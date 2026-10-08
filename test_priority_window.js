// 2026-10-06: 우선 택배 지정 전용 10초 창("priority" 상태) 서버 로직 검증 -- GameRoom 직접 구동, 브라우저/WS 불필요.
//   - 둘 다 준비(스페이스)하면 voting/thief 전에 priority 창이 먼저 열린다 (미배송 택배가 있을 때)
//   - 창 밖(idle/voting)에서는 지정이 무시된다
//   - 확정 전에는 바꾸고 해제할 수 있고, 확정하면 잠긴다
//   - 한 명만 확정해서는 안 닫힌다 / 둘 다 확정하면 즉시 닫히고 전반=voting, 후반=thief로 간다
//   - 시간 초과(_endPriorityWindow)면 확정 안 해도 닫히고, 그 시점의 지정값이 그대로 라운드에 적용된다
//   - 지정한 택배를 그 라운드에 배송하면 우선 배수, 다음 라운드엔 지정이 비워져 있다
//   - 미배송 택배가 하나도 없는 플레이어는 자동 확정, 둘 다 없으면 창 자체가 안 열린다
//   - 오래된 타이머(이전 창의 endsAt)는 새 창을 끊지 못한다
"use strict";
const assert = require("assert");
const { GameRoom } = require("./game-room.js");
const { PRIORITY_PICK_MS } = require("./game-data.js");

function log(...a) { console.log("[test-priority]", ...a); }
assert.strictEqual(PRIORITY_PICK_MS, 10000, "우선 택배 지정 시간은 10초");

function newRoom() {
  const room = new GameRoom("TEST", () => {});
  room.pickCourier("cookbang", "clientA");
  room.pickCourier("cheonil", "clientB");
  room.setReady("1"); room.setReady("2");
  return room;
}
const el = (room) => room.state.elevator;
const readyBoth = (room) => { room.setElevatorReady("1"); room.setElevatorReady("2"); };

// ---------- 전반, 택배가 있는 경우 ----------
let room = newRoom();
// 1F행 택배를 양쪽이 확보하게 한다 (확정 층수 택배는 칸 num이 곧 층: num=1 -> 1F)
room.secureCell("1", "fixed-floor-2");
room.secureCell("2", "fixed-floor-3");
room.secureCell("1", "normal-1");
room._endSecurePhase();
assert.strictEqual(room.state.phase, "elevator");
assert.strictEqual(el(room).state, "idle");

// 창 밖(idle)에서는 지정 무시
const inv1 = room.state.players["1"].invoices[0];
room.setPriorityPick("1", inv1.id);
assert.strictEqual(el(room).priorityPick["1"], null, "idle 게이트에서는 더 이상 지정할 수 없다");
log("idle 게이트에서 지정 시도 -> 무시");

readyBoth(room);
assert.strictEqual(el(room).state, "priority", "둘 다 준비 -> priority 창이 먼저 열림 (전반이어도)");
assert.ok(el(room).priorityWindowEndsAt - Date.now() > 9000 && el(room).priorityWindowEndsAt - Date.now() <= 10000, "창 길이 ~10초");
log("준비 완료 -> priority 창 열림, 종료 시각이 10초 뒤");

// 지정 / 해제 / 재지정
room.setPriorityPick("1", inv1.id);
assert.strictEqual(el(room).priorityPick["1"], inv1.id);
room.setPriorityPick("1", null);
assert.strictEqual(el(room).priorityPick["1"], null);
room.setPriorityPick("1", inv1.id);
// 남의 송장은 지정 불가
const inv2 = room.state.players["2"].invoices[0];
room.setPriorityPick("1", inv2.id);
assert.strictEqual(el(room).priorityPick["1"], inv1.id, "상대 송장은 지정 불가");
log("지정/해제/재지정 OK, 남의 송장 지정은 거부");

