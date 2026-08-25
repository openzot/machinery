/* Nitration House No. 3 — Sallowfield Works, 1927.
   Watch bench simulation: one nitration charge held on temperature
   against brine, air-lift agitation, and the drowning-tank dump. */
(function () {
  "use strict";

  /* ---------------- constants ---------------- */

  var NAME = "Sallowfield Works — Nitration House No. 3";
  var FAULTS = [
    "brine cooling loss",
    "agitation air failure",
    "glycerine feed overrun",
  ];

  var ACID_LB = 950; // standing charge of mixed acid
  var TARGET_LB = 120; // glycerine to be fed per charge
  var POT_CAP = 1070; // total liquid the pot will hold, lb
  var AMBIENT_F = 60;
  var FLAG_TEMP_F = 79; // TEMP HIGH
  var RUN_TEMP_F = 86; // dump without argument
  var BLOW_TEMP_F = 95; // instantaneous detonation
  var RUN_SECONDS = 25; // seconds at or above RUN before she goes

  /* ---------------- state ---------------- */

  var S = null;

  function freshState() {
    return {
      // services
      compressorOn: false,
      agitTurns: 0, // 0..5
      feedTurns: 0, // 0..4
      brineOpen: false,
      drawOpen: false,
      damper: 0, // 0..100 percent
      // plant
      airPsi: 0,
      airArmed: false,        // has stood at working pressure this shift
      brineFlow: 0, // nominal 12 gpm
      chargeTempF: AMBIENT_F,
      chargeLb: ACID_LB,
      glycerineFed: 0,
      feedRate: 0, // effective lb/min right now
      draught: 0, // inches water
      fume: 0, // 0..120 arbitrary loading
      settle: 0, // 0..1, separation progress
      settled: false, // split into nitroglycerine over spent acid
      drownLb: 0, // water fouled by product, lb
      // bookkeeping
      simTime: 0,
      batchTime: 0,
      runTimer: 0, // seconds at or above RUN_TEMP_F
      dumped: false,
      wrecked: false,
      complete: false,
      fumeLockout: false,
      faults: { brine: false, air: false, feed: false },
      flags: {
        "TEMP HIGH": false,
        "AIR LOW": false,
        "BRINE LOW": false,
        "FEED EXCESS": false,
        "DRAUGHT LOST": false,
        "FUMED OUT": false,
        "CHARGE DUMPED": false,
        "HOUSE LOST": false,
      },
    };
  }

  function resetFlags() {
    S.flags["TEMP HIGH"] = false;
    S.flags["AIR LOW"] = false;
    S.flags["BRINE LOW"] = false;
    S.flags["FEED EXCESS"] = false;
    S.flags["DRAUGHT LOST"] = false;
    S.flags["FUMED OUT"] = false;
    S.flags["CHARGE DUMPED"] = false;
    S.flags["HOUSE LOST"] = false;
    S.fumeLockout = false;
  }

  function reset() {
    S = freshState();
  }
  reset();

  /* ---------------- helpers ---------------- */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function agitationQuality() {
    // air-lift needs pressure behind it and the regulating valve open
    var byAir = clamp((S.airPsi - 8) / 32, 0, 1);
    var byValve = clamp(S.agitTurns / 1.2, 0, 1);
    return byAir * byValve;
  }

  function rawFeedRate() {
    if (S.wrecked) return 0;
    if (S.fumeLockout) return 0;
    return Math.min(S.feedTurns * 16, 44);
  }

  function effectiveFeedRate() {
    var base = rawFeedRate();
    if (S.faults.feed) {
      return base * 2.2 + (base < 1 ? 14 : 0);
    }
    return base;
  }

  function brineTarget() {
    if (S.brineOpen && !S.faults.brine && !S.wrecked) return 12;
    return 0;
  }

  /* ---------------- physics ---------------- */

  function step(dt) {
    var dtm = dt / 60; // minutes
    S.simTime += dt;
    S.batchTime += dt;

    // --- air receiver -------------------------------------------------
    var leak = 0.7 + S.agitTurns * 2.0;
    if (S.faults.air) leak += 26;
    if (S.compressorOn) {
      S.airPsi += (52 - S.airPsi) * 0.9 * dtm;
    } else if (S.airPsi > 0) {
      S.airPsi -= 1.2 * dtm * 10;
    }
    S.airPsi -= leak * dtm;
    if (!S.compressorOn && !S.faults.air && S.airPsi < 0) S.airPsi = 0;
    S.airPsi = clamp(S.airPsi, 0, 60);
    if (S.airPsi >= 40) S.airArmed = true;

    // --- brine --------------------------------------------------------
    var bt = brineTarget();
    var rate = bt > S.brineFlow ? 30 : 48; // gpm per second toward target
    S.brineFlow += clamp(bt - S.brineFlow, -rate * dt, rate * dt);

    // --- glycerine feed -----------------------------------------------
    var want = effectiveFeedRate();
    if (S.dumped || S.wrecked) want = 0;
    if (S.chargeLb >= POT_CAP) want = Math.min(want, 0);
    S.feedRate += clamp(want - S.feedRate, -60 * dt, 60 * dt);

    var fed = S.feedRate * dtm;
    if (fed > 0) {
      var room = POT_CAP - S.chargeLb;
      if (fed > room) fed = room;
      S.chargeLb += fed;
      S.glycerineFed += fed;
    }

    // settling restarts if you go on feeding after the split
    if (S.feedRate > 0.5) S.settle = Math.min(S.settle, 0.05);
    if (
      S.feedRate < 0.5 &&
      S.glycerineFed >= TARGET_LB &&
      !S.settled &&
      S.settle < 1
    ) {
      S.settle += dtm / 2;
      if (S.settle >= 1) {
        S.settle = 1;
        S.settled = true;
      }
    }

    // --- temperature -----------------------------------------------------
    // heat and cool are degrees F per minute; integrate per second
    var heat = 0.5 * S.feedRate; // reaction
    var cool =
      0.36 *
      agitationQuality() *
      (S.brineFlow / 12) *
      Math.max(S.chargeTempF - 38, 0);
    cool += 0.055 * Math.max(S.chargeTempF - 50, 0) * (S.brineFlow / 12); // jacket floor
    var ambLoss = (S.chargeTempF - AMBIENT_F) * 0.01;
    var degPerSec = (heat - cool - ambLoss) / 60;
    S.chargeTempF = clamp(S.chargeTempF + degPerSec * dt, AMBIENT_F - 4, 400);

    // runaway bookkeeping
    if (!S.wrecked) {
      if (S.chargeTempF >= RUN_TEMP_F) {
        S.runTimer += dt;
        if (S.runTimer >= RUN_SECONDS || S.chargeTempF >= BLOW_TEMP_F)
          detonate();
      } else {
        S.runTimer = Math.max(0, S.runTimer - dt * 2);
      }
    }

    // --- draught and fumes ---------------------------------------------
    var base = (S.damper / 100) * 0.42;
    var wobble =
      Math.sin(S.simTime / 7) * 0.012 + Math.sin(S.simTime / 2.3) * 0.006;
    S.draught = clamp(base + wobble, 0, 0.6);
    if (S.damper < 2) S.draught = Math.max(S.draught, 0.005);
    if (S.feedRate > 0.5) {
      S.fume += Math.max(0, 0.16 - S.draught) * 150 * dtm;
    } else {
      S.fume -= 16 * dtm;
    }
    S.fume = clamp(S.fume, 0, 120);
    if (S.fume >= 100 && !S.fumeLockout && !S.wrecked) {
      S.fumeLockout = true; // the office stops the feed until the vent proves clear
    }

    // --- drawing off spent acid -----------------------------------------
    if (S.drawOpen && S.settled && !S.dumped && !S.wrecked) {
      var drawn = 90 * dt; // lb per second
      var acidLb = S.chargeLb - S.glycerineFed;
      if (drawn > acidLb) drawn = Math.max(acidLb, 0);
      S.chargeLb -= drawn;
      if (S.chargeLb <= S.glycerineFed + 0.5 && S.glycerineFed >= TARGET_LB) {
        S.complete = true;
        chime();
      }
    }

    // --- dump / detonation drainage --------------------------------------
    if ((S.dumped || S.wrecked) && S.chargeLb > 0) {
      var drop = 320 * dt;
      if (drop > S.chargeLb) drop = S.chargeLb;
      S.chargeLb -= drop;
      S.drownLb += drop;
    }
  }

  function detonate() {
    S.wrecked = true;
    S.runTimer = 0;
    S.flags["TEMP HIGH"] = true;
    S.flags["HOUSE LOST"] = true;
    roar();
  }

  /* ---------------- alarms ---------------- */

  function updateFlags() {
    if (S.chargeTempF >= FLAG_TEMP_F) S.flags["TEMP HIGH"] = true;
    if (S.faults.air || (S.airArmed && S.airPsi < 32)) S.flags["AIR LOW"] = true;
    if (S.faults.brine || (S.feedRate > 0.5 && !S.brineOpen))
      S.flags["BRINE LOW"] = true;
    if (effectiveFeedRate() > 34) S.flags["FEED EXCESS"] = true;
    if (S.feedRate > 0.5 && S.draught < 0.12) S.flags["DRAUGHT LOST"] = true;
    if (S.fumeLockout) S.flags["FUMED OUT"] = true;
    if (S.dumped) S.flags["CHARGE DUMPED"] = true;

    // the gong speaks only for the dangerous ones, and only once per trip
    if (S.flags["TEMP HIGH"] && !gonged.TEMP) {
      gonged.TEMP = true;
      gong();
    }
    if (S.flags["BRINE LOW"] && !gonged.BRINE) {
      gonged.BRINE = true;
      gong();
    }
    if (S.flags["AIR LOW"] && !gonged.AIR) {
      gonged.AIR = true;
      gong();
    }
  }

  var gonged = {};

  function activeAlarms() {
    var out = [];
    for (var k in S.flags) if (S.flags[k]) out.push(k);
    return out;
  }

  /* ---------------- public API ---------------- */

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),

    state: function () {
      return {
        phase: phaseName(),
        chargeTempF: r2(S.chargeTempF),
        ambientTempF: AMBIENT_F,
        chargeLb: r1(S.chargeLb),
        glycerineFedLb: r1(S.glycerineFed),
        feedRateLbMin: r1(S.feedRate),
        airPressurePsi: r1(S.airPsi),
        agitationTurns: S.agitTurns,
        feedValveTurns: S.feedTurns,
        brineFlowGpm: r1(S.brineFlow),
        ventDamperPercent: Math.round(S.damper),
        draughtInWater: r2(S.draught),
        fumeLoading: r1(S.fume),
        settleProgress: r2(S.settle),
        drowningTankLb: r1(S.drownLb),
        dumped: !!S.dumped,
        wrecked: !!S.wrecked,
        batchComplete: !!S.complete,
        batchSeconds: Math.round(S.batchTime),
        alarms: activeAlarms(),
      };
    },

    tick: function (seconds) {
      var t = Number(seconds);
      if (!isFinite(t) || t <= 0) return this.state();
      var left = Math.min(t, 3600);
      while (left > 0) {
        var dt = left > 0.25 ? 0.25 : left;
        step(dt);
        updateFlags();
        left -= dt;
      }
      return this.state();
    },

    inject: function (fault) {
      var f = String(fault || "")
        .trim()
        .toLowerCase();
      if (f === "brine cooling loss") setFault("brine", true);
      else if (f === "agitation air failure") setFault("air", true);
      else if (f === "glycerine feed overrun") setFault("feed", true);
      return this.state();
    },

    reset: function () {
      reset();
      gonged = {};
      syncControlsToState();
      return this.state();
    },
  };

  function r1(v) {
    return Math.round(v * 10) / 10;
  }
  function r2(v) {
    return Math.round(v * 100) / 100;
  }

  function phaseName() {
    if (S.wrecked) return "HOUSE LOST — CHARGE DETONATED";
    if (S.dumped) return "DUMPED — HOUSE TO THE DROWNING TANK";
    if (S.complete) return "BATCH COMPLETE — HAND TO THE WASH HOUSE";
    if (S.drawOpen && S.settled) return "DRAWING SPENT ACID";
    if (S.settled) return "SETTLED — DRAW WHEN READY";
    if (S.settle > 0.02) return "SETTLING";
    if (S.feedRate > 0.5) return "FEEDING — HOLD HER STEADY";
    if (S.glycerineFed > 0.5) return "FEED STOPPED — WATCH THE THREAD";
    if (S.compressorOn || S.brineOpen) return "SERVICES ON — READY TO FEED";
    return "COLD — ACID STANDING";
  }

  function setFault(which, on) {
    S.faults[which] = !!on;
    var btn = null;
    if (which === "brine") btn = testBtns.brine;
    if (which === "air") btn = testBtns.air;
    if (which === "feed") btn = testBtns.feed;
    if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /* ================= DOM ================= */

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var SVGNS = "http://www.w3.org/2000/svg";

  var el = {
    body: document.body,
    tAir: $("#tAir"),
    tAgit: $("#tAgit"),
    tFeedTurns: $("#tFeedTurns"),
    tFed: $("#tFed"),
    tRate: $("#tRate"),
    tTemp: $("#tTemp"),
    tLevel: $("#tLevel"),
    tDraught: $("#tDraught"),
    tPhase: $("#tPhase"),
    tBatch: $("#tBatch"),
    airNeedle: $("#airNeedle"),
    airTicks: $("#airTicks"),
    thermoScale: $("#thermoScale"),
    mercury: $("#mercury"),
    emul: $("#emulLiq"),
    settleLayers: $("#settleLayers"),
    acidLiq: $("#acidLiq"),
    ngLiq: $("#ngLiq"),
    iface: $("#ifaceLine"),
    sgAcid: $("#sgAcid"),
    sgNg: $("#sgNg"),
    sgIface: $("#sgIface"),
    bub: [$("#bub1"), $("#bub2"), $("#bub3"), $("#bub4"), $("#bub5")],
    glyDrop: $("#glyDrop"),
    flyWheel: $("#flyWheel"),
    airLine: $("#airLine"),
    brineDash: $("#brineDash"),
    ventGate: $("#ventGate"),
    wisps: $("#wisps"),
    draughtCol: $("#draughtCol"),
    drownFill: $("#drownFill"),
    dumpPath: $("#dumpPath"),
    flags: {},
    knife: $('[data-control="AIR COMPRESSOR SWITCH"]'),
    rot: $('[data-control="AGITATION AIR VALVE"]'),
    rotWheel: $(".rot-wheel"),
    nv: $('[data-control="GLYCERINE FEED VALVE"]'),
    nvSpindle: $(".nv-spindle"),
    brineCock: $('[data-control="BRINE COCK"]'),
    drawCock: $('[data-control="SPENT ACID COCK"]'),
    damperEl: $('[data-control="VENT DAMPER"]'),
    damperHandle: $(".damper-handle"),
    dumpLever: $('[data-control="DUMP LEVER"]'),
    bellCut: $('[data-control="ALARM BELL CUT"]'),
    flagsReset: $('[data-control="FLAGS RESET"]'),
    flagProof: $('[data-control="FLAG PROOF"]'),
    testBtns: {
      brine: $('[data-control="TEST BRINE LOSS"]'),
      air: $('[data-control="TEST AIR FAILURE"]'),
      feed: $('[data-control="TEST FEED OVERRUN"]'),
    },
    restoreBrine: $('[data-control="RESTORE BRINE"]'),
    freeAgitator: $('[data-control="FREE AGITATOR"]'),
    resetFeedLimiter: $('[data-control="RESET FEED LIMITER"]'),
    resetCharge: $('[data-control="RESET CHARGE"]'),
    manualBtn: $('[data-action="manual"]'),
    closeManualBtn: $('[data-action="close-manual"]'),
    dialog: $("dialog[data-manual]"),
  };
  var testBtns = el.testBtns;

  Array.prototype.forEach.call(
    document.querySelectorAll(".flag"),
    function (f) {
      el.flags[f.getAttribute("data-flag")] = f;
    },
  );

  /* ------------- static dial furniture, drawn once ------------- */

  function buildAirTicks() {
    var cx = 60,
      cy = 60,
      r1o = 49,
      r1i = 43;
    for (var v = 0; v <= 60; v += 5) {
      var a = ((-210 + (v / 60) * 240) * Math.PI) / 180;
      var major = v % 10 === 0;
      var ro = major ? r1i - 3 : r1i;
      var ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", (cx + Math.cos(a) * ro).toFixed(2));
      ln.setAttribute("y1", (cy + Math.sin(a) * ro).toFixed(2));
      ln.setAttribute("x2", (cx + Math.cos(a) * r1o).toFixed(2));
      ln.setAttribute("y2", (cy + Math.sin(a) * r1o).toFixed(2));
      if (major) ln.setAttribute("class", "major");
      el.airTicks.appendChild(ln);
      if (major) {
        var tx = document.createElementNS(SVGNS, "text");
        var rt = r1i - 10;
        tx.setAttribute("x", (cx + Math.cos(a) * rt).toFixed(2));
        tx.setAttribute("y", (cy + Math.sin(a) * rt + 3).toFixed(2));
        tx.textContent = String(v);
        el.airTicks.appendChild(tx);
      }
    }
    // working mark at 45 psi
    var aw = ((-210 + (45 / 60) * 240) * Math.PI) / 180;
    var mk = document.createElementNS(SVGNS, "line");
    mk.setAttribute("x1", (cx + Math.cos(aw) * 36).toFixed(2));
    mk.setAttribute("y1", (cy + Math.sin(aw) * 36).toFixed(2));
    mk.setAttribute("x2", (cx + Math.cos(aw) * 47).toFixed(2));
    mk.setAttribute("y2", (cy + Math.sin(aw) * 47).toFixed(2));
    mk.setAttribute("stroke", "#b3261a");
    mk.setAttribute("stroke-width", "2.4");
    el.airTicks.appendChild(mk);
  }

  // thermometer: 60F at y=360, 5.5 px per degree F upward
  var TH_BASE_Y = 360;
  var TH_PX_PER_F = 5.5;

  function thY(tempF) {
    return TH_BASE_Y - (tempF - 60) * TH_PX_PER_F;
  }

  function buildThermoScale() {
    for (var t = 60; t <= 100; t += 5) {
      var y = thY(t);
      var ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", "296");
      ln.setAttribute("x2", "301");
      ln.setAttribute("y1", y.toFixed(1));
      ln.setAttribute("y2", y.toFixed(1));
      el.thermoScale.appendChild(ln);
      if (t % 10 === 0) {
        var tx = document.createElementNS(SVGNS, "text");
        tx.setAttribute("x", "294");
        tx.setAttribute("y", (y + 3).toFixed(1));
        tx.textContent = String(t);
        el.thermoScale.appendChild(tx);
      }
    }
  }

  /* ------------- rendering ------------- */

  var potBaseY = 350;
  var potTopY = 172;
  var pxPerLb = (potBaseY - potTopY) / POT_CAP;

  function liqY(lb) {
    return potBaseY - lb * pxPerLb;
  }

  // pot sight glass: liquid bottom at y=346, full (1070 lb) at y=166
  var SG_BASE_Y = 346;
  var SG_PX_PER_LB = (SG_BASE_Y - 166) / POT_CAP;

  function buildSightScale() {
    var g = document.getElementById("sightScale");
    if (!g) return;
    for (var lb = 0; lb <= 1000; lb += 250) {
      var y = SG_BASE_Y - lb * SG_PX_PER_LB;
      var ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", "477");
      ln.setAttribute("x2", "482");
      ln.setAttribute("y1", y.toFixed(1));
      ln.setAttribute("y2", y.toFixed(1));
      ln.setAttribute("stroke", "#8d978d");
      ln.setAttribute("stroke-width", "1.4");
      g.appendChild(ln);
      if (lb % 500 === 0) {
        var tx = document.createElementNS(SVGNS, "text");
        tx.setAttribute("x", "486");
        tx.setAttribute("y", (y + 3).toFixed(1));
        tx.setAttribute("class", "scale-note");
        tx.textContent = String(lb);
        g.appendChild(tx);
      }
    }
  }

  /* ------------- rendering ------------- */

  var potBaseY = 350;
  var potTopY = 172;
  var pxPerLb = (potBaseY - potTopY) / POT_CAP;

  function liqY(lb) {
    return potBaseY - lb * pxPerLb;
  }

  /* ------------- rendering ------------- */

  var potBaseY = 350;
  var potTopY = 172;
  var pxPerLb = (potBaseY - potTopY) / POT_CAP;

  function liqY(lb) {
    return potBaseY - lb * pxPerLb;
  }

  // pot sight glass: liquid bottom at y=346, full (1070 lb) at y=166
  var SG_BASE_Y = 346;
  var SG_PX_PER_LB = (SG_BASE_Y - 166) / POT_CAP;

  function render(now) {
    // thermometer
    var topY = thY(clamp(S.chargeTempF, 58, 102));
    if (topY < 132) topY = 132;
    el.mercury.setAttribute("y", topY.toFixed(1));
    el.mercury.setAttribute("height", Math.max(372 - topY, 2).toFixed(1));

    // pot contents
    var total = clamp(S.chargeLb, 0, POT_CAP);
    var split = S.settled || (S.settle > 0.6 && S.feedRate < 0.5);
    var surfY = liqY(total);
    if (split) {
      el.emul.setAttribute("height", "0");
      el.settleLayers.setAttribute("opacity", "1");
      var ngLb = Math.min(S.glycerineFed, total);
      var acidLb = total - ngLb;
      var ifaceY = liqY(acidLb);
      el.acidLiq.setAttribute("y", ifaceY.toFixed(1));
      el.acidLiq.setAttribute("height", (potBaseY - ifaceY).toFixed(1));
      el.ngLiq.setAttribute("y", surfY.toFixed(1));
      el.ngLiq.setAttribute("height", (ifaceY - surfY).toFixed(1));
      el.iface.setAttribute("y1", ifaceY.toFixed(1));
      el.iface.setAttribute("y2", ifaceY.toFixed(1));
    } else {
      el.settleLayers.setAttribute("opacity", "0");
      el.emul.setAttribute("y", surfY.toFixed(1));
      el.emul.setAttribute("height", (potBaseY - surfY).toFixed(1));
    }

    // sight glass mirrors the pot
    var sgSurf = SG_BASE_Y - total * SG_PX_PER_LB;
    if (split) {
      var sgAcidLb = total - Math.min(S.glycerineFed, total);
      var sgIfaceY = SG_BASE_Y - sgAcidLb * SG_PX_PER_LB;
      el.sgAcid.setAttribute("y", sgIfaceY.toFixed(1));
      el.sgAcid.setAttribute("height", (SG_BASE_Y - sgIfaceY).toFixed(1));
      el.sgNg.setAttribute("y", sgSurf.toFixed(1));
      el.sgNg.setAttribute("height", (sgIfaceY - sgSurf).toFixed(1));
      el.sgIface.setAttribute("y1", sgIfaceY.toFixed(1));
      el.sgIface.setAttribute("y2", sgIfaceY.toFixed(1));
    } else {
      el.sgAcid.setAttribute("y", sgSurf.toFixed(1));
      el.sgAcid.setAttribute("height", (SG_BASE_Y - sgSurf).toFixed(1));
      el.sgNg.setAttribute("height", "0");
      el.sgIface.setAttribute("y1", "500");
      el.sgIface.setAttribute("y2", "500");
    }

    // bubbles while the lift is on
    var aq = agitationQuality();
    for (var i = 0; i < el.bub.length; i++) {
      var b = el.bub[i];
      if (aq > 0.08 && !S.dumped && !S.wrecked && total > 200) {
        var cycle = (now * (0.05 + i * 0.011) + i * 0.19) % 1;
        var by = potBaseY - 8 - cycle * (potBaseY - surfY - 14);
        b.setAttribute("cy", by.toFixed(1));
        b.setAttribute("opacity", (aq * 0.85 * (1 - cycle * 0.5)).toFixed(2));
      } else {
        b.setAttribute("opacity", "0");
      }
    }

    // glycerine drip
    if (S.feedRate > 0.5 && !S.wrecked && !S.dumped) {
      var period = clamp(1.5 - S.feedRate / 26, 0.28, 1.5);
      var ph = (now % period) / period;
      el.glyDrop.setAttribute("opacity", ph < 0.85 ? "1" : "0");
      el.glyDrop.setAttribute("cy", (70 + ph * 27).toFixed(1));
    } else {
      el.glyDrop.setAttribute("opacity", "0");
    }

    // compressor flywheel and air line
    if (S.compressorOn) {
      flyAngle = (flyAngle + 190 * lastDt) % 360;
      el.flyWheel.setAttribute(
        "transform",
        "rotate(" + flyAngle.toFixed(1) + " 112 290)",
      );
      el.airLine.classList.add("pressurised");
    } else {
      el.airLine.classList.remove("pressurised");
    }
    el.airNeedle.setAttribute(
      "transform",
      "rotate(" +
        (-210 + (clamp(S.airPsi, 0, 60) / 60) * 240).toFixed(1) +
        " 60 60)",
    );

    // brine
    var flowing = S.brineFlow > 1.5;
    el.brineDash.classList.toggle("on", flowing);

    // vent
    el.ventGate.setAttribute(
      "transform",
      "translate(" + ((S.damper / 100) * 26).toFixed(1) + " 0)",
    );
    var wispOp =
      S.damper > 8 && !S.wrecked ? 0.25 + (S.feedRate > 0.5 ? 0.45 : 0) : 0;
    el.wisps.setAttribute("opacity", wispOp.toFixed(2));

    // draught U-gauge: 0..0.5 in -> 0..18px column
    var colH = clamp(S.draught / 0.5, 0, 1) * 18;
    el.draughtCol.setAttribute("y", (132 - colH).toFixed(1));
    el.draughtCol.setAttribute("height", colH.toFixed(1));

    // drowning tank
    var fillH = clamp(S.drownLb / POT_CAP, 0, 1) * 38;
    el.drownFill.setAttribute("y", (494 - fillH).toFixed(1));
    el.drownFill.setAttribute("height", fillH.toFixed(1));
    el.dumpPath.classList.toggle(
      "flowing",
      (S.dumped || S.wrecked) && S.chargeLb > 1,
    );

    // flags
    for (var fname in el.flags) {
      el.flags[fname].classList.toggle("tripped", !!S.flags[fname]);
    }

    // text readouts at ~8 Hz
    uiAccum += lastDt;
    if (uiAccum > 0.12 || forceUi) {
      uiAccum = 0;
      forceUi = false;
      el.tAir.textContent = String(Math.round(S.airPsi));
      el.tAgit.textContent = S.agitTurns.toFixed(1);
      el.tFeedTurns.textContent =
        S.feedTurns <= 0.01 ? "SHUT" : S.feedTurns.toFixed(2) + " TURNS";
      el.tFed.textContent = String(Math.round(S.glycerineFed));
      el.tRate.textContent = S.feedRate.toFixed(1);
      el.tTemp.textContent = String(Math.round(S.chargeTempF));
      el.tLevel.textContent = String(Math.round(S.chargeLb));
      el.tDraught.textContent = S.draught.toFixed(2);
      el.tPhase.textContent = phaseName();
      el.tPhase.classList.toggle(
        "alarm",
        S.wrecked || S.flags["TEMP HIGH"] || S.flags["BRINE LOW"],
      );
      var mm = Math.floor(S.batchTime / 60),
        ss = Math.floor(S.batchTime % 60);
      el.tBatch.textContent =
        (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
    }

    // audio follows the plant
    audioFrame();
  }

  var flyAngle = 0;
  var uiAccum = 0;
  var forceUi = true;

  /* ------------- sound (Web Audio, gesture-gated) ------------- */

  var AC = null;
  var hissGain = null;
  var masterGain = null;

  function ensureAudio() {
    if (AC) {
      if (AC.state === "suspended") AC.resume();
      return;
    }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    AC = new Ctx();
    masterGain = AC.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(AC.destination);
    // looping air hiss, level driven by agitation
    var len = AC.sampleRate * 1.5;
    var buf = AC.createBuffer(1, len, AC.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    var src = AC.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var lp = AC.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 850;
    hissGain = AC.createGain();
    hissGain.gain.value = 0;
    src.connect(lp).connect(hissGain).connect(masterGain);
    src.start();
  }

  function audioFrame() {
    if (!AC || !hissGain) return;
    var target = 0;
    if (S.airPsi > 20 && S.agitTurns > 0.1)
      target = 0.02 + agitationQuality() * 0.05;
    hissGain.gain.setTargetAtTime(target, AC.currentTime, 0.25);
  }

  function gong() {
    if (!AC || bellCutOn) return;
    var t0 = AC.currentTime;
    for (var n = 0; n < 5; n++) {
      var t = t0 + n * 0.42;
      var o = AC.createOscillator();
      var o2 = AC.createOscillator();
      var g = AC.createGain();
      o.type = "triangle";
      o.frequency.value = 512;
      o.detune.value = -6;
      o2.type = "sine";
      o2.frequency.value = 682;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g);
      o2.connect(g);
      g.connect(masterGain);
      o.start(t);
      o2.start(t);
      o.stop(t + 1.2);
      o2.stop(t + 1.2);
    }
  }

  function chime() {
    if (!AC) return;
    var t = AC.currentTime;
    var o = AC.createOscillator(),
      g = AC.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(masterGain);
    o.start(t);
    o.stop(t + 1);
  }

  function roar() {
    if (!AC) return;
    var t = AC.currentTime;
    var len = AC.sampleRate * 2.2;
    var buf = AC.createBuffer(1, len, AC.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++)
      d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = AC.createBufferSource();
    src.buffer = buf;
    var lp = AC.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220;
    var g = AC.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    src.connect(lp).connect(g).connect(masterGain);
    src.start(t);
  }

  var bellCutOn = false;

  /* ------------- control wiring ------------- */

  function syncControlsToState() {
    el.knife.setAttribute("aria-pressed", "false");
    el.rotWheel.style.transform = "rotate(0deg)";
    el.rot.setAttribute("aria-valuenow", "0");
    el.rot.setAttribute("aria-valuetext", "0 turns open");
    el.nv.setAttribute("aria-valuenow", "0");
    el.nv.setAttribute("aria-valuetext", "0 turns open");
    el.nvSpindle.style.transform = "rotate(0deg)";
    el.brineCock.setAttribute("aria-pressed", "false");
    el.drawCock.setAttribute("aria-pressed", "false");
    el.damperHandle.style.left = "0%";
    el.damperEl.setAttribute("aria-valuenow", "0");
    el.damperEl.setAttribute("aria-valuetext", "Damper shut");
    el.dumpLever.classList.remove("pulled");
    el.dumpLever.classList.remove("guard-open");
    testBtns.brine.setAttribute("aria-pressed", "false");
    testBtns.air.setAttribute("aria-pressed", "false");
    testBtns.feed.setAttribute("aria-pressed", "false");
    el.bellCut.setAttribute("aria-pressed", "false");
    bellCutOn = false;
    forceUi = true;
  }

  // knife switch
  el.knife.addEventListener("click", function () {
    S.compressorOn = !S.compressorOn;
    el.knife.setAttribute("aria-pressed", S.compressorOn ? "true" : "false");
    el.knife.setAttribute(
      "aria-label",
      "Air compressor switch, " +
        (S.compressorOn
          ? "ON — press to switch OFF"
          : "OFF — press to switch ON"),
    );
  });

  // rotary agitation valve
  function setAgit(v) {
    S.agitTurns = clamp(Math.round(v * 4) / 4, 0, 5);
    el.rotWheel.style.transform = "rotate(" + S.agitTurns * 74 + "deg)";
    el.rot.setAttribute("aria-valuenow", String(S.agitTurns));
    el.rot.setAttribute(
      "aria-valuetext",
      S.agitTurns.toFixed(2) + " turns open",
    );
    forceUi = true;
  }
  el.rot.addEventListener("click", function () {
    setAgit(S.agitTurns + 0.25);
  });
  el.rot.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      setAgit(S.agitTurns + 0.25);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      setAgit(S.agitTurns - 0.25);
      e.preventDefault();
    } else if (e.key === "Home") {
      setAgit(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setAgit(5);
      e.preventDefault();
    }
  });

  // glycerine needle valve
  function setFeed(v) {
    S.feedTurns = clamp(Math.round(v * 4) / 4, 0, 4);
    el.nvSpindle.style.transform = "rotate(" + S.feedTurns * 180 + "deg)";
    el.nv.setAttribute("aria-valuenow", String(S.feedTurns));
    el.nv.setAttribute(
      "aria-valuetext",
      S.feedTurns.toFixed(2) + " turns open",
    );
    forceUi = true;
  }
  el.nv.addEventListener("click", function () {
    setFeed(S.feedTurns + 0.25);
  });
  el.nv.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      setFeed(S.feedTurns + (e.deltaY < 0 ? 0.25 : -0.25));
    },
    { passive: false },
  );
  el.nv.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      setFeed(S.feedTurns + 0.25);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      setFeed(S.feedTurns - 0.25);
      e.preventDefault();
    } else if (e.key === "Home") {
      setFeed(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setFeed(4);
      e.preventDefault();
    }
  });

  // cocks
  el.brineCock.addEventListener("click", function () {
    S.brineOpen = !S.brineOpen;
    el.brineCock.setAttribute("aria-pressed", S.brineOpen ? "true" : "false");
  });
  el.drawCock.addEventListener("click", function () {
    S.drawOpen = !S.drawOpen;
    el.drawCock.setAttribute("aria-pressed", S.drawOpen ? "true" : "false");
  });

  // vent damper slider
  function setDamper(pct) {
    S.damper = clamp(Math.round(pct), 0, 100);
    el.damperHandle.style.left = S.damper + "%";
    el.damperEl.setAttribute("aria-valuenow", String(S.damper));
    el.damperEl.setAttribute(
      "aria-valuetext",
      S.damper === 0 ? "Damper shut" : "Damper " + S.damper + " percent open",
    );
    forceUi = true;
  }
  el.damperEl.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      setDamper(S.damper + 5);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      setDamper(S.damper - 5);
      e.preventDefault();
    } else if (e.key === "PageUp") {
      setDamper(S.damper + 25);
      e.preventDefault();
    } else if (e.key === "PageDown") {
      setDamper(S.damper - 25);
      e.preventDefault();
    } else if (e.key === "Home") {
      setDamper(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setDamper(100);
      e.preventDefault();
    }
  });
  el.damperEl.addEventListener("pointerdown", function (e) {
    el.damperEl.setPointerCapture(e.pointerId);
    damperDrag(e);
  });
  el.damperEl.addEventListener("pointermove", function (e) {
    if (e.buttons & 1) damperDrag(e);
  });

  function damperDrag(e) {
    var r = el.damperEl.querySelector(".damper-slot").getBoundingClientRect();
    setDamper(((e.clientX - r.left) / r.width) * 100);
  }

  // dump lever: press once lifts the sealed guard, press again pulls her
  el.dumpLever.addEventListener("click", function () {
    if (S.dumped) return;
    if (!el.dumpLever.classList.contains("guard-open")) {
      el.dumpLever.classList.add("guard-open");
      el.dumpLever.setAttribute(
        "aria-label",
        "Charge dump lever — guard lifted. Press again to PULL and dump the charge",
      );
      return;
    }
    el.dumpLever.classList.add("pulled");
    S.dumped = true;
    S.flags["CHARGE DUMPED"] = true;
    el.dumpLever.setAttribute(
      "aria-label",
      "Charge dump lever — pulled. The charge is in the drowning tank",
    );
    thud();
  });

  function thud() {
    if (!AC) return;
    var t = AC.currentTime;
    var o = AC.createOscillator(),
      g = AC.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.28);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(masterGain);
    o.start(t);
    o.stop(t + 0.45);
  }

  // bell cut
  el.bellCut.addEventListener("click", function () {
    bellCutOn = !bellCutOn;
    el.bellCut.setAttribute("aria-pressed", bellCutOn ? "true" : "false");
  });

  // flags
  el.flagsReset.addEventListener("click", function () {
    if (!(S.feedRate > 0.5 && S.draught < 0.12))
      S.flags["DRAUGHT LOST"] = false;
    if (!(S.chargeTempF >= FLAG_TEMP_F)) S.flags["TEMP HIGH"] = false;
    if (!(S.faults.air || (S.airArmed && S.airPsi < 32))) S.flags["AIR LOW"] = false;
    if (!(S.faults.brine || (S.feedRate > 0.5 && !S.brineOpen)))
      S.flags["BRINE LOW"] = false;
    if (!(effectiveFeedRate() > 34)) S.flags["FEED EXCESS"] = false;
    if (S.fume < 20) {
      S.flags["FUMED OUT"] = false;
      S.fumeLockout = false;
    }
    if (!S.dumped) S.flags["CHARGE DUMPED"] = false;
    if (!S.wrecked) S.flags["HOUSE LOST"] = false;
    gonged = {};
  });

  var proofTimer = null;
  function proof(on) {
    for (var f in el.flags) el.flags[f].classList.toggle("proof", on);
  }
  el.flagProof.addEventListener("pointerdown", function () {
    proof(true);
  });
  el.flagProof.addEventListener("pointerup", function () {
    proof(false);
  });
  el.flagProof.addEventListener("pointerleave", function () {
    proof(false);
  });
  el.flagProof.addEventListener("click", function () {
    proof(true);
    if (proofTimer) clearTimeout(proofTimer);
    proofTimer = setTimeout(function () {
      proof(false);
    }, 1200);
  });

  // proving tests double as the visitor's fault injection
  testBtns.brine.addEventListener("click", function () {
    setFault("brine", !S.faults.brine);
  });
  testBtns.air.addEventListener("click", function () {
    setFault("air", !S.faults.air);
  });
  testBtns.feed.addEventListener("click", function () {
    setFault("feed", !S.faults.feed);
  });

  // maintenance
  el.restoreBrine.addEventListener("click", function () {
    setFault("brine", false);
  });
  el.freeAgitator.addEventListener("click", function () {
    setFault("air", false);
  });
  el.resetFeedLimiter.addEventListener("click", function () {
    setFault("feed", false);
  });
  el.resetCharge.addEventListener("click", function () {
    window.machine.reset();
  });

  /* ------------- manual dialog ------------- */

  el.manualBtn.addEventListener("click", function () {
    if (typeof el.dialog.showModal === "function") el.dialog.showModal();
    else el.dialog.setAttribute("open", "");
  });
  el.closeManualBtn.addEventListener("click", function () {
    if (typeof el.dialog.close === "function") el.dialog.close();
    else el.dialog.removeAttribute("open");
  });

  /* ------------- gesture gate for sound ------------- */

  function gesture() {
    ensureAudio();
    document.removeEventListener("pointerdown", gesture);
    document.removeEventListener("keydown", gesture);
  }
  document.addEventListener("pointerdown", gesture);
  document.addEventListener("keydown", gesture);

  /* ------------- animation loop ------------- */

  var lastTs = null;
  var lastDt = 1 / 60;

  function frame(ts) {
    if (lastTs === null) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;
    lastDt = dt > 0 ? dt : 1 / 60;
    if (!document.hidden) {
      window.machine.tick(lastDt);
      render(ts / 1000);
    }
    requestAnimationFrame(frame);
  }

  buildAirTicks();
  buildThermoScale();
  buildSightScale();
  syncControlsToState();
  requestAnimationFrame(frame);
})();
