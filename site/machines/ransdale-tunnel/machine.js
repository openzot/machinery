/* ============================================================
   Ransdale College of Aeronautics - Supersonic Tunnel No. 1
   Control desk behaviour. Works Dept, 1957.
   An intermittent blowdown tunnel: charge the tanks with dry
   air, regenerate the dryer, snap the run valve, sweep the wing
   and read the shocks. Deterministic simulation behind a 1957
   bench of aluminium, wrinkle paint and ivory scales.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- little helpers ---------------- */

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };
  var clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };
  var approach = function (v, target, rate, dt) {
    var d = target - v;
    var step = rate * dt;
    if (Math.abs(d) <= step) return target;
    return v + Math.sign(d) * step;
  };

  /* ---------------- machine constants ---------------- */

  var NAME = "Ransdale Supersonic Tunnel No. 1";
  var FAULTS = [
    "nozzle condensation",
    "sting buffet oscillation",
    "compressor overheat",
  ];
  var MACH_BLOCKS = [1.6, 2.0, 2.5, 3.0];
  var ALARM_NAMES = {
    tank: "tank pressure low",
    dryer: "dryer saturated",
    moisture: "nozzle condensation",
    buffet: "sting buffet",
    unstart: "diffuser unstart",
    comphot: "compressor overheat",
    sting: "sting damaged",
    optics: "optics fouled",
  };
  var TANK_MAX = 250;
  var TANK_CHARGED = 200;

  /* ---------------- simulation state ---------------- */

  var S = null;

  function freshState() {
    return {
      time: 0,
      breaker: false,
      heater: false,
      compOn: false,
      compTemp: 15,
      compLatch: false, // thermal overload, motor held off
      compHot: false, // winding fault until cooled and reset
      tankP: 32,
      wetness: 0.06,

      machIdx: 1,
      aoaCmd: 0,
      aoa: 0,
      bleed: 50,

      valveCmd: false,
      valvePos: 0,
      valveLock: false,
      running: false,
      flowEst: false,
      runSeconds: 0,

      T0: 15,
      ps: 0,
      pdiff: 1.013,
      mach: 0,
      startBuzz: 0,
      lift: 0,
      drag: 0,

      buffet: 0,
      damageT: 0,
      condensation: 0,
      foulT: 0,
      riskT: 0,
      unstartT: 0,
      dumpT: 0,
      shake: 0,

      stingFault: false,
      stingDamaged: false,
      opticsFouled: false,
      unstartLatch: false,

      active: {}, // alarm id -> true
      flashing: {}, // alarm id -> true until accepted
      testT: 0,
      denyT: 0,
    };
  }

  /* ---------------- derived quantities ---------------- */

  function machSet() {
    return MACH_BLOCKS[S.machIdx];
  }
  function critAoA(m) {
    return 17 - 3 * m;
  }
  function needBleed(m) {
    return clamp((m - 1.1) / 2.4, 0.16, 0.92);
  }
  function dewline(m) {
    return 34 - 15 * m;
  }

  function raiseAlarm(id) {
    S.active[id] = true;
    if (!S.flashing[id] && !wasAccepted(id)) S.flashing[id] = true;
  }
  function wasAccepted(id) {
    return false; // acceptance handled by clearing flashing
  }
  function clearAlarm(id) {
    delete S.active[id];
    delete S.flashing[id];
  }

  function acceptAlarms() {
    for (var id in S.active) S.flashing[id] = false;
  }

  function anyFlashing() {
    for (var id in S.flashing) if (S.flashing[id]) return true;
    return false;
  }

  function emergencyDump() {
    S.valveCmd = false;
    S.valveLock = true;
    S.dumpT = 2.8;
    S.shake = Math.max(S.shake, 6);
  }

  /* ---------------- the tick: one deterministic step ---------------- */

  function tick(seconds) {
    var want = Number(seconds);
    if (!isFinite(want) || want <= 0) return;
    /* honour the requested interval exactly: step in small deterministic
       slices so one big call behaves like many small ones */
    var left = Math.min(want, 3600);
    while (left > 0.0001) {
      var stepSlice = left > 0.2 ? 0.2 : left;
      stepSim(stepSlice);
      left -= stepSlice;
    }
    if (want > 0) S.time += 0; // time advanced inside stepSim
  }

  function stepSim(dt) {
    S.time += dt;
    if (S.testT > 0) S.testT = Math.max(0, S.testT - dt);
    if (S.denyT > 0) S.denyT = Math.max(0, S.denyT - dt);

    var powered = S.breaker;
    var mSet = machSet();

    /* --- compressor and tanks --- */
    var charging =
      powered && S.compOn && !S.compLatch && !S.compHot && S.tankP < TANK_MAX;
    if (charging) {
      S.compTemp += 0.85 * dt;
      S.tankP = Math.min(TANK_MAX, S.tankP + 3.1 * (1 - S.tankP / 262) * dt);
    } else {
      S.compTemp = approach(
        S.compTemp,
        15,
        0.55 + (S.compTemp - 15) * 0.01,
        dt,
      );
    }
    if (S.compTemp >= 105 && !S.compLatch) S.compLatch = true;

    /* --- dryer regeneration / saturation --- */
    if (powered && S.heater) S.wetness -= 0.02 * dt;
    else S.wetness -= 0.0008 * dt;
    if (S.flowEst) S.wetness += 0.0022 * dt;
    S.wetness = clamp(S.wetness, 0.02, 1);

    /* --- stagnation temperature --- */
    var tTarget = 15 + (powered && S.heater ? 40 : 0);
    if (S.flowEst) {
      S.T0 -= (0.25 + S.mach * 0.33) * dt;
      S.T0 = Math.max(-48, S.T0);
    } else {
      S.T0 = approach(S.T0, tTarget, 2.5, dt);
    }

    /* --- run valve travel --- */
    var want = S.valveCmd && !S.valveLock ? 1 : 0;
    S.valvePos = approach(S.valvePos, want, 3.4, dt);

    /* --- flow: settling, back pressure, mach achieved --- */
    var psWant = S.valvePos > 0.05 ? S.tankP * 0.93 * S.valvePos : 0;
    S.ps = approach(S.ps, psWant, 220, dt);
    var bleedOpen = S.bleed / 100;
    var pdWant =
      1.013 +
      Math.max(0, S.aoa) * 0.028 * (mSet / 2) -
      bleedOpen * 0.5 * clamp(mSet - 1, 0.2, 2);
    S.pdiff = clamp(approach(S.pdiff, Math.max(0.3, pdWant), 30, dt), 0.3, 6);
    var ratio = S.pdiff > 0.29 ? S.ps / S.pdiff : 0;
    var rReq = Math.pow(1 + 0.2 * mSet * mSet, 3.5);

    if (S.unstartT > 0) {
      /* shock swallowed: violent few seconds */
      S.unstartT -= dt;
      S.mach = approach(S.mach, 0.55 + 0.2 * Math.sin(S.time * 37), 6, dt);
      S.shake = Math.max(S.shake, 7);
    } else if (S.valvePos > 0.05 && S.ps > 4) {
      var mTarget;
      if (ratio > rReq * 1.06) mTarget = mSet;
      else if (ratio > rReq) mTarget = mSet * 0.96;
      else mTarget = Math.max(0.35, 0.9 * Math.pow(Math.max(ratio, 0.05), 0.3));
      if (S.startBuzz > 0) {
        /* one-shot starting buzz as the diffuser swallows the blast */
        S.startBuzz -= dt;
        if (S.startBuzz <= 0) S.startBuzz = -1;
        else mTarget *= 0.55 + 0.45 * (1 - S.startBuzz / 1.2);
      }
      S.mach = approach(S.mach, mTarget, 5, dt);
    } else {
      S.mach = approach(S.mach, 0, 4, dt);
    }
    if (S.dumpT > 0) {
      S.dumpT -= dt;
      S.tankP = Math.max(18, S.tankP - 26 * dt);
      S.shake = Math.max(S.shake, 4);
    }

    var draining = S.valvePos > 0.05 && S.unstartT <= 0 && S.dumpT <= 0;
    if (draining) {
      S.tankP = Math.max(
        0,
        S.tankP - S.valvePos * (0.5 + S.mach * S.mach * 0.31) * dt,
      );
    }

    S.flowEst = S.valvePos > 0.9 && S.tankP > 10 && S.mach > mSet - 0.08;
    if (S.flowEst) {
      S.runSeconds += dt;
      if (S.startBuzz === 0) S.startBuzz = 1.2;
    } else if (S.valvePos < 0.05) {
      S.startBuzz = 0;
    }
    S.running = S.flowEst;

    /* --- angle of attack drive --- */
    if (!S.stingDamaged) {
      S.aoa = approach(S.aoa, S.aoaCmd, 7, dt);
    }

    /* --- sting buffet --- */
    var buffetBase = 0;
    if (S.running) {
      var over = S.aoa - (critAoA(S.mach) - 2);
      buffetBase = (Math.max(0, over) / 2.5) * clamp(S.mach / 2, 0.6, 1.5);
    }
    if (S.stingFault) buffetBase = Math.max(buffetBase, 1.6);
    if (S.unstartT > 0) buffetBase = Math.max(buffetBase, 1.4);
    S.buffet = approach(S.buffet, buffetBase, 2.2, dt);
    if (S.buffet > 1.45 && (S.flowEst || S.dumpT > 0)) {
      S.damageT += dt;
      if (S.damageT > 6 && !S.stingDamaged) {
        S.stingDamaged = true;
        emergencyDump();
      }
    } else {
      S.damageT = Math.max(0, S.damageT - dt * 0.5);
    }
    if (S.buffet > 0.35 || S.unstartT > 0) {
      S.shake = Math.max(S.shake, clamp((S.buffet - 0.35) * 3, 0, 3.2));
    }

    /* --- nozzle condensation --- */
    var dew = dewline(S.mach);
    if (S.running && S.T0 < dew) {
      S.condensation += ((dew - S.T0) / 22) * (0.55 + S.wetness) * 2.2 * dt;
    } else {
      S.condensation = Math.max(0, S.condensation - 0.5 * dt);
    }
    if (S.condensation > 2.2 && S.running) {
      S.foulT += dt;
      if (S.foulT > 12 && !S.opticsFouled) S.opticsFouled = true;
    } else {
      S.foulT = Math.max(0, S.foulT - dt * 0.4);
    }

    /* --- diffuser unstart risk --- */
    var risky = false;
    var riskRate = 0.42;
    if (S.running) {
      var bleedShort = bleedOpen < needBleed(S.mach) - 0.14;
      var aoaOver = S.aoa > critAoA(S.mach) + 2.5;
      risky =
        bleedShort || aoaOver || (S.mach >= 2.5 && S.aoa > critAoA(S.mach));
      if (aoaOver) riskRate = 1.1;
    }
    if (risky) {
      S.riskT += riskRate * dt;
      if (S.riskT > 2.2) {
        S.riskT = 0;
        S.unstartT = 2.6;
      }
    } else {
      S.riskT = Math.max(0, S.riskT - dt * 0.8);
    }
    if (S.unstartT > 0 && S.unstartT - dt <= 0) {
      S.unstartLatch = true;
      emergencyDump();
    }

    /* --- balance forces --- */
    var cl = 0.09 * (S.aoa + 2);
    if (Math.abs(S.aoa) > critAoA(Math.max(S.mach, 1.2))) cl *= 0.35;
    var fScale = S.mach * S.mach * S.ps * 0.21;
    var liftT = fScale * (0.62 + cl * 1.9);
    var dragT = fScale * (0.16 + 0.5 * cl * cl * 2.2);
    if (S.unstartT > 0) {
      liftT *= 3.2;
      dragT *= 3.6;
    }
    S.lift = clamp(approach(S.lift, liftT, 400, dt), 0, 240);
    S.drag = clamp(approach(S.drag, dragT, 400, dt), 0, 240);

    S.shake = Math.max(0, S.shake - dt * 6);

    /* --- alarms --- */
    if (S.running && S.tankP < 40) raiseAlarm("tank");
    else clearAlarm("tank");

    if (S.wetness > 0.85) raiseAlarm("dryer");
    else clearAlarm("dryer");

    if (S.condensation > 1) raiseAlarm("moisture");
    else clearAlarm("moisture");

    if (S.buffet > 1 || S.stingFault) raiseAlarm("buffet");
    else if (!S.stingFault) clearAlarm("buffet");

    if (S.unstartLatch) raiseAlarm("unstart");
    else clearAlarm("unstart");

    if (S.compTemp >= 95 || S.compHot || (S.compLatch && S.compTemp >= 70))
      raiseAlarm("comphot");
    else clearAlarm("comphot");

    if (S.stingDamaged) raiseAlarm("sting");
    else clearAlarm("sting");

    if (S.opticsFouled) raiseAlarm("optics");
    else clearAlarm("optics");
  }

  /* ---------------- public API ---------------- */

  function state() {
    var alarms = [];
    for (var id in S.active) if (S.active[id]) alarms.push(ALARM_NAMES[id]);
    return {
      name: NAME,
      phase:
        S.dumpT > 0
          ? "dump"
          : S.unstartT > 0
            ? "unstart"
            : S.running
              ? "running"
              : S.valvePos > 0.05
                ? "flowing"
                : S.tankP >= TANK_CHARGED
                  ? "charged"
                  : S.compOn && S.breaker
                    ? "charging"
                    : "cold",
      breaker: S.breaker,
      compressor: {
        on: S.compOn && S.breaker && !S.compLatch,
        temp: round1(S.compTemp),
        latched: S.compLatch,
      },
      tankPressure: round1(S.tankP),
      dryerHeater: S.heater,
      dryerWetness: round2(S.wetness),
      machBlock: machSet(),
      mach: round3(S.mach),
      incidenceDeg: round1(S.aoa),
      bleedPercent: Math.round(S.bleed),
      settlingPressure: round1(S.ps),
      diffuserPressure: round2(S.pdiff),
      stagnationTemp: round1(S.T0),
      dewline: round1(dewline(S.mach)),
      liftKg: round1(S.lift),
      dragKg: round1(S.drag),
      buffetIndex: round2(S.buffet),
      condensationIndex: round2(S.condensation),
      runSeconds: Math.round(S.runSeconds),
      valvesLocked: S.valveLock,
      schlieren: S.opticsFouled
        ? "fouled"
        : S.unstartT > 0
          ? "unstart"
          : S.condensation > 0.25
            ? "condensing"
            : S.running
              ? "shocks"
              : "idle",
      alarms: alarms,
    };
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }
  function round2(v) {
    return Math.round(v * 100) / 100;
  }
  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      S.wetness = 0.97;
      if (S.running) S.condensation = Math.max(S.condensation, 1.2);
    } else if (f === FAULTS[1]) {
      S.stingFault = true;
    } else if (f === FAULTS[2]) {
      S.compHot = true;
      S.compTemp = Math.max(S.compTemp, 112);
    } else {
      throw new Error("unknown fault: " + fault);
    }
  }

  function reset() {
    S = freshState();
    $$('.fg-switches input[type="checkbox"]').forEach(function (cb) {
      cb.checked = false;
    });
    syncControls();
  }

  /* ---------------- sound (after a gesture only) ---------------- */

  var AU = {
    ctx: null,
    master: null,
    rush: null,
    rushGain: null,
    buzGain: null,
    muted: false,
    lastUpd: 0,
  };

  function audioInit() {
    if (AU.ctx) {
      if (AU.ctx.state === "suspended") AU.ctx.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      var ctx = new AC();
      var master = ctx.createGain();
      master.gain.value = AU.muted ? 0 : 1;
      master.connect(ctx.destination);

      var len = ctx.sampleRate * 2;
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      var bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 900;
      bp.Q.value = 0.6;
      var rg = ctx.createGain();
      rg.gain.value = 0;
      src.connect(bp).connect(rg).connect(master);
      src.start();

      var osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 640;
      var bg = ctx.createGain();
      bg.gain.value = 0;
      osc.connect(bg).connect(master);
      osc.start();

      AU.ctx = ctx;
      AU.master = master;
      AU.rush = bp;
      AU.rushGain = rg;
      AU.buzGain = bg;
    } catch (e) {
      AU.ctx = null;
    }
  }

  function audioUpdate(now) {
    if (!AU.ctx) return;
    if (now - AU.lastUpd < 110) return;
    AU.lastUpd = now;
    var t = AU.ctx.currentTime;
    var rushT = 0;
    if (S.dumpT > 0) rushT = 0.16;
    else if (S.flowEst) rushT = 0.035 + 0.05 * (S.mach / 3);
    AU.rushGain.gain.setTargetAtTime(AU.muted ? 0 : rushT, t, 0.15);
    AU.rush.frequency.setTargetAtTime(600 + S.mach * 420, t, 0.2);
    var buz = 0;
    if (!AU.muted && anyFlashing() && S.time % 0.9 < 0.45) buz = 0.045;
    AU.buzGain.gain.setTargetAtTime(buz, t, 0.02);
  }

  function click(freq) {
    if (!AU.ctx || AU.muted) return;
    try {
      var t = AU.ctx.currentTime;
      var o = AU.ctx.createOscillator();
      var g = AU.ctx.createGain();
      o.type = "square";
      o.frequency.value = freq || 180;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g).connect(AU.master);
      o.start(t);
      o.stop(t + 0.08);
    } catch (e) {}
  }

  /* ---------------- drum counters ---------------- */

  var DRUM_H = 26;

  function buildDrum(el, pattern) {
    if (el.dataset.pattern === pattern) return;
    el.dataset.pattern = pattern;
    el.innerHTML = "";
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern[i];
      var cell = document.createElement("span");
      cell.className = "cell" + (ch === "#" ? "" : " narrow");
      var strip = document.createElement("i");
      var chars;
      if (ch === "#")
        chars = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
      else if (ch === "+") chars = ["+", "\u2212"];
      else if (ch === ":") chars = [":"];
      else if (ch === ".") chars = ["."];
      else if (ch === "o") chars = ["\u00B0"];
      else chars = [" "];
      for (var k = 0; k < chars.length; k++) {
        var b = document.createElement("b");
        b.textContent = chars[k];
        strip.appendChild(b);
      }
      cell.appendChild(strip);
      el.appendChild(cell);
    }
  }

  function setDrum(el, pattern, value) {
    buildDrum(el, pattern);
    var cells = el.children;
    for (var i = 0; i < cells.length; i++) {
      var ch = pattern[i];
      var c = value.charAt(i);
      var strip = cells[i].firstChild;
      var idx = 0;
      if (ch === "#") idx = clamp(parseInt(c, 10) || 0, 0, 9);
      else if (ch === "+") idx = c === "\u2212" ? 1 : 0;
      strip.style.transform = "translateY(" + -idx * DRUM_H + "px)";
    }
  }

  function fmtMach(m) {
    var v = clamp(Math.round(m * 100) / 100, 0, 3.99);
    var whole = Math.floor(v);
    var frac = Math.round((v - whole) * 100);
    if (frac >= 100) {
      whole += 1;
      frac = 0;
    }
    return String(whole) + "." + ("0" + frac).slice(-2);
  }
  function fmtAoA(a) {
    var neg = a < -0.05;
    var v = Math.abs(Math.round(a * 10) / 10);
    var w = Math.floor(v);
    var f = Math.round((v - w) * 10);
    return (neg ? "\u2212" : "+") + ("0" + w).slice(-2) + "." + f;
  }
  function fmtTime(sec) {
    sec = Math.min(sec, 5999);
    var mm = Math.floor(sec / 60);
    var ss = Math.floor(sec % 60);
    return ("0" + mm).slice(-2) + ":" + ("0" + ss).slice(-2);
  }

  /* ---------------- dials ---------------- */

  function dialFace(cv, spec) {
    var ctx = cv.getContext("2d");
    var w = cv.width,
      h = cv.height,
      cx = w / 2,
      cy = h / 2,
      R = w / 2 - 6;
    ctx.clearRect(0, 0, w, h);
    /* ivory face */
    var grad = ctx.createRadialGradient(
      cx * 0.7,
      cy * 0.65,
      R * 0.1,
      cx,
      cy,
      R,
    );
    grad.addColorStop(0, "#f4efdf");
    grad.addColorStop(1, "#ddd5bd");
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#14161a";
    ctx.stroke();

    var a0 = (-135 * Math.PI) / 180,
      a1 = (135 * Math.PI) / 180;
    function ang(f) {
      return a0 + (a1 - a0) * f;
    }
    function pt(a, r) {
      return [
        cx + Math.cos(a - Math.PI / 2) * r,
        cy + Math.sin(a - Math.PI / 2) * r,
      ];
    }

    /* red limit arc */
    if (spec.redFrom !== undefined) {
      var rf = (spec.redFrom - spec.min) / (spec.max - spec.min);
      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        R - 7,
        ang(clamp(rf, 0, 1)) - Math.PI / 2,
        ang(1) - Math.PI / 2,
      );
      ctx.strokeStyle = "#c23a20";
      ctx.lineWidth = 5;
      ctx.stroke();
    }
    /* blue good band */
    if (spec.band) {
      var bf = (spec.band[0] - spec.min) / (spec.max - spec.min);
      var bt = (spec.band[1] - spec.min) / (spec.max - spec.min);
      ctx.beginPath();
      ctx.arc(cx, cy, R - 7, ang(bf) - Math.PI / 2, ang(bt) - Math.PI / 2);
      ctx.strokeStyle = "#2c5f86";
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    /* ticks */
    var steps = spec.steps || 10;
    ctx.strokeStyle = "#14161a";
    for (var i = 0; i <= steps; i++) {
      var f = i / steps;
      var a = ang(f);
      var p1 = pt(a, R - 3),
        p2 = pt(a, R - (i % 2 === 0 ? 13 : 9));
      ctx.lineWidth = i % 2 === 0 ? 2.2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
      if (i % 2 === 0) {
        var v = spec.min + (spec.max - spec.min) * f;
        var lbl = spec.fmt ? spec.fmt(v) : String(Math.round(v));
        var tp = pt(a, R - 22);
        ctx.fillStyle = "#14161a";
        ctx.font =
          "bold " +
          Math.round(w * 0.085) +
          "px 'Arial Narrow', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lbl, tp[0], tp[1]);
      }
    }
    /* caption */
    ctx.fillStyle = "#3c4247";
    ctx.font =
      "bold " + Math.round(w * 0.075) + "px 'Arial Narrow', Arial, sans-serif";
    ctx.fillText(spec.label, cx, cy + R * 0.52);
  }

  function dialNeedle(cv, spec, value) {
    var ctx = cv.getContext("2d");
    var w = cv.width,
      cx = w / 2,
      cy = cv.height / 2,
      R = w / 2 - 6;
    var f = clamp((value - spec.min) / (spec.max - spec.min), -0.02, 1.02);
    var a = (-135 + 270 * f) * (Math.PI / 180) - Math.PI / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(-3.4, 8);
    ctx.lineTo(0, -R + 16);
    ctx.lineTo(3.4, 8);
    ctx.closePath();
    ctx.fillStyle = "#14161a";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "#3a4045";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#101214";
    ctx.stroke();
  }

  var DIAL_SPECS = {
    settle: { min: 0, max: 250, steps: 10, label: "BAR", redFrom: 218 },
    diffuser: { min: 0, max: 6, steps: 8, label: "BAR", band: [1.2, 4] },
    lift: { min: 0, max: 200, steps: 8, label: "KG" },
    drag: { min: 0, max: 200, steps: 8, label: "KG" },
  };

  /* ---------------- schlieren viewport ---------------- */

  var scCanvas = $("#schlieren");
  var scx = scCanvas.getContext("2d");

  function fitSchlieren() {
    var dpr = window.devicePixelRatio || 1;
    var r = scCanvas.getBoundingClientRect();
    scCanvas.width = Math.max(320, Math.round(r.width * dpr));
    scCanvas.height = Math.max(150, Math.round(r.height * dpr));
  }

  function n1(seed) {
    var x = Math.sin(seed * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawSchlieren() {
    var W = scCanvas.width,
      H = scCanvas.height;
    var shake = S.shake;
    var ox = 0,
      oy = 0;
    if (shake > 0.05) {
      ox = (n1(Math.floor(S.time * 31)) - 0.5) * shake * 2.4;
      oy = (n1(Math.floor(S.time * 31) + 9.7) - 0.5) * shake * 2.4;
    }
    scx.save();
    scx.translate(ox, oy);

    var lit = S.breaker || S.flowEst || S.dumpT > 0;
    /* field */
    if (!lit) {
      /* spark lamp off: dark glass with a faint room reflection */
      var dg = scx.createLinearGradient(0, 0, W, H);
      dg.addColorStop(0, "#171b1f");
      dg.addColorStop(0.45, "#101317");
      dg.addColorStop(0.5, "#1c2126");
      dg.addColorStop(0.52, "#0d1013");
      dg.addColorStop(1, "#12151a");
      scx.fillStyle = dg;
      scx.fillRect(-20, -20, W + 40, H + 40);
      scx.fillStyle = "rgba(200,210,216,0.045)";
      scx.beginPath();
      scx.ellipse(W * 0.32, H * 0.2, W * 0.3, H * 0.16, -0.35, 0, Math.PI * 2);
      scx.fill();
      scx.strokeStyle = "rgba(160,170,176,0.28)";
      scx.lineWidth = 2;
      scx.strokeRect(W * 0.045, H * 0.1, W * 0.91, H * 0.8);
      scx.fillStyle = "rgba(150,158,164,0.55)";
      scx.font =
        "bold " + Math.round(H * 0.07) + "px 'Arial Narrow', Arial, sans-serif";
      scx.textAlign = "center";
      scx.fillText(
        "SPARK LAMP OFF · MAIN BREAKER ON TO LIGHT",
        W / 2,
        H * 0.55,
      );
      scx.textAlign = "left";
      scx.restore();
      return;
    } else {
      var g = scx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#aab1b6");
      g.addColorStop(0.5, "#c3c9cd");
      g.addColorStop(1, "#9aa1a6");
      scx.fillStyle = g;
      scx.fillRect(-20, -20, W + 40, H + 40);
      /* knife-edge banding */
      scx.fillStyle = "rgba(40,46,52,0.10)";
      scx.fillRect(0, H * 0.12, W, H * 0.1);
      scx.fillStyle = "rgba(255,255,255,0.14)";
      scx.fillRect(0, H * 0.66, W, H * 0.12);
    }
    if (!lit) {
      scx.restore();
      return;
    }

    var mx = W * 0.4,
      my = H * 0.52;
    var chord = Math.min(W * 0.17, 190);
    var thick = chord * 0.16;
    var rad = (S.aoa * Math.PI) / 180;
    var m = S.mach;

    /* sting from bottom */
    scx.strokeStyle = "#3a4045";
    scx.lineWidth = Math.max(5, H * 0.02);
    scx.beginPath();
    scx.moveTo(mx + Math.sin(rad) * chord * 0.1, my + chord * 0.05);
    scx.lineTo(mx + H * 0.34, H + 12);
    scx.stroke();

    /* aerofoil silhouette */
    scx.save();
    scx.translate(mx, my);
    scx.rotate(-rad);
    scx.beginPath();
    scx.moveTo(-chord / 2, 0);
    scx.bezierCurveTo(
      -chord * 0.3,
      -thick * 0.72,
      chord * 0.16,
      -thick * 0.78,
      chord / 2,
      0,
    );
    scx.bezierCurveTo(
      chord * 0.16,
      thick * 0.62,
      -chord * 0.3,
      thick * 0.56,
      -chord / 2,
      0,
    );
    scx.fillStyle = "#22262a";
    scx.fill();
    scx.restore();

    if (S.running || S.dumpT > 0) {
      var strength = clamp((m - 1.02) / 1.4, 0, 1);
      var beta = Math.asin(clamp(1 / Math.max(m, 1.01), 0, 1));
      var len = W * 0.74;
      scx.lineCap = "round";

      function shock(x0, y0, dirDown, alpha, width) {
        var dx = Math.cos(beta) * len;
        var dy = Math.sin(beta) * len * (dirDown ? 1 : -1);
        var seg = 16;
        /* dark band with a bright knife-edge companion, like a print */
        for (var pass = 0; pass < 2; pass++) {
          var off = pass === 0 ? 0 : width * 1.9;
          scx.strokeStyle =
            pass === 0
              ? "rgba(24,28,34," + alpha + ")"
              : "rgba(250,252,253," + alpha * 0.55 + ")";
          scx.lineWidth = pass === 0 ? width : width * 0.55;
          scx.beginPath();
          for (var i = 0; i <= seg; i++) {
            var f2 = i / seg;
            var bow = Math.pow(f2, 3) * chord * 0.55;
            var px2 = x0 + dx * f2 + bow * 0.45;
            var py2 = y0 + dy * f2 + bow * 0.28 + off;
            if (i === 0) scx.moveTo(px2, py2);
            else scx.lineTo(px2, py2);
          }
          scx.stroke();
        }
      }

      var aoaFac = clamp(0.4 + Math.abs(S.aoa) / 11, 0.4, 1.35);
      shock(
        mx - chord * 0.44,
        my + Math.sin(rad) * chord * 0.42,
        false,
        clamp((0.32 + 0.58 * strength) * aoaFac, 0, 0.92),
        1.8 + strength * 3,
      );
      shock(
        mx + chord * 0.47,
        my - Math.sin(rad) * chord * 0.44,
        true,
        clamp((0.26 + 0.5 * strength) * aoaFac, 0, 0.85),
        1.4 + strength * 2.4,
      );
      /* expansion fan */
      scx.strokeStyle = "rgba(255,255,255," + (0.22 + 0.22 * strength) + ")";
      scx.lineWidth = 1.4;
      for (var fi = 0; fi < 3; fi++) {
        var fa = beta * 0.55 * (1 + fi * 0.35);
        scx.beginPath();
        scx.moveTo(mx + chord * (0.05 + fi * 0.06), my - thick * 0.4);
        scx.lineTo(
          mx + Math.cos(fa) * len * 0.8,
          my - Math.sin(fa) * len * 0.8 * 0.5,
        );
        scx.stroke();
      }
      /* faint supersonic streamers for texture */
      scx.strokeStyle = "rgba(255,255,255,0.10)";
      scx.lineWidth = 1;
      for (var si = 0; si < 7; si++) {
        var sy = H * (0.12 + n1(si * 3.7) * 0.76);
        var sx0 =
          ((n1(si * 9.1) * W * 1.4 + S.time * (340 + n1(si) * 260)) %
            (W + 220)) -
          110;
        scx.beginPath();
        scx.moveTo(sx0, sy);
        scx.lineTo(sx0 + 90, sy);
        scx.stroke();
      }
    }

    /* condensation fog */
    if (S.condensation > 0.22) {
      var ca = clamp((S.condensation - 0.22) / 1.4, 0, 0.75);
      for (var pi = 0; pi < 26; pi++) {
        var px =
          ((n1(pi * 3.3) * W + S.time * (60 + n1(pi) * 90)) % (W + 80)) - 40;
        var py = H * (0.15 + n1(pi * 7.7) * 0.7);
        var pr = 8 + n1(pi * 5.1) * 26;
        var rg = scx.createRadialGradient(px, py, 1, px, py, pr);
        rg.addColorStop(0, "rgba(245,247,248," + 0.5 * ca + ")");
        rg.addColorStop(1, "rgba(245,247,248,0)");
        scx.fillStyle = rg;
        scx.beginPath();
        scx.arc(px, py, pr, 0, Math.PI * 2);
        scx.fill();
      }
    }

    /* unstart churn */
    if (S.unstartT > 0) {
      scx.fillStyle =
        "rgba(30,26,24," + clamp(S.unstartT / 2.6, 0, 1) * 0.4 + ")";
      scx.fillRect(0, 0, W * 0.55, H);
      scx.strokeStyle = "rgba(20,18,16,0.6)";
      scx.lineWidth = 3;
      for (var ui = 0; ui < 5; ui++) {
        scx.beginPath();
        var uy = H * (0.15 + ui * 0.17);
        scx.moveTo(W * 0.02, uy);
        scx.quadraticCurveTo(
          W * 0.2,
          uy + 26 * Math.sin(S.time * 22 + ui),
          W * 0.42,
          uy + 10 * Math.cos(S.time * 19 + ui * 2),
        );
        scx.stroke();
      }
    }

    /* fouled optics */
    if (S.opticsFouled) {
      for (var bi = 0; bi < 7; bi++) {
        var bx = n1(bi * 11.3) * W;
        var by = n1(bi * 4.9) * H;
        var br = 30 + n1(bi * 2.3) * 70;
        var bg2 = scx.createRadialGradient(bx, by, 2, bx, by, br);
        bg2.addColorStop(0, "rgba(214,208,196,0.5)");
        bg2.addColorStop(1, "rgba(214,208,196,0)");
        scx.fillStyle = bg2;
        scx.beginPath();
        scx.arc(bx, by, br, 0, Math.PI * 2);
        scx.fill();
      }
      scx.fillStyle = "rgba(216,212,202,0.34)";
      scx.fillRect(0, 0, W, H);
    }

    /* etched corner marks */
    scx.strokeStyle = "rgba(20,24,28,0.5)";
    scx.lineWidth = 2;
    scx.strokeRect(W * 0.045, H * 0.1, W * 0.91, H * 0.8);
    scx.fillStyle = "rgba(20,24,28,0.62)";
    scx.font =
      "bold " + Math.round(H * 0.075) + "px 'Arial Narrow', Arial, sans-serif";
    scx.fillText("TEST SECTION 10in \u00D7 10in", W * 0.06, H * 0.94);
    scx.fillText("FLOW \u2192", W * 0.84, H * 0.94);
    scx.restore();
  }

  /* ---------------- DOM references ---------------- */

  var el = {
    breaker: $("#breaker"),
    heater: $("#heater"),
    comp: $("#comp"),
    runvalve: $("#runvalve"),
    qvlever: $("#qv-lever"),
    machsel: $("#machsel"),
    rotaryPointer: $("#machsel .rotary-pointer"),
    bleed: $("#bleed"),
    bleedRead: $("[data-bleedread]"),
    handwheel: $("#handwheel"),
    hwRim: $("#handwheel .hw-rim"),
    accept: $("#accept"),
    lampstest: $("#lampstest"),
    tripreset: $("#tripreset"),
    coldreset: $("#coldreset"),
    soundcut: $("#soundcut"),
    guard: $("#faultguard"),
    guardCover: $(".fg-cover"),
    dialog: $("dialog[data-manual]"),
  };

  var drumEls = {
    mach: $('[data-drum="mach"]'),
    aoa: $('[data-drum="aoa"]'),
    time: $('[data-drum="time"]'),
  };

  var winEls = {};
  $$("[data-win]").forEach(function (w) {
    winEls[w.getAttribute("data-win")] = w;
  });

  var dialCvs = {};
  $$("[data-dial]").forEach(function (cv) {
    dialCvs[cv.getAttribute("data-dial")] = cv;
  });

  var thermoEls = {};
  $$("[data-thermo]").forEach(function (t) {
    thermoEls[t.getAttribute("data-thermo")] = {
      root: t,
      fluid: t.querySelector(".thermo-fluid"),
    };
  });
  var dewMark = $("[data-dewmark]");

  /* ---------------- rendering ---------------- */

  var ROT_ANGLES = [-46, -16, 16, 46];

  function render() {
    /* jewels */
    setJewel("power", S.breaker, false);
    setJewel("charged", S.tankP >= TANK_CHARGED, false);
    setJewel("running", S.flowEst, false);
    var anyAlarm = false;
    for (var id in S.active) if (S.active[id]) anyAlarm = true;
    setJewel("fault", anyAlarm, anyFlashing());

    /* air path lamps */
    apLamp("compressor", S.breaker && S.compOn && !S.compLatch);
    apLamp("dryer", S.breaker && S.heater);
    apLamp("tanks", S.tankP >= TANK_CHARGED);
    apLamp("settle", S.ps > 20);
    apLamp("test", S.flowEst);
    apLamp("diffuser", S.flowEst);
    apLamp("exhaust", S.flowEst || S.dumpT > 0);

    /* pilots */
    var pilotHeater = $("[data-pilot='heater']");
    var pilotComp = $("[data-pilot='comp']");
    pilotHeater.classList.toggle("on", S.breaker && S.heater);
    pilotComp.classList.toggle("on", S.breaker && S.compOn && !S.compLatch);

    /* thermometers */
    thermoEls.comp.fluid.style.height =
      clamp(((S.compTemp - 10) / 115) * 100, 3, 98) + "%";
    thermoEls.stag.fluid.style.height =
      clamp(((S.T0 + 70) / 140) * 100, 3, 97) + "%";
    var dew = dewline(machSet());
    dewMark.textContent =
      "dew " + (dew > 0 ? "+" : "") + Math.round(dew) + "\u00B0";
    dewMark.style.color = S.running && S.T0 < dew + 2 ? "#ff9d8a" : "";

    /* drums */
    setDrum(drumEls.mach, "#.##", fmtMach(S.mach));
    setDrum(drumEls.aoa, "+##.#o", fmtAoA(S.aoa));
    setDrum(drumEls.time, "##:##", fmtTime(S.runSeconds));

    /* dials */
    dialNeedle(dialCvs.settle, DIAL_SPECS.settle, S.ps);
    dialNeedle(dialCvs.diffuser, DIAL_SPECS.diffuser, S.pdiff);
    dialNeedle(dialCvs.lift, DIAL_SPECS.lift, S.lift);
    dialNeedle(dialCvs.drag, DIAL_SPECS.drag, S.drag);

    /* annunciator windows */
    for (var wid in winEls) {
      var w = winEls[wid];
      var st = "off";
      if (S.active[wid]) st = S.flashing[wid] ? "flash" : "steady";
      if (S.testT > 0) st = "flash";
      w.setAttribute("data-state", st);
    }

    /* valve lever: -62deg shut, 62deg open */
    var va = -62 + S.valvePos * 124;
    el.qvlever.setAttribute(
      "transform",
      "translate(60 82) rotate(" + va.toFixed(1) + ")",
    );
    el.runvalve.classList.toggle("open", S.valveCmd);

    /* selector pointer */
    var ra = ROT_ANGLES[S.machIdx];
    el.rotaryPointer.style.transform = "rotate(" + ra + "deg)";

    /* bleed knob */
    el.bleedRead.textContent = Math.round(S.bleed) + "%";
    var ka = -140 + (S.bleed / 100) * 280;
    var kp = el.bleed.querySelector(".knob-pointer").parentElement;
    kp.style.transform = "rotate(" + ka + "deg)";

    /* handwheel */
    el.hwRim.style.transform = "rotate(" + (S.aoa * 7 - 20) + "deg)";
    el.handwheel.setAttribute(
      "aria-valuenow",
      String(Math.round(S.aoa * 10) / 10),
    );

    drawSchlieren();
  }

  function setJewel(id, on, blink) {
    var j = $('[data-jewel="' + id + '"]');
    if (!j) return;
    j.classList.toggle("on", !!on);
    j.classList.toggle("blink", !!blink);
  }

  function apLamp(name, on) {
    var l = $('[data-aplamp="' + name + '"]');
    if (!l) return;
    l.classList.toggle("on", !!on);
    l.classList.toggle("run", name === "test");
  }

  /* ---------------- control wiring ---------------- */

  function syncControls() {
    el.breaker.setAttribute("aria-checked", S.breaker ? "true" : "false");
    el.runvalve.setAttribute("aria-pressed", S.valveCmd ? "true" : "false");
    el.machsel.setAttribute("aria-valuenow", String(S.machIdx));
    el.machsel.setAttribute("aria-valuetext", "Mach " + machSet().toFixed(1));
    el.handwheel.setAttribute("aria-valuemin", "-5");
    el.handwheel.setAttribute("aria-valuemax", "15");
  }

  el.breaker.addEventListener("click", function () {
    S.breaker = !S.breaker;
    if (!S.breaker) {
      S.compOn = S.compOn && false;
    }
    click(140);
    syncControls();
  });

  el.heater.addEventListener("change", function () {
    S.heater = el.heater.checked;
    click(160);
  });

  el.comp.addEventListener("change", function () {
    S.compOn = el.comp.checked;
    if (S.compOn && (S.compLatch || S.compHot)) {
      el.comp.checked = false;
      S.compOn = false;
      S.denyT = 0.6;
    }
    click(120);
  });

  el.runvalve.addEventListener("click", function () {
    if (S.valveLock && !S.valveCmd) {
      S.denyT = 0.6;
      click(90);
      return;
    }
    S.valveCmd = !S.valveCmd;
    click(S.valveCmd ? 210 : 170);
    syncControls();
  });

  function setMach(idx) {
    if (S.flowEst) {
      S.denyT = 0.6;
      return;
    }
    S.machIdx = clamp(idx, 0, MACH_BLOCKS.length - 1);
    click(150);
    syncControls();
  }

  el.machsel.addEventListener("keydown", function (ev) {
    var k = ev.key;
    if (k === "ArrowRight" || k === "ArrowUp") {
      ev.preventDefault();
      setMach(S.machIdx + 1);
    } else if (k === "ArrowLeft" || k === "ArrowDown") {
      ev.preventDefault();
      setMach(S.machIdx - 1);
    } else if (k === "Home") {
      ev.preventDefault();
      setMach(0);
    } else if (k === "End") {
      ev.preventDefault();
      setMach(MACH_BLOCKS.length - 1);
    }
  });

  el.machsel.addEventListener("click", function (ev) {
    var r = el.machsel.getBoundingClientRect();
    var dx = ev.clientX - (r.left + r.width / 2);
    var dy = ev.clientY - (r.top + r.height / 2);
    var a = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    var best = 0,
      bd = 999;
    for (var i = 0; i < ROT_ANGLES.length; i++) {
      var d = Math.abs(((ROT_ANGLES[i] - a + 540) % 360) - 180);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    setMach(best);
  });

  function setBleed(v) {
    S.bleed = clamp(Math.round(v), 0, 100);
    el.bleed.setAttribute("aria-valuenow", String(S.bleed));
  }

  el.bleed.addEventListener("keydown", function (ev) {
    var k = ev.key;
    if (k === "ArrowRight" || k === "ArrowUp") {
      ev.preventDefault();
      setBleed(S.bleed + 2);
    } else if (k === "ArrowLeft" || k === "ArrowDown") {
      ev.preventDefault();
      setBleed(S.bleed - 2);
    } else if (k === "Home") {
      ev.preventDefault();
      setBleed(0);
    } else if (k === "End") {
      ev.preventDefault();
      setBleed(100);
    }
  });

  (function bleedDrag() {
    var dragging = false,
      lastY = 0;
    el.bleed.addEventListener("pointerdown", function (ev) {
      dragging = true;
      lastY = ev.clientY;
      el.bleed.setPointerCapture(ev.pointerId);
    });
    el.bleed.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var dy = lastY - ev.clientY;
      lastY = ev.clientY;
      if (dy) setBleed(S.bleed + dy * 0.9);
    });
    el.bleed.addEventListener("pointerup", function () {
      dragging = false;
    });
  })();

  function setAoa(v) {
    if (S.stingDamaged) {
      S.denyT = 0.6;
      return;
    }
    S.aoaCmd = clamp(Math.round(v * 2) / 2, -5, 15);
  }

  el.handwheel.addEventListener("keydown", function (ev) {
    var step = ev.shiftKey ? 2 : 0.5;
    var k = ev.key;
    if (k === "ArrowRight" || k === "ArrowUp") {
      ev.preventDefault();
      setAoa(S.aoaCmd + step);
    } else if (k === "ArrowLeft" || k === "ArrowDown") {
      ev.preventDefault();
      setAoa(S.aoaCmd - step);
    } else if (k === "Home") {
      ev.preventDefault();
      setAoa(0);
    }
  });

  (function wheelDrag() {
    var dragging = false,
      lastAng = 0;
    function angOf(ev) {
      var r = el.handwheel.getBoundingClientRect();
      return (
        (Math.atan2(
          ev.clientY - (r.top + r.height / 2),
          ev.clientX - (r.left + r.width / 2),
        ) *
          180) /
        Math.PI
      );
    }
    el.handwheel.addEventListener("pointerdown", function (ev) {
      dragging = true;
      lastAng = angOf(ev);
      el.handwheel.setPointerCapture(ev.pointerId);
    });
    el.handwheel.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var a = angOf(ev);
      var d = a - lastAng;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      lastAng = a;
      setAoa(S.aoaCmd + d * 0.22);
    });
    el.handwheel.addEventListener("pointerup", function () {
      dragging = false;
    });
  })();

  el.accept.addEventListener("click", function () {
    acceptAlarms();
    click(200);
  });

  el.lampstest.addEventListener("click", function () {
    S.testT = 2.2;
    click(240);
  });

  el.tripreset.addEventListener("click", function () {
    var problems = [];
    if (S.compHot && S.compTemp >= 70) problems.push("motor still hot");
    if (S.stingDamaged && (S.running || Math.abs(S.aoa) > 0.75))
      problems.push("shut the flow and zero the incidence first");
    if (S.opticsFouled && (S.wetness >= 0.35 || S.running))
      problems.push("regenerate the dryer before resetting the optics");
    if (problems.length) {
      S.denyT = 0.9;
      click(90);
      return;
    }
    S.compHot = false;
    S.compLatch = false;
    S.stingFault = false;
    S.stingDamaged = false;
    S.opticsFouled = false;
    S.unstartLatch = false;
    S.valveLock = false;
    S.damageT = 0;
    S.foulT = 0;
    S.riskT = 0;
    click(190);
  });

  $$(".fg-switches input[data-inject]").forEach(function (cb) {
    cb.addEventListener("change", function () {
      if (cb.checked) inject(cb.getAttribute("data-inject"));
      click(130);
    });
  });

  el.guardCover.addEventListener("click", function () {
    var open = el.guard.classList.toggle("open");
    el.guardCover.setAttribute("aria-expanded", open ? "true" : "false");
    click(150);
  });

  el.coldreset.addEventListener("click", function () {
    el.coldreset.classList.add("turning");
    click(120);
    setTimeout(function () {
      el.coldreset.classList.remove("turning");
      reset();
      click(180);
    }, 260);
  });

  el.soundcut.addEventListener("click", function () {
    AU.muted = !AU.muted;
    el.soundcut.setAttribute("aria-pressed", AU.muted ? "true" : "false");
    if (AU.master && AU.ctx) {
      AU.master.gain.setTargetAtTime(
        AU.muted ? 0 : 1,
        AU.ctx.currentTime,
        0.05,
      );
    }
  });

  /* manual dialog */
  $("[data-action='manual']").addEventListener("click", function () {
    if (typeof el.dialog.showModal === "function") el.dialog.showModal();
    else el.dialog.setAttribute("open", "");
  });
  $("[data-action='close-manual']").addEventListener("click", function () {
    if (typeof el.dialog.close === "function") el.dialog.close();
    else el.dialog.removeAttribute("open");
  });

  /* unlock audio on first gesture anywhere */
  window.addEventListener(
    "pointerdown",
    function () {
      audioInit();
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "keydown",
    function () {
      audioInit();
    },
    { capture: true },
  );

  /* ---------------- main loop ---------------- */

  var lastT = performance.now();

  function frame(now) {
    var dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0 && dt < 2) tick(dt);
    render();
    audioUpdate(now);
    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) lastT = performance.now();
  });

  window.addEventListener("resize", fitSchlieren);

  /* ---------------- boot ---------------- */

  reset();
  fitSchlieren();
  Object.keys(dialCvs).forEach(function (k) {
    dialFace(dialCvs[k], DIAL_SPECS[k]);
  });
  requestAnimationFrame(frame);

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };
})();
