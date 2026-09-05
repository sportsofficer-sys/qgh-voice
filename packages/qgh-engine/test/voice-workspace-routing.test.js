'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Voice = require('../voice-control.js');
const Radio = require('../radio-session.js');
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
    QGHRadioSession: Radio,
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
    callsign: add(documentRef, setup, 'input', { id: 'callsign', value: 'RAVEN 21' }),
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
    orbitLeft: add(documentRef, consoleScreen, 'button', { id: 'orbitLeft', textContent: 'ORBIT LEFT' }),
    orbitRight: add(documentRef, consoleScreen, 'button', { id: 'orbitRight', textContent: 'ORBIT RIGHT' }),
    continueOrbit: add(documentRef, consoleScreen, 'button', { id: 'continueOrbit', textContent: 'CONTINUE ORBIT', disabled: true }),
    resumeNormal: add(documentRef, consoleScreen, 'button', { id: 'resumeNormal', textContent: 'RESUME NORMAL', disabled: true }),
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
  return { workspace: environment.workspace, sandbox: environment.sandbox, timers: environment.timers, screens, setup, consoleScreen, analysis, controls };
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
    turnHeadingRight: add(documentRef, consoleScreen, 'button', { id: 'tTurnRight' }),
    continueHeading: add(documentRef, consoleScreen, 'button', { id: 'tContinueHeading', textContent: 'CONTINUE HEADING' }),
    orbitLeft: add(documentRef, consoleScreen, 'button', { id: 'tOrbitLeft', textContent: 'ORBIT LEFT' }),
    orbitRight: add(documentRef, consoleScreen, 'button', { id: 'tOrbitRight', textContent: 'ORBIT RIGHT' }),
    continueOrbit: add(documentRef, consoleScreen, 'button', { id: 'tContinueOrbit', textContent: 'CONTINUE ORBIT', disabled: true }),
    resumeNormal: add(documentRef, consoleScreen, 'button', { id: 'tResumeNormal', textContent: 'RESUME NORMAL', disabled: true })
  };
  const ravenLeader = add(documentRef, controls.formationLeader, 'option', { value: 'B', textContent: 'RAVEN 21' });
  controls.formationLeader.options = [ravenLeader];
  setActive(screens, consoleScreen);
  const environment = createWorkspaceEnvironment(documentRef);
  return { workspace: environment.workspace, sandbox: environment.sandbox, timers: environment.timers, screens, setup, consoleScreen, analysis, controls };
}

function showAppliedReply(harness) {
  const stage = [...harness.timers.values()].find(callback => callback.toString().includes('const message = `${phase}'));
  assert.ok(stage, 'the acknowledgement has a pending result transition');
  stage();
  return harness.controls.voiceCommandAck.textContent;
}

// Model control availability and the synchronous adapter outcome only. Orbit
// movement and its completion boundary are covered by the real-core tests.
function attachOrbitControlState(harness, tactical = false, immediateResume = false) {
  const aircraft = tactical
    ? { A: { source: 'A', callsign: 'FALCON 11', orbitSide: null }, B: { source: 'B', callsign: 'RAVEN 21', orbitSide: null } }
    : { single: { source: 'single', callsign: 'RAVEN 21', orbitSide: null } };
  let selected = tactical ? 'A' : 'single';
  const actions = [];
  const replies = [];
  const update = () => {
    harness.controls.continueOrbit.disabled = !aircraft[selected].orbitSide;
    harness.controls.resumeNormal.disabled = !aircraft[selected].orbitSide;
  };
  if (tactical) {
    harness.controls.falcon.select.onClick = () => { selected = 'A'; update(); };
    harness.controls.raven.select.onClick = () => { selected = 'B'; update(); };
  }
  for (const side of ['left', 'right']) {
    harness.controls[side === 'left' ? 'orbitLeft' : 'orbitRight'].onClick = () => {
      actions.push({ aircraft: selected, action: 'start', side });
      aircraft[selected].orbitSide = side;
      update();
    };
  }
  harness.controls.continueOrbit.onClick = () => {
    actions.push({ aircraft: selected, action: 'continue' });
  };
  harness.controls.resumeNormal.onClick = () => {
    actions.push({ aircraft: selected, action: 'resume' });
    if (immediateResume) aircraft[selected].orbitSide = null;
    update();
  };
  harness.sandbox.QGHRadioAdapter = { snapshot: id => aircraft[id || selected] };
  harness.sandbox.QGHRadioWorkspace = { acknowledge: command => replies.push(command) };
  update();
  return { aircraft, actions, replies };
}

