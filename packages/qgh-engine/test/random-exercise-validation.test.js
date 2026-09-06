const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Core = require('../simulator-core.js');
const Radio = require('../radio-session.js');
const SIMULATOR_PATH = path.join(__dirname, '..', 'simulator.js');
const STEP_SECONDS = .25;
const OVERHEAD_ZONE_NM = .25;

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach(name => this.values.add(name));
  }

  remove(...names) {
    names.forEach(name => this.values.delete(name));
  }

  toggle(name, force) {
    const selected = force === undefined ? !this.values.has(name) : Boolean(force);
    if (selected) this.values.add(name);
    else this.values.delete(name);
    return selected;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(id, value = '') {
    this.id = id;
    this.value = value;
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name) {
    (this.listeners.get(name) || []).forEach(listener => listener({ currentTarget: this, target: this }));
  }

  click() {
    if (!this.disabled) this.dispatch('click');
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }
}

function headingError(from, to) {
  return Math.abs(Core.normalize(to - from + 180) - 180);
}

function qdmFor(plane) {
  const qte = Core.normalize(Math.atan2(plane.x, -plane.y) * 180 / Math.PI);
  return Core.normalize(qte + 180);
}

function directedDegrees(from, to, side) {
  return side === 'right'
    ? Core.normalize(to - from)
    : Core.normalize(from - to);
}

function selectedSide(from, to, longerWay) {
  const shortest = Core.normalize(to - from + 180) - 180;
  const shortSide = shortest >= 0 ? 'right' : 'left';
  return longerWay ? (shortSide === 'right' ? 'left' : 'right') : shortSide;
}

function numericBearing(element) {
  const match = /^(\d{3})°$/.exec(element.textContent);
  assert.ok(match, `expected a live D/F bearing, received ${element.textContent || 'empty'}`);
  return Number(match[1]);
}

