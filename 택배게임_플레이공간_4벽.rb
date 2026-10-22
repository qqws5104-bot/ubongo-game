# encoding: UTF-8
# =====================================================================================
#  택배 배송 게임 · 플레이 공간 (지금 만든 게임 기준)  -- SketchUp Ruby          2026-10-22
#  원래 그린 방(흰 벽 + 남색 징두리 + 주황 걸레받이, 셔터, LED 시계, 벽 모니터, 가운데 레일, 상자 더미)을
#  그대로 두고, 지금 게임이 실제로 쓰는 장치를 자리마다 배치했다.
#
#   벽 4면: 뒷벽 = 문 벽(출입문 + 셔터 + LED 시계) / 앞벽(문 맞은편) = 아파트 /
#           오른쪽 벽 = 맨션 / 왼쪽 벽 = 주택. 건물마다 벽 하나를 통째로 쓴다.
#   ① 플레이어 자리 2개: 가운데 레일 양옆에 마주 보는 주황 스탠딩 책상
#      개인 화면(조각 미니게임) + Space·방향 버튼 + 실물 퍼즐 판·조각 통 + 택배 고르기 버튼 5개(팀 색)
#   ② 레일: 뒤쪽 끝에 레일 화면(택배 쌓기 문제 · 두 사람 진행도 · 고를 택배)
#      레일 위 공용 상황판: 32형 4개를 사방으로 매단 화면. 메인 화면을 HDMI 분배기로 똑같이 띄움 -- 어느 벽 앞에서도 보임
#   ③ 배송: 각 벽까지 걸어가서 집마다 있는 버튼 한 쌍 중 내 팀 색(빨강·파랑)을 누른다. 상대가 켠 집은 내 색 버튼 5번 = 막기.
#      배선: 같이 보낸 벽버튼_배선표.csv (빨간 버튼 키 / 파란 버튼 키). 게임은 PAIR_BUTTONS 기본값(켜짐)으로.
#   흐름: ① 자리에서 미니게임 → 조각 → 퍼즐 완성(Space) → 자리 버튼으로 택배 고르기 → ③ 배송 단계에 벽으로
#   버튼은 USB 오락실 버튼 인코더로 연결하면 키보드로 인식돼서 게임 코드를 고칠 필요가 없다.
#
#  쓰는 법: SketchUp > 창(Window) > Ruby 콘솔 에서  load "C:/경로/택배게임_플레이공간_v2.rb"
#  크기는 아래 숫자(미터)만 바꾸면 다시 지어진다. 실행 취소: Ctrl+Z 한 번.
# =====================================================================================

