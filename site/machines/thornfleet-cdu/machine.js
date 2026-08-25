/* Thornfleet Refinery — Crude Unit No.2 pneumatic control board, 1957.
   Simulation, panel behaviour and the fixed window.machine API.
   Vanilla script, wrapped in an IIFE, no modules, no network. */
(function () {
  "use strict";

  /* ============================== constants ============================== */

  var STEP = 0.05; // fixed integration step, seconds
  var AMBIENT = 15; // deg C, winter morning on the estuary

  var FAULTS = [
    "instrument air failure",
    "thermocouple drift",
    "reflux pump cavitation",
  ];

  var LOOPS = {
    tic: {
      tag: "TIC·1",
      min: 300,
      max: 600,
      defSp: 505,
      kp: 0.09,
      ki: 0.022,
      dir: 1,
    },
    pic: { tag: "PIC·2", min: 0, max: 3, defSp: 1.2, kp: 26, ki: 4.5, dir: -1 },
    fic: { tag: "FIC·3", min: 0, max: 90, defSp: 45, kp: 1.1, ki: 0.9, dir: 1 },
  };

  var COCK_TEXT = ["closed", "light", "open"];
  var TEST_NOTE = [
    "NO TEST SELECTED",
    "TESTING: INSTRUMENT AIR FAILURE",
    "TESTING: THERMOCOUPLE DRIFT",
    "TESTING: REFLUX PUMP CAVITATION",
  ];

  /* ============================== state ================================== */

  var S;

  function coldState() {
    return {
      t: 0,
      /* process */
      pumpRun: false,
      chargeRate: 0,
      cock: 0, // 0 closed, 1 light, 2 open
      airPct: 0,
      outletTemp: AMBIENT,
      colPress: 0.05,
      refluxFlow: 0,
      refluxHealth: 1,
      drumLevel: 34,
      sumpLevel: 24,
      flameOn: false,
      flameTimer: 0,
      flameDemand: 0,
      pilotLit: false,
      pilotIgniting: false,
      pilotHold: 0,
      /* controller outputs, percent of 3-15 psi span */
      out: { tic: 0, pic: 0, fic: 0 },
      integ: { tic: 0, pic: 0, fic: 0 },
      mode: { tic: "AUTO", pic: "AUTO", fic: "AUTO" },
      sp: { tic: LOOPS.tic.defSp, pic: LOOPS.pic.defSp, fic: LOOPS.fic.defSp },
      knob: {
        tic: LOOPS.tic.defSp,
        pic: LOOPS.pic.defSp,
        fic: LOOPS.fic.defSp,
      },
      /* protections */
      tripped: false,
      reliefOpen: false,
      reliefTime: 0,
      slammed: false,
      /* services */
      airHeader: 20,
      compressorOn: true,
      chartMotor: false,
      chartAngle: 0,
      /* fault latches and services state */
      fzAir: false,
      fzTc: false,
      fzCav: false,
      tcErr: 0,
      tcCell: 0, // 0 run, 1 duplex standby, 2 check
      testSel: 0,
      venting: false,
      /* annunciator */
      alarms: {}, // name -> "flash" | "steady"
      horn: false,
      lampTest: 0,
      /* recorder */
      history: [], // [t, indicated temp, column pressure]
      sampleAcc: 0,
    };
  }

  S = coldState();

  /* ============================== helpers ================================ */

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function fracOf(v, min, max) {
    return clamp((v - min) / (max - min), 0, 1);
  }

  function indicatedTemp() {
    if (S.tcCell === 0) return S.outletTemp + S.tcErr; // run cell may drift
    return S.outletTemp; // duplex or check reads true
  }

  function combustionEff() {
    return clamp(1 - Math.abs(S.airPct - 55) / 115, 0.32, 1);
  }

  function fuelValveOpening() {
    if (S.slammed || S.tripped) return 0;
    return S.cock === 2 ? 1 : S.cock === 1 ? 0.3 : 0;
  }

  function raiseAlarm(name) {
    if (!S.alarms[name]) {
      S.alarms[name] = "flash";
      S.horn = true;
    }
  }
  function clearAlarm(name) {
    delete S.alarms[name];
  }

  /* ============================ integration ============================== */

  function step(dt) {
    /* instrument air: the tests jam the compressor, reset restores it ------ */
    if (S.fzAir) S.compressorOn = false;
    if (S.compressorOn) S.airHeader = Math.min(20, S.airHeader + 0.5 * dt);
    else S.airHeader = Math.max(0, S.airHeader - 0.22 * dt);
    var airStarved = S.airHeader < 9.5;
    if (S.airHeader < 14) raiseAlarm("INSTRUMENT AIR LOW");
    else clearAlarm("INSTRUMENT AIR LOW");

    /* charge pump ----------------------------------------------------------- */
    var targetRate = S.pumpRun ? 120 : 0;
    var tauRate = S.pumpRun ? 6 : 9;
    S.chargeRate += (targetRate - S.chargeRate) * (dt / tauRate);
    if (Math.abs(targetRate - S.chargeRate) < 0.4) S.chargeRate = targetRate;

    /* controllers ------------------------------------------------------------
       AUTO: PI on (SP-PV); PIC is reverse acting (more output vents/condenses).
       MANUAL: the station knob drives the output directly.
       AIR STARVED: every output bleeds towards zero through the bleed plugs. */
    ["tic", "pic", "fic"].forEach(function (k) {
      var cfg = LOOPS[k];
      var pv =
        k === "tic" ? indicatedTemp() : k === "pic" ? S.colPress : S.refluxFlow;
      if (!airStarved && S.mode[k] === "AUTO") {
        var e = cfg.dir === 1 ? S.sp[k] - pv : pv - S.sp[k];
        S.integ[k] = clamp(S.integ[k] + cfg.ki * e * dt, 0, 120);
        var want = clamp(cfg.kp * e + S.integ[k], 0, 100);
        S.out[k] += (want - S.out[k]) * Math.min(1, dt / 2.2);
      } else if (airStarved) {
        S.out[k] *= Math.exp(-dt / 26);
      } else {
        var pct = clamp(
          ((S.knob[k] - cfg.min) / (cfg.max - cfg.min)) * 100,
          0,
          100,
        );
        S.out[k] += (pct - S.out[k]) * Math.min(1, dt / 1.6);
      }
    });

    /* burner ------------------------------------------------------------------ */
    var eff = combustionEff();
    var fuelFire = 0;
    var wantsFlame = S.cock >= 1 && !S.slammed && !S.tripped && S.out.tic >= 6;
    S.flameTimer = wantsFlame ? S.flameTimer + dt : 0;
    if (wantsFlame && !S.flameOn && S.flameTimer > 2.5) S.flameOn = true;
    if (!wantsFlame) S.flameOn = false;

    S.flameDemand = S.cock >= 1 ? S.flameDemand + dt : 0;
    if (!S.flameOn && S.flameDemand > 6) raiseAlarm("FLAME FAILURE");
    else clearAlarm("FLAME FAILURE");

    if (S.flameOn) {
      fuelFire = fuelValveOpening() * (0.2 + (0.8 * S.out.tic) / 100) * eff;
    }

    /* pilot igniter ------------------------------------------------------------ */
    if (S.pilotIgniting) {
      S.pilotHold += dt;
      if (S.pilotHold > 1.6) S.pilotLit = true;
    }

    /* furnace outlet temperature ------------------------------------------------ */
    var teq = 40 + fuelFire * 600 - S.chargeRate * 0.72;
    S.outletTemp += (teq - S.outletTemp) * (dt / 46);

    /* high temperature trip: protection reads the selected cell ------------------- */
    if (indicatedTemp() > 585 && !S.tripped) S.tripped = true;
    if (indicatedTemp() > 545) raiseAlarm("OUTLET TEMP HIGH");
    else clearAlarm("OUTLET TEMP HIGH");

    /* thermocouple run-cell disagreement ------------------------------------------ */
    if (Math.abs(S.tcErr) > 22) raiseAlarm("TC CELL FAULT");
    else clearAlarm("TC CELL FAULT");

    /* reflux flow -------------------------------------------------------------------- */
    var wantedFlow = clamp(S.out.fic / 100, 0, 1) * 90 * S.refluxHealth;
    S.refluxFlow += (wantedFlow - S.refluxFlow) * Math.min(1, dt / 3);
    if (S.refluxFlow < 25 && S.out.fic > 25) raiseAlarm("REFLUX FLOW LOW");
    else if (S.refluxFlow > 27) clearAlarm("REFLUX FLOW LOW");

    /* column pressure -------------------------------------------------------------------- */
    var vapour = S.flameOn
      ? (S.chargeRate * Math.max(0, S.outletTemp - 350)) / 148
      : 0;
    var condensing = 12 + S.refluxFlow * 2.5 + S.out.pic * 0.16;
    var reliefDrag = S.reliefOpen ? 3.4 : 0;
    S.colPress += (vapour - condensing - reliefDrag) * (dt / 17);
    S.colPress = clamp(S.colPress, 0, 3.4);

    if (S.colPress >= 2.6 && !S.reliefOpen) {
      S.reliefOpen = true;
      S.reliefTime = 0;
    }
    if (S.reliefOpen) {
      S.reliefTime += dt;
      if (S.colPress < 2.35 && S.reliefTime > 8) S.reliefOpen = false;
      if (S.reliefTime > 70 && !S.slammed) {
        S.slammed = true; // she cannot hang on the flare
        S.tripped = true;
      }
    }
    if (S.reliefOpen) raiseAlarm("RELIEF LIFTED");
    else clearAlarm("RELIEF LIFTED");
    if (S.colPress > 2.1) raiseAlarm("COLUMN PRESS HIGH");
    else clearAlarm("COLUMN PRESS HIGH");

    /* levels --------------------------------------------------------------------------------- */
    var overheadDraw = S.refluxFlow * 0.62 + 2;
    S.drumLevel += (overheadDraw - S.refluxFlow) * 0.06 * dt;
    S.drumLevel = clamp(S.drumLevel, 4, 92);
    S.sumpLevel = 18 + S.chargeRate * 0.05 + (S.flameOn ? 6 : 0);

    /* cavitation health and thermocouple drift ------------------------------------------------ */
    if (S.fzCav) S.refluxHealth = Math.max(0.12, S.refluxHealth - dt / 52);
    if (S.venting) S.refluxHealth = Math.min(1, S.refluxHealth + dt * 0.42);
    if (S.fzTc && S.tcCell === 0) S.tcErr = Math.max(-88, S.tcErr - dt * 0.68);

    /* circular chart ----------------------------------------------------------------------------- */
    if (S.chartMotor) {
      S.chartAngle += dt * ((Math.PI * 2) / 240); // one turn every four minutes
      S.sampleAcc += dt;
      if (S.sampleAcc >= 1.6) {
        S.sampleAcc = 0;
        S.history.push([S.t, indicatedTemp(), S.colPress]);
        if (S.history.length > 2600) S.history.shift();
      }
    }

    S.t += dt;
  }

  function tick(seconds) {
    var remaining = clamp(seconds || 0, 0, 3600);
    while (remaining > 0) {
      var h = remaining > STEP ? STEP : remaining;
      step(h);
      remaining -= h;
    }
  }

  /* ============================== public API ============================= */

  var NAME = "Thornfleet CDU No.2 Pneumatic Control Board";

  function round(v, n) {
    var m = Math.pow(10, n);
    return Math.round(v * m) / m;
  }

  function loopState(k) {
    var pv =
      k === "tic" ? indicatedTemp() : k === "pic" ? S.colPress : S.refluxFlow;
    return {
      sp: round(S.sp[k], 2),
      pv: round(pv, 2),
      out: round(S.out[k], 1),
      mode: S.airHeader < 9.5 && S.mode[k] === "AUTO" ? "DEAD" : S.mode[k],
    };
  }

  function activeFaults() {
    var a = [];
    if (S.fzAir) a.push("instrument air failure");
    if (S.fzTc) a.push("thermocouple drift");
    if (S.fzCav) a.push("reflux pump cavitation");
    return a;
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "instrument air failure") {
      S.fzAir = true;
      S.compressorOn = false;
    } else if (f === "thermocouple drift") {
      S.fzTc = true;
    } else if (f === "reflux pump cavitation") {
      S.fzCav = true;
    } else {
      throw new Error("unknown fault: " + fault);
    }
  }

  function reset() {
    S = coldState();
    syncAllInputs();
  }

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: function () {
      return {
        t: round(S.t, 2),
        name: NAME,
        chargeRate: round(S.chargeRate, 1),
        fuelGasCock: COCK_TEXT[S.cock].toUpperCase(),
        combustionAirPct: round(S.airPct, 1),
        outletTemp: round(S.outletTemp, 1),
        indicatedOutletTemp: round(indicatedTemp(), 1),
        columnPressure: round(S.colPress, 3),
        refluxFlow: round(S.refluxFlow, 1),
        refluxPumpHealth: round(S.refluxHealth, 2),
        refluxDrumLevel: round(S.drumLevel, 1),
        instrumentAir: round(S.airHeader, 2),
        flameOn: S.flameOn,
        pilotLit: S.pilotLit,
        hiTempTripped: S.tripped,
        reliefLifted: S.reliefOpen,
        fuelSlammed: S.slammed,
        loops: {
          tic: loopState("tic"),
          pic: loopState("pic"),
          fic: loopState("fic"),
        },
        faults: activeFaults(),
        alarms: Object.keys(S.alarms),
      };
    },
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ========================== panel interactions ========================= */

  function $(id) {
    return document.getElementById(id);
  }

  var els = {};
  [
    "tic-pv",
    "tic-sp",
    "tic-bal",
    "tic-knob",
    "tic-xfer",
    "tic-out-n",
    "tic-mode",
    "pic-pv",
    "pic-sp",
    "pic-bal",
    "pic-knob",
    "pic-xfer",
    "pic-out-n",
    "pic-mode",
    "fic-pv",
    "fic-sp",
    "fic-bal",
    "fic-knob",
    "fic-xfer",
    "fic-out-n",
    "fic-mode",
    "chart",
    "chart-motor",
    "air-needle",
    "compressor-reset",
    "air-note",
    "fuel-cock",
    "cock-handle",
    "register-knob",
    "register-read",
    "pilot-test",
    "flame-eye",
    "pump-start",
    "pump-stop",
    "pump-rate",
    "pump-note",
    "tc-selector",
    "tc-pointer",
    "trip-guard",
    "trip-reset-btn",
    "trip-note",
    "test-selector",
    "test-pointer",
    "test-note",
    "unit-reset",
    "vent-reflux",
    "coil-temp",
    "col-press-txt",
    "psv-tag",

    "charge-level",
    "sump-level",
    "drum-level",
    "flame",
    "flare-flame",
    "pump-charge",
    "pump-reflux",
    "manual-dialog",
  ].forEach(function (id) {
    els[id] = $(id);
  });

  /* ---- engraved scale faces ---- */

  var NS = "http://www.w3.org/2000/svg";

  function drawScale(group, majors, minors) {
    if (!group) return;
    for (var i = 0; i <= minors; i++) {
      var frac = i / minors;
      var big = i % Math.round(minors / majors) === 0;
      var a = ((-114 + 228 * frac) * Math.PI) / 180;
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", (110 + Math.sin(a) * 84).toFixed(1));
      ln.setAttribute("y1", (106 - Math.cos(a) * 84).toFixed(1));
      ln.setAttribute("x2", (110 + Math.sin(a) * (big ? 74 : 79)).toFixed(1));
      ln.setAttribute("y2", (106 - Math.cos(a) * (big ? 74 : 79)).toFixed(1));
      if (big) ln.setAttribute("class", "majors");
      group.appendChild(ln);
    }
  }

  drawScale(document.querySelector("#station-tic .scale-face"), 7, 30);
  drawScale(document.querySelector("#station-pic .scale-face"), 7, 28);
  drawScale(document.querySelector("#station-fic .scale-face"), 7, 28);

  function setRot(id, deg) {
    var el = $(id);
    if (el)
      el.setAttribute("transform", "rotate(" + deg.toFixed(2) + " 110 106)");
  }

  /* ---- discrete lever / selector behaviour ---- */

  function bindDiscrete(el, opts) {
    var suppressClick = false;
    var apply = function () {
      opts.render(el._val);
      el.setAttribute("aria-valuenow", String(el._val));
      el.setAttribute("aria-valuetext", opts.text(el._val));
    };
    el._val = opts.value();
    el.addEventListener("keydown", function (ev) {
      var v = el._val;
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") v++;
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") v--;
      else if (ev.key === "Enter" || ev.key === " ") v = v + 1;
      else return;
      ev.preventDefault();
      el._val = clamp(v, 0, opts.max);
      if (el._val >= opts.max + 1) el._val = 0;
      opts.commit(el._val);
      apply();
    });
    var drag = null;
    el.addEventListener("pointerdown", function (ev) {
      drag = { y: ev.clientY, v: el._val, moved: false };
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (e) {}
    });
    el.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      if (Math.abs(ev.clientY - drag.y) > 6) drag.moved = true;
      var nv = clamp(
        Math.round(drag.v - (ev.clientY - drag.y) / 22),
        0,
        opts.max,
      );
      if (nv !== el._val) {
        el._val = nv;
        opts.commit(nv);
        apply();
      }
    });
    var endDrag = function () {
      if (drag && drag.moved) suppressClick = true;
      drag = null;
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("click", function () {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      var nv = el._val + 1;
      if (nv > opts.max) nv = 0;
      el._val = nv;
      opts.commit(nv);
      apply();
    });
    apply();
    return {
      refresh: function () {
        el._val = opts.value();
        apply();
      },
    };
  }

  /* ---- continuous bakelite knob ---- */

  function bindKnob(el, key) {
    var cfg = LOOPS[key];
    var setV = function (v) {
      S.knob[key] = clamp(v, cfg.min, cfg.max);
      el.setAttribute(
        "aria-valuenow",
        S.knob[key].toFixed(key === "pic" ? 2 : 0),
      );
    };
    var render = function () {
      var f = fracOf(S.knob[key], cfg.min, cfg.max);
      el.style.transform = "rotate(" + (-140 + 280 * f).toFixed(1) + "deg)";
    };
    setV(S.knob[key]);
    render();
    el.addEventListener("keydown", function (ev) {
      var span = cfg.max - cfg.min;
      var st = span / 80,
        big = span / 12;
      var v = S.knob[key];
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") v += st;
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") v -= st;
      else if (ev.key === "PageUp") v += big;
      else if (ev.key === "PageDown") v -= big;
      else return;
      ev.preventDefault();
      setV(v);
      render();
    });
    var drag = null;
    el.addEventListener("pointerdown", function (ev) {
      drag = { y: ev.clientY, v: S.knob[key] };
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (e) {}
      ev.preventDefault();
    });
    el.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      setV(drag.v - ((ev.clientY - drag.y) * (cfg.max - cfg.min)) / 170);
      render();
    });
    var endDrag = function () {
      drag = null;
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    return {
      snapTo: function (v) {
        setV(v);
        render();
      },
      refresh: render,
    };
  }

  var knobUI = {};

  /* ---- AUTO / MANUAL transfer levers ---- */

  function renderXfer(key) {
    var btn = els[key + "-xfer"];
    var man = S.mode[key] === "MAN";
    btn.classList.toggle("auto", !man);
    btn.classList.toggle("man", man);
    btn.setAttribute("aria-pressed", String(!man));
    els[key + "-mode"].textContent =
      S.airHeader < 9.5 && !man ? "DEAD" : man ? "MANUAL" : "AUTO";
  }

  function bindXfer(key) {
    var btn = els[key + "-xfer"];
    btn.addEventListener("click", function () {
      if (S.mode[key] === "AUTO") {
        S.mode[key] = "MAN";
        var cfg = LOOPS[key];
        /* bumpless: drive the knob to the present output */
        knobUI[key].snapTo(cfg.min + ((cfg.max - cfg.min) * S.out[key]) / 100);
      } else {
        S.mode[key] = "AUTO";
        /* bumpless: preload the integrator at the manual output */
        S.integ[key] = S.out[key];
      }
      renderXfer(key);
    });
    btn.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowUp" && S.mode[key] !== "AUTO") {
        btn.click();
        ev.preventDefault();
      }
      if (ev.key === "ArrowDown" && S.mode[key] !== "MAN") {
        btn.click();
        ev.preventDefault();
      }
    });
  }

  /* ---- fuel gas cock ---- */

  var cockUI = bindDiscrete(els["fuel-cock"], {
    max: 2,
    value: function () {
      return S.cock;
    },
    commit: function (v) {
      S.cock = v;
    },
    text: function (v) {
      return COCK_TEXT[v];
    },
    render: function (v) {
      els["cock-handle"].style.transform = "rotate(" + [-52, 0, 52][v] + "deg)";
    },
  });

  /* ---- combustion air register ---- */

  knobUI.reg = (function () {
    var el = els["register-knob"];
    var render = function () {
      el.style.transform =
        "rotate(" + (-140 + (280 * S.airPct) / 100).toFixed(1) + "deg)";
      el.setAttribute("aria-valuenow", String(Math.round(S.airPct)));
      els["register-read"].textContent = "AIR " + Math.round(S.airPct) + "%";
    };
    var bump = function (d) {
      S.airPct = clamp(S.airPct + d, 0, 100);
      render();
    };
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
        bump(2.5);
        ev.preventDefault();
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
        bump(-2.5);
        ev.preventDefault();
      }
    });
    var drag = null;
    el.addEventListener("pointerdown", function (ev) {
      drag = { y: ev.clientY, v: S.airPct };
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (e) {}
      ev.preventDefault();
    });
    el.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      bump(drag.v - (ev.clientY - drag.y) * 0.65);
    });
    var endDrag = function () {
      drag = null;
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    render();
    return { refresh: render };
  })();

  /* ---- thermocouple cell selector ---- */

  var tcUI = bindDiscrete(els["tc-selector"], {
    max: 2,
    value: function () {
      return S.tcCell;
    },
    commit: function (v) {
      S.tcCell = v;
      if (v === 1) S.fzTc = false; // swinging over clears the drifting cell
    },
    text: function (v) {
      return ["run cell", "duplex standby", "check"][v];
    },
    render: function (v) {
      els["tc-pointer"].style.transform =
        "translateY(-100%) rotate(" + [-52, 0, 52][v] + "deg)";
    },
  });

  /* ---- works test selector (fault injection) ---- */

  var testUI = bindDiscrete(els["test-selector"], {
    max: 3,
    value: function () {
      return S.testSel;
    },
    commit: function (v) {
      S.testSel = v;
      if (v === 1) inject("instrument air failure");
      if (v === 2) inject("thermocouple drift");
      if (v === 3) inject("reflux pump cavitation");
      els["test-note"].textContent = TEST_NOTE[v];
    },
    text: function (v) {
      return ["off", "air failure test", "drift test", "cavitation test"][v];
    },
    render: function (v) {
      els["test-pointer"].style.transform =
        "translateY(-100%) rotate(" + [-64, -21, 21, 64][v] + "deg)";
    },
  });

  /* ---- plain buttons ---- */

  function wireBtn(id, fn) {
    var b = els[id];
    if (b) b.addEventListener("click", fn);
  }

  wireBtn("pump-start", function () {
    S.pumpRun = true;
  });
  wireBtn("pump-stop", function () {
    S.pumpRun = false;
  });
  wireBtn("compressor-reset", function () {
    if (S.testSel !== 1) {
      S.compressorOn = true;
      S.fzAir = false;
    }
  });
  wireBtn("unit-reset", function () {
    reset();
  });

  /* alarm accept and lamps test live in the annunciator rail */
  (function () {
    var acc = document.querySelector('[data-control="ALARM ACCEPT"]');
    if (acc)
      acc.addEventListener("click", function () {
        Object.keys(S.alarms).forEach(function (k) {
          S.alarms[k] = "steady";
        });
        S.horn = false;
      });
    var lt = document.querySelector('[data-control="LAMPS TEST"]');
    if (lt)
      lt.addEventListener("click", function () {
        S.lampTest = 2.5;
      });
  })();

  /* ---- hold-to-prove pilot igniter ---- */

  (function () {
    var b = els["pilot-test"];
    var start = function (ev) {
      ev.preventDefault();
      if (S.pilotIgniting) return;
      S.pilotIgniting = true;
      S.pilotHold = 0;
      b.classList.add("held");
    };
    var end = function () {
      if (!S.pilotIgniting) return;
      S.pilotIgniting = false;
      b.classList.remove("held");
      if (S.pilotHold > 1.5) S.pilotLit = true;
    };
    b.addEventListener("pointerdown", start);
    b.addEventListener("pointerup", end);
    b.addEventListener("pointerleave", end);
    b.addEventListener("keydown", function (ev) {
      if ((ev.key === " " || ev.key === "Enter") && !ev.repeat) start(ev);
    });
    b.addEventListener("keyup", function (ev) {
      if (ev.key === " " || ev.key === "Enter") end();
    });
  })();

  /* ---- hold-to-vent reflux pump ---- */

  (function () {
    var b = els["vent-reflux"];
    var on = function (ev) {
      ev.preventDefault();
      S.venting = true;
      b.classList.add("held");
    };
    var off = function () {
      S.venting = false;
      b.classList.remove("held");
    };
    b.addEventListener("pointerdown", on);
    b.addEventListener("pointerup", off);
    b.addEventListener("pointerleave", off);
    b.addEventListener("keydown", function (ev) {
      if ((ev.key === " " || ev.key === "Enter") && !ev.repeat) on(ev);
    });
    b.addEventListener("keyup", function (ev) {
      if (ev.key === " " || ev.key === "Enter") off();
    });
  })();

  /* ---- chart motor ---- */

  wireBtn("chart-motor", function () {
    S.chartMotor = !S.chartMotor;
    els["chart-motor"].setAttribute("aria-pressed", String(S.chartMotor));
  });

  /* ---- guarded hi-temperature trip reset ---- */

  (function () {
    var guard = els["trip-guard"];
    var btn = els["trip-reset-btn"];
    guard.addEventListener("click", function () {
      if (!guard.classList.contains("open")) {
        guard.classList.add("open");
        btn.disabled = false;
      }
    });
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      S.tripped = false;
      S.slammed = false;
      guard.classList.remove("open");
      btn.disabled = true;
    });
  })();

  /* ---- operating manual dialog ---- */

  (function () {
    var dlg = els["manual-dialog"];
    var opener = document.querySelector('[data-action="manual"]');
    var closer = document.querySelector('[data-action="close-manual"]');
    if (opener)
      opener.addEventListener("click", function () {
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    if (closer)
      closer.addEventListener("click", function () {
        if (typeof dlg.close === "function") dlg.close();
        else dlg.removeAttribute("open");
      });
  })();

  function syncAllInputs() {
    cockUI.refresh();
    tcUI.refresh();
    testUI.refresh();
    knobUI.reg.refresh();
    ["tic", "pic", "fic"].forEach(function (k) {
      knobUI[k].refresh();
      renderXfer(k);
    });
    els["chart-motor"].setAttribute("aria-pressed", "false");
    els["trip-guard"].classList.remove("open");
    els["trip-reset-btn"].disabled = true;
    els["trip-note"].textContent = "TRIP HEALTHY";
    els["test-note"].textContent = TEST_NOTE[0];
    els["register-read"].textContent = "AIR " + Math.round(S.airPct) + "%";
  }

  /* =============================== rendering ============================= */

  var chartCtx = els["chart"] ? els["chart"].getContext("2d") : null;

  function renderChart() {
    if (!chartCtx) return;
    var c = chartCtx,
      R = 145;
    c.clearRect(0, 0, 290, 290);
    c.save();
    c.translate(R, R);

    /* paper */
    c.beginPath();
    c.arc(0, 0, R - 3, 0, 7);
    c.fillStyle = "#f6efd8";
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = "#b9a97e";
    for (var rr = 30; rr <= 136; rr += 15) {
      c.beginPath();
      c.arc(0, 0, rr, 0, 7);
      c.stroke();
    }
    for (var hh = 0; hh < 24; hh++) {
      var sa = (hh * Math.PI) / 12;
      c.strokeStyle = hh % 6 === 0 ? "#a5966d" : "#cdbf94";
      c.lineWidth = hh % 6 === 0 ? 1.4 : 0.7;
      c.beginPath();
      c.moveTo(Math.cos(sa) * 30, Math.sin(sa) * 30);
      c.lineTo(Math.cos(sa) * 136, Math.sin(sa) * 136);
      c.stroke();
    }
    c.fillStyle = "#8f7f57";
    c.font = "700 8px Arial, sans-serif";
    c.textAlign = "center";
    c.fillText("THORNFLEET OIL WORKS · CHART 7", 0, -118);

    /* traces: the paper turns under two fixed pens */
    c.save();
    c.rotate(-S.chartAngle);
    var h = S.history,
      n = h.length;
    if (n > 1) {
      [
        [1, "#bf2314", 250, 650],
        [2, "#2e5d8a", 0, 3],
      ].forEach(function (pen) {
        c.strokeStyle = pen[1];
        c.lineWidth = 1.6;
        c.globalAlpha = 0.9;
        c.beginPath();
        var started = false,
          lastA = 0;
        for (var i = 0; i < n; i++) {
          var ta = ((h[i][0] % 240) / 240) * Math.PI * 2;
          var rad = 30 + 106 * fracOf(h[i][pen[0]], pen[2], pen[3]);
          var x = Math.cos(ta) * rad,
            y = Math.sin(ta) * rad;
          if (started && Math.abs(ta - lastA) > 0.4) {
            c.stroke();
            c.beginPath();
            started = false;
          }
          if (!started) {
            c.moveTo(x, y);
            started = true;
          } else {
            c.lineTo(x, y);
          }
          lastA = ta;
        }
        if (started) c.stroke();
        c.globalAlpha = 1;
      });
    }
    c.restore();

    /* pens riding their values */
    drawPen(
      c,
      -Math.PI / 2,
      30 + 106 * fracOf(clamp(indicatedTemp(), 250, 650), 250, 650),
      "#bf2314",
      S.chartMotor,
    );
    drawPen(
      c,
      Math.PI / 2,
      30 + 106 * fracOf(clamp(S.colPress, 0, 3), 0, 3),
      "#2e5d8a",
      S.chartMotor,
    );

    /* hub */
    c.beginPath();
    c.arc(0, 0, 13, 0, 7);
    c.fillStyle = "#b08d57";
    c.fill();
    c.strokeStyle = "#6e5426";
    c.lineWidth = 2;
    c.stroke();

    c.restore();
  }

  function drawPen(c, angle, rad, colour, live) {
    var x = Math.cos(angle) * rad,
      y = Math.sin(angle) * rad;
    c.strokeStyle = colour;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(Math.cos(angle) * (rad - 4), Math.sin(angle) * (rad - 4));
    c.lineTo(x, y);
    c.stroke();
    c.beginPath();
    c.arc(x, y, live ? 3.4 : 2.4, 0, 7);
    c.fillStyle = live ? colour : "#9c8f76";
    c.fill();
  }

  function setFlow(id, on) {
    var p = document.getElementById(id);
    if (p) p.classList.toggle("flowing", !!on);
  }

  function renderProcess() {
    /* flames */
    var fl = els["flame"];
    if (fl) {
      var op = S.flameOn ? 0.62 + 0.3 * Math.abs(Math.sin(S.t * 7.3)) : 0;
      fl.setAttribute("opacity", op.toFixed(2));
      fl.setAttribute(
        "ry",
        (16 * (S.flameOn ? 0.85 + (0.25 * S.out.tic) / 100 : 0.01)).toFixed(1),
      );
    }
    if (els["flare-flame"]) {
      els["flare-flame"].setAttribute("opacity", S.reliefOpen ? "0.95" : "0");
    }

    /* liquid levels */
    var sl = els["sump-level"];
    if (sl) {
      var sh = clamp(S.sumpLevel, 4, 44);
      sl.setAttribute("height", sh.toFixed(1));
      sl.setAttribute("y", (300 - sh).toFixed(1));
    }
    var dl = els["drum-level"];
    if (dl) {
      var dh = clamp(S.drumLevel * 0.76, 5, 76);
      dl.setAttribute("height", dh.toFixed(1));
      dl.setAttribute("y", (210 - dh).toFixed(1));
    }

    /* pumps */
    els["pump-charge"].classList.toggle("running", S.chargeRate > 4);
    els["pump-reflux"].classList.toggle("running", S.refluxFlow > 3);

    /* flows */
    setFlow("p-charge", S.chargeRate > 4);
    setFlow("p-transfer", S.flameOn && S.chargeRate > 4);
    setFlow("p-top", S.colPress > 0.25);
    setFlow("p-cond", S.colPress > 0.25);
    setFlow("p-reflux", S.refluxFlow > 3);
    setFlow("p-product", S.refluxFlow > 6);
    setFlow("p-relief", S.reliefOpen);
    setFlow("p-fuel", S.flameOn);

    /* readouts */
    els["coil-temp"].textContent =
      "COIL " + Math.round(indicatedTemp()) + "\u00B0C";
    els["col-press-txt"].textContent = S.colPress.toFixed(2) + " PSIG";
    els["psv-tag"].textContent = S.reliefOpen
      ? "PSV\u00B72 LIFTED"
      : "PSV\u00B72 SET 2.6";
    els["pump-rate"].textContent = Math.round(S.chargeRate) + " M\u00B3/H";
    els["pump-note"].textContent = S.pumpRun
      ? S.chargeRate > 60
        ? "RUNNING \u00B7 " + Math.round(S.chargeRate) + " M\u00B3/H"
        : "COMING UP"
      : "STOPPED";

    /* flame eye */
    els["flame-eye"].classList.toggle(
      "lit",
      S.flameOn || S.pilotLit || S.lampTest > 0,
    );

    /* air gauge and service notes */
    els["air-needle"].setAttribute(
      "transform",
      "rotate(" +
        (-90 + 180 * clamp(S.airHeader / 30, 0, 1)).toFixed(1) +
        " 55 66)",
    );
    els["air-note"].textContent = S.compressorOn
      ? S.airHeader > 19.5
        ? "COMPRESSOR RUNNING \u00B7 HEADER FULL"
        : "COMPRESSOR RUNNING \u00B7 REBUILDING"
      : "COMPRESSOR DOWN \u00B7 HEADER FALLING";

    els["trip-note"].textContent = S.tripped
      ? S.slammed
        ? "TRIPPED \u00B7 UNIT SLAMMED ON FLARE"
        : "HI-TEMP TRIP OPERATED"
      : S.tcCell === 1
        ? "STANDBY CELL IN SERVICE"
        : "TRIP HEALTHY";
  }

  function renderStations() {
    var ticF = fracOf(indicatedTemp(), LOOPS.tic.min, LOOPS.tic.max);
    var picF = fracOf(S.colPress, LOOPS.pic.min, LOOPS.pic.max);
    var ficF = fracOf(S.refluxFlow, LOOPS.fic.min, LOOPS.fic.max);
    setRot("tic-pv", -114 + 228 * ticF);
    setRot("pic-pv", -114 + 228 * picF);
    setRot("fic-pv", -114 + 228 * ficF);
    setRot(
      "tic-sp",
      -114 + 228 * fracOf(S.sp.tic, LOOPS.tic.min, LOOPS.tic.max),
    );
    setRot(
      "pic-sp",
      -114 + 228 * fracOf(S.sp.pic, LOOPS.pic.min, LOOPS.pic.max),
    );
    setRot(
      "fic-sp",
      -114 + 228 * fracOf(S.sp.fic, LOOPS.fic.min, LOOPS.fic.max),
    );

    /* balance needles: in MANUAL they show SP against PV */
    [
      ["tic", ticF],
      ["pic", picF],
      ["fic", ficF],
    ].forEach(function (p) {
      var k = p[0],
        bal = 0;
      if (S.mode[k] === "MAN") {
        bal = clamp(
          fracOf(S.knob[k], LOOPS[k].min, LOOPS[k].max) - p[1],
          -1,
          1,
        );
      }
      var el = $(k + "-bal");
      if (el)
        el.setAttribute(
          "transform",
          "rotate(" + (bal * 55).toFixed(1) + " 40 48)",
        );
    });

    /* output gauges, 3-15 psi */
    ["tic", "pic", "fic"].forEach(function (k) {
      var psi = 3 + (12 * S.out[k]) / 100;
      var el = $(k + "-out-n");
      if (el)
        el.setAttribute(
          "transform",
          "rotate(" + (-98 + (196 * (psi - 3)) / 12).toFixed(1) + " 45 52)",
        );
    });

    /* in AUTO the station knob sets the setpoint */
    ["tic", "pic", "fic"].forEach(function (k) {
      if (S.mode[k] === "AUTO") S.sp[k] = S.knob[k];
    });
  }

  function renderTiles() {
    var tiles = document.querySelectorAll("[data-alarm-tile]");
    Array.prototype.forEach.call(tiles, function (tile) {
      var st = S.alarms[tile.getAttribute("data-alarm-tile")];
      tile.classList.toggle(
        "alarm-flash",
        st === "flash" || (S.lampTest > 0 && !st),
      );
      tile.classList.toggle(
        "alarm-steady",
        st === "steady" || (S.lampTest > 0 && !!st),
      );
    });
  }

  /* ============================== boot =================================== */

  ["tic", "pic", "fic"].forEach(function (k) {
    knobUI[k] = bindKnob($(k + "-knob"), k);
  });
  ["tic", "pic", "fic"].forEach(bindXfer);
  syncAllInputs();
  reset();

  var last = null,
    raf = null;

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (last === null) {
      last = ts;
      return;
    }
    var dt = Math.min((ts - last) / 1000, 0.5);
    last = ts;
    tick(dt);
    if (S.lampTest > 0) S.lampTest -= dt;
    renderStations();
    renderChart();
    renderProcess();
    renderTiles();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      last = null;
    } else if (!raf) {
      last = null;
      raf = requestAnimationFrame(frame);
    }
  });

  if (!document.hidden) raf = requestAnimationFrame(frame);
})();
