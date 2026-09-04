'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repository = path.join(__dirname, '..', '..', '..');

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repository, relativePath), 'utf8');
}

test('native shells permit only bundled QGH simulator pages', () => {
  const windowsMain = readRepositoryFile('apps/windows/main.js');
  const androidMain = readRepositoryFile('apps/android/app/src/main/java/in/qgh/simulator/MainActivity.java');

  assert.match(windowsMain, /isAllowedLocalAppUrl/);
  assert.match(windowsMain, /fileURLToPath/);
  assert.match(androidMain, /isAllowedAssetUrl/);
  assert.match(androidMain, /ASSET_PREFIX/);
  assert.match(androidMain, /simulator\.canGoBack\(\)/);
});

test('asset synchronization includes the entry, single, and tactical QGH surfaces', () => {
  const sync = readRepositoryFile('scripts/Sync-WebAssets.ps1');
  const verify = readRepositoryFile('scripts/Verify-WebAssets.ps1');
  const required = [
    'index.html',
    'entry.css',
    'user-guide.html',
    'single.html',
    'workspace.css',
    'workspace.js',
    'simulator-core.js',
    'simulator.js',
    'voice-control.js',
    'voice-workspace.js',
    'voice.css',
    'tactical.html',
    'tactical.css',
    'tactical-core.js',
    'tactical-workspace.js',
    'tactical-simulator.js'
  ];

  required.forEach(file => {
    assert.match(sync, new RegExp("'" + file.replace('.', '\\.') + "'"));
    assert.match(verify, new RegExp("'" + file.replace('.', '\\.') + "'"));
  });
});

test('voice assets use the local-only bridge and are cached by the PWA shell', () => {
  const workspace = readRepositoryFile('packages/qgh-engine/voice-workspace.js');
  const worker = readRepositoryFile('apps/web/static/service-worker.js');
  const single = readRepositoryFile('packages/qgh-engine/single.html');
  const tactical = readRepositoryFile('packages/qgh-engine/tactical.html');

  assert.match(workspace, /processLocally\s*=\s*true/);
  assert.doesNotMatch(workspace, /\bfetch\s*\(/);
  assert.match(worker, /'\.\/voice-control\.js'/);
  assert.match(worker, /'\.\/voice-workspace\.js'/);
  assert.match(single, /voice-workspace\.js/);
  assert.match(tactical, /voice-workspace\.js/);
});
