// Authoritative, server-side game room. One instance per room code. All mutations happen here,
// in Node's single-threaded event loop, so there is no version/conflict machinery to speak of --
// two near-simultaneous actions are simply processed one after the other, in order. That whole
// class of problem (and the fragile client-side retry/tally-persistence code it required) only
// existed because the old design had no real server; it's gone here by construction.
"use strict";

const {
  TYPES, COURIERS, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
  PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS,
} = require("./game-data");

// Secure phase is per-player now: each seat has its own independent copy of the 21-cell board,
// so there is no cross-player contention (both players can secure "the same" cell id -- they're
// really securing their own separate copy of it). cellById therefore needs to know which seat's
// board to look in.
function cellById(state, seat, id) { return state.boards[seat].find((c) => c.id === id) || null; }
function cellMeta(id) { return CELLS.find((c) => c.id === id) || null; }

// 호수(ROOMS, "1"~"9")는 플레이어별로 겹치지 않게 뽑는다 -- 완전 무작위 복원추출이면 같은 플레이어
// 안에서도 "401호"와 "101호"처럼 호수 숫자가 자주 겹쳐 보였다("한 플레이어한테 같은 호수 안나오게끔"
// 요청, 2026-08-27). 셔플된 가방(bag)에서 하나씩 뽑아 쓰고, 다 떨어지면(9개 다 씀) 새로 셔플해서
// 다시 채운다 -- 그래서 "같은 9개를 한 바퀴 다 돌기 전까지는" 절대 안 겹치고, 그 이후엔 다시 안 겹치는
// 새 사이클이 시작된다. 21칸을 다 채우는 극단적 케이스에도 완전히 막을 순 없지만(호수 풀이 9개뿐이라
// 수학적으로 불가능), 그 안에서 최대한 안 겹치게 분산시킨다.
function shuffledRooms() {
  const arr = ROOMS.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function drawRoom(playerState) {
  if (!playerState.roomBag || playerState.roomBag.length === 0) playerState.roomBag = shuffledRooms();
  return playerState.roomBag.pop();
}

// fixedFloor 종류(확정 층수 택배)는 칸의 num(0..5)이 그대로 FLOORS 인덱스가 된다 -- 무작위가 아니라
// 어느 칸을 확보했는지에 따라 배송지가 결정되어 있다. 그 외 종류는 기존처럼 무작위 층. room은 이제
// 호출부(secureCell)에서 drawRoom()으로 뽑아 넘겨준다 (플레이어별 중복 방지, 위 참고).
function randomInvoice(seat, catIdx, num, acquiredSeq, room) {
  const t = TYPES[catIdx];
  const floorIdx = t.fixedFloor ? num : Math.floor(Math.random() * FLOORS.length);
  return {
    id: "inv-" + seat + "-" + acquiredSeq,
    catIdx, floorIdx, room, acquiredSeq,
    deliveredRound: null,
    stolen: false, // 택배도둑에게 뺏긴 경우 true (후반 전용, 확정 마이너스 점수)
    deliveredWasPriority: false, // 배송된 그 라운드에 우선 택배로 지정돼 있었는지 (확정, 이후 안 바뀜)
  };
}

// stolen: 배송은 됐지만 택배도둑이 가로챈 경우 -- 무조건 실패(penalty) 취급, 우선 배수도 적용 안 됨.
// deliveredWasPriority: 이 송장이 "배송된 바로 그 라운드"에 우선 택배로 지정되어 있었고 실제로
// 그 라운드에 배송됐다는 뜻 (2026-08-27: 게임 전체 1회 지정 -> 라운드마다 새로 지정, 라운드 한정
// 적용으로 변경. _applyDeliveries에서 배송 시점에 이 플래그를 확정해서 찍어두므로, 나중에 el의
// 우선택배 지정이 다음 라운드용으로 리셋/변경되어도 이 송장의 과거 결과는 그대로 남는다).
function scoreInvoice(inv) {
  const t = TYPES[inv.catIdx];
  if (inv.stolen) return -t.penalty;
  if (inv.deliveredRound === null) return -t.penalty;
  const base = t.reward;
  return inv.deliveredWasPriority ? base * PRIORITY_MULTIPLIER : base;
}
// 2026-08-27: 도난당한 송장도 "미배송"으로 표기하도록 변경(사용자 요청 -- "배송이 되지 않았으니까").
// 페널티/소진(재배송 불가) 로직은 이전과 동일 -- stolen은 여전히 deliveredRound를 채워 재시도 대상에서
// 빠지게 하고 -penalty로 채점되지만(scoreInvoice, 변경 없음), 영구 상태 라벨만 "도난"에서 통합됐다.
// 그 라운드의 실시간 결과 안내(_applyDeliveries가 만드는 delivered[].stolen, 클라이언트의
// renderDeliveredCallout "택배도둑에게 도난당했어요!")는 별개로 남겨뒀다 -- 그건 "이번 라운드에 무슨
// 일이 있었는지"를 보여주는 즉시성 정보라 계속 유용하다는 판단.
function resultLabel(inv) {
  if (inv.stolen) return "미배송"; // deliveredRound는 채워져 있지만(재배송 방지용) 라벨은 미배송 취급
  return inv.deliveredRound === null ? "미배송" : "성공";
}
function totalScore(seat, state) {
  return state.players[seat].invoices.reduce((sum, inv) => sum + scoreInvoice(inv), 0);
}

function freshBoard() {
  return CELLS.map((c) => ({ id: c.id, catIdx: c.catIdx, num: c.num, taken: false, acquiredSeq: null }));
}
function freshPlayers() {
  // roomBag: 이 플레이어의 이번 하프용 "안 겹치는 호수" 셔플 가방 (drawRoom() 참고). 하프가 바뀌면
  // (freshPlayers()가 다시 호출되면) 완전히 새로 셔플돼서 이전 하프의 소진 상태를 이어받지 않는다.
  return { "1": { invoices: [], roomBag: shuffledRooms() }, "2": { invoices: [], roomBag: shuffledRooms() } };
}
function freshElevator() {
  return {
    // state: "idle" | "thief" | "voting" | "choosing" | "result" | "done"
    // "thief": 후반(half===2)에서만 등장 -- voting 시작 전, 택배도둑을 놓을지 말지 THIEF_PLACE_MS
    // 동안 따로 주어지는 전용 시간 (2026-08-27 신설). 전반에는 이 상태를 아예 거치지 않는다.
    // "choosing": 이번 라운드에 같은 층에 배송 대기 중인 내 택배가 2개 이상인 플레이어가 있을 때,
    // 그 플레이어(들)에게 5초간 어느 걸 먼저 보낼지 고르게 하는 중간 단계 (없으면 곧장 result로).
    // "result"는 5초 이동/선택이 끝난 뒤 두 플레이어 모두 스페이스바를 눌러야(readyNext) 다음
    // 라운드(또는 마지막 라운드라면 하프 종료)로 넘어가는 대기 단계.
    round: 1, floorIdx: START_FLOOR_IDX, state: "idle", votingEndsAt: null,
    // votes: per-seat click counters, kept purely for the round log -- they no longer decide
    // anything and are never shown to players. Real movement is immediate, see vote().
    votes: { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } },
    roundStartFloorIdx: START_FLOOR_IDX,
    readyNext: { "1": false, "2": false },
    pendingChoice: null, // { conflicts: {seat: [invoiceId,...]}, chosen: {seat: invoiceId|null}, endsAt }
    // priorityPick: 이번에 다가올 라운드에 한해 유효한 우선 택배 지정 (2026-08-27: 게임 시작 전
    // 1회 -> 매 라운드 새로 지정으로 변경). idle/result 게이트(다음 라운드 시작 전 대기 화면)에서만
    // 바꿀 수 있고, 그 라운드 배송이 확정되는 순간(_finishRound) 다음 게이트를 위해 다시 비워진다.
    priorityPick: { "1": null, "2": null },
    // thieves: 후반(half===2) 전용. placedThisRound는 "이번 라운드 전용 시간에 배치를 썼는가"(1인당
    // 라운드당 1회), skipped는 "이번 라운드엔 안 놓기로 명시적으로 넘겼는가" (둘 다 하면 그 즉시
    // THIEF_PLACE_MS를 기다리지 않고 voting으로 넘어감 -- choosing의 조기-진행 패턴과 동일), active는
    // "바로 다음 라운드에 실제로 작동 중인 도둑 목록" -- 배치한 그 라운드에는 아직 작동하지 않고,
    // 다음 라운드의 thief 창이 열릴 때 activate된다 ("다음 라운드에 그 층에 배송하면 뺏어간다").
    // usedThisHalf: 1인당 이 후반 전체(라운드 5개) 통틀어 택배도둑 배치는 딱 1번만 허용한다
    // (2026-08-27 요청 -- 원래는 매 라운드 새로 놓을 수 있었음). 한 번 놓으면(스킵은 해당 안 됨)
    // true로 굳어지고, 다음 하프에 freshElevator()가 다시 호출될 때만 리셋된다.
    thieves: { placedThisRound: { "1": null, "2": null }, skipped: { "1": false, "2": false }, active: [],
      usedThisHalf: { "1": false, "2": false } },
    thiefWindowEndsAt: null,
    log: [],
  };
}

