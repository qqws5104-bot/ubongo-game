// 2026-10-14 확보 단계 레이스 라운드 서버 규칙 검증 -- GameRoom 직접 구동 (브라우저/WS 불필요)
//   - 확보 시작 = 라운드 1, 택배 3개(종류만 보임), 두 사람 모두 송장 붙이기부터
//   - 송장 -> 우봉고 -> 투입 순서만 인정 (건너뛰기 불가)
//   - 먼저 투입한 사람이 고르기, 고른 것만 그 사람 송장이 된다 (층·금액 그대로, 자기 자리 송장)
//   - 늦은 사람: 마감 안에 투입하면 남은 것 중 하나를 고름, 마감 지나면 못 가져감. 아무도 안 가져간 건 레일로 돌아감
//   - 안 고르면 RACE_PICK_MS 뒤 기본 금액이 비싼 종류 자동 선택
//   - 둘 다 포기 -> 아무도 못 가져감, 다음 라운드
//   - 결과(reveal) 뒤 자동으로 다음 라운드, 퍼즐은 RACE_PUZZLE_ORDER 순서
//   - 레이스 모드에선 예전 secureCell이 무시된다 / 확보 단계 종료 타이머가 레이스 타이머에 덮이지 않는다
"use strict";
const assert = require("assert");
const { GameRoom, scoreInvoice } = require("./game-room.js");
const { TYPES, RACE_PUZZLE_ORDER } = require("./game-data.js");

