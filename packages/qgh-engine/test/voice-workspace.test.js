'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workspace = fs.readFileSync(path.join(__dirname, '..', 'voice-workspace.js'), 'utf8');
const offlineEngine = fs.readFileSync(path.join(__dirname, '..', 'offline-voice-engine.js'), 'utf8');
const guide = fs.readFileSync(path.join(__dirname, '..', 'user-guide.html'), 'utf8');
const voiceStyles = fs.readFileSync(path.join(__dirname, '..', 'voice.css'), 'utf8');

test('voice workspace is a local DOM adapter and does not contain flight-model logic', () => {
  assert.match(workspace, /element\.click\(\)/);
  assert.match(workspace, /new root\.Event\(type, \{ bubbles: true \}\)/);
  assert.match(workspace, /QGHOfflineVoiceEngine/);
  assert.match(workspace, /PTT/);
  assert.match(workspace, /RECENT_TRANSCRIPT_WINDOW_MS/);
  assert.doesNotMatch(workspace, /\b(fetch|XMLHttpRequest|WebSocket)\b/);
  assert.doesNotMatch(workspace, /SpeechRecognition|webkitSpeechRecognition|processLocally/);
  assert.doesNotMatch(workspace, /\b(physicsStep|turnRadiusNm|simulateFlight|Tactical\.)\b/);
  assert.match(offlineEngine, /Vosk\.createModel/);
  assert.match(offlineEngine, /buildQghGrammar/);
  assert.doesNotMatch(offlineEngine, /SpeechRecognition|webkitSpeechRecognition/);
});

test('voice workspace preserves UI safety gates for procedures, formation, and termination', () => {
  assert.match(workspace, /HEADING TURNS ARE NOT AVAILABLE IN U\/S COMPASS/);
  assert.match(workspace, /U\/S TURNS ARE NOT AVAILABLE IN NORMAL QGH/);
  assert.match(workspace, /FORMATION FOLLOWING STOPPED/);
  assert.match(workspace, /NO TERMINATION CONFIRMATION IS OPEN/);
  assert.match(workspace, /VALUE DOES NOT MATCH CONTROL STEP/);
});

test('the in-app guide documents the shipped local voice workflow', () => {
  assert.match(guide, /PRESS TO TALK BY DEFAULT/);
  assert.match(guide, /continuous listening/i);
  assert.match(guide, /no cloud speech fallback/i);
  assert.match(guide, /Confirm termination/);
  assert.match(guide, /Raven Twenty One turn right heading zero six zero/);
  assert.match(guide, /unique designator/i);
});

test('phone voice dock follows the live browser viewport instead of Safari browser chrome', () => {
  assert.match(workspace, /visualViewport/);
  assert.match(workspace, /--qgh-browser-bottom-inset/);
  assert.match(voiceStyles, /--qgh-browser-bottom-inset/);
  assert.match(voiceStyles, /--qgh-phone-bottom-inset/);
});