function initialState() {
  return {
    phase: "lobby", // lobby -> secure -> elevator -> halftime -> secure -> elevator -> end -> (재시작 시) secure ...
    ready: { "1": false, "2": false },
    seatOwners: { "1": null, "2": null },
    // courierPick: 좌석당 고른 가상 택배사 key(COURIERS 참고, null이면 아직 미선택). 좌석 배정과
    // 동시에(pickCourier) 정해지고, 하프가 바뀌어도 그대로 유지된다(게임 시작 전 1회 선택 -- 리셋
    // 없음). 2026-08-27 신설.
    courierPick: { "1": null, "2": null },
    secureEndsAt: null,
    boards: { "1": freshBoard(), "2": freshBoard() },
    acquireCounter: { "1": 0, "2": 0 },
    players: freshPlayers(),
    elevator: freshElevator(),
    half: 1,
    halftimeReady: { "1": false, "2": false },
    halfHistory: [], // [{half, players, scores}, ...] -- snapshot taken at the end of each half
    scores: null, // grand total across both halves, set once phase becomes "end"
    // restartReady: 종료 화면의 "다시 시작" 버튼용 준비 게이트 (2026-08-28 신설). phase가 "end"일
    // 때만 의미가 있고, 그 외엔 항상 비어 있는 상태({false,false})로 둔다 -- restartGame()이 매번
    // 리셋하므로 다음 재시작 때도 깨끗하게 시작한다.
    restartReady: { "1": false, "2": false },
  };
}

