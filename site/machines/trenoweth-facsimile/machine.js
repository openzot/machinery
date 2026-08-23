/* ============================================================
   FACSIMILE CHART RECEIVER MK. III — simulation and behaviour.
   Trenoweth Regional Forecast Office, 1954.
   Vanilla script; exposes window.machine { name, faults,
   state(), tick(seconds), inject(fault), reset() }.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- little helpers ------------------------- */

  var $ = function (id) {
    return document.getElementById(id);
  };
  var clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };
  var frac = function (x) {
    return x - Math.floor(x);
  };
  function hash(n) {
    return frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
  }
  function smoothNoise(t) {
    var i = Math.floor(t);
    var f = t - i;
    var u = f * f * (3 - 2 * f);
    return hash(i) * (1 - u) + hash(i + 1) * u;
  }
  function nz(t) {
    return smoothNoise(t) * 2 - 1;
  }

  /* ---------------- the state of the machine --------------- */

  var FAULTS = ["line dropout", "stylus burnout", "drive belt slip"];
  var CHART_SECONDS_AT_90 = 300; /* a full strip at index 90 */

  var S = {};

  function coldState() {
    S.timeSec = 0;
    S.powerOn = false;
    S.circuit = "main";
    S.indexRpm = 90;
    S.gainDb = 0;
    S.phaseKnob = 0;
    S.density = 4;
    S.clutchRun = false;

    S.signalDb = -55;
    S.phaseDrift = 0;
    S.phaseErrorDeg = 0;
    S.onSync = false;
    S.drumRpm = 0;
    S.rejectHold = 0;
    S.slipDamage = 0;

    S.chartSeed = 7;
    S.chartStatus = "NONE"; /* NONE | READY | RECORDING | COMPLETE | REJECTED */
    S.chartPercent = 0;
    S.committedTo = 0;
    S.stylusTempC = 21;
    S.wearHold = 0;
    S.stylusWorn = false;
    S.cleanCount = 0;
    S.lastCleanAt = -999;

    S.chartsDone = 0;
    S.chartsWasted = 0;
    S.lineVolts = 239;

    /* injected faults */
    S.fDropout = false;
    S.fBurn = false;
    S.fBelt = false;

    /* latches */
    S.latchChartEnd = false;
    S.latchWasted = false;

    S.acked = true;
    S.alarmKey = "";
    S.lampTest = false;
    S.note = "";
    S.noteUntil = 0;
  }
  coldState();

  function alarmsNow() {
    var spinning = S.powerOn && S.clutchRun;
    var a = [];
    if (S.fDropout || (spinning && effectiveSignal() < -38))
      a.push("SIGNAL LOW");
    if (spinning && Math.abs(S.phaseErrorDeg) > 25) a.push("OFF PHASE");
    if (S.fBurn || S.stylusTempC >= 95) a.push("STYLUS OVERHEAT");
    if (S.fBelt || (spinning && Math.abs(S.drumRpm - targetRpm()) > 6))
      a.push("DRIVE FAULT");
    if (S.latchChartEnd) a.push("CHART END");
    if (S.latchWasted) a.push("CHART WASTED");
    return a;
  }

  /* ---------------- physics -------------------------------- */

  function targetRpm() {
    var t = targetRpmRaw();
    if (S.fBelt) {
      t *= 0.84 + 0.1 * Math.sin(S.timeSec * 1.9) + 0.06 * nz(S.timeSec * 0.7);
    }
    return t;
  }
  function targetRpmRaw() {
    return S.powerOn && S.clutchRun ? S.indexRpm : 0;
  }
  function effectiveSignal() {
    return S.signalDb + S.gainDb * 0.85 + (S.stylusWorn ? -7 : 0);
  }
  function quality() {
    return clamp((effectiveSignal() + 42) / 36, 0, 1);
  }
  function spinning() {
    return S.powerOn && S.clutchRun;
  }

  function tick(seconds) {
    var dt = clamp(Number(seconds) || 0, 0, 600);
    var steps = Math.max(1, Math.ceil(dt / 0.5));
    var h = dt / steps;
    for (var i = 0; i < steps; i++) step(h);
  }

  function step(dt) {
    S.timeSec += dt;
    var t = S.timeSec;

    /* mains */
    S.lineVolts = 239 + nz(t * 0.5) * 3.2;

    /* incoming line signal, dB */
    var sigTarget;
    if (!S.powerOn) sigTarget = -55;
    else if (S.circuit === "tone") sigTarget = -6 + nz(t * 0.05) * 0.5;
    else if (S.circuit === "standby") sigTarget = -33 + nz(t * 0.23) * 5;
    else sigTarget = -18 + nz(t * 0.11) * 3.2;
    if (S.fDropout) sigTarget = -52 + nz(t * 0.31) * 6;
    S.signalDb += (sigTarget - S.signalDb) * clamp(dt * 2.2, 0, 1);

    /* synchronising: drift walks while quality is poor, servo locks it */
    var spin = spinning();
    var q = quality();
    var c = S.phaseKnob;
    if (spin) {
      var push =
        q < 0.5
          ? (0.5 - q) * 30 * nz(t * 0.09)
          : -(q - 0.5) * 4 * (S.phaseDrift / 60);
      S.phaseDrift += push * dt;
      S.phaseDrift -= S.phaseDrift * dt * (q > 0.45 ? 0.12 : 0.02);
      if (S.onSync) S.phaseDrift += (-c - S.phaseDrift) * clamp(dt * 1.4, 0, 1);
    }
    S.phaseErrorDeg = clamp(S.phaseDrift + c, -240, 240);
    S.onSync = spin && Math.abs(S.phaseErrorDeg) <= 6 && q >= 0.35;

    /* drum */
    var rt = targetRpm();
    S.drumRpm += (rt - S.drumRpm) * clamp(dt * 3.5, 0, 1);

    /* stylus temperature: only a powered machine heats her tip */
    var rpmNorm = S.drumRpm / 120;
    var heat = 0.15;
    if (S.powerOn) heat += spin ? 0.8 + S.density * 0.75 + rpmNorm * 1.4 : 0.5;
    if (S.fBurn && S.powerOn) heat += 34;
    var eq = 21 + heat / 0.09;
    S.stylusTempC += (eq - S.stylusTempC) * clamp(dt / 11, 0, 1);
    S.stylusTempC = clamp(S.stylusTempC, 15, 260);

    /* burned stylus */
    if (S.stylusTempC >= 116) {
      S.wearHold += dt;
      if (S.wearHold >= 40 && !S.stylusWorn) {
        S.stylusWorn = true;
        S.wearHold = 0;
        if (S.chartStatus === "RECORDING")
          rejectChart("REJECTED — STYLUS BURNED");
      }
    } else {
      S.wearHold = Math.max(0, S.wearHold - dt * 2);
    }

    /* belt-slip neglect ruins the mechanism */
    if (S.fBelt && spin) {
      S.slipDamage += dt;
      if (S.slipDamage > 90) {
        S.slipDamage = 0;
        setClutch(false);
        if (S.chartStatus === "RECORDING")
          rejectChart("REJECTED — DRIVE JAMMED");
        say("JAM — CYCLE MAINS AND RESET BELT");
      }
    } else {
      S.slipDamage = Math.max(0, S.slipDamage - dt * 4);
    }

    /* the chart itself */
    if (spin && S.chartStatus === "READY" && S.drumRpm > 5) {
      S.chartStatus = "RECORDING";
    }
    if (S.chartStatus === "RECORDING") {
      S.chartPercent += (S.drumRpm / 90) * dt * (100 / CHART_SECONDS_AT_90);
      /* off-phase long enough tears the analysis apart */
      if (Math.abs(S.phaseErrorDeg) > 110) S.rejectHold += dt;
      else S.rejectHold = Math.max(0, S.rejectHold - dt * 2);
      if (S.rejectHold > 4) rejectChart("REJECTED — OUT OF PHASE");
      if (S.chartPercent >= 100) completeChart();
    } else {
      S.rejectHold = 0;
    }

    /* housekeeping */
    var al = alarmsNow();
    var key = al.join("|");
    if (key !== S.alarmKey) {
      S.acked = false;
      S.alarmKey = key;
    }
  }

  function rejectChart(reason) {
    S.chartStatus = "REJECTED";
    S.chartPercent = clamp(S.chartPercent, 0, 100);
    S.latchWasted = true;
    S.chartsWasted++;
    setClutch(false);
    stamp(reason, "#a32014");
  }

  function completeChart() {
    S.chartStatus = "COMPLETE";
    S.chartPercent = 100;
    S.latchChartEnd = true;
    S.chartsDone++;
    setClutch(false);
    stamp("RECEIVED OK", "#274e2d");
  }

  function threadChart() {
    if (S.chartStatus === "RECORDING") {
      rejectChart("REJECTED — CUT AND RE-THREADED");
    }
    S.chartSeed = (S.chartSeed * 16807 + 11) % 2147483647;
    S.chartStatus = "READY";
    S.chartPercent = 0;
    S.committedTo = 0;
    S.rejectHold = 0;
    S.latchChartEnd = false;
    S.latchWasted = false;
    freshPaper();
    paintMap();
    say("FRESH CHART ON THE DRUM");
  }

  function releaseChart() {
    if (S.chartStatus === "RECORDING") {
      S.latchWasted = true;
      S.chartsWasted++;
      setClutch(false);
    }
    S.chartStatus = "NONE";
    S.chartPercent = 0;
    S.committedTo = 0;
    S.latchChartEnd = false;
    S.latchWasted = false;
    freshPaper();
    say("CHART OFF THE DRUM");
  }

  function pressCleaner() {
    if (S.clutchRun) {
      say("STOP THE CLUTCH BEFORE CLEANING");
      return;
    }
    if (S.stylusTempC >= 70) {
      say("LET HER COOL BELOW 70 FIRST");
      return;
    }
    if (S.timeSec - S.lastCleanAt > 60) S.cleanCount = 0;
    S.lastCleanAt = S.timeSec;
    S.cleanCount++;
    S.stylusTempC = Math.max(21, S.stylusTempC - 8);
    if (S.cleanCount >= 3 && S.stylusWorn) {
      S.stylusWorn = false;
      S.cleanCount = 0;
      say("STYLUS CLEANED AND TRUED");
    } else {
      say("PASSES " + S.cleanCount + " OF 3");
    }
  }

  function say(msg) {
    S.note = msg;
    S.noteUntil = S.timeSec + 3;
  }

  /* ---------------- the paper and the map ------------------ */

  var MW = 1320;
  var MH = 384;
  var paper = $("paper");
  var pctx = paper ? paper.getContext("2d") : null;
  var map = document.createElement("canvas");
  map.width = MW;
  map.height = MH;
  var mctx = map.getContext("2d");

  function freshPaper() {
    if (!pctx) return;
    pctx.globalAlpha = 1;
    pctx.fillStyle = "#f6f1e2";
    pctx.fillRect(0, 0, MW, MH);
    /* faint wax sheen bands */
    pctx.fillStyle = "rgba(190,178,148,0.12)";
    for (var y = 0; y < MH; y += 8) pctx.fillRect(0, y, MW, 1);
    /* printed margin */
    pctx.fillStyle = "#95886a";
    pctx.font = '12px "Courier New", monospace';
    var msg = "· THE BUREAU FACSIMILE · INDEX 132 · 25 MM PER MINUTE · ";
    var wide = pctx.measureText(msg).width;
    for (var x = 10; x < MW; x += wide) pctx.fillText(msg, x, MH - 12);
    pctx.fillStyle = "#b9ac8c";
    for (var dx = 6; dx < MW; dx += 22) pctx.fillRect(dx, MH - 30, 2, 2);
  }

  function paintMap() {
    if (!mctx) return;
    mctx.clearRect(0, 0, MW, MH);
    var seed = S.chartSeed;

    /* graticule */
    mctx.strokeStyle = "rgba(122,138,131,0.4)";
    mctx.lineWidth = 1;
    for (var gx = 60; gx < MW; gx += 120) {
      mctx.beginPath();
      mctx.moveTo(gx, 0);
      mctx.lineTo(gx, MH);
      mctx.stroke();
    }
    for (var gy = 40; gy < MH; gy += 96) {
      mctx.beginPath();
      mctx.moveTo(0, gy);
      mctx.lineTo(MW, gy);
      mctx.stroke();
    }

    /* coastline down the left hand side */
    mctx.beginPath();
    mctx.moveTo(0, 0);
    var cx = 150;
    for (var y = 0; y <= MH; y += 56) {
      cx = clamp(cx + (hash(seed + y) - 0.48) * 90, 40, 330);
      mctx.lineTo(cx + Math.sin(y * 0.02 + seed) * 24, y);
    }
    mctx.lineTo(0, MH);
    mctx.closePath();
    mctx.fillStyle = "rgba(196,186,152,0.55)";
    mctx.fill();
    mctx.strokeStyle = "#37413f";
    mctx.lineWidth = 2;
    mctx.stroke();

    /* an island */
    mctx.beginPath();
    var ix = 360 + hash(seed + 3) * 60;
    var iy = 120 + hash(seed + 5) * 160;
    mctx.ellipse(
      ix,
      iy,
      26 + hash(seed + 7) * 18,
      14 + hash(seed + 9) * 12,
      hash(seed) * 3,
      0,
      6.3,
    );
    mctx.fillStyle = "rgba(196,186,152,0.55)";
    mctx.fill();
    mctx.strokeStyle = "#37413f";
    mctx.lineWidth = 1.6;
    mctx.stroke();

    /* pressure centres */
    var lx = MW * (0.4 + hash(seed + 11) * 0.12);
    var ly = MH * (0.36 + hash(seed + 13) * 0.1);
    var hx = MW * (0.74 + hash(seed + 17) * 0.08);
    var hy = MH * (0.62 + hash(seed + 19) * 0.12);

    isobarRing(lx, ly, 46, "968");
    isobarRing(lx, ly, 92, "976");
    isobarRing(lx, ly, 140, "984");
    isobarRing(lx, ly, 192, "992");
    isobarRing(hx, hy, 54, "1022");
    isobarRing(hx, hy, 104, "1014");
    isobarRing(hx, hy, 156, "1006");

    /* fronts spiralling out of the low */
    dashedSpiral(lx, ly, 60, 210, seed, "#37413f", [9, 6]);
    dashedSpiral(
      lx + 30,
      ly + 24,
      40,
      170,
      seed + 40,
      "#37413f",
      [16, 5, 3, 5],
    );

    /* centres marked */
    centreMark(lx, ly, "L");
    centreMark(hx, hy, "H");

    /* a few wind arrows */
    mctx.strokeStyle = "#37413f";
    mctx.lineWidth = 1.4;
    for (var w = 0; w < 7; w++) {
      var wx = 420 + hash(seed + 23 + w) * (MW - 480);
      var wy = 60 + hash(seed + 31 + w) * (MH - 140);
      var ang = hash(seed + 41 + w) * 6.28;
      mctx.beginPath();
      mctx.moveTo(wx - Math.cos(ang) * 14, wy - Math.sin(ang) * 14);
      mctx.lineTo(wx + Math.cos(ang) * 14, wy + Math.sin(ang) * 14);
      mctx.stroke();
      mctx.beginPath();
      mctx.moveTo(wx, wy);
      mctx.lineTo(wx - Math.cos(ang - 0.5) * 8, wy - Math.sin(ang - 0.5) * 8);
      mctx.stroke();
    }

    /* title block */
    mctx.fillStyle = "rgba(246,241,226,0.9)";
    mctx.fillRect(20, 20, 300, 58);
    mctx.strokeStyle = "#37413f";
    mctx.strokeRect(20, 20, 300, 58);
    mctx.fillStyle = "#232d2b";
    mctx.font = 'bold 17px "Courier New", monospace';
    mctx.fillText("SURFACE ANALYSIS  0600 GMT", 32, 46);
    mctx.font = '13px "Courier New", monospace';
    mctx.fillText(
      "ISSUED BY THE CENTRE — CHART " + (1000 + (seed % 900)),
      32,
      68,
    );
  }

  function isobarRing(x, y, r, label) {
    var pts = [];
    var n = 26;
    var wob = hash(r + S.chartSeed) * 6.28;
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * Math.PI * 2;
      var rr =
        r * (1 + 0.22 * Math.sin(a * 3 + wob) + 0.12 * Math.cos(a * 5 - wob));
      pts.push([x + Math.cos(a) * rr * 1.25, y + Math.sin(a) * rr * 0.72]);
    }
    mctx.beginPath();
    mctx.moveTo(pts[0][0], pts[0][1]);
    for (var j = 1; j < pts.length - 1; j++) {
      var mx = (pts[j][0] + pts[j + 1][0]) / 2;
      var my = (pts[j][1] + pts[j + 1][1]) / 2;
      mctx.quadraticCurveTo(pts[j][0], pts[j][1], mx, my);
    }
    mctx.strokeStyle = "#37413f";
    mctx.lineWidth = 1.6;
    mctx.stroke();
    mctx.fillStyle = "#37413f";
    mctx.font = '12px "Courier New", monospace';
    mctx.fillText(label, x + r * 1.25 - 12, y - r * 0.72 - 4);
  }

  function dashedSpiral(x, y, r0, r1, seed, col, dash) {
    mctx.save();
    mctx.setLineDash(dash);
    mctx.strokeStyle = col;
    mctx.lineWidth = 2;
    mctx.beginPath();
    var turns = 2.2;
    for (var i = 0; i <= 120; i++) {
      var f = i / 120;
      var a = f * turns * Math.PI * 2 + hash(seed) * 6;
      var rr = r0 + (r1 - r0) * f;
      var px = x + Math.cos(a) * rr * 1.2;
      var py = y + Math.sin(a) * rr * 0.66;
      if (i === 0) mctx.moveTo(px, py);
      else mctx.lineTo(px, py);
    }
    mctx.stroke();
    mctx.restore();
  }

  function centreMark(x, y, ch) {
    mctx.beginPath();
    mctx.arc(x, y, 15, 0, 6.3);
    mctx.fillStyle = "#f6f1e2";
    mctx.fill();
    mctx.strokeStyle = "#37413f";
    mctx.lineWidth = 2;
    mctx.stroke();
    mctx.fillStyle = "#232d2b";
    mctx.font = "bold 19px Georgia, serif";
    mctx.fillText(ch, x - 6, y + 7);
  }

  function stamp(text, col) {
    if (!pctx) return;
    pctx.save();
    pctx.translate(MW * 0.62, MH * 0.3);
    pctx.rotate(-0.09);
    pctx.globalAlpha = 0.82;
    pctx.strokeStyle = col;
    pctx.lineWidth = 4;
    pctx.strokeRect(-230, -38, 460, 76);
    pctx.fillStyle = col;
    pctx.font = 'bold 34px "Courier New", monospace';
    pctx.textAlign = "center";
    pctx.fillText(text, 0, 12);
    pctx.textAlign = "left";
    pctx.restore();
  }

  function commitColumns() {
    if (!pctx || S.chartStatus === "NONE") return;
    var target = Math.floor((clamp(S.chartPercent, 0, 100) / 100) * MW);
    if (target <= S.committedTo) return;
    var alpha = S.stylusWorn ? 0.16 : 0.3 + S.density * 0.06;
    pctx.globalAlpha = alpha;
    for (var x = S.committedTo; x < target; x++) {
      var dy = clamp(S.phaseErrorDeg * 0.55, -80, 80);
      pctx.drawImage(map, x, 0, 1, MH, x, dy, 1, MH);
    }
    pctx.globalAlpha = 1;
    S.committedTo = target;
  }

  /* ---------------- sound (after a gesture) ----------------- */

  var AC = null;
  var humGain = null;
  var buzGain = null;

  function initAudio() {
    if (AC) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      AC = new Ctx();
      var master = AC.createGain();
      master.gain.value = 0.5;
      master.connect(AC.destination);

      var hp = AC.createBiquadFilter();
      hp.type = "lowpass";
      hp.frequency.value = 240;
      humGain = AC.createGain();
      humGain.gain.value = 0;
      var o1 = AC.createOscillator();
      o1.type = "triangle";
      o1.frequency.value = 100;
      var o2 = AC.createOscillator();
      o2.type = "sawtooth";
      o2.frequency.value = 50;
      o2.connect(hp);
      o1.connect(hp);
      hp.connect(humGain);
      humGain.connect(master);
      o1.start();
      o2.start();

      var bp = AC.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 520;
      bp.Q.value = 2;
      buzGain = AC.createGain();
      buzGain.gain.value = 0;
      var b1 = AC.createOscillator();
      b1.type = "square";
      b1.frequency.value = 520;
      b1.connect(bp);
      bp.connect(buzGain);
      buzGain.connect(master);
      b1.start();
    } catch (e) {
      AC = null;
    }
  }

  function clack() {
    if (!AC) return;
    try {
      var o = AC.createOscillator();
      var g = AC.createGain();
      o.type = "square";
      o.frequency.value = 160;
      g.gain.setValueAtTime(0.08, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0008, AC.currentTime + 0.07);
      o.connect(g);
      g.connect(AC.destination);
      o.start();
      o.stop(AC.currentTime + 0.08);
    } catch (e) {
      /* silent failure is fine */
    }
  }

  function serviceSound() {
    if (!AC) return;
    try {
      if (AC.state === "suspended") AC.resume();
      humGain.gain.setTargetAtTime(S.powerOn ? 0.028 : 0, AC.currentTime, 0.25);
      var unacked = S.alarmKey !== "" && !S.acked;
      var gate =
        unacked && !S.lampTest
          ? Math.sin(Date.now() * 0.02) > 0
            ? 0.035
            : 0.002
          : 0;
      buzGain.gain.setTargetAtTime(gate, AC.currentTime, 0.03);
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------- rendering ------------------------------- */

  var el = {
    lampPower: $("lamp-power"),
    volts: $("volts-counter"),
    circuitPointer: $("circuit-pointer"),
    indexPointer: $("index-pointer"),
    needleSignal: $("needle-signal"),
    needlePhase: $("needle-phase"),
    needleRpm: $("needle-rpm"),
    knobGain: $("knob-gain"),
    knobPhase: $("knob-phase"),
    knobDensity: $("knob-density"),
    syncEye: $("sync-eye"),
    thermoFill: $("thermo-fill"),
    carriage: $("carriage"),
    status: $("chart-status"),
    countGood: $("count-good"),
    countWaste: $("count-waste"),
    cleanerNote: $("cleaner-note"),
    flags: {},
  };
  Array.prototype.forEach.call(
    document.querySelectorAll(".flag"),
    function (f) {
      el.flags[f.getAttribute("data-flag")] = f;
    },
  );

  function setKnob(elm, frac01) {
    if (elm) elm.style.transform = "rotate(" + (-135 + frac01 * 270) + "deg)";
  }
  function setNeedle(elm, deg) {
    if (elm) elm.style.transform = "rotate(" + deg + "deg)";
  }

  function pad(n, w) {
    var s = String(Math.max(0, Math.round(n)));
    while (s.length < w) s = "0" + s;
    return s.slice(-w);
  }

  function render() {
    var al = alarmsNow();
    var test = S.lampTest;

    /* header lamps and counters */
    el.lampPower.classList.toggle("lit", S.powerOn || test);
    el.volts.textContent = pad(S.lineVolts, 3);
    el.countGood.textContent = pad(S.chartsDone, 4);
    el.countWaste.textContent = pad(S.chartsWasted, 2);

    /* selector pointers */
    var circAngle = { main: -35, standby: 0, tone: 35 }[S.circuit];
    el.circuitPointer.style.transform = "rotate(" + circAngle + "deg)";
    var idxAngle = { 60: -35, 90: 0, 120: 35 }[String(S.indexRpm)];
    el.indexPointer.style.transform = "rotate(" + idxAngle + "deg)";

    /* meters */
    var sigShow = clamp(effectiveSignal(), -50, 0);
    setNeedle(el.needleSignal, -46 + ((sigShow + 50) / 50) * 92);
    setNeedle(el.needlePhase, (clamp(S.phaseErrorDeg, -60, 60) / 60) * 44);
    setNeedle(el.needleRpm, (clamp(S.drumRpm, 0, 140) / 140) * 92 - 46);

    /* knobs follow their inputs */
    setKnob(el.knobGain, (S.gainDb + 15) / 30);
    setKnob(el.knobPhase, (S.phaseKnob + 60) / 120);
    setKnob(el.knobDensity, (S.density - 1) / 9);

    /* sync eye */
    el.syncEye.classList.toggle("on", S.onSync || test);

    /* thermometer: 20..130 degrees maps bottom..top */
    var tpct = clamp((S.stylusTempC - 20) / 110, 0, 1);
    el.thermoFill.style.top = (100 - tpct * 100).toFixed(1) + "%";

    /* flags */
    Object.keys(el.flags).forEach(function (name) {
      var lit = test || al.indexOf(name) !== -1;
      var f = el.flags[name];
      f.classList.toggle("lit", lit);
      f.classList.toggle("acked", lit && !test && S.acked);
    });

    /* status plate */
    var txt;
    if (S.note && S.timeSec < S.noteUntil) txt = S.note;
    else if (S.chartStatus === "NONE") txt = "NO CHART";
    else if (S.chartStatus === "READY") txt = "READY — ENGAGE CLUTCH";
    else if (S.chartStatus === "RECORDING")
      txt = "RECORDING " + Math.floor(S.chartPercent) + " %";
    else if (S.chartStatus === "COMPLETE") txt = "COMPLETE — TAKE CHART";
    else txt = "REJECTED — RE-THREAD";
    el.status.textContent = txt;
    el.status.classList.toggle(
      "bad",
      S.chartStatus === "REJECTED" ||
        (!S.lampTest &&
          al.length > 0 &&
          !(txt === S.note && S.timeSec < S.noteUntil)),
    );

    /* stylus carriage rides the write position */
    var cw = paper.clientWidth || MW;
    el.carriage.style.left =
      9 + (clamp(S.chartPercent, 0, 100) / 100) * (cw - 18) + "px";
    el.carriage.classList.toggle("writing", S.chartStatus === "RECORDING");

    commitColumns();
    serviceSound();
  }

  /* ---------------- controls -------------------------------- */

  function setClutch(on) {
    S.clutchRun = !!on;
    var lv = $("clutch");
    if (lv) {
      lv.value = on ? "1" : "0";
      lv.setAttribute("aria-valuetext", on ? "RUN" : "STOP");
    }
  }

  var powerBtn = $("power");
  powerBtn.addEventListener("click", function () {
    initAudio();
    S.powerOn = !S.powerOn;
    powerBtn.setAttribute("aria-checked", String(S.powerOn));
    if (!S.powerOn) {
      setClutch(false);
      say("MAINS OFF");
    } else {
      say("MAINS ON — MOTOR RUNNING");
    }
    clack();
  });

  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="circuit"]'),
    function (r) {
      r.addEventListener("change", function () {
        S.circuit = r.value;
        say(
          S.circuit === "tone"
            ? "TEST TONE ON THE LINE"
            : S.circuit === "standby"
              ? "ON THE STANDBY CIRCUIT"
              : "ON THE MAIN LINE",
        );
      });
    },
  );

  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="index"]'),
    function (r) {
      r.addEventListener("change", function () {
        S.indexRpm = Number(r.value);
        say("INDEX SET TO " + { 60: "92", 90: "132", 120: "176" }[S.indexRpm]);
        clack();
      });
    },
  );

  $("gain").addEventListener("input", function () {
    S.gainDb = Number(this.value);
  });
  $("phase").addEventListener("input", function () {
    S.phaseKnob = Number(this.value);
  });
  $("density").addEventListener("input", function () {
    S.density = Number(this.value);
  });

  var clutchIn = $("clutch");
  clutchIn.addEventListener("input", function () {
    var want = this.value === "1";
    if (want && !S.powerOn) {
      say("NO MAINS — SHE WILL NOT ENGAGE");
      setClutch(false);
      return;
    }
    if (want && S.chartStatus !== "READY" && S.chartStatus !== "RECORDING") {
      say("THREAD A CHART FIRST");
      setClutch(false);
      return;
    }
    if (want !== S.clutchRun) clack();
    S.clutchRun = want;
    clutchIn.setAttribute("aria-valuetext", want ? "RUN" : "STOP");
  });

  var chartIn = $("chartlever");
  chartIn.addEventListener("input", function () {
    var wantThread = this.value === "1";
    if (
      wantThread &&
      S.chartStatus !== "READY" &&
      S.chartStatus !== "RECORDING"
    ) {
      threadChart();
      clack();
    } else if (
      !wantThread &&
      (S.chartStatus === "READY" || S.chartStatus === "COMPLETE")
    ) {
      releaseChart();
      clack();
    } else if (!wantThread && S.chartStatus === "RECORDING") {
      releaseChart();
      clack();
    } else if (wantThread) {
      say("ALREADY THREADED");
    }
  });

  $("cleaner").addEventListener("click", function () {
    initAudio();
    pressCleaner();
  });
  $("accept").addEventListener("click", function () {
    initAudio();
    S.acked = true;
    say("ALARMS ACCEPTED");
    clack();
  });
  $("lampstest").addEventListener("click", function () {
    initAudio();
    S.lampTest = !S.lampTest;
    this.setAttribute("aria-pressed", String(S.lampTest));
  });

  var lid = $("drawerlid");
  lid.addEventListener("click", function () {
    var guts = document.querySelector(".drawerguts");
    var open = guts.hidden;
    guts.hidden = !open;
    lid.setAttribute("aria-expanded", String(open));
  });

  var faultButtons = [
    { btn: $("ft-line"), name: "line dropout", key: "fDropout" },
    { btn: $("ft-burn"), name: "stylus burnout", key: "fBurn" },
    { btn: $("ft-belt"), name: "drive belt slip", key: "fBelt" },
  ];
  faultButtons.forEach(function (f) {
    f.btn.addEventListener("click", function () {
      initAudio();
      var on = S[f.key];
      if (on) clearFault(f.name);
      else inject(f.name);
      f.btn.setAttribute("aria-checked", String(S[f.key]));
      clack();
    });
  });

  $("conreset").addEventListener("click", function () {
    initAudio();
    machine.reset();
    syncInputsFromState();
    say("CONSOLE RESET — COLD");
    clack();
  });

  function syncInputsFromState() {
    powerBtn.setAttribute("aria-checked", String(S.powerOn));
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="circuit"]'),
      function (r) {
        r.checked = r.value === S.circuit;
      },
    );
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="index"]'),
      function (r) {
        r.checked = Number(r.value) === S.indexRpm;
      },
    );
    $("gain").value = String(S.gainDb);
    $("phase").value = String(S.phaseKnob);
    $("density").value = String(S.density);
    $("clutch").value = S.clutchRun ? "1" : "0";
    $("clutch").setAttribute("aria-valuetext", S.clutchRun ? "RUN" : "STOP");
    $("chartlever").value = "0";
    faultButtons.forEach(function (f) {
      f.btn.setAttribute("aria-checked", String(S[f.key]));
    });
    var guts = document.querySelector(".drawerguts");
    if (guts && guts.hidden === false && window.innerWidth < 720) {
      /* leave the drawer as the visitor left it */
    }
  }

  /* ---------------- manual dialog --------------------------- */

  var dlg = document.querySelector("dialog[data-manual]");
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="manual"]'),
    function (b) {
      b.addEventListener("click", function () {
        if (dlg && typeof dlg.showModal === "function") dlg.showModal();
      });
    },
  );
  Array.prototype.forEach.call(
    document.querySelectorAll('[data-action="close-manual"]'),
    function (b) {
      b.addEventListener("click", function () {
        if (dlg && dlg.open) dlg.close();
      });
    },
  );
  if (dlg) {
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) dlg.close();
    });
  }

  /* ---------------- animation loop -------------------------- */

  var hidden = false;
  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    lastFrame = performance.now();
  });
  var lastFrame = performance.now();

  function frame(now) {
    if (!hidden) {
      var dt = clamp((now - lastFrame) / 1000, 0, 0.25);
      if (dt > 0) tick(dt);
      render();
    }
    lastFrame = now;
    window.requestAnimationFrame(frame);
  }

  /* ---------------- the fixed API --------------------------- */

  function inject(fault) {
    var i = FAULTS.indexOf(String(fault).toLowerCase());
    if (i === -1) throw new Error("unknown fault: " + fault);
    if (i === 0) S.fDropout = true;
    if (i === 1) {
      S.fBurn = true;
      S.stylusTempC = Math.max(S.stylusTempC, 96);
    }
    if (i === 2) S.fBelt = true;
    S.acked = false;
  }

  function clearFault(fault) {
    var i = FAULTS.indexOf(String(fault).toLowerCase());
    if (i === -1) throw new Error("unknown fault: " + fault);
    if (i === 0) S.fDropout = false;
    if (i === 1) {
      S.fBurn = false;
      S.stylusTempC = Math.min(S.stylusTempC, 88);
      S.wearHold = 0;
    }
    if (i === 2) {
      S.fBelt = false;
      S.slipDamage = 0;
    }
    S.acked = false;
  }

  var machine = {
    name: "Trenoweth Facsimile Chart Receiver Mk. III",
    faults: FAULTS.slice(),
    state: function () {
      return {
        timeSec: Math.round(S.timeSec * 10) / 10,
        powerOn: S.powerOn,
        circuit: S.circuit,
        indexRpm: S.indexRpm,
        gainDb: S.gainDb,
        phaseKnobDeg: S.phaseKnob,
        density: S.density,
        clutchRun: S.clutchRun,
        signalDb: Math.round(S.signalDb * 10) / 10,
        signalEffectiveDb: Math.round(effectiveSignal() * 10) / 10,
        phaseErrorDeg: Math.round(S.phaseErrorDeg * 10) / 10,
        onSync: S.onSync,
        drumRpm: Math.round(S.drumRpm * 10) / 10,
        targetRpm: Math.round(targetRpm() * 10) / 10,
        stylusTempC: Math.round(S.stylusTempC * 10) / 10,
        stylusWorn: S.stylusWorn,
        chartStatus: S.chartStatus,
        chartPercent: Math.round(clamp(S.chartPercent, 0, 100) * 10) / 10,
        chartsDone: S.chartsDone,
        chartsWasted: S.chartsWasted,
        lineVolts: Math.round(S.lineVolts * 10) / 10,
        faultsActive: [
          S.fDropout ? "line dropout" : null,
          S.fBurn ? "stylus burnout" : null,
          S.fBelt ? "drive belt slip" : null,
        ].filter(Boolean),
        alarms: alarmsNow(),
        acknowledged: S.acked,
      };
    },
    tick: tick,
    inject: inject,
    reset: function () {
      coldState();
      freshPaper();
      if (mctx) mctx.clearRect(0, 0, MW, MH);
      syncInputsFromState();
    },
  };

  window.machine = machine;

  /* ---------------- boot ------------------------------------ */

  freshPaper();
  paintMap(); /* a ghost on the drum so the window is never dead */
  S.chartStatus = "NONE";
  S.committedTo = 0;
  syncInputsFromState();
  render();
  window.requestAnimationFrame(frame);
})();
