import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const outputRoot = resolve(repositoryRoot, 'apps', 'web', 'dist');
const staticProbe = resolve(repositoryRoot, 'apps', 'web', 'static', '__qgh-web-build-probe__.txt');

const absoluteFiles = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? absoluteFiles(entryPath) : [entryPath];
  });

const outputFiles = directory => absoluteFiles(directory)
  .map(file => relative(outputRoot, file).replaceAll('\\', '/'))
  .sort();

test('web build creates an allowlisted PWA package', () => {
  const expectedFiles = [
    'index.html',
    'entry.css',
    'user-guide.html',
    'single.html',
    'simulator-core.js',
    'simulator.js',
    'voice-control.js',
    'voice-workspace.js',
    'voice.css',
    'workspace.css',
    'workspace.js',
    'tactical.html',
    'tactical.css',
    'tactical-core.js',
    'tactical-workspace.js',
    'tactical-simulator.js',
    'fonts/ibm-plex-mono-500.ttf',
    'fonts/ibm-plex-sans-400.ttf',
    'fonts/ibm-plex-sans-600.ttf',
    'fonts/OFL-1.1.txt',
    'manifest.webmanifest',
    'service-worker.js',
    'pwa-register.js',
    'web-environment.js',
    'web-distribution.js',
    'release-links.js',
    'pwa.css',
    'app-version.json',
    '_headers',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/apple-touch-icon.png',
    'icons/favicon-32.png',
  ].sort();

  if (existsSync(staticProbe)) rmSync(staticProbe, { force: true });
  writeFileSync(staticProbe, 'This file must never be copied into the public PWA package.');
  try {
    execFileSync(process.execPath, [resolve(repositoryRoot, 'scripts', 'build-web.mjs')], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });
  } finally {
    unlinkSync(staticProbe);
  }

  for (const relativePath of expectedFiles) {
    assert.equal(existsSync(resolve(outputRoot, relativePath)), true, `${relativePath} is present`);
  }

  assert.deepEqual(outputFiles(outputRoot), expectedFiles, 'web output contains only the approved engine and PWA files');
  assert.equal(existsSync(resolve(outputRoot, '__qgh-web-build-probe__.txt')), false, 'unlisted static content is excluded');

  assert.equal(existsSync(resolve(outputRoot, 'screens')), false, 'stale duplicate screens are excluded');
  assert.equal(existsSync(resolve(outputRoot, 'state')), false, 'local state is excluded');

  const entry = readFileSync(resolve(outputRoot, 'index.html'), 'utf8');
  const guide = readFileSync(resolve(outputRoot, 'user-guide.html'), 'utf8');
  const single = readFileSync(resolve(outputRoot, 'single.html'), 'utf8');
  const tactical = readFileSync(resolve(outputRoot, 'tactical.html'), 'utf8');
  const serviceWorker = readFileSync(resolve(outputRoot, 'service-worker.js'), 'utf8');
  const registration = readFileSync(resolve(outputRoot, 'pwa-register.js'), 'utf8');
  const environment = readFileSync(resolve(outputRoot, 'web-environment.js'), 'utf8');
  const distribution = readFileSync(resolve(outputRoot, 'web-distribution.js'), 'utf8');
  const headers = readFileSync(resolve(outputRoot, '_headers'), 'utf8');
  assert.match(entry, /manifest\.webmanifest/);
  assert.match(entry, /QGH_WEB_DISTRIBUTION/);
  assert.match(guide, /manifest\.webmanifest/);
  assert.match(guide, /pwa-register\.js/);
  assert.match(single, /worker-src 'self'/);
  assert.match(single, /pwa-register\.js/);
  assert.match(tactical, /manifest\.webmanifest/);
  assert.match(tactical, /worker-src 'self'/);
  assert.match(tactical, /web-environment\.js/);
  assert.match(tactical, /pwa-register\.js/);
  assert.match(serviceWorker, /const APP_SHELL_PATHS = new Set/);
  assert.match(serviceWorker, /function shellCacheKey\(request\)/);
  assert.match(serviceWorker, /if \(!cacheKey\) return;/);
  assert.match(serviceWorker, /return \(await openCache\(\)\)\.match\(cacheKey\);/);
  assert.doesNotMatch(serviceWorker, /cache\.put\(/);
  assert.doesNotMatch(serviceWorker, /cacheResponse/);
  assert.doesNotMatch(serviceWorker, /caches\.match\(/);
  assert.match(serviceWorker, /event\.data\?\.type === 'SKIP_WAITING'/);
  assert.doesNotMatch(serviceWorker.split("self.addEventListener('activate'")[0], /skipWaiting/);
  assert.match(registration, /#console\.active, #tConsole\.active/);
  assert.match(registration, /QGH_WEB_ENVIRONMENT/);
  assert.match(environment, /appassets\.androidplatform\.net/);
  assert.match(distribution, /url\.protocol === 'https:'/);
  assert.match(headers, /\/service-worker\.js\s+! Content-Security-Policy\s+Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'/);
});
