/* ============================================================
   PILLATON MANUAL EXCHANGE — POSITION No. 1
   Simulation core. Classic script, IIFE, exposes window.machine.

   Three coupled quantities drive everything:
     - ring-generator flywheel rpm (motor drive vs drag, ringing
       drain, hand crank, belt slip)
     - common-battery bus volts (rectifier impedance vs talking
       and ringing load; sustained collapse blows the main fuse)
     - traffic (seeded-LCG arrivals; unanswered calls abandon and
       reach the supervisor's ledger)
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- subscribers on the multiple ---------------- */

  var LINES = [
    { num: 201, name: "DRAYCOTT" },
    { num: 202, name: "POST OFFICE" },
    { num: 203, name: "MANSE" },
    { num: 204, name: "GREEN FARM" },
    { num: 205, name: "SCHOOLHOUSE" },
    { num: 206, name: "FORGE" },
    { num: 207, name: "KILN COTTAGE" },
    { num: 208, name: "DOCTOR" },
    { num: 209, name: "BAKERY" },
    { num: 210, name: "STATION" },
    { num: 211, name: "MILL HOUSE" },
    { num: 212, name: "CHURCH" },
  ];

  var FAULT_NAMES = [
    "generator belt slip",
    "battery fuse blown",
    "reversed cord pair",
  ];
  var ALARM = {
    BELT: "BELT SLIP",
    FUSE: "MAIN FUSE BLOWN",
    REV: "REVERSED CORD PAIR",
    LOWV: "BATTERY VOLTS LOW",
    UNANS: "CALLS UNANSWERED",
    SUP: "SUPERVISOR COMPLAINT",
    RINGF: "RING FAILURE",
  };

  /* ---------------- simulation state ---------------- */

  var S = null;

  function freshState() {
    return {
      t: 0,
      seed: 218,
      rpm: 0,
      selector: "off",
      beltTight: false,
      fuseOk: true,
      volts: 48,
      load: 1,
      lowvSince: -1,
      nightService: false,
      buzzSilentUntil: 0,
      lampsTest: false,
      lines: LINES.map(function () {
        return { st: "idle", since: 0, want: -1, pair: -1 };
      }),
      pairs: [1, 2, 3].map(function (n) {
        return {
          n: n,
          a: null /* seated answering plug: {line, row:'front'} */,
          b: null /* seated calling plug: {line, row:'rear'}    */,
          lifted: null /* 'a' | 'b' | null                           */,
          key: "standby",
          ringing: false,
          talk: false,
          ringFailLatch: 0,
          howled: false,
        };
      }),
      answered: 0,
      missed: 0,
      connected: 0,
      alarms: {} /* name -> since                              */,
      faults: {} /* canonical fault name -> since              */,
      revDetectAt: -1,
      beltDetectAt: -1,
      nextArrivalAt: 0,
      lastBuzz: -10,
      tickets: [],
      note: "Motor off — flywheel standing.",
      revCycleArm: false,
    };
  }

  /* seeded LCG — the day's traffic is decided before it happens */
  function rnd() {
    S.seed = (S.seed * 1103515245 + 12345) % 2147483648;
    return S.seed / 2147483648;
  }

  function idleLineIdx(exclude) {
    var free = [];
    S.lines.forEach(function (L, i) {
      if (L.st === "idle" && exclude.indexOf(i) === -1) free.push(i);
    });
    if (!free.length) return -1;
    return free[Math.floor(rnd() * free.length)];
  }

  function ticket(txt) {
    var h = Math.floor((8.5 * 3600 + S.t) / 3600) % 24;
    var m = Math.floor((8.5 * 3600 + S.t) / 60) % 60;
    var stamp = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
    S.tickets.unshift(stamp + "  " + txt);
    if (S.tickets.length > 22) S.tickets.pop();
    renderTickets();
  }

  /* ---------------- alarms ---------------- */

  function raise(name) {
    if (!S.alarms[name]) {
      S.alarms[name] = S.t;
      renderAlarms();
      buzz();
    }
  }
  function clear(name) {
    if (S.alarms[name]) {
      delete S.alarms[name];
      renderAlarms();
    }
  }

  /* ---------------- faults ---------------- */

  function inject(fault) {
    var f = String(fault || "").toLowerCase();
    if (FAULT_NAMES.indexOf(f) === -1) return;
    if (S.faults[f]) return;
    S.faults[f] = S.t;
    if (f === "generator belt slip") S.beltDetectAt = S.t + 8;
    if (f === "battery fuse blown") blowFuse();
    if (f === "reversed cord pair") S.revDetectAt = S.t + 10;
    syncTestSwitches();
  }

  function blowFuse() {
    S.faults["battery fuse blown"] = S.t;
    S.fuseOk = false;
    raise(ALARM.FUSE);
    ticket("MAIN FUSE BLOWN — POSITION DEAD");
    /* every battery-fed circuit dies */
    S.pairs.forEach(function (p) {
      teardownPair(p, true);
    });
    S.lines.forEach(function (L) {
      if (L.st !== "idle") {
        L.st = "idle";
        L.pair = -1;
      }
    });
    S.missed += 0;
    renderAll();
  }

  function restoreFuse() {
    S.fuseOk = true;
    delete S.faults["battery fuse blown"];
    clear(ALARM.FUSE);
    ticket("SPARE MAIN FUSE FITTED");
    syncTestSwitches();
    renderAll();
  }

  /* ---------------- cord work ---------------- */

  function findPairByPlug(id) {
    var pn = parseInt(id.charAt(0), 10);
    return S.pairs[pn - 1];
  }

  function unseat(p, which) {
    var seat = which === "a" ? p.a : p.b;
    if (!seat) return;
    if (which === "a") p.a = null;
    else p.b = null;
    var Li = seat.line,
      L = S.lines[Li];
    clickSound();
    if (which === "a") {
      /* lifting the answering side releases the caller's hold */
      if (p.talk) {
        p.talk = false;
      }
      if (L.pair === p.n) {
        L.st = L.waitBack ? "waiting" : "idle";
        L.pair = -1;
      }
      if (L.st === "waiting") {
        L.since = S.t;
      }
    } else {
      /* lifting the calling side clears whatever the pair was doing */
      if (p.ringing) stopRing(p);
      if (p.talk) p.talk = false;
      if (L.pair === p.n) {
        if (L.st === "through" || L.st === "clearing" || L.st === "ringout") {
          L.st = "idle";
          L.pair = -1;
          var other = p.a ? S.lines[p.a.line] : null;
          if (other && other.pair === p.n) {
            other.st = "idle";
            other.pair = -1;
          }
          ticket(LINES[Li].num + " CLEARED PAIR " + p.n);
        } else if (L.st === "called") {
          L.st = "idle";
          L.pair = -1;
        }
      }
    }
  }

  function teardownPair(p, silent) {
    if (p.ringing) stopRing(p);
    p.talk = false;
    ["a", "b"].forEach(function (w) {
      var seat = w === "a" ? p.a : p.b;
      if (seat) {
        var L = S.lines[seat.line];
        if (L.pair === p.n) {
          L.st = "idle";
          L.pair = -1;
        }
        if (w === "a") p.a = null;
        else p.b = null;
      }
    });
    if (!silent) renderAll();
  }

  function seatPlug(p, which, li, row) {
    var L = S.lines[li];
    /* one plug per socket; front takes answers, rear takes calls */
    var occupied = S.pairs.some(function (q) {
      return (
        (q.a && q.a.line === li && q.a.row === row) ||
        (q.b && q.b.line === li && q.b.row === row)
      );
    });
    if (occupied) return false;
    if (which === "a") p.a = { line: li, row: row };
    else p.b = { line: li, row: row };
    p.lifted = null;
    clickSound();
    if (which === "a" && row === "front") {
      if (L.st === "waiting") {
        L.st = "answered";
        L.pair = p.n;
        L.waitBack = true;
      } else if (L.st === "idle") {
        L.st = "probe";
        L.pair = p.n;
        L.waitBack = false;
      }
    }
    if (which === "b" && row === "rear") {
      if (L.st === "idle") {
        L.st = "called";
        L.pair = p.n;
        L.since = S.t;
      }
    }
    renderAll();
    return true;
  }

  /* ---------------- lever keys ---------------- */

  function cycleKey(p) {
    var order = ["standby", "talk", "ring"];
    var next = order[(order.indexOf(p.key) + 1) % order.length];
    setKey(p, next);
  }

  function setKey(p, pos) {
    var prev = p.key;
    p.key = pos;

    /* --- reversed-pair proving: with both plugs homed in their wells,
       working the key off STANDBY and home again restores the relay --- */
    if (
      S.faults["reversed cord pair"] &&
      p.n === 2 &&
      pos === "standby" &&
      prev !== "standby" &&
      !p.a &&
      !p.b
    ) {
      delete S.faults["reversed cord pair"];
      clear(ALARM.REV);
      ticket("PAIR 2 REVERSAL RELAY RESTORED");
      syncTestSwitches();
    }

    if (pos === "talk") {
      if (p.a) {
        var La = S.lines[p.a.line];
        if (La.st === "answered" && La.pair === p.n) {
          La.st = "operator";
          p.talk = true;
          S.answered += 1;
          var want = La.want >= 0 ? LINES[La.want].num : -1;
          ticket(
            LINES[p.a.line].num +
              (want > 0 ? " ASKS " + want : " ASKS A LINE") +
              " · P" +
              p.n +
              (S.faults["reversed cord pair"] && p.n === 2 ? " · HOWLER!" : ""),
          );
          if (S.faults["reversed cord pair"] && p.n === 2 && !p.howled) {
            p.howled = true;
          }
        } else if (
          (La.st === "through" || La.st === "operator") &&
          La.pair === p.n
        ) {
          p.talk = true;
        }
      }
      humTick();
    }

    if (pos === "ring") {
      if (p.b) {
        var Lb = S.lines[p.b.line];
        if (Lb.st === "called" && Lb.pair === p.n) {
          if (S.rpm >= 900 && S.fuseOk) {
            Lb.st = "ringout";
            p.ringing = true;
          } else {
            p.ringFailLatch = S.t + 8;
            raise(ALARM.RINGF);
            ticket("WEAK OR NO RING OUT — CHECK GENERATOR");
          }
        }
      }
    }

    if (pos === "standby") {
      if (p.ringing) stopRing(p);
      p.talk = false;
    }
    renderAll();
  }

  function stopRing(p) {
    p.ringing = false;
    if (p.b) {
      var L = S.lines[p.b.line];
      if (L.st === "ringout" && L.pair === p.n) {
        L.st = "called";
      }
    }
    bellStop();
  }

  /* ---------------- physics step ---------------- */

  function advance(dt) {
    S.t += dt;

    /* ---- arrivals ---- */
    while (S.nextArrivalAt <= S.t) {
      var li = idleLineIdx([]);
      if (li >= 0) {
        var want = idleLineIdx([li]);
        S.lines[li].st = "waiting";
        S.lines[li].since = S.nextArrivalAt;
        S.lines[li].want = want;
        S.lines[li].pair = -1;
      }
      S.nextArrivalAt = S.t + 9 + rnd() * 22;
    }

    /* ---- waiting discipline ---- */
    S.lines.forEach(function (L) {
      if (L.st === "waiting") {
        var age = S.t - L.since;
        if (age > 55) {
          L.st = "idle";
          S.missed += 1;
          S.alarms[ALARM.SUP] = S.t; /* re-raise refreshes the clock */
          ticket(LINES[S.lines.indexOf(L)].num + " ABANDONED");
          renderAlarms();
        } else if (age > 40) {
          raise(ALARM.UNANS);
        }
      }
    });
    var anyOld = S.lines.some(function (L) {
      return L.st === "waiting" && S.t - L.since > 40;
    });
    if (!anyOld) clear(ALARM.UNANS);

    /* ---- generator ---- */
    var slipping = !!S.faults["generator belt slip"];
    var target = 0;
    if (S.selector === "run") target = slipping ? 700 : 1480;
    var tau = S.rpm > target ? 9 : 6;
    S.rpm += (target - S.rpm) * (dt / tau);
    if (cranking && S.rpm < 1350) S.rpm += 430 * dt;
    var wobble = slipping ? 46 * Math.sin(S.t * 5.3) : 0;
    var rpmNow = Math.max(0, S.rpm + wobble);

    /* ringing draws on the flywheel */
    var ringingPairs = 0;
    S.pairs.forEach(function (p) {
      if (p.ringing) {
        ringingPairs += 1;
        S.rpm = Math.max(0, S.rpm - 26 * dt);
        var L = S.lines[p.b.line];
        if (L.st === "ringout" && S.t - L.since > 5.5 + rnd() * 0.01) {
          /* answered at the far end */
          L.st = "through";
          L.since = S.t;
          p.ringing = false;
          var La = S.lines[p.a.line];
          if (
            La.pair === p.n &&
            (La.st === "operator" || La.st === "answered")
          ) {
            La.st = "through";
            La.since = S.t;
          }
          S.connected += 1;
          ticket(
            LINES[p.a.line].num +
              "-" +
              LINES[p.b.line].num +
              " CONNECTED P" +
              p.n,
          );
          bellStop();
          scheduleClear(p, L);
        }
      }
    });

    /* ---- through calls drift to their natural clearing time ---- */

    /* ---- belt-slip detector: motor revs disagree with the flywheel ---- */
    if (slipping && S.beltDetectAt >= 0 && S.t >= S.beltDetectAt) {
      raise(ALARM.BELT);
    }
    if (slipping && S.beltTight && S.selector === "run") {
      S.slipClear = (S.slipClear || 0) + dt;
      if (S.slipClear > 4) {
        delete S.faults["generator belt slip"];
        S.beltDetectAt = -1;
        S.slipClear = 0;
        clear(ALARM.BELT);
        ticket("BELT RE-TENSIONED — DRIVE HEALTHY");
        syncTestSwitches();
      }
    } else {
      S.slipClear = 0;
    }

    /* ---- reversed cord detector (automatic pair test) ---- */
    if (
      slipping === false &&
      S.revDetectAt >= 0 &&
      S.t >= S.revDetectAt &&
      S.faults["reversed cord pair"]
    ) {
      raise(ALARM.REV);
    }

    /* ---- battery ---- */
    var talkCircuits = 0;
    S.pairs.forEach(function (p) {
      if (p.talk) talkCircuits += 1;
      if (p.howled && S.faults["reversed cord pair"]) talkCircuits += 1;
    });
    S.load =
      1 +
      0.45 * talkCircuits +
      1.8 * ringingPairs +
      (S.selector === "run" ? 0.6 : 0);
    if (!S.fuseOk) {
      S.volts += (0 - S.volts) * (dt / 0.4);
    } else {
      var over = Math.max(0, S.load - 2);
      var vTarget = 48 - 3.1 * Math.pow(over, 1.15);
      S.volts += (vTarget - S.volts) * (dt / 4);
      if (S.volts < 44) raise(ALARM.LOWV);
      else clear(ALARM.LOWV);
      if (S.volts < 38.5) {
        if (S.lowvSince < 0) S.lowvSince = S.t;
        else if (S.t - S.lowvSince > 10) blowFuse();
      } else {
        S.lowvSince = -1;
      }
    }

    /* ---- ring failure latch expiry ---- */
    S.pairs.forEach(function (p) {
      if (p.ringFailLatch && S.t > p.ringFailLatch && S.rpm >= 1100) {
        p.ringFailLatch = 0;
        clear(ALARM.RINGF);
      }
      if (p.ringFailLatch && !anyPairRingingBlocked())
        clearWhen(S.t > p.ringFailLatch + 6, ALARM.RINGF);
    });

    /* ---- supervisor complaint cools off ---- */
    if (S.alarms[ALARM.SUP] && S.t - S.alarms[ALARM.SUP] > 90) clear(ALARM.SUP);

    /* ---- sounds tied to plant state ---- */
    if (ringingPairs > 0 && audioOn) bellStart();
    else bellStop();

    return rpmNow;
  }

  function anyPairRingingBlocked() {
    return S.pairs.some(function (p) {
      return !!p.ringFailLatch;
    });
  }
  function clearWhen(cond, name) {
    if (cond) clear(name);
  }

  function scheduleClear(p, L) {
    /* conversation length decided now; both lamps flash when they finish */
    var dur = 26 + rnd() * 44;
    setTimeoutSim(dur, function () {
      if (L.st === "through" && L.pair === p.n) {
        L.st = "clearing";
        L.since = S.t;
        var La = S.lines[p.a.line];
        if (La && La.pair === p.n) {
          La.st = "clearing";
          La.since = S.t;
        }
      }
    });
  }

  /* small deterministic scheduler: absolute sim-time callbacks */
  var simJobs = [];
  function setTimeoutSim(delay, fn) {
    simJobs.push({ at: S.t + delay, fn: fn });
  }
  function runJobs() {
    for (var i = simJobs.length - 1; i >= 0; i--) {
      if (S.t >= simJobs[i].at) {
        var j = simJobs.splice(i, 1)[0];
        j.fn();
      }
    }
  }

  /* ---------------- public API ---------------- */

  function tick(seconds) {
    var remain = Math.max(0, Number(seconds) || 0);
    while (remain > 0) {
      var dt = Math.min(0.25, remain);
      remain -= dt;
      advance(dt);
      runJobs();
    }
    renderFrame();
  }

  function reset() {
    S = freshState();
    S.nextArrivalAt = 6 + rnd() * 8;
    ticket("POSITION OPENED — COLD");
    simJobs.length = 0;
    cranking = false;
    selectedPlug = null;
    bellStop();
    syncTestSwitches();
    renderAll();
  }

  function state() {
    var waiting = S.lines.filter(function (L) {
      return L.st === "waiting";
    }).length;
    var oldest = 0;
    S.lines.forEach(function (L) {
      if (L.st === "waiting") oldest = Math.max(oldest, S.t - L.since);
    });
    return {
      simTime: round2(S.t),
      flywheelRpm: round2(Math.max(0, S.rpm)),
      busVolts: round2(S.volts),
      busLoadAmps: round2(S.load),
      generatorSelector: S.selector,
      fuseOk: !!S.fuseOk,
      beltTension: S.beltTight ? "tight" : "slack",
      nightService: !!S.nightService,
      callsWaiting: waiting,
      longestWaitSeconds: round2(oldest),
      callsHandled: S.answered,
      callsConnected: S.connected,
      callsAbandoned: S.missed,
      cordPairsInUse: S.pairs.filter(function (p) {
        return p.a && p.b;
      }).length,
      alarms: Object.keys(S.alarms),
      faults: Object.keys(S.faults),
    };
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  window.machine = {
    name: "Pillaton Manual Exchange — Position No. 1",
    faults: FAULT_NAMES.slice(),
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  /* ============================================================
     PANEL WIRING
     ============================================================ */

  var $ = function (sel) {
    return document.querySelector(sel);
  };
  var multiple = $("#multiple");
  var cordSvg = $("#cordSvg");
  var SVGNS = "http://www.w3.org/2000/svg";

  var lineEls = []; /* per line: {lamp, jackF, jackR} */
  var selectedPlug = null; /* "1a" .. "3b" lifted from its well */
  var cranking = false;
  var testing = false;

  /* ---------- build the twelve-line multiple ---------- */
  (function buildMultiple() {
    LINES.forEach(function (Ln, i) {
      var col = document.createElement("div");
      col.className = "line";
      col.dataset.line = String(i);

      var lamp = document.createElement("button");
      lamp.type = "button";
      lamp.className = "lamp";
      lamp.setAttribute("aria-label", "Line " + Ln.num + " calling lamp");
      lamp.disabled = true; /* lamps are indicators */
      lamp.innerHTML = '<span class="cap"></span>';
      lamp.style.cursor = "default";

      var strip = document.createElement("span");
      strip.className = "lnum-strip";
      strip.textContent = Ln.num + "·" + Ln.name;
      strip.title = Ln.num + " " + Ln.name;

      var jf = document.createElement("button");
      jf.type = "button";
      jf.className = "jack front";
      jf.dataset.line = String(i);
      jf.dataset.row = "front";
      jf.setAttribute(
        "aria-label",
        "Line " + Ln.num + " front (answering) jack",
      );

      var jr = document.createElement("button");
      jr.type = "button";
      jr.className = "jack rear";
      jr.dataset.line = String(i);
      jr.dataset.row = "rear";
      jr.setAttribute("aria-label", "Line " + Ln.num + " rear (calling) jack");

      col.appendChild(lamp);
      col.appendChild(strip);
      col.appendChild(jf);
      col.appendChild(jr);
      multiple.appendChild(col);
      lineEls.push({ lamp: lamp, jf: jf, jr: jr });
    });
  })();

  /* ---------- plug/well buttons ---------- */
  Array.prototype.forEach.call(
    document.querySelectorAll(".well"),
    function (w) {
      w.addEventListener("click", function () {
        var id = w.dataset.plug;
        var p = findPairByPlug(id);
        var which = id.charAt(1);
        if (p[which]) {
          unseat(p, which);
          selectedPlug = null;
        } else if (selectedPlug === id) {
          selectedPlug = null;
        } else {
          selectedPlug = id;
        }
        renderAll();
      });
    },
  );

  /* ---------- jack sockets ---------- */
  multiple.addEventListener("click", function (ev) {
    var j = ev.target.closest(".jack");
    if (!j) return;
    var li = parseInt(j.dataset.line, 10);
    var row = j.dataset.row;
    if (!selectedPlug) return;
    var p = findPairByPlug(selectedPlug);
    var which = selectedPlug.charAt(1);
    if (which === "a" && row !== "front") {
      flashNote("Answering plug seats in FRONT jacks only.");
      return;
    }
    if (which === "b" && row !== "rear") {
      flashNote("Calling plug seats in REAR jacks only.");
      return;
    }
    if (seatPlug(p, which, li, row)) selectedPlug = null;
  });

  /* ---------- lever keys ---------- */
  Array.prototype.forEach.call(
    document.querySelectorAll(".leverkey"),
    function (k) {
      k.addEventListener("click", function () {
        cycleKey(S.pairs[parseInt(k.dataset.key, 10) - 1]);
      });
    },
  );

  /* ---------- generator selector ---------- */
  $("#genSelector").addEventListener("click", function () {
    S.selector = S.selector === "run" ? "off" : "run";
    humSet(S.selector === "run");
    flashNote(
      S.selector === "run" ? "Motor on — flywheel coming up." : "Motor off.",
    );
    renderAll();
  });

  /* ---------- hand crank ---------- */
  var crankBtn = $("#handCrank");
  crankBtn.addEventListener("pointerdown", function () {
    cranking = true;
    crankBtn.classList.add("turning");
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(function (e) {
    crankBtn.addEventListener(e, function () {
      cranking = false;
      crankBtn.classList.remove("turning");
    });
  });
  crankBtn.addEventListener("keydown", function (ev) {
    if (ev.key === " " || ev.key === "Enter") {
      cranking = true;
      crankBtn.classList.add("turning");
      ev.preventDefault();
    }
  });
  crankBtn.addEventListener("keyup", function (ev) {
    if (ev.key === " " || ev.key === "Enter") {
      cranking = false;
      crankBtn.classList.remove("turning");
    }
  });

  /* ---------- spare main fuse ---------- */
  var clipArmed = false;
  $("#fuseClip").addEventListener("click", function () {
    if (!S.fuseOk) {
      if (!clipArmed) {
        clipArmed = true;
        $("#fuseClip").classList.add("armed");
        flashNote("Spare fuse offered to the clips — press again to home it.");
      } else {
        clipArmed = false;
        $("#fuseClip").classList.remove("armed");
        restoreFuse();
      }
    } else {
      clipArmed = false;
      $("#fuseClip").classList.remove("armed");
      flashNote("Main fuse healthy — spare stowed.");
    }
  });

  /* ---------- belt tension lever ---------- */
  $("#beltLever").addEventListener("click", function () {
    S.beltTight = !S.beltTight;
    this.setAttribute("aria-pressed", S.beltTight ? "true" : "false");
    this.setAttribute(
      "aria-label",
      "Belt tension lever, currently " + (S.beltTight ? "TIGHT" : "SLACK"),
    );
    flashNote(S.beltTight ? "Belt drawn tight." : "Belt slacked off.");
    renderAll();
  });

  /* ---------- supervisor's corner ---------- */
  $("#nightService").addEventListener("change", function () {
    S.nightService = this.checked;
    flashNote(
      this.checked
        ? "Night service — calls announce at the NIGHT CALL lens."
        : "Day service — calling lamps lit across the multiple.",
    );
    renderAll();
  });

  $("#buzzerCut").addEventListener("click", function () {
    S.buzzSilentUntil = S.t + 45;
    flashNote("Buzzer cut off for 45 seconds.");
  });

  var lampsTestBtn = $("#lampsTest");
  function testOn(ev) {
    testing = true;
    if (ev && ev.preventDefault) ev.preventDefault();
    renderLamps();
  }
  function testOff() {
    testing = false;
    renderLamps();
  }
  lampsTestBtn.addEventListener("pointerdown", testOn);
  ["pointerup", "pointerleave"].forEach(function (e) {
    lampsTestBtn.addEventListener(e, testOff);
  });
  lampsTestBtn.addEventListener("keydown", function (ev) {
    if (ev.key === " " || ev.key === "Enter") testOn(ev);
  });
  lampsTestBtn.addEventListener("keyup", function (ev) {
    if (ev.key === " " || ev.key === "Enter") testOff();
  });

  /* ---------- guarded fault test switches ---------- */
  Array.prototype.forEach.call(
    document.querySelectorAll(".ftest .guard"),
    function (g) {
      g.addEventListener("click", function () {
        var f = g.parentElement;
        f.classList.toggle("open");
        g.setAttribute(
          "aria-expanded",
          f.classList.contains("open") ? "true" : "false",
        );
      });
    },
  );
  [
    ["ftBelt", "generator belt slip"],
    ["ftFuse", "battery fuse blown"],
    ["ftCord", "reversed cord pair"],
  ].forEach(function (pair) {
    $("#" + pair[0]).addEventListener("change", function () {
      if (this.checked) inject(pair[1]);
    });
  });

  function syncTestSwitches() {
    $("#ftBelt").checked = !!S.faults["generator belt slip"];
    $("#ftFuse").checked = !!S.faults["battery fuse blown"];
    $("#ftCord").checked = !!S.faults["reversed cord pair"];
    ["ftBelt", "ftFuse", "ftCord"].forEach(function (id) {
      var box = $("#" + id);
      var f = box.parentElement;
      if (!box.checked) {
        f.classList.remove("open");
        f.querySelector(".guard").setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- header ---------- */
  $("#resetBtn").addEventListener("click", function () {
    reset();
    flashNote("Position reset — cold and quiet.");
  });
  $("#manualBtn").addEventListener("click", function () {
    var d = $("#manualDialog");
    var fr = d.querySelector("iframe");
    fr.src = "manual.html";
    d.showModal();
  });
  $("[data-action='close-manual']").addEventListener("click", function () {
    $("#manualDialog").close();
  });

  function flashNote(txt) {
    S.note = txt;
    $("#genNote").textContent = txt;
  }

  /* ============================================================
     SOUND — synthesised, only after a visitor gesture
     ============================================================ */

  var audioOn = false,
    AC = null,
    master = null,
    humOsc = null,
    humGain = null;
  var bellOsc = null,
    bellLfo = null,
    bellGain = null;

  function ensureAudio() {
    if (audioOn) return;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain();
      master.gain.value = 0.16;
      master.connect(AC.destination);
      audioOn = true;
    } catch (e) {
      audioOn = false;
    }
  }
  document.addEventListener("pointerdown", ensureAudio, { once: false });
  document.addEventListener("keydown", ensureAudio, { once: false });

  function clickSound() {
    if (!audioOn) return;
    try {
      var o = AC.createOscillator(),
        g = AC.createGain();
      o.type = "square";
      o.frequency.value = 1400;
      g.gain.setValueAtTime(0.12, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.03);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(AC.currentTime + 0.04);
    } catch (e) {}
  }

  function humSet(on) {
    if (!audioOn) return;
    try {
      if (on && !humOsc) {
        humOsc = AC.createOscillator();
        humGain = AC.createGain();
        humOsc.type = "triangle";
        humOsc.frequency.value = 100;
        humGain.gain.value = 0.02;
        humOsc.connect(humGain);
        humGain.connect(master);
        humOsc.start();
      } else if (!on && humOsc) {
        humOsc.stop();
        humOsc = null;
        humGain = null;
      }
    } catch (e) {}
  }
  function humTick() {}

  function bellStart() {
    if (!audioOn || bellOsc) return;
    try {
      bellOsc = AC.createOscillator();
      bellGain = AC.createGain();
      bellLfo = AC.createOscillator();
      var lfoGain = AC.createGain();
      bellOsc.type = "sine";
      bellOsc.frequency.value = 880;
      bellLfo.type = "square";
      bellLfo.frequency.value = 25;
      lfoGain.gain.value = 0.035;
      bellGain.gain.value = 0.035;
      bellLfo.connect(lfoGain);
      lfoGain.connect(bellGain.gain);
      bellOsc.connect(bellGain);
      bellGain.connect(master);
      bellOsc.start();
      bellLfo.start();
    } catch (e) {}
  }
  function bellStop() {
    if (!audioOn || !bellOsc) return;
    try {
      bellOsc.stop();
      bellLfo.stop();
    } catch (e) {}
    bellOsc = null;
    bellLfo = null;
    bellGain = null;
  }

  function buzz() {
    if (!audioOn || S.t < S.buzzSilentUntil) return;
    if (S.t - S.lastBuzz < 2.4) return;
    S.lastBuzz = S.t;
    try {
      var o = AC.createOscillator(),
        g = AC.createGain();
      o.type = "sawtooth";
      o.frequency.value = 300;
      g.gain.setValueAtTime(0.06, AC.currentTime);
      g.gain.setValueAtTime(0.06, AC.currentTime + 0.28);
      g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.34);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(AC.currentTime + 0.36);
    } catch (e) {}
  }

  /* ============================================================
     RENDER
     ============================================================ */

  /* continuous render: everything the sim can change on its own */
  function renderFrame() {
    renderDynamic();
    renderLamps();
    renderJacks();
    renderCords();
  }

  function renderAll() {
    renderLamps();
    renderJacks();
    renderKeys();
    renderBayControls();
    renderAlarms();
    renderCounters();
    renderTickets();
    renderCords();
    renderDynamic();
  }

  function renderDynamic() {
    /* meters */
    var vAng = -84 + clamp01(S.volts / 70) * 168;
    var dispRpm = Math.max(
      0,
      S.rpm + (S.faults["generator belt slip"] ? 46 * Math.sin(S.t * 5.3) : 0),
    );
    var rAng = -84 + clamp01(dispRpm / 1600) * 168;
    $("#voltNeedle").style.transform =
      "translateX(-50%) rotate(" + (testing ? 82 : vAng) + "deg)";
    $("#rpmNeedle").style.transform =
      "translateX(-50%) rotate(" + (testing ? 82 : rAng) + "deg)";

    /* duty clock */
    var secs = 8.5 * 3600 + S.t;
    var h = Math.floor(secs / 3600) % 24,
      m = Math.floor(secs / 60) % 60;
    $("#dutyClock").textContent =
      (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;

    /* neon */
    $("#neonLamp").classList.toggle("on", S.fuseOk && testing);

    /* crank wheel spins with the flywheel */
    var wheel = document.querySelector(".crank-wheel");
    wheel.style.transform =
      "rotate(" + Math.round((((S.t * dispRpm) / 60) * 360) % 360) + "deg)";

    /* status note when idle-handed */
    if (S.note.indexOf("Motor on") === 0 && S.rpm > 1200) {
      $("#genNote").textContent = "Flywheel up to speed — rings will carry.";
    }
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v || 0));
  }

  function renderLamps() {
    S.lines.forEach(function (L, i) {
      var el = lineEls[i].lamp;
      el.className = "lamp";
      var lit = false,
        flash = false;
      if (testing) {
        el.classList.add("test-lit");
        return;
      }
      switch (L.st) {
        case "waiting":
          lit = !S.nightService;
          break;
        case "answered":
        case "operator":
          lit = true;
          break;
        case "ringout":
          lit = false;
          break;
        case "through":
          lit = false;
          break;
        case "clearing":
          flash = true;
          lit = true;
          break;
      }
      el.classList.toggle("lit", lit);
      el.classList.toggle("flash", flash);
    });

    /* night call + supervisor + power lenses */
    var nightWaiting = S.lines.some(function (L) {
      return L.st === "waiting" && S.nightService;
    });
    var anyWaiting = S.lines.some(function (L) {
      return L.st === "waiting";
    });
    $("#lampNightCall").classList.toggle("on", nightWaiting);
    $("#lampNightCall").classList.toggle("flash", nightWaiting);
    $("#lampSupervisor").classList.toggle("on", !!S.alarms[ALARM.SUP]);
    $("#lampPower").classList.toggle("on", !S.fuseOk);
    $("#lampPower").classList.toggle("flash", !S.fuseOk);
    if (anyWaiting && !nightWaiting) $("#lampNightCall").classList.remove("on");
  }

  function renderJacks() {
    S.lines.forEach(function (L, i) {
      var busy = L.st !== "idle";
      [lineEls[i].jf, lineEls[i].jr].forEach(function (j) {
        j.classList.toggle("engaged", busy && !testing);
      });
    });
    S.pairs.forEach(function (p) {
      [
        ["a", "jf"],
        ["b", "jr"],
      ].forEach(function (w) {
        var seat = p[w[0]];
        [[0, 0]].forEach(function () {});
      });
    });
    /* mark seated sockets */
    Array.prototype.forEach.call(
      multiple.querySelectorAll(".jack"),
      function (j) {
        j.classList.remove("seated");
      },
    );
    S.pairs.forEach(function (p) {
      if (p.a)
        lineEls[p.a.line][p.a.row === "front" ? "jf" : "jr"].classList.add(
          "seated",
        );
      if (p.b)
        lineEls[p.b.line][p.b.row === "rear" ? "jr" : "jf"].classList.add(
          "seated",
        );
    });
  }

  function renderKeys() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".leverkey"),
      function (k) {
        var p = S.pairs[parseInt(k.dataset.key, 10) - 1];
        k.dataset.pos = p.key;
        k.setAttribute(
          "aria-label",
          "Pair " + p.n + " lever key, at " + p.key.toUpperCase(),
        );
      },
    );
    $("#genSelector").classList.toggle("run", S.selector === "run");
    $("#genSelector").setAttribute(
      "aria-label",
      "Ring generator selector, currently " +
        (S.selector === "run" ? "MOTOR RUN" : "OFF") +
        ". Operate to switch.",
    );
    $("#beltLever").setAttribute(
      "aria-pressed",
      S.beltTight ? "true" : "false",
    );
  }

  function renderBayControls() {
    $("#fuseClip").classList.toggle("blown-state", !S.fuseOk);
  }

  function renderAlarms() {
    var holder = $("#annLenses");
    holder.innerHTML = "";
    Object.keys(S.alarms).forEach(function (name) {
      var span = document.createElement("span");
      span.className = "ann-lens";
      span.textContent = name;
      holder.appendChild(span);
    });
  }

  function renderCounters() {
    $("#cntAnswered").textContent = String(S.answered);
    $("#cntMissed").textContent = String(S.missed);
  }

  function renderTickets() {
    var ol = $("#tickets");
    ol.innerHTML = "";
    S.tickets.forEach(function (t) {
      var li = document.createElement("li");
      li.textContent = t;
      ol.appendChild(li);
    });
  }

  /* ---------- cords as SVG braids ---------- */

  function ptOf(el) {
    var br = cordSvg.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    return {
      x: r.left - br.left + r.width / 2,
      y: r.top - br.top + r.height / 2,
    };
  }

  function renderCords() {
    cordSvg.innerHTML = "";
    S.pairs.forEach(function (p) {
      drawPlug(p, "a");
      drawPlug(p, "b");
    });
  }

  function drawPlug(p, which) {
    var id = p.n + which;
    var wellEl = document.querySelector('.well[data-plug="' + id + '"]');
    if (!wellEl) return;
    var mouth = wellEl.querySelector(".well-mouth");
    wellEl.classList.toggle("lifted", selectedPlug === id);

    var seat = which === "a" ? p.a : p.b;
    var live = which === "b" && p.ringing;
    var end,
      anchor = ptOf(mouth);
    if (seat) {
      var jackEl = lineEls[seat.line][seat.row === "front" ? "jf" : "jr"];
      end = ptOf(jackEl);
      end.y += 4;
    } else if (selectedPlug === id) {
      end = { x: anchor.x, y: anchor.y - 34 }; /* plug held aloft */
    } else {
      end = { x: anchor.x, y: anchor.y - 6 }; /* resting in the well */
    }

    var midY =
      Math.min(anchor.y, end.y) -
      Math.max(26, Math.abs(end.y - anchor.y) * 0.22);
    var d =
      "M" +
      anchor.x.toFixed(1) +
      " " +
      anchor.y.toFixed(1) +
      " C" +
      anchor.x.toFixed(1) +
      " " +
      midY.toFixed(1) +
      "," +
      end.x.toFixed(1) +
      " " +
      (midY + (end.y - midY) * 0.35).toFixed(1) +
      "," +
      end.x.toFixed(1) +
      " " +
      end.y.toFixed(1);

    var colour = which === "a" ? "#8a3b2a" : "#23262a";
    var fleck = which === "a" ? "#d8917c" : "#8b939c";

    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "cord-braid" + (live ? " cord-live" : ""));
    path.setAttribute("stroke", colour);
    cordSvg.appendChild(path);

    var fl = document.createElementNS(SVGNS, "path");
    fl.setAttribute("d", d);
    fl.setAttribute("class", "cord-fleck");
    fl.setAttribute("stroke", fleck);
    cordSvg.appendChild(fl);

    var head = document.createElementNS(SVGNS, "circle");
    head.setAttribute("cx", end.x.toFixed(1));
    head.setAttribute("cy", end.y.toFixed(1));
    head.setAttribute("r", seat ? 9 : 7);
    head.setAttribute("class", "plug-head");
    head.setAttribute("fill", "#c9a75a");
    cordSvg.appendChild(head);
  }

  /* ============================================================
     ANIMATION LOOP — feeds the same tick()
     ============================================================ */

  reset();

  var lastT = null;
  function frame(ts) {
    if (lastT === null) lastT = ts;
    var dt = Math.min(1, (ts - lastT) / 1000);
    lastT = ts;
    if (!document.hidden && dt > 0) tick(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.addEventListener("visibilitychange", function () {
    lastT = null;
    if (!document.hidden) {
      humSet(S.selector === "run");
    } else bellStop();
  });
})();
