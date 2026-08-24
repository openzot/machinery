/* ======================================================================
   VINDSKÆR V-62 · NACELLE SERVICEPULT
   Turbine behaviour: aerodynamic rotor against generator torque, pitch
   and yaw servos, hydraulic brake pack, gearbox thermal loop, cable-
   twist supervision and the annunciator chain.

   Classic script, no modules. Everything lives in this IIFE; the fixed
   API is exposed on window.machine. Fully deterministic: every gust is
   a function of simulated time, never of the wall clock.
   ====================================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------- constants */

  var MACHINE_NAME = "Vindskær V-62 Nacelle Controller";
  var FAULTS = [
    "anemometer icing",
    "gearbox oil overheating",
    "yaw cable twist",
  ];

  var ALARM_NAMES = [
    "OVERSPEED",
    "GEARBOX OIL TEMP",
    "HYD PRESSURE LOW",
    "YAW CABLE TWIST",
    "ANEMOMETER ICING",
    "TRIP",
  ];

  /* rotor and drive train */
  var RADIUS_M = 31;
  var SWEEP_M2 = 3019;
  var AIR_RHO = 1.225;
  var INERTIA = 260000; // drive train inertia referred to the HSS
  var RPM_TO_RAD = Math.PI / 30;
  var RPM_RATED = 19;
  var RPM_IDLE_TARGET = 13; // soft-start hold speed, off the grid
  var GEN_K = 330000; // Nm per rad/s -> rated torque at rated speed
  var GEN_TQ_MAX = 700000;
  var MOTOR_TQ = 60000; // converter motoring the rotor up to speed
  var WINDAGE_TQ = 34000; // generator windage off the grid, Nm per rad/s
  var FRICTION_TQ = 5200;
  var BRAKE_TQ = 320000;

  /* limits */
  var RPM_ALARM = 23.5;
  var RPM_TRIP = 26.5;
  var OIL_ALARM_C = 82;
  var OIL_TRIP_C = 95;
  var OIL_RESTART_C = 75;
  var HYD_PRESET_BAR = 160;
  var HYD_ALARM_BAR = 115;
  var TWIST_ALARM_DEG = 540;
  var TWIST_TRIP_DEG = 720;
  var TWIST_RELEASE_DEG = 300;
  var WIND_CUTOUT_MS = 24;

  /* thermal */
  var AMBIENT_C = 12;
  var OIL_CAP = 260000; // J per kelvin
  var COOL_AUTO = 590; // W per kelvin to ambient
  var COOL_FORCE = 1500;

  /* ------------------------------------------------------------ state */

  var S = {};

  function coldStart() {
    S.time = 0;
    S.mode = 0; // 0 STOP, 1 SERVICE, 2 AUTO
    S.pumpOn = false;
    S.brakeOn = true;
    S.lockIn = true; // rotor lock pin engaged
    S.heaterOn = false;
    S.cooling = 0; // 0 OFF, 1 AUTO, 2 FORCED
    S.estop = false;
    S.contactor = false;
    S.rpm = 0;
    S.rotorAngle = 0;
    S.pitchDeg = 88; // parked, feathered
    S.pitchDemandDeg = 88;
    S.windTrue = windAt(0);
    S.windMeasured = S.windTrue;
    S.yawDeg = 205;
    S.windDirDeg = windDirAt(0);
    S.twistDeg = 0;
    S.oilC = AMBIENT_C + 6;
    S.hydBar = 0;
    S.kw = 0;
    S.cutoutTimer = 0;
    S.lampTest = 0;
    S.msgTimer = 0;
    S.msgLine1 = "";
    S.trips = []; // OVERSPEED / GEARBOX TEMP / TWIST LIMIT / EMERGENCY STOP
    S.faultIce = false;
    S.iceStopTimer = 0;
    S.iceMelt = 0;
    S.faultOil = false;
    S.faultTwist = false;
    S.alarmFlash = {}; // name -> true until acknowledged
    S.alarmActive = {}; // name -> true
  }

  /* ----------------------------------------------- deterministic weather */

  function windAt(t) {
    return (
      10.2 +
      2.6 * Math.sin(t * 0.0135 + 0.7) +
      1.7 * Math.sin(t * 0.041 + 2.2) +
      1.0 * Math.sin(t * 0.09 + 4.1) +
      0.6 * Math.sin(t * 0.007 + 1.1)
    );
  }

  function windDirAt(t) {
    return (
      203 + 36 * Math.sin(t * 0.0081 + 1.2) + 13 * Math.sin(t * 0.029 + 0.3)
    );
  }

  /* --------------------------------------------------------- aero model */

  function powerCoef(lambda, beta) {
    var inv = 1 / (lambda + 0.08 * beta) - 0.035 / (beta * beta * beta + 1);
    var li = 1 / Math.max(inv, 1e-6);
    var cp =
      0.22 * (116 / li - 0.4 * beta - 5) * Math.exp(-12.5 / Math.max(li, 1e-6));
    cp = Math.max(-0.02, Math.min(0.47, cp));
    // and keep the brake-like negative torque sane
    return cp;
  }

  function aeroTorque(v, omegaRad, beta) {
    if (v < 0.2 || omegaRad < 0.05) return 0;
    var lambda = (omegaRad * RADIUS_M) / v;
    var cp = powerCoef(lambda, beta);
    var pa = 0.5 * AIR_RHO * SWEEP_M2 * cp * v * v * v; // W
    var q = pa / omegaRad;
    return Math.max(-250000, Math.min(1600000, q));
  }

  function normAngle(d) {
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  function round(v, n) {
    var m = Math.pow(10, n);
    return Math.round(v * m) / m;
  }

  /* ----------------------------------------------------------- ticking */

  function tick(seconds) {
    var dt = Math.max(0, Math.min(5, Number(seconds) || 0));
    S.time += dt;

    var prevAlarms = Object.keys(S.alarmActive).join("|");

    /* weather */
    S.windTrue = windAt(S.time);
    S.windDirDeg = windDirAt(S.time);

    if (S.lampTest > 0) S.lampTest = Math.max(0, S.lampTest - dt);
    if (S.msgTimer > 0) S.msgTimer = Math.max(0, S.msgTimer - dt);

    /* ---- faults evolve ---- */
    if (S.faultIce) {
      if (S.heaterOn) {
        S.iceMelt += dt;
        if (S.iceMelt >= 40) {
          S.faultIce = false;
          S.iceStopTimer = 0;
          S.windMeasured = S.windTrue;
        }
      } else {
        S.windMeasured = Math.max(0, S.windMeasured - dt * 0.09);
      }
    } else {
      S.windMeasured = S.windTrue;
    }

    /* ---- hydraulics ---- */
    if (S.pumpOn && !S.estop) {
      S.hydBar += (HYD_PRESET_BAR - S.hydBar) * Math.min(1, dt * 0.5);
    } else {
      S.hydBar = Math.max(0, S.hydBar - dt * 7);
    }
    var hydOk = S.hydBar >= 90;

    /* ---- pitch demand, servos, rotor and power: sub-stepped ---- */
    var nSub = Math.max(1, Math.ceil(dt / 0.05));
    var h = dt / nSub;
    for (var sub = 0; sub < nSub; sub++) {
      /* pitch demand */
      if (S.estop || S.trips.length || S.mode === 0) {
        S.pitchDemandDeg = 88; // spring-back feather
      } else if (S.mode === 1) {
        S.pitchDemandDeg = S.pitchDeg; // SERVICE: hold where jogged
      } else if (!S.contactor) {
        // soft start: modulate pitch to hold the rotor near idling speed
        S.pitchDemandDeg = Math.max(
          0,
          Math.min(90, (S.rpm - RPM_IDLE_TARGET) * 8),
        );
      } else {
        // on the grid: govern rated speed, spill gusts above rated wind
        var rpmErr = S.rpm - RPM_RATED;
        var gustTerm = Math.max(0, S.windMeasured - 13) * 2.4;
        S.pitchDemandDeg = Math.max(0, Math.min(32, rpmErr * 6 + gustTerm));
      }

      /* pitch servo */
      var pitchRate = S.hydBar < 110 ? 2.4 : 6.5; // weak on accumulators
      var pd = S.pitchDemandDeg - S.pitchDeg;
      S.pitchDeg = Math.min(
        90,
        Math.max(
          -2,
          S.pitchDeg + Math.sign(pd) * Math.min(Math.abs(pd), pitchRate * h),
        ),
      );

      /* rotor */
      var omega = Math.max(0, S.rpm * RPM_TO_RAD);
      var qa = aeroTorque(S.windTrue, Math.max(omega, 0.05), S.pitchDeg);
      // profile drag gives starting torque even when lambda is near zero
      if (S.pitchDeg < 60 && S.windTrue > 1) {
        qa = Math.max(
          qa,
          2100 *
            S.windTrue *
            S.windTrue *
            Math.max(0, 1 - omega / (1.3 + S.windTrue * 0.05)),
        );
      }
      var qg;
      if (S.contactor && S.mode === 2 && !S.estop && !S.trips.length) {
        if (omega < 12 * RPM_TO_RAD) {
          // converter motors the rotor up to speed, fading out by 14 rpm
          qg =
            -MOTOR_TQ *
            Math.max(
              0,
              Math.min(1, (14 * RPM_TO_RAD - omega) / (2 * RPM_TO_RAD)),
            );
        } else {
          var genRamp = Math.min(
            1,
            (omega - 12 * RPM_TO_RAD) / (2.5 * RPM_TO_RAD),
          );
          // converter torque limit follows the believed wind: an iced,
          // frozen-low anemometer quietly strangles the generator
          var tqCap =
            GEN_TQ_MAX * Math.max(0.18, Math.min(1, S.windMeasured / 13));
          qg = Math.min(GEN_K * omega * genRamp, tqCap);
        }
      } else {
        qg = WINDAGE_TQ * omega; // generator windage off the grid
      }
      var qb;
      if (S.brakeOn && hydOk) qb = omega > 0.01 ? BRAKE_TQ : 0;
      else if (S.brakeOn)
        qb = 42000 * omega; // feeble park damper without pressure
      else qb = 0;
      var qf = FRICTION_TQ * Math.sign(omega) + 9000 * omega;
      omega += ((qa - qg - qb - qf) / INERTIA) * h;
      if (omega < 0.015 && qa <= 0) omega = 0;
      S.rpm = omega / RPM_TO_RAD;
      S.rotorAngle = (S.rotorAngle + S.rpm * 6 * h) % 360;

      /* electrical power */
      var mis = Math.abs(normAngle(S.windDirDeg - S.yawDeg));
      var misFactor = Math.max(0.12, Math.cos((mis * Math.PI) / 180));
      if (
        S.contactor &&
        S.mode === 2 &&
        !S.estop &&
        !S.trips.length &&
        S.rpm > 13
      ) {
        S.kw = Math.min(
          1320,
          ((GEN_K * omega * omega) / 1000) * 0.97 * misFactor,
        );
      } else {
        S.kw = 0;
      }
    }

    /* ---- gearbox temperature ---- */
    var lossW = 8000 + (S.rpm > 1 ? 0.021 * S.kw * 1000 : 0);
    if (S.faultOil) lossW *= 2.3;
    var coolK = 0;
    if (S.cooling === 2) coolK = COOL_FORCE;
    else if (S.cooling === 1) coolK = S.faultOil ? COOL_AUTO * 0.22 : COOL_AUTO;
    if (coolK > 0) coolK *= Math.max(0, (S.oilC - 8) / 40);
    S.oilC += ((lossW - coolK * (S.oilC - AMBIENT_C)) / OIL_CAP) * dt;

    S.oilC = Math.max(AMBIENT_C - 2, Math.min(140, S.oilC));

    /* ---- yaw ---- */
    if (S.mode === 2 && !S.estop && !S.trips.length) {
      var err = normAngle(S.windDirDeg - S.yawDeg);
      if (Math.abs(err) > 6) {
        var moved = Math.sign(err) * Math.min(Math.abs(err), 0.5 * dt);
        S.yawDeg += moved;
        S.twistDeg += moved * 0.55;
      }
    }
    /* slow deterministic cable winding, as on every machine ever built */
    S.twistDeg += Math.sin(S.time * 0.0021 + 0.9) * 0.05 * dt;
    if (S.faultTwist) S.twistDeg += 4.6 * dt;
    S.twistDeg = Math.max(-900, Math.min(900, S.twistDeg));

    /* ---- storm protection ---- */
    if (S.windTrue > WIND_CUTOUT_MS && S.contactor && S.mode === 2) {
      S.cutoutTimer += dt;
      if (S.cutoutTimer > 12) {
        S.contactor = false;
        S.pitchDemandDeg = 88;
      }
    } else {
      S.cutoutTimer = Math.max(0, S.cutoutTimer - dt * 2);
    }

    /* ---- blind-anemometer protective stop ---- */
    var blind = Math.abs(S.windTrue - S.windMeasured) > 3.5 && !S.heaterOn;
    if (S.mode === 2 && S.contactor && blind) {
      S.iceStopTimer += dt;
      if (S.iceStopTimer > 150) {
        doTrip("SENSOR FAIL");
        S.iceStopTimer = 0;
      }
    } else {
      S.iceStopTimer = Math.max(0, S.iceStopTimer - dt * 2);
    }

    /* ---- fault healing ---- */
    if (S.faultOil && S.oilC < 78) S.faultOil = false;
    if (S.faultTwist && Math.abs(S.twistDeg) < TWIST_RELEASE_DEG)
      S.faultTwist = false;

    supervise();
    if (Object.keys(S.alarmActive).join("|") !== prevAlarms) {
      if (Object.keys(S.alarmFlash).length) chirp();
    }
  }

  /* ------------------------------------------------ alarms and protection */

  function setAlarm(name, on) {
    if (on && !S.alarmActive[name]) {
      S.alarmActive[name] = true;
      S.alarmFlash[name] = true; // new alarm flashes until acknowledged
    } else if (!on && S.alarmActive[name]) {
      delete S.alarmActive[name];
      delete S.alarmFlash[name];
    }
  }

  function supervise() {
    setAlarm("OVERSPEED", S.rpm > RPM_ALARM);
    setAlarm("GEARBOX OIL TEMP", S.oilC > OIL_ALARM_C);
    setAlarm(
      "HYD PRESSURE LOW",
      (S.pumpOn || S.hydBar > 2) && S.hydBar < HYD_ALARM_BAR,
    );
    setAlarm(
      "YAW CABLE TWIST",
      Math.abs(S.twistDeg) > TWIST_ALARM_DEG || S.faultTwist,
    );
    setAlarm(
      "ANEMOMETER ICING",
      S.faultIce || Math.abs(S.windTrue - S.windMeasured) > 3.5,
    );

    if (S.rpm > RPM_TRIP) doTrip("OVERSPEED");
    if (S.oilC > OIL_TRIP_C) doTrip("GEARBOX TEMP");
    if (Math.abs(S.twistDeg) > TWIST_TRIP_DEG) doTrip("TWIST LIMIT");

    setAlarm("TRIP", S.trips.length > 0);
  }

  function doTrip(reason) {
    if (S.trips.indexOf(reason) !== -1) return;
    S.trips.push(reason);
    S.contactor = false;
    S.pitchDemandDeg = 88;
  }

  /* -------------------------------------------------------------- the API */

  function activeFaults() {
    var f = [];
    if (S.faultIce) f.push(FAULTS[0]);
    if (S.faultOil) f.push(FAULTS[1]);
    if (S.faultTwist) f.push(FAULTS[2]);
    return f;
  }

  function state() {
    return {
      time: round(S.time, 2),
      mode: ["STOP", "SERVICE", "AUTO"][S.mode],
      contactor: S.contactor,
      pumpOn: S.pumpOn,
      brakeOn: S.brakeOn,
      lockEngaged: S.lockIn,
      heaterOn: S.heaterOn,
      cooling: ["OFF", "AUTO", "FORCED"][S.cooling],
      estop: S.estop,
      windTrue: round(S.windTrue, 2),
      windMeasured: round(S.windMeasured, 2),
      rpm: round(S.rpm, 2),
      pitchDeg: round(S.pitchDeg, 1),
      powerKW: round(S.kw, 1),
      gearboxTempC: round(S.oilC, 1),
      hydraulicBar: round(S.hydBar, 1),
      yawDeg: round(((S.yawDeg % 360) + 360) % 360, 1),
      windDirDeg: round(((S.windDirDeg % 360) + 360) % 360, 1),
      cableTwistDeg: round(S.twistDeg, 1),
      trips: S.trips.slice(),
      alarms: Object.keys(S.alarmActive),
      faults: activeFaults(),
    };
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      S.faultIce = true;
      S.iceMelt = 0;
      S.windMeasured = Math.max(0, S.windMeasured - 6);
    } else if (f === FAULTS[1]) {
      S.faultOil = true;
      S.oilC = Math.max(S.oilC, OIL_ALARM_C + 4);
    } else if (f === FAULTS[2]) {
      S.faultTwist = true;
      S.twistDeg = Math.max(S.twistDeg, TWIST_ALARM_DEG - 90);
    } else {
      throw new Error("unknown fault: " + fault);
    }
    supervise();
  }

  function reset() {
    coldStart();
    if (typeof render === "function") render();
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ================================================================ PANEL */

  if (typeof document === "undefined") return;

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  var el = {
    leds: {},
    needles: {},
    readouts: {},
    mimic: {},
    ann: {},
    stack: {},
  };

  $$("[data-alarm]").forEach(function (n) {
    el.ann[n.getAttribute("data-alarm")] = n;
  });
  $$("[data-led]").forEach(function (n) {
    el.leds[n.getAttribute("data-led")] = n;
  });
  $$("[data-needle]").forEach(function (n) {
    el.needles[n.getAttribute("data-needle")] = n;
  });
  $$("[data-readout]").forEach(function (n) {
    el.readouts[n.getAttribute("data-readout")] = n;
  });
  $$("[data-mimic]").forEach(function (n) {
    el.mimic[n.getAttribute("data-mimic")] = n;
  });
  el.stack.red = $('[data-stack="red"]');
  el.stack.amber = $('[data-stack="amber"]');
  el.stack.green = $('[data-stack="green"]');
  el.lcd1 = $('[data-lcd="1"]');
  el.lcd2 = $('[data-lcd="2"]');

  /* -------------------------------------------------- dial ticks & zones */

  var GAUGES = {
    wind: {
      min: 0,
      max: 30,
      majors: [0, 5, 10, 15, 20, 25, 30],
      red: [24, 30],
    },
    rpm: {
      min: 0,
      max: 30,
      majors: [0, 5, 10, 15, 20, 25, 30],
      red: [23.5, 30],
    },
    oil: {
      min: 0,
      max: 120,
      majors: [0, 20, 40, 60, 80, 100, 120],
      red: [82, 120],
    },
    hyd: {
      min: 0,
      max: 200,
      majors: [0, 40, 80, 120, 160, 200],
      green: [135, 175],
    },
  };

  function polar(cx, cy, r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function arcPath(cx, cy, r, d0, d1) {
    var p0 = polar(cx, cy, r, d0);
    var p1 = polar(cx, cy, r, d1);
    return (
      "M" +
      p0[0].toFixed(1) +
      " " +
      p0[1].toFixed(1) +
      " A" +
      r +
      " " +
      r +
      " 0 0 1 " +
      p1[0].toFixed(1) +
      " " +
      p1[1].toFixed(1)
    );
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  Object.keys(GAUGES).forEach(function (key) {
    var g = GAUGES[key];
    var span = g.max - g.min;
    var toDeg = function (v) {
      return -90 + ((v - g.min) / span) * 180;
    };
    var cx = 100;
    var cy = 118;
    var rOuter = 92;
    var ticks = $('[data-ticks="' + key + '"]');
    if (!ticks) return;

    g.majors.forEach(function (v) {
      var deg = toDeg(v);
      var p0 = polar(cx, cy, rOuter, deg);
      var p1 = polar(cx, cy, rOuter - 10, deg);
      var ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", p0[0].toFixed(1));
      ln.setAttribute("y1", p0[1].toFixed(1));
      ln.setAttribute("x2", p1[0].toFixed(1));
      ln.setAttribute("y2", p1[1].toFixed(1));
      ln.setAttribute("class", "major");
      ticks.appendChild(ln);
      var lp = polar(cx, cy, rOuter - 21, deg);
      var tx = document.createElementNS(SVG_NS, "text");
      tx.setAttribute("x", lp[0].toFixed(1));
      tx.setAttribute("y", (lp[1] + 3.5).toFixed(1));
      tx.setAttribute("text-anchor", "middle");
      tx.textContent = v;
      ticks.appendChild(tx);
    });

    var minors = g.majors.length * 2;
    for (var i = 0; i <= minors; i++) {
      var mv = g.min + (span * i) / minors;
      if (i % 2 === 0) continue; // majors already drawn
      var deg2 = toDeg(mv);
      var q0 = polar(cx, cy, rOuter, deg2);
      var q1 = polar(cx, cy, rOuter - 5, deg2);
      var mn = document.createElementNS(SVG_NS, "line");
      mn.setAttribute("x1", q0[0].toFixed(1));
      mn.setAttribute("y1", q0[1].toFixed(1));
      mn.setAttribute("x2", q1[0].toFixed(1));
      mn.setAttribute("y2", q1[1].toFixed(1));
      ticks.appendChild(mn);
    }

    var rz = $('[data-redarc="' + key + '"]');
    if (rz && g.red)
      rz.setAttribute(
        "d",
        arcPath(cx, cy, rOuter - 3, toDeg(g.red[0]), toDeg(g.red[1])),
      );
    var gz = $('[data-greenarc="' + key + '"]');
    if (gz && g.green)
      gz.setAttribute(
        "d",
        arcPath(cx, cy, rOuter - 3, toDeg(g.green[0]), toDeg(g.green[1])),
      );
  });

  /* ------------------------------------------------------------- sound */

  var audioCtx = null;
  var soundOn = false;

  function ensureAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx && AC) audioCtx = new AC();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  function clack() {
    if (!soundOn || !audioCtx) return;
    var t = audioCtx.currentTime;
    var buf = audioCtx.createBuffer(1, 2200, audioCtx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    }
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    var f = audioCtx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1900;
    var gn = audioCtx.createGain();
    gn.gain.value = 0.4;
    src.connect(f);
    f.connect(gn);
    gn.connect(audioCtx.destination);
    src.start(t);
  }

  function chirp() {
    if (!soundOn || !audioCtx) return;
    var t = audioCtx.currentTime;
    [0, 0.24].forEach(function (off) {
      var o = audioCtx.createOscillator();
      var gn = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = 840;
      gn.gain.setValueAtTime(0.001, t + off);
      gn.gain.exponentialRampToValueAtTime(0.12, t + off + 0.02);
      gn.gain.exponentialRampToValueAtTime(0.001, t + off + 0.16);
      o.connect(gn);
      gn.connect(audioCtx.destination);
      o.start(t + off);
      o.stop(t + off + 0.18);
    });
  }

  /* -------------------------------------------------------- interactions */

  function pad(s, n) {
    s = String(s);
    while (s.length < n) s = " " + s;
    return s;
  }

  function flash(line1) {
    S.msgLine1 = String(line1).slice(0, 42);
    S.msgTimer = 2.6;
  }

  function lcdBottom() {
    return (
      pad(S.windMeasured.toFixed(1), 4) +
      "m/s " +
      pad(S.rpm.toFixed(1), 4) +
      "rpm " +
      pad(String(Math.round(S.kw)), 4) +
      "kW T+" +
      pad(String(Math.round(Math.abs(S.twistDeg))), 3) +
      "\u00B0"
    );
  }

  var pumpBtn = $('[data-control="HYD PUMP"]');
  var brakeBtn = $('[data-control="ROTOR BRAKE"]');
  var pinBtn = $('[data-control="ROTOR LOCK PIN"]');
  var heaterBtn = $('[data-control="SENSOR HEATER"]');
  var estopBtn = $('[data-control="EMERGENCY STOP"]');
  var resetBtn = $('[data-control="RESET"]');
  var gridBtn = $('[data-control="GRID CONTACTOR"]');

  var modeBtn = $('[data-control="MODE KEY"]');
  if (modeBtn) {
    modeBtn.addEventListener("click", function () {
      if (S.estop || S.trips.length) {
        flash("RELEASE NODSTOP / PRESS RESET FIRST");
        return;
      }
      S.mode = (S.mode + 1) % 3;
      if (S.mode !== 2 && S.contactor) {
        S.contactor = false;
        clack();
      }
      if (S.mode === 0) {
        S.brakeOn = true;
        S.pumpOn = false;
      }
      clack();
      render();
    });
  }

  if (pumpBtn) {
    pumpBtn.addEventListener("click", function () {
      if (S.mode === 0) {
        flash("TURN KEY TO SERVICE FIRST");
        return;
      }
      S.pumpOn = !S.pumpOn;
      clack();
      render();
    });
  }

  if (pinBtn) {
    pinBtn.addEventListener("click", function () {
      if (S.rpm > 0.5) {
        flash("ROTOR STILL TURNING - BRAKE IT FIRST");
        return;
      }
      if (S.lockIn && !S.brakeOn) {
        flash("APPLY ROTOR BRAKE BEFORE UNLOCKING");
        return;
      }
      S.lockIn = !S.lockIn;
      flash(
        S.lockIn ? "ROTORLOCK INDSATT / PIN IN" : "ROTORLOCK UDTAGET / PIN OUT",
      );
      clack();
      render();
    });
  }

  if (brakeBtn) {
    brakeBtn.addEventListener("click", function () {
      S.brakeOn = !S.brakeOn;
      flash(S.brakeOn ? "BREMS PAA / BRAKE ON" : "BREMS FRA / BRAKE OFF");
      clack();
      render();
    });
  }

  if (gridBtn) {
    gridBtn.addEventListener("click", function () {
      if (S.contactor) {
        S.contactor = false;
        clack();
      } else if (S.mode !== 2) {
        flash("KEY MUST BE IN AUTO TO CLOSE");
      } else if (S.lockIn) {
        flash("ROTORLOCK STILL ENGAGED");
      } else if (S.estop || S.trips.length) {
        flash("TRIPPED - PRESS RESET FIRST");
      } else if (S.windTrue > WIND_CUTOUT_MS) {
        flash("STORM - WIND ABOVE CUT-OUT");
      } else {
        S.contactor = true;
        clack();
      }
      render();
    });
  }

  $$(".jog-btn[data-pitch]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (S.mode !== 1) {
        flash("PITCH JOG WORKS ONLY IN SERVICE");
        return;
      }
      S.pitchDemandDeg =
        b.getAttribute("data-pitch") === "feather"
          ? Math.min(90, S.pitchDeg + 4)
          : Math.max(-2, S.pitchDeg - 4);
      render();
    });
  });

  $$(".jog-btn[data-yaw]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (S.mode !== 1) {
        flash("YAW JOG WORKS ONLY IN SERVICE");
        return;
      }
      var dir = b.getAttribute("data-yaw") === "cw" ? 1 : -1;
      S.yawDeg += dir * 6;
      S.twistDeg += dir * 6;
      render();
    });
  });

  var coolBtn = $('[data-control="COOLING SELECTOR"]');
  if (coolBtn) {
    coolBtn.addEventListener("click", function () {
      S.cooling = (S.cooling + 1) % 3;
      flash("OLIEK\u00D8LING: " + ["OFF", "AUTO", "FORCED"][S.cooling]);
      clack();
      render();
    });
  }

  if (heaterBtn) {
    heaterBtn.addEventListener("click", function () {
      S.heaterOn = !S.heaterOn;
      render();
    });
  }

  var ackBtn = $('[data-control="ALARM ACK"]');
  if (ackBtn) {
    ackBtn.addEventListener("click", function () {
      S.alarmFlash = {};
      render();
    });
  }

  var lampBtn = $('[data-control="LAMP TEST"]');
  if (lampBtn) {
    lampBtn.addEventListener("click", function () {
      S.lampTest = 1.6;
      render();
    });
  }

  $$(".test-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      inject(b.getAttribute("data-test"));
      flash("TESTFAULT: " + b.getAttribute("data-test").toUpperCase());
      chirp();
      render();
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      if (S.estop) {
        flash("RELEASE THE NODSTOP BUTTON FIRST");
        return;
      }
      if (S.trips.indexOf("OVERSPEED") !== -1 && S.rpm > RPM_ALARM) {
        flash("ROTOR STILL FAST - WAIT");
        return;
      }
      if (S.trips.indexOf("GEARBOX TEMP") !== -1 && S.oilC > OIL_RESTART_C) {
        flash("OIL STILL OVER 75 C - COOL IT");
        return;
      }
      if (
        S.trips.indexOf("TWIST LIMIT") !== -1 &&
        Math.abs(S.twistDeg) > TWIST_RELEASE_DEG
      ) {
        flash("UNWIND CABLE IN SERVICE FIRST");
        return;
      }
      S.trips = [];
      S.alarmActive = {};
      S.alarmFlash = {};
      S.mode = 0;
      S.contactor = false;
      S.pumpOn = false;
      S.brakeOn = true;
      S.pitchDemandDeg = 88;
      flash("RESET OK - KEY TO SERVICE");
      clack();
      render();
    });
  }

  if (estopBtn) {
    estopBtn.addEventListener("click", function () {
      S.estop = !S.estop;
      if (S.estop) {
        S.contactor = false;
        S.pitchDemandDeg = 88;
        S.mode = 0;
        if (S.trips.indexOf("EMERGENCY STOP") === -1)
          S.trips.push("EMERGENCY STOP");
        supervise();
        clack();
      }
      render();
    });
  }

  var manualOpen = $('[data-action="manual"]');
  var manualDialog = $("dialog[data-manual]");
  if (manualOpen && manualDialog) {
    manualOpen.addEventListener("click", function () {
      if (typeof manualDialog.showModal === "function")
        manualDialog.showModal();
      else manualDialog.setAttribute("open", "");
    });
  }
  var manualClose = $('[data-action="close-manual"]');
  if (manualClose && manualDialog) {
    manualClose.addEventListener("click", function () {
      if (typeof manualDialog.close === "function") manualDialog.close();
      else manualDialog.removeAttribute("open");
    });
  }

  var soundBtn = $(".sound-toggle");
  if (soundBtn) {
    soundBtn.addEventListener("click", function () {
      soundOn = !soundOn;
      soundBtn.setAttribute("data-sound", soundOn ? "on" : "off");
      soundBtn.setAttribute("aria-pressed", String(soundOn));
      if (soundOn) ensureAudio();
    });
  }

  /* ------------------------------------------------------------ rendering */

  function setNeedle(key, value) {
    var g = GAUGES[key];
    var n = el.needles[key];
    if (!g || !n) return;
    var frac = Math.max(0, Math.min(1, (value - g.min) / (g.max - g.min)));
    n.setAttribute(
      "transform",
      "rotate(" + (-90 + frac * 180).toFixed(2) + " 100 118)",
    );
  }

  function render() {
    var st = state();
    var testing = S.lampTest > 0;

    /* lcd */
    var l2 = lcdBottom();
    var l1;
    if (testing) l1 = "LAMPEPROVE / LAMP TEST ACTIVE";
    else if (st.estop) l1 = "!! NODSTOP AKTIV - EMERGENCY STOP !!";
    else if (st.trips.length)
      l1 = "TRIP: " + st.trips.join("+") + " - ACK+RESET";
    else if (S.msgTimer > 0) l1 = "* " + S.msgLine1;
    else if (st.mode === "STOP") l1 = "MODE:STOP    ROTOR FEATHERED+BRAKED";
    else if (st.mode === "SERVICE")
      l1 =
        "MODE:SERVICE HYD:" +
        Math.round(st.hydraulicBar) +
        "bar PUMPE:" +
        (st.pumpOn ? "ON" : "OFF");
    else if (!st.contactor) l1 = "MODE:AUTO    KLAR - CLOSE CONTACTOR";
    else if (st.powerKW < 5) l1 = "MODE:AUTO    OPSPENDING - SPOOLING";
    else l1 = "MODE:AUTO    P\u00C5 NETTET / ON GRID";
    if (el.lcd1) el.lcd1.textContent = l1;
    if (el.lcd2) el.lcd2.textContent = l2;
    var lcdBox = $(".lcd");
    if (lcdBox) lcdBox.classList.toggle("powered", S.time > 0.2);

    /* gauges */
    setNeedle("wind", st.windMeasured);
    setNeedle("rpm", st.rpm);
    setNeedle("oil", st.gearboxTempC);
    setNeedle("hyd", st.hydraulicBar);
    el.readouts.wind.textContent = st.windMeasured.toFixed(1);
    el.readouts.rpm.textContent = st.rpm.toFixed(1);
    el.readouts.oil.textContent = Math.round(st.gearboxTempC);
    el.readouts.hyd.textContent = Math.round(st.hydraulicBar);
    el.readouts.kw.textContent = Math.round(st.powerKW);
    if (el.needles.rpm)
      el.needles.rpm.classList.toggle("tripped", st.rpm > RPM_ALARM);

    /* annunciators */
    ALARM_NAMES.forEach(function (name) {
      var node = el.ann[name];
      if (!node) return;
      var active = !!S.alarmActive[name];
      node.classList.toggle("lit", active || testing);
      node.classList.toggle(
        "flash",
        (active && !!S.alarmFlash[name] && !testing) || testing,
      );
    });

    /* stack light */
    var anyActive = ALARM_NAMES.some(function (n) {
      return S.alarmActive[n];
    });
    var anyFlash = ALARM_NAMES.some(function (n) {
      return S.alarmFlash[n];
    });
    if (el.stack.red)
      el.stack.red.classList.toggle("on-red", anyActive || testing);
    if (el.stack.amber)
      el.stack.amber.classList.toggle(
        "on-amber",
        (!anyActive && (st.mode === "SERVICE" || S.cutoutTimer > 0)) || testing,
      );
    if (el.stack.green)
      el.stack.green.classList.toggle(
        "on-green",
        st.mode === "AUTO" && st.contactor && !anyActive && !testing,
      );
    var stackBox = $(".stack-light");
    if (stackBox) stackBox.classList.toggle("flash-red", anyFlash && !testing);

    /* leds */
    if (el.leds.grid)
      el.leds.grid.classList.toggle("on", st.contactor || testing);
    if (el.leds.pump) el.leds.pump.classList.toggle("on", st.pumpOn || testing);
    if (el.leds.pumprail)
      el.leds.pumprail.classList.toggle("on", st.pumpOn || testing);
    if (el.leds.heater)
      el.leds.heater.classList.toggle("amberled", st.heaterOn || testing);

    /* mimic */
    if (el.mimic.rotorblades)
      el.mimic.rotorblades.style.transform =
        "rotate(" + S.rotorAngle.toFixed(1) + "deg)";
    if (el.mimic.pitch) el.mimic.pitch.textContent = st.pitchDeg.toFixed(1);
    if (el.mimic.oiltemp)
      el.mimic.oiltemp.textContent = Math.round(st.gearboxTempC);
    if (el.mimic.genkw) el.mimic.genkw.textContent = Math.round(st.powerKW);
    if (el.mimic.gridlamp)
      el.mimic.gridlamp.classList.toggle("live", st.contactor || testing);
    if (el.mimic.cable)
      el.mimic.cable.classList.toggle("flowing", st.powerKW > 2 || testing);
    if (el.mimic.misalign)
      el.mimic.misalign.textContent = Math.round(
        Math.abs(normAngle(st.windDirDeg - st.yawDeg)),
      );
    if (el.mimic.twist) {
      var twSign = S.twistDeg < -0.5 ? "-" : "+";
      el.mimic.twist.textContent =
        twSign + pad(String(Math.round(Math.abs(S.twistDeg))), 3) + "\u00B0";
    }
    if (el.mimic.winddir)
      el.mimic.winddir.setAttribute(
        "transform",
        "rotate(" + st.windDirDeg.toFixed(1) + ")",
      );
    if (el.mimic.nacelledir)
      el.mimic.nacelledir.setAttribute(
        "transform",
        "rotate(" + st.yawDeg.toFixed(1) + ")",
      );
    if (el.mimic.windarrows)
      el.mimic.windarrows.style.opacity = String(
        0.25 + Math.min(0.75, st.windTrue / 22),
      );

    /* controls reflection */
    if (modeBtn) {
      modeBtn.classList.remove(
        "key-switch-pos-stop",
        "key-switch-pos-service",
        "key-switch-pos-auto",
      );
      modeBtn.classList.add(
        [
          "key-switch-pos-stop",
          "key-switch-pos-service",
          "key-switch-pos-auto",
        ][S.mode],
      );
    }
    if (pumpBtn) pumpBtn.setAttribute("aria-pressed", String(st.pumpOn));
    if (brakeBtn) brakeBtn.setAttribute("aria-pressed", String(st.brakeOn));
    if (pinBtn) {
      pinBtn.setAttribute("aria-pressed", String(!st.lockIn));
      pinBtn.classList.toggle("out", !st.lockIn);
      var tag = pinBtn.querySelector("[data-pin-tag]");
      if (tag)
        tag.textContent = st.lockIn
          ? "INDSATT \u00B7 IN"
          : "UDTAGET \u00B7 OUT";
    }
    if (heaterBtn) heaterBtn.setAttribute("aria-pressed", String(st.heaterOn));
    if (estopBtn) estopBtn.classList.toggle("engaged", st.estop);
    var knobPtr = $(".rotary-pointer");
    if (knobPtr)
      knobPtr.style.transform = "rotate(" + [-70, 0, 70][S.cooling] + "deg)";
    var fan = $("[data-fan]");
    if (fan) {
      fan.classList.toggle(
        "spinning",
        S.cooling === 2 || (S.cooling === 1 && st.gearboxTempC > 45),
      );
    }
  }

  /* ------------------------------------------------------- animation loop */

  var lastFrame = null;
  var paused = false;

  function frame(now) {
    requestAnimationFrame(frame);
    if (paused) {
      lastFrame = now;
      return;
    }
    if (lastFrame === null) lastFrame = now;
    var dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    if (dt > 0) tick(dt);
    render();
  }

  document.addEventListener("visibilitychange", function () {
    paused = document.hidden;
  });

  coldStart();
  render();
  requestAnimationFrame(frame);
})();
