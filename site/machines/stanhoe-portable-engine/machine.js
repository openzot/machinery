/*
 * Stanhoe & Bright Portable Engine No. 1284 — fireman's backhead.
 *
 * Fire, water and steam: three coupled quantities (fire-bed temperature,
 * boiler pressure, water level) with the threshing drum hanging off the
 * regulator. Nothing on this panel is electric — indication is brass
 * needles, lead glass and tin tell-tale flags, and every fault announces
 * itself mechanically.
 *
 * Exposes window.machine = { name, faults, state(), tick(s), inject(f), reset() }.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------ *
   * constants                                                     *
   * ------------------------------------------------------------ */

  var STEP = 0.05; // fixed integration step, seconds

  var GLASS_TOP = 13.0; // inches of water the glass can show
  var GLASS_LOW_ALARM = 3.0;
  var GLASS_HIGH_ALARM = 12.6;
  var PLUG_WATER = 1.15; // fusible plug uncovers below this
  var SAFETY_AT = 145;
  var SAFETY_RESEAT = 138;

  var FAULT_GLASS = "gauge glass broken";
  var FAULT_CONE = "injector choked with scale";
  var FAULT_SEATS = "safety valve seats leaking";

  /* ------------------------------------------------------------ *
   * cold state                                                    *
   * ------------------------------------------------------------ */

  function COLD() {
    return {
      t: 0,
      // fire
      doorOpen: false,
      damper: 3, // 0..10 notches
      coalBed: 0,
      coalBox: 96,
      clinker: 0,
      fireTemp: 14,
      fireLitEver: false,
      quench: false,
      // boiler
      psi: 0,
      waterIn: 7.2,
      blowBias: 0, // glasses read high after a blow-through
      safetyOpen: false,
      svEased: false,
      easeClean: 0, // seconds of easing spent cleaning the seat
      // steam off
      blower: 0,
      regulator: 0,
      whistle: false,
      whistleHeld: false,
      // feed
      waterTurns: 0,
      steamTurns: 0,
      clackTurns: 0,
      auxOn: false,
      pickedMain: false,
      pickedAux: false,
      spillMain: false,
      spillAux: false,
      // engine
      rpm: 0,
      load: 0.5,
      primeTimer: 0,
      damage: false,
      // faults & fittings
      glassBroken: false,
      glassCocks: [true, true], // both gauge cocks open
      coneChoked: false,
      seatsLeaking: false,
      plugDropped: false
    };
  }

  var S = COLD();

  /* ------------------------------------------------------------ *
   * small helpers                                                 *
   * ------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function norm(s) {
    return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
  }

  /* thresher duty: a slow deterministic working cycle */
  function dutyCycle(t) {
    var v =
      0.46 +
      0.27 * Math.sin((t / 97) * Math.PI * 2) +
      0.12 * Math.sin((t / 23) * Math.PI * 2 + 1.3);
    return clamp(v, 0.08, 1);
  }

  /* ------------------------------------------------------------ *
   * one fixed physics step                                        *
   * ------------------------------------------------------------ */

  function step(dt) {
    S.t += dt;
    S.load = dutyCycle(S.t);

    /* ---- draught and the fire ---- */
    var blowerDraft =
      (S.blower / 6) * clamp(S.psi / 40, 0, 1) * 0.95;
    var air =
      (S.damper / 10) * (S.doorOpen ? 1 : 0.22) + blowerDraft;
    air *= 1 - 0.55 * S.clinker;

    if (!S.quench && !S.plugDropped && S.coalBed > 0 && air > 0.02) {
      var burn = 0.055 * air * (0.35 + 0.65 * clamp(S.fireTemp / 900, 0, 1));
      burn = Math.min(burn * dt, S.coalBed);
      S.coalBed -= burn;
      S.clinker = clamp(S.clinker + burn * 0.004, 0, 1);
    }

    var fireTarget;
    if (S.quench || S.plugDropped || S.coalBed <= 0.01) {
      fireTarget = 14;
    } else {
      fireTarget =
        14 +
        940 *
          clamp(S.coalBed / 13, 0, 1) *
          clamp(air / 0.85, 0, 1.18);
    }
    var tau = fireTarget > S.fireTemp ? 26 : 11;
    if (S.quench || S.plugDropped) tau = 5;
    S.fireTemp += (fireTarget - S.fireTemp) * (dt / tau);

    /* ---- boiler pressure ---- */
    var tsat = 100 + 0.55 * S.psi;
    var heatIn = 0.0019 * Math.max(0, S.fireTemp - tsat);

    var drawReg = 0; // engine demand, psi/s
    var targetRpm = (S.regulator / 10) * 158;
    var avail = clamp((S.psi - 8) / 60, 0, 1);
    if (!S.damage) {
      S.rpm += (targetRpm * avail - S.rpm) * (dt / 6);
      if (S.rpm < 0.3 && targetRpm === 0) S.rpm = 0;
    } else {
      S.rpm += (0 - S.rpm) * dt; // seized drum falls dead
    }
    drawReg = (S.rpm / 158) * (1.7 + 2.7 * S.load);

    var drawBlower = (S.blower / 6) * 0.32;
    var drawWhistle = S.whistle ? 7 : 0;
    var drawLeak =
      S.seatsLeaking && S.psi > 70 ? (S.psi - 68) * 0.016 + 0.45 : 0;

    // safety valve with hysteresis; easing lever holds it open
    if (S.svEased) {
      S.safetyOpen = true;
      if (S.psi >= 100) S.easeClean += dt;
    } else if (S.psi >= SAFETY_AT) {
      S.safetyOpen = true;
    } else if (S.psi < SAFETY_RESEAT) {
      S.safetyOpen = false;
    }
    var dump = S.safetyOpen ? (S.psi - 134) * 0.09 + 1.5 : 0;
    if (dump < 0) dump = 0;

    // a picked injector feeds cold water: knocks the needle back a little
    var feedIn = feedingNow();
    var knock = feedIn.flow * 0.24;

    var dPsi = heatIn - drawReg - drawBlower - drawWhistle - drawLeak - dump - knock;
    S.psi = clamp(S.psi + dPsi * dt, 0, 200);

    /* ---- water level ---- */
    var steamOutPsi = drawReg + drawBlower + drawWhistle + drawLeak + dump;
    var evap = steamOutPsi / 19; // inches per second off the glass
    S.waterIn = clamp(S.waterIn + (feedIn.flow - evap) * dt, 0, GLASS_TOP + 0.4);

    S.blowBias = Math.max(0, S.blowBias - dt * 0.05);

    /* ---- priming: carry-over into the regulator ---- */
    var primingNow =
      S.waterIn > GLASS_HIGH_ALARM && (S.rpm > 55 || S.regulator >= 5);
    if (primingNow && !S.damage) {
      S.primeTimer += dt;
    } else {
      S.primeTimer = Math.max(0, S.primeTimer - dt * 2);
    }
    if (S.primeTimer > 70 && !S.damage) {
      S.damage = true;
    }

    /* ---- fusible plug ---- */
    if (
      !S.plugDropped &&
      !S.quench &&
      S.waterIn < PLUG_WATER &&
      S.fireTemp > 320
    ) {
      S.plugDropped = true;
    }

    /* ---- injector pick-up ---- */
    updateInjector(dt);
  }

  /* is an injector feeding, and how hard (inches of glass per second)? */
  function feedingNow() {
    var sel = S.auxOn ? S.pickedAux : S.pickedMain;
    if (!sel) return { flow: 0 };
    if (S.clackTurns < 2) return { flow: 0 };
    var flow = 0.075 * S.waterTurns + 0.04;
    return { flow: flow };
  }

  function updateInjector() {
    var wantFeed = S.waterTurns > 0 && S.steamTurns > 0;
    var healthy = wantFeed &&
      S.waterTurns >= 2 &&
      S.steamTurns >= 1 &&
      S.steamTurns <= 6 &&
      S.psi >= 20;

    // main cone is choked by the fault; auxiliary cone never chokes
    S.pickedMain = healthy && !S.coneChoked ? true : false;
    S.pickedAux = healthy ? true : false;

    var trying = S.auxOn ? S.pickedAux : S.pickedMain;
    var spilling = wantFeed && !trying;
    if (S.auxOn) {
      S.spillAux = spilling;
      S.spillMain = false;
    } else {
      S.spillMain = spilling;
      S.spillAux = false;
    }
  }

  /* ------------------------------------------------------------ *
   * alarms                                                        *
   * ------------------------------------------------------------ */

  function computeAlarms() {
    var a = [];
    if (S.waterIn < GLASS_LOW_ALARM) a.push("LOW WATER");
    if (S.waterIn > GLASS_HIGH_ALARM) a.push("HIGH WATER");
    if (S.primeTimer > 2 && !S.damage) a.push("PRIMING");
    if (S.damage) a.push("CYLINDER DAMAGED");
    if (S.safetyOpen) a.push("SAFETY VALVE BLOWING");
    if (S.fireLitEver && S.coalBed < 1.6 && S.fireTemp < 260 && !S.plugDropped)
      a.push("FIRE DYING");
    if (S.plugDropped) a.push("FUSIBLE PLUG DROPPED");
    if (S.glassBroken) a.push("GAUGE GLASS BROKEN");
    if (S.coneChoked) a.push("INJECTOR CHOKED");
    if (S.seatsLeaking) a.push("SAFETY VALVE LEAKING");
    return a;
  }

  /* ------------------------------------------------------------ *
   * public API                                                    *
   * ------------------------------------------------------------ */

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) return;
    var acc = seconds;
    var guard = 0;
    while (acc >= STEP && guard < 20000) {
      step(STEP);
      acc -= STEP;
      guard++;
    }
    if (acc > 0 && guard < 20000) {
      step(acc);
    }
  }

  function state() {
    return {
      timeSec: round(S.t, 1),
      psi: round(S.psi, 2),
      waterInches: round(S.waterIn, 2),
      fireTempC: round(S.fireTemp, 1),
      drumRpm: round(S.rpm, 1),
      loadPct: round(S.load * 100, 1),
      coalOnGrateKg: round(S.coalBed, 2),
      coalBoxKg: round(S.coalBox, 1),
      clinkerPct: round(S.clinker * 100, 1),
      damperNotches: S.damper,
      regulatorNotches: S.regulator,
      blowerHalfTurns: S.blower,
      injectorWaterHalfTurns: S.waterTurns,
      injectorSteamHalfTurns: S.steamTurns,
      feedCheckTurns: S.clackTurns,
      auxiliarySelected: S.auxOn,
      injectorPickedUp: !!(S.auxOn ? S.pickedAux : S.pickedMain),
      overflowSpilling: !!(S.auxOn ? S.spillAux : S.spillMain),
      safetyValveOpen: S.safetyOpen,
      fusiblePlugDropped: S.plugDropped,
      cylinderDamaged: S.damage,
      gaugeGlassBroken: S.glassBroken,
      faultsActive: {
        "gauge glass broken": S.glassBroken,
        "injector choked with scale": S.coneChoked,
        "safety valve seats leaking": S.seatsLeaking
      },
      alarms: computeAlarms()
    };
  }

  function round(v, p) {
    var m = Math.pow(10, p);
    return Math.round(v * m) / m;
  }

  function inject(fault) {
    var f = norm(fault);
    if (f === FAULT_GLASS) S.glassBroken = true;
    else if (f === FAULT_CONE) S.coneChoked = true;
    else if (f === FAULT_SEATS) S.seatsLeaking = true;
  }

  function reset() {
    S = COLD();
    syncControls();
  }

  window.machine = {
    name: "Stanhoe & Bright Portable Engine No. 1284",
    faults: [FAULT_GLASS, FAULT_CONE, FAULT_SEATS],
    state: state,
    tick: tick,
    inject: inject,
    reset: reset
  };

  /* ============================================================ *
   * panel wiring                                                  *
   * ============================================================ */

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  var root = $(".yard");
  var firedoorBtn = $('[data-control="FIRE DOOR"]');
  var damperQuad = $('[data-control="DAMPER QUADRANT"]');
  var regQuad = $('[data-control="REGULATOR LEVER"]');
  var scuttleBtn = $('[data-control="COAL SCUTTLE"]');
  var shakeBtn = $('[data-control="GRATE SHAKER"]');
  var tryCocks = $$("[data-try]");
  var gaugeCocks = $$("[data-cock]");
  var blowBtn = $('[data-control="GAUGE GLASS BLOW-DOWN"]');
  var easingBtn = $('[data-control="SAFETY EASING LEVER"]');
  var whistleBtn = $('[data-control="WHISTLE LANYARD"]');
  var waterWheel = $('[data-control="INJECTOR WATER COCK"]');
  var steamWheel = $('[data-control="INJECTOR STEAM COCK"]');
  var clackWheel = $('[data-control="FEED CHECK CLACK"]');
  var blowerWheel = $('[data-control="BLOWER VALVE"]');
  var auxSwitch = $('[data-control="AUXILIARY INJECTOR SELECTOR"]');
  var resetBtn = $("#cold-reset");
  var glassBench = $(".glass-bench");
  var dialog = $("dialog[data-manual]");

  var blownDown = false;

  /* ---------- generic slider behaviour (quadrants, wheels) ------ */

  function sliderValue(el) {
    return Number(el.getAttribute("aria-valuenow") || 0);
  }

  function setSlider(el, v, textFn) {
    v = clamp(Math.round(v), Number(el.getAttribute("aria-valuemin")), Number(el.getAttribute("aria-valuemax")));
    el.setAttribute("aria-valuenow", String(v));
    if (textFn) el.setAttribute("aria-valuetext", textFn(v));
    render();
  }

  function bindSlider(el, onSet, textFn) {
    var startX = 0;
    var startY = 0;
    var startV = 0;
    var moved = false;

    el.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      startV = sliderValue(el);
      moved = false;
    });
    el.addEventListener("pointermove", function (e) {
      if (!el.hasPointerCapture || !el.hasPointerCapture(e.pointerId)) return;
      var dx = e.clientX - startX;
      var dy = startY - e.clientY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      var span = Number(el.getAttribute("aria-valuemax"));
      var v = clamp(startV + Math.round((dx / 150) * span + dy / 22), 0, span);
      setSlider(el, v, textFn);
      onSet(v);
    });
    el.addEventListener("pointerup", function (e) {
      if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId))
        el.releasePointerCapture(e.pointerId);
      if (!moved) {
        var v = sliderValue(el) + 1;
        if (v > Number(el.getAttribute("aria-valuemax"))) v = 0;
        setSlider(el, v, textFn);
        onSet(v);
      }
    });
    el.addEventListener("keydown", function (e) {
      var v = sliderValue(el);
      var max = Number(el.getAttribute("aria-valuemax"));
      var handled = true;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") v += 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v -= 1;
      else if (e.key === "PageUp") v += 3;
      else if (e.key === "PageDown") v -= 3;
      else if (e.key === "Home") v = 0;
      else if (e.key === "End") v = max;
      else handled = false;
      if (handled) {
        e.preventDefault();
        v = clamp(v, 0, max);
        setSlider(el, v, textFn);
        onSet(v);
      }
    });
  }

  /* quadrants */

  bindSlider(
    damperQuad,
    function (v) {
      S.damper = v;
    },
    function (v) {
      return "Damper " + v + " of 10" + (v === 0 ? ", shut" : "");
    }
  );

  bindSlider(
    regQuad,
    function (v) {
      S.regulator = v;
    },
    function (v) {
      return "Regulator " + v + " of 10" + (v === 0 ? ", shut" : "");
    }
  );

  /* handwheels */

  function wheelText(name) {
    return function (v) {
      var turns = (v / 2).toFixed(1).replace(/\.0$/, "");
      return name + " " + turns + " turn" + (v === 0 ? "s shut" : " open");
    };
  }

  bindSlider(waterWheel, function (v) { S.waterTurns = v; }, wheelText("Water cock"));
  bindSlider(steamWheel, function (v) { S.steamTurns = v; }, wheelText("Steam cock"));
  bindSlider(blowerWheel, function (v) { S.blower = v; }, wheelText("Blower"));
  bindSlider(
    clackWheel,
    function (v) { S.clackTurns = v; },
    function (v) {
      if (v === 0) return "Feed check shut";
      if (v < 2) return "Feed check cracked";
      return "Feed check open, " + (v / 2).toFixed(1).replace(/\.0$/, "") + " turns";
    }
  );

  /* fire door */

  firedoorBtn.addEventListener("click", function () {
    S.doorOpen = !S.doorOpen;
    firedoorBtn.setAttribute("aria-pressed", String(S.doorOpen));
  });

  /* coal and grate */

  scuttleBtn.addEventListener("click", function () {
    if (S.coalBox <= 0) return;
    var grab = Math.min(8, S.coalBox);
    S.coalBox -= grab;
    S.coalBed = Math.min(28, S.coalBed + grab);
    S.fireLitEver = true;
  });

  shakeBtn.addEventListener("click", function () {
    S.clinker = Math.max(0, S.clinker - 0.22);
    puffAudio(0.25, 900, 0.05);
  });

  /* gauge cocks: shut a glass to take it out of service */

  gaugeCocks.forEach(function (btn, i) {
    btn.addEventListener("click", function () {
      S.glassCocks[i] = !S.glassCocks[i];
      btn.classList.toggle("is-open", S.glassCocks[i]);
      btn.setAttribute("aria-pressed", String(S.glassCocks[i]));
      btn.setAttribute(
        "aria-label",
        (i === 0 ? "Left" : "Right") + " glass gauge cock — " + (S.glassCocks[i] ? "open" : "shut")
      );
    });
  });

  /* try cocks: the honest reading when the glass lies */

  tryCocks.forEach(function (btn) {
    var heights = { top: 8.7, mid: 4.3, low: 0.6 };
    btn.addEventListener("pointerdown", function () {
      tryTest(btn.getAttribute("data-try"), heights[btn.getAttribute("data-try")]);
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        tryTest(btn.getAttribute("data-try"), heights[btn.getAttribute("data-try")]);
      }
    });
  });

  function tryTest(which, h) {
    var wet = S.waterIn > h + 0.4;
    $$(".wg-tube").forEach(function (tube) {
      var jet = document.createElement("span");
      jet.className = "wg-jet jet-" + which + (wet ? " jet-wet" : " jet-dry");
      tube.appendChild(jet);
      setTimeout(function () {
        jet.remove();
      }, 850);
    });
    puffAudio(0.4, wet ? 500 : 1400, 0.06);
  }

  /* blow through: clears the glasses, then they read a little high */

  function startBlow() {
    if (blownDown) return;
    blownDown = true;
    blowBtn.setAttribute("aria-pressed", "true");
    puffAudio(0.9, 1100, 0.08);
  }
  function endBlow() {
    if (!blownDown) return;
    blownDown = false;
    blowBtn.setAttribute("aria-pressed", "false");
    S.blowBias = 1.15; // surge above the true line, decays slowly
  }
  blowBtn.addEventListener("pointerdown", startBlow);
  blowBtn.addEventListener("pointerup", endBlow);
  blowBtn.addEventListener("pointerleave", endBlow);
  blowBtn.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) startBlow();
  });
  blowBtn.addEventListener("keyup", function (e) {
    if (e.key === "Enter" || e.key === " ") endBlow();
  });

  /* safety easing lever under its guard */

  var guardUp = false;
  var easeTimer = null;
  easingBtn.addEventListener("click", function () {
    if (!guardUp) {
      guardUp = true;
      easingBtn.setAttribute("aria-expanded", "true");
      return;
    }
    if (easeTimer) return; // already eased
    easingBtn.classList.add("eased");
    S.svEased = true;
    puffAudio(1.2, 700, 0.12);
    easeTimer = setTimeout(function () {
      easingBtn.classList.remove("eased");
      S.svEased = false;
      easeTimer = null;
      // two seconds of easing at working pressure blows the seat clean
      if (S.easeClean >= 1.6 && S.seatsLeaking) {
        S.seatsLeaking = false;
        S.easeClean = 0;
      }
    }, 2400);
  });
  function shutGuard() {
    if (easeTimer) return;
    guardUp = false;
    easingBtn.setAttribute("aria-expanded", "false");
  }
  easingBtn.addEventListener("dblclick", shutGuard);
  easingBtn.addEventListener("keydown", function (e) {
    if (e.key === "Escape") shutGuard();
  });

  /* whistle */

  function whistleDown() {
    if (S.whistle) return;
    S.whistle = true;
    whistleBtn.classList.add("is-pulled");
    whistleBtn.setAttribute("aria-pressed", "true");
    whistleAudio(true);
  }
  function whistleUp() {
    if (!S.whistle) return;
    S.whistle = false;
    whistleBtn.classList.remove("is-pulled");
    whistleBtn.setAttribute("aria-pressed", "false");
    whistleAudio(false);
  }
  whistleBtn.addEventListener("pointerdown", whistleDown);
  whistleBtn.addEventListener("pointerup", whistleUp);
  whistleBtn.addEventListener("pointerleave", whistleUp);
  whistleBtn.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) whistleDown();
  });
  whistleBtn.addEventListener("keyup", function (e) {
    if (e.key === "Enter" || e.key === " ") whistleUp();
  });

  /* aux selector */

  auxSwitch.addEventListener("click", function () {
    S.auxOn = !S.auxOn;
    auxSwitch.setAttribute("aria-checked", String(S.auxOn));
  });

  /* fitter's trials and repairs */

  $$(".trial-key").forEach(function (key) {
    key.addEventListener("click", function () {
      var trial = key.getAttribute("data-trial");
      var fix = key.getAttribute("data-fix");
      if (trial === "glass") S.glassBroken = true;
      if (trial === "cone") S.coneChoked = true;
      if (trial === "seats") S.seatsLeaking = true;
      if (fix === "glass") {
        if (S.glassBroken && !S.glassCocks[0] && !S.glassCocks[1]) {
          S.glassBroken = false;
        }
      }
      if (fix === "cone") S.coneChoked = false;
      if (fix === "plug") {
        if (S.psi < 15 && S.fireTemp < 160) {
          S.plugDropped = false;
          S.quench = false;
        }
      }
      if (fix === "cyl") {
        S.damage = false;
        S.primeTimer = 0;
      }
      render();
    });
  });

  /* cold standby */

  resetBtn.addEventListener("click", function () {
    reset();
  });

  /* keep control widgets in step after a programmatic reset */
  function syncControls() {
    firedoorBtn.setAttribute("aria-pressed", "false");
    setSlider(damperQuad, 3);
    setSlider(regQuad, 0);
    setSlider(waterWheel, 0);
    setSlider(steamWheel, 0);
    setSlider(clackWheel, 0);
    setSlider(blowerWheel, 0);
    auxSwitch.setAttribute("aria-checked", "false");
    gaugeCocks.forEach(function (b, i) {
      b.classList.toggle("is-open", true);
      b.setAttribute("aria-pressed", "true");
      S.glassCocks[i] = true;
    });
    guardUp = false;
    easingBtn.setAttribute("aria-expanded", "false");
    blowingGuardFix();
  }

  function blowingGuardFix() {
    /* no-op hook kept for clarity of sync order */
  }

  /* manual dialog */

  $('[data-action="manual"]').addEventListener("click", function () {
    dialog.showModal();
  });
  $('[data-action="close-manual"]').addEventListener("click", function () {
    dialog.close();
  });
  dialog.addEventListener("click", function (e) {
    var r = dialog.getBoundingClientRect();
    var inDialog =
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inDialog) dialog.close();
  });

  /* audio: synthesised hisses, strictly after a visitor gesture */

  var actx = null;
  function ensureAudio() {
    if (actx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    } catch (e) {
      actx = null;
    }
  }
  document.addEventListener("pointerdown", ensureAudio, { once: true });
  document.addEventListener("keydown", ensureAudio, { once: true });

  function noiseBuf(ctx, secs) {
    var buf = ctx.createBuffer(1, ctx.sampleRate * secs, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function puffAudio(secs, freq, gain) {
    if (!actx) return;
    try {
      var src = actx.createBufferSource();
      src.buffer = noiseBuf(actx, Math.max(0.3, secs));
      var f = actx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = freq;
      f.Q.value = 0.8;
      var g = actx.createGain();
      g.gain.value = gain;
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + secs);
      src.connect(f).connect(g).connect(actx.destination);
      src.start();
      src.stop(actx.currentTime + secs);
    } catch (e) { /* stay silent */ }
  }

  var whistleNodes = null;
  function whistleAudio(on) {
    if (!actx) return;
    try {
      if (on && !whistleNodes) {
        var o1 = actx.createOscillator();
        var o2 = actx.createOscillator();
        o1.type = "sine"; o2.type = "sine";
        o1.frequency.value = 622;
        o2.frequency.value = 933;
        var g = actx.createGain();
        g.gain.value = 0;
        g.gain.linearRampToValueAtTime(0.07, actx.currentTime + 0.05);
        o1.connect(g); o2.connect(g);
        g.connect(actx.destination);
        o1.start(); o2.start();
        whistleNodes = { o1: o1, o2: o2, g: g };
      } else if (!on && whistleNodes) {
        var w = whistleNodes;
        whistleNodes = null;
        w.g.gain.linearRampToValueAtTime(0.0001, actx.currentTime + 0.12);
        setTimeout(function () {
          try { w.o1.stop(); w.o2.stop(); } catch (e) {}
        }, 220);
      }
    } catch (e) { whistleNodes = null; }
  }

  /* ============================================================ *
   * rendering                                                     *
   * ============================================================ */

  var gaugeTicks = $('[data-gauge="ticks"]');
  var gaugeNumerals = $('[data-gauge="numerals"]');
  var gaugeRed = $('[data-gauge="redarc"]');

  (function buildGauge() {
    var NS = "http://www.w3.org/2000/svg";
    var cx = 160, cy = 172, rOut = 126, rIn = 112;
    for (var p = 0; p <= 200; p += 5) {
      var major = p % 25 === 0;
      var ang = (-118 + (p / 200) * 236) * (Math.PI / 180);
      var l = document.createElementNS(NS, "line");
      var r1 = major ? rIn : rIn + 8;
      l.setAttribute("x1", (cx + Math.sin(ang) * r1).toFixed(1));
      l.setAttribute("y1", (cy - Math.cos(ang) * r1).toFixed(1));
      l.setAttribute("x2", (cx + Math.sin(ang) * rOut).toFixed(1));
      l.setAttribute("y2", (cy - Math.cos(ang) * rOut).toFixed(1));
      if (!major) l.setAttribute("class", "minor");
      gaugeTicks.appendChild(l);
      if (major) {
        var t = document.createElementNS(NS, "text");
        var rl = rIn - 17;
        t.setAttribute("x", (cx + Math.sin(ang) * rl).toFixed(1));
        t.setAttribute("y", (cy - Math.cos(ang) * rl + 5).toFixed(1));
        t.setAttribute("text-anchor", "middle");
        t.textContent = String(p);
        gaugeNumerals.appendChild(t);
      }
    }
    var a1 = (-118 + (145 / 200) * 236) * (Math.PI / 180);
    var a2 = 118 * (Math.PI / 180);
    var rr = 119;
    var x1 = cx + Math.sin(a1) * rr, y1 = cy - Math.cos(a1) * rr;
    var x2 = cx + Math.sin(a2) * rr, y2 = cy - Math.cos(a2) * rr;
    gaugeRed.setAttribute(
      "d",
      "M " + x1.toFixed(1) + " " + y1.toFixed(1) +
      " A " + rr + " " + rr + " 0 0 1 " + x2.toFixed(1) + " " + y2.toFixed(1)
    );
  })();

  (function buildDrumTicks() {
    var NS = "http://www.w3.org/2000/svg";
    var g = $('[data-drum="ticks"]');
    for (var i = 0; i <= 8; i++) {
      var ang = (-62 + (i / 8) * 124) * (Math.PI / 180);
      var l = document.createElementNS(NS, "line");
      l.setAttribute("x1", (70 + Math.sin(ang) * 44).toFixed(1));
      l.setAttribute("y1", (82 - Math.cos(ang) * 44).toFixed(1));
      l.setAttribute("x2", (70 + Math.sin(ang) * 54).toFixed(1));
      l.setAttribute("y2", (82 - Math.cos(ang) * 54).toFixed(1));
      g.appendChild(l);
    }
  })();

  var readouts = {};
  $$("[data-readout]").forEach(function (el) {
    readouts[el.getAttribute("data-readout")] = el;
  });
  var flags = {};
  $$(".telltale").forEach(function (el) {
    flags[el.getAttribute("data-flag")] = el;
  });
  var dgWater = $('[data-dg="water"]');
  var dgFirebed = $('[data-dg="firebed"]');
  var saySpan = $("[data-gauge-say]");

  var WORDS = ["zero", "ten", "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety", "one hundred"];

  function psiWords(p) {
    var n = Math.round(p / 10) * 10;
    if (n >= 100) return n + " pounds or more";
    return WORDS[n / 10] + " pounds";
  }

  function displayedLevel(which) {
    var base = S.waterIn;
    var broken = S.glassBroken;
    if (blownDown) base = 0.4;
    if (broken) return 0.03;
    var v = base + S.blowBias;
    if (!S.glassCocks[which]) {
      // glass taken out of service: it freezes where it was left.
      // cheap model: it simply reads nothing useful — near empty.
      return 0.06;
    }
    return clamp((v - 0.4) / 13, 0.02, 1);
  }

  var lastRender = 0;
  function render(nowFrame) {
    var fire01 = clamp((S.fireTemp - 80) / 700, 0, 1);
    var st = root.style;

    st.setProperty("--needle-deg", (-118 + (clamp(S.psi, 0, 200) / 200) * 236).toFixed(2) + "deg");
    st.setProperty("--drum-needle-deg", (-62 + (clamp(S.rpm, 0, 170) / 170) * 124).toFixed(2) + "deg");
    st.setProperty("--fire", fire01.toFixed(3));
    st.setProperty("--glow", (fire01 * 0.85).toFixed(3));
    st.setProperty("--water-l", (displayedLevel(0) * 100).toFixed(1) + "%");
    st.setProperty("--water-r", (displayedLevel(1) * 100).toFixed(1) + "%");
    st.setProperty("--coal-frac", clamp((S.coalBox / 96) * 100, 0, 100).toFixed(1) + "%");

    var spill = S.auxOn ? S.spillAux : S.spillMain;
    st.setProperty("--spill", spill ? "1" : "0");

    var puff = 0;
    if (S.safetyOpen) puff = 0.75 + 0.25 * Math.sin(S.t * 21);
    if (S.whistle) puff = Math.max(puff, 0.9);
    st.setProperty("--steam-puff", puff.toFixed(2));

    var flyDur = S.rpm > 2 ? clamp(260 / S.rpm, 0.28, 30) : 0;
    st.setProperty("--fly-speed", flyDur ? flyDur.toFixed(2) + "s" : "0s");
    st.setProperty("--drum-speed", flyDur ? flyDur.toFixed(2) + "s" : "0s");
    root.classList.toggle("running", S.rpm > 2);

    /* levers and wheels */
    damperQuad.style.setProperty("--lever-deg", (-60 + (S.damper / 10) * 100).toFixed(1) + "deg");
    damperQuad.setAttribute("aria-valuenow", String(S.damper));
    regQuad.style.setProperty("--lever-deg", (-60 + (S.regulator / 10) * 100).toFixed(1) + "deg");
    regQuad.setAttribute("aria-valuenow", String(S.regulator));

    waterWheel.style.setProperty("--rot", (S.waterTurns * 180) + "deg");
    waterWheel.setAttribute("aria-valuenow", String(S.waterTurns));
    steamWheel.style.setProperty("--rot", (S.steamTurns * 180) + "deg");
    steamWheel.setAttribute("aria-valuenow", String(S.steamTurns));
    blowerWheel.style.setProperty("--rot", (S.blower * 180) + "deg");
    blowerWheel.setAttribute("aria-valuenow", String(S.blower));
    clackWheel.style.setProperty("--rot", (S.clackTurns * 120) + "deg");
    clackWheel.setAttribute("aria-valuenow", String(S.clackTurns));

    if (readouts.wturns) readouts.wturns.textContent = String(S.waterTurns);
    if (readouts.sturns) readouts.sturns.textContent = String(S.steamTurns);
    if (readouts.bturns) readouts.bturns.textContent = String(S.blower);
    if (readouts.cturns)
      readouts.cturns.textContent = S.clackTurns === 0 ? "SHUT" : (S.clackTurns / 2).toFixed(1).replace(/\.0$/, "");

    /* diagram water + fire bed */
    if (dgWater) {
      var wyTop = 178 - clamp(S.waterIn / 14, 0, 1) * 116;
      dgWater.setAttribute("y", wyTop.toFixed(1));
      dgWater.setAttribute("height", (178 - wyTop).toFixed(1));
    }
    if (dgFirebed) {
      dgFirebed.style.filter = "brightness(" + (0.6 + fire01 * 1.6).toFixed(2) + ")";
    }

    /* small wordy readouts */
    if (readouts.drum) readouts.drum.textContent = String(Math.round(S.rpm));
    if (readouts.firetemp)
      readouts.firetemp.textContent =
        S.fireTemp < 90 ? "cold" :
        S.fireTemp < 300 ? "taking" :
        S.fireTemp < 600 ? "bright" : "white-hot";
    if (readouts.clinker)
      readouts.clinker.textContent =
        S.clinker < 0.2 ? "none to speak of" :
        S.clinker < 0.55 ? "forming" : "bad — shake her";
    if (readouts.overflow)
      readouts.overflow.textContent =
        (S.auxOn ? S.spillAux : S.spillMain) ? "dribbling — not picked up" :
        (S.auxOn ? S.pickedAux : S.pickedMain) ? "dry — feeding" : "dry";

    /* tell-tales */
    var alarm = computeAlarms();
    Object.keys(flags).forEach(function (name) {
      var dropped = alarm.indexOf(name) !== -1;
      var el = flags[name];
      var changed = el.classList.contains("is-dropped") !== dropped;
      el.classList.toggle("is-dropped", dropped);
      if (changed) el.setAttribute("aria-hidden", String(!dropped));
    });

    /* glasses */
    glassBench.classList.toggle("is-broken", S.glassBroken);
    glassBench.setAttribute(
      "aria-label",
      S.glassBroken
        ? "Gauge glasses broken and dripping — use the try cocks"
        : "Gauge glasses showing about " + Math.round(S.waterIn) + " inches"
    );

    if (saySpan) saySpan.textContent = psiWords(S.psi);

    lastRender = nowFrame;
  }

  /* ============================================================ *
   * animation loop                                                *
   * ============================================================ */

  var rafAcc = 0;
  var lastFrame = performance.now();
  var hidden = false;

  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    if (!hidden) lastFrame = performance.now();
  });

  function frame(now) {
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!hidden) {
      if (dt > 1) dt = 1;
      rafAcc += dt;
      while (rafAcc >= STEP) {
        step(STEP);
        rafAcc -= STEP;
      }
    }
    render(now);
    requestAnimationFrame(frame);
  }

  /* safety valve hiss follows the valve, only once audio exists */
  setInterval(function () {
    if (actx && S.safetyOpen && Math.random() < 0.5) {
      puffAudio(0.6, 800, 0.05);
    }
  }, 1400);

  syncControls();
  render(0);
  requestAnimationFrame(frame);
})();
