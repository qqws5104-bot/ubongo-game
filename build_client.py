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
            priority_multiplier, same_floor_choice_ms, halves, thief_place_ms)


(TYPES, COURIERS, FLOORS, ROOMS, ELEVATOR_ROUNDS, SECURE_PHASE_MS, VOTE_MS,
 PRIORITY_MULTIPLIER, SAME_FLOOR_CHOICE_MS, HALVES, THIEF_PLACE_MS) = load_shared_constants()

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


def load_image_files(ref_dir):
    files = sorted(
        f for f in os.listdir(ref_dir)
        if f.lower().endswith(".png") and f != "contact_sheet.png"
    )
    if len(files) < TOTAL_CELLS:
        print(
            f"WARNING: {ref_dir} 안에 원본 PNG가 {len(files)}장뿐인데 칸은 {TOTAL_CELLS}개입니다. "
            f"부족한 {TOTAL_CELLS - len(files)}칸은 마지막 이미지를 임시로 재사용합니다 -- "
            "실제 플레이 전 반드시 새 이미지 세트로 교체하세요."
        )
    elif len(files) > TOTAL_CELLS:
        print(f"WARNING: 원본 PNG가 {len(files)}장 있는데 칸은 {TOTAL_CELLS}개뿐입니다 ({ref_dir}). 앞에서부터 {TOTAL_CELLS}장만 사용합니다.")
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


def build_cells(ref_dir):
    files = load_image_files(ref_dir)
    cells = []
    flat_idx = 0
    for cat_idx, t in enumerate(TYPES):
        for num_idx in range(t["count"]):
            cells.append({
                "id": f"{t['key']}-{num_idx + 1}",
                "catIdx": cat_idx,
                "num": num_idx,
                "src": data_uri_for(image_for_flat_idx(files, ref_dir, flat_idx)),
            })
            flat_idx += 1
    return cells


