/* =====================================================================
   Villarasca Air Terminal — Flap-Board Control Position (CEL FV/63)
   Simulation: motor-generator set -> solenoid drive -> split-flap cells.
   Volts drive stepping torque; stepping and stalls draw armature current;
   current heats the windings; heat trips the set and freezes the board.
   Deterministic: tick(seconds) integrates fixed 50 ms slices.
   ===================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------- constants */

  var NAME = "Villarasca Air Terminal Flap-Board";
  var FAULTS = ["flap jam", "motor overheating", "index error"];

  var FIELDS = [
    { key: "DESTINATION", width: 10 },
    { key: "FLIGHT", width: 5 },
    { key: "VIA", width: 6 },
    { key: "TIME", width: 5 },
    { key: "REMARKS", width: 8, amber: true },
  ];
  var ROWS = 6;
  var CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var NCHARS = CHARS.length;

  var RPM_FULL = 1420;
  var VOLTS_FULL = 52;
  var TRIP_TEMP = 95;
  var RESET_TEMP = 80;
  var AMBIENT = 22;
  var AMP_MAX = 30;

  /* The summer timetable taped beside the tape reader. */
  var SCHEDULE = [
    { dest: "ROMA", flight: "AZ 74", via: "", time: "13:05", rem: "IMBARCO" },
    {
      dest: "CATANIA",
      flight: "IT 512",
      via: "ROMA",
      time: "13:40",
      rem: "IN ORARIO",
    },
    { dest: "GENOVA", flight: "AT 33", via: "", time: "14:10", rem: "" },
    {
      dest: "PARIGI",
      flight: "AF 210",
      via: "TORINO",
      time: "14:35",
      rem: "CHECK-IN",
    },
    {
      dest: "LONDRA",
      flight: "BE 908",
      via: "",
      time: "15:05",
      rem: "IN ORARIO",
    },
    {
      dest: "PALERMO",
      flight: "AZ 611",
      via: "",
      time: "15:30",
      rem: "RITARDO",
    },
    {
      dest: "TRIESTE",
      flight: "AZ 88",
      via: "VENEZIA",
      time: "15:55",
      rem: "",
    },
    {
      dest: "MONACO",
      flight: "LH 371",
      via: "",
      time: "16:20",
      rem: "IMBARCO",
    },
    {
      dest: "VIENNA",
      flight: "OS 516",
      via: "",
      time: "16:45",
      rem: "IN ORARIO",
    },
    {
      dest: "BARCELLONA",
      flight: "IB 6240",
      via: "",
      time: "17:15",
      rem: "CANCELL.",
    },
    { dest: "BRUXELLES", flight: "SN 331", via: "", time: "17:40", rem: "" },
    {
      dest: "AMBURGO",
      flight: "LH 209",
      via: "MONACO",
      time: "18:05",
      rem: "ON TIME",
    },
  ];

  var FIELD_ABBR = {
    DESTINATION: "DEST",
    FLIGHT: "VOLO",
    VIA: "VIA",
    TIME: "ORA",
    REMARKS: "NOTE",
  };
  var MODES = ["STOP", "HAND", "TAPE"];
  var LEVER_ANGLE = [-46, 0, 46];
  var MAINT_ITEMS = ["OFF", "FLAP JAM", "MOTOR OVERHEATING", "INDEX ERROR"];

  /* ----------------------------------------------------------- state */

  var S = null;
  var CELLS = []; // one per flap, built once against the DOM
  var GRID = []; // GRID[r][c] -> CELLS entry

  function blankRows() {
    var rows = [];
    for (var r = 0; r < ROWS; r++) {
      var f = [];
      for (var k = 0; k < FIELDS.length; k++) {
        var pad = "";
        for (var i = 0; i < FIELDS[k].width; i++) pad += " ";
        f.push(pad);
      }
      rows.push(f);
    }
    return rows;
  }

  function freshState() {
    return {
      supply: false,
      guardOpen: false,
      coverOpen: false,
      mgOn: false,
      tripped: false,
      tripReason: "",
      rpm: 0,
      volts: 0,
      current: 0,
      activeSteps: 0,
      stallSurge: 0,
      temp: AMBIENT,
      mode: 0, // STOP / HAND / TAPE
      queue: [],
      schedIdx: 0,
      steppedTotal: 0,
      writeRow: 0,

      rows: blankRows(),

      jam: null,
      jamDetect: -1,
      jamCranked: 0,
      overheated: false,
      ovhtDetect: -1,
      idxDetect: -1,
      indexError: false,

      alarms: {},
      accepted: true,
      lampTest: 0,
      cranking: false,
      reindexing: false,
      reindexList: [],
      rngState: 0x2f6b46,

      clockMin: 12 * 60,
      stepAcc: 0,
      rr: 0,
    };
  }

  function rnd() {
    // deterministic little PRNG, seeded at reset
    S.rngState |= 0;
    S.rngState = (S.rngState + 0x6d2b79f5) | 0;
    var t = Math.imul(S.rngState ^ (S.rngState >>> 15), 1 | S.rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function charIdx(ch) {
    var i = CHARS.indexOf(ch);
    return i < 0 ? 0 : i;
  }

  /* ------------------------------------------------------------ audio */

  var AC = null;
  var humOsc = null;
  var humGain = null;
  var hornGain = null;
  var noiseBuf = null;
  var simNow = 0;

  function audioReady() {
    return !!AC && AC.state !== "closed";
  }

  function initAudio() {
    if (audioReady()) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      AC = new Ctx();
      var len = Math.floor(AC.sampleRate * 0.03);
      noiseBuf = AC.createBuffer(1, len, AC.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * (1 - i / len);

      humGain = AC.createGain();
      humGain.gain.value = 0;
      var lp = AC.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 320;
      humOsc = AC.createOscillator();
      humOsc.type = "sawtooth";
      humOsc.frequency.value = 50;
      humOsc.connect(lp);
      lp.connect(humGain);
      humGain.connect(AC.destination);
      humOsc.start();

      hornGain = AC.createGain();
      hornGain.gain.value = 0;
      var hp = AC.createBiquadFilter();
      hp.type = "bandpass";
      hp.frequency.value = 700;
      [420, 560].forEach(function (f) {
        var o = AC.createOscillator();
        o.type = "square";
        o.frequency.value = f;
        o.connect(hornGain);
        o.start();
      });
      hornGain.connect(hp);
      hp.connect(AC.destination);
    } catch (e) {
      AC = null;
    }
  }

  function sndClack() {
    if (!audioReady() || !noiseBuf) return;
    try {
      var src = AC.createBufferSource();
      src.buffer = noiseBuf;
      var bp = AC.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1700 + Math.random() * 500;
      bp.Q.value = 1.4;
      var g = AC.createGain();
      g.gain.value = 0.08;
      src.connect(bp);
      bp.connect(g);
      g.connect(AC.destination);
      src.start();
      src.stop(AC.currentTime + 0.04);
    } catch (e) {
      /* stay silent */
    }
  }

  function updateHum() {
    if (!audioReady() || !humGain) return;
    try {
      var target = S.mgOn && S.supply ? (S.rpm / RPM_FULL) * 0.026 : 0;
      humGain.gain.setTargetAtTime(target, AC.currentTime, 0.08);
      if (humOsc)
        humOsc.frequency.setTargetAtTime(
          28 + (S.rpm / RPM_FULL) * 34,
          AC.currentTime,
          0.1,
        );
    } catch (e) {
      /* stay silent */
    }
  }

  function updateHorn() {
    if (!audioReady() || !hornGain) return;
    try {
      var active = alarmNames().length > 0 && !S.accepted;
      var wob = active ? (Math.floor(simNow * 3) % 2 === 0 ? 0.03 : 0.018) : 0;
      hornGain.gain.setTargetAtTime(wob, AC.currentTime, 0.03);
    } catch (e) {
      /* stay silent */
    }
  }

  /* ------------------------------------------------------------ board */

  function buildBoard() {
    var boardEl = document.querySelector("[data-board]");
    if (!boardEl) return;
    boardEl.textContent = "";

    var head = document.createElement("div");
    head.className = "b-head";
    var h0 = document.createElement("span");
    h0.className = "bh-no";
    h0.textContent = "R";
    head.appendChild(h0);
    FIELDS.forEach(function (f) {
      var s = document.createElement("span");
      s.textContent = f.key;
      head.appendChild(s);
    });
    boardEl.appendChild(head);

    CELLS = [];
    GRID = [];
    for (var r = 0; r < ROWS; r++) {
      var rowEl = document.createElement("div");
      rowEl.className = "b-row";
      var tag = document.createElement("span");
      tag.className = "row-tag";
      tag.textContent = String(r + 1);
      rowEl.appendChild(tag);
      GRID.push([]);
      var ci = 0;
      FIELDS.forEach(function (f, fi) {
        var grp = document.createElement("span");
        grp.className = "fgroup";
        for (var i = 0; i < f.width; i++) {
          var cello = {
            r: r,
            c: ci,
            fieldIndex: fi,
            colInField: i,
            pos: 0,
            to: 0,
            tok: 0,
          };
          var el = document.createElement("span");
          el.className = "cell" + (f.amber ? " remarks" : "");
          var top = document.createElement("span");
          top.className = "cf cf-top";
          var topCh = document.createElement("span");
          topCh.className = "cf-ch";
          top.appendChild(topCh);
          var bot = document.createElement("span");
          bot.className = "cf cf-bot";
          var botCh = document.createElement("span");
          botCh.className = "cf-ch";
          bot.appendChild(botCh);
          var split = document.createElement("span");
          split.className = "splitline";
          var flap = document.createElement("span");
          flap.className = "flapper";
          var flapCh = document.createElement("span");
          flapCh.className = "cf-ch";
          flap.appendChild(flapCh);
          el.appendChild(top);
          el.appendChild(bot);
          el.appendChild(split);
          el.appendChild(flap);
          grp.appendChild(el);
          cello.el = el;
          cello.topCh = topCh;
          cello.botCh = botCh;
          cello.flap = flap;
          cello.flapCh = flapCh;
          snapPaint(cello);
          CELLS.push(cello);
          GRID[r].push(cello);
          ci++;
        }
        rowEl.appendChild(grp);
      });
      boardEl.appendChild(rowEl);
    }
  }

  function buildRings() {
    // printed tick rings around the selector knobs
    document.querySelectorAll(".r-ring").forEach(function (ring) {
      var n = 0;
      if (ring.classList.contains("r-row")) n = ROWS;
      else if (ring.classList.contains("r-field")) n = FIELDS.length;
      else if (ring.classList.contains("r-chars")) n = NCHARS;
      else if (ring.classList.contains("r-maint")) n = MAINT_ITEMS.length;
      for (var i = 0; i < n; i++) {
        var t = document.createElement("i");
        t.className = "r-tick";
        ring.appendChild(t);
      }
    });
  }

  function snapPaint(cello) {
    cello.pos = cello.to;
    if (!cello.el) return;
    cello.flap.classList.remove("on", "fall");
    cello.topCh.textContent = CHARS[cello.pos];
    cello.botCh.textContent = CHARS[cello.pos];
  }

  /* One tooth of the drum: the OLD top half swings away, the next
     character is revealed behind it. Cells always travel forward. */
  function animateStep(cello) {
    var oldCh = CHARS[cello.pos];
    cello.pos = (cello.pos + 1) % NCHARS;
    var newCh = CHARS[cello.pos];
    cello.tok++;
    var tok = cello.tok;
    S.steppedTotal++;
    sndClack();
    cello.topCh.textContent = newCh;
    cello.botCh.textContent = oldCh;
    cello.flapCh.textContent = oldCh;
    cello.flap.classList.add("on");
    cello.flap.classList.remove("fall");
    void cello.flap.offsetWidth;
    cello.flap.classList.add("fall");
    window.setTimeout(function () {
      if (cello.tok !== tok) return;
      cello.flap.classList.remove("on", "fall");
      cello.topCh.textContent = CHARS[cello.pos];
      cello.botCh.textContent = CHARS[cello.pos];
    }, 85);
  }

  /* --------------------------------------------------------- physics */

  function activeCount() {
    var n = 0;
    for (var i = 0; i < CELLS.length; i++)
      if (CELLS[i].to !== CELLS[i].pos) n++;
    return n;
  }

  function armatureCurrent(activeSteps) {
    var shaft = S.mgOn && S.supply ? S.rpm / RPM_FULL : 0; // no volts, no current
    if (shaft <= 0) return 0;
    var i = 1.2; // excitation
    i += activeSteps * 0.05; // solenoid banks, one tooth each
    if (S.stallSurge > 0) i += 11; // the drive stalled against a bound flap
    if (S.cranking) i += 2;
    return Math.min(i * shaft, AMP_MAX + 2);
  }

  function alarmNames() {
    return Object.keys(S.alarms);
  }

  function raiseAlarm(name) {
    if (!S.alarms[name]) {
      S.alarms[name] = true;
      S.accepted = false;
    }
  }

  function clearAlarm(name) {
    delete S.alarms[name];
    if (alarmNames().length === 0) S.accepted = true;
  }

  /* --------------------------------------------- operations & faults */

  function offsetOf(fieldIdx) {
    var o = 0;
    for (var k = 0; k < fieldIdx; k++) o += FIELDS[k].width;
    return o;
  }

  function startEntry(entry) {
    var r = S.writeRow % ROWS;
    S.writeRow++;
    var fields = [entry.dest, entry.flight, entry.via, entry.time, entry.rem];
    for (var k = 0; k < FIELDS.length; k++) {
      var txt = String(fields[k] || "").toUpperCase();
      var w = FIELDS[k].width;
      if (txt.length > w) txt = txt.slice(0, w);
      while (txt.length < w) txt += " ";
      S.rows[r][k] = txt;
      for (var i = 0; i < w; i++) GRID[r][offsetOf(k) + i].to = charIdx(txt[i]);
    }
  }

  function garbleDisplay() {
    // the encoder slips: a scattering of flaps sit one tooth off
    for (var i = 0; i < CELLS.length; i++) {
      if (rnd() < 0.14) {
        CELLS[i].pos = (CELLS[i].pos + (rnd() < 0.5 ? 1 : NCHARS - 1)) % NCHARS;
        CELLS[i].topCh.textContent = CHARS[CELLS[i].pos];
        CELLS[i].botCh.textContent = CHARS[CELLS[i].pos];
      }
    }
  }

  function doInject(name) {
    if (name === "flap jam") {
      S.jam = { r: 2, c: 4 };
      GRID[2][4].el.classList.add("jammed");
      S.jamDetect = 3; // torque monitor polls on the battery-backed feed
    } else if (name === "motor overheating") {
      S.overheated = true;
      S.temp = Math.max(S.temp, 88);
      S.ovhtDetect = 2;
    } else if (name === "index error") {
      S.indexError = true;
      garbleDisplay();
      S.idxDetect = 2;
    }
  }

  function doReset() {
    S = freshState();
    for (var i = 0; i < CELLS.length; i++) {
      var cello = CELLS[i];
      cello.to = 0;
      cello.tok++;
      cello.el.classList.remove("jammed");
      snapPaint(cello);
    }
    if (ui.supplyToggle) syncControls();
    updateHum();
    updateHorn();
  }

  /* -------------------------------------------------- fixed-step sim */

  var STEP_RATE = 42; // cascade flips per second while the drive turns

  function simSlice(dt) {
    S.clockMin = (S.clockMin + dt / 60) % 1440;

    // detect timers ride the battery-backed annunciator feed
    if (S.jamDetect > 0) {
      S.jamDetect -= dt;
      if (S.jamDetect <= 0) raiseAlarm("FLAP JAM");
    }
    if (S.ovhtDetect > 0) {
      S.ovhtDetect -= dt;
      if (S.ovhtDetect <= 0) raiseAlarm("OVERLOAD");
    }
    if (S.idxDetect > 0) {
      S.idxDetect -= dt;
      if (S.idxDetect <= 0) raiseAlarm("INDEX ERROR");
    }

    // motor-generator set
    var wantRun = S.supply && S.mgOn && !S.tripped;
    if (wantRun) S.rpm = Math.min(RPM_FULL, S.rpm + 950 * dt);
    else S.rpm = Math.max(0, S.rpm - 700 * dt);
    S.volts = (S.rpm / RPM_FULL) * VOLTS_FULL;

    // thermal model of the drive windings
    var act = activeCount();
    S.activeSteps = act;
    S.current = armatureCurrent(act);
    var heat = S.current * S.current * 0.38;
    var coolK = S.overheated ? 0.016 : 0.09; // cooked windings choke their own fan
    S.temp += (heat - coolK * (S.temp - AMBIENT)) * dt;

    if (S.temp < AMBIENT) S.temp = AMBIENT;
    if (S.temp >= TRIP_TEMP && !S.tripped) {
      S.tripped = true;
      S.tripReason = "OVERLOAD";
      S.mgOn = false; // the contactor drops out
      raiseAlarm("OVERLOAD");
    }

    // cranking frees a bound flap mechanically
    if (S.cranking && S.supply && S.jam) {
      S.jamCranked += dt;
      if (S.jamCranked >= 2.4) {
        GRID[S.jam.r][S.jam.c].el.classList.remove("jammed");
        S.jam = null;
        S.jamCranked = 0;
        S.jamDetect = -1;
        clearAlarm("FLAP JAM");
      }
    }

    // reindex walk: every cam is walked home off the logical register
    if (S.reindexing) {
      S.stepAcc += dt * 84;
      while (S.stepAcc >= 1) {
        S.stepAcc -= 1;
        var nxt = S.reindexList.shift();
        if (!nxt) {
          S.reindexing = false;
          S.indexError = false;
          S.idxDetect = -1;
          clearAlarm("INDEX ERROR");
          break;
        }
        nxt.to = charIdx(S.rows[nxt.r][nxt.fieldIndex][nxt.colInField]);
        sndClack();
        snapPaint(nxt);
      }
    }

    // normal cascade stepping
    var driving =
      S.supply &&
      S.mgOn &&
      !S.tripped &&
      S.rpm > RPM_FULL * 0.55 &&
      S.mode > 0 &&
      !S.reindexing;
    S.stallSurge = 0;
    if (driving) {
      S.stepAcc += dt * STEP_RATE;
      var guard = 0;
      while (S.stepAcc >= 1 && guard < 96) {
        S.stepAcc -= 1;
        guard++;
        stepOneCell();
      }
      if (S.mode === 2 && act === 0 && !S.indexError && S.queue.length > 0) {
        startEntry(S.queue.shift());
      }
    } else {
      S.stepAcc = 0;
    }
  }

  function stepOneCell() {
    var n = CELLS.length;
    for (var k = 0; k < n; k++) {
      S.rr = (S.rr + 1) % n;
      var cello = CELLS[S.rr];
      if (cello.to !== cello.pos) {
        if (S.jam && S.jam.r === cello.r && S.jam.c === cello.c) {
          S.stallSurge = 1; // drive stalls against the bound flap
          return;
        }
        animateStep(cello);
        return;
      }
    }
  }

  /* ------------------------------------------------------ public API */

  function apiState() {
    var boardText = [];
    for (var r = 0; r < ROWS; r++) {
      boardText.push(
        S.rows[r]
          .map(function (t, k) {
            return t.trim() === ""
              ? ""
              : FIELD_ABBR[FIELDS[k].key] + ":" + t.trim();
          })
          .filter(Boolean)
          .join(" | "),
      );
    }
    return {
      supply: S.supply,
      mgRunning: S.mgOn && !S.tripped && S.rpm > 100,
      rpm: Math.round(S.rpm),
      volts: Number(S.volts.toFixed(2)),
      current: Number(S.current.toFixed(2)),
      windingTemp: Number(S.temp.toFixed(2)),
      runMode: MODES[S.mode],
      queuedEntries: S.queue.length,
      stepsCompleted: S.steppedTotal,
      tripped: S.tripped,
      tripReason: S.tripReason || "",
      jammedCell: S.jam ? "R" + (S.jam.r + 1) + "C" + (S.jam.c + 1) : "",
      displayCorrupt: S.indexError,
      board: boardText,
      alarms: alarmNames(),
    };
  }

  window.machine = {
    name: NAME,
    faults: FAULTS.slice(),
    state: apiState,
    tick: function (seconds) {
      var remaining = Number(seconds) || 0;
      if (remaining <= 0) return apiState();
      var spent = remaining;
      while (remaining > 0) {
        var h = remaining > 0.05 ? 0.05 : remaining;
        simSlice(h);
        remaining -= h;
      }
      simNow += spent;
      return apiState();
    },
    inject: function (fault) {
      var f = String(fault || "").toLowerCase();
      for (var i = 0; i < FAULTS.length; i++) if (FAULTS[i] === f) doInject(f);
    },
    reset: function () {
      doReset();
    },
  };

  /* --------------------------------------------------- controls / DOM */

  function $(sel) {
    return document.querySelector(sel);
  }

  var ui = { sel: { row: 0, field: 0, char: 0, fault: 0 }, lamps: {} };

  function grabUi() {
    ui.clock = $("[data-clock]");
    ui.supplyToggle = $("[data-supply]");
    ui.guard = $("[data-guard]");
    ui.starter = $("[data-starter]");
    ["supply", "mgset", "overload", "jam", "index", "tape"].forEach(
      function (k) {
        var jw = document.querySelector('[data-lamp="' + k + '"]');
        ui.lamps[k] = jw ? jw.parentNode : null;
      },
    );
    ui.lever = $("[data-lever]");
    ui.needleAmps = $('[data-needle="amps"]');
    ui.needleTemp = $('[data-needle="temp"]');
    ui.drumQueue = $('[data-drum="queue"]');
    ui.drumSteps = $('[data-drum="steps"]');
    ui.crank = $("[data-crank]");
    ui.resetBtn = $("[data-resetbtn]");
    ui.acceptBtn = $("[data-accept]");
    ui.rots = {
      row: $("[data-rot='row']"),
      field: $("[data-rot='field']"),
      char: $("[data-rot='char']"),
      fault: $("[data-rot='fault']"),
    };
    ui.setCell = $("[data-setcell]");
    ui.tapeFeed = $("[data-tapefeed]");
    ui.reindex = $("[data-reindex]");
    ui.lampTest = $("[data-lamptest]");
    ui.readout = $("[data-readout]");
    ui.maintLatch = $("[data-maintlatch]");
    ui.inject = $("[data-inject]");
    ui.dialog = $("dialog[data-manual]");
  }

  function rotPositions(which) {
    if (which === "row") return ROWS;
    if (which === "field") return FIELDS.length;
    if (which === "fault") return MAINT_ITEMS.length;
    return NCHARS;
  }

  function rotLabel(which, i) {
    if (which === "row") return String(i + 1);
    if (which === "field") return FIELD_ABBR[FIELDS[i].key];
    if (which === "fault")
      return MAINT_ITEMS[i] === "OFF" ? "OFF" : MAINT_ITEMS[i].slice(0, 4);
    return i === 0 ? "\u00b7" : CHARS[i];
  }

  function syncRotary(which) {
    var btn = ui.rots[which];
    if (!btn) return;
    var n = rotPositions(which);
    var i = ui.sel[which];
    var a = -130 + (i * 260) / (n - 1);
    btn.style.setProperty("--ka", a.toFixed(1) + "deg");
    btn.setAttribute("aria-valuemin", "0");
    btn.setAttribute("aria-valuemax", String(n - 1));
    btn.setAttribute("aria-valuenow", String(i));
    btn.setAttribute("aria-valuetext", rotLabel(which, i));
    btn.dataset.show = rotLabel(which, i);
    var ring = btn.parentNode.querySelector(".r-ring");
    if (ring) {
      var ticks = ring.querySelectorAll(".r-tick");
      ticks.forEach(function (t, ti) {
        var ta = -130 + (ti * 260) / Math.max(1, ticks.length - 1);
        t.style.transform =
          "rotate(" + ta.toFixed(1) + "deg) translateY(-40px)";
        t.classList.toggle("cur", ti === i);
      });
    }
    if (which !== "fault") syncReadout();
  }

  function syncReadout() {
    if (!ui.readout) return;
    var f = FIELDS[ui.sel.field];
    var txt =
      "R" +
      (ui.sel.row + 1) +
      " " +
      FIELD_ABBR[f.key] +
      " \u00b7 " +
      (ui.sel.char === 0 ? "SPAZIO" : CHARS[ui.sel.char]);
    ui.readout.textContent = txt;
  }

  function flashReadout(msg) {
    if (!ui.readout) return;
    ui.readout.textContent = msg;
    window.setTimeout(function () {
      syncReadout();
    }, 1600);
  }

  function syncControls() {
    if (!ui.supplyToggle) return;
    ui.supplyToggle.setAttribute("aria-pressed", S.supply ? "true" : "false");
    ui.guard.setAttribute("aria-expanded", S.guardOpen ? "true" : "false");
    ui.starter.disabled = !(S.guardOpen && S.supply);
    ui.lever.setAttribute("aria-valuenow", String(S.mode));
    ui.lever.setAttribute("aria-valuetext", MODES[S.mode]);
    ui.lever.style.setProperty("--lever-a", LEVER_ANGLE[S.mode] + "deg");
    ui.maintLatch.setAttribute("aria-expanded", S.coverOpen ? "true" : "false");
    ui.inject.disabled = !S.coverOpen || ui.sel.fault === 0;
    Object.keys(ui.rots).forEach(syncRotary);
  }

  function trySetMode(m) {
    if (!S.supply || !S.mgOn || S.tripped) m = 0;
    if (m === 2 && S.indexError) {
      // the tape interlock refuses while the encoder is at fault
      flashReadout("BLOCCO INDICE \u2014 NASTRO NEGATO");
      m = 1;
      if (!S.supply || !S.mgOn || S.tripped) m = 0;
    }
    S.mode = m;
    syncControls();
  }

  function wireControls() {
    $("[data-action='manual']").addEventListener("click", function () {
      initAudio();
      ui.dialog.showModal();
    });
    $("[data-action='close-manual']").addEventListener("click", function () {
      ui.dialog.close();
    });

    ui.supplyToggle.addEventListener("click", function () {
      initAudio();
      S.supply = !S.supply;
      if (!S.supply) {
        S.mgOn = false;
        S.mode = 0;
      }
      syncControls();
    });

    ui.guard.addEventListener("click", function () {
      S.guardOpen = !S.guardOpen;
      syncControls();
    });

    ui.starter.addEventListener("click", function () {
      initAudio();
      if (!S.supply || S.tripped) {
        flashReadout(
          S.tripped
            ? "SGRILLATO: PREMERE OVERLOAD RESET"
            : "MANCA RETE: CONTROL SUPPLY",
        );
        return;
      }
      S.mgOn = true;
      syncControls();
    });

    ui.lever.addEventListener("click", function () {
      initAudio();
      trySetMode((S.mode + 1) % 3);
    });
    ui.lever.addEventListener("keydown", function (e) {
      var d = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") d = 1;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -1;
      if (!d) return;
      e.preventDefault();
      initAudio();
      trySetMode(Math.max(0, Math.min(2, S.mode + d)));
    });

    Object.keys(ui.rots).forEach(function (which) {
      var btn = ui.rots[which];
      btn.setAttribute("role", "slider");
      btn.setAttribute("tabindex", "0");
      var apply = function () {
        if (which === "fault") syncControls();
        else syncRotary(which);
      };
      var bump = function (d) {
        initAudio();
        var n = rotPositions(which);
        ui.sel[which] = (ui.sel[which] + d + n) % n;
        apply();
      };
      btn.addEventListener("click", function () {
        bump(1);
      });
      btn.addEventListener("keydown", function (e) {
        var d = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") d = 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") d = -1;
        if (e.key === "Home") {
          ui.sel[which] = 0;
          apply();
          e.preventDefault();
          return;
        }
        if (!d) return;
        e.preventDefault();
        bump(d);
      });
    });

    ui.setCell.addEventListener("click", function () {
      initAudio();
      if (S.tripped) return flashReadout("SGRILLATO: PREMERE OVERLOAD RESET");
      if (!(S.supply && S.mgOn))
        return flashReadout("MANCA MOTORE: START M-G SET");
      if (S.mode !== 1) return flashReadout("RUN LEVER SU HAND PER COMPORRE");
      var ch = ui.sel.char === 0 ? " " : CHARS[ui.sel.char];
      var txt = S.rows[ui.sel.row][ui.sel.field].split("");
      txt[0] = ch;
      S.rows[ui.sel.row][ui.sel.field] = txt.join("");
      GRID[ui.sel.row][offsetOf(ui.sel.field)].to = charIdx(ch);
      syncReadout();
    });

    ui.tapeFeed.addEventListener("click", function () {
      initAudio();
      if (!S.supply) return flashReadout("MANCA RETE: CONTROL SUPPLY");
      if (S.queue.length >= 6)
        return flashReadout("CODA PIENA \u2014 QUEUE FULL");
      S.queue.push(SCHEDULE[S.schedIdx % SCHEDULE.length]);
      S.schedIdx++;
      syncReadout();
    });

    ui.reindex.addEventListener("click", function () {
      initAudio();
      if (S.reindexing) return;
      if (!(S.supply && S.mgOn) || S.tripped)
        return flashReadout("SERVO CAMME: SERVE M-G SET IN MOTO");
      S.reindexList = CELLS.slice();
      S.reindexing = true;
      S.stepAcc = 0;
    });

    ui.lampTest.addEventListener("click", function () {
      S.lampTest = 1.2;
    });

    ui.acceptBtn.addEventListener("click", function () {
      initAudio();
      S.accepted = true;
    });

    ui.resetBtn.addEventListener("click", function () {
      initAudio();
      if (S.temp < RESET_TEMP && !S.jam) {
        S.overheated = false;
        S.tripped = false;
        S.tripReason = "";
        clearAlarm("OVERLOAD");
        flashReadout("SGRILLO TOGLITO \u2014 BREAKER FREE");
      } else if (S.jam) {
        flashReadout("LIBERARE LA VENTOLA COL CRANK");
      } else {
        flashReadout("AVVOLGIMENTI CALDI: FERMARE E RAFFREDDARE");
      }
      syncControls();
    });

    var startCrank = function (e) {
      if (e.cancelable) e.preventDefault();
      initAudio();
      S.cranking = true;
      ui.crank.classList.add("cranking");
    };
    var stopCrank = function () {
      S.cranking = false;
      S.jamCranked = 0;
      ui.crank.classList.remove("cranking");
    };
    ui.crank.addEventListener("pointerdown", startCrank);
    window.addEventListener("pointerup", stopCrank);
    ui.crank.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) startCrank(e);
    });
    ui.crank.addEventListener("keyup", stopCrank);
    ui.crank.addEventListener("blur", stopCrank);

    ui.maintLatch.addEventListener("click", function () {
      S.coverOpen = !S.coverOpen;
      syncControls();
    });

    ui.inject.addEventListener("click", function () {
      initAudio();
      var item = MAINT_ITEMS[ui.sel.fault];
      if (item === "OFF") return flashReadout("SELEZIONARE UN GUASTO");
      doInject(item.toLowerCase());
    });

    document.body.addEventListener(
      "pointerdown",
      function () {
        initAudio();
        if (audioReady() && AC.state === "suspended") AC.resume();
      },
      { passive: true },
    );
  }

  /* -------------------------------------------------------- rendering */

  function setLamp(key, lit) {
    if (ui.lamps[key]) ui.lamps[key].classList.toggle("lit", !!lit);
  }

  function renderFrame(dtReal) {
    var aFrac = Math.min(S.current, AMP_MAX) / AMP_MAX;
    ui.needleAmps.style.setProperty(
      "--needle-a",
      (-60 + aFrac * 120).toFixed(1) + "deg",
    );
    var tFrac = (Math.min(Math.max(S.temp, 20), 120) - 20) / 100;
    ui.needleTemp.style.setProperty(
      "--needle-a",
      (-60 + tFrac * 120).toFixed(1) + "deg",
    );

    var q = String(Math.min(S.queue.length, 999));
    while (q.length < 3) q = "0" + q;
    ui.drumQueue.textContent = q;
    var st = String(Math.min(S.steppedTotal, 99999));
    while (st.length < 5) st = "0" + st;
    ui.drumSteps.textContent = st;

    var hh = Math.floor(S.clockMin / 60);
    var mm = Math.floor(S.clockMin % 60);
    ui.clock.textContent =
      (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;

    var test = S.lampTest > 0;
    setLamp("supply", S.supply || test);
    setLamp("mgset", (S.mgOn && S.supply && !S.tripped && S.rpm > 60) || test);
    setLamp("tape", (S.mode === 2 && S.mgOn && !S.tripped) || test);
    var names = alarmNames();
    setLamp(
      "overload",
      names.indexOf("OVERLOAD") >= 0 ||
        test ||
        (S.temp >= TRIP_TEMP - 12 && S.temp > AMBIENT + 5),
    );
    setLamp(
      "jam",
      names.indexOf("FLAP JAM") >= 0 || test || (!!S.jam && S.stallSurge > 0),
    );
    setLamp("index", names.indexOf("INDEX ERROR") >= 0 || test || S.indexError);
    ["overload", "jam", "index"].forEach(function (k) {
      var el = ui.lamps[k];
      if (!el) return;
      el.classList.toggle(
        "flash",
        el.classList.contains("lit") && !S.accepted && !test,
      );
    });

    if (S.lampTest > 0) S.lampTest -= dtReal;

    ui.lever.style.setProperty("--lever-a", LEVER_ANGLE[S.mode] + "deg");

    updateHum();
    updateHorn();
  }

  /* -------------------------------------------------------- main loop */

  var lastT = 0;

  function loop(t) {
    window.requestAnimationFrame(loop);
    if (!lastT) {
      lastT = t;
      return;
    }
    var dt = (t - lastT) / 1000;
    lastT = t;
    if (dt > 0.5) dt = 0.5;
    if (document.hidden) return;
    simSlice(dt);
    simNow += dt;
    renderFrame(dt);
  }

  /* ------------------------------------------------------------- boot */

  function boot() {
    S = freshState();
    buildBoard();
    buildRings();
    grabUi();
    wireControls();
    syncControls();
    window.requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) lastT = 0;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
