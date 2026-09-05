'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Core = require('../simulator-core.js');
const Tactical = require('../tactical-core.js');

const STEP = .25;
const headingError = (from, to) => Math.abs(Core.normalize(to - from + 180) - 180);
const separation = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function exercise(procedure = 'normal', options = {}) {
  return Tactical.createExercise({
    procedure, runway: 230, inbound: 225, outbound: 65, randomizeInitial: false,
    formation: options.formation ? { enabled: true, leaderId: 'A', memberIds: ['A', 'B', 'C'] } : undefined,
    aircraft: ['A', 'B', 'C'].map((id, index) => ({
      id, callsign: ['FALCON 11', 'RAVEN 21', 'VIPER 31'][index],
      speed: options.speed ?? 240, rate: options.rate ?? 3, distance: 12 + index
    }))
  });
}
const orbitEvents = events => events.filter(item => item.type === 'ORBIT COMPLETE');

test('orbit progress counts full revolutions in its direction, including several in one update', () => {
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? -1 : 1;
    const orbit = Core.createOrbit(side, 360);
    assert.deepEqual(orbit, { side, entryHeading: 0, degrees: 0, laps: 0 });
    assert.equal(Core.advanceOrbit(orbit, sign * 359.9), 0);
    assert.equal(Core.advanceOrbit(orbit, -sign), 0, 'opposite motion does not count as orbit progress');
    assert.equal(Core.advanceOrbit(orbit, sign * .1), 1);
    assert.equal(Core.advanceOrbit(orbit, 0), 0);
    assert.equal(Core.advanceOrbit(orbit, sign * 720), 2);
    assert.equal(orbit.laps, 3);
    assert.ok(Math.abs(orbit.degrees - 1080) < 1e-9);
  }
  assert.throws(() => Core.createOrbit('up', 90), /direction/);
  assert.throws(() => Core.createOrbit('left', NaN), /finite/);
});

test('left and right orbits use the selected finite radius and return to their entry point', () => {
  for (const side of ['left', 'right']) {
    const entry = { x: 10, y: -7, heading: 63 };
    let plane = { ...entry };
    const speed = 240;
    const rate = 3;
    const radius = Core.turnRadiusNm(speed, rate);
    const sideSign = side === 'left' ? -1 : 1;
    const centre = {
      x: entry.x + sideSign * Math.cos(Core.radians(entry.heading)) * radius,
      y: entry.y + sideSign * Math.sin(Core.radians(entry.heading)) * radius
    };
    const orbit = Core.createOrbit(side, entry.heading);
    let reports = 0;
    let furthest = 0;
    for (let sample = 1; sample <= 480; sample += 1) {
      const before = plane;
      const motion = Core.advanceOrbitMotion(plane, speed, rate, STEP, orbit);
      plane = { x: motion.x, y: motion.y, heading: motion.heading };
      reports += motion.completedLaps;
      furthest = Math.max(furthest, separation(plane, entry));
      assert.ok(Math.abs(separation(plane, centre) - radius) < 1e-9);
      assert.ok(separation(plane, before) <= speed * STEP / 3600 + 1e-9);
      assert.equal(motion.exited, false);
      assert.equal(reports, sample < 480 ? 0 : 1);
    }
    assert.ok(Math.abs(furthest - 2 * radius) < 1e-9, 'the orbit traces a full circle rather than a point turn');
    assert.ok(separation(plane, entry) < 1e-9);
    assert.ok(headingError(plane.heading, entry.heading) < 1e-9);
    assert.equal(orbit.laps, 1);
  }
});

test('resume normal finishes a non-divisor-rate circle then flies the leftover step straight', () => {
  for (const side of ['left', 'right']) {
    const entry = { x: 10, y: -7, heading: 347 };
    const speed = 240;
    const rate = 2.8;
    const orbit = Core.createOrbit(side, entry.heading);
    let plane = { ...entry };
    let result;
    let samples = 0;
    let reports = 0;
    for (; samples < 53; samples += 1) {
      result = Core.advanceOrbitMotion(plane, speed, rate, STEP, orbit);
      plane = { x: result.x, y: result.y, heading: result.heading };
    }
    const beforeRequest = { ...plane };
    assert.equal(Core.resumeOrbit(orbit), false);
    assert.deepEqual(plane, beforeRequest, 'requesting resume never teleports or rolls out immediately');
    do {
      const before = plane;
      result = Core.advanceOrbitMotion(plane, speed, rate, STEP, orbit);
      plane = { x: result.x, y: result.y, heading: result.heading };
      samples += 1;
      reports += result.completedLaps;
      assert.ok(separation(plane, before) <= speed * STEP / 3600 + 1e-9);
      assert.ok(samples < 1000, 'resume must finish the current circle');
    } while (!result.exited);
    const straightSeconds = samples * STEP - 360 / rate;
    const expected = Core.advanceArc(entry, entry.heading, speed, 0, straightSeconds);
    assert.ok(straightSeconds > 0 && straightSeconds < STEP);
    assert.ok(separation(plane, expected) < 1e-9, 'the final partial arc keeps the original radius');
    assert.equal(plane.heading, entry.heading);
    assert.equal(reports, 1);
    assert.equal(orbit.laps, 1);
  }
});

