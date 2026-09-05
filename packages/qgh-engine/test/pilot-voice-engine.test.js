'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const engineSource = fs.readFileSync(path.join(__dirname, '..', 'pilot-voice-engine.js'), 'utf8');

function loadRuntime(options = {}) {
  const state = { workers: [], contexts: [], audio: [], timers: new Map() };
  class Worker {
    constructor(url, settings) { this.url = url; this.settings = settings; this.messages = []; state.workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(message) { this.onmessage({ data: message }); }
  }
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; state.contexts.push(this); }
    resume() { this.resumed = true; this.state = options.suspended ? 'suspended' : 'running'; return Promise.resolve(); }
    createBuffer(channels, length, sampleRate) { return { channels, length, sampleRate, copyToChannel() {} }; }
    createBufferSource() {
      const node = { connect() {}, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop() { this.stopped = true; } };
      state.audio.push(node);
      return node;
    }
  }
  const root = {
    URL, Float32Array, WebAssembly, Worker: options.unavailable ? undefined : Worker, AudioContext,
    document: { currentScript: { src: 'https://example.test/qgh/v4/pilot-voice-engine.js' } },
    location: { href: 'https://example.test/elsewhere/' },
    setTimeout(fn, delay) { const id = state.timers.size + 1; state.timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { state.timers.delete(id); }
  };
  root.globalThis = root;
  vm.runInNewContext(engineSource, root);
  return { api: root.QGHPilotVoiceEngine, state, root };
}

async function ready(runtime) {
  const preparing = runtime.api.prepare();
  runtime.state.workers.at(-1).emit({ type: 'ready' });
  await preparing;
  return runtime.state.workers.at(-1);
}

test('pilot voice preparation is explicit and assets resolve beside the loaded script', async () => {
  const runtime = loadRuntime();
  assert.equal(runtime.api.capability(), 'unprepared');
  assert.equal(runtime.state.workers.length, 0);
  assert.equal(runtime.state.contexts.length, 0);
  const progress = [];
  const prepared = runtime.api.prepare({ onProgress: value => progress.push(value.phase) });
  assert.equal(runtime.state.contexts[0].resumed, true, 'audio is unlocked synchronously inside the user gesture');
  assert.equal(runtime.api.capability(), 'preparing');
  assert.equal(runtime.state.workers[0].url, 'https://example.test/qgh/v4/pilot-voice-worker.js');
  assert.equal(runtime.state.workers[0].settings.type, 'module');
  runtime.state.workers[0].emit({ type: 'progress', progress: { phase: 'model' } });
  runtime.state.workers[0].emit({ type: 'ready' });
  await prepared;
  assert.deepEqual(progress, ['model']);
  assert.equal(runtime.api.capability(), 'ready');
});

test('fixed pilot profiles remain distinct across runtimes without device voice enumeration', () => {
  const a = loadRuntime().api;
  const b = loadRuntime().api;
  const ids = ['A', 'B', 'C', 'D'].map(source => a.profile(source).id);
  assert.deepEqual(ids, ['am_michael', 'am_fenrir', 'am_puck', 'bm_george']);
  for (const source of ['single', 'A', 'B', 'C', 'D', 'RAVEN 21']) {
    assert.equal(a.profile(source).id, b.profile(source).id);
  }
  assert.equal(a.voices.length, 4);
  assert.equal(a.profile('single').id, a.profile('A').id);
  assert.equal(a.profile('aircraft-B').id, 'am_fenrir');
  assert.equal(Object.isFrozen(a.voices), true);
});

test('speech cannot implicitly initialize the pack or fall back to system speech', () => {
  const { api, state } = loadRuntime();
  const failures = [];
  api.speak({ text: 'Raven two one', onerror: error => failures.push(error.message) });
  assert.equal(failures.length, 1);
  assert.equal(state.workers.length, 0);
  assert.doesNotMatch(engineSource, /speechSynthesis|SpeechSynthesisUtterance/);
});

