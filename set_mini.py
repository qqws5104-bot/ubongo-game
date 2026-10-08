#!/usr/bin/env python3
"""game-data.js의 TYPES[].mini를 한 번에 바꾼다 (2026-10-08).

  python3 set_mini.py ubongo    # 네 종류 모두 실물 우봉고 (mini: null) -- 기본값, 커밋되는 상태
  python3 set_mini.py digital   # pack / inspect / sticker / map 디지털 미니게임 (테스트 전용: test_minigames_live.js, test_rail_site.js 등)

바꾼 뒤에는 `python3 build_client.py`로 클라이언트를 다시 빌드하고 서버도 재시작해야 한다.
디지털 테스트가 끝나면 반드시 `ubongo`로 되돌릴 것 (regress.sh가 자동으로 한다).
"""
import re, sys

DIGITAL = {"normal": "pack", "fragile": "inspect", "valuable": "map", "fixed-floor": "sticker"}
mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode not in ("ubongo", "digital"):
    sys.exit(__doc__)
path = __file__.rsplit("/", 1)[0] + "/game-data.js" if "/" in __file__ else "game-data.js"
src = open(path, encoding="utf-8").read()
for key, game in DIGITAL.items():
    want = "null" if mode == "ubongo" else '"%s"' % game
    pat = re.compile(r'(\{ key: "%s",.*?mini: )(null|"[a-z]+")' % re.escape(key), re.S)
    src, n = pat.subn(lambda m: m.group(1) + want, src, count=1)
    assert n == 1, key
open(path, "w", encoding="utf-8").write(src)
print("TYPES.mini ->", mode)
