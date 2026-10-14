// Authoritative, server-side game room. One instance per room code. All mutations happen here,
// in Node's single-threaded event loop, so there is no version/conflict machinery to speak of --
// two near-simultaneous actions are simply processed one after the other, in order. That whole
// class of problem (and the fragile client-side retry/tally-persistence code it required) only
// existed because the old design had no real server; it's gone here by construction.
"use strict";

// 보드가 다 비었을 때 확보 단계를 끝내기까지의 짧은 여유(마지막 확보가 화면에 보일 시간).
const SECURE_EARLY_END_MS = 1500;

const {
  TYPES, COURIERS, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
  PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS, THIEF_PER_HALF, PRIORITY_PICK_MS,
  FLOOR_REWARD_MULT, START_FLOOR_CHOICES, ELEVATOR_JOLT, RESULT_AUTO_ADVANCE_MS, MERGE_PRIORITY_THIEF, SAME_FLOOR_AUTO_PICK,
  RACE_MODE, RACE_PICK_MS, RACE_SECOND_MS, RACE_REVEAL_MS, RACE_PUZZLE_ORDER, RACE_PARCELS, RACE_LEFTOVER_RETURN, RACE_AUTO_PICK, RACE_GAME_POOL, RACE_AUTO_PICK_MODE,
} = require("./game-data");

// 2026-10-13 개선 1단계(P1+P2) 규칙 묶음. 기본값은 game-data.js. GameRoom 생성자의 세 번째 인자로 일부를 덮어쓸 수 있다
// (기존 회귀 테스트는 LEGACY_RULES로 예전 흐름을 그대로 검증하고, test_p1p2.js가 새 흐름을 검증한다).
const DEFAULT_RULES = {
  floorRewardMult: FLOOR_REWARD_MULT,
  startFloorChoices: START_FLOOR_CHOICES,
  resultAutoAdvanceMs: RESULT_AUTO_ADVANCE_MS,
  mergePriorityThief: !!MERGE_PRIORITY_THIEF,
  sameFloorAutoPick: !!SAME_FLOOR_AUTO_PICK,
  // 2026-10-14 확보 단계 레이스 라운드 (game-data.js RACE_* 참고). false면 예전처럼 레일에서 각자 골라 확보.
  raceMode: !!RACE_MODE,
  racePickMs: RACE_PICK_MS,
  raceSecondMs: RACE_SECOND_MS,
  raceRevealMs: RACE_REVEAL_MS,
  raceParcels: RACE_PARCELS,
  raceLeftoverReturn: !!RACE_LEFTOVER_RETURN,
  raceAutoPick: !!RACE_AUTO_PICK,
  raceGamePool: RACE_GAME_POOL,
  raceAutoPickMode: RACE_AUTO_PICK_MODE,
  elevatorJolt: !!ELEVATOR_JOLT,
};
// 2026-10-12까지의 동작과 똑같이 만드는 규칙 (1F 시작, 배율 없음, 스페이스 게이트, 도둑 창 별도, 같은 층 선택 창).
const LEGACY_RULES = {
  floorRewardMult: FLOORS.map(() => 1),
  startFloorChoices: [START_FLOOR_IDX],
  resultAutoAdvanceMs: 0,
  mergePriorityThief: false,
  sameFloorAutoPick: false,
  raceMode: false,
  elevatorJolt: false,
};

