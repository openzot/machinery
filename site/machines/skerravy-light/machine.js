/* ============================================================
   Skerravy Light — optic driving & fog-signal machinery, 1924.
   Weight-driven optic, electric cell carousel, compressed-air
   fog signal. One falling weight drives everything; the keeper's
   job is to keep the character of the light against the weather.
   ============================================================ */
(function () {
  "use strict";

  /* ------------------------------ constants ----------------------------- */

  var FALL_MAX_FT = 36; // height of fall of the driving weight
  var NOMINAL_PERIOD_S = 45; // the governor plate's own figure
  var PERIOD_MIN_S = 30;
  var PERIOD_MAX_S = 60;
  var DRAIN_NOMINAL_FT_S = 36 / 480; // full weight ≈ eight minutes' running
  var WIND_FT_S = 7; // hoisting rate at the crank
  var AIR_FULL_PSI = 200;
  var AIR_START_PSI = 180;
  var AIR_CHARGE_PSI_MIN = 14; // compressor geared off the main train
  var AIR_BLOW_PSI_MIN = 28;
  var AIR_LEAK_PSI_MIN = 80; // total loss while the cock stands off HOLD
  var AIR_LEAK_WEAP_PSI_MIN = 14; // the weep that survives HOLD
  var AIR_LOW_PSI = 130;
  var AIR_BLOW_CUT_PSI = 25; // below this the trumpet cannot speak
  var CELL_COUNT = 4;
  var CELL_LIFE_H = 12;
  var CHANGE_DWELL_S = 3; // carousel passing between cells
  var OVERSPEED_FACTOR = 1.3;
  var SLIP_FACTOR = 1.75;

  var ALARMS = {
    WEIGHT_LOW: "WEIGHT LOW",
    OPTIC_STOPPED: "OPTIC STOPPED",
    OVERSPEED: "GOVERNOR OVERSPEED",
    LAMP_FAILED: "LAMP FAILED",
    NO_SPARE: "NO SPARE CELL",
    AIR_LOW: "AIR PRESSURE LOW",
    FOG_SILENT: "FOG SILENT",
  };

  var VIS_NAMES = ["CLEAR", "MIST", "FOG", "DENSE"];
  var COCK_NAMES = ["CHARGE", "HOLD", "BLOW"];
  var ROMANS = ["I", "II", "III", "IV"];

  /* ------------------------------- state -------------------------------- */

  var st;

  function freshCells() {
    var cells = [];
    for (var i = 0; i < CELL_COUNT; i++) {
      cells.push({ healthPct: 100, dead: false });
    }
    return cells;
  }

  function coldState() {
    return {
      t: 0,
      weightFt: FALL_MAX_FT,
      opticDeg: 0,
      opticDps: 0,
      revolutions: 0,
      clutchIn: false,
      governorS: NOMINAL_PERIOD_S,
      cockPos: 0, // CHARGE - the valve is found standing open between watches
      airPsi: AIR_START_PSI,
      cells: freshCells(),
      cellNow: 1, // 1-based
      selectMode: "auto",
      changeDwellS: 0,
      darkFromLampS: 0,
      opticStoppedS: 0,
      fogSilentS: 0,
      bellSilenced: false,
      bellAcceptsLamp: false,
      bellT: 999,
      lampAlarmLatched: false,
      blastT: 0,
      trumpetSpeaking: false,
      visibilityIdx: 0,
      fogLevel: 0,
      faults: {
        "governor slip": false,
        "filament burnout": false,
        "air main leak": false,
      },
      alarms: [],
      incidents: [],
      lastEvent: null,
      lastIncidentAt: -9999,
      winding: false,
      crankDeg: 0,
      ratchetT: 0,
      lampLit: true,
      lampVolts: 13.6,
      lampHealthPct: 100,
    };
  }

  /* --------------------------- deterministic helpers -------------------- */

  function wobble(t, seed) {
    return Math.sin(t * seed) * Math.cos(t * seed * 0.37);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function roman(n) {
    return ROMANS[n - 1] || String(n);
  }

  function clock() {
    var m = Math.floor(st.t / 60);
    var s = Math.floor(st.t % 60);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function log(text) {
    st.lastEvent = { t: st.t, text: text };
  }

  function noteIncident(text) {
    if (
      st.incidents.length &&
      st.incidents[st.incidents.length - 1] === text &&
      st.t - st.lastIncidentAt < 240
    ) {
      return;
    }
    st.incidents.push(text);
    st.lastIncidentAt = st.t;
    log("INCIDENT — " + text);
  }

  /* ------------------------------ simulation ---------------------------- */

  // Weather off the Minch: a slow tide of haze, independent of the keeper.
  function fogLevel(t) {
    return clamp(
      1.35 +
        1.55 * Math.sin((2 * Math.PI * t) / 470) +
        0.75 * Math.sin((2 * Math.PI * t) / 163 + 1.2),
      0,
      3.6,
    );
  }

  function tick(seconds) {
    var dt = seconds;
    if (!(dt > 0)) return;
    while (dt > 0) {
      var h = dt > 0.5 ? 0.5 : dt; // sub-step long jumps for stability
      step(h);
      dt -= h;
    }
  }

  function step(dt) {
    st.t += dt;

    /* --- driving weight & optic speed ------------------------------------ */
    if (st.winding) {
      st.weightFt = Math.min(FALL_MAX_FT, st.weightFt + WIND_FT_S * dt);
      st.crankDeg += 430 * dt;
      st.ratchetT += dt;
      if (st.ratchetT > 0.11) {
        st.ratchetT = 0;
        sfx.ratchet();
      }
      if (st.weightFt >= FALL_MAX_FT)
        log("Weight hoisted full — fall of thirty-six feet.");
    }

    var period = clamp(st.governorS, PERIOD_MIN_S, PERIOD_MAX_S);
    var targetDps =
      (360 / period) * (st.faults["governor slip"] ? SLIP_FACTOR : 1);
    var driving = st.clutchIn && st.weightFt > 0;

    if (driving) {
      // the governor's balls swing out and throttle the train onto target
      var pull = clamp((targetDps - st.opticDps) * 0.55, -60 * dt, 26 * dt);
      st.opticDps += pull;
      var load = Math.pow(
        Math.max(st.opticDps, 0) / (360 / NOMINAL_PERIOD_S),
        1.25,
      );
      st.weightFt -=
        DRAIN_NOMINAL_FT_S * load * (st.faults["governor slip"] ? 2.1 : 1) * dt;
      if (st.weightFt <= 0) st.weightFt = 0;
    } else {
      // train out, or the weight is down: she coasts to rest
      st.opticDps -= st.opticDps * clamp(dt * 0.5, 0, 1);
      if (!st.clutchIn) st.opticDps -= 30 * dt;
      if (st.opticDps < 0.05) st.opticDps = 0;
    }
    if (st.opticDps < 0) st.opticDps = 0;

    st.opticDeg = (st.opticDeg + st.opticDps * dt) % 360;
    st.revolutions += (st.opticDps * dt) / 360;

    /* --- lamp & cell carousel -------------------------------------------- */
    var cur = st.cells[st.cellNow - 1];
    if (!cur.dead) {
      cur.healthPct -= (dt * 100) / (CELL_LIFE_H * 3600);
      if (cur.healthPct <= 0) burnCell(st.cellNow);
    }

    if (st.changeDwellS > 0) {
      st.changeDwellS = Math.max(0, st.changeDwellS - dt);
    }

    var healthy = !st.cells[st.cellNow - 1].dead;
    st.lampLit = healthy && st.changeDwellS === 0;
    // an acceptance given while the carousel is still passing takes effect
    // the moment the fresh cell lights
    if (st.bellAcceptsLamp && st.lampLit) {
      st.bellAcceptsLamp = false;
      st.lampAlarmLatched = false;
    }
    st.lampHealthPct = healthy ? st.cells[st.cellNow - 1].healthPct : 0;
    st.lampVolts = st.lampLit ? 13.6 + wobble(st.t, 0.9) * 0.22 : 0;

    if (st.lampLit) {
      st.darkFromLampS = 0;
    } else {
      st.darkFromLampS += dt;
    }

    /* --- air receivers ----------------------------------------------------- */
    // The compressor is belted to the main train: no turn, no charge.
    var turning = st.opticDps > 2;
    if (st.cockPos === 0 && turning) {
      st.airPsi += (AIR_CHARGE_PSI_MIN / 60) * dt;
    } else if (st.cockPos === 2) {
      st.airPsi -= (AIR_BLOW_PSI_MIN / 60) * dt;
    }
    // A leak forward of the receiver valve: the main weeps even with the
    // cock at HOLD, and pours out whenever it stands off HOLD.
    if (st.faults["air main leak"]) {
      st.airPsi -= (AIR_LEAK_WEAP_PSI_MIN / 60) * dt;
      if (st.cockPos !== 1) {
        st.airPsi -= ((AIR_LEAK_PSI_MIN - AIR_LEAK_WEAP_PSI_MIN) / 60) * dt;
      }
    }
    st.airPsi = clamp(st.airPsi, 0, AIR_FULL_PSI);

    /* --- fog signal -------------------------------------------------------- */
    var wanted = st.cockPos === 2 && st.airPsi >= AIR_BLOW_CUT_PSI;
    st.blastT += dt;
    st.trumpetSpeaking = wanted && st.blastT % 4 < 1.4;

    st.fogLevel = fogLevel(st.t - 150);
    st.visibilityIdx =
      st.fogLevel < 1 ? 0 : st.fogLevel < 2.2 ? 1 : st.fogLevel < 3 ? 2 : 3;

    var fogDuty = st.visibilityIdx >= 2; // FOG or DENSE: the signal must sound
    if (fogDuty && !st.trumpetSpeaking) {
      st.fogSilentS += dt;
    } else {
      st.fogSilentS = Math.max(0, st.fogSilentS - dt * 2);
    }

    /* --- alarms ------------------------------------------------------------ */
    var alarms = [];
    var slipping = st.faults["governor slip"];

    if (st.weightFt < FALL_MAX_FT * 0.25) alarms.push(ALARMS.WEIGHT_LOW);

    if (st.clutchIn && st.weightFt <= 0 && st.opticDps < 3) {
      st.opticStoppedS += dt;
    } else {
      st.opticStoppedS = 0;
    }
    if (st.clutchIn && st.opticStoppedS > 8) alarms.push(ALARMS.OPTIC_STOPPED);

    // a slipped governor cries overspeed even at rest - the trip sees the
    // flyballs seized wide
    if (
      slipping &&
      (st.opticDps > (360 / period) * OVERSPEED_FACTOR || !st.clutchIn)
    ) {
      alarms.push(ALARMS.OVERSPEED);
    }

    var anyHealthy = st.cells.some(function (c) {
      return !c.dead;
    });
    if (
      st.lampAlarmLatched ||
      (st.darkFromLampS > 1 && st.changeDwellS === 0)
    ) {
      alarms.push(ALARMS.LAMP_FAILED);
    }
    if (!anyHealthy && !healthy) alarms.push(ALARMS.NO_SPARE);

    if (st.airPsi < AIR_LOW_PSI) alarms.push(ALARMS.AIR_LOW);
    if (st.fogSilentS > 45) alarms.push(ALARMS.FOG_SILENT);

    st.alarms = alarms;

    /* --- consequences of ignoring them ------------------------------------- */
    if (alarms.indexOf(ALARMS.OPTIC_STOPPED) !== -1 && st.opticStoppedS > 75) {
      noteIncident("Vessel reports the light showing no character.");
    }
    if (st.darkFromLampS > 75) {
      noteIncident("Vessel reports the Skerravy light extinguished.");
    }
    if (st.fogSilentS > 135) {
      noteIncident("Coastguard logs a fog casualty off the rock.");
    }

    /* --- bell --------------------------------------------------------------- */
    if (alarms.length) {
      st.bellT += dt;
      if (!st.bellSilenced && st.bellT > 2.4) {
        st.bellT = 0;
        sfx.bell();
      }
    } else {
      st.bellSilenced = false;
      st.bellT = 999;
    }

    /* --- sounds tied to motion ---------------------------------------------- */
    sfx.train(turning ? st.opticDps : 0);
    sfx.trumpet(st.trumpetSpeaking);
  }

  function burnCell(n) {
    var c = st.cells[n - 1];
    if (!c || c.dead) return;
    c.dead = true;
    c.healthPct = 0;
    st.lampAlarmLatched = true;
    log("Filament of cell " + roman(n) + " burned at " + clock());
    if (st.selectMode === "auto") {
      for (var i = 1; i <= CELL_COUNT; i++) {
        var idx = ((st.cellNow - 1 + i) % CELL_COUNT) + 1;
        if (!st.cells[idx - 1].dead) {
          st.cellNow = idx;
          st.changeDwellS = CHANGE_DWELL_S;
          log("Carousel passed to cell " + roman(idx));
          return;
        }
      }
    }
  }

  /* -------------------------------- sound -------------------------------- */

  var sfx = (function () {
    var ctx = null;
    var master = null;
    var ready = false;
    var trainOsc = null;
    var trainGain = null;
    var trumpetNodes = null;

    function ensure() {
      if (ctx) return true;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        ready = true;
      } catch (e) {
        ctx = null;
        ready = false;
      }
      return ready;
    }

    function blip(freq, dur, type, vol) {
      if (!ready) return;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(ctx.currentTime + dur + 0.02);
    }

    return {
      unlock: function () {
        ensure();
      },
      ratchet: function () {
        if (ready) blip(1900, 0.03, "square", 0.05);
      },
      bell: function () {
        if (!ready) return;
        [1046, 1568].forEach(function (f, i) {
          var o = ctx.createOscillator();
          var g = ctx.createGain();
          o.type = "sine";
          o.frequency.value = f * (i ? 1.003 : 0.997);
          g.gain.setValueAtTime(i ? 0.05 : 0.09, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
          o.connect(g);
          g.connect(master);
          o.start();
          o.stop(ctx.currentTime + 1);
        });
      },
      train: function (dps) {
        if (!ready) return;
        if (!trainOsc) {
          trainOsc = ctx.createOscillator();
          trainGain = ctx.createGain();
          trainOsc.type = "triangle";
          trainGain.gain.value = 0;
          trainOsc.connect(trainGain);
          trainGain.connect(master);
          trainOsc.start();
        }
        var want = dps > 0.5 ? clamp(0.02 + dps / 900, 0, 0.06) : 0;
        trainGain.gain.setTargetAtTime(want, ctx.currentTime, 0.2);
        trainOsc.frequency.setTargetAtTime(
          34 + dps * 2.2,
          ctx.currentTime,
          0.2,
        );
      },
      trumpet: function (on) {
        if (!ready) return;
        if (on && !trumpetNodes) {
          var o = ctx.createOscillator();
          var g = ctx.createGain();
          var f = ctx.createBiquadFilter();
          o.type = "sawtooth";
          o.frequency.value = 92;
          f.type = "lowpass";
          f.frequency.value = 420;
          g.gain.setValueAtTime(0, ctx.currentTime);
          g.gain.linearRampToValueAtTime(0.14, ctx.currentTime + 0.18);
          o.connect(f);
          f.connect(g);
          g.connect(master);
          o.start();
          trumpetNodes = { o: o, g: g };
        } else if (!on && trumpetNodes) {
          var tn = trumpetNodes;
          trumpetNodes = null;
          tn.g.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
          setTimeout(function () {
            try {
              tn.o.stop();
            } catch (e) {
              /* already stopped */
            }
          }, 500);
        }
      },
      stop: function () {
        this.train(0);
        this.trumpet(false);
      },
    };
  })();

  /* ------------------------------ API ------------------------------------ */

  window.machine = {
    name: "Skerravy Light",
    faults: ["governor slip", "filament burnout", "air main leak"],

    state: function () {
      return {
        timeS: round(st.t),
        weightFt: round(st.weightFt),
        weightUsedPct: round(((FALL_MAX_FT - st.weightFt) / FALL_MAX_FT) * 100),
        opticDeg: round(st.opticDeg),
        opticDps: round(st.opticDps),
        revolutionPeriodS: st.opticDps > 0.1 ? round(360 / st.opticDps) : 0,
        governorSetS: round(st.governorS),
        revolutions: Math.floor(st.revolutions),
        clutchEngaged: st.clutchIn ? 1 : 0,
        winding: st.winding ? 1 : 0,
        lampCell: st.cellNow,
        lampSelector: st.selectMode,
        lampLit: st.lampLit ? 1 : 0,
        lampVolts: round(st.lampVolts),
        lampHealthPct: round(st.lampHealthPct),
        cellsDead: st.cells.map(function (c) {
          return c.dead ? 1 : 0;
        }),
        airPressurePsi: round(st.airPsi),
        airCock: COCK_NAMES[st.cockPos],
        fogSignalBlowing: st.trumpetSpeaking ? 1 : 0,
        visibilityIndex: st.visibilityIdx,
        visibility: VIS_NAMES[st.visibilityIdx],
        alarms: st.alarms.slice(),
        incidents: st.incidents.slice(),
        faultsActive: Object.keys(st.faults).filter(function (k) {
          return st.faults[k];
        }),
      };
    },

    tick: tick,

    inject: function (fault) {
      if (!(fault in st.faults)) return;
      st.faults[fault] = true;
      if (fault === "filament burnout") burnCell(st.cellNow);
      if (fault === "governor slip") log("Governor slipping — optic racing.");
      if (fault === "air main leak")
        log("Air main leaking forward of the receiver valve.");
      panel.syncFaults();
    },

    reset: function () {
      st = coldState();
      panel.syncAll();
      sfx.stop();
    },
  };

  function round(v) {
    return typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : 0;
  }

  /* ------------------------------ panel wiring --------------------------- */

  var panel = (function () {
    var d = document;
    var $ = function (s) {
      return d.querySelector(s);
    };
    var $$ = function (s) {
      return Array.prototype.slice.call(d.querySelectorAll(s));
    };

    var E = {
      optic: $("[data-optic]"),
      beam: $("[data-beam]"),
      lampdot: $("[data-lampdot]"),
      gearBig: $("[data-gear-big]"),
      gearSmall: $("[data-gear-small]"),
      chain: $("[data-chain]"),
      weight: $("[data-weight]"),
      coils: $$(".chain-coil"),
      trumpet: $("[data-trumpet]"),
      haze: $("[data-haze]"),
      crank: $("[data-control='WINDING CRANK']"),
      crankArm: $(".crank-arm"),
      clutch: $("[data-control='DRIVE CLUTCH']"),
      knob: $("[data-control='GOVERNOR']"),
      knobPointer: $(".knob-pointer"),
      revCounter: $("[data-readout='revolutions']"),
      selButtons: $$(".sel-pos"),
      cellWins: $$(".cell-window"),
      airNeedle: $("[data-dial='air'] [data-needle]"),
      voltsNeedle: $("[data-dial='volts'] [data-needle]"),
      cock: $("[data-control='FOG AIR COCK']"),
      cockHandle: $(".cock-handle"),
      visPointer: $("[data-vis-pointer]"),
      jewelRuby: $("[data-lamp='alarm-bell']"),
      jewelClear: $("[data-lamp='machine-turns']"),
      annWindows: $$(".ann-window"),
      bellBtn: $("[data-control='BELL SILENCE']"),
      tray: $("[data-control='FAULT TEST SWITCHES']"),
      trayCover: $("[data-tray-cover]"),
      faultBtns: $$(".fault-toggle"),
      logLine: $("[data-log]"),
      dialog: $("dialog[data-manual]"),
      openBook: $("[data-action='manual']"),
      closeBook: $("[data-action='close-manual']"),
    };

    var ANN = {};
    E.annWindows.forEach(function (w) {
      ANN[w.getAttribute("data-ann")] = w;
    });

    /* ---- winding crank ---- */

    function startWind(e) {
      sfx.unlock();
      st.winding = true;
      E.crank.classList.add("turning");
      if (E.crank.setPointerCapture && e && e.pointerId != null) {
        try {
          E.crank.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      }
      if (e && e.cancelable) e.preventDefault();
    }

    function stopWind() {
      st.winding = false;
      E.crank.classList.remove("turning");
    }

    E.crank.addEventListener("pointerdown", startWind);
    window.addEventListener("pointerup", stopWind);
    window.addEventListener("pointercancel", stopWind);
    E.crank.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !st.winding) {
        startWind(null);
        e.preventDefault();
      }
    });
    E.crank.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") stopWind();
    });
    E.crank.addEventListener("blur", stopWind);

    /* ---- clutch ---- */

    E.clutch.addEventListener("click", function () {
      sfx.unlock();
      st.clutchIn = !st.clutchIn;
      E.clutch.setAttribute("aria-pressed", st.clutchIn ? "true" : "false");
      log(
        st.clutchIn ? "Clutch engaged — train turning." : "Clutch thrown out.",
      );
    });

    /* ---- governor knob ---- */

    function syncKnob() {
      var frac = (PERIOD_MAX_S - st.governorS) / (PERIOD_MAX_S - PERIOD_MIN_S);
      E.knob.setAttribute("aria-valuenow", String(st.governorS));
      E.knob.setAttribute(
        "aria-valuetext",
        st.governorS + " seconds per revolution",
      );
      E.knob.dataset.angle = String(-120 + 240 * frac);
    }

    E.knob.addEventListener("keydown", function (e) {
      var steps = {
        ArrowUp: -2,
        ArrowRight: -2,
        ArrowDown: 2,
        ArrowLeft: 2,
        PageUp: -6,
        PageDown: 6,
      };
      if (e.key in steps) {
        st.governorS = clamp(
          Math.round(st.governorS) + steps[e.key],
          PERIOD_MIN_S,
          PERIOD_MAX_S,
        );
        syncKnob();
        e.preventDefault();
      } else if (e.key === "Home" || e.key === "End") {
        st.governorS = e.key === "Home" ? PERIOD_MIN_S : PERIOD_MAX_S;
        syncKnob();
        e.preventDefault();
      }
    });

    /* ---- fog air cock ---- */

    function syncCock() {
      E.cock.setAttribute("aria-valuenow", String(st.cockPos));
      E.cock.setAttribute("aria-valuetext", COCK_NAMES[st.cockPos]);
      E.cock.dataset.angle = String([-38, 0, 38][st.cockPos]);
    }

    E.cock.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        st.cockPos = clamp(st.cockPos + 1, 0, 2);
        syncCock();
        e.preventDefault();
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        st.cockPos = clamp(st.cockPos - 1, 0, 2);
        syncCock();
        e.preventDefault();
      } else if (e.key === "Home" || e.key === "End") {
        st.cockPos = e.key === "Home" ? 0 : 2;
        syncCock();
        e.preventDefault();
      }
    });

    E.cock.addEventListener("click", function (e) {
      if (e.detail === 0) return; // keyboard-invoked; arrows already work
      sfx.unlock();
      var r = E.cock.getBoundingClientRect();
      setCockFromX(e.clientX - r.left, r.width);
    });

    function setCockFromX(x, w) {
      var frac = w > 0 ? x / w : 0.5;
      st.cockPos = clamp(Math.round(frac * 2), 0, 2);
      syncCock();
    }

    /* ---- cell selector ---- */

    var CELL_ORDER = ["1", "2", "3", "4", "auto"];

    function syncSelector() {
      E.selButtons.forEach(function (b) {
        var v = b.getAttribute("data-cell");
        var on =
          st.selectMode === "auto"
            ? v === "auto"
            : parseInt(v, 10) === st.cellNow;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
    }

    function selectCell(val) {
      sfx.unlock();
      if (val === "auto") {
        st.selectMode = "auto";
        // let the carousel find the next live cell itself
        if (st.cells[st.cellNow - 1].dead) {
          for (var i = 1; i <= CELL_COUNT; i++) {
            var idx = ((st.cellNow - 1 + i) % CELL_COUNT) + 1;
            if (!st.cells[idx - 1].dead) break;
          }
          st.cellNow = idx;
          st.changeDwellS = CHANGE_DWELL_S;
        }
        log("Carousel to automatic changeover.");
      } else {
        var n = parseInt(val, 10);
        st.selectMode = "manual";
        if (st.cells[n - 1].dead) {
          log("Cell " + roman(n) + " is burned — choose another.");
        } else if (n !== st.cellNow) {
          st.cellNow = n;
          st.changeDwellS = CHANGE_DWELL_S;
          st.lampAlarmLatched = false;
          log("Carousel run to cell " + roman(n));
        } else {
          st.lampAlarmLatched = false;
        }
      }
      syncSelector();
    }

    E.selButtons.forEach(function (b, bi) {
      b.addEventListener("click", function () {
        selectCell(b.getAttribute("data-cell"));
      });
      b.addEventListener("keydown", function (e) {
        var dir = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = -1;
        if (dir !== 0) {
          var ni = clamp(bi + dir, 0, CELL_ORDER.length - 1);
          selectCell(CELL_ORDER[ni]);
          E.selButtons[ni].focus();
          e.preventDefault();
        }
      });
    });

    /* ---- bell, tray, book ---- */

    E.bellBtn.addEventListener("click", function () {
      sfx.unlock();
      st.bellSilenced = true;
      if (st.lampLit) st.lampAlarmLatched = false;
      st.bellAcceptsLamp = true; // covers the burnout accepted mid-changeover
      log("Bell silenced.");
    });

    E.trayCover.addEventListener("click", function () {
      var open = E.tray.classList.toggle("open");
      E.trayCover.setAttribute("aria-expanded", open ? "true" : "false");
    });

    function syncFaults() {
      E.faultBtns.forEach(function (b) {
        b.setAttribute(
          "aria-pressed",
          st.faults[b.getAttribute("data-inject")] ? "true" : "false",
        );
      });
    }

    E.faultBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        sfx.unlock();
        var name = b.getAttribute("data-inject");
        if (st.faults[name]) {
          st.faults[name] = false;
          log("Test switch off — " + name + " cleared.");
          if (name === "filament burnout") selectCell("auto");
        } else {
          window.machine.inject(name);
        }
        syncFaults();
      });
    });

    if (E.openBook) {
      E.openBook.addEventListener("click", function () {
        sfx.unlock();
        if (typeof E.dialog.showModal === "function") E.dialog.showModal();
        else E.dialog.setAttribute("open", "");
      });
    }
    if (E.closeBook) {
      E.closeBook.addEventListener("click", function () {
        if (typeof E.dialog.close === "function" && E.dialog.open)
          E.dialog.close();
        else E.dialog.removeAttribute("open");
      });
    }

    /* ---- rendering ---- */

    var NEEDLE_SPAN = 220; // degrees swept across a dial face

    function setNeedle(needle, frac) {
      var a = -NEEDLE_SPAN / 2 + NEEDLE_SPAN * clamp(frac, 0, 1);
      needle.style.transform =
        "translate(-2px,-100%) rotate(" + a.toFixed(1) + "deg)";
    }

    function pad6(n) {
      var s = String(Math.max(0, Math.floor(n)) % 1000000);
      while (s.length < 6) s = "0" + s;
      return s;
    }

    var lastBeam = false;

    function render() {
      E.optic.style.transform = "rotate(" + st.opticDeg.toFixed(2) + "deg)";
      if (E.gearBig)
        E.gearBig.style.transform =
          "rotate(" + (-st.opticDeg * 0.42).toFixed(2) + "deg)";
      if (E.gearSmall)
        E.gearSmall.style.transform =
          "rotate(" + (st.opticDeg * 1.17).toFixed(2) + "deg)";

      // the beam breathes while a lens facet faces seaward
      var phase = st.opticDeg % 90;
      var flashing =
        st.lampLit && st.opticDps > 0.5 && (phase < 9 || phase > 81);
      if (flashing !== lastBeam) {
        E.beam.style.opacity = flashing ? "0.9" : "0";
        lastBeam = flashing;
      }

      E.lampdot.classList.toggle("lit", st.lampLit);
      E.jewelClear.classList.toggle("lit-clear", st.opticDps > 2);

      var well = E.weight.parentElement;
      var travel = Math.max(40, well.clientHeight - 44);
      var depthFrac = clamp(1 - st.weightFt / FALL_MAX_FT, 0, 1);
      E.weight.style.bottom = ((1 - depthFrac) * travel).toFixed(1) + "px";
      E.chain.style.transform =
        "translateY(" + ((depthFrac * travel * 0.16) % 16).toFixed(1) + "px)";

      var coils =
        depthFrac > 0.97 ? 3 : depthFrac > 0.78 ? 2 : depthFrac > 0.52 ? 1 : 0;
      E.coils.forEach(function (c, i) {
        c.style.opacity = i < coils ? "1" : "0";
      });

      E.trumpet.classList.toggle("blowing", !!st.trumpetSpeaking);

      var hazeOp = [0, 0.28, 0.62, 0.88][st.visibilityIdx];
      E.haze.style.opacity = String(hazeOp);
      E.visPointer.style.left = (4 + st.visibilityIdx * 30.6).toFixed(1) + "%";

      setNeedle(E.airNeedle, st.airPsi / AIR_FULL_PSI);
      setNeedle(E.voltsNeedle, st.lampVolts / 15);

      E.revCounter.textContent = pad6(st.revolutions);

      var govFrac =
        (PERIOD_MAX_S - st.governorS) / (PERIOD_MAX_S - PERIOD_MIN_S);
      E.knobPointer.style.transform =
        "rotate(" + (-120 + 240 * govFrac).toFixed(1) + "deg)";

      E.cockHandle.style.transform =
        "rotate(" + [-38, 0, 38][st.cockPos] + "deg)";

      st.cells.forEach(function (c, i) {
        var w = E.cellWins[i];
        w.classList.toggle("current", i + 1 === st.cellNow);
        w.classList.toggle("hot", st.lampLit && i + 1 === st.cellNow);
        w.classList.toggle("dead", c.dead);
      });

      var alarmed = st.alarms.length > 0;
      E.jewelRuby.classList.toggle("lit-ruby", alarmed && !st.bellSilenced);
      Object.keys(ANN).forEach(function (name) {
        ANN[name].classList.toggle("fallen", st.alarms.indexOf(name) !== -1);
      });

      var line;
      if (st.incidents.length) {
        line = "STATION LOG — " + st.incidents[st.incidents.length - 1];
      } else if (alarmed) {
        line = "Alarms standing: " + st.alarms.join(", ") + ".";
      } else if (st.lastEvent && st.t - st.lastEvent.t < 30) {
        line = clock() + " — " + st.lastEvent.text;
      } else {
        line = "Station log — all clear.";
      }
      E.logLine.textContent = line;
      E.logLine.classList.toggle(
        "alarming",
        alarmed || st.incidents.length > 0,
      );
    }

    function syncAll() {
      E.clutch.setAttribute("aria-pressed", st.clutchIn ? "true" : "false");
      syncKnob();
      syncCock();
      syncSelector();
      syncFaults();
      render();
    }

    return { render: render, syncAll: syncAll, syncFaults: syncFaults };
  })();

  /* ------------------------------ main loop ------------------------------ */

  st = coldState();

  var lastT = null;
  function frame(now) {
    if (lastT === null) lastT = now;
    var dt = (now - lastT) / 1000;
    lastT = now;
    if (!document.hidden && dt > 0) {
      if (dt > 0.25) dt = 0.25;
      step(dt);
      panel.render();
    }
    requestAnimationFrame(frame);
  }

  panel.syncAll();
  requestAnimationFrame(frame);
})();