test('resume at the entry heading can exit without an extra circle', () => {
  const plane = { x: 1, y: 2, heading: 219 };
  const orbit = Core.createOrbit('left', plane.heading);
  assert.equal(Core.resumeOrbit(orbit), true);
  const motion = Core.advanceOrbitMotion(plane, 240, 3, STEP, orbit);
  const expected = Core.advanceArc(plane, plane.heading, 240, 0, STEP);
  assert.equal(motion.exited, true);
  assert.equal(motion.completedLaps, 0);
  assert.equal(motion.heading, 219);
  assert.ok(separation(motion, expected) < 1e-12);
});

test('tactical Normal and U/S orbits complete repeated circles without changing sample count', () => {
  for (const procedure of ['normal', 'us']) {
    for (const side of ['left', 'right']) {
      const current = exercise(procedure);
      const aircraft = Tactical.getAircraft(current, 'B');
      aircraft.plane.heading = 63;
      const entry = { ...aircraft.plane };
      aircraft.pendingLeg = { target: 63, distance: .04 };
      const result = Tactical.startOrbit(current, 'B', side);
      assert.equal(result.aircraft, aircraft);
      assert.equal(aircraft.orbit.entryHeading, 63);
      assert.equal(aircraft.manualTurnSide, side);
      assert.equal(aircraft.pendingLeg, null);
      assert.equal(aircraft.targetHeading, null);
      const samples = aircraft.path.length;
      assert.equal(orbitEvents(Tactical.advance(current, 60)).length, 0);
      const first = orbitEvents(Tactical.advance(current, 60));
      assert.equal(first.length, 1);
      assert.equal(first[0].aircraftId, 'B');
      assert.equal(first[0].callsign, 'RAVEN 21');
      assert.equal(aircraft.path.length, samples + 480);
      assert.ok(separation(aircraft.plane, entry) < 1e-9);
      assert.equal(aircraft.orbit.laps, 1);
      assert.equal(orbitEvents(Tactical.advance(current, 120)).length, 1);
      assert.equal(aircraft.orbit.laps, 2);
      Tactical.step(current);
      assert.ok(headingError(aircraft.plane.heading, entry.heading) > .5, 'the aircraft keeps circling after completion');
    }
  }
});

test('same-side orbit and continue preserve progress and can cancel pending resume', () => {
  const current = exercise();
  const aircraft = Tactical.getAircraft(current, 'A');
  Tactical.startOrbit(current, 'A', 'right');
  Tactical.advance(current, 30);
  const orbit = aircraft.orbit;
  const before = { degrees: orbit.degrees, entryHeading: orbit.entryHeading, laps: orbit.laps };
  Tactical.startOrbit(current, 'A', 'right');
  assert.equal(aircraft.orbit, orbit);
  assert.equal(Tactical.resumeOrbit(current, 'A').immediate, false);
  assert.equal(orbit.exitRequested, true);
  Tactical.continueOrbit(current, 'A');
  assert.equal(orbit.exitRequested, false);
  assert.deepEqual({ degrees: orbit.degrees, entryHeading: orbit.entryHeading, laps: orbit.laps }, before);
  const events = Tactical.advance(current, 100);
  assert.equal(events.some(item => item.type === 'ORBIT RESUMED'), false);
  assert.equal(aircraft.orbit.laps, 1);
  const previousHeading = aircraft.plane.heading;
  Tactical.startOrbit(current, 'A', 'left');
  assert.notEqual(aircraft.orbit, orbit);
  assert.equal(aircraft.orbit.entryHeading, previousHeading);
  assert.equal(aircraft.orbit.degrees, 0);
});

