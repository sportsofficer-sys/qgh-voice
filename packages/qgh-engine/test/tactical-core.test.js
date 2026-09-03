'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Tactical = require('../tactical-core.js');
const Core = require('../simulator-core.js');

const STEP_SECONDS = .25;

function seededRandom(seed = 38703) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function fleet(count, overrides = {}) {
  const defaults = [
    { id: 'A', callsign: 'FALCON 11', color: '#007d7d', lineStyle: 'solid', type: 'fighter', speed: 360, rate: 3, distance: 12 },
    { id: 'B', callsign: 'RAVEN 21', color: '#296aa7', lineStyle: 'dash', type: 'transport', speed: 280, rate: 2, distance: 14 },
    { id: 'C', callsign: 'VIPER 31', color: '#a36316', lineStyle: 'dot', type: 'helicopter', speed: 150, rate: 3, distance: 10 },
    { id: 'D', callsign: 'HAWK 41', color: '#7b4e80', lineStyle: 'dashdot', type: 'fighter', speed: 320, rate: 2.5, distance: 16 }
  ];
  return defaults.slice(0, count).map(item => ({ ...item, ...overrides }));
}

function makeExercise(procedure = 'normal', count = 3, options = {}) {
  return Tactical.createExercise({
    procedure,
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: fleet(count),
    randomizeInitial: options.randomizeInitial ?? false,
    random: options.random || seededRandom()
  });
}

function headingError(from, to) {
  return Math.abs(Core.normalize(to - from + 180) - 180);
}

function formationOptions() {
  return { enabled: true, leaderId: 'A', memberIds: ['A', 'B', 'C'] };
}

function bodySlot(leader, follower) {
  const heading = Core.radians(leader.plane.heading);
  const deltaX = follower.plane.x - leader.plane.x;
  const deltaY = follower.plane.y - leader.plane.y;
  return {
    forward: deltaX * Math.sin(heading) - deltaY * Math.cos(heading),
    right: deltaX * Math.cos(heading) + deltaY * Math.sin(heading)
  };
}

test('Tactical QGH permits only 2–4 uniquely named aircraft', () => {
  assert.throws(
    () => Tactical.createExercise({ procedure: 'normal', runway: 230, outbound: 65, inbound: 225, aircraft: fleet(1) }),
    /2 to 4 aircraft/
  );
  assert.throws(
    () => Tactical.createExercise({ procedure: 'normal', runway: 230, outbound: 65, inbound: 225, aircraft: [...fleet(4), fleet(1)[0]] }),
    /2 to 4 aircraft/
  );
  const duplicate = fleet(2);
  duplicate[1].callsign = duplicate[0].callsign;
  assert.throws(
    () => Tactical.createExercise({ procedure: 'normal', runway: 230, outbound: 65, inbound: 225, aircraft: duplicate }),
    /unique callsign/
  );
});

test('every tactical aircraft receives an independently randomised starting state', () => {
  const exercise = makeExercise('normal', 4, { randomizeInitial: true, random: seededRandom(91) });
  const signatures = exercise.aircraft.map(aircraft => {
    const point = aircraft.path[0];
    return [point.x.toFixed(4), point.y.toFixed(4), point.heading.toFixed(2), aircraft.initialTurnSide || 'straight'].join('|');
  });
  assert.equal(new Set(signatures).size, 4);
});

test('random tactical starts do not place two aircraft at the same initial position', () => {
  const values = [0, 0, 0, 0, .004, 0, .25, .25, 0];
  let index = 0;
  const random = () => values[index++] ?? .5;
  const exercise = Tactical.createExercise({
    procedure: 'normal',
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: fleet(2, { distance: 10 }),
    randomizeInitial: true,
    random
  });
  const first = exercise.aircraft[0].path[0];
  const second = exercise.aircraft[1].path[0];
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) >= .75);
});

test('tactical aircraft receive automatic levels separated by 1000 ft', () => {
  const exercise = makeExercise('normal', 4);
  assert.deepEqual(exercise.aircraft.map(aircraft => aircraft.level), [6000, 7000, 8000, 9000]);
  const mixedLevels = fleet(3);
  mixedLevels[0].level = 7000;
  mixedLevels[1].level = '';
  mixedLevels[2].level = undefined;
  const mixedExercise = Tactical.createExercise({
    procedure: 'normal',
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: mixedLevels
  });
  assert.deepEqual(mixedExercise.aircraft.map(aircraft => aircraft.level), [7000, 6000, 8000]);
  assert.throws(
    () => Tactical.createExercise({
      procedure: 'normal',
      runway: 230,
      outbound: 65,
      inbound: 225,
      aircraft: fleet(2).map((aircraft, index) => ({ ...aircraft, level: 18000 + index * 500 }))
    }),
    /1000 ft/
  );
});