function makeHarness() {
  const defaults = {
    runway: '230', inbound: '225', outbound: '065', aircraft: 'fighter', distance: '8', speed: '360', rate: '4',
    headingInput: '225', liveSpeed: '360', callsign: 'FALCON 11'
  };
  const ids = [
    'setup', 'console', 'analysis', 'runway', 'inbound', 'outbound', 'aircraft', 'distance', 'speed', 'rate', 'callsign',
    'normal', 'us', 'startExercise', 'consoleTitle', 'badge', 'mobileControlsToggle', 'controls', 'transmit',
    'terminate', 'advanceFlight', 'infoRow', 'requestHeading', 'headingReply', 'requestDistance', 'distanceReply', 'normalCtl',
    'turnHeadingLeft', 'headingInput', 'turnHeadingRight', 'continueHeading', 'usCtl', 'turnLeft', 'turnRight', 'turnStop', 'liveSpeed',
    'orbitLeft', 'orbitRight', 'continueOrbit', 'resumeNormal',
    'clock', 'homingClock', 'clockStart', 'clockStop', 'clockReset', 'restartExercise', 'dfState', 'bearingType', 'bearing', 'signal',
    'qdm', 'qte', 'sumRunway', 'sumOutbound', 'sumInbound', 'sumProcedure', 'sumInitial', 'sumTerminal', 'sumSpeed',
    'sumTx', 'sumOverheadTurn', 'sumBaseTurn', 'plot', 'replayElapsed', 'returnConsole', 'replay', 'newExercise', 'logs', 'toast'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id, defaults[id]) ]));
  elements.homingClock.hidden = true;
  const replayButtons = [1, 2, 3, 10].map(speed => {
    const button = new FakeElement(`replay-${speed}`);
    button.dataset.replaySpeed = String(speed);
    return button;
  });
  const document = {
    getElementById: id => elements[id],
    querySelectorAll: selector => selector === '[data-replay-speed]' ? replayButtons : [],
    createElement: name => new FakeElement(name)
  };

  let intervalId = 0;
  let timeoutId = 0;
  const intervals = new Map();
  const timeouts = new Map();
  let randomState = 0x5a17c0de;
  let radioNow = 0;
  const reviewModels = [];
  const context = {
    document,
    console,
    Uint32Array,
    setInterval: callback => {
      const id = ++intervalId;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: id => intervals.delete(id),
    setTimeout: (callback, delay = 0) => {
      const id = ++timeoutId;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timeouts.delete(id),
    alert: message => { throw new Error(`unexpected alert: ${message}`); },
    QGHCore: Core,
    QGHRadioSession: { ...Radio, createReceiver: options => Radio.createReceiver({ ...options, now: () => radioNow }) },
    QGHReview: { draw: model => reviewModels.push(model) },
    crypto: {
      getRandomValues(values) {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        values[0] = randomState;
        return values;
      }
    }
  };
  context.window = context;
  vm.createContext(context);
  const source = fs.readFileSync(SIMULATOR_PATH, 'utf8').replace(
    /\n\}\)\(\);\s*$/,
    '\n  window.__qghTestState = state;\n})();\n'
  );
  vm.runInContext(source, context, { filename: SIMULATOR_PATH });

  return {
    elements,
    state: context.__qghTestState,
    reviewModels,
    enableRadio() {
      const captions = [];
      context.QGHVoiceWorkspace = { isDispatchingRadioCommand: () => false, setPilotSpeaking() {}, showPilotReply: reply => captions.push(reply.text) };
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'radio-workspace.js'), 'utf8'), context);
      return { captions, workspace: context.QGHRadioWorkspace };
    },
    fireDelay(delay) {
      const entry = [...timeouts].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `missing ${delay}ms timer`);
      timeouts.delete(entry[0]); entry[1].callback();
    },
    click(id) {
      elements[id].click();
    },
    input(id) {
      elements[id].dispatch('input');
    },
    change(id) {
      elements[id].dispatch('change');
    },
    tick(count) {
      for (let step = 0; step < count; step += 1) {
        [...intervals.values()].forEach(callback => callback());
      }
    },
    advanceRadioTime(milliseconds) {
      radioNow += milliseconds;
      [...intervals.values()].forEach(callback => callback());
    },
    fireTimeout(id) {
      const timeout = timeouts.get(id);
      assert.ok(timeout, `missing timeout ${id}`);
      timeouts.delete(id);
      timeout.callback();
    },
    timeoutDelay(id) {
      const timeout = timeouts.get(id);
      assert.ok(timeout, `missing timeout ${id}`);
      return timeout.delay;
    },
    clickReplaySpeed(speed) {
      const button = replayButtons.find(item => Number(item.dataset.replaySpeed) === speed);
      assert.ok(button, `missing replay speed ${speed}`);
      button.click();
    }
  };
}

test('single orbit buttons repeat a curved circle, report with DF and resume the actual entry heading in both procedures', () => {
  for (const procedure of ['normal', 'us']) for (const side of ['left', 'right']) {
    const h = makeHarness(); h.click(procedure); h.click('startExercise');
    const radio = h.enableRadio();
    h.state.plane.heading = 350; h.state.targetHeading = 120;
    const entry = { ...h.state.plane };
    h.click(side === 'left' ? 'orbitLeft' : 'orbitRight');
    assert.deepEqual({ ...h.state.plane }, entry, 'command never teleports the aircraft');
    radio.workspace.interrupt();
    h.tick(360);
    assert.ok(Math.hypot(h.state.plane.x - entry.x, h.state.plane.y - entry.y) < 1e-8);
    assert.equal(h.state.orbit.laps, 1); h.fireDelay(300);
    assert.match(radio.captions.at(-1), /ORBIT COMPLETE, CONTINUING/);
    assert.equal(h.elements.dfState.textContent, 'SIGNAL LIVE');
    h.tick(20); const progress = h.state.orbit.degrees;
    h.click('continueOrbit'); assert.equal(h.state.orbit.degrees, progress);
    h.click('resumeNormal'); assert.equal(h.state.orbit.exitRequested, true);
    h.tick(341);
    assert.equal(h.state.orbit, null);
    assert.equal(h.state.plane.heading, 350);
    assert.equal(h.state.manualTurnSide, null);
    assert.equal(h.elements.resumeNormal.disabled, true);
    assert.equal(h.elements.continueOrbit.disabled, true);
    assert.equal(h.elements.turnStop.disabled, true);
    if (procedure === 'us') assert.equal(h.elements.requestHeading.hidden, true);
  }
});

