/* ============================================================
   Strathbraan Distillery — Spirit Still No. 2 Cutting Bench
   Simulation and behaviour. Still house, autumn 1968.
   ============================================================ */
(function () {
  "use strict";

  /* ----------------------------------------------------------
     Constants
     ---------------------------------------------------------- */
  var MACHINE_NAME = "Strathbraan Spirit Still No. 2";
  var FAULTS = [
    "condenser water loss",
    "priming carry-over",
    "excise seal broken",
  ];

  var AL = {
    HOT: "CONDENSER HOT",
    HIGH: "VAPOUR HIGH",
    PRIME: "PRIMING",
    LOW: "PARROT BELOW CUT",
    FULL: "RECEIVER FULL",
    SEAL: "EXCISE SEAL BROKEN",
    TRIP: "REGULATOR TRIPPED",
  };

  var ALARM_NAMES = [
    AL.HOT,
    AL.HIGH,
    AL.PRIME,
    AL.LOW,
    AL.FULL,
    AL.SEAL,
    AL.TRIP,
  ];

  var CAP = { foreshots: 90, spirit: 1100, feints: 1400 };
  var CHARGE_TARGET = 3200;
  var TANK_STOCK = 3400;
  var ETHANOL_BASE = 2000; // litres of recoverable spirits at full yield

  var TAP_ORDER = ["closed", "foreshots", "spirit", "feints"];
  var TAP_ANGLE = { closed: -46, foreshots: -15, spirit: 15, feints: 46 };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function r1(v) {
    return Math.round(v * 10) / 10;
  }

  /* Distillate strength from vapour-head temperature (piecewise). */
  var ABV_CURVE = [
    [70, 85],
    [74, 84],
    [77, 81],
    [79, 74],
    [81, 66],
    [84, 53],
    [88, 34],
    [92, 16],
    [96, 4],
    [101, 0.5],
  ];

  function abvAt(vt) {
    if (vt <= ABV_CURVE[0][0]) return ABV_CURVE[0][1];
    for (var i = 1; i < ABV_CURVE.length; i++) {
      if (vt <= ABV_CURVE[i][0]) {
        var a = ABV_CURVE[i - 1];
        var b = ABV_CURVE[i];
        var f = (vt - a[0]) / (b[0] - a[0]);
        return a[1] + f * (b[1] - a[1]);
      }
    }
    return 0.5;
  }

  /* ----------------------------------------------------------
     Simulation state
     ---------------------------------------------------------- */
  var S;

  function freshState() {
    return {
      phase: "cold", // cold|charging|ready|running|finished
      tankStock: TANK_STOCK,
      chargeL: 0,
      distilledTotal: 0,
      x: 1,
      potTemp: 12,
      vapourTemp: 12,
      steamWheel: 0, // 0..10 turns (operator)
      waterWheel: 0,
      steamPsi: 0,
      coolantFlow: 0,
      coolantOut: 11,
      eff: 1,
      rawRate: 0,
      rate: 0,
      parrot: 0,
      tap: "closed",
      cockOpen: false,
      recv: { foreshots: 0, spirit: 0, feints: 0 },
      cloudiness: 0,
      waterFault: false,
      standbyThrown: false,
      sealBroken: false,
      primingBias: false,
      primingDelay: 0,
      tripped: false,
      offGrade: false,
      offGradeTime: 0,
      hotSustain: 0,
      settle: 0,
      hotFromWatch: false,

      runSec: 0,
      clockSec: 0,
      cond: {},
      latch: {},
      accepted: {},
      losses: { vent: 0, overflow: 0, evap: 0 },
      supplyFactor: 1,
    };
  }
  S = freshState();

  /* ----------------------------------------------------------
     Core integration — deterministic, fixed sub-steps
     ---------------------------------------------------------- */
  function step(h) {
    var i, name;
    S.clockSec += h;

    /* ---- charging the still ---- */
    if (S.cockOpen && S.distilledTotal < 1) {
      var room = CHARGE_TARGET - S.chargeL;
      var take = Math.min(room, S.tankStock, 70 * h);
      S.tankStock -= take;
      S.chargeL += take;
      if (take > 0) S.phase = "charging";
      if (S.chargeL >= CHARGE_TARGET - 0.5 || S.tankStock <= 0.5) {
        S.cockOpen = false;
        if (S.phase === "charging") S.phase = "ready";
      }
    }

    /* ---- steam ---- */
    var steamEff = S.tripped ? 0 : S.steamWheel / 10;
    S.steamPsi =
      34 * steamEff +
      Math.sin(S.clockSec * 0.9) * 1.1 * steamEff +
      Math.sin(S.clockSec * 0.23) * 0.6 * steamEff;

    var boilTarget = Math.min(99.2, 88 + (1 - S.x) * 14);
    if (steamEff > 0.001) {
      var k = 0.004 + steamEff * 0.02;

      S.potTemp += (boilTarget - S.potTemp) * Math.min(1, k * h);
    } else {
      S.potTemp += (12 - S.potTemp) * Math.min(1, h / 260);
    }

    /* ---- ethanol remaining ---- */
    S.x = clamp(1 - S.distilledTotal / ETHANOL_BASE, 0, 1);

    /* ---- vapour head temperature ---- */
    if (S.potTemp >= 74) {
      var base = 75.5 + (1 - S.x) * 18.5;

      var drive = Math.max(0, steamEff - 0.62) * 9;
      var ineff = (1 - S.eff) * 6;
      var vtT = Math.min(104, base + drive + ineff);
      S.vapourTemp += (vtT - S.vapourTemp) * Math.min(1, h / 7);
    } else {
      S.vapourTemp += (S.potTemp - 5 - S.vapourTemp) * Math.min(1, h / 9);
    }

    /* ---- condenser cooling ---- */
    if (S.waterFault && !S.standbyThrown) {
      S.supplyFactor += (0.06 - S.supplyFactor) * Math.min(1, h / 4);
    } else {
      S.supplyFactor += (1 - S.supplyFactor) * Math.min(1, h / 3);
    }

    S.coolantFlow = (S.waterWheel / 10) * 20 * S.supplyFactor;
    var load = 0.15 + 3.1 * steamEff * (S.potTemp >= 74 ? 1 : 0.15);
    S.coolantOut = clamp(10.5 + (66 * load) / (3.5 + S.coolantFlow), 8, 58);
    S.eff =
      S.coolantOut <= 26 ? 1 : clamp(1 - (S.coolantOut - 26) / 10, 0.12, 1);

    /* ---- distillation ---- */
    var boiling = S.potTemp >= 76 && S.chargeL > 1;
    S.rawRate = 150 * steamEff * (boiling ? 1 : 0);

    S.rate = S.rawRate * S.eff;
    var dVol = (S.rate * h) / 60;
    if (dVol > 0) {
      var take2 = Math.min(dVol, S.chargeL);
      S.chargeL -= take2;
      S.distilledTotal += take2;
      S.runSec += h;
      if (S.phase === "ready") S.phase = "running";
    } else if (steamEff > 0.001) {
      S.runSec += h;
    }
    if (S.rawRate > 0.01 && S.eff < 1) {
      var vented = ((S.rawRate - S.rate) * h) / 60;
      S.losses.vent += vented;
      S.chargeL = Math.max(0, S.chargeL - vented); // uncondensed spirit is gone
    }
    if (
      S.distilledTotal >= ETHANOL_BASE - 40 ||
      (S.x <= 0.02 && S.rate < 0.05 && steamEff > 0)
    ) {
      if (S.phase === "running") S.phase = "finished";
    }

    /* ---- parrot hydrometer lag ---- */
    if (S.rate > 0.02) {
      var target = abvAt(S.vapourTemp);
      S.parrot += (target - S.parrot) * Math.min(1, h / 36);
    }

    /* ---- routing to receivers ---- */
    if (S.tap !== "closed" && S.rate > 0) {
      var add = (S.rate * h) / 60;
      var space = CAP[S.tap] - S.recv[S.tap];
      var moved = Math.min(add, Math.max(0, space));
      S.recv[S.tap] += moved;
      S.losses.overflow += add - moved;
    }
    if (
      S.tap !== "closed" &&
      S.recv[S.tap] >= CAP[S.tap] - 0.05 &&
      S.rate > 0
    ) {
      S.cond[AL.FULL] = true;
    } else {
      delete S.cond[AL.FULL];
    }

    /* ---- priming / carry-over ---- */
    if (S.primingDelay > 0) {
      S.primingDelay -= h;
      if (S.primingDelay <= 0) S.cond[AL.PRIME] = true;
    }
    if (S.primingBias) {
      if (S.potTemp > 85) {
        S.cloudiness += (0.5 + steamEff * 1.1) * h * 0.55;
      }
      /* throttling right back lets the charge settle */
      if (steamEff < 0.2) {
        S.settle += h;
      } else {
        S.settle = 0;
      }
      if (
        S.primingDelay <= 0 &&
        S.cond[AL.PRIME] &&
        S.settle > 20 &&
        S.cloudiness < 10
      ) {
        S.primingBias = false;
        S.settle = 0;
        delete S.cond[AL.PRIME];
      }
    } else {
      S.cloudiness -= h * 0.55;
      if (S.primingDelay <= 0) delete S.cond[AL.PRIME];
    }
    S.cloudiness = clamp(S.cloudiness, 0, 100);

    /* ---- conditional alarms ---- */
    /* CONDENSER HOT: the float watch on the burn supply, or real heat */
    var supplyWatch = S.waterFault && S.supplyFactor < 0.85 && !S.standbyThrown;
    if (supplyWatch || S.coolantOut >= 31) {
      S.cond[AL.HOT] = true;
      S.hotFromWatch = supplyWatch;
    } else if (!supplyWatch && S.coolantOut < 29) {
      delete S.cond[AL.HOT];
      S.hotFromWatch = false;
    }

    if (S.vapourTemp >= 86) S.cond[AL.HIGH] = true;
    if (S.vapourTemp < 83.5) delete S.cond[AL.HIGH];

    if (S.sealBroken) S.cond[AL.SEAL] = true;
    else delete S.cond[AL.SEAL];

    /* ---- trips (consequences of ignoring alarms) ---- */
    /* A spent charge always drives the head up; that is not a runaway. */
    S.hotSustain = S.coolantOut >= 38 ? S.hotSustain + h : 0;
    S.vapSustain = S.vapourTemp >= 95 && S.x > 0.12 ? S.vapSustain + h : 0;
    if (S.hotSustain > 22 || S.vapSustain > 28) {
      if (!S.tripped) {
        S.tripped = true;
        S.latch[AL.TRIP] = true;
        delete S.accepted[AL.TRIP];
      }
      S.hotSustain = 0;
      S.vapSustain = 0;
    }

    /* ---- housekeeping ---- */
    for (i = 0; i < ALARM_NAMES.length; i++) {
      name = ALARM_NAMES[i];
      if (!(name in S.cond) && !(name in S.latch)) delete S.accepted[name];
    }
    if (!S.sealBroken) delete S.accepted[AL.SEAL];
  }

  function tick(seconds) {
    var sec = clamp(Number(seconds) || 0, 0, 3600);
    var n = Math.max(1, Math.ceil(sec / 0.25));
    var h = sec / n;
    for (var i = 0; i < n; i++) step(h);
    return sec;
  }

  /* ----------------------------------------------------------
     Fixed API
     ---------------------------------------------------------- */
  function state() {
    var alarms = [];
    for (var i = 0; i < ALARM_NAMES.length; i++) {
      var n = ALARM_NAMES[i];
      if (n in S.cond || n in S.latch) alarms.push(n);
    }
    return {
      alarms: alarms,
      phase: S.phase,
      tankStockL: Math.round(S.tankStock),
      chargeLitres: Math.round(S.chargeL),
      distilledLitres: r1(S.distilledTotal),
      potTempC: r1(S.potTemp),
      vapourTempC: r1(S.vapourTemp),
      steamTurns: r1(S.steamWheel),
      steamPsi: r1(Math.max(0, S.steamPsi)),
      waterTurns: r1(S.waterWheel),
      coolantFlowLpm: r1(S.coolantFlow),
      coolingWaterOutC: r1(S.coolantOut),
      condensateLph: Math.round(S.rate * 60),
      parrotProofPct: r1(S.parrot),
      tap: S.tap,
      receivers: {
        foreshots: r1(S.recv.foreshots),
        spirit: r1(S.recv.spirit),
        feints: r1(S.recv.feints),
      },
      cloudinessPct: r1(S.cloudiness),
      runSeconds: r1(S.runSec),
      tripped: S.tripped,
      offGrade: S.offGrade,
      sealBroken: S.sealBroken,
      waterFault: S.waterFault,
      faultsInjected: [
        S.waterFault ? FAULTS[0] : null,
        S.primingBias ? FAULTS[1] : null,
        S.sealBroken ? FAULTS[2] : null,
      ].filter(Boolean),
      lossesLitres: {
        vented: r1(S.losses.vent),
        overflow: r1(S.losses.overflow),
        evaporation: r1(S.losses.evap),
      },
      spiritCollectedL: r1(S.recv.spirit),
      spiritGrade: S.offGrade ? "off-grade" : "in specification",
    };
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      S.waterFault = true;
    } else if (f === FAULTS[1]) {
      S.primingBias = true;
      S.primingDelay = 5;
    } else if (f === FAULTS[2]) {
      S.sealBroken = true;
      delete S.accepted[AL.SEAL];
    } else {
      throw new Error("unknown fault: " + fault);
    }
  }

  function reset() {
    var soundWasOn = ui.soundOn;
    S = freshState();
    S.supplyFactor = 1;
    ui.soundOn = soundWasOn;
    chartTrace.length = 0;
    lastSample = -1;
    syncControlsFromSim();
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ----------------------------------------------------------
     Chart recorder buffer
     ---------------------------------------------------------- */
  var chartTrace = [];
  var lastSample = -1;

  function sampleChart() {
    var whole = Math.floor(S.clockSec);
    if (whole !== lastSample) {
      lastSample = whole;
      chartTrace.push({ t: whole, vt: S.vapourTemp });
      if (chartTrace.length > 1000) chartTrace.shift();
    }
  }

  /* ----------------------------------------------------------
     UI wiring
     ---------------------------------------------------------- */
  var $ = function (id) {
    return document.getElementById(id);
  };

  var ui = {
    soundOn: false,
    holding: false,
    holdProgress: 0,
    guardOpen: false,
    lampsTestUntil: 0,
    selectedFault: "",
    hornOsc: null,
    humNodes: null,
  };

  var el = {};

  function cacheEls() {
    var ids = [
      "chgLiquid",
      "sgLiquid",
      "chgCard",
      "chargeFlow",
      "chargeCockLever",
      "stillLiquid",
      "stillCoil",
      "wisps",
      "vapourFlow",
      "steamFlowLine",
      "steamNeedle",
      "regLever",
      "vtColumn",
      "wormFlow",
      "coolInFlow",
      "outNeedle",
      "ventPlume",
      "parrotFloat",
      "safeDrip",
      "pilotJewel",
      "sealSwing",
      "sealCrack",
      "tapPointer",
      "legFo",
      "legSp",
      "legFe",
      "foLiquid",
      "spLiquid",
      "feLiquid",
      "foCard",
      "spCard",
      "feCard",
      "chartDisc",
      "injectBtn",
      "injectLamp",
      "steamTurnsRo",
      "waterTurnsRo",
    ];
    for (var i = 0; i < ids.length; i++) el[ids[i]] = $(ids[i]);
    el.dialog = document.querySelector("dialog[data-manual]");
    el.anns = {};

    var annList = document.querySelectorAll("[data-ann]");
    for (var j = 0; j < annList.length; j++) {
      el.anns[annList[j].getAttribute("data-ann")] = annList[j];
    }
  }

  /* ---- handwheels ---- */
  function makeWheel(wheelEl, roEl, getV, setV) {
    var spokes = wheelEl.querySelector(".spokes");
    var MAXT = 10;

    function paint() {
      var v = getV();
      spokes.style.transform = "rotate(" + v * 54 + "deg)";
      wheelEl.setAttribute("aria-valuenow", String(r1(v)));
      wheelEl.setAttribute("aria-valuetext", r1(v) + " turns");
      if (roEl) roEl.textContent = r1(v).toFixed(1);
    }

    function setFrom(ev) {
      var dx = ev.movementX || 0;
      var dy = ev.movementY || 0;
      if (dx || dy) {
        setV(clamp(getV() + (dx - dy) * 0.022, 0, MAXT));
        paint();
      }
    }

    wheelEl.addEventListener("pointerdown", function (e) {
      wheelEl.setPointerCapture(e.pointerId);
      var move = function (ev) {
        setFrom(ev);
      };
      var up = function () {
        wheelEl.removeEventListener("pointermove", move);
        wheelEl.removeEventListener("pointerup", up);
        wheelEl.removeEventListener("pointercancel", up);
      };
      wheelEl.addEventListener("pointermove", move);
      wheelEl.addEventListener("pointerup", up);
      wheelEl.addEventListener("pointercancel", up);
      e.preventDefault();
    });

    wheelEl.addEventListener("keydown", function (e) {
      var v = getV();
      var stepK = e.shiftKey ? 1 : 0.25;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        setV(clamp(v + stepK, 0, MAXT));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        setV(clamp(v - stepK, 0, MAXT));
      } else if (e.key === "PageUp") {
        setV(clamp(v + 1, 0, MAXT));
      } else if (e.key === "PageDown") {
        setV(clamp(v - 1, 0, MAXT));
      } else if (e.key === "Home") {
        setV(0);
      } else if (e.key === "End") {
        setV(MAXT);
      } else {
        return;
      }
      e.preventDefault();
      paint();
      sound.clack();
    });

    paint();
    return paint;
  }

  var paintSteamWheel, paintWaterWheel;

  /* ---- quarter-turn lever: charge cock ---- */
  function wireChargeCock() {
    var btn = document.querySelector('[data-control="CHARGE COCK"]');
    btn.addEventListener("click", function () {
      if (!S.cockOpen && S.chargeL > CHARGE_TARGET - 1) {
        return; // already full
      }
      S.cockOpen = !S.cockOpen;
      btn.setAttribute("aria-checked", S.cockOpen ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        "Charge cock: " + (S.cockOpen ? "open" : "closed"),
      );
      sound.clack();
    });
    el.syncChargeCock = function () {
      btn.setAttribute("aria-checked", S.cockOpen ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        "Charge cock: " + (S.cockOpen ? "open" : "shut"),
      );
    };
  }

  /* ---- guarded standby cock ---- */
  function wireStandby() {
    var box = document.querySelector('[data-control="STANDBY WATER COCK"]');
    var lid = box.querySelector(".guardLid");
    var lever = box.querySelector("[data-lever='standby']");

    lid.addEventListener("click", function () {
      ui.guardOpen = !ui.guardOpen;
      lid.setAttribute("aria-expanded", ui.guardOpen ? "true" : "false");
      lever.disabled = !ui.guardOpen;
      sound.clack();
    });
    lid.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        lid.click();
      }
    });

    lever.addEventListener("click", function () {
      if (lever.disabled) return;
      S.standbyThrown = !S.standbyThrown;
      lever.setAttribute("aria-checked", S.standbyThrown ? "true" : "false");
      lever.setAttribute(
        "aria-label",
        "Standby water cock: " + (S.standbyThrown ? "open" : "shut"),
      );
      sound.clack();
    });

    el.syncStandby = function () {
      lever.disabled = !ui.guardOpen;
      lever.setAttribute("aria-checked", S.standbyThrown ? "true" : "false");
    };
  }

  /* ---- safe tap radiogroup ---- */
  function wireTap() {
    var group = document.querySelector('[data-control="SAFE TAP"]');
    var posEls = Array.prototype.slice.call(group.querySelectorAll(".tapPos"));

    function select(tap) {
      S.tap = tap;
      for (var i = 0; i < posEls.length; i++) {
        var on = posEls[i].getAttribute("data-tap") === tap;
        posEls[i].setAttribute("aria-checked", on ? "true" : "false");
        posEls[i].tabIndex = on ? 0 : -1;
      }
      sound.clack();
    }

    posEls.forEach(function (b) {
      b.addEventListener("click", function () {
        select(b.getAttribute("data-tap"));
      });
      b.addEventListener("keydown", function (e) {
        var idx = TAP_ORDER.indexOf(S.tap);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          select(TAP_ORDER[Math.min(TAP_ORDER.length - 1, idx + 1)]);
          group.querySelector("[aria-checked='true']").focus();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          select(TAP_ORDER[Math.max(0, idx - 1)]);
          group.querySelector("[aria-checked='true']").focus();
        }
      });
    });

    el.syncTap = function () {
      for (var i = 0; i < posEls.length; i++) {
        var on = posEls[i].getAttribute("data-tap") === S.tap;
        posEls[i].setAttribute("aria-checked", on ? "true" : "false");
        posEls[i].tabIndex = on ? 0 : -1;
      }
    };
    el.syncTap();
  }

  /* ---- reseal hold button ---- */
  function wireReseal() {
    var btn = document.querySelector('[data-control="RESEAL SAFE"]');

    function begin(e) {
      if (e) e.preventDefault();
      ui.holding = true;
      btn.setPointerCapture && e && btn.setPointerCapture(e.pointerId);
    }
    function end() {
      ui.holding = false;
      if (ui.holdProgress < 1) ui.holdProgress = 0;
    }
    btn.addEventListener("pointerdown", begin);
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
    btn.addEventListener("pointerleave", end);
    btn.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && !ui.holding) begin(null);
    });
    btn.addEventListener("keyup", end);

    function resealTick(dt) {
      if (!ui.holding) {
        if (ui.holdProgress >= 1) ui.holdProgress = 0;
        return;
      }
      if (S.tap !== "closed") {
        ui.holdProgress = 0;
        return; // tap must be shut
      }
      if (!S.sealBroken && ui.holdProgress > 0.1) {
        ui.holdProgress = 0;
        return;
      }
      ui.holdProgress = Math.min(1, ui.holdProgress + dt / 2);
      if (ui.holdProgress >= 1 && S.sealBroken) {
        S.sealBroken = false;
        delete S.accepted[AL.SEAL];
        ui.holdProgress = 0;
        ui.holding = false;
        sound.stampSeal();
      }
    }
    ui.resealTick = resealTick;
  }

  /* ---- plain buttons ---- */
  function wireButtons() {
    document
      .querySelector('[data-control="ALARM ACCEPT"]')
      .addEventListener("click", function () {
        for (var i = 0; i < ALARM_NAMES.length; i++) {
          var n = ALARM_NAMES[i];
          if (n in S.cond || n in S.latch) S.accepted[n] = true;
        }
        sound.accept();
      });

    document
      .querySelector('[data-control="LAMPS TEST"]')
      .addEventListener("click", function () {
        ui.lampsTestUntil = performance.now() + 2000;
      });

    document
      .querySelector('[data-control="RUN RESET"]')
      .addEventListener("click", function () {
        window.machine.reset();
        ui.guardOpen = false;
        sound.clack();
      });

    /* fault test switches */
    var panel = document.querySelector('[data-control="FAULT TEST SWITCHES"]');
    var poss = Array.prototype.slice.call(panel.querySelectorAll(".fpPos"));
    poss.forEach(function (b) {
      b.addEventListener("click", function () {
        ui.selectedFault = b.getAttribute("data-fault") || "";
        poss.forEach(function (o) {
          o.setAttribute("aria-checked", o === b ? "true" : "false");
          o.tabIndex = o === b ? 0 : -1;
        });
      });
      b.addEventListener("keydown", function (e) {
        var idx = poss.indexOf(b);
        var next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown")
          next = poss[(idx + 1) % poss.length];
        if (e.key === "ArrowLeft" || e.key === "ArrowUp")
          next = poss[(idx - 1 + poss.length) % poss.length];
        if (next) {
          e.preventDefault();
          next.focus();
          next.click();
        }
      });
    });

    el.injectBtn.addEventListener("click", function () {
      if (!ui.selectedFault) return;
      window.machine.inject(ui.selectedFault);
      el.injectLamp.classList.add("fired");
      setTimeout(function () {
        el.injectLamp.classList.remove("fired");
      }, 900);
      sound.klaxonBlip();
    });
  }

  /* ---- sound cut ---- */
  function wireSound() {
    var bat = document.querySelector('[data-control="SOUND CUT"]');
    bat.addEventListener("click", function () {
      ui.soundOn = !ui.soundOn;
      bat.setAttribute("aria-checked", ui.soundOn ? "true" : "false");
      sound.setEnabled(ui.soundOn);
    });
  }

  /* ---- manual dialog ---- */
  function wireManual() {
    var opener = document.querySelector('[data-action="manual"]');
    var closer = document.querySelector('[data-action="close-manual"]');
    opener.addEventListener("click", function () {
      if (typeof el.dialog.showModal === "function") el.dialog.showModal();
      else el.dialog.setAttribute("open", "");
    });
    closer.addEventListener("click", function () {
      if (typeof el.dialog.close === "function") el.dialog.close();
      else el.dialog.removeAttribute("open");
    });
    el.dialog.addEventListener("click", function (e) {
      if (e.target === el.dialog) closer.click();
    });
  }

  function syncControlsFromSim() {
    S.steamWheel = 0;
    S.waterWheel = 0;
    if (paintSteamWheel) paintSteamWheel();
    if (paintWaterWheel) paintWaterWheel();
    if (el.syncChargeCock) el.syncChargeCock();
    if (el.syncStandby) el.syncStandby();
    if (el.syncTap) el.syncTap();
    ui.guardOpen = false;
    var lid = document.querySelector(".guardLid");
    if (lid) lid.setAttribute("aria-expanded", "false");
  }

  /* ----------------------------------------------------------
     Sound — Web Audio, silent until enabled after a gesture
     ---------------------------------------------------------- */
  var sound = {
    ctx: null,
    master: null,
    humGain: null,
    hissGain: null,

    ensure: function () {
      if (this.ctx) return true;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = ui.soundOn ? 0.5 : 0;
      this.master.connect(this.ctx.destination);

      /* plant hum */
      var hum = this.ctx.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 58;
      var hum2 = this.ctx.createOscillator();
      hum2.type = "sine";
      hum2.frequency.value = 117;
      this.humGain = this.ctx.createGain();
      this.humGain.gain.value = 0;
      hum.connect(this.humGain);
      hum2.connect(this.humGain);
      this.humGain.connect(this.master);
      hum.start();
      hum2.start();

      /* steam / worm hiss */
      var len = this.ctx.sampleRate * 2;
      var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var d = buf.getChannelData(0);
      var lastN = 0;
      for (var i = 0; i < len; i++) {
        var white = Math.random() * 2 - 1;
        lastN = (lastN + 0.04 * white) / 1.04;
        d[i] = lastN * 3;
      }
      var src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      var filt = this.ctx.createBiquadFilter();
      filt.type = "bandpass";
      filt.frequency.value = 2600;
      filt.Q.value = 0.6;
      this.hissGain = this.ctx.createGain();
      this.hissGain.gain.value = 0;
      src.connect(filt);
      filt.connect(this.hissGain);
      this.hissGain.connect(this.master);
      src.start();
      return true;
    },

    setEnabled: function (on) {
      if (on && !this.ensure()) {
        ui.soundOn = false;
        return;
      }
      if (!this.ctx) return;
      if (this.ctx.state === "suspended") this.ctx.resume();
      this.master.gain.setTargetAtTime(
        on ? 0.5 : 0,
        this.ctx.currentTime,
        0.08,
      );
    },

    ambience: function (steamEff, rate) {
      if (!this.ctx) return;
      var t = this.ctx.currentTime;
      this.humGain.gain.setTargetAtTime(0.05 + steamEff * 0.12, t, 0.4);
      this.hissGain.gain.setTargetAtTime(
        steamEff * 0.05 + Math.min(0.06, rate * 0.012),
        t,
        0.4,
      );
    },

    blip: function (freq, dur, type, vol) {
      if (!this.ctx || !ui.soundOn) return;
      var t = this.ctx.currentTime;
      var o = this.ctx.createOscillator();
      var g = this.ctx.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.02);
    },

    clack: function () {
      this.blip(190, 0.06, "square", 0.09);
    },
    accept: function () {
      this.blip(520, 0.09, "square", 0.08);
    },
    stampSeal: function () {
      this.blip(140, 0.16, "triangle", 0.16);
      var self = this;
      setTimeout(function () {
        self.blip(96, 0.2, "triangle", 0.14);
      }, 120);
    },
    klaxonBlip: function () {
      this.blip(620, 0.14, "sawtooth", 0.07);
    },

    horn: function (active) {
      if (!this.ctx) return;
      if (active && !this.hornOsc) {
        var o = this.ctx.createOscillator();
        var g = this.ctx.createGain();
        var lfo = this.ctx.createOscillator();
        var lg = this.ctx.createGain();
        o.type = "square";
        o.frequency.value = 420;
        lfo.type = "sine";
        lfo.frequency.value = 2.6;
        lg.gain.value = 130;
        lfo.connect(lg);
        lg.connect(o.frequency);
        g.gain.value = 0.055;
        o.connect(g);
        g.connect(this.master);
        o.start();
        lfo.start();
        this.hornOsc = { o: o, lfo: lfo, g: g };
      } else if (!active && this.hornOsc) {
        try {
          this.hornOsc.o.stop();
          this.hornOsc.lfo.stop();
        } catch (e) {
          /* already stopped */
        }
        this.hornOsc = null;
      }
    },
  };

  /* ----------------------------------------------------------
     Rendering
     ---------------------------------------------------------- */
  function setLiquid(rect, pct, yBottom, fullH) {
    var h = clamp(pct, 0, 1) * fullH;
    rect.setAttribute("height", String(h));
    rect.setAttribute("y", String(yBottom - h));
  }

  function rotEl(elm, deg) {
    elm.setAttribute("transform", "rotate(" + deg.toFixed(1) + ")");
  }

  function render(now) {
    var st = state();

    /* charge tank */
    var tankPct = st.tankStockL / TANK_STOCK;
    setLiquid(el.chgLiquid, tankPct, 333, 111);
    setLiquid(el.sgLiquid, tankPct, 324, 82);
    el.chgCard.textContent = st.tankStockL + " L";

    var pumping = S.cockOpen && st.tankStockL > 1;
    el.chargeFlow.setAttribute("opacity", pumping ? "1" : "0");
    rotEl(el.chargeCockLever, S.cockOpen ? -8 : 52);

    /* still */
    setLiquid(el.stillLiquid, st.chargeLitres / 3400, 327, 42);
    el.stillCoil.setAttribute(
      "opacity",
      String(clamp(st.steamTurns / 10, 0, 1) * 0.85),
    );
    el.wisps.setAttribute(
      "opacity",
      st.potTempC > 82 ? String(clamp((st.potTempC - 78) / 16, 0, 0.9)) : "0",
    );
    el.vapourFlow.setAttribute("opacity", st.vapourTempC > 72 ? "1" : "0");
    el.steamFlowLine.setAttribute(
      "opacity",
      st.steamTurns > 0.2 && !st.tripped ? "1" : "0",
    );
    rotEl(el.steamNeedle, -120 + clamp(st.steamPsi, 0, 60) * 4);
    rotEl(el.regLever, -70 + (st.tripped ? 0 : st.steamTurns * 14));

    var vt = clamp(st.vapourTempC, 58, 102);
    var colBottom = 73;
    var colTop = 63 - (vt - 60) * 2.2;

    var colBottom = 73;
    var colTop = 63 - (vt - 60) * 2.4;
    el.vtColumn.setAttribute("y", String(colTop));
    el.vtColumn.setAttribute("height", String(Math.max(0, colBottom - colTop)));

    /* condenser */
    var flowing = st.condensateLph > 3;
    el.wormFlow.setAttribute("opacity", flowing ? "1" : "0");
    el.coolInFlow.setAttribute("opacity", st.coolantFlowLpm > 0.4 ? "1" : "0");
    var outF = clamp((st.coolingWaterOutC * 1.8 + 32 - 40) / 80, 0, 1);
    rotEl(el.outNeedle, -110 + outF * 220);
    el.ventPlume.setAttribute(
      "opacity",
      st.condensateLph > 3 && st.coolingWaterOutC > 27
        ? String(clamp((st.coolingWaterOutC - 27) / 14, 0, 0.9))
        : "0",
    );

    /* spirit safe */
    el.safeDrip.setAttribute("opacity", flowing ? "1" : "0");
    var floatAbv = clamp(st.parrotProofPct, 54, 84);
    var dy = clamp((80 - floatAbv) * 1.9, -4, 44);

    el.parrotFloat.setAttribute(
      "transform",
      "translate(0," + clamp(dy, -2, 30).toFixed(1) + ")",
    );
    var pilotHot = flowing || now < ui.lampsTestUntil;
    el.pilotJewel.setAttribute("fill", pilotHot ? "#ffb24a" : "#3a1410");

    rotEl(el.sealSwing, st.sealBroken ? 16 : 0);
    el.sealCrack.setAttribute(
      "visibility",
      st.sealBroken ? "visible" : "hidden",
    );

    rotEl(el.tapPointer, TAP_ANGLE[st.tap]);
    el.legFo.setAttribute(
      "class",
      "legPipe" + (st.tap === "foreshots" && flowing ? " on" : ""),
    );
    el.legSp.setAttribute(
      "class",
      "legPipe" + (st.tap === "spirit" && flowing ? " on" : ""),
    );
    el.legFe.setAttribute(
      "class",
      "legPipe" + (st.tap === "feints" && flowing ? " on" : ""),
    );

    /* receivers */
    setLiquid(el.foLiquid, st.receivers.foreshots / CAP.foreshots, 128, 124);
    setLiquid(el.spLiquid, st.receivers.spirit / CAP.spirit, 128, 124);
    setLiquid(el.feLiquid, st.receivers.feints / CAP.feints, 128, 124);
    el.foCard.textContent = Math.round(st.receivers.foreshots) + " L";
    el.spCard.textContent = Math.round(st.receivers.spirit) + " L";
    el.feCard.textContent = Math.round(st.receivers.feints) + " L";

    /* annunciators */
    var testing = now < ui.lampsTestUntil;
    for (var i = 0; i < ALARM_NAMES.length; i++) {
      var name = ALARM_NAMES[i];
      var win = el.anns[name];
      if (!win) continue;
      var active = testing || st.alarms.indexOf(name) !== -1;
      win.classList.toggle("lit", active);
      win.classList.toggle(
        "flashing",
        active &&
          !testing &&
          st.alarms.indexOf(name) !== -1 &&
          !(name in S.accepted),
      );
    }

    /* horn */
    var hornNeeded = false;
    for (var j = 0; j < st.alarms.length; j++) {
      if (!(st.alarms[j] in S.accepted)) hornNeeded = true;
    }
    if (ui.soundOn) sound.horn(hornNeeded);
    else sound.horn(false);

    /* ambience */
    if (ui.soundOn) sound.ambience(st.steamTurns / 10, st.condensateLph);

    /* readouts */
    el.steamTurnsRo.textContent = st.steamTurns.toFixed(1);
    el.waterTurnsRo.textContent = st.waterTurns.toFixed(1);
  }

  /* ---- chart recorder ---- */
  function drawChart() {
    var c = el.chartDisc;
    var ctx2 = c.getContext("2d");
    var W = c.width;
    var cx = W / 2;
    var cy = W / 2 + 3;
    ctx2.clearRect(0, 0, W, W);

    /* disc face */
    ctx2.fillStyle = "#efe6cc";
    ctx2.beginPath();
    ctx2.arc(cx, cy, W / 2 - 4, 0, Math.PI * 2);
    ctx2.fill();

    /* rings + sectors */
    ctx2.strokeStyle = "rgba(90,70,40,0.5)";
    ctx2.lineWidth = 0.7;
    [20, 34, 48, 62].forEach(function (r) {
      ctx2.beginPath();
      ctx2.arc(cx, cy, r, 0, Math.PI * 2);
      ctx2.stroke();
    });
    for (var s = 0; s < 12; s++) {
      var a = (s / 12) * Math.PI * 2;
      ctx2.beginPath();
      ctx2.moveTo(cx + Math.cos(a) * 12, cy + Math.sin(a) * 12);
      ctx2.lineTo(cx + Math.cos(a) * 62, cy + Math.sin(a) * 62);
      ctx2.stroke();
    }

    /* trace: one revolution = 900 s of vapour temperature */
    ctx2.strokeStyle = "#6e1f14";
    ctx2.lineWidth = 1.4;
    ctx2.beginPath();
    for (var i = 0; i < chartTrace.length; i++) {
      var p = chartTrace[i];
      var ang = ((p.t % 900) / 900) * Math.PI * 2 - Math.PI / 2;
      var rr = 16 + clamp((p.vt - 60) / 40, 0, 1) * 46;
      var x = cx + Math.cos(ang) * rr;
      var y = cy + Math.sin(ang) * rr;
      if (i === 0) ctx2.moveTo(x, y);
      else ctx2.lineTo(x, y);
    }
    ctx2.stroke();

    /* pen arm */
    var cur = ((S.clockSec % 900) / 900) * Math.PI * 2 - Math.PI / 2;
    var rv = 16 + clamp((S.vapourTemp - 60) / 40, 0, 1) * 46;
    ctx2.strokeStyle = "#3a2c16";
    ctx2.lineWidth = 1.6;
    ctx2.beginPath();
    ctx2.moveTo(cx, cy);
    ctx2.lineTo(cx + Math.cos(cur) * rv, cy + Math.sin(cur) * rv);
    ctx2.stroke();
    ctx2.fillStyle = "#8f2c1e";
    ctx2.beginPath();
    ctx2.arc(
      cx + Math.cos(cur) * rv,
      cy + Math.sin(cur) * rv,
      2,
      0,
      Math.PI * 2,
    );
    ctx2.fill();
    ctx2.fillStyle = "#3a2c16";
    ctx2.beginPath();
    ctx2.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx2.fill();
  }

  /* ----------------------------------------------------------
     Main loop
     ---------------------------------------------------------- */
  var lastT = null;

  function frame(t) {
    if (lastT === null) lastT = t;
    var dt = Math.min(1.5, (t - lastT) / 1000);
    lastT = t;

    if (!document.hidden && dt > 0) {
      tick(dt);
      if (ui.resealTick) ui.resealTick(dt);
      sampleChart();
    }
    render(t);
    drawChart();
    window.requestAnimationFrame(frame);
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */
  function boot() {
    cacheEls();
    paintSteamWheel = makeWheel(
      document.querySelector('[data-control="STEAM REGULATOR"]'),
      el.steamTurnsRo,
      function () {
        return S.steamWheel;
      },
      function (v) {
        S.steamWheel = v;
      },
    );
    paintWaterWheel = makeWheel(
      document.querySelector('[data-control="CONDENSER WATER VALVE"]'),
      el.waterTurnsRo,
      function () {
        return S.waterWheel;
      },
      function (v) {
        S.waterWheel = v;
      },
    );
    wireChargeCock();
    wireStandby();
    wireTap();
    wireReseal();
    wireButtons();
    wireSound();
    wireManual();
    syncControlsFromSim();
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
