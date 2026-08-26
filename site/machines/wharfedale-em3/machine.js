/* ============================================================
   Naylor EM-3 Transmission Electron Microscope — Operating Desk
   Wharfedale Technical College, Electron Optics Bay, 1958.
   Behaviour: vacuum plant, gun high tension, filament emission,
   lens focus and the wilmenite viewing screen, all coupled.
   Deterministic: tick(seconds) is pure integration over dt with
   hash-seeded grain - no randomness that depends on the clock.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- little helpers ---------------- */

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function approach(v, target, rate, dt) {
    var d = target - v;
    var step = rate * dt;
    if (Math.abs(d) <= step) return target;
    return v + Math.sign(d) * step;
  }

  /* deterministic hash noise: same integer -> same value */
  function hash(n) {
    var s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function smooth(knee, x) {
    var t = clamp((x - knee.lo) / (knee.hi - knee.lo), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ---------------- machine constants ---------------- */

  var NAME = "Naylor EM-3 Electron Microscope";

  var FAULTS = ["camera port leak", "filament burnout", "cooling water loss"];

  var MAGS = [2000, 4000, 8000, 16000, 32000, 50000];
  var TRANSMISSION = [1.0, 0.72, 0.5, 0.33, 0.2, 0.13];

  var P_STAND = 4e-6; /* standing vacuum, torr          */
  var P_AIR = 760; /* atmosphere                     */
  var P_DIFF_OK = 5e-2; /* diffusion interlock            */
  var P_HV_OK = 2e-4; /* high tension interlock         */
  var ALARM_VAC = 8e-4; /* column vacuum alarm threshold  */
  var FORE_MAX = 0.42; /* diffusion needs fore below this */

  var DISCHARGE_HOLD = 3; /* seconds of instability before a discharge */

  /* ---------------- state ---------------- */

  var S;

  function coldState() {
    return {
      t: 0,
      mains: false,

      /* vacuum plant */
      pumpPos: 0 /* OFF ROUGH BACK DIFFUSION AUTO */,
      portOpen: true,
      leakIn: 0 /* torr per second at the port   */,
      trapCharge: 0,

      pCol: P_STAND /* column pressure, torr         */,
      pFore: 0.3 /* fore-line pressure, mm Hg     */,

      /* gun */
      hvKey: false,
      hvOn: false,
      kv: 0,
      unstableFor: 0,
      gunLocked: false,
      gunLatched: false,

      /* filament */
      filSet: 0 /* amperes demanded              */,
      wear: 0,
      burnout: false,
      emission: 0 /* microamperes                  */,

      /* optics */
      cond: 0,
      focusUm: 0,
      magIndex: 0,
      stageX: 0,
      stageY: 0,
      wobbler: 0,

      /* chamber */
      screenView: true,
      plates: 0,
      exposing: 0,
      blankNote: 0,

      /* water & heat */
      waterDemand: true,
      waterFlow: 1,
      objTemp: 18,
      overheatTrip: false,
      lensWarped: 0 /* permanent focus offset, um    */,

      /* foil condition */
      contamination: 0,

      /* annunciation */
      alarms: {} /* key -> active                 */,
      acked: {} /* key -> accepted               */,

      note: "STANDING VACUUM HELD",
      noteT: 0,
    };
  }
  S = coldState();

  /* ---------------- physics ---------------- */

  function setAlarm(key, on) {
    if (on) {
      if (!S.alarms[key]) {
        S.alarms[key] = true;
        S.acked[key] = false;
      }
    } else {
      delete S.alarms[key];
      delete S.acked[key];
    }
  }

  function say(text) {
    S.note = text;
    S.noteT = S.t;
  }

  function tick(dt) {
    dt = clamp(Number(dt) || 0, 0, 0.5);
    S.t += dt;

    /* ----- cooling water ----- */
    var flowTarget = S.waterDemand ? 1 : 0.04;
    S.waterFlow = approach(S.waterFlow, flowTarget, 3, dt);
    setAlarm("water", S.waterFlow < 0.25);

    /* ----- vacuum plant ----- */
    var rotaryOn = S.mains && S.pumpPos > 0;
    var forePumping = rotaryOn; /* rotary vane runs for ROUGH/BACK/DIFF/AUTO */
    var diffHeating = S.mains && S.pumpPos >= 3 && S.pFore < FORE_MAX;
    var colSpeed = 0;
    if (S.pumpPos === 1 && S.mains)
      colSpeed = 1.25; /* roughing line wide open   */
    else if (S.pumpPos === 2 && S.mains)
      colSpeed = 0.03; /* column isolated, backing  */
    else if (diffHeating) colSpeed = 3.6; /* diffusion on the column   */
    else if (!S.mains) colSpeed = 0.004; /* sealed column creeps up   */

    var qAir = 0; /* inflow through seals, torr/s */
    if (S.leakIn > 0 && S.portOpen) qAir += S.leakIn;
    if (!rotaryOn) qAir += 0.00035; /* slow let-up through warm metal */

    var dP = (qAir - colSpeed * S.pCol) * dt;
    S.pCol = clamp(S.pCol + dP, 8e-7, P_AIR);

    var fTarget = forePumping ? 0.16 : P_AIR;
    var fSpeed = forePumping ? 2.4 : 0;
    var dq =
      ((fTarget === P_AIR ? 0.05 * (1 - S.pFore / P_AIR) : 0) -
        fSpeed * (S.pFore - 0.12)) *
      dt;
    S.pFore = clamp(S.pFore + dq, 0.11, P_AIR);

    /* ----- cold trap ----- */
    S.trapCharge = clamp(S.trapCharge - dt / 260, 0, 1);

    /* ----- gun high tension ----- */
    if (!S.mains || S.gunLocked || S.overheatTrip) S.hvKey = false;

    if (S.hvKey && S.mains && !S.gunLocked && !S.overheatTrip) {
      S.hvOn = true;
      S.kv = approach(S.kv, 50, 9, dt);
    } else {
      S.hvOn = false;
      S.kv = approach(S.kv, 0, 40, dt);
    }

    /* stability: ripple grows with pressure above 5e-5 torr */
    var excess = Math.max(0, S.pCol - 5e-5);
    var ripple = 0.35 + 340 * Math.sqrt(excess);
    if (S.hvOn && ripple > 2.4) S.unstableFor += dt;
    else S.unstableFor = Math.max(0, S.unstableFor - dt * 2);

    if (S.unstableFor >= DISCHARGE_HOLD && S.hvOn) {
      /* a discharge: kV collapses, gun locks out until the key is cycled */
      S.kv = 0;
      S.hvOn = false;
      S.hvKey = false;
      S.gunLocked = true;
      S.unstableFor = 0;
      S.gunLatched = true;
      setAlarm("gun", true);
      say("GUN DISCHARGE - CYCLE THE HV KEY");
    }

    /* ----- filament ----- */
    if (S.burnout) {
      S.emission = approach(S.emission, 0, 80, dt);
    } else {
      var knee = smooth({ lo: 1.55, hi: 2.45 }, S.filSet);
      var droop = 1 - smooth({ lo: 2.75, hi: 3.05 }, S.filSet) * 0.18;
      var target = 52 * knee * droop * (S.hvOn ? 1 : 0);
      S.emission = approach(S.emission, target, 26, dt);
      /* wear: gentle past the knee, savage above it */
      var wearRate = 1e-6 + smooth({ lo: 2.45, hi: 3.0 }, S.filSet) * 3.2e-3;
      if (S.emission > 1) S.wear += wearRate * dt;
      if (S.wear >= 1) {
        S.wear = 1;
        S.burnout = true;
        setAlarm("filament", true);
        say("FILAMENT OPEN - FIT A NEW HAIRPIN");
      }
    }
    setAlarm("filament", S.burnout);

    /* ----- lens temperature ----- */
    /* Full beam on a healthy jacket settles in the low forties; a lost
       jacket climbs without limit and trips at ninety-two. */
    var heat = (S.emission / 52) * (0.35 + 0.65 * S.cond) * 9;
    var cool = (S.objTemp - 18) * S.waterFlow * 0.42;
    S.objTemp +=
      (heat - cool - (S.objTemp - 18) * 0.008) * dt * (S.mains ? 1 : 0.15);
    S.objTemp = clamp(S.objTemp, 16, 140);

    if (S.objTemp >= 92 && !S.overheatTrip) {
      S.overheatTrip = true;
      S.lensWarped = 60 + hash(Math.floor(S.t)) * 50;
      S.hvOn = false;
      S.hvKey = false;
      setAlarm("overheat", true);
      say("OBJECTIVE OVERHEAT - GUN TRIPPED");
    }
    if (S.overheatTrip && S.objTemp < 46 && S.waterFlow > 0.9) {
      S.overheatTrip = false; /* trip latches only while hot */
    }
    setAlarm("overheat", S.overheatTrip);

    /* ----- true focus drifts as the lens warms ----- */
    var warpDrift = S.lensWarped > 0 ? S.lensWarped : 0;
    S.trueFocusErr = warpDrift + (S.objTemp - 20) * 0.9;

    /* ----- foil contamination ----- */
    var dose = (S.emission / 52) * (0.3 + 0.7 * S.cond);
    var trapFactor = 1 - 0.85 * smooth({ lo: 0.15, hi: 0.6 }, S.trapCharge);
    var vacFactor = 1 + 30 * Math.max(0, S.pCol - 5e-5);
    S.contamination = clamp(
      S.contamination + dose * 0.0011 * trapFactor * vacFactor * dt,
      0,
      1,
    );

    /* ----- exposure ----- */
    if (S.exposing > 0) {
      S.exposing -= dt;
      if (S.exposing <= 0) {
        S.exposing = 0;
        S.plates += 1;
        say("PLATE " + pad2(S.plates) + " EXPOSED");
      }
    }

    /* ----- vacuum alarms ----- */
    setAlarm("air", S.pCol > 5e-2);
    setAlarm("vacuum", S.pCol > ALARM_VAC && S.pCol <= 5e-2);

    /* ----- notes decay to running commentary ----- */
    if (S.t - S.noteT > 6) {
      S.noteT = S.t;
      if (!S.mains) say("STANDING VACUUM HELD");
      else if (S.pCol > 5e-2) say("COLUMN AT ATMOSPHERE");
      else if (S.pumpPos === 1 && S.pCol > 6e-3) say("ROUGHING");
      else if (diffHeating && S.pCol > 2e-5) say("DIFFUSION PUMPING");
      else if (S.screenView && beamReady())
        say("VIEWING x " + MAGS[S.magIndex]);
      else if (!S.screenView && beamReady()) say("SCREEN UP - BEAM ON FILM");
      else say("IDLE");
    }
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function beamReady() {
    return S.mains && S.hvOn && S.kv > 40 && S.emission > 2 && !S.burnout;
  }

  /* image sharpness error in arbitrary defocus units */
  function defocus() {
    var err = S.focusUm - (S.trueFocusErr || 0);
    if (S.wobbler !== 0) {
      err += S.wobbler * 34 * (Math.sin(S.t * 2 * Math.PI * 2.1) > 0 ? 1 : -1);
    }
    return err;
  }

  function intensity() {
    if (!beamReady()) return 0;
    var spot = smooth({ lo: 0.12, hi: 0.75 }, S.cond);
    return clamp(
      (S.emission / 52) * (0.22 + 0.78 * spot) * TRANSMISSION[S.magIndex],
      0,
      1.4,
    );
  }

  /* ---------------- public API ---------------- */

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),

    state: function () {
      return {
        timeSec: round(S.t),
        mains: S.mains,
        pumpPosition: ["off", "rough", "back", "diffusion", "auto"][S.pumpPos],
        cameraPortOpen: S.portOpen,
        columnPressureTorr: sci(S.pCol),
        foreLineMmHg: round(S.pFore, 2),
        coldTrapCharge: round(S.trapCharge, 3),
        gunHtOn: S.hvOn,
        gunKv: round(S.kv, 2),
        htRipplePercent: round(
          0.35 + 340 * Math.sqrt(Math.max(0, S.pCol - 5e-5)),
          3,
        ),
        filamentSetA: round(S.filSet, 2),
        filamentWear: round(S.wear, 4),
        filamentOpen: S.burnout,
        emissionUa: round(S.emission, 3),
        condenserFraction: round(S.cond, 3),
        objectiveFocusUm: round(S.focusUm, 1),
        magnification: MAGS[S.magIndex],
        stageXUm: round(S.stageX, 1),
        stageYUm: round(S.stageY, 1),
        wobbler: S.wobbler,
        screenViewing: S.screenView,
        platesExposed: S.plates,
        exposingNow: S.exposing > 0,
        waterFlowFraction: round(S.waterFlow, 3),
        objectiveTempC: round(S.objTemp, 2),
        contamination: round(S.contamination, 4),
        beamIntensity: round(intensity(), 4),
        defocusError: round(defocus(), 2),
        statusNote: S.note,
        alarms: Object.keys(S.alarms).map(function (k) {
          return ALARM_TEXT[k];
        }),
      };
    },

    tick: tick,

    inject: function (fault) {
      switch (fault) {
        case "camera port leak":
          S.leakIn = 0.004;
          say("TEST - CAMERA PORT LEAK");
          break;
        case "filament burnout":
          S.burnout = true;
          S.wear = 1;
          setAlarm("filament", true);
          say("TEST - FILAMENT OPEN");
          break;
        case "cooling water loss":
          S.waterDemand = false;
          say("TEST - COOLING WATER LOST");
          break;
        default:
          throw new Error("unknown fault: " + fault);
      }
    },

    reset: function () {
      S = coldState();
      syncAllControls();
    },
  };

  var ALARM_TEXT = {
    vacuum: "column vacuum high",
    gun: "gun discharge",
    filament: "filament open",
    water: "cooling water lost",
    overheat: "objective overheat",
    air: "column let up to air",
  };

  function round(v, dp) {
    var m = Math.pow(10, dp || 2);
    return Math.round(v * m) / m;
  }

  function sci(p) {
    /* keep pressures finite and readable: 3.4e-5 style strings are no use
       to arithmetic consumers, so give the number itself, clamped */
    var v = p < 8e-7 ? 8e-7 : p;
    return Number(v.toExponential(3));
  }

  /* ---------------- rendering ---------------- */

  var canvas = $("#phosphor");
  var ctx = canvas.getContext("2d");
  var spec = document.createElement("canvas");
  spec.width = 720;
  spec.height = 540;

  function paintSpecimen() {
    var g = spec.getContext("2d");
    g.fillStyle = "#101b14";
    g.fillRect(0, 0, 720, 540);

    /* bent graphite-like lattice patch */
    var cx = 250,
      cy = 210,
      n = 17,
      sp = 21;
    for (var row = 0; row < n; row++) {
      for (var col = 0; col < n; col++) {
        var wob = Math.sin(row * 0.55 + col * 0.28) * 3.4;
        var bend =
          Math.exp(-Math.pow(col - 8, 2) / 40) * Math.sin(row * 0.4) * 6;
        var x = cx + (col - n / 2) * sp + wob;
        var y = cy + (row - n / 2) * sp + bend;
        var r = 2.1 + hash(row * 31 + col) * 1.3;
        g.fillStyle =
          "rgba(190,255,205," + (0.5 + hash(row * 7 + col * 3) * 0.4) + ")";
        g.beginPath();
        g.arc(x, y, r, 0, 6.2832);
        g.fill();
      }
    }
    /* second small lattice, moire against the first */
    cx = 520;
    cy = 380;
    n = 11;
    sp = 24;
    for (row = 0; row < n; row++) {
      for (col = 0; col < n; col++) {
        x = cx + (col - n / 2) * sp * 0.98 + Math.sin(row) * 1.2;
        y = cy + (row - n / 2) * sp * 0.94;
        g.fillStyle =
          "rgba(160,235,185," + (0.35 + hash(col * 13 + row) * 0.35) + ")";
        g.beginPath();
        g.arc(x, y, 1.8, 0, 6.2832);
        g.fill();
      }
    }
    /* latex spheres */
    var spheres = [
      [120, 420, 34],
      [600, 130, 27],
      [430, 90, 19],
      [620, 300, 15],
      [330, 330, 12],
    ];
    spheres.forEach(function (s, i2) {
      var grad = g.createRadialGradient(
        s[0] - s[2] * 0.3,
        s[1] - s[2] * 0.3,
        s[2] * 0.15,
        s[0],
        s[1],
        s[2],
      );
      grad.addColorStop(0, "rgba(220,255,228,0.92)");
      grad.addColorStop(0.72, "rgba(150,215,170,0.55)");
      grad.addColorStop(1, "rgba(70,120,90,0.08)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(s[0], s[1], s[2], 0, 6.2832);
      g.fill();
      /* faint edge ring like real phase contrast */
      g.strokeStyle = "rgba(230,255,240," + (0.32 - i2 * 0.04) + ")";
      g.lineWidth = 1.4;
      g.stroke();
    });
    /* a hole in the foil */
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(480, 470, 38, 0, 6.2832);
    g.fill();
    g.globalCompositeOperation = "source-over";
  }
  paintSpecimen();

  function drawScreen(st) {
    var W = canvas.width,
      H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#07100a";
    ctx.fillRect(0, 0, W, H);

    var live = st.beamIntensity > 0.02 && st.screenViewing && st.mains;

    if (live) {
      var inten = Math.min(1.25, st.beamIntensity);
      var err = Math.abs(st.defocusError);
      var blur = clamp(err / 34, 0.4, 13);
      var bright = clamp(0.32 + inten * 1.15, 0, 1.6);
      var contrast = 1.18 * (1 - st.contamination * 0.5);
      var sc = 0.5 + 0.62 * Math.sqrt(st.magnification / 2000);
      var dw = 720 * sc,
        dh = 540 * sc;
      var dx = (W - dw) / 2 - st.stageXUm * 0.62 * sc;
      var dy = (H - dh) / 2 + st.stageYUm * 0.62 * sc;

      ctx.filter =
        "blur(" +
        blur.toFixed(1) +
        "px) brightness(" +
        bright.toFixed(2) +
        ") contrast(" +
        contrast.toFixed(2) +
        ") saturate(0.9)";
      ctx.drawImage(spec, dx, dy, dw, dh);
      ctx.filter = "none";

      /* contamination stain: brown veil where the beam has sat */
      if (st.contamination > 0.02) {
        ctx.fillStyle =
          "rgba(112,84,34," + (st.contamination * 0.4).toFixed(3) + ")";
        ctx.fillRect(0, 0, W, H);
      }

      /* phosphor grain, deterministic per eighth-second bucket */
      var bucket = Math.floor(st.timeSec * 8);
      var grains = 130;
      for (var i = 0; i < grains; i++) {
        var h1 = hash(bucket * 131 + i);
        var h2 = hash(bucket * 197 + i * 7 + 3);
        var h3 = hash(i * 29 + bucket);
        ctx.fillStyle =
          "rgba(200,255,215," + (0.03 + h3 * 0.1 * inten).toFixed(3) + ")";
        ctx.fillRect(h1 * W, h2 * H, 1.4, 1.4);
      }
    } else {
      /* dark screen: the willemite itself, faintly green under room light,
         with the etched centre marks every EM-3 screen carries */
      var glow = ctx.createRadialGradient(
        W / 2,
        H / 2,
        6,
        W / 2,
        H / 2,
        H * 0.62,
      );
      glow.addColorStop(0, "rgba(126,214,158,0.16)");
      glow.addColorStop(0.55, "rgba(96,178,128,0.07)");
      glow.addColorStop(1, "rgba(90,170,120,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(150,230,180,0.13)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 74, 0, 6.2832);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 34, 0, 6.2832);
      ctx.stroke();
      ctx.strokeStyle = "rgba(150,230,180,0.10)";
      ctx.beginPath();
      ctx.moveTo(W / 2 - 86, H / 2);
      ctx.lineTo(W / 2 + 86, H / 2);
      ctx.moveTo(W / 2, H / 2 - 86);
      ctx.lineTo(W / 2, H / 2 + 86);
      ctx.stroke();
    }

    /* exposure flash */
    if (st.exposingNow) {
      ctx.fillStyle = "rgba(240,255,245,0.14)";
      ctx.fillRect(0, 0, W, H);
    }

    /* vignette */
    var vig = ctx.createRadialGradient(
      W / 2,
      H / 2,
      H * 0.42,
      W / 2,
      H / 2,
      H * 0.86,
    );
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
  }

  /* meter needle helper: frac 0..1 across the -78..+78 degree sweep */
  function setNeedle(id, frac) {
    var el = $(id);
    if (el)
      el.setAttribute(
        "transform",
        "rotate(" +
          (-78 + 156 * clamp(frac, -0.02, 1.02)).toFixed(2) +
          " 60 70)",
      );
  }

  function buildTicks(id, count, majorEvery) {
    var host = $(id);
    if (!host) return;
    var out = [];
    for (var i = 0; i <= count; i++) {
      var a = ((-78 + (156 * i) / count) * Math.PI) / 180;
      var r1 = 47,
        r2 = i % majorEvery === 0 ? 38 : 42;
      out.push(
        '<line x1="' +
          (60 + r1 * Math.sin(a)).toFixed(1) +
          '" y1="' +
          (70 - r1 * Math.cos(a)).toFixed(1) +
          '" x2="' +
          (60 + r2 * Math.sin(a)).toFixed(1) +
          '" y2="' +
          (70 - r2 * Math.cos(a)).toFixed(1) +
          '" class="' +
          (i % majorEvery === 0 ? "major" : "") +
          '"/>',
      );
    }
    host.innerHTML = out.join("");
  }

  function renderAnnunciators() {
    $$(".ann").forEach(function (el) {
      var key = el.getAttribute("data-ann");
      var active = !!S.alarms[key];
      var acked = !!S.acked[key];
      el.classList.toggle("lit", active);
      el.classList.toggle("flashing", active && !acked);
      el.classList.toggle("accepted", active && acked);
    });
  }

  var lampsTestUntil = 0;

  function renderJewels() {
    $('[data-jewel="mains"]').classList.toggle("on", S.mains);
    var diff = S.mains && S.pumpPos >= 3 && S.pFore < FORE_MAX;
    $('[data-jewel="diffusion"]').classList.toggle("on", diff);
  }

  function renderColumn() {
    var root = $("#column");
    var hot = S.filSet > 1.4 && !S.burnout && S.mains;
    $(".col-gun").classList.toggle("hot", hot);
    $(".col-obj").classList.toggle("hot", S.objTemp > 58);
    $(".col-spec").classList.toggle("shifted", Math.abs(S.stageX) > 1);
    $(".col-spec").style.setProperty(
      "--sx",
      (S.stageX * 0.16).toFixed(1) + "px",
    );

    var inten = intensity();
    var spread = clamp(Math.abs(defocus()) / 260, 0, 1);
    $$(".beamseg").forEach(function (seg) {
      seg.style.setProperty("--beam-i", (inten * 0.75).toFixed(3));
      seg.style.setProperty("--beam-w", (spread * 4.5).toFixed(2) + "px");
    });
    root.setAttribute("aria-hidden", "true");
  }

  function renderReadouts(st) {
    setNeedle("#vacNeedle", (-1 - Math.log10(clamp(S.pCol, 1e-6, 1))) / 5);
    setNeedle("#foreNeedle", S.pFore / 760);
    setNeedle("#emNeedle", S.emission / 52);
    setNeedle("#hvNeedle", S.kv / 60);
    setNeedle("#waterNeedle", S.waterFlow);

    $("#filReadout").textContent = S.filSet.toFixed(2) + " A";
    var spots = [7, 6, 5, 4, 3, 2];
    $("#condReadout").textContent = "SPOT " + spots[Math.round(S.cond * 5)];
    var f = Math.round(S.focusUm);
    $("#focusReadout").textContent =
      (f >= 0 ? "+" : "-") + ("00" + Math.abs(f)).slice(-3) + " \u00B5m";
    $("#magReadout").textContent =
      MAGS[S.magIndex].toLocaleString("en-GB").replace(/,/g, " ") + "\u00D7";
    $("#stageReadout").textContent =
      "x" + sgn(S.stageX) + " y" + sgn(S.stageY) + " \u00B5m";
    $("#objTemp").innerHTML = Math.round(S.objTemp) + "&deg;C";
    $("#plateCount").textContent = pad2(S.plates);

    $("#trapLevel").style.width = (S.trapCharge * 100).toFixed(1) + "%";
    var life = $("#filLife");
    life.style.width = (S.wear * 100).toFixed(1) + "%";
    life.parentElement.classList.toggle("warn", S.wear > 0.6);

    /* stage dot inside the pad */
    var dot = $("#stageDot");
    var rr = 44;
    dot.style.transform =
      "translate(" +
      ((S.stageX / 100) * rr).toFixed(1) +
      "px," +
      ((S.stageY / 100) * rr).toFixed(1) +
      "px)";

    /* chamber note */
    var note;
    if (S.exposingNow) note = "EXPOSING PLATE " + pad2(S.plates + 1);
    else if (!S.mains) note = "CHAMBER \u2014 DARK";
    else if (beamReady() && S.screenView)
      note = "VIEWING \u00D7 " + MAGS[S.magIndex];
    else if (beamReady() && !S.screenView)
      note = "SCREEN UP \u2014 BEAM ON FILM";
    else note = S.note;
    $("#chamberNote").textContent = note;

    renderColumn();
    renderJewels();
    renderAnnunciators();
    drawScreen(st);
  }

  function sgn(v) {
    var n = Math.round(v);
    return (n >= 0 ? "+" : "-") + ("00" + Math.abs(n)).slice(-3);
  }

  /* ---------------- control wiring ---------------- */

  function bindHold(el, down, up) {
    el.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      down();
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      el.addEventListener(ev, up);
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        down();
      }
    });
    el.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        up();
      }
    });
  }

  function wireControls() {
    /* ---- mains breaker ---- */
    var bat = $("#mainsBat");
    bat.addEventListener("click", function () {
      S.mains = !S.mains;
      if (S.mains) say("SUPPLY ON - ROTARY OFF");
      else say("SUPPLY ISOLATED");
      syncMains();
    });

    /* ---- pump selector ---- */
    $$(".rot-stop").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pos = Number(btn.getAttribute("data-pos"));
        if (pos >= 3 && (S.pCol > P_DIFF_OK || S.pFore > FORE_MAX)) {
          say("DIFFUSION INTERLOCK - PUMP DOWN FIRST");
          syncRotary();
          return;
        }
        S.pumpPos = pos;
        var labels = [
          "OFF",
          "ROUGH LINE",
          "BACKING",
          "DIFFUSION ON",
          "AUTO SEQUENCE",
        ];
        say(labels[pos]);
        syncRotary();
      });
    });

    /* ---- camera port valve ---- */
    var port = $("#portValve");
    port.addEventListener("click", function () {
      S.portOpen = !S.portOpen;
      say(
        S.portOpen ? "PORT VALVE OPEN" : "PORT VALVE CLOSED - CAMERA ISOLATED",
      );
      syncPort();
    });

    /* ---- cold trap ---- */
    var trapBtn = $('[data-btn="trap"]');
    bindHold(
      trapBtn,
      function () {
        trapBtn.classList.add("pressed");
        S.__trapFill = true;
      },
      function () {
        trapBtn.classList.remove("pressed");
        S.__trapFill = false;
      },
    );

    /* ---- gun HV guard + key ---- */
    var guard = $("#hvGuard");
    var lid = $("#hvGuardLid");
    var key = $("#hvKey");
    lid.addEventListener("click", function () {
      var open = !guard.classList.contains("open");
      guard.classList.toggle("open", open);
      lid.setAttribute("aria-expanded", String(open));
      key.disabled = !open;
    });
    key.addEventListener("click", function () {
      if (key.disabled) return;
      if (S.gunLocked && !S.hvKey) {
        /* cycling the key clears a discharge lock-out */
        S.gunLocked = false;
        if (S.pCol < P_HV_OK) {
          S.gunLatched = false;
          setAlarm("gun", false);
        }
      }
      S.hvKey = !S.hvKey;
      say(S.hvKey ? "HIGH TENSION RUN" : "HIGH TENSION OFF");
      syncKey();
    });

    /* ---- sliders ---- */
    var fil = $("#filamentSlider");
    fil.addEventListener("input", function () {
      S.filSet = (Number(fil.value) / 100) * 3;
    });
    var cond = $("#condenserSlider");
    cond.addEventListener("input", function () {
      S.cond = Number(cond.value) / 100;
    });
    var foc = $("#focusKnob");
    foc.addEventListener("input", function () {
      S.focusUm = Number(foc.value);
    });
    $("#focusMinus").addEventListener("click", function () {
      foc.value = String(clamp(Number(foc.value) - 6, -500, 500));
      S.focusUm = Number(foc.value);
    });
    $("#focusPlus").addEventListener("click", function () {
      foc.value = String(clamp(Number(foc.value) + 6, -500, 500));
      S.focusUm = Number(foc.value);
    });

    /* ---- magnification ---- */
    $$(".mag-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var dir = Number(btn.getAttribute("data-dir"));
        S.magIndex = clamp(S.magIndex + dir, 0, MAGS.length - 1);
        say("x " + MAGS[S.magIndex]);
      });
    });

    /* ---- stage pad ---- */
    var pad = $("#stagePad");
    var dragging = false;
    function padMove(e) {
      var r = pad.getBoundingClientRect();
      var rr = (r.width / 2) * 0.82;
      var dx = e.clientX - (r.left + r.width / 2);
      var dy = e.clientY - (r.top + r.height / 2);
      S.stageX = clamp((dx / rr) * 100, -100, 100);
      S.stageY = clamp((dy / rr) * 100, -100, 100);
    }
    pad.addEventListener("pointerdown", function (e) {
      dragging = true;
      pad.setPointerCapture(e.pointerId);
      padMove(e);
    });
    pad.addEventListener("pointermove", function (e) {
      if (dragging) padMove(e);
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      pad.addEventListener(ev, function () {
        dragging = false;
      });
    });
    pad.addEventListener("keydown", function (e) {
      var step = 6;
      if (e.key === "ArrowLeft") {
        S.stageX = clamp(S.stageX - step, -100, 100);
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        S.stageX = clamp(S.stageX + step, -100, 100);
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        S.stageY = clamp(S.stageY - step, -100, 100);
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        S.stageY = clamp(S.stageY + step, -100, 100);
        e.preventDefault();
      }
    });

    /* ---- wobbler ---- */
    var wobWrap = $("#wobbler");
    $$(".wob").forEach(function (btn) {
      var dir = Number(btn.getAttribute("data-wob"));
      bindHold(
        btn,
        function () {
          btn.classList.add("pressed");
          S.wobbler = dir;
          wobWrap.style.setProperty("--tilt", dir * 4 + "deg");
        },
        function () {
          btn.classList.remove("pressed");
          S.wobbler = 0;
          wobWrap.style.setProperty("--tilt", "0deg");
        },
      );
    });

    /* ---- screen lever ---- */
    var lever = $("#screenLever");
    lever.addEventListener("click", function () {
      S.screenView = !S.screenView;
      say(S.screenView ? "GLASS DOWN - VIEWING" : "GLASS UP - CAMERA MODE");
      syncLever();
    });

    /* ---- expose plunger ---- */
    var exp = $('[data-btn="expose"]');
    exp.addEventListener("click", function () {
      if (S.screenView) {
        say("GLASS IS DOWN - LIFT TO CAMERA");
        return;
      }
      if (!beamReady()) {
        say("NO IMAGE TO EXPOSE");
        return;
      }
      S.exposing = 1.4;
    });

    /* ---- water restore ---- */
    $('[data-btn="water"]').addEventListener("click", function () {
      S.waterDemand = true;
      say("HYDRANT VALVE OPEN");
    });

    /* ---- new filament ---- */
    var sparesBox = $("#sparesBox");
    var spareLid = $("#sparesLid");
    var newFil = $('[data-btn="newfil"]');
    spareLid.addEventListener("click", function () {
      var open = !sparesBox.classList.contains("open");
      sparesBox.classList.toggle("open", open);
      spareLid.setAttribute("aria-expanded", String(open));
      newFil.disabled = !open;
    });
    newFil.addEventListener("click", function () {
      S.burnout = false;
      S.wear = 0;
      S.emission = 0;
      S.__testFilament = false;
      say("NEW HAIRPIN FITTED - RECONDITION SLOWLY");
      sparesBox.classList.remove("open");
      spareLid.setAttribute("aria-expanded", "false");
      newFil.disabled = true;
    });

    /* ---- fault test switches ---- */
    $$(".testsw").forEach(function (sw) {
      sw.addEventListener("click", function () {
        var f = sw.getAttribute("data-fault");
        var engaged = sw.getAttribute("aria-pressed") === "true";
        if (engaged) {
          clearFault(f);
          sw.setAttribute("aria-pressed", "false");
        } else {
          window.machine.inject(f);
          if (f === "filament burnout") S.__testFilament = true;
          sw.setAttribute("aria-pressed", "true");
        }
      });
    });

    /* ---- accept, lamps, reset, manual ---- */
    $('[data-btn="accept"]').addEventListener("click", function () {
      Object.keys(S.alarms).forEach(function (k) {
        S.acked[k] = true;
      });
    });
    $('[data-btn="lampstest"]').addEventListener("click", function () {
      lampsTestUntil = performance.now() + 2200;
    });
    $('[data-btn="reset"]').addEventListener("click", function () {
      window.machine.reset();
    });
    $('[data-action="manual"]').addEventListener("click", function () {
      var d = $("dialog[data-manual]");
      if (d && !d.open) d.showModal();
    });
    $('[data-action="close-manual"]').addEventListener("click", function () {
      var d = $("dialog[data-manual]");
      if (d && d.open) d.close();
    });
  }

  function clearFault(fault) {
    switch (fault) {
      case "camera port leak":
        S.leakIn = 0;
        break;
      case "cooling water loss":
        S.waterDemand = true;
        break;
      case "filament burnout":
        /* the test proves the lamp; fitting a new filament clears it */
        if (S.__testFilament) {
          S.burnout = false;
          S.wear = 0;
        }
        break;
    }
  }

  /* ---- reflect state onto controls after reset ---- */

  var ROT_ANGLES = [0, 39, 78, -78, -39]; /* OFF ROUGH BACK DIFF AUTO */

  function syncRotary() {
    $("#pumpRotary").style.setProperty("--rot", ROT_ANGLES[S.pumpPos] + "deg");
    $$(".rot-stop").forEach(function (b) {
      b.setAttribute(
        "aria-checked",
        String(Number(b.getAttribute("data-pos")) === S.pumpPos),
      );
    });
  }
  function syncPort() {
    var p = $("#portValve");
    p.style.setProperty("--turn", S.portOpen ? "90deg" : "4deg");
    p.setAttribute("aria-pressed", String(S.portOpen));
  }
  function syncKey() {
    $("#hvKey").classList.toggle("on", S.hvKey);
    $("#hvKey").setAttribute("aria-checked", String(S.hvKey));
  }
  function syncLever() {
    var l = $("#screenLever");
    l.style.setProperty("--swing", S.screenView ? "-24deg" : "24deg");
    l.setAttribute("aria-pressed", String(!S.screenView));
    var ems = l.querySelectorAll(".slever-quadrant em");
    ems[0].classList.toggle("active", S.screenView);
    ems[1].classList.toggle("active", !S.screenView);
  }
  function syncMains() {
    $("#mainsBat").setAttribute("aria-checked", String(S.mains));
  }
  function syncAllControls() {
    $("#filamentSlider").value = "0";
    $("#condenserSlider").value = "0";
    $("#focusKnob").value = "0";
    $$(".testsw").forEach(function (sw) {
      sw.setAttribute("aria-pressed", "false");
    });
    $("#sparesBox").classList.remove("open");
    $("#sparesLid").setAttribute("aria-expanded", "false");
    $('[data-btn="newfil"]').disabled = true;
    $("#hvGuard").classList.remove("open");
    $("#hvGuardLid").setAttribute("aria-expanded", "false");
    $("#hvKey").disabled = true;
    syncRotary();
    syncPort();
    syncKey();
    syncLever();
    syncMains();
  }

  /* ---------------- animation loop ---------------- */

  var lastTs = null;

  function frame(ts) {
    if (lastTs === null) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0 && dt < 2) tick(Math.min(dt, 0.1));

    /* trap fill is held from the button */
    if (S.__trapFill) S.trapCharge = clamp(S.trapCharge + 0.02, 0, 1);

    renderReadouts(window.machine.state());

    var testing = performance.now() < lampsTestUntil;
    $$(".ann").forEach(function (el) {
      el.classList.toggle("forced", testing);
    });
    $$(".jewel").forEach(function (j) {
      j.classList.toggle("on", testing ? true : j.classList.contains("on"));
    });

    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    lastTs = null;
  });

  /* ---------------- boot ---------------- */

  buildTicks("#vacTicks", 25, 5);
  buildTicks("#foreTicks", 20, 5);
  buildTicks("#emTicks", 20, 5);
  buildTicks("#hvTicks", 20, 5);
  buildTicks("#waterTicks", 20, 5);
  wireControls();
  syncAllControls();
  requestAnimationFrame(frame);
})();