test('single orbit manual override, Continue 060 and one-minute advance keep existing flight controls', () => {
  const h = makeHarness(); h.click('startExercise');
  h.state.plane.heading = 210; h.click('orbitLeft'); h.click('advanceFlight');
  assert.equal(h.state.orbit.degrees, 240);
  h.elements.headingInput.value = '60'; h.click('continueHeading');
  assert.equal(h.state.orbit, null);
  assert.equal(h.state.forcedTurnSide, 'left');
  assert.equal(h.state.targetHeading, 60);
  h.click('orbitRight'); h.click('resumeNormal');
  assert.equal(h.state.orbit, null, 'resume at exact entry can roll out immediately');
});

test('real single-aircraft physics fires a deferred report without commanding a turn, including Advance', () => {
  for (const advance of [false, true]) {
    const h = makeHarness(); h.click('startExercise');
    const radio = h.enableRadio();
    h.state.plane.heading = 350; h.state.initialTurnSide = 'right';
    const before = { ...h.state.plane };
    const targetBefore = h.state.targetHeading;
    assert.equal(radio.workspace.requestHeadingPassing({ heading: 360 }).ok, true);
    assert.deepEqual({ ...h.state.plane }, before);
    assert.equal(h.state.targetHeading, targetBefore);
    if (advance) h.click('advanceFlight'); else h.tick(14);
    h.fireDelay(300);
    assert.match(radio.captions.at(-1), advance ? /^HEADING PASSED 000/ : /^HEADING PASSING 000/);
    assert.equal(h.elements.dfState.textContent, 'SIGNAL LIVE');
    assert.ok(h.state.commands.some(command => command.detail.includes('PASSED 000')));
  }
});

test('manual controller override changes the real flight before its replacement readback starts', () => {
  const h = makeHarness();
  h.click('startExercise');
  const radio = h.enableRadio();
  h.state.plane.heading = 350;
  h.elements.headingInput.value = '60'; h.click('turnHeadingRight'); h.tick(2); h.fireDelay(300);
  assert.match(radio.captions.at(-1), /TURNING RIGHT 060/);
  const before = { ...h.state.plane };
  h.elements.headingInput.value = '10'; h.click('turnHeadingLeft');
  assert.equal(h.state.forcedTurnSide, 'left');
  assert.equal(h.state.targetHeading, 10);
  assert.deepEqual({ ...h.state.plane }, before, 'no point-turn or position teleport on command');
  h.tick(1);
  assert.equal(h.state.plane.heading, Core.normalize(before.heading - h.state.cfg.rate * STEP_SECONDS));
  h.fireDelay(300);
  assert.match(radio.captions.at(-1), /TURNING LEFT 010/);
});

test('manual single speed replaces a pending reply immediately without acknowledging invalid edits', () => {
  const h = makeHarness();
  h.click('startExercise');
  const radio = h.enableRadio();
  radio.workspace.controllerStart();
  for (const speed of [240, 300]) {
    h.elements.liveSpeed.value = String(speed);
    h.input('liveSpeed'); h.change('liveSpeed');
  }
  assert.equal(h.state.cfg.speed, 300, 'accepted speed changes take effect before playback');
  assert.equal(radio.workspace.status().pending, 1, 'only the current speed should be read back');
  radio.workspace.controllerEnd(); h.fireDelay(300);
  assert.deepEqual(radio.captions, ['SPEED 300 KT · FALCON 11']);
  for (const speed of [300, 59, 601, 'invalid']) {
    h.elements.liveSpeed.value = String(speed);
    h.input('liveSpeed'); h.change('liveSpeed');
  }
  assert.equal(h.state.cfg.speed, 300);
  assert.equal(radio.workspace.status().pending, 0);
  assert.deepEqual(radio.captions, ['SPEED 300 KT · FALCON 11']);
});

