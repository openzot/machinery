/* Complex 14 — Blockhouse Firing Console. Type GM-412/S, 1962.
   Terminal-count sequencer: load, pressurise, align, start, hold, recycle.
   Deterministic simulation; window.machine is the fixed test API. */
(function () {
  "use strict";

  var NAME = "Complex 14 Blockhouse Firing Console";
  var FAULTS = [
    "tank pressurisation loss",
    "guidance computer dropout",
    "deluge water loss",
  ];

  /* ------------------------------ model ------------------------------ */

  var S = null;

  function fresh() {
    return {
      bus: false,
      padClear: false,
      armsRetracted: false, // SERVICE ARMS toggle: false = connected
      ventOpen: false,
      selMode: 0, // 0 OFF 1 LOAD 2 TOP OFF 3 PRESS
      gmode: 0, // 0 OFF 1 WARM UP 2 ALIGN 3 FLY
      compOn: false,
      compWarm: 0, // seconds of warm-up accumulated
      delugeRun: false,
      delugePress: 0, // psi
      he: 3000, // helium bottle, psi
      loxP: 0,
      rp1P: 0, // ullage, psi
      loxMass: 0,
      rp1Mass: 0, // percent
      align: 0, // guidance alignment, pct
      seq: "cold", // cold|ready|count|hold|aborted|flight|orbit|destruct
      t: -180, // count time, s (negative before liftoff)
      mark: 180, // selected count length, s
      holdCause: "", // "" | manual | arms | guid
      abortLatch: false,
      destructed: false,
      thrust: 0,
      altKm: 0,
      velMs: 0,
      attErr: 0,
      simTime: 0,
      faults: { pressure: false, guidance: false, deluge: false },
      repress: 0, // seconds of emergency-helium pulse left
      lampsTest: false,
      noGoMsg: "",
      noGoUntil: -1, // real-time stamp for the caption line
    };
  }

  var ALARMS = {
    pressure: { text: "TANK PRESSURE LOW", el: "ann-pressure" },
    helium: { text: "HELIUM RESERVE LOW", el: "ann-helium" },
    guidance: { text: "GUIDANCE FAILURE", el: "ann-guidance" },
    arm: { text: "ARM INTERLOCK", el: "ann-arm" },
    deluge: { text: "DELUGE WATER LOSS", el: "ann-deluge" },
    abort: { text: "AUTO ABORT", el: "ann-abort" },
    destruct: { text: "RANGE DESTRUCT", el: "ann-destruct" },
  };

  function activeAlarms() {
    var out = [];
    if (!S) return out;
    var loaded = S.loxMass > 60;
    if (S.faults.pressure || (loaded && S.loxP < 12))
      out.push(ALARMS.pressure.text);
    if (S.he < 800 && S.bus) out.push(ALARMS.helium.text);
    if (
      S.faults.guidance ||
      (S.gmode > 0 && !S.compOn) ||
      (S.seq === "flight" && S.attErr > 3)
    )
      out.push(ALARMS.guidance.text);
    if (S.holdCause === "arms") out.push(ALARMS.arm.text);
    if (S.faults.deluge || (S.delugeRun && S.delugePress < 40))
      out.push(ALARMS.deluge.text);
    if (S.abortLatch) out.push(ALARMS.abort.text);
    if (S.destructed) out.push(ALARMS.destruct.text);
    return out;
  }

  function alarmOn(key) {
    var t = ALARMS[key].text;
    return activeAlarms().indexOf(t) !== -1;
  }

  /* --------------------------- audio --------------------------------- */

  var AC = null,
    audioArmed = false;

  function armAudio() {
    if (audioArmed) return;
    audioArmed = true;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      AC = null;
    }
  }

  function tone(freq, dur, type, gainV, when) {
    if (!AC) return;
    try {
      var o = AC.createOscillator(),
        g = AC.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, AC.currentTime + (when || 0));
      g.gain.exponentialRampToValueAtTime(
        gainV || 0.05,
        AC.currentTime + (when || 0) + 0.01,
      );
      g.gain.exponentialRampToValueAtTime(
        0.0001,
        AC.currentTime + (when || 0) + dur,
      );
      o.connect(g);
      g.connect(AC.destination);
      o.start(AC.currentTime + (when || 0));
      o.stop(AC.currentTime + (when || 0) + dur + 0.05);
    } catch (e) {
      /* audio optional */
    }
  }

  function noiseBurst(dur, gainV, freq) {
    if (!AC) return;
    try {
      var n = Math.floor(AC.sampleRate * dur),
        buf = AC.createBuffer(1, n, AC.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = AC.createBufferSource();
      src.buffer = buf;
      var f = AC.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = freq || 400;
      var g = AC.createGain();
      g.gain.value = gainV || 0.12;
      src.connect(f);
      f.connect(g);
      g.connect(AC.destination);
      src.start();
    } catch (e) {
      /* audio optional */
    }
  }

  var hornStopAt = 0,
    lastAlarmSet = {};
  function horn() {
    if (!AC) return;
    var now = performance.now();
    if (now < hornStopAt) return;
    hornStopAt = now + 1400;
    tone(520, 0.28, "square", 0.055, 0);
    tone(370, 0.28, "square", 0.055, 0.32);
    tone(520, 0.28, "square", 0.055, 0.64);
  }
  function relayClick() {
    noiseBurst(0.03, 0.06, 2600);
  }
  function klaxon() {
    if (!AC) return;
    for (var i = 0; i < 6; i++) {
      tone(660, 0.16, "sawtooth", 0.06, i * 0.34);
      tone(440, 0.16, "sawtooth", 0.06, i * 0.34 + 0.17);
    }
  }
  function rumble() {
    noiseBurst(4.2, 0.22, 180);
    noiseBurst(3.0, 0.14, 90);
  }
  function boom() {
    noiseBurst(1.6, 0.3, 120);
    tone(70, 1.2, "sine", 0.18, 0);
  }

  /* ------------------------- dom references -------------------------- */

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {};

  var SEG = {
    0: "abcdef",
    1: "bc",
    2: "abged",
    3: "abgcd",
    4: "fgbc",
    5: "afgcd",
    6: "afgedc",
    7: "abc",
    8: "abcdefg",
    9: "abfgcd",
  };
  var DIGIT_KEYS = ["hm-tens", "hm-ones", "ms-tens", "ms-ones"];

  function q(root, sel) {
    return root.querySelector(sel);
  }

  /* meters are drawn once at init */
  var meterDefs = {
    lox: { max: 25, green: [14, 22], red: [0, 11], unit: "PSI" },
    rp1: { max: 25, green: [11, 19], red: [0, 8], unit: "PSI" },
    he: { max: 3000, green: [900, 3000], red: [0, 800], unit: "PSI" },
    align: { max: 100, green: [95, 100], red: [0, 80], unit: "PCT" },
  };
  var needleEls = {};
  var SVGNS = "http://www.w3.org/2000/svg";

  function polar(cx, cy, r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function arcPath(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0),
      p1 = polar(cx, cy, r, a1);
    return (
      "M" +
      p0[0].toFixed(1) +
      " " +
      p0[1].toFixed(1) +
      " A" +
      r +
      " " +
      r +
      " 0 0 1 " +
      p1[0].toFixed(1) +
      " " +
      p1[1].toFixed(1)
    );
  }

  function buildMeter(svg, def) {
    var cx = 60,
      cy = 66,
      r = 48;
    var face = document.createElementNS(SVGNS, "path");
    face.setAttribute("d", arcPath(cx, cy, r, -84, 84));
    face.setAttribute("stroke", "#d9d2bc");
    face.setAttribute("stroke-width", "26");
    face.setAttribute("fill", "none");
    svg.appendChild(face);
    var rim = document.createElementNS(SVGNS, "path");
    rim.setAttribute("d", arcPath(cx, cy, r + 13, -86, 86));
    rim.setAttribute("stroke", "#20262a");
    rim.setAttribute("stroke-width", "3");
    rim.setAttribute("fill", "none");
    svg.appendChild(rim);

    var zones = [
      ["red", "#b3271c"],
      ["green", "#2f7a44"],
    ];
    zones.forEach(function (z) {
      var d = def[z[0]];
      if (!d) return;
      var a0 = -84 + 168 * (d[0] / def.max),
        a1 = -84 + 168 * (d[1] / def.max);
      if (z[0] === "red") {
        a0 = -84 + 168 * (d[0] / def.max);
        a1 = -84 + 168 * (d[1] / def.max);
      }
      var p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", arcPath(cx, cy, r, a0, a1));
      p.setAttribute("stroke", z[1]);
      p.setAttribute("stroke-width", "5");
      p.setAttribute("fill", "none");
      svg.appendChild(p);
    });

    for (var k = 0; k <= 10; k++) {
      var big = k % 5 === 0;
      var ang = -84 + 168 * (k / 10);
      var q1 = polar(cx, cy, r - 9, ang),
        q2 = polar(cx, cy, r - (big ? 16 : 13), ang);
      var tick = document.createElementNS(SVGNS, "line");
      tick.setAttribute("x1", q1[0]);
      tick.setAttribute("y1", q1[1]);
      tick.setAttribute("x2", q2[0]);
      tick.setAttribute("y2", q2[1]);
      tick.setAttribute("stroke", "#20262a");
      tick.setAttribute("stroke-width", big ? 1.8 : 1);
      svg.appendChild(tick);
    }
    var lbl = document.createElementNS(SVGNS, "text");
    lbl.setAttribute("x", cx);
    lbl.setAttribute("y", cy - 16);
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute(
      "style",
      "font: bold 8px 'Courier New',monospace; fill:#20262a; letter-spacing:1px",
    );
    lbl.textContent = def.unit;
    svg.appendChild(lbl);

    var hub = document.createElementNS(SVGNS, "circle");
    hub.setAttribute("cx", cx);
    hub.setAttribute("cy", cy);
    hub.setAttribute("r", "5");
    hub.setAttribute("fill", "#20262a");
    svg.appendChild(hub);

    var needle = document.createElementNS(SVGNS, "g");
    var line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", cx);
    line.setAttribute("y1", cy + 6);
    line.setAttribute("x2", cx);
    line.setAttribute("y2", cy - r + 12);
    line.setAttribute("stroke", "#16181a");
    line.setAttribute("stroke-width", "2.4");
    line.setAttribute("stroke-linecap", "round");
    needle.appendChild(line);
    svg.appendChild(needle);
    needle.setAttribute("transform", "rotate(-84 " + cx + " " + cy + ")");
    return needle;
  }

  function initMeters() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".meter"),
      function (svg) {
        var key = svg.getAttribute("data-meter");
        needleEls[key] = buildMeter(svg, meterDefs[key]);
      },
    );
  }

  /* ---------------------------- rendering ----------------------------- */

  function setDigit(el, ch) {
    var on = SEG[ch] || "";
    Array.prototype.forEach.call(el.children, function (segEl) {
      var cls =
        segEl.className.baseVal !== undefined
          ? segEl.className.baseVal
          : segEl.className;
      var letter = cls.split(" ")[1];
      var lit = on.indexOf(letter) !== -1;
      if (S.lampsTest) lit = true;
      segEl.className.baseVal !== undefined
        ? (segEl.className.baseVal = "s " + letter + (lit ? " on" : ""))
        : (segEl.className = "s " + letter + (lit ? " on" : ""));
    });
  }

  function render(nowReal) {
    var t = S.t;
    var neg = t < 0;
    $("t-sign").textContent = neg ? "T\u2212" : "T+";
    var tt = Math.min(Math.abs(t), 99 * 60 + 59);
    var mm = String(Math.floor(tt / 60)),
      ss = String(Math.floor(tt % 60));
    if (mm.length < 2) mm = "0" + mm;
    if (ss.length < 2) ss = "0" + ss;
    var str = mm + ss;
    DIGIT_KEYS.forEach(function (k, i) {
      setDigit(els.digits[k], str[i]);
    });

    var lampHold = $("lamp-hold"),
      lampSeq = $("lamp-seq");
    lampHold.className = "mini-lamp" + (S.seq === "hold" ? " lit" : "");
    lampSeq.className =
      "mini-lamp" +
      (S.seq === "count" ? " lit" : S.seq === "orbit" ? " green-lit" : "");

    var markLine = $("clock-mark");
    if (S.noGoMsg && nowReal < S.noGoUntil) markLine.textContent = S.noGoMsg;
    else if (S.seq === "cold") markLine.textContent = "SYSTEM COLD";
    else if (S.seq === "ready")
      markLine.textContent = "MARK T\u2212" + S.mark + " \u00B7 READY";
    else if (S.seq === "hold")
      markLine.textContent =
        "HOLD AT T" + (neg ? "\u2212" : "+") + mm + ":" + ss;
    else if (S.seq === "aborted")
      markLine.textContent = "ABORT \u2014 LATCH SET";
    else if (S.seq === "flight")
      markLine.textContent =
        "FLIGHT \u00B7 " + (S.thrust > 0 ? "POWERED" : "COAST");
    else if (S.seq === "orbit") markLine.textContent = "INSERTION CONFIRMED";
    else if (S.seq === "destruct") markLine.textContent = "VEHICLE LOST";
    else markLine.textContent = "TERMINAL COUNT RUNNING";

    /* annunciators */
    var act = {};
    activeAlarms().forEach(function (a) {
      act[a] = true;
    });
    Object.keys(ALARMS).forEach(function (k) {
      var el = $(ALARMS[k].el);
      var on = act[ALARMS[k].text] || S.lampsTest;
      var flash = on && !S.lampsTest && !acked[k];
      el.className =
        "ann" +
        (on
          ? k === "arm" || k === "helium"
            ? " lit-amber"
            : " lit-red"
          : "") +
        (flash ? " flash" : "");
    });
    var ringing = false;
    Object.keys(act).forEach(function (k) {
      if (!acked[k]) ringing = true;
    });
    $("horn-flag").className =
      "horn-flag" + (ringing && S.bus ? " ringing" : "");

    /* jewels */
    jewel($("jw-bus"), S.bus ? "green lit" : "");
    jewel(
      $("jw-clear"),
      S.padClear ? "green lit" : S.seq === "count" ? "red-j lit" : "",
    );
    jewel($("jw-arms"), S.armsRetracted ? "green lit" : "amber-j lit");
    jewel(
      $("jw-deluge"),
      S.delugePress >= 85
        ? "green lit"
        : S.delugePress >= 30
          ? "amber-j lit"
          : S.lampsTest
            ? "amber-j lit"
            : "",
    );

    /* needles */
    setNeedle("lox", S.loxP);
    setNeedle("rp1", S.rp1P);
    setNeedle("he", S.he);
    setNeedle("align", S.align);

    /* drums */
    drum($("drum-lox"), fmtLoad(S.loxMass));
    drum($("drum-rp1"), fmtLoad(S.rp1Mass));
    $("drum-alt").querySelector("span").textContent = String(
      Math.round(Math.min(S.altKm, 999)),
    ).padStart(3, "0");
    $("drum-vel").querySelector("span").textContent = String(
      Math.round(Math.min(S.velMs, 9999)),
    ).padStart(4, "0");

    /* periscope */
    var retract = S.armsRetracted ? -42 : 0;
    $("arm-a").setAttribute("transform", "rotate(" + retract + " 208 84)");
    $("arm-b").setAttribute("transform", "rotate(" + retract + " 208 132)");

    var air = $("airframe"),
      plume = $("plume"),
      wreck = $("wreck"),
      puffs = $("vent-puffs"),
      smoke = $("smoke");
    var lifting = S.seq === "flight";
    var rise = lifting ? Math.min(S.t * 30, 300) : 0;
    var dy = lifting ? -Math.max(0, rise) : 0;
    var dxv = lifting && S.t > 20 ? -(S.t - 20) * 0.55 : 0;
    $("missile").setAttribute(
      "transform",
      "translate(" + dxv.toFixed(1) + " " + dy.toFixed(1) + ")",
    );

    air.style.display = S.destructed ? "none" : "";
    wreck.style.opacity = S.destructed ? 1 : 0;

    var flick =
      1 + 0.14 * Math.sin(S.simTime * 21) + 0.08 * Math.sin(S.simTime * 47);
    var pOp =
      S.thrust > 0.02 && !S.destructed ? Math.min(1, S.thrust * 1.2) : 0;
    plume.setAttribute("opacity", pOp.toFixed(2));
    if (pOp > 0) {
      q(plume, "#plume-body").setAttribute(
        "d",
        "M352 210 q14 " +
          (26 * flick).toFixed(1) +
          " 16 " +
          (52 * flick).toFixed(1) +
          " q2 -22 16 -" +
          (52 * flick).toFixed(1) +
          " z",
      );
    }

    var venting =
      (S.selMode === 1 || S.selMode === 2 || (S.ventOpen && S.bus)) &&
      !lifting &&
      !S.destructed &&
      S.bus;
    puffs.setAttribute(
      "opacity",
      venting ? (0.55 + 0.35 * Math.sin(S.simTime * 2.1)).toFixed(2) : 0,
    );

    if (lifting && S.t < 14) {
      smoke.setAttribute("opacity", Math.max(0, 0.5 - S.t * 0.035).toFixed(2));
      smoke.setAttribute("rx", (20 + S.t * 16).toFixed(1));
      smoke.setAttribute("ry", (8 + S.t * 5).toFixed(1));
    } else if (S.destructed) {
      smoke.setAttribute("opacity", "0.65");
      smoke.setAttribute("rx", "150");
      smoke.setAttribute("ry", "46");
    } else {
      smoke.setAttribute("opacity", "0");
    }

    var cam = $("cam-state");
    cam.textContent =
      S.seq === "destruct"
        ? "VEHICLE LOST"
        : S.seq === "orbit"
          ? "IN ORBIT"
          : S.seq === "flight"
            ? "AIRBORNE"
            : S.seq === "aborted"
              ? "PAD ABORT"
              : S.seq === "count"
                ? "TERMINAL COUNT"
                : S.seq === "hold"
                  ? "HOLD"
                  : "PAD SAFE";
    $("cam-alt").textContent =
      "ALT " + (S.altKm > 0 ? Math.round(S.altKm) + " KM" : "---");

    /* armed glow on the start key when all-go */
    var goBtn = els.start;
    if (goCheck(true).ok && S.seq === "ready") goBtn.classList.add("armed");
    else goBtn.classList.remove("armed");
  }

  function jewel(el, cls) {
    el.className = "jewel" + (cls ? " " + cls : "");
  }

  function setNeedle(key, v) {
    var def = meterDefs[key],
      nv = Math.max(0, Math.min(def.max, v));
    var ang = -84 + 168 * (nv / def.max);
    needleEls[key].setAttribute(
      "transform",
      "rotate(" + ang.toFixed(1) + " 60 66)",
    );
  }

  function fmtLoad(v) {
    var x = Math.max(0, Math.min(99.9, v));
    var whole = String(Math.floor(x));
    if (whole.length < 2) whole = "0" + whole;
    var tenths = String(Math.floor((x * 10) % 10));
    return whole + "." + tenths;
  }

  function drum(el, str) {
    var spans = el.querySelectorAll("span");
    var chars = ["0", "0", ".", "0"];
    for (var i = 0; i < 4; i++) chars[i] = str[i];
    spans.forEach(function (sp, j) {
      sp.textContent = chars[j];
    });
  }

  /* --------------------------- sequencing ----------------------------- */

  function goCheck(quiet) {
    var fails = [];
    if (!S.bus) fails.push("BUS OFF");
    if (!S.padClear) fails.push("NOT PAD CLEAR");
    if (!S.armsRetracted) fails.push("ARMS CONNECTED");
    if (S.loxMass < 97) fails.push("LOX LOAD");
    if (S.rp1Mass < 98) fails.push("RP-1 LOAD");
    if (S.loxP < 14) fails.push("LOX PRESS");
    if (S.rp1P < 11) fails.push("RP-1 PRESS");
    if (!S.compOn || S.compWarm < 5) fails.push("COMPUTER");
    if (S.align < 95) fails.push("GUIDANCE ALIGN");
    if (S.gmode !== 3) fails.push("GUIDANCE NOT IN FLY");
    if (S.delugePress < 50) fails.push("DELUGE PRESS");
    if (S.abortLatch) fails.push("ABORT LATCH");
    if (quiet) return { ok: fails.length === 0 };
    return { ok: fails.length === 0, first: fails[0] || "" };
  }

  function say(msg) {
    S.noGoMsg = msg;
    S.noGoUntil = performance.now() + 2400;
  }

  function raiseAlarmWave() {
    var act = {};
    var list = activeAlarms();
    list.forEach(function (a) {
      act[a] = true;
    });
    var isNew = list.some(function (a) {
      return !lastAlarmSet[a];
    });
    if (isNew && list.length && S.bus && audioArmed) horn();
    lastAlarmSet = act;
  }

  /* deterministic physics step */
  function step(dt) {
    S.simTime += dt;

    if (!S.bus) {
      /* dead panel: slow bleed only */
      S.delugePress = Math.max(0, S.delugePress - dt);
      return;
    }

    var counting = S.seq === "count";

    /* --- propellant transfer --- */
    if (
      counting === false &&
      (S.seq === "ready" ||
        S.seq === "hold" ||
        S.seq === "cold" ||
        S.seq === "aborted")
    ) {
      if (S.padClear && S.selMode === 1 && !S.abortLatch) {
        var capL = S.ventOpen ? 2.4 : 1.15;
        S.loxMass = Math.min(97, S.loxMass + capL * dt);
        S.rp1Mass = Math.min(98, S.rp1Mass + 3.1 * dt);
      } else if (S.padClear && S.selMode === 2 && !S.abortLatch) {
        S.loxMass = Math.min(100, S.loxMass + 0.4 * dt);
        S.rp1Mass = Math.min(100, S.rp1Mass + 0.45 * dt);
      }
    }

    /* --- ullage thermodynamics --- */
    var boilL = 0.06,
      boilR = 0.04;
    if (S.ventOpen) {
      boilL += 0.5;
      boilR += 0.25;
    }
    if (S.faults.pressure) {
      boilL += 0.38;
      boilR += 0.3;
      S.he -= 30 * dt;
    }

    if (S.selMode === 3 && !S.ventOpen && !S.faults.pressure && S.he > 50) {
      S.loxP += (18 - S.loxP) * Math.min(1, 0.09 * dt);
      S.rp1P += (15 - S.rp1P) * Math.min(1, 0.09 * dt);
      S.he -= 3.4 * dt;
    }
    S.he = Math.max(0, S.he);
    S.loxP = Math.max(0, S.loxP - boilL * dt);
    S.rp1P = Math.max(0, S.rp1P - boilR * dt);

    /* emergency repress pulse */
    if (S.repress > 0 && S.he > 50) {
      S.repress -= dt;
      S.he -= 55 * dt;
      S.loxP += 2.4 * dt;
      S.rp1P += 2.0 * dt;
      S.loxP = Math.min(24, S.loxP);
      S.rp1P = Math.min(22, S.rp1P);
    }

    /* --- delude... deluge water --- */
    if (S.delugeRun && !S.faults.deluge)
      S.delugePress = Math.min(120, S.delugePress + 9 * dt);
    else
      S.delugePress = Math.max(
        0,
        S.delugePress - (S.faults.deluge ? 6 : 0.8) * dt,
      );

    /* --- guidance computer --- */
    if (S.compOn && S.compWarm < 6) S.compWarm += dt;
    if (S.gmode === 2 && S.compOn && S.compWarm >= 5) {
      S.align = Math.min(100, S.align + 4 * dt);
    } else if (S.gmode < 2 || !S.compOn) {
      S.align = Math.max(0, S.align - (S.compOn ? 0.5 : 2) * dt);
    }

    /* --- terminal count --- */
    if (S.seq === "count") {
      S.t += dt;

      /* auto-hold: arms must be retracted by T-60 */
      if (S.t >= -60 && !S.armsRetracted) {
        S.t = -60;
        S.seq = "hold";
        S.holdCause = "arms";
      }
      /* auto-abort: deluge lost late in the count */
      if (
        S.seq === "count" &&
        S.t >= -4.2 &&
        S.delugePress < 50 &&
        !S.abortLatch
      ) {
        fireAbort("DELUGE PRESS LOW");
      }
      /* auto-abort: ullage pressures below engine-start limits */
      if (
        S.seq === "count" &&
        S.t >= -3.5 &&
        (S.loxP < 14 || S.rp1P < 11) &&
        !S.abortLatch
      ) {
        fireAbort("ULLAGE PRESS LOW");
      }
      /* auto-hold: guidance must be aligned by T-31 */
      if (S.seq === "count" && S.t >= -31 && (S.align < 95 || !S.compOn)) {
        S.t = -31;
        S.seq = "hold";
        S.holdCause = "guid";
      }
      if (S.seq === "count" && S.t >= -3 && S.thrust === 0) {
        S.thrust = Math.min(1, S.thrust + 0.34 * dt);
        if (Math.abs(S.t - -3) < dt * 1.5) rumble();
      }
      if (S.t >= 0) beginFlight();
    }

    /* --- flight --- */
    if (S.seq === "flight") {
      S.t += dt;
      var tau = S.t;
      if (tau < 2.5) {
        S.altKm = 0;
        S.velMs = Math.max(0, S.velMs);
      } else {
        var u = tau - 2.5;
        if (u < 149.5) {
          S.velMs = 17 * u - 376 * (1 - Math.exp(-u / 40));
          S.altKm = 0.0085 * u * u;
        } else if (tau < 166) {
          S.velMs += 380 * dt;
          S.altKm += (S.velMs * dt) / 1000;
        } else {
          S.velMs = 7793;
          S.altKm = 185;
          S.seq = "orbit";
          tone(880, 0.5, "sine", 0.05, 0);
          tone(1175, 0.6, "sine", 0.05, 0.25);
        }
      }
      if (tau >= 152) S.thrust = Math.max(0, S.thrust - 0.8 * dt);

      /* guidance loss in flight ends badly */
      if (S.faults.guidance || (!S.compOn && S.gmode === 3)) {
        S.attErr = Math.min(40, S.attErr + 2.2 * dt);
        if (S.attErr > 14 && !S.destructed) fireDestruct();
      } else {
        S.attErr = Math.max(0, S.attErr - 3 * dt);
      }
    }

    if (S.seq === "hold") {
      if (S.holdCause === "arms" && S.armsRetracted) {
        S.seq = "count";
        S.holdCause = "";
      } else if (S.holdCause === "guid" && S.align >= 95 && S.compOn) {
        S.seq = "count";
        S.holdCause = "";
      }
    }
  }

  function beginFlight() {
    S.seq = "flight";
    S.t = 0;
    S.thrust = 1;
    rumble();
  }

  function fireAbort(reason) {
    S.seq = "aborted";
    S.abortLatch = true;
    S.thrust = 0;
    say("ABORT: " + reason);
    klaxon();
  }

  function fireDestruct() {
    S.destructed = true;
    S.seq = "destruct";
    S.thrust = 0;
    boom();
  }

  /* ------------------------------ API -------------------------------- */

  function state() {
    return {
      phase: S.seq,
      countSeconds: Math.round(S.t),
      markSeconds: S.mark,
      busEnergised: !!S.bus,
      padClear: !!S.padClear,
      serviceArmsRetracted: !!S.armsRetracted,
      propellantSelector: ["OFF", "LOAD", "TOP OFF", "PRESS"][S.selMode],
      loxVentOpen: !!S.ventOpen,
      delugePumpRunning: !!S.delugeRun,
      delugePressure: round1(S.delugePress),
      heliumPressure: round1(S.he),
      loxUllagePsi: round1(S.loxP),
      rp1UllagePsi: round1(S.rp1P),
      loxLoadPercent: round1(S.loxMass),
      rp1LoadPercent: round1(S.rp1Mass),
      guidanceMode: ["OFF", "WARM UP", "ALIGN", "FLY"][S.gmode],
      computerRunning: !!S.compOn,
      guidanceAlignment: round1(S.align),
      thrustPercent: Math.round(S.thrust * 100),
      altitudeKm: round1(S.altKm),
      velocityMs: Math.round(S.velMs),
      attitudeErrorDeg: round1(S.attErr),
      abortLatchSet: !!S.abortLatch,
      vehicleLost: !!S.destructed,
      alarms: activeAlarms(),
    };
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return;
    var total = Math.min(seconds, 3600);
    var h = 0.02;
    while (total > 0) {
      var dt = Math.min(h, total);
      step(dt);
      total -= dt;
    }
    raiseAlarmWave();
  }

  function inject(fault) {
    var i = FAULTS.indexOf(fault);
    if (i === -1) throw new Error("unknown fault: " + fault);
    if (i === 0) {
      S.faults.pressure = true;
      syncFaultSwitches();
    } else if (i === 1) {
      S.faults.guidance = true;
      S.compOn = false;
      syncFaultSwitches();
    } else {
      S.faults.deluge = true;
      syncFaultSwitches();
    }
  }

  function clearFault(fault) {
    var i = FAULTS.indexOf(fault);
    if (i === -1) throw new Error("unknown fault: " + fault);
    if (i === 0) S.faults.pressure = false;
    else if (i === 1) S.faults.guidance = false;
    else S.faults.deluge = false;
    syncFaultSwitches();
  }

  function resetAll() {
    S = fresh();
    acked = {};
    lastAlarmSet = {};
    syncFaultSwitches();
    syncToggles();
  }

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: resetAll,
  };

  /* --------------------------- panel wiring --------------------------- */

  var acked = {};

  function wire() {
    /* gesture → audio */
    window.addEventListener("pointerdown", armAudio, { once: false });
    window.addEventListener("keydown", armAudio, { once: false });

    els.digits = {};
    DIGIT_KEYS.forEach(function (k) {
      els.digits[k] = q(document, '[data-d="' + k + '"]');
    });
    els.start = $("ctl-start");

    /* key switches */
    bindToggle($("ctl-bus"), function () {
      if (S.seq === "flight" || S.seq === "orbit" || S.seq === "destruct")
        return false;
      S.bus = !S.bus;
      relayClick();
      if (!S.bus) {
        S.compWarm = 0;
      }
      return true;
    });
    bindToggle($("ctl-clear"), function () {
      if (S.seq === "flight" || S.seq === "orbit" || S.seq === "destruct")
        return false;
      S.padClear = !S.padClear;
      relayClick();
      return true;
    });

    bindToggle(
      $("ctl-arms"),
      function () {
        S.armsRetracted = !S.armsRetracted;
        relayClick();
        return true;
      },
      true,
    );
    bindToggle(
      $("ctl-vent"),
      function () {
        S.ventOpen = !S.ventOpen;
        relayClick();
        return true;
      },
      true,
    );
    bindToggle(
      $("ctl-deluge"),
      function () {
        S.delugeRun = !S.delugeRun;
        relayClick();
        if (S.delugeRun) say("DELUGE PUMP RUNNING");
        return true;
      },
      true,
    );

    /* rotaries */
    rotary($("ctl-sel"), ["OFF", "LOAD", "TOP OFF", "PRESS"], function (v) {
      S.selMode = v;
      relayClick();
      return true;
    });
    rotary($("ctl-gmode"), ["OFF", "WARM UP", "ALIGN", "FLY"], function (v) {
      S.gmode = v;
      relayClick();
      if (v === 1 && S.compOn) say("COMPUTER WARMING");
      return true;
    });
    rotary(
      $("ctl-recycle"),
      ["RUN", "T\u2212180", "T\u221260", "T\u221231"],
      function (v, label) {
        if (v === 0) return true;
        if (S.seq === "flight" || S.seq === "orbit" || S.seq === "destruct") {
          say("NO RECYCLE IN FLIGHT");
          return false;
        }
        var marks = [0, 180, 60, 31];
        S.mark = marks[v];
        S.t = -marks[v];
        S.seq = "ready";
        S.thrust = 0;
        S.holdCause = "";
        relayClick();
        say("RECYCLED TO " + label);
        return true;
      },
    );

    /* pushes */
    momentary($("ctl-lamps"), function () {
      S.lampsTest = !S.lampsTest;
      return true;
    });

    momentary($("ctl-greset"), function () {
      if (!S.bus) {
        say("BUS OFF");
        return false;
      }
      S.compOn = true;
      S.compWarm = 0;
      S.align = 0;
      say("COMPUTER RESTART \u2014 WARM-UP 5 SEC");
      relayClick();
      return true;
    });

    momentary($("ctl-hold"), function () {
      if (S.seq === "count") {
        S.seq = "hold";
        S.holdCause = "manual";
        relayClick();
        return true;
      }
      if (S.seq === "hold" && S.holdCause === "manual") {
        S.seq = "count";
        S.holdCause = "";
        relayClick();
        return true;
      }
      if (S.seq === "hold") {
        say("HOLD IS INTERLOCK \u2014 CLEAR CAUSE");
        return false;
      }
      say("COUNT NOT RUNNING");
      return false;
    });

    momentary($("ctl-abortreset"), function () {
      if (!S.abortLatch) {
        say("NO ABORT LATCHED");
        return false;
      }
      if (S.loxMass >= 60 && (S.loxP < 14 || S.rp1P < 11)) {
        say("RESTORE ULLAGE FIRST");
        return false;
      }
      if (S.delugePress < 50) {
        say("RESTORE DELUGE FIRST");
        return false;
      }
      S.abortLatch = false;
      S.seq = "ready";
      S.mark = S.mark || 180;
      S.t = -S.mark;
      S.thrust = 0;
      relayClick();
      say("ABORT LATCH CLEARED");
      return true;
    });

    momentary($("ctl-ack"), function () {
      activeAlarms().forEach(function (a) {
        Object.keys(ALARMS).forEach(function (k) {
          if (ALARMS[k].text === a) acked[k] = true;
        });
      });
      hornStopAt = 0;
      relayClick();
      return true;
    });

    momentary($("ctl-reset"), function () {
      resetAll();
      say("PANEL RESET \u2014 SYSTEM COLD");
      return true;
    });

    /* guarded controls */
    guard($("guard-he"), $("ctl-he"), function () {
      if (!S.bus || S.he < 50) {
        if (S.he < 50) say("HELIUM BOTTLE EMPTY");
        return false;
      }
      S.repress = 2;
      noiseBurst(0.5, 0.1, 700);
      say("EMERGENCY REPRESS PULSE");
      return true;
    });
    guard($("guard-start"), els.start, function () {
      if (!(S.bus || S.padClear)) {
        say("GO TO READY FIRST");
        return false;
      }
      if (S.seq === "count") {
        say("COUNT ALREADY RUNNING");
        return false;
      }
      if (S.seq === "flight" || S.seq === "orbit" || S.seq === "destruct") {
        say("VEHICLE AWAY");
        return false;
      }
      var g = goCheck(false);
      if (!g.ok) {
        say("NO-GO: " + g.first);
        klaxon();
        return false;
      }
      if (S.seq !== "ready" && S.seq !== "hold") S.seq = "ready";
      if (S.t > -3) S.t = -S.mark;
      S.seq = "count";
      S.holdCause = "";
      acked = {};
      lastAlarmSet = {};
      var gw = $("guard-start");
      gw.classList.remove("open");
      gw.querySelector(".guard-cover").setAttribute("aria-expanded", "false");
      els.start.tabIndex = -1;
      relayClick();
      say("AUTO SEQUENCE RUNNING");
      return true;
    });

    /* fault bank */
    var lid = $("fault-lid");
    lid.querySelector(".lid").addEventListener("click", function () {
      var open = lid.classList.toggle("open");
      this.setAttribute("aria-expanded", open ? "true" : "false");
      relayClick();
      lid.querySelectorAll(".ftoggle").forEach(function (b) {
        b.tabIndex = open ? 0 : -1;
      });
    });
    lid.querySelectorAll(".ftoggle").forEach(function (b) {
      b.tabIndex = -1;
      b.addEventListener("click", function () {
        var f = b.getAttribute("data-fault");
        if (b.getAttribute("aria-pressed") === "true") clearFault(f);
        else inject(f);
        relayClick();
      });
    });

    /* manual dialog */
    var dialog = $("manual-dialog");
    document
      .querySelector('[data-action="manual"]')
      .addEventListener("click", function () {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      });
    document
      .querySelector('[data-action="close-manual"]')
      .addEventListener("click", function () {
        dialog.close ? dialog.close() : dialog.removeAttribute("open");
      });

    initMeters();
    resetAll();
  }

  /* control helpers ---------------------------------------------------- */

  function bindToggle(btn, fn, allowFlight) {
    btn.addEventListener("click", function () {
      var changed = fn();
      if (changed !== false) syncOne(btn);
    });
  }

  function syncOne(btn) {
    var key = btn.id;
    switch (key) {
      case "ctl-bus":
        btn.setAttribute("aria-pressed", S.bus ? "true" : "false");
        break;
      case "ctl-clear":
        btn.setAttribute("aria-pressed", S.padClear ? "true" : "false");
        break;
      case "ctl-arms":
        btn.setAttribute("aria-pressed", S.armsRetracted ? "true" : "false");
        break;
      case "ctl-vent":
        btn.setAttribute("aria-pressed", S.ventOpen ? "true" : "false");
        break;
      case "ctl-deluge":
        btn.setAttribute("aria-pressed", S.delugeRun ? "true" : "false");
        break;
    }
  }

  function syncToggles() {
    ["ctl-bus", "ctl-clear", "ctl-arms", "ctl-vent", "ctl-deluge"].forEach(
      function (id) {
        syncOne($(id));
      },
    );
    [$("ctl-sel"), $("ctl-gmode"), $("ctl-recycle")].forEach(function (r) {
      r.dispatchEvent(new CustomEvent("syncrot"));
    });
  }

  function syncFaultSwitches() {
    document.querySelectorAll(".ftoggle").forEach(function (b) {
      var f = b.getAttribute("data-fault");
      var on =
        (f === FAULTS[0] && S.faults.pressure) ||
        (f === FAULTS[1] && S.faults.guidance) ||
        (f === FAULTS[2] && S.faults.deluge);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function rotary(btn, labels, apply) {
    var val = 0;
    function paint() {
      btn.setAttribute("aria-valuenow", String(val));
      btn.setAttribute("aria-valuetext", labels[val]);
      var knob = btn.querySelector(".knob");
      var angles = [-135, -45, 45, 135];
      knob.style.transform = "rotate(" + angles[val] + "deg)";
    }
    function setTo(v, announce) {
      val = Math.max(0, Math.min(labels.length - 1, v));
      paint();
      if (announce !== false) apply(val, labels[val]);
    }
    btn.addEventListener("click", function () {
      setTo((val + 1) % labels.length);
    });
    btn.addEventListener("keydown", function (e) {
      var d = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") d = 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -1;
      else if (e.key === "Home") {
        e.preventDefault();
        setTo(0);
        return;
      } else if (e.key === "End") {
        e.preventDefault();
        setTo(labels.length - 1);
        return;
      }
      if (d !== 0) {
        e.preventDefault();
        setTo(val + d);
      }
    });
    btn.addEventListener("syncrot", function () {
      val = currentRotValue(btn.id);
      paint();
    });
    paint();
  }

  function currentRotValue(id) {
    if (id === "ctl-sel") return S.selMode;
    if (id === "ctl-gmode") return S.gmode;
    return 0;
  }

  function momentary(btn, fn) {
    btn.addEventListener("click", function () {
      fn();
    });
  }

  function guard(wrap, inner, fn) {
    var cover = wrap.querySelector(".guard-cover");
    cover.addEventListener("click", function () {
      var open = wrap.classList.toggle("open");
      cover.setAttribute("aria-expanded", open ? "true" : "false");
      inner.tabIndex = open ? 0 : -1;
      if (open) {
        inner.focus({ preventScroll: true });
        relayClick();
      }
    });
    inner.addEventListener("click", function () {
      if (!wrap.classList.contains("open")) return;
      fn();
    });
    inner.tabIndex = -1;
  }

  /* ------------------------------- loop ------------------------------- */

  var rafId = null,
    lastStamp = 0;

  function frame(stamp) {
    rafId = requestAnimationFrame(frame);
    var dt = (stamp - lastStamp) / 1000;
    lastStamp = stamp;
    if (dt > 0.25) dt = 0.25;
    if (dt > 0) tick(dt);
    render(stamp);
  }

  function startLoop() {
    if (rafId !== null) return;
    lastStamp = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopLoop();
    else startLoop();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else boot();

  function boot() {
    wire();
    render(performance.now());
    startLoop();
  }
})();
