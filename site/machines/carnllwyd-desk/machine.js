/* =====================================================================
   CARN LLWYD OBSERVATORY — DRIVE, DOME & GUIDING DESK No. 2
   Simulation and behaviour. Halswell Optical Engineering Co. Ltd, 1961.

   The plant behind the desk:
     - a synchronous clock drive on a worm and sector, governed;
     - a 28-ft dome with a shutter motor that can be jogged or left to follow;
     - an air bag float system carrying the 36-inch mirror;
     - a photomultiplier integrating towards a 900-second measurement.
   ===================================================================== */
(function () {
  "use strict";

  var MACHINE_NAME = "Carn Llwyd Observatory - Drive, Dome & Guiding Desk";
  var FAULTS = [
    "clock-drive governor hunt",
    "mirror-support air leak",
    "dome shutter drive runaway",
  ];
  var ALARM_ORDER = [
    "TRACKING ERROR",
    "SLIT OFFSET",
    "DOME INTERLOCK",
    "FLOAT LOW",
    "MIRROR SEATED",
  ];
  var MODES = ["OFF", "MAN", "FOLL"];
  var SID_BASE = 2 * 3600 + 14 * 60 + 5; /* sidereal clock at cold start */
  var SID_RATE = 1.00274; /* sidereal seconds per mean second */
  var SKY_DRIFT = 15.2; /* arcsec per second with the drive off */
  var TARGET = 900; /* seconds of good integration */

  /* ---------------- state ---------------- */

  function coldState() {
    return {
      t: 0,
      mains: false,
      clutchWanted: false,
      modeIdx: 0 /* OFF / MAN / FOLL */,
      tripped: false /* dome shutter motor breaker */,
      interlock: false /* latched: slit struck the telescope */,
      runaway: false,
      hunt: false,
      huntStart: 0,
      huntClearAt: -1,
      leak: false,
      wasTracking: false,
      offset: 6.0 /* degrees, slit ahead(+)/behind(-) the axis */,
      errX: 0 /* RA tracking error, arcsec */,
      errY: 0 /* declination wander, arcsec */,
      floatP: 12.0,
      seated: false,
      focusAdj: 0 /* micrometer, um */,
      dark: 100 /* % dark adaptation */,
      white: false,
      integ: 0,
      done: false,
    };
  }

  var st = coldState();

  /* desk-side (non-plant) state */
  var ui = {
    guardOpen: false,
    lampsTest: false,
    soundOn: true,
    audioArmed: false,
    acceptedKey: null,
    nextBell: 0,
    wheelAngle: 0,
    valveSpin: 0,
    heldJogCW: false,
    heldJogCCW: false,
    heldValve: false,
    heldTest: false,
    lastEngaged: false,
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function turbulence(t) {
    return Math.max(
      0.08,
      0.22 +
        0.14 * Math.sin(0.31 * t) +
        0.09 * Math.sin(0.83 * t + 1.7) +
        0.06 * Math.sin(2.17 * t + 0.4),
    );
  }

  function nightTemp(t) {
    return Math.max(3, 7.5 - 0.0017 * t);
  }

  function focusDriftUm(t) {
    return (7.5 - nightTemp(t)) * 260;
  }

  function derived() {
    var engaged = st.mains && st.clutchWanted && !st.interlock;
    var residual = st.focusAdj + focusDriftUm(st.t);
    var img =
      1.05 + turbulence(st.t) + Math.abs(residual) / 150 + (st.seated ? 16 : 0);
    var inField = Math.abs(st.errX) < 25 && Math.abs(st.errY) < 25;
    var darkF = 0.25 + 0.75 * (st.dark / 100);
    var sig =
      88 *
      Math.exp(-Math.max(0, img - 0.55)) *
      (st.seated ? 0.12 : 1) *
      (st.white ? 0.4 : 1) *
      (inField ? 1 : 0);
    sig = clamp(sig * darkF, 0, 100);
    return {
      engaged: engaged,
      residual: residual,
      img: img,
      inField: inField,
      sig: sig,
    };
  }

  function activeAlarms() {
    var a = [];
    if (Math.abs(st.errX) >= 12) a.push("TRACKING ERROR");
    if (Math.abs(st.offset) >= 8) a.push("SLIT OFFSET");
    if (st.interlock) a.push("DOME INTERLOCK");
    if (st.floatP <= 9) a.push("FLOAT LOW");
    if (st.seated) a.push("MIRROR SEATED");
    return a;
  }

  function activeFaults() {
    var f = [];
    if (st.hunt) f.push(FAULTS[0]);
    if (st.leak) f.push(FAULTS[1]);
    if (st.runaway) f.push(FAULTS[2]);
    return f;
  }

  /* ---------------- the plant, advanced deterministically ---------------- */

  function step(h) {
    st.t += h;

    var eng = st.mains && st.clutchWanted && !st.interlock;

    /* clock drive */
    if (eng) {
      st.wasTracking = true;
      var rate = 0.03;
      if (st.hunt) {
        var env = Math.min(1, (st.t - st.huntStart) / 60 + 0.3);
        rate += (0.3 * Math.sin(0.23 * st.t) + 0.36) * env;
      }
      st.errX += rate * h;
      if (st.huntClearAt > 0 && st.t >= st.huntClearAt) {
        st.hunt = false;
        st.huntClearAt = -1;
      }
    } else {
      if (st.wasTracking) st.errX += SKY_DRIFT * h;
      st.huntClearAt = -1;
    }
    st.errX = clamp(st.errX, -60, 60);

    /* guiding corrections (mechanical, work whenever the observer works) */
    st.errX += ui.guideDirEW * 1.4 * h;
    st.errY += ui.guideDirNS * 1.4 * h;
    st.errY += 0.85 * Math.sin(0.037 * st.t) * h;
    st.errX = clamp(st.errX, -60, 60);
    st.errY = clamp(st.errY, -60, 60);

    /* dome */
    if (st.runaway && !st.tripped) {
      st.offset += 0.45 * h;
    } else {
      st.offset += 0.09 * Math.sin(0.013 * st.t) * h;
    }
    if (!st.tripped && st.modeIdx === 1) {
      if (ui.heldJogCW) st.offset += 3.2 * h;
      if (ui.heldJogCCW) st.offset -= 3.2 * h;
    }
    if (!st.tripped && st.modeIdx === 2) {
      var drive = clamp(st.offset, -2.2 * h, 2.2 * h);
      st.offset -= drive;
    }
    st.offset = clamp(st.offset, -25, 25);

    if (!st.interlock && Math.abs(st.offset) > 15 && eng) {
      st.interlock = true;
      st.clutchWanted = false; /* the interlock throws the clutch out */
    }

    /* mirror air float */
    if (ui.heldValve) {
      st.floatP = Math.min(14.5, st.floatP + 0.5 * h);
      if (st.floatP >= 11.6)
        st.leak = false; /* the surge blows the seat clear */
    } else if (st.leak) {
      st.floatP = Math.max(0, st.floatP - 0.075 * h);
    }
    if (st.floatP <= 3.6) st.seated = true;

    /* observer */
    if (st.white) st.dark = Math.max(0, st.dark - 9 * h);
    else st.dark = Math.min(100, st.dark + 0.34 * h);

    /* photometer */
    var d = derived();
    if (d.engaged && d.inField && d.sig >= 12) {
      st.integ = Math.min(9999, st.integ + h * clamp(d.sig / 48, 0, 1.2));
      if (!st.done && st.integ >= TARGET) st.done = true;
    }

    /* relay + hum bookkeeping */
    if (d.engaged !== ui.lastEngaged) {
      relayClack();
      ui.lastEngaged = d.engaged;
    }
  }

  function tick(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s <= 0) return;
    s = Math.min(s, 7200);
    var h = 0.2;
    while (s > 0) {
      var take = Math.min(h, s);
      step(take);
      s -= take;
    }
  }

  function inject(fault) {
    if (typeof fault !== "string") return;
    var name = fault.trim().toLowerCase();
    if (name === FAULTS[0]) {
      st.hunt = true;
      st.huntStart = st.t;
      st.huntClearAt = -1;
    } else if (name === FAULTS[1]) {
      st.leak = true;
    } else if (name === FAULTS[2]) {
      st.runaway = true;
    }
  }

  function reset() {
    st = coldState();
    ui.guardOpen = false;
    ui.lampsTest = false;
    ui.acceptedKey = null;
    ui.nextBell = 0;
    ui.wheelAngle = 0;
    ui.valveSpin = 0;
    ui.heldJogCW = ui.heldJogCCW = ui.heldValve = ui.heldTest = false;
    ui.guideDirEW = 0;
    ui.guideDirNS = 0;
    ui.lastEngaged = false;
    document.body.classList.remove("lit");
    setHum(false);
    syncControlsToState();
  }

  function state() {
    var d = derived();
    var sid = SID_BASE + st.t * SID_RATE;
    var hh = Math.floor(sid / 3600) % 24;
    var mm = Math.floor(sid / 60) % 60;
    var ss = Math.floor(sid) % 60;
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return {
      time: st.t,
      sidereal: pad(hh) + ":" + pad(mm) + ":" + pad(ss),
      mains: st.mains,
      clutchEngaged: d.engaged,
      domeMode: MODES[st.modeIdx],
      slitOffsetDeg: +st.offset.toFixed(2),
      raErrorArcsec: +st.errX.toFixed(2),
      decWanderArcsec: +st.errY.toFixed(2),
      mirrorFloatPsi: +st.floatP.toFixed(2),
      focusResidualUm: +d.residual.toFixed(1),
      imageDiameterArcsec: +d.img.toFixed(2),
      signalUa: +d.sig.toFixed(1),
      darkAdaptationPct: Math.round(st.dark),
      nightAirC: +nightTemp(st.t).toFixed(2),
      integrationSec: Math.round(st.integ),
      integrationTargetSec: TARGET,
      measurementComplete: st.done,
      workingLightOn: st.white,
      faultsActive: activeFaults(),
      alarms: activeAlarms(),
    };
  }

  /* ---------------- sound (after a gesture, only) ---------------- */

  var AC = null,
    master = null,
    humOsc = null,
    humGain = null;

  function armAudio() {
    if (ui.audioArmed) return;
    ui.audioArmed = true;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      AC = new Ctor();
      master = AC.createGain();
      master.gain.value = 0.5;
      master.connect(AC.destination);
      humOsc = AC.createOscillator();
      humOsc.type = "triangle";
      humOsc.frequency.value = 46;
      humGain = AC.createGain();
      humGain.gain.value = 0;
      humOsc.connect(humGain);
      humGain.connect(master);
      humOsc.start();
    } catch (e) {
      AC = null;
    }
  }

  function blip(freq, dur, type, vol, when) {
    if (!AC || !ui.soundOn) return;
    try {
      var o = AC.createOscillator();
      var g = AC.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.08, AC.currentTime + (when || 0));
      g.gain.exponentialRampToValueAtTime(
        0.0001,
        AC.currentTime + (when || 0) + dur,
      );
      o.connect(g);
      g.connect(master);
      o.start(AC.currentTime + (when || 0));
      o.stop(AC.currentTime + (when || 0) + dur + 0.05);
    } catch (e) {
      /* silent */
    }
  }

  function relayClack() {
    if (!AC || !ui.soundOn) return;
    blip(150, 0.05, "square", 0.06);
    blip(2100, 0.02, "square", 0.03, 0.01);
  }

  function keyClick() {
    if (!AC || !ui.soundOn) return;
    blip(1900, 0.015, "square", 0.02);
  }

  function bellRing() {
    if (!AC || !ui.soundOn) return;
    blip(640, 0.55, "sine", 0.09);
    blip(508, 0.7, "sine", 0.08, 0.19);
  }

  function setHum(on) {
    if (!AC || !humGain) return;
    try {
      humGain.gain.setTargetAtTime(
        on && ui.soundOn ? 0.02 : 0,
        AC.currentTime,
        0.2,
      );
    } catch (e) {
      /* silent */
    }
  }

  document.addEventListener("pointerdown", armAudio, { passive: true });
  document.addEventListener("keydown", armAudio);

  /* ---------------- DOM ---------------- */

  function $(id) {
    return document.getElementById(id);
  }

  var el = {
    body: document.body,
    sidClock: $("sidClock"),
    mainsCtl: $("mainsCtl"),
    clutchCtl: $("clutchCtl"),
    raWheel: $("raWheel"),
    raWheelRot: $("raWheelRot"),
    raNeedle: $("raNeedle"),
    raErrOut: $("raErrOut"),
    tempOut: $("tempOut"),
    thermoCol: $("thermoCol"),
    eyeSvg: $("eyeSvg"),
    starGroup: $("starGroup"),
    starCore: $("starCore"),
    starHalo: $("starHalo"),
    fieldStars: $("fieldStars"),
    focusKnob: $("focusKnob"),
    focusOut: $("focusOut"),
    seeingOut: $("seeingOut"),
    sigNeedle: $("sigNeedle"),
    integDrum: $("integDrum"),
    lampDone: $("lampDone"),
    slitNeedle: $("slitNeedle"),
    slitOut: $("slitOut"),
    modeSel: $("modeSel"),
    modePointer: $("modePointer"),
    jogCW: $("jogCW"),
    jogCCW: $("jogCCW"),
    domeBrk: $("domeBrk"),
    floatNeedle: $("floatNeedle"),
    floatOut: $("floatOut"),
    chargeValve: $("chargeValve"),
    valveWheel: $("valveWheel"),
    whiteBtn: $("whiteBtn"),
    soundBtn: $("soundBtn"),
    acceptBtn: $("acceptBtn"),
    lampTestBtn: $("lampTestBtn"),
    resetBtn: $("resetBtn"),
    ftHunt: $("ftHunt"),
    ftLeak: $("ftLeak"),
    ftRun: $("ftRun"),
  };

  var lamps = {
    MAINS: $("lampMains"),
    DRIVE: $("lampDrive"),
    "TRACKING ERROR": $("lampTrack"),
    "SLIT OFFSET": $("lampSlit"),
    "DOME INTERLOCK": $("lampLock"),
    "FLOAT LOW": $("lampFloat"),
    "MIRROR SEATED": $("lampSeat"),
    "WHITE LIGHT": $("lampWhite"),
  };

  /* faint background field stars, laid out once, deterministic */
  (function seedField() {
    var svgns = "http://www.w3.org/2000/svg";
    var pts = [
      [52, 71, 1.1],
      [241, 58, 1.3],
      [88, 250, 1.0],
      [270, 205, 1.4],
      [130, 44, 0.9],
      [37, 176, 1.2],
      [293, 118, 1.0],
      [196, 276, 1.1],
      [222, 300, 0.9],
      [70, 305, 1.0],
      [305, 260, 1.2],
      [24, 116, 0.9],
    ];
    pts.forEach(function (p) {
      var c = document.createElementNS(svgns, "circle");
      c.setAttribute("cx", p[0]);
      c.setAttribute("cy", p[1]);
      c.setAttribute("r", p[2] * 0.9);
      c.setAttribute("class", "field-star");
      c.setAttribute("opacity", "0.55");
      el.fieldStars.appendChild(c);
    });
  })();

  /* ---------------- the handbook ---------------- */

  var dlg = document.getElementById("manualDlg");
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="manual"]'),
    function (b) {
      b.addEventListener("click", function () {
        keyClick();
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    },
  );
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="close-manual"]'),
    function (b) {
      b.addEventListener("click", function () {
        keyClick();
        if (typeof dlg.close === "function") dlg.close();
        else dlg.removeAttribute("open");
      });
    },
  );

  /* ---------------- control wiring ---------------- */

  ui.guideDirEW = 0;
  ui.guideDirNS = 0;

  /* guarded mains breaker: lift guard -> throw ON -> throw OFF -> close guard */
  el.mainsCtl.addEventListener("click", function () {
    keyClick();
    if (!ui.guardOpen) {
      ui.guardOpen = true;
    } else if (!st.mains) {
      st.mains = true;
    } else if (ui.guardOpen) {
      st.mains = false;
      ui.guardOpen = false;
    }
    syncControlsToState();
  });

  el.clutchCtl.addEventListener("click", function () {
    st.clutchWanted = !st.clutchWanted;
    if (st.clutchWanted && st.hunt && st.huntClearAt < 0)
      st.huntClearAt = st.t + 4;
    syncControlsToState();
  });

  /* RA trim handwheel */
  function trimRA(delta) {
    st.errX = clamp(st.errX - delta, -60, 60);
    ui.wheelAngle += delta * 6;
  }
  (function wireWheel() {
    var dragging = false,
      lastX = 0;
    el.raWheel.addEventListener("pointerdown", function (ev) {
      dragging = true;
      lastX = ev.clientX;
      el.raWheel.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    el.raWheel.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var dx = ev.clientX - lastX;
      lastX = ev.clientX;
      trimRA(dx * 0.18);
    });
    ["pointerup", "pointercancel"].forEach(function (n) {
      el.raWheel.addEventListener(n, function () {
        dragging = false;
      });
    });
    el.raWheel.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
        trimRA(-0.7);
        ev.preventDefault();
      }
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
        trimRA(0.7);
        ev.preventDefault();
      }
    });
  })();

  /* focus micrometer */
  function nudgeFocus(delta) {
    st.focusAdj = clamp(st.focusAdj + delta, -900, 900);
  }
  (function wireFocus() {
    var dragging = false,
      lastY = 0;
    el.focusKnob.addEventListener("pointerdown", function (ev) {
      dragging = true;
      lastY = ev.clientY;
      el.focusKnob.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    el.focusKnob.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var dy = ev.clientY - lastY;
      lastY = ev.clientY;
      nudgeFocus(-dy * 5);
    });
    ["pointerup", "pointercancel"].forEach(function (n) {
      el.focusKnob.addEventListener(n, function () {
        dragging = false;
      });
    });
    el.focusKnob.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
        nudgeFocus(-20);
        ev.preventDefault();
      }
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
        nudgeFocus(20);
        ev.preventDefault();
      }
    });
  })();

  /* dome mode selector */
  function setMode(i) {
    st.modeIdx = clamp(i, 0, 2);
    syncControlsToState();
  }
  el.modeSel.addEventListener("click", function () {
    setMode((st.modeIdx + 1) % 3);
    keyClick();
  });
  el.modeSel.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
      setMode(Math.min(2, st.modeIdx + 1));
      ev.preventDefault();
    }
    if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
      setMode(Math.max(0, st.modeIdx - 1));
      ev.preventDefault();
    }
  });

  /* momentary helpers: pointer + held keys */
  function momentary(btn, onDown, onUp) {
    btn.addEventListener("pointerdown", function (ev) {
      btn.setPointerCapture(ev.pointerId);
      btn.classList.add("held");
      onDown();
      ev.preventDefault();
    });
    ["pointerup", "pointercancel"].forEach(function (n) {
      btn.addEventListener(n, function () {
        btn.classList.remove("held");
        onUp();
      });
    });
    btn.addEventListener("keydown", function (ev) {
      if (ev.key === " " || ev.key === "Enter") {
        if (!btn.classList.contains("held")) {
          btn.classList.add("held");
          onDown();
        }
        ev.preventDefault();
      }
    });
    btn.addEventListener("keyup", function (ev) {
      if (ev.key === " " || ev.key === "Enter") {
        btn.classList.remove("held");
        onUp();
      }
    });
    btn.addEventListener("lostpointercapture", function () {
      btn.classList.remove("held");
      onUp();
    });
  }

  momentary(
    el.jogCW,
    function () {
      ui.heldJogCW = true;
    },
    function () {
      ui.heldJogCW = false;
    },
  );
  momentary(
    el.jogCCW,
    function () {
      ui.heldJogCCW = true;
    },
    function () {
      ui.heldJogCCW = false;
    },
  );

  momentary(
    el.chargeValve,
    function () {
      ui.heldValve = true;
    },
    function () {
      ui.heldValve = false;
    },
  );

  momentary(
    el.lampTestBtn,
    function () {
      ui.lampsTest = true;
    },
    function () {
      ui.lampsTest = false;
    },
  );

  /* guiding toggles: press-and-hold, spring return */
  momentary(
    $("guideW"),
    function () {
      ui.guideDirEW = -1;
    },
    function () {
      ui.guideDirEW = 0;
    },
  );
  momentary(
    $("guideE"),
    function () {
      ui.guideDirEW = 1;
    },
    function () {
      ui.guideDirEW = 0;
    },
  );
  momentary(
    $("guideN"),
    function () {
      ui.guideDirNS = -1;
    },
    function () {
      ui.guideDirNS = 0;
    },
  );
  momentary(
    $("guideS"),
    function () {
      ui.guideDirNS = 1;
    },
    function () {
      ui.guideDirNS = 0;
    },
  );

  /* dome breaker / interlock reset */
  el.domeBrk.addEventListener("click", function () {
    keyClick();
    if (st.tripped) st.tripped = false;
    if (st.interlock && Math.abs(st.offset) < 15) st.interlock = false;
    syncControlsToState();
  });

  /* working light + sound cut */
  el.whiteBtn.addEventListener("click", function () {
    st.white = !st.white;
    document.body.classList.toggle("lit", st.white);
    keyClick();
    syncControlsToState();
  });
  el.soundBtn.addEventListener("click", function () {
    ui.soundOn = !ui.soundOn;
    if (!ui.soundOn) setHum(false);
    keyClick();
    syncControlsToState();
  });

  /* alarm accept */
  el.acceptBtn.addEventListener("click", function () {
    keyClick();
    var a = activeAlarms();
    if (a.length) ui.acceptedKey = a.join("|");
    ui.nextBell = performance.now() / 1000 + 2.2;
  });

  /* engineer reset */
  el.resetBtn.addEventListener("click", function () {
    relayClack();
    reset();
  });

  /* fault test switches */
  [
    ["ftHunt", 0],
    ["ftLeak", 1],
    ["ftRun", 2],
  ].forEach(function (pair) {
    $(pair[0]).addEventListener("click", function () {
      keyClick();
      inject(FAULTS[pair[1]]);
    });
  });

  function syncControlsToState() {
    el.mainsCtl.classList.toggle("open", ui.guardOpen);
    el.mainsCtl.classList.toggle("on", st.mains);
    el.mainsCtl.setAttribute("aria-pressed", st.mains ? "true" : "false");

    el.clutchCtl.classList.toggle("on", st.clutchWanted);
    el.clutchCtl.setAttribute(
      "aria-pressed",
      st.clutchWanted ? "true" : "false",
    );

    el.modeSel.setAttribute("aria-value", MODES[st.modeIdx]);

    el.whiteBtn.setAttribute("aria-pressed", st.white ? "true" : "false");
    el.soundBtn.setAttribute("aria-pressed", ui.soundOn ? "false" : "true");
  }

  /* ---------------- rendering ---------------- */

  var fmtSigned = function (v, unit, dp) {
    var s = v >= 0 ? "+" : "\u2212";
    return s + Math.abs(v).toFixed(dp) + unit;
  };

  function render(nowSec) {
    var d = derived();
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };

    /* sidereal clock */
    var sid = SID_BASE + st.t * SID_RATE;
    el.sidClock.innerHTML =
      pad(Math.floor(sid / 3600) % 24) +
      "&thinsp;" +
      pad(Math.floor(sid / 60) % 60) +
      "&thinsp;" +
      pad(Math.floor(sid) % 60);

    /* needles */
    el.raNeedle.setAttribute(
      "transform",
      "rotate(" + ((st.errX / 30) * 58).toFixed(2) + " 110 118)",
    );
    el.slitNeedle.setAttribute(
      "transform",
      "rotate(" + ((st.offset / 20) * 58).toFixed(2) + " 110 118)",
    );
    el.sigNeedle.setAttribute(
      "transform",
      "rotate(" + ((d.sig / 100) * 100 - 50).toFixed(2) + " 110 118)",
    );
    el.floatNeedle.setAttribute(
      "transform",
      "rotate(" + ((st.floatP / 20) * 240 - 120).toFixed(2) + " 85 85)",
    );

    /* readouts */
    el.raErrOut.textContent = fmtSigned(st.errX, "\u2033", 1);
    el.slitOut.textContent = fmtSigned(st.offset, "\u00b0", 1);
    el.floatOut.textContent = st.floatP.toFixed(1);
    el.seeingOut.textContent = d.img.toFixed(1) + "\u2033";
    el.focusOut.textContent = fmtSigned(d.residual, "", 0);
    el.tempOut.textContent = nightTemp(st.t).toFixed(1) + "\u00b0C";
    el.thermoCol.style.height =
      clamp(((nightTemp(st.t) - 2) / 9) * 100, 4, 96) + "%";

    el.integDrum.textContent = (
      "0000" + Math.floor(Math.min(st.integ, 9999))
    ).slice(-4);

    /* handwheel + knob + selector + valve visuals */
    el.raWheelRot.setAttribute(
      "transform",
      "rotate(" + (ui.wheelAngle % 360).toFixed(1) + " 60 60)",
    );
    el.focusKnob.style.setProperty(
      "--rot",
      ((st.focusAdj / 900) * 170).toFixed(1),
    );
    var modeAng = [0, 90, -90][st.modeIdx]; /* OFF up, MAN right, FOLL left */
    el.modePointer.setAttribute("transform", "rotate(" + modeAng + " 60 60)");
    if (ui.heldValve) ui.valveSpin += 9;
    el.valveWheel.setAttribute(
      "transform",
      "rotate(" + (ui.valveSpin % 360).toFixed(1) + " 55 24)",
    );

    /* the star */
    var px = 160 + clamp(st.errX, -27, 27) * 3.1;
    var py = 160 + clamp(st.errY, -27, 27) * 3.1;
    var vis = clamp(d.sig / 55, 0, 1);
    el.starGroup.setAttribute(
      "transform",
      "translate(" + (px - 160).toFixed(1) + " " + (py - 160).toFixed(1) + ")",
    );
    el.starCore.setAttribute(
      "opacity",
      vis > 0.06 ? (0.45 + vis * 0.55).toFixed(2) : "0",
    );
    el.starHalo.setAttribute("opacity", (0.12 + vis * 0.88).toFixed(2));

    /* lamps */
    var alarmSet = {};
    activeAlarms().forEach(function (a) {
      alarmSet[a] = true;
    });
    var steady = {
      MAINS: st.mains,
      DRIVE: d.engaged,
      "WHITE LIGHT": st.white,
    };
    Object.keys(lamps).forEach(function (name) {
      var node = lamps[name];
      node.classList.remove("onred", "ongold", "test");
      if (alarmSet[name]) node.classList.add("onred");
      else if (steady[name]) node.classList.add("ongold");
      if (ui.lampsTest) node.classList.add("test");
    });
    el.lampDone.classList.toggle("ongold", st.done);
    if (ui.lampsTest) el.lampDone.classList.add("test");

    /* measurement drum colour cue */
    el.integDrum.style.color = st.done ? "#ffd9a0" : "";

    /* fault switch caps follow reality */
    var act = activeFaults();
    el.ftHunt.setAttribute(
      "aria-pressed",
      act.indexOf(FAULTS[0]) >= 0 ? "true" : "false",
    );
    el.ftLeak.setAttribute(
      "aria-pressed",
      act.indexOf(FAULTS[1]) >= 0 ? "true" : "false",
    );
    el.ftRun.setAttribute(
      "aria-pressed",
      act.indexOf(FAULTS[2]) >= 0 ? "true" : "false",
    );

    /* alarm bell */
    var a = activeAlarms();
    var key = a.join("|");
    var ringing = a.length > 0 && ui.acceptedKey !== key;
    if (ringing && ui.audioArmed && nowSec >= ui.nextBell) {
      bellRing();
      ui.nextBell = nowSec + 2.4;
    }

    setHum(d.engaged);
  }

  /* ---------------- main loop ---------------- */

  var lastFrame = null;
  var hidden = false;

  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    lastFrame = null;
  });

  function frame(ts) {
    if (lastFrame === null) lastFrame = ts;
    var dt = (ts - lastFrame) / 1000;
    lastFrame = ts;
    if (!hidden) {
      if (dt > 0 && dt < 2) machine.tick(dt);
      render(ts / 1000);
    } else {
      lastFrame = null;
    }
    requestAnimationFrame(frame);
  }

  var machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };
  window.machine = machine;

  reset();
  requestAnimationFrame(frame);
})();