test('formation wingmen follow the leader through curved flight and detach on a direct heading command', () => {
  const exercise = Tactical.createExercise({
    procedure: 'normal',
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: fleet(3),
    formation: formationOptions(),
    randomizeInitial: false
  });
  const leader = Tactical.getAircraft(exercise, 'A');
  const wingman = Tactical.getAircraft(exercise, 'B');
  const remainingWingman = Tactical.getAircraft(exercise, 'C');
  const initialSlot = bodySlot(leader, wingman);

  Tactical.issueHeading(exercise, 'A', 'right', 180);
  Tactical.advance(exercise, 30);
  const formedSlot = bodySlot(leader, wingman);
  assert.equal(Tactical.formationRoleFor(exercise, 'A'), 'LEAD');
  assert.equal(Tactical.formationRoleFor(exercise, 'B'), 'FORMATION');
  assert.ok(Math.abs(initialSlot.forward - formedSlot.forward) < 1e-7);
  assert.ok(Math.abs(initialSlot.right - formedSlot.right) < 1e-7);
  assert.ok(headingError(wingman.plane.heading, leader.plane.heading) < 25);
  assert.ok(wingman.formationSpeed > 0);
  assert.equal(wingman.level, 7000);

  const result = Tactical.issueHeading(exercise, 'B', 'left', 120);
  assert.equal(Tactical.formationRoleFor(exercise, 'B'), 'INDEPENDENT');
  assert.equal(Tactical.formationRoleFor(exercise, 'C'), 'FORMATION');
  assert.ok(result.events.some(event => event.type === 'FORMATION BREAK'));
  Tactical.advance(exercise, 30);
  assert.ok(headingError(wingman.plane.heading, 120) < .01);
  assert.ok(headingError(leader.plane.heading, wingman.plane.heading) > 5);
  assert.ok(Tactical.rangeFor(remainingWingman) > 0);
});

test('a selected wingman can stop following and continue on its current heading', () => {
  const exercise = Tactical.createExercise({
    procedure: 'normal',
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: fleet(3),
    formation: formationOptions(),
    randomizeInitial: false
  });
  const leader = Tactical.getAircraft(exercise, 'A');
  const wingman = Tactical.getAircraft(exercise, 'B');
  Tactical.advance(exercise, 2);
  const heldHeading = wingman.plane.heading;
  const heldSpeed = wingman.formationSpeed;

  const result = Tactical.stopFollowingLeader(exercise, 'B');
  assert.ok(result.events.some(event => event.type === 'STOP FOLLOWING LEADER'));
  assert.equal(Tactical.formationRoleFor(exercise, 'B'), 'INDEPENDENT');
  assert.equal(Tactical.formationRoleFor(exercise, 'C'), 'FORMATION');
  assert.ok(headingError(wingman.targetHeading, heldHeading) < 1e-8);
  assert.ok(Math.abs(wingman.cfg.speed - heldSpeed) < 1e-8);
  assert.equal(Tactical.stopFollowingLeader(exercise, 'B'), null);

  Tactical.issueHeading(exercise, 'A', 'right', Core.normalize(leader.plane.heading + 90));
  Tactical.advance(exercise, 5);
  assert.ok(headingError(wingman.plane.heading, heldHeading) < .01);
  assert.ok(Math.hypot(
    wingman.plane.x - leader.plane.x - (wingman.path[0].x - leader.path[0].x),
    wingman.plane.y - leader.plane.y - (wingman.path[0].y - leader.path[0].y)
  ) > .01);
});

test('an individual U/S Compass turn releases only the selected formation wingman', () => {
  const exercise = Tactical.createExercise({
    procedure: 'us',
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: fleet(3),
    formation: formationOptions(),
    randomizeInitial: false
  });
  const result = Tactical.startTurn(exercise, 'C', 'right');
  assert.ok(result.events.some(event => event.type === 'FORMATION BREAK'));
  assert.equal(Tactical.formationRoleFor(exercise, 'A'), 'LEAD');
  assert.equal(Tactical.formationRoleFor(exercise, 'B'), 'FORMATION');
  assert.equal(Tactical.formationRoleFor(exercise, 'C'), 'INDEPENDENT');
  Tactical.advance(exercise, 5);
  assert.ok(Tactical.getAircraft(exercise, 'C').manualTurnSide === 'right');
});

test('an invalid individual heading command does not release a formation wingman', () => {
  const exercise = Tactical.createExercise({
    procedure: 'normal',
    runway: 230,
    outbound: 65,
    inbound: 225,
    aircraft: fleet(3),
    formation: formationOptions(),
    randomizeInitial: false
  });
  assert.throws(() => Tactical.issueHeading(exercise, 'B', 'left', 'invalid'), /heading/);
  assert.equal(Tactical.formationRoleFor(exercise, 'B'), 'FORMATION');
});