test('the homing stopwatch mirrors the existing clock, stops, resumes and clears on reset', () => {
  for (const procedure of ['normal', 'us']) {
    const harness = makeHarness();
    const { elements, state } = harness;
    harness.click(procedure === 'normal' ? 'normal' : 'us');
    harness.click('startExercise');
    assert.equal(elements.homingClock.hidden, true);
    harness.click('clockStart');
    assert.equal(elements.homingClock.hidden, false);
    assert.equal(elements.homingClock.textContent, '00:00');
    harness.tick(2);
    assert.equal(elements.homingClock.textContent, '00:02');
    assert.equal(elements.homingClock.textContent, elements.clock.textContent);
    harness.click('clockStart');
    harness.tick(1);
    assert.equal(elements.homingClock.textContent, '00:03', 'a second Start must not duplicate the timer');
    harness.click('clockStop');
    harness.tick(2);
    assert.equal(elements.homingClock.textContent, '00:03');
    assert.equal(elements.homingClock.hidden, false);
    assert.match(elements.homingClock.getAttribute('aria-label'), /stopped/);
    harness.click('clockStart');
    state.clockSeconds = 59;
    harness.tick(1);
    assert.equal(elements.homingClock.textContent, '01:00');
    harness.click('clockReset');
    assert.equal(elements.homingClock.hidden, true);
    assert.equal(elements.homingClock.textContent, '00:00');
    assert.equal(state.clockRunning, false);
  }
});

function setExercise(harness, scenario, procedure) {
  const { elements } = harness;
  elements.runway.value = String(scenario.runway);
  elements.inbound.value = String(scenario.inbound);
  elements.outbound.value = String(scenario.outbound);
  elements.aircraft.value = scenario.aircraft;
  elements.distance.value = String(scenario.distance);
  elements.speed.value = String(scenario.speed);
  elements.rate.value = String(scenario.rate);
  harness.click(procedure === 'normal' ? 'normal' : 'us');
  harness.click('startExercise');
  assert.equal(elements.console.classList.contains('active'), true, 'exercise should enter the console');
  assert.equal(elements.bearing.textContent, '---', 'D/F must be blank before a transmission');
  harness.click('transmit');
  numericBearing(elements.bearing);
  harness.fireTimeout(harness.state.dfExpiry);
  const held = elements.bearing.textContent;
  assert.equal(elements.dfState.textContent, 'SIGNAL HELD');
  harness.tick(4);
  assert.equal(elements.bearing.textContent, held, 'D/F freezes while the aircraft keeps flying');
  harness.advanceRadioTime(2000);
  assert.equal(elements.bearing.textContent, '---', 'D/F clears after the two-second hold');
  harness.click('transmit');
}

test('single-aircraft setup accepts a standalone numeric callsign from 100 to 999', () => {
  const h = makeHarness();
  h.elements.callsign.value = '387';
  h.click('startExercise');
  assert.equal(h.state.cfg.callsign, '387');
  assert.equal(h.elements.badge.textContent, '387 · NORMAL QGH');
});

test('Single U/S Compass controls allow immediate opposite-turn reversal without a flight-state jump', () => {
  const h = makeHarness();
  h.click('us');
  h.click('startExercise');
  h.state.initialTurnSide = null;
  h.state.targetHeading = h.state.plane.heading;
  h.click('turnLeft');
  h.tick(8);
  const beforeReverse = { ...h.state.plane };
  const headingAtReverse = h.state.plane.heading;
  assert.equal(h.elements.turnRight.disabled, false, 'the opposite U/S direction must remain available');
  assert.equal(h.elements.turnLeft.getAttribute('aria-pressed'), 'true');

  h.click('turnRight');
  assert.equal(h.state.plane.x, beforeReverse.x, 'an immediate reversal must not point-turn or teleport the aircraft');
  assert.equal(h.state.plane.y, beforeReverse.y, 'an immediate reversal must not point-turn or teleport the aircraft');
  assert.equal(h.state.plane.heading, beforeReverse.heading, 'an immediate reversal must not point-turn or teleport the aircraft');
  assert.equal(h.state.manualTurnSide, 'right');
  assert.equal(h.elements.turnRight.getAttribute('aria-pressed'), 'true');
  assert.equal(h.elements.turnLeft.getAttribute('aria-pressed'), 'false');

  h.tick(1);
  assert.equal(h.state.plane.heading, Core.normalize(headingAtReverse + h.state.cfg.rate * STEP_SECONDS));
  h.click('turnStop');
  assert.equal(h.state.manualTurnSide, null);
  assert.equal(h.elements.turnStop.disabled, true);
});