function log(...a) { console.log("[test-race]", ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 자동 선택은 기본이 꺼짐(RACE_AUTO_PICK = 0). 자동 선택 규칙도 함께 검증하려고 여기선 켠다 -- 꺼진 경우는 맨 아래에서 따로 확인.
const FAST = { racePickMs: 300, raceSecondMs: 500, raceRevealMs: 300, raceAutoPick: true, raceAutoPickMode: "best" };
function newRoom(rules) {
  const room = new GameRoom("RACE", () => {}, Object.assign({}, FAST, rules || {}));
  room.pickCourier("cookbang", "a"); room.pickCourier("cheonil", "b");
  room.setReady("1"); room.setReady("2");
  return room;
}
const race = (room) => room.state.race;
const finishBoth = (room, seat) => { room.raceStep(seat, "sticker-done"); room.raceStep(seat, "ubongo-done"); };

(async () => {
  let room = newRoom();
  assert.strictEqual(room.state.phase, "secure");
  let r = race(room);
  assert.ok(r && r.round === 1 && r.pair.length === 3, "라운드 1, 택배 3개");
  assert.deepStrictEqual(r.stage, { "1": "sticker", "2": "sticker" });
  assert.strictEqual(r.puzzleId, RACE_PUZZLE_ORDER[0]);
  r.pair.forEach((it) => { assert.ok(typeof it.reward === "number" && it.floorIdx >= 0 && it.floorIdx < 6); });
  log("확보 시작 -> 라운드 1, 택배 3개, 둘 다 송장 붙이기부터");

  room.secureCell("1", "normal-1");
  assert.strictEqual(room.state.players["1"].invoices.length, 0, "레이스 모드에선 secureCell 무시");

  room.raceStep("1", "ubongo-done");
  assert.strictEqual(r.stage["1"], "sticker", "송장 붙이기 전엔 우봉고 완료 불가");
  room.raceStep("1", "sticker-done");
  room.raceStep("2", "sticker-done");
  room.raceStep("1", "ubongo-done");
  assert.strictEqual(r.status, "picking"); assert.strictEqual(r.first, "1");
  log("송장 -> 우봉고 -> 투입 순서, 먼저 투입한 1번이 고르는 중");

  // 늦은 사람이 먼저 고르려 해도 안 됨, 1번이 고르기 전엔 2번은 못 고름
  room.raceStep("2", "ubongo-done");
  room.racePick("2", 0);
  assert.strictEqual(r.picks["2"], null, "1등이 고르기 전엔 2등은 못 고름");
  const chosen = r.pair[1];
  room.racePick("1", 1);
  assert.strictEqual(r.picks["1"], 1);
  const inv1 = room.state.players["1"].invoices[0];
  assert.strictEqual(r.invoiceIds["1"], inv1.id, "자기 자리 송장 id 기록");
  assert.strictEqual(inv1.catIdx, chosen.catIdx); assert.strictEqual(inv1.floorIdx, chosen.floorIdx); assert.strictEqual(inv1.reward, chosen.reward);
  assert.strictEqual(r.status, "picking", "2등이 남은 2개 중 고르는 중");
  room.racePick("2", 1);
  assert.strictEqual(r.picks["2"], null, "이미 가져간 택배는 못 고름");
  room.racePick("2", 2);
  assert.strictEqual(r.picks["2"], 2);
  assert.strictEqual(r.status, "reveal");
  assert.deepStrictEqual(r.discarded, [0]);
  const left = room.state.board.find((c) => c.id === r.pair[0].cellId);
  assert.ok(!left.taken, "아무도 안 가져간 택배는 레일로 돌아감");
  log("1등이 3개 중 하나 -> 자기 송장, 2등이 남은 2개 중 하나, 남은 1개는 레일로 돌아감");

  await sleep(450);
  r = race(room);
  assert.strictEqual(r.round, 2); assert.strictEqual(r.status, "playing");
  assert.strictEqual(r.puzzleId, RACE_PUZZLE_ORDER[1]);
  log("결과 뒤 자동으로 라운드 2, 퍼즐 순서대로");

  // 라운드 2: 1등 안 고르면 기본 금액 비싼 종류 자동, 2등 마감 초과 -> 못 가져감
  finishBoth(room, "2");
  room.raceStep("1", "sticker-done");
  const baseBest = r.pair.reduce((b, it, i) => (TYPES[it.catIdx].reward > TYPES[r.pair[b].catIdx].reward ? i : b), 0);
  await sleep(350);
  assert.strictEqual(r.picks["2"], baseBest, "안 고르면 기본 금액이 비싼 종류 자동");
  assert.strictEqual(r.status, "picking", "늦은 사람 마감 전엔 기다림");
  await sleep(250);
  assert.strictEqual(r.status, "reveal");
  assert.strictEqual(r.stage["1"], "out"); assert.strictEqual(r.picks["1"], null);
  room.raceStep("1", "ubongo-done");
  assert.strictEqual(room.state.players["1"].invoices.length, 1);
  log("1등이 안 고르면 기본 금액 비싼 종류 자동, 늦은 사람이 마감 넘기면 못 가져감");

  // 라운드 3: 2등이 투입했지만 안 고르면 자동
  await sleep(400);
  r = race(room);
  assert.strictEqual(r.round, 3);
  finishBoth(room, "1"); finishBoth(room, "2");
  room.racePick("1", 0);
  assert.ok(r.secondPickEndsAt, "2등 고르기 마감");
  await sleep(350);
  assert.notStrictEqual(r.picks["2"], null, "2등도 안 고르면 자동");
  assert.strictEqual(r.status, "reveal");
  log("2등도 마감 안에 안 고르면 자동");

  // 라운드 4: 둘 다 포기
  await sleep(400);
  r = race(room);
  assert.strictEqual(r.round, 4);
  room.raceStep("1", "give-up"); room.raceStep("2", "give-up");
  assert.strictEqual(r.status, "reveal");
  assert.strictEqual(r.discarded.length, 3);
  log("둘 다 포기 -> 아무도 못 가져가고 다음 라운드로");

  // 점수: 레이스로 얻은 송장도 기존 채점 그대로 (미배송이면 감점)
  assert.strictEqual(scoreInvoice(inv1), -TYPES[inv1.catIdx].penalty);

  // 확보 단계 종료 타이머가 레이스 타이머에 안 덮였는지: 짧은 확보 시간으로 확인
  room.destroy();
  room = newRoom();
  room.state.secureEndsAt = Date.now() + 300;
  room._scheduleAt(room.state.secureEndsAt, () => room._endSecurePhase());
  finishBoth(room, "1"); // 레이스 타이머가 걸림
  await sleep(500);
  assert.strictEqual(room.state.phase, "elevator", "확보 시간이 끝나면 레이스 중이어도 엘리베이터로");
  assert.strictEqual(room.state.race, null);
  log("확보 시간 종료 -> 레이스 중이어도 엘리베이터로 (타이머 분리)");

  // 택배가 다 떨어지면 결과를 보여 준 뒤 엘리베이터로
  room.destroy();
  room = newRoom();
  let rounds = 0;
  while (room.state.phase === "secure" && rounds < 30) {
    r = race(room);
    if (!r || r.status !== "playing") { await sleep(60); continue; }
    finishBoth(room, "1"); finishBoth(room, "2");
    room.racePick("1", 0);
    const rest = r.pair.map((_, i) => i).find((i) => i !== 0);
    if (rest !== undefined) room.racePick("2", rest);
    rounds++;
    await sleep(380);
  }
  assert.strictEqual(room.state.phase, "elevator", "17칸이 다 떨어지면 엘리베이터로");
  const total = room.state.players["1"].invoices.length + room.state.players["2"].invoices.length;
  assert.strictEqual(total, 17, "두 사람이 매 라운드 다 끝내면 17개가 전부 나뉜다");
  log("택배 17개가 다 떨어지면 엘리베이터로 (라운드 " + rounds + "번)");

  // 자동 선택 꺼짐(raceAutoPick:false): 고를 때까지 기다린다
  room.destroy();
  room = new GameRoom("NOAUTO", () => {}, { racePickMs: 300, raceSecondMs: 500, raceRevealMs: 300, raceAutoPick: false });
  room.pickCourier("cookbang", "a"); room.pickCourier("cheonil", "b"); room.setReady("1"); room.setReady("2");
  r = race(room);
  finishBoth(room, "1"); finishBoth(room, "2");
  assert.strictEqual(r.pickEndsAt, null, "자동 선택 꺼지면 고르기 마감 없음");
  await sleep(700);
  assert.strictEqual(r.status, "picking"); assert.strictEqual(r.picks["1"], null, "1등이 안 고르면 계속 기다림");
  room.racePick("1", 0);
  await sleep(700);
  assert.strictEqual(r.status, "picking"); assert.strictEqual(r.picks["2"], null, "2등도 고를 때까지 기다림");
  room.racePick("2", 1);
  assert.strictEqual(r.status, "reveal");
  log("raceAutoPick:false: 1등·2등 모두 직접 고를 때까지 넘어가지 않음");
  room.destroy();

  // 기본값(2026-10-14): 투입 순간부터 RACE_PICK_MS(20초) 안에 고름, 지나면 남은 것 중 무작위
  {
    const { RACE_PICK_MS, RACE_AUTO_PICK, RACE_AUTO_PICK_MODE } = require("./game-data.js");
    assert.strictEqual(RACE_PICK_MS, 20000); assert.strictEqual(RACE_AUTO_PICK, 1); assert.strictEqual(RACE_AUTO_PICK_MODE, "random");
    const seenPick = new Set();
    for (let k = 0; k < 24; k++) {
      const rm = new GameRoom("RND" + k, () => {}, { racePickMs: 120, raceSecondMs: 400, raceRevealMs: 5000 });
      rm.pickCourier("cookbang", "a"); rm.pickCourier("cheonil", "b"); rm.setReady("1"); rm.setReady("2");
      const rr = race(rm);
      const t0 = Date.now();
      finishBoth(rm, "1");
      assert.ok(rr.pickEndsAt >= t0 + 120 && rr.pickEndsAt <= Date.now() + 120, "1등 마감 = 투입 순간 + RACE_PICK_MS");
      await sleep(200);
      assert.notStrictEqual(rr.picks["1"], null, "마감 지나면 자동으로 골라짐");
      seenPick.add(rr.picks["1"]);
      rm.destroy();
    }
    assert.ok(seenPick.size >= 2, "자동 선택은 무작위 (여러 칸이 나와야 함): " + [...seenPick]);
    log("기본: 투입 후 20초 안에 고르기, 안 고르면 무작위 (24번 중 " + seenPick.size + "가지 칸)");
  }

  // 예전 방식 플래그
  const legacy = new GameRoom("L", () => {}, { raceMode: false });
  legacy.pickCourier("cookbang", "a"); legacy.pickCourier("cheonil", "b"); legacy.setReady("1"); legacy.setReady("2");
  assert.strictEqual(legacy.state.race, null);
  legacy.secureCell("1", "normal-1");
  assert.strictEqual(legacy.state.players["1"].invoices.length, 1, "raceMode:false면 예전 확보 그대로");
  legacy.destroy();
  log("raceMode:false -> 예전 확보 방식 그대로");

  log("ALL CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
