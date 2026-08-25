/* Peregrine WXR-91 Doppler Weather Radar Signal Console
   Putty-grey ops desk · charcoal crinkle RF modules · amber P7 phosphor.
   Classic script, IIFE, exposes window.machine. */
(function () {
  "use strict";

  var NAME = "Peregrine WXR-91";
  var FAULTS = [
    "transmitter arcing",
    "pedestal drive stall",
    "waveguide pressure loss",
  ];

  /* ---------------- deterministic simulation core ---------------- */

  var DT = 0.1; // fixed simulated step, seconds
  var AMBIENT = 24; // transmitter room, °C
  var DISPLAY_KM = 150; // PPI range scale
  var AZ_BINS = 180; // 2° bearing resolution
  var R_BINS = 64;

  var MODES = {
    STANDBY: { rate: 0, cuts: [0.5], kw: 0, temp: AMBIENT },
    "CLEAR-AIR": { rate: 9, cuts: [0.5, 0.9, 1.3], kw: 500, temp: 61 },
    PRECIPITATION: { rate: 17, cuts: [0.5, 1.5, 2.5], kw: 750, temp: 76 },
    SEVERE: { rate: 27, cuts: [0.5, 0.9, 1.4, 2.0, 2.8], kw: 750, temp: 87 },
    MANUAL: { rate: 0, cuts: [0.5, 1.5, 2.5], kw: 750, temp: 70 },
  };

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

  var rnd = mulberry32(0x57a11991);

  var CELLS = [];
  (function seedCells() {
    for (var i = 0; i < 7; i++) {
      CELLS.push({
        x: rnd() * 300 - 150,
        y: rnd() * 300 - 150,
        r: 16 + rnd() * 36,
        peak: 30 + rnd() * 32,
        vx: 34 + rnd() * 30,
        vy: -(14 + rnd() * 22),
        ph: rnd() * 6.283,
        w: 0.035 + rnd() * 0.06,
      });
    }
  })();

  function freshState() {
    return {
      t: 0,
      mains: false,
      mainsAt: -999,
      hvSwitch: false,
      hvLive: false,
      mode: "STANDBY",
      elIdx: 0,
      az: 137,
      slewVel: 0,
      kTemp: AMBIENT,
      fwdKW: 0,
      refPct: 0,
      arcLatched: false,
      arcCooldown: 0,
      arcTendency: 0,
      wgPressure: 12,
      wgLeak: false,
      purgeHeld: false,
      purgeSeal: 0,
      pedBreaker: true,
      pedLoad: 0,
      overloadT: 0,
      stallFault: false,
      stc: 35,
      acked: false,
      noiseDb: -113.2,
    };
  }

  function bootState() {
    var b = freshState();
    b.mains = true;
    b.mainsAt = -30;
    b.hvSwitch = true;
    b.hvLive = true;
    b.mode = "PRECIPITATION";
    b.kTemp = 76;
    return b;
  }

  var s = bootState();

  function modeDef() {
    return MODES[s.mode] || MODES.STANDBY;
  }

  function windKt() {
    return 12 + 6 * Math.sin(s.t * 0.021 + 1.3) + 3 * Math.sin(s.t * 0.047);
  }

  function filamentReady() {
    return s.mains && s.t - s.mainsAt > 6;
  }

  function hvCloseAllowed() {
    return s.mains && filamentReady() && s.arcCooldown <= 0 && s.kTemp < 104;
  }

  function doArcTrip() {
    s.arcLatched = true;
    s.arcCooldown = 25;
    if (s.hvLive) {
      s.hvLive = false;
      ui.clack(true);
    }
  }

  function step(dt) {
    var m = modeDef();
    s.t += dt;

    // storm advection (deterministic drift to the north-east)
    var i, c;
    for (i = 0; i < CELLS.length; i++) {
      c = CELLS[i];
      c.x += (c.vx * dt) / 60;
      c.y += (c.vy * dt) / 60;
      if (c.x > 175) c.x -= 350;
      if (c.y < -175) c.y += 350;
    }

    // power chain
    if (!s.mains) {
      s.hvSwitch = false;
      s.hvLive = false;
    }
    var live = s.hvSwitch && hvCloseAllowed();
    if (live !== s.hvLive) {
      s.hvLive = live;
      ui.clack(false);
      if (!live) s.arcTendency = 0; // recycling the transmitter clears arcing
    }

    // klystron thermal model
    var target = AMBIENT;
    var tau = 95;
    if (s.hvLive) {
      target = m.temp + s.refPct * 0.75;
      tau = 42;
    }
    s.kTemp += ((target - s.kTemp) / tau) * dt;
    if (s.kTemp < AMBIENT - 2) s.kTemp = AMBIENT - 2;

    // forward / reflected power
    var nom = s.hvLive ? m.kw : 0;
    var wobble = 1 + 0.025 * Math.sin(s.t * 1.7) + 0.015 * Math.sin(s.t * 0.53);
    s.fwdKW += (nom * wobble - s.fwdKW) * Math.min(1, dt * 4);
    if (s.fwdKW < 0.5) s.fwdKW = 0;

    var dryLoss =
      s.wgPressure >= 10 ? 0 : Math.pow((10 - s.wgPressure) / 10, 2);
    var refTarget = s.fwdKW > 0 ? 0.9 + 26 * dryLoss + s.arcTendency * 5 : 0;
    s.refPct += (refTarget - s.refPct) * Math.min(1, dt * 3);
    if (s.refPct < 0.05) s.refPct = 0;

    // arcing: overheated collector, wet guide, or injected tendency
    var arcP = 0;
    if (s.hvLive) {
      if (s.kTemp >= 104) arcP += 0.05;
      if (s.refPct > 14) arcP += 0.02;
      arcP += s.arcTendency * 0.09;
    }
    if (arcP > 0 && Math.random() < 1 - Math.exp(-arcP * dt * 10)) doArcTrip();
    if (s.arcCooldown > 0) s.arcCooldown = Math.max(0, s.arcCooldown - dt);

    // waveguide pressurisation
    if (s.purgeHeld && s.mains) {
      s.wgPressure += (13.5 - s.wgPressure) * 0.3 * dt;
      if (s.wgLeak) {
        s.purgeSeal += dt;
        if (s.purgeSeal >= 3) s.wgLeak = false;
      }
    } else if (s.wgLeak) {
      s.wgPressure = Math.max(
        1.2,
        s.wgPressure - (0.55 + 0.1 * Math.sin(s.t * 0.8)) * dt,
      );
    } else {
      s.wgPressure += (12 - s.wgPressure) * 0.06 * dt;
    }

    // antenna drive
    var demand = s.mode !== "STANDBY";
    var driveActive = s.mains && s.pedBreaker && demand && !s.stallFault;
    var azRate = 0;
    if (driveActive) {
      azRate = s.mode === "MANUAL" ? s.slewVel : m.rate;
    }
    s.slewVel *= Math.exp(-dt / 1.4);
    if (Math.abs(s.slewVel) < 0.4) s.slewVel = 0;

    var prevAz = s.az;
    s.az = (s.az + azRate * dt + 360) % 360;
    if (azRate > 0 && s.az < prevAz) {
      s.elIdx = (s.elIdx + 1) % m.cuts.length;
    }

    // pedestal load and breaker
    var loadT = 0;
    if (s.mains) {
      loadT = 7 + Math.abs(azRate) * 0.62 + windKt() * 0.85;
      if (s.stallFault) loadT = 97;
    }
    s.pedLoad += (loadT - s.pedLoad) * Math.min(1, dt * 2.5);
    if (s.pedLoad > 86 && s.pedBreaker) {
      s.overloadT += dt;
      if (s.overloadT > 6 || (s.stallFault && s.overloadT > 2)) {
        s.pedBreaker = false;
        s.overloadT = 0;
        ui.clack(true);
      }
    } else if (s.overloadT > 0) {
      s.overloadT = Math.max(0, s.overloadT - dt * 1.5);
    }

    // receiver noise floor rises as the guide loses its dry air
    var noiseT =
      -113.2 +
      (s.wgPressure < 10 ? (10 - s.wgPressure) * 0.4 : 0) +
      0.3 * Math.sin(s.t * 0.31);
    s.noiseDb += (noiseT - s.noiseDb) * Math.min(1, dt);
  }

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return s;
    var remaining = seconds;
    while (remaining > 0) {
      var h = remaining > DT ? DT : remaining;
      step(h);
      remaining -= h;
    }
    return s;
  }

  /* ---------------- alarms and the fixed API ---------------- */

  function alarmsNow() {
    var out = [];
    if (s.arcLatched || s.arcCooldown > 0) out.push("ARC DETECTED");
    if (s.kTemp >= 92) out.push("KLYSTRON TEMP");
    if (s.refPct > 6 && s.fwdKW > 0) out.push("REFLECTED POWER");
    if (!s.pedBreaker || s.stallFault || s.pedLoad > 84)
      out.push("PEDESTAL LOAD");
    if (s.wgPressure < 8) out.push("GUIDE PRESSURE");
    return out;
  }

  function state() {
    var m = modeDef();
    return {
      time_s: round2(s.t),
      mains: s.mains,
      filament_ready: filamentReady(),
      hv_switch: s.hvSwitch,
      hv_live: s.hvLive,
      scan_mode: s.mode,
      azimuth_deg: round1(s.az),
      elevation_deg: m.cuts[s.elIdx % m.cuts.length],
      elevation_index: s.elIdx,
      scan_rate_dps: s.mode === "MANUAL" ? round2(s.slewVel) : m.rate,
      forward_power_kw: round1(s.fwdKW),
      reflected_power_pct: round2(s.refPct),
      klystron_temp_c: round1(s.kTemp),
      pedestal_breaker_closed: s.pedBreaker,
      pedestal_load_pct: round1(s.pedLoad),
      wind_kt: round1(windKt()),
      waveguide_pressure_psig: round1(s.wgPressure),
      waveguide_leak: s.wgLeak,
      noise_dbm: round1(s.noiseDb),
      stc_pct: s.stc,
      storm_cells: CELLS.length,
      alarms: alarmsNow(),
    };
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }
  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "transmitter arcing") {
      s.arcTendency = 1;
      doArcTrip();
      return true;
    }
    if (f === "pedestal drive stall") {
      s.stallFault = true;
      s.overloadT = Math.max(s.overloadT, 2.1);
      return true;
    }
    if (f === "waveguide pressure loss") {
      s.wgLeak = true;
      s.purgeSeal = 0;
      return true;
    }
    return false;
  }

  function reset() {
    s = freshState();
    ui.resync();
  }

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ---------------- sound (synthesised, after a gesture only) ---------------- */

  var audio = {
    on: false,
    ctx: null,
    hum: null,
    humGain: null,
    burstBuf: null,
  };

  function audioEnsure() {
    if (audio.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio.ctx = new AC();
    var b = audio.ctx.createBuffer(
      1,
      audio.ctx.sampleRate * 0.09,
      audio.ctx.sampleRate,
    );
    var d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    audio.burstBuf = b;
    var osc = audio.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 118;
    var lp = audio.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 260;
    audio.humGain = audio.ctx.createGain();
    audio.humGain.gain.value = 0;
    osc.connect(lp).connect(audio.humGain).connect(audio.ctx.destination);
    osc.start();
    audio.hum = osc;
  }

  function humLevel() {
    if (!audio.on || !audio.humGain) return;
    var g = !s.mains ? 0 : s.hvLive ? 0.035 : 0.016;
    audio.humGain.gain.setTargetAtTime(g, audio.ctx.currentTime, 0.2);
  }

  /* ---------------- panel wiring ---------------- */

  var ui = (function () {
    function $(sel) {
      return document.querySelector(sel);
    }
    function all(sel) {
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    }

    /* relays: a short filtered noise burst; safe to call before sound is on */
    function clack(heavy) {
      if (!audio.on || !audio.ctx || !audio.burstBuf) return;
      var src = audio.ctx.createBufferSource();
      src.buffer = audio.burstBuf;
      var f = audio.ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = heavy ? 420 : 900;
      var g = audio.ctx.createGain();
      g.gain.value = heavy ? 0.5 : 0.3;
      src.connect(f).connect(g).connect(audio.ctx.destination);
      src.start();
    }

    function chirp() {
      if (!audio.on || !audio.ctx) return;
      var t0 = audio.ctx.currentTime;
      [0, 0.19].forEach(function (off) {
        var o = audio.ctx.createOscillator();
        o.type = "square";
        o.frequency.value = 880;
        var g = audio.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.06, t0 + off + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.14);
        o.connect(g).connect(audio.ctx.destination);
        o.start(t0 + off);
        o.stop(t0 + off + 0.16);
      });
    }

    /* guarded toggles */
    function wireGuard(bodyId, legend, onChange) {
      var body = $(bodyId);
      var guard = body.querySelector(".guard");
      var sw = body.querySelector(".toggle");
      var bat = document.createElement("span");
      bat.className = "bat";
      sw.appendChild(bat);
      guard.setAttribute("aria-label", "Lift " + legend + " guard cover");
      sw.setAttribute("aria-label", legend);
      function setOn(v) {
        sw.setAttribute("aria-checked", v ? "true" : "false");
        body.classList.toggle("locked", v);
        onChange(v);
      }
      guard.addEventListener("click", function () {
        var lifting = !body.classList.contains("lifted");
        body.classList.toggle("lifted", lifting);
        if (!lifting && sw.getAttribute("aria-checked") === "true")
          setOn(false);
      });
      sw.addEventListener("click", function () {
        if (!body.classList.contains("lifted")) return;
        setOn(sw.getAttribute("aria-checked") !== "true");
      });
      return {
        set: function (v) {
          sw.setAttribute("aria-checked", v ? "true" : "false");
          body.classList.toggle("locked", v);
        },
        lift: function (up) {
          body.classList.toggle("lifted", up);
        },
        lowerGuard: function () {
          body.classList.remove("lifted");
        },
      };
    }

    var gtMains = wireGuard("#gt-mains", "MAINS POWER", function (v) {
      s.mains = v;
      s.mainsAt = s.t;
      if (!v) {
        gtHv.set(false);
        s.hvSwitch = false;
        s.slewVel = 0;
      }
      clack(false);
    });

    var gtHv = wireGuard("#gt-hv", "TRANSMITTER HV", function (v) {
      s.hvSwitch = v;
      if (!v) {
        s.arcLatched = false; // dropping HV clears the arc detector
        s.arcTendency = 0;
      }
      clack(false);
    });

    /* rotary selector builder: labels placed around the dial */
    function wireRotary(
      groupEl,
      items,
      startAngle,
      stepAngle,
      radius,
      onSelect,
    ) {
      var dial = groupEl.querySelector(".rot-dial, .ks-dial");
      var legend = groupEl.querySelector(".rot-legend, .ks-legend");
      var pointer = dial.querySelector(".rot-pointer, .ks-pointer");
      var cx = groupEl.clientWidth ? groupEl.clientWidth / 2 : 98;
      var cy = groupEl.clientHeight ? groupEl.clientHeight * 0.54 : 64;
      var btns = items.map(function (label, idx) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = groupEl.id === "fi-rotary" ? "ks-pos" : "rot-pos";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.textContent = label;
        var ang = ((startAngle + idx * stepAngle) * Math.PI) / 180;
        b.style.left = Math.round(cx + Math.sin(ang) * radius) + "px";
        b.style.top = Math.round(cy - Math.cos(ang) * radius) + "px";
        b.addEventListener("click", function () {
          select(idx, true);
        });
        legend.appendChild(b);
        return b;
      });
      var cur = 0;
      function select(idx, fire) {
        cur = idx;
        btns.forEach(function (b, j) {
          b.setAttribute("aria-checked", j === idx ? "true" : "false");
        });
        pointer.style.transform = "rotate(" + idx * stepAngle + "deg)";
        if (fire) onSelect(items[idx], idx);
      }
      groupEl.addEventListener("keydown", function (e) {
        var d = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") d = 1;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") d = -1;
        else return;
        e.preventDefault();
        select((cur + d + items.length) % items.length, true);
      });
      select(0, false);
      return { select: select };
    }

    var FI_ITEMS = ["OFF", "TX ARC", "PED STALL", "WG LEAK"];
    var fiSpring = null;
    function clearAsserted() {
      s.wgLeak = false;
      s.stallFault = false;
    }
    var fiRot = wireRotary(
      $("#fi-rotary"),
      FI_ITEMS,
      0,
      90,
      38,
      function (label) {
        clearTimeout(fiSpring);
        if (label === "OFF") {
          clearAsserted(); // returning the key drops the asserted condition
          return;
        }
        clearAsserted();
        if (label === "TX ARC") inject("transmitter arcing");
        if (label === "PED STALL") inject("pedestal drive stall");
        if (label === "WG LEAK") {
          s.wgLeak = true; // maintained position: the leak stays until the key returns
          s.purgeSeal = 0;
        }
        chirp();
        if (label !== "WG LEAK") {
          fiSpring = setTimeout(function () {
            fiRot.select(0, false);
          }, 550);
        }
      },
    );

    var MODE_ITEMS = ["STANDBY", "CLEAR-AIR", "PRECIP", "SEVERE", "MANUAL"];
    var modeMap = {
      "CLEAR-AIR": "CLEAR-AIR",
      PRECIP: "PRECIPITATION",
      SEVERE: "SEVERE",
      MANUAL: "MANUAL",
    };
    var modeRot = wireRotary(
      $("#mode-rotary"),
      MODE_ITEMS,
      0,
      60,
      62,
      function (label, idx) {
        s.mode = modeMap[label] || "STANDBY";
        s.elIdx = 0;
        if (idx === 0) s.slewVel = 0;
        clack(false);
      },
    );

    /* azimuth slew handwheel */
    var wheel = $("#az-wheel");
    var disc = wheel.querySelector(".wheel-disc");
    var wheelRot = 0;
    var dragging = false;
    var lastAng = 0;
    var lastMoveT = 0;

    function wheelAngle(e) {
      var r = wheel.getBoundingClientRect();
      return Math.atan2(
        e.clientY - (r.top + r.height / 2),
        e.clientX - (r.left + r.width / 2),
      );
    }

    wheel.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastAng = wheelAngle(e);
      lastMoveT = performance.now();
      wheel.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    wheel.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var a = wheelAngle(e);
      var d = a - lastAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      lastAng = a;
      var now = performance.now();
      var dtm = Math.max(0.016, (now - lastMoveT) / 1000);
      lastMoveT = now;
      var deg = (d * 180) / Math.PI;
      wheelRot += deg;
      disc.style.transform = "rotate(" + wheelRot + "deg)";
      var v = (deg / dtm) * 0.9;
      s.slewVel = Math.max(-90, Math.min(90, s.slewVel * 0.55 + v * 0.45));
    });
    function endDrag() {
      dragging = false;
    }
    wheel.addEventListener("pointerup", endDrag);
    wheel.addEventListener("pointercancel", endDrag);
    wheel.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        s.slewVel = 60;
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        s.slewVel = -60;
        e.preventDefault();
      }
    });
    wheel.addEventListener("keyup", function () {
      s.slewVel = 0;
    });

    /* pushbuttons */
    $("#ack-btn").addEventListener("click", function () {
      s.acked = true;
    });
    $("#pedreset-btn").addEventListener("click", function () {
      if (!s.pedBreaker && s.pedLoad < 80) {
        s.pedBreaker = true;
        s.overloadT = 0;
        clack(false);
      }
    });
    var purgeBtn = $("#purge-btn");
    function purge(v) {
      s.purgeHeld = v;
      purgeBtn.classList.toggle("held", v);
      purgeBtn.setAttribute("aria-pressed", v ? "true" : "false");
    }
    purgeBtn.addEventListener("pointerdown", function () {
      purge(true);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      purgeBtn.addEventListener(ev, function () {
        purge(false);
      });
    });
    purgeBtn.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") purge(true);
    });
    purgeBtn.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") purge(false);
    });

    $("#simreset-btn").addEventListener("click", function () {
      reset();
    });

    var stcSlider = $("#stc-slider");
    stcSlider.addEventListener("input", function () {
      s.stc = Number(stcSlider.value) || 0;
    });

    var soundBtn = $("#sound-btn");
    soundBtn.addEventListener("click", function () {
      audio.on = !audio.on;
      if (audio.on) audioEnsure();
      if (audio.ctx && audio.ctx.state === "suspended") audio.ctx.resume();
      if (!audio.on && audio.humGain) audio.humGain.gain.value = 0;
      soundBtn.textContent = audio.on ? "SOUND\u00a0ON" : "SOUND\u00a0OFF";
      soundBtn.setAttribute("aria-pressed", audio.on ? "true" : "false");
    });

    /* manual dialog */
    var dlg = $("#manual-dialog");
    $('[data-action="manual"]').addEventListener("click", function () {
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    });
    $('[data-action="close-manual"]').addEventListener("click", function () {
      dlg.close ? dlg.close() : dlg.removeAttribute("open");
    });

    function resync() {
      gtMains.set(false);
      gtMains.lowerGuard();
      gtHv.set(false);
      gtHv.lowerGuard();
      modeRot.select(0, false);
      fiRot.select(0, false);
      stcSlider.value = "35";
      purgeBtn.classList.remove("held");
      bins.fill(0);
      pctx.fillStyle = "#060503";
      pctx.fillRect(0, 0, ppi.width, ppi.height);
    }

    /* reflect the running handover state onto the drawn controls */
    function syncControls() {
      gtMains.lift(s.mains);
      gtMains.set(s.mains);
      gtHv.lift(s.hvSwitch);
      gtHv.set(s.hvSwitch);
      var idx = MODE_ITEMS.indexOf("PRECIP");
      modeRot.select(idx < 0 ? 0 : idx, false);
      stcSlider.value = String(s.stc);
    }

    return {
      clack: clack,
      chirp: chirp,
      resync: resync,
      syncControls: syncControls,
    };
  })();

  /* ---------------- PPI rendering ---------------- */

  var ppi = document.getElementById("ppi");
  var overlay = document.getElementById("overlay");
  var pctx = ppi.getContext("2d");
  var octx = overlay.getContext("2d");
  var W = ppi.width;
  var CTR = W / 2;
  var RPX = 262;

  var bins = new Float32Array(AZ_BINS * R_BINS);

  /* polar lookup table: pixel -> bin index (AZ_BINS*R_BINS when off-disk) */
  var lut = new Int32Array(W * W);
  (function buildLut() {
    for (var y = 0; y < W; y++) {
      for (var x = 0; x < W; x++) {
        var dx = x - CTR + 0.5;
        var dy = y - CTR + 0.5;
        var rr = Math.sqrt(dx * dx + dy * dy);
        var idx = y * W + x;
        if (rr > RPX) {
          lut[idx] = -1;
        } else {
          var brg = (Math.atan2(dx, -dy) * 180) / Math.PI;
          if (brg < 0) brg += 360;
          var azBin = Math.floor(brg / (360 / AZ_BINS)) % AZ_BINS;
          var rBin = Math.min(R_BINS - 1, Math.floor((rr / RPX) * R_BINS));
          lut[idx] = azBin * R_BINS + rBin;
        }
      }
    }
  })();

  var img = pctx.createImageData(W, W);
  var imgData = img.data;

  function sampleCell(azDeg, rKm) {
    var rad = (azDeg * Math.PI) / 180;
    var px = Math.sin(rad) * rKm;
    var py = -Math.cos(rad) * rKm;
    var v = 0;
    for (var i = 0; i < CELLS.length; i++) {
      var c = CELLS[i];
      var dx = px - c.x;
      var dy = py - c.y;
      var g = Math.exp(-(dx * dx + dy * dy) / (2 * c.r * c.r));
      v += g * c.peak * (0.72 + 0.28 * Math.sin(c.w * s.t + c.ph));
    }
    return Math.min(1, v / 68);
  }

  function speckle(a, r, bucket) {
    var h = (a * 73856093) ^ (r * 19349663) ^ (bucket * 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function writeBeam() {
    if (!s.mains) return;
    var pure = s.hvLive ? 1 : 0;
    var gain =
      (0.32 + 0.0102 * s.stc) *
      (0.22 + 0.78 * pure) *
      (s.wgPressure >= 10 ? 1 : Math.max(0.12, s.wgPressure / 10));
    var azBin = Math.floor(s.az / (360 / AZ_BINS)) % AZ_BINS;
    var bucket = Math.floor(s.t * 0.7);
    for (var rb = 0; rb < R_BINS; rb++) {
      var rKm = ((rb + 0.5) / R_BINS) * DISPLAY_KM;
      var v = sampleCell(s.az, rKm) * gain;
      v += pure * 0.028 * speckle(azBin, rb, bucket);
      var idx = azBin * R_BINS + rb;
      if (v > bins[idx]) bins[idx] = Math.min(1, v);
      var nb = ((azBin + AZ_BINS - 1) % AZ_BINS) * R_BINS + rb;
      if (v * 0.45 > bins[nb]) bins[nb] = Math.min(1, v * 0.45);
    }
  }

  function paintPhosphor(dt) {
    var decay = Math.exp(-dt / 3.6);
    var i, v;
    for (i = 0; i < bins.length; i++) {
      bins[i] *= decay;
    }
    var d = imgData;
    for (i = 0; i < lut.length; i++) {
      var li = lut[i];
      var o = i * 4;
      if (li < 0) {
        d[o] = 7;
        d[o + 1] = 5;
        d[o + 2] = 3;
        d[o + 3] = 255;
        continue;
      }
      v = bins[li];
      var vv = v > 0.004 ? v : 0;
      d[o] = Math.min(255, 255 * vv * 1.9 + 10);
      d[o + 1] = Math.min(235, 205 * Math.pow(vv, 0.82));
      d[o + 2] = Math.min(120, 90 * vv * vv);
      d[o + 3] = 255;
    }
    pctx.putImageData(img, 0, 0);
  }

  function paintOverlay() {
    octx.clearRect(0, 0, W, W);
    var lit = s.mains;
    var ringA = lit ? 0.3 : 0.13;
    var spokeA = lit ? 0.14 : 0.07;
    octx.lineWidth = 1;
    octx.strokeStyle = "rgba(255,176,0," + ringA + ")";
    for (var km = 30; km <= 150; km += 30) {
      octx.beginPath();
      octx.arc(CTR, CTR, (km / DISPLAY_KM) * RPX, 0, 6.2832);
      octx.stroke();
    }
    octx.strokeStyle = "rgba(255,176,0," + spokeA + ")";
    for (var dg = 0; dg < 360; dg += 30) {
      var a = (dg * Math.PI) / 180;
      octx.beginPath();
      octx.moveTo(CTR + Math.sin(a) * 24, CTR - Math.cos(a) * 24);
      octx.lineTo(CTR + Math.sin(a) * RPX, CTR - Math.cos(a) * RPX);
      octx.stroke();
    }
    /* north index and cardinal ticks */
    octx.strokeStyle = "rgba(255,220,140,0.55)";
    octx.beginPath();
    octx.moveTo(CTR, CTR - 18);
    octx.lineTo(CTR, CTR - RPX);
    octx.stroke();
    /* the sweep */
    if (lit) {
      var sa = (s.az * Math.PI) / 180;
      var sx = Math.sin(sa);
      var cy = -Math.cos(sa);
      var grad = octx.createRadialGradient(CTR, CTR, 0, CTR, CTR, RPX);
      grad.addColorStop(0, "rgba(255,212,92,0.95)");
      grad.addColorStop(1, "rgba(255,176,0,0.55)");
      octx.strokeStyle = grad;
      octx.lineWidth = 2;
      octx.beginPath();
      octx.moveTo(CTR, CTR);
      octx.lineTo(CTR + sx * RPX, CTR + cy * RPX);
      octx.stroke();
    }
  }

  /* ---------------- instrument DOM updates ---------------- */

  var dom = {
    fwd: document.getElementById("fwd-readout"),
    ref: document.getElementById("ref-readout"),
    kly: document.getElementById("kly-needle"),
    azr: document.getElementById("az-readout"),
    el: document.getElementById("el-readout"),
    wind: document.getElementById("wind-readout"),
    ped: document.getElementById("ped-needle"),
    wg: document.getElementById("wg-readout"),
    noise: document.getElementById("noise-readout"),
    mode: document.getElementById("mode-readout"),
    fil: document.getElementById("lamp-filament"),
    hvr: document.getElementById("lamp-hvready"),
    man: document.getElementById("lamp-manual"),
    inh: document.getElementById("lamp-inhibit"),
    wheel: document.getElementById("az-wheel"),
    anns: {},
    fwdBar: document.querySelectorAll("#fwd-bar i"),
    refBar: document.querySelectorAll("#ref-bar i"),
  };
  Array.prototype.forEach.call(
    document.querySelectorAll(".ann[data-ann]"),
    function (el) {
      dom.anns[el.getAttribute("data-ann")] = el;
    },
  );

  var prevAlarms = [];
  var domClock = 0;

  function setBar(bar, n, hot) {
    for (var i = 0; i < bar.length; i++) {
      bar[i].className = i < n ? "on" + (hot && i >= 7 ? " hot" : "") : "";
    }
  }

  function needle(el, frac) {
    el.style.transform =
      "rotate(" + (-120 + Math.max(0, Math.min(1, frac)) * 240) + "deg)";
  }

  function pad(n, w) {
    var str = String(Math.abs(Math.round(n * 10) / 10));
    var dot = str.indexOf(".");
    if (dot < 0) str += ".0";
    while (str.length < w) str = "0" + str;
    return (n < 0 ? "-" : "") + str;
  }

  function updateDom() {
    var st = state();
    dom.fwd.textContent = String(Math.round(st.forward_power_kw)).padStart(
      3,
      "0",
    );
    dom.ref.textContent = st.reflected_power_pct.toFixed(1);
    setBar(dom.fwdBar, Math.round((st.forward_power_kw / 800) * 10), false);
    setBar(
      dom.refBar,
      Math.min(10, Math.round((st.reflected_power_pct / 30) * 10)),
      st.reflected_power_pct > 6,
    );
    needle(dom.kly, st.klystron_temp_c / 150);
    needle(dom.ped, st.pedestal_load_pct / 120);
    dom.azr.textContent = pad(st.azimuth_deg, 5) + "\u00b0";
    dom.el.textContent = st.elevation_deg.toFixed(2) + "\u00b0";
    dom.wind.textContent = Math.round(st.wind_kt) + " KT";
    dom.wg.textContent = st.waveguide_pressure_psig.toFixed(1) + " PSIG";
    dom.noise.innerHTML =
      "&minus;" + Math.abs(st.noise_dbm).toFixed(1) + " dBm";
    dom.mode.textContent =
      st.scan_mode === "STANDBY"
        ? "STANDBY"
        : st.scan_mode + " \u00b7 CUT " + (st.elevation_index + 1);

    dom.fil.classList.toggle("lit", st.mains);
    dom.hvr.classList.toggle("lit", st.filament_ready && !st.hv_live);
    dom.man.classList.toggle("lit", st.scan_mode === "MANUAL");
    dom.inh.classList.toggle(
      "lit",
      s.mode !== "MANUAL" && Math.abs(s.slewVel) > 2,
    );
    dom.wheel.setAttribute("aria-valuenow", String(Math.round(st.azimuth_deg)));

    var active = st.alarms;
    if (active.length === 0) s.acked = false;
    Object.keys(dom.anns).forEach(function (name) {
      var on = active.indexOf(name) >= 0;
      var el = dom.anns[name];
      var cls = "ann";
      if (on) {
        cls +=
          name === "REFLECTED POWER" || name === "GUIDE PRESSURE"
            ? " amber-on"
            : " red-on";
        if (!s.acked) cls += " flash";
      }
      el.className = cls;
    });
    if (active.length > prevAlarms.length && audio.on) ui.chirp();
    prevAlarms = active;
  }

  /* ---------------- main loop ---------------- */

  var lastTs = performance.now();

  function frame(ts) {
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.5) dt = 0.5;
    if (!document.hidden && dt > 0) {
      tick(dt);
      writeBeam();
      paintPhosphor(dt);
      paintOverlay();
      domClock += dt;
      if (domClock > 0.12) {
        domClock = 0;
        updateDom();
        humLevel();
      }
    }
    requestAnimationFrame(frame);
  }

  ui.syncControls();
  updateDom();
  requestAnimationFrame(frame);
})();
