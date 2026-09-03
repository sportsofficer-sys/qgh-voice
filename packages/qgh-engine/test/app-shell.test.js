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
