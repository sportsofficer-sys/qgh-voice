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
  assert.match(androidMain, /QghOfflineVoice/);
  assert.match(androidMain, /request\.deny\(\)/);
  assert.doesNotMatch(androidMain, /SpeechRecognizer|RecognitionService/);
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
    'offline-voice-engine.js',
    'voice-workspace.js',
    'voice.css',
    'guided-familiarisation.js',
    'guided-familiarisation.css',
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
  const offlineEngine = readRepositoryFile('packages/qgh-engine/offline-voice-engine.js');
  const androidOfflineVoice = readRepositoryFile('apps/android/app/src/main/java/in/qgh/simulator/QghOfflineVoice.java');
  const worker = readRepositoryFile('apps/web/static/service-worker.js');
  const single = readRepositoryFile('packages/qgh-engine/single.html');
  const tactical = readRepositoryFile('packages/qgh-engine/tactical.html');

  assert.match(workspace, /QGHOfflineVoiceEngine/);
  assert.doesNotMatch(workspace, /SpeechRecognition|webkitSpeechRecognition|processLocally/);
  assert.doesNotMatch(workspace, /\bfetch\s*\(/);
  assert.match(offlineEngine, /Vosk\.createModel/);
  assert.match(offlineEngine, /getUserMedia/);
  assert.doesNotMatch(offlineEngine, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(androidOfflineVoice, /qgh-vosk-en-us-small-0\.15\.tar/);
  assert.doesNotMatch(androidOfflineVoice, /GZIPInputStream/);
  assert.match(androidOfflineVoice, /service\.cancel\(\)/);
  assert.match(androidOfflineVoice, /handleStartFailure/);
  assert.match(androidOfflineVoice, /void onResult\(String hypothesis\)[\s\S]*finishCurrentSession\([\s\S]*serviceForListener, recognizerForListener, transcript, null, false\)/);
  assert.match(androidOfflineVoice, /speechService != expectedService/);
  assert.match(worker, /'\.\/voice-control\.js'/);
  assert.match(worker, /'\.\/voice-workspace\.js'/);
  assert.match(worker, /'\.\/offline-voice-engine\.js'/);
  assert.match(worker, /VOICE_MODEL_URL/);
  assert.match(single, /voice-workspace\.js/);
  assert.match(tactical, /voice-workspace\.js/);
});
