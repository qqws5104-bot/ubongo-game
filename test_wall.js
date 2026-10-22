// 2026-10-16 벽 배송 + 택배 쌓기 몫 계획 (서버 로직). 실행: node test_wall.js
"use strict";
process.env.APT_WAR = process.env.APT_WAR || "0"; // 예전 3동(아파트·맨션·주택) 규칙 테스트 -- 엘리베이터 전쟁은 test_war.js
const { GameRoom } = require("./game-room.js");
const D = require("./game-data.js");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(rules) {
  const box = { st: null };
  const room = new GameRoom("T", (s) => { box.st = s; }, Object.assign({ wallMode: true, raceGrantPlan: D.RACE_GRANT_PLAN, raceGrantByPieces: D.RACE_GRANT_BY_PIECES, raceUnlimited: true, raceGamePool: [], racePieceGames: false, deliveryModes: { apt: "wait", mansion: "wait", house: "wait" }, contestRate: 0, feverMs: 0, deliveryPairButtons: false }, rules));
  room.pickCourier("cookbang", "c1"); room.pickCourier("cheonil", "c2"); room.setReady("1"); room.setReady("2");
  return { room, box };
}
(async () => {
  // 0) 택배 쌓기 전에 첫 미니게임 + 택배 수 = 조각 수로 (2조각 3개 / 3조각 이상 5개)
  {
    const { room, box } = mk({ raceGamePool: ["sticker"] });
    const r = box.st.race;
    assert.strictEqual(r.game, "sticker"); assert.deepStrictEqual(r.stage, { "1": "sticker", "2": "sticker" }, "첫 미니게임부터");
    const t = D.TYPES.find((x) => r.puzzleId.indexOf(x.key + "-") === 0), pieces = Array.isArray(t.pieces) ? t.pieces[0] : t.pieces;
    assert.strictEqual(r.pair.length, pieces === 2 ? 4 : 5, "조각 " + pieces + "개 -> 택배 수");
    room.raceStep("1", "sticker-done", 1); assert.strictEqual(box.st.race.stage["1"], "ubongo");
    // 3조각 문제로 직접 확인
    assert.deepStrictEqual(room._planByPieces("fragile-1"), { parcels: 5, first: 2, late: 2, lateFail: 1 });
    assert.deepStrictEqual(room._planByPieces("normal-1"), { parcels: 4, first: 2, late: 2, lateFail: 1 });
    room.destroy();
  }
  // 0b) 조각마다 반응형 미니게임: stage pieces -> piece-done 조각 수만큼 -> ubongo
  {
    const { room, box } = mk({ racePieceGames: true });
    const r = box.st.race;
    assert.deepStrictEqual(r.stage, { "1": "pieces", "2": "pieces" });
    assert.strictEqual(r.pieceGames.length, r.need); assert(r.need >= 2);
    for (let k = 1; k < r.pieceGames.length; k++) assert.notStrictEqual(r.pieceGames[k], r.pieceGames[k - 1], "같은 게임 연속 없음");
    room.raceStep("1", "ubongo-done", 1); assert.strictEqual(box.st.race.stage["1"], "pieces", "조각을 다 모으기 전엔 투입 불가");
    for (let k = 0; k < r.need; k++) room.raceStep("1", "piece-done", 1);
    assert.strictEqual(box.st.race.stage["1"], "ubongo"); assert.strictEqual(box.st.race.got["1"], r.need);
    room.raceStep("1", "piece-done", 1); assert.strictEqual(box.st.race.got["1"], r.need, "더 안 늘어남");
    room.raceStep("1", "ubongo-done", 1); assert.strictEqual(box.st.race.first, "1");
    room.destroy();
  }
  // 1) 몫: 1~2라운드 3개 중 2개, 3라운드부터 5개 중 3개. 나머지는 늦은 사람. (조각 표를 끄고 라운드 표로)
  {
    const { room, box } = mk({ raceConsolationMs: 300, racePickMs: 400, raceRevealMs: 50, raceGrantByPieces: null });
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
    assert(!box.st.delivery.doors.m205 && box.st.players["2"].invoices[0].bounces === 1, "5번 누르면 반송(다시 보낼 수 있음)");
    room.destroy();
  }
  // 4) 기본(2026-10-16): Ctrl/Shift+호실 = 시작, 5초 뒤 완료 / 팀 키로 남의 켜진 집 누름 = 안내만 / 보조키 없이 5번 = 반송 / 아파트는 엘리베이터 층
  {
    const { room, box } = mk({ deliveryMs: 3000, deliveryProgressMs: 400, deliveryElevMoveMs: 0 });
    room._endSecurePhase();
    box.st.players["1"].invoices = [{ id: "q1", catIdx: 0, unit: "m101", reward: 2500, deliveredRound: null }, { id: "q2", catIdx: 0, unit: "a201", reward: 2500, deliveredRound: null }];
    const last = () => box.st.delivery.ev[box.st.delivery.ev.length - 1].k;
    room.wallPress("1", "a201"); assert.strictEqual(last(), "noelev");
    room.wallPress("1", "m101"); assert(box.st.delivery.doors.m101);
    room.wallPress("2", "m101"); assert.strictEqual(last(), "taken"); assert.strictEqual(box.st.delivery.doors.m101.taps, 0, "팀 키로는 못 막음");
    for (let i = 0; i < 4; i++) room.wallPress(null, "m101");
    assert.strictEqual(box.st.delivery.doors.m101.taps, 4);
    room.wallPress(null, "m101"); assert(!box.st.delivery.doors.m101, "5번째에 반송(꺼짐)");
    assert.strictEqual(box.st.players["1"].invoices[0].bounces, 1); assert(!box.st.players["1"].invoices[0].returned, "반송돼도 다시 보낼 수 있다");
    room.wallPress("1", "m101"); assert(box.st.delivery.doors.m101, "다시 배송 시작");
    room.destroy();
  }
  // 5) 콤보: 아파트·맨션·주택 모두 배송 = 건물 콤보, 3종류 모두 배송 = 종류 콤보(SET_BONUS)
  {
    const { room, box } = mk({ deliveryMs: 3000, deliveryProgressMs: 100, deliveryElevMoveMs: 0, setBonus: D.SET_BONUS, setBonusKinds: 3 });
    room._endSecurePhase();
    box.st.players["1"].invoices = [
      { id: "c1", catIdx: 0, unit: "a101", reward: 1000, deliveredRound: null },
      { id: "c2", catIdx: 1, unit: "m101", reward: 1000, deliveredRound: null },
      { id: "c3", catIdx: 2, unit: "h1", reward: 1000, deliveredRound: null }];
    for (const u of ["a101", "m101", "h1"]) { room.wallPress("1", u); await sleep(250); }
    const doneEv = box.st.delivery.ev.filter((e) => e.k === "done");
    const last = doneEv[doneEv.length - 1];
    assert.strictEqual(last.combos.length, 2, "마지막 배송에서 콤보 두 개 동시 달성");
    await sleep(3000);
    assert.strictEqual(box.st.halfHistory[0].scores["1"], 3000 + D.SET_BONUS + D.COMBO_BUILDING_BONUS, "점수에 콤보 포함");
    room.destroy();
  }
  // 6) 건물별 방식: 맨션 = 팀 키 연타(계단), 주택 = 초인종 -> 문 열리면 한 번 더 (일찍 누르면 다시, 놓치면 닫힘)
  {
    const { room, box } = mk({ deliveryMs: 6000, deliveryProgressMs: 300, deliveryElevMoveMs: 0, deliveryModes: { apt: "wait", mansion: "climb", house: "bell" }, deliveryClimbSteps: { 1: 5, 2: 5 }, deliveryBellWaitMs: [300, 400], deliveryBellWindowMs: 300 });
    room._endSecurePhase();
    box.st.players["1"].invoices = [
      { id: "c1", catIdx: 0, unit: "m201", reward: 1000, deliveredRound: null },
      { id: "c2", catIdx: 1, unit: "h2", reward: 1000, deliveredRound: null }];
    const last = () => box.st.delivery.ev[box.st.delivery.ev.length - 1];
    room.wallPress("1", "m201");
    assert.strictEqual(box.st.delivery.doors.m201.steps, 1, "첫 누름 = 첫 계단");
    for (let i = 0; i < 3; i++) room.wallPress("1", "m201");
    assert.strictEqual(last().k, "step"); assert.strictEqual(last().steps, 4);
    await sleep(500); assert(box.st.delivery.doors.m201, "계단은 시간으로 안 끝남");
    room.wallPress("1", "m201"); assert.strictEqual(last().k, "done", "5번째 계단에 완료");
    // 주택: 일찍 누르면 다시 울림
    room.wallPress("1", "h2"); const open0 = box.st.delivery.doors.h2.openAt;
    await sleep(50); room.wallPress("1", "h2"); assert.strictEqual(last().k, "early"); assert(box.st.delivery.doors.h2.openAt >= Date.now() + 250, "다시 울림"); void open0;
    // 놓치면 닫힘(택배는 그대로)
    await sleep(900); assert(!box.st.delivery.doors.h2); assert(box.st.delivery.ev.some((e) => e.k === "missed")); assert.strictEqual(box.st.players["1"].invoices[1].deliveredRound, null);
    // 문 열렸을 때 누르면 완료
    room.wallPress("1", "h2"); const d2 = box.st.delivery.doors.h2;
    await sleep(d2.openAt - Date.now() + 40); room.wallPress("1", "h2");
    assert.strictEqual(last().k, "done"); assert.strictEqual(box.st.players["1"].invoices[1].deliveredRound, 1);
    // 막기는 그대로 (계단 오르는 중 그냥 5번)
    box.st.players["2"].invoices = [{ id: "z", catIdx: 0, unit: "m102", reward: 1000, deliveredRound: null }];
    room.wallPress("2", "m102"); for (let i = 0; i < 5; i++) room.wallPress(null, "m102");
    assert.strictEqual(last().k, "returned");
    room.destroy();
  }
  // 7) 같은 집 쟁탈 + 막기 보상
  {
    const { room, box } = mk({ deliveryMs: 4000, deliveryProgressMs: 150, deliveryElevMoveMs: 0, blockReward: 1000 });
    room._endSecurePhase();
    box.st.players["1"].invoices = [{ id: "a", catIdx: 0, unit: "h4", reward: 1000, deliveredRound: null }];
    box.st.players["2"].invoices = [{ id: "b", catIdx: 0, unit: "h4", reward: 1000, deliveredRound: null }, { id: "c", catIdx: 0, unit: "h5", reward: 1000, deliveredRound: null }];
    const last = () => box.st.delivery.ev[box.st.delivery.ev.length - 1];
    // 파랑이 h5 배송 -> 빨강이 막음 -> 빨강 +1000
    room.wallPress("2", "h5"); for (let i = 0; i < 5; i++) room.wallPress(null, "h5");
    assert.strictEqual(last().k, "returned"); assert.strictEqual(last().blocker, "1"); assert.strictEqual(box.st.players["1"].blocks, 1);
    // 빨강이 h4 먼저 -> 파랑 h4 선점당함
    room.wallPress("1", "h4"); await sleep(300);
    assert.strictEqual(last().k, "done"); assert.strictEqual(last().snatched, 1000);
    assert.strictEqual(box.st.players["2"].invoices[0].lost, true);
    room.wallPress("2", "h4"); assert.strictEqual(last().k, "wrong", "선점당한 집은 더 이상 내 택배 없음");
    await sleep(4000);
    const sc = box.st.halfHistory[0].scores;
    assert.strictEqual(sc["1"], 1000 + 1000, "배송 + 막기");
    room.destroy();
  }
  // 8) 쟁탈 주소 생성: 누가 들고 있는 집이 다시 나온다
  {
    const { room, box } = mk({ contestRate: 1 });
    box.st.players["1"].invoices.push({ id: "x", catIdx: 0, unit: "a301", reward: 1000, deliveredRound: null });
    room._planNewRound(9, { parcels: 3, first: 2 }, box.st.race.puzzleId);
    assert(box.st.race.pair.some((p) => p.unit === "a301"), "들고 있는 집이 주소로 나옴");
    assert.strictEqual(new Set(box.st.race.pair.map((p) => p.unit)).size, 3, "한 라운드 안에선 안 겹침");
    room.destroy();
  }
  // 9) 피버: 마지막 feverMs 동안 배송 금액 x2, 연속 배송 수
  {
    const { room, box } = mk({ deliveryMs: 1500, deliveryProgressMs: 100, deliveryElevMoveMs: 0, feverMs: 1000, feverMult: 2 });
    room._endSecurePhase();
    box.st.players["1"].invoices = [{ id: "a", catIdx: 0, unit: "h1", reward: 1000, deliveredRound: null }, { id: "b", catIdx: 0, unit: "h2", reward: 1000, deliveredRound: null }];
    room.wallPress("1", "h1"); await sleep(200);
    let ev = box.st.delivery.ev.filter((e) => e.k === "done").pop();
    assert.strictEqual(ev.fever, false); assert.strictEqual(ev.reward, 1000); assert.strictEqual(ev.streak, 1);
    await sleep(300); room.wallPress("1", "h2"); await sleep(350);
    ev = box.st.delivery.ev.filter((e) => e.k === "done").pop();
    assert.strictEqual(ev.fever, true); assert.strictEqual(ev.reward, 2000, "피버 2배"); assert.strictEqual(ev.streak, 2);
    room.wallPress("1", "m101"); assert.strictEqual(box.st.players["1"].streak, 0, "오배송이면 연속 끊김");
    await sleep(1200);
    assert.strictEqual(box.st.halfHistory[0].scores["1"], 3000 - 500);
    room.destroy();
  }
  // 10) 엘리베이터는 팀 키 없이도 (seat null)
  {
    const { room, box } = mk({ deliveryMs: 3000, deliveryElevMoveMs: 0 });
    room._endSecurePhase();
    const f0 = box.st.delivery.elev.floor;
    room.wallElevator(null, "up"); assert.strictEqual(box.st.delivery.elev.floor, f0 + 1, "팀 키 없이 위로");
    room.wallElevator(null, "down"); assert.strictEqual(box.st.delivery.elev.floor, f0);
    room.destroy();
  }
  // 11) 늦은 사람: 시간 안에 맞추면 남은 것 중 2개 직접 고름 / 못 맞추면 무작위 1개, 나머지는 사라짐
  {
    const { room, box } = mk({ raceConsolationMs: 300, racePickMs: 5000, raceRevealMs: 400 });
    room._planNewRound(1, { parcels: 5, first: 2, late: 2, lateFail: 1 }, "fragile-1");
    room.raceStep("1", "ubongo-done", 1);
    room.racePick("1", 0); room.racePick("1", 1);
    room.racePick("2", 2); assert.deepStrictEqual(box.st.race.picks["2"], [], "완성 전엔 못 고름");
    room.raceStep("2", "ubongo-done", 1);
    assert.strictEqual(box.st.race.status, "picking", "늦은 사람 고르는 중");
    room.racePick("2", 4); room.racePick("2", 2);
    assert.strictEqual(box.st.race.status, "reveal"); assert.deepStrictEqual(box.st.race.picks["2"], [4, 2]);
    assert.deepStrictEqual(box.st.race.discarded, [3], "남은 하나는 사라짐");
    await sleep(470);
    // 못 맞춤 -> 무작위 1개
    const r2 = box.st.race; assert.strictEqual(r2.round, 2);
    room._planNewRound(2, { parcels: 5, first: 2, late: 2, lateFail: 1 }, "fragile-1");
    room.raceStep("1", "ubongo-done", 2); room.racePick("1", 0); room.racePick("1", 1);
    await sleep(380);
    assert.strictEqual(box.st.race.picks["2"].length, 1, "무작위 1개"); assert.strictEqual(box.st.race.randomPick["2"], true);
    assert.strictEqual(box.st.race.discarded.length, 2);
    room.destroy();
  }
  // 12) 2조각(4개): 늦게라도 맞추면 남은 2개 다(고를 것 없음), 포기하면 바로 무작위 1개
  {
    const { room, box } = mk({ raceConsolationMs: 5000, racePickMs: 5000, raceRevealMs: 50 });
    room._planNewRound(1, { parcels: 4, first: 2, late: 2, lateFail: 1 }, "normal-1");
    room.raceStep("1", "ubongo-done", 1); room.racePick("1", 0); room.racePick("1", 3);
    room.raceStep("2", "ubongo-done", 1);
    assert.strictEqual(box.st.race.status, "reveal"); assert.strictEqual(box.st.race.picks["2"].length, 2);
    await sleep(120);
    room._planNewRound(2, { parcels: 4, first: 2, late: 2, lateFail: 1 }, "normal-1");
    room.raceStep("1", "ubongo-done", 2); room.racePick("1", 0); room.racePick("1", 1);
    room.raceStep("2", "give-up", 2);
    assert.strictEqual(box.st.race.status, "reveal", "포기하면 20초 안 기다림"); assert.strictEqual(box.st.race.picks["2"].length, 1);
    room.destroy();
  }
  // 13) 문마다 버튼 한 쌍: 팀 버튼으로 상대가 켠 문을 누르면 막기(누가 막았는지 앎), 내 문은 그대로 진행
  {
    const { room, box } = mk({ deliveryMs: 4000, deliveryProgressMs: 2000, deliveryElevMoveMs: 0, deliveryPairButtons: true, blockReward: 1000 });
    room._endSecurePhase();
    assert.strictEqual(box.st.wallRule.pair, true);
    box.st.players["1"].invoices = [{ id: "a", catIdx: 0, unit: "h3", reward: 1000, deliveredRound: null }];
    room.wallPress("1", "h3"); assert(box.st.delivery.doors.h3);
    const last = () => box.st.delivery.ev[box.st.delivery.ev.length - 1];
    room.wallPress("2", "h3"); assert.strictEqual(last().k, "tap", "파란 버튼으로 빨강이 켠 문 = 막기 1회"); assert.strictEqual(box.st.delivery.doors.h3.taps, 1);
    for (let i = 0; i < 4; i++) room.wallPress("2", "h3");
    assert.strictEqual(last().k, "returned"); assert.strictEqual(last().blocker, "2"); assert.strictEqual(box.st.players["2"].blocks, 1);
    room.wallPress("2", "h5"); assert.strictEqual(last().k, "wrong", "빈 집에 내 버튼 = 오배송 그대로");
    room.destroy();
  }
  console.log("test_wall OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
