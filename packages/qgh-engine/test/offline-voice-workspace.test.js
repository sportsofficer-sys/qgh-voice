'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Voice = require('../voice-control.js');
const OfflineVoice = require('../offline-voice-engine.js');
const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'voice-workspace.js'), 'utf8');

class FakeEvent {
  constructor(type, options) {
    this.type = type;
    Object.assign(this, options || {});
    this.defaultPrevented = false;
  }

  preventDefault() { this.defaultPrevented = true; }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toLowerCase();
    this.id = '';
    this.type = '';
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.classList = new FakeClassList();
    Object.defineProperty(this, 'className', {
      get: () => [...this.classList.values].join(' '),
      set: value => { this.classList = new FakeClassList(); String(value || '').split(/\s+/).filter(Boolean).forEach(item => this.classList.add(item)); }
    });
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatchEvent(event) {
    event.target = this;
    (this.listeners.get(event.type) || []).forEach(listener => listener.call(this, event));
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent(new FakeEvent('click')); }
  focus() {}
  matches(selector) {
    if (selector === '[hidden]') return this.hidden || this.attributes.has('hidden');
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.classList.contains(name));
    return false;
  }
  closest(selector) {
    const options = selector.split(',').map(item => item.trim());
    for (let node = this; node; node = node.parentElement) if (options.some(option => node.matches(option))) return node;
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => node.children.forEach(child => {
      if (child.matches(selector)) found.push(child);
      visit(child);
    });
    visit(this);
    return found;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.visibilityState = 'visible';
    this.listeners = new Map();
  }

  createElement(tagName) { return new FakeElement(tagName); }
  getElementById() { return null; }
  querySelector(selector) { return this.body.querySelector(selector); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

function makeOfflineEngine(options) {
  const config = options || {};
  let ready = Boolean(config.ready);
  let hooks = null;
  let resolvePrepare = null;
  const engine = {
    prepareCalls: 0,
    startCalls: [],
    stopCalls: [],
    cancelCalls: 0,
    lastStart: null,
    isReady() { return ready; },
    prepare(onProgress) {
      this.prepareCalls += 1;
      onProgress?.({ phase: 'downloading', loaded: 1, total: 2 });
      if (config.deferPrepare) {
        return new Promise(resolve => { resolvePrepare = () => { ready = true; onProgress?.({ phase: 'ready', loaded: 2, total: 2 }); resolve(this); }; });
      }
      ready = true;
      onProgress?.({ phase: 'ready', loaded: 2, total: 2 });
      return Promise.resolve(this);
    },
    start(settings) {
      this.startCalls.push(settings);
      this.lastStart = settings;
      if (!config.deferStart) settings.onStarted?.();
      return Promise.resolve(true);
    },
    stop(settings) {
      this.stopCalls.push(settings || {});
      hooks?.onEnded?.();
    },
    cancel() {
      this.cancelCalls += 1;
      hooks?.onEnded?.();
    },
    resolvePrepare() { resolvePrepare?.(); },
    triggerStarted() { this.lastStart?.onStarted?.(); },
    triggerEnd() { hooks?.onEnded?.(); }
  };
  return {
    engine,
    api: {
      supportsOfflineVoice: () => true,
      buildQghGrammar: () => ['turn right heading two seven zero', '[unk]'],
      create(nextHooks) { hooks = nextHooks; return engine; }
    }
  };
}

function createEnvironment(options) {
  const document = new FakeDocument();
  const timers = new Map();
  const listeners = new Map();
  let nextTimer = 1;
  const sandbox = {
    QGHVoiceControl: Voice,
    QGHOfflineVoiceEngine: options?.offlineVoice,
    QghNativeVoice: options?.nativeVoice,
    document,
    Event: FakeEvent,
    setTimeout(callback) { const id = nextTimer; nextTimer += 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    location: { href: 'https://example.test/qgh/single.html' }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workspaceSource, sandbox);
  return { document, timers, listeners, workspace: sandbox.QGHVoiceWorkspace };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('offline voice requires an explicit one-time setup, coalesces it, and exposes PTT', async () => {
  const runtime = makeOfflineEngine({ deferPrepare: true });
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  const mic = environment.document.querySelector('.voice-mic');
  const settings = environment.document.querySelector('.voice-settings-toggle');
  const prepare = environment.document.querySelector('.voice-prepare');
  assert.equal(mic.textContent, 'PTT');
  assert.equal(mic.disabled, true);
  assert.equal(prepare.hidden, false);

  settings.click();
  prepare.click();
  prepare.click();
  assert.equal(runtime.engine.prepareCalls, 1, 'only one model setup begins');
  assert.equal(prepare.disabled, true);
  runtime.engine.resolvePrepare();
  await flush();
  assert.equal(mic.disabled, false);
  assert.equal(prepare.hidden, true);
});

test('PTT and continuous assistant route only through the offline engine and safely restart', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  const prepare = environment.document.querySelector('.voice-prepare');
  prepare.click();
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  assert.equal(runtime.engine.startCalls.length, 1);
  assert.equal(mic.getAttribute('aria-pressed'), 'true');
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  assert.equal(runtime.engine.stopCalls.length, 1);
  assert.equal(mic.getAttribute('aria-pressed'), 'false');

  const continuous = environment.document.querySelector('.voice-continuous').children[0];
  continuous.checked = true;
  continuous.dispatchEvent(new FakeEvent('change'));
  await flush();
  const assistant = environment.document.querySelector('.voice-assistant');
  assert.equal(runtime.engine.startCalls.length, 2);
  assert.equal(assistant.hidden, false);

  runtime.engine.triggerEnd();
  assert.equal(environment.timers.size, 1, 'an unexpected end schedules one restart');
  const [timerId, restart] = environment.timers.entries().next().value;
  environment.timers.delete(timerId);
  restart();
  await flush();
  assert.equal(runtime.engine.startCalls.length, 3);
  environment.listeners.get('blur')();
  assert.equal(environment.timers.size, 0, 'blur cancels any pending continuous retry');
  assert.equal(assistant.hidden, true);
});

test('a released PTT press cannot become active after a delayed local-engine start', async () => {
  const runtime = makeOfflineEngine({ deferStart: true });
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();
  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  assert.equal(runtime.engine.startCalls.length, 1);
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  assert.equal(runtime.engine.cancelCalls, 1);
  runtime.engine.triggerStarted();
  assert.equal(runtime.engine.cancelCalls, 2, 'late start is immediately cancelled');
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
});

test('offline voice stops continuous retries after microphone permission is denied', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();
  const continuous = environment.document.querySelector('.voice-continuous').children[0];
  continuous.checked = true;
  continuous.dispatchEvent(new FakeEvent('change'));
  await flush();
  runtime.engine.lastStart.onError('not-allowed');
  assert.equal(environment.timers.size, 0);
  assert.equal(continuous.checked, false);
  assert.equal(environment.document.querySelector('.voice-mic').textContent, 'PTT');
});

test('Android native bridge can report a preparing offline pack until it is ready', async () => {
  let capability = 'preparing';
  const bridge = {
    getCapability() { return capability; },
    start() {}, stop() {}, cancel() {}
  };
  const environment = createEnvironment({ nativeVoice: bridge });
  await flush();
  const mic = environment.document.querySelector('.voice-mic');
  assert.equal(mic.disabled, true);
  assert.equal(environment.timers.size, 1);
  capability = 'available';
  const [timerId, refresh] = environment.timers.entries().next().value;
  environment.timers.delete(timerId);
  refresh();
  await flush();
  assert.equal(mic.disabled, false);
});

test('the offline grammar keeps unknown speech explicit and includes active callsigns', () => {
  const grammar = OfflineVoice.buildQghGrammar({ callsigns: ['FALCON 11'] });
  assert.ok(grammar.includes('[unk]'));
  assert.ok(grammar.includes('turn right heading two seven zero'));
  assert.ok(grammar.includes('falcon 11 turn right heading two seven zero'));
  assert.ok(grammar.includes('transmit for df falcon 11'));
});