// 2026-10-06: 보드는 두 플레이어가 "같이 쓰는" 하나다 (종류별 6칸 = 두 사람 합쳐서 6개). 한 사람이 확보하면
// 그 칸은 상대에게서도 사라진다. 그 전(2026-08-27~10-05)에는 플레이어별로 독립된 보드 사본이었다.
function cellById(state, id) { return state.board.find((c) => c.id === id) || null; }
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
// reward: 이 송장의 배송 성공 금액 = 종류 기본 금액 x 층 배율(P1-1, 2026-10-13). 층이 확보 순간 정해지므로 여기서 확정해
// 송장에 박아 둔다 -- 점수 함수(scoreInvoice)는 계속 인자 하나로 순수하게 유지되고, 클라이언트 복제본도 같은 값을 읽는다.
function rewardFor(catIdx, floorIdx, floorRewardMult) {
  const mult = (floorRewardMult && floorRewardMult[floorIdx] != null) ? floorRewardMult[floorIdx] : 1;
  return Math.round(TYPES[catIdx].reward * mult);
}
function randomInvoice(seat, catIdx, num, acquiredSeq, room, floorRewardMult) {
  const t = TYPES[catIdx];
  const floorIdx = t.fixedFloor ? num : Math.floor(Math.random() * FLOORS.length);
  return {
    id: "inv-" + seat + "-" + acquiredSeq,
    catIdx, floorIdx, room, acquiredSeq,
    reward: rewardFor(catIdx, floorIdx, floorRewardMult),
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
  // inv.reward가 없는 송장(2026-10-13 이전 형식)은 종류 기본 금액 그대로.
  const base = typeof inv.reward === "number" ? inv.reward : t.reward;
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
  // takenBy: 이 칸을 확보한 좌석("1"/"2"). acquiredSeq는 그 좌석 안에서의 확보 순번이다(송장과 연결하는 키 --
  // 좌석이 다르면 같은 번호가 있을 수 있으니 항상 takenBy와 함께 본다).
  return CELLS.map((c) => ({ id: c.id, catIdx: c.catIdx, num: c.num, taken: false, takenBy: null, acquiredSeq: null }));
}
function freshPlayers() {
  // roomBag: 이 플레이어의 이번 하프용 "안 겹치는 호수" 셔플 가방 (drawRoom() 참고). 하프가 바뀌면
  // (freshPlayers()가 다시 호출되면) 완전히 새로 셔플돼서 이전 하프의 소진 상태를 이어받지 않는다.
  return { "1": { invoices: [], roomBag: shuffledRooms() }, "2": { invoices: [], roomBag: shuffledRooms() } };
}
function pickStartFloor(choices) {
  const list = choices && choices.length ? choices : [START_FLOOR_IDX];
  return list[Math.floor(Math.random() * list.length)];
}
function freshElevator(rules) {
  const startFloorIdx = pickStartFloor((rules || DEFAULT_RULES).startFloorChoices);
  return {
    // state: "idle" | "priority" | "thief" | "voting" | "choosing" | "result" | "done"
    // "priority": 매 라운드 게이트(idle/result)에서 둘 다 준비하면 맨 먼저 열리는 우선 택배 지정 전용 시간
    // (PRIORITY_PICK_MS = 10초, 2026-10-06 신설). 둘 다 "확정"하면 조기 종료. 이후 후반이면 thief, 전반이면 voting.
    // "thief": 후반(half===2)에서만 등장 -- voting 시작 전, 택배도둑을 놓을지 말지 THIEF_PLACE_MS
    // 동안 따로 주어지는 전용 시간 (2026-08-27 신설). 전반에는 이 상태를 아예 거치지 않는다.
    // "choosing": 이번 라운드에 같은 층에 배송 대기 중인 내 택배가 2개 이상인 플레이어가 있을 때,
    // 그 플레이어(들)에게 5초간 어느 걸 먼저 보낼지 고르게 하는 중간 단계 (없으면 곧장 result로).
    // "result"는 5초 이동/선택이 끝난 뒤 두 플레이어 모두 스페이스바를 눌러야(readyNext) 다음
    // 라운드(또는 마지막 라운드라면 하프 종료)로 넘어가는 대기 단계.
    round: 1, floorIdx: startFloorIdx, state: "idle", votingEndsAt: null,
    // 결과 화면 자동 진행 시각 (RESULT_AUTO_ADVANCE_MS > 0일 때만, result 상태에서만 값이 있다). 클라이언트 카운트다운용.
    resultEndsAt: null,
    // votes: per-seat click counters, kept purely for the round log -- they no longer decide
    // anything and are never shown to players. Real movement is immediate, see vote().
    votes: { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } },
    roundStartFloorIdx: startFloorIdx,
    readyNext: { "1": false, "2": false },
    pendingChoice: null, // { conflicts: {seat: [invoiceId,...]}, chosen: {seat: invoiceId|null}, endsAt }
    // priorityPick: 이번에 다가올 라운드에 한해 유효한 우선 택배 지정 (2026-08-27: 게임 시작 전
    // 1회 -> 매 라운드 새로 지정으로 변경). idle/result 게이트(다음 라운드 시작 전 대기 화면)에서만
    // 바꿀 수 있고, 그 라운드 배송이 확정되는 순간(_finishRound) 다음 게이트를 위해 다시 비워진다.
    priorityPick: { "1": null, "2": null },
    // 우선 택배 지정 전용 시간("priority" 상태)의 종료 시각과 좌석별 "확정" 여부 (2026-10-06 신설).
    // 미배송 택배가 하나도 없는 플레이어는 지정할 게 없으니 자동으로 확정 처리된다.
    priorityWindowEndsAt: null,
    priorityConfirmed: { "1": false, "2": false },
    // thieves: 후반(half===2) 전용. placedThisRound는 "이번 라운드 전용 시간에 배치를 썼는가"(1인당
    // 라운드당 1회), skipped는 "이번 라운드엔 안 놓기로 명시적으로 넘겼는가" (둘 다 하면 그 즉시
    // THIEF_PLACE_MS를 기다리지 않고 voting으로 넘어감 -- choosing의 조기-진행 패턴과 동일), active는
    // "바로 다음 라운드에 실제로 작동 중인 도둑 목록" -- 배치한 그 라운드에는 아직 작동하지 않고,
    // 다음 라운드의 thief 창이 열릴 때 activate된다 ("다음 라운드에 그 층에 배송하면 뺏어간다").
    // usedThisHalf: 1인당 이 후반 전체를 통틀어 택배도둑을 놓은 횟수. perHalf(THIEF_PER_HALF = 2)에 닿으면
    // 더는 못 놓는다 (2026-08-27 요청으로 후반 통틀어 1회 -> 2026-10-07 2회). 스킵은 횟수에 안 들어가고,
    // 다음 하프에 freshElevator()가 다시 호출될 때만 0으로 리셋된다. 라운드당 배치는 여전히 최대 1개.
    thieves: { placedThisRound: { "1": null, "2": null }, skipped: { "1": false, "2": false }, active: [],
      usedThisHalf: { "1": 0, "2": 0 }, perHalf: THIEF_PER_HALF },
    thiefWindowEndsAt: null,
    log: [],
  };
}

