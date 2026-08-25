/* =====================================================================
   Thurlby Fields Aerodrome — Ground-Lighting Regulator Mk. 2 (1974)
   Four thyristor constant-current regulators, a hooded tungsten mimic,
   a standby alternator, and the alarms that come of neglecting them.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------- constants */

  var CHANNELS = ["approach", "threshold", "edge", "papi"];
  var STEP_PCT = [0, 48, 64, 77, 89, 100]; // five intensity steps of 6.6 A
  var FULL_CURRENT = 6.6;
  var SEGMENTS = [
    { name: "BYPASS A", from: 0, to: 3 },
    { name: "BYPASS B", from: 4, to: 7 },
    { name: "BYPASS C", from: 8, to: 10 },
    { name: "BYPASS D", from: 11, to: 13 },
  ];
  var BARRETTES = 14; // approach centreline barrette groups, five lamps each

  var ALARM_DEFS = [
    "LAMP FAILURE",
    "EARTH FAULT",
    "OVERTEMP",
    "REGULATOR TRIP",
    "COOLING AIR",
    "STANDBY SUPPLY",
    "LOW VOLTAGE",
  ];

  var TEMP_WARN = 95;
  var TEMP_TRIP = 105;
  var TEMP_RECLOSE = 88;
  var VOLT_LOW = 208;

  /* ------------------------------------------------------------ helpers */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* --------------------------------------------------------------- state */

  var rnd = mulberry32(0x74f1e2d);

  function freshChannel(lamps) {
    return {
      step: 0,
      crashFrom: 0,
      current: 0,
      temp: 21,
      lampsTotal: lamps,
      agedOut: [], // individually dead lamps (open isolation transformer)
      groupsOut: [], // approach only: whole dead barrette groups
      tripped: false,
      lowVoltTimer: 0,
    };
  }

  var S = coldState();

  function coldState() {
    rnd = mulberry32(0x74f1e2d);
    return {
      t: 0,
      mainsOk: true,
      gensetRunning: false,
      outageClock: 0,
      volts: 240,
      blowers: false,
      blowerAirflow: true,
      crash: false,
      isolator: 0, // 0 = NORMAL, 1..4 = BYPASS A..D
      earthSegment: -1, // index of the segment holding damaged barrettes
      scrWeldedChan: "",
      channels: {
        approach: freshChannel(BARRETTES * 5),
        threshold: freshChannel(10),
        edge: freshChannel(30),
        papi: freshChannel(4),
      },
      glide: 3.0,
      insulation: 999,
      alarms: {},
      lampTestUntil: 0,
      insulTestUntil: 0,
      nextBarretteSeg: 1,
    };
  }

  /* --------------------------------------------------------- simulation */

  function stepPct(ch) {
    return STEP_PCT[ch.step];
  }

  function totalDemand() {
    var sum = 0;
    CHANNELS.forEach(function (k) {
      sum += S.channels[k].current;
    });
    return sum;
  }

  function busTarget() {
    if (!S.mainsOk && !S.gensetRunning) return 0;
    if (S.mainsOk) return 240;
    // the 40 kVA alternator sags under heavy demand
    var overload = clamp((totalDemand() - 16) / 9, 0, 1);
    return 236 - overload * 46;
  }

  function currentTarget(ch) {
    if (ch.tripped || ch.step === 0 || S.volts < 40) return 0;
    var vf = clamp(S.volts / 238, 0, 1.02);
    if (S.volts < 206)
      vf *= clamp(((S.volts - 165) / 41) * 0.45 + 0.55, 0.55, 1);
    var bypassed = S.isolator === S.earthSegment + 1;
    var earthLeak =
      ch === S.channels.approach && S.earthSegment >= 0 && !bypassed ? 0.86 : 1;
    return (stepPct(ch) / 100) * FULL_CURRENT * vf * earthLeak;
  }

  function tick(seconds) {
    var dt = clamp(seconds, 0, 5);
    if (dt <= 0) return;
    var remaining = dt;
    while (remaining > 0) {
      var h = Math.min(remaining, 0.5);
      integrate(h);
      remaining -= h;
    }
    S.t += dt;
  }

  function integrate(h) {
    /* --- supply ------------------------------------------------------ */
    if (!S.mainsOk) {
      S.outageClock += h;
      if (!S.gensetRunning && S.outageClock > 2.2) S.gensetRunning = true;
    } else {
      S.outageClock = 0;
      S.gensetRunning = false;
    }
    var vt = busTarget();
    var tauV = S.gensetRunning && S.outageClock < 4 ? 1.4 : 0.45;
    S.volts += (vt - S.volts) * (1 - Math.exp(-h / tauV));
    if (S.volts > 25) S.volts += (rnd() - 0.5) * 0.6;
    S.volts = clamp(S.volts, 0, 255);

    if (!S.mainsOk) raiseAlarm("STANDBY SUPPLY");
    if (S.volts < VOLT_LOW && S.volts > 20) raiseAlarm("LOW VOLTAGE");
    if (S.volts >= VOLT_LOW + 4 || S.volts <= 20) clearAlarm("LOW VOLTAGE");

    /* --- regulators ---------------------------------------------------- */
    var airNeeded = false;
    CHANNELS.forEach(function (k) {
      var ch = S.channels[k];
      var tgt = currentTarget(ch);
      ch.current += (tgt - ch.current) * (1 - Math.exp(-h / 0.3));
      if (Math.abs(tgt - ch.current) < 0.004) ch.current = tgt;

      /* thermal: I²R heating, blower cooling */
      var frac = ch.current / FULL_CURRENT;
      // a welded thyristor cooks the stack whenever the regulator is in,
      // tripped or not — only the contactor opening stops the fire
      var welded = S.scrWeldedChan === k && !ch.tripped;

      var air = S.blowers && S.blowerAirflow;

      var heat = frac * frac * 88 * (air ? 0.42 : 1);

      var equilibrium = 21 + heat + (welded ? 149 : 0);
      var tauT = welded ? 52 : air ? 95 : 150;
      ch.temp += (equilibrium - ch.temp) * (1 - Math.exp(-h / tauT));
      ch.temp = clamp(ch.temp, 19, 160);

      if (ch.temp >= TEMP_WARN) raiseAlarm("OVERTEMP");

      if (!ch.tripped && ch.temp >= TEMP_TRIP) {
        ch.tripped = true;
        raiseAlarm("REGULATOR TRIP");
        sound.relay();
      }

      if (frac > 0.55 && !air) {
        airNeeded = true;
        raiseAlarm("COOLING AIR");
      }

      /* lamp ageing above step 3 */
      if (
        ch.step >= 4 &&
        !ch.tripped &&
        k !== "papi" &&
        ch.agedOut.length < Math.floor(ch.lampsTotal * 0.25) &&
        rnd() < h * 0.00003 * ch.step * ch.step * ch.step * frac
      ) {
        ageOneLamp(ch);
      }

      ch.lowVoltTimer =
        S.volts < VOLT_LOW && S.volts > 20 && ch.current > 2
          ? ch.lowVoltTimer + h
          : 0;
    });

    if (!airNeeded) clearAlarm("COOLING AIR");

    /* sustained low voltage on standby sheds the biggest circuit */
    var worst = CHANNELS.reduce(function (a, b) {
      return S.channels[a].step >= S.channels[b].step ? a : b;
    });
    var wch = S.channels[worst];
    if (wch.lowVoltTimer > 12 && wch.step > 0 && !wch.tripped) {
      wch.tripped = true;
      raiseAlarm("REGULATOR TRIP");
      sound.relay();
    }

    /* --- approach loop earth fault ------------------------------------- */
    var bypassed = S.isolator === S.earthSegment + 1 && S.earthSegment >= 0;
    if (S.earthSegment >= 0) {
      if (bypassed) {
        clearAlarm("EARTH FAULT");
        S.insulation = 999;
      } else {
        raiseAlarm("EARTH FAULT");
        S.insulation = 8;
      }
    } else {
      S.insulation = 999;
    }

    if (countAged() > 0 || S.channels.approach.groupsOut.length > 0) {
      raiseAlarm("LAMP FAILURE");
    } else if (S.earthSegment < 0) {
      clearAlarm("LAMP FAILURE");
    }

    /* --- PAPI glide wander ---------------------------------------------- */
    S.glide +=
      (3.0 - S.glide) * (1 - Math.exp(-h / 40)) + (rnd() - 0.5) * h * 0.06;
    S.glide = clamp(S.glide, 2.4, 3.7);
  }

  function ageOneLamp(ch) {
    var idx;
    do {
      idx = Math.floor(rnd() * ch.lampsTotal);
    } while (ch.agedOut.indexOf(idx) !== -1);
    ch.agedOut.push(idx);
  }

  function countAged() {
    return (
      S.channels.approach.agedOut.length +
      S.channels.threshold.agedOut.length +
      S.channels.edge.agedOut.length
    );
  }

  /* ------------------------------------------------------------- alarms */

  function raiseAlarm(name) {
    if (!S.alarms[name]) {
      S.alarms[name] = "new";
      sound.horn();
    }
  }

  function clearAlarm(name) {
    delete S.alarms[name];
  }

  function activeAlarms() {
    return ALARM_DEFS.filter(function (n) {
      return !!S.alarms[n];
    });
  }

  /* -------------------------------------------------------------- faults */

  var FAULTS = [
    "approach barrette failure",
    "regulator overheat",
    "mains supply failure",
  ];

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === FAULTS[0]) {
      // two adjacent barrettes fail inside one bypass segment
      var seg = S.nextBarretteSeg % 4;
      S.nextBarretteSeg++;
      var def = SEGMENTS[seg];
      var span = def.to - def.from + 1;
      var mid = def.from + Math.floor(span / 2);
      var other = mid + 1 <= def.to ? mid + 1 : mid - 1;
      S.channels.approach.groupsOut = [
        Math.min(mid, other),
        Math.max(mid, other),
      ];
      S.earthSegment = seg;
      raiseAlarm("EARTH FAULT");
      raiseAlarm("LAMP FAILURE");
    } else if (f === FAULTS[1]) {
      S.scrWeldedChan = "edge";
    } else if (f === FAULTS[2]) {
      S.mainsOk = false;
      S.outageClock = 0;
    } else {
      throw new Error("unknown fault: " + fault);
    }
  }

  /* -------------------------------------------------------------- reset */

  function reset() {
    S = coldState();
    sound.stopHum();
  }

  /* ---------------------------------------------------------- public API */

  window.machine = {
    name: "Thurlby Fields GLR Mk. 2",
    faults: FAULTS.slice(),
    state: function () {
      var chans = {};
      CHANNELS.forEach(function (k) {
        var c = S.channels[k];
        chans[k] = {
          step: c.step,
          current: Math.round(c.current * 1000) / 1000,
          percent: stepPct(c),
          temp: Math.round(c.temp * 10) / 10,
          lampsOut:
            k === "approach"
              ? c.groupsOut.length * 5 + c.agedOut.length
              : c.agedOut.length,
          tripped: c.tripped,
        };
      });
      return {
        t: Math.round(S.t * 100) / 100,
        supply: S.mainsOk ? "mains" : S.gensetRunning ? "standby" : "dead",
        volts: Math.round(S.volts * 10) / 10,
        blowers: S.blowers && S.blowerAirflow,
        crash: S.crash,
        isolator: S.isolator === 0 ? "NORMAL" : SEGMENTS[S.isolator - 1].name,
        insulationKohm: S.insulation,
        glideAngle: Math.round(S.glide * 100) / 100,
        channels: chans,
        alarms: activeAlarms(),
      };
    },
    tick: tick,
    inject: inject,
    reset: reset,
  };

  var machine = window.machine;

  /* ======================================================================
     Panel rendering and control wiring
     ====================================================================== */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* --------------------------------------------------------------- sound */

  var sound = (function () {
    var ctx = null;
    var humOsc = null;
    var humGain = null;
    var allowed = false;

    function ready() {
      if (ctx) return ctx;
      if (!allowed) return null;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
      } catch (e) {
        ctx = null;
      }
      return ctx;
    }

    function arm() {
      allowed = true;
      ready();
    }

    function env(node, t0, a, d, peak) {
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
      node.connect(g);
      g.connect(ctx.destination);
    }

    function relay() {
      if (!ready()) return;
      var t0 = ctx.currentTime;
      var o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = 190 + rnd() * 60;
      env(o, t0, 0.002, 0.05, 0.08);
      o.start(t0);
      o.stop(t0 + 0.09);
      var n = ctx.createBufferSource();
      var buf = ctx.createBuffer(1, 900, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < d.length; i++)
        d[i] = (rnd() * 2 - 1) * (1 - i / d.length);
      n.buffer = buf;
      env(n, t0 + 0.01, 0.001, 0.03, 0.1);
      n.start(t0);
    }

    function horn() {
      if (!ready()) return;
      var t0 = ctx.currentTime;
      [196, 208].forEach(function (f) {
        var o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        var lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 900;
        o.connect(lp);
        env(lp, t0, 0.01, 0.5, 0.04);
        o.start(t0);
        o.stop(t0 + 0.55);
      });
    }

    function hum(on) {
      if (!ready()) return;
      if (on && !humOsc) {
        humOsc = ctx.createOscillator();
        humOsc.type = "triangle";
        humOsc.frequency.value = 118;
        humGain = ctx.createGain();
        humGain.gain.value = 0.013;
        humOsc.connect(humGain);
        humGain.connect(ctx.destination);
        humOsc.start();
      } else if (!on && humOsc) {
        try {
          humOsc.stop();
        } catch (e) {
          void e;
        }
        humOsc = null;
        humGain = null;
      }
    }

    document.addEventListener("pointerdown", arm);
    document.addEventListener("keydown", arm);

    return {
      relay: relay,
      horn: horn,
      hum: hum,
      stopHum: function () {
        hum(false);
      },
    };
  })();

  /* ------------------------------------------------------- meter faces */

  var voltMeter = null;
  var ampMeters = {};

  function buildFace(host, opts) {
    host.innerHTML = "";
    var face = document.createElement("div");
    face.className = "face";
    host.appendChild(face);

    var w = face.clientWidth || 180;
    var hgt = face.clientHeight || 110;
    var cx = w / 2;
    var py = hgt * 0.93;

    (opts.bands || []).forEach(function (b) {
      var ang =
        opts.minAngle + (b.v / opts.max) * (opts.maxAngle - opts.minAngle);
      var rad = (ang * Math.PI) / 180;
      var rT = hgt * 0.56;
      var band = document.createElement("span");
      band.className = "arcband";
      band.style.background = b.color;
      band.style.height = Math.round(hgt * 0.12) + "px";
      band.style.left = cx + Math.sin(rad) * rT - 1.5 + "px";
      band.style.top = py - Math.cos(rad) * rT + "px";
      band.style.transform = "rotate(" + ang + "deg)";
      band.style.transformOrigin = "50% 0";
      face.appendChild(band);
    });

    for (var v = 0; v <= opts.max; v += opts.minor) {
      var major = v % opts.majorEvery === 0;
      var ang2 =
        opts.minAngle + (v / opts.max) * (opts.maxAngle - opts.minAngle);
      var rad2 = (ang2 * Math.PI) / 180;
      var rt = hgt * 0.62;
      var tickEl = document.createElement("span");
      tickEl.className = "tick" + (major ? " major" : "");
      tickEl.style.left = cx + Math.sin(rad2) * rt - 1 + "px";
      tickEl.style.top = py - Math.cos(rad2) * rt + "px";
      tickEl.style.transform = "rotate(" + ang2 + "deg)";
      tickEl.style.transformOrigin = "50% 0";
      face.appendChild(tickEl);

      if (major && opts.nums !== false) {
        var num = document.createElement("span");
        num.className = "ticknum";
        num.textContent = String(v);
        var rn = hgt * 0.42;
        num.style.left = cx + Math.sin(rad2) * rn + "px";
        num.style.top = py - Math.cos(rad2) * rn + "px";
        num.style.transform = "translate(-50%,-50%)";
        face.appendChild(num);
      }
    }

    var label = document.createElement("span");
    label.className = "mlabel";
    label.textContent = opts.label;
    face.appendChild(label);

    var needle = document.createElement("span");
    needle.className = "needle";
    needle.style.height = Math.round(hgt * 0.52) + "px";
    needle.style.bottom = hgt - py + "px";
    face.appendChild(needle);

    var hub = document.createElement("span");
    hub.style.cssText =
      "position:absolute;left:" +
      (cx - 7) +
      "px;top:" +
      (py - 7) +
      "px;width:14px;height:14px;border-radius:50%;" +
      "background:radial-gradient(circle at 34% 30%,#6a7793,#232c3e 68%,#10141d);" +
      "box-shadow:0 1px 1px rgba(0,0,0,.5);z-index:2";
    face.appendChild(hub);

    return function set(value) {
      var frac = clamp(value / opts.max, 0, 1.04);
      var ang = opts.minAngle + frac * (opts.maxAngle - opts.minAngle);
      needle.style.transform = "rotate(" + ang + "deg)";
    };
  }

  function buildMeters() {
    voltMeter = buildFace($('[data-meter="volts"]'), {
      max: 300,
      minor: 25,
      majorEvery: 50,
      minAngle: -96,
      maxAngle: 96,
      label: "Bus volts",
    });
    $$(".meter.ammeter").forEach(function (host) {
      var key = host.closest(".chan").getAttribute("data-chan");
      host.setAttribute("data-meter", key);
      ampMeters[key] = buildFace(host, {
        max: 100,
        minor: 5,
        majorEvery: 25,
        minAngle: -96,
        maxAngle: 96,
        label: "% of 6.6 A",
        bands: [
          { v: 48, color: "#a86613" },
          { v: 64, color: "#a86613" },
          { v: 77, color: "#5c7a34" },
          { v: 89, color: "#5c7a34" },
          { v: 100, color: "#d3301f" },
        ],
      });
    });
  }

  /* -------------------------------------------------------- knob marks */

  function layKnobMarks() {
    $$("ol.knobmarks").forEach(function (ol) {
      var items = $$("li", ol);
      items.forEach(function (li, i) {
        li.style.setProperty(
          "--a",
          -125 + (250 / (items.length - 1)) * i + "deg",
        );
      });
    });
  }

  /* -------------------------------------------------------------- knobs */

  var ISOLATOR_LABELS = [
    "Normal",
    "Bypass A",
    "Bypass B",
    "Bypass C",
    "Bypass D",
  ];
  var STEP_LABELS = ["Off", "Step 1", "Step 2", "Step 3", "Step 4", "Step 5"];
  var knobSetters = {};

  function wireKnob(el, max, labels, onChange) {
    function set(v, silent) {
      v = clamp(Math.round(v), 0, max);
      var changed = v !== Number(el.getAttribute("aria-valuenow"));
      el.setAttribute("aria-valuenow", String(v));
      el.setAttribute("aria-valuetext", labels ? labels[v] : String(v));
      el.style.setProperty("--pos", -125 + (250 / max) * v + "deg");
      if (changed && !silent) sound.relay();
      if (changed && onChange) onChange(v);
      return v;
    }
    set(Number(el.getAttribute("aria-valuenow")) || 0, true);

    el.addEventListener("keydown", function (ev) {
      var cur = Number(el.getAttribute("aria-valuenow")) || 0;
      var next = null;
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") next = cur + 1;
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") next = cur - 1;
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = max;
      if (next !== null) {
        ev.preventDefault();
        set(next);
      }
    });

    el.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      el.focus();
      var cur = Number(el.getAttribute("aria-valuenow")) || 0;
      var rect = el.getBoundingClientRect();
      var rightHalf = ev.clientX - rect.left > rect.width / 2;
      set(rightHalf ? cur + 1 : cur - 1);
    });

    el.addEventListener(
      "wheel",
      function (ev) {
        ev.preventDefault();
        var cur = Number(el.getAttribute("aria-valuenow")) || 0;
        set(cur + (ev.deltaY < 0 ? 1 : -1));
      },
      { passive: false },
    );

    return function (v) {
      return set(v, true);
    };
  }

  function wireKnobs() {
    knobSetters.approach = wireKnob(
      $('[data-control="APPROACH INTENSITY"]'),
      5,
      STEP_LABELS,
      function (v) {
        S.channels.approach.step = v;
      },
    );
    knobSetters.threshold = wireKnob(
      $('[data-control="THRESHOLD INTENSITY"]'),
      5,
      STEP_LABELS,
      function (v) {
        S.channels.threshold.step = v;
      },
    );
    knobSetters.edge = wireKnob(
      $('[data-control="EDGE INTENSITY"]'),
      5,
      STEP_LABELS,
      function (v) {
        S.channels.edge.step = v;
      },
    );
    knobSetters.papi = wireKnob(
      $('[data-control="PAPI INTENSITY"]'),
      5,
      STEP_LABELS,
      function (v) {
        S.channels.papi.step = v;
      },
    );
    knobSetters.isolator = wireKnob(
      $('[data-control="APPROACH ISOLATOR"]'),
      4,
      ISOLATOR_LABELS,
      function (v) {
        S.isolator = v;
      },
    );
  }

  /* ------------------------------------------------------------ toggles */

  function wireToggles() {
    var blowers = $('[data-control="REGULATOR BLOWERS"]');
    blowers.addEventListener("click", function () {
      var on = blowers.getAttribute("aria-checked") !== "true";
      blowers.setAttribute("aria-checked", String(on));
      S.blowers = on;
      sound.relay();
    });

    var guarded = $(".guarded");
    var lid = $(".guardlid");
    var crash = $('[data-control="CRASH MAX SWITCH"]');
    lid.addEventListener("click", function () {
      var open = guarded.classList.toggle("open");
      lid.setAttribute("aria-expanded", String(open));
      lid.setAttribute(
        "aria-label",
        open ? "Lower the crash switch guard" : "Raise the crash switch guard",
      );
      if (open) crash.focus();
      sound.relay();
    });
    crash.addEventListener("click", function () {
      var on = crash.getAttribute("aria-checked") !== "true";
      crash.setAttribute("aria-checked", String(on));
      S.crash = on;
      applyCrash(on);
      sound.relay();
    });
  }

  /* ----------------------------------------------------- pushes and keys */

  function wireManual() {
    var opener = $('[data-action="manual"]');
    var closer = $('[data-action="close-manual"]');
    var dialog = $("dialog[data-manual]");
    if (!opener || !closer || !dialog) return;
    opener.addEventListener("click", function () {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      sound.relay();
    });
    closer.addEventListener("click", function () {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      sound.relay();
    });
  }

  function applyCrash(on) {
    CHANNELS.forEach(function (k) {
      var ch = S.channels[k];
      if (on) {
        ch.crashFrom = ch.step;
        ch.step = 5;
      } else {
        ch.step = ch.crashFrom;
      }
      knobSetters[k](ch.step);
    });
  }

  /* ----------------------------------------------------- pushes and keys */

  function wirePushes() {
    $('[data-control="ALARM ACCEPT"]').addEventListener("click", function () {
      Object.keys(S.alarms).forEach(function (k) {
        if (S.alarms[k] === "new") S.alarms[k] = "acked";
      });
      sound.relay();
    });

    $('[data-control="ALARM RESET"]').addEventListener("click", function () {
      Object.keys(S.alarms).forEach(function (k) {
        delete S.alarms[k];
      });
      CHANNELS.forEach(function (k) {
        var ch = S.channels[k];
        if (ch.tripped && ch.temp < TEMP_RECLOSE) {
          ch.tripped = false;
          sound.relay();
        }
      });
      sound.relay();
    });

    $('[data-control="LAMP TEST"]').addEventListener("click", function () {
      S.lampTestUntil = S.t + 1.6;
    });

    $('[data-control="INSULATION TEST"]').addEventListener(
      "click",
      function () {
        S.insulTestUntil = S.t + 1.8;
      },
    );

    var key = $('[data-control="COLD START KEY"]');
    key.addEventListener("click", function () {
      key.classList.add("turned");
      sound.relay();
      setTimeout(function () {
        hardResetPanel();
        key.classList.remove("turned");
      }, 380);
    });

    $$("[data-inject]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        inject(btn.getAttribute("data-inject"));
      });
    });
  }

  /* ------------------------------------------------------ mimic building */

  var mimicLayers = {};

  function layer(name) {
    var d = document.createElement("div");
    $("#mimic").appendChild(d);
    mimicLayers[name] = d;
    return d;
  }

  function addLamp(parent, xPct, yPct, colour) {
    var lamp = document.createElement("span");
    lamp.className = "lamp " + colour;
    lamp.style.left = xPct + "%";
    lamp.style.top = yPct + "%";
    parent.appendChild(lamp);
    return lamp;
  }

  function buildMimic() {
    ["approach", "threshold", "edge", "end", "papi", "rabbit"].forEach(layer);

    var i;
    for (var g = 0; g < BARRETTES; g++) {
      var grp = document.createElement("span");
      grp.className = "barrette";
      grp.setAttribute("data-group", String(g));
      grp.style.left = 27.5 - g * 1.85 + "%";
      grp.style.top = "50%";
      for (i = 0; i < 5; i++) {
        var lamp = document.createElement("span");
        lamp.className = "lamp white";
        lamp.style.display = "block";
        lamp.style.margin = "0 auto " + (i === 4 ? "0" : "3px");
        grp.appendChild(lamp);
      }
      mimicLayers.approach.appendChild(grp);
    }

    for (i = 0; i < 6; i++)
      addLamp(mimicLayers.threshold, 30, 34 + i * 6.4, "green");
    for (i = 0; i < 5; i++) {
      addLamp(mimicLayers.threshold, 30, 12 + i * 3.4, "green");
      addLamp(mimicLayers.threshold, 30, 74 + i * 3.4, "green");
    }

    for (i = 0; i < 15; i++) {
      var ex = 33 + i * 4.35;
      addLamp(mimicLayers.edge, ex, 32.2, "white");
      addLamp(mimicLayers.edge, ex, 67.8, "white");
    }

    for (i = 0; i < 6; i++) addLamp(mimicLayers.end, 95, 34 + i * 6.4, "red");

    for (i = 0; i < 4; i++) {
      var box = addLamp(mimicLayers.papi, 23, 56 + i * 6, "white");
      box.classList.add("papibox");
      box.style.width = "9px";
      box.style.height = "9px";
      box.style.borderRadius = "2px";
    }

    var rabbit = document.createElement("span");
    rabbit.className = "lamp white rabbitlamp";
    rabbit.style.opacity = "0";
    mimicLayers.rabbit.appendChild(rabbit);
  }

  /* ---------------------------------------------------------- rendering */

  function pad3(n) {
    n = clamp(Math.round(n), 0, 999);
    return ("00" + String(n)).slice(-3);
  }

  function setReel(el, text) {
    var bs = $$("b", el);
    for (var i = 0; i < bs.length; i++) bs[i].textContent = text.charAt(i);
  }

  function papiSplit(angle) {
    if (angle >= 3.5) return 4;
    if (angle >= 3.2) return 3;
    if (angle >= 2.8) return 2;
    if (angle >= 2.5) return 1;
    return 0;
  }

  function lampBrightness(key) {
    var ch = S.channels[key];
    if (ch.step === 0 || ch.tripped) return 0;
    return 0.4 + 0.6 * (STEP_PCT[ch.step] / 100);
  }

  function paintLamp(el, on, bright) {
    el.classList.toggle("on", on);
    el.style.opacity = on ? bright.toFixed(2) : "";
  }

  function killLamp(el) {
    el.classList.remove("on");
    el.classList.add("dead");
    el.style.opacity = "";
  }

  function renderApproach(testing) {
    var ch = S.channels.approach;
    var bright = testing ? 1 : lampBrightness("approach");
    var live = testing || (ch.step > 0 && !ch.tripped);
    $$(".barrette", mimicLayers.approach).forEach(function (grp, gi) {
      var dead = ch.groupsOut.indexOf(gi) !== -1;
      $$(".lamp", grp).forEach(function (lamp) {
        if (testing) {
          paintLamp(lamp, true, 1);
        } else if (dead || !live) {
          if (dead) killLamp(lamp);
          else {
            lamp.classList.remove("on", "dead");
            lamp.style.opacity = "";
          }
        } else {
          paintLamp(lamp, true, bright);
        }
      });
    });
  }

  function renderGroup(parentLayer, key, testing) {
    var ch = S.channels[key];
    var bright = testing ? 1 : lampBrightness(key);
    var live = testing || (ch.step > 0 && !ch.tripped);
    var isEnd = parentLayer.className.indexOf("endlay") !== -1;
    void isEnd;
    $$(".lamp", parentLayer).forEach(function (lamp, idx) {
      if (testing) {
        paintLamp(lamp, true, 1);
        return;
      }
      var dead = ch.agedOut.indexOf(idx % Math.max(ch.lampsTotal, 1)) !== -1;
      if (dead) {
        killLamp(lamp);
      } else if (!live) {
        lamp.classList.remove("on", "dead");
        lamp.style.opacity = "";
      } else {
        paintLamp(lamp, true, bright);
      }
    });
  }

  function renderRabbit(testing) {
    var lamp = $(".rabbitlamp", mimicLayers.rabbit);
    var ch = S.channels.approach;
    if (!ch.step || ch.tripped) {
      lamp.style.opacity = "0";
      return;
    }
    var period = 1.15 - ch.step * 0.09;
    var phase = (S.t % period) / period;
    lamp.style.left = 6 + phase * 21.5 + "%";
    lamp.style.top = "50%";
    lamp.style.opacity = testing
      ? "1"
      : String(0.45 + 0.55 * Math.sin(phase * Math.PI));
  }

  function render() {
    var st = machine.state();
    var testing = S.t < S.lampTestUntil;

    voltMeter(testing ? 300 : st.volts);

    CHANNELS.forEach(function (k) {
      var ch = S.channels[k];
      var pct = ch.tripped ? 0 : (ch.current / FULL_CURRENT) * 100;
      if (ampMeters[k]) ampMeters[k](testing ? 100 : pct);
      var strip = $('[data-temp="' + k + '"]');
      if (strip) {
        var fill = $(".tfill", strip);
        fill.style.width =
          (clamp((ch.temp - 20) / 110, 0, 1) * 100).toFixed(1) + "%";
        fill.classList.toggle("hot", ch.temp > TEMP_WARN - 8);
      }
    });

    $('[data-pilot="mains"]').classList.toggle(
      "on",
      testing || st.supply === "mains",
    );
    $('[data-pilot="standby"]').classList.toggle(
      "on",
      testing || st.supply === "standby",
    );

    $$(".annwin").forEach(function (win) {
      var mode = S.alarms[win.getAttribute("data-alarm")];
      win.classList.toggle("flash", !testing && mode === "new");
      win.classList.toggle("lit", testing || (!!mode && mode !== "new"));
    });

    setReel(
      $('[data-counter="approach"]'),
      pad3(st.channels.approach.lampsOut),
    );
    setReel(
      $('[data-counter="threshold"]'),
      pad3(st.channels.threshold.lampsOut),
    );
    setReel($('[data-counter="edge"]'), pad3(st.channels.edge.lampsOut));
    var insulShown = 999;
    if (S.insulTestUntil > S.t || S.insulation < 999) insulShown = S.insulation;
    setReel($('[data-counter="insulation"]'), pad3(insulShown));

    var split = papiSplit(st.glideAngle);
    var papiLive = S.channels.papi.step > 0 && !S.channels.papi.tripped;
    $$(".papilamp").forEach(function (box, i) {
      box.classList.toggle("white", testing || (papiLive && i < split));
      box.classList.toggle("red", testing || (papiLive && i >= split));
    });
    $("[data-glide]").textContent = testing ? "3.0" : st.glideAngle.toFixed(1);

    renderApproach(testing);
    renderGroup(mimicLayers.threshold, "threshold", testing);
    renderGroup(mimicLayers.edge, "edge", testing);
    renderGroup(mimicLayers.end, "edge", testing);
    renderGroup(mimicLayers.papi, "papi", testing);
    renderRabbit(testing);

    sound.hum(S.blowers && S.blowerAirflow && !document.hidden);
  }

  /* --------------------------------------------------- panel hard reset */

  function hardResetPanel() {
    reset();
    $('[data-control="REGULATOR BLOWERS"]').setAttribute(
      "aria-checked",
      "false",
    );
    $('[data-control="CRASH MAX SWITCH"]').setAttribute(
      "aria-checked",
      "false",
    );
    knobSetters.approach(0);
    knobSetters.threshold(0);
    knobSetters.edge(0);
    knobSetters.papi(0);
    knobSetters.isolator(0);
  }

  /* --------------------------------------------------------- main loop */

  var lastFrame = performance.now();

  function frame(now) {
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!document.hidden && dt > 0) {
      tick(Math.min(dt, 2));
      render();
    }
    window.requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------------- bootup */

  function init() {
    buildMeters();
    layKnobMarks();
    wireKnobs();
    wireToggles();
    wirePushes();
    wireManual();
    buildMimic();

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(buildMeters, 250);
    });

    render();
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
