"""
택배 배송 게임 — 자체 호스팅(WebSocket 서버) 버전의 클라이언트(public/index.html) 생성 스크립트.

Claude Artifact의 publish/reload 구조를 걷어내고, 실제 Node WebSocket 서버(server.js +
game-room.js)가 상태를 소유한다. 클라이언트는 이제 순수 렌더러 + WS 클라이언트일 뿐이라
예전 버전에 있던 것들이 통째로 사라졌다: 클라이언트측 리듀서, sessionStorage 기반 pending
액션 재시도, publish 충돌/재시도 로직, 라운드별 투표 집계를 로컬에 모아뒀다 라운드 끝에
한 번만 제출하던 방식(그리고 그 방식 때문에 있었던 "제출 직전 리로드로 집계가 날아가는"
버그의 원인 자체)까지 전부. 서버가 모든 액션을 순서대로 처리하는 단일 소유자이므로
클릭 하나하나를 즉시 브로드캐스트해도 안전하고, 오히려 그게 더 단순하다.

TYPES/CELLS/FLOORS/ROOMS 경제 상수는 game-data.js(서버가 require하는 것과 동일 파일)에서
읽어와 클라이언트 JSON에 그대로 반영한다 — 서버와 클라이언트가 다른 소스에서 각자
유지되며 몰래 어긋나는 일을 원천적으로 막기 위함.
"""

import os
import re
import base64
import json

# 2026-08-28: 전반/후반 퍼즐 이미지 분리 (이전엔 REF_DIR 하나를 두 하프가 공유했다 -- 후반용 세트가
# 아직 안 와서 임시로 그랬던 것. 후반 세트가 도착해서 REF_DIR_1(전반)/REF_DIR_2(후반)로 나눔).
REF_DIR_1 = "/home/claude/project/quiz_board/ref"
REF_DIR_2 = "/home/claude/project/quiz_board/ref_2"
COMPRESSED_DIR = "/tmp/compressed"
GAME_DATA_JS = os.path.join(os.path.dirname(__file__), "game-data.js")
OUT_HTML = os.path.join(os.path.dirname(__file__), "public", "index.html")
# 2026-08-27: 종류별 보드 칸 배경으로 쓰는 박스 일러스트 (사용자 제공, ref/box_art/<key>.webp --
# 알파 채널 있는 투명 배경 PNG를 크롭해 webp로 저장해둔 것). CELLS의 퍼즐 이미지(칸마다 다름)와는
# 별개로, 종류(TYPES)당 딱 1장씩만 있고 그 종류의 21칸 전부가 공유해서 쓴다.
BOX_ART_DIR = os.path.join(os.path.dirname(__file__), "box_art")


def load_shared_constants():
    """game-data.js를 파싱해서 TYPES/FLOORS/ROOMS/ELEVATOR_ROUNDS/SECURE_PHASE_MS/VOTE_MS를
    그대로 재사용한다 (정규식으로 각 상수 리터럴을 추출 -- Node를 별도로 실행하지 않고
    빌드 스크립트를 순수 Python으로 유지하기 위함). 값이 하나라도 어긋나면 즉시 실패하도록
    각 상수를 못 찾으면 에러를 낸다."""
    src = open(GAME_DATA_JS, encoding="utf-8").read()

    def grab(name):
        m = re.search(r"const %s = (\[[\s\S]*?\]|\d+(?:\s*\*\s*\d+)*);" % re.escape(name), src)
        if not m:
            raise RuntimeError(f"could not find {name} in game-data.js")
        return m.group(1)

    types_js = grab("TYPES")
    couriers_js = grab("COURIERS")
    floors_js = grab("FLOORS")
    rooms_js = grab("ROOMS")
    elevator_rounds = eval(grab("ELEVATOR_ROUNDS"))
    secure_phase_ms = eval(grab("SECURE_PHASE_MS"))
    vote_ms = eval(grab("VOTE_MS"))
    priority_multiplier = eval(grab("PRIORITY_MULTIPLIER"))
    same_floor_choice_ms = eval(grab("SAME_FLOOR_CHOICE_MS"))
    halves = eval(grab("HALVES"))
    thief_place_ms = eval(grab("THIEF_PLACE_MS"))
    priority_pick_ms = eval(grab("PRIORITY_PICK_MS"))
    # 2026-10-13 개선 1단계(P1+P2)
    floor_reward_mult = json.loads(grab("FLOOR_REWARD_MULT"))
    result_auto_advance_ms = eval(grab("RESULT_AUTO_ADVANCE_MS"))
    merge_priority_thief = eval(grab("MERGE_PRIORITY_THIEF"))
    # 2026-10-14 확보 단계 레이스 라운드
    race = {
        "RACE_MODE": eval(grab("RACE_MODE")),
        "RACE_PICK_MS": eval(grab("RACE_PICK_MS")),
        "RACE_SECOND_MS": eval(grab("RACE_SECOND_MS")),
        "RACE_CONSOLATION_MS": eval(grab("RACE_CONSOLATION_MS")),
        "RACE_STICKER_LEVEL": json.loads(grab("RACE_STICKER_LEVEL")),
        "ELEVATOR_JOLT": eval(grab("ELEVATOR_JOLT")),
        "VOTE_MS": eval(grab("VOTE_MS")),
        "RACE_EXCLUDE_KINDS": json.loads(grab("RACE_EXCLUDE_KINDS")),
        "RACE_GAME_POOL": json.loads(grab("RACE_GAME_POOL")),
        "THIEF_PER_HALF": eval(grab("THIEF_PER_HALF")),
    }

    # TYPES uses plain (unquoted) JS object keys -- not valid JSON as-is. Quote bare
    # identifier keys before parsing (FLOORS/ROOMS are already flat string arrays, so this
    # is a no-op for them; applying it unconditionally keeps this function generic).
    def js_object_to_json(js):
        js = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)', r'\1"\2"\3', js)
        # strip trailing commas before a closing ] or } (valid in JS, not in JSON)
        js = re.sub(r',(\s*[\]}])', r'\1', js)
        return js

    types = json.loads(js_object_to_json(types_js))
    couriers = json.loads(js_object_to_json(couriers_js))
    floors = json.loads(js_object_to_json(floors_js))
    rooms = json.loads(js_object_to_json(rooms_js))
    return (types, couriers, floors, rooms, elevator_rounds, secure_phase_ms, vote_ms,
            priority_multiplier, same_floor_choice_ms, halves, thief_place_ms, priority_pick_ms,
            floor_reward_mult, result_auto_advance_ms, merge_priority_thief, race)


(TYPES, COURIERS, FLOORS, ROOMS, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
 PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS, PRIORITY_PICK_MS,
 FLOOR_REWARD_MULT, RESULT_AUTO_ADVANCE_MS, MERGE_PRIORITY_THIEF, RACE_CONST) = load_shared_constants()

# 2026-08-27 개편: 보드가 20칸(4종류x5개 고정)에서 21칸(종류별 count가 다름, 확정 층수 택배만 6개)으로
# 바뀌면서, 예전의 스와치 개수(2/3/4조각) 기준 이미지 그룹핑은 더 이상 종류별 칸 수와 맞물리지 않는다
# (그 그룹핑은 애초에 시각적 편의였을 뿐 게임 로직과는 무관했다). 이제는 CELLS 순서대로 이미지 파일을
# 그냥 하나씩 배정한다. 21칸에 맞는 원본 PNG가 REF_DIR_1/REF_DIR_2에 없다면, 마지막 이미지를 재사용해
# 자리만 채우고 크게 경고한다 -- 빌드/배포는 막지 않되 실제 플레이에는 쓰면 안 되는 플레이스홀더임을
# 분명히 한다.
#
# 2026-08-28: 전반(half 1)과 후반(half 2)이 서로 다른 21장 세트를 쓴다 (REF_DIR_1/REF_DIR_2).
# 보드 구조(id/catIdx/num, game-data.js의 CELLS)는 두 하프가 그대로 공유하지만 -- 서버는 이미지에
# 관심이 없다, 순전히 클라이언트가 퍼즐 오버레이에 띄우는 이미지만 하프별로 다르다. 그래서 이 파일의
# CELLS는 half별로 두 벌(CELLS_1/CELLS_2)을 만들고, 클라이언트의 cellMeta(id, half)가 그중 하나를
# 골라 쓴다 (렌더 함수 쪽 주석 참고).
TOTAL_CELLS = sum(t["count"] for t in TYPES)
LEGACY_TOTAL_CELLS = 21  # 원본 PNG 한 세트의 장 수 (예전 5/5/5/6 배치) -- PUZZLE_SRC의 번호는 이 번호 체계를 따른다


def load_image_files(ref_dir):
    files = sorted(
        f for f in os.listdir(ref_dir)
        if f.lower().endswith(".png") and f != "contact_sheet.png"
    )
    if len(files) < LEGACY_TOTAL_CELLS:
        print(f"WARNING: {ref_dir} 안에 원본 PNG가 {len(files)}장뿐입니다(예전 배치 기준 {LEGACY_TOTAL_CELLS}장 필요). 부족한 칸은 마지막 이미지를 재사용합니다.")
    return files


def image_for_flat_idx(files, ref_dir, i):
    if not files:
        raise RuntimeError(f"{ref_dir}에 원본 PNG가 하나도 없습니다.")
    return files[i] if i < len(files) else files[-1]


def data_uri_for(png_name):
    jpg_name = png_name.replace(".png", ".jpg")
    path = os.path.join(COMPRESSED_DIR, jpg_name)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


# 2026-10-06: 우봉고 퍼즐 이미지는 "귀중품" 칸에만 필요하다(나머지 종류는 미니게임). 퍼즐의 색(조각) 개수는 하프마다
# 다르다 -- 전반 3색, 후반 4색(사용자 요청, game-data.js의 valuable.pieces = [3, 4]와 맞출 것). 원본 이미지 세트는
# 예전 21칸 배치(1~5: 2색, 6~10: 3색, 11~15: 4색, 16~21: 3색)로 번호가 매겨져 있으므로, 색 개수에 맞는 이미지를 골라
# 명시적으로 지정한다. (세트, 번호): 세트 1 = REF_DIR_1(전반 원본), 2 = REF_DIR_2(후반 원본), 번호는 1부터.
#   * 전반 귀중품 6칸 = 3색짜리 6장 (전반 세트의 6~10번 + 16번) -- 더는 안 쓰는 깨지기/확정 층수용 이미지를 재활용.
#   * 후반 귀중품 6칸 = 4색짜리 6장 (후반 세트의 11~15번 + 전반 세트의 11번). 후반용 4색 이미지는 5장뿐이라 6번째는
#     전반에서 안 쓰게 된 전반 세트의 4색 이미지를 가져온다 -- 전반에는 4색 이미지가 안 나오므로 한 판 안에서 겹치지 않는다.
# 귀중품이 아닌 종류(mini가 있는 종류)의 칸은 src를 비워서 번들에서 이미지를 뺀다(약 4MB -> 1.4MB). 어떤 종류를 다시
# 우봉고로 돌리려면(TYPES의 mini를 null로) 아래 PUZZLE_SRC에 그 종류의 (세트, 번호) 6개를 하프별로 적어야 한다 -- 없으면
# 빌드가 실패한다(빈 퍼즐 이미지가 실전에 나가는 걸 막기 위함).
# 2026-10-08 실물 우봉고 복귀: 네 종류 모두 퍼즐 이미지를 싣는다. 원본 세트의 번호 체계(1~5: 2색, 6~10: 3색, 11~15: 4색,
# 16~21: 3색)에 맞춰 색 개수가 TYPES의 pieces와 같은 이미지를 고른다. 전반은 세트 1, 후반은 세트 2 (서로 다른 이미지).
#   일반 4칸(2색) = 1~4 / 깨지기 4칸(3색) = 6~9 / 귀중품 3칸(4색) = 11~13 / 확정 층수 6칸(3색) = 16~21
PUZZLE_SRC = {
    1: {
        "normal": [(1, 1), (1, 2), (1, 3), (1, 4)],
        "fragile": [(1, 6), (1, 7), (1, 8), (1, 9)],
        "valuable": [(1, 11), (1, 12), (1, 13)],
        "fixed-floor": [(1, 16), (1, 17), (1, 18), (1, 19), (1, 20), (1, 21)],
    },
    2: {
        "normal": [(2, 1), (2, 2), (2, 3), (2, 4)],
        "fragile": [(2, 6), (2, 7), (2, 8), (2, 9)],
        "valuable": [(2, 11), (2, 12), (2, 13)],
        "fixed-floor": [(2, 16), (2, 17), (2, 18), (2, 19), (2, 20), (2, 21)],
    },
}
REF_DIRS = {1: REF_DIR_1, 2: REF_DIR_2}
_FILES_BY_SET = {}


def _files_for_set(set_no):
    if set_no not in _FILES_BY_SET:
        _FILES_BY_SET[set_no] = load_image_files(REF_DIRS[set_no])
    return _FILES_BY_SET[set_no]


def build_cells(half):
    cells = []
    for cat_idx, t in enumerate(TYPES):
        picks = PUZZLE_SRC[half].get(t["key"]) if t.get("mini") is None else None
        if t.get("mini") is None and (picks is None or len(picks) < t["count"]):
            raise RuntimeError(f"{t['name']}은(는) 우봉고인데 PUZZLE_SRC[{half}]에 퍼즐 이미지 {t['count']}장이 지정되어 있지 않습니다.")
        for num_idx in range(t["count"]):
            src = ""
            if picks is not None:
                set_no, n = picks[num_idx]
                files = _files_for_set(set_no)
                src = data_uri_for(image_for_flat_idx(files, REF_DIRS[set_no], n - 1))
            cells.append({
                "id": f"{t['key']}-{num_idx + 1}",
                "catIdx": cat_idx,
                "num": num_idx,
                "src": src,
            })
    return cells


# 2026-10-13: 퍼즐 원본(REF_DIR_1/REF_DIR_2, COMPRESSED_DIR)은 저장소 밖(작업자 PC)에 있다. 그 폴더가 없는 환경에서
# 게임 규칙/화면만 고쳐 재빌드할 때는, 이미 커밋된 public/index.html에 박혀 있는 퍼즐 이미지(CELLS_1/CELLS_2)를 그대로
# 재사용한다 -- 이미지가 바뀌지 않으니 결과가 같다. 이미지를 교체하려면 원본 폴더가 있는 환경에서 빌드할 것(2.1절).
PUBLIC_INDEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "index.html")


def cells_from_previous_build(half):
    html = open(PUBLIC_INDEX, encoding="utf-8").read()
    m = re.search(r"var CELLS_%d = (\[.*?\]);\n" % half, html, re.S)
    if not m:
        raise RuntimeError("퍼즐 원본 폴더도 없고, 이전 빌드(public/index.html)에서 CELLS_%d도 못 찾았습니다." % half)
    prev = {c["id"]: c for c in json.loads(m.group(1))}
    cells = []
    for cat_idx, t in enumerate(TYPES):
        for num_idx in range(t["count"]):
            cid = f"{t['key']}-{num_idx + 1}"
            if cid not in prev:
                raise RuntimeError(f"이전 빌드에 {cid} 칸이 없습니다 -- 보드 구성이 바뀌었다면 원본 폴더가 있는 환경에서 빌드하세요.")
            # 디지털 미니게임 종류여도 이미지를 빼지 않는다 -- 빼 버리면 다음 빌드(우봉고로 복귀)에서 되살릴 원본이 없다.
            src = prev[cid]["src"]
            if t.get("mini") is None and not src:
                raise RuntimeError(f"이전 빌드의 {cid} 칸에 퍼즐 이미지가 없습니다.")
            cells.append({"id": cid, "catIdx": cat_idx, "num": num_idx, "src": src})
    return cells


if all(os.path.isdir(d) for d in (REF_DIR_1, REF_DIR_2, COMPRESSED_DIR)):
    CELLS_1 = build_cells(1)   # 전반
    CELLS_2 = build_cells(2)   # 후반
else:
    print("NOTE: 퍼즐 원본 폴더가 없어 이전 빌드(public/index.html)의 퍼즐 이미지를 재사용합니다.")
    CELLS_1 = cells_from_previous_build(1)
    CELLS_2 = cells_from_previous_build(2)


def box_art_data_uri(key):
    path = os.path.join(BOX_ART_DIR, f"{key}.webp")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/webp;base64,{b64}"


# catIdx로 바로 인덱싱해서 쓰는 배열 (TYPES 순서와 항상 같이 감) -- renderBoard가 BOX_ART[catIdx]로 참조.
BOX_ART = [box_art_data_uri(t["key"]) for t in TYPES]

TYPES_JSON = json.dumps(TYPES, ensure_ascii=False)
COURIERS_JSON = json.dumps(COURIERS, ensure_ascii=False)
CELLS_1_JSON = json.dumps(CELLS_1, ensure_ascii=False)
CELLS_2_JSON = json.dumps(CELLS_2, ensure_ascii=False)
FLOORS_JSON = json.dumps(FLOORS, ensure_ascii=False)
BOX_ART_JSON = json.dumps(BOX_ART, ensure_ascii=False)
ROOMS_JSON = json.dumps(ROOMS, ensure_ascii=False)

HEAD_HTML = """<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>택배 배송 게임 — 라이브</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  /* 2026-08-27 전면 리스킨: 어두운 남색 테마 -> 사용자가 준 "택배 요금표" 참고 포스터(크림/베이지
     바탕 + 주황 포인트)에 맞춘 따뜻한 톤. 게임 전체(로비/보드/엘리베이터/하프타임/종료 화면 전부)에
     적용 -- 사용자가 명시적으로 "게임 전체" 범위를 확인했다. 토큰만 바꾸면 대부분의 컴포넌트가
     자동으로 따라오지만, 특정 hex 값을 직접 박아넣은 rgba(...) 리터럴들과, 어두운 배경을 전제로 한
     "옅은 흰색 틴트" 오버레이들은 토큰이 아니라서 이 블록만 바꿔선 안 바뀐다 -- 아래 각 규칙에서
     개별적으로 손봤다 (검색: 2026-08-27 리스킨). */
  :root {
    --bg: #f7ecd9; --bg-deep: #efdcb2; --panel: #fffcf4; --panel-line: rgba(43,29,18,0.14);
    --ink: #2b1d12; --muted: #8a7256; --gold: #e2691a; --gold-ink: #fff8ef;
    --sky: #2569a8; --danger: #c7402d; --ok: #2f8f52; --visited: #d8c7a1;
    --font-display: 'Oswald','Noto Sans KR',sans-serif; --font-body: 'Noto Sans KR',system-ui,-apple-system,sans-serif;
  }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--ink); font-family:var(--font-body); min-height:100%; }
  body { min-height:100vh; }
  #app { min-height:100vh; display:flex; flex-direction:column; }
  button { font-family:inherit; cursor:pointer; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:1rem;
    padding:0.9rem clamp(1rem,3vw,2.2rem); border-bottom:1px solid var(--panel-line);
    background:linear-gradient(180deg,var(--bg-deep),rgba(239,220,178,0)); flex-wrap:wrap; }
  .topbar .brand { display:flex; flex-direction:column; gap:0.3rem; }
  .topbar .eyebrow { font-family:var(--font-display); font-size:0.7rem; letter-spacing:0.2em; text-transform:uppercase; color:var(--gold); font-weight:600; }
  .topbar h1 { margin:0; font-size:clamp(1.1rem,2vw,1.5rem); font-weight:700; }
  .topbar .right { display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; }
  .seat-badge { display:inline-flex; align-items:center; gap:0.4rem; padding:0.3rem 0.7rem; border-radius:999px;
    border:1px solid rgba(226,105,26,0.4); background:rgba(226,105,26,0.08); color:var(--gold);
    font-family:var(--font-display); font-size:0.82rem; font-weight:600; }
  .room-chip { display:inline-flex; align-items:center; gap:0.35rem; padding:0.3rem 0.7rem; border-radius:999px;
    border:1px solid rgba(37,105,168,0.35); background:rgba(37,105,168,0.1); color:var(--sky);
    font-family:var(--font-display); font-size:0.82rem; font-weight:600; letter-spacing:0.05em; }
  .conn-banner { position:fixed; top:0; left:0; right:0; z-index:90; text-align:center; padding:0.5rem;
    background:var(--danger); color:#fff; font-family:var(--font-display); font-size:0.85rem; font-weight:600; }
  main.stage { flex:1; padding:clamp(1rem,3vw,2.2rem); display:flex; flex-direction:column; gap:1.2rem; }
  /* Secure phase gets a genuine fit-to-viewport layout instead of a guessed pixel budget: the
     page height is pinned to the viewport (no page scroll) and the board grid is given exactly
     whatever vertical space is left after the header, with its 4 rows set to fill that space
     (grid-template-rows: 1fr) and the boxes stretching to match (aspect-ratio:auto below) --
     so cell size adapts automatically to WHATEVER a given laptop's browser chrome actually
     leaves, rather than a fixed rem/aspect-ratio guess that can be thrown off by toolbars,
     bookmark bars, or OS scaling. board-grid keeps a scroll fallback (overflow-y:auto) in case
     content still can't physically fit (e.g. a very short window) so nothing ever gets clipped. */
  html:has(main.stage--secure), html:has(main.stage--secure) body { height:100%; overflow:hidden; }
  html:has(main.stage--secure) #app { height:100vh; }
  main.stage.stage--secure { padding-left:calc(128px + 1.1rem + 1.6rem); padding-top:clamp(0.5rem,1.6vw,1.1rem); padding-bottom:clamp(0.5rem,1.6vw,1.1rem); min-height:0; }
  @media (max-width:900px) { main.stage.stage--secure { padding-left:clamp(1rem,3vw,2.2rem); } }
  .card { background:var(--panel); border:1px solid var(--panel-line); border-radius:14px; padding:1.2rem 1.4rem; }
  .stage--secure .card { padding:0.8rem 1rem; flex:1; min-height:0; display:flex; flex-direction:column; }
  .btn { border:none; border-radius:10px; padding:0.7rem 1.3rem; font-weight:700; font-size:0.95rem;
    font-family:var(--font-display); letter-spacing:0.01em; transition:transform .12s ease, filter .12s ease; }
  .btn:active { transform:scale(0.96); }
  .btn.primary { background:var(--gold); color:var(--gold-ink); }
  .btn.primary:hover { filter:brightness(1.08); }
  .btn.ghost { background:transparent; color:var(--ink); border:1px solid var(--panel-line); }
  .btn.danger { background:var(--danger); color:#fff; }
  .btn.ok { background:var(--ok); color:#fff; }
  .btn:disabled { opacity:0.4; cursor:not-allowed; transform:none; }
  .btn.big { padding:1.4rem; font-size:1.4rem; border-radius:16px; width:100%; }

  .center-screen { flex:1; display:flex; align-items:center; justify-content:center; padding:2rem 1rem; }
  /* 2026-08-27: 좌석 선택 화면을 "플레이어 1/2" 두 버튼에서 가상 택배사 5종 아이콘 픽커로 교체하면서
     같이 카드 배경 + 장식용 택배박스 일러스트를 추가했다 (사용자 요청: "처음 시작 페이지에 택배박스
     모양이 좀 그려져 있으면 좋을 것 같아"). .picker-scene이 그 장식(.lobby-box-deco, 카드 뒤에 옅게
     흩어진 박스 라인아트)의 위치 기준점 -- 카드(.seat-pick) 자체는 z-index로 그 위에 뜬다. */
  .picker-scene { position:relative; width:100%; max-width:680px; display:flex; justify-content:center; }
  .lobby-box-deco { position:absolute; pointer-events:none; z-index:0; }
  .lobby-box-deco svg { width:100%; height:100%; display:block; }
  .seat-pick { position:relative; z-index:1; text-align:center; max-width:640px; width:100%; padding:1.6rem 1.8rem; }
  .seat-pick h2 { font-family:var(--font-display); font-size:1.6rem; margin:0 0 0.4rem; }
  .seat-pick p { color:var(--muted); font-size:0.9rem; margin:0 0 1.4rem; }
  .courier-options { display:flex; gap:0.7rem; justify-content:center; flex-wrap:wrap; max-width:360px; margin:0 auto; }
  .courier-btn { --courier-color:var(--gold); flex:0 1 108px; display:flex; flex-direction:column; align-items:center;
    gap:0.4rem; padding:0.9rem 0.6rem; border-radius:14px; background:var(--panel);
    border:2px solid var(--panel-line); font-family:var(--font-display); color:var(--ink);
    transition:transform .12s ease, border-color .12s ease, box-shadow .12s ease; }
  .courier-btn:not(:disabled):hover { transform:translateY(-2px); border-color:var(--courier-color);
    box-shadow:0 8px 18px rgba(43,29,18,0.14); }
  .courier-btn .courier-icon { width:34px; height:34px; color:var(--courier-color); }
  .courier-btn .courier-icon svg { width:100%; height:100%; display:block; }
  .courier-btn .courier-name { font-size:0.82rem; font-weight:700; }
  .courier-btn.mine { border-color:var(--courier-color); background:color-mix(in srgb, var(--courier-color) 12%, var(--panel)); }
  .courier-btn.taken, .courier-btn:disabled:not(.mine) { opacity:0.45; cursor:not-allowed; }
  .courier-btn .taken-note { display:block; font-size:0.68rem; font-weight:600; color:var(--muted); }
  .room-share { margin-top:1.2rem; padding-top:1.2rem; border-top:1px solid var(--panel-line); color:var(--muted); font-size:0.85rem; }
  .room-share strong { color:var(--sky); font-family:var(--font-display); letter-spacing:0.08em; }

  .lobby-box { text-align:center; max-width:520px; }
  .lobby-box h2 { font-family:var(--font-display); font-size:1.8rem; margin:0 0 0.6rem; }
  .lobby-box p { color:var(--muted); font-size:0.95rem; line-height:1.6; }

  .timer-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
  .timer-label { font-family:var(--font-display); font-size:0.85rem; color:var(--muted); letter-spacing:0.05em; }
  .timer-num { font-family:var(--font-display); font-size:1.9rem; font-weight:700; font-variant-numeric:tabular-nums; color:var(--gold); }
  .timer-bar { height:8px; border-radius:999px; background:rgba(43,29,18,0.1); overflow:hidden; margin-top:0.5rem; }
  .timer-bar > i { display:block; height:100%; background:var(--gold); transition:width 0.3s linear; }
  .time-left-big { margin-top:0.6rem; font-family:var(--font-display); font-weight:700; font-size:1.5rem;
    color:var(--gold); font-variant-numeric:tabular-nums; letter-spacing:0.02em; }

  .side-timer { position:fixed; left:1.1rem; top:6.5rem; width:128px; z-index:30; text-align:center;
    background:var(--panel); border:1px solid var(--panel-line); border-radius:14px; padding:0.9rem 0.8rem;
    box-shadow:0 14px 34px rgba(0,0,0,0.4); }
  .side-timer .timer-label { display:block; line-height:1.3; margin-bottom:0.4rem; }
  .side-timer .timer-num { display:block; font-size:1.65rem; }
  .side-timer .timer-bar { margin-top:0.6rem; }
  @media (max-width:900px) { .side-timer { position:static; width:auto; margin:0 0 1rem; display:flex;
    align-items:center; gap:0.9rem; text-align:left; } .side-timer .timer-bar { flex:1; margin-top:0; } }

  .ready-row { display:flex; gap:0.7rem; justify-content:center; margin-top:1.2rem; flex-wrap:wrap; }
  .ready-chip { font-family:var(--font-display); font-size:0.85rem; font-weight:600; padding:0.5rem 0.9rem;
    border-radius:999px; border:1px solid var(--panel-line); color:var(--muted); }
  .ready-chip.is-ready { color:var(--ok); border-color:rgba(47,143,82,0.45); background:rgba(47,143,82,0.1); }
  .space-hint { margin:1.4rem auto 0; width:min(220px,80%); padding:0.9rem; text-align:center; border-radius:10px;
    border:1px solid var(--panel-line); background:rgba(43,29,18,0.035); font-family:var(--font-display);
    letter-spacing:0.08em; color:var(--muted); }
  .key-hint { margin-top:0.6rem; color:var(--muted); font-size:0.78rem; }

  /* 2026-10-06 레일 화면: 확보 보드는 "레일 위의 택배 4종". 종류마다 한 줄이고, 줄 가운데에 택배 상자(남은 개수 점 6개),
     내 자리 쪽(1번 = 왼쪽, 2번 = 오른쪽)에 내 버튼이 있다. 버튼을 누르면 내 화면에 그 종류의 미니게임이 뜬다.
     상대 쪽은 비워 둔다(상대가 뭘 하는지는 안 보인다 -- 남은 개수만 공유). 확정 층수 택배는 층이 곧 칸이라 버튼 대신 층 버튼 6개. */
  .board-grid { display:flex; flex-direction:column; gap:0; flex:1; min-height:0; overflow-y:auto; }
  .board-row { flex:1 1 0; min-height:96px; display:grid; grid-template-columns:minmax(0,1fr) minmax(210px,300px) minmax(0,1fr); align-items:stretch; padding:0.28rem 0; }
  .rail-side { display:flex; flex-direction:column; justify-content:center; gap:0.4rem; min-width:0; padding:0 0.7rem; }
  .rail-side.mine { align-items:stretch; }
  .rail-side.theirs { align-items:center; color:var(--muted); font-size:0.7rem; opacity:0.55; }
  .rail-mid { position:relative; display:flex; align-items:center; justify-content:center; padding:0.4rem 0.5rem;
    background:repeating-linear-gradient(180deg,#3b4049 0 14px,#2d3139 14px 18px); box-shadow:inset 0 0 0 3px #1f232b; }
  .rail-head + .board-row .rail-mid { border-radius:12px 12px 0 0; }
  .board-row:last-child .rail-mid { border-radius:0 0 12px 12px; }
  .rail-box { position:relative; width:100%; height:100%; min-height:78px; border-radius:12px; overflow:hidden; border:2px solid rgba(22,35,63,0.55);
    box-shadow:0 5px 10px rgba(0,0,0,0.4); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0.2rem; padding:0.3rem 0.4rem; text-align:center; }
  .rail-box .cell-art { position:absolute; inset:-25% -25%; z-index:0; background-repeat:no-repeat; background-position:center; background-size:cover; opacity:0.55; filter:blur(1px); }
  .rail-box::before { content:""; position:absolute; inset:0; z-index:1; background:linear-gradient(180deg,rgba(255,255,255,0.28),rgba(0,0,0,0.12)); }
  .rail-box > * { position:relative; z-index:2; }
  .rail-box .rb-name { display:inline-flex; align-items:center; gap:0.3rem; background:#f4f1ea; color:#20180f; border:2px solid #16233f; border-radius:6px;
    padding:0.12rem 0.5rem; font-family:var(--font-display); font-weight:800; font-size:0.8rem; line-height:1.15; }
  .rail-box .rb-name .cat-icon { width:15px; height:15px; flex:none; }
  .rail-box .rb-name .cat-icon svg { width:100%; height:100%; display:block; }
  .rail-box .rb-game { font-size:0.68rem; font-weight:700; color:#16233f; background:rgba(255,255,255,0.7); border-radius:999px; padding:0 0.45rem; }
  .rail-box .cat-left { font-family:var(--font-display); font-size:0.7rem; color:#16233f; font-weight:700; }
  .rail-box .cat-left b { font-size:0.9rem; }
  .rail-box .pips { display:flex; gap:4px; background:rgba(255,252,244,0.9); padding:3px 7px; border-radius:999px; }
  .rail-box .pip { width:10px; height:10px; border-radius:50%; background:var(--c); border:1.5px solid rgba(22,35,63,0.55); }
  .rail-box .pip.gone { background:transparent; border-style:dashed; opacity:0.45; }
  .rail-box .stamp { position:absolute; z-index:3; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-8deg); background:var(--danger); color:#fff;
    font-family:var(--font-display); font-weight:800; padding:0.15rem 0.8rem; border-radius:6px; white-space:nowrap; }
  .board-row.is-empty .rail-box { filter:grayscale(1); opacity:0.7; }
  .rail-btn { font:inherit; cursor:pointer; border:2px solid var(--c); border-bottom-width:5px; border-radius:12px; background:var(--panel); color:var(--ink);
    padding:0.5rem 0.6rem; display:flex; flex-direction:column; align-items:center; gap:0.1rem; font-family:var(--font-display); }
  .rail-btn:hover:not(:disabled) { background:#fff6df; }
  .rail-btn:active:not(:disabled) { transform:translateY(3px); border-bottom-width:2px; }
  .rail-btn:disabled { opacity:0.45; cursor:default; }
  .rail-btn .rbt { font-weight:800; font-size:0.9rem; }
  .rail-btn .rbp { font-size:0.7rem; color:var(--muted); font-weight:700; font-variant-numeric:tabular-nums; }
  .floor-btns { display:grid; grid-template-columns:repeat(3,1fr); gap:0.3rem; }
  .floor-btn { font:inherit; font-family:var(--font-display); font-weight:800; font-size:0.85rem; cursor:pointer; border:2px solid var(--c); border-bottom-width:4px; border-radius:9px;
    background:var(--panel); color:var(--ink); padding:0.28rem 0.1rem; }
  .floor-btn:hover:not(.is-gone) { background:#fff6df; }
  .floor-btn.is-gone { cursor:default; opacity:0.4; border-style:dashed; background:transparent; }
  .floor-btn.mine { opacity:1; background:var(--c); border-style:solid; display:flex; flex-direction:column; align-items:center; line-height:1.1; }
  .floor-btn.mine small { font-size:0.62rem; font-weight:700; }
  .my-chips { display:flex; flex-wrap:wrap; gap:0.25rem; justify-content:center; min-height:1.3rem; }
  .my-chip { background:#f4f1ea; color:#20180f; border:2px solid #16233f; border-radius:6px; font-family:var(--font-display); font-weight:700; font-size:0.74rem; padding:0 0.4rem; }
  .rail-side .mine-count { font-size:0.7rem; color:var(--muted); font-weight:700; text-align:center; }
  .rail-head { display:grid; grid-template-columns:minmax(0,1fr) minmax(210px,300px) minmax(0,1fr); font-family:var(--font-display); font-weight:700; font-size:0.78rem; color:var(--muted); padding-bottom:0.3rem; text-align:center; }
  .rail-head .me { color:var(--ink); }
  /* 2026-10-06: 폰/좁은 화면 -- 3열(내 자리|레일|상대 자리)은 안 들어가므로 한 줄을 2열(레일 상자 | 내 버튼)로 줄인다.
     상대 자리 열과 3열 머리글은 숨기고(어차피 비어 있음), 1번/2번 자리 모두 상자가 왼쪽, 내 버튼이 오른쪽. 세로로 길어지면 보드가 스크롤. */
  @media (max-width:860px) {
    .rail-head { display:none; }
    .board-grid { overflow-y:auto; }
    .board-row { flex:none; min-height:0; grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); gap:0.3rem; padding:0.2rem 0; }
    .board-row .rail-side.theirs { display:none; }
    .board-row .rail-mid { order:1; border-radius:12px; padding:0.35rem 0.4rem; }
    .board-row .rail-side.mine { order:2; padding:0 0.2rem; }
    .rail-box { min-height:92px; }
    .rail-btn { padding:0.6rem 0.4rem; }
    .rail-btn .rbt { font-size:0.85rem; }
  }


  /* ---------- 2026-10-07 레일 사이트(/rail): 공용 화면. 3열(1번 자리 | 레일 | 2번 자리)을 어느 폭에서도 유지한다. ---------- */
  body.rail-view { overflow:hidden; }
  body.rail-view #app { height:100vh; min-height:0; }
  .rv { height:100vh; display:flex; flex-direction:column; gap:clamp(0.4rem,1.2vh,0.9rem); padding:clamp(0.5rem,1.5vh,1.2rem) clamp(0.6rem,2vw,2rem) clamp(0.6rem,1.8vh,1.4rem); background:linear-gradient(180deg,var(--bg-deep),var(--bg) 22%); }
  .rv-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex:0 0 auto; }
  .rv-eyebrow { font-family:var(--font-display); font-size:0.7rem; letter-spacing:0.22em; text-transform:uppercase; color:var(--gold); font-weight:600; }
  .rv-head h1 { margin:0.1rem 0 0; font-size:clamp(1.1rem,3.2vh,1.8rem); font-weight:800; }
  .rv-chips { display:flex; gap:0.5rem; flex-wrap:wrap; justify-content:flex-end; }
  .rv-chip { padding:0.25rem 0.8rem; border-radius:999px; font-family:var(--font-display); font-weight:700; font-size:0.85rem; white-space:nowrap; }
  .rv-chip.phase { background:rgba(226,105,26,0.12); border:2px solid rgba(226,105,26,0.5); color:var(--gold); }
  .rv-chip.room { background:rgba(37,105,168,0.1); border:2px solid rgba(37,105,168,0.4); color:var(--sky); }
  .rv-clockrow { flex:0 0 auto; display:flex; align-items:center; gap:0.9rem; }
  .rv-clock-label { font-family:var(--font-display); font-weight:700; color:var(--muted); font-size:0.95rem; white-space:nowrap; }
  .rv-clockrow b { font-family:var(--font-display); font-size:clamp(1.6rem,6vh,3rem); font-variant-numeric:tabular-nums; line-height:1; min-width:3.4ch; }
  .rv-clockrow b.is-low { color:var(--danger); }
  .rv-bar { flex:1; height:0.8rem; border-radius:999px; background:rgba(43,29,18,0.1); overflow:hidden; }
  .rv-bar > i { display:block; height:100%; width:100%; background:var(--gold); border-radius:999px; transition:width 0.25s linear; }
  .rv-center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:1rem; }
  .rv-center h2 { margin:0; font-size:clamp(1.6rem,6vh,3rem); }
  .rv-center p { margin:0; color:var(--muted); font-size:1.1rem; }
  .rv-sides { display:flex; gap:1rem; margin-top:0.6rem; }
  .rv-code { font:inherit; font-family:var(--font-display); font-size:1.4rem; text-transform:uppercase; width:7ch; text-align:center; padding:0.3rem; border:2px solid var(--muted); border-radius:10px; background:var(--panel); color:var(--ink); }
  .rv-side { --c:#999; display:inline-flex; flex-direction:column; align-items:center; gap:0.1rem; padding:0.25rem 0.9rem; border-radius:12px; border:2px solid var(--c); background:var(--panel); color:var(--ink); font-family:var(--font-display); min-width:0; }
  .rv-side b { font-size:clamp(0.9rem,2.4vh,1.25rem); display:inline-flex; align-items:center; gap:0.35rem; }
  .rv-side .rv-side-icon { width:1.2em; height:1.2em; display:inline-flex; color:var(--c); }
  .rv-side .rv-side-icon svg { width:100%; height:100%; }
  .rv-side small { font-size:0.72rem; color:var(--muted); font-weight:700; }
  .rv-side.is-busy { background:var(--c); }
  .rv-side.is-busy, .rv-side.is-busy small { color:#fff; }
  .rv-board { overflow-y:auto; }
  body.rail-view .rail-head { display:grid; grid-template-columns:minmax(0,1fr) minmax(150px,260px) minmax(0,1fr); align-items:end; gap:0; padding-bottom:0.4rem; }
  body.rail-view .rail-head > .rv-side { justify-self:center; }
  body.rail-view .board-row { flex:1 1 0; min-height:84px; grid-template-columns:minmax(0,1fr) minmax(150px,260px) minmax(0,1fr); gap:0; padding:0.28rem 0; }
  body.rail-view .board-row .rail-mid { order:0; border-radius:0; }
  body.rail-view .rail-head + .board-row .rail-mid { border-radius:12px 12px 0 0; }
  body.rail-view .board-row:last-child .rail-mid { border-radius:0 0 12px 12px; }
  body.rail-view .board-row .rail-side.mine { order:0; padding:0 clamp(0.4rem,1.6vw,1.4rem); }
  body.rail-view .rail-btn { padding:clamp(0.4rem,1.6vh,1rem) 0.6rem; flex:1; justify-content:center; }
  body.rail-view .rail-btn .rbt { font-size:clamp(0.95rem,2.6vh,1.5rem); }
  body.rail-view .rail-btn .rbp { font-size:clamp(0.68rem,1.6vh,0.9rem); }
  body.rail-view .floor-btn { font-size:clamp(0.9rem,2.4vh,1.3rem); padding:clamp(0.3rem,1.2vh,0.7rem) 0.1rem; }
  .rail-btn.is-busy { animation:rv-pulse 1.2s ease-in-out infinite; }
  @keyframes rv-pulse { 50% { opacity:0.55; } }
  @media (prefers-reduced-motion: reduce) { .rail-btn.is-busy { animation:none; } }

  /* 플레이어 화면(레일 모드)의 대기 카드 */
  .rw { display:flex; flex-direction:column; gap:0.8rem; }
  .rw h2 { margin:0; font-size:1.3rem; }
  .rw-sub { margin:0; color:var(--muted); font-size:0.9rem; }
  .rw-sub b { color:var(--ink); }
  .rw-list { display:flex; flex-direction:column; gap:0.5rem; }
  .rw-row { --c:#ccc; display:grid; grid-template-columns:auto minmax(0,1.3fr) auto minmax(0,1fr); align-items:center; gap:0.7rem; padding:0.5rem 0.8rem; border-radius:12px; border:2px solid var(--c); background:var(--panel); }
  .rw-row.is-empty { opacity:0.5; }
  .rw-ico { width:24px; height:24px; display:inline-flex; }
  .rw-ico svg { width:100%; height:100%; }
  .rw-name { font-family:var(--font-display); font-weight:800; display:flex; flex-direction:column; line-height:1.15; }
  .rw-name small { font-weight:700; color:var(--muted); font-size:0.72rem; }
  .rw-left { font-family:var(--font-display); font-weight:700; font-size:0.85rem; white-space:nowrap; }
  .rw-left b { font-size:1.1rem; }
  .rw-mine { display:flex; flex-wrap:wrap; gap:0.25rem; justify-content:flex-end; }
  .rw-mine small { color:var(--muted); }
  @media (max-width:560px) { .rw-row { grid-template-columns:auto minmax(0,1fr) auto; } .rw-mine { grid-column:1 / -1; justify-content:flex-start; } }

  /* on genuinely short viewports, shrink the chrome around the board (topbar + side-timer) too --
     the board itself already fills whatever's left via grid-template-rows:1fr, but a smaller
     topbar/timer leaves it more room to work with before the overflow-y:auto fallback kicks in. */
  @media (max-height:700px) {
    .topbar { padding-top:0.5rem; padding-bottom:0.5rem; }
    .side-timer { top:4.6rem; padding:0.6rem 0.6rem; }
    .side-timer .timer-num { font-size:1.3rem; }
  }

  .overlay { position:fixed; inset:0; background:rgba(6,10,18,0.92); display:flex; align-items:center; justify-content:center;
    z-index:50; padding:1.2rem; }
  .overlay.hidden { display:none; }
  /* 2026-10-06: 화면 높이가 낮아도 그림 + 포기/완료 버튼이 한 화면에 들어오도록 폭을 높이 기준으로도 제한(그림 비율 16:9). */
  .puzzle-frame { max-width:960px; width:min(100%, calc((100vh - 8.5rem) * 16 / 9)); }
  .puzzle-frame img { width:100%; border-radius:12px; display:block; box-shadow:0 20px 60px rgba(0,0,0,0.5); }
  .puzzle-actions { display:flex; gap:0.8rem; margin-top:1rem; }
  .puzzle-actions .btn { flex:1; }

  .elev-layout { display:grid; grid-template-columns:220px 1fr; gap:1.2rem; align-items:start; }
  /* 2026-10-06: 폰/좁은 화면에서는 지금 해야 할 일(우선 택배 10초 창, 이동 버튼, 준비)이 담긴 오른쪽 카드를 위로 올린다 --
     안 그러면 층 게이지/내 택배 목록 밑으로 밀려서 10초 타이머가 도는 걸 화면 밖에서 놓친다. */
  @media (max-width:820px) { .elev-layout { grid-template-columns:1fr; } .elev-layout > div:last-child { order:-1; } }
  /* left column: gauge + my own package list stacked underneath it, so "what I'm carrying" reads
     right off the same glance as "where the car is" instead of living at the bottom of the far
     wider right-hand panel. */
  .elev-left { display:flex; flex-direction:column; gap:1rem; min-width:0; }
  .elev-left .player-col.me { max-width:none; }
  .elev-left .invoice { padding:0.5rem 0.6rem; gap:0.55rem; }
  .elev-left .invoice .meta .t { font-size:0.82rem; }
  .elev-left .invoice .sticker { font-size:0.68rem; padding:0.18rem 0.4rem; }
  /* Elevator position: a plain list of six floor rows with only the CURRENT one highlighted --
     no cumulative fill from the bottom. (An earlier version filled the whole area beneath the
     current floor like a level gauge; reverted per direct feedback -- it read as "progress" rather
     than "here is the car", which is the wrong metaphor once movement is real and instant per
     click.) */
  .shaft { background:var(--bg-deep); border-radius:14px; border:1px solid var(--panel-line); padding:1rem 0.8rem; }
  .shaft-track { display:flex; flex-direction:column-reverse; gap:0.4rem; }
  /* 2026-08-27 수정: 층수 숫자가 --muted(연한 갈색)라 --bg-deep(연한 탠) 위에서 잘 안 보인다는
     피드백 -- 비활성 층은 더 짙은 잉크색으로 대비를 올리고, 현재 층은 옅은 틴트 배경 대신 꽉 찬
     골드 배경 + 크림 글씨(버튼과 같은 언어)로 확실히 튀게 만들었다. */
  .floor-stop { display:flex; align-items:center; gap:0.5rem; padding:0.55rem 0.6rem; border-radius:8px;
    font-family:var(--font-display); font-weight:700; color:rgba(43,29,18,0.62); font-size:1.02rem;
    transition:background-color 160ms ease, color 160ms ease, transform 160ms ease; }
  .floor-stop.current { background:var(--gold); color:var(--gold-ink); font-weight:800;
    font-size:1.12rem; box-shadow:0 6px 16px rgba(226,105,26,0.45); transform:scale(1.03); }
  .floor-stop .car { width:11px; height:11px; border-radius:50%; background:transparent; flex-shrink:0;
    transition:background-color 160ms ease, box-shadow 160ms ease; }
  .floor-stop.current .car { background:var(--gold-ink); box-shadow:0 0 0 4px rgba(255,248,239,0.35); }
  .round-pill { display:inline-flex; align-items:center; gap:0.4rem; padding:0.3rem 0.8rem; border-radius:999px;
    background:rgba(37,105,168,0.12); color:var(--sky); font-family:var(--font-display); font-weight:600; font-size:0.85rem; }
  .vote-buttons { display:flex; flex-direction:column; gap:0.7rem; margin-top:1rem; }
  .round-result { background:rgba(47,143,82,0.1); border:1px solid rgba(47,143,82,0.28); border-radius:10px; padding:0.9rem 1rem; margin-top:0.8rem; }
  .delivered-callout { margin-top:0.6rem; display:flex; flex-direction:column; gap:0.35rem; }
  .delivered-callout.empty { color:var(--muted); font-size:0.85rem; }
  .delivered-item { display:flex; align-items:center; gap:0.5rem; font-size:0.88rem; }
  .delivered-item .swatch { width:9px; height:18px; border-radius:3px; flex-shrink:0; }

  .invoice-list { display:flex; flex-direction:column; gap:0.5rem; margin-top:0.7rem; }
  .invoice { display:flex; align-items:center; gap:0.7rem; padding:0.55rem 0.7rem; border-radius:9px; background:rgba(43,29,18,0.04); border:1px solid var(--panel-line); }
  .invoice.delivered { opacity:0.65; }
  .invoice .swatch { width:10px; height:34px; border-radius:4px; flex-shrink:0; }
  .invoice .meta { flex:1; }
  .invoice .meta .t { font-weight:700; font-size:0.88rem; }
  .invoice .meta .d { font-size:0.78rem; color:var(--muted); }
  .invoice .sticker { font-family:var(--font-display); font-size:0.72rem; font-weight:700; padding:0.2rem 0.5rem; border-radius:999px;
    background:var(--ok); color:#fff; white-space:nowrap; }
  .invoice .sticker.pending { background:transparent; color:var(--muted); border:1px dashed var(--panel-line); }

  .split-two { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  @media (max-width:720px) { .split-two { grid-template-columns:1fr; } }
  .player-col h3 { font-family:var(--font-display); font-size:0.95rem; margin:0 0 0.3rem; color:var(--muted); }
  .player-col.me h3 { color:var(--gold); }

  /* 우선 택배 지정 (엘리베이터 라운드 게이트 "idle"/"result"에 내장, 매 라운드 다시 고름) */
  .invoice.pickable { cursor:pointer; transition:background-color 120ms ease, border-color 120ms ease; }
  .invoice.pickable:hover { background:rgba(43,29,18,0.08); }
  .invoice.is-priority { border-color:var(--gold); background:rgba(226,105,26,0.1); }
  .invoice .priority-flag { font-family:var(--font-display); font-size:0.68rem; font-weight:700; color:var(--gold);
    border:1px solid rgba(226,105,26,0.5); border-radius:999px; padding:0.15rem 0.45rem; white-space:nowrap; }
  /* 2026-10-06: 우선 택배 지정은 게이트에 끼워 넣던 방식에서 전용 10초 창("priority" 상태)으로 분리됐다. */
  .priority-window { background:rgba(226,105,26,0.08); border:1px solid rgba(226,105,26,0.35); border-radius:12px;
    padding:0.9rem 1rem; margin-top:0.75rem; }
  .priority-window h4 { margin:0 0 0.3rem; font-family:var(--font-display); font-size:1rem; color:var(--gold); }
  .priority-window .pw-sub { color:var(--muted); font-size:0.85rem; margin-bottom:0.6rem; }
  .priority-window .pw-clock { display:flex; align-items:baseline; gap:0.6rem; margin-top:0.2rem; }
  .priority-window .pw-clock .time-left-big { margin-top:0; font-size:1.9rem; }
  .priority-window .timer-bar { margin:0.45rem 0 0.8rem; }
  /* 2026-10-13 개선 1단계: 층별 배송비 배율 표시, 결과 자동 진행 안내, 우선 지정 창 안의 택배도둑 영역 */
  .floor-stop .floor-mult { margin-left:auto; font-size:0.72rem; font-weight:800; padding:0.05rem 0.4rem; border-radius:999px; }
  .floor-stop .floor-mult.hi { background:rgba(47,158,110,0.18); color:#2F9E6E; }
  .floor-stop .floor-mult.lo { background:rgba(120,120,120,0.16); color:var(--muted); }
  .floor-stop.current .floor-mult { background:rgba(0,0,0,0.12); color:inherit; }
  .auto-advance { margin-top:0.6rem; font-size:0.9rem; color:var(--muted); font-weight:700; }
  .priority-window .thief-window.merged { margin-top:0.8rem; }
  .priority-window .pw-actions { margin-top:0.7rem; display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; }
  .priority-window .pw-actions .key-hint { margin:0; }

  /* same-floor 선택 (같은 층에 배송 대기 중인 내 택배가 2개 이상일 때, SAME_FLOOR_CHOICE_MS 동안) */
  .choice-box { background:rgba(226,105,26,0.08); border:1px solid rgba(226,105,26,0.3); border-radius:12px;
    padding:0.9rem 1rem; margin-top:0.75rem; }
  .choice-box h4 { margin:0 0 0.5rem; font-family:var(--font-display); font-size:0.95rem; color:var(--gold); }
  .choice-list { display:flex; flex-direction:column; gap:0.5rem; }
  .choice-list .invoice.chosen { border-color:var(--ok); background:rgba(47,143,82,0.14); }

  /* 택배도둑 배치 전용 시간 (후반 전용, "thief" 상태 -- 라운드 이동 전 독립된 전체 화면) */
  .thief-window { background:rgba(199,64,45,0.08); border:1px solid rgba(199,64,45,0.3); border-radius:12px;
    padding:0.9rem 1rem; margin-top:0.75rem; }
  .thief-window h4 { margin:0 0 0.5rem; font-family:var(--font-display); font-size:0.95rem; color:var(--danger); }
  .thief-floors { display:flex; flex-wrap:wrap; gap:0.4rem; }
  .thief-floors .btn { flex:none; padding:0.4rem 0.7rem; font-size:0.8rem; }

  /* halftime 전환 화면 */
  .halftime-box { text-align:center; max-width:480px; }
  .halftime-box h2 { font-family:var(--font-display); font-size:1.7rem; margin:0 0 0.6rem; color:var(--gold); }
  .halftime-scores { display:flex; gap:1rem; justify-content:center; margin:1rem 0; }
  .halftime-scores .chip { background:var(--panel); border:1px solid var(--panel-line); border-radius:12px;
    padding:0.7rem 1.1rem; font-family:var(--font-display); }
  .halftime-scores .chip .n { display:block; font-size:1.3rem; font-weight:700; color:var(--gold); font-variant-numeric:tabular-nums; }

  .score-table { width:100%; border-collapse:collapse; margin-top:0.6rem; }
  .score-table th, .score-table td { text-align:left; padding:0.45rem 0.5rem; border-bottom:1px solid var(--panel-line); font-size:0.85rem; }
  .score-table th { color:var(--muted); font-weight:600; font-family:var(--font-display); }
  .winner-banner { text-align:center; padding:1.4rem; font-family:var(--font-display); font-size:1.6rem; font-weight:700; color:var(--gold); }
  /* 2026-08-28: 종료 화면 "다시 시작" 게이트 -- 결과 표들 사이에서도 눈에 띄도록 가운데 정렬 + 폭 제한. */
  .restart-gate { max-width:420px; margin:0 auto 1.4rem; text-align:center; }
  /* 2026-10-06: 확보 미니게임 레이어. #app 바깥(body 직속)에 둔다 -- render()가 상태 브로드캐스트마다
     #app 전체를 innerHTML로 갈아엎기 때문에, 미니게임을 #app 안에 넣으면 상대가 택배를 확보하는 것 같은
     아무 브로드캐스트만 와도 진행 중이던 게임이 통째로 날아간다. 게임 자체의 스타일은 minigames.css. */
  #mg-layer { overflow-y:auto; align-items:flex-start; }
  #mg-layer .mg-wrap { margin:auto; width:100%; max-width:640px; }
  #mg-layer .mg-clock { text-align:center; margin:0 0 0.6rem; color:var(--bg); font-family:var(--font-display); font-size:0.9rem; letter-spacing:0.04em; }
  #mg-layer .mg-clock b { margin-left:0.35rem; font-size:1.15rem; color:var(--gold); font-variant-numeric:tabular-nums; }
  #mg-layer .mg-clock.low b { color:#ff7a66; }
  .cat-game { margin-top:0.15rem; font-size:0.68rem; font-weight:600; color:var(--muted); letter-spacing:0.02em; }
  .toast { position:fixed; left:50%; bottom:1.4rem; transform:translateX(-50%); background:var(--panel); border:1px solid var(--panel-line);
    padding:0.6rem 1.1rem; border-radius:999px; font-size:0.85rem; z-index:80; box-shadow:0 10px 30px rgba(0,0,0,0.4); }
</style>
</head><body>
<div id="app"></div>
<div class="overlay hidden" id="mg-layer"></div>
"""

APP_JS_TEMPLATE = r"""
(function () {
  "use strict";

  var TYPES = @@TYPES_JSON@@;
  // 2026-08-28: 전반/후반이 서로 다른 21장 퍼즐 이미지 세트를 쓴다 (build_client.py의 REF_DIR_1/
  // REF_DIR_2 참고). 보드 구조(id/catIdx/num)는 동일하고 src(이미지)만 다르므로 배열을 통째로
  // 두 벌 두고, cellMeta(id, half)가 half에 맞는 쪽에서 찾는다.
  var CELLS_1 = @@CELLS_1_JSON@@;
  var CELLS_2 = @@CELLS_2_JSON@@;
  var FLOORS = @@FLOORS_JSON@@;
  var ROOMS = @@ROOMS_JSON@@;
  // 2026-08-27 신설: 좌석 선택 화면에서 고르는 가상 택배사 5종 (game-data.js와 동일 -- 서버가
  // pickCourier에서 이 key 목록으로 유효성 검사도 한다). 실제 택배사 로고를 흉내내면 상표권
  // 문제가 있어서 완전 창작 브랜드로 대체했다 (HANDOVER.md 3.6 참고).
  var COURIERS = @@COURIERS_JSON@@;
  // COURIERS와 순서를 맞춘 손그림 flat 아이콘 (SVG, 순수 표시용이라 서버/game-data.js엔 없음).
  // 2026-08-28 리스킨: 사용자가 준 새 로고 세트에 맞춰 교체 (COURIERS 순서와 동일 -- 쿡방/천일배송/
  // 한짐택배/MZ로지스틱스/우체통안). 프라이팬+계란(쿡방), 다이아몬드 직인+바코드선(천일배송),
  // 방패+상자(한짐택배), 지그재그 화살표(MZ로지스틱스), 우편함(우체통안).
  var COURIER_ICONS = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="14" r="6"></circle><path d="M14.5 9.5L20 4"></path><circle cx="10" cy="14" r="2.1" fill="currentColor" stroke="none"></circle><path d="M6.5 8.2c.6-1.4 2-2.2 3.2-2.2"></path></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 7-7 7-7-7z"></path><path d="M8.7 10.6h6.6M8.7 13h4.6"></path></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"></path><rect x="9" y="10.2" width="6" height="4.6" rx="0.6"></rect><path d="M9 12.3h6"></path></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h13l-8 6h8l-9 6"></path></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10a6 6 0 0 1 12 0v6H6z"></path><path d="M4 16h16"></path><path d="M12 4v3"></path><rect x="8.5" y="11.5" width="7" height="2.4" rx="0.5" fill="currentColor" stroke="none"></rect></svg>'
  ];
  // catIdx로 인덱싱하는 종류별 보드-칸 배경 일러스트 (위 BOX_ART_DIR 참고). CELLS[].src(칸마다 다른
  // 퍼즐 이미지, 오버레이 전용)와는 별개 -- 이건 보드 위 21칸 자체의 배경으로 쓴다.
  var BOX_ART = @@BOX_ART_JSON@@;
  // 2026-08-27 리스킨: board-label 카드용 평평한 라인 아이콘 (TYPES 순서와 동일 -- 트럭/깨진 유리잔/
  // 보석/체크마크 건물). box_art/의 3D 박스 일러스트와는 다른, 손으로 그린 별도의 단순한 SVG -- 그
  // 일러스트는 라벨 카드 안에 아이콘 크기로 넣기엔 스타일이 안 맞아서(입체 박스 그림 vs 평면 라인
  // 아이콘), 참고 포스터의 "구분/요금" 카드가 쓰는 플랫 아이콘 언어에 맞춰 새로 그렸다.
  // 2026-10-22 (사용자 결정, 플레이 테스트 "비싼 것·안 비싼 것 구분이 어렵다"): 값어치 = 메달. 일반 = 동, 깨지기 쉬운 = 은, 귀중품 = 금.
  //   색만으로 구분하지 않게 글자(동/은/금) + 크기(금이 제일 큼) + 별 개수. 확정 층수(지금 안 나옴)는 메달 없음.
  // 2026-10-22 (사용자: "금·은·동 글자 말고 그 색의 택배 상자로, 글이 너무 많다"): 값어치 = 상자 색. 일반 = 동색 / 깨지기 쉬운 = 은색 / 귀중품 = 금색 상자.
  //   글자 없이 색 + 크기(금이 제일 큼) + 금은 반짝임. 확정 층수(지금 안 나옴)는 상자 없음.
  var MEDAL = [{ k: "동" }, { k: "은" }, { k: "금" }];
  var PBOX_SVG = '<svg viewBox="0 0 40 38" aria-hidden="true"><path class="bx-f" d="M4 12 L20 19 L20 35 L4 28 Z"/><path class="bx-s" d="M20 19 L36 12 L36 28 L20 35 Z"/><path class="bx-t" d="M4 12 L20 5 L36 12 L20 19 Z"/>'
    + '<path class="bx-tape" d="M11 8.9 L27 15.9 L27 21 L23 22.8 L23 17.6 L7.4 10.5 Z"/><path class="bx-o" d="M4 12 L20 5 L36 12 L36 28 L20 35 L4 28 Z M4 12 L20 19 L36 12 M20 19 L20 35"/></svg>';
  function medal(ci, extra) { var m = MEDAL[ci]; if (!m) return ''; return '<span class="pbox m' + ci + (extra ? ' ' + extra : '') + '" title="' + m.k + '색 택배">' + PBOX_SVG + '</span>'; }
  function medalTag(ci) { return MEDAL[ci] ? '<span class="pbox-tag">' + medal(ci, 'xl') + '</span>' : ''; }
  var CAT_ICONS = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="13" height="9"></rect><path d="M14 10h4l3 3v3h-7z"></path><circle cx="6" cy="18" r="1.6"></circle><circle cx="17" cy="18" r="1.6"></circle></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10l-1 8a4 4 0 0 1-8 0z"></path><path d="M12 11v6"></path><path d="M9 20h6"></path><path d="M9 5l2 3-2 2 3 2"></path></svg>',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l4.5-6h9L21 9"></path><path d="M3 9l9 12 9-12"></path><path d="M3 9h18"></path><path d="M9 3l3 6 3-6"></path></svg>',
    '<svg viewBox="0 0 26 22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="10" height="18"></rect><line x1="5" y1="6" x2="5" y2="6.01"></line><line x1="9" y1="6" x2="9" y2="6.01"></line><line x1="5" y1="10" x2="5" y2="10.01"></line><line x1="9" y1="10" x2="9" y2="10.01"></line><line x1="5" y1="14" x2="5" y2="14.01"></line><line x1="9" y1="14" x2="9" y2="14.01"></line><path d="M16 12l3 3 6-6"></path></svg>'
  ];
  var ELEVATOR_ROUNDS = @@ELEVATOR_ROUNDS@@;
  var SECURE_PHASE_MS = @@SECURE_PHASE_MS@@;
  var PRIORITY_MULTIPLIER = @@PRIORITY_MULTIPLIER@@;
  var SAME_FLOOR_CHOICE_MS = @@SAME_FLOOR_CHOICE_MS@@;
  var HALVES = @@HALVES@@;
  var THIEF_PLACE_MS = @@THIEF_PLACE_MS@@;
  var PRIORITY_PICK_MS = @@PRIORITY_PICK_MS@@;
  // 2026-10-13 개선 1단계(P1+P2) -- game-data.js 참고
  var FLOOR_REWARD_MULT = @@FLOOR_REWARD_MULT@@;
  var RESULT_AUTO_ADVANCE_MS = @@RESULT_AUTO_ADVANCE_MS@@;
  var MERGE_PRIORITY_THIEF = @@MERGE_PRIORITY_THIEF@@;
  // 2026-10-14 확보 단계 레이스 라운드 (game-data.js RACE_*). 레이스 모드인지는 서버 상태(state.race)로 판단한다.
  var RACE_MODE = @@RACE_MODE@@; // 안내 문구용 (실제 모드는 서버 상태 state.race로 판단 -- 서버를 RACE_MODE=0으로 띄우면 예전 방식)
  var RACE_PICK_MS = @@RACE_PICK_MS@@;
  var RACE_SECOND_MS = @@RACE_SECOND_MS@@;
  var RACE_CONSOLATION_MS = @@RACE_CONSOLATION_MS@@; // 2026-10-14 한 사람만 끝내면 1등이 고르고 이 시간 뒤 다른 사람도 무작위로 하나
  var RACE_STICKER_LEVEL = @@RACE_STICKER_LEVEL@@;
  var RACE_EXCLUDE_KINDS = @@RACE_EXCLUDE_KINDS@@;
  var RACE_HAS_FIRST_GAME = @@RACE_HAS_FIRST_GAME@@; // 2026-10-15: 첫 미니게임 없음(바로 택배 쌓기)이 기본 // 2026-10-15 레이스에서 빠지는 종류 (확정 층수)
  function kindOff(ci) { return !!RACE_MODE && RACE_EXCLUDE_KINDS.indexOf(TYPES[ci].key) >= 0; }
  // 2026-10-15 레일 화면 고르기 키: 왼쪽(1번) 자리 A S D, 오른쪽(2번) 자리 J K L (현장 물리 버튼을 이 키로 연결)
  // 2026-10-16: 택배가 5개까지 나온다 -- 1번 A S D F G / 2번 H J K L ;
  var RAIL_PICK_KEYS = { "1": ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG"], "2": ["KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"] };
  var RAIL_PICK_LABEL = { "1": ["A", "S", "D", "F", "G"], "2": ["H", "J", "K", "L", ";"] };
  var VOTING_MS = @@VOTE_MS@@, THIEF_PER_HALF = @@THIEF_PER_HALF@@; // 튜토리얼 문구용 (game-data.js)
  var ELEVATOR_JOLT = @@ELEVATOR_JOLT@@; // 2026-10-14 덜컹 (game-data.js)
  var BUILD_TAG = "@@BUILD_TAG@@"; // 배포 확인용 빌드 표시 (build_client.py가 빌드 시각을 넣는다 -- 화면 왼쪽 위 작은 글씨)
  // 송장 하나의 배송 성공 금액 (서버가 확보 순간 층 배율을 적용해 inv.reward에 박아 둔다 -- 예전 형식이면 종류 금액)
  function invReward(inv) { return typeof inv.reward === "number" ? inv.reward : TYPES[inv.catIdx].reward; }
  function floorMult(i) { return FLOOR_REWARD_MULT[i] == null ? 1 : FLOOR_REWARD_MULT[i]; }
  function multLabel(i) { var m = floorMult(i); return "x" + (Math.round(m * 10) / 10); }
  // 종류 금액의 층별 범위 ("1,750~3,250원" 식) -- 층이 아직 안 정해진 레일 버튼용
  function rewardRange(t) {
    var lo = Infinity, hi = -Infinity;
    FLOOR_REWARD_MULT.forEach(function (m) { var v = Math.round(t.reward * m); if (v < lo) lo = v; if (v > hi) hi = v; });
    if (lo === hi) return fmtWon(lo);
    return fmtWon(lo) + "~" + Math.abs(hi).toLocaleString("ko-KR") + "원";
  }

  // ---------- 2026-10-14 UI 리스킨: 빨간 택배 카트 틀 + 택배 요금표 (스타일은 ui_theme.css) ----------
  // 카트 틀: cartOpen(cls) + 내용 + cartClose(). 회색 화면(.cart-screen) 안에 기존 카드/레이아웃이 그대로 들어간다.
  function cartOpen(cls) {
    return '<div class="cart' + (cls ? ' ' + cls : '') + '"><span class="cart-door l"><i></i></span><span class="cart-door r"><i></i></span>'
      + '<div class="cart-body"><div class="cart-screen">';
  }
  function cartClose() {
    return '</div><div class="cart-base"><b></b><b></b></div></div><span class="cart-wheel l"></span><span class="cart-wheel r"></span></div>';
  }
  function cartWrap(inner, cls) { return cartOpen(cls) + inner + cartClose(); }

  // 택배 요금표 -- 사용자 제공 포스터(ui_art/ref/fee_poster_ref.png)를 HTML로 다시 그린 것. 숫자는 TYPES / FLOOR_REWARD_MULT에서.
  var FEE_UP_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 13V3M8.5 5.5 11 3l2.5 2.5"></path></svg>';
  var FEE_TRUCK_SVG = '<svg class="fee-truck" viewBox="0 0 74 40" aria-hidden="true"><rect x="24" y="2" width="48" height="27" rx="2" fill="#E2A65B" stroke="#7a4a1f" stroke-width="2"></rect>'
    + '<path d="M3 30V17l7-11h15v24z" fill="#6B3A12"></path><path d="M9 16l4-7h8v7z" fill="#cfe8ff"></path>'
    + '<rect x="1" y="28" width="72" height="4" rx="2" fill="#3b2a1e"></rect><circle cx="14" cy="33" r="5" fill="#222" stroke="#fff" stroke-width="2"></circle>'
    + '<circle cx="58" cy="33" r="5" fill="#222" stroke="#fff" stroke-width="2"></circle></svg>';
  function multsVary() { return FLOOR_REWARD_MULT.some(function (m) { return m !== 1; }); }
  function rewardRangePlain(t) {
    var vals = FLOOR_REWARD_MULT.map(function (m) { return Math.round(t.reward * m); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    return lo.toLocaleString("ko-KR") + "~" + hi.toLocaleString("ko-KR") + "원";
  }
  // withRange: 성공 칸 아래에 층별 금액 범위를 작게 (확보 보드의 작은 카드용 -- 포스터는 아래 안내에 배율을 따로 적는다)
  function feeTable(t, withRange) {
    return '<table class="fee-table"><thead><tr><th>구분</th><th>요금</th></tr></thead><tbody>'
      + '<tr><td>성공</td><td>' + fmtWon(t.reward) + (withRange && multsVary() ? '<small>층별 ' + rewardRangePlain(t) + '</small>' : '') + '</td></tr>'
      + '<tr><td>실패</td><td>' + fmtWon(-t.penalty) + '</td></tr></tbody></table>';
  }
  function feeName(catIdx, withUp) {
    return '<div class="fee-name"><span class="ico">' + CAT_ICONS[catIdx] + '</span>' + esc(TYPES[catIdx].name)
      + (withUp ? '<span class="up">' + FEE_UP_SVG + '</span>' : '') + '</div>';
  }
  function renderFeeMini(catIdx) {
    return '<div class="fee-mini fee-t' + catIdx + '">' + feeName(catIdx, false) + feeTable(TYPES[catIdx], true) + '</div>';
  }
  function renderFeePoster() {
    var html = '<div class="fee-poster"><div class="fee-head"><span class="fee-title">택배 요금표</span>' + FEE_TRUCK_SVG + '</div><div class="fee-road"></div>';
    html += '<div class="fee-cards">' + TYPES.map(function (t, i) {
      if (kindOff(i)) return '';
      return '<div class="fee-card fee-t' + i + '">' + feeName(i, true) + feeTable(t) + '</div>';
    }).join('') + '</div>';
    html += '<div class="fee-foot"><span class="i">i</span><div><ul>';
    if (multsVary()) {
      html += '<li>성공 요금은 <b>표의 요금 x 층 배율</b>이에요.<div class="fee-mults">'
        + FLOORS.map(function (f, i) { var m = floorMult(i); return '<span class="' + (m > 1 ? 'hi' : (m < 1 ? 'lo' : '')) + '">' + esc(f) + ' ' + multLabel(i) + '</span>'; }).join('')
        + '</div></li>';
    }
    if (setRuleOf(state).amount > 0) html += '<li><b>서로 다른 종류 ' + setRuleOf(state).kinds + '가지</b>를 배송하면 세트 보너스 <b>' + fmtWon(setRuleOf(state).amount) + '</b> (하프마다)</li>';
    html += '<li>전반에 획득한 송장은 전반에, 후반에 획득한 송장은 후반에 보내야 합니다.</li>'
      + '<li>모든 택배는 지정된 조건을 충족해야 정상적으로 처리됩니다.</li></ul></div></div></div>';
    return html;
  }
  // 확정 층수 택배를 제외한 나머지 종류는 칸 번호 대신 A/B/C/D/E로 표기한다 (사용자 요청, 2026-08-27: 대문자로 변경).
  var CELL_LETTERS = ["A", "B", "C", "D", "E", "F"];

  var ROOM = (new URLSearchParams(window.location.search).get("room") || "").trim().toUpperCase();
  // 2026-10-06: ?view=main 이면 "메인 모니터" 화면 -- 좌석을 잡지 않고 상태만 받아서 큰 화면으로 보여준다
  // (renderMain 참고). 서버 입장에서는 좌석 없는 관전 연결이라 게임 진행에는 아무 영향이 없다.
  var MAIN = /[?&]view=main(&|$)/.test(window.location.search);
  if (MAIN) document.body.classList.add("main-view");
  // 2026-10-07: /rail (또는 ?view=rail) 이면 "레일 사이트" -- 두 플레이어가 같이 보는 공용 화면. 좌석을 잡지 않고, 왼쪽(1번)/오른쪽(2번) 버튼을
  // 누르면 서버가 해당 플레이어의 기기에 그 종류의 미니게임을 띄운다 (renderRail 참고). 접속해 있는 동안 플레이어 화면은 레일 모드가 된다.
  var RAIL = window.location.pathname === "/rail" || /[?&]view=rail(&|$)/.test(window.location.search);
  if (RAIL) document.body.classList.add("rail-view");
  // 서버가 상태 메시지마다 실어 보내는 레일 정보 { count: 접속 중인 레일 화면 수, busy: {"1":bool,"2":bool} }.
  var railInfo = { count: 0, busy: { "1": false, "2": false } };
  // 서버 시계와 이 기기 시계의 차이 (서버가 상태 메시지마다 now를 실어 보낸다). 메인 모니터의 카운트다운에만 쓴다.
  var clockOffset = 0;
  function nowMs() { return Date.now() + clockOffset; }

  // ---------- identity: per-tab, survives a refresh (sessionStorage), but a second tab on the
  // same device gets its own id -- so two tabs can hold the two different seats without one
  // stealing the other's seat on reconnect. ----------
  function getClientId() {
    try {
      var id = sessionStorage.getItem("bp-client-id");
      if (!id) { id = "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("bp-client-id", id); }
      return id;
    } catch (e) { return "c-" + Math.random().toString(36).slice(2); }
  }
  var CLIENT_ID = getClientId();
  function mySeat() { try { return sessionStorage.getItem("bp-seat"); } catch (e) { return null; } }
  function setMySeat(s) { try { sessionStorage.setItem("bp-seat", s); } catch (e) {} }

  var state = null; // populated by the first "state" message from the server
  var local = { openCellId: null, toast: null, pending: {} };
  // 방금 완료 신호를 보낸 칸(서버 브로드캐스트가 오기 전) -- 종류 버튼이 같은 칸을 또 골라 중복 완료로 무시되는 걸 막는다.
  function markPending(id) { local.pending[id] = Date.now(); }
  var wsConnected = false;

  // half(1|2)로 전반/후반 이미지 세트를 고른다 -- id/catIdx/num은 두 세트가 동일하고 src(이미지)만 다르다.
  function cellMeta(id, half) {
    var arr = half === 2 ? CELLS_2 : CELLS_1;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  // ---------- scoring (pure display functions -- server owns deliveredRound/floorIdx/stolen, this
  // just formats them; no risk of drifting from the server since it's a pure fn of server data.
  // Must stay in exact sync with scoreInvoice/resultLabel/totalScore in game-room.js -- see
  // HANDOVER.md 4.3. ----------
  function scoreInvoice(inv) {
    var t = TYPES[inv.catIdx];
    if (inv.stolen) return -t.penalty;
    if (inv.lost) return 0; // 2026-10-16 같은 집 선점당함
    if (inv.returned) return -t.penalty; // 2026-10-16 반송
    if (inv.deliveredRound === null) return -t.penalty;
    var base = invReward(inv); // 2026-10-13: 층 배율 적용 금액 (game-room.js scoreInvoice와 동일)
    return inv.deliveredWasPriority ? base * PRIORITY_MULTIPLIER : base;
  }
  function resultLabel(inv) {
    // 2026-08-27: 도난당한 송장도 "미배송"으로 통합 표기 (사용자 요청 -- 배송이 안 됐으니까).
    // 페널티/소진 로직(scoreInvoice, deliveredRound 처리)은 그대로, 영구 라벨만 통일했다. 그 라운드의
    // 실시간 안내(renderDeliveredCallout의 "택배도둑에게 도난당했어요!")는 별개로 남겨둠.
    if (inv.lost) return "선점당함";
    if (inv.returned) return "반송";
    if (inv.stolen) return "미배송";
    return inv.deliveredRound === null ? "미배송" : "성공";
  }
  // 2026-10-15 종류 모으기 보너스 (game-room.js setBonusFor/deliveredKinds와 동일). st.setRule = { amount, kinds }
  function deliveredKinds(invs) {
    var k = {}; invs.forEach(function (inv) { if (!inv.stolen && inv.deliveredRound !== null) k[inv.catIdx] = true; });
    return Object.keys(k).length;
  }
  function setRuleOf(st) { return (st && st.setRule) || { amount: 0, kinds: 3 }; }
  function setBonusFor(invs, rule) { return rule && rule.amount > 0 && deliveredKinds(invs) >= rule.kinds ? rule.amount : 0; }
  function heldKinds(invs) { var k = {}; invs.forEach(function (inv) { k[inv.catIdx] = true; }); return k; }
  // 2026-10-16 건물 콤보 (game-room.js deliveredBuildings/buildingBonusFor와 같음)
  function deliveredBlds(invs) {
    var b = {}; invs.forEach(function (inv) { if (inv.stolen || inv.returned || inv.deliveredRound === null || !inv.unit) return; var u = (typeof unitById !== "undefined") && unitById[inv.unit]; if (u) b[u.b] = true; });
    return Object.keys(b).length;
  }
  function bldBonusFor(invs, wr) { return wr && wr.bldBonus > 0 && deliveredBlds(invs) >= 3 ? wr.bldBonus : 0; }
  function totalScore(seat, st) {
    var invs = st.players[seat].invoices;
    var wrong = (st.players[seat].wrong || 0) * ((st.wallRule && st.wallRule.wrongPenalty) || 0); // 2026-10-16 오배송 감점
    var blocks = (st.players[seat].blocks || 0) * ((st.wallRule && st.wallRule.blockReward) || 0); // 2026-10-16 막기 보상
    return invs.reduce(function (sum, inv) { return sum + scoreInvoice(inv); }, 0) + setBonusFor(invs, setRuleOf(st)) + bldBonusFor(invs, st.wallRule) - wrong + blocks;
  }
  function fmtWon(n) {
    var sign = n > 0 ? "+" : (n < 0 ? "-" : "");
    return sign + Math.abs(n).toLocaleString("ko-KR") + "원";
  }

  // ---------- websocket sync: the server is the single source of truth. every action is just a
  // fire-and-forget message; the resulting full state comes back (to everyone in the room) as
  // a broadcast, and render() runs off of that. no client-side reducers, no conflict handling,
  // no pending-action retry queue -- none of that machinery is needed once a real server owns
  // the state and processes messages one at a time. ----------
  var ws = null;
  function wsUrl() {
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + window.location.host + "/ws?room=" + encodeURIComponent(ROOM) + (RAIL ? "&role=rail" : (MAIN ? "&role=main" : ""));
  }
  function connectWS() {
    if (!ROOM) return;
    try { ws = new WebSocket(wsUrl()); } catch (e) { setTimeout(connectWS, 1500); return; }
    ws.onopen = function () {
      wsConnected = true;
      renderConnBanner();
      var seat = RAIL ? null : mySeat();
      ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID, seat: seat }));
      if (seat) ws.send(JSON.stringify({ type: "pick-seat", clientId: CLIENT_ID, seat: seat })); // reclaim after reconnect
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg) return;
      if (msg.type === "state") {
        // the elevator's floorIdx is now real, server-authoritative position -- every click (from
        // either player) already moves it for real before this broadcast goes out, so a plain
        // re-render is enough to show the car actually stepping; no client-side simulation needed.
        state = msg.state;
        if (typeof msg.now === "number") clockOffset = msg.now - Date.now();
        if (msg.rail) railInfo = msg.rail;
        // 2026-08-27: "pick-courier"는 좌석 번호를 클라이언트가 미리 못 정하므로(서버가 정해서
        // 돌려줌 -- game-room.js의 pickCourier), 낙관적으로 sessionStorage에 세팅하는 대신 여기서
        // 매 상태 브로드캐스트마다 "아직 내 좌석을 모르는 상태에서 내 clientId가 어느 좌석 주인이
        // 됐는지"를 확인해서 확정한다. 한 번 확정되면(mySeat() !== null) 더 이상 스캔 안 함.
        if (!mySeat()) {
          ["1", "2"].forEach(function (s) { if (state.seatOwners[s] === CLIENT_ID) setMySeat(s); });
        }
        render();
        dEvents(state);
        dLeadCheck(state);
        raceDoneFx(state);
        microSync();
        syncMiniGame();
      }
      else if (msg.type === "error") { handleWsError(msg); }
      else if (msg.type === "open-game") { onRailOpenGame(msg.cellId); }
    };
    ws.onclose = function () { wsConnected = false; renderConnBanner(); setTimeout(connectWS, 1200); };
    ws.onerror = function () {};
  }
  function send(action) {
    action.clientId = CLIENT_ID;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(action));
  }
  function handleWsError(msg) {
    if (msg.code === "seat_taken") {
      try { sessionStorage.removeItem("bp-seat"); } catch (e) {}
      showToast(seatName(msg.seat, state) + "는 이미 다른 사람이 선택했어요. 다시 골라주세요.");
      render();
    }
    else if (msg.code === "courier_taken") {
      showToast("바로 직전에 상대방이 그 택배사를 먼저 골랐어요. 다른 곳을 골라주세요.");
      render();
    }
    else if (msg.code === "room_full") {
      showToast("이 방은 이미 두 명이 다 찼어요.");
      render();
    }
  }
  function renderConnBanner() {
    var el = document.getElementById("conn-banner");
    if (wsConnected) { if (el) el.remove(); return; }
    if (el) return;
    var d = document.createElement("div");
    d.id = "conn-banner"; d.className = "conn-banner"; d.textContent = "서버와 연결이 끊겼어요 — 재연결 시도 중...";
    document.body.appendChild(d);
  }

  // ---------- rendering ----------
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  // Combines a floor + room slot into a single realistic-looking building room code, e.g.
  // "401호" (4F, slot 1) or "B03호" (B1, slot 3) -- floorIdx/room are still tracked separately
  // server-side (floorIdx drives elevator delivery-matching), this is purely a display format.
  function floorDigitLabel(floorIdx) {
    var f = FLOORS[floorIdx];
    return f === "B1" ? "B" : f.replace("F", "");
  }
  function roomCode(floorIdx, room) {
    return floorDigitLabel(floorIdx) + "0" + room + "호";
  }

  // ---------- 택배사(courier) 표시 이름 -- 2026-08-27 신설 ----------
  // "플레이어 1/2" 대신 화면 곳곳에서 좌석을 부를 때 이걸 쓴다. 아직 그 좌석이 택배사를 안 골랐으면
  // (게임 시작 전 극히 짧은 순간, 혹은 옛 상태 호환) "플레이어 N"으로 그냥 폴백한다.
  function courierByKey(key) {
    for (var i = 0; i < COURIERS.length; i++) if (COURIERS[i].key === key) return COURIERS[i];
    return null;
  }
  function seatName(seat, st) {
    var key = st && st.courierPick && st.courierPick[seat];
    var c = key ? courierByKey(key) : null;
    return c ? c.name : ("플레이어 " + seat);
  }

  // 시작(택배사 선택) 화면 뒤에 옅게 흩뿌리는 장식용 택배박스 라인아트 -- 2026-08-27 신설
  // (사용자 요청: "처음 시작 페이지에 택배박스 모양이 좀 그려져 있으면 좋을 것 같아"). 순수 장식이라
  // 클릭 불가(pointer-events:none)이고, 위치/크기/회전/색만 다른 같은 SVG 하나를 4번 찍는다.
  function renderLobbyBoxes() {
    var BOX_SVG = '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M6 14 20 8 34 14 34 30 20 36 6 30Z"></path><path d="M6 14 20 20 34 14M20 20V36"></path></svg>';
    function deco(style) { return '<span class="lobby-box-deco" style="' + style + '">' + BOX_SVG + '</span>'; }
    return deco('top:-4%;left:-3%;width:88px;height:88px;color:var(--gold);opacity:0.16;transform:rotate(-12deg);')
      + deco('top:60%;left:-6%;width:66px;height:66px;color:var(--sky);opacity:0.14;transform:rotate(9deg);')
      + deco('top:-7%;right:-2%;width:74px;height:74px;color:var(--ok);opacity:0.15;transform:rotate(13deg);')
      + deco('top:56%;right:-5%;width:92px;height:92px;color:var(--danger);opacity:0.12;transform:rotate(-9deg);');
  }

  function renderSeatPicker() {
    var picks = (state && state.courierPick) || { "1": null, "2": null };
    var myKey = null;
    ["1", "2"].forEach(function (s) { if (state && state.seatOwners[s] === CLIENT_ID) myKey = picks[s]; });
    var takenKeys = {};
    ["1", "2"].forEach(function (s) {
      if (picks[s] && state.seatOwners[s] !== CLIENT_ID) takenKeys[picks[s]] = true;
    });
    var roomFull = state && state.seatOwners["1"] && state.seatOwners["2"]
      && state.seatOwners["1"] !== CLIENT_ID && state.seatOwners["2"] !== CLIENT_ID;
    function courierBtn(c, i) {
      var taken = !!takenKeys[c.key];
      var mine = myKey === c.key;
      var disabled = taken || (roomFull && !mine);
      return '<button class="courier-btn' + (taken ? ' taken' : '') + (mine ? ' mine' : '') + '"'
        + ' style="--courier-color:' + c.color + '" data-action="pick-courier" data-courier="' + c.key + '"'
        + (disabled ? ' disabled' : '') + '>'
        + '<span class="courier-icon">' + COURIER_ICONS[i] + '</span>'
        + '<span class="courier-name">' + esc(c.name) + '</span>'
        + (taken ? '<span class="taken-note">이미 선택됨</span>' : (mine ? '<span class="taken-note">내 선택</span>' : ''))
        + '</button>';
    }
    return '<div class="center-screen">' + cartOpen('cart--pick') + '<div class="picker-scene">'
      + renderLobbyBoxes()
      + '<div class="seat-pick card">'
      + '<h2>어느 택배사 직원인가요?</h2>'
      + '<p>이 기기에서 플레이할 가상 택배사를 하나 골라주세요. 상대방이 먼저 고른 곳은 고를 수 없어요.</p>'
      + '<div class="courier-options">' + COURIERS.map(courierBtn).join('') + '</div>'
      + '<div class="room-share">이 방 코드: <strong>' + esc(ROOM) + '</strong><br>상대방에게는 지금 이 페이지의 링크를 그대로 보내주면 같은 방으로 들어와요.</div>'
      + '</div></div>' + cartClose() + '</div>';
  }

  function renderTopbar(st, seat) {
    var phaseLabel = { lobby: "대기 중", tutorial: "진행 방법", secure: "택배 확보", elevator: "엘리베이터", halftime: "하프타임", end: "결과" }[st.phase] || "";
    if (st.half && (st.phase === "secure" || st.phase === "elevator")) {
      phaseLabel += " · " + (st.half === 1 ? "전반" : "후반");
    }
    // 2026-10-14 (사용자 요청): 레이스 중 확보 남은 시간은 맨 위 줄 가운데에 (카트 안 오른쪽 위는 택배 고르기 남은 초 자리)
    var secureClock = (st.phase === "secure" && st.race && st.secureEndsAt)
      ? '<div class="tb-secure">확보 남은 시간 <b id="race-secure-clock">' + fmtClock(st.secureEndsAt - nowMs()) + '</b></div>' : '';
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live · ' + BUILD_TAG + '</span><h1>택배 배송 게임 — ' + phaseLabel + '</h1></div>'
      + secureClock
      + '<div class="right"><span class="room-chip">방 ' + esc(ROOM) + '</span>'
      + '<span class="seat-badge">' + (seat ? ("내 좌석 · " + seatName(seat, st)) : "택배사 미선택") + '</span></div></div>';
  }

  // ---------- 2026-10-15 시작 전 튜토리얼 (진행 방법) ----------
  // 서버 state.tutorial = { pages, page{좌석}, skip{좌석} }. 각자 Space/→ 다음, ← 이전, ↑ 건너뛰기(둘 다 눌러야). 둘 다 끝까지 보면 시작.
  var TUT_DEMO_EL = { floorIdx: 3, state: "voting", roundStartFloorIdx: 2, log: [], round: 1 };
  function tutParcel(ci, extra) {
    var t = TYPES[ci];
    return '<div class="race-parcel is-open tut-parcel fee-t' + ci + '"><span class="rp-ico">' + CAT_ICONS[ci] + '</span><span class="rp-name">' + esc(t.name) + '</span>'
      + '<span class="rp-amt">' + fmtWon(t.reward) + '</span>' + (extra || '<span class="rp-hint">층은 송장에서</span>') + '</div>';
  }
  var TUT_PAGES = [
    { t: "이렇게 진행돼요", v: function () {
        return '<div class="tut-flow"><span class="tut-step">① 택배 확보<small>' + Math.round(SECURE_PHASE_MS / 60000) + '분 · 먼저 끝내기 경주</small></span><i>→</i>'
          + '<span class="tut-step">② 엘리베이터<small>' + ELEVATOR_ROUNDS + '라운드 · 배송 줄다리기</small></span></div>'
          + '<div class="tut-flow sub"><span>전반</span><i>+</i><span>후반</span><i>=</i><span><b>총점 높은 사람 승리</b></span></div>'; },
      l: function () { return ["택배를 모아서, 하나뿐인 엘리베이터로 각자 송장의 층까지 배달해요.", "전반과 후반 두 번 반복해요."]; } },
    { t: "① 택배 확보 — 먼저 끝내기 경주", v: function () {
        return '<div class="tut-flow">' + (RACE_HAS_FIRST_GAME ? '<span class="tut-step">화면 미니게임<small>5종 중 하나 · 둘이 같은 게임</small></span><i>→</i>' : '')
          + '<span class="tut-step">택배 쌓기<small>레일 화면 문제를 실물 조각으로</small></span><i>→</i><span class="tut-step key">Space<small>투입!</small></span></div>'; },
      l: function () { return ["라운드마다 둘이 동시에 시작해요. 먼저 투입한 사람이 택배를 먼저 골라요.", "택배 쌓기 문제는 <b>레일 화면</b>에만 떠요."]; } },
    { t: "② 택배 고르기", v: function () {
        return '<div class="tut-parcels">' + tutParcel(0, '<span class="rp-floorbig">1F</span>') + tutParcel(1, '<span class="rp-floorbig">4F</span>') + tutParcel(2, '<span class="rp-floorbig">3F</span>') + '</div>'
          + '<div class="tut-keys">레일 앞 내 자리 버튼으로 고르기 · 왼쪽 <b>A</b><b>S</b><b>D</b> / 오른쪽 <b>J</b><b>K</b><b>L</b> · ' + Math.round(RACE_PICK_MS / 1000) + '초 안에</div>'; },
      l: function () { return ["<b>레일 화면</b>에 택배 3개가 종류·금액·<b>층</b>과 함께 떠요. 엘리베이터로 갈 층을 생각해서 골라요. 호실은 고르면 내 자리 송장에 나와요.",
          RACE_CONSOLATION_MS > 0 ? "늦은 사람도 상대가 고른 뒤 " + Math.round(RACE_CONSOLATION_MS / 1000) + "초 안에 투입하면 남은 것 중 고르고, 못 하면 무작위로 하나 받아요." : "늦은 사람은 마감 안에 투입하면 남은 것 중 골라요."]; } },
    { t: "③ 요금과 세트 보너스", v: function () {
        return '<div class="tut-fees">' + TYPES.map(function (_, ci) { return kindOff(ci) ? '' : renderFeeMini(ci); }).join('') + '</div>'; },
      l: function () { return ["배송에 성공하면 요금을 받고, 끝까지 못 보내면 감점이에요.",
          setRuleOf(state).amount > 0 ? "<b>서로 다른 종류 " + setRuleOf(state).kinds + "가지</b>를 배송하면 세트 보너스 <b>" + fmtWon(setRuleOf(state).amount) + "</b> · 상대가 뭘 모으는지도 보여요." : "비싼 택배일수록 실패 감점도 커요."]; } },
    { t: "④ 엘리베이터 줄다리기", v: function () {
        return '<div class="tut-elev"><div class="tut-bld">' + renderBuilding(TUT_DEMO_EL) + '</div><div class="tut-keys big"><b>▲</b> / <b>▼</b> 연타</div></div>'; },
      l: function () { return ["라운드마다 " + Math.round(VOTING_MS / 1000) + "초 동안 둘이 같이 엘리베이터를 위아래로 끌어요. 멈춘 층에 내 송장이 있으면 배송!",
          "상대 송장은 안 보여요 · 우선 택배로 지정하면 2배" + (ELEVATOR_JOLT ? " · 둘 다 눌렀는데 제자리면 <b>덜컹!</b>" : "")]; } },
    { t: "⑤ 후반엔 택배도둑", v: function () {
        return '<div class="tut-flow"><span class="tut-step">층에 도둑 숨기기<small>후반 · ' + THIEF_PER_HALF + '번까지</small></span><i>→</i>'
          + '<span class="tut-step">다음 라운드<small>상대가 그 층에서 배송하면</small></span><i>→</i><span class="tut-step bad">도난!<small>상대 감점</small></span></div>'; },
      l: function () { return ["상대가 어느 층으로 갈지 읽어서 숨겨 두세요.", "준비됐으면 Space! 두 사람이 다 보면 바로 시작해요."]; } },
  ];
  // 2026-10-16 벽 배송 규칙용 튜토리얼 (서버 wallRule이 있으면 이걸 쓴다 -- 4장, 서버 _startTutorial과 장 수를 맞춘다)
  var TUT_PAGES_WALL = [
    { t: "이렇게 진행돼요", v: function () {
        return '<div class="tut-flow"><span class="tut-step">① 택배 쌓기<small>' + Math.round(SECURE_PHASE_MS / 60000) + '분 · 먼저 끝내기 경주</small></span><i>→</i>'
          + '<span class="tut-step">② 배송<small>호실 버튼 누르기</small></span></div>'
          + '<div class="tut-flow sub"><span class="t1">빨간 팀</span><i>vs</i><span class="t2">파란 팀</span><i>=</i><span><b>전반+후반 배송 실적</b></span></div>'; },
      l: function () { return ["택배 쌓기로 택배를 따고, 송장에 적힌 집의 버튼을 눌러 배송해요.", "<b>콤보</b>: 모든 종류의 택배를 배송하면 +, 아파트·맨션·주택 세 곳에 다 배송하면 +"]; } },
    { t: "① 택배 쌓기", v: function () {
        return '<div class="tut-flow"><span class="tut-step">짧은 게임 = 조각 1개<small>바코드 스캔 · 송장 주소 · 테이프(← →) · 배달 길</small></span><i>→</i>'
          + '<span class="tut-step">판에 놓기<small>레일 화면 문제를 실물 조각으로</small></span><i>→</i><span class="tut-step key">Space<small>완성하면 투입!</small></span></div>'; },
      l: function () { return ["먼저 끝낸 사람이 <b>2개</b> 고르기 · 늦은 사람도 <b>20초 안에 완성하면 2개</b> 고르기, 못 하면 <b>무작위 1개</b>(남은 건 사라져요).", "조각 2개 문제는 택배 4개, 조각 3개 이상은 5개 · 택배마다 <b>주소</b>가 보여요."]; } },
    { t: "② 배송 — 집 버튼 누르기", v: function () {
        if (dPair()) return '<div class="tut-keys big">집마다 버튼 두 개 · <span class="t1"><b>빨간 버튼</b> 빨간 팀</span> · <span class="t2"><b>파란 버튼</b> 파란 팀</span> · 내 색 버튼을 누르세요</div>';
        return '<div class="tut-keys big">메인 컴퓨터 · <span class="t1"><b>Ctrl</b> 빨간 팀</span> · <span class="t2"><b>Shift</b> 파란 팀</span> 누른 채 + 호실 키</div>'; },
      l: function () { return ["집마다 배송 방법이 달라요: " + (state ? dHowShort(state) : ""), (function () { var w = (state && state.wallRule) || {}; return (dPair() ? "상대가 켠 집은 <b>내 색 버튼 5번</b>이면 반송" : "상대 배송은 켜진 호실 키를 <b>그냥 5번</b> 연타하면 반송") + (w.blockReward ? " + <b>막은 팀 보너스</b>" : "") + (w.contest ? " · <b>⚔</b> 두 팀 다 가진 집은 <b>먼저 보낸 팀만</b> 인정!" : ""); })()]; } },
    { t: "③ 아파트는 엘리베이터", v: function () {
        return '<div class="tut-keys big">메인 컴퓨터 · <b>↑</b> / <b>↓</b> 로 엘리베이터 움직이기 (누구나)</div>'; },
      l: function () { return ["아파트 집은 엘리베이터가 <b>그 층에 멈춰 있어야</b> 배송돼요. 움직이는 중엔 못 하고, 누르는 동안 움직이면 실패!", "맨션·주택은 엘리베이터와 상관없어요 · <b>마지막 15초는 FEVER</b> -- 배송 금액 2배!"]; } },
  ];
  function tutPages(st) { return (st && st.wallRule) ? TUT_PAGES_WALL : TUT_PAGES; }
  function tutPageHtml(st, pg) {
    var TUT_PAGES = tutPages(st);
    var p = TUT_PAGES[pg];
    return '<div class="tut-page"><div class="tut-num">' + (pg + 1) + ' / ' + TUT_PAGES.length + '</div><h2>' + p.t + '</h2>'
      + '<div class="tut-visual">' + p.v() + '</div>'
      + '<ul class="tut-lines">' + p.l().map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></div>';
  }
  function tutProgText(tt, sn) {
    if (tt.page[sn] >= tt.pages) return '다 봤어요';
    return (tt.skip[sn] ? '건너뛰기 · ' : '') + (tt.page[sn] + 1) + '/' + tt.pages + ' 보는 중';
  }
  function renderTutorial(st, seat) {
    var tt = st.tutorial;
    if (!tt) return '';
    var other = seat === "1" ? "2" : "1";
    var mine = tt.page[seat];
    var html = '<main class="stage">' + cartOpen('cart--tut') + '<div class="tut">';
    if (mine >= tt.pages) {
      html += '<div class="tut-page tut-wait"><h2>다 봤어요!</h2><p>' + esc(seatName(other, st)) + ' · ' + tutProgText(tt, other) + '</p>'
        + '<p class="tut-hint">두 사람이 다 보면 바로 택배 확보가 시작돼요</p></div>';
    } else {
      html += tutPageHtml(st, Math.min(mine, tutPages(st).length - 1));
    }
    html += '<div class="tut-dots">' + tutPages(st).map(function (_, i) { return '<i class="' + (i < mine ? 'seen' : '') + (i === mine ? ' now' : '') + '"></i>'; }).join('') + '</div>';
    html += '<div class="tut-actions">'
      + '<button class="btn" data-action="tutorial-prev"' + (mine <= 0 ? ' disabled' : '') + '>← 이전</button>'
      + (mine < tt.pages ? '<button class="btn primary" data-action="tutorial-next">' + (mine === tt.pages - 1 ? '다 봤어요 (Space)' : '다음 (Space)') + '</button>' : '')
      + '<button class="btn' + (tt.skip[seat] ? ' ok' : '') + '" data-action="tutorial-skip">' + (tt.skip[seat] ? '건너뛰기 누름 ✓' : '↑ 건너뛰기') + '</button>'
      + '</div>'
      + '<div class="tut-other">' + esc(seatName(other, st)) + ' · ' + tutProgText(tt, other) + ' · 건너뛰기는 둘 다 눌러야 돼요</div>';
    html += '</div>' + cartClose() + '</main>';
    return html;
  }

  function renderLobby(st, seat) {
    var otherSeat = seat === "1" ? "2" : (seat === "2" ? "1" : null);
    var mine = seat ? !!st.ready[seat] : false;
    var other = otherSeat ? !!st.ready[otherSeat] : false;
    return '<main class="stage"><div class="center-screen"><div class="cart-lobby">' + cartOpen('cart--lobby') + '<div class="lobby-box card">'
      + '<h2>택배 배송 게임</h2>'
      + '<p>두 사람 모두 이 페이지를 열고 좌석을 선택한 뒤, 각자 자기 키보드의 <strong>스페이스바</strong>를 누르면 준비 완료예요.<br>'
      + (RACE_MODE
        ? '둘 다 준비되면 3분 동안 <b>택배 확보 레이스</b>: 레일에 택배 3개가 올라오면 <b>송장 붙이기 → 택배 쌓기 → 투입</b>! 먼저 끝낸 사람이 먼저 고르고, 늦은 사람은 남은 것 중에서 골라요. 고르면 내 자리에 송장(층·금액)이 나와요. 그다음 엘리베이터 라운드(총 ' + ELEVATOR_ROUNDS + '라운드)로 배송해요.</p>'
        : '둘 다 준비되면 자동으로 시작하고, 최대 3분 동안(택배가 다 떨어지면 일찍 끝나요) 택배 확보 미니게임을 진행한 뒤 자동으로 엘리베이터 라운드(총 ' + ELEVATOR_ROUNDS + '라운드)로 넘어가요.</p>')
      + '<div class="ready-row">'
      + '<span class="ready-chip' + (mine ? ' is-ready' : '') + '">나 · ' + (seat ? seatName(seat, st) : "-") + (mine ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
      + '<span class="ready-chip' + (other ? ' is-ready' : '') + '">' + (otherSeat ? seatName(otherSeat, st) : "-") + (other ? ' · 준비 완료' : ' · 대기 중') + '</span>'
      + '</div>'
      + '<div class="space-hint">Space</div>'
      + '</div>' + cartClose() + renderFeePoster() + '</div></div></main>';
  }

  // ---------- 공유 보드 헬퍼 (2026-10-06) ----------
  function boardCell(st, id) {
    var b = st.board || [];
    for (var i = 0; i < b.length; i++) if (b[i].id === id) return b[i];
    return null;
  }
  function boardLeft(st, catIdx) {
    var n = 0, b = st.board || [];
    for (var i = 0; i < b.length; i++) if (b[i].catIdx === catIdx && !b[i].taken) n++;
    return n;
  }
  // 이 칸을 지금 눌러서 확보할 수 있는가. 확정 층수 택배는 그 층(칸)이 비어 있어야 하고, 나머지 종류는 같은 종류
  // 빈 칸이 하나라도 있으면 된다(서버가 대신 빈 칸을 준다). 반환: null이면 가능, 아니면 사유 문구.
  function cellBlockedReason(st, cellId) {
    if (!st || st.phase !== "secure") return "확보 시간이 끝났어요";
    var c = boardCell(st, cellId);
    if (!c) return "확보 시간이 끝났어요";
    var t = TYPES[c.catIdx];
    if (t.fixedFloor) return c.taken ? "다른 사람이 먼저 확보한 층이에요" : null;
    return boardLeft(st, c.catIdx) > 0 ? null : "이 종류 택배가 모두 소진됐어요";
  }

  // ---------- 2026-10-14 확보 단계 레이스 라운드 화면 ----------
  // 흐름: 가려진 택배 2개 -> 둘이 동시에 송장 붙이기(#mg-layer의 디지털 미니게임) -> 실물 우봉고(같은 문제, 이 화면에 그림 + 투입 버튼)
  //   -> 먼저 투입한 사람이 공개된 2개 중 하나를 고름(← / → 또는 클릭, RACE_PICK_MS) -> 늦은 사람은 RACE_SECOND_MS 안에 투입하면 남은 것.
  // 상대의 진행 단계(송장/우봉고/투입)는 보인다 -- "같이 겨룬다"는 느낌. 상대 송장 내용은 여전히 안 보인다.
  function raceOther(seat) { return seat === "1" ? "2" : "1"; }
  // 2026-10-14: 라운드 첫 게임은 RACE_GAME_POOL 중 무작위(r.game). 단계 이름 "sticker"는 그대로지만 화면엔 그 게임 이름을 쓴다.
  function raceGameKind(r) { return (r && r.game && MiniGames.KINDS[r.game]) ? r.game : "sticker"; }
  function raceGameName(r) { return MiniGames.KINDS[raceGameKind(r)].name; }
  // 택배 쌓기 문제는 레일 화면(관전)에 하나만 -- 누군가 첫 게임을 끝낸 순간부터 결과 공개 전까지
  function racePuzzleOpen(r) {
    if (r.status === "reveal") return false;
    return !!r.first || ["1", "2"].some(function (s) { return r.stage[s] === "ubongo" || r.stage[s] === "done" || r.stage[s] === "pieces"; });
  }
  function raceCount(endsAt, prefix, suffix) {
    return '<b class="race-count" data-ends="' + endsAt + '" data-prefix="' + esc(prefix || '') + '" data-suffix="' + esc(suffix || '') + '">'
      + (prefix || '') + Math.max(0, Math.ceil((endsAt - nowMs()) / 1000)) + (suffix || '') + '</b>';
  }
  var RACE_KEYS = ["←", "↑", "→"]; // 택배 3개 고르기 키 (현장 물리 버튼과 같은 배치)
  // 레일 화면이 접속해 있으면 고르기는 레일에서 (플레이어 화면은 안내만). 레일이 없으면 예전처럼 내 화면에서.
  function railPicks() { return !RAIL && !MAIN && railInfo && railInfo.count > 0; }
  // 2026-10-16 몫 계획(r.plan): picks가 좌석별 배열. 먼저 끝낸 사람만 r.plan.first개까지 고르고, 나머지는 늦은 사람에게 자동으로 간다.
  function rOwner(r, i) {
    if (r.plan) return r.picks["1"].indexOf(i) >= 0 ? "1" : (r.picks["2"].indexOf(i) >= 0 ? "2" : null);
    return r.picks["1"] === i ? "1" : (r.picks["2"] === i ? "2" : null);
  }
  function rRestCount(r) { var n = 0; r.pair.forEach(function (_, i) { if (!rOwner(r, i)) n++; }); return n; }
  function itAddrHtml(it) {
    if (it.unit && unitById[it.unit]) { var u = unitById[it.unit]; return '<span class="rp-floorbig rp-addr">' + (WALL.war ? '' : '<small>' + esc(bShort(u.b)) + '</small>') + esc(u.b === "apt" ? u.floor + "층 " + u.label : u.label.replace("성수로 ", "성수로 ")) + '</span>'; }
    return '<span class="rp-floorbig">' + esc(FLOORS[it.floorIdx] || '') + '</span>';
  }
  function raceCanPick(r, seat) {
    if (r && r.plan) {
      if (!seat || r.status !== "picking" || rRestCount(r) <= 0) return false;
      if (r.first === seat) return r.picks[seat].length < r.plan.first;
      // 2026-10-21 늦은 사람: 1등이 다 고른 뒤, 시간 안에 직접 완성했으면 late개까지
      var lateN = r.plan.late != null ? r.plan.late : 0;
      return !!r.first && r.picks[r.first].length >= r.plan.first && r.stage[seat] === "done" && !(r.randomPick && r.randomPick[seat]) && r.picks[seat].length < lateN;
    }
    if (!seat || r.status !== "picking" || r.picks[seat] !== null) return false;
    if (r.first === seat) return true;
    return r.picks[r.first] !== null && r.stage[seat] === "done";
  }
  // 택배는 종류만 보인다. 층·금액은 고른 사람 자기 자리 송장(raceSlip)에만.
  function raceParcel(st, r, it, i, seat) {
    var owner = rOwner(r, i);
    var left = r.status === "reveal" && !owner;
    var canPick = !owner && raceCanPick(r, seat) && !railPicks();
    var t = TYPES[it.catIdx];
    var cls = 'race-parcel is-open fee-t' + it.catIdx + (owner ? ' is-owned' : '') + (left ? ' is-gone' : '') + (canPick ? ' can-pick' : '') + (owner && owner === seat ? ' is-mine' : '');
    var inner = medalTag(it.catIdx) + (WALL.war ? '' : '<span class="rp-ico">' + CAT_ICONS[it.catIdx] + '</span><span class="rp-name">' + esc(t.name) + '</span>')
      + '<span class="rp-amt">' + (multsVary() ? '기본 ' : '') + fmtWon(t.reward) + '</span>'
      // 2026-10-15: 확정 층수 택배만 층을 미리 보여 준다 (이름 그대로 층이 정해진 택배). 나머지는 송장이 나와야 안다.
      // 2026-10-15: 층을 보고 고른다 -- 모든 택배의 층을 카드에 크게 (호실은 송장에서)
      + itAddrHtml(it);
    // 종류 모으기: 이걸 가져가면 내 세트가 완성되는지 / 상대 세트를 막는지 (가진 종류 기준 -- 보너스는 배송해야 받는다)
    var rule = setRuleOf(st);
    if (!owner && !left && rule.amount > 0) {
      var viewer = seat || null;
      var tags = [];
      ["1", "2"].forEach(function (s) {
        var hk = heldKinds(st.players[s].invoices), n = Object.keys(hk).length;
        if (!hk[it.catIdx] && n + 1 >= rule.kinds && n < rule.kinds) {
          if (viewer) tags.push(s === viewer ? '<span class="rp-set mine">세트 완성!</span>' : '<span class="rp-set block">상대 세트 막기</span>');
          else tags.push('<span class="rp-set">' + esc(seatName(s, st)) + ' 세트 완성</span>');
        }
      });
      inner += tags.join('');
    }
    if (owner) inner += '<span class="rp-owner seat-' + owner + '">' + esc(seatName(owner, st)) + ' 획득</span>';
    else if (left) inner += '<span class="rp-owner gone">' + (r.plan ? '사라짐' : '레일로 돌아감') + '</span>';
    else if (canPick) inner += '<span class="rp-owner pick">' + (r.plan ? (i + 1) : (RACE_KEYS[i] || '')) + ' 고르기</span>';
    return canPick ? '<button class="' + cls + '" data-action="race-pick" data-idx="' + i + '">' + inner + '</button>'
      : '<div class="' + cls + '">' + inner + '</div>';
  }
  // 자기 자리에서 나오는 송장 (고른 사람 화면에만)
  function raceSlip(st, r, seat) {
    if (r.plan) {
      var ids = (r.invoiceIds && r.invoiceIds[seat]) || [];
      if (!ids.length) return '';
      var invs = st.players[seat].invoices.filter(function (v) { return ids.indexOf(v.id) >= 0; });
      local.raceSlipSeenSet = local.raceSlipSeenSet || {};
      return '<div class="race-slips">' + invs.map(function (inv) {
        var isNew2 = !local.raceSlipSeenSet[inv.id]; local.raceSlipSeenSet[inv.id] = 1;
        return '<div class="race-slip fee-t' + inv.catIdx + (isNew2 ? ' is-new' : '') + '"><div class="rs-bar">송장</div>' + medalTag(inv.catIdx)
          + '<div class="rs-room">' + esc(invAddr(inv)) + '</div><div class="rs-amt">' + fmtWon(invReward(inv)) + '</div></div>';
      }).join('') + '</div>';
    }
    var id = r.invoiceIds && r.invoiceIds[seat];
    if (!id) return '';
    var inv = null;
    st.players[seat].invoices.forEach(function (v) { if (v.id === id) inv = v; });
    if (!inv) return '';
    var t = TYPES[inv.catIdx];
    // 출력 애니메이션은 처음 한 번만 (상태가 올 때마다 다시 그리므로, 매번 붙이면 계속 처음부터 다시 나온다)
    var isNew = local.raceSlipSeen !== id;
    local.raceSlipSeen = id;
    return '<div class="race-slip fee-t' + inv.catIdx + (isNew ? ' is-new' : '') + '"><div class="rs-bar">송장 출력</div>' + medalTag(inv.catIdx)
      + '<div class="rs-name"><span class="rp-ico">' + CAT_ICONS[inv.catIdx] + '</span>' + esc(t.name) + '</div>'
      + '<div class="rs-room">' + esc(invAddr(inv)) + '</div>'
      + '<div class="rs-floor">' + esc(FLOORS[inv.floorIdx]) + (floorMult(inv.floorIdx) !== 1 ? ' <small>' + multLabel(inv.floorIdx) + '</small>' : '') + '</div>'
      + '<div class="rs-amt">' + fmtWon(invReward(inv)) + '</div>'
      + '<div class="rs-code">||| ||||| || |||| ||| |||||</div></div>';
  }
  function raceLane(st, r, s, isMe) {
    var stg = r.stage[s];
    // 2026-10-15: 첫 게임이 없으면(기본) 택배 쌓기 > 투입 두 단계
    // 2026-10-22: 공개 규칙 -- 조립 중이라는 단계는 따로 보여 주지 않고 "조각 n/n"으로. 남은 조각 하나면 "완성 임박".
    var stp = stg === "ubongo" ? "pieces" : stg;
    var steps = r.pieceGames ? [["pieces", "조각 " + (stg === "ubongo" ? r.need : (r.got ? r.got[s] : 0)) + "/" + r.need + (raceImminent(r, s) ? " · 완성 임박" : "")], ["done", "완성"]]
      : r.game ? [["sticker", raceGameName(r)], ["ubongo", "택배 쌓기"], ["done", "투입"]] : [["ubongo", "택배 쌓기"], ["done", "투입"]];
    if (r.randomPick && r.randomPick[s] && r.pieceGames) stp = "pieces"; // 시간 초과로 받은 사람은 "완성"으로 칠하지 않는다
    var idx = -1; steps.forEach(function (sp, k) { if (sp[0] === (r.pieceGames ? stp : stg)) idx = k; });
    var last = steps.length - 1;
    var html = '<div class="race-lane' + (isMe ? ' me' : '') + (stg === "out" ? ' is-out' : '') + (raceImminent(r, s) ? ' imminent' : '') + '"><span class="rl-name">' + (isMe ? '나 · ' : '') + esc(seatName(s, st))
      + (r.first === s ? ' <em>1등</em>' : '') + '</span><span class="rl-steps">';
    steps.forEach(function (sp, k) {
      html += '<span class="rl-step' + (k < idx || (k === last && idx === last) ? ' done' : '') + (k === idx && idx < last ? ' now' : '') + '">' + sp[1] + '</span>';
      if (k < last) html += '<i class="rl-arrow">›</i>';
    });
    var dsec = raceDoneSec(r, s);
    html += '</span>' + (stg === "out" ? '<span class="rl-out">이번 라운드 탈락</span>' : '') + (dsec != null ? '<span class="rl-time">완성 ' + raceTime(dsec) + '</span>' : (r.randomPick && r.randomPick[s] ? '<span class="rl-out">시간 초과</span>' : ''));
    // 2026-10-15 종류 모으기: 이번 하프에 가진 종류 (공개 정보 -- 상대가 뭘 노리는지 보이게)
    var rule = setRuleOf(st);
    if (rule.amount > 0) {
      var hk = heldKinds(st.players[s].invoices), n = Object.keys(hk).length;
      html += '<span class="rl-set' + (n >= rule.kinds ? ' full' : '') + '" title="모은 종류">' + TYPES.map(function (t, ci) {
        return '<i class="rl-kind fee-t' + ci + (hk[ci] ? ' on' : '') + '">' + CAT_ICONS[ci] + '</i>';
      }).join('') + '<b>' + Math.min(n, rule.kinds) + '/' + rule.kinds + '</b></span>';
    }
    html += '</div>';
    return html;
  }
  // ---- 2026-10-21 테스트 1: 상대 진행도를 내 화면에 (미니게임 카드 위 / 택배 쌓기 중 화면) ----
  //   값: 조각 수(0~need) → 판 맞추는 중(need + 0.5) → 투입(need + 1). 상대가 앞서면 강조.
  // 2026-10-21 (사용자 규칙 "상대 진행도 공개"): 완성 시각 = 라운드 시작부터 투입까지 (서버 시계)
  function raceDoneSec(r, s) { return r.finishedAt && r.finishedAt[s] && r.t0 ? (r.finishedAt[s] - r.t0) / 1000 : null; }
  function raceGapHtml(r, seat) {
    var a = raceDoneSec(r, "1"), b = raceDoneSec(r, "2");
    if (a == null || b == null) return '';
    var fast = a <= b ? "1" : "2", gap = Math.abs(a - b).toFixed(1);
    if (!seat) return esc(TEAM[fast]) + '이 ' + gap + '초 먼저';
    return fast === seat ? '내가 ' + gap + '초 먼저 완성!' : '상대가 ' + gap + '초 먼저 완성';
  }
  // 2026-10-22 (사용자 제안 1) 완성 임박: 남은 조각이 하나일 때. 단 조각 2개 문제는 1/2부터 임박이면 너무 이르니 2/2(다 모음)일 때.
  function raceImminent(r, s) {
    if (!r || !r.pieceGames) return false;
    var need = r.need || 0, st = r.stage[s];
    if (st === "ubongo") return true;
    return st === "pieces" && need >= 3 && r.got && r.got[s] === need - 1;
  }
  function raceTime(sec) { var m = Math.floor(sec / 60), x = sec - m * 60; return (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + Math.floor(x); }
  function raceGapTxt(g) { return (g < 10 ? g.toFixed(1) : Math.round(g)) + '초'; }
  // 2026-10-22 (사용자 제안 2) 퍼즐 완성 순위 -- 점수 없음, 기록만. 늦은 사람이 시간 안에 못 하면 "시간 초과".
  function raceRankHtml(st, r) {
    var rows = ["1", "2"].map(function (s) { return { s: s, t: raceDoneSec(r, s) }; });
    rows.sort(function (a, b) { if (a.t == null) return 1; if (b.t == null) return -1; return a.t - b.t; });
    var first = rows[0];
    return '<div class="race-rank">' + '<div class="rr-title">퍼즐 완성 기록</div>' + rows.map(function (x, k) {
      var sub = k === 0 ? (x.t != null ? '선택 우선권' : '') : (x.t == null ? ((r.randomPick && r.randomPick[x.s]) ? '시간 초과 · 무작위 받기' : '포기') : (first.t != null ? raceGapTxt(x.t - first.t) + ' 차이' : ''));
      return '<div class="rr-row t' + x.s + (k === 0 ? ' win' : '') + '"><b class="rr-pos">' + (x.t == null ? '—' : (k + 1) + '위') + '</b><span class="rr-name">' + esc(seatName(x.s, st)) + '</span>'
        + '<span class="rr-time">' + (x.t != null ? '퍼즐 완성 ' + raceTime(x.t) : '미완성') + '</span><span class="rr-sub">' + sub + '</span>'
        + '<span class="rr-got">' + r.picks[x.s].length + '개</span></div>';
    }).join('') + '</div>';
  }
  function raceProg(r, s) { var st = r.stage[s]; if (st === "done") return (r.need || 0) + 1; if (st === "ubongo") return (r.need || 0) + 0.5; if (st === "out") return -1; return r.got ? r.got[s] : 0; }
  function raceVsRow(st, r, s, me) {
    var need = r.need || 0, got = r.got ? r.got[s] : 0, stg = r.stage[s], dots = '';
    var immP = stg === "pieces" && need >= 3 && got === need - 1; // 남은 조각 하나: 빈 마지막 칸을 깜빡
    for (var k = 0; k < need; k++) dots += '<i class="vs-dot' + (k < got || stg === "ubongo" || stg === "done" ? ' on' : (immP && k === got ? ' last' : '')) + '"></i>';
    // 공개 규칙: 조각 수와 완성 여부·완성 시각만 (조립 상태·게임 종류는 보여 주지 않음)
    var ds = raceDoneSec(r, s);
    var imm = raceImminent(r, s);
    var label = stg === "done" ? '완성 · ' + (ds != null ? raceTime(ds) : '') : stg === "out" ? '포기' : '조각 ' + (stg === "ubongo" ? need : got) + '/' + need + (imm ? ' · 완성 임박' : '');
    return '<div class="vs-row t' + s + (me ? ' me' : ' opp') + (imm ? ' imminent' : '') + (stg === "done" ? ' done' : '') + '" data-vs="' + s + '">'
      + '<span class="vs-name">' + (me ? '나' : '상대') + '</span><span class="vs-dots">' + dots + '<i class="vs-board' + (stg === "done" ? ' on' : '') + '">완성</i></span>'
      + '<b class="vs-lab">' + label + '</b></div>';
  }
  function raceVsHtml(st, r, seat) {
    if (!r || !r.pieceGames || !seat || r.status === "reveal") return '';
    var o = raceOther(seat), a = raceProg(r, seat), b = raceProg(r, o), msg = '', cls = '';
    if (r.stage[o] === "done" && r.stage[seat] === "done") { msg = raceGapHtml(r, seat); cls = raceDoneSec(r, seat) <= raceDoneSec(r, o) ? 'ahead' : 'behind'; }
    else if (r.stage[o] === "done" && r.stage[seat] !== "done") { msg = '상대가 먼저 완성했어요!'; cls = 'behind'; }
    else if (raceImminent(r, o) && !raceImminent(r, seat)) { msg = r.stage[o] === "ubongo" ? '상대가 조각을 다 모았어요! 곧 완성' : '상대가 조각 1개만 더 모으면 완성!'; cls = 'behind urgent'; }
    else if (raceImminent(r, o) && raceImminent(r, seat)) { msg = '둘 다 완성 임박!'; cls = 'even urgent'; }
    else if (b > a) { msg = '상대가 ' + (b - a >= 1 ? Math.floor(b - a) + '조각 ' : '') + '앞서요!'; cls = 'behind'; }
    else if (a > b) { msg = '내가 앞서요 · 계속!'; cls = 'ahead'; }
    else { msg = '막상막하!'; cls = 'even'; }
    return '<div class="race-vs ' + cls + '">' + raceVsRow(st, r, seat, true) + raceVsRow(st, r, o, false) + '<div class="vs-msg">' + msg + '</div></div>';
  }
  // 상대가 한 단계 나아갈 때마다 잠깐 깜빡 + 작은 소리 (내 화면에서만)
  var raceVsLast = { key: null, v: null };
  // 2026-10-22 (사용자 제안) 완성 순간 짧은 연출: 팀 색 토스트 "○○ 팀 택배 확보 완료! 00:12" + 카트 테두리 반짝 (1.4초, 아무것도 막지 않음)
  var raceDoneSeen = {};
  function raceDoneFx(st) {
    var r = st && st.phase === "secure" ? st.race : null;
    if (!r || !r.pieceGames) return;
    var key0 = (st.half || 1) + ":" + r.round;
    ["1", "2"].forEach(function (s) {
      var key = key0 + ":" + s;
      if (r.stage[s] !== "done" || raceDoneSeen[key] || (r.randomPick && r.randomPick[s])) return;
      raceDoneSeen[key] = 1;
      if (!r.finishedAt || !r.finishedAt[s] || nowMs() - r.finishedAt[s] > 3000) return; // 다시 접속했을 때 지난 일로 번쩍이지 않게
      var me = mySeat(), first = r.first === s, sec = raceDoneSec(r, s);
      var el = document.createElement("div");
      el.className = "race-donefx t" + s + (first ? " first" : "");
      el.innerHTML = '<b>' + (me && !RAIL && !MAIN ? (s === me ? '택배 확보 완료!' : '상대 택배 확보 완료!') : esc(TEAM[s]) + ' 택배 확보 완료!') + '</b><span>' + (first ? '1등 · 선택 우선권' : '2등') + (sec != null ? ' · ' + raceTime(sec) : '') + '</span>';
      document.body.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1500);
      document.body.classList.remove("fx-glow-1", "fx-glow-2"); void document.body.offsetWidth; document.body.classList.add("fx-glow-" + s);
      setTimeout(function () { document.body.classList.remove("fx-glow-" + s); }, 1300);
      try { if (me && s !== me) { dTone(392, 0, 0.12, "square", 0.1); dTone(330, 0.12, 0.2, "square", 0.1); } else { dTone(784, 0, 0.1, "triangle", 0.2); dTone(1046, 0.1, 0.25, "triangle", 0.2); } } catch (e) {}
    });
  }
  var raceImmSeen = {};
  function raceVsBump(r, seat) {
    if (!r || !r.pieceGames || !seat) { raceVsLast = { key: null, v: null }; return; }
    var key = (state.half || 1) + ":" + r.round, v = raceProg(r, raceOther(seat));
    // 상대가 완성 임박이 되는 순간 한 번만: 짧은 경고음 (피로하지 않게 라운드당 1회)
    var immNow = false;
    if (raceImminent(r, raceOther(seat)) && !raceImmSeen[key]) {
      raceImmSeen[key] = 1; immNow = true;
      try { dTone(660, 0, 0.09, "square", 0.1); dTone(880, 0.1, 0.09, "square", 0.1); dTone(1100, 0.2, 0.16, "square", 0.1); } catch (e) {}
    }
    if (raceVsLast.key === key && raceVsLast.v != null && v > raceVsLast.v) {
      Array.prototype.forEach.call(document.querySelectorAll('.race-vs .vs-row.opp'), function (el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); });
      if (!immNow) try { dTone(220, 0, 0.12, "square", 0.08); dTone(196, 0.1, 0.16, "square", 0.08); } catch (e) {}
    }
    raceVsLast = { key: key, v: v };
  }
  function raceMessage(st, r, seat) {
    if (r.plan) return raceMessagePlan(st, r, seat);
    if (r.status === "reveal") {
      var parts = ["1", "2"].map(function (s) {
        var i = r.picks[s];
        return esc(seatName(s, st)) + ' · ' + (i === null ? '못 가져감' : esc(TYPES[r.pair[i].catIdx].name) + (r.randomPick && r.randomPick[s] ? ' (무작위)' : ''));
      });
      return '<div class="race-msg reveal">' + parts.join('<span class="sep">|</span>') + '</div>';
    }
    var f = r.first;
    if (!seat) { // 관전(레일 화면/메인 모니터)
      if (r.status === "picking") {
        if (r.picks[f] === null) return '<div class="race-msg hot">' + esc(seatName(f, st)) + ' 먼저 투입! 고르는 중' + (r.pickEndsAt ? ' ' + raceCount(r.pickEndsAt, '', '초') : '') + '</div>';
        var o = raceOther(f);
        if (r.stage[o] === "done") return '<div class="race-msg hot">' + esc(seatName(o, st)) + ' 남은 택배 고르는 중</div>';
        return '<div class="race-msg hot">' + esc(seatName(o, st)) + ' 남은 택배를 노린다!' + (r.secondEndsAt ? ' ' + raceCount(r.secondEndsAt, '', '초') : '') + '</div>';
      }
      return '<div class="race-msg">' + (r.game ? esc(raceGameName(r)) + ' → ' : '') + '택배 쌓기 → 투입! 먼저 끝낸 사람이 먼저 골라요</div>';
    }
    var me = r.stage[seat];
    if (r.status === "picking") {
      if (raceCanPick(r, seat)) {
        var ends = f === seat ? r.pickEndsAt : r.secondPickEndsAt;
        if (railPicks()) return '<div class="race-msg hot">' + (f === seat ? '먼저 끝냈어요! ' : '') + '<b>레일 화면</b>에서 층을 보고 고르세요 · 내 자리 버튼 <b>' + RAIL_PICK_LABEL[seat].join(' ') + '</b>' + (ends ? ' <small>· 시간 안에 안 고르면 무작위</small>' : '') + '</div>'; // 자동 선택이 꺼져 있으면(기본) 마감 없음 -- 고를 때까지 기다린다
        return '<div class="race-msg hot">' + (f === seat ? '먼저 끝냈어요! ' : '남은 택배 중 ') + '<b>← ↑ →</b> 로 고르세요' + (ends ? ' <small>· 시간 안에 안 고르면 무작위</small>' : '') + '</div>';
      }
      if (f === seat) {
        if (r.stage[raceOther(seat)] === "done") return '<div class="race-msg">상대가 남은 택배를 고르는 중</div>';
        return '<div class="race-msg">상대가 남은 택배를 노리는 중' + (r.secondEndsAt ? ' ' + raceCount(r.secondEndsAt, '', '초') : '') + '</div>';
      }
      if (me === "done") return '<div class="race-msg">상대가 고르는 중이에요. 다음은 내 차례!</div>';
      if (RACE_CONSOLATION_MS > 0) {
        var wait = r.secondEndsAt ? raceCount(r.secondEndsAt, '', '초') + ' 뒤' : '상대가 고르고 ' + Math.round(RACE_CONSOLATION_MS / 1000) + '초 뒤';
        if (me === "out") return '<div class="race-msg">이번 라운드는 포기했어요 · ' + wait + ' 남은 택배 중 하나를 무작위로 받아요</div>';
        return '<div class="race-msg hot">상대가 먼저 끝냈어요! 그 전에 투입하면 직접 고르고, ' + wait + '엔 남은 택배 중 무작위로 받아요</div>';
      }
      if (me === "out") return '<div class="race-msg">이번 라운드는 탈락이에요</div>';
      return '<div class="race-msg hot">상대가 먼저 끝냈어요! ' + raceCount(r.secondEndsAt, '', '초') + ' 안에 투입하면 남은 택배 중 골라요</div>';
    }
    if (me === "sticker") return '<div class="race-msg">' + esc(raceGameName(r)) + '! 끝나면 바로 택배 쌓기예요</div>';
    if (me === "ubongo") return '<div class="race-msg hot"><b>레일 화면</b>의 문제를 실물 조각으로 <b>택배 쌓기</b> → <b>투입</b> (Space)</div>';
    if (me === "out") return '<div class="race-msg">이번 라운드는 포기했어요. ' + (RACE_CONSOLATION_MS > 0 ? '상대가 끝내고 고르면 ' + Math.round(RACE_CONSOLATION_MS / 1000) + '초 뒤 남은 택배 중 하나를 받아요' : '다음 라운드를 기다려요') + '</div>';
    return '<div class="race-msg">투입 완료!</div>';
  }
  function lateN(r) { return r.plan.late != null ? r.plan.late : rRestCount(r); }
  function lateFailN(r) { return r.plan.lateFail != null ? r.plan.lateFail : rRestCount(r); }
  function lateLeft(r, s) { return Math.min(rRestCount(r), lateN(r) - r.picks[s].length); }
  function raceMessagePlan(st, r, seat) {
    var f = r.first, n = r.plan.first, rest = rRestCount(r);
    if (r.status === "reveal") {
      if (r.pieceGames) return raceRankHtml(st, r);
      var gapT = raceGapHtml(r, null);
      return '<div class="race-msg reveal">' + ["1", "2"].map(function (s) {
        var d = raceDoneSec(r, s);
        return esc(seatName(s, st)) + ' · ' + r.picks[s].length + '개' + (d != null ? ' · ' + d.toFixed(1) + '초' : '') + (r.randomPick && r.randomPick[s] ? ' (자동)' : '');
      }).join('<span class="sep">|</span>') + (gapT ? '<span class="sep">|</span>' + gapT : '') + '</div>';
    }
    if (r.status !== "picking") {
      if (seat && r.stage[seat] === "out") return '<div class="race-msg">이번 라운드는 포기했어요 · 상대가 고른 뒤 무작위 ' + lateFailN(r) + '개를 받아요</div>';
      if (seat && r.stage[seat] === "pieces") return '<div class="race-msg">조각 ' + r.got[seat] + '/' + r.need + ' · 짧은 게임을 끝낼 때마다 조각 하나를 가져가 판에 놓으세요</div>';
      if (seat && r.stage[seat] === "sticker") return '<div class="race-msg">' + esc(raceGameName(r)) + '! 끝나면 바로 택배 쌓기 · 택배 ' + r.pair.length + '개 걸림</div>';
      if (seat && r.stage[seat] === "ubongo") return '<div class="race-msg hot"><b>택배 쌓기</b> → <b>투입</b> (Space) · 먼저 끝내면 ' + r.pair.length + '개 중 ' + n + '개 고르기</div>';
      return '<div class="race-msg">' + (r.pieceGames ? '조각 ' + r.need + '개 모으기 → 완성 → ' : (r.game ? esc(raceGameName(r)) + ' → ' : '')) + '투입! 먼저 끝낸 사람이 ' + r.pair.length + '개 중 ' + n + '개, 늦은 사람은 완성하면 ' + lateN(r) + '개 · 못 하면 ' + lateFailN(r) + '개</div>';
    }
    var o = raceOther(f), firstLeft = n - r.picks[f].length;
    if (!seat) {
      if (firstLeft > 0 && rest) return '<div class="race-msg hot">' + esc(seatName(f, st)) + ' 먼저 투입! ' + firstLeft + '개 더 고르는 중' + (r.pickEndsAt ? ' ' + raceCount(r.pickEndsAt, '', '초') : '') + '</div>';
      if (r.stage[o] === "done" && !(r.randomPick && r.randomPick[o])) return '<div class="race-msg hot">' + esc(seatName(o, st)) + ' 완성! 남은 ' + rest + '개 중 ' + lateLeft(r, o) + '개 고르는 중</div>';
      return '<div class="race-msg hot">' + esc(seatName(o, st)) + ' 남은 시간 ' + (r.secondEndsAt ? raceCount(r.secondEndsAt, '', '초') : '') + ' · 완성하면 ' + rest + '개 중 ' + lateN(r) + '개 고르기, 못 하면 무작위 ' + lateFailN(r) + '개</div>';
    }
    if (raceCanPick(r, seat)) {
      var how = railPicks() ? '<b>레일 화면</b>에서 내 자리 버튼으로' : '숫자 <b>1~' + r.pair.length + '</b> 또는 클릭으로';
      if (f !== seat) return '<div class="race-msg hot">시간 안에 완성! 남은 택배 중 ' + how + ' <b>' + lateLeft(r, seat) + '개</b> 고르세요</div>';
      return '<div class="race-msg hot">먼저 끝냈어요! 주소를 보고 ' + how + ' <b>' + firstLeft + '개</b> 더 고르세요 <small>· 시간이 지나면 무작위</small></div>';
    }
    if (f === seat) return '<div class="race-msg">고르기 끝! 상대가 시간 안에 완성하면 ' + lateN(r) + '개, 못 하면 무작위 ' + lateFailN(r) + '개를 가져가요</div>';
    var tail = ' · ' + (r.secondEndsAt ? raceCount(r.secondEndsAt, '', '초') + ' 안에' : '시간 안에') + ' 완성하면 남은 것 중 <b>' + lateN(r) + '개 고르기</b>, 못 하면 무작위 <b>' + lateFailN(r) + '개</b>';
    if (r.stage[seat] === "done") return '<div class="race-msg">상대가 고르는 중 · 끝나면 내가 ' + lateN(r) + '개 골라요</div>';
    if (r.stage[seat] === "pieces") return '<div class="race-msg hot">상대가 먼저 끝냈어요! 조각 ' + r.got[seat] + '/' + r.need + tail + '</div>';
    return '<div class="race-msg hot">상대가 먼저 끝냈어요!' + tail + '</div>';
  }
  // seat가 null이면 관전용(레일 화면/메인 모니터): 고르기 버튼·내 우봉고 영역 없음
  // 카트 안 오른쪽 위: 택배 고르기 남은 초 (내가 고를 차례일 때) / 늦은 사람은 투입 마감 초. 해당 없으면 비워 둔다.
  function racePickClock(r, seat) {
    if (r.status !== "picking") return '<span></span>';
    if (r.plan) {
      var pe = r.first === seat ? r.pickEndsAt : r.latePickEndsAt;
      if (raceCanPick(r, seat) && pe) return '<span class="race-clock is-pick">택배 고르기 ' + raceCount(pe, '', '초') + '</span>';
      if (r.first !== seat && r.stage[seat] !== "done" && r.secondEndsAt) return '<span class="race-clock is-pick">완성 마감 ' + raceCount(r.secondEndsAt, '', '초') + '</span>';
      return '<span></span>';
    }
    if (raceCanPick(r, seat)) {
      var ends = r.first === seat ? r.pickEndsAt : r.secondPickEndsAt;
      return ends ? '<span class="race-clock is-pick">택배 고르기 ' + raceCount(ends, '', '초') + '</span>' : '<span class="race-clock is-pick">택배 고르기</span>';
    }
    if (r.first !== seat && r.stage[seat] !== "done" && (r.stage[seat] !== "out" || RACE_CONSOLATION_MS > 0) && r.secondEndsAt)
      return '<span class="race-clock is-pick">' + (RACE_CONSOLATION_MS > 0 ? '무작위까지 ' : '투입 마감 ') + raceCount(r.secondEndsAt, '', '초') + '</span>';
    return '<span></span>';
  }
  function raceStage(st, seat) {
    var r = st.race;
    var html = '<div class="race' + (seat ? '' : ' race--watch') + '" data-race-round="' + r.round + '">';
    html += '<div class="race-head"><span class="round-pill">레이스 ' + r.round + '</span>'
      + (seat ? racePickClock(r, seat)
        : '<span class="race-clock">확보 남은 시간 <b id="race-secure-clock">' + fmtClock((st.secureEndsAt || nowMs()) - nowMs()) + '</b></span>') + '</div>';
    html += '<div class="race-rail"><span class="race-belt"></span>' + r.pair.map(function (it, i) { return raceParcel(st, r, it, i, seat); }).join('') + '</div>';
    html += raceMessage(st, r, seat);
    var order = seat ? [seat, raceOther(seat)] : ["1", "2"];
    html += '<div class="race-lanes">' + order.map(function (s, k) { return raceLane(st, r, s, !!seat && k === 0); }).join('') + '</div>';
    html += '</div>';
    // 관전 화면(레일 화면/메인 모니터): 택배 쌓기 문제를 여기에만 크게 하나 (플레이어 화면엔 그림 없음)
    if (!seat && racePuzzleOpen(r)) return '<div class="race-watch has-puzzle">' + html + racePuzzle(st, r) + '</div>';
    return html;
  }
  function racePieces(st, r) {
    var meta = cellMeta(r.puzzleId, st.half);
    var pt = meta ? TYPES[meta.catIdx] : null;
    return pt ? perHalf(pt.pieces) : '?';
  }
  // 레일 화면용 문제 그림 (하나만)
  function racePuzzle(st, r) {
    var meta = cellMeta(r.puzzleId, st.half);
    return '<div class="race-puzzle"><div class="rp-cap">택배 쌓기 문제 · 조각 ' + racePieces(st, r) + '개 · 두 사람 같은 문제</div>'
      + (meta && meta.src ? '<img src="' + meta.src + '" alt="택배 쌓기 문제">' : '') + '</div>';
  }
  // 플레이어 화면: 문제 그림 없이 안내 + 포기/투입 버튼만
  function racePad(st, r) {
    return '<div class="race-pad"><div class="rpad-ico" aria-hidden="true">⇧</div>'
      + '<div class="rpad-t">레일 화면의 문제를 보세요</div>'
      + '<div class="rpad-s">실물 조각 ' + racePieces(st, r) + '개로 택배 쌓기 · 두 사람 같은 문제</div>'
      + '<div class="puzzle-actions"><button class="btn danger" data-action="race-giveup">포기</button>'
      + '<button class="btn ok" data-action="race-done">투입 (Space)</button></div></div>';
  }
  function renderRace(st, seat) {
    var r = st.race;
    var me = r.stage[seat];
    // 2026-10-14 (사용자 요청): 첫 게임·택배 쌓기 중에는 플레이어 화면에 아무것도 없다 (문제는 레일 화면에만).
    //   택배 3개는 내가 택배 쌓기를 끝내고 투입한 뒤에야 나온다. 화면엔 지금 할 일 한 줄(늦은 사람은 투입 마감)과 작은 투입/포기 버튼만.
    var pickAtRail = r.status === "picking" && railPicks() && raceCanPick(r, seat);
    if (r.status !== "reveal" && (me === "sticker" || me === "ubongo" || me === "pieces" || pickAtRail)) {
      return '<main class="stage stage--race">' + cartOpen('cart--race') + '<div class="race-blank">'
        + '<div class="race-head"><span class="round-pill">레이스 ' + r.round + '</span>'
        + racePickClock(r, seat) + '</div>'
        + raceVsHtml(st, r, seat)
        + '<div class="rb-center">' + raceMessage(st, r, seat)
        + (me === "ubongo" ? '<div class="rb-actions"><button class="btn danger" data-action="race-giveup">포기</button><button class="btn ok" data-action="race-done">투입 (Space)</button></div>' : '')
        + '</div></div>' + cartClose() + '</main>';
    }
    var slip = raceSlip(st, r, seat); // 고른 뒤: 자기 자리에서 송장이 나온다
    var html = '<main class="stage stage--race">' + cartOpen('cart--race') + '<div class="race-wrap' + (slip ? ' has-slip' : '') + '">'
      + raceStage(st, seat) + slip + '</div>';
    html += '<div class="race-mine"><span class="rm-label">내 택배</span>' + (st.players[seat].invoices.length
      ? st.players[seat].invoices.map(function (inv) { return '<span class="my-chip fee-t' + inv.catIdx + '">' + esc(TYPES[inv.catIdx].name) + ' ' + esc(invAddr(inv)) + ' ' + fmtWon(invReward(inv)) + '</span>'; }).join('')
      : '<small>아직 없음</small>') + '</div>';
    return html + cartClose() + '</main>';
  }
  // 송장 붙이기 미니게임(#mg-layer)을 레이스 단계에 맞춰 열고 닫는다. 상태가 바뀔 때마다 호출된다.
  function raceSync() {
    var r = state && state.phase === "secure" ? state.race : null;
    var seat = mySeat();
    var want = r && seat && r.stage[seat] === "sticker" && r.status !== "reveal";
    if (want) {
      if (!mg || !mg.race || mg.round !== r.round || mg.kind !== raceGameKind(r)) openRaceSticker(r);
      updateRaceStrip();
    } else if (mg && mg.race) closeMiniGame();
  }
  function openRaceSticker(r) {
    closeMiniGame();
    var layer = document.getElementById("mg-layer");
    layer.innerHTML = '<div class="mg-wrap"><div class="mg-clock">레이스 ' + r.round + ' · 확보 시간<b id="mg-clock">--:--</b></div>'
      + '<div class="race-strip" id="race-strip"></div><div id="mg-host"></div></div>';
    layer.classList.remove("hidden");
    var round = r.round;
    var done = function () { closeMiniGame(); send({ type: "race-step", seat: mySeat(), step: "sticker-done", round: round }); };
    mg = {
      race: true, round: round, kind: raceGameKind(r),
      ctl: MiniGames.start(document.getElementById("mg-host"), {
        kind: raceGameKind(r), level: perHalf(RACE_STICKER_LEVEL), testHooks: TEST_HOOKS,
        onDone: done,
        onCancel: function () { closeMiniGame(); send({ type: "race-step", seat: mySeat(), step: "give-up", round: round }); },
      }),
    };
    if (TEST_HOOKS) window.__mgFinish = function () { if (!mg || !mg.race) return false; done(); return true; };
    updateMiniClock();
  }
  // 송장 붙이기 화면 위쪽 띠: 상대 진행 단계 (게임 화면이 가려도 상대가 어디까지 왔는지 보이게)
  function updateRaceStrip() {
    var el = document.getElementById("race-strip");
    if (!el || !state || !state.race) return;
    var o = raceOther(mySeat());
    var stg = state.race.stage[o];
    el.textContent = seatName(o, state) + ' · ' + (stg === "sticker" ? raceGameName(state.race) + ' 중' : stg === "ubongo" ? '택배 쌓기 중!' : stg === "done" ? '투입 완료!' : '탈락');
    el.className = 'race-strip' + (stg === "ubongo" || stg === "done" ? ' hot' : '');
  }

  function renderBoard(st, seat) {
    var msLeft = st.secureEndsAt ? (st.secureEndsAt - nowMs()) : SECURE_PHASE_MS;
    var pct = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100));
    var html = '<main class="stage stage--secure">';
    html += '<div class="side-timer" id="side-timer">'
      + '<span class="timer-label">택배 확보<br>남은 시간</span>'
      + '<span class="timer-num">' + fmtClock(msLeft) + '</span>'
      + '<div class="timer-bar"><i style="width:' + pct + '%"></i></div></div>';

    html += cartOpen('cart--board') + '<div class="card"><div class="board-grid">';
    // 2026-10-06 레일 화면: 종류마다 한 줄 -- 가운데 레일 위에 택배 상자(남은 개수), 내 자리 쪽에 내 버튼.
    // 1번 자리는 왼쪽, 2번 자리는 오른쪽. 보드는 두 플레이어가 공유한다(종류별 6개 합계) -- 남은 개수만 같이 보이고
    // 상대 쪽 칸은 비워 둔다. 버튼은 "그 종류의 아직 안 가져간 칸"을 열어 준다(칸끼리 구별이 없어서 서버가 어차피 대체함).
    // 확정 층수 택배만 층(칸)이 곧 배송 층이라 버튼 대신 층 버튼 6개를 둔다.
    var myInvoices = st.players[seat].invoices;
    var boardById = {};
    st.board.forEach(function (c) { boardById[c.id] = c; });
    var meLeft = seat === "1";
    html += '<div class="rail-head">'
      + '<span class="' + (meLeft ? 'me' : '') + '">' + (meLeft ? '내 자리' : '상대 자리') + '</span><span>레일</span>'
      + '<span class="' + (meLeft ? '' : 'me') + '">' + (meLeft ? '상대 자리' : '내 자리') + '</span></div>';
    TYPES.forEach(function (t, catIdx) {
      var left = boardLeft(st, catIdx);
      var invFor = function (cell) {
        for (var i = 0; i < myInvoices.length; i++) { if (myInvoices[i].acquiredSeq === cell.acquiredSeq) return myInvoices[i]; }
        return null;
      };
      var myCells = [];
      for (var n = 0; n < t.count; n++) {
        var c = boardById[t.key + "-" + (n + 1)];
        if (c && c.taken && c.takenBy === seat) myCells.push(c);
      }
      // --- 내 쪽 ---
      var mine = '<div class="rail-side mine" style="--c:' + t.color + '">';
      if (t.fixedFloor) {
        mine += '<div class="floor-btns">';
        for (var num = 0; num < t.count; num++) {
          var cell = boardById[t.key + "-" + (num + 1)];
          if (!cell.taken) mine += '<button class="floor-btn" data-action="open-cell" data-cell="' + cell.id + '"><span>' + esc(FLOORS[num]) + '</span><small>' + fmtWon(Math.round(t.reward * floorMult(num))) + '</small></button>';
          else if (cell.takenBy === seat) {
            var fInv = invFor(cell);
            mine += '<button class="floor-btn is-gone mine" disabled><span>' + esc(FLOORS[num]) + '</span>' + (fInv ? '<small>' + esc(invAddr(fInv)) + '</small>' : '') + '</button>';
          }
          else mine += '<button class="floor-btn is-gone" disabled title="상대가 먼저 가져갔어요">' + esc(FLOORS[num]) + '</button>';
        }
        mine += '</div>';
        mine += '<div class="mine-count">내 택배 ' + myCells.length + '개 · 층 버튼을 눌러 송장 붙이기</div>';
      } else {
        mine += '<button class="rail-btn" data-action="open-type" data-cat="' + catIdx + '"' + (left === 0 ? ' disabled' : '') + '>'
          + '<span class="rbt">' + (left === 0 ? '소진' : esc(MINI_NAME[t.mini] || '택배 쌓기') + ' 시작') + '</span>'
          + '<span class="rbp">성공 ' + rewardRange(t) + ' · 실패 ' + fmtWon(-t.penalty) + '</span></button>';
        mine += '<div class="my-chips">' + myCells.map(function (c) {
          var inv = invFor(c);
          return '<span class="my-chip">' + (inv ? esc(invAddr(inv)) : '확보') + '</span>';
        }).join('') + '</div>';
      }
      mine += '</div>';
      // --- 가운데 레일 위 상자 ---
      var pips = '';
      for (var k = 0; k < t.count; k++) pips += '<span class="pip' + (k < left ? '' : ' gone') + '"></span>';
      var mid = '<div class="rail-mid"><div class="rail-box" style="background:' + t.color + ';--c:' + t.color + '">'
        + '<span class="cell-art" style="background-image:url(\'' + BOX_ART[catIdx] + '\')"></span>'
        + '<span class="rb-name"><span class="cat-icon">' + CAT_ICONS[catIdx] + '</span>' + esc(t.name) + '</span>'
        + '<span class="rb-game">' + esc(MINI_NAME[t.mini] || '택배 쌓기') + '</span>'
        + '<span class="pips">' + pips + '</span>'
        + '<span class="cat-left">남은 <b>' + left + '</b> / ' + t.count + '</span>'
        + (left === 0 ? '<span class="stamp">소진</span>' : '')
        + '</div></div>';
      // 2026-10-14: 비어 있던 상대 자리 칸에 그 줄 종류의 요금 카드(요금표 디자인)를 둔다. 상대 정보는 여전히 안 보인다.
      var theirs = '<div class="rail-side theirs has-fee">' + renderFeeMini(catIdx) + '</div>';
      html += '<div class="board-row' + (left === 0 ? ' is-empty' : '') + '" data-cat="' + catIdx + '">'
        + (meLeft ? mine + mid + theirs : theirs + mid + mine) + '</div>';
    });
    html += '</div></div>' + cartClose();
    html += '</main>';
    return html;
  }

  // ---------- 확보 미니게임 (2026-10-06) ----------
  // TYPES[catIdx].mini(game-data.js)가 있는 종류의 칸은 우봉고 대신 minigames.js의 게임을 띄운다
  // (null이면 기존 우봉고 이미지 + "완료" 버튼). 게임은 #app이 아니라 #mg-layer에 mount한다 -- 이유는 CSS 주석 참고.
  // 서버는 이 게임을 모른다: 클라이언트가 끝까지 풀었다고 판정하면 예전과 똑같은 secure-cell 하나만 보낸다.
  var MINI_NAME = { pack: "박스 포장", inspect: "이상 확인", sticker: "송장 붙이기", map: "지도 배달" };
  // ?mgtest=1 이면 불량 검수의 정답 칸에 data-defect를 노출한다 (자동 테스트 전용 -- 일반 플레이엔 안 붙음).
  var TEST_HOOKS = /[?&]mgtest=1(&|$)/.test(location.search);
  var mg = null; // { cellId, ctl }

  // 값이 숫자 하나면 그대로, [전반, 후반] 배열이면 지금 하프 것 (TYPES의 miniLevel/pieces).
  function perHalf(v) { return Array.isArray(v) ? v[(state && state.half === 2) ? 1 : 0] : v; }
  function closeMiniGame() {
    if (mg) { try { mg.ctl.destroy(); } catch (e) { /* ignore */ } mg = null; notifyGameClosed(); }
    var layer = document.getElementById("mg-layer");
    if (layer) { layer.classList.add("hidden"); layer.innerHTML = ""; }
  }
  // 칸을 연다: 미니게임이 있는 종류면 게임, 없으면(귀중품) 우봉고 오버레이. open-cell 버튼/레일 화면 지시가 같이 쓴다.
  function openCell(cellId) {
    var m = cellMeta(cellId, state.half);
    if (m && TYPES[m.catIdx].mini && window.MiniGames) { openMiniGame(cellId); return; }
    local.openCellId = cellId; render();
  }
  // 레일 화면이 "이 칸을 풀어라"고 보냈을 때. 이미 뭔가 하고 있으면(서버도 막지만 경합 대비) 무시한다.
  function onRailOpenGame(cellId) {
    if (!state || state.phase !== "secure" || mg || local.openCellId) return;
    if (cellBlockedReason(state, cellId)) { notifyGameClosed(); return; }
    openCell(cellId);
  }
  // 레일이 열어 준 게임을 닫았다(포기/시간 종료/소진)는 걸 서버에 알린다 -- 레일 화면의 "플레이 중" 표시와 중복 지시 방지용.
  function notifyGameClosed() { send({ type: "game-closed", seat: mySeat() }); }
  function openMiniGame(cellId) {
    var meta = cellMeta(cellId, state.half);
    var t = TYPES[meta.catIdx];
    closeMiniGame();
    var layer = document.getElementById("mg-layer");
    layer.innerHTML = '<div class="mg-wrap"><div class="mg-clock">확보 시간<b id="mg-clock">--:--</b></div><div id="mg-host"></div></div>';
    layer.classList.remove("hidden");
    mg = {
      cellId: cellId,
      ctl: MiniGames.start(document.getElementById("mg-host"), {
        kind: t.mini, level: perHalf(t.miniLevel),
        // 확정 층수 택배는 칸이 곧 배송 층이라 송장에 그 층을 그대로 찍는다 (호수는 확보 순간 서버가 정하므로 표기 안 함).
        label: t.fixedFloor ? FLOORS[meta.num] : null,
        testHooks: TEST_HOOKS,
        onDone: function () { var id = cellId; markPending(id); closeMiniGame(); send({ type: "secure-cell", seat: mySeat(), cellId: id }); },
        onCancel: function () { closeMiniGame(); },
      }),
    };
    // 자동 테스트 전용(?mgtest=1): 게임을 실제로 풀지 않고 "풀었다"로 처리 -- 많은 칸을 한꺼번에 확보해야 하는
    // 엘리베이터 단계 테스트가 확보 시간 안에 끝나게 하려는 용도다. 미니게임 자체는 test_minigames.js와
    // test_minigames_live.js가 실제로 플레이하며 검증한다. 일반 접속에는 이 함수가 생기지 않는다.
    if (TEST_HOOKS) {
      window.__mgFinish = function () {
        if (!mg) return false;
        var id = mg.cellId;
        markPending(id);
        closeMiniGame();
        send({ type: "secure-cell", seat: mySeat(), cellId: id });
        return true;
      };
    }
    updateMiniClock();
  }
  function updateMiniClock() {
    var el = document.getElementById("mg-clock");
    if (!el || !state || state.phase !== "secure" || !state.secureEndsAt) return;
    var left = state.secureEndsAt - nowMs();
    el.textContent = fmtClock(Math.max(0, left));
    el.parentNode.classList.toggle("low", left < 30000);
  }
  // 상태가 바뀔 때마다 호출: 확보 시간이 끝났거나 그 칸이 이미 확보됐으면(재접속 등) 열려 있던 게임을 닫는다.
  function syncMiniGame() {
    if ((state && state.phase === "secure" && state.race) || (mg && mg.race)) { raceSync(); return; }
    if (!mg) return;
    var why = cellBlockedReason(state, mg.cellId);
    if (why) { closeMiniGame(); showToast(why); }
  }

  function renderPuzzleOverlay(st) {
    var cellId = local.openCellId;
    if (!cellId) return '<div class="overlay hidden" id="puzzle-overlay"></div>';
    var meta = cellMeta(cellId, st.half);
    var t = TYPES[meta.catIdx];
    return '<div class="overlay" id="puzzle-overlay">'
      + '<div class="puzzle-frame">'
      + '<div style="margin-bottom:0.6rem;color:var(--muted);font-family:var(--font-display);font-size:0.85rem;">' + esc(t.name) + ' · 조각 ' + perHalf(t.pieces) + '개</div>'
      + '<img src="' + meta.src + '" alt="택배 쌓기 문제">'
      + '<div class="puzzle-actions">'
      + '<button class="btn danger" data-action="give-up">포기</button>'
      + '<button class="btn ok" data-action="complete-cell" data-cell="' + cellId + '">완료</button>'
      + '</div></div></div>';
  }

  // floorIdx is the real, server-authoritative elevator position -- it moves live as either player
  // clicks (see game-room.js's vote()), so this is a direct rendering of it with no client-side
  // simulation whatsoever: whichever row is floorIdx gets .current, nothing else changes.
  function renderShaft(floorIdx) {
    var html = '<div class="shaft"><div class="shaft-track">';
    // DOM order stays FLOORS order (B1 first) -- the bottom-to-top stacking comes from
    // column-reverse, so rows[i] is still floor i no matter where it sits on screen. Tests rely on
    // that mapping.
    FLOORS.forEach(function (f, i) {
      html += '<div class="floor-stop' + (i === floorIdx ? ' current' : '') + '"><span class="car"></span>' + f
        + (floorMult(i) !== 1 ? ' <span class="floor-mult' + (floorMult(i) > 1 ? ' hi' : ' lo') + '">' + multLabel(i) + '</span>' : '')
        + '</div>';
    });
    html += '</div></div>';
    return html;
  }

  function renderInvoiceList(st, seat) {
    var invs = st.players[seat].invoices.slice().sort(function (a, b) { return a.acquiredSeq - b.acquiredSeq; });
    if (!invs.length) return '<div style="color:var(--muted);font-size:0.85rem;">아직 확보한 택배가 없어요</div>';
    // st.elevator.priorityPick는 "이번 라운드" 우선 택배 지정값(라운드가 끝나면 서버가 비움) --
    // 아직 안 끝난 항목에만 의미가 있다. 이미 배송된 항목은 대신 inv.deliveredWasPriority(그 라운드에
    // 배송 성공했을 때만 영구히 true)로 우선 보너스가 적용됐는지를 보여준다.
    var pickedId = st.elevator ? st.elevator.priorityPick[seat] : null;
    return '<div class="invoice-list">' + invs.map(function (inv) {
      var t = TYPES[inv.catIdx];
      var delivered = inv.deliveredRound !== null;
      var stickerText = inv.stolen ? "미배송" : (delivered ? ("완료 · R" + inv.deliveredRound) : "대기");
      var isPendingPriority = !delivered && inv.id === pickedId;
      var isPriority = isPendingPriority || inv.deliveredWasPriority;
      var flagText = inv.deliveredWasPriority ? ('우선 x' + PRIORITY_MULTIPLIER + ' 성공') : (isPendingPriority ? ('이번 라운드 우선 x' + PRIORITY_MULTIPLIER) : '');
      return '<div class="invoice' + (delivered ? ' delivered' : '') + (isPriority ? ' is-priority' : '') + '">'
        + '<span class="swatch" style="background:' + t.color + '"></span>'
        + '<div class="meta"><div class="t">' + esc(t.name) + (flagText ? ' <span class="priority-flag">' + flagText + '</span>' : '') + '</div><div class="d">' + invAddr(inv) + ' · ' + fmtWon(invReward(inv)) + '</div></div>'
        + '<span class="sticker' + (delivered && !inv.stolen ? '' : ' pending') + '">' + stickerText + '</span>'
        + '</div>';
    }).join("") + '</div>';
  }

  // Only ever passed MY OWN delivered items (see renderElevator) -- who received what is private
  // per player, so there is no seat tag here; it's always understood to be "mine".
  // 엘리베이터 단계: 배송한 종류 n/3 (세트 보너스 진행)
  function setProgressLine(st, seat) {
    var rule = setRuleOf(st);
    if (!(rule.amount > 0)) return '';
    var n = deliveredKinds(st.players[seat].invoices), done = n >= rule.kinds;
    return ' <span class="set-prog' + (done ? ' on' : '') + '">배송한 종류 ' + Math.min(n, rule.kinds) + '/' + rule.kinds + (done ? ' · 세트 ' + fmtWon(rule.amount) : ' · 세트 ' + fmtWon(rule.amount)) + '</span>';
  }
  // 이번 라운드 배송으로 세트가 막 완성됐으면 한 줄
  function setJustDone(st, seat, round) {
    var rule = setRuleOf(st);
    if (!(rule.amount > 0)) return '';
    var invs = st.players[seat].invoices;
    var before = invs.filter(function (inv) { return inv.deliveredRound !== round; });
    return deliveredKinds(invs) >= rule.kinds && deliveredKinds(before) < rule.kinds
      ? '<div class="set-done">세트 완성! 서로 다른 종류 ' + rule.kinds + '가지 배송 · ' + fmtWon(rule.amount) + '</div>' : '';
  }
  function renderDeliveredCallout(delivered) {
    if (!delivered || !delivered.length) return '<div class="delivered-callout empty">이번 라운드에 배송된 택배가 없어요</div>';
    return '<div class="delivered-callout">' + delivered.map(function (d) {
      var t = TYPES[d.catIdx];
      var note = d.stolen
        ? ' — <span style="color:var(--danger);font-weight:700;">택배도둑에게 도난당했어요! (' + fmtWon(-t.penalty) + ')</span>'
        : ' (' + fmtWon((typeof d.reward === "number" ? d.reward : t.reward) * (d.priority ? PRIORITY_MULTIPLIER : 1)) + (d.priority ? ' · 우선 x' + PRIORITY_MULTIPLIER : '') + ')';
      return '<div class="delivered-item"><span class="swatch" style="background:' + t.color + '"></span>'
        + roomCode(d.floorIdx, d.room) + ' ' + esc(t.name) + note
        + '</div>';
    }).join('') + '</div>';
  }

  // 우선 택배 지정 전용 시간 ("priority" 상태, PRIORITY_PICK_MS = 10초 -- 2026-10-06 신설; 그 전에는 라운드
  // 게이트에 끼워져 있었고 타이머가 없었다). 매 라운드 다시 골라야 하고(라운드가 끝나면 서버가
  // el.priorityPick을 비운다), 그 라운드 안에 배송까지 성공해야만 점수가 PRIORITY_MULTIPLIER배가 된다
  // -- 나중 라운드로 넘어가면 보너스는 사라진다(사용자 확인 사항). 내가 "확정"하면 이후엔 바꿀 수 없고,
  // 둘 다 확정하면 10초를 다 기다리지 않고 넘어간다. 시간이 다 되면 확정 여부와 무관하게 그 시점의 지정값이 적용된다.
  function renderPriorityWindow(st, seat) {
    var el = st.elevator;
    var undelivered = st.players[seat].invoices.filter(function (inv) { return inv.deliveredRound === null; })
      .sort(function (a, b) { return a.acquiredSeq - b.acquiredSeq; });
    var confirmed = !!el.priorityConfirmed[seat];
    var otherSeat = seat === "1" ? "2" : "1";
    var pickedId = el.priorityPick[seat];
    var html = '<div class="priority-window">';
    html += '<h4>우선 택배 지정 (성공 시 점수 ' + PRIORITY_MULTIPLIER + '배)</h4>';
    html += '<div class="pw-sub">이번 라운드 안에 배송해야만 적용돼요. 안 보내면 보너스는 사라져요.</div>';
    html += '<div class="pw-clock"><span style="color:var(--muted);font-size:0.85rem;">남은 시간</span>'
      + '<span class="time-left-big" id="priority-clock">' + fmtClock(Math.max(0, (el.priorityWindowEndsAt || 0) - nowMs())) + '</span></div>';
    html += '<div class="timer-bar"><i id="priority-bar" style="width:100%"></i></div>';
    if (!undelivered.length) html += '<div style="color:var(--muted);font-size:0.85rem;">지정할 미배송 택배가 없어요</div>';
    html += '<div class="invoice-list">' + undelivered.map(function (inv) {
      var t = TYPES[inv.catIdx];
      var picked = inv.id === pickedId;
      return '<div class="invoice' + (confirmed ? ' delivered' : ' pickable') + (picked ? ' is-priority' : '') + '"'
        + (confirmed ? '' : (' data-action="pick-priority" data-inv="' + (picked ? '' : inv.id) + '"')) + '>'
        + '<span class="swatch" style="background:' + t.color + '"></span>'
        + '<div class="meta"><div class="t">' + esc(t.name) + '</div><div class="d">' + invAddr(inv) + ' · 성공 시 ' + fmtWon(invReward(inv)) + '</div></div>'
        + '<span class="sticker' + (picked ? '' : ' pending') + '">' + (picked ? ('우선 x' + PRIORITY_MULTIPLIER) : '선택') + '</span>'
        + '</div>';
    }).join('') + '</div>';
    // P2-2 (2026-10-13): 후반이면 같은 창에서 택배도둑도 놓는다 (game-room.js _mergedThiefWindow). 놓아도 창은 안 닫히고, "확정"해야 진행.
    var merged = MERGE_PRIORITY_THIEF && st.half === 2;
    if (merged) html += renderThiefPicker(st, seat, confirmed);
    if (confirmed) {
      html += '<div class="pw-actions"><span class="ready-chip is-ready">'
        + (merged ? '확정 완료' : (pickedId ? '우선 택배 확정' : '지정 안 함으로 확정')) + '</span>'
        + '<span class="ready-chip' + (el.priorityConfirmed[otherSeat] ? ' is-ready' : '') + '">' + seatName(otherSeat, st)
        + (el.priorityConfirmed[otherSeat] ? ' · 확정' : ' · 고르는 중') + '</span></div>';
    } else {
      html += '<div class="pw-actions"><button class="btn primary" data-action="confirm-priority">'
        + (merged ? '확정' : (pickedId ? '이걸로 확정' : '지정 안 함으로 확정')) + '</button>'
        + '<span class="key-hint">Space로도 확정 · 고른 택배를 다시 누르면 선택 해제</span></div>';
    }
    html += '</div>';
    return html;
  }

  // 합쳐진 창 안의 택배도둑 영역 (P2-2). 배치 규칙은 예전 thief 창과 같다: 후반 통틀어 THIEF_PER_HALF회, 라운드당 1개,
  // 다음 라운드부터 작동, 마지막 라운드 불가(서버가 자동 넘김). 확정 전에는 아직 안 놓았으면 층 버튼을 보여 준다.
  function renderThiefPicker(st, seat, confirmed) {
    var th = st.elevator.thieves;
    var perHalf = th.perHalf || 1;
    var usedCnt = th.usedThisHalf[seat] || 0;
    var leftCnt = Math.max(0, perHalf - usedCnt);
    var placed = th.placedThisRound[seat];
    var hasPlaced = placed !== null && placed !== undefined;
    var lastRound = st.elevator.round >= ELEVATOR_ROUNDS;
    var html = '<div class="thief-window merged">';
    html += '<h4>택배도둑 (남은 횟수 ' + leftCnt + '/' + perHalf + ')</h4>';
    if (hasPlaced) {
      html += '<div style="color:var(--muted);font-size:0.85rem;"><strong style="color:var(--danger)">' + esc(FLOORS[placed]) + '</strong>에 배치했어요. 다음 라운드에 상대가 그 층에 배송하면 가로채요.</div>';
    } else if (lastRound) {
      html += '<div style="color:var(--muted);font-size:0.85rem;">마지막 라운드엔 놓을 수 없어요.</div>';
    } else if (leftCnt === 0) {
      html += '<div style="color:var(--muted);font-size:0.85rem;">이번 후반에 택배도둑을 다 썼어요.</div>';
    } else if (confirmed) {
      html += '<div style="color:var(--muted);font-size:0.85rem;">이번 라운드는 놓지 않았어요.</div>';
    } else {
      html += '<div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem;">층을 고르면 다음 라운드에 상대가 그 층에 배송할 때 가로채요 (선택 사항).</div>';
      html += '<div class="thief-floors">' + FLOORS.map(function (f, i) {
        return '<button class="btn ghost" data-action="place-thief" data-floor-idx="' + i + '">' + esc(f) + '</button>';
      }).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  // 2026-10-14: 엘리베이터 단계의 일러스트 = 엘리베이터 안 그림(ui_art/elevator.jpg, 원본 elevator_src.png에서 층 표시창 숫자와
  // 층 버튼을 지운 것). 그 자리에 HTML로 현재 층(표시창)과 층 버튼판(5 / 4 3 / 2 1 / B1, 현재 층 노란불)을 다시 그려서 실시간으로 바뀐다.
  // 표시창 화살표: 이동 중엔 이번 라운드 시작 층 대비 방향, 결과 화면에선 그 라운드 결과 방향.
  var EA_PANEL = [[5, null], [4, 3], [2, 1], [0, null]]; // FLOORS 인덱스 (0 = B1)
  function eaLabel(i) { var f = FLOORS[i]; return f === "B1" ? "B1" : f.replace("F", ""); }
  function elevDir(el) {
    var f = el.floorIdx;
    if (el.state === "voting") return f > el.roundStartFloorIdx ? "up" : (f < el.roundStartFloorIdx ? "down" : "");
    if (el.state === "result" && el.log && el.log.length) { var lg = el.log[el.log.length - 1]; return lg.jolt ? lg.jolt.dir : (lg.dir === "tie" ? "" : (lg.dir || "")); }
    return "";
  }

  // 2026-10-14: 엘리베이터 이동 표시 = 건물 단면도(ui_art/building.jpg -- 원본 building_src.png에서 계단 칸을 잘라 폭을 줄이고,
  // 오른쪽 유리 승강로에 그려져 있던 카트/화살표를 지운 것). 빨간 카트형 엘리베이터와 ▲▼ 화살표는 HTML/CSS로 얹어서
  // 현재 층(서버 floorIdx)으로 실제로 미끄러져 움직인다. 층 이름표(5F 보라 ~ B1 빨강)는 그림 그대로, 현재 층만 밝게.
  // 테스트 호환: 층마다 .floor-stop (현재 층은 .current, 글자는 층 이름 + .floor-mult 배지) -- 글자는 투명.
  // 카트 애니메이션: 직전 층(bldPrevFloor)에서 출발한 모습으로 그렸다가 그린 직후 새 층으로 옮긴다(bldAfterRender).
  var bldPrevFloor = null;
  // 덜컹(결과 화면, 이번 라운드 log.jolt): 처음 그릴 때만 흔들림 애니메이션 (상태가 올 때마다 다시 그리므로)
  var joltSeen = null;
  function elevJolt(el) {
    if (el.state !== "result" || !el.log || !el.log.length) return null;
    var last = el.log[el.log.length - 1];
    return last.round === el.round && last.jolt ? last.jolt : null;
  }
  function joltClass(el, who) {
    var j = elevJolt(el);
    if (!j) return '';
    var key = who + ':' + el.round + ':' + j.to;
    var fresh = !joltSeen || joltSeen.indexOf(key) < 0;
    if (fresh) joltSeen = (joltSeen || []).concat([key]);
    return ' has-jolt' + (fresh ? ' is-jolt' : '');
  }
  function renderBuilding(el) {
    var f = el.floorIdx, dir = elevDir(el);
    var from = bldPrevFloor === null ? f : bldPrevFloor;
    var stops = FLOORS.map(function (name, i) {
      var m = floorMult(i);
      return '<div class="floor-stop bld-stop' + (i === f ? ' current' : '') + '" style="--i:' + i + '"><span class="bld-name">' + name + '</span>'
        + (m !== 1 ? '<span class="floor-mult' + (m > 1 ? ' hi' : ' lo') + '">' + multLabel(i) + '</span>' : '') + '</div>';
    }).join('');
    bldPrevFloor = f;
    var jc = joltClass(el, 'bld');
    return '<div class="bld' + (dir ? ' is-' + dir : '') + jc + '" aria-label="엘리베이터 위치 ' + esc(FLOORS[f]) + '">' + stops
      + (jc ? '<span class="jolt-pop">덜컹!</span>' : '')
      + '<div class="bld-car" id="mv-car" data-to="' + f + '" style="--i:' + from + '">'
      + '<i class="bld-arw up"><b></b><b></b><b></b></i><i class="bld-arw down"><b></b><b></b><b></b></i>'
      + '<span class="bld-cab"></span><span class="bld-wheels"></span></div>'
      + '</div>';
  }
  function bldAfterRender() {
    Array.prototype.forEach.call(document.querySelectorAll(".bld-car[data-to]"), function (car) {
      var to = car.getAttribute("data-to");
      if (car.style.getPropertyValue("--i") === to) return;
      void car.offsetWidth;
      requestAnimationFrame(function () { requestAnimationFrame(function () { car.style.setProperty("--i", to); }); });
    });
  }

  // 2026-10-15 (사용자 요청): 엘리베이터 안 바닥에 "내가 보내야 할 택배"를 그림으로 -- 상자(종류 색) + 앞면에 송장(호실).
  //   플레이어 화면에서만(seat가 있을 때) -- 레일 화면/메인 모니터에는 그리지 않는다(송장은 비공개).
  //   지금 층에서 내려질 택배는 반짝(is-here), 이번 라운드 우선 택배는 "우선" 표시. 배송/도난된 송장은 빠진다.
  function elevParcels(el, st, seat) {
    var invs = st.players[seat].invoices.filter(function (v) { return v.deliveredRound === null && !v.stolen; })
      .sort(function (a, b) { return a.floorIdx - b.floorIdx || a.acquiredSeq - b.acquiredSeq; });
    if (!invs.length) return '<div class="ea-pks empty"><span>실을 택배가 없어요</span></div>';
    var pri = el.priorityPick ? el.priorityPick[seat] : null;
    return '<div class="ea-pks' + (invs.length > 5 ? ' many' : '') + '">' + invs.map(function (v) {
      var t = TYPES[v.catIdx];
      return '<div class="ea-pk fee-t' + v.catIdx + (v.floorIdx === el.floorIdx ? ' is-here' : '') + (pri === v.id ? ' is-pri' : '') + '">'
        + '<span class="ea-pk-tape"></span>'
        + '<span class="ea-pk-slip"><i class="ea-pk-ico">' + CAT_ICONS[v.catIdx] + '</i><b>' + esc(invAddr(v)) + '</b></span>'
        + (pri === v.id ? '<span class="ea-pk-pri">우선</span>' : '')
        + '</div>';
    }).join('') + '</div>';
  }
  function renderElevArt(el, st, seat) {
    var f = el.floorIdx, dir = elevDir(el);
    var panel = EA_PANEL.map(function (row) {
      return row.map(function (i) {
        return i === null ? '<span class="ea-gap"></span>' : '<span class="ea-btn' + (i === f ? ' on' : '') + '" data-floor="' + i + '">' + eaLabel(i) + '</span>';
      }).join('');
    }).join('');
    return '<div class="elev-art' + joltClass(el, 'art') + '" data-floor-name="' + esc(FLOORS[f]) + '" aria-label="엘리베이터 ' + esc(FLOORS[f]) + '">'
      + '<div class="ea-ind"><i class="ea-up' + (dir === "up" ? ' on' : '') + '"></i><b>' + eaLabel(f) + '</b><i class="ea-down' + (dir === "down" ? ' on' : '') + '"></i></div>'
      + '<div class="ea-panel">' + panel + '</div>'
      + (floorMult(f) !== 1 ? '<span class="ea-mult' + (floorMult(f) > 1 ? ' hi' : '') + '">배송비 ' + multLabel(f) + '</span>' : '')
      + (st && seat ? elevParcels(el, st, seat) : '')
      + '</div>';
  }

  function renderElevator(st, seat) {
    var html = '<main class="stage"><div class="elev-frame"><div class="elev-layout">';
    // left column: gauge, then my own package list directly beneath it -- opponent's list is
    // never rendered here (or anywhere in the elevator phase), only mine.
    // 2026-10-15 (사용자 요청, "한 화면에 한 가지 일"): 내 화면엔 엘리베이터 안(바닥에 내 택배 + 송장)과 조작만.
    //   건물 단면도는 레일 화면/메인 모니터에, 송장 목록은 바닥의 상자가 대신한다.
    html += '<div class="elev-mid">' + renderElevArt(st.elevator, st, seat)
      + '<div class="elev-mid-foot">' + setProgressLine(st, seat) + '</div>'
      + '</div>';

    html += '<div>';
    html += '<div class="card">';
    html += '<span class="round-pill">라운드 ' + st.elevator.round + ' / ' + ELEVATOR_ROUNDS + '</span>';
    html += '<div style="margin-top:0.6rem;font-family:var(--font-display);font-size:1.1rem;">현재 층: <strong style="color:var(--gold)">' + FLOORS[st.elevator.floorIdx] + '</strong></div>';

    // Pre-round-1 gate: mirrors the between-round "result" ready-row, but with no voting UI at
    // all yet (nothing has been voted on) -- just a moment to review invoices before both players
    // press space to kick off round 1's 5-second vote.
    if (st.elevator.state === "idle") {
      var otherSeat0 = seat === "1" ? "2" : "1";
      var myReady0 = !!st.elevator.readyNext[seat];
      var otherReady0 = !!st.elevator.readyNext[otherSeat0];
      html += '<div style="margin-top:0.75rem;color:var(--muted);font-size:0.9rem;">확보한 택배를 확인하고, 준비가 되면 스페이스바를 눌러주세요. 이어서 우선 택배 지정 시간(' + (PRIORITY_PICK_MS / 1000) + '초)이 열려요.</div>';
      html += '<div class="ready-row" style="margin-top:0.75rem;">'
        + '<span class="ready-chip' + (myReady0 ? ' is-ready' : '') + '">나 · ' + seatName(seat, st) + (myReady0 ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
        + '<span class="ready-chip' + (otherReady0 ? ' is-ready' : '') + '">' + seatName(otherSeat0, st) + (otherReady0 ? ' · 준비 완료' : ' · 대기 중') + '</span>'
        + '</div>'
        + '<div class="space-hint">Space · 엘리베이터 이동 시작</div>';
      html += '</div>';

      html += '</div></div></div></main>';
      return html;
    }

    // 우선 택배 지정 전용 시간 (매 라운드 맨 처음, PRIORITY_PICK_MS) -- 독립된 상태 화면.
    if (st.elevator.state === "priority") {
      html += renderPriorityWindow(st, seat);
      html += '</div></div></div></main>';
      return html;
    }

    // 택배도둑 배치 전용 시간 (후반 전용, 매 라운드 voting 시작 전 THIEF_PLACE_MS 동안 -- idle/voting 중
    // 아무 때나 놓을 수 있던 예전 방식 대신, 이제는 독립된 상태 화면이다). 배치는 선택사항(건너뛰기
    // 가능)이고, 배치 직후엔 아무 효과 없이 다음 라운드부터 실제로 작동한다 (game-room.js의 el.thieves
    // 참고). 둘 다 배치/건너뛰기를 마치면 타이머를 기다리지 않고 곧장 voting으로 넘어간다.
    // 2026-10-07: 1인당 이 후반 전체를 통틀어 thieves.perHalf(2)번까지 배치 가능 -- usedThisHalf(횟수)가
    // perHalf에 닿으면 서버가 이미 매 라운드 자동으로 스킵 처리해두므로(placeThief 호출 없이도 doneMine이
    // true), 여기서는 "이미 다 썼다"는 걸 구분해서 보여주기만 하면 된다. (마지막 라운드엔 창이 안 열린다.)
    if (st.elevator.state === "thief") {
      var placedMine = st.elevator.thieves.placedThisRound[seat];
      var skippedMine = !!st.elevator.thieves.skipped[seat];
      var perHalf = st.elevator.thieves.perHalf || 1;
      var usedCnt = st.elevator.thieves.usedThisHalf[seat] || 0;
      var usedUpMine = usedCnt >= perHalf;
      var leftMine = Math.max(0, perHalf - usedCnt);
      var doneMine = placedMine !== null && placedMine !== undefined || skippedMine;
      html += '<div class="thief-window">';
      html += '<h4>택배도둑 배치 (후반 전용, 후반 통틀어 ' + perHalf + '회 · 남은 횟수 ' + leftMine + '회)</h4>';
      if (doneMine) {
        html += '<div style="color:var(--muted);font-size:0.85rem;">'
          + (placedMine !== null && placedMine !== undefined
            ? ('<strong style="color:var(--danger)">' + esc(FLOORS[placedMine]) + '</strong>에 배치했어요. 다음 라운드부터 그 층에 상대가 배송하면 뺏어요.')
            : (usedUpMine ? '이번 후반에 택배도둑을 이미 다 사용했어요 (1인당 ' + perHalf + '회).' : '이번 라운드는 배치하지 않았어요.'))
          + ' 상대를 기다리는 중...</div>';
      } else {
        html += '<div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem;">층을 골라 배치하면, 다음 라운드에 상대가 그 층에 배송할 때 가로채서 상대에게 확정 마이너스 점수를 줘요. 이 후반 동안 총 ' + perHalf + '번까지 놓을 수 있고(라운드당 1개), 마지막 라운드엔 놓을 수 없으니 신중하게 골라주세요.</div>';
        html += '<div class="thief-floors">' + FLOORS.map(function (f, i) {
          return '<button class="btn ghost" data-action="place-thief" data-floor-idx="' + i + '">' + esc(f) + '</button>';
        }).join('') + '<button class="btn ghost" data-action="skip-thief">건너뛰기</button></div>';
      }
      html += '<div class="time-left-big" id="thief-clock">' + (doneMine ? '' : '남은 시간 계산 중...') + '</div>';
      html += '</div>';
      html += '</div></div></div></main>';
      return html;
    }

    // 같은 층 충돌 선택 단계: 이번 라운드 도착한 층에 내 미배송 택배가 2개 이상이면, SAME_FLOOR_CHOICE_MS
    // 동안 어느 걸 먼저 보낼지 고를 수 있다 (안 고르면 서버가 무작위로 정함). 충돌이 없는 플레이어에게는
    // 상대가 고르는 동안 대기 메시지만 보여준다.
    if (st.elevator.state === "choosing") {
      var pc = st.elevator.pendingChoice;
      var myConflict = pc && pc.conflicts[seat];
      html += '<div class="choice-box">';
      if (myConflict) {
        var myChosen = pc.chosen[seat];
        html += '<h4>같은 층에 택배가 여러 개예요 — 먼저 보낼 걸 골라주세요</h4>';
        html += '<div class="choice-list">' + myConflict.map(function (invId) {
          var inv = null;
          for (var i = 0; i < st.players[seat].invoices.length; i++) { if (st.players[seat].invoices[i].id === invId) { inv = st.players[seat].invoices[i]; break; } }
          if (!inv) return '';
          var t = TYPES[inv.catIdx];
          var isChosen = myChosen === invId;
          return '<div class="invoice' + (myChosen ? ' delivered' : ' pickable') + (isChosen ? ' chosen' : '') + '"'
            + (myChosen ? '' : (' data-action="choose-delivery" data-inv="' + invId + '"'))
            + '>'
            + '<span class="swatch" style="background:' + t.color + '"></span>'
            + '<div class="meta"><div class="t">' + esc(t.name) + '</div><div class="d">' + invAddr(inv) + '</div></div>'
            + '<span class="sticker' + (isChosen ? '' : ' pending') + '">' + (isChosen ? '선택됨' : '선택') + '</span>'
            + '</div>';
        }).join('') + '</div>';
        html += '<div class="time-left-big" id="choice-clock">' + (myChosen ? '상대를 기다리는 중...' : '남은 시간 계산 중...') + '</div>';
      } else {
        html += '<h4>잠시만요</h4><div style="color:var(--muted);font-size:0.85rem;">상대방이 같은 층 택배 중 먼저 보낼 걸 고르고 있어요...</div>';
      }
      html += '</div>';
      html += '</div></div></div></main>';
      return html;
    }

    var voting = st.elevator.state === "voting";

    html += '<div class="vote-buttons">';
    html += '<button class="btn big primary" data-action="vote-up"' + (voting ? '' : ' disabled') + '>▲ 위로</button>';
    html += '<button class="btn big ghost" data-action="vote-down"' + (voting ? '' : ' disabled') + '>▼ 아래로</button>';
    html += '</div>';
    // per-click counts (mine or the opponent's) are never shown -- the real floor position, shown
    // live in the shaft (whichever row carries .current), is the only movement feedback either
    // player gets during voting.
    html += '<div class="key-hint">' + (voting ? '키보드 ↑ / ↓ 화살표로도 누를 수 있어요' + (ELEVATOR_JOLT ? ' · <b>둘 다 눌렀는데 제자리면 덜컹!</b>' : '') : '이번 라운드 투표가 끝났어요') + '</div>';

    if (voting) {
      html += '<div class="time-left-big" id="round-clock">남은 시간 계산 중...</div>';
    } else if (st.elevator.log.length) {
      var last = st.elevator.log[st.elevator.log.length - 1];
      // Only the numeric up/down tally is hidden here -- which direction won, and where the
      // elevator ended up, are still shown. Delivered items are filtered to MY seat only: who
      // received what package is private per player (see renderDeliveredCallout).
      var myDelivered = (last.delivered || []).filter(function (d) { return d.seat === seat; });
      html += '<div class="round-result">'
        + '<div>라운드 ' + last.round + ' 결과 — '
        + (last.jolt ? '팽팽! <b class="jolt-word">덜컹!</b> ' + FLOORS[last.jolt.from] + '에서 ' + (last.jolt.dir === "up" ? "튀어 올랐어요" : "떨어졌어요")
          : (last.dir === "tie" ? "동률, 유지" : (last.dir === "up" ? "상승" : "하강")))
        + ' (현재 ' + FLOORS[last.floorIdx] + ')</div>'
        + renderDeliveredCallout(myDelivered) + setJustDone(st, seat, last.round)
        + '</div>';
      var otherSeat = seat === "1" ? "2" : "1";
      var myReady = !!st.elevator.readyNext[seat];
      var otherReady = !!st.elevator.readyNext[otherSeat];
      var nextLabel = st.elevator.round >= ELEVATOR_ROUNDS ? "최종 결과 보기" : "다음 라운드로";
      // P2-1 (2026-10-13): 결과는 RESULT_AUTO_ADVANCE_MS 뒤 자동으로 넘어간다. 둘 다 Space면 더 빨리.
      if (st.elevator.resultEndsAt) {
        html += '<div class="auto-advance" id="result-clock">' + Math.max(0, Math.ceil((st.elevator.resultEndsAt - nowMs()) / 1000)) + '초 뒤 자동으로 ' + nextLabel.replace(" 보기", "") + '</div>';
      }
      html += '<div class="ready-row">'
        + '<span class="ready-chip' + (myReady ? ' is-ready' : '') + '">나 · ' + seatName(seat, st) + (myReady ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
        + '<span class="ready-chip' + (otherReady ? ' is-ready' : '') + '">' + seatName(otherSeat, st) + (otherReady ? ' · 준비 완료' : ' · 대기 중') + '</span>'
        + '</div>'
        + '<div class="space-hint">Space · ' + (st.elevator.resultEndsAt ? '둘 다 누르면 바로 넘어가요' : nextLabel) + '</div>';
    }
    html += '</div>';

    html += '</div></div></div></main>';
    return html;
  }

  // 하프타임 전환 화면: 전반이 끝난 뒤 후반(새 보드, 새 송장, 택배도둑 해금)을 시작하기 전 결과를 잠깐
  // 보여주고, 둘 다 스페이스바를 누르면 후반의 택배 확보 페이즈가 시작된다.
  function renderHalftime(st, seat) {
    var otherSeat = seat === "1" ? "2" : "1";
    var myReady = !!st.halftimeReady[seat];
    var otherReady = !!st.halftimeReady[otherSeat];
    var h1 = st.halfHistory[0];
    var html = '<main class="stage"><div class="center-screen">' + cartOpen('cart--half') + '<div class="halftime-box card">';
    html += '<h2>전반 종료</h2>';
    if (h1) {
      html += '<div class="halftime-scores">'
        + '<div class="chip">' + esc(seatName("1", st)) + '<span class="n">' + fmtWon(h1.scores["1"]) + '</span></div>'
        + '<div class="chip">' + esc(seatName("2", st)) + '<span class="n">' + fmtWon(h1.scores["2"]) + '</span></div>'
        + '</div>';
    }
    html += '<p style="color:var(--muted);font-size:0.9rem;">후반이 시작돼요. 택배 보드가 새로 채워지고, 후반부터는 <strong style="color:var(--danger)">택배도둑</strong>을 배치할 수 있어요.</p>';
    html += '<div class="ready-row">'
      + '<span class="ready-chip' + (myReady ? ' is-ready' : '') + '">나 · ' + seatName(seat, st) + (myReady ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
      + '<span class="ready-chip' + (otherReady ? ' is-ready' : '') + '">' + seatName(otherSeat, st) + (otherReady ? ' · 준비 완료' : ' · 대기 중') + '</span>'
      + '</div>'
      + '<div class="space-hint">Space · 후반 시작</div>';
    html += '</div>' + cartClose() + '</div></main>';
    return html;
  }

  // 전반/후반 각각의 스냅샷(st.halfHistory)과, 그 안의 players.invoices로부터 다시 계산한 점수를
  // 그대로 보여준다 -- st.scores(전체 합산)와는 별개로 하프별 내역도 함께 표시. 우선 배송 여부는
  // (라운드 한정 보너스이므로) inv.deliveredWasPriority에 이미 영구히 기록돼 있다.
  function renderHalfTable(seat, halfEntry) {
    var invs = halfEntry.players[seat].invoices.slice().sort(function (a, b) { return a.acquiredSeq - b.acquiredSeq; });
    var html = '<table class="score-table"><thead><tr><th>종류</th><th>목적지</th><th>결과</th><th>점수</th></tr></thead><tbody>';
    invs.forEach(function (inv) {
      var t = TYPES[inv.catIdx];
      var pts = scoreInvoice(inv);
      var label = resultLabel(inv) + (inv.deliveredWasPriority ? ' · 우선' : '');
      html += '<tr><td>' + esc(t.name) + '</td><td>' + invAddr(inv) + '</td><td>' + label + '</td><td>' + fmtWon(pts) + '</td></tr>';
    });
    if (!invs.length) html += '<tr><td colspan="4" style="color:var(--muted)">확보한 택배 없음</td></tr>';
    var sb = setBonusFor(invs, setRuleOf(state));
    if (setRuleOf(state).amount > 0) html += '<tr class="set-row' + (sb ? ' on' : '') + '"><td colspan="3">종류 모으기 보너스 · 배송한 종류 ' + deliveredKinds(invs) + ' / ' + setRuleOf(state).kinds + '</td><td>' + (sb ? fmtWon(sb) : '-') + '</td></tr>';
    html += '</tbody></table>';
    return html;
  }

  // 2026-08-28 신설: 종료 화면에서 링크를 새로 안 받아도 같은 방에서 바로 재대결할 수 있는 버튼.
  // halftime/lobby의 "둘 다 눌러야" 게이트와 같은 패턴이되, 스페이스바가 아니라 실제 클릭 버튼으로
  // 만들었다(사용자 요청 -- 결과 화면은 내용이 길어서 스페이스바보다 버튼이 더 눈에 띈다). 내가 이미
  // 누른 뒤에는 버튼을 비활성화하고 "상대방 대기 중" 문구로 바꿔서, 두 번 누르거나 아직 상대가 안
  // 눌렀는데 눌린 것처럼 보이는 걸 방지한다.
  function renderRestartGate(st, seat) {
    var otherSeat = seat === "1" ? "2" : (seat === "2" ? "1" : null);
    var mine = !!(st.restartReady && seat && st.restartReady[seat]);
    var other = !!(st.restartReady && otherSeat && st.restartReady[otherSeat]);
    var html = '<div class="restart-gate card">';
    if (mine) {
      html += '<button class="btn primary big" disabled>' + (other ? '다시 시작하는 중...' : '다시 시작 대기 중 (' + esc(seatName(otherSeat, st)) + ' 응답 대기)') + '</button>';
    } else {
      html += '<button class="btn primary big" data-action="restart-ready">다시 시작</button>';
    }
    html += '<div class="ready-row" style="margin-top:0.6rem;">'
      + '<span class="ready-chip' + (mine ? ' is-ready' : '') + '">나 · ' + (mine ? '준비 완료' : '대기 중') + '</span>'
      + (otherSeat ? '<span class="ready-chip' + (other ? ' is-ready' : '') + '">' + esc(seatName(otherSeat, st)) + (other ? ' · 준비 완료' : ' · 대기 중') + '</span>' : '')
      + '</div>';
    html += '<p style="color:var(--muted);font-size:0.85rem;margin:0.5rem 0 0;">같은 링크에서 좌석/택배사는 그대로 두고 바로 새 게임을 시작해요. 둘 다 눌러야 시작됩니다.</p>';
    html += '</div>';
    return html;
  }

  function renderEnd(st, seat) {
    var s1 = st.scores ? st.scores["1"] : 0, s2 = st.scores ? st.scores["2"] : 0;
    var winner = s1 === s2 ? "무승부" : (s1 > s2 ? (seatName("1", st) + " 승리") : (seatName("2", st) + " 승리"));
    var html = '<main class="stage">' + cartOpen('cart--end');
    html += '<div class="winner-banner">' + winner + '</div>';
    html += renderRestartGate(st, seat);
    // Game's over -- unlike the elevator phase (where per-round delivery info stays private so
    // players can't read each other's moves mid-game), the ending screen reveals both players'
    // full itemized results (전반 + 후반 각각, 그리고 합산) so they can compare and review the
    // whole run together.
    st.halfHistory.forEach(function (h) {
      html += '<h3 style="font-family:var(--font-display);color:var(--muted);margin:1.2rem 0 0.4rem;">' + (h.half === 1 ? "전반" : "후반") + '</h3>';
      html += '<div class="split-two">';
      ["1", "2"].forEach(function (s) {
        html += '<div class="card"><h3 style="font-family:var(--font-display);margin-top:0;">' + esc(seatName(s, st)) + (s === seat ? ' (나)' : '') + ' — ' + fmtWon(h.scores[s]) + '</h3>';
        html += renderHalfTable(s, h);
        html += '</div>';
      });
      html += '</div>';
    });
    html += '<div class="halftime-scores" style="margin-top:1.4rem;">'
      + '<div class="chip">' + esc(seatName("1", st)) + ' 총점<span class="n">' + fmtWon(s1) + '</span></div>'
      + '<div class="chip">' + esc(seatName("2", st)) + ' 총점<span class="n">' + fmtWon(s2) + '</span></div>'
      + '</div>';
    html += cartClose() + '</main>';
    return html;
  }

  function renderLoading() {
    return '<main class="stage"><div class="center-screen">' + cartWrap('<div class="lobby-box card"><h2>연결 중...</h2>'
      + '<p>서버에 접속하고 있어요. 잠시만 기다려 주세요.</p></div>', 'cart--lobby') + '</div></main>';
  }

  // ---------- 2026-10-16 벽 배송 (phase "delivery") ----------
  // 화면마다 볼 것 하나만 (사용자 피드백: 정보가 흩어져 시선이 분산됨):
  //   플레이어 화면 = 내 송장(주소)과 지금 상태 / 레일 화면 = 벽(호실 버튼) / 메인 모니터 = 두 팀 점수판
  var WALL = @@WALL_JSON@@;
  function dWon(n) { return (n < 0 ? "-" : "") + Math.abs(n || 0).toLocaleString("ko-KR") + "원"; }
  var TEAM = { "1": "빨간 팀", "2": "파란 팀" };
  var TEAM_KEY = { "1": "Ctrl", "2": "Shift" };
  // 호실 키 (34개). Ctrl+W/T/N/Q와 Ctrl+숫자는 브라우저가 가로채서 쓰지 않는다. 현장에서는 물리 버튼을 이 키로 연결.
  var WALL_KEYS = ["KeyE", "KeyR", "KeyD", "KeyF", "KeyC", "KeyV", "KeyU", "KeyI", "KeyJ", "KeyK", "KeyM", "Comma", "KeyO", "KeyP",
    "KeyA", "KeyS", "KeyG", "KeyH", "KeyL", "Semicolon", "KeyZ", "KeyX", "KeyB", "Period", "Slash", "Quote",
    "KeyY", "BracketLeft", "BracketRight", "Backslash", "Minus", "Equal", "Backquote", "Enter"];
  var KEY_LABEL = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Enter: "↵" };
  // 2026-10-22 (사용자 결정) 문마다 버튼 한 쌍: 빨간 버튼 = 위 WALL_KEYS(그냥 누름), 파란 버튼 = 아래 BLUE_KEYS(그냥 누름).
  //   키보드로 시험할 때는 빨강 = 호실 키 그대로, 파랑 = Shift + 호실 키 (또는 파란 키). 오락실 버튼 인코더에서 이 키로 연결.
  var BLUE_KEYS = ["KeyQ", "KeyW", "KeyT", "KeyN", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0",
    "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9", "Numpad0",
    "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter", "Insert", "Delete", "Home", "End"];
  var unitById = {}, unitByKey = {}, unitByKeyB = {};
  WALL.units.forEach(function (u, i) { unitById[u.id] = u; if (WALL.war) return; u.key = WALL_KEYS[i]; u.keyB = BLUE_KEYS[i]; u.keyLabel = KEY_LABEL[u.key] || u.key.replace("Key", ""); unitByKey[u.key] = u; unitByKeyB[u.keyB] = u; });
  // 2026-10-22 엘리베이터 이동 전쟁 (아파트 한 채): 1인당 버튼 = ↑ ↓ + 호실 8개(지금 엘리베이터가 선 층의 N01~N08).
  //   빨강: ↑ W / ↓ S / 호실 1~8 = 숫자 1~8 · 파랑: ↑↓ 방향키 / 호실 1~8 = Y U I O H J K L (또는 숫자패드 1~8, 또는 Shift+숫자).
  //   현장 아케이드 버튼 인코더는 이 키로 연결 (벽버튼_배선표.csv).
  var WAR_KEYS = {
    "1": { up: ["KeyW"], down: ["KeyS"], slot: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8"] },
    "2": { up: ["ArrowUp"], down: ["ArrowDown"], slot: ["KeyY", "KeyU", "KeyI", "KeyO", "KeyH", "KeyJ", "KeyK", "KeyL"], slot2: ["Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8"] },
  };
  var WAR_KEY_LABEL = { "1": { up: "W", down: "S", slot: ["1", "2", "3", "4", "5", "6", "7", "8"] }, "2": { up: "↑", down: "↓", slot: ["Y", "U", "I", "O", "H", "J", "K", "L"] } };
  function dWar() { return !!(state && state.delivery && state.delivery.elev && state.delivery.elev.war); }
  function warKey(code, shift) {
    for (var s = 1; s <= 2; s++) {
      var k = WAR_KEYS[s], t = String(s);
      if (k.up.indexOf(code) >= 0) return { team: t, dir: "up" };
      if (k.down.indexOf(code) >= 0) return { team: t, dir: "down" };
      var i = k.slot.indexOf(code); if (i < 0 && k.slot2) i = k.slot2.indexOf(code);
      if (i >= 0) return { team: shift && t === "1" ? "2" : t, slot: i + 1 };
    }
    return null;
  }
  function dPair() { return !!(state && state.wallRule && state.wallRule.pair); }
  function unitAddr(u) { if (WALL.war) return u.floor + "층 " + u.label; return u.b === "house" ? u.label : (u.b === "apt" ? "아파트 " + u.floor + "층 " + u.label : "맨션 " + u.label); }
  function invAddr(inv) { return (inv && inv.unit && unitById[inv.unit]) ? unitAddr(unitById[inv.unit]) : roomCode(inv.floorIdx, inv.room); }
  function bShort(b) { return b === "apt" ? "아파트" : (b === "mansion" ? "맨션" : "주택"); }
  function dStats(st, s) {
    var invs = st.players[s].invoices, r = { got: invs.length, gotSum: 0, done: 0, doneSum: 0, pending: [], returned: 0, lost: 0, wrong: st.players[s].wrong || 0 };
    r.blocks = st.players[s].blocks || 0; r.blockSum = r.blocks * ((st.wallRule && st.wallRule.blockReward) || 0);
    var rule = setRuleOf(st);
    r.kinds = deliveredKinds(invs); r.kindsNeed = rule.kinds; r.kindsAmt = rule.amount;
    r.blds = deliveredBlds(invs); r.bldAmt = (st.wallRule && st.wallRule.bldBonus) || 0;
    r.combo = (r.kindsAmt > 0 && r.kinds >= r.kindsNeed ? r.kindsAmt : 0) + (r.bldAmt > 0 && r.blds >= 3 ? r.bldAmt : 0);
    invs.forEach(function (v) {
      r.gotSum += invReward(v);
      if (v.lost) { r.lost++; return; }
      if (v.returned) r.returned++;
      else if (v.deliveredRound !== null && !v.stolen) { r.done++; r.doneSum += invReward(v); }
      else if (v.deliveredRound === null) r.pending.push(v);
    });
    r.live = r.doneSum + r.combo + r.blockSum; // 배송 화면 "실적" (미배송 감점은 끝나고 계산)
    return r;
  }
  // 2026-10-16 같은 집 쟁탈: 두 팀이 다 미배송으로 들고 있는 집
  function dHeld(st, s, unit) { return st.players[s].invoices.some(function (v) { return v.unit === unit && v.deliveredRound === null && !v.returned && !v.lost; }); }
  function dContested(st, unit) { return dHeld(st, "1", unit) && dHeld(st, "2", unit); }
  // 줄다리기 막대: 두 팀 실적 차이
  function dTug(st) {
    var a = dStats(st, "1").live, b = dStats(st, "2").live, diff = a - b;
    var pct = 50 + Math.max(-46, Math.min(46, diff / Math.max(10000, Math.abs(a) + Math.abs(b)) * 50));
    var lead = diff === 0 ? '<span class="d-tug-even">동점</span>' : '<span class="d-tug-lead t' + (diff > 0 ? "1" : "2") + '">' + TEAM[diff > 0 ? "1" : "2"] + ' <b>+' + dWon(Math.abs(diff)) + '</b></span>';
    return '<div class="d-tug"><div class="d-tug-bar"><i class="d-tug-1" style="width:' + pct.toFixed(1) + '%"></i><i class="d-tug-2" style="width:' + (100 - pct).toFixed(1) + '%"></i><em style="left:' + pct.toFixed(1) + '%"></em></div>' + lead + '</div>';
  }
  function comboChips(x) {
    var h = '';
    if (x.kindsAmt > 0) h += '<span class="d-combo' + (x.kinds >= x.kindsNeed ? ' on' : '') + '">종류 콤보 <b>' + Math.min(x.kinds, x.kindsNeed) + '/' + x.kindsNeed + '</b> <small>+' + dWon(x.kindsAmt) + '</small></span>';
    if (x.bldAmt > 0) h += '<span class="d-combo' + (x.blds >= 3 ? ' on' : '') + '">건물 콤보 <b>' + Math.min(x.blds, 3) + '/3</b> <small>+' + dWon(x.bldAmt) + '</small></span>';
    return h ? '<div class="d-combos">' + h + '</div>' : '';
  }
  function dActive(st, s) {
    var d = st.delivery, out = null;
    if (!d) return null;
    Object.keys(d.doors).forEach(function (id) { if (d.doors[id].seat === s) out = { unit: id, door: d.doors[id] }; });
    return out;
  }
  function dNeedMs(door) { var w = state.wallRule || {}; return door.mode === "bell" ? (w.bellWindowMs || 1800) : door.hold ? (w.holdMs || 2000) : (w.progressMs || 5000); }
  // 2026-10-16 건물별 배송 방식: wait(아파트, 시간) / climb(맨션, 계단 연타) / bell(주택, 초인종 -> 문 열리면 한 번 더)
  function dModeOf(b) { var m = state && state.wallRule && state.wallRule.modes; return (m && m[b]) || "wait"; }
  function dClimbNeed(u) { var c = state && state.wallRule && state.wallRule.climb; return (c && (c[u.floor] || c[1])) || 5; }
  function dDoorAttrs(door) {
    if (door.mode === "climb") return ' data-mode="climb" style="--p:' + (door.steps / door.need).toFixed(3) + '"';
    if (door.mode === "bell") return ' data-mode="bell" data-dopen="' + door.openAt + '" data-dstart="' + door.openAt + '" data-dneed="' + dNeedMs(door) + '"';
    return ' data-dstart="' + door.start + '" data-dneed="' + dNeedMs(door) + '"';
  }
  // 진행 중 한 줄 안내 (플레이어 화면)
  function dDoorNote(door) {
    if (door.mode === "climb") return ' · 계단 <b>' + door.steps + '/' + door.need + '</b> · 팀 키 누른 채 계속 연타!';
    if (door.mode === "bell") return ' · <span class="d-bell-wait">띵동… 문 열리면 한 번 더!</span><span class="d-bell-open">문 열림! 지금 한 번 더!</span>';
    return '';
  }
  function dClock(st) { return '<b class="d-clock" data-ends="' + (st.delivery.endsAt || nowMs()) + '">' + fmtClock((st.delivery.endsAt || nowMs()) - nowMs()) + '</b>'; }

  // 호실 버튼 하나. interactive: 레일 화면(키/클릭) 또는 레일이 없을 때 플레이어 화면(탭)
  function unitBtn(st, u, keyHint) {
    var door = st.delivery.doors[u.id];
    var vs = dContested(st, u.id);
    var cls = 'du du-' + u.b + (door ? ' on-' + door.seat : '') + (vs ? ' du-vs' : '');
    var taps = door && door.taps ? '<span class="du-taps">막기 ' + door.taps + '/' + ((st.wallRule && st.wallRule.returnTaps) || 5) + '</span>' : '';
    // 2026-10-16 (사용자: "너무 난잡"): 메인 화면에선 문마다 표 하나 -- [호수 | 키] 칩. 맨션은 그림 속 호수가 커서 키만.
    var num = u.b === "house" ? u.label.replace("성수로 ", "") : u.label.replace("호", "");
    var chip = keyHint ? '<span class="du-chip">' + (u.b === "mansion" ? '' : '<b>' + esc(num) + '</b>') + '<kbd>' + esc(u.keyLabel) + '</kbd></span>' : '<span class="du-label">' + esc(u.b === "house" ? u.label.replace("성수로 ", "") : u.label) + '</span>';
    var steps = door && door.mode === "climb" ? '<span class="du-steps">' + door.steps + '/' + door.need + '</span>' : door && door.mode === "bell" ? '<span class="du-bell"></span>' : '';
    return '<button class="' + cls + '" data-unit="' + u.id + '"' + (door ? dDoorAttrs(door) : '') + ' aria-label="' + esc(unitAddr(u)) + '">'
      + '<span class="du-ring"></span>' + taps + steps + (vs && !door ? '<span class="du-vsb">⚔</span>' : '') + chip + '</button>';
  }
  function renderWalls(st, keyHint) {
    var d = st.delivery, ef = d.elev ? d.elev.floor : null;
    // 2026-10-16 (사용자 제공 그림): 아파트는 그림(ui_art/town_apt.jpg, 7층 x 701·702) 위 각 문 자리에 버튼을 겹친다.
    //   위치는 그림 기준 비율(%) -- 층 가운데 y(그림 510px 기준)와 문 x 범위. 엘리베이터 칸은 승강로 위에서 움직인다.
    var ROW_Y = { 7: 70, 6: 129, 5: 188, 4: 247, 3: 306, 2: 365, 1: 426 }, IH = 510, IW = 405;
    var pct = function (v, of) { return (v / of * 100).toFixed(2) + '%'; };
    var apt = '<div class="dw dw-apt dw-img"><div class="dw-name">아파트</div><div class="dw-fit"><div class="dw-apt-pic">';
    for (var f = 7; f >= 1; f--) {
      var top = pct(ROW_Y[f] - 27, IH), hh = pct(54, IH);
      apt += '<span class="dw-fl-hl' + (ef === f ? ' here' : '') + '" style="top:' + top + ';height:' + hh + '"></span>'
        + '<span class="dw-slot" style="left:' + pct(104, IW) + ';top:' + top + ';width:' + pct(84, IW) + ';height:' + hh + '">' + unitBtn(st, unitById["a" + f + "01"], keyHint) + '</span>'
        + '<span class="dw-slot" style="left:' + pct(234, IW) + ';top:' + top + ';width:' + pct(84, IW) + ';height:' + hh + '">' + unitBtn(st, unitById["a" + f + "02"], keyHint) + '</span>';
    }
    if (ef) apt += '<i class="dw-car-img" style="top:' + pct(ROW_Y[ef] - 26, IH) + ';height:' + pct(52, IH) + '"></i>';
    apt += '</div></div></div>'; // dw-fit: 3분할에서 칸 크기에 비율 유지로 맞추는 틀
    // 2026-10-16 (사용자 제공 그림 2): 맨션 그림(ui_art/town_mansion.jpg, 2층 x 201~206 / 101~106 -- 우리 호실과 같음) 위 문 자리에 버튼.
    var MW = 740, MH = 300, MX = [117, 227, 332, 437, 535, 620], MY = { 2: 75, 1: 220 }; // 외벽만 잘라 낸 그림(740x300) 기준
    var man = '<div class="dw dw-mansion dw-img"><div class="dw-name">맨션</div><div class="dw-fit"><div class="dw-man-pic">';
    [2, 1].forEach(function (f) { for (var k = 1; k <= 6; k++) {
      man += '<span class="dw-slot dw-mslot" style="left:' + pct(MX[k - 1] - 44, MW) + ';top:' + pct(MY[f] - 58, MH) + ';width:' + pct(88, MW) + ';height:' + pct(116, MH) + '">' + unitBtn(st, unitById["m" + f + "0" + k], keyHint) + '</span>';
    } });
    man += '</div></div></div>';
    var hs = '<div class="dw dw-house dw-img"><div class="dw-name">주택 <small>성수로</small></div><div class="dw-house-grid">';
    for (var h = 1; h <= 8; h++) hs += '<div class="dw-home dw-home-pic hp' + (((h - 1) % 4) + 1) + '">' + unitBtn(st, unitById["h" + h], keyHint) + '</div>';
    hs += '</div></div>';
    // 2026-10-22 (사용자: 메인이 한 화면에 다 안 나옴): 메인 화면은 아파트 | 맨션 | 주택 3분할, 화면 높이에 맞춤 (스크롤 없음)
    return keyHint ? '<div class="dwalls dwalls3">' + apt + man + hs + '</div>' : '<div class="dwalls">' + apt + man + hs + '</div>';
  }
  function elevCtl(st, withButtons) {
    var e = st.delivery.elev;
    if (!e) return '';
    if (e.war) return '<div class="d-elev' + (e.open ? ' open' : '') + '"><span class="d-elev-l">엘리베이터</span><b class="d-elev-f">' + e.floor + '층</b><span class="d-elev-st">' + (e.open ? '문 열림' : '이동 전쟁') + '</span></div>';
    return '<div class="d-elev" data-moving="' + (e.movingUntil || 0) + '"><span class="d-elev-l">엘리베이터</span><b class="d-elev-f">' + e.floor + '층</b><span class="d-elev-mv">이동 중</span></div>';
  }

  // 2026-10-22 (사용자 결정): 엘리베이터 전쟁 입력은 각자 화면. 이동 단계 = 큰 ▲▼, 배송 단계 = 지금 층 문 8개(내 택배 있는 집만 눌림)
  function renderWarPlayer(st, seat) {
    var s = dStats(st, seat), e = st.delivery.elev, w = warRule(st), per = WALL.perFloor || 8, mv = e.stage !== "deliver";
    var ctl;
    if (mv) {
      ctl = '<div class="wp-move"><button class="wp-arrow up" data-war="up" aria-label="위로">▲</button><div class="wp-floor"><b>' + e.floor + '</b><small>층</small></div><button class="wp-arrow down" data-war="down" aria-label="아래로">▼</button></div>';
    } else {
      var doors = '', ms = (st.delivery.mash && st.delivery.mash[seat]) || {}, need = w.deliverTaps || 3;
      for (var n = 1; n <= per; n++) {
        var u = unitById["a" + e.floor + "0" + n], c = dHeldCat(st, seat, u.id), mine = c >= 0, p = (ms[u.id] || 0) / need;
        doors += (n === per / 2 + 1 ? '<i class="wp-shaft"></i>' : '') + '<button class="wp-door' + (mine ? ' mine' : '') + '" data-war="slot" data-slot="' + n + '"' + (mine ? '' : ' disabled') + ' style="--p:' + p.toFixed(2) + '">'
          + '<b>' + esc(u.label.replace("호", "")) + '</b>' + (mine ? medal(c) + '<i class="wp-door-bar"><i></i></i>' : '') + '</button>';
      }
      ctl = '<div class="wp-doors">' + doors + '</div>';
    }
    var slips = s.pending.slice().sort(function (a, b) { var ua = unitById[a.unit], ub = unitById[b.unit]; return (ub ? ub.floor : 0) - (ua ? ua.floor : 0); }).map(function (v) {
      var u = unitById[v.unit], other = seat === "1" ? "2" : "1", vsx = u && dHeld(st, other, v.unit), here = u && u.floor === e.floor;
      return '<div class="wp-slip' + (here ? ' here' : '') + (vsx ? ' vs' : '') + '">' + medal(v.catIdx) + '<b>' + esc(u ? u.label.replace("호", "") : invAddr(v)) + '</b>' + (vsx ? '<span class="wp-vs">⚔</span>' : '') + '</div>';
    }).join('');
    return '<main class="stage stage--dlv">' + cartOpen('cart--dlv') + '<div class="dlv wp t' + seat + '">'
      + '<div class="dlv-top"><span class="dlv-team t' + seat + '">' + TEAM[seat] + '</span>' + dClock(st)
      + '<span class="dlv-earn">' + dCount("p" + seat, s.live) + '<small>' + s.done + '건</small></span></div>'
      + dTug(st) + warStage(st, true) + ctl
      + '<div class="wp-slips">' + (slips || '<div class="wp-clear">다 배송했어요!</div>') + '</div>'
      + '</div>' + cartClose() + '</main>';
  }
  // 플레이어 화면: 내 송장(주소)과 지금 할 일만 크게
  function renderDelivery(st, seat) {
    if (dWar()) return renderWarPlayer(st, seat);
    var s = dStats(st, seat), act = dActive(st, seat), rail = railInfo && railInfo.count > 0;
    var now = '';
    if (dWar()) {
      var e = st.delivery.elev, mineHere = s.pending.filter(function (v) { var u = unitById[v.unit]; return u && u.floor === e.floor; });
      var fl = warFloors(st, seat), fk = Object.keys(fl).sort(function (a, b) { return b - a; });
      var L = WAR_KEY_LABEL[seat];
      if (!s.pending.length) now = '<div class="d-now is-clear">내 택배를 모두 배송했어요</div>';
      else if (e.open && mineHere.length) now = '<div class="d-now is-on t' + seat + '"><b>' + e.floor + '층 문 열림!</b> ' + mineHere.map(function (v) { return esc(unitById[v.unit].label); }).join(' · ') + ' 버튼 <b>' + (warRule(st).deliverTaps || 3) + '번</b> 연타!</div>';
      else now = '<div class="d-now">엘리베이터 <b>' + e.floor + '층</b>' + (e.open ? ' (문 열림 -- 내 택배 없음)' : '') + ' · 내 택배 층 <b>' + fk.join(', ') + '</b> · ' + esc(L.up) + '/' + esc(L.down) + ' <b>' + (warRule(st).taps || 5) + '번</b> 먼저 누르면 한 층</div>';
    } else if (act) {
      var u = unitById[act.unit];
      now = '<div class="d-now is-on t' + seat + '"' + dDoorAttrs(act.door) + '><b>' + esc(unitAddr(u)) + '</b> 배송 중' + dDoorNote(act.door) + (act.door.hold ? ' · 손 떼지 마세요' : (act.door.taps ? ' · 상대가 막는 중 ' + act.door.taps + '/' + ((st.wallRule && st.wallRule.returnTaps) || 5) + '!' : '')) + '<i class="d-now-bar"><i></i></i></div>';
    } else if (s.pending.length) {
      now = '<div class="d-now">' + (st.wallRule && st.wallRule.holdMs ? '메인 컴퓨터에서 <b>' + TEAM_KEY[seat] + '</b> + 호실 키를 <b>' + Math.round(st.wallRule.holdMs / 1000) + '초</b> 누르고 있으면 배송 완료'
        : dPair() ? '집 앞 <b>' + (seat === "1" ? '빨간' : '파란') + ' 버튼</b>으로 배송 · ' + dHowShort(st) + ' · 상대가 켠 집은 내 색 버튼 <b>' + ((st.wallRule && st.wallRule.returnTaps) || 5) + '번</b>으로 막기'
        : '메인 컴퓨터에서 <b>' + TEAM_KEY[seat] + '</b> 누른 채 호실 키 · ' + dHowShort(st) + ' · 상대 배송은 그 호실 키 <b>' + ((st.wallRule && st.wallRule.returnTaps) || 5) + '번</b> 연타로 막기') + '</div>';
    } else now = '<div class="d-now is-clear">내 택배를 모두 처리했어요</div>';
    var slips = s.pending.map(function (v) {
      var u = unitById[v.unit];
      var on = act && act.unit === v.unit;
      var other = seat === "1" ? "2" : "1", vsx = u && dHeld(st, other, v.unit);
      return '<div class="d-slip' + (on ? ' on' : '') + (vsx ? ' vs' : '') + '">' + (vsx ? '<span class="d-slip-vs">⚔ 상대도 이 집!</span>' : '') + (WALL.war ? '' : '<span class="d-slip-b">' + esc(u ? bShort(u.b) : '') + '</span>') + '<span class="d-slip-a">' + medal(v.catIdx, 'big') + esc(u ? (u.b === "apt" ? u.floor + "층 " + u.label : u.label) : invAddr(v)) + '</span><span class="d-slip-w">' + (WALL.war ? '' : '<i class="d-kind fee-t' + v.catIdx + '">' + esc(TYPES[v.catIdx].name) + '</i> ') + dWon(invReward(v)) + '</span></div>';
    }).join('');
    var html = '<main class="stage stage--dlv">' + cartOpen('cart--dlv') + '<div class="dlv t' + seat + '">'
      + '<div class="dlv-top"><span class="dlv-team t' + seat + '">' + TEAM[seat] + '</span>' + dClock(st)
      + '<span class="dlv-earn">실적 ' + dCount("p" + seat, s.live) + '<small>배송 ' + s.done + '건' + (s.blocks ? ' · 막기 ' + s.blocks : '') + '</small></span></div>'
      + dTug(st)
      + comboChips(s)
      + now
      + '<div class="d-slips">' + (slips || '') + '</div>'
      + elevCtl(st, false)
      + '</div>' + cartClose() + '</main>';
    return html;
  }

  // 건물별 배송 방법 한 줄 요약
  function dHowShort(st) {
    var w = st.wallRule || {}, sec = Math.round((w.progressMs || 5000) / 1000), c = w.climb || {};
    var t = { wait: function () { return '<b>' + sec + '초</b> 기다리기'; }, climb: function () { return '키 <b>' + (c[1] || 5) + (c[2] && c[2] !== c[1] ? '·' + c[2] : '') + '번</b> 연타(계단)'; }, bell: function () { return '초인종 → 문 열리면 <b>한 번 더</b>'; } };
    return ['apt', 'mansion', 'house'].map(function (b) { return bShort(b) + ' ' + t[dModeOf(b)](); }).join(' · ');
  }
  // 팀 점수 칸 (레일 화면 위쪽 작게 / 메인 모니터 크게)
  function teamCard(st, s, big) {
    var x = dStats(st, s), act = dActive(st, s);
    var combN = (x.kindsAmt > 0 && x.kinds >= x.kindsNeed ? 1 : 0) + (x.bldAmt > 0 && x.blds >= 3 ? 1 : 0);
    if (!big) return '<div class="d-team t' + s + '"><span>' + TEAM[s] + '</span>' + dCount("s" + s, x.live) + '<small>' + x.done + '건' + (combN ? ' · 콤보 ' + combN : '') + '</small></div>';
    return '<div class="d-team big t' + s + '"><div class="d-team-h">' + TEAM[s] + ' · 배송 실적</div><div class="d-team-v">' + dCount("b" + s, x.live) + '</div>'
      + '<div class="d-team-rows">'
      + '<div><span>획득</span><b>' + x.got + '개 · ' + dWon(x.gotSum) + '</b></div>'
      + '<div><span>배송 완료</span><b>' + x.done + '개 · ' + dWon(x.doneSum) + '</b></div>'
      + '<div><span>남은 택배</span><b>' + x.pending.length + '개</b></div>'
      + (dWar() ? '<div><span>⚔ 뺏김</span><b>' + x.lost + '개</b></div>' : '<div><span>막기 · 뺏김</span><b>' + x.blocks + '회' + (x.blockSum ? ' +' + dWon(x.blockSum) : '') + ' · ' + x.lost + '개</b></div>')
      + '<div><span>콤보</span><b>종류 ' + Math.min(x.kinds, x.kindsNeed) + '/' + x.kindsNeed + (x.bldAmt > 0 ? ' · 건물 ' + Math.min(x.blds, 3) + '/3' : '') + '</b></div>'
      + '<div><span>지금</span><b>' + (act ? esc(unitAddr(unitById[act.unit])) + ' 배송 중' : '—') + '</b></div>'
      + (x.returned || x.wrong ? '<div class="d-team-neg"><span>반송 · 오배송</span><b>' + x.returned + ' · ' + x.wrong + '</b></div>' : '')
      + '</div>' + (act ? '<i class="d-team-bar"' + dDoorAttrs(act.door) + '><i></i></i>' : '') + '</div>';
  }
  // 2026-10-16 (사용자 결정): 메인 컴퓨터 = 벽 + 입력(Ctrl/Shift + 호실 키 2초, Ctrl/Shift+↑↓ 엘리베이터). 레일 화면 = 두 팀 점수판.

  // ---------- 2026-10-22 엘리베이터 이동 전쟁 (아파트 한 채) ----------
  function warRule(st) { return (st.wallRule && st.wallRule.war) || { taps: 5, deliverTaps: 3, openMs: 2500 }; }
  function warFloors(st, s) { var c = {}; dStats(st, s).pending.forEach(function (v) { var u = unitById[v.unit]; if (u) c[u.floor] = (c[u.floor] || 0) + 1; }); return c; }
  // 그 집에 그 팀이 들고 있는 (미배송) 택배 종류
  function dHeldCat(st, s, unit) { var c = -1; st.players[s].invoices.forEach(function (v) { if (v.unit === unit && v.deliveredRound === null && !v.returned && !v.lost && v.catIdx > c) c = v.catIdx; }); return c; }
  function warUnit(st, u, e) {
    var h1 = dHeld(st, "1", u.id), h2 = dHeld(st, "2", u.id), here = e.floor === u.floor, open = here && e.open;
    var ms = st.delivery.mash || {}, need = warRule(st).deliverTaps || 3;
    var m1 = open && ms["1"] ? (ms["1"][u.id] || 0) : 0, m2 = open && ms["2"] ? (ms["2"][u.id] || 0) : 0;
    var cls = 'wu' + (h1 ? ' h1' : '') + (h2 ? ' h2' : '') + (h1 && h2 ? ' vs' : '') + (here ? ' here' : '') + (open ? ' open' : '') + (open && (h1 || h2) ? ' go' : '');
    var bars = open && (h1 || h2) ? '<span class="wu-bars">' + (h1 ? '<i class="t1" style="--p:' + (m1 / need).toFixed(2) + '"></i>' : '') + (h2 ? '<i class="t2" style="--p:' + (m2 / need).toFixed(2) + '"></i>' : '') + '</span>' : '';
    return '<div class="' + cls + '" data-unit="' + u.id + '"><span class="wu-door"></span><b>' + esc(u.label.replace("호", "")) + '</b>'
      + '<span class="wu-dots">' + (h1 ? medal(dHeldCat(st, "1", u.id), 'mt1') : '') + (h2 ? medal(dHeldCat(st, "2", u.id), 'mt2') : '') + '</span>'
      + (h1 && h2 ? '<span class="wu-vs">⚔</span>' : '') + bars + '</div>';
  }
  function warBuilding(st) {
    var e = st.delivery.elev, per = WALL.perFloor || 8, half = per / 2, h = '';
    for (var f = 7; f >= 1; f--) {
      var row = 8 - f;
      h += '<div class="wfl' + (e.floor === f ? ' here' : '') + '" style="grid-row:' + row + '"><b>' + f + 'F</b></div>';
      for (var n = 1; n <= per; n++) {
        var col = n <= half ? n + 1 : n + 2;
        h += '<div class="wcell" style="grid-row:' + row + ';grid-column:' + col + '">' + warUnit(st, unitById["a" + f + "0" + n], e) + '</div>';
      }
    }
    var top = ((7 - e.floor) / 7 * 100).toFixed(3);
    h += '<div class="wshaft" style="grid-row:1 / span 7;grid-column:' + (half + 2) + '"><div class="wcar' + (e.open ? ' open' : '') + '" style="top:' + top + '%"><i></i><i></i><b>' + e.floor + '</b></div></div>';
    return '<div class="wbld" style="--half:' + half + '">' + h + '</div>';
  }
  // 2026-10-22 (사용자 결정 2차): 이동 5초(누를 때마다 한 층) -> 택배 있는 층이면 배송 5초. 입력은 각자 플레이어 화면.
  function warStage(st, big) {
    var e = st.delivery.elev, w = warRule(st), mv = e.stage !== "deliver";
    var ends = mv ? e.stageEndsAt : e.openUntil, ms = mv ? (w.moveMs || 5000) : (w.openMs || 5000);
    return '<div class="wst ' + (mv ? 'war' : 'open') + (big ? ' big' : '') + '" data-wend="' + ends + '" data-wms="' + ms + '"><b>' + (mv ? '이동' : '배송') + ' <span class="wst-sec" data-wsec="' + ends + '">' + Math.max(0, Math.ceil((ends - nowMs()) / 1000)) + '</span></b>'
      + '<span>' + (mv ? '▲▼ 누른 만큼 움직여요' : e.floor + '층 내 집을 ' + (w.deliverTaps || 3) + '번씩!') + '</span><i class="wst-bar"><i></i></i></div>';
  }
  function warTeamFloors(st, s) {
    var e = st.delivery.elev, fl = {}, fk, mv = e.moves && e.moves[s];
    dStats(st, s).pending.forEach(function (v) { var u = unitById[v.unit]; if (u) (fl[u.floor] = fl[u.floor] || []).push(v.catIdx); });
    fk = Object.keys(fl).sort(function (a, b) { return b - a; });
    return '<div class="wg t' + s + '"><div class="wg-h">' + TEAM[s] + (mv && e.stage === "move" ? ' <small class="wg-mv">▲' + mv.up + ' ▼' + mv.down + '</small>' : '') + '</div>'
      + '<div class="wg-fl">' + (fk.length ? fk.map(function (f) { return '<span' + (+f === e.floor ? ' class="here"' : '') + '><em>' + f + '</em>' + fl[f].sort(function (a, b) { return b - a; }).map(function (c) { return medal(c, 'sm'); }).join('') + '</span>'; }).join('') : '<span class="done">다 배송!</span>') + '</div></div>';
  }
  function warPanel(st) {
    var e = st.delivery.elev;
    if (dLocal.wFloor !== e.floor) { if (dLocal.wFloor != null) dLocal.wFloorAt = nowMs(); dLocal.wFloor = e.floor; }
    var since = dLocal.wFloorAt ? nowMs() - dLocal.wFloorAt : 1e9, pop = since < 600 ? ' class="pop" style="animation-delay:-' + Math.round(since) + 'ms"' : '';
    return '<div class="wpanel"><div class="wfloor"><b' + pop + '>' + e.floor + '<em>층</em></b></div>' + warStage(st)
      + warTeamFloors(st, "1") + warTeamFloors(st, "2") + '</div>';
  }
  function renderWarMain(st, head, halfName) {
    var w = warRule(st), L1 = WAR_KEY_LABEL["1"], L2 = WAR_KEY_LABEL["2"];
    return head("배송 · " + halfName) + '<div class="mv-body rv-dlv d-main d-war">'
      + '<div class="d-bar">' + teamCard(st, "1", false) + '<div class="d-bar-mid">' + dClock(st) + '</div>' + teamCard(st, "2", false) + '</div>'
      + dTug(st)
      + '<div class="wwrap">' + warBuilding(st) + warPanel(st) + '</div>'
      + '<div class="d-keys1"><b>이동 5초</b> ▲▼ 누른 만큼 · <b>배송 5초</b> 그 층 내 집 ' + (w.deliverTaps || 3) + '번씩 · ⚔ 먼저 채운 사람만</div></div>';
  }
  function renderMainDelivery(st, head, halfName) {
    if (st.delivery && st.delivery.elev && st.delivery.elev.war) return renderWarMain(st, head, halfName);
    return head("배송 · " + halfName) + '<div class="mv-body rv-dlv d-main">'
      + '<div class="d-bar">' + teamCard(st, "1", false) + '<div class="d-bar-mid">' + dClock(st) + elevCtl(st, false) + '</div>' + teamCard(st, "2", false) + '</div>'
      + dTug(st)
      + renderWalls(st, true)
      + '<div class="d-keys1">' + (dPair() ? '<span class="t1"><b>빨간 버튼</b> 빨강</span><span class="t2"><b>파란 버튼</b> 파랑</span> · ' + dHowShort(st) + ' · <b>↑↓</b> 엘리베이터 · 상대가 켠 집 내 색 버튼 <b>5번</b> = 막기 <small>(키보드: 호실 키 = 빨강, Shift+호실 키 = 파랑)</small>'
        : '<span class="t1"><b>Ctrl</b> 빨강</span><span class="t2"><b>Shift</b> 파랑</span> + 호실 키 · ' + dHowShort(st) + ' · <b>↑↓</b> 엘리베이터 · 켜진 호실 키 <b>5번</b> = 막기') + ((st.wallRule && st.wallRule.blockReward) ? ' <b>+' + dWon(st.wallRule.blockReward) + '</b>' : '') + ((st.wallRule && st.wallRule.contest) ? ' · <b>⚔</b> 두 팀 다 가진 집 = 먼저 보내면 상대 것 무효' : '') + '</div></div>';
  }
  function renderRailDelivery(st, head, halfName) {
    return '<div class="rv">' + head("배송 · " + halfName) + '<div class="d-board">'
      + teamCard(st, "1", true)
      + '<div class="d-board-mid">' + dClock(st) + elevCtl(st, false) + dTug(st) + '</div>'
      + teamCard(st, "2", true) + '</div></div>';
  }

  // ---- 소리 ----
  var dAudio = null;
  function dTone(f, t, dur, type, vol) {
    try {
      if (!dAudio) dAudio = new (window.AudioContext || window.webkitAudioContext)();
      if (dAudio.state === "suspended") dAudio.resume();
      var o = dAudio.createOscillator(), g = dAudio.createGain(), s0 = dAudio.currentTime + t;
      o.type = type || "sine"; o.frequency.value = f; g.gain.setValueAtTime(vol || 0.2, s0); g.gain.exponentialRampToValueAtTime(0.001, s0 + dur);
      o.connect(g); g.connect(dAudio.destination); o.start(s0); o.stop(s0 + dur + 0.02);
    } catch (e) {}
  }
  var DSND = {
    start: function () { dTone(659, 0, 0.45); dTone(523, 0.25, 0.6); },
    done: function () { dTone(1046, 0, 0.1, "triangle", 0.25); dTone(1318, 0.1, 0.1, "triangle", 0.25); dTone(1568, 0.2, 0.3, "triangle", 0.25); },
    err: function () { dTone(150, 0, 0.3, "square", 0.08); },
    soft: function () { dTone(330, 0, 0.18, "triangle", 0.12); },
    beep: function () { dTone(880, 0, 0.14, "square", 0.08); },
    step: function (n) { dTone(392 + n * 45, 0, 0.09, "triangle", 0.14); },
    coin: function () { dTone(988, 0.05, 0.08, "square", 0.1); dTone(1319, 0.13, 0.35, "square", 0.1); },
    pulse: function (hi) { dTone(hi ? 110 : 82, 0, 0.16, "sawtooth", 0.13); },
    fever: function () { [523, 659, 784, 1046, 784, 1046, 1318].forEach(function (f, i) { dTone(f, i * 0.08, 0.12, "square", 0.12); }); },
    lead: function () { dTone(523, 0, 0.12, "square", 0.12); dTone(659, 0.12, 0.12, "square", 0.12); dTone(784, 0.24, 0.12, "square", 0.12); dTone(1046, 0.36, 0.35, "square", 0.14); },
    open: function () { dTone(784, 0, 0.12, "sine", 0.25); dTone(988, 0.08, 0.2, "sine", 0.25); },
  };

  // ---- 이벤트 → 소리·팝업 (진행 중 표시와 겹치지 않게 결과만 팝업) ----
  var dLocal = { lastEv: -1, keyHold: {}, ptrHold: null, beeped: {}, shown: {} };
  function dPop(kind, title, sub, team) {
    var el = document.getElementById("dpop");
    if (!el) { el = document.createElement("div"); el.id = "dpop"; document.body.appendChild(el); }
    el.className = "dpop " + kind + (team ? " t" + team : "");
    el.innerHTML = '<b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '');
    void el.offsetWidth; el.classList.add("show");
    clearTimeout(dLocal.popT); dLocal.popT = setTimeout(function () { el.classList.remove("show"); }, kind === "ok" ? 2200 : 1600);
  }
  function dEvents(st) {
    if (!st || st.phase !== "delivery" || !st.delivery) { dLocal.lastEv = -1; dLocal.beeped = {}; dLocal.shown = {}; return; }
    var evs = st.delivery.ev || [];
    if (dLocal.lastEv < 0) { dLocal.lastEv = evs.length ? evs[evs.length - 1].n : 0; return; }
    var me = (RAIL || MAIN) ? null : mySeat();
    evs.forEach(function (e) {
      if (e.n <= dLocal.lastEv) return;
      dLocal.lastEv = e.n;
      var mine = !me || e.seat === me, u = unitById[e.unit], addr = u ? unitAddr(u) : "", who = e.seat ? TEAM[e.seat] : "";
      if (e.k === "move") { if (MAIN) { dTone(220 + (e.floor || 1) * 40, 0, 0.12, "sawtooth", 0.06); dTone(660 + (e.floor || 1) * 40, 0.08, 0.18, "sine", 0.22); } return; } // 엘리베이터 이동음 (층마다 음 높이)
      if (e.k === "open") { DSND.open(); if (e.forced && MAIN) { dSay("버티기 끝!"); dPop("warn", "버티다가 " + e.floor + "층에서 문이 열렸어요", "", null); } return; }
      if (e.k === "close" || e.k === "elevend") return;
      if (e.k === "empty") { DSND.soft(); return; }
      if (e.k === "shut") { if (mine) { DSND.err(); dPop("warn", (me ? "" : who + " · ") + "문이 닫혔어요", addr + " · 연타 " + (e.taps || 0) + "번은 처음부터", e.seat); } return; }
      if (e.k === "closed" || (e.k === "noelev" && dWar())) { if (me && mine) { DSND.soft(); dPop("warn", e.k === "closed" ? "문이 닫혀 있어요" : "엘리베이터가 " + (e.floor || "?") + "층이에요", "멈추고 문이 열려야 배송돼요", e.seat); } else if (mine) DSND.soft(); return; }
      if (e.k === "start") { if (mine || !me) DSND.start(); return; }
      if (e.k === "step") { if (mine) DSND.step(e.steps || 0); return; }
      if (e.k === "done") {
        DSND.done(); DSND.coin();
        dJuice(e);
        var stk = e.streak >= 2 ? " · " + e.streak + "연속!" : "", fv = e.fever ? "FEVER " : "";
        if (e.streak >= 3) dSay(e.streak + "연속!");
        if (e.snatched) dSay("선점!");
        if (mine) {
          if (e.combos && e.combos.length) {
            var cTitle = e.combos.map(function (c) { return c.k === "bld" ? "모든 건물 배송" : "모든 종류 배송"; }).join(" + ");
            var cAmt = e.combos.reduce(function (a, c) { return a + c.amount; }, 0);
            setTimeout(function () { DSND.done(); dPop("ok combo", "콤보! " + cTitle + " +" + dWon(cAmt), (me ? "" : who + " · ") + "배송 +" + dWon(e.reward || 0) + " · " + addr, e.seat); }, 50);
          } else if (e.snatched) dPop("ok vs", "선점! +" + dWon(e.reward || 0), (me ? "" : who + " · ") + addr + " · 상대 택배 무효 (−" + dWon(e.snatched) + ")", e.seat);
          else dPop("ok" + (e.fever ? " fever" : ""), fv + "배송 완료! +" + dWon(e.reward || 0) + stk, (me ? "" : who + " · ") + addr + " · 누적 배송 " + (e.count || 0) + "건", e.seat);
        } else if (e.snatched) { DSND.err(); dPop("bad", "선점당했어요!", addr + " · 상대가 먼저 배송 -- 이 택배는 무효", me); }
        return;
      }
      if (e.k === "tap") { DSND.soft(); if (!me) dPop("warn", TEAM[e.seat] + " 배송 막는 중 " + (e.taps || 0) + "/" + ((st.wallRule && st.wallRule.returnTaps) || 5), addr, e.seat); return; }
      if (e.k === "returned") {
        var gain = e.gain ? " · " + TEAM[e.blocker] + " +" + dWon(e.gain) : "";
        dSay("막았다!"); dShake();
        if (me && e.blocker === me) { DSND.done(); dPop("ok vs", "막기 성공! +" + dWon(e.gain || 0), addr + " · 상대 택배 반송", me); }
        else { DSND.err(); dPop("bad", (me && e.seat === me ? "상대가 막았어요! 반송" : who + " 배송 막힘! 반송"), addr + gain + " · 다시 보낼 수 있어요", e.seat); }
        return;
      }
      if (!mine) return;
      var pre = me ? "" : who + " · ";
      if (e.k === "wrong") { DSND.err(); dPop("bad", pre + "오배송! 내 택배가 없는 집", addr + " · -" + dWon((st.wallRule && st.wallRule.wrongPenalty) || 0), e.seat); }
      else if (e.k === "elevmoving") { DSND.err(); dPop("warn", pre + "엘리베이터가 움직이는 중", "멈춘 뒤에 아파트 배송을 시작하세요", e.seat); }
      else if (e.k === "noelev") { DSND.err(); dPop("warn", pre + "엘리베이터가 " + (e.floor || "?") + "층에 있어요", addr + "는 엘리베이터가 와야 배송돼요", e.seat); }
      else if (e.k === "elevleft") { DSND.err(); dPop("bad", pre + "엘리베이터가 떠났어요", addr + " 배송 실패 · 다시 누르세요", e.seat); }
      else if (e.k === "released") { DSND.soft(); dPop("warn", pre + "손을 뗐어요", addr + " · 처음부터 다시", e.seat); }
      else if (e.k === "busy") { DSND.soft(); dPop("warn", pre + "한 번에 한 집만", "누르고 있는 집을 먼저 끝내세요", e.seat); }
      else if (e.k === "early") { DSND.err(); dPop("warn", pre + "아직 문이 안 열렸어요", addr + " · 초인종을 다시 눌렀어요, 초록 불을 기다리세요", e.seat); }
      else if (e.k === "missed") { DSND.err(); dPop("warn", pre + "문이 닫혔어요", addr + " · 초인종부터 다시", e.seat); }
      else if (e.k === "taken") { DSND.soft(); dPop("warn", pre + "상대 팀이 배송 중인 집", dHeld(st, e.seat, e.unit) ? "내 택배도 있는 집! 그냥 5번 연타로 막고 내가 먼저 보내세요" : "막으려면 Ctrl/Shift 없이 그 키를 5번 연타", e.seat); }
    });
  }
  // ---- 2026-10-16 아케이드 연출: 아나운서 / 흔들림 / 떠오르는 점수 / 숫자 올라가기 / 피버 ----
  // 음성은 메인 컴퓨터에서만 (화면 여러 대가 같이 말하지 않게). 한국어 음성이 없는 기기면 조용히 넘어간다.
  function dSay(t) {
    if (!MAIN || !window.speechSynthesis) return;
    try { speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(t); u.lang = "ko-KR"; u.rate = 1.2; u.pitch = 1.15; u.volume = 1; speechSynthesis.speak(u); } catch (e) {}
  }
  function dShake() { if (!MAIN && !RAIL) return; document.body.classList.remove("d-shake"); void document.body.offsetWidth; document.body.classList.add("d-shake"); clearTimeout(dLocal.shT); dLocal.shT = setTimeout(function () { document.body.classList.remove("d-shake"); }, 450); }
  function dJuice(e) {
    if (!MAIN && !RAIL) return;
    if (e.fever || e.snatched || e.streak >= 3) dShake();
    var el = document.querySelector('[data-unit="' + e.unit + '"]') || document.querySelector('.d-team.t' + e.seat);
    if (!el) return;
    var r = el.getBoundingClientRect(), f = document.createElement("div");
    f.className = "d-float t" + e.seat + (e.fever ? " fever" : "");
    f.innerHTML = '+' + dWon(e.reward || 0) + (e.streak >= 2 ? '<small>' + e.streak + '연속</small>' : '');
    f.style.left = (r.left + r.width / 2) + "px"; f.style.top = (r.top + r.height / 2) + "px";
    document.body.appendChild(f);
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1400);
  }
  // 점수 숫자: 렌더 때는 직전에 보이던 값, dTick에서 목표값까지 촤라락
  function dCount(key, val) {
    var shown = dLocal.shown[key]; if (shown == null) shown = dLocal.shown[key] = val;
    return '<b class="d-cnt" data-ck="' + key + '" data-cv="' + val + '">' + dWon(shown) + '</b>';
  }
  // 2026-10-16 역전 알림: 실적 1등이 바뀌면 (동점은 무시)
  function dLeadCheck(st) {
    if (!st || st.phase !== "delivery" || !st.delivery) { dLocal.leader = null; return; }
    var a = dStats(st, "1").live, b = dStats(st, "2").live, ld = a === b ? null : (a > b ? "1" : "2");
    if (ld && dLocal.leader && ld !== dLocal.leader) { setTimeout(function () { DSND.lead(); dSay("역전! " + TEAM[ld]); dShake(); dPop("lead", "역전! " + TEAM[ld], "+" + dWon(Math.abs(a - b)) + " 앞서요", ld); }, 900); }
    if (ld) dLocal.leader = ld;
  }
  // 진행 링·시계·마감 경고 (render 사이에도 계속)
  function dTick() {
    if (!state || state.phase !== "delivery" || !state.delivery) { document.body.classList.remove("d-warn", "d-crit", "d-fever"); var fb0 = document.getElementById("dfever"); if (fb0) fb0.parentNode.removeChild(fb0); return; }
    var n = nowMs();
    Array.prototype.forEach.call(document.querySelectorAll("[data-dstart]"), function (el) {
      var p = Math.max(0, Math.min(1, (n - parseInt(el.getAttribute("data-dstart"), 10)) / parseInt(el.getAttribute("data-dneed"), 10)));
      el.style.setProperty("--p", p.toFixed(3));
      el.classList.toggle("near", p > 0.7);
    });
    // 주택 초인종: 문 열린 순간 초록 + 딩동 (같은 문/같은 열림은 한 번만)
    Array.prototype.forEach.call(document.querySelectorAll("[data-dopen]"), function (el) {
      var at = parseInt(el.getAttribute("data-dopen"), 10), open = n >= at;
      el.classList.toggle("bell-open", open);
      if (open && el.hasAttribute("data-unit") && !dLocal.beeped["bell" + at]) { dLocal.beeped["bell" + at] = 1; DSND.open(); }
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-wend]"), function (el) {
      var p = Math.max(0, Math.min(1, (parseInt(el.getAttribute("data-wend"), 10) - n) / parseInt(el.getAttribute("data-wms"), 10)));
      el.style.setProperty("--p", p.toFixed(3));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-wsec]"), function (el) { el.textContent = Math.max(0, Math.ceil((parseInt(el.getAttribute("data-wsec"), 10) - n) / 1000)); });
    Array.prototype.forEach.call(document.querySelectorAll(".d-elev[data-moving]"), function (el) { el.classList.toggle("moving", parseInt(el.getAttribute("data-moving"), 10) > n); });
    Array.prototype.forEach.call(document.querySelectorAll(".d-cnt[data-ck]"), function (el) {
      var k = el.getAttribute("data-ck"), tv = parseInt(el.getAttribute("data-cv"), 10), cur = dLocal.shown[k];
      if (cur == null || cur === tv) return;
      var diff = tv - cur, step = Math.sign(diff) * Math.max(50, Math.round(Math.abs(diff) * 0.12 / 50) * 50);
      cur = Math.abs(step) >= Math.abs(diff) ? tv : cur + step;
      dLocal.shown[k] = cur; el.textContent = dWon(cur); el.classList.toggle("up", cur !== tv);
    });
    var ends = state.delivery.endsAt, left = ends ? ends - n : 0;
    var fms = (state.wallRule && state.wallRule.feverMs) || 0, inFever = fms > 0 && left > 0 && left <= fms;
    document.body.classList.toggle("d-fever", inFever);
    var fb = document.getElementById("dfever");
    if (inFever) {
      if (!fb) { fb = document.createElement("div"); fb.id = "dfever"; document.body.appendChild(fb); }
      fb.innerHTML = '<b>FEVER</b><span>배송 금액 x' + ((state.wallRule && state.wallRule.feverMult) || 2) + '</span>';
      if (!dLocal.beeped.fever) { dLocal.beeped.fever = 1; DSND.fever(); dSay("피버 타임! 점수 두 배!"); dShake(); }
      var hb = Math.floor(left / 500);
      if (!dLocal.beeped["fp" + hb] && (MAIN || RAIL)) { dLocal.beeped["fp" + hb] = 1; DSND.pulse(hb % 2 === 0); }
    } else if (fb) fb.parentNode.removeChild(fb);
    Array.prototype.forEach.call(document.querySelectorAll(".d-clock[data-ends]"), function (el) { el.textContent = fmtClock(Math.max(0, left)); });
    document.body.classList.toggle("d-warn", left <= 10000 && left > 5000);
    document.body.classList.toggle("d-crit", left <= 5000 && left > 0);
    var sec = Math.ceil(left / 1000);
    if (sec <= 5 && sec > 0 && !dLocal.beeped[sec]) { dLocal.beeped[sec] = 1; DSND.beep(); }
    if (sec === 10 && !dLocal.beeped[10]) { dLocal.beeped[10] = 1; DSND.beep(); dPop("warn", "배송 마감 10초 전!", "", null); }
  }
  (function dLoop() { dTick(); requestAnimationFrame(dLoop); })();

  // ---- 입력 ----
  function dTeamOf(e) { if (e.ctrlKey && !e.shiftKey) return "1"; if (e.shiftKey && !e.ctrlKey) return "2"; if (e.ctrlKey && e.shiftKey) return "both"; return null; }
  function dPress(unit, team) { if (MAIN) send({ type: "wall-press", unit: unit, team: team }); }
  function dRelease(unit, team) { if (MAIN) send({ type: "wall-release", unit: unit, team: team }); }
  function warSend(seat, what, slot) {
    if (what === "up" || what === "down") send({ type: "wall-elev", seat: seat, dir: what });
    else if (slot) send({ type: "wall-slot", seat: seat, slot: slot });
  }
  document.addEventListener("pointerdown", function (e) {
    var b = e.target.closest && e.target.closest("[data-war]");
    if (!b || MAIN || RAIL || !dWar() || b.disabled) return;
    e.preventDefault();
    b.classList.remove("hit"); void b.offsetWidth; b.classList.add("hit");
    warSend(mySeat(), b.getAttribute("data-war"), parseInt(b.getAttribute("data-slot") || "0", 10));
  });
  function dKeyDown(e) {
    if (!state || state.phase !== "delivery") return false;
    if (dWar() && !MAIN && !RAIL && mySeat()) {
      // 플레이어 기기 키보드 (시험용 / 아케이드 버튼 인코더): ↑ W = 위, ↓ S = 아래, 숫자 1~8 = 지금 층 N0n호
      var c = e.code, dir = (c === "ArrowUp" || c === "KeyW") ? "up" : (c === "ArrowDown" || c === "KeyS") ? "down" : null;
      var sl = /^(Digit|Numpad)([1-8])$/.exec(c);
      if (!dir && !sl) return false;
      e.preventDefault();
      if (!e.repeat) warSend(mySeat(), dir || "slot", sl ? parseInt(sl[2], 10) : 0);
      return true;
    }
    var team = dTeamOf(e);
    if (!MAIN) return false; // 배송 입력은 메인 컴퓨터에서만
    if (dWar()) {
      var wk = warKey(e.code, e.shiftKey);
      if (!wk) return false;
      e.preventDefault();
      if (wk.dir) { if (!e.repeat) send({ type: "wall-elev", team: wk.team, dir: wk.dir }); return true; } // 연타만 (누르고 있기 X)
      if (!e.repeat) send({ type: "wall-slot", team: wk.team, slot: wk.slot });
      return true;
    }
    if (e.code === "ArrowUp" || e.code === "ArrowDown") {
      e.preventDefault();
      if (e.repeat) return true;
      send({ type: "wall-elev", team: (team === "1" || team === "2") ? team : null, dir: e.code === "ArrowUp" ? "up" : "down" }); // 2026-10-21: 팀 키 없이도
      return true;
    }
    var u = unitByKey[e.code];
    if (dPair()) {
      // 버튼 한 쌍: 어느 키냐로 팀이 정해진다 (빨간 버튼 키 = 1, 파란 버튼 키 = 2). 키보드 시험용으로 Shift를 누르면 파랑.
      var keyTeam = u ? "1" : null;
      if (!u && unitByKeyB[e.code]) { u = unitByKeyB[e.code]; keyTeam = "2"; }
      if (!u) return false;
      e.preventDefault();
      if (e.repeat || dLocal.keyHold[e.code]) return true;
      team = e.shiftKey ? "2" : keyTeam;
      dLocal.keyHold[e.code] = { unit: u.id, team: team };
      dPress(u.id, team);
      return true;
    }
    if (!u) return false;
    e.preventDefault();
    if (e.repeat || dLocal.keyHold[e.code]) return true;
    if (team === "both") { DSND.err(); dPop("warn", "Ctrl과 Shift를 같이 눌렀어요", "한 팀 키만 누른 채로 호실을 누르세요", null); return true; }
    dLocal.keyHold[e.code] = { unit: u.id, team: team };
    dPress(u.id, team);
    return true;
  }
  function dKeyUp(e) {
    var h = dLocal.keyHold[e.code];
    if (!h) return;
    delete dLocal.keyHold[e.code];
    if (h.team) dRelease(h.unit, h.team);
  }
  document.addEventListener("keyup", dKeyUp);
  window.addEventListener("blur", function () { Object.keys(dLocal.keyHold).forEach(function (c) { dKeyUp({ code: c }); }); if (dLocal.ptrHold) { dRelease(dLocal.ptrHold.unit, dLocal.ptrHold.team); dLocal.ptrHold = null; } });
  document.addEventListener("pointerdown", function (e) {
    var b = e.target.closest && e.target.closest("[data-unit]");
    if (!b || !MAIN || !state || state.phase !== "delivery") return;
    e.preventDefault();
    var team = dTeamOf(e);
    if (team !== "1" && team !== "2") return;
    dLocal.ptrHold = { unit: b.getAttribute("data-unit"), team: team };
    dPress(dLocal.ptrHold.unit, team);
  });
  function dPtrUp() { if (!dLocal.ptrHold) return; var h = dLocal.ptrHold; dLocal.ptrHold = null; if (h.team) dRelease(h.unit, h.team); }
  document.addEventListener("pointerup", dPtrUp);
  document.addEventListener("pointercancel", dPtrUp);
  document.addEventListener("contextmenu", function (e) { if (e.target.closest && e.target.closest("[data-unit]")) e.preventDefault(); });

  // ---------- 2026-10-16 조각마다 반응형 미니게임 (stage "pieces") ----------
  // 규칙을 읽을 필요 없는 3~5초짜리. 키: Space / ← ↑ → ↓ (레일 앞 물리 버튼), 터치도 됨.
  // 하나 끝내면 "조각 획득" -> 서버 race-step piece-done -> 다음 게임. 다 모으면 서버가 stage를 ubongo로(완성 -> 투입).
  // 2026-10-16 (사용자 피드백 "너무 쉽다"): 각 게임에 실패할 수 있는 요소를 넣었다. 후반은 한 단계 더 어렵게(mxHard).
  // 2026-10-16 (사용자 요청): 네 게임 모두 택배 일로 바꿈 -- 규칙(난이도)은 그대로, 모양과 말만.
  //   react = 바코드 스캔(정상 택배만 스캔, 반품 박스는 스캔 금지) / pick = 송장 주소 확인 / mash = 테이프 붙이기 / arrows = 배달 길 외우기
  var MX_NAME = { react: "바코드 스캔", pick: "송장 주소 확인", mash: "테이프 붙이기", arrows: "배달 길 외우기" };
  function mxBoxSvg(extra) {
    return '<svg viewBox="0 0 120 90" class="mx-box-svg" aria-hidden="true"><path d="M10 28 L60 10 L110 28 L110 78 L60 88 L10 78 Z" fill="#c99a5b" stroke="#7a5428" stroke-width="3"/>'
      + '<path d="M10 28 L60 44 L110 28 M60 44 L60 88" fill="none" stroke="#7a5428" stroke-width="3"/>' + (extra || '') + '</svg>';
  }
  function mxHard() { return !!(state && state.half === 2); }
  var MX_ARROW = { ArrowLeft: "←", ArrowUp: "↑", ArrowRight: "→", ArrowDown: "↓" };
  var mx = null;
  function mxLayer() {
    var el = document.getElementById("mx-layer");
    if (!el) { el = document.createElement("div"); el.id = "mx-layer"; el.className = "mx-layer"; document.body.appendChild(el); }
    return el;
  }
  function mxClose() { if (mx && mx.clock) clearInterval(mx.clock); if (mx && mx.timer) { clearTimeout(mx.timer); clearInterval(mx.timer); } mx = null; var el = document.getElementById("mx-layer"); if (el) { el.innerHTML = ""; el.classList.remove("on"); } }
  function microSync() {
    var r = state && state.phase === "secure" ? state.race : null, seat = mySeat();
    // 2026-10-21 상대 진행 줄은 카드를 다시 그리지 않고 그 자리만 바꾼다 (깜빡임 없이)
    var vsEl = document.getElementById("mx-vs");
    if (vsEl && r) vsEl.innerHTML = raceVsHtml(state, r, seat);
    raceVsBump(r && r.status !== "reveal" ? r : null, seat);
    var want = r && seat && r.pieceGames && r.stage[seat] === "pieces" && r.status !== "reveal";
    if (!want) {
      // 마지막 조각을 받은 직후엔 "조각 획득" 화면을 잠깐 더 보여 준다
      if (mx && mx.won && mx.holdUntil > Date.now() && r && seat && r.stage[seat] === "ubongo") { setTimeout(microSync, mx.holdUntil - Date.now()); return; }
      if (mx) mxClose();
      return;
    }
    var idx = r.got[seat];
    if (mx && mx.round === r.round && mx.idx === idx) return; // 진행 중 (또는 서버 응답 대기)
    if (mx && mx.won && mx.holdUntil > Date.now()) { setTimeout(microSync, mx.holdUntil - Date.now()); return; }
    mxStart(r, idx);
  }
  // 2026-10-16 (사용자 피드백 2차 "아직 쉽다"): 게임마다 제한 시간(MX_LIMIT, 넘기면 같은 게임을 새 문제로 다시) + 각 게임 난이도 한 단계 더.
  // 2026-10-16 (사용자: "시간 압박이 너무 강하다"): 제한 시간을 크게 늘림 (예전 7/5/5.5/5초)
  // 2026-10-16 (사용자 피드백 "너무 어렵다"): 한 단계 쉽게 -- 성공 횟수↓, 초록불·기억 시간↑, 연타 목표↓, 감쇠 느리게, 제한 시간↑
  var MX_LIMIT = { react: [14000, 14000], pick: [11000, 10000], mash: [0, 0], arrows: [11000, 10000] };
  function mxStart(r, idx) {
    if (mx) { if (mx.timer) { clearTimeout(mx.timer); clearInterval(mx.timer); } if (mx.clock) clearInterval(mx.clock); }
    var kind = r.pieceGames[idx] || "react";
    var H = mxHard() ? 1 : 0;
    var same = mx && mx.round === r.round && mx.idx === idx;
    // 2026-10-21 기록용: 이 조각 게임을 처음 시작한 시각 / 실수 / 시간 초과 (시간 초과로 다시 시작해도 이어서 센다)
    mx = { round: r.round, idx: idx, need: r.need, kind: kind, won: false, lockUntil: 0, tries: (same ? (mx.tries || 0) + 1 : 0),
      t0Piece: same ? mx.t0Piece : Date.now(), fails: same ? (mx.fails || 0) : 0, timeouts: same ? (mx.timeouts || 0) + 1 : 0 };
    if (kind === "react") { mx.hits = 0; mx.scanCount = 0; mx.scanSeg = -1; mx.scanNeed = [6, 7][H]; mx.needHits = [1, 2][H]; mx.sched = mxReactSched((r.seed || 1) + idx * 7919, H); mx.t0 = r.startedAt || nowMs(); mx.lastHitSeg = -1; mx.seenSeg = -1; mxArmReact(); }
    else if (kind === "pick") { mx.streak = 0; mx.needStreak = [2, 3][H]; mxNewPick(); }
    else if (kind === "mash") { mx.count = 0; mx.goal = [14, 16][H]; mx.last = null; mxMashDecay(); } // 2026-10-22: ← → 번갈아 (테이프를 좌우로 당겨 붙이기)
    else if (kind === "arrows") { mxNewArrows(); }
    var limit = MX_LIMIT[kind][H]; // 0 = 제한 시간 없음 (테이프 붙이기 -- 2026-10-16 사용자 요청)
    mx.startAt = Date.now(); mx.deadline = Math.max(mx.startAt, mx.showUntil || 0) + limit; mx.limit = limit;
    var my = mx;
    if (limit) mx.clock = setInterval(function () {
      if (mx !== my) { clearInterval(my.clock); return; }
      if (mx.won) { clearInterval(mx.clock); return; }
      var bar = document.getElementById("mx-time");
      if (bar) bar.style.width = Math.max(0, Math.min(1, (mx.deadline - Date.now()) / mx.limit) * 100) + "%";
      if (Date.now() > mx.deadline) { // 시간 초과 -> 같은 조각 게임을 새 문제로 다시
        clearInterval(mx.clock);
        mx.flash = "배송 지연! 다시"; mx.lockUntil = Date.now() + 900; mxRender();
        try { DSND.err(); } catch (e) {}
        setTimeout(function () { if (mx === my && state && state.race) mxStart(state.race, my.idx); }, 900);
      }
    }, 100);
    mxLayer().classList.add("on");
    mxRender();
  }
  // 방향 따라 누르기: 1.3초(후반 1초) 보여 주고 가린다 -- 외워서 누르기. 틀리면 새 순서로 다시 보여 줌.
  var MX_MEMO_MS = 5000;
  function mxNewArrows() {
    var a = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"], H = mxHard() ? 1 : 0;
    mx.seq = []; for (var k = 0; k < [3, 4][H]; k++) mx.seq.push(a[Math.floor(Math.random() * 4)]); // 2026-10-16 (사용자): 전반 3개 / 후반 4개
    // 2026-10-21 (사용자): 길은 팝업으로 5초 보여 주고 사라짐. 제한 시간은 팝업이 닫힌 뒤부터.
    mx.pos = 0; mx.showUntil = Date.now() + MX_MEMO_MS;
    var my = mx, seqNo = (mx.seqNo = (mx.seqNo || 0) + 1);
    // 2026-10-21 (사용자 "깜빡거림"): 보는 동안은 다시 그리지 않고 숫자만 바꾼다. 끝날 때 한 번만 다시 그림.
    for (var t = 1; t < MX_MEMO_MS / 1000; t++) (function (t) { setTimeout(function () { if (mx !== my || my.seqNo !== seqNo) return; var c = document.querySelector("#mx-layer .mx-memo-c"); if (c) c.textContent = String(MX_MEMO_MS / 1000 - t); }, t * 1000); })(t);
    setTimeout(function () { if (mx === my && my.seqNo === seqNo) mxRender(); }, MX_MEMO_MS + 20);
  }
  // 초록불에만 누르기: 기다리다 빨강(누르면 실패) 또는 초록이 뜬다. 초록은 짧게만 켜진다(놓치면 다시). 성공 needHits번.
  // 2026-10-16 (사용자 요청): 두 좌석이 같은 시각에 같은 불 -- 서버가 준 씨앗(race.seed)과 시작 시각(race.startedAt, 서버 시계)으로
  //   같은 시간표(대기 / 반품 빨간불 / 정상 초록불)를 만들고, 서버 시계(nowMs) 기준으로 지금 어느 칸인지 본다.
  function mxRng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function mxReactSched(seed, H) {
    var rng = mxRng(seed), segs = [], t = 0;
    while (t < 240000) {
      var w = 500 + Math.floor(rng() * 800);
      segs.push({ s: t, e: t + w, ph: "wait" }); t += w;
      if (rng() < 0.25) { segs.push({ s: t, e: t + 650, ph: "red" }); t += 650; }
      else { var g = H ? 1500 : 1800; segs.push({ s: t, e: t + g, ph: "go" }); t += g; } // 2026-10-21: 초록불 동안 연타 -- 창을 넉넉히
    }
    return segs;
  }
  function mxReactSeg() {
    var el = nowMs() - mx.t0, sc = mx.sched;
    if (el < 0) return { i: -1, ph: "wait" };
    var lo = 0, hi = sc.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (sc[mid].s <= el) lo = mid; else hi = mid - 1; }
    return { i: lo, ph: sc[lo].ph };
  }
  function mxArmReact() {
    if (mx.timer) clearInterval(mx.timer);
    var my = mx;
    var tick = function () {
      if (mx !== my || mx.won) { clearInterval(my.timer); return; }
      var seg = mxReactSeg();
      if (seg.i !== mx.seenSeg) {
        // 방금 끝난 칸이 초록불이었는데 못 눌렀으면 "지나갔어요"
        var prev = mx.seenSeg >= 0 ? mx.sched[mx.seenSeg] : null;
        if (prev && prev.ph === "go" && mx.lastHitSeg !== mx.seenSeg && mx.lockUntil < Date.now()) {
          mx.flash = "택배가 지나갔어요!";
          setTimeout(function () { if (mx === my && mx.flash === "택배가 지나갔어요!") { mx.flash = null; mxRender(); } }, 600);
        }
        mx.seenSeg = seg.i; mx.phase = seg.ph; mxRender();
      }
    };
    mx.phase = "wait"; mx.seenSeg = -2; tick();
    mx.timer = setInterval(tick, 25);
  }
  // 게이지 채우기: 가만히 있으면 줄어든다
  function mxMashDecay() {
    var my = mx;
    mx.timer = setInterval(function () {
      if (mx !== my || mx.won) { clearInterval(my.timer); return; }
      if (mx.count > 0) { mx.count = Math.max(0, mx.count - 1); mxRender(); }
    }, mxHard() ? 480 : 550); // 2026-10-16 (사용자 "테이프 너무 어려움"): 줄어드는 속도 더 느리게
  }
  // 송장 주소 맞추기: 위 송장의 호수와 같은 것을 고른다. 보기는 숫자를 뒤집거나 하나 바꾼 비슷한 호수들. needStreak번 연속.
  // 2026-10-21 (사용자 "1:1 매칭이라 머리를 안 씀"): 송장에 기준 집 + 배송 메모("윗집", "왼쪽 옆집" ...)가 적혀 있어서
  //   실제 문은 머리로 한 번(후반엔 두 번) 옮겨 찾아야 한다. 적힌 호수 그대로는 함정 보기. 가끔은 메모 없이 "그대로"(방심 방지).
  //   호수 = 층 + 0 + 번째 집 (예: 607호 = 6층 7번째). 윗집 = 층+1, 왼쪽 옆집 = 번째-1.
  var MX_REL = [
    { k: "up", t: "윗집", df: 1, du: 0 }, { k: "down", t: "아랫집", df: -1, du: 0 },
    { k: "left", t: "왼쪽 옆집", df: 0, du: -1 }, { k: "right", t: "오른쪽 옆집", df: 0, du: 1 },
  ];
  var MX_GUARD_RATE = 0.15;
  var MX_GUARD_FAKES = ["경감실", "겅비실", "경비살", "경리실", "경미실", "갱비실", "경빈실"];
  function mxNewPick() {
    var H = mxHard() ? 1 : 0;
    var r = function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); };
    var lab = function (a, b) { return a + "0" + b + "호"; };
    var f = r(3, 7), u = r(3, 7); // 두 번 옮겨도 1~9 안
    // 2026-10-22 (사용자): 가끔 "경비실에 맡겨 주세요" -- 팻말은 비슷한 글자들(경감실, 겅비실 ...) 중에서 경비실 찾기
    if (Math.random() < MX_GUARD_RATE) {
      var fakes = MX_GUARD_FAKES.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 3);
      mx.target = "경비실"; mx.base = lab(f, u); mx.memo = ["경비실"]; mx.guard = true;
      mx.opts = ["경비실"].concat(fakes).sort(function () { return Math.random() - 0.5; });
      return;
    }
    mx.guard = false;
    var steps = [];
    var roll = Math.random();
    if (roll < (H ? 0.12 : 0.2)) steps = [];                       // 메모 없음 -- 적힌 그대로
    else if (!H || roll < 0.45) steps = [MX_REL[r(0, 3)]];         // 한 번
    else { var a = MX_REL[r(0, 1)], b = MX_REL[r(2, 3)]; steps = Math.random() < 0.5 ? [a, b] : [b, a]; } // 두 번 (위아래 + 옆)
    var tf = f, tu = u;
    steps.forEach(function (st) { tf += st.df; tu += st.du; });
    var target = lab(tf, tu), base = lab(f, u);
    // 함정 보기: 적힌 집 그대로 / 반대로 옮긴 집 / 한 단계만 옮긴 집 / 층·번째 뒤바꾼 집
    var pool = [base];
    steps.forEach(function (st) { pool.push(lab(f - st.df * (steps.length === 1 ? 1 : 1), u - st.du)); });
    if (steps.length === 2) { pool.push(lab(f + steps[0].df, u + steps[0].du), lab(f + steps[1].df, u + steps[1].du)); }
    if (steps.length === 1) { var s0 = steps[0]; pool.push(lab(f + s0.du, u + s0.df)); } // 축을 헷갈림 (윗집인데 옆집으로)
    pool.push(lab(tu, tf), lab(tf + 1, tu), lab(tf, tu - 1), lab(tf - 1, tu), lab(tf, tu + 1), lab(tf + 1, tu + 1)); // 모자라지 않게 여유분
    pool = pool.filter(function (x, i) { return x !== target && pool.indexOf(x) === i; });
    var lead = pool.slice(0, steps.length === 0 ? 1 : 2), rest = pool.slice(lead.length).sort(function () { return Math.random() - 0.5; });
    var picks = lead.concat(rest).slice(0, 3);
    mx.target = target; mx.base = base; mx.memo = steps.map(function (st) { return st.t; });
    mx.opts = [target].concat(picks).sort(function () { return Math.random() - 0.5; });
  }
  function mxFail(msg) {
    mx.fails = (mx.fails || 0) + 1;
    mx.lockUntil = Date.now() + 700; mx.flash = msg;
    // 2026-10-16 (사용자): 틀리면 제한 시간도 처음부터 다시 (잠깐 멈춘 0.7초 뒤부터)
    if (mx.limit) mx.deadline = Math.max(Date.now() + 700, mx.showUntil || 0) + mx.limit;
    var my = mx;
    setTimeout(function () { if (mx === my) { mx.flash = null; mxRender(); } }, 700);
    mxRender();
  }
  function mxWin() {
    if (!mx || mx.won) return;
    mx.won = true; mx.holdUntil = Date.now() + 1100;
    if (mx.timer) { clearTimeout(mx.timer); clearInterval(mx.timer); }
    if (mx.clock) clearInterval(mx.clock);
    try { DSND.done(); } catch (e) {}
    mxRender();
    send({ type: "race-step", seat: mySeat(), step: "piece-done", round: mx.round, meta: { kind: mx.kind, ms: Date.now() - (mx.t0Piece || Date.now()), fails: mx.fails || 0, timeouts: mx.timeouts || 0 } });
  }
  // 입력 하나 (key = "Space" | "ArrowLeft" ... | {opt: i} 터치)
  function mxInput(key) {
    if (!mx || mx.won) return;
    if (mx.lockUntil > Date.now()) return;
    if (mx.kind === "react") {
      if (key !== "Space" && key !== "tap") return;
      var sg = mxReactSeg();
      // 2026-10-21 (사용자): 초록불 동안 Space를 scanNeed번 연타해야 스캔 하나. 다 찍은 뒤 남은 연타, 초록불 직후 0.35초 안의 연타는 봐준다.
      if (sg.ph === "go") {
        if (sg.i === mx.lastHitSeg) return;
        if (mx.scanSeg !== sg.i) { mx.scanSeg = sg.i; mx.scanCount = 0; }
        mx.scanCount++;
        try { DSND.step(mx.scanCount); } catch (e) {}
        if (mx.scanCount >= mx.scanNeed) { mx.lastHitSeg = sg.i; mx.hits++; if (mx.hits >= mx.needHits) mxWin(); else { mx.phase = "scanned"; mxRender(); } }
        else mxRender();
        return;
      }
      var prevSeg = sg.i > 0 ? mx.sched[sg.i - 1] : null;
      if (prevSeg && prevSeg.ph === "go" && (nowMs() - mx.t0) - prevSeg.e < 350) return;
      { mx.hits = 0; mx.scanCount = 0; mxFail(sg.ph === "red" ? "반품 박스를 스캔했어요! 처음부터" : "아직 택배가 안 왔어요! 처음부터"); }
    } else if (mx.kind === "pick") {
      var i = key === "ArrowLeft" ? 0 : key === "ArrowUp" ? 1 : key === "ArrowDown" ? 2 : key === "ArrowRight" ? 3 : (typeof key === "object" ? key.opt : -1);
      if (i < 0) return;
      if (mx.opts[i] === mx.target) { mx.streak++; if (mx.streak >= mx.needStreak) mxWin(); else { mxNewPick(); mxRender(); } }
      else { mx.streak = 0; mxFail("다른 집 주소예요 · 처음부터"); mxNewPick(); }
    } else if (mx.kind === "mash") {
      // 2026-10-22 (사용자 "스캔 연타와 비슷"): Space 연타 → ← → 번갈아 누르기. 같은 쪽을 두 번 누르면 테이프가 꼬여 한 칸 뒤로.
      var tk = typeof key === "object" ? key.dir : key;
      if (tk !== "ArrowLeft" && tk !== "ArrowRight") return;
      if (mx.last === tk) { mx.count = Math.max(0, mx.count - 1); mx.tangle = Date.now(); try { DSND.err(); } catch (e) {} mxRender(); return; }
      mx.last = tk; mx.count++;
      try { DSND.step(mx.count % 8); } catch (e) {}
      if (mx.count >= mx.goal) mxWin(); else mxRender();
    } else if (mx.kind === "arrows") {
      var k = typeof key === "object" ? key.dir : key;
      if (!MX_ARROW[k]) return;
      if (Date.now() < mx.showUntil) return; // 외우는 중엔 입력 안 받음
      if (mx.seq[mx.pos] === k) { mx.pos++; if (mx.pos >= mx.seq.length) mxWin(); else mxRender(); }
      else { mxNewArrows(); mxFail("길을 잘못 들었어요! 새 길"); }
    }
  }
  function mxDots(n, of) { var h = ''; for (var i = 0; i < of; i++) h += '<i class="' + (i < n ? 'on' : '') + '"></i>'; return h; }
  function mxRender() {
    var el = mxLayer();
    if (!mx) { el.innerHTML = ""; return; }
    var head = '<div class="mx-head"><span class="mx-piece">조각 ' + (mx.idx + 1) + ' / ' + mx.need + '</span><span class="mx-name">' + esc(MX_NAME[mx.kind] || "") + '</span></div>';
    var body = '';
    if (mx.won) {
      body = '<div class="mx-won"><b>조각 획득!</b><span>내 자리 칸에서 조각 하나를 가져가 판에 놓으세요</span>'
        + (mx.idx + 1 >= mx.need ? '<span class="mx-next">다 모았어요! 완성하면 <b>Space</b> 투입</span>' : '<span class="mx-next">곧 다음 조각 게임</span>') + '</div>';
    } else if (mx.kind === "react") {
      var inner = mx.phase === "scanned" ? mxBoxSvg() + '<b>삑! 스캔됨</b>' : mx.phase === "go" ? mxBoxSvg('<g transform="translate(30 52)"><rect width="60" height="22" fill="#fff"/>' + [3, 7, 9, 14, 17, 22, 25, 30, 34, 37, 42, 46, 49, 54].map(function (x, i) { return '<rect x="' + x + '" y="3" width="' + (i % 3 ? 2 : 3) + '" height="16" fill="#111"/>'; }).join('') + '</g>') + '<b>Space 연타! <small>' + (mx.scanSeg === mxReactSeg().i ? mx.scanCount : 0) + ' / ' + mx.scanNeed + '</small></b><i class="mx-scanbar"><i style="width:' + Math.round((mx.scanSeg === mxReactSeg().i ? mx.scanCount : 0) / mx.scanNeed * 100) + '%"></i></i>'
        : mx.phase === "red" ? mxBoxSvg('<g transform="translate(34 50) rotate(-8)"><rect width="54" height="24" rx="3" fill="none" stroke="#C62828" stroke-width="4"/><text x="27" y="18" text-anchor="middle" font-size="15" font-weight="900" fill="#C62828">반품</text></g>') + '<b>스캔 금지!</b>'
        : '<span class="mx-belt-empty">택배가 오는 중…</span>';
      body = '<button class="mx-react mx-belt ' + mx.phase + '" data-mx="tap">' + inner + '</button>'
        + '<div class="mx-count">' + mxDots(mx.hits, mx.needHits) + '<span>스캔 ' + mx.hits + '/' + mx.needHits + '</span></div>';
    } else if (mx.kind === "pick") {
      var memo = mx.memo && mx.memo.length ? mx.memo.join('의 ') : '';
      body = '<div class="mx-target mx-addr mx-waybill"><small>받는 분 주소</small>' + esc(mx.base || mx.target)
        // 2026-10-22 (사용자): 메모가 없으면(그대로) 메모 줄 자체를 안 보여 준다
        + (memo ? '<span class="mx-memo-note">배송 메모 · <b>' + esc(memo) + '에 맡겨 주세요</b></span>' : '') + '<i class="mx-barcode"></i></div>'
        + '<div class="mx-q">' + (mx.guard ? '경비실 팻말을 찾으세요!' : memo ? '메모대로 가면 어느 집 문 앞?' + (mxHard() ? '' : ' <small>(윗집 = 한 층 위 · 오른쪽 옆집 = 끝자리 +1)</small>') : '이 택배는 어느 집 문 앞으로?') + '</div><div class="mx-opts">' + mx.opts.map(function (o, i) {
        // 2026-10-21 (사용자): 보기는 집 문 앞 호수 팻말 모양. 긴 호수(5008호 등)는 글자를 줄여 한 줄로.
        return '<button class="mx-opt mx-addr-opt" data-mx-opt="' + i + '"><span class="mx-plate"><b class="' + (o.length > 4 ? 'long' : '') + '">' + esc(o) + '</b></span><small>' + ["←", "↑", "↓", "→"][i] + '</small></button>';
      }).join('') + '</div><div class="mx-count">' + mxDots(mx.streak, mx.needStreak) + '</div>';
    } else if (mx.kind === "mash") {
      var pct = Math.round(mx.count / mx.goal * 100);
      var want = mx.last === "ArrowLeft" ? "ArrowRight" : mx.last === "ArrowRight" ? "ArrowLeft" : null, tangled = mx.tangle && Date.now() - mx.tangle < 400;
      body = '<div class="mx-mash mx-tape' + (tangled ? ' tangled' : '') + '">' + mxBoxSvg('<rect x="10" y="' + 38 + '" width="' + Math.round(pct) + '" height="10" fill="#d8c27a" stroke="#a88c3a" stroke-width="1.5" transform="skewY(-6)"/>')
        + '<span>← → 번갈아 눌러 테이프 붙이기 <small>' + (tangled ? '같은 쪽 두 번! 테이프가 꼬였어요' : '멈추면 떨어져요') + ' · ' + pct + '%</small></span></div>'
        + '<div class="mx-pad mx-tape-pad">' + ["ArrowLeft", "ArrowRight"].map(function (k) { return '<button data-mx-dir="' + k + '" class="' + (want === k ? 'now' : '') + '">' + MX_ARROW[k] + '</button>'; }).join('') + '</div>';
    } else if (mx.kind === "arrows") {
      var hide = Date.now() >= mx.showUntil;
      body = '<div class="mx-route"><span class="mx-stop">물류센터</span><div class="mx-seq">' + mx.seq.map(function (k, i) { return '<span class="' + (i < mx.pos ? 'ok' : (i === mx.pos ? 'now' : '')) + '">' + (i < mx.pos || !hide ? MX_ARROW[k] : '?') + '</span>'; }).join('') + '</div><span class="mx-stop home">고객 집</span></div>'
        + '<div class="mx-hint">' + (hide ? '외운 길 순서대로 운전!' : '골목 길을 외우세요…') + '</div>'
        + '<div class="mx-pad">' + ["ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"].map(function (k) { return '<button data-mx-dir="' + k + '">' + MX_ARROW[k] + '</button>'; }).join('') + '</div>';
      var memoAnim = mx.memoAnimSeq !== mx.seqNo; mx.memoAnimSeq = mx.seqNo; // 처음 뜰 때만 등장 애니메이션
      if (!hide) body += '<div class="mx-memo' + (memoAnim ? ' anim' : '') + '"><div class="mx-memo-card"><div class="mx-memo-t">배달 길을 외우세요!</div><div class="mx-memo-seq">'
        + mx.seq.map(function (k) { return '<span>' + MX_ARROW[k] + '</span>'; }).join('<i>›</i>')
        + '</div><div class="mx-memo-c">' + Math.max(1, Math.ceil((mx.showUntil - Date.now()) / 1000)) + '</div></div></div>';
    }
    var tbar = (mx.won || !mx.limit) ? '' : '<div class="mx-timebar"><i id="mx-time" style="width:' + Math.max(0, Math.min(1, (mx.deadline - Date.now()) / mx.limit) * 100) + '%"></i></div>';
    var vs = '<div id="mx-vs">' + (state && state.race ? raceVsHtml(state, state.race, mySeat()) : '') + '</div>';
    el.innerHTML = vs + '<div class="mx-card' + (mx.flash ? ' fail' : '') + (mx.won ? ' won' : '') + '">' + head + tbar + body + (mx.flash ? '<div class="mx-flash">' + esc(mx.flash) + '</div>' : '') + '</div>';
  }
  document.addEventListener("keydown", function (e) {
    if (!mx || MAIN || RAIL) return;
    var k = e.code === "Space" ? "Space" : (MX_ARROW[e.code] ? e.code : null);
    if (!k) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    mxInput(k);
  }, true);
  document.addEventListener("pointerdown", function (e) {
    if (!mx) return;
    var t = e.target.closest && e.target.closest("[data-mx],[data-mx-opt],[data-mx-dir]");
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute("data-mx-opt")) mxInput({ opt: parseInt(t.getAttribute("data-mx-opt"), 10) });
    else if (t.hasAttribute("data-mx-dir")) mxInput({ dir: t.getAttribute("data-mx-dir") });
    else mxInput("tap");
  });
  window.__mxFinish = function () { if (!/[?&]mgtest=1(&|$)/.test(location.search) || !mx || mx.won) return false; mxWin(); return true; };

  function renderBody() {
    if (RAIL && !ROOM) return renderRailJoin();
    if (!ROOM) return '<main class="stage"><div class="center-screen">' + cartWrap('<div class="lobby-box card"><h2>잘못된 링크예요</h2><p>방 코드가 없어요. 처음 받은 링크로 다시 들어와 주세요.</p></div>', 'cart--lobby') + '</div></main>';
    if (MAIN) return renderMain();
    if (RAIL) return renderRail();
    if (!state) return renderTopbarShell() + renderLoading();
    var seat = mySeat();
    var body = renderTopbar(state, seat);
    if (!seat) { body += renderSeatPicker(); return body; }
    if (state.phase === "lobby") {
      // 방어적 체크 (2026-08-28 버그 수정): 이 좌석이 서버에 등록돼 있어도(seat truthy) courierPick이
      // 비어 있으면(재접속 유예 로직으로도 못 막은 예외적 타이밍, 혹은 방이 스윕돼 새로 만들어진 뒤
      // sessionStorage만 남아있던 경우 등) 절대 "스페이스바 대기" 화면을 보여주지 않는다 -- 택배사를
      // 안 골랐는데 대기 화면만 뜨면 사용자가 다시 고를 방법이 없다("한번씩 대기 시간에 택배사 선택이
      // 안 떠" 버그 리포트). 내 택배사가 실제로 정해져 있을 때만 대기 화면, 아니면 선택 화면.
      body += (state.courierPick && state.courierPick[seat]) ? renderLobby(state, seat) : renderSeatPicker();
    }
    else if (state.phase === "secure") {
      // 우봉고 오버레이를 열어둔 사이 그 칸(또는 그 종류)이 상대에게 다 넘어갔으면 오버레이를 닫는다 (공유 보드).
      if (local.openCellId) {
        var blocked = cellBlockedReason(state, local.openCellId);
        if (blocked) { local.openCellId = null; notifyGameClosed(); setTimeout(function () { showToast(blocked); }, 0); }
      }
      // 레일 화면이 접속해 있으면 버튼은 그쪽에 있다 -- 내 화면은 "기다리는 화면"이고, 게임은 레일에서 눌렀을 때 뜬다.
      if (state.race) body += renderRace(state, seat); // 2026-10-14 레이스 라운드 (레일 화면 접속 여부와 무관)
      else body += (railInfo.count > 0 ? renderRailWaiting(state, seat) : renderBoard(state, seat)) + renderPuzzleOverlay(state);
    }
    else if (state.phase === "tutorial") body += renderTutorial(state, seat);
    else if (state.phase === "elevator") body += renderElevator(state, seat);
    else if (state.phase === "delivery" && state.delivery) body += renderDelivery(state, seat);
    else if (state.phase === "halftime") body += renderHalftime(state, seat);
    else if (state.phase === "end") body += renderEnd(state, seat);
    return body;
  }
  function renderTopbarShell() {
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live · ' + BUILD_TAG + '</span><h1>택배 배송 게임</h1></div>'
      + '<div class="right"><span class="room-chip">방 ' + esc(ROOM) + '</span></div></div>';
  }


  // ---------- 레일 사이트 (2026-10-07, /rail) ----------
  // 두 플레이어가 같이 보는 공용 화면. 확보 단계에서 종류마다 한 줄: 가운데 레일 위에 택배 상자(남은 개수 점), 왼쪽 = 1번 자리 버튼,
  // 오른쪽 = 2번 자리 버튼. 버튼을 누르면 서버(rail-press)가 그 자리 플레이어의 기기에 해당 종류 미니게임을 띄운다. 이 화면은 좌석이 없고
  // 비공개 정보(내가 확보한 호수, 우선 택배 등)는 어디에도 그리지 않는다 -- 남은 개수와 누가 지금 게임 중인지만 보인다.
  function renderRailJoin() {
    return '<main class="stage"><div class="center-screen"><div class="lobby-box card"><h2>레일 화면</h2>'
      + '<p>메인 화면에 뜬 방 코드를 입력하세요.</p>'
      + '<p><input id="rail-code" class="rv-code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="방 코드"> '
      + '<button class="btn ok" data-action="rail-join">입장</button></p></div></div></main>';
  }
  function railSideHead(st, side) {
    var key = st.courierPick && st.courierPick[side];
    var c = key ? courierByKey(key) : null;
    var idx = c ? COURIERS.indexOf(c) : -1;
    var here = !!st.seatOwners[side];
    var busy = railInfo.busy && railInfo.busy[side];
    return '<span class="rv-side' + (c ? ' is-on' : '') + (busy ? ' is-busy' : '') + '" data-side="' + side + '"' + (c ? ' style="--c:' + c.color + '"' : '') + '>'
      + (c ? '<span class="rv-side-icon">' + COURIER_ICONS[idx] + '</span>' : '')
      + '<b>' + esc(c ? c.name : '플레이어 ' + side) + '</b>'
      + '<small>' + (!here ? '입장 대기' : (busy ? '게임 중...' : '버튼을 누르세요')) + '</small></span>';
  }
  function railSideButtons(st, side, t, catIdx, left) {
    var here = !!st.seatOwners[side];
    var busy = !!(railInfo.busy && railInfo.busy[side]);
    var html = '<div class="rail-side mine side-' + side + '" style="--c:' + t.color + '">';
    if (t.fixedFloor) {
      html += '<div class="floor-btns">';
      for (var num = 0; num < t.count; num++) {
        var cell = boardCell(st, t.key + "-" + (num + 1));
        var off = !here || busy || (cell && cell.taken);
        html += '<button class="floor-btn' + (cell && cell.taken ? ' is-gone' : '') + '" data-action="rail-press" data-side="' + side + '" data-cat="' + catIdx + '" data-cell="' + t.key + '-' + (num + 1) + '"'
          + (off ? ' disabled' : '') + '><span>' + esc(FLOORS[num]) + '</span><small>' + fmtWon(Math.round(t.reward * floorMult(num))) + '</small></button>';
      }
      html += '</div>';
    } else {
      var off2 = !here || busy || left === 0;
      html += '<button class="rail-btn' + (busy ? ' is-busy' : '') + '" data-action="rail-press" data-side="' + side + '" data-cat="' + catIdx + '"' + (off2 ? ' disabled' : '') + '>'
        + '<span class="rbt">' + (left === 0 ? '소진' : (busy ? '게임 중...' : esc(MINI_NAME[t.mini] || '택배 쌓기') + ' 시작')) + '</span>'
        + '<span class="rbp">성공 ' + rewardRange(t) + ' · 실패 ' + fmtWon(-t.penalty) + '</span></button>';
    }
    return html + '</div>';
  }
  // 엘리베이터 단계의 상태 문구/마감 (메인 모니터와 레일 화면 공용)
  function elevStateInfo(st) {
    var el = st.elevator, r = { label: "", ends: null, wait: "" };
    if (el.state === "idle") { r.label = "출발 준비 중"; r.wait = "두 플레이어가 준비하면 출발해요"; }
    else if (el.state === "priority") { r.label = (MERGE_PRIORITY_THIEF && st.half === 2) ? "우선 택배 지정 · 택배도둑 배치 시간" : "우선 택배 지정 시간"; r.ends = el.priorityWindowEndsAt; }
    else if (el.state === "thief") { r.label = "택배도둑 배치 시간"; r.ends = el.thiefWindowEndsAt; }
    else if (el.state === "voting") { r.label = "엘리베이터 이동 중!"; r.ends = el.votingEndsAt; }
    else if (el.state === "choosing") { r.label = "같은 층 택배 선택 중"; r.ends = el.pendingChoice && el.pendingChoice.endsAt; }
    else if (el.state === "result") { r.label = elevJolt(el) ? "팽팽! 덜컹! 엘리베이터가 " + (elevJolt(el).dir === "up" ? "튀어 올랐어요" : "떨어졌어요") : "라운드 결과 확인 중"; if (el.resultEndsAt) r.ends = el.resultEndsAt; else r.wait = "다음 라운드 준비 대기"; }
    else { r.label = "배송 종료"; }
    return r;
  }
  // 2026-10-14 (사용자 요청): 레일 화면도 엘리베이터 단계엔 엘리베이터 그림 -- 건물 단면도(움직임) + 엘리베이터 안 그림 + 라운드/상태/남은 시간
  function renderRailElevator(st, head, halfName) {
    var el = st.elevator, esi = elevStateInfo(st);
    return '<div class="rv">' + head("엘리베이터 · " + halfName) + '<div class="rv-elev">'
      + '<div class="rv-elev-bld">' + renderBuilding(el) + '</div>'
      + '<div class="rv-elev-main">' + renderElevArt(el)
      + '<div class="rv-elev-info"><span class="round-pill">라운드 ' + el.round + ' / ' + ELEVATOR_ROUNDS + '</span>'
      + '<span class="rv-elev-floor">현재 층 <b>' + esc(FLOORS[el.floorIdx]) + '</b></span>'
      + '<span class="rv-elev-state">' + esc(esi.label) + '</span>'
      + (esi.ends ? raceCount(esi.ends, '', '초') : (esi.wait ? '<span class="rv-elev-wait">' + esc(esi.wait) + '</span>' : ''))
      + '</div></div></div></div>';
  }
  // 2026-10-14 (사용자 요청): 레이스 중 레일 화면엔 택배 쌓기 문제만. 누군가 첫 게임을 끝내면 문제가 화면 가득,
  //   그 전엔 "곧 문제가 나와요" 대기 화면. 택배·진행 단계·송장은 그리지 않는다 (택배 고르기는 각자 플레이어 화면).
  function railPuzzleOn(r) { return !!r.first || ["1", "2"].some(function (s) { return r.stage[s] === "ubongo" || r.stage[s] === "done" || r.stage[s] === "pieces"; }); }
  // 레일 화면 고르기 카드: 종류·금액·층 + 자리별 버튼(1번 A S D / 2번 J K L)
  function railParcel(st, r, it, i) {
    var owner = rOwner(r, i);
    var left = r.status === "reveal" && !owner;
    var t = TYPES[it.catIdx];
    var html = '<div class="race-parcel is-open rail-pk fee-t' + it.catIdx + (owner ? ' is-owned' : '') + (left ? ' is-gone' : '') + '">'
      + medalTag(it.catIdx)
      + itAddrHtml(it)
      + (WALL.war ? '' : '<span class="rp-ico">' + CAT_ICONS[it.catIdx] + '</span><span class="rp-name">' + esc(t.name) + '</span>') + '<span class="rp-amt">' + fmtWon(t.reward) + '</span>';
    if (owner) html += '<span class="rp-owner seat-' + owner + '">' + esc(seatName(owner, st)) + (r.randomPick && r.randomPick[owner] ? ' (무작위)' : '') + ' 획득</span>';
    else if (left) html += '<span class="rp-owner gone">' + (r.plan ? '사라짐' : '레일로 돌아감') + '</span>';
    else {
      var rule = setRuleOf(st), tags = [];
      ["1", "2"].forEach(function (s) {
        var hk = heldKinds(st.players[s].invoices), n = Object.keys(hk).length;
        if (rule.amount > 0 && !hk[it.catIdx] && n + 1 >= rule.kinds && n < rule.kinds) tags.push('<span class="rp-set">' + esc(seatName(s, st)) + ' 세트 완성</span>');
      });
      html += tags.join('') + '<span class="rail-pk-btns">' + ["1", "2"].map(function (s) {
        var ok = r.status === "picking" && raceCanPick(r, s);
        return '<button class="rail-pk-btn seat-' + s + (ok ? ' on' : '') + '" data-action="rail-pick" data-side="' + s + '" data-idx="' + i + '"' + (ok ? '' : ' disabled') + '>'
          + esc(seatName(s, st)) + ' <b>' + RAIL_PICK_LABEL[s][i] + '</b></button>';
      }).join('') + '</span>';
    }
    return html + '</div>';
  }
  function renderRailRace(st) {
    var r = st.race;
    // 누군가 투입한 뒤(고르기/결과): 위쪽에 택배 3개(층 보고 고르기), 아직 택배 쌓기 중인 사람이 있으면 문제 그림도 옆에 계속
    if (r.status === "picking" || r.status === "reveal") {
      var solving = ["1", "2"].some(function (s) { return r.stage[s] === "ubongo" || r.stage[s] === "sticker"; }) && r.status === "picking";
      var meta0 = cellMeta(r.puzzleId, st.half);
      return '<div class="rv rv-pick' + (solving ? ' with-puzzle' : '') + '">'
        + '<div class="rv-pick-main"><div class="rp-cap">레이스 ' + r.round + (r.plan ? ' · 주소를 보고 택배를 고르세요 · 먼저 끝낸 사람 ' + r.plan.first + '개' : ' · 층을 보고 택배를 고르세요') + '</div>'
        + '<div class="race-rail rv-pick-rail"><span class="race-belt"></span>' + r.pair.map(function (it, i) { return railParcel(st, r, it, i); }).join('') + '</div>'
        + raceMessage(st, r, null)
        + '<div class="race-lanes">' + ["1", "2"].map(function (s) { return raceLane(st, r, s, false); }).join('') + '</div></div>'
        + (solving ? '<div class="race-puzzle rv-pick-puzzle"><div class="rp-cap">택배 쌓기 · 조각 ' + racePieces(st, r) + '개</div>' + (meta0 && meta0.src ? '<img src="' + meta0.src + '" alt="택배 쌓기 문제">' : '') + '</div>' : '')
        + '</div>';
    }
    if (!railPuzzleOn(r)) {
      return '<div class="rv rv-race-wait"><div class="rv-center"><span class="round-pill">레이스 ' + r.round + '</span>'
        + '<h2>' + esc(raceGameName(r)) + ' 중</h2><p>먼저 끝낸 사람이 나오면 여기에 택배 쌓기 문제가 떠요</p></div></div>';
    }
    var meta = cellMeta(r.puzzleId, st.half);
    return '<div class="rv rv-puzzle-only"><div class="race-puzzle">'
      + '<div class="rp-cap">레이스 ' + r.round + ' · 택배 쌓기 · 조각 ' + racePieces(st, r) + '개</div>'
      + (meta && meta.src ? '<img src="' + meta.src + '" alt="택배 쌓기 문제">' : '') + '</div>'
      // 2026-10-22: 레일 화면(관전)에도 두 사람 진행도 -- 조각 수 · 완성 임박 · 완성 시각
      + (r.pieceGames ? '<div class="race-lanes rv-lanes">' + ["1", "2"].map(function (s) { return raceLane(st, r, s, false); }).join('') + '</div>' : '') + '</div>';
  }
  function renderRail() {
    var st = state;
    var head = function (label) {
      return '<header class="rv-head"><div><span class="rv-eyebrow">BeatPhobia · Live · ' + BUILD_TAG + '</span><h1>레일 화면</h1></div>'
        + '<div class="rv-chips">' + (label ? '<span class="rv-chip phase">' + esc(label) + '</span>' : '') + '<span class="rv-chip room">방 ' + esc(ROOM) + '</span></div></header>';
    };
    if (!st) return '<div class="rv">' + head('') + '<div class="rv-center"><h2>연결 중...</h2></div></div>';
    var halfName = st.half === 2 ? "후반" : "전반";
    if (st.phase === "elevator" && st.elevator) return renderRailElevator(st, head, halfName);
    if (st.phase === "delivery" && st.delivery) return renderRailDelivery(st, head, halfName);
    if (st.phase !== "secure") {
      var msg = st.phase === "lobby" ? ['참가자를 기다리고 있어요', '두 플레이어가 준비하면 이 화면에 레일이 열려요']
        : st.phase === "tutorial" ? ['진행 방법을 보는 중이에요', '두 사람이 다 보면 곧 시작해요 · 택배 쌓기 문제가 여기에 떠요']
        : (st.phase === "elevator" || st.phase === "delivery") ? ['배송 중이에요', '다음 택배 확보 단계에서 레일이 다시 열려요']
        : st.phase === "halftime" ? ['하프타임', '후반이 시작되면 레일이 새 택배로 채워져요']
        : ['게임이 끝났어요', '다시 시작하면 레일이 열려요'];
      return '<div class="rv">' + head(st.phase === "lobby" ? '대기 중' : halfName) + '<div class="rv-center"><h2>' + msg[0] + '</h2><p>' + msg[1] + '</p>'
        + '<div class="rv-sides">' + railSideHead(st, "1") + railSideHead(st, "2") + '</div></div></div>';
    }
    if (st.race) return renderRailRace(st);
    var endsAt = st.secureEndsAt || nowMs();
    var html = '<div class="rv">' + head('택배 확보 · ' + halfName);
    html += '<div class="rv-clockrow"><span class="rv-clock-label">남은 시간</span><b id="rv-clock" data-ends="' + endsAt + '">' + fmtClock(endsAt - nowMs()) + '</b>'
      + '<div class="rv-bar"><i id="rv-bar" data-ends="' + endsAt + '"></i></div></div>';
    html += '<div class="board-grid rv-board">';
    html += '<div class="rail-head">' + railSideHead(st, "1") + '<span>레일</span>' + railSideHead(st, "2") + '</div>';
    TYPES.forEach(function (t, catIdx) {
      var left = boardLeft(st, catIdx), pips = '';
      for (var k = 0; k < t.count; k++) pips += '<span class="pip' + (k < left ? '' : ' gone') + '"></span>';
      var mid = '<div class="rail-mid"><div class="rail-box" style="background:' + t.color + ';--c:' + t.color + '">'
        + '<span class="cell-art" style="background-image:url(\'' + BOX_ART[catIdx] + '\')"></span>'
        + '<span class="rb-name"><span class="cat-icon">' + CAT_ICONS[catIdx] + '</span>' + esc(t.name) + '</span>'
        + '<span class="rb-game">' + esc(MINI_NAME[t.mini] || '택배 쌓기') + '</span>'
        + '<span class="pips">' + pips + '</span>'
        + '<span class="cat-left">남은 <b>' + left + '</b> / ' + t.count + '</span>'
        + (left === 0 ? '<span class="stamp">소진</span>' : '')
        + '</div></div>';
      html += '<div class="board-row' + (left === 0 ? ' is-empty' : '') + '" data-cat="' + catIdx + '">'
        + railSideButtons(st, "1", t, catIdx, left) + mid + railSideButtons(st, "2", t, catIdx, left) + '</div>';
    });
    return html + '</div></div>';
  }
  function railTick() {
    var c = document.getElementById("rv-clock"), b = document.getElementById("rv-bar");
    if (!c) return;
    var ends = parseInt(c.getAttribute("data-ends"), 10), left = ends - nowMs();
    c.textContent = fmtClock(left);
    c.classList.toggle("is-low", left < 30000);
    if (b) b.style.width = Math.max(0, Math.min(100, left / SECURE_PHASE_MS * 100)) + "%";
  }
  // 플레이어 화면(레일 모드): 버튼은 레일 화면에 있다. 여기선 내 시간, 내 쪽 위치, 종류별 남은 개수와 내가 확보한 호수만 보여 준다.
  function renderRailWaiting(st, seat) {
    var msLeft = st.secureEndsAt ? (st.secureEndsAt - nowMs()) : SECURE_PHASE_MS;
    var pct = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100));
    var html = '<main class="stage stage--secure">'
      + '<div class="side-timer" id="side-timer"><span class="timer-label">택배 확보<br>남은 시간</span><span class="timer-num">' + fmtClock(msLeft) + '</span>'
      + '<div class="timer-bar"><i style="width:' + pct + '%"></i></div></div>';
    var mine = st.players[seat].invoices;
    var busy = !!(railInfo.busy && railInfo.busy[seat]);
    html += cartOpen('cart--board') + '<div class="card rw" data-rail-wait="1"><h2>' + (busy ? '게임을 푸는 중이에요' : '레일 화면에서 버튼을 눌러 주세요') + '</h2>'
      + '<p class="rw-sub">내 버튼은 레일 화면의 <b>' + (seat === "1" ? '왼쪽' : '오른쪽') + '</b>에 있어요. 누르면 이 화면에 게임이 떠요.</p><div class="rw-list">';
    TYPES.forEach(function (t, catIdx) {
      var left = boardLeft(st, catIdx);
      var chips = mine.filter(function (inv) { return inv.catIdx === catIdx; })
        .map(function (inv) { return '<span class="my-chip">' + esc(invAddr(inv)) + '</span>'; }).join('');
      html += '<div class="rw-row' + (left === 0 ? ' is-empty' : '') + '" data-cat="' + catIdx + '" style="--c:' + t.color + '">'
        + '<span class="rw-ico">' + CAT_ICONS[catIdx] + '</span><span class="rw-name">' + esc(t.name) + '<small>' + esc(MINI_NAME[t.mini] || '택배 쌓기') + '</small></span>'
        + '<span class="rw-left">남은 <b>' + left + '</b>/' + t.count + '</span><span class="rw-mine">' + (chips || '<small>아직 없음</small>') + '</span></div>';
    });
    return html + '</div></div>' + cartClose() + '</main>';
  }

  // ---------- 메인 모니터 (2026-10-06, ?view=main) ----------
  // 현장 TV/프로젝터에 띄우는 관전 화면. 요청된 것만 크게 보여준다:
  //   확보 단계    -> 남은 시간 + 종류별 남은 박스 수
  //   엘리베이터   -> 엘리베이터 위치(현재 층) + 남은 시간
  // 그 외(대기/하프타임/종료)는 흐름이 끊기지 않게 최소한만 (참가 안내, 점수). 플레이어별 비공개 정보(송장 내용,
  // 우선 택배 지정, 택배도둑 배치 위치)는 어디에도 그리지 않는다. 카운트다운 숫자는 data-ends(서버 시각)를 보고
  // mainTick()이 200ms마다 갱신하므로, 상태가 안 바뀌어도 시계는 계속 간다.
  var mvPrevFloor = null;
  function mvSeatCard(st, seatNo, readyMap, readyWord) {
    var key = st.courierPick && st.courierPick[seatNo];
    var c = key ? courierByKey(key) : null;
    var idx = c ? COURIERS.indexOf(c) : -1;
    var ready = !!(readyMap && readyMap[seatNo]);
    return '<div class="mv-seat' + (c ? ' is-on' : '') + (ready ? ' is-ready' : '') + '"' + (c ? ' style="--c:' + c.color + '"' : '') + '>'
      + (c ? '<span class="mv-seat-icon">' + COURIER_ICONS[idx] + '</span>' + esc(c.name) : '<span style="color:var(--muted)">플레이어 ' + seatNo + '</span>')
      + '<small>' + (!c ? '택배사 선택 대기' : (readyMap ? (ready ? readyWord + ' 완료' : '대기 중') : '입장 완료')) + '</small></div>';
  }
  function mvTime(endsAt, totalMs, opts) {
    // 큰 시계 한 덩어리. 값은 mainTick()이 채운다 (초기 문자열만 같은 규칙으로 미리 넣어 깜빡임을 막는다).
    opts = opts || {};
    return '<div class="mv-time" data-ends="' + endsAt + '" data-fmt="' + (opts.sec ? 'sec' : 'clock') + '"' + (opts.lowMs ? ' data-low="' + opts.lowMs + '"' : '') + '>'
      + mvFormat(endsAt, opts.sec ? 'sec' : 'clock') + '</div>';
  }
  function mvFormat(endsAt, fmt) {
    var left = Math.max(0, endsAt - nowMs());
    if (fmt === 'sec') return Math.ceil(left / 1000) + '<small>초</small>';
    return fmtClock(left);
  }
  function renderMain() {
    var st = state;
    var head = function (label) {
      return '<header class="mv-head"><div><span class="mv-eyebrow">BeatPhobia · Live · ' + BUILD_TAG + '</span><h1>택배 배송 게임</h1></div>'
        + '<div class="mv-chips">' + (label ? '<span class="mv-chip phase">' + esc(label) + '</span>' : '')
        + '<span class="mv-chip room">방 ' + esc(ROOM) + '</span></div></header>';
    };
    if (!ROOM) return '<div class="mv">' + head('') + '<div class="mv-body"><div class="mv-center"><h2>방 코드가 없어요</h2><p>주소 끝에 ?view=main 만 붙여 열면 새 방이 만들어져요.</p></div></div></div>';
    if (!st) return '<div class="mv">' + head('') + '<div class="mv-body"><div class="mv-center"><h2>연결 중...</h2></div></div></div>';
    var halfName = st.half === 2 ? "후반" : "전반";
    var html = '';

    if (st.phase === "lobby") {
      var joinUrl = location.origin + "/?room=" + ROOM;
      html = head("대기 중") + '<div class="mv-body"><div class="mv-center">'
        + '<h2>참가자를 기다리고 있어요</h2>'
        + '<div class="mv-seats">' + mvSeatCard(st, "1", st.ready, "준비") + mvSeatCard(st, "2", st.ready, "준비") + '</div>'
        + '<div class="mv-join">각자 기기에서 이 주소로 들어오세요<b>' + esc(joinUrl) + '</b></div>'
        + '<div class="mv-join mv-join-rail">레일 화면(공용)은 이 주소로<b>' + esc(location.origin + "/rail?room=" + ROOM) + '</b></div>'
        + '</div></div>';
    }
    else if (st.phase === "tutorial" && st.tutorial) {
      // 메인 모니터: 늦게 보고 있는 사람의 장을 크게 (구경꾼도 규칙을 같이 보게) + 두 사람 진행
      var tt = st.tutorial, pg = Math.min(tt.page["1"], tt.page["2"], tutPages(st).length - 1);
      html = head("진행 방법") + '<div class="mv-body"><div class="tut tut--main">' + tutPageHtml(st, pg)
        + '<div class="tut-prog">' + ["1", "2"].map(function (sn) { return '<span class="tut-who">' + esc(seatName(sn, st)) + ' · ' + tutProgText(tt, sn) + '</span>'; }).join('') + '</div>'
        + '</div></div>';
    }
    else if (st.phase === "secure") {
      var endsAt = st.secureEndsAt || nowMs();
      var cats = TYPES.map(function (t, catIdx) {
        var left = boardLeft(st, catIdx), pips = '';
        for (var i = 0; i < t.count; i++) pips += '<span class="mv-pip' + (i < left ? '' : ' is-gone') + '"></span>';
        return '<div class="mv-cat' + (left === 0 ? ' is-empty' : (left <= 2 ? ' is-few' : '')) + '" style="--c:' + t.color + '">'
          + '<div class="mv-cat-head"><span class="mv-cat-icon">' + CAT_ICONS[catIdx] + '</span><span class="mv-cat-name">' + esc(t.name) + '</span></div>'
          + '<div class="mv-cat-game">' + esc(MINI_NAME[t.mini] || "택배 쌓기") + '</div>'
          + '<div class="mv-left">' + left + '<small>/ ' + t.count + '</small></div>'
          + '<div class="mv-pips">' + pips + '</div></div>';
      }).join('');
      if (st.race) {
        html = head("택배 확보 · " + halfName) + '<div class="mv-body">' + raceStage(st, null) + '</div>';
        return '<div class="mv">' + html + '</div>';
      }
      html = head("택배 확보 · " + halfName) + '<div class="mv-body">'
        + '<div class="mv-secure-top"><div class="mv-label">확보 남은 시간</div>'
        + mvTime(endsAt, SECURE_PHASE_MS, { lowMs: 30000 })
        + '<div class="mv-bar"><i data-ends="' + endsAt + '" data-total="' + SECURE_PHASE_MS + '"></i></div></div>'
        + '<div class="mv-cats">' + cats + '</div></div>';
    }
    else if (st.phase === "elevator") {
      var el = st.elevator, floorIdx = el.floorIdx;
      var esi = elevStateInfo(st), stateLabel = esi.label, ends = esi.ends, wait = esi.wait;
      html = head("엘리베이터 · " + halfName) + '<div class="mv-body"><div class="mv-elev">'
        + '<div class="mv-bld">' + renderBuilding(el) + '</div>'
        + '<div class="mv-elev-main">'
        + '<span class="mv-round">라운드 ' + el.round + ' / ' + ELEVATOR_ROUNDS + '</span>'
        + '<div class="mv-nowfloor"><span class="mv-label">현재 층</span><span class="mv-floor-big">' + FLOORS[floorIdx] + '</span></div>'
        + '<div class="mv-state">' + esc(stateLabel) + '</div>'
        + (ends ? mvTime(ends, 0, { sec: true }) : (wait ? '<div class="mv-wait">' + esc(wait) + '</div>' : ''))
        + '</div></div></div>';
      mvPrevFloor = floorIdx;
      return '<div class="mv">' + html + '</div>';
    }
    else if (st.phase === "delivery" && st.delivery) {
      html = renderMainDelivery(st, head, halfName);
    }
    else if (st.phase === "halftime") {
      var h1 = st.halfHistory && st.halfHistory[0];
      html = head("하프타임") + '<div class="mv-body"><div class="mv-center"><h2>전반 종료</h2>'
        + (h1 ? '<div class="mv-scores">' + ["1", "2"].map(function (sn) { return '<div class="mv-score">' + esc(seatName(sn, st)) + '<b>' + fmtWon(h1.scores[sn]) + '</b></div>'; }).join('') + '</div>' : '')
        + '<p>잠시 후 후반이 시작돼요</p>'
        + '<div class="mv-seats">' + mvSeatCard(st, "1", st.halftimeReady, "준비") + mvSeatCard(st, "2", st.halftimeReady, "준비") + '</div>'
        + '</div></div>';
    }
    else if (st.phase === "end") {
      var s1 = st.scores ? st.scores["1"] : 0, s2 = st.scores ? st.scores["2"] : 0;
      var winner = s1 === s2 ? "무승부" : (s1 > s2 ? (seatName("1", st) + " 승리") : (seatName("2", st) + " 승리"));
      html = head("게임 종료") + '<div class="mv-body"><div class="mv-center"><div class="mv-winner">' + esc(winner) + '</div>'
        + '<div class="mv-scores">' + ["1", "2"].map(function (sn) { return '<div class="mv-score">' + esc(seatName(sn, st)) + ' 총점<b>' + fmtWon(sn === "1" ? s1 : s2) + '</b></div>'; }).join('') + '</div>'
        + '</div></div>';
    }
    if (st.phase !== "elevator") mvPrevFloor = null; // 다음에 엘리베이터가 시작되면 제자리에서 시작
    return '<div class="mv">' + html + '</div>';
  }
  // 그린 직후: 엘리베이터 칸을 새 층으로 옮긴다 (이전 층에서 출발한 모습으로 그려 두었다가 다음 프레임에 이동 -> CSS transition)
  function mainAfterRender() {
    mainTick();
    var car = document.getElementById("mv-car");
    if (!car) return;
    var to = car.getAttribute("data-to");
    if (car.style.getPropertyValue("--i") === to) return;
    void car.offsetWidth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { car.style.setProperty("--i", to); }); });
  }
  function mainTick() {
    var n = nowMs();
    Array.prototype.forEach.call(document.querySelectorAll(".mv-time[data-ends]"), function (e) {
      var ends = parseInt(e.getAttribute("data-ends"), 10), fmt = e.getAttribute("data-fmt");
      e.innerHTML = mvFormat(ends, fmt);
      var low = parseInt(e.getAttribute("data-low") || "0", 10);
      e.classList.toggle("is-low", !!low && ends - n < low);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".mv-bar > i[data-ends]"), function (e) {
      var ends = parseInt(e.getAttribute("data-ends"), 10), total = parseInt(e.getAttribute("data-total"), 10);
      var pct = Math.max(0, Math.min(100, (ends - n) / total * 100));
      e.style.width = pct + "%";
      e.classList.toggle("is-low", ends - n < 30000);
    });
  }

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (el) el.remove();
    if (!msg) return;
    var d = document.createElement("div");
    d.id = "toast"; d.className = "toast"; d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2600);
  }

  function render() {
    var _st = state;
    if (!_st || _st.phase !== "elevator") bldPrevFloor = null; // 다음 엘리베이터 단계는 제자리에서 시작
    document.getElementById("app").innerHTML = renderBody();
    bldAfterRender();
    if (MAIN) mainAfterRender();
    if (RAIL) railTick();
  }

  // ---------- event handling ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");

    if (action === "pick-courier") {
      // 좌석 번호는 서버가 정해서 돌려주므로(먼저 온 사람이 "1") 여기선 낙관적으로 세팅하지 않는다 --
      // 다음 "state" 브로드캐스트에서 내 clientId가 어느 좌석의 주인이 됐는지 보고 그때 확정한다
      // (connectWS의 onmessage 참고). 여기선 그냥 요청만 보낸다.
      send({ type: "pick-courier", courier: t.getAttribute("data-courier") });
      return;
    }
    if (action === "open-cell") { openCell(t.getAttribute("data-cell")); return; }
    if (action === "wall-elev") { send({ type: "wall-elev", seat: mySeat(), dir: t.getAttribute("data-dir") }); return; }
    if (action === "rail-pick") {
      send({ type: "rail-pick", side: t.getAttribute("data-side"), idx: parseInt(t.getAttribute("data-idx"), 10) });
      return;
    }
    if (action === "rail-press") {
      // 레일 화면 전용: side(1/2) 쪽 플레이어에게 그 종류 게임을 띄우라고 서버에 요청한다. 칸 선택/중복 방지는 서버가 한다.
      var rp = { type: "rail-press", side: t.getAttribute("data-side"), cat: parseInt(t.getAttribute("data-cat"), 10) };
      var rcell = t.getAttribute("data-cell"); if (rcell) rp.cellId = rcell;
      send(rp);
      return;
    }
    if (action === "rail-join") {
      var rc = (document.getElementById("rail-code").value || "").trim().toUpperCase();
      if (rc) window.location.href = "/rail?room=" + encodeURIComponent(rc);
      return;
    }
    if (action === "open-type") {
      // 레일 화면의 종류 버튼: 그 종류의 아직 안 가져간 칸 중 첫 번째를 연다 (칸끼리 구별이 없는 종류 전용)
      var typeIdx = parseInt(t.getAttribute("data-cat"), 10);
      var tt = TYPES[typeIdx];
      var freeCell = null, sawPending = false;
      for (var fi = 0; fi < state.board.length; fi++) {
        var bc = state.board[fi];
        if (bc.catIdx !== typeIdx || bc.taken) continue;
        if (local.pending[bc.id] && Date.now() - local.pending[bc.id] < 2000) { sawPending = true; continue; } // 방금 내가 끝낸 칸(브로드캐스트 대기 중)
        freeCell = bc; break;
      }
      if (!freeCell) { if (!sawPending) showToast(tt.name + "은(는) 이미 소진됐어요"); return; }
      if (tt.mini && window.MiniGames) { openMiniGame(freeCell.id); return; }
      local.openCellId = freeCell.id; render(); return;
    }
    if (action === "give-up") { local.openCellId = null; notifyGameClosed(); render(); return; }
    if (action === "complete-cell") {
      var cid = t.getAttribute("data-cell");
      markPending(cid);
      local.openCellId = null;
      send({ type: "secure-cell", seat: mySeat(), cellId: cid });
      render();
      return;
    }
    if (action === "tutorial-next" || action === "tutorial-prev" || action === "tutorial-skip") {
      send({ type: action, seat: mySeat() });
      return;
    }
    if (action === "race-done") {
      if (state && state.race) send({ type: "race-step", seat: mySeat(), step: "ubongo-done", round: state.race.round });
      return;
    }
    if (action === "race-giveup") {
      if (state && state.race) send({ type: "race-step", seat: mySeat(), step: "give-up", round: state.race.round });
      return;
    }
    if (action === "race-pick") {
      send({ type: "race-pick", seat: mySeat(), idx: parseInt(t.getAttribute("data-idx"), 10) });
      return;
    }
    if (action === "vote-up" || action === "vote-down") {
      send({ type: "vote", seat: mySeat(), dir: action === "vote-up" ? "up" : "down" });
      return;
    }
    if (action === "pick-priority") {
      var invId = t.getAttribute("data-inv");
      send({ type: "set-priority", seat: mySeat(), invoiceId: invId ? invId : null });
      return;
    }
    if (action === "confirm-priority") {
      send({ type: "confirm-priority", seat: mySeat() });
      return;
    }
    if (action === "choose-delivery") {
      send({ type: "choose-delivery", seat: mySeat(), invoiceId: t.getAttribute("data-inv") });
      return;
    }
    if (action === "place-thief") {
      send({ type: "place-thief", seat: mySeat(), floorIdx: parseInt(t.getAttribute("data-floor-idx"), 10) });
      return;
    }
    if (action === "skip-thief") {
      send({ type: "place-thief", seat: mySeat(), floorIdx: null });
      return;
    }
    if (action === "restart-ready") {
      // 다른 ready-gate(vote-up, place-thief 등)와 동일하게 낙관적 로컬 갱신 없이 그냥 보내기만
      // 한다 -- 서버가 다음 state 브로드캐스트로 st.restartReady[seat]를 채워서 돌려주면
      // renderRestartGate가 그걸 보고 버튼을 비활성화한다. 두 번 눌려도 서버가 멱등하게 무시한다.
      send({ type: "restart-ready", seat: mySeat() });
      return;
    }
  });

  document.addEventListener("keydown", function (e) {
    if (MAIN) { dKeyDown(e); return; } // 메인 컴퓨터: 배송 입력만 (2026-10-16)
    if (dKeyDown(e)) return; // 2026-10-16 벽 배송 (레일 화면 Ctrl/Shift + 호실 키, 엘리베이터 ↑↓)
    // 2026-10-15 레일 화면: 자리별 고르기 키 (1번 A S D / 2번 J K L)
    if (RAIL) {
      if (e.repeat || !state || state.phase !== "secure" || !state.race || state.race.status !== "picking") return;
      ["1", "2"].forEach(function (s) {
        var k = RAIL_PICK_KEYS[s].indexOf(e.code);
        if (k >= 0 && state.race.pair[k] && raceCanPick(state.race, s)) { e.preventDefault(); send({ type: "rail-pick", side: s, idx: k }); }
      });
      return;
    } // 메인 모니터는 입력을 받지 않는다 (스페이스/방향키가 게임에 영향 주면 안 됨)
    if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
      var seat = mySeat();
      if (seat && state && state.phase === "tutorial" && state.tutorial && !e.repeat) {
        e.preventDefault();
        if (state.tutorial.page[seat] < state.tutorial.pages) send({ type: "tutorial-next", seat: seat });
      } else if (seat && state && state.phase === "lobby" && !e.repeat && !state.ready[seat]) {
        e.preventDefault();
        send({ type: "set-ready", seat: seat });
      } else if (seat && state && state.phase === "elevator" && (state.elevator.state === "result" || state.elevator.state === "idle") && !e.repeat && !state.elevator.readyNext[seat]) {
        e.preventDefault();
        send({ type: "elevator-ready", seat: seat });
      } else if (seat && state && state.phase === "elevator" && state.elevator.state === "priority" && !e.repeat && !state.elevator.priorityConfirmed[seat]) {
        e.preventDefault();
        send({ type: "confirm-priority", seat: seat });
      } else if (seat && state && state.phase === "secure" && state.race && state.race.stage[seat] === "ubongo" && state.race.status !== "reveal" && !e.repeat) {
        // 레이스: 우봉고 투입 (현장에서는 레일 앞 물리 버튼이 스페이스)
        e.preventDefault();
        send({ type: "race-step", seat: seat, step: "ubongo-done", round: state.race.round });
      } else if (seat && state && state.phase === "halftime" && !e.repeat && !state.halftimeReady[seat]) {
        e.preventDefault();
        send({ type: "halftime-ready", seat: seat });
      }
      return;
    }
    if (!e.repeat && state && state.phase === "tutorial" && mySeat() && /^(ArrowLeft|ArrowUp|ArrowRight)$/.test(e.code)) {
      e.preventDefault();
      send({ type: e.code === "ArrowLeft" ? "tutorial-prev" : (e.code === "ArrowUp" ? "tutorial-skip" : "tutorial-next"), seat: mySeat() });
      return;
    }
    if (!e.repeat && /^(ArrowLeft|ArrowUp|ArrowDown|ArrowRight|Digit1|Digit2|Digit3|Digit4|Digit5)$/.test(e.code)) {
      // 레이스: 택배 고르기 (← = 왼쪽, ↑/↓ = 가운데, → = 오른쪽, 숫자 1/2/3도 가능)
      var seat3 = mySeat(), rr = state && state.phase === "secure" ? state.race : null;
      if (seat3 && rr && raceCanPick(rr, seat3) && !railPicks()) {
        e.preventDefault();
        var want = { ArrowLeft: 0, ArrowUp: 1, ArrowDown: 1, ArrowRight: 2, Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 }[e.code];
        if (want === undefined || (rr.plan && rOwner(rr, want))) return;
        if (rr.pair.length === 2 && e.code === "ArrowRight") want = 1;
        if (rr.pair[want]) send({ type: "race-pick", seat: seat3, idx: want });
        return;
      }
    }
    if (e.code === "ArrowUp" || e.code === "ArrowDown") {
      var seat2 = mySeat();
      if (seat2 && state && state.phase === "elevator" && state.elevator.state === "voting") {
        e.preventDefault();
        send({ type: "vote", seat: seat2, dir: e.code === "ArrowUp" ? "up" : "down" });
      }
    }
  });

  // ---------- local countdown display only: the server owns the actual round/phase transitions
  // via its own timers, so there is nothing for the client to "submit" or auto-advance here ----------
  setInterval(function () {
    if (!state) return;
    // 레이스 카운트다운 (플레이어/레일/메인 공통)
    Array.prototype.forEach.call(document.querySelectorAll(".race-count[data-ends]"), function (el) {
      var left = Math.max(0, Math.ceil((parseInt(el.getAttribute("data-ends"), 10) - nowMs()) / 1000));
      el.textContent = (el.getAttribute("data-prefix") || "") + left + (el.getAttribute("data-suffix") || "");
    });
    var rsc = document.getElementById("race-secure-clock");
    if (rsc && state.secureEndsAt) rsc.textContent = fmtClock(state.secureEndsAt - nowMs());
    if (MAIN) { mainTick(); return; }
    if (RAIL) { railTick(); return; }
    updateMiniClock();
    if (state.phase === "secure" && state.secureEndsAt) {
      var msLeft = state.secureEndsAt - nowMs();
      var barI = document.querySelector(".timer-bar > i");
      var numEl = document.querySelector(".timer-num");
      if (numEl) numEl.textContent = fmtClock(msLeft);
      if (barI) barI.style.width = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100)) + "%";
    } else if (state.phase === "elevator" && state.elevator.state === "voting" && state.elevator.votingEndsAt) {
      var left = state.elevator.votingEndsAt - nowMs();
      var clockEl = document.getElementById("round-clock");
      if (clockEl) clockEl.textContent = "남은 시간 " + fmtClock(Math.max(0, left));
    } else if (state.phase === "elevator" && state.elevator.state === "result" && state.elevator.resultEndsAt) {
      var resEl = document.getElementById("result-clock");
      if (resEl) {
        var nextTxt = state.elevator.round >= ELEVATOR_ROUNDS ? "최종 결과" : "다음 라운드로";
        resEl.textContent = Math.max(0, Math.ceil((state.elevator.resultEndsAt - nowMs()) / 1000)) + "초 뒤 자동으로 " + nextTxt;
      }
    } else if (state.phase === "elevator" && state.elevator.state === "choosing" && state.elevator.pendingChoice) {
      var seatNow = mySeat();
      var alreadyChosen = seatNow && state.elevator.pendingChoice.chosen[seatNow];
      if (!alreadyChosen) {
        var leftC = state.elevator.pendingChoice.endsAt - nowMs();
        var choiceClockEl = document.getElementById("choice-clock");
        if (choiceClockEl) choiceClockEl.textContent = "남은 시간 " + fmtClock(Math.max(0, leftC));
      }
    } else if (state.phase === "elevator" && state.elevator.state === "priority" && state.elevator.priorityWindowEndsAt) {
      var leftP = state.elevator.priorityWindowEndsAt - nowMs();
      var priClockEl = document.getElementById("priority-clock");
      if (priClockEl) priClockEl.textContent = fmtClock(Math.max(0, leftP));
      var priBarEl = document.getElementById("priority-bar");
      if (priBarEl) priBarEl.style.width = Math.max(0, Math.min(100, (leftP / PRIORITY_PICK_MS) * 100)) + "%";
    } else if (state.phase === "elevator" && state.elevator.state === "thief" && state.elevator.thiefWindowEndsAt) {
      var seatNow2 = mySeat();
      var placedNow = seatNow2 && state.elevator.thieves.placedThisRound[seatNow2];
      var skippedNow = seatNow2 && state.elevator.thieves.skipped[seatNow2];
      var doneNow = (placedNow !== null && placedNow !== undefined) || skippedNow;
      if (!doneNow) {
        var leftT = state.elevator.thiefWindowEndsAt - nowMs();
        var thiefClockEl = document.getElementById("thief-clock");
        if (thiefClockEl) thiefClockEl.textContent = "남은 시간 " + fmtClock(Math.max(0, leftT));
      }
    }
  }, 200);

  render();
  connectWS();
})();
"""

import subprocess as _sp
WALL_JSON = _sp.check_output(["node", "-e", "const d=require(" + json.dumps(GAME_DATA_JS) + ");process.stdout.write(JSON.stringify({units:d.UNITS,buildings:d.BUILDINGS,war:!!d.APT_WAR,perFloor:d.APT_UNITS_PER_FLOOR}))"]).decode("utf-8")
APP_JS = (APP_JS_TEMPLATE
          .replace("@@WALL_JSON@@", WALL_JSON)
          .replace("@@TYPES_JSON@@", TYPES_JSON)
          .replace("@@CELLS_1_JSON@@", CELLS_1_JSON)
          .replace("@@CELLS_2_JSON@@", CELLS_2_JSON)
          .replace("@@FLOORS_JSON@@", FLOORS_JSON)
          .replace("@@ROOMS_JSON@@", ROOMS_JSON)
          .replace("@@COURIERS_JSON@@", COURIERS_JSON)
          .replace("@@BOX_ART_JSON@@", BOX_ART_JSON)
          .replace("@@ELEVATOR_ROUNDS@@", str(ELEVATOR_ROUNDS))
          .replace("@@SECURE_PHASE_MS@@", str(SECURE_PHASE_MS))
          .replace("@@PRIORITY_MULTIPLIER@@", str(PRIORITY_MULTIPLIER))
          .replace("@@FLOOR_REWARD_MULT@@", json.dumps(FLOOR_REWARD_MULT))
          .replace("@@RESULT_AUTO_ADVANCE_MS@@", str(RESULT_AUTO_ADVANCE_MS))
          .replace("@@MERGE_PRIORITY_THIEF@@", "true" if MERGE_PRIORITY_THIEF else "false")
          .replace("@@RACE_MODE@@", "true" if RACE_CONST["RACE_MODE"] else "false")
          .replace("@@RACE_PICK_MS@@", str(RACE_CONST["RACE_PICK_MS"]))
          .replace("@@RACE_SECOND_MS@@", str(RACE_CONST["RACE_SECOND_MS"]))
          .replace("@@RACE_CONSOLATION_MS@@", str(RACE_CONST["RACE_CONSOLATION_MS"]))
          .replace("@@RACE_STICKER_LEVEL@@", json.dumps(RACE_CONST["RACE_STICKER_LEVEL"]))
          .replace("@@ELEVATOR_JOLT@@", str(RACE_CONST["ELEVATOR_JOLT"]))
          .replace("@@VOTE_MS@@", str(RACE_CONST["VOTE_MS"]))
          .replace("@@RACE_EXCLUDE_KINDS@@", json.dumps(RACE_CONST["RACE_EXCLUDE_KINDS"]))
          .replace("@@RACE_HAS_FIRST_GAME@@", "true" if RACE_CONST["RACE_GAME_POOL"] else "false")
          .replace("@@THIEF_PER_HALF@@", str(RACE_CONST["THIEF_PER_HALF"]))
          .replace("@@BUILD_TAG@@", "v" + __import__("datetime").datetime.now(__import__("datetime").timezone(__import__("datetime").timedelta(hours=9))).strftime("%m%d-%H%M"))
          .replace("@@SAME_FLOOR_CHOICE_MS@@", str(SAME_FLOOR_CHOICE_MS))
          .replace("@@HALVES@@", str(HALVES))
          .replace("@@THIEF_PLACE_MS@@", str(THIEF_PLACE_MS))
          .replace("@@PRIORITY_PICK_MS@@", str(PRIORITY_PICK_MS)))

# 2026-10-06: 확보 미니게임(박스 포장/불량 검수/송장 붙이기) 모듈을 그대로 인라인한다. 단독 시험장
# (build_minigame_proto.py)이 쓰는 것과 같은 파일이라, 시험장에서 확인한 동작이 게임에서도 똑같다.
_here = os.path.dirname(os.path.abspath(__file__))
MINIGAMES_CSS = open(os.path.join(_here, "minigames.css"), encoding="utf-8").read()
MINIGAMES_JS = open(os.path.join(_here, "minigames.js"), encoding="utf-8").read()
MAINVIEW_CSS = open(os.path.join(_here, "mainview.css"), encoding="utf-8").read()   # 메인 모니터(?view=main) 전용 스타일
# 2026-10-14 UI 리스킨: 창고 배경 + 빨간 카트 틀 + 요금표 (ui_theme.css). 배경 그림은 ui_art/warehouse.jpg를 data URI로 박는다.
UI_THEME_CSS = open(os.path.join(_here, "ui_theme.css"), encoding="utf-8").read()
with open(os.path.join(_here, "ui_art", "warehouse.jpg"), "rb") as _f:
    UI_THEME_CSS = UI_THEME_CSS.replace("@@WAREHOUSE_BG@@", "data:image/jpeg;base64," + base64.b64encode(_f.read()).decode("ascii"))
with open(os.path.join(_here, "ui_art", "elevator.jpg"), "rb") as _f:   # 2026-10-14 엘리베이터 단계 일러스트
    UI_THEME_CSS = UI_THEME_CSS.replace("@@ELEVATOR_BG@@", "data:image/jpeg;base64," + base64.b64encode(_f.read()).decode("ascii"))
for _n in ["apt", "mansion", "house1", "house2", "house3", "house4"]:   # 2026-10-16 배송 벽 그림 (사용자 제공 그림에서 잘라 냄)
    with open(os.path.join(_here, "ui_art", "town_" + _n + ".jpg"), "rb") as _f:
        UI_THEME_CSS = UI_THEME_CSS.replace("@@TOWN_" + _n.upper() + "@@", "data:image/jpeg;base64," + base64.b64encode(_f.read()).decode("ascii"))
with open(os.path.join(_here, "ui_art", "building.jpg"), "rb") as _f:   # 2026-10-14 엘리베이터 이동 표시(건물 단면도)
    UI_THEME_CSS = UI_THEME_CSS.replace("@@BUILDING_BG@@", "data:image/jpeg;base64," + base64.b64encode(_f.read()).decode("ascii"))
# 2026-10-22 둥근 제목 글꼴(Jua)을 파일로 박아 넣는다 -- 구글 글꼴이 안 되는 현장(오프라인)에서도 같은 모양
_jua_dir = os.path.join(_here, "ui_art", "fonts", "jua")
_jua_css = open(os.path.join(_jua_dir, "jua_embedded.css"), encoding="utf-8").read()  # 글꼴이 이미 data URI로 들어 있는 한 파일
UI_THEME_CSS = _jua_css + "\n" + UI_THEME_CSS
assert "@@" not in UI_THEME_CSS and "</style" not in UI_THEME_CSS
assert "</style" not in MAINVIEW_CSS
assert "</script" not in MINIGAMES_JS and "</style" not in MINIGAMES_CSS

full_html = (
    HEAD_HTML.replace("</style>\n</head>", MINIGAMES_CSS + "\n" + MAINVIEW_CSS + "\n" + UI_THEME_CSS + "\n</style>\n</head>", 1)
    + '<script>' + MINIGAMES_JS + "</script>\n"
    + '<script>' + APP_JS + "</script>\n"
    + "</body></html>\n"
)
assert MINIGAMES_CSS in full_html, "minigames.css가 HTML에 들어가지 않았다 (HEAD_HTML의 </style></head> 자리를 못 찾음)"

os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
with open(OUT_HTML, "w", encoding="utf-8") as f:
    f.write(full_html)

size_kb = len(full_html.encode("utf-8")) / 1024
print(f"saved {OUT_HTML} - {size_kb:.1f} KB")
