#!/bin/bash
# 전체 회귀 테스트 (2026-10-08 저장소에 편입). 오래 걸린다(약 10분) -- 백그라운드로: nohup bash regress.sh > /tmp/regress.out 2>&1 &
# 필요: playwright (NODE_PATH에 전역 node_modules), /opt/pw-browsers/chromium. 끝나면 game-data.js(SECURE_PHASE_MS, mini)와 빌드를 원복한다.
cd "$(dirname "$0")"
export NODE_PATH="$(npm root -g):$PWD/node_modules"
setsec(){ sed -i -E "s/const SECURE_PHASE_MS = .*;/const SECURE_PHASE_MS = $1;/" game-data.js; python3 build_client.py >/dev/null; pkill -x node; sleep 0.5; (nohup node server.js >/tmp/server.log 2>&1 &); sleep 1.5; }
restore(){ sed -i -E "s/const SECURE_PHASE_MS = .*;/const SECURE_PHASE_MS = 3 * 60 * 1000;/" game-data.js; python3 set_mini.py ubongo >/dev/null; python3 build_client.py >/dev/null; pkill -x node; }
trap restore EXIT
run(){ echo "== $1"; timeout 400 node $1 2>&1 | tail -3; echo "exit=${PIPESTATUS[0]}"; }

echo "######## 실물 우봉고 모드 (기본)"
python3 set_mini.py ubongo >/dev/null
setsec "3 * 60 * 1000"
for t in test_priority_window.js test_thief_limit.js test_shared_board.js test_theft_scoring.js test_restart.js test_minigames.js; do run $t; done
setsec "10 * 1000"
for t in test_hosted.js test_theft_e2e.js test_nudge.js; do run $t; done
setsec "20 * 1000"; run test_mainview.js
setsec "40 * 1000"; run test_half_difficulty.js; run test_rail_site.js

echo "######## 디지털 미니게임 모드 (python3 set_mini.py digital)"
python3 set_mini.py digital >/dev/null
setsec "10 * 1000"; run test_half_difficulty_digital.js
setsec "40 * 1000"; run test_minigames_live.js; run test_rail_site.js
