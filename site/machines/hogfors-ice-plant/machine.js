/* ======================================================================
   HÖGFORS ISSTADION · ICE PLANT MACHINE ROOM — machine.js
   Twin R22 reciprocating compressors, calcium-brine circuit under the
   slab, fan-condenser, liquid receiver and a 24-hour chart recorder.
   Frost grows under the slab until you give it hot gas.

   Classic script, everything inside one IIFE, fixed API on window.machine.
   Fully deterministic: every wobble is a function of simulated seconds,
   never of the wall clock or Math.random().
   ====================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------ identity */

  var MACHINE_NAME = "Högfors Isstadion Ice Plant";
  var FAULTS = ["refrigerant leak", "brine flow loss", "compressor knock"];

  var ALARM_NAMES = [
    "LOW CHARGE",
    "LOW SUCTION",
    "HIGH DISCHARGE",
    "BRINE FLOW",
    "ICE TEMP HIGH",
    "FROST LIMIT",
    "COMPRESSOR KNOCK",
    "MOTOR OVERLOAD",
    "ICE FAULT",
    "SAFETY TRIP",
  ];

  /* ------------------------------------------------------- plant constants */

  var CAP_STEPS = [25, 50, 75, 100];
  var KB = 2600; // brine loop thermal capacity, kJ/K
  var LOAD_BASE = 26; // ambient + hall load onto the brine, kW
  var LOAD_WAVE = 7; // slow daily wobble, kW
  var COOL_FULL = 95; // plant full-load refrigeration, kW
  var CHARGE_ALARM = 78; // % , hysteresis below
  var PS_ALARM = 1.15; // bar, running
  var PS_TRIP = 0.95;
  var PD_ALARM = 13.4;
  var PD_TRIP = 14.8;
  var AMPS_ALARM = 66;
  var AMPS_TRIP = 72;
  var FROST_ALARM = 10; // mm
  var ICET_ALARM = -2.8;
  var QUALITY_FAULT = 42;

  /* ----------------------------------------------------------- live state */

  var S = {};

  function coldState() {
    return {
      t: 0,
      running: false,
      selected: 0, // index into machines ["No.1","No.2"]
      pumpMode: 0, // 0 OFF · 1 DUTY · 2 DUTY+AUX
      capacity: 25,
      defrost: false,
      guardOpen: false,
      // process quantities
      brine: -6.0, // loop mean, °C
      iceT: -7.0,
      frost: 2.0, // mm
      charge: 100, // % of nominal R22 charge
      ps: 0.4, // suction, bar(g)
      pd: 9.4, // discharge, bar(g)
      oil: 0,
      amps: 0,
      quality: 100,
      // faults
      leak: false,
      leakIsolated: false,
      flowLoss: false,
      flowLossSince: -1,
      knock: false,
      knockMachine: 0,
      knockSev: 0,
      // protection
      tripped: false,
      tripCause: "",
      psLowAcc: 0,
      pdHighAcc: 0,
      olAcc: 0,
      // resurfacer
      resPhase: "shed", // shed · called · out · returning
      resPhaseT: 0,
      // alarms: name -> {active, ack}
      alarms: {},
      horn: false,
      lampsTest: false,
      hoursRun: 1437.2,
      // recorder buffer [{s, v}]
      chart: [],
      lastChart: -99,
      crankAngle: 0,
      fanAngle: 0,
      purgeReadyAt: -1,
    };
  }

  ALARM_NAMES.forEach(function (n) {
    /* pre-seed so state().alarms ordering is stable */
  });

  function activeAlarmList() {
    var out = [];
    for (var i = 0; i < ALARM_NAMES.length; i++) {
      var a = S.alarms[ALARM_NAMES[i]];
      if (a && a.active) out.push(ALARM_NAMES[i]);
    }
    return out;
  }

  function setAlarm(name, active) {
    var a = S.alarms[name];
    if (!a) {
      a = { active: false, ack: true };
      S.alarms[name] = a;
    }
    if (active && !a.active) {
      a.active = true;
      a.ack = false;
      S.horn = true;
      addLog(name + larmText(name));
    } else if (!active && a.active) {
      a.active = false;
      a.ack = true;
    }
    return a;
  }

  /* raise when cond goes true, hold until clearCond */
  function hyst(name, cond, stillHeld) {
    var cur = S.alarms[name] ? S.alarms[name].active : false;
    var active = cur ? stillHeld : cond;
    setAlarm(name, active);
  }

  function larmText(name) {
    return (
      {
        "LOW CHARGE": " — kylmediesläckage?",
        "LOW SUCTION": " — sugtryck under gräns",
        "HIGH DISCHARGE": " — tryckgas för varm",
        "BRINE FLOW": " — flödesvakta loss",
        "ICE TEMP HIGH": " — isen tinar",
        "FROST LIMIT": " — avdunstning iståkt",
        "COMPRESSOR KNOCK": " — mekanisk välting",
        "MOTOR OVERLOAD": " — överström",
        "ICE FAULT": " — iskvalitet förlorad",
        "SAFETY TRIP": " — skydd utlöst",
      }[name] || ""
    );
  }

  /* --------------------------------------------------------------- helpers */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function frac(t) {
    return (Math.sin(t * 12.9898) * 43758.5453) % 1;
  } // deterministic wobble

  function approach(target, value, rate, dt) {
    var d = target - value;
    var step = rate * dt;
    if (Math.abs(d) <= step) return target;
    return value + Math.sign(d) * step;
  }

  function clockString(sec) {
    var startOfDay = 17 * 3600 + 36 * 60; // evening ice time, 17:36
    var s = Math.floor(startOfDay + sec) % 86400;
    var h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  /* ------------------------------------------------------------------ tick */

  function tick(seconds) {
    if (!(seconds > 0)) return;
    var remaining = seconds;
    while (remaining > 0) {
      var dt = remaining > 1 ? 1 : remaining;
      step(dt);
      remaining -= dt;
    }
  }

  function step(dt) {
    S.t += dt;

    /* --- faults evolve --- */
    if (S.leak && !S.leakIsolated)
      S.charge = clamp(S.charge - dt * 1.05, 4, 100);
    if (S.knock) S.knockSev = clamp(S.knockSev + dt / 30, 0, 1);
    else S.knockSev = approach(0, S.knockSev, dt / 6, dt);

    var flowDemand = S.pumpMode > 0;
    var flow = 0;
    if (flowDemand && !S.flowLoss) flow = S.pumpMode === 2 ? 1.32 : 1.0;
    if (S.flowLoss) {
      if (S.pumpMode === 0) {
        if (S.flowLossSince < 0) S.flowLossSince = S.t;
        if (S.t - S.flowLossSince >= 5) S.purgeReadyAt = S.t; // stood still long enough to re-prime
      } else {
        S.flowLossSince = -1;
        if (S.purgeReadyAt >= 0 && S.t - S.purgeReadyAt >= 1.5) {
          S.flowLoss = false;
          S.purgeReadyAt = -1;
          addLog("Flöde åter — pumparna omprimade");
        }
      }
    }

    /* --- brine energy balance: the colder the brine, the harder the hall pulls --- */
    var load =
      LOAD_BASE +
      LOAD_WAVE * Math.sin(S.t / 900) +
      (-4 - Math.min(S.brine, -4)) * 2.0;
    var resHeat = 0;
    if (S.resPhase === "out" || S.resPhase === "returning") resHeat = 52;
    load += resHeat;
    if (S.defrost && S.running) load += 30;

    var capFrac = S.capacity / 100;
    var chargeEff = Math.pow(clamp(S.charge / 100, 0, 1), 0.65);
    var flowEff = flow >= 0.9 ? 1 : flow > 0 ? 0.18 : 0;
    var sat = clamp((S.brine + 18) / 10, 0, 1); // the evaporator loses bite as the brine falls
    var cool = 0;
    if (S.running) {
      if (S.defrost)
        cool = -16 * capFrac; // hot gas dumped into the slab
      else cool = COOL_FULL * capFrac * chargeEff * flowEff * sat;
      if (S.knock) cool *= 1 - 0.28 * S.knockSev;
    }
    S.brine = clamp(S.brine + ((load - cool) * dt) / KB, -16.5, 12);

    /* --- pressures --- */
    var te = S.running
      ? S.brine - (3 + 4.4 * capFrac * (S.defrost ? 0.4 : 1))
      : S.brine + 1;
    var starved = clamp(S.charge / 100 + 0.18, 0.38, 1); // short of refrigerant, short of suction
    var psTarget = clamp(
      0.085 * (te + 41) * (S.running ? starved : 1),
      0.05,
      6,
    );
    S.ps = approach(psTarget, S.ps, 0.5, dt);

    var pdTarget = S.running
      ? 8.3 +
        (S.defrost ? 2.6 + 4.2 * capFrac : 1.25 * capFrac) +
        0.3 * Math.sin(S.t / 5000)
      : 9.2;
    S.pd = approach(pdTarget, S.pd, 0.45, dt);

    /* --- motor --- */
    var puls =
      1 + (S.knock ? S.knockSev * (0.3 + 0.2 * Math.sin(S.t * 6.8)) : 0);
    var ampTarget = S.running
      ? (12 + 46 * capFrac * Math.sqrt(chargeEff) * (S.defrost ? 0.55 : 1)) *
          puls +
        frac(S.t) * 1.2
      : 0;
    S.amps = approach(ampTarget, S.amps, 90, dt);
    S.oil = S.running
      ? clamp(3.5 - 1.9 * S.knockSev + frac(S.t + 7) * 0.14, 0, 8)
      : approach(0, S.oil, 2, dt);

    /* --- frost --- */
    if (S.running && S.defrost) S.frost = clamp(S.frost - dt * 0.115, 0, 30);
    else
      S.frost = clamp(
        S.frost + dt * (0.0095 + (S.resPhase === "out" ? 0.026 : 0)),
        0,
        30,
      );

    /* --- ice temperature and quality --- */
    var iceTarget =
      S.brine + 4.2 + S.frost * 0.33 + (S.resPhase === "out" ? 2.4 : 0);
    S.iceT = approach(
      iceTarget,
      S.iceT,
      Math.abs(iceTarget - S.iceT) / 430 + 0.0012,
      dt,
    );
    if (S.iceT > -4) S.quality -= (S.iceT + 4) * 0.011 * dt;
    if (S.frost > 12) S.quality -= 0.02 * (S.frost - 12) * dt;
    if (S.iceT < -5 && S.frost < 10 && S.quality < 100) S.quality += 0.008 * dt;
    S.quality = clamp(S.quality, 0, 100);
    /* --- resurfacer cycle: called 8s · out 46s · returning 8s --- */
    if (S.resPhase !== "shed") {
      S.resPhaseT += dt;
      if (S.resPhase === "called" && S.resPhaseT >= 8) {
        S.resPhase = "out";
        S.resPhaseT = 0;
        addLog("Ismaskin ute på planen");
      } else if (S.resPhase === "out" && S.resPhaseT >= 46) {
        S.resPhase = "returning";
        S.resPhaseT = 0;
      } else if (S.resPhase === "returning" && S.resPhaseT >= 8) {
        S.resPhase = "shed";
        S.resPhaseT = 0;
        S.quality = clamp(S.quality + 4, 0, 100);
        addLog("Ny is — maskinen åter i skjulet");
      }
    }

    /* --- hours --- */
    if (S.running) S.hoursRun += dt / 3600;

    /* --- alarm evaluation (with hysteresis on every threshold) --- */
    hyst("LOW CHARGE", S.charge < CHARGE_ALARM, S.charge < CHARGE_ALARM + 6);
    setAlarm("BRINE FLOW", S.flowLoss);
    hyst("LOW SUCTION", S.running && S.ps < PS_ALARM, S.ps < PS_ALARM + 0.35);
    hyst("HIGH DISCHARGE", S.running && S.pd > PD_ALARM, S.pd > PD_ALARM - 0.6);
    hyst("COMPRESSOR KNOCK", S.knockSev > 0.22, S.knockSev >= 0.08);
    hyst("FROST LIMIT", S.frost > FROST_ALARM, S.frost >= FROST_ALARM - 1.5);
    hyst("ICE TEMP HIGH", S.iceT > ICET_ALARM, S.iceT >= ICET_ALARM - 1.4);
    hyst(
      "MOTOR OVERLOAD",
      S.running && S.amps > AMPS_ALARM,
      S.amps >= AMPS_ALARM - 4,
    );

    hyst("ICE FAULT", S.quality < QUALITY_FAULT, S.quality < 55);

    /* --- protective trips --- */
    // trip accumulators decay slowly instead of snapping to zero, so an
    // intermittent abuse still lands the trip
    S.psLowAcc =
      S.running && S.ps < PS_TRIP
        ? S.psLowAcc + dt
        : Math.max(0, S.psLowAcc - 0.6 * dt);
    S.pdHighAcc =
      S.running && S.pd > PD_TRIP
        ? S.pdHighAcc + dt
        : Math.max(0, S.pdHighAcc - 0.6 * dt);
    S.olAcc =
      S.running && S.amps > AMPS_TRIP
        ? S.olAcc + dt
        : Math.max(0, S.olAcc - 0.6 * dt);

    if (S.psLowAcc > 25) doTrip("LÅGT SUGTRYCK / LOW SUCTION");
    if (S.pdHighAcc > 20) doTrip("HÖGT TRYCKGASTRYCK / HIGH DISCHARGE");
    if (S.olAcc > 22) doTrip("ÖVERSTRÖM / MOTOR OVERLOAD");

    if (S.tripped) setAlarm("SAFETY TRIP", true);
    else setAlarm("SAFETY TRIP", false);

    /* --- recorder buffer: one point every 5 sim seconds --- */
    var supply = brineSupply();
    if (S.t - S.lastChart >= 5) {
      S.lastChart = S.t;
      S.chart.push({ s: S.t, v: supply });
      if (S.chart.length > 880) S.chart.shift();
    }

    /* --- motion integrators --- */
    if (S.running) {
      S.crankAngle = (S.crankAngle + dt * 760) % 360;
      S.fanAngle = (S.fanAngle + dt * 1350) % 360;
    } else {
      S.crankAngle = approach(0, S.crankAngle, 300 * dt, dt) % 360;
      S.fanAngle = approach(0, S.fanAngle, 420 * dt, dt) % 360;
    }
  }

  function brineSupply() {
    var pickup = 1.2 + 2.8 * (LOAD_BASE / COOL_FULL);
    return S.brine - pickup / 2;
  }
  function brineReturn() {
    var pickup = 1.2 + 2.8 * (LOAD_BASE / COOL_FULL);
    return S.brine + pickup / 2;
  }

  function doTrip(cause) {
    S.tripped = true;
    S.tripCause = cause;
    S.running = false;
    addLog("SKYDD UTLÖST — " + cause);
  }

  /* ------------------------------------------------------------- public API */

  function state() {
    return {
      clock: clockString(S.t),
      secondsRun: S.t,
      compressorSelected: S.selected === 0 ? "No.1" : "No.2",
      pumpMode: ["OFF", "DUTY", "DUTY+AUX"][S.pumpMode],
      running: S.running,
      capacityPct: S.capacity,
      defrosting: S.defrost,
      brineSupplyC: round2(brineSupply()),
      brineReturnC: round2(brineReturn()),
      iceSurfaceC: round2(S.iceT),
      suctionBar: round2(S.ps),
      dischargeBar: round2(S.pd),
      oilBar: round2(S.oil),
      motorAmps: round1(S.amps),
      chargePct: round1(S.charge),
      frostMm: round2(S.frost),
      iceQualityPct: round1(S.quality),
      flowPct:
        S.pumpMode === 0 ? 0 : S.flowLoss ? 0 : S.pumpMode === 2 ? 132 : 100,
      resurfacer: S.resPhase,
      tripped: S.tripped,
      tripCause: S.tripCause,
      horn: S.horn,
      alarms: activeAlarmList(),
    };
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }
  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === "refrigerant leak") {
      if (S.leak) return;
      S.leak = true;
      S.leakIsolated = false;
      addLog("PROVFEL — läckage på sugerör");
      note(el.trayNote, "Läckage aktivt — TÄTTA LÄCKAN, sedan TOP UP CHARGE.");
    } else if (f === "brine flow loss") {
      if (S.flowLoss) return;
      S.flowLoss = true;
      S.flowLossSince = -1;
      S.purgeReadyAt = -1;
      addLog("PROVFEL — flödesvakta löser ut");
      note(
        el.startNote,
        "FLÖDESBORTFALL — PUMPARNA AV I 5 s, SEDAN IGÅNG IGEN",
      );
    } else if (f === "compressor knock") {
      if (S.knock) return;
      S.knock = true;
      S.knockMachine = S.selected;
      addLog("PROVFEL — välting på maskin " + (S.selected + 1));
    } else {
      throw new Error("unknown fault: " + fault);
    }
  }

  function reset() {
    var chart = [];
    S = coldState();
    S.chart = chart;
    syncControlsToState();
    addLog("Anläggningen nollställd — kallt och larmfritt");
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ================================================================ DOM */

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var el = {};
  function grab() {
    el.clock = $("[data-clock]");
    el.hours = $("[data-hours]");
    el.frostGroup = $("#frostGroup");
    el.frostPatches = $$(".frost-patch");
    el.sheen = $("#sheenBand");
    el.resGlyph = $("#resurfacerGlyph");
    el.brinePaths = $$(".brine-main");
    el.mercury = {
      out: $('[data-thermo="out"] [data-mercury]'),
      ret: $('[data-thermo="ret"] [data-mercury]'),
    };
    el.bulbs = {
      out: $('[data-thermo="out"] [data-bulb]'),
      ret: $('[data-thermo="ret"] [data-bulb]'),
    };
    el.seg = $("[data-seg]");
    el.trace = $("[data-rec-trace]");
    el.recArm = $("[data-rec-arm]");
    el.sgLiquid = $("[data-sg-liquid]");
    el.sgBubbles = $("[data-sg-bubbles]");
    el.fan = $("[data-fan]");
    el.comp = [
      { root: $('[data-comp="1"]'), lamp: $('[data-lamp="run1"]') },
      { root: $('[data-comp="2"]'), lamp: $('[data-lamp="run2"]') },
    ];
    el.ann = {};
    $$(".ann-window").forEach(function (w) {
      el.ann[w.getAttribute("data-ann")] = w;
    });
    el.jewels = {
      pump1: $('[data-lamp="pump1"]'),
      pump2: $('[data-lamp="pump2"]'),
      bubbles: $('[data-lamp="bubbles"]'),
      horn: $('[data-lamp="horn"]'),
    };
    el.startNote = $("[data-start-note]");
    el.resurfNote = $("[data-resurf-note]");
    el.trayNote = $("[data-tray-note]");
    el.log = $("[data-log]");
    el.rotComp = $('[data-rotary="compressor"]');
    el.rotPump = $('[data-rotary="pump"]');
    el.leverHandle = $('[data-control="CAPACITY LEVER"]');
    el.guardBox = $("[data-guard-box]");
    el.guardLid = $("[data-guard-lid]");
    el.keySwitch = $('[data-control="DEFROST KEY"]');
    el.soundBtn = $("[data-sound-button]");
  }

  /* --------------------------------------------------------- dial builder */

  var GAUGES = {};

  function polar(cx, cy, r, angDeg) {
    var a = ((angDeg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function arcPath(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0),
      p1 = polar(cx, cy, r, a1);
    var large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return (
      "M" +
      p0[0].toFixed(2) +
      " " +
      p0[1].toFixed(2) +
      " A" +
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

  function makeDial(fig) {
    var min = parseFloat(fig.getAttribute("data-min"));
    var max = parseFloat(fig.getAttribute("data-max"));
    var span = max - min;
    var unit = fig.getAttribute("data-unit");
    var caption = fig.getAttribute("data-caption");
    var green = fig.getAttribute("data-green");
    var red = fig.getAttribute("data-red");
    var cx = 55,
      cy = 52,
      R = 40;

    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 110 96");
    svg.setAttribute("aria-hidden", "true");

    function add(tag, attrs, parent) {
      var n = document.createElementNS(NS, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(n);
      return n;
    }

    add("circle", { cx: cx, cy: cy, r: 47, class: "dial-bezel" });
    add("circle", { cx: cx, cy: cy, r: 43, class: "dial-face" });
    if (green) {
      var g = green.split(",").map(parseFloat);
      add("path", {
        d: arcPath(cx, cy, R - 2, aOf(g[0]), aOf(g[1])),
        class: "dial-sector-green",
      });
    }
    if (red) {
      var rd = red.split(",").map(parseFloat);
      add("path", {
        d: arcPath(cx, cy, R - 2, aOf(rd[0]), aOf(Math.min(rd[1], max))),
        class: "dial-sector-red",
      });
    }

    var span = max - min;
    var majors =
      span <= 10 ? span : span / (span > 60 ? 20 : span > 20 ? 10 : 5);
    var i, v;
    for (i = 0; i <= majors; i++) {
      v = min + (span * i) / majors;
      var a = aOf(v);
      var p0 = polar(cx, cy, R, a),
        p1 = polar(cx, cy, R - (i % 1 === 0 ? 7 : 4), a);
      add("line", {
        x1: p0[0],
        y1: p0[1],
        x2: p1[0],
        y2: p1[1],
        class: i % 1 === 0 ? "dial-tick-major" : "dial-tick",
      });
      if (majors <= 10) {
        var pt = polar(cx, cy, R - 15, a);
        var t = add("text", {
          x: pt[0],
          y: pt[1] + 3,
          class: "dial-num",
          "text-anchor": "middle",
        });
        t.textContent =
          Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
      }
    }
    var u = add("text", {
      x: cx,
      y: cy + 22,
      class: "dial-unit",
      "text-anchor": "middle",
    });
    u.textContent = unit;

    var needle = add("line", {
      x1: cx,
      y1: cy + 9,
      x2: cx,
      y2: cy - (R - 6),
      class: "dial-needle",
    });
    add("circle", { cx: cx, cy: cy, r: 5.5, class: "dial-hub" });

    var cap = document.createElement("figcaption");
    cap.className = "dial-caption";
    cap.textContent = caption;

    fig.appendChild(svg);
    fig.appendChild(cap);

    GAUGES[fig.getAttribute("data-gauge")] = {
      min: min,
      max: max,
      needle: needle,
      cx: cx,
      cy: cy,
    };

    function aOf(v2) {
      return -120 + ((clamp(v2, min, max) - min) / span) * 240;
    }
    return { aOf: aOf };
  }

  function setNeedle(name, v) {
    var g = GAUGES[name];
    if (!g) return;
    var f = (clamp(v, g.min, g.max) - g.min) / (g.max - g.min);
    g.needle.setAttribute(
      "transform",
      "rotate(" + (-120 + f * 240) + " " + g.cx + " " + g.cy + ")",
    );
  }

  /* ------------------------------------------------------ seven segment */

  var segPolys = [];

  function segGlyph(x, y, w, h) {
    // returns object of 7 segment polygons at cell x,y
    var NS = "http://www.w3.org/2000/svg";
    var g = document.createElementNS(NS, "g");
    var t = 3.4,
      gap = 1.1;
    function poly(points) {
      var p = document.createElementNS(NS, "polygon");
      p.setAttribute(
        "points",
        points
          .map(function (pt) {
            return pt.join(",");
          })
          .join(" "),
      );
      p.setAttribute("class", "seg-off");
      g.appendChild(p);
      return p;
    }
    var midY = y + h / 2;
    var o = {
      a: poly([
        [x + gap, y],
        [x + w - gap, y],
        [x + w - gap - t, y + t],
        [x + gap + t, y + t],
      ]),
      b: poly([
        [x + w, y + gap],
        [x + w, y + h / 2 - gap],
        [x + w - t, y + h / 2 - t],
        [x + w - t, y + gap + t],
      ]),
      c: poly([
        [x + w, y + h / 2 + gap],
        [x + w, y + h - gap],
        [x + w - t, y + h - gap - t],
        [x + w - t, y + h / 2 + gap + t],
      ]),
      d: poly([
        [x + gap, y + h],
        [x + w - gap, y + h],
        [x + w - gap - t, y + h - t],
        [x + gap + t, y + h - t],
      ]),
      e: poly([
        [x, y + h / 2 + gap],
        [x, y + h - gap],
        [x + t, y + h - gap - t],
        [x + t, y + h / 2 + gap + t],
      ]),
      f: poly([
        [x, y + gap],
        [x, y + h / 2 - gap],
        [x + t, y + h / 2 - t],
        [x + t, y + gap + t],
      ]),
      g: poly([
        [x + gap, midY],
        [x + gap + t, midY - t],
        [x + w - gap - t, midY - t],
        [x + w - gap, midY],
        [x + w - gap - t, midY + t],
        [x + gap + t, midY + t],
      ]),
    };
    o._g = g;
    return o;
  }

  var SEG_MAP = {
    0: "abcdef",
    1: "bc",
    2: "abged",
    3: "abgcd",
    4: "fgbc",
    5: "afgcd",
    6: "afgedc",
    7: "abc",
    8: "abcdefg",
    9: "abfgcd",
    "-": "g",
    " ": "",
  };

  function buildSegDisplay() {
    var NS = "http://www.w3.org/2000/svg";
    el.seg.innerHTML = "";
    segPolys = [];
    var layout = [
      { ch: "-", x: 8, w: 16 },
      { ch: "d", x: 30, w: 34 },
      { ch: "d", x: 70, w: 34 },
      { ch: ".", x: 106, w: 10 },
      { ch: "d", x: 120, w: 34 },
    ];
    layout.forEach(function (slot) {
      if (slot.ch === ".") {
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", slot.x + slot.w - 3);
        c.setAttribute("cy", 40);
        c.setAttribute("r", 3);
        c.setAttribute("class", "seg-off");
        el.seg.appendChild(c);
        segPolys.push({ dot: c });
      } else if (slot.ch === "-") {
        var gl = segGlyph(slot.x, 5, slot.w, 36);
        el.seg.appendChild(gl._g);
        segPolys.push(gl);
      } else {
        var gd = segGlyph(slot.x, 5, slot.w, 36);
        el.seg.appendChild(gd._g);
        segPolys.push(gd);
      }
    });
  }

  function showSeg(value) {
    // value: number like -12.4 ; format "-12.4" into 5 slots: -, 1, 2, ., 4
    var neg = value < 0;
    var av = Math.abs(value);
    var tens = Math.floor(av / 10);
    var ones = Math.floor(av % 10);
    var dec = Math.floor((av * 10) % 10);
    var tStr = tens === 0 && !neg ? " " : String(tens);
    var str = (neg ? "-" : " ") + tStr + String(ones) + "." + String(dec);
    for (var i = 0; i < 5; i++) {
      var slot = segPolys[i];
      var ch = str[i];
      if (slot.dot) {
        slot.dot.setAttribute("class", ch === "." ? "seg-on" : "seg-off");
      } else {
        var bits = SEG_MAP[ch] !== undefined ? SEG_MAP[ch] : "";
        for (var k in slot) {
          if (k.length === 1 && slot[k].classList) {
            slot[k].setAttribute(
              "class",
              bits.indexOf(k) >= 0 ? "seg-on" : "seg-off",
            );
          }
        }
      }
    }
  }

  /* ------------------------------------------------------- thermometer */

  function buildThermoTicks(root) {
    var g = $("[data-ticks]", root);
    if (!g) return;
    var NS = "http://www.w3.org/2000/svg";
    for (var v = -20; v <= 15; v += 5) {
      var y = thermoY(v);
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", 31);
      ln.setAttribute("x2", v % 10 === 0 ? 39 : 36);
      ln.setAttribute("y1", y);
      ln.setAttribute("y2", y);
      g.appendChild(ln);
      if (v % 10 === 0) {
        var tx = document.createElementNS(NS, "text");
        tx.setAttribute("x", 43);
        tx.setAttribute("y", y + 2.2);
        tx.textContent = v;
        g.appendChild(tx);
      }
    }
  }

  function thermoY(v) {
    return 128 - ((v + 20) / 35) * 118;
  }

  function setThermo(which, v) {
    var col = el.mercury[which];
    var y = thermoY(clamp(v, -20, 15));
    col.setAttribute("y", y);
    col.setAttribute("height", Math.max(0, 128 - y));
    el.bulbs[which].setAttribute(
      "fill",
      v < -2 ? "#17879e" : v < 4 ? "#c07f1a" : "#cf2a1c",
    );
  }

  /* -------------------------------------------------------------- log */

  var logCount = 0;
  function addLog(msg) {
    if (!el.log) return;
    var placeholder = el.log.querySelector("li[data-empty]");
    if (placeholder) placeholder.remove();
    var li = document.createElement("li");
    li.textContent = clockString(S.t) + "  " + msg;
    el.log.insertBefore(li, el.log.firstChild);
    while (el.log.children.length > 6) el.log.removeChild(el.log.lastChild);
    logCount++;
  }

  /* ---------------------------------------------------------- controls */

  var NOTE_TIMER = null;
  function note(nodeSel, msg) {
    var n = nodeSel;
    if (!n) return;
    n.textContent = msg;
    clearTimeout(NOTE_TIMER);
    NOTE_TIMER = setTimeout(function () {
      n.textContent = "";
    }, 4200);
  }

  var POS_COMP = ["No.1", "No.2"];
  var POS_PUMP = ["OFF", "DUTY", "DUTY+AUX"];

  function rotAngles(count) {
    return count === 2 ? [-38, 38] : [-46, 0, 46];
  }

  function refreshRotary(container, positions, index) {
    var knob = $(".rot-knob", container);
    var angles = rotAngles(positions.length);
    knob.style.setProperty("--rot-angle", angles[index] + "deg");
    knob.setAttribute(
      "aria-label",
      $(".rot-knob", container).getAttribute("data-base-label") +
        " Currently: " +
        positions[index] +
        ".",
    );
    $$("[data-pos]", container).forEach(function (li) {
      li.classList.toggle(
        "active",
        li.getAttribute("data-pos") === positions[index],
      );
    });
  }

  function wireRotary(container, positions, getIdx, setIdx) {
    var knob = $(".rot-knob", container);
    knob.setAttribute(
      "data-base-label",
      (knob.getAttribute("aria-label") || "").split(".")[0],
    );
    function move(dir) {
      var idx = clamp(getIdx() + dir, 0, positions.length - 1);
      if (idx !== getIdx()) {
        setIdx(idx);
        sndClick();
      }
      refreshRotary(container, positions, getIdx());
    }
    knob.addEventListener("click", function () {
      move(1);
    });
    knob.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        move(1);
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        move(-1);
      }
    });
    refreshRotary(container, positions, getIdx());
  }

  function wireLever() {
    var handle = el.leverHandle;
    var track = handle.parentElement;
    var dragging = false;

    function setFromEvent(e) {
      var rect = track.getBoundingClientRect();
      var y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
      var f = 1 - clamp(y / rect.height, 0, 1);
      var stepIdx = Math.round(f * (CAP_STEPS.length - 1));
      setCapacity(CAP_STEPS[stepIdx]);
    }

    function applyPos() {
      var idx = CAP_STEPS.indexOf(S.capacity);
      var f = idx / (CAP_STEPS.length - 1);
      handle.style.setProperty("--pos", (f * 100).toFixed(1));
      handle.setAttribute("aria-valuenow", String(S.capacity));
      handle.setAttribute("aria-valuetext", S.capacity + " percent");
    }

    handle.addEventListener("pointerdown", function (e) {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      setFromEvent(e);
    });
    handle.addEventListener("pointermove", function (e) {
      if (dragging) setFromEvent(e);
    });
    handle.addEventListener("pointerup", function () {
      dragging = false;
    });
    track.addEventListener("click", function (e) {
      if (e.target.closest(".lever-handle")) return;
      setFromEvent(e);
    });
    handle.addEventListener("keydown", function (e) {
      var idx = CAP_STEPS.indexOf(S.capacity);
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        e.preventDefault();
        setCapacity(CAP_STEPS[Math.min(CAP_STEPS.length - 1, idx + 1)]);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        setCapacity(CAP_STEPS[Math.max(0, idx - 1)]);
      }
      if (e.key === "Home") {
        e.preventDefault();
        setCapacity(CAP_STEPS[0]);
      }
      if (e.key === "End") {
        e.preventDefault();
        setCapacity(CAP_STEPS[CAP_STEPS.length - 1]);
      }
    });
    el.leverApply = applyPos;
    applyPos();
  }

  function setCapacity(pct) {
    if (CAP_STEPS.indexOf(pct) < 0) pct = CAP_STEPS[Math.round(pct / 25 - 1)];
    if (pct !== S.capacity) {
      S.capacity = pct;
      sndClick();
    }
    if (el.leverApply) el.leverApply();
  }

  function wireStartStop() {
    $('[data-control="COMPRESSOR START"]').addEventListener(
      "click",
      function () {
        sndClick();
        if (S.tripped) {
          note(
            el.startNote,
            "SKYDD UTLÖST — TRYCK ÅTERSTÄLL FÖRST / RESET THE TRIP FIRST",
          );
          return;
        }
        if (S.running) {
          note(el.startNote, "MASKINEN GÅR REDAN / ALREADY RUNNING");
          return;
        }
        if (S.pumpMode === 0 || (S.flowLoss && S.pumpMode > 0)) {
          note(
            el.startNote,
            "INGET BRINFLÖDE — STARTA PUMPARNA FÖRST / NO BRINE FLOW",
          );
          return;
        }
        S.running = true;
        addLog("Maskin " + POS_COMP[S.selected] + " startad");
        note(el.startNote, "");
        sndRelay();
      },
    );
    $('[data-control="COMPRESSOR STOP"]').addEventListener(
      "click",
      function () {
        sndClick();
        if (S.running) {
          S.running = false;
          addLog("Maskin " + POS_COMP[S.selected] + " stoppad");
        }
        note(el.startNote, "");
        sndRelay();
      },
    );
  }

  function wireSelector() {
    wireRotary(
      el.rotComp,
      POS_COMP,
      function () {
        return S.selected;
      },
      function (idx) {
        if (idx !== S.selected) {
          if (S.running) {
            S.running = false;
            addLog("Växel — maskinen kopplades ur, starta igen");
          }
          if (S.knock && S.selected === S.knockMachine) {
            S.knock = false; // the knocking machine is taken off duty for inspection
            addLog("Vältingande maskin urkopplad för besiktning");
          }
          S.selected = idx;
        }
      },
    );
    wireRotary(
      el.rotPump,
      POS_PUMP,
      function () {
        return S.pumpMode;
      },
      function (idx) {
        S.pumpMode = idx;
      },
    );
  }

  function wireDefrostKey() {
    el.guardLid.addEventListener("click", function () {
      S.guardOpen = !S.guardOpen;
      el.guardBox.classList.toggle("open", S.guardOpen);
      el.guardLid.setAttribute("aria-expanded", String(S.guardOpen));
      el.keySwitch.disabled = !S.guardOpen;
      sndClick();
    });
    el.keySwitch.addEventListener("click", function () {
      S.defrost = !S.defrost;
      el.keySwitch.style.setProperty(
        "--key-angle",
        S.defrost ? "62deg" : "0deg",
      );
      el.keySwitch.setAttribute(
        "aria-label",
        "Defrost key. Currently: " +
          (S.defrost ? "AVINNING / DEFROST" : "NORMAL") +
          ".",
      );
      addLog(
        S.defrost
          ? "Avinning tillsluten — het gas på planen"
          : "Avinning urkoplad — normaldrift",
      );
      sndRelay();
    });
  }

  function wireResurfacer() {
    $('[data-control="RESURFACER CALL"]').addEventListener(
      "click",
      function () {
        sndClick();
        if (S.resPhase !== "shed") {
          note(el.resurfNote, "ISMASKINEN ÄR UTE / RESURFACER IS ALREADY OUT");
          return;
        }
        S.resPhase = "called";
        S.resPhaseT = 0;
        addLog("Ismaskinen kallas till planen");
        note(el.resurfNote, "");
      },
    );
  }

  function wireAlarmButtons() {
    $('[data-control="ALARM ACCEPT"]').addEventListener("click", function () {
      sndClick();
      ALARM_NAMES.forEach(function (n) {
        if (S.alarms[n]) S.alarms[n].ack = true;
      });
      S.horn = false;
      addLog("Larm kvitterade");
    });
    $('[data-control="HORN CUT"]').addEventListener("click", function () {
      sndClick();
      S.horn = false;
    });
    var lampsBtn = $('[data-control="LAMPS TEST"]');
    var on = function () {
      S.lampsTest = true;
    };
    var off = function () {
      S.lampsTest = false;
    };
    lampsBtn.addEventListener("pointerdown", on);
    lampsBtn.addEventListener("pointerup", off);
    lampsBtn.addEventListener("pointerleave", off);
    lampsBtn.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") on();
    });
    lampsBtn.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") off();
    });
    lampsBtn.addEventListener("blur", off);

    $('[data-control="TRIP RESET"]').addEventListener("click", function () {
      sndClick();
      if (!S.tripped) {
        note(el.startNote, "INGET SKYDD UTLÖST / NOTHING TO RESET");
        return;
      }
      var blocked = [];
      if (S.running && S.ps < PS_ALARM) blocked.push("LOW SUCTION");
      if (S.running && S.pd > PD_ALARM) blocked.push("HIGH DISCHARGE");
      if (S.charge < CHARGE_ALARM) blocked.push("LOW CHARGE");
      if (blocked.length) {
        note(
          el.startNote,
          "KAN INTE ÅTERSTÄLLAS — " + blocked.join(", ") + " ÅTERSTÅR",
        );
        return;
      }
      S.tripped = false;
      S.tripCause = "";
      setAlarm("SAFETY TRIP", false);
      addLog("Skydd återställt — klar att starta");
      note(el.startNote, "");
    });
  }

  function wireMaintTray() {
    $('[data-control="TEST REFRIGERANT LEAK"]').addEventListener(
      "click",
      function () {
        sndClick();
        inject("refrigerant leak");
      },
    );
    $('[data-control="TEST BRINE FLOW LOSS"]').addEventListener(
      "click",
      function () {
        sndClick();
        inject("brine flow loss");
      },
    );
    $('[data-control="TEST COMPRESSOR KNOCK"]').addEventListener(
      "click",
      function () {
        sndClick();
        inject("compressor knock");
      },
    );

    $('[data-control="ISOLATE LEAK"]').addEventListener("click", function () {
      sndClick();
      if (!S.leak) {
        note(el.trayNote, "Ingen läcka isolerad — nothing to isolate.");
        return;
      }
      S.leakIsolated = true;
      note(el.trayNote, "Läckan täppt — fyll på med TOP UP CHARGE.");
      addLog("Läckan isolerad och täppt");
    });
    $('[data-control="TOP UP CHARGE"]').addEventListener("click", function () {
      sndClick();
      S.charge = clamp(S.charge + 16, 0, 100);
      note(
        el.trayNote,
        "Påfyllt 16 kg R22 — laddning " + Math.round(S.charge) + " %.",
      );
      addLog("Påfyllning 16 kg R22");
    });
  }

  function syncControlsToState() {
    el.leverApply();
    refreshRotary(el.rotComp, POS_COMP, S.selected);
    refreshRotary(el.rotPump, POS_PUMP, S.pumpMode);
    el.guardBox.classList.remove("open");
    el.guardLid.setAttribute("aria-expanded", "false");
    el.keySwitch.disabled = true;
    el.keySwitch.style.setProperty("--key-angle", "0deg");
    el.keySwitch.setAttribute(
      "aria-label",
      "Defrost key. Hot gas defrost of the slab. Turn to DEFROST or back to NORMAL.",
    );
    note(el.startNote, "");
    note(el.resurfNote, "");
    note(el.trayNote, "R22 flaskvikt kopplad — charging cylinder stowed.");
  }

  /* ------------------------------------------------------------- manual dialog */

  function wireDialog() {
    var dlg = $("dialog[data-manual]");
    $('[data-action="manual"]').addEventListener("click", function () {
      sndClick();
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    });
    $('[data-action="close-manual"]').addEventListener("click", function () {
      sndClick();
      if (typeof dlg.close === "function") dlg.close();
      else dlg.removeAttribute("open");
    });
  }

  /* --------------------------------------------------------------- sound */

  var AU = {
    ctx: null,
    enabled: false,
    hum: null,
    humGain: null,
    hiss: null,
    hissGain: null,
    klax: null,
    klaxGain: null,
    klaxTimer: null,
  };

  function audioInit() {
    if (AU.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    AU.ctx = new AC();
    AU.master = AU.ctx.createGain();
    AU.master.gain.value = 0.55;
    AU.master.connect(AU.ctx.destination);

    AU.humGain = AU.ctx.createGain();
    AU.humGain.gain.value = 0;
    var lp = AU.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 240;
    var o1 = AU.ctx.createOscillator();
    o1.type = "sawtooth";
    o1.frequency.value = 46;
    var o2 = AU.ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = 92;
    o1.connect(AU.humGain);
    o2.connect(AU.humGain);
    AU.humGain.connect(lp);
    lp.connect(AU.master);
    o1.start();
    o2.start();

    var len = AU.ctx.sampleRate * 1.2;
    var buf = AU.ctx.createBuffer(1, len, AU.ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (frac(i * 0.117) - 0.5) * 0.6;
    AU.hiss = AU.ctx.createBufferSource();
    AU.hiss.buffer = buf;
    AU.hiss.loop = true;
    var bp = AU.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 0.8;
    AU.hissGain = AU.ctx.createGain();
    AU.hissGain.gain.value = 0;
    AU.hiss.connect(bp);
    bp.connect(AU.hissGain);
    AU.hissGain.connect(AU.master);
    AU.hiss.start();

    AU.klaxGain = AU.ctx.createGain();
    AU.klaxGain.gain.value = 0;
    AU.klax = AU.ctx.createOscillator();
    AU.klax.type = "square";
    AU.klax.frequency.value = 480;
    var kg = AU.ctx.createGain();
    kg.gain.value = 0.16;
    AU.klax.connect(kg);
    kg.connect(AU.klaxGain);
    AU.klaxGain.connect(AU.master);
    AU.klax.start();
  }

  function sndSetHum(level) {
    if (!AU.enabled || !AU.humGain) return;
    AU.humGain.gain.setTargetAtTime(level, AU.ctx.currentTime, 0.4);
  }
  function sndSetHiss(level) {
    if (!AU.enabled || !AU.hissGain) return;
    AU.hissGain.gain.setTargetAtTime(level, AU.ctx.currentTime, 0.3);
  }
  function sndHorn(on) {
    if (!AU.enabled || !AU.klaxGain) return;
    AU.klaxGain.gain.setTargetAtTime(on ? 0.5 : 0, AU.ctx.currentTime, 0.05);
    if (on && !AU.klaxTimer) {
      var flip = false;
      AU.klaxTimer = setInterval(function () {
        flip = !flip;
        if (AU.klax)
          AU.klax.frequency.setTargetAtTime(
            flip ? 618 : 470,
            AU.ctx.currentTime,
            0.02,
          );
      }, 420);
    } else if (!on && AU.klaxTimer) {
      clearInterval(AU.klaxTimer);
      AU.klaxTimer = null;
    }
  }
  function blip(freq, dur, type, vol) {
    if (!AU.enabled || !AU.ctx) return;
    var o = AU.ctx.createOscillator(),
      g = AU.ctx.createGain();
    o.type = type || "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.12, AU.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, AU.ctx.currentTime + dur);
    o.connect(g);
    g.connect(AU.master);
    o.start();
    o.stop(AU.ctx.currentTime + dur + 0.02);
  }
  function sndClick() {
    blip(1500, 0.035, "square", 0.07);
  }
  function sndRelay() {
    blip(190, 0.09, "triangle", 0.2);
    blip(140, 0.12, "triangle", 0.16);
  }

  function wireSound() {
    el.soundBtn.addEventListener("click", function () {
      if (!AU.enabled) {
        audioInit();
        if (!AU.ctx) {
          el.soundBtn.querySelector(".push-sub").textContent = "NO AUDIO";
          return;
        }
        if (AU.ctx.state === "suspended") AU.ctx.resume();
        AU.enabled = true;
        el.soundBtn.setAttribute("aria-pressed", "true");
        el.soundBtn.querySelector(".push-sub").textContent = "SOUND ON";
        sndRelay();
      } else {
        AU.enabled = false;
        sndSetHum(0);
        sndSetHiss(0);
        sndHorn(false);
        el.soundBtn.setAttribute("aria-pressed", "false");
        el.soundBtn.querySelector(".push-sub").textContent = "SOUND OFF";
      }
    });
  }

  /* ------------------------------------------------------------- rendering */

  var FROST_FACTORS = [0.9, 0.86, 0.88, 0.82, 0.7, 0.72];

  function render() {
    var st = state();

    el.clock.textContent = st.clock;
    el.hours.textContent = ("000000" + Math.floor(S.hoursRun)).slice(-6);

    /* frost blooms */
    var fOp = clamp((S.frost - 0.4) / 13, 0, 1);
    for (var i = 0; i < el.frostPatches.length; i++) {
      el.frostPatches[i].style.opacity = String(
        fOp * FROST_FACTORS[i % FROST_FACTORS.length],
      );
    }

    /* resurfacer sheen + glyph */
    var sx = null,
      sOp = 0;
    if (S.resPhase === "called") sOp = 0;
    if (S.resPhase === "out") {
      var p = clamp(S.resPhaseT / 46, 0, 1);
      sx = -70 + p * 690;
      sOp = 0.5;
    }
    if (S.resPhase === "returning") {
      var p2 = 1 - clamp(S.resPhaseT / 8, 0, 1);
      sx = -70 + p2 * 690;
      sOp = 0.35;
    }
    el.sheen.setAttribute("opacity", String(sOp));
    if (sx !== null) {
      el.sheen.setAttribute("x", String(sx));
      el.resGlyph.setAttribute("opacity", "1");
      el.resGlyph.setAttribute("transform", "translate(" + (sx + 60) + ",160)");
    } else {
      el.resGlyph.setAttribute("opacity", "0");
    }
    if (S.resPhase === "shed") note(el.resurfNote, "");

    /* brine flow animation */
    var flowing = st.flowPct > 30;
    el.brinePaths.forEach(function (pth) {
      pth.classList.toggle("flowing", flowing);
    });

    /* thermometers + digital meter */
    setThermo("out", st.brineSupplyC);
    setThermo("ret", st.brineReturnC);
    showSeg(st.brineSupplyC);

    /* gauges */
    setNeedle("suction", st.suctionBar);
    setNeedle("discharge", st.dischargeBar);
    setNeedle("oil", st.oilBar);
    setNeedle("amps", st.motorAmps);
    setNeedle("quality", st.iceQualityPct);

    /* compressors */
    for (var m = 0; m < 2; m++) {
      var c = el.comp[m];
      var isRunning = S.running && S.selected === m;
      var web = $("[data-web]", c.root);
      var piston = $("[data-piston]", c.root);
      var rod = $("[data-rod]", c.root);
      var a = ((S.crankAngle + m * 180) * Math.PI) / 180;
      web.setAttribute(
        "transform",
        "rotate(" + (S.crankAngle + m * 180) + " 95 82)",
      );
      var pinX = 95 + 22 * Math.sin(a);
      var pinY = 82 - 22 * Math.cos(a);
      var py = 14 + 8 * (1 - Math.cos(a));
      piston.setAttribute("transform", "translate(0," + py.toFixed(2) + ")");
      var bx = parseFloat($("[data-piston]", c.root).getAttribute("x")) + 13;
      rod.setAttribute("x1", bx.toFixed(1));
      rod.setAttribute("y1", (36 + py).toFixed(1));
      rod.setAttribute("x2", pinX.toFixed(1));
      rod.setAttribute("y2", pinY.toFixed(1));
      c.lamp.classList.toggle("on", isRunning);
      c.lamp.style.opacity =
        isRunning && S.knock && S.knockMachine === m
          ? Math.sin(S.t * 9) > 0
            ? "1"
            : "0.35"
          : "1";
    }

    /* condenser fan + sight glass */
    el.fan.setAttribute(
      "transform",
      "rotate(" + S.fanAngle.toFixed(1) + " 60 60)",
    );
    var ch = clamp(S.charge / 100, 0, 1);
    var liqTop = 6 + (1 - ch) * 108;
    el.sgLiquid.setAttribute("y", liqTop.toFixed(1));
    el.sgLiquid.setAttribute("height", Math.max(0, 114 - liqTop).toFixed(1));
    var bubbling = S.running && S.charge < 62;
    el.sgBubbles.classList.toggle("live", bubbling);
    el.jewels.bubbles.classList.toggle("on", bubbling);
    el.jewels.pump1.classList.toggle("on", S.pumpMode > 0 && !S.flowLoss);
    el.jewels.pump2.classList.toggle("on", S.pumpMode === 2 && !S.flowLoss);

    /* chart recorder */
    var pts = [];
    for (var ci = 0; ci < S.chart.length; ci++) {
      var smp = S.chart[ci];
      var ang = (((smp.s + 17 * 3600 + 36 * 60) % 86400) / 86400) * 360;
      var r = 76 - ((clamp(smp.v, -16, 8) + 16) / 24) * 42;
      var rad = ((ang - 90) * Math.PI) / 180;
      pts.push(
        (89 + r * Math.cos(rad)).toFixed(1) +
          "," +
          (89 + r * Math.sin(rad)).toFixed(1),
      );
    }
    el.trace.setAttribute("points", pts.join(" "));
    var nowAng = (((S.t + 17 * 3600 + 36 * 60) % 86400) / 86400) * 360;
    el.recArm.setAttribute(
      "transform",
      "rotate(" + nowAng.toFixed(2) + " 89 89)",
    );

    /* lamps test forces everything lit */
    var test = S.lampsTest;
    if (test) {
      showSeg(-88.8);
    }

    /* annunciators */
    ALARM_NAMES.forEach(function (name) {
      var w = el.ann[name];
      if (!w) return;
      var a = S.alarms[name] || { active: false, ack: true };
      var red = name === "SAFETY TRIP" || name === "ICE FAULT";
      w.className = "ann-window " + (red ? "ann-red" : "ann-amber");
      if (test) w.classList.add(red ? "red-test" : "test");
      else if (a.active)
        w.classList.add(
          red
            ? a.ack
              ? "red-steady"
              : "red-flash"
            : a.ack
              ? "lit-steady"
              : "lit-flash",
        );
    });

    /* horn jewel + sound follow-up */
    el.jewels.horn.classList.toggle(
      "on",
      (S.horn || (S.tripped && !hornAcked())) && !test,
    );
    sndFollow(st);
  }

  function hornAcked() {
    var a = S.alarms["SAFETY TRIP"];
    return a && a.ack;
  }

  function sndFollow(st) {
    if (!AU.enabled) return;
    var humLevel = 0;
    if (S.running)
      humLevel =
        0.05 + 0.075 * (S.capacity / 100) * (st.oilBar > 0.5 ? 1 : 0.4);
    else if (S.pumpMode > 0) humLevel = 0.022;
    sndSetHum(humLevel);
    var hissLevel = 0;
    if (S.defrost && S.running) hissLevel = 0.05;
    if (S.resPhase === "out") hissLevel = Math.max(hissLevel, 0.04);
    sndSetHiss(hissLevel);
    sndHorn(S.horn && !S.lampsTest);
  }

  /* ------------------------------------------------------------------ boot */

  function build() {
    grab();
    $$("figure.dial").forEach(makeDial);
    $$(".thermo").forEach(buildThermoTicks);
    buildSegDisplay();
    wireStartStop();
    wireSelector();
    wireLever();
    wireDefrostKey();
    wireResurfacer();
    wireAlarmButtons();
    wireMaintTray();
    wireDialog();
    wireSound();

    S = coldState();
    // the paper still holds the tail of the evening's earlier run
    for (var st = -5400; st <= -120; st += 30) {
      var v = -12.1 + 0.55 * Math.sin(st / 700);
      if (st > -3800 && st < -3300) v = -9.4 + 0.4 * Math.sin(st / 60); // defrost bump
      S.chart.push({ s: st, v: v });
    }
    S.lastChart = -120;
    syncControlsToState();
    addLog("Skift börjar — anläggningen är kall");
  }

  /* main loop: real elapsed time feeds the same tick() the probe calls */
  var lastFrame = null;
  function frame(ts) {
    if (lastFrame !== null && !document.hidden) {
      var dt = Math.min(0.25, (ts - lastFrame) / 1000);
      if (dt > 0) tick(dt);
      render();
    }
    lastFrame = ts;
    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) lastFrame = null; // avoid a giant catch-up step
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  function boot() {
    build();
    requestAnimationFrame(frame);
  }
})();
