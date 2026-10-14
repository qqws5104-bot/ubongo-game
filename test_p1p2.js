// 2026-10-13 개선 1단계(개선명세 P1 + P2) 서버 규칙 검증 -- GameRoom 직접 구동, 브라우저/WS 불필요. 기본 규칙(game-data.js) 그대로.
//   P1-1 층별 배송비: 송장 reward = 종류 금액 x FLOOR_REWARD_MULT[층], 성공 점수/우선 2배에 반영, 감점은 그대로
//   P1-2 시작 층: START_FLOOR_CHOICES 중 하나 (하프마다 다시 뽑음)
//   P2-1 결과 자동 진행: result에서 스페이스 없이 RESULT_AUTO_ADVANCE_MS 뒤 다음 라운드/하프 종료, 둘 다 스페이스면 즉시
//   P2-2 후반 우선 지정 + 도둑 배치가 한 창: thief 상태 없이 priority 창에서 배치, 확정해야 닫힘, 도둑은 다음 라운드부터 작동
//   P2-3 같은 층 자동 선택: choosing 상태 없이 우선 지정 > 비싼 것 > 먼저 확보한 것
"use strict";
const assert = require("assert");
const { GameRoom, scoreInvoice, rewardFor } = require("./game-room.js");
const {
  TYPES, FLOORS, FLOOR_REWARD_MULT, START_FLOOR_CHOICES, RESULT_AUTO_ADVANCE_MS, ELEVATOR_ROUNDS, PRIORITY_MULTIPLIER,
} = require("./game-data.js");

