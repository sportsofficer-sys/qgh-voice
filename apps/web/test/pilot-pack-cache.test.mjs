import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workerSource = readFileSync(resolve(root, 'apps/web/static/service-worker.js'), 'utf8');
const registrationSource = readFileSync(resolve(root, 'apps/web/static/pwa-register.js'), 'utf8');
const scope = 'https://qgh.example/simulator/';
const assetPaths = [
  'pilot-voices/model_quantized.onnx', 'pilot-voices/tokenizer.json', 'pilot-voices/cmudict.dict',
  ...['am_michael', 'am_fenrir', 'am_puck', 'bm_george'].map(id => `pilot-voices/voices/${id}.bin`),
  ...['runtime.mjs', 'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
    'CMUDICT-LICENSE.txt', 'KOKORO-LICENSE.txt', 'onnxruntime-LICENSE.txt',
    'onnxruntime-ThirdPartyNotices.txt', 'NOTICE.md'].map(path => `vendor/pilot-tts/${path}`),
];
const bodies = new Map(assetPaths.map(path => [path, Buffer.from(`Bundled fixture for ${path}`)]));
const pack = {
  version: 'qgh-pilot-kokoro-q8-en-1',
  assets: assetPaths.map(path => ({ path, bytes: bodies.get(path).length,
    sha256: createHash('sha256').update(bodies.get(path)).digest('hex') })),
};
const pilotCacheName = `qgh-pilot-voices-simulator-${pack.version}`;

function createHarness({ storage = new Map(), version = '4.4.1', manifest = pack, idleMilliseconds = 45000 } = {}) {
  const handlers = new Map();
  const requests = [];
  const messages = [];
  const unrelatedMessages = [];
  const deleted = [];
  const failures = new Map();
  const quotaPaths = new Set();
  let offline = false;
  let skipped = 0;
  const key = request => typeof request === 'string' ? request : request.url;
  const bucket = name => {
    if (!storage.has(name)) storage.set(name, new Map());
    return storage.get(name);
  };
  const self = {
    location: new URL('service-worker.js', scope),
    registration: { scope },
    clients: { claim: async () => {}, matchAll: async () => [
      { url: `${scope}index.html`, postMessage: message => messages.push(message) },
      { url: 'https://qgh.example/other/', postMessage: message => unrelatedMessages.push(message) },
    ] },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: () => { skipped += 1; },
  };
  runInNewContext(workerSource.replaceAll('__QGH_VERSION__', version), {
    URL, Request, Response, Headers, AbortController, crypto: webcrypto, Uint8Array, Map, Set, Promise,
    setTimeout: callback => setTimeout(callback, idleMilliseconds), clearTimeout,
    self,
    caches: {
      open: async name => ({
        addAll: async paths => {
          for (const path of paths) {
            const url = new URL(path, scope).href;
            bucket(name).set(url, new Response(path === './pilot-voices/manifest.json'
              ? JSON.stringify(manifest) : `Shell: ${path}`));
          }
        },
        match: async request => bucket(name).get(key(request))?.clone(),
        put: async (request, response) => {
          if (quotaPaths.has(key(request))) throw new DOMException('Storage full', 'QuotaExceededError');
          bucket(name).set(key(request), response.clone());
        },
      }),
      keys: async () => Array.from(storage.keys()),
      delete: async name => { deleted.push(name); return storage.delete(name); },
    },
    fetch: async (request, options) => {
      const url = key(request);
      requests.push(url);
      if (offline) throw new TypeError('Offline');
      const failure = failures.get(url);
      if (failure) return failure(options);
      if (url === `${scope}pilot-voices/manifest.json`) return Response.json(manifest);
      const body = bodies.get(url.slice(scope.length));
      return body ? new Response(body) : new Response('Not found', { status: 404 });
    },
  }, { filename: 'service-worker.js' });
  async function dispatch(type, event = {}) {
    const pending = [];
    handlers.get(type)({ ...event, waitUntil: value => pending.push(value) });
    await Promise.all(pending);
  }
  return {
    storage, requests, messages, unrelatedMessages, deleted, failures, quotaPaths,
    setOffline: value => { offline = value; },
    skipped: () => skipped,
    install: () => dispatch('install'),
    activate: () => dispatch('activate'),
    prepare: (source = `${scope}index.html`) => dispatch('message', {
      data: { type: 'CACHE_PILOT_PACK' }, source: { url: source },
    }),
    fetch: request => {
      let response;
      handlers.get('fetch')({ request: typeof request === 'string' ? new Request(request) : request,
        respondWith: promise => { response = promise; } });
      return response;
    },
  };
}

