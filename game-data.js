// Shared game-economy constants + board layout. Required by both server.js (authoritative
// reducers) and build_client.py (embedded verbatim into the client bundle as JSON), so the
// two sides can never drift apart the way separately-maintained copies eventually do.
"use strict";

// 2026-08-27 개편: "신선·냉동 택배" 폐지, "확정 층수 택배"(6칸, B1~5F 각 1개씩 고정) 신설.
// reward/penalty는 이제 추상 점수가 아니라 원(KRW) 단위 실제 금액이다.
// count: 이 종류가 보드에서 차지하는 칸 수. (2026-10-06: 전 종류 6칸으로 통일 -- 보드 총 24칸, 전반/후반 각각.
//   그 전엔 5/5/5/6 = 21칸이었다. 확정 층수 택배는 층(B1~5F)이 6개라 원래도 6칸이다.)
// pieces: 우봉고 퍼즐의 색(조각) 개수 표시용 숫자일 뿐, 보드 칸 수(count)와는 무관. 숫자 하나 또는 [전반, 후반] 배열.
//   (귀중품만 우봉고를 쓰고, 어떤 퍼즐 이미지를 싣는지는 build_client.py의 PUZZLE_SRC가 정한다 -- 이 숫자와 맞춰야 한다.)
// mini / miniLevel: (2026-10-06) 이 종류의 칸을 확보할 때 하는 미니게임과 난이도(1~3). miniLevel은 숫자 하나 또는
//   [전반, 후반] 배열 (2026-10-06: 후반이 더 어렵다 -- 일반 6->8키, 깨지기 8->10개, 확정 층수 박스 5->7개/송장 3->4장). minigames.js의
//   "pack"(박스 포장) / "inspect"(불량 검수) / "sticker"(송장 붙이기) / "map"(지도 배달 -- 2026-10-07 귀중품의 우봉고를 대체). null이면 기존 우봉고(퍼즐 이미지 +
//   "완료" 버튼) 그대로. 서버는 이 두 필드를 쓰지 않는다 -- 클라이언트(build_client.py)만 읽는다.
//   난이도/배치를 바꾸는 곳은 여기 한 군데다. 보상(reward)과 같이 봐야 하는 값(HANDOVER 9.4).
// fixedFloor: true인 종류는 각 칸의 num(0..count-1)이 곧 FLOORS의 인덱스로 고정된다 (무작위 배정 안 함).
// 표시 순서는 이 배열 순서 그대로 보드에 반영된다 (2026-08-27: 확정 층수 택배를 맨 아래로 이동,
// 깨지기 쉬운 택배는 주황+흰 글씨 대신 연두+검은 글씨로 -- 주황 배경에 흰 글씨만 유독 튀어서 변경).
// 2026-10-08 실물 우봉고 복귀(사용자: "다 재미가 없다 -- 조각을 직접 돌려 끼우고, 시간에 쫓기고, 완성되는 장면이 우봉고의 재미",
//   확인: 실물 우봉고 조각). 네 종류 모두 mini: null = 퍼즐 이미지 + 실물 조각 + "완료" 버튼. 조각(색) 수는 2~4개가 적당하다는
//   사용자 지정: 일반 2 / 깨지기 3 / 확정 층수 3 / 귀중품 4. 디지털 미니게임(minigames.js의 pack/inspect/sticker/map)은 코드와 브랜치
//   digital-minigames에 그대로 있고, 이 필드에 그 이름을 적으면 그 종류만 다시 디지털 게임으로 돌아간다 (퍼즐 이미지는 build_client.py의 PUZZLE_SRC).
// 2026-10-07 희소성 조정(사용자 요청: "택배를 너무 쉽게 얻어서 우봉고 할 때보다 재미없다" -> "희소성 + 미니게임 난이도 업 둘 다"):
//   일반 6->4, 깨지기 6->4, 귀중품 6->3 (확정 층수는 층이 6개라 6 그대로) = 24 -> 17칸. 한 하프에 한 사람이 배송할 수 있는 건
//   라운드 7번 x 1장 이하(실제론 3~5장)라서, 24칸은 두 사람이 다 가져도 남는 공급이었다. 비싼 종류일수록 적게 둔다.
//   (이전엔 2026-10-06 사용자 요청으로 전 종류 6칸 통일이었다.)
const TYPES = [
  { key: "normal", name: "일반택배", count: 4, pieces: 2, reward: 2500, penalty: 1000,
    color: "#C9A576", ink: "#16233F", mini: null, miniLevel: [2, 3] },
  { key: "fragile", name: "깨지기 쉬운 택배", count: 4, pieces: 3, reward: 5000, penalty: 2500,
    color: "#C7E29A", ink: "#16233F", mini: null, miniLevel: [2, 3] },
  { key: "valuable", name: "귀중품", count: 3, pieces: 4, reward: 10000, penalty: 5000,
    color: "#F0B84A", ink: "#16233F", mini: null, miniLevel: [2, 3] },
  { key: "fixed-floor", name: "확정 층수 택배", count: 6, pieces: 3, fixedFloor: true, reward: 3000, penalty: 2500,
    color: "#6DBBFD", ink: "#16233F", mini: null, miniLevel: [2, 3] },
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
const ELEVATOR_ROUNDS = 7; // 전/후반 각각 이 라운드 수 (2026-10-07: 5 -> 7)
const SECURE_PHASE_MS = 3 * 60 * 1000;
const VOTE_MS = 5000; // 엘리베이터 이동 라운드 길이 (기존과 동일)

// ---- 2026-08-27 신규 상수 ----
// 우선 택배 -- 매 라운드 시작 전 전용 시간("priority" 상태, PRIORITY_PICK_MS)에 새로 지정한다(1인당 1개,
// 그 라운드 안에 배송 성공해야만 적용, 게임 시작 전 1회가 아님 -- game-room.js의 el.priorityPick
// 참고). 배송 성공하면 점수 2배.
const PRIORITY_MULTIPLIER = 2;
// 2026-10-15 (사용자 결정): 종류 모으기 보너스. 한 하프에서 서로 다른 종류 SET_BONUS_KINDS가지 이상을 "배송 성공"하면 그 하프 점수에 +SET_BONUS.
//   (도난/미배송은 안 셈) 고르기에서 "비싼 것" 말고도 "세트 완성"·"상대 세트 막기"라는 이유가 생기게. SET_BONUS = 0이면 끔.
// 2026-10-15 (사용자 요청): 게임 시작 전 튜토리얼(진행 방법) 장 수. 둘 다 준비하면 튜토리얼 -> 각자 Space로 넘기고 둘 다 끝까지 보면 시작.
//   둘 다 "건너뛰기"를 누르면 바로 시작. 서버 규칙 tutorial(server.js가 켬, 환경변수 TUTORIAL=0이면 끔)일 때만.
const TUTORIAL_PAGES = 6;
const SET_BONUS = 5000;
const SET_BONUS_KINDS = 3;
// 같은 층에 배송 대기 중인 내 택배가 2개 이상일 때, 어느 걸 먼저 보낼지 고르는 시간(안 고르면 무작위).
// 2026-08-27: 5초 -> 10초로 늘림(사용자 요청).
const SAME_FLOOR_CHOICE_MS = 10000;
// 전반/후반 두 번 연속 진행, 점수는 두 번의 합산.
const HALVES = 2;
// 후반 전용: 매 라운드 이동(voting) 시작 전, 택배도둑을 놓을지 말지 따로 주어지는 시간
// (2026-08-27 신설 -- 원래는 idle/voting 중 아무 때나 놓을 수 있었는데, 별도의 전용 시간으로 분리).
const THIEF_PLACE_MS = 5000;
// 후반 전체에서 1인당 택배도둑을 놓을 수 있는 횟수 (2026-10-07: 1 -> 2). 라운드당 최대 1개는 그대로.
const THIEF_PER_HALF = 2;
// 우선 택배 지정 전용 시간 (2026-10-06 신설, 사용자 요청: "우선택배 지정 시간을 10초, 타이머 있게").
// 라운드 게이트(idle/result)에서 둘 다 스페이스바를 누르면 이 창이 먼저 열리고(후반이면 그 다음 택배도둑 창),
// 둘 다 "확정"하면 10초를 다 기다리지 않고 곧장 다음으로 넘어간다 -- thief 창과 같은 조기-진행 패턴.
const PRIORITY_PICK_MS = 10000;

// ---- 2026-10-13 체키용 개선 1단계 (개선명세 P1 + P2) ----
// 테스트 피드백: "B1·5F가 너무 쉽다"(끝에서 더 밀어도 그 층에 멈추니 한쪽으로 세게 누르면 끝층 배송이 확정됨),
// 라운드 사이 대기가 길다. 엘리베이터(직선) 방향 싸움은 그대로 두고 숫자/흐름만 바꾼다.
// 아래 값은 모두 시작값(제안값)이다 -- 플레이 테스트 로그를 보고 조정할 것. 0으로 두면 예전 동작으로 돌아가는 플래그도 있다.
//
// P1-1 층별 배송비 배율 (FLOORS 순서: B1, 1F, 2F, 3F, 4F, 5F). 끝층은 쉽지만 싸고, 가운데 층은 비싸지만 격전지.
//   송장이 만들어질 때(확보 순간) 층이 정해지므로, 그때 inv.reward = round(TYPES[].reward x 배율)로 송장에 박아 둔다.
//   미배송/도난 감점(penalty)은 층과 무관하게 그대로. 전부 1.0이면 예전과 같다.
// 2026-10-14 (사용자 결정: "층별 비용을 적으면 어려워진다"): 일단 끔(전부 1.0) -- 화면의 배율 배지·층별 금액도 같이 사라진다.
//   다시 켜려면 [0.7, 1.0, 1.3, 1.3, 1.0, 0.7].
const FLOOR_REWARD_MULT = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
// P1-2 엘리베이터 시작 층: 하프마다 이 목록에서 무작위 (FLOORS 인덱스. 2 = 2F, 3 = 3F). 고정 시작층 공짜 배송 방지.
//   [1]로 두면 예전처럼 항상 1F에서 시작.
const START_FLOOR_CHOICES = [2, 3];
// 2026-10-14 (사용자 결정, 실패의 재미): 엘리베이터 "덜컹". 이동 시간 동안 두 사람이 모두 눌렀는데 엘리베이터가 시작 층 그대로면
//   (팽팽하게 비김) 결과 직전에 무작위로 한 층 떨어지거나 튀어 오른다(맨 아래/맨 위에선 가능한 쪽으로). 배송은 덜컹한 뒤의 층에서.
//   아무도 안 눌렀거나 한 사람만 눌렀으면 덜컹하지 않는다(둘 다 그 층을 원한 것일 수 있으니까). 0이면 끔.
const ELEVATOR_JOLT = 1;
// P2-1 라운드 결과 화면 자동 진행(ms). 결과를 이만큼 보여준 뒤 다음 라운드(또는 하프 종료)로 넘어간다.
//   둘 다 스페이스를 누르면 더 일찍 넘어간다. 0이면 예전처럼 "둘 다 스페이스"를 눌러야만 넘어간다.
const RESULT_AUTO_ADVANCE_MS = 3000;
// P2-2 후반의 우선 택배 지정(10초)과 택배도둑 배치(5초)를 한 화면·한 창(PRIORITY_PICK_MS)으로 합친다. 1 = 합침, 0 = 예전처럼 따로.
const MERGE_PRIORITY_THIEF = 1;
// P2-3 같은 층에 내 미배송 택배가 2개 이상이면 10초 선택 창(choosing) 없이 자동으로 고른다
//   (우선 지정한 것 > 배송비가 비싼 것 > 먼저 확보한 것). 1 = 자동, 0 = 예전처럼 선택 창. ※ 팀 확정 전 제안 사항.
const SAME_FLOOR_AUTO_PICK = 1;

// ---- 2026-10-14 확보 단계 "레이스 라운드" (사용자 결정: 속도전·순발력·같이 하는 느낌) ----
// 한 라운드: 레일에 택배 RACE_PARCELS개(종류만 보임)가 올라온다 -> 두 사람이 동시에 송장 붙이기(화면) -> 끝나면 바로 우봉고(실물, 같은 문제)
//   -> 우봉고까지 먼저 끝낸(투입한) 사람이 RACE_PICK_MS 안에 하나를 고른다(안 고르면 기본 금액이 비싼 종류) -> 자기 자리에 송장(층·금액) 출력
//   -> 늦은 사람은 먼저 끝낸 시각부터 RACE_SECOND_MS 안에 끝내면 남은 것 중 하나를 고르고(역시 RACE_PICK_MS), 못 끝내면 못 가져간다
//   -> RACE_REVEAL_MS 동안 결과를 보여 주고 다음 라운드. 확보 시간(SECURE_PHASE_MS)이 끝나거나 택배가 다 떨어지면 엘리베이터로.
// RACE_MODE = 0이면 예전 방식(레일에서 각자 골라 우봉고/미니게임).
// 2026-10-14 (사용자 수정): 택배는 3개, 종류만 보인다(가려진 상자 아님). 고르면 "자기 자리에서" 송장이 나온다 -- 층과 금액은
//   고른 사람 화면에만(레일 화면/메인 모니터/상대 화면에는 종류만). 먼저 끝낸 사람이 3개 중 하나, 늦은 사람은 마감 안에 투입하면
//   남은 것 중 하나를 고른다. 아무도 안 가져간 택배는 레일(보드)로 돌아가 다음 라운드에 다시 나올 수 있다(RACE_LEFTOVER_RETURN = 1).
const RACE_MODE = 1;
const RACE_PARCELS = 3;
const RACE_LEFTOVER_RETURN = 1;
// 2026-10-14 (사용자 요청): 투입(Space) 순간부터 20초 안에 고른다. 20초가 지나도 안 고르면 남은 것 중 무작위.
//   늦은 사람의 20초는 "내 투입"과 "1등이 고른 순간" 중 늦은 쪽부터 센다(1등이 고르기 전엔 고를 수 없으니까).
//   RACE_AUTO_PICK = 0이면 시간 제한 없이 직접 고를 때까지 기다린다. RACE_AUTO_PICK_MODE "best"면 무작위 대신 기본 금액이 비싼 종류.
//   (늦은 사람의 "투입" 마감 RACE_SECOND_MS는 그대로)
const RACE_PICK_MS = 20000;
const RACE_AUTO_PICK = 1;
const RACE_AUTO_PICK_MODE = "random";
// 2026-10-14 (사용자 결정): 늦은 사람의 투입 마감 5초 -> 30초. 상대가 먼저 투입해도 30초 안에 택배 쌓기를 끝내면 남은 택배 중 하나를 받는다.
const RACE_SECOND_MS = 30000;
// 2026-10-14 (사용자 결정): 한 사람만 끝내서 택배를 가져갔으면, 그 사람이 고른 순간부터 이 시간 뒤에 다른 사람도 남은 것 중 무작위로 하나 받는다
//   (그 전에 투입하면 직접 고른다. 포기한 사람도 받는다). 이 값이 0보다 크면 위 RACE_SECOND_MS(투입 마감)는 쓰지 않는다. 0이면 끔(예전처럼 마감 넘기면 못 가져감).
const RACE_CONSOLATION_MS = 20000;
// 2026-10-15 (사용자 결정): 레이스에서 빼는 택배 종류(key). 확정 층수 택배는 빼고, 대신 모든 택배의 층을 레일에서 보고 고른다.
const RACE_EXCLUDE_KINDS = ["fixed-floor"];
// 2026-10-15 (사용자 결정): 종류별로 나올 수 있는 층(FLOORS 인덱스, 0 = B1 ... 5 = 5F). 없으면 전 층. 귀중품은 B1·5F 안 나옴.
const FLOOR_LIMITS = { valuable: [1, 2, 3, 4] };
const RACE_REVEAL_MS = 2500;
// 송장 붙이기 난이도 [전반, 후반] (minigames.js: 1 = 박스 4개/송장 2장, 2 = 박스 7개/송장 4장)
const RACE_STICKER_LEVEL = [1, 1];
// 2026-10-14 (사용자 요청): 라운드 첫 게임은 송장 붙이기 고정이 아니라 아래 5종 중 무작위. 한 라운드에서 두 사람은 같은 게임을 한다.
//   바로 앞 라운드와 같은 게임은 안 나온다(5종을 섞은 순서대로 돌고, 다 돌면 다시 섞음). 박스 포장은 실물 택배 쌓기와 같은 퍼즐이라,
//   지도 배달은 길어서 뺐다. 한 종류로 고정하려면 ["sticker"]처럼 하나만 두면 된다. 난이도는 RACE_STICKER_LEVEL(전반/후반)을 같이 쓴다.
// 2026-10-15 (사용자 결정, "공부하는 느낌" 줄이기): 첫 미니게임을 뺐다 -- 레이스는 바로 실물 택배 쌓기로 시작한다.
//   다시 켜려면 ["sticker", "inspect", "match", "weigh", "tape"] (minigames.js에 5종 다 남아 있음).
// 2026-10-16 (사용자 결정): "택배 쌓기 전에 무언가 하는" 기조는 유지 -- 첫 미니게임 5종 다시 켬.
const RACE_GAME_POOL = ["sticker", "inspect", "match", "weigh", "tape"];
// 2026-10-16 (사용자 결정): 택배 쌓기 조각 하나당 짧은 반응형 미니게임 하나. 끝낼 때마다 조각 하나를 가져가 판에 놓고, 조각을 다 모으면 완성 -> 투입.
//   1이면 위 첫 게임(RACE_GAME_POOL) 대신 이 방식. 종류(build_client.py MICRO_GAMES): react(불 들어오면 누르기) / pick(같은 그림 고르기) / mash(연타) / arrows(방향 따라 누르기).
//   두 사람은 같은 순서의 게임을 한다 (서버가 라운드마다 정해 state.race.pieceGames에 둔다).
const RACE_PIECE_GAMES = 1;
const RACE_PIECE_GAME_KINDS = ["react", "pick", "mash", "arrows"];
// 라운드마다 띄울 우봉고 문제(퍼즐 이미지가 있는 칸 id). 내용물(택배 종류)과는 무관 -- 라운드가 갈수록 조각이 늘게(2 -> 3 -> 4조각) 배치.
// 현장에서는 이 순서대로 두 스테이션에 같은 실물 퍼즐을 준비한다. 끝까지 가면 처음부터 다시.
// 2026-10-14 (사용자 결정): 위 고정 순서 대신 라운드별 조각(색) 수로 고른다. [전반, 후반] 각각 라운드 순서대로, 목록이 끝나면 마지막 값 반복.
//   전반: 1~3라운드 2색, 이후 3색 / 후반: 1~4라운드 3색, 이후 4색. 같은 조각 수의 문제(칸 그림) 중에서 섞어서 겹치지 않게 돌린다.
//   (조각 수 = TYPES[].pieces -- 2색: 일반 4문제 / 3색: 깨지기 4 + 확정 층수 6 / 4색: 귀중품 3문제. 문제가 다 돌면 다시 섞음)
//   null로 두면 RACE_PUZZLE_ORDER 순서를 쓴다.
const RACE_PIECES_BY_ROUND = [[2, 2, 2, 3], [3, 3, 3, 3, 4]];
const RACE_PUZZLE_ORDER = ["normal-1", "normal-2", "fixed-floor-1", "fragile-1", "fixed-floor-2", "fragile-2", "valuable-1", "fixed-floor-3", "valuable-2", "valuable-3"];

// ---- 2026-10-16 벽 배송 (사용자 결정): 엘리베이터 대신 "호실 버튼 = 배송지". ----
// 건물 3동: 아파트 7층 x 2호 = 14 / 맨션 2층 x 6호 = 12 / 단독주택 8채(모양이 비슷한 집, 번지로 구분) = 34개 버튼.
// 확보 단계에서 택배마다 배송지(UNITS의 id)가 정해지고(레일에서 주소를 보고 고른다), 배송 단계에서 그 호실 버튼을 누른다.
// 입력: 레일 화면 키보드에서 Ctrl + 호실 키 = 1번(빨강), Shift + 호실 키 = 2번(파랑). 플레이어 화면에서는 호실을 탭(좌석은 자동).
// 누르면 그 호실 불이 켜지고 DELIVERY_PROGRESS_MS 뒤 배송 완료. 켜진 동안 그 호실 버튼을 Ctrl/Shift 없이 DELIVERY_RETURN_TAPS번 누르면
// 그 택배는 "반송"(배송 실패, 미배송과 같은 감점, 다시 배송 불가). 내 택배가 없는 호실을 Ctrl/Shift로 누르면 오배송 감점.
const WALL_MODE = 1;
// ---- 2026-10-22 (사용자 결정, 플레이 테스트 "주소가 낯설고 키가 너무 많다") 아파트 한 채 + 엘리베이터 이동 전쟁 ----
//   건물은 아파트 한 채(1~7층), 층마다 N01~N08호 (왼쪽 01~04 / 가운데 엘리베이터 / 오른쪽 05~08). 맨션·주택 없음.
//   (2차, 사용자 결정) 입력은 각자 플레이어 화면(▲▼ + 그 층 호실). 엘리베이터 하나를 같이 쓰며 두 단계를 번갈아:
//   이동 ELEV_MOVE_MS(5초): ▲ 한 번 = 한 층 위, ▼ 한 번 = 한 층 아래 (바로 움직이는 줄다리기, 예전 엘리베이터 라운드처럼). 5초 뒤 멈춘 층이 도착.
//   배송 ELEV_OPEN_MS(5초): 그 층에 택배가 있으면 문이 열리고, 그 층 내 집을 ELEV_DELIVER_TAPS번씩 눌러 최대한 많이 배송. ⚔ 같은 집은 먼저 채운 사람만.
//   택배 없는 층이면 배송 없이 바로 다음 이동. (1차의 "5연타 선점" 게이지는 이 방식으로 바뀌어 안 씀 -- ELEV_WAR_TAPS 등은 남겨 둠)
const APT_WAR = process.env.APT_WAR === "0" ? 0 : 1;
const APT_UNITS_PER_FLOOR = 8;
const ELEV_MOVE_MS = 5000;
const ELEV_WAR_TAPS = Math.max(1, parseInt(process.env.ELEV_TAPS || "5", 10) || 5);
const ELEV_SETTLE_MS = 800;
const ELEV_OPEN_MS = 5000;
const ELEV_DELIVER_TAPS = Math.max(1, parseInt(process.env.DELIVER_TAPS || "3", 10) || 3);
const ELEV_FLIP_FORCE = 3;
const ELEV_WAR_MOVE_MS = 250;   // 한 층 움직이는 연출 시간
const UNITS = [];
if (APT_WAR) {
  for (let f = 7; f >= 1; f--) for (let u = 1; u <= APT_UNITS_PER_FLOOR; u++) UNITS.push({ id: "a" + f + "0" + u, b: "apt", label: f + "0" + u + "호", floor: f, n: u });
} else {
  for (let f = 7; f >= 1; f--) for (let u = 1; u <= 2; u++) UNITS.push({ id: "a" + f + "0" + u, b: "apt", label: f + "0" + u + "호", floor: f });
  for (let f = 2; f >= 1; f--) for (let u = 1; u <= 6; u++) UNITS.push({ id: "m" + f + "0" + u, b: "mansion", label: f + "0" + u + "호", floor: f });
  ["11", "11-1", "13", "13-1", "15", "15-1", "17", "17-1"].forEach((n, i) => UNITS.push({ id: "h" + (i + 1), b: "house", label: "성수로 " + n }));
}
const BUILDINGS = [
  { key: "apt", name: "성수타워 아파트", short: "아파트" },
  { key: "mansion", name: "체키맨션", short: "맨션" },
  { key: "house", name: "단독주택", short: "주택" },
];
const DELIVERY_MS = 90 * 1000;          // 배송 단계 길이 (하프마다)
const DELIVERY_PROGRESS_MS = 5000;      // (유지 방식이 꺼졌을 때만) 버튼을 켠 뒤 배송 완료까지
// 2026-10-16 (사용자 제안, 첫 테스트): 팀 보조키 + 호실 버튼을 이 시간 동안 "누르고 있어야" 배송 완료. 중간에 떼면 처음부터.
//   0이면 위 DELIVERY_PROGRESS_MS 방식(한 번 누르면 켜지고 시간이 지나면 완료, 상대가 Ctrl/Shift 없이 5번 누르면 반송).
// 2026-10-16 (사용자 결정): 유지 방식은 끔 -- Ctrl/Shift 누른 채 호실 버튼을 누르면 배송이 시작되고 DELIVERY_PROGRESS_MS 뒤 완료.
//   막기: 그 사이 같은 호실 버튼을 Ctrl/Shift 없이 DELIVERY_RETURN_TAPS(5)번 연타하면 반송.
const DELIVERY_HOLD_MS = 0;
// 엘리베이터(위·아래 줄다리기)는 배송 단계 내내 움직인다. 아파트 호실은 엘리베이터가 그 층에 있을 때만 배송이 시작되고,
//   누르고 있는 동안 엘리베이터가 떠나면 실패. 맨션(2층)·주택은 엘리베이터와 상관없이 배송.
const DELIVERY_ELEVATOR = 1;
const DELIVERY_ELEV_START = 1;          // 시작 층 (아파트 1~7층)
// 2026-10-16 (사용자 결정): 엘리베이터는 메인 컴퓨터에서만(Ctrl/Shift+↑↓). 움직이는 동안(마지막 누름부터 이 시간)은 아파트 배송을 시작할 수 없다.
const DELIVERY_ELEV_MOVE_MS = 600;
const DELIVERY_RETURN_TAPS = 5;         // 켜진 버튼을 Ctrl/Shift 없이 이만큼 누르면 반송
const DELIVERY_MAX_ACTIVE = 1;          // 한 사람이 동시에 켤 수 있는 배송 수
const DELIVERY_WRONG_PENALTY = 500;     // 오배송(내 택배 없는 호실을 Ctrl/Shift로 누름) 1회 감점
// 2026-10-16 (사용자 결정) 콤보 점수 (하프마다 한 번씩):
//   종류 콤보 = 레이스에 나오는 모든 종류를 배송 성공 -> 기존 SET_BONUS(종류 모으기)를 그대로 씀 (확정 층수가 빠져 3종류 = 전부)
//   건물 콤보 = 아파트·맨션·주택 세 곳 모두 한 번 이상 배송 성공 -> +COMBO_BUILDING_BONUS
const COMBO_BUILDING_BONUS = 5000;
// 2026-10-16 (사용자 결정): 건물마다 배송 방식이 다르다.
//   아파트 "wait"  = 엘리베이터가 그 층 + 팀 키+호실 키 한 번 -> DELIVERY_PROGRESS_MS(5초) 뒤 완료 (지금 그대로)
//   맨션   "climb" = 팀 키를 누른 채 호실 키를 계단 수만큼 연타 (한 번 = 한 칸). 다 오르면 바로 완료. 2층이 더 높다.
//   주택   "bell"  = 팀 키+호실 키로 초인종 -> 무작위로 기다린 뒤 문이 열리면(초록) 제한 시간 안에 한 번 더 눌러 전달.
//            문 열리기 전에 누르면 초인종을 다시 누른 것(기다림이 처음부터), 시간 안에 못 누르면 문이 닫힘(택배는 그대로, 다시 초인종).
//   어느 방식이든 켜져 있는 동안 상대가 그 호실 키를 Ctrl/Shift 없이 5번 누르면 반송. 전부 "wait"로 두면 예전과 같다.
const DELIVERY_MODES = { apt: "wait", mansion: "climb", house: "bell" };
const DELIVERY_CLIMB_STEPS = { 1: 5, 2: 5 };   // 맨션 층별 계단 수(연타 횟수) -- 2층을 더 높게 하려면 2: 8 등

const DELIVERY_BELL_WAIT_MS = [1500, 3000];    // 주택 문이 열리기까지 (무작위 범위)
// 2026-10-16 (사용자 요청 "같이/경쟁하는 느낌"):
//   같은 집 쟁탈: 택배 쌓기에서 나오는 택배 주소 중 이 비율만큼은 "이미 누군가 들고 있는(미배송) 집"으로 뽑는다.
//     배송 단계에서 한 팀이 그 집에 먼저 배송하면, 상대 팀의 같은 집 택배는 "선점당함"(0원, 미배송 감점도 없음).
//   막기 보상: 상대 배송을 반송시키면(그냥 5번 연타) 상대 팀이 아닌 쪽(= 막은 팀)에 BLOCK_REWARD.
// 2026-10-16 (아케이드 연출) 피버: 배송 단계 마지막 FEVER_MS 동안 배송 완료 금액 x FEVER_MULT. 0이면 끔.
const FEVER_MS = 15000;
const FEVER_MULT = 2;
const CONTEST_RATE = 0.3;  // 하프마다 두 팀 겹치는 집이 두세 곳쯤
const BLOCK_REWARD = 1000;
const DELIVERY_BELL_WINDOW_MS = 2500;          // 문이 열려 있는 시간
// 2026-10-16 (사용자 결정): 택배 쌓기 라운드별 걸리는 택배 수와 먼저 끝낸 사람이 가져가는 수. 나머지는 늦은 사람(투입하거나 RACE_CONSOLATION_MS 뒤).
//   목록이 끝나면 마지막 값 반복. 1~2라운드: 3개 중 2개 / 3라운드부터: 5개 중 3개. null이면 예전(한 사람 하나씩).
const RACE_GRANT_PLAN = [{ parcels: 3, first: 2 }, { parcels: 3, first: 2 }, { parcels: 5, first: 3 }];
// 2026-10-16 (사용자 결정): 라운드 번호 대신 그 라운드 택배 쌓기 조각 수로 정한다. 2조각 = 택배 3개(1등 2개), 3조각 = 택배 5개(1등 3개).
//   4조각(후반 5라운드부터)은 따로 정해지지 않아 3조각과 같게 둔다. 이 표가 있으면 위 RACE_GRANT_PLAN(라운드별)보다 우선.
// 2026-10-21 (사용자 결정): 늦은 사람도 맞추면 이득이 있게 --
//   late = 늦은 사람이 RACE_CONSOLATION_MS 안에 완성하면 남은 것 중 직접 고르는 수, lateFail = 못 하면 무작위로 받는 수. 남는 택배는 사라짐.
//   2조각 = 4개(1등 2개 고름 / 늦게라도 맞추면 남은 2개 다 / 못 맞추면 1개 무작위), 3조각 이상 = 5개(1등 2개 / 맞추면 남은 3개 중 2개 / 못 맞추면 1개 무작위).
//   late·lateFail이 없으면 예전처럼 남은 것 전부.
const RACE_GRANT_BY_PIECES = { 2: { parcels: 4, first: 2, late: 2, lateFail: 1 }, 3: { parcels: 5, first: 2, late: 2, lateFail: 1 }, 4: { parcels: 5, first: 2, late: 2, lateFail: 1 } };
// 레이스 택배를 보드 칸 수와 상관없이 종류 비율(TYPES count)대로 계속 만든다 -- 라운드가 확보 시간 내내 이어진다.
const RACE_UNLIMITED = 1;

module.exports = {
  APT_WAR, APT_UNITS_PER_FLOOR, ELEV_MOVE_MS, ELEV_WAR_TAPS, ELEV_SETTLE_MS, ELEV_OPEN_MS, ELEV_DELIVER_TAPS, ELEV_FLIP_FORCE, ELEV_WAR_MOVE_MS,
  WALL_MODE, UNITS, BUILDINGS, DELIVERY_MS, DELIVERY_PROGRESS_MS, DELIVERY_HOLD_MS, DELIVERY_ELEVATOR, DELIVERY_ELEV_START, DELIVERY_ELEV_MOVE_MS, DELIVERY_RETURN_TAPS, DELIVERY_MAX_ACTIVE, DELIVERY_WRONG_PENALTY, COMBO_BUILDING_BONUS, DELIVERY_MODES, DELIVERY_CLIMB_STEPS, DELIVERY_BELL_WAIT_MS, DELIVERY_BELL_WINDOW_MS, CONTEST_RATE, BLOCK_REWARD, FEVER_MS, FEVER_MULT, RACE_GRANT_PLAN, RACE_GRANT_BY_PIECES, RACE_UNLIMITED, RACE_PIECE_GAMES, RACE_PIECE_GAME_KINDS,
  TYPES, COURIERS, FLOORS, ROOMS, CELLS, START_FLOOR_IDX, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
  PRIORITY_MULTIPLIER, SET_BONUS, SET_BONUS_KINDS, TUTORIAL_PAGES, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS, THIEF_PER_HALF, PRIORITY_PICK_MS,
  FLOOR_REWARD_MULT, START_FLOOR_CHOICES, ELEVATOR_JOLT, RESULT_AUTO_ADVANCE_MS, MERGE_PRIORITY_THIEF, SAME_FLOOR_AUTO_PICK,
  RACE_MODE, RACE_PICK_MS, RACE_SECOND_MS, RACE_REVEAL_MS, RACE_STICKER_LEVEL, RACE_GAME_POOL, RACE_PUZZLE_ORDER, RACE_PIECES_BY_ROUND, RACE_CONSOLATION_MS, RACE_EXCLUDE_KINDS, FLOOR_LIMITS, RACE_PARCELS, RACE_LEFTOVER_RETURN, RACE_AUTO_PICK, RACE_AUTO_PICK_MODE,
};
