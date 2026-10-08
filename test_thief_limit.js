// 2026-10-07: 엘리베이터 7라운드 + 택배도둑 후반 2회 -- GameRoom 직접 구동(브라우저/WS 불필요)
//   - 후반 라운드 1~6에만 thief 창이 열리고, 마지막(7) 라운드엔 안 열린다
//   - 1인당 후반 통틀어 2번까지 배치 가능(라운드당 1개), 3번째부터는 자동으로 넘김 처리, 둘 다 다 쓰면 창 자체가 안 열림
//   - 스킵은 횟수를 소진하지 않는다
//   - 6라운드에 놓은 도둑은 7라운드에 작동한다
"use strict";
const assert = require("assert");
const { GameRoom } = require("./game-room.js");
const { ELEVATOR_ROUNDS, THIEF_PER_HALF } = require("./game-data.js");
function log(...a) { console.log("[test-thief-limit]", ...a); }
assert.strictEqual(ELEVATOR_ROUNDS, 7, "전/후반 각각 7라운드");
assert.strictEqual(THIEF_PER_HALF, 2, "후반 도둑 1인당 2회");

function newRoomInHalf2() {
  const room = new GameRoom("TEST", () => {});
  room.pickCourier("cookbang", "clientA");
  room.pickCourier("cheonil", "clientB");
  room.setReady("1"); room.setReady("2");
  room._endSecurePhase();
  const el = room.state.elevator;
  const readyBoth = () => { room.setElevatorReady("1"); room.setElevatorReady("2"); };
  for (let r = 1; r <= ELEVATOR_ROUNDS; r++) {
    readyBoth();
    assert.notStrictEqual(el.state, "thief", "전반엔 thief 창 없음");
    assert.strictEqual(el.state, "voting");
    room._resolveRound();
  }
  assert.strictEqual(el.round, 7, "전반은 7라운드까지");
  readyBoth();
  assert.strictEqual(room.state.phase, "halftime");
  room.halftimeReady("1"); room.halftimeReady("2");
  assert.strictEqual(room.state.phase, "secure");
  assert.strictEqual(room.state.half, 2);
  room._endSecurePhase();
  assert.strictEqual(room.state.phase, "elevator");
  return room;
}
const gate = (room) => { room.setElevatorReady("1"); room.setElevatorReady("2"); };
const finishRound = (room) => { room._resolveRound(); assert.strictEqual(room.state.elevator.state, "result"); };

// ---------- 시나리오 A: 둘 다 최대한 놓는다 ----------
{
  const room = newRoomInHalf2();
  const el = room.state.elevator;
  assert.strictEqual(el.thieves.perHalf, 2);
  // 후반 R1: 둘 다 배치 -> 둘 다 끝났으니 즉시 voting
  gate(room);
  assert.strictEqual(el.state, "thief"); assert.strictEqual(el.round, 1);
  room.placeThief("1", 0);
  assert.strictEqual(el.state, "thief", "한 명만 끝내면 안 닫힘");
  room.placeThief("2", 2);
  assert.strictEqual(el.state, "voting");
  assert.deepStrictEqual(el.thieves.usedThisHalf, { "1": 1, "2": 1 });
  finishRound(room);
  // R2: 지난 라운드 도둑이 활성화, 둘 다 한 번 더 놓을 수 있다
  gate(room);
  assert.strictEqual(el.state, "thief"); assert.strictEqual(el.round, 2);
  assert.strictEqual(el.thieves.active.length, 2, "R1에 놓은 도둑 2개가 R2에 활성");
  assert.ok(!el.thieves.skipped["1"] && !el.thieves.skipped["2"], "아직 1회 남아서 자동 넘김 아님");
  room.placeThief("1", 3);
  room.placeThief("1", 4); // 같은 라운드 두 번째 배치는 무시
  assert.strictEqual(el.thieves.placedThisRound["1"], 3, "라운드당 1개");
  assert.strictEqual(el.thieves.usedThisHalf["1"], 2);
  room.placeThief("2", 1);
  assert.strictEqual(el.state, "voting");
  assert.deepStrictEqual(el.thieves.usedThisHalf, { "1": 2, "2": 2 });
  finishRound(room);
  // R3: 둘 다 2회를 다 썼으니 창 자체가 안 열린다(바로 voting). R2 도둑은 R3에 활성
  gate(room);
  assert.strictEqual(el.state, "voting", "둘 다 한도 소진 -> thief 창 없음");
  assert.strictEqual(el.thieves.active.length, 2);
  room.placeThief("1", 0); // 창이 아니니 무시
  assert.deepStrictEqual(el.thieves.usedThisHalf, { "1": 2, "2": 2 }, "3번째 배치는 불가");
  finishRound(room);
  for (let r = 4; r <= 7; r++) { gate(room); assert.strictEqual(el.state, "voting"); finishRound(room); }
  assert.strictEqual(el.round, 7);
  log("A: R1,R2에 1인 2회 배치, R3부터는 창이 안 열리고 3번째 배치는 거부");
}

