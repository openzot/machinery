/* ========================================================================
   FIRE DIRECTOR Mk. IV — behaviour
   A coast-artillery analogue fire computer: track the ship by hand, let
   the drums settle, mind the barrel heat. Deterministic tick(), no clocks.
   ======================================================================== */

(function () {
  "use strict";

  var FAULTS = [
    "gyro drift",
    "generator overload",
    "range transmission failure",
  ];
  var FAULT_KEYS = {
    gd: "gyro drift",
    go: "generator overload",
    rs: "range transmission failure",
  };

  /* ---- simulation state -------------------------------------------------- */

  var S = null;

  function freshState() {
    return {
      t: 0,
      /* power plant */
      mgOn: false,
      mgOffTimer: 0,
      mgTripped: false,
      hadPower: false,
      voltage: 0,
      gyro: 0,
      caged: false,
      cageTimer: 0,
      /* mode */
      mode: "off",
      /* target truth (yards; battery at the origin, north is +y) */
      shipX: -6500,
      shipY: 4200,
      shipVx: 11.3,
      shipVy: -2.6,
      pass: 0,
      tgtBrg: 0,
      tgtRg: 0,
      /* tracker */
      trkBrg: 305,
      trkRg: 9000,
      errAz: 0,
      errRg: 0,
      matched: false,
      quality: 0,
      lostTimer: 0,
      /* solution */
      valid: false,
      hasSolution: false,
      gunBrg: 305,
      quadElev: 0,
      predRg: 9000,
      /* gunnery */
      rounds: 0,
      heat: 18,
      overheatLatch: false,
      damageLatch: false,
      /* faults and alarms */
      faults: { gd: false, go: false, rs: false },
      timers: { gd: 0, rs: 0, trip: 0, goAnn: 0, rsAnn: 0 },
      driftBias: 0,
      driftRate: 0,
      silenced: false,
      alarms: {},
    };
  }

  /* ---- helpers ------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function wrap180(a) {
    a = a % 360;
    if (a > 180) a -= 360;
    if (a < -180) a += 360;
    return a;
  }

  function fmt(v, w, p) {
    if (!isFinite(v)) v = 0;
    var s = Math.abs(v).toFixed(p);
    while (s.length < w) s = "0" + s;
    return (v < 0 ? "-" : "") + s;
  }

  function bearingOf(x, y) {
    var b = (Math.atan2(x, y) * 180) / Math.PI;
    return b < 0 ? b + 360 : b;
  }

  /* ---- physics ------------------------------------------------------------ */

  function advanceTarget(dt) {
    S.shipX += S.shipVx * dt;
    S.shipY += S.shipVy * dt;
    S.tgtRg = Math.hypot(S.shipX, S.shipY);
    S.tgtBrg = bearingOf(S.shipX, S.shipY);
    /* she clears the headland: the next ship takes her station (deterministic) */
    if (S.shipX > 9200 || S.tgtRg > 15200) {
      S.pass += 1;
      S.shipX = -7200 - ((S.pass * 211) % 500);
      S.shipY = 4600 - ((S.pass * 173) % 900);
      S.shipVx = 11.3;
      S.shipVy = -2.6;
    }
  }

  function advancePower(dt) {
    /* the overload drags a running bus down; a dead set just decays */
    if (S.faults.go && S.mgOn) {
      S.voltage += (295 - S.voltage) * clamp(dt * 0.9, 0, 1);
    } else if (S.mgOn && !S.mgTripped) {
      S.voltage += (415 - S.voltage) * clamp(dt * 0.7, 0, 1);
    } else {
      S.voltage += (0 - S.voltage) * clamp(dt * 1.4, 0, 1);
    }

    S.hadPower = S.hadPower || S.mgOn;

    if (!S.mgOn) {
      S.mgOffTimer += dt;
      /* three seconds at rest reset an overloaded breaker that has run */
      if (S.mgOffTimer >= 3 && S.hadPower && S.faults.go) {
        S.faults.go = false;
        S.hadPower = false;
        syncTestSwitches();
      }
      if (S.mgOffTimer >= 3) S.mgTripped = false;
    } else {
      S.mgOffTimer = 0;
      /* ignoring LOW VOLTAGE for a quarter minute trips the set altogether */
      if (S.faults.go && S.voltage < 250) {
        S.timers.trip += dt;
        if (S.timers.trip > 18) {
          S.mgTripped = true;
          S.timers.trip = 0;
        }
      } else {
        S.timers.trip = 0;
      }
    }

    /* flywheel: spins up on good power, runs down without it */
    if (S.voltage >= 380) S.gyro += (100 - S.gyro) * clamp(dt * 0.16, 0, 1);
    else S.gyro -= S.gyro * clamp(dt * 0.22, 0, 1);
    S.gyro = clamp(S.gyro, 0, 100);

    /* gyro cage: hold it three seconds to kill precession drift */
    if (S.caged) {
      S.cageTimer += dt;
      if (S.cageTimer >= 3 && S.faults.gd && S.voltage >= 380) {
        S.faults.gd = false;
        S.driftBias = 0;
        S.driftRate = 0;
        syncTestSwitches();
      }
    } else {
      S.cageTimer = 0;
      if (S.faults.gd && S.voltage >= 380) {
        S.driftRate = clamp(S.driftRate + dt * 0.006, 0, 0.34);
        S.driftBias += S.driftRate * dt * 12;
      }
    }

    /* range-data servo re-syncs itself once the selector rests at OFF */
    if (S.faults.rs && S.mode === "off") {
      S.timers.rs += dt;
      if (S.timers.rs >= 5) {
        S.faults.rs = false;
        S.timers.rs = 0;
        syncTestSwitches();
      }
    }
  }

  function advanceTracking(dt) {
    var eAz = wrap180(S.tgtBrg - S.trkBrg);
    var eRg = S.tgtRg - S.trkRg;
    S.errAz = eAz;
    S.errRg = eRg;

    S.matched = Math.abs(eAz) <= 0.8 && Math.abs(eRg) <= 90;

    if (S.mode !== "off") {
      S.quality = clamp(S.quality + (S.matched ? dt / 4 : -dt / 6), 0, 1);
    } else {
      S.quality = clamp(S.quality - dt / 3, 0, 1);
    }

    /* ignoring TRACK LOST in COMPUTE drops the plot entirely */
    if (S.mode === "compute" && S.quality < 0.25) {
      S.lostTimer += dt;
      if (S.lostTimer >= 8) S.alarms["TRACK LOST"] = true;
    } else if (S.quality >= 0.5) {
      S.lostTimer = 0;
      delete S.alarms["TRACK LOST"];
    }
  }

  function advanceSolution(dt) {
    S.valid =
      S.mode === "compute" &&
      S.mgOn &&
      !S.mgTripped &&
      S.voltage >= 380 &&
      S.gyro >= 95 &&
      !S.caged &&
      S.quality >= 0.85;

    if (!S.valid) return;

    /* intercept: three fixed-point passes, the way the cams do it */
    var ft = S.predRg / 866;
    var ax = 0,
      ay = 0,
      i;
    for (i = 0; i < 3; i++) {
      ax = S.shipX + S.shipVx * ft;
      ay = S.shipY + S.shipVy * ft;
      ft = clamp(Math.hypot(ax, ay) / 866, 2, 45);
    }
    var desBrg = bearingOf(ax, ay) + S.driftBias;
    var desRg = clamp(Math.hypot(ax, ay), 800, 16000);
    var desEl = clamp(0.13 * Math.pow(desRg / 1000, 1.75), 0.4, 25);

    var k = clamp(dt * 0.9, 0, 1);
    S.gunBrg += wrap180(desBrg - S.gunBrg) * k;
    S.quadElev += (desEl - S.quadElev) * k;
    S.predRg += (desRg - S.predRg) * k;
    S.hasSolution = true;
  }

  function advanceGunnery(dt) {
    S.heat = clamp(S.heat - dt * 1.15, 18, 130);

    if (S.heat >= 100) {
      S.overheatLatch = true;
      S.alarms.OVERHEAT = true;
    }
    if (S.overheatLatch && S.heat <= 70) {
      S.overheatLatch = false;
      delete S.alarms.OVERHEAT;
    }
    /* firing into the red ruins the liner: only the armourer can fix that */
    if (S.heat >= 118) S.damageLatch = true;

    /* LOW VOLTAGE annunciator, with its own hold-off */
    if (S.faults.go || S.mgTripped) {
      S.timers.goAnn += dt;
      if (S.timers.goAnn >= 3) S.alarms["LOW VOLTAGE"] = true;
    } else if (S.mgOn && S.voltage < 380) {
      S.timers.goAnn += dt;
      if (S.timers.goAnn >= 2) S.alarms["LOW VOLTAGE"] = true;
    } else {
      S.timers.goAnn = 0;
      delete S.alarms["LOW VOLTAGE"];
    }

    if (S.faults.gd) {
      S.timers.gd += dt;
      if (S.timers.gd >= 5) S.alarms["GYRO DRIFT"] = true;
    } else {
      S.timers.gd = 0;
      delete S.alarms["GYRO DRIFT"];
    }

    if (S.faults.rs) {
      S.timers.rsAnn += dt;
      if (S.timers.rsAnn >= 4) S.alarms["RANGE SERVO"] = true;
    } else {
      S.timers.rsAnn = 0;
      delete S.alarms["RANGE SERVO"];
    }
  }

  function tick(seconds) {
    if (!(seconds > 0)) return;
    var dt = Math.min(seconds, 4);
    S.t += dt;
    advanceTarget(dt);
    advancePower(dt);
    advanceTracking(dt);
    advanceSolution(dt);
    advanceGunnery(dt);
  }

  /* ---- fixed API ------------------------------------------------------------ */

  function stateSnapshot() {
    return {
      time: S.t,
      powerOn: S.mgOn,
      tripped: S.mgTripped,
      voltage: S.voltage,
      gyroPercent: S.gyro,
      caged: S.caged,
      mode: S.mode,
      targetBearing: S.tgtBrg,
      targetRange: S.tgtRg,
      trackerBearing: S.trkBrg,
      trackerRange: S.trkRg,
      bearingError: S.errAz,
      rangeError: S.errRg,
      trackQuality: S.quality,
      ordersValid: S.valid,
      gunBearing: S.gunBrg,
      quadrantElevation: S.quadElev,
      predictedRange: S.predRg,
      roundsFired: S.rounds,
      barrelHeat: S.heat,
      linerDamaged: S.damageLatch,
      faultsActive: Object.keys(S.faults).filter(function (k) {
        return S.faults[k];
      }),
      alarms: Object.keys(S.alarms),
    };
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "gyro drift") S.faults.gd = true;
    else if (f === "generator overload") S.faults.go = true;
    else if (f === "range transmission failure") S.faults.rs = true;
    if (typeof document !== "undefined") syncTestSwitches();
  }

  function reset() {
    S = freshState();
    syncControlsFromModel();
    render(0);
  }

  window.machine = {
    name: "Halberd Fire Director Mk. IV",
    faults: FAULTS.slice(),
    state: stateSnapshot,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ---- panel wiring ------------------------------------------------------------ */

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  var el = {
    needle: $(".vm-needle"),
    vmMarks: $(".vm-marks"),
    gyroDisc: $(".gyro-disc i"),
    lampGyro: $('[data-lamp="gyroReady"]'),
    lampMatch: $('[data-lamp="matched"]'),
    lampValid: $('[data-lamp="ordersValid"]'),
    mgSwitch: $('[data-control="MOTOR-GENERATOR SWITCH"]'),
    cageSwitch: $('[data-control="GYRO CAGE SWITCH"]'),
    modeSelector: $('[data-control="MODE SELECTOR"]'),
    rsKnob: $("#rsKnob"),
    modeLegs: $$(".rs-leg"),
    wheelAz: $("#wheelAzimuth"),
    wheelRg: $("#wheelRange"),
    readAz: $("#readAzimuth"),
    readRg: $("#readRange"),
    drumBrg: $("#drumBearing"),
    drumEl: $("#drumElevation"),
    drumRg: $("#drumRange"),
    drumRounds: $("#drumRounds"),
    fireKey: $('[data-control="FIRE KEY"]'),
    heatFill: $("#heatFill"),
    interlock: $("#interlockNote"),
    silence: $('[data-control="ALARM SILENCE"]'),
    resetBtn: $("#systemReset"),
    testToggles: {
      gd: $('[data-control="GYRO DRIFT TEST"]'),
      go: $('[data-control="GENERATOR OVERLOAD TEST"]'),
      rs: $('[data-control="RANGE SERVO TEST"]'),
    },
    annWindows: $$(".ann-window"),
    target: document.getElementById("ohTarget"),
    reticle: document.getElementById("ohReticle"),
  };

  /* ---- sound (synthesised, after a gesture only) ------------------------------- */

  var audio = null;
  var buzzerAt = 0;

  function primeAudio() {
    if (audio) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = { ctx: new Ctx() };
    } catch (e) {
      audio = null;
    }
  }

  function relayClick() {
    if (!audio) return;
    var ctx = audio.ctx;
    var b = ctx.createBuffer(1, 900, ctx.sampleRate);
    var d = b.getChannelData(0);
    var i;
    for (i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
    }
    var src = ctx.createBufferSource();
    src.buffer = b;
    var g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(g).connect(ctx.destination);
    src.start();
  }

  function shotThump() {
    if (!audio) return;
    var ctx = audio.ctx;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(90, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.22);
    g.gain.setValueAtTime(0.16, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.26);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
  }

  function buzzer(now) {
    if (!audio || S.silenced) return;
    if (!Object.keys(S.alarms).length) return;
    if (now - buzzerAt < 1.7) return;
    buzzerAt = now;
    try {
      var ctx = audio.ctx;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = "square";
      o.frequency.value = 420;
      g.gain.setValueAtTime(0.028, ctx.currentTime);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + 0.24);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.27);
    } catch (e) {
      /* leave it silent */
    }
  }

  ["pointerdown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, primeAudio, { once: true, capture: true });
  });

  /* ---- control behaviours --------------------------------------------------------- */

  function bindToggle(btn, get, set) {
    btn.addEventListener("click", function () {
      primeAudio();
      set(!get());
      btn.setAttribute("aria-pressed", get() ? "true" : "false");
      relayClick();
      render(0);
    });
  }

  bindToggle(
    el.mgSwitch,
    function () {
      return S.mgOn;
    },
    function (v) {
      S.mgOn = v;
      if (v) S.mgOffTimer = 0;
    },
  );

  bindToggle(
    el.cageSwitch,
    function () {
      return S.caged;
    },
    function (v) {
      S.caged = v;
    },
  );

  Object.keys(el.testToggles).forEach(function (key) {
    var btn = el.testToggles[key];
    btn.addEventListener("click", function () {
      primeAudio();
      if (S.faults[key]) S.faults[key] = false;
      else inject(FAULT_KEYS[key]);
      btn.setAttribute("aria-pressed", S.faults[key] ? "true" : "false");
      relayClick();
      render(0);
    });
  });

  function syncTestSwitches() {
    el.testToggles.gd.setAttribute(
      "aria-pressed",
      S.faults.gd ? "true" : "false",
    );
    el.testToggles.go.setAttribute(
      "aria-pressed",
      S.faults.go ? "true" : "false",
    );
    el.testToggles.rs.setAttribute(
      "aria-pressed",
      S.faults.rs ? "true" : "false",
    );
  }

  /* mode selector */

  var MODE_ANGLE = { off: -42, track: 0, compute: 42 };

  el.modeLegs.forEach(function (leg) {
    leg.addEventListener("click", function () {
      primeAudio();
      setMode(leg.getAttribute("data-mode"));
      relayClick();
    });
  });

  function setMode(mode) {
    S.mode = mode;
    el.modeLegs.forEach(function (l) {
      l.setAttribute(
        "aria-checked",
        l.getAttribute("data-mode") === mode ? "true" : "false",
      );
    });
    if (el.rsKnob)
      el.rsKnob.style.transform = "rotate(" + MODE_ANGLE[mode] + "deg)";
    render(0);
  }

  /* handwheels: drag, mouse wheel, arrows */

  function bindWheel(node, opts) {
    var dragging = false,
      lastX = 0;
    node.addEventListener("pointerdown", function (e) {
      primeAudio();
      dragging = true;
      lastX = e.clientX;
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    node.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      lastX = e.clientX;
      opts.apply(dx * opts.perPx);
      node._rot = (node._rot || 0) + dx * 1.4;
      paintWheel(node);
      render(0);
    });
    function release() {
      dragging = false;
    }
    node.addEventListener("pointerup", release);
    node.addEventListener("pointercancel", release);

    node.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        opts.apply(e.deltaY < 0 ? opts.notch : -opts.notch);
        node._rot = (node._rot || 0) - (e.deltaY < 0 ? 6 : -6);
        paintWheel(node);
        render(0);
      },
      { passive: false },
    );

    node.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? opts.coarse : opts.fine;
      var dir = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") dir = 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") dir = -1;
      else return;
      e.preventDefault();
      opts.apply(dir * step);
      node._rot = (node._rot || 0) + dir * 8;
      paintWheel(node);
      render(0);
    });
  }

  function paintWheel(node) {
    var rotor = node.querySelector(".hw-rotor");
    rotor.style.transform = "rotate(" + (node._rot || 0) + "deg)";
  }

  bindWheel(el.wheelAz, {
    perPx: 0.07,
    notch: 0.5,
    fine: 0.3,
    coarse: 2,
    apply: function (d) {
      S.trkBrg = (S.trkBrg + d + 360) % 360;
    },
  });

  bindWheel(el.wheelRg, {
    perPx: 26,
    notch: 25,
    fine: 25,
    coarse: 150,
    /* a jammed range servo spins the wheel but the counter stays put */
    apply: function (d) {
      if (!S.faults.rs) S.trkRg = clamp(S.trkRg + d, 800, 16000);
    },
  });

  /* fire key and the rest */

  function fire() {
    primeAudio();
    if (S.damageLatch || !S.valid || S.overheatLatch || !S.mgOn) {
      render(0);
      return;
    }
    S.rounds += 1;
    S.heat = clamp(S.heat + 16, 18, 130);
    shotThump();
    el.fireKey.classList.add("fired");
    setTimeout(function () {
      el.fireKey.classList.remove("fired");
    }, 130);
    render(0);
  }

  el.fireKey.addEventListener("click", fire);

  el.silence.addEventListener("click", function () {
    primeAudio();
    S.silenced = true;
    relayClick();
    render(0);
  });

  el.resetBtn.addEventListener("click", function () {
    primeAudio();
    reset();
    relayClick();
  });

  /* ---- painting ---------------------------------------------------------------------- */

  function paintVolts() {
    var a = -62 + (clamp(S.voltage, 0, 500) / 500) * 124;
    el.needle.style.transform = "rotate(" + a + "deg)";
  }

  var gyroAngle = 0;

  function paintGyro(dt) {
    gyroAngle += dt * S.gyro * 22;
    el.gyroDisc.style.transform =
      "translate(-50%, -50%) rotate(" + (gyroAngle % 360).toFixed(1) + "deg)";
  }

  function paintOptics() {
    var dx = clamp(wrap180(S.tgtBrg - S.trkBrg) * 16, -168, 168);
    var up = clamp((S.tgtRg - S.trkRg) * 0.02, -52, 52);
    var sc = clamp(8200 / Math.max(S.tgtRg, 1), 0.55, 1.7);
    var bob = Math.sin(S.t * 1.1) * 1.6;
    var roll = Math.sin(S.t * 0.9) * 1.1;
    el.target.setAttribute(
      "transform",
      "translate(" +
        (170 + dx).toFixed(1) +
        "," +
        (112 - up + bob).toFixed(1) +
        ") scale(" +
        sc.toFixed(2) +
        ") rotate(" +
        roll.toFixed(1) +
        ")",
    );
    el.reticle.setAttribute("transform", "translate(170,104)");
  }

  function paintLamps() {
    el.lampGyro.checked = S.mgOn && S.voltage >= 380 && S.gyro >= 95;
    el.lampMatch.checked = S.matched && S.mode !== "off";
    el.lampValid.checked = S.valid;
  }

  function paintDrums() {
    el.readAz.textContent = fmt(S.trkBrg, 5, 1) + "\u00b0";
    el.readRg.textContent = fmt(S.trkRg, 5, 0);
    if (S.hasSolution) {
      var shown = S.gunBrg < 0 ? S.gunBrg + 360 : S.gunBrg;
      el.drumBrg.textContent = fmt(shown % 360, 5, 1) + "\u00b0";
      el.drumEl.textContent = fmt(S.quadElev, 5, 2) + "\u00b0";
      el.drumRg.textContent = fmt(S.predRg, 5, 0) + " YD";
    } else {
      el.drumBrg.textContent = "---.-\u00b0";
      el.drumEl.textContent = "--.--\u00b0";
      el.drumRg.textContent = "----- YD";
    }
    el.drumRounds.textContent = fmt(S.rounds, 4, 0);

    el.wheelAz.setAttribute("aria-valuenow", S.trkBrg.toFixed(1));
    el.wheelAz.setAttribute(
      "aria-valuetext",
      "tracking bearing " + S.trkBrg.toFixed(1) + " degrees",
    );
    el.wheelRg.setAttribute("aria-valuenow", String(Math.round(S.trkRg)));
    el.wheelRg.setAttribute(
      "aria-valuetext",
      "tracking range " + Math.round(S.trkRg) + " yards",
    );
  }

  function paintGunnery() {
    var pct = (clamp((S.heat - 18) / (120 - 18), 0, 1) * 100).toFixed(1);
    el.heatFill.style.height = pct + "%";
    el.fireKey.classList.toggle(
      "armed",
      S.valid && !S.overheatLatch && !S.damageLatch,
    );

    var note, cls;
    if (S.damageLatch) {
      note = "INTERLOCK: LINER DAMAGED \u2014 ARMOURER ONLY";
      cls = "bad";
    } else if (S.overheatLatch) {
      note = "INTERLOCK: OVERHEAT \u2014 STAND BY TO COOL";
      cls = "bad";
    } else if (S.valid) {
      note = "ORDERS FLOWING \u2014 DRUMS ON THE TARGET";
      cls = "warn";
    } else if (S.mode === "compute") {
      note = "SEARCHING \u2014 KEEP HER MATCHED";
      cls = "";
    } else {
      note = "INTERLOCK: NO ORDER \u2014 DRUMS IDLE";
      cls = "";
    }
    el.interlock.textContent = note;
    el.interlock.className = "interlock-note " + cls;
  }

  function paintAlarms() {
    var any = false;
    el.annWindows.forEach(function (w) {
      var name = w.getAttribute("data-alarm");
      var lit = !!S.alarms[name];
      if (lit && !S.silenced) any = true;
      w.classList.toggle("lit", lit);
      w.classList.toggle("flash", lit && !S.silenced);
    });
    if (!Object.keys(S.alarms).length) S.silenced = false;
    if (any) buzzer(performance.now() / 1000);
  }

  function syncControlsFromModel() {
    el.mgSwitch.setAttribute("aria-pressed", "false");
    el.cageSwitch.setAttribute("aria-pressed", "false");
    syncTestSwitches();
    setMode("off");
  }

  function render(dt) {
    paintVolts();
    paintGyro(dt || 0.0001);
    paintOptics();
    paintLamps();
    paintDrums();
    paintGunnery();
    paintAlarms();
  }

  /* ---- voltmeter tick marks (drawn once) ---------------------------------------------- */

  (function drawVmMarks() {
    var g = el.vmMarks;
    if (!g) return;
    var cx = 60,
      cy = 66,
      rOut = 47,
      rIn = 41,
      rInMajor = 37;
    var html = "";
    for (var v = 0; v <= 500; v += 50) {
      var ang = ((-62 + (v / 500) * 124 - 90) * Math.PI) / 180;
      var cos = Math.cos(ang),
        sin = Math.sin(ang);
      var major = v % 100 === 0;
      var r2 = major ? rInMajor : rIn;
      var red = v <= 350;
      html +=
        '<line x1="' +
        (cx + cos * rOut).toFixed(1) +
        '" y1="' +
        (cy + sin * rOut).toFixed(1) +
        '" x2="' +
        (cx + cos * r2).toFixed(1) +
        '" y2="' +
        (cy + sin * r2).toFixed(1) +
        '"' +
        (red ? ' class="red"' : "") +
        "></line>";
    }
    g.innerHTML = html;
  })();

  /* ---- manual dialog -------------------------------------------------------------------- */

  var manualDialog = $("dialog[data-manual]");

  $$('[data-action="manual"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (manualDialog && typeof manualDialog.showModal === "function")
        manualDialog.showModal();
    });
  });
  $$('[data-action="close-manual"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (manualDialog) manualDialog.close();
    });
  });

  /* ---- main loop -------------------------------------------------------------------------- */

  var last = null;
  var running = false;

  function frame(ts) {
    if (!running) return;
    if (last === null) last = ts;
    var dt = Math.min((ts - last) / 1000, 0.25);
    last = ts;
    if (dt > 0) tick(dt);
    render(dt);
    requestAnimationFrame(frame);
  }

  function startLoop() {
    if (running) return;
    running = true;
    last = null;
    requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopLoop();
    else startLoop();
  });

  /* ---- go ----------------------------------------------------------------------------------- */

  reset();
  startLoop();
})();
