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
    this.style = {};
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
    primeCalls: 0,
    startCalls: [],
    stopCalls: [],
    cancelCalls: 0,
    lastStart: null,
    isReady() { return ready; },
    primeAudio() {
      this.primeCalls += 1;
      return Promise.resolve(this);
    },
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
      if (config.startError) {
        settings.onError?.(config.startError);
        return Promise.reject(new Error(config.startError));
      }
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
    triggerResult(transcript) { this.lastStart?.onResult?.(transcript); },
    triggerNoResult() { this.lastStart?.onNoResult?.(); },
    triggerEnd() { hooks?.onEnded?.(); }
  };
  return {
    engine,
    api: {
      supportsOfflineVoice: () => true,
      hasCachedArchive: () => Boolean(config.cachedArchive),
      buildRecognitionPlan: () => ({ grammar: null }),
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

test('a cached offline pack is initialized automatically on an exercise page', async () => {
  const runtime = makeOfflineEngine({ cachedArchive: true, deferPrepare: true });
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  const prepare = environment.document.querySelector('.voice-prepare');
  assert.equal(runtime.engine.prepareCalls, 1, 'a stored local pack is prepared without another setup click');
  assert.equal(mic.disabled, true, 'PTT waits only while the cached model initializes');
  assert.equal(prepare.hidden, true, 'the one-time setup action stays out of the way for a stored pack');

  runtime.engine.resolvePrepare();
  await flush();
  assert.equal(mic.disabled, false);
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
  const listeningIndicator = environment.document.querySelector('.voice-listening-indicator');
  assert.equal(runtime.engine.startCalls.length, 2);
  assert.equal(listeningIndicator.hidden, false);

  runtime.engine.triggerEnd();
  assert.equal(environment.timers.size, 1, 'an unexpected end schedules one restart');
  const [timerId, restart] = environment.timers.entries().next().value;
  environment.timers.delete(timerId);
  restart();
  await flush();
  assert.equal(runtime.engine.startCalls.length, 3);
  environment.listeners.get('blur')();
  assert.equal(environment.timers.size, 0, 'blur cancels any pending continuous retry');
  assert.equal(listeningIndicator.hidden, true);
});

test('PTT remains live when the pointer crosses the edge of its control', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  mic.dispatchEvent(new FakeEvent('pointerleave', { pointerId: 1 }));
  assert.equal(runtime.engine.stopCalls.length, 0, 'moving the pointer must not cut off an in-progress RT call');

  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  assert.equal(runtime.engine.stopCalls.length, 1);
});

test('user-triggered PTT and continuous listening prime audio before asynchronous startup', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  assert.equal(runtime.engine.primeCalls, 1, 'pointerdown keeps audio unlock inside the user gesture');
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));

  const continuous = environment.document.querySelector('.voice-continuous').children[0];
  continuous.checked = true;
  continuous.dispatchEvent(new FakeEvent('change'));
  assert.equal(runtime.engine.primeCalls, 2, 'continuous mode is primed from the user control too');
});

test('a recoverable suspended-audio error keeps offline voice ready for another PTT press', async () => {
  const runtime = makeOfflineEngine({ startError: 'audio-suspended' });
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();

  const status = environment.document.querySelector('.voice-status');
  assert.equal(status.textContent, 'AUDIO IS BLOCKED · HOLD PTT AND TRY AGAIN');
  assert.equal(mic.disabled, false);
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

test('the dock preserves what local voice heard and its command result after the session ends', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  runtime.engine.triggerResult('transmit for df');
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));

  const feedback = environment.document.querySelector('.voice-feedback');
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /HEARD/i);
  assert.match(feedback.getAttribute('aria-label'), /TRANSMIT FOR DF/i);
  assert.match(feedback.getAttribute('aria-label'), /AVAILABLE ON THIS SCREEN/i);
  assert.equal(environment.document.querySelector('.voice-status').textContent, 'PTT READY');
});

test('the dock explains an empty final result and includes a movable control handle', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  environment.document.querySelector('.voice-prepare').click();
  await flush();

  const mic = environment.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  runtime.engine.triggerNoResult();
  runtime.engine.triggerEnd();

  const feedback = environment.document.querySelector('.voice-feedback');
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /NO SPEECH/i);
  assert.match(feedback.getAttribute('aria-label'), /NO SPEECH DETECTED/i);
  assert.ok(environment.document.querySelector('.voice-drag-handle'));
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

test('the offline recognition plan uses a constrained RT grammar with spoken callsign variants', () => {
  const plan = OfflineVoice.buildRecognitionPlan({ callsigns: ['FALCON 11', 'RAVEN 21'] });
  assert.ok(Array.isArray(plan.grammar));

  const grammar = plan.grammar;
  assert.ok(grammar.includes('[unk]'));
  assert.equal(grammar.includes('turn right heading two seven zero'), false, 'tactical RT grammar keeps turns callsign-specific');
  assert.ok(grammar.includes('falcon turn right heading two seven zero'));
  assert.ok(grammar.includes('transmit for df falcon 11'));
  assert.ok(grammar.includes('transmit for direction finding raven twenty one'));
  assert.ok(grammar.includes('transmit for d f raven two one'));

  const maximumTacticalPlan = OfflineVoice.buildRecognitionPlan({
    callsigns: ['FALCON 11', 'RAVEN 21', 'VIPER 31', 'EAGLE 41']
  }).grammar;
  assert.ok(maximumTacticalPlan.length < 12_000, 'the Android offline recognizer accepts no more than 12,000 phrases');
  assert.ok(Buffer.byteLength(JSON.stringify(maximumTacticalPlan)) < 500_000, 'the Android offline recognizer accepts no more than 500 KB of grammar JSON');
});
