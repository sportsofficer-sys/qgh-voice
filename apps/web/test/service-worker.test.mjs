import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const workerSource = readFileSync(resolve(repositoryRoot, 'apps', 'web', 'static', 'service-worker.js'), 'utf8')
  .replaceAll('__QGH_VERSION__', '4.0.2');
const scope = 'https://qgh.example/simulator/';

function createWorkerHarness({ cachedResponse = null, cacheNames = [] } = {}) {
  const handlers = new Map();
  const cacheCalls = { deleted: [], match: [], put: 0 };
  let networkCalls = 0;
  const cache = {
    addAll: async () => {},
    match: async request => {
      cacheCalls.match.push(request.url);
      return cachedResponse;
    },
    put: async () => { cacheCalls.put += 1; },
  };
  const self = {
    location: new URL(`${scope}service-worker.js`),
    registration: { scope },
    clients: { claim: async () => {} },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: () => {},
  };

  runInNewContext(workerSource, {
    URL,
    Request,
    Response,
    Set,
    Promise,
    caches: {
      open: async () => cache,
      keys: async () => cacheNames,
      delete: async name => {
        cacheCalls.deleted.push(name);
        return true;
      },
    },
    fetch: async () => {
      networkCalls += 1;
      return new Response('network');
    },
    self,
  }, { filename: 'service-worker.js' });

  return {
    cacheCalls,
    activateHandler: handlers.get('activate'),
    fetchHandler: handlers.get('fetch'),
    networkCalls: () => networkCalls,
  };
}

test('service worker ignores unapproved same-origin requests', () => {
  const harness = createWorkerHarness();
  for (const url of [
    `${scope}private-export.csv?exercise=1`,
    `${scope}single.html?exercise=1`,
    `${scope}simulator.js?token=example`,
    `${scope}simulator.js?v=4.0.2&token=example`,
  ]) {
    let responsePromise;
    harness.fetchHandler({
      request: new Request(url),
      respondWith: value => { responsePromise = value; },
    });
    assert.equal(responsePromise, undefined, `${url} is not intercepted`);
  }

  assert.deepEqual(harness.cacheCalls.match, [], 'unapproved content is not read from the shell cache');
  assert.equal(harness.cacheCalls.put, 0, 'unapproved content is never written to Cache Storage');
  assert.equal(harness.networkCalls(), 0, 'the worker does not proxy unapproved content');
});

test('service worker serves a versioned approved shell asset from the named cache', async () => {
  const harness = createWorkerHarness({ cachedResponse: new Response('cached shell') });
  let responsePromise;
  harness.fetchHandler({
    request: new Request(`${scope}simulator.js?v=4.0.2+public.1`),
    respondWith: value => { responsePromise = value; },
  });

  const response = await responsePromise;
  assert.equal(await response.text(), 'cached shell');
  assert.deepEqual(harness.cacheCalls.match, [`${scope}simulator.js`], 'query variants use the canonical approved shell key');
  assert.equal(harness.cacheCalls.put, 0, 'runtime responses are never written to Cache Storage');
  assert.equal(harness.networkCalls(), 0, 'an approved cached asset remains available offline');
});

test('service worker clears only its scoped cache generation and the known legacy cache', async () => {
  const harness = createWorkerHarness({
    cacheNames: [
      'qgh-simulator-v4.0.1',
      'qgh-simulator-other-v4.0.1',
      'qgh-simulator-simulator-v4.0.1',
      'qgh-simulator-simulator-v4.0.2',
    ],
  });
  let activation;
  harness.activateHandler({ waitUntil: value => { activation = value; } });
  await activation;

  assert.deepEqual(
    harness.cacheCalls.deleted.sort(),
    ['qgh-simulator-simulator-v4.0.1', 'qgh-simulator-v4.0.1'],
    'unrelated same-origin cache names are retained'
  );
});
