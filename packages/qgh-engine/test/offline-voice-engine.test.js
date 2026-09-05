'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const engineSource = fs.readFileSync(path.join(__dirname, '..', 'offline-voice-engine.js'), 'utf8');
const OfflineVoice = require('../offline-voice-engine.js');
const Voice = require('../voice-control.js');

function node() {
  return { connect() {}, disconnect() {} };
}

function loadEngineRuntime(options) {
  const config = options || {};
  const timers = new Map();
  let nextTimer = 1;
  const state = {
    recognizer: null,
    recognizers: [],
    audioContexts: [],
    resumeCalls: 0,
    streamRequests: 0,
    contextPresentAtStreamRequest: false
  };

  class FakeRecognizer {
    constructor() {
      this.listeners = new Map();
      this.removed = false;
      state.recognizer = this;
      state.recognizers.push(this);
    }

    on(event, listener) { this.listeners.set(event, listener); }
    acceptWaveform() {}
    retrieveFinalResult() {}
    remove() { this.removed = true; }
    emit(event, payload) {
      if (!this.removed) this.listeners.get(event)?.(payload);
    }
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.destination = node();
      this.state = config.initialAudioState || 'running';
      this.closed = false;
      state.audioContexts.push(this);
    }

    async resume() {
      state.resumeCalls += 1;
      if (config.resumeRejects) throw new Error('audio context is blocked');
      if (config.resumeToState) this.state = config.resumeToState;
    }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return { ...node(), onaudioprocess: null }; }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    async close() { this.closed = true; this.state = 'closed'; }
  }

  const track = { stop() {}, addEventListener() {} };
  const sandbox = {
    URL,
    Blob,
    Headers,
    Request,
    Response,
    Worker: function Worker() {},
    AudioContext: FakeAudioContext,
    Vosk: {
      createModel: async () => ({ KaldiRecognizer: FakeRecognizer })
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          state.streamRequests += 1;
          state.contextPresentAtStreamRequest = state.audioContexts.length > 0;
          return { getTracks: () => [track] };
        }
      }
    },
    location: { href: 'https://example.test/qgh/offline-voice-engine.js', protocol: 'https:' },
    setTimeout(callback, delay) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.cleared = true;
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(engineSource, sandbox, { filename: 'offline-voice-engine.js' });
  return { api: sandbox.QGHOfflineVoiceEngine, state, timers };
}

test('keeps a PTT session alive until a delayed final offline result arrives', async () => {
  const runtime = loadEngineRuntime();
  const transcripts = [];
  const session = runtime.api.create();
  await session.start({ onResult: transcript => transcripts.push(transcript) });

  session.stop();
  for (const timer of runtime.timers.values()) {
    if (!timer.cleared && timer.delay <= 1000) timer.callback();
  }
  runtime.state.recognizer.emit('result', { result: { text: 'turn right heading two seven zero' } });

  assert.deepEqual(transcripts, ['turn right heading two seven zero']);
  assert.equal(runtime.state.recognizer.removed, true, 'the session cleans up after forwarding the final result');
});

test('cancelling during final drain suppresses late speech and false no-speech feedback', async () => {
  const runtime = loadEngineRuntime();
  const callbacks = [];
  const session = runtime.api.create();
  await session.start({ onResult: () => callbacks.push('result'), onNoResult: () => callbacks.push('empty') });
  const recognizer = runtime.state.recognizer;
  session.stop();
  session.cancel();
  recognizer.emit('result', { result: { text: 'transmit for df' } });
  assert.deepEqual(callbacks, []);
});

test('replaces a pending PTT final-result drain before a new press starts', async () => {
  const runtime = loadEngineRuntime();
  const lifecycle = [];
  const session = runtime.api.create({ onEnded: () => lifecycle.push('ended') });
  await session.start({});
  const firstRecognizer = runtime.state.recognizer;

  session.stop();
  assert.equal(session.isFinalizing(), true, 'release waits for the first final result');
  assert.equal(runtime.state.recognizers.length, 1);
  assert.equal(session.replacePendingFinalResult(), true, 'the workspace can retire a stale final result before the next press');
  assert.equal(session.isFinalizing(), false);
  assert.equal(firstRecognizer.removed, true);

  await session.start({});

  assert.equal(runtime.state.recognizers.length, 2, 'a new recognizer opens immediately for the new PTT press');
  assert.equal(session.isFinalizing(), false);
  assert.deepEqual(lifecycle, [], 'the stale final result does not emit an end callback into the new PTT press');
  session.cancel();
});

