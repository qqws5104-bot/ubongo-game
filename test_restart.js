// 2026-08-28: "게임 완료된 후 다시 시작할 수 있는 버튼" 요청 검증.
//
// GameRoom을 직접 구동해서(WS/브라우저 없이) restartReady()가 정확히: (1) 둘 다 눌러야만 발동하고,
// (2) seatOwners/courierPick은 그대로 유지하면서, (3) 보드/송장/엘리베이터/하프/스코어 이력은 완전히
// 초기화하고, (4) phase를 곧장 "secure"로 되돌리는지 확인한다. E2E(Playwright) 쪽 커버리지는
// test_hosted.js 맨 끝에서 실제 두 브라우저 컨텍스트로 버튼 클릭까지 확인한다 -- 이 파일은 그
// 로직을 빠르게, 결정론적으로 검증하는 보완용.
"use strict";
const assert = require("assert");
const { GameRoom } = require("./game-room.js");

function log(...args) { console.log("[test-restart]", ...args); }

const room = new GameRoom("TEST", () => {});

// ---- 좌석/택배사 선택 ----
room.pickCourier("cookbang", "clientA"); // seat 1
room.pickCourier("cheonil", "clientB");  // seat 2
room.setReady("1");
room.setReady("2");
room._endSecurePhase(); // skip 전반 secure 타이머
room.secureCell("1", "normal-1"); // seat 1이 뭔가 하나는 확보해뒀다가 리셋 후 사라지는지 확인용
room._finishHalf(); // 전반 종료 -> halftime
room.halftimeReady("1");
room.halftimeReady("2");
room._endSecurePhase(); // skip 후반 secure 타이머
room._finishHalf(); // 후반 종료 -> end
assert.strictEqual(room.state.phase, "end", "should reach the end phase");
assert(room.state.scores, "scores should be set at game end");
log("reached end phase with scores:", JSON.stringify(room.state.scores));

// ---- restart-ready: 한쪽만 누르면 아직 발동하면 안 됨 ----
room.restartReady("1");
assert.strictEqual(room.state.phase, "end", "phase must NOT change until both seats click restart");
assert.strictEqual(room.state.restartReady["1"], true, "seat 1's restartReady should be recorded");
assert.strictEqual(room.state.restartReady["2"], false, "seat 2 has not clicked yet");
log("confirmed: one-sided restart click does not flip the phase");

// 이미 누른 좌석이 또 눌러도 멱등해야 함 (중복 클릭 방지 확인)
room.restartReady("1");
assert.strictEqual(room.state.phase, "end", "double-click from the same seat must stay a no-op");

// ---- 둘 다 누르면 즉시 재시작 ----
room.restartReady("2");
assert.strictEqual(room.state.phase, "secure", "phase should go straight back to secure once BOTH click restart");
assert.strictEqual(room.state.half, 1, "half must reset to 1");
assert.strictEqual(room.state.halfHistory.length, 0, "halfHistory must be cleared");
assert.strictEqual(room.state.scores, null, "scores must be cleared (null) until the new game ends");
assert.deepStrictEqual(room.state.restartReady, { "1": false, "2": false }, "restartReady gate must reset for next time");
log("confirmed: both-clicks triggers an immediate restart into a fresh secure phase");

// 좌석/택배사는 그대로 유지 (재선택 화면으로 안 돌아감)
assert.strictEqual(room.state.seatOwners["1"], "clientA", "seat 1 owner must be preserved across restart");
assert.strictEqual(room.state.seatOwners["2"], "clientB", "seat 2 owner must be preserved across restart");
assert.strictEqual(room.state.courierPick["1"], "cookbang", "seat 1's courier pick must be preserved across restart");
assert.strictEqual(room.state.courierPick["2"], "cheonil", "seat 2's courier pick must be preserved across restart");
log("confirmed: seatOwners/courierPick survive the restart (no re-pick screen needed)");

// 보드/송장은 완전히 새로 -- 이전 하프에서 확보했던 송장이 하나도 남아있으면 안 됨
assert.strictEqual(room.state.players["1"].invoices.length, 0, "seat 1 must start the restarted game with zero invoices");
assert.strictEqual(room.state.players["2"].invoices.length, 0, "seat 2 must start the restarted game with zero invoices");
const takenCells = room.state.boards["1"].filter((c) => c.taken).length + room.state.boards["2"].filter((c) => c.taken).length;
assert.strictEqual(takenCells, 0, "both boards must be completely fresh (no taken cells) after restart");
log("confirmed: boards/invoices fully reset after restart");

// secure 타이머가 실제로 다시 걸렸는지
assert(room.state.secureEndsAt && room.state.secureEndsAt > Date.now(), "a fresh secureEndsAt timer must be scheduled");
room.destroy(); // clean up the scheduled timer so the test process can exit promptly
log("ALL CHECKS PASSED");