class GameRoom {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange; // called with (state) whenever state mutates -- caller broadcasts it
    this.state = initialState();
    this.timer = null;
    this.lastActivityAt = Date.now();
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  touch() { this.lastActivityAt = Date.now(); }

  emit() { this.onChange(this.state); }

  // ---- seat / lobby ----
  pickSeat(seat, clientId) {
    this.touch();
    const owners = this.state.seatOwners;
    if (owners[seat] && owners[seat] !== clientId) return { ok: false, code: "seat_taken" };
    // freeing any other seat this same client previously held (e.g. picked wrong seat, retried) --
    // also clears its courierPick so that courier becomes pickable again, rather than staying
    // reserved on a now-unowned seat.
    ["1", "2"].forEach((s) => {
      if (owners[s] === clientId && s !== seat) { owners[s] = null; this.state.courierPick[s] = null; }
    });
    owners[seat] = clientId;
    this.emit();
    return { ok: true };
  }

  // 2026-08-27 신설: 좌석 선택 화면이 "플레이어 1/2" 버튼 대신 가상 택배사 5종 아이콘을 보여주고,
  // 클라이언트는 자기가 몇 번 좌석이 될지 미리 알 수 없으므로(먼저 온 사람이 "1", 나중 온 사람이
  // "2") 좌석 번호 없이 courierKey만 보내면 서버가 정한다. 이미 이 clientId가 어느 좌석을 갖고
  // 있으면(마음 바꿔 다른 아이콘 다시 고르는 경우) 그 좌석을 그대로 재사용하고, 없으면 비어 있는
  // 좌석("1" 우선) 하나를 새로 배정한다. courierKey는 반대쪽 좌석이 이미 고른 것과 겹칠 수 없다.
  pickCourier(courierKey, clientId) {
    this.touch();
    if (!COURIERS.some((c) => c.key === courierKey)) return { ok: false, code: "bad_courier" };
    const owners = this.state.seatOwners;
    const picks = this.state.courierPick;
    let seat = ["1", "2"].find((s) => owners[s] === clientId) || null;
    if (!seat) {
      seat = owners["1"] === null ? "1" : (owners["2"] === null ? "2" : null);
      if (!seat) return { ok: false, code: "room_full" };
    }
    const otherSeat = seat === "1" ? "2" : "1";
    if (picks[otherSeat] === courierKey) return { ok: false, code: "courier_taken" };
    owners[seat] = clientId;
    picks[seat] = courierKey;
    this.emit();
    return { ok: true, seat };
  }

