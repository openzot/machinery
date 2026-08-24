/* ============================================================================
   Deeping Valley Water Board — Filter Gallery Control Bench No. 2
   Four rapid gravity beds polishing river water into a clear well, chlorinated
   at the outlet. Vanilla JS, one IIFE, deterministic simulation behind
   window.machine.
   ========================================================================== */
(function () {
  "use strict";

  var NAME = "Deeping Valley Filter Gallery Control Bench";
  var BED_COUNT = 4;

  /* ------------------------------------------------------------ utilities */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function frac(x) {
    return x - Math.floor(x);
  }
  function hash(n) {
    return frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
  }
  function smooth(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function approach(cur, target, tau, dt) {
    if (tau <= 0) return target;
    return target + (cur - target) * Math.exp(-dt / tau);
  }
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* --------------------------------------------------------------- sound */

  var audio = null;
  function ensureAudio() {
    if (audio) return audio;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audio = new Ctx();
    } catch (e) {
      audio = null;
    }
    return audio;
  }
  function blip(freq, dur, gain, type) {
    var ctx = ensureAudio();
    if (!ctx || ctx.state !== "running") return;
    var t = ctx.currentTime;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = type || "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.03, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function sndClick() {
    blip(1900, 0.025, 0.02, "square");
  }
  function sndClack() {
    blip(320, 0.05, 0.04, "square");
    setTimeout(function () {
      blip(210, 0.06, 0.035, "square");
    }, 40);
  }
  function sndDeny() {
    blip(140, 0.12, 0.04, "sawtooth");
  }
  function sndGong() {
    blip(660, 0.5, 0.05, "sine");
    setTimeout(function () {
      blip(495, 0.7, 0.045, "sine");
    }, 180);
  }

  /* ---------------------------------------------------------- simulation */

  var STAGES = ["IDLE", "DRAIN", "SCOUR", "WASH", "REFILL"];
  var STAGE_SECS = { DRAIN: 30, SCOUR: 45, WASH: 70, REFILL: 40 };

  var sim = null;

  function freshBeds() {
    var dirtStart = [34, 41, 28, 47];
    var beds = [];
    for (var i = 0; i < BED_COUNT; i++) {
      beds.push({
        inlet: 0, // handwheel turns, 0 .. 3
        outlet: 0,
        waste: false, // quarter-turn cock
        dirt: dirtStart[i], // percent blinding
        loh: 0.1, // loss of head, metres
        effluent: 0.1, // NTU leaving the bed
        flow: 0, // ML/d through the bed right now
        breakRamp: 0, // sand-hole leakage 0..1
        faultBed: false,
      });
    }
    return beds;
  }

  function coldState() {
    return {
      T: 0,
      rate: 0.8, // 0.6 .. 1.2
      dose: 0, // mg/l set on the knob, 0 .. 6
      selectorStandby: false,
      clearWell: 62,
      residual: 0,
      ejectorVac: 0,
      supplyOff: false,
      notice: false,
      contamination: 0,
      unmetAccum: 0,
      beds: freshBeds(),
      wash: { stage: "IDLE", bed: -1, t: 0, doneFlash: 0 },
      blowerOn: false,
      blowerTripped: false,
      faultEjector: false,
      faultBedIndex: -1,
      scoured: 0,
      alarms: [],
      acked: {},
    };
  }

  function rawTurbidity(T) {
    var base =
      3.1 +
      1.9 * hash(Math.floor(T / 140)) * 0.6 +
      1.1 * hash(Math.floor(T / 140) + 7);
    // a spate rolls down the valley roughly every seven minutes
    var phase = T % 430;
    var spate = smooth((phase - 295) / 14) * (1 - smooth((phase - 352) / 16));
    return base + spate * 13;
  }

  function demandAt(T) {
    return (
      8.6 +
      2.6 * Math.sin((T * Math.PI * 2) / 480) +
      0.5 * Math.sin((T * Math.PI * 2) / 97 + 1.7)
    );
  }

  function computeAlarms(s, producing) {
    var list = [];
    var i, b;
    for (i = 0; i < BED_COUNT; i++) {
      b = s.beds[i];
      if (b.inlet > 2.4 && b.outlet > 2.4 && !b.waste && b.loh > 2.55) {
        list.push("HIGH LOSS OF HEAD");
        break;
      }
    }
    var turbid = producing && galleryNTU(s) > 1.0;
    var seeping = false;
    for (i = 0; i < BED_COUNT; i++) {
      if (s.beds[i].faultBed && s.beds[i].effluent > 1.0) seeping = true;
    }
    if (turbid || seeping) list.push("TURBIDITY BREAKTHROUGH");
    if (
      (producing && s.residual < 0.15) ||
      (s.faultEjector && s.residual < 0.15)
    )
      list.push("CHLORINE RESIDUAL LOW");
    if (producing && s.clearWell < 22) list.push("CLEAR WELL LOW");
    if (s.blowerTripped) list.push("BACKWASH FAULT");
    if (rawTurbidity(s.T) > 9) list.push("RAW WATER SPATE");
    if (s.supplyOff) list.push("SUPPLY OFF");
    if (s.notice) list.push("PUBLIC NOTICE");
    return list;
  }

  function galleryNTU(s) {
    var worst = 0;
    for (var i = 0; i < BED_COUNT; i++) {
      var b = s.beds[i];
      if (b.flow > 0.05 && b.effluent > worst) worst = b.effluent;
    }
    return worst;
  }

  /* Advance the simulation by dt seconds (already sub-stepped). */
  function step(dt) {
    var s = sim;
    s.T += dt;

    var raw = rawTurbidity(s.T);
    var demand = demandAt(s.T);
    var i, b;

    /* ---- who is on duty ---- */
    var duty = [];
    for (i = 0; i < BED_COUNT; i++) {
      b = s.beds[i];
      b.onDuty =
        !b.waste &&
        b.washing !== true &&
        b.inlet > 2.4 &&
        b.outlet > 2.4 &&
        !s.supplyOff;
      if (b.onDuty) duty.push(i);
    }

    /* ---- share the town demand between the duty beds ---- */
    var want = demand * s.rate;
    var weights = 0;
    for (i = 0; i < duty.length; i++)
      weights += 1 - (0.75 * s.beds[duty[i]].dirt) / 100;
    var made = 0;
    for (i = 0; i < BED_COUNT; i++) {
      b = s.beds[i];
      b.flow = 0;
    }
    for (i = 0; i < duty.length; i++) {
      b = s.beds[duty[i]];
      var w = 1 - (0.75 * b.dirt) / 100;
      var share = weights > 0 ? want * (w / weights) : 0;
      b.flow = clamp(share, 0, 4.6);
      made += b.flow;
    }

    /* ---- dirt, loss of head, effluent ---- */
    for (i = 0; i < BED_COUNT; i++) {
      b = s.beds[i];
      var load = raw / 4;
      if (b.onDuty) {
        b.dirt = clamp(
          b.dirt + dt * 0.115 * (b.flow / 4.0) * Math.pow(load, 1.15),
          0,
          100,
        );
      }
      var lohTarget;
      if (s.wash.stage !== "IDLE" && s.wash.bed === i) {
        lohTarget = { DRAIN: 0.05, SCOUR: 0.42, WASH: 1.15, REFILL: 0.3 }[
          s.wash.stage
        ];
      } else if (!b.onDuty) {
        lohTarget = 0.08;
      } else {
        lohTarget =
          0.22 +
          2.9 * Math.pow(b.dirt / 100, 1.7) * clamp(b.flow / 3.4, 0.2, 1.4);
      }
      b.loh = approach(b.loh, lohTarget, 6, dt);

      /* a bed past its limit cracks; a faulted bed leaks whatever its state */
      if (b.dirt > 92 && b.onDuty)
        b.breakRamp = approach(b.breakRamp, 1, 25, dt);
      else if (!b.faultBed) b.breakRamp = approach(b.breakRamp, 0, 40, dt);
      if (b.faultBed) b.breakRamp = approach(b.breakRamp, 1, 22, dt);

      var clean =
        0.07 +
        0.024 * raw * Math.pow(b.dirt / 100, 2.2) +
        b.breakRamp * Math.min(raw * 0.75, 5);
      b.effluent = approach(
        b.effluent,
        b.onDuty ? clean : b.faultBed ? clean : 0.08,
        b.faultBed ? 18 : 12,
        dt,
      );
    }

    /* ---- backwash sequence ---- */
    var ws = s.wash;
    /* winding the crank with a candidate standing starts the wash */
    if (ws.stage === "IDLE" && windActive()) {
      var cand = -1;
      for (var ci = 0; ci < BED_COUNT; ci++) {
        var cb = s.beds[ci];
        if (cb.waste && cb.inlet < 0.4 && cb.outlet < 0.4) {
          cand = ci;
          break;
        }
      }
      if (cand !== -1) {
        ws.stage = "DRAIN";
        ws.bed = cand;
        ws.t = 0;
        ws.hold = 0;
        sndClack();
      } else if (!ws.denied || ws.denied <= 0) {
        ws.denied = 2.5; /* a short buzz so the fitter knows nothing took */
        sndDeny();
      }
    }
    if (ws.denied > 0) ws.denied -= dt;

    if (ws.stage !== "IDLE") {
      var speed = windActive() ? 5 : 1;
      ws.t += dt * speed;
      var bedW = s.beds[ws.bed];

      if (ws.stage === "SCOUR") {
        if (!s.blowerOn || s.blowerTripped) {
          ws.hold = (ws.hold || 0) + dt;
        } else {
          ws.hold = 0;
          bedW.dirt = clamp(bedW.dirt - dt * speed * 1.4, 4, 100);
        }
        if (ws.t >= STAGE_SECS.SCOUR) {
          ws.stage = "WASH";
          ws.t = 0;
          ws.hold = 0;
        }
      } else {
        if (ws.stage === "DRAIN")
          bedW.dirt = clamp(bedW.dirt - dt * speed * 0.2, 4, 100);
        if (ws.t >= STAGE_SECS[ws.stage]) {
          var idx = STAGES.indexOf(ws.stage);
          ws.stage = STAGES[idx + 1] || "REFILL";
          ws.t = 0;
          if (ws.stage === "REFILL") {
            bedW.dirt = 6;
            bedW.breakRamp = 0;
            bedW.faultBed = false;
            if (sim.faultBedIndex === ws.bed) sim.faultBedIndex = -1;
            sndGong();
            ws.doneFlash = 4;
          }
        }
      }
      if (ws.stage === "REFILL" && ws.t >= STAGE_SECS.REFILL) {
        ws.stage = "IDLE";
        ws.bed = -1;
        ws.t = 0;
      }
      /* washing draws on the clear well */
      if (ws.stage === "WASH") made -= 1.9;
    }

    /* ---- chlorination ---- */
    var vacTarget = 0;
    var dosingLineBad = s.faultEjector && !s.selectorStandby;
    if (
      !dosingLineBad &&
      (s.beds.some(function (x) {
        return x.flow > 0.05;
      }) ||
        s.dose > 0)
    ) {
      vacTarget = 17.5 + hash(Math.floor(s.T / 9)) * 0.8;
    }
    s.ejectorVac = approach(
      s.ejectorVac,
      vacTarget,
      dosingLineBad ? 9 : 3.5,
      dt,
    );

    var doseApplied =
      s.dose > 0 && s.ejectorVac > 9 && !dosingLineBad ? s.dose : 0;
    var resTarget =
      doseApplied > 0
        ? doseApplied * 0.16 * clamp(made / 6 + 0.35, 0.3, 1.2)
        : 0;
    if (made > 0.05) s.residual = approach(s.residual, resTarget, 16, dt);
    else s.residual = approach(s.residual, 0, 220, dt);

    /* ---- clear well balance ---- */
    var net = made - demand;
    if (!s.supplyOff) {
      s.clearWell = clamp(s.clearWell + (net / 35) * dt, 0, 100);
      s.unmetAccum =
        net < 0
          ? s.unmetAccum + (-net * dt) / 60
          : Math.max(0, s.unmetAccum - dt * 2);
    } else {
      /* outlet to town is closed; the beds refill what they can */
      s.clearWell = clamp(
        s.clearWell + (Math.max(made - 1.5, 0) / 35) * dt,
        0,
        100,
      );
      s.unmetAccum += (demand * dt) / 60;
      if (s.clearWell > 30) s.supplyOff = false;
    }
    if (s.clearWell <= 2.01 && !s.supplyOff) {
      s.supplyOff = true;
      sndClack();
    }

    /* ---- public health escalation ---- */
    var badWater = made > 0.05 && (galleryNTU(s) > 1.0 || s.residual < 0.12);
    s.contamination = badWater
      ? s.contamination + dt
      : Math.max(0, s.contamination - dt * 0.6);
    if (s.contamination > 150) {
      s.notice = true;
      s.contamination = 150;
    }

    /* ---- alarms ---- */
    var producing = made > 0.05;
    var list = computeAlarms(s, producing);
    var known = {};
    var fresh = [];
    for (i = 0; i < list.length; i++) {
      known[list[i]] = true;
      if (s.alarms.indexOf(list[i]) === -1) fresh.push(list[i]);
    }
    if (fresh.length) sndClack();
    var nextAcked = {};
    for (i = 0; i < s.alarms.length; i++) {
      var name = s.alarms[i];
      if (known[name] && s.acked[name]) nextAcked[name] = true;
    }
    /* a freshly raised window always flashes, even if previously acknowledged */
    for (i = 0; i < fresh.length; i++) delete nextAcked[fresh[i]];
    s.alarms = list;
    s.acked = nextAcked;
    s.producing = producing;
    s.raw = raw;
    s.demand = demand;
    s.made = made;
  }

  /* ------------------------------------------------------- fixed API ---- */

  function tick(seconds) {
    var remain = clamp(Number(seconds) || 0, 0, 30);
    while (remain > 0) {
      var dt = Math.min(remain, 0.5);
      step(dt);
      remain -= dt;
    }
  }

  var FAULTS = [
    "filter bed breakthrough",
    "chlorine ejector vacuum loss",
    "backwash blower overload",
  ];

  function inject(fault) {
    var s = sim;
    var i,
      worst = -1,
      worstDirt = -1;
    if (fault === "filter bed breakthrough") {
      for (i = 0; i < BED_COUNT; i++) {
        if (s.beds[i].onDuty && s.beds[i].dirt > worstDirt) {
          worstDirt = s.beds[i].dirt;
          worst = i;
        }
      }
      if (worst === -1) worst = 0;
      s.beds[worst].faultBed = true;
      s.faultBedIndex = worst;
    } else if (fault === "chlorine ejector vacuum loss") {
      s.faultEjector = true;
    } else if (fault === "backwash blower overload") {
      s.blowerTripped = true;
    } else {
      throw new Error("unknown fault: " + fault);
    }
    sndClack();
  }

  function reset() {
    sim = coldState();
    crankHold = false;
    spring = 0;
  }

  function state() {
    var s = sim;
    return {
      T: round(s.T),
      alarms: s.alarms.slice(),
      producing: !!s.producing,
      demand: round(s.demand || demandAt(s.T)),
      output: round(s.made || 0),
      ratePct: Math.round(s.rate * 100),
      rawTurbidity: round(s.raw || rawTurbidity(s.T)),
      clearWellPct: round(s.clearWell),
      chlorineResidual: round(s.residual),
      doseSet: round(s.dose),
      ejector: s.selectorStandby ? "STANDBY" : "DUTY",
      ejectorVacuumInHg: round(s.ejectorVac),
      galleryTurbidity: round(galleryNTU(s)),
      supplyOff: !!s.supplyOff,
      publicNotice: !!s.notice,
      unmetWaterMl: round(s.unmetAccum),
      blowerRunning: !!s.blowerOn && !s.blowerTripped,
      blowerTripped: !!s.blowerTripped,
      wash: { stage: s.wash.stage, bed: s.wash.bed + 1 },
      beds: s.beds.map(function (b, i) {
        return {
          bed: i + 1,
          duty: !!b.onDuty,
          inletTurns: round(b.inlet),
          outletTurns: round(b.outlet),
          wasteOpen: !!b.waste,
          dirtPct: round(b.dirt),
          lossOfHeadM: round(b.loh),
          flowMlDay: round(b.flow),
          effluentNtu: round(b.effluent),
          faulted: !!b.faultBed,
        };
      }),
    };
  }

  function round(v) {
    return typeof v === "number" && isFinite(v)
      ? Math.round(v * 1000) / 1000
      : 0;
  }

  /* ------------------------------------------------------------ drawing */

  var SVG_NS = "http://www.w3.org/2000/svg";

  function el(name, attrs, parent) {
    var n = document.createElementNS(SVG_NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function drawWheelFace(button) {
    var svg = el("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
    var defs = el("defs", {}, svg);
    var grad = el(
      "radialGradient",
      { id: "wheeliron-" + ++wheelUid, cx: "35%", cy: "30%" },
      defs,
    );
    el("stop", { offset: "0%", "stop-color": "#7b837c" }, grad);
    el("stop", { offset: "65%", "stop-color": "#4a5049" }, grad);
    el("stop", { offset: "100%", "stop-color": "#2e332e" }, grad);
    var g = el("g", { class: "spin" }, svg);
    el(
      "circle",
      {
        cx: 50,
        cy: 50,
        r: 46,
        fill: "none",
        stroke: "url(#wheeliron-" + wheelUid + ")",
        "stroke-width": 11,
      },
      g,
    );
    for (var i = 0; i < 4; i++) {
      var a = (i * Math.PI) / 2;
      el(
        "line",
        {
          x1: 50 + Math.cos(a) * 9,
          y1: 50 + Math.sin(a) * 9,
          x2: 50 + Math.cos(a) * 41,
          y2: 50 + Math.sin(a) * 41,
          stroke: "#565d56",
          "stroke-width": 7,
          "stroke-linecap": "round",
        },
        g,
      );
    }
    /* the revolving spoke handle tells you the wheel is turning */
    el(
      "circle",
      {
        cx: 9,
        cy: 50,
        r: 5.5,
        fill: "#b3924c",
        stroke: "#5c4520",
        "stroke-width": 1.5,
      },
      g,
    );

    el(
      "circle",
      {
        cx: 50,
        cy: 50,
        r: 9,
        fill: "#8a6a34",
        stroke: "#5c4520",
        "stroke-width": 2,
      },
      g,
    );
    el(
      "rect",
      { x: 48.4, y: 43, width: 3.2, height: 5, rx: 1, fill: "#3a2c10" },
      g,
    );
    button.appendChild(svg);
    button._spinGroup = g;
  }
  var wheelUid = 0;

  function drawManometer(fig) {
    var svg = el("svg", {
      viewBox: "0 0 170 128",
      preserveAspectRatio: "xMidYMid meet",
      "aria-hidden": "true",
    });
    /* reservoir cup at the left, inclined glass rising to the right */
    el(
      "path",
      {
        d: "M10 92 q0 18 16 18 q16 0 16 -18 l0 -18 l-32 0 z",
        fill: "#8f9a94",
        stroke: "#525a54",
        "stroke-width": 2,
      },
      svg,
    );
    el(
      "polygon",
      {
        points: "38,80 158,32 164,44 46,94",
        fill: "rgba(232,240,237,0.72)",
        stroke: "#5f6a64",
        "stroke-width": 2,
      },
      svg,
    );
    /* scale ticks along the incline, 0 to 3 metres */
    for (var i = 0; i <= 6; i++) {
      var t = i / 6;
      var x = lerp(44, 156, t),
        y = lerp(87, 37, t);
      el(
        "line",
        {
          x1: x,
          y1: y,
          x2: x - 6,
          y2: y + 9,
          stroke: "#3c423d",
          "stroke-width": i % 2 ? 1 : 1.8,
        },
        svg,
      );
      if (i % 2 === 0) {
        var tx = el(
          "text",
          {
            x: x - 10,
            y: y + 15,
            "font-size": 9,
            fill: "#28343a",
            "font-weight": "bold",
            "font-family": "Georgia, serif",
            transform: "rotate(-20 " + (x - 10) + " " + (y + 15) + ")",
          },
          svg,
        );
        tx.textContent = String(i / 2);
      }
    }
    /* the mercury thread: a dark sheath line with a bright core */
    var back = el(
      "line",
      {
        x1: 42,
        y1: 86,
        x2: 42,
        y2: 86,
        stroke: "#767e79",
        "stroke-width": 7,
        "stroke-linecap": "round",
      },
      svg,
    );
    var thread = el(
      "line",
      {
        x1: 42,
        y1: 86,
        x2: 42,
        y2: 86,
        stroke: "#eef1f3",
        "stroke-width": 3.4,
        "stroke-linecap": "round",
      },
      svg,
    );
    var meniscus = el(
      "circle",
      {
        cx: 42,
        cy: 86,
        r: 4,
        fill: "#fafcfd",
        stroke: "#8b938e",
        "stroke-width": 0.8,
      },
      svg,
    );
    fig.insertBefore(svg, fig.firstChild);
    fig._thread = thread;
    fig._back = back;
    fig._meniscus = meniscus;
    fig._from = { x: 42, y: 86 };
    fig._to = { x: 158, y: 36 };
  }

  /* dial faces are drawn with the value scale baked in */
  function describeArc(cx, cy, r, a0, a1) {
    var p0 = {
      x: cx + r * Math.sin((a0 * Math.PI) / 180),
      y: cy - r * Math.cos((a0 * Math.PI) / 180),
    };
    var p1 = {
      x: cx + r * Math.sin((a1 * Math.PI) / 180),
      y: cy - r * Math.cos((a1 * Math.PI) / 180),
    };
    var large = a1 - a0 > 180 ? 1 : 0;
    return (
      "M " +
      p0.x.toFixed(2) +
      " " +
      p0.y.toFixed(2) +
      " A " +
      r +
      " " +
      r +
      " 0 " +
      large +
      " 1 " +
      p1.x.toFixed(2) +
      " " +
      p1.y.toFixed(2)
    );
  }

  function drawDialScaled(holder, opt) {
    var svg = el("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
    var c = 50,
      cy = 52,
      r = 36;
    function ang(v) {
      return -120 + 240 * ((v - opt.min) / (opt.max - opt.min));
    }
    el(
      "circle",
      {
        cx: c,
        cy: cy,
        r: 44,
        fill: "#f6f2e3",
        stroke: "#c9c2ab",
        "stroke-width": 1,
      },
      svg,
    );
    if (opt.redFrom != null) {
      el(
        "path",
        {
          d: describeArc(
            c,
            cy,
            r + 3.5,
            ang(opt.redFrom),
            ang(opt.redTo == null ? opt.max : opt.redTo),
          ),
          fill: "none",
          stroke: "#b81f2d",
          "stroke-width": 3.4,
        },
        svg,
      );
    }
    var ticks = 8;

    for (var i = 0; i <= ticks; i++) {
      var v = lerp(opt.min, opt.max, i / ticks);
      var a = (ang(v) * Math.PI) / 180;
      var inner = i % 2 === 0 ? r - 6 : r - 3.5;
      el(
        "line",
        {
          x1: c + Math.sin(a) * inner,
          y1: cy - Math.cos(a) * inner,
          x2: c + Math.sin(a) * (r - 0.5),
          y2: cy - Math.cos(a) * (r - 0.5),
          stroke: "#2b3330",
          "stroke-width": i % 2 === 0 ? 1.6 : 0.9,
        },
        svg,
      );
      if (i % 2 === 0) {
        var lr = r - 12.5;
        var tx = el(
          "text",
          {
            x: c + Math.sin(a) * lr,
            y: cy - Math.cos(a) * lr + 2.6,
            "text-anchor": "middle",
            "font-size": 8.6,
            fill: "#1c2b2b",
            "font-family": "Georgia, serif",
          },
          svg,
        );
        tx.textContent = opt.tickLabels[i / 2];
      }
    }
    var sub = el(
      "text",
      {
        x: c,
        y: cy + 20,
        "text-anchor": "middle",
        "font-size": 6.2,
        fill: "#5c6258",
        "letter-spacing": 0.8,
        "font-family": "'Trebuchet MS', Verdana, sans-serif",
      },
      svg,
    );
    sub.textContent = opt.sub || "";
    holder.appendChild(svg);
    var needle = document.createElement("div");
    needle.className = "needle";
    holder.appendChild(needle);
    var boss = document.createElement("div");
    boss.className = "boss";
    holder.appendChild(boss);
    holder._set = function (v) {
      var a = ang(clamp(Number(v) || 0, opt.min, opt.max));
      needle.style.transform =
        "translate(-50%,-100%) rotate(" + a.toFixed(1) + "deg)";
    };
    holder._set(opt.min);
  }

  /* ------------------------------------------------------------ ui refs */

  var uiRefs = {};
  var crankHold = false; /* the fitter is actually turning the handle */
  var spring = 0; /* stored winding that keeps the cam timer running */
  var lampsTestUntil = 0;
  function windActive() {
    return crankHold || spring > 0;
  }

  function cacheDom() {
    uiRefs.clock = $("#clock");
    uiRefs.mains = $("#mainsNeon");
    uiRefs.anns = {};
    $all(".ann").forEach(function (n) {
      uiRefs.anns[n.getAttribute("data-ann")] = n;
    });
    uiRefs.acceptBtn = $("#acceptBtn");
    uiRefs.lampsBtn = $("#lampsBtn");
    uiRefs.beds = $all(".bed").map(function (elm, idx) {
      var fig = $(".manometer", elm);
      drawManometer(fig);
      var glass = $(".sightglass", elm);
      var bubbles = $(".bubbles", elm);
      for (var i = 0; i < 5; i++)
        bubbles.appendChild(document.createElement("i"));
      var wheels = {};
      $all(".wheel", elm).forEach(function (w) {
        drawWheelFace(w);
        var isInlet = /INLET/.test(w.getAttribute("data-control"));
        wheels[isInlet ? "inlet" : "outlet"] = w;
        w._turns = 0;
        wireWheel(w);
      });
      var cock = $(".cock", elm);
      cock._open = false;
      wireCock(cock);
      return {
        root: elm,
        fig: fig,
        glass: glass,
        water: $(".water", glass),
        lampDuty: $(".lamp-duty", elm),
        lampWash: $(".lamp-wash", elm),
        lampIsol: $(".lamp-isol", elm),
        wheels: wheels,
        cock: cock,
        counts: $all(".turncount", elm),
      };
    });
    uiRefs.dialRaw = $("#dialRaw");
    drawDialScaled(uiRefs.dialRaw, {
      min: 0,
      max: 20,
      redFrom: 9,
      tickLabels: ["0", "5", "10", "15", "20"],
      sub: "RAW NTU",
    });
    uiRefs.dialEjector = $("#dialEjector");
    drawDialScaled(uiRefs.dialEjector, {
      min: 0,
      max: 30,
      redFrom: 0,
      redTo: 8,
      tickLabels: ["0", "8", "15", "22", "30"],
      sub: "VAC IN HG",
    });
    uiRefs.dialFlow = $("#dialFlow");
    drawDialScaled(uiRefs.dialFlow, {
      min: 0,
      max: 18,
      redFrom: 14.5,
      tickLabels: ["0", "5", "9", "14", "18"],
      sub: "OUT ML/D",
    });
    uiRefs.dialDemand = $("#dialDemand");
    drawDialScaled(uiRefs.dialDemand, {
      min: 0,
      max: 18,
      tickLabels: ["0", "5", "9", "14", "18"],
      sub: "TOWN ML/D",
    });
    uiRefs.compSample = $("#compSample");
    uiRefs.compPointer = $("#compPointer");
    uiRefs.levelWater = $(".levelglass .water");
    uiRefs.levelPct = $("#levelPct");
    uiRefs.crank = $(".crank");
    uiRefs.crankArm = $(".crank-arm", uiRefs.crank);
    uiRefs.stagelamps = {};
    $all(".stagelamp").forEach(function (s) {
      uiRefs.stagelamps[s.getAttribute("data-stage")] = s;
    });
    uiRefs.washNote = $("#washNote");
    uiRefs.blowerBtn = $("#blowerBtn");
    uiRefs.blowerReset = $("#blowerResetBtn");
    uiRefs.blowerLamp = $("#blowerLamp");
    uiRefs.doseKnob = $(".knob-dose");
    uiRefs.doseLabel = $("#doseLabel");
    uiRefs.selector = $(".selector");
    uiRefs.selScale = $all(".sel-scale b");
    uiRefs.rateLever = $(".ratelever");
    uiRefs.ratePct = $("#ratePct");
    uiRefs.drawerCover = $("#drawerCover");
    uiRefs.drawerTray = $("#drawerTray");
    uiRefs.testButtons = $all(".pb-test");
    uiRefs.resetBtn = $("#resetBtn");
    uiRefs.dialog = $("#manualDialog");

    wireKnob(uiRefs.doseKnob);
    wireSelector(uiRefs.selector);
    wireRate(uiRefs.rateLever);
    wireCrank(uiRefs.crank);
    wireButtons();
    wireManual();
  }

  /* -------------------------------------------------------- control wiring */

  function wireWheel(w) {
    var dragging = false,
      lastAng = 0;
    function angleOf(e) {
      var r = w.getBoundingClientRect();
      return Math.atan2(
        e.clientY - (r.top + r.height / 2),
        e.clientX - (r.left + r.width / 2),
      );
    }
    w.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastAng = angleOf(e);
      w.setPointerCapture && w.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    w.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var a = angleOf(e);
      var d = a - lastAng;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      lastAng = a;
      var before = w._turns;
      w._turns = clamp(before + d / (2 * Math.PI), 0, 3);
      checkDetent(before, w._turns);
    });
    var stop = function () {
      dragging = false;
    };
    w.addEventListener("pointerup", stop);
    w.addEventListener("pointercancel", stop);
    w.addEventListener("keydown", function (e) {
      var stepKey = 0.5;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        w._turns = clamp(w._turns + stepKey, 0, 3);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        w._turns = clamp(w._turns - stepKey, 0, 3);
      } else if (e.key === "Enter" || e.key === " ") {
        w._turns = w._turns > 2.6 ? 0 : 3;
        sndClick();
      } else return;
      checkDetent(-1, w._turns);
      e.preventDefault();
    });
  }
  function checkDetent(before, after) {
    if (Math.floor(after * 2) !== Math.floor(before * 2)) sndClick();
  }

  function wireCock(c) {
    c.addEventListener("click", function () {
      c._open = !c._open;
      c.classList.toggle("open", c._open);
      sndClick();
    });
    c.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        c.click();
      }
    });
  }

  function wireCrank(crank) {
    var ang = 0;
    function charge(e) {
      crankHold = true;
      spring = Math.min(Math.max(spring, 1) + 6, 14);
      if (e && e.pointerId != null && crank.setPointerCapture) {
        try {
          crank.setPointerCapture(e.pointerId);
        } catch (err) {}
      }
      if (e) e.preventDefault();
    }
    function release() {
      crankHold = false;
    }
    crank.addEventListener("pointerdown", charge);
    crank.addEventListener("pointerup", release);
    crank.addEventListener("pointercancel", release);
    crank.addEventListener("lostpointercapture", release);
    crank.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) charge(e);
    });
    crank.addEventListener("keyup", function (e) {
      if (e.key === "Enter" || e.key === " ") release();
    });
    crank._spin = function (dt) {
      /* the spring runs down when the handle stops; holding tops it up */
      if (crankHold) spring = Math.min(spring + dt * 4, 14);
      else spring = Math.max(0, spring - dt);
      if (!windActive()) return;
      ang += dt * 520;
      uiRefs.crankArm.style.transform =
        "rotate(" + (ang % 360).toFixed(1) + "deg)";
      if (Math.floor(ang / 90) !== Math.floor((ang - dt * 520) / 90))
        sndClick();
    };
  }

  function wireKnob(knob) {
    var dragging = false,
      startY = 0,
      startV = 0;
    function set(v) {
      setDose(v);
    }
    knob.addEventListener("pointerdown", function (e) {
      dragging = true;
      startY = e.clientY;
      startV = sim.dose;
      knob.setPointerCapture && knob.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    knob.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      set(startV + (startY - e.clientY) / 14);
    });
    knob.addEventListener("pointerup", function () {
      dragging = false;
    });
    knob.addEventListener("pointercancel", function () {
      dragging = false;
    });
    knob.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") set(sim.dose + 0.5);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
        set(sim.dose - 0.5);
      else if (e.key === "Enter" || e.key === " ")
        set(sim.dose >= 6 ? 0 : sim.dose + 0.5);
      else return;
      e.preventDefault();
    });
  }
  function setDose(v, silent) {
    var before = sim.dose;
    sim.dose = clamp(Math.round(v * 2) / 2, 0, 6);
    if (!silent && before !== sim.dose) sndClick();
    uiRefs.doseKnob.style.setProperty(
      "--rot",
      (sim.dose / 6) * 270 - 135 + "deg",
    );
    uiRefs.doseLabel.textContent = sim.dose.toFixed(1).replace(/\.0$/, "");
  }

  function wireSelector(sel) {
    sel.addEventListener("click", function () {
      setSelector(!sim.selectorStandby);
    });
    sel.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") setSelector(false);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
        setSelector(true);
      else if (e.key === "Enter" || e.key === " ") {
        setSelector(!sim.selectorStandby);
      } else return;
      e.preventDefault();
    });
  }
  function setSelector(standby, silent) {
    if (sim.selectorStandby !== standby && !silent) sndClick();
    sim.selectorStandby = standby;
    uiRefs.selector.style.setProperty("--sel", standby ? "35deg" : "-35deg");
    uiRefs.selScale[0].classList.toggle("active", !standby);
    uiRefs.selScale[1].classList.toggle("active", standby);
  }

  var RATE_STEPS = [0.6, 0.8, 1.0, 1.2];
  function wireRate(lever) {
    lever.addEventListener("click", function () {
      var idx = RATE_STEPS.indexOf(sim.rate);
      setRate(RATE_STEPS[(idx + 1) % RATE_STEPS.length]);
    });
    lever.addEventListener("keydown", function (e) {
      var idx = RATE_STEPS.indexOf(sim.rate);
      if (e.key === "ArrowUp" || e.key === "ArrowRight")
        setRate(RATE_STEPS[clamp(idx + 1, 0, 3)]);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft")
        setRate(RATE_STEPS[clamp(idx - 1, 0, 3)]);
      else if (e.key === "Enter" || e.key === " ")
        setRate(RATE_STEPS[(idx + 1) % RATE_STEPS.length]);
      else return;
      e.preventDefault();
    });
  }
  function setRate(rate, silent) {
    if (RATE_STEPS.indexOf(rate) === -1)
      rate = RATE_STEPS.reduce(function (a, b) {
        return Math.abs(b - rate) < Math.abs(a - rate) ? b : a;
      });
    if (rate !== sim.rate && !silent) sndClick();
    sim.rate = rate;
    var deg = lerp(-52, 52, (rate - 0.6) / 0.6);
    uiRefs.rateLever.style.setProperty("--rate", deg + "deg");
    uiRefs.ratePct.textContent = String(Math.round(rate * 100));
  }

  function wireButtons() {
    uiRefs.acceptBtn.addEventListener("click", function () {
      sim.alarms.forEach(function (a) {
        sim.acked[a] = true;
      });
      sndClick();
    });
    uiRefs.lampsBtn.addEventListener("click", function () {
      lampsTestUntil = performance.now() + 2000;
      sndClick();
    });
    uiRefs.blowerBtn.addEventListener("click", function () {
      if (sim.blowerTripped) {
        sndDeny();
        return;
      }
      sim.blowerOn = !sim.blowerOn;
      uiRefs.blowerBtn.classList.toggle("armed", sim.blowerOn);
      sndClack();
    });
    uiRefs.blowerReset.addEventListener("click", function () {
      if (sim.blowerTripped) {
        sim.blowerTripped = false;
        delete sim.acked["BACKWASH FAULT"];
        sndClack();
      } else sndClick();
    });
    uiRefs.drawerCover.addEventListener("click", function () {
      var open = uiRefs.drawerTray.hidden;
      uiRefs.drawerTray.hidden = !open;
      uiRefs.drawerCover.setAttribute("aria-expanded", open ? "true" : "false");
      uiRefs.drawerCover.textContent = open
        ? "Fault test switches — shut lid"
        : "Fault test switches — lift lid";
      sndClick();
    });
    uiRefs.testButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        inject(b.getAttribute("data-fault"));
      });
    });
    uiRefs.resetBtn.addEventListener("click", function () {
      reset();
      uiRefs.blowerBtn.classList.remove("armed");
      sndClack();
    });
  }

  function wireManual() {
    $('[data-action="manual"]').addEventListener("click", function () {
      uiRefs.dialog.showModal();
    });
    $('[data-action="close-manual"]').addEventListener("click", function () {
      uiRefs.dialog.close();
    });
  }

  /* ------------------------------------------------------------- render */

  function residualColour(r) {
    var stops = [
      [0.0, [227, 234, 223]],
      [0.1, [211, 226, 198]],
      [0.2, [186, 220, 171]],
      [0.3, [148, 205, 144]],
      [0.5, [92, 173, 113]],
      [0.8, [40, 130, 82]],
    ];
    var i = 0;
    while (i < stops.length - 1 && r > stops[i + 1][0]) i++;
    if (i >= stops.length - 1) return stops[stops.length - 1][1];
    var t = (r - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
    var a = stops[i][1],
      b = stops[i + 1][1];
    return [0, 1, 2].map(function (k) {
      return Math.round(lerp(a[k], b[k], t));
    });
  }

  function render(now) {
    var s = sim;
    var testing = now < lampsTestUntil;

    /* clock: the works day runs at sixty times real time from six in the morning */
    var mins = 6 * 60 + Math.floor(s.T);
    var hh = String(Math.floor(mins / 60) % 24);
    var mm = String(mins % 60);
    uiRefs.clock.textContent =
      "0".slice(hh.length > 1 ? 1 : 0) + hh + ":" + ("0" + mm).slice(-2);
    uiRefs.mains.classList.toggle("off", false);

    /* annunciator */
    Object.keys(uiRefs.anns).forEach(function (name) {
      var n = uiRefs.anns[name];
      var active = s.alarms.indexOf(name) !== -1;
      if (testing) {
        n.className = "ann unacked";
        return;
      }
      n.classList.toggle("unacked", active && !s.acked[name]);
      n.classList.toggle("acked", active && !!s.acked[name]);
    });

    /* beds */
    s.beds.forEach(function (b, i) {
      var ui = uiRefs.beds[i];
      /* the drawn controls own their positions: read them into the model */
      b.inlet = clamp(ui.wheels.inlet._turns || 0, 0, 3);
      b.outlet = clamp(ui.wheels.outlet._turns || 0, 0, 3);
      b.waste = !!ui.cock._open;
      var fracT = clamp(b.loh / 3.2, 0, 1);
      var x = lerp(ui.fig._from.x, ui.fig._to.x, fracT);
      var y = lerp(ui.fig._from.y, ui.fig._to.y, fracT);
      ui.fig._thread.setAttribute("x2", x.toFixed(1));
      ui.fig._thread.setAttribute("y2", y.toFixed(1));
      ui.fig._back.setAttribute("x2", x.toFixed(1));
      ui.fig._back.setAttribute("y2", y.toFixed(1));

      var washing = s.wash.stage !== "IDLE" && s.wash.bed === i;
      var duty = !!b.onDuty;
      var isol = !duty && !washing;
      ui.root.classList.toggle("washing", washing);
      ui.lampDuty.classList.toggle("on", testing || duty);
      ui.lampWash.classList.toggle("on", testing || washing);
      ui.lampIsol.classList.toggle("on", testing || isol);

      var ntu = Math.max(b.effluent, 0);
      ui.water.style.opacity = String(
        testing ? 0.9 : clamp(0.3 + ntu * 0.14, 0.3, 0.88),
      );
      if (washing && s.wash.stage === "WASH") {
        ui.water.style.opacity = String(
          clamp(0.3 + (1 - s.wash.t / STAGE_SECS.WASH) * 0.55, 0.3, 0.9),
        );
      }
      ui.water.style.background =
        washing && s.wash.stage === "WASH" ? "#6b5b33" : "";

      ui.wheels.inlet._spinGroup.style.transform =
        "rotate(" + (b.inlet * 360).toFixed(0) + "deg)";
      ui.wheels.outlet._spinGroup.style.transform =
        "rotate(" + (b.outlet * 360).toFixed(0) + "deg)";
      ui.counts[0].textContent = String(Math.round(b.inlet * 10) / 10);
      ui.counts[1].textContent = String(Math.round(b.outlet * 10) / 10);
      ui.cock.classList.toggle("open", b.waste);
    });

    /* chlorination */
    uiRefs.dialRaw._set(testing ? 20 : s.raw);
    uiRefs.dialEjector._set(s.ejectorVac);
    uiRefs.dialFlow._set(s.made || 0);
    uiRefs.dialDemand._set(s.demand || demandAt(s.T));

    var r = clamp(s.residual, 0, 0.8);
    var col = residualColour(r);
    uiRefs.compSample.style.background = "rgb(" + col.join(",") + ")";
    uiRefs.compSample.style.left =
      4 +
      clamp(r / 0.6, 0, 1) *
        (uiRefs.compSample.parentElement.clientWidth - 24) +
      "px";
    var marks = [0, 0.1, 0.2, 0.3, 0.5];
    var best = 0;
    marks.forEach(function (m, i) {
      if (Math.abs(m - r) < Math.abs(marks[best] - r)) best = i;
    });
    uiRefs.compPointer.style.left =
      4 +
      (best / (marks.length - 1)) *
        (uiRefs.compPointer.parentElement.clientWidth - 16) +
      "px";

    /* clear well */
    uiRefs.levelWater.style.height =
      (testing ? 100 : clamp(s.clearWell, 0, 100)) + "%";
    uiRefs.levelPct.textContent = String(Math.round(s.clearWell));

    /* wash bay */
    STAGES.forEach(function (st) {
      var lampElm = uiRefs.stagelamps[st];
      lampElm.classList.toggle("on", st === s.wash.stage);
      lampElm.classList.toggle("done", st === "IDLE" && s.wash.doneFlash > 0);
    });
    uiRefs.blowerLamp.classList.toggle(
      "on",
      testing || (s.blowerOn && !s.blowerTripped),
    );

    var note;
    if (s.wash.stage === "IDLE") {
      note =
        "No bed in the wash. Shut a bed's inlet and outlet, open its waste cock, then wind the timer.";
    } else if (s.wash.stage === "SCOUR" && (!s.blowerOn || s.blowerTripped)) {
      note =
        "Air scour held — the blower is " +
        (s.blowerTripped
          ? "tripped; press BLOWER RESET."
          : "not running; press BLOWER START.");
    } else {
      note =
        "Washing bed " +
        (s.wash.bed + 1) +
        ": " +
        s.wash.stage.toLowerCase() +
        ", " +
        Math.ceil(
          Math.max(STAGE_SECS[s.wash.stage] - s.wash.t, 0) /
            (windActive() ? 5 : 1),
        ) +
        " s to the next stage at this wind.";
    }
    uiRefs.washNote.textContent = note;

    /* controls whose positions mirror the sim state */

    uiRefs.doseKnob.style.setProperty(
      "--rot",
      (s.dose / 6) * 270 - 135 + "deg",
    );
    uiRefs.doseLabel.textContent = String(s.dose)
      .replace(/\.0$/, "")
      .replace(/\.5$/, ".5");
    uiRefs.selector.style.setProperty(
      "--sel",
      s.selectorStandby ? "35deg" : "-35deg",
    );
    uiRefs.selScale[0].classList.toggle("active", !s.selectorStandby);
    uiRefs.selScale[1].classList.toggle("active", s.selectorStandby);
    var rateDeg = lerp(-52, 52, (s.rate - 0.6) / 0.6);
    uiRefs.rateLever.style.setProperty("--rate", rateDeg + "deg");
    uiRefs.ratePct.textContent = String(Math.round(s.rate * 100));
    uiRefs.blowerBtn.classList.toggle("armed", s.blowerOn);

    /* fitters' bay latches */

    uiRefs.testButtons.forEach(function (b) {
      var f = b.getAttribute("data-fault");
      var on =
        (f === "filter bed breakthrough" && sim.faultBedIndex !== -1) ||
        (f === "chlorine ejector vacuum loss" && sim.faultEjector) ||
        (f === "backwash blower overload" && sim.blowerTripped);
      b.classList.toggle("latched", on);
    });
  }

  /* ------------------------------------------------------------- boot */

  function frame(last) {
    return function (now) {
      var dt = Math.min((now - last) / 1000, 2);
      last = now;
      if (!document.hidden) {
        tick(dt);
        uiRefs.crank._spin(dt);
        if (sim.wash.doneFlash > 0) sim.wash.doneFlash -= dt;
      }
      render(now);
      requestAnimationFrame(frame(now));
    };
  }

  function boot() {
    reset();
    cacheDom();
    /* gesture unlocks the little sounds the panel makes */
    var unlock = function () {
      var ctx = ensureAudio();
      if (ctx && ctx.state === "suspended") ctx.resume();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    requestAnimationFrame(frame(performance.now()));
  }

  /* -------------------------------------------- expose the fixed API */

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
