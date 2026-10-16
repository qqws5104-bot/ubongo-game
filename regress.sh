#!/bin/bash
# 전체 회귀 테스트 (2026-10-08 저장소에 편입). 오래 걸린다(약 10분) -- 백그라운드로: nohup bash regress.sh > /tmp/regress.out 2>&1 &
# 필요: playwright (NODE_PATH에 전역 node_modules), /opt/pw-browsers/chromium. 끝나면 game-data.js(SECURE_PHASE_MS, mini)와 빌드를 원복한다.
cd "$(dirname "$0")"
export NODE_PATH="$(npm root -g):$PWD/node_modules"
# 2026-10-16: 기본값이 벽 배송(+ 택배 쌓기 몫 계획)이 됐다. 아래 예전 테스트들은 WALL=0(예전 엘리베이터 흐름)으로 돈다. 벽 배송은 맨 끝 섹션.
export WALL=0
# 2026-10-14: 확보 단계 기본값이 레이스 라운드가 됐다. 예전 확보 방식을 전제로 한 브라우저 테스트는 RACE_MODE=0으로 띄운 서버에서 돈다.
RACE_ENV=0
setsec(){ sed -i -E "s/const SECURE_PHASE_MS = .*;/const SECURE_PHASE_MS = $1;/" game-data.js; python3 build_client.py >/dev/null; pkill -x node; sleep 0.5; (TUTORIAL=0 RACE_GAMES=$RACE_GAMES_ENV RACE_MODE=$RACE_ENV nohup node server.js >/tmp/server.log 2>&1 &); sleep 1.5; }
restore(){ sed -i -E "s/const SECURE_PHASE_MS = .*;/const SECURE_PHASE_MS = 3 * 60 * 1000;/" game-data.js; python3 set_mini.py ubongo >/dev/null; python3 build_client.py >/dev/null; pkill -x node; }
trap restore EXIT
run(){ echo "== $1"; timeout 400 node $1 2>&1 | tail -3; echo "exit=${PIPESTATUS[0]}"; }

echo "######## 실물 우봉고 모드 (기본)"
python3 set_mini.py ubongo >/dev/null
setsec "3 * 60 * 1000"
for t in test_race.js test_jolt.js test_set_bonus.js test_p1p2.js test_priority_window.js test_thief_limit.js test_shared_board.js test_theft_scoring.js test_restart.js test_minigames.js; do run $t; done
setsec "10 * 1000"
for t in test_hosted.js test_theft_e2e.js test_nudge.js; do run $t; done
setsec "20 * 1000"; run test_mainview.js
setsec "40 * 1000"; run test_half_difficulty.js; run test_rail_site.js

echo "######## 디지털 미니게임 모드 (python3 set_mini.py digital)"
python3 set_mini.py digital >/dev/null
setsec "10 * 1000"; run test_half_difficulty_digital.js
setsec "40 * 1000"; run test_minigames_live.js; run test_rail_site.js

echo "######## 확보 단계 레이스 라운드 (기본 모드, 2026-10-14)"
python3 set_mini.py ubongo >/dev/null
RACE_ENV=1
# test_race_e2e는 첫 미니게임 흐름까지 검사하려고 5종을 켠 서버로 (기본은 첫 게임 없음 -- test_tutorial_e2e가 검사)
RACE_GAMES_ENV=sticker,inspect,match,weigh,tape
setsec "100 * 1000"; run test_race_e2e.js; run test_race_games.js

RACE_GAMES_ENV=none
echo "######## 시작 전 튜토리얼 (실제 서버 기본값 = 켬, 2026-10-15)"
setsec "3 * 60 * 1000"; pkill -x node; sleep 0.5; (RACE_GAMES=none RACE_MODE=1 nohup node server.js >/tmp/server.log 2>&1 &); sleep 1.5
run test_tutorial_e2e.js

echo "######## 벽 배송 + 택배 쌓기 몫 (기본 모드, 2026-10-16)"
export WALL=1
run test_wall.js
setsec "90 * 1000"; pkill -x node; sleep 0.5; (TUTORIAL=0 RACE_MODE=1 nohup node server.js >/tmp/server.log 2>&1 &); sleep 1.5
run test_wall_e2e.js
