/* Wrayburn High-Vacuum Evaporating Bench Mk. III - behaviour.
   Deterministic vacuum simulation, panel wiring, rendering. */
(function () {
  "use strict";

  var NAME = "Wrayburn High-Vacuum Evaporating Bench Mk. III";
  var FAULTS = ["bell jar crack", "foreline valve passing", "filament burnout"];

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  var VC = 30; /* chamber volume, litres */
  var VF = 8; /* foreline volume, litres */
  var STEP = 0.05; /* fixed integration step, seconds */

  function coldState() {
    return {
      mains: false,
      waterCock: false,
      sel: "off",
      baffleCmd: false,
      baffle: 0,
      airAdmit: false,
      heatSet: 0,
      heatT: 25,
      bodyT: 21,
      heatTripped: false,
      filSet: 0,
      filT: 300,
      filOk: true,
      filWear: 0,
      shutter: false,
      pC: 1.2e-2,
      pF: 6.0e-2,
      thick: 0,
      thickLast: null,
      hazyLast: false,
      batchArmed: false,
      batchHazy: false,
      contam: 0,
      runSec: 0,
      faultJar: false,
      faultValve: false,
      alarmActive: {},
      alarmAccepted: {},
    };
  }

  var st = coldState();
  var carry = 0;
  var mcSample = null;

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function rateNmS(filK) {
    if (filK < 1500) return 0;
    var r = 4.96e8 * Math.exp(-49700 / filK);
    return r > 400 ? 400 : r;
  }

  function heaterEffect() {
    return clamp01((st.heatT - 130) / 150);
  }

  function stallFactor() {
    if (st.pF < 0.12) return 1;
    var s = 1 - (st.pF - 0.12) / 0.12;
    return s < 0 ? 0 : s;
  }

  function diffSpeed() {
    return (
      22 * st.baffle * heaterEffect() * stallFactor() * (1 - 0.4 * st.contam)
    );
  }

  function outgas() {
    var hFac = clamp01((st.heatT - 120) / 160);
    var fRad = clamp01((st.filT - 900) / 1900);
    return 1.1e-5 + 2.6e-5 * hFac + 1.4e-5 * fRad;
  }

  function setAlarm(key, active) {
    if (active) {
      if (!st.alarmActive[key]) {
        st.alarmActive[key] = true;
        st.alarmAccepted[key] = false;
      }
    } else {
      delete st.alarmActive[key];
      delete st.alarmAccepted[key];
    }
  }

  function step(h) {
    st.runSec += h;

    /* baffle travel */
    var bt = st.baffleCmd ? 1 : 0;
    if (st.baffle !== bt) {
      var d = bt - st.baffle;
      var move = h / 2.4;
      st.baffle += Math.abs(d) < move ? d : move * (d > 0 ? 1 : -1);
    }

    /* heater plate and pump body */
    var driveW = st.heatTripped ? 0 : st.heatSet;
    st.heatT += (30 + driveW * 0.58 - st.heatT) * (h / 9);
    var bodyTarget = st.heatT * (st.waterCock ? 0.16 : 0.38) + 16;
    var cool = st.waterCock ? 12 : 34;
    st.bodyT += (bodyTarget - st.bodyT) * (h / cool);
    if (!st.heatTripped && st.bodyT > 92) st.heatTripped = true;

    /* filament temperature */
    var filTarget = st.filOk ? 320 + 2780 * Math.pow(st.filSet / 30, 1.2) : 300;
    if (!isFinite(filTarget)) filTarget = 300;
    st.filT += (filTarget - st.filT) * (h / 2.5);

    var sd = diffSpeed();

    /* chamber pressure */
    var qIn = outgas();
    if (st.faultJar) qIn += 0.55;
    var dp = qIn - (sd / VC) * st.pC;
    if (st.sel === "roughing") {
      var rs = 1.8 * clamp01((st.pC - 2.5e-3) / 2.5e-2);
      dp -= (rs / VC) * st.pC;
    }
    if (st.airAdmit) dp -= (30 / VC) * (st.pC - 760);
    st.pC += dp * h;
    st.pC = st.pC < 1e-7 ? 1e-7 : st.pC > 820 ? 820 : st.pC;

    /* foreline pressure */
    var qPass = st.faultValve ? 0.06 : 0;
    var sfSpeed = st.sel === "off" ? 0 : 6;
    var dpF = sd * st.pC + qPass - sfSpeed * st.pF;
    st.pF += (dpF / VF) * h;
    st.pF = st.pF < 1e-4 ? 1e-4 : st.pF > 780 ? 780 : st.pF;

    /* oil contamination when the pump boils against a drowned foreline */
    if (st.heatT > 200 && st.pF > 0.15)
      st.contam = Math.min(1, st.contam + h * 0.05);

    /* deposition and filament life */
    var rate = rateNmS(st.filT);
    if (rate > 0.05) {
      if (st.pC > 1e-3) {
        st.filWear += h * (0.22 + st.pC * 26);
        if (st.shutter) st.batchHazy = true;
      } else {
        st.filWear += h * rate * 2e-5;
      }
    }
    if (st.filWear >= 1 && st.filOk) {
      st.filOk = false;
      st.filSet = 0;
    }
    var depositing = st.shutter && rate > 0.05;
    if (depositing) {
      var qf = st.pC < 1e-3 ? 1 : Math.max(0, 1 - (st.pC - 1e-3) / 9e-3);
      st.thick += rate * h * qf;
      st.batchArmed = true;
    }

    /* the batch card commits when the filament current is run down again */
    if (st.batchArmed && st.filSet < 6) {
      if (st.thick >= 5) {
        st.thickLast = st.thick;
        st.hazyLast = st.batchHazy;
      }
      st.batchArmed = false;
      st.batchHazy = false;
      st.thick = 0;
    }

    /* alarms */
    setAlarm("leak", st.faultJar && st.pC > 0.25 && !st.airAdmit);
    setAlarm("backing", st.pF > 0.22);
    setAlarm("water", !st.waterCock && st.heatT > 115);
    setAlarm("overheat", st.bodyT > 88 || st.heatTripped);
    setAlarm("filament", !st.filOk);

    if (st.heatTripped && st.bodyT < 46) st.heatTripped = false;
  }

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return;
    var budget = carry + seconds;
    var n = Math.floor(budget / STEP);
    carry = budget - n * STEP;
    if (n > 40000) n = 40000;
    for (var i = 0; i < n; i++) step(STEP);
  }

  function alarmList() {
    var names = [];
    for (var k in st.alarmActive) {
      if (Object.prototype.hasOwnProperty.call(st.alarmActive, k))
        names.push(k);
    }
    return names;
  }

  function state() {
    var detail = {};
    ["leak", "backing", "water", "overheat", "filament"].forEach(function (k) {
      detail[k] = {
        active: !!st.alarmActive[k],
        accepted: !!st.alarmAccepted[k],
      };
    });
    return {
      running: st.mains,
      selector: st.sel,
      waterFlowing: st.waterCock,
      baffleTravel: st.baffle,
      baffleCommanded: st.baffleCmd,
      airAdmitted: st.airAdmit,
      heaterSetWatts: st.heatTripped ? 0 : st.heatSet,
      heaterTripped: st.heatTripped,
      heaterPlateC: st.heatT,
      pumpBodyC: st.bodyT,
      filamentSetAmps: st.filSet,
      filamentTempK: st.filT,
      filamentOk: st.filOk,
      filamentWear: st.filWear,
      shutterOpen: st.shutter,
      depositionRateNmPerS: rateNmS(st.filT),
      filmThicknessNm: st.thick,
      lastFilmThicknessNm: st.thickLast,
      lastFilmHazy: st.hazyLast,
      pumpOilContaminated: st.contam,
      chamberPressureMmHg: st.pC,
      forelinePressureMmHg: st.pF,
      mcleodReadingMmHg: mcSample,
      runHours: st.runSec / 3600,
      faultJarPresent: st.faultJar,
      faultValvePresent: st.faultValve,
      alarmNames: {
        leak: "VACUUM LEAK",
        backing: "BACKING PRESSURE HIGH",
        water: "COOLING WATER LOSS",
        overheat: "PUMP OVERHEAT",
        filament: "FILAMENT BURNT OUT",
      },
      alarms: alarmList(),
      alarmDetail: detail,
    };
  }

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === "bell jar crack") st.faultJar = true;
    else if (f === "foreline valve passing") st.faultValve = true;
    else if (f === "filament burnout") {
      st.filWear = 1;
      st.filOk = false;
    }
    syncInjectBoxes();
  }

  function clearFault(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === "bell jar crack") st.faultJar = false;
    else if (f === "foreline valve passing") st.faultValve = false;
    syncInjectBoxes();
  }

  function repair(action) {
    if (action === "jar-replaced") st.faultJar = false;
    else if (action === "valve-reseated") st.faultValve = false;
    else if (action === "filament-replaced") {
      st.filOk = true;
      st.filWear = 0;
    } else if (action === "oil-changed") st.contam = 0;
    syncInjectBoxes();
  }

  function reset() {
    st = coldState();
    carry = 0;
    mcSample = null;
    syncInjectBoxes();
  }

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
    panel: {
      setHeater: function (w) {
        st.heatSet = Math.max(0, Math.min(450, Number(w) || 0));
        if (st.heatSet > 0) st.heatTripped = false;
      },
      setFilament: function (a) {
        if (st.filOk) st.filSet = Math.max(0, Math.min(30, Number(a) || 0));
      },
      select: function (pos) {
        if (pos === "off" || pos === "roughing" || pos === "backing")
          st.sel = pos;
      },
      setBaffle: function (open) {
        st.baffleCmd = !!open;
      },
      setAirAdmit: function (open) {
        st.airAdmit = !!open;
      },
      setShutter: function (open) {
        st.shutter = !!open;
      },
      setWater: function (open) {
        st.waterCock = !!open;
      },
      setMains: function (on) {
        st.mains = !!on;
      },
      accept: function () {
        for (var k in st.alarmActive) st.alarmAccepted[k] = true;
      },
      repair: repair,
    },
  };

  /* ------------------------------------------------------------------ */
  /* Panel wiring                                                        */
  /* ------------------------------------------------------------------ */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  var el = {
    guardHandle: $("[data-guard-handle]"),
    mainsBtn: $('[data-control="MAINS SWITCH"]'),
    mainsPilot: $("[data-pilot-mains]"),
    waterBtn: $('[data-control="COOLING WATER COCK"]'),
    waterGlass: $("[data-water-glass]"),
    coil: $("[data-coil]"),
    flywheel: $("[data-flywheel]"),
    spokes: $(".spokes"),
    selPos: $all(".selector-pos"),
    selPointer: $("[data-selector-pointer]"),
    hours: $("[data-hours]"),
    substrate: $("[data-substrate]"),
    shutterBlade: $("[data-shutter-blade]"),
    filGlow: $("[data-filament-glow]"),
    filWire: $("[data-filament-wire]"),
    vapor: $("[data-vapor]"),
    jet: $("[data-jet]"),
    heaterWin: $("[data-heater-window]"),
    heaterWinI: $("[data-heater-window] i"),
    baffleBtn: $('[data-control="BAFFLE VALVE"]'),
    airBtn: $('[data-control="AIR ADMIT VALVE"]'),
    shutBtn: $('[data-control="SHUTTER LEVER"]'),
    needleC: $("[data-needle-chamber]"),
    needleF: $("[data-needle-fore]"),
    needleO: $("[data-needle-optical]"),
    ticksLog: $("[data-ticks-log]"),
    decadeLabels: $("[data-decade-labels]"),
    ticksFore: $("[data-ticks-fore]"),
    merc: $("[data-mercury]"),
    meniscus: $("[data-meniscus]"),
    mcleodRead: $("[data-mcleod-read]"),
    tiltBtn: $('[data-control="MCLEOD TILT LEVER"]'),
    heaterRange: $("[data-heater-range]"),
    heaterPointer: $("[data-heater-pointer]"),
    heaterRead: $("[data-heater-read]"),
    filRange: $("[data-filament-range]"),
    filPointer: $("[data-filament-pointer]"),
    filRead: $("[data-filament-read]"),
    monitorJewel: $("[data-monitor-jewel]"),
    thickNow: $("[data-thick-now]"),
    thickLast: $("[data-thick-last]"),
    filmQuality: $("[data-film-quality]"),
    contamNote: $("[data-contamination-note]"),
    injectBoxes: $all("[data-inject]"),
    acceptBtn: $('[data-control="ALARM ACCEPT"]'),
    lampsBtn: $('[data-control="INDICATOR LAMPS TEST"]'),
    masterReset: $('[data-control="MASTER RESET"]'),
    dialog: $("dialog[data-manual]"),
    flags: {},
  };

  $all(".flag").forEach(function (f) {
    el.flags[f.getAttribute("data-flag")] = f;
  });

  /* ---- dial scales drawn in code ---- */

  var NS = "http://www.w3.org/2000/svg";
  var SUP = {
    0: "\u2070",
    1: "\xb9",
    2: "\xb2",
    3: "\xb3",
    4: "\u2074",
    5: "\u2075",
    6: "\u2076",
    7: "\u2077",
    8: "\u2078",
    9: "\u2079",
    "-": "\u207b",
  };

  function supNumber(d) {
    return String(d)
      .split("")
      .map(function (c) {
        return SUP[c] || c;
      })
      .join("");
  }

  function polar(cx, cy, r, deg) {
    var a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }

  function svgLine(x1, y1, x2, y2, cls) {
    var n = document.createElementNS(NS, "line");
    n.setAttribute("x1", x1.toFixed(2));
    n.setAttribute("y1", y1.toFixed(2));
    n.setAttribute("x2", x2.toFixed(2));
    n.setAttribute("y2", y2.toFixed(2));
    n.setAttribute("class", cls);
    return n;
  }

  function svgText(x, y, cls, text) {
    var n = document.createElementNS(NS, "text");
    n.setAttribute("x", x.toFixed(2));
    n.setAttribute("y", y.toFixed(2));
    n.setAttribute("class", cls);
    n.textContent = text;
    return n;
  }

  (function buildLogDial() {
    if (!el.ticksLog) return;
    var CX = 110;
    var CY = 118;
    var SWEEP = 250;
    for (var d = 3; d >= -6; d--) {
      for (var m = 1; m < 10; m++) {
        var v = Math.log10(m) + d;
        var frac = (3 - v) / 9;
        var deg = -SWEEP / 2 + frac * SWEEP;
        var major = m === 1;
        var p1 = polar(CX, CY, major ? 78 : 84, deg);
        var p2 = polar(CX, CY, 90, deg);
        el.ticksLog.appendChild(
          svgLine(
            p1[0],
            p1[1],
            p2[0],
            p2[1],
            major ? "tick-major" : "tick-minor",
          ),
        );
        if (major) {
          var lp = polar(CX, CY, 66, deg);
          el.decadeLabels.appendChild(
            svgText(lp[0], lp[1] + 4, "tick-num", d === 3 ? "ATM" : "1e" + d),
          );
        }
      }
    }
  })();

  (function buildForeDial() {
    if (!el.ticksFore) return;
    var CX = 60;
    var CY = 72;
    for (var i = 0; i <= 10; i++) {
      var deg = -80 + (i / 10) * 160;
      var major = i % 2 === 0;
      var p1 = polar(CX, CY, major ? 32 : 37, deg);
      var p2 = polar(CX, CY, 41, deg);
      el.ticksFore.appendChild(
        svgLine(
          p1[0],
          p1[1],
          p2[0],
          p2[1],
          major ? "tick-major" : "tick-minor",
        ),
      );
      if (i % 5 === 0) {
        var lp = polar(CX, CY, 23, deg);
        el.ticksFore.appendChild(
          svgText(lp[0], lp[1] + 3, "tick-num sm", String(i / 5)),
        );
      }
    }
  })();

  /* ---- helpers ---- */

  function fmtExp(p) {
    if (!(p > 0)) return "\u2014\u2014";
    var e = Math.floor(Math.log10(p));
    var mant = p / Math.pow(10, e);
    if (mant >= 9.95) {
      mant = 1;
      e += 1;
    }
    return mant.toFixed(1) + "e" + e;
  }

  /* ---- guarded mains ---- */

  el.guardHandle.addEventListener("click", function () {
    var open = el.guardHandle.getAttribute("aria-expanded") !== "true";
    el.guardHandle.setAttribute("aria-expanded", String(open));
    el.mainsBtn.disabled = !open;
    if (!open && window.machine.state().running) {
      window.machine.panel.setMains(false);
      el.mainsBtn.setAttribute("aria-label", "Mains switch, off");
    }
    el.guardHandle.textContent = open ? "SHUT" : "GUARD";
  });
  el.guardHandle.textContent = "GUARD";

  el.mainsBtn.addEventListener("click", function () {
    var on = !window.machine.state().running;
    window.machine.panel.setMains(on);
    el.mainsBtn.setAttribute(
      "aria-label",
      "Mains switch, " + (on ? "on" : "off"),
    );
  });

  /* ---- water ---- */

  el.waterBtn.addEventListener("click", function () {
    var open = !window.machine.state().waterFlowing;
    window.machine.panel.setWater(open);
    el.waterBtn.setAttribute(
      "aria-label",
      "Cooling water cock, " + (open ? "open" : "closed"),
    );
  });

  /* ---- selector ---- */

  function applySelection(pos) {
    window.machine.panel.select(pos);
    el.selPos.forEach(function (b) {
      b.setAttribute(
        "aria-checked",
        String(b.getAttribute("data-value") === pos),
      );
    });
    el.selPointer.style.transform =
      "rotate(" +
      (pos === "roughing" ? 0 : pos === "backing" ? 52 : -52) +
      "deg)";
  }
  el.selPos.forEach(function (b) {
    b.addEventListener("click", function () {
      applySelection(b.getAttribute("data-value"));
    });
  });

  /* ---- baffle, air admit, shutter ---- */

  el.baffleBtn.addEventListener("click", function () {
    var open = !window.machine.state().baffleCommanded;
    window.machine.panel.setBaffle(open);
    el.baffleBtn.setAttribute(
      "aria-label",
      "Baffle valve, " + (open ? "open" : "closed"),
    );
  });

  el.airBtn.addEventListener("click", function () {
    var open = !window.machine.state().airAdmitted;
    window.machine.panel.setAirAdmit(open);
    el.airBtn.setAttribute(
      "aria-label",
      "Air admit valve, " + (open ? "open" : "closed"),
    );
  });

  el.shutBtn.addEventListener("click", function () {
    var open = !window.machine.state().shutterOpen;
    window.machine.panel.setShutter(open);
    el.shutBtn.setAttribute(
      "aria-label",
      "Shutter lever, " + (open ? "open" : "closed"),
    );
  });

  /* ---- knobs ---- */

  function bindRange(input, pointer, read, apply, fmt) {
    function refresh() {
      var v = Number(input.value);
      var frac =
        (v - Number(input.min)) / (Number(input.max) - Number(input.min));
      pointer.style.transform = "rotate(" + (-135 + frac * 270) + "deg)";
      read.textContent = fmt(v);
      apply(v);
    }
    input.addEventListener("input", refresh);
    refresh();
  }

  bindRange(
    el.heaterRange,
    el.heaterPointer,
    el.heaterRead,
    function (v) {
      window.machine.panel.setHeater(v);
    },
    function (v) {
      return v === 0 ? "OFF" : v + " W";
    },
  );

  bindRange(
    el.filRange,
    el.filPointer,
    el.filRead,
    function (v) {
      window.machine.panel.setFilament(v);
    },
    function (v) {
      return v.toFixed(1) + " A";
    },
  );

  /* ---- McLeod tilt ---- */

  var tiltTimer = null;
  function beginTilt() {
    if (el.tiltBtn.getAttribute("aria-pressed") === "true") return;
    el.tiltBtn.setAttribute("aria-pressed", "true");
    mcSample = window.machine.state().chamberPressureMmHg * 1.03;
    clearTimeout(tiltTimer);
    tiltTimer = setTimeout(endTilt, 6000);
  }
  function endTilt() {
    if (el.tiltBtn.getAttribute("aria-pressed") !== "true") return;
    el.tiltBtn.setAttribute("aria-pressed", "false");
    clearTimeout(tiltTimer);
  }
  el.tiltBtn.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    beginTilt();
  });
  el.tiltBtn.addEventListener("pointerup", endTilt);
  el.tiltBtn.addEventListener("pointerleave", endTilt);
  el.tiltBtn.addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      beginTilt();
    }
  });
  el.tiltBtn.addEventListener("keyup", function (e) {
    if (e.key === " " || e.key === "Enter") endTilt();
  });

  /* ---- annunciator strip ---- */

  el.acceptBtn.addEventListener("click", function () {
    window.machine.panel.accept();
  });

  var lampsTimer = null;
  el.lampsBtn.addEventListener("click", function () {
    $all(".flag").forEach(function (f) {
      f.classList.add("lampshow");
    });
    el.monitorJewel.classList.add("lit");
    el.mainsPilot.classList.add("lit");
    clearTimeout(lampsTimer);
    lampsTimer = setTimeout(function () {
      $all(".flag").forEach(function (f) {
        f.classList.remove("lampshow");
      });
      el.monitorJewel.classList.remove("lit");
      el.mainsPilot.classList.remove("lit");
    }, 1500);
  });

  /* ---- maintenance tray ---- */

  function syncInjectBoxes() {
    var s = window.machine.state();
    el.injectBoxes.forEach(function (box) {
      var name = box.getAttribute("data-inject");
      if (name === "bell jar crack") box.checked = s.faultJarPresent;
      else if (name === "foreline valve passing")
        box.checked = s.faultValvePresent;
      else if (name === "filament burnout") box.checked = !s.filamentOk;
    });
  }

  el.injectBoxes.forEach(function (box) {
    box.addEventListener("change", function () {
      var name = box.getAttribute("data-inject");
      if (box.checked) window.machine.inject(name);
      else window.machine.clearFault(name);
    });
  });

  $all("[data-repair]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      window.machine.panel.repair(btn.getAttribute("data-repair"));
    });
  });

  el.masterReset.addEventListener("click", function () {
    window.machine.reset();
    el.heaterRange.value = "0";
    el.filRange.value = "0";
    el.heaterRange.dispatchEvent(new Event("input"));
    el.filRange.dispatchEvent(new Event("input"));
    applySelection("off");
    el.waterBtn.setAttribute("aria-label", "Cooling water cock, closed");
    el.baffleBtn.setAttribute("aria-label", "Baffle valve, closed");
    el.airBtn.setAttribute("aria-label", "Air admit valve, closed");
    el.shutBtn.setAttribute("aria-label", "Shutter lever, closed");
    el.mainsBtn.setAttribute("aria-label", "Mains switch, off");
    endTilt();
  });

  /* ---- manual dialog ---- */

  $all('[data-action="manual"]').forEach(function (b) {
    b.addEventListener("click", function () {
      if (el.dialog && !el.dialog.open) el.dialog.showModal();
    });
  });
  $all('[data-action="close-manual"]').forEach(function (b) {
    b.addEventListener("click", function () {
      if (el.dialog && el.dialog.open) el.dialog.close();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function logAngle(p) {
    if (!(p > 0)) return -125;
    var frac = (3 - Math.log10(p)) / 9;
    return -125 + clamp01(frac) * 250;
  }

  function render() {
    var s = window.machine.state();

    el.needleC.style.transform =
      "rotate(" + logAngle(s.chamberPressureMmHg) + "deg)";
    var fFrac = clamp01(s.forelinePressureMmHg);
    el.needleF.style.transform = "rotate(" + (-80 + fFrac * 160) + "deg)";
    var oFrac = (s.filmThicknessNm % 300) / 300;
    el.needleO.style.transform = "rotate(" + (-70 + oFrac * 140) + "deg)";

    /* supplies */
    el.mainsPilot.classList.toggle("lit", s.running);
    var pumping = s.running && s.selector !== "off";
    el.flywheel.classList.toggle("spin", pumping);
    el.spokes.style.animationName = pumping ? "spin" : "none";
    el.waterGlass.classList.toggle("flowing", s.waterFlowing);
    el.coil.classList.toggle("flowing", s.waterFlowing && s.heaterPlateC > 60);

    /* stand */
    el.shutterBlade.classList.toggle("open", s.shutterOpen);
    var glow = Math.max(0, (s.filamentTempK - 1000) / 2100);
    el.filGlow.style.opacity = (glow * glow).toFixed(3);
    el.filWire.className =
      s.filamentTempK > 1800
        ? "wire hot"
        : s.filamentTempK > 1300
          ? "wire dull"
          : "wire";
    el.vapor.style.opacity = Math.min(1, s.depositionRateNmPerS / 9).toFixed(3);
    el.jet.classList.toggle("hot", s.heaterPlateC > 165);
    el.heaterWin.classList.toggle("glow", s.heaterPlateC > 150);
    el.heaterWinI.style.opacity = clamp01((s.heaterPlateC - 60) / 220).toFixed(
      2,
    );
    if (s.lastFilmThicknessNm !== null && s.lastFilmThicknessNm >= 5) {
      el.substrate.classList.add("coated");
    }

    /* McLeod glass */
    var tilted = el.tiltBtn.getAttribute("aria-pressed") === "true";
    var mh = tilted ? 82 : 18;
    el.merc.style.height = mh + "%";
    el.meniscus.style.bottom = mh + "%";
    el.mcleodRead.textContent =
      tilted && s.mcleodReadingMmHg !== null
        ? fmtExp(s.mcleodReadingMmHg)
        : "\u2014\u2014";

    /* readouts */
    el.hours.textContent = s.runHours.toFixed(2).padStart(6, "0");
    el.thickNow.textContent = s.filmThicknessNm.toFixed(1).padStart(5, "0");
    el.thickLast.textContent =
      s.lastFilmThicknessNm === null
        ? "\u2014"
        : s.lastFilmThicknessNm.toFixed(0) + " nm";
    el.filmQuality.textContent =
      s.lastFilmThicknessNm === null
        ? "NO BATCH"
        : s.lastFilmThicknessNm < 5
          ? "NO BATCH"
          : s.lastFilmHazy
            ? "HAZY"
            : "CLEAR";
    el.contamNote.hidden = !(s.pumpOilContaminated > 0.04);
    el.monitorJewel.classList.toggle(
      "lit",
      s.shutterOpen && s.depositionRateNmPerS > 0.05,
    );

    /* flags */
    var detail = s.alarmDetail;
    Object.keys(el.flags).forEach(function (k) {
      var d = detail[k];
      var f = el.flags[k];
      f.classList.toggle("active", !!(d && d.active));
      f.classList.toggle("accepted", !!(d && d.active && d.accepted));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Loop                                                                */
  /* ------------------------------------------------------------------ */

  var last = performance.now();
  var hidden = document.hidden;

  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    last = performance.now();
  });

  function frame(now) {
    if (!hidden) {
      var dt = (now - last) / 1000;
      if (dt > 0.25) dt = 0.25;
      if (dt > 0) tick(dt);
    }
    last = now;
    render();
    requestAnimationFrame(frame);
  }

  applySelection("off");
  syncInjectBoxes();
  render();
  requestAnimationFrame(frame);
})();