function initialState(rules) {
  return {
    phase: "lobby", // lobby -> secure -> elevator -> halftime -> secure -> elevator -> end -> (재시작 시) secure ...
    ready: { "1": false, "2": false },
    seatOwners: { "1": null, "2": null },
    // courierPick: 좌석당 고른 가상 택배사 key(COURIERS 참고, null이면 아직 미선택). 좌석 배정과
    // 동시에(pickCourier) 정해지고, 하프가 바뀌어도 그대로 유지된다(게임 시작 전 1회 선택 -- 리셋
    // 없음). 2026-08-27 신설.
    courierPick: { "1": null, "2": null },
    secureEndsAt: null,
    board: freshBoard(), // 두 플레이어가 공유하는 보드 (종류별 6칸 합계)
    acquireCounter: { "1": 0, "2": 0 },
    players: freshPlayers(),
    elevator: freshElevator(rules),
    half: 1,
    halftimeReady: { "1": false, "2": false },
    halfHistory: [], // [{half, players, scores}, ...] -- snapshot taken at the end of each half
    scores: null, // grand total across both halves, set once phase becomes "end"
    // restartReady: 종료 화면의 "다시 시작" 버튼용 준비 게이트 (2026-08-28 신설). phase가 "end"일
    // 때만 의미가 있고, 그 외엔 항상 비어 있는 상태({false,false})로 둔다 -- restartGame()이 매번
    // 리셋하므로 다음 재시작 때도 깨끗하게 시작한다.
    restartReady: { "1": false, "2": false },
    race: null, // 2026-10-14 확보 단계 레이스 라운드 상태 (GameRoom._raceNewRound 참고)
  };
}

// ---------- 2026-10-14 확보 단계 레이스 라운드 ----------
// state.race (확보 단계 동안만, 레이스 모드일 때만):
//   round       : 이번 하프의 라운드 번호 (1부터)
//   pair        : [{ cellId, catIdx, floorIdx, reward }] -- 이번 라운드에 걸린 택배 1~RACE_PARCELS개. 화면에는 종류만 그리고,
//                 층·금액은 고른 사람의 화면(자기 자리 송장)에만 그린다(서버는 원래 전체 상태를 방송하는 구조라 "화면에서 숨김" 수준의
//                 비공개다 -- 송장과 같은 원칙)
//   game        : 이번 라운드 첫 게임(화면 미니게임 kind, rules.raceGamePool에서 무작위 -- 두 사람 같은 게임)
//   puzzleId    : 이번 라운드 우봉고 문제(퍼즐 이미지가 있는 칸 id, RACE_PUZZLE_ORDER 순서). 두 사람이 같은 문제를 푼다.
//   stage       : 좌석별 "sticker"(첫 게임 중 -- 이름은 예전 그대로, 실제 게임은 game) | "ubongo"(우봉고 중) | "done"(투입 완료) | "out"(포기/시간 초과)
//   finishedAt  : 좌석별 우봉고 완료 시각 (서버 시각)
//   first       : 먼저 끝낸 좌석 (없으면 null)
//   status      : "playing" | "picking"(먼저 끝낸 사람/늦은 사람이 고르는 중, 늦은 사람 마감 대기) | "reveal"(결과 보여 주는 중)
//   pickEndsAt  : 먼저 끝낸 사람의 고르기 마감 / secondEndsAt: 늦은 사람의 투입 마감 / secondPickEndsAt: 늦은 사람의 고르기 마감
//   revealEndsAt: 결과 표시 마감
//   picks       : 좌석별로 가져간 pair 인덱스 (못 가져갔으면 null) / invoiceIds: 좌석별로 이번 라운드에 출력된 송장 id
//   discarded   : 아무도 안 가져간 pair 인덱스 (RACE_LEFTOVER_RETURN이면 레일로 돌아가고, 아니면 사라진다)
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

class GameRoom {
  constructor(code, onChange, rules) {
    this.code = code;
    this.onChange = onChange; // called with (state) whenever state mutates -- caller broadcasts it
    this.rules = Object.assign({}, DEFAULT_RULES, rules || {});
    this.state = initialState(this.rules);
    this.timer = null;
    this.lastActivityAt = Date.now();
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    if (this.raceTimer) clearTimeout(this.raceTimer);
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
    this.state.race = null;
    if (this.rules.raceMode) this._raceNewRound(1);
    this.emit();
  }

  // ---- 확보 단계 레이스 라운드 (2026-10-14) ----
  // 타이머는 확보 단계 종료 타이머(this.timer, _scheduleAt)와 따로 둔다 -- 슬롯이 하나라 덮어쓰면 확보 단계가 안 끝난다.
  _raceAt(ts) {
    if (this.raceTimer) clearTimeout(this.raceTimer);
    this.raceTimer = null;
    if (ts == null) return;
    this.raceTimer = setTimeout(() => { this.raceTimer = null; this._raceAdvance(); }, Math.max(0, ts - Date.now()));
  }

  _raceNewRound(roundNo) {
    const free = this.state.board.filter((c) => !c.taken);
    if (!free.length) { this.state.race = null; this._raceAt(null); return; }
    const pair = shuffled(free).slice(0, Math.max(1, this.rules.raceParcels || 3)).map((c) => {
      const t = TYPES[c.catIdx];
      const floorIdx = t.fixedFloor ? c.num : Math.floor(Math.random() * FLOORS.length);
      return { cellId: c.id, catIdx: c.catIdx, floorIdx, reward: rewardFor(c.catIdx, floorIdx, this.rules.floorRewardMult) };
    });
    this.state.race = {
      round: roundNo, pair, game: this._raceNextGame(),
      puzzleId: RACE_PUZZLE_ORDER[(roundNo - 1) % RACE_PUZZLE_ORDER.length],
      stage: { "1": "sticker", "2": "sticker" },
      finishedAt: { "1": null, "2": null },
      first: null, status: "playing",
      pickEndsAt: null, secondEndsAt: null, secondPickEndsAt: null, revealEndsAt: null,
      picks: { "1": null, "2": null }, invoiceIds: { "1": null, "2": null }, discarded: [],
    };
    this._raceAt(null);
  }