module BeatPhobiaDeliveryRoom
  ROOM   = 5.0   # 방 한 변 (정사각형)
  WALL_H = 2.4   # 벽 높이
  WALL_T = 0.15  # 벽 두께
  NAVY_OUT = 0.65 # 바깥 남색 징두리 높이
  NAVY_IN  = 0.45 # 안쪽 남색 징두리 높이
  BASE_H   = 0.1  # 바깥 주황 걸레받이 높이

  def self.m(v) v.to_f.m end
  def self.pt(x, y, z) Geom::Point3d.new(m(x), m(y), m(z)) end

  def self.mat(model, name, rgb, alpha = 1.0)
    mt = model.materials[name] || model.materials.add(name)
    mt.color = Sketchup::Color.new(*rgb)
    mt.alpha = alpha
    mt
  end

  def self.materials(model)
    {
      wall:    mat(model, "택배게임_벽_흰색",   [242, 242, 238]),
      navy:    mat(model, "택배게임_남색",      [31, 52, 82]),
      orange:  mat(model, "택배게임_주황",      [230, 122, 58]),
      floor:   mat(model, "택배게임_바닥",      [203, 202, 214]),
      shutter: mat(model, "택배게임_셔터",      [96, 98, 104]),
      rib:     mat(model, "택배게임_셔터골",    [60, 62, 68]),
      screen:  mat(model, "택배게임_화면",      [116, 185, 232]),
      bezel:   mat(model, "택배게임_화면테",    [36, 52, 84]),
      led:     mat(model, "택배게임_LED",       [196, 48, 48]),
      ledtxt:  mat(model, "택배게임_LED글자",   [255, 120, 100]),
      rail:    mat(model, "택배게임_레일상판",  [245, 245, 245]),
      steel:   mat(model, "택배게임_철제",      [64, 66, 72]),
      kraft:   mat(model, "택배게임_상자",      [205, 158, 108]),
      kraft2:  mat(model, "택배게임_상자_어두운", [176, 130, 84]),
      blue:    mat(model, "택배게임_상자_파랑", [120, 182, 232]),
      orbox:   mat(model, "택배게임_상자_주황", [226, 118, 66]),
      purple:  mat(model, "택배게임_보라",      [140, 90, 200]),
      pink:    mat(model, "택배게임_분홍",      [236, 110, 150]),
      door:    mat(model, "택배게임_문",        [40, 44, 52]),
      red:     mat(model, "택배게임_빨간팀",    [229, 57, 53]),
      teamb:   mat(model, "택배게임_파란팀",    [47, 111, 224]),
      yellow:  mat(model, "택배게임_버튼노랑",  [246, 195, 68]),
      white:   mat(model, "택배게임_버튼흰색",  [250, 250, 250]),
      house:   mat(model, "택배게임_주택버튼",  [240, 200, 120]),
      piece1:  mat(model, "택배게임_조각1",     [230, 60, 60]),
      piece2:  mat(model, "택배게임_조각2",     [250, 220, 40]),
      piece3:  mat(model, "택배게임_조각3",     [60, 120, 220]),
      person_r: mat(model, "택배게임_사람빨강", [229, 57, 53], 0.8),
      person_b: mat(model, "택배게임_사람파랑", [47, 111, 224], 0.8),
    }
  end

  def self.box(ents, x, y, z, w, d, h, material, name = nil)
    g = ents.add_group
    g.name = name if name
    f = g.entities.add_face(pt(x, y, z), pt(x + w, y, z), pt(x + w, y + d, z), pt(x, y + d, z))
    f.reverse! if f.normal.z < 0
    f.pushpull(m(h))
    g.material = material
    g
  end

  def self.room(ents, mt)
    s, t, h = ROOM, WALL_T, WALL_H
    box(ents, -t, -t, -0.03, s + 2 * t, s + 2 * t, 0.03, mt[:floor], "바닥")
    # 벽 4면 (안팎 남색 징두리, 위는 흰색)
    walls = { "앞벽" => [-t, -t, s + 2 * t, t], "뒷벽" => [-t, s, s + 2 * t, t], "왼쪽 벽" => [-t, 0, t, s], "오른쪽 벽" => [s, 0, t, s] }
    walls.each do |nm, (x, y, w, d)|
      box(ents, x, y, 0, w, d, h, mt[:wall], nm)
    end
    # 안쪽 남색 징두리 (벽 안쪽 면에 얇게)
    k = 0.01
    box(ents, 0, 0, 0, s, k, NAVY_IN, mt[:navy], "안쪽 징두리 앞")
    box(ents, 0, s - k, 0, s, k, NAVY_IN, mt[:navy], "안쪽 징두리 뒤")
    box(ents, 0, k, 0, k, s - 2 * k, NAVY_IN, mt[:navy], "안쪽 징두리 왼쪽")
    box(ents, s - k, k, 0, k, s - 2 * k, NAVY_IN, mt[:navy], "안쪽 징두리 오른쪽")
    # 바깥 남색 징두리 + 주황 걸레받이
    o = t + k
    [[-o, -o, s + 2 * o, k], [-o, s + t, s + 2 * o, k], [-o, -t, k, s + 2 * t], [s + t, -t, k, s + 2 * t]].each_with_index do |(x, y, w, d), i|
      box(ents, x, y, BASE_H, w, d, NAVY_OUT - BASE_H, mt[:navy], "바깥 징두리 #{i + 1}")
      box(ents, x, y, 0, w, d, BASE_H, mt[:orange], "바깥 걸레받이 #{i + 1}")
    end
    # 바닥 주황 선 (벽에서 0.25m 안쪽, 폭 0.06m) -- 뒤·왼쪽·오른쪽 3면 + 앞 일부
    b, lw = 0.08, 0.06   # 벽 바로 앞 주황 선
    box(ents, b, s - b - lw, 0, s - 2 * b, lw, 0.004, mt[:orange], "바닥선 뒤")
    box(ents, b, b, 0, lw, s - 2 * b, 0.004, mt[:orange], "바닥선 왼쪽")
    box(ents, s - b - lw, b, 0, lw, s - 2 * b, 0.004, mt[:orange], "바닥선 오른쪽")
    box(ents, b, b, 0, s - 2 * b, lw, 0.004, mt[:orange], "바닥선 앞")
  end

  def self.back_wall(ents, mt)
    s, h = ROOM, WALL_H
    sx, sw = 1.55, 0.75
    box(ents, sx, s - 0.04, 0, sw, 0.04, h, mt[:shutter], "셔터")
    n = 26
    (1...n).each { |i| box(ents, sx + 0.02, s - 0.05, i * h / n.to_f, sw - 0.04, 0.01, 0.018, mt[:rib]) }
    # LED 시계 (빨간 판)
    lx = sx + sw + 0.25
    box(ents, lx, s - 0.06, 1.75, 0.38, 0.06, 0.16, mt[:led], "LED 시계")
    [0.05, 0.13, 0.21, 0.29].each { |dx| box(ents, lx + dx, s - 0.065, 1.79, 0.05, 0.005, 0.08, mt[:ledtxt]) }
    # (예전 벽 모니터는 가운데 4면 상황판으로 옮김 -- 배송 때 어느 벽에서든 고개만 돌리면 보이게)
    # 출입문 (뒷벽 = 문 벽). 안쪽·바깥쪽 문짝 + 문틀
    dx0, dw, dh = 3.85, 0.9, 2.05
    box(ents, dx0 - 0.06, s - 0.02, 0, 0.06, 0.02, dh + 0.06, mt[:orange], "문틀")
    box(ents, dx0 + dw, s - 0.02, 0, 0.06, 0.02, dh + 0.06, mt[:orange])
    box(ents, dx0, s - 0.02, dh, dw, 0.02, 0.06, mt[:orange])
    box(ents, dx0, s - 0.025, 0, dw, 0.025, dh, mt[:door], "출입문 (안쪽)")
    box(ents, dx0, s + WALL_T, 0, dw, 0.025, dh, mt[:door], "출입문 (바깥쪽)")
    box(ents, dx0 + dw - 0.12, s - 0.04, 1.0, 0.06, 0.015, 0.03, mt[:steel], "손잡이")
  end

  def self.box_pile(ents, mt, x, y)
    g = ents.add_group
    g.name = "택배 상자 더미"
    e = g.entities
    box(e, x, y, 0, 0.45, 0.4, 0.38, mt[:kraft])
    box(e, x + 0.03, y + 0.03, 0.38, 0.4, 0.34, 0.3, mt[:kraft2])
    box(e, x + 0.05, y + 0.42, 0, 0.38, 0.32, 0.26, mt[:kraft])
    # 열린 상자 (속에 알록달록한 물건)
    ox, oy = x + 0.55, y + 0.15
    box(e, ox, oy, 0, 0.42, 0.36, 0.02, mt[:kraft2])
    box(e, ox, oy, 0.02, 0.42, 0.02, 0.22, mt[:kraft])
    box(e, ox, oy + 0.34, 0.02, 0.42, 0.02, 0.22, mt[:kraft])
    box(e, ox, oy, 0.02, 0.02, 0.36, 0.22, mt[:kraft])
    box(e, ox + 0.4, oy, 0.02, 0.02, 0.36, 0.22, mt[:kraft])
    box(e, ox + 0.06, oy + 0.06, 0.02, 0.1, 0.24, 0.16, mt[:purple])
    box(e, ox + 0.18, oy + 0.06, 0.02, 0.08, 0.24, 0.14, mt[:pink])
    box(e, ox + 0.28, oy + 0.06, 0.02, 0.08, 0.24, 0.12, mt[:blue])
    # 펼쳐진 뚜껑
    box(e, ox - 0.02, oy - 0.2, 0.22, 0.46, 0.2, 0.01, mt[:kraft])
    g
  end

  def self.rail(ents, mt)
    s = ROOM
    rx, ry, rw, rl, rh = s * 0.40, s * 0.30, 0.55, 1.9, 0.85
    g = ents.add_group
    g.name = "레일(컨베이어)"
    e = g.entities
    # 다리 + 아래 가로대
    [[rx, ry], [rx + rw - 0.05, ry], [rx, ry + rl - 0.05], [rx + rw - 0.05, ry + rl - 0.05]].each { |px, py| box(e, px, py, 0, 0.05, 0.05, rh, mt[:steel]) }
    box(e, rx, ry + rl * 0.5, 0.15, rw, 0.05, 0.05, mt[:steel])
    # 테두리 철제 + 흰 상판(롤러 칸 나눔)
    box(e, rx - 0.03, ry - 0.03, rh, 0.03, rl + 0.06, 0.08, mt[:steel])
    box(e, rx + rw, ry - 0.03, rh, 0.03, rl + 0.06, 0.08, mt[:steel])
    6.times { |i| box(e, rx, ry + i * rl / 6.0 + 0.02, rh, rw, rl / 6.0 - 0.04, 0.05, mt[:rail]) }
    # 택배 3개
    box(e, rx + 0.12, ry + 0.15, rh + 0.05, 0.32, 0.3, 0.26, mt[:orbox], "택배(주황)")
    box(e, rx + 0.12, ry + 0.8, rh + 0.05, 0.32, 0.3, 0.28, mt[:blue], "택배(파랑)")
    box(e, rx + 0.1, ry + 1.45, rh + 0.05, 0.34, 0.32, 0.3, mt[:kraft], "택배(갈색)")
    g
  end

  # 원기둥(버튼): 밑면 중심 c(미터), 방향 dir, 반지름 r, 길이 len
  def self.cyl(ents, c, dir, r, len, material, name = nil)
    g = ents.add_group
    g.name = name if name
    edges = g.entities.add_circle(pt(*c), dir, m(r), 20)
    f = g.entities.add_face(edges)
    f.reverse! unless f.normal.samedirection?(dir)
    f.pushpull(m(len))
    g.material = material
    g
  end

  def self.label(ents, text, x, y, z, off = [0, 0, 0.4])
    ents.add_text(text, pt(x, y, z), Geom::Vector3d.new(m(off[0]), m(off[1]), m(off[2])))
  end

  def self.person(ents, x, y, material, name)
    g = ents.add_group
    g.name = name
    cyl(g.entities, [x, y, 0], Z_AXIS, 0.2, 1.45, material)
    cyl(g.entities, [x, y, 1.48], Z_AXIS, 0.12, 0.22, material)
    g
  end

  # ---------- ① 플레이어 자리 (벽에 붙은 주황 스탠딩 책상) ----------
  # x0: 벽 쪽 x, dirx: 방 안쪽 방향(+1 = 왼쪽 벽 자리, -1 = 오른쪽 벽 자리)
  def self.player_station(ents, mt, x, y, dirx, team)
    # x: 책상의 레일 쪽 끝, dirx: 사람이 서는 쪽(-1 = 레일 왼쪽 자리, +1 = 오른쪽 자리)
    tname = team == :red ? "빨간 팀" : "파란 팀"
    w, d, h = 0.6, 1.2, 0.95
    x0 = dirx < 0 ? x - w : x
    g = ents.add_group
    g.name = "#{tname} 자리 (미니게임 + 택배 쌓기 + 택배 고르기 버튼)"
    e = g.entities
    box(e, x0, y, h, w, d, 0.04, mt[:orange], "#{tname} 책상 상판")
    [[x0, y], [x0 + w - 0.05, y], [x0, y + d - 0.05], [x0 + w - 0.05, y + d - 0.05]].each { |px, py| box(e, px, py, 0, 0.05, 0.05, h, mt[:orange]) }
    box(e, x0, y, 0.25, w, 0.04, 0.04, mt[:orange])
    box(e, x0, y + d - 0.04, 0.25, w, 0.04, 0.04, mt[:orange])
    top = h + 0.04
    # 개인 화면: 레일 쪽 끝에 세워 사람 쪽을 봄
    sx = dirx < 0 ? x - 0.05 : x + 0.01
    box(e, sx, y + 0.3, top, 0.04, 0.6, 0.36, mt[:bezel], "#{tname} 개인 화면 (조각 미니게임)")
    box(e, dirx < 0 ? sx - 0.005 : sx + 0.04, y + 0.33, top + 0.03, 0.005, 0.54, 0.3, mt[:screen])
    # 퍼즐 판 + 조각 통
    px = x0 + 0.13
    box(e, px, y + 0.42, top, 0.34, 0.38, 0.015, mt[:white], "#{tname} 퍼즐 판 (택배 쌓기)")
    box(e, px + 0.05, y + 0.5, top + 0.015, 0.08, 0.16, 0.02, mt[:piece1])
    box(e, px + 0.15, y + 0.52, top + 0.015, 0.16, 0.08, 0.02, mt[:piece2])
    box(e, px, y + 0.05, top, 0.34, 0.28, 0.06, mt[:kraft2], "#{tname} 조각 통")
    # 사람 쪽 끝: Space(노랑) + 방향 4개(흰색) + 택배 고르기 버튼 5개(팀 색)
    bx = dirx < 0 ? x0 + 0.1 : x0 + w - 0.1
    cyl(e, [bx, y + 0.95, top], Z_AXIS, 0.05, 0.03, mt[:yellow], "Space (투입·연타)")
    [[0, 0], [0, 0.08], [0, -0.08], [0.08 * dirx, 0]].each { |ox, oy| cyl(e, [bx + ox, y + 0.25 + oy, top], Z_AXIS, 0.028, 0.025, mt[:white]) }
    5.times { |k| cyl(e, [bx, y + 0.45 + k * 0.08, top], Z_AXIS, 0.03, 0.025, team == :red ? mt[:red] : mt[:teamb]) }
    person(e, x0 + (dirx < 0 ? -0.4 : w + 0.4), y + d / 2.0, team == :red ? mt[:person_r] : mt[:person_b], "#{tname} 플레이어")
    label(e, "① #{tname} 자리: 미니게임 → 퍼즐 → Space · 고르기 버튼 5개", x0 + w / 2.0, y + d / 2.0, top + 0.4, [0, 0, 0.5])
    g
  end

  # ---------- ② 레일: 레일 화면 + 팀별 고르기 버튼 ----------
  def self.rail_game(ents, mt)
    s = ROOM
    rx, ry, rw, rl, rh = s * 0.40, s * 0.30, 0.55, 1.9, 0.85  # rail()과 같은 값
    g = ents.add_group
    g.name = "② 레일 화면: 택배 쌓기 문제 · 진행도 · 택배 고르기"
    e = g.entities
    cx = rx + rw / 2.0
    yb = ry + rl + 0.25
    box(e, cx - 0.06, yb, 0, 0.12, 0.12, 1.2, mt[:steel], "레일 화면 스탠드")
    box(e, cx - 0.62, yb - 0.02, 1.12, 1.24, 0.06, 0.72, mt[:bezel], "레일 화면 55형")
    box(e, cx - 0.58, yb - 0.025, 1.16, 1.16, 0.005, 0.64, mt[:screen])
    label(e, "② 레일 화면 (택배 고르기는 자리의 팀 버튼 5개로)", cx, yb, 1.85, [0, 0, 0.4])
    g
  end

  # ---------- ③ 벽 3면 배송 버튼판 ----------
  # 판 공통: 남색 판 + 집(호실)마다 버튼 한 쌍(빨강·파랑, 벽에서 튀어나옴)
  def self.wall_button(e, c, inward, material, r = 0.04, name = nil)
    cyl(e, c, inward, r, 0.035, material, name)
  end

  # 문마다 버튼 한 쌍: 벽을 마주 봤을 때 빨강 왼쪽 · 파랑 오른쪽. along = 마주 본 사람의 오른쪽 방향 [dx, dy]
  def self.pair_button(e, mt, c, inward, along, gap = 0.045)
    wall_button(e, [c[0] - along[0] * gap, c[1] - along[1] * gap, c[2]], inward, mt[:red], 0.032)
    wall_button(e, [c[0] + along[0] * gap, c[1] + along[1] * gap, c[2]], inward, mt[:teamb], 0.032)
  end

  def self.wall_panels(ents, mt)
    s = ROOM
    g = ents.add_group
    g.name = "③ 벽 배송 버튼판: 앞벽 아파트 · 오른쪽 벽 맨션 · 왼쪽 벽 주택 (뒷벽 = 문)"
    e = g.entities
    # 아파트: 앞벽 (문 맞은편) 가운데, 7층 × 2호 + 엘리베이터 ↑↓
    ax0, az0 = s / 2.0 - 0.55, 0.4
    box(e, ax0, 0.0, az0, 1.1, 0.03, 1.75, mt[:navy], "아파트 버튼판 (7층×2호) -- 문 맞은편 벽")
    box(e, ax0 + 0.53, 0.03, az0 + 0.4, 0.04, 0.005, 1.3, mt[:steel], "승강로 표시")
    7.times do |f|
      z = az0 + 0.45 + f * 0.19
      pair_button(e, mt, [ax0 + 0.25, 0.03, z], Y_AXIS, [-1, 0])
      pair_button(e, mt, [ax0 + 0.85, 0.03, z], Y_AXIS, [-1, 0])
    end
    wall_button(e, [ax0 + 0.55, 0.03, az0 + 1.45], Y_AXIS, mt[:yellow], 0.045, "엘리베이터 ↑")
    wall_button(e, [ax0 + 0.55, 0.03, az0 + 1.3], Y_AXIS, mt[:yellow], 0.045, "엘리베이터 ↓")
    label(e, "아파트 벽 (7층×2호 · 엘리베이터 ↑↓)", ax0 + 0.55, 0.03, az0 + 1.75, [0, 0.4, 0.3])
    # 맨션: 오른쪽 벽 가운데, 2층 × 6호
    my0, mz0, mw = s / 2.0 - 1.2, 0.65, 2.4
    box(e, s - 0.03, my0, mz0, 0.03, mw, 1.05, mt[:navy], "맨션 버튼판 (2층×6호)")
    2.times do |f|
      6.times { |u| pair_button(e, mt, [s - 0.03, my0 + 0.25 + u * 0.38, mz0 + 0.55 + f * 0.33], X_AXIS.reverse, [0, -1]) }
    end
    label(e, "맨션 벽 (2층×6호)", s - 0.03, my0 + mw / 2.0, mz0 + 1.05, [-0.4, 0, 0.3])
    # 주택: 왼쪽 벽 가운데, 작은 집 8채 한 줄 (집마다 초인종)
    hy0, hz0, hw = s / 2.0 - 1.55, 0.6, 3.1
    box(e, 0.0, hy0, hz0, 0.03, hw, 0.95, mt[:navy], "주택 버튼판 (8채)")
    8.times do |k|
      y = hy0 + 0.15 + k * 0.36
      box(e, 0.03, y, hz0 + 0.35, 0.02, 0.28, 0.26, mt[:house], "주택 #{k + 1}")
      box(e, 0.03, y + 0.02, hz0 + 0.61, 0.02, 0.24, 0.08, mt[:orbox])
      pair_button(e, mt, [0.05, y + 0.14, hz0 + 0.45], X_AXIS, [0, 1], 0.05)
    end
    label(e, "주택 벽 (8채 · 초인종)", 0.03, hy0 + hw / 2.0, hz0 + 0.95, [0.4, 0, 0.3])
    g
  end

  # ---------- 공용 상황판: 레일 위에 매단 4면 화면 ----------
  # 배송 단계에는 두 사람이 서로 다른 벽 앞에 있으므로, 벽 하나에 붙인 화면은 늘 누군가의 등 뒤가 된다.
  # 그래서 방 가운데(레일 위)에 사방을 향한 32형 화면 4개를 매단다. 메인 화면 하나를 HDMI 분배기로 4개에 똑같이 띄운다.
  # 보이는 것: 두 팀 조각 수·완성 연출(택배 쌓기 때) / 배송 건수·금액·점수 차이 막대·남은 시간·FEVER(배송 때)
  def self.status_board(ents, mt)
    s = ROOM
    cx, cy = s * 0.40 + 0.275, s * 0.30 + 0.95   # 레일 가운데
    sw, sh, z0 = 0.74, 0.44, 1.9                  # 32형 화면, 아래 끝 높이
    g = ents.add_group
    g.name = "공용 상황판 (4면 화면, 레일 위)"
    e = g.entities
    box(e, cx - 0.03, cy - 0.03, z0 + sh, 0.06, 0.06, WALL_H + 0.3 - (z0 + sh), mt[:steel], "천장 걸이")
    box(e, cx - sw / 2.0, cy - sw / 2.0, z0, sw, sw, sh, mt[:bezel], "4면 화면 틀")
    m = 0.03
    box(e, cx - sw / 2.0 + m, cy - sw / 2.0 - 0.005, z0 + m, sw - 2 * m, 0.005, sh - 2 * m, mt[:screen], "화면 (앞벽·아파트 쪽)")
    box(e, cx - sw / 2.0 + m, cy + sw / 2.0, z0 + m, sw - 2 * m, 0.005, sh - 2 * m, mt[:screen], "화면 (문 쪽)")
    box(e, cx - sw / 2.0 - 0.005, cy - sw / 2.0 + m, z0 + m, 0.005, sw - 2 * m, sh - 2 * m, mt[:screen], "화면 (주택 쪽)")
    box(e, cx + sw / 2.0, cy - sw / 2.0 + m, z0 + m, 0.005, sw - 2 * m, sh - 2 * m, mt[:screen], "화면 (맨션 쪽)")
    label(e, "공용 상황판 (4면): 진행도 · 점수 차이 · 남은 시간 · FEVER", cx, cy, z0 + sh, [0.6, 0, 0.5])
    g
  end

  def self.build
    model = Sketchup.active_model
    model.start_operation("택배게임 플레이 공간", true)
    mt = materials(model)
    root = model.active_entities.add_group
    root.name = "택배게임 플레이 공간 (현재 게임 기준)"
    e = root.entities
    room(e, mt)
    back_wall(e, mt)
    player_station(e, mt, ROOM * 0.40 - 0.25, ROOM * 0.30 + 0.35, -1, :red)        # 레일 왼쪽
    player_station(e, mt, ROOM * 0.40 + 0.55 + 0.25, ROOM * 0.30 + 0.35, +1, :blue) # 레일 오른쪽 (레일 사이로 마주 봄)
    box_pile(e, mt, 0.3, 0.25)                           # 앞쪽 왼쪽 구석 (장식)
    rail(e, mt)
    rail_game(e, mt)
    wall_panels(e, mt)
    status_board(e, mt)
    s = ROOM
    cam = Sketchup::Camera.new(pt(s * 1.9, -s * 0.8, s * 2.4), pt(s / 2.0, s / 2.0, 0.3), Z_AXIS) # 원래 그림처럼 셔터 벽이 오른쪽 위
    model.active_view.camera = cam
    page = model.pages["택배게임 플레이 공간"] || model.pages.add("택배게임 플레이 공간")
    page.update
    # 문(뒷벽) 쪽 위에서 들어오며 보는 장면 -- 정면에 아파트 벽
    cam2 = Sketchup::Camera.new(pt(s * 0.75, s * 2.1, s * 1.9), pt(s / 2.0, s * 0.35, 0.6), Z_AXIS)
    model.active_view.camera = cam2
    page2 = model.pages["문에서 본 모습"] || model.pages.add("문에서 본 모습")
    page2.update
    model.commit_operation
    puts "택배게임 플레이 공간 완료: #{ROOM}m × #{ROOM}m"
  rescue => err
    model.abort_operation if model
    puts "오류: #{err.message}\n#{err.backtrace.first(5).join("\n")}"
  end
end

BeatPhobiaDeliveryRoom.build