test('cancel drops delayed synthesis and silences audio without completion callbacks', async () => {
  const runtime = loadRuntime();
  const worker = await ready(runtime);
  const events = [];
  runtime.api.speak({ text: 'Raven, turning left.', source: 'B', onstart: () => events.push('start'), onend: () => events.push('end') });
  const first = worker.messages.at(-1);
  assert.equal(first.voice, 'am_fenrir');
  runtime.api.cancel();
  worker.emit({ type: 'audio', token: first.token, samples: new Float32Array(24), sampleRate: 24000 });
  assert.equal(runtime.state.audio.length, 0);
  assert.deepEqual(events, []);
  runtime.api.speak({ text: 'Raven, steady.', onstart: () => events.push('start'), onend: () => events.push('end') });
  const second = worker.messages.at(-1);
  worker.emit({ type: 'audio', token: second.token, samples: new Float32Array(24), sampleRate: 24000 });
  const playing = runtime.state.audio.at(-1);
  const lateEnd = playing.onended;
  runtime.api.cancel();
  assert.equal(playing.stopped, true);
  lateEnd();
  assert.deepEqual(events, ['start']);
});

test('onstart reports generated audio duration in seconds after playback begins', async () => {
  const runtime = loadRuntime();
  const worker = await ready(runtime);
  const events = [];
  runtime.api.speak({ text: 'Raven, steady.',
    onstart: playback => {
      assert.equal(runtime.state.audio.at(-1).started, true);
      assert.deepEqual(Object.keys(playback), ['durationSeconds']);
      events.push(playback.durationSeconds);
    },
    onend: () => events.push('end')
  });
  const token = worker.messages.at(-1).token;
  worker.emit({ type: 'audio', token, samples: new Float32Array(30000), sampleRate: 24000 });
  assert.deepEqual(events, [1.25]);
  assert.equal(runtime.state.timers.size, 0, 'generation watchdog clears before playback');
  runtime.state.audio.at(-1).onended();
  assert.deepEqual(events, [1.25, 'end']);
});

test('a replacement transmission rejects stale audio and stale errors', async () => {
  const runtime = loadRuntime();
  const worker = await ready(runtime);
  const events = [];
  runtime.api.speak({ text: 'Old.', onerror: () => events.push('old error') });
  const oldToken = worker.messages.at(-1).token;
  runtime.api.speak({ text: 'Current.', onstart: () => events.push('current start'), onend: () => events.push('current end') });
  const currentToken = worker.messages.at(-1).token;
  worker.emit({ type: 'error', token: oldToken, error: 'old error' });
  worker.emit({ type: 'audio', token: oldToken, samples: new Float32Array(1), sampleRate: 24000 });
  worker.emit({ type: 'audio', token: currentToken, samples: new Float32Array(24), sampleRate: 24000 });
  runtime.state.audio[0].onended();
  assert.deepEqual(events, ['current start', 'current end']);
});

test('worker crashes reset preparation and permit an explicit retry', async () => {
  const runtime = loadRuntime();
  const prepared = runtime.api.prepare();
  const worker = runtime.state.workers[0];
  worker.onerror();
  await assert.rejects(prepared, /worker failed/);
  assert.equal(worker.terminated, true);
  assert.equal(runtime.api.capability(), 'unprepared');
  await ready(runtime);
  worker.onerror();
  worker.emit({ type: 'error', error: 'old worker error' });
  assert.equal(runtime.api.capability(), 'ready');
});

