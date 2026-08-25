/* ============================================================
   CALDERBRIDGE CORPORATION — MASTER CLOCK No. 1 & IMPULSE BOARD
   A gravity-driven pendulum, a two-volt primary battery, and one
   minute impulse feeding forty slave dials in four borough
   circuits. Vanilla script; everything lives in this IIFE.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- simulation constants ---------------------- */

  const BEAT = 2; // seconds per pendulum beat
  const WEIGHT_FULL_HOURS = 2.8; // a full wind runs the clock this long
  const WIND_RATE = 7; // percent per second on the crank
  const FALL_RATE = 100 / (WEIGHT_FULL_HOURS * 3600);
  const AMP_RUN_TAU = 50; // s — approach to driven amplitude
  const AMP_DECAY_TAU = 90; // s — free decay when unimpulsed
  const AMP_EQ = 2.35; // degrees, healthy drive
  const AMP_STOPPED = 0.12;
  const BEAT_CURRENT = 0.115; // A drawn by the driving magnet each beat
  const CELL_PER_CIRCUIT = 0.022; // A per healthy circuit on the minute impulse
  const CELL_BASE_CURRENT = 0.008; // A pilot lamp and leakage
  const SHORT_CURRENT = 0.42; // A through a shorted line
  const LOW_VOLTS = 1.88; // loaded volts below which BATTERY LOW drops
  const CIRCUITS = ["A", "B", "C", "D"];
  const DIAL_COUNT = { A: 10, B: 10, C: 8, D: 12 };
  const BASE_MINUTE = { A: 12, B: 34, C: 51, D: 7 };
  const FAULT_NAMES = [
    "battery cell exhausted",
    "slave line short circuit",
    "pendulum stoppage",
  ];
  const FLAG_NAMES = [
    "TIME ERROR",
    "BATTERY LOW",
    "LINE FAULT",
    "CLOCK STOPPED",
  ];

  /* ---------------- state ------------------------------------- */

  let S;

  function coldState() {
    const t0 = 7 * 3600 + 42 * 60; // quarter to eight of a working morning
    return {
      tTrue: t0,
      tMaster: t0,
      swingT: 0,
      phase: 0,
      minuteAcc: 0,
      amp: 0,
      everStarted: false,
      running: false,
      weightPct: 68,
      ratingSet: 0,
      cellCap: [90, 90],
      selectedCell: 0, // 0 off · 1 · 2
      circuits: {
        A: { closed: false, fuse: true, short: false, lagMin: 0, steps: 0 },
        B: { closed: false, fuse: true, short: false, lagMin: 0, steps: 0 },
        C: { closed: false, fuse: true, short: false, lagMin: 0, steps: 0 },
        D: { closed: false, fuse: true, short: false, lagMin: 0, steps: 0 },
      },
      flags: {
        "TIME ERROR": false,
        "BATTERY LOW": false,
        "LINE FAULT": false,
        "CLOCK STOPPED": false,
      },
      bellArmed: true,
      tests: { cell: false, line: false, stop: false },
      faultedCell: null,
      winding: false,
      lastImpulseV: 0,
      lastImpulseMA: 0,
    };
  }

  /* ---------------- physics helpers --------------------------- */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function cellOpenVolts(cap) {
    return 1.664 + 0.416 * (cap / 100);
  }
  function cellRint(cap) {
    return 0.25 + 3.5 * Math.pow(1 - cap / 100, 2);
  }
  function cellLoadedVolts(i) {
    if (i === 0) return 0;
    const cap = Math.max(S.cellCap[i - 1], 0);
    return Math.max(cellOpenVolts(cap) - BEAT_CURRENT * cellRint(cap), 0);
  }

  function caseTemperature() {
    return 15.5 + 4.5 * Math.sin((S.tTrue * 2 * Math.PI) / 86400 - 1.35);
  }
  function rateSecPerDay() {
    return S.ratingSet + 0.35 * (caseTemperature() - 18);
  }
  function fallRate() {
    return FALL_RATE;
  }

  function healthyCircuits() {
    return CIRCUITS.filter(
      (c) => S.circuits[c].closed && S.circuits[c].fuse && !S.circuits[c].short,
    );
  }

  function impulseAvailable() {
    if (S.selectedCell === 0) return false;
    if (S.weightPct <= 5) return false;
    return (
      cellOpenVolts(Math.max(S.cellCap[S.selectedCell - 1], 0)) > 1.5 &&
      S.cellCap[S.selectedCell - 1] > 3
    );
  }

  function impulseQuality() {
    const v = cellLoadedVolts(S.selectedCell);
    const qv = clamp((v - 1.5) / 0.5, 0, 1);
    const qw = S.weightPct <= 15 ? clamp(S.weightPct / 15, 0, 1) : 1;
    return Math.min(qv, qw);
  }

  /* ---------------- alarms ------------------------------------ */

  function alarmConditions() {
    return {
      "TIME ERROR": Math.abs(S.tMaster - S.tTrue) > 15,
      "BATTERY LOW":
        S.selectedCell !== 0 && cellLoadedVolts(S.selectedCell) < LOW_VOLTS,
      "LINE FAULT": CIRCUITS.some(
        (c) => !S.circuits[c].fuse || S.circuits[c].short,
      ),
      "CLOCK STOPPED": !!S.tests.stop || (S.everStarted && !S.running),
    };
  }

  function refreshFlags(bellAllowed) {
    const cond = alarmConditions();
    let dropped = false;
    for (const name of FLAG_NAMES) {
      if (cond[name] && !S.flags[name]) {
        S.flags[name] = true;
        dropped = true;
      }
    }
    if (dropped && bellAllowed && S.bellArmed) sound.bell();
    return dropped;
  }

  /* ---------------- the minute impulse ------------------------ */

  function fireMinuteImpulse() {
    let amps = CELL_BASE_CURRENT;
    let blew = false;
    const healthy = [];
    for (const c of CIRCUITS) {
      const k = S.circuits[c];
      if (!k.closed || !k.fuse) continue;
      if (k.short) {
        amps += SHORT_CURRENT;
      } else {
        amps += CELL_PER_CIRCUIT;
        healthy.push(c);
      }
    }
    // the fuse goes where the current is greatest
    for (const c of CIRCUITS) {
      const k = S.circuits[c];
      if (k.closed && k.fuse && k.short) {
        k.fuse = false;
        blew = true;
      }
    }
    S.lastImpulseMA = amps * 1000;
    for (const c of healthy) S.circuits[c].steps += 1;
    for (const c of CIRCUITS) {
      if (!healthy.includes(c))
        S.circuits[c].lagMin = Math.min(S.circuits[c].lagMin + 1, 240);
    }
    if (blew) sound.clack();
  }

  /* ---------------- tick -------------------------------------- */

  function step(dt) {
    // ambient and true time run whether the clock does or not
    S.tTrue += dt;

    if (S.winding && S.weightPct < 100) {
      S.weightPct = Math.min(100, S.weightPct + WIND_RATE * dt);
      sound.ratchet();
    }

    // cells: standing drain falls on the selected cell only
    if (S.selectedCell !== 0) {
      const load = 1 + healthyCircuits().length;
      S.cellCap[S.selectedCell - 1] = clamp(
        S.cellCap[S.selectedCell - 1] - dt * (0.0015 + 0.0008 * load),
        0,
        100,
      );
    }
    // an exhausted trial cell collapses quickly wherever it sits
    if (S.tests.cell && S.faultedCell !== null) {
      S.cellCap[S.faultedCell - 1] = clamp(
        S.cellCap[S.faultedCell - 1] - dt * 2.5,
        0,
        100,
      );
    }

    // pendulum drive
    if (S.tests.stop) {
      S.amp *= Math.exp(-dt / 3);
    } else if (impulseAvailable()) {
      const q = impulseQuality();
      const target = q > 0.25 ? AMP_EQ * q : 0;
      if (target > 0)
        S.amp += (target - S.amp) * (1 - Math.exp(-dt / AMP_RUN_TAU));
      else S.amp *= Math.exp(-dt / AMP_DECAY_TAU);
    } else {
      S.amp *= Math.exp(-dt / AMP_DECAY_TAU);
    }

    S.running = S.amp >= AMP_STOPPED && !S.tests.stop;
    if (S.running) S.everStarted = true;

    // the escapement beats
    if (S.running) {
      S.swingT += dt;
      S.phase += dt;
      while (S.phase >= BEAT) {
        S.phase -= BEAT;
        S.lastImpulseV =
          S.selectedCell !== 0 ? cellLoadedVolts(S.selectedCell) : 0;
        sound.tick();
      }
      // the master keeps her own time at her own rate
      S.tMaster += dt * (1 + rateSecPerDay() / 86400);

      // the count wheel closes the line for half a second every minute
      S.minuteAcc += dt;
      if (S.minuteAcc >= 60) {
        S.minuteAcc -= 60;
        fireMinuteImpulse();
      }
    } else {
      S.lastImpulseV = 0;
    }

    refreshFlags(true);
  }

  function tick(seconds) {
    let t = Number(seconds);
    if (!isFinite(t) || t <= 0) return;
    t = Math.min(t, 3600);
    while (t > 0) {
      const dt = Math.min(t, 1);
      step(dt);
      t -= dt;
    }
  }

  /* ---------------- operating actions ------------------------- */

  const actions = {
    wind(on) {
      S.winding = !!on;
    },
    startPendulum() {
      S.amp = Math.max(S.amp, 1.05);
      S.swingT = 0;
      S.phase = 0;
    },
    advanceHands() {
      S.tMaster += 30;
      sound.whirr();
    },
    catchUp() {
      let moved = 0;
      for (const c of CIRCUITS) {
        const k = S.circuits[c];
        if (k.closed && k.fuse && !k.short && k.lagMin > 0) {
          k.lagMin -= 1;
          moved++;
        }
      }
      sound.clack();
      return moved;
    },
    setRating(v) {
      S.ratingSet = clamp(Math.round(v), -6, 6);
    },
    stepRating(d) {
      S.ratingSet = ((S.ratingSet + d + 6) % 13) - 6;
      sound.clack();
    },
    setSelector(v) {
      const want = ((Math.round(v) % 3) + 3) % 3;
      if (want !== S.selectedCell) {
        S.selectedCell = want;
        sound.clack();
      }
    },
    cycleSelector() {
      S.selectedCell = (S.selectedCell + 1) % 3;
      sound.clack();
    },
    toggleCircuit(c) {
      const k = S.circuits[c];
      k.closed = !k.closed;
      sound.clack();
    },
    toggleBell() {
      S.bellArmed = !S.bellArmed;
      sound.clack();
    },
    restoreFuses() {
      for (const c of CIRCUITS) S.circuits[c].fuse = true;
      sound.clack();
    },
    restoreFlags() {
      const cond = alarmConditions();
      for (const name of FLAG_NAMES) if (!cond[name]) S.flags[name] = false;
      sound.whirr();
    },
    replaceCell(i) {
      S.cellCap[i - 1] = 100;
      if (S.faultedCell === i) {
        S.faultedCell = null;
        S.tests.cell = false;
      }
      sound.clack();
    },
  };

  function inject(fault) {
    const name = String(fault || "")
      .trim()
      .toLowerCase();
    if (name === "battery cell exhausted") {
      if (!S.tests.cell) {
        S.tests.cell = true;
        S.faultedCell = S.selectedCell !== 0 ? S.selectedCell : 1;
      }
    } else if (name === "slave line short circuit") {
      S.tests.line = true;
      // the schools' line runs the farthest and fails first
      let target = "D";
      if (!S.circuits.D.fuse) {
        target = CIRCUITS.find((c) => S.circuits[c].fuse) || "D";
      }
      S.circuits[target].short = true;
      refreshFlags(false);
    } else if (name === "pendulum stoppage") {
      S.tests.stop = true;
      refreshFlags(false);
    }
  }

  function clearTest(which) {
    if (which === "cell") {
      S.tests.cell = false;
      S.faultedCell = null;
    } else if (which === "line") {
      S.tests.line = false;
      for (const c of CIRCUITS) S.circuits[c].short = false;
    } else if (which === "stop") {
      S.tests.stop = false;
    }
  }

  function resetMachine() {
    S = coldState();
    ui.dispV = 0;
    ui.dispMA = 0;
    for (const c of CIRCUITS) ui.lastSteps[c] = -1;
  }

  /* ---------------- public API -------------------------------- */

  window.machine = {
    name: "Calderbridge Master Clock No. 1",
    faults: FAULT_NAMES.slice(),
    state() {
      const st = {
        running: S.running,
        pendulumAmplitudeDeg: round3(S.amp),
        drivingWeightPercent: round3(S.weightPct),
        ratingSecondsPerDay: S.ratingSet,
        rateSecondsPerDay: round3(rateSecPerDay()),
        caseTemperatureC: round3(caseTemperature()),
        masterTimeErrorSeconds: round3(S.tMaster - S.tTrue),
        selectedCell: S.selectedCell,
        cells: [
          {
            chargePercent: round3(S.cellCap[0]),
            openVolts: round3(cellOpenVolts(Math.max(S.cellCap[0], 0))),
          },
          {
            chargePercent: round3(S.cellCap[1]),
            openVolts: round3(cellOpenVolts(Math.max(S.cellCap[1], 0))),
          },
        ],
        selectedCellLoadedVolts: round3(cellLoadedVolts(S.selectedCell)),
        lastImpulseMilliamps: round3(S.lastImpulseMA),
        circuits: {},
        alarms: FLAG_NAMES.filter((n) => S.flags[n]),
        tests: {
          cellExhaustion: !!S.tests.cell,
          lineShort: !!S.tests.line,
          pendulumStop: !!S.tests.stop,
        },
        bellArmed: S.bellArmed,
      };
      for (const c of CIRCUITS) {
        const k = S.circuits[c];
        st.circuits[c] = {
          connected: k.closed,
          fused: k.fuse,
          shorted: !!k.short,
          lagMinutes: k.lagMin,
          slaveDialsStepped: k.steps,
        };
      }
      return st;
    },
    tick,
    inject,
    reset: resetMachine,
  };

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  /* ============================================================
   SOUND — synthesised, and silent until the visitor touches
   something. Web Audio only.
   ============================================================ */

  const sound = (() => {
    let ctx = null,
      master = null,
      noiseBuf = null;
    let lastTickAt = 0,
      lastRatchetAt = 0;

    function unlock() {
      if (ctx) {
        if (ctx.state === "suspended") ctx.resume();
        return;
      }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        const len = Math.floor(ctx.sampleRate * 0.06);
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) {
        ctx = null;
      }
    }

    function env(gainNode, t0, peak, dur) {
      const g = gainNode.gain;
      g.setValueAtTime(0.0001, t0);
      g.exponentialRampToValueAtTime(peak, t0 + 0.004);
      g.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }

    function burst(freq, type, peak, dur, when) {
      if (!ctx) return;
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      o.connect(g);
      g.connect(master);
      env(g, when, peak, dur);
      o.start(when);
      o.stop(when + dur + 0.02);
    }

    function noise(peak, dur, freq, when) {
      if (!ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = freq;
      f.Q.value = 1.4;
      const g = ctx.createGain();
      src.connect(f);
      f.connect(g);
      g.connect(master);
      env(g, when, peak, dur);
      src.start(when);
      src.stop(when + dur + 0.02);
    }

    return {
      unlock,
      tick() {
        if (!ctx || ctx.state !== "running") return;
        const now = ctx.currentTime;
        if (now - lastTickAt < 0.15) return;
        lastTickAt = now;
        noise(0.05, 0.03, 3200, now);
      },
      ratchet() {
        if (!ctx || ctx.state !== "running") return;
        const now = ctx.currentTime;
        if (now - lastRatchetAt < 0.09) return;
        lastRatchetAt = now;
        noise(0.06, 0.025, 2100, now);
        burst(1650, "square", 0.015, 0.03, now);
      },
      clack() {
        if (!ctx || ctx.state !== "running") return;
        const now = ctx.currentTime;
        noise(0.07, 0.04, 900, now);
        burst(150, "triangle", 0.05, 0.05, now);
      },
      whirr() {
        if (!ctx || ctx.state !== "running") return;
        const now = ctx.currentTime;
        noise(0.04, 0.16, 1300, now);
      },
      bell() {
        if (!ctx || ctx.state !== "running") return;
        const now = ctx.currentTime;
        for (let i = 0; i < 2; i++) {
          const t0 = now + i * 0.34;
          burst(156, "square", 0.035, 0.3, t0);
          burst(470, "triangle", 0.02, 0.26, t0);
          noise(0.02, 0.05, 2500, t0);
        }
      },
    };
  })();

  /* ============================================================
   PANEL WIRING
   ============================================================ */

  const $ = (id) => document.getElementById(id);

  const el = {
    pendulum: $("pendulum"),
    anchor: $("anchorWheel"),
    cable: $("cable"),
    weightSlot: $("cable").parentElement,
    weight: $("weight"),
    drumWheel: $("drumWheel"),
    crank: $("crank"),
    crankArm: $("crankArm"),
    leverStart: $("leverStart"),
    knobRating: $("knobRating"),
    ratePtr: $("ratePtr"),
    rateVal: $("rateVal"),
    knobHands: $("knobHands"),
    dialSvg: $("dialSvg"),
    meterV: $("meterV"),
    meterMA: $("meterMA"),
    flags: Array.from(document.querySelectorAll(".flag")),
    knives: { A: $("kA"), B: $("kB"), C: $("kC"), D: $("kD") },
    selUnit: $("selUnit"),
    selPtr: $("selPtr"),
    bellKnife: $("bellKnife"),
    fuses: Array.from(document.querySelectorAll(".fuse")),
    btnFuse: $("btnFuse"),
    leverFlags: $("leverFlags"),
    jarFluid: [$("jarFluid1"), $("jarFluid2")],
    btnCell1: $("btnCell1"),
    btnCell2: $("btnCell2"),
    trayHead: $("trayHead"),
    trayBody: $("trayBody"),
    tCell: $("tCell"),
    tLine: $("tLine"),
    tStop: $("tStop"),
    wires: { A: $("wire-A"), B: $("wire-B"), C: $("wire-C"), D: $("wire-D") },
    routes: Array.from(document.querySelectorAll(".route")),
    clusters: { A: $("cl-A"), B: $("cl-B"), C: $("cl-C"), D: $("cl-D") },
    lags: Array.from(document.querySelectorAll(".lag")),
    leverCatch: $("leverCatch"),
  };

  const ui = {
    dispV: 0,
    dispMA: 0,
    crankAngle: 0,
    drumAngle: 0,
    miniHands: {},
    lastSteps: { A: -1, B: -1, C: -1, D: -1 },
    needles: {},
    dialHands: {},
  };

  /* ---------------- build the master dial --------------------- */

  function buildDial() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = el.dialSvg;
    const mk = (tag, attrs, txt, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (txt != null) n.textContent = txt;
      (parent || svg).appendChild(n);
      return n;
    };
    mk("circle", {
      cx: 0,
      cy: 0,
      r: 97,
      fill: "none",
      stroke: "#878b92",
      "stroke-width": 1,
    });
    mk("circle", {
      cx: 0,
      cy: 0,
      r: 84,
      fill: "none",
      stroke: "#33373d",
      "stroke-width": 1.4,
    });
    const ROMAN = [
      "XII",
      "I",
      "II",
      "III",
      "IIII",
      "V",
      "VI",
      "VII",
      "VIII",
      "IX",
      "X",
      "XI",
    ];
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const a = (i / 60) * 2 * Math.PI;
      const r1 = major ? 75 : 80,
        r2 = 86;
      mk("line", {
        x1: Math.sin(a) * r1,
        y1: -Math.cos(a) * r1,
        x2: Math.sin(a) * r2,
        y2: -Math.cos(a) * r2,
        stroke: major ? "#2e3238" : "#666a71",
        "stroke-width": major ? 2.8 : 1.1,
      });
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 2 * Math.PI;
      mk(
        "text",
        {
          x: Math.sin(a) * 62,
          y: -Math.cos(a) * 62 + 6.5,
          "text-anchor": "middle",
          "font-family": "Georgia, 'Times New Roman', serif",
          "font-weight": "bold",
          "font-size": "19",
          fill: "#2b2f35",
        },
        ROMAN[i],
      );
    }
    mk(
      "text",
      {
        x: 0,
        y: 34,
        "text-anchor": "middle",
        "font-family": "Georgia, 'Times New Roman', serif",
        "font-size": "8.4",
        fill: "#585d64",
        "letter-spacing": "2",
      },
      "CALDERBRIDGE CORPORATION",
    );

    const gH = mk("g", {}),
      gM = mk("g", {}),
      gS = mk("g", {});
    const hand = (g, w, l, tail) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute(
        "d",
        `M ${-w} ${tail} L ${-w * 0.55} 0 L 0 ${-l} L ${w * 0.55} 0 L ${w} ${tail} Z`,
      );
      p.setAttribute("fill", "#232c47");
      p.setAttribute("stroke", "#4a5a80");
      p.setAttribute("stroke-width", "0.6");
      g.appendChild(p);
    };
    hand(gH, 5, 43, 12);
    hand(gM, 3.4, 73, 16);
    const sec = document.createElementNS(NS, "line");
    sec.setAttribute("y1", 14);
    sec.setAttribute("y2", -79);
    sec.setAttribute("stroke", "#5a3040");
    sec.setAttribute("stroke-width", "1.2");
    gS.appendChild(sec);
    mk("circle", {
      cx: 0,
      cy: 0,
      r: 4.4,
      fill: "#b08d3f",
      stroke: "#6d5620",
      "stroke-width": 1,
    });
    ui.dialHands = { h: gH, m: gM, s: gS };
  }

  /* ---------------- build the meters -------------------------- */

  function describeArc(r, a0, a1) {
    const x0 = Math.sin(a0) * r,
      y0 = -Math.cos(a0) * r;
    const x1 = Math.sin(a1) * r,
      y1 = -Math.cos(a1) * r;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  }

  function buildMeter(host, opts) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-50 -50 100 100");
    host.innerHTML = "";
    host.appendChild(svg);
    const defs = document.createElementNS(NS, "defs");
    defs.innerHTML =
      '<linearGradient id="' +
      opts.id +
      'bez" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#caa54e"/><stop offset=".5" stop-color="#b08d3f"/>' +
      '<stop offset="1" stop-color="#6d5620"/></linearGradient>';
    svg.appendChild(defs);
    const mk = (tag, attrs, txt, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (txt != null) n.textContent = txt;
      (parent || svg).appendChild(n);
      return n;
    };
    mk("rect", {
      x: -48,
      y: -48,
      width: 96,
      height: 96,
      rx: 46,
      fill: "url(#" + opts.id + "bez)",
    });
    mk("circle", { cx: 0, cy: 0, r: 44, fill: "#e3e5e7", stroke: "#9aa0a6" });
    for (const z of opts.redZones || []) {
      const a0 =
        ((-60 + ((z.lo - opts.min) / (opts.max - opts.min)) * 120) * Math.PI) /
        180;
      const a1 =
        ((-60 + ((z.hi - opts.min) / (opts.max - opts.min)) * 120) * Math.PI) /
        180;
      mk("path", {
        d: describeArc(33, a0, a1),
        stroke: "#b32014",
        "stroke-width": 3.4,
        fill: "none",
      });
    }
    const N = opts.ticks;
    for (let i = 0; i <= N; i++) {
      const a = ((-60 + (i / N) * 120) * Math.PI) / 180;
      const major = i % (opts.majorEvery || 1) === 0;
      mk("line", {
        x1: Math.sin(a) * (major ? 30 : 34),
        y1: -Math.cos(a) * (major ? 30 : 34),
        x2: Math.sin(a) * 39,
        y2: -Math.cos(a) * 39,
        stroke: "#2e3236",
        "stroke-width": major ? 1.8 : 0.9,
      });
      if (major && opts.labels[i] !== undefined) {
        mk(
          "text",
          {
            x: Math.sin(a) * 22.5,
            y: -Math.cos(a) * 22.5 + 3,
            "text-anchor": "middle",
            "font-family": "'Arial Narrow', Arial, sans-serif",
            "font-size": "7.6",
            fill: "#2e3236",
          },
          String(opts.labels[i]),
        );
      }
    }
    mk(
      "text",
      {
        x: 0,
        y: 21,
        "text-anchor": "middle",
        "font-family": "'Arial Narrow', Arial, sans-serif",
        "font-size": "6.4",
        fill: "#5c6166",
        "letter-spacing": "1",
      },
      opts.sub,
    );
    const needle = mk("g", {});
    mk(
      "path",
      {
        d: "M -1.4 8 L 0 -36 L 1.4 8 Z",
        fill: "#232c47",
        stroke: "#4a5a80",
        "stroke-width": ".5",
      },
      null,
      needle,
    );
    mk("circle", { cx: 0, cy: 0, r: 4.6, fill: "#b08d3f", stroke: "#6d5620" });
    ui.needles[opts.id] = needle;
  }

  /* ---------------- build the borough ------------------------- */

  function buildBorough() {
    const NS = "http://www.w3.org/2000/svg";
    ui.miniHands = {};
    for (const c of CIRCUITS) {
      const host = el.clusters[c];
      host.innerHTML = "";
      const hands = [];
      for (let i = 0; i < DIAL_COUNT[c]; i++) {
        const mini = document.createElement("span");
        mini.className = "mini";
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "-13.5 -13.5 27 27");
        for (let t = 0; t < 12; t++) {
          const a = (t / 12) * 2 * Math.PI;
          const l = document.createElementNS(NS, "line");
          l.setAttribute("x1", Math.sin(a) * 9.6);
          l.setAttribute("y1", -Math.cos(a) * 9.6);
          l.setAttribute("x2", Math.sin(a) * 11.8);
          l.setAttribute("y2", -Math.cos(a) * 11.8);
          l.setAttribute("stroke", "#8d8672");
          l.setAttribute("stroke-width", "0.9");
          svg.appendChild(l);
        }
        const hand = document.createElementNS(NS, "line");
        hand.setAttribute("x1", 0);
        hand.setAttribute("y1", 2.5);
        hand.setAttribute("x2", 0);
        hand.setAttribute("y2", -8.6);
        hand.setAttribute("stroke", "#37332b");
        hand.setAttribute("stroke-width", "1.5");
        svg.appendChild(hand);
        const hub = document.createElementNS(NS, "circle");
        hub.setAttribute("r", "1.2");
        hub.setAttribute("fill", "#37332b");
        svg.appendChild(hub);
        mini.appendChild(svg);
        host.appendChild(mini);
        hands.push(hand);
      }
      ui.miniHands[c] = hands;
      ui.lastSteps[c] = -1;
    }
  }

  /* ---------------- render ------------------------------------ */

  function render(dt) {
    // pendulum and escapement
    const ang = Math.sin((Math.PI * S.swingT) / BEAT) * S.amp;
    el.pendulum.style.transform = `rotate(${ang.toFixed(3)}deg)`;
    el.anchor.style.transform = `rotate(${Math.floor(S.swingT / BEAT) % 2 ? 5 : -5}deg)`;

    // weight and drum
    const dropPct = (100 - S.weightPct).toFixed(2) + "%";
    el.weightSlot.style.setProperty("--drop", dropPct);
    ui.drumAngle += (S.winding ? 240 : -1.4) * dt;
    el.drumWheel.style.transform = `rotate(${ui.drumAngle.toFixed(1)}deg)`;
    if (S.winding) {
      ui.crankAngle += 300 * dt;
      el.crankArm.style.transform = `rotate(${ui.crankAngle.toFixed(1)}deg)`;
    }

    // master dial hands — the seconds hand steps on the beat
    const tm = S.tMaster;
    const secStep = Math.floor(tm / BEAT) * BEAT;
    ui.dialHands.s.setAttribute(
      "transform",
      `rotate(${(((secStep % 60) / 60) * 360).toFixed(2)})`,
    );
    ui.dialHands.m.setAttribute(
      "transform",
      `rotate(${(((tm / 60) % 60) * 6).toFixed(2)})`,
    );
    ui.dialHands.h.setAttribute(
      "transform",
      `rotate(${(((tm / 3600) % 12) * 30).toFixed(2)})`,
    );

    // meters relax toward zero; impulses kick them
    ui.dispV *= Math.exp(-dt / 1.4);
    ui.dispMA *= Math.exp(-dt / 2.0);
    if (S.lastImpulseV > 0) ui.dispV = Math.max(ui.dispV, S.lastImpulseV);
    if (S.lastImpulseMA > 0) ui.dispMA = Math.max(ui.dispMA, S.lastImpulseMA);
    setNeedle(ui.needles.V, ui.dispV, 0, 3);
    setNeedle(ui.needles.MA, ui.dispMA, 0, 600);

    // flags, knives, fuses, routes
    for (const f of el.flags) {
      f.classList.toggle("dropped", !!S.flags[f.getAttribute("data-flag")]);
    }
    for (const c of CIRCUITS) {
      const k = S.circuits[c];
      el.knives[c].classList.toggle("closed", k.closed);
      el.knives[c].setAttribute("aria-checked", k.closed ? "true" : "false");
      const dead = !k.closed || !k.fuse;
      el.routes
        .find((r) => r.getAttribute("data-route") === c)
        .classList.toggle("dead", dead);
      el.wires[c].classList.toggle("dead", dead);
      el.fuses
        .find((f) => f.getAttribute("data-fuse") === c)
        .classList.toggle("blown", !k.fuse);
      const lag = el.lags.find((l) => l.getAttribute("data-lag") === c);
      if (k.lagMin > 0) {
        lag.hidden = false;
        lag.textContent = "LAG " + k.lagMin + " MIN";
      } else lag.hidden = true;
      if (ui.lastSteps[c] !== k.steps) {
        ui.lastSteps[c] = k.steps;
        const handsArr = ui.miniHands[c];
        for (let i = 0; i < handsArr.length; i++) {
          handsArr[i].setAttribute(
            "transform",
            `rotate(${(((BASE_MINUTE[c] + k.steps) % 60) * 6).toFixed(1)})`,
          );
        }
      }
    }
    el.bellKnife.classList.toggle("closed", S.bellArmed);
    el.bellKnife.setAttribute("aria-checked", S.bellArmed ? "true" : "false");

    // battery jars and selector
    el.jarFluid[0].style.setProperty("--chg", S.cellCap[0].toFixed(1) + "%");
    el.jarFluid[1].style.setProperty("--chg", S.cellCap[1].toFixed(1) + "%");
    el.selPtr.style.transform = `rotate(${[-40, 0, 40][S.selectedCell]}deg)`;
    el.selUnit.setAttribute("aria-valuenow", String(S.selectedCell));
    el.selUnit.setAttribute(
      "aria-valuetext",
      ["OFF", "CELL I", "CELL II"][S.selectedCell],
    );

    // rating
    el.ratePtr.style.transform = `rotate(${(S.ratingSet * 6.5).toFixed(1)}deg)`;
    el.rateVal.textContent =
      (S.ratingSet > 0 ? "+" : "") + S.ratingSet + " s/day";
    el.knobRating.setAttribute("aria-valuenow", String(S.ratingSet));
    el.knobRating.setAttribute(
      "aria-valuetext",
      S.ratingSet + " seconds per day",
    );

    // maintenance tray mirrors the injected faults
    el.tCell.setAttribute("aria-pressed", S.tests.cell ? "true" : "false");
    el.tLine.setAttribute("aria-pressed", S.tests.line ? "true" : "false");
    el.tStop.setAttribute("aria-pressed", S.tests.stop ? "true" : "false");
  }

  function setNeedle(needle, value, min, max) {
    if (!needle) return;
    const a = -60 + clamp((value - min) / (max - min), 0, 1) * 120;
    needle.setAttribute("transform", `rotate(${a.toFixed(2)})`);
  }

  /* ---------------- control interactions ----------------------- */

  function pull(unit, dirClass, fn) {
    unit.classList.remove("pulled", "up", "down", "right");
    void unit.offsetWidth;
    unit.classList.add("pulled", dirClass);
    setTimeout(() => unit.classList.remove("pulled", dirClass), 240);
    if (fn) fn();
  }

  function bindHold(node, onDown, onUp) {
    const down = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      sound.unlock();
      onDown();
    };
    const up = () => {
      if (onUp) onUp();
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    node.addEventListener("pointerleave", up);
    node.addEventListener("keydown", (e) => {
      if (e.repeat) {
        if (e.key === " " || e.key === "Enter") e.preventDefault();
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        sound.unlock();
        onDown();
      }
    });
    node.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") up();
    });
    window.addEventListener("blur", up);
  }

  function bindTap(node, fn) {
    node.addEventListener("click", () => {
      sound.unlock();
      fn();
    });
    node.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        sound.unlock();
        fn();
      }
    });
  }

  function bindSlider(node, get, set) {
    node.addEventListener("keydown", (e) => {
      let handled = true;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") set(get() + 1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(get() - 1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        sound.unlock();
      }
    });
  }

  function wirePanel() {
    // case fittings
    bindHold(
      el.crank,
      () => actions.wind(true),
      () => actions.wind(false),
    );
    bindTap(el.leverStart, () =>
      pull(el.leverStart, "down", actions.startPendulum),
    );
    bindSlider(
      el.knobRating,
      () => S.ratingSet,
      (v) => actions.setRating(v),
    );
    bindTap(el.knobRating, () => actions.stepRating(1));
    bindTap(el.knobHands, () =>
      pull(el.knobHands, "right", actions.advanceHands),
    );

    // board fittings
    for (const c of CIRCUITS)
      bindTap(el.knives[c], () => actions.toggleCircuit(c));
    bindSlider(
      el.selUnit,
      () => S.selectedCell,
      (v) => actions.setSelector(v),
    );
    bindTap(el.selUnit, () => actions.cycleSelector());
    bindTap(el.bellKnife, () => actions.toggleBell());
    bindTap(el.btnFuse, () => actions.restoreFuses());
    bindTap(el.leverFlags, () =>
      pull(el.leverFlags, "right", actions.restoreFlags),
    );
    bindTap(el.btnCell1, () => actions.replaceCell(1));
    bindTap(el.btnCell2, () => actions.replaceCell(2));

    // maintenance tray
    bindTap(el.trayHead, () => {
      const open = el.trayBody.hidden;
      el.trayBody.hidden = !open;
      el.trayHead.setAttribute("aria-expanded", open ? "true" : "false");
    });
    bindTap(el.tCell, () => {
      if (S.tests.cell) clearTest("cell");
      else inject("battery cell exhausted");
    });
    bindTap(el.tLine, () => {
      if (S.tests.line) clearTest("line");
      else inject("slave line short circuit");
    });
    bindTap(el.tStop, () => {
      if (S.tests.stop) clearTest("stop");
      else inject("pendulum stoppage");
    });

    // borough
    bindTap(el.leverCatch, () =>
      pull(el.leverCatch, "down", () => actions.catchUp()),
    );

    // manual dialog
    const dialog = document.querySelector("dialog[data-manual]");
    document.querySelectorAll('[data-action="manual"]').forEach((b) =>
      b.addEventListener("click", () => {
        try {
          dialog.showModal();
        } catch (e) {}
      }),
    );
    document.querySelectorAll('[data-action="close-manual"]').forEach((b) =>
      b.addEventListener("click", () => {
        try {
          dialog.close();
        } catch (e) {}
      }),
    );
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        try {
          dialog.close();
        } catch (err) {}
      }
    });
  }

  /* ---------------- boot and loop ------------------------------ */

  resetMachine();
  buildDial();
  buildMeter(el.meterV, {
    id: "V",
    min: 0,
    max: 3,
    ticks: 6,
    majorEvery: 1,
    labels: { 0: "0", 1: "1", 2: "2", 3: "3" },
    sub: "CELL VOLTS · ON IMPULSE",
    redZones: [{ lo: 0, hi: 1.85 }],
  });
  buildMeter(el.meterMA, {
    id: "MA",
    min: 0,
    max: 600,
    ticks: 12,
    majorEvery: 2,
    labels: { 0: "0", 2: "200", 4: "400", 6: "600" },
    sub: "MINUTE IMPULSE · MILLIAMPERES",
    redZones: [{ lo: 430, hi: 600 }],
  });
  buildBorough();
  wirePanel();

  let lastFrame = performance.now();
  document.addEventListener("visibilitychange", () => {
    lastFrame = performance.now();
  });
  window.addEventListener("pointerdown", () => sound.unlock(), {
    passive: true,
  });
  window.addEventListener("keydown", () => sound.unlock());

  function frame(now) {
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (document.hidden) {
      requestAnimationFrame(frame);
      return;
    }
    dt = clamp(dt, 0, 0.5);
    if (dt > 0) tick(dt);
    render(dt || 0.016);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