test('resume normal uses the actual pre-orbit heading and finishes through north without a position jump', () => {
  for (const procedure of ['normal', 'us']) {
    const current = exercise(procedure, { rate: 2.8 });
    const aircraft = Tactical.getAircraft(current, 'A');
    aircraft.plane.heading = 347;
    aircraft.targetHeading = 90;
    Tactical.startOrbit(current, 'A', 'right');
    Tactical.advance(current, 20);
    const before = { ...aircraft.plane };
    const requested = Tactical.resumeOrbit(current, 'A');
    assert.equal(requested.immediate, false);
    assert.deepEqual(aircraft.plane, before);
    const events = Tactical.advance(current, 120);
    assert.equal(orbitEvents(events).length, 1);
    assert.equal(events.filter(item => item.type === 'ORBIT RESUMED').length, 1);
    assert.equal(aircraft.orbit, null);
    assert.equal(aircraft.manualTurnSide, null);
    assert.equal(aircraft.targetHeading, 347, 'resume uses actual entry heading, not the abandoned target');
    assert.equal(aircraft.plane.heading, 347);
    const straightStart = { ...aircraft.plane };
    Tactical.step(current);
    const expected = Core.advanceArc(straightStart, 347, aircraft.cfg.speed, 0, STEP);
    assert.ok(separation(aircraft.plane, expected) < 1e-12);
    assert.equal(Tactical.resumeOrbit(current, 'A'), null);
    assert.equal(Tactical.continueOrbit(current, 'A'), null);
  }
});

test('immediate tactical resume clears orbit state without moving the aircraft', () => {
  const current = exercise();
  const aircraft = Tactical.getAircraft(current, 'A');
  const before = { ...aircraft.plane };
  Tactical.startOrbit(current, 'A', 'left');
  const result = Tactical.resumeOrbit(current, 'A');
  assert.equal(result.immediate, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'ORBIT RESUMED');
  assert.equal(aircraft.orbit, null);
  assert.equal(aircraft.manualTurnSide, null);
  assert.deepEqual(aircraft.plane, before);
});

test('individual orbit detaches only its addressed formation member after valid input', () => {
  const current = exercise('normal', { formation: true });
  assert.throws(() => Tactical.startOrbit(current, 'B', 'up'), /direction/);
  assert.equal(Tactical.formationRoleFor(current, 'B'), 'FORMATION');
  const leader = Tactical.getAircraft(current, 'A');
  const wingman = Tactical.getAircraft(current, 'B');
  const before = { ...wingman.plane };
  const result = Tactical.startOrbit(current, 'B', 'left');
  assert.equal(Tactical.formationRoleFor(current, 'B'), 'INDEPENDENT');
  assert.equal(Tactical.formationRoleFor(current, 'C'), 'FORMATION');
  assert.equal(result.events.filter(item => item.type === 'FORMATION BREAK').length, 1);
  assert.deepEqual(wingman.plane, before);
  assert.equal(leader.orbit, null);
  Tactical.advance(current, 120);
  assert.equal(wingman.orbit.laps, 1);
  assert.equal(Tactical.getAircraft(current, 'C').orbit, null);
});

test('normal heading assignments replace orbit and numeric continue preserves the orbit direction', () => {
  const current = exercise();
  const aircraft = Tactical.getAircraft(current, 'A');
  Tactical.startOrbit(current, 'A', 'left');
  Tactical.advance(current, 10);
  const orbit = aircraft.orbit;
  assert.throws(() => Tactical.issueHeading(current, 'A', 'right', 361), /heading/);
  assert.equal(aircraft.orbit, orbit, 'an invalid replacement cannot cancel orbit');
  const before = { ...aircraft.plane };
  const result = Tactical.continueHeading(current, 'A', 219);
  assert.equal(result.turn.side, 'left');
  assert.equal(aircraft.orbit, null);
  assert.equal(aircraft.forcedTurnSide, 'left');
  assert.equal(aircraft.targetHeading, 219);
  assert.deepEqual(aircraft.plane, before);
  assert.equal(orbitEvents(Tactical.advance(current, 240)).length, 0);
  assert.ok(headingError(aircraft.plane.heading, 219) < 1e-9);
  Tactical.startOrbit(current, 'A', 'right');
  Tactical.issueHeading(current, 'A', 'left', 63);
  assert.equal(aircraft.orbit, null);
});

test('U/S stop cancels orbit while a rejected new timed turn leaves it intact', () => {
  const current = exercise('us');
  const aircraft = Tactical.getAircraft(current, 'A');
  Tactical.startOrbit(current, 'A', 'right');
  Tactical.advance(current, 10);
  const orbit = aircraft.orbit;
  assert.equal(Tactical.startTurn(current, 'A', 'left'), null);
  assert.equal(aircraft.orbit, orbit);
  const before = { ...aircraft.plane };
  Tactical.stopTurn(current, 'A');
  assert.equal(aircraft.orbit, null);
  assert.equal(aircraft.manualTurnSide, null);
  assert.deepEqual(aircraft.plane, before);
  assert.ok(Tactical.startTurn(current, 'A', 'left'));
  assert.equal(aircraft.orbit, null);
  assert.equal(orbitEvents(Tactical.advance(current, 180)).length, 0);
});