test('keeps a four-aircraft tactical grammar within Android limits and parser-compatible', () => {
  const maximumLengthCallsigns = [
    'ABCDEFGHIJKLMNOPQRST', 'UVWXYZABCDEFGHIJKLMN',
    'QWERTYUIOPASDFGHJKLZ', 'ZXCVBNMASDFGHJKLQWER'
  ];
  const maximumLengthGrammar = OfflineVoice.buildRecognitionPlan({
    screen: 'tactical-console', callsigns: maximumLengthCallsigns
  }).grammar;
  assert.ok(maximumLengthGrammar.length < 12_000);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumLengthGrammar)) < 500_000);

  const sharedDesignatorCallsigns = [
    { id: 'A', callsign: 'ABCDEFGHIJKLMNOP 101' },
    { id: 'B', callsign: 'ABCDEFGHIJKLMNOP 102' },
    { id: 'C', callsign: 'ABCDEFGHIJKLMNOP 103' },
    { id: 'D', callsign: 'ABCDEFGHIJKLMNOP 104' }
  ];
  const sharedDesignatorGrammar = OfflineVoice.buildRecognitionPlan({
    screen: 'tactical-console', callsigns: sharedDesignatorCallsigns
  }).grammar;
  const explicitTargetPhrase = 'abcdefghijklmnop one hundred one turn right two two zero';
  assert.ok(sharedDesignatorGrammar.includes(explicitTargetPhrase), 'ambiguous designators need a complete callsign phrase');
  assert.equal(
    Voice.parseCommand(explicitTargetPhrase, { callsigns: sharedDesignatorCallsigns }).aircraft,
    'A',
    'every target phrase admitted to the grammar must route to its configured aircraft'
  );
  assert.ok(Buffer.byteLength(JSON.stringify(sharedDesignatorGrammar)) < 500_000);
  assert.equal(sharedDesignatorGrammar.includes('select aircraft profile mirage two thousand'), false);
});

test('offline Normal turn grammar preserves both heading phrases across single and tactical exercises', () => {
  const scenarios = [
    { screen: 'single-console', callsigns: [], targets: [''] },
    {
      screen: 'tactical-console',
      callsigns: ['FALCON 11', 'RAVEN 21', 'VIPER 31', 'EAGLE 41'],
      targets: ['falcon', 'raven', 'viper', 'eagle']
    },
    {
      screen: 'tactical-console',
      callsigns: ['ABCDEFGHIJKLMNOP 101', 'ABCDEFGHIJKLMNOP 102', 'ABCDEFGHIJKLMNOP 103', 'ABCDEFGHIJKLMNOP 104'],
      targets: ['abcdefghijklmnop one hundred one', 'abcdefghijklmnop one hundred two', 'abcdefghijklmnop one hundred three', 'abcdefghijklmnop one hundred four']
    },
    {
      screen: 'tactical-console',
      callsigns: ['ABCDEFGHIJKLMNOP 999', 'ABCDEFGHIJKLMNOP 998', 'ABCDEFGHIJKLMNOP 997', 'ABCDEFGHIJKLMNOP 996'],
      targets: ['abcdefghijklmnop niner niner niner', 'abcdefghijklmnop niner niner eight', 'abcdefghijklmnop niner niner seven', 'abcdefghijklmnop niner niner six']
    },
    {
      screen: 'tactical-console',
      callsigns: ['ABCDEFGHIJKLMNOP 001', 'ABCDEFGHIJKLMNOP 002', 'ABCDEFGHIJKLMNOP 003', 'ABCDEFGHIJKLMNOP 004'],
      targets: ['abcdefghijklmnop zero zero one', 'abcdefghijklmnop zero zero two', 'abcdefghijklmnop zero zero tree', 'abcdefghijklmnop zero zero four']
    }
  ];

  for (const scenario of scenarios) {
    const grammar = OfflineVoice.buildRecognitionPlan(scenario).grammar;
    const phrases = new Set(grammar);
    assert.ok(grammar.length < 12_000, scenario.callsigns.join(', '));
    assert.ok(Buffer.byteLength(JSON.stringify(grammar)) < 490_000, scenario.callsigns.join(', '));
    for (const [index, target] of scenario.targets.entries()) {
      const prefix = target ? `${target} ` : '';
      for (const [heading, spoken] of [
        [0, 'zero zero zero'], [5, 'zero zero fife'], [140, 'one four zero'],
        [270, 'two seven zero'], [359, 'tree fife niner'], [360, 'tree six zero']
      ]) {
        for (const side of ['left', 'right']) {
          for (const headingWord of ['', 'heading ']) {
            const phrase = `${prefix}turn ${side} ${headingWord}${spoken}`;
            assert.ok(phrases.has(phrase), `missing offline phrase: ${phrase}`);
            const command = Voice.parseCommand(phrase, scenario);
            assert.equal(command.intent, 'normal-turn-heading', phrase);
            assert.equal(command.heading, heading, phrase);
            assert.equal(command.side, side, phrase);
            assert.equal(command.aircraft, scenario.callsigns[index], phrase);
          }
        }
      }
      for (const side of ['left', 'right']) {
        const phrase = `${prefix}turn ${side} now`;
        assert.ok(phrases.has(phrase), `missing U/S timed turn: ${phrase}`);
        assert.equal(Voice.parseCommand(phrase, scenario).intent, 'us-turn', phrase);
      }
    }
  }
});

test('primes the audio context before requesting microphone access', async () => {
  const runtime = loadEngineRuntime();
  const session = runtime.api.create();
  await session.start({});

  assert.equal(runtime.state.contextPresentAtStreamRequest, true);
  assert.equal(runtime.state.resumeCalls, 1);
  session.cancel();
});

test('never reports listening when the browser leaves the audio context suspended', async () => {
  const runtime = loadEngineRuntime({ initialAudioState: 'suspended' });
  const session = runtime.api.create();
  const errors = [];
  let started = false;

  await assert.rejects(() => session.start({
    onStarted: () => { started = true; },
    onError: error => errors.push(error)
  }));

  assert.equal(started, false);
  assert.deepEqual(errors, ['audio-suspended']);
  assert.equal(runtime.state.streamRequests, 0, 'a suspended audio path is rejected before microphone capture');
  assert.equal(runtime.state.audioContexts[0].closed, true);
});
