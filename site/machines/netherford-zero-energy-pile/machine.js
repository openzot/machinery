/* ======================================================================
   NETHERFORD ZERO-ENERGY PILE No. 2 - START-UP CONSOLE
   Machine behaviour: neutron kinetics, heat removal, detection chain,
   annunciator supervision, scram protection and the maintenance tray.

   Classic script, no modules. Everything lives in this IIFE; the fixed
   API is exposed on window.machine.
   ====================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------
     Constants
     ------------------------------------------------------------------ */

  var MACHINE_NAME = "Netherford Zero-Energy Pile No. 2";
  var FAULTS = [
    "detector high-voltage failure",
    "control-rod clutch slip",
    "coolant flow loss",
  ];
  var ALARM_NAMES = ["SOURCE", "PERIOD", "FUEL TEMP", "FLOW", "DRIVE", "SCRAM"];

  var SHIM_WORTH_PCM = 900; // worth of the shim rod, fully withdrawn
  var CORE_EXCESS_PCM = 800; // core excess held down by the shim rod
  var REG_WORTH_PCM = 120; // regulating rod, either way
  var TEMP_COEF_PCM = 3.0; // -pcm per degree C above reference
  var TEMP_REF_C = 30;
  var SOURCE_W = 0.05; // neutron source strength, watts-equivalent
  var SUPER_PCS = 2500; // pcm for e-folding time of one second
  var DECAY_PCS = 1800; // pcm controlling shutdown relaxation
  var HEAT_COEF = 3.24e-4; // degC per watt-second / capacity
  var HEAT_CAP = 4.0; // thermal capacity, arbitrary units
  var COOL_MAX = 0.09; // cooling rate per second at valve wide open
  var POWER_TRIP_W = 12000;
  var POWER_NOMINAL_W = 5000; // automatic setpoint
  var TEMP_ALARM_C = 82;
  var TEMP_TRIP_C = 97;
  var PERIOD_WARN_S = 20;
  var PERIOD_TRIP_S = 8;

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */

  var S = {};

  function coldStart() {
    S.time = 0;
    S.mains = false;
    S.chartOn = false;
    S.detectorHT = false;
    S.detector = 0; // 0 OFF, 1 CH A, 2 CH B
    S.mode = 0; // 0 SAFE, 1 MANUAL, 2 AUTO
    S.clutchIn = false;
    S.shim = 0; // percent withdrawn
    S.reg = 0; // -100 .. +100
    S.power = SOURCE_W;
    S.fuelTemp = 20;
    S.poolTemp = 22;
    S.valve = 0; // percent open
    S.rho = 0;
    S.period = 9999;
    S.counts = 0;
    S.dPdtLog = 0; // smoothed ln-derivative
    S.scrammed = false;
    S.tripLatched = false;
    S.scramReason = "";
    S.damaged = false;
    S.periodHold = 0; // seconds period has been below trip
    S.sampleClock = 0;
    S.runHeat = false; // pile has been above 1 kW since last cold start
    S.jitterSeed = 17;
    S.accepted = {}; // alarm name -> acknowledged
    S.lampTest = false;
    S.faultHT = false; // detector EHT unit no.1 failed
    S.faultSlip = false;
    S.faultFlow = false;
    S.faultTimers = { ht: 0, slip: 0, flow: 0 };
    S.chart = [];
    for (var i = 0; i < 160; i++) S.chart.push(null);
    ALARM_NAMES.forEach(function (n) {
      S.accepted[n] = false;
    });
  }
  coldStart();

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function jitter() {
    // deterministic pseudo-noise: same tick sequence, same wobble
    S.jitterSeed = (S.jitterSeed * 1103515245 + 12345) & 0x7fffffff;
    return S.jitterSeed / 0x3fffffff - 1;
  }

  function loopFlowPct() {
    if (!S.mains) return 0;
    if (S.faultFlow) return 0;
    return S.valve;
  }

  function computeRho() {
    var shimPcm =
      Math.pow(S.shim / 100, 1.15) * SHIM_WORTH_PCM - CORE_EXCESS_PCM;
    var regPcm = S.reg * (REG_WORTH_PCM / 100);
    var tempPcm = -TEMP_COEF_PCM * (S.fuelTemp - TEMP_REF_C);
    if (S.fuelTemp < TEMP_REF_C) tempPcm = 0;
    return clamp(shimPcm + regPcm + tempPcm, -900, 400);
  }

  function expectedCounts() {
    var bg = 2.2;
    if (!S.mains || !S.detectorHT || S.detector === 0) return 0;
    if (S.faultHT && S.detector !== 2) return bg;
    var gain = S.detector === 2 ? 34 : 40;
    return bg + S.power * gain;
  }

  /* ------------------------------------------------------------------
     Physics step
     ------------------------------------------------------------------ */

  function step(h) {
    S.time += h;

    /* --- rod mechanics ------------------------------------------------ */
    if (S.scrammed) {
      S.shim = Math.max(0, S.shim - 95 * h); // spring-assisted dump
    } else if (S.mode === 0 && S.mains) {
      S.shim = Math.max(0, S.shim - 11 * h); // motorised insert in SAFE
    } else if (S.clutchIn && S.faultSlip) {
      S.shim = Math.max(0, S.shim - 2.4 * h); // drive screw slipping back
    }

    /* --- reactivity ---------------------------------------------------- */
    S.rho = computeRho();

    /* --- neutron power -------------------------------------------------- */
    var p = S.power;
    if (S.rho > 0) {
      p = p * Math.exp((S.rho / SUPER_PCS) * h);
    } else if (S.rho < 0) {
      var d = -S.rho / DECAY_PCS;
      // subcritical multiplication: the nearer criticality, the more the
      // source is multiplied - this walks the count-rate up a 1/M curve
      var floorP = Math.min(SOURCE_W * (1 + 9000 / -S.rho), 60);
      p = floorP + (p - floorP) * Math.exp(-d * h);
    }
    p = clamp(p, SOURCE_W * 0.4, 60000);

    var instRate = 0;
    // the period meter is only meaningful above source level
    if (p > 2 && S.power > 2) instRate = Math.log(p / S.power) / h;
    S.dPdtLog = S.dPdtLog + (instRate - S.dPdtLog) * Math.min(1, h / 1.2);
    S.power = p;
    S.period =
      Math.abs(S.dPdtLog) < 1e-4 ? 9999 : clamp(1 / S.dPdtLog, -9999, 9999);

    /* --- counting chain -------------------------------------------------- */
    var ex = expectedCounts();
    if (ex <= 0) {
      S.counts = 0;
    } else {
      S.counts = Math.max(0, ex * (1 + jitter() * (ex > 50 ? 0.06 : 0.25)));
    }

    /* --- heat removal ----------------------------------------------------- */
    if (S.power > 1000) S.runHeat = true;
    var flow = loopFlowPct();
    var cooled = (flow / 100) * COOL_MAX;
    // with the loop stagnant and the pile having run, afterheat walks fuel
    // temperature up whatever the neutron power is doing
    var afterheat = S.faultFlow && S.runHeat ? 0.16 : 0;
    var dT =
      (HEAT_COEF * S.power - cooled * (S.fuelTemp - S.poolTemp)) / HEAT_CAP +
      afterheat;
    S.fuelTemp = clamp(S.fuelTemp + dT * h, 15, 150);
    S.poolTemp = 22 + clamp((S.fuelTemp - 22) * 0.04, 0, 6);

    /* --- automatic regulator ---------------------------------------------- */
    if (S.mode === 2 && S.mains && !S.scrammed && S.clutchIn && S.power > 200) {
      // hold the setpoint by governing the period: ease the rod out only
      // while far below power AND the period is long; insert on a short one
      var err = Math.log(POWER_NOMINAL_W / S.power);
      var demand =
        Math.abs(err) < 0.02 && Math.abs(S.dPdtLog) < 0.002
          ? 0
          : clamp(err * 0.55 - S.dPdtLog * 90, -3, 3);
      S.reg = clamp(S.reg + demand * h, -100, 100);
    }

    /* --- protection --------------------------------------------------------- */
    if (!S.scrammed) {
      if (S.power > POWER_TRIP_W) trip("POWER EXCURSION");
      else if (S.fuelTemp > TEMP_TRIP_C) {
        trip("FUEL TEMPERATURE");
        S.damaged = true;
      } else if (S.period > 0 && S.period < PERIOD_TRIP_S && S.power > 50) {
        S.periodHold += h;
        if (S.periodHold > 2) trip("SHORT PERIOD");
      } else {
        S.periodHold = Math.max(0, S.periodHold - h);
      }
    }

    /* --- fault timers ------------------------------------------------------ */
    if (S.faultHT) S.faultTimers.ht = Math.min(99, S.faultTimers.ht + h);
    if (S.faultSlip) S.faultTimers.slip = Math.min(99, S.faultTimers.slip + h);
    if (S.faultFlow) S.faultTimers.flow = Math.min(99, S.faultTimers.flow + h);

    /* --- chart ------------------------------------------------------------- */
    S.sampleClock += h;
    if (S.sampleClock >= 1) {
      S.sampleClock -= 1;
      if (S.chartOn && S.mains) {
        S.chart.push(Math.log10(clamp(S.power, 0.02, 1e6)));
        S.chart.shift();
      }
    }
  }

  function trip(reason) {
    S.scrammed = true;
    S.tripLatched = true;
    S.scramReason = reason;
    raise("SCRAM");
    relayClack();
  }

  /* ------------------------------------------------------------------
     Alarms
     ------------------------------------------------------------------ */

  function raise(name) {
    S.accepted[name] = false;
  }

  function activeAlarms() {
    var out = [];
    var flow = loopFlowPct();

    if (S.faultHT && S.faultTimers.ht > 5 && S.detector !== 2)
      out.push("SOURCE");
    if (
      S.period > 0 &&
      S.period < PERIOD_WARN_S &&
      S.power > 2 &&
      S.dPdtLog > 0.0001
    )
      out.push("PERIOD");
    if (S.damaged || S.fuelTemp > TEMP_ALARM_C) out.push("FUEL TEMP");
    if (
      (S.faultFlow && S.faultTimers.flow > 3) ||
      (S.power > 1500 && flow < 35 && S.mains)
    )
      out.push("FLOW");
    if (S.faultSlip && S.faultTimers.slip > 4) out.push("DRIVE");
    if (S.scrammed) out.push("SCRAM");

    return out;
  }

  /* ------------------------------------------------------------------
     Fixed API
     ------------------------------------------------------------------ */

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) return;
    var remaining = clamp(seconds, 0, 3600);
    var h = 0.25;
    while (remaining > 1e-6) {
      var dt = remaining < h ? remaining : h;
      step(dt);
      remaining -= dt;
    }
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      S.faultHT = true;
      S.faultTimers.ht = 0;
    } else if (f === FAULTS[1]) {
      S.faultSlip = true;
      S.faultTimers.slip = 0;
    } else if (f === FAULTS[2]) {
      S.faultFlow = true;
      S.faultTimers.flow = 0;
    }
  }

  function reset() {
    var chart = S.chart;
    coldStart();
    S.chart = chart;
    for (var i = 0; i < chart.length; i++) chart[i] = null;
  }

  function state() {
    var flow = loopFlowPct();
    return {
      time: round3(S.time),
      mains: S.mains,
      chartOn: S.chartOn,
      detectorHT: S.detectorHT,
      detector: ["OFF", "A", "B"][S.detector],
      mode: ["SAFE", "MANUAL", "AUTO"][S.mode],
      clutch: S.clutchIn ? "IN" : "OUT",
      shim: round3(S.shim),
      regulating: round3(S.reg),
      reactivity: Math.round(S.rho),
      power: round3(S.power),
      period: round3(Math.min(S.period, 9999)),
      counts: Math.round(S.counts * 10) / 10,
      fuelTemp: round3(S.fuelTemp),
      bulkTemp: round3(S.poolTemp),
      coolingValve: Math.round(S.valve),
      loopFlow: Math.round(flow),
      scram: S.scrammed,
      tripLatched: S.tripLatched,
      scramReason: S.scramReason,
      fuelDamage: S.damaged,
      critical: Math.abs(S.rho) < 8 && S.power > 5,
      alarms: activeAlarms(),
      faults: [
        S.faultHT ? FAULTS[0] : null,
        S.faultSlip ? FAULTS[1] : null,
        S.faultFlow ? FAULTS[2] : null,
      ].filter(Boolean),
    };
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ------------------------------------------------------------------
     DOM handles
     ------------------------------------------------------------------ */

  function q(sel) {
    return document.querySelector(sel);
  }
  function qa(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  var el = {
    mains: q('[data-control="MAINS BREAKER"]'),
    chartMotor: q('[data-control="CHART MOTOR"]'),
    detHt: q('[data-control="DETECTOR HT"]'),
    detSelector: q('[data-control="DETECTOR SELECTOR"]'),
    detPointer: q("#detPointer"),
    modeSelector: q('[data-control="MODE SELECTOR"]'),
    modePointer: q("#modePointer"),
    handwheel: q('[data-control="SHIM ROD HANDWHEEL"]'),
    hwSpin: q("#hwSpin"),
    clutch: q('[data-control="DRIVE CLUTCH"]'),
    crank: q('[data-control="REGULATING CRANK"]'),
    crankArm: q("#crankArm"),
    valve: q('[data-control="COOLING VALVE"]'),
    cvSpin: q("#cvSpin"),
    valveDisc: q("#valveDisc"),
    valveReadout: q("#valveReadout"),
    scramBar: q('[data-control="SCRAM BAR"]'),
    tripReset: q('[data-control="TRIP RESET"]'),
    coldReset: q('[data-control="COLD RESET"]'),
    accept: q('[data-control="ALARM ACCEPT"]'),
    lampTestBtn: q('[data-control="LAMPS TEST"]'),
    countNeedle: q("#countNeedle"),
    periodNeedle: q("#periodNeedle"),
    rhoNeedle: q("#rhoNeedle"),
    countsReadout: q("#countsReadout"),
    periodReadout: q("#periodReadout"),
    regReadout: q("#regReadout"),
    decades: qa("#decadeLamps i"),
    shimRod: q("#shimRod"),
    shimPin: q("#shimPin"),
    shimReadout: q("#shimReadout"),
    regRod: q("#regRod"),
    coreGlow: q("#coreGlow"),
    criticalLamp: q("#criticalLamp"),
    fuelBulb: q("#fuelBulb"),
    poolBulb: q("#poolBulb"),
    fuelReadout: q("#fuelTempReadout"),
    poolReadout: q("#poolTempReadout"),
    flowPellet: q("#flowPellet"),
    flowReadout: q("#flowReadout"),
    windows: {},
    chartCanvas: q("#chartPaper"),
  };

  qa("[data-alarm-window]").forEach(function (w) {
    el.windows[w.getAttribute("data-alarm-window")] = w;
  });

  /* ------------------------------------------------------------------
     Meter scales drawn in code
     ------------------------------------------------------------------ */

  var SVGNS = "http://www.w3.org/2000/svg";

  function polar(cx, cy, r, deg) {
    var a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }

  function tickLine(group, cx, cy, r1, r2, deg, w) {
    var p1 = polar(cx, cy, r1, deg);
    var p2 = polar(cx, cy, r2, deg);
    var ln = document.createElementNS(SVGNS, "line");
    ln.setAttribute("x1", p1[0].toFixed(1));
    ln.setAttribute("y1", p1[1].toFixed(1));
    ln.setAttribute("x2", p2[0].toFixed(1));
    ln.setAttribute("y2", p2[1].toFixed(1));
    ln.setAttribute("stroke-width", w || 1);
    group.appendChild(ln);
  }

  (function buildScales() {
    var gCount = q("#countMeter .ticks");
    for (var v = 0; v <= 6; v++) {
      var deg = -54 + v * 18;
      tickLine(gCount, 60, 73, 34, 41, deg, 1.4);
      if (v < 6) {
        for (var m = 1; m < 5; m++) {
          tickLine(gCount, 60, 73, 38, 41, deg + m * 3.6, 0.7);
        }
      }
    }
    var gPer = q("#periodMeter .pticks");
    var periods = [5, 6, 8, 10, 15, 20, 30, 50, 100];
    periods.forEach(function (T) {
      tickLine(gPer, 60, 73, 34, 41, periodAngle(T), 1.4);
    });
    tickLine(gPer, 60, 73, 37, 41, 54, 1.4); // infinity mark
    var gRho = q("#rhoMeter .rticks");
    for (var r = -200; r <= 200; r += 50) {
      tickLine(gRho, 60, 61, 30, 37, (r / 200) * 46, r % 100 === 0 ? 1.4 : 0.7);
    }
  })();

  function periodAngle(T) {
    var u = 1 / clamp(T, 1, 4000);
    return 54 - u * 540; // T=5 -> -54deg, T=10 -> 0deg, infinity -> 54deg
  }

  function logCountAngle(cps) {
    var lg = Math.log10(Math.max(cps, 1));
    return -54 + clamp(lg, 0, 6) * 18;
  }

  /* ------------------------------------------------------------------
     Chart recorder
     ------------------------------------------------------------------ */

  var ctx = el.chartCanvas.getContext("2d");

  function drawChart() {
    var w = el.chartCanvas.width;
    var hgt = el.chartCanvas.height;
    ctx.fillStyle = "#f4efe0";
    ctx.fillRect(0, 0, w, hgt);

    ctx.strokeStyle = "rgba(194,46,32,.4)";
    ctx.lineWidth = 1;
    for (var gy = 0; gy <= 6; gy++) {
      var yy = Math.round(hgt - 8 - (gy / 6) * (hgt - 16));
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
      if (gy < 6) {
        ctx.strokeStyle = "rgba(60,60,40,.14)";
        for (var sub = 1; sub < 5; sub++) {
          var ys = yy - (sub / 5) * ((hgt - 16) / 6);
          ctx.beginPath();
          ctx.moveTo(0, ys);
          ctx.lineTo(w, ys);
          ctx.stroke();
        }
        ctx.strokeStyle = "rgba(194,46,32,.4)";
      }
    }
    ctx.strokeStyle = "rgba(60,60,40,.18)";
    for (var gx = 0; gx < w; gx += 20) {
      ctx.beginPath();
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, hgt);
      ctx.stroke();
    }

    ctx.strokeStyle = "#3b3d33";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < S.chart.length; i++) {
      var v = S.chart[i];
      if (v === null) {
        started = false;
        continue;
      }
      var x = (i / (S.chart.length - 1)) * (w - 6) + 3;
      var y = hgt - 8 - (clamp(v, 0, 6) / 6) * (hgt - 16);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    var last = S.chart[S.chart.length - 1];
    if (last !== null && S.chartOn && S.mains) {
      var py = hgt - 8 - (clamp(last, 0, 6) / 6) * (hgt - 16);
      ctx.fillStyle = "#ffb03a";
      ctx.beginPath();
      ctx.arc(w - 4, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,176,58,.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w - 4, py, 6.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------------
     Sound: relay clack, only ever after a visitor gesture
     ------------------------------------------------------------------ */

  var audioCtx = null;

  function relayClack() {
    if (!audioCtx) return;
    try {
      var t = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(140, t);
      osc.frequency.exponentialRampToValueAtTime(55, t + 0.05);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
    } catch (e) {
      /* silent */
    }
  }

  function ensureAudio() {
    if (audioCtx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) {
      audioCtx = null;
    }
  }
  document.addEventListener("pointerdown", ensureAudio, { passive: true });
  document.addEventListener("keydown", ensureAudio);

  /* ------------------------------------------------------------------
     Control wiring
     ------------------------------------------------------------------ */

  function bindToggle(btn, get, set) {
    btn.addEventListener("click", function () {
      set(!get());
      btn.setAttribute("aria-pressed", get() ? "true" : "false");
      render();
    });
  }

  bindToggle(
    el.mains,
    function () {
      return S.mains;
    },
    function (v) {
      S.mains = v;
      if (!v) {
        S.detectorHT = false;
        el.detHt.setAttribute("aria-pressed", "false");
        relayClack();
      }
    },
  );

  bindToggle(
    el.chartMotor,
    function () {
      return S.chartOn;
    },
    function (v) {
      S.chartOn = v;
    },
  );

  bindToggle(
    el.detHt,
    function () {
      return S.detectorHT;
    },
    function (v) {
      S.detectorHT = v && S.mains;
      el.detHt.setAttribute("aria-pressed", S.detectorHT ? "true" : "false");
    },
  );

  bindToggle(
    el.clutch,
    function () {
      return S.clutchIn;
    },
    function (v) {
      S.clutchIn = v;
      if (!v && S.faultSlip) {
        // dropping the clutch resets the drive screw
        S.faultSlip = false;
        S.faultTimers.slip = 0;
      }
    },
  );

  /* rotary selectors ------------------------------------------------- */

  var DET_LABELS = ["OFF", "A", "B"];
  var MODE_LABELS = ["SAFE", "MANUAL", "AUTO"];
  var ROT_STEP = [-42, 0, 42];

  function bindRotary(node, pointerEl, getCount, setIndex, labels, origin) {
    function apply() {
      var i = getCount();
      pointerEl.setAttribute(
        "transform",
        "rotate(" + ROT_STEP[i] + " " + origin + ")",
      );
      node.setAttribute("aria-valuenow", String(i));
      node.setAttribute("aria-valuetext", labels[i]);
    }
    function cycle(dir) {
      var i = clamp(getCount() + dir, 0, labels.length - 1);
      setIndex(i);
      apply();
      render();
    }
    node.addEventListener("click", function () {
      cycle(getCount() === 2 ? -2 : 1);
    });
    node.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        cycle(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        cycle(-1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        cycle(1);
      }
    });
    apply();
    return apply;
  }

  var applyDetector = bindRotary(
    el.detSelector,
    el.detPointer,
    function () {
      return S.detector;
    },
    function (i) {
      S.detector = i;
    },
    DET_LABELS,
    "40 36",
  );

  var applyMode = bindRotary(
    el.modeSelector,
    el.modePointer,
    function () {
      return S.mode;
    },
    function (i) {
      S.mode = i;
    },
    MODE_LABELS,
    "48 46",
  );

  /* handwheel ---------------------------------------------------------- */

  var hwAngle = 0;

  function driveShim(deltaPercent) {
    hwAngle += deltaPercent * 12;
    el.hwSpin.setAttribute(
      "transform",
      "rotate(" + (hwAngle % 360) + " 60 60)",
    );
    if (!S.mains || S.scrammed || S.mode === 0 || !S.clutchIn) return; // free-wheel
    S.shim = clamp(S.shim + deltaPercent, 0, 100);
  }

  function bindWheelDrag(node, fn) {
    var dragging = false,
      lastY = 0;
    node.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastY = e.clientY;
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dy = e.clientY - lastY;
      lastY = e.clientY;
      fn(-dy * 0.14);
      render();
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      node.addEventListener(ev, function () {
        dragging = false;
      });
    });
  }

  bindWheelDrag(el.handwheel, driveShim);

  el.handwheel.addEventListener("keydown", function (e) {
    var stepKg = 0.8;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      driveShim(stepKg);
      render();
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      driveShim(-stepKg);
      render();
    }
  });

  /* regulating crank ---------------------------------------------------- */

  var crankAngle = 0;

  function trimReg(dir) {
    crankAngle += dir * 24;
    el.crankArm.setAttribute(
      "transform",
      "rotate(" + (crankAngle % 360) + " 32 32)",
    );
    if (S.mode === 2) return; // regulator owns the vernier in AUTO
    if (!S.mains || !S.clutchIn || S.scrammed) return;
    S.reg = clamp(S.reg + dir * 4, -100, 100);
  }

  el.crank.addEventListener("click", function () {
    trimReg(1);
    render();
  });
  el.crank.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      trimReg(1);
      render();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      trimReg(-1);
      render();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      trimReg(1);
      render();
    }
  });
  bindWheelDrag(el.crank, function (d) {
    var steps = Math.round(d / 4);
    for (var i = 0; i < Math.abs(steps); i++) trimReg(steps > 0 ? 1 : -1);
  });

  /* cooling valve -------------------------------------------------------- */

  var cvAngle = 0;

  function setValve(v, spin) {
    var nv = clamp(v, 0, 100);
    if (spin) cvAngle += (nv - S.valve) * 2.2;
    S.valve = nv;
    if (S.faultFlow && nv >= 85) {
      // opening hard resets the circulator
      S.faultFlow = false;
      S.faultTimers.flow = 0;
    }
  }

  bindWheelDrag(el.valve, function (d) {
    setValve(S.valve + d, true);
    render();
  });

  el.valve.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      setValve(S.valve + 5, true);
      render();
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      setValve(S.valve - 5, true);
      render();
    }
  });

  /* scram, trips and tests ------------------------------------------------ */

  function strikeScram() {
    ensureAudio();
    if (S.mains && !S.scrammed) trip("OPERATOR SCRAM BAR");
    else if (!S.mains) trip("OPERATOR SCRAM BAR"); // bar works dead-panel too
    el.scramBar.classList.add("striking");
    setTimeout(function () {
      el.scramBar.classList.remove("striking");
    }, 220);
    render();
  }
  el.scramBar.addEventListener("click", strikeScram);
  el.scramBar.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      strikeScram();
    }
  });

  el.tripReset.addEventListener("click", function () {
    if (!S.tripLatched) return;
    if (S.power < 2000 && S.fuelTemp < 92) {
      S.tripLatched = false;
      S.scrammed = false;
      S.scramReason = "";
      S.periodHold = 0;
      relayClack();
    }
    render();
  });

  el.coldReset.addEventListener("click", function () {
    reset();
    syncControlFaces();
    render();
  });

  el.accept.addEventListener("click", function () {
    activeAlarms().forEach(function (n) {
      S.accepted[n] = true;
    });
    render();
  });

  function lampTestOn() {
    S.lampTest = true;
    render();
  }
  function lampTestOff() {
    S.lampTest = false;
    render();
  }
  el.lampTestBtn.addEventListener("pointerdown", lampTestOn);
  ["pointerup", "pointerleave"].forEach(function (ev) {
    el.lampTestBtn.addEventListener(ev, lampTestOff);
  });
  el.lampTestBtn.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      lampTestOn();
    }
  });
  el.lampTestBtn.addEventListener("keyup", lampTestOff);

  qa(".trayswitches [data-fault]").forEach(function (sw) {
    sw.addEventListener("click", function () {
      var on = sw.getAttribute("aria-pressed") !== "true";
      sw.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) inject(sw.getAttribute("data-fault"));
      render();
    });
  });

  /* manual dialog --------------------------------------------------------- */

  var dlg = q("dialog[data-manual]");
  q('[data-action="manual"]').addEventListener("click", function () {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  });
  q('[data-action="close-manual"]').addEventListener("click", function () {
    dlg.close ? dlg.close() : dlg.removeAttribute("open");
  });

  function syncControlFaces() {
    el.mains.setAttribute("aria-pressed", "false");
    el.chartMotor.setAttribute("aria-pressed", "false");
    el.detHt.setAttribute("aria-pressed", "false");
    el.clutch.setAttribute("aria-pressed", "false");
    S.detector = 0;
    applyDetector();
    S.mode = 0;
    applyMode();
    qa(".trayswitches [data-fault]").forEach(function (sw) {
      sw.setAttribute("aria-pressed", "false");
    });
    hwAngle = 0;
    el.hwSpin.setAttribute("transform", "rotate(0 60 60)");
    crankAngle = 0;
    el.crankArm.setAttribute("transform", "rotate(0 32 32)");
    cvAngle = 0;
  }

  /* ------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------ */

  function render() {
    var st = S;
    var live = st.mains;

    /* needles ------------------------------------------------------------ */
    var cAng = live && st.counts > 0.5 ? logCountAngle(st.counts) : -56;
    el.countNeedle.setAttribute(
      "transform",
      "rotate(" + cAng.toFixed(2) + " 60 72)",
    );
    var pAng = live && st.power > 0.2 ? periodAngle(st.period) : -56;
    if (live && st.power > 0.2 && st.period >= 9999) pAng = 54;
    pAng = clamp(pAng, -56, 56);
    el.periodNeedle.setAttribute(
      "transform",
      "rotate(" + pAng.toFixed(2) + " 60 72)",
    );
    var rAng = live ? (clamp(st.rho, -210, 210) / 200) * 46 : 0;
    el.rhoNeedle.setAttribute(
      "transform",
      "rotate(" + rAng.toFixed(2) + " 60 60)",
    );

    /* readouts ------------------------------------------------------------ */
    el.countsReadout.textContent = live ? fmtCounts(st.counts) : "\u2014";
    el.periodReadout.textContent = live
      ? st.period >= 9999
        ? "\u221e SEC"
        : st.period < 0
          ? "FALLING"
          : st.period.toFixed(1) + " SEC"
      : "\u2014";
    el.shimReadout.textContent = Math.round(st.shim) + "%";
    el.regReadout.textContent = (st.reg >= 0 ? "+" : "") + Math.round(st.reg);
    el.valveReadout.textContent =
      st.valve < 2 ? "SHUT" : Math.round(st.valve) + "%";
    el.fuelReadout.textContent = Math.round(st.fuelTemp) + "\u00b0";
    el.poolReadout.textContent = Math.round(st.poolTemp) + "\u00b0";
    el.flowReadout.textContent = Math.round(loopFlowPct()) + "%";

    el.handwheel.setAttribute("aria-valuenow", String(Math.round(st.shim)));

    /* decade neons --------------------------------------------------------- */
    var lg =
      live && st.counts > 0
        ? Math.floor(Math.log10(Math.max(st.counts, 1)))
        : -1;
    el.decades.forEach(function (lamp) {
      var d = parseInt(lamp.getAttribute("data-d"), 10);
      lamp.classList.toggle("on", st.lampTest || d <= lg);
    });

    /* mimic ---------------------------------------------------------------- */
    var rodY = 110 - 0.78 * st.shim;
    el.shimRod.setAttribute("y", rodY.toFixed(1));
    el.shimPin.style.top = 93 - 0.93 * st.shim + "%";
    var regY = 58 - 0.16 * st.reg;
    el.regRod.setAttribute("y", regY.toFixed(1));
    el.coreGlow.style.opacity = live
      ? clamp(
          (Math.log10(Math.max(st.power, 0.02)) + 1.5) / 5.5,
          0,
          0.5,
        ).toFixed(2)
      : 0;
    el.valveDisc.setAttribute(
      "transform",
      "rotate(" + (st.valve * 2.7).toFixed(1) + " 98 100)",
    );
    el.cvSpin.setAttribute(
      "transform",
      "rotate(" + (cvAngle % 360).toFixed(1) + " 55 55)",
    );

    /* thermals --------------------------------------------------------------- */
    el.fuelBulb.style.height =
      clamp(((st.fuelTemp - 15) / 110) * 100, 4, 100).toFixed(1) + "%";
    el.fuelBulb.style.background =
      st.fuelTemp > TEMP_ALARM_C
        ? "linear-gradient(90deg,#8f1d14,#ff7a5c 50%,#8f1d14)"
        : "linear-gradient(90deg,#a3231a,#d8503f 50%,#8f1d14)";
    el.poolBulb.style.height =
      clamp(((st.poolTemp - 15) / 50) * 100, 4, 100).toFixed(1) + "%";
    el.flowPellet.style.bottom = (4 + 0.84 * loopFlowPct()).toFixed(1) + "%";

    /* critical eye ------------------------------------------------------------ */
    el.criticalLamp.classList.toggle(
      "on",
      live &&
        Math.abs(st.rho) < 8 &&
        st.power > 5 &&
        st.mode !== 0 &&
        !st.scrammed,
    );

    /* annunciators -------------------------------------------------------------- */
    var act = {};
    activeAlarms().forEach(function (n) {
      act[n] = true;
    });
    ALARM_NAMES.forEach(function (n) {
      var win = el.windows[n];
      if (!win) return;
      var on = act[n];
      win.classList.toggle("lit", !!on || st.lampTest);
      win.classList.toggle("flash", !!on && !st.accepted[n]);
      win.classList.toggle("steady", !!on && !!st.accepted[n]);
    });

    el.scramBar.classList.toggle("fired", st.scrammed);

    drawChart();
  }

  function fmtCounts(cps) {
    if (cps >= 100000) return (cps / 1000).toFixed(0) + "k";
    if (cps >= 10000) return (cps / 1000).toFixed(1) + "k";
    if (cps >= 1000) return (cps / 1000).toFixed(2) + "k";
    return cps.toFixed(1);
  }

  /* ------------------------------------------------------------------
     Animation loop
     ------------------------------------------------------------------ */

  var lastStamp = null;
  var rafId = null;

  function frame(now) {
    rafId = null;
    if (document.hidden) {
      lastStamp = null;
      return;
    }
    if (lastStamp !== null) {
      var dt = (now - lastStamp) / 1000;
      if (dt > 0 && dt < 2) tick(dt);
    }
    lastStamp = now;
    render();
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId === null && !document.hidden) {
      lastStamp = null;
      rafId = requestAnimationFrame(frame);
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) startLoop();
  });

  /* ------------------------------------------------------------------ */

  syncControlFaces();
  render();
  startLoop();
})();
