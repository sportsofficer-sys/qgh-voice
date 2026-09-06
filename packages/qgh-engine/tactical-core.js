(function exposeQghTacticalCore(root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./simulator-core.js') : root.QGHCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QGHTacticalCore = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function createQghTacticalCore(Core) {
  'use strict';

  if (!Core) throw new Error('QGH flight core failed to load.');

  const { advanceArc, closestApproachToOverhead, normalize, radians, turnRadiusNm } = Core;
  const STEP_SECONDS = .25;
  const OVERHEAD_ZONE_NM = .25;
  const LEVEL_STEP_FT = 1000;
  const DEFAULT_BASE_LEVEL_FT = 6000;
  const TURN_SIDES = new Set(['left', 'right']);
  const PROCEDURES = new Set(['normal', 'us']);

  function finite(value, label) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(label + ' must be a finite number.');
    return numeric;
  }

  function degrees(value, label) {
    const numeric = finite(value, label);
    if (numeric < 0 || numeric > 359) throw new Error(label + ' must be from 000 to 359.');
    return normalize(numeric);
  }

  function bounded(value, minimum, maximum, label) {
    const numeric = finite(value, label);
    if (numeric < minimum || numeric > maximum) throw new Error(label + ' must be from ' + minimum + ' to ' + maximum + '.');
    return numeric;
  }

  function callsign(value) {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!normalized) throw new Error('Each aircraft needs a callsign.');
    if (normalized.length > 20) throw new Error('Callsigns must be 20 characters or fewer.');
    if (/^\d+$/.test(normalized) && !/^[1-9]\d{2}$/.test(normalized)) {
      throw new Error('Numeric callsigns must be from 100 to 999.');
    }
    return normalized;
  }

  function lineStyle(value) {
    return ['solid', 'dash', 'dot', 'dashdot'].includes(value) ? value : 'solid';
  }

  function randomInteger(random) {
    const source = typeof random === 'function' ? random : Math.random;
    const value = Number(source());
    if (!Number.isFinite(value)) throw new Error('Random source must return a finite number.');
    return Math.floor(Math.abs(value % 1) * 360);
  }

  function padHeading(value) {
    return String(Math.round(normalize(value))).padStart(3, '0');
  }

  function signedHeadingDelta(from, to) {
    return normalize(to - from + 180) - 180;
  }

  function headingError(from, to) {
    return Math.abs(signedHeadingDelta(from, to));
  }

  function turnDescriptor(side, from, to) {
    const degreesTurned = side === 'right' ? normalize(to - from) : normalize(from - to);
    return { side, degrees: degreesTurned, way: degreesTurned <= 180 ? 'SHORTER WAY' : 'LONGER WAY' };
  }

  function formatTurn(turn) {
    return turn ? turn.side.toUpperCase() + ' · ' + Math.round(turn.degrees) + '° · ' + turn.way : '—';
  }

  function rangeFor(aircraft) {
    return Math.hypot(aircraft.plane.x, aircraft.plane.y);
  }

  function bearingFor(aircraft) {
    const qte = normalize(Math.atan2(aircraft.plane.x, -aircraft.plane.y) * 180 / Math.PI);
    return {
      range: rangeFor(aircraft),
      qte,
      qdm: normalize(qte + 180),
      overhead: rangeFor(aircraft) <= OVERHEAD_ZONE_NM
    };
  }

  function level(value, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const candidate = bounded(value, LEVEL_STEP_FT, 45000, label + ' level');
    if (Math.abs(candidate / LEVEL_STEP_FT - Math.round(candidate / LEVEL_STEP_FT)) > 1e-9) {
      throw new Error(label + ' level must use 1000 ft increments.');
    }
    return candidate;
  }

  function validateFleet(aircraft) {
    if (!Array.isArray(aircraft) || aircraft.length < 2 || aircraft.length > 4) {
      throw new Error('Tactical QGH requires 2 to 4 aircraft.');
    }
    const ids = new Set();
    const callsigns = new Set();
    const fleet = aircraft.map((item, index) => {
      const id = String(item && item.id || String.fromCharCode(65 + index)).trim();
      const name = callsign(item && item.callsign);
      if (!id || ids.has(id)) throw new Error('Each tactical aircraft needs a unique identifier.');
      if (callsigns.has(name)) throw new Error('Each tactical aircraft needs a unique callsign.');
      ids.add(id);
      callsigns.add(name);
      return {
        id,
        callsign: name,
        color: /^#[0-9a-f]{6}$/i.test(String(item && item.color || '')) ? item.color : '#007d7d',
        lineStyle: lineStyle(item && item.lineStyle),
        type: String(item && item.type || 'fighter'),
        speed: bounded(item && item.speed, 60, 600, name + ' ground speed'),
        rate: bounded(item && item.rate, .5, 8, name + ' rate of turn'),
        distance: bounded(item && item.distance, 5, 50, name + ' initial distance'),
        level: level(item && item.level, name)
      };
    });
    const occupiedLevels = new Set(fleet.filter(item => item.level !== null).map(item => item.level));
    let nextAutomaticLevel = DEFAULT_BASE_LEVEL_FT;
    fleet.forEach(item => {
      if (item.level !== null) return;
      while (occupiedLevels.has(nextAutomaticLevel)) nextAutomaticLevel += LEVEL_STEP_FT;
      if (nextAutomaticLevel > 45000) throw new Error('Could not allocate a safe initial aircraft level.');
      item.level = nextAutomaticLevel;
      occupiedLevels.add(item.level);
      nextAutomaticLevel += LEVEL_STEP_FT;
    });
    const levels = fleet.map(item => item.level).sort((first, second) => first - second);
    for (let index = 1; index < levels.length; index += 1) {
      if (levels[index] - levels[index - 1] < LEVEL_STEP_FT) {
        throw new Error('Initial aircraft levels must be separated by at least 1000 ft.');
      }
    }
    return fleet;
  }

  function validateFormation(value, aircraftSpecs) {
    if (!value || value.enabled !== true) {
      return { enabled: false, leaderId: null, memberIds: [], detachedIds: [], slots: {} };
    }
    const ids = new Set(aircraftSpecs.map(item => item.id));
    const leaderId = String(value.leaderId || '').trim();
    if (!ids.has(leaderId)) throw new Error('Select a valid formation leader.');
    const requested = Array.isArray(value.memberIds) ? value.memberIds : aircraftSpecs.map(item => item.id);
    const memberIds = [...new Set(requested.map(item => String(item).trim()).filter(Boolean))];
    if (!memberIds.every(id => ids.has(id))) throw new Error('Formation members must be selected aircraft.');
    if (!memberIds.includes(leaderId)) memberIds.unshift(leaderId);
    if (memberIds.length < 2) throw new Error('A formation needs a leader and at least one wingman.');
    return { enabled: true, leaderId, memberIds, detachedIds: [], slots: {} };
  }

  function formationSlot(index) {
    const slots = [
      { forward: -.08, right: -.055 },
      { forward: -.105, right: .065 },
      { forward: -.155, right: -.01 }
    ];
    return slots[index] || { forward: -.12 - index * .045, right: index % 2 ? .065 : -.065 };
  }

  function formationPlane(leaderPlane, slot) {
    const heading = radians(leaderPlane.heading);
    return {
      x: leaderPlane.x + slot.forward * Math.sin(heading) + slot.right * Math.cos(heading),
      y: leaderPlane.y - slot.forward * Math.cos(heading) + slot.right * Math.sin(heading),
      heading: leaderPlane.heading
    };
  }

  function initialState(spec, index, count, random, randomizeInitial, signatures, origins) {
    let bearing;
    let heading;
    let initialTurn;
    let signature;
    let x;
    let y;
    let attempts = 0;
    do {
      if (randomizeInitial) {
        bearing = randomInteger(random);
        heading = randomInteger(random);
        initialTurn = ['straight', 'left', 'right'][randomInteger(random) % 3];
      } else {
        bearing = normalize(index * 360 / count);
        heading = normalize(90 + index * 90);
        initialTurn = 'straight';
      }
      x = Math.sin(radians(bearing)) * spec.distance;
      y = -Math.cos(radians(bearing)) * spec.distance;
      signature = [bearing, heading, initialTurn, spec.distance].join('|');
      attempts += 1;
    } while ((signatures.has(signature) || origins.some(origin => Math.hypot(x - origin.x, y - origin.y) < .75)) && attempts < 64);

    if (signatures.has(signature) || origins.some(origin => Math.hypot(x - origin.x, y - origin.y) < .75)) {
      throw new Error('Could not create safely separated tactical starting states.');
    }
    signatures.add(signature);
    origins.push({ x, y });

    const plane = {
      x,
      y,
      heading
    };
    return {
      id: spec.id,
      callsign: spec.callsign,
      color: spec.color,
      lineStyle: spec.lineStyle,
      cfg: { type: spec.type, speed: spec.speed, rate: spec.rate, distance: spec.distance },
      level: spec.level,
      plane,
      phase: 'recovery',
      targetHeading: heading,
      forcedTurnSide: null,
      initialTurnSide: initialTurn === 'straight' ? null : initialTurn,
      manualTurnSide: null,
      manualTurnRecord: null,
      orbit: null,
      pendingLeg: null,
      procedureTurns: { overhead: null, base: null },
      formationSpeed: null,
      path: [{ ...plane }]
    };
  }

  function createExercise(options = {}) {
    if (!PROCEDURES.has(options.procedure)) throw new Error('Tactical procedure must be Normal QGH or U/S Compass.');
    const aircraftSpecs = validateFleet(options.aircraft);
    const cfg = {
      runway: degrees(options.runway, 'Runway orientation'),
      outbound: degrees(options.outbound, 'Outbound track'),
      inbound: degrees(options.inbound, 'Inbound / final track')
    };
    const signatures = options.initialSignatures instanceof Set ? options.initialSignatures : new Set();
    const origins = [];
    const randomizeInitial = options.randomizeInitial !== false;
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const exercise = {
      procedure: options.procedure,
      cfg,
      aircraft: aircraftSpecs.map((spec, index) => initialState(spec, index, aircraftSpecs.length, random, randomizeInitial, signatures, origins)),
      formation: validateFormation(options.formation, aircraftSpecs),
      simulationSeconds: 0,
      events: []
    };
    initialiseFormation(exercise);
    return exercise;
  }

  function getAircraft(exercise, id) {
    if (!exercise || !Array.isArray(exercise.aircraft)) throw new Error('Tactical exercise is not available.');
    const aircraft = exercise.aircraft.find(item => item.id === id);
    if (!aircraft) throw new Error('Selected tactical aircraft is not available.');
    return aircraft;
  }

  function event(exercise, aircraft, type, detail) {
    const item = { aircraftId: aircraft.id, callsign: aircraft.callsign, type, detail };
    exercise.events.push(item);
    return item;
  }

  function formationRoleFor(exercise, id) {
    const formation = exercise && exercise.formation;
    if (!formation || !formation.enabled) return 'INDEPENDENT';
    if (formation.leaderId === id) return 'LEAD';
    if (formation.memberIds.includes(id) && !formation.detachedIds.includes(id)) return 'FORMATION';
    return 'INDEPENDENT';
  }

  function isAttachedFollower(exercise, aircraft) {
    return formationRoleFor(exercise, aircraft.id) === 'FORMATION';
  }

  function initialiseFormation(exercise) {
    const formation = exercise.formation;
    if (!formation.enabled) return;
    const leader = getAircraft(exercise, formation.leaderId);
    leader.formationSlot = null;
    let slotIndex = 0;
    formation.memberIds.forEach(id => {
      if (id === leader.id) return;
      const follower = getAircraft(exercise, id);
      const slot = formationSlot(slotIndex);
      slotIndex += 1;
      formation.slots[follower.id] = slot;
      follower.formationSlot = slot;
      follower.plane = formationPlane(leader.plane, slot);
      follower.phase = leader.phase;
      follower.targetHeading = leader.plane.heading;
      follower.forcedTurnSide = null;
      follower.initialTurnSide = null;
      follower.manualTurnSide = null;
      follower.manualTurnRecord = null;
      follower.orbit = null;
      follower.pendingLeg = null;
      follower.path = [{ ...follower.plane }];
    });
  }

  function detachFormationFollower(exercise, aircraft, reason) {
    if (!isAttachedFollower(exercise, aircraft)) return null;
    exercise.formation.detachedIds.push(aircraft.id);
    delete exercise.formation.slots[aircraft.id];
    aircraft.formationSlot = null;
    return event(
      exercise,
      aircraft,
      'FORMATION BREAK',
      'Released from ' + getAircraft(exercise, exercise.formation.leaderId).callsign + ' formation for ' + reason + '.'
    );
  }

  function stopFollowingLeader(exercise, id) {
    const aircraft = getAircraft(exercise, id);
    if (!isAttachedFollower(exercise, aircraft)) return null;
    const startIndex = exercise.events.length;
    const leader = getAircraft(exercise, exercise.formation.leaderId);
    const heading = normalize(aircraft.plane.heading);
    const currentSpeed = Number.isFinite(aircraft.formationSpeed) && aircraft.formationSpeed > 0
      ? aircraft.formationSpeed
      : leader.cfg.speed;
    const speed = Math.max(60, Math.min(600, currentSpeed));
    const breakEvent = detachFormationFollower(exercise, aircraft, 'controller-directed individual recovery');

    aircraft.cfg.speed = speed;
    aircraft.formationSpeed = null;
    aircraft.targetHeading = heading;
    aircraft.forcedTurnSide = null;
    aircraft.initialTurnSide = null;
    aircraft.manualTurnSide = null;
    aircraft.manualTurnRecord = null;
    aircraft.orbit = null;
    aircraft.pendingLeg = null;
    breakEvent.type = 'STOP FOLLOWING LEADER';
    breakEvent.detail = 'Released from ' + leader.callsign + ' formation; continuing ' + padHeading(heading) + '°M at ' + Math.round(speed) + ' KT.';

    return {
      aircraft,
      heading,
      speed,
      events: exercise.events.slice(startIndex)
    };
  }

  function turnDeltaForStep(aircraft, duration) {
    const maximum = aircraft.cfg.rate * duration;
    if (aircraft.manualTurnSide) return aircraft.manualTurnSide === 'left' ? -maximum : maximum;
    if (aircraft.initialTurnSide) return aircraft.initialTurnSide === 'left' ? -maximum : maximum;
    if (aircraft.targetHeading === null) return 0;

    if (aircraft.forcedTurnSide) {
      const remaining = aircraft.forcedTurnSide === 'right'
        ? normalize(aircraft.targetHeading - aircraft.plane.heading)
        : normalize(aircraft.plane.heading - aircraft.targetHeading);
      const direction = aircraft.forcedTurnSide === 'right' ? 1 : -1;
      if (remaining < .001) {
        aircraft.forcedTurnSide = null;
        return 0;
      }
      if (remaining <= maximum) {
        aircraft.forcedTurnSide = null;
        return direction * remaining;
      }
      return direction * maximum;
    }

    const shortest = signedHeadingDelta(aircraft.plane.heading, aircraft.targetHeading);
    if (Math.abs(shortest) < .001) return 0;
    return Math.sign(shortest) * Math.min(Math.abs(shortest), maximum);
  }

  function markOverheadIfPassed(exercise, aircraft, previous, next) {
    if (aircraft.phase !== 'recovery') return;
    const closest = closestApproachToOverhead(previous, next);
    if (closest.rangeNm > OVERHEAD_ZONE_NM) return;
    aircraft.phase = 'overhead';
    event(exercise, aircraft, 'OVERHEAD', 'Overhead zone passed at ' + closest.rangeNm.toFixed(2) + ' NM; continuous path retained.');
  }

  function establishLegIfNeeded(exercise, aircraft, side, actualHeading, tolerance = .2, turn = null) {
    if (aircraft.phase === 'overhead' && headingError(actualHeading, exercise.cfg.outbound) <= tolerance) {
      aircraft.pendingLeg = {
        phase: 'outbound',
        target: actualHeading,
        distance: 0,
        turnKey: 'overhead',
        turn,
        label: 'OUTBOUND TRACK'
      };
      return;
    }
    if (aircraft.phase === 'outbound' && headingError(actualHeading, exercise.cfg.inbound) <= tolerance) {
      aircraft.pendingLeg = {
        phase: 'inbound',
        target: actualHeading,
        distance: 0,
        turnKey: 'base',
        turn,
        label: side.toUpperCase() + ' BASE TURN'
      };
    }
  }

  function checkPendingLeg(exercise, aircraft, distanceFlown) {
    const pending = aircraft.pendingLeg;
    if (!pending || aircraft.manualTurnSide || aircraft.forcedTurnSide || headingError(aircraft.plane.heading, pending.target) > .2) return;
    pending.distance += distanceFlown;
    if (pending.distance < .05) return;
    aircraft.phase = pending.phase;
    aircraft.procedureTurns[pending.turnKey] = pending.turn;
    event(exercise, aircraft, pending.label, formatTurn(pending.turn) + ' · established on ' + padHeading(pending.target) + '°M.');
    aircraft.pendingLeg = null;
  }

  function stepAircraft(exercise, aircraft, duration) {
    const previous = { x: aircraft.plane.x, y: aircraft.plane.y };
    const orbit = aircraft.orbit;
    const deltaHeading = orbit ? 0 : turnDeltaForStep(aircraft, duration);
    const motion = orbit
      ? Core.advanceOrbitMotion(aircraft.plane, aircraft.cfg.speed, aircraft.cfg.rate, duration, orbit)
      : advanceArc(aircraft.plane, aircraft.plane.heading, aircraft.cfg.speed, deltaHeading / duration, duration);
    aircraft.plane = { x: motion.x, y: motion.y, heading: motion.heading };
    if (orbit) {
      for (let lap = orbit.laps - motion.completedLaps + 1; lap <= orbit.laps; lap += 1) {
        event(exercise, aircraft, 'ORBIT COMPLETE', 'Completed orbit ' + lap + '.');
      }
      if (motion.exited) finishOrbit(exercise, aircraft);
    }
    markOverheadIfPassed(exercise, aircraft, previous, aircraft.plane);
    checkPendingLeg(exercise, aircraft, motion.distanceNm);
    aircraft.path.push({ ...aircraft.plane });
  }

  function stepFormationFollower(exercise, aircraft, duration) {
    const leader = getAircraft(exercise, exercise.formation.leaderId);
    const slot = exercise.formation.slots[aircraft.id];
    const previous = aircraft.plane;
    const next = formationPlane(leader.plane, slot);
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
    const heading = distance > 1e-9
      ? normalize(Math.atan2(next.x - previous.x, -(next.y - previous.y)) * 180 / Math.PI)
      : leader.plane.heading;
    aircraft.plane = { x: next.x, y: next.y, heading };
    aircraft.formationSpeed = distance * 3600 / duration;
    aircraft.phase = leader.phase;
    aircraft.targetHeading = leader.plane.heading;
    aircraft.forcedTurnSide = null;
    aircraft.initialTurnSide = null;
    aircraft.manualTurnSide = null;
    aircraft.manualTurnRecord = null;
    aircraft.orbit = null;
    aircraft.pendingLeg = null;
    aircraft.procedureTurns = { ...leader.procedureTurns };
    aircraft.path.push({ ...aircraft.plane });
  }

  function step(exercise, duration = STEP_SECONDS) {
    const seconds = finite(duration, 'Simulation step');
    if (seconds <= 0) throw new Error('Simulation step must be greater than zero.');
    const startIndex = exercise.events.length;
    const followers = exercise.aircraft.filter(aircraft => isAttachedFollower(exercise, aircraft));
    const followerIds = new Set(followers.map(aircraft => aircraft.id));
    exercise.aircraft.filter(aircraft => !followerIds.has(aircraft.id)).forEach(aircraft => stepAircraft(exercise, aircraft, seconds));
    followers.forEach(aircraft => stepFormationFollower(exercise, aircraft, seconds));
    exercise.simulationSeconds += seconds;
    return exercise.events.slice(startIndex);
  }

  function advance(exercise, durationSeconds) {
    const duration = finite(durationSeconds, 'Advance duration');
    const stepCount = duration / STEP_SECONDS;
    if (duration <= 0 || Math.abs(stepCount - Math.round(stepCount)) > 1e-9) {
      throw new Error('Advance duration must use quarter-second flight steps.');
    }
    const events = [];
    for (let index = 0; index < Math.round(stepCount); index += 1) {
      events.push(...step(exercise, STEP_SECONDS));
    }
    return events;
  }

  function issueHeading(exercise, id, side, heading) {
    if (exercise.procedure !== 'normal') throw new Error('Heading assignment is available only in Normal QGH.');
    if (!TURN_SIDES.has(side)) throw new Error('Turn side must be left or right.');
    const startIndex = exercise.events.length;
    const aircraft = getAircraft(exercise, id);
    const target = degrees(heading, 'Assigned heading');
    detachFormationFollower(exercise, aircraft, 'individual heading command');
    const turn = turnDescriptor(side, aircraft.plane.heading, target);
    aircraft.orbit = null;
    aircraft.initialTurnSide = null;
    aircraft.manualTurnSide = null;
    aircraft.targetHeading = target;
    aircraft.forcedTurnSide = side;
    establishLegIfNeeded(exercise, aircraft, side, target, .2, turn);
    return {
      aircraft,
      turn,
      radius: turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate),
      events: exercise.events.slice(startIndex)
    };
  }

  // A controller may amend the target while an aircraft is already turning. The existing
  // turn direction is retained deliberately: "continue 060" must not silently choose a
  // shorter-way turn or reverse an active controller instruction.
  function continueHeading(exercise, id, heading) {
    if (exercise.procedure !== 'normal') throw new Error('Heading assignment is available only in Normal QGH.');
    const aircraft = getAircraft(exercise, id);
    if (aircraft.orbit) return issueHeading(exercise, id, aircraft.orbit.side, heading);
    if (!TURN_SIDES.has(aircraft.forcedTurnSide) || aircraft.manualTurnSide || aircraft.initialTurnSide) return null;
    return issueHeading(exercise, id, aircraft.forcedTurnSide, heading);
  }

  function startTurn(exercise, id, side) {
    if (exercise.procedure !== 'us') throw new Error('Timed turns are available only in U/S Compass.');
    if (!TURN_SIDES.has(side)) throw new Error('Turn side must be left or right.');
    const aircraft = getAircraft(exercise, id);
    if (aircraft.orbit) return null;
    const currentSide = aircraft.manualTurnSide || aircraft.initialTurnSide;
    if (currentSide === side) {
      return {
        aircraft,
        radius: turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate),
        unchanged: true,
        events: []
      };
    }
    const startIndex = exercise.events.length;
    detachFormationFollower(exercise, aircraft, 'individual timed turn');
    aircraft.orbit = null;
    aircraft.initialTurnSide = null;
    aircraft.targetHeading = null;
    aircraft.forcedTurnSide = null;
    aircraft.manualTurnSide = side;
    aircraft.manualTurnRecord = {
      side,
      target: aircraft.phase === 'overhead' ? exercise.cfg.outbound : aircraft.phase === 'outbound' ? exercise.cfg.inbound : null,
      startHeading: aircraft.plane.heading
    };
    return {
      aircraft,
      radius: turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate),
      events: exercise.events.slice(startIndex)
    };
  }

  function stopTurn(exercise, id) {
    if (exercise.procedure !== 'us') throw new Error('Timed turns are available only in U/S Compass.');
    const aircraft = getAircraft(exercise, id);
    if (!aircraft.manualTurnSide && !aircraft.initialTurnSide) return null;
    const record = aircraft.manualTurnRecord;
    aircraft.orbit = null;
    aircraft.manualTurnSide = null;
    aircraft.initialTurnSide = null;
    aircraft.targetHeading = aircraft.plane.heading;
    aircraft.forcedTurnSide = null;
    let established = null;
    if (record && record.target !== null && headingError(aircraft.plane.heading, record.target) <= 2) {
      established = turnDescriptor(record.side, record.startHeading, aircraft.plane.heading);
      establishLegIfNeeded(exercise, aircraft, record.side, aircraft.plane.heading, 2, established);
    }
    aircraft.manualTurnRecord = null;
    return { aircraft, turn: established };
  }

  function startOrbit(exercise, id, side) {
    if (!PROCEDURES.has(exercise?.procedure)) throw new Error('Orbit needs an active Normal QGH or U/S Compass exercise.');
    if (!TURN_SIDES.has(side)) throw new Error('Orbit direction must be left or right.');
    const aircraft = getAircraft(exercise, id);
    if (aircraft.orbit?.side === side) return continueOrbit(exercise, id);
    const orbit = Core.createOrbit(side, aircraft.plane.heading);
    const startIndex = exercise.events.length;
    detachFormationFollower(exercise, aircraft, 'individual orbit command');
    aircraft.orbit = orbit;
    aircraft.initialTurnSide = null;
    aircraft.manualTurnSide = side;
    aircraft.manualTurnRecord = null;
    aircraft.targetHeading = null;
    aircraft.forcedTurnSide = null;
    aircraft.pendingLeg = null;
    return { aircraft, radius: turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate), events: exercise.events.slice(startIndex) };
  }

  function continueOrbit(exercise, id) {
    const aircraft = getAircraft(exercise, id);
    if (!aircraft.orbit) return null;
    aircraft.orbit.exitRequested = false;
    return { aircraft, radius: turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate), events: [] };
  }

  function finishOrbit(exercise, aircraft) {
    aircraft.targetHeading = aircraft.orbit.entryHeading;
    aircraft.orbit = null;
    aircraft.manualTurnSide = null;
    aircraft.initialTurnSide = null;
    aircraft.forcedTurnSide = null;
    aircraft.manualTurnRecord = null;
    aircraft.pendingLeg = null;
    return event(exercise, aircraft, 'ORBIT RESUMED', 'Resuming normal flight on the heading held before the orbit.');
  }

  function resumeOrbit(exercise, id) {
    const aircraft = getAircraft(exercise, id);
    if (!aircraft.orbit) return null;
    const startIndex = exercise.events.length;
    const immediate = Core.resumeOrbit(aircraft.orbit);
    if (immediate) finishOrbit(exercise, aircraft);
    return { aircraft, immediate, radius: turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate), events: exercise.events.slice(startIndex) };
  }

  function setSpeed(exercise, id, speed) {
    const aircraft = getAircraft(exercise, id);
    aircraft.cfg.speed = bounded(speed, 60, 600, 'Ground speed');
    return aircraft.cfg.speed;
  }

  return {
    STEP_SECONDS,
    OVERHEAD_ZONE_NM,
    LEVEL_STEP_FT,
    createExercise,
    getAircraft,
    rangeFor,
    bearingFor,
    formationRoleFor,
    stopFollowingLeader,
    issueHeading,
    continueHeading,
    startOrbit,
    continueOrbit,
    resumeOrbit,
    startTurn,
    stopTurn,
    setSpeed,
    step,
    advance,
    turnDescriptor,
    formatTurn,
    padHeading,
    headingError,
    turnRadiusNm
  };
});
