'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const engineDirectory = path.join(__dirname, '..');
const htmlPath = path.join(engineDirectory, 'tactical.html');
const simulatorPath = path.join(engineDirectory, 'tactical-simulator.js');

test('Tactical QGH page contains all tactical controller bindings', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const simulator = fs.readFileSync(simulatorPath, 'utf8');
  const pageIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const lookedUpIds = [...simulator.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
  const missingIds = [...new Set(lookedUpIds.filter(id => !pageIds.has(id)))];

  assert.deepEqual(missingIds, []);
  assert.match(html, /tactical-core\.js/);
  assert.match(html, /tactical-workspace\.js/);
  assert.match(html, /tactical-simulator\.js/);
  assert.match(simulator, /TRANSMIT FOR D\/F/);
  assert.match(simulator, /ADVANCE FLIGHT/);
  assert.match(simulator, /QGHTacticalReview/);
  assert.match(html, /FORMATION FLIGHT/);
  assert.match(html, /tFormationLeader/);
  assert.match(html, /tStopFollowing/);
  assert.match(simulator, /formationRoleFor/);
  assert.match(simulator, /stopFollowingLeader/);
  assert.match(simulator, /VERTICAL SEPARATION/);
  assert.match(simulator, /railItems: new Map\(\)/);
  assert.match(simulator, /function buildRailItem/);
  assert.match(simulator, /state\.activeAircraftId = state\.exercise\.formation/);
  assert.match(html, /data-tactical-replay-speed="10"/);
  assert.match(html, /tZoomToggle/);
  assert.match(html, /tTerminateDialog/);
  assert.match(simulator, /replayPaused/);
  assert.match(simulator, /setReviewZoom/);
});