  // 섞은 순서대로 꺼내고, 다 쓰면 다시 섞는다(새로 섞은 첫 게임이 직전 게임과 같으면 한 칸 미룬다)
  _raceNextGame() {
    const pool = (this.rules.raceGamePool && this.rules.raceGamePool.length) ? this.rules.raceGamePool : ["sticker"];
    if (!this.raceGameBag || !this.raceGameBag.length) {
      this.raceGameBag = shuffled(pool);
      if (this.raceGameBag.length > 1 && this.raceGameBag[0] === this.raceLastGame) this.raceGameBag.push(this.raceGameBag.shift());
    }
    this.raceLastGame = this.raceGameBag.shift();
    return this.raceLastGame;
  }

  // 클라이언트가 보내는 진행 신호: "sticker-done"(송장 붙이기 끝 -> 우봉고로) / "ubongo-done"(우봉고 완료 = 투입) / "give-up"(이번 라운드 포기)
  raceStep(seat, step, round) {
    if (this.state.phase !== "secure" || !this.rules.raceMode) return;
    const r = this.state.race;
    if (!r || (seat !== "1" && seat !== "2")) return;
    if (round != null && round !== r.round) return; // 지난 라운드의 늦게 도착한 메시지
    if (r.status === "reveal") return;
    const st = r.stage[seat];
    const now = Date.now();
    this.touch();
    if (step === "sticker-done") {
      if (st !== "sticker") return;
      r.stage[seat] = "ubongo";
    } else if (step === "ubongo-done") {
      if (st !== "ubongo") return;
      if (r.first && r.first !== seat && now > r.secondEndsAt) { r.stage[seat] = "out"; this._raceAdvance(); return; }
      r.stage[seat] = "done";
      r.finishedAt[seat] = now;
      if (!r.first) {
        r.first = seat;
        r.status = "picking";
        r.pickEndsAt = this.rules.raceAutoPick ? now + this.rules.racePickMs : null;
        r.secondEndsAt = now + this.rules.raceSecondMs;
      }
    } else if (step === "give-up") {
      if (st === "done" || st === "out") return;
      r.stage[seat] = "out";
    } else return;
    this._raceAdvance();
  }

  // 먼저 끝낸 사람이 공개된 택배 중 하나를 고른다 (pair 인덱스)
  racePick(seat, idx) {
    if (this.state.phase !== "secure" || !this.rules.raceMode) return;
    const r = this.state.race;
    if (!r || r.status !== "picking" || r.picks[seat] !== null) return;
    if (typeof idx !== "number" || !r.pair[idx]) return;
    if (r.picks["1"] === idx || r.picks["2"] === idx) return; // 이미 가져간 택배
    // 고를 수 있는 사람: 먼저 끝낸 사람 / (먼저 끝낸 사람이 고른 뒤) 마감 안에 투입한 늦은 사람
    const isFirst = r.first === seat;
    const isSecond = !isFirst && r.picks[r.first] !== null && r.stage[seat] === "done";
    if (!isFirst && !isSecond) return;
    this.touch();
    this._raceGrant(seat, idx);
    this._raceAdvance();
  }

  _raceGrant(seat, idx) {
    const r = this.state.race;
    const item = r.pair[idx];
    const cell = cellById(this.state, item.cellId);
    if (!cell || cell.taken) return;
    cell.taken = true;
    cell.takenBy = seat;
    this.state.acquireCounter[seat] += 1;
    cell.acquiredSeq = this.state.acquireCounter[seat];
    const room = drawRoom(this.state.players[seat]);
    this.state.players[seat].invoices.push({
      id: "inv-" + seat + "-" + cell.acquiredSeq,
      catIdx: item.catIdx, floorIdx: item.floorIdx, room, acquiredSeq: cell.acquiredSeq,
      reward: item.reward, deliveredRound: null, stolen: false, deliveredWasPriority: false,
    });
    r.picks[seat] = idx;
    r.invoiceIds[seat] = this.state.players[seat].invoices[this.state.players[seat].invoices.length - 1].id;
  }

  // 안 고르고 마감이 지나면: 남은 것 중 무작위(기본, raceAutoPickMode "random") 또는 "기본 금액"이 가장 비싼 종류("best").
  //   (층·금액은 고르기 전엔 모르는 정보라 그걸로 고르지 않는다)
  _raceAutoPick(seat) {
    const r = this.state.race;
    const rest = r.pair.map((_, i) => i).filter((i) => r.picks["1"] !== i && r.picks["2"] !== i);
    if (!rest.length) return;
    if (this.rules.raceAutoPickMode !== "best") { this._raceGrant(seat, rest[Math.floor(Math.random() * rest.length)]); return; }
    let best = rest[0];
    rest.forEach((i) => { if (TYPES[r.pair[i].catIdx].reward > TYPES[r.pair[best].catIdx].reward) best = i; });
    this._raceGrant(seat, best);
  }

