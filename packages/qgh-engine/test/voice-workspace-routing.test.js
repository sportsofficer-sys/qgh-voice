'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Voice = require('../voice-control.js');
const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'voice-workspace.js'), 'utf8');

class FakeClassList {
  constructor(values) {
    this.values = new Set(values || []);
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  remove(...values) {
    values.forEach(value => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeEvent {
  constructor(type, options) {
    this.type = type;
    Object.assign(this, options || {});
    this.defaultPrevented = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  constructor(tagName, options) {
    const settings = options || {};
    this.tagName = String(tagName || 'div').toLowerCase();
    this.id = settings.id || '';
    this.type = settings.type || '';
    this.min = settings.min ?? '';
    this.max = settings.max ?? '';
    this.value = settings.value ?? '';
    this.textContent = settings.textContent || '';
    this.disabled = Boolean(settings.disabled);
    this.hidden = Boolean(settings.hidden);
    this.dataset = Object.assign({}, settings.dataset);
    this.style = {};
    this.classList = new FakeClassList(settings.classes);
    Object.defineProperty(this, 'className', {
      get: () => [...this.classList.values].join(' '),
      set: value => {
        this.classList = new FakeClassList(String(value || '').split(/\s+/).filter(Boolean));
      }
    });
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map(Object.entries(settings.attributes || {}));
    this.listeners = new Map();
    this.events = [];
    this.clickCount = 0;
    this.focusCount = 0;
    this.onClick = settings.onClick || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  appendChild(child) {
    if (!child || typeof child !== 'object') return child;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target = this;
    this.events.push(event);
    (this.listeners.get(event.type) || []).forEach(listener => listener.call(this, event));
    return !event.defaultPrevented;
  }

  click() {
    if (this.disabled) return;
    this.clickCount += 1;
    this.dispatchEvent(new FakeEvent('click'));
    if (this.onClick) this.onClick(this);
  }

  focus(options) {
    this.focusCount += 1;
    this.focusOptions = options;
  }

  matches(selector) {
    const normalized = selector.trim();
    if (normalized === '[hidden]') return this.hidden || this.attributes.has('hidden');
    if (normalized.startsWith('#')) return this.id === normalized.slice(1);
    if (normalized.startsWith('.')) {
      const classAndAttribute = normalized.match(/^\.([\w-]+)(?:\[data-([\w-]+)="([^"]+)"\])?$/);
      if (!classAndAttribute) return false;
      if (!this.classList.contains(classAndAttribute[1])) return false;
      if (!classAndAttribute[2]) return true;
      return this.dataset[dataKey(classAndAttribute[2])] === classAndAttribute[3];
    }
    const dataAttributes = [...normalized.matchAll(/\[data-([\w-]+)(?:="([^"]+)")?\]/g)];
    if (dataAttributes.length && dataAttributes.map(match => match[0]).join('') === normalized) {
      return dataAttributes.every(([, name, value]) => (
        Object.prototype.hasOwnProperty.call(this.dataset, dataKey(name))
        && (value === undefined || this.dataset[dataKey(name)] === value)
      ));
    }
    const option = normalized.match(/^option\[value="([^"]+)"\]$/);
    return Boolean(option && this.tagName === 'option' && this.value === option[1]);
  }

  closest(selector) {
    const selectors = selector.split(',').map(item => item.trim());
    for (let current = this; current; current = current.parentElement) {
      if (selectors.some(candidate => current.matches(candidate))) return current;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matched = [];
    const visit = node => {
      node.children.forEach(child => {
        if (child.matches(selector)) matched.push(child);
        visit(child);
      });
    };
    visit(this);
    return matched;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.elementsById = new Map();
    this.visibilityState = 'visible';
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  register(element) {
    if (element.id) this.elementsById.set(element.id, element);
    return element;
  }
}

function dataKey(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function add(documentRef, parent, tagName, options) {
  const element = documentRef.register(new FakeElement(tagName, options));
  parent.appendChild(element);
  return element;
}

function addScreen(documentRef, id) {
  return add(documentRef, documentRef.body, 'section', { id, classes: ['screen', 'tactical-screen'] });
}

function setActive(screens, screen) {
  screens.forEach(item => item.classList.remove('active'));
  screen.classList.add('active');
}

function createWorkspaceEnvironment(documentRef, additions) {
  const rootListeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    QGHVoiceControl: Voice,
    document: documentRef,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    clearTimeout(timer) { timers.delete(timer); },
    setTimeout(callback) {
      const timer = nextTimer;
      nextTimer += 1;
      timers.set(timer, callback);
      return timer;
    },
    addEventListener(type, listener) { rootListeners.set(type, listener); },
    location: { assign() {} }
  };
  Object.assign(sandbox, additions || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workspaceSource, sandbox);
  return { workspace: sandbox.QGHVoiceWorkspace, rootListeners, sandbox, timers };
}

function bootWorkspace(documentRef) {
  return createWorkspaceEnvironment(documentRef).workspace;
}

function createSingleHarness() {
  const documentRef = new FakeDocument();
  const setup = addScreen(documentRef, 'setup');
  const consoleScreen = addScreen(documentRef, 'console');
  const analysis = addScreen(documentRef, 'analysis');
  const screens = [setup, consoleScreen, analysis];
  const aircraft = add(documentRef, setup, 'select', { id: 'aircraft' });
  const customProfile = add(documentRef, aircraft, 'option', { value: 'custom-trainer', textContent: 'CUSTOM TRAINER' });
  aircraft.options = [customProfile];
  const controls = {
    aircraft,
    runway: add(documentRef, setup, 'input', { id: 'runway', type: 'number', min: '0', max: '359', value: '150' }),
    voiceCommandAck: add(documentRef, consoleScreen, 'output', { id: 'voiceCommandAck', hidden: true }),
    requestHeading: add(documentRef, consoleScreen, 'button', { id: 'requestHeading' }),
    headingReply: add(documentRef, consoleScreen, 'b', { id: 'headingReply', textContent: 'HEADING —' }),
    requestDistance: add(documentRef, consoleScreen, 'button', { id: 'requestDistance' }),
    distanceReply: add(documentRef, consoleScreen, 'b', { id: 'distanceReply', textContent: 'RANGE —' }),
    headingInput: add(documentRef, consoleScreen, 'input', { id: 'headingInput', type: 'number', min: '0', max: '359', value: '150' }),
    turnHeadingLeft: add(documentRef, consoleScreen, 'button', { id: 'turnHeadingLeft', textContent: 'TURN LEFT' }),
    turnHeadingRight: add(documentRef, consoleScreen, 'button', { id: 'turnHeadingRight', textContent: 'TURN RIGHT' }),
    continueHeading: add(documentRef, consoleScreen, 'button', { id: 'continueHeading', textContent: 'CONTINUE HEADING' }),
    turnLeft: add(documentRef, consoleScreen, 'button', { id: 'turnLeft', textContent: 'TURN LEFT NOW', hidden: true }),
    turnRight: add(documentRef, consoleScreen, 'button', { id: 'turnRight', textContent: 'TURN RIGHT NOW', hidden: true }),
    turnStop: add(documentRef, consoleScreen, 'button', { id: 'turnStop', hidden: true }),
    transmit: add(documentRef, consoleScreen, 'button', { id: 'transmit', textContent: 'TRANSMIT FOR D/F' }),
    restartExercise: add(documentRef, consoleScreen, 'button', { id: 'restartExercise', textContent: 'RESTART EXERCISE' }),
    replay: add(documentRef, analysis, 'button', {
      id: 'replay',
      attributes: { 'aria-pressed': 'false' },
      onClick: button => button.setAttribute('aria-pressed', 'true')
    }),
    zoom: add(documentRef, analysis, 'button', {
      id: 'zoomToggle',
      attributes: { 'aria-pressed': 'false' },
      onClick: button => button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
    }),
    plot: add(documentRef, analysis, 'canvas', { id: 'plot' }),
    speed10: add(documentRef, analysis, 'button', { dataset: { replaySpeed: '10' }, attributes: { 'aria-pressed': 'false' } })
  };
  setActive(screens, setup);
  const environment = createWorkspaceEnvironment(documentRef);
  return { workspace: environment.workspace, timers: environment.timers, screens, setup, consoleScreen, analysis, controls };
}

function createTacticalHarness() {
  const documentRef = new FakeDocument();
  const setup = addScreen(documentRef, 'tSetup');
  const consoleScreen = addScreen(documentRef, 'tConsole');
  const analysis = addScreen(documentRef, 'tAnalysis');
  const screens = [setup, consoleScreen, analysis];

  const createAircraft = (id, callsign) => {
    const row = add(documentRef, setup, 'article', { classes: ['tactical-aircraft-row'], dataset: { aircraftId: id } });
    add(documentRef, row, 'input', { dataset: { tacticalField: 'callsign' }, value: callsign });
    const profile = add(documentRef, row, 'select', { dataset: { tacticalField: 'profile' } });
    const rafale = add(documentRef, profile, 'option', { value: 'rafale', textContent: 'RAFALE' });
    profile.options = [rafale];
    const rail = add(documentRef, consoleScreen, 'article', { classes: ['tactical-rail-item'], dataset: { aircraftId: id } });
    const select = add(documentRef, rail, 'button', { classes: ['tactical-rail-select'], textContent: `${callsign} SELECT` });
    const transmit = add(documentRef, rail, 'button', { classes: ['tactical-rail-tx'], textContent: `${callsign} TRANSMIT` });
    return { row, rail, select, transmit, profile };
  };

  const controls = {
    falcon: createAircraft('A', 'FALCON 11'),
    raven: createAircraft('B', 'RAVEN 21'),
    formationLeader: add(documentRef, setup, 'select', { id: 'tFormationLeader' }),
    voiceCommandAck: add(documentRef, consoleScreen, 'output', { id: 'tVoiceCommandAck', hidden: true }),
    requestHeading: add(documentRef, consoleScreen, 'button', { id: 'tRequestHeading' }),
    headingReply: add(documentRef, consoleScreen, 'b', { id: 'tHeadingReply', textContent: 'HEADING —' }),
    headingInput: add(documentRef, consoleScreen, 'input', { id: 'tHeadingInput', type: 'number', min: '0', max: '359', value: '150' }),
    turnHeadingLeft: add(documentRef, consoleScreen, 'button', { id: 'tTurnLeft' }),
    turnHeadingRight: add(documentRef, consoleScreen, 'button', { id: 'tTurnRight' })
  };
  const ravenLeader = add(documentRef, controls.formationLeader, 'option', { value: 'B', textContent: 'RAVEN 21' });
  controls.formationLeader.options = [ravenLeader];
  setActive(screens, consoleScreen);
  const environment = createWorkspaceEnvironment(documentRef);
  return { workspace: environment.workspace, timers: environment.timers, screens, setup, consoleScreen, analysis, controls };
}

function showAppliedReply(harness) {
  const stage = [...harness.timers.values()].find(callback => callback.toString().includes('const message = `${phase}'));
  assert.ok(stage, 'the acknowledgement has a pending result transition');
  stage();
  return harness.controls.voiceCommandAck.textContent;
}

function command(intent, detail) {
  return Object.assign({ accepted: true, intent }, detail || {});
}

test('voice DOM router uses existing Normal and U/S Compass controls and refuses disabled controls', () => {
  const harness = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);

  const normal = workspace.runCommand(command('normal-turn-heading', { side: 'right', heading: 270 }));
  assert.equal(normal.ok, true);
  assert.equal(controls.headingInput.value, '270');
  assert.equal(controls.turnHeadingRight.clickCount, 1);
  assert.equal(controls.headingInput.classList.contains('voice-command-effect'), true);
  assert.equal(controls.turnHeadingRight.classList.contains('voice-command-effect'), true);

  controls.continueHeading.dataset.turnSide = 'right';
  const continued = workspace.runCommand(command('continue-turn-heading', { heading: 60 }));
  assert.equal(continued.ok, true);
  assert.equal(controls.headingInput.value, '60');
  assert.equal(controls.continueHeading.clickCount, 1);
  assert.equal(controls.turnHeadingRight.classList.contains('voice-command-effect'), true);

  controls.turnHeadingLeft.hidden = true;
  controls.turnHeadingRight.hidden = true;
  controls.turnLeft.hidden = false;
  const us = workspace.runCommand(command('us-turn', { side: 'left' }));
  assert.equal(us.ok, true);
  assert.equal(controls.turnLeft.clickCount, 1);

  controls.turnLeft.disabled = true;
  const disabled = workspace.runCommand(command('us-turn', { side: 'left' }));
  assert.equal(disabled.ok, false);
  assert.equal(disabled.message, 'TURN CONTROL IS NOT AVAILABLE');
  assert.equal(controls.turnLeft.clickCount, 1);

  const transmitted = workspace.dispatchTranscript('transmit for df please');
  assert.equal(transmitted.ok, true);
  assert.equal(controls.transmit.clickCount, 1);
});

test('accepted voice calls visibly acknowledge above the active homing display and highlight their control', () => {
  const single = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = single;
  setActive(screens, consoleScreen);

  const singleOutcome = workspace.dispatchTranscript('turn right two seven zero');
  assert.equal(singleOutcome.ok, true);
  assert.equal(controls.headingInput.classList.contains('voice-command-effect'), true);
  assert.equal(controls.turnHeadingRight.classList.contains('voice-command-effect'), true);
  assert.equal(controls.voiceCommandAck.hidden, false);
  assert.match(controls.voiceCommandAck.textContent, /^HEARD ·/);
  assert.match(controls.voiceCommandAck.textContent, /TURN RIGHT HEADING 270/);
  assert.equal(controls.voiceCommandAck.getAttribute('aria-label'), controls.voiceCommandAck.textContent);
  assert.equal(controls.voiceCommandAck.title, controls.voiceCommandAck.textContent);
  assert.equal(controls.voiceCommandAck.classList.contains('voice-command-ack-active'), true);
  const stage = [...single.timers.values()].find(callback => callback.toString().includes('const message = `${phase}'));
  assert.ok(stage);
  stage();
  assert.match(controls.voiceCommandAck.textContent, /^APPLIED ·/);
  [...single.timers.values()].forEach(callback => callback());
  assert.equal(controls.voiceCommandAck.hidden, true, 'the acknowledgement clears after its short acquisition window');

  const rejected = workspace.dispatchTranscript('random words without a control call');
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(controls.voiceCommandAck.textContent, /APPLIED/);

  const tactical = createTacticalHarness();
  const tacticalOutcome = tactical.workspace.dispatchTranscript('raven transmit for df');
  assert.equal(tacticalOutcome.ok, true);
  assert.equal(tactical.controls.raven.transmit.classList.contains('voice-command-effect'), true);
  assert.equal(tactical.controls.voiceCommandAck.hidden, false);
  assert.match(tactical.controls.voiceCommandAck.textContent, /RAVEN 21.*TRANSMIT/);
});

test('voice heading and range acknowledgements snapshot the returned data, not the request or a later report', () => {
  const harness = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);
  controls.headingReply.textContent = 'HEADING 120°M';
  controls.requestHeading.onClick = () => { controls.headingReply.textContent = 'HEADING 300°M'; };
  assert.equal(workspace.dispatchTranscript('report heading').ok, true);
  assert.match(controls.voiceCommandAck.textContent, /HEARD · REPORT HEADING/);
  assert.equal(controls.requestHeading.classList.contains('voice-command-effect'), true);
  controls.headingReply.textContent = 'HEADING 305°M';
  assert.equal(showAppliedReply(harness), 'APPLIED · HEADING 300°M');
  assert.equal(controls.voiceCommandAck.getAttribute('aria-label'), controls.voiceCommandAck.textContent);
  assert.equal(controls.voiceCommandAck.title, controls.voiceCommandAck.textContent);

  controls.requestDistance.onClick = () => { controls.distanceReply.textContent = 'RANGE 12.4 NM'; };
  assert.equal(workspace.dispatchTranscript('report distance').ok, true);
  assert.equal(showAppliedReply(harness), 'APPLIED · RANGE 12.4 NM');

  controls.requestHeading.disabled = true;
  assert.equal(workspace.dispatchTranscript('report heading').ok, false);
  assert.match(showAppliedReply(harness), /^REJECTED ·/);
  assert.doesNotMatch(controls.voiceCommandAck.textContent, /300|305/);
});

test('voice turn replies distinguish target headings and retain the active continuation direction', () => {
  const harness = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);
  assert.equal(workspace.dispatchTranscript('turn right two three zero').ok, true);
  assert.equal(showAppliedReply(harness), 'APPLIED · TURNING RIGHT 230°M');
  assert.equal(controls.headingInput.value, '230');
  assert.equal(controls.turnHeadingRight.classList.contains('voice-command-effect'), true);
  controls.continueHeading.dataset.turnSide = 'right';
  assert.equal(workspace.dispatchTranscript('continue zero six zero').ok, true);
  assert.equal(showAppliedReply(harness), 'APPLIED · TURNING RIGHT 060°M');
  assert.equal(workspace.dispatchTranscript('turn left three six zero').ok, true);
  assert.equal(showAppliedReply(harness), 'APPLIED · TURNING LEFT 000°M');
});

test('tactical voice readbacks retain the addressed callsign and reported data across selection changes', () => {
  const harness = createTacticalHarness();
  const { workspace, controls } = harness;
  let selected;
  controls.raven.select.onClick = () => { selected = 'raven'; };
  controls.requestHeading.onClick = () => {
    assert.equal(selected, 'raven');
    controls.headingReply.textContent = 'HEADING 300°M';
  };
  assert.equal(workspace.dispatchTranscript('raven report heading').ok, true);
  selected = 'falcon';
  controls.headingReply.textContent = 'HEADING —';
  assert.equal(showAppliedReply(harness), 'APPLIED · RAVEN 21 · HEADING 300°M');
  assert.equal(workspace.dispatchTranscript('raven turn right two three zero').ok, true);
  assert.equal(selected, 'raven');
  assert.equal(showAppliedReply(harness), 'APPLIED · RAVEN 21 · TURNING RIGHT 230°M');
  assert.equal(controls.turnHeadingRight.classList.contains('voice-command-effect'), true);
});

test('U/S voice turn readbacks never disclose heading and a heading request stays rejected', () => {
  const harness = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);
  controls.turnHeadingLeft.hidden = controls.turnHeadingRight.hidden = controls.requestHeading.hidden = true;
  controls.turnLeft.hidden = controls.turnRight.hidden = controls.turnStop.hidden = false;
  controls.headingReply.textContent = 'HEADING 300°M';
  assert.equal(workspace.dispatchTranscript('turn right now').ok, true);
  assert.equal(showAppliedReply(harness), 'APPLIED · TURNING RIGHT');
  assert.equal(workspace.dispatchTranscript('stop turn now').ok, true);
  assert.equal(showAppliedReply(harness), 'APPLIED · TURN STOPPED');
  assert.equal(workspace.dispatchTranscript('report heading').ok, false);
  assert.match(showAppliedReply(harness), /^REJECTED ·/);
  assert.doesNotMatch(controls.voiceCommandAck.textContent, /300/);
});

test('voice router requires an explicit confirmation before restart and accepts spoken confirmation', () => {
  const harness = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);

  const pending = workspace.dispatchTranscript('restart exercise');
  assert.equal(pending.ok, true);
  assert.equal(controls.restartExercise.clickCount, 0);
  assert.match(pending.message, /CONFIRM/);
  assert.equal(controls.restartExercise.classList.contains('voice-command-effect'), false);

  const confirmed = workspace.dispatchTranscript('confirm voice command');
  assert.equal(confirmed.ok, true);
  assert.equal(controls.restartExercise.clickCount, 1);
});

test('a pending voice confirmation expires when its exercise screen changes', () => {
  const harness = createSingleHarness();
  const { workspace, screens, setup, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);

  const pending = workspace.dispatchTranscript('restart exercise');
  assert.equal(pending.ok, true);
  setActive(screens, setup);

  const expired = workspace.dispatchTranscript('confirm voice command');
  assert.equal(expired.ok, false);
  assert.match(expired.message, /EXPIRED/);
  assert.equal(controls.restartExercise.clickCount, 0);
});

test('a pending destructive voice confirmation expires after its short acceptance window', () => {
  const harness = createSingleHarness();
  const { workspace, timers, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);

  const pending = workspace.dispatchTranscript('restart exercise');
  assert.equal(pending.ok, true);
  [...timers.values()].forEach(callback => callback());

  const expired = workspace.dispatchTranscript('confirm voice command');
  assert.equal(expired.ok, false);
  assert.match(expired.message, /NO VOICE COMMAND/);
  assert.equal(controls.restartExercise.clickCount, 0);
});

test('voice DOM router canonicalises a setup 360 heading to 000 and drives review controls', () => {
  const harness = createSingleHarness();
  const { workspace, screens, setup, analysis, controls } = harness;
  setActive(screens, setup);

  const setupHeading = workspace.dispatchTranscript('set runway orientation three six zero');
  assert.equal(setupHeading.ok, true);
  assert.equal(controls.runway.value, '0');
  const customProfile = workspace.dispatchTranscript('select aircraft profile custom trainer');
  assert.equal(customProfile.ok, true);
  assert.equal(controls.aircraft.value, 'custom-trainer');
  assert.equal(controls.aircraft.classList.contains('voice-command-effect'), true);

  setActive(screens, analysis);
  assert.equal(workspace.runCommand(command('replay-play')).ok, true);
  assert.equal(controls.replay.clickCount, 1);
  assert.equal(controls.replay.getAttribute('aria-pressed'), 'true');
  assert.equal(workspace.runCommand(command('set-replay-speed', { speed: 10 })).ok, true);
  assert.equal(controls.speed10.clickCount, 1);
  assert.equal(workspace.runCommand(command('review-zoom', { enabled: true })).ok, true);
  assert.equal(controls.zoom.getAttribute('aria-pressed'), 'true');
  assert.equal(workspace.runCommand(command('review-zoom-step', { direction: 'in' })).ok, true);
  assert.equal(controls.plot.focusCount, 1);
  assert.equal(controls.plot.events.at(-1).key, '+');
});

test('voice DOM router resolves live tactical aircraft rows for selection and D/F transmit', () => {
  const harness = createTacticalHarness();
  const { workspace, screens, setup, controls } = harness;

  const selected = workspace.dispatchTranscript('select aircraft raven twenty one');
  assert.equal(selected.ok, true);
  assert.equal(controls.raven.select.clickCount, 1);
  assert.equal(controls.falcon.select.clickCount, 0);

  const transmitted = workspace.dispatchTranscript('transmit for df raven twenty one');
  assert.equal(transmitted.ok, true);
  assert.equal(controls.raven.transmit.clickCount, 1);
  assert.equal(controls.falcon.transmit.clickCount, 0);

  const unnamed = workspace.runCommand(command('normal-turn-heading', { side: 'right', heading: 60 }));
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.message, /CALLSIGN/);

  const unnamedSpeed = workspace.runCommand(command('set-field', { field: 'speed', value: 240 }));
  assert.equal(unnamedSpeed.ok, false);
  assert.match(unnamedSpeed.message, /CALLSIGN/);

  setActive(screens, setup);
  const profile = workspace.runCommand(command('set-aircraft-profile', { aircraft: 'B', profile: 'rafale' }));
  assert.equal(profile.ok, true);
  assert.equal(controls.raven.profile.value, 'rafale');
  assert.equal(controls.raven.profile.classList.contains('voice-command-effect'), true);

  const leader = workspace.runCommand(command('set-formation-leader', { aircraft: 'B' }));
  assert.equal(leader.ok, true);
  assert.equal(controls.formationLeader.value, 'B');
  assert.equal(controls.formationLeader.classList.contains('voice-command-effect'), true);
});

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

test('Android native voice bridge uses the same safe voice dock workflow', async () => {
  const nativeBridge = {
    starts: [],
    stops: 0,
    cancels: 0,
    getCapability() { return 'available'; },
    start(continuous) { this.starts.push(continuous); },
    stop() { this.stops += 1; },
    cancel() { this.cancels += 1; }
  };
  const documentRef = new FakeDocument();
  const environment = createWorkspaceEnvironment(documentRef, { QghNativeVoice: nativeBridge });
  const settings = documentRef.querySelector('.voice-settings-toggle');
  const mic = documentRef.querySelector('.voice-mic');
  settings.click();
  await tick();
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await tick();
  assert.deepEqual(nativeBridge.starts, [false]);

  environment.workspace.receiveNativeVoiceEvent({ type: 'started' });
  assert.equal(mic.getAttribute('aria-pressed'), 'true');
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  assert.equal(nativeBridge.stops, 1);
  environment.workspace.receiveNativeVoiceEvent({ type: 'ended' });
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
});
