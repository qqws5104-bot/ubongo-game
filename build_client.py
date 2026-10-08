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
            priority_multiplier, same_floor_choice_ms, halves, thief_place_ms, priority_pick_ms)


(TYPES, COURIERS, FLOORS, ROOMS, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
 PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS, PRIORITY_PICK_MS) = load_shared_constants()

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


CELLS_1 = build_cells(1)   # 전반
CELLS_2 = build_cells(2)   # 후반


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
    if (inv.deliveredRound === null) return -t.penalty;
    var base = t.reward;
    return inv.deliveredWasPriority ? base * PRIORITY_MULTIPLIER : base;
  }
  function resultLabel(inv) {
    // 2026-08-27: 도난당한 송장도 "미배송"으로 통합 표기 (사용자 요청 -- 배송이 안 됐으니까).
    // 페널티/소진 로직(scoreInvoice, deliveredRound 처리)은 그대로, 영구 라벨만 통일했다. 그 라운드의
    // 실시간 안내(renderDeliveredCallout의 "택배도둑에게 도난당했어요!")는 별개로 남겨둠.
    if (inv.stolen) return "미배송";
    return inv.deliveredRound === null ? "미배송" : "성공";
  }
  function totalScore(seat, st) {
    return st.players[seat].invoices.reduce(function (sum, inv) { return sum + scoreInvoice(inv); }, 0);
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
    return proto + "//" + window.location.host + "/ws?room=" + encodeURIComponent(ROOM) + (RAIL ? "&role=rail" : "");
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
    return '<div class="center-screen"><div class="picker-scene">'
      + renderLobbyBoxes()
      + '<div class="seat-pick card">'
      + '<h2>어느 택배사 직원인가요?</h2>'
      + '<p>이 기기에서 플레이할 가상 택배사를 하나 골라주세요. 상대방이 먼저 고른 곳은 고를 수 없어요.</p>'
      + '<div class="courier-options">' + COURIERS.map(courierBtn).join('') + '</div>'
      + '<div class="room-share">이 방 코드: <strong>' + esc(ROOM) + '</strong><br>상대방에게는 지금 이 페이지의 링크를 그대로 보내주면 같은 방으로 들어와요.</div>'
      + '</div></div></div>';
  }

  function renderTopbar(st, seat) {
    var phaseLabel = { lobby: "대기 중", secure: "택배 확보", elevator: "엘리베이터", halftime: "하프타임", end: "결과" }[st.phase] || "";
    if (st.half && (st.phase === "secure" || st.phase === "elevator")) {
      phaseLabel += " · " + (st.half === 1 ? "전반" : "후반");
    }
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live</span><h1>택배 배송 게임 — ' + phaseLabel + '</h1></div>'
      + '<div class="right"><span class="room-chip">방 ' + esc(ROOM) + '</span>'
      + '<span class="seat-badge">' + (seat ? ("내 좌석 · " + seatName(seat, st)) : "택배사 미선택") + '</span></div></div>';
  }

  function renderLobby(st, seat) {
    var otherSeat = seat === "1" ? "2" : (seat === "2" ? "1" : null);
    var mine = seat ? !!st.ready[seat] : false;
    var other = otherSeat ? !!st.ready[otherSeat] : false;
    return '<main class="stage"><div class="center-screen"><div class="lobby-box card">'
      + '<h2>택배 배송 게임</h2>'
      + '<p>두 사람 모두 이 페이지를 열고 좌석을 선택한 뒤, 각자 자기 키보드의 <strong>스페이스바</strong>를 누르면 준비 완료예요.<br>'
      + '둘 다 준비되면 자동으로 시작하고, 최대 3분 동안(택배가 다 떨어지면 일찍 끝나요) 택배 확보 미니게임을 진행한 뒤 자동으로 엘리베이터 라운드(총 ' + ELEVATOR_ROUNDS + '라운드)로 넘어가요.</p>'
      + '<div class="ready-row">'
      + '<span class="ready-chip' + (mine ? ' is-ready' : '') + '">나 · ' + (seat ? seatName(seat, st) : "-") + (mine ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
      + '<span class="ready-chip' + (other ? ' is-ready' : '') + '">' + (otherSeat ? seatName(otherSeat, st) : "-") + (other ? ' · 준비 완료' : ' · 대기 중') + '</span>'
      + '</div>'
      + '<div class="space-hint">Space</div>'
      + '</div></div></main>';
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

  function renderBoard(st, seat) {
    var msLeft = st.secureEndsAt ? (st.secureEndsAt - nowMs()) : SECURE_PHASE_MS;
    var pct = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100));
    var html = '<main class="stage stage--secure">';
    html += '<div class="side-timer" id="side-timer">'
      + '<span class="timer-label">택배 확보<br>남은 시간</span>'
      + '<span class="timer-num">' + fmtClock(msLeft) + '</span>'
      + '<div class="timer-bar"><i style="width:' + pct + '%"></i></div></div>';

    html += '<div class="card"><div class="board-grid">';
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
          if (!cell.taken) mine += '<button class="floor-btn" data-action="open-cell" data-cell="' + cell.id + '">' + esc(FLOORS[num]) + '</button>';
          else if (cell.takenBy === seat) {
            var fInv = invFor(cell);
            mine += '<button class="floor-btn is-gone mine" disabled><span>' + esc(FLOORS[num]) + '</span>' + (fInv ? '<small>' + esc(roomCode(fInv.floorIdx, fInv.room)) + '</small>' : '') + '</button>';
          }
          else mine += '<button class="floor-btn is-gone" disabled title="상대가 먼저 가져갔어요">' + esc(FLOORS[num]) + '</button>';
        }
        mine += '</div>';
        mine += '<div class="mine-count">내 택배 ' + myCells.length + '개 · 층 버튼을 눌러 송장 붙이기</div>';
      } else {
        mine += '<button class="rail-btn" data-action="open-type" data-cat="' + catIdx + '"' + (left === 0 ? ' disabled' : '') + '>'
          + '<span class="rbt">' + (left === 0 ? '소진' : esc(MINI_NAME[t.mini] || '우봉고') + ' 시작') + '</span>'
          + '<span class="rbp">성공 ' + fmtWon(t.reward) + ' · 실패 ' + fmtWon(-t.penalty) + '</span></button>';
        mine += '<div class="my-chips">' + myCells.map(function (c) {
          var inv = invFor(c);
          return '<span class="my-chip">' + (inv ? esc(roomCode(inv.floorIdx, inv.room)) : '확보') + '</span>';
        }).join('') + '</div>';
      }
      mine += '</div>';
      // --- 가운데 레일 위 상자 ---
      var pips = '';
      for (var k = 0; k < t.count; k++) pips += '<span class="pip' + (k < left ? '' : ' gone') + '"></span>';
      var mid = '<div class="rail-mid"><div class="rail-box" style="background:' + t.color + ';--c:' + t.color + '">'
        + '<span class="cell-art" style="background-image:url(\'' + BOX_ART[catIdx] + '\')"></span>'
        + '<span class="rb-name"><span class="cat-icon">' + CAT_ICONS[catIdx] + '</span>' + esc(t.name) + '</span>'
        + '<span class="rb-game">' + esc(MINI_NAME[t.mini] || '우봉고') + '</span>'
        + '<span class="pips">' + pips + '</span>'
        + '<span class="cat-left">남은 <b>' + left + '</b> / ' + t.count + '</span>'
        + (left === 0 ? '<span class="stamp">소진</span>' : '')
        + '</div></div>';
      var theirs = '<div class="rail-side theirs"></div>';
      html += '<div class="board-row' + (left === 0 ? ' is-empty' : '') + '" data-cat="' + catIdx + '">'
        + (meLeft ? mine + mid + theirs : theirs + mid + mine) + '</div>';
    });
    html += '</div></div>';
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
      + '<img src="' + meta.src + '" alt="우봉고 문제">'
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
      html += '<div class="floor-stop' + (i === floorIdx ? ' current' : '') + '"><span class="car"></span>' + f + '</div>';
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
        + '<div class="meta"><div class="t">' + esc(t.name) + (flagText ? ' <span class="priority-flag">' + flagText + '</span>' : '') + '</div><div class="d">' + roomCode(inv.floorIdx, inv.room) + '</div></div>'
        + '<span class="sticker' + (delivered && !inv.stolen ? '' : ' pending') + '">' + stickerText + '</span>'
        + '</div>';
    }).join("") + '</div>';
  }

  // Only ever passed MY OWN delivered items (see renderElevator) -- who received what is private
  // per player, so there is no seat tag here; it's always understood to be "mine".
  function renderDeliveredCallout(delivered) {
    if (!delivered || !delivered.length) return '<div class="delivered-callout empty">이번 라운드에 배송된 택배가 없어요</div>';
    return '<div class="delivered-callout">' + delivered.map(function (d) {
      var t = TYPES[d.catIdx];
      var note = d.stolen
        ? ' — <span style="color:var(--danger);font-weight:700;">택배도둑에게 도난당했어요! (' + fmtWon(-t.penalty) + ')</span>'
        : ' (' + fmtWon(d.priority ? t.reward * PRIORITY_MULTIPLIER : t.reward) + (d.priority ? ' · 우선 x' + PRIORITY_MULTIPLIER : '') + ')';
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
    html += '<div class="invoice-list">' + undelivered.map(function (inv) {
      var t = TYPES[inv.catIdx];
      var picked = inv.id === pickedId;
      return '<div class="invoice' + (confirmed ? ' delivered' : ' pickable') + (picked ? ' is-priority' : '') + '"'
        + (confirmed ? '' : (' data-action="pick-priority" data-inv="' + (picked ? '' : inv.id) + '"')) + '>'
        + '<span class="swatch" style="background:' + t.color + '"></span>'
        + '<div class="meta"><div class="t">' + esc(t.name) + '</div><div class="d">' + roomCode(inv.floorIdx, inv.room) + ' · 성공 시 ' + fmtWon(t.reward) + '</div></div>'
        + '<span class="sticker' + (picked ? '' : ' pending') + '">' + (picked ? ('우선 x' + PRIORITY_MULTIPLIER) : '선택') + '</span>'
        + '</div>';
    }).join('') + '</div>';
    if (confirmed) {
      html += '<div class="pw-actions"><span class="ready-chip is-ready">'
        + (pickedId ? '우선 택배 확정' : '지정 안 함으로 확정') + '</span>'
        + '<span class="ready-chip' + (el.priorityConfirmed[otherSeat] ? ' is-ready' : '') + '">' + seatName(otherSeat, st)
        + (el.priorityConfirmed[otherSeat] ? ' · 확정' : ' · 고르는 중') + '</span></div>';
    } else {
      html += '<div class="pw-actions"><button class="btn primary" data-action="confirm-priority">'
        + (pickedId ? '이걸로 확정' : '지정 안 함으로 확정') + '</button>'
        + '<span class="key-hint">Space로도 확정 · 고른 택배를 다시 누르면 선택 해제</span></div>';
    }
    html += '</div>';
    return html;
  }

  function renderElevator(st, seat) {
    var html = '<main class="stage"><div class="elev-layout">';
    // left column: gauge, then my own package list directly beneath it -- opponent's list is
    // never rendered here (or anywhere in the elevator phase), only mine.
    html += '<div class="elev-left">' + renderShaft(st.elevator.floorIdx)
      + '<div class="player-col me"><h3>내 택배</h3>' + renderInvoiceList(st, seat) + '</div>'
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

      html += '</div></div></main>';
      return html;
    }

    // 우선 택배 지정 전용 시간 (매 라운드 맨 처음, PRIORITY_PICK_MS) -- 독립된 상태 화면.
    if (st.elevator.state === "priority") {
      html += renderPriorityWindow(st, seat);
      html += '</div></div></main>';
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
      html += '</div></div></main>';
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
            + '<div class="meta"><div class="t">' + esc(t.name) + '</div><div class="d">' + roomCode(inv.floorIdx, inv.room) + '</div></div>'
            + '<span class="sticker' + (isChosen ? '' : ' pending') + '">' + (isChosen ? '선택됨' : '선택') + '</span>'
            + '</div>';
        }).join('') + '</div>';
        html += '<div class="time-left-big" id="choice-clock">' + (myChosen ? '상대를 기다리는 중...' : '남은 시간 계산 중...') + '</div>';
      } else {
        html += '<h4>잠시만요</h4><div style="color:var(--muted);font-size:0.85rem;">상대방이 같은 층 택배 중 먼저 보낼 걸 고르고 있어요...</div>';
      }
      html += '</div>';
      html += '</div></div></main>';
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
    html += '<div class="key-hint">' + (voting ? '키보드 ↑ / ↓ 화살표로도 누를 수 있어요' : '이번 라운드 투표가 끝났어요') + '</div>';

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
        + (last.dir === "tie" ? "동률, 유지" : (last.dir === "up" ? "상승" : "하강"))
        + ' (현재 ' + FLOORS[last.floorIdx] + ')</div>'
        + renderDeliveredCallout(myDelivered)
        + '</div>';
      var otherSeat = seat === "1" ? "2" : "1";
      var myReady = !!st.elevator.readyNext[seat];
      var otherReady = !!st.elevator.readyNext[otherSeat];
      var nextLabel = st.elevator.round >= ELEVATOR_ROUNDS ? "최종 결과 보기" : "다음 라운드로";
      html += '<div class="ready-row">'
        + '<span class="ready-chip' + (myReady ? ' is-ready' : '') + '">나 · ' + seatName(seat, st) + (myReady ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
        + '<span class="ready-chip' + (otherReady ? ' is-ready' : '') + '">' + seatName(otherSeat, st) + (otherReady ? ' · 준비 완료' : ' · 대기 중') + '</span>'
        + '</div>'
        + '<div class="space-hint">Space · ' + nextLabel + '</div>';
    }
    html += '</div>';

    html += '</div></div></main>';
    return html;
  }

  // 하프타임 전환 화면: 전반이 끝난 뒤 후반(새 보드, 새 송장, 택배도둑 해금)을 시작하기 전 결과를 잠깐
  // 보여주고, 둘 다 스페이스바를 누르면 후반의 택배 확보 페이즈가 시작된다.
  function renderHalftime(st, seat) {
    var otherSeat = seat === "1" ? "2" : "1";
    var myReady = !!st.halftimeReady[seat];
    var otherReady = !!st.halftimeReady[otherSeat];
    var h1 = st.halfHistory[0];
    var html = '<main class="stage"><div class="center-screen"><div class="halftime-box card">';
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
    html += '</div></div></main>';
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
      html += '<tr><td>' + esc(t.name) + '</td><td>' + roomCode(inv.floorIdx, inv.room) + '</td><td>' + label + '</td><td>' + fmtWon(pts) + '</td></tr>';
    });
    if (!invs.length) html += '<tr><td colspan="4" style="color:var(--muted)">확보한 택배 없음</td></tr>';
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
    var html = '<main class="stage">';
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
    html += '</main>';
    return html;
  }

  function renderLoading() {
    return '<main class="stage"><div class="center-screen"><div class="lobby-box card"><h2>연결 중...</h2>'
      + '<p>서버에 접속하고 있어요. 잠시만 기다려 주세요.</p></div></div></main>';
  }

  function renderBody() {
    if (RAIL && !ROOM) return renderRailJoin();
    if (!ROOM) return '<main class="stage"><div class="center-screen"><div class="lobby-box card"><h2>잘못된 링크예요</h2><p>방 코드가 없어요. 처음 받은 링크로 다시 들어와 주세요.</p></div></div></main>';
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
      body += (railInfo.count > 0 ? renderRailWaiting(state, seat) : renderBoard(state, seat)) + renderPuzzleOverlay(state);
    }
    else if (state.phase === "elevator") body += renderElevator(state, seat);
    else if (state.phase === "halftime") body += renderHalftime(state, seat);
    else if (state.phase === "end") body += renderEnd(state, seat);
    return body;
  }
  function renderTopbarShell() {
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live</span><h1>택배 배송 게임</h1></div>'
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
          + (off ? ' disabled' : '') + '>' + esc(FLOORS[num]) + '</button>';
      }
      html += '</div>';
    } else {
      var off2 = !here || busy || left === 0;
      html += '<button class="rail-btn' + (busy ? ' is-busy' : '') + '" data-action="rail-press" data-side="' + side + '" data-cat="' + catIdx + '"' + (off2 ? ' disabled' : '') + '>'
        + '<span class="rbt">' + (left === 0 ? '소진' : (busy ? '게임 중...' : esc(MINI_NAME[t.mini] || '우봉고') + ' 시작')) + '</span>'
        + '<span class="rbp">성공 ' + fmtWon(t.reward) + ' · 실패 ' + fmtWon(-t.penalty) + '</span></button>';
    }
    return html + '</div>';
  }
  function renderRail() {
    var st = state;
    var head = function (label) {
      return '<header class="rv-head"><div><span class="rv-eyebrow">BeatPhobia · Live</span><h1>레일 화면</h1></div>'
        + '<div class="rv-chips">' + (label ? '<span class="rv-chip phase">' + esc(label) + '</span>' : '') + '<span class="rv-chip room">방 ' + esc(ROOM) + '</span></div></header>';
    };
    if (!st) return '<div class="rv">' + head('') + '<div class="rv-center"><h2>연결 중...</h2></div></div>';
    var halfName = st.half === 2 ? "후반" : "전반";
    if (st.phase !== "secure") {
      var msg = st.phase === "lobby" ? ['참가자를 기다리고 있어요', '두 플레이어가 준비하면 이 화면에 레일이 열려요']
        : st.phase === "elevator" ? ['배송 중이에요', '다음 택배 확보 단계에서 레일이 다시 열려요']
        : st.phase === "halftime" ? ['하프타임', '후반이 시작되면 레일이 새 택배로 채워져요']
        : ['게임이 끝났어요', '다시 시작하면 레일이 열려요'];
      return '<div class="rv">' + head(st.phase === "lobby" ? '대기 중' : halfName) + '<div class="rv-center"><h2>' + msg[0] + '</h2><p>' + msg[1] + '</p>'
        + '<div class="rv-sides">' + railSideHead(st, "1") + railSideHead(st, "2") + '</div></div></div>';
    }
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
        + '<span class="rb-game">' + esc(MINI_NAME[t.mini] || '우봉고') + '</span>'
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
    html += '<div class="card rw" data-rail-wait="1"><h2>' + (busy ? '게임을 푸는 중이에요' : '레일 화면에서 버튼을 눌러 주세요') + '</h2>'
      + '<p class="rw-sub">내 버튼은 레일 화면의 <b>' + (seat === "1" ? '왼쪽' : '오른쪽') + '</b>에 있어요. 누르면 이 화면에 게임이 떠요.</p><div class="rw-list">';
    TYPES.forEach(function (t, catIdx) {
      var left = boardLeft(st, catIdx);
      var chips = mine.filter(function (inv) { return inv.catIdx === catIdx; })
        .map(function (inv) { return '<span class="my-chip">' + esc(roomCode(inv.floorIdx, inv.room)) + '</span>'; }).join('');
      html += '<div class="rw-row' + (left === 0 ? ' is-empty' : '') + '" data-cat="' + catIdx + '" style="--c:' + t.color + '">'
        + '<span class="rw-ico">' + CAT_ICONS[catIdx] + '</span><span class="rw-name">' + esc(t.name) + '<small>' + esc(MINI_NAME[t.mini] || '우봉고') + '</small></span>'
        + '<span class="rw-left">남은 <b>' + left + '</b>/' + t.count + '</span><span class="rw-mine">' + (chips || '<small>아직 없음</small>') + '</span></div>';
    });
    return html + '</div></div></main>';
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
      return '<header class="mv-head"><div><span class="mv-eyebrow">BeatPhobia · Live</span><h1>택배 배송 게임</h1></div>'
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
    else if (st.phase === "secure") {
      var endsAt = st.secureEndsAt || nowMs();
      var cats = TYPES.map(function (t, catIdx) {
        var left = boardLeft(st, catIdx), pips = '';
        for (var i = 0; i < t.count; i++) pips += '<span class="mv-pip' + (i < left ? '' : ' is-gone') + '"></span>';
        return '<div class="mv-cat' + (left === 0 ? ' is-empty' : (left <= 2 ? ' is-few' : '')) + '" style="--c:' + t.color + '">'
          + '<div class="mv-cat-head"><span class="mv-cat-icon">' + CAT_ICONS[catIdx] + '</span><span class="mv-cat-name">' + esc(t.name) + '</span></div>'
          + '<div class="mv-cat-game">' + esc(MINI_NAME[t.mini] || "우봉고") + '</div>'
          + '<div class="mv-left">' + left + '<small>/ ' + t.count + '</small></div>'
          + '<div class="mv-pips">' + pips + '</div></div>';
      }).join('');
      html = head("택배 확보 · " + halfName) + '<div class="mv-body">'
        + '<div class="mv-secure-top"><div class="mv-label">확보 남은 시간</div>'
        + mvTime(endsAt, SECURE_PHASE_MS, { lowMs: 30000 })
        + '<div class="mv-bar"><i data-ends="' + endsAt + '" data-total="' + SECURE_PHASE_MS + '"></i></div></div>'
        + '<div class="mv-cats">' + cats + '</div></div>';
    }
    else if (st.phase === "elevator") {
      var el = st.elevator, floorIdx = el.floorIdx;
      var stateLabel = "", ends = null, wait = "";
      if (el.state === "idle") { stateLabel = "출발 준비 중"; wait = "두 플레이어가 준비하면 출발해요"; }
      else if (el.state === "priority") { stateLabel = "우선 택배 지정 시간"; ends = el.priorityWindowEndsAt; }
      else if (el.state === "thief") { stateLabel = "택배도둑 배치 시간"; ends = el.thiefWindowEndsAt; }
      else if (el.state === "voting") { stateLabel = "엘리베이터 이동 중!"; ends = el.votingEndsAt; }
      else if (el.state === "choosing") { stateLabel = "같은 층 택배 선택 중"; ends = el.pendingChoice && el.pendingChoice.endsAt; }
      else if (el.state === "result") { stateLabel = "라운드 결과 확인 중"; wait = "다음 라운드 준비 대기"; }
      else { stateLabel = "배송 종료"; }
      var rows = '';
      FLOORS.forEach(function (f, i) { rows += '<div class="mv-floor-row' + (i === floorIdx ? ' is-current' : '') + '">' + f + '</div>'; });
      var carFrom = mvPrevFloor === null ? floorIdx : mvPrevFloor;
      html = head("엘리베이터 · " + halfName) + '<div class="mv-body"><div class="mv-elev">'
        + '<div class="mv-shaft"><div class="mv-floors">' + rows + '</div>'
        + '<div class="mv-car" id="mv-car" data-to="' + floorIdx + '" style="--i:' + carFrom + '"><span>' + FLOORS[floorIdx] + '</span></div></div>'
        + '<div class="mv-elev-main">'
        + '<span class="mv-round">라운드 ' + el.round + ' / ' + ELEVATOR_ROUNDS + '</span>'
        + '<div class="mv-nowfloor"><span class="mv-label">현재 층</span><span class="mv-floor-big">' + FLOORS[floorIdx] + '</span></div>'
        + '<div class="mv-state">' + esc(stateLabel) + '</div>'
        + (ends ? mvTime(ends, 0, { sec: true }) : (wait ? '<div class="mv-wait">' + esc(wait) + '</div>' : ''))
        + '</div></div></div>';
      mvPrevFloor = floorIdx;
      return '<div class="mv">' + html + '</div>';
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
    document.getElementById("app").innerHTML = renderBody();
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
    if (MAIN) return; // 메인 모니터는 입력을 받지 않는다 (스페이스/방향키가 게임에 영향 주면 안 됨)
    if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
      var seat = mySeat();
      if (seat && state && state.phase === "lobby" && !e.repeat && !state.ready[seat]) {
        e.preventDefault();
        send({ type: "set-ready", seat: seat });
      } else if (seat && state && state.phase === "elevator" && (state.elevator.state === "result" || state.elevator.state === "idle") && !e.repeat && !state.elevator.readyNext[seat]) {
        e.preventDefault();
        send({ type: "elevator-ready", seat: seat });
      } else if (seat && state && state.phase === "elevator" && state.elevator.state === "priority" && !e.repeat && !state.elevator.priorityConfirmed[seat]) {
        e.preventDefault();
        send({ type: "confirm-priority", seat: seat });
      } else if (seat && state && state.phase === "halftime" && !e.repeat && !state.halftimeReady[seat]) {
        e.preventDefault();
        send({ type: "halftime-ready", seat: seat });
      }
      return;
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

APP_JS = (APP_JS_TEMPLATE
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
assert "</style" not in MAINVIEW_CSS
assert "</script" not in MINIGAMES_JS and "</style" not in MINIGAMES_CSS

full_html = (
    HEAD_HTML.replace("</style>\n</head>", MINIGAMES_CSS + "\n" + MAINVIEW_CSS + "\n</style>\n</head>", 1)
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
