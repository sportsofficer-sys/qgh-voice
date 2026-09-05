const cacheScope = new URL(self.registration.scope).pathname
  .replace(/[^a-z0-9]+/gi, '-')
  .replace(/^-|-$/g, '') || 'root';
const CACHE_PREFIX = `qgh-simulator-${cacheScope}-`;
const APP_VERSION = '__QGH_VERSION__';
const CACHE_NAME = `${CACHE_PREFIX}v__QGH_VERSION__`;
const VOICE_CACHE_NAME = 'qgh-offline-voice-pack-v1';
const VOICE_MODEL_URL = new URL('./voice-models/qgh-vosk-en-us-small-0.15.tar.gz', self.registration.scope).href;
const PILOT_CACHE_PREFIX = `qgh-pilot-voices-${cacheScope}-`;
const PILOT_MANIFEST_URL = new URL('./pilot-voices/manifest.json', self.registration.scope).href;
// A manifest may list only safe relative paths within the bundled pilot pack.
// It cannot expand caching to application, user or remote content.
const PILOT_ASSET_PATH = /^(?:pilot-voices|vendor\/pilot-tts)\/(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*$/i;
const PILOT_MAX_BYTES = 192 * 1024 * 1024;
const LEGACY_CACHE_NAMES = new Set(['qgh-simulator-v4.0.1']);
const APP_SHELL = [
  './',
  './index.html',
  './entry.css',
  './user-guide.html',
  './rt-reference.md',
  './single.html',
  './simulator-core.js',
  './radio-session.js',
  './radio-workspace.js',
  './simulator.js',
  './voice-control.js',
  './voice-workspace.js',
  './offline-voice-engine.js',
  './pilot-voice-engine.js',
  './pilot-voice-worker.js',
  './headphone-consent.js',
  './pilot-voices/manifest.json',
  './voice.css',
  './guided-familiarisation.js',
  './guided-familiarisation.css',
  './workspace.css',
  './workspace.js',
  './tactical.html',
  './tactical.css',
  './tactical-core.js',
  './tactical-workspace.js',
  './tactical-simulator.js',
  './fonts/ibm-plex-mono-500.ttf',
  './fonts/ibm-plex-sans-400.ttf',
  './fonts/ibm-plex-sans-600.ttf',
  './manifest.webmanifest',
  './app-version.json',
  './pwa.css',
  './web-environment.js',
  './pwa-register.js',
  './web-distribution.js',
  './release-links.js',
  './vendor/vosk-browser-0.0.8.js',
  './vendor/Apache-2.0.txt',
  './voice-models/NOTICE.txt',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];
const APP_SHELL_PATHS = new Set(
  APP_SHELL.map(asset => new URL(asset, self.registration.scope).pathname)
);
const PAGE_SHELL_PATHS = new Set(
  ['./', './index.html', './user-guide.html', './single.html', './tactical.html']
    .map(page => new URL(page, self.registration.scope).pathname)
);
let cachePromise;
let pilotManifestPromise;
let pilotPackPromise;
let pilotPackStatus = { state: 'checking', loadedBytes: 0, totalBytes: 0 };
const pilotDownloads = new Map();

function openCache() {
  cachePromise ??= caches.open(CACHE_NAME);
  return cachePromise;
}

function shellCacheKey(request) {
  if (request.method !== 'GET') return null;
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin || !APP_SHELL_PATHS.has(requestUrl.pathname)) return null;

  if (requestUrl.search) {
    const isVersionedAsset = !PAGE_SHELL_PATHS.has(requestUrl.pathname)
      && (requestUrl.search === `?v=${APP_VERSION}`
        || requestUrl.search === `?v=${APP_VERSION}&release=${APP_VERSION}`);
    if (!isVersionedAsset) return null;
  }

  return new Request(new URL(requestUrl.pathname, self.location.origin).href);
}

async function cachedShell(cacheKey) {
  return (await openCache()).match(cacheKey);
}

function isVoiceModelRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.href === VOICE_MODEL_URL;
}

async function cachedVoiceModel() {
  return (await caches.open(VOICE_CACHE_NAME)).match(VOICE_MODEL_URL);
}