test('commands affect only the selected tactical aircraft while the rest continue moving', () => {
  const exercise = makeExercise('normal', 2);
  const selected = Tactical.getAircraft(exercise, 'A');
  const other = Tactical.getAircraft(exercise, 'B');
  selected.plane.heading = 0;
  other.plane.heading = 90;
  other.targetHeading = 90;
  const otherStart = { ...other.plane };

  Tactical.issueHeading(exercise, 'A', 'right', 90);
  Tactical.advance(exercise, 30);

  assert.ok(headingError(selected.plane.heading, 90) < .01, 'selected aircraft should achieve its assigned heading');
  assert.equal(other.targetHeading, 90, 'other aircraft retains its own heading state');
  assert.notDeepEqual(other.plane, otherStart, 'other aircraft should continue flying during a selected-aircraft command');
});

test('D/F bearing belongs to the requested aircraft and changes with its flight path', () => {
  const exercise = makeExercise('normal', 2);
  const falcon = Tactical.getAircraft(exercise, 'A');
  const raven = Tactical.getAircraft(exercise, 'B');
  falcon.plane = { x: 10, y: 0, heading: 0 };
  raven.plane = { x: -10, y: 0, heading: 270 };
  raven.targetHeading = 270;

  assert.equal(Tactical.bearingFor(falcon).qdm, 270);
  assert.equal(Tactical.bearingFor(raven).qdm, 90);
  Tactical.issueHeading(exercise, 'A', 'right', 90);
  Tactical.advance(exercise, 20);
  assert.notEqual(Tactical.bearingFor(falcon).qdm, 270, 'moving the transmitting aircraft must change its D/F homing bearing');
  assert.equal(Tactical.bearingFor(raven).qdm, 90, 'the uncommanded aircraft bearing remains tied to its own position');
});

test('per-aircraft turns respect selected rate of turn and curved-flight radius', () => {
  const exercise = makeExercise('normal', 2);
  const aircraft = Tactical.getAircraft(exercise, 'A');
  aircraft.plane.heading = 0;
  aircraft.path = [{ ...aircraft.plane }];
  Tactical.issueHeading(exercise, 'A', 'right', 90);
  Tactical.advance(exercise, 30);

  for (let index = 1; index < aircraft.path.length; index += 1) {
    const before = aircraft.path[index - 1];
    const after = aircraft.path[index];
    assert.ok(
      headingError(before.heading, after.heading) <= aircraft.cfg.rate * STEP_SECONDS + 1e-7,
      'heading change must remain constrained by that aircraft’s selected rate of turn'
    );
  }
  assert.ok(
    Math.abs(Core.turnRadiusNm(aircraft.cfg.speed, aircraft.cfg.rate) - 1.90986) < .0001,
    'turn radius remains derived from the aircraft speed and turn rate'
  );
});

test('one-minute advance moves every active aircraft through exactly 240 physical samples', () => {
  const exercise = makeExercise('us', 4);
  const before = exercise.aircraft.map(aircraft => ({ position: { ...aircraft.plane }, samples: aircraft.path.length }));

  Tactical.advance(exercise, 60);

  exercise.aircraft.forEach((aircraft, index) => {
    assert.equal(aircraft.path.length, before[index].samples + 240);
    assert.notDeepEqual(aircraft.plane, before[index].position);
  });
  assert.equal(exercise.simulationSeconds, 60);
});

test('Normal and U/S tactical exercises remain physically bounded across randomized 2–4 aircraft fleets', () => {
  const random = seededRandom(7123);
  ['normal', 'us'].forEach(procedure => {
    [2, 3, 4].forEach(count => {
      for (let run = 0; run < 10; run += 1) {
        const exercise = makeExercise(procedure, count, { randomizeInitial: true, random });
        const active = exercise.aircraft[run % count];
        const target = Core.normalize(active.plane.heading + (run % 2 === 0 ? 90 : -110));
        if (procedure === 'normal') {
          Tactical.issueHeading(exercise, active.id, run % 2 === 0 ? 'right' : 'left', target);
        } else {
          Tactical.startTurn(exercise, active.id, run % 2 === 0 ? 'right' : 'left');
        }
        Tactical.advance(exercise, 12);
        if (procedure === 'us') Tactical.stopTurn(exercise, active.id);
        Tactical.advance(exercise, 6);
        exercise.aircraft.forEach(aircraft => {
          assert.ok(aircraft.path.length > 70, [procedure, count, run, 'records all aircraft'].join('/'));
          for (let index = 1; index < aircraft.path.length; index += 1) {
            const before = aircraft.path[index - 1];
            const after = aircraft.path[index];
            const stepDistance = Math.hypot(after.x - before.x, after.y - before.y);
            assert.ok(stepDistance <= aircraft.cfg.speed * STEP_SECONDS / 3600 + 1e-7);
            assert.ok(headingError(before.heading, after.heading) <= aircraft.cfg.rate * STEP_SECONDS + 1e-7);
          }
        });
      }
    });
  });
});
