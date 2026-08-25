/* ============================================================
   MARLPIT GAS WORKS — RETORT HOUSE STOKING BENCH No. 4
   Simulation and panel behaviour, 1926.
   Five coal retorts over producer-gas firing; gas through the
   water-sealed hydraulic main, the exhauster, to the holder.
   */
(function () {
  "use strict";

  /* ---------------- constants ---------------- */

  var RETORTS = 5;
  var AMBIENT = 60;
  var HEAT_C = 532000; /* full-fire heat input */
  var LOSS_K = 180; /* envelope loss per degF */
  var THERMAL_M = 26000; /* bench thermal mass */
  var DOOR_LOSS = 30000; /* per open door */
  var OVERHEAT_AT = 2050;
  var SCORCH_AT = 2250;

  var ALARM_DEFS = [
    "SAFETY LIFTS",
    "MAIN SUCTION",
    "OVERHEAT",
    "GAS ESCAPE",
    "LOW GAS MAKE",
    "HOLDER FULL",
    "HOLDER LOW",
    "EXHAUSTER TRIP",
    "FLAME FAILURE",
  ];

  var FAULT_LIST = [
    "water seal blown",
    "flue clinker fouling",
    "exhauster overload trip",
  ];

  /* ---------------- simulation state ---------------- */

  var S;

  function coldState() {
    return {
      t: 0,
      clockMin: 360 /* 06:00 */,
      temp: AMBIENT,
      mainP: 0.15,
      holder: 48,
      seal: 6.5,
      rpm: 0,
      governor: 0,
      damper: 0,
      valve: 0,
      tbOn: false,
      sel: 0,
      doors: [false, false, false, false, false],
      retorts: [
        { coal: 0, c: 0 },
        { coal: 0, c: 0 },
        { coal: 0, c: 0 },
        { coal: 0, c: 0 },
        { coal: 0, c: 0 },
      ],
      rakePos: 0,
      rakeArmed: false,
      clinker: 0,
      cockHeld: false,
      lampsTest: false,
      accepted: {},
      alarms: {},
      faultSeal: false,
      faultClinker: false,
      faultExTrip: false,
      exRunning: true,
      exTripLatched: false,
      backfire: false,
      scorch: false,
      scorchTimer: 0,
      lidsLift: false,
    };
  }

  S = coldState();
  ALARM_DEFS.forEach(function (n) {
    S.alarms[n] = false;
  });

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function setAlarm(name, on) {
    if (on && !S.alarms[name]) S.accepted[name] = false;
    S.alarms[name] = !!on;
  }

  function burnLevel() {
    if (S.backfire || S.valve <= 0) return 0;
    return (S.valve / 8) * clamp(0.35 + 0.065 * S.damper, 0.2, 1);
  }

  function effFactor() {
    return 1 - 0.55 * S.clinker - (S.scorch ? 0.3 : 0);
  }

  function gasMake() {
    var total = 0;
    var sealFactor = S.seal < 1.5 ? 0.22 : S.seal < 4 ? 0.62 : 1;
    for (var i = 0; i < RETORTS; i++) {
      var r = S.retorts[i];
      if (!r.coal) continue;
      var bell = Math.exp(-Math.pow((r.c - 55) / 28, 2));
      total += 2.6 * bell * (r.c >= 100 ? 0.12 : 1) + (r.c < 100 ? 0.62 : 0);
    }
    return total * sealFactor;
  }

  function openDoorCount() {
    var n = 0;
    for (var i = 0; i < RETORTS; i++) if (S.doors[i]) n++;
    return n;
  }

  /* ---------------- one fixed sub-step ---------------- */

  function step(dt) {
    S.t += dt;
    S.clockMin = (S.clockMin + dt) % 1440;

    /* --- firing and bench temperature --- */
    var burn = burnLevel();
    var doors = openDoorCount();
    var heat = burn * HEAT_C * (S.scorch ? 0.82 : 1);
    var loss = LOSS_K * (S.temp - AMBIENT) + doors * DOOR_LOSS;
    S.temp += ((heat - loss) / THERMAL_M) * dt;
    S.temp = clamp(S.temp, AMBIENT, 2600);

    /* --- carbonisation and gas make --- */
    var effTemp = S.temp * (1 - 0.5 * S.clinker);
    var tf = clamp((effTemp - 1050) / 850, 0, 1.3);
    var charged = 0;
    for (var i = 0; i < RETORTS; i++) {
      var r = S.retorts[i];
      if (r.coal && r.c < 100) {
        r.c = clamp(r.c + tf * 0.09 * dt, 0, 100);
      }
      if (r.coal) charged++;
    }
    var make = gasMake();

    /* --- water seal --- */
    var dSeal = -0.0035 - make * 0.0006;
    if (S.faultSeal) dSeal -= 0.5;
    if (S.cockHeld) dSeal += 0.9;
    S.seal = clamp(S.seal + dSeal * dt, 0, 7.5);

    /* --- exhauster --- */
    var target = 0;
    if (S.exRunning && !S.exTripLatched) target = S.governor * 28;
    S.rpm += (target - S.rpm) * clamp(dt / 2.5, 0, 1);
    if (S.rpm < 0.5) S.rpm = 0;

    /* --- hydraulic main pressure --- */
    var draw = (S.rpm / 240) * (S.holder >= 96 ? 0.35 : 1);
    var vent = 0;
    if (S.mainP > 2.55) S.lidsLift = true;
    if (S.lidsLift && S.mainP < 2.3) S.lidsLift = false;
    if (S.lidsLift) vent = (S.mainP - 2.4) * 30 + 0.5;
    var dP = (make * 0.055 - S.rpm * 0.0021 - Math.max(vent, 0)) / 14;
    S.mainP = clamp(S.mainP + dP * dt, -1.4, 4);

    /* --- backfire: suction with a door open --- */
    if (!S.backfire && S.mainP < -0.45 && doors > 0 && S.t > 20) {
      S.backfire = true;
    }

    /* --- gasholder --- */
    var inflow =
      (S.rpm / 240) *
      1 *
      (S.mainP > 0.25 ? 1 : 0.15) *
      (S.holder >= 96 ? 0.3 : 1) *
      (S.seal < 1.5 ? 0.3 : 1);
    var take = 0.28;
    S.holder = clamp(S.holder + (inflow - take) * dt, 0, 100);

    /* --- overheat and scorching --- */
    if (S.temp > SCORCH_AT) {
      S.scorchTimer += dt;
      if (S.scorchTimer > 20 && !S.scorch) S.scorch = true;
    } else {
      S.scorchTimer = Math.max(0, S.scorchTimer - dt * 2);
    }

    /* --- clinker growth --- */
    if (S.faultClinker) S.clinker = clamp(S.clinker + 0.04 * dt, 0, 1);

    /* --- alarms --- */
    setAlarm("SAFETY LIFTS", S.lidsLift);
    setAlarm("MAIN SUCTION", S.mainP < -0.25);
    setAlarm("OVERHEAT", S.temp > OVERHEAT_AT || S.scorch);
    setAlarm("GAS ESCAPE", S.seal < 3.8);
    setAlarm(
      "LOW GAS MAKE",
      (S.valve >= 2 && make < 2 && !S.backfire) || S.clinker > 0.55,
    );
    setAlarm("HOLDER FULL", S.holder >= 96);
    setAlarm("HOLDER LOW", S.holder <= 8);
    setAlarm("EXHAUSTER TRIP", S.exTripLatched || !S.exRunning);
    setAlarm("FLAME FAILURE", S.backfire);
  }

  /* ---------------- public API ---------------- */

  var api = {
    name: "Marlpit Gas Works Retort House Stoking Bench No. 4",
    faults: FAULT_LIST.slice(),

    state: function () {
      var alarms = [];
      ALARM_DEFS.forEach(function (n) {
        if (S.alarms[n]) alarms.push(n);
      });
      var faults = [];
      if (S.faultSeal) faults.push("water seal blown");
      if (S.faultClinker) faults.push("flue clinker fouling");
      if (S.faultExTrip || S.exTripLatched)
        faults.push("exhauster overload trip");
      return {
        alarms: alarms,
        faultsActive: faults,
        timeSec: S.t,
        clock: formatClock(),
        tempF: Math.round(S.temp),
        flueTemperatureF: Math.round(S.temp),
        mainPressureWG: Math.round(S.mainP * 100) / 100,
        hydraulicMainInchesWG: Math.round(S.mainP * 100) / 100,
        holderPercent: Math.round(S.holder * 10) / 10,
        sealLevelIn: Math.round(S.seal * 10) / 10,
        waterSealInches: Math.round(S.seal * 10) / 10,
        gasMakeThousandsFt3PerHour: Math.round(gasMake() * 42) / 10,
        exhausterRpm: Math.round(S.rpm),
        exhausterRunning: S.exRunning && !S.exTripLatched && S.rpm > 2,
        governorSetting: S.governor,
        damperSetting: S.damper,
        valveQuarterTurns: S.valve,
        selectedRetort: S.sel + 1,
        doorsOpen: S.doors.slice(),
        safetyLidsLifted: S.lidsLift,
        backfired: S.backfire,
        scorched: S.scorch,
        clinkerFraction: Math.round(S.clinker * 100) / 100,
        testBurnerOn: S.tbOn,
        testFlameHeightIn: Math.round(testFlameHeight() * 10) / 10,
        retorts: S.retorts.map(function (r, i) {
          return {
            retort: i + 1,
            charged: !!r.coal,
            carbonisedPercent: Math.round(r.c),
            doorOpen: S.doors[i],
          };
        }),
      };
    },

    tick: function (seconds) {
      if (!(seconds > 0)) return;
      var remaining = Math.min(seconds, 3600);
      var h = 0.5;
      while (remaining > 0) {
        var dt = remaining > h ? h : remaining;
        step(dt);
        remaining -= dt;
      }
    },

    inject: function (fault) {
      var f = String(fault || "")
        .trim()
        .toLowerCase();
      if (f === "water seal blown") S.faultSeal = true;
      else if (f === "flue clinker fouling") S.faultClinker = true;
      else if (f === "exhauster overload trip") {
        S.faultExTrip = true;
        S.exTripLatched = true;
      }
    },

    reset: function () {
      var alarms = S.alarms,
        accepted = S.accepted;
      ALARM_DEFS.forEach(function (n) {
        alarms[n] = false;
        accepted[n] = false;
      });
      S = coldState();
      ALARM_DEFS.forEach(function (n) {
        alarms[n] = false;
      });
      S.alarms = alarms;
      S.accepted = accepted;
      syncControlsToState();
    },
  };

  function formatClock() {
    var m = Math.floor(S.clockMin);
    var hh = Math.floor(m / 60),
      mm = m % 60;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function testFlameHeight() {
    if (!S.tbOn || S.mainP <= 0.25) return 0;
    var effTemp = S.temp * (1 - 0.5 * S.clinker);
    var q = clamp(
      1.04 - Math.abs(effTemp - 1680) / 2300 - (S.scorch ? 0.18 : 0),
      0.15,
      1.05,
    );
    return q * (S.mainP < 0.6 ? 0.55 : 1) * 26;
  }

  window.machine = api;

  /* ================================================================
     Panel wiring
     ================================================================ */

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var el = {
    setting: $(".setting"),
    spout: $("[data-spout]"),
    bays: $$(".bay"),
    flamesWrap: $(".flues"),
    rakerod: $("[data-rakerod]"),
    troughWater: $("[data-troughwater]"),
    sealColumn: $("[data-sealcolumn]"),
    lidA: $("[data-lid-a]"),
    lidB: $("[data-lid-b]"),
    bubbles: $("[data-bubbles]"),
    vane: $("[data-vane]"),
    holderSheet: $("[data-holdersheet]"),
    tbflame: $("[data-tbflame]"),
    cascade: $("[data-cascade]"),
    shutters: {},
    jewelFires: $("[data-jewel='fires']"),
    jewelRun: $("[data-jewel='exhauster']"),
    mwaterL: $("[data-mwater-left]"),
    mwaterR: $("[data-mwater-right]"),
    pyroNeedle: $("[data-pyroneedle]"),
    pyroTicks: $("[data-pyroticks]"),
    redArc: $("[data-redarc]"),
    holderNeedle: $("[data-holderneedle]"),
    secTicks: $("[data-secticks]"),
    makeOut: $("[data-make]"),
    rpmOut: $("[data-rpm]"),
    clockOut: $("[data-clock]"),
    chargeBtn: $("[data-control='CHARGE LEVER']"),
    selector: $("[data-control='RETORT SELECTOR']"),
    selKnob: $(".selknob"),
    doorToggle: $("[data-control='RETORT DOOR']"),
    rake: $("[data-control='STOKING RAKE']"),
    rakeBar: $("[data-rakebar]"),
    damper: $("[data-control='PRODUCER DAMPER']"),
    damperHandle: $("[data-damperhandle]"),
    valve: $("[data-control='FIRING VALVE']"),
    valveKnob: $("[data-valveknob]"),
    govWheel: $("[data-control='EXHAUSTER GOVERNOR']"),
    wheelG: $("[data-wheelg]"),
    cock: $("[data-control='SEAL WATER COCK']"),
    tbCock: $("[data-control='TEST BURNER COCK']"),
    acceptBtn: $("[data-control='ALARM ACCEPT']"),
    lampsBtn: $("[data-control='LAMPS TEST']"),
    resetBtn: $("[data-control='TRIP RESET']"),
    fsws: $$(".fsw"),
  };

  Object.keys(ALARM_DEFS).forEach(function () {});
  $$(".shutter").forEach(function (sh) {
    el.shutters[sh.getAttribute("data-alarm")] = sh;
  });

  /* ---------------- dial tick generation ---------------- */

  var NS = "http://www.w3.org/2000/svg";

  function buildTicks(group, cx, cy, r0, r1, aStart, aEnd, steps, labelsEvery) {
    if (!group) return;
    for (var i = 0; i <= steps; i++) {
      var a = ((aStart + (aEnd - aStart) * (i / steps)) * Math.PI) / 180;
      var major = i % labelsEvery === 0;
      var rr = major ? r1 : r1 - 5;
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", (cx + Math.sin(a) * rr).toFixed(1));
      ln.setAttribute("y1", (cy - Math.cos(a) * rr).toFixed(1));
      ln.setAttribute("x2", (cx + Math.sin(a) * r0).toFixed(1));
      ln.setAttribute("y2", (cy - Math.cos(a) * r0).toFixed(1));
      group.appendChild(ln);
      if (major) {
        var tx = document.createElementNS(NS, "text");
        tx.setAttribute("x", (cx + Math.sin(a) * (r1 + 9)).toFixed(1));
        tx.setAttribute("y", (cy - Math.cos(a) * (r1 + 9) + 2.5).toFixed(1));
        tx.setAttribute("text-anchor", "middle");
        tx.textContent = String(800 + i * 400);
        group.appendChild(tx);
      }
    }
  }

  buildTicks(el.pyroTicks, 75, 82, 44, 52, -120, 120, 8, 2);

  (function () {
    var g = el.secTicks;
    if (!g) return;
    for (var i = 0; i <= 4; i++) {
      var a = ((-60 + i * 30) * Math.PI) / 180;
      var ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", (75 + Math.sin(a) * 50).toFixed(1));
      ln.setAttribute("y1", (92 - Math.cos(a) * 50).toFixed(1));
      ln.setAttribute("x2", (75 + Math.sin(a) * 56).toFixed(1));
      ln.setAttribute("y2", (92 - Math.cos(a) * 56).toFixed(1));
      g.appendChild(ln);
    }
  })();

  (function () {
    var p = el.redArc;
    if (!p) return;
    /* red sector from 2050F upward: angle for 2050 = -120+(2050-800)/1600*240 */
    var a1 = ((-120 + ((2050 - 800) / 1600) * 240) * Math.PI) / 180;
    var a2 = (120 * Math.PI) / 180;
    var r = 48,
      cx = 75,
      cy = 82;
    var x1 = cx + Math.sin(a1) * r,
      y1 = cy - Math.cos(a1) * r;
    var x2 = cx + Math.sin(a2) * r,
      y2 = cy - Math.cos(a2) * r;
    p.setAttribute(
      "d",
      "M" +
        x1.toFixed(1) +
        " " +
        y1.toFixed(1) +
        " A" +
        r +
        " " +
        r +
        " 0 0 1 " +
        x2.toFixed(1) +
        " " +
        y2.toFixed(1),
    );
  })();

  /* ---------------- generic slider behaviour ---------------- */

  function bindSlider(node, opts) {
    if (!node) return;
    var get = opts.get,
      set = opts.set,
      max = opts.max,
      horiz = !!opts.horiz;

    function applyFromEvent(ev) {
      var rect = node.getBoundingClientRect();
      var frac;
      if (horiz) frac = (ev.clientX - rect.left) / rect.width;
      else frac = 1 - (ev.clientY - rect.top) / rect.height;
      set(clamp(Math.round(frac * max), 0, max));
    }

    node.addEventListener("pointerdown", function (ev) {
      node.setPointerCapture && node.setPointerCapture(ev.pointerId);
      applyFromEvent(ev);
      var move = function (e) {
        applyFromEvent(e);
      };
      var up = function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      ev.preventDefault();
    });

    node.addEventListener("keydown", function (ev) {
      var cur = get();
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
        set(clamp(cur + 1, 0, max));
        ev.preventDefault();
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
        set(clamp(cur - 1, 0, max));
        ev.preventDefault();
      } else if (ev.key === "Home") {
        set(0);
        ev.preventDefault();
      } else if (ev.key === "End") {
        set(max);
        ev.preventDefault();
      }
    });
  }

  /* --- retort selector --- */

  function setSelect(v) {
    S.sel = clamp(v, 0, RETORTS - 1);
    el.selector.setAttribute("aria-valuenow", String(S.sel + 1));
    el.doorToggle.setAttribute(
      "aria-pressed",
      S.doors[S.sel] ? "true" : "false",
    );
  }

  bindSlider(el.selector, {
    max: 4,
    horiz: true,
    get: function () {
      return S.sel;
    },
    set: function (v) {
      setSelect(v);
    },
  });

  el.selector.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" || ev.key === " ") {
      setSelect((S.sel + 1) % RETORTS);
      ev.preventDefault();
    }
  });

  /* --- retort door --- */

  el.doorToggle.addEventListener("click", function () {
    S.doors[S.sel] = !S.doors[S.sel];
    this.setAttribute("aria-pressed", S.doors[S.sel] ? "true" : "false");
  });

  /* --- charge lever --- */

  var chargingBusy = false;
  el.chargeBtn.addEventListener("click", function () {
    if (chargingBusy) return;
    chargingBusy = true;
    var btn = this;
    btn.classList.add("pulled");
    setTimeout(function () {
      var r = S.retorts[S.sel];
      var canCharge = !r.coal || r.c >= 97;
      if (canCharge) {
        r.coal = 1;
        r.c = 2;
        S.temp = Math.max(AMBIENT, S.temp - 130);
        placeCascade();
        el.cascade.classList.remove("run");
        void el.cascade.offsetWidth;
        el.cascade.classList.add("run");
      }
      btn.classList.remove("pulled");
      setTimeout(function () {
        chargingBusy = false;
      }, 240);
    }, 340);
  });

  function placeCascade() {
    var bay = el.bays[S.sel];
    if (!bay) return;
    var x =
      parseFloat(bay.style.left) ||
      parseFloat(bay.getAttribute("data-x")) ||
      [4.2, 14.6, 25, 35.4, 45.8][S.sel];
    el.cascade.style.left = x + 3.4 + "%";
  }

  /* --- stoking rake --- */

  function countStroke(pos) {
    if (pos >= 92) S.rakeArmed = true;
    if (S.rakeArmed && pos <= 8) {
      S.rakeArmed = false;
      if (S.doors[S.sel]) {
        S.clinker = Math.max(0, S.clinker - 0.36);
        var r = S.retorts[S.sel];
        if (r.coal && r.c < 100) r.c = clamp(r.c + 1.5, 0, 100);
      }
    }
  }

  bindSlider(el.rake, {
    max: 100,
    horiz: true,
    get: function () {
      return S.rakePos;
    },
    set: function (v) {
      S.rakePos = v;
      countStroke(v);
      el.rake.setAttribute("aria-valuenow", String(v));
    },
  });

  /* --- producer damper --- */

  bindSlider(el.damper, {
    max: 10,
    horiz: false,
    get: function () {
      return S.damper;
    },
    set: function (v) {
      S.damper = v;
      el.damper.setAttribute("aria-valuenow", String(v));
    },
  });

  /* --- firing valve --- */

  function setValve(v) {
    S.valve = clamp(v, 0, 8);
    el.valve.setAttribute("aria-valuenow", String(S.valve));
  }

  bindSlider(el.valve, {
    max: 8,
    horiz: true,
    get: function () {
      return S.valve;
    },
    set: setValve,
  });

  el.valve.addEventListener("click", function (ev) {
    var rect = this.getBoundingClientRect();
    var dir = ev.clientX - rect.left > rect.width / 2 ? 1 : -1;
    setValve(S.valve + dir);
  });

  /* --- exhauster governor handwheel --- */

  function setGov(v) {
    S.governor = clamp(v, 0, 10);
    el.govWheel.setAttribute("aria-valuenow", String(S.governor));
  }

  el.govWheel.addEventListener("pointerdown", function (ev) {
    var rect = this.getBoundingClientRect();
    var dir = ev.clientX - rect.left > rect.left + rect.width / 2 ? 1 : -1;
    setGov(S.governor + dir);
    ev.preventDefault();
  });

  el.govWheel.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
      setGov(S.governor + 1);
      ev.preventDefault();
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
      setGov(S.governor - 1);
      ev.preventDefault();
    } else if (ev.key === "Home") {
      setGov(0);
      ev.preventDefault();
    } else if (ev.key === "End") {
      setGov(10);
      ev.preventDefault();
    }
  });

  /* --- seal water cock (hold) --- */

  function cockDown(on) {
    S.cockHeld = on;
    el.cock.classList.toggle("held", on);
  }

  el.cock.addEventListener("pointerdown", function (ev) {
    cockDown(true);
    ev.preventDefault();
  });
  window.addEventListener("pointerup", function () {
    cockDown(false);
  });
  window.addEventListener("pointercancel", function () {
    cockDown(false);
  });
  el.cock.addEventListener("keydown", function (ev) {
    if (ev.key === " " || ev.key === "Enter") {
      cockDown(true);
      ev.preventDefault();
    }
  });
  el.cock.addEventListener("keyup", function (ev) {
    if (ev.key === " " || ev.key === "Enter") cockDown(false);
  });
  el.cock.addEventListener("blur", function () {
    cockDown(false);
  });

  /* --- test burner cock --- */

  el.tbCock.addEventListener("click", function () {
    S.tbOn = !S.tbOn;
    this.setAttribute("aria-pressed", S.tbOn ? "true" : "false");
  });

  /* --- annunciation buttons --- */

  el.acceptBtn.addEventListener("click", function () {
    ALARM_DEFS.forEach(function (n) {
      S.accepted[n] = true;
    });
  });

  function lampsDown(on) {
    S.lampsTest = on;
  }
  el.lampsBtn.addEventListener("pointerdown", function (ev) {
    lampsDown(true);
    ev.preventDefault();
  });
  window.addEventListener("pointerup", function () {
    lampsDown(false);
  });
  el.lampsBtn.addEventListener("keydown", function (ev) {
    if (ev.key === " " || ev.key === "Enter") {
      lampsDown(true);
      ev.preventDefault();
    }
  });
  el.lampsBtn.addEventListener("keyup", function (ev) {
    if (ev.key === " " || ev.key === "Enter") lampsDown(false);
  });
  el.lampsBtn.addEventListener("blur", function () {
    lampsDown(false);
  });

  /* --- trip reset --- */

  el.resetBtn.addEventListener("click", function () {
    /* clears the exhauster overload and relights a backfired bench */
    if (S.faultExTrip) S.faultExTrip = false;
    if (S.exTripLatched) {
      S.exTripLatched = false;
      S.exRunning = true;
    }
    if (S.backfire && S.valve === 0 && S.mainP > -0.3) {
      S.backfire = false;
    }
    if (S.scorch && S.temp < 1900) {
      S.scorch = false;
      S.scorchTimer = 0;
    }
  });

  /* --- fault test switches --- */

  el.fsws.forEach(function (sw) {
    sw.addEventListener("click", function () {
      var f = this.getAttribute("data-fault");
      var active = api.state().faultsActive.indexOf(f) !== -1;
      if (!active) {
        api.inject(f);
      } else if (f === "water seal blown") {
        S.faultSeal = false;
      } else if (f === "flue clinker fouling") {
        S.faultClinker = false;
      } else if (f === "exhauster overload trip") {
        S.faultExTrip = false;
        if (S.exTripLatched) {
          S.exTripLatched = false;
          S.exRunning = true;
        }
      }
    });
  });

  /* --- manual dialog --- */

  var dlg = $("dialog[data-manual]");
  $$("[data-action='manual']").forEach(function (b) {
    b.addEventListener("click", function () {
      if (dlg && !dlg.open) dlg.showModal();
    });
  });
  $$("[data-action='close-manual']").forEach(function (b) {
    b.addEventListener("click", function () {
      if (dlg && dlg.open) dlg.close();
    });
  });
  if (dlg) {
    dlg.addEventListener("click", function (ev) {
      if (ev.target === dlg) dlg.close();
    });
  }

  /* ---------------- keep panel controls in step with state ------------- */

  function syncControlsToState() {
    if (el.selector) el.selector.setAttribute("aria-valuenow", "1");
    if (el.doorToggle) el.doorToggle.setAttribute("aria-pressed", "false");
    if (el.rake) el.rake.setAttribute("aria-valuenow", "0");
    if (el.damper) el.damper.setAttribute("aria-valuenow", "0");
    if (el.valve) el.valve.setAttribute("aria-valuenow", "0");
    if (el.govWheel) el.govWheel.setAttribute("aria-valuenow", "0");
    if (el.tbCock) el.tbCock.setAttribute("aria-pressed", "false");
    if (el.chargeBtn) el.chargeBtn.classList.remove("pulled");
    if (el.cock) el.cock.classList.remove("held");
    el.fsws.forEach(function (sw) {
      sw.setAttribute("aria-pressed", "false");
    });
  }

  /* ---------------- render ---------------- */

  var lastRenderFaults = "";

  function render() {
    var st = api.state();

    /* setting atmosphere */
    var burn = burnLevel();
    el.setting.style.setProperty("--fire", (burn * 0.95).toFixed(3));

    /* doors and glow */
    var glow = clamp((S.temp - 700) / 1500, 0, 1) * (0.35 + 0.65 * burn);
    for (var i = 0; i < el.bays.length; i++) {
      var bay = el.bays[i];
      bay.classList.toggle("open", !!S.doors[i]);
      bay.classList.toggle("doorglow", !!S.doors[i]);
      bay.querySelector(".glow").style.setProperty("--glow", glow.toFixed(3));
    }

    /* spout follows selection */
    if (el.spout)
      el.spout.style.transform = "rotate(" + (S.sel * 17 - 6) + "deg)";

    /* rake rod */
    var doorOpenSel = S.doors[S.sel];
    if (doorOpenSel && S.rakePos > 2) {
      var bx = [4.2, 14.6, 25, 35.4, 45.8][S.sel];
      el.rakerod.classList.add("show");
      el.rakerod.style.left = bx + 1.2 + "%";
      el.rakerod.style.width = 10 - S.rakePos * 0.075 + "%";
    } else {
      el.rakerod.classList.remove("show");
    }

    /* trough, seal, lids, bubbles */
    var sealPct = clamp((S.seal / 7.5) * 100, 0, 100);
    el.troughWater.style.setProperty("--sealh", sealPct.toFixed(1) + "%");
    el.sealColumn.style.setProperty("--sealh", sealPct.toFixed(1) + "%");
    el.lidA.classList.toggle("pop", S.lidsLift);
    el.lidB.classList.toggle("pop", S.lidsLift);
    el.bubbles.classList.toggle("on", gasMake() > 1.5 && S.mainP > 0.2);

    /* exhauster */
    if (S.rpm > 3) {
      el.vane.classList.add("spinning");
      el.vane.style.animationDuration =
        clamp(60 / (S.rpm * 0.35), 0.12, 6).toFixed(2) + "s";
    } else {
      el.vane.classList.remove("spinning");
    }

    /* holder */
    el.holderSheet.style.setProperty(
      "--holdh",
      clamp(st.holderPercent, 0, 100).toFixed(1) + "%",
    );

    /* test burner */
    var tbh = testFlameHeight();
    el.tbflame.classList.toggle("burn", tbh > 0.2);
    el.tbflame.style.setProperty("--tbh", tbh.toFixed(1) + "%");

    /* manometer: 21px per inch WG, zero at y=115 */
    var yL = clamp(115 + S.mainP * 21, 46, 139);
    var yR = clamp(115 - S.mainP * 21, 46, 139);
    el.mwaterL.setAttribute("y", yL.toFixed(1));
    el.mwaterL.setAttribute("height", Math.max(0, 123 - yL).toFixed(1));
    el.mwaterR.setAttribute("y", yR.toFixed(1));
    el.mwaterR.setAttribute("height", Math.max(0, 123 - yR).toFixed(1));

    /* pyrometer needle: clinker makes the flue read hot */
    var pyroShown = clamp(S.temp + S.clinker * 260, 0, 2600);
    var pa = -120 + ((clamp(pyroShown, 800, 2400) - 800) / 1600) * 240;
    el.pyroNeedle.setAttribute(
      "transform",
      "rotate(" + pa.toFixed(1) + " 75 82)",
    );

    /* holder gauge needle */
    var ha = -60 + clamp(st.holderPercent, 0, 100) * 1.2;
    el.holderNeedle.setAttribute(
      "transform",
      "rotate(" + ha.toFixed(1) + " 75 92)",
    );

    /* cards */
    el.makeOut.textContent = st.gasMakeThousandsFt3PerHour.toFixed(1);
    el.rpmOut.textContent = String(st.exhausterRpm);
    el.clockOut.textContent = st.clock;

    /* control visuals */
    el.selKnob.style.transform = "rotate(" + (S.sel * 30 - 60) + "deg)";
    el.rakeBar.style.left = 8 + S.rakePos * 0.58 + "%";
    el.damperHandle.style.bottom = el.valveKnob.style.transform =
      "rotate(" + (135 - S.valve * 45) + "deg)";

    el.valveKnob.style.transform = "rotate(" + S.valve * 45 + "deg)";
    el.wheelG.setAttribute(
      "transform",
      "rotate(" + S.governor * 36 + " 50 50)",
    );

    /* jewels */
    el.jewelFires.classList.toggle("lit-fires", burn > 0.02 && !S.backfire);
    el.jewelRun.classList.toggle("lit-run", S.rpm > 4);

    /* shutters */
    var faultKey = st.faultsActive.join("|");
    if (faultKey !== lastRenderFaults) {
      el.fsws.forEach(function (sw) {
        var f = sw.getAttribute("data-fault");
        sw.setAttribute(
          "aria-pressed",
          st.faultsActive.indexOf(f) !== -1 ? "true" : "false",
        );
      });
      lastRenderFaults = faultKey;
    }
    ALARM_DEFS.forEach(function (name) {
      var sh = el.shutters[name];
      if (!sh) return;
      var active = S.alarms[name];
      sh.classList.toggle("alarm", active && !(S.accepted[name] && active));
      sh.classList.toggle("acked", !!(active && S.accepted[name]));
      sh.classList.toggle("testlit", S.lampsTest);
    });

    /* door toggle reflects selection */
    el.doorToggle.setAttribute(
      "aria-pressed",
      S.doors[S.sel] ? "true" : "false",
    );
  }

  /* ---------------- main loop ---------------- */

  var last = performance.now();
  var hidden = false;

  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
    last = performance.now();
  });

  function frame(now) {
    var dt = (now - last) / 1000;
    last = now;
    if (!hidden && dt > 0) {
      api.tick(Math.min(dt, 0.5));
      render();
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  render();
})();
