/* ============================================================
   M/T CORALLINE — CARGO DISCHARGE CONSOLE · plant simulation
   Helsingør Værft instruments department, panel CCC-2, 1972.

   Three centre tanks discharge ashore through two shore valves,
   a common suction header and three steam-turbine cargo pumps.
   Coupled quantities: tank levels, pump flows, shore line
   pressure, inert-gas oxygen, ballast trim and the hull bending
   moment they all conspire to bend.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- plant constants ---------------- */

  var TANK_M3 = 3280; // each centre tank, 100 %
  var PUMP_MAX = 26; // m³/min at full throttle
  var BM_SCALE = 130; // tm per % of mid/ends imbalance
  var TRIM_SCALE = 95; // tm per % of signed ballast trim
  var BALLAST_LIMIT = 72; // % of ballast capacity either way
  var STRESS_WARN = 6000; // tm
  var STRESS_DAMAGE = 7500; // tm, sustained
  var TIME_SCALE = 25; // console clock runs 25× ship time
  var DAMAGE_TIME = 40; // seconds at or beyond damage stress
  var PRESSURE_TRIP = 10; // bar
  var PRESSURE_ALARM = 8.5; // bar
  var FLOW_KPA = 0.045; // bar per m³/min against the terminal
  var OXYGEN_LIMIT = 8; // %
  var VAPOUR_AT = 13; // % O2 that will find a spark
  var VAPOUR_TIME = 50; // seconds of pumping above that

  var FAULT_CAV = "cargo pump cavitation";
  var FAULT_JAM = "valve actuator jam";
  var FAULT_IG = "inert gas generator failure";

  /* ---------------- plant state ---------------- */

  var plant;

  function coldPlant() {
    return {
      time: 0,
      levels: { t1: 96, t3: 96, t5: 96 },
      valves: { sealine: false, riser: false, v1: false, v3: false, v5: false },
      v3Half: false, // actuator parked half-open by the jam
      vent: "CLOSED", // CLOSED | INERTED | OPEN
      oxygen: 3.0,
      pumps: [
        { throttle: 0, flow: 0, health: 1, vib: 0, tripped: false },
        { throttle: 0, flow: 0, health: 1, vib: 0, tripped: false },
        { throttle: 0, flow: 0, health: 1, vib: 0, tripped: false },
      ],
      ballastAuto: false,
      ballast: 0, // signed % : + amidships, − at ends
      pressure: 0,
      totalFlow: 0,
      discharged: 0,
      foulingDp: 0, // pump 2 strainer differential
      hiPressTime: 0,
      damageTime: 0,
      vapourTime: 0,
      hullDamage: false,
      vapourEvent: false,
      faults: { cav: false, jam: false, igfail: false },
      alarms: [],
      acknowledged: {},
    };
  }

  plant = coldPlant();

  /* ---------------- helpers ---------------- */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function round(v, places) {
    var f = Math.pow(10, places === undefined ? 2 : places);
    return Math.round(v * f) / f;
  }

  function pathToShore() {
    return plant.valves.sealine && plant.valves.riser;
  }

  function openTanks() {
    var out = [];
    if (plant.valves.v1 && plant.levels.t1 > 0.4) out.push("t1");
    if (plant.valves.v3 && tankGives("t3")) out.push("t3");
    if (plant.valves.v5 && plant.levels.t5 > 0.4) out.push("t5");
    return out;
  }

  function tankGives(key) {
    return (
      plant.levels[key] > 0.4 &&
      !(key === "t3" && plant.v3Half && plant.levels.t3 <= 0)
    );
  }

  /* ---------------- the simulation proper ---------------- */

  function step(h) {
    plant.time += h;

    /* --- pump 2 strainer fouling --- */
    if (plant.faults.cav)
      plant.foulingDp = clamp(plant.foulingDp + h / 10, 0, 1);
    else plant.foulingDp = clamp(plant.foulingDp - h / 12, 0, 1);
    plant.pumps[1].health = 1 - 0.68 * plant.foulingDp;

    /* --- line-up --- */
    var shore = pathToShore();
    var tanks = openTanks();

    /* --- pump flows --- */
    var avail = [];
    var totalAvail = 0;
    var anyCmd = false;
    for (var i = 0; i < 3; i++) {
      var p = plant.pumps[i];
      var a = p.tripped ? 0 : (p.throttle / 100) * PUMP_MAX * p.health;
      if (p.throttle > 4 && !p.tripped) anyCmd = true;
      avail.push(a);
      totalAvail += a;
    }

    var flow = 0;
    if (shore && tanks.length && totalAvail > 0) {
      /* header delivers whatever the pumps give, shared by open tanks */
      flow = totalAvail;
      var per = flow / tanks.length;
      for (var k = 0; k < tanks.length; k++) {
        var key = tanks[k];
        /* % of tank per console second (clock runs TIME_SCALE x ship time) */
        var ratePct = (((per / TANK_M3) * 100) / 60) * TIME_SCALE;
        plant.levels[key] = Math.max(0, plant.levels[key] - ratePct * h);
      }
      plant.discharged += (flow * TIME_SCALE * h) / 60;
    }

    /* --- pumps fighting a shut line: vibration and pressure --- */
    for (var j = 0; j < 3; j++) {
      var pp = plant.pumps[j];
      var starving = anyCmd && !pp.tripped && (!shore || !tanks.length);
      var fouled =
        j === 1 && plant.foulingDp > 0.4 && pp.throttle > 45 && !pp.tripped;
      if (starving || fouled)
        pp.vib = clamp(pp.vib + (fouled ? 0.022 : 0.05) * h, 0, 1);
      else pp.vib = clamp(pp.vib - 0.05 * h, 0, 1);
      if (pp.vib > 0.94) {
        pp.holdTrip = (pp.holdTrip || 0) + h;
        if (pp.holdTrip > 12) {
          pp.tripped = true;
          pp.holdTrip = 0;
        }
      } else pp.holdTrip = 0;
      pp.flow = shore && tanks.length ? avail[j] * (pp.tripped ? 0 : 1) : 0;
    }
    plant.totalFlow = flow;

    /* --- shore line pressure --- */
    if (anyCmd && !shore) {
      plant.pressure = clamp(plant.pressure + totalAvail * 0.38 * h, 0, 11);
    } else {
      var target = shore ? 2.2 + flow * FLOW_KPA : 0;
      plant.pressure += (target - plant.pressure) * 0.25 * h;
      if (plant.pressure < 0.05 && flow === 0) plant.pressure = 0;
    }
    if (plant.pressure >= PRESSURE_ALARM) {
      if (plant.pressure >= PRESSURE_TRIP) {
        plant.hiPressTime += h;
        if (plant.hiPressTime > 8) {
          for (var t = 0; t < 3; t++) plant.pumps[t].tripped = true;
        }
      } else plant.hiPressTime = 0;
    } else plant.hiPressTime = 0;

    /* --- inert gas / tank atmosphere --- */
    var o2Target, o2Rate;
    if (plant.faults.igfail) {
      o2Target = 21;
      o2Rate = 0.14;
    } else if (plant.vent === "INERTED") {
      o2Target = 1.8;
      o2Rate = 0.02;
    } else if (plant.vent === "OPEN") {
      o2Target = 21;
      o2Rate = 0.1;
    } else {
      o2Target = 4.5;
      o2Rate = 0.004;
    }
    plant.oxygen += clamp(o2Target - plant.oxygen, -o2Rate * h, o2Rate * h);
    plant.oxygen = clamp(plant.oxygen, 0, 21);

    /* --- ballast trim --- */
    var imbalance = plant.levels.t3 - (plant.levels.t1 + plant.levels.t5) / 2;
    if (plant.ballastAuto && !plant.hullDamage) {
      var wanted = clamp(
        (-imbalance * BM_SCALE) / TRIM_SCALE,
        -BALLAST_LIMIT,
        BALLAST_LIMIT,
      );
      var db = clamp(wanted - plant.ballast, -0.5 * h, 0.5 * h);
      plant.ballast = clamp(plant.ballast + db, -BALLAST_LIMIT, BALLAST_LIMIT);
    }
    var bm = imbalance * BM_SCALE - plant.ballast * TRIM_SCALE;
    bm = clamp(bm, -9999, 9999);

    /* --- hull damage: overstress sustained --- */
    if (Math.abs(bm) >= STRESS_DAMAGE && !plant.hullDamage) {
      plant.damageTime += h;
      if (plant.damageTime >= DAMAGE_TIME) {
        plant.hullDamage = true;
        for (var q = 0; q < 3; q++) plant.pumps[q].tripped = true;
      }
    } else if (Math.abs(bm) < STRESS_WARN) {
      plant.damageTime = Math.max(0, plant.damageTime - h * 2);
    }

    /* --- vapour hazard: pumping with air in the tanks --- */
    var pumpingHard = totalAvail > 0.6;
    if (!plant.vapourEvent && plant.oxygen >= VAPOUR_AT && pumpingHard) {
      plant.vapourTime += h;
      if (plant.vapourTime >= VAPOUR_TIME) {
        plant.vapourEvent = true;
        for (var w = 0; w < 3; w++) plant.pumps[w].tripped = true;
      }
    } else if (plant.oxygen < OXYGEN_LIMIT) {
      plant.vapourTime = Math.max(0, plant.vapourTime - h);
    }

    /* --- alarms --- */
    var alarms = [];
    if (plant.oxygen >= OXYGEN_LIMIT) alarms.push("oxygen high");
    if (Math.abs(bm) > STRESS_WARN && !plant.hullDamage)
      alarms.push("hull stress high");
    if (plant.pressure >= PRESSURE_ALARM) alarms.push("line pressure high");
    if (plant.foulingDp > 0.5) alarms.push("pump cavitation");
    for (var c = 0; c < 3; c++) {
      if (plant.pumps[c].vib > 0.55) {
        alarms.push("pump cavitation");
        break;
      }
    }
    var low = false;
    ["v1", "v3", "v5"].forEach(function (vk, idx) {
      var lk = "t" + (idx === 0 ? 1 : idx === 1 ? 3 : 5);
      if (plant.valves[vk] && plant.levels[lk] < 8 && plant.levels[lk] > 0)
        low = true;
    });
    if (low) alarms.push("level low");
    if (plant.faults.jam) alarms.push("valve jam");
    if (plant.hullDamage) alarms.push("hull damage");
    if (plant.vapourEvent) alarms.push("vapour event");

    plant.alarms = alarms;
    plant.lastBm = bm;
    plant.lastImbalance = imbalance;
  }

  function tick(seconds) {
    var remain = clamp(Number(seconds) || 0, 0, 3600);
    while (remain > 1e-6) {
      var h = Math.min(0.25, remain);
      step(h);
      remain -= h;
    }
  }

  /* ---------------- fixed API ---------------- */

  function state() {
    return {
      name: "M/T Coralline Cargo Discharge Console",
      time: round(plant.time, 1),
      alarms: plant.alarms.slice(),
      levels: {
        t1: round(plant.levels.t1, 2),
        t3: round(plant.levels.t3, 2),
        t5: round(plant.levels.t5, 2),
      },
      ballast: round(plant.ballast, 2),
      ballastAuto: plant.ballastAuto,
      vent: plant.vent,
      oxygen: round(plant.oxygen, 2),
      pressure: round(plant.pressure, 2),
      totalFlow: round(plant.totalFlow, 2),
      discharged: round(plant.discharged, 1),
      bendingMoment: round(plant.lastBm || 0, 0),
      valves: {
        sealine: plant.valves.sealine,
        riser: plant.valves.riser,
        v1: plant.valves.v1,
        v3: plant.valves.v3,
        v5: plant.valves.v5,
      },
      pumps: [
        {
          throttle: plant.pumps[0].throttle,
          flow: round(plant.pumps[0].flow, 2),
          tripped: plant.pumps[0].tripped,
          vibration: round(plant.pumps[0].vib, 2),
        },
        {
          throttle: plant.pumps[1].throttle,
          flow: round(plant.pumps[1].flow, 2),
          tripped: plant.pumps[1].tripped,
          vibration: round(plant.pumps[1].vib, 2),
        },
        {
          throttle: plant.pumps[2].throttle,
          flow: round(plant.pumps[2].flow, 2),
          tripped: plant.pumps[2].tripped,
          vibration: round(plant.pumps[2].vib, 2),
        },
      ],
      faults: Object.keys(plant.faults).filter(function (k) {
        return plant.faults[k];
      }),
      hullDamage: plant.hullDamage,
      vapourEvent: plant.vapourEvent,
    };
  }

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === FAULT_CAV) plant.faults.cav = true;
    else if (f === FAULT_JAM) {
      plant.faults.jam = true;
      plant.v3Half = plant.valves.v3;
    } else if (f === FAULT_IG) plant.faults.igfail = true;
    refresh();
  }

  function reset() {
    var keepNothing = coldPlant();
    plant = keepNothing;
    refresh();
  }

  /* ============================================================
     PANEL WIRING
     ============================================================ */

  function $(id) {
    return document.getElementById(id);
  }
  function $all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  var els = {};

  function grab() {
    els.dialPressure = $("dial-pressure");
    els.dialOxygen = $("dial-oxygen");
    els.roPressure = $("ro-pressure");
    els.roOxygen = $("ro-oxygen");
    els.roBm = $("ro-bm");
    els.roBallast = $("ro-ballast");
    els.stressPointer = $("stress-pointer");
    els.stressCard = document.querySelector(".stress-card");
    els.counter = $("counter-discharged");
    els.jewelIg = $("jewel-ig");
    els.jewelShore = $("jewel-shore");
    els.flowShore = $("flow-shore");
    els.flowHeader = $("flow-header");
    els.flowDrops = [$("flow-d1"), $("flow-d3"), $("flow-d5")];
    els.tanks = { t1: $("tank-1"), t3: $("tank-3"), t5: $("tank-5") };
    els.valves = {};
    $all("[data-valve]").forEach(function (b) {
      els.valves[b.getAttribute("data-valve")] = b;
    });
    els.throttles = $all(".throttle");
    els.pumps = [$("pump-1"), $("pump-2"), $("pump-3")];
    els.roFlow = [$("ro-flow-1"), $("ro-flow-2"), $("ro-flow-3")];
    els.cavFills = $all(".cav-fill");
    els.cavBars = $all(".cav-bar");
    els.ann = {
      "oxygen high": $("ann-oxygen-high"),
      "line pressure high": $("ann-line-pressure-high"),
      "pump cavitation": $("ann-pump-cavitation"),
      "level low": $("ann-level-low"),
      "hull stress high": $("ann-hull-stress-high"),
      "valve jam": $("ann-valve-jam"),
      "hull damage": $("ann-hull-damage"),
      "vapour event": $("ann-vapour-event"),
    };
    els.acceptBtn = document.querySelector("[data-control='ALARM ACCEPT']");
    els.lampsBtn = document.querySelector("[data-control='LAMPS TEST']");
    els.dropGuard = document.querySelector(".drop-guard");
    els.dropMushroom = document.querySelector(".drop-mushroom");
    els.live = $("live-status");
    els.annunciator = document.querySelector(".annunciator");
  }

  /* ---------------- sound (after a gesture only) ---------------- */

  var audio = null;
  var humOsc = null,
    humGain = null,
    klaxonGain = null;

  function initAudio() {
    if (audio) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = new AC();
      var master = audio.createGain();
      master.gain.value = 0.5;
      master.connect(audio.destination);

      humGain = audio.createGain();
      humGain.gain.value = 0;
      var lp = audio.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 240;
      humOsc = audio.createOscillator();
      humOsc.type = "sawtooth";
      humOsc.frequency.value = 50;
      humOsc.connect(lp);
      lp.connect(humGain);
      humGain.connect(master);
      humOsc.start();

      klaxonGain = audio.createGain();
      klaxonGain.gain.value = 0;
      var ko = audio.createOscillator();
      ko.type = "square";
      ko.frequency.value = 470;
      var lfo = audio.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = 2.6;
      var lfoDepth = audio.createGain();
      lfoDepth.gain.value = 0.035;
      lfo.connect(lfoDepth);
      lfoDepth.connect(klaxonGain.gain);
      ko.connect(klaxonGain);
      klaxonGain.connect(master);
      ko.start();
      lfo.start();
    } catch (e) {
      audio = null;
    }
  }

  function thunk(freq) {
    if (!audio) return;
    try {
      var o = audio.createOscillator();
      var g = audio.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(freq || 90, audio.currentTime);
      o.frequency.exponentialRampToValueAtTime(40, audio.currentTime + 0.12);
      g.gain.setValueAtTime(0.18, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.16);
      o.connect(g);
      g.connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.18);
    } catch (e) {
      /* silent */
    }
  }

  function updateSound(st) {
    if (!audio) return;
    try {
      if (audio.state === "suspended") audio.resume();
      var flowFrac = clamp(st.totalFlow / (PUMP_MAX * 3), 0, 1);
      humOsc.frequency.value = 44 + flowFrac * 70;
      humGain.gain.value = flowFrac * 0.05;
      var unacked = unackedAlarms().length > 0;
      klaxonGain.gain.value = unacked ? 0.045 : 0;
    } catch (e) {
      /* silent */
    }
  }

  /* ---------------- rendering ---------------- */

  function setNeedle(dialEl, frac) {
    dialEl.style.setProperty(
      "--ang",
      (-120 + clamp(frac, 0, 1) * 240).toFixed(1) + "deg",
    );
  }

  function unackedAlarms() {
    return plant.alarms.filter(function (a) {
      return !plant.acknowledged[a];
    });
  }

  var lastLive = "";

  function refresh() {
    if (!els.counter) grab();
    var st = state();

    /* dials */
    setNeedle(els.dialPressure, st.pressure / 12);
    setNeedle(els.dialOxygen, st.oxygen / 25);
    els.roPressure.textContent = st.pressure.toFixed(1);
    els.roOxygen.textContent = st.oxygen.toFixed(1);

    /* tanks */
    [["t1"], ["t3"], ["t5"]].forEach(function (kk) {
      var key = kk[0];
      var lvl = st.levels[key];
      var el = els.tanks[key];
      el.querySelector(".tank-fill").style.height = lvl + "%";
      el.querySelector(".tank-m3").textContent =
        Math.round((lvl / 100) * TANK_M3) + " m³";
      el.classList.toggle(
        "low",
        plant.valves[key.replace("t", "v")] && lvl < 8 && lvl > 0,
      );
    });

    /* flows */
    for (var i = 0; i < 3; i++) {
      setNeedle(els.pumps[i].querySelector(".dial"), st.pumps[i].flow / 12);
      els.roFlow[i].textContent = st.pumps[i].flow.toFixed(1);
      els.throttles[i].style.setProperty(
        "--lever",
        (-52 + st.pumps[i].throttle * 1.04).toFixed(1) + "deg",
      );
      els.throttles[i].setAttribute(
        "aria-valuenow",
        String(Math.round(st.pumps[i].throttle)),
      );
      els.throttles[i].setAttribute(
        "aria-valuetext",
        Math.round(st.pumps[i].throttle) +
          " percent" +
          (st.pumps[i].tripped ? ", pump tripped" : ""),
      );
      els.throttles[i].classList.toggle("tripped-lever", st.pumps[i].tripped);
      els.cavFills[i].style.width =
        (st.pumps[i].vibration * 100).toFixed(0) + "%";
      els.cavBars[i].classList.toggle("hot", st.pumps[i].vibration > 0.55);
      els.cavBars[i].classList.toggle(
        "warm",
        st.pumps[i].vibration > 0.25 && st.pumps[i].vibration <= 0.55,
      );
      els.pumps[i].classList.toggle("tripped", st.pumps[i].tripped);
    }

    /* flow highlights */
    var shore = st.valves.sealine && st.valves.riser && st.totalFlow > 0.01;
    els.flowShore.classList.toggle("on", shore);
    els.flowHeader.classList.toggle("on", shore);
    els.flowDrops[0].classList.toggle("on", shore && st.valves.v1);
    els.flowDrops[1].classList.toggle("on", shore && st.valves.v3);
    els.flowDrops[2].classList.toggle("on", shore && st.valves.v5);

    /* valves */
    ["sealine", "riser", "v1", "v3", "v5"].forEach(function (vk) {
      var b = els.valves[vk];
      var open = st.valves[vk];
      b.setAttribute("aria-pressed", open ? "true" : "false");
      b.setAttribute(
        "aria-label",
        b
          .getAttribute("aria-label")
          .replace(/, (open|closed|jammed half-open)$/, "") +
          (vk === "v3" && plant.faults.jam
            ? ", jammed half-open"
            : open
              ? ", open"
              : ", closed"),
      );
      b.classList.toggle("jammed", vk === "v3" && plant.faults.jam);
    });

    /* stress */
    var bm = st.bendingMoment;
    els.roBm.textContent = (bm > 0 ? "+" : "") + bm + " tm";
    els.stressPointer.style.left =
      (((bm + 9000) / 18000) * 100).toFixed(2) + "%";
    els.stressCard.classList.toggle("over-limit", Math.abs(bm) > STRESS_WARN);

    /* jewels */
    els.jewelIg.classList.toggle(
      "lit",
      st.vent === "INERTED" && !plant.faults.igfail,
    );
    els.jewelShore.classList.toggle(
      "lit",
      st.valves.sealine && st.valves.riser,
    );

    /* ballast */
    els.roBallast.textContent =
      (st.ballast > 0 ? "+" : "") + Math.round(st.ballast) + " %";

    /* counter */
    var tonnes = Math.round(st.discharged * 1.02);
    els.counter.firstElementChild.textContent = (
      "00000" + Math.min(tonnes, 99999)
    ).slice(-5);

    /* annunciators */
    var lampsTest =
      els.lampsBtn && els.lampsBtn.getAttribute("aria-pressed") === "true";
    var unackedSet = {};
    unackedAlarms().forEach(function (a) {
      unackedSet[a] = true;
    });
    Object.keys(els.ann).forEach(function (name) {
      var win = els.ann[name];
      if (!win) return;
      var active = plant.alarms.indexOf(name) !== -1;
      var red = win.classList.contains("ann-red");
      win.classList.remove("alert-amber", "alert-red", "flash", "test-lit");
      if (lampsTest) win.classList.add("test-lit");
      else if (active) {
        win.classList.add(red ? "alert-red" : "alert-amber");
        if (unackedSet[name]) win.classList.add("flash");
      }
    });
    els.acceptBtn.classList.toggle("needful", unackedAlarms().length > 0);

    /* maintenance switches follow plant truth */
    $all(".tswitch").forEach(function (sw) {
      var t = sw.getAttribute("data-test");
      var on =
        (t === "cavitation" && plant.faults.cav) ||
        (t === "jam" && plant.faults.jam) ||
        (t === "igfail" && plant.faults.igfail);
      sw.setAttribute("aria-pressed", on ? "true" : "false");
    });

    /* live region */
    var msg;
    if (plant.alarms.length) {
      msg = "Alarm: " + plant.alarms.join(", ") + ".";
    } else if (st.totalFlow > 0.1) {
      msg =
        "Discharging " + Math.round(st.totalFlow) + " cubic metres per minute.";
    } else {
      msg = "Console standing by.";
    }
    if (msg !== lastLive) {
      lastLive = msg;
      els.live.textContent = msg;
    }

    updateSound(st);
  }

  /* ---------------- controls ---------------- */

  function wire() {
    /* valves */
    Object.keys(els.valves).forEach(function (vk) {
      els.valves[vk].addEventListener("click", function () {
        plant.valves[vk] = !plant.valves[vk];
        thunk(120);
        if (vk === "v3" && plant.faults.jam) plant.v3Half = plant.valves.v3;
        refresh();
      });
    });

    /* vent selector */
    $all(".vs-pos").forEach(function (b) {
      b.addEventListener("click", function () {
        plant.vent = b.getAttribute("data-vent");
        thunk(150);
        refresh();
      });
    });

    /* ballast selector */
    $all(".seg-pos").forEach(function (b) {
      b.addEventListener("click", function () {
        plant.ballastAuto = b.getAttribute("data-ballast") === "AUTO";
        thunk(150);
        refresh();
      });
    });

    /* throttles: pointer + keyboard */
    els.throttles.forEach(function (th, idx) {
      var dragging = false;
      function fromEvent(e) {
        var r = th.getBoundingClientRect();
        var y = r.bottom - 10 - e.clientY;
        var pct = clamp((y / (r.height - 22)) * 118, 0, 100);
        plant.pumps[idx].throttle = Math.round(pct);
        refresh();
      }
      th.addEventListener("pointerdown", function (e) {
        dragging = true;
        th.setPointerCapture(e.pointerId);
        fromEvent(e);
      });
      th.addEventListener("pointermove", function (e) {
        if (dragging) fromEvent(e);
      });
      th.addEventListener("pointerup", function () {
        dragging = false;
      });
      th.addEventListener("pointercancel", function () {
        dragging = false;
      });
      th.addEventListener("keydown", function (e) {
        var cur = plant.pumps[idx].throttle;
        var next = null;
        if (e.key === "ArrowUp" || e.key === "ArrowRight") next = cur + 5;
        else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = cur - 5;
        else if (e.key === "PageUp") next = cur + 20;
        else if (e.key === "PageDown") next = cur - 20;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = 100;
        if (next !== null) {
          e.preventDefault();
          plant.pumps[idx].throttle = clamp(Math.round(next), 0, 100);
          refresh();
        }
      });
    });

    /* alarm accept */
    els.acceptBtn.addEventListener("click", function () {
      plant.alarms.forEach(function (a) {
        plant.acknowledged[a] = true;
      });
      refresh();
    });

    /* lamps test */
    els.lampsBtn.setAttribute("aria-pressed", "false");
    els.lampsBtn.addEventListener("click", function () {
      var on = els.lampsBtn.getAttribute("aria-pressed") !== "true";
      els.lampsBtn.setAttribute("aria-pressed", on ? "true" : "false");
      if (on)
        setTimeout(function () {
          els.lampsBtn.setAttribute("aria-pressed", "false");
          refresh();
        }, 1600);
      refresh();
    });

    /* pump reset */
    document
      .querySelector("[data-control='PUMP RESET']")
      .addEventListener("click", function () {
        var any = false;
        plant.pumps.forEach(function (p) {
          if (p.tripped) {
            p.tripped = false;
            any = true;
          }
        });
        if (any) thunk(200);
        refresh();
      });

    /* console reset */
    document
      .querySelector("[data-control='CONSOLE RESET']")
      .addEventListener("click", function () {
        reset();
      });

    /* maintenance fault switches */
    $all(".tswitch").forEach(function (sw) {
      sw.addEventListener("click", function () {
        var t = sw.getAttribute("data-test");
        var turningOn = sw.getAttribute("aria-pressed") !== "true";
        if (t === "cavitation") plant.faults.cav = turningOn;
        if (t === "jam") {
          plant.faults.jam = turningOn;
          if (turningOn) plant.v3Half = plant.valves.v3;
        }
        if (t === "igfail") plant.faults.igfail = turningOn;
        thunk(turningOn ? 80 : 160);
        refresh();
      });
    });

    /* emergency drop */
    els.dropGuard.addEventListener("click", function () {
      var lift = els.dropGuard.getAttribute("aria-pressed") !== "true";
      els.dropGuard.setAttribute("aria-pressed", lift ? "true" : "false");
      els.dropMushroom.disabled = !lift;
    });
    els.dropMushroom.addEventListener("click", function () {
      if (els.dropMushroom.disabled) return;
      Object.keys(plant.valves).forEach(function (vk) {
        plant.valves[vk] = false;
      });
      plant.pumps.forEach(function (p) {
        p.throttle = 0;
        p.tripped = true;
      });
      thunk(60);
      refresh();
    });

    /* manual dialog */
    var dlg = document.querySelector("dialog[data-manual]");
    document
      .querySelector("[data-action='manual']")
      .addEventListener("click", function () {
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    document
      .querySelector("[data-action='close-manual']")
      .addEventListener("click", function () {
        if (typeof dlg.close === "function") dlg.close();
        else dlg.removeAttribute("open");
      });

    /* audio unlock on first gesture */
    var unlock = function () {
      initAudio();
      if (audio && audio.state === "suspended") audio.resume();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
  }

  /* ---------------- animation loop ---------------- */

  var rafId = null;
  var lastTs = null;

  function frame(ts) {
    if (lastTs === null) lastTs = ts;
    var dt = clamp((ts - lastTs) / 1000, 0, 2);
    lastTs = ts;
    if (dt > 0) tick(dt);
    refresh();
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId === null) {
      lastTs = null;
      rafId = requestAnimationFrame(frame);
    }
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopLoop();
    else startLoop();
  });

  /* ---------------- boot ---------------- */

  function boot() {
    grab();
    wire();
    /* reflect cold selectors */
    $all(".vs-pos").forEach(function (b) {
      b.setAttribute(
        "aria-pressed",
        b.getAttribute("data-vent") === plant.vent ? "true" : "false",
      );
    });
    $all(".seg-pos").forEach(function (b) {
      b.setAttribute(
        "aria-pressed",
        (b.getAttribute("data-ballast") === "AUTO") === plant.ballastAuto
          ? "true"
          : "false",
      );
    });
    refresh();
    startLoop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ---------------- exported API ---------------- */

  window.machine = {
    name: "Coralline Cargo Discharge Console",
    faults: [FAULT_CAV, FAULT_JAM, FAULT_IG],
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };
})();
