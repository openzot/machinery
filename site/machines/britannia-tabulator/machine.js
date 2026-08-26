/*
 * Britannia Meridian IV — punched-card accounting machine, rates bureau, 1953.
 * Sea-green enamel office iron: hand-wired plugboard, mechanical counters,
 * wire-matrix printer. No glow, no network, no dependencies.
 */
(function () {
  "use strict";

  var MACHINE_NAME = "Britannia Meridian IV";
  var NOMINAL_RPM = 1440;
  var DECK_SIZE = 800;
  var GROUP_EVERY = 20;

  var FAULTS = [
    "card jam in the feed throat",
    "reading-brush misregister",
    "counter carry failure",
  ];

  /* ---------------- deterministic card deck ---------------- */

  function hash32(n) {
    n = n | 0;
    n = Math.imul(n ^ 0x9e3779b9, 2654435761);
    n = Math.imul(n ^ (n >>> 15), 2246822519);
    n = (n ^ (n >>> 13)) >>> 0;
    return n;
  }

  var STREETS = [
    "ASHFIELD ROW",
    "BELLE VUE TCE",
    "CANNON YARD",
    "DEANSGATE",
    "ELM WALK",
    "FETTER LANE",
    "GORSE VALE",
    "HOLLOWMEAD",
  ];

  var WARDS = [
    "NORTH",
    "RIVER",
    "MARKET",
    "CASTLE",
    "PRIORY",
    "MOOR",
    "TOWN",
    "HILL",
  ];

  function cardData(i) {
    var h = hash32(i * 7 + 11);
    var valuePence = 1800 + (h % 48000); // rateable value in old pence
    var waterPence = 120 + ((h >>> 8) % 3600);
    var street = STREETS[(h >>> 3) % STREETS.length];
    var ward = WARDS[i % WARDS.length];
    var pounds = Math.floor(valuePence / 240);
    var shillings = Math.floor((valuePence % 240) / 12);
    var pence = valuePence % 12;
    return {
      i: i,
      ward: ward,
      street: street,
      valuePence: valuePence,
      waterPence: waterPence,
      label:
        pad(String(i + 1).slice(-4), 4) +
        " " +
        pad(street, 13) +
        " " +
        String(pounds).padStart(5, " ") +
        "  " +
        pad(String(shillings), 2) +
        "s" +
        pad(String(pence), 2) +
        "d",
    };
  }

  function pad(s, n) {
    s = String(s).slice(0, n);
    while (s.length < n) s += " ";
    return s;
  }

  function lsd(penceTotal) {
    var lb = Math.floor(penceTotal / 240);
    var sh = Math.floor((penceTotal % 240) / 12);
    var pe = penceTotal % 12;
    return lb + "LB " + pad(sh, 2) + "S " + pad(pe, 2) + "D";
  }

  /* ---------------- simulation state ---------------- */

  var S = {};

  function coldState() {
    S = {
      t: 0,
      mains: false,
      starterLatched: false,
      tripped: false,
      rpm: 0,
      tempC: 18,
      foulingPct: 0,
      vacuum: 0,

      clutchPos: 0, // 0 release, 1 single, 2 run
      singlePending: false,
      feedRunning: false,
      interCardTimer: 0,

      hopper: DECK_SIZE,
      fed: 0,
      stacked: 0,
      torn: 0,
      linesPrinted: 0,

      counters: [0, 0, 0, 0],
      groupSum1: 0,
      groupSum2: 0,
      groupCount: 0,

      selectedCounter: 0,

      wires: {}, // "a|b" -> true
      armedHub: null,

      brushAdjust: 10,
      brushIdeal: 10,
      readCheckPct: 96,
      skewEvents: 0,

      jammed: false,
      jamAlarmPending: false,
      feedSeized: false,
      misreadActive: false,
      carryCounter: -1,
      carryActive: false,
      carryAlarmPending: false,
      misreadAlarmPending: false,

      figuresSuspect: false,
      overloadAlarm: false,

      alarms: [],
      lampsTestUntil: 0,
      tapeLines: [],
      statusMsg: "machine cold",
      alarming: false,
      soundCut: false,
    };
  }

  coldState();

  var ALARM_JAM = "FEED JAM";
  var ALARM_READ = "READ CHECK";
  var ALARM_CARRY = "CARRY CHECK";
  var ALARM_OVERLOAD = "MOTOR OVERLOAD";

  function setAlarm(name, on) {
    var i = S.alarms.indexOf(name);
    if (on && i === -1) S.alarms.push(name);
    if (!on && i !== -1) S.alarms.splice(i, 1);
    S.alarming = S.alarms.length > 0;
  }

  /* ---------------- the fixed API ---------------- */

  function state() {
    return {
      name: MACHINE_NAME,
      secondsRun: round2(S.t),
      mains: S.mains,
      motorRunning: motorRunning(),
      motorRpm: round2(S.rpm),
      motorTempC: round1(S.tempC),
      motorCurrentA: round1(motorCurrent()),
      vacuumInH2O: round2(S.vacuum),
      filterFoulingPct: round1(S.foulingPct),
      clutch: CLUTCH_POS[S.clutchPos],
      feedRunning: S.feedRunning,
      feedRatePerMin: round1(feedRate()),
      hopperCards: S.hopper,
      cardsFed: S.fed,
      cardsTorn: S.torn,
      stackerCards: S.stacked,
      linesPrinted: S.linesPrinted,
      counters: S.counters.slice(),
      selectedCounter: S.selectedCounter + 1,
      wiresSeated: wireNames(),
      printEnabled: printEnabled(),
      readCheckPct: Math.round(S.readCheckPct),
      brushAdjust: S.brushAdjust,
      jammed: S.jammed,
      feedSeized: S.feedSeized,
      figuresSuspect: S.figuresSuspect,
      alarms: S.alarms.slice(),
    };
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  var CLUTCH_POS = ["RELEASE", "SINGLE", "RUN"];

  function motorRunning() {
    return S.mains && S.starterLatched && !S.tripped;
  }

  function motorCurrent() {
    if (!motorRunning()) return 0;
    var frac = S.rpm / NOMINAL_RPM;
    return 4 + (1 - frac) * 26;
  }

  function feedRate() {
    if (!motorRunning() || S.clutchPos !== 2 || S.feedSeized || S.jammed)
      return 0;
    return 150 * (S.rpm / NOMINAL_RPM) * (S.hopper > 0 ? 1 : 0);
  }

  function REQUIRED_WIRES() {
    return [
      [0, 11],
      [1, 8],
      [2, 9],
      [3, 10],
    ];
  }

  function printEnabled() {
    var req = REQUIRED_WIRES();
    for (var k = 0; k < req.length; k++) {
      if (!S.wires[req[k][0] + "|" + req[k][1]]) return false;
    }
    return true;
  }

  function wireNames() {
    return Object.keys(S.wires)
      .filter(function (k) {
        return S.wires[k];
      })
      .map(function (k) {
        var ab = k.split("|");
        return HUB_LABELS[ab[0]] + " \u2192 " + HUB_LABELS[ab[1]];
      });
  }

  /* ---------------- tick ---------------- */

  function tick(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return;
    var remaining = Math.min(seconds, 120);
    while (remaining > 0) {
      var step = Math.min(remaining, 0.25);
      stepOnce(step);
      remaining -= step;
    }
  }

  function stepOnce(dt) {
    S.t += dt;

    /* motor and thermal */
    var target = motorRunning() ? NOMINAL_RPM : 0;
    var rate = motorRunning() ? 2.2 : 1.4; // spin-up / coast-down time constants
    if (target > S.rpm) S.rpm = Math.min(target, S.rpm + rate * dt * 720);
    else S.rpm = Math.max(0, S.rpm - rate * dt * 900);

    if (motorRunning()) {
      var load =
        0.55 + 0.45 * (S.rpm / NOMINAL_RPM) + (feedRate() > 0 ? 0.18 : 0);
      S.tempC += (load * 2.1 - (S.tempC - 18) * 0.028) * dt;
      S.foulingPct = Math.min(100, S.foulingPct + dt * 0.0075);
      if (S.tempC >= 88 && !S.tripped) {
        S.tripped = true;
        S.overloadAlarm = true;
        setAlarm(ALARM_OVERLOAD, true);
        say("motor overload — breaker out, let her cool");
      }
    } else {
      S.tempC -= (S.tempC - 18) * 0.05 * dt;
    }
    S.tempC = clamp(S.tempC, 12, 140);

    S.vacuum = Math.max(
      0,
      (S.rpm / NOMINAL_RPM) * 10.2 -
        S.foulingPct * 0.032 -
        (S.jammed ? 3.5 : 0),
    );

    /* read-check registration */
    var err = Math.abs(S.brushAdjust - S.brushIdeal);
    S.readCheckPct = clamp(96 - err * 8.5 - (S.misreadActive ? 6 : 0), 0, 95.9);
    var registered = S.readCheckPct >= 90;
    if (S.misreadActive && registered && S.brushAdjust === S.brushIdeal) {
      S.misreadActive = false;
      setAlarm(ALARM_READ, false);
      say("brushes back in register — read check out");
    }

    /* delayed alarm raising so forced faults show promptly */
    if (S.jamAlarmPending) {
      S.jamAlarmPending = false;
      setAlarm(ALARM_JAM, true);
      say("card jam — release the clutch and clear the feedway");
    }
    if (S.carryAlarmPending) {
      S.carryAlarmPending = false;
      setAlarm(ALARM_CARRY, true);
      say("carry check — counter losing carries, engineer key to zero");
    }
    if (S.misreadAlarmPending) {
      S.misreadAlarmPending = false;
      if (!registered) setAlarm(ALARM_READ, true);
      say("read check — brushes out of register, adjust and watch the meter");
    }

    /* consequences of ignored alarms */
    if (S.jammed && S.clutchPos === 2 && motorRunning() && !S.feedSeized) {
      S.torn += 1;
      if (S.torn > 8) {
        S.feedSeized = true;
        say("feed seized — release the clutch and clear the feedway");
      }
    }

    /* the feed */
    if (S.clutchPos === 1 && S.singlePending && motorRunning()) {
      S.singlePending = false;
      feedOneCard(true);
    }

    var cardsDueAcc = feedRate() * (dt / 60);
    feedAccumulator += cardsDueAcc;
    while (feedAccumulator >= 1) {
      feedAccumulator -= 1;
      feedOneCard(false);
    }

    if (feedRate() === 0) feedAccumulator = 0;

    if (
      S.hopper === 0 &&
      S.clutchPos === 2 &&
      S.fed > 0 &&
      !deckEmptiedReported
    ) {
      deckEmptiedReported = true;
      printFinal();
      say("deck emptied — final total printed");
    }
  }

  var feedAccumulator = 0;
  var deckEmptiedReported = false;

  function feedOneCard(single) {
    if (S.hopper <= 0) return;
    if (S.jammed || S.feedSeized) return;
    var card = cardData(S.fed);
    S.fed += 1;
    S.hopper -= 1;
    S.stacked += 1;

    /* low vacuum skews the lead card now and then */
    if (S.vacuum < 7 && hash32(card.i * 31 + 7) % 23 === 0) {
      S.skewEvents += 1;
    }

    /* accumulate */
    var v1 = card.valuePence;
    var v2 = card.waterPence;
    if (S.misreadActive) {
      v1 = Math.max(0, v1 + ((hash32(card.i * 17 + 3) % 13) - 6) * 10);
      S.figuresSuspect = true;
    }
    addToCounter(0, v1);
    addToCounter(1, v2);
    S.groupSum1 += v1;
    S.groupSum2 += v2;
    S.groupCount += 1;

    /* print */
    if (printEnabled()) {
      pushLine(card.label, "");
      S.linesPrinted += 1;
    }
    if (!single && S.groupCount >= GROUP_EVERY && printEnabled()) {
      pushLine(
        "GROUP " +
          pad(card.ward, 8) +
          "   " +
          lsd(S.groupSum1) +
          "  " +
          lsd(S.groupSum2),
        "groupline",
      );
      S.groupSum1 = 0;
      S.groupSum2 = 0;
      S.groupCount = 0;
      addToCounter(3, 1);
    }
    clatter();
  }

  function addToCounter(idx, value) {
    var before = S.counters[idx];
    var after;
    if (S.carryActive && idx === S.carryCounter) {
      after = before + (value % 1000); // the thousands carry wheel slips
    } else {
      after = before + value;
    }
    S.counters[idx] = Math.min(after, 99999999);
  }

  function printFinal() {
    if (!printEnabled()) {
      pushLine("-- BLANK CYCLE: BOARD NOT WIRED TO PROGRAM --", "groupline");
      return;
    }
    pushLine(
      "FINAL TOTAL     " + lsd(S.counters[0]) + "  " + lsd(S.counters[1]),
      "groupline",
    );
    if (S.figuresSuspect) {
      pushLine("** FIGURES SUSPECT - READ CHECK HAS RUN **", "groupline");
    }
    if (S.carryActive) {
      pushLine("** FIGURES SUSPECT - CARRY CHECK HAS RUN **", "groupline");
    }
    S.linesPrinted += 1;
  }

  /* ---------------- fault injection ---------------- */

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f.indexOf("jam") !== -1) {
      S.jammed = true;
      S.jamAlarmPending = true;
    } else if (f.indexOf("misregister") !== -1 || f.indexOf("read") !== -1) {
      S.misreadActive = true;
      S.misreadAlarmPending = true;
      S.brushIdeal = clamp(
        Math.round(
          S.brushAdjust +
            (hash32(S.t | 0) % 2 ? 1 : -1) * (4 + (hash32((S.t * 7) | 0) % 3)),
        ),
        0,
        20,
      );
    } else if (f.indexOf("carry") !== -1) {
      S.carryActive = true;
      S.carryCounter = S.selectedCounter;
      S.carryAlarmPending = true;
    } else {
      throw new Error("unknown fault: " + fault);
    }
  }

  /* ---------------- reset ---------------- */

  function reset() {
    coldState();
    deckEmptiedReported = false;
    feedAccumulator = 0;
    renderFull();
  }

  /* ---------------- panel wiring ---------------- */

  var HUB_LABELS = [
    "CYCLE TAKE-OFF",
    "FIELD A",
    "FIELD B",
    "GROUP BREAK",
    "X-CONTROL",
    "DECIMAL",
    "ZERO SET",
    "SPARE 7",
    "CNT 1",
    "CNT 2",
    "COMPARE",
    "PRINTER",
    "LIST",
    "CNT 3",
    "CNT 4",
    "SPARE 15",
  ];

  var $ = function (id) {
    return document.getElementById(id);
  };

  var el = {
    lamps: {},
    hopper: $("hopper-count"),
    fed: $("fed-count"),
    stack: $("stack-count"),
    moving: $("moving-cards"),
    readMeterWrap: $("readcheck-meter"),
    readBar: $("readcheck-bar"),
    readVal: $("readcheck-value"),
    jamFlag: $("jamflag"),
    drums: [$("cnt-1"), $("cnt-2"), $("cnt-3"), $("cnt-4")],
    selFace: $("counter-selector-face"),
    selPtr: $("counter-selector-pointer"),
    selBtn: $("counter-selector-btn"),
    selRead: $("selector-readout"),
    tape: $("listing-tape"),
    board: $("plugboard"),
    statusline: $("statusline"),
    breaker: $("mains-breaker"),
    starter: $("motor-starter"),
    clutchBtn: $("feed-clutch"),
    clutchKnob: null,
    paperFeed: $("paper-feed"),
    stop: $("stop-btn"),
    brush: $("brush-adjust"),
    brushFace: $("brush-knobface"),
    clear: $("clear-feedway"),
    key: $("engineer-key"),
    ftJam: $("ft-jam"),
    ftMis: $("ft-misread"),
    ftCarry: $("ft-carry"),
    lampsTest: $("lamps-test"),
    soundCut: $("sound-cut"),
    dialog: document.querySelector("dialog[data-manual]"),
  };

  [
    "feed-jam",
    "read-check",
    "carry-check",
    "motor",
    "print-enabled",
    "power",
  ].forEach(function (n) {
    el.lamps[n] = document.querySelector('[data-lamp="' + n + '"]');
  });

  /* ---- plugboard ---- */

  var hubButtons = [];
  var wiresSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wiresSvg.setAttribute("class", "wires");

  function buildBoard() {
    el.board.textContent = "";
    hubButtons = [];
    el.board.appendChild(wiresSvg);
    HUB_LABELS.forEach(function (label, idx) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "hub";
      b.setAttribute("data-hub", idx);
      b.setAttribute(
        "aria-label",
        "plugboard hub " +
          label +
          (idx < 8 ? " (program side)" : " (unit side)"),
      );
      var sock = document.createElement("span");
      sock.className = "socket";
      var cap = document.createElement("span");
      cap.textContent = label;
      b.appendChild(sock);
      b.appendChild(cap);
      b.addEventListener("click", function () {
        hubClicked(idx);
      });
      el.board.appendChild(b);
      hubButtons.push(b);
    });
    redrawWires();
  }

  function hubClicked(idx) {
    ensureSound();
    if (S.armedHub === null) {
      S.armedHub = idx;
    } else if (S.armedHub === idx) {
      S.armedHub = null;
    } else {
      var a = S.armedHub;
      var key = a < idx ? a + "|" + idx : idx + "|" + a;
      if (a % 8 === idx % 8) {
        say("both hubs sit in the same column — wire across the board");
      } else if (S.wires[key]) {
        delete S.wires[key];
        say("wire lifted: " + HUB_LABELS[a] + " from " + HUB_LABELS[idx]);
      } else {
        S.wires[key] = true;
        say("wire seated: " + HUB_LABELS[a] + " to " + HUB_LABELS[idx]);
        if (printEnabled()) say("program complete — print enabled");
      }
      S.armedHub = null;
    }
    syncBoard();
  }

  function syncBoard() {
    hubButtons.forEach(function (b, i) {
      b.classList.toggle("armed", S.armedHub === i);
      var wired =
        Object.keys(S.wires).some(function (k) {
          var ab = k.split("|");
          return S.wires[k] && (+ab[0] === i || +ab[1] === i);
        }) || false;
      b.classList.toggle("wired", wired);
    });
    redrawWires();
    lamp("print-enabled", printEnabled());
  }

  function hubCenter(idx) {
    var b = hubButtons[idx].querySelector(".socket");
    var br = b.getBoundingClientRect();
    var wr = wiresSvg.getBoundingClientRect();
    return {
      x: br.left + br.width / 2 - wr.left,
      y: br.top + br.height / 2 - wr.top,
    };
  }

  function redrawWires() {
    while (wiresSvg.firstChild) wiresSvg.removeChild(wiresSvg.firstChild);
    var w = wiresSvg.getBoundingClientRect().width;
    if (!w || !S || !S.wires) return;
    Object.keys(S.wires).forEach(function (k) {
      if (!S.wires[k]) return;
      var ab = k.split("|");
      var p1 = hubCenter(+ab[0]);
      var p2 = hubCenter(+ab[1]);
      var midx = (p1.x + p2.x) / 2;
      var sag = 16 + Math.abs(p2.x - p1.x) * 0.08;
      var d =
        "M" +
        p1.x +
        "," +
        p1.y +
        " Q" +
        midx +
        "," +
        (Math.max(p1.y, p2.y) + sag) +
        " " +
        p2.x +
        "," +
        p2.y;
      var shadow = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      shadow.setAttribute("d", d);
      shadow.setAttribute("stroke", "#000");
      shadow.setAttribute("stroke-width", "5");
      shadow.setAttribute("opacity", "0.5");
      wiresSvg.appendChild(shadow);
      var wire = document.createElementNS("http://www.w3.org/2000/svg", "path");
      wire.setAttribute("d", d);
      wire.setAttribute("stroke", "#d9c27a");
      wire.setAttribute("stroke-width", "3");
      wiresSvg.appendChild(wire);
    });
  }

  window.addEventListener("resize", redrawWires);

  /* ---- controls ---- */

  el.breaker.addEventListener("change", function () {
    ensureSound();
    if (el.breaker.checked) {
      if (S.tripped && S.tempC > 62) {
        el.breaker.checked = false;
        say("motor still hot — wait for her to cool below 62 degrees");
        return;
      }
      S.mains = true;
      if (S.tripped) {
        S.tripped = false;
        S.overloadAlarm = false;
        setAlarm(ALARM_OVERLOAD, false);
        say("overload reset — she will take it from cold");
      }
      say("mains on");
    } else {
      S.mains = false;
      S.starterLatched = false;
      say("mains off");
    }
  });

  el.starter.addEventListener("click", function () {
    ensureSound();
    if (!S.mains) {
      say("mains breaker is out");
      return;
    }
    if (S.tripped) {
      say("overload tripped — breaker out and in again once cool");
      return;
    }
    S.starterLatched = true;
    say("contactor in — motor coming up to speed");
  });

  el.selBtn.addEventListener("click", function () {
    S.selectedCounter = (S.selectedCounter + 1) % 4;
    syncSelector();
  });

  function syncSelector() {
    var angles = [-42, -14, 14, 42];
    el.selPtr.style.transform =
      "translateX(-50%) rotate(" + angles[S.selectedCounter] + "deg)";
    var names = [
      "CNT 1 — RATES",
      "CNT 2 — WATER",
      "CNT 3 — ACCOUNTS",
      "CNT 4 — GROUPS",
    ];
    el.selRead.textContent = "selected " + names[S.selectedCounter];
  }

  function cycleClutch() {
    ensureSound();
    var next = (S.clutchPos + 1) % 3;
    setClutch(next);
  }

  function setClutch(pos) {
    S.clutchPos = pos;
    if (pos === 1) S.singlePending = true;
    if (pos === 0 && S.fed > 0 && S.groupCount > 0 && printEnabled())
      printFinal();
    var pcts = [8, 50, 82];
    if (el.clutchKnob) el.clutchKnob.style.left = pcts[pos] + "%";
    el.clutchBtn.setAttribute(
      "aria-label",
      "Feed clutch lever, now at " +
        CLUTCH_POS[pos] +
        ": operate to step release, single cycle, run",
    );
    say("clutch " + CLUTCH_POS[pos].toLowerCase());
  }

  el.clutchBtn = $("feed-clutch");
  el.clutchKnob = el.clutchBtn.querySelector(".leverknob");
  el.clutchBtn.addEventListener("click", cycleClutch);
  el.clutchBtn.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
      ev.preventDefault();
      var nxt = Math.min(2, S.clutchPos + 1);
      if (nxt !== S.clutchPos) setClutch(nxt);
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
      ev.preventDefault();
      var prv = Math.max(0, S.clutchPos - 1);
      if (prv !== S.clutchPos) setClutch(prv);
    }
  });

  el.paperFeed.addEventListener("click", function () {
    ensureSound();
    pushLine("", "");
    say("carriage advanced one line");
  });

  el.stop.addEventListener("click", function () {
    ensureSound();
    if (S.clutchPos !== 0) {
      setClutch(0);
    } else if (S.starterLatched || S.mains) {
      S.starterLatched = false;
      say("stopped — contactor out, motor coasting");
    } else {
      say("already stopped");
    }
  });

  el.clear.addEventListener("click", function () {
    ensureSound();
    if (!S.jammed && !S.feedSeized) {
      say("feedway already clear");
      return;
    }
    if (S.clutchPos !== 0) {
      say("bring the clutch to RELEASE before clearing the feedway");
      return;
    }
    S.jammed = false;
    S.feedSeized = false;
    el.ftJam.checked = false;
    setAlarm(ALARM_JAM, false);
    say("feedway cleared — torn cards to one side, ready to run");
  });

  el.brush.addEventListener("input", function () {
    S.brushAdjust = parseInt(el.brush.value, 10) || 0;
    var rot = -135 + (S.brushAdjust / 20) * 270;
    el.brushFace.querySelector(".knobmark").parentElement.style.transform =
      "rotate(" + rot + "deg)";
  });

  el.key.addEventListener("change", function () {
    ensureSound();
    if (el.key.checked) {
      S.counters = [0, 0, 0, 0];
      S.groupSum1 = 0;
      S.groupSum2 = 0;
      S.groupCount = 0;
      S.foulingPct = Math.max(0, S.foulingPct * 0.4);
      if (S.hopper === 0) {
        S.hopper = DECK_SIZE;
        deckEmptiedReported = false;
        pushLine("-- FRESH DECK THREADED --", "groupline");
      }
      if (S.carryActive) {
        S.carryActive = false;
        setAlarm(ALARM_CARRY, false);
      }
      S.figuresSuspect = false;
      pushLine("-- ENGINEER ZERO-SET --", "groupline");
      say("counters zeroed, carry latches reset");
      setTimeout(function () {
        el.key.checked = false;
      }, 900);
    }
  });

  el.ftJam.addEventListener("change", function () {
    if (el.ftJam.checked) inject(FAULTS[0]);
    else if (S.jammed)
      say("test switch off — the jam itself still wants clearing");
  });

  el.ftMis.addEventListener("change", function () {
    if (el.ftMis.checked) inject(FAULTS[1]);
    else if (!S.misreadActive) say("test switch off");
  });

  el.ftCarry.addEventListener("change", function () {
    if (el.ftCarry.checked) inject(FAULTS[2]);
    else if (!S.carryActive) say("test switch off");
  });

  el.lampsTest.addEventListener("click", function () {
    ensureSound();
    S.lampsTestUntil = performance.now() + 1300;
    say("lamps test");
  });

  el.soundCut.addEventListener("click", function () {
    S.soundCut = !S.soundCut;
    el.soundCut.setAttribute("aria-pressed", String(S.soundCut));
    el.soundCut.classList.toggle("cut", S.soundCut);
    say(S.soundCut ? "sound cut" : "sound live");
    applySoundGains();
  });

  document.querySelectorAll('[data-action="manual"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      el.dialog.showModal();
    });
  });
  document
    .querySelectorAll('[data-action="close-manual"]')
    .forEach(function (btn) {
      btn.addEventListener("click", function () {
        el.dialog.close();
      });
    });

  /* ---------------- rendering ---------------- */

  function lamp(name, on) {
    var node = el.lamps[name];
    if (!node) return;
    node.classList.toggle("lit", !!on);
  }

  function pushLine(text, cls) {
    S.tapeLines.push({ text: text, cls: cls });
    if (S.tapeLines.length > 40) S.tapeLines.shift();
    renderTape();
  }

  function renderTape() {
    el.tape.textContent = "";
    var frag = document.createDocumentFragment();
    S.tapeLines.slice(-15).forEach(function (ln) {
      var span = document.createElement("span");
      if (ln.cls) span.className = ln.cls;
      span.textContent = ln.text + "\n";
      frag.appendChild(span);
    });
    el.tape.appendChild(frag);
  }

  var lastDrums = ["", "", "", ""];
  var lastMovingTransform = "";

  function render() {
    if (!el.moving.childNodes.length) seedMovingCards();
    lamp("power", S.mains);
    lamp("motor", motorRunning() && S.rpm > NOMINAL_RPM * 0.6);
    lamp("feed-jam", S.jammed || hasAlarm(ALARM_JAM));
    lamp("read-check", hasAlarm(ALARM_READ));
    lamp("carry-check", hasAlarm(ALARM_CARRY));
    lamp("print-enabled", printEnabled());

    el.hopper.textContent = String(S.hopper);
    el.fed.textContent = String(S.fed);
    el.stack.textContent = String(S.stacked);

    /* deck shrinks as she feeds */
    var deckSheets = el.hopper.parentElement.querySelectorAll(".deck i");
    var want = Math.ceil((S.hopper / DECK_SIZE) * deckSheets.length);
    deckSheets.forEach(function (sheet, i) {
      sheet.style.opacity = i < want ? "1" : "0.12";
    });

    /* moving cards in the throat */
    var speed = feedRate();
    if (speed > 0) {
      movingOffset -= speed * 0.06;
      if (movingOffset < -260) movingOffset = 0;
      var tf = "translateX(" + movingOffset.toFixed(1) + "px)";
      if (tf !== lastMovingTransform) {
        el.moving.style.transform = tf;
        lastMovingTransform = tf;
      }
      if (!el.moving.childNodes.length) seedMovingCards();
    } else if (
      lastMovingTransform !== "translateX(0px)" &&
      speed === 0 &&
      S.rpm === 0
    ) {
      el.moving.innerHTML = "";
      lastMovingTransform = "";
    }
    el.moving.style.opacity = S.jammed ? "0.35" : "1";

    el.readBar.style.width = Math.max(3, Math.round(S.readCheckPct)) + "%";
    el.readVal.textContent = Math.round(S.readCheckPct) + "%";
    el.readMeterWrap.classList.toggle("bad", S.readCheckPct < 90);

    el.jamFlag.classList.toggle("on", S.jammed);

    for (var d = 0; d < 4; d++) {
      var txt = pad(String(S.counters[d]), 8);
      if (txt !== lastDrums[d]) {
        lastDrums[d] = txt;
        el.drums[d].textContent = txt;
        el.drums[d].classList.add("roll");
        (function (node) {
          setTimeout(function () {
            node.classList.remove("roll");
          }, 110);
        })(el.drums[d]);
      }
    }

    var testNow = performance.now() < S.lampsTestUntil;
    if (testNow) {
      Object.keys(el.lamps).forEach(function (n) {
        el.lamps[n].classList.add("lit");
      });
    }

    el.statusline.textContent = S.statusMsg;
    el.statusline.classList.toggle("alarming", S.alarming);
  }

  var movingOffset = 0;

  function seedMovingCards() {
    el.moving.textContent = "";
    for (var i = 0; i < 10; i++) {
      var c = document.createElement("i");
      c.style.left = i * 28 + "px";
      el.moving.appendChild(c);
    }
  }

  function hasAlarm(a) {
    return S.alarms.indexOf(a) !== -1;
  }

  function say(msg) {
    S.statusMsg = msg.toLowerCase();
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function renderFull() {
    renderTape();
    syncBoard();
    syncSelector();
    var ev = new Event("input", { bubbles: false });
    el.brush.dispatchEvent(ev);
    if (el.clutchKnob)
      el.clutchKnob.style.left = ["8%", "50%", "82%"][S.clutchPos] + "%";
    lastDrums = ["", "", "", ""];
    render();
  }

  /* ---------------- sound (after a gesture only) ---------------- */

  var audio = null;
  var humGain = null;

  function ensureSound() {
    if (audio || S.soundCut) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = new AC();
      var osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 94;
      var osc2 = audio.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.value = 188;
      humGain = audio.createGain();
      humGain.gain.value = 0;
      var mix = audio.createGain();
      mix.gain.value = 0.5;
      osc.connect(mix);
      osc2.connect(mix);
      mix.connect(humGain);
      humGain.connect(audio.destination);
      osc.start();
      osc2.start();
      applySoundGains();
    } catch (e) {
      audio = null;
    }
  }

  function applySoundGains() {
    if (!audio || !humGain) return;
    var target =
      S.soundCut || !motorRunning() || S.rpm < 200
        ? 0
        : 0.028 + (S.rpm / NOMINAL_RPM) * 0.02;
    try {
      humGain.gain.setTargetAtTime(target, audio.currentTime, 0.25);
    } catch (e) {}
  }

  var lastClatterAt = 0;

  function clatter() {
    if (!audio || S.soundCut) return;
    var now = performance.now();
    if (now - lastClatterAt < 90) return;
    lastClatterAt = now;
    try {
      var buf = audio.createBuffer(1, 900, audio.sampleRate);
      var chan = buf.getChannelData(0);
      for (var i = 0; i < chan.length; i++) {
        chan[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / chan.length, 2);
      }
      var src = audio.createBufferSource();
      src.buffer = buf;
      var bp = audio.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2600;
      var g = audio.createGain();
      g.gain.value = 0.05;
      src.connect(bp);
      bp.connect(g);
      g.connect(audio.destination);
      src.start();
    } catch (e) {}
  }

  /* ---------------- animation loop ---------------- */

  var lastFrame = performance.now();

  function frame(now) {
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!document.hidden) {
      tick(Math.min(dt, 0.5));
      applySoundGains();
      render();
    }
    requestAnimationFrame(frame);
  }

  /* ---------------- boot ---------------- */

  buildBoard();
  reset();
  syncBoard();
  requestAnimationFrame(frame);

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };
})();
