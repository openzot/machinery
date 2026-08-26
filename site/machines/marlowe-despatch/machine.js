/* ======================================================================
   MARLOWE & DUNN LTD. — PNEUMATIC DESPATCH · CONTROL POSITION No. 1
   Simulation and panel behaviour. Kensington store, 1936.
   One exhauster set charges a receiver; a reducing valve holds the main;
   felted carriers fly out to eight departments and come back by return.
   ====================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------ consts */

  var MACHINE_NAME = "Marlowe & Dunn Pneumatic Despatch";
  var FAULTS = [
    "carrier jammed in the line",
    "air main gasket leak",
    "exhauster overheat",
  ];

  var STATIONS = [
    { name: "LACES", ft: 40 },
    { name: "MILLINERY", ft: 82 },
    { name: "FURS", ft: 122 },
    { name: "BOOKS", ft: 163 },
    { name: "SILKS", ft: 204 },
    { name: "TOYS", ft: 245 },
    { name: "CHEMIST", ft: 285 },
    { name: "ENQUIRIES", ft: 315 },
  ];

  var LINE_FT = 315;
  var AMBIENT_C = 22;
  var TRIP_C = 95;
  var RELIGHT_C = 70;
  var RELIEF_PSI = 92;
  var CUTOUT_PSI = 88;
  var CUTIN_PSI = 72;
  var WEAK_PSI = 16; // below this a carrier will stall
  var RESEAT_PSI = 9; // a blown gasket reseats cold below this

  /* --------------------------------------------------------- sim state */

  var sim;

  function freshSim() {
    return {
      t: 0,
      seed: 0x19360401 >>> 0,
      rngState: 0,
      // air plant
      motorMode: "OFF", // OFF | AUTO | RUN
      motorLocked: false,
      motorRunning: false,
      receiverPsi: 2.5,
      linePsi: 0,
      setpointPsi: 26,
      temperatureC: AMBIENT_C,
      reliefLifted: false,
      // faults
      jammed: false,
      jamIsReal: false, // true: a carrier really sits stalled in the tube
      leakActive: false,
      leakBelowTimer: 0,
      heatFault: false,
      heatFaultSpent: false,
      // carrier (ours)
      carrierWhere: "breech", // breech | outbound | department | returning
      carrierFt: 0,
      carrierV: 0,
      shotAge: 0,
      shotBlastLeft: 0,
      destIndex: -1,
      deptHold: 0,
      // inbound store traffic
      inboundActive: false,
      inboundFrom: -1,
      inboundFt: 0,
      inboundV: 0,
      nextInbound: 45,
      lineHealthy: false,

      // panel
      stationIndex: 0,
      gateOpen: false,
      lever: "HOLD", // VENT | HOLD | DESPATCH
      purgeOpen: false,
      purgeTimer: 0,
      trayCount: 0,
      boxCount: 0,
      lampsTesting: 0,
      soundCut: false,
    };
  }

  function rngNext() {
    // mulberry32, stepped only from tick(): deterministic
    sim.rngState = (sim.rngState + 0x6d2b79f5) >>> 0;
    var z = sim.rngState;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ------------------------------------------------------------- alarms */

  var alarmLatched = {};
  var annAccepted = true;

  function latch(name) {
    if (!alarmLatched[name]) {
      alarmLatched[name] = true;
      annAccepted = false;
    }
  }
  function unlatch(name) {
    delete alarmLatched[name];
  }

  /* --------------------------------------------------------------- tick */

  function tick(seconds) {
    var dt = Number(seconds);
    if (!isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 2); // sub-stepped below; generous cap for tab resumes
    var steps = Math.max(1, Math.ceil(dt / 0.05));
    var h = dt / steps;
    for (var i = 0; i < steps; i++) step(h);
  }

  function step(h) {
    sim.t += h;

    /* ---- exhauster ---- */
    var wanted =
      sim.motorMode === "RUN" ||
      (sim.motorMode === "AUTO" && sim.receiverPsi < CUTOUT_PSI);
    if (
      sim.motorMode === "AUTO" &&
      sim.motorRunning &&
      sim.receiverPsi >= CUTOUT_PSI
    )
      wanted = false;
    if (
      sim.motorMode === "AUTO" &&
      !sim.motorRunning &&
      sim.receiverPsi <= CUTIN_PSI
    )
      wanted = true;
    sim.motorRunning = !!wanted && !sim.motorLocked;

    /* ---- receiver ---- */
    if (sim.motorRunning)
      sim.receiverPsi += 1.45 * (1 - sim.receiverPsi / 96) * h;
    if (sim.shotBlastLeft > 0) {
      sim.receiverPsi -= 0.32 * h;
      sim.shotBlastLeft -= h;
    }
    sim.receiverPsi -= 0.008 * h; // standing gland loss
    if (sim.receiverPsi < 0) sim.receiverPsi = 0;

    /* ---- relief valve ---- */
    if (!sim.reliefLifted && sim.receiverPsi >= RELIEF_PSI) {
      sim.reliefLifted = true;
      latch("relief valve lifted");
      sfx.hiss();
      note("RELIEF VALVE LIFTED — TAKE THE STARTER TO AUTO OR OFF");
    }
    if (sim.reliefLifted) {
      sim.receiverPsi = Math.min(sim.receiverPsi, RELIEF_PSI);
      if (sim.receiverPsi < 86) {
        sim.reliefLifted = false;
        unlatch("relief valve lifted");
        note("RELIEF VALVE SEATED");
      }
    }

    /* ---- reducing valve holds the main ---- */
    var set = sim.setpointPsi;
    var riseCap = 1.7 * clamp((sim.receiverPsi - sim.linePsi - 4) / 10, 0, 1);
    var rise = clamp((set - sim.linePsi) * 0.5, -2.2, riseCap);

    // LO detent vents the main; branches weep a little at all times
    var standingDraw = 0.05 + (set <= 12.5 ? 1.15 : 0);

    sim.linePsi += rise * h;
    sim.linePsi -= standingDraw * h;
    if (sim.leakActive) sim.linePsi -= 1.05 * h;
    if (sim.purgeOpen) sim.linePsi -= 2.6 * h;
    sim.linePsi = clamp(sim.linePsi, 0, 40);

    /* ---- gasket leak: announces itself, reseats cold ---- */
    if (sim.leakActive) {
      latch("air main gasket leak");
      if (sim.linePsi <= RESEAT_PSI) {
        sim.leakBelowTimer += h;
        if (sim.leakBelowTimer >= 5) {
          sim.leakActive = false;
          sim.leakBelowTimer = 0;
          unlatch("air main gasket leak");
          note("GASKET RESEATED COLD — RESTORE THE REGULATOR AND RECHARGE");
        }
      } else {
        sim.leakBelowTimer = 0;
      }
    } else {
      sim.leakBelowTimer = 0;
    }

    /* ---- low main pressure ---- */
    // only after the main has stood at working pressure: a climbing main
    // on start-up is not an alarm, a falling one is
    if (sim.linePsi >= Math.max(set - 4, 14)) sim.lineHealthy = true;
    if (
      (sim.motorRunning || sim.purgeOpen || sim.leakActive) &&
      sim.lineHealthy &&
      sim.linePsi < Math.max(set - 8, 12) &&
      sim.t > 4
    )
      latch("line pressure low");
    else unlatch("line pressure low");

    /* ---- temperature ---- */
    var load = 0;
    if (sim.motorRunning) {
      load = 0.3 + 0.55 * clamp((CUTOUT_PSI - sim.receiverPsi) / 40, 0, 1);
      if (sim.purgeOpen) load += 0.5;
      if (sim.leakActive) load += 0.5;
      if (sim.reliefLifted) load += 0.4;
    }
    if (sim.heatFault && !sim.heatFaultSpent) load += 6;

    sim.temperatureC += (load - (sim.temperatureC - AMBIENT_C) * 0.05) * h;
    sim.temperatureC = clamp(sim.temperatureC, AMBIENT_C, 220);

    if (!sim.motorLocked && sim.temperatureC >= TRIP_C) {
      sim.motorLocked = true;
      sim.motorRunning = false;
      latch("exhauster overheat");
      sfx.clack();
      note("OVERLOAD TRIP — LET THE HEAD COOL BELOW 70°C, THEN PLANT RESET");
    }
    if (sim.heatFault && !sim.heatFaultSpent && sim.temperatureC >= TRIP_C)
      sim.heatFaultSpent = true;
    if (sim.motorLocked && !sim.heatFault && sim.temperatureC < RELIGHT_C)
      note("HEAD COOL — PRESS PLANT RESET TO FREE THE STARTER");

    /* ---- our carrier ---- */
    fly(h);

    /* ---- reverse purge ---- */
    if (sim.purgeOpen) {
      sim.purgeTimer += h;
      if (sim.jammed) {
        if (sim.jamIsReal) {
          sim.carrierV = -26;
          sim.carrierFt += sim.carrierV * h;
          if (sim.carrierFt <= 2) clearJam();
        } else if (sim.purgeTimer >= 6) {
          clearJam();
        }
      }
    } else {
      sim.purgeTimer = 0;
    }

    /* ---- department keeps the carrier, then returns it ---- */
    if (sim.carrierWhere === "department") {
      sim.deptHold -= h;
      if (sim.deptHold <= 0) {
        if (sim.linePsi >= 12) {
          sim.carrierWhere = "returning";
          sim.carrierFt = STATIONS[sim.destIndex].ft;
          sim.carrierV = 0;
          stationJewel(sim.destIndex, false);
          note("DEPARTMENT HAS SENT IT BACK — COMING HOME ON THE RETURN");
        } else {
          sim.deptHold = 4;
        }
      }
    }

    /* ---- inbound traffic on the home run ---- */
    inboundStep(h);

    if (sim.lampsTesting > 0) sim.lampsTesting -= h;
  }

  function clearJam() {
    sim.jammed = false;
    sim.jamIsReal = false;
    sim.carrierWhere = "breech";
    sim.carrierFt = 0;
    sim.carrierV = 0;
    unlatch("carrier jammed in the line");
    sfx.thunk();
    note("CARRIER DRAWN HOME — SHUT THE PURGE VALVE");
  }

  /* ------------------------------------------------------- carrier math */

  function fly(h) {
    if (sim.carrierWhere !== "outbound" && sim.carrierWhere !== "returning")
      return;

    if (sim.carrierWhere === "outbound") {
      sim.shotAge += h;
      var drive = 0;
      if (sim.linePsi > WEAK_PSI)
        drive =
          (9 * Math.pow(sim.linePsi - 14, 0.85)) / (1 + sim.carrierV / 40);
      var drag = 0.02 * sim.carrierV * sim.carrierV + 0.4 * sim.carrierV;
      if (sim.carrierFt >= LINE_FT - 14) {
        // terminal arrester sucks her into the receiving box
        sim.carrierV += (34 * h * (LINE_FT - sim.carrierFt)) / 14 - 26 * h;
        sim.carrierV = Math.max(sim.carrierV, 6);
        sim.carrierFt += sim.carrierV * h;
      } else {
        sim.carrierV += (drive - drag) * h;
        if (sim.carrierV < 0) sim.carrierV = 0;
        sim.carrierFt += sim.carrierV * h;
      }

      if (sim.carrierFt >= LINE_FT) {
        sim.carrierFt = LINE_FT;
        sim.carrierWhere = "department";
        sim.destIndex = sim.stationIndex;
        sim.deptHold = 14 + rngNext() * 14;
        stationJewel(sim.destIndex, true);
        sfx.gong();
        note(
          "CARRIER ARRIVED AT " + STATIONS[sim.destIndex].name + " — JEWEL LIT",
        );
        return;
      }
      if (sim.carrierV < 0.8 && sim.linePsi < WEAK_PSI && sim.shotAge > 2.5) {
        sim.jammed = true;
        sim.jamIsReal = true;
        latch("carrier jammed in the line");
        note(
          "CARRIER STALLED AT " +
            Math.round(sim.carrierFt) +
            " FT — MAIN TOO WEAK. REVERSE PURGE HER HOME",
        );
      }
    } else {
      // the exhauster's suction works the home run
      var suck = sim.linePsi >= 12 ? 30 : 0;
      sim.carrierV +=
        (suck - 0.015 * sim.carrierV * sim.carrierV - 0.4 * sim.carrierV) * h;
      if (sim.carrierV < 0) sim.carrierV = 0;
      sim.carrierFt -= sim.carrierV * h;
      if (sim.carrierFt <= 2) {
        sim.carrierWhere = "breech";
        sim.carrierFt = 0;
        sim.carrierV = 0;
        sfx.thunk();
        note("RETURNED CARRIER SEATED AT THE BREECH — READY TO DESPATCH");
      }
    }
  }

  function inboundStep(h) {
    if (sim.inboundActive) {
      var v = sim.inboundV;
      v += (26 - 0.02 * v * v - 0.4 * v) * h;
      if (v < 0) v = 0;
      sim.inboundV = v;
      sim.inboundFt -= v * h;
      if (sim.inboundFt <= 2) {
        sim.inboundActive = false;
        sim.boxCount++;
        sfx.gong();
        note(
          "CARRIER IN FROM " +
            STATIONS[sim.inboundFrom].name +
            " — PRESS THE RECEIVE DOOR",
        );
        sim.nextInbound = sim.t + 55 + rngNext() * 70;
      }
    } else if (sim.linePsi >= 16 && sim.t >= sim.nextInbound) {
      sim.inboundActive = true;
      sim.inboundFrom = Math.floor(rngNext() * STATIONS.length);
      sim.inboundFt = STATIONS[sim.inboundFrom].ft;
      sim.inboundV = 6;
    }
  }

  /* -------------------------------------------------------- operations */

  function despatchAttempt() {
    if (sim.gateOpen) {
      sfx.clack();
      note("THE SLEEVE GATE IS OPEN — CLOSE IT BEFORE YOU DESPATCH");
      return;
    }
    if (sim.carrierWhere !== "breech") {
      sfx.clack();
      note("NO CARRIER AT THE BREECH");
      return;
    }
    if (sim.jammed) {
      sfx.clack();
      note("LINE REPORTED OBSTRUCTED — PURGE IT CLEAR FIRST");
      return;
    }
    sim.carrierWhere = "outbound";
    sim.carrierFt = 0;
    sim.carrierV = 4;
    sim.shotAge = 0;
    sim.shotBlastLeft = 1.2;
    sim.linePsi = Math.max(0, sim.linePsi - 3.5);
    sfx.whoosh();
    note(
      "DESPATCHING TO " +
        STATIONS[sim.stationIndex].name +
        " — " +
        Math.round(sim.linePsi) +
        " LB ON THE MAIN",
    );
  }

  function inject(fault) {
    var f = String(fault == null ? "" : fault)
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      sim.jammed = true;
      if (sim.carrierWhere === "outbound") {
        sim.jamIsReal = true;
        sim.carrierV = 0;
      } else {
        sim.jamIsReal = false;
      }
      latch("carrier jammed in the line");
      note("TEST OBSTRUCTION INSERTED — LINE ANNUNCIATES JAM");
      return true;
    }
    if (f === FAULTS[1]) {
      sim.leakActive = true;
      sim.leakBelowTimer = 0;
      latch("air main gasket leak");
      note("JOINT GASKET BLOWN — MAIN FALLING. VENT HER COLD TO RESEAT");
      return true;
    }
    if (f === FAULTS[2]) {
      sim.heatFault = true;
      sim.heatFaultSpent = false;
      note("BEARING RUNNING HOT — TEMPERATURE CLIMBING");
      return true;
    }
    return false;
  }

  function reset() {
    var soundWasCut = sim ? sim.soundCut : false;
    sim = freshSim();
    sim.rngState = sim.seed;
    sim.soundCut = !!soundWasCut;
    alarmLatched = {};
    annAccepted = true;
    lastNote = "";
    note("PLANT AT REST — SET THE EXHAUSTER TO RUN");
  }

  function state() {
    return {
      name: MACHINE_NAME,
      time: round(sim.t),
      clock: clockString(),
      receiverPsi: round(sim.receiverPsi),
      linePsi: round(sim.linePsi),
      setpointPsi: round(sim.setpointPsi),
      temperatureC: round(sim.temperatureC),
      motorMode: sim.motorMode,
      motorRunning: sim.motorRunning,
      starterTripped: sim.motorLocked,
      reliefLifted: sim.reliefLifted,
      station: STATIONS[sim.stationIndex].name,
      gateOpen: sim.gateOpen,
      lever: sim.lever,
      purgeOpen: sim.purgeOpen,
      carrier: {
        where: sim.carrierWhere,
        feetOut: round(sim.carrierFt),
        feetPerSecond: round(Math.abs(sim.carrierV)),
      },
      carriersOut: sim.carrierWhere === "breech" ? 0 : 1,
      inboundCarriers: sim.inboundActive ? 1 : 0,
      receiveBoxCount: sim.boxCount,
      trayCount: sim.trayCount,
      jammed: sim.jammed,
      leakActive: sim.leakActive,
      overheatTrip: sim.motorLocked,
      soundCut: !!sim.soundCut,
      alarms: Object.keys(alarmLatched),
    };
  }

  function round(v) {
    return Math.round(v * 100) / 100;
  }

  function clockString() {
    var s = 9 * 3600 + Math.floor(sim.t);
    var m = Math.floor(s / 60) % 60;
    var hh = Math.floor(s / 3600) % 24;
    return (hh < 10 ? "0" : "") + hh + ":" + (m < 10 ? "0" : "") + m;
  }

  /* ---------------------------------------------------------- sound fx */

  var actx = null;
  var buzzerGain = null;
  var sfx = {
    clack: function () {},
    whoosh: function () {},
    gong: function () {},
    thunk: function () {},
    hiss: function () {},
  };

  function muted() {
    return !actx || sim.soundCut;
  }

  function initAudio() {
    if (actx) {
      if (actx.state === "suspended") actx.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();

    function env(g, t0, peak, decay) {
      g.setValueAtTime(0.0001, t0);
      g.exponentialRampToValueAtTime(peak, t0 + 0.012);
      g.exponentialRampToValueAtTime(0.0001, t0 + decay);
    }
    function noiseBuffer(seconds) {
      var buf = actx.createBuffer(
        1,
        Math.max(1, Math.floor(actx.sampleRate * seconds)),
        actx.sampleRate,
      );
      var d = buf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    sfx.clack = function () {
      if (muted()) return;
      var t = actx.currentTime;
      var src = actx.createBufferSource();
      src.buffer = noiseBuffer(0.06);
      var f = actx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 2600;
      var g = actx.createGain();
      env(g.gain, t, 0.2, 0.07);
      src.connect(f).connect(g).connect(actx.destination);
      src.start(t);
    };

    sfx.whoosh = function () {
      if (muted()) return;
      var t = actx.currentTime;
      var src = actx.createBufferSource();
      src.buffer = noiseBuffer(1.4);
      var f = actx.createBiquadFilter();
      f.type = "bandpass";
      f.Q.value = 1.1;
      f.frequency.setValueAtTime(500, t);
      f.frequency.exponentialRampToValueAtTime(2400, t + 0.5);
      f.frequency.exponentialRampToValueAtTime(700, t + 1.3);
      var g = actx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
      src.connect(f).connect(g).connect(actx.destination);
      src.start(t);
    };

    sfx.gong = function () {
      if (muted()) return;
      var t = actx.currentTime;
      [660, 991, 1322].forEach(function (hz, i) {
        var o = actx.createOscillator();
        o.type = "triangle";
        o.frequency.value = hz * (i ? 1.003 : 0.998);
        var g = actx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(i ? 0.07 : 0.2, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5 - i * 0.35);
        o.connect(g).connect(actx.destination);
        o.start(t);
        o.stop(t + 1.7);
      });
    };

    sfx.thunk = function () {
      if (muted()) return;
      var t = actx.currentTime;
      var o = actx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.16);
      var g = actx.createGain();
      env(g.gain, t, 0.35, 0.22);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + 0.3);
    };

    sfx.hiss = function () {
      if (muted()) return;
      var t = actx.currentTime;
      var src = actx.createBufferSource();
      src.buffer = noiseBuffer(1.6);
      var f = actx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = 3800;
      var g = actx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      src.connect(f).connect(g).connect(actx.destination);
      src.start(t);
    };

    // alarm buzzer: pulsed while an alarm stands unaccepted
    var o = actx.createOscillator();
    o.type = "square";
    o.frequency.value = 330;
    buzzerGain = actx.createGain();
    buzzerGain.gain.value = 0;
    o.connect(buzzerGain).connect(actx.destination);
    o.start();
    setInterval(function () {
      if (!buzzerGain) return;
      var anyAlarm = Object.keys(alarmLatched).length > 0;
      if (anyAlarm && !annAccepted && actx && !sim.soundCut) {
        buzzerGain.gain.setValueAtTime(0.045, actx.currentTime);
        buzzerGain.gain.exponentialRampToValueAtTime(
          0.0001,
          actx.currentTime + 0.42,
        );
      }
    }, 640);
  }

  /* ------------------------------------------------------------ markup */

  var $ = function (id) {
    return document.getElementById(id);
  };
  var el = {};

  function buildMimic() {
    var NS = "http://www.w3.org/2000/svg";
    var row = $("stationRow");
    var X0 = 78;
    var X1 = 946;

    function fx(ft) {
      return X0 + (ft / LINE_FT) * (X1 - X0);
    }

    STATIONS.forEach(function (st, i) {
      var x = fx(st.ft);
      var g = document.createElementNS(NS, "g");

      var stem = document.createElementNS(NS, "line");
      stem.setAttribute("x1", x);
      stem.setAttribute("y1", 62);
      stem.setAttribute("x2", x);
      stem.setAttribute("y2", 30);
      stem.setAttribute("class", "station-stem");
      g.appendChild(stem);

      var plaque = document.createElementNS(NS, "rect");
      plaque.setAttribute("x", x - 41);
      plaque.setAttribute("y", 10);
      plaque.setAttribute("width", 82);
      plaque.setAttribute("height", 19);
      plaque.setAttribute("rx", 2);
      plaque.setAttribute("class", "station-plaque");
      g.appendChild(plaque);

      var label = document.createElementNS(NS, "text");
      label.setAttribute("x", x);
      label.setAttribute("y", 23.5);
      label.setAttribute("class", "station-name");
      label.textContent = st.name;
      g.appendChild(label);

      var cup = document.createElementNS(NS, "circle");
      cup.setAttribute("cx", x);
      cup.setAttribute("cy", 62);
      cup.setAttribute("r", 8.5);
      cup.setAttribute("class", "jewel-cup");
      g.appendChild(cup);

      var glass = document.createElementNS(NS, "circle");
      glass.setAttribute("cx", x);
      glass.setAttribute("cy", 62);
      glass.setAttribute("r", 5.5);
      glass.setAttribute("class", "jewel-glass");
      glass.setAttribute("id", "stJewel" + i);
      g.appendChild(glass);

      row.appendChild(g);
    });

    var scale = $("scaleRow");
    for (var ft = 0; ft <= LINE_FT; ft += 45) {
      var x = fx(ft);
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", x);
      ln.setAttribute("y1", 182);
      ln.setAttribute("x2", x);
      ln.setAttribute("y2", 192);
      scale.appendChild(ln);
      var tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", x);
      tx.setAttribute("y", 202);
      tx.textContent =
        ft === 0 ? "0 FT" : ft === LINE_FT ? ft + " FT" : String(ft);
      scale.appendChild(tx);
    }

    // second carrier for inbound traffic on the return run
    var f2 = document.createElementNS(NS, "g");
    f2.setAttribute("id", "flyer2");
    f2.style.display = "none";
    var cr = document.createElementNS(NS, "rect");
    cr.setAttribute("x", -16);
    cr.setAttribute("y", -9);
    cr.setAttribute("width", 32);
    cr.setAttribute("height", 18);
    cr.setAttribute("rx", 8);
    cr.setAttribute("class", "carrier felt");
    var band = document.createElementNS(NS, "rect");
    band.setAttribute("x", 6);
    band.setAttribute("y", -9);
    band.setAttribute("width", 4);
    band.setAttribute("height", 18);
    band.setAttribute("class", "carrier-band");
    f2.appendChild(cr);
    f2.appendChild(band);
    document.querySelector(".mimic").appendChild(f2);
  }

  function buildDial(tickGroup, labelGroup, max, majorStep, redZone) {
    var NS = "http://www.w3.org/2000/svg";
    var cx = 60;
    var cy = 66;
    var rOut = 45;
    function angFor(v) {
      return -118 + (v / max) * 236;
    }
    for (var v = 0; v <= max + 0.01; v += majorStep / 2) {
      var major = Math.abs(v % majorStep) < 0.01;
      var a = ((angFor(v) - 90) * Math.PI) / 180;
      var rIn = major ? rOut - 8 : rOut - 4.5;
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", cx + rIn * Math.cos(a));
      ln.setAttribute("y1", cy + rIn * Math.sin(a));
      ln.setAttribute("x2", cx + rOut * Math.cos(a));
      ln.setAttribute("y2", cy + rOut * Math.sin(a));
      ln.setAttribute("class", major ? "dial-tick-major" : "dial-tick");
      tickGroup.appendChild(ln);
      if (major) {
        var tx = document.createElementNS(NS, "text");
        tx.setAttribute("x", cx + (rOut - 16) * Math.cos(a));
        tx.setAttribute("y", cy + (rOut - 16) * Math.sin(a) + 4);
        tx.setAttribute("class", "dial-num");
        tx.textContent = String(Math.round(v));
        labelGroup.appendChild(tx);
      }
    }
    if (redZone) {
      var pth = document.createElementNS(NS, "path");
      var a0 = ((angFor(redZone[0]) - 90) * Math.PI) / 180;
      var a1 = ((angFor(redZone[1]) - 90) * Math.PI) / 180;
      var rr = rOut + 2;
      pth.setAttribute(
        "d",
        "M" +
          (cx + rr * Math.cos(a0)).toFixed(1) +
          " " +
          (cy + rr * Math.sin(a0)).toFixed(1) +
          " A " +
          rr +
          " " +
          rr +
          " 0 0 1 " +
          (cx + rr * Math.cos(a1)).toFixed(1) +
          " " +
          (cy + rr * Math.sin(a1)).toFixed(1),
      );
      pth.setAttribute("class", "dial-redzone");
      tickGroup.parentNode.insertBefore(pth, tickGroup);
    }
  }

  /* ----------------------------------------------------------- render */

  var lastNote = "";
  function note(msg) {
    lastNote = msg;
  }

  function setNeedle(node, value, max) {
    var ang = -118 + clamp(value / max, 0, 1) * 236;
    node.setAttribute("transform", "rotate(" + ang.toFixed(1) + " 60 66)");
  }

  function stationJewel(index, on) {
    var j = $("stJewel" + index);
    if (j) j.classList.toggle("is-on", on);
  }

  function renderJewelsTest() {
    STATIONS.forEach(function (_, i) {
      var j = $("stJewel" + i);
      if (j) {
        j.classList.add("test-flash");
        setTimeout(function () {
          j.classList.remove("test-flash");
        }, 550);
      }
    });
  }

  function paintAnn(node, name, isRed) {
    var on = !!alarmLatched[name];
    node.classList.toggle("lit", on);
    node.classList.toggle("alarm-red", on && isRed);
    node.classList.toggle("flash", on && !annAccepted);
  }

  function render() {
    var s = sim;

    setNeedle(el.recvNeedle, s.receiverPsi, 100);
    setNeedle(el.lineNeedle, s.linePsi, 40);

    var pct = clamp(
      ((s.temperatureC - AMBIENT_C) / (TRIP_C - AMBIENT_C)) * 100,
      0,
      100,
    );
    el.thermoFill.style.width = pct.toFixed(1) + "%";
    el.tripFlag.classList.toggle("on", s.motorLocked);
    el.tempRead.textContent = String(Math.round(s.temperatureC));

    el.starterFace.style.setProperty(
      "--rot",
      { OFF: "-50deg", AUTO: "0deg", RUN: "50deg" }[s.motorMode],
    );
    el.purgeFace.style.setProperty("--rot", s.purgeOpen ? "90deg" : "0deg");

    el.drumKnob.style.setProperty("--rot", s.stationIndex * 45 + "deg");
    el.stationWindow.textContent = STATIONS[s.stationIndex].name;

    el.lvArm.style.setProperty(
      "--lv",
      { VENT: "-88deg", HOLD: "0deg", DESPATCH: "80deg" }[s.lever],
    );

    el.gateToggle.setAttribute("aria-pressed", s.gateOpen ? "true" : "false");
    el.gateToggle.classList.toggle("open-guard", s.gateOpen);

    var seated = s.carrierWhere === "breech";
    el.bwCarrier.classList.toggle("hidden", !seated);
    el.breechTag.textContent = seated
      ? "CARRIER SEATED"
      : s.carrierWhere === "outbound"
        ? "ON THE OUT RUN"
        : s.carrierWhere === "department"
          ? "AT " + STATIONS[s.destIndex].name
          : "COMING HOME";

    var flying =
      s.carrierWhere === "outbound" || s.carrierWhere === "returning";
    el.flyer.style.display = flying ? "" : "none";
    if (flying) {
      var x = 78 + (s.carrierFt / LINE_FT) * (946 - 78);
      var y = s.carrierWhere === "outbound" ? 62 : 136;
      el.flyer.setAttribute(
        "transform",
        "translate(" + x.toFixed(1) + " " + y + ")",
      );
    }
    el.breechSvgCarrier.style.display = seated ? "" : "none";

    var inb = $("flyer2");
    if (inb) {
      if (s.inboundActive) {
        var ix = 78 + (s.inboundFt / LINE_FT) * (946 - 78);
        inb.style.display = "";
        inb.setAttribute("transform", "translate(" + ix.toFixed(1) + " 136)");
      } else {
        inb.style.display = "none";
      }
    }

    el.circCount.textContent = String(
      (seated ? 1 : 2) + (s.inboundActive ? 1 : 0),
    );
    el.trayCount.textContent = String(s.trayCount);
    el.boxRead.textContent =
      s.boxCount > 0 ? "RECEIVE BOX HOLDS " + s.boxCount : "RECEIVE BOX EMPTY";

    paintAnn(el.annLow, "line pressure low", false);
    paintAnn(el.annJam, "carrier jammed in the line", true);
    paintAnn(el.annLeak, "air main gasket leak", true);
    paintAnn(el.annHeat, "exhauster overheat", true);
    paintAnn(el.annRelief, "relief valve lifted", false);

    el.noteLine.textContent = lastNote;
  }

  /* ------------------------------------------------------ control wire */

  function setStation(i) {
    sim.stationIndex = i;
    sfx.clack();
    note("SELECTED " + STATIONS[i].name + " AT " + STATIONS[i].ft + " FEET");
  }

  function cycleStarter(mode) {
    if (sim.motorLocked && mode !== "OFF") {
      note("OVERLOAD TRIP — LET HER COOL, THEN PLANT RESET");
      return;
    }
    if (sim.motorMode === mode) return;
    sim.motorMode = mode;
    note(
      mode === "OFF"
        ? "EXHAUSTER STOPPED"
        : mode === "AUTO"
          ? "STARTER TO AUTO — PRESSURE SWITCH WILL MIND THE RECEIVER"
          : "STARTER TO RUN — SHE CHARGES WITHOUT STOPPING",
    );
  }

  function holdButton(btn, onDown, onUp) {
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      btn.classList.add("pressed");
      onDown();
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      btn.addEventListener(ev, function () {
        if (btn.classList.contains("pressed")) {
          btn.classList.remove("pressed");
          onUp();
        }
      });
    });
  }

  var faultButtons = [];
  function bindFaultSwitch(btn, faultName) {
    faultButtons.push(btn);
    btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) inject(faultName);
      else note("TEST SWITCH DOWN — CONDITION REMAINS UNTIL CLEARED");
    });
  }
  function springFaultSwitches() {
    faultButtons.forEach(function (b) {
      b.setAttribute("aria-pressed", "false");
    });
  }

  function bindControls() {
    // EXHAUSTER SET starter: OFF → AUTO → RUN → OFF
    el.starterBtn.addEventListener("click", function () {
      sfx.clack();
      cycleStarter(
        sim.motorMode === "OFF"
          ? "AUTO"
          : sim.motorMode === "AUTO"
            ? "RUN"
            : "OFF",
      );
    });
    el.starterBtn.addEventListener("keydown", function (e) {
      var order = ["OFF", "AUTO", "RUN"];
      var idx = order.indexOf(sim.motorMode);
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        cycleStarter(order[Math.min(order.length - 1, idx + 1)]);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        cycleStarter(order[Math.max(0, idx - 1)]);
      }
    });

    el.regInput.addEventListener("input", function () {
      sim.setpointPsi = Number(el.regInput.value);
      note(
        sim.setpointPsi <= 12.5
          ? "REGULATOR AT LO — THE MAIN WILL VENT"
          : "REGULATOR SET TO " + sim.setpointPsi + " LB ON THE MAIN",
      );
    });

    el.drum.addEventListener("click", function () {
      setStation((sim.stationIndex + 1) % STATIONS.length);
    });
    el.drum.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        setStation((sim.stationIndex + 1) % STATIONS.length);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        setStation((sim.stationIndex + STATIONS.length - 1) % STATIONS.length);
      }
    });

    el.gateToggle.addEventListener("click", function () {
      if (sim.carrierWhere === "outbound" || sim.carrierWhere === "returning") {
        sfx.clack();
        note("A CARRIER IS IN FLIGHT — THE BREECH MUST STAY CLOSED");
        return;
      }
      sim.gateOpen = !sim.gateOpen;
      sfx.clack();
      note(
        sim.gateOpen
          ? "GATE OPEN — SEAT THE CARRIER, THEN CLOSE HER"
          : "GATE CLOSED AND SEALED",
      );
    });

    holdButton(
      el.despatchLever,
      function () {
        sim.lever = "DESPATCH";
        despatchAttempt();
      },
      function () {
        sim.lever = "HOLD";
      },
    );
    el.despatchLever.addEventListener("keydown", function (e) {
      if (
        (e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") &&
        !e.repeat
      ) {
        e.preventDefault();
        sim.lever = "DESPATCH";
        despatchAttempt();
      } else if (e.key === "ArrowDown" && !e.repeat) {
        e.preventDefault();
        sim.lever = "VENT";
        note("LEVER AT VENT — NO AIR HELD BEHIND THE CARRIER");
      }
    });
    el.despatchLever.addEventListener("keyup", function (e) {
      if (["ArrowUp", "Enter", " ", "ArrowDown"].indexOf(e.key) !== -1) {
        sim.lever = "HOLD";
      }
    });

    el.receiveDoor.addEventListener("click", function () {
      sfx.thunk();
      if (sim.boxCount > 0) {
        sim.trayCount += sim.boxCount;
        note(
          sim.boxCount +
            " CARRIER" +
            (sim.boxCount > 1 ? "S" : "") +
            " RELEASED INTO THE IN-TRAY",
        );
        sim.boxCount = 0;
      } else {
        note("RECEIVE BOX EMPTY");
      }
    });

    el.purgeBtn.addEventListener("click", function () {
      sim.purgeOpen = !sim.purgeOpen;
      el.purgeBtn.setAttribute(
        "aria-pressed",
        sim.purgeOpen ? "true" : "false",
      );
      sfx.hiss();
      note(
        sim.purgeOpen
          ? "PURGE OPEN — SHE WILL DRAW A STALLED CARRIER HOME, AND SHE WILL VENT THE MAIN WHILE OPEN"
          : "PURGE SHUT",
      );
    });

    el.acceptBtn.addEventListener("click", function () {
      annAccepted = true;
      sfx.clack();
    });

    el.lampsBtn.addEventListener("click", function () {
      sim.lampsTesting = 0.8;
      renderJewelsTest();
      [el.annLow, el.annJam, el.annLeak, el.annHeat, el.annRelief].forEach(
        function (n) {
          n.classList.add("test-flash");
          setTimeout(function () {
            n.classList.remove("test-flash");
          }, 550);
        },
      );
      sfx.clack();
    });

    el.resetBtn.addEventListener("click", function () {
      var hadTrouble =
        sim.jammed ||
        sim.leakActive ||
        sim.heatFault ||
        sim.motorLocked ||
        Object.keys(alarmLatched).length > 0;
      sim.jammed = false;
      sim.jamIsReal = false;
      sim.leakActive = false;
      sim.heatFault = false;
      sim.heatFaultSpent = false;
      if (sim.temperatureC < RELIGHT_C) sim.motorLocked = false;
      sim.purgeOpen = false;
      el.purgeBtn.setAttribute("aria-pressed", "false");
      springFaultSwitches();
      alarmLatched = {};
      annAccepted = true;
      sfx.clack();
      note(
        sim.motorLocked
          ? "STILL TOO HOT — LET HER COOL BELOW 70°C AND RESET AGAIN"
          : hadTrouble
            ? "PLANT RESET — TROUBLE CLEARED, TEST SWITCHES SPRUNG OFF"
            : "PLANT RESET",
      );
    });

    el.soundBtn.addEventListener("click", function () {
      sim.soundCut = !sim.soundCut;
      el.soundBtn.setAttribute("aria-pressed", sim.soundCut ? "true" : "false");
    });

    bindFaultSwitch($("ftJam"), FAULTS[0]);
    bindFaultSwitch($("ftLeak"), FAULTS[1]);
    bindFaultSwitch($("ftHeat"), FAULTS[2]);

    // audio unlocks on the visitor's first gesture anywhere
    window.addEventListener("pointerdown", initAudio);
    window.addEventListener("keydown", initAudio);
  }

  /* ------------------------------------------------------------- boot */

  function grab() {
    el.clock = $("dutyClock");
    el.recvNeedle = $("recvNeedle");
    el.lineNeedle = $("lineNeedle");
    el.thermoFill = $("thermoFill");
    el.tripFlag = $("tripFlag");
    el.tempRead = $("tempRead");
    el.starterFace = document.querySelector("#motorStarter .rot-face");
    el.purgeFace = document.querySelector("#purgeValve .rot-face");
    el.drumKnob = document.querySelector("#stationDrum .drum-knob");
    el.stationWindow = $("stationWindow");
    el.lvArm = document.querySelector("#despatchLever .lv-arm");
    el.gateToggle = $("gateToggle");
    el.bwCarrier = document.querySelector(".bw-carrier");
    el.breechTag = $("breechTag");
    el.flyer = $("flyer");
    el.breechSvgCarrier = $("breechCarrier");
    el.circCount = $("circCount");
    el.trayCount = $("trayCount");
    el.boxRead = $("boxRead");
    el.annLow = $("annLow");
    el.annJam = $("annJam");
    el.annLeak = $("annLeak");
    el.annHeat = $("annHeat");
    el.annRelief = $("annRelief");
    el.noteLine = $("noteLine");
    el.starterBtn = $("motorStarter");
    el.regInput = $("regulatorInput");
    el.drum = $("stationDrum");
    el.despatchLever = $("despatchLever");
    el.receiveDoor = $("receiveDoor");
    el.purgeBtn = $("purgeValve");
    el.acceptBtn = $("acceptBtn");
    el.lampsBtn = $("lampsBtn");
    el.resetBtn = $("resetBtn");
    el.soundBtn = $("soundBtn");
  }

  function bindManual() {
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
          dlg.close();
        });
      },
    );
  }

  var lastTs = null;
  var rafId = null;

  function loop(ts) {
    if (lastTs === null) lastTs = ts;
    var dt = Math.min((ts - lastTs) / 1000, 0.25);
    lastTs = ts;
    tick(dt);
    render();
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId === null) {
      lastTs = null;
      rafId = requestAnimationFrame(loop);
    }
  }
  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopLoop();
    else startLoop();
  });

  reset();
  grab();
  buildMimic();
  buildDial($("recvTicks"), $("recvLabels"), 100, 20, null);
  buildDial($("lineTicks"), $("lineLabels"), 40, 10, [0, 14]);
  bindControls();
  bindManual();
  startLoop();
})();
