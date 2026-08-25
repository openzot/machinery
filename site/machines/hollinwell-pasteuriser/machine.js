/* ============================================================
   Hollinwell Dairies — HTST Pasteuriser Panel No. 2 (1993)
   Simulation: balance tank -> regen -> hot-water set -> legal
   holding tube -> fail-safe FDV -> cooler. Deterministic tick.
   ============================================================ */
(() => {
  "use strict";

  // ---------------- constants ----------------
  var TANK_CAP_L = 1000; // balance tank working capacity
  var HOLD_VOL_L = 84.5; // legal holding tube volume
  var LEGAL_TEMP = 71.7; // legal minimum pasteurisation temperature
  var DIVERT_TEMP = 71.8; // FDV cut-out
  var RESIDENCE_MIN = 15.0; // legal minimum residence, seconds
  var NOTCH_LPH = 2000; // litres/hour per pump notch
  var RATED_LPH = 20000; // nameplate duty
  var RAW_IN_LPH = 18000; // float-valve raw supply
  var CHART_REV_S = 240; // simulated seconds per chart revolution

  var ALARMS = [
    "PAST. TEMP LOW",
    "RESIDENCE SHORT",
    "TANK LEVEL LOW",
    "TANK OVERHEAT",
    "HOT WATER HIGH",
    "OUTLET WARM",
    "MAINTENANCE FAULT",
    "FLOW TRIP",
  ];

  var FAULTS = ["plate pack fouling", "FDV seat sticking"];

  var AMBIENT = 19;
  var RAW_TEMP = 6;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function lag(v, target, h, tau) {
    return v + (target - v) * (1 - Math.exp(-h / tau));
  }

  // ---------------- state ----------------
  var S;

  function coldState() {
    return {
      t: 0,
      chartT: 0,
      mode: "OFF",
      notch: 0,
      hwSet: 76.5,
      flow: 0,
      tw: AMBIENT,
      tp: RAW_TEMP,
      outletT: 14,
      tankLvl: 76,
      tankT: RAW_TEMP,
      rawOpen: true,
      fouling: 1,
      fdvState: "SHUT",
      cavT: 0,
      hwHotT: 0,
      washHotS: 0,
      flowTrip: false,
      spoilTrip: false,
      hwTrip: false,
      foulFault: false,
      stuckFault: false,
      testEngaged: false,
      exercise: 0,
      acked: {},
      hist: [],
      lastSample: -1,
      productLostL: 0,
    };
  }
  S = coldState();

  // ---------------- derived quantities ----------------
  function regenEff() {
    return clamp(0.94 - 0.28 * (1 - S.fouling), 0, 0.94);
  }
  function residenceS() {
    return (HOLD_VOL_L / Math.max(S.flow, 1)) * 3600;
  }
  function powered() {
    return S.mode !== "OFF" && !S.spoilTrip;
  }
  function producing() {
    return S.mode === "PRODUCE" && !S.spoilTrip;
  }
  function cleaning() {
    return S.mode === "WASH";
  }
  function sanitising() {
    return S.mode === "SANITISE";
  }
  function flowing() {
    return S.flow > 800;
  }

  // ---------------- integration ----------------
  function integrate(h) {
    var prod = producing();
    var wash = cleaning();
    var san = sanitising();
    var on = powered();
    var i, tgt;

    // ---- feed pump ----
    var cmd = on && !S.flowTrip ? S.notch * NOTCH_LPH : 0;
    var starving = cmd > 0 && S.tankLvl < 6;
    if (starving) {
      S.cavT += h;
      S.flow = lag(S.flow, 0, h, 1.2);
    } else {
      S.cavT = Math.max(0, S.cavT - h * 2);
      S.flow = lag(S.flow, cmd, h, 3.5);
    }
    if (!S.flowTrip && S.cavT > 6) S.flowTrip = true;
    if (S.flowTrip) S.flow = lag(S.flow, 0, h, 1.2);

    // ---- hot-water circuit ----
    tgt = S.hwTrip ? AMBIENT : san ? 82 : on ? S.hwSet : AMBIENT;
    S.tw = lag(S.tw, tgt, h, tgt > S.tw ? 22 : 55);
    if (S.hwTrip) {
      if (S.hwSet < 85.4 && S.tw < 87) S.hwTrip = false;
    } else if (S.tw > 89) {
      S.hwHotT += h;
      if (S.hwHotT > 20) {
        S.hwTrip = true;
        S.hwHotT = 0;
      }
    } else {
      S.hwHotT = Math.max(0, S.hwHotT - h);
    }

    // ---- plate-pack fouling ----
    if (S.foulFault) {
      S.fouling = Math.max(0.45, S.fouling - h * 0.02);
    } else if (wash && S.tw >= 70 && S.flow > 800) {
      S.fouling = Math.min(1, S.fouling + h * 0.005);
    } else if (on) {
      S.fouling = Math.max(0.45, S.fouling - h * 0.00006 * (S.tw / 75));
    }

    // ---- product temperatures along the plate pack ----
    var fl = flowing();
    var R = regenEff();
    var treg = S.tankT + R * (Math.max(S.tp, S.tankT) - S.tankT);
    var gain = (3 * S.fouling) / (3 * S.fouling + S.flow / RATED_LPH);
    tgt = fl ? treg + (S.tw - 2.0 - treg) * gain - 0.8 : S.tankT;
    S.tp = clamp(lag(S.tp, tgt, h, 7), 0, 99);

    // ---- flow diversion valve ----
    var fdvCmd;
    if (S.testEngaged) fdvCmd = "DIVERT";
    else if (!on || !fl) fdvCmd = "SHUT";
    else if (wash || san) fdvCmd = "DIVERT";
    else
      fdvCmd =
        S.tp >= DIVERT_TEMP && residenceS() >= RESIDENCE_MIN
          ? "FORWARD"
          : "DIVERT";
    if (!S.stuckFault && fdvCmd !== S.fdvState) {
      S.fdvState = fdvCmd;
      ui.clack();
    }
    if (S.testEngaged && prod && S.fdvState === "DIVERT")
      S.productLostL += (S.flow / 3600) * h;

    // ---- balance tank level ----
    var suction = on && !S.flowTrip ? S.flow : 0;
    var divBack = prod && S.fdvState === "DIVERT" ? S.flow : 0;
    var rawIn = 0;
    if ((prod || S.mode === "OFF") && S.rawOpen) rawIn = RAW_IN_LPH;
    if (S.rawOpen && S.tankLvl > 82) S.rawOpen = false;
    if (!S.rawOpen && S.tankLvl < 78) S.rawOpen = true;
    var netLph = wash || san ? 0 : rawIn + divBack - suction;
    S.tankLvl = clamp(S.tankLvl + (netLph * h) / 36000, 0, 100);


    // ---- balance tank temperature ----
    if (divBack > 0)
      S.tankT +=
        (((S.tp - S.tankT) * (divBack * h)) / (3600 * TANK_CAP_L)) * 1.6;
    if (rawIn > 0)
      S.tankT += ((RAW_TEMP - S.tankT) * (rawIn * h)) / (3600 * TANK_CAP_L);
    S.tankT = clamp(lag(S.tankT, 10, h, 12000), 2, 42);

    // ---- raw-milk spoilage: ignoring an overheated tank wrecks the vat ----
    if (S.tankT >= 31 && !S.spoilTrip) {
      S.spoilTrip = true;
      S.mode = "OFF";
      S.notch = 0;
    }
    if (wash && S.tw >= 70 && fl) {
      S.washHotS += h;
      if (S.spoilTrip && S.washHotS >= 90) S.spoilTrip = false;
    } else if (!wash) {
      S.washHotS = Math.max(0, S.washHotS - h);
    }

    // ---- cooler ----
    tgt =
      prod && S.fdvState === "FORWARD" && fl
        ? 2.2 +
          3.6 * Math.pow(S.flow / RATED_LPH, 1.4) +
          Math.max(0, S.tankT - 8) * 0.22
        : 14;
    S.outletT = lag(S.outletT, tgt, h, 20);

    // ---- chart recorder paper ----
    if (ui.driveOn()) {
      S.chartT += h;
      var sample = Math.floor(S.chartT / 2);
      if (sample !== S.lastSample) {
        S.lastSample = sample;
        S.hist.push({ a: angOf(S.chartT), v1: pvPen1(), v2: pvPen2() });
        if (S.hist.length > 420) S.hist.splice(0, S.hist.length - 420);
      }
    }
    S.t += h;

    // pen positions, 0..1 across their bands
    function pvPen1() {
      return clamp((S.tp - 60) / 25, 0, 1);
    }
    function pvPen2() {
      return clamp(S.flow / RATED_LPH, 0, 1);
    }
    function angOf(tSec) {
      return (tSec / CHART_REV_S) * Math.PI * 2;
    }
  }

  function computeAlarms() {
    var prod = producing(),
      fl = flowing(),
      list = [];
    if (prod && fl && S.tp < LEGAL_TEMP - 0.1) list.push(ALARMS[0]);
    if (powered() && fl && residenceS() < RESIDENCE_MIN) list.push(ALARMS[1]);
    if (S.tankLvl < 18) list.push(ALARMS[2]);
    if (S.tankT >= 24) list.push(ALARMS[3]);
    if (S.tw > 86) list.push(ALARMS[4]);
    if (prod && S.fdvState === "FORWARD" && fl && S.outletT > 6.5)
      list.push(ALARMS[5]);
    if (S.foulFault || S.stuckFault) list.push(ALARMS[6]);
    if (S.flowTrip) list.push(ALARMS[7]);
    return list;
  }

  // ---------------- public API ----------------
  var machine = {
    name: "Hollinwell Dairies HTST Pasteuriser Panel No. 2",
    faults: FAULTS.slice(),

    state: function () {
      return {
        mode: S.mode,
        pump_notch: S.notch,
        flow_lph: Math.round(S.flow),
        past_temp_c: Math.round(S.tp * 10) / 10,
        hw_temp_c: Math.round(S.tw * 10) / 10,
        hw_set_c: Math.round(S.hwSet * 10) / 10,
        regen_eff_pct: Math.round(regenEff() * 100),
        residence_s: Math.round(residenceS() * 10) / 10,
        tank_level_pct: Math.round(S.tankLvl * 10) / 10,
        tank_temp_c: Math.round(S.tankT * 10) / 10,
        outlet_temp_c: Math.round(S.outletT * 10) / 10,
        fouling_pct: Math.round(S.fouling * 100),
        fdv: S.fdvState,
        flow_trip: S.flowTrip,
        spoilage_trip: S.spoilTrip,
        hw_trip: S.hwTrip,
        product_lost_l: Math.round(S.productLostL),
        uptime_s: Math.round(S.t),
        alarms: computeAlarms(),
      };
    },

    tick: function (seconds) {
      var remain = clamp(isFinite(+seconds) ? +seconds : 0, 0, 120);
      while (remain > 0.0001) {
        var h = Math.min(0.25, remain);
        integrate(h);
        remain -= h;
      }
    },

    inject: function (fault) {
      var f = String(fault || "").toLowerCase();
      if (f.indexOf("foul") !== -1 || f.indexOf("plate") !== -1)
        S.foulFault = true;
      else if (
        f.indexOf("fdv") !== -1 ||
        f.indexOf("seat") !== -1 ||
        f.indexOf("stick") !== -1
      ) {
        S.stuckFault = true;
        S.exercise = 0;
      } else throw new Error("unknown fault: " + fault);
      ui.syncInjectBoxes();
    },

    reset: function () {
      var driveWasOn = ui.driveOn();
      S = coldState();
      ui.syncControls();
      if (driveWasOn) ui.setDrive(true);
      drawChart();
    },

    // used by the divert-test lever and the exercise-valve button:
    // one full stroke and return proves (or restores) the spring return
    testEngage: function (b) {
      b = !!b;
      if (b === S.testEngaged) return;
      S.testEngaged = b;
      if (!b) {
        S.exercise++;
        if (S.stuckFault && S.exercise >= 1) {
          S.stuckFault = false;
          S.exercise = 0;
          relayClack();
          ui.syncInjectBoxes();
        }
      }
      ui.syncTestLever();
    },
  };

  window.machine = machine;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    lampRun: $("lamp-run"),
    lampDivert: $("lamp-divert"),
    ann: {
      "PAST. TEMP LOW": $("ann-pastlow"),
      "RESIDENCE SHORT": $("ann-residence"),
      "TANK LEVEL LOW": $("ann-tanklow"),
      "TANK OVERHEAT": $("ann-tankhot"),
      "HOT WATER HIGH": $("ann-hwhigh"),
      "OUTLET WARM": $("ann-warm"),
      "MAINTENANCE FAULT": $("ann-maint"),
      "FLOW TRIP": $("ann-trip"),
    },
    tankFill: $("tank-fill"),
    sightFloat: $("sight-float"),
    pumpVane: $("pump-vane"),
    regenEff: $("regen-eff"),
    heaterEye: $("heater-eye"),
    hwMimic: $("hw-temp-mimic"),
    resRead: $("residence-read"),
    fdvNode: $("fdv-node"),
    fdvSpindle: $("fdv-spindle"),
    fdvState: $("fdv-state"),
    pathLine: $("path-line"),
    pathDivert: $("path-divert"),
    hwSetRead: $("hw-set-read"),
    chartClock: $("chart-clock"),
    modeCaption: $("mode-caption"),
    pump: $("in-pump"),
    hw: $("in-hw"),
    chartBox: $("in-chart"),
    testLever: $("btn-fdv-test"),
    dialog: $("manual-dialog"),
    lcds: {},
  };

  var CRIT = {
    "PAST. TEMP LOW": 1,
    "RESIDENCE SHORT": 1,
    "TANK OVERHEAT": 1,
    "FLOW TRIP": 1,
  };

  var ui = {
    driveOn: function () {
      return els.chartBox.checked;
    },
    setDrive: function (b) {
      els.chartBox.checked = b;
    },
    clearChart: function () {
      S.hist = [];
      S.lastSample = -1;
      S.chartT = 0;
      drawChart();
    },
    syncControls: function () {
      els.pump.value = String(S.notch);
      els.hw.value = String(S.hwSet);
      els.hwSetRead.textContent = S.hwSet.toFixed(1) + " \u00B0C";
      var radios = document.querySelectorAll('input[name="mode"]');
      for (var i = 0; i < radios.length; i++)
        radios[i].checked = radios[i].value === S.mode;
      ui.syncInjectBoxes();
      ui.syncTestLever();
    },
    syncInjectBoxes: function () {
      var boxes = document.querySelectorAll("[data-inject]");
      for (var i = 0; i < boxes.length; i++) {
        var n = boxes[i].getAttribute("data-inject").toLowerCase();
        if (n.indexOf("foul") !== -1 || n.indexOf("plate") !== -1)
          boxes[i].checked = S.foulFault;
        else boxes[i].checked = S.stuckFault;
      }
    },
    syncTestLever: function () {
      els.testLever.classList.toggle("engaged", S.testEngaged);
    },
    clack: function () {
      relayClack();
    },
  };


  // ---- seven-segment LCD canvases ----
  // unit cell: 12 wide x 20 tall, drawn at scale s
  var PATHS = [
    // a
    [
      [1.6, 0.7],
      [10.4, 0.7],
      [9.4, 1.7],
      [2.6, 1.7],
    ],
    // b
    [
      [10.8, 1.2],
      [11.3, 2.2],
      [11.3, 8.4],
      [10.3, 9.2],
      [9.9, 8.6],
      [9.9, 2.1],
    ],
    // c
    [
      [10.8, 18.8],
      [11.3, 17.8],
      [11.3, 11.6],
      [10.3, 10.8],
      [9.9, 11.4],
      [9.9, 17.9],
    ],
    // d
    [
      [1.6, 19.3],
      [10.4, 19.3],
      [9.4, 18.3],
      [2.6, 18.3],
    ],
    // e
    [
      [1.2, 18.8],
      [1.7, 17.8],
      [2.1, 11.4],
      [3.1, 10.8],
      [3.1, 17.9],
    ],
    // f
    [
      [1.2, 1.2],
      [2.1, 2.1],
      [2.1, 8.6],
      [3.1, 9.2],
      [3.1, 11.4],
      [1.7, 2.2],
    ],
    // g
    [
      [1.9, 9.3],
      [2.8, 9.9],
      [9.2, 9.9],
      [10.1, 9.3],
      [9.2, 8.7],
      [2.8, 8.7],
    ],
  ];

  var DIG_SEGS = {
    0: "abcdef",
    1: "bc",
    2: "abged",
    3: "abgcd",
    4: "fgbc",
    5: "afgcd",
    6: "afgedc",
    7: "abc",
    8: "abcdefg",
    9: "abcfgd",
    "-": "g",
    " ": "",
  };

  function setupCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 120;
    var h = cv.clientHeight || 40;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function drawSegs(cv, text) {
    var ctx = setupCanvas(cv);
    var W = cv.clientWidth || 120,
      H = cv.clientHeight || 40;
    ctx.clearRect(0, 0, W, H);
    var dark = "#26301f";
    var toks = String(text).split("");
    var n = Math.max(toks.length, 1);
    var charW = W / n;
    var segH = H * 0.74,
      yOff = (H - segH) / 2;
    var s = Math.min((charW * 0.72) / 12, segH / 20);

    function drawPoly(pi, xBase, alpha) {
      var P = PATHS[pi];
      ctx.beginPath();
      for (var k = 0; k < P.length; k++) {
        var X = xBase + P[k][0] * s,
          Y = yOff + P[k][1] * s;
        if (k === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = dark;
      ctx.fill();
    }

    // ghosted unlit segments, like a real reflective LCD
    for (var i = 0; i < n; i++) {
      if (toks[i] === ".") continue;
      var xg = i * charW + (charW - 12 * s) / 2;
      for (var gi = 0; gi < PATHS.length; gi++) drawPoly(gi, xg, 0.09);
    }
    // lit segments
    for (i = 0; i < n; i++) {
      var t = toks[i];
      var xb = i * charW + (charW - 12 * s) / 2;
      if (t === ".") {
        ctx.beginPath();
        ctx.arc(xb + 11.5 * s, yOff + 18.8 * s, 1.15 * s, 0, 7);
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = dark;
        ctx.fill();
        continue;
      }
      var lit = DIG_SEGS[t] || "";
      for (var j = 0; j < lit.length; j++) {
        var pi = lit.charAt(j) === "g" ? 6 : "abcdef".indexOf(lit.charAt(j));
        drawPoly(pi, xb, 0.92);
      }
    }
    ctx.globalAlpha = 1;
  }

  function fmt4(str) {
    str = String(str);
    while (str.length < 4) str = " " + str;
    return str.slice(-4);
  }

  var lastLcd = {};
  function lcd(name, text) {
    // redraw every frame: cheap, and immune to first-paint layout shifts
    drawSegs(els.lcds[name], text);
  }


  // ---- circular chart recorder ----
  var chartBg = null;

  function buildChartBg(size) {
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var x = c.getContext("2d");
    var cx = size / 2,
      cy = size / 2,
      R = size / 2 - 4;
    var r, i, a;
    x.fillStyle = "#efe9d8";
    x.beginPath();
    x.arc(cx, cy, R + 3, 0, 7);
    x.fill();
    x.strokeStyle = "#cfc4a6";
    x.lineWidth = 1;
    for (i = 1; i <= 12; i++) {
      r = (R * i) / 12;
      x.beginPath();
      x.arc(cx, cy, r, 0, 7);
      x.stroke();
    }
    x.strokeStyle = "#bcb08e";
    for (i = 0; i < 24; i++) {
      a = (i / 24) * Math.PI * 2;
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * R * 0.16, cy + Math.sin(a) * R * 0.16);
      x.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      x.stroke();
    }
    x.fillStyle = "#6d6350";
    x.font = "bold 11px 'Arial Narrow', Arial, sans-serif";
    x.textAlign = "center";
    x.fillText("PEN 1 \u00B7 TEMP 60\u201385 \u00B0C", cx, cy - R * 0.62 - 5);
    x.fillText("PEN 2 \u00B7 FLOW 0\u201320", cx, cy - R * 0.3 - 5);
    x.fillStyle = "#2c3135";
    x.beginPath();
    x.arc(cx, cy, R * 0.13, 0, 7);
    x.fill();
    x.strokeStyle = "#14171a";
    x.lineWidth = 2;
    x.stroke();
    chartBg = c;
  }

  function angOf(tSec) {
    return (tSec / CHART_REV_S) * Math.PI * 2;
  }

  function drawChart() {
    var cv = els.chart;
    var size = cv.width;
    if (!chartBg || chartBg.width !== size) buildChartBg(size);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(chartBg, 0, 0);
    var cx = size / 2,
      cy = size / 2,
      R = size / 2 - 4;
    var nowAng = angOf(S.chartT);
    var i, p, th, rr;

    function plot(idx, band0, band1, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      var started = false,
        prevA = 0;
      for (i = 0; i < S.hist.length; i++) {
        p = S.hist[i];
        th = Math.PI / 2 - (nowAng - p.a);
        rr = R * (band0 + (band1 - band0) * p["v" + idx]);
        var X = cx + Math.cos(th) * rr,
          Y = cy + Math.sin(th) * rr;
        if (!started || Math.abs(p.a - prevA) > 0.35) {
          ctx.moveTo(X, Y);
          started = true;
        } else ctx.lineTo(X, Y);
        prevA = p.a;
      }
      ctx.stroke();
    }
    plot(1, 0.62, 0.97, "#c22227"); // red ink: pasteurisation temperature
    plot(2, 0.3, 0.54, "#1e4f86"); // blue ink: flow

    // pens ride fixed at twelve o'clock; the disc turns beneath them
    var v1 = clamp((S.tp - 60) / 25, 0, 1),
      v2 = clamp(S.flow / RATED_LPH, 0, 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#8a2016";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - R * (0.62 + 0.35 * v1));
    ctx.stroke();
    ctx.strokeStyle = "#173a5e";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - R * (0.3 + 0.24 * v2));
    ctx.stroke();
    ctx.fillStyle = "#c22227";
    ctx.beginPath();
    ctx.arc(cx, cy - R * (0.62 + 0.35 * v1), 2.6, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#1e4f86";
    ctx.beginPath();
    ctx.arc(cx, cy - R * (0.3 + 0.24 * v2), 2.6, 0, 7);
    ctx.fill();
  }

  // ---- sound (after a visitor's first gesture only) ----
  var AC = null,
    humOsc = null,
    humGain = null;
  function audioInit() {
    try {
      if (!AC) {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        AC = new Ctor();
        humOsc = AC.createOscillator();
        humOsc.type = "sawtooth";
        humOsc.frequency.value = 48;
        var flt = AC.createBiquadFilter();
        flt.type = "lowpass";
        flt.frequency.value = 220;
        humGain = AC.createGain();
        humGain.gain.value = 0;
        humOsc.connect(flt);
        flt.connect(humGain);
        humGain.connect(AC.destination);
        humOsc.start();
      }
      if (AC.state === "suspended") AC.resume();
    } catch (e) {
      AC = null;
    }
  }
  function relayClack() {
    if (!AC) return;
    try {
      var len = Math.floor(AC.sampleRate * 0.045);
      var buf = AC.createBuffer(1, len, AC.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      var src = AC.createBufferSource();
      src.buffer = buf;
      var bp = AC.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 850;
      var g = AC.createGain();
      g.gain.value = 0.09;
      src.connect(bp);
      bp.connect(g);
      g.connect(AC.destination);
      src.start();
    } catch (e) {
      /* stay silent */
    }
  }
  function updateHum() {
    if (!humGain || !AC) return;
    try {
      var fr = S.flow / RATED_LPH;
      var target = S.flow > 500 ? 0.01 + fr * 0.038 : 0;
      humGain.gain.setTargetAtTime(target, AC.currentTime, 0.25);
      humOsc.frequency.setTargetAtTime(46 + fr * 34, AC.currentTime, 0.3);
    } catch (e) {
      /* stay silent */
    }
  }
  document.addEventListener("pointerdown", audioInit);
  document.addEventListener("keydown", audioInit);

  // ---- render ----
  var prevAlarms = {};
  var lastFdvClass = "";

  function render() {
    var st = machine.state();

    els.lampRun.classList.toggle("on", st.fdv === "FORWARD");
    els.lampDivert.classList.toggle(
      "on",
      powered() && flowing() && st.fdv === "DIVERT",
    );

    // annunciator
    var active = {};
    st.alarms.forEach(function (a) {
      active[a] = true;
    });
    ALARMS.forEach(function (a) {
      var el = els.ann[a];
      if (!el) return;
      if (active[a] && !prevAlarms[a]) S.acked[a] = false;
      el.classList.toggle("active", !!active[a]);
      el.classList.toggle("crit", !!CRIT[a]);
      el.classList.toggle("warn", !CRIT[a]);
      el.classList.toggle("blink", !!active[a] && !S.acked[a]);
    });
    prevAlarms = active;

    // mimic
    var lvlY = 100 + (100 - st.tank_level_pct);
    els.tankFill.setAttribute("y", lvlY.toFixed(1));
    els.tankFill.setAttribute("height", st.tank_level_pct.toFixed(1));
    els.sightFloat.setAttribute("cy", (lvlY + 8).toFixed(1));
    els.pumpVane.classList.toggle("spin", st.flow_lph > 500);
    els.regenEff.textContent = st.regen_eff_pct + " %";
    els.heaterEye.classList.toggle("warm", S.tw > 45);
    els.heaterEye.classList.toggle("hot", S.tw > 72);
    els.hwMimic.textContent = st.hw_temp_c.toFixed(1) + " \u00B0C";
    els.resRead.textContent =
      st.flow_lph > 500 ? st.residence_s.toFixed(1) + " s" : "\u2014 s";
    els.fdvSpindle.setAttribute(
      "transform",
      st.fdv === "DIVERT" ? "translate(0,7)" : "",
    );
    els.fdvState.textContent = S.stuckFault ? "STUCK" : st.fdv;
    var cls =
      "node " +
      (st.fdv === "FORWARD"
        ? "node-fwd"
        : st.fdv === "DIVERT"
          ? "node-div"
          : "node-shut");
    if (cls !== lastFdvClass) {
      els.fdvNode.setAttribute("class", cls);
      lastFdvClass = cls;
    }
    var liveFlow = st.flow_lph > 500;
    els.pathLine.classList.toggle("flowing", liveFlow && st.fdv === "FORWARD");
    els.pathDivert.classList.toggle("flowing", liveFlow && st.fdv === "DIVERT");

    // loop controllers
    lcd("pp", fmt4(st.past_temp_c.toFixed(1)));
    lcd("ps", fmt4("71.7"));
    lcd("fp", fmt4((st.flow_lph / 1000).toFixed(1)));
    lcd("fs", fmt4((S.notch * 2).toFixed(1)));
    lcd("hp", fmt4(Math.min(99.9, st.hw_temp_c).toFixed(1)));
    lcd("hs", fmt4(st.hw_set_c.toFixed(1)));

    els.modeCaption.textContent = {
      OFF: "PANEL ISOLATED AT OFF",
      WASH: "CAUSTIC CIRCULATION \u2014 75 \u00B0C MIN",
      SANITISE: "WATER RECIRC \u2014 82 \u00B0C",
      PRODUCE: "LINE FORWARD TO FILLERS"
    }[S.mode];

    els.hwSetRead.textContent = st.hw_set_c.toFixed(1) + " \u00B0C";

    var mm = Math.floor(S.chartT / 60),
      ss = Math.floor(S.chartT % 60);
    els.chartClock.textContent =
      (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;

    updateHum();
  }

  // ---- events ----
  function bind() {
    document.querySelectorAll('input[name="mode"]').forEach(function (rad) {
      rad.addEventListener("change", function () {
        var v = rad.value;
        if (v === "PRODUCE" && S.spoilTrip) {
          rad.checked = false;
          var off = document.getElementById("m-off");
          if (off) off.checked = true;
          S.mode = "OFF";
          relayClack();
          return;
        }
        if (v !== S.mode) {
          S.mode = v;
          relayClack();
        }
      });
    });

    els.pump.addEventListener("input", function () {
      S.notch = parseInt(els.pump.value, 10) || 0;
    });
    els.hw.addEventListener("input", function () {
      S.hwSet = parseFloat(els.hw.value);
    });

    // divert test lever: hold to stroke it over; release and the weight must return it
    els.testLever.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      machine.testEngage(true);
    });
    window.addEventListener("pointerup", function () {
      machine.testEngage(false);
    });
    els.testLever.addEventListener("keydown", function (ev) {
      if ((ev.key === " " || ev.key === "Enter") && !ev.repeat) {
        ev.preventDefault();
        machine.testEngage(true);
      }
    });
    els.testLever.addEventListener("keyup", function (ev) {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        machine.testEngage(false);
      }
    });

    // maintenance flap
    $("flap-tab").addEventListener("click", function () {
      var inner = $("flap-inner");
      var show = inner.hidden;
      inner.hidden = !show;
      this.setAttribute("aria-expanded", show ? "true" : "false");
      this.textContent = show ? "MAINTENANCE \u25B4" : "MAINTENANCE \u25BE";
    });
    document.querySelectorAll("[data-inject]").forEach(function (box) {
      box.addEventListener("change", function () {
        var nm = box.getAttribute("data-inject").toLowerCase();
        if (nm.indexOf("foul") !== -1 || nm.indexOf("plate") !== -1) {
          S.foulFault = box.checked;
        } else {
          S.stuckFault = box.checked;
          if (box.checked) S.exercise = 0;
        }
        relayClack();
      });
    });
    $("btn-reseat").addEventListener("click", function () {
      machine.testEngage(true);
      setTimeout(function () {
        machine.testEngage(false);
      }, 380);
    });

    $("btn-ack").addEventListener("click", function () {
      machine.state().alarms.forEach(function (a) {
        S.acked[a] = true;
      });
    });

    els.chartBox.addEventListener("change", function () {
      if (els.chartBox.checked) relayClack();
    });

    $("btn-reset").addEventListener("click", function () {
      machine.reset();
    });

    document
      .querySelector('[data-action="manual"]')
      .addEventListener("click", function () {
        try {
          els.dialog.showModal();
        } catch (e) {
          els.dialog.setAttribute("open", "");
        }
      });
    document
      .querySelector('[data-action="close-manual"]')
      .addEventListener("click", function () {
        try {
          els.dialog.close();
        } catch (e) {
          els.dialog.removeAttribute("open");
        }
      });
  }
  // ---- animation loop ----
  var last = performance.now();
  function frame(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (dt < 0) dt = 0;
    if (dt > 1) dt = 1;
    if (!document.hidden) {
      machine.tick(dt);
      render();
    }
    requestAnimationFrame(frame);
  }

  // gather the LCD canvases, then go
  var LCD_KEYS = {
    "past-pv": "pp",
    "past-sp": "ps",
    "flow-pv": "fp",
    "flow-sp": "fs",
    "hw-pv": "hp",
    "hw-sp": "hs"
  };
  document.querySelectorAll("[data-segs]").forEach(function (cv) {
    var attr = cv.getAttribute("data-segs");
    els.lcds[LCD_KEYS[attr] || attr] = cv;
  });
  els.chart = $("chart");

  bind();
  ui.syncControls();
  ui.clearChart();
  requestAnimationFrame(frame);
})();
