/*
 * Creag Dhubh Hydro-Electric Station - No. 1 Machine Control Bench.
 * One 12 MW vertical Francis set: loch, dam, intake, surge shaft,
 * penstock, turbine, generator, 11 kV machine bus and 33 kV grid bus.
 * North of Scotland Hydro-Electric Board practice, 1956.
 *
 * All behaviour lives here. window.machine exposes the fixed API:
 *   name, faults[], state(), tick(seconds), inject(fault), reset()
 */
(function () {
  "use strict";

  var MACHINE_NAME = "Creag Dhubh Hydro-Electric Station - No. 1 Machine";
  var FAULTS = [
    "governor oil pressure loss",
    "bearing cooling water loss",
    "load rejection",
  ];

  var ALARM_NAMES = [
    "FOREBAY LOW",
    "SURGE HIGH",
    "GOVERNOR OIL LOW",
    "BRG WATER LOW",
    "GUIDE BRG HOT",
    "OVERSPEED",
    "LOAD REJECTION",
    "INCORRECT SYNC",
  ];

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  function $(sel) {
    return document.querySelector(sel);
  }
  function $all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function approach(v, target, maxStep) {
    if (v < target) return Math.min(target, v + maxStep);
    return Math.max(target, v - maxStep);
  }
  function svgEl(name, attrs, parent) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k))
        e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function polar(cx, cy, r, angDeg) {
    var a = ((angDeg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  var S = coldState();

  function coldState() {
    return {
      t: 0,
      forebay: 6.2,
      miv: 0,
      mivTarget: 0,
      gate: 0,
      gateCmd: 0,
      autoTrim: 0,
      govMode: "OFF",
      qPen: 0,
      qDot: 0,
      hTurb: 118,
      surge: 0,
      surgeV: 0,
      rpm: 0,
      freq: 50,
      fieldA: 0,
      volts: 0,
      mw: 0,
      mvar: 0,
      oil: 20.5,
      brgTemp: 19,
      pumpOn: false,
      phase: 0,
      synced: false,
      breaker: false,
      tripped: false,
      tripCause: null,
      damaged: false,
      leakOn: false,
      coolFault: false,
      rejectLatch: false,
      badSyncLeft: 0,
      runnerDeg: 0,
      dash: 0,
      busPhase: 0,
      alarms: [],
      unacked: {},
    };
  }

  var CFG = {
    qRated: 12,
    hRef: 115,
    pK: 0.008829,
    tw: 5.0,
    forebayArea: 1500,
    oilAlarm: 16,
    oilServoMin: 9,
    tempAlarm: 68,
    tempTrip: 88,
    surgeAlarm: 2.2,
    surgeTrip: 3.3,
    forebayAlarm: 3.4,
    forebayTrip: 2.0,
    overspeedAlarm: 1.12,
    overspeedTrip: 1.4,
  };

  function gridFreq(t) {
    return (
      50 + 0.05 * Math.sin(t * 0.008 + 1.1) + 0.03 * Math.sin(t * 0.021 + 4.2)
    );
  }
  function riverFlow(t) {
    return (
      11 + 1.6 * Math.sin(t * 0.011 + 0.7) + 0.9 * Math.sin(t * 0.041 + 3.0)
    );
  }

  function raiseCheck(list, cond, name) {
    if (cond && list.indexOf(name) === -1) list.push(name);
  }

  function computeAlarms() {
    var list = [];
    var n = S.rpm / 375;
    var running = n > 0.05 || S.gate > 4 || S.qPen > 0.3;
    raiseCheck(list, S.forebay < CFG.forebayAlarm, "FOREBAY LOW");
    raiseCheck(list, S.surge > CFG.surgeAlarm, "SURGE HIGH");
    raiseCheck(list, S.oil < CFG.oilAlarm, "GOVERNOR OIL LOW");
    raiseCheck(list, S.coolFault || (!S.pumpOn && running), "BRG WATER LOW");
    raiseCheck(list, S.brgTemp >= CFG.tempAlarm, "GUIDE BRG HOT");
    raiseCheck(list, n >= CFG.overspeedAlarm, "OVERSPEED");
    raiseCheck(list, S.rejectLatch, "LOAD REJECTION");
    raiseCheck(list, S.badSyncLeft > 0, "INCORRECT SYNC");
    S.alarms = list;
  }

  function trip(cause) {
    if (S.tripped) return;
    S.tripped = true;
    S.tripCause = cause;
    S.damaged = true;
    S.breaker = false;
    S.synced = false;
  }

  // ------------------------------------------------------------------
  // one integration step (dt seconds)
  // ------------------------------------------------------------------
  function step(dt) {
    S.t += dt;
    var fg = gridFreq(S.t);
    var n = S.rpm / 375;

    // main inlet valve
    S.miv = approach(S.miv, S.mivTarget, 4.5 * dt);
    if (S.tripped) S.miv = approach(S.miv, 0, 7 * dt);
    var flowFactor = clamp(S.miv / 100, 0, 1);

    // governor
    var oilOk = S.oil > CFG.oilServoMin;
    var target = null;
    var rate = 0;
    if (S.tripped) {
      target = 0;
      rate = oilOk ? 16 : 2;
    } else if (S.govMode === "OFF") {
      target = 0;
      rate = 6; // gates fall shut on their weight with oil released
    } else if (S.govMode === "HAND") {
      target = S.gateCmd;
      rate = oilOk ? 2.4 : 0.7;
    } else {
      if (!S.breaker) {
        // isochronous governing: a proportional brake plus a slow
        // integral trim that hunts out the last of the error
        var err = 50 - S.freq;
        S.autoTrim = clamp(S.autoTrim + err * 0.25 * dt, -115, 115);
        // a gentle governor hunt so the phase creeps for synchronising
        var hunt = Math.sin(S.t * 0.11) * 1.6;
        target = clamp(
          S.gateCmd + 2.5 * err + S.autoTrim + hunt,
          0,
          100
        );
      } else {
        target = S.gateCmd;
      }
      rate = oilOk ? 9 : 1;
    }
    var gOld = S.gate;
    if (target !== null) S.gate = approach(S.gate, target, rate * dt);
    var dgUsed = Math.abs(S.gate - gOld);

    // governor oil
    var recharge = (21 - S.oil) * (S.rpm > 5 ? 0.02 : 0.007);
    S.oil += recharge * dt;
    S.oil -= dgUsed * 0.055 + dt * 0.004;
    if (S.leakOn) S.oil -= 0.55 * dt;
    S.oil = clamp(S.oil, 0, 21.5);

    // hydraulics
    var hNet = 118 + (S.forebay - 6) * 1.8 - 4.2 * Math.pow(S.qPen / 12, 2);
    hNet -= 2.0 * S.qDot;
    S.hTurb = hNet;
    var qWant =
      (S.gate / 100) *
      flowFactor *
      CFG.qRated *
      Math.sqrt(Math.max(10, hNet) / CFG.hRef);
    S.qDot = (qWant - S.qPen) / CFG.tw;
    S.qPen = clamp(S.qPen + S.qDot * dt, 0, 14);

    // surge shaft oscillation
    var w0 = 0.25;
    var zeta = 0.07;
    S.surgeV +=
      (-w0 * w0 * S.surge - 2 * zeta * w0 * S.surgeV + (S.qPen - qWant) / 38) *
      dt;
    S.surge = clamp(S.surge + S.surgeV * dt, -3.8, 4.2);

    // forebay storage
    S.forebay = clamp(
      S.forebay + ((riverFlow(S.t) - S.qPen) / CFG.forebayArea) * dt,
      0,
      10,
    );
    if (S.forebay < CFG.forebayAlarm) S.gate = Math.min(S.gate, 45);

    // turbine power: torque falls to nothing at runaway (about 1.8x),
    // so an unloaded set with her gates open will race towards it
    var spdFac = Math.max(0, (4 * n * (1.8 - n)) / 3.24);
    var pw = CFG.pK * S.hTurb * qWant * spdFac;

    // rotor & generator
    if (S.breaker && S.synced) {
      n = fg / 50;
      S.rpm = n * 375;
      S.freq = fg;
      S.mw += (pw - S.mw) * clamp(dt / 1.4, 0, 1);
      var epu = S.fieldA / 7;
      S.mvar = clamp(((epu - 1) / 1.1) * 14, -7, 9);
      S.volts = 11;
    } else {
      S.mw = 0;
      S.mvar = 0;
      var accel = (pw - 0.35 * n * n) / 260;
      // runner churning in residual water brings a shut-down set to rest
      if (!S.breaker && pw < 0.05) accel -= n * 0.05;
      n = clamp(n + accel * dt, 0, 1.85);
      S.rpm = n * 375;
      S.freq += (n * 50 - S.freq) * clamp(dt * 6, 0, 1);
      S.volts = clamp((11 * S.fieldA) / 7, 0, 13.6);
    }

    // synchroscope phase
    if (!S.synced && n > 0.05) {
      S.phase += (S.freq - fg) * 360 * dt;
      if (S.phase > 3600000 || S.phase < -3600000) S.phase = S.phase % 360;
    }

    // bearing temperature
    var cooling = S.coolFault ? 0.05 : S.pumpOn ? 1 : 0.06;
    var teq = 13 + n * n * (cooling >= 0.95 ? 34 : 130);
    var tau = cooling >= 0.95 ? 110 : 80;
    S.brgTemp += ((teq - S.brgTemp) / tau) * dt;

    // decorative accumulators
    S.runnerDeg = (S.runnerDeg + S.rpm * dt * 0.55) % 360;
    S.dash += (S.qPen * 14 + 2) * dt;
    if (S.breaker && S.synced) S.busPhase += (S.mw * 2.4 + 0.001) * dt;

    // trips
    if (n >= CFG.overspeedTrip) trip("OVERSPEED");
    if (S.brgTemp >= CFG.tempTrip) trip("GUIDE BEARING TEMPERATURE");
    if (S.surge >= CFG.surgeTrip) trip("SURGE CHAMBER OVERPRESSURE");
    if (S.forebay <= CFG.forebayTrip && S.gate > 8) trip("INTAKE VORTEX");

    if (S.badSyncLeft > 0) S.badSyncLeft = Math.max(0, S.badSyncLeft - dt);

    computeAlarms();
  }

  function tick(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s <= 0) return;
    s = Math.min(s, 7200);
    var remaining = s;
    var guard = 0;
    while (remaining > 1e-9 && guard < 200000) {
      var dt = Math.min(0.05, remaining);
      step(dt);
      remaining -= dt;
      guard++;
    }
  }

  // ------------------------------------------------------------------
  // fixed API
  // ------------------------------------------------------------------
  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f.indexOf("oil") !== -1) {
      S.leakOn = true;
      setSwitch(elFtOil, true);
    } else if (f.indexOf("cool") !== -1 || f.indexOf("water") !== -1) {
      S.coolFault = true;
      setSwitch(elFtCool, true);
    } else if (f.indexOf("reject") !== -1 || f.indexOf("load") !== -1) {
      if (S.breaker) {
        S.breaker = false;
        S.synced = false;
      }
      S.rejectLatch = true;
      flashMomentary();
    }
    render();
  }

  function reset() {
    S = coldState();
    syncControlsFromState();
    prevAlarms = [];
    render();
  }

  function state() {
    return {
      time: Math.round(S.t * 1000) / 1000,
      mivOpening: Math.round(S.miv * 10) / 10,
      gateOpening: Math.round(S.gate * 10) / 10,
      gateCommand: Math.round(S.gateCmd * 10) / 10,
      governorMode: S.govMode,
      penstockFlow: Math.round(S.qPen * 100) / 100,
      netHead: Math.round(S.hTurb * 10) / 10,
      surgeLevel: Math.round(S.surge * 100) / 100,
      forebayLevel: Math.round(S.forebay * 100) / 100,
      rpm: Math.round(S.rpm * 10) / 10,
      frequency: Math.round(S.freq * 1000) / 1000,
      voltageKV: Math.round(S.volts * 100) / 100,
      megawatts: Math.round(S.mw * 100) / 100,
      megavars: Math.round(S.mvar * 100) / 100,
      excitationA: Math.round(S.fieldA * 100) / 100,
      oilPressureBar: Math.round(S.oil * 100) / 100,
      bearingTempC: Math.round(S.brgTemp * 10) / 10,
      bearingWaterFlow: S.coolFault ? 0.05 : S.pumpOn ? 1 : 0.06,
      syncAngleDeg: Math.round((((S.phase % 360) + 360) % 360) * 10) / 10,
      breakerClosed: !!S.breaker,
      synchronised: !!S.synced,
      tripped: !!S.tripped,
      tripCause: S.tripCause,
      damaged: !!S.damaged,
      alarms: S.alarms.slice(),
    };
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  // ==================================================================
  // instrument faces, generated once
  // ==================================================================
  var SWEEP_START = -122;
  var SWEEP = 244;

  var DIAL_CFG = {
    forebay: {
      name: "FOREBAY LEVEL",
      unit: "METRES",
      min: 0,
      max: 10,
      stepMajor: 2,
      stepMinor: 0.5,
      arcs: [{ from: 0, to: 3.4, color: "#c77b2e" }],
      marks: [{ v: 3.4 }],
    },
    surge: {
      name: "SURGE SHAFT",
      unit: "+ UP / \u2212 DOWN, M",
      min: -3.5,
      max: 3.5,
      stepMajor: 1,
      stepMinor: 0.5,
      arcs: [{ from: 2.2, to: 3.5, color: "#b3261c" }],
      marks: [{ v: 2.2 }],
    },
    press: {
      name: "PENSTOCK PRESSURE",
      unit: "M HEAD",
      min: 0,
      max: 160,
      stepMajor: 40,
      stepMinor: 10,
    },
    oil: {
      name: "GOVERNOR OIL",
      unit: "BAR",
      min: 0,
      max: 25,
      stepMajor: 5,
      stepMinor: 1,
      arcs: [{ from: 0, to: 9, color: "#b3261c" }],
    },
    volts: {
      name: "MACHINE VOLTS",
      unit: "KILOVOLTS",
      min: 0,
      max: 13.5,
      stepMajor: 3,
      stepMinor: 0.75,
      arcs: [{ from: 10.4, to: 11.6, color: "#2e6e46" }],
      numFormat: function (v) {
        return v.toFixed(1);
      },
    },
    mw: {
      name: "MEGAWATTS",
      unit: "MW",
      min: 0,
      max: 14,
      stepMajor: 2,
      stepMinor: 0.5,
      arcs: [
        { from: 6, to: 11, color: "#2e6e46" },
        { from: 12.2, to: 14, color: "#b3261c" },
      ],
    },
    gridhz: {
      name: "BUS FREQUENCY",
      unit: "HERTZ",
      min: 48.5,
      max: 51.5,
      stepMajor: 0.5,
      stepMinor: 0.1,
      arcs: [{ from: 49.85, to: 50.15, color: "#2e6e46" }],
      numFormat: function (v) {
        return v.toFixed(1);
      },
    },
    temp: {
      name: "GUIDE BEARING",
      unit: "DEG C",
      min: 0,
      max: 100,
      stepMajor: 20,
      stepMinor: 5,
      arcs: [
        { from: 68, to: 88, color: "#c77b2e" },
        { from: 88, to: 100, color: "#b3261c" },
      ],
    },
  };

  function arcPath(cx, cy, r, a1, a2) {
    var p1 = polar(cx, cy, r, a1);
    var p2 = polar(cx, cy, r, a2);
    var large = Math.abs(a2 - a1) > 180 ? 1 : 0;
    return (
      "M" +
      p1[0].toFixed(1) +
      "," +
      p1[1].toFixed(1) +
      " A" +
      r +
      "," +
      r +
      " 0 " +
      large +
      " 1 " +
      p2[0].toFixed(1) +
      "," +
      p2[1].toFixed(1)
    );
  }

  function buildDial(key) {
    var cfg = DIAL_CFG[key];
    var W = 200,
      H = 176,
      cx = 100,
      cy = 82,
      R = 70;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H });
    svgEl("circle", { class: "df-face", cx: cx, cy: cy, r: R }, svg);
    svgEl("circle", { class: "df-bezel", cx: cx, cy: cy, r: R }, svg);
    var vToAng = function (v) {
      return SWEEP_START + ((v - cfg.min) / (cfg.max - cfg.min)) * SWEEP;
    };
    (cfg.arcs || []).forEach(function (a) {
      svgEl(
        "path",
        {
          class: "df-arc",
          stroke: a.color,
          "stroke-width": 7,
          d: arcPath(cx, cy, R - 13, vToAng(a.from), vToAng(a.to)),
        },
        svg,
      );
    });
    var tick, isMaj, ang, p1, p2;
    for (tick = cfg.min; tick <= cfg.max + 1e-9; tick += cfg.stepMinor) {
      var majTest = tick / cfg.stepMajor;
      isMaj = Math.abs(majTest - Math.round(majTest)) < 1e-6;
      ang = vToAng(tick);
      p1 = polar(cx, cy, R - 5, ang);
      p2 = polar(cx, cy, R - (isMaj ? 18 : 12), ang);
      svgEl(
        "line",
        {
          class: isMaj ? "df-tickmaj" : "df-tickmin",
          x1: p1[0].toFixed(1),
          y1: p1[1].toFixed(1),
          x2: p2[0].toFixed(1),
          y2: p2[1].toFixed(1),
        },
        svg,
      );
    }
    for (tick = cfg.min; tick <= cfg.max + 1e-9; tick += cfg.stepMajor) {
      ang = vToAng(tick);
      var pl = polar(cx, cy, R - 29, ang);
      var lab = cfg.numFormat ? cfg.numFormat(tick) : String(+tick.toFixed(2));
      var t = svgEl(
        "text",
        {
          class: "df-num",
          "font-size": 11.5,
          "text-anchor": "middle",
          x: pl[0].toFixed(1),
          y: (pl[1] + 4).toFixed(1),
        },
        svg,
      );
      t.textContent = lab;
    }
    (cfg.marks || []).forEach(function (m) {
      var am = vToAng(m.v);
      var q1 = polar(cx, cy, R - 20, am);
      var q2 = polar(cx, cy, R - 4, am);
      svgEl(
        "line",
        {
          stroke: "#b3261c",
          "stroke-width": 2.5,
          x1: q1[0].toFixed(1),
          y1: q1[1].toFixed(1),
          x2: q2[0].toFixed(1),
          y2: q2[1].toFixed(1),
        },
        svg,
      );
    });
    var needle = svgEl("g", {}, svg);
    svgEl(
      "line",
      { class: "df-needle", x1: cx, y1: cy, x2: cx, y2: cy - (R - 22) },
      needle,
    );
    svgEl("circle", { class: "df-cap", cx: cx, cy: cy, r: 6 }, svg);
    var nm = svgEl(
      "text",
      {
        class: "df-name",
        "font-size": 11.5,
        "text-anchor": "middle",
        x: cx,
        y: H - 8,
      },
      svg,
    );
    nm.textContent = cfg.name;
    var un = svgEl(
      "text",
      {
        class: "df-unit",
        "font-size": 9,
        "text-anchor": "middle",
        x: cx,
        y: cy + 26,
      },
      svg,
    );
    un.textContent = cfg.unit;
    return { svg: svg, needle: needle, vToAng: vToAng, cx: cx, cy: cy };
  }

  function buildBigDial() {
    var W = 240,
      H = 212,
      cx = 120,
      cy = 98,
      R = 88;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H });
    svgEl("circle", { class: "df-face", cx: cx, cy: cy, r: R }, svg);
    svgEl("circle", { class: "df-bezel", cx: cx, cy: cy, r: R }, svg);
    var i, a, p1, p2, pt, maj;
    for (i = 0; i <= 750; i += 25) {
      a = SWEEP_START + (i / 750) * SWEEP;
      maj = i % 75 === 0;
      p1 = polar(cx, cy, R - 7, a);
      p2 = polar(cx, cy, R - (maj ? 19 : 13), a);
      svgEl(
        "line",
        {
          class: maj ? "df-tickmaj" : "df-tickmin",
          x1: p1[0].toFixed(1),
          y1: p1[1].toFixed(1),
          x2: p2[0].toFixed(1),
          y2: p2[1].toFixed(1),
        },
        svg,
      );
    }
    for (i = 0; i <= 750; i += 150) {
      a = SWEEP_START + (i / 750) * SWEEP;
      pt = polar(cx, cy, R - 31, a);
      var t = svgEl(
        "text",
        {
          class: "df-num",
          "font-size": 12,
          "text-anchor": "middle",
          x: pt[0].toFixed(1),
          y: (pt[1] + 4).toFixed(1),
        },
        svg,
      );
      t.textContent = String(i);
    }
    svgEl(
      "path",
      {
        class: "df-arc",
        stroke: "#b3261c",
        "stroke-width": 5,
        d: arcPath(
          cx,
          cy,
          R - 11,
          SWEEP_START + (420 / 750) * SWEEP,
          SWEEP_START + SWEEP,
        ),
      },
      svg,
    );
    for (i = 40; i <= 60; i += 0.5) {
      a = SWEEP_START + ((i - 40) / 20) * SWEEP;
      maj = i % 5 === 0;
      p1 = polar(cx, cy, R - 44, a);
      p2 = polar(cx, cy, R - (maj ? 54 : 49), a);
      svgEl(
        "line",
        {
          class: maj ? "df-tickmaj" : "df-tickmin",
          x1: p1[0].toFixed(1),
          y1: p1[1].toFixed(1),
          x2: p2[0].toFixed(1),
          y2: p2[1].toFixed(1),
        },
        svg,
      );
    }
    for (i = 40; i <= 60; i += 5) {
      a = SWEEP_START + ((i - 40) / 20) * SWEEP;
      pt = polar(cx, cy, R - 66, a);
      var t2 = svgEl(
        "text",
        {
          class: "df-num",
          "font-size": 10.5,
          "text-anchor": "middle",
          x: pt[0].toFixed(1),
          y: (pt[1] + 4).toFixed(1),
        },
        svg,
      );
      t2.textContent = String(i);
    }
    var nm = svgEl(
      "text",
      {
        class: "df-name",
        "font-size": 11.5,
        "text-anchor": "middle",
        x: cx,
        y: H - 6,
      },
      svg,
    );
    nm.textContent = "REV/MIN \u2014 HERTZ";
    var needle = svgEl("g", {}, svg);
    svgEl(
      "line",
      { class: "df-needle", x1: cx, y1: cy, x2: cx, y2: cy - (R - 24) },
      needle,
    );
    var needle2 = svgEl("g", {}, svg);
    svgEl(
      "line",
      { class: "df-needle2", x1: cx, y1: cy, x2: cx, y2: cy - (R - 46) },
      needle2,
    );
    svgEl("circle", { class: "df-cap", cx: cx, cy: cy, r: 7 }, svg);
    return { svg: svg, needle: needle, needle2: needle2 };
  }

  var dials = {};
  $all("[data-dial]").forEach(function (box) {
    var key = box.getAttribute("data-dial");
    var d;
    if (key === "tacho") d = buildBigDial();
    else if (DIAL_CFG[key]) d = buildDial(key);
    if (!d) return;
    box.appendChild(d.svg);
    dials[key] = d;
  });

  function angFor(min, max, v) {
    return SWEEP_START + ((clamp(v, min, max) - min) / (max - min)) * SWEEP;
  }
  function rot(d, deg) {
    d.needle.setAttribute(
      "transform",
      "rotate(" + deg.toFixed(2) + " " + d.cx + " " + d.cy + ")",
    );
  }

  // ==================================================================
  // element refs
  // ==================================================================
  var bench = $("#bench");
  var dlg = $("dialog[data-manual]");
  var tiles = {};
  $all("[data-alarm]").forEach(function (t) {
    tiles[t.getAttribute("data-alarm")] = t;
  });
  var pilotAux = $('[data-pilot="aux"]');
  var pilotLoad = $('[data-pilot="onload"]');
  var pilotTrip = $('[data-pilot="trip"]');
  var servoJewel = $('[data-jewel="servo"]');
  var lampInWindow = $("#lamp-inwindow");
  var lampClosed = $("#lamp-closed");
  var lampSlow = $("#lamp-slow");
  var lampFast = $("#lamp-fast");
  var syPtr = $("#sy-pointer");

  var lochMove = $("#loch-move");
  var surgeWater = $("#surge-water");
  var tailraceWater = $("#tailrace-water");
  var runner = $("#runner");
  var flowLoch = $("#flow-loch");
  var flowConduit = $("#flow-conduit");
  var flowPen = $("#flow-penstock");
  var flowTail = $("#flow-tailrace");
  var busDots = [];
  (function () {
    var g = $("#bus-dots");
    for (var i = 0; i < 3; i++) {
      busDots.push(svgEl("rect", { x: 1064, y: 228, width: 7, height: 8 }, g));
    }
  })();

  var mivBox = $("#miv");
  var mivLever = $("#miv-lever");
  var mivDrum = $("#miv-drum");
  var scBox = $("#speed-changer");
  var scDrum = $("#sc-drum");
  var wheelSvg = scBox.querySelector(".wheel");
  var excBox = $("#exc-knob");
  var excFace = $("#knob-face");
  var excDrum = $("#exc-drum");
  var govPointer = $("#gov-pointer");
  var radios = $all('#gov-sel button[role="radio"]');
  var brkrGuard = $("#brkr-guard");
  var brkrHandle = $("#brkr-handle");
  var brkrPtr = $("#brkr-pointer");
  var elPump = $("#pump-toggle");
  var elFtOil = $("#ft-oil");
  var elFtCool = $("#ft-cooling");
  var elFtRej = $("#ft-reject");

  var POS_ANGLE = { OFF: -52, HAND: 0, AUTO: 52 };
  var guardOpen = false;
  var ptrTimer = null;
  var momTimer = null;
  var prevAlarms = [];

  // ==================================================================
  // controls
  // ==================================================================
  $('[data-action="manual"]').addEventListener("click", function () {
    if (!dlg.open) dlg.showModal();
  });
  $('[data-action="close-manual"]').addEventListener("click", function () {
    if (dlg.open) dlg.close();
  });

  function fmtDrum(elNum, v, digits) {
    var s = String(Math.round(clamp(v, 0, 999)));
    while (s.length < digits) s = "0" + s;
    elNum.textContent = s;
  }

  function attachDrag(el, onDelta) {
    var lastY = null;
    el.addEventListener("pointerdown", function (e) {
      lastY = e.clientY;
      try {
        if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
      } catch (err) {}
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (lastY === null) return;
      var dy = e.clientY - lastY;
      lastY = e.clientY;
      onDelta(dy);
    });
    function end() {
      lastY = null;
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function mivSet(v) {
    S.mivTarget = clamp(Math.round(v / 5) * 5, 0, 100);
    renderControls();
  }
  mivBox.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "Enter")
      mivSet(S.mivTarget + 5);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
      mivSet(S.mivTarget - 5);
    else if (e.key === "Home") mivSet(0);
    else if (e.key === "End") mivSet(100);
    else return;
    e.preventDefault();
  });
  attachDrag(mivBox, function (dy) {
    mivSet(S.mivTarget - dy * 0.6);
  });

  function scSet(v) {
    S.gateCmd = clamp(Math.round(v), 0, 100);
    renderControls();
  }
  scBox.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") scSet(S.gateCmd + 2);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
      scSet(S.gateCmd - 2);
    else if (e.key === "PageUp") scSet(S.gateCmd + 10);
    else if (e.key === "PageDown") scSet(S.gateCmd - 10);
    else if (e.key === "Home") scSet(0);
    else if (e.key === "End") scSet(100);
    else return;
    e.preventDefault();
  });
  attachDrag(scBox, function (dy) {
    scSet(S.gateCmd - dy * 0.5);
  });

  function excSet(v) {
    S.fieldA = clamp(Math.round(v * 5) / 5, 0, 10);
    renderControls();
  }
  excBox.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") excSet(S.fieldA + 0.2);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
      excSet(S.fieldA - 0.2);
    else if (e.key === "Home") excSet(0);
    else if (e.key === "End") excSet(10);
    else return;
    e.preventDefault();
  });
  attachDrag(excBox, function (dy) {
    excSet(S.fieldA - dy * 0.04);
  });

  function selectPos(pos) {
    S.govMode = pos;
    if (pos !== "AUTO") S.autoTrim = 0;
    radios.forEach(function (r) {
      var on = r.getAttribute("data-pos") === pos;
      r.setAttribute("aria-checked", on ? "true" : "false");
      r.tabIndex = on ? 0 : -1;
    });
    renderControls();
  }
  radios.forEach(function (r, i) {
    r.addEventListener("click", function () {
      selectPos(r.getAttribute("data-pos"));
    });
    r.addEventListener("keydown", function (e) {
      var d = 0;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") d = -1;
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") d = 1;
      if (!d) return;
      e.preventDefault();
      var nx = (i + d + radios.length) % radios.length;
      radios[nx].focus();
      selectPos(radios[nx].getAttribute("data-pos"));
    });
  });

  brkrGuard.addEventListener("click", function () {
    guardOpen = !guardOpen;
    brkrHandle.disabled = !guardOpen || S.tripped;
    brkrGuard.setAttribute("aria-expanded", guardOpen ? "true" : "false");
    brkrGuard.textContent = guardOpen ? "COVER LIFTED" : "GUARD";
  });

  function swingPointer(deg) {
    brkrPtr.style.transform = "rotate(" + deg + "deg)";
    if (ptrTimer) clearTimeout(ptrTimer);
    ptrTimer = setTimeout(function () {
      brkrPtr.style.transform = "rotate(0deg)";
    }, 480);
  }

  function tryClose() {
    var fg = gridFreq(S.t);
    var ph = ((S.phase % 360) + 360) % 360;
    var ad = Math.min(ph, 360 - ph);
    if (
      Math.abs(S.freq - fg) <= 0.25 &&
      ad <= 18 &&
      Math.abs(S.volts - 11) <= 0.55 &&
      S.rpm > 60
    ) {
      S.breaker = true;
      S.synced = true;
      S.autoTrim = clamp(S.gate - S.gateCmd, -105, 105);
      S.rejectLatch = false;
      S.badSyncLeft = 0;
    } else {
      S.badSyncLeft = 9;
    }
  }

  brkrHandle.addEventListener("click", function () {
    if (!guardOpen || S.tripped) return;
    if (S.breaker) {
      S.breaker = false;
      S.synced = false;
      swingPointer(-42);
    } else {
      tryClose();
      swingPointer(42);
    }
    render();
  });

  function setSwitch(btn, on) {
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }

  elPump.addEventListener("click", function () {
    S.pumpOn = !S.pumpOn;
    setSwitch(elPump, S.pumpOn);
    render();
  });
  elFtOil.addEventListener("click", function () {
    S.leakOn = !S.leakOn;
    setSwitch(elFtOil, S.leakOn);
    render();
  });
  elFtCool.addEventListener("click", function () {
    S.coolFault = !S.coolFault;
    setSwitch(elFtCool, S.coolFault);
    render();
  });
  elFtRej.addEventListener("click", function () {
    inject("load rejection");
  });
  function flashMomentary() {
    setSwitch(elFtRej, true);
    if (momTimer) clearTimeout(momTimer);
    momTimer = setTimeout(function () {
      setSwitch(elFtRej, false);
    }, 350);
  }
  $("#tc-lid").addEventListener("click", function () {
    var open = $("#test-cover").classList.toggle("open");
    this.setAttribute("aria-expanded", open ? "true" : "false");
    this.textContent = open
      ? "FAULT TEST SWITCHES \u2014 REPLACE LID"
      : "FAULT TEST SWITCHES \u2014 LIFT LID";
  });
  $("#lamp-test-btn").addEventListener("click", function () {
    bench.classList.add("lamp-test");
    setTimeout(function () {
      bench.classList.remove("lamp-test");
    }, 1700);
  });
  $("#accept-btn").addEventListener("click", function () {
    for (var k in S.unacked) delete S.unacked[k];
    render();
  });
  $("#reset-btn").addEventListener("click", function () {
    reset();
  });

  function renderControls() {
    var ang = 105 - S.mivTarget * 1.35;
    mivLever.style.transform = "rotate(" + ang + "deg)";
    mivBox.setAttribute("aria-valuenow", String(Math.round(S.mivTarget)));
    fmtDrum(mivDrum, S.mivTarget, 3);
    wheelSvg.style.transform = "rotate(" + S.gateCmd * 7.2 + "deg)";
    scBox.setAttribute("aria-valuenow", String(Math.round(S.gateCmd)));
    fmtDrum(scDrum, S.gateCmd, 3);
    excFace.style.transform = "rotate(" + (-135 + S.fieldA * 27) + "deg)";
    excBox.setAttribute("aria-valuenow", S.fieldA.toFixed(1));
    excDrum.textContent = S.fieldA.toFixed(1);
    govPointer.style.transform =
      "translateX(-50%) rotate(" + (POS_ANGLE[S.govMode] || 0) + "deg)";
  }

  function syncControlsFromState() {
    guardOpen = false;
    brkrHandle.disabled = true;
    brkrGuard.setAttribute("aria-expanded", "false");
    brkrGuard.textContent = "GUARD";
    brkrPtr.style.transform = "rotate(0deg)";
    setSwitch(elPump, false);
    setSwitch(elFtOil, false);
    setSwitch(elFtCool, false);
    setSwitch(elFtRej, false);
    selectPos("OFF");
  }

  // ==================================================================
  // render
  // ==================================================================
  function render() {
    var st = state();

    ALARM_NAMES.forEach(function (a) {
      var tile = tiles[a];
      if (!tile) return;
      var active = st.alarms.indexOf(a) !== -1;
      if (active && prevAlarms.indexOf(a) === -1) S.unacked[a] = true;
      tile.classList.toggle("lit", active);
      tile.classList.toggle("unacked", !!S.unacked[a]);
      if (!active) delete S.unacked[a];
    });
    prevAlarms = st.alarms.slice();

    pilotAux.classList.add("lit");
    pilotLoad.classList.toggle("lit", st.breakerClosed && st.megawatts > 0.3);
    pilotTrip.classList.toggle("lit", st.tripped);
    servoJewel.classList.toggle(
      "lit",
      st.governorMode === "AUTO" &&
        st.oilPressureBar > CFG.oilServoMin &&
        !st.tripped,
    );

    var inWin = false;
    var slowOn = false;
    var fastOn = false;
    if (!st.synchronised && st.rpm > 60) {
      var fg = gridFreq(S.t);
      var ph = ((S.phase % 360) + 360) % 360;
      var ad = Math.min(ph, 360 - ph);
      inWin =
        Math.abs(st.frequency - fg) <= 0.25 &&
        ad <= 18 &&
        Math.abs(st.voltageKV - 11) <= 0.55;
      slowOn = st.frequency < fg - 0.05;
      fastOn = st.frequency > fg + 0.05;
    }
    lampInWindow.classList.toggle("lit", inWin);
    lampClosed.classList.toggle("lit", st.breakerClosed);
    lampSlow.classList.toggle("lit", slowOn);
    lampFast.classList.toggle("lit", fastOn);
    syPtr.setAttribute(
      "transform",
      "rotate(" + (((S.phase % 360) + 360) % 360).toFixed(1) + " 60 60)",
    );

    rot(dials.forebay, angFor(0, 10, st.forebayLevel));
    rot(dials.surge, angFor(-3.5, 3.5, st.surgeLevel));
    rot(dials.press, angFor(0, 160, st.netHead));
    rot(dials.oil, angFor(0, 25, st.oilPressureBar));
    rot(dials.volts, angFor(0, 13.5, st.voltageKV));
    rot(dials.mw, angFor(0, 14, st.megawatts));
    rot(dials.gridhz, angFor(48.5, 51.5, st.frequency));
    rot(dials.temp, angFor(0, 100, st.bearingTempC));
    var bigA1 = SWEEP_START + (clamp(st.rpm, 0, 750) / 750) * SWEEP;
    var bigA2 = SWEEP_START + ((clamp(st.frequency, 40, 60) - 40) / 20) * SWEEP;
    dials.tacho.needle.setAttribute(
      "transform",
      "rotate(" + bigA1.toFixed(2) + " 120 98)",
    );
    dials.tacho.needle2.setAttribute(
      "transform",
      "rotate(" + bigA2.toFixed(2) + " 120 98)",
    );

    lochMove.setAttribute(
      "transform",
      "translate(0," +
        clamp((6.0 - st.forebayLevel) * 6, -24, 30).toFixed(1) +
        ")",
    );
    var sy = 120 - clamp(st.surgeLevel, -3.5, 4) * 26;
    surgeWater.setAttribute("y", sy.toFixed(1));
    surgeWater.setAttribute("height", Math.max(0, 218 - sy).toFixed(1));
    tailraceWater.setAttribute(
      "opacity",
      st.penstockFlow > 0.4 ? "0.92" : "0.25",
    );
    runner.setAttribute(
      "transform",
      "rotate(" + S.runnerDeg.toFixed(1) + " 792 238)",
    );
    var dashOff = String(-Math.round(S.dash) % 1000);
    var flowOn = st.penstockFlow > 0.25 ? "0.85" : "0";
    [flowLoch, flowConduit, flowPen].forEach(function (p) {
      p.setAttribute("stroke-dashoffset", dashOff);
      p.setAttribute("opacity", flowOn);
    });
    flowTail.setAttribute("stroke-dashoffset", dashOff);
    flowTail.setAttribute("opacity", flowOn);
    for (var bi = 0; bi < busDots.length; bi++) {
      if (st.breakerClosed && st.megawatts > 0.3) {
        busDots[bi].setAttribute(
          "x",
          String(1064 + ((S.busPhase * 9 + bi * 30) % 78)),
        );
        busDots[bi].setAttribute("opacity", "0.95");
      } else {
        busDots[bi].setAttribute("opacity", "0");
      }
    }

    renderControls();
  }

  // ==================================================================
  // animation loop
  // ==================================================================
  var lastFrame = null;
  function frame(now) {
    if (lastFrame !== null && !document.hidden) {
      tick(Math.min(0.25, (now - lastFrame) / 1000));
    }
    lastFrame = now;
    render();
    window.requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) lastFrame = performance.now();
  });

  reset();
  window.requestAnimationFrame(frame);
})();