CELLS_1 = build_cells(REF_DIR_1)   # 전반
CELLS_2 = build_cells(REF_DIR_2)   # 후반


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

  /* Board is now 21 cells split unevenly across 4 category rows (5/6/5/5 -- 확정 층수 택배 has 6,
     one per floor). A single monolithic CSS grid can't hold rows of different lengths without the
     shorter rows' cells drifting into the next row's slots, so each category is its own row-level
     grid (repeat(6,1fr) so columns still line up visually across rows even when a row only fills
     5 of them) stacked in a flex column. */
  .board-grid { display:flex; flex-direction:column; gap:0.5rem; flex:1; min-height:0; overflow-y:auto; }
  .board-row { display:grid; grid-template-columns:minmax(110px,150px) repeat(6,1fr); gap:0.4rem; align-items:stretch; }
  /* 2026-08-27 리스킨: 참고 포스터("택배 요금표")의 카드 스타일을 그대로 옮겨왔다 -- 크림색 카드,
     종류별 색을 두른 테두리, 위에 플랫 라인 아이콘 + 이름, 아래에 오렌지 헤더가 달린 "구분/요금"
     미니 표. 실제 <table> 대신 grid로 짠 것은 이 칸(110~150px 폭, 보드 4행 높이에 맞춰야 함)이 너무
     좁고 낮아서 표 레이아웃 엔진의 기본 여백을 이길 필요가 있었기 때문 -- 시각적으로는 표와 동일하게
     읽힌다. 카드 자체는 var(--panel)(크림)에 앉고 카테고리 색은 테두리 + 아이콘 틴트로만 쓴다 (이전
     버전처럼 배경 전체를 칠하지 않음 -- 그건 남색 테마에서의 방식이었고, 지금은 포스터의 "흰 카드 +
     색 테두리" 언어를 따른다). */
  .board-label { display:flex; flex-direction:column; gap:0.3rem; padding:0.45rem 0.55rem; border-radius:10px;
    background:var(--panel); border:2px solid var(--panel-line); box-shadow:0 2px 7px rgba(43,29,18,0.1); }
  .board-label .cat-head { display:flex; align-items:center; gap:0.32rem; }
  .board-label .cat-icon { width:17px; height:17px; flex-shrink:0; }
  .board-label .cat-icon svg { width:100%; height:100%; display:block; }
  .board-label .cat-name { font-family:var(--font-display); font-size:0.76rem; font-weight:800; letter-spacing:0.005em;
    line-height:1.15; color:var(--ink); }
  .board-label .price-grid { display:grid; grid-template-columns:1fr 1fr; gap:2px 4px; margin-top:0.2rem; }
  .board-label .price-grid .pk { font-family:var(--font-display); font-size:0.64rem; color:var(--muted); font-weight:600; }
  .board-label .price-grid .pv { font-family:var(--font-display); font-size:0.64rem; color:var(--ink); font-weight:700;
    text-align:right; font-variant-numeric:tabular-nums; }
  /* each cell reads as a soft, rounded 3D delivery box. Base layer is still the category's flat
     color (set inline per-cell, see renderBoard) -- on top of that (2026-08-27) sits the user-
     supplied box illustration (.cell-art, one image per category, shared by all cells of that
     category) as a blurred backdrop, then the glossy highlight + diagonal "strap" band (still
     drawn with black/white overlays so they work over any art), then the a/b/c/d/e or floor label
     on top of all of it. aspect-ratio is intentionally NOT set -- the cell stretches to fill its
     grid row/column exactly (board-grid's grid-template-rows:1fr above), which is what makes the
     whole board fit any viewport height without scrolling. */
  .cell { position:relative; min-height:0; border-radius:16px; border:none; display:flex; align-items:center; justify-content:center;
    font-family:var(--font-display); font-weight:700; font-size:1.25rem; overflow:hidden;
    box-shadow: inset 0 3px 0 rgba(255,255,255,0.38), inset 0 -12px 16px rgba(0,0,0,0.22), 0 6px 14px rgba(0,0,0,0.22); }
  /* box illustration backdrop (2026-08-27, user-supplied art per category -- see box_art/ and
     BOX_ART in renderBoard). Cells are small (21 of them fit on one screen) and the source art has
     its own baked-in label text, so it's deliberately BLURRED and lets the a/b/c/d/e or floor
     label (z-index 3, its own opaque chip below) stay the thing you actually read -- the art is
     ambient texture/color, not something meant to be legible at this size. Oversized inset (not
     0) so the blur has room to sample past the cell's own edge instead of fading to transparent
     there; .cell's overflow:hidden clips it back to the rounded shape. */
  .cell .cell-art { position:absolute; inset:-20% -20%; z-index:0; background-repeat:no-repeat;
    background-position:center; background-size:cover; filter:blur(6px); opacity:0.92; }
  /* glossy sheen, upper-left */
  .cell::before { content:""; position:absolute; inset:0; z-index:1; border-radius:inherit;
    background: radial-gradient(120% 90% at 28% 14%, rgba(255,255,255,0.4), transparent 55%); }
  /* the wrap-around strap: a diagonal darkened band across the box's own color -- reads as a
     slightly darker sash/ribbon without needing a separate strap color per category. */
  .cell::after { content:""; position:absolute; inset:-15% -15%; z-index:1;
    background: linear-gradient(112deg, transparent 39%, rgba(0,0,0,0.15) 44%, rgba(0,0,0,0.15) 60%, transparent 65%); }
  /* the a/b/c/d/e or floor label is styled as its own little shipping-label plate -- cream fill +
     navy border -- echoing the white label-plate-with-navy-outline that's already part of the box
     art itself, so it reads as "that thing on the box" rather than a generic floating text overlay
     (2026-08-27, to go with the box art backdrop above). Same treatment as .invoice-label below,
     just without the rotation (that one reads as a sticker slapped on after the fact; this one
     reads as printed on the box). */
  .cell .cell-num { position:relative; z-index:3; background:#f4f1ea; color:#20180f;
    border:2px solid #16233f; font-family:var(--font-display); font-weight:700; font-size:1.05rem;
    letter-spacing:0.02em; padding:0.26rem 0.6rem; border-radius:6px; box-shadow:0 3px 8px rgba(0,0,0,0.3); }
  .cell .box-tag { position:absolute; z-index:3; right:8px; bottom:7px; display:flex; align-items:center; gap:4px; opacity:0.55; }
  .cell .box-tag .chip { width:9px; height:9px; border-radius:2px; background:currentColor; }
  .cell .box-tag .lines { display:flex; flex-direction:column; gap:2px; }
  .cell .box-tag .lines span { display:block; width:15px; height:2px; border-radius:1px; background:currentColor; }
  /* a secured cell keeps its category color (it reads as "this box's contents"), it just gets a
     shipping-label sticker slapped on with the invoice's destination room code instead of the
     plain index number -- the box stays identifiable, not just greyed into a blank "used" tile. */
  .cell.taken { cursor:default; }
  .cell.taken::before, .cell.taken::after { opacity:0.5; }
  .cell.taken .cell-art { opacity:0.45; }
  .cell.taken .box-tag { opacity:0.3; }
  .cell .invoice-label { position:relative; z-index:3; background:#f4f1ea; color:#20180f;
    border:2px solid #16233f; font-family:var(--font-display); font-weight:700; font-size:1.05rem; letter-spacing:0.02em;
    padding:0.3rem 0.63rem; border-radius:6px; box-shadow:0 3px 8px rgba(0,0,0,0.3); transform:rotate(-2deg); }
  .cell:not(.taken):hover { filter:brightness(1.06); transform:translateY(-1px); }

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
  .puzzle-frame { max-width:960px; width:100%; }
  .puzzle-frame img { width:100%; border-radius:12px; display:block; box-shadow:0 20px 60px rgba(0,0,0,0.5); }
  .puzzle-actions { display:flex; gap:0.8rem; margin-top:1rem; }
  .puzzle-actions .btn { flex:1; }

  .elev-layout { display:grid; grid-template-columns:220px 1fr; gap:1.2rem; align-items:start; }
  @media (max-width:820px) { .elev-layout { grid-template-columns:1fr; } }
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
  .priority-picker { margin-top:0.75rem; padding-top:0.75rem; border-top:1px dashed var(--panel-line); }
  .priority-picker h4 { margin:0 0 0.5rem; font-family:var(--font-display); font-size:0.9rem; color:var(--gold); }

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
  .toast { position:fixed; left:50%; bottom:1.4rem; transform:translateX(-50%); background:var(--panel); border:1px solid var(--panel-line);
    padding:0.6rem 1.1rem; border-radius:999px; font-size:0.85rem; z-index:80; box-shadow:0 10px 30px rgba(0,0,0,0.4); }