function turnNormalTo(harness, target, longerWay = false) {
  const state = harness.state;
  const from = state.plane.heading;
  const side = selectedSide(from, target, longerWay);
  harness.elements.headingInput.value = String(target);
  harness.click(side === 'left' ? 'turnHeadingLeft' : 'turnHeadingRight');
  const steps = Math.ceil(directedDegrees(from, target, side) / (state.cfg.rate * STEP_SECONDS)) + 2;
  harness.tick(steps);
  assert.ok(headingError(state.plane.heading, target) < .01, 'Normal QGH heading turn should stop on its assigned heading');
  return side;
}

function turnUsTo(harness, target, longerWay = false) {
  const state = harness.state;
  const from = state.plane.heading;
  const side = selectedSide(from, target, longerWay);
  harness.click(side === 'left' ? 'turnLeft' : 'turnRight');
  const degrees = directedDegrees(from, target, side);
  const steps = Math.floor(degrees / (state.cfg.rate * STEP_SECONDS));
  harness.tick(steps);
  harness.click('turnStop');
  harness.tick(3);
  assert.ok(headingError(state.plane.heading, target) <= 2.1, 'U/S timed turn should stop within the procedure tolerance');
  return side;
}

function flyToOverhead(harness, procedure, index) {
  const turnTo = procedure === 'normal' ? turnNormalTo : turnUsTo;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (harness.state.phase !== 'recovery') return;
    const target = qdmFor(harness.state.plane);
    turnTo(harness, target, attempt % 4 === 3 && index % 2 === 1);
    harness.tick(18);
  }
  assert.notEqual(harness.state.phase, 'recovery', `${procedure} exercise ${index + 1} did not pass overhead`);
}

function checkCurvedFlightPath(model, maxSpeed, rate, label) {
  assert.ok(model.path.length > 100, `${label} should record a substantial flight path`);
  const maximumStep = maxSpeed * STEP_SECONDS / 3600 + 1e-7;
  for (let index = 1; index < model.path.length; index += 1) {
    const previous = model.path[index - 1];
    const next = model.path[index];
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
    assert.ok(distance <= maximumStep, `${label} contains a non-physical position jump at sample ${index}`);
    assert.ok(
      headingError(previous.heading, next.heading) <= rate * STEP_SECONDS + 1e-7,
      `${label} exceeds the selected turn rate at sample ${index}`
    );
  }
}

