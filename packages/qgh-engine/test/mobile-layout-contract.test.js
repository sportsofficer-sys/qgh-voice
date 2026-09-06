'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const voiceCss = fs.readFileSync(path.join(__dirname, '..', 'voice.css'), 'utf8');

test('the phone voice dock preserves natural page scrolling and reserves a safe lower edge', () => {
  assert.doesNotMatch(voiceCss, /body:has\(\.voice-dock\)\s*\{\s*padding:\s*0;\s*height:\s*100dvh;/);
  assert.doesNotMatch(voiceCss, /height:\s*calc\(100dvh - var\(--qgh-voice-dock-height\)\);/);
  assert.match(voiceCss, /body:has\(\.voice-dock\)\s*\{\s*padding:\s*0;\s*min-height:\s*100dvh;/);
  assert.match(voiceCss, /calc\(var\(--qgh-voice-dock-height\) \+ 20px\)/);
});
