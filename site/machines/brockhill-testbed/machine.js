/* Brockhill Test Bed No. 2 - Osprey Mk.IV acceptance console, 1944.
   Bench simulation of a seven-cylinder air-cooled radial on a water-brake
   dynamometer: fuel, ignition, cooling and load fight each other exactly
   as they did in the test house. */
(function () {
  "use strict";

  var MACHINE_NAME = "Osprey Mk.IV Test Bed No. 2";
  var FAULTS = [
    "magneto earth fault",
    "oil cooler blockage",
    "float chamber flooding",
  ];
  var H = 0.25;
  var NS = "http://www.w3.org/2000/svg";
  var MAG_FACTOR = [0, 0.95, 0.28, 1];
  var MIX_FACTOR = [0, 0.9, 1];

  function $(id) {
    return document.getElementById(id);
  }

  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ------------------------------------------------------------ gauges */

  function polar(cx, cy, r, deg) {
    var a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }

  function arcPath(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0);
    var p1 = polar(cx, cy, r, a1);
    var big = Math.abs(a1 - a0) > 180 ? 1 : 0;
    var sweep = a1 > a0 ? 1 : 0;
    return (
      "M " +
      p0[0].toFixed(2) +
      " " +
      p0[1].toFixed(2) +
      " A " +
      r +
      " " +
      r +
      " 0 " +
      big +
      " " +
      sweep +
      " " +
      p1[0].toFixed(2) +
      " " +
      p1[1].toFixed(2)
    );
  }

  /* Moving-coil style face: ivory, black ticks, painted limit arcs,
     black needle, steel bezel. */
  function buildGauge(svg, cfg) {
    var cx = cfg.cx;
    var cy = cfg.cy;
    var r = cfg.r;
    svg.textContent = "";
    svgEl("circle", { cx: cx, cy: cy, r: r + 9, fill: "#211b17" }, svg);
    svgEl("circle", { cx: cx, cy: cy, r: r + 6, fill: "#55483f" }, svg);
    svgEl("circle", { cx: cx, cy: cy, r: r + 3.5, fill: "#17110d" }, svg);
    svgEl("circle", { cx: cx, cy: cy, r: r, fill: "#f3ead4" }, svg);

    function val2ang(v) {
      var t = (v - cfg.min) / (cfg.max - cfg.min);
      t = Math.min(1, Math.max(0, t));
      return cfg.from + t * (cfg.to - cfg.from);
    }

    [
      ["#b8930f", cfg.yellow],
      ["#b32014", cfg.red],
      ["#1e6b2e", cfg.green],
    ].forEach(function (band) {
      if (!band[1]) return;
      svgEl(
        "path",
        {
          d: arcPath(cx, cy, r - 8, val2ang(band[1][0]), val2ang(band[1][1])),
          stroke: band[0],
          "stroke-width": 5,
          fill: "none",
        },
        svg,
      );
    });

    var minors = cfg.minor != null ? cfg.minor : 4;
    var total = cfg.major * minors;
    for (var i = 0; i <= total; i++) {
      var v = cfg.min + ((cfg.max - cfg.min) * i) / total;
      var ang = val2ang(v);
      var isMajor = i % minors === 0;
      var p1 = polar(cx, cy, r - (isMajor ? 12 : 6), ang);
      var p2 = polar(cx, cy, r - 1, ang);
      svgEl(
        "line",
        {
          x1: p1[0],
          y1: p1[1],
          x2: p2[0],
          y2: p2[1],
          stroke: "#241f1a",
          "stroke-width": isMajor ? 2 : 1,
        },
        svg,
      );
      if (isMajor && cfg.numbers !== false) {
        var lp = polar(cx, cy, r - 22, ang);
        var t = svgEl(
          "text",
          {
            x: lp[0],
            y: lp[1] + 3.5,
            "text-anchor": "middle",
            "font-family": '"Arial Narrow",Arial,sans-serif',
            "font-size": cfg.numSize || 11,
            "font-weight": 700,
            fill: "#241f1a",
          },
          svg,
        );
        t.textContent = cfg.number(v);
      }
    }
    if (cfg.caption) {
      var cp = polar(cx, cy, r * 0.42, (cfg.from + cfg.to) / 2);
      var c = svgEl(
        "text",
        {
          x: cp[0],
          y: cp[1],
          "text-anchor": "middle",
          "font-family": '"Arial Narrow",Arial,sans-serif',
          "font-size": 9,
          "letter-spacing": 1.5,
          fill: "#5c4a32",
        },
        svg,
      );
      c.textContent = cfg.caption;
    }

    var pivot = polar(cx, cy, r - 14, cfg.from);
    var nde = svgEl("g", {}, svg);
    svgEl(
      "path",
      {
        d:
          "M " +
          (cx - 4) +
          " " +
          cy +
          " L " +
          (cx + 4) +
          " " +
          cy +
          " L " +
          pivot[0].toFixed(1) +
          " " +
          (pivot[1] + 6).toFixed(1) +
          " Z",
        fill: "#17110d",
      },
      nde,
    );
    svgEl("circle", { cx: cx, cy: cy, r: 6, fill: "#211b17" }, svg);
    svgEl("circle", { cx: cx, cy: cy, r: 2.4, fill: "#8a7a5c" }, svg);

    return function (v) {
      nde.setAttribute(
        "transform",
        "rotate(" + val2ang(v).toFixed(2) + " " + cx + " " + cy + ")",
      );
    };
  }

  /* Cylinder-head thermometer column. Scale 20-260 C, red above 232. */
  function buildBar(svg) {
    svg.textContent = "";
    svgEl(
      "rect",
      { x: 8, y: 4, width: 44, height: 152, rx: 8, fill: "#211b17" },
      svg,
    );
    svgEl(
      "rect",
      { x: 13, y: 9, width: 34, height: 128, rx: 5, fill: "#efe6cd" },
      svg,
    );

    function yOf(v) {
      return 9 + (128 * (260 - v)) / 240;
    }

    svgEl(
      "rect",
      {
        x: 47,
        y: yOf(260),
        width: 5,
        height: yOf(232) - yOf(260),
        fill: "#b32014",
      },
      svg,
    );
    svgEl(
      "rect",
      {
        x: 47,
        y: yOf(232),
        width: 5,
        height: yOf(190) - yOf(232),
        fill: "#b8930f",
      },
      svg,
    );
    for (var i = 0; i <= 6; i++) {
      var v = 20 + (i * 240) / 6;
      var yy = yOf(v);
      svgEl(
        "line",
        {
          x1: 9,
          y1: yy,
          x2: 13,
          y2: yy,
          stroke: "#241f1a",
          "stroke-width": i % 2 ? 1 : 2,
        },
        svg,
      );
      if (i % 2 === 0) {
        var t = svgEl(
          "text",
          {
            x: 5,
            y: yy + 3,
            "text-anchor": "end",
            "font-family": '"Arial Narrow",Arial,sans-serif',
            "font-size": 8,
            fill: "#241f1a",
          },
          svg,
        );
        t.textContent = String(Math.round(v));
      }
    }
    svgEl(
      "circle",
      {
        cx: 30,
        cy: 148,
        r: 11,
        fill: "#b32014",
        stroke: "#211b17",
        "stroke-width": 2,
      },
      svg,
    );
    var fill = svgEl(
      "rect",
      { x: 14.5, y: 137, width: 31, height: 0, fill: "#8a2b1c" },
      svg,
    );
    return function (v) {
      var frac = Math.min(1, Math.max(0, (v - 20) / 240));
      var hgt = frac * 128;
      fill.setAttribute("height", hgt.toFixed(1));
      fill.setAttribute("y", (137 - hgt).toFixed(1));
      fill.setAttribute(
        "fill",
        v >= 232 ? "#cf1e14" : v >= 190 ? "#b8860b" : "#8a2b1c",
      );
    };
  }

  /* Rotary selectors: bakelite knob, engraved plate. Discrete positions
     or a continuous 0-100 quadrant. Drag or arrow keys. */
  function buildRotary(svg, cfg) {
    svg.textContent = "";
    var cx = 65;
    var cy = 65;
    var defs = svgEl("defs", {}, svg);
    var grad = svgEl(
      "radialGradient",
      { id: "knob-" + cfg.id, cx: "35%", cy: "30%", r: "80%" },
      defs,
    );
    svgEl("stop", { offset: "0%", "stop-color": "#5c5046" }, grad);
    svgEl("stop", { offset: "65%", "stop-color": "#2c251f" }, grad);

    svgEl("stop", { offset: "100%", "stop-color": "#15100c" }, grad);
    svgEl("circle", { cx: cx, cy: cy, r: 62, fill: "#211b17" }, svg);
    svgEl("circle", { cx: cx, cy: cy, r: 58, fill: "#33291f" }, svg);
    svgEl(
      "circle",
      {
        cx: cx,
        cy: cy,
        r: 58,
        fill: "none",
        stroke: "rgba(255,220,170,.14)",
        "stroke-width": 1,
      },
      svg,
    );

    var n = cfg.continuous ? 5 : cfg.labels.length;
    for (var i = 0; i < n; i++) {
      var frac = i / (n - 1);
      var ang = cfg.continuous ? -70 + 140 * frac : cfg.angles[i];
      var p1 = polar(cx, cy, 54, ang);
      var p2 = polar(cx, cy, 47, ang);
      svgEl(
        "line",
        {
          x1: p1[0],
          y1: p1[1],
          x2: p2[0],
          y2: p2[1],
          stroke: "#e8dcc0",
          "stroke-width": 2,
        },
        svg,
      );
      var lp = polar(cx, cy, 41, ang);
      var lab = svgEl(
        "text",
        {
          x: lp[0],
          y: lp[1] + 3,
          "text-anchor": "middle",
          "font-family": '"Arial Narrow",Arial,sans-serif',
          "font-size": 8.5,
          "letter-spacing": 0.6,
          fill: "#f1e8d2",
        },
        svg,
      );
      lab.textContent = cfg.continuous
        ? i === 0
          ? "SHUT"
          : i === n - 1
            ? "FULL"
            : ""
        : cfg.labels[i];
    }

    var knob = svgEl("g", {}, svg);
    svgEl(
      "circle",
      { cx: cx, cy: cy, r: 30, fill: "url(#knob-" + cfg.id + ")" },
      knob,
    );
    svgEl(
      "circle",
      {
        cx: cx,
        cy: cy,
        r: 30,
        fill: "none",
        stroke: "#0d0a07",
        "stroke-width": 2,
      },
      knob,
    );
    var sk = svgEl("g", {}, knob);
    for (var k = 0; k < 10; k++) {
      var ka = k * 36 + 90;
      var s1 = polar(cx, cy, 23, ka);
      var s2 = polar(cx, cy, 29, ka);
      svgEl(
        "line",
        {
          x1: s1[0],
          y1: s1[1],
          x2: s2[0],
          y2: s2[1],
          stroke: "rgba(255,235,200,.16)",
          "stroke-width": 1.4,
        },
        sk,
      );
    }
    var pt1 = polar(cx, cy, 27, 0);
    var pt2 = polar(cx, cy, 6, 0);
    svgEl(
      "line",
      {
        x1: pt1[0],
        y1: pt1[1],
        x2: pt2[0],
        y2: pt2[1],
        stroke: "#f4ead0",
        "stroke-width": 3.5,
        "stroke-linecap": "round",
      },
      sk,
    );

    svg.tabIndex = 0;
    svg.setAttribute("role", "slider");

    function paint(idx) {
      var ang = cfg.continuous ? -70 + (140 * idx) / 100 : cfg.angles[idx];
      sk.setAttribute(
        "transform",
        "rotate(" + ang.toFixed(1) + " " + cx + " " + cy + ")",
      );
      if (cfg.continuous) {
        svg.setAttribute("aria-valuemin", "0");
        svg.setAttribute("aria-valuemax", "100");
        svg.setAttribute("aria-valuenow", String(Math.round(idx)));
        svg.setAttribute("aria-valuetext", Math.round(idx) + " percent load");
      } else {
        svg.setAttribute("aria-valuemin", "0");
        svg.setAttribute("aria-valuemax", String(cfg.labels.length - 1));
        svg.setAttribute("aria-valuenow", String(idx));
        svg.setAttribute("aria-valuetext", cfg.labels[idx]);
      }
    }

    function apply(idx) {
      paint(idx);
      cfg.onChange(idx);
    }

    function setFromEvent(ev) {
      var box = svg.getBoundingClientRect();
      var dx = ev.clientX - (box.left + box.width / 2);
      var dy = ev.clientY - (box.top + box.height / 2);
      var deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      deg = Math.max(-70, Math.min(70, deg));
      if (cfg.continuous) {
        apply(((deg + 70) / 140) * 100);
      } else {
        var best = 0;
        var bd = 1e9;
        cfg.angles.forEach(function (aa, ii) {
          var dd = Math.abs(aa - deg);
          if (dd < bd) {
            bd = dd;
            best = ii;
          }
        });

        apply(best);
      }
    }

    var dragging = false;
    svg.addEventListener("pointerdown", function (ev) {
      dragging = true;
      svg.setPointerCapture(ev.pointerId);
      setFromEvent(ev);
      pokeAudio();
    });
    svg.addEventListener("pointermove", function (ev) {
      if (dragging) setFromEvent(ev);
    });
    svg.addEventListener("pointerup", function () {
      dragging = false;
    });
    svg.addEventListener("keydown", function (ev) {
      var dir =
        ev.key === "ArrowRight" || ev.key === "ArrowUp"
          ? 1
          : ev.key === "ArrowLeft" || ev.key === "ArrowDown"
            ? -1
            : 0;
      if (!dir) return;
      ev.preventDefault();
      pokeAudio();
      var cur = cfg.get();
      if (cfg.continuous) apply(Math.max(0, Math.min(100, cur + dir * 5)));
      else apply(Math.max(0, Math.min(cfg.labels.length - 1, cur + dir)));
    });

    return { paint: paint, apply: apply };
  }

  /* --------------------------------------------------------- sim state */

  function coldState() {
    return {
      time: 0,
      master: false,
      fuelPump: false,
      friction: false,
      throttle: 0,
      gills: 0,
      mixture: 0, // 0 cut-off, 1 lean, 2 rich
      mags: 0, // 0 off, 1 L, 2 R, 3 BOTH
      dyno: 0,
      prime: 0,
      spinHeld: false,
      flywheel: 0,
      crank: 0,
      running: false,
      rpm: 0,
      boost: -6,
      bhpShown: 0,
      oilTemp: 14,
      headTemp: 16,
      oilPress: 0,
      fuel: 0,
      carbLevel: 0,
      drainHeld: false,
      seized: false,
      seizeTimer: 0,
      starve: 0,
      faults: { mag: false, cooler: false, carb: false },
      ack: 0,
      alarmSeq: 0,
    };
  }

  var S = coldState();
  var acc = 0;

  function approach(cur, target, tau, dt) {
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  }

  function effMagFactor() {
    var mf = MAG_FACTOR[S.mags];
    if (S.faults.mag && S.mags === 3) mf = 0.78;
    if (S.faults.mag && S.mags === 1) mf = 0.93;
    return mf;
  }

  function tryCatch() {
    if (S.running) return;
    S.running = true;
    S.rpm = Math.max(S.rpm, 380);
    S.alarmSeq++;
  }

  function step(dt) {
    S.time += dt;
    var magFault = S.faults.mag;
    var coolerHealth = S.faults.cooler ? 0.14 : 1;

    /* primer charge evaporates slowly */
    S.prime = Math.max(0, S.prime - 0.05 * dt);

    /* inertia starter flywheel */
    if (S.spinHeld && S.master) {
      S.flywheel = Math.min(1650, S.flywheel + 780 * dt);
    } else {
      S.flywheel = Math.max(0, S.flywheel - (S.crank > 0 ? 900 : 130) * dt);
    }

    /* cranking */
    if (S.crank > 0) {
      S.crank -= dt;
      S.rpm = Math.max(S.rpm, 170 + 40 * Math.sin(S.time * 9));
      var needsPrime = S.oilTemp < 35 ? S.prime > 0.22 : true;
      var magOk = S.mags === 1 || S.mags === 3 || (S.mags === 2 && !magFault);
      if (
        !S.running &&
        S.crank < 2.4 &&
        needsPrime &&
        magOk &&
        S.master &&
        S.fuelPump &&
        S.carbLevel < 0.92 &&
        MIX_FACTOR[S.mixture] > 0
      ) {
        S.prime -= 0.06 * dt;
        tryCatch();
      }
    } else if (!S.running) {
      S.rpm = approach(S.rpm, 0, 0.7, dt);
    }

    /* running engine speed */
    if (S.running) {
      var T = S.throttle;
      var mixf = MIX_FACTOR[S.mixture];
      var floodDrag = 1 - 0.55 * Math.max(0, S.carbLevel - 0.25);
      var target =
        (520 + 2120 * T) *
        (1 - 0.3 * (S.dyno / 100)) *
        floodDrag *
        effMagFactor() *
        mixf;
      if (!S.master || !S.fuelPump || S.starve > 3.5 || S.carbLevel > 0.94)
        target = 0;
      S.rpm = approach(S.rpm, Math.max(target, S.crank > 0 ? 170 : 0), 1.1, dt);
      if (S.rpm < 240 && S.crank <= 0) {
        S.running = false;
      }
      if (!S.fuelPump || !S.master) S.starve += dt;
      else S.starve = 0;
    } else if (S.crank <= 0) {
      S.rpm = approach(S.rpm, 0, 0.6, dt);
    }

    /* air, boost, shaft power */
    var rpmN = Math.min(1, S.rpm / 2400);
    var boostTarget =
      S.rpm < 60
        ? -6
        : -7 + 19 * Math.pow(S.throttle, 0.85) * (0.3 + 0.7 * rpmN);
    boostTarget = Math.max(-6.5, Math.min(12.2, boostTarget));
    S.boost = approach(S.boost, boostTarget, 0.5, dt);

    var bhp =
      S.running && S.boost > 0
        ? 13.5 *
          S.boost *
          (S.rpm / 1000) *
          effMagFactor() *
          MIX_FACTOR[S.mixture]
        : 0;
    bhp *= 1 - 0.5 * Math.max(0, S.carbLevel - 0.25);
    S.bhpShown = approach(S.bhpShown, Math.max(0, bhp), 0.4, dt);

    /* fuel flow */
    var fuelTarget = S.running
      ? (2.6 + 60 * S.throttle * MIX_FACTOR[S.mixture] * rpmN) *
        (1 + 1.25 * S.carbLevel)
      : 0;
    S.fuel = approach(S.fuel, fuelTarget, 0.5, dt);

    /* float chamber */
    if (S.faults.carb) S.carbLevel = Math.min(1, S.carbLevel + 0.045 * dt);
    if (S.drainHeld && S.master)
      S.carbLevel = Math.max(0, S.carbLevel - 0.3 * dt);

    /* cooling and oil temperature */
    var loadFrac = Math.min(1.15, (S.bhpShown + 0.06 * S.rpm) / 430);
    var oilTgt = 18 + (118 * loadFrac) / (0.72 + 1.02 * S.gills * coolerHealth);
    var headTgt =
      25 + (235 * loadFrac) / (0.62 + 1.05 * S.gills * coolerHealth);
    S.oilTemp = Math.max(12, approach(S.oilTemp, oilTgt, 26, dt));
    S.headTemp = Math.max(14, approach(S.headTemp, headTgt, 13, dt));

    /* oil pressure */
    var hotPenalty = S.oilTemp > 112 ? (S.oilTemp - 112) * 1.15 : 0;
    var opTgt = S.running
      ? Math.max(0, 26 + 47 * rpmN - hotPenalty)
      : S.crank > 0
        ? 9
        : 0;
    S.oilPress = approach(S.oilPress, opTgt, 0.8, dt);

    /* consequences: ignore the temperatures and she seizes */
    var seizing =
      (S.oilTemp > 138 || S.headTemp > 285 || (S.running && S.oilPress < 15)) &&
      (S.running || S.rpm > 300);
    if (seizing) {
      S.seizeTimer += dt;
      if (S.seizeTimer > 5) {
        S.seized = true;
        S.running = false;
        S.alarmSeq++;
      }
    } else {
      S.seizeTimer = Math.max(0, S.seizeTimer - dt * 0.5);
    }
    if (S.seized) {
      S.running = false;
      S.rpm = approach(S.rpm, 0, 0.45, dt);
      S.oilPress = approach(S.oilPress, 0, 0.4, dt);
      S.boost = approach(S.boost, -6, 1, dt);
      S.bhpShown = approach(S.bhpShown, 0, 0.4, dt);
      S.fuel = approach(S.fuel, 0, 0.5, dt);
    }
  }

  /* ------------------------------------------------------------ alarms */

  function roughRunning() {
    return (
      (S.faults.mag && (S.mags === 3 || S.mags === 2)) ||
      (S.carbLevel > 0.3 && S.running)
    );
  }

  function alarms() {
    var a = [];
    var magIsolated =
      S.mags === 1; /* LEFT isolates the earthed right magneto */
    if (S.faults.mag && !magIsolated) a.push("MAGNETO EARTH FAULT");
    if (S.faults.cooler) a.push("OIL COOLER BLOCKED");
    if (S.faults.carb || S.carbLevel >= 0.35) a.push("FLOAT CHAMBER FLOODED");
    if (S.oilTemp >= 112) a.push("OIL TEMPERATURE HIGH");
    if (S.headTemp >= 232) a.push("HEAD TEMPERATURE HIGH");
    if (S.running && S.rpm > 450 && S.oilPress <= 38)
      a.push("OIL PRESSURE LOW");
    if (roughRunning()) a.push("ROUGH RUNNING");
    if (S.seized) a.push("SEIZURE");
    return a;
  }

  /* ------------------------------------------------------------- API */

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  function state() {
    return {
      running: S.running,
      cranking: S.crank > 0,
      seized: S.seized,
      rpm: round1(S.rpm),
      boostPsi: round1(S.boost),
      bhp: round1(S.bhpShown),
      oilPressPsi: round1(S.oilPress),
      oilTempC: round1(S.oilTemp),
      headTempC: round1(S.headTemp),
      fuelGalPerHr: round1(S.fuel),
      flywheelRpm: Math.round(S.flywheel),
      throttleFraction: round1(S.throttle),
      gillsFraction: round1(S.gills),
      dynoLoadPercent: Math.round(S.dyno),
      carbFloatLevel: round1(S.carbLevel),
      magnetoSelector: ["OFF", "LEFT", "RIGHT", "BOTH"][S.mags],
      mixtureSelector: ["IDLE CUT-OFF", "AUTO LEAN", "AUTO RICH"][S.mixture],
      roughRunning: roughRunning(),
      secondsRun: round1(S.time),
      alarms: alarms(),
    };
  }

  function tick(seconds) {
    var s = Number(seconds) || 0;
    if (!isFinite(s) || s < 0) s = 0;
    if (s > 600) s = 600;
    acc += s;
    while (acc >= H) {
      step(H);
      acc -= H;
    }
  }

  function setFault(name, on) {
    var key = null;
    if (name.indexOf("magneto") === 0) key = "mag";
    else if (name.indexOf("oil cooler") === 0) key = "cooler";
    else if (name.indexOf("float") === 0) key = "carb";
    if (!key) return;
    S.faults[key] = !!on;
    if (on) {
      S.alarmSeq++;
      openFaultGear(true);
    }
    var box = { mag: $("ft-mag"), cooler: $("ft-cooler"), carb: $("ft-carb") }[
      key
    ];
    if (box && box.checked !== !!on) box.checked = !!on;
  }

  function inject(fault) {
    setFault(String(fault).toLowerCase(), true);
  }

  function reset() {
    S = coldState();
    acc = 0;
    $("sw-master").checked = false;
    $("sw-fuelpump").checked = false;
    $("sw-friction").checked = false;
    $("lever-throttle").value = "0";
    $("lever-gills").value = "0";
    $("ft-mag").checked = false;
    $("ft-cooler").checked = false;
    $("ft-carb").checked = false;
    rotMags.apply(0);
    rotMix.apply(0);
    rotDyno.apply(0);
    syncThrottleText();
    syncGillsText();
    document.querySelectorAll(".cell.on").forEach(function (c) {
      c.classList.remove("on");
    });
    silenceBellUntilNew();
  }

  /* ------------------------------------------------------- DOM wiring */

  var rotMags;
  var rotMix;
  var rotDyno;
  var setters = {};
  var gearOpen = false;

  function syncThrottleText() {
    var el = $("lever-throttle");
    var v = Number(el.value);
    el.setAttribute(
      "aria-valuetext",
      v === 0 ? "closed" : v <= 8 ? "cracked" : Math.round(v) + " percent open",
    );
  }

  function syncGillsText() {
    var el = $("lever-gills");
    var v = Number(el.value);
    el.setAttribute(
      "aria-valuetext",
      v === 0 ? "shut" : Math.round(v) + " percent open",
    );
  }

  function openFaultGear(open) {
    gearOpen = open;
    var gear = document.querySelector(".faultgear");
    if (gear) gear.classList.toggle("open", open);
    var sw = $("fault-switches");
    if (sw) sw.hidden = !open;
    var cov = $("fault-cover");
    if (cov) cov.setAttribute("aria-expanded", String(open));
  }

  function holdButton(id, setter) {
    var btn = $(id);
    setter(false);
    btn.addEventListener("pointerdown", function () {
      setter(true);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (evn) {
      btn.addEventListener(evn, function () {
        setter(false);
      });
    });
    btn.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) setter(true);
    });
    btn.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") setter(false);
    });
    btn.addEventListener("blur", function () {
      setter(false);
    });
  }

  function wireControls() {
    $("sw-master").addEventListener("change", function (e) {
      S.master = e.target.checked;
      pokeAudio();
    });
    $("sw-fuelpump").addEventListener("change", function (e) {
      S.fuelPump = e.target.checked;
      pokeAudio();
    });
    $("sw-friction").addEventListener("change", function (e) {
      S.friction = e.target.checked;
      pokeAudio();
    });

    var thr = $("lever-throttle");
    thr.addEventListener("input", function () {
      if (S.friction) {
        thr.value = String(Math.round(S.throttle * 100));
        return;
      }
      S.throttle = Number(thr.value) / 100;
      syncThrottleText();
    });
    thr.addEventListener("pointerdown", pokeAudio);

    var gl = $("lever-gills");
    gl.addEventListener("input", function () {
      S.gills = Number(gl.value) / 100;
      syncGillsText();
    });
    gl.addEventListener("pointerdown", pokeAudio);

    holdButton("btn-spin", function (on) {
      S.spinHeld = on;
      $("btn-spin").classList.toggle("pressed", on);
      if (on) pokeAudio();
    });
    holdButton("btn-drain", function (on) {
      S.drainHeld = on;
      $("btn-drain").classList.toggle("pressed", on);
      if (on) pokeAudio();
    });

    $("btn-primer").addEventListener("pointerdown", function () {
      S.prime = Math.min(1, S.prime + 0.36);
      pokeAudio();
    });
    $("btn-primer").addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        S.prime = Math.min(1, S.prime + 0.36);
      }
    });

    var mesh = $("knob-mesh");
    mesh.addEventListener("click", function () {
      mesh.classList.add("pulled");
      setTimeout(function () {
        mesh.classList.remove("pulled");
      }, 380);
      pokeAudio();
      if (S.seized) {
        sound.clunk(0.6, 42);
        return;
      }
      if (S.flywheel < 750) {
        sound.clunk(0.35, 55);
        return;
      }
      S.crank = 3;
      sound.clunk(0.8, 90);
    });

    [
      ["ft-mag", "mag"],
      ["ft-cooler", "cooler"],
      ["ft-carb", "carb"],
    ].forEach(function (pair) {
      $(pair[0]).addEventListener("change", function (e) {
        S.faults[pair[1]] = e.target.checked;
        if (e.target.checked) {
          S.alarmSeq++;
          pokeAudio();
        }
      });
    });

    var cover = $("fault-cover");
    cover.addEventListener("click", function () {
      openFaultGear(!gearOpen);
      pokeAudio();
    });

    $("btn-lamps").addEventListener("click", function () {
      lampTestUntil = Date.now() + 1400;
      pokeAudio();
    });
    $("btn-silence").addEventListener("click", function () {
      silenceBellUntilNew();
      pokeAudio();
    });
    $("btn-reset").addEventListener("click", function () {
      reset();
      pokeAudio();
    });
  }

  /* ------------------------------------------------------ dial builders */

  function buildAllDials() {
    setters.tach = buildGauge($("dial-tach"), {
      cx: 110,
      cy: 108,
      r: 84,
      min: 0,
      max: 30,
      from: -125,
      to: 125,
      major: 6,
      minor: 5,
      number: function (v) {
        return String(Math.round(v));
      },
      yellow: [20, 24],
      red: [26, 30],
      caption: "OSPREY Mk.IV",
      numSize: 13,
    });
    setters.boost = buildGauge($("dial-boost"), {
      cx: 65,
      cy: 62,
      r: 46,
      min: -6,
      max: 14,
      from: -120,
      to: 120,
      major: 5,
      minor: 2,
      number: function (v) {
        return String(Math.round(v));
      },
      yellow: [7, 12],
      red: [12, 14],
      caption: "BOOST",
      numSize: 9,
    });
    setters.bhp = buildGauge($("dial-bhp"), {
      cx: 65,
      cy: 62,
      r: 46,
      min: 0,
      max: 400,
      from: -120,
      to: 120,
      major: 8,
      minor: 2,
      number: function (v) {
        return String(Math.round(v / 50) * 50);
      },
      yellow: [270, 330],
      red: [330, 400],
      caption: "BRAKE HP",
      numSize: 8,
    });
    setters.oilpress = buildGauge($("dial-oilpress"), {
      cx: 65,
      cy: 62,
      r: 46,
      min: 0,
      max: 90,
      from: -120,
      to: 120,
      major: 6,
      minor: 2,
      number: function (v) {
        return String(Math.round(v / 15) * 15);
      },
      red: [0, 38],
      green: [45, 80],
      caption: "OIL PRESS",
      numSize: 9,
    });
    setters.oiltemp = buildGauge($("dial-oiltemp"), {
      cx: 65,
      cy: 62,
      r: 46,
      min: 0,
      max: 140,
      from: -120,
      to: 120,
      major: 7,
      minor: 2,
      number: function (v) {
        return String(Math.round(v / 20) * 20);
      },
      yellow: [85, 112],
      red: [112, 140],
      caption: "OIL IN",
      numSize: 9,
    });
    setters.fuelflow = buildGauge($("dial-fuelflow"), {
      cx: 65,
      cy: 62,
      r: 46,
      min: 0,
      max: 80,
      from: -120,
      to: 120,
      major: 4,
      minor: 2,
      number: function (v) {
        return String(Math.round(v / 10) * 10);
      },
      red: [70, 80],
      caption: "FUEL FLOW",
      numSize: 9,
    });
    setters.flywheel = buildGauge($("dial-flywheel"), {
      cx: 60,
      cy: 66,
      r: 42,
      min: 0,
      max: 2000,
      from: -110,
      to: 110,
      major: 4,
      minor: 2,
      number: function (v) {
        return String(Math.round(v / 500) * 500);
      },
      green: [900, 1650],
      caption: "INERTIA",
      numSize: 8,
    });
    setters.head = buildBar($("bar-headtemp"));

    rotMags = buildRotary($("rot-mags"), {
      id: "mags",
      labels: ["OFF", "L", "R", "BOTH"],
      angles: [-75, -25, 25, 75],
      get: function () {
        return S.mags;
      },
      onChange: function (i) {
        S.mags = i;
      },
    });
    rotMix = buildRotary($("rot-mixture"), {
      id: "mix",
      labels: ["CUT-OFF", "LEAN", "RICH"],
      angles: [-60, 0, 60],
      get: function () {
        return S.mixture;
      },
      onChange: function (i) {
        S.mixture = i;
      },
    });
    rotDyno = buildRotary($("rot-dyno"), {
      id: "dyno",
      continuous: true,
      get: function () {
        return S.dyno;
      },
      onChange: function (i) {
        S.dyno = i;
      },
    });
    rotMags.paint(0);
    rotMix.paint(0);
    rotDyno.paint(0);
  }

  /* ---------------------------------------------------------- rendering */

  var lampTestUntil = 0;

  function render() {
    var st = state();
    var wobble = st.roughRunning
      ? Math.sin(S.time * 11) * 0.9 + Math.sin(S.time * 23) * 0.5
      : Math.sin(S.time * 7) * 0.12;
    setters.tach(st.rpm / 100 + wobble);
    setters.boost(st.boostPsi);
    setters.bhp(st.bhp);
    setters.oilpress(st.oilPressPsi);
    setters.oiltemp(st.oilTempC);
    setters.fuelflow(st.fuelGalPerHr);
    setters.flywheel(S.flywheel);
    setters.head(st.headTempC);

    var al = {};
    st.alarms.forEach(function (n) {
      al[n] = true;
    });
    var testing = Date.now() < lampTestUntil;
    function lamp(id, on) {
      var cell = document.querySelector('[data-lamp="' + id + '"]');
      if (cell) cell.classList.toggle("on", testing || on);
    }
    lamp("starter", S.crank > 0 || S.flywheel > 200);
    lamp("running", st.running);
    lamp("rough", !!al["ROUGH RUNNING"]);
    lamp("oiltemp", !!al["OIL TEMPERATURE HIGH"]);
    lamp("headtemp", !!al["HEAD TEMPERATURE HIGH"]);
    lamp("oilpress", !!al["OIL PRESSURE LOW"]);
    lamp("flood", !!al["FLOAT CHAMBER FLOODED"]);
    lamp("seized", st.seized);
  }

  /* -------------------------------------------------------------- sound */

  var AC = null;
  var snd = null;
  var sound = {
    clunk: function () {},
  };

  function pokeAudio() {
    if (!snd) initSound();
    if (AC && AC.state === "suspended") AC.resume();
  }

  function initSound() {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      AC = null;
      return;
    }
    var master = AC.createGain();
    master.gain.value = 0.55;
    master.connect(AC.destination);

    var engFilter = AC.createBiquadFilter();
    engFilter.type = "lowpass";
    engFilter.frequency.value = 320;
    var engGain = AC.createGain();
    engGain.gain.value = 0;
    engFilter.connect(engGain);
    engGain.connect(master);
    var engA = AC.createOscillator();
    engA.type = "sawtooth";
    engA.frequency.value = 40;
    var engB = AC.createOscillator();
    engB.type = "square";
    engB.frequency.value = 20;
    var engBGain = AC.createGain();
    engBGain.gain.value = 0.4;
    engA.connect(engFilter);
    engB.connect(engBGain);
    engBGain.connect(engFilter);
    engA.start();
    engB.start();

    var startGain = AC.createGain();
    startGain.gain.value = 0;
    var startFilter = AC.createBiquadFilter();
    startFilter.type = "lowpass";
    startFilter.frequency.value = 1500;
    var startOsc = AC.createOscillator();
    startOsc.type = "sawtooth";
    startOsc.frequency.value = 90;
    startOsc.connect(startFilter);
    startFilter.connect(startGain);
    startGain.connect(master);
    startOsc.start();

    var bellGain = AC.createGain();
    bellGain.gain.value = 0;
    var bellFilter = AC.createBiquadFilter();
    bellFilter.type = "bandpass";
    bellFilter.frequency.value = 780;
    bellFilter.Q.value = 6;
    var bellOsc = AC.createOscillator();
    bellOsc.type = "square";
    bellOsc.frequency.value = 780;
    bellOsc.connect(bellFilter);
    bellFilter.connect(bellGain);
    bellGain.connect(master);
    bellOsc.start();

    snd = {
      master: master,
      engA: engA,
      engB: engB,
      engGain: engGain,
      engFilter: engFilter,
      startOsc: startOsc,
      startGain: startGain,
      bellGain: bellGain,
    };

    sound.clunk = function (vol, freq) {
      if (!AC || AC.state !== "running") return;
      var o = AC.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq || 80;
      var g = AC.createGain();
      g.gain.setValueAtTime(0.001, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(
        Math.min(0.4, vol),
        AC.currentTime + 0.01,
      );
      g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.16);
      o.connect(g);
      g.connect(snd.master);
      o.start();
      o.stop(AC.currentTime + 0.2);
    };
  }

  function silenceBellUntilNew() {
    S.ack = S.alarmSeq;
  }

  function updateSound() {
    if (!snd || !AC || AC.state !== "running") return;
    var t = AC.currentTime;
    var firing = Math.max(6, (S.rpm / 60) * 3.5);
    var engineVol = S.running
      ? 0.05 + 0.1 * S.throttle
      : S.crank > 0
        ? 0.05
        : 0;
    snd.engA.frequency.setTargetAtTime(firing, t, 0.08);
    snd.engB.frequency.setTargetAtTime(firing / 2, t, 0.08);
    snd.engFilter.frequency.setTargetAtTime(220 + S.rpm * 0.35, t, 0.15);
    snd.engGain.gain.setTargetAtTime(engineVol, t, 0.12);

    var spinVol = S.spinHeld && S.master ? 0.06 * (S.flywheel / 1650) : 0;
    snd.startOsc.frequency.setTargetAtTime(90 + S.flywheel * 0.72, t, 0.05);
    snd.startGain.gain.setTargetAtTime(spinVol, t, 0.06);

    var unacked = alarms().length > 0 && S.alarmSeq > S.ack;
    var bellVol = unacked && S.time % 1.3 < 0.4 ? 0.05 : 0;
    snd.bellGain.gain.setTargetAtTime(bellVol, t, 0.02);
  }

  /* -------------------------------------------------------- main loop */

  var last = null;
  function frame(now) {
    if (last == null) last = now;
    var dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (!document.hidden) {
      tick(dt);
      render();
      updateSound();
    }
    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    if (!AC) return;
    if (document.hidden) AC.suspend();
    else AC.resume();
  });

  /* ------------------------------------------------------ manual dialog */

  function wireDialog() {
    var dlg = $("manual-dialog");
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
  }

  /* --------------------------------------------------------------- go */

  buildAllDials();
  wireControls();
  wireDialog();
  syncThrottleText();
  syncGillsText();
  render();
  requestAnimationFrame(frame);

  window.machine = {
    name: MACHINE_NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
    setFault: setFault,
  };
})();
