/* Verity Anaesthetic Apparatus Mk. II — simulation and behaviour.
   Sheffield, 1958. Gas moves by pressure, the patient responds in time,
   and the mains only feeds the lamps, the meters and the bell. */
(function () {
  "use strict";

  var MACHINE_NAME = "Verity Anaesthetic Apparatus Mk. II";
  var FAULTS = [
    "oxygen cylinder depletion",
    "vaporizer leak",
    "soda lime exhaustion",
  ];

  /* ---------------- tunables ---------------- */
  var FAIL_BAR = 15; // cylinder pressure below which supply is lost
  var FAULT_DRAIN = 5.5; // bar/s drained by the works-test leak
  var USE_DRAIN = 0.00045; // bar per litre drawn from the cylinder
  var EXHAUSTED = 0.02; // canister life fraction counted as spent
  var CANISTER_LIFE_S = 2100; // seconds of ordinary breathing from fresh
  var SAT_CRISIS = 78;
  var CO2_CRISIS = 14;
  var ALV_CRISIS = 4.6;

  /* ---------------- plant state ---------------- */
  var S = {};

  function coldState() {
    return {
      t: 0,
      mains: false,
      o2Valve: 0,
      n2oValve: 0,
      vapSet: 0,
      popoff: 0, // 0 = closed .. 10 = wide open
      yokeReserve: false,
      cutout: false,
      dutyBar: 122,
      reserveBar: 132,
      o2Flow: 0,
      n2oFlow: 0,
      flushT: 0,
      delivered: 0,
      alveolar: 0,
      leak: false,
      supplyDrain: false,
      sodalimeTest: false,
      canisterLife: 1,
      respPhase: 0,
      respRate: 12,
      effort: 1,
      bagPressure: 4,
      co2: 5.3,
      sat: 98,
      crisis: false,
      pressureHold: 0,
      alarms: [],
    };
  }
  S = coldState();

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function approach(v, target, tau, dt) {
    if (tau <= 0) return target;
    return v + (target - v) * (1 - Math.exp(-dt / tau));
  }

  /* ---------------- the simulation ---------------- */

  function step(dt) {
    S.t += dt;

    /* --- oxygen supply --- */
    var sourceBar = S.yokeReserve ? S.reserveBar : S.dutyBar;
    var draining = S.supplyDrain && !S.yokeReserve;
    if (draining) S.dutyBar = Math.max(0, S.dutyBar - FAULT_DRAIN * dt);
    var drawLitres = S.o2Flow * dt;
    if (S.yokeReserve)
      S.reserveBar = Math.max(0, S.reserveBar - drawLitres * USE_DRAIN);
    else S.dutyBar = Math.max(0, S.dutyBar - drawLitres * USE_DRAIN);
    var supplyOK = sourceBar > FAIL_BAR && !(draining && S.dutyBar <= FAIL_BAR);

    /* --- flows: pneumatics work with the mains off --- */
    var o2Target = supplyOK ? S.o2Valve : 0;
    S.o2Flow = approach(S.o2Flow, o2Target, 1.2, dt);
    var cutOff = !supplyOK || (S.o2Valve >= 0.3 && S.o2Flow < 0.2);
    var n2oTarget = cutOff ? 0 : S.n2oValve;
    S.n2oFlow = approach(S.n2oFlow, n2oTarget, 1.5, dt);
    if (S.flushT > 0) S.flushT = Math.max(0, S.flushT - dt);

    var freshGas = S.o2Flow + S.n2oFlow + (S.flushT > 0 ? 12 : 0);

    /* --- vaporiser --- */
    var dilution = 1.25 / (1 + freshGas / 4.5);
    var dTarget =
      S.vapSet > 0.01 ? S.vapSet * dilution * (S.leak ? 0.2 : 1) : 0;
    S.delivered = approach(S.delivered, dTarget, 2.5, dt);
    S.alveolar = approach(S.alveolar, S.delivered, 22, dt);
    S.alveolar = clamp(S.alveolar, 0, 6);

    /* --- the patient breathes the circle --- */
    var depression = Math.max(0, S.alveolar - 2.2) * 0.38;
    S.effort = clamp(1 - depression, 0.04, 1);
    S.respRate = S.crisis && S.sat < 70 ? 0 : 11.5 * S.effort;
    S.respPhase += (S.respRate / 60) * dt * Math.PI * 2;

    var rebreathGap = S.canisterLife <= EXHAUSTED ? 26 : 0;
    var lowFlowGap = freshGas < 0.6 ? 10 * (1 - freshGas / 0.6) : 0;
    var hypoGap = (1 - S.effort) * 17;
    var co2Target = clamp(5.3 + rebreathGap + lowFlowGap + hypoGap, 0, 32);
    S.co2 = approach(S.co2, co2Target, 9, dt);

    var o2Percent = freshGas > 0.05 ? (100 * S.o2Flow) / freshGas : 0;
    var apnoeaGap = S.respRate < 3.5 ? (3.5 - S.respRate) * 6 : 0;
    var hypoxicGap = Math.max(0, 21 - o2Percent) * 3.1;
    var satTarget = clamp(
      100 - hypoxicGap - apnoeaGap - Math.max(0, S.co2 - 8) * 1.4,
      40,
      100,
    );
    S.sat = approach(S.sat, satTarget, 22, dt);
    S.sat = clamp(S.sat, 0, 100);

    /* --- airway pressure against the pop-off --- */
    var relief = clamp(46 - 4.4 * S.popoff, 2, 48);
    var wave = 3 * Math.max(0, Math.sin(S.respPhase));
    var pTarget = Math.min(relief, 3.5 + wave);
    S.bagPressure = approach(S.bagPressure, pTarget, 0.9, dt);
    S.pressureHold = S.bagPressure > 38 ? S.pressureHold + dt : 0;

    /* --- soda lime --- */
    var useFactor = (S.co2 / 5.3) * (Math.min(S.respRate, 14) / 12);
    if (S.sodalimeTest) S.canisterLife = Math.max(0, S.canisterLife - dt);
    else
      S.canisterLife = Math.max(
        0,
        S.canisterLife - dt * (useFactor / CANISTER_LIFE_S),
      );

    /* --- alarms --- */
    var list = [];
    if (!supplyOK) list.push("oxygen failure");
    if (S.leak) list.push("vapour loss");
    if (S.canisterLife <= EXHAUSTED) list.push("co2 rebreathing");
    if (S.bagPressure > 34) list.push("airway pressure high");

    var danger =
      S.sat < SAT_CRISIS ||
      S.co2 > CO2_CRISIS ||
      S.alveolar > ALV_CRISIS ||
      S.pressureHold > 25;
    if (danger) S.crisis = true;
    var safe =
      S.sat > 88 && S.co2 < 10 && S.alveolar < 3.4 && S.bagPressure < 30;
    if (S.crisis && safe) S.crisis = false;
    if (S.crisis) list.push("patient crisis");

    S.alarms = list;
  }

  function tick(seconds) {
    var remaining = Math.max(0, Number(seconds) || 0);
    while (remaining > 0) {
      var dt = Math.min(0.1, remaining);
      step(dt);
      remaining -= dt;
    }
  }

  function state() {
    var sourceBar = S.yokeReserve ? S.reserveBar : S.dutyBar;
    return {
      seconds: Math.round(S.t * 10) / 10,
      mainsOn: S.mains,
      yokeOnReserve: S.yokeReserve,
      dutyCylinderBar:
        Math.round((S.yokeReserve ? S.reserveBar : S.dutyBar) * 100) / 100,

      reserveCylinderBar: Math.round(S.reserveBar * 100) / 100,
      oxygenFlow: Math.round(S.o2Flow * 100) / 100,
      nitrousFlow: Math.round(S.n2oFlow * 100) / 100,
      freshGasFlow: Math.round((S.o2Flow + S.n2oFlow) * 100) / 100,
      oxygenPercent:
        Math.round(
          (S.o2Flow + S.n2oFlow > 0.05
            ? (100 * S.o2Flow) / (S.o2Flow + S.n2oFlow)
            : 0) * 10,
        ) / 10,
      vaporizerSetting: Math.round(S.vapSet * 100) / 100,
      deliveredPercent: Math.round(S.delivered * 100) / 100,
      alveolarPercent: Math.round(S.alveolar * 100) / 100,
      respRate: Math.round(S.respRate * 10) / 10,
      endTidalCO2: Math.round(S.co2 * 10) / 10,
      saturation: Math.round(S.sat * 10) / 10,
      bagPressure: Math.round(S.bagPressure * 10) / 10,
      canisterLife: Math.round(S.canisterLife * 1000) / 1000,
      nitrousCutOffEngaged: !!(S.n2oValve > 0 && S.n2oFlow < 0.05),
      emergencyFlushSeconds: Math.round(S.flushT * 10) / 10,
      alarms: S.alarms.slice(),
    };
  }

  /* ---------------- faults and reset ---------------- */

  function setTestUI(id, on) {
    var el = document.getElementById(id);
    if (el) el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      S.supplyDrain = true;
      setTestUI("test-oxygen", true);
    } else if (f === FAULTS[1]) {
      S.leak = true;
      setTestUI("test-vapour", true);
    } else if (f === FAULTS[2]) {
      S.canisterLife = 0;
      S.sodalimeTest = true;
      setTestUI("test-sodalime", true);
    }
  }

  function reset() {
    S = coldState();
    setTestUI("test-oxygen", false);
    setTestUI("test-vapour", false);
    setTestUI("test-sodalime", false);
    document.getElementById("bolt-a").classList.remove("open");
    document.getElementById("bolt-b").classList.remove("open");
    syncControls();
    updateDom();
  }

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ================= drawing the instruments ================= */

  var NS = "http://www.w3.org/2000/svg";

  function polar(cx, cy, r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function arcPath(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0);
    var p1 = polar(cx, cy, r, a1);
    var large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return (
      "M " +
      p0[0].toFixed(2) +
      " " +
      p0[1].toFixed(2) +
      " A " +
      r +
      " " +
      r +
      " 0 " +
      large +
      " 1 " +
      p1[0].toFixed(2) +
      " " +
      p1[1].toFixed(2)
    );
  }

  /* A wrinkle-black gauge with ivory figures and a brass needle. */
  function buildGauge(el) {
    var min = parseFloat(el.dataset.min);
    var max = parseFloat(el.dataset.max);
    var ticks = parseInt(el.dataset.ticks || "5", 10);
    var unit = el.dataset.unit || "";
    var A0 = -125,
      A1 = 125;

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 120 120");

    var face = document.createElementNS(NS, "circle");
    face.setAttribute("cx", "60");
    face.setAttribute("cy", "60");
    face.setAttribute("r", "57");
    face.setAttribute("class", "g-face");
    svg.appendChild(face);

    var bezel = document.createElementNS(NS, "circle");
    bezel.setAttribute("cx", "60");
    bezel.setAttribute("cy", "60");
    bezel.setAttribute("r", "56");
    bezel.setAttribute("class", "g-bezel");
    svg.appendChild(bezel);

    // coloured duty bands
    var zones = (el.dataset.zones || "").split("|").filter(Boolean);
    zones.forEach(function (z) {
      var parts = z.split(":");
      var range = parts[1].split(",").map(parseFloat);
      var v0 = clamp(range[0], min, max),
        v1 = clamp(range[1], min, max);
      var a0 = A0 + ((v0 - min) / (max - min)) * (A1 - A0);
      var a1 = A0 + ((v1 - min) / (max - min)) * (A1 - A0);
      var band = document.createElementNS(NS, "path");
      band.setAttribute("d", arcPath(60, 60, 47, a0, a1));
      band.setAttribute("class", "g-band-" + parts[0]);
      svg.appendChild(band);
    });

    for (var i = 0; i <= ticks; i++) {
      var frac = i / ticks;
      var ang = A0 + frac * (A1 - A0);
      var line = document.createElementNS(NS, "line");
      var pOut = polar(60, 60, 52, ang);
      var pIn = polar(60, 60, 45, ang);
      line.setAttribute("x1", pOut[0].toFixed(2));
      line.setAttribute("y1", pOut[1].toFixed(2));
      line.setAttribute("x2", pIn[0].toFixed(2));
      line.setAttribute("y2", pIn[1].toFixed(2));
      line.setAttribute("class", "g-tick");
      svg.appendChild(line);
      var lbl = document.createElementNS(NS, "text");
      var lp = polar(60, 60, 36, ang);
      lbl.setAttribute("x", lp[0].toFixed(2));
      lbl.setAttribute("y", (lp[1] + 3).toFixed(2));
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("class", "g-num");
      var val = min + frac * (max - min);
      lbl.textContent =
        Math.abs(val) >= 10
          ? String(Math.round(val))
          : Number.isInteger(val)
            ? String(val)
            : val.toFixed(1);
      svg.appendChild(lbl);
    }

    var unitTxt = document.createElementNS(NS, "text");
    unitTxt.setAttribute("x", "60");
    unitTxt.setAttribute("y", "86");
    unitTxt.setAttribute("text-anchor", "middle");
    unitTxt.setAttribute("class", "g-unit");
    unitTxt.textContent = unit;
    svg.appendChild(unitTxt);

    var needle = document.createElementNS(NS, "line");
    needle.setAttribute("x1", "60");
    needle.setAttribute("y1", "68");
    needle.setAttribute("x2", "60");
    needle.setAttribute("y2", "18");
    needle.setAttribute("class", "g-needle");
    svg.appendChild(needle);

    var hub = document.createElementNS(NS, "circle");
    hub.setAttribute("cx", "60");
    hub.setAttribute("cy", "60");
    hub.setAttribute("r", "5");
    hub.setAttribute("class", "g-hub");
    svg.appendChild(hub);

    el.appendChild(svg);

    return function (value) {
      var frac = clamp((value - min) / (max - min), 0, 1);
      needle.setAttribute(
        "transform",
        "rotate(" + (A0 + frac * (A1 - A0)).toFixed(2) + " 60 60)",
      );
    };
  }

  var setDuty, setReserve, setAirway, setDepth, setSaturation;

  function buildInstruments() {
    setDuty = buildGauge(document.getElementById("gauge-duty"));
    setReserve = buildGauge(document.getElementById("gauge-reserve"));
    setAirway = buildGauge(document.getElementById("gauge-airway"));
    setDepth = buildGauge(document.getElementById("gauge-depth"));
    setSaturation = buildGauge(document.getElementById("gauge-saturation"));

    // vaporiser dial ticks: 270 degrees, 0..4 percent
    var g = document.getElementById("vapour-ticks");
    for (var i = 0; i <= 8; i++) {
      var ang = -135 + (i / 8) * 270;
      var pOut = polar(60, 60, 54, ang);
      var pIn = polar(60, 60, i % 2 === 0 ? 45 : 49, ang);
      var line = document.createElementNS(NS, "line");
      line.setAttribute("x1", pOut[0].toFixed(2));
      line.setAttribute("y1", pOut[1].toFixed(2));
      line.setAttribute("x2", pIn[0].toFixed(2));
      line.setAttribute("y2", pIn[1].toFixed(2));
      g.appendChild(line);
      if (i % 2 === 0) {
        var lp = polar(60, 60, 37, ang);
        var txt = document.createElementNS(NS, "text");
        txt.setAttribute("x", lp[0].toFixed(2));
        txt.setAttribute("y", (lp[1] + 3).toFixed(2));
        txt.setAttribute("text-anchor", "middle");
        txt.textContent = String(i / 2);
        g.appendChild(txt);
      }
    }
  }

  /* ---------------- DOM references ---------------- */

  var $ = function (id) {
    return document.getElementById(id);
  };
  var apparatus = $("apparatus");
  var tubeOxygen = $("tube-oxygen");
  var tubeNitrous = $("tube-nitrous");
  var valveOxygen = $("valve-oxygen");
  var valveNitrous = $("valve-nitrous");
  var valvePopoff = $("valve-popoff");
  var dialVapour = $("dial-vapour");
  var vapourPointer = $("vapour-pointer");
  var vapourReadout = $("vapour-readout");
  var yokeBtn = $("yoke");
  var mainsBtn = $("mains");
  var cutoutBtn = $("cutout");
  var flushBtn = $("flush");
  var bag = $("bag");
  var chargeDisc = $("charge-disc");
  var chargeLife = $("charge-life");
  var jewelLeak = $("jewel-leak");
  var hints = {
    oxygen: $("hint-oxygen"),
    nitrous: $("hint-nitrous"),
    popoff: $("hint-popoff"),
  };
  var lensIds = {
    "oxygen failure": "lens-oxygen",
    "vapour loss": "lens-vapour",
    "co2 rebreathing": "lens-co2",
    "airway pressure high": "lens-airway",
    "patient crisis": "lens-crisis",
  };

  function setLens(lensId, lit) {
    var el = $(lensId);
    if (el) el.setAttribute("data-lit", lit ? "true" : "false");
  }

  function updateDom() {
    var st = state();

    tubeOxygen.style.setProperty("--flow", clamp(st.oxygenFlow / 10, 0, 1));
    tubeNitrous.style.setProperty("--flow", clamp(st.nitrousFlow / 10, 0, 1));
    valveOxygen.querySelector(".knob-face").style.transform =
      "rotate(" + (st.oxygenFlow / 10) * 1080 + "deg)";
    valveNitrous.querySelector(".knob-face").style.transform =
      "rotate(" + (st.nitrousFlow / 10) * 1080 + "deg)";
    valvePopoff.querySelector(".knob-face").style.transform =
      "rotate(" + (S.popoff / 10) * 1080 + "deg)";

    valveOxygen.setAttribute("aria-valuenow", st.oxygenFlow.toFixed(1));
    valveOxygen.setAttribute(
      "aria-valuetext",
      st.oxygenFlow.toFixed(1) + " litres per minute",
    );
    valveNitrous.setAttribute("aria-valuenow", st.nitrousFlow.toFixed(1));
    valveNitrous.setAttribute(
      "aria-valuetext",
      st.nitrousFlow.toFixed(1) + " litres per minute",
    );
    valvePopoff.setAttribute(
      "aria-valuenow",
      String(Math.round(S.popoff * 4) / 4),
    );
    valvePopoff.setAttribute(
      "aria-valuetext",
      S.popoff <= 0.01
        ? "valve closed"
        : "relief about " +
            Math.round(clamp(46 - 4.4 * S.popoff, 2, 48)) +
            " centimetres of water",
    );

    hints.oxygen.textContent =
      st.oxygenFlow >= 0.05 ? st.oxygenFlow.toFixed(1) + " L/min" : "closed";
    hints.nitrous.textContent = st.nitrousCutOffEngaged
      ? "cut-off dropped"
      : st.nitrousFlow >= 0.05
        ? st.nitrousFlow.toFixed(1) + " L/min"
        : "closed";
    hints.popoff.textContent =
      S.popoff <= 0.01
        ? "closed"
        : "relief " + Math.round(clamp(46 - 4.4 * S.popoff, 2, 48)) + " cmH2O";

    vapourReadout.textContent = st.vaporizerSetting.toFixed(1);
    var vp = dialVapour.querySelector(".knob-skirt");
    if (vp) vp.style.transform = "rotate(" + (S.vapSet / 4) * 900 + "deg)";
    vapourPointer.setAttribute(
      "transform",
      "rotate(" +
        (-135 + (st.vaporizerSetting / 4) * 270).toFixed(1) +
        " 60 60)",
    );
    jewelLeak.setAttribute("data-lit", S.leak ? "true" : "false");

    setDuty(st.dutyCylinderBar);
    setReserve(st.reserveCylinderBar);
    setAirway(st.bagPressure);
    setDepth(st.mains ? st.alveolarPercent : 0);
    setSaturation(st.mains ? st.saturation : 98);

    var breathe = 0.5 + 0.5 * Math.sin(S.respPhase);
    bag.style.setProperty("--fill", (0.25 + 0.75 * breathe).toFixed(3));

    chargeDisc.style.setProperty(
      "--life",
      clamp(st.canisterLife, 0, 1).toFixed(3),
    );
    chargeLife.textContent =
      st.canisterLife > 0.66
        ? "FRESH"
        : st.canisterLife > EXHAUSTED
          ? "PARTLY SPENT"
          : "EXHAUSTED";

    setLens("lens-mains", S.mains);
    Object.keys(lensIds).forEach(function (name) {
      setLens(lensIds[name], st.alarms.indexOf(name) !== -1);
    });

    yokeBtn.setAttribute("aria-checked", S.yokeReserve ? "true" : "false");
    mainsBtn.setAttribute("aria-checked", S.mains ? "true" : "false");
    cutoutBtn.setAttribute("aria-checked", S.cutout ? "true" : "false");
    apparatus.setAttribute("data-power", S.mains ? "on" : "off");
  }

  function syncControls() {
    valveOxygen.setAttribute("aria-valuemin", "0");
    valveOxygen.setAttribute("aria-valuemax", "10");
    valveNitrous.setAttribute("aria-valuemin", "0");
    valveNitrous.setAttribute("aria-valuemax", "10");
    dialVapour.setAttribute("aria-valuemin", "0");
    dialVapour.setAttribute("aria-valuemax", "4");
    valvePopoff.setAttribute("aria-valuemin", "0");
    valvePopoff.setAttribute("aria-valuemax", "10");
  }

  /* ---------------- operating the controls ---------------- */

  /* A bakelite knob: drag it round, spin the wheel over it, or use the
     arrow keys. Enter does nothing; this is a valve, not a button. */
  function bindKnob(el, opts) {
    var dragging = false,
      startY = 0,
      startVal = 0;

    function announce() {
      updateDom();
      sound.click();
    }

    function adjust(delta) {
      opts.set(clamp(opts.get() + delta, opts.min, opts.max));
      announce();
    }

    el.addEventListener("pointerdown", function (e) {
      dragging = true;
      startY = e.clientY;
      startVal = opts.get();
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dy = startY - e.clientY;
      var span = opts.max - opts.min;
      var raw = startVal + (dy / 160) * span;
      var snapped = Math.round(raw / opts.step) * opts.step;
      opts.set(clamp(snapped, opts.min, opts.max));
      updateDom();
    });
    el.addEventListener("pointerup", function () {
      if (!dragging) return;
      dragging = false;
      sound.click();
    });
    el.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        adjust((e.deltaY < 0 ? 1 : -1) * opts.step);
      },
      { passive: false },
    );
    el.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? opts.step * 10 : opts.step;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        adjust(step);
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        adjust(-step);
        e.preventDefault();
      } else if (e.key === "Home") {
        opts.set(opts.min);
        announce();
        e.preventDefault();
      } else if (e.key === "End") {
        opts.set(opts.max);
        announce();
        e.preventDefault();
      }
    });
  }

  bindKnob(valveOxygen, {
    min: 0,
    max: 10,
    step: 0.1,
    get: function () {
      return S.o2Valve;
    },
    set: function (v) {
      S.o2Valve = Math.round(v * 10) / 10;
    },
  });
  bindKnob(valveNitrous, {
    min: 0,
    max: 10,
    step: 0.1,
    get: function () {
      return S.n2oValve;
    },
    set: function (v) {
      S.n2oValve = Math.round(v * 10) / 10;
    },
  });
  bindKnob(dialVapour, {
    min: 0,
    max: 4,
    step: 0.1,
    get: function () {
      return S.vapSet;
    },
    set: function (v) {
      var nv = Math.round(v * 10) / 10;
      if (S.leak && nv <= 0.01) {
        /* closing the dial seats the vapour seal again */
        S.leak = false;
        setTestUI("test-vapour", false);
      }
      S.vapSet = nv;
    },
  });
  bindKnob(valvePopoff, {
    min: 0,
    max: 10,
    step: 0.25,
    get: function () {
      return S.popoff;
    },
    set: function (v) {
      S.popoff = Math.round(v * 4) / 4;
    },
  });

  yokeBtn.addEventListener("click", function () {
    S.yokeReserve = !S.yokeReserve;
    updateDom();
    sound.clack();
  });

  mainsBtn.addEventListener("click", function () {
    S.mains = !S.mains;
    updateDom();
    sound.clack();
  });

  cutoutBtn.addEventListener("click", function () {
    S.cutout = !S.cutout;
    updateDom();
    sound.click();
  });

  flushBtn.addEventListener("click", function () {
    S.flushT = 1.4;
    updateDom();
    sound.hissBurst();
  });

  function boltHandler(other) {
    return function () {
      var mine = this;
      mine.classList.toggle("open");
      if (mine.classList.contains("open") && other.classList.contains("open")) {
        /* both swing bolts open: the charge is swapped for a fresh one */
        S.canisterLife = 1;
        S.sodalimeTest = false;
        setTestUI("test-sodalime", false);
        setTimeout(function () {
          $("bolt-a").classList.remove("open");
          $("bolt-b").classList.remove("open");
          updateDom();
        }, 450);
      }
      sound.clack();
      updateDom();
    };
  }
  var boltA = $("bolt-a"),
    boltB = $("bolt-b");
  boltA.addEventListener("click", boltHandler(boltB));
  boltB.addEventListener("click", boltHandler(boltA));

  function bindTest(id, fn) {
    $(id).addEventListener("click", function () {
      var on = $(id).getAttribute("aria-checked") !== "true";
      $(id).setAttribute("aria-checked", on ? "true" : "false");
      fn(on);
      sound.clack();
      updateDom();
    });
  }
  bindTest("test-oxygen", function (on) {
    S.supplyDrain = on;
  });
  bindTest("test-vapour", function (on) {
    S.leak = on;
    if (on && S.vapSet > 0) {
      /* leak announces itself at once */
    }
  });
  bindTest("test-sodalime", function (on) {
    S.sodalimeTest = on;
    if (on) S.canisterLife = 0;
  });

  $("service-reset").addEventListener("click", function () {
    reset();
    sound.clack();
  });

  /* ---------------- the manual in its alcove ---------------- */

  var dialog = $("manual-dialog");
  document
    .querySelector('[data-action="manual"]')
    .addEventListener("click", function () {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });
  document
    .querySelector('[data-action="close-manual"]')
    .addEventListener("click", function () {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    });

  /* ---------------- sound, only after a gesture ---------------- */

  var sound = (function () {
    var ctx = null,
      master = null,
      hissGain = null,
      whGain = null,
      whOsc = null,
      ready = false;

    function unlock() {
      if (ready) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        ready = true;
        return;
      }
      try {
        ctx = new AC();
      } catch (e) {
        ready = true;
        return;
      }
      master = ctx.createGain();
      master.gain.value = 0.5;
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
      bp.frequency.value = 850;
      bp.Q.value = 0.7;
      hissGain = ctx.createGain();
      hissGain.gain.value = 0;
      src.connect(bp).connect(hissGain).connect(master);
      src.start();

      whOsc = ctx.createOscillator();
      whOsc.type = "square";
      whOsc.frequency.value = 1880;
      var tremolo = ctx.createGain();
      tremolo.gain.value = 0.5;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 13;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.5;
      lfo.connect(lfoGain).connect(tremolo.gain);
      whGain = ctx.createGain();
      whGain.gain.value = 0;
      whOsc.connect(tremolo).connect(whGain).connect(master);
      whOsc.start();
      lfo.start();
      ready = true;
    }

    function ambience() {
      if (!ready || !ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      var flow = S.o2Flow + S.n2oFlow + (S.flushT > 0 ? 12 : 0);
      var want = flow > 0.05 ? Math.min(0.14, 0.012 + flow * 0.011) : 0;
      hissGain.gain.setTargetAtTime(want, ctx.currentTime, 0.2);
      var whistling = S.alarms.indexOf("oxygen failure") !== -1 && !S.cutout;
      whGain.gain.setTargetAtTime(whistling ? 0.06 : 0, ctx.currentTime, 0.05);
    }

    function blip(freq, dur, vol, type) {
      if (!ready || !ctx) return;
      var o = ctx.createOscillator(),
        g = ctx.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(master);
      o.start();
      o.stop(ctx.currentTime + dur + 0.02);
    }

    return {
      unlock: unlock,
      ambience: ambience,
      click: function () {
        blip(2400, 0.03, 0.05, "square");
      },
      clack: function () {
        blip(320, 0.06, 0.09, "square");
      },
      hissBurst: function () {
        blip(520, 0.5, 0.04, "sawtooth");
      },
    };
  })();

  ["pointerdown", "keydown"].forEach(function (evtName) {
    document.addEventListener(
      evtName,
      function () {
        sound.unlock();
      },
      { once: true },
    );
  });

  /* ---------------- the clock ---------------- */

  var lastStamp = null;
  function frame(now) {
    if (lastStamp !== null) {
      var dt = (now - lastStamp) / 1000;
      if (dt > 0 && dt < 2) tick(dt);
    }
    lastStamp = now;
    updateDom();
    sound.ambience();
    requestAnimationFrame(frame);
  }

  buildInstruments();
  reset();
  requestAnimationFrame(frame);
})();
