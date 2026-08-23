/* =====================================================================
   Ferriday 9/F Process Computer — simulation and front-panel behaviour.
   Ferriday Instrument Co., Reading, England. Publication 9F-MAN-003.

   A 12-bit core-memory process computer. The resident diagnostic sweeps
   odd words for primality and posts each prime to the output register;
   the operator loads an address, examines and deposits core, starts and
   stops the clock, and keeps an eye on the +5 V rail and the core-stack
   temperature. Three things go wrong: a core parity error halts her
   where she stands, a sagging +5 V rail scrambles memory if ignored,
   and a tripped blower cooks the stack towards thermal trip.
   ===================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  var MACHINE_NAME = "Ferriday 9/F Process Computer";
  var FAULTS = [
    "core memory parity error",
    "power supply undervoltage",
    "blower failure",
  ];

  var MEM_SIZE = 4096; /* words of core, twelve bits each   */
  var PROG_BASE = parseInt("7600", 8); /* diagnostic entry, octal 07600 */
  var PROG_SPAN = 56; /* words of the visible loop         */
  var T_AMBIENT = 22; /* deg C, computer-room air          */
  var T_WARN = 65; /* OVERTEMPERATURE annunciator       */
  var T_TRIP = 80; /* thermal trip                      */
  var T_REARM = 55; /* trip rearms below here            */
  var V_NOMINAL = 5.08;
  var V_LOW = 4.85; /* DC LOW threshold                  */
  var V_SCRAMBLE = 4.55; /* below this, core writes corrupt   */
  var SCRAMBLE_SECONDS = 18; /* sustained sag before scramble     */
  var FREQ_MIN = 0.2;
  var FREQ_MAX = 1.6;
  var FREQ_DEFAULT = 1.2;

  var MODES = ["OFF", "STANDBY", "LOAD", "RUN", "MAINT"];

  /* Deterministic noise: the same seed walks the same machine. */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rng = makeRng(0x9f1174);

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  function buildProgram(mem) {
    /* Code words of the resident diagnostic - decoration for EXAMINE,
       but the right sort: branchy, dense, self-checking. */
    var i;
    for (i = 0; i < MEM_SIZE; i++) {
      mem[i] = 0;
    }
    mem[PROG_BASE] = 0o1101; /* load candidate                   */
    mem[PROG_BASE + 1] = 0o2404; /* divide by trial factor           */
    mem[PROG_BASE + 2] = 0o3552; /* skip if remainder zero           */
    mem[PROG_BASE + 3] = 0o5200; /* jump, next trial                 */
    mem[PROG_BASE + 4] = 0o6411; /* post prime to output register    */
    for (i = 5; i < PROG_SPAN; i++) {
      mem[PROG_BASE + i] = (0o1400 + ((i * 263) % 0o377)) & 0o7777;
    }
    mem[PROG_BASE + PROG_SPAN - 1] = 0o5200;
  }

  function freshState() {
    return {
      /* panel */
      mains: false,
      mode: 0 /* index into MODES                  */,
      freqSet: FREQ_DEFAULT,
      blowerSwitch: true /* operator's blower breaker         */,
      lampTest: false,
      /* machine */
      psuV: 0,
      tempC: T_AMBIENT,
      running: false,
      runRequested: false,
      pc: PROG_BASE,
      ac: 0,
      mq: 0,
      link: 0,
      phase: 0,
      microCount: 0,
      stepFrac: 0,
      addrReg: PROG_BASE,
      dispReg: 0,
      outReg: 0,
      instrTotal: 0,
      primesPosted: 0,
      candidate: 3,
      trial: 3,
      simTime: 0,
      uptime: 0,
      /* faults */
      faultParity: false,
      faultDc: false,
      faultBlower: false,
      parityHalted: false,
      parityAddr: -1,
      scrambled: false,
      tripLatched: false,
      dcLowSeconds: 0,
      paritySweepAt: 0.7,
      /* alarms: asserted conditions plus acknowledgement bookkeeping */
      alarms: {
        "PARITY ERROR": false,
        "DC LOW": false,
        OVERTEMPERATURE: false,
        "THERMAL TRIP": false,
        "AIRFLOW LOSS": false,
        "MEMORY SCRAMBLE": false,
      },
      acknowledged: {},
      mem: null,
      pristine: null,
    };
  }

  var S = freshState();
  buildProgram((S.mem = []));
  S.pristine = S.mem.slice();

  /* ------------------------------------------------------------------ */
  /* Shortcuts                                                           */
  /* ------------------------------------------------------------------ */

  function $all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }
  function $(sel) {
    return document.querySelector(sel);
  }

  function powered() {
    return S.mains;
  }
  function throttleFactor() {
    return S.tempC > 72 ? 0.45 : 1;
  }
  function executing() {
    return (
      powered() &&
      S.mode === 3 &&
      S.runRequested &&
      !S.tripLatched &&
      !S.parityHalted &&
      !S.scrambled
    );
  }
  function utilisation() {
    return S.running
      ? (S.freqSet / FREQ_MAX) * throttleFactor()
      : powered()
        ? 0.06
        : 0;
  }

  /* ------------------------------------------------------------------ */
  /* The simulation                                                      */
  /* ------------------------------------------------------------------ */

  function microStep() {
    /* One instruction of the prime-sweep diagnostic: honest trial
       division by odd factors, posted to the output register. */
    S.microCount += 1;
    S.instrTotal += 1;
    S.phase = S.microCount % 6;
    S.pc = PROG_BASE + (S.microCount % PROG_SPAN);
    if (S.trial * S.trial > S.candidate) {
      S.outReg = S.candidate; /* prime found               */
      S.primesPosted += 1;
      S.ac = S.candidate;
      S.mq = S.primesPosted & 0o7777;
      S.candidate += 2;
      S.trial = 3;
    } else if (S.candidate % S.trial === 0) {
      S.ac = 0; /* composite: next candidate */
      S.mq = S.trial;
      S.candidate += 2;
      S.trial = 3;
    } else {
      S.ac = S.candidate % S.trial; /* remainder this division   */
      S.mq = S.trial;
      S.trial += 2;
    }
    S.link = S.microCount % 9 < 5 ? 1 : 0;
    if (S.candidate > 0o7775) {
      S.candidate = 3;
      S.trial = 3;
    }
  }

  function raiseAlarm(name) {
    if (!S.alarms[name]) {
      S.alarms[name] = true;
      delete S.acknowledged[name];
    }
  }

  function scrambleCore() {
    var i, addr;
    for (i = 0; i < 10; i++) {
      addr = (rng() * MEM_SIZE) | 0;
      S.mem[addr] = (rng() * 4096) | 0;
    }
    S.ac = 0o4721;
    S.mq = 0o1552;
    S.outReg = 0;
  }

  function tick(seconds) {
    var dt = Math.max(0, Math.min(0.5, Number(seconds) || 0));
    var dissipation,
      conductance,
      targetV,
      ripple,
      rateHz,
      steps,
      whole,
      airLost,
      k;

    S.simTime += dt;

    /* --- power supply ------------------------------------------------- */
    if (powered()) {
      S.uptime += dt;
      targetV = V_NOMINAL - 0.1 * utilisation() - (S.faultDc ? 0.72 : 0);
      ripple =
        0.012 * Math.sin(S.simTime * 628.3) +
        0.006 * Math.sin(S.simTime * 45.9);
      S.psuV += (targetV - S.psuV) * Math.min(1, dt / 1.4);
      S.psuV += ripple * Math.min(1, dt * 4);
    } else {
      S.psuV += (0 - S.psuV) * Math.min(1, dt / 0.7);
      S.dcLowSeconds = 0;
    }

    /* --- core stack temperature ---------------------------------------- */
    dissipation = powered() ? 14 + 34 * utilisation() : 2;
    conductance =
      S.blowerSwitch && !S.faultBlower ? (powered() ? 1.0 : 0.55) : 0.26;
    S.tempC +=
      (dissipation / conductance - (S.tempC - T_AMBIENT)) *
      Math.min(1, dt / 140);

    /* --- the clock runs ------------------------------------------------ */
    S.running = executing();
    if (S.running) {
      rateHz = S.freqSet * 1e6 * throttleFactor();
      S.stepFrac += (rateHz * dt) / 9000; /* one visible step per 9000 beats */
      whole = Math.floor(S.stepFrac);
      S.stepFrac -= whole;
      for (k = 0; k < whole; k++) {
        microStep();
      }
    }

    /* --- parity sweep ---------------------------------------------------- */
    S.paritySweepAt -= dt;
    if (S.paritySweepAt <= 0) {
      S.paritySweepAt = 0.7;
      if (S.faultParity && !S.alarms["PARITY ERROR"]) {
        S.parityAddr = PROG_BASE + ((rng() * PROG_SPAN) | 0);
        raiseAlarm("PARITY ERROR");
        if (executing()) {
          S.parityHalted = true;
          S.runRequested = false;
        }
      }
    }

    /* --- DC LOW and its consequence --------------------------------------- */
    var dcLowNow = S.faultDc || (powered() && S.psuV > 1 && S.psuV < V_LOW);
    if (dcLowNow) {
      raiseAlarm("DC LOW");
    }
    if (!dcLowNow && !S.faultDc) {
      S.alarms["DC LOW"] = false;
    }
    if (powered()) {
      if (S.psuV < V_SCRAMBLE) {
        S.dcLowSeconds += dt;
      } else if (!S.faultDc) {
        S.dcLowSeconds = Math.max(0, S.dcLowSeconds - dt);
      }
      if (S.dcLowSeconds >= SCRAMBLE_SECONDS && !S.scrambled) {
        S.scrambled = true;
        scrambleCore();
        S.runRequested = false;
        raiseAlarm("MEMORY SCRAMBLE");
      }
    }

    /* --- temperature consequences ------------------------------------------ */
    if (S.tempC >= T_WARN) {
      raiseAlarm("OVERTEMPERATURE");
    }
    if (S.tempC < T_WARN - 6) {
      S.alarms.OVERTEMPERATURE = false;
    }
    if (powered() && S.tempC >= T_TRIP && !S.tripLatched) {
      S.tripLatched = true;
      S.runRequested = false;
      raiseAlarm("THERMAL TRIP");
    }

    /* --- airflow ------------------------------------------------------------ */
    airLost = S.faultBlower || (powered() && !S.blowerSwitch);
    if (airLost) {
      raiseAlarm("AIRFLOW LOSS");
    }
    if (!airLost) {
      S.alarms["AIRFLOW LOSS"] = false;
    }

    updateSound();
  }

  /* ------------------------------------------------------------------ */
  /* Fixed API                                                           */
  /* ------------------------------------------------------------------ */

  function stateObject() {
    var names = [],
      k;
    for (k in S.alarms) {
      if (Object.prototype.hasOwnProperty.call(S.alarms, k) && S.alarms[k]) {
        names.push(k);
      }
    }
    return {
      mode: MODES[S.mode],
      mains: S.mains,
      running: S.running,
      clockSettingMHz: +S.freqSet.toFixed(2),
      clockMHz: +(S.freqSet * throttleFactor()).toFixed(3),
      throttled: S.tempC > 72,
      psuV: +S.psuV.toFixed(3),
      coreTempC: +S.tempC.toFixed(2),
      blowerOk: !(S.faultBlower || (powered() && !S.blowerSwitch)),
      pc: S.pc,
      ac: S.ac,
      mq: S.mq,
      link: S.link,
      addrReg: S.addrReg,
      dispReg: S.dispReg,
      output: S.outReg,
      primesPosted: S.primesPosted,
      instructionsExecuted: Math.floor(S.instrTotal),
      parityAddress: S.parityAddr,
      parityHalted: S.parityHalted,
      scrambled: S.scrambled,
      thermalTripped: S.tripLatched,
      uptimeSeconds: +S.uptime.toFixed(2),
      alarms: names.slice(),
    };
  }

  function inject(name) {
    var n = String(name || "").toLowerCase();
    if (n.indexOf("parity") >= 0) {
      S.faultParity = true;
      syncInjector("parity", true);
    } else if (
      n.indexOf("undervolt") >= 0 ||
      n.indexOf("supply") >= 0 ||
      n === "power supply undervoltage"
    ) {
      S.faultDc = true;
      syncInjector("dclow", true);
    } else if (
      n.indexOf("blower") >= 0 ||
      n.indexOf("fan") >= 0 ||
      n.indexOf("cool") >= 0
    ) {
      S.faultBlower = true;
      syncInjector("blower", true);
    } else {
      throw new Error("unknown fault: " + name);
    }
  }

  function clearFaultFlags() {
    S.faultParity = false;
    S.faultDc = false;
    S.faultBlower = false;
    syncInjector("parity", false);
    syncInjector("dclow", false);
    syncInjector("blower", false);
  }

  function reset() {
    var mem = [];
    buildProgram(mem);
    S = freshState();
    S.mem = mem;
    S.pristine = mem.slice();
    rng = makeRng(0x9f1174);
    clearFaultFlags();
    uiSyncAll();
    render();
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: stateObject,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ------------------------------------------------------------------ */
  /* Sound: relays, blower hum, alarm horn - after a gesture only.       */
  /* ------------------------------------------------------------------ */

  var audio = { ctx: null, enabled: false, hornNodes: null, humGain: null };

  function ensureAudio() {
    if (audio.ctx) {
      return;
    }
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new Ctx();
      audio.enabled = true;
      var hum = audio.ctx.createOscillator();
      var hum2 = audio.ctx.createOscillator();
      var g = audio.ctx.createGain();
      hum.type = "sine";
      hum.frequency.value = 118;
      hum2.type = "triangle";
      hum2.frequency.value = 236;
      g.gain.value = 0;
      hum.connect(g);
      hum2.connect(g);
      g.connect(audio.ctx.destination);
      hum.start();
      hum2.start();
      audio.humGain = g;
    } catch (e) {
      audio.enabled = false;
    }
  }

  function clack(pitch) {
    if (!audio.enabled || !audio.ctx) {
      return;
    }
    try {
      var t = audio.ctx.currentTime;
      var o = audio.ctx.createOscillator();
      var g = audio.ctx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(pitch, t);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.03);
      g.gain.setValueAtTime(0.1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      o.connect(g);
      g.connect(audio.ctx.destination);
      o.start(t);
      o.stop(t + 0.06);
    } catch (e) {
      /* stay silent if the browser refuses */
    }
  }

  function hornShouldRun() {
    var k;
    for (k in S.alarms) {
      if (S.alarms[k] && !S.acknowledged[k]) {
        return true;
      }
    }
    return false;
  }

  function updateSound() {
    if (!audio.enabled || !audio.ctx) {
      return;
    }
    try {
      var wantHum = powered() && S.blowerSwitch && !S.faultBlower ? 0.016 : 0;
      audio.humGain.gain.setTargetAtTime(wantHum, audio.ctx.currentTime, 0.4);
      var wantHorn = hornShouldRun();
      if (wantHorn && !audio.hornNodes) {
        var o = audio.ctx.createOscillator();
        var o2 = audio.ctx.createOscillator();
        var g = audio.ctx.createGain();
        var lfo = audio.ctx.createOscillator();
        var lg = audio.ctx.createGain();
        o.type = "square";
        o.frequency.value = 420;
        o2.type = "square";
        o2.frequency.value = 523;
        lfo.type = "square";
        lfo.frequency.value = 2.4;
        lg.gain.value = 0.03;
        g.gain.value = 0.045;
        lfo.connect(lg);
        lg.connect(g.gain);
        o.connect(g);
        o2.connect(g);
        g.connect(audio.ctx.destination);
        o.start();
        o2.start();
        lfo.start();
        audio.hornNodes = {
          stop: function () {
            try {
              o.stop();
              o2.stop();
              lfo.stop();
            } catch (e) {
              /* already stopped */
            }
          },
        };
      } else if (!wantHorn && audio.hornNodes) {
        audio.hornNodes.stop();
        audio.hornNodes = null;
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Panel wiring                                                        */
  /* ------------------------------------------------------------------ */

  function bankValue(prefix) {
    var v = 0,
      i,
      sw;
    for (i = 0; i < 12; i++) {
      sw = document.querySelector('[data-sw="' + prefix + "-" + i + '"]');
      if (sw && sw.checked) {
        v |= 1 << i;
      }
    }
    return v;
  }

  function setBank(prefix, value) {
    var i, sw;
    for (i = 0; i < 12; i++) {
      sw = document.querySelector('[data-sw="' + prefix + "-" + i + '"]');
      if (sw) {
        sw.checked = !!(value & (1 << i));
      }
    }
  }

  function acknowledge() {
    var k;
    for (k in S.alarms) {
      if (S.alarms[k]) {
        S.acknowledged[k] = true;
      }
    }
    /* the thermal trip rearms once she has cooled and been accepted */
    if (S.tripLatched && S.tempC < T_REARM) {
      S.tripLatched = false;
      S.alarms["THERMAL TRIP"] = false;
      delete S.acknowledged["THERMAL TRIP"];
    }
    updateSound();
  }

  function pressClear() {
    S.ac = 0;
    S.mq = 0;
    S.link = 0;
    S.runRequested = false;
    if (S.scrambled) {
      S.mem = S.pristine.slice();
      S.scrambled = false;
      S.alarms["MEMORY SCRAMBLE"] = false;
      delete S.acknowledged["MEMORY SCRAMBLE"];
      S.dcLowSeconds = 0;
    }
    clack(500);
  }

  function pressExamine() {
    if (!powered()) {
      return;
    }
    S.dispReg = S.mem[S.addrReg];
    clack(480);
  }

  function pressDeposit() {
    if (!powered()) {
      return;
    }
    S.mem[S.addrReg] = bankValue("data") & 0o7777;
    S.dispReg = S.mem[S.addrReg];
    S.addrReg = (S.addrReg + 1) % MEM_SIZE;
    clack(430);
  }

  function pressStart() {
    if (
      !powered() ||
      S.mode !== 3 ||
      S.tripLatched ||
      S.parityHalted ||
      S.scrambled
    ) {
      return;
    }
    S.runRequested = true;
    clack(360);
  }

  function pressStep() {
    if (!powered() || S.tripLatched || S.scrambled || S.parityHalted) {
      return;
    }
    if (S.mode === 3 || S.mode === 4) {
      microStep();
      clack(520);
    }
  }

  function setMode(i) {
    S.mode = Math.max(0, Math.min(MODES.length - 1, i));
    if (MODES[S.mode] !== "RUN") {
      S.runRequested = false;
    }
    clack(300);
  }

  function setFreq(v) {
    S.freqSet = Math.round(Math.max(FREQ_MIN, Math.min(FREQ_MAX, v)) * 10) / 10;
  }

  /* Guarded switches: first press lifts the guard, second throws. */
  function wireGuard(root, onThrow) {
    var cover = root.querySelector(".g-cover");
    var body = root.querySelector(".g-body");
    if (!cover.dataset.wired) {
      cover.addEventListener("click", function () {
        root.classList.add("guard-open");
        cover.tabIndex = -1;
        clack(700);
      });
      cover.dataset.wired = "1";
    }
    if (!body.dataset.wired) {
      body.addEventListener("click", function () {
        if (!root.classList.contains("guard-open")) {
          root.classList.add("guard-open");
          cover.tabIndex = -1;
          clack(700);
          return;
        }
        var on = body.getAttribute("aria-pressed") !== "true";
        body.setAttribute("aria-pressed", on ? "true" : "false");
        clack(on ? 320 : 280);
        if (onThrow) {
          onThrow(on);
        }
      });
      body.dataset.wired = "1";
    }
  }

  function syncInjector(key, on) {
    var box = document.querySelector('[data-inject="' + key + '"]');
    if (box && box.checked !== on) {
      box.checked = on;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function oct4(v) {
    var s = (Math.floor(v) & 0o7777).toString(8);
    while (s.length < 4) {
      s = "0" + s;
    }
    return s;
  }

  function dec4(v) {
    var s = String(Math.max(0, Math.min(9999, Math.floor(v))));
    while (s.length < 4) {
      s = "0" + s;
    }
    return s;
  }

  function setNixie(which, text, litWhenPowered) {
    var tubes = $all('[data-nixie="' + which + '"] .tube');
    var i, d, ch, lit;
    for (i = 0; i < tubes.length; i++) {
      d = tubes[i].querySelector(".digit");
      ch = S.lampTest ? "8" : text.charAt(i) || "\u00a0";
      if (d.textContent !== ch) {
        d.textContent = ch;
      }
      lit = S.lampTest || (litWhenPowered && powered());
      tubes[i].classList.toggle("lit", !!lit && ch !== "\u00a0");
    }
  }

  function setRegLamps(name, value) {
    var holder = document.querySelector('[data-reglamp="' + name + '"]');
    if (!holder) {
      return;
    }
    var lamps = holder.querySelectorAll(".rlamp");
    Array.prototype.forEach.call(lamps, function (lamp) {
      var bit = parseInt(lamp.getAttribute("data-bit"), 10);
      lamp.classList.toggle(
        "on",
        S.lampTest || (powered() && !!(value & (1 << bit))),
      );
    });
  }

  function needle(name, frac) {
    var el = document.querySelector('[data-needle="' + name + '"]');
    if (!el) {
      return;
    }
    el.setAttribute(
      "transform",
      "rotate(" + (75 - frac * 150).toFixed(2) + " 110 112)",
    );
  }

  function drawMeterTicks() {
    var ns = "http://www.w3.org/2000/svg";
    $all(".mticks").forEach(function (g, idx) {
      var vals = idx === 0 ? [4, 4.5, 5, 5.5, 6] : [0, 20, 40, 60, 80, 100];
      vals.forEach(function (v) {
        var f = idx === 0 ? (v - 4) / 2 : v / 100;
        var phi = ((165 - 150 * f) * Math.PI) / 180;
        var line = document.createElementNS(ns, "line");
        line.setAttribute("x1", (110 + 78 * Math.cos(phi)).toFixed(1));
        line.setAttribute("y1", (112 - 78 * Math.sin(phi)).toFixed(1));
        line.setAttribute("x2", (110 + 69 * Math.cos(phi)).toFixed(1));
        line.setAttribute("y2", (112 - 69 * Math.sin(phi)).toFixed(1));
        g.appendChild(line);
        var txt = document.createElementNS(ns, "text");
        txt.setAttribute("x", (110 + 57 * Math.cos(phi)).toFixed(1));
        txt.setAttribute("y", (112 - 57 * Math.sin(phi) + 3).toFixed(1));
        txt.textContent =
          idx === 0 ? (v % 1 === 0 ? String(v) : v.toFixed(1)) : String(v);
        g.appendChild(txt);
      });
    });
  }

  function render() {
    $('[data-jewel="POWER"]').classList.toggle("lit", powered());
    $('[data-jewel="BLOWER"]').classList.toggle(
      "lit",
      powered() && S.blowerSwitch && !S.faultBlower,
    );
    $('[data-jewel="RUN"]').classList.toggle("lit", S.running);
    $('[data-jewel="HALT"]').classList.toggle("lit", powered() && !S.running);

    setRegLamps("pc", S.pc);
    setRegLamps("ac", S.ac);
    setRegLamps("mq", S.mq);
    setRegLamps("link", S.link ? 1 : 0);
    setRegLamps("fetch", S.running ? 0b111 ^ (1 << (S.phase % 3)) : 0b111);
    setRegLamps("exec", S.running ? 1 << (S.phase % 3) : 0);

    /* address follows the program counter while she runs */
    setNixie("addr", oct4(S.running ? S.pc : S.addrReg), true);
    setNixie("disp", oct4(S.running ? S.mem[S.pc] : S.dispReg), true);
    setNixie("out", dec4(S.outReg), S.outReg > 0);

    needle("psu", Math.max(0, Math.min(1, (S.psuV - 4) / 2)));
    needle("temp", Math.max(0, Math.min(1, S.tempC / 100)));

    $all(".ann").forEach(function (el) {
      var name = el.getAttribute("data-ann");
      var lit = !!S.alarms[name];
      el.classList.toggle("lit", lit);
      el.classList.toggle("flash", lit && !S.acknowledged[name]);
    });

    var modeKnob = $(".knob-mode");
    var clockKnob = $(".knob-clock");
    modeKnob.style.setProperty("--rot", -64 + S.mode * 32 + "deg");
    modeKnob.setAttribute("aria-valuenow", String(S.mode));
    modeKnob.setAttribute("aria-valuetext", MODES[S.mode]);
    clockKnob.style.setProperty(
      "--rot",
      (-70 + ((S.freqSet - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * 140).toFixed(
        1,
      ) + "deg",
    );
    clockKnob.setAttribute("aria-valuenow", S.freqSet.toFixed(1));
  }

  function syncTrayInner(open) {
    $all(".mtray-inner input, .mtray-inner button").forEach(function (el) {
      el.disabled = !open;
    });
  }

  function uiSyncAll() {
    setBank("addr", PROG_BASE);
    setBank("data", 0);
    $all(".guardsw").forEach(function (g) {
      g.classList.remove("guard-open");
      var c = g.querySelector(".g-cover");
      if (c) {
        c.removeAttribute("tabindex");
        c.tabIndex = 0;
      }
      var b = g.querySelector(".g-body");
      if (b) {
        b.setAttribute(
          "aria-pressed",
          g.getAttribute("data-control") === "BLOWER" ? "true" : "false",
        );
      }
    });
    var tray = $(".mtray");
    if (tray) {
      tray.classList.remove("open");
      tray.querySelector(".mtray-cover").setAttribute("aria-expanded", "false");
      syncTrayInner(false);
    }
    document.body.classList.remove("lt");
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function wire() {
    $('[data-control="ADDRESS LOAD"]').addEventListener("click", function () {
      if (!powered()) {
        return;
      }
      S.addrReg = bankValue("addr");
      S.dispReg = S.mem[S.addrReg];
      clack(460);
    });
    $('[data-control="EXAMINE"]').addEventListener("click", pressExamine);
    $('[data-control="DEPOSIT"]').addEventListener("click", pressDeposit);
    $('[data-control="CLEAR"]').addEventListener("click", pressClear);
    $('[data-control="START"]').addEventListener("click", pressStart);
    $('[data-control="STOP"]').addEventListener("click", function () {
      S.runRequested = false;
      clack(260);
    });
    $('[data-control="SINGLE STEP"]').addEventListener("click", pressStep);
    $('[data-control="ALARM ACKNOWLEDGE"]').addEventListener(
      "click",
      function () {
        acknowledge();
        clack(620);
      },
    );

    /* lamps test: hold */
    var lt = $('[data-control="LAMPS TEST"]');
    var ltOn = function () {
      S.lampTest = true;
      document.body.classList.add("lt");
    };
    var ltOff = function () {
      S.lampTest = false;
      document.body.classList.remove("lt");
    };
    lt.addEventListener("pointerdown", ltOn);
    lt.addEventListener("pointerup", ltOff);
    lt.addEventListener("pointerleave", ltOff);
    lt.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        ltOn();
      }
    });
    lt.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") {
        ltOff();
      }
    });

    /* guarded switches */
    wireGuard($('[data-control="MAINS BREAKER"]'), function (on) {
      S.mains = on;
      if (!on) {
        S.runRequested = false;
      }
    });
    wireGuard($('[data-control="BLOWER"]'), function (on) {
      S.blowerSwitch = on;
      if (on) {
        /* cycling the breaker restarts a tripped blower motor */
        S.faultBlower = false;
        syncInjector("blower", false);
      }
    });

    /* mode knob */
    var modeKnob = $(".knob-mode");
    modeKnob.addEventListener("click", function () {
      setMode(S.mode + 1 === MODES.length ? 0 : S.mode + 1);
    });
    modeKnob.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        setMode(S.mode + 1);
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        setMode(S.mode - 1);
      }
      if (e.key === "Home") {
        e.preventDefault();
        setMode(0);
      }
      if (e.key === "End") {
        e.preventDefault();
        setMode(MODES.length - 1);
      }
    });

    /* clock knob */
    var clockKnob = $(".knob-clock");
    clockKnob.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        setFreq(S.freqSet + 0.1);
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        setFreq(S.freqSet - 0.1);
      }
    });
    clockKnob.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        setFreq(S.freqSet + (e.deltaY < 0 ? 0.1 : -0.1));
      },
      { passive: false },
    );

    /* rocker banks */
    $all(".rocker input").forEach(function (box) {
      box.addEventListener("change", function () {
        clack(box.checked ? 640 : 600);
      });
      box.addEventListener("keydown", function (e) {
        /* arrows walk the bank like a real row of paddles */
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
          return;
        }
        e.preventDefault();
        var bank = box.closest(".rockers").getAttribute("data-bank");
        var all = $all('[data-bank="' + bank + '"] input');
        var i = all.indexOf(box) + (e.key === "ArrowRight" ? -1 : 1);
        if (i >= 0 && i < all.length) {
          all[i].focus();
        }
      });
    });

    /* maintenance tray */
    var tray = $(".mtray");
    tray.querySelector(".mtray-cover").addEventListener("click", function () {
      var open = !tray.classList.contains("open");
      tray.classList.toggle("open", open);
      tray
        .querySelector(".mtray-cover")
        .setAttribute("aria-expanded", open ? "true" : "false");
      syncTrayInner(open);
      clack(700);
    });
    $all("[data-inject]").forEach(function (box) {
      box.addEventListener("change", function () {
        if (!box.checked) {
          if (box.getAttribute("data-inject") === "parity") {
            S.faultParity = false;
          }
          if (box.getAttribute("data-inject") === "dclow") {
            S.faultDc = false;
          }
          /* the blower test switch latches: cycle the BLOWER breaker */
        }
      });
    });
    $('[data-key="parity-clear"]').addEventListener("click", function () {
      S.faultParity = false;
      S.alarms["PARITY ERROR"] = false;
      delete S.acknowledged["PARITY ERROR"];
      S.parityHalted = false;
      S.parityAddr = -1;
      syncInjector("parity", false);
      clack(540);
    });

    /* manual dialog */
    var dlg = $("dialog[data-manual]");
    $('[data-action="manual"]').addEventListener("click", function () {
      if (typeof dlg.showModal === "function") {
        dlg.showModal();
      } else {
        dlg.setAttribute("open", "");
      }
    });
    dlg
      .querySelector('[data-action="close-manual"]')
      .addEventListener("click", function () {
        dlg.close();
      });

    /* audio unlock on first gesture */
    var unlock = function () {
      ensureAudio();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
  }

  /* Main loop: real elapsed time into tick(), paused when hidden. */
  var lastStamp = 0;
  var hidden = false;

  function frame(stamp) {
    if (!hidden) {
      var dt = lastStamp ? (stamp - lastStamp) / 1000 : 0.016;
      lastStamp = stamp;
      tick(Math.min(0.25, dt));
      render();
    } else {
      lastStamp = stamp;
    }
    window.requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    if (!hidden) {
      lastStamp = 0;
    }
  });

  function boot() {
    wire();
    drawMeterTicks();
    uiSyncAll();
    render();
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
