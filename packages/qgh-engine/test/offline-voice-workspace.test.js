'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Voice = require('../voice-control.js');
const OfflineVoice = require('../offline-voice-engine.js');
const Radio = require('../radio-session.js');
const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'voice-workspace.js'), 'utf8');
const radioWorkspaceSource = fs.readFileSync(path.join(__dirname, '..', 'radio-workspace.js'), 'utf8');

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
  appendChild(child) {
    if (typeof child === 'string') { const text = new FakeElement('text'); text.textContent = child; child = text; }
    child.parentElement = this; this.children.push(child); return child;
  }
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
      if (!config.deferStop) hooks?.onEnded?.();
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
  const timerDeadlines = new Map();
  const listeners = new Map();
  const storage = new Map(options?.stored || []);
  let nextTimer = 1;
  let now = 0;
  const sandbox = {
    QGHVoiceControl: options?.voiceControl || Voice,
    QGHOfflineVoiceEngine: options?.offlineVoice,
    QghNativeVoice: options?.nativeVoice,
    QGHRadioWorkspace: options?.radio ? { status: () => ({ audioEnabled: false }), audioAvailable: () => false, ...options.radio } : undefined,
    document,
    Event: FakeEvent,
    setTimeout(callback, delay = 0) {
      const id = nextTimer++;
      timers.set(id, callback);
      timerDeadlines.set(id, now + delay);
      return id;
    },
    clearTimeout(id) { timers.delete(id); timerDeadlines.delete(id); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    innerWidth: options?.viewportWidth,
    innerHeight: options?.viewportHeight,
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    location: { href: 'https://example.test/qgh/single.html' }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workspaceSource, sandbox);
  return { document, timers, listeners, storage, sandbox, workspace: sandbox.QGHVoiceWorkspace,
    now: () => now,
    advanceTime(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timerDeadlines].filter(([id, deadline]) => timers.has(id) && deadline <= end)
          .sort((a, b) => a[1] - b[1])[0];
        if (!next) break;
        const [id, deadline] = next;
        const callback = timers.get(id);
        timers.delete(id);
        timerDeadlines.delete(id);
        now = deadline;
        callback();
      }
      now = end;
    }
  };
}

