/* =====================================================================
   HALCYON H.86 MERIDIAN — flight engineer's station
   Four Halcyon Kestrel-9 radials, fuel system, airframe performance,
   warning circuits. Classic script, IIFE, exposes window.machine.
   ===================================================================== */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  /* ------------------------------ helpers ------------------------------ */
  function $(sel) {
    return document.querySelector(sel);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function norm(s) {
    return String(s == null ? "" : s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function sv(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  /* --------------------------- dial construction ------------------------
     Matte-black faces, ivory numerals, chrome bezel, red limit arc —
     1954 British cockpit practice. Sweep runs -125deg .. +125deg.       */
  function angleFor(v, min, max) {
    return -125 + ((clamp(v, min, max) - min) / (max - min)) * 250;
  }

  function drawDial(slot, opt) {
    var size = opt.size || 88;
    slot.style.minHeight = size + 8 + "px";
    var svg = sv(
      "svg",
      {
        viewBox: "0 0 100 100",
        width: size,
        height: size,
        class: "gauge-svg",
        "aria-hidden": "true",
      },
      slot,
    );
    sv("circle", { cx: 50, cy: 50, r: 49, fill: "url(#bezel)" }, svg);
    sv(
      "circle",
      {
        cx: 50,
        cy: 50,
        r: 43,
        fill: "#121417",
        stroke: "#000",
        "stroke-width": 1,
      },
      svg,
    );

    if (opt.redFrom != null) {
      var a0 = angleFor(opt.redFrom, opt.min, opt.max) - 90;
      var a1 = angleFor(opt.max, opt.min, opt.max) - 90;
      var large = a1 - a0 > 180 ? 1 : 0;
      var r0 = 37;
      var x0 = 50 + r0 * Math.cos((a0 * Math.PI) / 180),
        y0 = 50 + r0 * Math.sin((a0 * Math.PI) / 180);
      var x1 = 50 + r0 * Math.cos((a1 * Math.PI) / 180),
        y1 = 50 + r0 * Math.sin((a1 * Math.PI) / 180);
      sv(
        "path",
        {
          d:
            "M " +
            x0.toFixed(2) +
            " " +
            y0.toFixed(2) +
            " A " +
            r0 +
            " " +
            r0 +
            " 0 " +
            large +
            " 1 " +
            x1.toFixed(2) +
            " " +
            y1.toFixed(2),
          stroke: "#c8281c",
          "stroke-width": 4.5,
          fill: "none",
        },
        svg,
      );
    }
    if (opt.greenBand) {
      var g0 = angleFor(opt.greenBand[0], opt.min, opt.max) - 90;
      var g1 = angleFor(opt.greenBand[1], opt.min, opt.max) - 90;
      var glarge = g1 - g0 > 180 ? 1 : 0;
      var rg = 41.5;
      var gx0 = 50 + rg * Math.cos((g0 * Math.PI) / 180),
        gy0 = 50 + rg * Math.sin((g0 * Math.PI) / 180);
      var gx1 = 50 + rg * Math.cos((g1 * Math.PI) / 180),
        gy1 = 50 + rg * Math.sin((g1 * Math.PI) / 180);
      sv(
        "path",
        {
          d:
            "M " +
            gx0.toFixed(2) +
            " " +
            gy0.toFixed(2) +
            " A " +
            rg +
            " " +
            rg +
            " 0 " +
            glarge +
            " 1 " +
            gx1.toFixed(2) +
            " " +
            gy1.toFixed(2),
          stroke: "#2e7d4f",
          "stroke-width": 3,
          fill: "none",
        },
        svg,
      );
    }
    var step = opt.tickStep || (opt.max - opt.min) / 10;
    for (var v = opt.min; v <= opt.max + 1e-9; v += step) {
      var ang = ((angleFor(v, opt.min, opt.max) - 90) * Math.PI) / 180;
      var major = opt.majorStep || step;
      var isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      var r1 = isMajor ? 31 : 35.5,
        r2 = 39;
      sv(
        "line",
        {
          x1: (50 + r1 * Math.cos(ang)).toFixed(2),
          y1: (50 + r1 * Math.sin(ang)).toFixed(2),
          x2: (50 + r2 * Math.cos(ang)).toFixed(2),
          y2: (50 + r2 * Math.sin(ang)).toFixed(2),
          stroke: "#e8e2ce",
          "stroke-width": isMajor ? 1.6 : 0.7,
        },
        svg,
      );
      if (isMajor && opt.numerals !== false) {
        var rl = 24.5;
        var t = sv(
          "text",
          {
            x: (50 + rl * Math.cos(ang)).toFixed(2),
            y: (50 + rl * Math.sin(ang) + 2.6).toFixed(2),
            "text-anchor": "middle",
            "font-size": opt.numSize || 7.5,
            fill: "#efe8d2",
            "font-family": "Arial Narrow, Arial, sans-serif",
          },
          svg,
        );
        t.textContent = opt.numFormat
          ? opt.numFormat(v)
          : String(Math.round(v));
      }
    }
    if (opt.caption) {
      var cap = sv(
        "text",
        {
          x: 50,
          y: 66,
          "text-anchor": "middle",
          "font-size": 6.4,
          fill: "#b9b29a",
          "font-family": "Arial Narrow, Arial, sans-serif",
          "letter-spacing": "0.6",
        },
        svg,
      );
      cap.textContent = opt.caption;
    }
    var needle = sv(
      "polygon",
      { points: "50,14 47.6,52 52.4,52", fill: "#f4efe2" },
      svg,
    );
    sv("circle", { cx: 50, cy: 50, r: 4.6, fill: "url(#hub)" }, svg);

    return {
      set: function (val) {
        needle.setAttribute(
          "transform",
          "rotate(" + angleFor(val, opt.min, opt.max).toFixed(2) + " 50 50)",
        );
      },
    };
  }

  /* slim horizontal strip gauge */
  function drawStrip(slot, opt) {
    slot.classList.add("half");
    var svg = sv(
      "svg",
      {
        viewBox: "0 0 120 26",
        width: "100%",
        class: "gauge-svg",
        "aria-hidden": "true",
      },
      slot,
    );
    sv(
      "rect",
      {
        x: 0.5,
        y: 0.5,
        width: 119,
        height: 25,
        rx: 2,
        fill: "#121417",
        stroke: "#000",
      },
      svg,
    );
    var x = 26,
      w = 76,
      y = 8;
    if (opt.redAbove != null) {
      var ra = x + (w * (opt.redAbove - opt.min)) / (opt.max - opt.min);
      sv(
        "rect",
        {
          x: ra.toFixed(2),
          y: y,
          width: (x + w - ra).toFixed(2),
          height: 10,
          fill: "#c8281c",
          opacity: 0.85,
        },
        svg,
      );
    }
    if (opt.redBelow != null) {
      var rb = x + (w * (opt.redBelow - opt.min)) / (opt.max - opt.min);
      sv(
        "rect",
        {
          x: x,
          y: y,
          width: rb.toFixed(2) - x,
          height: 10,
          fill: "#c8281c",
          opacity: 0.85,
        },
        svg,
      );
    }
    sv(
      "rect",
      {
        x: x,
        y: y,
        width: w,
        height: 10,
        fill: "none",
        stroke: "#3a4046",
        "stroke-width": 1,
      },
      svg,
    );
    var lab = sv(
      "text",
      {
        x: 3,
        y: 16,
        "font-size": 6.5,
        fill: "#b9b29a",
        "font-family": "Arial Narrow, Arial, sans-serif",
        "letter-spacing": "0.4",
      },
      svg,
    );
    lab.textContent = opt.label;
    var valTxt = sv(
      "text",
      {
        x: 117,
        y: 23.5,
        "text-anchor": "end",
        "font-size": 7.4,
        fill: "#efe8d2",
        "font-family": "Courier New, monospace",
        "font-weight": "bold",
      },
      svg,
    );
    var cursor = sv(
      "rect",
      { x: x, y: y - 1, width: 3, height: 12, fill: "#f4efe2" },
      svg,
    );
    return {
      set: function (v) {
        var f = clamp((v - opt.min) / (opt.max - opt.min), 0, 1);
        cursor.setAttribute("x", (x + f * w - 1.5).toFixed(2));
        valTxt.textContent =
          opt.decimals != null
            ? v.toFixed(opt.decimals)
            : String(Math.round(v));
      },
    };
  }

  /* mechanical drum counter (fuel flow) */
  function drawDrum(slot, opt) {
    slot.classList.add("half");
    var wrap = el("div", "drum", slot);
    el("span", "drum-label", wrap, opt.label);
    var win = el("span", "drum-window", wrap, "0000");
    return {
      set: function (v) {
        win.textContent = String(Math.round(clamp(v, 0, 9999))).padStart(
          4,
          "0",
        );
      },
    };
  }

  /* shared defs */
  (function defs() {
    var holder = sv(
      "svg",
      {
        width: 0,
        height: 0,
        "aria-hidden": "true",
        style: "position:absolute",
      },
      document.body,
    );
    var d = sv("defs", {}, holder);
    var lin = sv(
      "linearGradient",
      { id: "bezel", x1: 0, y1: 0, x2: 0.4, y2: 1 },
      d,
    );
    sv("stop", { offset: "0", "stop-color": "#dfe4e8" }, lin);
    sv("stop", { offset: "0.45", "stop-color": "#7c858d" }, lin);
    sv("stop", { offset: "1", "stop-color": "#33383d" }, lin);
    var hub = sv("radialGradient", { id: "hub" }, d);
    sv("stop", { offset: "0", "stop-color": "#e8c87c" }, hub);
    sv("stop", { offset: "0.7", "stop-color": "#ad7f2f" }, hub);
    sv("stop", { offset: "1", "stop-color": "#5e4212" }, hub);
  })();

  /* ------------------------------ rotary ------------------------------- */
  function buildRotary(host, positions, initial, onChange, caption) {
    host.innerHTML = "";
    var stage = el("div", "rotary-stage", host);
    var ringSvg = sv(
      "svg",
      { class: "rotary-ring", viewBox: "0 0 100 100" },
      stage,
    );
    var knob = el("button", "rotary-knob", stage);
    knob.type = "button";
    var idx = initial;

    function layout() {
      ringSvg.innerHTML = "";
      var n = positions.length;
      for (var i = 0; i < n; i++) {
        var a =
          ((-125 + (n === 1 ? 125 : (i * 250) / (n - 1))) * Math.PI) / 180;
        var t = sv(
          "text",
          {
            x: (50 + 43 * Math.cos(a - Math.PI / 2)).toFixed(2),
            y: (50 + 43 * Math.sin(a - Math.PI / 2) + 2.6).toFixed(2),
            "text-anchor": "middle",
            "font-size": 9,
            class: "rotary-label" + (i === idx ? " rotary-label-on" : ""),
          },
          ringSvg,
        );
        t.textContent = positions[i].label;
      }
      var ang = -125 + (n === 1 ? 125 : (idx * 250) / (n - 1));
      knob.setAttribute("aria-valuetext", positions[idx].label);
      knob.style.transform = "rotate(" + ang.toFixed(2) + "deg)";
    }
    function setIdx(i) {
      idx = clamp(i, 0, positions.length - 1);
      layout();
      onChange(positions[idx].value, idx);
    }
    knob.addEventListener("click", function () {
      setIdx(idx + 1 >= positions.length ? 0 : idx + 1);
    });
    knob.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        setIdx(idx + 1);
        e.preventDefault();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        setIdx(idx - 1);
        e.preventDefault();
      }
    });
    if (caption) el("span", "rotary-caption", host, caption);
    setIdx(initial);
    return {
      set: function (i) {
        idx = clamp(i, 0, positions.length - 1);
        layout();
      },
      get: function () {
        return positions[idx].value;
      },
    };
  }

  /* ------------------------------ levers ------------------------------- */

  function buildLever(host, opt) {
    var lv = el("button", "lever " + (opt.kind || "throttle"), host);
    lv.type = "button";
    lv.setAttribute("role", "slider");
    lv.setAttribute("aria-orientation", "vertical");
    lv.setAttribute("aria-label", opt.label);
    el("span", "slot", lv);
    var arm = el("span", "arm", lv);
    if (opt.tHandle) el("span", "t-handle", arm);
    el("span", "lv-tag", lv, opt.tag);
    var valBubble = el("span", "lever-value", lv, "");

    var value = opt.value;
    function paint() {
      var f = clamp((value - opt.min) / (opt.max - opt.min), 0, 1);
      arm.style.height = 18 + f * 62 + "%";
      valBubble.textContent = opt.format(value);
      lv.setAttribute("aria-valuemin", String(opt.min));
      lv.setAttribute("aria-valuemax", String(opt.max));
      lv.setAttribute("aria-valuenow", String(Math.round(value)));
      lv.setAttribute("aria-valuetext", opt.format(value));
    }
    function setVal(v) {
      value = clamp(v, opt.min, opt.max);
      paint();
      opt.onInput(value);
    }

    function fromEvent(e) {
      var r = lv.getBoundingClientRect();
      var f = 1 - clamp((e.clientY - r.top - 10) / (r.height - 20), 0, 1);
      setVal(opt.min + f * (opt.max - opt.min));
    }
    lv.addEventListener("pointerdown", function (e) {
      lv.setPointerCapture(e.pointerId);
      fromEvent(e);
      var move = function (ev) {
        fromEvent(ev);
      };
      var up = function () {
        lv.removeEventListener("pointermove", move);
        lv.removeEventListener("pointerup", up);
      };
      lv.addEventListener("pointermove", move);
      lv.addEventListener("pointerup", up);
    });
    lv.addEventListener("keydown", function (e) {
      var k = (opt.max - opt.min) / 40;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        setVal(value + k);
        e.preventDefault();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        setVal(value - k);
        e.preventDefault();
      }
      if (e.key === "PageUp") {
        setVal(value + k * 4);
        e.preventDefault();
      }
      if (e.key === "PageDown") {
        setVal(value - k * 4);
        e.preventDefault();
      }
    });
    paint();
    return {
      set: setVal,
      get: function () {
        return value;
      },
    };
  }

  /* ======================================================================
     SIMULATION STATE
     ====================================================================== */
  var ENGINES = 4;
  var REDLINE_CHT = 232;
  var DETONATION_CHT = 262;

  function freshState() {
    return {
      master: false,
      throttle: [0, 0, 0, 0],
      governor: 1900,
      cowl: [0, 0],
      pumps: [false, false, false, false],
      starterSel: 0,
      crossfeed: "NORMAL",
      analyser: 0,

      eng: [],
      tanks: [100, 100, 100, 100],

      alt: 0,
      vs: 0,
      ias: 0,
      oat: 15,
      time: 0,

      faults: { baffle: false, oilline: false, boost: false },
      faultProve: { baffle: 0, oilline: 0, boost: 0 },
      seizeTimer: 0,
      hotAirTimer: 0,
      sinkTimer: 0,
    };
  }

  function freshEngines(S) {
    S.eng = [];
    for (var i = 0; i < ENGINES; i++) {
      S.eng.push({
        running: false,
        cranking: false,
        crankTime: 0,
        rpm: 0,
        map: 0,
        ff: 0,
        cht: 15,
        oilT: 15,
        oilP: 0,
        fp: 0,
        feathered: false,
        seizing: false,
        featherProg: 0,
        lowFpTimer: 0,
      });
    }
  }

  var S = freshState();
  freshEngines(S);
  var accepted = true;
  var lampsTestUntil = 0;

  var ALARM_DEF = [
    { name: "CYL HEAD HOT", sev: "red" },
    { name: "OIL PRESS LOW", sev: "red" },
    { name: "FUEL PRESS LOW", sev: "amber" },
    { name: "TANK IMBALANCE", sev: "amber" },
    { name: "ENGINE OUT", sev: "red" },
    { name: "BEARING SEIZURE", sev: "red" },
    { name: "SINK RATE", sev: "amber" },
    { name: "STARTER", sev: "amber", advisory: true },
  ];
  var activeAlarms = {};
  var outLatch = [false, false, false, false];

  /* ------------------------------ physics ------------------------------ */
  function sigma(alt) {
    var t = 1 - 6.875e-6 * alt;
    return Math.pow(t < 0.1 ? 0.1 : t, 4.256);
  }

  function tick(seconds) {
    var dt = clamp(Number(seconds) || 0, 0, 4);
    if (dt <= 0) {
      render();
      return;
    }
    S.time += dt;

    var sig = sigma(S.alt);
    S.oat = 15 - 1.98 * (S.alt / 1000);

    /* ---- starters ---- */
    var anyCrank = false;
    for (var i = 0; i < ENGINES; i++) {
      var E = S.eng[i];
      E.cranking = false;
      if (
        S.master &&
        S.starterSel === i + 1 &&
        !E.running &&
        !E.feathered &&
        !E.seizing
      ) {
        E.cranking = true;
        anyCrank = true;
        E.crankTime += dt;
        E.rpm += (420 - E.rpm) * clamp(dt * 1.2, 0, 1);
        var supplyOk =
          (S.pumps[i] && !(S.faults.boost && i === 3)) ||
          (S.crossfeed === "XFEED" && i === 3 && S.pumps[1]) ||
          (S.crossfeed === "ALL" &&
            S.pumps.some(function (p, pi) {
              return p && !(S.faults.boost && pi === 3);
            })) ||
          S.tanks[i] > 4;
        if (E.crankTime > 1.6 && S.throttle[i] >= 0.06 && supplyOk) {
          E.running = true;
          E.crankTime = 0;
          outLatch[i] = false;
        }
      } else if (!E.running) {
        E.crankTime = 0;
      }
    }

    /* ---- fuel system ---- */
    var draw = [[0], [1], [2], [3]];
    if (S.crossfeed === "XFEED") draw[3] = [1];
    if (S.crossfeed === "ALL")
      draw = [
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
      ];

    for (var j = 0; j < ENGINES; j++) {
      var Ej = S.eng[j];
      var tankList = draw[j];
      var supplied = false;
      for (var t2 = 0; t2 < tankList.length; t2++) {
        var tk = tankList[t2];
        var pumpWorks =
          S.master && S.pumps[tk] && !(S.faults.boost && tk === 3);
        if (S.tanks[tk] > 1 && (pumpWorks || S.alt < 5000)) supplied = true;
      }
      var want = supplied ? 17 : S.alt > 5000 ? 4 : 11;
      Ej.fp += (want - Ej.fp) * clamp(dt * (supplied ? 1.5 : 0.55), 0, 1);
    }

    /* ---- per-engine thermodynamics ---- */
    for (var k = 0; k < ENGINES; k++) {
      var En = S.eng[k];

      if (En.feathered && En.featherProg < 1) {
        En.featherProg = clamp(En.featherProg + dt / 3, 0, 1);
      }
      var featherCut = En.featherProg > 0.25;

      if (En.running && (featherCut || En.fp < 4.5)) {
        En.lowFpTimer += dt;
        if (featherCut || En.lowFpTimer > 8) {
          En.running = false;
          if (!En.feathered) {
            outLatch[k] = true;
          }
          En.lowFpTimer = 0;
        }
      } else {
        En.lowFpTimer = Math.max(0, En.lowFpTimer - dt);
      }

      if (En.running && !En.feathered) {
        var mapMax = 44 * Math.pow(sig, 0.72);
        var mapT = Math.max(9 * Math.pow(sig, 0.72), S.throttle[k] * mapMax);
        En.map += (mapT - En.map) * clamp(dt * 1.6, 0, 1);
        var govT = 700 + (S.governor - 700) * clamp(S.throttle[k] * 1.18, 0, 1);
        En.rpm += (Math.max(govT, 650) - En.rpm) * clamp(dt * 1.1, 0, 1);
        var pw = clamp((En.map / 42) * (En.rpm / 2400), 0, 1.15);
        En.ff += (240 + 1950 * pw - En.ff) * clamp(dt * 1.4, 0, 1);
      } else {
        var windmill = En.seizing || En.featherProg >= 1 ? 0 : S.ias * 1.35;
        En.map += (0 - En.map) * clamp(dt * 1.4, 0, 1);
        En.ff += (0 - En.ff) * clamp(dt * 1.8, 0, 1);
        En.rpm +=
          (windmill - En.rpm) * clamp(dt * (En.seizing ? 0.5 : 0.9), 0, 1);
      }

      /* cylinder-head temperature */
      var cowlSide = k < 2 ? S.cowl[0] : S.cowl[1];
      var cool =
        0.05 +
        cowlSide * 0.155 +
        (S.ias / 1000) * 0.055 +
        (En.rpm / 2400) * 0.02;
      var heatIn = (En.map / 42) * (En.rpm / 2400) * 235;
      if (S.faults.baffle && k === 2) {
        heatIn = heatIn * 2.05 + 95;
        cool *= 0.45;
      }
      var target = 15 + (heatIn / Math.max(cool, 0.02)) * 0.09;
      En.cht += (target - En.cht) * clamp(dt * (0.028 + cool * 0.32), 0, 1);
      En.cht = clamp(En.cht, S.oat, 340);

      /* detonation: a cooked head lets go */
      if (En.cht > DETONATION_CHT) {
        S.hotAirTimer += dt;
        if (S.hotAirTimer > 18) {
          En.running = false;
          En.seizing = true;
          outLatch[2] = true;
        }
      } else if (S.hotAirTimer > 0 && En.cht < DETONATION_CHT - 12) {
        S.hotAirTimer = Math.max(0, S.hotAirTimer - dt * 0.5);
      }

      /* oil temperature trails CHT */
      En.oilT += (En.cht - 24 - En.oilT) * clamp(dt * 0.02, 0, 1);

      /* oil pressure */
      var opNominal =
        En.running && !En.feathered
          ? 82 * Math.sqrt(clamp(En.rpm / 2400, 0.05, 1.1))
          : En.seizing
            ? 0
            : En.rpm > 100
              ? 14
              : 0;
      if (En.oilT > 112) opNominal -= (En.oilT - 112) * 1.6;
      opNominal = Math.max(0, opNominal);
      if (S.faults.oilline && k === 1) opNominal = Math.min(opNominal, 6);
      En.oilP += (opNominal - En.oilP) * clamp(dt * 0.9, 0, 1);

      /* bearing seizure under oil starvation (no.2) */
      if (
        k === 1 &&
        S.faults.oilline &&
        En.running &&
        !En.feathered &&
        En.oilP < 15
      ) {
        S.seizeTimer += dt;
        if (S.seizeTimer > 45) {
          En.running = false;
          En.seizing = true;
          outLatch[1] = true;
        }
      }
    }

    /* ---- fuel burn ---- */
    for (var m = 0; m < ENGINES; m++) {
      var Em = S.eng[m];
      if (!Em.running || Em.featherProg > 0.25) continue;
      var gal = (Em.ff * dt) / 129600;

      var targets = draw[m];
      for (var q = 0; q < targets.length; q++) {
        S.tanks[targets[q]] = Math.max(
          0,
          S.tanks[targets[q]] - gal / targets.length,
        );
      }
    }

    /* ---- airframe ---- */
    var pwTotal = 0;
    for (var p2 = 0; p2 < ENGINES; p2++) {
      var Ep = S.eng[p2];
      if (Ep.running && !Ep.feathered && !Ep.seizing) {
        pwTotal += clamp((Ep.map / 42) * (Ep.rpm / 2400), 0, 1.1);
      }
    }
    var dragCowl = (S.cowl[0] + S.cowl[1]) * 0.42;
    var excess = (pwTotal * 4.35 - 2.35) * 640 - dragCowl * 620;
    var vsT = clamp(excess, -2600, 3100);
    if (pwTotal < 0.02) vsT = -1150;
    S.vs += (vsT - S.vs) * clamp(dt * 0.5, 0, 1);
    S.alt = Math.max(0, S.alt + (S.vs * dt) / 60);
    var iasT = pwTotal > 0.05 ? 118 + 68 * clamp(pwTotal / 3.4, 0, 1) : 105;
    iasT -= (S.cowl[0] + S.cowl[1]) * 14;
    S.ias += (iasT - S.ias) * clamp(dt * 0.22, 0, 1);



    /* ------------------------------ alarms ------------------------------ */
    var standing = {};
    var hot = false,
      oilLow = false,
      fuelLow = false;
    for (var a1 = 0; a1 < ENGINES; a1++) {
      var Ea = S.eng[a1];
      if (Ea.cht > REDLINE_CHT) hot = true;
      if ((Ea.running || Ea.cranking) && Ea.fp < 10) fuelLow = true;
    }
    if (
      (S.eng[1].running || S.eng[1].cranking) &&
      S.eng[1].oilP < 30 &&
      S.eng[1].oilP > 0.5
    )
      oilLow = true;
    if (S.faults.baffle && S.time - S.faultProve.baffle < 60) hot = true;
    if (
      S.faults.oilline &&
      (S.eng[1].running ||
        S.eng[1].cranking ||
        S.eng[1].seizing ||
        S.time - S.faultProve.oilline < 60)
    )
      oilLow = true;
    if (
      S.faults.boost &&
      (S.eng[3].running ||
        S.eng[3].cranking ||
        S.time - S.faultProve.boost < 60)
    )
      fuelLow = true;
    if (hot) standing["CYL HEAD HOT"] = true;
    if (oilLow) standing["OIL PRESS LOW"] = true;
    if (fuelLow) standing["FUEL PRESS LOW"] = true;

    var hi = Math.max.apply(null, S.tanks),
      lo = Math.min.apply(null, S.tanks);
    if (hi - lo > 28) standing["TANK IMBALANCE"] = true;

    for (var a2 = 0; a2 < ENGINES; a2++) {
      if (outLatch[a2]) standing["ENGINE OUT"] = true;
      if (S.eng[a2].seizing) standing["BEARING SEIZURE"] = true;
    }
    if (anyCrank && S.master) standing["STARTER"] = true;

    if (S.alt > 800 && S.vs < -220) {
      S.sinkTimer += dt;
      if (S.sinkTimer > 8) standing["SINK RATE"] = true;
    } else {
      S.sinkTimer = 0;
    }

    for (var nm in standing) {
      if (!activeAlarms[nm]) {
        activeAlarms[nm] = true;
        if (nm !== "STARTER") accepted = false;
      }
    }
    for (var am in activeAlarms) {
      if (!standing[am]) delete activeAlarms[am];
    }

    render();
  }

  /* ======================================================================
     PANEL CONSTRUCTION
     ====================================================================== */
  var refs = {};

  function buildFlightBay() {
    refs.altimeter = drawDial($("#g-altimeter"), {
      min: 0,
      max: 10,
      size: 122,
      tickStep: 0.5,
      majorStep: 1,
      caption: "ALTITUDE  ×1000 FT",
      numSize: 9,
    });
    var slot = $("#g-altimeter");
    var drum = el("div", "alt-drum", slot);
    el("span", "", drum, "FT");
    refs.altDrum = el("b", "", drum, "00000");

    refs.vsi = drawDial($("#g-vsi"), {
      min: -2000,
      max: 2000,
      size: 86,
      tickStep: 250,
      majorStep: 500,
      caption: "VERT SPEED FT/MIN",
      numFormat: function (v) {
        return String(Math.abs(Math.round(v / 100)));
      },
    });
    refs.asi = drawDial($("#g-asi"), {
      min: 0,
      max: 320,
      size: 86,
      tickStep: 20,
      majorStep: 40,
      greenBand: [130, 200],
      redFrom: 300,
      caption: "AIR SPEED KT",
    });
    refs.oat = drawStrip($("#g-oat"), {
      min: -50,
      max: 40,
      label: "O.A.T. °C",
      decimals: 0,
    });
  }

  function buildEngineColumns() {
    var row = $("#engine-row");
    row.innerHTML = "";
    refs.engCols = [];
    refs.feathers = [];
    for (var i = 0; i < ENGINES; i++) {
      var col = el("article", "engine-col", row);
      col.setAttribute("data-engine", String(i + 1));
      var head = el("div", "eng-head", col);
      var runLamp = el("span", "eng-run-lamp", head);
      el("span", "", head, "No." + (i + 1));

      var R = {
        runLamp: runLamp,
        map: drawDial(col, {
          min: 10,
          max: 50,
          size: 74,
          tickStep: 5,
          majorStep: 10,
          redFrom: 46,
          caption: "BOOST inHg",
          numSize: 7,
        }),
        rpm: drawDial(col, {
          min: 0,
          max: 3000,
          size: 74,
          tickStep: 250,
          majorStep: 500,
          redFrom: 2750,
          caption: "R.P.M.",
          numFormat: function (v) {
            return String(Math.round(v / 100));
          },
        }),
        cht: drawDial(col, {
          min: 0,
          max: 320,
          size: 74,
          tickStep: 40,
          majorStep: 80,
          redFrom: REDLINE_CHT,
          caption: "CYL HEAD °C",
          numSize: 7,
        }),
      };

      var pair1 = el("div", "gauge-pair", col);
      R.oilP = drawStrip(pair1, {
        min: 0,
        max: 100,
        label: "OIL P",
        redBelow: 30,
      });
      R.oilT = drawStrip(pair1, {
        min: 0,
        max: 140,
        label: "OIL T",
        redAbove: 112,
      });

      var pair2 = el("div", "gauge-pair", col);
      R.fp = drawStrip(pair2, {
        min: 0,
        max: 25,
        label: "FUEL P",
        redBelow: 10,
      });
      R.ff = drawDrum(pair2, { label: "LB/HR" });

      refs.engCols.push(R);
    }

    /* feather rack */
    var rack = $(".feather-rack");
    rack.querySelectorAll(".feather-unit").forEach(function (n) {
      n.remove();
    });
    var _loop = function (j) {
      var unit = el("div", "feather-unit", rack);
      var wrap = el("div", "feather-wrap", unit);
      var btn = el("button", "feather-btn", wrap);
      btn.type = "button";
      btn.setAttribute("aria-label", "Feather button No." + (j + 1));
      var guard = el("button", "guard-flap", wrap);
      guard.type = "button";
      guard.setAttribute(
        "aria-label",
        "Red guard, feather button No." + (j + 1),
      );
      guard.tabIndex = -1; /* the wrapped button is the single tab stop */
      wrap.addEventListener("pointerdown", function () {
        if (!guard.classList.contains("open")) {
          guard.classList.add("open");
        }
      });
      guard.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          guard.classList.add("open");
          btn.focus();
          e.preventDefault();
        }
      });
      btn.addEventListener("click", function () {
        if (!guard.classList.contains("open")) {
          guard.classList.add("open");
          return;
        }
        featherEngine(j);
      });
      btn.addEventListener("keydown", function (e) {
        if (e.key === " " || e.key === "Enter") {
          if (!guard.classList.contains("open")) guard.classList.add("open");
          else featherEngine(j);
          e.preventDefault();
        }
      });
      el("span", "fl-caption", unit, "No." + (j + 1));
      refs.feathers.push({ btn: btn, guard: guard });
    };
    for (var fi = 0; fi < ENGINES; fi++) _loop(fi);
  }

  function buildSystemsBay() {
    /* fuel schematic */
    var fsHost = $("#fuel-schematic");
    fsHost.innerHTML = "";
    var svg = sv("svg", { viewBox: "0 0 320 116" }, fsHost);
    refs.tankRects = [];
    refs.tankTexts = [];
    refs.feedLines = [];

    function tankShape(x, y, w, h, flip) {
      return flip
        ? x +
            "," +
            y +
            " " +
            (x + w * 0.82) +
            "," +
            y +
            " " +
            (x + w) +
            "," +
            (y + h * 0.5) +
            " " +
            (x + w * 0.82) +
            "," +
            (y + h) +
            " " +
            x +
            "," +
            (y + h)
        : x +
            w * 0.18 +
            "," +
            y +
            " " +
            (x + w) +
            "," +
            y +
            " " +
            (x + w) +
            "," +
            (y + h) +
            " " +
            (x + w * 0.18) +
            "," +
            (y + h) +
            " " +
            x +
            "," +
            (y + h * 0.5);
    }
    var tankDefs = [
      { x: 8, y: 26, w: 62, h: 40, flip: false, n: 1 },
      { x: 78, y: 26, w: 72, h: 40, flip: false, n: 2 },
      { x: 170, y: 26, w: 72, h: 40, flip: true, n: 3 },
      { x: 250, y: 26, w: 62, h: 40, flip: true, n: 4 },
    ];
    tankDefs.forEach(function (td, i) {
      var gid = "clip-tank-" + i;
      var pts = tankShape(td.x, td.y, td.w, td.h, td.flip);
      var cp = sv("clipPath", { id: gid }, svg);
      sv("polygon", { points: pts }, cp);
      sv(
        "polygon",
        {
          points: pts,
          fill: "#1c2023",
          stroke: "#4a525a",
          "stroke-width": 1.4,
        },
        svg,
      );
      var fillRect = sv(
        "rect",
        {
          x: td.x - 2,
          y: td.y,
          width: td.w + 4,
          height: td.h,
          fill: "#ad7f2f",
          opacity: 0.85,
          "clip-path": "url(#" + gid + ")",
        },
        svg,
      );
      refs.tankRects.push(fillRect);
      var lab = sv(
        "text",
        {
          x: td.x + td.w / 2,
          y: td.y - 7,
          "text-anchor": "middle",
          "font-size": 8.5,
          fill: "#cdd4da",
          "letter-spacing": "1",
          "font-family": "Arial Narrow, Arial, sans-serif",
        },
        svg,
      );
      lab.textContent = "TANK No." + td.n;
      var pct = sv(
        "text",
        {
          x: td.x + td.w / 2,
          y: td.y + td.h / 2 + 3.5,
          "text-anchor": "middle",
          "font-size": 10.5,
          "font-weight": "bold",
          fill: "#17191b",
          "font-family": "Courier New, monospace",
        },
        svg,
      );
      refs.tankTexts.push(pct);
    });

    sv(
      "rect",
      {
        x: 148,
        y: 8,
        width: 24,
        height: 118,
        rx: 8,
        fill: "#262b2f",
        stroke: "#4a525a",
      },
      svg,
    );

    var lineDefs = [
      { x1: 39, y1: 66, x2: 62, y2: 108 },
      { x1: 114, y1: 66, x2: 120, y2: 108 },
      { x1: 206, y1: 66, x2: 200, y2: 108 },
      { x1: 281, y1: 66, x2: 258, y2: 108 },
    ];
    lineDefs.forEach(function (ld, i) {
      refs.feedLines.push(
        sv(
          "line",
          {
            x1: ld.x1,
            y1: ld.y1,
            x2: ld.x2,
            y2: ld.y2,
            stroke: "#5b646c",
            "stroke-width": 2.4,
          },
          svg,
        ),
      );
      sv(
        "circle",
        {
          cx: (ld.x1 + ld.x2) / 2,
          cy: (ld.y1 + ld.y2) / 2,
          r: 9,
          fill: "#1c2023",
          stroke: "#4a525a",
        },
        svg,
      );
      var t = sv(
        "text",
        {
          x: (ld.x1 + ld.x2) / 2,
          y: (ld.y1 + ld.y2) / 2 + 3.2,
          "text-anchor": "middle",
          "font-size": 8,
          fill: "#efe8d2",
          "font-family": "Arial Narrow, Arial, sans-serif",
        },
        svg,
      );
      t.textContent = "E" + (i + 1);
    });

    refs.xfeedPipe = sv(
      "path",
      {
        d: "M 114 74 C 140 94 180 94 206 74",
        fill: "none",
        stroke: "#3a4046",
        "stroke-width": 2.4,
        "stroke-dasharray": "5 4",
      },
      svg,
    );
    var xfLab = sv(
      "text",
      {
        x: 160,
        y: 101,
        "text-anchor": "middle",
        "font-size": 7.5,
        fill: "#8f98a0",
        "letter-spacing": "1",
        "font-family": "Arial Narrow, Arial, sans-serif",
      },
      svg,
    );
    xfLab.textContent = "CROSSFEED 2 ↔ 4";

    /* crossfeed rotary */
    refs.crossfeed = buildRotary(
      $("#crossfeed-selector"),
      [
        { value: "NORMAL", label: "NORM" },
        { value: "XFEED", label: "X-FEED" },
        { value: "ALL", label: "INTER" },
      ],
      0,
      function (v) {
        S.crossfeed = v;
      },
      "CROSSFEED SELECTOR",
    );

    /* annunciators */
    var grid = $("#annunc-grid");
    grid.innerHTML = "";
    refs.windows = {};
    ALARM_DEF.forEach(function (d) {
      var w = el("div", "annunc-window", grid);
      el("span", "caption", w, d.name);
      refs.windows[d.name] = { node: w, def: d };
    });

    /* engine analyser: meter + selector share the data-control wrapper */
    refs.analyserMeter = drawDial($("#g-analyser"), {
      min: 0,
      max: 320,
      size: 88,
      tickStep: 40,
      majorStep: 80,
      redFrom: REDLINE_CHT,
      caption: "ANALYSER °C",
      numSize: 8,
    });
    var holderDiv = el("div", "rotary-unit", $("#engine-analyser"));
    refs.analyserSel = buildRotary(
      holderDiv,
      [
        { value: 0, label: "OFF" },
        { value: 1, label: "1" },
        { value: 2, label: "2" },
        { value: 3, label: "3" },
        { value: 4, label: "4" },
      ],
      0,
      function (v) {
        S.analyser = v;
      },
      "PROBE SELECTOR",
    );
  }

  function buildQuadrant() {
    var q = $("#power-quadrant");

    var scale = q.querySelector(".quadrant-scale");
    scale.innerHTML = "";
    for (var deg = 0; deg <= 60; deg += 10) {
      var x = 30 + (deg / 60) * 400;
      sv(
        "line",
        {
          x1: x,
          y1: 96,
          x2: x,
          y2: deg % 20 === 0 ? 82 : 89,
          stroke: "#39434c",
          "stroke-width": deg % 20 === 0 ? 2 : 1,
        },
        scale,
      );
      if (deg % 20 === 0) {
        var t = sv(
          "text",
          {
            x: x,
            y: 76,
            "text-anchor": "middle",
            "font-size": 10,
            fill: "#39434c",
            "letter-spacing": "0.5",
          },
          scale,
        );
        t.textContent = String(deg);
      }
    }
    var scap = sv(
      "text",
      {
        x: 230,
        y: 114,
        "text-anchor": "middle",
        "font-size": 10,
        fill: "#39434c",
        "letter-spacing": "2",
      },
      scale,
    );
    scap.textContent = "THROTTLE · DEGREES OPEN";
    sv(
      "circle",
      { cx: 316, cy: 34, r: 13, fill: "url(#hub)", stroke: "#5e4212" },
      scale,
    );
    var fr = sv(
      "text",
      {
        x: 316,
        y: 62,
        "text-anchor": "middle",
        "font-size": 8.5,
        fill: "#39434c",
        "letter-spacing": "1",
      },
      scale,
    );
    fr.textContent = "FRICTION";

    var rail = el("div", "lever-rail", q);
    refs.throttles = [];
    for (var i = 0; i < ENGINES; i++) {
      (function (idx) {
        refs.throttles.push(
          buildLever(rail, {
            label: "Throttle No." + (idx + 1),
            min: 0,
            max: 1,
            value: 0,
            kind: "throttle",
            tag: "T" + (idx + 1),
            format: function (v) {
              return Math.round(v * 60) + "°";
            },
            onInput: function (v) {
              S.throttle[idx] = v;
            },
          }),
        );
      })(i);
    }

    var aux = $("#prop-governor");
    aux.innerHTML =
      "<span class='group-caption'>PROP GOVERNOR</span><div class='lever-holder'></div>";
    refs.governor = buildLever(aux.querySelector(".lever-holder"), {
      label: "Propeller governor R.P.M.",
      min: 1600,
      max: 2600,
      value: 1900,
      kind: "brass-lever",
      tag: "RPM",
      format: function (v) {
        return String(Math.round(v));
      },
      onInput: function (v) {
        S.governor = v;
      },
    });

    var cf = $("#cowl-flaps");
    cf.innerHTML =
      "<span class='group-caption'>COWL FLAPS</span><div class='lever-holder'></div>";
    refs.cowls = [];
    ["PORT", "STBD"].forEach(function (side, idx) {
      refs.cowls.push(
        buildLever(cf.querySelector(".lever-holder"), {
          label: "Cowl flaps " + side,
          min: 0,
          max: 1,
          value: 0,
          kind: "brass-lever t-handle-lever",
          tag: side,
          tHandle: true,
          format: function (v) {
            return v < 0.02 ? "SHUT" : Math.round(v * 100) + "%";
          },
          onInput: function (v) {
            S.cowl[idx] = v;
          },
        }),
      );
    });
  }

  function buildTray() {
    var bank = $("#pump-bank");
    bank.innerHTML = "";
    refs.pumps = [];
    for (var i = 0; i < ENGINES; i++) {
      (function (idx) {
        var b = el("button", "bat-toggle small", bank);
        b.type = "button";
        b.setAttribute("data-pump", String(idx + 1));
        b.setAttribute("aria-pressed", "false");
        b.setAttribute("aria-label", "Boost pump switch, tank No." + (idx + 1));
        el("span", "bat-lever", b);
        el("span", "toggle-caption", b, "TK " + (idx + 1));
        b.addEventListener("click", function () {
          S.pumps[idx] = !S.pumps[idx];
          b.setAttribute("aria-pressed", String(S.pumps[idx]));
        });
        refs.pumps.push(b);
      })(i);
    }

    refs.starter = buildRotary(
      $("#starter-selector"),
      [
        { value: 0, label: "OFF" },
        { value: 1, label: "1" },
        { value: 2, label: "2" },
        { value: 3, label: "3" },
        { value: 4, label: "4" },
      ],
      0,
      function (v) {
        S.starterSel = v;
      },
      null,
    );

    var fb = $("#fault-bank");
    fb.innerHTML = "";
    refs.faultSwitches = {};
    [
      ["baffle", "NO.3 CYL HEAD"],
      ["oilline", "NO.2 OIL LINE"],
      ["boost", "NO.4 BOOST PN"],
    ].forEach(function (pairDef) {
      var unit = el("div", "fault-unit", fb);
      var sw = el("button", "mini-guard", unit);
      sw.type = "button";
      sw.setAttribute("aria-pressed", "false");
      sw.setAttribute("aria-label", "Fault test switch: " + pairDef[1]);
      el("span", "mg-cap", sw);
      el("span", "cell-caption", unit, pairDef[1]);
      sw.addEventListener("click", function () {
        var on = sw.getAttribute("aria-pressed") !== "true";
        sw.setAttribute("aria-pressed", String(on));
        if (on) injectFault(pairDef[0]);
      });
      refs.faultSwitches[pairDef[0]] = sw;
    });

    var rb = $("#repair-bank");
    rb.innerHTML = "";
    [
      ["baffle", "REPAIR BAFFLE"],
      ["oilline", "RESTORE OIL"],
      ["boost", "CHANGE PUMP"],
    ].forEach(function (rd) {
      var b = el("button", "push repair", rb, rd[1]);
      b.type = "button";
      b.setAttribute("data-repair", rd[0]);
      b.setAttribute("aria-label", "Repair action: " + rd[1]);
      b.addEventListener("click", function () {
        repair(rd[0]);
      });
    });

    $("#master-switch").addEventListener("click", function () {
      S.master = !S.master;
      this.setAttribute("aria-pressed", String(S.master));
    });
    $("#alarm-accept").addEventListener("click", function () {
      accepted = true;
    });
    $("#lamps-test").addEventListener("click", function () {
      lampsTestUntil = performance.now() / 1000 + 1.2;
    });
    $("#secure-reset").addEventListener("click", function () {
      api.reset();
    });
  }

  /* ======================================================================
     ACTIONS
     ====================================================================== */
  function featherEngine(idx) {
    var E = S.eng[idx];
    if (E.feathered || E.seizing) return;
    E.feathered = true;
    E.featherProg = 0;
  }

  var FAULT_NAMES = {
    baffle: "number three cylinder-head overheat",
    oilline: "number two oil-pressure loss",
    boost: "number four boost-pump failure",
  };

  function injectFault(key) {
    S.faults[key] = true;
    S.faultProve[key] = S.time;
    var sw = refs.faultSwitches[key];
    if (sw) sw.setAttribute("aria-pressed", "true");
  }

  function repair(key) {
    S.faults[key] = false;
    var sw = refs.faultSwitches[key];
    if (sw) sw.setAttribute("aria-pressed", "false");
    if (key === "baffle") S.hotAirTimer = 0;
    if (key === "oilline") S.seizeTimer = 0;
  }

  /* ======================================================================
     RENDER
     ====================================================================== */
  function render() {
    var testing = performance.now() / 1000 < lampsTestUntil;

    for (var i = 0; i < ENGINES; i++) {
      var E = S.eng[i],
        R = refs.engCols[i];
      R.map.set(E.map);
      R.rpm.set(E.rpm);
      R.cht.set(E.cht);
      R.oilP.set(testing ? 100 : E.oilP);
      R.oilT.set(testing ? 60 : E.oilT);
      R.fp.set(testing ? 25 : E.fp);
      R.ff.set(testing ? 888 : E.ff);
      R.runLamp.classList.toggle("on", testing || E.running || E.cranking);
      refs.feathers[i].btn.style.opacity = E.feathered ? "0.55" : "1";
    }

    refs.altimeter.set((S.alt % 10000) / 1000);
    refs.altDrum.textContent = String(Math.round(S.alt)).padStart(5, "0");
    refs.vsi.set(S.vs);
    refs.asi.set(S.ias);
    refs.oat.set(S.oat);

    for (var t3 = 0; t3 < 4; t3++) {
      var lvl = clamp(S.tanks[t3], 0, 100);
      refs.tankRects[t3].setAttribute(
        "y",
        (26 + 40 * (1 - lvl / 100)).toFixed(2),
      );
      refs.tankRects[t3].setAttribute(
        "height",
        (40 * (lvl / 100) + 0.01).toFixed(2),
      );
      refs.tankTexts[t3].textContent = Math.round(lvl) + "%";
      refs.feedLines[t3].setAttribute(
        "stroke",
        S.eng[t3].running || S.eng[t3].cranking ? "#ad7f2f" : "#5b646c",
      );
    }
    refs.xfeedPipe.setAttribute(
      "stroke",
      S.crossfeed === "NORMAL" ? "#3a4046" : "#e09a28",
    );

    refs.analyserMeter.set(S.analyser ? S.eng[S.analyser - 1].cht : 0);

    for (var name in refs.windows) {
      var wref = refs.windows[name];
      var lit = testing || !!activeAlarms[name];
      wref.node.classList.toggle("red", lit && wref.def.sev === "red");
      wref.node.classList.toggle("amber", lit && wref.def.sev === "amber");
    }
    var mcLit = testing;
    if (!testing) {
      mcLit = false;
      for (var mk in activeAlarms) {
        if (mk !== "STARTER" && !accepted) mcLit = true;
      }
    }
    $("#master-caution").classList.toggle("lit", mcLit);

    var runningCount = 0;
    for (var rc = 0; rc < ENGINES; rc++) if (S.eng[rc].running) runningCount++;
    var note = $("#phase-note");
    if (!S.master) note.textContent = "ELECTRICS OFF · STATION COLD";
    else if (runningCount === 0)
      note.textContent = "AIRFRAME AT SHANNON RAMP · ENGINES COLD";
    else if (S.alt < 1500)
      note.textContent =
        "DEPARTURE · SHANNON CLIMB OUT · " + Math.round(S.alt) + " FT";
    else if (S.vs > 120)
      note.textContent =
        "CLIMB · FL" + String(Math.round(S.alt / 100)).padStart(3, "0");
    else if (S.vs < -220) note.textContent = "DESCENT · MIND THE SINK RATE";
    else
      note.textContent =
        "CRUISE · FL" +
        String(Math.round(S.alt / 100)).padStart(3, "0") +
        " · " +
        Math.round(S.ias) +
        " KT";
  }

  /* ======================================================================
     PUBLIC API
     ====================================================================== */
  var api = {
    name: "Halcyon H.86 Meridian — Flight Engineer's Station",
    faults: Object.keys(FAULT_NAMES).map(function (k) {
      return FAULT_NAMES[k];
    }),

    state: function () {
      var alarms = Object.keys(activeAlarms).filter(function (n) {
        return n !== "STARTER";
      });
      return {
        time_s: S.time,
        altitude_ft: S.alt,
        vertical_speed_fpm: S.vs,
        airspeed_kt: S.ias,
        outside_air_temp_c: S.oat,
        governor_rpm: S.governor,
        crossfeed: S.crossfeed,
        tanks_pct: S.tanks.slice(),
        engines: S.eng.map(function (E) {
          return {
            running: E.running,
            cranking: E.cranking,
            feathered: E.feathered,
            seized: E.seizing,
            rpm: E.rpm,
            manifold_inHg: E.map,
            fuel_flow_lb_hr: E.ff,
            cyl_head_temp_c: E.cht,
            oil_press_psi: E.oilP,
            oil_temp_c: E.oilT,
            fuel_press_psi: E.fp,
          };
        }),
        faults_active: Object.keys(S.faults)
          .filter(function (k) {
            return S.faults[k];
          })
          .map(function (k) {
            return FAULT_NAMES[k];
          }),
        alarms: alarms,
        master_caution:
          !!$("#master-caution") &&
          $("#master-caution").classList.contains("lit"),
      };
    },

    tick: tick,

    inject: function (faultName) {
      var n = norm(faultName);
      for (var k in FAULT_NAMES) {
        if (norm(FAULT_NAMES[k]) === n) {
          injectFault(k);
          return;
        }
      }
      throw new Error("unknown fault: " + faultName);
    },

    reset: function () {
      S = freshState();
      freshEngines(S);
      activeAlarms = {};
      outLatch = [false, false, false, false];
      accepted = true;
      lampsTestUntil = 0;
      refs.throttles.forEach(function (lv) {
        lv.set(0);
      });
      refs.governor.set(1900);
      refs.cowls.forEach(function (lv) {
        lv.set(0);
      });
      refs.pumps.forEach(function (b) {
        b.setAttribute("aria-pressed", "false");
      });
      refs.starter.set(0);
      refs.crossfeed.set(0);
      refs.analyserSel.set(0);
      for (var fk in refs.faultSwitches)
        refs.faultSwitches[fk].setAttribute("aria-pressed", "false");
      $("#master-switch").setAttribute("aria-pressed", "false");
      render();
    },
  };
  window.machine = api;

  /* ======================================================================
     MANUAL DIALOG
     ====================================================================== */
  (function wireManual() {
    var dlg = $("#manual-dialog");
    document.querySelectorAll('[data-action="manual"]').forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      });
    });
    document
      .querySelectorAll('[data-action="close-manual"]')
      .forEach(function (b) {
        b.addEventListener("click", function () {
          if (typeof dlg.close === "function") dlg.close();
          else dlg.removeAttribute("open");
        });
      });
  })();

  /* ======================================================================
     BOOT + ANIMATION LOOP
     ====================================================================== */
  buildFlightBay();
  buildEngineColumns();
  buildSystemsBay();
  buildQuadrant();
  buildTray();
  render();

  var last = null;
  function frame(now) {
    if (document.hidden) {
      last = null;
    } else {
      var dtm = last == null ? 0 : (now - last) / 1000;
      last = now;
      if (dtm > 0) tick(Math.min(dtm, 2));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  requestAnimationFrame(frame);
})();