  // 상태를 한 단계씩 진행시키고 다음 마감 타이머를 건다. 모든 액션/타이머가 여기를 거친다.
  _raceAdvance() {
    if (this.state.phase !== "secure") return;
    const r = this.state.race;
    if (!r) return;
    const now = Date.now();
    const other = (s) => (s === "1" ? "2" : "1");
    if (r.status === "playing") {
      if (r.stage["1"] === "out" && r.stage["2"] === "out") this._raceReveal(); // 둘 다 포기 -- 아무도 못 가져감
    }
    if (r.status === "picking") {
      const f = r.first, s2 = other(f);
      if (this.rules.raceAutoPick && r.picks[f] === null && now >= r.pickEndsAt) this._raceAutoPick(f);
      if (r.picks[f] !== null) {
        const rest = r.pair.map((_, i) => i).filter((i) => r.picks["1"] !== i && r.picks["2"] !== i);
        // 늦은 사람이 마감 안에 투입하지 못했으면 탈락
        if (r.stage[s2] !== "done" && r.stage[s2] !== "out" && now >= r.secondEndsAt) r.stage[s2] = "out";
        if (r.stage[s2] === "done" && r.picks[s2] === null && rest.length) {
          // 늦은 사람의 고르기 창: 먼저 끝낸 사람이 고른 뒤(또는 늦은 사람이 그 뒤에 투입한 뒤)부터 RACE_PICK_MS
          if (!r.secondPickEndsAt && this.rules.raceAutoPick) r.secondPickEndsAt = now + this.rules.racePickMs;
          if (rest.length === 1) this._raceGrant(s2, rest[0]); // 하나 남았으면 고를 것 없이 그것
          else if (this.rules.raceAutoPick && now >= r.secondPickEndsAt) this._raceAutoPick(s2);
        }
        const secondSettled = r.stage[s2] === "out" || r.picks[s2] !== null || !rest.length;
        if (secondSettled) this._raceReveal();
      }
    }
    if (r.status === "reveal" && now >= r.revealEndsAt) {
      const next = r.round + 1;
      this._raceNewRound(next);
      if (!this.state.race) { this.emit(); return; } // 다 떨어짐 -- 조기 종료는 _raceReveal에서 이미 처리
    }
    // 다음 마감
    const cur = this.state.race;
    let nextTs = null;
    if (cur.status === "picking") {
      const cand = [];
      const s2 = other(cur.first);
      if (this.rules.raceAutoPick && cur.picks[cur.first] === null) cand.push(cur.pickEndsAt);
      if (cur.stage[s2] !== "done" && cur.stage[s2] !== "out") cand.push(cur.secondEndsAt);
      if (this.rules.raceAutoPick && cur.secondPickEndsAt && cur.picks[s2] === null) cand.push(cur.secondPickEndsAt);
      if (cand.length) nextTs = Math.min.apply(null, cand);
    } else if (cur.status === "reveal") nextTs = cur.revealEndsAt;
    this._raceAt(nextTs);
    this.emit();
  }

  _raceReveal() {
    const r = this.state.race;
    r.status = "reveal";
    r.discarded = r.pair.map((_, i) => i).filter((i) => r.picks["1"] !== i && r.picks["2"] !== i);
    // 아무도 안 가져간 택배: 레일로 돌아가 다음 라운드에 다시 나올 수 있다(기본). raceLeftoverReturn이 false면 사라진다(주인 없이 보드에서 빠짐).
    if (!this.rules.raceLeftoverReturn) {
      r.discarded.forEach((i) => { const c = cellById(this.state, r.pair[i].cellId); if (c && !c.taken) { c.taken = true; c.takenBy = null; } });
    }
    r.revealEndsAt = Date.now() + this.rules.raceRevealMs;
    // 보드가 다 비면 결과를 잠깐 보여 준 뒤 엘리베이터로 (예전 조기 종료와 같은 방식, 결과 표시 시간만큼 기다림)
    if (this.state.board.every((c) => c.taken)) {
      this.state.secureEndsAt = r.revealEndsAt;
      this._scheduleAt(this.state.secureEndsAt, () => this._endSecurePhase());
    }
  }

  // ---- secure phase ----
  // 보드는 두 플레이어가 공유한다(종류별 6칸 = 합계 6개). 누가 미니게임을 "먼저 끝내느냐"가 곧 선착순이다
  // (여는 순간 잠그지 않는다 -- 사용자 결정 2026-10-06: "한 사람이 완료해서 박스를 만들면 총 개수에서 줄어든다").
  //  * 일반/깨지기/귀중품: 칸은 서로 구별이 없다(그냥 개수). 클라이언트가 보낸 칸이 이미 남이 가져갔어도
  //    같은 종류의 빈 칸 아무거나를 대신 준다. 종류 전체가 소진됐으면 그냥 무시(= 늦은 사람은 허탕).
  //  * 확정 층수 택배: 칸이 곧 배송 층이라 서로 대체가 안 된다. 그 층을 이미 남이 가져갔으면 무시(선점자 우선).
  // 포기(클라이언트가 이 메시지를 안 보내고 게임만 닫음)는 여기까지 오지 않으므로 보드는 그대로다.
  secureCell(seat, cellId) {
    if (this.state.phase !== "secure") return;
    if (this.rules.raceMode) return; // 레이스 모드에서는 raceStep/racePick으로만 확보
    let cell = cellById(this.state, cellId);
    if (!cell) return; // 모르는 id
    if (cell.taken) {
      if (cell.takenBy === seat) return; // 내가 이미 가진 칸에 대한 중복 메시지 -- 무시 (대체 칸을 또 주면 안 된다)
      if (TYPES[cell.catIdx].fixedFloor) return;
      cell = this.state.board.find((c) => c.catIdx === cell.catIdx && !c.taken) || null;
      if (!cell) return;
    }
    this.touch();
    cell.taken = true;
    cell.takenBy = seat;
    this.state.acquireCounter[seat] += 1;
    cell.acquiredSeq = this.state.acquireCounter[seat];
    const room = drawRoom(this.state.players[seat]);
    this.state.players[seat].invoices.push(randomInvoice(seat, cell.catIdx, cell.num, cell.acquiredSeq, room, this.rules.floorRewardMult));
    // 2026-10-07: 보드가 다 비면 남은 시간을 기다리지 않고 곧 엘리베이터로 넘어간다(할 게 없는 빈 시간 방지).
    // 클라이언트의 카운트다운이 secureEndsAt을 보므로 그 값을 짧게 당겨 둔다. _scheduleAt은 타이머 슬롯이 하나라
    // 원래의 3분 타이머를 대체한다(낡은 타이머가 다음 하프의 확보 단계를 끊을 일 없음).
    if (this.state.board.every((c) => c.taken)) {
      this.state.secureEndsAt = Date.now() + SECURE_EARLY_END_MS;
      this._scheduleAt(this.state.secureEndsAt, () => this._endSecurePhase());
    }
    this.emit();
  }