test('orbit voice calls use and highlight single-aircraft controls with an optional callsign', () => {
  const h = createSingleHarness();
  setActive(h.screens, h.consoleScreen);
  const state = attachOrbitControlState(h);
  assert.equal(h.workspace.dispatchTranscript('orbit left').ok, true);
  assert.equal(h.controls.orbitLeft.clickCount, 1);
  assert.equal(h.controls.orbitLeft.classList.contains('voice-command-effect'), true);
  assert.match(showAppliedReply(h), /APPLIED · ORBITING LEFT/);
  assert.equal(h.workspace.dispatchTranscript('Raven twenty one orbit right').ok, true);
  assert.equal(h.controls.orbitRight.clickCount, 1);
  assert.equal(h.controls.orbitRight.classList.contains('voice-command-effect'), true);
  assert.match(showAppliedReply(h), /RAVEN 21 · ORBITING RIGHT/);
  for (const phrase of ['continue orbit', 'continue']) assert.equal(h.workspace.dispatchTranscript(phrase).ok, true, phrase);
  assert.equal(h.controls.continueOrbit.clickCount, 2);
  assert.equal(h.controls.continueOrbit.classList.contains('voice-command-effect'), true);
  assert.match(showAppliedReply(h), /CONTINUING ORBIT/);
  assert.equal(state.aircraft.single.orbitSide, 'right');
  assert.equal(h.controls.headingInput.value, '150');
  assert.equal(h.controls.turnHeadingLeft.clickCount, 0);
  assert.equal(h.controls.turnHeadingRight.clickCount, 0);
  assert.equal(h.controls.continueHeading.clickCount, 0);
  assert.deepEqual(state.replies.map(reply => reply.intent), ['start-orbit', 'start-orbit', 'continue-orbit', 'continue-orbit']);
});

test('tactical orbit voice calls require a known callsign and select it before applying the control', () => {
  const h = createTacticalHarness();
  const state = attachOrbitControlState(h, true);
  for (const phrase of ['orbit left', 'continue orbit', 'continue', 'resume normal', 'Eagle thirty one orbit right']) {
    assert.equal(h.workspace.dispatchTranscript(phrase).ok, false, phrase);
  }
  assert.equal(h.controls.falcon.select.clickCount, 0);
  assert.equal(h.controls.raven.select.clickCount, 0);
  assert.equal(state.actions.length, 0);
  assert.equal(state.replies.length, 0);
  assert.equal(h.workspace.dispatchTranscript('Raven twenty one orbit left').ok, true);
  assert.equal(h.controls.raven.select.clickCount, 1);
  assert.equal(h.controls.orbitLeft.classList.contains('voice-command-effect'), true);
  assert.match(showAppliedReply(h), /RAVEN 21 · ORBITING LEFT/);
  assert.equal(h.workspace.dispatchTranscript('Falcon eleven orbit right').ok, true);
  assert.equal(h.controls.falcon.select.clickCount, 1);
  assert.equal(h.workspace.dispatchTranscript('Raven twenty one continue orbit').ok, true);
  assert.equal(h.controls.continueOrbit.classList.contains('voice-command-effect'), true);
  assert.equal(h.workspace.dispatchTranscript('Raven twenty one resume normal').ok, true);
  assert.equal(h.controls.resumeNormal.classList.contains('voice-command-effect'), true);
  assert.match(showAppliedReply(h), /RAVEN 21 · WILL RESUME NORMAL AFTER THIS ORBIT/);
  assert.deepEqual(state.actions, [
    { aircraft: 'B', action: 'start', side: 'left' },
    { aircraft: 'A', action: 'start', side: 'right' },
    { aircraft: 'B', action: 'continue' },
    { aircraft: 'B', action: 'resume' }
  ]);
  assert.deepEqual(state.replies.map(reply => reply.aircraft), ['B', 'A', 'B', 'B']);
  assert.equal(h.controls.turnHeadingLeft.clickCount, 0);
  assert.equal(h.controls.turnHeadingRight.clickCount, 0);
});

