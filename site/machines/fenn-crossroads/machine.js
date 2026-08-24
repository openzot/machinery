/* Fenn Crossroads Automatic Signal Controller Mk III — simulation and panel behaviour.
   A synchronous motor turns a camshaft; three adjustable cams open mercury switches
   to step the junction through its intervals; vehicle treadles register demand;
   a conflict monitor drops the junction to alternating red flash when a filament
   fails or the saturation timer runs out. Everything here is deterministic given
   the same sequence of tick() calls. */
(function () {
  "use strict";

  /* ------------------------------------------------------------- constants */
  var AMBER = 3,
    ALLRED = 2,
    STEP = 0.1;
  var GM_MIN = 15,
    GM_MAX = 60,
    GM_STEP = 5;
  var GS_MIN = 10,
    GS_MAX = 40,
    GS_STEP = 5;
  var WK_MIN = 5,
    WK_MAX = 15,
    WK_STEP = 1;
  var SEED = 19550414;

  /* ------------------------------------------------------------------ rng */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- state */
  var rng = mulberry32(SEED);
  var S = {};

  function defaults() {
    S.time = 0;
    S.acc = 0;
    S.power = true;
    S.mode = "AUTO"; // FLASH | AUTO | HAND
    S.flashKey = false;
    S.gm = 30;
    S.gs = 20;
    S.wk = 8;
    S.cyclePos = 0;
    S.slipK = 1; // clutch slip multiplier
    S.mainsV = 242;
    S.sagTarget = 242;
    S.sagLeft = 0;
    S.sagGuard = 30;
    S.qE = 0;
    S.qW = 0;
    S.qN = 0;
    S.qS = 0;
    S.arrE = 0;
    S.arrW = 0;
    S.arrN = 0;
    S.arrS = 0;
    S.latchE = false;
    S.latchW = false;
    S.latchN = false;
    S.latchS = false;
    S.mainCalls = 0;
    S.sideCalls = 0;
    S.treadleStuck = false;
    S.stuckSince = 0;
    S.lampFail = false;
    S.clutchSlip = false;
    S.conflictTimer = 0;
    S.forcedConflict = false;
    S.satTimer = 0;
    S.satTrip = false;
    S.graceUntil = 0;
    S.flashT = 0;
    S.flashAlt = false;
    S.sidePlatoonIn = 40 + rng() * 50;
    S.platoonLeft = 0;
    S.mainRate = 0.17;
    S.ratePhase = rng() * 6.28;
  }
  defaults();

  /* ------------------------------------------------------------ geometry */
  function effGm() {
    /* a permanently-called Carrow Lane detector cuts Fenn Road to minimum green */
    var g = S.gm;
    if (S.treadleStuck && S.time - S.stuckSince > 25) g = Math.min(g, GM_MIN);
    return g * S.slipK;
  }
  function effGs() {
    return S.gs * S.slipK;
  }
  function cycleLen() {
    return effGm() + AMBER + ALLRED + effGs() + AMBER + ALLRED;
  }
  function bounds() {
    var a = effGm(),
      b = a + AMBER,
      c = b + ALLRED,
      d = c + effGs();
    var wkEnd = Math.min(d, c + Math.min(S.wk, S.gs - 3) * S.slipK);
    return {
      mgA: 0,
      mgB: a,
      maB: b,
      ar1B: c,
      sgB: d,
      wkEnd: wkEnd,
      saB: d + AMBER,
      end: d + AMBER + ALLRED,
    };
  }
  function intervalName(p) {
    var b = bounds();
    if (p < b.mgB) return "MAIN GREEN";
    if (p < b.maB) return "MAIN AMBER";
    if (p < b.ar1B) return "ALL RED";
    if (p < b.sgB) return p < b.wkEnd ? "WALK" : "SIDE GREEN";
    if (p < b.saB) return "SIDE AMBER";
    return "ALL RED";
  }

  function isFlashing() {
    return (
      S.flashKey ||
      S.mode === "FLASH" ||
      S.forcedConflict ||
      S.satTrip ||
      !S.power
    );
  }

  /* ------------------------------------------------------------- stepping */
  function step(h) {
    S.time += h;

    /* mains */
    if (S.sagGuard > 0) S.sagGuard -= h;
    if (S.sagLeft > 0) {
      S.sagLeft -= h;
      if (S.sagLeft <= 0) {
        S.sagTarget = 239 + rng() * 5;
      }
    } else if (S.sagGuard <= 0 && S.power && rng() < h / 210) {
      S.sagLeft = 8 + rng() * 14;
      S.sagTarget = 184 + rng() * 30;
    }
    S.mainsV += (S.sagTarget - S.mainsV) * Math.min(1, h * 1.4);

    var speed = S.power ? Math.min(1.06, S.mainsV / 240) : 0;
    var stalled = S.mainsV < 178;
    if (!S.power || stalled) speed = 0;

    /* clutch slip grows while the test is made, reseats when cleared */
    if (S.clutchSlip) S.slipK = Math.min(1.8, S.slipK + h * 0.02);
    else S.slipK = Math.max(1, S.slipK - h * 0.06);

    /* traffic arrival rates */
    S.ratePhase += h * 0.11;
    S.mainRate = 0.13 + 0.09 * (0.5 + 0.5 * Math.sin(S.ratePhase));
    S.sidePlatoonIn -= h;
    if (S.sidePlatoonIn <= 0) {
      S.platoonLeft = 6 + Math.floor(rng() * 7);
      S.sidePlatoonIn = 45 + rng() * 60;
    }
    var lamM = S.mainRate,
      lamS = 0.055 + (S.platoonLeft > 0 ? 0.32 : 0);
    if (S.platoonLeft > 0) S.platoonLeft = Math.max(0, S.platoonLeft - h * 0.4);

    var C = cycleLen();

    /* camshaft: motor-driven in AUTO and FLASH-free running, hand-wound at HAND */
    if (S.power && !isFlashing() && S.mode !== "HAND") {
      S.cyclePos += h * speed;
      if (S.cyclePos >= C) {
        S.cyclePos -= C;
        onCycleDone();
      }
    }
    if (S.power && S.mode === "HAND" && crankHeld && !isFlashing()) {
      S.cyclePos += h * 2.4;
      if (S.cyclePos >= C) {
        S.cyclePos -= C;
        onCycleDone();
      }
    }

    /* arrivals -> queues, calls, counters */
    arrive("E", lamM * h);
    arrive("W", lamM * 0.85 * h);
    arrive("N", lamS * 0.6 * h);
    arrive("S", lamS * h);

    /* discharge during greens */
    var name = intervalName(S.cyclePos);
    if (S.power && !isFlashing()) {
      if (name === "MAIN GREEN") {
        discharge("E", h);
        discharge("W", h);
      } else if (name === "SIDE GREEN" || name === "WALK") {
        discharge("N", h);
        discharge("S", h);
      }
    }

    /* stuck treadle forces a Carrow Lane call every instant */
    if (S.treadleStuck) {
      S.latchN = true;
      S.latchS = true;
    }

    /* saturation timer */
    var worst = Math.max(Math.max(S.qE, S.qW), Math.max(S.qN, S.qS));
    if (worst >= 13 && S.power && !isFlashing())
      S.satTimer = Math.min(120, S.satTimer + h);
    else S.satTimer = Math.max(0, S.satTimer - h * 2);

    /* conflict monitor: Carrow Lane red filaments open while Fenn Rd. has right of way */
    if (
      S.power &&
      !isFlashing() &&
      S.lampFail &&
      (name === "MAIN GREEN" || name === "MAIN AMBER")
    ) {
      S.conflictTimer += h;
      if (S.conflictTimer > 0.8) S.forcedConflict = true;
    } else {
      S.conflictTimer = 0;
    }

    /* saturation trip: sustained oversaturation drops the junction to flash */
    if (S.satTimer >= 90 && !S.satTrip && S.power && !isFlashing()) {
      S.satTrip = true;
    }

    /* flash alternation clock */
    if (isFlashing()) {
      S.flashT += h;
      if (S.flashT >= 0.7) {
        S.flashT = 0;
        S.flashAlt = !S.flashAlt;
      }
    } else {
      S.flashT = 0;
    }
  }

  function arrive(which, n) {
    S["arr" + which] += n;
    while (S["arr" + which] >= 1) {
      S["arr" + which] -= 1;
      if (S["q" + which] < 24) S["q" + which] += 1;
      if (which === "E" || which === "W") {
        S.mainCalls = (S.mainCalls + 1) % 10000;
        S.latchE = true;
        S.latchW = true;
      } else {
        S.sideCalls = (S.sideCalls + 1) % 10000;
        S.latchN = true;
        S.latchS = true;
      }
    }
  }
  function discharge(which, h) {
    var before = S["q" + which];
    S["q" + which] = Math.max(0, before - 0.52 * h);
    if (before > 0 && S["q" + which] === 0) {
      if (which === "E") S.latchE = false;
      if (which === "W") S.latchW = false;
      if (which === "N") S.latchN = S.treadleStuck;
      if (which === "S") S.latchS = S.treadleStuck;
    }
  }
  function onCycleDone() {
    if (S.treadleStuck) {
      S.latchN = true;
      S.latchS = true;
    }
  }

  /* ------------------------------------------------------------------ API */
  function alarmsNow() {
    if (!S.power) return [];
    var out = [];
    if (S.forcedConflict) out.push("CONFLICT");
    if (S.clutchSlip && S.slipK >= 1.12) out.push("CYCLE DRIFT");
    if (S.satTrip) out.push("SATURATION");
    else if (S.satTimer >= 20) out.push("SATURATION");
    if (S.treadleStuck && S.time - S.stuckSince > 25) out.push("DEMAND STUCK");
    if (S.mainsV < 216) out.push("MAINS LOW");
    return out;
  }

  window.machine = {
    name: "Fenn Crossroads Automatic Signal Controller Mk III",
    faults: ["signal lamp failure", "cam clutch slip", "treadle stuck closed"],
    state: function () {
      var C = cycleLen();
      var speed = S.power ? Math.min(1.06, S.mainsV / 240) : 0;
      var turning = S.power && !isFlashing() && S.mode !== "HAND" && speed > 0;
      return {
        power: !!S.power,
        mode: S.mode,
        flash: isFlashing(),
        interval: S.power ? intervalName(S.cyclePos) : "SUPPLY ISOLATED",
        cyclePos: +S.cyclePos.toFixed(2),
        cycleLength: +C.toFixed(2),
        mainGreenSet: S.gm,
        sideGreenSet: S.gs,
        walkSet: S.wk,
        slipFactor: +S.slipK.toFixed(3),
        mainsVolts: +S.mainsV.toFixed(1),
        camshaftRpm: +(turning ? (60 / C) * speed : 0).toFixed(2),
        mainQueue: +(S.qE + S.qW).toFixed(2),
        sideQueue: +(S.qN + S.qS).toFixed(2),
        mainCalls: S.mainCalls,
        sideCalls: S.sideCalls,
        saturationTimer: +S.satTimer.toFixed(1),
        alarms: alarmsNow(),
      };
    },
    tick: function (seconds) {
      if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
        return;
      S.acc += seconds;
      var guard = 0;
      while (S.acc >= STEP && guard++ < 20000) {
        step(STEP);
        S.acc -= STEP;
      }
    },
    inject: function (fault) {
      var f = String(fault || "").toLowerCase();
      if (f === "signal lamp failure") {
        S.lampFail = true;
        return;
      }
      if (f === "cam clutch slip") {
        S.clutchSlip = true;
        return;
      }
      if (f === "treadle stuck closed") {
        S.treadleStuck = true;
        S.stuckSince = S.time;
        return;
      }
      throw new Error("unknown fault: " + fault);
    },
    reset: function () {
      defaults();
      ui.guardOpen = { lamp: false, clutch: false, treadle: false };
      syncPanels();
    },
  };

  /* ------------------------------------------------------- operator actions */
  function setIsolator(on) {
    S.power = !!on;
    syncPanels();
  }
  function setMode(m) {
    if (m !== "FLASH" && m !== "AUTO" && m !== "HAND") return;
    var wasFlash = isFlashing();
    S.mode = m;
    if (wasFlash && !isFlashing()) {
      S.satTimer = 0;
      S.graceUntil = S.time + 45;
    }
    syncPanels();
  }
  function setFlashKey(on) {
    S.flashKey = !!on;
    syncPanels();
  }
  function policeStep() {
    if (S.mode !== "HAND" || !S.power || isFlashing()) return;
    var b = bounds();
    var edges = [b.mgB, b.maB, b.ar1B, b.sgB, b.saB, b.end];
    for (var i = 0; i < edges.length; i++) {
      if (S.cyclePos < edges[i] - 0.01) {
        S.cyclePos = edges[i];
        return;
      }
    }
    S.cyclePos = 0;
    onCycleDone();
  }
  function setGreen(which, v) {
    v = Math.round(v);
    if (which === "gm") S.gm = Math.min(GM_MAX, Math.max(GM_MIN, v));
    if (which === "gs") S.gs = Math.min(GS_MAX, Math.max(GS_MIN, v));
    if (which === "wk") S.wk = Math.min(WK_MAX, Math.max(WK_MIN, v));
    S.wk = Math.min(S.wk, S.gs - 3);
    var C = cycleLen();
    if (S.cyclePos > C) S.cyclePos = C;
    /* working a cam knob re-seats its clutch */
    S.slipK = 1;
    buildCycleDial();
    syncPanels();
  }
  function treadleTest() {
    S.sideCalls = (S.sideCalls + 1) % 10000;
    S.latchN = true;
    S.latchS = true;
    if (S.treadleStuck) {
      S.treadleStuck = false;
    }
    pulseTreadle();
    syncPanels();
  }
  function lampRestore() {
    if (!S.lampFail) {
      S.forcedConflict = false;
      S.conflictTimer = 0;
    }
    syncPanels();
  }

  /* ------------------------------------------------------------- dom refs */
  function $(id) {
    return document.getElementById(id);
  }
  var el = {
    flywheel: $("flywheel"),
    relay: $("relayBox"),
    bell: $("bell"),
    discMG: $("discMG"),
    discSG: $("discSG"),
    discWK: $("discWK"),
    folMG: $("folMG"),
    folSG: $("folSG"),
    folWK: $("folWK"),
    knobMG: $("knobMG"),
    knobSG: $("knobSG"),
    knobWK: $("knobWK"),
    readMG: $("readMG"),
    readSG: $("readSG"),
    readWK: $("readWK"),
    jMG: $("jMG"),
    jMA: $("jMA"),
    jAR: $("jAR"),
    jSG: $("jSG"),
    jSA: $("jSA"),
    jWK: $("jWK"),
    jPower: $("jPower"),
    jTransfer: $("jTransfer"),
    jBell: $("jBell"),
    hdE: $("hd-E"),
    hdW: $("hd-W"),
    hdS: $("hd-S"),
    hdN: $("hd-N"),
    pedW: document.querySelector("#ped-W1 .lp-walk"),
    pedD: document.querySelector("#ped-D1 .lp-dw"),
    trE: $("tr-E"),
    trW: $("tr-W"),
    trS: $("tr-S"),
    trN: $("tr-N"),
    carsE: $("carsE"),
    carsW: $("carsW"),
    carsS: $("carsS"),
    carsN: $("carsN"),
    drumMain: $("drumMain"),
    drumSide: $("drumSide"),
    isolator: $("isolator"),
    modeSel: $("modeSel"),
    flashKeyEl: $("flashKey"),
    policeBtn: $("policeBtn"),
    crankBtn: $("crank"),
    treadleTest: $("treadleTest"),
    lampRestore: $("lampRestore"),
    bellCutBtn: $("bellCut"),
    plantReset: $("plantReset"),
    gsLamp: $("gsLamp"),
    gsClutch: $("gsClutch"),
    gsTreadle: $("gsTreadle"),
    dial: $("cycleDial"),
    volt: $("voltMeter"),
  };

  var ui = {
    guardOpen: { lamp: false, clutch: false, treadle: false },
    lastInterval: "",
    lastAlarms: "",
  };
  var crankHeld = false;
  var bellCutOn = false;
  var announce = null;

  /* --------------------------------------------------------- dial drawing */
  var NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  var dialNeedle = null,
    voltNeedle = null;

  function polar(cx, cy, r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function arcPath(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0),
      p1 = polar(cx, cy, r, a1);
    var large = a1 - a0 > 180 ? 1 : 0;
    return (
      "M " +
      p0[0].toFixed(2) +
      " " +
      p0[1].toFixed(2) +
      " A " +
      r +
      " " +
      r +
      " 0 " +
      large +
      " 1 " +
      p1[0].toFixed(2) +
      " " +
      p1[1].toFixed(2)
    );
  }

  function buildCycleDial() {
    var svg = el.dial;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var cx = 105,
      cy = 105;
    svg.appendChild(
      svgEl("circle", {
        cx: cx,
        cy: cy,
        r: 96,
        fill: "#efe8d2",
        stroke: "#4c4736",
        "stroke-width": 3,
      }),
    );
    var C = cycleLen(),
      b = bounds();
    function arc(a0, a1, col, w) {
      if (a1 - a0 < 0.4) return;
      svg.appendChild(
        svgEl("path", {
          d: arcPath(cx, cy, 84, a0, Math.min(a1, 359.99)),
          fill: "none",
          stroke: col,
          "stroke-width": w || 13,
        }),
      );
    }
    var f = function (sec) {
      return (sec / C) * 360;
    };
    arc(f(b.mgA), f(b.mgB), "#cf7a10");
    arc(f(b.mgB), f(b.maB), "#c9a227");
    arc(f(b.maB), f(b.ar1B), "#bf2318");
    arc(f(b.ar1B), f(b.sgB), "#1d7a3a");
    arc(f(b.sgB), f(b.saB), "#c9a227");
    arc(f(b.saB), f(b.end), "#bf2318");
    var i, deg, pt, qt, t;
    for (i = 0; i <= 90; i += 5) {
      deg = (i / 90) * 360;
      pt = polar(cx, cy, 96, deg);
      qt = polar(cx, cy, i % 15 === 0 ? 88 : 91, deg);
      svg.appendChild(
        svgEl("line", {
          x1: pt[0].toFixed(1),
          y1: pt[1].toFixed(1),
          x2: qt[0].toFixed(1),
          y2: qt[1].toFixed(1),
          stroke: "#4c4736",
          "stroke-width": i % 15 === 0 ? 2 : 1,
        }),
      );
      if (i % 15 === 0) {
        t = svgEl("text", {
          fill: "#4c4736",
          "font-size": 11,
          "text-anchor": "middle",
          "font-family": "Courier New, monospace",
          "font-weight": "bold",
        });
        t.setAttribute(
          "transform",
          "translate(" +
            polar(cx, cy, 74, deg)[0].toFixed(1) +
            "," +
            (polar(cx, cy, 74, deg)[1] + 4).toFixed(1) +
            ")",
        );
        t.textContent = String(i);
        svg.appendChild(t);
      }
    }
    dialNeedle = svgEl("line", {
      x1: cx,
      y1: cy + 10,
      x2: cx,
      y2: cy - 78,
      stroke: "#8f130a",
      "stroke-width": 3,
      "stroke-linecap": "round",
    });
    svg.appendChild(dialNeedle);
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 7, fill: "#23251f" }));
    var cap = svgEl("text", {
      x: cx,
      y: 198,
      fill: "#3c371c",
      "font-size": 10,
      "letter-spacing": 2,
      "text-anchor": "middle",
      "font-family": "Arial Narrow, sans-serif",
    });
    cap.textContent = "ONE REVOLUTION PER CYCLE · SECONDS";
    svg.appendChild(cap);
  }

  function buildVoltMeter() {
    var svg = el.volt;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var cx = 105,
      cy = 118;
    svg.appendChild(
      svgEl("rect", {
        x: 4,
        y: 4,
        width: 202,
        height: 124,
        rx: 8,
        fill: "#efe8d2",
        stroke: "#4c4736",
        "stroke-width": 3,
      }),
    );
    function vToDeg(v) {
      return -58 + ((v - 160) / 120) * 116;
    }
    svg.appendChild(
      svgEl("path", {
        d: arcPath(cx, cy, 84, vToDeg(200), vToDeg(280)),
        fill: "none",
        stroke: "#7d8a72",
        "stroke-width": 9,
      }),
    );
    svg.appendChild(
      svgEl("path", {
        d: arcPath(cx, cy, 84, vToDeg(160), vToDeg(200)),
        fill: "none",
        stroke: "#bf2318",
        "stroke-width": 9,
      }),
    );
    var v, deg, p, q, t;
    for (v = 160; v <= 280; v += 20) {
      deg = vToDeg(v);
      p = polar(cx, cy, 92, deg);
      q = polar(cx, cy, v % 40 === 0 ? 80 : 85, deg);
      svg.appendChild(
        svgEl("line", {
          x1: p[0],
          y1: p[1],
          x2: q[0],
          y2: q[1],
          stroke: "#4c4736",
          "stroke-width": v % 40 === 0 ? 2 : 1,
        }),
      );
      if (v % 40 === 0) {
        t = svgEl("text", {
          fill: "#4c4736",
          "font-size": 11,
          "text-anchor": "middle",
          "font-family": "Courier New, monospace",
          "font-weight": "bold",
        });
        t.setAttribute(
          "transform",
          "translate(" +
            polar(cx, cy, 68, deg)[0].toFixed(1) +
            "," +
            (polar(cx, cy, 68, deg)[1] + 4).toFixed(1) +
            ")",
        );
        t.textContent = String(v);
        svg.appendChild(t);
      }
    }
    voltNeedle = svgEl("line", {
      x1: cx,
      y1: cy,
      x2: cx,
      y2: cy - 74,
      stroke: "#22241f",
      "stroke-width": 3,
      "stroke-linecap": "round",
    });
    svg.appendChild(voltNeedle);
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 6, fill: "#23251f" }));
    var lab = svgEl("text", {
      x: cx,
      y: 122,
      fill: "#3c371c",
      "font-size": 10,
      "letter-spacing": 2,
      "text-anchor": "middle",
      "font-family": "Arial Narrow, sans-serif",
    });
    lab.textContent = "MAINS VOLTS A.C.";
    svg.appendChild(lab);
  }

  /* ---------------------------------------------------------------- sound */
  var AC = null,
    master = null,
    humGain = null,
    bellNext = 0;
  function ensureAudio() {
    if (AC) {
      if (AC.state === "suspended") AC.resume();
      return;
    }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    AC = new Ctx();
    master = AC.createGain();
    master.gain.value = 0.16;
    master.connect(AC.destination);
    var humOsc = AC.createOscillator(),
      humOsc2 = AC.createOscillator(),
      lp = AC.createBiquadFilter();
    humOsc.type = "sawtooth";
    humOsc.frequency.value = 50;
    humOsc2.type = "triangle";
    humOsc2.frequency.value = 100;
    lp.type = "lowpass";
    lp.frequency.value = 220;
    humGain = AC.createGain();
    humGain.gain.value = 0;
    humOsc.connect(lp);
    humOsc2.connect(lp);
    lp.connect(humGain);
    humGain.connect(master);
    humOsc.start();
    humOsc2.start();
  }
  function sndClick() {
    if (!AC) return;
    var t = AC.currentTime;
    var buf = AC.createBufferSource();
    var len = Math.floor(AC.sampleRate * 0.03);
    var data = AC.createBuffer(1, len, AC.sampleRate);
    var ch = data.getChannelData(0),
      i;
    for (i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    buf.buffer = data;
    var bp = AC.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 2;
    var g = AC.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    buf.connect(bp);
    bp.connect(g);
    g.connect(master);
    buf.start(t);
  }
  function sndBell() {
    if (!AC) return;
    var t = AC.currentTime;
    [1046, 1568].forEach(function (f, idx) {
      var o = AC.createOscillator(),
        g = AC.createGain();
      o.type = "square";
      o.frequency.value = f * (idx ? 1.003 : 1);
      g.gain.setValueAtTime(idx ? 0.05 : 0.09, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.65);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.7);
    });
  }

  /* -------------------------------------------------------------- rendering */
  function setLit(jewel, on) {
    if (jewel) jewel.classList.toggle("lit", !!on);
  }

  function renderCars(group, count, horizontal, fromX, fromY, dir) {
    while (group.firstChild) group.removeChild(group.firstChild);
    var k = Math.min(14, Math.floor(count));
    var i, r;
    for (i = 0; i < k; i++) {
      r = document.createElementNS(NS, "rect");
      if (horizontal) {
        r.setAttribute("x", (fromX + dir * (i * 31)).toFixed(1));
        r.setAttribute("y", fromY);
        r.setAttribute("width", 26);
        r.setAttribute("height", 14);
      } else {
        r.setAttribute("x", fromX);
        r.setAttribute("y", (fromY + dir * (i * 27)).toFixed(1));
        r.setAttribute("width", 14);
        r.setAttribute("height", 22);
      }
      group.appendChild(r);
    }
  }

  function headAspects(head, cmd) {
    var r = head.querySelector(".lp-r"),
      a = head.querySelector(".lp-a"),
      g = head.querySelector(".lp-g");
    r.classList.toggle("on", cmd === "r");
    a.classList.toggle("on", cmd === "a");
    g.classList.toggle("on", cmd === "g");
  }

  function render() {
    var st = window.machine.state();
    var b = bounds();
    var name = st.interval;
    var flash = st.flash;
    var altRed = flash && S.flashAlt;

    /* signal heads */
    var mainCmd = "r",
      sideCmd = "r",
      walkOn = false,
      dwFlash = false;
    if (!st.power) {
      mainCmd = "";
      sideCmd = "";
    } else if (flash) {
      mainCmd = altRed ? "r" : "";
      sideCmd = altRed ? "" : "r";
      if (sideCmd === "r" && S.lampFail)
        sideCmd = ""; /* open filament shows dark */
    } else {
      if (name === "MAIN GREEN") mainCmd = "g";
      else if (name === "MAIN AMBER") mainCmd = "a";
      else if (name === "SIDE GREEN" || name === "WALK") sideCmd = "g";
      else if (name === "SIDE AMBER") sideCmd = "a";
      walkOn = name === "WALK";
      dwFlash = name === "SIDE GREEN";
    }
    headAspects(el.hdE, mainCmd);
    headAspects(el.hdW, mainCmd);
    headAspects(el.hdS, sideCmd);
    headAspects(el.hdN, sideCmd);
    if (el.pedW) el.pedW.classList.toggle("on", walkOn);
    if (el.pedD) el.pedD.classList.toggle("on", dwFlash && S.time % 1 < 0.5);

    /* queues */
    renderCars(el.carsE, S.qE, true, 424, 166, -1);
    renderCars(el.carsW, S.qW, true, 550, 128, 1);
    renderCars(el.carsS, S.qS, false, 500, 112, -1);
    renderCars(el.carsN, S.qN, false, 464, 206, 1);

    /* treadle call marks */
    el.trE.classList.toggle("call", S.latchE);
    el.trW.classList.toggle("call", S.latchW);
    el.trN.classList.toggle("call", S.latchN);
    el.trS.classList.toggle("call", S.latchS);

    /* camshaft visuals */
    var C = st.cycleLength || 1;
    var frac = S.cyclePos / C;
    var fmMG = b.mgB / 2 / C,
      fmSG = (b.ar1B + b.sgB) / 2 / C,
      fmWK = (b.ar1B + b.wkEnd) / 2 / C;
    el.discMG.style.setProperty(
      "--ang",
      ((fmMG - frac) * 360).toFixed(1) + "deg",
    );
    el.discSG.style.setProperty(
      "--ang",
      ((fmSG - frac) * 360).toFixed(1) + "deg",
    );
    el.discWK.style.setProperty(
      "--ang",
      ((fmWK - frac) * 360).toFixed(1) + "deg",
    );
    var jOn = !flash && st.power;
    el.folMG.classList.toggle("on", jOn && name === "MAIN GREEN");
    el.folSG.classList.toggle(
      "on",
      jOn && (name === "SIDE GREEN" || name === "SIDE AMBER"),
    );
    el.folWK.classList.toggle("on", jOn && name === "WALK");

    /* flywheel + relay */
    var running = st.power && !flash && st.camshaftRpm > 0;
    el.flywheel.style.animationPlayState = running ? "running" : "paused";
    el.flywheel.style.animationDuration =
      (3.2 / Math.max(0.35, st.mainsVolts / 240)).toFixed(2) + "s";
    el.relay.classList.toggle("on", flash);

    /* interval jewels */
    setLit(el.jMG, jOn && name === "MAIN GREEN");
    setLit(el.jMA, jOn && name === "MAIN AMBER");
    setLit(el.jAR, jOn && name === "ALL RED");
    setLit(el.jSG, jOn && name === "SIDE GREEN");
    setLit(el.jSA, jOn && name === "SIDE AMBER");
    setLit(el.jWK, jOn && name === "WALK");

    /* instruments */
    if (dialNeedle)
      dialNeedle.setAttribute(
        "transform",
        "rotate(" + (frac * 360).toFixed(1) + " 105 105)",
      );
    if (voltNeedle) {
      var vd =
        -58 + ((Math.max(160, Math.min(280, st.mainsVolts)) - 160) / 120) * 116;
      voltNeedle.setAttribute(
        "transform",
        "rotate(" + vd.toFixed(1) + " 105 118)",
      );
    }

    /* counters */
    setDrum(el.drumMain, st.mainCalls);
    setDrum(el.drumSide, st.sideCalls);

    /* pilot jewels */
    setLit(el.jPower, st.power);
    setLit(el.jTransfer, flash);
    setLit(el.jBell, bellCutOn);

    /* alarms + bell + hum */
    var ringing = st.power && !bellCutOn && st.alarms.length > 0;
    el.bell.classList.toggle("ring", ringing);
    if (AC) {
      var now = AC.currentTime;
      humGain.gain.setTargetAtTime(running ? 0.05 : 0, now, 0.2);
      if (ringing && now > bellNext) {
        sndBell();
        bellNext = now + 1.15;
      }
    }

    /* relay clicks between intervals */
    var key =
      st.power + "|" + name + "|" + (flash ? "F" + (altRed ? "1" : "0") : "");
    if (key !== ui.lastInterval) {
      if (ui.lastInterval && AC && st.power) sndClick();
      ui.lastInterval = key;
    }
    var al = st.alarms.join(", ");
    if (al !== ui.lastAlarms) {
      announce.textContent = st.alarms.length
        ? "Alarm: " + st.alarms.join(", ")
        : "No alarms.";
      ui.lastAlarms = al;
    }

    /* control faces */
    paintControls(st);
  }

  function setDrum(win, value) {
    var s = String(Math.max(0, Math.floor(value)) % 10000);
    while (s.length < 4) s = "0" + s;
    var spans = win.children;
    for (var i = 0; i < 4; i++) spans[i].textContent = s.charAt(i);
  }

  function pulseTreadle() {
    [el.trN, el.trS].forEach(function (t) {
      t.classList.add("call");
      setTimeout(function () {
        t.classList.remove("call");
      }, 900);
    });
  }

  /* ---------------------------------------------------------- control faces */
  var MODE_ANGLE = { FLASH: -48, AUTO: 0, HAND: 48 };

  function paintControls(st) {
    el.isolator.querySelector(".rt-dial").style.transform =
      "rotate(" + (st.power ? 38 : -38) + "deg)";
    el.isolator.setAttribute("aria-pressed", st.power ? "true" : "false");
    el.isolator.setAttribute(
      "aria-label",
      "MAINS ISOLATOR — currently " +
        (st.power ? "ON" : "OFF") +
        ". Press to switch " +
        (st.power ? "off" : "on") +
        ".",
    );
    el.modeSel.querySelector(".rt-dial").style.transform =
      "rotate(" + MODE_ANGLE[st.mode] + "deg)";
    el.modeSel.setAttribute("aria-valuetext", st.mode);
    el.modeSel.setAttribute(
      "aria-label",
      "MODE SELECTOR — currently " +
        st.mode +
        ". Left arrow for FLASH, right arrow for HAND.",
    );
    el.flashKeyEl.setAttribute("aria-pressed", S.flashKey ? "true" : "false");
    el.flashKeyEl.querySelector(".kw-barrel").style.transform =
      "rotate(" + (S.flashKey ? 90 : 0) + "deg)";

    el.knobMG.setAttribute("aria-valuenow", S.gm);
    el.readMG.querySelector("b").textContent = S.gm;
    el.knobSG.setAttribute("aria-valuenow", S.gs);
    el.readSG.querySelector("b").textContent = S.gs;
    el.knobWK.setAttribute("aria-valuenow", S.wk);
    el.readWK.querySelector("b").textContent = S.wk;

    paintGuard(el.gsLamp, ui.guardOpen.lamp, S.lampFail);
    paintGuard(el.gsClutch, ui.guardOpen.clutch, S.clutchSlip);
    paintGuard(el.gsTreadle, ui.guardOpen.treadle, S.treadleStuck);

    el.bellCutBtn.setAttribute("aria-pressed", bellCutOn ? "true" : "false");

    var cranking = S.power && S.mode === "HAND" && crankHeld && !st.flash;
    el.crankBtn.style.setProperty(
      "--crankAng",
      (cranking ? (S.cyclePos * 36) % 360 : 0) + "deg",
    );
  }

  function paintGuard(root, open, on) {
    var g = root.querySelector(".guard"),
      lever = root.querySelector(".toggle-lever");
    g.setAttribute("aria-expanded", open ? "true" : "false");
    lever.disabled = !open;
    lever.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function syncPanels() {
    render();
  }

  /* --------------------------------------------------------------- wiring */
  function wire() {
    announce = document.createElement("div");
    announce.setAttribute("aria-live", "polite");
    announce.className = "sr-announce";
    document.body.appendChild(announce);

    document.addEventListener("pointerdown", ensureAudio);
    document.addEventListener("keydown", ensureAudio);

    /* manual dialog */
    var dlg = document.getElementById("manualDialog");
    document
      .querySelector('[data-action="manual"]')
      .addEventListener("click", function () {
        dlg.showModal();
      });
    dlg
      .querySelector('[data-action="close-manual"]')
      .addEventListener("click", function () {
        dlg.close();
      });

    el.isolator.addEventListener("click", function () {
      setIsolator(!S.power);
    });
    el.modeSel.addEventListener("click", function () {
      setMode(
        S.mode === "FLASH" ? "AUTO" : S.mode === "AUTO" ? "HAND" : "FLASH",
      );
    });
    el.modeSel.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") {
        setMode(S.mode === "HAND" ? "AUTO" : "FLASH");
        e.preventDefault();
      }
      if (e.key === "ArrowRight") {
        setMode(S.mode === "FLASH" ? "AUTO" : "HAND");
        e.preventDefault();
      }
    });
    el.flashKeyEl.addEventListener("click", function () {
      setFlashKey(!S.flashKey);
    });
    el.policeBtn.addEventListener("click", policeStep);

    hookCam(el.knobMG, "gm", GM_MIN, GM_MAX, GM_STEP);
    hookCam(el.knobSG, "gs", GS_MIN, GS_MAX, GS_STEP);
    hookCam(el.knobWK, "wk", WK_MIN, WK_MAX, WK_STEP);

    hookHold(
      el.crankBtn,
      function () {
        crankHeld = true;
      },
      function () {
        crankHeld = false;
      },
    );

    el.treadleTest.addEventListener("click", treadleTest);
    el.lampRestore.addEventListener("click", lampRestore);
    el.bellCutBtn.addEventListener("click", function () {
      bellCutOn = !bellCutOn;
      if (!bellCutOn && AC) bellNext = 0;
      syncPanels();
    });
    el.plantReset.addEventListener("click", function () {
      window.machine.reset();
    });

    hookGuard(el.gsLamp, "lamp", function (v) {
      S.lampFail = v;
      syncPanels();
    });
    hookGuard(el.gsClutch, "clutch", function (v) {
      S.clutchSlip = v;
      syncPanels();
    });
    hookGuard(el.gsTreadle, "treadle", function (v) {
      S.treadleStuck = v;
      if (v) S.stuckSince = S.time;
      syncPanels();
    });
  }

  function hookCam(knob, key, min, max, stepSize) {
    knob.addEventListener("keydown", function (e) {
      var v = S[key],
        handled = true;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          v += stepSize;
          break;
        case "ArrowLeft":
        case "ArrowDown":
          v -= stepSize;
          break;
        case "PageUp":
          v += stepSize * 3;
          break;
        case "PageDown":
          v -= stepSize * 3;
          break;
        case "Home":
          v = min;
          break;
        case "End":
          v = max;
          break;
        default:
          handled = false;
      }
      if (handled) {
        setGreen(key, v);
        e.preventDefault();
      }
    });
    knob.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        setGreen(key, S[key] + (e.deltaY < 0 ? stepSize : -stepSize));
      },
      { passive: false },
    );
    var dragging = null;
    knob.addEventListener("pointerdown", function (e) {
      dragging = e.clientY;
      knob.setPointerCapture(e.pointerId);
    });
    knob.addEventListener("pointermove", function (e) {
      if (dragging === null) return;
      var dy = dragging - e.clientY;
      if (Math.abs(dy) >= 14) {
        setGreen(key, S[key] + Math.sign(dy) * stepSize);
        dragging = e.clientY;
      }
    });
    knob.addEventListener("pointerup", function () {
      dragging = null;
    });
    knob.addEventListener("pointercancel", function () {
      dragging = null;
    });
  }

  function hookHold(btn, down, up) {
    btn.addEventListener("pointerdown", function (e) {
      down();
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) down();
    });
    btn.addEventListener("keyup", function (e) {
      if (e.key === "Enter" || e.key === " ") up();
    });
    btn.addEventListener("blur", up);
  }

  function hookGuard(root, name, apply) {
    var g = root.querySelector(".guard"),
      lever = root.querySelector(".toggle-lever");
    g.addEventListener("click", function () {
      ui.guardOpen[name] = !ui.guardOpen[name];
      paintGuard(
        root,
        ui.guardOpen[name],
        lever.getAttribute("aria-pressed") === "true",
      );
      if (AC) sndClick();
    });
    lever.addEventListener("click", function () {
      apply(lever.getAttribute("aria-pressed") !== "true");
    });
  }

  /* ------------------------------------------------------------------ boot */
  buildVoltMeter();
  buildCycleDial();
  wire();
  window.machine.reset();

  var last = null;
  function frame(t) {
    if (last === null) last = t;
    var dt = Math.min(0.25, (t - last) / 1000);
    last = t;
    if (!document.hidden && dt > 0) {
      window.machine.tick(dt);
      render();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
