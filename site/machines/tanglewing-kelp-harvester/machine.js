/* =====================================================================
   MV TANGLEWING — kelp harvester cut & winch console · control software
   Havsvart Marine Systems CW-0331 · firmware 84.7.2
   One deterministic simulation, one render pass per frame, no network.
   ===================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Tuning constants                                                    */
  /* ------------------------------------------------------------------ */

  var SURFACE_M = 19; // metres shown on the depth axis
  var NOTCH_SPEED = [0, 0.35, 0.72, 1.15]; // advance m/s per lever notch
  var PRESS_MAIN = 205;
  var PRESS_STBY = 168;
  var TENSION_WARN = 175;
  var TENSION_PART = 214;
  var TEMP_TRIP = 96;
  var TEMP_RELEASE = 78;
  var HOLD_MAX = 8000;
  var PURGE_TIME = 5;
  var RESEAT_TIME = 5;

  var MACHINE_NAME = "Tanglewing Kelp Harvester";
  var FAULTS = ["cutter fouling", "winch brake slip", "hydraulic fluid leak"];

  var ALARM_DEFS = [
    { id: "cutter-foul", label: "CUTTER FOUL", cls: "red" },
    { id: "brake-slip", label: "BRAKE SLIP", cls: "red" },
    { id: "hyd-leak", label: "HYD LEAK", cls: "red" },
    { id: "tension", label: "TENSION", cls: "red" },
    { id: "oil-hot", label: "OIL HOT", cls: "red" },
    { id: "off-canopy", label: "OFF CANOPY", cls: "amber" },
    { id: "hold-full", label: "HOLD FULL", cls: "amber" },
    { id: "lockout", label: "LOCKOUT", cls: "red" },
  ];

  var LEVER_ANGLES = [-38, -13, 13, 38];
  var ROTARY_LABEL = [
    ["SHUT", "MAIN", "STBY"],
    ["BOW", "LEVEL", "STERN"],
  ];

  /* ------------------------------------------------------------------ */
  /* Machine state                                                       */
  /* ------------------------------------------------------------------ */

  var S = coldState();

  function coldState() {
    return {
      elapsed: 0,
      busOn: false,
      hydIdx: 0, // 0 shut · 1 main · 2 standby
      trimIdx: 1, // 0 bow · 1 level · 2 stern
      depthCmd: 11,
      depth: 0,
      haulNotch: 0,
      cutterSwitch: false,
      wash: "off",
      purgeLeft: 0,
      brakeHeld: false,
      press: 0,
      oilTemp: 12,
      oilLevel: 100,
      tension: 0,
      torque: 0,
      haulSpeed: 0,
      position: 0,
      holdKg: 0,
      cutEff: 0,
      grounded: false,
      lockHot: false,
      cableIntact: true,
      overTension: 0,
      foulSev: 0,
      slipSev: 0,
      leakOn: false,
      alarmAck: {},
    };
  }

  function clamp(v, lo, hi) {
    if (v < lo) {
      return lo;
    }
    if (v > hi) {
      return hi;
    }
    return v;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /* ------------------------------------------------------------------ */
  /* Environment: the farm bank, pure functions of distance run          */
  /* ------------------------------------------------------------------ */

  function densityAt(x) {
    var d =
      0.58 +
      0.34 * Math.sin(x / 88) * Math.sin(x / 27 + 1.7) +
      0.1 * Math.sin(x / 13);
    return clamp(d, 0.04, 0.98);
  }

  function bandTopAt(x) {
    return 8 + 1.15 * Math.sin(x / 152) + 0.35 * Math.sin(x / 41 + 2.2);
  }

  function bandBottomAt(x) {
    return bandTopAt(x) + 4.6 + 0.55 * Math.sin(x / 97 + 0.8);
  }

  function seabedAt(x) {
    return 16.6 + 0.95 * Math.sin(x / 213 + 0.6) + 0.3 * Math.sin(x / 61);
  }

  function currentAt(x) {
    return 0.42 + 0.3 * Math.sin(x / 305 + 1.1);
  }

  /* ------------------------------------------------------------------ */
  /* Derived quantities                                                  */
  /* ------------------------------------------------------------------ */

  function pressTarget() {
    if (!S.busOn || S.hydIdx === 0) {
      return 0;
    }
    var t = S.hydIdx === 2 ? PRESS_STBY : PRESS_MAIN;
    if (S.leakOn && S.hydIdx === 1 && S.oilLevel < 48) {
      t *= Math.max(0.08, S.oilLevel / 48);
    }
    return t;
  }

  function powerFactor() {
    return Math.min(1.04, S.press / 195);
  }

  function canopyMid() {
    return (bandTopAt(S.position) + bandBottomAt(S.position)) / 2;
  }

  function offCanopyCond() {
    if (!S.busOn || S.depth < 1.5) {
      return false;
    }
    var top = bandTopAt(S.position);
    var bot = bandBottomAt(S.position);
    return (
      S.depth < top - 0.6 ||
      S.depth > bot + 0.6 ||
      S.depth > seabedAt(S.position) - 0.45
    );
  }

  function lockEngaged() {
    return S.lockHot || !S.cableIntact;
  }

  function statusWord() {
    if (!S.cableIntact) {
      return "CABLE PARTED";
    }
    if (S.lockHot) {
      return "THERMAL LOCKOUT";
    }
    if (!S.busOn) {
      return "COLD";
    }
    if (S.press < 60) {
      return "NO HYD PRESSURE";
    }
    if (S.haulNotch > 0 && S.cutterSwitch) {
      return "HARVESTING";
    }
    if (S.cutterSwitch) {
      return "CUTTER ON";
    }
    if (S.haulNotch > 0) {
      return "HAULING";
    }
    return "READY";
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  function step(dt) {
    S.elapsed += dt;

    /* hydraulics ---------------------------------------------------- */
    var pt = pressTarget();
    S.press += (pt - S.press) * Math.min(1, dt * 0.55);
    if (Math.abs(S.press - pt) < 0.4) {
      S.press = pt;
    }
    var pf = powerFactor();

    /* oil level: the leak weeps on the main circuit only ------------- */
    if (S.leakOn && S.hydIdx === 1) {
      S.oilLevel -= 1.15 * dt;
    } else {
      S.oilLevel += 0.22 * dt;
    }
    S.oilLevel = clamp(S.oilLevel, 0, 100);

    /* winch: command against actual ---------------------------------- */
    var prevDepth = S.depth;
    var payRate = 0.55 * Math.max(pf, 0.25);
    if (S.slipSev > 0.02) {
      // the brake bleeds: the sled runs out whatever the wheel says
      S.depth += (0.1 + 0.09 * S.slipSev) * dt;
      if (S.brakeHeld && S.tension < TENSION_WARN) {
        S.slipSev = Math.max(0, S.slipSev - dt / RESEAT_TIME);
        if (S.slipSev === 0) {
          S.depthCmd = S.depth; // re-seat the drum at the running depth
        }
      }
    } else {
      S.depth +=
        clamp(S.depthCmd - S.depth, -payRate, payRate) *
        dt *
        1.6 *
        clamp(pf, 0.25, 1);
      if (S.brakeHeld) {
        S.depth -=
          clamp(S.depthCmd - S.depth, -payRate, payRate) *
          dt *
          1.6 *
          clamp(pf, 0.25, 1);
      }
    }

    var floor = seabedAt(S.position) - 0.15;
    S.grounded = false;
    if (S.depth >= floor) {
      S.depth = floor;
    }
    if (S.depth < 0) {
      S.depth = 0;
    }
    S.grounded = S.depth >= floor - 0.32 && S.depth > 2;
    var paid = Math.abs(S.depth - prevDepth);

    /* haul along the bank -------------------------------------------- */
    var locked = lockEngaged();
    S.haulSpeed =
      locked || !S.busOn
        ? 0
        : NOTCH_SPEED[S.haulNotch] * pf * (S.cableIntact ? 1 : 0);
    S.position += S.haulSpeed * dt * 10;

    /* cutting ---------------------------------------------------------*/
    var spinning = S.cutterSwitch && S.press > 55 && !locked;
    var cutting =
      spinning &&
      S.depth > 1.5 &&
      !S.grounded &&
      S.holdKg < HOLD_MAX - 1 &&
      S.cableIntact;
    var mid = canopyMid();
    var half = (bandBottomAt(S.position) - bandTopAt(S.position)) / 2;
    var shape = Math.exp(-Math.pow((S.depth - mid) / (half * 0.85), 2));
    if (S.depth < 1.5) {
      shape = 0;
    }
    S.cutEff = clamp(shape * (1 - S.foulSev * 0.94) * (0.45 + 0.55 * pf), 0, 1);
    if (!spinning) {
      S.cutEff = 0;
    }

    var massRate = cutting
      ? 13.5 * S.cutEff * (0.5 + densityAt(S.position))
      : 0;
    S.holdKg = Math.min(HOLD_MAX, S.holdKg + massRate * dt);

    /* slow natural fouling in dense canopy --------------------------- */
    if (cutting && S.foulSev > 0.001) {
      S.foulSev = Math.min(1, S.foulSev + dt * 0.0035 * densityAt(S.position));
    }

    /* wash / purge -----------------------------------------------------*/
    if (S.purgeLeft > 0) {
      S.purgeLeft = Math.max(0, S.purgeLeft - dt);
      if (S.busOn && S.press > 70) {
        S.foulSev = Math.max(0, S.foulSev - dt / PURGE_TIME);
      }
      if (S.purgeLeft === 0) {
        S.wash = "off";
        syncWashUI();
      }
    }

    /* torque ------------------------------------------------------------*/
    var tqTarget = 0;
    if (spinning) {
      tqTarget = 10;
      if (cutting) {
        tqTarget += 30 + 52 * S.cutEff * (0.6 + 0.6 * densityAt(S.position));
      }
      tqTarget += S.foulSev * 62;
      if (S.grounded) {
        tqTarget += 34;
      }
      if (S.wash === "wash" && S.busOn) {
        tqTarget -= 4;
      }
    }
    S.torque += (tqTarget - S.torque) * Math.min(1, dt * 1.1);
    S.torque = clamp(S.torque, 0, 170);

    /* tension ------------------------------------------------------------*/
    var tnTarget = 0;
    if (S.cableIntact && S.busOn) {
      tnTarget =
        16 +
        S.haulSpeed * 34 +
        currentAt(S.position) * S.haulSpeed * 26 +
        Math.max(0, S.depth - S.depthCmd) * 30 +
        S.foulSev * 26;
      if (S.brakeHeld) {
        tnTarget += 10;
      }
    } else if (!S.cableIntact) {
      tnTarget = 3;
    }
    S.tension += (tnTarget - S.tension) * Math.min(1, dt * 0.9);
    S.tension = clamp(S.tension, 0, 260);

    if (S.cableIntact && S.tension >= TENSION_PART) {
      S.overTension += dt;
      if (S.overTension > 2.4) {
        S.cableIntact = false;
        S.tension = 6;
        S.torque = 0;
        S.haulNotch = 0;
      }
    } else {
      S.overTension = Math.max(0, S.overTension - dt);
    }

    /* thermal --------------------------------------------------------------*/
    var heat = S.torque * 0.105 + S.tension * 0.028 + (S.press > 40 ? 7 : 0);
    var cool =
      0.032 * (S.oilTemp - 12) * (S.wash === "wash" && S.busOn ? 1.25 : 1);
    S.oilTemp = clamp(S.oilTemp + (heat * 0.06 - cool) * dt, 12, 135);

    if (S.oilTemp >= TEMP_TRIP) {
      S.lockHot = true;
    }
    if (S.lockHot && S.oilTemp < TEMP_RELEASE && alarmAcked("oil-hot")) {
      S.lockHot = false;
    }

    drumAngle += paid * 240;

    /* alarms ----------------------------------------------------------------*/
    setAlarm("cutter-foul", S.foulSev > 0.22);
    setAlarm("brake-slip", S.slipSev > 0.04);
    setAlarm("hyd-leak", S.leakOn);
    setAlarm("tension", S.tension > TENSION_WARN || !S.cableIntact);
    setAlarm("oil-hot", S.oilTemp > 91);
    setAlarm("off-canopy", offCanopyCond());
    setAlarm("hold-full", S.holdKg >= HOLD_MAX - 1);
    setAlarm("lockout", lockEngaged());
  }

  /* ------------------------------------------------------------------ */
  /* Alarms                                                              */
  /* ------------------------------------------------------------------ */

  var lastHornAt = -10;

  function setAlarm(id, cond) {
    var was = S.alarmAck[id];
    if (cond) {
      if (was === undefined) {
        S.alarmAck[id] = false;
        hornBlast();
      }
    } else if (was !== undefined) {
      delete S.alarmAck[id];
    }
  }

  function alarmAcked(id) {
    return S.alarmAck[id] === true;
  }

  function activeAlarms() {
    var out = [];
    for (var i = 0; i < ALARM_DEFS.length; i++) {
      if (S.alarmAck[ALARM_DEFS[i].id] !== undefined) {
        out.push(ALARM_DEFS[i].label);
      }
    }
    return out;
  }

  function anyUnacked() {
    for (var id in S.alarmAck) {
      if (S.alarmAck[id] === false) {
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Fixed API                                                           */
  /* ------------------------------------------------------------------ */

  function apiState() {
    return {
      elapsed: round2(S.elapsed),
      status: statusWord(),
      busOn: S.busOn ? 1 : 0,
      hydCircuit: S.hydIdx,
      trim: S.trimIdx,
      depthCmd: round2(S.depthCmd),
      depth: round2(S.depth),
      bandTop: round2(bandTopAt(S.position)),
      bandBottom: round2(bandBottomAt(S.position)),
      seabed: round2(seabedAt(S.position)),
      haulNotch: S.haulNotch,
      haulSpeed: round2(S.haulSpeed),
      position: Math.round(S.position),
      density: round2(densityAt(S.position)),
      torque: Math.round(S.torque),
      tension: Math.round(S.tension),
      press: Math.round(S.press),
      oilTemp: round2(S.oilTemp),
      oilLevel: round2(S.oilLevel),
      holdKg: Math.round(S.holdKg),
      cutEff: round2(S.cutEff),
      wash: S.wash,
      purgeLeft: round2(S.purgeLeft),
      cutterOn: S.cutterSwitch && S.press > 55 ? 1 : 0,
      brakeHeld: S.brakeHeld ? 1 : 0,
      grounded: S.grounded ? 1 : 0,
      cableIntact: S.cableIntact ? 1 : 0,
      lockout: lockEngaged() ? 1 : 0,
      faultsActive: [
        S.foulSev > 0.02 ? "cutter fouling" : "",
        S.slipSev > 0.02 ? "winch brake slip" : "",
        S.leakOn ? "hydraulic fluid leak" : "",
      ].filter(Boolean),
      alarms: activeAlarms(),
    };
  }

  function tick(seconds) {
    var remaining = Number(seconds);
    if (!isFinite(remaining) || remaining <= 0) {
      return;
    }
    remaining = Math.min(remaining, 120);
    while (remaining > 0) {
      var h = remaining > 0.25 ? 0.25 : remaining;
      step(h);
      remaining -= h;
    }
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "cutter fouling") {
      S.foulSev = Math.max(S.foulSev, 0.82);
    } else if (f === "winch brake slip") {
      S.slipSev = 1;
    } else if (f === "hydraulic fluid leak") {
      S.leakOn = true;
    }
  }

  function reset() {
    S = coldState();
    drumAngle = 0;
    wheelAngle = 0;
    stopHorn();
    syncAllUI();
  }

  /* ------------------------------------------------------------------ */
  /* DOM handles                                                         */
  /* ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  var el = {};
  var drumAngle = 0;
  var wheelAngle = 0;
  var lampTestOn = false;
  var transferHeld = false;

  var DOM_IDS = [
    "ro-clock",
    "ro-pos",
    "ro-status",
    "ro-press",
    "ro-temp",
    "ro-level",
    "ro-torque",
    "ro-tension",
    "ro-hold",
    "ro-depthcmd",
    "ro-depthact",
    "ro-deptherr",
    "ro-band",
    "needle-press",
    "sw-bus",
    "sw-engage",
    "guard-box",
    "guard-flap",
    "rot-hyd",
    "rot-trim",
    "wheel",
    "hw-rotor",
    "lever",
    "qd-arm",
    "brake",
    "btn-ack",
    "btn-lamptest",
    "btn-transfer",
    "sound",
    "maint-latch",
    "maint-tests",
    "ft-foul",
    "ft-slip",
    "ft-leak",
    "manual-dialog",
    "sc-seabed",
    "sc-canopy",
    "sc-stipes",
    "sc-fan",
    "sc-surface",
    "sc-cable",
    "sc-sled",
    "sc-bug",
    "sc-ruler",
    "drum-spokes",
    "bg-temp",
    "bg-torque",
    "bg-tension",
    "sg-oil",
    "hg-hold",
    "lp-power",
    "lp-hyd",
    "lp-cutter",
    "lp-wash",
  ];

  function grabDom() {
    DOM_IDS.forEach(function (id) {
      el[id] = $(id);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Static SVG built once                                               */
  /* ------------------------------------------------------------------ */

  function buildGaugeFace() {
    var NS = "http://www.w3.org/2000/svg";
    var g = document.querySelector(".rg-scale");
    var i;
    for (i = 0; i <= 25; i++) {
      var a = ((-120 + (i / 25) * 240) * Math.PI) / 180;
      var major = i % 5 === 0;
      var r1 = major ? 37 : 41;
      var line = document.createElementNS(NS, "line");
      line.setAttribute("x1", (60 + r1 * Math.sin(a)).toFixed(2));
      line.setAttribute("y1", (60 - r1 * Math.cos(a)).toFixed(2));
      line.setAttribute("x2", (60 + 46 * Math.sin(a)).toFixed(2));
      line.setAttribute("y2", (60 - 46 * Math.cos(a)).toFixed(2));
      g.appendChild(line);
      if (major) {
        var t = document.createElementNS(NS, "text");
        t.setAttribute("x", (60 + 29 * Math.sin(a)).toFixed(2));
        t.setAttribute("y", (60 - 29 * Math.cos(a) + 3).toFixed(2));
        t.setAttribute("text-anchor", "middle");
        t.textContent = String(i / 5);
        g.appendChild(t);
      }
    }
    var arc = document.querySelector(".rg-redarc-zone");
    var a1 = (((210 / 250) * 240 - 120) * Math.PI) / 180;
    var a2 = (120 * Math.PI) / 180;
    var r = 47;
    arc.setAttribute(
      "d",
      "M" +
        (60 + r * Math.sin(a1)).toFixed(2) +
        " " +
        (60 - r * Math.cos(a1)).toFixed(2) +
        " A" +
        r +
        " " +
        r +
        " 0 0 1 " +
        (60 + r * Math.sin(a2)).toFixed(2) +
        " " +
        (60 - r * Math.cos(a2)).toFixed(2),
    );
  }

  function yForDepth(d) {
    return 44 + (d / SURFACE_M) * 344;
  }

  function buildRuler() {
    var NS = "http://www.w3.org/2000/svg";
    var g = el["sc-ruler"];
    var d;
    for (d = 0; d <= 18; d += 2) {
      var y = yForDepth(d).toFixed(1);
      var line = document.createElementNS(NS, "line");
      line.setAttribute("x1", 26);
      line.setAttribute("y1", y);
      line.setAttribute("x2", d % 4 === 0 ? 36 : 31);
      line.setAttribute("y2", y);
      g.appendChild(line);
      if (d % 4 === 0) {
        var t = document.createElementNS(NS, "text");
        t.setAttribute("x", 38);
        t.setAttribute("y", Number(y) + 2.6);
        t.textContent = String(d);
        g.appendChild(t);
      }
    }
  }

  function buildStipes() {
    var NS = "http://www.w3.org/2000/svg";
    var g = el["sc-stipes"];
    var x;
    for (x = 56; x <= 330; x += 17) {
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("data-x", x);
      g.appendChild(ln);
    }
  }

  /* screen column -> world distance run */
  function worldXFor(sx) {
    return S.position + (sx - 128) * 0.62;
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  function render() {
    el["ro-clock"].textContent =
      pad2(Math.floor(S.elapsed / 60)) + ":" + pad2(Math.floor(S.elapsed % 60));
    el["ro-pos"].textContent =
      String(Math.round(S.position) % 10000).padStart(4, "0") + " m";
    el["ro-status"].textContent = statusWord();

    el["needle-press"].style.transform =
      "rotate(" + (-120 + clamp(S.press / 250, 0, 1) * 240).toFixed(1) + "deg)";
    el["ro-press"].textContent = String(Math.round(S.press));

    setBar("bg-temp", (S.oilTemp - 12) / 98);
    el["ro-temp"].textContent = String(Math.round(S.oilTemp));
    setBar("bg-torque", S.torque / 160);
    el["ro-torque"].textContent = String(Math.round(S.torque));
    setBar("bg-tension", S.tension / 240);
    el["ro-tension"].textContent = String(Math.round(S.tension));

    el["sg-oil"].querySelector(".sg-fill").style.height =
      clamp(S.oilLevel, 0, 100) + "%";
    el["ro-level"].textContent = String(Math.round(S.oilLevel));
    el["hg-hold"].querySelector(".hg-fill").style.height =
      clamp((S.holdKg / HOLD_MAX) * 100, 0, 100) + "%";
    el["ro-hold"].textContent = (S.holdKg / 1000).toFixed(1) + " t";

    setJewel("lp-power", S.busOn ? "grn" : "");
    setJewel("lp-hyd", S.press > 150 ? "grn" : S.press > 55 ? "on" : "");
    setJewel("lp-cutter", S.torque > 4 ? (S.torque > 120 ? "red" : "grn") : "");
    setJewel("lp-wash", S.wash !== "off" && S.busOn ? "on" : "");

    ALARM_DEFS.forEach(function (def) {
      var tile = document.querySelector('[data-alarm="' + def.id + '"]');
      var ackState = S.alarmAck[def.id];
      tile.classList.remove("alarm-red", "alarm-amber", "flash");
      if (lampTestOn || ackState !== undefined) {
        tile.classList.add(def.cls === "amber" ? "alarm-amber" : "alarm-red");
        if (!lampTestOn && ackState === false) {
          tile.classList.add("flash");
        }
      }
    });

    el["ro-depthcmd"].textContent = S.depthCmd.toFixed(1) + " m";
    el["ro-depthact"].textContent = S.depth.toFixed(1) + " m";
    var err = S.depthCmd - S.depth;
    el["ro-deptherr"].textContent = (err >= 0 ? "+" : "") + err.toFixed(1);
    el["ro-deptherr"].classList.toggle("piezo-warn", Math.abs(err) > 1.2);
    el["ro-band"].textContent =
      bandTopAt(S.position).toFixed(1) +
      "/" +
      bandBottomAt(S.position).toFixed(1);

    drawScope();

    el["hw-rotor"].style.transform = "rotate(" + wheelAngle.toFixed(1) + "deg)";
    el["drum-spokes"].style.transform =
      "translate(46px,366px) rotate(" +
      (drumAngle % 360).toFixed(1) +
      "deg) translate(-46px,-366px)";
  }

  function setBar(id, frac) {
    el[id].querySelector(".bg-fill").style.width =
      (clamp(frac, 0, 1) * 100).toFixed(1) + "%";
  }

  function setJewel(id, mode) {
    var j = el[id];
    j.classList.remove("on", "grn", "red");
    var m = lampTestOn ? "grn" : mode;
    if (m) {
      j.classList.add(m);
    }
  }

  /* ---------- the echosounder picture ---------- */

  function drawScope() {
    var x;
    var pts;

    pts = [];
    for (x = 26; x <= 332; x += 12) {
      pts.push(
        x + "," + (34 + 1.6 * Math.sin(x / 22 + S.elapsed * 1.4)).toFixed(1),
      );
    }
    el["sc-surface"].setAttribute("points", pts.join(" "));

    pts = [];
    for (x = 26; x <= 332; x += 14) {
      pts.push(x + "," + yForDepth(seabedAt(worldXFor(x))).toFixed(1));
    }
    pts.push("332,394 26,394");
    el["sc-seabed"].setAttribute("points", pts.join(" "));

    pts = [];
    for (x = 26; x <= 332; x += 14) {
      pts.push(x + "," + yForDepth(bandTopAt(worldXFor(x))).toFixed(1));
    }
    for (x = 332; x >= 26; x -= 14) {
      pts.push(x + "," + yForDepth(bandBottomAt(worldXFor(x))).toFixed(1));
    }
    el["sc-canopy"].setAttribute("points", pts.join(" "));

    var lines = el["sc-stipes"].querySelectorAll("line");
    lines.forEach(function (ln) {
      var sx = Number(ln.getAttribute("data-x"));
      var wx = worldXFor(sx);
      var top = yForDepth(bandTopAt(wx));
      var bot = yForDepth(bandBottomAt(wx));
      var dens = densityAt(wx);
      var sway = Math.sin(S.elapsed * 1.1 + sx * 0.35) * (3 + 3 * dens);
      var lean = 5 + 7 * Math.abs(Math.sin(wx / 60));
      ln.setAttribute("x1", sx.toFixed(1));
      ln.setAttribute("y1", bot.toFixed(1));
      ln.setAttribute("x2", (sx + lean + sway).toFixed(1));
      ln.setAttribute("y2", top.toFixed(1));
      ln.style.opacity = (0.22 + 0.5 * dens).toFixed(2);
    });

    var sy = yForDepth(clamp(S.depth, 0, SURFACE_M));
    el["sc-sled"].style.transform = "translate(150px," + sy.toFixed(1) + "px)";
    el["sc-cable"].setAttribute("x2", "150");
    el["sc-cable"].setAttribute("y2", sy.toFixed(1));

    el["sc-bug"].style.transform =
      "translate(0," +
      yForDepth(clamp(S.depthCmd, 0, SURFACE_M)).toFixed(1) +
      "px)";
  }

  /* ------------------------------------------------------------------ */
  /* Audio: pump hum + alarm horn, only ever after a gesture             */
  /* ------------------------------------------------------------------ */

  var AC = null;
  var humGain = null;
  var hornGain = null;
  var soundArmed = false;
  var lastHornWall = 0;

  function ensureAudio() {
    if (AC || !soundArmed) {
      return;
    }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return;
    }
    try {
      AC = new Ctx();
      humGain = AC.createGain();
      humGain.gain.value = 0;
      var lp = AC.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 240;
      var o1 = AC.createOscillator();
      o1.type = "sawtooth";
      o1.frequency.value = 47;
      var o2 = AC.createOscillator();
      o2.type = "sine";
      o2.frequency.value = 94;
      o1.connect(humGain);
      o2.connect(humGain);
      humGain.connect(lp);
      lp.connect(AC.destination);
      o1.start();
      o2.start();

      hornGain = AC.createGain();
      hornGain.gain.value = 0;
      var bp = AC.createBiquadFilter();
      bp.type = "bandpass";

      bp.Q.value = 2.2;
      var ho = AC.createOscillator();
      ho.type = "square";
      ho.frequency.value = 318;
      ho.connect(hornGain);
      hornGain.connect(bp);
      bp.connect(AC.destination);
      ho.start();
    } catch (e) {
      AC = null;
    }
  }

  function hornBlast() {
    if (!AC || !soundArmed) {
      return;
    }
    var now = Date.now();
    if (now - lastHornWall < 2400) {
      return;
    }
    lastHornWall = now;
    var t = AC.currentTime;
    var g = hornGain.gain;
    g.cancelScheduledValues(t);

    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(0.15, t + 0.03);
    g.setValueAtTime(0.15, t + 0.45);
    g.exponentialRampToValueAtTime(0.0001, t + 0.65);
  }

  function stopHorn() {
    if (AC && hornGain) {
      var t = AC.currentTime;
      hornGain.gain.cancelScheduledValues(t);
      hornGain.gain.setValueAtTime(0.0001, t);
    }
  }

  function audioFrame() {
    if (!AC || !humGain) {
      return;
    }
    var target =
      soundArmed && S.busOn && S.press > 60
        ? 0.026 + Math.min(0.02, S.haulSpeed * 0.012)
        : 0;
    humGain.gain.setTargetAtTime(target, AC.currentTime, 0.25);
    if (anyUnacked()) {
      hornBlast();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Control wiring                                                      */
  /* ------------------------------------------------------------------ */

  function poke() {}

  function syncWashUI() {
    var group = $("wash");
    group.querySelectorAll(".rocker").forEach(function (b) {
      b.setAttribute(
        "aria-checked",
        b.getAttribute("data-wash") === S.wash ? "true" : "false",
      );
    });
  }

  function syncAllUI() {
    $("sw-bus").setAttribute("aria-checked", S.busOn ? "true" : "false");
    $("sw-engage").setAttribute(
      "aria-checked",
      S.cutterSwitch ? "true" : "false",
    );
    $("rot-hyd")._show();
    $("rot-trim")._show();
    syncLever();
    syncWashUI();
    $("guard-box").classList.remove("open");
  }

  function bindBus() {
    var btn = $("sw-bus");
    btn.addEventListener("click", function () {
      S.busOn = !S.busOn;
      btn.setAttribute("aria-checked", S.busOn ? "true" : "false");
      if (!S.busOn) {
        S.cutterSwitch = false;
        $("sw-engage").setAttribute("aria-checked", "false");
        S.haulNotch = 0;
        syncLever();
      }
      poke();
    });
  }

  function bindRotary(elm, which, get, set) {
    function show() {
      var v = get();
      elm.setAttribute("aria-valuenow", String(v));
      elm.setAttribute(
        "aria-valuetext",
        ROTARY_LABEL[which][v] + ", index " + v + " of 2",
      );
      elm.querySelector(".rot-pointer").style.transform =
        "rotate(" + (-60 + v * 60) + "deg)";
    }
    elm._show = show;
    show();
    elm.addEventListener("keydown", function (e) {
      var v = get();
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        set(Math.min(2, v + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        set(Math.max(0, v - 1));
      } else if (e.key === "Home") {
        set(0);
      } else if (e.key === "End") {
        set(2);
      } else {
        return;
      }
      e.preventDefault();
      show();
      poke();
    });
    elm.addEventListener("click", function () {
      set((get() + 1) % 3);
      show();
      poke();
    });
  }

  function bindWheel() {
    var wheel = el.wheel;
    var dragging = false;
    var lastY = 0;

    function nudge(dm) {
      S.depthCmd = clamp(S.depthCmd + dm, 4, 18);
      wheelAngle += dm * 24;
      wheel.setAttribute("aria-valuenow", S.depthCmd.toFixed(1));
      wheel.setAttribute("aria-valuetext", S.depthCmd.toFixed(1) + " metres");
      poke();
    }

    wheel.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastY = e.clientY;
      try {
        wheel.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    wheel.addEventListener("pointermove", function (e) {
      if (!dragging) {
        return;
      }
      var dy = e.clientY - lastY;
      lastY = e.clientY;
      nudge(-dy * 0.035);
    });
    wheel.addEventListener("pointerup", function () {
      dragging = false;
    });
    wheel.addEventListener("pointercancel", function () {
      dragging = false;
    });
    wheel.addEventListener("keydown", function (e) {
      var stepSize = e.shiftKey ? 1 : 0.2;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        nudge(stepSize);
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        nudge(-stepSize);
      } else if (e.key === "PageUp") {
        nudge(1);
      } else if (e.key === "PageDown") {
        nudge(-1);
      } else if (e.key === "Home") {
        nudge(-99);
      } else if (e.key === "End") {
        nudge(99);
      } else {
        return;
      }
      e.preventDefault();
    });
  }

  var LEVER_NAMES = ["STOP", "SLOW", "HALF", "FULL"];

  function syncLever() {
    el["qd-arm"].style.transform =
      "rotate(" + LEVER_ANGLES[S.haulNotch] + "deg)";
    el.lever.setAttribute("aria-valuenow", String(S.haulNotch));
    el.lever.setAttribute(
      "aria-valuetext",
      LEVER_NAMES[S.haulNotch] + ", notch " + S.haulNotch + " of 3",
    );
  }

  function bindLever() {
    var q = el.lever;

    function setNotch(n) {
      S.haulNotch = clamp(Math.round(n), 0, 3);
      syncLever();
      poke();
    }

    function fromEvent(e) {
      var r = q.getBoundingClientRect();
      var px = e.clientX - (r.left + r.width / 2);
      var py = r.bottom - 10 - e.clientY;
      var ang = (Math.atan2(px, Math.max(py, 4)) * 180) / Math.PI;
      var best = 0;
      var bd = 999;
      LEVER_ANGLES.forEach(function (a, i) {
        var d = Math.abs(a - ang);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      setNotch(best);
    }

    var down = false;
    q.addEventListener("pointerdown", function (e) {
      down = true;
      try {
        q.setPointerCapture(e.pointerId);
      } catch (err) {}
      fromEvent(e);
    });
    q.addEventListener("pointermove", function (e) {
      if (down) {
        fromEvent(e);
      }
    });
    q.addEventListener("pointerup", function () {
      down = false;
    });
    q.addEventListener("pointercancel", function () {
      down = false;
    });
    q.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        setNotch(S.haulNotch + 1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        setNotch(S.haulNotch - 1);
      } else if (e.key === "Home") {
        setNotch(0);
      } else if (e.key === "End") {
        setNotch(3);
      } else {
        return;
      }
      e.preventDefault();
    });
  }

  function guardOpen() {
    return el["guard-box"].classList.contains("open");
  }

  function liftGuard() {
    el["guard-box"].classList.add("open");
  }

  function bindGuarded() {
    el["guard-flap"].addEventListener("click", liftGuard);
    el["guard-box"].addEventListener("click", function (e) {
      if (e.target === el["guard-box"]) {
        liftGuard();
      }
    });
    el["sw-engage"].addEventListener("click", function () {
      if (!guardOpen()) {
        liftGuard();
        return;
      }
      S.cutterSwitch = !S.cutterSwitch;
      el["sw-engage"].setAttribute(
        "aria-checked",
        S.cutterSwitch ? "true" : "false",
      );
      poke();
    });
    el["sw-engage"].addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
        e.preventDefault();
        this.click();
      }
    });
  }

  function bindWash() {
    var group = $("wash");
    var buttons = group.querySelectorAll(".rocker");
    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        var w = b.getAttribute("data-wash");
        if (w === "purge") {
          if (S.wash !== "purge") {
            S.wash = "purge";
            S.purgeLeft = PURGE_TIME;
          }
        } else {
          S.wash = w;
          if (w === "off") {
            S.purgeLeft = 0;
          }
        }
        syncWashUI();
        poke();
      });
    });
    group.addEventListener("keydown", function (e) {
      var order = ["purge", "off", "wash"];
      var cur = order.indexOf(S.wash);
      var nxt = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        nxt = order[(cur + 1) % 3];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        nxt = order[(cur + 2) % 3];
      }
      if (nxt !== null && cur !== -1) {
        e.preventDefault();
        buttons.forEach(function (b) {
          if (b.getAttribute("data-wash") === nxt) {
            b.click();
          }
        });
      }
    });
  }

  function bindBrake() {
    var b = el.brake;
    function on(e) {
      e.preventDefault();
      S.brakeHeld = true;
      b.classList.add("held");
      poke();
    }
    function off() {
      S.brakeHeld = false;
      b.classList.remove("held");
      poke();
    }
    b.addEventListener("pointerdown", on);
    b.addEventListener("pointerup", off);
    b.addEventListener("pointerleave", off);
    b.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
        on(e);
      }
    });
    b.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
        off();
      }
    });
  }

  function acknowledge() {
    for (var id in S.alarmAck) {
      S.alarmAck[id] = true;
    }
    stopHorn();
    poke();
  }

  function holdButton(btn, onDown, onUp) {
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      btn.classList.add("pressed");
      onDown();
    });
    var release = function () {
      btn.classList.remove("pressed");
      if (onUp) {
        onUp();
      }
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("keydown", function (e) {
      if (
        (e.key === " " || e.key === "Spacebar" || e.key === "Enter") &&
        !btn._held
      ) {
        btn._held = true;
        btn.classList.add("pressed");
        onDown();
      }
    });
    btn.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
        btn._held = false;
        release();
      }
    });
  }

  function bindButtons() {
    // ALARM ACK acknowledges; held for two seconds with the gear lost
    // overboard it also re-rigs a replacement cable (see the manual).
    var rigTimer = null;
    holdButton(
      $("btn-ack"),
      function () {
        acknowledge();
        rigTimer = setTimeout(function () {
          if (!S.cableIntact) {
            S.cableIntact = true;
            S.overTension = 0;
            S.tension = 6;
            for (var id in S.alarmAck) {
              if (id === "lockout" || id === "tension") {
                delete S.alarmAck[id];
              }
            }
            stopHorn();
          }
        }, 2000);
      },
      function () {
        if (rigTimer) {
          clearTimeout(rigTimer);
          rigTimer = null;
        }
      },
    );
    holdButton(
      $("btn-transfer"),

      $("btn-transfer"),
      function () {
        transferHeld = true;
      },
      function () {
        transferHeld = false;
      },
    );

    var lt = $("btn-lamptest");
    var ltOn = function (e) {
      if (e && e.preventDefault) {
        e.preventDefault();
      }
      lampTestOn = true;
      lt.classList.add("pressed");
    };
    var ltOff = function () {
      lampTestOn = false;
      lt.classList.remove("pressed");
    };
    lt.addEventListener("pointerdown", ltOn);
    lt.addEventListener("pointerup", ltOff);
    lt.addEventListener("pointerleave", ltOff);
    lt.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Spacebar" || e.key === "Enter") {
        ltOn();
      }
    });
    lt.addEventListener("keyup", ltOff);
  }

  function bindMaint() {
    var latch = $("maint-latch");
    var tests = $("maint-tests");
    latch.addEventListener("click", function () {
      if (tests.hasAttribute("hidden")) {
        tests.removeAttribute("hidden");
        latch.setAttribute("aria-expanded", "true");
      } else {
        tests.setAttribute("hidden", "");
        latch.setAttribute("aria-expanded", "false");
      }
    });
    $("ft-foul").addEventListener("click", function () {
      inject("cutter fouling");
    });
    $("ft-slip").addEventListener("click", function () {
      inject("winch brake slip");
    });
    $("ft-leak").addEventListener("click", function () {
      inject("hydraulic fluid leak");
    });
  }

  function bindSound() {
    el.sound.addEventListener("click", function () {
      soundArmed = !soundArmed;
      el.sound.setAttribute("aria-checked", soundArmed ? "true" : "false");
      if (soundArmed) {
        ensureAudio();
        if (AC && AC.state === "suspended") {
          AC.resume();
        }
      } else {
        stopHorn();
        if (AC && humGain) {
          humGain.gain.setTargetAtTime(0, AC.currentTime, 0.05);
        }
      }
    });
  }

  function bindDialog() {
    var dlg = el["manual-dialog"];
    document.querySelectorAll('[data-action="manual"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof dlg.showModal === "function") {
          dlg.showModal();
        } else {
          dlg.setAttribute("open", "");
        }
      });
    });
    document
      .querySelectorAll('[data-action="close-manual"]')
      .forEach(function (b) {
        b.addEventListener("click", function () {
          if (typeof dlg.close === "function") {
            dlg.close();
          } else {
            dlg.removeAttribute("open");
          }
        });
      });
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) {
        dlg.close();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Hold transfer pump                                                  */
  /* ------------------------------------------------------------------ */

  function stepTransfer(dt) {
    if (transferHeld && S.busOn && S.press > 80) {
      S.holdKg = Math.max(0, S.holdKg - 950 * dt);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Main loop                                                           */
  /* ------------------------------------------------------------------ */

  var lastT = null;

  function frame(t) {
    requestAnimationFrame(frame);
    if (lastT === null) {
      lastT = t;
      return;
    }
    var dt = (t - lastT) / 1000;
    lastT = t;
    if (document.hidden) {
      return;
    }
    if (dt > 1) {
      dt = 1;
    }
    tick(dt);
    stepTransfer(dt);
    render();
    audioFrame();
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    grabDom();
    buildGaugeFace();
    buildRuler();
    buildStipes();

    bindBus();
    bindRotary(
      $("rot-hyd"),
      0,
      function () {
        return S.hydIdx;
      },
      function (v) {
        S.hydIdx = v;
      },
    );
    bindRotary(
      $("rot-trim"),
      1,
      function () {
        return S.trimIdx;
      },
      function (v) {
        S.trimIdx = v;
      },
    );
    bindWheel();
    bindLever();
    bindGuarded();
    bindWash();
    bindBrake();
    bindButtons();
    bindMaint();
    bindSound();
    bindDialog();

    reset();
    render();
    requestAnimationFrame(frame);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        lastT = null;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: apiState,
    tick: tick,
    inject: inject,
    reset: reset,
  };
})();
