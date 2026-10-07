// Shared game-economy constants + board layout. Required by both server.js (authoritative
// reducers) and build_client.py (embedded verbatim into the client bundle as JSON), so the
// two sides can never drift apart the way separately-maintained copies eventually do.
"use strict";

// 2026-08-27 개편: "신선·냉동 택배" 폐지, "확정 층수 택배"(6칸, B1~5F 각 1개씩 고정) 신설.
// reward/penalty는 이제 추상 점수가 아니라 원(KRW) 단위 실제 금액이다.
// count: 이 종류가 보드에서 차지하는 칸 수 (기존엔 전 종류 고정 5칸이었으나 이제 종류별로 다름 -- 총 21칸).
// pieces: 우봉고 퍼즐 조각 개수 표시용 숫자일 뿐, 보드 칸 수(count)와는 무관.
// fixedFloor: true인 종류는 각 칸의 num(0..count-1)이 곧 FLOORS의 인덱스로 고정된다 (무작위 배정 안 함).
// 표시 순서는 이 배열 순서 그대로 보드에 반영된다 (2026-08-27: 확정 층수 택배를 맨 아래로 이동,
// 깨지기 쉬운 택배는 주황+흰 글씨 대신 연두+검은 글씨로 -- 주황 배경에 흰 글씨만 유독 튀어서 변경).
const TYPES = [
  { key: "normal", name: "일반택배", count: 5, pieces: 2, reward: 2500, penalty: 1000,
    color: "#C9A576", ink: "#16233F" },
  { key: "fragile", name: "깨지기 쉬운 택배", count: 5, pieces: 3, reward: 5000, penalty: 2500,
    color: "#C7E29A", ink: "#16233F" },
  { key: "valuable", name: "귀중품", count: 5, pieces: 4, reward: 10000, penalty: 5000,
    color: "#F0B84A", ink: "#16233F" },
  { key: "fixed-floor", name: "확정 층수 택배", count: 6, pieces: 3, fixedFloor: true, reward: 3000, penalty: 2500,
    color: "#6DBBFD", ink: "#16233F" },
];

// 2026-08-27 신설: 좌석 선택 화면에서 "플레이어 1/2" 대신 고르는 가상 택배사 5종 (사용자 요청 --
// 실제 택배사 로고를 흉내내면 상표권 문제가 있어서, 완전히 새로 지어낸 가상 브랜드로 대체했다.
// 자세한 배경은 HANDOVER.md 3.6 참고). 5개 중 2개만 실제로 쓰이며(플레이어 수만큼), 한쪽 좌석이
// 고른 건 다른 좌석이 못 고른다 -- game-room.js의 pickCourier() 참고. 아이콘(SVG)은 순수 표시용이라
// 여기 안 두고 build_client.py의 COURIER_ICONS에 key 순서 맞춰 따로 둔다.
// 2026-08-28 리스킨: 사용자가 새 로고/이름 세트를 제공. 이 중 "한진택배"는 실제 택배회사명과
// 동일해 위 상표권 원칙(완전 창작 가상 브랜드)에 어긋난다고 판단, 확인 결과 말장난("한짐 가득
// 싣습니다")은 살리되 이름만 "한짐택배"로 바꿔서 실제 브랜드명과 겹치지 않게 했다. 나머지 4개는
// 실제 브랜드와 무관한 창작명이라 그대로 사용.
const COURIERS = [
  { key: "cookbang", name: "쿡방", color: "#D9552E" },
  { key: "cheonil", name: "천일배송", color: "#7A2333" },
  { key: "hanjim", name: "한짐택배", color: "#1E4C86" },
  { key: "mz", name: "MZ로지스틱스", color: "#2F9E6E" },
  { key: "tongan", name: "우체통안", color: "#C23B3B" },
];

const FLOORS = ["B1", "1F", "2F", "3F", "4F", "5F"];
// Single-digit room slot within a floor; the client combines this with the floor to display a
// realistic-looking room code like "401호" (4F, room 1) or "B03호" (B1, room 3) -- see roomCode()
// in build_client.py's APP_JS_TEMPLATE.
const ROOMS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const CELLS = [];
TYPES.forEach((t, catIdx) => {
  for (let num = 0; num < t.count; num++) {
    CELLS.push({ id: `${t.key}-${num + 1}`, catIdx, num });
  }
});

const START_FLOOR_IDX = 1; // 1F
const ELEVATOR_ROUNDS = 5;
const SECURE_PHASE_MS = 3 * 60 * 1000;
const VOTE_MS = 5000; // 엘리베이터 이동 라운드 길이 (기존과 동일)

// ---- 2026-08-27 신규 상수 ----
// 우선 택배 -- 엘리베이터의 각 라운드 게이트(idle/result)에서 매 라운드 새로 지정한다(1인당 1개,
// 그 라운드 안에 배송 성공해야만 적용, 게임 시작 전 1회가 아님 -- game-room.js의 el.priorityPick
// 참고). 배송 성공하면 점수 2배.
const PRIORITY_MULTIPLIER = 2;
// 같은 층에 배송 대기 중인 내 택배가 2개 이상일 때, 어느 걸 먼저 보낼지 고르는 시간(안 고르면 무작위).
// 2026-08-27: 5초 -> 10초로 늘림(사용자 요청).
const SAME_FLOOR_CHOICE_MS = 10000;
// 전반/후반 두 번 연속 진행, 점수는 두 번의 합산.
const HALVES = 2;
// 후반 전용: 매 라운드 이동(voting) 시작 전, 택배도둑을 놓을지 말지 따로 주어지는 시간
// (2026-08-27 신설 -- 원래는 idle/voting 중 아무 때나 놓을 수 있었는데, 별도의 전용 시간으로 분리).
const THIEF_PLACE_MS = 5000;

module.exports = {
  TYPES, COURIERS, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
  PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS,
};
