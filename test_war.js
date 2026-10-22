// 2026-10-22 아파트 한 채 + 엘리베이터 이동 전쟁 (서버 로직). 실행: node test_war.js
// 2차 규칙: 이동 5초(▲ 한 번 = 한 층 위, ▼ = 한 층 아래, 바로 움직임) -> 택배 있는 층이면 배송 5초(그 층 내 집 3번씩) -> 다시 이동.
"use strict";
process.env.APT_WAR = "1";
const { GameRoom } = require("./game-room.js");
const D = require("./game-data.js");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(rules) {
  const box = { st: null };
  const room = new GameRoom("W", (s) => { box.st = s; }, Object.assign({ wallMode: true, raceGrantPlan: D.RACE_GRANT_PLAN, raceGrantByPieces: D.RACE_GRANT_BY_PIECES, raceUnlimited: true, raceGamePool: [], racePieceGames: false,
    contestRate: 0, feverMs: 0, deliveryMs: 20000, elevMoveMs: 400, elevOpenMs: 500, elevWarMoveMs: 0 }, rules));
  room.pickCourier("cookbang", "c1"); room.pickCourier("cheonil", "c2"); room.setReady("1"); room.setReady("2");
  room._endSecurePhase();
  box.st.players["1"].invoices = []; box.st.players["2"].invoices = []; // 레이스에서 받은 택배는 비우고 테스트마다 직접
  return { room, box };
}
const inv = (id, unit, reward) => ({ id, catIdx: 0, unit, reward: reward || 1000, deliveredRound: null });
const up = (room, s, n) => { for (let i = 0; i < n; i++) room.wallElevator(s, "up"); };
const down = (room, s, n) => { for (let i = 0; i < n; i++) room.wallElevator(s, "down"); };
(async () => {
  assert.strictEqual(D.UNITS.length, 56, "아파트 7층 x 8호");
  assert(D.UNITS.every((u) => u.b === "apt"));
  assert.strictEqual(D.ELEV_MOVE_MS, 5000); assert.strictEqual(D.ELEV_OPEN_MS, 5000);
  // 1) 이동 단계: 누를 때마다 바로 한 층 (줄다리기), 1~7층 안. 누가 몇 번 눌렀는지 셈.
  {
    const { room, box } = mk();
    const e = () => box.st.delivery.elev;
    assert(e().war); assert.strictEqual(e().stage, "move"); assert.strictEqual(e().floor, 1);
    up(room, "1", 3); assert.strictEqual(e().floor, 4);
    down(room, "2", 1); assert.strictEqual(e().floor, 3, "상대가 반대로 누르면 바로 내려감");
    up(room, "1", 10); assert.strictEqual(e().floor, 7, "7층까지만");
    assert.deepStrictEqual(e().moves, { "1": { up: 13, down: 0 }, "2": { up: 0, down: 1 } });
    room.wallElevator(null, "up"); assert.strictEqual(e().moves["1"].up, 13, "누군지 모르는 입력은 무시");
    room.destroy();
  }
  // 2) 5초(여기선 0.4초) 뒤 멈춘 층에 택배 있으면 배송 단계: 엘리베이터 잠김, 그 층 내 집 3번 = 배송
  {
    const { room, box } = mk();
    box.st.players["1"].invoices = [inv("a", "a203"), inv("b", "a207"), inv("x", "a705")];
    box.st.players["2"].invoices = [inv("c", "a201")];
    up(room, "1", 1); assert.strictEqual(box.st.delivery.elev.floor, 2);
    room.wallSlot("1", 3); assert.strictEqual(box.st.delivery.ev.pop().k, "closed", "이동 중엔 배송 못 함");
    await sleep(500);
    const e = box.st.delivery.elev;
    assert.strictEqual(e.stage, "deliver"); assert.strictEqual(e.open, true);
    up(room, "2", 3); assert.strictEqual(e.floor, 2, "배송 동안 잠김");
    for (let i = 0; i < 3; i++) room.wallSlot("1", 3);
    for (let i = 0; i < 3; i++) room.wallSlot("1", 7);
    assert.strictEqual(box.st.players["1"].invoices.filter((v) => v.deliveredRound === 1).length, 2, "5초 안에 여러 집");
    room.wallSlot("2", 1); // 파랑은 한 번만 -> 못 채움
    room.wallSlot("1", 4); room.wallSlot("1", 4); assert.strictEqual(box.st.players["1"].wrong, 1, "오배송은 같은 문 열림에 한 번만");
    await sleep(600);
    assert.strictEqual(box.st.delivery.elev.stage, "move", "배송 끝 -> 다시 이동");
    assert(box.st.delivery.ev.some((x) => x.k === "shut" && x.seat === "2"), "못 채운 파랑은 끊김");
    room.destroy();
  }
  // 3) 택배 없는 층이면 배송 없이 바로 다음 이동
  {
    const { room, box } = mk();
    box.st.players["1"].invoices = [inv("a", "a301")];
    const r0 = box.st.delivery.elev.round;
    await sleep(500);
    assert.strictEqual(box.st.delivery.elev.stage, "move"); assert(box.st.delivery.elev.round > r0, "다음 이동 라운드");
    assert(box.st.delivery.ev.some((x) => x.k === "empty"));
    room.destroy();
  }
  // 4) 같은 집(⚔): 먼저 3번 채운 사람만, 그 층 택배가 다 나가면 조금 일찍 닫힘
  {
    const { room, box } = mk({ elevOpenMs: 3000 });
    box.st.players["1"].invoices = [inv("a", "a102")];
    box.st.players["2"].invoices = [inv("b", "a102")];
    await sleep(500); assert.strictEqual(box.st.delivery.elev.stage, "deliver");
    room.wallSlot("1", 2); room.wallSlot("2", 2); room.wallSlot("2", 2); room.wallSlot("1", 2); room.wallSlot("2", 2);
    assert.strictEqual(box.st.players["2"].invoices[0].deliveredRound, 1);
    assert.strictEqual(box.st.players["1"].invoices[0].lost, true);
    await sleep(800); assert.strictEqual(box.st.delivery.elev.stage, "move", "다 나감 -> 3초 안 기다리고 닫힘");
    room.destroy();
  }
  // 5) 점수 합산 (건물 콤보·막기 보상 없음)
  {
    const { room, box } = mk({ deliveryMs: 1200 });
    assert.strictEqual(box.st.wallRule.bldBonus, 0); assert.strictEqual(box.st.wallRule.blockReward, 0);
    assert.deepStrictEqual(box.st.wallRule.war, { moveMs: 400, openMs: 500, deliverTaps: 3 });
    box.st.players["1"].invoices = [inv("a", "a108", 3000)];
    await sleep(500);
    for (let i = 0; i < 3; i++) room.wallSlot("1", 8);
    await sleep(4000);
    assert.strictEqual(box.st.halfHistory[0].scores["1"], 3000);
    room.destroy();
  }
  console.log("test_war OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