test('resume voice feedback reflects the synchronous immediate or deferred control outcome', () => {
  for (const tactical of [false, true]) {
    for (const immediate of [false, true]) {
      const h = tactical ? createTacticalHarness() : createSingleHarness();
      setActive(h.screens, h.consoleScreen);
      attachOrbitControlState(h, tactical, immediate);
      const prefix = tactical ? 'Raven twenty one ' : '';
      assert.equal(h.workspace.dispatchTranscript(prefix + 'orbit left').ok, true);
      assert.equal(h.workspace.dispatchTranscript(prefix + 'resume normal').ok, true);
      assert.equal(h.controls.resumeNormal.clickCount, 1);
      assert.equal(h.controls.resumeNormal.classList.contains('voice-command-effect'), true);
      const reply = showAppliedReply(h);
      assert.match(reply, immediate ? /RESUMING NORMAL$/ : /WILL RESUME NORMAL AFTER THIS ORBIT$/);
      if (immediate) assert.doesNotMatch(reply, /AFTER THIS ORBIT/);
      if (tactical) assert.match(reply, /RAVEN 21/);
      assert.doesNotMatch(reply, /\d{3}°/, 'resume feedback does not reveal a hidden U/S heading');
    }
  }
});

test('disabled orbit continuation or resume is rejected without clicking or highlighting its control', () => {
  for (const tactical of [false, true]) {
    const h = tactical ? createTacticalHarness() : createSingleHarness();
    setActive(h.screens, h.consoleScreen);
    const state = attachOrbitControlState(h, tactical);
    const prefix = tactical ? 'Raven twenty one ' : '';
    for (const phrase of ['continue orbit', 'continue', 'resume normal']) {
      const outcome = h.workspace.dispatchTranscript(prefix + phrase);
      assert.equal(outcome.ok, false, phrase);
      assert.match(outcome.message, /NOT AVAILABLE/);
      assert.match(showAppliedReply(h), /^REJECTED ·/);
    }
    assert.equal(h.controls.continueOrbit.clickCount, 0);
    assert.equal(h.controls.resumeNormal.clickCount, 0);
    assert.equal(h.controls.continueOrbit.classList.contains('voice-command-effect'), false);
    assert.equal(h.controls.resumeNormal.classList.contains('voice-command-effect'), false);
    assert.equal(state.replies.length, 0);
  }
});

test('numbered continue retains the heading-control route and bare continue requires an orbit control', () => {
  for (const tactical of [false, true]) {
    const h = tactical ? createTacticalHarness() : createSingleHarness();
    setActive(h.screens, h.consoleScreen);
    const state = attachOrbitControlState(h, tactical);
    const prefix = tactical ? 'Raven twenty one ' : '';
    h.controls.continueHeading.dataset.turnSide = 'right';
    assert.equal(h.workspace.dispatchTranscript(prefix + 'continue zero six zero').ok, true);
    assert.equal(h.controls.headingInput.value, '60');
    assert.equal(h.controls.continueHeading.clickCount, 1);
    assert.equal(h.controls.continueHeading.classList.contains('voice-command-effect'), true);
    assert.equal(h.controls.continueOrbit.clickCount, 0);
    assert.equal(state.replies.at(-1).intent, 'continue-turn-heading');
    h.sandbox.document.elementsById.delete(tactical ? 'tContinueOrbit' : 'continueOrbit');
    assert.equal(h.workspace.dispatchTranscript(prefix + 'continue').ok, false);
    assert.equal(h.controls.continueHeading.clickCount, 1, 'bare continue must not fall back to the numbered heading control');
    assert.equal(h.controls.continueOrbit.clickCount, 0);
  }
});

