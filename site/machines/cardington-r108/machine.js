/* ============================================================
   R.108 BALLAST, TRIM & VALVE BOARD — simulation & behaviour.
   Royal Airship Works, Cardington, 1929. Vanilla script, IIFE,
   exposes window.machine per the factory contract.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- simulation constants ---------------- */

  var FAULT_CELL = "gas cell puncture";
  var FAULT_VALVE = "forward dump valve passing";
  var FAULT_PUMP = "trim pump overload";

  var AL_HEAVY = "STATIC HEAVY";
  var AL_LIGHT = "STATIC LIGHT";
  var AL_TRIM = "TRIM LIMIT";
  var AL_GAS = "GAS PRESSURE";
  var AL_LOW = "BALLAST LOW";
  var AL_PUMP = "PUMP TRIP";
  var AL_GROUND = "GROUND CONTACT";

  var STRUCT_LB = 118000; // car, envelope, crew, oil, stores
  var LB_PER_GAL = 6;
  var FUEL_GAL_MAX = 1800;
  var TANK_MAX = 4000;
  var LIFT_FULL = 135100; // lb at full cells, reference superheat +4F
  var SH_REF = 4;

  var SPEED_TARGET = { SLOW: 26, HALF: 44, FULL: 62 };
  var BURN_GAL_S = { SLOW: 0.01, HALF: 0.016, FULL: 0.024 };

  var SEL_NAMES = ["VENT SHUT", "BOW CELLS", "MIDSHIP CELLS", "STERN CELLS"];

  /* ---------------- simulation state ---------------- */

  var S = {};

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function resetState() {
    S = {
      t: 0,
      altitude: 1500,
      pitch: 0,
      speed: 44,
      fuel: FUEL_GAL_MAX,
      ballastFore: 3200,
      ballastAft: 3200,
      fillFore: 1,
      fillMid: 1,
      fillAft: 1,
      pressFore: 33,
      pressAft: 33,
      superheat: SH_REF,
      elevator: 0, // degrees, -25 .. +25
      order: "HALF",
      answer: "HALF",
      answerAt: 0,
      valveFore: 0, // turns open 0..6
      valveAft: 0,
      selPos: 0, // gas cell selector 0..3
      ventOpen: false,
      guardOpen: false,
      pumpPos: 0, // -1 fore, 0 hold, +1 aft
      puncture: false,
      valvePass: false,
      pumpTripped: false,
      aground: false,
      strained: false,
      strainTime: 0,
      lampTestUntil: -1,
      bellCutAt: -1,
      knownAlarms: {},
    };
  }
  resetState();

  /* ---------------- physics ---------------- */

  function ambientSuperheat(t) {
    // slow diurnal drift of the gas/air temperature difference, deg F
    return 3 + 5 * Math.sin(t / 480);
  }

  function grossLift() {
    var fillAvg = (S.fillFore + S.fillMid + S.fillAft) / 3;
    return LIFT_FULL * fillAvg * (1 + 0.0016 * (S.superheat - SH_REF));
  }

  function weight() {
    return STRUCT_LB + S.fuel * LB_PER_GAL + S.ballastFore + S.ballastAft;
  }

  function heaviness() {
    return weight() - grossLift();
  }

  function tick(seconds) {
    var dt = Number(seconds);
    if (!isFinite(dt) || dt <= 0) return;
    if (dt > 2) dt = 2;
    S.t += dt;

    // superheat drifts with the (simulated) day
    S.superheat += (ambientSuperheat(S.t) - S.superheat) * (dt / 220);

    // engines
    if (S.answer !== S.order && S.t >= S.answerAt) S.answer = S.order;
    if (S.fuel > 0) S.fuel = Math.max(0, S.fuel - BURN_GAL_S[S.order] * dt);
    var tgtSpeed = S.aground ? 6 : S.fuel <= 0 ? 8 : SPEED_TARGET[S.order];
    S.speed += (tgtSpeed - S.speed) * (dt / 14);

    // ballast: dumps, the passing valve, the trim pump
    var flowF = S.valveFore * 55;
    var flowA = S.valveAft * 55;
    if (S.valvePass) flowF += 26;
    S.ballastFore = clamp(S.ballastFore - flowF * dt, 0, TANK_MAX);
    S.ballastAft = clamp(S.ballastAft - flowA * dt, 0, TANK_MAX);
    if (S.pumpPos !== 0 && !S.pumpTripped) {
      var moved = 90 * dt;
      if (S.pumpPos < 0) {
        var toFore = Math.min(moved, S.ballastAft, TANK_MAX - S.ballastFore);
        S.ballastFore += toFore;
        S.ballastAft -= toFore;
      } else {
        var toAft = Math.min(moved, S.ballastFore, TANK_MAX - S.ballastAft);
        S.ballastAft += toAft;
        S.ballastFore -= toAft;
      }
    }

    // valving gas: permanent loss of lift
    if (S.ventOpen && S.selPos !== 0) {
      var rate = 0.0009;
      if (S.selPos === 1) S.fillFore = Math.max(0, S.fillFore - rate * dt);
      else if (S.selPos === 3) S.fillAft = Math.max(0, S.fillAft - rate * dt);
      else {
        S.fillFore = Math.max(0, S.fillFore - rate * 0.5 * dt);
        S.fillMid = Math.max(0, S.fillMid - rate * dt);
        S.fillAft = Math.max(0, S.fillAft - rate * 0.5 * dt);
      }
    }

    // cell puncture bleeds gauge pressure fast, lift slowly
    if (S.puncture) {
      S.pressFore = Math.max(3, S.pressFore - 2 * dt);
      S.fillFore = Math.max(0, S.fillFore - 0.00035 * dt);
    } else {
      S.pressFore += (10 + S.fillFore * 24 - S.pressFore) * (dt / 30);
    }
    S.pressAft +=
      (10 + ((S.fillMid + S.fillAft) / 2) * 24 - S.pressAft) * (dt / 30);
    S.pressFore = clamp(
      S.pressFore + (S.pressAft - S.pressFore) * (dt / 200),
      0,
      50,
    );
    S.pressAft = clamp(
      S.pressAft + (S.pressFore - S.pressAft) * (dt / 200),
      0,
      50,
    );

    // static condition drives altitude
    var h = heaviness();
    var sink = clamp(-h * 0.0042, -40, 40);
    S.altitude = clamp(S.altitude + sink * dt, 0, 4000);
    if (S.altitude <= 0 && h >= 0 && !S.aground) {
      S.aground = true;
      ringFor(AL_GROUND);
    }

    // pitch: tank split, gas distribution, elevator authority
    var trim =
      ((S.ballastAft - S.ballastFore) / 8000) * 10 +
      (S.fillAft - S.fillFore) * 3 +
      S.elevator * 0.36 * (S.speed / 45);
    var tgtPitch = clamp(trim, -13, 13);
    S.pitch += (tgtPitch - S.pitch) * (dt / 5);
    if (Math.abs(S.pitch) > 5.5) {
      S.strainTime += dt;
      if (S.strainTime > 25 && !S.strained) {
        S.strained = true;
        ringFor(AL_TRIM);
      }
    } else {
      S.strainTime = Math.max(0, S.strainTime - dt * 0.5);
    }
    if (S.aground || S.strained) S.pitch *= 1 - dt / 3;

    if (S.lampTestUntil >= 0 && S.t > S.lampTestUntil) S.lampTestUntil = -1;
  }

  /* ---------------- alarms ---------------- */

  function activeAlarms() {
    var a = [];
    var h = heaviness();
    if (h > 700) a.push(AL_HEAVY);
    if (h < -700) a.push(AL_LIGHT);
    if (Math.abs(S.pitch) > 5.5) a.push(AL_TRIM);
    if (S.pressFore < 22 || S.pressAft < 22) a.push(AL_GAS);
    if (S.ballastFore + S.ballastAft < 900) a.push(AL_LOW);
    if (S.pumpTripped) a.push(AL_PUMP);
    if (S.aground || S.strained) a.push(AL_GROUND);
    return a;
  }

  function ringFor(name) {
    if (S.bellCutAt === S.t) return;
    S.knownAlarms[name] = true;
    ui.bellRinging = true;
  }

  /* ---------------- public API ---------------- */

  window.machine = {
    name: "Airship R.108 - Ballast, Trim & Valve Board",
    faults: [FAULT_CELL, FAULT_VALVE, FAULT_PUMP],

    state: function () {
      return {
        time: S.t,
        altitude: S.altitude,
        pitch: S.pitch,
        airspeed: S.speed,
        heaviness: heaviness(),
        grossLift: grossLift(),
        weight: weight(),
        ballastFore: S.ballastFore,
        ballastAft: S.ballastAft,
        fuel: S.fuel,
        fillFore: S.fillFore,
        fillMid: S.fillMid,
        fillAft: S.fillAft,
        pressFore: S.pressFore,
        pressAft: S.pressAft,
        superheat: S.superheat,
        elevator: S.elevator,
        engineOrder: S.order,
        engineAnswer: S.answer,
        valveForeTurns: S.valveFore,
        valveAftTurns: S.valveAft,
        gasSelector: SEL_NAMES[S.selPos],
        ventOpen: S.ventOpen,
        pumpPosition: S.pumpPos,
        aground: S.aground,
        strained: S.strained,
        faults: [
          S.puncture ? FAULT_CELL : null,
          S.valvePass ? FAULT_VALVE : null,
          S.pumpTripped ? FAULT_PUMP : null,
        ].filter(Boolean),
        alarms: activeAlarms(),
      };
    },

    tick: tick,

    inject: function (fault) {
      if (fault === FAULT_CELL) {
        S.puncture = true;
        ringFor(AL_GAS);
      } else if (fault === FAULT_VALVE) {
        S.valvePass = true;
      } else if (fault === FAULT_PUMP) {
        S.pumpTripped = true;
        ringFor(AL_PUMP);
      }
      renderMaintenance();
    },

    reset: function () {
      resetState();
      ui.bellRinging = false;
      syncControls();
      renderEverything();
    },
  };

  /* ---------------- dial geometry ---------------- */

  var DIALS = {
    inclin: { min: -15, max: 15, a0: -112, a1: 112, major: 5, minor: 1 },
    speed: { min: 0, max: 70, a0: -122, a1: 122, major: 10, minor: 5 },
    alt: { min: 0, max: 30, a0: -128, a1: 128, major: 5, minor: 1 },
    superheat: { min: -10, max: 25, a0: -115, a1: 115, major: 5, minor: 1 },
    pressF: { min: 0, max: 50, a0: -125, a1: 125, major: 10, minor: 5 },
    pressA: { min: 0, max: 50, a0: -125, a1: 125, major: 10, minor: 5 },
  };

  function polar(cx, cy, r, deg) {
    var rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function buildTicks(g, spec) {
    var ns = "http://www.w3.org/2000/svg";
    var span = spec.a1 - spec.a0;
    var range = spec.max - spec.min;
    var v;
    for (v = spec.min; v <= spec.max + 1e-9; v += spec.minor) {
      var f = (v - spec.min) / range;
      var ang = spec.a0 + f * span;
      var major = Math.abs(v / spec.major - Math.round(v / spec.major)) < 1e-6;
      var l = document.createElementNS(ns, "line");
      var p1 = polar(50, 52, major ? 32 : 36, ang);
      var p2 = polar(50, 52, 41, ang);
      l.setAttribute("x1", p1[0].toFixed(2));
      l.setAttribute("y1", p1[1].toFixed(2));
      l.setAttribute("x2", p2[0].toFixed(2));
      l.setAttribute("y2", p2[1].toFixed(2));
      if (!major) l.setAttribute("class", "minor");
      g.appendChild(l);
    }
    var arcs = RED_ARCS[g.getAttribute("data-dial")] || [];
    arcs.forEach(function (pair) {
      var a = spec.a0 + ((pair[0] - spec.min) / range) * span;
      var b = spec.a0 + ((pair[1] - spec.min) / range) * span;
      var p1 = polar(50, 52, 38.5, a);
      var p2 = polar(50, 52, 38.5, b);
      var path = document.createElementNS(ns, "path");
      path.setAttribute("class", "redarc");
      path.setAttribute(
        "d",
        "M" +
          p1[0].toFixed(2) +
          " " +
          p1[1].toFixed(2) +
          " A38.5 38.5 0 0 1 " +
          p2[0].toFixed(2) +
          " " +
          p2[1].toFixed(2),
      );
      g.appendChild(path);
    });
  }

  var RED_ARCS = {
    inclin: [
      [-15, -10],
      [10, 15],
    ],
    speed: [[62, 70]],
    superheat: [[18, 25]],
    pressF: [[0, 20]],
    pressA: [[0, 20]],
    alt: [],
  };

  function setNeedle(id, value, specName) {
    var el = document.getElementById(id);
    var spec = DIALS[specName];
    var f = clamp((value - spec.min) / (spec.max - spec.min), 0, 1);
    el.style.transform =
      "rotate(" + (spec.a0 + f * (spec.a1 - spec.a0)) + "deg)";
  }

  /* ---------------- element handles ---------------- */

  function $(id) {
    return document.getElementById(id);
  }

  var ui = {
    bellRinging: false,
    cloudPhase: 0,
    els: {},
  };

  var FLAGS = [
    "STATIC HEAVY",
    "STATIC LIGHT",
    "TRIM LIMIT",
    "GAS PRESSURE",
    "BALLAST LOW",
    "PUMP TRIP",
    "GROUND CONTACT",
  ].map(function (n) {
    return document.querySelector('.flag[data-flag="' + n + '"]');
  });

  /* ---------------- rendering ---------------- */

  function pad(n, w) {
    n = Math.round(Math.abs(n));
    var s = String(n);
    while (s.length < w) s = "0" + s;
    return s.slice(-w);
  }

  function renderEverything() {
    var st = window.machine.state();

    // gauges
    setNeedle("nInclin", st.pitch, "inclin");
    setNeedle("nPressF", st.pressFore, "pressF");
    setNeedle("nPressA", st.pressAft, "pressA");
    setNeedle("nSpeed", st.airspeed, "speed");
    setNeedle("nAlt", st.altitude / 100, "alt");
    setNeedle("nSuperheat", st.superheat, "superheat");

    $("txtPitch").textContent =
      (st.pitch >= 0 ? "+" : "") + st.pitch.toFixed(1) + "\u00B0";

    // balance
    var hf = clamp(st.heaviness / 2600, -1, 1);
    $("balPtr").style.left = 50 + hf * 46 + "%";
    $("txtBal").textContent =
      (st.heaviness >= 0 ? "+" : "-") + pad(st.heaviness, 4);
    $("txtBal").style.color =
      Math.abs(st.heaviness) > 700 ? "#f4d9c4" : "var(--ivory)";

    // glasses
    $("waterFore").style.height = (st.ballastFore / TANK_MAX) * 100 + "%";
    $("waterAft").style.height = (st.ballastAft / TANK_MAX) * 100 + "%";
    $("waterFuel").style.height = (st.fuel / FUEL_GAL_MAX) * 100 + "%";
    $("txtFore").textContent = pad(st.ballastFore, 4);
    $("txtAft").textContent = pad(st.ballastAft, 4);
    $("txtFuel").textContent = pad(st.fuel, 4);

    // drums
    $("cntAlt").children[0].textContent = pad(st.altitude / 1000, 1);
    $("cntAlt").children[1].textContent = pad(st.altitude / 100, 1);
    $("cntAlt").children[2].textContent = pad(st.altitude / 10, 1);
    $("cntAlt").children[3].textContent = pad(st.altitude, 1);
    $("cntFuelDrum").children[0].textContent = pad(st.fuel / 1000, 1);
    $("cntFuelDrum").children[1].textContent = pad(st.fuel / 100, 1);
    $("cntFuelDrum").children[2].textContent = pad(st.fuel / 10, 1);
    $("cntFuelDrum").children[3].textContent = pad(st.fuel, 1);

    // telegraph
    var ordAng = { SLOW: -32, HALF: 0, FULL: 32 }[st.engineOrder];
    var ansAng = { SLOW: -32, HALF: 0, FULL: 32 }[st.engineAnswer];
    $("tgOrder").style.setProperty("--ord", ordAng + "deg");
    $("tgAnswer").style.setProperty("--ans", ansAng + "deg");
    $("txtTelegraph").textContent =
      "ORDER " + st.engineOrder + " \u00B7 ANSWER " + st.engineAnswer;

    // hull mimic
    var ship = ui.els.ship;
    ship.setAttribute(
      "transform",
      "rotate(" + st.pitch.toFixed(2) + " 460 100)",
    );
    var rise = clamp(st.altitude / 1500, 0, 1.6) * 62;
    ship.setAttribute("translate-y", "");
    ship.style.transform = "translateY(" + (-rise).toFixed(1) + "px)";
    var drift = (st.time * (12 + st.airspeed * 0.9)) % 1060;
    ui.els.clouds.style.transform = "translateX(" + (-drift).toFixed(1) + "px)";
    ui.els.cellFore.setAttribute(
      "fill-opacity",
      (0.2 + st.fillFore * 0.4).toFixed(2),
    );
    ui.els.cellMid.setAttribute(
      "fill-opacity",
      (0.2 + st.fillMid * 0.4).toFixed(2),
    );
    ui.els.cellAft.setAttribute(
      "fill-opacity",
      (0.2 + st.fillAft * 0.4).toFixed(2),
    );
    ui.els.patchMark.classList.toggle(
      "alarm",
      !!~window.machine.state().faults.indexOf(FAULT_CELL),
    );

    // annunciators
    var alarms = st.alarms;
    var testing = S.lampTestUntil >= 0;
    FLAGS.forEach(function (el, i) {
      var on =
        testing || alarms.indexOf(FLAGS[i].getAttribute("data-flag")) !== -1;
      el.classList.toggle("active", on && !testing);
      el.classList.toggle("test", on && testing);
    });

    // jewel + bell
    var alive = !st.aground;
    var jewel = ui.els.jewel;
    jewel.classList.toggle("lit", alive);
    jewel.classList.toggle("test", testing);
    if (ui.bellRinging && alarms.length === 0) ui.bellRinging = false;
    var ringing = ui.bellRinging && !testing;
    ui.els.bellBtn.classList.toggle("ringing", ringing);

    // readouts tied to controls
    $("turnsFore").textContent = st.valveForeTurns.toFixed(1);
    $("turnsAft").textContent = st.valveAftTurns.toFixed(1);
    $("txtElev").textContent =
      st.elevator === 0
        ? "AMIDSHIPS"
        : (st.elevator > 0 ? "NOSE DOWN " : "NOSE UP ") +
          Math.abs(st.elevator) +
          "\u00B0";
    $("txtPump").textContent = ["SEND WATER FORWARD", "HOLD", "SEND WATER AFT"][
      st.pumpPos + 1
    ];

    renderMaintenance();
  }

  function renderMaintenance() {
    $("btnFixCell").disabled = !S.puncture;
    $("btnFixValve").disabled = !S.valvePass;
    $("btnFixPump").disabled = !S.pumpTripped;
  }

  /* ---------------- control syncing ---------------- */

  function syncControls() {
    ui.rotFore = S.valveFore * 360;
    ui.rotAft = S.valveAft * 360;
    ui.rotElev = (S.elevator / 25) * 150;
    applyWheel(ui.els.wheelFore, ui.rotFore);
    applyWheel(ui.els.wheelAft, ui.rotAft);
    applyWheel(ui.els.elevWheel, ui.rotElev);
    ui.els.elevWheel.setAttribute(
      "aria-valuenow",
      String(Math.round(S.elevator)),
    );
    ui.els.elevWheel.setAttribute(
      "aria-valuetext",
      S.elevator === 0
        ? "0 degrees, amidships"
        : Math.round(S.elevator) + " degrees",
    );
    ui.els.wheelFore.setAttribute(
      "aria-valuenow",
      String(S.valveFore.toFixed(1)),
    );
    ui.els.wheelFore.setAttribute(
      "aria-valuetext",
      S.valveFore.toFixed(1) + " turns open",
    );
    ui.els.wheelAft.setAttribute(
      "aria-valuenow",
      String(S.valveAft.toFixed(1)),
    );
    ui.els.wheelAft.setAttribute(
      "aria-valuetext",
      S.valveAft.toFixed(1) + " turns open",
    );
    setSelVisual();
    setPumpVisual();
    setVentVisual();
    setTelegraphDetents();
  }

  function applyWheel(el, rot) {
    el.style.setProperty("--rot", rot + "deg");
  }

  function setSelVisual() {
    var angles = [-60, -20, 20, 60];
    ui.els.selKnob.style.setProperty("--sel", angles[S.selPos] + "deg");
    ui.els.selKnob.setAttribute("aria-valuenow", String(S.selPos));
    ui.els.selKnob.setAttribute("aria-valuetext", SEL_NAMES[S.selPos]);
    Array.prototype.forEach.call(ui.els.selScale.children, function (li, i) {
      li.classList.toggle("on", i === S.selPos);
    });
  }

  function setPumpVisual() {
    var angles = { "-1": -34, 0: 0, 1: 34 };
    ui.els.pumpQuad.style.setProperty(
      "--pump",
      angles[String(S.pumpPos)] + "deg",
    );
    ui.els.pumpQuad.setAttribute("aria-valuenow", String(S.pumpPos));
    ui.els.pumpQuad.setAttribute(
      "aria-valuetext",
      ["SEND WATER FORWARD", "HOLD", "SEND WATER AFT"][S.pumpPos + 1],
    );
  }

  function setVentVisual() {
    ui.els.guardBtn.setAttribute("aria-pressed", String(S.guardOpen));
    ui.els.ventBtn.disabled = !S.guardOpen;
    ui.els.ventBtn.setAttribute("aria-pressed", String(S.ventOpen));
  }

  function setTelegraphDetents() {
    Array.prototype.forEach.call(ui.els.detents, function (b) {
      b.classList.toggle("on", b.getAttribute("data-order") === S.order);
    });
  }

  /* ---------------- control interactions ---------------- */

  function bindWheelDrag(el, onChange) {
    var dragging = false;
    var lastY = 0;
    el.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      onChange(e.clientY - lastY);
      lastY = e.clientY;
    });
    el.addEventListener("pointerup", function () {
      dragging = false;
    });
    el.addEventListener("pointercancel", function () {
      dragging = false;
    });
    el.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        onChange(e.deltaY > 0 ? 6 : -6);
      },
      { passive: false },
    );
  }

  function bindKeys(el, handler) {
    el.addEventListener("keydown", function (e) {
      var used = true;
      switch (e.key) {
        case "ArrowUp":
        case "ArrowRight":
          handler(1);
          break;
        case "ArrowDown":
        case "ArrowLeft":
          handler(-1);
          break;
        case "PageUp":
          handler(6);
          break;
        case "PageDown":
          handler(-6);
          break;
        case "Home":
          handler("min");
          break;
        case "End":
          handler("max");
          break;
        default:
          used = false;
      }
      if (used) e.preventDefault();
    });
  }

  function initControls() {
    ui.els.ship = $("shipGroup");
    ui.els.shipLift = $("shipLift");
    ui.els.altMark = $("altMark");
    ui.els.ladder = $("ladder");
    ui.els.clouds = $("cloudA");
    ui.els.cellFore = $("cellForeShape");
    ui.els.cellMid = $("cellMidShape");
    ui.els.cellAft = $("cellAftShape");
    ui.els.patchMark = $("patchMark");
    ui.els.jewel = $("jewelPilot");
    ui.els.bellBtn = $("btnBellCut");
    ui.els.wheelFore = $("wheelFore");
    ui.els.wheelAft = $("wheelAft");
    ui.els.elevWheel = $("elevWheel");
    ui.els.selKnob = $("selKnob");
    ui.els.selScale = document.querySelector(".sel-scale");
    ui.els.pumpQuad = $("pumpQuadrant");
    ui.els.guardBtn = $("guardBtn");
    ui.els.ventBtn = $("ventBtn");
    ui.els.detents = Array.prototype.slice.call(
      document.querySelectorAll(".tg-detent"),
    );

    // dump valve wheels: one full turn of the hand wheel
    bindWheelDrag(ui.els.wheelFore, function (dy) {
      S.valveFore = clamp(S.valveFore + dy / 60, 0, 6);
      ui.rotFore = S.valveFore * 360;
      applyWheel(ui.els.wheelFore, ui.rotFore);
      ui.els.wheelFore.setAttribute("aria-valuenow", S.valveFore.toFixed(1));
      ui.els.wheelFore.setAttribute(
        "aria-valuetext",
        S.valveFore.toFixed(1) + " turns open",
      );
      $("turnsFore").textContent = S.valveFore.toFixed(1);
    });
    bindWheelDrag(ui.els.wheelAft, function (dy) {
      S.valveAft = clamp(S.valveAft + dy / 60, 0, 6);
      ui.rotAft = S.valveAft * 360;
      applyWheel(ui.els.wheelAft, ui.rotAft);
      ui.els.wheelAft.setAttribute("aria-valuenow", S.valveAft.toFixed(1));
      ui.els.wheelAft.setAttribute(
        "aria-valuetext",
        S.valveAft.toFixed(1) + " turns open",
      );
      $("turnsAft").textContent = S.valveAft.toFixed(1);
    });
    bindKeys(ui.els.wheelFore, function (step) {
      S.valveFore =
        step === "min"
          ? 0
          : step === "max"
            ? 6
            : clamp(S.valveFore + step * 0.25, 0, 6);
      ui.rotFore = S.valveFore * 360;
      applyWheel(ui.els.wheelFore, ui.rotFore);
      ui.els.wheelFore.setAttribute("aria-valuenow", S.valveFore.toFixed(1));
      ui.els.wheelFore.setAttribute(
        "aria-valuetext",
        S.valveFore.toFixed(1) + " turns open",
      );
      $("turnsFore").textContent = S.valveFore.toFixed(1);
    });
    bindKeys(ui.els.wheelAft, function (step) {
      S.valveAft =
        step === "min"
          ? 0
          : step === "max"
            ? 6
            : clamp(S.valveAft + step * 0.25, 0, 6);
      ui.rotAft = S.valveAft * 360;
      applyWheel(ui.els.wheelAft, ui.rotAft);
      ui.els.wheelAft.setAttribute("aria-valuenow", S.valveAft.toFixed(1));
      ui.els.wheelAft.setAttribute(
        "aria-valuetext",
        S.valveAft.toFixed(1) + " turns open",
      );
      $("turnsAft").textContent = S.valveAft.toFixed(1);
    });

    // gas cell selector
    bindWheelDrag(ui.els.selKnob, function (dy) {
      if (Math.abs(dy) > 4) {
        S.selPos = clamp(S.selPos + (dy < 0 ? 1 : -1), 0, 3);
        setSelVisual();
      }
    });
    bindKeys(ui.els.selKnob, function (step) {
      S.selPos =
        step === "min" ? 0 : step === "max" ? 3 : clamp(S.selPos + step, 0, 3);
      setSelVisual();
    });

    // vent guard + lever
    ui.els.guardBtn.addEventListener("click", function () {
      S.guardOpen = !S.guardOpen;
      if (!S.guardOpen) S.ventOpen = false;
      setVentVisual();
    });
    ui.els.ventBtn.addEventListener("click", function () {
      if (!S.guardOpen) return;
      S.ventOpen = !S.ventOpen;
      setVentVisual();
    });

    // elevator handwheel
    bindWheelDrag(ui.els.elevWheel, function (dy) {
      S.elevator = clamp(S.elevator - dy / 4.8, -25, 25);
      ui.rotElev = (S.elevator / 25) * 150;
      applyWheel(ui.els.elevWheel, ui.rotElev);
      ui.els.elevWheel.setAttribute(
        "aria-valuenow",
        String(Math.round(S.elevator)),
      );
      ui.els.elevWheel.setAttribute(
        "aria-valuetext",
        S.elevator === 0
          ? "0 degrees, amidships"
          : Math.round(S.elevator) + " degrees",
      );
    });
    bindKeys(ui.els.elevWheel, function (step) {
      S.elevator =
        step === "min"
          ? 0
          : step === "max"
            ? 0
            : clamp(S.elevator + step, -25, 25);
      ui.rotElev = (S.elevator / 25) * 150;
      applyWheel(ui.els.elevWheel, ui.rotElev);
      ui.els.elevWheel.setAttribute(
        "aria-valuenow",
        String(Math.round(S.elevator)),
      );
      ui.els.elevWheel.setAttribute(
        "aria-valuetext",
        S.elevator === 0
          ? "0 degrees, amidships"
          : Math.round(S.elevator) + " degrees",
      );
    });
    ui.els.elevWheel.addEventListener("dblclick", function () {
      S.elevator = 0;
      applyWheel(ui.els.elevWheel, 0);
      ui.els.elevWheel.setAttribute("aria-valuenow", "0");
    });

    // trim pump quadrant
    bindWheelDrag(ui.els.pumpQuad, function (dy) {
      if (Math.abs(dy) > 8) {
        S.pumpPos = clamp(S.pumpPos + (dy < 0 ? 1 : -1), -1, 1);
        setPumpVisual();
      }
    });
    bindKeys(ui.els.pumpQuad, function (step) {
      S.pumpPos =
        step === "min"
          ? -1
          : step === "max"
            ? 1
            : clamp(S.pumpPos + step, -1, 1);
      setPumpVisual();
    });
    ui.els.pumpQuad.addEventListener("pointerdown", function (e) {
      var r = ui.els.pumpQuad.getBoundingClientRect();
      var fx = (e.clientX - r.left) / r.width;
      S.pumpPos = fx < 0.37 ? -1 : fx > 0.63 ? 1 : 0;
      setPumpVisual();
    });

    // telegraph detents
    ui.els.detents.forEach(function (b) {
      b.addEventListener("click", function () {
        var o = b.getAttribute("data-order");
        if (o !== S.order) {
          S.order = o;
          S.answerAt = S.t + 6;
          setTelegraphDetents();
        }
      });
    });

    // bells, lamps, reset
    ui.els.bellBtn.addEventListener("click", function () {
      ui.bellRinging = false;
      S.bellCutAt = S.t;
      Object.keys(S.knownAlarms).forEach(function (k) {
        delete S.knownAlarms[k];
      });
    });
    $("btnLamps").addEventListener("click", function () {
      S.lampTestUntil = S.t + 1.6;
    });
    $("btnReset").addEventListener("click", function () {
      window.machine.reset();
    });

    // maintenance tray
    $("btnTestCell").addEventListener("click", function () {
      window.machine.inject(FAULT_CELL);
    });
    $("btnTestValve").addEventListener("click", function () {
      window.machine.inject(FAULT_VALVE);
    });
    $("btnTestPump").addEventListener("click", function () {
      window.machine.inject(FAULT_PUMP);
    });
    $("btnFixCell").addEventListener("click", function () {
      S.puncture = false;
      S.fillFore = Math.min(1, S.fillFore + 0.04);
      renderMaintenance();
    });
    $("btnFixValve").addEventListener("click", function () {
      S.valvePass = false;
      renderMaintenance();
    });
    $("btnFixPump").addEventListener("click", function () {
      S.pumpTripped = false;
      renderMaintenance();
    });

    // manual dialog
    var dialog = $("manualDialog");
    $("btnManual").addEventListener("click", function () {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });
    $("btnCloseManual").addEventListener("click", function () {
      dialog.close();
    });
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) dialog.close();
    });
  }

  /* ---------------- animation loop ---------------- */

  var lastStamp = null;
  var running = true;

  function frame(now) {
    if (lastStamp === null) lastStamp = now;
    var dt = (now - lastStamp) / 1000;
    lastStamp = now;
    if (running && dt > 0) {
      window.machine.tick(Math.min(dt, 0.5));
      try {
        renderEverything();
      } catch (e) {
        /* never let a paint problem kill the sim */
      }
    }
    window.requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    running = !document.hidden;
    lastStamp = null;
  });

  /* ---------------- boot ---------------- */

  function buildLadder() {
    var ns = "http://www.w3.org/2000/svg";
    var ft;
    for (ft = 0; ft <= 3000; ft += 500) {
      var y = 208 - (ft / 3000) * 172;
      var l = document.createElementNS(ns, "line");
      l.setAttribute("x1", 852);
      l.setAttribute("x2", ft % 1000 === 0 ? 842 : 847);
      l.setAttribute("y1", y);
      l.setAttribute("y2", y);
      ui.els.ladder.appendChild(l);
      if (ft % 1000 === 0) {
        var t = document.createElementNS(ns, "text");
        t.setAttribute("x", 838);
        t.setAttribute("y", y + 3);
        t.setAttribute("text-anchor", "end");
        t.textContent = String(ft / 1000);
        ui.els.ladder.appendChild(t);
      }
    }
    var cap = document.createElementNS(ns, "text");
    cap.setAttribute("x", 838);
    cap.setAttribute("y", 22);
    cap.setAttribute("text-anchor", "end");
    cap.textContent = "\u00D71000 FT";
    cap.setAttribute("class", "ladder-cap");
    ui.els.ladder.appendChild(cap);
  }

  function boot() {
    var g, key;
    var groups = document.querySelectorAll("g.ticks");
    for (var i = 0; i < groups.length; i++) {
      g = groups[i];
      key = g.getAttribute("data-dial");
      if (DIALS[key]) buildTicks(g, DIALS[key]);
    }
    initControls();
    buildLadder();
    syncControls();
    renderEverything();
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