  setReady(seat) {
    if (this.state.phase !== "lobby") return;
    this.touch();
    this.state.ready[seat] = true;
    if (this.state.ready["1"] && this.state.ready["2"]) this._startGame();
    else this.emit();
  }

  _startGame() {
    this.state.phase = "secure";
    this.state.secureEndsAt = Date.now() + SECURE_PHASE_MS;
    this._scheduleAt(this.state.secureEndsAt, () => this._endSecurePhase());
    this.emit();
  }

  // ---- secure phase ----
  // Each seat has its own independent board (see freshBoard/state.boards), so there is no
  // cross-player race here anymore -- player 1 securing "fragile-1" has zero effect on whether
  // player 2 can also secure their own "fragile-1". Giving up (the client just closes the puzzle
  // overlay without sending this message) never reaches here, so a given-up cell never gets
  // touched -- it stays exactly as untaken as it was before the attempt.
  secureCell(seat, cellId) {
    if (this.state.phase !== "secure") return;
    const cell = cellById(this.state, seat, cellId);
    if (!cell || cell.taken) return; // already taken by this same seat (or unknown id) -- silent no-op
    this.touch();
    cell.taken = true;
    this.state.acquireCounter[seat] += 1;
    cell.acquiredSeq = this.state.acquireCounter[seat];
    const meta = cellMeta(cellId);
    const room = drawRoom(this.state.players[seat]);
    this.state.players[seat].invoices.push(randomInvoice(seat, meta.catIdx, meta.num, cell.acquiredSeq, room));
    this.emit();
  }

  _endSecurePhase() {
    if (this.state.phase !== "secure") return;
    this.state.phase = "elevator";
    this.state.elevator = freshElevator();
    this.emit();
  }

