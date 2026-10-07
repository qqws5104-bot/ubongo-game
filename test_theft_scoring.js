// 2026-08-28: 사용자 리포트 검증 -- "택배도둑이 도둑질한 택배는 미배송으로 처리되어야해".
//
// 코드를 읽어보면 game-room.js의 scoreInvoice/resultLabel은 이미 stolen 송장을 무조건 실패(-penalty
// / "미배송")로 처리하도록 되어 있고(2026-08-27 커밋 ce12f26), origin/main과도 diff 없이 동일하다.
// 다만 "실제로 성공/정상 배송으로 처리되는 걸 봤다"는 리포트가 있었으므로, 정적 코드 리뷰만으로
// 끝내지 않고 실제 GameRoom을 구동해서 진짜로 도난이 발생하는 시나리오를 결정론적으로 재현해본다.
//
// 실시간 타이머(secure phase 3분, VOTE_MS 5초 등)를 실제로 기다리지 않기 위해, WS/브라우저 없이
// GameRoom 인스턴스를 직접 만들어서 내부 메서드(_endSecurePhase, _finishHalf, _resolveRound 등)를
// 바로 호출한다 -- private 컨벤션(_ 접두사)일 뿐 실제로 호출을 막아주진 않으므로 테스트 목적으로는
// 안전하고 빠르다.
//
// 시나리오: "확정 층수 택배" 종류는 칸의 num이 곧 배송 층이라 층을 미리 알 수 있다(game-data.js:
// TYPES의 네 번째 종류, num=0 -> FLOORS[0] = "B1"). 후반 1라운드에 seat 1이 B1(floorIdx 0)에
// 택배도둑을 놓고, seat 2는 그 확정 층수 택배(B1행)를 확보해둔다. 도둑은 "다음 라운드부터" 작동하므로
// 2라운드에 엘리베이터를 B1로 보내 seat 2의 그 송장이 배송되게 만들면, stolen:true가 찍혀야 하고
// scoreInvoice/resultLabel 모두 "실패/미배송"으로 나와야 한다.
"use strict";
const assert = require("assert");
const { GameRoom, scoreInvoice, resultLabel, totalScore } = require("./game-room.js");
const { TYPES } = require("./game-data.js");

function log(...args) { console.log("[test-theft]", ...args); }

const fixedFloorCatIdx = TYPES.findIndex((t) => t.key === "fixed-floor");
assert(fixedFloorCatIdx === TYPES.length - 1, "assumption check: fixed-floor is the last category");
const fixedFloorPenalty = TYPES[fixedFloorCatIdx].penalty;

let lastState = null;
const room = new GameRoom("TEST", (state) => { lastState = state; });

// ---- 좌석/택배사 선택 ----
let r = room.pickCourier("cookbang", "clientA");
assert(r.ok && r.seat === "1", "seat 1 should be cookbang/clientA");
r = room.pickCourier("cheonil", "clientB");
assert(r.ok && r.seat === "2", "seat 2 should be cheonil/clientB");

// ---- 로비 -> 전반 secure (실제 타이머는 기다리지 않고 바로 끝냄, 이 테스트는 전반 결과 자체엔
// 관심 없음 -- 오직 후반 택배도둑 메커닉만 검증) ----
room.setReady("1");
room.setReady("2");
assert.strictEqual(room.state.phase, "secure", "should enter 전반 secure phase after both ready");
room._endSecurePhase();
assert.strictEqual(room.state.phase, "elevator", "should enter 전반 elevator phase");

// ---- 전반 엘리베이터는 이 테스트와 무관 -- 곧장 하프 종료로 스킵 ----
room._finishHalf();
assert.strictEqual(room.state.phase, "halftime", "should reach halftime after 전반");
assert.strictEqual(room.state.half, 2, "half should advance to 2");

// ---- 후반 시작 ----
room.halftimeReady("1");
room.halftimeReady("2");
assert.strictEqual(room.state.phase, "secure", "should enter 후반 secure phase");

// seat 2가 확정 층수 택배의 B1칸(num=0)을 확보 -- floorIdx가 확정적으로 0(B1)이 된다.
room.secureCell("2", "fixed-floor-1");
const seat2Inv = room.state.players["2"].invoices.find((v) => v.catIdx === fixedFloorCatIdx);
assert(seat2Inv, "seat 2 should have acquired the fixed-floor invoice");
assert.strictEqual(seat2Inv.floorIdx, 0, "fixed-floor-1 should map to floorIdx 0 (B1)");
log("seat 2 secured a B1-bound 확정 층수 택배 invoice:", seat2Inv.id);

room._endSecurePhase();
assert.strictEqual(room.state.phase, "elevator", "should enter 후반 elevator phase");
assert.strictEqual(room.state.half, 2, "still half 2");