// 한 명만 확정 -> 안 닫힘, 확정 후엔 잠김
room.confirmPriority("1");
assert.strictEqual(el(room).state, "priority", "한 명 확정으로는 닫히지 않음");
room.setPriorityPick("1", null);
assert.strictEqual(el(room).priorityPick["1"], inv1.id, "확정 후에는 지정 변경 불가");
room.confirmPriority("1"); // 멱등
assert.strictEqual(el(room).state, "priority");
room.confirmPriority("2");
assert.strictEqual(el(room).state, "voting", "둘 다 확정 -> 전반이므로 곧장 voting");
assert.strictEqual(el(room).priorityWindowEndsAt, null);
log("확정 잠금 + 둘 다 확정하면 즉시 voting(전반)");

// voting 중에는 지정/확정 무시
room.setPriorityPick("2", inv2.id);
assert.strictEqual(el(room).priorityPick["2"], null, "voting 중엔 지정 불가");
room.confirmPriority("2");

// 이번 라운드에 1F로 가만히 있으면 1F행 택배가 배송됨 -> inv1이 1F행이 아니면 우선 배수 없음. 여기선 지정이 라운드 끝에 비워지는지만 본다.
room._resolveRound();
if (el(room).state === "choosing") room._finishChoosing && room._finishChoosing();
assert.ok(["result", "choosing"].includes(el(room).state));
log("라운드 해소까지 진행");

// ---------- 시간 초과 경로 ----------
room = newRoom();
room.secureCell("1", "fixed-floor-2"); // 1F행
room._endSecurePhase();
readyBoth(room);
assert.strictEqual(el(room).state, "priority", "seat 1만 택배가 있어도 창은 열림");
assert.strictEqual(el(room).priorityConfirmed["2"], true, "택배가 없는 seat 2는 자동 확정");
assert.strictEqual(el(room).priorityConfirmed["1"], false);
const only = room.state.players["1"].invoices[0];
room.setPriorityPick("1", only.id);
// 오래된 타이머가 새 창을 끊지 못해야 한다
room._endPriorityWindow(12345);
assert.strictEqual(el(room).state, "priority", "이 창이 아닌 타이머(endsAt 불일치)는 무시");
// 시간 초과: 확정 안 했어도 닫히고, 지정값 유지
room._endPriorityWindow(el(room).priorityWindowEndsAt);
assert.strictEqual(el(room).state, "voting", "시간 초과 -> voting");
assert.strictEqual(el(room).priorityPick["1"], only.id, "시간 초과 시점의 지정값이 그대로 적용됨");
// 그 라운드에 1F(시작 층)에 머문 채로 해소 -> 1F행 택배라 배송되고 우선 배수가 붙는다
assert.strictEqual(only.floorIdx, 1, "fixed-floor-2 = 1F 행");
room._resolveRound();
assert.strictEqual(only.deliveredRound, 1);
assert.strictEqual(only.deliveredWasPriority, true, "지정 + 그 라운드 배송 -> 우선 배수 적용");
assert.deepStrictEqual(el(room).priorityPick, { "1": null, "2": null }, "라운드가 끝나면 지정이 비워짐");
log("시간 초과 시 지정값 적용 + 같은 라운드 배송 시 우선 배수, 라운드 후 지정 초기화, 오래된 타이머 무시");

// ---------- 지정할 택배가 없으면 창 자체가 안 열림 ----------
room = newRoom();
room._endSecurePhase();
readyBoth(room);
assert.strictEqual(el(room).state, "voting", "둘 다 택배가 없으면 priority 창을 건너뜀");
log("둘 다 택배 없음 -> priority 창 생략");

// ---------- 후반: priority -> thief -> voting ----------
room = newRoom();
room._endSecurePhase();
room._finishHalf();
room.halftimeReady("1"); room.halftimeReady("2");
room.secureCell("1", "fixed-floor-2");
room.secureCell("2", "fixed-floor-3");
room._endSecurePhase();
readyBoth(room);
assert.strictEqual(room.state.half, 2);
assert.strictEqual(el(room).state, "priority", "후반도 priority가 먼저");
room.confirmPriority("1"); room.confirmPriority("2");
assert.strictEqual(el(room).state, "thief", "후반: priority 다음은 thief 창");
room.placeThief("1", null); room.placeThief("2", null);
assert.strictEqual(el(room).state, "voting");
log("후반: priority -> thief -> voting 순서");

log("ALL CHECKS PASSED");
process.exit(0);
