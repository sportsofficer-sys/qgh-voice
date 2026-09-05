'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const runtimeModule = import(pathToFileURL(path.join(__dirname, '..', 'vendor/pilot-tts/runtime.mjs')).href);
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeBank(value) {
  const buffer = new ArrayBuffer(60);
  const view = new DataView(buffer);
  const tag = (offset, text) => [...text].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, 16, true);
  for (let i = 0; i < 8; i += 1) view.setInt16(44 + i * 2, value + i, true);
  return buffer;
}

async function mockPack(t, bankResponse) {
  const module = await runtimeModule;
  const index = { sampleRate: module.SAMPLE_RATE, phrases: ['roger', 'one'], voices: {} };
  const buffers = new Map();
  module.VOICE_IDS.forEach((voice, i) => {
    index.voices[voice] = { file: `${voice}.wav`, segments: {
      roger: { offset: 0, length: 4, words: 1 }, one: { offset: 4, length: 4, words: 1 }
    } };
    buffers.set(voice, makeBank((i + 1) * 2000));
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.credentials, 'same-origin');
    const filename = url.pathname.split('/').at(-1);
    requests.push(filename);
    if (filename === 'index.json') return { ok: true, json: async () => index };
    const voice = filename.replace(/\.wav$/, '');
    assert.ok(buffers.has(voice), `unexpected bank request: ${filename}`);
    return bankResponse?.(voice, buffers.get(voice)) ?? {
      ok: true, arrayBuffer: async () => buffers.get(voice)
    };
  });
  return { module, index, buffers, requests };
}

test('preparation loads only the headphone voice and reuses its decoded bank', async t => {
  const pack = await mockPack(t);
  const progress = [];
  const runtime = await pack.module.loadRuntime(value => progress.push(value));
  assert.deepEqual(pack.requests, ['index.json', 'am_michael.wav']);
  assert.deepEqual(progress, [
    { phase: 'loading', loaded: 0, total: 1 },
    { phase: 'loading', loaded: 1, total: 1 }
  ]);
  assert.equal(Object.isFrozen(runtime), true);
  for (const text of ['Roger one', 'One roger', 'Roger one']) {
    const actual = await runtime.generate(text, 'am_michael');
    const expected = pack.module.assemble(text, 'am_michael', pack.index, pack.module.decodeBank(pack.buffers.get('am_michael')));
    assert.deepEqual(actual, expected, 'loading changes must preserve samples, pauses, and sample rate');
  }
  assert.deepEqual(pack.requests, ['index.json', 'am_michael.wav']);
});

test('all three other voices load on demand and concurrent loads read one bank at a time', async t => {
  const gates = new Map();
  const reading = [];
  const pack = await mockPack(t, (voice, buffer) => {
    if (voice === 'am_michael') return;
    const gate = deferred();
    gates.set(voice, gate);
    return { ok: true, async arrayBuffer() {
      reading.push(voice);
      await gate.promise;
      return buffer;
    } };
  });
  const runtime = await pack.module.loadRuntime();
  const lazyVoices = pack.module.VOICE_IDS.slice(1);
  const generations = lazyVoices.map(voice => runtime.generate('Roger one', voice));
  for (let i = 0; i < lazyVoices.length; i += 1) {
    await flush();
    assert.deepEqual(pack.requests, ['index.json', 'am_michael.wav', ...lazyVoices.slice(0, i + 1).map(voice => `${voice}.wav`)]);
    assert.deepEqual(reading, lazyVoices.slice(0, i + 1), 'the next bank waits for the current body to be read and decoded');
    gates.get(lazyVoices[i]).resolve();
    const actual = await generations[i];
    const expected = pack.module.assemble('Roger one', lazyVoices[i], pack.index, pack.module.decodeBank(pack.buffers.get(lazyVoices[i])));
    assert.deepEqual(actual, expected);
  }
  const requestCount = pack.requests.length;
  for (const voice of pack.module.VOICE_IDS) await runtime.generate('One', voice);
  assert.equal(pack.requests.length, requestCount, 'every successfully loaded voice is cached');
});