test('bundled segments cover generated radio replies without spelling fixed words', async () => {
  const runtime = await import(pathToFileURL(path.join(__dirname, '..', 'vendor/pilot-tts/runtime.mjs')).href);
  const recipe = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vendor/pilot-tts/render-recipe.json'), 'utf8'));
  const index = { phrases: recipe.segments.filter(segment => segment.kind === 'phrase').map(segment => segment.key) };
  const Radio = require('../radio-session.js');
  const aircraft = { callsign: 'RAVEN 21', heading: 140, range: 13.2, orbitSide: 'left', turnSide: 'right', procedure: 'normal' };
  const commands = [
    { intent: 'radio-exchange', radioKind: 'receipt' }, { intent: 'radio-exchange', radioKind: 'unmodelled', radioLabel: 'INSTRUCTION' },
    ...['resume-normal', 'orbit-resumed', 'start-orbit', 'continue-orbit', 'orbit-complete', 'us-turn', 'us-turn-stop',
      'normal-turn-heading', 'continue-turn-heading', 'request-heading-passing', 'heading-passing-report', 'report-heading',
      'request-distance', 'transmit-df', 'stop-following-leader'].map(intent => ({ intent, side: 'left', heading: 140 })),
    { intent: 'set-field', field: 'speed', value: 180 }
  ];
  for (const command of commands) {
    const reply = Radio.replyFor(command, aircraft);
    assert.ok(reply, command.intent);
    const segments = runtime.selectSegments(reply.speech, index);
    assert.ok(segments.length > 0, reply.speech);
    assert.equal(segments.some(segment => segment.startsWith('letter:')), false, reply.speech);
  }
  assert.deepEqual(runtime.selectSegments('QZX 09', index), ['letter:q', 'letter:z', 'letter:x', 'zero', 'nine']);
  assert.deepEqual(runtime.selectSegments('Radio check. Pilot replies are set to one hundred words per minute.', index), ['radio check pilot replies are set to one hundred words per minute']);
  assert.deepEqual(runtime.selectSegments('Roger, turning left, one four zero, Raven 21.', index), ['roger turning left', 'one', 'four', 'zero', 'raven', 'two', 'one']);
  assert.deepEqual(runtime.selectSegments('Falcon Raven Viper Hawk Eagle', index), ['falcon', 'raven', 'viper', 'hawk', 'eagle']);
  for (const segment of recipe.segments) {
    assert.equal(segment.ids[0], 0);
    assert.equal(segment.ids.at(-1), 0);
    assert.equal(segment.ids.length, Array.from(segment.phonemes).length + 2);
    assert.ok(segment.ids.length <= 512);
  }
});

