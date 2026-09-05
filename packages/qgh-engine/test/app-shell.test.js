'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const engineDirectory = path.join(__dirname, '..');

function readEngineFile(name) {
  return fs.readFileSync(path.join(engineDirectory, name), 'utf8');
}

test('the QGH entry page routes to the single and tactical simulators', () => {
  const entry = readEngineFile('index.html');
  const entryCss = readEngineFile('entry.css');

  assert.match(entry, /href="single\.html"/);
  assert.match(entry, /href="tactical\.html"/);
  assert.match(entry, /Flt Lt Balaram Reddy/);
  assert.match(entry, /SERVICE NO\. 38703/);
  assert.match(entry, /Order in the air begins with clarity on the ground\./);
  assert.match(entry, /entry\.css/);
  assert.match(entryCss, /@media/);
});

test('each simulator page offers a local return to the QGH entry page', () => {
  const single = readEngineFile('single.html');
  const tactical = readEngineFile('tactical.html');

  assert.match(single, /href="index\.html"/);
  assert.match(tactical, /href="index\.html"/);
});

test('each live homing display includes an unobtrusive voice-command acknowledgement', () => {
  const single = readEngineFile('single.html');
  const tactical = readEngineFile('tactical.html');
  const voiceCss = readEngineFile('voice.css');

  assert.match(single, /id="voiceCommandAck" class="voice-command-ack"/);
  assert.match(tactical, /id="tVoiceCommandAck" class="voice-command-ack"/);
  assert.match(single, /voice-ack-slot"><output id="voiceCommandAck"[^>]*aria-live="off"/);
  assert.match(tactical, /voice-ack-slot"><output id="tVoiceCommandAck"[^>]*aria-live="off"/);
  assert.match(voiceCss, /\.voice-command-ack\s*\{[\s\S]*#a32c27/);
  assert.match(voiceCss, /overflow-wrap: anywhere/);
  assert.match(readEngineFile('voice-workspace.js'), /announcement.setAttribute\('aria-live', 'polite'\)/);
  assert.match(voiceCss, /prefers-reduced-motion: reduce/);
});

test('guided familiarisation teaches exercise-first RT calls for each QGH mode', () => {
  const guidedTour = readEngineFile('guided-familiarisation.js');
  const userGuide = readEngineFile('user-guide.html');

  assert.match(guidedTour, /continue zero six zero/);
  assert.match(guidedTour, /while a same-direction turn is active/i);
  assert.match(guidedTour, /turn right heading zero six zero/);
  assert.match(guidedTour, /turn right now/);
  assert.match(guidedTour, /stop turn now/);
  assert.match(guidedTour, /Raven Twenty One turn right heading zero six zero/);
  assert.match(guidedTour, /Raven Twenty One transmit for D\/F/);
  assert.match(guidedTour, /Raven Twenty One stop following leader/);
  assert.match(userGuide, /EXERCISE RT CALLS/);
});
