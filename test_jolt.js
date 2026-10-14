// 2026-10-14 엘리베이터 "덜컹" (ELEVATOR_JOLT) -- GameRoom 직접 구동.
//   두 사람 모두 눌렀는데 시작 층 그대로 -> 결과 직전에 한 층 위/아래(무작위, 끝층에선 가능한 쪽), log.jolt 기록, 배송은 덜컹한 층에서
//   한 사람만 눌렀거나 아무도 안 눌렀으면 덜컹 없음 / 시작 층에서 벗어났으면 덜컹 없음 / elevatorJolt:false면 없음
"use strict";
const assert = require("assert");
const { GameRoom, LEGACY_RULES } = require("./game-room.js");
const { ELEVATOR_JOLT, FLOORS, TYPES } = require("./game-data.js");
function log(...a) { console.log("[test-jolt]", ...a); }
const el = (room) => room.state.elevator;

function toVoting(rules) {
  const room = new GameRoom("J", () => {}, Object.assign({ raceMode: false }, rules || {}));
  room.pickCourier("cookbang", "a"); room.pickCourier("cheonil", "b"); room.setReady("1"); room.setReady("2");
  room._endSecurePhase();
  room.setElevatorReady("1"); room.setElevatorReady("2");
  if (el(room).state === "priority") { room.confirmPriority("1"); room.confirmPriority("2"); }
  assert.strictEqual(el(room).state, "voting");
  return room;
}

assert.strictEqual(ELEVATOR_JOLT, 1, "기본값 켜짐");

// 1) 팽팽하게 비김 -> 덜컹
const seenDir = new Set();
for (let k = 0; k < 30; k++) {
  const room = toVoting();
  const start = el(room).floorIdx;
  room.vote("1", "up"); room.vote("2", "down");
  assert.strictEqual(el(room).floorIdx, start);
  room._resolveRound();
  const last = el(room).log[el(room).log.length - 1];
  assert.ok(last.jolt, "둘 다 눌렀는데 제자리면 덜컹");
  assert.strictEqual(last.jolt.from, start);
  assert.strictEqual(Math.abs(last.jolt.to - start), 1, "한 층만");
  assert.strictEqual(el(room).floorIdx, last.jolt.to);
  assert.strictEqual(last.floorIdx, last.jolt.to, "배송 층 = 덜컹한 층");
  assert.strictEqual(last.dir, "tie", "줄다리기 결과는 동률");
  seenDir.add(last.jolt.dir);
  room.destroy();
}
assert.strictEqual(seenDir.size, 2, "위/아래 둘 다 나온다");
log("두 사람 모두 눌렀는데 제자리 -> 한 층 덜컹 (위/아래 무작위)");

// 2) 끝층: B1에선 위로만
{
  const room = toVoting();
  let g = 10; while (el(room).floorIdx > 0 && g--) room.vote("1", "down");
  el(room).roundStartFloorIdx = 0; // B1에서 시작한 라운드로 만든다
  room.vote("2", "up"); room.vote("1", "down");
  room._resolveRound();
  const last = el(room).log[el(room).log.length - 1];
  assert.ok(last.jolt && last.jolt.to === 1, "B1에서 덜컹하면 1F로");
  room.destroy();
  log("B1에선 위로만 덜컹");
}

// 3) 덜컹 안 하는 경우
{
  let room = toVoting();
  room._resolveRound();
  assert.strictEqual(el(room).log[0].jolt, null, "아무도 안 누르면 덜컹 없음"); room.destroy();
  room = toVoting();
  room.vote("1", "up"); room.vote("1", "down");
  room._resolveRound();
  assert.strictEqual(el(room).log[0].jolt, null, "한 사람만 누르면 덜컹 없음"); room.destroy();
  room = toVoting();
  const s = el(room).floorIdx;
  room.vote("1", s < FLOORS.length - 1 ? "up" : "down"); room.vote("2", s < FLOORS.length - 1 ? "up" : "down");
  room._resolveRound();
  assert.strictEqual(el(room).log[0].jolt, null, "층이 바뀌었으면 덜컹 없음"); room.destroy();
  room = toVoting({ elevatorJolt: false });
  room.vote("1", "up"); room.vote("2", "down");
  room._resolveRound();
  assert.strictEqual(el(room).log[0].jolt, null, "elevatorJolt:false면 없음"); room.destroy();
  assert.strictEqual(LEGACY_RULES.elevatorJolt, false, "예전 규칙엔 덜컹 없음");
  log("안 누름 / 한 사람만 / 층 이동함 / 끔 -> 덜컹 없음");
}

// 4) 덜컹한 층에 송장이 있으면 그 층으로 배송
{
  const room = new GameRoom("J2", () => {}, { raceMode: false });
  room.pickCourier("cookbang", "a"); room.pickCourier("cheonil", "b"); room.setReady("1"); room.setReady("2");
  const ff = TYPES.findIndex((t) => t.key === "fixed-floor");
  room._endSecurePhase();
  const start = el(room).floorIdx;
  // 위·아래 층 둘 다에 1번 송장을 넣어 두면 어느 쪽으로 덜컹하든 배송된다
  [start - 1, start + 1].filter((f) => f >= 0 && f < FLOORS.length).forEach((f, i) => room.state.players["1"].invoices.push({
    id: "inv-1-j" + i, catIdx: ff, floorIdx: f, room: "1", acquiredSeq: 90 + i, reward: TYPES[ff].reward, deliveredRound: null, stolen: false, deliveredWasPriority: false,
  }));
  room.setElevatorReady("1"); room.setElevatorReady("2");
  if (el(room).state === "priority") { room.confirmPriority("1"); room.confirmPriority("2"); }
  room.vote("1", "up"); room.vote("2", "down");
  room._resolveRound();
  const last = el(room).log[el(room).log.length - 1];
  assert.ok(last.jolt);
  assert.ok(last.delivered.some((d) => d.seat === "1"), "덜컹한 층의 송장이 배송됨: " + JSON.stringify(last.delivered));
  room.destroy();
  log("덜컹한 층에서 배송 처리");
}
log("ALL CHECKS PASSED");
process.exit(0);
