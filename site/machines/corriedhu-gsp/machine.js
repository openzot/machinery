/* ========================================================================
   CORRIEDHU GRID SUPPLY POINT — behaviour
   A 132/33 kV distribution substation: two incoming circuits, two 45 MVA
   transformers with on-load tap changers, a split 33 kV busbar and six
   feeders. Deterministic tick(), no clocks, no randomness.
   ======================================================================== */

(function () {
  "use strict";

  var FAULTS = [
    "transformer gas accumulation",
    "tap changer mechanism jam",
    "incomer line trip",
  ];

  var FEEDER_BASE_MW = [8.5, 7.0, 9.5, 8.0, 10.0, 6.5];
  var RATING_MVA = 45;
  var SYNC_WINDOW_DEG = 18;
  var SLIP_HZ = 0.05;

  /* ---- simulation state -------------------------------------------------- */

  function freshBreakers() {
    return {
      tlnd: false,
      cbth: false,
      t1hv: false,
      t1lv: false,
      t2hv: false,
      t2lv: false,
      section: false,
      f1: false,
      f2: false,
      f3: false,
      f4: false,
      f5: false,
      f6: false,
    };
  }

  function freshState() {
    return {
      t: 0,
      brk: freshBreakers(),
      tap1: 0,
      tap2: 0,
      regMode: 0, // 0 OFF, 1 AUTO, 2 MANUAL
      syncCheck: false,
      telemetry: true,
      lampTest: false,
      hornSilenced: false,
      /* network */
      kv132: 0,
      busApv: 0,
      busBpv: 0,
      freq: 50,
      demandMw: 0,
      tx1Mva: 0,
      tx2Mva: 0,
      syncAngle: 25,
      /* thermal */
      tx1Oil: 19,
      tx2Oil: 19,
      tx1Wdg: 19,
      tx2Wdg: 19,
      /* faults */
      faults: { gas: false, jam: false, lineTrip: false },
      gasLevel: 0,
      jamLatched: false,
      /* timers */
      ops: [], // queued switching operations {at, kind}
      uvA: 0,
      uvB: 0,
      uvWarnA: 0,
      uvWarnB: 0,
      liveLatchA: false,
      liveLatchB: false,
      deadBoth: 0,
      everLive: false,
      autoClock: 0,
      lastJamMsg: -9,
      /* alarms: name -> {on, acked} */
      alarms: {},
    };
  }

  /* ---- helpers ------------------------------------------------------------ */

  var S = freshState();
  var BOOTED = false;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function raise(name) {
    var a = S.alarms[name];
    if (!a) {
      S.alarms[name] = { on: true, acked: false };
      S.hornSilenced = false;
    } else if (!a.on) {
      a.on = true;
      a.acked = false;
      S.hornSilenced = false;
    }
  }

  function clearCond(name) {
    var a = S.alarms[name];
    if (a) a.on = false;
  }

  function clockStr(t) {
    var secs = Math.floor(16 * 3600 + 32 * 60 + t);
    var h = Math.floor(secs / 3600) % 24;
    var m = Math.floor((secs % 3600) / 60);
    var s = secs % 60;
    function z(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return z(h) + ":" + z(m) + ":" + z(s);
  }

  function log(msg, kind) {
    if (!BOOTED || !S.telemetry || typeof document === "undefined") return;
    var box = document.querySelector("[data-crt]");
    if (!box) return;
    var div = document.createElement("div");
    div.className = "crt-line" + (kind ? " " + kind : "");
    div.textContent = clockStr(S.t) + "  " + msg;
    box.appendChild(div);
    while (box.childNodes.length > 64) box.removeChild(box.firstChild);
  }

  /* ---- network solution ---------------------------------------------------- */

  function demandCurve(t) {
    var h = (16.533 + t / 3600) % 24;
    var evening = Math.exp(-Math.pow((h - 17.6) / 1.9, 2));
    var midday = Math.exp(-Math.pow((h - 12.5) / 2.2, 2));
    return 0.75 + 0.42 * evening + 0.18 * midday;
  }

  function solveNetwork(dt) {
    var b = S.brk;
    var prevA = S.busApv;
    var prevB = S.busBpv;

    S.kv132 = 0;
    if (b.tlnd || b.cbth) {
      S.kv132 = 141.5 + 1.2 * Math.sin(S.t / 53) + 0.4 * Math.sin(S.t / 7.7);
    }
    var v132pu = S.kv132 / 132;

    var t1Hot = b.t1hv && S.kv132 > 100;
    var t2Hot = b.t2hv && S.kv132 > 100;

    var mva = [0, 0, 0, 0, 0, 0];
    var mult = demandCurve(S.t);
    var i;
    for (i = 0; i < 6; i++) {
      var onHalfA = i < 3;
      var halfLive = onHalfA ? S.busApv : S.busBpv;
      var fb = b["f" + (i + 1)];
      if (fb && halfLive > 0.45) {
        var jit =
          1 +
          0.06 * Math.sin(S.t / 47 + i * 2.1) +
          0.03 * Math.sin(S.t / 13 + i);
        mva[i] = (FEEDER_BASE_MW[i] * mult * jit) / 0.95;
      }
    }
    var loadA = mva[0] + mva[1] + mva[2];
    var loadB = mva[3] + mva[4] + mva[5];
    S.tx1Mva = t1Hot && b.t1lv ? loadA : t1Hot ? 0.4 : 0;
    S.tx2Mva = t2Hot && b.t2lv ? loadB : t2Hot ? 0.4 : 0;

    S.demandMw = 0;
    for (i = 0; i < 6; i++) {
      if (mva[i] > 0) S.demandMw += mva[i] * 0.95;
    }

    /* voltages: droop through the transformer impedance plus OLTC boost */
    var s1 = S.tx1Mva / RATING_MVA;
    var s2 = S.tx2Mva / RATING_MVA;
    var va = 0;
    var vb = 0;
    if (t1Hot) va = clamp(v132pu - s1 * 0.13 + S.tap1 * 0.0167, 0, 1.25);
    if (t2Hot) vb = clamp(v132pu - s2 * 0.13 + S.tap2 * 0.0167, 0, 1.25);
    if (b.section) {
      var vsec = Math.max(va, vb);
      va = vsec;
      vb = vsec;
    }
    S.busApv = va;
    S.busBpv = vb;
    if (S.busApv > 0.45 || S.busBpv > 0.45) S.everLive = true;

    S.freq = 50 + 0.06 * Math.sin(S.t / 41) + 0.025 * Math.sin(S.t / 9.7);

    /* synchronism: angle between an incoming circuit and the bus */
    if (S.kv132 > 100 && (prevA > 0 || prevB > 0)) {
      S.syncAngle = (S.syncAngle + 360 * SLIP_HZ * dt) % 360;
    }

    return {
      t1Hot: t1Hot,
      t2Hot: t2Hot,
      loadA: loadA,
      loadB: loadB,
    };
  }

  /* ---- protection, regulation, escalation ---------------------------------- */

  function stepProtection(net, dt) {
    var b = S.brk;

    /* Buchholz gas on Tx1: the tank makes gas whatever the duty */
    if (S.faults.gas) {
      S.gasLevel += dt / 26;
      if (S.gasLevel >= 1) raise("TX1 GAS");
      if (S.gasLevel >= 2.2) {
        S.gasLevel = 2.2;
        if (net.t1Hot && (b.t1lv || b.t1hv)) {
          b.t1lv = false;
          b.t1hv = false;
          log("TX1 BUCHHOLZ SURGE OPERATION - TRIP", "trip");
        }
      }
    }

    /* winding temperature trips */
    if (S.tx1Wdg > 140 && (b.t1hv || b.t1lv)) {
      b.t1lv = false;
      b.t1hv = false;
      log("TX1 WINDING TEMPERATURE TRIP", "trip");
    }
    if (S.tx2Wdg > 140 && (b.t2hv || b.t2lv)) {
      b.t2lv = false;
      b.t2hv = false;
      log("TX2 WINDING TEMPERATURE TRIP", "trip");
    }

    /* overload and temperature alarms */
    var s1 = S.tx1Mva / RATING_MVA;
    var s2 = S.tx2Mva / RATING_MVA;
    if (s1 > 1.05 || s2 > 1.05) raise("TX OVERLOAD");
    else clearCond("TX OVERLOAD");
    if (S.tx1Wdg > 115) raise("TX1 WDG TEMP");
    else clearCond("TX1 WDG TEMP");

    /* undervoltage: warn below 90%, release feeders below 45% for three seconds */
    monitorHalf(true, dt);
    monitorHalf(false, dt);

    /* total supply failure once the panel has been in service */
    if (S.busApv <= 0.01 && S.busBpv <= 0.01) {
      S.deadBoth += dt;
      if (S.deadBoth > 4 && S.everLive) raise("SUPPLY FAIL");
    } else {
      S.deadBoth = 0;
      clearCond("SUPPLY FAIL");
    }

    /* automatic voltage regulation, one move every six seconds per unit */
    if (S.regMode === 1) {
      S.autoClock += dt;
      if (S.autoClock >= 6) {
        S.autoClock = 0;
        autoRegulate();
      }
    } else {
      S.autoClock = 0;
    }

    integrateThermal(dt);

    /* SYNC BLOCK decays by itself once seen */
    var sb = S.alarms["SYNC BLOCK"];
    if (sb && sb.on && sb.raisedAt !== undefined && S.t - sb.raisedAt > 2.5) {
      clearCond("SYNC BLOCK");
    }
  }

  function monitorHalf(isA, dt) {
    var pu = isA ? S.busApv : S.busBpv;
    var wKey = isA ? "uvWarnA" : "uvWarnB";
    var rKey = isA ? "uvA" : "uvB";
    if (pu > 0.01 && pu < 0.9) {
      S[wKey] += dt;
      if (S[wKey] > 4) raise("33KV U/V");
    } else {
      S[wKey] = 0;
    }
    if (pu > 0.45) {
      S[isA ? "liveLatchA" : "liveLatchB"] = true;
      S[rKey] = 0;
    }
    if (pu < 0.45 && S[isA ? "liveLatchA" : "liveLatchB"]) {
      S[rKey] += dt;
      if (S[rKey] > 3) {
        var dropped = false;
        var keys = isA ? ["f1", "f2", "f3"] : ["f4", "f5", "f6"];
        keys.forEach(function (f) {
          if (S.brk[f]) {
            S.brk[f] = false;
            dropped = true;
          }
        });
        if (dropped)
          log(
            "U/V RELEASE - BUS " + (isA ? "A" : "B") + " FEEDERS DROPPED",
            "warn",
          );
        S[rKey] = 0;
      }
    } else {
      S[rKey] = 0;
    }
    if (S.busApv >= 0.9 && S.busBpv >= 0.9) clearCond("33KV U/V");
  }

  function autoRegulate() {
    if (S.brk.section) {
      var errP = 1 - Math.max(S.busApv, S.busBpv);
      if (Math.abs(errP) > 0.012) {
        var lead = Math.floor(S.t / 6) % 2 === 0 ? 1 : 2;
        moveTap(lead, errP > 0 ? 1 : -1, "AUTO");
      }
      return;
    }
    var errA = 1 - S.busApv;
    var errB = 1 - S.busBpv;
    if (S.brk.t1lv && Math.abs(errA) > 0.012)
      moveTap(1, errA > 0 ? 1 : -1, "AUTO");
    if (S.brk.t2lv && Math.abs(errB) > 0.012)
      moveTap(2, errB > 0 ? 1 : -1, "AUTO");
  }

  function moveTap(tx, dir, why) {
    if (tx === 2 && S.jamLatched) {
      if (S.t - S.lastJamMsg > 8) {
        S.lastJamMsg = S.t;
        log("TX2 OLTC JAMMED - MOVE REFUSED", "warn");
        raise("TX2 OLTC JAM");
      }
      return false;
    }
    var pos = tx === 1 ? S.tap1 : S.tap2;
    var next = pos + dir;
    if (next < -10 || next > 10) {
      if (why !== "AUTO") log("TX" + tx + " TAP AT LIMIT " + pos, "warn");
      return false;
    }
    if (tx === 1) S.tap1 = next;
    else S.tap2 = next;
    log(
      "TX" +
        tx +
        " TAP CHANGE " +
        (dir > 0 ? "RAISE" : "LOWER") +
        " -> " +
        (next > 0 ? "+" : "") +
        next +
        (why === "LOCAL" ? "" : " (" + why + ")"),
    );
    return true;
  }

  function integrateThermal(dt) {
    function unit(mva, oil, wdg) {
      var s = mva / RATING_MVA;
      var oilTarget = 19 + 30 * Math.pow(Math.max(s, 0.008), 1.6);
      var wdgTarget = oilTarget + 12 + 34 * Math.max(0, s * s - 0.35);
      var kOil = 1 - Math.exp(-dt / 300);
      var kWdg = 1 - Math.exp(-dt / 90);
      return [oil + (oilTarget - oil) * kOil, wdg + (wdgTarget - wdg) * kWdg];
    }
    var r1 = unit(S.tx1Mva, S.tx1Oil, S.tx1Wdg);
    S.tx1Oil = r1[0];
    S.tx1Wdg = r1[1];
    var r2 = unit(S.tx2Mva, S.tx2Oil, S.tx2Wdg);
    S.tx2Oil = r2[0];
    S.tx2Wdg = r2[1];
  }

  /* ---- switching operations ------------------------------------------------ */

  function command(key, action) {
    queue(S.t + (action === "close" ? 0.3 : 0.15), action + ":" + key);
  }

  function queue(at, kind) {
    S.ops.push({ at: at, kind: kind });
  }

  function refuse(msg) {
    log(msg, "warn");
  }

  function angledist(a) {
    return Math.min(a, 360 - a);
  }

  function raiseSyncBlock() {
    raise("SYNC BLOCK");
    S.alarms["SYNC BLOCK"].raisedAt = S.t;
  }

  function runOps() {
    var keep = [];
    for (var i = 0; i < S.ops.length; i++) {
      if (S.ops[i].at > S.t) keep.push(S.ops[i]);
      else execOp(S.ops[i].kind);
    }
    S.ops = keep;
  }

  function execOp(kind) {
    var b = S.brk;
    var p = kind.split(":");
    var cmd = p[0];
    var key = p[1];

    /* a transformer bay control switch drives the HV and LV breakers in order */
    if (key === "t1pair" || key === "t2pair") {
      var hv = key === "t1pair" ? "t1hv" : "t2hv";
      var lv = key === "t1pair" ? "t1lv" : "t2lv";
      if (cmd === "close") {
        execOp("close:" + hv);
      } else {
        execOp("trip:" + lv);
        execOp("trip:" + hv);
      }
      return;
    }

    if (cmd === "close") {
      if (key === "tlnd" || key === "cbth") {
        var nm = key === "tlnd" ? "TEINDLAND" : "CAIRNBEATH";
        if (!S.syncCheck) {
          refuse(nm + " CLOSE REFUSED - SYNCHRO-CHECK OFF");
          raiseSyncBlock();
          return;
        }
        if (S.kv132 > 100 && angledist(S.syncAngle) > SYNC_WINDOW_DEG) {
          refuse(nm + " CLOSE BLOCKED - OUTSIDE SYNCHRONISM WINDOW");
          raiseSyncBlock();
          return;
        }
        b[key] = true;
        log(nm + " 132 kV CIRCUIT CLOSED", "info");
        if (key === "tlnd" && S.faults.lineTrip) {
          S.faults.lineTrip = false;
          clearCond("TEINDLAND LINE");
          log("TEINDLAND CIRCUIT RESTORED", "info");
        }
        return;
      }
      if (key === "t1hv" || key === "t2hv") {
        var tx = key === "t1hv" ? 1 : 2;
        if (S.kv132 < 100) {
          refuse("TX" + tx + " HV CLOSE REFUSED - NO 132 kV SUPPLY");
          return;
        }
        b[key] = true;
        log("TX" + tx + " HV BREAKER CLOSED", "info");
        queue(S.t + 1.2, "close:" + (tx === 1 ? "t1lv" : "t2lv"));
        return;
      }
      if (key === "t1lv" || key === "t2lv") {
        var hvKey = key === "t1lv" ? "t1hv" : "t2hv";
        var n = key === "t1lv" ? 1 : 2;
        if (!b[hvKey] || S.kv132 < 100) {
          refuse("TX" + n + " LV CLOSE REFUSED - HV NOT ENERGISED");
          return;
        }
        b[key] = true;
        log("TX" + n + " LV BREAKER CLOSED", "info");
        return;
      }
      if (key === "section") {
        var aLive = S.busApv > 0.45;
        var bLive = S.busBpv > 0.45;
        if (aLive && bLive) {
          refuse("BUS SECTION CLOSE REFUSED - PARALLEL INTERLOCK");
          return;
        }
        if (!aLive && !bLive) {
          refuse("BUS SECTION CLOSE REFUSED - BOTH HALVES DEAD");
          return;
        }
        b.section = true;
        log("33 kV BUS SECTION CLOSED - BACKFEED ESTABLISHED", "info");
        return;
      }
      if (key.charAt(0) === "f") {
        var halfA = key === "f1" || key === "f2" || key === "f3";
        var hl = halfA ? S.busApv : S.busBpv;
        if (hl < 0.45) {
          refuse("FEEDER " + key.charAt(1) + " CLOSE REFUSED - BUS DEAD");
          return;
        }
        b[key] = true;
        log("FEEDER " + key.charAt(1) + " CLOSED", "info");
        return;
      }
      return;
    }

    if (cmd === "trip" && b[key]) {
      b[key] = false;
      log(opLabel(key) + " TRIPPED", "warn");
    }
  }

  function opLabel(key) {
    var names = {
      tlnd: "TEINDLAND 132 kV CIRCUIT",
      cbth: "CAIRNBEATH 132 kV CIRCUIT",
      t1hv: "TX1 HV BREAKER",
      t1lv: "TX1 LV BREAKER",
      t2hv: "TX2 HV BREAKER",
      t2lv: "TX2 LV BREAKER",
      section: "33 kV BUS SECTION",
      f1: "FEEDER 1",
      f2: "FEEDER 2",
      f3: "FEEDER 3",
      f4: "FEEDER 4",
      f5: "FEEDER 5",
      f6: "FEEDER 6",
    };
    return names[key] || key.toUpperCase();
  }

  /* ---- fixed API ------------------------------------------------------------- */

  function tick(seconds) {
    if (!(seconds > 0)) return;
    var remaining = Math.min(seconds, 4);
    while (remaining > 0) {
      var h = Math.min(0.25, remaining);
      remaining -= h;
      S.t += h;
      var net = solveNetwork(h);
      runOps();
      net = solveNetwork(0);
      stepProtection(net, h);
    }
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function stateSnapshot() {
    var b = S.brk;
    var alarms = [];
    var name;
    for (name in S.alarms) {
      if (S.alarms[name].on) alarms.push(name);
    }
    return {
      time: round2(S.t),
      clock: clockStr(S.t),
      freqHz: round2(S.freq),
      kv132: round2(S.kv132),
      busAkV: round2(S.busApv * 33),
      busBkV: round2(S.busBpv * 33),
      demandMW: round2(S.demandMw),
      tx1Mva: round2(S.tx1Mva),
      tx2Mva: round2(S.tx2Mva),
      tx1LoadingPct: Math.round((S.tx1Mva / RATING_MVA) * 100),
      tx2LoadingPct: Math.round((S.tx2Mva / RATING_MVA) * 100),
      tx1TopOilC: round2(S.tx1Oil),
      tx2TopOilC: round2(S.tx2Oil),
      tx1WindingC: round2(S.tx1Wdg),
      tx2WindingC: round2(S.tx2Wdg),
      tap1: S.tap1,
      tap2: S.tap2,
      regulator: ["OFF", "AUTO", "MANUAL"][S.regMode],
      synchroCheck: S.syncCheck,
      telemetry: S.telemetry,
      syncAngleDeg: Math.round(S.syncAngle),
      breakers: {
        teindland: b.tlnd,
        cairnbeath: b.cbth,
        tx1Hv: b.t1hv,
        tx1Lv: b.t1lv,
        tx2Hv: b.t2hv,
        tx2Lv: b.t2lv,
        busSection: b.section,
        feedersClosed: [b.f1, b.f2, b.f3, b.f4, b.f5, b.f6],
      },
      faultsActive: Object.keys(S.faults).filter(function (k) {
        return S.faults[k];
      }),
      alarms: alarms,
    };
  }

  function inject(fault) {
    var f = String(fault || "")
      .trim()
      .toLowerCase();
    if (f === "transformer gas accumulation") {
      S.faults.gas = true;
      S.gasLevel = Math.max(S.gasLevel, 0.9);
      raise("TX1 GAS");
      log("MAINTENANCE TEST - GAS RELAY TX1 OPERATED", "warn");
    } else if (f === "tap changer mechanism jam") {
      S.faults.jam = true;
      S.jamLatched = true;
      raise("TX2 OLTC JAM");
      log("MAINTENANCE TEST - TX2 OLTC MECHANISM JAMMED", "warn");
    } else if (f === "incomer line trip") {
      S.faults.lineTrip = true;
      S.brk.tlnd = false;
      raise("TEINDLAND LINE");
      log("MAINTENANCE TEST - TEINDLAND LINE PROTECTION OPERATION", "trip");
    }
  }

  function serviceAction(act) {
    if (act === "gas-relay-reset") {
      if (S.brk.t1hv || S.brk.t1lv) {
        log("GAS RELAY RESET BLOCKED - TX1 STILL IN SERVICE", "warn");
        return;
      }
      if (!S.faults.gas && S.gasLevel <= 0) {
        log("GAS RELAY ALREADY RESET", "info");
        return;
      }
      S.faults.gas = false;
      S.gasLevel = 0;
      clearCond("TX1 GAS");
      log("GAS RELAY RESET - TX1 MAY BE RETURNED TO SERVICE", "info");
    } else if (act === "oltc-override") {
      if (!S.jamLatched) {
        log("OLTC OVERRIDE - NO JAM PRESENT", "info");
        return;
      }
      if (S.regMode === 1) {
        log("OLTC OVERRIDE BLOCKED - TAKE REGULATOR OUT OF AUTO FIRST", "warn");
        return;
      }
      S.jamLatched = false;
      S.faults.jam = false;
      clearCond("TX2 OLTC JAM");
      log("OLTC OVERRIDE ACCEPTED - TX2 DRIVE RESTORED", "info");
    }
  }

  function reset() {
    S = freshState();
    if (typeof document !== "undefined") {
      log("CORRIEDHU GSP - RTU 7 - REV C");
      log("RTU 7 SELF TEST OK");
      log("SCANNING 21 PRIMARY POINTS");
      log("COMMS LINK POLLED - MASTER RECEIVED");
      syncControlsFromModel();
    }
  }

  window.machine = {
    name: "Corriedhu Grid Supply Point",
    faults: FAULTS.slice(),
    state: stateSnapshot,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ---- panel wiring ----------------------------------------------------------- */

  if (typeof document === "undefined") return;

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  /* --- dial ticks, drawn once -------------------------------------------------- */

  $$("[data-dial]").forEach(function (dial) {
    var ticks = dial.querySelector(".dial-ticks");
    var face = dial.querySelector(".dial-face");
    var r = parseFloat(face.getAttribute("r"));
    for (var i = 0; i <= 10; i++) {
      var ang = ((-50 + i * 10) * Math.PI) / 180;
      var major = i % 2 === 0;
      var inner = major ? r - 8 : r - 5;
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", (Math.sin(ang) * inner).toFixed(2));
      line.setAttribute("y1", (-Math.cos(ang) * inner).toFixed(2));
      line.setAttribute("x2", (Math.sin(ang) * (r - 3)).toFixed(2));
      line.setAttribute("y2", (-Math.cos(ang) * (r - 3)).toFixed(2));
      if (major) line.setAttribute("class", "major");
      ticks.appendChild(line);
    }
  });

  function setNeedle(name, frac) {
    var el = document.querySelector('[data-needle="' + name + '"]');
    if (el)
      el.style.transform =
        "rotate(" + (-50 + 100 * clamp(frac, 0, 1.04)).toFixed(2) + "deg)";
  }

  /* --- control switches ---------------------------------------------------------- */

  function ctrlKey(el) {
    var c = el.getAttribute("data-control");
    if (c.indexOf("TEINDLAND") === 0) return "tlnd";
    if (c.indexOf("CAIRNBEATH") === 0) return "cbth";
    if (c.indexOf("TX1") === 0) return "t1pair";
    if (c.indexOf("TX2") === 0) return "t2pair";
    if (c.indexOf("BUS SECTION") >= 0) return "section";
    var m = c.match(/FEEDER (\d)/);
    if (m) return "f" + m[1];
    return "";
  }

  $$(".ctrl-switch").forEach(function (el) {
    var key = ctrlKey(el);
    function pulse(which, action) {
      el.classList.remove("pulse-close", "pulse-trip");
      void el.offsetWidth;
      el.classList.add(which);
      setTimeout(function () {
        el.classList.remove(which);
      }, 320);
      command(key, action);
      ensureAudio();
    }
    el.addEventListener("pointerdown", function () {
      pulse("pulse-close", "close");
    });
    el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      pulse("pulse-trip", "trip");
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        pulse("pulse-close", "close");
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        pulse("pulse-trip", "trip");
      }
    });
  });

  /* --- OLTC rockers ---------------------------------------------------------------- */

  $$(".oltc-rocker").forEach(function (el, idx) {
    var tx = idx === 0 ? 1 : 2;
    function bump(dir, which) {
      if (S.regMode !== 2) {
        log(
          S.regMode === 1
            ? "LOCAL TAP CONTROL REFUSED - REGULATOR IN AUTO"
            : "LOCAL TAP CONTROL REFUSED - REGULATOR ISOLATED",
          "warn",
        );
        return;
      }
      el.classList.remove("tilt-up", "tilt-down");
      void el.offsetWidth;
      el.classList.add(which);
      setTimeout(function () {
        el.classList.remove(which);
      }, 220);
      moveTap(tx, dir, "LOCAL");
      ensureAudio();
    }
    el.addEventListener("pointerdown", function (ev) {
      var rect = el.getBoundingClientRect();
      var isTop = ev.clientY - rect.top < rect.height / 2;
      bump(isTop ? 1 : -1, isTop ? "tilt-up" : "tilt-down");
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
        e.preventDefault();
        bump(1, "tilt-up");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        bump(-1, "tilt-down");
      }
    });
  });

  /* --- rotary selectors --------------------------------------------------------------- */

  function bindSelector(el, options, onChange) {
    var pos = parseInt(el.getAttribute("data-position") || "0", 10);
    function apply(p) {
      pos = ((p % options.length) + options.length) % options.length;
      el.setAttribute("data-position", String(pos));
      el.setAttribute("aria-valuetext", options[pos]);
      onChange(pos);
    }
    apply(pos);
    el.addEventListener("pointerdown", function () {
      apply(pos + 1);
      ensureAudio();
    });
    el.addEventListener("keydown", function (e) {
      if (
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp"
      ) {
        e.preventDefault();
        apply(pos + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        apply(pos - 1);
      }
    });
    return {
      set: apply,
      get: function () {
        return pos;
      },
    };
  }

  var regSel = bindSelector(
    $('[data-control="VOLTAGE REGULATOR SELECTOR"]'),
    ["OFF", "AUTO", "MAN"],
    function (p) {
      S.regMode = p;
      var names = ["OFF (DRIVE ISOLATED)", "AUTO", "MANUAL"];
      log("VOLTAGE REGULATOR SELECTED " + names[p]);
    },
  );

  bindSelector(
    $('[data-control="SYNCHRO-CHECK SELECTOR"]'),
    ["OFF", "ON"],
    function (p) {
      S.syncCheck = p === 1;
      log("SYNCHRO-CHECK SELECTED " + (p === 1 ? "ON" : "OFF"));
    },
  );

  /* --- telemetry key --------------------------------------------------------------------- */

  var telKey = $('[data-control="TELEMETRY ISOLATION KEY"]');
  telKey.classList.add("on");
  telKey.addEventListener("pointerdown", function () {
    S.telemetry = !S.telemetry;
    telKey.classList.toggle("on", S.telemetry);
    telKey.setAttribute("aria-pressed", String(S.telemetry));
    log(
      S.telemetry
        ? "TELEMETRY RESTORED - SCANNING"
        : "RTU ISOLATED FROM TELEMETRY",
      S.telemetry ? "info" : "warn",
    );
    ensureAudio();
  });

  /* --- annunciator buttons ------------------------------------------------------------------- */

  $('[data-act="accept"]').addEventListener("click", function () {
    var name;
    for (name in S.alarms) {
      if (S.alarms[name].on) S.alarms[name].acked = true;
    }
    S.hornSilenced = true;
    ensureAudio();
  });

  $('[data-act="alarm-reset"]').addEventListener("click", function () {
    var name;
    for (name in S.alarms) {
      if (!S.alarms[name].on) delete S.alarms[name];
    }
  });

  $('[data-act="silence"]').addEventListener("click", function () {
    S.hornSilenced = true;
    ensureAudio();
  });

  var lampBtn = $('[data-act="lamp-test"]');
  function lampTest(on) {
    S.lampTest = on;
  }
  lampBtn.addEventListener("pointerdown", function () {
    lampTest(true);
  });
  lampBtn.addEventListener("pointerup", function () {
    lampTest(false);
  });
  lampBtn.addEventListener("pointerleave", function () {
    lampTest(false);
  });
  lampBtn.addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      lampTest(true);
    }
  });
  lampBtn.addEventListener("keyup", function (e) {
    if (e.key === " " || e.key === "Enter") lampTest(false);
  });

  /* --- maintenance flap ------------------------------------------------------------------------ */

  var flapToggle = $("[data-flap-toggle]");
  var flapWell = $("#flap-well");
  var maintPlate = $('[data-control="FAULT TEST BUTTONS"]');
  maintPlate.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest(".fault-btn")) return;
    var nowOpen = flapWell.classList.contains("collapsed");
    flapWell.classList.toggle("collapsed", !nowOpen);
    flapToggle.setAttribute("aria-expanded", String(nowOpen));
  });

  $$(".fault-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var inj = btn.getAttribute("data-inject");
      var svc = btn.getAttribute("data-service");
      if (inj) inject(inj);
      else if (svc) serviceAction(svc);
      ensureAudio();
    });
  });

  /* --- header buttons ---------------------------------------------------------------------------- */

  $('[data-action="reset"]').addEventListener("click", function () {
    reset();
  });

  var dialog = $("dialog[data-manual]");
  $('[data-action="manual"]').addEventListener("click", function () {
    if (dialog && !dialog.open) dialog.showModal();
  });
  $('[data-action="close-manual"]').addEventListener("click", function () {
    if (dialog && dialog.open) dialog.close();
  });

  /* --- sound -------------------------------------------------------------------------------------- */

  var audio = null;
  var humGain = null;
  var hornGain = null;

  function ensureAudio() {
    if (audio) {
      if (audio.state === "suspended") audio.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audio = new AC();
      humGain = audio.createGain();
      humGain.gain.value = 0;
      humGain.connect(audio.destination);
      var hum = audio.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 100;
      hum.connect(humGain);
      hum.start();
      var hum2 = audio.createOscillator();
      hum2.type = "triangle";
      hum2.frequency.value = 50;
      var hum2g = audio.createGain();
      hum2g.gain.value = 0.35;
      hum2.connect(hum2g);
      hum2g.connect(humGain);
      hum2.start();

      hornGain = audio.createGain();
      hornGain.gain.value = 0;
      hornGain.connect(audio.destination);
      var horn = audio.createOscillator();
      horn.type = "square";
      horn.frequency.value = 640;
      horn.connect(hornGain);
      horn.start();
    } catch (e) {
      audio = null;
    }
  }

  document.addEventListener("pointerdown", ensureAudio);
  document.addEventListener("keydown", ensureAudio);

  var hornClock = 0;

  function driveSound(dt) {
    if (!audio) return;
    var units = 0;
    if (S.brk.t1hv && S.kv132 > 100) units++;
    if (S.brk.t2hv && S.kv132 > 100) units++;
    humGain.gain.value = units * 0.012;
    var unacked = false;
    var name;
    for (name in S.alarms) {
      if (S.alarms[name].on && !S.alarms[name].acked) unacked = true;
    }
    hornClock = (hornClock + dt) % 0.9;
    hornGain.gain.value =
      unacked && !S.hornSilenced && hornClock < 0.45 ? 0.018 : 0;
  }

  /* --- rendering ------------------------------------------------------------------------------------ */

  function rememberBase(el) {
    if (!el.getAttribute("data-base")) {
      el.setAttribute("data-base", el.getAttribute("class") || "");
    }
  }

  function svgOn(el, cls, on) {
    var keep = (el.getAttribute("data-base") || "")
      .split(/\s+/)
      .filter(Boolean);
    var idx = keep.indexOf(cls);
    if (on && idx < 0) keep.push(cls);
    if (!on && idx >= 0) keep.splice(idx, 1);
    el.setAttribute("class", keep.join(" "));
  }

  function energisation() {
    var b = S.brk;
    var lineLive = true;
    var e132 = S.kv132 > 100;
    var t1mid = e132 && b.t1hv;
    var t2mid = e132 && b.t2hv;
    var t1out = t1mid && b.t1lv;
    var t2out = t2mid && b.t2lv;
    var busA = t1out;
    var busB = t2out;
    if (b.section) {
      busA = busA || busB;
      busB = busA;
    }
    var secWire = b.section && (t1out || t2out);
    return {
      "tlnd-top": lineLive,
      "tlnd-bot": lineLive && b.tlnd,
      "cbth-top": lineLive,
      "cbth-bot": lineLive && b.cbth,
      pt132: e132,
      pt132b: e132,
      e132: e132,
      t1a: e132,
      t1b: t1mid,
      t1c: t1mid,
      t1d: t1out,
      t2a: e132,
      t2b: t2mid,
      t2c: t2mid,
      t2d: t2out,
      ct1: t1out,
      ct2: t2out,
      seca: secWire || busA,
      secb: secWire || busB,
      busA: busA,
      busB: busB,
      t1mid: t1mid,
      t2mid: t2mid,
      f1a: busA,
      f1b: busA && b.f1,
      f2a: busA,
      f2b: busA && b.f2,
      f3a: busA,
      f3b: busA && b.f3,
      f4a: busB,
      f4b: busB && b.f4,
      f5a: busB,
      f5b: busB && b.f5,
      f6a: busB,
      f6b: busB && b.f6,
    };
  }

  var LED_MAP = {
    tlnd: "tlnd",
    cbth: "cbth",
    t1hv: "t1hv",
    t1lv: "t1lv",
    t2hv: "t2hv",
    t2lv: "t2lv",
    section: "section",
    f1: "f1",
    f2: "f2",
    f3: "f3",
    f4: "f4",
    f5: "f5",
    f6: "f6",
  };

  function ledVoltage(id, st) {
    switch (id) {
      case "tlnd":
      case "cbth":
        return true;
      case "t1hv":
      case "t2hv":
        return st.e132;
      case "t1lv":
        return st.t1mid;
      case "t2lv":
        return st.t2mid;
      case "section":
        return st.busA || st.busB;
      default:
        return st[id.slice(0, 2) + "a"] === true;
    }
  }

  function fmtKv(kv) {
    return kv > 0.5 ? kv.toFixed(1) + " kV" : "DEAD";
  }

  function fmtTap(v) {
    return "TAP " + (v > 0 ? "+" : "") + v;
  }

  function ampsOf(mva) {
    return mva > 0.05 ? (mva * 1000) / (1.732 * 33) : 0;
  }

  function setText(sel, txt) {
    var el = document.querySelector(sel);
    if (el && el.textContent !== txt) el.textContent = txt;
  }

  var lastDt = 0.016;

  function render() {
    var st = energisation();
    var b = S.brk;

    $$(".mimic [data-wire]").forEach(function (w) {
      svgOn(w, "live", st[w.getAttribute("data-wire")] === true);
    });
    [
      ["e132", st.e132],
      ["busA", st.busA],
      ["busB", st.busB],
    ].forEach(function (pr) {
      var bar = document.querySelector('[data-bus="' + pr[0] + '"]');
      if (bar) svgOn(bar, "live", pr[1]);
    });

    Object.keys(b).forEach(function (key) {
      var sq = document.querySelector('[data-brk="' + key + '"]');
      if (sq) svgOn(sq, "closed", b[key]);
    });

    $$(".node-led").forEach(function (led) {
      var id = led.getAttribute("data-led");
      var closed = b[LED_MAP[id]];
      var adj = ledVoltage(id, st);
      led.setAttribute(
        "class",
        "node-led " + (closed && adj ? "red" : adj ? "green" : ""),
      );
    });

    setText("[data-val='kv132txt']", fmtKv(S.kv132));
    setText("[data-val='kvaTxt']", fmtKv(S.busApv * 33));
    setText("[data-val='kvbTxt']", fmtKv(S.busBpv * 33));
    setText("[data-val='t1mvatxt']", S.tx1Mva.toFixed(1) + "\u00a0MVA");
    setText("[data-val='t2mvatxt']", S.tx2Mva.toFixed(1) + "\u00a0MVA");
    setText("[data-val='t1taptxt']", fmtTap(S.tap1));
    setText("[data-val='t2taptxt']", fmtTap(S.tap2));
    setText("[data-val='t1temptxt']", Math.round(S.tx1Wdg) + "\u00b0C");
    setText("[data-val='t2temptxt']", Math.round(S.tx2Wdg) + "\u00b0C");

    setNeedle("v132", S.kv132 / 165);
    setNeedle("a1", ampsOf(S.tx1Mva) / 1300);
    setNeedle("a2", ampsOf(S.tx2Mva) / 1300);

    var rotor = document.querySelector("[data-sync-rotor]");
    var scopeActive = S.kv132 > 100 && (S.busApv > 0.45 || S.busBpv > 0.45);
    if (rotor) {
      rotor.style.transform =
        "rotate(" + (scopeActive ? S.syncAngle.toFixed(1) : 0) + "deg)";
      rotor.style.opacity = scopeActive ? "1" : "0.25";
    }

    $$(".ann-window").forEach(function (win) {
      var name = win.getAttribute("data-ann");
      var entry = S.alarms[name];
      win.classList.remove("flash", "steady");
      if (S.lampTest) {
        win.classList.add("steady");
        return;
      }
      if (!entry) return;
      if (entry.on && !entry.acked) win.classList.add("flash");
      else win.classList.add("steady");
    });

    $$("[data-deskled]").forEach(function (led) {
      var key = led.getAttribute("data-deskled").split(".")[1];
      led.setAttribute("class", "led " + (b[key] ? "led-red" : "led-green"));
    });

    var blink = Math.floor(S.t / 1.5) % 2 === 0;
    var scan = document.querySelector('[data-led="scan"]');
    var comms = document.querySelector('[data-led="comms"]');
    if (scan)
      scan.setAttribute(
        "class",
        "led " + (S.telemetry && blink ? "led-green" : ""),
      );
    if (comms)
      comms.setAttribute(
        "class",
        "led " + (S.telemetry && !blink ? "led-green" : ""),
      );

    setText('[data-readout="clock"]', clockStr(S.t));
    setText('[data-readout="freq"]', S.freq.toFixed(2));
    setText('[data-readout="demand"]', S.demandMw.toFixed(1));

    driveSound(lastDt);
  }

  /* --- control synchronisation after reset ------------------------------------------------ */

  function syncControlsFromModel() {
    regSel.set(0);
    $('[data-control="SYNCHRO-CHECK SELECTOR"]').setAttribute(
      "data-position",
      "0",
    );
    telKey.classList.add("on");
    telKey.setAttribute("aria-pressed", "true");
    $$(".ann-window").forEach(function (win) {
      win.classList.remove("flash", "steady");
    });
    var box = $("[data-crt]");
    if (box) box.textContent = "";
  }

  /* --- main loop ------------------------------------------------------------------------------ */

  var lastFrame = performance.now();

  function loop(now) {
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0 && dt < 1.5 && !document.hidden) {
      lastDt = dt;
      tick(dt);
    }
    render();
    requestAnimationFrame(loop);
  }

  $$(".conductor, .busbar, .breaker").forEach(rememberBase);
  BOOTED = true;
  log("CORRIEDHU GSP - RTU 7 - REV C");
  log("RTU 7 SELF TEST OK");
  log("SCANNING 21 PRIMARY POINTS");
  log("COMMS LINK POLLED - MASTER RECEIVED");
  syncControlsFromModel();
  requestAnimationFrame(loop);
})();