test('passing report voice variants arm the addressed report, highlight without clicking or turning, and reject malformed calls', () => {
  for (const tactical of [false, true]) {
    const h = tactical ? createTacticalHarness() : createSingleHarness();
    setActive(h.screens, h.consoleScreen);
    const requests = []; const replies = [];
    h.sandbox.QGHRadioWorkspace = {
      requestHeadingPassing(command) { requests.push(command); return { ok: true, message: `WILL REPORT PASSING ${String(command.heading).padStart(3, '0')}°M` }; },
      acknowledge: command => replies.push(command)
    };
    const prefix = tactical ? 'Raven twenty one ' : '';
    for (const phrase of ['report heading passing325', 'report passing heading 325', 'report passing three two five']) {
      // Natural recognition supplies a word boundary before the numeric heading.
      const spoken = phrase.replace('passing325', 'passing 325');
      assert.equal(h.workspace.dispatchTranscript(prefix + spoken).ok, true);
      assert.equal(requests.at(-1).heading, 325);
      assert.equal(requests.at(-1).aircraft, tactical ? 'B' : 'single');
      assert.equal(h.controls.requestHeading.clickCount, 0, 'do not report the current heading immediately');
      assert.equal(h.controls.requestHeading.classList.contains('voice-command-effect'), true);
      assert.match(showAppliedReply(h), /WILL REPORT PASSING 325/);
    }
    assert.equal(h.controls.turnHeadingRight.clickCount, 0);
    assert.equal(h.controls.turnHeadingLeft.clickCount, 0);
    for (const invalid of ['report heading passing', 'report heading passing 400', 'cancel report heading passing 325', 'report passing 325 and turn left 090']) {
      assert.equal(h.workspace.dispatchTranscript(prefix + invalid).ok, false);
    }
    if (tactical) assert.equal(h.workspace.dispatchTranscript('report passing325'.replace('passing325', 'passing 325')).ok, false);
    assert.equal(requests.length, 3);
    assert.equal(replies.length, 3);
  }
});

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

test('single callsigns route Normal and U/S commands while unknown callsigns cannot execute', () => {
  const harness = createSingleHarness();
  const { workspace, screens, consoleScreen, controls } = harness;
  setActive(screens, consoleScreen);
  for (const phrase of ['Raven turn right 230', 'Raven two one turn right heading 230', 'Raven twenty one turn right 230']) {
    assert.equal(workspace.dispatchTranscript(phrase).ok, true, phrase);
    assert.equal(controls.headingInput.value, '230');
    assert.equal(showAppliedReply(harness), 'APPLIED · RAVEN 21 · TURNING RIGHT 230°M');
  }
  const before = controls.turnHeadingRight.clickCount;
  assert.equal(workspace.dispatchTranscript('Falcon turn right heading 180').ok, false);
  assert.equal(workspace.dispatchTranscript('Raven twenty two turn right 180').ok, false);
  assert.equal(controls.turnHeadingRight.clickCount, before);
  assert.equal(workspace.dispatchTranscript('turn right 180').ok, true, 'existing unaddressed single calls remain valid');
  controls.turnHeadingLeft.hidden = controls.turnHeadingRight.hidden = true;
  controls.turnLeft.hidden = controls.turnRight.hidden = controls.turnStop.hidden = false;
  assert.equal(workspace.dispatchTranscript('Raven turn left now').ok, true);
  assert.equal(controls.turnLeft.clickCount, 1);
  assert.equal(workspace.dispatchTranscript('Raven stop turn now').ok, true);
  assert.equal(controls.turnStop.clickCount, 1);
  assert.equal(workspace.dispatchTranscript('Raven transmit for df').ok, true);
  assert.equal(controls.transmit.clickCount, 1);
  assert.equal(workspace.dispatchTranscript('Raven turn right 230').ok, false, 'U/S does not gain heading controls');
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

test('RT information receives a reply without changing flight controls; single callsign stays optional', () => {
  const single = createSingleHarness();
  setActive(single.screens, single.consoleScreen);
  assert.equal(single.workspace.dispatchTranscript('surface wind two three zero degrees ten knots').ok, true);
  assert.match(showAppliedReply(single), /RECEIVED.*ROGER/);
  assert.equal(single.controls.headingInput.value, '150');
  assert.equal(single.controls.turnHeadingRight.clickCount, 0);
  assert.equal(single.controls.turnHeadingRight.classList.contains('voice-command-effect'), false);
  assert.equal(single.workspace.dispatchTranscript('Raven twenty one commence descent now').ok, true);
  assert.match(showAppliedReply(single), /NOT SIMULATED/);
  single.controls.turnLeft.hidden = single.controls.turnRight.hidden = false;
  single.controls.turnStop.hidden = false;
  assert.equal(single.workspace.dispatchTranscript('turn right now').ok, true);
  assert.equal(single.workspace.dispatchTranscript('stop turn now').ok, true);
  const tactical = createTacticalHarness();
  assert.equal(tactical.workspace.dispatchTranscript('surface wind two three zero ten knots').ok, false);
  assert.equal(tactical.workspace.dispatchTranscript('Raven twenty one surface wind two three zero ten knots').ok, true);
  assert.match(showAppliedReply(tactical), /ROGER.*RAVEN 21/);
  assert.equal(tactical.controls.raven.select.clickCount, 0, 'RT alone does not change selected aircraft');
});

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
