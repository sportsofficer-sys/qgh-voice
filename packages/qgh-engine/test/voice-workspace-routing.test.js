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
  const sandbox = {
    QGHVoiceControl: Voice,
    document: documentRef,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    clearTimeout() {},
    setTimeout() { return 1; },
    addEventListener(type, listener) { rootListeners.set(type, listener); },
    location: { assign() {} }
  };
  Object.assign(sandbox, additions || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workspaceSource, sandbox);
  return { workspace: sandbox.QGHVoiceWorkspace, rootListeners, sandbox };
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
    headingInput: add(documentRef, consoleScreen, 'input', { id: 'headingInput', type: 'number', min: '0', max: '359', value: '150' }),
    turnHeadingLeft: add(documentRef, consoleScreen, 'button', { id: 'turnHeadingLeft', textContent: 'TURN LEFT' }),
    turnHeadingRight: add(documentRef, consoleScreen, 'button', { id: 'turnHeadingRight', textContent: 'TURN RIGHT' }),
    turnLeft: add(documentRef, consoleScreen, 'button', { id: 'turnLeft', textContent: 'TURN LEFT NOW', hidden: true }),
    turnRight: add(documentRef, consoleScreen, 'button', { id: 'turnRight', textContent: 'TURN RIGHT NOW', hidden: true }),
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
  return { workspace: bootWorkspace(documentRef), screens, setup, consoleScreen, analysis, controls };
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
    const rail = add(documentRef, consoleScreen, 'article', { classes: ['tactical-rail-item'], dataset: { aircraftId: id } });
    const select = add(documentRef, rail, 'button', { classes: ['tactical-rail-select'], textContent: `${callsign} SELECT` });
    const transmit = add(documentRef, rail, 'button', { classes: ['tactical-rail-tx'], textContent: `${callsign} TRANSMIT` });
    return { row, rail, select, transmit };
  };

  const controls = {
    falcon: createAircraft('A', 'FALCON 11'),
    raven: createAircraft('B', 'RAVEN 21')
  };
  setActive(screens, consoleScreen);
  return { workspace: bootWorkspace(documentRef), screens, setup, consoleScreen, analysis, controls };
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
  const { workspace, controls } = harness;

  const selected = workspace.dispatchTranscript('select aircraft raven twenty one');
  assert.equal(selected.ok, true);
  assert.equal(controls.raven.select.clickCount, 1);
  assert.equal(controls.falcon.select.clickCount, 0);

  const transmitted = workspace.dispatchTranscript('transmit for df raven twenty one');
  assert.equal(transmitted.ok, true);
  assert.equal(controls.raven.transmit.clickCount, 1);
  assert.equal(controls.falcon.transmit.clickCount, 0);
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
