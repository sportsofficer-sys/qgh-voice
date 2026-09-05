'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../headphone-consent.js');

function harness() {
  const enabled = [];
  let complete;
  let stops = 0;
  const consent = create({
    setEnabled: value => enabled.push(value),
    playTest: () => new Promise(resolve => { complete = resolve; }),
    stopTest: () => { stops++; },
    onChange() {}
  });
  return { consent, enabled, complete: value => complete(value), stops: () => stops };
}

test('pilot audio requires a completed test and fresh explicit headphone confirmation', async () => {
  const h = harness();
  assert.equal(h.consent.status().confirmed, false);
  assert.equal(h.consent.confirm(true), false);
  h.consent.open();
  assert.equal(h.consent.confirm(true), false);
  const pending = h.consent.test();
  assert.equal(h.consent.status().testing, true);
  assert.equal(h.consent.confirm(true), false);
  h.complete(true); await pending;
  assert.equal(h.consent.confirm(false), false);
  assert.equal(h.consent.confirm(true), true);
  assert.equal(h.enabled.at(-1), true);
  assert.equal(h.consent.status().open, false);
  h.consent.mute();
  assert.equal(h.consent.status().confirmed, false);
  h.consent.open();
  assert.equal(h.consent.confirm(true), false, 'old audio test does not enable a new confirmation');
});

test('device changes mute immediately and invalidate pending audio-test results', async () => {
  const h = harness(); h.consent.open();
  const pending = h.consent.test();
  h.consent.deviceChanged();
  assert.equal(h.enabled.at(-1), false);
  assert.equal(h.consent.status().confirmed, false);
  h.complete(true); await pending;
  assert.equal(h.consent.status().tested, false);
  assert.equal(h.consent.confirm(true), false);
  assert.match(h.consent.status().message, /changed/i);
});

test('failed and cancelled tests cannot enable replies or resurrect closed prompts', async () => {
  const h = harness(); h.consent.open();
  let pending = h.consent.test(); h.complete(false); await pending;
  assert.equal(h.consent.confirm(true), false);
  pending = h.consent.test(); h.consent.close(); h.complete(true); await pending;
  assert.equal(h.consent.status().open, false);
  assert.equal(h.consent.status().testing, false);
  assert.equal(h.consent.status().tested, false);
  assert.equal(h.enabled.at(-1), false);
  assert.ok(h.stops() > 0);
});

test('changing voice invalidates the test and only the latest test can succeed', async () => {
  const h = harness(); h.consent.open();
  const pending = h.consent.test();
  h.consent.invalidateTest();
  h.complete(true); await pending;
  assert.equal(h.consent.status().tested, false);
  assert.equal(h.consent.confirm(true), false);
});