  // ---- elevator phase ----
  // 우선 택배 지정 (2026-08-27: 게임/하프 전체 1회 -> 매 라운드 새로 지정으로 변경). idle(라운드1
  // 시작 전)/result(다음 라운드 시작 전) 게이트에서만 바꿀 수 있다 -- 그 라운드가 실제로 진행되는
  // 동안(voting/choosing)은 고정. 최대 1개, 선택 사항이며 언제든 null로 되돌려 지정 해제 가능.
  // 그 라운드에 정확히 그 송장이 배송돼야만 PRIORITY_MULTIPLIER가 적용된다 (다음 라운드로 안 넘어감).
  setPriorityPick(seat, invoiceId) {
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "idle" && el.state !== "result") return;
    if (invoiceId !== null) {
      const inv = this.state.players[seat].invoices.find((v) => v.id === invoiceId);
      if (!inv || inv.deliveredRound !== null) return; // 내 것이면서 아직 미배송인 송장만 지정 가능
    }
    this.touch();
    el.priorityPick[seat] = invoiceId;
    this.emit();
  }

  _startVotingRound() {
    const el = this.state.elevator;
    el.state = "voting";
    el.votes = { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } };
    el.roundStartFloorIdx = el.floorIdx;
    el.readyNext = { "1": false, "2": false };
    el.pendingChoice = null;
    el.votingEndsAt = Date.now() + VOTE_MS;
    this._scheduleAt(el.votingEndsAt, () => this._resolveRound());
    this.emit();
  }

  // Used both for the pre-round-1 "idle" gate and the between-round "result" gate, once both
  // players are ready: in 후반(half===2) a dedicated THIEF_PLACE_MS window comes first (see
  // _startThiefWindow); in 전반 there's no thief mechanic at all, so it goes straight to voting.
  _enterNextRound() {
    if (this.state.half === 2) this._startThiefWindow();
    else this._startVotingRound();
  }

  // 후반 전용, 매 라운드 voting 시작 직전에 열리는 "택배도둑을 놓을지" 전용 시간 (2026-08-27 신설 --
  // 원래는 idle/voting 아무 때나 놓을 수 있었는데, 사용자 요청으로 별도의 전용 시간으로 분리했다).
  // 지난 라운드에 놓은 도둑을 여기서 activate하고(다음 라운드부터 작동하므로), 이번 라운드 몫의
  // 배치 슬롯을 새로 연다. 둘 다 배치를 마치면(놓거나 명시적으로 넘기면) 타이머를 기다리지 않고
  // 곧장 voting으로 넘어간다 -- choosing의 조기-진행 패턴과 동일.
  _startThiefWindow() {
    const el = this.state.elevator;
    el.thieves.active = ["1", "2"]
      .filter((s) => el.thieves.placedThisRound[s] !== null)
      .map((s) => ({ seat: s, floorIdx: el.thieves.placedThisRound[s] }));
    el.thieves.placedThisRound = { "1": null, "2": null };
    el.thieves.skipped = { "1": false, "2": false };
    // 이미 이 후반에 1회 배치를 다 쓴 플레이어는 이번 라운드도 자동으로 "넘김" 처리해서 굳이 화면에서
    // 다시 액션을 요구하지 않는다 (2026-08-27, 후반 전체 1회 한도). 둘 다 이미 다 썼다면 아무도 놓을 수
    // 없으니 thief 창 자체를 열지 않고 곧장 voting으로 넘어간다.
    ["1", "2"].forEach((s) => { if (el.thieves.usedThisHalf[s]) el.thieves.skipped[s] = true; });
    if (["1", "2"].every((s) => el.thieves.usedThisHalf[s])) { this._startVotingRound(); return; }
    el.state = "thief";
    el.thiefWindowEndsAt = Date.now() + THIEF_PLACE_MS;
    this._scheduleAt(el.thiefWindowEndsAt, () => this._endThiefWindow());
    this.emit();
  }

  _endThiefWindow() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "thief") return;
    this._startVotingRound();
  }

  // Each accepted click moves the REAL elevator by exactly one floor, right now -- not a vote that
  // gets tallied and resolved later. Both players share control of the same car during the round's
  // 5-second window, so whichever of them clicks, the car visibly steps immediately for everyone
  // (the broadcast below reaches both clients). Wherever it happens to be sitting when the round's
  // timer fires is what _resolveRound() uses for that round's delivery. votes[seat] is still
  // incremented as a simple per-player click counter for the round log only -- never shown.
  vote(seat, dir) {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    if (dir !== "up" && dir !== "down") return;
    this.touch();
    const el = this.state.elevator;
    el.votes[seat][dir] += 1;
    if (dir === "up") el.floorIdx = Math.min(FLOORS.length - 1, el.floorIdx + 1);
    else el.floorIdx = Math.max(0, el.floorIdx - 1);
    this.emit(); // real-time: broadcast every single click immediately so both players see the
    // actual car move, not just their own
  }

  // 후반(half===2)에서만, 그리고 오직 전용 "thief" 시간에만 유효. 이번 라운드에 이미 배치했거나
  // 넘겼다면 무시. 1인당 이 후반 전체 5라운드를 통틀어 배치는 딱 1번만 허용된다(2026-08-27 요청,
  // usedThisHalf) -- 이미 썼다면 _startThiefWindow가 매 라운드 자동으로 스킵 처리해두므로 여기까지
  // 오는 일 자체가 없다. 배치 직후엔 아무 효과 없고, 다음 라운드의 thief 창이 열릴 때
  // (_startThiefWindow) active로 넘어가 작동한다. floorIdx가 null이면 "이번 라운드엔 안 놓음"으로
  // 명시적으로 넘기는 것(usedThisHalf는 소진되지 않음) -- 두 플레이어 모두 배치/넘기기를 마치면
  // THIEF_PLACE_MS를 다 기다리지 않고 곧장 voting으로 넘어간다.
  placeThief(seat, floorIdx) {
    if (this.state.half !== 2) return;
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "thief") return;
    if (el.thieves.placedThisRound[seat] !== null || el.thieves.skipped[seat]) return;
    if (floorIdx !== null && (typeof floorIdx !== "number" || floorIdx < 0 || floorIdx >= FLOORS.length)) return;
    this.touch();
    if (floorIdx === null) {
      el.thieves.skipped[seat] = true;
    } else {
      el.thieves.placedThisRound[seat] = floorIdx;
      el.thieves.usedThisHalf[seat] = true; // 후반 전체 1회 한도 소진 (2026-08-27)
    }
    const bothDone = ["1", "2"].every((s) => el.thieves.placedThisRound[s] !== null || el.thieves.skipped[s]);
    if (bothDone) { this._endThiefWindow(); return; }
    this.emit();
  }

  // Returns the list of delivered/stolen items for the round-result callout. Only ONE package per
  // player is delivered per floor visit -- normally the earliest-acquired (lowest acquiredSeq)
  // undelivered invoice bound for this floor, UNLESS that player explicitly chose a different one
  // during a "choosing" conflict window (forcedChoice[seat]). If an active thief (placed by the
  // OTHER seat last round) targets this floor, the delivery still "arrives" but scores as stolen
  // (guaranteed negative) instead of a normal success.
  _applyDeliveries(round, forcedChoice) {
    const el = this.state.elevator;
    const floorIdx = el.floorIdx;
    const delivered = [];
    ["1", "2"].forEach((seat) => {
      const invs = this.state.players[seat].invoices
        .filter((v) => v.deliveredRound === null && v.floorIdx === floorIdx)
        .sort((a, b) => a.acquiredSeq - b.acquiredSeq);
      if (!invs.length) return;
      let v = invs[0];
      const forcedId = forcedChoice && forcedChoice[seat];
      if (forcedId) {
        const chosen = invs.find((x) => x.id === forcedId);
        if (chosen) v = chosen;
      }
      const thief = el.thieves.active.find((t) => t.floorIdx === floorIdx && t.seat !== seat);
      const wasPriority = el.priorityPick[seat] === v.id;
      v.deliveredRound = round;
      if (thief) v.stolen = true;
      else if (wasPriority) v.deliveredWasPriority = true; // 도난당한 경우 우선 배수는 적용 안 함
      delivered.push({
        seat, catIdx: v.catIdx, floorIdx: v.floorIdx, room: v.room, invoiceId: v.id,
        stolen: !!thief, priority: !thief && wasPriority,
      });
    });
    return delivered;
  }

  _computeHalfScores() {
    return { "1": totalScore("1", this.state), "2": totalScore("2", this.state) };
  }

  _finishRound(round, forcedChoice) {
    const el = this.state.elevator;
    const v1 = el.votes["1"], v2 = el.votes["2"];
    const totalUp = v1.up + v2.up, totalDown = v1.down + v2.down;
    const dir = el.floorIdx > el.roundStartFloorIdx ? "up" : (el.floorIdx < el.roundStartFloorIdx ? "down" : "tie");
    const delivered = this._applyDeliveries(round, forcedChoice);
    el.log.push({ round, up: totalUp, down: totalDown, dir, floorIdx: el.floorIdx, delivered });
    el.pendingChoice = null;
    // 이번 라운드의 우선 택배 지정은 이번 라운드 배송에만 유효했다 -- 다음 라운드 게이트에서는
    // 다시 비어 있는 상태로 새로 골라야 한다 ("매 라운드마다 지정").
    el.priorityPick = { "1": null, "2": null };
    // Pause here regardless of whether this was the final round -- both players press space to
    // continue (mirrors the lobby's ready-up gate), so there's always time to read the result
    // and see what was just delivered before moving on.
    el.state = "result";
    el.readyNext = { "1": false, "2": false };
    this.emit();
  }

  // The floor has already moved live, click by click, over the course of the round (see vote()) --
  // this locks in wherever it ended up. Before delivering, check whether either player has 2+
  // undelivered invoices bound for that exact floor -- if so, give them SAME_FLOOR_CHOICE_MS to
  // pick which one goes first (random if they don't answer in time) instead of always defaulting
  // to earliest-acquired. If nobody has a conflict, deliveries resolve immediately as before.
  _resolveRound() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    const el = this.state.elevator;
    const floorIdx = el.floorIdx;
    const conflicts = {};
    ["1", "2"].forEach((seat) => {
      const candidates = this.state.players[seat].invoices
        .filter((v) => v.deliveredRound === null && v.floorIdx === floorIdx)
        .map((v) => v.id);
      if (candidates.length >= 2) conflicts[seat] = candidates;
    });
    if (Object.keys(conflicts).length === 0) {
      this._finishRound(el.round, null);
      return;
    }
    this.touch();
    el.state = "choosing";
    el.pendingChoice = {
      conflicts,
      chosen: { "1": null, "2": null },
      endsAt: Date.now() + SAME_FLOOR_CHOICE_MS,
    };
    this._scheduleAt(el.pendingChoice.endsAt, () => this._finalizeChoice());
    this.emit();
  }

  chooseDelivery(seat, invoiceId) {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "choosing") return;
    const pc = this.state.elevator.pendingChoice;
    if (!pc || !pc.conflicts[seat] || !pc.conflicts[seat].includes(invoiceId)) return;
    if (pc.chosen[seat]) return; // already chose
    this.touch();
    pc.chosen[seat] = invoiceId;
    const stillWaiting = Object.keys(pc.conflicts).some((s) => !pc.chosen[s]);
    if (!stillWaiting) { this._finalizeChoice(); return; }
    this.emit();
  }

  _finalizeChoice() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "choosing") return;
    const el = this.state.elevator;
    const pc = el.pendingChoice;
    const forcedChoice = {};
    Object.keys(pc.conflicts).forEach((seat) => {
      forcedChoice[seat] = pc.chosen[seat]
        || pc.conflicts[seat][Math.floor(Math.random() * pc.conflicts[seat].length)];
    });
    this._finishRound(el.round, forcedChoice);
  }

  // Used both for the pre-round-1 gate ("idle") and the between-round gate ("result") -- in
  // either case, once both players have pressed space, either round 1 begins (from "idle") or
  // the next round begins / the half ends (from "result").
  setElevatorReady(seat) {
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "idle" && el.state !== "result") return;
    this.touch();
    el.readyNext[seat] = true;
    if (!(el.readyNext["1"] && el.readyNext["2"])) { this.emit(); return; }
    if (el.state === "idle") {
      this._enterNextRound(); // begins round 1 (via thief window in 후반, or straight to voting); also emits
      return;
    }
    if (el.round >= ELEVATOR_ROUNDS) {
      el.state = "done";
      this._finishHalf();
    } else {
      el.round += 1;
      this._enterNextRound(); // also emits
    }
  }

  // Ends the current half: snapshots this half's per-player invoices + score into halfHistory.
  // After half 1, moves to a "halftime" transition screen (both press space to start half 2 --
  // fresh boards/invoices, thief mechanic unlocked). After half 2, sums both halves' scores into
  // the grand total and moves to "end".
  _finishHalf() {
    const scores = this._computeHalfScores();
    this.state.halfHistory.push({
      half: this.state.half,
      players: JSON.parse(JSON.stringify(this.state.players)),
      scores,
    });
    if (this.state.half < HALVES) {
      this.state.half += 1;
      this.state.phase = "halftime";
      this.state.halftimeReady = { "1": false, "2": false };
      this.emit();
    } else {
      this.state.scores = {
        "1": this.state.halfHistory.reduce((sum, h) => sum + h.scores["1"], 0),
        "2": this.state.halfHistory.reduce((sum, h) => sum + h.scores["2"], 0),
      };
      this.state.phase = "end";
      this.emit();
    }
  }

  // ---- 2026-08-28 신설: 종료 화면의 "다시 시작" 버튼 -- 같은 방(같은 링크)에서 좌석/택배사를 다시
  // 고를 필요 없이 곧바로 새 게임을 시작한다. halftimeReady와 같은 "둘 다 눌러야" 게이트 패턴이다
  // (한쪽이 실수로 눌러도 상대 동의 없이 화면이 바뀌지 않도록). seatOwners/courierPick은 그대로
  // 유지하고(같은 택배사로 계속 플레이), 그 외 게임 진행 상태(보드/송장/엘리베이터/하프/스코어
  // 이력)만 완전히 초기값으로 되돌린 뒤 _startGame()으로 바로 전반 secure 페이즈에 진입한다 --
  // 로비 화면(택배사 재선택)을 다시 거치지 않는다.
  restartReady(seat) {
    if (this.state.phase !== "end") return;
    this.touch();
    this.state.restartReady[seat] = true;
    if (!(this.state.restartReady["1"] && this.state.restartReady["2"])) { this.emit(); return; }
    this._restartGame();
  }

  _restartGame() {
    this.state.boards = { "1": freshBoard(), "2": freshBoard() };
    this.state.acquireCounter = { "1": 0, "2": 0 };
    this.state.players = freshPlayers();
    this.state.elevator = freshElevator();
    this.state.half = 1;
    this.state.halfHistory = [];
    this.state.scores = null;
    this.state.restartReady = { "1": false, "2": false };
    this._startGame(); // phase -> "secure", secure 타이머 새로 시작, emit까지 포함
  }

  halftimeReady(seat) {
    if (this.state.phase !== "halftime") return;
    this.touch();
    this.state.halftimeReady[seat] = true;
    if (!(this.state.halftimeReady["1"] && this.state.halftimeReady["2"])) { this.emit(); return; }
    this.state.boards = { "1": freshBoard(), "2": freshBoard() };
    this.state.acquireCounter = { "1": 0, "2": 0 };
    this.state.players = freshPlayers();
    this._startGame(); // phase="secure" again, fresh secure timer; also emits
  }

  // ---- disconnect bookkeeping: free a seat if its owning client has no other open sockets ----
  releaseSeatIfOrphaned(seat, clientId, stillConnectedClientIds) {
    if (this.state.seatOwners[seat] === clientId && !stillConnectedClientIds.has(clientId)) {
      this.state.seatOwners[seat] = null;
      // 게임 시작 전(로비)이었다면 그 좌석의 택배사 선택도 같이 풀어줘서 다른 사람이 다시 고를 수
      // 있게 한다. 게임이 이미 시작된 뒤의 연결 끊김은 courierPick을 그대로 둔다 -- 그 좌석은
      // 여전히 "그 택배사 직원"으로 진행 중인 게임의 일부이므로, 재접속하면 같은 좌석/택배사로
      // 복귀해야 한다(위 pickSeat의 재접속 경로).
      if (this.state.phase === "lobby") this.state.courierPick[seat] = null;
      this.emit();
    }
  }

  _scheduleAt(ts, fn) {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(0, ts - Date.now());
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }
}

module.exports = { GameRoom, initialState, scoreInvoice, resultLabel, totalScore };
