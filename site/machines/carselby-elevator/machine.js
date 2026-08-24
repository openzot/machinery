/* ============================================================
   CARSELBY CO-OPERATIVE ELEVATOR - LEG HOUSE CONTROL
   Simulation and behaviour. Vanilla script, no modules.
   ============================================================ */
(function () {
  "use strict";

  var MACHINE_NAME = "Carselby Co-operative Elevator";
  var FAULTS = [
    "leg belt slip",
    "hot head-shaft bearing",
    "dryer flame failure",
  ];

  var ALARMS = [
    "HIGH BOOT",
    "LEG SLIP",
    "OVERLOAD",
    "BIN FULL",
    "DUST HIGH",
    "BEARING HEAT",
    "FLAME FAIL",
    "SCORCH",
    "VENT BLOWN",
  ];

  /* ---------------- constants ---------------- */

  var AMBIENT_F = 70;
  var AMBIENT_C = 22;
  var NOM_SPEED = 520; // ft/min belt speed
  var LIFT_FULL = 100; // bu/min at nominal speed
  var GATE_STEP = 12; // bu/min per gate notch
  var BIN_CAP = 3500;

  var S; // the whole simulated plant

  function freshState() {
    return {
      t: 0,
      breaker: false,
      legCmd: false, // start station latched
      legRunning: false,
      legSpeed: 0, // ft/min actual
      motorAmps: 0,
      motorHeat: 0, // seconds of overload stress / cooldown
      gate: 0, // 0..10 notches
      bootBu: 0, // grain waiting in the boot

      tension: 100, // belt tension, good 80..115
      slipFault: false,

      bearingC: AMBIENT_C,
      bearingSeized: false,
      oilSeconds: 0,
      bearingFault: false,

      distTarget: 0, // 0 = parked, 1..6 bins
      distPos: 0, // continuous position 0..6
      lastBinPassed: 0,
      settledBin: 0,

      bins: [0, 0, 0, 0, 0, 0],
      fullFlags: [false, false, false, false, false, false],

      scaleBu: 0,

      burnerValve: 0, // percent
      igniterHeld: false,
      flameOn: false,
      dryerF: AMBIENT_F,
      scorchTimer: 0,
      scorchTripped: false,
      scannerFault: false,
      eyeCleanSeconds: 0,
      eyeCleanHeld: false,

      fanMode: 0, // 0 off 1 low 2 high
      dust: 0, // oz per 1000 cu ft

      ventBlown: false,

      alarmsActive: {},
      alarmsAcked: {},
      hornCutFor: {},
      hornRinging: false,

      testSlip: false,
      testBearing: false,
      testFlame: false,

      lampsTestHeld: false,
      crankHeld: false,
      crankAngle: 0,
      oilHeld: false,
      lastLifted: 0,
      knockFlash: 0,
    };
  }

  /* ---------------- helpers ---------------- */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function raise(name) {
    S.alarmsActive[name] = true;
    if (!S.hornCutFor[name]) S.hornRinging = true;
  }

  function clear(name) {
    delete S.alarmsActive[name];
    delete S.alarmsAcked[name];
    delete S.hornCutFor[name];
  }

  function hasAlarms() {
    for (var k in S.alarmsActive) {
      if (Object.prototype.hasOwnProperty.call(S.alarmsActive, k)) return true;
    }
    return false;
  }

  function fireSource() {
    return S.bearingC > 125 || S.scorchTimer > 4;
  }

  /* ---------------- physics ---------------- */

  function step(h) {
    S.t += h;

    /* maintenance test switches hold the same defects */
    S.slipFault = S.slipFault || S.testSlip;
    S.bearingFault = S.bearingFault || S.testBearing;
    S.scannerFault = S.scannerFault || S.testFlame;

    /* ----- electrical ----- */
    var powered = S.breaker;
    var wantRun = powered && S.legCmd && !S.bearingSeized && S.motorHeat <= 0;

    var flood = clamp((S.bootBu - 26) / 30, 0, 1);
    var grip = clamp((S.tension - 30) / 55, 0, 1);
    if (!S.slipFault && S.tension >= 65) grip = Math.max(grip, 0.92);

    var target = wantRun ? NOM_SPEED * (0.35 + 0.65 * grip) : 0;
    var accel = wantRun ? 260 : 420;
    S.legSpeed = Math.max(
      0,
      S.legSpeed + clamp(target - S.legSpeed, -accel * h, accel * h),
    );
    S.legRunning = S.legSpeed > 40;

    var load = 6 + (S.legSpeed / NOM_SPEED) * 9 + flood * 17 + (1 - grip) * 7;
    S.motorAmps = S.legRunning ? load : powered ? 1.2 : 0;

    if (S.motorAmps > 36) {
      S.motorHeat += h;
      if (S.motorHeat > 6) {
        S.legCmd = false;
        S.motorHeat = 14;
        raise("OVERLOAD");
      }
    } else {
      S.motorHeat = Math.max(0, S.motorHeat - h * 0.75);
    }
    if (S.alarmsActive.OVERLOAD && S.motorHeat <= 0 && S.motorAmps <= 36)
      clear("OVERLOAD");

    /* ----- grain flow ----- */
    var feed = S.gate * GATE_STEP * (powered ? 1 : 0.15);
    var liftCap = Math.min(
      130,
      (S.legSpeed / NOM_SPEED) * LIFT_FULL * grip + S.bootBu * 0.3,
    );
    var lifted = Math.min(liftCap, feed + S.bootBu * 0.25);
    S.lastLifted = (S.lastLifted || 0) * 0.9 + lifted * 0.1;

    /* distributor routing: 0 means the head spout is between bins and
       the grain goes back down the return spout into the boot */
    var dir = S.distTarget - S.distPos;
    if (Math.abs(dir) > 0.002) {
      S.distPos = clamp(S.distPos + clamp(dir, -0.55 * h, 0.55 * h), 0, 6);
      var passed = Math.floor(S.distPos + (dir > 0 ? 0.001 : -0.001));
      if (passed !== S.lastBinPassed && passed >= 1 && passed <= 6) {
        S.lastBinPassed = passed;
        soundBell();
      }
      S.settledBin = 0;
    } else {
      S.distPos = S.distTarget;
      S.settledBin = S.distTarget;
      if (S.settledBin >= 1) S.lastBinPassed = S.settledBin;
    }
    var routing = S.settledBin;

    var overflow = lifted * h;
    if (routing >= 1) {
      var room = Math.max(BIN_CAP - S.bins[routing - 1], 0);
      var into = Math.min(overflow, room);
      S.bins[routing - 1] += into;
      S.fullFlags[routing - 1] = room - into < 12;
      overflow -= into;
    }
    /* return spout and bin overflow both go back to the boot */
    S.bootBu = clamp(S.bootBu + (feed - lifted) * h + overflow * 0.95, 0, 62);
    S.scaleBu = (S.scaleBu + lifted * h) % 100000;

    var binFullNow = false;
    for (var b = 0; b < 6; b++) if (S.fullFlags[b]) binFullNow = true;
    if (binFullNow) raise("BIN FULL");
    else clear("BIN FULL");

    /* ----- dryer ----- */
    if (S.scorchTripped) S.burnerValve = 0;
    var wantsFlame = S.burnerValve > 3 && powered && !S.scorchTripped;
    if (S.flameOn) {
      if (!wantsFlame || S.scannerFault) S.flameOn = false;
    } else if (wantsFlame && !S.scannerFault && S.igniterHeld) {
      S.flameOn = true;
    }
    var eq = AMBIENT_F + (S.flameOn ? S.burnerValve * 9.5 : 0) - lifted * 1.35;
    eq = Math.max(AMBIENT_F - 4, eq);
    S.dryerF += (eq - S.dryerF) * Math.min(1, 0.16 * h);

    if (S.dryerF > 620) {
      raise("SCORCH");
      S.scorchTimer += h;
      if (S.scorchTimer > 18) {
        S.scorchTripped = true;
        S.flameOn = false;
      }
    } else {
      S.scorchTimer = Math.max(0, S.scorchTimer - h * 2);
      if (S.dryerF < 590) clear("SCORCH");
      if (S.dryerF < 400 && S.scorchTripped && S.scorchTimer <= 0)
        S.scorchTripped = false;
    }

    /* ----- dust ----- */
    var dustMake = feed * 0.00025;
    if (S.legRunning) dustMake += 0.01 * (S.legSpeed / NOM_SPEED);
    if (routing === 0 && lifted > 0) dustMake += 0.008;
    if (binFullNow && lifted > 0) dustMake += 0.02;
    var fanPull = S.fanMode === 2 ? 0.06 : S.fanMode === 1 ? 0.02 : 0;
    S.dust = clamp(S.dust + (dustMake - fanPull) * h, 0, 0.6);
    if (S.dust >= 0.3) raise("DUST HIGH");
    else clear("DUST HIGH");

    /* ----- head-shaft bearing ----- */
    var heatRate = 0;
    if (S.bearingFault) heatRate += S.legRunning ? 2.6 : 1.9;
    else heatRate += S.legRunning ? 0.05 : -0.03;
    /* convection: a standing shaft sheds its heat, a turning one keeps it */
    heatRate -= (S.legRunning ? 0.15 : 0.8) * ((S.bearingC - AMBIENT_C) / 60);
    if (S.oilHeld) {
      heatRate -=
        (S.legRunning ? 1.1 : 2.6) * ((S.bearingC - AMBIENT_C) / 60) + 0.35;
      S.oilSeconds += h;
      if (S.bearingFault && S.oilSeconds >= 1.6) {
        S.bearingFault = false;
        S.oilSeconds = 0;
      }
    } else if (!S.bearingFault) {
      S.oilSeconds = 0;
    }
    S.bearingC = clamp(S.bearingC + heatRate * h, AMBIENT_C, 190);

    if (S.bearingC >= 140 && !S.bearingSeized) {
      S.bearingSeized = true;
      S.legCmd = false;
    }
    if (S.bearingSeized && S.bearingC < 88) S.bearingSeized = false;

    if (S.bearingC >= 85) raise("BEARING HEAT");
    else clear("BEARING HEAT");

    /* ----- belt take-up ----- */
    if (S.slipFault) {
      S.tension = clamp(S.tension - 5.5 * h, 12, 112);
      if (S.crankHeld && !S.legRunning)
        S.tension = clamp(S.tension + 13.5 * h, 12, 112);
      if (S.tension >= 96) S.slipFault = false; // stretch taken out of the belt
    } else if (S.crankHeld && !S.legRunning) {
      S.tension = clamp(S.tension + 11 * h, 0, 112);
    }
    S.crankAngle =
      (S.crankAngle + (S.crankHeld && !S.legRunning ? 320 * h : 0)) % 360;

    if ((S.slipFault && S.tension < 68) || S.tension < 58) raise("LEG SLIP");
    else clear("LEG SLIP");
    if (S.bootBu > 30) raise("HIGH BOOT");
    else clear("HIGH BOOT");

    /* ----- flame eye ----- */
    S.eyeCleanSeconds = S.eyeCleanHeld ? S.eyeCleanSeconds + h : 0;
    if (S.eyeCleanHeld && S.eyeCleanSeconds >= 0.9) {
      S.scannerFault = S.testFlame; // wiping restores the photocell
      S.eyeCleanSeconds = 0;
    }
    if (S.scannerFault) raise("FLAME FAIL");
    else clear("FLAME FAIL");

    /* ----- the consequence nobody wants ----- */
    if (!S.ventBlown && S.dust >= 0.3 && fireSource()) {
      S.ventBlown = true;
      S.legCmd = false;
      S.scorchTripped = true;
      S.flameOn = false;
      raise("VENT BLOWN");
    }
    if (S.ventBlown && S.dust < 0.3 && !fireSource()) clear("VENT BLOWN");

    if (!hasAlarms()) {
      S.hornRinging = false;
      S.hornCutFor = {};
    }
    S.knockFlash = Math.max(0, S.knockFlash - h);
  }

  /* ---------------- public API ---------------- */

  function tick(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s <= 0) return;
    var remaining = Math.min(s, 4000);
    while (remaining > 0.00001) {
      var h = remaining > 0.05 ? 0.05 : remaining;
      step(h);
      remaining -= h;
    }
  }

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === FAULTS[0]) {
      S.slipFault = true;
      S.testSlip = true;
    } else if (f === FAULTS[1]) {
      S.bearingFault = true;
      S.testBearing = true;
    } else if (f === FAULTS[2]) {
      S.scannerFault = true;
      S.testFlame = true;
    }
    syncTestButtons();
  }

  function reset() {
    S = freshState();
    syncTestButtons();
    stopHorn();
  }

  function state() {
    var alarms = [];
    for (var i = 0; i < ALARMS.length; i++) {
      if (S.alarmsActive[ALARMS[i]]) alarms.push(ALARMS[i]);
    }
    return {
      name: MACHINE_NAME,
      time: Math.round(S.t * 10) / 10,
      breaker: S.breaker,
      legRunning: S.legRunning,
      legSpeed: Math.round(S.legSpeed * 10) / 10,
      motorAmps: Math.round(S.motorAmps * 10) / 10,
      gate: S.gate,
      feedBuMin: Math.round(S.gate * GATE_STEP * 10) / 10,
      liftBuMin: Math.round((S.lastLifted || 0) * 10) / 10,
      bootBu: Math.round(S.bootBu * 10) / 10,
      beltTension: Math.round(S.tension),
      bearingTempC: Math.round(S.bearingC * 10) / 10,
      distributorTarget: S.distTarget,
      distributorPosition: Math.round(S.distPos * 100) / 100,
      settledBin: S.settledBin,
      bins: S.bins.map(function (v) {
        return Math.round(v);
      }),
      binFullFlags: S.fullFlags.slice(),
      scaleBushels: Math.round(S.scaleBu),
      burnerValve: S.burnerValve,
      flameOn: S.flameOn,
      dryerTempF: Math.round(S.dryerF),
      cycloneFan: ["off", "low", "high"][S.fanMode],
      dust: Math.round(S.dust * 1000) / 1000,
      ventBlown: S.ventBlown,
      bearingSeized: S.bearingSeized,
      scorchTripped: S.scorchTripped,
      tests: {
        slip: !!S.testSlip,
        bearing: !!S.testBearing,
        flame: !!S.testFlame,
      },
      alarms: alarms,
    };
  }

  /* ---------------- sound: gesture-gated ---------------- */

  var AC = null;
  var hornNodes = null;

  function ensureAudio() {
    if (AC) return AC;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) AC = new Ctx();
    } catch (e) {
      AC = null;
    }
    return AC;
  }

  function soundRelay() {
    var ac = ensureAudio();
    if (!ac || ac.state !== "running") return;
    try {
      var o = ac.createOscillator();
      var g = ac.createGain();
      o.type = "square";
      o.frequency.value = 76;
      g.gain.setValueAtTime(0.11, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.09);
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.1);
    } catch (e) {
      /* stay silent */
    }
  }

  function soundBell() {
    var ac = ensureAudio();
    if (!ac || ac.state !== "running") return;
    try {
      [1567, 2093].forEach(function (f, i) {
        var o = ac.createOscillator();
        var g = ac.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(i ? 0.05 : 0.13, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0008, ac.currentTime + 0.7);
        o.connect(g);
        g.connect(ac.destination);
        o.start();
        o.stop(ac.currentTime + 0.75);
      });
    } catch (e) {
      /* stay silent */
    }
  }

  function startHorn() {
    var ac = ensureAudio();
    if (!ac || hornNodes) return;
    try {
      var g = ac.createGain();
      g.gain.value = 0.05;
      var o1 = ac.createOscillator();
      var o2 = ac.createOscillator();
      o1.type = "sawtooth";
      o2.type = "sawtooth";
      o1.frequency.value = 233;
      o2.frequency.value = 293;
      o1.connect(g);
      o2.connect(g);
      g.connect(ac.destination);
      o1.start();
      o2.start();
      hornNodes = { o1: o1, o2: o2 };
    } catch (e) {
      /* stay silent */
    }
  }

  function stopHorn() {
    if (!hornNodes) return;
    try {
      hornNodes.o1.stop();
      hornNodes.o2.stop();
    } catch (e) {
      /* ignore */
    }
    hornNodes = null;
  }

  document.addEventListener(
    "pointerdown",
    function () {
      var ac = ensureAudio();
      if (ac && ac.state === "suspended") ac.resume();
    },
    { capture: true },
  );

  /* ---------------- dom wiring ---------------- */

  function $(id) {
    return document.getElementById(id);
  }

  var el = {};

  function holdButton(node, onDown, onUp) {
    function down(e) {
      e.preventDefault();
      node.setAttribute("data-held", "1");
      onDown();
    }
    function up() {
      if (node.getAttribute("data-held") !== "1") return;
      node.removeAttribute("data-held");
      onUp();
    }
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointerleave", up);
    node.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) down(e);
    });
    node.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") up();
    });
  }

  function makeSlider(node, opts) {
    function apply(v) {
      opts.set(clamp(v, opts.min, opts.max));
    }
    node.addEventListener("keydown", function (e) {
      var cur = opts.get();
      var big = e.key === "PageUp" || e.key === "PageDown";
      if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp") {
        apply(cur + opts.step * (big ? 2 : 1));
        e.preventDefault();
      } else if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowDown" ||
        e.key === "PageDown"
      ) {
        apply(cur - opts.step * (big ? 2 : 1));
        e.preventDefault();
      } else if (e.key === "Home") {
        apply(opts.min);
        e.preventDefault();
      } else if (e.key === "End") {
        apply(opts.max);
        e.preventDefault();
      }
    });
    var drag = null;
    node.addEventListener("pointerdown", function (e) {
      drag = { y: e.clientY, v: opts.get() };
      if (node.setPointerCapture) {
        try {
          node.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ok */
        }
      }
      e.preventDefault();
    });
    node.addEventListener("pointermove", function (e) {
      if (!drag) return;
      apply(drag.v + (drag.y - e.clientY) * opts.perPixel);
    });
    node.addEventListener("pointerup", function () {
      drag = null;
    });
    node.addEventListener("pointercancel", function () {
      drag = null;
    });
  }

  function bindControls() {
    el.breaker = $("c-breaker");
    el.start = $("c-start");
    el.stop = $("c-stop");
    el.gate = $("c-gate");
    el.gateArm = document.querySelector("#c-gate .lever-arm");
    el.roGate = $("ro-gate");
    el.distStuds = Array.prototype.slice.call(
      document.querySelectorAll(".dist-stud"),
    );
    el.spoutArm = $("spout-arm");
    el.burner = $("c-burner");
    el.burnerPtr = document.querySelector("#c-burner .knob-pointer");
    el.roBurner = $("ro-burner");
    el.igniter = $("c-igniter");
    el.eyeclean = $("c-eyeclean");
    el.accept = $("c-accept");
    el.horn = $("c-horn");
    el.lamps = $("c-lamps");
    el.resetBtn = $("c-reset");
    el.crank = $("c-crank");
    el.crankArm = $("crank-arm");
    el.knocker = $("c-knocker");
    el.oil = $("c-oil");
    el.testSlip = $("c-testslip");
    el.testBear = $("c-testbear");
    el.testFlame = $("c-testflame");
    el.regBushels = $("reg-bushels");
    el.cupTrain = $("cup-train");
    el.bootFill = $("boot-fill");
    el.thermoBearing = $("thermo-bearing");
    el.ventFlag = $("vent-flag");
    el.smoke = $("smoke");
    el.tensionWord = $("tension-word");
    el.lampPower = $("lamp-power");
    el.lampRun = $("lamp-run");
    el.lampTrip = $("lamp-trip");
    el.lampFlame = $("lamp-flame");
    el.roSpeed = $("ro-speed");
    el.roAmps = $("ro-amps");
    el.roFeed = $("ro-feed");
    el.roLift = $("ro-lift");
    el.roTemp = $("ro-temp");
    el.roDust = $("ro-dust");
    el.ann = {};
    [
      "highboot",
      "slip",
      "overload",
      "binfull",
      "dust",
      "bearing",
      "flamefail",
      "scorch",
      "vent",
    ].forEach(function (k) {
      el.ann[k] = $("ann-" + k);
    });
    el.binFill = [];
    el.binBu = [];
    el.binFull = [];
    for (var i = 1; i <= 6; i++) {
      el.binFill.push($("bin-fill-" + i));
      el.binBu.push($("bin-bu-" + i));
      el.binFull.push($("bin-full-" + i));
    }

    el.breaker.addEventListener("click", function () {
      S.breaker = !S.breaker;
      if (!S.breaker) S.legCmd = false;
      soundRelay();
    });

    el.start.addEventListener("click", function () {
      if (!S.breaker || S.bearingSeized || S.motorHeat > 0) return;
      S.legCmd = true;
      soundRelay();
    });
    el.stop.addEventListener("click", function () {
      S.legCmd = false;
      soundRelay();
    });

    makeSlider(el.gate, {
      min: 0,
      max: 10,
      step: 1,
      perPixel: 0.09,
      get: function () {
        return S.gate;
      },
      set: function (v) {
        S.gate = Math.round(clamp(v, 0, 10));
      },
    });

    el.distStuds.forEach(function (btn) {
      btn.addEventListener("click", function () {
        S.distTarget = Number(btn.getAttribute("data-pos"));
      });
    });

    el.fanButtons = Array.prototype.slice.call(
      document.querySelectorAll(".fan-pos"),
    );
    el.fanButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        S.fanMode = Number(btn.getAttribute("data-fan")) || 0;
      });
    });

    makeSlider(el.burner, {
      min: 0,
      max: 100,
      step: 5,
      perPixel: 0.7,
      get: function () {
        return S.burnerValve;
      },
      set: function (v) {
        S.burnerValve = Math.round(clamp(v, 0, 100) / 5) * 5;
      },
    });

    holdButton(
      el.igniter,
      function () {
        S.igniterHeld = true;
      },
      function () {
        S.igniterHeld = false;
      },
    );
    holdButton(
      el.eyeclean,
      function () {
        S.eyeCleanHeld = true;
      },
      function () {
        S.eyeCleanHeld = false;
      },
    );
    holdButton(
      el.lamps,
      function () {
        S.lampsTestHeld = true;
      },
      function () {
        S.lampsTestHeld = false;
      },
    );
    holdButton(
      el.crank,
      function () {
        S.crankHeld = true;
      },
      function () {
        S.crankHeld = false;
      },
    );
    holdButton(
      el.oil,
      function () {
        S.oilHeld = true;
      },
      function () {
        S.oilHeld = false;
      },
    );

    el.accept.addEventListener("click", function () {
      for (var k in S.alarmsActive) S.alarmsAcked[k] = true;
      S.hornRinging = false;
      stopHorn();
    });
    el.horn.addEventListener("click", function () {
      S.hornRinging = false;
      stopHorn();
      for (var k2 in S.alarmsActive) S.hornCutFor[k2] = true;
    });

    el.resetBtn.addEventListener("click", function () {
      S.ventBlown = false;
      S.scorchTripped = false;
      S.motorHeat = 0;
      S.bearingSeized = false;
      S.testSlip = false;
      S.testBearing = false;
      S.testFlame = false;
      S.slipFault = false;
      S.bearingFault = false;
      S.scannerFault = false;
      S.alarmsActive = {};
      S.alarmsAcked = {};
      S.hornCutFor = {};
      S.hornRinging = false;
      stopHorn();
      syncTestButtons();
      soundRelay();
    });

    el.knocker.addEventListener("click", function () {
      S.knockFlash = 0.6;
      if (S.bootBu > 24) S.bootBu -= 3; // frees bridged grain
      soundRelay();
    });

    function wireToggle(node, prop, faultProp) {
      node.addEventListener("click", function () {
        S[prop] = !S[prop];
        if (S[prop]) S[faultProp] = true;
        syncTestButtons();
      });
    }
    wireToggle(el.testSlip, "testSlip", "slipFault");
    wireToggle(el.testBear, "testBearing", "bearingFault");
    wireToggle(el.testFlame, "testFlame", "scannerFault");
  }

  function syncTestButtons() {
    if (!el || !el.testSlip) return;
    el.testSlip.setAttribute("aria-pressed", String(!!S.testSlip));
    el.testBear.setAttribute("aria-pressed", String(!!S.testBearing));
    el.testFlame.setAttribute("aria-pressed", String(!!S.testFlame));
  }

  /* ---------------- manual dialog ---------------- */

  function bindDialog() {
    var dlg = document.querySelector("dialog[data-manual]");
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-action="manual"]'),
      function (b) {
        b.addEventListener("click", function () {
          if (typeof dlg.showModal === "function") dlg.showModal();
          else dlg.setAttribute("open", "");
        });
      },
    );
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-action="close-manual"]'),
      function (b) {
        b.addEventListener("click", function () {
          if (typeof dlg.close === "function") dlg.close();
          else dlg.removeAttribute("open");
        });
      },
    );
  }

  /* ---------------- rendering ---------------- */

  function needleIn(container, frac) {
    var node = container.querySelector(".needle");
    if (!node) return;
    node.style.transform =
      "translate(0,-100%) rotate(" + (-122 + 242 * clamp(frac, 0, 1)) + "deg)";
  }

  function gauge(name, frac) {
    var host = document.querySelector('[data-gauge="' + name + '"]');
    if (host) needleIn(host, frac);
  }

  function annSet(key, name) {
    var node = el.ann[key];
    if (!node) return;
    var active = !!S.alarmsActive[name];
    var acked = !!S.alarmsAcked[name];
    node.classList.toggle("alarm", (active && !acked) || S.lampsTestHeld);
    node.classList.toggle(
      "acked",
      (active && acked && !S.lampsTestHeld) || S.lampsTestHeld,
    );
  }

  var cupOffset = 0;

  function render(dt) {
    var st = state();

    setJewel(el.lampPower, S.breaker || S.lampsTestHeld);
    setJewel(el.lampRun, st.legRunning || S.lampsTestHeld);
    setJewel(
      el.lampTrip,
      !!S.alarmsActive.OVERLOAD ||
        S.bearingSeized ||
        S.ventBlown ||
        S.lampsTestHeld,
    );
    setJewel(el.lampFlame, st.flameOn || S.lampsTestHeld);

    gauge("speed", st.legSpeed / 600);
    gauge("amps", st.motorAmps / 50);
    gauge("temp", (st.dryerTempF - 70) / 730);
    gauge("dust", st.dust / 0.6);
    gauge("tension", st.tension / 150);
    needleIn(document.querySelector(".scale-dial"), st.liftBuMin / 130);

    el.roSpeed.textContent = String(Math.round(st.legSpeed));
    el.roAmps.textContent = st.motorAmps.toFixed(1);
    el.roTemp.textContent = st.breaker ? String(st.dryerTempF) : "--";
    el.roDust.textContent = st.dust.toFixed(2);
    el.tensionWord.textContent =
      st.beltTension >= 80
        ? "TAKE-UP \u00b7 GOOD"
        : st.beltTension >= 58
          ? "TAKE-UP \u00b7 SOFT"
          : "BELT SLACK";

    el.regBushels.textContent = ("00000" + st.scaleBushels).slice(-5);
    el.roFeed.textContent = st.feedBuMin.toFixed(1);
    el.roLift.textContent = st.liftBuMin.toFixed(1);
    el.roGate.textContent = String(st.gate);
    el.roBurner.textContent = st.burnerValve + "%";

    el.gateArm.style.transform = "rotate(" + (-45 + 9 * st.gate) + "deg)";
    el.gate.setAttribute("aria-valuenow", String(st.gate));
    el.burnerPtr.style.transform =
      "rotate(" + (-135 + 2.7 * st.burnerValve) + "deg)";
    el.burner.setAttribute("aria-valuenow", String(st.burnerValve));
    el.breaker.setAttribute("aria-pressed", String(!!S.breaker));

    el.fanButtons.forEach(function (b) {
      var on = (Number(b.getAttribute("data-fan")) || 0) === S.fanMode;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });

    var ang = -90 + (180 / 7) * st.distributorPosition;
    el.spoutArm.style.transform = "rotate(" + ang + "deg)";
    el.distStuds.forEach(function (b) {
      b.classList.toggle(
        "is-live",
        Number(b.getAttribute("data-pos")) === st.settledBin &&
          st.settledBin > 0,
      );
    });

    var beltPx = (st.legSpeed / NOM_SPEED) * 130;
    cupOffset = (cupOffset + beltPx * dt) % 28;
    if (!isFinite(cupOffset)) cupOffset = 0;
    el.cupTrain.style.transform =
      "translateY(" + (-cupOffset).toFixed(2) + "px)";

    el.bootFill.style.height =
      (8 + 86 * clamp(st.bootBu / 62, 0, 1)).toFixed(1) + "%";
    el.thermoBearing.style.height =
      (6 + 88 * clamp((st.bearingTempC - AMBIENT_C) / 130, 0, 1)).toFixed(1) +
      "%";
    el.thermoBearing.style.background =
      st.bearingTempC > 110 ? "#ff6a4d" : st.bearingTempC > 85 ? "#e0972e" : "";
    el.smoke.classList.toggle(
      "show",
      st.bearingTempC > 120 || st.dryerTempF > 700,
    );
    el.ventFlag.classList.toggle("show", st.ventBlown);

    for (var i = 0; i < 6; i++) {
      var bu = st.bins[i];
      el.binFill[i].style.height = ((100 * bu) / BIN_CAP).toFixed(1) + "%";
      el.binBu[i].textContent = String(Math.round(bu));
      el.binFull[i].classList.toggle(
        "on",
        st.binFullFlags[i] || S.lampsTestHeld,
      );
    }

    annSet("highboot", "HIGH BOOT");
    annSet("slip", "LEG SLIP");
    annSet("overload", "OVERLOAD");
    annSet("binfull", "BIN FULL");
    annSet("dust", "DUST HIGH");
    annSet("bearing", "BEARING HEAT");
    annSet("flamefail", "FLAME FAIL");
    annSet("scorch", "SCORCH");
    annSet("vent", "VENT BLOWN");

    if (S.hornRinging && hasAlarms()) startHorn();
    else if ((!S.hornRinging || !hasAlarms()) && hornNodes) stopHorn();

    el.crankArm.style.transform = "rotate(" + S.crankAngle.toFixed(1) + "deg)";

    syncTestButtons();
  }

  function setJewel(node, on) {
    if (node) node.classList.toggle("on", !!on);
  }

  function buildCups() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 15; i++) frag.appendChild(document.createElement("i"));
    el.cupTrain.appendChild(frag);
  }

  /* ---------------- animation loop ---------------- */

  var lastStamp = null;
  var rafId = null;

  function loop(now) {
    rafId = null;
    if (lastStamp === null) lastStamp = now;
    var dt = (now - lastStamp) / 1000;
    lastStamp = now;
    if (dt > 0 && dt < 2) tick(dt);
    render(Math.min(Math.max(dt, 0.001), 0.1));
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId === null) {
      lastStamp = null;
      rafId = requestAnimationFrame(loop);
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      stopHorn();
    } else {
      startLoop();
    }
  });

  /* ---------------- boot ---------------- */

  reset();
  bindControls();
  bindDialog();
  buildCups();
  render(1 / 60);
  startLoop();

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };
})();