</style>
</head><body>
<div id="app"></div>
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
  // 확정 층수 택배를 제외한 나머지 종류는 칸 번호 대신 A/B/C/D/E로 표기한다 (사용자 요청, 2026-08-27: 대문자로 변경).
  var CELL_LETTERS = ["A", "B", "C", "D", "E", "F"];

  var ROOM = (new URLSearchParams(window.location.search).get("room") || "").trim().toUpperCase();

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
  var local = { openCellId: null, toast: null };
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
    return proto + "//" + window.location.host + "/ws?room=" + encodeURIComponent(ROOM);
  }
  function connectWS() {
    if (!ROOM) return;
    try { ws = new WebSocket(wsUrl()); } catch (e) { setTimeout(connectWS, 1500); return; }
    ws.onopen = function () {
      wsConnected = true;
      renderConnBanner();
      var seat = mySeat();
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
        // 2026-08-27: "pick-courier"는 좌석 번호를 클라이언트가 미리 못 정하므로(서버가 정해서
        // 돌려줌 -- game-room.js의 pickCourier), 낙관적으로 sessionStorage에 세팅하는 대신 여기서
        // 매 상태 브로드캐스트마다 "아직 내 좌석을 모르는 상태에서 내 clientId가 어느 좌석 주인이
        // 됐는지"를 확인해서 확정한다. 한 번 확정되면(mySeat() !== null) 더 이상 스캔 안 함.
        if (!mySeat()) {
          ["1", "2"].forEach(function (s) { if (state.seatOwners[s] === CLIENT_ID) setMySeat(s); });
        }
        render();
      }
      else if (msg.type === "error") { handleWsError(msg); }
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
      + '둘 다 준비되면 자동으로 시작하고, 3분 동안 택배 확보 미니게임을 진행한 뒤 자동으로 엘리베이터 라운드(총 ' + ELEVATOR_ROUNDS + '라운드)로 넘어가요.</p>'
      + '<div class="ready-row">'
      + '<span class="ready-chip' + (mine ? ' is-ready' : '') + '">나 · ' + (seat ? seatName(seat, st) : "-") + (mine ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
      + '<span class="ready-chip' + (other ? ' is-ready' : '') + '">' + (otherSeat ? seatName(otherSeat, st) : "-") + (other ? ' · 준비 완료' : ' · 대기 중') + '</span>'
      + '</div>'
      + '<div class="space-hint">Space</div>'
      + '</div></div></main>';
  }

  function renderBoard(st, seat) {
    var msLeft = st.secureEndsAt ? (st.secureEndsAt - Date.now()) : SECURE_PHASE_MS;
    var pct = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100));
    var html = '<main class="stage stage--secure">';
    html += '<div class="side-timer" id="side-timer">'
      + '<span class="timer-label">택배 확보<br>남은 시간</span>'
      + '<span class="timer-num">' + fmtClock(msLeft) + '</span>'
      + '<div class="timer-bar"><i style="width:' + pct + '%"></i></div></div>';

    html += '<div class="card"><div class="board-grid">';
    // each seat has its own independent board -- what I secure has zero effect on the other
    // player's copy of the same cell id, so this is purely my own view, no cross-player state.
    // Cells are grouped by type but the group offsets are no longer a fixed "x5" -- each type has
    // its own `count` (확정 층수 택배 has 6, the rest have 5), so we look each cell up by id
    // instead of assuming a fixed stride.
    var myBoard = st.boards[seat];
    var myInvoices = st.players[seat].invoices;
    var boardById = {};
    myBoard.forEach(function (c) { boardById[c.id] = c; });
    TYPES.forEach(function (t, catIdx) {
      html += '<div class="board-row">';
      html += '<div class="board-label" style="border-color:' + t.color + ';">'
        + '<div class="cat-head"><span class="cat-icon" style="color:' + t.color + '">' + CAT_ICONS[catIdx] + '</span>'
        + '<span class="cat-name">' + esc(t.name) + '</span></div>'
        + '<div class="price-grid">'
        + '<span class="pk">성공</span><span class="pv">' + fmtWon(t.reward) + '</span>'
        + '<span class="pk">실패</span><span class="pv">' + fmtWon(-t.penalty) + '</span>'
        + '</div></div>';
      for (var num = 0; num < t.count; num++) {
        var cell = boardById[t.key + "-" + (num + 1)];
        var taken = !!cell.taken;
        // 확정 층수 택배는 칸의 num이 곧 배송 층이므로 지금 표기(층 이름) 그대로 유지하고,
        // 나머지 종류는 숫자 대신 A/B/C/D/E로 표기한다 (사용자 요청, 2026-08-27; 같은 날 다시 대문자로 변경).
        var faceHtml = t.fixedFloor
          ? '<span class="cell-num">' + esc(FLOORS[num]) + '</span>'
          : '<span class="cell-num">' + esc(CELL_LETTERS[num] || String(num + 1)) + '</span>';
        if (taken) {
          // the invoice created at securing time shares this cell's acquiredSeq -- look it up to
          // show its destination as a shipping-label sticker instead of the plain index number.
          var inv = null;
          for (var i = 0; i < myInvoices.length; i++) { if (myInvoices[i].acquiredSeq === cell.acquiredSeq) { inv = myInvoices[i]; break; } }
          faceHtml = inv ? ('<span class="invoice-label">' + esc(roomCode(inv.floorIdx, inv.room)) + '</span>') : faceHtml;
        }
        html += '<button class="cell' + (taken ? ' taken' : '') + '" style="background:' + t.color + ';color:' + t.ink + ';"'
          + (taken ? '' : (' data-action="open-cell" data-cell="' + cell.id + '"'))
          + '>' + '<span class="cell-art" style="background-image:url(\'' + BOX_ART[catIdx] + '\')"></span>' + faceHtml
          + '<span class="box-tag"><span class="chip"></span><span class="lines"><span></span><span></span><span></span></span></span>'
          + '</button>';
      }
      html += '</div>';
    });
    html += '</div></div>';
    html += '</main>';
    return html;
  }

  function renderPuzzleOverlay(st) {
    var cellId = local.openCellId;
    if (!cellId) return '<div class="overlay hidden" id="puzzle-overlay"></div>';
    var meta = cellMeta(cellId, st.half);
    var t = TYPES[meta.catIdx];
    return '<div class="overlay" id="puzzle-overlay">'
      + '<div class="puzzle-frame">'
      + '<div style="margin-bottom:0.6rem;color:var(--muted);font-family:var(--font-display);font-size:0.85rem;">' + esc(t.name) + ' · 조각 ' + t.pieces + '개</div>'
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

  // 라운드 게이트("idle"/"result")에 내장된 우선 택배 지정 -- 매 라운드 다시 골라야 한다(라운드가
  // 끝나면 서버가 el.priorityPick을 비운다). 그 라운드 안에 배송까지 성공해야만 점수가
  // PRIORITY_MULTIPLIER배가 된다 -- 나중 라운드로 넘어가면 보너스는 사라진다(사용자 확인 사항).
  function renderPriorityPicker(st, seat) {
    var undelivered = st.players[seat].invoices.filter(function (inv) { return inv.deliveredRound === null; })
      .sort(function (a, b) { return a.acquiredSeq - b.acquiredSeq; });
    if (!undelivered.length) return '';
    var pickedId = st.elevator.priorityPick[seat];
    var html = '<div class="priority-picker"><h4>이번 라운드 우선 택배 (성공 시 점수 ' + PRIORITY_MULTIPLIER + '배 · 그 라운드 안에 배송해야 적용돼요)</h4>';
    html += '<div class="invoice-list">' + undelivered.map(function (inv) {
      var t = TYPES[inv.catIdx];
      var picked = inv.id === pickedId;
      return '<div class="invoice pickable' + (picked ? ' is-priority' : '') + '" data-action="pick-priority" data-inv="' + inv.id + '">'
        + '<span class="swatch" style="background:' + t.color + '"></span>'
        + '<div class="meta"><div class="t">' + esc(t.name) + '</div><div class="d">' + roomCode(inv.floorIdx, inv.room) + ' · 성공 시 ' + fmtWon(t.reward) + '</div></div>'
        + '<span class="sticker' + (picked ? '' : ' pending') + '">' + (picked ? ('우선 x' + PRIORITY_MULTIPLIER) : '선택') + '</span>'
        + '</div>';
    }).join('') + '</div>';
    html += '<div style="margin-top:0.5rem;"><button class="btn ghost" data-action="pick-priority" data-inv="">지정 안 함</button></div>';
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
      html += '<div style="margin-top:0.75rem;color:var(--muted);font-size:0.9rem;">확보한 택배를 확인하고, 준비가 되면 스페이스바를 눌러주세요.</div>';
      html += '<div class="ready-row" style="margin-top:0.75rem;">'
        + '<span class="ready-chip' + (myReady0 ? ' is-ready' : '') + '">나 · ' + seatName(seat, st) + (myReady0 ? ' · 준비 완료' : ' · 스페이스바 대기') + '</span>'
        + '<span class="ready-chip' + (otherReady0 ? ' is-ready' : '') + '">' + seatName(otherSeat0, st) + (otherReady0 ? ' · 준비 완료' : ' · 대기 중') + '</span>'
        + '</div>'
        + '<div class="space-hint">Space · 엘리베이터 이동 시작</div>';
      html += renderPriorityPicker(st, seat);
      html += '</div>';

      html += '</div></div></main>';
      return html;
    }

    // 택배도둑 배치 전용 시간 (후반 전용, 매 라운드 voting 시작 전 THIEF_PLACE_MS 동안 -- idle/voting 중
    // 아무 때나 놓을 수 있던 예전 방식 대신, 이제는 독립된 상태 화면이다). 배치는 선택사항(건너뛰기
    // 가능)이고, 배치 직후엔 아무 효과 없이 다음 라운드부터 실제로 작동한다 (game-room.js의 el.thieves
    // 참고). 둘 다 배치/건너뛰기를 마치면 타이머를 기다리지 않고 곧장 voting으로 넘어간다.
    // 2026-08-27: 1인당 이 후반 전체(5라운드)를 통틀어 배치는 딱 1번만 허용 -- usedThisHalf가 true면
    // 서버가 이미 매 라운드 자동으로 스킵 처리해두므로(placeThief 호출 없이도 doneMine이 true), 여기서는
    // "이미 다 썼다"는 걸 구분해서 보여주기만 하면 된다.
    if (st.elevator.state === "thief") {
      var placedMine = st.elevator.thieves.placedThisRound[seat];
      var skippedMine = !!st.elevator.thieves.skipped[seat];
      var usedUpMine = !!st.elevator.thieves.usedThisHalf[seat];
      var doneMine = placedMine !== null && placedMine !== undefined || skippedMine;
      html += '<div class="thief-window">';
      html += '<h4>택배도둑 배치 (후반 전용, 후반 통틀어 1회)</h4>';
      if (doneMine) {
        html += '<div style="color:var(--muted);font-size:0.85rem;">'
          + (placedMine !== null && placedMine !== undefined
            ? ('<strong style="color:var(--danger)">' + esc(FLOORS[placedMine]) + '</strong>에 배치했어요. 다음 라운드부터 그 층에 상대가 배송하면 뺏어요.')
            : (usedUpMine ? '이번 후반에 택배도둑을 이미 사용했어요 (1인당 1회).' : '이번 라운드는 배치하지 않았어요.'))
          + ' 상대를 기다리는 중...</div>';
      } else {
        html += '<div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem;">층을 골라 배치하면, 다음 라운드에 상대가 그 층에 배송할 때 가로채서 상대에게 확정 마이너스 점수를 줘요. 이 후반 동안 딱 한 번만 놓을 수 있으니 신중하게 골라주세요.</div>';
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
      html += renderPriorityPicker(st, seat);
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
    if (!ROOM) return '<main class="stage"><div class="center-screen"><div class="lobby-box card"><h2>잘못된 링크예요</h2><p>방 코드가 없어요. 처음 받은 링크로 다시 들어와 주세요.</p></div></div></main>';
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
    else if (state.phase === "secure") body += renderBoard(state, seat) + renderPuzzleOverlay(state);
    else if (state.phase === "elevator") body += renderElevator(state, seat);
    else if (state.phase === "halftime") body += renderHalftime(state, seat);
    else if (state.phase === "end") body += renderEnd(state, seat);
    return body;
  }
  function renderTopbarShell() {
    return '<div class="topbar"><div class="brand"><span class="eyebrow">BeatPhobia · Live</span><h1>택배 배송 게임</h1></div>'
      + '<div class="right"><span class="room-chip">방 ' + esc(ROOM) + '</span></div></div>';
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
    if (action === "open-cell") { local.openCellId = t.getAttribute("data-cell"); render(); return; }
    if (action === "give-up") { local.openCellId = null; render(); return; }
    if (action === "complete-cell") {
      var cid = t.getAttribute("data-cell");
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
    if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
      var seat = mySeat();
      if (seat && state && state.phase === "lobby" && !e.repeat && !state.ready[seat]) {
        e.preventDefault();
        send({ type: "set-ready", seat: seat });
      } else if (seat && state && state.phase === "elevator" && (state.elevator.state === "result" || state.elevator.state === "idle") && !e.repeat && !state.elevator.readyNext[seat]) {
        e.preventDefault();
        send({ type: "elevator-ready", seat: seat });
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
    if (state.phase === "secure" && state.secureEndsAt) {
      var msLeft = state.secureEndsAt - Date.now();
      var barI = document.querySelector(".timer-bar > i");
      var numEl = document.querySelector(".timer-num");
      if (numEl) numEl.textContent = fmtClock(msLeft);
      if (barI) barI.style.width = Math.max(0, Math.min(100, (msLeft / SECURE_PHASE_MS) * 100)) + "%";
    } else if (state.phase === "elevator" && state.elevator.state === "voting" && state.elevator.votingEndsAt) {
      var left = state.elevator.votingEndsAt - Date.now();
      var clockEl = document.getElementById("round-clock");
      if (clockEl) clockEl.textContent = "남은 시간 " + fmtClock(Math.max(0, left));
    } else if (state.phase === "elevator" && state.elevator.state === "choosing" && state.elevator.pendingChoice) {
      var seatNow = mySeat();
      var alreadyChosen = seatNow && state.elevator.pendingChoice.chosen[seatNow];
      if (!alreadyChosen) {
        var leftC = state.elevator.pendingChoice.endsAt - Date.now();
        var choiceClockEl = document.getElementById("choice-clock");
        if (choiceClockEl) choiceClockEl.textContent = "남은 시간 " + fmtClock(Math.max(0, leftC));
      }
    } else if (state.phase === "elevator" && state.elevator.state === "thief" && state.elevator.thiefWindowEndsAt) {
      var seatNow2 = mySeat();
      var placedNow = seatNow2 && state.elevator.thieves.placedThisRound[seatNow2];
      var skippedNow = seatNow2 && state.elevator.thieves.skipped[seatNow2];
      var doneNow = (placedNow !== null && placedNow !== undefined) || skippedNow;
      if (!doneNow) {
        var leftT = state.elevator.thiefWindowEndsAt - Date.now();
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
          .replace("@@THIEF_PLACE_MS@@", str(THIEF_PLACE_MS)))

full_html = (
    HEAD_HTML
    + '<script>' + APP_JS + "</script>\n"
    + "</body></html>\n"
)

os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
with open(OUT_HTML, "w", encoding="utf-8") as f:
    f.write(full_html)

size_kb = len(full_html.encode("utf-8")) / 1024
print(f"saved {OUT_HTML} - {size_kb:.1f} KB")
