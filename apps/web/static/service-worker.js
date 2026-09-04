const cacheScope = new URL(self.registration.scope).pathname
  .replace(/[^a-z0-9]+/gi, '-')
  .replace(/^-|-$/g, '') || 'root';
const CACHE_PREFIX = `qgh-simulator-${cacheScope}-`;
const CACHE_NAME = `${CACHE_PREFIX}v__QGH_VERSION__`;
const LEGACY_CACHE_NAMES = new Set(['qgh-simulator-v4.0.1']);
const APP_SHELL = [
  './',
  './index.html',
  './entry.css',
  './user-guide.html',
  './single.html',
  './simulator-core.js',
  './simulator.js',
  './voice-control.js',
  './voice-workspace.js',
  './voice.css',
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
      && /^\?v=[0-9][a-zA-Z0-9.+-]*$/.test(requestUrl.search);
    if (!isVersionedAsset) return null;
  }

  return new Request(new URL(requestUrl.pathname, self.location.origin).href);
}

async function cachedShell(cacheKey) {
  return (await openCache()).match(cacheKey);
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
});

self.addEventListener('fetch', event => {
  const { request } = event;
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
