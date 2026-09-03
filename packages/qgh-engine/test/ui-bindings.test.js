const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const engineDirectory = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(engineDirectory, 'single.html'), 'utf8');
const simulator = fs.readFileSync(path.join(engineDirectory, 'simulator.js'), 'utf8');

test('every single-aircraft simulator DOM lookup has a matching element in its page', () => {
  const pageIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const lookedUpIds = [...simulator.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
  const missingIds = [...new Set(lookedUpIds.filter(id => !pageIds.has(id)))];

  assert.deepEqual(missingIds, []);
});