test('all bundled assets match their pinned manifest and remain below ordinary Git file limits', () => {
  const { createHash } = require('node:crypto');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pilot-voices/manifest.json'), 'utf8'));
  assert.equal(manifest.voices.length, 4);
  for (const asset of manifest.assets) {
    assert.match(asset.path, /^(?:pilot-voices\/|vendor\/pilot-tts\/)/);
    const bytes = fs.readFileSync(path.join(root, asset.path));
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
    assert.ok(bytes.length < 100 * 1024 * 1024, asset.path);
  }
  const source = fs.readFileSync(path.join(root, 'vendor/pilot-tts/runtime.mjs'), 'utf8');
  assert.doesNotMatch(source, /https?:\/\//);
  assert.doesNotMatch(source, /onnxruntime|WebAssembly|speechSynthesis|InferenceSession/);
});

test('all four real banks contain complete bounded segments and assemble a readback', async () => {
  const runtime = await import(pathToFileURL(path.join(__dirname, '..', 'vendor/pilot-tts/runtime.mjs')).href);
  const root = path.join(__dirname, '..', 'pilot-voices');
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  const fingerprints = new Set();
  const { createHash } = require('node:crypto');
  for (const voice of runtime.VOICE_IDS) {
    const bytes = fs.readFileSync(path.join(root, index.voices[voice].file));
    fingerprints.add(createHash('sha256').update(bytes).digest('hex'));
    const bank = runtime.decodeBank(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    for (const key of [...index.phrases, ...Array.from('abcdefghijklmnopqrstuvwxyz', letter => `letter:${letter}`)]) {
      const segment = index.voices[voice].segments[key];
      assert.ok(segment?.offset >= 0 && segment.length > 0 && segment.offset + segment.length <= bank.length, `${voice}: ${key}`);
      assert.equal(segment.length, segment.words * 14400, `${voice}: ${key} must target 100 WPM`);
      assert.ok(segment.tempo.appliedFactor >= 0.5 && segment.tempo.appliedFactor <= 2.0);
      assert.ok(Math.abs(segment.tempo.silenceAdjustmentSamples) <= 720);
    }
    const reply = runtime.assemble('Roger, turning left, one four zero, Raven 21.', voice, index, bank);
    assert.equal(reply.sampleRate, 24000);
    assert.ok(reply.samples.some(sample => Math.abs(sample) > 0.01));
    assert.ok(reply.samples.length > 24000 && reply.samples.length < 24000 * 20);
    const wpm = 9 * 60 / (reply.samples.length / 24000);
    assert.ok(wpm >= 95 && wpm <= 100, `composed readback pace: ${wpm}`);
  }
  assert.equal(fingerprints.size, 4, 'the four voice banks must contain distinct audio');
});

test('audio assembly retains voiced samples and bounds invalid segments', async () => {
  const runtime = await import(pathToFileURL(path.join(__dirname, '..', 'vendor/pilot-tts/runtime.mjs')).href);
  const index = { phrases: ['roger', 'one'], voices: { am_michael: { segments: {
    roger: { offset: 0, length: 12000, words: 1 }, one: { offset: 12000, length: 12000, words: 1 }
  } } } };
  const bank = new Float32Array(24000).fill(0.25);
  const audio = runtime.assemble('Roger one', 'am_michael', index, bank);
  assert.equal(audio.samples.length, 28800, 'pauses bring two short words to 1.2 seconds at 100 WPM');
  assert.equal(audio.samples[0], 0.25);
  assert.equal(audio.samples[12000], 0);
  assert.equal(audio.samples.at(-1), 0.25);
  index.voices.am_michael.segments.one.length = 30000;
  assert.throws(() => runtime.assemble('one', 'am_michael', index, bank), /Missing bundled/);
  assert.throws(() => runtime.decodeBank(new ArrayBuffer(10)), /Invalid bundled/);
});

test('worker coalesces queued clips and cancellation suppresses late results', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pilot-voice-worker.js'), 'utf8')
    .replace(/^import[^\n]*\n/, '');
  const posts = [];
  const generations = [];
  const self = { postMessage: message => posts.push(message) };
  const sandbox = { self, loadRuntime: async () => ({ generate(text, voice) {
    return new Promise(resolve => generations.push({ text, voice, resolve }));
  } }) };
  vm.runInNewContext(source, sandbox);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  self.onmessage({ data: { type: 'prepare' } });
  await flush();
  assert.equal(posts.at(-1).type, 'ready');
  self.onmessage({ data: { type: 'speak', token: 1, text: 'Old', voice: 'am_michael' } });
  self.onmessage({ data: { type: 'speak', token: 2, text: 'Intermediate', voice: 'am_michael' } });
  self.onmessage({ data: { type: 'speak', token: 3, text: 'Newest', voice: 'am_michael' } });
  generations[0].resolve({ samples: new Float32Array(24), sampleRate: 24000 });
  await flush();
  assert.deepEqual(generations.map(item => item.text), ['Old', 'Newest']);
  assert.equal(posts.filter(item => item.type === 'audio').length, 0);
  self.onmessage({ data: { type: 'cancel', token: 4 } });
  generations[1].resolve({ samples: new Float32Array(24), sampleRate: 24000 });
  await flush();
  assert.equal(posts.filter(item => item.type === 'audio').length, 0);
});

test('generation timeout drops the transmission and invalidates late worker results', async () => {
  const runtime = loadRuntime();
  const worker = await ready(runtime);
  const failures = [];
  runtime.api.speak({ text: 'Raven, passing north.', onerror: error => failures.push(error.message) });
  const token = worker.messages.at(-1).token;
  [...runtime.state.timers.values()].find(timer => timer.delay === 5000).fn();
  worker.emit({ type: 'audio', token, samples: new Float32Array(24), sampleRate: 24000 });
  assert.equal(failures.length, 1);
  assert.equal(runtime.state.audio.length, 0);
  assert.equal(runtime.api.capability(), 'unprepared');
});

test('unavailable and suspended audio fail visibly instead of claiming readiness', async () => {
  const unavailable = loadRuntime({ unavailable: true });
  assert.equal(unavailable.api.capability(), 'unavailable');
  await assert.rejects(unavailable.api.prepare(), /unavailable/);
  const suspended = loadRuntime({ suspended: true });
  const preparing = suspended.api.prepare();
  await assert.rejects(preparing, /suspended/);
  assert.equal(suspended.api.capability(), 'unprepared');
});
