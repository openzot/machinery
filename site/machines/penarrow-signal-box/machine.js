/* ===========================================================================
   PENARROW JUNCTION SIGNAL BOX — machine.js
   A 1923 mechanical signal box: six levers, one bell, absolute block.
   Everything below is deterministic: tick(seconds) advances the railway by
   fixed-substep integration, and it is the same function the rAF loop calls.
   =========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* geometry of the line (simulation metres; mapped to SVG in render)  */
  /* ------------------------------------------------------------------ */

  const X = {
    spawn: -430,
    distant: -330,
    homeStop: -20,
    homePass: -14,
    pointsCross: 10,
    starterStop: 304,
    starterPass: 316,
    sectionEnter: 344,
    sectionExit: 780,
  };

  const CRUISE_PASSENGER = 24;
  const CRUISE_FREIGHT = 17;
  const CREEP = 3.2;
  const BRAKE = 1.15;
  const ACCEL = 0.75;
  const SPAD_SECONDS = 90;
  const OFFER_REPEAT = 45;

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  let S = null;
  let listenersBound = false;
  let audioCtx = null;

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function coldState() {
    return {
      t: 0,
      rng: mulberry32(19230819),
      seedCounter: 0,
      /* levers: false = normal (back in frame), true = pulled */
      levers: { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false },
      dropped: { UH: false, USm: false, USl: false },
      trains: [],
      nextTrainId: 1,
      offerAt: 25,
      offerPhase: "idle" /* idle | offered | accepted */,
      nextType: null,
      pendingSpawn: null,
      autoAcceptIn: -1,
      lineClearAsked: false,
      pendowerReplyIn: -1,
      block: "LINE BLOCKED",
      outOfSectionFlash: 0,
      faults: { clutch: false, tcD: false, wire: false },
      incidents: [],
      wrongRoadTrainId: -1,
      served: 0,
      totalDelaySec: 0,
      damage: null,
      note: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* derived railway state                                               */
  /* ------------------------------------------------------------------ */

  function occ(name) {
    for (const tr of S.trains) {
      if (tr.phase === "gone" || tr.phase === "wreck") continue;
      if (name === "A" && tr.pos > X.spawn - 40 && tr.pos < X.pointsCross)
        return true;
      if (
        (name === "B1" || name === "B2") &&
        tr.pos >= X.pointsCross - 6 &&
        tr.pos < X.starterPass + 30
      ) {
        const road = tr.road || (S.levers[5] ? "loop" : "main");
        if (name === "B1" && road === "main") return true;
        if (name === "B2" && road === "loop") return true;
      }
      if (
        name === "D" &&
        tr.pos >= X.sectionEnter - 20 &&
        tr.pos < X.sectionExit
      )
        return true;
    }
    return false;
  }

  function pointsDetected() {
    return !S.faults.clutch;
  }

  /* the facing point lock covers the station: no engine may stand between
     the home signal's replacement mark and just beyond the starters */
  function pointsZoneOccupied() {
    for (const tr of S.trains) {
      if (tr.phase === "gone" || tr.phase === "wreck") continue;
      if (tr.pos > X.homePass - 40 && tr.pos < X.starterPass + 30) return true;
    }
    return false;
  }

  function fplEngaged() {
    return !S.levers[4];
  }

  function routeRoadClear(reversed) {
    return reversed ? !occ("B2") : !occ("B1");
  }

  function homeCanClear() {
    return fplEngaged() && pointsDetected() && routeRoadClear(S.levers[5]);
  }

  function effectiveSignal(which) {
    if (which === "UH") {
      return S.levers[1] && !S.faults.wire && !S.dropped.UH && homeCanClear();
    }
    if (which === "UD") {
      return S.levers[2] && effectiveSignal("UH");
    }
    const lever = which === "USm" ? 3 : 6;
    const dropped = which === "USm" ? S.dropped.USm : S.dropped.USl;
    return S.levers[lever] && !dropped && S.block === "LINE CLEAR" && !occ("D");
  }

  function requiredRoad(tr) {
    return tr.type === "freight" ? "loop" : "main";
  }

  function activeTrain() {
    for (const tr of S.trains) {
      if (tr.phase !== "gone" && tr.phase !== "wreck") return tr;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* alarms                                                              */
  /* ------------------------------------------------------------------ */

  function computeAlarms() {
    const set = [];
    if (S.faults.clutch) set.push("POINTS NOT DETECTED");
    if (S.faults.tcD) set.push("TRACK CIRCUIT FAILURE");
    if (S.faults.wire) set.push("HOME LEVER SLACK");
    const tr = activeTrain();
    if (tr && !tr.spad && tr.pos > X.distant && tr.pos <= X.homePass) {
      set.push("APPROACH WITHOUT ROUTE");
    }
    if (tr && tr.id === S.wrongRoadTrainId) set.push("WRONG ROAD SET");
    for (const name of S.incidents) set.push(name);
    if (S.totalDelaySec / 60 > 15) set.push("DELAYED WORKING");
    return set;
  }

  function raiseIncident(name) {
    if (S.incidents.indexOf(name) === -1) {
      S.incidents.push(name);
      bell(4);
    }
  }

  /* ------------------------------------------------------------------ */
  /* train physics                                                       */
  /* ------------------------------------------------------------------ */

  function moveTowards(tr, target, cruise, h) {
    let v = tr.v;
    if (target !== null) {
      const dist = target - tr.pos;
      if (dist <= 0.05) {
        tr.v = 0;
        return true;
      }
      const braking = (v * v) / (2 * BRAKE);
      if (braking >= dist) {
        v = Math.max(0, v - BRAKE * h);
      } else {
        v = Math.min(cruise, v + ACCEL * h);
      }
      const step = Math.min(v * h, dist);
      tr.pos += step;
      tr.v = step < v * h - 1e-9 ? 0 : v;
      if (dist - step <= 0.05) {
        tr.v = 0;
        return true;
      }
      return false;
    }
    v = Math.min(cruise, v + ACCEL * h);
    tr.pos += v * h;
    tr.v = v;
    return false;
  }

  function stepTrain(tr, h) {
    const prevPos = tr.pos;

    if (tr.phase === "approach") {
      const off = effectiveSignal("UH");
      const cruise = tr.type === "freight" ? CRUISE_FREIGHT : CRUISE_PASSENGER;
      const stopped = moveTowards(
        tr,
        off ? null : X.homeStop,
        off ? cruise * 0.62 : cruise,
        h,
      );
      if (stopped && !off) {
        /* standing at the home signal, shown at danger: the clock runs */
        tr.phase = "hold";
        tr.standT = 0;
      } else if (off && tr.pos > X.homeStop) {
        tr.phase = "run";
      }
    } else if (tr.phase === "hold") {
      tr.standT += h;
      if (tr.standT >= SPAD_SECONDS) {
        tr.spad = true;
        raiseIncident("SIGNAL PASSED AT DANGER");
        tr.phase = "run";
      }
    } else if (tr.phase === "run") {
      if (!tr.road && tr.pos >= X.pointsCross) {
        tr.road = S.levers[5] ? "loop" : "main";
        if (S.faults.clutch) {
          /* blades neither here nor there: engine off the rails at the fouling mark */
          tr.phase = "wreck";
          tr.pos = X.pointsCross + 8;
          tr.v = 0;
          S.damage = "derailment";
          raiseIncident("DERAILMENT");
          return;
        }
        if (tr.road !== requiredRoad(tr)) {
          S.wrongRoadTrainId = tr.id;
          S.totalDelaySec += 120;
        }
      }
      const road = tr.road || (S.levers[5] ? "loop" : "main");
      const starterOff =
        road === "loop" ? effectiveSignal("USl") : effectiveSignal("USm");
      const cruise = tr.spad
        ? CREEP
        : (tr.type === "freight" ? CRUISE_FREIGHT : CRUISE_PASSENGER) * 0.62;
      /* once past the starter stop mark the train is on its way: it never
         re-targets a mark behind it, however the signal falls */
      const target =
        tr.pos < X.starterStop && !starterOff ? X.starterStop : null;
      const done = moveTowards(tr, target, cruise, h);
      if (done && target !== null) {
        tr.phase = "berthed";
        tr.standT = 0;
      }
    } else if (tr.phase === "berthed") {
      tr.standT += h;
      const starterOff =
        tr.road === "loop" ? effectiveSignal("USl") : effectiveSignal("USm");
      if (starterOff) {
        tr.phase = "run";
      }
    } else if (tr.phase === "depart") {
      const cruise = tr.type === "freight" ? CRUISE_FREIGHT : CRUISE_PASSENGER;
      moveTowards(tr, null, cruise, h);
    }

    /* crossing events */
    if (prevPos <= X.homePass && tr.pos > X.homePass && tr.phase !== "hold") {
      S.dropped.UH = true;
    }
    if (prevPos <= X.starterPass && tr.pos > X.starterPass) {
      if (tr.road === "loop") S.dropped.USl = true;
      else S.dropped.USm = true;
    }
    if (prevPos < X.sectionEnter && tr.pos >= X.sectionEnter) {
      tr.phase = "depart";
      S.block = "TRAIN ON LINE";
      S.lineClearAsked = false;
    }
    if (tr.phase === "depart" && tr.pos >= X.sectionExit) {
      finishTrain(tr);
    }
  }

  function finishTrain(tr) {
    tr.phase = "gone";
    tr.v = 0;
    tr.goneAt = S.t;
    S.served += 1;
    const scheduled = tr.enteredAt + (tr.type === "freight" ? 150 : 120);
    const late = Math.max(0, S.t - scheduled);
    S.totalDelaySec += late;
    if (tr.id === S.wrongRoadTrainId) S.wrongRoadTrainId = -1;
    S.block = "LINE BLOCKED";
    S.outOfSectionFlash = 8;
    bell(3);
    scheduleNextOffer();
  }

  function scheduleNextOffer() {
    S.offerAt = S.t + 115 + S.rng() * 35;
    S.offerPhase = "idle";
    S.autoAcceptIn = -1;
  }

  /* ------------------------------------------------------------------ */
  /* offers, accepts, the block                                          */
  /* ------------------------------------------------------------------ */

  function makeOffer() {
    S.offerPhase = "offered";
    S.autoAcceptIn = OFFER_REPEAT;
    S.nextType = S.seedCounter % 2 === 0 ? "passenger" : "freight";
    S.seedCounter += 1;
    bell(2);
  }

  function acceptOffer(assumed) {
    S.offerPhase = "accepted";
    S.autoAcceptIn = -1;
    if (assumed) S.totalDelaySec += 240;
    bell(1);
    S.pendingSpawn = { type: S.nextType || "passenger", at: S.t + 12 };
  }

  function spawnTrain(type) {
    const tr = {
      id: S.nextTrainId,
      type: type,
      pos: X.spawn,
      v: 26,
      phase: "approach",
      road: null,
      standT: 0,
      spad: false,
      enteredAt: S.t,
      headcode:
        type === "freight"
          ? "No. " + (4100 + ((S.nextTrainId * 37) % 700)) + " FREIGHT"
          : "No. " + (1100 + ((S.nextTrainId * 53) % 500)) + " PASSENGER",
    };
    S.nextTrainId += 1;
    S.trains.push(tr);
    S.offerPhase = "idle";
    bell(1);
  }

  function pressPlunger() {
    ensureAudio();
    if (S.offerPhase === "offered") {
      acceptOffer(false);
      return;
    }
    if (
      S.block === "LINE BLOCKED" &&
      !S.lineClearAsked &&
      S.offerPhase === "idle"
    ) {
      const tr = activeTrain();
      if (
        tr &&
        (tr.phase === "berthed" || tr.phase === "run" || tr.phase === "hold")
      ) {
        S.lineClearAsked = true;
        S.pendowerReplyIn = 6;
        bell(1);
        return;
      }
      bell(1); /* a test stroke: nothing on the road to offer */
      return;
    }
    bell(1);
  }
  /* ------------------------------------------------------------------ */
  /* lever operation                                                     */
  /* ------------------------------------------------------------------ */

  function lockReason(n) {
    switch (n) {
      case 4:
        if (pointsZoneOccupied()) return "LOCK OVER OCCUPIED LINE";
        break;
      case 5:
        if (!S.levers[4]) return "POINT LOCK IN";
        if (pointsZoneOccupied()) return "POINTS UNDER TRAIN";
        break;
      case 1:
        if (S.faults.wire) return "WIRE SLACK";
        if (!fplEngaged()) return "POINT LOCK OUT";
        if (!pointsDetected()) return "PTS. NOT DETECTED";
        if (!routeRoadClear(S.levers[5])) return "ROAD OCCUPIED";
        break;
      case 2:
        break;
      case 3:
      case 6:
        if (S.block !== "LINE CLEAR") return "NO LINE CLEAR";
        if (occ("D")) return "SECTION AHEAD FULL";
        break;
      default:
        break;
    }
    return null;
  }

  function pullLever(n) {
    ensureAudio();
    const want = !S.levers[n];
    if (want) {
      const reason = lockReason(n);
      if (reason) {
        refuse(n, reason);
        return;
      }
      S.levers[n] = true;
      if (n === 5 && S.faults.clutch) {
        /* stroking the lever re-clutches the drive: detection restored */
        S.faults.clutch = false;
        syncTestSwitch("clutch", false);
      }
      clunk(true);
    } else {
      S.levers[n] = false;
      if (n === 1) S.dropped.UH = false;
      if (n === 3) S.dropped.USm = false;
      if (n === 6) S.dropped.USl = false;
      clunk(false);
    }
    refreshLevers();
  }

  /* ------------------------------------------------------------------ */
  /* faults                                                              */
  /* ------------------------------------------------------------------ */

  function inject(fault) {
    const key = normFault(fault);
    if (!key) return;
    if (key === "clutch") {
      S.faults.clutch = true;
      syncTestSwitch("clutch", true);
    } else if (key === "tcD") {
      S.faults.tcD = true;
      syncTestSwitch("tcD", true);
    } else if (key === "wire") {
      S.faults.wire = true;
      S.levers[1] = false;
      S.dropped.UH = false;
      syncTestSwitch("wire", true);
    }
    refreshLevers();
  }

  function normFault(f) {
    const s = String(f || "")
      .trim()
      .toLowerCase();
    if (s.indexOf("correspondence") !== -1 || s.indexOf("clutch") !== -1)
      return "clutch";
    if (s.indexOf("track circuit") !== -1 || s.indexOf("circuit") !== -1)
      return "tcD";
    if (s.indexOf("wire") !== -1 || s.indexOf("fracture") !== -1) return "wire";
    return null;
  }

  function repair(key) {
    if (key === "tcD") {
      S.faults.tcD = false;
      syncTestSwitch("tcD", false);
    } else if (key === "wire") {
      S.faults.wire = false;
      syncTestSwitch("wire", false);
    }
    refreshLevers();
  }

  /* ------------------------------------------------------------------ */
  /* the tick                                                            */
  /* ------------------------------------------------------------------ */

  function tick(seconds) {
    if (!S) return;
    let remaining = Math.max(0, Math.min(seconds, 86400));
    while (remaining > 1e-6) {
      const h = Math.min(0.25, remaining);
      remaining -= h;
      substep(h);
    }
  }

  function substep(h) {
    S.t += h;

    if (S.damage === "derailment" || S.damage === "collision") {
      /* the box is stopped: nothing moves until the inspector's reset */
      decayFlashes(h);
      return;
    }

    /* incoming offers */
    if (S.offerPhase === "idle" && !activeTrain() && S.t >= S.offerAt) {
      makeOffer();
    }
    if (S.offerPhase === "offered") {
      if (S.autoAcceptIn > 0) {
        S.autoAcceptIn -= h;
        if (S.autoAcceptIn <= 0) acceptOffer(true);
      }
    }
    if (S.pendingSpawn && S.t >= S.pendingSpawn.at) {
      const type = S.pendingSpawn.type;
      S.pendingSpawn = null;
      spawnTrain(type);
    }

    /* Pendower's reply to our offer */
    if (S.pendowerReplyIn > 0) {
      S.pendowerReplyIn -= h;
      if (S.pendowerReplyIn <= 0) {
        S.pendowerReplyIn = -1;
        S.block = "LINE CLEAR";
        bell(2);
      }
    }

    /* trains */
    for (const tr of S.trains) {
      if (tr.phase !== "gone" && tr.phase !== "wreck") stepTrain(tr, h);
    }

    /* collision between two trains sharing a road */
    const live = [];
    for (const tr of S.trains) {
      if (tr.phase !== "gone" && tr.phase !== "wreck") live.push(tr);
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (
          a.road &&
          b.road &&
          a.road === b.road &&
          Math.abs(a.pos - b.pos) < 14
        ) {
          a.phase = "wreck";
          b.phase = "wreck";
          a.v = 0;
          b.v = 0;
          S.damage = "collision";
          raiseIncident("COLLISION");
        }
      }
    }

    /* prune long-gone stock */
    if (S.trains.length > 4) {
      S.trains = S.trains.filter(function (tr) {
        return tr.phase !== "gone" || S.t - (tr.goneAt || 0) < 60;
      });
    }

    decayFlashes(h);
  }

  function decayFlashes(h) {
    if (S.outOfSectionFlash > 0)
      S.outOfSectionFlash = Math.max(0, S.outOfSectionFlash - h);
  }

  /* ------------------------------------------------------------------ */
  /* public state                                                        */
  /* ------------------------------------------------------------------ */

  function round(v, places) {
    const m = Math.pow(10, places || 1);
    return Math.round(v * m) / m;
  }

  function clockString() {
    const base = 9 * 3600 + 12 * 60;
    const secs = base + Math.floor(S.t);
    const hh = Math.floor(secs / 3600) % 24;
    const mm = Math.floor((secs % 3600) / 60);
    const pad = function (n) {
      return n < 10 ? "0" + n : "" + n;
    };
    return pad(hh) + ":" + pad(mm);
  }

  function state() {
    const tr = activeTrain();
    const lead = S.trains.length ? S.trains[S.trains.length - 1] : null;
    return {
      alarms: computeAlarms(),
      elapsedSec: round(S.t, 1),
      clock: clockString(),
      block: S.block,
      offerPhase: S.offerPhase,
      damage: S.damage,
      trainsPassed: S.served,
      totalDelayMin: round(S.totalDelaySec / 60, 1),
      pointsReversed: !!S.levers[5],
      pointsDetected: pointsDetected(),
      fplReleased: !!S.levers[4],
      trackCircuits: { A: occ("A"), B1: occ("B1"), B2: occ("B2"), D: occ("D") },
      signals: {
        upDistant: effectiveSignal("UD"),
        upHome: effectiveSignal("UH"),
        mainStarter: effectiveSignal("USm"),
        loopStarter: effectiveSignal("USl"),
      },
      levers: {
        1: !!S.levers[1],
        2: !!S.levers[2],
        3: !!S.levers[3],
        4: !!S.levers[4],
        5: !!S.levers[5],
        6: !!S.levers[6],
      },
      train: tr
        ? {
            id: tr.id,
            kind: tr.type,
            headcode: tr.headcode,
            phase: tr.phase,
            positionM: round(tr.pos, 1),
            speedMps: round(Math.max(0, tr.v), 1),
            road: tr.road,
            passedAtDanger: !!tr.spad,
          }
        : null,
      lastHeadcode: lead ? lead.headcode : null,
    };
  }

  function reset() {
    S = coldState();
    refreshLevers();
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* audio: single-stroke bell after a gesture only                      */
  /* ------------------------------------------------------------------ */

  function ensureAudio() {
    if (audioCtx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch (e) {
      audioCtx = null;
    }
  }

  function strike(when, gainScale) {
    try {
      if (!audioCtx) return;
      const t0 = audioCtx.currentTime + when;
      const partials = [
        [1560, 0.5],
        [2320, 0.28],
        [3910, 0.12],
      ];
      for (const p of partials) {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.frequency.value = p[0];
        osc.type = "sine";
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(
          0.06 * p[1] * (gainScale || 1),
          t0 + 0.004,
        );
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
        osc.connect(g).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 1);
      }
    } catch (e) {
      /* silence is period-appropriate too */
    }
  }

  function bell(code) {
    for (let i = 0; i < code; i++) strike(i * 0.45, 1);
  }

  function clunk(pull) {
    try {
      if (!audioCtx) return;
      const t0 = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(pull ? 130 : 90, t0);
      osc.frequency.exponentialRampToValueAtTime(pull ? 70 : 48, t0 + 0.09);
      g.gain.setValueAtTime(0.05, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.13);
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  const $ = function (id) {
    return document.getElementById(id);
  };

  const ARM_PIVOTS = {
    UD: [98, 152],
    UH: [258, 134],
    USl: [602, 79.5],
    USm: [602, 157.5],
  };
  const CLEAR_ANGLE = 42;

  function svgX(pos) {
    if (pos <= X.homeStop) {
      const k = (250 - 12) / (X.homeStop - X.spawn);
      return 12 + (pos - X.spawn) * k;
    }
    if (pos <= X.pointsCross) {
      const k = (306 - 250) / (X.pointsCross - X.homeStop);
      return 250 + (pos - X.homeStop) * k;
    }
    if (pos <= X.starterStop) {
      const k = (594 - 306) / (X.starterStop - X.pointsCross);
      return 306 + (pos - X.pointsCross) * k;
    }
    if (pos <= X.sectionEnter) {
      const k = (700 - 594) / (X.sectionEnter - X.starterStop);
      return 594 + (pos - X.starterStop) * k;
    }
    const k = (852 - 700) / (X.sectionExit - X.sectionEnter);
    return (
      700 + Math.min(pos - X.sectionEnter, X.sectionExit - X.sectionEnter) * k
    );
  }

  function svgY(pos, road) {
    if (pos <= X.pointsCross) return 216;
    if (pos <= X.starterStop) return road === "loop" ? 138 : 216;
    if (pos <= X.sectionEnter) {
      const k = (pos - X.starterStop) / (X.sectionEnter - X.starterStop);
      const from = road === "loop" ? 138 : 216;
      return from + (216 - from) * k;
    }
    return 216;
  }

  function setSignal(key, on) {
    const g = $("sig-" + key);
    const arm = $("arm-" + key);
    if (!g || !arm) return;
    if (on) {
      g.classList.add("clear");
      const p = ARM_PIVOTS[key];
      arm.setAttribute(
        "transform",
        "rotate(" + CLEAR_ANGLE + " " + p[0] + " " + p[1] + ")",
      );
    } else {
      g.classList.remove("clear");
      arm.removeAttribute("transform");
    }
  }

  const LEVER_NAMES = {
    1: "up home signal",
    2: "up distant signal",
    3: "main starter signal",
    4: "facing point lock",
    5: "loop points, normal main road, reverse loop road",
    6: "loop starter signal",
  };

  function refreshLevers() {
    for (let n = 1; n <= 6; n++) {
      const el = document.querySelector('.lever[data-lever="' + n + '"]');
      if (!el) continue;
      el.classList.toggle("reversed", !!S.levers[n]);
      el.setAttribute(
        "aria-label",
        "Lever " +
          n +
          ", " +
          LEVER_NAMES[n] +
          ", currently " +
          (S.levers[n] ? "pulled" : "normal"),
      );
    }
  }

  const refusedTimer = {};

  function refuse(n, reason) {
    const el = document.querySelector('.lever[data-lever="' + n + '"]');
    S.note = { text: reason, until: S.t + 4 };
    if (!el) return;
    el.classList.remove("refused");
    void el.offsetWidth;
    el.classList.add("refused");
    clunk(false);
    if (refusedTimer[n]) window.clearTimeout(refusedTimer[n]);
    refusedTimer[n] = window.setTimeout(function () {
      el.classList.remove("refused");
      refusedTimer[n] = null;
    }, 1400);
  }

  function prompt(text, urgent) {
    const el = $("bell-prompt");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("urgent", !!urgent);
  }

  function renderAll() {
    /* clock */
    const secs = 9 * 3600 + 12 * 60 + S.t;
    const minAng = ((secs % 3600) / 3600) * 360;
    const hourAng = (((secs / 3600) % 12) / 12) * 360;
    const mh = $("clock-minute");
    const hh = $("clock-hour");
    if (mh) mh.setAttribute("transform", "rotate(" + minAng + " 50 50)");
    if (hh) hh.setAttribute("transform", "rotate(" + hourAng + " 50 50)");

    /* track circuits */
    const tcMap = { A: occ("A"), B1: occ("B1"), B2: occ("B2"), D: occ("D") };
    for (const key of Object.keys(tcMap)) {
      const fill = $("tc-" + key);
      const jewel = $("jewel-" + key);
      if (fill) fill.classList.toggle("occupied", tcMap[key]);
      if (jewel) jewel.classList.toggle("lit", tcMap[key]);
    }

    /* signals */
    setSignal("UD", effectiveSignal("UD"));
    setSignal("UH", effectiveSignal("UH"));
    setSignal("USm", effectiveSignal("USm"));
    setSignal("USl", effectiveSignal("USl"));

    /* blades and points plate */
    const rev = !!S.levers[5];
    const bm = $("blade-main");
    const bl = $("blade-loop");
    const pw = $("pts-wrong");
    if (bm) bm.classList.toggle("hidden", rev);
    if (bl) bl.classList.toggle("hidden", !rev);
    if (pw) pw.classList.toggle("hidden", pointsDetected());

    /* block needle */
    const needle = $("block-needle");
    if (needle) {
      const ang =
        S.block === "LINE CLEAR" ? 46 : S.block === "TRAIN ON LINE" ? 180 : -46;
      needle.setAttribute("transform", "rotate(" + ang + " 65 65)");
    }

    /* tiles */
    const offered = S.offerPhase === "offered";
    const tr0 = activeTrain();
    const approaching = !!S.pendingSpawn || !!(tr0 && tr0.phase === "approach");
    const out = S.outOfSectionFlash > 0;
    const t1 = $("tile-offered");
    const t2 = $("tile-approaching");
    const t3 = $("tile-out");
    if (t1) t1.classList.toggle("lit", offered);
    if (t2) t2.classList.toggle("lit", approaching);
    if (t3) t3.classList.toggle("lit", out);

    /* ticket */
    const tr = tr0;
    const tm = $("ticket-main");
    const troute = $("ticket-route");
    if (tm && troute) {
      if (S.offerPhase === "offered") {
        tm.textContent =
          (S.nextType || "passenger").toUpperCase() +
          " TRAIN OFFERED BY TREGONY";
        troute.textContent =
          "REQUIRED ROAD: " +
          (S.nextType === "freight" ? "LOOP" : "MAIN (PLATFORM)");
      } else if (tr) {
        tm.textContent = tr.headcode + " — " + tr.phase.toUpperCase();
        troute.textContent =
          "ROUTE: " +
          (tr.road
            ? tr.road.toUpperCase()
            : S.levers[5]
              ? "LOOP SET"
              : "MAIN SET") +
          (tr.spad ? " — PASSED SIGNAL AT DANGER" : "");
      } else if (S.damage) {
        tm.textContent =
          S.damage === "collision"
            ? "COLLISION — SECTION FOULED"
            : "DERAILMENT AT PTS. No. 5";
        troute.textContent = "FRAME STOPPED. CALL THE INSPECTOR.";
      } else {
        tm.textContent = "NOTHING ON THE SPIKE";
        troute.textContent = "—";
      }
    }

    /* prompt line: damage and faults first, then any transient refusal
       note, then the standing phase of the block */
    if (S.damage === "collision") prompt("COLLISION — FRAME STOPPED", true);
    else if (S.damage === "derailment")
      prompt("ENGINE OFF THE RAILS AT No. 5", true);
    else if (S.faults.clutch) prompt("PTS. No. 5 NOT DETECTED", true);
    else if (S.faults.tcD) prompt("TC D FALSELY OCCUPIED", true);
    else if (S.faults.wire) prompt("U.HOME WIRE SLACK — ARM FALLEN", true);
    else if (S.note && S.note.until > S.t) prompt(S.note.text, true);
    else if (S.offerPhase === "offered")
      prompt("ACCEPT THE TRAIN — PRESS THE PLUNGER", true);
    else if (S.pendowerReplyIn > 0)
      prompt("OFFER SENT — PENDOWER IS REPLYING", false);
    else if (S.block === "LINE CLEAR")
      prompt("LINE CLEAR — WORK YOUR TRAIN", false);
    else if (S.block === "TRAIN ON LINE")
      prompt("TRAIN ON LINE — WAIT FOR THE BELL", false);
    else prompt("STANDING BY", false);

    /* register */
    const rp = $("reg-passed");
    const rd = $("reg-delay");
    const rs = $("reg-shift");
    if (rp) rp.textContent = "PASSED: " + S.served;
    if (rd)
      rd.textContent = "DELAY: " + Math.floor(S.totalDelaySec / 60) + " MIN";
    if (rs) rs.textContent = "SHIFT: " + clockString();

    /* sequence strip */
    const stepsDone = [false, false, false, false, false];
    if (S.offerPhase !== "idle" || tr || S.served > 0) stepsDone[0] = true;
    if (tr ? S.levers[4] === false && tr.road === requiredRoad(tr) : false)
      stepsDone[1] = true;
    if (effectiveSignal("UH")) stepsDone[2] = true;
    if (S.block === "LINE CLEAR" || S.block === "TRAIN ON LINE")
      stepsDone[3] = true;
    if ((tr && tr.phase === "depart") || (!tr && S.served > 0))
      stepsDone[4] = true;
    for (let i = 1; i <= 5; i++) {
      const el = $("seq-" + i);
      if (el) el.classList.toggle("done", stepsDone[i - 1]);
    }

    /* the train marker: draw the leading live train */
    const marker = $("train");
    const spadFlag = $("spad-flag");
    const liveTrains = [];
    for (const t of S.trains) {
      if (t.phase !== "gone") liveTrains.push(t);
    }
    if (marker && liveTrains.length) {
      const lead2 = liveTrains[liveTrains.length - 1];
      const anySpad = liveTrains.some(function (t) {
        return t.spad;
      });
      marker.classList.remove("hidden");
      const x = svgX(lead2.pos);
      const y = svgY(lead2.pos, lead2.road);
      marker.setAttribute(
        "transform",
        "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")",
      );
      if (spadFlag) {
        spadFlag.classList.toggle("hidden", !anySpad);
        if (anySpad) {
          spadFlag.setAttribute(
            "transform",
            "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")",
          );
        }
      }
    } else {
      if (marker) marker.classList.add("hidden");
      if (spadFlag) spadFlag.classList.add("hidden");
    }
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    if (listenersBound) return;
    listenersBound = true;

    document.addEventListener("pointerdown", ensureAudio, { once: true });
    document.addEventListener("keydown", ensureAudio, { once: true });

    for (let n = 1; n <= 6; n++) {
      const el = document.querySelector('.lever[data-lever="' + n + '"]');
      if (el) {
        el.addEventListener("click", function () {
          pullLever(parseInt(el.getAttribute("data-lever"), 10));
        });
      }
    }

    const plunger = document.querySelector(
      '[data-control="LINE BELL PLUNGER"]',
    );
    if (plunger) plunger.addEventListener("click", pressPlunger);

    bindTestSwitch("ts-clutch", "clutch");
    bindTestSwitch("ts-tc", "tcD");
    bindTestSwitch("ts-wire", "wire");

    const reseat = $("reseat-btn");
    if (reseat) {
      reseat.addEventListener("click", function () {
        ensureAudio();
        repair("tcD");
        bell(1);
      });
    }

    const restore = $("restore-btn");
    if (restore) {
      restore.addEventListener("click", function () {
        reset();
      });
    }

    const openManual = document.querySelector('[data-action="manual"]');
    const dialog = document.querySelector("dialog[data-manual]");
    if (openManual && dialog) {
      openManual.addEventListener("click", function () {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      });
    }
    const closeManual = document.querySelector('[data-action="close-manual"]');
    if (closeManual && dialog) {
      closeManual.addEventListener("click", function () {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      });
    }
  }

  function bindTestSwitch(id, key) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", function () {
      ensureAudio();
      const on = el.getAttribute("aria-checked") === "true";
      if (on) {
        /* switching off is itself the repair for the wire; the other two
           faults stand until their proper recovery actions are taken */
        el.setAttribute("aria-checked", "false");
        if (key === "wire") repair("wire");
        else bell(1);
      } else {
        el.setAttribute("aria-checked", "true");
        inject(
          key === "clutch"
            ? "points out of correspondence"
            : key === "tcD"
              ? "track circuit failure"
              : "signal wire fracture",
        );
      }
    });
  }

  function syncTestSwitch(key, on) {
    const map = { clutch: "ts-clutch", tcD: "ts-tc", wire: "ts-wire" };
    const el = $(map[key]);
    if (el) el.setAttribute("aria-checked", on ? "true" : "false");
  }

  /* ------------------------------------------------------------------ */
  /* the loop                                                            */
  /* ------------------------------------------------------------------ */

  let last = null;

  function frame(now) {
    if (last === null) last = now;
    const dt = Math.min((now - last) / 1000, 1);
    last = now;
    if (!document.hidden && dt > 0) {
      tick(dt);
      renderAll();
    }
    window.requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", function () {
    last = null;
  });

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */

  window.machine = {
    name: "Penarrow Junction Signal Box",
    faults: [
      "points out of correspondence",
      "track circuit failure",
      "signal wire fracture",
    ],
    state: state,
    tick: tick,
    inject: inject,
    reset: reset,
  };

  S = coldState();
  bindEvents();
  refreshLevers();
  renderAll();
  window.requestAnimationFrame(frame);
})();
