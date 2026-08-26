/* ============================================================
   St. Amandustoren — Beiaardkamer No. 2 · machine behaviour
   Vanbeke & Zonen transmission works, Aldenhoorn, 1954.

   The driving weight turns the pinned playing drum; the governor
   holds the tempo while the weight lasts; the tower sways in the
   wind and an interlock drops the heavy bass wires when she rolls.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- constants ---------------- */

  var DROP = 7.6; // metres of fall for the 1.9 t weight
  var LOW_AT = 1.5; // WEIGHT LOW flag (metres remaining)
  var RESTART_AT = 2.0; // weight needed before STALL flag may clear
  var SWAY_LIMIT = 45; // mm at belfry level
  var COST_HEAVY = 0.038; // metres of drop per bass stroke
  var COST_LIGHT = 0.022;
  var HEAVY_BELOW = 5; // semitone indices below this are heavy bells
  var WIND_RATE = 0.85; // m/s of rewind
  var MEND_TIME = 3.0; // seconds of holding MEND PIN

  var NOTE_NAMES = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
    "C",
  ];
  var NATURALS = [0, 2, 4, 5, 7, 9, 11, 12];
  var CHROMATICS = [1, 3, 6, 8, 10];

  function freqOf(semi) {
    return 261.6255653 * Math.pow(2, semi / 12);
  }

  /* Six marches pinned on the drum. [semitone above C4, beats] */
  var TUNES = [
    {
      no: "No. I",
      title: "Aldenhoornsche Mars",
      seq: [
        [9, 1],
        [9, 1],
        [9, 2],
        [4, 1],
        [7, 1],
        [9, 2],
        [7, 1],
        [9, 1],
        [12, 4],
        [4, 1],
        [4, 1],
        [12, 2],
        [9, 1],
        [7, 1],
        [9, 4],
      ],
    },
    {
      no: "No. II",
      title: "Lied van de Toren",
      seq: [
        [0, 2],
        [4, 1],
        [7, 1],
        [9, 2],
        [7, 2],
        [9, 1],
        [7, 1],
        [5, 1],
        [4, 1],
        [2, 2],
        [0, 2],
        [4, 2],
        [0, 4],
      ],
    },
    {
      no: "No. III",
      title: "Avondlied",
      seq: [
        [12, 2],
        [10, 1],
        [9, 1],
        [7, 2],
        [5, 2],
        [4, 1],
        [5, 1],
        [7, 4],
        [5, 2],
        [4, 1],
        [2, 1],
        [0, 4],
      ],
    },
    {
      no: "No. IV",
      title: "Gildekwartier",
      seq: [
        [7, 1],
        [0, 1],
        [7, 1],
        [9, 1],
        [11, 1],
        [12, 1],
        [11, 1],
        [9, 1],
        [7, 2],
        [4, 2],
        [5, 1],
        [7, 1],
        [5, 1],
        [4, 1],
        [2, 2],
        [0, 4],
      ],
    },
    {
      no: "No. V",
      title: "Kermiswijzer",
      seq: [
        [4, 1],
        [4, 1],
        [7, 1],
        [7, 1],
        [9, 1],
        [7, 1],
        [5, 1],
        [4, 1],
        [2, 1],
        [2, 1],
        [5, 1],
        [5, 1],
        [4, 1],
        [4, 1],
        [0, 2],
        [7, 2],
        [4, 4],
      ],
    },
    {
      no: "No. VI",
      title: "Stille Cantus",
      seq: [
        [0, 2],
        [2, 1],
        [4, 1],
        [5, 2],
        [4, 2],
        [2, 1],
        [0, 1],
        [2, 4],
        [7, 2],
        [5, 1],
        [4, 1],
        [2, 2],
        [0, 4],
      ],
    },
  ];

  var FAULTS = ["tether wire fracture", "drum pin shear", "gale squall"];

  /* ---------------- state ---------------- */

  var S = {};
  var latched = {}; // annunciator flags, cleared by FLAG RESET
  var pending = {}; // delayed flag drops (sim-seconds)

  function coldState() {
    S = {
      t: 0,
      weight: DROP,
      brake: true, // true = drum held
      clutch: false, // true = drum rolling
      route: "off", // off | main | spare
      tempoSet: 24,
      tempoActual: 0,
      drumUnwrapped: 0,
      shutters: 0,
      programme: 0,
      brokenWire: -1,
      pinSheared: false,
      shearedPin: -1,
      pinRepaired: false,
      mendProg: 0,
      galeT0: -1e9,
      snatch: 0,
      strokes: 0,
      skipped: 0,
      missed: 0,
      stalled: false,
      sway: 0,
      wind: 0,
    };
    latched = {
      weightLow: false,
      swayHigh: false,
      wireFractured: false,
      pinSheared: false,
      stalled: false,
    };
    pending = { wire: 0, pin: 0 };
    rebuildPins();
  }

  /* pins: absolute angles per drum revolution for current programme */
  var pins = { ang: [], note: [], n: 0 };
  var pinPtr = 0,
    pinRev = 0;

  function rebuildPins() {
    var tune = TUNES[S.programme];
    var total = 0,
      i;
    for (i = 0; i < tune.seq.length; i++) total += tune.seq[i][1];
    pins.ang = [];
    pins.note = [];
    var acc = 0;
    for (i = 0; i < tune.seq.length; i++) {
      pins.note.push(tune.seq[i][0]);
      pins.ang.push(((acc + tune.seq[i][1] / 2) / total) * 2 * Math.PI);
      acc += tune.seq[i][1];
    }
    pins.n = tune.seq.length;
    pinPtr = 0;
    pinRev = Math.floor(S.drumUnwrapped / (2 * Math.PI));
    while (
      pinPtr < pins.n &&
      pinRev * 2 * Math.PI + pins.ang[pinPtr] <= S.drumUnwrapped
    )
      pinPtr++;
    if (pinPtr >= pins.n) {
      pinPtr = 0;
      pinRev++;
    }
    S.shearedPin = S.pinSheared ? Math.min(3, pins.n - 1) : -1;
  }

  /* ---------------- weather & tower motion ---------------- */

  function galeAt(t) {
    if (S.galeT0 < -1e8) return 0;
    var e = t - S.galeT0;
    if (e <= 0) return 0;
    var rise = Math.min(1, e / 12);
    var hold = Math.min(1, Math.max(0, (150 - e) / 60)); // full to e=90, gone by 150
    return 13 * rise * hold;
  }

  function windAt(t) {
    var w =
      4.5 +
      2.5 * Math.sin(t / 47) +
      1.8 * Math.sin(t / 13 + 1.3) +
      1.2 * Math.sin(t / 29 + 0.5) +
      galeAt(t);
    return Math.max(0, Math.min(40, w));
  }

  /* ---------------- alarms ---------------- */

  function latch(name) {
    latched[name] = true;
  }

  function alarmList() {
    var a = [];
    if (latched.weightLow) a.push("WEIGHT LOW");
    if (latched.swayHigh) a.push("SWAY HIGH");
    if (latched.wireFractured) a.push("WIRE FRACTURED");
    if (latched.pinSheared) a.push("PIN SHEARED");
    if (latched.stalled) a.push("DRIVE STALLED");
    return a;
  }

  /* ---------------- strikes ---------------- */

  function costOf(semi) {
    return semi < HEAVY_BELOW ? COST_HEAVY : COST_LIGHT;
  }

  function strikeNote(semi, source) {
    var blocked = S.sway > SWAY_LIMIT && semi < HEAVY_BELOW;
    if (blocked) {
      S.skipped++;
      if (source === "drum") return false;
      playClick();
      S.snatch += 1;
      if (S.snatch >= 3 && S.brokenWire < 0) {
        S.brokenWire = 4;
        pending.wire = 1.5;
      }
      return false;
    }
    if (source === "drum") {
      S.weight -= costOf(semi);
      S.strokes++;
      if (S.weight < LOW_AT && !latched.weightLow && !latched.stalled)
        latch("weightLow");
      if (S.weight <= 0) {
        S.weight = 0;
        doStall();
      }
    }
    playBell(semi);
    bellAnim(semi);
    return true;
  }

  function doStall() {
    if (S.stalled) return;
    S.stalled = true;
    S.tempoActual = 0;
    latch("stalled");
    latch("weightLow");
  }

  function manualStrike(semi) {
    if (S.route === "off") {
      playClick();
      return;
    }
    if (S.route === "main" && S.brokenWire === semi) {
      playClick();
      batonSlackAnim(semi);
      return;
    }
    strikeNote(semi, "hand");
  }

  /* ---------------- the fixed API ---------------- */

  var H = 0.05;

  function tick(seconds) {
    if (typeof seconds !== "number" || !(seconds > 0)) return;
    var budget = Math.min(seconds, 300);
    while (budget > 0) {
      var h = Math.min(H, budget);
      step(h);
      budget -= h;
    }
  }

  function step(h) {
    S.t += h;

    /* weather and sway */
    S.wind = windAt(S.t);
    var swayTarget = Math.max(0, Math.min(120, (S.wind - 2.5) * 6));
    S.sway += (swayTarget - S.sway) * (h / 4);
    if (!latched.swayHigh && S.sway > SWAY_LIMIT) latch("swayHigh");
    S.snatch = Math.max(0, S.snatch - h * 0.02);

    /* delayed flag drops */
    if (pending.wire > 0) {
      pending.wire -= h;
      if (pending.wire <= 0) latch("wireFractured");
    }
    if (pending.pin > 0) {
      pending.pin -= h;
      if (pending.pin <= 0) latch("pinSheared");
    }

    /* governor and drum */
    var wf = S.weight / DROP;
    var target = 0;
    if (S.clutch && !S.stalled) {
      target =
        S.tempoSet *
        (0.55 + 0.45 * Math.pow(wf, 0.7)) *
        (1 + 0.04 * Math.sin(S.t * 1.9) + 0.025 * Math.sin(S.t * 0.7 + 2));
    }
    var tau = target >= S.tempoActual ? 0.9 : 0.6;
    S.tempoActual += (target - S.tempoActual) * (h / tau);

    if (S.clutch && !S.stalled && S.tempoActual > 0.01) {
      var notesPerSec = S.tempoActual / 60;
      var revPerSec = notesPerSec / pins.n;
      var prev = S.drumUnwrapped;
      S.drumUnwrapped += revPerSec * 2 * Math.PI * h;
      var guard = 0;
      while (guard++ < 64) {
        var absAng = pinRev * 2 * Math.PI + pins.ang[pinPtr];
        if (absAng > S.drumUnwrapped) break;
        firePin(pinPtr);
        pinPtr++;
        if (pinPtr >= pins.n) {
          pinPtr = 0;
          pinRev++;
        }
      }
    }

    /* rewinding and mending */
    if (cranking) {
      crankAngle += h * (S.brake && !S.clutch ? 520 : 70);
      if (S.brake && !S.clutch) {
        S.weight = Math.min(DROP, S.weight + h * WIND_RATE);
        if (S.weight < LOW_AT) latch("weightLow");
      }
    }
    if (mending) {
      if (!S.clutch && S.pinSheared) {
        S.mendProg = Math.min(1, S.mendProg + h / MEND_TIME);
        if (S.mendProg >= 1) {
          S.pinRepaired = true;
        }
      } else {
        S.mendProg = 0;
      }
    }
  }

  function firePin(k) {
    var semi = pins.note[k];
    if (S.pinSheared && k === S.shearedPin && !S.pinRepaired) {
      S.missed++; /* the hammer hangs on a sheared pin */
      return;
    }
    strikeNote(semi, "drum");
  }

  function inject(fault) {
    if (fault === "tether wire fracture") {
      if (S.brokenWire < 0) {
        S.brokenWire = 4;
        pending.wire = 1.5;
      } else {
        latch("wireFractured");
      }
    } else if (fault === "drum pin shear") {
      S.pinSheared = true;
      S.pinRepaired = false;
      S.mendProg = 0;
      S.shearedPin = Math.min(3, pins.n - 1);
      pending.pin = 2.5;
    } else if (fault === "gale squall") {
      S.galeT0 = S.t;
    }
  }

  function reset() {
    var keepSound = soundCut;
    coldState();
    cranking = false;
    mending = false;
    soundCut = keepSound;
    syncCutToggle();
    renderStatic();
  }

  function state() {
    return {
      time: round3(S.t),
      running: !!(S.clutch && !S.stalled && S.tempoActual > 0.5),
      weightM: round3(S.weight),
      weightFrac: round3(S.weight / DROP),
      brakeOn: S.brake,
      clutchIn: S.clutch,
      transmission: S.route,
      tempoCommanded: S.tempoSet,
      tempoActual: round3(S.tempoActual),
      drumAngleRad: round3(S.drumUnwrapped % (2 * Math.PI)),
      programme: S.programme,
      programmeTitle: TUNES[S.programme].title,
      shuttersPct: Math.round(S.shutters),
      windMps: round3(S.wind),
      swayMm: round3(S.sway),
      swayLimitMm: SWAY_LIMIT,
      strokesPlayed: S.strokes,
      strokesBlocked: S.skipped,
      notesMissed: S.missed,
      snatchStress: round3(S.snatch),
      brokenWireIndex: S.brokenWire,
      pinSheared: S.pinSheared && !S.pinRepaired,
      stalled: S.stalled,
      alarms: alarmList(),
    };
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  window.machine = {
    name: "St. Amandus Carillon Playing Cabin No. 2",
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ============================================================
     Sound — synthesised bells, only after a visitor's gesture
     ============================================================ */

  var actx = null,
    master = null,
    noiseBuf = null;
  var soundCut = false;

  function ensureAudio() {
    if (actx) {
      if (actx.state === "suspended") actx.resume();
      return;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.5;
      master.connect(actx.destination);
      var len = Math.floor(actx.sampleRate * 0.08);
      noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    } catch (e) {
      actx = null;
    }
  }

  var PARTIAL_R = [0.5, 1, 1.183, 1.506, 2.0, 2.662];
  var PARTIAL_G = [0.55, 1, 0.62, 0.55, 0.42, 0.22];
  var PARTIAL_D = [4.2, 3.2, 2.4, 1.9, 1.3, 0.8];
  var voices = [];

  function playBell(semi) {
    if (!actx || soundCut) return;
    var f = freqOf(semi);
    var loud = 0.16 * (0.3 + (0.7 * S.shutters) / 100);
    var when = actx.currentTime;
    var bus = actx.createGain();
    bus.gain.value = loud;
    bus.connect(master);
    for (var j = 0; j < PARTIAL_R.length; j++) {
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = "sine";
      o.frequency.value = f * PARTIAL_R[j];
      g.gain.setValueAtTime(PARTIAL_G[j], when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + PARTIAL_D[j]);
      o.connect(g);
      g.connect(bus);
      o.start(when);
      o.stop(when + PARTIAL_D[j] + 0.05);
      voices.push(o);
    }
    if (voices.length > 48) {
      var old = voices.splice(0, voices.length - 48);
      old.forEach(function (v) {
        try {
          v.stop();
        } catch (e) {}
      });
    }
    setTimeout(function () {
      bus.disconnect();
    }, 4500);
  }

  function playClick() {
    if (!actx || soundCut || !noiseBuf) return;
    var src = actx.createBufferSource();
    var g = actx.createGain();
    src.buffer = noiseBuf;
    g.gain.value = 0.06;
    src.connect(g);
    g.connect(master);
    src.start();
  }

  /* ============================================================
     Panel wiring
     ============================================================ */

  var $ = function (id) {
    return document.getElementById(id);
  };

  var batonEls = [];
  var bellGroups = [];
  var hammerTimers = {};

  function buildClavier() {
    var rowN = $("row-natur"),
      rowC = $("row-chrom"),
      board = $("wire-board");
    NATURALS.forEach(function (semi) {
      rowN.appendChild(makeBaton(semi));
    });
    CHROMATICS.forEach(function (semi) {
      rowC.appendChild(makeBaton(semi));
    });
    for (var i = 0; i < 13; i++)
      board.appendChild(document.createElement("span"));
  }

  function makeBaton(semi) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "baton";
    b.dataset.semi = String(semi);
    b.setAttribute(
      "aria-label",
      "Strike bell " +
        (semi + 1) +
        ", note " +
        NOTE_NAMES[semi] +
        (semi === 12 ? "5" : "4"),
    );
    var nm = document.createElement("span");
    nm.className = "note-name";
    nm.textContent = NOTE_NAMES[semi];
    var tag = document.createElement("span");
    tag.className = "wire-tag";
    tag.textContent = String(semi + 1);
    b.appendChild(nm);
    b.appendChild(tag);
    b.addEventListener("click", function () {
      ensureAudio();
      manualStrike(semi);
      pulseBaton(b);
    });
    batonEls[semi] = b;
    return b;
  }

  function pulseBaton(b) {
    b.classList.add("strike");
    setTimeout(function () {
      b.classList.remove("strike");
    }, 110);
  }

  function batonSlackAnim(semi) {
    var b = batonEls[semi];
    if (b) {
      b.classList.add("strike");
      setTimeout(function () {
        b.classList.remove("strike");
      }, 200);
    }
  }

  function buildTower() {
    var g = $("bells"),
      ns = "http://www.w3.org/2000/svg";
    var radii = [23, 18.5, 15, 12, 9.5, 8];
    var y = 178;
    for (var j = 0; j < 6; j++) {
      var r = radii[j];
      var x = j % 2 === 0 ? 88 : 132;
      var grp = document.createElementNS(ns, "g");

      var yoke = document.createElementNS(ns, "line");
      yoke.setAttribute("x1", x - r);
      yoke.setAttribute("y1", y - r - 8);
      yoke.setAttribute("x2", x + r);
      yoke.setAttribute("y2", y - r - 8);
      yoke.setAttribute("class", "bell-shape");

      var path = document.createElementNS(ns, "path");
      var top = y - r;
      path.setAttribute(
        "d",
        "M " +
          (x - r * 0.28) +
          " " +
          top +
          " C " +
          (x - r * 0.95) +
          " " +
          (top + r * 0.35) +
          ", " +
          (x - r) +
          " " +
          (top + r * 0.75) +
          ", " +
          (x - r) +
          " " +
          (top + r * 1.15) +
          " L " +
          (x + r) +
          " " +
          (top + r * 1.15) +
          " C " +
          (x + r) +
          " " +
          (top + r * 0.75) +
          ", " +
          (x + r * 0.95) +
          " " +
          (top + r * 0.35) +
          ", " +
          (x + r * 0.28) +
          " " +
          top +
          " Z",
      );
      path.setAttribute("class", "bell-shape");

      var side = j % 2 === 0 ? -1 : 1;
      var px = x + side * (r + 14),
        py = y + r * 0.4;
      var hg = document.createElementNS(ns, "g");
      hg.setAttribute("class", "hammer-g");
      hg.style.transformOrigin = px + "px " + py + "px";
      var arm = document.createElementNS(ns, "line");
      arm.setAttribute("x1", px);
      arm.setAttribute("y1", py);
      arm.setAttribute("x2", x + side * (r - 2));
      arm.setAttribute("y2", py - 2);
      arm.setAttribute("class", "hammer-arm");
      var head = document.createElementNS(ns, "circle");
      head.setAttribute("cx", x + side * (r - 2));
      head.setAttribute("cy", py - 2);
      head.setAttribute("r", 4.5);
      head.setAttribute("class", "hammer-head");
      hg.appendChild(arm);
      hg.appendChild(head);

      grp.appendChild(yoke);
      grp.appendChild(path);
      grp.appendChild(hg);
      g.appendChild(grp);
      bellGroups[j] = { g: grp, hammer: hg, side: side };
      y += r * 2 * 1.02 + 14;
    }

    /* louvre slats */
    var ll = $("louvre-l"),
      lr = $("louvre-r");
    for (var i = 0; i < 5; i++) {
      addSlat(ll, 68, 131.5 + i * 4.2, 34, false);
      addSlat(lr, 118, 131.5 + i * 4.2, 34, true);
    }
  }

  function addSlat(parent, x, y, len, mirror) {
    var ns = "http://www.w3.org/2000/svg";
    var ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", x);
    ln.setAttribute("y1", y);
    ln.setAttribute("x2", x + len);
    ln.setAttribute("y2", y);
    parent.appendChild(ln);
    slatEls.push({ el: ln, x: mirror ? x + len : x, y: y, mirror: mirror });
  }
  var slatEls = [];

  function buildDrumPins() {
    var gp = $("drum-pins"),
      gn = $("drum-next"),
      ns = "http://www.w3.org/2000/svg";
    for (var i = 0; i < 24; i++) {
      var c = document.createElementNS(ns, "circle");
      var a = (i / 24) * 2 * Math.PI;
      c.setAttribute("cx", (100 + 79 * Math.cos(a)).toFixed(1));
      c.setAttribute("cy", (100 + 79 * Math.sin(a)).toFixed(1));
      c.setAttribute("r", i % 2 ? 3 : 4.4);
      gp.appendChild(c);
    }
    var mk = document.createElementNS(ns, "circle");
    mk.setAttribute("r", 5);
    gn.appendChild(mk);
    nextPinMarker = mk;
  }
  var nextPinMarker = null;

  /* ---------- controls ---------- */

  var cranking = false,
    mending = false,
    crankAngle = 0;

  function bindControls() {
    /* rewind crank */
    var rb = $("rewind-btn");
    rb.addEventListener("pointerdown", function () {
      cranking = true;
      rb.classList.add("engaged");
    });
    window.addEventListener("pointerup", stopCrank);
    rb.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !cranking) {
        cranking = true;
        rb.classList.add("engaged");
        e.preventDefault();
      }
    });
    rb.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") stopCrank();
    });

    /* brake guard + lever */
    var guard = $("brake-guard"),
      lever = $("brake-lever");
    guard.addEventListener("click", function () {
      var st = document.querySelector(".brake-station");
      var open = st.classList.toggle("guard-open");
      guard.setAttribute("aria-expanded", open ? "true" : "false");
      lever.disabled = !open;
    });
    lever.addEventListener("click", function () {
      S.brake = !S.brake;
      lever.setAttribute("aria-checked", S.brake ? "true" : "false");
    });

    /* clutch */
    var clutch = $("clutch-lever");
    clutch.addEventListener("click", function () {
      S.clutch = !S.clutch;
      clutch.setAttribute("aria-checked", S.clutch ? "true" : "false");
    });

    /* governor tempo */
    var tr = $("tempo-range");
    tr.addEventListener("input", function () {
      S.tempoSet = parseInt(tr.value, 10);
      $("tempo-readout").textContent = String(S.tempoSet);
    });

    /* swell shutters */
    var sr = $("shutter-range");
    sr.addEventListener("input", function () {
      S.shutters = parseInt(sr.value, 10);
      $("shutter-readout").textContent = String(S.shutters);
    });

    /* transmission selector */
    bindRadio("TRANSMISSION", "[data-route]", function (v) {
      S.route = v;
      $("sel-pointer").style.left =
        (v === "off" ? 17 : v === "main" ? 50 : 83) + "%";
    });

    /* programme selector */
    bindRadio("PROGRAMME", "[data-prog]", function (v) {
      S.programme = parseInt(v, 10);
      rebuildPins();
      updateTuneCard();
    });

    /* mend pin */
    var mb = $("mend-btn");
    mb.addEventListener("pointerdown", function () {
      mending = true;
      mb.classList.add("engaged");
    });
    window.addEventListener("pointerup", stopMend);
    mb.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !mending) {
        mending = true;
        mb.classList.add("engaged");
        e.preventDefault();
      }
    });
    mb.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") stopMend();
    });

    /* flag reset */
    $("flag-reset-btn").addEventListener("click", flagReset);

    /* fault test switches */
    $("test-wire").addEventListener("click", function () {
      fireTest(this, "tether wire fracture");
    });
    $("test-pin").addEventListener("click", function () {
      fireTest(this, "drum pin shear");
    });
    $("test-gale").addEventListener("click", function () {
      fireTest(this, "gale squall");
    });

    /* sound cut */
    $("sound-cut").addEventListener("click", function () {
      soundCut = !soundCut;
      syncCutToggle();
    });

    /* any first gesture unlocks audio */
    document.addEventListener("pointerdown", ensureAudio, { once: false });
    document.addEventListener("keydown", ensureAudio, { once: false });

    /* pause when the tab is hidden */
    document.addEventListener("visibilitychange", function () {
      lastTs = 0;
    });
  }

  function stopCrank() {
    cranking = false;
    $("rewind-btn").classList.remove("engaged");
  }
  function stopMend() {
    mending = false;
    $("mend-btn").classList.remove("engaged");
  }

  function fireTest(btn, fault) {
    ensureAudio();
    btn.classList.add("fired");
    inject(fault);
    setTimeout(function () {
      btn.classList.remove("fired");
    }, 380);
  }

  function flagReset() {
    if (latched.weightLow && S.weight >= LOW_AT) latched.weightLow = false;
    if (latched.swayHigh && S.sway <= SWAY_LIMIT - 3) latched.swayHigh = false;
    if (latched.wireFractured && (S.route === "spare" || S.brokenWire < 0)) {
      latched.wireFractured = false;
      if (S.route === "spare")
        S.brokenWire = -1; /* the rigger has spliced her */
    }
    if (latched.pinSheared && (!S.pinSheared || S.pinRepaired))
      latched.pinSheared = false;
    if (latched.stalled && S.weight >= RESTART_AT) {
      latched.stalled = false;
      S.stalled = false;
    }
  }

  function bindRadio(_kind, sel, apply) {
    var btns = Array.prototype.slice.call(document.querySelectorAll(sel));
    btns.forEach(function (b) {
      b.addEventListener("click", function () {
        btns.forEach(function (o) {
          o.setAttribute("aria-checked", "false");
        });
        b.setAttribute("aria-checked", "true");
        apply(b.getAttribute(sel.match(/\[(data-\w+)\]/)[1]));
      });
    });
  }

  function syncCutToggle() {
    $("sound-cut").setAttribute("aria-checked", soundCut ? "true" : "false");
  }

  function updateTuneCard() {
    var t = TUNES[S.programme];
    $("tune-no").textContent = t.no;
    $("tune-title").textContent = t.title;
  }

  /* ============================================================
     Render — every frame, from simulation state
     ============================================================ */

  var lastTs = 0,
    anemoDeg = 0;

  function frame(ts) {
    if (!lastTs) lastTs = ts;
    var dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (dt > 0) tick(dt);
    render();
    window.addEventListener("load", renderStatic);
    requestAnimationFrame(frame);
  }

  function render() {
    /* weight */
    var frac = S.weight / DROP;
    $("weight-block").style.setProperty("--weight-frac", frac.toFixed(4));
    document
      .querySelector(".gauge-track")
      .style.setProperty("--weight-frac", frac.toFixed(4));

    /* drum rotation and next-pin marker */
    var angDeg = ((S.drumUnwrapped % (2 * Math.PI)) * 180) / Math.PI;
    var rot = document.getElementById("disc-rot");
    if (rot) rot.style.transform = "rotate(" + angDeg.toFixed(2) + "deg)";
    if (nextPinMarker) {
      var nextAbs = pinRev * 2 * Math.PI + pins.ang[pinPtr];
      var world = nextAbs - S.drumUnwrapped;
      var wx = 100 + 88 * Math.cos(world),
        wy = 100 + 88 * Math.sin(world);
      nextPinMarker.setAttribute("cx", wx.toFixed(1));
      nextPinMarker.setAttribute("cy", wy.toFixed(1));
      nextPinMarker.style.opacity = S.clutch && !S.stalled ? "1" : "0.25";
    }

    /* crank wheel */
    document.querySelector(".crank-wheel").style.transform = crankAngle
      ? "rotate(" + crankAngle.toFixed(1) + "deg)"
      : "";
    $("mend-fill").style.width = (S.mendProg * 100).toFixed(0) + "%";

    /* governor figure */
    var spread = Math.max(0, Math.min(1, S.tempoActual / 72));
    var phi = ((16 + 38 * spread) * Math.PI) / 180;
    var bl = $("gov-ball-l"),
      br = $("gov-ball-r"),
      al = $("gov-arm-l"),
      ar = $("gov-arm-r");
    var lx = 40 - Math.sin(phi) * 27,
      rx = 40 + Math.sin(phi) * 27,
      by = 20 + Math.cos(phi) * 27;
    al.setAttribute("x2", lx.toFixed(1));
    al.setAttribute("y2", by.toFixed(1));
    ar.setAttribute("x2", rx.toFixed(1));
    ar.setAttribute("y2", by.toFixed(1));
    bl.setAttribute("cx", lx.toFixed(1));
    bl.setAttribute("cy", by.toFixed(1));
    br.setAttribute("cx", rx.toFixed(1));
    br.setAttribute("cy", by.toFixed(1));

    /* needles */
    function needleDeg(v) {
      return -56 + ((Math.max(24, Math.min(72, v)) - 24) / 48) * 112;
    }
    document.getElementById("needle-set").style.transform =
      "rotate(" + needleDeg(S.tempoSet) + "deg)";
    document.getElementById("needle-actual").style.transform =
      "rotate(" + needleDeg(S.tempoActual) + "deg)";

    /* tower readouts */
    $("wind-readout").textContent = S.wind.toFixed(1);
    $("sway-readout").textContent = S.sway.toFixed(0);

    /* sway pendulum */
    var swayPx = Math.max(-14, Math.min(14, (S.sway / 45) * 6));
    var sg = document.getElementById("sway-group");
    if (sg) {
      var wob = swayPx * Math.sin(S.t * 2.6);
      sg.setAttribute("transform", "rotate(" + wob.toFixed(2) + " 110 70)");
    }

    /* anemometer */
    anemoDeg += S.wind * 0.9;
    document.getElementById("anemo-cups").style.transform =
      "rotate(" + anemoDeg.toFixed(1) + "deg)";

    /* louvres */
    var open = (S.shutters / 100) * 52;
    slatEls.forEach(function (s) {
      s.el.style.transformOrigin = s.x + "px " + s.y + "px";
      s.el.style.transform =
        "rotate(" + (s.mirror ? open : -open).toFixed(1) + "deg)";
    });

    /* flags and jewel */
    $("flag-weight-low").classList.toggle("up", latched.weightLow);
    $("flag-sway-high").classList.toggle("up", latched.swayHigh);
    $("flag-wire-fractured").classList.toggle("up", latched.wireFractured);
    $("flag-pin-sheared").classList.toggle("up", latched.pinSheared);
    $("flag-drive-stalled").classList.toggle("up", latched.stalled);
    $("jewel").classList.toggle("lit", alarmList().length > 0);

    /* wires */
    var spans = $("wire-board").children;
    for (var i = 0; i < spans.length; i++) {
      var snapped = i === S.brokenWire;
      spans[i].classList.toggle("snapped", snapped);
      spans[i].style.setProperty("--wire-hang", snapped ? "0.35" : "1");
    }
    for (var k = 0; k < 13; k++) {
      if (batonEls[k])
        batonEls[k].classList.toggle(
          "slack",
          k === S.brokenWire && S.route !== "spare",
        );
    }

    /* stall footnote */
    $("stall-note").textContent = S.stalled
      ? "DRIVE STALLED — clutch out, brake on, wind her up, then FLAG RESET."
      : S.weight < LOW_AT
        ? "The weight is nearly spent — the march is already dragging."
        : "The weight drives drum, transmission and clappers alike.";
  }

  function bellAnim(semi) {
    var j = Math.max(0, Math.min(5, Math.round((semi * 5) / 12)));
    {
      var hg = bellGroups[j].hammer;
      var side = bellGroups[j].side;
      hg.style.transition = "transform 0.05s";
      hg.style.transform = "rotate(" + -14 * side + "deg)";
      clearTimeout(hammerTimers[j]);
      hammerTimers[j] = setTimeout(
        (function (h, sd) {
          return function () {
            h.style.transition = "transform 0.3s";
            h.style.transform = "rotate(" + 5 * sd + "deg)";
          };
        })(hg, side),
        60,
      );
    }
  }

  function renderStatic() {
    updateTuneCard();
    $("tempo-range").value = String(S.tempoSet);
    $("tempo-readout").textContent = String(S.tempoSet);
    $("shutter-range").value = "0";
    $("shutter-readout").textContent = "0";
    $("clutch-lever").setAttribute("aria-checked", "false");
    $("brake-lever").setAttribute("aria-checked", "true");
    var selBtns = document.querySelectorAll("[data-route]");
    selBtns.forEach.call(selBtns, function (b) {
      b.setAttribute(
        "aria-checked",
        b.getAttribute("data-route") === "off" ? "true" : "false",
      );
    });
    $("sel-pointer").style.left = "17%";
    var progBtns = document.querySelectorAll("[data-prog]");
    progBtns.forEach.call(progBtns, function (b) {
      b.setAttribute(
        "aria-checked",
        b.getAttribute("data-prog") === "0" ? "true" : "false",
      );
    });
    var progSel = document.querySelector(".prog-selector");
    var first = document.querySelector('[data-prog="0"]');
    if (progSel && first)
      $("prog-pointer").style.left =
        first.offsetLeft + first.offsetWidth / 2 + "px";
  }

  /* ---------- boot ---------- */

  coldState();
  buildClavier();
  buildTower();
  buildDrumPins();
  bindControls();
  renderStatic();

  /* manual dialog */
  var dlg = document.querySelector("dialog[data-manual]");
  document
    .querySelector('[data-action="manual"]')
    .addEventListener("click", function () {
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    });
  document
    .querySelector('[data-action="close-manual"]')
    .addEventListener("click", function () {
      dlg.close ? dlg.close() : dlg.removeAttribute("open");
    });

  window.addEventListener("load", renderStatic);
  requestAnimationFrame(frame);
})();
