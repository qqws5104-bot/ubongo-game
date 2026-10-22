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
  PRIORITY_MULTIPLIER, SET_BONUS, SET_BONUS_KINDS, TUTORIAL_PAGES, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS, THIEF_PER_HALF, PRIORITY_PICK_MS,
  FLOOR_REWARD_MULT, START_FLOOR_CHOICES, ELEVATOR_JOLT, RESULT_AUTO_ADVANCE_MS, MERGE_PRIORITY_THIEF, SAME_FLOOR_AUTO_PICK,
  RACE_MODE, RACE_PICK_MS, RACE_SECOND_MS, RACE_REVEAL_MS, RACE_PUZZLE_ORDER, RACE_PARCELS, RACE_LEFTOVER_RETURN, RACE_AUTO_PICK, RACE_GAME_POOL, RACE_AUTO_PICK_MODE, RACE_PIECES_BY_ROUND, RACE_CONSOLATION_MS, RACE_EXCLUDE_KINDS, FLOOR_LIMITS,
  APT_WAR, ELEV_MOVE_MS, ELEV_WAR_TAPS, ELEV_SETTLE_MS, ELEV_OPEN_MS, ELEV_DELIVER_TAPS, ELEV_FLIP_FORCE, ELEV_WAR_MOVE_MS,
  WALL_MODE, UNITS, DELIVERY_MS, DELIVERY_PROGRESS_MS, DELIVERY_HOLD_MS, DELIVERY_ELEVATOR, DELIVERY_ELEV_START, DELIVERY_ELEV_MOVE_MS, DELIVERY_RETURN_TAPS, DELIVERY_MAX_ACTIVE, DELIVERY_WRONG_PENALTY, COMBO_BUILDING_BONUS, DELIVERY_MODES, DELIVERY_CLIMB_STEPS, DELIVERY_BELL_WAIT_MS, DELIVERY_BELL_WINDOW_MS, CONTEST_RATE, BLOCK_REWARD, FEVER_MS, FEVER_MULT, RACE_GRANT_PLAN, RACE_GRANT_BY_PIECES, RACE_UNLIMITED, RACE_PIECE_GAMES, RACE_PIECE_GAME_KINDS,
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
  racePiecesByRound: RACE_PIECES_BY_ROUND,
  raceConsolationMs: RACE_CONSOLATION_MS,
  raceExcludeKinds: RACE_EXCLUDE_KINDS,
  elevatorJolt: !!ELEVATOR_JOLT,
  setBonus: SET_BONUS,
  setBonusKinds: SET_BONUS_KINDS,
  // 2026-10-15 시작 전 튜토리얼. 기본은 끔(GameRoom을 직접 쓰는 테스트가 곧장 확보로 가도록) -- 실제 서버(server.js)가 켠다.
  tutorial: false,
  // 2026-10-16 벽 배송 + 택배 쌓기 몫(game-data.js WALL_MODE / RACE_GRANT_PLAN 참고)
  // 환경변수 WALL=0이면 예전 흐름(한 사람 하나씩 고르기 -> 엘리베이터 라운드). 예전 회귀 테스트(regress.sh)가 이걸로 돈다.
  wallMode: !!WALL_MODE && process.env.WALL !== "0",
  raceGrantPlan: process.env.WALL === "0" ? null : RACE_GRANT_PLAN,
  raceGrantByPieces: process.env.WALL === "0" ? null : RACE_GRANT_BY_PIECES,
  raceUnlimited: !!RACE_UNLIMITED && process.env.WALL !== "0",
  racePieceGames: !!RACE_PIECE_GAMES && process.env.WALL !== "0", // 2026-10-16 조각마다 반응형 미니게임 (몫 계획 모드에서만)
  deliveryMs: DELIVERY_MS,
  deliveryProgressMs: DELIVERY_PROGRESS_MS,
  deliveryHoldMs: DELIVERY_HOLD_MS,
  deliveryElevator: !!DELIVERY_ELEVATOR,
  deliveryElevStart: DELIVERY_ELEV_START,
  deliveryElevMoveMs: DELIVERY_ELEV_MOVE_MS,
  deliveryReturnTaps: DELIVERY_RETURN_TAPS,
  deliveryMaxActive: DELIVERY_MAX_ACTIVE,
  deliveryWrongPenalty: DELIVERY_WRONG_PENALTY,
  deliveryModes: process.env.DELIVERY_MODES === "same" ? { apt: "wait", mansion: "wait", house: "wait" } : DELIVERY_MODES,
  deliveryClimbSteps: DELIVERY_CLIMB_STEPS,
  deliveryBellWaitMs: DELIVERY_BELL_WAIT_MS,
  deliveryBellWindowMs: DELIVERY_BELL_WINDOW_MS,
  // 2026-10-21 테스트 1용: COMPETE=0 이면 ⚔ 같은 집 쟁탈과 막기 보상을 같이 끈다 (CONTEST=0 / BLOCK=0 으로 따로도 가능). 막기 자체(반송)는 그대로.
  contestRate: process.env.CONTEST === "0" || process.env.COMPETE === "0" ? 0 : CONTEST_RATE,
  blockReward: process.env.BLOCK === "0" || process.env.COMPETE === "0" ? 0 : BLOCK_REWARD,
  // 2026-10-22 (사용자 결정): 문마다 빨강·파랑 버튼 한 쌍. 팀이 정해진 입력으로 상대가 켠 문을 누르면 = 막기 1회(누가 막았는지도 안다).
  //   PAIR_BUTTONS=0 이면 예전(팀 키로는 상대 문을 못 막고, 팀 키 없이 누른 입력만 막기).
  deliveryPairButtons: process.env.PAIR_BUTTONS !== "0",
  feverMs: process.env.FEVER === "0" ? 0 : FEVER_MS,
  feverMult: FEVER_MULT,
  comboBuildingBonus: APT_WAR ? 0 : COMBO_BUILDING_BONUS, // 아파트 한 채면 건물 콤보 없음
  // 2026-10-22 아파트 한 채 + 엘리베이터 이동 전쟁 (game-data.js APT_WAR 참고)
  aptWar: !!APT_WAR,
  elevWarTaps: ELEV_WAR_TAPS,
  elevMoveMs: ELEV_MOVE_MS,
  elevSettleMs: ELEV_SETTLE_MS,
  elevOpenMs: ELEV_OPEN_MS,
  elevDeliverTaps: ELEV_DELIVER_TAPS,
  elevFlipForce: ELEV_FLIP_FORCE,
  elevWarMoveMs: ELEV_WAR_MOVE_MS,
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
  setBonus: 0,
  wallMode: false,
  raceGrantPlan: null,
  raceGrantByPieces: null,
  raceUnlimited: false,
  racePieceGames: false,
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
// 2026-10-15: 종류별 가능한 층 (FLOOR_LIMITS, 예: 귀중품은 B1·5F 제외). 확정 층수 택배는 칸 번호가 곧 층.
function drawFloor(catIdx, num) {
  const t = TYPES[catIdx];
  if (t.fixedFloor) return num;
  const allowed = (FLOOR_LIMITS && FLOOR_LIMITS[t.key]) || null;
  if (allowed && allowed.length) return allowed[Math.floor(Math.random() * allowed.length)];
  return Math.floor(Math.random() * FLOORS.length);
}
function randomInvoice(seat, catIdx, num, acquiredSeq, room, floorRewardMult) {
  const t = TYPES[catIdx];
  const floorIdx = drawFloor(catIdx, num);
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
  if (inv.lost) return 0; // 2026-10-16 같은 집 쟁탈: 상대가 먼저 배송 -- 0원(감점 없음)
  if (inv.returned) return -t.penalty; // 2026-10-16 벽 배송: 반송(상대가 5번 눌러 끔)
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
  if (inv.lost) return "선점당함";
  if (inv.returned) return "반송";
  if (inv.stolen) return "미배송"; // deliveredRound는 채워져 있지만(재배송 방지용) 라벨은 미배송 취급
  return inv.deliveredRound === null ? "미배송" : "성공";
}
// 2026-10-15 종류 모으기 보너스: 이 송장 목록(한 하프)에서 배송 성공한 서로 다른 종류 수가 kinds 이상이면 amount. state.setRule = { amount, kinds }.
function deliveredKinds(invoices) {
  const kinds = {};
  invoices.forEach((inv) => { if (!inv.stolen && inv.deliveredRound !== null) kinds[inv.catIdx] = true; });
  return Object.keys(kinds).length;
}
function setBonusFor(invoices, setRule) {
  if (!setRule || !(setRule.amount > 0)) return 0;
  return deliveredKinds(invoices) >= setRule.kinds ? setRule.amount : 0;
}
// 2026-10-16 건물 콤보: 배송 성공한 건물 종류 수 (아파트/맨션/주택). state.wallRule.bldBonus가 있으면 3곳 다 가면 보너스.
function deliveredBuildings(invoices) {
  const b = {};
  invoices.forEach((inv) => {
    if (inv.stolen || inv.returned || inv.deliveredRound === null || !inv.unit) return;
    const u = UNITS.find((x) => x.id === inv.unit);
    if (u) b[u.b] = true;
  });
  return Object.keys(b).length;
}
function buildingBonusFor(invoices, wallRule) {
  if (!wallRule || !(wallRule.bldBonus > 0)) return 0;
  return deliveredBuildings(invoices) >= 3 ? wallRule.bldBonus : 0;
}
function totalScore(seat, state) {
  const invs = state.players[seat].invoices;
  const wrong = (state.players[seat].wrong || 0) * ((state.wallRule && state.wallRule.wrongPenalty) || 0); // 2026-10-16 오배송 감점
  const blocks = (state.players[seat].blocks || 0) * ((state.wallRule && state.wallRule.blockReward) || 0); // 2026-10-16 막기 보상
  return invs.reduce((sum, inv) => sum + scoreInvoice(inv), 0) + setBonusFor(invs, state.setRule) + buildingBonusFor(invs, state.wallRule) - wrong + blocks;
}