// ---- 후반 라운드 1: idle -> thief window. seat 1이 B1(floorIdx 0)에 도둑을 놓고, seat 2는 넘긴다.
room.setElevatorReady("1");
room.setElevatorReady("2");
assert.strictEqual(room.state.elevator.state, "thief", "후반 round 1 should open the thief window");

room.placeThief("1", 0); // B1을 노림
room.placeThief("2", null); // 넘김
assert.strictEqual(room.state.elevator.state, "voting", "both done placing/skipping should advance straight to voting");
assert.deepStrictEqual(room.state.elevator.thieves.active, [], "round 1's own thief has not activated yet (활성화는 다음 라운드부터)");

// 라운드 1에서는 층 이동 없이(1F에 머무름) 곧장 해소 -- seat 2의 B1행 송장이 이 라운드에 배송되면
// 안 되므로(그러면 도둑이 활성화되기 전에 이미 배송 완료돼버려서 시나리오가 깨진다).
assert.strictEqual(room.state.elevator.floorIdx, 1, "elevator should still be at start floor (1F, idx 1) with no votes cast");
room._resolveRound();
assert.strictEqual(room.state.elevator.state, "result", "round 1 should resolve to result");
assert.strictEqual(seat2Inv.deliveredRound, null, "seat 2's B1 invoice must still be undelivered after round 1");

// ---- 후반 라운드 2: idle(result) -> thief window. 이번엔 round 1에 놓은 도둑이 activate된다.
room.setElevatorReady("1");
room.setElevatorReady("2");
assert.strictEqual(room.state.elevator.round, 2, "should now be round 2");
assert.strictEqual(room.state.elevator.state, "thief", "round 2 should also open a thief window");
assert.deepStrictEqual(
  room.state.elevator.thieves.active,
  [{ seat: "1", floorIdx: 0 }],
  "round 1's thief placement (seat 1 -> B1) must now be active for round 2"
);
log("confirmed: round-1 thief placement activated exactly one round later, as designed");

// seat 1은 후반 전체 1회 한도를 이미 썼으므로 자동으로 스킵 처리돼 있어야 한다.
assert.strictEqual(room.state.elevator.thieves.skipped["1"], true, "seat 1 should be auto-skipped (already used this half)");
room.placeThief("2", null); // seat 2도 넘겨서 곧장 voting으로
assert.strictEqual(room.state.elevator.state, "voting", "round 2 should now be voting");

// 엘리베이터를 1F(idx 1) -> B1(idx 0)으로 이동시켜 seat 2의 그 송장을 이번 라운드에 배송시킨다.
room.vote("1", "down");
assert.strictEqual(room.state.elevator.floorIdx, 0, "elevator should now be at B1 (idx 0)");
room._resolveRound();
assert.strictEqual(room.state.elevator.state, "result", "round 2 should resolve to result");

// ---- 핵심 검증: seat 2의 그 송장이 도난당했고, 그 결과가 "미배송"/실패로 정확히 채점되는가 ----
assert.strictEqual(seat2Inv.deliveredRound, 2, "invoice should be marked delivered on round 2 (도난도 '배송 시도는 됨' 처리)");
assert.strictEqual(seat2Inv.stolen, true, "invoice must be marked stolen -- a thief was active on its floor this round");
assert.strictEqual(seat2Inv.deliveredWasPriority, false, "stolen delivery must never get the priority multiplier");

const score = scoreInvoice(seat2Inv);
assert.strictEqual(score, -fixedFloorPenalty, `stolen invoice must score as a flat penalty (-${fixedFloorPenalty}), got ${score}`);

const label = resultLabel(seat2Inv);
assert.strictEqual(label, "미배송", `stolen invoice must be labeled 미배송 (undelivered), got "${label}"`);

// 라운드 로그(클라이언트의 실시간 "이번 라운드 배송" 안내가 읽는 데이터)에도 stolen:true가 찍혀야 함.
const roundLog = room.state.elevator.log.find((l) => l.round === 2);
const deliveredEntry = roundLog.delivered.find((d) => d.seat === "2");
assert(deliveredEntry, "round 2's delivered log should include seat 2's delivery");
assert.strictEqual(deliveredEntry.stolen, true, "round log entry must also mark this delivery as stolen");
assert.strictEqual(deliveredEntry.priority, false, "round log entry must not mark a stolen delivery as priority");

// 전체 합산 점수도 이 페널티를 정확히 반영하는지 (다른 송장이 하나도 없으므로 정확히 -penalty와 같아야 함)
const seat2Total = totalScore("2", room.state);
assert.strictEqual(seat2Total, -fixedFloorPenalty, "seat 2's total score for 후반 so far should equal exactly the theft penalty (no other invoices)");

log("ALL CHECKS PASSED -- stolen invoice correctly scored as a flat penalty and labeled 미배송, both in scoreInvoice/resultLabel and in the round log data the client renders from");