function pilotAssetUrl(request) {
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return null;
  const path = request.url.slice(self.registration.scope.length);
  return request.url !== PILOT_MANIFEST_URL && PILOT_ASSET_PATH.test(path) ? request.url : null;
}

async function pilotManifest() {
  pilotManifestPromise ??= (async () => {
    const response = await (await openCache()).match(PILOT_MANIFEST_URL)
      || await fetch(PILOT_MANIFEST_URL, { cache: 'no-cache', redirect: 'error' });
    if (!response.ok) throw new Error('Pilot voice manifest unavailable');
    const manifest = await response.json();
    if (typeof manifest.version !== 'string' || !/^[a-z0-9][a-z0-9.+-]{0,79}$/i.test(manifest.version)
      || !Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > 2048) {
      throw new Error('Invalid pilot voice manifest');
    }
    const paths = new Set();
    let totalBytes = 0;
    for (const asset of manifest.assets) {
      if (typeof asset.path !== 'string' || !PILOT_ASSET_PATH.test(asset.path)
        || asset.path === 'pilot-voices/manifest.json' || paths.has(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 128 * 1024 * 1024) {
        throw new Error('Invalid pilot voice asset');
      }
      paths.add(asset.path);
      totalBytes += asset.bytes;
    }
    if (totalBytes > PILOT_MAX_BYTES) throw new Error('Invalid pilot voice pack size');
    return { ...manifest, totalBytes, cacheName: `${PILOT_CACHE_PREFIX}${manifest.version}` };
  })().catch(error => { pilotManifestPromise = undefined; throw error; });
  return pilotManifestPromise;
}

async function verifiedPilotAsset(pilotCache, asset) {
  const response = await pilotCache.match(new URL(asset.path, self.registration.scope).href);
  // These headers are written only after validating the full byte count and
  // SHA-256. Presence of a cached manifest alone never means the pack is ready.
  return response?.ok && response.headers.get('x-qgh-pilot-sha256') === asset.sha256
    && Number(response.headers.get('content-length')) === asset.bytes ? response : null;
}

async function pilotInventory(manifest) {
  const pilotCache = await caches.open(manifest.cacheName);
  const missing = [];
  let loadedBytes = 0;
  for (const asset of manifest.assets) {
    if (await verifiedPilotAsset(pilotCache, asset)) loadedBytes += asset.bytes;
    else missing.push(asset);
  }
  return { pilotCache, missing, loadedBytes };
}

async function reportPilotStatus(status) {
  pilotPackStatus = status;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => []);
  for (const client of clients) {
    if (client.url.startsWith(self.registration.scope)) {
      try { client.postMessage({ type: 'PILOT_PACK_STATUS', ...status }); }
      catch { /* A closing tab must not interrupt the download. */ }
    }
  }
}

async function fetchPilotFile(url, asset, onProgress) {
  const controller = new AbortController();
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 45000);
  };
  resetIdleTimer();
  try {
    const response = await fetch(url, {
      credentials: 'same-origin', cache: 'no-cache', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new Error('Pilot voice download unavailable');
    let bytes;
    if (response.body) {
      bytes = new Uint8Array(asset.bytes);
      const reader = response.body.getReader();
      let loaded = 0;
      let reported = 0;
      try {
        while (true) {
          resetIdleTimer();
          const { done, value } = await reader.read();
          if (done) break;
          if (loaded + value.length > asset.bytes) throw new Error('Pilot voice file size mismatch');
          bytes.set(value, loaded);
          loaded += value.length;
          if (loaded - reported >= 1024 * 1024) {
            reported = loaded;
            await onProgress?.(loaded);
          }
        }
        if (loaded !== asset.bytes) throw new Error('Pilot voice download incomplete');
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== asset.bytes) throw new Error('Pilot voice file size mismatch');
    }
    return { response, bytes };
  } finally { clearTimeout(idleTimer); }
}

async function downloadPilotAsset(manifest, asset, onProgress) {
  const url = new URL(asset.path, self.registration.scope).href;
  const key = `${url}:${asset.sha256}`;
  if (pilotDownloads.has(key)) return pilotDownloads.get(key);
  const download = (async () => {
    const pilotCache = await caches.open(manifest.cacheName);
    const cached = await verifiedPilotAsset(pilotCache, asset);
    if (cached) return { response: cached, stored: true };
    const { response, bytes } = await fetchPilotFile(url, asset, onProgress);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== asset.sha256) throw new Error('Pilot voice file integrity mismatch');
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(asset.bytes));
    headers.set('x-qgh-pilot-sha256', sha256);
    const verified = new Response(bytes, { headers });
    try {
      await pilotCache.put(url, verified.clone());
      return { response: verified, stored: true };
    } catch (error) {
      // A full browser cache must not prevent using a downloaded voice online.
      return { response: verified, stored: false, error };
    }
  })();
  pilotDownloads.set(key, download);
  try { return await download; }
  finally { pilotDownloads.delete(key); }
}

