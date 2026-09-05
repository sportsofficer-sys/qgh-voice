'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Core = require('../simulator-core.js');
const Tactical = require('../tactical-core.js');
const Radio = require('../radio-session.js');

// Execute the real tactical controls and radio scheduler. Only DOM rendering,
// audio output and wall-clock timers are replaced; flight motion is the real core.
class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.classes = new Set();
    this.style = { setProperty() {} };
    this.classList = {
      contains: name => this.classes.has(name),
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      toggle: (name, force) => {
        const selected = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (selected) this.classes.add(name); else this.classes.delete(name);
        return selected;
      }
    };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  click() {
    if (!this.disabled) (this.listeners.get('click') || []).forEach(listener => listener({ target: this, currentTarget: this }));
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node?.fragment) this.append(...node.children);
      else {
        this.children.push(node);
        if (node && typeof node === 'object') node.parentElement = this;
      }
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) if (child && typeof child === 'object') child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  querySelectorAll(selector) {
    const matches = [];
    const field = /^\[data-tactical-field="([^"]+)"\]$/.exec(selector);
    const visit = node => {
      for (const child of node.children || []) {
        if (!(child instanceof Element)) continue;
        if ((selector.startsWith('.') && child.classList.contains(selector.slice(1)))
          || (field && child.dataset.tacticalField === field[1])) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function harness({ formation = false, procedure = 'normal', rate = 3 } = {}) {
  const directory = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(directory, 'tactical.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  for (const [id, value] of Object.entries({ tRunway: '230', tInbound: '225', tOutbound: '065' })) elements[id].value = value;
  elements.tSetup.classList.add('active');
  elements.tTerminateDialog.showModal = function () { this.open = true; };
  elements.tTerminateDialog.close = function () { this.open = false; };
  const document = {
    getElementById: id => elements[id] || null,
    createElement: () => new Element(),
    createTextNode: text => ({ textContent: text }),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    querySelectorAll: selector => selector === '.tactical-aircraft-row'
      ? elements.tAircraftRows.querySelectorAll(selector) : []
  };
  let now = 0;
  let nextTimer = 0;
  let randomState = 0x5a17c0de;
  const timers = new Map();
  const intervals = new Map();
  const captions = [];
  const context = {
    document, console, Uint32Array,
    setTimeout(callback, delay = 0) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval(callback) { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    QGHCore: Core,
    QGHTacticalCore: Tactical,
    QGHRadioSession: { ...Radio, createReceiver: options => Radio.createReceiver({ ...options, now: () => now }) },
    QGHTacticalReview: { draw() {}, setZoomEnabled() {} },
    crypto: { getRandomValues(values) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      values[0] = randomState;
      return values;
    } }
  };
  context.window = context;
  vm.createContext(context);
  const simulator = fs.readFileSync(path.join(directory, 'tactical-simulator.js'), 'utf8').replace(
    /\n\}\)\(\);\s*$/, '\n  window.__tacticalTestState = state;\n})();\n'
  );
  vm.runInContext(simulator, context, { filename: 'tactical-simulator.js' });
  context.QGHVoiceWorkspace = {
    isDispatchingRadioCommand: () => false,
    setPilotSpeaking() {},
    showPilotReply: reply => captions.push({ ...reply, source: context.QGHRadioAdapter.observation().source })
  };
  vm.runInContext(fs.readFileSync(path.join(directory, 'radio-workspace.js'), 'utf8'), context, { filename: 'radio-workspace.js' });
  for (const row of document.querySelectorAll('.tactical-aircraft-row')) {
    row.querySelector('[data-tactical-field="rate"]').value = String(rate);
  }
  if (formation) elements.tFormationOn.click();
  if (procedure === 'us') elements.tProcedureUs.click();
  elements.tStart.click();
  const state = context.__tacticalTestState;
  assert.ok(state.exercise, `exercise startup failed: ${elements.tToast.textContent}`);
  assert.equal(elements.tConsole.classList.contains('active'), true);
  return {
    state, elements, captions, radio: context.QGHRadioWorkspace, adapter: context.QGHRadioAdapter,
    aircraft: id => Tactical.getAircraft(state.exercise, id),
    click: id => elements[id].click(),
    select: id => state.railItems.get(id).select.click(),
    speed(value) {
      const input = elements.tLiveSpeed;
      input.value = String(value);
      for (const type of ['input', 'change']) {
        for (const listener of input.listeners.get(type) || []) listener({ target: input, currentTarget: input });
      }
    },
    arm(id, heading) {
      return context.QGHRadioWorkspace.requestHeadingPassing({ intent: 'request-heading-passing', aircraft: id, heading });
    },
    turn(id, side, heading) {
      state.railItems.get(id).select.click();
      elements.tHeadingInput.value = String(heading);
      elements[side === 'left' ? 'tTurnLeft' : 'tTurnRight'].click();
    },
    tick(count = 1) {
      for (let index = 0; index < count; index += 1) intervals.get(state.flightTimer)?.();
    },
    advanceTime(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    }
  };
}

const clone = value => JSON.parse(JSON.stringify(value));
const crossingLogs = h => h.state.commands.filter(item => item.type === 'HEADING PASSING REPORT' && /^PASSED /.test(item.detail));

test('manual tactical speed supersedes only its aircraft pending speed reply', () => {
  const h = harness();
  h.radio.controllerStart();
  h.select('A'); h.speed(240);
  h.select('B'); h.speed(260);
  h.select('A'); h.speed(300);
  assert.equal(h.aircraft('A').cfg.speed, 300, 'flight speed changes before the channel is released');
  assert.equal(h.aircraft('B').cfg.speed, 260);
  assert.equal(h.radio.status().pending, 2, 'one current speed reply remains per aircraft');
  h.select('C');
  h.radio.controllerEnd();
  h.advanceTime(10000);
  assert.deepEqual(h.captions.map(reply => ({ source: reply.source, text: reply.text })), [
    { source: 'B', text: 'SPEED 260 KT · RAVEN 21' },
    { source: 'A', text: 'SPEED 300 KT · FALCON 11' }
  ]);
});

test('unchanged or rejected manual tactical speeds produce no pilot reply', () => {
  const h = harness();
  h.select('A'); h.speed(300); h.advanceTime(10000);
  assert.equal(h.captions.length, 1);
  for (const value of [300, 59, 601, 'invalid']) h.speed(value);
  h.advanceTime(10000);
  assert.equal(h.aircraft('A').cfg.speed, 300);
  assert.equal(h.captions.length, 1, 'invalid and unchanged edits cannot restart a readback');

  const formation = harness({ formation: true });
  const previousSpeed = formation.aircraft('B').cfg.speed;
  formation.select('B'); formation.speed(300); formation.advanceTime(10000);
  assert.equal(formation.aircraft('B').cfg.speed, previousSpeed);
  assert.equal(Tactical.formationRoleFor(formation.state.exercise, 'B'), 'FORMATION');
  assert.equal(formation.captions.length, 0, 'a rejected follower amendment never acknowledges a new speed');
});

test('real tactical orbit controls and automatic radio keep callsign identity and resume the entry heading', () => {
  for (const procedure of ['normal', 'us']) {
    const h = harness({ procedure, rate: 8 });
    h.select('B'); const aircraft = h.aircraft('B'); aircraft.plane.heading = 210;
    const entry = { ...aircraft.plane };
    h.click('tOrbitRight'); h.radio.interrupt(); h.select('A');
    h.click('tAdvance');
    assert.equal(aircraft.orbit.laps, 1);
    assert.equal(aircraft.orbit.degrees, 480);
    h.advanceTime(300);
    assert.equal(h.captions.at(-1).source, 'B');
    assert.match(h.captions.at(-1).text, /ORBIT COMPLETE, CONTINUING RIGHT ORBIT/);
    h.select('B'); h.click('tContinueOrbit'); h.click('tResumeNormal');
    h.tick(120);
    assert.equal(aircraft.orbit, null);
    assert.equal(aircraft.plane.heading, 210);
    assert.ok(Math.hypot(aircraft.plane.x - entry.x, aircraft.plane.y - entry.y) < 1e-8);
    assert.equal(h.elements.tResumeNormal.disabled, true);
    assert.equal(h.elements.tUsStop.disabled, true);
    h.advanceTime(10000);
    assert.ok(h.captions.some(caption => caption.source === 'B' && /RESUMING NORMAL/.test(caption.text)));
  }
});

test('tactical Advance observes every flight step and preserves the reporting aircraft after selection changes', () => {
  const h = harness({ rate: 8 });
  const falcon = h.aircraft('A');
  falcon.plane.heading = 350;
  h.turn('A', 'right', 200);
  h.radio.interrupt();
  const before = clone(h.state.exercise);
  assert.equal(h.arm('A', 63).ok, true);
  assert.deepEqual(clone(h.state.exercise), before, 'arming must not alter the flight or assigned heading');
  h.select('B');
  const samples = falcon.path.length;
  h.click('tAdvance');
  assert.equal(falcon.path.length, samples + 240);
  assert.equal(falcon.plane.heading, 200);
  assert.equal(h.state.exercise.simulationSeconds, 60);
  assert.equal(crossingLogs(h).length, 1, 'a 210-degree turn crosses 063 even though the shortest endpoint arc does not');
  assert.equal(crossingLogs(h)[0].aircraftId, 'A');
  assert.equal(crossingLogs(h)[0].callsign, 'FALCON 11');
  h.advanceTime(300);
  assert.match(h.captions[0].text, /^PASSED 063°M · FALCON 11$/);
  assert.equal(h.captions[0].source, 'A');
  assert.equal(h.adapter.observation().phase, 'live');
  assert.equal(h.adapter.observation().source, 'A');
  assert.equal(h.state.activeAircraftId, 'B', 'automatic transmission does not select the reporting aircraft');
  h.click('tAdvance');
  h.advanceTime(10000);
  assert.equal(h.captions.length, 1, 'the crossing report remains one-shot');
});

test('live tactical steps report once for the addressed aircraft without changing its turn', () => {
  const h = harness();
  const raven = h.aircraft('B');
  raven.plane.heading = 142;
  h.turn('B', 'left', 90);
  h.radio.interrupt();
  assert.equal(h.arm('B', 140).ok, true);
  h.select('A');
  h.tick(2);
  assert.equal(crossingLogs(h).length, 0);
  h.tick();
  assert.equal(crossingLogs(h).length, 1);
  h.advanceTime(300);
  assert.equal(h.captions[0].text, 'PASSING 140°M · RAVEN 21');
  assert.equal(h.captions[0].source, 'B');
  assert.equal(raven.targetHeading, 90);
  assert.equal(raven.forcedTurnSide, 'left');
  assert.equal(h.state.activeAircraftId, 'A');
});

test('tactical Advance preserves separate reports for multiple aircraft', () => {
  const h = harness();
  h.aircraft('A').plane.heading = 350;
  h.turn('A', 'right', 120);
  h.aircraft('B').plane.heading = 120;
  h.turn('B', 'left', 60);
  h.radio.interrupt();
  assert.equal(h.arm('A', 360).ok, true);
  assert.equal(h.arm('B', 90).ok, true);
  h.select('C');
  h.click('tAdvance');
  h.advanceTime(10000);
  assert.deepEqual(h.captions.map(reply => reply.source), ['A', 'B']);
  assert.match(h.captions[0].text, /000°M · FALCON 11/);
  assert.match(h.captions[1].text, /090°M · RAVEN 21/);
  assert.equal(h.state.activeAircraftId, 'C');
  assert.equal(crossingLogs(h).length, 2);
});

test('a formation-member passing report neither detaches the member nor changes the flight path', () => {
  const h = harness({ formation: true });
  const baseline = harness({ formation: true });
  const leaderHeading = h.aircraft('A').plane.heading;
  const requested = Core.normalize(leaderHeading + 30);
  const target = Core.normalize(leaderHeading + 90);
  for (const current of [h, baseline]) {
    current.turn('A', 'right', target);
    current.radio.interrupt();
    current.select('C');
  }
  const before = clone(h.state.exercise);
  assert.equal(h.arm('B', requested).ok, true);
  assert.deepEqual(clone(h.state.exercise), before);
  assert.equal(Tactical.formationRoleFor(h.state.exercise, 'B'), 'FORMATION');
  h.click('tAdvance');
  baseline.click('tAdvance');
  assert.deepEqual(clone(h.state.exercise), clone(baseline.state.exercise), 'reporting must not change any aircraft path or formation state');
  assert.equal(Tactical.formationRoleFor(h.state.exercise, 'B'), 'FORMATION');
  h.advanceTime(10000);
  assert.equal(h.captions.length, 1);
  assert.equal(h.captions[0].source, 'B');
  assert.match(h.captions[0].text, /RAVEN 21$/);
  assert.equal(h.state.activeAircraftId, 'C');
});

test('tactical U/S Compass rejects passing reports without disclosing or changing heading', () => {
  const h = harness({ procedure: 'us' });
  const before = clone(h.state.exercise);
  const outcome = h.arm('B', 219);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /HEADING REPORTS UNAVAILABLE.*U\/S COMPASS/);
  assert.doesNotMatch(outcome.message, /\d{3}/);
  assert.deepEqual(clone(h.state.exercise), before);
  h.click('tAdvance');
  h.advanceTime(10000);
  assert.equal(h.captions.length, 0);
  assert.equal(crossingLogs(h).length, 0);
});

