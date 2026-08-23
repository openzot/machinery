/* ============================================================
   Haverbrack Transmitting Station — Transmitter No. 2
   1943 · 12 kW short-wave broadcast transmitter control panel
   Simulation + panel behaviour. Vanilla script, no dependencies.
   ============================================================ */
(function () {
  "use strict";

  var MACHINE_NAME = "Haverbrack Transmitting Station — Transmitter No. 2";
  var FAULTS = [
    "rectifier arc-back",
    "cooling water flow loss",
    "main feeder fault",
  ];

  /* ---------------- simulation constants ---------------- */

  var HT_RUNNING_KV = 11;
  var FILAMENT_HOT_V = 33;
  var INLET_TEMP_C = 17.5;

  /* bands: resonant drum position and resonance width per waveband */
  var BANDS = [
    { metres: 31, r: 57, w: 5.2 },
    { metres: 41, r: 47, w: 5.8 },
    { metres: 49, r: 38, w: 6.4 },
    { metres: 61, r: 66, w: 7.0 },
  ];

  /* aerial system: tuning offset and coupling gain of each position */
  var AERIALS = [
    { name: "DUMMY LOAD", off: 4, gain: 1.16 },
    { name: "DIPOLE NORTH", off: -3, gain: 1.0 },
    { name: "RHOMBIC SOUTH", off: 9, gain: 0.92 },
    { name: "SPARE FEEDER", off: -8, gain: 1.06 },
  ];

  var ALARMS = [
    "ARC BACK",
    "WATER FLOW LOW",
    "WATER TEMP HIGH",
    "PA OVERLOAD",
    "FEEDER FAULT",
    "HT LOCKED OUT",
  ];

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }
  function norm(s) {
    return String(s == null ? "" : s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  /* ---------------- machine state ---------------- */

  var S;
  var feederFaultActive = false;

  function coldState() {
    return {
      breaker: false,
      blower: false,
      filamentSw: false,
      standbyPump: false,
      guardArmed: false,
      aerialIndex: 0,
      bandIndex: 2,
      tuningPos: 50,
      loadingNotch: 0,
      driveSteps: 0,
      filamentVolts: 0,
      htKV: 0,
      paAnodeAmps: 0,
      aerialAmps: 0,
      refPowerW: 0,
      anodeKw: 0,
      waterTempC: INLET_TEMP_C,
      waterFlowLpm: 0,
      pumpEff: 1,
      standbyEff: 0,
      modPct: 0,
      htCommanded: false,
      tripped: false,
      tripReason: "",
      lockout: false,
      arcBackLatch: false,
      feederFaultRamp: 0,
      overloadTimer: 0,
      simSeconds: 0,
      ann: {},
      onAir: false,
    };
  }

  /* ---------------- physics ---------------- */

  function resonance() {
    return (
      BANDS[S.bandIndex].r +
      AERIALS[S.aerialIndex].off +
      2.0 * S.loadingNotch +
      12 * S.feederFaultRamp
    );
  }

  function derived() {
    var band = BANDS[S.bandIndex];
    var air = AERIALS[S.aerialIndex];
    var delta = S.tuningPos - resonance();
    var w = band.w;
    var htN = S.htKV / HT_RUNNING_KV;
    var driveF = S.driveSteps / 10;

    /* class-C PA: anode current runs away off tune */
    var detuneSq = Math.pow(delta / w, 2);
    var paLoad = 0.9 + 1.02 * S.loadingNotch;
    var pa = driveF * htN * paLoad * (1 + 1.35 * Math.min(detuneSq, 3.4));

    /* aerial current: bell curve over the drum, killed by feeder trouble */
    var feederKill = 1 - 0.55 * S.feederFaultRamp;
    var coupling = 0.3 + 0.55 * S.loadingNotch;
    var peak = driveF * htN * air.gain * coupling * 9.2 * feederKill;
    var ant = peak * Math.exp(-detuneSq / 2);

    /* reflected power from a sick feeder */
    var refl = S.feederFaultRamp * 430 * Math.exp(-detuneSq / 8);

    /* anode dissipation heats the distilled water */
    var kw = pa * S.htKV * 0.33;

    return { delta: delta, w: w, pa: pa, ant: ant, refl: refl, kw: kw };
  }

  function step(dt) {
    var i, a;
    S.simSeconds += dt;

    /* filament heating */
    if (S.breaker && S.filamentSw) {
      S.filamentVolts += (FILAMENT_HOT_V - S.filamentVolts) * (dt / 4.6);
    } else {
      S.filamentVolts += (0 - S.filamentVolts) * (dt / 9);
    }
    if (S.filamentVolts < 0.05) S.filamentVolts = 0;

    /* cooling water */
    var flow = S.breaker ? Math.max(45 * S.pumpEff, 45 * S.standbyEff) : 0;
    S.standbyEff = clamp(
      S.standbyEff + (S.standbyPump && S.breaker ? dt / 6 : -dt / 4),
      0,
      1,
    );
    S.waterFlowLpm += (flow - S.waterFlowLpm) * clamp(dt / 1.6, 0, 1);

    /* high tension */
    if (S.htCommanded && !S.tripped && !S.arcBackLatch) {
      S.htKV += (HT_RUNNING_KV - S.htKV) * clamp(dt / 1.9, 0, 1);
    } else {
      S.htKV *= Math.max(0, 1 - dt / 0.28);
      if (S.htKV < 0.02) S.htKV = 0;
    }

    var d = derived();
    S.paAnodeAmps = d.pa;
    S.aerialAmps = d.ant;
    S.refPowerW = d.refl;
    S.anodeKw = d.kw;

    /* water temperature against anode dissipation:
       equilibrium sits near 42 C at rated dissipation with full flow */
    var cool = 0.0214 * (S.waterFlowLpm / 45);
    var heat = 0.07 * S.anodeKw;
    S.waterTempC += (heat - cool * (S.waterTempC - INLET_TEMP_C)) * dt;

    /* programme modulation once the carrier is steady */
    var t = S.simSeconds;
    var tuned = Math.abs(d.delta) <= d.w * 0.75;
    S.onAir =
      S.htKV > 10.2 &&
      S.aerialAmps >= 7.2 &&
      tuned &&
      !S.tripped &&
      !S.arcBackLatch;
    if (S.onAir) {
      S.modPct = clamp(
        46 + 27 * Math.sin(t * 0.37) + 14 * Math.sin(t * 0.113),
        0,
        96,
      );
    } else {
      S.modPct = 0;
    }

    /* feeder fault builds only on the faulted feeders; isolating them cures it */
    var feederEngaged = S.aerialIndex === 1 || S.aerialIndex === 2;
    var want = feederFaultActive && feederEngaged ? 1 : 0;
    S.feederFaultRamp += (want - S.feederFaultRamp) * clamp(dt / 9, 0, 1);
    if (S.feederFaultRamp < 0.005) S.feederFaultRamp = 0;

    /* protection: anode overload timer */
    if (S.paAnodeAmps > 4.4 && S.htKV > 2) {
      S.overloadTimer += dt;
    } else {
      S.overloadTimer = Math.max(0, S.overloadTimer - dt * 2);
    }
    if (S.paAnodeAmps > 5.2 && S.overloadTimer > 4) trip("PA OVERLOAD");

    /* protection: cooling water */
    if (S.waterTempC > 68 && S.htKV > 0.5 && !S.tripped)
      trip("WATER TEMP HIGH");

    /* alarms */
    setAlarm("ARC BACK", S.arcBackLatch);
    setAlarm(
      "WATER FLOW LOW",
      S.pumpEff < 0.6 && !(S.standbyPump && S.standbyEff > 0.85),
    );
    setAlarm("WATER TEMP HIGH", S.waterTempC > 60);
    setAlarm(
      "PA OVERLOAD",
      S.tripReason === "PA OVERLOAD" || S.overloadTimer > 1.5,
    );
    setAlarm("FEEDER FAULT", feederFaultActive);
    setAlarm("HT LOCKED OUT", S.lockout);

    /* expire acknowledgements when their alarm has gone */
    for (i = 0; i < ALARMS.length; i++) {
      a = S.ann[ALARMS[i]];
      if (a && !a.active) delete S.ann[ALARMS[i]];
    }
  }

  function trip(reason) {
    S.tripped = true;
    S.tripReason = reason;
    S.htCommanded = false;
    S.guardArmed = false;
    S.lockout = reason === "WATER TEMP HIGH";
  }

  function setAlarm(name, active) {
    var a = S.ann[name];
    if (!a) {
      if (active) S.ann[name] = { active: true, acked: false };
    } else {
      a.active = active;
    }
  }

  function activeAlarms() {
    var out = [];
    for (var i = 0; i < ALARMS.length; i++) {
      if (S.ann[ALARMS[i]] && S.ann[ALARMS[i]].active) out.push(ALARMS[i]);
    }
    return out;
  }

  function round(v, dp) {
    var m = Math.pow(10, dp === undefined ? 2 : dp);
    return Math.round(v * m) / m;
  }

  /* ---------------- public API ---------------- */

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),

    state: function () {
      return {
        breaker: S.breaker,
        blower: S.blower,
        filamentSwitch: S.filamentSw,
        standbyPump: S.standbyPump,
        filamentVolts: round(S.filamentVolts),
        filamentReady: S.filamentVolts >= 31.5,
        htKilovolts: round(S.htKV),
        htRunning: S.htCommanded,
        tripped: S.tripped,
        tripReason: S.tripReason,
        lockedOut: S.lockout,
        rectifierArcBack: S.arcBackLatch,
        bandMetres: BANDS[S.bandIndex].metres,
        aerial: AERIALS[S.aerialIndex].name,
        tuningPosition: round(S.tuningPos),
        resonancePosition: round(resonance()),
        loadingNotch: S.loadingNotch,
        driveSteps: S.driveSteps,
        paAnodeAmps: round(S.paAnodeAmps),
        aerialAmps: round(S.aerialAmps),
        reflectedPowerWatts: round(S.refPowerW),
        anodeDissipationKw: round(S.anodeKw),
        waterTemperatureC: round(S.waterTempC),
        waterFlowLpm: round(S.waterFlowLpm),
        modulationPercent: round(S.modPct),
        onAir: S.onAir,
        runSeconds: round(S.simSeconds, 1),
        alarms: activeAlarms(),
      };
    },

    tick: function (seconds) {
      var dt = Number(seconds);
      if (!isFinite(dt) || dt <= 0) return;
      dt = Math.min(dt, 120);
      var n = Math.min(240, Math.ceil(dt / 0.25));
      var h = dt / n;
      for (var i = 0; i < n; i++) step(h);
    },

    inject: function (fault) {
      var f = norm(fault);
      if (f === norm(FAULTS[0])) {
        /* the arc-back condition: HT trips and stays locked until restored */
        S.arcBackLatch = true;
        trip("ARC BACK");
      } else if (f === norm(FAULTS[1])) {
        S.pumpEff = 0; /* main cooling pump shaft lets go */
      } else if (f === norm(FAULTS[2])) {
        feederFaultActive = true; /* a main feeder develops a fault */
      }
    },

    reset: function () {
      feederFaultActive = false;
      S = coldState();
      syncControls();
      render();
    },
  };

  /* ---------------- DOM handles ---------------- */

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    breaker: $("ctl-breaker"),
    blower: $("ctl-blower"),
    filament: $("ctl-filament"),
    pump: $("ctl-pump"),
    htstart: $("ctl-htstart"),
    htguardWrap: document.querySelector(".guard-wrap"),
    htguard: $("ht-guard"),
    tripreset: $("ctl-tripreset"),
    rectrestore: $("ctl-rectrestore"),
    crank: $("ctl-crank"),
    vernier: $("vernier-scale"),
    loading: $("ctl-loading"),
    drive: $("ctl-drive"),
    aerial: $("ctl-aerial"),
    band: $("ctl-band"),
    accept: $("btn-accept"),
    lamps: $("btn-lamps"),
    resetBtn: $("btn-reset"),
    rectWindow: $("rectifier-window"),
    onair: $("onair-lamp"),
    tripflag: $("trip-flag"),
    sightglass: $("sightglass-fill"),
  };

  var annWins = {};
  Array.prototype.forEach.call(
    document.querySelectorAll(".ann-window"),
    function (w) {
      annWins[w.getAttribute("data-alarm")] = w;
    },
  );

  var jewels = {
    aux: $("j-aux"),
    blower: $("j-blower"),
    ready: $("j-ready"),
    pump: $("j-pump"),
  };
  jewels.aux.classList.add("green");
  jewels.blower.classList.add("green");
  jewels.ready.classList.add("amber");
  jewels.pump.classList.add("green");

  var schJewels = {
    osc: $("sj-osc"),
    pa: $("sj-pa"),
    tank: $("sj-tank"),
    coupler: $("sj-coupler"),
    feeder: $("sj-feeder"),
    aerial: $("sj-aerial"),
  };
  /* place the schematic jewels over their SVG nodes (viewBox stretched) */
  var spots = {
    osc: [18, 62],
    pa: [34, 28.5],
    tank: [54, 28.5],
    coupler: [72, 28.5],
    feeder: [84, 62],
    aerial: [97.5, 58],
  };
  Object.keys(spots).forEach(function (k) {
    schJewels[k].style.left = spots[k][0] + "%";
    schJewels[k].style.top = spots[k][1] + "%";
  });

  /* ---------------- meter faces (drawn in code) ---------------- */

  var meters = {};

  function buildMeter(svgEl, cfg) {
    var NS = "http://www.w3.org/2000/svg";
    var cx = cfg.w / 2;
    var cy = cfg.h - 14;
    var rad = Math.min(cfg.w / 2 - 12, cfg.h - 26);
    var el = function (tag, attrs, parent) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      (parent || svgEl).appendChild(e);
      return e;
    };
    var angOf = function (v) {
      var f = (v - cfg.min) / (cfg.max - cfg.min);
      return -62 + 124 * clamp(f, -0.02, 1.02);
    };
    var pol = function (aDeg, r) {
      var t = ((aDeg - 90) * Math.PI) / 180;
      return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    };

    /* bezel + ivory face */
    el("circle", {
      cx: cx,
      cy: cy,
      r: rad + 8,
      fill: "#101114",
      stroke: "#000",
      "stroke-width": 1.5,
    });
    el("circle", {
      cx: cx,
      cy: cy,
      r: rad + 4.5,
      fill: "none",
      stroke: "#7d683e",
      "stroke-width": 2,
    });
    el("circle", { cx: cx, cy: cy, r: rad, fill: "#ece5d0" });

    /* coloured sectors along the scale arc */
    var sector = function (from, to, colour) {
      var a1 = pol(angOf(from), rad - 5);
      var a2 = pol(angOf(to), rad - 5);
      var b1 = pol(angOf(from), rad - 13);
      var b2 = pol(angOf(to), rad - 13);
      el("path", {
        d:
          "M" +
          a1[0] +
          "," +
          a1[1] +
          " A" +
          (rad - 5) +
          "," +
          (rad - 5) +
          " 0 0 1 " +
          a2[0] +
          "," +
          a2[1] +
          " L" +
          b2[0] +
          "," +
          b2[1] +
          " A" +
          (rad - 13) +
          "," +
          (rad - 13) +
          " 0 0 0 " +
          b1[0] +
          "," +
          b1[1] +
          " Z",
        fill: colour,
        opacity: 0.85,
      });
    };
    (cfg.green || []).forEach(function (g) {
      sector(g[0], g[1], "#3e7a4d");
    });
    (cfg.red || []).forEach(function (g) {
      sector(g[0], g[1], "#b3261a");
    });

    /* ticks */
    for (var v = cfg.min; v <= cfg.max + 1e-9; v += cfg.minor) {
      var big = false;
      for (var mi = 0; mi < cfg.major.length; mi++) {
        if (Math.abs(cfg.major[mi] - v) < cfg.minor / 2) big = true;
      }
      var p1 = pol(angOf(v), rad - 3);
      var p2 = pol(angOf(v), rad - (big ? 14 : 8));
      el("line", {
        x1: p1[0],
        y1: p1[1],
        x2: p2[0],
        y2: p2[1],
        stroke: "#211d14",
        "stroke-width": big ? 2 : 1,
      });
    }

    /* figures */
    cfg.major.forEach(function (m) {
      var pt = pol(angOf(m), rad - 23);
      var t = el("text", {
        x: pt[0],
        y: pt[1] + 4,
        "text-anchor": "middle",
        "font-family": "DejaVu Serif, FreeSerif, Georgia, serif",
        "font-size": cfg.big ? 13 : 11.5,
        fill: "#211d14",
      });
      t.textContent = String(m);
    });

    /* italic unit legend */
    var sub = el("text", {
      x: cx,
      y: cy - rad * 0.4,
      "text-anchor": "middle",
      "font-family": "DejaVu Serif, FreeSerif, Georgia, serif",
      "font-style": "italic",
      "font-size": 9.5,
      fill: "#4a4436",
    });
    sub.textContent = cfg.sub || "";

    /* mirror strip */
    var mA = pol(-56, rad - 27);
    var mB = pol(56, rad - 27);
    el("path", {
      d:
        "M" +
        mA[0] +
        "," +
        mA[1] +
        " A" +
        (rad - 27) +
        "," +
        (rad - 27) +
        " 0 0 1 " +
        mB[0] +
        "," +
        mB[1],
      fill: "none",
      stroke: "#cfc6ab",
      "stroke-width": 3,
      opacity: 0.7,
    });

    /* needle + brass hub */
    var needle = el("g", {});
    el(
      "polygon",
      {
        points:
          cx -
          2.4 +
          "," +
          cy +
          " " +
          cx +
          "," +
          (cy - rad + 16) +
          " " +
          (cx + 2.4) +
          "," +
          cy,
        fill: "#17130b",
      },
      needle,
    );
    el(
      "circle",
      {
        cx: cx,
        cy: cy,
        r: 6.5,
        fill: "#c8a558",
        stroke: "#6d5626",
        "stroke-width": 1,
      },
      needle,
    );

    /* glass glare */
    /* glass glare */
    el("path", {
      d:
        "M" +
        (cx - rad * 0.8) +
        "," +
        (cy - 4) +
        " Q" +
        cx +
        "," +
        (cy - rad - 6) +
        " " +
        (cx + rad * 0.8) +
        "," +
        (cy - 4) +
        " L" +
        (cx + rad * 0.62) +
        "," +
        (cy - 4) +
        " Q" +
        cx +
        "," +
        (cy - rad * 0.82) +
        " " +
        (cx - rad * 0.62) +
        "," +
        (cy - 4) +
        " Z",
      fill: "#ffffff",
      opacity: 0.07,
    });

    meters[cfg.key] = {
      needle: needle,
      angOf: angOf,
      cx: cx,
      cy: cy,
      get: cfg.get,
    };
  }

  function buildAllMeters() {
    document.querySelectorAll("svg[data-meter]").forEach(function (svg) {
      var kind = svg.getAttribute("data-meter");
      if (kind === "filament")
        buildMeter(svg, {
          key: "filament",
          w: 200,
          h: 118,
          min: 0,
          max: 40,
          minor: 2,
          major: [0, 10, 20, 30, 40],
          green: [[31, 36]],
          sub: "VOLTS",
          get: function () {
            return S.filamentVolts;
          },
        });
      if (kind === "ht")
        buildMeter(svg, {
          key: "ht",
          w: 200,
          h: 118,
          min: 0,
          max: 14,
          minor: 1,
          major: [0, 2, 4, 6, 8, 10, 12, 14],
          green: [[10.4, 11.6]],
          sub: "KILOVOLTS",
          get: function () {
            return S.htKV;
          },
        });
      if (kind === "pa")
        buildMeter(svg, {
          key: "pa",
          w: 220,
          h: 132,
          min: 0,
          max: 6,
          minor: 0.25,
          major: [0, 1, 2, 3, 4, 5, 6],
          green: [[1.6, 3.0]],
          red: [[5, 6]],
          big: true,
          sub: "AMPERES D.C.",
          get: function () {
            return S.paAnodeAmps;
          },
        });
      if (kind === "aerial")
        buildMeter(svg, {
          key: "aerial",
          w: 220,
          h: 132,
          min: 0,
          max: 12,
          minor: 0.5,
          major: [0, 2, 4, 6, 8, 10, 12],
          green: [[7.5, 9.8]],
          red: [[11, 12]],
          big: true,
          sub: "AMPERES R.F.",
          get: function () {
            return S.aerialAmps;
          },
        });
      if (kind === "water")
        buildMeter(svg, {
          key: "water",
          w: 200,
          h: 118,
          min: 10,
          max: 90,
          minor: 4,
          major: [10, 30, 50, 70, 90],
          green: [[30, 55]],
          red: [[68, 90]],
          sub: "DEG C",
          get: function () {
            return S.waterTempC;
          },
        });
      if (kind === "reflected")
        buildMeter(svg, {
          key: "reflected",
          w: 200,
          h: 118,
          min: 0,
          max: 600,
          minor: 25,
          major: [0, 150, 300, 450, 600],
          red: [[300, 600]],
          sub: "WATTS",
          get: function () {
            return S.refPowerW;
          },
        });
    });
  }

  /* ---------------- vernier drum ---------------- */

  function buildVernier() {
    els.vernier.textContent = "";
    for (var v = 0; v <= 100; v += 2) {
      var b = document.createElement("b");
      b.textContent = String(v);
      els.vernier.appendChild(b);
    }
  }

  function positionVernier() {
    var wrap = els.vernier.parentElement;
    if (!wrap) return;
    var cw = wrap.clientWidth;
    var scaleW = els.vernier.children.length * 34;
    var px = (S.tuningPos / 2) * 34 + 17;
    var tx = clamp(cw / 2 - px, cw - scaleW, 0);
    els.vernier.style.transform = "translateX(" + tx + "px)";
    els.crank.setAttribute("aria-valuenow", String(Math.round(S.tuningPos)));
    els.crank.style.setProperty("--crank-rot", S.tuningPos * 14.4 + "deg");
  }

  /* ---------------- rendering ---------------- */

  function markPositions(rotary, idx) {
    rotary.setAttribute("data-pos", String(idx));
    rotary.setAttribute("aria-valuenow", String(idx));
    var list = rotary.parentElement.querySelector(".rot-positions");
    if (list) {
      Array.prototype.forEach.call(list.children, function (li, i) {
        li.classList.toggle("here", i === idx);
      });
    }
  }

  function render() {
    var k, m;
    for (k in meters) {
      m = meters[k];
      m.needle.setAttribute(
        "transform",
        "rotate(" + m.angOf(m.get()) + " " + m.cx + " " + m.cy + ")",
      );
    }

    ALARMS.forEach(function (name) {
      var w = annWins[name];
      if (!w) return;
      var a = S.ann[name];
      var active = !!(a && a.active);
      w.classList.toggle("alarm", active);
      w.classList.toggle("flash", active && !(lampsTest || (a && a.acked)));
    });

    jewels.aux.classList.toggle("lit", S.breaker);
    jewels.blower.classList.toggle(
      "lit",
      S.breaker && S.blower && S.waterFlowLpm > 4,
    );
    jewels.ready.classList.toggle("lit", S.filamentVolts >= 31.5);
    jewels.pump.classList.toggle("lit", S.waterFlowLpm >= 40);

    els.rectWindow.classList.toggle("on", S.htKV > 0.6);
    els.onair.classList.toggle("lit", S.onAir);
    els.tripflag.hidden = !S.tripped;

    schJewels.osc.classList.toggle("lit", S.filamentVolts >= 31.5);
    schJewels.pa.classList.toggle("lit", S.htKV > 0.8);
    schJewels.tank.classList.toggle("lit", S.htKV > 0.8);
    schJewels.coupler.classList.toggle(
      "lit",
      S.htKV > 0.8 && S.loadingNotch > 0,
    );
    schJewels.feeder.classList.toggle("lit", S.aerialAmps > 0.4);
    schJewels.aerial.classList.toggle("lit", S.onAir);

    els.sightglass.style.height =
      clamp((S.waterFlowLpm / 45) * 100, 0, 100) + "%";

    positionVernier();
    markPositions(els.aerial, S.aerialIndex);
    markPositions(els.band, S.bandIndex);

    var canHt =
      S.breaker &&
      S.waterFlowLpm >= 38 &&
      S.filamentVolts >= 31.5 &&
      !S.tripped &&
      !S.arcBackLatch &&
      !S.lockout;
    els.htstart.disabled = !(S.guardArmed && canHt);
    els.rectrestore.disabled = !(
      S.arcBackLatch &&
      S.htKV < 0.5 &&
      !S.htCommanded
    );
    els.tripreset.disabled = !(
      (S.tripped && !S.lockout) ||
      (S.lockout && S.waterTempC < 52)
    );
  }

  function syncControls() {
    els.breaker.setAttribute("aria-checked", String(S.breaker));
    els.breaker.classList.toggle("open", !S.breaker);
    els.blower.setAttribute("aria-checked", String(S.blower));
    els.filament.setAttribute("aria-checked", String(S.filamentSw));
    els.pump.setAttribute("aria-checked", String(S.standbyPump));
    els.htguardWrap.classList.toggle("armed", S.guardArmed);
    els.drive.style.setProperty(
      "--knob-rot",
      -135 + 270 * (S.driveSteps / 10) + "deg",
    );
    els.drive.setAttribute("aria-valuenow", String(S.driveSteps));
    els.loading.setAttribute("data-notch", String(S.loadingNotch));
    els.loading.setAttribute("aria-valuenow", String(S.loadingNotch));
    markPositions(els.aerial, S.aerialIndex);
    markPositions(els.band, S.bandIndex);
  }

  /* ---------------- sound (after first gesture only) ---------------- */

  var audio = null;

  function ensureAudio() {
    if (audio) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();

      var humGain = ctx.createGain();
      humGain.gain.value = 0;
      var humFilter = ctx.createBiquadFilter();
      humFilter.type.value = "lowpass";
      humFilter.frequency.value = 320;
      var hum = ctx.createOscillator();
      hum.type.value = "sawtooth";
      hum.frequency.value = 100;
      hum.connect(humFilter);
      humFilter.connect(humGain);
      humGain.connect(ctx.destination);
      hum.start();

      var buzGain = ctx.createGain();
      buzGain.gain.value = 0;
      var buz = ctx.createOscillator();
      buz.type.value = "square";
      buz.frequency.value = 640;
      buz.connect(buzGain);
      buzGain.connect(ctx.destination);
      buz.start();

      audio = { ctx: ctx, humGain: humGain, buzGain: buzGain, buzPhase: 0 };
    } catch (e) {
      audio = null;
    }
  }

  function clickSound(freq) {
    if (!audio) return;
    try {
      var ctx = audio.ctx;
      var now = ctx.currentTime;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.09, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      var o = ctx.createOscillator();
      o.type.value = "square";
      o.frequency.value = freq || 1400;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(now);
      o.stop(now + 0.06);
    } catch (e) {
      /* stay silent */
    }
  }

  function clackSound() {
    if (!audio) return;
    try {
      var ctx = audio.ctx;
      var now = ctx.currentTime;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.05, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      var o = ctx.createOscillator();
      o.type.value = "triangle";
      o.frequency.setValueAtTime(240, now);
      o.frequency.exponentialRampToValueAtTime(90, now + 0.25);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(now);
      o.stop(now + 0.32);
    } catch (e) {
      /* stay silent */
    }
  }

  function updateSound(dtReal) {
    if (!audio || audio.ctx.state !== "running") return;
    var humTarget = (S.breaker ? 0.008 : 0) + (S.htKV / HT_RUNNING_KV) * 0.05;
    audio.humGain.gain.value +=
      (humTarget - audio.humGain.gain.value) * clamp(dtReal * 4, 0, 1);
    var unacked = activeAlarms().some(function (n) {
      var a = S.ann[n];
      return a && !a.acked;
    });
    if (unacked) {
      audio.buzPhase += dtReal;
      audio.buzGain.gain.value = audio.buzPhase % 0.9 < 0.45 ? 0.03 : 0;
    } else {
      audio.buzGain.gain.value = 0;
      audio.buzPhase = 0;
    }
  }

  /* ---------------- interactions ---------------- */

  function toggleSwitch(el, prop) {
    el.addEventListener("click", function () {
      S[prop] = !S[prop];
      if (prop === "breaker" && !S.breaker) {
        S.htCommanded = false;
        S.guardArmed = false;
        els.htguardWrap.classList.remove("armed");
      }
      el.setAttribute("aria-checked", String(S[prop]));
      clickSound(prop === "breaker" ? 900 : 1500);
      render();
    });
  }
  toggleSwitch(els.breaker, "breaker");
  toggleSwitch(els.blower, "blower");
  toggleSwitch(els.filament, "filamentSw");
  toggleSwitch(els.pump, "standbyPump");

  /* guarded HT start */
  els.htguard.addEventListener("click", function () {
    S.guardArmed = !S.guardArmed;
    els.htguardWrap.classList.toggle("armed", S.guardArmed);
    clickSound(700);
    render();
  });
  els.htstart.addEventListener("click", function () {
    var canHt =
      S.breaker &&
      S.waterFlowLpm >= 38 &&
      S.filamentVolts >= 31.5 &&
      !S.tripped &&
      !S.arcBackLatch &&
      !S.lockout;
    if (!canHt) {
      clackSound();
      return;
    }
    S.htCommanded = true;
    clickSound(500);
    setTimeout(clackSound, 320);
    render();
  });

  els.tripreset.addEventListener("click", function () {
    if ((S.tripped && !S.lockout) || (S.lockout && S.waterTempC < 52)) {
      S.tripped = false;
      S.tripReason = "";
      S.lockout = false;
      S.overloadTimer = 0;
      clackSound();
    }
    render();
  });

  els.rectrestore.addEventListener("click", function () {
    if (S.arcBackLatch && S.htKV < 0.5 && !S.htCommanded) {
      S.arcBackLatch = false;
      clickSound(400);
      setTimeout(function () {
        clickSound(620);
      }, 160);
    }
    render();
  });

  /* drag helper shared by crank, lever and knob */
  function dragger(el, onChange, onEnd) {
    var active = false;
    var lastX = 0;
    var lastY = 0;
    el.addEventListener("pointerdown", function (ev) {
      active = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (e) {
        /* fine */
      }
      ev.preventDefault();
    });
    el.addEventListener("pointermove", function (ev) {
      if (!active) return;
      onChange(ev.clientX - lastX, ev.clientY - lastY);
      lastX = ev.clientX;
      lastY = ev.clientY;
    });
    ["pointerup", "pointercancel"].forEach(function (t) {
      el.addEventListener(t, function (ev) {
        if (!active) return;
        active = false;
        if (onEnd) onEnd(ev.clientX - lastX, ev.clientY - lastY);
      });
    });
  }

  /* tank tuning crank */
  dragger(els.crank, function (dx) {
    S.tuningPos = clamp(S.tuningPos + dx * 0.09, 0, 100);
    positionVernier();
  });
  els.crank.addEventListener(
    "wheel",
    function (ev) {
      ev.preventDefault();
      S.tuningPos = clamp(S.tuningPos - Math.sign(ev.deltaY) * 0.6, 0, 100);
      positionVernier();
    },
    { passive: false },
  );
  els.crank.addEventListener("keydown", function (ev) {
    var st = ev.shiftKey ? 4 : 0.6;
    if (ev.key === "ArrowLeft" || ev.key === "ArrowDown")
      S.tuningPos = clamp(S.tuningPos - st, 0, 100);
    else if (ev.key === "ArrowRight" || ev.key === "ArrowUp")
      S.tuningPos = clamp(S.tuningPos + st, 0, 100);
    else if (ev.key === "Home") S.tuningPos = 0;
    else if (ev.key === "End") S.tuningPos = 100;
    else return;
    ev.preventDefault();
    positionVernier();
  });

  /* antenna loading lever: click above the pivot backs off, below drives in */
  function setLoading(n) {
    S.loadingNotch = clamp(n, 0, 4);
    els.loading.setAttribute("data-notch", String(S.loadingNotch));
    els.loading.setAttribute("aria-valuenow", String(S.loadingNotch));
    clickSound(1700);
  }
  var leverDragged = false;
  dragger(
    els.loading,
    function (dx, dy) {
      if (dy < -6 || dx > 6) {
        setLoading(S.loadingNotch + 1);
        leverDragged = true;
      } else if (dy > 6 || dx < -6) {
        setLoading(S.loadingNotch - 1);
        leverDragged = true;
      }
    },
    function () {
      setTimeout(function () {
        leverDragged = false;
      }, 60);
    },
  );
  els.loading.addEventListener("click", function (ev) {
    if (leverDragged) return;
    var r = els.loading.getBoundingClientRect();
    var above = ev.clientY - r.top < r.height * 0.55;
    setLoading(S.loadingNotch + (above ? -1 : 1));
  });
  els.loading.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowUp" || ev.key === "ArrowRight") {
      ev.preventDefault();
      setLoading(S.loadingNotch + 1);
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      setLoading(S.loadingNotch - 1);
    }
  });

  /* drive knob */
  function paintDrive() {
    els.drive.style.setProperty(
      "--knob-rot",
      -135 + 270 * (S.driveSteps / 10) + "deg",
    );
    els.drive.setAttribute("aria-valuenow", String(S.driveSteps));
  }
  dragger(els.drive, function (dx, dy) {
    S.driveSteps = clamp(S.driveSteps + (-dy - dx) * 0.07, 0, 10);
    S.driveSteps = Math.round(S.driveSteps * 2) / 2;
    paintDrive();
  });
  els.drive.addEventListener("keydown", function (ev) {
    var st = ev.shiftKey ? 2 : 0.5;
    if (ev.key === "ArrowUp" || ev.key === "ArrowRight") {
      ev.preventDefault();
      S.driveSteps = clamp(S.driveSteps + st, 0, 10);
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      S.driveSteps = clamp(S.driveSteps - st, 0, 10);
    } else return;
    paintDrive();
  });

  /* rotary selectors */
  function cycleRotary(el, prop, max, after) {
    var apply = function () {
      markPositions(el, S[prop]);
      clickSound(1300);
      if (after) after();
    };
    el.addEventListener("click", function () {
      S[prop] = (S[prop] + 1) % (max + 1);
      apply();
    });
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
        ev.preventDefault();
        S[prop] = Math.min(max, S[prop] + 1);
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
        ev.preventDefault();
        S[prop] = Math.max(0, S[prop] - 1);
      } else return;
      apply();
    });
  }
  /* taking the faulted feeders out of circuit clears the feeder fault */
  cycleRotary(els.aerial, "aerialIndex", 3, function () {
    if (S.aerialIndex !== 1 && S.aerialIndex !== 2) feederFaultActive = false;
  });
  cycleRotary(els.band, "bandIndex", 3);

  /* annunciator buttons */
  els.accept.addEventListener("click", function () {
    ALARMS.forEach(function (n) {
      var a = S.ann[n];
      if (a) a.acked = true;
    });
    clickSound(1900);
    render();
  });

  var lampsTest = false;
  function setLamps(on) {
    lampsTest = on;
    render();
  }
  els.lamps.addEventListener("pointerdown", function () {
    setLamps(true);
  });
  ["pointerup", "pointerleave"].forEach(function (t) {
    els.lamps.addEventListener(t, function () {
      setLamps(false);
    });
  });
  els.lamps.addEventListener("keydown", function (ev) {
    if (ev.key === " " || ev.key === "Enter") setLamps(true);
  });
  els.lamps.addEventListener("keyup", function (ev) {
    if (ev.key === " " || ev.key === "Enter") setLamps(false);
  });

  els.resetBtn.addEventListener("click", function () {
    window.machine.reset();
    clackSound();
  });

  /* maintenance fault-test tray */
  Array.prototype.forEach.call(
    document.querySelectorAll("[data-inject]"),
    function (btn) {
      btn.addEventListener("click", function () {
        window.machine.inject(btn.getAttribute("data-inject"));
        btn.classList.add("fired");
        setTimeout(function () {
          btn.classList.remove("fired");
        }, 900);
        clackSound();
        render();
      });
    },
  );

  /* manual dialog */
  var dialog = document.querySelector("dialog[data-manual]");
  document
    .querySelector('[data-action="manual"]')
    .addEventListener("click", function () {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });
  document
    .querySelector('[data-action="close-manual"]')
    .addEventListener("click", function () {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    });

  /* unlock audio on the first gesture anywhere */
  ["pointerdown", "keydown"].forEach(function (t) {
    document.addEventListener(
      t,
      function first() {
        ensureAudio();
        if (audio && audio.ctx.state === "suspended") audio.ctx.resume();
        document.removeEventListener(t, first, { capture: true });
      },
      { capture: true },
    );
  });

  /* ---------------- animation loop ---------------- */

  var last = null;
  var raf = null;
  var running = true;

  function frame(now) {
    if (last === null) last = now;
    var dt = (now - last) / 1000;
    last = now;
    if (dt > 0) {
      window.machine.tick(Math.min(dt, 2));
      render();
      updateSound(dt);
    }
    raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!running) {
      running = true;
      last = null;
      raf = requestAnimationFrame(frame);
    }
  });

  window.addEventListener("resize", function () {
    positionVernier();
  });

  /* ---------------- boot ---------------- */

  S = coldState();
  buildAllMeters();
  buildVernier();
  syncControls();
  render();
  raf = requestAnimationFrame(frame);
})();