function executeExercise(harness, scenario, procedure, index) {
  setExercise(harness, scenario, procedure);
  const { state, elements } = harness;
  const initialSignature = `${state.path[0].x.toFixed(5)}|${state.path[0].y.toFixed(5)}|${state.path[0].heading}`;
  const initialQdm = numericBearing(elements.bearing);
  assert.equal(initialQdm, Math.round(qdmFor(state.plane)), 'D/F must match the aircraft position');

  if (procedure === 'us') {
    if (state.initialTurnSide) {
      assert.equal(elements.turnStop.disabled, false, 'U/S must permit stopping a randomized initial turn');
      harness.click('turnStop');
    } else {
      harness.click('turnRight');
      harness.tick(3);
      harness.click('turnStop');
    }
    assert.equal(elements.turnLeft.disabled, false, 'U/S left turn must be available after stop');
    assert.equal(elements.turnRight.disabled, false, 'U/S right turn must be available after stop');
    assert.equal(elements.turnStop.disabled, true, 'U/S stop must disable once levelled');
  }

  flyToOverhead(harness, procedure, index);
  assert.equal(state.phase, 'overhead', `${procedure} should classify the continuous crossing as overhead`);

  const turnTo = procedure === 'normal' ? turnNormalTo : turnUsTo;
  const overheadSide = turnTo(harness, state.cfg.outbound, index % 2 === 1);
  harness.tick(8);
  assert.equal(state.phase, 'outbound', `${procedure} should establish outbound after the overhead turn`);

  const changedSpeed = Math.min(600, state.cfg.speed + 40);
  elements.liveSpeed.value = String(changedSpeed);
  harness.input('liveSpeed');
  assert.equal(state.cfg.speed, changedSpeed, `${procedure} live speed must take effect immediately`);
  harness.change('liveSpeed');
  harness.tick(54);

  const baseSide = turnTo(harness, state.cfg.inbound, index % 3 === 2);
  harness.tick(8);
  assert.equal(state.phase, 'inbound', `${procedure} should establish inbound after the base turn`);
  harness.tick(32);
  harness.click('terminate');

  const model = harness.reviewModels.at(-1);
  assert.ok(model, `${procedure} should produce a final review`);
  assert.equal(elements.analysis.classList.contains('active'), true, `${procedure} should show final review`);
  assert.equal(model.cfg.runway, scenario.runway, `${procedure} final review must retain runway input`);
  assert.equal(model.cfg.outbound, scenario.outbound, `${procedure} final review must retain outbound input`);
  assert.equal(model.cfg.inbound, scenario.inbound, `${procedure} final review must retain inbound input`);
  assert.equal(model.turns.overhead.side, overheadSide, `${procedure} final review must retain overhead turn direction`);
  assert.equal(model.turns.base.side, baseSide, `${procedure} final review must retain base turn direction`);
  assert.equal(elements.sumTerminal.textContent.endsWith(' NM'), true, `${procedure} final review should display terminal range`);
  assert.equal(elements.sumSpeed.textContent, `${changedSpeed} KT`, `${procedure} final review should display the live speed`);
  checkCurvedFlightPath(model, changedSpeed, scenario.rate, `${procedure} exercise ${index + 1}`);

  return initialSignature;
}

function assertAdvanceFlightOneMinute(procedure) {
  const harness = makeHarness();
  const scenario = { runway: 230, outbound: 65, inbound: 225, aircraft: 'fighter', distance: 8, speed: 360, rate: 4 };
  setExercise(harness, scenario, procedure);
  const { elements, state } = harness;
  const initialClock = state.clockSeconds;
  const firstPoint = state.path.at(-1);
  const firstHeading = state.plane.heading;
  const startingPathLength = state.path.length;

  if (procedure === 'normal') {
    elements.headingInput.value = String(Core.normalize(firstHeading + 90));
    harness.click('turnHeadingRight');
  } else {
    if (state.initialTurnSide) harness.click('turnStop');
    harness.click('turnRight');
  }

  harness.click('advanceFlight');
  const advancedPath = state.path.slice(startingPathLength - 1);
  assert.equal(state.path.length, startingPathLength + 240, `${procedure} must integrate exactly one minute at 0.25-second steps`);
  assert.equal(state.clockSeconds, initialClock, `${procedure} must not change the controller stopwatch`);
  assert.equal(state.commands.at(-1).type, 'ADVANCE FLIGHT · 1 MIN', `${procedure} must record the advance command`);
  assert.notDeepEqual(state.path.at(-1), firstPoint, `${procedure} advance must move the aircraft`);
  checkCurvedFlightPath({ path: advancedPath }, state.cfg.speed, state.cfg.rate, `${procedure} one-minute advance`);
}

test('Advance Flight by 1 Minute retains physical flight behaviour in Normal QGH and U/S Compass', () => {
  assertAdvanceFlightOneMinute('normal');
  assertAdvanceFlightOneMinute('us');
});

test('continue-heading holds the active Normal QGH turn direction while amending its target', () => {
  const harness = makeHarness();
  const scenario = { runway: 230, outbound: 65, inbound: 225, aircraft: 'fighter', distance: 8, speed: 360, rate: 4 };
  setExercise(harness, scenario, 'normal');
  const { elements, state } = harness;
  state.plane.heading = 330;
  state.targetHeading = 330;
  elements.headingInput.value = '120';
  harness.click('turnHeadingRight');
  harness.tick(12);
  elements.headingInput.value = '060';
  harness.click('continueHeading');

  assert.equal(state.forcedTurnSide, 'right');
  assert.equal(state.targetHeading, 60);
  assert.match(state.commands.at(-1).type, /CONTINUE RIGHT/);
  harness.tick(Math.ceil(360 / (state.cfg.rate * STEP_SECONDS)) + 4);
  assert.ok(headingError(state.plane.heading, 60) < .01);
});