function createRadioEnvironment(options) {
  const env = createEnvironment(options);
  const aircraft = { source: 'single', callsign: 'FALCON 11', procedure: 'normal',
    heading: 230, simulationSeconds: 0, range: 10, qdm: 60, qte: 240 };
  const transmissions = [];
  const receiver = Radio.createReceiver({ observe: () => ({ ...aircraft }), now: env.now,
    setTimer: env.sandbox.setTimeout, clearTimer: env.sandbox.clearTimeout });
  env.sandbox.QGHRadioSession = Radio;
  env.sandbox.QGHRadioAdapter = {
    active: () => true,
    snapshot: () => ({ ...aircraft }),
    beginTransmit(source) { transmissions.push(source); return receiver.transmit(source); },
    endTransmit: token => receiver.release(token),
    observation: () => receiver.read(),
    controllerStart: () => receiver.controllerStart()
  };
  vm.runInContext(radioWorkspaceSource, env.sandbox);
  return { ...env, aircraft, transmissions, receiver, radio: env.sandbox.QGHRadioWorkspace };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('silent continuous resume leaves manual replies and passing reports free to transmit', async () => {
  const runtime = makeOfflineEngine({ cachedArchive: true });
  const env = createRadioEnvironment({ offlineVoice: runtime.api });
  await flush();
  const continuous = env.document.querySelector('.voice-continuous').children[0];
  continuous.checked = true;
  continuous.dispatchEvent(new FakeEvent('change'));
  await flush();
  const mic = env.document.querySelector('.voice-mic');
  mic.click();
  await flush();
  env.radio.requestHeadingPassing({ aircraft: 'single', heading: 240 });
  mic.click();
  await flush();
  assert.equal(mic.textContent, 'STOP', 'continuous recognition has resumed');
  assert.equal(env.radio.status().controllerHeld, false, 'listening in silence does not transmit');
  env.aircraft.heading = 241;
  env.radio.observeHeading('single', 241);
  env.radio.manualCommand({ intent: 'normal-turn-heading', side: 'right', heading: 270 });
  env.advanceTime(300);
  assert.equal(env.receiver.read().phase, 'live');
  env.advanceTime(10000);
  assert.deepEqual(env.transmissions, ['single', 'single'], 'both the new manual reply and passing report transmit without controller speech');
});

for (const error of ['not-allowed', 'audio-suspended', 'unavailable']) {
  test(`terminal ${error} releases radio without an ended callback`, async () => {
    for (const stage of ['start', 'continuous-speech']) {
      const runtime = makeOfflineEngine({ cachedArchive: true, ...(stage === 'start' ? { startError: error } : {}) });
      const env = createRadioEnvironment({ offlineVoice: runtime.api });
      await flush();
      env.radio.requestHeadingPassing({ aircraft: 'single', heading: 240 });
      if (stage === 'start') {
        env.document.querySelector('.voice-mic').dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
      } else {
        const continuous = env.document.querySelector('.voice-continuous').children[0];
        continuous.checked = true;
        continuous.dispatchEvent(new FakeEvent('change'));
        await flush();
        runtime.engine.lastStart.onPartial('Falcon');
      }
      assert.equal(env.radio.status().controllerHeld, true, `${stage}: PTT or speech owns the channel`);
      env.aircraft.heading = 241;
      env.radio.observeHeading('single', 241);
      if (stage === 'continuous-speech') runtime.engine.lastStart.onError(error);
      await flush();
      assert.equal(env.radio.status().controllerHeld, false, `${stage}: terminal error releases the channel`);
      assert.equal([...env.timers.values()].some(callback => callback.toString().includes('!state.pilotSpeaking && !state.pressHeld')), false,
        `${stage}: obsolete controller quiet timer is cleared`);
      env.radio.manualCommand({ intent: 'normal-turn-heading', side: 'right', heading: 270 });
      env.advanceTime(300);
      assert.equal(env.receiver.read().phase, 'live', `${stage}: manual reply is not locked behind the failed microphone`);
      env.advanceTime(10000);
      assert.deepEqual(env.transmissions, ['single', 'single'], `${stage}: crossing obligation survives and transmits after the manual reply`);
      assert.equal(runtime.engine.startCalls.length, 1, `${stage}: terminal error does not restart recognition`);
    }
  });
}

test('PTT radio release waits for delayed finalization and pilot audio invalidates late recognition', async () => {
  const calls = [];
  const runtime = makeOfflineEngine({ cachedArchive: true, deferStop: true });
  const env = createEnvironment({ offlineVoice: runtime.api,
    radio: { controllerStart: () => calls.push('start'), controllerEnd: () => calls.push('end'), reset() {}, acknowledge() {} } });
  await flush();
  const mic = env.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 })); await flush();
  const capture = runtime.engine.lastStart;
  capture.onResult('report heading');
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  assert.equal(calls.filter(call => call === 'end').length, 0);
  capture.onResult('request distance');
  assert.match(env.document.querySelector('.voice-last-call').children[1].textContent, /HEARD · request distance/);
  runtime.engine.triggerEnd();
  assert.equal(calls.filter(call => call === 'end').length, 1);
  env.workspace.setPilotSpeaking(true);
  capture.onResult('turn left heading 140');
  assert.match(env.document.querySelector('.voice-last-call').children[1].textContent, /HEARD · request distance/, 'old speech cannot self-execute during pilot playback');
});

test('continuous radio waits for a quiet boundary and stopping it prevents microphone restart after pilot speech', async () => {
  const calls = [];
  const runtime = makeOfflineEngine({ cachedArchive: true });
  const env = createEnvironment({ offlineVoice: runtime.api,
    radio: { controllerStart: () => calls.push('start'), controllerEnd: () => calls.push('end'), reset() {}, acknowledge() {} } });
  await flush();
  const continuous = env.document.querySelector('.voice-continuous').children[0];
  continuous.checked = true; continuous.dispatchEvent(new FakeEvent('change')); await flush();
  runtime.engine.lastStart.onResult('surface wind two three zero');
  assert.equal(calls.includes('end'), false);
  runtime.engine.lastStart.onPartial('ten knots');
  const quiet = [...env.timers.values()].filter(callback => callback.toString().includes('!state.pilotSpeaking && !state.pressHeld'));
  assert.equal(quiet.length, 1, 'only the most recent speech boundary survives');
  quiet[0]();
  assert.equal(calls.at(-1), 'end');
  env.workspace.setPilotSpeaking(true);
  continuous.checked = false; continuous.dispatchEvent(new FakeEvent('change'));
  const starts = runtime.engine.startCalls.length;
  env.workspace.setPilotSpeaking(false);
  [...env.timers.values()].forEach(callback => callback()); await flush();
  assert.equal(runtime.engine.startCalls.length, starts);
});

