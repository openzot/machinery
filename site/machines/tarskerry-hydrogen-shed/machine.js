/* Tarskerry Upper-Air Station — Hydrogen Shed & Sounding Position No. 1
   Simulation core. Classic script, IIFE, exposes window.machine.

   MAKE  an electrolytic generator makes hydrogen into a floating-bell holder;
   STORE the holder bell rises and falls with what is banked;
   FILL  the holder feeds a balloon on the nozzle against a counterweight balance;
   SEND  at the sounding window the guarded release key sends her up, and the
         observer follows her on the theodolite until she bursts. */
(function () {
  "use strict";

  /* ------------------------------ constants ----------------------------- */

  var AMBIENT = 11; // shed temperature, deg C
  var HEAT_K = 0.0000307; // stack heating per ampere squared
  var TEMP_TAU = 20; // stack thermal lag, s
  var TRIP_TEMP = 108; // thermal trip
  var RESTART_TEMP = 75; // cooler than this to restart
  var OVERHEAT_ALARM = 82;
  var PURITY_TRIP = 95.5; // explosive mixture threshold
  var PURITY_SAFE = 98.5;
  var CAPACITY = 2.5; // holder, m3
  var GRAMS_PER_M3 = 1120; // gross lift of hydrogen
  var ENVELOPE = 1200; // balloon envelope weight, g
  var DRAW_RATE = 0.026; // holder -> balloon, m3/s
  var VENT_RATE = 0.09; // holder -> air via vent lever, m3/s
  var PURGE_RATE = 0.11; // holder -> air via purge valve, m3/s
  var BURST_ALT = 34; // km
  var ASCENT_RATE = 165; // simulated climb, m/s (fast-time training rig)
  var WINDOW_EVERY = 600; // sounding windows every ten minutes of rig time
  var WINDOW_OPEN = 90; // window duration, s
  var FIRST_WINDOW = 480; // first window eight minutes after cold (14:00 GMT)

  var FAULTS = [
    "oxygen crossover",
    "cooling water failure",
    "balloon neck slips off the nozzle",
  ];

  /* -------------------------------- state ------------------------------- */

  var S;

  function fresh() {
    return {
      t: 0, // simulated seconds since cold
      clockStart: 13 * 3600 + 52 * 60,
      running: false,
      rheoSet: 0, // demanded current, A
      current: 0, // stack current, A
      banks: 0, // cell bank selector position 0/1/2
      temp: AMBIENT,
      flowPos: 0, // cooling cock 0 shut, 1 half, 2 open
      purity: 99.7,
      level: 0, // holder fill fraction 0..1
      ventOpen: false,
      purging: false,
      purgeHold: 0, // seconds of continuous purge
      lockedOut: false,
      tripped: false,
      draught: 4, // mm water gauge on the holder
      balloonMounted: false,
      balloonVolume: 0,
      clamped: false,
      fillOpen: false,
      target: 800, // balance target free lift, g
      lastClosedIdx: -1,
      launched: false,
      missedLatch: false,
      inFlight: false,
      flightT: 0,
      altM: 0,
      trackDeg: 0,
      onTargetSum: 0,
      resultMsg: "",
      resultUntil: 0,
      resultClass: "",
      finished: "",
      guardOpen: false,
      keyTurned: false,
      faults: {
        "oxygen crossover": { active: false },
        "cooling water failure": { active: false },
        "balloon neck slips off the nozzle": { active: false },
      },
    };
  }

  S = fresh();

  /* ------------------------------- helpers ------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function approach(v, target, ratePerS, dt) {
    var d = target - v;
    var stepSize = ratePerS * dt;
    if (Math.abs(d) <= stepSize) return target;
    return v + (d < 0 ? -1 : 1) * stepSize;
  }

  function clockSeconds() {
    return S.clockStart + S.t;
  }

  function p2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function fmtClock(sec) {
    sec = ((Math.round(sec) % 86400) + 86400) % 86400;
    return (
      p2(Math.floor(sec / 3600)) +
      ":" +
      p2(Math.floor((sec % 3600) / 60)) +
      ":" +
      p2(sec % 60)
    );
  }

  function fmtHM(sec) {
    sec = ((Math.round(sec) % 86400) + 86400) % 86400;
    return (
      p2(Math.floor(sec / 3600)) + "\u00b7" + p2(Math.floor((sec % 3600) / 60))
    );
  }

  function windowIndexAt(t) {
    if (t < FIRST_WINDOW) return -1;
    return Math.floor((t - FIRST_WINDOW) / WINDOW_EVERY);
  }

  function windowState(t) {
    var idx = windowIndexAt(t);
    if (idx < 0) return { open: false, nextIn: FIRST_WINDOW - t };
    var into = t - FIRST_WINDOW - idx * WINDOW_EVERY;
    if (into <= WINDOW_OPEN) return { open: true, nextIn: 0 };
    return { open: false, nextIn: WINDOW_EVERY - into };
  }

  function freeLiftG() {
    return S.balloonVolume * GRAMS_PER_M3 - ENVELOPE;
  }

  function rangeKm() {
    return 8 + (S.altM / 1000) * 0.62;
  }

  function bearing() {
    return 10 + 34 * Math.sin(S.flightT / 23) + 12 * Math.sin(S.flightT / 7.3);
  }

  function neckBad() {
    if (S.faults["balloon neck slips off the nozzle"].active) return true;
    return S.balloonMounted && !S.clamped && S.balloonVolume > 0.02;
  }

  function alarmsNow() {
    var a = [];
    if (S.purity < PURITY_TRIP) a.push("EXPLOSIVE MIXTURE");
    if (S.temp >= OVERHEAT_ALARM) a.push("STACK OVERHEAT");
    if (S.faults["cooling water failure"].active) a.push("WATER MAINS OFF");
    if (neckBad()) a.push("NECK SLIPPED");
    if (S.level >= 0.995) a.push("HOLDER OVERFULL");
    if (S.missedLatch) a.push("SOUNDING MISSED");
    return a;
  }

  function flowFraction() {
    return S.flowPos === 2 ? 1 : S.flowPos === 1 ? 0.5 : 0;
  }

  /* --------------------------- simulation step -------------------------- */

  function step(dt) {
    S.t += dt;

    var fCross = S.faults["oxygen crossover"].active;
    var fWater = S.faults["cooling water failure"].active;
    var fNeck = S.faults["balloon neck slips off the nozzle"].active;

    /* electrical */
    var want = S.running && !S.lockedOut && !S.tripped ? S.rheoSet : 0;
    S.current = approach(S.current, want, 220, dt);

    /* thermal */
    var cool = fWater ? 0 : flowFraction();
    var dT =
      (HEAT_K * S.current * S.current - cool * 0.062 * (S.temp - AMBIENT)) /
      TEMP_TAU;
    S.temp = clamp(S.temp + dT * dt, AMBIENT, 140);
    if (S.temp >= TRIP_TEMP && S.running) {
      S.running = false;
      S.tripped = true;
    }

    /* purity */
    var pTarget = 99.6;
    var pRate = 0.004;
    if (fCross) {
      pTarget = 86;
      pRate = 0.28;
    } else if (S.temp >= OVERHEAT_ALARM) {
      pTarget = 91;
      pRate = 0.05;
    }
    if (S.purging && !S.running) {
      S.purity = approach(S.purity, 99.6, 1.4, dt);
    } else {
      S.purity = approach(S.purity, pTarget, pRate, dt);
    }
    if (S.purity < PURITY_TRIP && !S.lockedOut) {
      S.lockedOut = true;
      S.running = false;
    }

    /* purge hold */
    if (S.purging) {
      S.level = clamp(S.level - (PURGE_RATE * dt) / CAPACITY, 0, 1);
      S.purgeHold += dt;
      if (S.lockedOut && S.purity >= PURITY_SAFE && S.purgeHold >= 5) {
        S.lockedOut = false;
        S.purgeHold = 0;
      }
    } else {
      S.purgeHold = 0;
    }

    /* generation */
    var gen = 0;
    if (S.current > 1 && !S.lockedOut && !S.tripped) {
      gen = (S.current / 1000) * 0.0288 * S.banks; /* m3/s */
    }
    S.draught = 4 + gen * 260;

    /* holder */
    S.level = S.level + (gen * dt) / CAPACITY;
    if (S.ventOpen)
      S.level = clamp(S.level - (VENT_RATE * dt) / CAPACITY, 0, 1);
    if (S.level > 1) S.level = 1; /* safety wastes the rest */

    /* balloon fill and leak */
    if (
      S.fillOpen &&
      S.balloonMounted &&
      S.clamped &&
      S.level > 0.002 &&
      !S.inFlight
    ) {
      var move = Math.min(DRAW_RATE * dt, S.level * CAPACITY);
      S.balloonVolume += move;
      S.level = clamp(S.level - move / CAPACITY, 0, 1);
    }
    if (S.balloonMounted && !S.clamped && S.balloonVolume > 0) {
      var loss = Math.min((fNeck ? 0.05 : 0.028) * dt, S.balloonVolume);
      S.balloonVolume -= loss;
    }

    /* sounding windows and consequences */
    var k = windowIndexAt(S.t);
    if (k >= 0) {
      var closeT = FIRST_WINDOW + k * WINDOW_EVERY + WINDOW_OPEN;
      if (S.t > closeT && S.lastClosedIdx < k) {
        S.lastClosedIdx = k;
        if (!S.launched && !S.inFlight && !S.finished) S.missedLatch = true;
      }
    }

    /* ascent */
    if (S.inFlight) {
      S.flightT += dt;
      S.altM = Math.min(BURST_ALT * 1000, S.altM + ASCENT_RATE * dt);
      if (Math.abs(S.trackDeg - bearing()) <= 6) S.onTargetSum += dt;
      if (S.altM >= BURST_ALT * 1000) {
        S.inFlight = false;
        var pct = Math.round((100 * S.onTargetSum) / Math.max(1, S.flightT));
        S.finished = pct >= 85 ? "GOOD" : pct >= 55 ? "FAIR" : "POOR";
        S.resultClass = S.finished === "POOR" ? "bad" : "good";
        S.resultMsg = "BURST \u00b7 " + S.finished;
        document.getElementById("thd-dot").hidden = true;
        document.querySelector(".hatch").classList.remove("open");
      }
    }

    /* transient refusals fade */
    if (
      S.resultUntil > 0 &&
      S.resultUntil < S.t &&
      S.resultMsg.indexOf("REFUSED") === 0
    ) {
      S.resultMsg = "";
      S.resultClass = "";
      S.resultUntil = 0;
    }
  }

  /* ------------------------------ public API ---------------------------- */

  function state() {
    var w = windowState(S.t);
    var pctFlight =
      S.inFlight || S.finished
        ? Math.round((100 * S.onTargetSum) / Math.max(1, S.flightT))
        : 0;
    return {
      clock: fmtClock(clockSeconds()),
      elapsed: Math.round(S.t * 10) / 10,
      generator: {
        running: !!S.running,
        lockedOut: !!S.lockedOut,
        tripped: !!S.tripped,
        demandedCurrent: Math.round(S.rheoSet),
        current: Math.round(S.current),
        cellBanks: S.banks,
        temperature: Math.round(S.temp * 10) / 10,
        purity: Math.round(S.purity * 10) / 10,
        coolingPosition: S.flowPos,
      },
      holder: {
        level: Math.round(S.level * 1000) / 1000,
        storedM3: Math.round(S.level * CAPACITY * 100) / 100,
        draughtMM: Math.round(S.draught * 10) / 10,
        ventOpen: !!S.ventOpen,
      },
      balloon: {
        mounted: !!S.balloonMounted,
        clamped: !!S.clamped,
        fillingValveOpen: !!S.fillOpen,
        volumeM3: Math.round(S.balloonVolume * 1000) / 1000,
        freeLiftG: Math.round(freeLiftG()),
        targetG: Math.round(S.target),
      },
      window: {
        open: !!w.open,
        nextInS: Math.max(0, Math.round(w.nextIn)),
        missedThisShift: !!S.missedLatch,
      },
      ascent: {
        inFlight: !!S.inFlight,
        altitudeKm: Math.round(S.altM / 100) / 10,
        rangeKm: Math.round(rangeKm()),
        bearingDeg: Math.round(bearing() * 10) / 10,
        trackDeg: Math.round(S.trackDeg),
        onTargetPct: pctFlight,
        result: S.finished || S.resultMsg || "",
      },
      purgeReadyToClear: !S.lockedOut,
      alarms: alarmsNow(),
    };
  }

  function tick(seconds) {
    var remain = Math.max(0, Number(seconds) || 0);
    while (remain > 0) {
      var dt = Math.min(0.5, remain);
      step(dt);
      remain -= dt;
    }
  }

  function inject(fault) {
    var f = S.faults[fault];
    if (!f) return;
    f.active = true;
    if (fault === "balloon neck slips off the nozzle") {
      S.clamped = false;
      if (!S.balloonMounted) {
        /* the training rig seats a demonstration balloon so the loss is seen */
        S.balloonMounted = true;
        S.balloonVolume = 1.4;
      }
    }
    syncWorksSwitches();
  }

  function clearFault(fault) {
    var f = S.faults[fault];
    if (f) f.active = false;
    syncWorksSwitches();
  }

  function reset() {
    S = fresh();
    $$(".works input[data-test]").forEach(function (i) {
      i.checked = false;
    });
    $("#gen-switch").setAttribute("aria-pressed", "false");
    $("#water-cock").dataset.pos = "0";
    guard.classList.remove("open");
    document.querySelector(".hatch").classList.remove("open");
    render();
  }

  window.machine = {
    name: "Tarskerry Upper-Air Station \u2014 Hydrogen Shed",
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ------------------------------- rendering ---------------------------- */

  function $(sel) {
    return document.querySelector(sel);
  }
  function $$(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  function mapAng(v, lo, hi) {
    return -60 + 120 * clamp((v - lo) / (hi - lo), 0, 1);
  }

  var flagEls = {};
  ["explosive", "overheat", "water", "neck", "holder", "missed"].forEach(
    function (n) {
      flagEls[n] = document.getElementById("flag-" + n);
    },
  );

  function render() {
    var st = state();

    /* needles */
    $('[data-needle="current"]').style.setProperty(
      "--a",
      mapAng(st.generator.current, 0, 480) + "deg",
    );
    $('[data-needle="temp"]').style.setProperty(
      "--a",
      mapAng(st.generator.temperature, 15, 100) + "deg",
    );
    $('[data-needle="signal"]').style.setProperty(
      "--a",
      mapAng(S.inFlight ? Math.max(0, 96 - rangeKm() * 0.33) : 0, 0, 100) +
        "deg",
    );
    $('[data-needle="lift"]').style.setProperty(
      "--a",
      mapAng(st.balloon.freeLiftG, 400, 1200) + "deg",
    );

    /* lockout lamp */
    $("#locklamp").classList.toggle(
      "locked",
      st.generator.lockedOut || st.generator.tripped,
    );

    /* holder and u-gauge */
    $("#holder-bell").style.setProperty("--lvl", String(st.holder.level));
    var dr = clamp(st.holder.draughtMM / 40, 0, 1);
    $("#ug-left").style.setProperty("--l", (30 - 22 * dr).toFixed(1) + "%");
    $("#ug-right").style.setProperty("--r", (30 + 22 * dr).toFixed(1) + "%");

    /* cooling sight glass */
    $(".sg-water").style.height =
      (st.generator.coolingPosition === 2
        ? 86
        : st.generator.coolingPosition === 1
          ? 46
          : 8) + "%";
    $(".sightglass").classList.toggle(
      "flowing",
      st.generator.coolingPosition > 0,
    );

    /* clock and window card */
    var secs = clockSeconds();
    var hh = Math.floor((secs % 43200) / 3600),
      mm = (secs % 3600) / 60;
    $("#clk-hour").style.transform = "rotate(" + (hh * 30 + mm * 0.5) + "deg)";
    $("#clk-min").style.transform = "rotate(" + mm * 6 + "deg)";
    $("#next-window").textContent = st.window.open
      ? "OPEN NOW"
      : fmtHM(secs + st.window.nextInS) + " GMT";
    var ws = $("#window-state");
    ws.textContent = st.window.open
      ? "WINDOW OPEN \u2014 LAUNCH"
      : "WINDOW SHUT";
    ws.classList.toggle("open", st.window.open);

    /* release key */
    $("#release-key").disabled = !S.guardOpen || st.ascent.inFlight;
    $("#release-key").setAttribute(
      "aria-pressed",
      S.keyTurned ? "true" : "false",
    );

    /* balloon geometry */
    var b = $("#balloon");
    if (!st.balloon.mounted) {
      b.style.width = "0px";
      b.style.height = "0px";
      b.classList.add("gone");
    } else {
      b.classList.remove("gone");
      var hgt = 34 + 168 * clamp(st.balloon.volumeM3 / 1.9, 0, 1.05);
      b.style.width = (hgt * 0.84).toFixed(1) + "px";
      b.style.height = hgt.toFixed(1) + "px";
    }

    /* neckline from nozzle tip to balloon underside */
    var nl = $("#neckline");
    if (st.balloon.mounted && b.getBoundingClientRect().height > 2) {
      var wrap = $(".balloonwrap").getBoundingClientRect();
      var bal = b.getBoundingClientRect();
      var stand = $(".ns-nozzle").getBoundingClientRect();
      var x1 = stand.left + stand.width / 2 - wrap.left;
      var y1 = stand.top - wrap.top;
      var x2 = bal.left + bal.width / 2 - wrap.left;
      var y2 = bal.bottom - wrap.top - bal.height * 0.04;
      nl.hidden = false;
      nl.style.left = x2 - 2.5 + "px";
      nl.style.top = y1 + "px";
      nl.style.height = Math.max(2, y2 - y1) + "px";
    } else {
      nl.hidden = true;
    }

    /* balance target index */
    var tx = (47 + ((S.target - 800) / 200) * 21).toFixed(1) + "%";
    var ti = $("#target-index");
    ti.style.left = tx;

    /* theodolite dot */
    var dot = $("#thd-dot");
    if (st.ascent.inFlight) {
      var brad = (bearing() * Math.PI) / 180;
      var fr = clamp(S.altM / (BURST_ALT * 1000), 0, 1);
      dot.hidden = false;
      dot.style.left = 50 + Math.sin(brad) * 44 + "%";
      dot.style.top = 56 - fr * 44 + "%";
    } else {
      dot.hidden = true;
    }

    /* counters */
    var flown = st.ascent.inFlight || st.ascent.result.indexOf("BURST") === 0;
    $("#ctr-alt").textContent = flown
      ? st.ascent.altitudeKm.toFixed(1)
      : "\u2014";
    $("#ctr-range").textContent = flown ? st.ascent.rangeKm : "\u2014";
    $("#ctr-on").textContent = flown ? st.ascent.onTargetPct : "\u2014";
    var res = $("#ctr-result");
    res.textContent =
      st.ascent.result ||
      (st.window.open
        ? "WINDOW OPEN"
        : st.balloon.mounted
          ? "STANDBY"
          : "\u2014");
    res.className = "result " + S.resultClass;

    /* annunciator flags */
    var al = st.alarms;
    flagEls.explosive.classList.toggle(
      "on",
      al.indexOf("EXPLOSIVE MIXTURE") >= 0,
    );
    flagEls.overheat.classList.toggle("on", al.indexOf("STACK OVERHEAT") >= 0);
    flagEls.water.classList.toggle("on", al.indexOf("WATER MAINS OFF") >= 0);
    flagEls.neck.classList.toggle("on", al.indexOf("NECK SLIPPED") >= 0);
    flagEls.holder.classList.toggle("on", al.indexOf("HOLDER OVERFULL") >= 0);
    flagEls.missed.classList.toggle("on", al.indexOf("SOUNDING MISSED") >= 0);

    /* control chrome that follows state */
    $("#vent-lever").setAttribute(
      "aria-pressed",
      S.ventOpen ? "true" : "false",
    );
    $("#fill-valve").setAttribute(
      "aria-pressed",
      S.fillOpen ? "true" : "false",
    );
    $("#neck-clamp").setAttribute("aria-pressed", S.clamped ? "true" : "false");
    $("#cellsel").setAttribute("aria-valuenow", String(S.banks));
    $$(".sel-names b").forEach(function (el, i) {
      el.classList.toggle("cur", i === S.banks);
    });
    $("#rheostat").setAttribute("aria-valuenow", String(Math.round(S.rheoSet)));
    $("#balance-crank").setAttribute(
      "aria-valuenow",
      String(Math.round(S.target)),
    );
    $("#track-crank").setAttribute(
      "aria-valuenow",
      String(Math.round(S.trackDeg)),
    );

    $("#rheostat .knob-pointer").style.transform =
      "rotate(" + (-90 + (180 * S.rheoSet) / 480) + "deg)";
    $("#cellsel .sel-pointer").style.transform =
      "rotate(" + (-60 + 60 * S.banks) + "deg)";
    $("#balance-crank .knob-pointer").style.transform =
      "rotate(" + (-70 + (140 * (S.target - 700)) / 200) + "deg)";
    $("#track-crank .knob-pointer").style.transform =
      "rotate(" + S.trackDeg + "deg)";

    $("#purge-btn").classList.toggle("purging", S.purging);

    audioFrame(st);
  }

  /* ------------------------------- controls ----------------------------- */

  function bindKnob(el, get, set, stepSize, lo, hi, vertical) {
    var dragging = false,
      lastY = 0,
      lastX = 0;
    el.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastY = e.clientY;
      lastX = e.clientX;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* headless */
      }
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var d = vertical ? lastY - e.clientY : e.clientX - lastX;
      lastY = e.clientY;
      lastX = e.clientX;
      set(clamp(get() + (d * stepSize) / 14, lo, hi));
      render();
    });
    el.addEventListener("pointerup", function () {
      dragging = false;
    });
    el.addEventListener("keydown", function (e) {
      var k = e.key;
      var dir =
        k === "ArrowUp" || k === "ArrowRight"
          ? 1
          : k === "ArrowDown" || k === "ArrowLeft"
            ? -1
            : 0;
      if (dir) {
        set(clamp(get() + dir * stepSize, lo, hi));
        render();
        e.preventDefault();
      } else if (k === "Home") {
        set(lo);
        render();
        e.preventDefault();
      } else if (k === "End") {
        set(hi);
        render();
        e.preventDefault();
      }
    });
  }

  bindKnob(
    $("#rheostat"),
    function () {
      return S.rheoSet;
    },
    function (v) {
      S.rheoSet = Math.round(v / 20) * 20;
    },
    20,
    0,
    480,
    true,
  );

  bindKnob(
    $("#balance-crank"),
    function () {
      return S.target;
    },
    function (v) {
      S.target = Math.round(v / 10) * 10;
    },
    10,
    700,
    900,
    false,
  );

  bindKnob(
    $("#track-crank"),
    function () {
      return S.trackDeg;
    },
    function (v) {
      S.trackDeg = Math.round(v);
    },
    4,
    -60,
    60,
    false,
  );

  /* cell bank selector steps through its three positions */
  $("#cellsel").addEventListener("pointerdown", function () {
    S.banks = (S.banks + 1) % 3;
    render();
  });
  $("#cellsel").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      S.banks = (S.banks + 1) % 3;
      render();
      e.preventDefault();
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      S.banks = Math.min(2, S.banks + 1);
      render();
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      S.banks = Math.max(0, S.banks - 1);
      render();
      e.preventDefault();
    }
  });

  /* knife switch */
  $("#gen-switch").addEventListener(
    "click",
    function () {
      if (S.running) {
        S.running = false;
      } else if (!S.lockedOut && !(S.tripped && S.temp > RESTART_TEMP)) {
        S.tripped = false;
        S.running = true;
      }
      this.setAttribute("aria-pressed", S.running ? "true" : "false");
      render();
    }.bind(document.getElementById("gen-switch")),
  );

  /* cooling cock cycles shut -> half -> open -> shut */
  $("#water-cock").addEventListener(
    "click",
    function () {
      S.flowPos = (S.flowPos + 1) % 3;
      this.dataset.pos = String(S.flowPos);
      this.setAttribute(
        "aria-label",
        "Cooling water cock: " + ["shut", "half", "open"][S.flowPos],
      );
      render();
    }.bind(document.getElementById("water-cock")),
  );

  /* momentary purge valve: hold to purge */
  var purgeBtn = $("#purge-btn");
  function purgeOn() {
    S.purging = true;
    render();
  }
  function purgeOff() {
    S.purging = false;
    render();
  }
  purgeBtn.addEventListener("pointerdown", function (e) {
    purgeOn();
    e.preventDefault();
  });
  purgeBtn.addEventListener("pointerup", purgeOff);
  purgeBtn.addEventListener("pointerleave", purgeOff);
  purgeBtn.addEventListener("keydown", function (e) {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) purgeOn();
  });
  purgeBtn.addEventListener("keyup", function (e) {
    if (e.key === " " || e.key === "Enter") purgeOff();
  });

  /* holder vent lever */
  $("#vent-lever").addEventListener("click", function () {
    S.ventOpen = !S.ventOpen;
    render();
  });

  /* filling valve lever */
  $("#fill-valve").addEventListener("click", function () {
    S.fillOpen = !S.fillOpen;
    render();
  });

  /* neck clamp screw */
  $("#neck-clamp").addEventListener("click", function () {
    if (S.faults["balloon neck slips off the nozzle"].active) return;
    S.clamped = !S.clamped;
    render();
  });

  /* new balloon plunger */
  $("#new-balloon").addEventListener("click", function () {
    if (S.balloonMounted || S.inFlight) return;
    S.balloonMounted = true;
    S.balloonVolume = 0.06;
    S.clamped = false;
    S.finished = "";
    S.resultMsg = "";
    S.resultClass = "";
    S.resultUntil = 0;
    render();
  });

  /* release key guard and key */
  var guard = $("#key-guard");
  guard.setAttribute("role", "button");
  guard.setAttribute("tabindex", "0");
  guard.setAttribute("aria-label", "Lift the release key guard");
  function toggleGuard() {
    S.guardOpen = !S.guardOpen;
    guard.classList.toggle("open", S.guardOpen);
    render();
  }
  guard.addEventListener("click", toggleGuard);
  guard.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      toggleGuard();
      e.preventDefault();
    }
  });

  $("#release-key").addEventListener("click", function () {
    if (!S.guardOpen || S.inFlight) return;
    var w = windowState(S.t);
    if (!w.open) {
      S.resultMsg = "REFUSED \u2014 NO WINDOW";
      S.resultUntil = S.t + 5;
      render();
      return;
    }
    if (freeLiftG() < S.target - 12) {
      S.resultMsg = "REFUSED \u2014 LOW FREE LIFT";
      S.resultUntil = S.t + 5;
      render();
      return;
    }
    /* away she goes */
    S.keyTurned = true;
    S.launched = true;
    S.balloonMounted = false;
    S.fillOpen = false;
    S.inFlight = true;
    S.flightT = 0;
    S.altM = 0;
    S.onTargetSum = 0;
    document.querySelector(".hatch").classList.add("open");
    render();
  });

  /* alarm flag reset */
  $("[data-action='flags']").addEventListener("click", function () {
    S.missedLatch = false;
    render();
  });

  /* works test switches */
  function syncWorksSwitches() {
    $$(".works input[data-test]").forEach(function (i) {
      var f = S.faults[i.getAttribute("data-test")];
      if (f) i.checked = f.active;
    });
  }
  $$(".works input[data-test]").forEach(function (i) {
    i.addEventListener("change", function () {
      if (i.checked) inject(i.getAttribute("data-test"));
      else clearFault(i.getAttribute("data-test"));
      render();
    });
  });

  /* -------------------------------- audio ------------------------------- */

  var actx = null,
    hissGain = null,
    soundLive = false;
  var soundBox = $("#soundcut");

  function initAudio() {
    soundLive = !soundBox.checked;
    if (actx) {
      if (actx.resume) actx.resume();
      return;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      var len = actx.sampleRate * 2;
      var buf = actx.createBuffer(1, len, actx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      var src = actx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      var bp = actx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 850;
      bp.Q.value = 0.7;
      hissGain = actx.createGain();
      hissGain.gain.value = 0;
      src.connect(bp);
      bp.connect(hissGain);
      hissGain.connect(actx.destination);
      src.start();
    } catch (err) {
      actx = null;
    }
  }
  document.addEventListener("pointerdown", initAudio);

  function audioFrame(st) {
    if (!actx || !hissGain) return;
    var g = 0;
    if (soundLive && !soundBox.checked) {
      if (S.purging) g = 0.22;
      else if (st.balloon.fillingValveOpen && st.holder.storedM3 > 0.01)
        g = 0.17;
      else if (st.generator.running) g = 0.045;
    }
    hissGain.gain.setTargetAtTime(g, actx.currentTime, 0.12);
  }

  /* --------------------------- manual dialog ---------------------------- */

  var manualDlg = document.querySelector("dialog[data-manual]");
  document
    .querySelector('[data-action="manual"]')
    .addEventListener("click", function () {
      if (typeof manualDlg.showModal === "function") manualDlg.showModal();
      else manualDlg.setAttribute("open", "");
      render();
    });
  document
    .querySelector('[data-action="close-manual"]')
    .addEventListener("click", function () {
      manualDlg.close ? manualDlg.close() : manualDlg.removeAttribute("open");
      render();
    });

  /* ------------------------------ main loop ----------------------------- */

  var lastStamp = null;
  function frame(ts) {
    if (lastStamp !== null && !document.hidden) {
      var dt = Math.min(0.5, (ts - lastStamp) / 1000);
      if (dt > 0.016) {
        tick(dt);
        render();
      }
    }
    lastStamp = ts;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  render();
})();