  // 2026-10-07 레일 사이트(/rail): 공용 레일 화면에서 seat 쪽 버튼이 눌렸을 때 "그 좌석 플레이어가 풀 칸"을 정해 돌려준다.
  // 상태는 바꾸지 않는다(칸은 플레이어가 미니게임을 끝내고 secure-cell을 보낼 때 확보됨 -- 위 secureCell 규칙 그대로).
  //  * 일반/깨지기/귀중품: 그 종류의 아직 안 가져간 첫 칸. 없으면 null(소진).
  //  * 확정 층수 택배: 레일 화면이 고른 층(cellId)이 아직 비어 있어야 한다. 아니면 null.
  // 좌석 주인이 없거나 확보 단계가 아니면 null.
  railCellFor(seat, catIdx, cellId) {
    if (this.state.phase !== "secure") return null;
    if (this.rules.raceMode) return null;
    if (seat !== "1" && seat !== "2") return null;
    if (!this.state.seatOwners[seat]) return null;
    const t = TYPES[catIdx];
    if (!t) return null;
    if (t.fixedFloor) {
      const c = cellById(this.state, cellId);
      return c && c.catIdx === catIdx && !c.taken ? c.id : null;
    }
    const free = this.state.board.find((c) => c.catIdx === catIdx && !c.taken);
    return free ? free.id : null;
  }

  _endSecurePhase() {
    if (this.state.phase !== "secure") return;
    this._raceAt(null);
    this.state.race = null;
    this.state.phase = "elevator";
    this.state.elevator = freshElevator(this.rules);
    this.emit();
  }

  // ---- elevator phase ----
  // 우선 택배 지정 (2026-08-27: 게임/하프 전체 1회 -> 매 라운드 새로 지정으로 변경). 2026-10-06부터는
  // 게이트가 아니라 전용 "priority" 시간(PRIORITY_PICK_MS)에서만, 그리고 내가 아직 "확정"하지 않았을 때만
  // 바꿀 수 있다 -- 그 라운드가 실제로 진행되는 동안(voting/choosing)은 고정. 최대 1개, 선택 사항이며
  // 확정 전에는 null로 되돌려 지정 해제 가능.
  // 그 라운드에 정확히 그 송장이 배송돼야만 PRIORITY_MULTIPLIER가 적용된다 (다음 라운드로 안 넘어감).
  setPriorityPick(seat, invoiceId) {
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "priority" || el.priorityConfirmed[seat]) return;
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
  // players are ready: the 10s priority-pick window (_startPriorityWindow) comes first, then in 후반
  // (half===2) the THIEF_PLACE_MS window (_startThiefWindow); in 전반 there's no thief mechanic, so voting.
  _enterNextRound() {
    this._startPriorityWindow();
  }

  // 우선 택배 지정 전용 시간 (2026-10-06 신설). 매 라운드 맨 처음 PRIORITY_PICK_MS(10초) 동안 열리고,
  // 둘 다 "확정"(지정하거나 "지정 안 함")하면 시간을 다 기다리지 않고 곧장 다음 단계로 넘어간다.
  // 지정할 미배송 택배가 없는 플레이어는 자동 확정이고, 둘 다 그렇다면 창 자체를 열지 않는다
  // (thief 창과 같은 패턴). 지난 라운드의 지정값은 _finishRound에서 이미 비워져 있다.
  _startPriorityWindow() {
    const el = this.state.elevator;
    el.resultEndsAt = null;
    el.priorityPick = { "1": null, "2": null };
    // P2-2 (2026-10-13): 후반이면 택배도둑 배치도 이 창에서 같이 받는다. 도둑 슬롯 준비(지난 라운드 배치분 activate,
    // 이번 라운드 슬롯 초기화, 한도 소진/마지막 라운드 자동 넘김)는 원래 _startThiefWindow 앞부분과 똑같다.
    const merged = this._mergedThiefWindow();
    if (merged) this._prepareThiefSlots();
    ["1", "2"].forEach((s) => {
      const nothingToPick = !this.state.players[s].invoices.some((v) => v.deliveredRound === null);
      const thiefDone = !merged || el.thieves.skipped[s];
      el.priorityConfirmed[s] = nothingToPick && thiefDone;
    });
    if (el.priorityConfirmed["1"] && el.priorityConfirmed["2"]) { this._afterPriorityWindow(); return; }
    el.state = "priority";
    const endsAt = Date.now() + PRIORITY_PICK_MS;
    el.priorityWindowEndsAt = endsAt;
    this._scheduleAt(endsAt, () => this._endPriorityWindow(endsAt));
    this.emit();
  }

  confirmPriority(seat) {
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    if (el.state !== "priority" || el.priorityConfirmed[seat]) return;
    this.touch();
    el.priorityConfirmed[seat] = true;
    // 합쳐진 창: 확정하면서 도둑을 안 놓았다면 "이번 라운드는 안 놓음"으로 처리한다 (한도는 소진되지 않음).
    if (this._mergedThiefWindow() && el.thieves.placedThisRound[seat] === null) el.thieves.skipped[seat] = true;
    if (el.priorityConfirmed["1"] && el.priorityConfirmed["2"]) { this._afterPriorityWindow(); return; }
    this.emit();
  }

