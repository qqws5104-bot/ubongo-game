// 2026-10-16 벽 배송 + 택배 쌓기 몫 계획 (서버 로직). 실행: node test_wall.js
"use strict";
const { GameRoom } = require("./game-room.js");
const D = require("./game-data.js");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(rules) {
  const box = { st: null };
  const room = new GameRoom("T", (s) => { box.st = s; }, Object.assign({ wallMode: true, raceGrantPlan: D.RACE_GRANT_PLAN, raceUnlimited: true }, rules));
  room.pickCourier("cookbang", "c1"); room.pickCourier("cheonil", "c2"); room.setReady("1"); room.setReady("2");
  return { room, box };
}
(async () => {
  // 1) 몫: 1~2라운드 3개 중 2개, 3라운드부터 5개 중 3개. 나머지는 늦은 사람.
  {
    const { room, box } = mk({ raceConsolationMs: 300, racePickMs: 400, raceRevealMs: 50 });
    let r = box.st.race;
    assert.strictEqual(r.pair.length, 3); assert.strictEqual(r.plan.first, 2); assert(r.pair.every((p) => p.unit), "택배마다 배송지");
    room.raceStep("1", "ubongo-done", 1);
    room.racePick("1", 0); room.racePick("1", 2); room.racePick("1", 1);
    assert.deepStrictEqual(box.st.race.picks["1"], [0, 2], "먼저 끝낸 사람은 2개까지만");
    room.racePick("2", 1); assert.deepStrictEqual(box.st.race.picks["2"], [], "늦은 사람은 직접 못 고른다");
    await sleep(450);
    assert.strictEqual(box.st.players["2"].invoices.length, 1, "위로: 늦은 사람이 나머지 1개");
    await sleep(150);
    assert.strictEqual(box.st.race.round, 2);
    room.raceStep("2", "ubongo-done", 2); await sleep(950); // 2번이 먼저, 시간 지나 무작위 2개 + 1번이 나머지
    assert.strictEqual(box.st.race.round, 3, "3라운드");
    assert.strictEqual(box.st.race.pair.length, 5); assert.strictEqual(box.st.race.plan.first, 3);
    room.raceStep("1", "ubongo-done", 3); room.raceStep("2", "ubongo-done", 3); // 늦은 사람도 투입 -> 1등이 다 고르면 바로 나머지
    room.racePick("1", 1); room.racePick("1", 3); room.racePick("1", 4);
    assert.strictEqual(box.st.players["1"].invoices.length, 2 + 1 + 3);
    assert.strictEqual(box.st.players["2"].invoices.length, 1 + 2 + 2);
    const units = [].concat(box.st.players["1"].invoices, box.st.players["2"].invoices).map((v) => v.unit);
    assert.strictEqual(new Set(units).size, units.length, "배송지 안 겹침");
    room.destroy();
  }
  // 2) 유지 방식 배송 + 엘리베이터 + 오배송
  {
    const { room, box } = mk({ deliveryMs: 4000, deliveryHoldMs: 300, deliveryElevMoveMs: 0 });
    room._endSecurePhase(); assert.strictEqual(box.st.phase, "delivery"); assert.strictEqual(box.st.delivery.elev.floor, 1);
    box.st.players["1"].invoices = [{ id: "x1", catIdx: 0, unit: "a301", reward: 2500, deliveredRound: null }, { id: "x2", catIdx: 1, unit: "h3", reward: 5000, deliveredRound: null }];
    const last = () => box.st.delivery.ev[box.st.delivery.ev.length - 1].k;
    room.wallPress("1", "a301"); assert(!box.st.delivery.doors.a301); assert.strictEqual(last(), "noelev"); assert.strictEqual(box.st.players["1"].wrong, 0, "엘리베이터 없음은 감점 아님");
    room.wallElevator("1", "up"); room.wallElevator("1", "up"); assert.strictEqual(box.st.delivery.elev.floor, 3);
    room.wallPress("1", "a301"); assert(box.st.delivery.doors.a301);
    room.wallPress("1", "h3"); assert.strictEqual(last(), "busy", "한 번에 한 집");
    room.wallElevator("2", "down"); assert(!box.st.delivery.doors.a301); assert.strictEqual(last(), "elevleft");
    room.wallPress("1", "h3"); await sleep(100); room.wallRelease("1", "h3"); assert.strictEqual(last(), "released");
    room.wallPress("1", "h3"); await sleep(450); assert.strictEqual(box.st.players["1"].invoices[1].deliveredRound, 1); assert.strictEqual(last(), "done");
    room.wallPress("1", "m101"); assert.strictEqual(box.st.players["1"].wrong, 1, "오배송");
    room.wallPress("2", "h3"); assert.strictEqual(box.st.players["2"].wrong, 1, "남의 집도 오배송");
    await sleep(3700); assert.strictEqual(box.st.phase, "halftime");
    const sc = box.st.halfHistory[0].scores["1"];
    assert.strictEqual(sc, 5000 - 1000 - D.DELIVERY_WRONG_PENALTY, "점수 = 배송 - 미배송 감점 - 오배송");
    room.destroy();
  }
  // 2b) 엘리베이터가 움직이는 동안(deliveryElevMoveMs)은 아파트 배송 시작 불가
  {
    const { room, box } = mk({ deliveryMs: 3000, deliveryHoldMs: 300, deliveryElevMoveMs: 300 });
    room._endSecurePhase();
    box.st.players["1"].invoices = [{ id: "z1", catIdx: 0, unit: "a201", reward: 2500, deliveredRound: null }];
    room.wallElevator("2", "up"); assert.strictEqual(box.st.delivery.elev.floor, 2);
    room.wallPress("1", "a201"); assert(!box.st.delivery.doors.a201); assert.strictEqual(box.st.delivery.ev[box.st.delivery.ev.length - 1].k, "elevmoving");
    await sleep(350); room.wallPress("1", "a201"); assert(box.st.delivery.doors.a201, "멈춘 뒤엔 가능");
    room.destroy();
  }
  // 3) 시간 방식(유지 끔): 켜진 버튼을 보조키 없이 5번 -> 반송
  {
    const { room, box } = mk({ deliveryMs: 3000, deliveryHoldMs: 0, deliveryProgressMs: 400 });
    room._endSecurePhase();
    box.st.players["2"].invoices = [{ id: "y1", catIdx: 0, unit: "m205", reward: 2500, deliveredRound: null }];
    room.wallPress("2", "m205"); for (let i = 0; i < 5; i++) room.wallPress(null, "m205");
    assert(box.st.players["2"].invoices[0].returned, "5번 누르면 반송");
    room.destroy();
  }
  console.log("test_wall OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
