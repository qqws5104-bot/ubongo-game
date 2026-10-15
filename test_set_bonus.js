// 2026-10-15 종류 모으기 보너스 (SET_BONUS / SET_BONUS_KINDS) -- GameRoom 직접 구동.
//   한 하프에서 서로 다른 종류 3가지를 "배송 성공"하면 +SET_BONUS (도난/미배송 제외), 하프 점수(halfHistory)에 반영, LEGACY_RULES는 끔
"use strict";
const assert = require("assert");
const { GameRoom, totalScore, setBonusFor, deliveredKinds, scoreInvoice, LEGACY_RULES } = require("./game-room.js");
const { TYPES, SET_BONUS, SET_BONUS_KINDS } = require("./game-data.js");
function log(...a) { console.log("[test-set-bonus]", ...a); }
const inv = (id, catIdx, delivered, extra) => Object.assign({ id, catIdx, floorIdx: 2, room: "1", acquiredSeq: 1, reward: TYPES[catIdx].reward, deliveredRound: delivered ? 1 : null, stolen: false, deliveredWasPriority: false }, extra || {});

assert.strictEqual(SET_BONUS, 5000); assert.strictEqual(SET_BONUS_KINDS, 3);
const room = new GameRoom("S", () => {}, { raceMode: false });
assert.deepStrictEqual(room.state.setRule, { amount: 5000, kinds: 3 });
const st = room.state;
const base = (invs) => invs.reduce((s, v) => s + scoreInvoice(v), 0);

st.players["1"].invoices = [inv("a", 0, true), inv("b", 1, true), inv("c", 1, true)];
assert.strictEqual(deliveredKinds(st.players["1"].invoices), 2);
assert.strictEqual(totalScore("1", st), base(st.players["1"].invoices), "2종류면 보너스 없음");
st.players["1"].invoices.push(inv("d", 3, true));
assert.strictEqual(totalScore("1", st), base(st.players["1"].invoices) + 5000, "3종류 배송 -> +5000");
st.players["1"].invoices = [inv("a", 0, true), inv("b", 1, true), inv("c", 2, false)];
assert.strictEqual(setBonusFor(st.players["1"].invoices, st.setRule), 0, "미배송은 안 셈");
st.players["1"].invoices = [inv("a", 0, true), inv("b", 1, true), inv("c", 2, true, { stolen: true })];
assert.strictEqual(setBonusFor(st.players["1"].invoices, st.setRule), 0, "도난은 안 셈");
log("서로 다른 종류 3가지 배송 성공 -> +5,000 (미배송/도난 제외)");

// 하프 점수에 반영
st.players["1"].invoices = [inv("a", 0, true), inv("b", 1, true), inv("c", 2, true)];
st.players["2"].invoices = [inv("e", 0, true)];
const exp1 = base(st.players["1"].invoices) + 5000;
st.phase = "elevator";
room._finishHalf();
assert.strictEqual(st.halfHistory[0].scores["1"], exp1, "하프 점수에 보너스 포함");
assert.strictEqual(st.halfHistory[0].scores["2"], base([inv("e", 0, true)]));
log("하프 점수(halfHistory)에 반영");
room.destroy();

const legacy = new GameRoom("L", () => {}, LEGACY_RULES);
assert.strictEqual(legacy.state.setRule.amount, 0, "LEGACY_RULES는 보너스 없음");
legacy.destroy();
log("ALL CHECKS PASSED");
process.exit(0);