function log(...a) { console.log("[test-p1p2]", ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (room) => room.state.elevator;
const catIdx = (key) => TYPES.findIndex((t) => t.key === key);

// 2026-10-14: 기본값은 층 배율 끔(전부 1.0, 사용자 결정). 여기서는 배율 기능 자체를 켜고 검사한다.
const P1_MULT = [0.7, 1.0, 1.3, 1.3, 1.0, 0.7];
function newRoom() {
  const room = new GameRoom("TEST", () => {}, { raceMode: false, floorRewardMult: P1_MULT }); // 확보는 예전 방식으로 칸을 직접 지정 (레이스는 test_race.js)
  room.pickCourier("cookbang", "clientA");
  room.pickCourier("cheonil", "clientB");
  room.setReady("1"); room.setReady("2");
  return room;
}
// 엘리베이터를 원하는 층으로 (voting 중에만). 1클릭 = 1칸 규칙 그대로 사용.
function moveTo(room, target) {
  let guard = 20;
  while (el(room).floorIdx !== target && guard-- > 0) room.vote("1", el(room).floorIdx < target ? "up" : "down");
  assert.strictEqual(el(room).floorIdx, target);
}
const confirmBoth = (room) => { room.confirmPriority("1"); room.confirmPriority("2"); };

(async () => {
  // ---------- P1-1: 배율 값 ----------
  assert.ok(FLOOR_REWARD_MULT.every((m) => m === 1), "기본값은 층 배율 끔 (2026-10-14)");
  assert.strictEqual(P1_MULT.length, FLOORS.length, "배율은 층마다 하나");
  assert.ok(P1_MULT[0] < P1_MULT[2] && P1_MULT[5] < P1_MULT[3], "끝층이 가운데 층보다 싸야 한다");
  const ff = catIdx("fixed-floor");
  for (let f = 0; f < FLOORS.length; f++) {
    assert.strictEqual(rewardFor(ff, f, P1_MULT), Math.round(TYPES[ff].reward * P1_MULT[f]));
  }
  log("배율:", FLOORS.map((f, i) => f + " x" + P1_MULT[i]).join(", "));

  // ---------- P1-2: 시작 층 ----------
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(new GameRoom("S", () => {}).state.elevator.floorIdx);
  assert.ok([...seen].every((f) => START_FLOOR_CHOICES.includes(f)), "시작 층은 START_FLOOR_CHOICES 안에서만");
  if (START_FLOOR_CHOICES.length > 1) assert.strictEqual(seen.size, START_FLOOR_CHOICES.length, "여러 후보가 실제로 섞여 나온다");
  log("시작 층 후보:", [...seen].sort().map((f) => FLOORS[f]).join("/"));

  // ---------- 전반: 송장 reward, 결과 자동 진행, 같은 층 자동 선택 ----------
  let room = newRoom();
  // 확정 층수 택배는 칸 num이 곧 층. B1(0), 2F(2)를 1번이, 3F(3)를 2번이 확보.
  room.secureCell("1", "fixed-floor-1"); // B1
  room.secureCell("1", "fixed-floor-3"); // 2F
  room.secureCell("2", "fixed-floor-4"); // 3F
  const p1 = room.state.players["1"].invoices;
  assert.strictEqual(p1[0].floorIdx, 0); assert.strictEqual(p1[1].floorIdx, 2);
  assert.strictEqual(p1[0].reward, Math.round(TYPES[ff].reward * P1_MULT[0]), "B1 송장 금액에 배율 적용");
  assert.strictEqual(p1[1].reward, Math.round(TYPES[ff].reward * P1_MULT[2]), "2F 송장 금액에 배율 적용");
  assert.ok(p1[0].reward < p1[1].reward, "같은 종류라도 B1이 2F보다 싸다");
  // 일반 택배(층 무작위)도 송장마다 reward가 층에 맞게 들어간다
  room.secureCell("2", "normal-1");
  const n = room.state.players["2"].invoices[1];
  assert.strictEqual(n.reward, Math.round(TYPES[n.catIdx].reward * P1_MULT[n.floorIdx]));
  log("송장 금액에 층 배율이 박힌다 (B1", p1[0].reward, "/ 2F", p1[1].reward, ")");

  room._endSecurePhase();
  assert.ok(START_FLOOR_CHOICES.includes(el(room).floorIdx), "하프 시작 층");
  room.setElevatorReady("1"); room.setElevatorReady("2"); // idle 게이트(1라운드 전)는 그대로 스페이스
  assert.strictEqual(el(room).state, "priority");
  room.setPriorityPick("1", p1[1].id); // 2F 택배 우선 지정
  confirmBoth(room);
  assert.strictEqual(el(room).state, "voting", "전반: 둘 다 확정 -> voting");
  moveTo(room, 2);
  room._resolveRound();
  assert.strictEqual(el(room).state, "result");
  assert.strictEqual(p1[1].deliveredRound, 1);
  assert.strictEqual(scoreInvoice(p1[1]), p1[1].reward * PRIORITY_MULTIPLIER, "우선 2배는 층 배율 적용된 금액 기준");
  assert.ok(el(room).resultEndsAt && el(room).resultEndsAt - Date.now() <= RESULT_AUTO_ADVANCE_MS, "결과 자동 진행 시각이 잡힌다");
  log("2F 우선 배송 점수", scoreInvoice(p1[1]), "= reward x2");

  // 스페이스 없이 자동으로 다음 라운드
  await sleep(RESULT_AUTO_ADVANCE_MS + 300);
  assert.strictEqual(el(room).round, 2, "결과 화면이 자동으로 다음 라운드로 넘어감");
  assert.strictEqual(el(room).state, "priority");
  assert.strictEqual(el(room).resultEndsAt, null);
  log("결과 화면", RESULT_AUTO_ADVANCE_MS, "ms 뒤 자동 진행 OK");

  // 미배송 감점은 배율과 무관
  assert.strictEqual(scoreInvoice(p1[0]), -TYPES[ff].penalty, "미배송 감점은 층과 무관");

  // 둘 다 스페이스 -> 자동 시각 전에 즉시 진행
  confirmBoth(room);
  room._resolveRound();
  assert.strictEqual(el(room).state, "result");
  room.setElevatorReady("1"); room.setElevatorReady("2");
  assert.strictEqual(el(room).round, 3, "둘 다 스페이스면 즉시 진행");
  log("둘 다 스페이스 -> 즉시 진행 OK");

  // ---------- 같은 층 자동 선택 ----------
  room = newRoom();
  // 1번 플레이어가 같은 층(2F)에 일반 + 귀중품을 갖도록 보정 (층 무작위라 직접 맞춘다)
  room.secureCell("1", "normal-1"); room.secureCell("1", "valuable-1"); room.secureCell("1", "normal-2");
  const inv = room.state.players["1"].invoices;
  inv.forEach((v) => { v.floorIdx = 2; v.reward = rewardFor(v.catIdx, 2, FLOOR_REWARD_MULT); });
  room._endSecurePhase();
  room.setElevatorReady("1"); room.setElevatorReady("2");
  room.confirmPriority("1"); room.confirmPriority("2");
  moveTo(room, 2);
  room._resolveRound();
  assert.notStrictEqual(el(room).state, "choosing", "선택 창 없이 바로 결과");
  assert.strictEqual(el(room).state, "result");
  const deliveredNow = inv.filter((v) => v.deliveredRound === 1);
  assert.strictEqual(deliveredNow.length, 1, "한 층 방문에 1인당 1개 배송은 그대로");
  assert.strictEqual(TYPES[deliveredNow[0].catIdx].key, "valuable", "우선 지정 없으면 비싼 것(귀중품) 먼저");
  // 다음 라운드: 일반 두 개 중 우선 지정한 나중 것이 먼저
  room.setElevatorReady("1"); room.setElevatorReady("2");
  const later = inv.find((v) => v.acquiredSeq === 3);
  room.setPriorityPick("1", later.id);
  confirmBoth(room);
  room._resolveRound(); // 아직 2F
  assert.strictEqual(later.deliveredRound, 2, "우선 지정한 것이 금액 같은 다른 것보다 먼저");
  log("같은 층 자동 선택: 귀중품 먼저, 그다음 우선 지정한 것 먼저 OK");

  // ---------- 후반: 우선 지정 + 도둑 한 창 ----------
  room = newRoom();
  room._endSecurePhase();
  room.state.half = 2; // 후반 흐름만 검증 (하프 전환 자체는 기존 테스트가 검증)
  room.state.elevator.floorIdx = 2;
  // 2번이 3F 택배, 1번이 B1 택배
  room.state.phase = "elevator";
  room.state.players["2"].invoices.push({ id: "inv-2-1", catIdx: ff, floorIdx: 3, room: "1", acquiredSeq: 1, reward: rewardFor(ff, 3, FLOOR_REWARD_MULT), deliveredRound: null, stolen: false, deliveredWasPriority: false });
  room.state.players["1"].invoices.push({ id: "inv-1-1", catIdx: ff, floorIdx: 0, room: "1", acquiredSeq: 1, reward: rewardFor(ff, 0, FLOOR_REWARD_MULT), deliveredRound: null, stolen: false, deliveredWasPriority: false });
  room.setElevatorReady("1"); room.setElevatorReady("2");
  assert.strictEqual(el(room).state, "priority", "후반 R1: 합쳐진 창");
  room.placeThief("1", 3); // 1번이 3F에 도둑
  assert.strictEqual(el(room).thieves.placedThisRound["1"], 3);
  assert.strictEqual(el(room).state, "priority", "도둑을 놓아도 창은 안 닫힘");
  room.placeThief("1", 4);
  assert.strictEqual(el(room).thieves.placedThisRound["1"], 3, "라운드당 1개");
  room.confirmPriority("1");
  assert.strictEqual(el(room).state, "priority", "한 명만 확정하면 안 닫힘");
  room.placeThief("2", 0);
  room.confirmPriority("2");
  assert.strictEqual(el(room).state, "voting", "둘 다 확정 -> thief 상태 없이 곧장 voting");
  assert.strictEqual(el(room).thieves.usedThisHalf["1"], 1);
  assert.strictEqual(el(room).thieves.active.length, 0, "놓은 라운드에는 아직 작동 안 함");
  moveTo(room, 2); room._resolveRound();
  await sleep(RESULT_AUTO_ADVANCE_MS + 300);
  assert.strictEqual(el(room).round, 2);
  assert.strictEqual(el(room).state, "priority");
  assert.deepStrictEqual(el(room).thieves.active.map((t) => t.seat + ":" + t.floorIdx).sort(), ["1:3", "2:0"], "R1 배치분이 R2에 작동");
  // 2번은 이번 라운드 도둑 안 놓고 확정 -> 넘김 처리, 한도 소진 안 됨
  room.confirmPriority("2");
  assert.strictEqual(el(room).thieves.skipped["2"], true);
  assert.strictEqual(el(room).thieves.usedThisHalf["2"], 1);
  room.confirmPriority("1");
  moveTo(room, 3); room._resolveRound();
  const stolenInv = room.state.players["2"].invoices[0];
  assert.strictEqual(stolenInv.stolen, true, "3F 도착 -> 1번이 놓은 도둑이 2번 택배를 가로챔");
  assert.strictEqual(scoreInvoice(stolenInv), -TYPES[ff].penalty);
  log("후반: 우선 지정 + 도둑 한 창, 확정으로 진행, 도둑은 다음 라운드 작동 OK");

  // 마지막 라운드엔 도둑 배치 불가 (자동 넘김)
  el(room).round = ELEVATOR_ROUNDS - 1;
  room.setElevatorReady("1"); room.setElevatorReady("2");
  assert.strictEqual(el(room).round, ELEVATOR_ROUNDS);
  room.placeThief("1", 1);
  assert.strictEqual(el(room).thieves.placedThisRound["1"], null, "마지막 라운드엔 배치 무시");
  assert.ok(el(room).thieves.skipped["1"] && el(room).thieves.skipped["2"]);
  log("마지막 라운드 도둑 배치 불가 OK");

  // 마지막 라운드 결과 -> 자동으로 하프 종료
  if (el(room).state === "priority") confirmBoth(room);
  room._resolveRound();
  await sleep(RESULT_AUTO_ADVANCE_MS + 300);
  assert.strictEqual(room.state.phase, "end", "마지막 라운드 결과도 자동으로 끝까지 진행");
  log("마지막 라운드 결과 -> 자동 종료 OK");

  log("ALL CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
