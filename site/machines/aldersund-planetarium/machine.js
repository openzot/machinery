/*
 * Aldersund Planetarium · Projector Console No. 1
 * Nordstjärnan Typ 63-S opto-mechanical star projector, 1964.
 *
 * Simulation model: a twin carbon-arc lamp fed by a rotary blower, two drum
 * gear trains carrying the sky westward, a latitude crank tipping the whole
 * star cage, and a dome shutter between the lamp and the dark. The gears
 * must be re-caged at six hours west; the arc must be trimmed onto thirty
 * amperes; the lamp must never burn without her air.
 */
(() => {
  "use strict";

  /* ============================ constants ============================= */

  const AMBIENT_C = 18;
  const CURRENT_MAX_A = 40;
  const ARC_STRIKE_A = 11.5;
  const ARC_NOMINAL_A = 30;
  const TEMP_TRIP_C = 112;
  const TEMP_ALARM_C = 104;
  const STRAIN_JAM = 100;
  const SHUTTER_SPEED = 0.34; // fraction per second
  const RATE_H_PER_S = [0, 0.1, 0.0958, 1.2]; // STOP / STJÄRNA / SOL / DEMO
  const RATE_NAMES = ["STOP", "STJÄRNA", "SOL", "DEMO"];
  const LAT_MIN = 10;
  const LAT_MAX = 70;

  const ALARM_TEXT = {
    overtemp: "ARC OVERTEMP",
    airloss: "AIR LOSS",
    arcunstable: "ARC UNSTABLE",
    strain: "DRUM STRAIN",
    cageat6: "CAGE AT SIX",
    heatsoak: "HEAT SOAK",
    jam: "GEAR JAM",
  };
  const ALARM_ORDER = [
    "overtemp",
    "airloss",
    "arcunstable",
    "strain",
    "cageat6",
    "heatsoak",
    "jam",
  ];

  /* ============================== state =============================== */

  let simTime = 0;
  let mains = false;
  let blower = false;
  let fanBreakerTripped = false;
  let fanBreakerWasTripped = false;

  let lampKnobA = 0; // where the operator has set the knob
  let lampCurrentA = 0; // what the rheostat is actually carrying
  let lampTempC = AMBIENT_C;
  let lampTripped = false;

  let arcFault = false;
  let arcBadSince = null; // seconds the instability has run unchecked
  let arcTrimGoodSince = null; // seconds the operator has held the band

  let airflowPct = 0;
  let airLossSince = null;

  let ratePos = 0;
  let haHours = 4.2;
  let prevHaHours = 4.2;
  let cageArmed = true; // gears indexed: next south passage is safe
  let cageLever = false; // false = RUN, true = CAGE

  let strainPct = 0;
  let jamRamp = false;
  let jammed = false;

  let shutter = "closed"; // closed | opening | open | closing
  let shutterPos = 0;

  let latitudeDeg = 59;
  let housePct = 30;
  let civilMinutes = 19 * 60;
  let hourMeter = 0;

  const alarms = {
    overtemp: false,
    airloss: false,
    arcunstable: false,
    strain: false,
    cageat6: false,
    heatsoak: false,
    jam: false,
  };
  let unacked = false;

  /* ============================ utilities ============================= */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const fmt = (v, n) => String(Math.floor(Math.abs(v))).padStart(n, "0");

  /* ========================= the star catalogue ======================= */

  const rand = mulberry32(19640321);
  const stars = [];
  const TINTS = ["#ffffff", "#e9eeff", "#fdf4d0", "#ffe2b8"];
  for (let i = 0; i < 240; i++) {
    // uniform on the celestial sphere, northern favourites kept bright
    const ra = rand() * Math.PI * 2;
    const dec = Math.asin(rand() * 0.94 + 0.03);
    const bright = rand();
    stars.push({
      ra,
      dec,
      r: bright > 0.86 ? 1.9 : bright > 0.55 ? 1.25 : 0.85,
      a: bright > 0.86 ? 0.95 : bright > 0.55 ? 0.7 : 0.45,
      tint: TINTS[(rand() * TINTS.length) | 0],
      flare: bright > 0.92,
      tw: rand() * Math.PI * 2,
    });
  }
  const milkyWay = [];
  for (let i = 0; i < 430; i++) {
    // a band of faint haze along a great circle inclined to the equator
    const lon = rand() * Math.PI * 2;
    const off = (rand() + rand() + rand() - 1.5) * 0.21;
    const inc = (63 * Math.PI) / 180;
    const x = Math.cos(lon);
    const y = Math.sin(lon) * Math.cos(inc) - Math.tan(off) * Math.sin(inc);
    const z = Math.sin(lon) * Math.sin(inc) + Math.tan(off) * Math.cos(inc);
    const dec = Math.asin(clamp(z, -1, 1));
    const ra = Math.atan2(y, x);
    milkyWay.push({
      ra: ra < 0 ? ra + Math.PI * 2 : ra,
      dec,
      a: 0.1 + rand() * 0.2,
    });
  }

  /* ============================ simulation ============================ */

  function arcStability() {
    let stab =
      99 - Math.max(0, Math.abs(lampCurrentA - ARC_NOMINAL_A) - 4) * 4.6;
    stab += Math.sin(simTime * 0.9) * 1.5;
    if (arcFault) {
      stab -= 52 + 34 * Math.sin(simTime * 2.1) + 12 * Math.sin(simTime * 7.7);
    }
    return clamp(stab, 0, 100);
  }

  function tick(seconds) {
    const total = clamp(Number(seconds) || 0, 0, 8);
    let left = total;
    while (left > 0) {
      const h = Math.min(left, 0.05);
      step(h);
      left -= h;
    }
  }

  function step(h) {
    simTime += h;
    civilMinutes = (civilMinutes + h * 60) % 1440;

    /* --- air -------------------------------------------------------- */
    const airDemand = mains && blower && !fanBreakerTripped ? 100 : 0;
    if (airflowPct < airDemand)
      airflowPct = Math.min(airDemand, airflowPct + 58 * h);
    else airflowPct = Math.max(airDemand, airflowPct - 34 * h);

    const airWanted = mains && blower;
    if (airWanted && airflowPct < 62) {
      airLossSince = (airLossSince ?? 0) + h;
      if (airLossSince > 2.5) setAlarm("airloss", true);
    } else {
      airLossSince = null;
    }
    setAlarm("airloss", fanBreakerTripped || (airWanted && airflowPct < 62));

    /* --- the arc ---------------------------------------------------- */
    const wanted = mains && !lampTripped ? lampKnobA : 0;
    const slew = 26 * h; // the rheostat motor travels 26 amperes a second
    lampCurrentA += clamp(wanted - lampCurrentA, -slew, slew);

    const arcLit = lampCurrentA >= ARC_STRIKE_A;
    const stab = arcStability();

    if (arcFault) {
      if (Math.abs(lampCurrentA - ARC_NOMINAL_A) <= 1.2 && mains) {
        arcTrimGoodSince = (arcTrimGoodSince ?? 0) + h;
        if (arcTrimGoodSince >= 6) {
          arcFault = false;
          arcTrimGoodSince = null;
          arcBadSince = null;
          setAlarm("arcunstable", false);
        }
      } else {
        arcTrimGoodSince = null;
      }
      if (stab < 32) {
        arcBadSince = (arcBadSince ?? 0) + h;
        if (arcBadSince > 12 && lampCurrentA > 0) {
          lampTripped = true; // the arc breaks and will not restrike
        }
      } else {
        arcBadSince = null;
      }
    }

    /* --- lamp heat --------------------------------------------------- */
    const airK = 0.011 + 0.05 * (airflowPct / 100);
    let heat = lampCurrentA * lampCurrentA * 0.0032;
    const sealed = shutterPos < 0.15 && lampCurrentA > 8;
    if (sealed) heat *= 2.2;
    setAlarm("heatsoak", sealed && lampCurrentA >= ARC_STRIKE_A);
    lampTempC += (heat - (lampTempC - AMBIENT_C) * airK) * h;
    lampTempC = clamp(lampTempC, AMBIENT_C, 165);

    setAlarm("overtemp", lampTempC >= TEMP_ALARM_C);
    if (lampTempC >= TEMP_TRIP_C && !lampTripped) lampTripped = true;
    hourMeter += arcLit ? (lampCurrentA * h) / 3600 : 0;

    /* --- drum trains -------------------------------------------------- */
    let rate = RATE_H_PER_S[ratePos];
    if (jammed) rate = 0;
    const running = rate > 0;
    prevHaHours = haHours;
    haHours = (haHours + rate * h) % 24;

    // the six-hours-west passage
    const crossed = crossedMark(prevHaHours, haHours, 6);
    if (crossed && rate > 0) {
      if (cageLever && cageArmed) {
        cageArmed = false; // she is re-indexed for another day
        strainPct = Math.max(0, strainPct - 12);
      } else {
        strainPct += 55;
      }
    }
    if (Math.abs(southDistance(haHours)) > 1.2) cageArmed = true;

    // cranking the latitude hard while the drums run strains them too
    const latRate = lastLatRate();
    if (running && Math.abs(latRate) > 9)
      strainPct += (Math.abs(latRate) - 9) * 0.9 * h;

    if (jamRamp) strainPct += 2.4 * h;
    if (strainPct > 0 && !jamRamp)
      strainPct = Math.max(0, strainPct - (cageLever ? 10 : 0.8) * h);
    strainPct = clamp(strainPct, 0, 130);

    setAlarm("strain", strainPct >= 45);
    if (strainPct >= STRAIN_JAM && !jammed) {
      jammed = true;
      setAlarm("jam", true);
    }

    const cageLead = RATE_H_PER_S[ratePos] * 2.5 + 0.15;
    setAlarm(
      "cageat6",
      running && !cageLever && southDistance(haHours) < cageLead,
    );

    /* --- shutter ------------------------------------------------------- */
    if (shutter === "opening") {
      shutterPos = Math.min(1, shutterPos + SHUTTER_SPEED * h);
      if (shutterPos >= 1) shutter = "open";
    } else if (shutter === "closing") {
      shutterPos = Math.max(0, shutterPos - SHUTTER_SPEED * h);
      if (shutterPos <= 0) shutter = "closed";
    }
  }

  function crossedMark(from, to, mark) {
    if (to === from) return false;
    const span = (to - from + 24) % 24;
    const reach = (mark - from + 24) % 24;
    return reach > 0 && reach <= span;
  }

  function southDistance(h) {
    return (6 - h + 24) % 24;
  }

  function setAlarm(key, on) {
    if (!!alarms[key] !== !!on) {
      alarms[key] = !!on;
      if (on) unacked = true;
    }
  }

  /* ------------------------- latitude rate memory -------------------- */

  let lastLatitude = 59;
  let lastLatTime = 0;
  function lastLatRate() {
    const dt = simTime - lastLatTime;
    if (dt <= 0.0001) return 0;
    const rate = (latitudeDeg - lastLatitude) / dt;
    lastLatitude = latitudeDeg;
    lastLatTime = simTime;
    return rate;
  }

  /* ============================== faults ============================= */

  function inject(fault) {
    const f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "blower failure") {
      fanBreakerTripped = true;
      fanBreakerWasTripped = true;
      setAlarm("airloss", true);
    } else if (f === "arc instability") {
      arcFault = true;
      arcTrimGoodSince = null;
      setAlarm("arcunstable", true);
    } else if (f === "gear train jam") {
      jamRamp = true;
      strainPct = Math.max(strainPct, 52);
      setAlarm("strain", true);
    }
  }

  function recover(fault) {
    const f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "gear train jam") jamRamp = false;
  }

  function reset() {
    simTime = 0;
    mains = false;
    blower = false;
    fanBreakerTripped = false;
    fanBreakerWasTripped = false;
    lampKnobA = 0;
    lampCurrentA = 0;
    lampTempC = AMBIENT_C;
    lampTripped = false;
    arcFault = false;
    arcBadSince = null;
    arcTrimGoodSince = null;
    airflowPct = 0;
    airLossSince = null;
    ratePos = 0;
    haHours = 4.2;
    prevHaHours = 4.2;
    cageArmed = true;
    cageLever = false;
    strainPct = 0;
    jamRamp = false;
    jammed = false;
    shutter = "closed";
    shutterPos = 0;
    latitudeDeg = 59;
    housePct = 30;
    civilMinutes = 19 * 60;
    hourMeter = 0;
    lastLatitude = 59;
    lastLatTime = 0;
    for (const k of ALARM_ORDER) alarms[k] = false;
    unacked = false;
    uiSyncFromMachine();
  }

  /* =========================== public API ============================ */

  const machine = {
    name: "Aldersund Planetarium Projector Console",
    faults: ["blower failure", "arc instability", "gear train jam"],

    state() {
      const r2 = (v) => Math.round(v * 100) / 100;
      return {
        alarms: ALARM_ORDER.filter((k) => alarms[k]).map((k) => ALARM_TEXT[k]),
        unacknowledged: unacked,
        mains,
        blower,
        fanBreakerTripped,
        lampKnobA: r2(lampKnobA),
        lampCurrentA: r2(lampCurrentA),
        arcLit: lampCurrentA >= ARC_STRIKE_A,
        arcStabilityPct: Math.round(arcStability()),
        lampTempC: r2(lampTempC),
        lampTripped,
        airflowPct: r2(airflowPct),
        rate: RATE_NAMES[ratePos],
        ratePos,
        siderealHours: r2(haHours),
        civilClock: `${fmt(civilMinutes / 60, 2)}:${fmt(civilMinutes % 60, 2)}`,
        hourMeter: r2(hourMeter),
        latitudeDeg: r2(latitudeDeg),
        strainPct: r2(strainPct),
        jammed,
        shutter,
        shutterOpenPct: r2(shutterPos * 100),
        houseLightsPct: r2(housePct),
        running: !!(
          mains &&
          lampCurrentA >= ARC_STRIKE_A &&
          shutterPos > 0.5 &&
          RATE_H_PER_S[ratePos] > 0 &&
          !jammed
        ),
      };
    },

    tick,
    inject,
    reset,

    /* panel-only actions, shared with the buttons */
    panel: {
      setMains(on) {
        mains = !!on;
        clickRelay();
      },
      setBlower(on) {
        blower = !!on;
        clickRelay();
      },
      setCurrent(a) {
        lampKnobA = clamp(Number(a) || 0, 0, CURRENT_MAX_A);
      },
      setRate(pos) {
        ratePos = clamp(Number(pos) | 0, 0, 3);
        clickRelay();
      },
      setCage(caged) {
        cageLever = !!caged;
        clickRelay();
      },
      setLatitude(deg) {
        latitudeDeg = clamp(Number(deg) || 0, LAT_MIN, LAT_MAX);
      },
      requestShutter(open) {
        const want = open ? "open" : "closed";
        if (shutter === want || shutter === (open ? "opening" : "closing"))
          return;
        shutter = open ? "opening" : "closing";
        clickRelay();
      },
      setHouse(pct) {
        housePct = clamp(Number(pct) || 0, 0, 100);
      },
      acceptAlarms() {
        unacked = false;
        clickRelay();
      },
      lampsTest(on) {
        lampsTestHeld = !!on;
      },
      fanBreakerReset() {
        if (blower) return; // interlocked: rest her switch before the breaker
        fanBreakerWasTripped = fanBreakerTripped;
        fanBreakerTripped = false;
        setAlarm("airloss", false);
        clickRelay();
      },
      jogRelease(on) {
        jogHeld = !!on;
      },
      tripReset() {
        if (jammed && strainPct > 4) return; // she is still bound
        jammed = false;
        jamRamp = false;
        lampTripped = false;
        setAlarm("jam", false);
        setAlarm("strain", false);
        setAlarm("overtemp", false);
        clickRelay();
      },
    },
  };

  let lampsTestHeld = false;
  let jogHeld = false;

  window.machine = machine;

  /* jogging drains the strained drums; done while stopped and caged */
  setInterval(() => {
    if (!jogHeld) return;
    if (ratePos !== 0) return;
    if (!cageLever) return;
    strainPct = Math.max(0, strainPct - 30 * 0.12);
    if (jammed && strainPct <= 2) {
      jammed = false; // free; the JAM window stays until TRIP RESET
    }
    if (navigator.vibrate) navigator.vibrate(8);
  }, 120);

  /* =============================== DOM ================================ */

  const $ = (sel) => document.querySelector(sel);
  const el = {
    port: $("[data-port]"),
    sidereal: $("[data-drum-sidereal]"),
    civil: $("[data-drum-civil]"),
    hours: $("[data-drum-hours]"),
    needleCurrent: $("[data-needle-current]"),
    thermoFill: $("[data-thermo-fill]"),
    airflowFill: $("[data-airflow-fill]"),
    pilotMains: $("[data-pilot-mains]"),
    pilotBlower: $("[data-pilot-blower]"),
    showLamp: $("[data-show-lamp]"),
    latitudeValue: $("[data-latitude-value]"),
    quadrantPointer: $("[data-quadrant-pointer]"),
    shutterWord: $("[data-shutter-word]"),
    shutterDot: $("[data-shutter-dot]"),
    breakerFlag: $("[data-breaker-flag]"),
    tiles: Array.from(document.querySelectorAll(".tile")),
    rateLabels: Array.from(document.querySelectorAll("[data-rate-label]")),
    mainsBtn: $("[data-mains]"),
    blowerBtn: $("[data-blower]"),
    knobCurrent: $("[data-knob-current]"),
    knobFace: document.querySelector("[data-knob-current] .knob-face"),
    selector: $("[data-selector]"),
    selectorBarrel: document.querySelector("[data-selector] .selector-barrel"),
    crank: $("[data-crank]"),
    crankWheel: document.querySelector("[data-crank] .crank-wheel"),
    cageGuard: $("[data-cage-guard]"),
    cageLever: $("[data-cage-lever]"),
    house: $("[data-house]"),
    slideFill: document.querySelector("[data-house] .slide-fill"),
    slideThumb: document.querySelector("[data-house] .slide-thumb"),
    shutterOpen: $("[data-shutter-open]"),
    shutterClose: $("[data-shutter-close]"),
    alarmAccept: $("[data-alarm-accept]"),
    lampsTest: $("[data-lamps-test]"),
    consoleReset: $("[data-console-reset]"),
    fanBreaker: $("[data-fan-breaker]"),
    jogRelease: $("[data-jog-release]"),
    tripReset: $("[data-trip-reset]"),
    dialog: $("[data-manual]"),
    manualOpeners: document.querySelectorAll('[data-action="manual"]'),
    manualClosers: document.querySelectorAll('[data-action="close-manual"]'),
    soundButton: $("[data-sound-button]"),
  };

  const ctx = el.port.getContext("2d");

  /* =============================== audio ============================== */

  let audio = null;
  let soundArmed = false;

  function buildAudio() {
    if (audio || !soundArmed) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const master = ac.createGain();
      master.gain.value = 0.9;
      master.connect(ac.destination);

      const noiseBuf = ac.createBuffer(1, ac.sampleRate * 1.2, ac.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      const mkNoise = (filterType, freq) => {
        const src = ac.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        const flt = ac.createBiquadFilter();
        flt.type = filterType;
        flt.frequency.value = freq;
        const g = ac.createGain();
        g.gain.value = 0;
        src.connect(flt).connect(g).connect(master);
        src.start();
        return g;
      };

      audio = {
        ac,
        master,
        blowerGain: mkNoise("lowpass", 340),
        hissGain: mkNoise("highpass", 3200),
        humOsc: (() => {
          const o = ac.createOscillator();
          o.type = "triangle";
          o.frequency.value = 100;
          const g = ac.createGain();
          g.gain.value = 0;
          o.connect(g).connect(master);
          o.start();
          return g;
        })(),
        click(last) {
          const t = ac.currentTime;
          const src = ac.createBufferSource();
          src.buffer = noiseBuf;
          const flt = ac.createBiquadFilter();
          flt.type = "bandpass";
          flt.frequency.value = 1700;
          flt.Q.value = 5;
          const g = ac.createGain();
          g.gain.setValueAtTime(last ?? 0.16, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
          src.connect(flt).connect(g).connect(master);
          src.start(t);
          src.stop(t + 0.09);
        },
        gong() {
          const t = ac.currentTime;
          const o = ac.createOscillator();
          o.type = "triangle";
          o.frequency.setValueAtTime(660, t);
          o.frequency.exponentialRampToValueAtTime(505, t + 0.5);
          const g = ac.createGain();
          g.gain.setValueAtTime(0.22, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
          o.connect(g).connect(master);
          o.start(t);
          o.stop(t + 0.75);
        },
      };
    } catch (e) {
      audio = null;
    }
  }

  let lastGongCount = 0;
  function clickRelay() {
    if (audio) audio.click();
  }

  document.addEventListener(
    "pointerdown",
    () => {
      buildAudio();
      if (audio && audio.ac.state === "suspended")
        audio.ac.resume().catch(() => {});
    },
    { capture: true },
  );

  /* ============================ interactions ========================== */

  function wirePress(btn, onDown, onUp) {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onDown();
    });
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointerleave", onUp);
    btn.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onDown();
      }
    });
    btn.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") onUp();
    });
  }

  /* paddle switches */
  el.mainsBtn.addEventListener("click", () => {
    const on = el.mainsBtn.getAttribute("aria-checked") !== "true";
    el.mainsBtn.setAttribute("aria-checked", String(on));
    machine.panel.setMains(on);
  });
  el.blowerBtn.addEventListener("click", () => {
    const on = el.blowerBtn.getAttribute("aria-checked") !== "true";
    el.blowerBtn.setAttribute("aria-checked", String(on));
    machine.panel.setBlower(on);
  });

  /* generic rotary drag: angle around the centre drives the value */
  function wireRotary(node, onChange) {
    let dragging = false;
    let lastAngle = 0;
    const angleOf = (e) => {
      const r = node.getBoundingClientRect();
      return Math.atan2(
        e.clientX - (r.left + r.width / 2),
        -(e.clientY - (r.top + r.height / 2)),
      );
    };
    node.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastAngle = angleOf(e);
      node.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const a = angleOf(e);
      let d = a - lastAngle;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      lastAngle = a;
      onChange(d, (d * 180) / Math.PI);
    });
    const end = () => {
      dragging = false;
    };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }

  function wireKeys(node, stepFn, bigStepFn) {
    node.addEventListener("keydown", (e) => {
      const big = e.shiftKey;
      let handled = true;
      switch (e.key) {
        case "ArrowUp":
        case "ArrowRight":
          stepFn(big ? 5 : 1);
          break;
        case "ArrowDown":
        case "ArrowLeft":
          stepFn(big ? -5 : -1);
          break;
        case "PageUp":
          bigStepFn ? bigStepFn(10) : stepFn(5);
          break;
        case "PageDown":
          bigStepFn ? bigStepFn(-10) : stepFn(-5);
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    });
  }

  /* arc current knob */
  const knobDegPerA = 5.4;
  function renderKnob() {
    el.knobFace.style.transform = `rotate(${(lampKnobA - 8) * knobDegPerA}deg)`;
    el.knobCurrent.setAttribute("aria-valuenow", String(Math.round(lampKnobA)));
    el.knobCurrent.setAttribute(
      "aria-valuetext",
      `${Math.round(lampKnobA)} amperes`,
    );
  }
  wireRotary(el.knobCurrent, (_d, deg) => {
    machine.panel.setCurrent(lampKnobA + deg / knobDegPerA);
  });
  wireKeys(el.knobCurrent, (n) =>
    machine.panel.setCurrent(lampKnobA + n * 0.5),
  );
  el.knobCurrent.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      machine.panel.setCurrent(lampKnobA + (e.deltaY < 0 ? 0.5 : -0.5));
    },
    { passive: false },
  );

  /* rate selector */
  const SELECT_ANGLES = [-120, -40, 40, 120];
  function renderSelector() {
    el.selectorBarrel.style.transform = `rotate(${SELECT_ANGLES[ratePos]}deg)`;
    el.selector.setAttribute("aria-valuenow", String(ratePos));
    el.selector.setAttribute("aria-valuetext", RATE_NAMES[ratePos]);
    el.rateLabels.forEach((b, i) => b.classList.toggle("on", i === ratePos));
  }
  wireRotary(el.selector, (_d, deg) => {
    const raw = SELECT_ANGLES.reduce(
      (best, a, i) => {
        const dist = Math.abs(((deg - a + 540) % 360) - 180);
        return dist < best.dist ? { i, dist } : best;
      },
      { i: ratePos, dist: Infinity },
    ).i;
    if (raw !== ratePos) machine.panel.setRate(raw);
  });
  wireKeys(el.selector, (n) => machine.panel.setRate(ratePos + Math.sign(n)));
  el.rateLabels.forEach((b, i) =>
    b.addEventListener("click", () => machine.panel.setRate(i)),
  );

  /* latitude crank */
  let crankVisual = 0;
  function renderCrank() {
    el.crankWheel.style.transform = `rotate(${crankVisual}deg)`;
    el.crank.setAttribute("aria-valuenow", String(Math.round(latitudeDeg)));
    el.crank.setAttribute(
      "aria-valuetext",
      `${Math.round(latitudeDeg)} degrees north`,
    );
    el.latitudeValue.textContent = String(Math.round(latitudeDeg));
    el.quadrantPointer.style.transform = `rotate(${(latitudeDeg - 40) * 2.4}deg)`;
  }
  wireRotary(el.crank, (dRad) => {
    crankVisual += (dRad * 180) / Math.PI;
    machine.panel.setLatitude(latitudeDeg + ((dRad * 180) / Math.PI) * 0.085);
  });
  wireKeys(el.crank, (n) => {
    machine.panel.setLatitude(latitudeDeg + n * 2);
  });

  /* re-cage guard + lever */
  el.cageGuard.addEventListener("click", () => {
    const open = el.cageGuard.getAttribute("aria-expanded") !== "true";
    el.cageGuard.setAttribute("aria-expanded", String(open));
    if (!open) {
      el.cageLever.disabled = true;
      el.cageLever.setAttribute("aria-checked", "false");
      machine.panel.setCage(false);
    } else {
      el.cageLever.disabled = false;
      clickRelay();
    }
  });
  el.cageLever.addEventListener("click", () => {
    const caged = el.cageLever.getAttribute("aria-checked") !== "true";
    el.cageLever.setAttribute("aria-checked", String(caged));
    machine.panel.setCage(caged);
  });

  /* shutter keys */
  el.shutterOpen.addEventListener("click", () =>
    machine.panel.requestShutter(true),
  );
  el.shutterClose.addEventListener("click", () =>
    machine.panel.requestShutter(false),
  );

  /* house light slider */
  function renderHouse() {
    el.slideFill.style.width = `${housePct}%`;
    el.slideThumb.style.left = `${housePct}%`;
    el.house.setAttribute("aria-valuenow", String(Math.round(housePct)));
    el.house.setAttribute("aria-valuetext", `${Math.round(housePct)} percent`);
  }
  function houseFromEvent(e) {
    const r = el.house.querySelector(".slide-track").getBoundingClientRect();
    machine.panel.setHouse(((e.clientX - r.left) / r.width) * 100);
  }
  let sliding = false;
  el.house.addEventListener("pointerdown", (e) => {
    sliding = true;
    el.house.setPointerCapture?.(e.pointerId);
    houseFromEvent(e);
  });
  el.house.addEventListener("pointermove", (e) => sliding && houseFromEvent(e));
  el.house.addEventListener("pointerup", () => {
    sliding = false;
  });
  wireKeys(el.house, (n) => machine.panel.setHouse(housePct + n));

  /* bench keys */
  el.alarmAccept.addEventListener("click", () => machine.panel.acceptAlarms());
  wirePress(
    el.lampsTest,
    () => machine.panel.lampsTest(true),
    () => machine.panel.lampsTest(false),
  );
  el.consoleReset.addEventListener("click", () => {
    machine.reset();
    clickRelay();
  });
  el.fanBreaker.addEventListener("click", () =>
    machine.panel.fanBreakerReset(),
  );
  wirePress(
    el.jogRelease,
    () => {
      jogHeld = true;
      el.jogRelease.classList.add("held");
    },
    () => {
      jogHeld = false;
      el.jogRelease.classList.remove("held");
    },
  );
  el.tripReset.addEventListener("click", () => machine.panel.tripReset());

  /* maintenance fault injection */
  document.querySelectorAll("[data-inject]").forEach((btn) =>
    btn.addEventListener("click", () => {
      machine.inject(btn.getAttribute("data-inject"));
      clickRelay();
    }),
  );

  /* manual dialog */
  el.manualOpeners.forEach((b) =>
    b.addEventListener("click", () => {
      try {
        el.dialog.showModal();
      } catch (e) {
        el.dialog.setAttribute("open", "");
      }
    }),
  );
  el.manualClosers.forEach((b) =>
    b.addEventListener("click", () => {
      try {
        el.dialog.close();
      } catch (e) {
        el.dialog.removeAttribute("open");
      }
    }),
  );
  el.dialog.addEventListener("click", (e) => {
    if (e.target === el.dialog) el.dialog.close();
  });

  /* sound arming */
  el.soundButton.addEventListener("click", () => {
    soundArmed = !soundArmed;
    el.soundButton.setAttribute("aria-pressed", String(soundArmed));
    el.soundButton.innerHTML = soundArmed
      ? 'LJUD<br /><span class="key-sub">SOUND ON</span>'
      : 'LJUD<br /><span class="key-sub">SOUND OFF</span>';
    if (soundArmed) buildAudio();
    if (audio) clickRelay();
  });

  function uiSyncFromMachine() {
    el.mainsBtn.setAttribute("aria-checked", "false");
    el.blowerBtn.setAttribute("aria-checked", "false");
    el.cageGuard.setAttribute("aria-expanded", "false");
    el.cageLever.disabled = true;
    el.cageLever.setAttribute("aria-checked", "false");
    renderKnob();
    renderSelector();
    renderCrank();
    renderHouse();
  }

  /* =============================== render ============================= */

  function renderInstruments() {
    const st = machine.state();

    el.needleCurrent.style.transform = `rotate(${-76 + (st.lampCurrentA / CURRENT_MAX_A) * 152}deg)`;
    el.thermoFill.style.height = `${clamp(((st.lampTempC - AMBIENT_C) / 100) * 100, 6, 100)}%`;
    el.airflowFill.style.width = `${st.airflowPct}%`;

    el.pilotMains.dataset.on = String(st.mains);
    el.pilotBlower.dataset.on = String(st.mains && st.blower);

    const hh = Math.floor(st.siderealHours);
    const mm = Math.floor((st.siderealHours - hh) * 60);
    const ss = Math.floor(((st.siderealHours - hh) * 60 - mm) * 60);
    el.sidereal.textContent = `${fmt(hh, 2)}:${fmt(mm, 2)}:${fmt(ss, 2)}`;
    el.civil.textContent = st.civilClock;
    el.hours.textContent = st.hourMeter.toFixed(1).padStart(6, "0");

    el.showLamp.style.opacity = st.running ? "1" : "0.25";

    el.shutterWord.textContent =
      st.shutter === "open"
        ? "OPEN"
        : st.shutter === "opening"
          ? "RISING"
          : st.shutter === "closing"
            ? "LOWERING"
            : "CLOSED";
    el.shutterDot.className = `state-dot ${
      st.shutter === "open"
        ? "open"
        : st.shutter === "opening" || st.shutter === "closing"
          ? "transit"
          : ""
    }`;

    el.breakerFlag.hidden = !st.fanBreakerTripped;
    el.fanBreaker.dataset.tripped = String(st.fanBreakerTripped);

    const testing = lampsTestHeld;
    let liveCount = 0;
    for (const tile of el.tiles) {
      const key = tile.getAttribute("data-alarm");
      const on = testing || st.alarms.includes(ALARM_TEXT[key]);
      tile.classList.toggle("active", on);
      tile.classList.toggle("flash", on && st.unacknowledged && !testing);
      if (on) liveCount++;
    }
    if (st.alarms.length > lastGongCount && audio && soundArmed) {
      try {
        audio.gong();
      } catch (e) {}
    }
    lastGongCount = st.alarms.length;

    if (audio && soundArmed) {
      const g = (v) => clamp(v, 0, 1);
      audio.blowerGain.gain.value = g((st.airflowPct / 100) * 0.17);
      audio.hissGain.gain.value = g(
        (st.lampCurrentA / CURRENT_MAX_A) * (st.arcStabilityPct / 100) * 0.06,
      );
      audio.humOsc.gain.value = g((st.lampCurrentA / CURRENT_MAX_A) * 0.028);
    }
    return st;
  }

  /* ------------------------------ the sky ----------------------------- */

  function drawSky(st) {
    const W = el.port.width;
    const H = el.port.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W / 2 - 26;

    ctx.clearRect(0, 0, W, H);

    // auditorium darkness behind the dome
    const night = ctx.createRadialGradient(cx, cy * 0.86, R * 0.1, cx, cy, R);
    night.addColorStop(0, "#10131c");
    night.addColorStop(1, "#07080d");
    ctx.fillStyle = night;
    ctx.fillRect(0, 0, W, H);

    const warm = clamp((st.lampTempC - 26) / 36, 0, 1);
    const iris = clamp(shutterPos, 0, 1);
    const houseDim = 1 - (st.houseLightsPct / 100) * 0.72;
    const instab = 1 - st.arcStabilityPct / 100;
    const flick =
      instab > 0.25
        ? 0.72 +
          0.28 * Math.abs(Math.sin(simTime * 11) * Math.sin(simTime * 4.3))
        : 1;
    const skyAlpha = warm * iris * houseDim * flick;
    const phi = (st.latitudeDeg * Math.PI) / 180;

    // the plaster itself, as the house lights leave it
    const plasterA = (st.houseLightsPct / 100) * 0.85;
    if (plasterA > 0.01) {
      const plaster = ctx.createRadialGradient(
        cx,
        cy * 1.04,
        R * 0.1,
        cx,
        cy,
        R,
      );
      plaster.addColorStop(0, "#c9bd9f");
      plaster.addColorStop(0.75, "#a99a7c");
      plaster.addColorStop(1, "#7c6f57");
      ctx.globalAlpha = plasterA;
      ctx.fillStyle = plaster;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // the lighting cove hugging the southern rim
      ctx.strokeStyle = "#241f18";
      ctx.lineWidth = R * 0.085;
      ctx.beginPath();
      ctx.arc(
        cx,
        cy - R * 0.06,
        R * 0.88,
        (Math.PI * 18) / 180,
        (Math.PI * 162) / 180,
      );
      ctx.stroke();

      // the star ball, silhouetted on her pier due south
      const bx = cx;
      const by = cy + R * 0.62;
      ctx.fillStyle = "#191510";
      ctx.beginPath();
      ctx.arc(bx, by, R * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(bx - R * 0.035, by, R * 0.07, R * 0.34);
      ctx.globalAlpha = plasterA * 0.5;
      ctx.strokeStyle = "#3d352a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        bx - R * 0.02,
        by - R * 0.03,
        R * 0.105,
        Math.PI * 0.85,
        Math.PI * 1.65,
      );
      ctx.stroke();
    }

    // arc light escaping round a closed shutter
    if (lampCurrentA > 5 && iris < 0.15 && st.lampTempC > 26) {
      const leak = clamp(
        (lampCurrentA / CURRENT_MAX_A) * ((st.lampTempC - 26) / 36),
        0,
        1,
      );
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      halo.addColorStop(0, "rgba(244, 196, 92, 0.32)");
      halo.addColorStop(0.55, "rgba(244, 170, 70, 0.11)");
      halo.addColorStop(1, "rgba(244, 170, 70, 0)");
      ctx.globalAlpha = leak;
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * iris, 0, Math.PI * 2);
    ctx.clip();

    // milky haze
    ctx.fillStyle = "#c8d2e8";
    for (const s of milkyWay) {
      const p = project(s.ra, s.dec, phi);
      if (!p) continue;
      ctx.globalAlpha = s.a * skyAlpha * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // stars
    for (const s of stars) {
      const p = project(s.ra, s.dec, phi);
      if (!p) continue;
      const twinkle = 0.82 + 0.18 * Math.sin(simTime * 2.2 + s.tw);
      ctx.globalAlpha = s.a * skyAlpha * twinkle;
      ctx.fillStyle = s.tint;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.r * 2.1, 0, Math.PI * 2);
      ctx.fill();
      if (s.flare && skyAlpha > 0.35) {
        ctx.globalAlpha = (s.a - 0.3) * skyAlpha;
        ctx.strokeStyle = s.tint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - s.r * 5, p.y);
        ctx.lineTo(p.x + s.r * 5, p.y);
        ctx.moveTo(p.x, p.y - s.r * 5);
        ctx.lineTo(p.x, p.y + s.r * 5);
        ctx.stroke();
      }
    }

    // the sun, when the SOL train carries her
    if (ratePos === 2 || ratePos === 3) {
      const p = project(haHoursToRa(haHours), (15 * Math.PI) / 180, phi);
      if (p) {
        const glow = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 64);
        glow.addColorStop(0, "rgba(255, 214, 140, 0.95)");
        glow.addColorStop(0.35, "rgba(255, 190, 110, 0.35)");
        glow.addColorStop(1, "rgba(255, 190, 110, 0)");
        ctx.globalAlpha = skyAlpha;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 64, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff3cf";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Polaris, the lecturer's friend
    {
      const p = project(raOfPolaris(), decOfPolaris(), phi);
      if (p) {
        ctx.globalAlpha = 0.9 * skyAlpha;
        ctx.fillStyle = "#f4f6ff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    // the horizon ring, etched
    ctx.globalAlpha = 0.45 + 0.55 * iris;
    ctx.strokeStyle = "#39415a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R * iris, 0, Math.PI * 2);
    ctx.stroke();

    // azimuth graduations engraved in the bezel glass
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#d8cdb2";
    for (let d = 0; d < 360; d += 15) {
      const a = (d * Math.PI) / 180;
      const major = d % 45 === 0;
      const r1 = R + 4;
      const r2 = R + (major ? 15 : 10);
      ctx.lineWidth = major ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
      ctx.stroke();
    }

    // house-light wash on the plaster
    if (st.houseLightsPct > 0) {
      ctx.globalAlpha = (st.houseLightsPct / 100) * 0.4;
      const wash = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
      wash.addColorStop(0, "#efe3c2");
      wash.addColorStop(1, "#c9b892");
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  function haHoursToRa(h) {
    return (h / 24) * Math.PI * 2;
  }

  function raOfPolaris() {
    return (2.53 / 24) * Math.PI * 2;
  }
  function decOfPolaris() {
    return (89.2 * Math.PI) / 180;
  }

  /* equatorial -> dome-interior fisheye; returns null below the horizon */
  function project(ra, dec, phi) {
    const W = el.port.width;
    const cx = W / 2;
    const cy = W / 2;
    const R = W / 2 - 26;
    const th = haHoursToRa(haHours); // sidereal time on the meridian
    const H = th - ra;
    const sinAlt =
      Math.sin(phi) * Math.sin(dec) +
      Math.cos(phi) * Math.cos(dec) * Math.cos(H);
    const alt = Math.asin(clamp(sinAlt, -1, 1));
    if (alt < 0) return null;
    // Meeus: azimuth from south, positive westward
    const A = Math.atan2(
      Math.sin(H),
      Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
    );
    const rr = R * Math.pow(1 - alt / (Math.PI / 2), 1.12);
    // lying under the dome, head north: south low, west to the right
    const x = cx + rr * Math.sin(A);
    const y = cy + rr * Math.cos(A);
    return { x, y };
  }

  /* ============================ main loop ============================= */

  let lastFrame = performance.now();
  function frame(now) {
    const dt = clamp((now - lastFrame) / 1000, 0, 0.12);
    lastFrame = now;
    if (!document.hidden) {
      tick(dt);
      const st = renderInstruments();
      drawSky(st);
      renderKnob();
      renderSelector();
      renderCrank();
      renderHouse();
    }
    requestAnimationFrame(frame);
  }

  uiSyncFromMachine();
  renderInstruments();
  drawSky(machine.state());
  requestAnimationFrame(frame);

  /* keep the probe honest: whole-second ticks stay available and pure */
  machine.tick(0);
})();
