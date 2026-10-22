// 2026-10-22 아파트 한 채 + 엘리베이터 이동 전쟁 (서버 로직). 실행: node test_war.js
"use strict";
process.env.APT_WAR = "1";
const { GameRoom } = require("./game-room.js");
const D = require("./game-data.js");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(rules) {
  const box = { st: null };
  const room = new GameRoom("W", (s) => { box.st = s; }, Object.assign({ wallMode: true, raceGrantPlan: D.RACE_GRANT_PLAN, raceGrantByPieces: D.RACE_GRANT_BY_PIECES, raceUnlimited: true, raceGamePool: [], racePieceGames: false,
    contestRate: 0, feverMs: 0, deliveryMs: 20000, elevSettleMs: 200, elevOpenMs: 600, elevWarMoveMs: 0 }, rules));
  room.pickCourier("cookbang", "c1"); room.pickCourier("cheonil", "c2"); room.setReady("1"); room.setReady("2");
  room._endSecurePhase();
  return { room, box };
}
const inv = (id, unit, reward) => ({ id, catIdx: 0, unit, reward: reward || 1000, deliveredRound: null });
const up = (room, s, n) => { for (let i = 0; i < n; i++) room.wallElevator(s, "up"); };
const down = (room, s, n) => { for (let i = 0; i < n; i++) room.wallElevator(s, "down"); };
(async () => {
  assert.strictEqual(D.UNITS.length, 56, "아파트 7층 x 8호");
  assert(D.UNITS.every((u) => u.b === "apt"));
  // 1) 방향 게이지: 누가 눌렀든 ↑ 수 vs ↓ 수, 먼저 5에 닿은 방향으로 한 층, 두 게이지 다 0으로
  {
    const { room, box } = mk();
    const e = () => box.st.delivery.elev;
    assert(e().war); assert.strictEqual(e().floor, 1); assert.strictEqual(e().open, false);
    assert.strictEqual(box.st.wallRule.war.taps, 5);
    up(room, "1", 5); assert.strictEqual(e().floor, 2);
    up(room, "2", 3); down(room, "1", 4);
    assert.deepStrictEqual(e().cnt, { up: 3, down: 4 }); assert.deepStrictEqual(e().by.up, ["2", "2", "2"]);
    up(room, "1", 1); assert.strictEqual(e().cnt.up, 4, "빨강이 ↑를 눌러도 ↑ 게이지 (같은 방향 = 같이 채움)");
    down(room, "2", 1); assert.strictEqual(e().floor, 1, "↓ 5 먼저 -> 한 층 아래");
    assert.deepStrictEqual(e().cnt, { up: 0, down: 0 }, "두 게이지 모두 처음부터");
    room.wallElevator(null, "up"); assert.strictEqual(e().cnt.up, 0, "누군지 모르는 입력은 무시");
    room.destroy();
  }
  // 2) 멈추면 문 열림 -> 그 층 호실 3번 연타 = 배송. 문 열린 동안 엘리베이터 잠김. 다른 층 호실/문 닫힘 때는 안 됨.
  {
    const { room, box } = mk();
    box.st.players["1"].invoices = [inv("a", "a203"), inv("b", "a705")];
    box.st.players["2"].invoices = [inv("c", "a201")];
    up(room, "1", 5); assert.strictEqual(box.st.delivery.elev.floor, 2);
    room.wallPress("1", "a203"); assert.strictEqual(box.st.delivery.ev.pop().k, "closed", "문 닫힘");
    await sleep(320);
    const e = box.st.delivery.elev;
    assert.strictEqual(e.open, true, "멈추면 문 열림");
    up(room, "2", 5); assert.strictEqual(e.floor, 2, "문 열린 동안 잠김");
    room.wallPress("1", "a705"); assert.strictEqual(box.st.delivery.ev[box.st.delivery.ev.length - 1].k, "noelev");
    room.wallPress("1", "a203"); room.wallPress("1", "a203");
    assert.strictEqual(box.st.delivery.mash["1"].a203, 2);
    room.wallPress("2", "a201"); // 파랑도 동시에
    room.wallPress("1", "a203");
    assert.strictEqual(box.st.players["1"].invoices[0].deliveredRound, 1, "3번 = 배송");
    // 오배송: 같은 문 열림에 같은 집은 한 번만 감점
    room.wallPress("1", "a204"); room.wallPress("1", "a204"); room.wallPress("1", "a204");
    assert.strictEqual(box.st.players["1"].wrong, 1);
    await sleep(650);
    assert(box.st.delivery.ev.some((x) => x.k === "close"), "시간 지나면 닫힘");
    assert(box.st.delivery.ev.some((x) => x.k === "shut" && x.seat === "2"), "못 채운 파랑은 끊김");
    assert(!box.st.delivery.mash["2"].a201, "닫히면 연타 수 처음부터");
    room.destroy();
  }
  // 3) 같은 집(⚔): 먼저 3번 채운 사람만, 상대 택배는 무효
  {
    const { room, box } = mk();
    box.st.players["1"].invoices = [inv("a", "a102")];
    box.st.players["2"].invoices = [inv("b", "a102")];
    await sleep(320); assert(box.st.delivery.elev.open);
    room.wallPress("1", "a102"); room.wallPress("2", "a102"); room.wallPress("2", "a102"); room.wallPress("1", "a102"); room.wallPress("2", "a102");
    assert.strictEqual(box.st.players["2"].invoices[0].deliveredRound, 1);
    assert.strictEqual(box.st.players["1"].invoices[0].lost, true);
    room.wallPress("1", "a102"); assert.strictEqual(box.st.players["1"].wrong || 0, 1, "이미 없는 택배 -> 오배송");
    room.destroy();
  }
  // 4) 위아래 버티기: flipForce번 방향이 바뀌면 그 층에서 강제로 문 열림
  {
    const { room, box } = mk({ elevSettleMs: 5000 });
    box.st.players["1"].invoices = [inv("a", "a204")];
    up(room, "1", 5); up(room, "1", 5); // 3층
    down(room, "2", 5); up(room, "1", 5); down(room, "2", 5); // 방향 바뀜 3번 (방향 게이지라 각자 5번씩이면 그대로 한 층씩)
    assert.strictEqual(box.st.delivery.elev.flips, 3);
    await sleep(150);
    assert.strictEqual(box.st.delivery.elev.open, true, "강제로 열림");
    assert(box.st.delivery.ev.some((x) => x.k === "open" && x.forced));
    room.destroy();
  }
  // 4b) 문은 도착할 때 한 번, 택배 있는 층에서만. 그 층을 다 보내면 바로 닫힘. 안 움직이면 다시 안 열림.
  {
    const { room, box } = mk();
    box.st.players["1"].invoices = [inv("a", "a301")];
    await sleep(350); assert.strictEqual(box.st.delivery.elev.open, false, "1층엔 아무 택배 없음 -> 안 열림");
    up(room, "2", 5); up(room, "2", 5); await sleep(350);
    assert.strictEqual(box.st.delivery.elev.open, true, "3층 도착 -> 열림");
    room.wallPress("1", "a301"); room.wallPress("1", "a301"); room.wallPress("1", "a301");
    await sleep(550); assert.strictEqual(box.st.delivery.elev.open, false, "3층 다 보냄 -> 바로 닫힘");
    await sleep(400); assert.strictEqual(box.st.delivery.elev.open, false, "안 움직이면 다시 안 열림");
    up(room, "1", 3); assert.strictEqual(box.st.delivery.elev.cnt.up, 3, "닫힌 동안 바로 쟁탈");
    room.destroy();
  }
  // 5) 끝 층에서 더 못 감, 점수 합산 (건물 콤보·막기 보상 없음)
  {
    const { room, box } = mk({ deliveryMs: 900 });
    assert.strictEqual(box.st.wallRule.bldBonus, 0); assert.strictEqual(box.st.wallRule.blockReward, 0);
    down(room, "1", 5); assert.strictEqual(box.st.delivery.elev.floor, 1);
    assert(box.st.delivery.ev.some((x) => x.k === "elevend"));
    box.st.players["1"].invoices = [inv("a", "a108", 3000)];
    await sleep(320);
    room.wallPress("1", "a108"); room.wallPress("1", "a108"); room.wallPress("1", "a108");
    await sleep(4000);
    assert.strictEqual(box.st.halfHistory[0].scores["1"], 3000);
    room.destroy();
  }
  console.log("test_war OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
