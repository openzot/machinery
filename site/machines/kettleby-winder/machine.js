/* Kettleby Colliery No. 2 Winder — driver's console simulation.
   A friction (Koepe) winder: cage and counterweight on a rope over a wheel,
   300 m of shaft, a hydraulic brake, a thyristor drive with opinions.
   Deterministic core in tick(); everything else renders it. */

(function () {
  "use strict";

  /* ---------------- constants ---------------- */

  var TRAVEL = 300; // bank (0) to surface (300), metres
  var OTRAVEL = 2.5; // overtravel beyond a landing that trips, m
  var V_MAX = 17; // hard ceiling, m/s
  var ALARM_SPEED = 13; // overspeed alarm, m/s
  var TRIP_SPEED = 15; // overspeed trip, m/s
  var P_MAX = 95; // standby brake pressure, bar
  var P_LOW = 45; // low-pressure alarm, bar
  var F_DRIVE = 26000; // rope pull at full quadrant below base speed, N
  var V_BASE = 6; // field-weakening knee, m/s
  var MASS = 12000; // moving mass, kg
  var IMB = 3800; // static out-of-balance toward the bank, N
  var DRAG = 46; // shaft drag, N per (m/s)^2
  var BRAKE_K = 30000; // fully-applied spring brake force at the rope, N
  var AMB_TEMP = 38; // winding temperature, deg C
  var TEMP_ALARM = 150;
  var TEMP_TRIP = 175;

  var SLIP_RATE = 0.28; // rope slip creep, m/s
  var SLIP_ALARM = 2.0; // indicator-vs-cage mismatch, m
  var SLIP_TRIP = 8.0;

  var FAULTS = ["brake hydraulic leak", "rope slip", "motor overtemperature"];

  var ALARMS = [
    "OVERSPEED",
    "OVERWIND",
    "BRAKE FAULT",
    "TEMP HIGH",
    "DEPTH FAULT",
    "WINDER TRIPPED",
  ];

  var MODES = ["INSPECT", "MANUAL", "AUTO"];

  /* ---------------- state ---------------- */

  var S = cold();
  var subAcc = 0;

  function cold() {
    return {
      t: 0,
      master: false,
      mode: "MANUAL",
      thr: 0, // -1 lower .. +1 raise
      brk: 0, // 0 applied .. 1 released
      posT: 0, // true cage position, m
      posD: 0, // indicated (driver's) position, m
      vel: 0, // m/s, positive raising
      press: 0, // bar
      amps: 0, // A
      temp: AMB_TEMP, // deg C
      tripped: false,
      tripCause: "",
      thermal: false, // latched thermal trip
      pressLowT: 0,
      leakT: 0,
      diffSync: false, // maintenance re-sync in progress after rope slip
      calls: { bank: false, surface: false },
      autoTarget: null,
      bellCount: 0,
      bellMeaning: "",
      bellTimer: 0,
      fBrake: false,
      fRope: false,
      fTemp: false,
      alrm: {},
      hornCut: false,
      diff: 0,
    };
  }

  ALARMS.forEach(function (a) {
    S.alrm[a] = { on: false, acked: true };
  });

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function norm(s) {
    return String(s == null ? "" : s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  /* ---------------- simulation ---------------- */

  function setAlarm(name, on) {
    var a = S.alrm[name];
    if (on && !a.on) {
      a.on = true;
      a.acked = false;
      S.hornCut = false;
    }
    if (!on) a.on = false;
  }

  function doTrip(cause) {
    if (S.tripped) return;
    S.tripped = true;
    S.tripCause = cause;
    setAlarm("WINDER TRIPPED", true);
    sound.hornNudge();
  }

  function step(h) {
    S.t += h;

    /* ----- auto driver ----- */
    if (S.mode === "AUTO" && S.master && !S.tripped) {
      if (!S.calls.surface && !S.calls.bank) {
        // nothing called: hold wherever she stands
        S.autoTarget = null;
        S.thr += clamp(0 - S.thr, -1.4 * h, 1.4 * h);
        S.brk += clamp(0 - S.brk, -2.5 * h, 2.5 * h);
      } else {
        if (S.autoTarget == null || (!S.calls.surface && !S.calls.bank))
          S.autoTarget = null;
        if (S.autoTarget == null) S.autoTarget = S.calls.surface ? TRAVEL : 0;
        var d = S.autoTarget - S.posD;
        if (Math.abs(d) < 0.15 && Math.abs(S.vel) < 0.08) {
          S.thr = 0;
          S.brk = 0;
          if (S.autoTarget === TRAVEL) S.calls.surface = false;
          else S.calls.bank = false;
          S.autoTarget = null;
          sound.ding();
        } else {
          var vDes = clamp(
            Math.sign(d) *
              Math.sqrt(2 * 0.72 * Math.max(Math.abs(d) - 0.35, 0)),
            -8,
            8,
          );
          var thrCmd = clamp(IMB / F_DRIVE + (vDes - S.vel) * 0.4, -1, 1);
          S.thr += clamp(thrCmd - S.thr, -1.4 * h, 1.4 * h);
          S.brk += clamp(1 - S.brk, -2.5 * h, 2.5 * h);
        }
      }
    }

    /* ----- hydraulics ----- */
    var pTar = !S.master || S.tripped ? 0 : S.brk * P_MAX;
    if (S.fBrake) pTar = Math.min(pTar, 4);
    var rate = clamp((pTar - S.press) * 1.3, -26 * h, 20 * h);
    S.press = clamp(S.press + rate, 0, P_MAX);

    if (S.fBrake) S.leakT += h;
    else S.leakT = 0;
    var brakeDemand =
      S.master && (S.brk > 0.2 || Math.abs(S.vel) > 0.1 || S.press > P_LOW);
    if (brakeDemand && S.press < P_LOW) S.pressLowT += h;
    else S.pressLowT = 0;
    var brakeBad = (S.fBrake && S.leakT > 3.5) || (S.master && S.pressLowT > 4);
    setAlarm("BRAKE FAULT", brakeBad);

    /* ----- drive ----- */
    var fDrive = 0;
    if (S.master && !S.tripped && !S.thermal && Math.abs(S.thr) > 0.003) {
      var vAbs = Math.abs(S.vel);
      var fade = vAbs > V_BASE ? Math.pow(V_BASE / vAbs, 1.7) : 1;
      var inspect = S.mode === "INSPECT" ? 0.16 : 1;
      fDrive = S.thr * F_DRIVE * fade * inspect;
    }

    var iLoad = (Math.abs(fDrive) / F_DRIVE) * 640;
    var iTarget = iLoad + (S.master ? 42 : 0);
    S.amps += (iTarget - S.amps) * Math.min(1, 3 * h);

    /* ----- temperature ----- */
    var heat = Math.pow(S.amps / 320, 2) * 1.05 + (S.fTemp ? 5.5 : 0);
    var cool = (S.temp - AMB_TEMP) * 0.022;
    S.temp = clamp(S.temp + (heat - cool) * h, AMB_TEMP - 2, 260);
    setAlarm("TEMP HIGH", S.temp >= TEMP_ALARM);

    if (S.temp >= TEMP_TRIP && !S.thermal) {
      S.thermal = true;
      doTrip("MOTOR OVERHEATING");
    }

    /* ----- mechanics -----
       Spring-applied, hydraulically released: no pressure = full braking
       force; pressure pulls the pads off. */
    var cap = BRAKE_K * (1 - S.press / P_MAX);
    var fOther = fDrive - IMB - DRAG * S.vel * Math.abs(S.vel);
    var fNet;
    if (Math.abs(S.vel) <= 0.05) {
      if (Math.abs(fOther) <= cap) {
        fNet = 0;
        S.vel = 0;
      } else fNet = fOther - Math.sign(fOther) * cap;
    } else {
      fNet = fOther - Math.sign(S.vel) * cap;
    }
    S.vel = clamp(S.vel + (fNet / MASS) * h, -V_MAX, V_MAX);

    S.posT += S.vel * h;
    S.posD += S.vel * h;
    if (S.fRope) S.posT -= SLIP_RATE * h;
    S.posT = clamp(S.posT, -3.5, TRAVEL + 3.5);
    S.posD = clamp(S.posD, -3.5, TRAVEL + 3.5);
    S.diff = S.posD - S.posT;

    /* ----- protection ----- */
    setAlarm("OVERSPEED", Math.abs(S.vel) > ALARM_SPEED);
    if (Math.abs(S.vel) > TRIP_SPEED) doTrip("OVERSPEED");
    var overtravel = S.posT > TRAVEL + OTRAVEL || S.posT < -OTRAVEL;
    if (overtravel) doTrip("OVERWIND/OVERTRAVEL");
    setAlarm("OVERWIND", overtravel || S.alrm.OVERWIND.on);
    setAlarm("DEPTH FAULT", Math.abs(S.diff) > SLIP_ALARM);
    if (Math.abs(S.diff) > SLIP_TRIP) doTrip("OUT OF STEP");

    /* rope re-sync after maintenance re-clamps */
    if (!S.fRope && Math.abs(S.diff) > 0.01) {
      var close = Math.min(Math.abs(S.diff), 0.8 * h);
      S.posT += Math.sign(S.diff) * close;
    }

    /* ----- annunciator bookkeeping ----- */
    S.bellTimer -= h;
    if (S.bellTimer <= 0 && S.bellCount !== 0) {
      S.bellCount = 0;
    }
  }

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return;
    subAcc += Math.min(seconds, 120);
    var H = 0.05;
    var guard = 6000;
    while (subAcc >= H - 1e-9 && guard-- > 0) {
      step(H);
      subAcc -= H;
    }
  }

  /* ---------------- fixed API ---------------- */

  function state() {
    var active = [];
    ALARMS.forEach(function (a) {
      if (S.alrm[a].on) active.push(a);
    });
    return {
      elapsed: Math.round(S.t * 100) / 100,
      master: S.master,
      mode: S.mode,
      throttle: Math.round(S.thr * 1000) / 1000,
      brake: Math.round(S.brk * 1000) / 1000,
      position: Math.round(S.posT * 100) / 100,
      indicatedPosition: Math.round(S.posD * 100) / 100,
      velocity: Math.round(S.vel * 1000) / 1000,
      speed: Math.round(Math.abs(S.vel) * 1000) / 1000,
      motorAmps: Math.round(S.amps),
      brakePressure: Math.round(S.press * 10) / 10,
      windingTemp: Math.round(S.temp * 10) / 10,
      tripped: S.tripped,
      tripCause: S.tripCause,
      calls: { bank: S.calls.bank, surface: S.calls.surface },
      faults: {
        "brake hydraulic leak": S.fBrake,
        "rope slip": S.fRope,
        "motor overtemperature": S.fTemp,
      },
      alarms: active,
    };
  }

  function inject(fault) {
    var f = norm(fault);
    if (f === "brake hydraulic leak") S.fBrake = true;
    else if (f === "rope slip") S.fRope = true;
    else if (f === "motor overtemperature") S.fTemp = true;
    syncTestLamps();
  }

  function clearFault(fault) {
    var f = norm(fault);
    if (f === "brake hydraulic leak") {
      S.fBrake = false;
      S.leakT = 0;
    } else if (f === "rope slip") S.fRope = false;
    else if (f === "motor overtemperature") S.fTemp = false;
    syncTestLamps();
  }

  function reset() {
    var fresh = cold();
    ALARMS.forEach(function (a) {
      fresh.alrm[a] = { on: false, acked: true };
    });
    S = fresh;
    subAcc = 0;
    sound.stopHorn();
    syncTestLamps();
    render();
  }

  window.machine = {
    name: "Kettleby Colliery No. 2 Winder",
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ---------------- gauges (drawn once) ---------------- */

  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function buildGauge(id, max, unitMax, redZones, majors) {
    var svg = document.getElementById(id);
    if (!svg) return null;
    var c = 65,
      cy = 67,
      r = 51;
    el("circle", { cx: c, cy: cy, r: 57, fill: "#0e0f10" }, svg);
    el(
      "circle",
      {
        cx: c,
        cy: cy,
        r: 53,
        fill: "var(--dial)",
        stroke: "#3a3d42",
        "stroke-width": 1,
      },
      svg,
    );
    // red zones
    redZones.forEach(function (z) {
      el(
        "path",
        {
          d: arcPath(c, cy, 46, ang(z[0]), ang(z[1])),
          fill: "none",
          stroke: "#c23a24",
          "stroke-width": 6,
        },
        svg,
      );
    });
    var g = el("g", {}, svg);
    for (var v = 0; v <= max; v += majors.step) {
      var major = v % majors.every === 0;
      var a = ang(v);
      el(
        "line",
        {
          x1: c + Math.sin(rad(a)) * r,
          y1: cy - Math.cos(rad(a)) * r,
          x2: c + Math.sin(rad(a)) * (r - (major ? 9 : 5)),
          y2: cy - Math.cos(rad(a)) * (r - (major ? 9 : 5)),
          stroke: "#17181b",
          "stroke-width": major ? 2.2 : 1.1,
        },
        g,
      );
      if (major) {
        var tr = r - 17;
        el(
          "text",
          {
            x: c + Math.sin(rad(a)) * tr,
            y: cy - Math.cos(rad(a)) * tr + 3.5,
            "text-anchor": "middle",
            "font-family": "Arial, Helvetica, sans-serif",
            "font-size": "10",
            "font-weight": "700",
            fill: "#17181b",
          },
          g,
        ).textContent = String(v);
      }
    }
    el(
      "text",
      {
        x: c,
        y: cy + 26,
        "text-anchor": "middle",
        "font-family": "Arial, Helvetica, sans-serif",
        "font-size": "7.5",
        fill: "#5b5f64",
        "letter-spacing": "1",
      },
      svg,
    ).textContent = unitMax;
    var needle = el("g", {}, svg);
    el(
      "path",
      {
        d:
          "M" +
          c +
          " " +
          (cy + 8) +
          " L" +
          (c - 3) +
          " " +
          cy +
          " L" +
          c +
          " " +
          (cy - r + 12) +
          " L" +
          (c + 3) +
          " " +
          cy +
          " Z",
        fill: "#17181b",
      },
      needle,
    );
    el(
      "circle",
      {
        cx: c,
        cy: cy,
        r: 6,
        fill: "#caccd0",
        stroke: "#3a3d42",
        "stroke-width": 1.5,
      },
      svg,
    );
    return { needle: needle, ang: ang };

    function rad(d) {
      return (d * Math.PI) / 180;
    }
    function ang(v) {
      return -135 + (clamp(v, 0, max) / max) * 270;
    }
    function arcPath(x, y, rr, a0, a1) {
      var large = a1 - a0 > 180 ? 1 : 0;
      var x0 = x + Math.sin(rad(a0)) * rr,
        y0 = y - Math.cos(rad(a0)) * rr;
      var x1 = x + Math.sin(rad(a1)) * rr,
        y1 = y - Math.cos(rad(a1)) * rr;
      return (
        "M" +
        x0 +
        " " +
        y0 +
        " A" +
        rr +
        " " +
        rr +
        " 0 " +
        large +
        " 1 " +
        x1 +
        " " +
        y1
      );
    }
  }

  var gSpeed = buildGauge("g-speed", 16, "m/s x 1", [[13, 16]], {
    step: 1,
    every: 4,
  });
  var gAmps = buildGauge("g-amps", 800, "AMPS x 1", [[560, 800]], {
    step: 50,
    every: 200,
  });
  var gBrake = buildGauge("g-brake", 110, "BAR x 1", [[0, 30]], {
    step: 10,
    every: 50,
  });

  /* depth scale */
  (function () {
    var g = document.getElementById("depthscale");
    if (!g) return;
    for (var m = 0; m <= TRAVEL; m += 25) {
      var y = yForPos(m);
      el("line", { x1: 300, y1: y, x2: 305, y2: y }, g);
      if (m % 75 === 0) {
        var t = el(
          "text",
          {
            x: 308,
            y: y + 3.5,
            "font-size": "9",
            "font-family": "Arial, Helvetica, sans-serif",
          },
          g,
        );
        t.textContent = String(m);
      }
    }
  })();

  /* quadrant notch plate */
  (function () {
    var g = document.getElementById("quadnotches");
    if (!g) return;
    for (var i = -5; i <= 5; i++) {
      var a = i * 12.4; // degrees off vertical
      var rr = 96,
        r2 = i % 2 === 0 ? 78 : 86;
      var rad = (a * Math.PI) / 180;
      var cx = 105,
        cy = 218;
      el(
        "line",
        {
          x1: cx + Math.sin(rad) * r2,
          y1: cy - Math.cos(rad) * r2,
          x2: cx + Math.sin(rad) * rr,
          y2: cy - Math.cos(rad) * rr,
          class: i % 2 === 0 ? "" : "minor",
        },
        g,
      );
    }
  })();

  /* ---------------- geometry helpers ---------------- */

  function yForPos(m) {
    return 472 - (clamp(m, -3.5, TRAVEL + 3.5) / TRAVEL) * (472 - 153);
  }
  function cageTop(m) {
    return 422 - (clamp(m, -3.5, TRAVEL + 3.5) / TRAVEL) * (422 - 102);
  }

  /* ---------------- rendering ---------------- */

  var $ = function (id) {
    return document.getElementById(id);
  };
  var cageG = $("cage"),
    cwG = $("cw"),
    wheelG = $("wheel"),
    ropeR = $("ropeR"),
    ropeL = $("ropeL"),
    tailR = $("tailrope"),
    quadLever = $("quadlever"),
    brakeHandle = $("brakehandle"),
    rotpointer = $("rotpointer"),
    dH = $("d-h"),
    dT = $("d-t"),
    dU = $("d-u"),
    dX = $("d-x"),
    tempFill = $("tempfill"),
    tempNum = $("tempnum"),
    tallyNum = $("tallynum"),
    tallyMeaning = $("tallymeaning");

  function fmtDigits(p) {
    var v = clamp(p, 0, 999.9);
    var whole = Math.floor(v),
      tenth = Math.floor((v - whole) * 10);
    var s = ("00" + whole).slice(-3);
    dH.textContent = s.charAt(0);
    dT.textContent = s.charAt(1);
    dU.textContent = s.charAt(2);
    dX.textContent = String(tenth);
  }

  function render() {
    var st = S;

    /* shaft scene */
    var ct = cageTop(st.posT),
      wt = cageTop(TRAVEL - st.posT);
    cageG.setAttribute("transform", "translate(0," + ct.toFixed(2) + ")");
    cwG.setAttribute("transform", "translate(0," + wt.toFixed(2) + ")");
    wheelG.setAttribute(
      "transform",
      "rotate(" + ((st.posD * 2.4) % 360).toFixed(2) + ")",
    );
    ropeR.setAttribute("d", "M162 82 H276 V" + (ct + 5).toFixed(1));
    ropeL.setAttribute("d", "M58 98 H222 V" + (wt + 3).toFixed(1));
    tailR.setAttribute(
      "d",
      "M276 " +
        (ct + 52).toFixed(1) +
        " C276 " +
        ((ct + wt) / 2 + 40).toFixed(1) +
        ", 222 " +
        ((ct + wt) / 2 + 40).toFixed(1) +
        ", 222 " +
        (wt + 45).toFixed(1),
    );

    fmtDigits(st.posD);

    /* gauges */
    var spd = Math.abs(st.vel);
    if (gSpeed)
      gSpeed.needle.setAttribute(
        "transform",
        "rotate(" + gSpeed.ang(spd).toFixed(1) + " 65 67)",
      );
    if (gAmps)
      gAmps.needle.setAttribute(
        "transform",
        "rotate(" + gAmps.ang(st.amps).toFixed(1) + " 65 67)",
      );
    if (gBrake)
      gBrake.needle.setAttribute(
        "transform",
        "rotate(" + gBrake.ang(st.press).toFixed(1) + " 65 67)",
      );

    /* levers */
    quadLever.setAttribute(
      "transform",
      "translate(105 218) rotate(" + (st.thr * 62).toFixed(1) + ")",
    );
    brakeHandle.style.bottom =
      "calc(" +
      (st.brk * 100).toFixed(1) +
      "% - " +
      (st.brk * 70).toFixed(0) +
      "px)";

    /* rotary */
    rotpointer.style.transform =
      "translate(0,-100%) rotate(" +
      ((MODES.indexOf(st.mode) - 1) * 40).toFixed(0) +
      "deg)";

    /* temperature */
    var tp = clamp((st.temp - 30) / 160, 0, 1) * 100;
    tempFill.style.height = tp.toFixed(1) + "%";
    tempNum.textContent = String(Math.round(st.temp));
    tempNum.style.color = st.temp >= TEMP_ALARM ? "#ff8d7d" : "";

    /* annunciators */
    var ANN_ID = {
      OVERSPEED: "ann-OVERSPEED",
      OVERWIND: "ann-OVERWIND",
      "BRAKE FAULT": "ann-BRAKE",
      "TEMP HIGH": "ann-TEMP",
      "DEPTH FAULT": "ann-DEPTH",
      "WINDER TRIPPED": "ann-WINDER",
    };
    ALARMS.forEach(function (a) {
      var w = $(ANN_ID[a]);
      if (!w) return;
      var al = st.alrm[a];
      w.setAttribute(
        "data-lit",
        al.on ? (al.acked ? "steady" : "flash") : "off",
      );
    });

    /* lamps */

    $("l-mains").setAttribute("data-on", "on");
    $("l-driveon").setAttribute(
      "data-on",
      st.master && !st.tripped ? "on" : "off",
    );
    $("l-ready").setAttribute(
      "data-on",
      st.mode === "AUTO" && st.master && !st.tripped ? "on" : "off",
    );
    var nearLanding = Math.min(Math.abs(st.posT), Math.abs(TRAVEL - st.posT));
    $("l-landing").setAttribute(
      "data-on",
      nearLanding < 1 && Math.abs(st.vel) < 0.05 ? "on" : "off",
    );

    /* calls + tests */
    $("cl-bank").parentNode.setAttribute(
      "data-call",
      st.calls.bank ? "on" : "off",
    );
    $("cl-surface").parentNode.setAttribute(
      "data-call",
      st.calls.surface ? "on" : "off",
    );
    $("masterkey").setAttribute("aria-checked", st.master ? "true" : "false");

    /* tally */
    tallyNum.textContent = st.bellCount > 0 ? String(st.bellCount) : "\u2014";
    tallyMeaning.textContent = st.bellMeaning || "SIGNAL";

    /* key switch caption state */
    sound.setHum(st.master ? Math.abs(st.amps) / 800 : 0);
    sound.setHorn(anyUnacked());
  }

  function anyUnacked() {
    for (var i = 0; i < ALARMS.length; i++) {
      var a = S.alrm[ALARMS[i]];
      if (a.on && !a.acked) return true;
    }
    return false;
  }

  function syncTestLamps() {
    $("tl-brake").parentNode.setAttribute(
      "data-fault",
      S.fBrake ? "on" : "off",
    );
    $("tl-rope").parentNode.setAttribute("data-fault", S.fRope ? "on" : "off");
    $("tl-temp").parentNode.setAttribute("data-fault", S.fTemp ? "on" : "off");
  }

  /* ---------------- interaction ---------------- */

  function leverDrag(elm, onValue) {
    var active = false;
    function fromEvent(e) {
      var r = elm.getBoundingClientRect();
      var y = (e.clientY - r.top) / r.height;
      onValue(clamp(1 - y, 0, 1));
    }
    elm.addEventListener("pointerdown", function (e) {
      active = true;
      elm.setPointerCapture(e.pointerId);
      fromEvent(e);
      e.preventDefault();
    });
    elm.addEventListener("pointermove", function (e) {
      if (active) fromEvent(e);
    });
    elm.addEventListener("pointerup", function () {
      active = false;
    });
    elm.addEventListener("pointercancel", function () {
      active = false;
    });
  }

  leverDrag($("brakelever"), function (v) {
    if (S.mode === "AUTO") return;
    S.brk = v;
  });

  (function () {
    var q = $("quadrant");
    var active = false;
    function fromEvent(e) {
      if (S.mode === "AUTO") return;
      var r = q.getBoundingClientRect();
      var sx = 210 / r.width,
        sy = 230 / r.height;
      var px = (e.clientX - r.left) * sx,
        py = (e.clientY - r.top) * sy;
      var dx = px - 105,
        dy = 218 - py;
      var a = (Math.atan2(dx, dy) * 180) / Math.PI;
      S.thr = clamp(a / 62, -1, 1);
    }
    q.addEventListener("pointerdown", function (e) {
      active = true;
      q.setPointerCapture(e.pointerId);
      fromEvent(e);
      e.preventDefault();
    });
    q.addEventListener("pointermove", function (e) {
      if (active) fromEvent(e);
    });
    q.addEventListener("pointerup", function () {
      active = false;
    });
    q.addEventListener("pointercancel", function () {
      active = false;
    });
  })();

  function keyStep(e, apply) {
    var map = {
      ArrowUp: 1,
      ArrowRight: 1,
      PageUp: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageDown: -1,
    };
    if (!(e.key in map) && e.key !== "Home" && e.key !== "End") return false;
    e.preventDefault();
    if (e.key === "Home") apply(-Infinity);
    else if (e.key === "End") apply(Infinity);
    else apply(map[e.key] * 0.08);
    return true;
  }

  $("brakelever").addEventListener("keydown", function (e) {
    if (S.mode === "AUTO") return;
    keyStep(e, function (d) {
      S.brk = clamp(d === -Infinity ? 0 : d === Infinity ? 1 : S.brk + d, 0, 1);
    });
  });

  $("quadrant").addEventListener("keydown", function (e) {
    if (S.mode === "AUTO") return;
    keyStep(e, function (d) {
      S.thr = clamp(
        d === -Infinity ? -1 : d === Infinity ? 1 : S.thr + d,
        -1,
        1,
      );
    });
  });

  /* master key */
  $("masterkey").addEventListener("click", function () {
    S.master = !S.master;
    if (!S.master) S.autoTarget = null;
    render();
  });
  $("masterkey").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.click();
    }
  });

  /* mode selector */
  function setMode(m) {
    S.mode = m;
    if (m !== "AUTO") S.autoTarget = null;
    Array.prototype.forEach.call(
      document.querySelectorAll(".rotlab"),
      function (b) {
        b.setAttribute("aria-checked", b.dataset.mode === m ? "true" : "false");
      },
    );
    render();
  }
  Array.prototype.forEach.call(
    document.querySelectorAll(".rotlab"),
    function (b) {
      b.addEventListener("click", function () {
        setMode(b.dataset.mode);
      });
    },
  );
  $("modesel").addEventListener("click", function () {
    setMode(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]);
  });
  $("modesel").addEventListener("keydown", function (e) {
    var map = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key in map) {
      e.preventDefault();
      setMode(
        MODES[
          (MODES.indexOf(S.mode) + map[e.key] + MODES.length) % MODES.length
        ],
      );
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setMode(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]);
    }
  });

  /* bell */
  $("b-bell").addEventListener("click", function () {
    if (S.bellTimer > 0) S.bellCount += 1;
    else S.bellCount = 1;
    S.bellTimer = 1.6;
    S.bellMeaning =
      S.bellCount === 1
        ? "STOP"
        : S.bellCount === 2
          ? "LOWER"
          : S.bellCount === 3
            ? "RAISE"
            : "WINDER CLEAR";
    sound.ding();
    render();
  });

  /* calls */
  $("b-bank").addEventListener("click", function () {
    S.calls.bank = !S.calls.bank;
    if (!S.calls.bank && S.autoTarget === 0) S.autoTarget = null;
    render();
  });
  $("b-surface").addEventListener("click", function () {
    S.calls.surface = !S.calls.surface;
    if (!S.calls.surface && S.autoTarget === TRAVEL) S.autoTarget = null;
    render();
  });

  /* annunciator buttons */
  $("b-accept").addEventListener("click", function () {
    ALARMS.forEach(function (a) {
      if (S.alrm[a].on) S.alrm[a].acked = true;
    });
    render();
  });
  $("b-horn").addEventListener("click", function () {
    S.hornCut = true;
    sound.stopHorn();
  });
  $("b-reset").addEventListener("click", function () {
    var ok =
      Math.abs(S.vel) < 0.05 &&
      Math.abs(S.thr) < 0.02 &&
      Math.abs(S.diff) < SLIP_TRIP &&
      (!S.thermal || S.temp < 140);
    if (!ok) return;
    S.tripped = false;
    S.tripCause = "";
    S.thermal = false;
    S.alrm["WINDER TRIPPED"].on = false;
    S.alrm["OVERWIND"].on = false;
    S.alrm.OVERWIND.acked = true;
    render();
  });

  /* maintenance cover + test buttons */
  $("maintcover").addEventListener("click", function () {
    var p = $("maintpanel");
    p.classList.toggle("open");
    this.setAttribute(
      "aria-expanded",
      p.classList.contains("open") ? "true" : "false",
    );
  });
  $("t-brake").addEventListener("click", function () {
    if (S.fBrake) clearFault("brake hydraulic leak");
    else inject("brake hydraulic leak");
  });
  $("t-rope").addEventListener("click", function () {
    if (S.fRope) clearFault("rope slip");
    else inject("rope slip");
  });
  $("t-temp").addEventListener("click", function () {
    if (S.fTemp) clearFault("motor overtemperature");
    else inject("motor overtemperature");
  });

  /* ---------------- manual dialog ---------------- */

  var dlg = $("manualdialog");
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="manual"]'),
    function (b) {
      b.addEventListener("click", function () {
        if (typeof dlg.showModal === "function") dlg.showModal();
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

  /* ---------------- sound (after first gesture only) ---------------- */

  var sound = (function () {
    var ctx = null,
      humOsc = null,
      humGain = null,
      hornOsc = null,
      hornGain = null;
    var humLevel = 0,
      hornWant = false;

    function unlock() {
      if (ctx) {
        if (ctx.state === "suspended") ctx.resume();
        return;
      }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        humOsc = ctx.createOscillator();
        humOsc.type = "sawtooth";
        humOsc.frequency.value = 50;
        humGain = ctx.createGain();
        humGain.gain.value = 0;
        var lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 220;
        humOsc.connect(lp);
        lp.connect(humGain);
        humGain.connect(ctx.destination);
        humOsc.start();
        hornOsc = ctx.createOscillator();
        hornOsc.type = "square";
        hornOsc.frequency.value = 228;
        hornGain = ctx.createGain();
        hornGain.gain.value = 0;
        hornOsc.connect(hornGain);
        hornGain.connect(ctx.destination);
        hornOsc.start();
      } catch (e) {
        ctx = null;
      }
    }
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);

    function ding() {
      if (!ctx) return;
      var t = ctx.currentTime;
      [1318, 1974].forEach(function (f, i) {
        var o = ctx.createOscillator(),
          g = ctx.createGain();
        o.type = "triangle";
        o.frequency.value = f;
        g.gain.setValueAtTime(i ? 0.05 : 0.09, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t);
        o.stop(t + 1);
      });
    }
    return {
      ding: ding,
      setHum: function (level) {
        humLevel = level;
        if (humGain && ctx)
          humGain.gain.setTargetAtTime(humLevel * 0.028, ctx.currentTime, 0.2);
      },
      setHorn: function (want) {
        hornWant = want;
      },
      hornNudge: function () {
        hornWant = true;
      },
      stopHorn: function () {
        hornWant = false;
        if (hornGain && ctx)
          hornGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      },
      pump: function () {
        if (!ctx) return;
        var on = hornWant && !S.hornCut && anyUnacked();
        if (hornGain)
          hornGain.gain.setTargetAtTime(
            on ? 0.045 : 0,
            ctx.currentTime,
            on ? 0.02 : 0.1,
          );
      },
    };
  })();

  /* ---------------- main loop ---------------- */

  var lastFrame = null;
  var hidden = false;
  function frame(now) {
    requestAnimationFrame(frame);
    if (hidden) {
      lastFrame = now;
      return;
    }
    if (lastFrame == null) lastFrame = now;
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0 && dt < 2) {
      tick(dt);
      render();
      sound.pump();
    }
  }
  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    if (!hidden) lastFrame = null;
  });

  render();
  requestAnimationFrame(frame);
})();
