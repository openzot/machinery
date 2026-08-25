/* ============================================================
   REDMOSS TERMINAL - PIG RECEIVER No. 1
   machine.js - simulation, panel behaviour and fixed API.
   Classic script, no modules. All state inside the IIFE.
   ============================================================ */
(function () {
  "use strict";

  var MACHINE_NAME = "Redmoss Terminal - Pig Receiver No. 1";
  var FAULT_NAMES = [
    "pig stalls in the line",
    "inlet valve passing",
    "trap inlet signaller failure",
  ];

  /* ------------------------- plant constants ---------------- */
  var PFAR = 38.0; /* field-side line pressure, bar        */
  var PLANT = 27.5; /* plant-side sales pressure, bar       */
  var FLAREB = 0.02; /* flare back pressure, bar             */
  var BARREL_M3 = 12.0; /* receiver barrel capacity             */
  var ARRIVE_LIMIT = 14; /* arrestor capture limit, km/h         */
  var PROFILE_KM = 34.0;
  var SIM_SPEED = 12; /* animation: 1 real second = 12 sim s  */

  /* terrain of the profile strip, mirrors the svg polyline    */
  var TERRAIN = [
    [0, 84],
    [80, 76],
    [160, 88],
    [240, 70],
    [320, 82],
    [400, 64],
    [480, 76],
    [560, 60],
    [640, 74],
    [720, 56],
    [800, 70],
    [880, 62],
    [960, 78],
    [1040, 68],
    [1120, 84],
    [1200, 76],
  ];

  /* ----------------------------- state ---------------------- */
  var S = {};

  function cold() {
    S = {
      breaker: false,
      inlet: false,
      kicker: true /* bypass open, barrel off line      */,
      vent: false,
      drain: false,
      mlvTurns: 0 /* geared mainline valve, 0..10      */,
      ring: 0 /* 0 locked, 1 cracked, 2 open       */,
      doorOpen: false,

      rangeKm: 2.5,
      v: 0,
      prevRange: 2.5,
      flagS1: false,
      flagS2: false,
      headsDead: false,
      failTimer: 0,

      trapP: 0.0,
      liquids: 0.8,
      tankL: 0.2,

      pigIn: false,
      entryT: -1,
      extracted: false,

      pullHeld: false,
      pull: 0,

      faultStall: false,
      stallHead: 0,
      stallTimer: 0,
      stallLatched: false,
      clearTimer: 0,
      leakTimer: 0,
      dPdtSm: 0,
      lastTrapP: 0,
      inletPass: false,
      sawInletOpen: false,
      spillDone: false,

      active: {} /* alarm name -> true                */,
      accepted: {},
      sticky: {} /* damage / spill until CONSOLE RESET*/,

      elapsed: 0,
      ventFlow: 0,
      reliefFlow: 0,
      headerP: PFAR,
      status: "NO SUPPLY",
    };
  }
  cold();

  /* --------------------------- helpers ---------------------- */
  function $(id) {
    return document.getElementById(id);
  }
  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }
  function r1(x) {
    return Math.round(x * 10) / 10;
  }
  function r2(x) {
    return Math.round(x * 100) / 100;
  }

  function mlvPct() {
    return S.mlvTurns / 10;
  }

  /* how firmly the barrel is tied to the line: inlet valve
     times how far the geared mainline valve is open           */
  function tieIn() {
    if (!S.inlet) return 0;
    return 0.12 + 0.88 * mlvPct();
  }

  function alarm(name, on) {
    if (on) S.active[name] = true;
    else delete S.active[name];
  }

  /* ------------------------------ physics ------------------- */
  function tick(seconds) {
    var dt = clamp(Number(seconds) || 0, 0, 600);
    if (dt <= 0) return;
    S.elapsed += dt;

    var fric = 0.006 * S.v * S.v;
    S.headerP = PFAR - fric;

    /* ---- pig on the line ------------------------------------ */
    if (!S.pigIn && !S.extracted) {
      if (S.faultStall) {
        S.stallHead = Math.min(14, S.stallHead + dt * 0.7);
      } else {
        S.stallHead = Math.max(0, S.stallHead - dt * 1.2);
      }

      var pEnd = PLANT + fric;
      var pEff =
        tieIn() > 0.08 ? Math.min(pEnd, Math.max(S.trapP, FLAREB)) : pEnd;
      var dP = Math.max(0, PFAR - pEff - S.stallHead);
      var vTarget = 3.05 * Math.sqrt(dP);
      var tau = S.faultStall ? 6 : 18; /* stuck in liquid: she stops hard */
      S.v += (vTarget - S.v) * Math.min(1, dt / tau);

      S.prevRange = S.rangeKm;
      S.rangeKm = Math.max(0, S.rangeKm - (S.v * dt) / 3600);

      if (!S.flagS1 && S.rangeKm <= 2.0 && S.prevRange > 2.0 && !S.headsDead) {
        S.flagS1 = true;
      }

      /* liquid slug ahead of the pig comes over the last stretch */
      if (tieIn() > 0.1 && S.rangeKm < 0.55) {
        S.liquids = Math.min(
          BARREL_M3,
          S.liquids + 0.02 * dt * (1 + (0.55 - S.rangeKm)),
        );
      }

      if (S.rangeKm <= 0.0001) {
        S.rangeKm = 0;
        S.pigIn = true;
        S.entryT = 0;
        var hit = S.v;
        S.v = 0;
        if (!S.headsDead) S.flagS2 = true;
        if (hit > ARRIVE_LIMIT) {
          S.sticky["ARRESTOR DAMAGE"] = true;
          alarm("ARRESTOR DAMAGE", true);
        }
      }

      if (S.faultStall) {
        if (S.v < 0.4) {
          S.stallTimer += dt;
          S.stallLatched = true;
          S.clearTimer = 0;
        } else {
          S.stallTimer = 0;
        }
        /* she broke free - but only counts once she had truly stalled
           and has then kept rolling for a few seconds */
        if (S.stallLatched && S.v > 2) {
          S.clearTimer += dt;
          if (S.clearTimer > 4) setStallFault(false);
        } else {
          S.clearTimer = 0;
        }
      } else {
        S.stallTimer = 0;
      }
      alarm("PIG STALLED", S.faultStall && S.stallTimer > 8);
    } else {
      S.v = 0;
      alarm("PIG STALLED", false);
    }

    /* ---- barrel pressure ------------------------------------ */
    var o = tieIn();
    var ventRate = 0.5 * Math.sqrt(Math.max(0, S.trapP - FLAREB));
    S.ventFlow = S.vent ? ventRate : 0;

    /* the PSV is self-acting; the vent valve is not */
    S.reliefFlow = S.trapP > 34.9 ? 0.35 * (S.trapP - 34.9) : 0;

    var dTrap = 0;
    if (o > 0.02) {
      var target = PLANT + fric + (PFAR - PLANT) * Math.exp(-3.2 * o);
      dTrap = (target - S.trapP) * Math.min(1, dt * (0.05 + 0.35 * o));
    }
    /* an inlet seat that passes lets header gas creep in       */
    if (S.inletPass) {
      dTrap += 0.01 * Math.sqrt(Math.max(0, PFAR - S.trapP)) * dt;
    }

    var ventDrop = S.vent ? ventRate * dt : 0;
    S.trapP = clamp(S.trapP + dTrap - ventDrop - S.reliefFlow * dt, 0, 60);

    alarm("TRAP OVERPRESSURE", S.trapP >= 33.5);

    /* ---- liquids -------------------------------------------- */
    if (S.drain && S.liquids > 0) {
      var rate =
        0.05 *
        Math.sqrt(S.liquids / 3) *
        (0.25 + Math.min(S.trapP, 20) * 0.075);
      rate = Math.min(rate, S.liquids / Math.max(dt, 0.001));
      S.liquids -= rate * dt;
      S.tankL = Math.min(8, S.tankL + rate * dt);
    }
    /* ---- isolation watch ------------------------------------ */
    var allShut = !S.inlet && mlvPct() < 0.02 && !S.vent && !S.drain;
    var inst = allShut ? (S.trapP - S.lastTrapP) / dt : 0;
    S.lastTrapP = S.trapP;
    S.dPdtSm += (inst - S.dPdtSm) * Math.min(1, dt / 4);
    if (allShut && S.dPdtSm > 0.004 && S.trapP < PFAR - 1) {
      S.leakTimer += dt;
    } else {
      S.leakTimer = Math.max(0, S.leakTimer - dt * 2);
    }
    alarm("ISOLATION LEAK", S.leakTimer > 8);

    /* ---- signaller health ----------------------------------- */
    if (S.headsDead) {
      S.failTimer += dt;
    } else {
      S.failTimer = 0;
    }
    alarm("SIGNALLER FAIL", S.headsDead && S.failTimer > 16);

    /* ---- door and spill ------------------------------------- */
    if (S.ring < 2) S.doorOpen = false;
    if (S.doorOpen && !S.spillDone && S.liquids > 0.55) {
      S.spillDone = true;
      S.sticky["LIQUID SPILL"] = true;
      alarm("LIQUID SPILL", true);
    }

    /* ---- pig sliding into the barrel after capture ---------- */
    if (S.pigIn && S.entryT >= 0 && S.entryT < 1) {
      S.entryT = Math.min(1, S.entryT + dt / 2.2);
    }

    S.status = computeStatus();
  }

  /* pull progress runs on real seconds so holding feels right */
  function updatePull(dtReal) {
    if (S.pullHeld) {
      var canPull =
        S.doorOpen && S.pigIn && !S.sticky.ARRESTOR_DAMAGE && S.liquids < 0.25;
      S.pull = canPull
        ? Math.min(1, S.pull + dtReal / 2.5)
        : Math.max(0, S.pull - dtReal / 0.8);
      if (S.pull >= 1) {
        S.extracted = true;
        S.pigIn = false;
        S.pullHeld = false;
        S.pull = 0;
      }
    } else {
      S.pull = Math.max(0, S.pull - dtReal / 0.8);
    }
  }

  function setStallFault(on) {
    S.faultStall = on;
    if (!on) {
      S.stallHead = 0;
      S.stallTimer = 0;
      S.stallLatched = false;
      S.clearTimer = 0;
    }
  }

  function computeStatus() {
    if (!S.breaker) return "NO SUPPLY";
    if (S.extracted) return "RECEIPT COMPLETE";
    if (S.sticky["ARRESTOR DAMAGE"]) return "ARRESTOR DAMAGED";
    if (S.active["SIGNALLER FAIL"]) return "SIGNALLERS DEAD - USE DRUM";
    if (S.pigIn && S.doorOpen) return "BARREL OPEN";
    if (S.pigIn && S.trapP < 0.05) return "PROVED DEAD - PIN OUT";
    if (S.pigIn && S.vent) return "VENTING TO FLARE";
    if (S.pigIn && S.drain) return "DRAINING";
    if (S.pigIn) return "PIG IN TRAP - ISOLATE";
    if (S.rangeKm < 1.6) return "APPROACH - MIND THE ARRESTOR";
    if (tieIn() > 0.5) return "ON THROUGH FLOW";
    if (S.kicker) return "PLANT ON BYPASS";
    return "LINING UP";
  }

  function activeAlarmNames() {
    var names = [
      "TRAP OVERPRESSURE",
      "PIG STALLED",
      "SIGNALLER FAIL",
      "ISOLATION LEAK",
      "ARRESTOR DAMAGE",
      "LIQUID SPILL",
    ];
    var out = [];
    for (var i = 0; i < names.length; i++) {
      if (S.active[names[i]] || S.sticky[names[i]]) out.push(names[i]);
    }
    return out;
  }

  function anyUnacked() {
    for (var k in S.active) {
      if (S.active[k] && !S.accepted[k]) return true;
    }
    return false;
  }

  /* ---------------------------- controls -------------------- */

  function setLever(which, on) {
    if (which === "inlet") {
      S.inlet = on;
      if (on) S.sawInletOpen = true;
      else if (S.inletPass && S.sawInletOpen) {
        S.inletPass = false; /* stroked: the seat reseats  */
        S.sawInletOpen = false;
        S.dPdtSm = 0;
        S.leakTimer = 0;
      }
    }
    if (which === "kicker") S.kicker = on;
    if (which === "vent") S.vent = on;
    if (which === "drain") S.drain = on;
  }

  function turnWheel(dir) {
    S.mlvTurns = clamp(S.mlvTurns + dir, 0, 10);
  }

  function swingRing() {
    joltCrank();
    if (S.ring >= 2) {
      /* swinging back shut          */
      S.ring = 1;
      return;
    }
    if (S.trapP >= 0.05) return; /* pinned solid               */
    S.ring += 1;
    if (S.ring === 2) S.doorOpen = true;
  }

  function joltCrank() {
    var el = $("crankBtn");
    el.classList.remove("jolt");
    void el.offsetWidth;
    el.classList.add("jolt");
  }

  function acceptAlarms() {
    for (var k in S.active) {
      if (S.active[k]) S.accepted[k] = true;
    }
  }

  function resetAlarms() {
    for (var k in S.active) {
      if (!S.sticky[k]) {
        delete S.active[k];
        delete S.accepted[k];
      }
    }
  }

  function signallerReset() {
    S.headsDead = false;
    S.flagS1 = false;
    S.flagS2 = false;
    S.failTimer = 0;
    delete S.active["SIGNALLER FAIL"];
    delete S.accepted["SIGNALLER FAIL"];
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULT_NAMES[0]) setStallFault(true);
    else if (f === FAULT_NAMES[1]) {
      S.inletPass = true;
      S.sawInletOpen = false;
    } else if (f === FAULT_NAMES[2]) S.headsDead = true;
  }

  function apiReset() {
    cold();
  }

  /* ------------------------------ state() ------------------- */
  function state() {
    return {
      breaker: S.breaker,
      inletValve: S.inlet,
      kickerValve: S.kicker,
      mainlinePercent: r1(mlvPct() * 100),
      ventValve: S.vent,
      drainValve: S.drain,
      clampRing: ["LOCKED", "CRACKED", "OPEN"][S.ring],
      doorOpen: S.doorOpen,
      pigRangeKm: r2(S.rangeKm),
      pigSpeedKmh: r2(S.v),
      linePressureBar: r1(S.headerP),
      trapPressureBar: r2(S.trapP),
      liquidsM3: r2(S.liquids),
      drainTankM3: r2(S.tankL),
      pigInTrap: S.pigIn,
      pigExtracted: S.extracted,
      signallersOk: !S.headsDead,
      faultsActive: [
        S.faultStall ? FAULT_NAMES[0] : null,
        S.inletPass ? FAULT_NAMES[1] : null,
        S.headsDead ? FAULT_NAMES[2] : null,
      ].filter(Boolean),
      alarms: activeAlarmNames(),
      status: S.status,
      elapsedSimS: r1(S.elapsed),
    };
  }

  /* ============================ rendering ==================== */
  var els = {};
  function cacheEls() {
    els.lcdRange = $("lcdRange");
    els.lcdLineTrap = $("lcdLineTrap");
    els.lcdSpeed = $("lcdSpeed");
    els.lcdStatus = $("lcdStatus");
    els.beaconRig = document.querySelector(".beacon-rig");
    els.annstrip = document.querySelector(".annstrip");
    els.ann = {};
    var list = document.querySelectorAll(".ann");
    for (var i = 0; i < list.length; i++) {
      els.ann[list[i].getAttribute("data-ann")] = list[i];
    }
    els.drum = $("drumDigits");
    els.pigMark = $("pigMarker");
    els.flagS1 = $("flagS1");
    els.flagS2 = $("flagS2");
    els.lineNeedle = $("lineNeedle");
    els.trapNeedle = $("trapNeedle");
    els.barrelLiquid = $("barrelLiquid");
    els.glassLiquid = $("glassLiquid");
    els.tankLiquid = $("tankLiquid");
    els.pigBody = $("pigBody");
    els.flame = $("flareFlame");
    els.flowHeader = $("flowHeader");
    els.flowKick = $("flowKick");
    els.flowVent = $("flowVent");
    els.flowOutlet = $("flowOutlet");
    els.flowDrain = $("flowDrain");
    els.pinRect = $("pinRect");
    els.trapwrap = document.querySelector(".trapwrap");
    els.crankBtn = $("crankBtn");
    els.tommyArm = $("tommyArm");
    els.ringTag = $("ringTag");
    els.handwheel = $("handwheel");
    els.wheelBox = $("wheelBox");
    els.pullerBtn = $("pullerBtn");
    els.pullerShaft = $("pullerShaft");
    els.hs = {
      inlet: $("hsInlet"),
      kicker: $("hsKicker"),
      vent: $("hsVent"),
      drain: $("hsDrain"),
    };
    els.breaker = $("swBreaker");
  }

  function needleAngle(bar) {
    return -122 + (clamp(bar, 0, 60) / 60) * 244;
  }

  function terrainY(x) {
    for (var i = 1; i < TERRAIN.length; i++) {
      if (x <= TERRAIN[i][0]) {
        var a = TERRAIN[i - 1];
        var b = TERRAIN[i];
        var f = (x - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * f;
      }
    }
    return 76;
  }

  function render() {
    var st = state();

    els.lcdRange.textContent = st.pigExtracted
      ? "PIG OUT"
      : st.pigInTrap
        ? "IN ARRESTOR"
        : st.pigRangeKm.toFixed(2) + " KM";
    els.lcdLineTrap.textContent =
      st.linePressureBar.toFixed(1) +
      " / " +
      st.trapPressureBar.toFixed(2) +
      " B";
    els.lcdSpeed.textContent = st.pigSpeedKmh.toFixed(1) + " KMH";
    els.lcdStatus.textContent = S.breaker ? S.status : "NO SUPPLY";

    els.beaconRig.classList.toggle("alarm", anyUnacked());

    /* annunciators */
    var testing = els.annstrip.classList.contains("test");
    var ind = {
      POWER: S.breaker,
      "THROUGH BARREL": st.inletValve && st.mainlinePercent > 50,
      APPROACH:
        !st.pigInTrap && !st.pigExtracted && (st.pigRangeKm < 1.6 || S.flagS1),
      "PIG RECEIVED": st.pigInTrap,
      "RECEIPT COMPLETE": st.pigExtracted,
      "RING FREE": st.trapPressureBar < 0.05,
      "LIQUIDS HIGH": st.liquidsM3 > 3.4,
      "VENT TO FLARE": S.ventFlow > 0.004 || S.reliefFlow > 0,
      "TRAP OVERPRESSURE": st.trapPressureBar >= 33.5,
      "PIG STALLED": !!S.active["PIG STALLED"],
      "SIGNALLER FAIL": !!S.active["SIGNALLER FAIL"],
      "ISOLATION LEAK": !!S.active["ISOLATION LEAK"],
      "ARRESTOR DAMAGE": !!S.sticky["ARRESTOR DAMAGE"],
      "LIQUID SPILL": !!S.sticky["LIQUID SPILL"],
    };
    for (var name in els.ann) {
      var el = els.ann[name];
      var isActive = !!(S.active[name] || S.sticky[name]);
      el.classList.toggle("on", testing || !!ind[name]);
      el.classList.toggle("unacked", !testing && isActive && !S.accepted[name]);
    }

    /* drums and markers */
    els.drum.textContent =
      st.pigInTrap || st.pigExtracted ? "00.00" : st.pigRangeKm.toFixed(2);
    var px = clamp((st.pigRangeKm / PROFILE_KM) * 1200, 4, 1196);
    var py = terrainY(px);
    els.pigMark.setAttribute(
      "transform",
      "translate(" + px.toFixed(1) + "," + (py - 7).toFixed(1) + ")",
    );
    els.pigMark.style.opacity = st.pigInTrap || st.pigExtracted ? "0.15" : "1";
    els.flagS1.classList.toggle("fired", S.flagS1);
    els.flagS2.classList.toggle("fired", S.flagS2);

    /* gauges */
    els.lineNeedle.setAttribute(
      "transform",
      "rotate(" + needleAngle(st.linePressureBar).toFixed(1) + ")",
    );
    els.trapNeedle.setAttribute(
      "transform",
      "rotate(" + needleAngle(st.trapPressureBar).toFixed(1) + ")",
    );

    /* liquids */
    var lh = (st.liquidsM3 / BARREL_M3) * 92;
    els.barrelLiquid.setAttribute("y", (346 - lh).toFixed(1));
    els.barrelLiquid.setAttribute("height", Math.max(0, lh).toFixed(1));
    var gh = (st.liquidsM3 / BARREL_M3) * 88;
    els.glassLiquid.setAttribute("y", (92 - gh).toFixed(1));
    els.glassLiquid.setAttribute("height", Math.max(0, gh).toFixed(1));
    var th = (st.drainTankM3 / 8) * 36;
    els.tankLiquid.setAttribute("y", (468 - th).toFixed(1));
    els.tankLiquid.setAttribute("height", Math.max(0, th).toFixed(1));

    /* pig capsule */
    var pigX = 330;
    var showPig = st.pigInTrap && !st.pigExtracted;
    if (showPig) {
      var e = S.entryT < 0 ? 1 : S.entryT;
      var eased = 1 - Math.pow(1 - e, 3);
      pigX = 330 + eased * 430;
    }
    els.pigBody.setAttribute(
      "transform",
      "translate(" + pigX.toFixed(1) + ",300)",
    );
    els.pigBody.style.opacity = showPig ? "1" : "0";

    /* flame + flow dashes */
    var fl = clamp((S.ventFlow + S.reliefFlow) * 6, 0, 1);
    els.flame.setAttribute("opacity", (fl * 0.95).toFixed(2));
    els.flowVent.classList.toggle("flowing", fl > 0.02);
    var through = st.inletValve && st.mainlinePercent > 2;
    els.flowHeader.classList.toggle("flowing", through);
    els.flowOutlet.classList.toggle("flowing", through);
    els.flowKick.classList.toggle("flowing", st.kickerValve);
    els.flowDrain.classList.toggle(
      "flowing",
      st.drainValve && st.liquidsM3 > 0.02,
    );

    /* door + pin */
    els.trapwrap.classList.toggle("door-open", st.doorOpen);
    els.pinRect.setAttribute(
      "transform",
      st.trapPressureBar < 0.05 ? "translate(0,16)" : "translate(0,0)",
    );

    /* levers */
    setLeverView(els.hs.inlet, st.inletValve, false);
    setLeverView(els.hs.kicker, st.kickerValve, false);
    setLeverView(els.hs.vent, st.ventValve, false);
    setLeverView(els.hs.drain, st.drainValve, true);

    /* wheel */
    els.handwheel.style.setProperty("--turns", S.mlvTurns.toFixed(2));
    els.wheelBox.setAttribute(
      "aria-valuenow",
      String(Math.round(st.mainlinePercent)),
    );
    els.wheelBox.setAttribute(
      "aria-valuetext",
      "MAINLINE VALVE " +
        (st.mainlinePercent < 1
          ? "shut"
          : Math.round(st.mainlinePercent) + " percent open"),
    );

    /* crank */
    var ringNames = ["RING LOCKED", "RING CRACKED", "RING OPEN"];
    els.ringTag.textContent = ringNames[S.ring];
    var angles = [-32, 49, 130];
    els.tommyArm.style.setProperty("--ca", angles[S.ring] + "deg");
    els.crankBtn.classList.toggle("free", st.trapPressureBar < 0.05);
    els.crankBtn.setAttribute("aria-pressed", st.doorOpen ? "true" : "false");

    /* line-up card squares */
    var lu = [
      ["luInlet", st.inletValve],
      ["luKicker", st.kickerValve],
      ["luMlv", st.mainlinePercent > 1],
      ["luVent", st.ventValve],
      ["luDrain", st.drainValve],
    ];
    for (var li = 0; li < lu.length; li++) {
      var sq = document.getElementById(lu[li][0]);
      if (sq) sq.classList.toggle("on", !!lu[li][1]);
    }

    /* puller */
    els.pullerShaft.style.setProperty("--pull", S.pull.toFixed(2));
    els.pullerBtn.classList.toggle("holding", S.pull > 0.02);
  }

  function setLeverView(el, isOpen, vertical) {
    el.setAttribute("aria-pressed", isOpen ? "true" : "false");
    var deg = vertical ? (isOpen ? 90 : 0) : isOpen ? 0 : 90;
    var arm = el.querySelector(".arm");
    arm.style.setProperty("--ra", deg + "deg");
    arm.style.transform = "translate(-50%, -50%) rotate(" + deg + "deg)";
  }

  /* --------------------------- wiring ------------------------ */
  function wire() {
    document.querySelectorAll('[data-action="manual"]').forEach(function (b) {
      b.addEventListener("click", openManual);
    });
    $("btnCloseManual").addEventListener("click", closeManual);

    els.breaker.addEventListener("click", function () {
      S.breaker = !S.breaker;
      els.breaker.setAttribute("aria-checked", S.breaker ? "true" : "false");
    });

    els.hs.inlet.addEventListener("click", function () {
      setLever("inlet", !S.inlet);
    });
    els.hs.kicker.addEventListener("click", function () {
      setLever("kicker", !S.kicker);
    });
    els.hs.vent.addEventListener("click", function () {
      setLever("vent", !S.vent);
    });
    els.hs.drain.addEventListener("click", function () {
      setLever("drain", !S.drain);
    });

    $("nudgeOpen").addEventListener("click", function () {
      turnWheel(1);
    });
    $("nudgeShut").addEventListener("click", function () {
      turnWheel(-1);
    });
    els.wheelBox.addEventListener("keydown", function (e) {
      var used = true;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") turnWheel(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") turnWheel(-1);
      else if (e.key === "Home") S.mlvTurns = 10;
      else if (e.key === "End") S.mlvTurns = 0;
      else used = false;
      if (used) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    els.crankBtn.addEventListener("click", swingRing);

    var pullStart = function (e) {
      S.pullHeld = true;
      if (e && e.preventDefault) e.preventDefault();
    };
    var pullStop = function () {
      S.pullHeld = false;
    };
    els.pullerBtn.addEventListener("pointerdown", pullStart);
    window.addEventListener("pointerup", pullStop);
    window.addEventListener("pointercancel", pullStop);
    els.pullerBtn.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) pullStart(e);
    });
    els.pullerBtn.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") pullStop();
    });

    $("btnAccept").addEventListener("click", acceptAlarms);
    $("btnReset").addEventListener("click", resetAlarms);
    $("btnSignaller").addEventListener("click", signallerReset);
    $("btnConsole").addEventListener("click", function () {
      apiReset();
      syncAfterReset();
    });

    /* lamp test: hold */
    var lt = $("btnLampTest");
    var lampOn = function (e) {
      els.annstrip.classList.add("test");
      if (e && e.preventDefault) e.preventDefault();
    };
    var lampOff = function () {
      els.annstrip.classList.remove("test");
    };
    lt.addEventListener("pointerdown", lampOn);
    window.addEventListener("pointerup", lampOff);
    lt.addEventListener("pointerleave", lampOff);
    lt.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) lampOn(e);
    });
    lt.addEventListener("keyup", lampOff);

    /* guarded maintenance tests */
    document.querySelectorAll(".guardbox").forEach(function (box) {
      var guard = box.querySelector(".guard");
      var btn = box.querySelector("button");
      guard.addEventListener("click", function () {
        box.classList.toggle("open");
      });
      guard.addEventListener("keydown", function (e) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          box.classList.toggle("open");
        }
      });
      btn.addEventListener("click", function () {
        if (!box.classList.contains("open")) return; /* guarded */
        inject(btn.getAttribute("data-fault"));
      });
    });
    $("testStall").setAttribute("data-fault", FAULT_NAMES[0]);
    $("testInlet").setAttribute("data-fault", FAULT_NAMES[1]);
    $("testSignaller").setAttribute("data-fault", FAULT_NAMES[2]);

    /* kilometre ticks on the profile */
    var ticks = $("kmTicks");
    var NS = "http://www.w3.org/2000/svg";
    for (var km = 0; km <= 34; km += 2) {
      var x = (km / 34) * 1200;
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", x);
      ln.setAttribute("x2", x);
      ln.setAttribute("y1", 118);
      ln.setAttribute("y2", 124);
      ticks.appendChild(ln);
      if (km % 4 === 0) {
        var tx = document.createElementNS(NS, "text");
        tx.setAttribute("x", x);
        tx.setAttribute("y", 138);
        tx.setAttribute("text-anchor", "middle");
        tx.setAttribute("class", "svgtick");
        tx.textContent = String(km);
        ticks.appendChild(tx);
      }
    }
  }

  function syncAfterReset() {
    els.breaker.setAttribute("aria-checked", "false");
    els.annstrip.classList.remove("test");
    document.querySelectorAll(".guardbox.open").forEach(function (b) {
      b.classList.remove("open");
    });
  }

  /* --------------------------- manual dialog ----------------- */
  function openManual() {
    var d = $("manualDlg");
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }
  function closeManual() {
    var d = $("manualDlg");
    if (typeof d.close === "function") d.close();
    else d.removeAttribute("open");
  }

  /* --------------------------- main loop --------------------- */
  var last = null;
  function frame(now) {
    if (last === null) last = now;
    var dtReal = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!document.hidden) {
      tick(dtReal * SIM_SPEED);
      updatePull(dtReal);
    }
    render();
    window.requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    last = null;
  });

  /* --------------------------- fixed API --------------------- */
  window.machine = {
    name: MACHINE_NAME,
    faults: FAULT_NAMES.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: function () {
      apiReset();
      syncAfterReset();
    },
  };

  document.addEventListener("DOMContentLoaded", function () {
    cacheEls();
    wire();
    render();
    window.requestAnimationFrame(frame);
  });
})();
