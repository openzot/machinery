/* ============================================================================
   REDBOURNE IRRADIATION SERVICES - CO-60 CELL No. 1
   Source & product control desk. Panel QP-1, issue 4, 1985.
   Pearl-ivory powder coat, espresso trim, traffolyte plates, incandescent
   windows, one log ratemeter. The rack lives under five metres of water;
   everything on this panel exists to keep it that way.
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------- plant constants ------------------------- */
  var LEVEL_NOMINAL_M = 5.8;
  var LEVEL_FILL_MAX_M = 5.95;
  var LEVEL_LOW_ALARM_M = 5.35;
  var LEAK_RATE_MPS = 0.011;
  var FILL_RATE_MPS = 0.02;
  var LEAK_SEAL_LEVEL_M = 5.6;
  var RACK_TRAVEL_M = 2.9;
  var RACK_BASE_M = 0.85;
  var TRANSIT_UP_S = 24;
  var TRANSIT_DOWN_S = 14;
  var EMERGENCY_DROP_S = 6;
  var JAM_TO_TRIP_S = 45;
  var HOIST_COOL_S = 40;
  var DWELL_MIN = 6;
  var DWELL_MAX = 60;
  var SEARCH_SWEEP_S = 10;
  var STATIONS = 10;
  /* flux weight seen by the tote standing at each maze station */
  var FLUX_W = [0.06, 1.0, 0.78, 0.1, 0.05, 0.05, 0.06, 0.08, 0.06, 0.02];
  var K_DOSE = 0.0942; /* kGy per second at unit flux, rack fully up */
  var OVERDOSE_KGY = 4.0;

  var ALARMS = {
    transit: "SOURCE TRANSIT FAULT",
    pool: "POOL LEVEL LOW",
    rad: "HIGH RADIATION",
    jam: "PRODUCT JAM",
    over: "OVERDOSE DAMAGED",
    lock: "INTERLOCK OPEN",
  };
  var FAULTS = [
    "source rack jams in transit",
    "pool water leak",
    "product jam in the maze",
  ];

  var STATION_XY = [
    [300, 196],
    [300, 288],
    [300, 380],
    [300, 470],
    [364, 470],
    [428, 470],
    [428, 380],
    [428, 288],
    [428, 196],
    [348, 196],
  ];
  var MONITORS = ["POOL TOP", "MAZE DOOR", "STACK"];
  var MON_LIMIT = [25, 10, 2];

  /* --------------------------------- state ------------------------------- */
  var S;

  function freshBox() {
    return { dose: 0 };
  }

  function reset() {
    S = {
      t: 0,
      key: 0 /* 0 OFF, 1 STANDBY, 2 OPERATE */,
      ready: false,
      sweepLeft: 0,
      p: 0 /* rack position, 0 storage .. 1 irradiate */,
      lever: 1 /* 0 RAISE, 1 HOLD, 2 LOWER */,
      moving: false,
      dropping: false,
      jamActive: false,
      jamClock: 0,
      hoistTrip: false,
      hoistCool: 0,
      edropLatch: false,
      level: LEVEL_NOMINAL_M,
      leakActive: false,
      tempC: 18,
      filling: false,
      monitor: 0,
      dwell: 12,
      convMode: 0 /* 0 OFF, 1 SINGLE, 2 AUTO */,
      autoClock: 0,
      mazeJam: false,
      revving: false,
      revHold: 0,
      convTrip: false,
      conveyorRunning: false,
      slots: [],
      boxesOut: 0,
      scrapped: 0,
      lastDose: 0,
      alarms: {} /* name -> acknowledged bool */,
      interlockFlash: 0,
      scramble: false,
      lampsTestUntil: -1,
      hornOn: false,
      log: [],
      boxesEverOut: 0,
    };
    for (var i = 0; i < STATIONS; i++) {
      S.slots.push(null); /* the maze starts empty; the loader feeds it */
    }
  }
  reset();

  /* ------------------------------ derived -------------------------------- */
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function coverM() {
    return Math.max(0, S.level - (RACK_BASE_M + RACK_TRAVEL_M * S.p));
  }
  function ratePoolTop() {
    var c = coverM();
    return 0.04 + 25 * Math.exp(-4.15 * (c - 1.2));
  }
  function rateDoor() {
    var c = coverM();
    return c < 2 ? 0.05 + 0.25 * S.p + (2 - c) * 8 : 0.05 + 0.25 * S.p;
  }
  function rateStack() {
    return 0.02 + 0.05 * S.p + (S.key > 0 ? 0.01 : 0);
  }
  function monitorRates() {
    return [ratePoolTop(), rateDoor(), rateStack()];
  }
  function flutter(seed) {
    return (
      1 +
      0.02 * Math.sin(S.t * 1.7 + seed) +
      0.012 * Math.sin(S.t * 0.53 + seed * 2.3)
    );
  }
  function anyUnacked() {
    for (var k in S.alarms) if (!S.alarms[k]) return true;
    return false;
  }

  /* ------------------------------- alarms -------------------------------- */
  function raise(name) {
    var fresh = !(name in S.alarms);
    if (fresh) {
      S.alarms[name] = false;
      logEvent("** ALARM ** " + name);
      soundHorn(true);
    } else if (S.alarms[name]) {
      S.alarms[name] = false; /* recurrence: flash and sound again */
      logEvent("** ALARM ** " + name);
      soundHorn(true);
    }
  }
  function clear(name) {
    if (name in S.alarms) {
      delete S.alarms[name];
      soundHorn(anyUnacked());
    }
  }
  function acceptAlarms() {
    for (var k in S.alarms) S.alarms[k] = true;
    soundHorn(false);
  }
  function logEvent(msg) {
    var t = S.t;
    function z(n) {
      return (n < 10 ? "0" : "") + Math.floor(n);
    }
    var stamp = z(t / 3600) + ":" + z((t / 60) % 60) + ":" + z(t % 60);
    S.log.unshift(stamp + "  " + msg);
    if (S.log.length > 6) S.log.pop();
  }

  function flashInterlock() {
    raise(ALARMS.lock);
    S.interlockFlash = 4;
  }

  /* ---------------------------- source hoist ----------------------------- */
  function requestLever(pos) {
    if (S.hoistTrip) {
      S.lever = 1;
      syncLever();
      refuse();
      return;
    }
    if (pos === 0 && (S.key < 2 || !S.ready || S.dropping)) {
      S.lever = 1;
      syncLever();
      flashInterlock();
      return;
    }
    if (pos === 2 && S.key < 1) {
      S.lever = 1;
      syncLever();
      flashInterlock();
      return;
    }
    S.lever = pos;
    syncLever();
    clack();
  }

  function emergencyDrop(auto) {
    if (S.p <= 0 && !S.dropping) return;
    S.dropping = true;
    S.ready = false;
    S.edropLatch = true;
    S.lever = 1;
    syncLever();
    if (!auto) clack();
  }

  /* ------------------------------ conveyor ------------------------------- */
  function stepTrain(dir) {
    var i;
    if (dir > 0) {
      if (S.slots[STATIONS - 1]) {
        S.lastDose = S.slots[STATIONS - 1].dose;
        S.boxesOut++;
        S.boxesEverOut++;
        logEvent(
          "BOX OUT #" +
            S.boxesEverOut +
            "  " +
            S.lastDose.toFixed(2) +
            " kGy" +
            (S.lastDose < 2.2 ? "  LOW" : S.lastDose > 3.2 ? "  HIGH" : ""),
        );
      }
      for (i = STATIONS - 1; i > 0; i--) S.slots[i] = S.slots[i - 1];
      S.slots[0] = freshBox();
    } else {
      for (i = 0; i < STATIONS - 1; i++) S.slots[i] = S.slots[i + 1];
      S.slots[STATIONS - 1] = null;
    }
    clack(120);
  }

  /* ------------------------------ main tick ------------------------------ */
  function tick(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return;
    var left = Math.min(seconds, 3600);
    while (left > 0) {
      var dt = Math.min(0.25, left);
      left -= dt;
      substep(dt);
    }
  }

  function substep(dt) {
    S.t += dt;

    /* reverse jog against a wedged tote */
    if (S.revving && S.mazeJam && S.key >= 1) {
      S.revHold += dt;
      if (S.revHold >= 3) {
        S.mazeJam = false;
        S.revving = false;
        S.revHold = 0;
        logEvent("Jam backed off one station");
        setTestToggle("ftJam", false);
        clear(ALARMS.jam);
        stepTrain(-1);
        chirp();
      }
    } else if (!S.mazeJam) {
      S.revHold = 0;
    }

    /* search sweep countdown */
    if (S.sweepLeft > 0) {
      S.sweepLeft -= dt;
      if (S.sweepLeft <= 0) {
        S.sweepLeft = 0;
        S.ready = true;
        logEvent("Search complete - READY");
        chirp();
      }
    }

    /* interlock window self-clears */
    if (S.interlockFlash > 0) {
      S.interlockFlash -= dt;
      if (S.interlockFlash <= 0) clear(ALARMS.lock);
    }

    /* ---- hoist ---- */
    var commanding = false;
    if (S.hoistTrip || S.hoistCool > 0) {
      S.moving = false;
      if (S.hoistTrip && S.lever === 1)
        S.hoistCool = Math.max(0, S.hoistCool - dt);
    } else if (S.dropping) {
      commanding = true;
      S.p -= dt / EMERGENCY_DROP_S;
      if (S.p <= 0) {
        S.p = 0;
        S.dropping = false;
        S.scramble = false;
        logEvent("Drop complete - rack shielded");
        clack();
      }
    } else if (S.lever === 0 && S.key === 2 && S.ready) {
      commanding = true;
      S.moving = true;
      S.p += dt / TRANSIT_UP_S;
      if (S.jamActive) S.p -= dt / TRANSIT_UP_S; /* fouled guide: no motion */
      if (S.p >= 1) {
        S.p = 1;
        S.lever = 1;
        syncLever();
        logEvent("Source at IRRADIATE");
      }
    } else if (S.lever === 2 && S.key >= 1) {
      commanding = true;
      S.moving = true;
      S.p -= dt / TRANSIT_DOWN_S;
      if (S.p <= 0) {
        S.p = 0;
        S.lever = 1;
        syncLever();
        logEvent("Rack at STORAGE");
        if (S.jamActive) {
          /* the fouler drops into the guide basket */
          S.jamActive = false;
          S.jamClock = 0;
          setTestToggle("ftTransit", false);
          clear(ALARMS.transit);
          logEvent("Guide fouling cleared at bottom");
          clack(70);
        }
      }
    } else {
      S.moving = false;
    }

    /* stalled against the guides -> thermal overload */
    if (S.jamActive && commanding) {
      S.jamClock += dt;
      if (S.jamClock >= JAM_TO_TRIP_S && !S.hoistTrip) {
        S.hoistTrip = true;
        S.hoistCool = HOIST_COOL_S;
        logEvent("Hoist overload TRIP - cooling");
        S.lever = 1;
        S.moving = false;
        S.dropping = false;
        syncLever();
        clack(60);
      }
    } else if (!commanding) {
      S.jamClock = Math.max(0, S.jamClock - dt * 0.5);
    }

    /* ---- pool inventory ---- */
    if (S.leakActive) S.level -= LEAK_RATE_MPS * dt;
    if (S.filling) {
      S.level += FILL_RATE_MPS * dt;
      if (S.leakActive && S.level >= LEAK_SEAL_LEVEL_M) {
        S.leakActive = false; /* found and sealed under head pressure */
        logEvent("Leak sealed, level restored");
        setTestToggle("ftLeak", false);
        clear(ALARMS.pool);
      }
    }
    S.level = clamp(S.level, 0, LEVEL_FILL_MAX_M);

    /* ---- decay heat ---- */
    var heat = 1.35 * S.p - 0.085 * (S.tempC - 18);
    S.tempC = clamp(S.tempC + (heat / 60) * dt, 12, 60);

    /* ---- conveyor ---- */
    var running =
      S.convMode === 2 &&
      !S.convTrip &&
      !S.mazeJam &&
      !S.moving &&
      !S.dropping &&
      S.key >= 1;
    S.conveyorRunning = running;
    if (running) {
      S.autoClock += dt;
      if (S.autoClock >= S.dwell) {
        S.autoClock = 0;
        stepTrain(1);
      }
    }

    /* ---- dose accrual ---- */
    if (S.key >= 1) {
      for (var i = 0; i < STATIONS; i++) {
        if (S.slots[i]) S.slots[i].dose += K_DOSE * FLUX_W[i] * S.p * dt;
      }
    }

    /* ---- a tote wedged at the window cooks until someone backs it out ---- */
    if (S.mazeJam && S.key >= 1) {
      var worstSlot = -1,
        worstDose = 0;
      for (var w = 0; w < STATIONS; w++) {
        if (S.slots[w] && S.slots[w].dose > worstDose) {
          worstDose = S.slots[w].dose;
          worstSlot = w;
        }
      }
      if (worstSlot >= 0 && worstDose >= OVERDOSE_KGY) {
        raise(ALARMS.over);
        S.scrapped++;
        S.convTrip = true;
        logEvent("Overdose tote quarantined - line tripped");
        S.convMode = 0;
        S.autoClock = 0;
        S.slots[worstSlot] = freshBox(); /* quarantined for assay */
        syncConv();
      }
    }

    /* ---- radiation protection ---- */
    var rates = monitorRates();
    var overLimit =
      rates[0] > MON_LIMIT[0] ||
      rates[1] > MON_LIMIT[1] ||
      rates[2] > MON_LIMIT[2];
    if (overLimit) {
      raise(ALARMS.rad);
      if (!S.scramble) {
        S.scramble = true;
        emergencyDrop(true);
        if (coverM() < 1.5) raise(ALARMS.over);
      }
    }
    /* HIGH RADIATION stays lit until TRIP RESET: the RPS reads it first */

    if (S.level < LEVEL_LOW_ALARM_M) raise(ALARMS.pool);

    /* ---- public API snapshot cache ---- */
    S._rates = rates;
  }

  /* ------------------------------- injection ----------------------------- */
  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === FAULTS[0]) {
      S.jamActive = true;
      S.jamClock = 0;
      setTestToggle("ftTransit", true);
      raise(ALARMS.transit);
    } else if (f === FAULTS[1]) {
      S.leakActive = true;
      setTestToggle("ftLeak", true);
      raise(ALARMS.pool);
    } else if (f === FAULTS[2]) {
      S.mazeJam = true;
      S.revHold = 0;
      setTestToggle("ftJam", true);
      raise(ALARMS.jam);
      clack();
    }
  }

  /* ================================ UI =================================== */
  var $ = function (id) {
    return document.getElementById(id);
  };
  var el = {};
  var annEls = {};

  function yForDepth(d) {
    return 528 - d * 58.7;
  }

  function buildReels(containerId, digits, decimalAfter) {
    var drum = $(containerId);
    var unit = drum.querySelector(".unit");
    var reels = [];
    for (var k = 0; k < digits; k++) {
      if (decimalAfter >= 0 && k === decimalAfter + 1) {
        var dot = document.createElement("span");
        dot.className = "dot";
        dot.textContent = ".";
        drum.insertBefore(dot, unit);
      }
      var wrap = document.createElement("span");
      wrap.className = "reel";
      var strip = document.createElement("span");
      strip.className = "reel-strip";
      for (var d = 0; d <= 9; d++) {
        var b = document.createElement("b");
        b.textContent = d;
        strip.appendChild(b);
      }
      wrap.appendChild(strip);
      drum.insertBefore(wrap, unit);
      reels.push({ strip: strip, pos: -1 });
    }
    return reels;
  }

  function setDrum(reels, valueStr) {
    for (var i = 0; i < reels.length; i++) {
      var ch = valueStr.charAt(i);
      var d = ch >= "0" && ch <= "9" ? +ch : 0;
      if (d !== reels[i].pos) {
        reels[i].pos = d;
        reels[i].strip.style.top = -d * 32 + "px";
      }
    }
  }

  function buildRateScale() {
    var svgNS = "http://www.w3.org/2000/svg";
    var g = $("rateScale");
    var cx = 125,
      cy = 138,
      R = 96;
    function pt(aDeg, r) {
      var a = (aDeg * Math.PI) / 180;
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    }
    function ang(v) {
      return -62 + (Math.log(v) / Math.LN10 + 1) * (124 / 6);
    }
    function arc(a0, a1, color) {
      var p0 = pt(a0, R),
        p1 = pt(a1, R);
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute(
        "d",
        "M" +
          p0[0].toFixed(1) +
          " " +
          p0[1].toFixed(1) +
          " A" +
          R +
          " " +
          R +
          " 0 0 1 " +
          p1[0].toFixed(1) +
          " " +
          p1[1].toFixed(1),
      );
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "6");
      g.appendChild(path);
    }
    arc(ang(0.1), ang(2.5), "#3f7d46");
    arc(ang(2.5), ang(25), "#dfa018");
    arc(ang(25), ang(100000), "#cf2318");

    var decades = [0.1, 1, 10, 100, 1000, 10000, 100000];
    for (var i = 0; i < decades.length; i++) {
      var a = ang(decades[i]);
      var q0 = pt(a, R - 7),
        q1 = pt(a, R + 7);
      g.appendChild(mkLine(svgNS, q0, q1, "#20140e", 2));
      var tp = pt(a, R + 18);
      var label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", tp[0]);
      label.setAttribute("y", tp[1] + 3);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "9");
      label.setAttribute("font-family", "Courier New,monospace");
      label.setAttribute("fill", "#4c463a");
      label.textContent =
        decades[i] >= 1000 ? decades[i] / 1000 + "k" : String(decades[i]);
      g.appendChild(label);
      if (i < decades.length - 1) {
        for (var m = 2; m <= 9; m++) {
          var v = decades[i] * m;
          var u0 = pt(ang(v), R - 3.5),
            u1 = pt(ang(v), R + 3.5);
          g.appendChild(mkLine(svgNS, u0, u1, "#6b6557", 1));
        }
      }
    }
    /* detector identity plate drawn under the scale */
    var cap = document.createElementNS(svgNS, "text");
    cap.setAttribute("x", cx);
    cap.setAttribute("y", cy - 74);
    cap.setAttribute("text-anchor", "middle");
    cap.setAttribute("font-size", "10");
    cap.setAttribute("font-family", "Arial Narrow,Arial,sans-serif");
    cap.setAttribute("letter-spacing", "2");
    cap.setAttribute("fill", "#4c463a");
    cap.textContent = "\u00B5Sv/h \u00B7 LOG SCALE";
    g.appendChild(cap);
  }
  function mkLine(svgNS, p0, p1, color, w) {
    var ln = document.createElementNS(svgNS, "line");
    ln.setAttribute("x1", p0[0]);
    ln.setAttribute("y1", p0[1]);
    ln.setAttribute("x2", p1[0]);
    ln.setAttribute("y2", p1[1]);
    ln.setAttribute("stroke", color);
    ln.setAttribute("stroke-width", w);
    return ln;
  }

  /* -------------------------------- render ------------------------------- */
  function testLit() {
    return S.t < S.lampsTestUntil;
  }

  function render() {
    var rates = S._rates || monitorRates();
    var sel = rates[S.monitor] * flutter(S.monitor * 3.1);
    var a = clamp(
      -62 + (Math.log(Math.max(sel, 0.02)) / Math.LN10 + 1) * (124 / 6),
      -62,
      62,
    );
    el.rateNeedle.setAttribute(
      "transform",
      "rotate(" + a.toFixed(2) + " 125 138)",
    );
    el.monVal.textContent =
      sel >= 100
        ? String(Math.round(sel))
        : sel >= 10
          ? sel.toFixed(1)
          : sel.toFixed(2);
    el.monName.textContent = MONITORS[S.monitor];

    el.srcPointer.style.top = (96 - S.p * 88).toFixed(1) + "%";
    el.covVal.textContent = coverM().toFixed(1) + " m";

    var doseTxt = Math.min(S.lastDose, 99.9).toFixed(1);
    setDrum(el.doseReels, ("0" + doseTxt).slice(-4).replace(".", ""));
    setDrum(el.outReels, ("0000" + Math.min(S.boxesOut, 9999)).slice(-4));
    setDrum(el.scrapReels, ("00" + Math.min(S.scrapped, 99)).slice(-2));
    var hrs = Math.min(S.t / 3600, 999.9).toFixed(1);
    setDrum(el.hourReels, ("0" + hrs).slice(-4).replace(".", ""));

    var tpct = clamp((S.tempC - 14) / 26, 0, 1) * 100;
    el.tempBar.style.width = tpct.toFixed(1) + "%";
    el.tempVal.textContent = Math.round(S.tempC) + "\u00B0";
    el.tbar.classList.toggle("hot", S.tempC > 36);

    /* mimic: water */
    var surfY = yForDepth(S.level);
    el.waterRect.setAttribute("y", surfY.toFixed(1));
    el.waterRect.setAttribute("height", Math.max(0, 528 - surfY).toFixed(1));
    el.surfline.setAttribute("y1", surfY.toFixed(1));
    el.surfline.setAttribute("y2", surfY.toFixed(1));

    /* mimic: rack, cable, winch */
    var rackTop = 470 - S.p * 170;
    el.rackG.setAttribute(
      "transform",
      "translate(0," + rackTop.toFixed(1) + ")",
    );
    el.cableLine.setAttribute("y2", (rackTop - 8).toFixed(1));
    if (S.moving || S.dropping) {
      el.winchDrum.setAttribute(
        "transform",
        "rotate(" + ((S.t * 160) % 360).toFixed(0) + " 140 92)",
      );
    }

    /* mimic: beacon, chain, boxes, fill pipe */
    var transiting = S.moving || S.dropping;
    el.beaconcone.setAttribute("opacity", transiting ? ".85" : "0");
    if (transiting) {
      el.beaconG.setAttribute(
        "transform",
        "rotate(" + ((S.t * 420) % 360).toFixed(0) + " 112 52)",
      );
    }
    el.chainPath.style.animationPlayState = S.conveyorRunning
      ? "running"
      : "paused";
    for (var i = 0; i < STATIONS; i++) {
      var boxEl = el.boxEls[i];
      if (S.slots[i]) {
        boxEl.setAttribute("display", "inline");
        boxEl.setAttribute(
          "transform",
          "translate(" +
            (STATION_XY[i][0] - 13) +
            "," +
            (STATION_XY[i][1] - 15) +
            ")",
        );
      } else {
        boxEl.setAttribute("display", "none");
      }
    }
    el.fillpipe.setAttribute("opacity", S.filling ? "1" : ".35");

    /* indicator lamps */
    setLamp(el.lampKey, S.key === 2, false);
    setLamp(el.lampReady, S.ready, false);
    setLamp(el.lampUp, S.p >= 0.98, false);
    setLamp(el.lampTransit, transiting, transiting);
    setLamp(el.lampEdrop, S.edropLatch, false);
    setLamp(el.lampTrip, S.hoistTrip || S.convTrip, false);
    setLamp(el.lampHorn, S.hornOn, S.hornOn);
    setLamp(el.lampChain, S.key > 0, false);
    setLamp(el.lampFill, S.filling, false);
    setLamp(el.lampFan, S.key > 0, false);
    if (testLit()) {
      var ids = [
        "lampKey",
        "lampReady",
        "lampUp",
        "lampTransit",
        "lampEdrop",
        "lampTrip",
        "lampHorn",
      ];
      for (var L = 0; L < ids.length; L++) $(ids[L]).classList.add("testlit");
    } else {
      var ids2 = [
        "lampKey",
        "lampReady",
        "lampUp",
        "lampTransit",
        "lampEdrop",
        "lampTrip",
        "lampHorn",
      ];
      for (var M = 0; M < ids2.length; M++)
        $(ids2[M]).classList.remove("testlit");
    }

    /* annunciators */
    for (var name in annEls) {
      var pane = annEls[name];
      var active = name in S.alarms;
      var unacked = active && !S.alarms[name];
      var isRed = pane.red;
      pane.el.className = "ann" + (isRed ? " ann-red" : "");
      if (active) pane.el.classList.add(isRed ? "alarm-red" : "alarm");
      if (unacked) pane.el.classList.add("flash");
      if (testLit())
        pane.el.classList.add(
          active ? (isRed ? "alarm-red" : "alarm") : "alarm",
        );
    }

    /* small readouts */
    if (S.sweepLeft > 0) {
      el.searchRead.textContent = "SWEEP " + Math.ceil(S.sweepLeft);
      el.searchBtn.classList.add("busy");
    } else {
      el.searchBtn.classList.remove("busy");
      el.searchRead.textContent = S.ready ? "READY" : "\u2014";
    }
    el.dwellRead.textContent = S.dwell + " s / STATION";

    el.logList.textContent = S.log.length
      ? S.log.join("\n")
      : "\u2014 no entries this shift \u2014";
  }

  function setLamp(node, on, blink) {
    node.classList.toggle("on", !!on);
    node.classList.toggle("blink", !!blink);
  }

  function syncLever() {
    var pct = S.lever === 0 ? "16%" : S.lever === 2 ? "84%" : "50%";
    el.hoistHandle.style.top = pct;
    el.hoistLever.setAttribute("aria-valuenow", String(1 - S.lever));
    el.hoistLever.setAttribute(
      "aria-valuetext",
      S.lever === 0 ? "RAISE" : S.lever === 2 ? "LOWER" : "HOLD",
    );
    el.hoistLever.classList.toggle("tripped", S.hoistTrip);
  }
  function syncConv() {
    el.convKnob.style.setProperty("--rot", -60 + S.convMode * 60 + "deg");
  }
  function syncKey() {
    el.keySleeve.style.setProperty("--keyrot", S.key * 45 + "deg");
  }
  function syncMon() {
    el.monKnob.style.setProperty("--rot", -45 + S.monitor * 45 + "deg");
  }
  function syncDwell() {
    var frac = (S.dwell - DWELL_MIN) / (DWELL_MAX - DWELL_MIN);
    el.dwellFace.style.setProperty("--rot", -66 + frac * 132 + "deg");
  }

  function setTestToggle(id, on) {
    var t = $(id);
    if (t && t.checked !== !!on) t.checked = !!on;
  }

  /* -------------------------------- audio -------------------------------- */
  var actx = null,
    hornOsc = null,
    hornTimer = null,
    hornHi = false;
  function ensureAudio() {
    if (actx) {
      if (actx.state === "suspended") actx.resume();
      return true;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      actx = new AC();
      return true;
    } catch (e) {
      return false;
    }
  }
  function blip(freq, dur, type, vol) {
    if (!ensureAudio()) return;
    try {
      var o = actx.createOscillator(),
        g = actx.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.04, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g);
      g.connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + dur);
    } catch (e) {
      /* audio is a courtesy, never a requirement */
    }
  }
  function clack(f) {
    blip(f || 150, 0.06, "square", 0.03);
  }
  function refuse() {
    blip(95, 0.14, "square", 0.05);
  }
  function chirp() {
    blip(880, 0.09, "sine", 0.05);
    setTimeout(function () {
      blip(1180, 0.09, "sine", 0.05);
    }, 110);
  }
  function soundHorn(on) {
    S.hornOn = !!on && anyUnacked();
    if (S.hornOn && !hornOsc && ensureAudio()) {
      try {
        hornOsc = actx.createOscillator();
        var g = actx.createGain();
        g.gain.value = 0.03;
        hornOsc.type = "square";
        hornOsc.connect(g);
        g.connect(actx.destination);
        hornOsc.start();
        hornTimer = setInterval(function () {
          hornHi = !hornHi;
          if (hornOsc) hornOsc.frequency.value = hornHi ? 620 : 465;
        }, 340);
      } catch (e) {
        hornOsc = null;
      }
    } else if (!S.hornOn && hornOsc) {
      try {
        hornOsc.stop();
      } catch (e) {
        /* already stopped */
      }
      hornOsc = null;
      if (hornTimer) {
        clearInterval(hornTimer);
        hornTimer = null;
      }
    }
  }
  function killHorn() {
    if (hornOsc) {
      try {
        hornOsc.stop();
      } catch (e) {
        /* noop */
      }
      hornOsc = null;
    }
    if (hornTimer) {
      clearInterval(hornTimer);
      hornTimer = null;
    }
  }

  /* ------------------------------ interaction ---------------------------- */
  function holdButton(node, onDown, onUp) {
    function down(e) {
      if (e.cancelable) e.preventDefault();
      node.classList.add("held");
      onDown();
    }
    function up() {
      if (!node.classList.contains("held")) return;
      node.classList.remove("held");
      onUp();
    }
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointerleave", up);
    node.addEventListener("pointercancel", up);
    node.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) down(e);
    });
    node.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") up();
    });
  }

  function wire() {
    var all = document.querySelectorAll("[id]");
    for (var i = 0; i < all.length; i++) el[all[i].id] = all[i];

    var annList = document.querySelectorAll(".ann");
    for (var a = 0; a < annList.length; a++) {
      var name = annList[a].getAttribute("data-alarm");
      annEls[name] = {
        el: annList[a],
        red:
          name === ALARMS.rad ||
          name === ALARMS.over ||
          annList[a].classList.contains("ann-red"),
      };
    }

    el.doseReels = buildReels("doseDrum", 3, 0);
    el.outReels = buildReels("outDrum", 4, -1);
    el.scrapReels = buildReels("scrapDrum", 2, -1);
    el.hourReels = buildReels("hourDrum", 3, 0);

    el.waterRect = $("waterRect");
    el.surfline = $("surfline");
    el.rackG = $("rackG");
    el.cableLine = $("cableLine");
    el.winchDrum = $("winchDrum");
    el.beaconG = $("beaconG");
    el.beaconcone = $("beaconcone");
    el.chainPath = $("chainPath");
    el.fillpipe = $("fillpipe");
    el.tbar = document.querySelector(".tbar");
    el.rateNeedle = $("rateNeedle");
    el.monVal = $("monVal");
    el.monName = $("monName");
    el.srcPointer = $("srcPointer");
    el.covVal = $("covVal");
    el.searchRead = $("searchRead");
    el.searchBtn = $("searchBtn");
    el.dwellRead = $("dwellRead");
    el.tempBar = $("tempBar");
    el.tempVal = $("tempVal");
    el.hoistHandle = $("hoistHandle");
    el.hoistLever = $("hoistLever");
    el.convKnob = $("convKnob");
    el.keySleeve = $("keySleeve");
    el.monKnob = $("monKnob");
    el.dwellFace = $("dwellFace");
    el.logList = $("logList");

    /* tote boxes drawn into the mimic */
    var boxesG = $("boxesG"),
      svgNS = "http://www.w3.org/2000/svg";
    el.boxEls = [];
    for (var b = 0; b < STATIONS; b++) {
      var g = document.createElementNS(svgNS, "g");
      var r1 = document.createElementNS(svgNS, "rect");
      r1.setAttribute("width", "26");
      r1.setAttribute("height", "30");
      r1.setAttribute("rx", "2");
      r1.setAttribute("fill", "#f7f2df");
      r1.setAttribute("stroke", "#3f3a30");
      r1.setAttribute("stroke-width", "2.4");
      var r2 = document.createElementNS(svgNS, "rect");
      r2.setAttribute("x", "5");
      r2.setAttribute("y", "6");
      r2.setAttribute("width", "16");
      r2.setAttribute("height", "18");
      r2.setAttribute("fill", "none");
      r2.setAttribute("stroke", "#9a9382");
      g.appendChild(r1);
      g.appendChild(r2);
      boxesG.appendChild(g);
      el.boxEls.push(g);
    }

    buildRateScale();

    /* ---- controls ---- */
    $("keySw").addEventListener("click", function () {
      if (S.key === 0) {
        S.key = 1;
        logEvent("KEY to STANDBY");
        chirp();
      } else if (S.key === 1) {
        if (S.ready && !S.hoistTrip && !S.edropLatch) {
          S.key = 2;
          logEvent("KEY to OPERATE");
          clack();
        } else flashInterlock();
      } else {
        S.key = 0;
        logEvent("KEY to OFF");
        clack();
      }
      syncKey();
    });

    $("searchBtn").addEventListener("click", function () {
      if (S.key === 0 || S.p > 0.01 || S.convMode !== 0 || S.dropping) {
        flashInterlock();
        return;
      }
      if (S.sweepLeft > 0) return;
      S.sweepLeft = SEARCH_SWEEP_S;
      S.ready = false;
      logEvent("Cell search started");
      logEvent("Cell search started");
      clack();
    });

    $("convSel").addEventListener("click", function () {
      if (S.key === 0) {
        flashInterlock();
        return;
      }
      S.convMode = (S.convMode + 1) % 3;
      S.autoClock = 0;
      logEvent(["Maze OFF", "Maze SINGLE STEP", "Maze AUTO CYCLE"][S.convMode]);
      syncConv();
      clack();
    });

    $("dwellKnob").addEventListener("click", function (e) {
      S.dwell = clamp(S.dwell + (e.shiftKey ? -2 : 2), DWELL_MIN, DWELL_MAX);
      syncDwell();
      clack(200);
    });
    $("dwellKnob").addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        S.dwell = clamp(S.dwell + 2, DWELL_MIN, DWELL_MAX);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        S.dwell = clamp(S.dwell - 2, DWELL_MIN, DWELL_MAX);
      } else return;
      e.preventDefault();
      syncDwell();
    });

    $("indexBtn").addEventListener("click", function () {
      if (S.key === 0) {
        flashInterlock();
        return;
      }
      if (S.moving || S.dropping) {
        flashInterlock();
        return;
      }
      if (S.mazeJam) {
        raise(ALARMS.jam);
        refuse();
        return;
      }
      if (S.convTrip) {
        refuse();
        return;
      }
      stepTrain(1);
    });

    holdButton(
      $("jamRev"),
      function () {
        if (S.mazeJam) S.revving = true;
      },
      function () {
        S.revving = false;
        S.revHold = 0;
      },
    );
    $("jamNrm").addEventListener("click", function () {
      blip(120, 0.04, "square", 0.02);
    });

    $("tripReset").addEventListener("click", function () {
      var rts = monitorRates();
      if (
        (ALARMS.rad in S.alarms || ALARMS.over in S.alarms) &&
        rts[0] < MON_LIMIT[0] &&
        !S.mazeJam &&
        S.p < 0.02
      ) {
        clear(ALARMS.rad);
        if (!S.convTrip) clear(ALARMS.over);
      }
      var did = false;
      if (S.hoistTrip) {
        if (S.hoistCool <= 0) {
          S.hoistTrip = false;
          did = true;
        } else refuse();
      }
      if (S.convTrip) {
        if (!S.mazeJam) {
          S.convTrip = false;
          clear(ALARMS.over);
          did = true;
        } else refuse();
      }
      if (S.edropLatch) {
        S.edropLatch = false;
        did = true;
      }
      if (!S.mazeJam && !S.convTrip && ALARMS.over in S.alarms)
        clear(ALARMS.over);
      if (did) {
        logEvent("Trips reset");
        chirp();
      }
      syncLever();
    });

    el.hoistLever.addEventListener("click", function (e) {
      var slot = el.hoistLever.querySelector(".slot");
      var r = slot.getBoundingClientRect();
      var y = (e.clientY - r.top) / Math.max(1, r.height);
      requestLever(y < 0.34 ? 0 : y > 0.66 ? 2 : 1);
    });
    el.hoistLever.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        requestLever(0);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        requestLever(2);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        requestLever(1);
      }
    });

    $("edropBtn").addEventListener("click", function () {
      logEvent("EMERGENCY DROP used");
      emergencyDrop(false);
      flashInterlock(); /* drop used: the cell is open until reset */
    });

    holdButton(
      $("fillValve"),
      function () {
        if (S.key === 0) {
          flashInterlock();
          return;
        }
        S.filling = true;
      },
      function () {
        S.filling = false;
      },
    );

    $("monSel").addEventListener("click", function () {
      S.monitor = (S.monitor + 1) % 3;
      syncMon();
      clack(210);
    });

    $("alarmAccept").addEventListener("click", function () {
      acceptAlarms();
      blip(500, 0.05, "sine", 0.03);
    });

    $("lampsTest").addEventListener("click", function () {
      S.lampsTestUntil = S.t + 4;
      clack(240);
    });

    /* maintenance switches drive the same inject() the probe drives */
    $("ftTransit").addEventListener("change", function (e) {
      if (e.target.checked) inject(FAULTS[0]);
    });
    $("ftLeak").addEventListener("change", function (e) {
      if (e.target.checked) inject(FAULTS[1]);
    });
    $("ftJam").addEventListener("change", function (e) {
      if (e.target.checked) inject(FAULTS[2]);
    });

    /* manual dialog */
    var dlg = document.querySelector("dialog[data-manual]");
    var openers = document.querySelectorAll('[data-action="manual"]');
    for (var op = 0; op < openers.length; op++) {
      openers[op].addEventListener("click", function () {
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    }
    var closers = document.querySelectorAll('[data-action="close-manual"]');
    for (var cl = 0; cl < closers.length; cl++) {
      closers[cl].addEventListener("click", function () {
        if (typeof dlg.close === "function") dlg.close();
        else dlg.removeAttribute("open");
      });
    }

    /* unlock audio on the first gesture anywhere */
    var unlock = function () {
      ensureAudio();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);

    syncLever();
    syncConv();
    syncKey();
    syncMon();
    syncDwell();
  }

  /* --------------------------- animation loop ---------------------------- */
  var lastTs = 0;
  function frame(ts) {
    var dt = lastTs ? Math.min(0.5, (ts - lastTs) / 1000) : 0.05;
    lastTs = ts;
    if (!document.hidden) tick(dt);
    render();
    requestAnimationFrame(frame);
  }

  /* ------------------------------ public API ----------------------------- */
  function round1(v) {
    return Math.round(v * 10) / 10;
  }
  function round2(v) {
    return Math.round(v * 100) / 100;
  }
  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  window.machine = {
    name: "Redbourne Co-60 Irradiation Cell No. 1",
    faults: FAULTS.slice(),
    state: function () {
      var rates = monitorRates();
      return {
        t: round2(S.t),
        keyPosition: ["OFF", "STANDBY", "OPERATE"][S.key],
        ready: S.ready,
        sourcePos: round4(S.p),
        sourceState: S.dropping
          ? "EMERGENCY DROP"
          : S.moving
            ? "IN TRANSIT"
            : S.p >= 0.98
              ? "IRRADIATE"
              : "STORAGE",
        leverPos: ["RAISE", "HOLD", "LOWER"][S.lever],
        hoistTrip: S.hoistTrip,
        hoistCooldownS: round1(Math.max(0, S.hoistCool)),
        poolLevelM: round2(S.level),
        coverM: round2(coverM()),
        waterTempC: round1(S.tempC),
        monitorsUsvH: {
          poolTop: round2(rates[0]),
          mazeDoor: round2(rates[1]),
          stack: round2(rates[2]),
        },
        selectedMonitor: MONITORS[S.monitor],
        dwellSetS: S.dwell,
        conveyorMode: ["OFF", "SINGLE STEP", "AUTO CYCLE"][S.convMode],
        conveyorRunning: !!S.conveyorRunning,
        mazeJammed: S.mazeJam,
        boxesOut: S.boxesOut,
        boxesScrapped: S.scrapped,
        lastBoxDoseKgy: round2(S.lastDose),
        filling: S.filling,
        beaconOn: !!(S.moving || S.dropping),
        shiftLog: S.log.slice(0, 3),
        alarms: Object.keys(S.alarms),
      };
    },
    tick: tick,
    inject: inject,
    reset: function () {
      reset();
      killHorn();
      S.hornOn = false;
      syncLever();
      syncConv();
      syncKey();
      syncMon();
      syncDwell();
      setTestToggle("ftTransit", false);
      setTestToggle("ftLeak", false);
      setTestToggle("ftJam", false);
    },
  };

  /* -------------------------------- boot --------------------------------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      wire();
      requestAnimationFrame(frame);
    });
  } else {
    wire();
    requestAnimationFrame(frame);
  }
})();