function freshBoard() {
  // takenBy: 이 칸을 확보한 좌석("1"/"2"). acquiredSeq는 그 좌석 안에서의 확보 순번이다(송장과 연결하는 키 --
  // 좌석이 다르면 같은 번호가 있을 수 있으니 항상 takenBy와 함께 본다).
  return CELLS.map((c) => ({ id: c.id, catIdx: c.catIdx, num: c.num, taken: false, takenBy: null, acquiredSeq: null }));
}
function freshPlayers() {
  // roomBag: 이 플레이어의 이번 하프용 "안 겹치는 호수" 셔플 가방 (drawRoom() 참고). 하프가 바뀌면
  // (freshPlayers()가 다시 호출되면) 완전히 새로 셔플돼서 이전 하프의 소진 상태를 이어받지 않는다.
  return { "1": { invoices: [], roomBag: shuffledRooms(), wrong: 0, blocks: 0 }, "2": { invoices: [], roomBag: shuffledRooms(), wrong: 0, blocks: 0 } };
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
    setRule: { amount: (rules && rules.setBonus) || 0, kinds: (rules && rules.setBonusKinds) || SET_BONUS_KINDS }, // 2026-10-15 종류 모으기 보너스 (클라이언트도 이걸로 계산)
    tutorial: null, // 2026-10-15 시작 전 튜토리얼 (phase "tutorial"일 때만)
    // 2026-10-16 벽 배송: 규칙 묶음(클라이언트 표시·점수 계산용)과 진행 상태(phase "delivery"일 때만)
    wallRule: (rules && rules.wallMode) ? { wrongPenalty: rules.deliveryWrongPenalty || 0, progressMs: rules.deliveryProgressMs, holdMs: rules.deliveryHoldMs || 0, elevator: !!rules.deliveryElevator, returnTaps: rules.deliveryReturnTaps, maxActive: rules.deliveryMaxActive, bldBonus: rules.comboBuildingBonus || 0, modes: rules.deliveryModes || null, climb: rules.deliveryClimbSteps || null, bellWindowMs: rules.deliveryBellWindowMs || 0, blockReward: rules.aptWar ? 0 : (rules.blockReward || 0), contest: (rules.contestRate || 0) > 0, pair: !!rules.deliveryPairButtons, feverMs: rules.feverMs || 0, feverMult: rules.feverMult || 1, war: rules.aptWar ? { moveMs: rules.elevMoveMs, openMs: rules.elevOpenMs, deliverTaps: rules.elevDeliverTaps } : null } : null,
    delivery: null,
    phase: "lobby", // lobby -> (tutorial) -> secure -> elevator -> halftime -> secure -> elevator -> end -> (재시작 시) secure ...
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
    this.logger = null; // 2026-10-21 플레이 기록 (server.js가 setLogger로 연결; 없으면 기록 안 함)
  }
  setLogger(fn) { this.logger = typeof fn === "function" ? fn : null; }
  _log(ev) {
    if (!this.logger) return;
    try { this.logger(Object.assign({ at: Date.now(), room: this.code, half: this.state.half || 1 }, ev)); } catch (e) {}
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    if (this.raceTimer) clearTimeout(this.raceTimer);
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
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
    if (this.state.ready["1"] && this.state.ready["2"]) { if (this.rules.tutorial) this._startTutorial(); else this._startGame(); }
    else this.emit();
  }

  // ---- 2026-10-15 시작 전 튜토리얼 ----
  // state.tutorial = { pages, page: {좌석: 보고 있는 장(0부터, pages면 다 봄)}, skip: {좌석: 건너뛰기 누름} }
  // 각자 넘기고, 둘 다 끝까지 보거나(page >= pages) 둘 다 건너뛰기를 누르면 확보 단계 시작.
  _startTutorial() {
    this.state.phase = "tutorial";
    this.state.tutorial = { pages: this.rules.wallMode ? 4 : TUTORIAL_PAGES, // 2026-10-16 벽 배송 튜토리얼은 4장 (build_client.py TUT_PAGES_WALL)
       page: { "1": 0, "2": 0 }, skip: { "1": false, "2": false } };
    this.emit();
  }
  tutorialStep(seat, dir) {
    const t = this.state.tutorial;
    if (this.state.phase !== "tutorial" || !t || (seat !== "1" && seat !== "2")) return;
    this.touch();
    if (dir === "prev") t.page[seat] = Math.max(0, t.page[seat] - 1);
    else if (dir === "next") t.page[seat] = Math.min(t.pages, t.page[seat] + 1);
    else return;
    this._maybeEndTutorial();
  }
  tutorialSkip(seat) {
    const t = this.state.tutorial;
    if (this.state.phase !== "tutorial" || !t || (seat !== "1" && seat !== "2")) return;
    this.touch();
    t.skip[seat] = !t.skip[seat];
    this._maybeEndTutorial();
  }
  _maybeEndTutorial() {
    const t = this.state.tutorial;
    const done = (s) => t.page[s] >= t.pages || t.skip[s];
    const allSkip = t.skip["1"] && t.skip["2"];
    const allSeen = t.page["1"] >= t.pages && t.page["2"] >= t.pages;
    if (allSkip || allSeen || (done("1") && done("2"))) { this.state.tutorial = null; this._startGame(); return; }
    this.emit();
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
    // 2026-10-15: 레이스에서 빼는 종류(raceExcludeKinds, 기본 확정 층수)는 하프 첫 라운드에 보드에서 치운다(주인 없이 taken) --
    //   레일에 안 나오고, "보드가 다 비면 조기 종료"도 그대로 동작한다.
    if (roundNo === 1 && this.rules.raceExcludeKinds && this.rules.raceExcludeKinds.length) {
      this.state.board.forEach((c) => { if (!c.taken && this.rules.raceExcludeKinds.includes(TYPES[c.catIdx].key)) { c.taken = true; c.takenBy = null; c.excluded = true; } });
    }
    const plan = this._racePlanFor(roundNo);
    if (plan) { const pz = this._racePuzzleFor(roundNo); this._planNewRound(roundNo, this._planByPieces(pz) || plan, pz); return; }
    const free = this.state.board.filter((c) => !c.taken);
    if (!free.length) { this.state.race = null; this._raceAt(null); return; }
    const pair = shuffled(free).slice(0, Math.max(1, this.rules.raceParcels || 3)).map((c) => {
      const floorIdx = drawFloor(c.catIdx, c.num);
      return { cellId: c.id, catIdx: c.catIdx, floorIdx, reward: rewardFor(c.catIdx, floorIdx, this.rules.floorRewardMult) };
    });
    this.state.race = {
      round: roundNo, pair, game: null,
      puzzleId: this._racePuzzleFor(roundNo),
      stage: { "1": "sticker", "2": "sticker" }, // 아래에서 첫 게임이 없으면 둘 다 "ubongo"로
      finishedAt: { "1": null, "2": null },
      first: null, status: "playing",
      pickEndsAt: null, secondEndsAt: null, secondPickEndsAt: null, revealEndsAt: null,
      picks: { "1": null, "2": null }, invoiceIds: { "1": null, "2": null }, discarded: [],
      randomPick: { "1": false, "2": false }, // 시간이 지나 무작위로 받은 좌석 (화면 표시용)
    };
    this.state.race.game = this._raceNextGame();
    if (!this.state.race.game) this.state.race.stage = { "1": "ubongo", "2": "ubongo" };
    this._raceAt(null);
  }


  // ---- 2026-10-16 택배 쌓기 몫 계획 (rules.raceGrantPlan): 라운드마다 n개를 걸고 먼저 끝낸 사람이 first개, 늦은 사람이 나머지 ----
  _racePlanFor(roundNo) {
    const plan = this.rules.raceGrantPlan;
    if (!plan || !plan.length) return null;
    return plan[Math.min(roundNo, plan.length) - 1];
  }
  // 그 퍼즐(칸 id)의 조각 수
  _piecesOf(puzzleId) {
    if (!puzzleId) return null;
    const t = TYPES.find((x) => puzzleId.indexOf(x.key + "-") === 0 && /^\d+$/.test(puzzleId.slice(x.key.length + 1)));
    if (!t) return null;
    return Array.isArray(t.pieces) ? t.pieces[(this.state.half || 1) - 1] : t.pieces;
  }
  // 조각 수 -> rules.raceGrantByPieces 표
  _planByPieces(puzzleId) {
    const tbl = this.rules.raceGrantByPieces;
    const pieces = this._piecesOf(puzzleId);
    if (!tbl || !pieces) return null;
    return tbl[pieces] || null;
  }
  _heldUnits() {
    // 한 팀만 들고 있는 집 (이미 두 팀이 다 가진 집은 또 내지 않는다)
    const h = {};
    ["1", "2"].forEach((s) => this.state.players[s].invoices.forEach((v) => { if (v.unit && v.deliveredRound === null && !v.returned && !v.lost) { h[v.unit] = h[v.unit] || {}; h[v.unit][s] = true; } }));
    return Object.keys(h).filter((u) => Object.keys(h[u]).length === 1);
  }
  _usedUnits() {
    const used = {};
    ["1", "2"].forEach((s) => this.state.players[s].invoices.forEach((v) => { if (v.unit) used[v.unit] = true; }));
    return used;
  }
  _planNewRound(roundNo, plan, puzzleId) {
    const n = Math.max(1, plan.parcels | 0);
    const excl = this.rules.raceExcludeKinds || [];
    let items = [];
    if (this.rules.raceUnlimited) {
      const bag = [];
      TYPES.forEach((t, ci) => { if (!excl.includes(t.key)) for (let k = 0; k < t.count; k++) bag.push(ci); });
      for (let k = 0; k < n; k++) items.push({ cellId: null, catIdx: bag[Math.floor(Math.random() * bag.length)] });
    } else {
      if (roundNo === 1 && excl.length) this.state.board.forEach((c) => { if (!c.taken && excl.includes(TYPES[c.catIdx].key)) { c.taken = true; c.takenBy = null; c.excluded = true; } });
      const free = this.state.board.filter((c) => !c.taken);
      if (!free.length) { this.state.race = null; this._raceAt(null); return; }
      items = shuffled(free).slice(0, n).map((c) => ({ cellId: c.id, catIdx: c.catIdx, num: c.num }));
    }
    const used = this._usedUnits();
    const pool = shuffled(UNITS.filter((u) => !used[u.id]));
    // 2026-10-16 같은 집 쟁탈: 일부는 지금 누군가 들고 있는(미배송) 집으로
    const held = shuffled(this._heldUnits());
    const inRound = {};
    const pair = items.map((it, k) => {
      const out = { cellId: it.cellId, catIdx: it.catIdx, floorIdx: null, unit: null, reward: TYPES[it.catIdx].reward };
      if (this.rules.wallMode) {
        let uid = null;
        if (held.length && Math.random() < (this.rules.contestRate || 0)) { uid = held.find((x) => !inRound[x]) || null; }
        if (!uid) { const f = pool.find((u) => !inRound[u.id]); uid = (f || UNITS[Math.floor(Math.random() * UNITS.length)]).id; }
        inRound[uid] = true; out.unit = uid;
      }
      else { out.floorIdx = drawFloor(it.catIdx, it.num || 0); out.reward = rewardFor(it.catIdx, out.floorIdx, this.rules.floorRewardMult); }
      return out;
    });
    this.state.race = {
      round: roundNo, pair, game: this._raceNextGame(), plan: { parcels: pair.length, first: Math.min(plan.first, pair.length), late: plan.late != null ? plan.late : null, lateFail: plan.lateFail != null ? plan.lateFail : null },
      puzzleId: puzzleId || this._racePuzzleFor(roundNo),
      stage: { "1": "ubongo", "2": "ubongo" },
      finishedAt: { "1": null, "2": null },
      first: null, status: "playing",
      pickEndsAt: null, secondEndsAt: null, secondPickEndsAt: null, revealEndsAt: null,
      picks: { "1": [], "2": [] }, invoiceIds: { "1": [], "2": [] }, discarded: [],
      randomPick: { "1": false, "2": false },
      t0: Date.now(), piecesAt: { "1": null, "2": null }, // 2026-10-21 기록용: 라운드 시작 / 조각을 다 모은 시각
    };
    if (this.rules.racePieceGames) {
      // 조각마다 반응형 미니게임: stage "pieces", got = 모은 조각 수, need = 조각 수. 게임 순서는 두 사람 같게.
      const r = this.state.race, need = this._piecesOf(r.puzzleId) || 2;
      const kinds = (this.rules.racePieceKinds || RACE_PIECE_GAME_KINDS || ["react"]).slice();
      r.game = null; r.need = need; r.got = { "1": 0, "2": 0 }; r.pieceGames = [];
      // 2026-10-16 (사용자 요청): 바코드 스캔(react)은 두 좌석이 같은 시각에 같은 불을 본다 -- 클라이언트가 이 씨앗과 시작 시각(서버 시계)으로 같은 시간표를 만든다.
      r.seed = Math.floor(Math.random() * 2147483647); r.startedAt = Date.now();
      let last = this.lastPieceGame || null;
      for (let k = 0; k < need; k++) { let opts = kinds.filter((x) => x !== last); if (!opts.length) opts = kinds; last = opts[Math.floor(Math.random() * opts.length)]; r.pieceGames.push(last); }
      this.lastPieceGame = last;
      r.stage = { "1": "pieces", "2": "pieces" };
      this._log({ t: "round", round: r.round, puzzle: r.puzzleId, need: r.need, parcels: r.pair.length, games: r.pieceGames.slice() });
    } else if (this.state.race.game) this.state.race.stage = { "1": "sticker", "2": "sticker" }; // 택배 쌓기 전에 첫 미니게임
    this._raceAt(null);
  }
  _planRest() {
    const r = this.state.race;
    const taken = r.picks["1"].concat(r.picks["2"]);
    return r.pair.map((_, i) => i).filter((i) => !taken.includes(i));
  }
  _planAdvance() {
    const r = this.state.race;
    const now = Date.now();
    const other = (s) => (s === "1" ? "2" : "1");
    if (r.status === "playing" && r.stage["1"] === "out" && r.stage["2"] === "out") this._raceReveal();
    if (r.status === "picking") {
      const f = r.first, s2 = other(f);
      const firstFull = () => r.picks[f].length >= r.plan.first || !this._planRest().length;
      if (!firstFull() && this.rules.raceAutoPick && now >= r.pickEndsAt) {
        while (!firstFull()) { const rest = this._planRest(); this._raceGrant(f, rest[Math.floor(Math.random() * rest.length)]); }
      }
      if (firstFull()) {
        if (!r.secondEndsAt) r.secondEndsAt = now + (this.rules.raceConsolationMs || 0);
        const lateN = r.plan.late != null ? r.plan.late : Infinity, failN = r.plan.lateFail != null ? r.plan.lateFail : Infinity;
        const randomFill = (n) => { while (r.picks[s2].length < n && this._planRest().length) { const rest = this._planRest(); this._raceGrant(s2, rest[Math.floor(Math.random() * rest.length)]); } };
        let lateDone = false;
        if (!this._planRest().length) lateDone = true;
        else if (r.stage[s2] === "done" && !r.randomPick[s2]) {
          // 늦게라도 직접 완성: lateN개를 고른다 (남은 게 그 수 이하면 고를 것 없이 전부)
          if (this._planRest().length <= lateN - r.picks[s2].length) { this._planRest().forEach((i) => this._raceGrant(s2, i)); lateDone = true; }
          else if (r.picks[s2].length >= lateN) lateDone = true;
          else {
            if (!r.latePickEndsAt) r.latePickEndsAt = this.rules.raceAutoPick ? now + this.rules.racePickMs : null;
            if (r.latePickEndsAt && now >= r.latePickEndsAt) { randomFill(lateN); lateDone = true; }
          }
        } else if (now >= r.secondEndsAt || r.stage[s2] === "out") {
          // 시간 안에 못 맞춤(포기 포함): 무작위 failN개
          r.randomPick[s2] = true; r.stage[s2] = "done";
          randomFill(failN === Infinity ? r.pair.length : failN); lateDone = true;
        }
        if (lateDone) this._raceReveal(); // 남은 택배는 사라짐 (r.discarded)
      }
    }
    if (r.status === "reveal" && now >= r.revealEndsAt) {
      this._raceNewRound(r.round + 1);
      if (!this.state.race) { this.emit(); return; }
    }
    const cur = this.state.race;
    let nextTs = null;
    if (cur.status === "picking") {
      const f = cur.first;
      if (cur.picks[f].length < cur.plan.first && this._planRest().length) nextTs = this.rules.raceAutoPick ? cur.pickEndsAt : null;
      else if (cur.latePickEndsAt) nextTs = cur.latePickEndsAt;
      else nextTs = cur.secondEndsAt;
    } else if (cur.status === "reveal") nextTs = cur.revealEndsAt;
    this._raceAt(nextTs);
    this.emit();
  }

  // 2026-10-14: 이번 라운드 우봉고 문제. racePiecesByRound[하프-1][라운드-1](끝나면 마지막 값)의 조각 수 문제 중에서,
  //   하프마다 새로 섞은 순서대로 겹치지 않게 꺼낸다(다 쓰면 다시 섞음). 설정이 없으면 예전 RACE_PUZZLE_ORDER 순서.
  _racePuzzleFor(roundNo) {
    const plan = this.rules.racePiecesByRound;
    const half = this.state.half || 1;
    const list = plan && plan[half - 1];
    if (!list || !list.length) return RACE_PUZZLE_ORDER[(roundNo - 1) % RACE_PUZZLE_ORDER.length];
    const want = list[Math.min(roundNo, list.length) - 1];
    if (roundNo === 1 || !this.racePuzzleBags || this.racePuzzleBags.half !== half) this.racePuzzleBags = { half };
    const bags = this.racePuzzleBags;
    if (!bags[want] || !bags[want].length) {
      const ids = [];
      TYPES.forEach((t) => {
        const p = Array.isArray(t.pieces) ? t.pieces[half - 1] : t.pieces;
        if (p === want) for (let n = 1; n <= t.count; n++) ids.push(t.key + "-" + n);
      });
      if (!ids.length) return RACE_PUZZLE_ORDER[(roundNo - 1) % RACE_PUZZLE_ORDER.length];
      bags[want] = shuffled(ids);
    }
    return bags[want].shift();
  }

  // 섞은 순서대로 꺼내고, 다 쓰면 다시 섞는다(새로 섞은 첫 게임이 직전 게임과 같으면 한 칸 미룬다)
  _raceNextGame() {
    const pool = this.rules.raceGamePool || [];
    if (!pool.length) return null; // 2026-10-15: 첫 게임 없음 -> 바로 택배 쌓기
    if (!this.raceGameBag || !this.raceGameBag.length) {
      this.raceGameBag = shuffled(pool);
      if (this.raceGameBag.length > 1 && this.raceGameBag[0] === this.raceLastGame) this.raceGameBag.push(this.raceGameBag.shift());
    }
    this.raceLastGame = this.raceGameBag.shift();
    return this.raceLastGame;
  }

  // 클라이언트가 보내는 진행 신호: "sticker-done"(송장 붙이기 끝 -> 우봉고로) / "ubongo-done"(우봉고 완료 = 투입) / "give-up"(이번 라운드 포기)
  raceStep(seat, step, round, meta) {
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
    } else if (step === "piece-done") {
      // 2026-10-16 조각 하나 획득 (반응형 미니게임 하나 끝냄). 다 모으면 택배 쌓기(완성 -> 투입)로
      if (st !== "pieces") return;
      r.got[seat] += 1;
      const m = meta && typeof meta === "object" ? meta : {};
      const num = (x) => (typeof x === "number" && isFinite(x) && x >= 0 && x < 600000 ? Math.round(x) : null);
      this._log({ t: "piece", round: r.round, seat, idx: r.got[seat] - 1, kind: (r.pieceGames && r.pieceGames[r.got[seat] - 1]) || null,
        ms: num(m.ms), fails: num(m.fails), timeouts: num(m.timeouts), sinceRound: now - (r.t0 || now) });
      if (r.got[seat] >= r.need) { r.stage[seat] = "ubongo"; r.piecesAt[seat] = now; }
    } else if (step === "ubongo-done") {
      if (st !== "ubongo") return;
      const consol = this.rules.raceConsolationMs > 0;
      if (!consol && r.first && r.first !== seat && now > r.secondEndsAt) { r.stage[seat] = "out"; this._raceAdvance(); return; }
      r.stage[seat] = "done";
      r.finishedAt[seat] = now;
      {
        const o = seat === "1" ? "2" : "1";
        this._log({ t: "finish", round: r.round, seat, first: !r.first, sinceRound: now - (r.t0 || now),
          assembleMs: r.piecesAt && r.piecesAt[seat] ? now - r.piecesAt[seat] : null,
          gapMs: r.first && r.finishedAt[o] ? now - r.finishedAt[o] : null, oppStage: r.stage[o], oppGot: r.got ? r.got[o] : null });
      }
      if (r.plan) {
        if (!r.first) { r.first = seat; r.status = "picking"; r.pickEndsAt = this.rules.raceAutoPick ? now + this.rules.racePickMs : null; }
      } else if (!r.first) {
        r.first = seat;
        r.status = "picking";
        r.pickEndsAt = this.rules.raceAutoPick ? now + this.rules.racePickMs : null;
        // 위로(consolation) 모드: 늦은 사람의 마감은 1등이 고른 순간부터 잰다(_raceAdvance에서 설정)
        r.secondEndsAt = consol ? null : now + this.rules.raceSecondMs;
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
    if (r && r.plan) {
      if (r.status !== "picking" || typeof idx !== "number" || !r.pair[idx] || !this._planRest().includes(idx)) return;
      if (r.first === seat) { if (r.picks[seat].length >= r.plan.first) return; }
      else {
        // 늦은 사람: 1등이 다 고른 뒤, 시간 안에 직접 완성했을 때만 late개까지
        const lateN = r.plan.late != null ? r.plan.late : Infinity;
        if (!r.first || r.picks[r.first].length < r.plan.first || r.stage[seat] !== "done" || (r.randomPick && r.randomPick[seat]) || r.picks[seat].length >= lateN) return;
      }
      this.touch();
      this._raceGrant(seat, idx);
      this._raceAdvance();
      return;
    }
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
    if (r.plan) {
      if (item.cellId) { const c = cellById(this.state, item.cellId); if (c) { c.taken = true; c.takenBy = seat; } }
      this.state.acquireCounter[seat] += 1;
      const seq = this.state.acquireCounter[seat];
      const inv = {
        id: "inv-" + seat + "-" + seq, catIdx: item.catIdx, floorIdx: item.floorIdx, unit: item.unit || null,
        room: item.unit ? null : drawRoom(this.state.players[seat]), acquiredSeq: seq,
        reward: item.reward, deliveredRound: null, stolen: false, deliveredWasPriority: false, returned: false,
        src: r.first === seat ? "first" : (r.randomPick && r.randomPick[seat] ? "random" : "late"), // 2026-10-21 기록용: 어떻게 얻은 택배인지
      };
      this.state.players[seat].invoices.push(inv);
      r.picks[seat].push(idx);
      r.invoiceIds[seat].push(inv.id);
      return;
    }
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
    if (r.plan) { this._planAdvance(); return; }
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
        const consol = this.rules.raceConsolationMs > 0;
        if (consol) {
          // 1등이 고른 순간부터 raceConsolationMs: 그 안에 투입하면 직접 고르고, 지나면(포기했어도) 남은 것 중 무작위로 하나
          if (!r.secondEndsAt) r.secondEndsAt = now + this.rules.raceConsolationMs;
          if (r.stage[s2] !== "done" && r.picks[s2] === null && rest.length && now >= r.secondEndsAt) {
            this._raceGrant(s2, rest[Math.floor(Math.random() * rest.length)]);
            r.randomPick[s2] = true;
            r.stage[s2] = "done";
          }
        } else if (r.stage[s2] !== "done" && r.stage[s2] !== "out" && now >= r.secondEndsAt) r.stage[s2] = "out"; // 늦은 사람이 마감 안에 투입하지 못했으면 탈락
        const restNow = r.pair.map((_, i) => i).filter((i) => r.picks["1"] !== i && r.picks["2"] !== i);
        if (r.stage[s2] === "done" && r.picks[s2] === null && restNow.length) {
          // 늦은 사람의 고르기 창: 먼저 끝낸 사람이 고른 뒤(또는 늦은 사람이 그 뒤에 투입한 뒤)부터 RACE_PICK_MS
          if (!r.secondPickEndsAt && this.rules.raceAutoPick) r.secondPickEndsAt = now + this.rules.racePickMs;
          if (restNow.length === 1) this._raceGrant(s2, restNow[0]); // 하나 남았으면 고를 것 없이 그것
          else if (this.rules.raceAutoPick && now >= r.secondPickEndsAt) this._raceAutoPick(s2);
        }
        const secondSettled = r.picks[s2] !== null || !r.pair.some((_, i) => r.picks["1"] !== i && r.picks["2"] !== i)
          || (r.stage[s2] === "out" && !consol);
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
      if (this.rules.raceConsolationMs > 0) { if (cur.secondEndsAt && cur.picks[s2] === null && cur.stage[s2] !== "done") cand.push(cur.secondEndsAt); }
      else if (cur.stage[s2] !== "done" && cur.stage[s2] !== "out") cand.push(cur.secondEndsAt);
      if (this.rules.raceAutoPick && cur.secondPickEndsAt && cur.picks[s2] === null) cand.push(cur.secondPickEndsAt);
      if (cand.length) nextTs = Math.min.apply(null, cand);
    } else if (cur.status === "reveal") nextTs = cur.revealEndsAt;
    this._raceAt(nextTs);
    this.emit();
  }

  _raceReveal() {
    const r = this.state.race;
    r.status = "reveal";
    if (r.plan) {
      const desc = (i) => { const it = r.pair[i]; const u = UNITS.find((x) => x.id === it.unit); return { unit: it.unit, b: u ? u.b : null, cat: it.catIdx }; };
      this._log({ t: "picks", round: r.round, first: r.first, random: Object.assign({}, r.randomPick),
        offered: r.pair.map((_, i) => desc(i)), picks: { "1": r.picks["1"].map(desc), "2": r.picks["2"].map(desc) } });
    }
    r.discarded = r.plan ? this._planRest() : r.pair.map((_, i) => i).filter((i) => r.picks["1"] !== i && r.picks["2"] !== i);
    // 아무도 안 가져간 택배: 레일로 돌아가 다음 라운드에 다시 나올 수 있다(기본). raceLeftoverReturn이 false면 사라진다(주인 없이 보드에서 빠짐).
    if (!this.rules.raceLeftoverReturn && !r.plan) {
      r.discarded.forEach((i) => { const c = cellById(this.state, r.pair[i].cellId); if (c && !c.taken) { c.taken = true; c.takenBy = null; } });
    }
    r.revealEndsAt = Date.now() + this.rules.raceRevealMs;
    // 보드가 다 비면 결과를 잠깐 보여 준 뒤 엘리베이터로 (예전 조기 종료와 같은 방식, 결과 표시 시간만큼 기다림)
    if (!(r.plan && this.rules.raceUnlimited) && this.state.board.every((c) => c.taken)) {
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
    if (this.rules.wallMode) { this._startDelivery(); return; }
    this.state.phase = "elevator";
    this.state.elevator = freshElevator(this.rules);
    this.emit();
  }

  // ---- 2026-10-16 벽 배송 단계 (rules.wallMode) ----
  // state.delivery = { endsAt, doors: {unitId: {seat, invId, start, taps}}, ev: [{n,k,unit,seat,taps}], evN }
  //   k: start(켜짐) / done(배송 완료) / tap(끄기 1회) / returned(반송) / wrong(오배송) / busy(이미 다른 집 배송 중) / own(내가 켠 걸 또 누름)
  _startDelivery() {
    this.state.phase = "delivery";
    this.state.delivery = { endsAt: Date.now() + this.rules.deliveryMs, doors: {}, ev: [], evN: 0,
      elev: this.rules.deliveryElevator ? { floor: this.rules.deliveryElevStart || 1, top: 7, movingUntil: 0, presses: { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } } } : null };
    if (this.rules.aptWar) {
      // 엘리베이터 이동 전쟁: cnt = 이번 층에서 각자 ↑/↓ 누른 수 (먼저 taps 채우면 그 방향으로 한 층, 둘 다 0으로)
      const now0 = Date.now();
      this.state.delivery.elev = { war: true, floor: this.rules.deliveryElevStart || 1, top: 7, movingUntil: 0, stage: "move", stageEndsAt: 0, open: false, openedAt: 0, openUntil: 0, openN: 0, round: 0, moves: null };
      this.state.delivery.mash = { "1": {}, "2": {} }; // 문 열린 동안 호실별 연타 수
      this.state.delivery.wrongSeen = {};
      this._warStartMove(now0);
    }
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.deliveryTimer = setInterval(() => this._deliveryTick(), 100);
    this.emit();
  }
  _dEv(k, unit, seat, extra) {
    const d = this.state.delivery;
    d.evN += 1;
    // 연속 배송(점수 없음, 연출용): 실패하면 끊긴다
    if (seat && (k === "wrong" || k === "elevleft" || k === "missed" || k === "returned") && this.state.players[seat]) this.state.players[seat].streak = 0;
    d.ev.push(Object.assign({ n: d.evN, k, unit, seat: seat || null }, extra || {}));
    if (d.ev.length > 30) d.ev.shift();
  }
  // seat: "1"/"2"(Ctrl/Shift 또는 플레이어 화면) 또는 null(Ctrl/Shift 없이 누름 -- 누군지 모름)
  wallPress(seat, unitId) {
    if (this.state.phase !== "delivery" || !this.state.delivery) return;
    if (!UNITS.some((u) => u.id === unitId)) return;
    if (seat !== "1" && seat !== "2") seat = null;
    const d = this.state.delivery;
    const door = d.doors[unitId];
    this.touch();
    if (d.elev && d.elev.war) { this._warPress(seat, unitId); return; }
    if (this.rules.deliveryHoldMs > 0) { this._holdDown(seat, unitId); return; }
    if (door) {
      // 2026-10-16 (사용자 결정): 막기는 Ctrl/Shift 없이 그 호실 버튼 연타만. 팀 키를 누른 채 남의 켜진 버튼을 누르면 안내만.
      if (seat && door.seat === seat) {
        if (door.mode === "climb") this._climbStep(unitId);
        else if (door.mode === "bell") this._bellAnswer(unitId);
        else this._dEv("own", unitId, seat);
        this.emit();
        return;
      }
      if (seat && !this.rules.deliveryPairButtons) { this._dEv("taken", unitId, seat); this.emit(); return; }
      this._wallTap(unitId);
      this.emit();
      return;
    }
    if (!seat) return; // 꺼진 버튼을 Ctrl/Shift 없이 누름 -- 아무 일 없음
    const inv = this.state.players[seat].invoices.find((v) => v.unit === unitId && v.deliveredRound === null && !v.returned && !v.lost);
    if (!inv) {
      this.state.players[seat].wrong = (this.state.players[seat].wrong || 0) + 1;
      this._dEv("wrong", unitId, seat);
      this.emit();
      return;
    }
    const u0 = this._unitOf(unitId);
    if (d.elev && u0.b === "apt" && d.elev.movingUntil > Date.now()) { this._dEv("elevmoving", unitId, seat, { floor: d.elev.floor }); this.emit(); return; }
    if (d.elev && u0.b === "apt" && d.elev.floor !== u0.floor) { this._dEv("noelev", unitId, seat, { floor: d.elev.floor }); this.emit(); return; }
    const active = Object.values(d.doors).filter((x) => x.seat === seat).length;
    if (active >= Math.max(1, this.rules.deliveryMaxActive || 1)) { this._dEv("busy", unitId, seat); this.emit(); return; }
    const mode = this._modeOf(u0);
    const door0 = { seat, invId: inv.id, start: Date.now(), taps: 0, mode };
    if (mode === "climb") { door0.need = this._climbNeed(u0); door0.steps = 0; }
    if (mode === "bell") this._bellRing(door0);
    d.doors[unitId] = door0;
    this._dEv("start", unitId, seat, { mode });
    if (mode === "climb") this._climbStep(unitId); // 첫 누름이 첫 계단
    this.emit();
  }
  // ---- 건물별 배송 방식 (rules.deliveryModes) ----
  _modeOf(u) { const m = this.rules.deliveryModes && this.rules.deliveryModes[u.b]; return m === "climb" || m === "bell" ? m : "wait"; }
  _climbNeed(u) { const c = this.rules.deliveryClimbSteps || {}; return Math.max(1, c[u.floor] || c[1] || 5); }
  _climbStep(unitId) {
    const door = this.state.delivery.doors[unitId];
    door.steps += 1;
    if (door.steps >= door.need) { this._completeDoor(unitId); return; }
    this._dEv("step", unitId, door.seat, { steps: door.steps, need: door.need });
  }
  _bellRing(door) {
    const w = this.rules.deliveryBellWaitMs || [1500, 3500];
    const now = Date.now();
    door.openAt = now + w[0] + Math.floor(Math.random() * Math.max(1, w[1] - w[0]));
    door.closeAt = door.openAt + (this.rules.deliveryBellWindowMs || 1800);
  }
  _bellAnswer(unitId) {
    const door = this.state.delivery.doors[unitId];
    const now = Date.now();
    if (now >= door.openAt && now < door.closeAt) { this._completeDoor(unitId); return; }
    this._bellRing(door); // 문 열리기 전에 또 누름 -- 초인종 다시, 기다림 처음부터
    this._dEv("early", unitId, door.seat);
  }
  // ---- 유지 방식 (rules.deliveryHoldMs > 0) ----
  // 누르는 순간: 내 택배 + (아파트면) 엘리베이터가 그 층 -> doors[unit] = {seat, invId, start, hold:true}. 아니면 즉시 오류 이벤트(진행과 구분).
  //   오류 종류: wrong(내 택배가 없는 호실, 오배송 감점) / noelev(아파트인데 엘리베이터가 다른 층 -- 감점 없음) / busy(이미 다른 집을 누르고 있음)
  // 떼는 순간(wallRelease) 시간이 안 찼으면 released(처음부터). 누르고 있는 동안 엘리베이터가 떠나면 elevleft.
  _unitOf(id) { return UNITS.find((u) => u.id === id); }
  _holdDown(seat, unitId) {
    const d = this.state.delivery;
    if (!seat) return; // 유지 방식에서는 보조키 없는 입력은 쓰지 않는다
    if (d.doors[unitId]) { if (d.doors[unitId].seat !== seat) this._dEv("taken", unitId, seat); this.emit(); return; }
    const inv = this.state.players[seat].invoices.find((v) => v.unit === unitId && v.deliveredRound === null && !v.returned && !v.lost);
    if (!inv) {
      this.state.players[seat].wrong = (this.state.players[seat].wrong || 0) + 1;
      this._dEv("wrong", unitId, seat); this.emit(); return;
    }
    const u = this._unitOf(unitId);
    if (d.elev && u.b === "apt" && d.elev.movingUntil > Date.now()) { this._dEv("elevmoving", unitId, seat, { floor: d.elev.floor }); this.emit(); return; }
    if (d.elev && u.b === "apt" && d.elev.floor !== u.floor) { this._dEv("noelev", unitId, seat, { floor: d.elev.floor }); this.emit(); return; }
    const active = Object.values(d.doors).filter((x) => x.seat === seat).length;
    if (active >= Math.max(1, this.rules.deliveryMaxActive || 1)) { this._dEv("busy", unitId, seat); this.emit(); return; }
    d.doors[unitId] = { seat, invId: inv.id, start: Date.now(), taps: 0, hold: true };
    this._dEv("start", unitId, seat);
    this.emit();
  }
  wallRelease(seat, unitId) {
    if (this.state.phase !== "delivery" || !this.state.delivery || !(this.rules.deliveryHoldMs > 0)) return;
    const d = this.state.delivery;
    const door = d.doors[unitId];
    if (!door || door.seat !== seat) return;
    if (Date.now() - door.start >= this.rules.deliveryHoldMs) { this._deliveryTick(); return; } // 이미 찼다 -- 완료 처리
    delete d.doors[unitId];
    this._dEv("released", unitId, seat);
    this.emit();
  }
  // 엘리베이터: 누를 때마다 한 층 (예전 vote와 같음). 두 팀이 반대로 누르면 차이만큼 움직인다.
  wallElevator(seat, dir) {
    if (this.state.phase !== "delivery" || !this.state.delivery || !this.state.delivery.elev) return;
    if (dir !== "up" && dir !== "down") return;
    const e = this.state.delivery.elev;
    this.touch();
    if (e.war) { this._warElev(seat, dir); return; }
    // 2026-10-21 (사용자): 엘리베이터 ↑↓는 팀 키 없이도 누구나. 팀 키를 같이 누르면 그 팀 칸에, 아니면 "0" 칸에 센다.
    const who = seat === "1" || seat === "2" ? seat : "0";
    if (!e.presses[who]) e.presses[who] = { up: 0, down: 0 };
    e.presses[who][dir] += 1;
    const before = e.floor;
    e.floor = Math.max(1, Math.min(e.top, e.floor + (dir === "up" ? 1 : -1)));
    if (e.floor !== before) e.movingUntil = Date.now() + (this.rules.deliveryElevMoveMs || 0); // 움직이는 동안 아파트 배송 시작 불가
    // 아파트를 누르고 있던 배송은 엘리베이터가 떠나면 실패
    const d = this.state.delivery;
    Object.keys(d.doors).forEach((id) => {
      const u = this._unitOf(id);
      if (u.b === "apt" && u.floor !== e.floor) { const s2 = d.doors[id].seat; delete d.doors[id]; this._dEv("elevleft", id, s2, { floor: e.floor }); }
    });
    this.emit();
  }

  // 2026-10-22 엘리베이터 전쟁: 호실 버튼은 "지금 엘리베이터가 선 층의 slot번째 집" (1인당 버튼 8개)
  wallSlot(seat, slot) {
    if (this.state.phase !== "delivery" || !this.state.delivery || !this.state.delivery.elev || !this.state.delivery.elev.war) return;
    if (!(slot >= 1 && slot <= 9)) return;
    const id = "a" + this.state.delivery.elev.floor + "0" + slot;
    if (!UNITS.some((u) => u.id === id)) return;
    this.wallPress(seat, id);
  }
  // ---- 2026-10-22 엘리베이터 이동 전쟁 (rules.aptWar) ----
  // (사용자 결정 2차) 5초 이동 -> 5초 배송을 번갈아. 입력은 각자 플레이어 화면.
  //   이동(stage "move", elevMoveMs): ↑ 한 번 = 한 층 위, ↓ 한 번 = 한 층 아래 (예전 엘리베이터 라운드처럼 바로 움직이는 줄다리기). 5초 뒤 멈춘 층이 도착 층.
  //   배송(stage "deliver", elevOpenMs): 그 층에 택배가 있으면 문이 열리고 5초 동안 그 층 내 집을 elevDeliverTaps번씩 눌러 최대한 많이 배송.
  //   그 층에 아무 택배도 없으면 배송 없이 바로 다음 이동. 그 층 택배가 다 나가면 조금 일찍 닫힘.
  _warStartMove(now) {
    const d = this.state.delivery, e = d.elev;
    e.stage = "move"; e.open = false; e.stageEndsAt = now + (this.rules.elevMoveMs || 5000);
    e.moves = { "1": { up: 0, down: 0 }, "2": { up: 0, down: 0 } }; e.round = (e.round || 0) + 1;
    d.mash = { "1": {}, "2": {} };
  }
  _warElev(seat, dir) {
    if (seat !== "1" && seat !== "2") return;
    const d = this.state.delivery, e = d.elev, now = Date.now();
    if (e.stage !== "move") return; // 배송 5초 동안은 엘리베이터 잠김
    e.moves[seat][dir] += 1;
    const nf = Math.max(1, Math.min(e.top, e.floor + (dir === "up" ? 1 : -1)));
    if (nf !== e.floor) { e.floor = nf; e.movingUntil = now + (this.rules.elevWarMoveMs || 0); this._dEv("move", null, seat, { floor: nf, dir }); }
    this.emit();
  }
  // 이 층에 아직 배송할 택배가 있는가 (둘 중 누구든)
  _warFloorBusy(floor) {
    return ["1", "2"].some((s) => this.state.players[s].invoices.some((v) => v.deliveredRound === null && !v.returned && !v.lost && v.unit && (this._unitOf(v.unit) || {}).floor === floor));
  }
  _warOpen(now) {
    const d = this.state.delivery, e = d.elev;
    e.stage = "deliver"; e.open = true; e.openedAt = now; e.openUntil = now + (this.rules.elevOpenMs || 5000); e.stageEndsAt = e.openUntil; e.openN += 1;
    d.mash = { "1": {}, "2": {} };
    this._dEv("open", null, null, { floor: e.floor });
  }
  _warClose(now) {
    const d = this.state.delivery, e = d.elev;
    ["1", "2"].forEach((s) => { const part = Object.keys(d.mash[s] || {}).filter((u) => d.mash[s][u] > 0); if (part.length) this._dEv("shut", part[0], s, { taps: d.mash[s][part[0]] }); });
    this._dEv("close", null, null, { floor: e.floor });
    this._warStartMove(now);
  }
  _warPress(seat, unitId) {
    if (seat !== "1" && seat !== "2") return;
    const d = this.state.delivery, e = d.elev, u = this._unitOf(unitId);
    if (!e.open || u.floor !== e.floor) { this._dEv(e.open ? "noelev" : "closed", unitId, seat, { floor: e.floor }); this.emit(); return; }
    const pl = this.state.players[seat];
    const inv = pl.invoices.find((v) => v.unit === unitId && v.deliveredRound === null && !v.returned && !v.lost);
    if (!inv) {
      const k = seat + ":" + unitId + ":" + e.openN; // 같은 문 열림에 같은 집 오배송은 한 번만 감점 (연타하다 실수해도 한 번)
      if (!d.wrongSeen[k]) { d.wrongSeen[k] = 1; pl.wrong = (pl.wrong || 0) + 1; this._dEv("wrong", unitId, seat); }
      this.emit(); return;
    }
    const m = d.mash[seat];
    m[unitId] = (m[unitId] || 0) + 1;
    const need = this.rules.elevDeliverTaps || 3;
    if (m[unitId] < need) { this._dEv("step", unitId, seat, { steps: m[unitId], need }); this.emit(); return; }
    delete m[unitId];
    d.doors[unitId] = { seat, invId: inv.id, start: e.openedAt, taps: 0, mode: "mash" };
    this._completeDoor(unitId);
    const o = seat === "1" ? "2" : "1";
    if (d.mash[o]) delete d.mash[o][unitId]; // 같은 집을 두드리던 상대는 끝
    if (!this._warFloorBusy(e.floor)) { e.openUntil = Math.min(e.openUntil, Date.now() + 600); e.stageEndsAt = e.openUntil; } // 이 층 택배를 다 보냈으면 조금 일찍 닫고 다음 이동
    this.emit();
  }

  _wallTap(unitId) {
    const d = this.state.delivery;
    const door = d.doors[unitId];
    door.taps += 1;
    if (door.taps < this.rules.deliveryReturnTaps) { this._dEv("tap", unitId, door.seat, { taps: door.taps }); return; }
    // 2026-10-16 (사용자 결정): 반송돼도 다시 보낼 수 있다 -- 택배는 미배송 상태로 돌아가고(반송 횟수만 셈), 처음부터 다시 배송.
    const inv = this.state.players[door.seat].invoices.find((v) => v.id === door.invId);
    if (inv) inv.bounces = (inv.bounces || 0) + 1;
    delete d.doors[unitId];
    const blocker = door.seat === "1" ? "2" : "1"; // 그냥 누른 입력은 누군지 모르지만, 막는 쪽은 상대 팀
    const br = (this.state.wallRule && this.state.wallRule.blockReward) || 0;
    if (br > 0) this.state.players[blocker].blocks = (this.state.players[blocker].blocks || 0) + 1;
    this._dEv("returned", unitId, door.seat, { blocker, gain: br });
    this._log({ t: "blocked", seat: door.seat, unit: unitId, b: (this._unitOf(unitId) || {}).b, mode: door.mode || "wait", ms: Date.now() - door.start });
  }
  _completeDoor(unitId) {
    const d = this.state.delivery;
    const door = d.doors[unitId];
    if (!door) return;
    const invs0 = this.state.players[door.seat].invoices;
    const inv = invs0.find((v) => v.id === door.invId);
    const kindsBefore = deliveredKinds(invs0), bldBefore = deliveredBuildings(invs0);
    // 피버: 마지막 feverMs 동안은 이 택배 금액 x feverMult (송장 금액 자체를 올려 점수 계산은 그대로)
    const fever = !!(this.rules.feverMs > 0 && d.endsAt && Date.now() >= d.endsAt - this.rules.feverMs);
    if (inv && fever) { inv.reward = Math.round((typeof inv.reward === "number" ? inv.reward : TYPES[inv.catIdx].reward) * (this.rules.feverMult || 1)); inv.fever = true; }
    if (inv) inv.deliveredRound = 1;
    const pl = this.state.players[door.seat]; pl.streak = (pl.streak || 0) + 1;
    delete d.doors[unitId];
    // 같은 집 쟁탈: 상대가 같은 집 택배를 들고 있으면 그건 선점당함
    const other = door.seat === "1" ? "2" : "1";
    const lostInv = this.state.players[other].invoices.find((v) => v.unit === unitId && v.deliveredRound === null && !v.returned && !v.lost);
    if (lostInv) lostInv.lost = true;
    const combos = [];
    const sr = this.state.setRule, wr = this.state.wallRule;
    if (sr && sr.amount > 0 && kindsBefore < sr.kinds && deliveredKinds(invs0) >= sr.kinds) combos.push({ k: "kinds", amount: sr.amount });
    if (wr && wr.bldBonus > 0 && bldBefore < 3 && deliveredBuildings(invs0) >= 3) combos.push({ k: "bld", amount: wr.bldBonus });
    this._log({ t: "deliver", seat: door.seat, unit: unitId, b: (this._unitOf(unitId) || {}).b, mode: door.mode || "wait", ms: Date.now() - door.start, fever, src: inv ? inv.src || null : null, snatched: !!lostInv });
    this._dEv("done", unitId, door.seat, { combos, reward: inv ? (typeof inv.reward === "number" ? inv.reward : TYPES[inv.catIdx].reward) : 0, count: invs0.filter((v) => v.deliveredRound !== null && !v.stolen && !v.returned).length, snatched: lostInv ? (typeof lostInv.reward === "number" ? lostInv.reward : TYPES[lostInv.catIdx].reward) : 0, fever, streak: pl.streak });
  }
  _deliveryTick() {
    if (this.state.phase !== "delivery" || !this.state.delivery) { clearInterval(this.deliveryTimer); this.deliveryTimer = null; return; }
    const d = this.state.delivery;
    const now = Date.now();
    let changed = false;
    const ew = d.elev && d.elev.war ? d.elev : null;
    if (ew) {
      if (ew.stage === "move" && now >= ew.stageEndsAt) {
        if (this._warFloorBusy(ew.floor)) this._warOpen(now);
        else { this._dEv("empty", null, null, { floor: ew.floor }); this._warStartMove(now); } // 택배 없는 층 -- 바로 다음 이동
        changed = true;
      } else if (ew.stage === "deliver" && now >= ew.openUntil) { this._warClose(now); changed = true; }
    }
    Object.keys(d.doors).forEach((unitId) => {
      const door = d.doors[unitId];
      if (door.mode === "climb") return; // 계단은 시간으로 끝나지 않는다
      if (door.mode === "bell") {
        if (now < door.closeAt) return;
        delete d.doors[unitId]; // 문이 닫힘 -- 택배는 그대로, 다시 초인종부터
        this._dEv("missed", unitId, door.seat);
        changed = true;
        return;
      }
      if (now - door.start < (door.hold ? this.rules.deliveryHoldMs : this.rules.deliveryProgressMs)) return;
      this._completeDoor(unitId);
      changed = true;
    });
    if (now >= d.endsAt) { this._endDelivery(); return; }
    if (changed) this.emit();
  }
  _endDelivery() {
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.deliveryTimer = null;
    const d = this.state.delivery;
    d.doors = {};
    if (d.mash) d.mash = { "1": {}, "2": {} };
    if (d.elev && d.elev.war) d.elev.open = false;
    d.endsAt = null;
    this._finishHalf();
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
    {
      const per = {};
      ["1", "2"].forEach((s) => {
        const invs = this.state.players[s].invoices;
        const by = (src) => { const a = invs.filter((v) => (v.src || "late") === src); return { n: a.length, done: a.filter((v) => v.deliveredRound !== null && !v.lost && !v.returned).length }; };
        per[s] = { score: scores[s], got: invs.length, first: by("first"), late: by("late"), random: by("random"), lost: invs.filter((v) => v.lost).length, wrong: this.state.players[s].wrong || 0, blocks: this.state.players[s].blocks || 0 };
      });
      this._log({ t: "half", per });
    }
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
    this.state.delivery = null;
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
    this.state.delivery = null;
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

module.exports = { GameRoom, initialState, scoreInvoice, resultLabel, totalScore, rewardFor, setBonusFor, deliveredKinds, deliveredBuildings, buildingBonusFor, DEFAULT_RULES, LEGACY_RULES };
