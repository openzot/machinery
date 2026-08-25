/*
 * Corvedale Transport Board — 1973 Stock Driving Console.
 * Merrowgate Deep Line loop: 9.6 km, eight stations, 630 V DC.
 *
 * One deterministic simulation, fixed 50 ms sub-steps, driven by tick().
 * The animation loop feeds it real elapsed time; the probe feeds it whole
 * seconds. Nothing reads the wall clock inside the model.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------ */
  /* Line geometry and rolling stock constants                     */
  /* ------------------------------------------------------------ */

  var LOOP_M = 9600;
  var STATION_COUNT = 8;
  var STATION_SPACING = LOOP_M / STATION_COUNT; // 1200 m
  var PLATFORM_HALF = 55; // m either side of the centre: doors may open here
  var SIGNAL_SPACING = 600;
  var GHOST_SPEED = 8.4; // the service ahead of us, m/s

  var STATION_NAMES = [
    "MERROWGATE",
    "TANNERS END",
    "RIVERGATE",
    "OLD QUAY",
    "WINDMILL LANE",
    "CHARNWICK",
    "DEEPDENE",
    "HALVERSTON",
  ];

  var NOTCHES = [
    "P4",
    "P3",
    "P2",
    "P1",
    "OFF",
    "B1",
    "B2",
    "B3",
    "B4",
    "B5",
    "B6",
    "EM",
  ];
  var OFF = 4; // index of OFF in NOTCHES

  var TRACTION_AMPS = [380, 300, 210, 120]; // P4..P1
  var TRACTION_KN = [205, 160, 110, 60];
  var BRAKE_KN = [40, 70, 100, 130, 160, 190]; // B1..B6
  var EMERGENCY_KN = 265;

  var MASS_TARE = 132; // tonnes, four cars
  var LINE_LIMIT = 45; // mph
  var OVERSPEED_WARN = 47;
  var ALARM_OVERSPEED = 50;

  var RES_MAX = 100;
  var RES_CUT_IN = 84;
  var RES_CUT_OUT = 100;
  var RES_ALARM = 62;
  var RES_FAIL = 38;

  var STEP = 0.05; // fixed physics sub-step, seconds
  var tickAccumulator = 0;

  var KMH_PER_MS = 3.6;
  var MPH_PER_MS = 2.23694;

  /* ------------------------------------------------------------ */
  /* Small helpers                                                 */
  /* ------------------------------------------------------------ */

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function hash1(n) {
    // deterministic 0..1 from an integer
    var s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function mod(a, n) {
    return ((a % n) + n) % n;
  }

  function stationAt(s) {
    // nearest station index and signed distance (m, + means ahead)
    var k = Math.round(s / STATION_SPACING);
    var d = s - k * STATION_SPACING;
    return { index: mod(k, STATION_COUNT), dist: d };
  }

  /* ------------------------------------------------------------ */
  /* State                                                         */
  /* ------------------------------------------------------------ */

  var S = null;

  function coldState() {
    return {
      time: 0,
      pos: 0,
      v: 0,
      notchIdx: OFF,
      aux: false,
      res: 78,
      bcy: 0,
      compOn: false,
      doors: "CLOSED", // CLOSED | OPENING | OPEN | CLOSING
      doorTimer: 0,
      selector: "off", // left | off | right
      dwell: 0,
      passengers: 260,
      gripHeld: false,
      heldTime: 0,
      releasedTime: 0,
      demandRelease: false,
      graceTimer: 0,
      deadmanTrip: false,
      deadmanHold: 0,
      tripcock: false,
      leakActive: false,
      interlockBad: false,
      airFail: false,
      alarms: [],
      ackedFor: "",
      buzzerSilenced: false,
      overspeedTime: 0,
      lostSeconds: 0,
      doorOpenCount: 0,
      testLamps: 0,
      selfTest: 0,
      lastSignalCrossed: -1,
    };
  }

  /* ------------------------------------------------------------ */
  /* Alarms bookkeeping                                            */
  /* ------------------------------------------------------------ */

  function raise(list, name) {
    if (list.indexOf(name) === -1) list.push(name);
  }

  function refreshAlarms() {
    var before = S.alarms.join("|");
    var list = [];
    if (S.res < RES_ALARM) raise(list, "LOW MAIN RES");
    if (S.interlockBad && S.doors !== "OPEN") raise(list, "DOOR INTERLOCK");
    else if (S.doors === "OPEN" || S.doors === "CLOSING") {
      /* doors legitimately open at a platform: no alarm */
    }
    if (S.tripcock) raise(list, "TRIPCOCK OPERATED");
    if (S.deadmanTrip) raise(list, "DEAD-MAN");
    if (S.overspeedTime > 3) raise(list, "OVERSPEED");
    S.alarms = list;
    if (list.join("|") !== before) S.buzzerSilenced = false;
  }

  /* ------------------------------------------------------------ */
  /* Physics step                                                  */
  /* ------------------------------------------------------------ */

  function lineVolts() {
    if (!S.aux) return 0;
    var r = 0.22 + 0.16 * hash1(Math.floor(S.pos / 800)); // distance from feeder
    var i = Math.abs(motorAmps()) + (S.compOn ? 42 : 0) + 24; // train heating and lights
    var v = 630 - i * r;
    if (i < 5) v = 628 + 4 * hash1(Math.floor(S.time));
    return clamp(v, 0, 700);
  }

  function motorAmps() {
    var p = OFF - S.notchIdx; // + power, - brake
    var vkmh = S.v * KMH_PER_MS;
    if (p > 0) {
      var base = TRACTION_AMPS[4 - p] || 0;
      var taper = clamp(1.18 - vkmh / 68, 0.18, 1);
      return base * taper * (lineVoltsRaw() / 630);
    }
    if (p < 0) {
      var b = -p; // 1..6
      return -(b * 52);
    }
    return 0;
  }

  function lineVoltsRaw() {
    // voltage without the meter's aux-off zero, for internal arithmetic
    if (!S.aux) return 630;
    var r = 0.22 + 0.16 * hash1(Math.floor(S.pos / 800));
    var i = Math.abs(TRACTION_AMPS[Math.max(OFF - S.notchIdx - 1, 0)] || 0);
    return clamp(630 - i * r * 0.4, 420, 660);
  }

  function tractionEffort() {
    var p = OFF - S.notchIdx;
    if (p <= 0 || S.airFail || S.deadmanTrip || S.tripcock) return 0;
    if (!powerAvailable()) return 0;
    return TRACTION_KN[4 - p] || 0;
  }

  function brakeEffort() {
    var b = S.notchIdx - OFF;
    var e = 0;
    if (b >= 7) e = EMERGENCY_KN;
    else if (b > 0) e = BRAKE_KN[b - 1] || 0;
    if (S.deadmanTrip || S.tripcock || S.airFail) e = EMERGENCY_KN;
    if (S.res < RES_FAIL) e = Math.min(e, 30); // almost no air left
    return e;
  }

  function powerAvailable() {
    if (!S.aux) return false;
    if (S.res < RES_FAIL) return false;
    if (S.doors !== "CLOSED") return false;
    if (S.interlockBad) return false;
    return true;
  }

  function step(h) {
    S.time += h;

    /* ---- dead-man watchdog ---- */
    if (S.aux) {
      if (S.gripHeld) {
        S.graceTimer = 0;
        if (S.demandRelease) {
          if (S.releasedTime > 0.05) {
            /* driver eased off in time */
            S.demandRelease = false;
            S.heldTime = 0;
            S.releasedTime = 0;
          } else {
            S.releasedTime += h;
            S.heldTime += h;
            if (S.releasedTime > 5) escalateDeadman();
          }
        } else {
          S.releasedTime = 0;
          S.heldTime += h;
          if (S.heldTime > 40 && !S.deadmanTrip) S.demandRelease = true;
        }
        if (S.deadmanTrip) {
          S.deadmanHold += h;
          if (S.notchIdx === OFF && S.deadmanHold > 1.2) {
            S.deadmanTrip = false;
            S.demandRelease = false;
            S.heldTime = 0;
            S.deadmanHold = 0;
          }
        }
      } else {
        S.heldTime = 0;
        if (S.demandRelease) {
          S.releasedTime += h;
          if (S.releasedTime > 5) escalateDeadman();
        } else {
          S.graceTimer += h;
          if (S.graceTimer > 6 && !S.deadmanTrip) escalateDeadman();
        }
      }
    } else {
      S.graceTimer = 0;
      S.demandRelease = false;
    }

    /* ---- doors ---- */
    if (S.doors === "OPENING" || S.doors === "CLOSING") {
      S.doorTimer -= h;
      if (S.doorTimer <= 0) {
        S.doors = S.doors === "OPENING" ? "OPEN" : "CLOSED";
        if (S.doors === "OPEN") S.doorOpenCount++;
      }
    }
    if (S.doors === "OPEN") S.dwell += h;
    if (S.doors === "OPEN" && S.dwell > 20) S.lostSeconds += h;

    /* ---- main reservoir ---- */
    if (S.aux) {
      if (!S.compOn && S.res < RES_CUT_IN) S.compOn = true;
      if (S.compOn && S.res >= RES_CUT_OUT) S.compOn = false;
    } else {
      S.compOn = false;
    }
    if (S.compOn) S.res += 3.4 * h;
    var brakeNow = brakeEffort() > 0;
    if (brakeNow) S.res -= 0.55 * h;
    if (S.leakActive && !leakIsolated()) S.res -= 4.2 * h;
    S.res = clamp(S.res, 0, RES_MAX);
    if (S.res < RES_FAIL) S.airFail = true;
    if (S.airFail && S.res > RES_CUT_IN) S.airFail = false;

    /* ---- brake cylinder gauge ---- */
    var b = S.notchIdx - OFF;
    var target = 0;
    if (S.deadmanTrip || S.tripcock || S.airFail) target = 72;
    else if (b >= 7) target = 72;
    else if (b > 0) target = 10 * b;
    if (S.res < RES_FAIL) target = Math.min(target, 12);
    S.bcy += (target - S.bcy) * Math.min(1, 3 * h);

    /* ---- longitudinal dynamics ---- */
    var m = MASS_TARE + S.passengers * 0.075;
    var vk = S.v * KMH_PER_MS;
    var resist = 2.2 + 0.0042 * vk * vk;
    var f = tractionEffort() - brakeEffort() * (S.v > 0.05 ? 1 : 0) - resist;
    if (Math.abs(S.v) < 0.06 && f < 0 && brakeOrResistHolds()) {
      S.v = 0;
    } else {
      S.v += (f / m) * h;
      if (S.v < 0) S.v = 0;
    }
    var prevPos = S.pos;
    S.pos = mod(S.pos + S.v * h, LOOP_M);

    /* ---- signals and the tripcock ---- */
    checkSignals(prevPos, S.pos);

    /* ---- overspeed ---- */
    if (vk > ALARM_OVERSPEED) S.overspeedTime += h;
    else S.overspeedTime = Math.max(0, S.overspeedTime - 2 * h);

    refreshAlarms();
  }

  function brakeOrResistHolds() {
    return brakeEffort() > 0 || S.notchIdx === OFF;
  }

  function escalateDeadman() {
    S.deadmanTrip = true;
    S.deadmanHold = 0;
    S.demandRelease = false;
    S.releasedTime = 0;
    S.heldTime = 0;
    S.graceTimer = 0;
    S.lostSeconds += 60;
  }

  function signalAspect(x, ghost) {
    var g = mod(ghost - x, LOOP_M); // how far ahead of the signal the ghost is
    if (g < SIGNAL_SPACING) return "RED";
    if (g < 2 * SIGNAL_SPACING) return "AMBER";
    return "GREEN";
  }

  function checkSignals(a, b) {
    // crossing any signal between a and b?
    var first = Math.ceil(Math.min(a, b) / SIGNAL_SPACING);
    var last = Math.floor(Math.max(a, b) / SIGNAL_SPACING);
    for (var k = first; k <= last; k++) {
      var x = k * SIGNAL_SPACING;
      if (x === a) continue;
      var ghost = mod(GHOST_SPEED * S.time + 3200, LOOP_M);
      if (signalAspect(mod(x, LOOP_M), ghost) === "RED" && S.v > 0.75) {
        applyTripcock();
        return;
      }
    }
  }

  function applyTripcock() {
    if (!S.tripcock) {
      S.tripcock = true;
      S.lostSeconds += 120;
    }
  }

  function leakIsolated() {
    return cockShut;
  }

  var cockShut = false;

  /* ------------------------------------------------------------ */
  /* Public API                                                    */
  /* ------------------------------------------------------------ */

  var FAULTS = [
    "main reservoir leak",
    "door interlock failure",
    "trainstop trip (SPAD)",
  ];

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f.indexOf("reservoir") !== -1 || f.indexOf("leak") !== -1) {
      S.leakActive = true;
    } else if (f.indexOf("interlock") !== -1) {
      S.interlockBad = true;
      refreshAlarms();
    } else if (f.indexOf("trip") !== -1 || f.indexOf("spad") !== -1) {
      applyTripcock();
      refreshAlarms();
    }
  }

  function reset() {
    S = coldState();
    tickAccumulator = 0;
    cockShut = false;
    syncTestSwitches();
    setSelector("off", true);
    setNotch(OFF, true);
    updateAuxInput();
    buildTicks();
    draw();
    syncDom(true);
  }

  var api = {
    name: "Corvedale 1973 Stock - Driving Console",
    faults: FAULTS.slice(),
    state: function () {
      return {
        speed_mph: +(S.v * MPH_PER_MS).toFixed(3),
        speed_kmh: +(S.v * KMH_PER_MS).toFixed(3),
        position_km: +(S.pos / 1000).toFixed(4),
        controller_notch: NOTCHES[S.notchIdx],
        brake_cylinder_psi: +S.bcy.toFixed(1),
        main_reservoir_psi: +S.res.toFixed(1),
        line_volts: +lineVolts().toFixed(1),
        motor_amps: +motorAmps().toFixed(1),
        compressor_on: S.compOn,
        doors: S.doors,
        door_selector: S.selector,
        at_platform: Math.abs(stationAt(S.pos).dist) < PLATFORM_HALF,
        next_signal: nextAspectAhead(),
        deadman_held: S.gripHeld,
        deadman_demand: S.demandRelease,
        tripcock_operated: S.tripcock,
        air_failure: S.airFail,
        faults_active: [
          S.leakActive ? "main reservoir leak" : "",
          S.interlockBad ? "door interlock failure" : "",
          S.tripcock ? "trainstop trip (SPAD)" : "",
        ].filter(Boolean),
        time_lost_min: Math.floor(S.lostSeconds / 60),
        alarms: S.alarms.slice(),
      };
    },
    tick: function (seconds) {
      var t = Number(seconds) || 0;
      tickAccumulator += t;
      var steps = Math.min(40000, Math.floor(tickAccumulator / STEP));
      var i;
      for (i = 0; i < steps; i++) step(STEP);
      tickAccumulator -= steps * STEP;
      if (!(tickAccumulator >= 0)) tickAccumulator = 0;
    },
    inject: inject,
    reset: reset,
  };

  window.machine = api;

  function nextAspectAhead() {
    var ghost = mod(GHOST_SPEED * S.time + 3200, LOOP_M);
    var nx = (Math.floor(S.pos / SIGNAL_SPACING) + 1) * SIGNAL_SPACING;
    return signalAspect(mod(nx, LOOP_M), ghost);
  }

  /* ------------------------------------------------------------ */
  /* DOM wiring                                                    */
  /* ------------------------------------------------------------ */

  var $ = function (id) {
    return document.getElementById(id);
  };

  var el = {
    handle: $("handle"),
    detents: $("detents"),
    quadrant: document.querySelector("#controller .quadrant"),
    grip: $("grip"),
    gripLamp: $("grip-lamp"),
    rotKnob: $("rot-knob"),
    doorSelect: $("door-select"),
    doorOpen: $("door-open"),
    doorClose: $("door-close"),
    aux: $("aux"),
    accept: $("accept"),
    lampstest: $("lampstest"),
    tripGuard: $("trip-guard"),
    tripReset: $("trip-reset"),
    tripWrap: $("trip-reset-wrap"),
    bay: $("bay"),
    bayCover: $("bay-cover"),
    bayInner: $("bay-inner"),
    ftLeak: $("ft-leak"),
    ftInterlock: $("ft-interlock"),
    ftTrip: $("ft-trip"),
    cock: $("leak-cock"),
    deskReset: $("desk-reset"),
    sound: $("sound-toggle"),
    late: $("late-min"),
    spdKmh: $("spd-kmh"),
    anns: {},
    needles: {
      res: $("n-res"),
      bcy: $("n-bcy"),
      volts: $("n-volts"),
      amps: $("n-amps"),
      spd: $("n-spd"),
    },
  };

  Array.prototype.forEach.call(document.querySelectorAll(".ann"), function (a) {
    el.anns[a.getAttribute("data-ann")] = a;
  });

  /* ---- gauge tick construction (art in code) ---- */

  function polar(cx, cy, r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function buildDial(
    gauge,
    nums,
    min,
    max,
    majorEvery,
    cx,
    cy,
    r0,
    r1,
    labels,
  ) {
    var gT = document.querySelector('[data-gauge="' + gauge + '"]');
    var gN = document.querySelector('[data-gauge="' + nums + '"]');
    if (!gT) return;
    var svgNS = "http://www.w3.org/2000/svg";
    for (var v = min; v <= max; v += majorEvery) {
      var frac = (v - min) / (max - min);
      var deg = -120 + 240 * frac;
      var p1 = polar(cx, cy, r1, deg);
      var p2 = polar(cx, cy, r1 - (labels ? 8 : 5), deg);
      var ln = document.createElementNS(svgNS, "line");
      ln.setAttribute("x1", p1[0].toFixed(1));
      ln.setAttribute("y1", p1[1].toFixed(1));
      ln.setAttribute("x2", p2[0].toFixed(1));
      ln.setAttribute("y2", p2[1].toFixed(1));
      gT.appendChild(ln);
      if (labels && gN) {
        var pl = polar(cx, cy, r1 - 15, deg);
        var tx = document.createElementNS(svgNS, "text");
        tx.setAttribute("x", pl[0].toFixed(1));
        tx.setAttribute("y", (pl[1] + 3).toFixed(1));
        tx.textContent = typeof labels === "function" ? labels(v) : v;
        gN.appendChild(tx);
      }
    }
  }

  function buildSpeedoExtras() {
    var svgNS = "http://www.w3.org/2000/svg";
    var arc = document.querySelector('[data-gauge="spd-limit"]');
    var mark = document.querySelector('[data-gauge="spd-mark"]');
    if (!arc) return;
    var cx = 100,
      cy = 72,
      r = 44;
    var a1 = -120 + 240 * (LINE_LIMIT / 60);
    var d =
      "M " +
      polar(cx, cy, r, a1).join(" ") +
      " A " +
      r +
      " " +
      r +
      " 0 0 1 " +
      polar(cx, cy, r, 120).join(" ");
    arc.setAttribute("d", d);
    var p1 = polar(cx, cy, 48, a1);
    var p2 = polar(cx, cy, 38, a1);
    var ln = document.createElementNS(svgNS, "line");
    ln.setAttribute("x1", p1[0]);
    ln.setAttribute("y1", p1[1] + 20);
    ln.setAttribute("x2", p2[0]);
    ln.setAttribute("y2", p2[1] + 20);
    mark.appendChild(ln);
    var tx = document.createElementNS(svgNS, "text");
    var pt = polar(cx, cy, 33, a1);
    tx.setAttribute("x", pt[0] + 2);
    tx.setAttribute("y", pt[1] + 22);
    tx.textContent = "LIMIT";
    mark.appendChild(tx);
  }

  function buildTicks() {
    buildDial("res", "res-nums", 0, 120, 20, 50, 54, 0, 38, true);
    buildDial("bcy", "bcy-nums", 0, 80, 20, 50, 54, 0, 38, true);
    buildDial("volts", "volts-nums", 0, 750, 250, 50, 54, 0, 38, function (v) {
      return v === 0 ? "" : v;
    });
    buildDial("amps", "amps-nums", -450, 450, 225, 50, 54, 0, 38, function (v) {
      return v === 0 ? "0" : Math.abs(v) / 75;
    });
    buildDial("spd", "spd-nums", 0, 60, 10, 100, 72, 0, 46, true);
    buildSpeedoExtras();
  }

  function setNeedle(node, frac) {
    if (!node) return;
    node.style.transform =
      "rotate(" + (-120 + 240 * clamp(frac, -0.02, 1.02)) + "deg)";
  }

  /* ---- controller ---- */

  function setNotch(idx, skipDom) {
    S.notchIdx = clamp(idx, 0, NOTCHES.length - 1);
    if (skipDom) return syncControllerDom();
    syncControllerDom();
  }

  function syncControllerDom() {
    var frac = 1 - S.notchIdx / (NOTCHES.length - 1); // top = full power
    el.handle.style.top = 8 + frac * 84 + "%";
    el.handle.setAttribute("aria-valuemin", String(-7));
    el.handle.setAttribute("aria-valuemax", String(4));
    el.handle.setAttribute(
      "aria-valuenow",
      String(NOTCHES.length - 1 === 0 ? 0 : S.notchIdx - OFF),
    );
    el.handle.setAttribute("aria-valuetext", NOTCHES[S.notchIdx]);
    Array.prototype.forEach.call(el.detents.children, function (li, i) {
      li.firstChild.classList.toggle("on", i === S.notchIdx);
    });
  }

  function buildDetents() {
    el.detents.innerHTML = "";
    NOTCHES.forEach(function (n, i) {
      var li = document.createElement("li");
      var flavour =
        n === "EM"
          ? "emergency"
          : n.charAt(0) === "P"
            ? "power"
            : n.charAt(0) === "B"
              ? "brake"
              : "off";
      li.setAttribute("data-flav", flavour);
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = n;
      b.setAttribute("aria-label", "controller to " + n);
      b.addEventListener("click", function () {
        setNotch(i);
      });
      li.appendChild(b);
      el.detents.appendChild(li);
    });
  }

  /* pointer drag on the controller quadrant */
  function dragHandle(e) {
    var r = el.quadrant.getBoundingClientRect();
    var y = (e.clientY !== undefined ? e.clientY : 0) - r.top;
    var frac = clamp(y / r.height, 0, 1);
    setNotch(Math.round((1 - frac) * (NOTCHES.length - 1)));
  }

  /* ---- door selector ---- */

  function setSelector(pos, skipEvent) {
    S.selector = pos;
    el.rotKnob.setAttribute("data-pos", pos);
    Array.prototype.forEach.call(
      el.doorSelect.querySelectorAll(".stop"),
      function (b) {
        b.setAttribute(
          "aria-pressed",
          String(b.getAttribute("data-pos") === pos),
        );
      },
    );
    if (!skipEvent) doorSelectorChanged();
  }

  function doorSelectorChanged() {
    /* moving the selector away from OFF with doors open shuts them first */
    if (S.doors === "OPEN") closeDoors();
  }

  function requestOpen() {
    if (S.selector === "off") return buzzOnce();
    if (Math.abs(stationAt(S.pos).dist) > PLATFORM_HALF) return buzzOnce();
    if (S.v * KMH_PER_MS > 0.4) return buzzOnce();
    if (S.doors === "CLOSED") {
      S.doors = "OPENING";
      S.doorTimer = 2;
      S.dwell = 0;
      hiss();
    }
  }

  function closeDoors() {
    if (S.doors === "OPEN") {
      S.doors = "CLOSING";
      S.doorTimer = 2;
      hiss();
    }
    /* recycling against a failed proving circuit re-seats it */
    if (S.interlockBad && S.doors === "CLOSED") {
      S.interlockBad = false;
      syncTestSwitches();
      refreshAlarms();
    }
  }

  /* ---- switches, keys, cover ---- */

  function syncTestSwitches() {
    el.ftLeak.checked = S.leakActive;
    el.ftInterlock.checked = S.interlockBad;
    el.ftTrip.checked = S.tripcock;
  }

  function updateAuxInput() {
    el.aux.checked = S.aux;
  }

  /* ---- annunciators ---- */

  function paintAnns() {
    var st = {
      "doors-closed": S.doors === "CLOSED" ? "green" : "",
      interlock:
        S.interlockBad && S.doors !== "OPEN"
          ? "red blink"
          : S.doors === "CLOSED"
            ? ""
            : "amber",
      compressor: S.compOn ? "amber" : "",
      linelow: S.aux && lineVolts() < 430 ? "amber" : "",
      overspeed: S.overspeedTime > 0.4 ? "amber blink" : "",
      lowair: S.res < RES_ALARM ? "red" : "",
      deadman: S.deadmanTrip
        ? "red blink"
        : S.demandRelease || (!S.gripHeld && S.aux)
          ? "amber blink"
          : "",
      tripcock: S.tripcock ? "red blink" : "",
    };
    Object.keys(st).forEach(function (k) {
      var node = el.anns[k];
      if (!node) return;
      node.className = "ann" + (st[k] ? " lit-" + st[k].split(" ")[0] : "");
      if (st[k].indexOf("blink") !== -1) node.className += " blink";
    });
    if (S.testLamps > 0 || S.selfTest > 0) {
      Object.keys(el.anns).forEach(function (k) {
        var c =
          k === "doors-closed"
            ? "lit-green"
            : k === "interlock" ||
                k === "linelow" ||
                k === "compressor" ||
                k === "deadman" ||
                k === "overspeed"
              ? "lit-amber"
              : "lit-red";
        el.anns[k].className = "ann " + c;
      });
    }
  }

  /* ---- buzzer & sound ---- */

  var audio = {
    ctx: null,
    master: null,
    traction: null,
    tractionGain: null,
    compGain: null,
    buzzerOsc: null,
    buzzerGain: null,
    enabled: false,
    phase: 0,
  };

  function initAudio() {
    if (audio.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = new AC();
    var master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    var tOsc = ctx.createOscillator();
    tOsc.type = "sawtooth";
    tOsc.frequency.value = 50;
    var tFilt = ctx.createBiquadFilter();
    tFilt.type = "lowpass";
    tFilt.frequency.value = 420;
    var tGain = ctx.createGain();
    tGain.gain.value = 0;
    tOsc.connect(tFilt).connect(tGain).connect(master);
    tOsc.start();

    var buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    var noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    var nf = ctx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = 900;
    nf.Q.value = 1.4;
    var nGain = ctx.createGain();
    nGain.gain.value = 0;
    noise.connect(nf).connect(nGain).connect(master);
    noise.start();

    var bz = ctx.createOscillator();
    bz.type = "square";
    bz.frequency.value = 520;
    var bg = ctx.createGain();
    bg.gain.value = 0;
    bz.connect(bg).connect(master);
    bz.start();

    audio.ctx = ctx;
    audio.master = master;
    audio.traction = tOsc;
    audio.tractionGain = tGain;
    audio.compGain = nGain;
    audio.noiseBuf = buf;
    audio.buzzerOsc = bz;
    audio.buzzerGain = bg;
  }

  function setSound(on) {
    initAudio();
    audio.enabled = on;
    el.sound.setAttribute("aria-checked", String(on));
    el.sound.setAttribute("aria-label", "cab speaker: " + (on ? "on" : "off"));
    if (audio.master && audio.ctx) {
      if (audio.ctx.state === "suspended") audio.ctx.resume();
      audio.master.gain.setTargetAtTime(
        on ? 0.32 : 0,
        audio.ctx.currentTime,
        0.08,
      );
    }
  }

  function hiss() {
    if (!audio.enabled || !audio.ctx) return;
    var ctx = audio.ctx;
    var src = ctx.createBufferSource();
    src.buffer = audio.noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 1400;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.4);
    src.connect(f).connect(g).connect(audio.master);
    src.start();
    src.stop(ctx.currentTime + 1.5);
  }

  function clunk() {
    if (!audio.enabled || !audio.ctx) return;
    var ctx = audio.ctx;
    var o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(90, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(34, ctx.currentTime + 0.18);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.9, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g).connect(audio.master);
    o.start();
    o.stop(ctx.currentTime + 0.32);
  }

  function buzzOnce() {
    if (!audio.enabled || !audio.ctx) return;
    audio.buzzerGain.gain.cancelScheduledValues(audio.ctx.currentTime);
    audio.buzzerGain.gain.setValueAtTime(0.18, audio.ctx.currentTime);
    audio.buzzerGain.gain.setTargetAtTime(
      0,
      audio.ctx.currentTime + 0.16,
      0.04,
    );
  }

  function driveSound() {
    if (!audio.ctx || !audio.enabled) return;
    var vk = S.v * KMH_PER_MS;
    var amp = Math.abs(motorAmps());
    var f = 42 + vk * 2.6;
    audio.traction.frequency.setTargetAtTime(f, audio.ctx.currentTime, 0.08);
    audio.tractionGain.gain.setTargetAtTime(
      clamp(amp / 900, 0, 0.34),
      audio.ctx.currentTime,
      0.1,
    );
    audio.compGain.gain.setTargetAtTime(
      S.compOn ? 0.14 : 0,
      audio.ctx.currentTime,
      0.15,
    );
    var alarming =
      S.alarms.length > 0 ||
      S.demandRelease ||
      (!S.gripHeld && S.aux && !S.deadmanTrip) ||
      S.overspeedTime > 0.4;
    var gate = alarming && !S.buzzerSilenced;
    audio.buzzerGain.gain.setTargetAtTime(
      gate ? (Math.floor(S.time * 2.4) % 2 === 0 ? 0.09 : 0.0001) : 0,
      audio.ctx.currentTime,
      0.02,
    );
  }

  /* ---- canvas scenery ---- */

  var cv = $("view");
  var cx2d = cv.getContext("2d");
  var CW = cv.width;
  var HORIZON = 92; // eye line of the tunnel bore, in canvas pixels
  var CH = cv.height;

  /* ---- canvas scenery: a real bore, projected ---- */

  var FOCAL = 330; // pixel-metres
  var EYE_M = 1.85; // driver's eye above railhead, metres
  var vpXCur = CW / 2;

  function px(m) {
    return FOCAL / Math.max(m, 0.35);
  }

  function py(m) {
    return HORIZON + (EYE_M * FOCAL) / Math.max(m, 0.35);
  }

  function drawScenery() {
    var g = cx2d;
    var vk = S.v * KMH_PER_MS;
    g.clearRect(0, 0, CW, CH);

    vpXCur = CW / 2 + Math.sin(S.time * 0.9) * clamp(vk / 40, 0, 1) * 2.2;

    /* the deep dark of the bore */
    var bg = g.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, "#07080c");
    bg.addColorStop(0.42, "#0c0e13");
    bg.addColorStop(1, "#040404");
    g.fillStyle = bg;
    g.fillRect(0, 0, CW, CH);

    /* haze where the tunnel swallows the light */
    var haze = g.createRadialGradient(vpXCur, HORIZON, 3, vpXCur, HORIZON, 230);
    haze.addColorStop(0, "rgba(148,144,128,0.22)");
    haze.addColorStop(1, "rgba(148,144,128,0)");
    g.fillStyle = haze;
    g.fillRect(0, 0, CW, CH);

    /* concrete ring ribs marching past */
    for (var i = 26; i >= 1; i--) {
      var m = i * 2.6 + mod(S.pos, 2.6);
      var k = px(m);
      var rx = k * 2.75;
      var ry = k * 2.45;
      if (rx < 5) break;
      if (rx > CW * 1.6) continue;
      var shade = clamp(10 + (i / 26) * 34, 8, 46);
      g.strokeStyle =
        "rgba(" + (shade + 6) + "," + (shade + 7) + "," + (shade + 12) + ",1)";
      g.lineWidth = clamp(k * 0.16, 0.7, 7);
      g.beginPath();
      g.ellipse(vpXCur, HORIZON - ry * 0.16, rx, ry, 0, 0, Math.PI * 2);
      g.stroke();
    }

    /* cable run on the right-hand wall */
    g.strokeStyle = "#23252c";
    for (var c = 0; c < 3; c++) {
      g.beginPath();
      var first = true;
      for (var mm = 2.4; mm < 130; mm *= 1.13) {
        var latC = 2.62 + c * 0.14;
        var xC = vpXCur + latC * px(mm);
        var yC = HORIZON + (EYE_M - 2.05 + c * 0.16) * px(mm);
        if (first) {
          g.moveTo(xC, yC);
          first = false;
        } else g.lineTo(xC, yC);
      }
      g.lineWidth = 1.6;
      g.stroke();
    }

    /* trackbed */
    var mN = 2.1,
      mF = 150;
    g.fillStyle = "#131110";
    g.beginPath();
    g.moveTo(vpXCur - 3.6 * px(mN), py(mN));
    g.lineTo(vpXCur - 3.6 * px(mF), py(mF));
    g.lineTo(vpXCur + 4.6 * px(mF), py(mF));
    g.lineTo(vpXCur + 4.6 * px(mN), py(mN));
    g.closePath();
    g.fill();

    /* sleepers */
    for (var sm = 2.15; sm < 70; sm += 0.65) {
      var hw = 1.28 * px(sm);
      var yy = py(sm);
      if (yy < HORIZON + 2 || yy > CH + 30) continue;
      var th = clamp(px(sm) * 0.24, 1, 14);
      var fade = clamp(1.15 - sm / 60, 0.06, 0.85);
      g.fillStyle = "rgba(66,55,40," + fade.toFixed(3) + ")";
      g.fillRect(vpXCur - hw, yy, hw * 2, th);
    }

    /* the four-foot: light from our own shoe gear */
    if (S.aux) {
      var gl = g.createLinearGradient(0, HORIZON, 0, CH);
      gl.addColorStop(0, "rgba(216,198,120,0)");
      gl.addColorStop(1, "rgba(216,198,120,0.07)");
      g.fillStyle = gl;
      g.beginPath();
      g.moveTo(vpXCur - 0.8 * px(mN), CH);
      g.lineTo(vpXCur - 0.8 * px(mF), py(mF));
      g.lineTo(vpXCur + 0.8 * px(mF), py(mF));
      g.lineTo(vpXCur + 0.8 * px(mN), CH);
      g.closePath();
      g.fill();
    }

    /* running rails — left-hand running, we ride the left pair */
    railLine(g, -0.74);
    railLine(g, 0.74);
    /* the far road, mostly swallowed by the wall */
    railLine(g, 2.9, true);
    railLine(g, 4.35, true);

    /* station on the LEFT */
    var near = stationAt(S.pos);
    if (Math.abs(near.dist) < 430) drawStation(g, near);

    /* signals on the RIGHT */
    drawSignals(g);

    /* the service ahead */
    var ghost = mod(GHOST_SPEED * S.time + 3200, LOOP_M);
    var gap = mod(ghost - S.pos, LOOP_M);
    if (gap > 6 && gap < 340) drawGhostTrain(g, gap);

    /* speed streaks across the glass */
    if (vk > 32) {
      g.strokeStyle =
        "rgba(210,212,222," + clamp((vk - 32) / 240, 0, 0.15) + ")";
      g.lineWidth = 1;
      for (var st = 0; st < 8; st++) {
        var sy = 14 + hash1(st * 17) * (HORIZON - 10);
        var sx = hash1(st * 31) * CW;
        var ln = vk * 0.85;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx - ln, sy);
        g.stroke();
      }
    }

    /* glass grime */
    var vg = g.createRadialGradient(
      CW / 2,
      CH * 0.52,
      CH * 0.3,
      CW / 2,
      CH * 0.52,
      CH * 1.02,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.5)");
    g.fillStyle = vg;
    g.fillRect(0, 0, CW, CH);
  }

  function railLine(g, lat, faint) {
    var g2 = cx2d;
    var prev = null;
    for (var m = 2.05; m < 150; m *= 1.09) {
      var x = vpXCur + lat * px(m);
      var y = py(m);
      if (prev) {
        var w = clamp((px(m) / FOCAL) * 26, faint ? 0.4 : 0.8, faint ? 2 : 6);
        g2.strokeStyle = faint ? "rgba(90,88,84,0.28)" : "#78746a";
        g2.lineWidth = w;
        g2.beginPath();
        g2.moveTo(prev[0], prev[1]);
        g2.lineTo(x, y);
        g2.stroke();
        if (!faint) {
          g2.strokeStyle = "rgba(214,206,184,0.32)";
          g2.lineWidth = Math.max(0.5, w * 0.3);
          g2.beginPath();
          g2.moveTo(prev[0] - w * 0.22, prev[1]);
          g2.lineTo(x - w * 0.22, y);
          g2.stroke();
        }
      }
      prev = [x, y];
    }
  }

  function drawStation(g, near) {
    var name = STATION_NAMES[near.index];
    var mL = 2.7,
      mR = 58;

    function xw(m) {
      return vpXCur - 3.25 * px(m);
    }
    /* height h metres above railhead at depth m */
    function yh(m, h) {
      return HORIZON + (EYE_M - h) * px(m);
    }

    function wallQuad(hTop, hBot, a, b) {
      g.beginPath();
      g.moveTo(xw(a), yh(a, hTop));
      g.lineTo(xw(b), yh(b, hTop));
      g.lineTo(xw(b), yh(b, hBot));
      g.lineTo(xw(a), yh(a, hBot));
      g.closePath();
    }

    g.save();
    wallQuad(3.05, -0.2, mL, mR);
    g.clip();

    /* tiled wall face */
    var tileM = 1.05;
    for (var tm = mL; tm < mR; tm += tileM) {
      var tn = Math.round(tm / tileM);
      var xa = xw(tm),
        xb = xw(tm + tileM);
      var steps = 10;
      for (var ci = 0; ci < steps; ci++) {
        var tt = hash1(tn * 61 + ci * 13 + near.index * 97);
        g.fillStyle = tt > 0.94 ? "#33404f" : tt > 0.5 ? "#242e39" : "#1d2631";
        var hA = 3.02 - (ci / steps) * 3.2;
        var hB = 3.02 - ((ci + 1) / steps) * 3.2;
        g.beginPath();
        g.moveTo(xa, yh(tm, hA));
        g.lineTo(xb, yh(tm + tileM, hA));
        g.lineTo(xb, yh(tm + tileM, hB));
        g.lineTo(xa, yh(tm, hB));
        g.closePath();
        g.fill();
      }
    }

    /* frieze band in the line colour, correctly converged */
    wallQuad(2.62, 2.18, mL, mR);
    g.fillStyle = "#1c3f94";
    g.fill();
    g.fillStyle = "rgba(236,229,210,0.85)";
    wallQuad(2.66, 2.6, mL, mR);
    g.fill();
    wallQuad(2.2, 2.14, mL, mR);
    g.fill();

    /* platform deck */
    wallQuad(0.98, -0.2, mL, mR);
    g.fillStyle = "#232830";
    g.fill();
    /* cream safety edge */
    wallQuad(1.06, 0.94, mL, mR);
    g.fillStyle = "rgba(236,229,210,0.85)";
    g.fill();

    /* warm lamps down the wall */
    for (var li = 0; li < 8; li++) {
      var lm = 3.5 + li * 7.5 - mod(near.dist + 430, 7.5);
      if (lm < mL || lm > mR) continue;
      var lx = xw(lm) + 0.12 * px(lm);
      var ly = yh(lm, 2.85);
      var rr = clamp(px(lm) * 0.42, 1.5, 18);
      var lg = g.createRadialGradient(lx, ly, 0, lx, ly, rr * 3.2);
      lg.addColorStop(0, "rgba(255,216,142,0.95)");
      lg.addColorStop(0.4, "rgba(255,216,142,0.25)");
      lg.addColorStop(1, "rgba(255,216,142,0)");
      g.fillStyle = lg;
      g.beginPath();
      g.arc(lx, ly, rr * 3.2, 0, 6.29);
      g.fill();
      g.fillStyle = "#ffe2ac";
      g.beginPath();
      g.arc(lx, ly, Math.max(rr * 0.32, 0.8), 0, 6.29);
      g.fill();
    }

    /* waiting passengers on the platform edge side */
    for (var pn = 0; pn < 6; pn++) {
      var ph = hash1(pn * 53 + near.index * 29);
      var pm2 = 4 + ph * 44;
      var pxx = xw(pm2) + 0.5 * px(pm2);
      var pfy = yh(pm2, 1.02);
      var hgt = 1.68 * px(pm2);
      var wid = 0.44 * px(pm2);
      if (wid < 1.2) continue;
      g.fillStyle = "#090a0d";
      g.fillRect(pxx - wid / 2, pfy - hgt, wid, hgt);
      g.beginPath();
      g.arc(pxx, pfy - hgt - wid * 0.3, wid * 0.34, 0, 6.29);
      g.fill();
    }

    g.restore();

    /* the station name on the frieze, readable from the road */
    var nm = clamp(6.5 + near.dist * 0.05, 6.5, 30);
    var nx = xw(nm) + 0.9 * px(nm);
    var ny = yh(nm, 2.4);
    var fs = clamp(px(nm) * 0.34, 7, 26);
    g.font = "700 " + fs.toFixed(1) + 'px "Arial Narrow", Arial';
    g.fillStyle = "rgba(240,234,218,0.95)";
    var wide = g.measureText(name).width;
    g.fillText(name, nx - wide / 2, ny + fs * 0.35);
  }

  function drawSignals(g) {
    for (var si = 0; si < 3; si++) {
      var sigNo = Math.floor(S.pos / SIGNAL_SPACING) + 1 + si;
      var sxm = sigNo * SIGNAL_SPACING - S.pos;
      if (sxm < 2.5) continue;
      var aspect = signalAspect(
        mod(sigNo * SIGNAL_SPACING, LOOP_M),
        mod(GHOST_SPEED * S.time + 3200, LOOP_M),
      );
      var base = 2.3;
      var bx = vpXCur + 2.15 * px(sxm);
      var byFoot = py(sxm) - (0.4 - EYE_M) * px(sxm);
      var topY = py(sxm) - (3.4 - EYE_M) * px(sxm);
      g.strokeStyle = "#2c2e2b";
      g.lineWidth = clamp(px(sxm) * 0.09, 1, 7);
      g.beginPath();
      g.moveTo(bx, byFoot);
      g.lineTo(bx, topY);
      g.stroke();

      var headW = clamp(px(sxm) * 0.34, 3, 26);
      var headH = headW * 2.1;
      g.fillStyle = "#15161a";
      g.fillRect(bx - headW / 2, topY - headH, headW, headH);
      g.strokeStyle = "#000";
      g.lineWidth = 1;
      g.strokeRect(bx - headW / 2, topY - headH, headW, headH);

      var lampY = topY - headH * 0.3;
      var col =
        aspect === "RED"
          ? "#ff4433"
          : aspect === "AMBER"
            ? "#ffb21c"
            : "#39e56a";
      var halo = clamp(headW * 2.4, 6, 60);
      var hg = g.createRadialGradient(bx, lampY, 0, bx, lampY, halo);
      hg.addColorStop(0, col);
      hg.addColorStop(0.25, col.replace(")", "") && hexGlow(col));
      hg.addColorStop(1, "rgba(0,0,0,0)");
      g.globalAlpha = 0.85;
      g.fillStyle = hg;
      g.beginPath();
      g.arc(bx, lampY, halo, 0, 6.29);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = col;
      g.beginPath();
      g.arc(bx, lampY, headW * 0.3, 0, 6.29);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.9)";
      g.beginPath();
      g.arc(bx - headW * 0.08, lampY - headW * 0.1, headW * 0.09, 0, 6.29);
      g.fill();

      /* route plate */
      if (headW > 8) {
        g.fillStyle = "#d8d2bf";
        g.font = "700 " + clamp(headW * 0.5, 6, 11) + "px Arial";
        g.fillText(String(sigNo % 100), bx + headW * 0.8, topY - headH * 0.2);
      }
    }
  }

  function hexGlow(hex) {
    var v = parseInt(hex.slice(1), 16);
    return (
      "rgba(" +
      ((v >> 16) & 255) +
      "," +
      ((v >> 8) & 255) +
      "," +
      (v & 255) +
      ",0.5)"
    );
  }

  function drawGhostTrain(g, gap) {
    var mg = gap;
    var xL = vpXCur - 1.18 * px(mg);
    var xR = vpXCur + 1.18 * px(mg);
    var yBot = py(mg);
    var yTop = yBot - (2.9 - EYE_M) * px(mg);
    g.fillStyle = "rgba(16,17,22,0.96)";
    g.beginPath();
    g.moveTo(xL, yBot);
    g.lineTo(xL, yTop + (yBot - yTop) * 0.18);
    g.quadraticCurveTo(
      (xL + xR) / 2,
      yTop - (yBot - yTop) * 0.08,
      xR,
      yTop + (yBot - yTop) * 0.18,
    );
    g.lineTo(xR, yBot);
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(120,124,134,0.35)";
    g.lineWidth = 1;
    g.stroke();

    var ly = yBot - (0.55 - EYE_M) * px(mg);
    var rr = clamp(px(mg) * 0.09, 1, 7);
    for (var s = -1; s <= 1; s += 2) {
      var lx = vpXCur + s * 0.62 * px(mg);
      var rg = g.createRadialGradient(lx, ly, 0, lx, ly, rr * 4);
      rg.addColorStop(0, "rgba(255,60,40,0.95)");
      rg.addColorStop(1, "rgba(255,60,40,0)");
      g.fillStyle = rg;
      g.beginPath();
      g.arc(lx, ly, rr * 4, 0, 6.29);
      g.fill();
      g.fillStyle = "#ff2e20";
      g.beginPath();
      g.arc(lx, ly, rr, 0, 6.29);
      g.fill();
    }
  }

  function draw() {
    drawScenery();
  }

  /* ---- per-frame DOM sync ---- */

  function syncDom(force) {
    var vk = S.v * KMH_PER_MS;
    setNeedle(el.needles.res, S.res / 120);
    setNeedle(el.needles.bcy, S.bcy / 80);
    setNeedle(el.needles.volts, lineVolts() / 750);
    setNeedle(el.needles.amps, (motorAmps() + 450) / 900);
    setNeedle(el.needles.spd, (S.v * MPH_PER_MS) / 60);
    el.spdKmh.textContent = Math.round(vk) + " KM/H";
    el.late.textContent = "+" + Math.floor(S.lostSeconds / 60);

    el.gripLamp.classList.toggle("demand", S.demandRelease && !S.deadmanTrip);
    el.gripLamp.classList.toggle("tripped", S.deadmanTrip);
    el.grip.setAttribute("aria-pressed", String(S.gripHeld));

    el.doorOpen.disabled = S.doors !== "CLOSED";
    el.doorClose.disabled = S.doors === "OPENING";

    el.tripWrap.classList.toggle("armed", S.tripcock);
    el.tripGuard.querySelector("span").textContent = S.tripcock
      ? "TRIPPED"
      : "LIFT";

    paintAnns();
    driveSound();

    var note = $("ws-note");
    var stn = stationAt(S.pos);
    if (Math.abs(stn.dist) < 260) {
      note.textContent = "NOW APPROACHING — " + STATION_NAMES[stn.index];
    } else {
      var nxt =
        STATION_NAMES[(stn.index + (stn.dist > 0 ? 1 : 0)) % STATION_COUNT];
      note.textContent = "NEXT — " + nxt;
    }
  }

  /* ---- events ---- */

  function wire() {
    buildDetents();
    buildTicks();

    /* controller keyboard */
    el.handle.addEventListener("keydown", function (e) {
      var handled = true;
      if (e.key === "ArrowUp" || e.key === "ArrowRight")
        setNotch(S.notchIdx - 1);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft")
        setNotch(S.notchIdx + 1);
      else if (e.key === "Home") setNotch(0);
      else if (e.key === "End") setNotch(NOTCHES.length - 1);
      else handled = false;
      if (handled) e.preventDefault();
    });

    /* controller pointer drag */
    var dragging = false;
    el.quadrant.addEventListener("pointerdown", function (e) {
      dragging = true;
      el.quadrant.setPointerCapture(e.pointerId);
      dragHandle(e);
    });
    el.quadrant.addEventListener("pointermove", function (e) {
      if (dragging) dragHandle(e);
    });
    el.quadrant.addEventListener("pointerup", function () {
      dragging = false;
    });

    /* dead-man grip: hold. Only the hand that took it can give it up —
       working another control must not count as letting go. */
    var gripPointer = null;
    function gripDown(e) {
      e.preventDefault();
      gripPointer = e.pointerId !== undefined ? e.pointerId : "kbd";
      S.gripHeld = true;
    }
    function gripUp(e) {
      var id = e && e.pointerId !== undefined ? e.pointerId : "kbd";
      if (gripPointer === null || id === gripPointer) {
        gripPointer = null;
        S.gripHeld = false;
      }
    }
    el.grip.addEventListener("pointerdown", gripDown);
    window.addEventListener("pointerup", gripUp);
    window.addEventListener("pointercancel", gripUp);
    el.grip.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") gripDown(e);
    });
    el.grip.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") gripUp();
    });
    el.grip.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });

    /* door selector stops */
    Array.prototype.forEach.call(
      el.doorSelect.querySelectorAll(".stop"),
      function (b) {
        b.addEventListener("click", function () {
          setSelector(b.getAttribute("data-pos"));
        });
      },
    );

    el.doorOpen.addEventListener("click", requestOpen);
    el.doorClose.addEventListener("click", closeDoors);

    el.aux.addEventListener("change", function () {
      S.aux = el.aux.checked;
      if (S.aux) {
        S.selfTest = 1.4;
        clunk();
      }
    });

    el.accept.addEventListener("click", function () {
      S.buzzerSilenced = true;
      buzzOnce();
    });

    el.lampstest.addEventListener("click", function () {
      S.testLamps = 1.5;
    });

    el.tripGuard.addEventListener("click", function () {
      el.tripWrap.classList.add("open");
      el.tripGuard.setAttribute("aria-expanded", "true");
      el.tripReset.disabled = false;
      el.tripReset.focus();
    });

    el.tripReset.addEventListener("click", function () {
      if (S.tripcock && S.v * KMH_PER_MS < 0.5) {
        S.tripcock = false;
        el.ftTrip.checked = false;
        clunk();
        refreshAlarms();
      }
    });

    el.bayCover.addEventListener("click", function () {
      var open = el.bay.classList.toggle("open");
      el.bayCover.setAttribute("aria-expanded", String(open));
      el.bayInner.hidden = !open;
    });

    el.ftLeak.addEventListener("change", function () {
      if (el.ftLeak.checked) inject("main reservoir leak");
    });
    el.ftInterlock.addEventListener("change", function () {
      if (el.ftInterlock.checked) inject("door interlock failure");
    });
    el.ftTrip.addEventListener("change", function () {
      if (el.ftTrip.checked) inject("trainstop trip (SPAD)");
    });

    el.cock.addEventListener("click", function () {
      cockShut = !cockShut;
      el.cock.setAttribute("aria-pressed", String(cockShut));
      el.cock.querySelector(".cock-word").textContent = cockShut
        ? "SHUT"
        : "OPEN";
      el.cock.setAttribute(
        "aria-label",
        "leak isolation cock: " + (cockShut ? "shut" : "open"),
      );
    });

    el.deskReset.addEventListener("click", function () {
      reset();
    });

    el.sound.addEventListener("click", function () {
      setSound(el.sound.getAttribute("aria-checked") !== "true");
    });

    /* manual dialog */
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
          dlg.close ? dlg.close() : dlg.removeAttribute("open");
        });
      },
    );
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg)
        dlg.close ? dlg.close() : dlg.removeAttribute("open");
    });

    /* any first gesture primes the audio graph */
    window.addEventListener(
      "pointerdown",
      function () {
        initAudio();
      },
      { once: true },
    );
  }

  /* ---- animation loop ---- */

  var lastTs = 0;

  function frame(ts) {
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (document.hidden) dt = 0;
    dt = clamp(dt, 0, 0.25);
    if (dt > 0) {
      api.tick(dt);
    }
    /* housekeeping timers that belong to the cab, not the railway */
    if (S.testLamps > 0) S.testLamps = Math.max(0, S.testLamps - dt);
    if (S.selfTest > 0) S.selfTest = Math.max(0, S.selfTest - dt);
    draw();
    syncDom(false);
    requestAnimationFrame(frame);
  }

  /* boot: cold, parked at Merrowgate with the desk unpowered */
  reset();
  wire();
  requestAnimationFrame(function (t) {
    lastTs = t;
    requestAnimationFrame(frame);
  });
})();
