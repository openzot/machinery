/* Wrenford Vale Radio - Studio B Continuity Desk (Type CB/2)
   Behaviour: programme chain simulation, silence sensing, transmitter remote.
   Aveling Broadcast Installations commissioning code, September 1983. */
(function () {
  "use strict";

  var NAME = "Wrenford Vale Radio - Studio B Continuity Desk";
  var FAULTS = ["cart jam", "network line loss", "transmitter overload"];

  /* ---------------- constants ---------------- */

  var STEP = 0.05; /* fixed integration step, seconds */
  var SILENCE_LIMIT = 12; /* seconds of dead air before SILENCE */
  var SILENCE_TRIP = 30; /* seconds of dead air before the transmitter drops */
  var BUS_FLOOR = 0.045; /* linear programme floor for "silent" */
  var ALARMS = [
    "SILENCE",
    "NET FAIL",
    "CART JAM",
    "PA TEMP",
    "TX TRIP",
    "OFF AIR",
  ];

  var CARTS = [
    { name: "OPEN THEME", dur: 28, lvl: 0.72 },
    { name: "NEWS IN", dur: 6, lvl: 0.62 },
    { name: "WEATHER", dur: 12, lvl: 0.6 },
    { name: "IDENT B", dur: 5, lvl: 0.66 },
    { name: "DOC SPOT", dur: 45, lvl: 0.58 },
    { name: "CLOSE SIG", dur: 20, lvl: 0.7 },
  ];

  /* VU scale anchors: [dB, needle degrees from vertical] */
  var VU_ANCHORS = [
    [-20, -44],
    [-10, -31],
    [-5, -22],
    [-3, -15],
    [-2, -13],
    [-1, -7],
    [0, -2],
    [1, 9],
    [2, 19],
    [3, 29],
  ];

  /* ---------------- state ---------------- */

  var S;

  function freshState() {
    return {
      t: 0,
      mains: true /* standby: the desk is powered, nothing local on air */,
      monitor: 0 /* 0 audition, 1 air, 2 cue */,
      netSel: 0 /* 0 main line, 1 standby feed, 2 off */,
      faders: {
        cart: 0,
        network: 7,
        mic: 0,
      } /* network rides the overnight line */,
      micKey: false,
      micGuardOpen: false,
      selCart: 0,
      deck: { running: -1, pos: 0, jam: false, eomT: 0 },
      jamArmed: false,
      netDown: false,
      netRepairAt: Infinity,
      delayArmed: false,
      delaySec: 0,
      toneHeld: false,
      lampsTest: false,
      accepted: {},
      /* continuous quantities */
      netLvl: 0,
      cartLvl: 0,
      micLvl: 0,
      busLin: 0,
      busDb: -80,
      vuAng: -44,
      peak: false,
      silTimer: 0,
      hubAng: 0,
      /* transmitter */
      txSp: 4 /* power setpoint, kW - carrier is up overnight */,
      fwd: 4,
      refl: 0,
      vswr: 1.06,
      temp: 52,
      ovlArmed: false,
      ovlUntil: Infinity,
      foldback: false,
      foldT: 0,
      trip: false,
      offAir: false,
      prevAlarms: {},
    };
  }

  S = freshState();

  /* ---------------- helpers ---------------- */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function wobble(t, f, p) {
    return Math.sin(t * f + p);
  }

  function gain(f) {
    var u = clamp(f, 0, 10) / 10;
    return Math.pow(u, 1.8);
  }

  function vuAngle(db) {
    if (db <= VU_ANCHORS[0][0]) return VU_ANCHORS[0][1];
    for (var i = 1; i < VU_ANCHORS.length; i++) {
      if (db <= VU_ANCHORS[i][0]) {
        var a = VU_ANCHORS[i - 1],
          b = VU_ANCHORS[i];
        var u = (db - a[0]) / (b[0] - a[0]);
        return a[1] + u * (b[1] - a[1]);
      }
    }
    return 33;
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function clockString(t) {
    var s = Math.floor(6 * 3600 + 57 * 60 + 30 + t) % 86400;
    var hh = Math.floor(s / 3600),
      mm = Math.floor((s % 3600) / 60),
      ss = s % 60;
    return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
  }

  function clockHands(t) {
    var s = (6 * 3600 + 57 * 60 + 30 + t) % 43200; /* 12 h dial */
    return {
      sec: (s % 60) * 6,
      min: ((s % 3600) / 60) * 6,
      hour: (s / 3600) * 30,
    };
  }

  /* ---------------- alarm bookkeeping ---------------- */

  function activeConditions() {
    var conds = {};
    conds["NET FAIL"] = S.netSel !== 2 && S.netLvl < 0.02;
    conds["CART JAM"] = S.deck.jam;
    conds["SILENCE"] = S.txSp > 0 && !S.trip && S.silTimer >= SILENCE_LIMIT;
    conds["PA TEMP"] = S.refl > 260 || S.temp > 82;
    conds["TX TRIP"] = S.trip;
    conds["OFF AIR"] = S.offAir;
    return conds;
  }

  function alarmsList() {
    var conds = activeConditions(),
      out = [];
    for (var i = 0; i < ALARMS.length; i++)
      if (conds[ALARMS[i]]) out.push(ALARMS[i]);
    return out;
  }

  /* ---------------- one integration step ---------------- */

  function step(h) {
    S.t += h;

    /* --- sources --- */

    var netBase;
    if (S.netSel === 0) {
      netBase = S.netDown
        ? 0
        : 0.62 +
          0.14 * wobble(S.t, 0.31, 0) +
          0.09 * wobble(S.t, 1.7, 1.3) +
          0.05 * wobble(S.t, 4.2, 0.7);
    } else if (S.netSel === 1) {
      netBase =
        0.54 + 0.11 * wobble(S.t, 0.27, 2.1) + 0.08 * wobble(S.t, 2.3, 0.4);
    } else {
      netBase = 0;
    }
    S.netLvl = clamp(netBase, 0, 1);

    if (S.netDown && S.t >= S.netRepairAt) S.netDown = false;

    var deck = S.deck;
    if (deck.running >= 0) {
      var c = CARTS[deck.running];
      if (!deck.jam) {
        deck.pos += h;
        if (deck.pos >= c.dur) {
          deck.running = -1;
          deck.pos = 0;
          deck.eomT = S.t + 1.4;
        }
      }
      S.cartLvl = deck.jam
        ? 0
        : c.lvl *
          clamp(deck.pos / 0.4, 0, 1) *
          clamp((c.dur - deck.pos) / 0.6, 0, 1);
    } else {
      S.cartLvl = 0;
    }
    if (deck.eomT && S.t > deck.eomT) deck.eomT = 0;

    S.micLvl =
      S.micKey && S.mains
        ? clamp(
            0.46 + 0.16 * wobble(S.t, 0.5, 0.9) + 0.12 * wobble(S.t, 1.9, 2.2),
            0.06,
            0.9,
          )
        : 0;

    /* --- programme bus --- */

    var lin = 0;
    if (S.mains) {
      lin =
        S.netLvl * gain(S.faders.network) +
        S.cartLvl * gain(S.faders.cart) +
        S.micLvl * gain(S.faders.mic) +
        (S.toneHeld ? 0.7 : 0);
    }
    S.busLin = lin;
    S.busDb = clamp(20 * Math.log10(Math.max(lin, 0.0001)), -80, 6);

    var target = vuAngle(S.busDb);
    var tau = target > S.vuAng ? 0.07 : 0.26;
    S.vuAng += (target - S.vuAng) * (1 - Math.exp(-h / tau));
    S.peak = S.busDb > 1.5;

    /* --- silence sensor --- */

    var silent = S.txSp > 0 && !S.trip && lin < BUS_FLOOR;
    S.silTimer = silent ? S.silTimer + h : 0;
    if (silent && S.silTimer >= SILENCE_TRIP && !S.trip) tripTx();

    /* --- profanity delay --- */

    if (S.delayArmed) S.delaySec += (8 - S.delaySec) * clamp(h / 1.2, 0, 1);

    /* --- transmitter --- */

    var vswrTarget = S.ovlArmed ? 3.2 : 1.06 + 0.02 * wobble(S.t, 0.9, 0);
    S.vswr += (vswrTarget - S.vswr) * clamp(h / 2.2, 0, 1);
    if (S.ovlArmed && S.t >= S.ovlUntil) S.ovlArmed = false;

    var fwdTarget = 0;
    if (!S.trip && S.txSp > 0)
      fwdTarget = S.foldback ? Math.min(S.txSp, 1.6) : S.txSp;
    S.fwd += (fwdTarget - S.fwd) * clamp(h / 0.7, 0, 1);

    var coef = (S.vswr - 1) / (S.vswr + 1);
    S.refl = clamp(S.fwd * coef * coef * 1000, 0, 1200);

    var heat = S.refl * 0.0022 + Math.max(0, S.fwd - 3.6) * 1.2 + 0.35;
    var cool = 0.032 * (S.temp - 22);
    S.temp = clamp(S.temp + (heat - cool) * h, 22, 140);

    if (!S.foldback && S.temp > 88) {
      S.foldT += h;
      if (S.foldT >= 6) {
        S.foldback = true;
      }
    } else if (S.foldback) {
      if (S.temp < 74) {
        S.foldback = false;
        S.foldT = 0;
      }
    } else {
      S.foldT = 0;
    }

    if (!S.trip && S.temp >= 92) tripTx();

    /* --- edge-triggered alarm chirp --- */

    var conds = activeConditions();
    for (var i = 0; i < ALARMS.length; i++) {
      var a = ALARMS[i];
      if (conds[a] && !S.prevAlarms[a]) fx.chirp();
      if (!conds[a]) delete S.accepted[a];
      S.prevAlarms[a] = conds[a];
    }
  }

  function tripTx() {
    S.trip = true;
    S.offAir = true;
  }

  /* ---------------- public API ---------------- */

  function state() {
    var deck = S.deck;
    return {
      simTime: S.t,
      clock: clockString(S.t),
      mains: S.mains,
      monitorPos: S.monitor,
      networkPos: S.netSel,
      selectedCart: S.selCart + 1,
      deck: { running: deck.running + 1, position: deck.pos, jammed: deck.jam },
      carts: CARTS.map(function (c, i) {
        return {
          n: i + 1,
          name: c.name,
          duration: c.dur,
          state:
            deck.running === i ? (deck.jam ? "stalled" : "running") : "idle",
          position: deck.running === i ? deck.pos : 0,
        };
      }),
      faders: {
        cart: S.faders.cart,
        network: S.faders.network,
        mic: S.faders.mic,
      },
      micKey: S.micKey,
      levels: {
        network: S.netLvl,
        cart: S.cartLvl,
        mic: S.micLvl,
        busLinear: S.busLin,
        busDb: S.busDb,
        vuAngle: S.vuAng,
      },
      silenceTimer: S.silTimer,
      delaySeconds: S.delaySec,
      delayArmed: S.delayArmed,
      tx: {
        setpointKw: S.txSp,
        forwardKw: S.fwd,
        reflectedW: S.refl,
        vswr: S.vswr,
        paTempC: S.temp,
        foldback: S.foldback,
        tripped: S.trip,
        offAir: S.offAir,
      },
      alarms: alarmsList(),
    };
  }

  var tickAcc = 0;

  function tick(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0)
      return;
    tickAcc += Math.min(seconds, 600);
    var guard = 0;
    while (tickAcc >= STEP && guard < 4800) {
      step(STEP);
      tickAcc -= STEP;
      guard++;
    }
  }

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (f === "cart jam") {
      S.jamArmed = true;
      S.deck.sel = S.selCart;
      S.deck.running = S.selCart;
      S.deck.pos = Math.min(S.deck.pos, 0.2);
      S.deck.jam = true;
    } else if (f === "network line loss") {
      S.netDown = true;
      S.netRepairAt = S.t + 150;
    } else if (f === "transmitter overload") {
      S.ovlArmed = true;
      S.ovlUntil = S.t + 180;
    }
  }

  function reset() {
    var keepFx = true;
    S = freshState();
    S.prevAlarms = {};
    tickAcc = 0;
    syncAllInputs();
    return keepFx;
  }

  /* ---------------- audio (gesture-gated) ---------------- */

  var fx = (function () {
    var ctx = null,
      ready = false;
    function boot() {
      if (ready) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        ready = true;
      } catch (e) {
        ctx = null;
      }
    }
    function blip(freq, dur, type, vol, when) {
      if (!ready) return;
      try {
        var o = ctx.createOscillator(),
          g = ctx.createGain(),
          t0 = ctx.currentTime + (when || 0);
        o.type = type || "square";
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol || 0.08, t0);
        g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + dur + 0.02);
      } catch (e) {
        /* silent */
      }
    }
    document.addEventListener("pointerdown", boot, { passive: true });
    document.addEventListener("keydown", boot);
    return {
      click: function () {
        blip(1900, 0.03, "square", 0.05);
        blip(240, 0.05, "triangle", 0.09, 0.01);
      },
      chirp: function () {
        blip(880, 0.16, "square", 0.07);
        blip(660, 0.2, "square", 0.07, 0.19);
      },
      thunk: function () {
        blip(140, 0.09, "triangle", 0.1);
      },
      tone: null,
    };
  })();

  /* ---------------- DOM wiring ---------------- */

  function $(s) {
    return document.querySelector(s);
  }
  function $all(s) {
    return Array.prototype.slice.call(document.querySelectorAll(s));
  }

  var R = {}; /* rendered element cache */
  $all("[data-ro]").forEach(function (el) {
    R[el.getAttribute("data-ro")] = el;
  });
  var annEls = {};
  $all("[data-alarm]").forEach(function (el) {
    annEls[el.getAttribute("data-alarm")] = el;
  });
  var hubEls = $all("[data-hub]");
  var bayEls = $all("[data-bay]");

  /* --- toggles --- */

  var inMains = $("#ctl-mains");
  var inMic = $("#ctl-mic");
  var inDelayArm = $("#ctl-delayarm");

  function syncAllInputs() {
    inMains.checked = S.mains;
    inMic.checked = false;
    inMic.disabled = !S.micGuardOpen;
    inDelayArm.checked = false;
    setFader("cart", 0);
    setFader("network", 7);
    setFader("mic", 0);
    setRotary(rotNet, 0);
    setRotary(rotMon, 0);
    setRotary(rotCart, 0);
  }

  inMains.addEventListener("change", function () {
    S.mains = inMains.checked;
    fx.click();
    if (!S.mains) {
      S.micKey = false;
      inMic.checked = false;
    }
  });

  inMic.addEventListener("change", function () {
    S.micKey = inMic.checked && S.mains;
    fx.click();
  });

  inDelayArm.addEventListener("change", function () {
    S.delayArmed = inDelayArm.checked;
    fx.click();
  });

  /* --- guarded cover --- */

  var guardEl = R.micGuard;
  function guardToggle() {
    S.micGuardOpen = !S.micGuardOpen;
    guardEl.classList.toggle("open", S.micGuardOpen);
    guardEl.setAttribute("aria-expanded", String(S.micGuardOpen));
    inMic.disabled = !S.micGuardOpen;
    fx.click();
  }
  guardEl.addEventListener("click", guardToggle);
  guardEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      guardToggle();
    }
  });

  /* --- maintenance lid --- */

  var lidEl = R.maintLid;
  function lidToggle() {
    var open = lidEl.classList.toggle("open");
    lidEl.setAttribute("aria-expanded", String(open));
  }
  lidEl.addEventListener("click", lidToggle);
  lidEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      lidToggle();
    }
  });

  /* --- rotary selectors --- */

  var POS_MON = ["Audition", "AIR", "CUE"];
  var POS_NET = ["Main line", "Standby feed", "Off"];
  var ANG_MON = [-56, 0, 56];
  var ANG_NET = [-56, 0, 56];
  var ANG_CART = [-75, -45, -15, 15, 45, 75];

  function makeRotary(el, labels, angles) {
    return {
      el: el,
      labels: labels,
      angles: angles,
      pos: 0,
      apply: function () {
        el.style.setProperty("--ang", angles[this.pos] + "deg");
        el.setAttribute("aria-valuenow", String(this.pos));
        el.setAttribute("aria-valuetext", labels[this.pos]);
      },
    };
  }

  function setRotary(r, p) {
    r.pos = clamp(p, 0, r.labels.length - 1);
    r.apply();
  }

  var rotMon = makeRotary(
    $('[data-control="MONITOR SELECTOR"]'),
    POS_MON,
    ANG_MON,
  );
  var rotNet = makeRotary(
    $('[data-control="NETWORK SELECTOR"]'),
    POS_NET,
    ANG_NET,
  );
  var rotCart = makeRotary(
    $('[data-control="CARTRIDGE SELECTOR"]'),
    [
      "Cartridge 1",
      "Cartridge 2",
      "Cartridge 3",
      "Cartridge 4",
      "Cartridge 5",
      "Cartridge 6",
    ],
    ANG_CART,
  );

  function rotaryStep(r, dir) {
    setRotary(r, (r.pos + dir + r.labels.length) % r.labels.length);
    fx.click();
    if (r === rotCart) selectBay(r.pos);
    else if (r === rotMon) S.monitor = r.pos;
    else if (r === rotNet) S.netSel = r.pos;
  }

  [rotMon, rotNet, rotCart].forEach(function (r) {
    r.el.addEventListener("click", function () {
      rotaryStep(r, 1);
    });
    r.el.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        rotaryStep(r, 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        rotaryStep(r, -1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setRotary(r, 0);
      } else if (e.key === "End") {
        e.preventDefault();
        setRotary(r, r.labels.length - 1);
      }
    });
  });

  rotNet.apply();
  rotMon.apply();
  rotCart.apply();

  /* --- cart bays --- */

  function selectBay(i) {
    S.selCart = clamp(i, 0, 5);
    bayEls.forEach(function (b, j) {
      b.setAttribute("aria-current", j === S.selCart ? "true" : "false");
    });
    setRotary(rotCart, S.selCart);
    R.selNum.textContent = String(S.selCart + 1);
  }

  bayEls.forEach(function (b) {
    b.addEventListener("click", function () {
      selectBay(Number(b.getAttribute("data-bay")));
      fx.click();
    });
  });
  selectBay(0);

  /* --- transport --- */

  $('[data-control="CART START"]').addEventListener("click", function () {
    if (!S.mains || S.deck.running >= 0) return;
    S.deck.running = S.selCart;
    S.deck.pos = 0;
    S.deck.jam = false;
    S.jamArmed = false;
    fx.click();
  });

  $('[data-control="CART STOP CUE"]').addEventListener("click", function () {
    S.deck.running = -1;
    S.deck.pos = 0;
    S.deck.jam = false;
    S.jamArmed = false;
    fx.thunk();
  });

  /* --- faders --- */

  var faders = {};
  $all("[data-fader]").forEach(function (el) {
    var id = el.getAttribute("data-fader");
    faders[id] = {
      el: el,
      handle: el.querySelector(".fhandle"),
      slot: el.querySelector(".fslot"),
      val: 0,
      drag: false,
    };
    applyFader(id);

    el.addEventListener("pointerdown", function (e) {
      var f = faders[id];
      f.drag = true;
      el.setPointerCapture(e.pointerId);
      faderFromPoint(id, e.clientX, e.clientY);
    });
    el.addEventListener("pointermove", function (e) {
      if (faders[id].drag) faderFromPoint(id, e.clientX, e.clientY);
    });
    el.addEventListener("pointerup", function () {
      faders[id].drag = false;
    });
    el.addEventListener("pointercancel", function () {
      faders[id].drag = false;
    });

    el.addEventListener("keydown", function (e) {
      var f = faders[id],
        v = f.val,
        handled = true;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") v += 0.5;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") v -= 0.5;
      else if (e.key === "PageUp") v += 2;
      else if (e.key === "PageDown") v -= 2;
      else if (e.key === "Home") v = 0;
      else if (e.key === "End") v = 10;
      else handled = false;
      if (handled) {
        e.preventDefault();
        setFader(id, v);
      }
    });
  });

  function faderFromPoint(id, cx, cy) {
    var r = faders[id].slot.getBoundingClientRect();
    var v;
    if (r.height >= r.width) v = (1 - (cy - r.top) / r.height) * 10;
    else v = ((cx - r.left) / r.width) * 10;
    setFader(id, v);
  }

  function setFader(id, v) {
    var f = faders[id];
    f.val = clamp(Math.round(v * 10) / 10, 0, 10);
    S.faders[id] = f.val;
    applyFader(id);
  }

  function applyFader(id) {
    var f = faders[id];
    if (!f) return;
    var pct = (f.val / 10) * 100;
    var r = f.slot.getBoundingClientRect();
    if (r.height && r.width && r.height >= r.width) {
      f.handle.style.left = "50%";
      f.handle.style.bottom = "calc(" + pct + "% - 7px)";
      f.handle.style.marginLeft = "-23px";
      f.handle.style.marginTop = "0";
    } else {
      f.handle.style.bottom = "auto";
      f.handle.style.left = pct + "%";
      f.handle.style.marginTop = "-23px";
      f.handle.style.marginLeft = "-10px";
    }
    f.el.setAttribute("aria-valuenow", f.val.toFixed(1));
  }

  /* --- delay dump --- */

  $('[data-control="DELAY DUMP"]').addEventListener("click", function () {
    S.delaySec = 0;
    fx.thunk();
  });

  /* --- transmitter keys --- */

  $('[data-control="TX RAISE"]').addEventListener("click", function () {
    if (S.trip) return;
    S.txSp = clamp(S.txSp + 0.25, 0, 5);
    fx.click();
  });

  $('[data-control="TX LOWER"]').addEventListener("click", function () {
    S.txSp = clamp(S.txSp - 0.25, 0, 5);
    fx.click();
  });

  $('[data-control="TX RESET"]').addEventListener("click", function () {
    if (S.trip && S.temp < 82 && S.refl < 240) {
      S.trip = false;
      S.offAir = false;
      S.silTimer = 0;
      fx.thunk();
    }
  });

  /* --- alarm rail --- */

  $('[data-control="ALARM ACCEPT"]').addEventListener("click", function () {
    var conds = activeConditions();
    for (var i = 0; i < ALARMS.length; i++)
      if (conds[ALARMS[i]]) S.accepted[ALARMS[i]] = true;
    fx.click();
  });

  var lampsBtn = $('[data-control="LAMPS TEST"]');
  function lamps(on) {
    S.lampsTest = on;
  }
  lampsBtn.addEventListener("pointerdown", function () {
    lamps(true);
  });
  lampsBtn.addEventListener("pointerup", function () {
    lamps(false);
  });
  lampsBtn.addEventListener("pointerleave", function () {
    lamps(false);
  });
  lampsBtn.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
      e.preventDefault();
      lamps(true);
    }
  });
  lampsBtn.addEventListener("keyup", function (e) {
    if (e.key === "Enter" || e.key === " ") lamps(false);
  });

  /* --- maintenance keys --- */

  $('[data-control="TEST CART JAM"]').addEventListener("click", function () {
    inject("cart jam");
    fx.click();
  });
  $('[data-control="TEST NETWORK LOSS"]').addEventListener(
    "click",
    function () {
      inject("network line loss");
      fx.click();
    },
  );
  $('[data-control="TEST TX OVERLOAD"]').addEventListener("click", function () {
    inject("transmitter overload");
    fx.click();
  });

  var toneBtn = $('[data-control="TEST TONE"]');
  function tone(on) {
    S.toneHeld = on && S.mains;
  }
  toneBtn.addEventListener("pointerdown", function () {
    tone(true);
  });
  toneBtn.addEventListener("pointerup", function () {
    tone(false);
  });
  toneBtn.addEventListener("pointerleave", function () {
    tone(false);
  });
  toneBtn.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
      e.preventDefault();
      tone(true);
    }
  });
  toneBtn.addEventListener("keyup", function (e) {
    if (e.key === "Enter" || e.key === " ") tone(false);
  });

  var resetKeyBtn = $('[data-control="CONSOLE RESET"]');
  resetKeyBtn.addEventListener("click", function () {
    R.keyBarrel.parentElement.classList.add("turn");
    setTimeout(function () {
      R.keyBarrel.parentElement.classList.remove("turn");
    }, 350);
    reset();
    fx.thunk();
  });

  /* --- manual dialog --- */

  var dlg = $("dialog[data-manual]");
  $('[data-action="manual"]').addEventListener("click", function () {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  });
  $('[data-action="close-manual"]').addEventListener("click", function () {
    dlg.close ? dlg.close() : dlg.removeAttribute("open");
  });

  /* ---------------- rendering ---------------- */

  function setNeedle(el, ang, cx, cy) {
    el.setAttribute(
      "transform",
      "rotate(" + ang.toFixed(2) + " " + cx + " " + cy + ")",
    );
  }

  function render() {
    var st = S;

    /* masthead */
    var hands = clockHands(st.t);
    R.handHour.setAttribute("transform", "rotate(" + hands.hour + " 60 60)");
    R.handMin.setAttribute("transform", "rotate(" + hands.min + " 60 60)");
    R.handSec.setAttribute("transform", "rotate(" + hands.sec + " 60 60)");
    var dstr = clockString(st.t);
    R.datestrip.textContent = "SAT 24 SEP " + dstr.slice(0, 5);
    R.onAirLight.classList.toggle(
      "lit",
      st.mains && st.busLin > 0.05 && st.txSp > 0 && !st.trip,
    );
    R.offAirLight.classList.toggle("lit", st.offAir);

    /* cart deck */
    var deck = st.deck;
    if (deck.running >= 0 && !deck.jam) S.hubAng += 4;
    var spinClass = deck.running >= 0 && !deck.jam ? "hub spin" : "hub";
    hubEls.forEach(function (hub) {
      hub.className = spinClass;
      var idx = Number(hub.getAttribute("data-hub").split("")[0]);
      var dir = hub.getAttribute("data-hub").charAt(1) === "a" ? 1 : -1;
      hub.style.transform = "rotate(" + (S.hubAng * dir + idx * 40) + "deg)";
    });
    R.deckState.textContent = deck.jam
      ? "STALLED"
      : deck.eomT
        ? "EOM"
        : deck.running >= 0
          ? "RUNNING"
          : "READY";
    R.deckRemain.textContent =
      deck.running >= 0
        ? Math.max(0, CARTS[deck.running].dur - deck.pos).toFixed(1)
        : "--.-";
    R.cartStartBar.classList.toggle("lit", deck.running >= 0 && !deck.jam);

    /* sources */
    R.netOk.classList.toggle("on", st.netSel !== 2 && st.netLvl > 0.02);
    R.netBar.style.width = Math.round(clamp(st.netLvl, 0, 1) * 100) + "%";
    R.micLive.classList.toggle("on", st.micLvl > 0.05);

    /* meters */
    setNeedle(R.needle, clamp(st.vuAng, -46, 33), 230, 320);
    R.busDb.textContent = st.busDb <= -79 ? "\u221260.0" : st.busDb.toFixed(1);
    R.peakLamp.classList.toggle("on", st.peak);

    /* delay + silence */
    R.delaySec.textContent = st.delaySec.toFixed(1);
    R.delayFill.style.width = (st.delaySec / 8) * 100 + "%";
    R.silTimer.textContent = st.silTimer.toFixed(1);
    R.silBar.style.width = clamp(st.silTimer / SILENCE_LIMIT, 0, 1) * 100 + "%";

    /* transmitter */
    setNeedle(R.needleFwd, -50 + clamp(st.fwd / 5, 0, 1.06) * 100, 110, 150);
    setNeedle(
      R.needleRefl,
      -50 + clamp(st.refl / 500, 0, 1.06) * 100,
      110,
      150,
    );
    R.fwdKw.textContent = st.fwd.toFixed(2);
    R.reflW.textContent = String(Math.round(st.refl));
    R.tempFill.style.height = clamp((st.temp - 20) / 100, 0, 1) * 100 + "%";
    R.txReady.classList.toggle("on", st.txSp > 0 && !st.trip && !st.foldback);
    R.txFold.classList.toggle("on", st.foldback);
    R.txTripLamp.classList.toggle("on", st.trip);

    /* annunciators */
    var conds = activeConditions();
    for (var i = 0; i < ALARMS.length; i++) {
      var a = ALARMS[i],
        el = annEls[a];
      if (!el) continue;
      el.className = "ann";
      if (conds[a]) el.classList.add(st.accepted[a] ? "steady" : "flash");
      else if (st.lampsTest) el.classList.add("test");
    }
    if (st.lampsTest) {
      Object.keys(R).forEach(function (k) {
        if (/Light|Lamp/.test(k)) R[k].classList.add("lit");
      });
      R.netOk.classList.add("on");
      R.micLive.classList.add("on");
      R.peakLamp.classList.add("on");
      R.txReady.classList.add("on");
      R.txFold.classList.add("on");
      R.txTripLamp.classList.add("on");
    }
  }

  /* ---------------- loop ---------------- */

  var lastTs = null,
    rafId = 0;

  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    if (lastTs === null) {
      lastTs = ts;
      return;
    }
    var dt = Math.min((ts - lastTs) / 1000, 0.25);
    lastTs = ts;
    tick(dt);
    render();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      lastTs = null;
    } else {
      lastTs = null;
      rafId = requestAnimationFrame(frame);
    }
  });

  window.addEventListener("resize", function () {
    ["cart", "network", "mic"].forEach(applyFader);
  });

  syncAllInputs();
  render();
  rafId = requestAnimationFrame(frame);

  /* ---------------- exported API ---------------- */

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };
})();