test('first web setup caches the exact pilot pack and then serves every file offline', async () => {
  const worker = createHarness();
  await worker.install();
  await worker.activate();
  assert.deepEqual(worker.requests, [], 'large voice downloads do not hold up shell installation');
  const shell = worker.storage.get('qgh-simulator-simulator-v4.4.1');
  for (const path of ['pilot-voice-engine.js', 'pilot-voice-worker.js', 'headphone-consent.js', 'pilot-voices/manifest.json']) {
    assert.ok(shell.has(`${scope}${path}`), `${path} is in the initial shell`);
  }
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'ready');
  assert.equal(worker.messages.at(-1).loadedBytes, pack.assets.reduce((sum, asset) => sum + asset.bytes, 0));
  assert.deepEqual(worker.requests, assetPaths.map(path => `${scope}${path}`));
  assert.deepEqual(Array.from(worker.storage.get(pilotCacheName).keys()), worker.requests);
  assert.deepEqual(worker.unrelatedMessages, []);
  assert.equal(worker.skipped(), 0, 'initial preparation never forces an update');
  worker.setOffline(true);
  for (const path of assetPaths) {
    assert.equal(await (await worker.fetch(`${scope}${path}`)).text(), bodies.get(path).toString());
  }
  assert.equal(worker.requests.length, assetPaths.length, 'offline voices need no additional network requests');
});

test('partial downloads remain incomplete and a retry preserves verified files', async () => {
  const worker = createHarness();
  await worker.install();
  const failedUrl = `${scope}${assetPaths[2]}`;
  worker.failures.set(failedUrl, () => new Response('Unavailable', { status: 503 }));
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'incomplete');
  assert.equal(worker.storage.get(pilotCacheName).size, 2);
  assert.equal(worker.messages.some(message => message.state === 'ready'), false);
  worker.setOffline(true);
  assert.match(await (await worker.fetch(`${scope}simulator.js`)).text(), /^Shell:/, 'manual simulator remains cached');
  worker.setOffline(false);
  worker.failures.clear();
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'ready');
  assert.equal(worker.requests.filter(url => url === `${scope}${assetPaths[0]}`).length, 1);
  assert.equal(worker.requests.filter(url => url === failedUrl).length, 2);
  assert.equal(worker.storage.get(pilotCacheName).size, assetPaths.length);

  worker.storage.get(pilotCacheName).delete(failedUrl);
  worker.setOffline(true);
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'incomplete', 'previous success cannot conceal a subsequently evicted asset');
  worker.setOffline(false);
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'ready');
});

test('truncated files and equal-length integrity failures never count as ready', async () => {
  for (const corrupt of [body => body.subarray(1), body => Buffer.alloc(body.length, 1)]) {
    const worker = createHarness();
    await worker.install();
    const path = assetPaths[0];
    worker.failures.set(`${scope}${path}`, () => new Response(corrupt(bodies.get(path))));
    await worker.prepare();
    assert.equal(worker.messages.at(-1).state, 'incomplete');
    assert.equal(worker.storage.get(pilotCacheName).size, 0);
    worker.failures.clear();
    await worker.prepare();
    assert.equal(worker.messages.at(-1).state, 'ready');
  }
});

test('storage failure leaves the simulator usable and permits an explicit retry', async () => {
  const worker = createHarness();
  await worker.install();
  const url = `${scope}${assetPaths[1]}`;
  worker.quotaPaths.add(url);
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'incomplete');
  assert.equal(worker.messages.at(-1).reason, 'storage');
  assert.match(await (await worker.fetch(`${scope}single.html`)).text(), /^Shell:/);
  assert.equal(await (await worker.fetch(url)).text(), bodies.get(assetPaths[1]).toString(), 'a failed cache write still permits online use');
  worker.quotaPaths.clear();
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'ready');
  assert.equal(worker.requests.filter(request => request === `${scope}${assetPaths[0]}`).length, 1);
});

test('a stalled initial download times out without holding the shell or disabling retry', async () => {
  const worker = createHarness({ idleMilliseconds: 10 });
  await worker.install();
  const url = `${scope}${assetPaths[0]}`;
  worker.failures.set(url, options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
  }));
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'incomplete');
  assert.equal(worker.messages.at(-1).loadedBytes, 0);
  assert.match(await (await worker.fetch(`${scope}simulator.js`)).text(), /^Shell:/);
  worker.failures.clear();
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'ready');
});

test('app updates retain the stable pilot cache and do not download the pack again', async () => {
  const first = createHarness();
  await first.install();
  await first.prepare();
  first.storage.set('qgh-pilot-voices-other-pack', new Map());
  first.storage.set('qgh-offline-voice-pack-v1', new Map());
  const updated = createHarness({ storage: first.storage, version: '4.4.2' });
  await updated.install();
  await updated.activate();
  updated.setOffline(true);
  await updated.prepare();
  assert.equal(updated.messages.at(-1).state, 'ready');
  assert.deepEqual(updated.requests, []);
  assert.deepEqual(updated.deleted, ['qgh-simulator-simulator-v4.4.1']);
  assert.ok(updated.storage.has(pilotCacheName));
  assert.ok(updated.storage.has('qgh-offline-voice-pack-v1'));
  assert.ok(updated.storage.has('qgh-pilot-voices-other-pack'));
});