function cachePilotPack() {
  if (pilotPackPromise) {
    void reportPilotStatus(pilotPackStatus).catch(() => {});
    return pilotPackPromise;
  }
  let attemptedManifest;
  pilotPackPromise = (async () => {
    const manifest = await pilotManifest();
    attemptedManifest = manifest;
    const inventory = await pilotInventory(manifest);
    const base = { version: manifest.version, totalBytes: manifest.totalBytes, totalAssets: manifest.assets.length };
    let loadedBytes = inventory.loadedBytes;
    await reportPilotStatus({ ...base, state: 'downloading', loadedBytes });
    // Sequential downloads bound the large model's memory and bandwidth use.
    for (const asset of inventory.missing) {
      const result = await downloadPilotAsset(manifest, asset, progress => reportPilotStatus({
        ...base, state: 'downloading', loadedBytes: Math.min(loadedBytes + progress, manifest.totalBytes),
      }));
      if (!result.stored) throw result.error;
      loadedBytes += asset.bytes;
      await reportPilotStatus({ ...base, state: 'downloading', loadedBytes });
    }
    const verified = await pilotInventory(manifest);
    await reportPilotStatus({ ...base, state: verified.missing.length ? 'incomplete' : 'ready', loadedBytes: verified.loadedBytes });
  })().catch(async error => {
    // Report bytes actually saved, excluding a failed file's streamed progress.
    let loadedBytes = 0;
    try { if (attemptedManifest) loadedBytes = (await pilotInventory(attemptedManifest)).loadedBytes; }
    catch { /* Storage may be unavailable. */ }
    await reportPilotStatus({ ...pilotPackStatus, state: 'incomplete',
      loadedBytes,
      reason: error?.name === 'QuotaExceededError' ? 'storage' : 'download' }).catch(() => {});
  }).finally(() => { pilotPackPromise = undefined; });
  return pilotPackPromise;
}

self.addEventListener('install', event => {
  event.waitUntil(openCache().then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter(name => (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) || LEGACY_CACHE_NAMES.has(name))
        .map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CACHE_PILOT_PACK' && event.source?.url?.startsWith(self.registration.scope)) {
    event.waitUntil(cachePilotPack());
  }
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const pilotUrl = pilotAssetUrl(request);
  if (pilotUrl) {
    event.respondWith((async () => {
      let manifest;
      try {
        manifest = await pilotManifest();
      } catch { /* The ordinary online simulator can still use its bundled files. */ }
      const asset = manifest?.assets.find(item => new URL(item.path, self.registration.scope).href === pilotUrl);
      try {
        if (!asset) return await fetch(request);
        return (await downloadPilotAsset(manifest, asset)).response.clone();
      } catch {
        return new Response('', { status: 504, statusText: 'Offline pilot voice unavailable' });
      }
    })());
    return;
  }
  if (isVoiceModelRequest(request)) {
    event.respondWith((async () => {
      const cachedResponse = await cachedVoiceModel();
      if (cachedResponse) return cachedResponse;
      try {
        return await fetch(request);
      } catch {
        return new Response('', { status: 504, statusText: 'Offline voice pack unavailable' });
      }
    })());
    return;
  }
  const cacheKey = shellCacheKey(request);
  if (!cacheKey) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await cachedShell(cacheKey)) || new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cachedResponse = await cachedShell(cacheKey);
    if (cachedResponse) return cachedResponse;

    try {
      return await fetch(request);
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
