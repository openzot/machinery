/* Koegors Crossing — Tunnel Ventilation & Incident Control.
   Provinciale Werken Vaarderland, plant room Noord, 1983.
   The desk keeps the air breathable, the road lit and the sump dry;
   the smoke-control key takes it all away in one motion. */
(function () {
  "use strict";

  /* ----------------------------- constants ----------------------------- */
  var BORE_L = 720; // m; positive airflow runs Zuid -> Noord
  var DRAG_K = 57; // N per (m/s)^2
  var JET_N = 350;
  var JETS_PER_GROUP = 2;
  var JET_KW = 26;
  var PX_PER_M = 1120 / 720;

  var FAULTS = [
    "jet fan seizure",
    "mains supply failure",
    "vehicle fire in bore",
  ];
  var GROUPS = ["A", "B", "C", "D"];
  var ALARM_NAMES = [
    "CO HIGH",
    "VIS POOR",
    "AIRFLOW LOW",
    "FAN TRIP",
    "SUMP HIGH",
    "POWER FAIL",
    "FIRE DETECTED",
    "AUTOMATIC CLOSURE",
  ];

  /* ----------------------------- desk state ---------------------------- */
  var desk = {
    t: 0,
    supply: true,
    ventMode: "off", // off | auto | hand | test
    paddles: [0, 0, 0, 0], // -1 reverse | 0 auto/law | 1 normal
    pumpMode: "auto",
    lever: 0, // 0 green | 1 amber | 2 red
    zones: [true, true, false, false],
    keyGuarded: true,
    keyTurned: false,
    hornCut: false,
    lampTest: false,
    handRunHeld: false,
    flushHeld: false,
    faults: { seizure: false, mainsfail: false, fireSwitch: false },
  };

  var sim = {
    q: 2400,
    queue: 0,
    v: 0,
    co: 4,
    extK: 2,
    tempC: 14,
    sumpPct: 12,
    pumpsRunning: [false, false],
    fanRun: [false, false, false, false],
    fanDir: [1, 1, 1, 1],
    fanTripped: [false, false, false, false],
    bearing: [22, 22, 22, 22],
    locked: [false, false, false, false],
    mainsOk: true,
    fire: {
      active: false,
      fuel: 100,
      intensity: 0,
      rampUp: 0,
      burntOut: false,
    },
    closure: false,
    lawStage: 0,
    lawTarget: 0,
    pumpsLatched: false,
  };

  var timers = {
    coHold: 0,
    visHold: 0,
    fireBigHold: 0,
    airLowHold: 0,
    calmHold: 0,
    sampleAcc: 0,
  };

  var alarmState = {};
  var alarmAcked = {};
  var klaxonArmed = true;

  ALARM_NAMES.forEach(function (n) {
    alarmState[n] = false;
    alarmAcked[n] = false;
  });

  /* --------------------------- deterministic noise ---------------------- */
  function noise(t, w, p) {
    return Math.sin((t / w + p) * 1.0);
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  function approachDemand() {
    var h = (6 + desk.t / 3600) % 24;
    var rush =
      1150 * Math.exp(-((h - 8) * (h - 8)) / 2.4) +
      1250 * Math.exp(-((h - 17.3) * (h - 17.3)) / 2.8);
    var wander = 260 * noise(desk.t, 301, 0) + 120 * noise(desk.t, 47, 2);
    return clamp(1450 + rush + wander, 650, 4300);
  }

  /* ------------------------------- physics ------------------------------ */
  function stepPhysics(dt) {
    desk.t += dt;
    var i;

    /* --- traffic over the Zuid portal --- */
    var want = approachDemand();
    var cap = desk.lever === 1 ? 1800 : 3600;
    if (desk.lever === 2 || sim.closure) cap = 0;
    var admitted = Math.min(want, cap);
    var spill = want - admitted;
    sim.q = admitted;
    sim.queue += (spill / 3600) * dt;
    if (spill <= 0.001) sim.queue -= ((cap - want) / 3600) * dt;
    sim.queue = clamp(sim.queue, 0, 400);

    /* --- what the ventilation law wants --- */
    var smokeKey = desk.keyTurned && !desk.keyGuarded && desk.supply;
    var autoTarget = clamp(1.2 + sim.co * 0.045 + sim.extK * 0.9, 1.2, 8);
    var needThrust = DRAG_K * autoTarget * autoTarget * 1.06;
    var stagesNeeded = 0;
    var acc = 0;
    while (stagesNeeded < 4 && acc < needThrust) {
      stagesNeeded++;
      acc += JETS_PER_GROUP * JET_N;
    }
    if (smokeKey) {
      stagesNeeded = 4;
      autoTarget = 7.5;
    }
    sim.lawTarget = autoTarget;
    sim.lawStage = desk.supply ? stagesNeeded : 0;

    /* --- resolve each group against mode + paddle --- */
    var demand = [false, false, false, false];
    var dirs = [1, 1, 1, 1];
    for (i = 0; i < 4; i++) {
      var p = desk.paddles[i];
      var on = false;
      var dir = 1;
      if (desk.supply) {
        if (smokeKey) {
          on = true;
          dir = -1;
        } else if (p === -1) {
          on = desk.ventMode !== "off";
          dir = -1;
        } else if (p === 1) {
          on = desk.ventMode !== "off";
        } else if (desk.ventMode === "auto") {
          on = i < sim.lawStage;
        }
      }
      if (sim.fanTripped[i] || sim.locked[i]) on = false;
      if (
        sim.fire.active &&
        dir === 1 &&
        i >= 2 &&
        sim.tempC > 160 &&
        !smokeKey
      ) {
        on = false; // hot layer trips the downstream jets
      }
      demand[i] = on;
      dirs[i] = dir;
    }
    sim.fanDir = dirs;

    /* --- airflow --- */
    var thrust = 0;
    for (i = 0; i < 4; i++) {
      if (demand[i] && sim.mainsOk) thrust += dirs[i] * JETS_PER_GROUP * JET_N;
    }
    var piston = (sim.q / 3600) * 950;
    var windN = 190 * noise(desk.t, 173, 0) + 80 * noise(desk.t, 61, 1.4);
    var fTotal = thrust + piston + windN - DRAG_K * sim.v * Math.abs(sim.v);
    sim.v = clamp(sim.v + (fTotal / AIR_M()) * dt, -9, 9);

    /* --- fan electrics & bearings --- */
    for (i = 0; i < 4; i++) {
      var running = demand[i] && sim.mainsOk;
      sim.fanRun[i] = running;
      var target = sim.locked[i]
        ? 170
        : running
          ? 58 + Math.abs(sim.v) * 2.4
          : 20;
      var rate = sim.locked[i] ? 0.065 : running ? 0.05 : 0.03;
      sim.bearing[i] = clamp(
        sim.bearing[i] + (target - sim.bearing[i]) * rate * dt,
        18,
        172,
      );
      if (sim.bearing[i] >= 148 && !sim.fanTripped[i]) {
        sim.fanTripped[i] = true;
        setActive("FAN TRIP", true);
      }
    }

    /* --- contaminants --- */
    var ach = (Math.abs(sim.v) / BORE_L) * 1.3;
    var srcCo = sim.q * 0.0000376;
    if (sim.fire.active) srcCo += 2.3 * sim.fire.intensity;
    sim.co = clamp(sim.co + (srcCo - sim.co * ach) * dt, 0, 999);

    var srcK = sim.q * 0.0000063;
    if (sim.fire.active) srcK += 0.09 * sim.fire.intensity;
    sim.extK = clamp(sim.extK + (srcK - (sim.extK - 2) * ach) * dt, 1.4, 40);

    /* --- fire fuel and heat --- */
    if (sim.fire.active) {
      sim.fire.rampUp += dt;
      var ramp = clamp(sim.fire.rampUp / 25, 0, 1);
      sim.fire.intensity = ramp * clamp(sim.fire.fuel / 30, 0.12, 1);
      sim.fire.fuel -= sim.fire.intensity * 0.3 * dt;
      if (sim.fire.fuel <= 0) {
        sim.fire.fuel = 0;
        sim.fire.intensity = Math.max(0, sim.fire.intensity - dt * 0.05);
        if (sim.fire.intensity === 0) sim.fire.burntOut = true;
      }
      sim.tempC = clamp(
        sim.tempC +
          ((13e6 * sim.fire.intensity -
            62000 * (1 + Math.abs(sim.v) * 0.16) * (sim.tempC - 14)) /
            5.2e7) *
            dt,
        12,
        320,
      );
    } else {
      sim.tempC = clamp(
        sim.tempC +
          ((0 - 62000 * (1 + Math.abs(sim.v) * 0.16) * (sim.tempC - 14)) /
            5.2e7) *
            dt,
        12,
        320,
      );
    }

    /* --- drainage --- */
    var seepage = Math.max(
      0,
      5.5 + 4.5 * noise(desk.t, 97, 0.6) + 2.5 * noise(desk.t, 13.7, 0),
    );
    if (desk.flushHeld) seepage += 42;
    var p1 = false;
    var p2 = false;
    var standby = !sim.mainsOk;
    if (desk.supply && desk.pumpMode === "hand") {
      p1 = desk.handRunHeld;
      p2 = desk.handRunHeld && sim.sumpPct > 70;
    } else if (desk.supply && desk.pumpMode === "auto") {
      if (sim.sumpPct >= 65) sim.pumpsLatched = true;
      if (sim.sumpPct <= 22) sim.pumpsLatched = false;
      p1 = sim.pumpsLatched;
      p2 = p1 && sim.sumpPct > 80;
    } else if (standby && sim.sumpPct > 40) {
      p1 = true;
    }
    if (sim.sumpPct >= 99.5) {
      p1 = false;
      p2 = false;
    }
    sim.pumpsRunning = [p1, p2];
    var pumpCap = (p1 ? 27 : 0) + (p2 ? 27 : 0);
    sim.sumpPct = clamp(sim.sumpPct + ((seepage - pumpCap) * dt) / 24, 0, 100);

    /* --- automatic closure --- */
    timers.coHold = sim.co >= 150 ? timers.coHold + dt : 0;
    timers.visHold = sim.extK >= 18 ? timers.visHold + dt : 0;
    timers.fireBigHold =
      sim.fire.active && sim.fire.intensity >= 0.72
        ? timers.fireBigHold + dt
        : 0;
    if (
      !sim.closure &&
      (timers.coHold > 45 || timers.visHold > 45 || timers.fireBigHold > 90)
    ) {
      sim.closure = true;
      timers.calmHold = 0;
      setActive("AUTOMATIC CLOSURE", true);
    }
    if (sim.closure) {
      var calm =
        sim.co < 110 &&
        sim.extK < 13 &&
        !(sim.fire.active && sim.fire.intensity > 0.4) &&
        desk.lever !== 2;
      timers.calmHold = calm ? timers.calmHold + dt : 0;
      if (timers.calmHold > 60 && alarmAcked["AUTOMATIC CLOSURE"])
        sim.closure = false;
    }

    /* --- alarm conditions --- */
    var forcedAny =
      desk.paddles[0] !== 0 ||
      desk.paddles[1] !== 0 ||
      desk.paddles[2] !== 0 ||
      desk.paddles[3] !== 0;
    var venting =
      desk.supply &&
      (smokeKey || sim.lawStage > 0 || (forcedAny && desk.ventMode !== "off"));
    timers.airLowHold =
      venting && Math.abs(sim.v) < 0.6 ? timers.airLowHold + dt : 0;

    setActive("CO HIGH", sim.co >= 70);
    setActive("VIS POOR", sim.extK >= 9);
    setActive(
      "AIRFLOW LOW",
      timers.airLowHold > 20 || (smokeKey && Math.abs(sim.v) < 1),
    );
    setActive(
      "FAN TRIP",
      sim.fanTripped[0] ||
        sim.fanTripped[1] ||
        sim.fanTripped[2] ||
        sim.fanTripped[3],
    );
    setActive("SUMP HIGH", sim.sumpPct >= 85);
    setActive("POWER FAIL", !sim.mainsOk);

    setActive(
      "FIRE DETECTED",
      sim.fire.active ||
        (sim.fire.latch && !sim.fire.latchCleared && sim.extK >= 5),
    );
    setActive("AUTOMATIC CLOSURE", sim.closure);
    if (sim.fire.active) sim.fire.latch = true;

    /* --- chart sampling, one second of chart per second --- */
    timers.sampleAcc += dt;
    if (timers.sampleAcc >= 1) {
      timers.sampleAcc -= 1;
      histCo.push(sim.co);
      histK.push(sim.extK);
      if (histCo.length > 300) histCo.shift();
      if (histK.length > 300) histK.shift();
    }
  }

  function AIR_M() {
    return 38880; // kg of air in the bore
  }

  /* ------------------------------ alarms -------------------------------- */
  function setActive(name, cond) {
    if (cond) {
      if (!alarmState[name]) {
        alarmState[name] = true;
        alarmAcked[name] = false;
        if (!desk.hornCut) klaxonArmed = true;
      }
    } else {
      alarmState[name] = false;
    }
  }

  function activeNames() {
    return ALARM_NAMES.filter(function (n) {
      return alarmState[n];
    });
  }

  /* ============================== public API ============================ */
  function kwNow() {
    return sim.fanRun.reduce(function (s, r) {
      return s + (r ? JETS_PER_GROUP * JET_KW : 0);
    }, 0);
  }

  function clockString() {
    var total = 6 * 3600 + desk.t;
    var h = Math.floor(total / 3600) % 24;
    var m = Math.floor(total / 60) % 60;
    var sec = Math.floor(total) % 60;
    function p2(x) {
      return (x < 10 ? "0" : "") + x;
    }
    return p2(h) + ":" + p2(m) + ":" + p2(sec);
  }

  var machine = {
    name: "Koegors Crossing — Tunnel Ventilation & Incident Control",
    faults: FAULTS.slice(),

    state: function () {
      return {
        time: desk.t,
        clock: clockString(),
        trafficVehH: Math.round(sim.q),
        queueVeh: Math.round(sim.queue),
        airflowMs: Number(sim.v.toFixed(3)),
        carbonMonoxidePpm: Number(sim.co.toFixed(2)),
        extinctionPerKm: Number(sim.extK.toFixed(3)),
        boreTempC: Number(sim.tempC.toFixed(2)),
        sumpPercent: Number(sim.sumpPct.toFixed(2)),
        fansRunning: sim.fanRun.slice(),
        fanDirection: sim.fanDir.slice(),
        fansTripped: sim.fanTripped.slice(),
        fanGroupsStaged: sim.lawStage,
        fanKilowatts: kwNow(),
        pumpsRunning: sim.pumpsRunning.slice(),
        portalSignal: sim.closure
          ? "RED"
          : ["GREEN", "AMBER", "RED"][desk.lever],
        portalsClosed: sim.closure || desk.lever === 2,
        mainsHealthy: sim.mainsOk,
        fireActive: sim.fire.active,
        fireFuelPercent: Number(clamp(sim.fire.fuel, 0, 100).toFixed(2)),
        smokeControlActive: desk.keyTurned && !desk.keyGuarded,
        alarms: activeNames(),
      };
    },

    tick: function (seconds) {
      var s = Number(seconds);
      if (!isFinite(s) || s <= 0) return;
      var remaining = Math.min(s, 120);
      while (remaining > 0) {
        var dt = Math.min(0.5, remaining);
        stepPhysics(dt);
        remaining -= dt;
      }
    },

    inject: function (fault) {
      var f = String(fault || "").toLowerCase();
      if (f === "jet fan seizure") {
        desk.faults.seizure = true;
        sim.locked[1] = true;
        sim.bearing[1] = Math.max(sim.bearing[1], 96);
      } else if (f === "mains supply failure") {
        desk.faults.mainsfail = true;
        sim.mainsOk = false;
      } else if (f === "vehicle fire in bore") {
        desk.faults.fireSwitch = true;
        if (!sim.fire.active) {
          sim.fire.active = true;
          sim.fire.fuel = 100;
          sim.fire.rampUp = 0;
          sim.fire.burntOut = false;
          sim.fire.latch = true;
          sim.fire.latchCleared = false;
        }
      }
      syncFaultToggles();
    },

    reset: function () {
      desk.t = 0;
      desk.supply = true;
      desk.ventMode = "off";
      desk.paddles = [0, 0, 0, 0];
      desk.pumpMode = "auto";
      desk.lever = 0;
      desk.zones = [true, true, false, false];
      desk.keyGuarded = true;
      desk.keyTurned = false;
      desk.hornCut = false;
      desk.lampTest = false;
      desk.faults = { seizure: false, mainsfail: false, fireSwitch: false };

      sim.q = 2400;
      sim.queue = 0;
      sim.v = 0;
      sim.co = 4;
      sim.extK = 2;
      sim.tempC = 14;
      sim.sumpPct = 12;
      sim.pumpsRunning = [false, false];
      sim.fanRun = [false, false, false, false];
      sim.fanDir = [1, 1, 1, 1];
      sim.fanTripped = [false, false, false, false];
      sim.bearing = [22, 22, 22, 22];
      sim.locked = [false, false, false, false];
      sim.mainsOk = true;
      sim.fire = {
        active: false,
        fuel: 100,
        intensity: 0,
        rampUp: 0,
        burntOut: false,
      };
      sim.closure = false;
      sim.lawStage = 0;
      sim.lawTarget = 0;
      sim.pumpsLatched = false;

      timers.coHold = 0;
      timers.visHold = 0;
      timers.fireBigHold = 0;
      timers.airLowHold = 0;
      timers.calmHold = 0;
      timers.sampleAcc = 0;
      histCo.length = 0;
      histK.length = 0;

      ALARM_NAMES.forEach(function (n) {
        alarmState[n] = false;
        alarmAcked[n] = false;
      });
      klaxonArmed = false;
      sound.stopKlaxon();
      ui.syncAll();
    },
  };
  window.machine = machine;

  /* ============================ user interface ========================== */
  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  var ui = {};
  var histCo = [];
  var histK = [];
  var recCtx = null;
  var smokePhase = 0;

  var SVGNS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, attrs[k]);
    });
    return el;
  }

  function buildFans() {
    GROUPS.forEach(function (g) {
      var host = document.getElementById("fanGroup" + g);
      host.appendChild(
        svgEl("text", { x: 26, y: -16, class: "fan-tag", textContent: g }),
      );
      for (var j = 0; j < 2; j++) {
        var jet = svgEl("g", { class: "jet" });
        if (j === 1) jet.setAttribute("transform", "translate(0,26)");
        jet.appendChild(
          svgEl("rect", {
            x: 0,
            y: -8,
            width: 46,
            height: 16,
            rx: 7,
            class: "jet-body",
          }),
        );
        var blades = svgEl("g", { class: "blades" });
        blades.appendChild(
          svgEl("circle", { cx: 12, cy: 0, r: 5.5, class: "blade-ring" }),
        );
        blades.appendChild(
          svgEl("path", {
            d: "M12 0 L16 -4 M12 0 L16 4 M12 0 L7 -4 M12 0 L7 4",
            class: "blade-path",
          }),
        );
        jet.appendChild(blades);
        jet.appendChild(
          svgEl("rect", {
            x: 34,
            y: -3,
            width: 8,
            height: 6,
            class: "jet-motor",
          }),
        );
        host.appendChild(jet);
      }
    });
  }

  function buildQueue() {
    var hostZ = $("#queueZuid");
    for (var i = 0; i < 16; i++) {
      var car = svgEl("rect", {
        class: "queue-car" + (i % 4 === 2 ? " lgv" : ""),
        x: 18 + (i % 8) * 15,
        y: 290 - Math.floor(i / 8) * 14,
        width: 12,
        height: 8,
        rx: 2,
      });
      car.style.display = "none";
      hostZ.appendChild(car);
    }
  }

  ui.cache = function () {
    ui.clockEl = $("#clock");
    ui.annEls = {};
    $$(".annw").forEach(function (el) {
      ui.annEls[el.getAttribute("data-ann")] = el;
    });
    ui.fanHosts = GROUPS.map(function (g) {
      return document.getElementById("fanGroup" + g);
    });
    ui.smoke1 = $("#smoke1");
    ui.smoke2 = $("#smoke2");
    ui.fireGlow = $("#fireGlow");
    ui.fireMarker = $("#fireMarker");
    ui.sumpWater = $("#sumpWater");
    ui.pumpDots = [$("#pump1"), $("#pump2")];
    ui.ribbonLine = $("#airflowLine");
    ui.ribbonHead = $("#airflowHead");
    ui.ribbonText = $("#airflowText");
    ui.barge = $("#barge");
    ui.queueCars = $$("#queueZuid .queue-car");
    ui.signalZuid = document
      .querySelector("#signalZuid")
      .querySelectorAll(".aspect");
    ui.signalNoord = document
      .querySelector("#signalNoord")
      .querySelectorAll(".aspect");
    ui.barrierZ = $("#barrierZuid");
    ui.barrierN = $("#barrierNoord");
    ui.zoneGs = $$(".zone");
    ui.coDrum = $("#coDrum span");
    ui.visDrum = $("#visDrum span");
    ui.airNeedle = $("#airNeedle");
    ui.tempNeedle = $("#tempNeedle");
    ui.recorder = $("#recorder");
    ui.qRead = $("#qRead");
    ui.queueRead = $("#queueRead");
    ui.kwRead = $("#kwRead");
    ui.powerRead = $("#powerRead");
    ui.ventStatus = $("#ventStatus");
    ui.sumpReadEl = $("#sumpRead");
    ui.pumpRead = $("#pumpRead");
    ui.signalNote = $("#signalNote");
    ui.rotaries = [
      {
        root: $("#deskSupply"),
        sel: 'input[name="deskSupply"]',
        angles: { off: -35, on: 35 },
      },
      {
        root: $("#ventMode"),
        sel: 'input[name="ventMode"]',
        angles: { off: -51, auto: -17, hand: 17, test: 51 },
      },
      {
        root: $("#pumpMode"),
        sel: 'input[name="pumpMode"]',
        angles: { off: -32, auto: 0, hand: 32 },
      },
    ];
  };

  function setRadio(groupName, value) {
    var el = $('input[name="' + groupName + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function refreshKnobs() {
    ui.rotaries.forEach(function (r) {
      var checked = r.root.querySelector(r.sel + ":checked");
      var knob = r.root.querySelector("[data-knob]");
      if (checked && knob)
        knob.style.transform = "rotate(" + r.angles[checked.value] + "deg)";
    });
  }

  ui.syncAll = function () {
    setRadio("deskSupply", desk.supply ? "on" : "off");
    setRadio("ventMode", desk.ventMode);
    setRadio("pumpMode", desk.pumpMode);
    refreshKnobs();
    $$(".paddle input[type=range]").forEach(function (inp, i) {
      inp.value = String(desk.paddles[i]);
    });
    $("#signalLever").value = String(desk.lever);
    $$(".rocker input").forEach(function (cb, i) {
      cb.checked = desk.zones[i];
    });
    $("#keyGuard").classList.toggle("lifted", !desk.keyGuarded);
    $("#keySwitch").classList.toggle("turned", desk.keyTurned);
    $("#keySwitch").setAttribute("aria-pressed", String(desk.keyTurned));
    $("#faultLid").classList.remove("open");
    $("#faultLid").setAttribute("aria-expanded", "false");
    $("#lampTest").classList.remove("btn-reset");
    syncFaultToggles();
    drawCharts();
    paintFrame(0);
    paintAlarms();
  };

  /* ------------------------------ rendering ----------------------------- */
  function paintFrame(dt) {
    ui.clockEl.textContent = clockString();

    var speedDur = clamp(1.9 / Math.max(Math.abs(sim.v), 0.35), 0.16, 2.4);
    ui.fanHosts.forEach(function (host, i) {
      var jets = host.querySelectorAll(".jet");
      Array.prototype.forEach.call(jets, function (jet) {
        jet.classList.toggle("running", sim.fanRun[i]);
        jet.classList.toggle("rev", sim.fanDir[i] < 0);
        jet.classList.toggle("tripped", sim.fanTripped[i]);
        jet.style.animationDuration = speedDur.toFixed(2) + "s";
      });
    });

    ui.zoneGs.forEach(function (zg, i) {
      zg.classList.toggle(
        "lit",
        desk.supply && desk.zones[i] && (sim.mainsOk || i === 1),
      );
    });

    var effRed = sim.closure || desk.lever === 2;
    var effAmber = !effRed && desk.lever === 1;
    var effGreen = !effRed && !effAmber;
    [ui.signalZuid, ui.signalNoord].forEach(function (a) {
      a[0].classList.toggle("on", effRed && desk.supply);
      a[1].classList.toggle("on", effAmber && desk.supply);
      a[2].classList.toggle("on", effGreen && desk.supply);
    });
    ui.barrierZ.classList.toggle("barrier-up", !effRed);
    ui.barrierN.classList.toggle("barrier-up", !effRed);

    var shown = Math.round(clamp(sim.queue / 24, 0, ui.queueCars.length));
    ui.queueCars.forEach(function (car, i) {
      car.style.display = i < shown ? "" : "none";
    });

    smokePhase += sim.v * dt * PX_PER_M;
    var haze = clamp((sim.extK - 4) / 22, 0, 0.85);
    var cx1 = 700 + (((smokePhase % 500) + 500) % 500) - 250;
    var cx2 = 520 + ((((smokePhase * 0.7) % 400) + 400) % 400) - 200;
    ui.smoke1.setAttribute("cx", cx1.toFixed(1));
    ui.smoke2.setAttribute("cx", cx2.toFixed(1));
    ui.smoke1.setAttribute("opacity", haze.toFixed(3));
    ui.smoke2.setAttribute("opacity", (haze * 0.8).toFixed(3));
    ui.fireGlow.setAttribute(
      "opacity",
      (sim.fire.active ? clamp(sim.fire.intensity, 0, 1) * 0.85 : 0).toFixed(3),
    );
    ui.fireMarker.classList.toggle("hidden", !sim.fire.active);

    var wh = 24 * (sim.sumpPct / 100);
    ui.sumpWater.setAttribute("y", (27 - wh).toFixed(1));
    ui.sumpWater.setAttribute("height", Math.max(0, wh).toFixed(1));
    ui.pumpDots[0].classList.toggle("running", sim.pumpsRunning[0]);
    ui.pumpDots[1].classList.toggle("running", sim.pumpsRunning[1]);

    var dash = parseFloat(
      ui.ribbonLine.getAttribute("stroke-dashoffset") || "0",
    );
    dash -= sim.v * dt * 9;
    ui.ribbonLine.setAttribute("stroke-dashoffset", dash.toFixed(1));
    ui.ribbonHead.setAttribute(
      "transform",
      sim.v < -0.05 ? "scale(-1,1) translate(-2518,0)" : "",
    );
    ui.ribbonText.textContent =
      "AIRFLOW " +
      Math.abs(sim.v).toFixed(1) +
      " m/s " +
      (sim.v >= 0 ? "\u2192" : "\u2190") +
      (desk.ventMode === "auto" && sim.lawStage
        ? " \u00b7 LAW STAGE " + sim.lawStage
        : "");

    var bx = ((desk.t * 9) % 1750) - 220;
    ui.barge.setAttribute("transform", "translate(" + bx.toFixed(1) + ",34)");

    ui.coDrum.textContent = String(Math.round(sim.co)).padStart(3, "0");
    ui.visDrum.textContent = sim.extK.toFixed(1).replace(".", "\u00b7");
    ui.airNeedle.style.transform =
      "rotate(" + (-60 + (clamp(Math.abs(sim.v), 0, 12) / 12) * 120) + "deg)";
    ui.tempNeedle.style.transform =
      "rotate(" + (-60 + clamp((sim.tempC - 10) / 300, 0, 1) * 120) + "deg)";

    ui.qRead.textContent = String(Math.round(sim.q));
    ui.queueRead.textContent = String(Math.round(sim.queue));
    ui.kwRead.textContent = String(kwNow());
    ui.powerRead.textContent = sim.mainsOk
      ? "MAINS \u2713"
      : "MAINS \u2717 EMERGENCY FEED";
    ui.powerRead.classList.toggle("fail", !sim.mainsOk);
    ui.sumpReadEl.textContent = Math.round(sim.sumpPct) + "%";
    ui.pumpRead.textContent = sim.pumpsRunning[1]
      ? "P1+P2 DUTY"
      : sim.pumpsRunning[0]
        ? "P1 DUTY"
        : standbyText();
    ui.signalNote.textContent = sim.closure
      ? "AUTOMATIC CLOSURE \u2014 LEVER OVERRIDDEN TO RED"
      : desk.lever === 2
        ? "PORTALS SHUT \u00b7 QUEUE FORMING AT ZUID"
        : desk.lever === 1
          ? "AMBER \u2014 SINGLE FILE, CAPACITY 1800 veh/h"
          : "PORTALS OPEN \u00b7 3600 veh/h CAPACITY";

    var parts = [
      desk.supply ? "SUPPLY ON" : "SUPPLY OFF",
      desk.ventMode.toUpperCase(),
    ];
    if (desk.keyTurned && !desk.keyGuarded) parts.push("\u26a0 PURGE REVERSE");
    parts.push("TARGET " + sim.lawTarget.toFixed(1) + " m/s");
    parts.push(
      "BEARINGS " +
        GROUPS.map(function (g, i) {
          return g + ":" + Math.round(sim.bearing[i]);
        }).join(" "),
    );
    ui.ventStatus.textContent = parts.join(" \u00b7 ");

    drawCharts();
  }

  function standbyText() {
    return "STANDBY";
  }

  function drawCharts() {
    var cv = ui.recorder;
    if (!cv) return;
    if (!recCtx) recCtx = cv.getContext("2d");
    var ctx = recCtx;
    var w = cv.width;
    var h = cv.height;
    ctx.fillStyle = "#efe8d2";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(120,100,60,.35)";
    ctx.lineWidth = 1;
    var gx;
    for (gx = 0; gx <= 6; gx++) {
      var x = (gx / 6) * (w - 8) + 4;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, h - 2);
      ctx.stroke();
    }
    var gy;
    for (gy = 0; gy <= 5; gy++) {
      var y = 2 + (gy / 5) * (h - 4);
      ctx.beginPath();
      ctx.moveTo(4, y);
      ctx.lineTo(w - 4, y);
      ctx.stroke();
    }
    function pen(series, max, color) {
      if (series.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      series.forEach(function (val, idx) {
        var px = 4 + (idx / 299) * (w - 8);
        var py = h - 4 - (clamp(val, 0, max) / max) * (h - 8);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    pen(histK, 25, "#2456a0");
    pen(histCo, 250, "#c22214");
    ctx.fillStyle = "#6b5c39";
    ctx.font = "9px Consolas, monospace";
    ctx.fillText("250", 4, 11);
    ctx.fillText("CO ppm", 6, h - 6);
    ctx.fillStyle = "#2456a0";
    ctx.fillText("K 25", w - 44, 11);
  }

  function paintAlarms() {
    ALARM_NAMES.forEach(function (name) {
      var win = ui.annEls[name];
      if (!win) return;
      var active = alarmState[name];
      win.classList.toggle("alarm", active);
      win.classList.toggle(
        "flash",
        active && !alarmAcked[name] && !desk.lampTest,
      );
      win.classList.toggle("testlit", desk.lampTest && !active);
    });
  }

  /* ------------------------------- sound -------------------------------- */
  var sound = {
    ctx: null,
    humGain: null,
    klaxGain: null,
    ready: false,

    ensure: function () {
      if (sound.ready) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        sound.ctx = new AC();
        var hum = sound.ctx.createOscillator();
        hum.type = "sawtooth";
        hum.frequency.value = 47;
        var lp = sound.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 130;
        sound.humGain = sound.ctx.createGain();
        sound.humGain.gain.value = 0;
        hum.connect(lp);
        lp.connect(sound.humGain);
        sound.humGain.connect(sound.ctx.destination);
        hum.start();

        sound.klaxGain = sound.ctx.createGain();
        sound.klaxGain.gain.value = 0;
        var o1 = sound.ctx.createOscillator();
        o1.type = "square";
        o1.frequency.value = 485;
        var o2 = sound.ctx.createOscillator();
        o2.type = "square";
        o2.frequency.value = 364;
        var mix = sound.ctx.createGain();
        mix.gain.value = 0.5;
        var lfo = sound.ctx.createOscillator();
        lfo.type = "square";
        lfo.frequency.value = 2.4;
        var lfoGain = sound.ctx.createGain();
        lfoGain.gain.value = 0.5;
        lfo.connect(lfoGain);
        lfoGain.connect(mix.gain);
        o1.connect(mix);
        o2.connect(mix);
        mix.connect(sound.klaxGain);
        sound.klaxGain.connect(sound.ctx.destination);
        o1.start();
        o2.start();
        lfo.start();
        sound.ready = true;
      } catch (e) {
        sound.ready = false;
      }
    },

    frame: function () {
      if (!sound.ready) return;
      var t = sound.ctx.currentTime;
      sound.humGain.gain.setTargetAtTime(
        Math.min(0.045, (kwNow() / 208) * 0.045),
        t,
        0.4,
      );
      var wants =
        klaxonArmed && !desk.hornCut && desk.supply && activeNames().length > 0;
      sound.klaxGain.gain.setTargetAtTime(wants ? 0.05 : 0, t, 0.05);
    },

    stopKlaxon: function () {
      klaxonArmed = false;
    },

    clack: function () {
      if (!sound.ready) return;
      try {
        var o = sound.ctx.createOscillator();
        o.type = "triangle";
        o.frequency.setValueAtTime(2100, sound.ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(
          240,
          sound.ctx.currentTime + 0.04,
        );
        var g = sound.ctx.createGain();
        g.gain.setValueAtTime(0.08, sound.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(
          0.0001,
          sound.ctx.currentTime + 0.07,
        );
        o.connect(g);
        g.connect(sound.ctx.destination);
        o.start();
        o.stop(sound.ctx.currentTime + 0.09);
      } catch (e) {
        /* silent */
      }
    },
  };

  /* ------------------------------ bindings ------------------------------ */
  function bindEvents() {
    document.addEventListener("pointerdown", function () {
      sound.ensure();
    });

    $$('input[name="deskSupply"]').forEach(function (r) {
      r.addEventListener("change", function () {
        desk.supply = r.value === "on";
        refreshKnobs();
        sound.clack();
      });
    });
    $$('input[name="ventMode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        desk.ventMode = r.value;
        refreshKnobs();
        sound.clack();
      });
    });
    $$('input[name="pumpMode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        desk.pumpMode = r.value;
        refreshKnobs();
        sound.clack();
      });
    });

    $$(".paddle input[type=range]").forEach(function (inp, i) {
      inp.addEventListener("input", function () {
        desk.paddles[i] = parseInt(inp.value, 10);
      });
    });

    $("#signalLever").addEventListener("input", function () {
      desk.lever = parseInt(this.value, 10);
    });

    $$(".rocker input").forEach(function (cb, i) {
      cb.addEventListener("change", function () {
        desk.zones[i] = cb.checked;
      });
    });

    $("#keyGuard").addEventListener("click", function () {
      desk.keyGuarded = false;
      this.classList.add("lifted");
    });
    $("#keySwitch").addEventListener("click", function () {
      if (desk.keyGuarded) return;
      desk.keyTurned = !desk.keyTurned;
      this.classList.toggle("turned", desk.keyTurned);
      this.setAttribute("aria-pressed", String(desk.keyTurned));
      if (!desk.keyTurned) sim.fire.latchCleared = true;
      sound.clack();
    });

    $("#faultLid").addEventListener("click", function () {
      var open = this.classList.toggle("open");
      this.setAttribute("aria-expanded", String(open));
    });
    $$(".ftoggle").forEach(function (tg) {
      tg.addEventListener("click", function () {
        var name = tg.getAttribute("data-fault");
        if (tg.getAttribute("aria-checked") === "true") clearTestFault(name);
        else machine.inject(name);
      });
    });

    function holdBind(el, prop) {
      var down = function (ev) {
        ev.preventDefault();
        desk[prop] = true;
        el.classList.add("held");
      };
      var up = function () {
        desk[prop] = false;
        el.classList.remove("held");
      };
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointerleave", up);
      el.addEventListener("keydown", function (ev) {
        if (ev.key === " " || ev.key === "Enter") down(ev);
      });
      el.addEventListener("keyup", up);
    }
    holdBind($("#handRun"), "handRunHeld");
    holdBind($("#flushValve"), "flushHeld");

    $("#tripReset").addEventListener("click", function () {
      for (var i = 0; i < 4; i++) {
        if (sim.fanTripped[i] && sim.bearing[i] < 95) sim.fanTripped[i] = false;
        if (sim.locked[i] && !desk.faults.seizure && sim.bearing[i] < 95)
          sim.locked[i] = false;
      }
      sound.clack();
    });
    $("#alarmAccept").addEventListener("click", function () {
      activeNames().forEach(function (n) {
        alarmAcked[n] = true;
      });
      sound.clack();
    });
    $("#hornCut").addEventListener("click", function () {
      desk.hornCut = true;
      klaxonArmed = false;
    });
    $("#lampTest").addEventListener("click", function () {
      desk.lampTest = !desk.lampTest;
      this.classList.toggle("btn-reset", desk.lampTest);
      paintAlarms();
    });
    $("#deskReset").addEventListener("click", function () {
      machine.reset();
    });

    var dialog = $("dialog[data-manual]");
    $$('[data-action="manual"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      });
    });
    $$('[data-action="close-manual"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      });
    });
  }

  function clearTestFault(name) {
    if (name === "jet fan seizure") {
      desk.faults.seizure = false;
      /* spindle stays locked until it cools and the desk resets the trip */
    } else if (name === "mains supply failure") {
      desk.faults.mainsfail = false;
      sim.mainsOk = true;
    } else if (name === "vehicle fire in bore") {
      desk.faults.fireSwitch = false;
      /* lifting the test switch removes the ignition source, not the burning load */
    }
    syncFaultToggles();
  }

  function syncFaultToggles() {
    $$(".ftoggle").forEach(function (tg) {
      var name = tg.getAttribute("data-fault");
      var on =
        (name === "jet fan seizure" && desk.faults.seizure) ||
        (name === "mains supply failure" && desk.faults.mainsfail) ||
        (name === "vehicle fire in bore" && desk.faults.fireSwitch);
      tg.setAttribute("aria-checked", String(on));
    });
  }

  /* ------------------------------ main loop ----------------------------- */
  var lastTs = null;

  function loop(ts) {
    if (lastTs === null) lastTs = ts;
    var dt = Math.min(1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!document.hidden) {
      machine.tick(dt);
      paintFrame(dt);
      paintAlarms();
      sound.frame();
    }
    requestAnimationFrame(loop);
  }

  /* -------------------------------- boot -------------------------------- */
  function boot() {
    buildFans();
    buildQueue();
    ui.cache();
    bindEvents();
    ui.syncAll();
    requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