test('pilot caching neither intercepts unrelated paths nor trusts a manifest that expands its scope', async () => {
  const worker = createHarness();
  for (const url of [
    `${scope}private-export.csv`, `${scope}${assetPaths[0]}?token=secret`,
    `${scope}${assetPaths[0]}?v=4.4.1`, `https://other.example/simulator/${assetPaths[0]}`,
  ]) assert.equal(worker.fetch(url), undefined, `${url} is outside the allowlist`);
  assert.equal(worker.fetch(new Request(`${scope}${assetPaths[0]}`, { method: 'POST', body: 'private' })), undefined);
  await worker.prepare('https://qgh.example/other/');
  assert.deepEqual(worker.requests, []);
  assert.equal(worker.storage.size, 0);
  await worker.install();
  for (const path of ['pilot-voices/private.json', 'vendor/pilot-tts/unlisted.mjs']) {
    const response = await worker.fetch(`${scope}${path}`);
    assert.equal(response.status, 404, 'an unlisted pack-root URL passes through without being cached');
  }
  assert.equal(worker.storage.has(pilotCacheName), false);
  for (const path of ['../private.json', 'https://other.example/model.onnx', 'private/model.onnx',
    'pilot-voices/../private.json', 'pilot-voices/%2e%2e/private.json', 'pilot-voices/model.onnx?private=1']) {
    const bad = createHarness({ manifest: { ...pack, assets: pack.assets.map((asset, index) => index ? asset : { ...asset, path }) } });
    await bad.install();
    await bad.prepare();
    assert.equal(bad.messages.at(-1).state, 'incomplete');
    assert.deepEqual(bad.requests, []);
    assert.equal(bad.storage.has(pilotCacheName), false);
  }
});

test('the manifest can describe a different bounded local voice package', async () => {
  const manifest = { version: 'qgh-pilot-prepared-1', assets: [pack.assets[1]] };
  const worker = createHarness({ manifest });
  await worker.install();
  await worker.prepare();
  assert.equal(worker.messages.at(-1).state, 'ready');
  assert.equal(worker.messages.at(-1).totalAssets, 1);
  assert.equal(worker.messages.at(-1).totalBytes, pack.assets[1].bytes);
  assert.deepEqual(worker.requests, [`${scope}${pack.assets[1].path}`]);
});

function createRegistrationHarness({ entry = true, exercise = false } = {}) {
  const swHandlers = new Map();
  const windowHandlers = new Map();
  const nodes = [];
  const sent = [];
  let reloads = 0;
  const element = tag => ({
    tag, children: [], attributes: {}, events: new Map(), hidden: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.events.set(name, listener); },
    append(...children) { this.children.push(...children); },
    querySelector() { return null; },
  });
  const entryCard = element('section');
  const registration = {
    active: { postMessage: message => sent.push(message) },
    waiting: null,
    addEventListener() {},
    update: async () => {},
  };
  const document = {
    body: element('body'),
    createElement: tag => { const node = element(tag); nodes.push(node); return node; },
    createTextNode: text => ({ textContent: text }),
    querySelector: selector => selector === '.entry-app .entry-card' ? (entry ? entryCard : null)
      : (exercise ? element('div') : null),
    addEventListener() {},
  };
  runInNewContext(registrationSource, {
    window: { QGH_WEB_ENVIRONMENT: { isHostedBrowser: () => true },
      location: { reload: () => { reloads += 1; } },
      addEventListener: (type, handler) => windowHandlers.set(type, [...(windowHandlers.get(type) || []), handler]),
    },
    document,
    navigator: { serviceWorker: {
      ready: Promise.resolve(registration), register: async () => registration,
      controller: {}, addEventListener: (type, handler) => swHandlers.set(type, handler),
    } },
  });
  return { nodes, sent, entryCard, reloads: () => reloads,
    load: () => windowHandlers.get('load')[0](),
    online: () => windowHandlers.get('online').forEach(handler => handler()),
    status: state => swHandlers.get('message')({ data: { type: 'PILOT_PACK_STATUS', ...state } }),
    controllerChange: () => swHandlers.get('controllerchange')(),
  };
}

test('registration starts initial caching, shows entry-only status and retries without reloading', async () => {
  const entry = createRegistrationHarness();
  await entry.load();
  assert.equal(entry.sent[0].type, 'CACHE_PILOT_PACK');
  entry.status({ state: 'incomplete' });
  const retry = entry.nodes.find(node => node.tag === 'button');
  assert.equal(retry.hidden, false);
  retry.events.get('click')();
  assert.equal(entry.sent.length, 2);
  entry.online();
  assert.equal(entry.sent.length, 3, 'reconnection also retries an interrupted initial download');
  entry.status({ state: 'ready' });
  assert.match(entry.nodes.find(node => node.tag === 'span').textContent, /saved for offline use/);
  assert.equal(retry.hidden, true);
  entry.controllerChange();
  assert.equal(entry.reloads(), 0);
  assert.equal(entry.entryCard.children.length, 1, 'status is a single inline entry paragraph');

  const active = createRegistrationHarness({ entry: false, exercise: true });
  await active.load();
  active.status({ state: 'downloading', totalBytes: 100, loadedBytes: 50 });
  active.status({ state: 'incomplete' });
  active.controllerChange();
  assert.equal(active.sent.length, 1, 'first setup also works after a direct simulator navigation');
  assert.equal(active.nodes.length, 0, 'exercise pages receive no download notice or controls');
  assert.equal(active.reloads(), 0);
});