test('tactical exercise transitions clear both armed and crossed-but-unsent reports', () => {
  for (const transition of ['restart', 'terminate', 'new']) {
    for (const crossed of [false, true]) {
      const h = harness();
      h.aircraft('A').plane.heading = 0;
      h.turn('A', 'right', 90);
      h.radio.interrupt();
      assert.equal(h.arm('A', 45).ok, true);
      if (crossed) h.click('tAdvance');
      if (transition === 'restart') h.click('tRestart');
      if (transition === 'terminate') {
        h.click('tTerminate');
        h.click('tConfirmTerminate');
        assert.equal(h.elements.tAnalysis.classList.contains('active'), true);
        h.click('tReturnConsole');
      }
      if (transition === 'new') {
        h.click('tNewExercise');
        assert.equal(h.elements.tSetup.classList.contains('active'), true);
        assert.equal(h.arm('A', 45).ok, false, 'reports are unavailable in setup');
        h.click('tStart');
      }
      h.aircraft('A').plane.heading = 0;
      h.turn('A', 'right', 90);
      h.radio.interrupt();
      h.click('tAdvance');
      h.advanceTime(10000);
      assert.equal(h.captions.length, 0, `${transition}, crossed=${crossed}: no old report may return`);
    }
  }
});

test('resetting tactical microphone playback preserves an armed flight report', () => {
  const h = harness();
  h.aircraft('A').plane.heading = 60;
  h.turn('A', 'right', 90);
  h.radio.interrupt();
  assert.equal(h.arm('A', 63).ok, true);
  h.radio.reset();
  h.tick(4);
  h.advanceTime(300);
  assert.equal(h.captions[0].text, 'PASSING 063°M · FALCON 11');
});