test('headphones keep continuous recognition live and controller speech interrupts the pilot', async () => {
  const calls = [];
  const runtime = makeOfflineEngine({ cachedArchive: true });
  let env;
  env = createEnvironment({ offlineVoice: runtime.api, radio: {
    allowsBargeIn: () => true,
    controllerStart() { calls.push('interrupt'); env.workspace.setPilotSpeaking(false); },
    controllerEnd() {}, reset() {}, acknowledge() {}
  } });
  await flush();
  const continuous = env.document.querySelector('.voice-continuous').children[0];
  continuous.checked = true; continuous.dispatchEvent(new FakeEvent('change')); await flush();
  const capture = runtime.engine.lastStart;
  const cancellations = runtime.engine.cancelCalls;
  env.workspace.setPilotSpeaking(true);
  assert.equal(runtime.engine.cancelCalls, cancellations, 'headphones do not cancel active recognition');
  capture.onPartial('turn left');
  assert.deepEqual(calls, ['interrupt']);
  capture.onResult('turn left heading 010');
  assert.match(env.document.querySelector('.voice-last-call').children[1].textContent, /HEARD · turn left heading 010/);
});

test('PTT releases outside without capture and ignores unrelated or duplicate releases', async () => {
  const runtime = makeOfflineEngine({ cachedArchive: true, deferStop: true });
  const env = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  const mic = env.document.querySelector('.voice-mic');
  mic.setPointerCapture = () => { throw new Error('capture unsupported'); };
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 7 }));
  assert.equal(mic.getAttribute('aria-pressed'), 'true', 'press feedback is immediate');
  await flush();
  env.listeners.get('pointerup')(new FakeEvent('pointerup', { pointerId: 8 }));
  assert.equal(runtime.engine.stopCalls.length, 0);
  env.listeners.get('pointerup')(new FakeEvent('pointerup', { pointerId: 7 }));
  assert.equal(runtime.engine.stopCalls.length, 1);
  assert.equal(env.document.querySelector('.voice-status').textContent, 'PROCESSING');
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
  mic.dispatchEvent(new FakeEvent('lostpointercapture', { pointerId: 7 }));
  assert.equal(runtime.engine.cancelCalls, 0, 'normal release still accepts its delayed final');
});

test('interrupted PTT cancels instead of submitting and stale errors cannot stop a fresh press', async () => {
  const runtime = makeOfflineEngine({ cachedArchive: true });
  const env = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  const mic = env.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  const old = runtime.engine.lastStart;
  mic.dispatchEvent(new FakeEvent('pointercancel', { pointerId: 1 }));
  assert.equal(runtime.engine.cancelCalls, 1);
  assert.equal(runtime.engine.stopCalls.length, 0);
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 2 }));
  await flush();
  old.onError('not-allowed');
  assert.equal(mic.getAttribute('aria-pressed'), 'true');
  env.listeners.get('pagehide')();
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
});

test('one PTT call is not dispatched twice, but a deliberate repeat on a new press is accepted', async () => {
  const runtime = makeOfflineEngine({ cachedArchive: true });
  let parsed = 0;
  const voiceControl = { ...Voice, parseCommand: (...args) => { parsed += 1; return Voice.parseCommand(...args); } };
  const env = createEnvironment({ offlineVoice: runtime.api, voiceControl });
  await flush();
  const mic = env.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 1 }));
  await flush();
  runtime.engine.triggerResult('transmit for df');
  runtime.engine.triggerResult('transmit for df');
  assert.equal(parsed, 1);
  mic.dispatchEvent(new FakeEvent('pointerup', { pointerId: 1 }));
  mic.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 2 }));
  await flush();
  runtime.engine.triggerResult('transmit for df');
  assert.equal(parsed, 2);
  assert.equal(env.storage.size, 0, 'no heard text is persisted');
  const fresh = createEnvironment({ offlineVoice: runtime.api });
  assert.match(fresh.document.querySelector('.voice-last-call').textContent || fresh.document.querySelector('.voice-last-call').children[1].textContent, /No voice call yet/);
});

test('saved dock position recovers into the viewport and can be reset', async () => {
  const env = createEnvironment({ offlineVoice: makeOfflineEngine().api, viewportWidth: 900, viewportHeight: 600,
    stored: [['qgh-voice-dock-position-v2', JSON.stringify({left:9999, top:9999})]] });
  await flush();
  const dock = env.document.querySelector('.voice-dock');
  assert.equal(dock.style.left, '824px');
  assert.equal(dock.style.top, '396px');
  env.document.querySelector('.voice-reset-position').click();
  assert.equal(dock.style.left, '');
  assert.equal(env.storage.size, 0);
});

