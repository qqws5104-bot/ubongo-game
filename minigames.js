/* minigames.js -- 택배 확보 미니게임 3종 (박스 포장 / 불량 검수 / 송장 붙이기)
 *
 * 바닐라 JS, 의존성 없음. 게임 본체(build_client.py)에 그대로 인라인하거나, 단독 시험장 페이지에서
 * 똑같이 쓸 수 있게 만들었다.
 *
 *   var ctl = MiniGames.start(hostElement, {
 *     kind: "pack" | "inspect" | "sticker",
 *     level: 1 | 2 | 3,              // 쉬움 / 보통 / 어려움
 *     label: "B08호",                // 송장 붙이기에서 송장에 찍을 목적지 (없으면 임의 생성)
 *     onDone:   function (res) {},   // res = { ok:true, kind, level, ms, mistakes }
 *     onCancel: function () {},      // "포기" 버튼
 *   });
 *   ctl.destroy();                   // 키 입력 리스너/타이머 정리 (오버레이를 닫을 때 반드시 호출)
 *
 * 한 칸의 시간제한은 따로 없다 -- 전체 확보 시간(3분)이 곧 시계다. 실패 상태도 없고, 다 풀어야 끝난다.
 */
(function (root) {
  "use strict";

  var KINDS = {
    pack:    { name: "박스 포장" },
    inspect: { name: "불량 검수" },
    sticker: { name: "송장 붙이기" },
  };
  var LEVEL_NAME = ["쉬움", "보통", "어려움"];

  // 박스 포장에서 방향키를 잘못 눌렀을 때의 규칙 (2026-10-06 결정: 영상처럼 "reset" -- 처음부터 다시).
  //   reset  : 입력한 순서 전체를 처음부터 다시
  //   freeze : 0.5초 멈췄다가 있던 자리부터 이어서
  //   ignore : 틀린 키는 무시(실수로만 기록)
  var config = { mistakeRule: "reset" };

  function rand(n) { return Math.floor(Math.random() * n); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = rand(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function restartAnim(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // 리플로우를 강제해야 같은 클래스를 다시 붙여도 애니메이션이 재시작된다
    node.classList.add(cls);
  }
  function fmtSec(ms) { return (ms / 1000).toFixed(1) + "초"; }

  // ======================================================================
  // 박스 포장 -- 화면에 뜬 방향키 순서대로 누르고, 마지막은 스페이스바(테이프)
  // ======================================================================
  var PACK_LEN = [4, 6, 8]; // 방향키 개수 (+ 마지막 스페이스)
  var DIRS = ["up", "down", "left", "right"];
  var GLYPH = { up: "↑", down: "↓", left: "←", right: "→" };

  function packGame(body, c) {
    var len = PACK_LEN[c.level - 1];
    var seq = [];
    while (seq.length < len) {
      var d = DIRS[rand(4)], n = seq.length;
      if (n >= 2 && seq[n - 1] === d && seq[n - 2] === d) continue; // 같은 키 3연속은 지루하니 제외
      seq.push(d);
    }
    body.setAttribute("data-seq", seq.join(","));

    var chipsHtml = seq.map(function (d) { return '<span class="mg-chip" data-k="' + d + '">' + GLYPH[d] + "</span>"; }).join("")
      + '<span class="mg-chip is-space" data-k="space">SPACE</span>';
    body.innerHTML =
      '<div class="mg-pack-stage"><div class="mg-box">'
      + '<div class="mg-box-inner"></div>'
      + '<div class="mg-flap mg-flap-up" data-flap="up"></div><div class="mg-flap mg-flap-down" data-flap="down"></div>'
      + '<div class="mg-flap mg-flap-left" data-flap="left"></div><div class="mg-flap mg-flap-right" data-flap="right"></div>'
      + '<div class="mg-tape">TAPE</div></div></div>'
      + '<p class="mg-freeze-note"></p>'
      + '<div class="mg-seq">' + chipsHtml + "</div>"
      + '<div class="mg-pad">'
      + '<button type="button" class="mg-key" data-k="up" aria-label="위">↑</button>'
      + '<button type="button" class="mg-key" data-k="left" aria-label="왼쪽">←</button>'
      + '<button type="button" class="mg-key" data-k="down" aria-label="아래">↓</button>'
      + '<button type="button" class="mg-key" data-k="right" aria-label="오른쪽">→</button>'
      + '<button type="button" class="mg-key" data-k="space" aria-label="스페이스">SPACE · 테이프</button>'
      + "</div>";

    var box = body.querySelector(".mg-box");
    var tape = body.querySelector(".mg-tape");
    var note = body.querySelector(".mg-freeze-note");
    var chips = Array.prototype.slice.call(body.querySelectorAll(".mg-chip"));
    var flaps = {};
    Array.prototype.forEach.call(body.querySelectorAll(".mg-flap"), function (f) { flaps[f.getAttribute("data-flap")] = f; });
    var idx = 0, locked = false;

    function paint() {
      chips.forEach(function (ch, i) {
        ch.classList.toggle("is-done", i < idx);
        ch.classList.toggle("is-current", i === idx);
        ch.classList.remove("is-bad");
      });
    }
    function reopenAll() {
      Object.keys(flaps).forEach(function (k) { flaps[k].classList.remove("is-closed"); });
      tape.classList.remove("is-on");
    }

    function press(k) {
      if (locked || c.isFinished()) return;
      var want = idx < len ? seq[idx] : "space";
      if (k === want) {
        if (idx < len) {
          flaps[k].classList.add("is-closed");
          restartAnim(flaps[k], "is-pop");
        } else {
          // 테이프를 붙이는 순간 아직 열려 있던 덮개도 같이 닫혀야 "봉해진 상자"로 보인다
          Object.keys(flaps).forEach(function (k) { flaps[k].classList.add("is-closed"); });
          tape.classList.add("is-on");
        }
        idx++;
        paint();
        if (idx === len + 1) c.later(c.finish, 280);
        return;
      }
      // ---- 오입력 ----
      c.addMistake();
      restartAnim(box, "is-shake");
      var cur = chips[idx]; if (cur) { cur.classList.add("is-bad"); }
      var rule = config.mistakeRule;
      if (rule === "reset") {
        idx = 0;
        reopenAll();
        note.textContent = "틀렸어요 — 처음부터!";
        c.later(function () { note.textContent = ""; }, 900);
        c.later(paint, 160);
      } else if (rule === "freeze") {
        locked = true;
        note.textContent = "잠깐 멈춤 (0.5초)";
        c.later(function () { locked = false; note.textContent = ""; paint(); }, 500);
      } else { // ignore
        c.later(paint, 160);
      }
    }

    function onKey(e) {
      if (e.repeat || c.isFinished()) return;
      var k = null;
      if (e.key === "ArrowUp") k = "up";
      else if (e.key === "ArrowDown") k = "down";
      else if (e.key === "ArrowLeft") k = "left";
      else if (e.key === "ArrowRight") k = "right";
      else if (e.code === "Space" || e.key === " ") k = "space";
      if (!k) return;
      e.preventDefault();
      e.stopPropagation(); // 게임 본체의 전역 스페이스바/방향키 핸들러가 이 키를 따로 처리하지 않게 막는다
      press(k);
    }
    document.addEventListener("keydown", onKey, true);
    c.onCleanup(function () { document.removeEventListener("keydown", onKey, true); });

    Array.prototype.forEach.call(body.querySelectorAll(".mg-key"), function (b) {
      b.addEventListener("pointerdown", function (e) { e.preventDefault(); press(b.getAttribute("data-k")); });
    });
    paint();
    return {
      hint: function () {
        var r = config.mistakeRule;
        return "화면에 뜬 순서대로 방향키를 누르고, 마지막은 스페이스바로 테이프를 붙이세요. "
          + (r === "reset" ? "한 번 틀리면 처음부터 다시 해야 해요." : r === "freeze" ? "틀리면 0.5초 멈춰요." : "틀린 키는 무시돼요.");
      },
    };
  }

  // ======================================================================
  // 불량 검수 -- 상자들 중 깨지거나 찌그러진 것을 전부 찾아 클릭
  // ======================================================================
  var INSPECT_CFG = [
    { cols: 3, rows: 3, defects: 2, crack: 3.4, dent: 0.42, decoy: 0 },
    { cols: 4, rows: 3, defects: 3, crack: 2.4, dent: 0.3, decoy: 0.3 },
    { cols: 5, rows: 4, defects: 4, crack: 1.7, dent: 0.2, decoy: 0.4 },
  ];
  var TONES = [["#c9a576", "#ddc08f"], ["#c19a68", "#d6b684"], ["#d2b183", "#e4c99c"]];

  function boxSvg(isDefect, cfg) {
    var tone = TONES[rand(TONES.length)];
    var tapeX = 20 + rand(46);
    var lx = 56 + rand(8), ly = 58 + rand(5);
    var s = '<svg viewBox="0 0 100 100" aria-hidden="true">'
      + '<ellipse cx="50" cy="88" rx="34" ry="5" fill="rgba(43,29,18,.18)"/>'
      + '<rect x="14" y="30" width="72" height="54" rx="3" fill="' + tone[0] + '" stroke="#7a5a30" stroke-width="1.6"/>'
      + '<rect x="14" y="30" width="72" height="12" rx="3" fill="' + tone[1] + '" stroke="#7a5a30" stroke-width="1.6"/>'
      + '<rect x="' + tapeX + '" y="30" width="12" height="26" fill="#ead8b0" opacity=".92"/>'
      + '<rect x="' + lx + '" y="' + ly + '" width="22" height="14" rx="1.5" fill="#fffcf4" stroke="#8a7256" stroke-width="1"/>'
      + '<path d="M' + (lx + 3) + ' ' + (ly + 4) + 'h16M' + (lx + 3) + ' ' + (ly + 8) + 'h11M' + (lx + 3) + ' ' + (ly + 11) + 'h14" stroke="#8a7256" stroke-width="1" fill="none"/>';
    if (isDefect) {
      var cx = 22 + rand(52), corner = rand(4);
      s += '<path d="M' + cx + ' 30 l5 9 l-7 8 l6 9 l-4 7" stroke="#4a2d12" stroke-width="' + cfg.crack + '" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
      var dent = [
        "14,30 32,30 14,48", "86,30 68,30 86,48", "14,84 32,84 14,66", "86,84 68,84 86,66",
      ][corner];
      s += '<polygon points="' + dent + '" fill="rgba(60,35,10,' + cfg.dent + ')"/>';
    } else if (cfg.decoy && Math.random() < cfg.decoy) {
      // 멀쩡한 상자에도 가벼운 스크래치를 넣어서 "선 하나 있으면 불량"으로 찍지 못하게 한다
      var sy = 50 + rand(24), sx = 20 + rand(40);
      s += '<path d="M' + sx + ' ' + sy + 'h' + (8 + rand(8)) + '" stroke="rgba(74,45,18,.38)" stroke-width="1.1" stroke-linecap="round" fill="none"/>';
    }
    return s + "</svg>";
  }

  function inspectGame(body, c) {
    var cfg = INSPECT_CFG[c.level - 1];
    var total = cfg.cols * cfg.rows;
    var defectSet = {};
    shuffle(Array.apply(null, { length: total }).map(function (_, i) { return i; }))
      .slice(0, cfg.defects).forEach(function (i) { defectSet[i] = true; });
    var found = 0, locked = false;

    body.innerHTML = '<p class="mg-progress">파손된 상자 <em class="mg-found">0</em> / ' + cfg.defects + "개 찾음</p>"
      + '<div class="mg-grid" style="--cols:' + cfg.cols + '"></div>';
    var grid = body.querySelector(".mg-grid");
    var foundEl = body.querySelector(".mg-found");

    for (var i = 0; i < total; i++) {
      (function (i) {
        var t = el("button", "mg-tile", boxSvg(!!defectSet[i], cfg));
        t.type = "button";
        t.setAttribute("aria-label", "상자 " + (i + 1));
        if (c.testHooks && defectSet[i]) t.setAttribute("data-defect", "1");
        t.addEventListener("click", function () {
          if (locked || c.isFinished() || t.classList.contains("is-found")) return;
          if (defectSet[i]) {
            t.classList.add("is-found");
            found++;
            foundEl.textContent = found;
            if (found === cfg.defects) c.later(c.finish, 320);
          } else {
            c.addMistake();
            locked = true;
            grid.classList.add("is-locked");
            restartAnim(t, "is-wrong");
            c.later(function () { t.classList.remove("is-wrong"); locked = false; grid.classList.remove("is-locked"); }, 600);
          }
        });
        grid.appendChild(t);
      })(i);
    }
    return { hint: function () { return "깨지거나 찌그러진 상자를 전부 찾아 클릭하세요. 멀쩡한 상자를 누르면 잠깐 멈춰요."; } };
  }

  // ======================================================================
  // 송장 붙이기 -- 송장을 끌어다 점선 안에 쏙 들어가게 붙이기
  // ======================================================================
  // 모든 좌표/크기는 스테이지(520:320) 대비 % -- 화면 크기가 달라도 같은 판정이 된다.
  var LW = 22, LH = 18;                                   // 송장 크기
  var SLACK = [[10, 7], [6, 5], [4, 3.5]];                // 점선 칸이 송장보다 얼마나 더 큰가(여유) -- 작을수록 어렵다
  var STRIPS = [[5, 33], [45.5, 73]];                     // 박스 윗면에서 테이프 위/아래의 쓸 수 있는 세로 구간(%)
  var HALVES = [[5, 50], [50, 95]];                       // 가로 구간(%)

  function sampleRoom() {
    var floors = ["B1", "1F", "2F", "3F", "4F", "5F"];
    var f = floors[rand(floors.length)];
    return (f === "B1" ? "B" : f.charAt(0)) + "0" + (1 + rand(9)) + "호";
  }

  function stickerGame(body, c) {
    var count = c.level;
    var TW = LW + SLACK[c.level - 1][0], TH = LH + SLACK[c.level - 1][1];
    var slots = shuffle([[0, 0], [0, 1], [1, 0], [1, 1]]).slice(0, count).map(function (s) {
      var strip = STRIPS[s[0]], half = HALVES[s[1]];
      var x0 = half[0] + 1.5, x1 = half[1] - TW - 1.5;
      var y0 = strip[0] + 1.5, y1 = strip[1] - TH - 1.5;
      return { x: x0 + Math.random() * Math.max(0, x1 - x0), y: y0 + Math.random() * Math.max(0, y1 - y0) };
    });

    body.innerHTML = '<div class="mg-stage"><div class="mg-parcel"></div><div class="mg-tray"></div>'
      + '<div class="mg-target"></div></div>';
    var stage = body.querySelector(".mg-stage");
    var target = body.querySelector(".mg-target");
    var placed = 0, current = null, dragging = false, grabDX = 0, grabDY = 0;
    var trayX = (100 - LW) / 2, trayY = 78;

    function showTarget() {
      var s = slots[placed];
      target.style.left = s.x + "%"; target.style.top = s.y + "%";
      target.style.width = TW + "%"; target.style.height = TH + "%";
      target.classList.add("is-on");
      if (c.testHooks) { target.setAttribute("data-tx", s.x); target.setAttribute("data-ty", s.y); }
    }
    function spawnLabel() {
      var room = (c.label || sampleRoom());
      var lb = el("div", "mg-label",
        '<div class="lb-bar"></div><div class="lb-main"><div class="lb-txt"><div class="lb-cap">받는 곳</div><div class="lb-room">' + room + '</div></div><div class="lb-code"></div></div>');
      lb.style.width = LW + "%"; lb.style.height = LH + "%";
      lb.style.left = trayX + "%"; lb.style.top = trayY + "%";
      lb.setAttribute("data-label", "1");
      stage.appendChild(lb);
      current = lb;
      lb.addEventListener("pointerdown", function (e) {
        if (c.isFinished() || lb !== current) return;
        e.preventDefault();
        lb.setPointerCapture(e.pointerId);
        var lr = lb.getBoundingClientRect();
        grabDX = e.clientX - lr.left; grabDY = e.clientY - lr.top;
        dragging = true;
        lb.classList.remove("is-return");
        lb.classList.add("is-drag");
      });
      lb.addEventListener("pointermove", function (e) {
        if (!dragging || lb !== current) return;
        var r = stage.getBoundingClientRect();
        lb.style.left = clamp((e.clientX - grabDX - r.left) / r.width * 100, -4, 104 - LW) + "%";
        lb.style.top = clamp((e.clientY - grabDY - r.top) / r.height * 100, -4, 104 - LH) + "%";
      });
      function drop() {
        if (!dragging || lb !== current) return;
        dragging = false;
        lb.classList.remove("is-drag");
        var lx = parseFloat(lb.style.left), ly = parseFloat(lb.style.top);
        var s = slots[placed];
        var inside = lx >= s.x && ly >= s.y && lx + LW <= s.x + TW && ly + LH <= s.y + TH;
        if (inside) {
          lb.style.left = (s.x + (TW - LW) / 2) + "%";
          lb.style.top = (s.y + (TH - LH) / 2) + "%";
          lb.classList.add("is-stuck");
          lb.setAttribute("data-stuck", "1");
          target.classList.remove("is-on");
          placed++;
          current = null;
          if (placed === count) { c.later(c.finish, 280); }
          else { c.later(function () { showTarget(); spawnLabel(); }, 260); }
          return;
        }
        // 박스 윗면 위에서 놓쳤으면 실수, 트레이 근처에서 그냥 놓은 건 실수 아님
        if (ly + LH / 2 < 73) { c.addMistake(); restartAnim(lb, "mg-shake"); }
        lb.classList.add("is-return");
        lb.style.left = trayX + "%"; lb.style.top = trayY + "%";
      }
      lb.addEventListener("pointerup", drop);
      lb.addEventListener("pointercancel", drop);
    }

    showTarget();
    spawnLabel();
    return { hint: function () { return "송장을 끌어다 점선 안에 쏙 들어가게 놓으세요. 송장 전체가 점선 안에 들어와야 붙어요" + (count > 1 ? " (" + count + "장)." : "."); } };
  }

  var GAMES = { pack: packGame, inspect: inspectGame, sticker: stickerGame };

  // ======================================================================
  // 공통 진행: 헤더(제목/시간/실수/포기), 타이머, 완료 배너, 정리
  // ======================================================================
  function start(host, opts) {
    opts = opts || {};
    var kind = GAMES[opts.kind] ? opts.kind : "pack";
    var level = clamp(parseInt(opts.level, 10) || 1, 1, 3);

    var rootEl = el("div", "mg-root mg-kind-" + kind);
    rootEl.innerHTML =
      '<header class="mg-head"><div class="mg-title"><span class="mg-name">' + KINDS[kind].name + '</span>'
      + '<span class="mg-level">난이도 ' + LEVEL_NAME[level - 1] + '</span></div>'
      + '<div class="mg-stats"><span class="mg-time">0.0초</span><span class="mg-miss">실수 0</span></div>'
      + '<button type="button" class="mg-giveup">포기</button></header>'
      + '<div class="mg-body"></div><p class="mg-hint"></p>'
      + '<div class="mg-done"><b>완료!</b></div>';
    host.innerHTML = "";
    host.appendChild(rootEl);
    var body = rootEl.querySelector(".mg-body");
    var doneEl = rootEl.querySelector(".mg-done");
    var timeEl = rootEl.querySelector(".mg-time");
    var missEl = rootEl.querySelector(".mg-miss");

    var t0 = performance.now(), mistakes = 0, finished = false, destroyed = false;
    var timers = [], cleanups = [];
    var tick = setInterval(function () { if (!finished) timeEl.textContent = fmtSec(performance.now() - t0); }, 100);

    var ctx = {
      level: level, label: opts.label, testHooks: !!opts.testHooks,
      isFinished: function () { return finished || destroyed; },
      later: function (fn, ms) {
        var id = setTimeout(function () { if (!destroyed) fn(); }, ms);
        timers.push(id);
        return id;
      },
      onCleanup: function (fn) { cleanups.push(fn); },
      addMistake: function () {
        mistakes++;
        missEl.textContent = "실수 " + mistakes;
        missEl.classList.add("has-miss");
      },
      finish: function () {
        if (finished || destroyed) return;
        finished = true;
        var ms = Math.round(performance.now() - t0);
        timeEl.textContent = fmtSec(ms);
        doneEl.querySelector("b").textContent = "완료! " + fmtSec(ms);
        doneEl.classList.add("is-on");
        ctx.later(function () {
          if (opts.onDone) opts.onDone({ ok: true, kind: kind, level: level, ms: ms, mistakes: mistakes });
        }, 700);
      },
    };

    var game = GAMES[kind](body, ctx);
    rootEl.querySelector(".mg-hint").textContent = game.hint();
    rootEl.querySelector(".mg-giveup").addEventListener("click", function () {
      if (finished || destroyed) return;
      if (opts.onCancel) opts.onCancel();
    });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(tick);
      timers.forEach(clearTimeout);
      cleanups.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }
    return { destroy: destroy, root: rootEl };
  }

  root.MiniGames = {
    start: start,
    KINDS: KINDS,
    LEVEL_NAME: LEVEL_NAME,
    setMistakeRule: function (rule) { if (rule === "reset" || rule === "freeze" || rule === "ignore") config.mistakeRule = rule; },
    getMistakeRule: function () { return config.mistakeRule; },
  };
})(typeof window !== "undefined" ? window : this);
