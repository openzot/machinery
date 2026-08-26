/* ============================================================
   MALAPERT OXYGEN WORKS — reactor train simulation & console
   behaviour. Consortium Standard 88-C. Vanilla script, IIFE,
   exposes window.machine = { name, faults, state, tick,
   inject, reset }.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- tunables ---------------- */

  var T_AMB = 21;
  var C_MASS = 42; // kJ/K equivalent — minutes, not hours, on this console
  var FEED_STEPS = [0, 6, 14, 22, 30]; // kg/min: CLOSED TRICKLE LOW NOMINAL FULL
  var FEED_NAMES = ["CLOSED", "TRICKLE", "LOW", "NOMINAL", "FULL"];
  var BLOWER_KW = [0, 14, 22, 32, 44];
  var BLOWER_FLOW = [0, 0.45, 0.7, 0.9, 1.1];
  var BANK_KW = { a: 120, b: 140, c: 160 };
  var AUX_KW = 14;
  var PURGE_KW = 70;
  var BUDGET_KW = 640;

  var DP_FLUIDISE = 7.5; // kPa minimum to hold the bed up
  var DP_HIGH = 16.5;
  var DP_CHANNEL = 19;
  var TEMP_BAND_LO = 980;
  var TEMP_IDEAL_LO = 1040;
  var TEMP_IDEAL_HI = 1095;
  var TEMP_HIGH = 1120;
  var TEMP_TRIP = 1160;
  var O2_FRACTION = 0.058; // kg oxygen per kg feed, ilmenite-rich mare basalt
  var POUR_KG_PER_PCTS = 2.6; // cosmetic kg/min mapping for the readout
  var DRYER_REGEN_S = 95;
  var HOPPER_MAX = 2400;

  /* ---------------- state ---------------- */

  var S;

  function freshState() {
    return {
      t: 0,
      breaker: false,
      charged: false, // recycle loop holds hydrogen
      chargeT: 0,
      mode: "COLD",
      bedTemp: T_AMB,
      bathPct: 0,
      castPct: 0,
      dust: 8, // % cyclone screen loading
      blindOffset: 0, // kPa false head from a blinded cyclone
      purity: -1, // -1 = no reading
      cols: {
        A: { duty: true, health: 1, wet: false },
        B: { duty: false, health: 1, wet: false },
      },
      feedIdx: 0,
      blower: 0,
      banks: { a: false, b: false, c: false },
      purgeHold: 0,
      purgeWasHeld: false,
      hopper: HOPPER_MAX,
      // taphole
      tapGuardOpen: false,
      cracked: false,
      seized: false,
      seizeProveT: 0,
      crackT: 0,
      sinterT: 0,
      reSeizeT: 0,
      tapNotch: 0,
      pourRate: 0,
      stallT: 0,
      stallAlarmT: 0,
      // casting
      castSwapT: 0,
      casts: 0,
      bricks: 0,
      spilled: false,
      spillKg: 0,
      bathFullT: 0,
      // products
      o2Rate: 0,
      oxygenT: 0,
      siteKw: 0,
      loadHighT: 0,
      shedStage: 0,
      bankCAutoOff: false,
      // protection
      tempHighT: 0,
      defluidT: 0,
      purityLowT: 0,
      floodT: 0,
      tripped: false,
      tripReason: "",
      faultSel: 0, // 0 OFF 1 CYC 2 DRY 3 TAP
      faultsActive: [],
      alarms: {
        load: { on: false, acked: false },
        dp: { on: false, acked: false },
        temp: { on: false, acked: false },
        h2: { on: false, acked: false },
        bath: { on: false, acked: false },
        stall: { on: false, acked: false },
        trip: { on: false, acked: false },
      },
    };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function approach(v, target, tau, dt) {
    return target + (v - target) * Math.exp(-dt / tau);
  }

  function alarm(name, key, cond) {
    var a = S.alarms[key];
    if (cond) {
      if (!a.on) a.acked = false;
      a.on = true;
    } else {
      a.on = false;
      a.acked = false;
    }
    return a.on;
  }

  function activeAlarmNames() {
    var out = [];
    if (S.alarms.load.on) out.push("site load high");
    if (S.alarms.dp.on) out.push("bed dp high");
    if (S.alarms.temp.on) out.push("bed temp high");
    if (S.alarms.h2.on) out.push("h2 purity low");
    if (S.alarms.bath.on) out.push("bath high");
    if (S.alarms.stall.on) out.push("tap stall");
    if (S.alarms.trip.on) out.push("reactor trip");
    return out;
  }

  /* ---------------- derived ---------------- */

  function live() {
    return S.breaker && !S.tripped;
  }

  function feedKgMin() {
    return FEED_STEPS[S.feedIdx];
  }

  function feedEff() {
    return live() ? FEED_STEPS[S.feedIdx] : 0;
  }

  function blowerEff() {
    return live() ? S.blower : 0;
  }

  function dpRaw() {
    var flow = BLOWER_FLOW[blowerEff()];
    /* a loaded screen raises the head the transmitter sees */
    var restriction = (17.5 + 8 * (S.dust / 100)) * flow;
    var bed = feedEff() * 0.05;
    var bathHead = S.bathPct > 85 ? 3.2 : 0;
    return Math.max(0, restriction - bed - bathHead);
  }

  function channelling() {
    return dpRaw() > DP_CHANNEL;
  }

  function effDP() {
    if (!fluidising()) return 0.12;
    return channelling() ? 0.5 : 1;
  }

  function dpShown() {
    return dpRaw() + S.blindOffset;
  }

  function fluidising() {
    return blowerEff() > 0 && dpRaw() >= DP_FLUIDISE;
  }

  function flowing() {
    return S.charged && blowerEff() > 0;
  }

  function effTemp(t) {
    if (t < 950) return 0;
    if (t < TEMP_IDEAL_LO) return (t - 950) / (TEMP_IDEAL_LO - 950);
    if (t <= TEMP_IDEAL_HI) return 1;
    if (t <= 1150) return 1 - ((t - TEMP_IDEAL_HI) / 55) * 0.4;
    return Math.max(0.15, 0.6 - (t - 1150) * 0.002);
  }

  function effPurity(p) {
    if (p < 0) return 0;
    if (p >= 95) return 1;
    if (p >= 88) return 0.85;
    if (p >= 78) return 0.45;
    return 0.15;
  }

  function dutyCol() {
    return S.cols.A.duty ? S.cols.A : S.cols.B;
  }

  function dryCap() {
    var c = dutyCol();
    if (c.wet) return 0.15;
    return c.health < 0.3 ? c.health / 0.3 : 1;
  }

  function heatLoss(t) {
    var feedTerm = 0.0095 * feedEff() * (t - 40);
    var conv = 0.05 * (t - T_AMB);
    var tk = t + 273;
    var rad = (4.75e-8 * tk * tk * tk * tk) / 1000;
    return feedTerm + conv + rad;
  }

  function heaterKw() {
    var kw = 0;
    if (!live()) return 0;
    if (S.banks.a) kw += BANK_KW.a;
    if (S.banks.b) kw += BANK_KW.b;
    if (S.banks.c && !S.bankCAutoOff) kw += BANK_KW.c;
    return kw;
  }

  function siteLoad() {
    var ely = Math.max(0, S.o2Rate) * 1.35;
    var purge = S.purgeWasHeld && S.breaker ? PURGE_KW : 0;
    return (
      heaterKw() +
      BLOWER_KW[blowerEff()] +
      AUX_KW +
      ely +
      purge +
      (S.shedStage >= 2 ? 0 : 0)
    );
  }

  /* ---------------- physics ---------------- */

  function step(dt) {
    var i, col;
    S.t += dt;

    /* charge the recycle loop when the bus is live */
    if (S.breaker && !S.charged) {
      S.chargeT += dt;
      if (S.chargeT > 2.5) {
        S.charged = true;
        S.purity = 96.5;
      }
    }

    /* dryer columns */
    for (i = 0; i < 2; i++) {
      col = i === 0 ? S.cols.A : S.cols.B;
      if (!col.duty) {
        col.health = Math.min(1, col.health + dt / DRYER_REGEN_S);
        if (col.wet && col.health >= 0.99) col.wet = false;
      }
    }

    /* gas side */
    var duty = dutyCol();
    if (S.charged) {
      var wload = (S.o2Rate / 3600) * 60 * 1.35; // kg/min water to absorb
      if (flowing()) {
        var deficit = wload * (1 - dryCap());
        if (duty.wet) deficit = Math.max(deficit, 1.05);
        S.purity = clamp(
          S.purity - deficit * 2.1 * dt + (96.5 - S.purity) * 0.05 * dt,
          40,
          99,
        );
      } else if (duty.wet) {
        S.purity = clamp(S.purity - 1.05 * dt, 40, 99);
      } else {
        S.purity = approach(S.purity, 96.5, 30, dt);
      }
    }

    /* feed & hopper */
    var fm = feedEff();
    if (fm > 0) {
      var draw = (fm * dt) / 60;
      var got = Math.min(draw, S.hopper);
      S.hopper -= got;
      if (got < draw) fm *= got / draw;
    }
    if (S.hopper < 420) S.hopper = Math.min(HOPPER_MAX, S.hopper + 9 * dt);

    /* reactor heat */
    var heat = heaterKw();
    S.bedTemp += ((heat - heatLoss(S.bedTemp)) / C_MASS) * dt;
    S.bedTemp = clamp(S.bedTemp, T_AMB - 2, 1650);

    /* dust & cyclone */
    if (flowing()) {
      S.dust = clamp(
        S.dust +
          0.011 *
            dt *
            (S.faultsActive.indexOf("cyclone blinding") >= 0 ? 6 : 1),
        0,
        100,
      );
    }
    if (S.purgeWasHeld && live()) {
      S.dust = clamp(S.dust - 4.5 * dt, 0, 100);
      S.blindOffset = Math.max(0, S.blindOffset - 6 * dt);
    } else if (S.blindOffset > 0) {
      S.blindOffset = Math.max(0, S.blindOffset - 0.08 * dt);
    }

    /* chemistry */
    var eff =
      effTemp(S.bedTemp) *
      effPurity(S.purity) *
      effDP() *
      (flowing() ? 1 : 0) *
      (fm > 0 && S.hopper > 0 ? 1 : 0);
    S.o2Rate = flowing() ? fm * 60 * O2_FRACTION * eff : 0;
    S.oxygenT += (S.o2Rate * dt) / 3600;

    /* bath & casting — percentages per second, tuned to the shift */
    var bathFill =
      [0, 0.28, 0.65, 1.0, 1.35][S.feedIdx] * (fm > 0 && S.hopper > 0 ? 1 : 0);
    S.bathPct = clamp(S.bathPct + bathFill * dt, 0, 104);

    var fluidity = clamp((S.bedTemp - 750) / 250, 0, 1);
    var drainRate = [0, 0.35, 0.75, 1][S.tapNotch] * 1.5 * fluidity;
    if (!S.cracked || S.seized || !live() || S.bathPct <= 0) drainRate = 0;
    if (S.castSwapT > 0 || S.castPct >= 100) drainRate = 0;
    S.pourRate = drainRate;

    var poured = drainRate * dt;
    S.bathPct = Math.max(0, S.bathPct - poured);
    var room = 100 - S.castPct;
    var intoCast = Math.min(poured * 2, room);
    S.castPct += intoCast;
    if (intoCast < poured * 2) {
      S.spilled = true;
      S.spillKg += (poured * 2 - intoCast) * 4.5;
      S.bricks = Math.max(0, S.bricks - 1);
    }

    if (S.castSwapT > 0) {
      S.castSwapT -= dt;
      if (S.castSwapT <= 0) S.castPct = 0;
    } else if (S.castPct >= 99.5 && S.tapNotch === 0) {
      S.casts += 1;
      S.bricks += Math.floor((S.castPct * 4.5) / 34);
      S.castSwapT = 5;
    }

    /* bath overdue protection */
    if (S.bathPct > 98) {
      S.bathFullT += dt;
      if (S.bathFullT > 15 && !S.tripped) trip("BATH FULL — TAP OVERDUE");
    } else {
      S.bathFullT = Math.max(0, S.bathFullT - dt);
    }

    /* taphole mechanics */
    if (S.seized) {
      S.stallAlarmT += dt;
    } else {
      S.stallAlarmT = 0;
    }
    if (S.cracked && S.tapNotch === 0 && S.bedTemp > 700 && !S.seized) {
      S.sinterT += dt;
      if (S.sinterT > 6) {
        S.cracked = false;
        S.sinterT = 0;
      }
    } else {
      S.sinterT = 0;
    }
    if (!S.seized && S.cracked && S.bedTemp < 850) {
      S.reSeizeT += dt;
      if (S.reSeizeT > 25) {
        S.seized = true;
        S.reSeizeT = 0;
      }
    } else if (!S.seized) {
      S.reSeizeT = 0;
    }

    /* taphole drill: an operator action held across time */
    if (!S.cracking || !S.tapGuardOpen) {
      S.crackT = 0;
    } else if (S.seized) {
      S.crackT += dt;
      if (S.crackT >= 3) {
        S.seized = false;
        var fix = S.faultsActive.indexOf("tap-hole freeze");
        if (fix >= 0) S.faultsActive.splice(fix, 1);
        S.crackT = 0;
        S.stallAlarmT = 0;
      }
    } else if (!S.cracked) {
      S.crackT += dt;
      if (S.crackT >= 1.6) {
        S.cracked = true;
        S.sinterT = 0;
        S.reSeizeT = 0;
        S.crackT = 0;
      }
    } else {
      S.crackT = 0;
    }

    /* protection timers */
    var over = siteLoad();
    S.siteKw = over;
    if (over > BUDGET_KW) {
      S.loadHighT += dt;
      if (S.loadHighT > 20 && S.shedStage < 1) {
        S.shedStage = 1;
        S.bankCAutoOff = true;
        S.banks.c = false;
      }
      if (S.loadHighT > 45 && !S.tripped) trip("SITE OVERLOAD — ARRAY BUDGET");
    } else {
      S.loadHighT = Math.max(0, S.loadHighT - dt * 2);
      if (S.loadHighT === 0 && S.shedStage === 1 && over < BUDGET_KW - 30) {
        S.shedStage = 0;
      }
    }

    if (S.bedTemp > TEMP_HIGH) {
      S.tempHighT += dt;
      if (S.tempHighT > 12 && !S.tripped) trip("BED OVERTEMPERATURE");
    } else {
      S.tempHighT = Math.max(0, S.tempHighT - dt);
    }

    if (flowing() && fm > 0 && (!fluidising() || channelling())) {
      S.defluidT += dt;
      S.bedTemp += 0.9 * dt * (S.bedTemp > 800 ? 1 : 0);
      if (S.defluidT > 18 && !S.tripped) trip("FLUIDISATION LOST");
    } else {
      S.defluidT = Math.max(0, S.defluidT - dt);
    }

    var purityBad = S.purity >= 0 && S.purity < 88;
    if (purityBad) {
      S.purityLowT += dt;
      if (S.purity < 75 && flowing()) {
        S.floodT += dt;
        if (S.floodT > 40 && !S.tripped) trip("ELECTROLYSER FLOOD");
      } else {
        S.floodT = Math.max(0, S.floodT - dt);
      }
    } else {
      S.purityLowT = Math.max(0, S.purityLowT - dt * 2);
      S.floodT = Math.max(0, S.floodT - dt);
    }

    if (S.seized && S.tapNotch > 0) {
      S.stallT += dt;
      if (S.stallT > 25 && !S.tripped) trip("TAPHOLE BLOCKED");
    } else {
      S.stallT = Math.max(0, S.stallT - dt);
    }

    /* alarms (monitoring circuits are battery-backed) */
    alarm("site load high", "load", S.siteKw > BUDGET_KW);
    alarm("bed dp high", "dp", dpShown() > DP_HIGH);
    alarm("bed temp high", "temp", S.bedTemp > TEMP_HIGH);
    alarm(
      "h2 purity low",
      "h2",
      wetSeenLong(dt) || (flowing() && S.purity >= 0 && S.purity < 88),
    );
    alarm("bath high", "bath", S.bathPct > 88 || S.spilled);
    alarm("tap stall", "stall", S.seized && S.stallAlarmT > 8);
    alarm("reactor trip", "trip", S.tripped);

    /* mode */
    S.mode = S.tripped
      ? "TRIPPED"
      : !S.breaker
        ? "COLD"
        : S.tapNotch > 0 && S.pourRate > 0
          ? "TAPPING"
          : fm > 0 && flowing()
            ? "REDUCING"
            : heaterKw() > 0
              ? "HEATING"
              : "STANDBY";
  }

  var wetSeen = 0;
  function wetSeenLong(dt) {
    var duty = dutyCol();
    if (duty.wet) {
      wetSeen += dt;
    } else {
      wetSeen = 0;
    }
    return wetSeen > 6;
  }

  function trip(reason) {
    S.tripped = true;
    S.tripReason = reason;
    S.banks.a = S.banks.b = S.banks.c = false;
    S.feedIdx = 0;
    S.blower = 0;
    S.tapNotch = 0;
    S.pourRate = 0;
  }

  /* ---------------- faults ---------------- */

  var FAULT_KEYS = [
    "cyclone blinding",
    "dryer breakthrough",
    "tap-hole freeze",
  ];

  function applyFault(key) {
    if (FAULT_KEYS.indexOf(key) < 0) return;
    if (S.faultsActive.indexOf(key) < 0) S.faultsActive.push(key);
    if (key === "cyclone blinding") {
      S.dust = clamp(S.dust + 34, 0, 100);
      S.blindOffset = Math.max(S.blindOffset, 17);
    } else if (key === "dryer breakthrough") {
      var c = dutyCol();
      c.wet = true;
      c.health = 0.06;
      wetSeen = 0;
    } else if (key === "tap-hole freeze") {
      S.seized = true;
      S.seizeProveT = 0;
    }
  }

  /* ---------------- public API ---------------- */

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return;
    var remaining = seconds;
    while (remaining > 0) {
      var dt = remaining > 0.5 ? 0.5 : remaining;
      step(dt);
      remaining -= dt;
    }
  }

  function state() {
    return {
      time: S.t,
      mode: S.mode,
      breakerOn: S.breaker,
      bedTemp: round(S.bedTemp, 1),
      bedDP: round(dpShown(), 2),
      dpTrue: round(dpRaw(), 2),
      fluidising: fluidising(),
      dustLoadPct: round(S.dust, 1),
      h2Purity: S.purity < 0 ? -1 : round(S.purity, 1),
      dryerDuty: S.cols.A.duty ? "A" : "B",
      dryerAHealth: round(S.cols.A.health, 3),
      dryerBHealth: round(S.cols.B.health, 3),
      dryerAWet: S.cols.A.wet,
      dryerBWet: S.cols.B.wet,
      feedIndex: S.feedIdx,
      feedName: FEED_NAMES[S.feedIdx],
      feedKgMin: round(feedKgMin(), 1),
      blowerNotch: S.blower,
      banks: { a: !!S.banks.a, b: !!S.banks.b, c: !!S.banks.c },
      bankCAutoOff: S.bankCAutoOff,
      hopperKg: round(S.hopper, 0),
      bathPct: round(S.bathPct, 1),
      plugSeized: S.seized,
      plugCracked: S.cracked,
      tapNotch: S.tapNotch,
      pourRatePctS: round(S.pourRate, 2),
      castKg: round(S.castPct * 4.5, 1),
      casts: S.casts,
      bricks: S.bricks,
      spilled: S.spilled,
      o2RateKgH: round(S.o2Rate, 2),
      oxygenTonnes: round(S.oxygenT, 3),
      siteLoadKw: round(S.siteKw, 0),
      budgetKw: BUDGET_KW,
      tripped: S.tripped,
      tripReason: S.tripReason,
      faultsActive: S.faultsActive.slice(),
      alarms: activeAlarmNames(),
    };
  }

  function round(v, d) {
    var f = Math.pow(10, d);
    return Math.round(v * f) / f;
  }

  function inject(fault) {
    applyFault(String(fault || "").toLowerCase());
  }

  function reset() {
    var guardTap = S ? S.tapGuardOpen : false;
    S = freshState();
    S.tapGuardOpen = guardTap;
    wetSeen = 0;
  }

  reset();

  window.machine = {
    name: "Malapert Oxygen Works — Reduction Reactor Console",
    faults: FAULT_KEYS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ==================== CONSOLE BEHAVIOUR ==================== */

  if (typeof document === "undefined") return;

  var $ = function (id) {
    return document.getElementById(id);
  };

  var ui = {
    clock: $("site-clock"),
    modeLamp: $("mode-lamp"),
    modeBlock: document.querySelector(".mode-block"),
    al: {
      load: $("al-load"),
      dp: $("al-dp"),
      temp: $("al-temp"),
      h2: $("al-h2"),
      bath: $("al-cast"),
      stall: $("al-stall"),
      trip: $("al-trip"),
    },
    ack: $("ack-btn"),
    sight: $("sight-port"),
    halo: $("port-halo"),
    bubbles: $("bed-bubbles"),
    pour: $("pour-stream"),
    slag: $("slag-fill"),
    castLabel: $("cast-label"),
    bricks: $("brick-stack"),
    brickNote: $("brick-note"),
    dustCake: $("dust-cake"),
    dustNote: $("dust-note"),
    dryerA: $("dryer-a"),
    dryerB: $("dryer-b"),
    hopperLevel: $("hopper-level"),
    hopperPct: $("hopper-pct"),
    feedFlow: $("feed-flow"),
    phCoils: [$("ph-coil-a"), $("ph-coil-b"), $("ph-coil-c")],
    phNote: $("ph-note"),
    bankMarks: { a: $("bm-a"), b: $("bm-b"), c: $("bm-c") },
    h2InFlow: $("h2-in-flow"),
    offgasFlow: $("offgas-flow"),
    dryerFlow: $("dryer-flow"),
    elyFlow: $("ely-flow"),
    o2Flow: $("o2-flow"),
    recycleFlow: $("recycle-flow"),
    plugPin: $("plug-pin"),
    plugState: $("plug-state"),
    crackLamp: $("crack-lamp"),
    rTemp: $("r-temp"),
    rDp: $("r-dp"),
    rH2: $("r-h2"),
    rO2: $("r-o2"),
    rKw: $("r-kw"),
    barTemp: $("bar-temp"),
    barDp: $("bar-dp"),
    barH2: $("bar-h2"),
    barO2: $("bar-o2"),
    barKw: $("bar-kw"),
    cellTemps: Array.prototype.slice.call(
      document.querySelectorAll(".cell.emissive"),
    ),
    drumO2: $("drum-o2"),
    drumCasts: $("drum-casts"),
    breaker: $("ctl-breaker"),
    bankGuard: $("bank-guard"),
    bankBtns: {
      a: $("ctl-bank-a"),
      b: $("ctl-bank-b"),
      c: $("ctl-bank-c"),
    },
    feed: $("ctl-feed"),
    feedKnob: $("feed-knob"),
    feedScale: $("feed-scale"),
    blower: $("ctl-blower"),
    blowerScale: document.querySelector(".lever-mount .lever-scale"),
    tapGuard: $("tap-guard"),
    tapControls: $("tap-controls"),
    crack: $("ctl-crack"),
    tapLever: $("ctl-tap"),
    tapScale: document.querySelector(".tap-scale"),
    purgeGuard: $("purge-guard"),
    purgeSet: document.querySelector(".purge-set"),
    purge: $("ctl-purge"),
    dryerKey: $("ctl-dryer"),
    faultSel: $("ctl-faultsel"),
    faultKnob: $("fault-knob"),
    faultScale: $("fault-scale"),
    injectBtn: $("ctl-inject"),
  };

  var FAULT_LABELS = ["OFF", "CYC", "DRY", "TAP"];
  var FAULT_MAP = [
    "",
    "cyclone blinding",
    "dryer breakthrough",
    "tap-hole freeze",
  ];

  /* ---- guards ---- */

  function bindGuard(btn, onOpen) {
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      btn.classList.toggle("open", !open);
      snd.click();
      if (onOpen) onOpen(!open);
    });
  }

  bindGuard(ui.bankGuard, function (open) {
    Object.keys(ui.bankBtns).forEach(function (k) {
      ui.bankBtns[k].disabled = !open;
    });
  });
  ui.bankGuard.setAttribute("aria-expanded", "false");

  bindGuard(ui.tapGuard, function (open) {
    S.tapGuardOpen = open;
    ui.crack.disabled = !open;
    ui.tapLever.disabled = !open;
    if (!open) {
      setTap(0);
      ui.tapLever.value = "0";
    }
  });
  ui.crack.disabled = true;
  ui.tapLever.disabled = true;

  bindGuard(ui.purgeGuard, function (open) {
    ui.purge.disabled = !open;
  });
  ui.purge.disabled = true;

  /* ---- site breaker ---- */

  ui.breaker.addEventListener("click", function () {
    if (S.tripped) return;
    S.breaker = !S.breaker;
    if (!S.breaker) {
      S.charged = false;
      S.chargeT = 0;
      S.banks.a = S.banks.b = S.banks.c = false;
      S.feedIdx = 0;
      S.blower = 0;
      ui.blower.value = "0";
    } else {
      S.purity = -1;
    }
    snd.relay();
  });

  /* ---- heater banks ---- */

  Object.keys(ui.bankBtns).forEach(function (k) {
    ui.bankBtns[k].addEventListener("click", function () {
      if (S.tripped) return;
      if (k === "c") S.bankCAutoOff = false;
      S.banks[k] = !S.banks[k];
      this.setAttribute("aria-pressed", String(S.banks[k]));
      snd.click();
    });
  });

  /* ---- feed rotary ---- */

  function setFeed(idx) {
    S.feedIdx = idx;
    ui.feedKnob.style.setProperty("--rot", idx * 74 - 148 + "deg");
    Array.prototype.forEach.call(ui.feedScale.children, function (b, i) {
      b.classList.toggle("at", i === idx);
    });
    ui.feed.setAttribute("aria-label", "Feed rate at " + FEED_NAMES[idx]);
  }

  ui.feed.addEventListener("click", function () {
    setFeed((S.feedIdx + 1) % FEED_STEPS.length);
    snd.click();
  });

  /* ---- blower quadrant ---- */

  function setBlower(n) {
    S.blower = n;
    Array.prototype.forEach.call(ui.blowerScale.children, function (b, i) {
      b.classList.toggle("at", i === n);
    });
    ui.blower.setAttribute(
      "aria-label",
      "Hydrogen recycle blower, notch " + n + " of 4",
    );
  }

  ui.blower.addEventListener("input", function () {
    setBlower(parseInt(ui.blower.value, 10) || 0);
    snd.hum(true);
  });

  /* ---- dryer keyswitch ---- */

  ui.dryerKey.addEventListener("click", function () {
    var aToB = S.cols.A.duty;
    S.cols.A.duty = !aToB;
    S.cols.B.duty = aToB;
    ui.dryerKey.classList.toggle("b", aToB);
    ui.dryerKey.setAttribute(
      "aria-label",
      "Dryer selector, column " + (aToB ? "B" : "A") + " on duty",
    );
    snd.relay();
  });

  /* ---- purge ---- */

  function purgeDown() {
    S.purgeWasHeld = true;
    ui.purge.classList.add("held");
  }

  function purgeUp() {
    S.purgeWasHeld = false;
    ui.purge.classList.remove("held");
  }

  ui.purge.addEventListener("pointerdown", purgeDown);
  window.addEventListener("pointerup", purgeUp);
  ui.purge.addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") purgeDown();
  });
  ui.purge.addEventListener("keyup", function (e) {
    if (e.key === " " || e.key === "Enter") purgeUp();
  });
  ui.purge.addEventListener("blur", purgeUp);

  /* ---- crack plug ---- */

  function crackDown() {
    S.cracking = true;
    ui.crack.classList.add("held");
  }

  function crackUp() {
    S.cracking = false;
    S.crackT = 0;
    ui.crack.classList.remove("held");
  }

  ui.crack.addEventListener("pointerdown", crackDown);
  window.addEventListener("pointerup", crackUp);
  ui.crack.addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") crackDown();
  });
  ui.crack.addEventListener("keyup", function (e) {
    if (e.key === " " || e.key === "Enter") crackUp();
  });
  ui.crack.addEventListener("blur", crackUp);
  /* audible confirmation when the plug gives */
  setInterval(function () {
    if (S._lastCracked !== S.cracked || S._lastSeized !== S.seized) {
      S._lastCracked = S.cracked;
      S._lastSeized = S.seized;
      snd.relay();
    }
  }, 120);

  /* ---- tap lever ---- */

  var TAP_NAMES = ["shut", "nip", "open", "full"];

  function setTap(n) {
    S.tapNotch = n;
    Array.prototype.forEach.call(ui.tapScale.children, function (b, i) {
      b.classList.toggle("at", i === n);
    });
    ui.tapLever.setAttribute("aria-label", "Tap lever, " + TAP_NAMES[n]);
  }

  ui.tapLever.addEventListener("input", function () {
    setTap(parseInt(ui.tapLever.value, 10) || 0);
    snd.click();
  });

  /* ---- fault sim ---- */

  function setFaultSel(i) {
    S.faultSel = i;
    ui.faultKnob.style.setProperty("--rot", i * 84 - 126 + "deg");
    Array.prototype.forEach.call(ui.faultScale.children, function (b, j) {
      b.classList.toggle("at", j === i);
    });
    ui.faultSel.setAttribute(
      "aria-label",
      "Fault selector at " + FAULT_LABELS[i],
    );
  }

  ui.faultSel.addEventListener("click", function () {
    setFaultSel((S.faultSel + 1) % FAULT_LABELS.length);
    snd.click();
  });

  ui.injectBtn.addEventListener("click", function () {
    var key = FAULT_MAP[S.faultSel];
    if (key) {
      applyFault(key);
      snd.alarmBlip();
    }
  });

  /* ---- ack ---- */

  ui.ack.addEventListener("click", function () {
    Object.keys(S.alarms).forEach(function (k) {
      if (S.alarms[k].on) S.alarms[k].acked = true;
    });
    if (S.tripped) {
      S.tripped = false;
      S.tripReason = "";
      S.bankCAutoOff = false;
      S.shedStage = 0;
    }
    if (!S.castSwapT || S.castSwapT <= 0) {
      /* an acknowledged spill is swept before the next cast */
      S.spilled = false;
      S.spillKg = 0;
    }
    snd.click();
  });

  /* ==================== SOUND ==================== */

  var snd = (function () {
    var ctx = null;
    var humGain = null;
    var hissGain = null;
    var ready = false;

    function init() {
      if (ctx) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        ctx = new AC();
        var master = ctx.createGain();
        master.gain.value = 0.14;
        master.connect(ctx.destination);

        /* blower hum: low sawtooth + filtered noise */
        humGain = ctx.createGain();
        humGain.gain.value = 0;
        var osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = 52;
        var lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 210;
        osc.connect(lp);
        lp.connect(humGain);
        humGain.connect(master);
        osc.start();

        /* pour hiss */
        hissGain = ctx.createGain();
        hissGain.gain.value = 0;
        var len = ctx.sampleRate * 1.2;
        var buf = ctx.createBuffer(1, len, ctx.sampleRate);
        var data = buf.getChannelData(0);
        for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        var noise = ctx.createBufferSource();
        noise.buffer = buf;
        noise.loop = true;
        var bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 3100;
        bp.Q.value = 0.7;
        noise.connect(bp);
        bp.connect(hissGain);
        hissGain.connect(master);
        noise.start();
        ready = true;
      } catch (e) {
        ctx = null;
      }
    }

    function unlock() {
      init();
      if (ctx && ctx.state === "suspended") ctx.resume();
    }

    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);

    return {
      hum: function () {
        if (!ready || !ctx) return;
        try {
          var g = S.blower > 0 && S.breaker ? 0.016 + S.blower * 0.011 : 0;
          humGain.gain.setTargetAtTime(g, ctx.currentTime, 0.25);
          if (ctx.state === "suspended") ctx.resume();
        } catch (e) {}
      },
      hiss: function (on) {
        if (!ready || !ctx) return;
        try {
          hissGain.gain.setTargetAtTime(on ? 0.05 : 0, ctx.currentTime, 0.12);
        } catch (e) {}
      },
      click: function () {
        blip(1600, 0.03, 0.12);
      },
      relay: function () {
        blip(340, 0.05, 0.2);
        setTimeoutSafe(function () {
          blip(240, 0.04, 0.14);
        }, 70);
      },
      alarmBlip: function () {
        blip(880, 0.12, 0.16);
        setTimeoutSafe(function () {
          blip(660, 0.12, 0.16);
        }, 160);
      },
    };

    function blip(freq, dur, vol) {
      if (!ready || !ctx) return;
      try {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "square";
        o.frequency.value = freq;
        g.gain.value = vol;
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + dur);
      } catch (e) {}
    }

    function setTimeoutSafe(fn, ms) {
      setTimeout(fn, ms);
    }
  })();

  /* ==================== RENDER ==================== */

  var bubblePool = [];
  for (var bi = 0; bi < 14; bi++) {
    var bc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bc.setAttribute("class", "bubble");
    bc.setAttribute("r", (1.6 + Math.random() * 2.2).toFixed(1));
    bc.setAttribute("visibility", "hidden");
    ui.bubbles.appendChild(bc);
    bubblePool.push({
      el: bc,
      x: 0,
      y: 0,
      v: 0,
    });
  }

  var flowPhase = {};
  function runFlow(el, speed, dt) {
    if (!el) return;
    if (speed <= 0.01) {
      el.style.opacity = "0";
      return;
    }
    el.style.opacity = "";
    flowPhase[el.id] = (flowPhase[el.id] || 0) - speed * dt * 46;
    el.setAttribute("stroke-dashoffset", (flowPhase[el.id] % 14).toFixed(2));
  }

  function meltColor(t) {
    function mix(a, b, f) {
      return Math.round(a + (b - a) * f);
    }
    if (t < 350) return "#181512";
    if (t < 700) {
      var f = (t - 350) / 350;
      return (
        "rgb(" +
        mix(24, 122, f) +
        "," +
        mix(20, 34, f) +
        "," +
        mix(18, 22, f) +
        ")"
      );
    }
    if (t < 1000) {
      var f2 = (t - 700) / 300;
      return (
        "rgb(" +
        mix(122, 236, f2) +
        "," +
        mix(34, 108, f2) +
        "," +
        mix(22, 38, f2) +
        ")"
      );
    }
    var f3 = clamp((t - 1000) / 200, 0, 1);
    return (
      "rgb(" +
      mix(236, 255, f3) +
      "," +
      mix(108, 196, f3) +
      "," +
      mix(38, 96, f3) +
      ")"
    );
  }

  function fmt(v, width, decimals) {
    var s = v.toFixed(decimals);
    while (s.length < width) s = "0" + s;
    return s;
  }

  function pad(str, n) {
    str = String(str);
    while (str.length < n) str = "0" + str;
    return str;
  }

  function render(dt) {
    var st = S;

    /* clock */
    var secs = 6 * 3600 + 20 * 60 + Math.floor(st.t);
    var hh = pad(Math.floor(secs / 3600) % 24, 2);
    var mm = pad(Math.floor(secs / 60) % 60, 2);
    var ss = pad(secs % 60, 2);
    ui.clock.textContent = hh + ":" + mm + ":" + ss;

    /* mode */
    ui.modeLamp.textContent = st.mode;
    if (ui.modeBlock)
      ui.modeBlock.setAttribute("data-mode", st.mode.toLowerCase());

    /* annunciators */
    var map = {
      load: st.alarms.load,
      dp: st.alarms.dp,
      temp: st.alarms.temp,
      h2: st.alarms.h2,
      bath: st.alarms.bath,
      stall: st.alarms.stall,
      trip: st.alarms.trip,
    };
    Object.keys(map).forEach(function (k) {
      var el = ui.al[k];
      var a = map[k];
      el.classList.toggle("alert", a.on && !a.acked && k !== "trip");
      el.classList.toggle("steady", a.on && (a.acked || k === "trip"));
    });

    /* readouts */
    ui.rTemp.textContent = String(Math.round(st.bedTemp));
    ui.rDp.textContent = dpShown().toFixed(1);
    ui.rH2.textContent = st.purity < 0 ? "——" : String(Math.round(st.purity));
    ui.rO2.textContent = st.o2Rate.toFixed(1);
    ui.rKw.textContent = String(Math.round(st.siteKw));

    setBar(ui.barTemp, (st.bedTemp / 1300) * 100, st.bedTemp > TEMP_HIGH);
    setBar(ui.barDp, (dpShown() / 22) * 100, dpShown() > DP_HIGH);
    setBar(
      ui.barH2,
      st.purity < 0 ? 0 : st.purity,
      st.purity >= 0 && st.purity < 88,
    );
    setBar(ui.barO2, (st.o2Rate / 100) * 100, false);
    setBar(ui.barKw, (st.siteKw / 720) * 100, st.siteKw > BUDGET_KW);

    warnCell(0, st.alarms.temp.on);
    warnCell(1, st.alarms.dp.on);
    warnCell(2, st.alarms.h2.on);
    warnCell(3, false);
    warnCell(4, st.alarms.load.on);

    /* drums */
    ui.drumO2.textContent = fmt(st.oxygenT, 7, 2);
    ui.drumCasts.textContent = pad(st.casts, 3);

    /* mimic: feed side */
    var hp = st.hopper / HOPPER_MAX;
    ui.hopperLevel.setAttribute("height", (hp * 48).toFixed(1));
    ui.hopperLevel.setAttribute("y", (94 - hp * 48).toFixed(1));
    ui.hopperPct.textContent = "HOPPER " + Math.round(hp * 100) + "%";
    var feedSpd = feedKgMin() / 30;
    runFlow(ui.feedFlow, feedSpd, dt);

    var bankKwArr = [
      st.banks.a ? 1 : 0,
      st.banks.b ? 1 : 0,
      st.banks.c && !st.bankCAutoOff ? 1 : 0,
    ];
    ui.phCoils[0].classList.toggle("hot", bankKwArr[0] === 1 && st.breaker);
    ui.phCoils[1].classList.toggle("hot", bankKwArr[1] === 1 && st.breaker);
    ui.phCoils[2].classList.toggle("hot", bankKwArr[2] === 1 && st.breaker);
    var totBanks = heaterKw();
    ui.phNote.textContent =
      st.breaker && totBanks > 0
        ? "COUNTERFLOW · " + Math.round(totBanks) + " kW"
        : "COUNTERFLOW · OFF";

    /* mimic: reactor */
    ui.sight.setAttribute("fill", meltColor(st.bedTemp));
    if (ui.halo) {
      ui.halo.setAttribute(
        "opacity",
        (clamp((st.bedTemp - 780) / 420, 0, 1) * 0.85).toFixed(2),
      );
    }

    var bubVisible = fluidising() && st.bedTemp > 600;
    for (var i = 0; i < bubblePool.length; i++) {
      var b = bubblePool[i];
      if (!bubVisible) {
        b.el.setAttribute("visibility", "hidden");
        continue;
      }
      if (b.v <= 0 || b.y < 150) {
        b.x = 448 + Math.random() * 114;
        b.y = 236 - Math.random() * 30;
        b.v = 14 + Math.random() * 26;
        b.el.setAttribute("r", (1.4 + Math.random() * 2.4).toFixed(1));
      }
      b.y -= b.v * dt;
      b.el.setAttribute("cx", b.x.toFixed(1));
      b.el.setAttribute("cy", b.y.toFixed(1));
      b.el.setAttribute("visibility", "");
      b.el.setAttribute(
        "opacity",
        clamp((b.y - 150) / 60, 0.15, 0.9).toFixed(2),
      );
    }

    ui.bankMarks.a.classList.toggle("on", bankKwArr[0] === 1 && st.breaker);
    ui.bankMarks.b.classList.toggle("on", bankKwArr[1] === 1 && st.breaker);
    ui.bankMarks.c.classList.toggle("on", bankKwArr[2] === 1 && st.breaker);

    var gasSpd = st.blower > 0 && st.charged ? BLOWER_FLOW[st.blower] : 0;
    runFlow(ui.h2InFlow, gasSpd, dt);
    runFlow(ui.offgasFlow, gasSpd * (fmNow() > 0 ? 1 : 0.4), dt);

    /* pour + cast */
    var pouring = st.pourRate > 0 && S.castSwapT <= 0;
    if (pouring) {
      ui.pour.setAttribute("d", "M618 244 Q 640 250 656 246");
      ui.pour.style.opacity = "1";
    } else {
      ui.pour.style.opacity = "0";
    }
    snd.hiss(pouring);

    var castPct = S.castPct / 100;
    var ch = castPct * 30;
    ui.slag.setAttribute("y", (250 - ch).toFixed(1));
    ui.slag.setAttribute("height", ch.toFixed(1));
    ui.castLabel.textContent =
      "CAST " + pad(Math.round(castPct * 100), 2) + "%";

    var bn = Math.min(st.bricks, 12);
    while (ui.bricks.childNodes.length > bn) {
      ui.bricks.removeChild(ui.bricks.lastChild);
    }
    while (ui.bricks.childNodes.length < bn) {
      var br = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      br.setAttribute("width", "16");
      br.setAttribute("height", "7");
      br.setAttribute("rx", "1");
      br.setAttribute("class", "shell");
      br.setAttribute("stroke-width", "1");
      ui.bricks.appendChild(br);
    }
    Array.prototype.forEach.call(ui.bricks.childNodes, function (el, idx) {
      var rowI = Math.floor(idx / 4);
      var colI = idx % 4;
      el.setAttribute("x", 780 + colI * 18 + (rowI % 2) * 4);
      el.setAttribute("y", 288 - rowI * 9);
    });
    ui.brickNote.textContent =
      "CASTING FLOOR · " +
      st.bricks +
      " BRICKS" +
      (st.spilled ? " · SPILL" : "");

    /* mimic: gas train */
    var dh = (st.dust / 100) * 26;
    ui.dustCake.setAttribute("height", dh.toFixed(1));
    ui.dustCake.setAttribute("y", (126 - dh).toFixed(1));
    ui.dustNote.textContent =
      "CYCLONE · " +
      (st.dust > 70 ? "BLINDED" : st.dust > 40 ? "LOADED" : "CLEAN");

    var da = S.cols.A,
      dbb = S.cols.B;
    ui.dryerA.classList.toggle("duty", da.duty);
    ui.dryerA.classList.toggle("regen", !da.duty && da.health < 0.98);
    ui.dryerB.classList.toggle("duty", dbb.duty);
    ui.dryerB.classList.toggle("regen", !dbb.duty && dbb.health < 0.98);

    runFlow(ui.dryerFlow, gasSpd, dt);
    runFlow(ui.elyFlow, gasSpd, dt);

    /* electrolyser bubbles */
    if (!render.elyPhase) render.elyPhase = [0, 0, 0];
    for (var eb = 1; eb <= 3; eb++) {
      var bel = document.getElementById("ely-bub-" + eb);
      if (!bel) continue;
      if (st.o2Rate > 1 && st.breaker) {
        render.elyPhase[eb - 1] -= dt * (14 + eb * 5);
        if (render.elyPhase[eb - 1] <= 0) render.elyPhase[eb - 1] = 66;
        var yy = 118 - ((66 - render.elyPhase[eb - 1]) % 66) * 0.95;
        bel.setAttribute("cx", (1026 + eb * 28).toFixed(1));
        bel.setAttribute("cy", yy.toFixed(1));
        bel.setAttribute("visibility", "");
        bel.setAttribute("opacity", "0.85");
      } else {
        bel.setAttribute("visibility", "hidden");
      }
    }
    runFlow(ui.o2Flow, st.o2Rate / 100, dt);
    runFlow(ui.recycleFlow, gasSpd * 0.8, dt);

    /* plug state */
    var ps;
    if (st.seized) ps = "PLUG SEIZED";
    else if (st.cracked)
      ps = st.bedTemp > 700 ? "PLUG CRACKED" : "PLUG CRACKED · COOLING";
    else ps = st.bedTemp < 700 ? "PLUG INTACT · COLD" : "PLUG INTACT";
    ui.plugState.textContent = ps;
    ui.plugState.classList.toggle("hot", st.cracked || st.seized);
    ui.plugPin.classList.toggle("free", st.cracked);
    ui.crackLamp.classList.toggle("on", !!st.cracking);
  }

  function fmNow() {
    return FEED_STEPS[S.feedIdx];
  }

  function setBar(el, pct, bad) {
    el.style.width = clamp(pct, 0, 100).toFixed(1) + "%";
    el.classList.toggle("over", !!bad);
  }

  function warnCell(idx, bad) {
    ui.cellTemps[idx].classList.toggle("warn", !!bad);
  }

  /* keep the drawn controls honest when the plant moves them */
  function syncControls() {
    if (parseInt(ui.blower.value, 10) !== S.blower)
      ui.blower.value = String(S.blower);
    if (parseInt(ui.tapLever.value, 10) !== S.tapNotch)
      ui.tapLever.value = String(S.tapNotch);
    if (ui.bankBtns.a.getAttribute("aria-pressed") !== String(!!S.banks.a))
      ui.bankBtns.a.setAttribute("aria-pressed", String(!!S.banks.a));
    if (ui.bankBtns.b.getAttribute("aria-pressed") !== String(!!S.banks.b))
      ui.bankBtns.b.setAttribute("aria-pressed", String(!!S.banks.b));
    if (ui.bankBtns.c.getAttribute("aria-pressed") !== String(!!S.banks.c))
      ui.bankBtns.c.setAttribute("aria-pressed", String(!!S.banks.c));
    Array.prototype.forEach.call(ui.feedScale.children, function (b, i) {
      b.classList.toggle("at", i === S.feedIdx);
    });
    if (
      (parseInt(ui.feedKnob.style.getPropertyValue("--rot"), 10) || 999) !==
      S.feedIdx * 74 - 148
    ) {
      ui.feedKnob.style.setProperty("--rot", S.feedIdx * 74 - 148 + "deg");
    }
  }

  /* ==================== MAIN LOOP ==================== */

  var last = performance.now();
  var raf = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = Math.min((now - last) / 1000, 0.5);
    last = now;
    tick(dt);
    syncControls();
    render(dt);
    snd.hum();
  }

  function start() {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else start();
  });

  /* ---- manual dialog ---- */

  var dlg = document.getElementById("manual-dialog");
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="manual"]'),
    function (btn) {
      btn.addEventListener("click", function () {
        if (dlg && !dlg.open) {
          dlg.showModal();
          snd.click();
        }
      });
    },
  );
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="close-manual"]'),
    function (btn) {
      btn.addEventListener("click", function () {
        if (dlg && dlg.open) dlg.close();
      });
    },
  );

  /* ---- initial control positions ---- */
  setFeed(0);
  setBlower(0);
  setTap(0);
  setFaultSel(0);
  start();
})();