// ---------- 시나리오 B: 한 명은 스킵만(횟수 소진 안 함), 1명만 한도 소진 ----------
{
  const room = newRoomInHalf2();
  const el = room.state.elevator;
  gate(room); room.placeThief("1", 0); room.placeThief("2", null); finishRound(room);       // R1: p1 1회, p2 스킵
  assert.strictEqual(el.thieves.usedThisHalf["2"], 0, "스킵은 횟수를 소진하지 않는다");
  gate(room); room.placeThief("1", 0); room.placeThief("2", null); finishRound(room);       // R2: p1 2회(소진), p2 스킵
  gate(room);                                                                                // R3: p1은 자동 넘김, p2만 결정
  assert.strictEqual(el.state, "thief", "p2가 아직 남아 있어 창은 열린다");
  assert.ok(el.thieves.skipped["1"], "p1은 한도 소진으로 자동 넘김");
  room.placeThief("2", 5);
  assert.strictEqual(el.state, "voting", "p1은 자동 넘김이라 p2만 끝내면 즉시 진행");
  assert.strictEqual(el.thieves.usedThisHalf["2"], 1);
  finishRound(room);
  gate(room); room.placeThief("2", null); finishRound(room);                                // R4
  gate(room); room.placeThief("2", 3); finishRound(room);                                   // R5: p2 2회 소진
  assert.strictEqual(el.thieves.usedThisHalf["2"], 2);
  log("B: 스킵은 횟수 비소진, 한 명만 한도 소진 시 그 사람은 자동 넘김");
}

// ---------- 시나리오 C: 마지막(7) 라운드엔 창이 안 열리고, 6라운드에 놓은 도둑은 7라운드에 작동 ----------
{
  const room = newRoomInHalf2();
  const el = room.state.elevator;
  for (let r = 1; r <= 5; r++) { gate(room); assert.strictEqual(el.state, "thief"); room.placeThief("1", null); room.placeThief("2", null); finishRound(room); }
  gate(room); assert.strictEqual(el.round, 6); assert.strictEqual(el.state, "thief", "R6엔 창이 열린다");
  room.placeThief("1", 4); room.placeThief("2", null);
  assert.strictEqual(el.state, "voting"); finishRound(room);
  gate(room);
  assert.strictEqual(el.round, 7);
  assert.strictEqual(el.state, "voting", "R7엔 thief 창이 열리지 않는다(한도가 남아 있어도)");
  assert.strictEqual(el.thieves.active.length, 1, "R6에 놓은 도둑이 R7에 작동");
  assert.strictEqual(el.thieves.active[0].floorIdx, 4);
  assert.strictEqual(el.thieves.usedThisHalf["1"], 1, "남은 한도는 그대로(함정에 소진되지 않음)");
  log("C: R7엔 창이 없고 R6에 놓은 도둑은 R7에 작동");
}
console.log("[test-thief-limit] ALL CHECKS PASSED");