test('voice result has one dedicated live announcement and no duplicated live dock outputs', async () => {
  const env = createEnvironment({ offlineVoice: makeOfflineEngine().api });
  await flush();
  env.workspace.dispatchTranscript('random words');
  const live = env.document.querySelector('.voice-announcement');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(env.document.querySelector('.voice-status').getAttribute('aria-live'), 'off');
  assert.equal(env.document.querySelector('.voice-feedback').getAttribute('aria-live'), 'off');
  for (const callback of [...env.timers.values()]) callback();
  assert.match(live.textContent, /^NOT RECOGNISED/);
});

test('keyboard PTT does not repeat on keydown and cancels when keyboard focus leaves', async () => {
  const runtime = makeOfflineEngine({ cachedArchive: true });
  const env = createEnvironment({ offlineVoice: runtime.api });
  await flush();
  const mic = env.document.querySelector('.voice-mic');
  mic.dispatchEvent(new FakeEvent('keydown', { key: ' ' }));
  mic.dispatchEvent(new FakeEvent('keydown', { key: ' ', repeat: true }));
  await flush();
  assert.equal(runtime.engine.startCalls.length, 1);
  mic.dispatchEvent(new FakeEvent('blur'));
  assert.equal(runtime.engine.cancelCalls, 1);
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
});

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
  assert.equal(environment.document.querySelector('.voice-status').textContent, 'REJECTED');
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
  const dragHandle = environment.document.querySelector('.voice-drag-handle');
  assert.ok(dragHandle);
  assert.equal(dragHandle.textContent, 'DRAG');
  assert.match(dragHandle.getAttribute('aria-label'), /hold and drag/i);
});

test('the DRAG grip clamps, persists, and keyboard-moves the complete voice dock', async () => {
  const runtime = makeOfflineEngine();
  const environment = createEnvironment({ offlineVoice: runtime.api, viewportWidth: 320, viewportHeight: 420 });
  await flush();

  const dock = environment.document.querySelector('.voice-dock');
  const dragHandle = environment.document.querySelector('.voice-drag-handle');
  dock.getBoundingClientRect = () => ({
    left: Number.parseFloat(dock.style.left) || 100,
    top: Number.parseFloat(dock.style.top) || 200,
    width: 68,
    height: 196
  });

  dragHandle.dispatchEvent(new FakeEvent('pointerdown', {
    button: 0,
    pointerId: 9,
    clientX: 112,
    clientY: 212
  }));
  environment.listeners.get('pointermove')(new FakeEvent('pointermove', {
    pointerId: 9,
    clientX: 999,
    clientY: 999
  }));
  environment.listeners.get('pointerup')(new FakeEvent('pointerup', {
    pointerId: 9,
    clientX: 999,
    clientY: 999
  }));

  assert.equal(dock.style.left, '244px', 'right edge clamps to an 8 px viewport margin');
  assert.equal(dock.style.top, '216px', 'bottom edge clamps to an 8 px viewport margin');
  assert.equal(dock.style.right, 'auto');
  assert.equal(dock.style.bottom, 'auto');
  assert.equal(dock.dataset.dragging, undefined);
  assert.deepEqual(JSON.parse(environment.storage.get('qgh-voice-dock-position-v2')), { left: 244, top: 216 });

  dragHandle.dispatchEvent(new FakeEvent('pointerdown', {
    button: 0,
    pointerId: 10,
    clientX: 250,
    clientY: 222
  }));
  environment.listeners.get('pointermove')(new FakeEvent('pointermove', {
    pointerId: 10,
    clientX: -99,
    clientY: -99
  }));
  dragHandle.dispatchEvent(new FakeEvent('lostpointercapture', { pointerId: 10 }));
  assert.equal(dock.style.left, '8px', 'left edge clamps to an 8 px viewport margin');
  assert.equal(dock.style.top, '8px', 'top edge clamps to an 8 px viewport margin');
  assert.equal(dock.dataset.dragging, undefined, 'lost pointer capture completes the drag safely');

  const right = new FakeEvent('keydown', { key: 'ArrowRight' });
  dragHandle.dispatchEvent(right);
  assert.equal(right.defaultPrevented, true);
  assert.equal(dock.style.left, '24px');
  assert.equal(dock.style.top, '8px');
  assert.deepEqual(JSON.parse(environment.storage.get('qgh-voice-dock-position-v2')), { left: 24, top: 8 });
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
