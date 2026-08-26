/*
 * Trethellan Sound Surge Barrier - Control Desk No. 1
 * Rosevennor Coastal Authority. Panel software rev. 2.4.1
 *
 * Six rising-sector gates across a tidal estuary. Pass the normal tide with
 * the gates down; close ahead of a surge without crushing a gate on the
 * differential, and without drowning the upstream embankments behind an
 * impounded flood. Everything is deterministic: tick(seconds) is the only
 * clock the plant reads.
 */
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var DAY = 86400;
  var BASIN_AREA = 25000;
  var TRAVEL_TIME = 26;
  var HEAD_LIMIT = 3;
  var HEAD_ABSOLUTE = 5.4;
  var HEAD_WARN_PARKED = 5.0;
  var WEIR_CREST = 6;
  var WEIR_K = 300;
  var SLUICE_FLOW = 460;
  var HIGH_WATER = 7.2;
  var OVERTOP = 7.8;
  var OVERTOP_SECONDS = 20;
  var SCOUR_LIMIT = 100;

  var ALARM_LIST = [
    "SURGE FORECAST SEVERE",
    "HIGH WATER UPSTREAM",
    "DIFFERENTIAL HEAD HIGH",
    "HYD PRESSURE LOW",
    "GATE 4 SKEW",
    "DEBRIS IMPACT",
    "SCOUR DAMAGE",
    "OVERTOPPING",
  ];
  var AMBER_ALARMS = ["SURGE FORECAST SEVERE"];
  var FAULT_SKEW = "gate skew jam";
  var FAULT_PUMP = "hydraulic power unit trip";
  var FAULT_DEBRIS = "floating debris strike";

  /* ------------------------------------------------------------------ plant */

  var t = 0;
  var S = freshState();

  function gauss(x) {
    return Math.exp(-x * x);
  }

  // The published prediction: pure harmonic tide, no meteorology in it.
  function predicted(mt) {
    var amp = 3.1 + 1.3 * Math.sin((TAU * mt) / 1500 + 1);
    return 2.5 + amp * Math.sin((TAU * mt) / 300) + 0.12 * Math.sin(mt / 47);
  }

  // What the weather actually adds: two deterministic surge events.
  function surgeAt(mt) {
    return 2.9 * gauss((mt - 375) / 85) + 0.9 * gauss((mt - 1000) / 95);
  }

  function riverFlow(mt) {
    return 180 + 470 * gauss((mt - 450) / 95) + 25 * Math.sin(mt / 53);
  }

  function freshState() {
    return {
      mode: "OFF", // OFF | TEST | OPERATE
      sea: predicted(0),
      river: 1.2,
      discharge: riverFlow(0),
      head: 0,
      pressure: 0,
      dutyOn: false,
      dutyLockout: false,
      standbyOn: false,
      sluiceTurns: 0,
      gates: [
        { pos: 0, moving: false },
        { pos: 0, moving: false },
        { pos: 0, moving: false },
        { pos: 0, moving: false },
        { pos: 0, moving: false },
        { pos: 0, moving: false },
      ],
      selected: 6,
      lever: 0,
      autoSeq: null,
      skewFault: false,
      skewAngle: 0,
      debrisLatched: false,
      debrisEta: null,
      stress: 0,
      overSeconds: 0,
      damaged: null,
      alarms: [],
      forecastSevere: false,
      impounded: false,
      lampsTest: false,
      testProveUntil: 0,
    };
  }

  function coldReset() {
    flashSet.clear();
    hornLatched = false;
    S = freshState();
    t = 0;
  }

  function averagePos() {
    return (
      (S.gates[0].pos +
        S.gates[1].pos +
        S.gates[2].pos +
        S.gates[3].pos +
        S.gates[4].pos +
        S.gates[5].pos) /
      6
    );
  }

  /* ------------------------------------------------------------- simulation */

  function tick(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 5);
    t += dt;

    var g = S.gates;

    // ---- water ----
    S.sea = Math.max(0.2, predicted(t) + surgeAt(t) + 0.05 * Math.sin(t * 0.9));
    S.discharge = riverFlow(t);

    var openness = 1 - averagePos();
    var openPow = Math.pow(Math.max(openness, 0), 1.2);
    var du = S.discharge / BASIN_AREA;
    du += ((S.sea - S.river) / 12) * openPow;
    if (S.river > WEIR_CREST) {
      du -= ((S.river - WEIR_CREST) * WEIR_K) / BASIN_AREA;
    }
    var bypass =
      (S.sluiceTurns / 5) *
      SLUICE_FLOW *
      Math.max(0, Math.tanh((S.river - S.sea) / 0.5));
    du -= bypass / BASIN_AREA;
    S.river = Math.min(8.5, Math.max(0.15, S.river + du * dt));
    S.head = S.river - S.sea;
    S.impounded = averagePos() > 0.5 && S.river > S.sea + 0.4;

    // ---- hydraulics ----
    var supply = 0;
    if (S.mode === "OPERATE") {
      if (S.dutyOn && !S.dutyLockout) supply += 190;
      if (S.standbyOn) supply += 194;
    }
    var movingCount = 0;
    for (var mi = 0; mi < 6; mi++) {
      if (g[mi].moving) movingCount++;
    }
    if (supply > 0) {
      S.pressure += (Math.min(supply, 210) - S.pressure) * (dt / 6);
      S.pressure -= movingCount * 3 * dt;
    } else {
      S.pressure -= S.pressure * (dt / 14);
    }
    S.pressure = Math.min(230, Math.max(0, S.pressure));

    // ---- automatic sequence bookkeeping (overlapping pairs) ----
    if (S.autoSeq && !S.damaged && S.mode === "OPERATE") {
      var last = g[5];
      var seqOver = S.autoSeq.dir > 0 ? last.pos > 0.985 : last.pos < 0.015;
      var seqGate = g[S.autoSeq.i];
      var seqStarted =
        S.autoSeq.dir > 0 ? seqGate.pos > 0.62 : seqGate.pos < 0.38;
      if (seqOver) {
        S.autoSeq = null;
      } else if (seqStarted && S.autoSeq.i < 5) {
        S.autoSeq.i++;
      }
    } else if (S.autoSeq) {
      S.autoSeq = null;
    }

    // ---- which gates are being asked to move ----
    // The lever speaks directly for its selected gate; the automatic
    // sequence is a polite subordinate - it will not fight a differential
    // above the limit, it simply holds and waits for the sluice.
    var cmdsAuto = [0, 0, 0, 0, 0, 0];
    var cmds = [0, 0, 0, 0, 0, 0];
    S.autoHolding = false;
    if (S.mode === "OPERATE" && !S.damaged) {
      if (S.lever !== 0) {
        if (S.selected === 6) {
          for (var ci = 0; ci < 6; ci++) cmds[ci] = S.lever;
        } else {
          cmds[S.selected] = S.lever;
        }
      }
      if (S.autoSeq && Math.abs(S.head) <= HEAD_LIMIT) {
        for (var si = 0; si <= S.autoSeq.i; si++) {
          cmdsAuto[si] = S.autoSeq.dir;
        }
      } else if (S.autoSeq) {
        S.autoHolding = true;
      }
      for (var ai = 0; ai < 6; ai++) {
        if (cmds[ai] === 0) cmds[ai] = cmdsAuto[ai];
      }
    }

    // ---- gate motion ----
    var speedFac = S.pressure < 95 ? 0 : Math.min(1, (S.pressure - 95) / 50);
    for (var i = 0; i < 6; i++) {
      var dir = cmds[i];
      var v = 0;
      if (dir !== 0 && speedFac > 0) {
        var frozen = i === 3 && (S.skewFault || S.debrisLatched);
        if (!frozen) {
          v = (dir / TRAVEL_TIME) * speedFac;
          g[i].pos = Math.min(1, Math.max(0, g[i].pos + v * dt));
        } else if (S.skewFault) {
          S.skewAngle = Math.min(12, S.skewAngle + 4 * dt);
        }
      }
      if (i === 3 && S.skewAngle > 0 && dir === 0) {
        S.skewAngle = Math.max(0, S.skewAngle - 0.5 * dt);
      }
      g[i].moving = v !== 0;
    }
    var anyMoving =
      g[0].moving ||
      g[1].moving ||
      g[2].moving ||
      g[3].moving ||
      g[4].moving ||
      g[5].moving;

    // ---- debris strike timer ----
    if (S.debrisEta !== null && t >= S.debrisEta && !S.debrisLatched) {
      S.debrisLatched = true;
      g[3].moving = false;
    }

    // ---- structural stress ----
    // Holding a closed barrier against a full surge is what it is FOR;
    // only driving against the differential grinds the sill.
    var stressing = anyMoving && Math.abs(S.head) > HEAD_LIMIT;
    if (stressing) {
      S.stress += (Math.abs(S.head) - HEAD_LIMIT) * 6 * dt;
    } else {
      S.stress = Math.max(0, S.stress - 2 * dt);
    }
    if (S.stress >= SCOUR_LIMIT && !S.damaged) tripDamage("scour");

    // ---- impounding / overtopping ----
    if (S.river >= OVERTOP) S.overSeconds += dt;
    else S.overSeconds = Math.max(0, S.overSeconds - 2 * dt);
    if (S.overSeconds >= OVERTOP_SECONDS && !S.damaged) tripDamage("overtop");

    // ---- surge forecast ----
    if (S.mode !== "OFF") {
      var worstAnom = -Infinity;
      var worstLevel = -Infinity;
      for (var k = 0; k <= 12; k++) {
        var ft = t + (k * 120) / 12;
        worstAnom = Math.max(worstAnom, surgeAt(ft));
        worstLevel = Math.max(worstLevel, predicted(ft) + surgeAt(ft));
      }
      S.forecastSevere = worstAnom > 1.4 || worstLevel > 7.6;
    } else {
      S.forecastSevere = false;
    }

    // ---- annunciators ----
    var active = [];
    if (S.forecastSevere) active.push("SURGE FORECAST SEVERE");
    if (S.river >= HIGH_WATER) active.push("HIGH WATER UPSTREAM");
    if (
      (anyMoving && Math.abs(S.head) > HEAD_LIMIT) ||
      (S.autoHolding && Math.abs(S.head) > HEAD_LIMIT * 0.8) ||
      (!anyMoving && !S.autoHolding && Math.abs(S.head) > HEAD_WARN_PARKED)
    ) {
      active.push("DIFFERENTIAL HEAD HIGH");
    }
    if (S.dutyLockout || (S.mode === "OPERATE" && S.pressure < 120)) {
      active.push("HYD PRESSURE LOW");
    }
    if (S.skewFault) active.push("GATE 4 SKEW");
    if (S.debrisLatched) active.push("DEBRIS IMPACT");
    if (S.damaged === "scour") active.push("SCOUR DAMAGE");
    if (S.damaged === "overtop") active.push("OVERTOPPING");
    mergeAlarms(active);

    if (S.lampsTest && t > S.testProveUntil) S.lampsTest = false;
  }

  function tripDamage(cause) {
    S.damaged = cause;
    S.autoSeq = null;
    S.lever = 0;
    renderLever();
  }

  function mergeAlarms(active) {
    var i;
    for (i = 0; i < active.length; i++) {
      if (S.alarms.indexOf(active[i]) === -1) {
        S.alarms.push(active[i]);
        flashSet.add(active[i]);
        hornLatched = true;
      }
    }
    for (i = S.alarms.length - 1; i >= 0; i--) {
      if (active.indexOf(S.alarms[i]) === -1) {
        var gone = S.alarms[i];
        S.alarms.splice(i, 1);
        flashSet.delete(gone);
      }
    }
  }

  /* --------------------------------------------------------------- the API */

  window.machine = {
    name: "Trethellan Sound Surge Barrier",
    faults: [FAULT_SKEW, FAULT_PUMP, FAULT_DEBRIS],

    state: function () {
      return {
        elapsed: round3(t),
        mode: S.mode,
        sea: round3(S.sea),
        river: round3(S.river),
        head: round3(S.head),
        discharge: Math.round(S.discharge),
        pressure: Math.round(S.pressure),
        surgeForecastSevere: S.forecastSevere,
        impounded: S.impounded,
        sluiceTurns: round2(S.sluiceTurns),
        gates: S.gates.map(function (gate) {
          return { position: round3(gate.pos), moving: gate.moving };
        }),
        selectedGate: S.selected === 6 ? "ALL" : "GATE " + (S.selected + 1),
        lever: ["LOWER", "HOLD", "RAISE"][S.lever + 1],
        dutyPumpRunning: S.dutyOn && !S.dutyLockout,
        standbyPumpRunning: S.standbyOn,
        dutyLockout: S.dutyLockout,
        skewFault: S.skewFault,
        skewAngle: round2(S.skewAngle),
        debrisImpact: S.debrisLatched,
        scourStress: round2(S.stress),
        damaged: S.damaged,
        alarms: S.alarms.slice(),
      };
    },

    tick: tick,

    inject: function (fault) {
      if (fault === FAULT_SKEW) {
        S.skewFault = true;
      } else if (fault === FAULT_PUMP) {
        S.dutyLockout = true;
        S.dutyOn = false;
      } else if (fault === FAULT_DEBRIS) {
        S.debrisEta = t + 18;
      }
    },

    reset: function () {
      coldReset();
      renderLever();
      syncSwitchesFromPlant();
    },
  };

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /* ------------------------------------------------------------ panel work */

  var flashSet = new Set();
  var hornLatched = false;
  var hornSilenced = false;

  function $(sel) {
    return document.querySelector(sel);
  }

  var el = {
    clock: $("#clock"),
    modeChip: $("#modeChip"),
    beacon: $("#beacon"),
    seaLevel: $("#seaLevel"),
    seaTrend: $("#seaTrend"),
    predHw: $("#predHw"),
    riverLevel: $("#riverLevel"),
    riverQ: $("#riverQ"),
    impoundBadge: $("#impoundBadge"),
    seaFill: $("#seaFill"),
    riverFill: $("#riverFill"),
    seaLine: $("#seaLine"),
    riverLine: $("#riverLine"),
    gateG: $("#gateG"),
    scales: $("#scales"),
    headArrows: $("#headArrows"),
    gateStrip: $("#gateStrip"),
    gateBars: $("#gateBars"),
    chart: $("#chartCanvas"),
    drum: $("#drumCanvas"),
    drumWidget: $("#drumWidget"),
    drumNeedle: $("#drumNeedle"),
    needleVal: $("#needleVal"),
    amendSlip: $("#amendSlip"),
    drumHome: $("#drumHome"),
    acceptBtn: $("#acceptBtn"),
    hornBtn: $("#hornBtn"),
    lampsBtn: $("#lampsBtn"),
    soundBtn: $("#soundBtn"),
    headNeedle: $("#headNeedle"),
    pressNeedle: $("#pressNeedle"),
    gateSelector: $("#gateSelector"),
    gateSelectorKnob: $("#gateSelectorKnob"),
    gateSelectorRead: $("#gateSelectorRead"),
    leverHandle: $("#leverHandle"),
    leverZones: {
      "-1": $("#leverLower"),
      0: $("#leverHold"),
      1: $("#leverRaise"),
    },
    surgeGuard: $("#surgeGuard"),
    surgeCloseBtn: $("#surgeCloseBtn"),
    openAllBtn: $("#openAllBtn"),
    sluiceWheel: $("#sluiceWheel"),
    sluiceWheelSpin: $("#sluiceWheelSpin"),
    sluiceTurns: $("#sluiceTurns"),
    dutyPump: $("#dutyPump"),
    standbyPump: $("#standbyPump"),
    testPanel: $("#testPanel"),
    testPanelLid: $("#testPanelLid"),
    skewResetBtn: $("#skewResetBtn"),
    debrisClearBtn: $("#debrisClearBtn"),
    maintenanceReset: $("#maintenanceReset"),
  };

  var FAULT_BY_CONTROL = {
    "TEST GATE SKEW": FAULT_SKEW,
    "TEST PUMP TRIP": FAULT_PUMP,
    "TEST DEBRIS STRIKE": FAULT_DEBRIS,
  };
  el.testSwitches = {};
  ["#testSkew", "#testPump", "#testDebris"].forEach(function (sel) {
    var sw = $(sel);
    el.testSwitches[FAULT_BY_CONTROL[sw.getAttribute("data-control")]] = sw;
  });

  // ---- build mimic gates, scales, indicator strips, rotary ticks ----

  var NS = "http://www.w3.org/2000/svg";
  var BAY_X0 = 214;
  var PITCH = 36;
  var LEAF_W = 24;
  var SILL_Y = 236;
  var PX_PER_M = 16;
  var MAX_GATE_HEIGHT = 126;

  function svgEl(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function levelY(m) {
    return 208 - m * PX_PER_M;
  }

  var gateEls = [];
  for (var gi = 0; gi < 6; gi++) {
    var gx = BAY_X0 + gi * PITCH + (PITCH - LEAF_W) / 2;
    var grp = svgEl("g", {});
    var leaf = svgEl("rect", {
      x: gx,
      y: SILL_Y,
      width: LEAF_W,
      height: 2,
      rx: 2,
      class: "gate-leaf",
    });
    grp.appendChild(leaf);
    grp.appendChild(
      svgEl("circle", {
        cx: gx + LEAF_W / 2,
        cy: SILL_Y + 3,
        r: 2.4,
        class: "gate-pin",
      }),
    );
    el.gateG.appendChild(grp);
    gateEls.push(leaf);
  }

  for (var m = 0; m <= 8; m += 2) {
    var sy = levelY(m);
    el.scales.appendChild(
      svgEl("line", { x1: 118, y1: sy, x2: 522, y2: sy, class: "scale-line" }),
    );
    var lbl = svgEl("text", { x: 528, y: sy + 3, class: "scale-text" });
    lbl.textContent = m + "m";
    el.scales.appendChild(lbl);
  }

  var stripItems = [];
  for (var si = 0; si < 6; si++) {
    var inner =
      '<span class="gbar-name">G' +
      (si + 1) +
      "</span>" +
      '<span class="gbar-track"><span class="gbar-fill"></span></span>' +
      '<span class="gbar-val mono">0%</span>' +
      '<span class="gbar-skewflag">SKEW</span>';
    var wallBox = document.createElement("div");
    wallBox.className = "gbar";
    wallBox.innerHTML = inner;
    el.gateStrip.appendChild(wallBox);
    var deskBox = document.createElement("div");
    deskBox.className = "desk-gbar gbar";
    deskBox.innerHTML = inner;
    el.gateBars.appendChild(deskBox);
    stripItems.push({ wall: wallBox, desk: deskBox });
  }

  for (var ti = 0; ti < 7; ti++) {
    var tickEl = document.createElement("span");
    tickEl.className = "rotary-tick";
    tickEl.style.transform =
      "rotate(" + (-135 + (ti * 270) / 6) + "deg) translateY(-40px)";
    el.gateSelector.appendChild(tickEl);
  }

  /* -------------------------------------------------------------- controls */

  function setMode(mode) {
    S.mode = mode;
    if (mode !== "OPERATE") {
      S.autoSeq = null;
      S.lever = 0;
      renderLever();
    }
    if (mode === "TEST") {
      S.lampsTest = true;
      S.testProveUntil = t + 2.2;
    }
    if (mode === "OFF") {
      S.dutyOn = false;
      S.standbyOn = false;
    }
    clack();
  }

  function stepMode() {
    var next =
      S.mode === "OFF" ? "TEST" : S.mode === "TEST" ? "OPERATE" : "TEST";
    if (next === "OPERATE" && S.damaged) return;
    setMode(next);
  }

  el.modeChip.addEventListener("click", stepMode);
  el.modeChip.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      stepMode();
    }
  });

  // ---- gate selector rotary ----

  var SELECTOR_LABELS = ["G1", "G2", "G3", "G4", "G5", "G6", "ALL"];

  function selectorStep(delta) {
    S.selected = (S.selected + delta + 7) % 7;
    clack();
  }

  el.gateSelector.addEventListener("click", function () {
    selectorStep(S.selected === 6 ? -6 : 1);
  });
  el.gateSelector.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      selectorStep(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      selectorStep(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      S.selected = 6;
    }
  });

  // ---- drive lever ----

  function setLever(dir) {
    if (S.mode !== "OPERATE" || S.damaged) dir = 0;
    if (S.lever !== dir) clack();
    S.lever = dir;
    renderLever();
  }

  function renderLever() {
    if (!el.leverZones) return;
    [-1, 0, 1].forEach(function (key) {
      el.leverZones[key].classList.toggle("is-active", key === S.lever);
    });
    el.leverHandle.style.top =
      (S.lever === 1 ? 4 : S.lever === 0 ? 40 : 76) + "px";
  }

  [-1, 0, 1].forEach(function (dir) {
    var btn = el.leverZones[dir];
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      setLever(dir);
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setLever(dir);
      }
    });
  });
  document.addEventListener("pointerup", function () {
    if (S.lever !== 0) setLever(0);
  });

  document.addEventListener("keydown", function (e) {
    var target = e.target;
    if (
      target === el.gateSelector ||
      el.drumWidget.contains(target) ||
      el.sluiceWheel.contains(target)
    ) {
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setLever(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setLever(-1);
    } else if (e.key === " ") {
      e.preventDefault();
      setLever(0);
    }
  });
  document.addEventListener("keyup", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (S.lever !== 0) setLever(0);
    }
  });

  // ---- guarded SURGE CLOSE ----

  var guardTimer = null;

  function openGuard() {
    el.surgeGuard.classList.add("is-open");
    el.surgeCloseBtn.disabled = false;
    clearTimeout(guardTimer);
    guardTimer = setTimeout(closeGuard, 9000);
  }

  function closeGuard() {
    el.surgeGuard.classList.remove("is-open");
    el.surgeCloseBtn.disabled = true;
  }

  el.surgeGuard.addEventListener("click", openGuard);
  el.surgeGuard.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openGuard();
    }
  });
  el.surgeCloseBtn.addEventListener("click", function () {
    if (S.mode === "OPERATE" && !S.damaged) {
      S.autoSeq = { dir: 1, i: 0 };
      clack();
    }
    closeGuard();
  });

  el.openAllBtn.addEventListener("click", function () {
    if (S.mode === "OPERATE" && !S.damaged) {
      S.autoSeq = { dir: -1, i: 0 };
      clack();
    }
  });

  // ---- sluice handwheel ----

  function sluiceSet(turns) {
    S.sluiceTurns = Math.max(0, Math.min(5, turns));
  }

  var sluiceDragState = null;

  el.sluiceWheel.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    sluiceDragState = { x: e.clientX, start: S.sluiceTurns };
  });
  document.addEventListener("pointermove", function (e) {
    if (!sluiceDragState) return;
    sluiceSet(sluiceDragState.start + (sluiceDragState.x - e.clientX) / 46);
  });
  document.addEventListener("pointerup", function () {
    sluiceDragState = null;
  });
  el.sluiceWheel.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      sluiceSet(S.sluiceTurns - 0.25);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      sluiceSet(S.sluiceTurns + 0.25);
    }
  });

  // ---- pumps ----

  el.dutyPump.addEventListener("click", function () {
    if (S.mode !== "OPERATE") return;
    if (S.dutyLockout) {
      // recycling the breaker clears the trip lockout; it stays stopped
      S.dutyLockout = false;
    } else {
      S.dutyOn = !S.dutyOn;
    }
    clack();
  });

  el.standbyPump.addEventListener("click", function () {
    if (S.mode !== "OPERATE") return;
    S.standbyOn = !S.standbyOn;
    clack();
  });

  // ---- fault test panel ----

  el.testPanelLid.addEventListener("click", function () {
    var open = el.testPanel.classList.toggle("is-open");
    el.testPanelLid.setAttribute("aria-expanded", String(open));
  });

  Object.keys(el.testSwitches).forEach(function (fault) {
    el.testSwitches[fault].addEventListener("click", function () {
      var sw = el.testSwitches[fault];
      if (sw.getAttribute("aria-checked") !== "true") {
        window.machine.inject(fault);
      }
      sw.setAttribute("aria-checked", "true"); // render() keeps it honest
      clack();
    });
  });

  // ---- recovery ----

  el.skewResetBtn.addEventListener("click", function () {
    if (!S.skewFault) return;
    var driving = S.lever !== 0 || (S.autoSeq && S.autoSeq.i === 3);
    if (Math.abs(S.head) <= 1.2 && !driving) {
      S.skewFault = false;
      S.skewAngle = 0;
      clack();
    }
  });

  var debrisHold = null;

  function debrisStart(e) {
    if (!S.debrisLatched || debrisHold) return;
    if (e.cancelable) e.preventDefault();
    debrisHold = setTimeout(function () {
      S.debrisLatched = false;
      S.debrisEta = null;
      debrisHold = null;
      clack();
    }, 2000);
  }

  function debrisCancel() {
    if (debrisHold) {
      clearTimeout(debrisHold);
      debrisHold = null;
    }
  }

  el.debrisClearBtn.addEventListener("pointerdown", debrisStart);
  el.debrisClearBtn.addEventListener("pointerup", debrisCancel);
  el.debrisClearBtn.addEventListener("pointerleave", debrisCancel);
  el.debrisClearBtn.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") debrisStart(e);
  });
  el.debrisClearBtn.addEventListener("keyup", debrisCancel);

  el.maintenanceReset.addEventListener("click", function () {
    window.machine.reset();
    clack();
  });

  function syncSwitchesFromPlant() {
    el.dutyPump.setAttribute("aria-checked", String(S.dutyOn));
    el.standbyPump.setAttribute("aria-checked", String(S.standbyOn));
    Object.keys(el.testSwitches).forEach(function (f) {
      el.testSwitches[f].setAttribute("aria-checked", "false");
    });
    closeGuard();
  }

  // ---- annunciator buttons ----

  el.acceptBtn.addEventListener("click", function () {
    flashSet.clear();
    hornSilenced = false;
    clack();
  });

  el.hornBtn.addEventListener("click", function () {
    hornSilenced = true;
    stopHorn();
    clack();
  });

  el.lampsBtn.addEventListener("click", function () {
    S.lampsTest = true;
    S.testProveUntil = t + 1.6;
  });

  // ---- sound ----

  var audio = {
    ctx: null,
    enabled: false,
    humGain: null,
    humOsc: null,
    hornOsc: null,
    hornLfo: null,
  };

  function ensureAudio() {
    if (audio.ctx) return true;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new Ctx();
      audio.humGain = audio.ctx.createGain();
      audio.humGain.gain.value = 0;
      audio.humGain.connect(audio.ctx.destination);
      audio.humOsc = audio.ctx.createOscillator();
      audio.humOsc.type = "sine";
      audio.humOsc.frequency.value = 58;
      audio.humOsc.connect(audio.humGain);
      audio.humOsc.start();
      return true;
    } catch (err) {
      audio.ctx = null;
      return false;
    }
  }

  function clack() {
    if (!audio.enabled || !ensureAudio()) return;
    try {
      var ctx = audio.ctx;
      var len = Math.floor(ctx.sampleRate * 0.03);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }
      var burst = ctx.createBufferSource();
      burst.buffer = buf;
      var gain = ctx.createGain();
      gain.gain.value = 0.1;
      burst.connect(gain);
      gain.connect(ctx.destination);
      burst.start();
    } catch (err) {
      /* sound is decorative; never let it trip the panel */
    }
  }

  function startHorn() {
    if (!audio.enabled || !ensureAudio() || audio.hornOsc) return;
    try {
      var ctx = audio.ctx;
      var hornGain = ctx.createGain();
      hornGain.gain.value = 0;
      hornGain.connect(ctx.destination);
      audio.hornOsc = ctx.createOscillator();
      audio.hornOsc.type = "square";
      audio.hornOsc.frequency.value = 600;
      audio.hornLfo = ctx.createOscillator();
      audio.hornLfo.type = "square";
      audio.hornLfo.frequency.value = 2.2;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 150;
      audio.hornLfo.connect(lfoGain);
      lfoGain.connect(audio.hornOsc.frequency);
      audio.hornOsc.connect(hornGain);
      audio.hornOsc.start();
      audio.hornLfo.start();
      hornGain.gain.setTargetAtTime(0.04, ctx.currentTime, 0.05);
    } catch (err) {
      stopHorn();
    }
  }

  function stopHorn() {
    try {
      if (audio.hornOsc) audio.hornOsc.stop();
      if (audio.hornLfo) audio.hornLfo.stop();
    } catch (err) {
      /* already stopped */
    }
    audio.hornOsc = null;
    audio.hornLfo = null;
  }

  el.soundBtn.addEventListener("click", function () {
    audio.enabled = !audio.enabled;
    el.soundBtn.textContent = audio.enabled ? "SOUND ON" : "SOUND OFF";
    el.soundBtn.setAttribute("aria-pressed", String(audio.enabled));
    if (audio.enabled) {
      ensureAudio();
      if (audio.ctx && audio.ctx.state === "suspended") audio.ctx.resume();
    } else {
      stopHorn();
      if (audio.humGain) audio.humGain.gain.value = 0;
    }
  });

  // ---- tide drum ----

  var drumOffsetDays = 0;

  function drumSet(offset) {
    drumOffsetDays = Math.max(-7, Math.min(7, offset));
  }

  var drumDrag = null;
  el.drumWidget.addEventListener("pointerdown", function (e) {
    drumDrag = { x: e.clientX, start: drumOffsetDays };
  });
  el.drumWidget.addEventListener("pointermove", function (e) {
    if (drumDrag) drumSet(drumDrag.start + (drumDrag.x - e.clientX) / 90);
  });
  el.drumWidget.addEventListener("pointerup", function () {
    drumDrag = null;
  });
  el.drumWidget.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      drumSet(drumOffsetDays + (e.deltaY + e.deltaX) / 600);
    },
    { passive: false },
  );
  el.drumWidget.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      drumSet(drumOffsetDays - 0.25);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      drumSet(drumOffsetDays + 0.25);
    }
  });
  el.drumHome.addEventListener("click", function (e) {
    e.stopPropagation();
    drumSet(0);
  });

  function drawDrum() {
    var c = el.drum;
    var ctx = c.getContext("2d");
    var W = c.width;
    var H = c.height;
    ctx.fillStyle = "#f4efdd";
    ctx.fillRect(0, 0, W, H);

    var spanDays = 5;
    var centreDays = t / DAY + drumOffsetDays;
    var pxPerDay = W / spanDays;
    var m0 = centreDays * DAY - (spanDays / 2) * DAY;
    var levelToY = function (lvl) {
      return 22 + (1 - lvl / 10) * (H - 46);
    };

    // day ruling
    ctx.font = "10px Consolas, monospace";
    var firstDay = Math.floor(centreDays - spanDays / 2);
    for (var d = firstDay; d <= firstDay + spanDays + 1; d++) {
      var x = (d - centreDays) * pxPerDay + W / 2;
      if (x < -30 || x > W + 30) continue;
      ctx.strokeStyle = "rgba(90,80,50,0.28)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = "#7a6f52";
      ctx.fillText("DAY " + (d + 1), x + 5, 13);
      ctx.strokeStyle = "rgba(90,80,50,0.14)";
      ctx.lineWidth = 1;
      for (var hh = 3; hh < 24; hh += 3) {
        var xt = x + (hh / 24) * pxPerDay;
        ctx.beginPath();
        ctx.moveTo(xt, H - 10);
        ctx.lineTo(xt, H);
        ctx.stroke();
      }
    }

    // the printed prediction curve
    ctx.strokeStyle = "#41508f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var px = 0; px <= W; px += 2) {
      var mt = m0 + (px / W) * spanDays * DAY;
      var y = levelToY(predicted(mt));
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();

    // high-water rings at every semidiurnal maximum
    ctx.strokeStyle = "#41508f";
    ctx.lineWidth = 1.2;
    var kStart = Math.floor((m0 - 75) / 300);
    for (var k = kStart; k < kStart + spanDays * 5; k++) {
      var hwT = 300 * k + 75;
      var hx = ((hwT - m0) / (spanDays * DAY)) * W;
      if (hx < -4 || hx > W + 4) continue;
      ctx.beginPath();
      ctx.arc(hx, levelToY(predicted(hwT)), 3, 0, TAU);
      ctx.stroke();
    }

    // roller shading
    var shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, "rgba(60,50,20,0.30)");
    shade.addColorStop(0.16, "rgba(60,50,20,0)");
    shade.addColorStop(0.84, "rgba(60,50,20,0)");
    shade.addColorStop(1, "rgba(60,50,20,0.34)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    el.drumWidget.setAttribute(
      "aria-valuenow",
      String(Math.round(drumOffsetDays)),
    );
    el.drumWidget.setAttribute(
      "aria-valuetext",
      drumOffsetDays === 0
        ? "reading now"
        : Math.abs(drumOffsetDays).toFixed(1) +
            " days " +
            (drumOffsetDays > 0 ? "forward" : "back"),
    );
  }

  /* ------------------------------------------------------------- rendering */

  var trendPrev = predicted(0);

  function fmtClock() {
    var base = Date.UTC(2026, 9, 14, 5, 0, 0);
    var ms = base + t * 44.7 * 1000;
    var d = new Date(ms);
    var day = Math.floor((ms - base) / DAY_MS) + 1;
    function p2(n) {
      return (n < 10 ? "0" : "") + n;
    }
    return (
      "DAY " +
      day +
      " \u00b7 " +
      p2(d.getUTCHours()) +
      ":" +
      p2(d.getUTCMinutes())
    );
  }
  var DAY_MS = 86400000;

  function nextHWLabel() {
    for (var ahead = 60; ahead <= 3600; ahead += 15) {
      var a = predicted(t + ahead - 15);
      var b = predicted(t + ahead);
      var c = predicted(t + ahead + 15);
      if (b > a && b >= c) return "HW IN " + Math.round(ahead / 60) + " MIN";
    }
    return "--:--";
  }

  function render() {
    el.clock.textContent = fmtClock();
    el.beacon.classList.toggle("is-alarm", !!S.damaged);

    var chip = "";
    var cls = "";
    if (S.damaged === "overtop") {
      chip = "OVERTOPPED - OUT OF SERVICE";
      cls = "is-tripped";
    } else if (S.damaged === "scour") {
      chip = "SCOUR DAMAGE - OUT OF SERVICE";
      cls = "is-tripped";
    } else if (averagePos() > 0.97) {
      chip = "BARRIER CLOSED";
      cls = "is-closed";
    } else if (averagePos() > 0.03) {
      chip = "GATES IN TRAVEL";
      cls = "is-closed";
    } else {
      chip = "BARRIER OPEN";
    }
    if (S.mode !== "OFF") chip = "[" + S.mode + "] " + chip;
    el.modeChip.textContent = chip;
    el.modeChip.className = "modechip " + cls;

    el.seaLevel.textContent = S.sea.toFixed(2);
    var rising = S.sea >= trendPrev;
    el.seaTrend.textContent = rising ? "\u25b2 RISING" : "\u25bc FALLING";
    trendPrev = S.sea;
    el.predHw.textContent = nextHWLabel();
    el.riverLevel.textContent = S.river.toFixed(2);
    el.riverQ.textContent = String(Math.round(S.discharge));
    el.impoundBadge.textContent = S.impounded
      ? "IMPOUNDED - FLUME SHUT"
      : "PASSING TIDE";

    var seaY = levelY(S.sea);
    var rivY = levelY(S.river);
    el.seaFill.setAttribute("y", seaY);
    el.seaFill.setAttribute("height", 260 - seaY);
    el.riverFill.setAttribute("y", rivY);
    el.riverFill.setAttribute("height", 260 - rivY);
    el.seaLine.setAttribute("y1", seaY);
    el.seaLine.setAttribute("y2", seaY);
    el.riverLine.setAttribute("y1", rivY);
    el.riverLine.setAttribute("y2", rivY);

    for (var i = 0; i < 6; i++) {
      var pos = S.gates[i].pos;
      var h = 2 + pos * MAX_GATE_HEIGHT;
      var leaf = gateEls[i];
      leaf.setAttribute("y", SILL_Y - h);
      leaf.setAttribute("height", h);
      var jammedHere = i === 3 && (S.skewFault || S.debrisLatched);
      leaf.setAttribute(
        "class",
        "gate-leaf" + (jammedHere ? " is-jammed" : ""),
      );
      var pct = Math.round(pos * 100);
      [stripItems[i].wall, stripItems[i].desk].forEach(function (box) {
        box.querySelector(".gbar-fill").style.height = pct + "%";
        box.querySelector(".gbar-val").textContent = pct + "%";
        box.classList.toggle("is-moving", S.gates[i].moving);
        box.classList.toggle("is-skewed", i === 3 && S.skewFault);
      });
    }

    renderHeadArrows();
    renderGauges();
    renderAnnunciators();

    el.gateSelectorKnob.style.transform =
      "rotate(" + (-135 + (S.selected * 270) / 6) + "deg)";
    el.gateSelectorRead.textContent = SELECTOR_LABELS[S.selected];
    el.gateSelector.setAttribute("aria-valuenow", String(S.selected));
    el.gateSelector.setAttribute(
      "aria-valuetext",
      S.selected === 6 ? "ALL GATES" : "GATE " + (S.selected + 1),
    );

    el.sluiceTurns.textContent = S.sluiceTurns.toFixed(1);
    el.sluiceWheelSpin.setAttribute(
      "transform",
      "rotate(" + S.sluiceTurns * -137 + " 50 50)",
    );
    el.sluiceWheel.setAttribute("aria-valuenow", String(round2(S.sluiceTurns)));
    el.sluiceWheel.setAttribute(
      "aria-valuetext",
      S.sluiceTurns < 0.05 ? "shut" : S.sluiceTurns.toFixed(1) + " turns open",
    );

    el.dutyPump.setAttribute("aria-checked", String(S.dutyOn));
    el.standbyPump.setAttribute("aria-checked", String(S.standbyOn));
    el.testSwitches[FAULT_SKEW].setAttribute(
      "aria-checked",
      String(S.skewFault),
    );
    el.testSwitches[FAULT_PUMP].setAttribute(
      "aria-checked",
      String(S.dutyLockout),
    );
    el.testSwitches[FAULT_DEBRIS].setAttribute(
      "aria-checked",
      String(S.debrisLatched || (S.debrisEta !== null && t < S.debrisEta)),
    );

    el.amendSlip.hidden = !S.forecastSevere;

    var scale = el.drum.clientHeight / 190 || 1;
    el.drumNeedle.style.top =
      (22 + (1 - S.sea / 10) * (190 - 46)) * scale + "px";
    el.needleVal.textContent = S.sea.toFixed(2);

    drawChart();
    drawDrum();
    renderSound();
  }

  function renderHeadArrows() {
    while (el.headArrows.firstChild) {
      el.headArrows.removeChild(el.headArrows.firstChild);
    }
    if (Math.abs(S.head) < 0.15) return;
    var yMid = levelY((S.sea + S.river) / 2) + 44;
    var toRiver = S.head > 0;
    var x1 = toRiver ? 452 : 188;
    var x2 = toRiver ? 494 : 146;
    el.headArrows.appendChild(
      svgEl("line", {
        x1: x1,
        y1: yMid,
        x2: x2,
        y2: yMid,
        class: "head-arrow-line",
      }),
    );
    var tipX = toRiver ? x2 : x1;
    var dirX = toRiver ? 1 : -1;
    el.headArrows.appendChild(
      svgEl("path", {
        d:
          "M" +
          tipX +
          " " +
          (yMid - 4) +
          " l" +
          8 * dirX +
          " 4 l" +
          -8 * dirX +
          " 4 Z",
        fill: "#e8b34a",
      }),
    );
    var txt = svgEl("text", {
      x: (x1 + x2) / 2,
      y: yMid - 9,
      "text-anchor": "middle",
      class: "head-arrow-text",
    });
    txt.textContent = Math.abs(S.head).toFixed(1) + " m";
    el.headArrows.appendChild(txt);
  }

  function renderGauges() {
    var frac = Math.max(-1, Math.min(1, S.head / 4));
    el.headNeedle.style.transform = "rotate(" + frac * 78 + "deg)";
    var pf = Math.max(0, Math.min(1, S.pressure / 250));
    el.pressNeedle.style.transform = "rotate(" + (-114 + pf * 228) + "deg)";
  }

  function renderAnnunciators() {
    ALARM_LIST.forEach(function (name) {
      var node = document.querySelector('[data-ann="' + name + '"]');
      if (!node) return;
      node.classList.remove(
        "state-flash",
        "state-steady",
        "state-amber",
        "lamp-test",
      );
      if (S.lampsTest) {
        node.classList.add("lamp-test");
        return;
      }
      if (S.alarms.indexOf(name) === -1) return;
      if (AMBER_ALARMS.indexOf(name) !== -1) node.classList.add("state-amber");
      node.classList.add(flashSet.has(name) ? "state-flash" : "state-steady");
    });
  }

  function renderSound() {
    if (!audio.ctx) return;
    var wantHum = audio.enabled && (S.dutyOn || S.standbyOn) && S.pressure > 40;
    if (audio.humGain) {
      audio.humGain.gain.setTargetAtTime(
        wantHum ? 0.02 : 0,
        audio.ctx.currentTime,
        0.4,
      );
    }
    var hornWanted =
      audio.enabled && !hornSilenced && hornLatched && flashSet.size > 0;
    if (hornWanted && !audio.hornOsc) startHorn();
    if (!hornWanted && audio.hornOsc) stopHorn();
    if (flashSet.size === 0) hornLatched = false;
  }

  // ---- wall chart ----

  var trace = [];
  var lastTraceAt = -Infinity;

  function recordTrace() {
    if (t - lastTraceAt < 2) return;
    lastTraceAt = t;
    trace.push({ t: t, sea: S.sea, river: S.river });
    while (trace.length && trace[0].t < t - 1250) trace.shift();
  }

  function drawChart() {
    var c = el.chart;
    var ctx = c.getContext("2d");
    var W = c.width;
    var H = c.height;
    ctx.fillStyle = "#10171b";
    ctx.fillRect(0, 0, W, H);

    var SPAN = 1200;
    var xOf = function (mt) {
      return ((mt - (t - SPAN / 2)) / SPAN) * W;
    };
    var yOf = function (lvl) {
      return 8 + (1 - lvl / 10) * (H - 20);
    };

    ctx.strokeStyle = "#1d2930";
    ctx.lineWidth = 1;
    ctx.font = "9px Consolas, monospace";
    for (var m = 0; m <= 10; m += 2) {
      ctx.beginPath();
      ctx.moveTo(0, yOf(m));
      ctx.lineTo(W, yOf(m));
      ctx.stroke();
      ctx.fillStyle = "#54666e";
      ctx.fillText(m + "m", 4, yOf(m) - 3);
    }

    ctx.strokeStyle = "#d0342a";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yOf(HIGH_WATER));
    ctx.lineTo(W, yOf(HIGH_WATER));
    ctx.stroke();

    ctx.strokeStyle = "#5f7680";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (var px = 0; px <= W; px += 3) {
      var mt = t - SPAN / 2 + (px / W) * SPAN;
      var y = yOf(predicted(mt));
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    var drawTrace = function (key, colour) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      var started = false;
      var lastX = 0;
      var lastPt = null;
      for (var i = 0; i < trace.length; i++) {
        var pt = trace[i];
        lastPt = pt;
        var x = xOf(pt.t);
        if (x < -4) continue;
        lastX = x;
        if (!started) {
          ctx.moveTo(x, yOf(pt[key]));
          started = true;
        } else {
          ctx.lineTo(x, yOf(pt[key]));
        }
      }
      if (started && lastPt) ctx.lineTo(xOf(t), yOf(lastPt[key]));
    };
    drawTrace("sea", "#7fc4de");
    drawTrace("river", "#86d8ab");

    ctx.strokeStyle = "#3d4d55";
    ctx.beginPath();
    ctx.moveTo(xOf(t), 0);
    ctx.lineTo(xOf(t), H);
    ctx.stroke();
    ctx.fillStyle = "#93a7ae";
    ctx.fillText("NOW", xOf(t) + 4, 12);
  }

  /* ------------------------------------------------------------------- loop */

  var rafId = null;
  var lastFrame = null;
  var renderAcc = 0;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (lastFrame === null) lastFrame = now;
    var dt = Math.min((now - lastFrame) / 1000, 2);
    lastFrame = now;
    tick(dt);
    recordTrace();
    renderAcc += dt;
    if (renderAcc > 0.12) {
      renderAcc = 0;
      render();
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      stopHorn();
    } else {
      lastFrame = null;
      if (rafId === null) rafId = requestAnimationFrame(frame);
    }
  });

  // ---- manual dialog ----

  var dialog = $("dialog[data-manual]");
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="manual"]'),
    function (btn) {
      btn.addEventListener("click", function () {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      });
    },
  );
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="close-manual"]'),
    function (btn) {
      btn.addEventListener("click", function () {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      });
    },
  );

  /* ------------------------------------------------------------------ go */

  renderLever();
  syncSwitchesFromPlant();
  render();
  rafId = requestAnimationFrame(frame);
})();
