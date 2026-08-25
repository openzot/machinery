/* Dunlin Sentinel — Saturation Control Console
   Nordsea Engineering Ltd., Aberdeen, 1983.
   Simulation of a saturation diving complex's life-support panel:
   heliox make-up from quad banks, oxygen injection, CO2 scrubbing,
   chamber depth control. Classic script, no dependencies. */
(function () {
  "use strict";

  /* ============================ constants ============================ */

  var TICK_STEP = 0.1; // simulated seconds per integration step
  var MAX_DEPTH = 140; // mSW hard stop
  var O2_MIN = 12,
    O2_MAX = 32; // bargraph ends, %
  var O2_LO = 16,
    O2_HI = 25; // alarm band, %
  var CO2_HI = 30,
    CO2_TRIP = 50; // mbar surface equivalent
  var BANK_LOW = 40; // bar, SUPPLY LOW threshold
  var O2CYL_LOW = 50; // bar

  var FAULTS = [
    "scrubber fan stall",
    "quad bank depletion",
    "make-up valve passing",
  ];

  /* ============================ state ============================ */

  var S;

  function coldState() {
    return {
      t: 0,
      powered: true,
      depth: 0,
      depthSet: 0,
      ppO2: 21.0,
      ppCO2: 4,
      tempC: 12,
      banks: [212, 198, 224, 186], // bar, banks A..D
      quadPos: 0, // index into banks
      o2Bar: 178,
      o2Turns: 0,
      ventTurns: 0,
      fanPos: 0, // 0 off, 1 low, 2 high, 3 standby
      mkupAuto: true, // isolator lined up AUTO; controller holds shut
      bypassHeld: false,
      // fault flags
      fFans: false,
      fQuads: false,
      fMkup: false,
      // trips
      tripped: false,
      tripCause: "",
      tripTimerCo2: 0,
      tripTimerO2lo: 0,
      tripTimerO2hi: 0,
      // last-step flows for display
      makeupFlow: 0,
      ventFlow: 0,
      scrubRate: 0,
    };
  }

  /* ======================= derived quantities ======================= */

  function supplyBar() {
    return S.banks[S.quadPos];
  }

  function scrubbing() {
    // mbar of CO2 removed per second
    if (!S.powered) return 0;
    // a standing trip drops the duty contactors; the standby train,
    // on its own feeders, is exactly what you go to next
    if (S.tripped && S.fanPos !== 3) return 0;
    if (S.fanPos === 1) return S.fFans ? 0 : 0.04; // duty fans stalled?
    if (S.fanPos === 2) return S.fFans ? 0 : 0.07;
    if (S.fanPos === 3) return 0.05; // standby train is healthy
    return 0;
  }

  function makeupAvailable() {
    return S.powered && !S.tripped && supplyBar() > 4;
  }

  function computeFlows() {
    // metres per second of depth change contributions
    var mk = 0;
    if (S.fMkup && S.mkupAuto && supplyBar() > 2) {
      mk += 0.075; // the auto valve passes its seat
    }
    if (S.mkupAuto && makeupAvailable()) {
      var err = S.depthSet - S.depth;
      if (err > 0.05) mk += Math.min(0.32, err * 0.05);
    }
    if (S.bypassHeld && makeupAvailable()) mk += 0.26;
    var vent = S.ventTurns * 0.11;
    var drift = S.depth > 2 ? -0.0022 : 0; // contraction, absorption
    return { makeup: mk, vent: vent, net: mk - vent + drift };
  }

  /* ============================ the tick ============================ */

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return;
    var remaining = Math.min(seconds, 120);
    while (remaining > 0) {
      var dt = Math.min(TICK_STEP, remaining);
      remaining -= dt;
      step(dt);
    }
    clampAll();
  }

  function step(dt) {
    S.t += dt;
    var fl = computeFlows();

    // ---- depth ----
    S.depth += fl.net * dt;
    if (S.depth < 0) S.depth = 0;
    if (S.depth > MAX_DEPTH) S.depth = MAX_DEPTH;

    // ---- gas drawn against the selected quad bank ----
    if (fl.makeup > 0 && supplyBar() > 0) {
      S.banks[S.quadPos] -= fl.makeup * dt * 0.55; // bar per metre supplied
    }
    if (S.fQuads && supplyBar() > 0) {
      S.banks[S.quadPos] -= 4.2 * dt; // the bank is running away
    }
    if (S.banks[S.quadPos] < 0) S.banks[S.quadPos] = 0;

    // ---- oxygen partial pressure ----
    if (S.o2Turns > 0 && S.o2Bar > 0) {
      S.ppO2 += S.o2Turns * 0.0062 * dt;
      S.o2Bar -= S.o2Turns * 0.014 * dt;
      if (S.o2Bar < 0) S.o2Bar = 0;
    }
    var ventEff = Math.min(S.ventTurns * 0.11, 0.55) * (S.depth > 10 ? 1 : 0);
    S.ppCO2 = Math.max(0, S.ppCO2 - ventEff * 1.8 * dt);
    S.ppO2 -= 0.00085 * dt; // two men on the bench
    S.ppO2 -= ventEff * 0.12 * dt; // fresh heliox carries no oxygen

    // ---- carbon dioxide ----
    var co2Prod = 0.034; // mbar/s surface equiv.
    S.scrubRate = scrubbing();
    S.ppCO2 += (co2Prod - S.scrubRate) * dt;
    if (S.ppCO2 < 0) S.ppCO2 = 0;

    // ---- temperature follows compression and scrubbers ----
    var heat = fl.makeup * 14 + S.scrubRate * 160 - 0.55 * (S.tempC - 12);
    S.tempC += heat * dt;

    // ---- trip timers: ignoring an alarm has a consequence ----
    S.tripTimerCo2 = S.ppCO2 >= CO2_TRIP ? S.tripTimerCo2 + dt : 0;
    S.tripTimerO2lo = S.ppO2 <= 13 ? S.tripTimerO2lo + dt : 0;
    S.tripTimerO2hi = S.ppO2 >= 31 ? S.tripTimerO2hi + dt : 0;
    if (!S.tripped) {
      if (S.tripTimerCo2 >= 60) {
        S.tripped = true;
        S.tripCause = "CO2";
      } else if (S.tripTimerO2lo >= 45) {
        S.tripped = true;
        S.tripCause = "O2 LOW";
      } else if (S.tripTimerO2hi >= 45) {
        S.tripped = true;
        S.tripCause = "O2 TOXICITY";
      }
    } else {
      S.tripTimerCo2 = 0;
      S.tripTimerO2lo = 0;
      S.tripTimerO2hi = 0;
    }

    S.makeupFlow = fl.makeup;
    S.ventFlow = fl.vent;
  }

  function clampAll() {
    var keys = [
      "depth",
      "depthSet",
      "ppO2",
      "ppCO2",
      "tempC",
      "o2Bar",
      "o2Turns",
      "ventTurns",
      "makeupFlow",
      "ventFlow",
      "scrubRate",
    ];
    var i;
    for (i = 0; i < keys.length; i++) {
      if (!isFinite(S[keys[i]])) S[keys[i]] = 0;
    }
    for (i = 0; i < 4; i++) if (!isFinite(S.banks[i])) S.banks[i] = 0;
    S.ppO2 = Math.max(O2_MIN - 2, Math.min(O2_MAX + 2, S.ppO2));
    S.ppCO2 = Math.max(0, Math.min(80, S.ppCO2));
    S.tempC = Math.max(4, Math.min(44, S.tempC));
    S.depth = Math.max(0, Math.min(MAX_DEPTH, S.depth));
    S.o2Bar = Math.max(0, Math.min(250, S.o2Bar));
    S.banks[0] = Math.max(0, Math.min(300, S.banks[0]));
    S.banks[1] = Math.max(0, Math.min(300, S.banks[1]));
    S.banks[2] = Math.max(0, Math.min(300, S.banks[2]));
    S.banks[3] = Math.max(0, Math.min(300, S.banks[3]));
    S.t = Math.max(0, Math.min(1e9, S.t));
  }

  /* ============================ alarms ============================ */

  function activeAlarms() {
    var a = [];
    if (!S.powered) return a;
    if (S.ppO2 > O2_HI) a.push("PP O2 HIGH");
    if (S.ppO2 < O2_LO) a.push("PP O2 LOW");
    if (S.ppCO2 >= CO2_HI) a.push("CO2 HIGH");
    if (Math.abs(S.depth - S.depthSet) > 3) a.push("DEPTH DEV.");
    if (supplyBar() < BANK_LOW) a.push("SUPPLY LOW");
    if (S.fFans) a.push("FAN FAIL"); // duty-train monitor
    if (S.o2Bar < O2CYL_LOW) a.push("O2 CYL LOW");
    if (S.fMkup && S.mkupAuto) a.push("MK-UP PASSING");
    return a;
  }

  /* ====================== public fixed API ====================== */

  var uiReady = false;

  var machine = {
    name: "Dunlin Sentinel Saturation Control",
    faults: FAULTS.slice(),
    state: function () {
      return {
        t: round2(S.t),
        powered: S.powered,
        depth: round2(S.depth),
        depthSet: round2(S.depthSet),
        ppO2: round3(S.ppO2),
        ppCO2: round2(S.ppCO2),
        tempC: round2(S.tempC),
        banks: [
          round1(S.banks[0]),
          round1(S.banks[1]),
          round1(S.banks[2]),
          round1(S.banks[3]),
        ],
        selectedBank: ["A", "B", "C", "D"][S.quadPos],
        o2Bar: round1(S.o2Bar),
        o2Turns: round2(S.o2Turns),
        ventTurns: round2(S.ventTurns),
        fanPos: S.fanPos,
        mkupAuto: S.mkupAuto,
        makeupFlow: round3(S.makeupFlow),
        ventFlow: round3(S.ventFlow),
        scrubRate: round4(S.scrubRate),
        tripped: S.tripped,
        tripCause: S.tripCause,
        alarms: activeAlarms(),
        faults: [
          S.fFans && "scrubber fan stall",
          S.fQuads && "quad bank depletion",
          S.fMkup && "make-up valve passing",
        ].filter(Boolean),
      };
    },
    tick: tick,
    inject: function (fault) {
      var f = norm(fault);
      if (f === "scrubber fan stall") S.fFans = true;
      else if (f === "quad bank depletion") S.fQuads = true;
      else if (f === "make-up valve passing") S.fMkup = true;
    },
    reset: function () {
      S = coldState();
      if (uiReady) ui.syncAll();
    },
  };
  window.machine = machine;

  function norm(s) {
    return String(s == null ? "" : s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }
  function round1(v) {
    return Math.round(v * 10) / 10;
  }
  function round2(v) {
    return Math.round(v * 100) / 100;
  }
  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }
  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  /* ============================ UI wiring ============================ */

  var ui = { ready: false };

  function $(sel) {
    return document.querySelector(sel);
  }
  function $all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  /* ---- generic rotary knob: drag, wheel, arrows ---- */
  function knob(el, opts) {
    var value = opts.value;
    function setAngle() {
      var frac = opts.angleMap(value);
      el.style.setProperty("--angle", frac.toFixed(1) + "deg");
      el.setAttribute("aria-valuenow", String(Math.round(value * 100) / 100));
      el.setAttribute("aria-valuetext", opts.text(value));
    }
    function commit(v, silent) {
      v = Math.max(opts.min, Math.min(opts.max, v));
      if (opts.snap) v = Math.round(v);
      if (v === value) return;
      value = v;
      setAngle();
      if (!silent) {
        opts.onChange(value);
        audio.gesture();
      }
    }
    el.addEventListener("keydown", function (e) {
      var stepv = (e.shiftKey ? (opts.max - opts.min) / 8 : opts.keyStep) || 1;
      var handled = true;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") commit(value + stepv);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
        commit(value - stepv);
      else if (e.key === "PageUp") commit(value + stepv * 4);
      else if (e.key === "PageDown") commit(value - stepv * 4);
      else if (e.key === "Home") commit(opts.min);
      else if (e.key === "End") commit(opts.max);
      else handled = false;
      if (handled) e.preventDefault();
    });
    el.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        commit(value + (e.deltaY < 0 ? 1 : -1) * opts.keyStep);
      },
      { passive: false },
    );
    var dragging = false,
      lastY = 0;
    el.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastY = e.clientY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dy = lastY - e.clientY;
      lastY = e.clientY;
      commit(value + dy * opts.dragStep);
    });
    function endDrag() {
      dragging = false;
    }
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    setAngle();
    return {
      get: function () {
        return value;
      },
      set: function (v, silent) {
        commit(v, silent);
      },
    };
  }

  /* ---- dial scale drawing (SVG ticks generated once) ---- */
  function pt(cx, cy, r, deg) {
    var rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  var DIALS = {
    bankA: { cx: 50, cy: 54, r: 36, min: 0, max: 300, sweep: 115, major: 50 },
    bankB: { cx: 50, cy: 54, r: 36, min: 0, max: 300, sweep: 115, major: 50 },
    bankC: { cx: 50, cy: 54, r: 36, min: 0, max: 300, sweep: 115, major: 50 },
    bankD: { cx: 50, cy: 54, r: 36, min: 0, max: 300, sweep: 115, major: 50 },
    temp: { cx: 50, cy: 54, r: 36, min: 0, max: 40, sweep: 115, major: 10 },
    o2cyl: { cx: 100, cy: 96, r: 72, min: 0, max: 250, sweep: 88, major: 50 },
    ppco2: { cx: 120, cy: 116, r: 82, min: 0, max: 60, sweep: 78, arc: true },
    depth: {
      cx: 110,
      cy: 112,
      r: 88,
      min: 0,
      max: 120,
      sweep: 118,
      major: 10,
      minor: 5,
    },
  };

  function buildScale(name) {
    var fig = document.querySelector('[data-dial="' + name + '"]');
    if (!fig) return null;
    var g = fig.querySelector("g.scale");
    var cfg = DIALS[name];
    if (!g || !cfg) return null;
    var ns = "http://www.w3.org/2000/svg";
    var span = cfg.sweep * 2;
    var minor = cfg.minor || cfg.major / 2 || cfg.max / 24;
    var major = cfg.major || cfg.max / 6;
    var v;
    for (v = cfg.min; v <= cfg.max + 0.001; v += minor) {
      var isMajor = Math.abs(v / major - Math.round(v / major)) < 0.001;
      var deg = -cfg.sweep + ((v - cfg.min) / (cfg.max - cfg.min)) * span;
      var p1 = pt(cfg.cx, cfg.cy, cfg.r, deg);
      var p2 = pt(cfg.cx, cfg.cy, cfg.r - (isMajor ? 9 : 5), deg);
      var ln = document.createElementNS(ns, "line");
      ln.setAttribute("x1", p1[0].toFixed(1));
      ln.setAttribute("y1", p1[1].toFixed(1));
      ln.setAttribute("x2", p2[0].toFixed(1));
      ln.setAttribute("y2", p2[1].toFixed(1));
      if (isMajor) ln.setAttribute("class", "major");
      g.appendChild(ln);
      if (isMajor && cfg.arc !== true) {
        var tp = pt(cfg.cx, cfg.cy, cfg.r - 17, deg);
        var tx = document.createElementNS(ns, "text");
        tx.setAttribute("x", tp[0].toFixed(1));
        tx.setAttribute("y", tp[1].toFixed(1));
        tx.textContent = String(Math.round(v));
        g.appendChild(tx);
      }
    }
    if (name === "ppco2") {
      for (v = 0; v <= 60; v += 10) {
        var degc = -cfg.sweep + (v / 60) * span;
        var tpc = pt(cfg.cx, cfg.cy, cfg.r - 19, degc);
        var tc = document.createElementNS(ns, "text");
        tc.setAttribute("x", tpc[0].toFixed(1));
        tc.setAttribute("y", tpc[1].toFixed(1));
        tc.textContent = String(v);
        g.appendChild(tc);
      }
      var a1 = -cfg.sweep + (50 / 60) * span,
        a2 = -cfg.sweep + (60 / 60) * span;
      var pA = pt(cfg.cx, cfg.cy, cfg.r - 2, a1),
        pB = pt(cfg.cx, cfg.cy, cfg.r - 2, a2);
      var large = a2 - a1 > 180 ? 1 : 0;
      var red = fig.querySelector(".redarc");
      if (red) {
        red.setAttribute(
          "d",
          "M " +
            pA[0].toFixed(1) +
            " " +
            pA[1].toFixed(1) +
            " A " +
            (cfg.r - 2) +
            " " +
            (cfg.r - 2) +
            " 0 " +
            large +
            " 1 " +
            pB[0].toFixed(1) +
            " " +
            pB[1].toFixed(1),
        );
      }
    }
    var needle = fig.querySelector(".needle");
    var ghost = fig.querySelector(".ghost");
    if (needle) needle.style.transformOrigin = cfg.cx + "px " + cfg.cy + "px";
    if (ghost) ghost.style.transformOrigin = cfg.cx + "px " + cfg.cy + "px";
    return {
      set: function (val) {
        var frac = Math.max(
          0,
          Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)),
        );
        var deg = -cfg.sweep + frac * span;
        if (needle)
          needle.style.transform = "rotate(" + deg.toFixed(2) + "deg)";
      },
      setGhost: function (val) {
        if (!ghost) return;
        var frac = Math.max(
          0,
          Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)),
        );
        var deg = -cfg.sweep + frac * span;
        ghost.style.transform = "rotate(" + deg.toFixed(2) + "deg)";
      },
    };
  }

  var dialRefs = {};

  /* ---- annunciator bookkeeping ---- */
  var acked = {};
  var lampEls = {};
  var LAMP_NAMES = {
    o2high: "PP O2 HIGH",
    o2low: "PP O2 LOW",
    co2high: "CO2 HIGH",
    depthdev: "DEPTH DEV.",
    supplylow: "SUPPLY LOW",
    fanfail: "FAN FAIL",
    o2cyllow: "O2 CYL LOW",
    mkuppass: "MK-UP PASSING",
  };

  /* ---- CCTV: chamber interior, monochrome closed-circuit picture ---- */
  var cctv = $("#cctv");
  var cctvCtx = cctv ? cctv.getContext("2d") : null;
  var cctvPhase = 0;

  function drawCCTV(dtFrame) {
    if (!cctvCtx) return;
    var w = cctv.width,
      h = cctv.height;
    cctvPhase += dtFrame;
    var ctx = cctvCtx;
    var lit = S.powered;
    ctx.fillStyle = lit ? "#39413b" : "#05060a";
    ctx.fillRect(0, 0, w, h);
    var i;
    if (lit) {
      ctx.fillStyle = "#2f3730";
      ctx.fillRect(0, 0, w, 26);
      ctx.fillStyle = "#333c34";
      for (i = 8; i < w; i += 34) ctx.fillRect(i, 26, 2, h - 26);
      ctx.fillStyle = "#232a24";
      ctx.fillRect(0, h - 34, w, 12);
      var slump = S.ppO2 < 14 || S.ppCO2 > 55 || S.tripped;
      drawDiver(ctx, w * 0.34, h - 34, slump, 0);
      drawDiver(ctx, w * 0.66, h - 34, slump, 1.7);
      if (S.tempC > 24) {
        ctx.fillStyle = "rgba(220,230,225,0.05)";
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      ctx.fillStyle = "#10151a";
      ctx.font = "9px monospace";
      ctx.fillText("NO SIGNAL", w / 2 - 26, h / 2);
    }
    for (i = 0; i < 130; i++) {
      var sx = (Math.sin(i * 127.1 + cctvPhase * 13.7) * 0.5 + 0.5) * w;
      var sy = (Math.sin(i * 311.7 + cctvPhase * 7.3) * 0.5 + 0.5) * h;
      ctx.fillStyle =
        "rgba(200,215,205," +
        (0.03 + 0.05 * Math.abs(Math.sin(i + cctvPhase))).toFixed(3) +
        ")";
      ctx.fillRect(sx, sy, 1.4, 1.4);
    }
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    for (i = 0; i < h; i += 3)
      ctx.fillRect(0, i + ((cctvPhase * 14) % 3), w, 1);
    var gr = ctx.createRadialGradient(
      w / 2,
      h / 2,
      h / 3,
      w / 2,
      h / 2,
      w / 1.4,
    );
    gr.addColorStop(0, "rgba(0,0,0,0)");
    gr.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);
  }

  function drawDiver(ctx, x, floorY, slump, seedphase) {
    var bob = Math.sin(cctvPhase * 1.1 + seedphase) * (slump ? 0.4 : 1.4);
    ctx.save();
    ctx.translate(x, bob * 0.4);
    ctx.fillStyle = "#141a16";
    if (slump) {
      ctx.beginPath();
      ctx.ellipse(0, -12, 13, 10, 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-14, -10, 26, 12);
    } else {
      ctx.beginPath();
      ctx.arc(0, -38, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#c8cdc4";
      ctx.beginPath();
      ctx.arc(1.5, -38, 4.2, -0.9, 0.9);
      ctx.fill();
      ctx.fillStyle = "#141a16";
      ctx.fillRect(-9, -31, 18, 22);
      ctx.fillRect(-12, -12, 8, 12);
      ctx.fillRect(4, -12, 8, 12);
      ctx.fillStyle = "#101512";
      ctx.fillRect(-16, -27, 7, 14);
    }
    ctx.restore();
  }

  /* ---- sound: blower hum + alarm buzzer, gesture-gated ---- */
  var audio = (function () {
    var ctx = null,
      humGain = null,
      buzzGain = null,
      buzzing = false;
    function init() {
      if (ctx) {
        if (ctx.state === "suspended") {
          try {
            ctx.resume();
          } catch (e) {}
        }
        return;
      }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        humGain = ctx.createGain();
        humGain.gain.value = 0;
        var hum = ctx.createOscillator();
        hum.type = "triangle";
        hum.frequency.value = 92;
        var lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 240;
        hum.connect(lp);
        lp.connect(humGain);
        humGain.connect(ctx.destination);
        hum.start();
        buzzGain = ctx.createGain();
        buzzGain.gain.value = 0;
        var sq = ctx.createOscillator();
        sq.type = "square";
        sq.frequency.value = 620;
        sq.connect(buzzGain);
        buzzGain.connect(ctx.destination);
        sq.start();
      } catch (e) {
        ctx = null;
      }
    }
    document.addEventListener("pointerdown", init);
    document.addEventListener("keydown", init);
    return {
      gesture: init,
      frame: function (state) {
        if (!ctx) return;
        var targetHum = state.powered ? 0.01 : 0;
        if (state.fanPos > 0 && !state.tripped)
          targetHum += 0.012 * state.fanPos;
        humGain.gain.setTargetAtTime(targetHum, ctx.currentTime, 0.2);
        buzzGain.gain.setTargetAtTime(
          buzzing ? 0.025 : 0,
          ctx.currentTime,
          0.01,
        );
      },
      setBuzzer: function (on) {
        buzzing = !!on;
      },
    };
  })();

  /* ---- controls ---- */

  var K = {}; // knob refs

  function clearFault(fault) {
    var f = norm(fault);
    if (f === "scrubber fan stall") S.fFans = false;
    else if (f === "quad bank depletion") S.fQuads = false;
    else if (f === "make-up valve passing") S.fMkup = false;
  }

  function setupControls() {
    // QUAD SELECTOR A..D
    var quadLabels = ["Bank A", "Bank B", "Bank C", "Bank D"];
    K.quad = knob($("#quad-knob"), {
      min: 0,
      max: 3,
      value: 0,
      snap: true,
      keyStep: 1,
      dragStep: 0.03,
      angleMap: function (v) {
        return -45 + v * 30;
      },
      text: function (v) {
        return quadLabels[Math.round(v)];
      },
      onChange: function (v) {
        S.quadPos = Math.round(v);
        if (S.fQuads) S.fQuads = false; // healthy bank selected
        ui.readout.feeding.textContent = ["A", "B", "C", "D"][S.quadPos];
      },
    });

    // SCRUBBER FANS OFF/LOW/HIGH/STBY
    var fanLabels = ["Off", "Low", "High", "Standby fan"];
    K.fans = knob($("#fan-knob"), {
      min: 0,
      max: 3,
      value: 0,
      snap: true,
      keyStep: 1,
      dragStep: 0.03,
      angleMap: function (v) {
        return -45 + v * 30;
      },
      text: function (v) {
        return fanLabels[Math.round(v)];
      },
      onChange: function (v) {
        S.fanPos = Math.round(v);
        if (S.fanPos === 3) S.fFans = false; // standby fan takes duty
      },
    });

    // DEPTH SET 0..120
    K.set = knob($("#setdepth-knob"), {
      min: 0,
      max: 120,
      value: 0,
      snap: false,
      keyStep: 2,
      dragStep: 0.6,
      angleMap: function (v) {
        return -135 + (v / 120) * 270;
      },
      text: function (v) {
        return Math.round(v) + " metres";
      },
      onChange: function (v) {
        S.depthSet = v;
      },
    });

    // O2 INJECT micrometer 0..8 turns
    K.o2 = knob($("#o2-knob"), {
      min: 0,
      max: 8,
      value: 0,
      snap: false,
      keyStep: 0.25,
      dragStep: 0.02,
      angleMap: function (v) {
        return v * 160;
      },
      text: function (v) {
        return v.toFixed(2) + " turns open";
      },
      onChange: function (v) {
        S.o2Turns = v;
      },
    });

    // CHAMBER VENT 0..10 turns
    K.vent = knob($("#vent-knob"), {
      min: 0,
      max: 10,
      value: 0,
      snap: false,
      keyStep: 0.25,
      dragStep: 0.025,
      angleMap: function (v) {
        return v * 130;
      },
      text: function (v) {
        return v.toFixed(2) + " turns open";
      },
      onChange: function (v) {
        S.ventTurns = v;
      },
    });

    // MAINS keyswitch
    var mains = $("#mains-key");
    function toggleMains(state) {
      var on =
        state !== undefined
          ? state
          : mains.getAttribute("aria-checked") !== "true";
      mains.setAttribute("aria-checked", on ? "true" : "false");
      S.powered = on;
      document.body.classList.toggle("is-powered", on);
      audio.gesture();
    }
    mains.addEventListener("click", function () {
      toggleMains();
    });
    mains.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMains();
      }
    });

    // make-up isolator guarded toggle
    $("#mkup-isol").addEventListener("change", function (e) {
      S.mkupAuto = e.target.checked;
      audio.gesture();
    });

    // manual make-up bypass (hold)
    var byp = $("#btn-bypass");
    function hold(on) {
      if (on && (!S.powered || S.tripped)) return;
      S.bypassHeld = on;
      if (on) audio.gesture();
    }
    byp.addEventListener("pointerdown", function () {
      hold(true);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      byp.addEventListener(ev, function () {
        hold(false);
      });
    });
    byp.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
        e.preventDefault();
        hold(true);
      }
    });
    byp.addEventListener("keyup", function (e) {
      if (e.key === "Enter" || e.key === " ") hold(false);
    });

    // alarm accept
    $("#btn-accept").addEventListener("click", function () {
      activeAlarms().forEach(function (n) {
        acked[n] = true;
      });
      audio.gesture();
    });

    // lamps test (momentary)
    var lt = $("#btn-lamps");
    function lampsOn(on) {
      document.body.classList.toggle("lamps-test-on", on);
      if (on) audio.gesture();
    }
    lt.addEventListener("pointerdown", function () {
      lampsOn(true);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      lt.addEventListener(ev, function () {
        lampsOn(false);
      });
    });
    lt.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
        e.preventDefault();
        lampsOn(true);
      }
    });
    lt.addEventListener("keyup", function (e) {
      if (e.key === "Enter" || e.key === " ") lampsOn(false);
    });

    // life-support trip reset
    $("#btn-tripreset").addEventListener("click", function () {
      if (!S.tripped) return;
      if (S.ppCO2 < CO2_HI && S.ppO2 > 13 && S.ppO2 < 31) {
        S.tripped = false;
        S.tripCause = "";
      }
      audio.gesture();
    });

    // panel reset
    $("#btn-panelreset").addEventListener("click", function () {
      machine.reset();
    });

    // fault test switches
    [
      ["#ft-fans", "scrubber fan stall"],
      ["#ft-quads", "quad bank depletion"],
      ["#ft-mkup", "make-up valve passing"],
    ].forEach(function (pair) {
      var el = $(pair[0]);
      el.addEventListener("change", function () {
        if (el.checked) machine.inject(pair[1]);
        else clearFault(pair[1]);
        audio.gesture();
      });
    });

    // manual dialog
    var dlg = $("dialog[data-manual]");
    $all('[data-action="manual"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    });
    $all('[data-action="close-manual"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof dlg.close === "function") dlg.close();
        else dlg.removeAttribute("open");
      });
    });
  }

  /* ---- per-frame UI sync ---- */

  var segs = [];
  function collectSegs() {
    segs = $all(".tube .seg");
    segs.forEach(function (seg, i) {
      var pct = (i + 0.5) / segs.length;
      seg.classList.add(pct < 0.25 ? "z-lo" : pct >= 0.8125 ? "z-hi" : "z-ok");
    });
  }

  ui.syncAll = function () {
    // dials
    dialRefs.bankA.set(S.banks[0]);
    dialRefs.bankB.set(S.banks[1]);
    dialRefs.bankC.set(S.banks[2]);
    dialRefs.bankD.set(S.banks[3]);
    dialRefs.temp.set(S.tempC);
    dialRefs.o2cyl.set(S.o2Bar);
    dialRefs.ppco2.set(S.ppCO2);
    dialRefs.depth.set(S.depth);
    dialRefs.depth.setGhost(S.depthSet);

    // readouts
    var R = ui.readout;
    R.bankA.textContent = String(Math.round(S.banks[0]));
    R.bankB.textContent = String(Math.round(S.banks[1]));
    R.bankC.textContent = String(Math.round(S.banks[2]));
    R.bankD.textContent = String(Math.round(S.banks[3]));
    R.feeding.textContent = ["A", "B", "C", "D"][S.quadPos];
    R.turns.textContent = String(Math.round(S.o2Turns * 100)).padStart(3, "0");
    R.ppo2.textContent = S.ppO2.toFixed(1) + "%";
    R.ppco2.textContent = S.ppCO2.toFixed(1);
    R.tempc.textContent = S.tempC.toFixed(1);
    R.depthm.textContent = Math.round(S.depth) + " m";

    // oxygen bargraph
    var n = Math.round(((S.ppO2 - O2_MIN) / (O2_MAX - O2_MIN)) * segs.length);
    segs.forEach(function (seg, i) {
      seg.classList.toggle("lit-lo", i < n && seg.classList.contains("z-lo"));
      seg.classList.toggle("lit-ok", i < n && seg.classList.contains("z-ok"));
      seg.classList.toggle("lit-hi", i < n && seg.classList.contains("z-hi"));
    });

    // annunciators
    var active = {};
    activeAlarms().forEach(function (n) {
      active[n] = true;
    });
    Object.keys(lampEls).forEach(function (key) {
      var name = LAMP_NAMES[key];
      var el = lampEls[key];
      var on = !!active[name];
      var critical =
        name === "PP O2 LOW" || name === "CO2 HIGH" || name === "PP O2 HIGH";
      el.classList.toggle("critical", critical);
      el.classList.toggle("on", on);
      el.classList.toggle("flash", on && !acked[name]);
      if (!on) delete acked[name];
    });

    // trip bar
    var tb = $("#btn-tripreset");
    tb.classList.toggle("tripped", S.tripped);
    R.tripstate.textContent = S.tripped ? "TRIPPED · " + S.tripCause : "CLEAR";

    // bypass availability
    var byp = $("#btn-bypass");
    var usable = S.powered && !S.tripped;
    byp.disabled = !usable;
    if (!usable) S.bypassHeld = false;

    // fault switches reflect injected state
    $("#ft-fans").checked = S.fFans;
    $("#ft-quads").checked = S.fQuads;
    $("#ft-mkup").checked = S.fMkup;

    // isolator reflects state
    $("#mkup-isol").checked = S.mkupAuto;

    // knobs follow state (silent: keyboard/drag stay authoritative)
    K.quad.set(S.quadPos, true);
    K.fans.set(S.fanPos, true);
    K.set.set(S.depthSet, true);
    K.o2.set(S.o2Turns, true);
    K.vent.set(S.ventTurns, true);

    document.body.classList.toggle("is-powered", S.powered);

    // buzzer: unaccepted critical alarm, or a standing trip
    var buzz =
      S.powered &&
      (S.tripped ||
        activeAlarms().some(function (n) {
          return (
            !acked[n] &&
            (n === "PP O2 LOW" || n === "CO2 HIGH" || n === "PP O2 HIGH")
          );
        }));
    audio.setBuzzer(buzz);
  };

  /* ---- animation loop ---- */

  var lastTs = 0,
    uiAccum = 0.5;
  function frame(ts) {
    var dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    if (!document.hidden) {
      if (dt > 0 && dt < 2) tick(Math.min(dt, 0.5));
      drawCCTV(dt);
      uiAccum += dt;
      if (uiAccum > 0.09) {
        uiAccum = 0;
        ui.syncAll();
        audio.frame(S);
      }
    }
    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    lastTs = 0;
  });

  /* ---- boot ---- */

  function boot() {
    S = coldState();

    $all(".windows li").forEach(function (li) {
      lampEls[li.getAttribute("data-lamp")] = li;
    });

    [
      "bankA",
      "bankB",
      "bankC",
      "bankD",
      "temp",
      "o2cyl",
      "ppco2",
      "depth",
    ].forEach(function (n) {
      dialRefs[n] = buildScale(n);
    });

    ui.readout = {};
    $all("[data-readout]").forEach(function (o) {
      ui.readout[o.getAttribute("data-readout")] = o;
    });

    collectSegs();
    setupControls();
    ui.ready = true;
    document.body.classList.add("is-powered");

    ui.syncAll();
    drawCCTV(0.016);
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