test('simultaneous requests for one voice share its bank load and assemble independent clips', async t => {
  const gate = deferred();
  let reads = 0;
  const pack = await mockPack(t, (voice, buffer) => voice === 'am_fenrir' ? {
    ok: true, async arrayBuffer() { reads += 1; await gate.promise; return buffer; }
  } : undefined);
  const runtime = await pack.module.loadRuntime();
  const first = runtime.generate('Roger', 'am_fenrir');
  const second = runtime.generate('One', 'am_fenrir');
  await flush();
  assert.deepEqual(pack.requests, ['index.json', 'am_michael.wav', 'am_fenrir.wav']);
  assert.equal(reads, 1);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.samples, b.samples);
  assert.equal(a.samples[0], 4000 / 32768);
  assert.equal(b.samples[0], 4004 / 32768);
});

test('failed network, HTTP, body, and decode loads are retryable without poisoning queued voices', async t => {
  for (const failure of ['network', 'HTTP', 'body', 'decode']) {
    await t.test(failure, async t => {
      let attempts = 0;
      const pack = await mockPack(t, (voice, buffer) => {
        if (voice !== 'am_fenrir' || ++attempts > 1) return;
        if (failure === 'network') throw new Error('network failed');
        if (failure === 'HTTP') return { ok: false };
        if (failure === 'body') return { ok: true, arrayBuffer: async () => { throw new Error('body failed'); } };
        return { ok: true, arrayBuffer: async () => buffer.slice(0, 10) };
      });
      const runtime = await pack.module.loadRuntime();
      const failed = runtime.generate('Roger', 'am_fenrir');
      const sharedFailure = runtime.generate('One', 'am_fenrir');
      const nextVoice = runtime.generate('One', 'am_puck');
      await Promise.all([
        assert.rejects(failed, /missing|network failed|body failed|Invalid bundled/),
        assert.rejects(sharedFailure, /missing|network failed|body failed|Invalid bundled/)
      ]);
      assert.equal(attempts, 1, 'coalesced failure makes one attempt');
      assert.equal((await nextVoice).samples[0], 6004 / 32768);
      assert.equal((await runtime.generate('Roger', 'am_fenrir')).samples[0], 4000 / 32768);
      await runtime.generate('One', 'am_fenrir');
      assert.equal(attempts, 2, 'a successful retry is cached');
    });
  }
});

test('failed headphone preparation can be retried explicitly', async t => {
  let attempts = 0;
  const pack = await mockPack(t, voice => voice === 'am_michael' && ++attempts === 1 ? { ok: false } : undefined);
  await assert.rejects(pack.module.loadRuntime(), /Bundled pilot voice is missing: am_michael/);
  const runtime = await pack.module.loadRuntime();
  assert.equal((await runtime.generate('Roger', 'am_michael')).samples[0], 2000 / 32768);
  assert.deepEqual(pack.requests, ['index.json', 'am_michael.wav', 'index.json', 'am_michael.wav']);
});

test('unknown voices reject without fetching a bank or blocking a known voice', async t => {
  const pack = await mockPack(t);
  const runtime = await pack.module.loadRuntime();
  for (const voice of ['unknown', '../am_michael', '__proto__', undefined, null]) {
    await assert.rejects(runtime.generate('Roger', voice), /Unknown bundled pilot voice/);
  }
  assert.deepEqual(pack.requests, ['index.json', 'am_michael.wav']);
  await runtime.generate('Roger', 'bm_george');
  assert.equal(pack.requests.at(-1), 'bm_george.wav');
});

test('preparation still validates paths for voices that will load later', async t => {
  const pack = await mockPack(t);
  pack.index.voices.am_puck.file = '../am_puck.wav';
  await assert.rejects(pack.module.loadRuntime(), /Invalid pilot voice bank path/);
  assert.deepEqual(pack.requests, ['index.json']);
});