test('replay keeps the fast 1× baseline, supports 10×, and pauses without losing its cursor', () => {
  const harness = makeHarness();
  const scenario = { runway: 230, outbound: 65, inbound: 225, aircraft: 'fighter', distance: 8, speed: 360, rate: 4 };
  setExercise(harness, scenario, 'normal');
  harness.tick(24);
  harness.click('terminate');
  harness.click('replay');

  assert.equal(harness.timeoutDelay(harness.state.replayTimer), 37, '1× replay must use the fast review baseline');
  assert.equal(harness.elements.replayElapsed.textContent, 'REPLAY 00:00', 'replay must start with a minimal elapsed-time readout');
  harness.fireTimeout(harness.state.replayTimer);
  assert.equal(harness.state.replayIndex, 2, '1× replay must advance one recorded point per frame');

  harness.clickReplaySpeed(3);
  assert.equal(harness.timeoutDelay(harness.state.replayTimer), 37, '3× replay keeps a smooth frame cadence');
  assert.equal(harness.elements.replay.textContent, 'PAUSE REPLAY', 'changing speed during replay must retain the active replay state');
  assert.equal(harness.elements.replay.getAttribute('aria-pressed'), 'true', 'the replay button must remain pressed while replay continues');
  harness.fireTimeout(harness.state.replayTimer);
  assert.equal(harness.state.replayIndex, 5, '3× replay must advance three recorded points per frame');
  assert.equal(harness.elements.replayElapsed.textContent, 'REPLAY 00:01', 'replay elapsed time must follow the moving cursor');

  harness.clickReplaySpeed(10);
  assert.equal(harness.timeoutDelay(harness.state.replayTimer), 37, '10× replay keeps the same smooth frame cadence');
  harness.fireTimeout(harness.state.replayTimer);
  assert.equal(harness.state.replayIndex, 15, '10× replay must advance ten recorded points per frame');

  harness.click('replay');
  assert.equal(harness.state.replayPaused, true, 'replay control must pause at the current cursor');
  assert.equal(harness.state.replayTimer, null, 'pausing must cancel the active replay frame');
  const pausedIndex = harness.state.replayIndex;
  harness.click('replay');
  assert.equal(harness.state.replayPaused, false, 'replay control must resume without restart');
  assert.equal(harness.state.replayIndex, pausedIndex, 'resume must retain the current replay cursor');
  assert.equal(harness.timeoutDelay(harness.state.replayTimer), 37, 'resume must retain the selected replay cadence');
});

function buildScenarios() {
  const aircraft = ['fighter', 'transport', 'helicopter', 'tejas', 'c130', 'mi17'];
  const scenarios = [{ runway: 230, outbound: 65, inbound: 225, aircraft: 'fighter', distance: 8, speed: 360, rate: 4 }];
  let seed = 38703;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  while (scenarios.length < 10) {
    const inbound = next() % 360;
    scenarios.push({
      runway: next() % 360,
      outbound: next() % 360,
      inbound,
      aircraft: aircraft[next() % aircraft.length],
      distance: 6 + (next() % 8),
      speed: 220 + (next() % 6) * 40,
      rate: 2 + (next() % 5) * .5
    });
  }
  return scenarios;
}

test('runs 10 Normal QGH and 10 U/S Compass randomized exercises through the live simulator controls', () => {
  const harness = makeHarness();
  const scenarios = buildScenarios();
  const signatures = [];

  scenarios.forEach((scenario, index) => {
    signatures.push(executeExercise(harness, scenario, 'normal', index));
  });
  scenarios.forEach((scenario, index) => {
    signatures.push(executeExercise(harness, scenario, 'us', index));
  });

  assert.equal(new Set(signatures).size, 20, 'each validated exercise must have a unique randomized start state');
});