  // expectedEndsAt: 이전 라운드의 (조기 종료돼서 이미 쓸모없어진) 타이머가 이번 라운드의 새 창을
  // 중간에 끊지 못하도록, 이 타이머가 연 바로 그 창일 때만 동작한다.
  _endPriorityWindow(expectedEndsAt) {
    const el = this.state.elevator;
    if (this.state.phase !== "elevator" || el.state !== "priority") return;
    if (expectedEndsAt !== undefined && el.priorityWindowEndsAt !== expectedEndsAt) return;
    this._afterPriorityWindow();
  }

  _afterPriorityWindow() {
    this.state.elevator.priorityWindowEndsAt = null;
    if (this.state.half === 2 && !this.rules.mergePriorityThief) this._startThiefWindow();
    else this._startVotingRound();
  }

  _mergedThiefWindow() {
    return !!this.rules.mergePriorityThief && this.state.half === 2;
  }

  // 도둑 슬롯 준비 -- 지난 라운드에 놓은 도둑을 이번 라운드에 작동하도록 activate하고, 이번 라운드 몫의 배치 슬롯을 새로 연다.
  // 한도(THIEF_PER_HALF)를 다 쓴 사람은 자동 넘김. 마지막 라운드는 놓아도 작동할 다음 라운드가 없으니 모두 자동 넘김.
  // 반환값: 이번 라운드에 아무도 놓을 수 없으면 true.
  _prepareThiefSlots() {
    const el = this.state.elevator;
    el.thieves.active = ["1", "2"]
      .filter((s) => el.thieves.placedThisRound[s] !== null)
      .map((s) => ({ seat: s, floorIdx: el.thieves.placedThisRound[s] }));
    el.thieves.placedThisRound = { "1": null, "2": null };
    el.thieves.skipped = { "1": false, "2": false };
    const usedUp = (s) => el.thieves.usedThisHalf[s] >= THIEF_PER_HALF;
    const lastRound = el.round >= ELEVATOR_ROUNDS;
    ["1", "2"].forEach((s) => { if (usedUp(s) || lastRound) el.thieves.skipped[s] = true; });
    return lastRound || ["1", "2"].every(usedUp);
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
    // (P2-2 합친 창을 쓰지 않을 때만 오는 예전 경로. 합친 창은 _prepareThiefSlots를 쓴다.)
    // 이미 이 후반의 배치 한도(THIEF_PER_HALF)를 다 쓴 플레이어는 이번 라운드도 자동으로 "넘김" 처리해서
    // 굳이 화면에서 다시 액션을 요구하지 않는다. 둘 다 다 썼다면 아무도 놓을 수 없으니 thief 창 자체를
    // 열지 않고 곧장 voting으로 넘어간다. 마지막 라운드도 창을 열지 않는다: 도둑은 "다음 라운드부터"
    // 작동하는데 다음 라운드가 없어서, 놓으면 한도만 날리는 함정이 되기 때문 (2026-10-07).
    const usedUp = (s) => el.thieves.usedThisHalf[s] >= THIEF_PER_HALF;
    ["1", "2"].forEach((s) => { if (usedUp(s)) el.thieves.skipped[s] = true; });
    if (el.round >= ELEVATOR_ROUNDS || ["1", "2"].every(usedUp)) { this._startVotingRound(); return; }
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
  // 넘겼다면 무시. 1인당 이 후반 전체를 통틀어 배치는 THIEF_PER_HALF(2)번까지만 허용된다(usedThisHalf) -- 이미 다 썼다면 _startThiefWindow가 매 라운드 자동으로 스킵 처리해두므로 여기까지
  // 오는 일 자체가 없다. 배치 직후엔 아무 효과 없고, 다음 라운드의 thief 창이 열릴 때
  // (_startThiefWindow) active로 넘어가 작동한다. floorIdx가 null이면 "이번 라운드엔 안 놓음"으로
  // 명시적으로 넘기는 것(usedThisHalf는 소진되지 않음) -- 두 플레이어 모두 배치/넘기기를 마치면
  // THIEF_PLACE_MS를 다 기다리지 않고 곧장 voting으로 넘어간다.
  placeThief(seat, floorIdx) {
    if (this.state.half !== 2) return;
    if (this.state.phase !== "elevator") return;
    const el = this.state.elevator;
    const inMergedWindow = el.state === "priority" && this._mergedThiefWindow();
    if (el.state !== "thief" && !inMergedWindow) return;
    if (inMergedWindow && el.priorityConfirmed[seat]) return; // 확정한 뒤엔 못 바꿈
    if (el.thieves.placedThisRound[seat] !== null || el.thieves.skipped[seat]) return;
    if (floorIdx !== null && (typeof floorIdx !== "number" || floorIdx < 0 || floorIdx >= FLOORS.length)) return;
    this.touch();
    if (floorIdx === null) {
      el.thieves.skipped[seat] = true;
    } else {
      el.thieves.placedThisRound[seat] = floorIdx;
      el.thieves.usedThisHalf[seat] += 1; // 후반 전체 한도(THIEF_PER_HALF)에서 1회 차감
    }
    // 합쳐진 창에서는 도둑을 놓아도 창이 닫히지 않는다 -- 둘 다 "확정"(confirmPriority)해야 진행.
    if (inMergedWindow) { this.emit(); return; }
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
      // P2-3 (2026-10-13): 선택 창 없이 자동으로 -- 이번 라운드 우선 지정한 것 > 배송 금액이 큰 것 > 먼저 확보한 것.
      if (this.rules.sameFloorAutoPick && invs.length > 1) {
        const pick = el.priorityPick[seat];
        const val = (x) => (typeof x.reward === "number" ? x.reward : TYPES[x.catIdx].reward);
        v = invs.slice().sort((a, b) => ((b.id === pick) - (a.id === pick)) || (val(b) - val(a)) || (a.acquiredSeq - b.acquiredSeq))[0];
      }
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
        reward: typeof v.reward === "number" ? v.reward : TYPES[v.catIdx].reward, // 층 배율 적용된 금액 (표시용)
        stolen: !!thief, priority: !thief && wasPriority,
      });
    });
    return delivered;
  }

  _computeHalfScores() {
    return { "1": totalScore("1", this.state), "2": totalScore("2", this.state) };
  }

  // 2026-10-14 덜컹 (ELEVATOR_JOLT): 두 사람 모두 눌렀는데 시작 층 그대로면 무작위로 한 층 위/아래. el.jolt = { from, to, dir }.
  _maybeJolt() {
    const el = this.state.elevator;
    el.jolt = null;
    if (!this.rules.elevatorJolt || el.floorIdx !== el.roundStartFloorIdx) return;
    const pressed = (s) => (el.votes[s].up + el.votes[s].down) > 0;
    if (!pressed("1") || !pressed("2")) return;
    const from = el.floorIdx;
    let d = Math.random() < 0.5 ? -1 : 1;
    if (from + d < 0 || from + d >= FLOORS.length) d = -d;
    el.floorIdx = from + d;
    el.jolt = { from, to: el.floorIdx, dir: d > 0 ? "up" : "down" };
  }

  _finishRound(round, forcedChoice) {
    const el = this.state.elevator;
    const v1 = el.votes["1"], v2 = el.votes["2"];
    const totalUp = v1.up + v2.up, totalDown = v1.down + v2.down;
    // 덜컹했으면 줄다리기 결과는 "동률"이고, 실제 층은 덜컹한 층이다 (log.jolt)
    const dir = el.jolt ? "tie" : (el.floorIdx > el.roundStartFloorIdx ? "up" : (el.floorIdx < el.roundStartFloorIdx ? "down" : "tie"));
    const delivered = this._applyDeliveries(round, forcedChoice);
    el.log.push({ round, up: totalUp, down: totalDown, dir, floorIdx: el.floorIdx, delivered, jolt: el.jolt || null });
    el.jolt = null;
    el.pendingChoice = null;
    // 이번 라운드의 우선 택배 지정은 이번 라운드 배송에만 유효했다 -- 다음 라운드 게이트에서는
    // 다시 비어 있는 상태로 새로 골라야 한다 ("매 라운드마다 지정").
    el.priorityPick = { "1": null, "2": null };
    // Pause here regardless of whether this was the final round -- both players press space to
    // continue (mirrors the lobby's ready-up gate), so there's always time to read the result
    // and see what was just delivered before moving on.
    el.state = "result";
    el.readyNext = { "1": false, "2": false };
    // P2-1 (2026-10-13): 결과를 RESULT_AUTO_ADVANCE_MS 동안 보여준 뒤 스페이스 없이 자동으로 다음으로 넘어간다.
    // 둘 다 스페이스를 누르면 그보다 일찍 넘어간다(setElevatorReady). 0이면 예전처럼 스페이스 게이트만.
    el.resultEndsAt = null;
    if (this.rules.resultAutoAdvanceMs > 0) {
      const endsAt = Date.now() + this.rules.resultAutoAdvanceMs;
      el.resultEndsAt = endsAt;
      this._scheduleAt(endsAt, () => this._autoAdvanceFromResult(endsAt));
    }
    this.emit();
  }

  _autoAdvanceFromResult(expectedEndsAt) {
    const el = this.state.elevator;
    if (this.state.phase !== "elevator" || el.state !== "result" || el.resultEndsAt !== expectedEndsAt) return;
    this._advanceFromResult();
  }

  // result 게이트를 통과할 때(둘 다 스페이스 또는 자동 진행): 다음 라운드, 마지막 라운드였다면 하프 종료.
  _advanceFromResult() {
    const el = this.state.elevator;
    el.resultEndsAt = null;
    if (el.round >= ELEVATOR_ROUNDS) {
      el.state = "done";
      this._finishHalf();
    } else {
      el.round += 1;
      this._enterNextRound(); // also emits
    }
  }

  // The floor has already moved live, click by click, over the course of the round (see vote()) --
  // this locks in wherever it ended up. Before delivering, check whether either player has 2+
  // undelivered invoices bound for that exact floor -- if so, give them SAME_FLOOR_CHOICE_MS to
  // pick which one goes first (random if they don't answer in time) instead of always defaulting
  // to earliest-acquired. If nobody has a conflict, deliveries resolve immediately as before.
  _resolveRound() {
    if (this.state.phase !== "elevator" || this.state.elevator.state !== "voting") return;
    const el = this.state.elevator;
    this._maybeJolt();
    const floorIdx = el.floorIdx;
    if (this.rules.sameFloorAutoPick) { this._finishRound(el.round, null); return; }
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
    this._advanceFromResult();
  }

  // Ends the current half: snapshots this half's per-player invoices + score into halfHistory.
  // After half 1, moves to a "halftime" transition screen (both press space to start half 2 --
  // fresh board/invoices, thief mechanic unlocked). After half 2, sums both halves' scores into
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
    this.state.board = freshBoard();
    this.state.acquireCounter = { "1": 0, "2": 0 };
    this.state.players = freshPlayers();
    this.state.elevator = freshElevator(this.rules);
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
    this.state.board = freshBoard();
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

module.exports = { GameRoom, initialState, scoreInvoice, resultLabel, totalScore, rewardFor, DEFAULT_RULES, LEGACY_RULES };
