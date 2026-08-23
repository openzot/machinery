/*
 * Hawthorne Grand Theatre — Dimmer Board No. 1
 * Peel & Vanner Ltd., Hackney, 1948. Serial 1948-HG-117.
 *
 * Six tungsten circuits through two cast-iron resistance-dimmer cages.
 * The simulation couples: supply voltage (sagging with load), board
 * current, per-circuit filament volts, lamp brightness, and cage
 * temperature (resistance dimmers dissipate hardest at mid position).
 * Faults: scenery resting on cage B (overheat), scene-dock kettles on
 * the supply (overload trip), an open filament in the tabs circuit.
 */
(function () {
  "use strict";

  var NAME = "Hawthorne Grand Theatre Dimmer Board No. 1";
  var FAULTS = [
    "dimmer bank overheat",
    "mains overload trip",
    "stage circuit failure",
  ];

  var AMBIENT = 18;
  var RATED_AMPS = 8.33; // per circuit at 240 V
  var BREAKER_LIMIT = 80; // amperes
  var TRIP_TEMP = 150;
  var ALARM_TEMP = 120;
  var RESTORE_TEMP = 95;

  // ---------------------------------------------------------------- state

  var S;

  function cold() {
    S = {
      selector: 0, // 0 off · 1 mains · 2 aux plant
      breakerClosed: false,
      breakerTripped: false,
      overloadLatched: false,
      overloadAccum: 0,
      gm: 0,
      dim: [0, 0, 0, 0, 0, 0],
      temps: { A: AMBIENT, B: AMBIENT },
      bankTripped: { A: false, B: false },
      sceneryOnCage: false,
      dockKettles: false,
      filamentOpen: false,
      spareFeed: false,
      workingLight: false,
      lampTestUntil: 0,
    };
  }
  cold();

  // ------------------------------------------------------------ physics

  var out = {
    volts: 0,
    amps: 0,
    bright: [0, 0, 0, 0, 0, 0],
    cvolts: [0, 0, 0, 0, 0, 0],
    alarms: [],
  };

  function bankOf(i) {
    return i < 3 ? "A" : "B";
  }

  function compute(dt, integrate) {
    var vBase = S.selector === 1 ? 240 : S.selector === 2 ? 212 : 0;
    var sagK = S.selector === 2 ? 0.34 : 0.16;
    var live =
      S.breakerClosed && !S.breakerTripped && S.selector > 0 && vBase > 0;

    var i, v, frac;
    var amps = 0;

    // first pass with nominal voltage
    var guessV = live ? vBase : 0;
    var total = phantomAmps();
    for (i = 0; i < 6; i++) {
      v = circuitVolts(i, guessV);
      total += rated(i) * Math.pow(v / 240, 0.62);
    }
    if (S.workingLight && live) total += 0.5;

    // second pass with sagged voltage
    var volts = live ? Math.max(0, vBase - sagK * total) : 0;
    var diss = { A: 0, B: 0 };
    for (i = 0; i < 6; i++) {
      v = circuitVolts(i, volts);
      out.cvolts[i] = v;
      var ic = rated(i) * Math.pow(v / 240, 0.62);
      amps += ic;
      out.bright[i] = Math.min(1, Math.pow(v / 240, 3.2));
      diss[bankOf(i)] += ic * Math.max(0, volts - v);
    }

    out.volts = volts;
    out.amps = amps + total + (S.workingLight && live ? 0.5 : 0);

    if (integrate) {
      // cage temperatures: dissipation in, convection out, plus whatever
      // the scenery is cooking
      var cool = 0.032;
      var extB = S.sceneryOnCage ? 5.5 : 0;
      var dA = diss.A / 920 - cool * (S.temps.A - AMBIENT);
      var dB = diss.B / 920 + extB - cool * (S.temps.B - AMBIENT);
      S.temps.A = clamp(S.temps.A + dA * dt, AMBIENT - 0.01, 420);
      S.temps.B = clamp(S.temps.B + dB * dt, AMBIENT - 0.01, 420);

      if (S.temps.A >= TRIP_TEMP && !S.bankTripped.A) S.bankTripped.A = true;
      if (S.temps.B >= TRIP_TEMP && !S.bankTripped.B) S.bankTripped.B = true;

      // thermal image of the breaker
      var over = out.amps - BREAKER_LIMIT;
      if (over > 0) {
        S.overloadAccum = Math.min(1.2, S.overloadAccum + (over / 300) * dt);
      } else {
        S.overloadAccum = Math.max(0, S.overloadAccum - 0.02 * dt);
      }
      if (S.overloadAccum >= 0.5) {
        S.breakerTripped = true;
        S.overloadLatched = true;
      }
      if (!S.breakerTripped && S.overloadAccum < 0.1) S.overloadLatched = false;
    }

    // alarms
    var list = [];
    if (
      S.temps.A > ALARM_TEMP ||
      S.temps.B > ALARM_TEMP ||
      S.bankTripped.A ||
      S.bankTripped.B
    ) {
      list.push("dimmer bank overheat");
    }
    if (S.overloadAccum >= 0.12 || S.overloadLatched || S.breakerTripped) {
      list.push("mains overload trip");
    }
    if (S.filamentOpen && !S.spareFeed) {
      list.push("stage circuit failure");
    }
    out.alarms = list;
  }

  function phantomAmps() {
    return S.dockKettles ? 96 : 0;
  }

  function rated(i) {
    return RATED_AMPS;
  }

  function circuitVolts(i, volts) {
    if (volts <= 0) return 0;
    if (S.bankTripped[bankOf(i)]) return 0;
    var filamentOk = true;
    if (i === 3 && S.filamentOpen && !S.spareFeed) filamentOk = false;
    if (!filamentOk) return 0;
    var wireLoss = i === 3 && S.spareFeed ? 0.94 : 1;
    return volts * (S.gm / 10) * (S.dim[i] / 10) * wireLoss;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ---------------------------------------------------------------- API

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),

    state: function () {
      return {
        alarms: out.alarms.slice(),
        volts: round(out.volts),
        amps: round(out.amps),
        selector: ["off", "mains", "aux"][S.selector],
        breaker: S.breakerTripped
          ? "tripped"
          : S.breakerClosed
            ? "closed"
            : "open",
        grandmaster: round(S.gm, 2),
        dimmers: S.dim.map(function (d) {
          return round(d, 2);
        }),
        brightness: out.bright.map(function (b) {
          return round(b, 4);
        }),
        circuitVolts: out.cvolts.map(function (v) {
          return round(v, 1);
        }),
        bankTemps: { A: round(S.temps.A, 1), B: round(S.temps.B, 1) },
        bankTripped: { A: !!S.bankTripped.A, B: !!S.bankTripped.B },
        spareFeed: S.spareFeed ? "spare" : "normal",
        workingLight: !!S.workingLight,
        testFaults: {
          sceneryOnCage: !!S.sceneryOnCage,
          dockKettles: !!S.dockKettles,
          tabsFilamentOpen: !!S.filamentOpen,
        },
      };
    },

    tick: function (seconds) {
      var dt = Number(seconds);
      if (!isFinite(dt) || dt <= 0) {
        compute(0, false);
        return;
      }
      dt = Math.min(dt, 2);
      compute(dt, true);
    },

    inject: function (fault) {
      switch (String(fault).toLowerCase()) {
        case "dimmer bank overheat":
          S.sceneryOnCage = true;
          break;
        case "mains overload trip":
          S.dockKettles = true;
          break;
        case "stage circuit failure":
          S.filamentOpen = true;
          break;
        default:
          throw new Error("unknown fault: " + fault);
      }
      syncTestSwitches();
      compute(0, false);
    },

    reset: function () {
      cold();
      syncControls();
      compute(0, false);
    },
  };

  function round(v, p) {
    var f = Math.pow(10, p == null ? 1 : p);
    return Math.round(v * f) / f;
  }

  // ------------------------------------------------------------- helpers

  function $(sel) {
    return document.querySelector(sel);
  }
  function $all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  // --------------------------------------------------------------- DOM

  var knobs = {
    supply: $("#supply-knob"),
    breaker: $("#mains-breaker"),
    gmSlot: $("#grandmaster"),
    gmHandle: $("#gm-handle"),
    thermalReset: $("#thermal-reset"),
    spare: $("#spare-feed"),
    work: $("#working-light"),
    lampsTest: $("#lamps-test"),
    ack: $("#alarm-ack"),
    flap: $("#flap-toggle"),
    well: $("#flap-well"),
    ftOverheat: $("#ft-overheat"),
    ftOverload: $("#ft-overload"),
    ftCircuit: $("#ft-circuit"),
  };

  var slots = {};
  $all(".slot").forEach(function (el) {
    slots[el.getAttribute("data-dimmer")] = el;
  });

  var SELECTOR_ANGLES = [-52, 0, 52];
  var SELECTOR_WORDS = ["OFF", "MAINS", "AUX PLANT"];

  var unacked = {};
  var prevAlarms = [];

  // meter tick marks (visual only)
  function buildTicks(group, count) {
    if (!group) return;
    var svgNS = "http://www.w3.org/2000/svg";
    var cx = 60,
      cy = 70,
      r1 = 46,
      r2 = 51;
    for (var i = 0; i <= count; i++) {
      var a = (-60 + (120 * i) / count) * (Math.PI / 180);
      var sin = Math.sin(a),
        cos = -Math.cos(a);
      var line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", cx + r1 * sin);
      line.setAttribute("y1", cy + r1 * cos);
      line.setAttribute("x2", cx + r2 * sin);
      line.setAttribute("y2", cy + r2 * cos);
      group.appendChild(line);
    }
  }
  buildTicks($('[data-meter="volts-ticks"]'), 6);
  buildTicks($('[data-meter="amps-ticks"]'), 10);

  // engraved numerals on the grandmaster scale (visual only)
  (function () {
    for (var n = 0; n <= 10; n++) {
      var s = document.createElement("span");
      s.className = "gm-num";
      s.textContent = String(n);
      s.style.left = 6 + n * 8.8 + "%";
      knobs.gmSlot.appendChild(s);
    }
  })();

  function setDim(i, v) {
    S.dim[i] = clamp(Math.round(v), 0, 10);
    var el = slots[String(i + 1)];
    if (el) {
      el.setAttribute("aria-valuenow", String(S.dim[i]));
      var h = el.querySelector(".handle");
      if (h) h.style.bottom = (S.dim[i] / 10) * 86 + "%";
    }
    compute(0, false);
  }

  function setGm(v) {
    S.gm = clamp(Math.round(v * 2) / 2, 0, 10);
    knobs.gmSlot.setAttribute("aria-valuenow", String(S.gm));
    knobs.gmHandle.style.left = 6 + (S.gm / 10) * 88 + "%";
    compute(0, false);
  }

  function render() {
    // jewels
    var test = performance.now() < S.lampTestUntil;
    var mainsOn = out.volts > 30;
    jewel("mains", test || mainsOn);
    jewel(
      "overload",
      test || out.alarms.indexOf("mains overload trip") >= 0,
      "mains overload trip",
    );
    jewel(
      "overheat",
      test || out.alarms.indexOf("dimmer bank overheat") >= 0,
      "dimmer bank overheat",
    );
    jewel(
      "circuit",
      test || out.alarms.indexOf("stage circuit failure") >= 0,
      "stage circuit failure",
    );

    // meters
    needle("volts-needle", (out.volts / 260) * 120 - 60);
    needle("amps-needle", (out.amps / 100) * 120 - 60);

    // thermometers
    thermo("A", S.temps.A, S.bankTripped.A);
    thermo("B", S.temps.B, S.bankTripped.B);

    // stage mimic
    mimicSet("batten-l", out.bright[0]);
    mimicSet("batten-r", out.bright[1]);
    var cyc = $('[data-mimic="cyc"]');
    if (cyc) cyc.style.opacity = 0.02 + out.bright[2] * 0.93;
    tabSet("tab-l", out.bright[3]);
    tabSet("tab-r", out.bright[3]);
    mimicSet("footlights", out.bright[4]);
    mimicSet("gods", out.bright[5]);
    var house = $('[data-mimic="house"]');
    if (house) house.style.opacity = mainsOn ? 1 : 0.12;

    // pilots
    for (var i = 1; i <= 6; i++) {
      var p = $('[data-pilot="' + i + '"]');
      if (!p) continue;
      var b = out.bright[i - 1];
      p.classList.toggle("lit", test || b > 0.02);
      p.classList.toggle("fail", i === 4 && S.filamentOpen && !S.spareFeed);
    }

    document.documentElement.style.setProperty("--wl", S.workingLight ? 1 : 0);

    var lamp = $("[data-flap-lamp]");
    if (lamp)
      lamp.classList.toggle(
        "on",
        S.sceneryOnCage || S.dockKettles || S.filamentOpen,
      );
  }

  function jewel(name, lit, alarmKey) {
    var el = $('[data-jewel="' + name + '"]');
    if (!el) return;
    el.classList.toggle("lit", !!lit);
    if (alarmKey) {
      if (lit && prevAlarms.indexOf(alarmKey) < 0) unacked[alarmKey] = true;
      el.classList.toggle("fresh", !!unacked[alarmKey]);
    }
  }

  function needle(name, deg) {
    var el = $('[data-meter="' + name + '"]');
    if (el) el.style.transform = "rotate(" + clamp(deg, -62, 62) + "deg)";
  }

  function thermo(bank, temp, tripped) {
    var el = $('[data-thermo="' + bank + '"]');
    if (!el) return;
    el.style.height =
      clamp(((temp - AMBIENT) / (TRIP_TEMP + 10 - AMBIENT)) * 100, 0, 100) +
      "%";
    el.parentNode.classList.toggle("trip", !!tripped);
  }

  function mimicSet(key, b) {
    var g = $('[data-mimic="' + key + '"]');
    if (!g) return;
    Array.prototype.forEach.call(g.querySelectorAll("circle"), function (c) {
      c.style.opacity = 0.07 + b * 0.93;
      c.style.filter =
        b > 0.05
          ? "drop-shadow(0 0 4px rgba(255,217,143," + b * 0.9 + "))"
          : "";
    });
    Array.prototype.forEach.call(
      g.querySelectorAll("[data-glow]"),
      function () {},
    );
  }

  function tabSet(key, b) {
    var el = $('[data-mimic="' + key + '"]');
    if (el)
      el.style.filter =
        "brightness(" +
        (0.32 + b * 1.55) +
        ") saturate(" +
        (0.75 + b * 0.5) +
        ")";
  }

  // --------------------------------------------------------- interactions

  function sliderDrag(el, onValue, vertical) {
    var active = false;
    function val(e) {
      var r = el.getBoundingClientRect();
      var t;
      if (vertical) {
        t = (r.bottom - e.clientY) / r.height;
      } else {
        t = (e.clientX - r.left) / r.width;
      }
      onValue(clamp(t, 0, 1));
    }
    el.addEventListener("pointerdown", function (e) {
      active = true;
      if (el.setPointerCapture) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {}
      }
      val(e);
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (active) val(e);
    });
    el.addEventListener("pointerup", function () {
      active = false;
    });
    el.addEventListener("pointercancel", function () {
      active = false;
    });
  }

  Object.keys(slots).forEach(function (k) {
    var el = slots[k];
    var idx = parseInt(k, 10) - 1;
    sliderDrag(
      el,
      function (t) {
        setDim(idx, Math.round(t * 10));
      },
      true,
    );
    el.addEventListener("keydown", function (e) {
      var v = S.dim[idx];
      if (e.key === "ArrowUp" || e.key === "ArrowRight") setDim(idx, v + 1);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft")
        setDim(idx, v - 1);
      else if (e.key === "Home") setDim(idx, 0);
      else if (e.key === "End") setDim(idx, 10);
      else return;
      e.preventDefault();
    });
  });

  sliderDrag(
    knobs.gmSlot,
    function (t) {
      setGm(t * 10);
    },
    false,
  );
  knobs.gmSlot.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") setGm(S.gm + 0.5);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") setGm(S.gm - 0.5);
    else if (e.key === "Home") setGm(0);
    else if (e.key === "End") setGm(10);
    else return;
    e.preventDefault();
  });

  knobs.supply.addEventListener("click", function () {
    S.selector = (S.selector + 1) % 3;
    syncSelector();
    compute(0, false);
  });
  knobs.supply.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowUp")
      S.selector = Math.min(2, S.selector + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
      S.selector = Math.max(0, S.selector - 1);
    else return;
    e.preventDefault();
    syncSelector();
    compute(0, false);
  });

  knobs.breaker.addEventListener("click", function () {
    if (S.breakerTripped) {
      S.breakerTripped = false;
      S.overloadLatched = false;
      S.overloadAccum = 0;
    } else {
      S.breakerClosed = !S.breakerClosed;
    }
    syncBreaker();
    compute(0, false);
  });

  knobs.thermalReset.addEventListener("click", function () {
    if (
      (S.bankTripped.A || S.bankTripped.B) &&
      S.temps.A < RESTORE_TEMP &&
      S.temps.B < RESTORE_TEMP
    ) {
      S.bankTripped.A = false;
      S.bankTripped.B = false;
      compute(0, false);
    } else {
      flashDisabled(knobs.thermalReset);
    }
  });

  knobs.spare.addEventListener("click", function () {
    S.spareFeed = !S.spareFeed;
    knobs.spare.setAttribute("aria-checked", String(S.spareFeed));
    compute(0, false);
  });

  knobs.work.addEventListener("click", function () {
    S.workingLight = !S.workingLight;
    knobs.work.setAttribute("aria-checked", String(S.workingLight));
    compute(0, false);
  });

  knobs.lampsTest.addEventListener("click", function () {
    S.lampTestUntil = performance.now() + 1600;
  });

  knobs.ack.addEventListener("click", function () {
    unacked = {};
    $all(".jewel.fresh").forEach(function (j) {
      j.classList.remove("fresh");
    });
  });

  knobs.flap.addEventListener("click", function () {
    var open = knobs.well.hidden;
    knobs.well.hidden = !open;
    knobs.flap.setAttribute("aria-expanded", String(open));
  });

  knobs.ftOverheat.addEventListener("change", function () {
    S.sceneryOnCage = knobs.ftOverheat.checked;
    compute(0, false);
  });
  knobs.ftOverload.addEventListener("change", function () {
    S.dockKettles = knobs.ftOverload.checked;
    compute(0, false);
  });
  knobs.ftCircuit.addEventListener("change", function () {
    S.filamentOpen = knobs.ftCircuit.checked;
    compute(0, false);
  });

  function flashDisabled(btn) {
    btn.classList.add("refused");
    setTimeout(function () {
      btn.classList.remove("refused");
    }, 350);
  }

  function syncSelector() {
    knobs.supply.style.transform =
      "rotate(" + SELECTOR_ANGLES[S.selector] + "deg)";
    knobs.supply.setAttribute(
      "aria-label",
      "SUPPLY SELECTOR, rotary: OFF, MAINS or AUX PLANT — now on " +
        SELECTOR_WORDS[S.selector],
    );
  }

  function syncBreaker() {
    knobs.breaker.setAttribute(
      "aria-checked",
      String(S.breakerClosed && !S.breakerTripped),
    );
    knobs.breaker.classList.toggle("tripped", S.breakerTripped);
  }

  function syncTestSwitches() {
    knobs.ftOverheat.checked = !!S.sceneryOnCage;
    knobs.ftOverload.checked = !!S.dockKettles;
    knobs.ftCircuit.checked = !!S.filamentOpen;
  }

  function syncControls() {
    syncSelector();
    syncBreaker();
    syncTestSwitches();
    knobs.spare.setAttribute("aria-checked", "false");
    knobs.work.setAttribute("aria-checked", "false");
    knobs.well.hidden = true;
    knobs.flap.setAttribute("aria-expanded", "false");
    for (var i = 0; i < 6; i++) setDim(i, 0);
    setGm(0);
  }

  // ---------------------------------------------------------------- loop

  var lastFrame = null;
  var rafId = null;

  function frame(now) {
    if (lastFrame != null) {
      var dt = Math.min((now - lastFrame) / 1000, 0.25);
      window.machine.tick(dt);
    }
    lastFrame = now;
    render();
    rafId = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
    } else {
      lastFrame = null;
      if (rafId == null) rafId = requestAnimationFrame(frame);
    }
  });

  // manual dialog
  var dlg = $("#manual-dialog");
  $all('[data-action="manual"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (dlg && typeof dlg.showModal === "function") dlg.showModal();
    });
  });
  $all('[data-action="close-manual"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (dlg) dlg.close();
    });
  });

  // go
  syncControls();
  compute(0, false);
  render();
  rafId = requestAnimationFrame(frame);
})();
