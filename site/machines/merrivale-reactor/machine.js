/* ==========================================================================
   Merrivale BEP-3 Reactor — Operating Console · machine.js
   Point-kinetics toy model: rod worth -> reactivity (pcm) -> one-group
   period -> thermal power -> fuel temperature with negative moderator
   feedback -> D2O blower flow. Trips, SCRAM, decay heat, alarms.
   England, 1958. Vanilla script, no modules, no network.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------ constants */

  var RATED_MW = 5; // 5 MW(th)
  var BETA_ABS = 0.0065; // delayed neutron fraction (650 pcm)
  var LAMBDA = 0.1; // effective one-group precursor decay, 1/s
  var SOURCE_MW = 5e-4; // photoneutron + spontaneous source floor
  var TEMP_COEF = -1.35; // pcm per K of fuel temperature above reference
  var T_REF = 40; // reference temperature for the coeficient
  var T_COOL = 25; // incoming D2O temperature, C
  var K_COOL = 1.2; // cooling coefficient at full flow, kW/K normalised
  var C_FUEL = 30; // fuel thermal capacity -> 25 s time constant
  var HEAT_GAIN = 67; // equilibrium K rise per MW at full flow

  var RODS = {
    safety: { worth: 130 },
    shima: { worth: 120, rate: 1.8 },
    shimb: { worth: 120, rate: 1.8 },
    reg: { worth: 50, rate: 0.6 },
  };

  var ALARM_ORDER = [
    "REACTOR SCRAM",
    "SHORT PERIOD",
    "HIGH FLUX",
    "HIGH FUEL TEMPERATURE",
    "LOW COOLANT FLOW",
    "ROD DRIVE FAULT",
    "FLUX MONITOR FAULT",
    "BLOWER BREAKER TRIPPED",
  ];

  var FAULTS = [
    "shim rod drive failure",
    "coolant blower trip",
    "ion chamber drift",
  ];

  /* ---------------------------------------------------------------- state */

  var S;
  var carry = 0;
  var H = 0.05; // physics sub-step, seconds

  function freshState() {
    return {
      t: 0,
      supply: false,
      mode: 0, // 0 OFF, 1 MANUAL, 2 AUTO
      blowerSel: 0, // 0 OFF, 1 LOW, 2 HIGH
      rodDrive: false,
      demand: 50, // percent full power

      pos: { safety: 0, shima: 0, shimb: 0, reg: 0 },

      n: SOURCE_MW, // thermal power from fission, MW
      measT: 99999, // displayed reactor period, s
      tf: T_COOL, // fuel temperature, C
      tout: T_COOL, // coolant outlet, C
      flow: 0, // D2O flow, percent

      dh: 0, // decay heat, MW
      scrammed: false,
      tScram: -1,

      faults: { shim: false, blower: false, chamber: false },
      driftAge: 0,
      lowFlowSeconds: 0,
      calibrating: 0,

      active: {}, // alarm name -> true
      unacked: {}, // alarm name -> true (flashing until accept)

      chart: [], // recorder samples {t, lp}
      lastSample: -1,
    };
  }

  /* ----------------------------------------------------------- simulation */

  function netReactivity() {
    var pcm = 0,
      k;
    for (k in RODS) {
      pcm += (RODS[k].worth * S.pos[k]) / 100;
    }
    pcm += TEMP_COEF * (S.tf - T_REF);
    return pcm; // milli-k units (pcm)
  }

  function periodFromRho(pcm) {
    var abs = pcm * 1e-5;
    if (Math.abs(abs) < 1e-7) {
      return 99999;
    } // effectively critical
    var t = (BETA_ABS - abs) / (LAMBDA * abs);
    if (!isFinite(t)) {
      return 99999;
    }
    if (t > 0 && t < 0.5) {
      t = 0.5;
    } // prompt region, clamped
    return Math.max(-99999, Math.min(99999, t));
  }

  function raiseAlarm(name) {
    if (!S.active[name]) {
      S.active[name] = true;
      S.unacked[name] = true;
    }
  }

  function scram() {
    if (!S.scrammed) {
      S.scrammed = true;
      S.tScram = S.t;
      S.dh = Math.max(S.dh, 0.068 * S.n);
    }
  }

  function step(h) {
    var prevN = S.n;

    /* --- operator demands -------------------------------------------- */
    var mayDrive = S.supply && S.rodDrive && !S.scrammed && S.mode === 1;

    // safety rod rides on the magnet whenever supplies are healthy
    var safTarget = S.supply && S.rodDrive && !S.scrammed ? 100 : 0;
    moveRod(
      "safety",
      safTarget > S.pos.safety ? 1 : -1,
      safTarget > S.pos.safety ? 3 : 20,
      h,
    );

    if (mayDrive) {
      if (ui.rocker.shima !== 0) {
        moveRod("shima", ui.rocker.shima, RODS.shima.rate, h);
      }
      if (ui.rocker.shimb !== 0) {
        moveRod("shimb", ui.rocker.shimb, RODS.shimb.rate, h);
      }
      if (ui.rocker.reg !== 0) {
        moveRod("reg", ui.rocker.reg, RODS.reg.rate, h);
      }
    }

    // a scram de-energises the drive clamps: every driven rod falls home
    if (S.scrammed) {
      moveRod("shima", -1, 22, h);
      moveRod("shimb", -1, 22, h);
      moveRod("reg", -1, 26, h);
    }

    // AUTO: regulating rod trims towards the demand point
    if (S.supply && S.rodDrive && !S.scrammed && S.mode === 2) {
      var demMW = (S.demand * RATED_MW) / 100;
      var err = (demMW - S.n) / Math.max(demMW, 0.25);
      if (Math.abs(err) > 0.015) {
        moveRod(
          "reg",
          err > 0 ? 1 : -1,
          Math.min(RODS.reg.rate, Math.abs(err) * 2.2),
          h,
        );
      }
    }

    /* --- blowers ------------------------------------------------------ */
    var flowTarget = [0, 62, 100][S.blowerSel];
    if (S.faults.blower || !S.supply) {
      flowTarget = 0;
    }
    S.flow += (flowTarget - S.flow) * Math.min(1, h / 6);
    if (S.flow < 0.05) {
      S.flow = 0;
    }

    /* --- kinetics ----------------------------------------------------- */
    var pcm = netReactivity();
    var period = periodFromRho(pcm);
    var growth = Math.exp(h / period);
    S.n = S.n * growth;
    if (S.n < SOURCE_MW) {
      S.n = SOURCE_MW;
    }
    if (S.n > 25) {
      S.n = 25;
    }

    // decay-heat tail follows the highest recent power
    S.dh *= Math.exp(-h / 95);
    if (0.068 * S.n > S.dh) {
      S.dh = 0.068 * S.n;
    }

    /* --- thermal ------------------------------------------------------ */
    var kEff = K_COOL * (0.25 + (0.75 * S.flow) / 100);
    var dTf = ((S.n + S.dh) * HEAT_GAIN - kEff * (S.tf - T_COOL)) / C_FUEL;
    S.tf += dTf * h;
    if (S.tf < T_COOL) {
      S.tf = T_COOL;
    }
    S.tout = T_COOL + (S.tf - T_COOL) * 0.34 * (0.3 + (0.7 * S.flow) / 100);

    /* --- period measurement ------------------------------------------- */
    if (prevN > 0 && S.n > 0) {
      var ratio = S.n / prevN;
      if (ratio > 0 && ratio !== 1) {
        var inst = h / Math.log(ratio);
        if (!isFinite(inst)) {
          inst = 99999;
        }
        inst = Math.max(-99999, Math.min(99999, inst));
        S.measT += (inst - S.measT) * Math.min(1, h / 1.1);
      }
    }
    if (Math.abs(S.measT) > 99999) {
      S.measT = 99999;
    }

    /* --- ion chamber health ------------------------------------------- */
    if (S.faults.chamber) {
      S.driftAge += h;
    }

    /* --- alarms ------------------------------------------------------- */
    var next = {};
    var dispT = displayedPeriod();
    if (S.scrammed) {
      next["REACTOR SCRAM"] = true;
    }
    if (dispT > 0 && dispT < 15 && S.n > 0.002 && !S.scrammed) {
      next["SHORT PERIOD"] = true;
    }
    if (S.n > RATED_MW) {
      next["HIGH FLUX"] = true;
    }
    if (S.tf > 380) {
      next["HIGH FUEL TEMPERATURE"] = true;
    }
    if (S.flow < 45 && (S.blowerSel > 0 || S.n > 0.5) && S.supply) {
      next["LOW COOLANT FLOW"] = true;
    }
    if (S.faults.shim) {
      next["ROD DRIVE FAULT"] = true;
    }
    if (S.faults.chamber && S.driftAge * 0.02 > 0.22) {
      next["FLUX MONITOR FAULT"] = true;
    }
    if (S.faults.blower) {
      next["BLOWER BREAKER TRIPPED"] = true;
    }

    var k2;
    for (k2 in next) {
      if (!S.active[k2]) {
        S.unacked[k2] = true;
      }
    }
    S.active = next;
    for (k2 in S.unacked) {
      if (!S.active[k2]) {
        delete S.unacked[k2];
      }
    }

    /* --- trips -------------------------------------------------------- */
    if (S.supply && !S.scrammed) {
      if (S.n > RATED_MW * 1.18) {
        trip();
      } else if (dispT > 0 && dispT < 8 && S.n > 0.002) {
        trip();
      } else if (S.tf > 420) {
        trip();
      } else if (S.flow < 45 && S.n > 1) {
        S.lowFlowSeconds += h;
        if (S.lowFlowSeconds > 8) {
          trip();
        }
      } else {
        S.lowFlowSeconds = 0;
      }
    }

    S.t += h;
  }

  function moveRod(rod, dir, rate, h) {
    if (rod === "shima" && S.faults.shim) {
      return;
    }
    var p = S.pos[rod] + dir * rate * h;
    S.pos[rod] = Math.max(0, Math.min(100, p));
  }

  function displayedPeriod() {
    var t = S.measT;
    if (S.faults.chamber) {
      var noise = Math.sin(S.t * 2.7) * S.driftAge * 1.6;
      t = t + noise;
    }
    return Math.max(-99999, Math.min(99999, t));
  }

  function displayedFlux() {
    var mw = S.n;
    if (S.faults.chamber) {
      mw *= 1 + Math.min(0.55, S.driftAge * 0.02);
    }
    return mw;
  }

  function trip() {
    scram();
    raiseAlarm("REACTOR SCRAM");
    S.lowFlowSeconds = 0;
  }

  function tick(seconds) {
    var total = seconds + carry;
    var steps = Math.floor(total / H);
    carry = total - steps * H;
    if (steps > 4800) {
      steps = 4800;
      carry = 0;
    }
    for (var i = 0; i < steps; i++) {
      step(H);
    }
    sampleChart();
  }

  function sampleChart() {
    if (S.t - S.lastSample >= 0.5 || S.lastSample < 0) {
      S.lastSample = S.t;
      var pct = Math.max(1e-3, (displayedFlux() / RATED_MW) * 100);
      S.chart.push({ t: S.t, lp: Math.log10(Math.min(pct, 199)) });
      if (S.chart.length > 170) {
        S.chart.shift();
      }
    }
  }

  /* ------------------------------------------------------------- public API */

  var machine = {
    name: "Merrivale BEP-3 Reactor",
    faults: FAULTS.slice(),

    state: function () {
      var list = [],
        k;
      for (k in S.active) {
        list.push(k);
      }
      return {
        time: S.t,
        supply: S.supply,
        mode: ["OFF", "MANUAL", "AUTO"][S.mode],
        blower: ["OFF", "LOW", "HIGH"][S.blowerSel],
        rodDrive: S.rodDrive,
        demandPercent: S.demand,
        rods: {
          safety: S.pos.safety,
          shimA: S.pos.shima,
          shimB: S.pos.shimb,
          regulating: S.pos.reg,
        },
        reactivityPcm: netReactivity(),
        periodSeconds: S.measT,
        powerMW: S.n,
        decayHeatMW: S.dh,
        fuelTempC: S.tf,
        coolantOutC: S.tout,
        flowPercent: S.flow,
        scrammed: S.scrammed,
        alarms: list,
      };
    },

    tick: tick,

    inject: function (fault) {
      var f = String(fault || "").toLowerCase();
      if (f === "shim rod drive failure") {
        S.faults.shim = true;
      } else if (f === "coolant blower trip") {
        S.faults.blower = true;
      } else if (f === "ion chamber drift") {
        if (!S.faults.chamber) {
          S.faults.chamber = true;
          S.driftAge = 0;
        }
      }
    },

    reset: function () {
      S = freshState();
      ui.rocker = { shima: 0, shimb: 0, reg: 0 };
    },
  };

  window.machine = machine;
  S = freshState();

  /* --------------------------------------------------------------- helpers */

  function $(id) {
    return document.getElementById(id);
  }
  function el(sel) {
    return document.querySelector(sel);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  var ui = {
    rocker: { shima: 0, shimb: 0, reg: 0 },
    lampsTest: false,
    sound: false,
    actx: null,
    clickDebt: 0,
  };

  /* --------------------------------------------------------- meter drawing */

  function polar(cx, cy, r, ang) {
    var a = ((ang - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function elNS(name, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var k in attrs) {
      e.setAttribute(k, attrs[k]);
    }
    return e;
  }
  function faceBase(svg, cx, cy, r) {
    svg.appendChild(
      elNS("rect", {
        x: 2,
        y: 2,
        width: 196,
        height: 124,
        rx: 7,
        fill: "#f2eee2",
        stroke: "#23261c",
        "stroke-width": 1,
      }),
    );
  }
  function tickMark(svg, cx, cy, rIn, rOut, ang, w, col) {
    var p1 = polar(cx, cy, rIn, ang),
      p2 = polar(cx, cy, rOut, ang);
    svg.appendChild(
      elNS("line", {
        x1: p1[0],
        y1: p1[1],
        x2: p2[0],
        y2: p2[1],
        stroke: col || "#23261c",
        "stroke-width": w || 1.6,
      }),
    );
  }
  function label(svg, x, y, txt, size, anchor, col, weight) {
    var t = elNS("text", {
      x: x,
      y: y,
      "font-size": size,
      "text-anchor": anchor || "middle",
      fill: col || "#23261c",
      "font-family": "Arial, sans-serif",
      "font-weight": weight || "bold",
    });
    t.textContent = txt;
    svg.appendChild(t);
  }

  function buildLogMeter(svg) {
    var cx = 100,
      cy = 116,
      r = 92;
    faceBase(svg);
    var i, ang;
    var decades = [
      { v: 0.001, lbl: "10\u207B\u00B3" },
      { v: 0.01, lbl: "10\u207B\u00B2" },
      { v: 0.1, lbl: "10\u207B\u00B9" },
      { v: 1, lbl: "1" },
      { v: 10, lbl: "10" },
      { v: 100, lbl: "100" },
    ];
    for (i = 0; i < decades.length; i++) {
      ang = logAngle(decades[i].v);
      tickMark(svg, cx, cy, r - 12, r - 1, ang, 2.2);
      label(
        svg,
        polar(cx, cy, r - 23, ang)[0],
        polar(cx, cy, r - 23, ang)[1] + 3,
        decades[i].lbl,
        8.5,
      );
    }
    for (var m = 2; m <= 9; m++) {
      [0.001, 0.01, 0.1, 1, 10].forEach(function (base) {
        tickMark(svg, cx, cy, r - 7, r - 1, logAngle(base * m), 1);
      });
    }
    // red overload zone 118 .. 150 %
    var a1 = logAngle(118),
      a2 = logAngle(160);
    var pA = polar(cx, cy, r - 4, a1),
      pB = polar(cx, cy, r - 4, a2);
    svg.appendChild(
      elNS("path", {
        d:
          "M " +
          pA[0] +
          " " +
          pA[1] +
          " A " +
          (r - 4) +
          " " +
          (r - 4) +
          " 0 0 1 " +
          pB[0] +
          " " +
          pB[1],
        stroke: "#c8271b",
        "stroke-width": 5,
        fill: "none",
      }),
    );
    label(svg, cx, 26, "\uFF05 FULL POWER", 8, "middle", "#5a5f52");
    label(
      svg,
      26,
      116,
      "MERRIVALE INST. WKS.",
      5.5,
      "start",
      "#8a8570",
      "normal",
    );

    var g = elNS("g", {});
    var needle = elNS("line", {
      x1: cx,
      y1: cy,
      x2: cx,
      y2: cy - (r - 14),
      stroke: "#171a14",
      "stroke-width": 2.4,
    });
    g.appendChild(needle);
    svg.appendChild(g);
    svg.appendChild(
      elNS("circle", {
        cx: cx,
        cy: cy,
        r: 6,
        fill: "#3a3e35",
        stroke: "#14170f",
      }),
    );
    svg.appendChild(
      elNS("circle", { cx: cx, cy: cy, r: 2.2, fill: "#c9cdc2" }),
    );
    svg._needle = needle;
    svg._cx = cx;
    svg._cy = cy;
  }

  function logAngle(pct) {
    var x = Math.log10(clamp(pct, 1e-3, 160));
    return -52 + ((x + 3) / (Math.log10(160) + 3)) * 104;
  }

  function buildPeriodMeter(svg) {
    var cx = 100,
      cy = 116,
      r = 92;
    faceBase(svg);
    var marks = [
      { t: 100, lbl: "100" },
      { t: 30, lbl: "30" },
      { t: 10, lbl: "10" },
    ];
    var i, a;
    label(svg, cx, cy - r + 16, "\u221E", 13, "middle", "#23261c");
    for (i = 0; i < marks.length; i++) {
      [1, -1].forEach(function (sgn) {
        a = sgn * periodAngle(marks[i].t);
        tickMark(svg, cx, cy, r - 12, r - 1, a, 2.2);
        label(
          svg,
          polar(cx, cy, r - 23, a)[0],
          polar(cx, cy, r - 23, a)[1] + 3,
          marks[i].lbl,
          8.5,
        );
      });
    }
    [1, -1].forEach(function (sgn) {
      [20, 50].forEach(function (tt) {
        tickMark(svg, cx, cy, r - 7, r - 1, sgn * periodAngle(tt), 1);
      });
      // red trip band: period under 8 s
      var aOut = sgn * 47.5,
        aIn = sgn * periodAngle(8);
      var pA = polar(cx, cy, r - 4, aIn),
        pB = polar(cx, cy, r - 4, aOut);
      svg.appendChild(
        elNS("path", {
          d:
            "M " +
            pA[0] +
            " " +
            pA[1] +
            " A " +
            (r - 4) +
            " " +
            (r - 4) +
            " 0 0 " +
            (sgn > 0 ? 1 : 0) +
            " " +
            pB[0] +
            " " +
            pB[1],
          stroke: "#c8271b",
          "stroke-width": 5,
          fill: "none",
        }),
      );
    });
    label(svg, cx - r + 26, 30, "FALL", 7, "middle", "#5a5f52");
    label(svg, cx + r - 26, 30, "RISE", 7, "middle", "#5a5f52");
    label(svg, cx, cy - 34, "SECONDS", 7, "middle", "#5a5f52");

    var needle = elNS("line", {
      x1: cx,
      y1: cy,
      x2: cx,
      y2: cy - (r - 14),
      stroke: "#171a14",
      "stroke-width": 2.4,
    });
    svg.appendChild(needle);
    svg.appendChild(
      elNS("circle", {
        cx: cx,
        cy: cy,
        r: 6,
        fill: "#3a3e35",
        stroke: "#14170f",
      }),
    );
    svg.appendChild(
      elNS("circle", { cx: cx, cy: cy, r: 2.2, fill: "#c9cdc2" }),
    );
    svg._needle = needle;
    svg._cx = cx;
    svg._cy = cy;
  }

  function periodAngle(T) {
    var x = Math.log10(clamp(Math.abs(T), 5, 250));
    return ((2.4 - x) / (2.4 - Math.log10(5))) * 47;
  }

  /* -------------------------------------------------------------- recorder */

  var rc, rctx;
  function initRecorder() {
    rc = $("recorder");
    rctx = rc.getContext("2d");
  }

  function drawRecorder() {
    if (!rctx) {
      return;
    }
    var w = rc.width,
      hgt = rc.height;
    rctx.fillStyle = "#f4efdd";
    rctx.fillRect(0, 0, w, hgt);
    // grid
    rctx.strokeStyle = "rgba(90,84,60,.25)";
    rctx.lineWidth = 1;
    var i, x, y;
    for (i = 1; i < 8; i++) {
      x = (i * w) / 8;
      line(x, 0, x, hgt);
    }
    for (i = 1; i < 6; i++) {
      y = (i * hgt) / 6;
      line(0, y, w, y);
    }
    rctx.strokeStyle = "rgba(90,84,60,.5)";
    [0.125, 0.375, 0.625, 0.875].forEach(function (f, idx) {
      var yy = hgt * f;
      line(0, yy, w, yy);
      rctx.fillStyle = "rgba(90,84,60,.8)";
      rctx.font = "bold 9px Courier New";
      rctx.fillText(["100", "10", "1", "0.1"][idx] + "%", 4, yy - 3);
    });
    // trace
    var ch = S.chart;
    if (ch.length > 1) {
      rctx.strokeStyle = "#c8271b";
      rctx.lineWidth = 1.8;
      rctx.beginPath();
      var t0 = ch[0].t,
        t1 = ch[ch.length - 1].t,
        span = Math.max(60, t1 - t0);
      for (i = 0; i < ch.length; i++) {
        x = ((ch[i].t - t0) / span) * w;
        y = (1 - (ch[i].lp + 3) / 4.9) * hgt;
        if (i === 0) {
          rctx.moveTo(x, y);
        } else {
          rctx.lineTo(x, y);
        }
      }
      rctx.stroke();
      // pen head
      rctx.fillStyle = "#8d1810";
      rctx.beginPath();
      rctx.arc(x, y, 3, 0, 6.283);
      rctx.fill();
    }
    function line(a, b, c, d) {
      rctx.beginPath();
      rctx.moveTo(a, b);
      rctx.lineTo(c, d);
      rctx.stroke();
    }
  }

  /* ------------------------------------------------------------------ sound */

  function ensureAudio() {
    if (!ui.actx) {
      try {
        ui.actx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        ui.sound = false;
      }
    }
    if (ui.actx && ui.actx.state === "suspended") {
      ui.actx.resume();
    }
  }

  function geiger(dtReal) {
    if (!ui.sound || !ui.actx) {
      return;
    }
    var frac = clamp(S.n / RATED_MW, 0, 1.4);
    var rate = 3 + 520 * Math.sqrt(frac);
    ui.clickDebt += rate * dtReal;
    var n = Math.floor(ui.clickDebt);
    ui.clickDebt -= n;
    if (n > 12) {
      n = 12;
    }
    for (var i = 0; i < n; i++) {
      click();
    }
  }

  function click() {
    var t = ui.actx.currentTime;
    var o = ui.actx.createOscillator();
    var g = ui.actx.createGain();
    o.type = "square";
    o.frequency.value = 2300 + Math.random() * 900;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    o.connect(g);
    g.connect(ui.actx.destination);
    o.start(t);
    o.stop(t + 0.014);
  }

  /* ------------------------------------------------------------ UI plumbing */

  var keySwitch,
    modeSelector,
    blowerSelector,
    rodDriveBtn,
    countRateBtn,
    detCalBtn,
    testsPlate,
    scramBar,
    tripResetBtn,
    acceptBtn,
    lampsBtn,
    driveBkrBtn,
    blowerRstBtn,
    demandKnob,
    dlg,
    anns = {},
    jewels = {},
    drumScales = {},
    posOuts = {};

  function cacheDom() {
    keySwitch = $("key-switch");
    modeSelector = $("mode-selector");
    blowerSelector = $("blower-selector");
    rodDriveBtn = $("rod-drive-supply");
    countRateBtn = $("count-rate-set");
    detCalBtn = $("detector-calibrate");
    testsPlate = $("maintenance-tests");
    scramBar = $("scram-bar");
    tripResetBtn = $("trip-reset");
    acceptBtn = $("alarm-accept");
    lampsBtn = $("lamps-test");
    driveBkrBtn = $("drive-breaker-reset");
    blowerRstBtn = $("blower-reset");
    demandKnob = $("power-demand");
    dlg = el("dialog[data-manual]");
    Array.prototype.forEach.call(
      document.querySelectorAll(".ann"),
      function (a) {
        anns[a.getAttribute("data-ann")] = a;
      },
    );
    jewels.supply = $("jewel-supply");
    jewels.critical = $("jewel-critical");
    drumScales.safety = $("scale-safety");
    drumScales.shima = $("scale-shima");
    drumScales.shimb = $("scale-shimb");
    drumScales.reg = $("scale-reg");
    posOuts.safety = $("pos-safety");
    posOuts.shima = $("pos-shima");
    posOuts.shimb = $("pos-shimb");
    posOuts.reg = $("pos-reg");
  }

  function buildDrum(scale) {
    var frag = document.createDocumentFragment();
    for (var v = -60; v <= 160; v += 10) {
      var cell = document.createElement("i");
      if (v >= 0 && v <= 100) {
        cell.textContent = String(v);
      }
      frag.appendChild(cell);
    }
    scale.appendChild(frag);
  }

  /* hold-to-run rocker plumbing */
  function wireRockers() {
    var rods = ["shima", "shimb", "reg"];
    rods.forEach(function (rod) {
      var group = document.querySelector(
        '[data-control="' + rodLabel(rod) + '"]',
      );
      if (!group) {
        return;
      }
      Array.prototype.forEach.call(
        group.querySelectorAll(".rk"),
        function (btn) {
          var dir = btn.getAttribute("data-roddir") === "out" ? 1 : -1;
          var press = function (ev) {
            ev.preventDefault();
            ui.rocker[rod] = dir;
            btn.classList.add("held");
          };
          var release = function () {
            if (ui.rocker[rod] === dir) {
              ui.rocker[rod] = 0;
            }
            btn.classList.remove("held");
          };
          btn.addEventListener("pointerdown", press);
          btn.addEventListener("pointerup", release);
          btn.addEventListener("pointerleave", release);
          btn.addEventListener("pointercancel", release);
          btn.addEventListener("keydown", function (ev) {
            if (
              (ev.key === "Enter" ||
                ev.key === " " ||
                ev.key === "ArrowUp" ||
                ev.key === "ArrowDown") &&
              !ev.repeat
            ) {
              press(ev);
            }
          });
          btn.addEventListener("keyup", release);
          btn.addEventListener("blur", release);
        },
      );
    });
  }
  function rodLabel(rod) {
    return {
      shima: "SHIM A ROD CONTROL",
      shimb: "SHIM B ROD CONTROL",
      reg: "REGULATING ROD CONTROL",
    }[rod];
  }

  function wireSelectors() {
    keySwitch.addEventListener("click", function () {
      S.supply = !S.supply;
      if (!S.supply) {
        S.rodDrive = false;
      }
    });
    cycleSelector(
      modeSelector,
      function () {
        S.mode = (S.mode + 1) % 3;
      },
      function (d) {
        S.mode = (S.mode + 3 + d) % 3;
      },
    );
    cycleSelector(
      blowerSelector,
      function () {
        S.blowerSel = (S.blowerSel + 1) % 3;
      },
      function (d) {
        S.blowerSel = (S.blowerSel + 3 + d) % 3;
      },
    );

    rodDriveBtn.addEventListener("click", function () {
      if (!rodDriveBtn.classList.contains("open")) {
        rodDriveBtn.classList.add("open");
        return;
      }
      S.rodDrive = !S.rodDrive;
    });

    countRateBtn.addEventListener("click", function () {
      ui.sound = !ui.sound;
      if (ui.sound) {
        ensureAudio();
      }
    });

    scramBar.addEventListener("click", function () {
      trip();
    });

    tripResetBtn.addEventListener("click", function () {
      if (!S.scrammed) {
        return;
      }
      var seated =
        S.pos.safety < 0.5 &&
        S.pos.shima < 0.5 &&
        S.pos.shimb < 0.5 &&
        S.pos.reg < 0.5;
      if (seated && S.tf < 200) {
        S.scrammed = false;
        S.tScram = -1;
      } else {
        tripResetBtn.classList.remove("deny");
        void tripResetBtn.offsetWidth;
        tripResetBtn.classList.add("deny");
      }
    });

    acceptBtn.addEventListener("click", function () {
      S.unacked = {};
    });

    lampsBtn.addEventListener("pointerdown", function () {
      ui.lampsTest = true;
    });
    lampsBtn.addEventListener("pointerup", function () {
      ui.lampsTest = false;
    });
    lampsBtn.addEventListener("pointerleave", function () {
      ui.lampsTest = false;
    });
    lampsBtn.addEventListener("keydown", function (ev) {
      if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat) {
        ui.lampsTest = true;
      }
    });
    lampsBtn.addEventListener("keyup", function () {
      ui.lampsTest = false;
    });

    driveBkrBtn.addEventListener("click", function () {
      S.faults.shim = false;
      S.driftAge = S.faults.chamber ? S.driftAge : 0;
    });
    blowerRstBtn.addEventListener("click", function () {
      S.faults.blower = false;
    });

    // maintenance test switches
    var lid = $("tests-lid");
    lid.addEventListener("click", function () {
      testsPlate.classList.toggle("open");
    });
    Array.prototype.forEach.call(
      testsPlate.querySelectorAll(".toggle-mini"),
      function (tg) {
        tg.addEventListener("click", function (ev) {
          ev.stopPropagation();
          machine.inject(tg.getAttribute("data-testfault"));
        });
      },
    );

    // detector calibrate: hold 3 s
    var calTimer = null,
      calStart = 0;
    var calStop = function () {
      if (calTimer) {
        clearInterval(calTimer);
        calTimer = null;
      }
      S.calibrating = 0;
      detCalBtn.style.setProperty("--cal", 0);
      detCalBtn.classList.remove("calibrating");
    };
    var calStartFn = function (ev) {
      ev.preventDefault();
      if (calTimer) {
        return;
      }
      detCalBtn.classList.add("calibrating");
      calStart = Date.now();
      calTimer = setInterval(function () {
        var f = (Date.now() - calStart) / 3000;
        S.calibrating = f;
        detCalBtn.style.setProperty("--cal", clamp(f, 0, 1));
        if (f >= 1) {
          S.faults.chamber = false;
          S.driftAge = 0;
          calStop();
        }
      }, 60);
    };
    detCalBtn.addEventListener("pointerdown", calStartFn);
    detCalBtn.addEventListener("pointerup", calStop);
    detCalBtn.addEventListener("pointerleave", calStop);
    detCalBtn.addEventListener("keydown", function (ev) {
      if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat) {
        calStartFn(ev);
      }
    });
    detCalBtn.addEventListener("keyup", calStop);

    // power demand knob: vertical drag or arrow keys
    var dragging = null;
    demandKnob.addEventListener("pointerdown", function (ev) {
      dragging = ev.clientY;
      demandKnob.setPointerCapture(ev.pointerId);
    });
    demandKnob.addEventListener("pointermove", function (ev) {
      if (dragging === null) {
        return;
      }
      var dy = dragging - ev.clientY;
      dragging = ev.clientY;
      S.demand = clamp(S.demand + dy * 0.45, 10, 110);
    });
    demandKnob.addEventListener("pointerup", function () {
      dragging = null;
    });
    demandKnob.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowUp") {
        S.demand = clamp(S.demand + 2, 10, 110);
        ev.preventDefault();
      }
      if (ev.key === "ArrowDown") {
        S.demand = clamp(S.demand - 2, 10, 110);
        ev.preventDefault();
      }
    });

    // manual dialog
    el('[data-action="manual"]').addEventListener("click", function () {
      var fr = dlg.querySelector("iframe");
      if (fr && !fr.src) {
        fr.src = "manual.html";
      }
      dlg.showModal();
    });
    el('[data-action="close-manual"]').addEventListener("click", function () {
      dlg.close();
    });
  }

  function cycleSelector(btn, onCycle, onStep) {
    btn.addEventListener("click", onCycle);
    btn.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
        onStep(1);
        ev.preventDefault();
      }
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
        onStep(-1);
        ev.preventDefault();
      }
    });
  }

  /* ---------------------------------------------------------------- render */

  var logMeterSvg,
    periodMeterSvg,
    lastFrame = 0;

  function render() {
    // selectors
    keySwitch.classList.toggle("on", S.supply);
    jewels.supply.classList.toggle("on", S.supply);
    modeSelector.setAttribute("aria-valuenow", S.mode);
    modeSelector.querySelector(".sel-pointer").style.transform =
      "rotate(" + (S.mode * 45 - 45) + "deg)";
    blowerSelector.setAttribute("aria-valuenow", S.blowerSel);
    blowerSelector.querySelector(".sel-pointer").style.transform =
      "rotate(" + (S.blowerSel * 45 - 45) + "deg)";
    rodDriveBtn.classList.toggle("on", S.rodDrive);
    rodDriveBtn.setAttribute("aria-pressed", S.rodDrive ? "true" : "false");
    countRateBtn.classList.toggle("on", ui.sound);
    countRateBtn.setAttribute("aria-pressed", ui.sound ? "true" : "false");

    // rods
    ["safety", "shima", "shimb", "reg"].forEach(function (rod) {
      var v = S.pos[rod];
      drumScales[rod].style.transform = "translateY(" + (67 - 0.7 * v) + "px)";
      posOuts[rod].textContent = Math.round(v) + "%";
    });

    // demand knob
    demandKnob.setAttribute("aria-valuenow", Math.round(S.demand));
    demandKnob.querySelector(".knob-pointer").style.transform =
      "rotate(" + (-135 + ((S.demand - 10) / 100) * 270) + "deg)";
    $("rd-demand").textContent = Math.round(S.demand) + "% F.P.";

    // instruments
    var mwDisp = displayedFlux();
    var pct = (mwDisp / RATED_MW) * 100;
    logMeterSvg._needle.setAttribute(
      "transform",
      "rotate(" + logAngle(clamp(pct, 1e-3, 155)) + " 100 116)",
    );
    var dt = displayedPeriod();
    var pa = 0;
    if (isFinite(dt) && Math.abs(dt) < 90000) {
      pa = (dt >= 0 ? 1 : -1) * periodAngle(Math.abs(dt));
    }
    periodMeterSvg._needle.setAttribute(
      "transform",
      "rotate(" + pa + " 100 116)",
    );

    $("rd-power").textContent =
      mwDisp >= 1 ? mwDisp.toFixed(2) : mwDisp.toExponential(1);
    $("rd-temp").textContent = String(Math.round(S.tf));
    $("rd-flow").textContent = String(Math.round(S.flow));

    var hh = Math.floor(S.t / 3600),
      mm = Math.floor(S.t / 60) % 60,
      ss = Math.floor(S.t) % 60;
    $("rd-time").textContent =
      (hh < 10 ? "0" : "") +
      hh +
      ":" +
      (mm < 10 ? "0" : "") +
      mm +
      ":" +
      (ss < 10 ? "0" : "") +
      ss;

    jewels.critical.classList.toggle(
      "on",
      S.supply && Math.abs(netReactivity()) < 8 && S.n > 0.05,
    );

    // annunciators
    ALARM_ORDER.forEach(function (name) {
      var a = anns[name];
      if (!a) {
        return;
      }
      var lit = S.active[name] || ui.lampsTest;
      a.classList.toggle("lit", !!lit);
      a.classList.toggle(
        "red",
        name === "REACTOR SCRAM" ||
          name === "HIGH FLUX" ||
          name === "HIGH FUEL TEMPERATURE",
      );
      a.classList.toggle("unack", !!S.unacked[name]);
      a.classList.toggle("testlit", ui.lampsTest && !S.active[name]);
    });

    // fault echo switches
    Array.prototype.forEach.call(
      testsPlate.querySelectorAll(".toggle-mini"),
      function (tg) {
        var f = tg.getAttribute("data-testfault");
        tg.setAttribute(
          "aria-pressed",
          (f === "shim rod drive failure" && S.faults.shim) ||
            (f === "coolant blower trip" && S.faults.blower) ||
            (f === "ion chamber drift" && S.faults.chamber)
            ? "true"
            : "false",
        );
      },
    );

    drawRecorder();
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!lastFrame) {
      lastFrame = ts;
    }
    var dtReal = (ts - lastFrame) / 1000;
    lastFrame = ts;
    if (dtReal > 0.5) {
      dtReal = 0.5;
    }
    if (!document.hidden && dtReal > 0) {
      tick(dtReal);
      geiger(dtReal);
    }
    render();
  }

  /* ------------------------------------------------------------------ boot */

  function init() {
    cacheDom();
    buildDrum(drumScales.safety);
    buildDrum(drumScales.shima);
    buildDrum(drumScales.shimb);
    buildDrum(drumScales.reg);

    logMeterSvg = $("meter-log");
    periodMeterSvg = $("meter-period");
    buildLogMeter(logMeterSvg);
    buildPeriodMeter(periodMeterSvg);
    initRecorder();
    wireRockers();
    wireSelectors();
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
