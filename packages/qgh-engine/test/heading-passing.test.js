'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Radio = require('../radio-session.js');
const Voice = require('../voice-control.js');

const normalize = heading => (heading % 360 + 360) % 360;
const single = { single: true, callsigns: [{ id: 'single', callsign: 'FALCON 11' }] };
const tactical = { single: false, callsigns: [
  { id: 'A', callsign: 'FALCON 11' }, { id: 'B', callsign: 'RAVEN 21' }
] };

test('passing reports accept every integer heading and cross once in either direction', () => {
  for (let requested = 0; requested <= 360; requested += 1) {
    for (const direction of [-1, 1]) {
      const reports = Radio.createHeadingReports();
      const heading = normalize(requested);
      const label = `${requested}, direction ${direction}`;
      assert.equal(reports.arm('A', requested, normalize(heading - direction * 1.2)), true, label);
      assert.equal(reports.observe('A', normalize(heading - direction * .6)), null, label);
      assert.deepEqual(reports.observe('A', normalize(heading + direction * .2)), { source: 'A', heading }, label);
      assert.equal(reports.observe('A', normalize(heading + direction * .8)), null, label);
    }
  }
});

test('passing reports use raw heading samples and include the reached endpoint', () => {
  const reports = Radio.createHeadingReports();
  reports.arm('A', 63, 62.1);
  assert.equal(reports.observe('A', 62.7), null, 'rounding the current heading must not report early');
  assert.equal(reports.observe('A', 62.999), null);
  assert.deepEqual(reports.observe('A', 63), { source: 'A', heading: 63 });
  assert.equal(reports.observe('A', 63), null, 'remaining on the crossed heading does not repeat');
  reports.arm('A', 142, 142.8);
  assert.equal(reports.observe('A', 142.001), null);
  assert.deepEqual(reports.observe('A', 141.9), { source: 'A', heading: 142 });
});

test('arming on the current heading waits for a later crossing and remains one-shot', () => {
  const reports = Radio.createHeadingReports();
  assert.equal(reports.arm('A', 135, 135), true);
  assert.equal(reports.observe('A', 135), null);
  for (const heading of [225, 315, 45, 134.9]) assert.equal(reports.observe('A', heading), null);
  assert.deepEqual(reports.observe('A', 135), { source: 'A', heading: 135 });
  for (const heading of [225, 315, 45, 135]) assert.equal(reports.observe('A', heading), null);
});

test('a turn can stop or reverse without inventing a crossing', () => {
  const reports = Radio.createHeadingReports();
  reports.arm('A', 90, 60);
  for (const heading of [65, 70, 70, 68, 50, 40, 40, 70, 89.9]) {
    assert.equal(reports.observe('A', heading), null, `not yet passing at ${heading}`);
  }
  assert.deepEqual(reports.observe('A', 90.2), { source: 'A', heading: 90 });
});

test('valid replacement updates only the addressed aircraft report', () => {
  const reports = Radio.createHeadingReports();
  reports.arm('A', 90, 60);
  reports.arm('B', 271, 270);
  assert.equal(reports.arm('A', 45, 60), true);
  assert.equal(reports.observe('A', 90), null, 'the previous requested heading was replaced');
  assert.deepEqual(reports.observe('B', 271.2), { source: 'B', heading: 271 });
  assert.equal(reports.observe('A', 50), null);
  assert.deepEqual(reports.observe('A', 44.8), { source: 'A', heading: 45 });
});

test('invalid replacement leaves the existing reporting obligation intact', () => {
  for (const invalid of [-1, 361, 63.5, NaN, Infinity, -Infinity, '063', null, undefined]) {
    const reports = Radio.createHeadingReports();
    reports.arm('A', 219, 218);
    assert.equal(reports.arm('A', invalid, 218.5), false, String(invalid));
    assert.deepEqual(reports.observe('A', 219.2), { source: 'A', heading: 219 }, String(invalid));
  }
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '218']) {
    const reports = Radio.createHeadingReports();
    reports.arm('A', 219, 218);
    assert.equal(reports.arm('A', 45, invalid), false, `current heading ${invalid}`);
    assert.deepEqual(reports.observe('A', 219.2), { source: 'A', heading: 219 });
  }
});

test('clearing one report preserves other sources while clearing all cancels every report', () => {
  const reports = Radio.createHeadingReports();
  assert.equal(reports.observe('unknown', 90), null);
  reports.arm('A', 7, 6);
  reports.arm('B', 180, 179);
  reports.clear('A');
  assert.equal(reports.observe('A', 8), null);
  assert.deepEqual(reports.observe('B', 180), { source: 'B', heading: 180 });
  reports.arm('A', 7, 6);
  reports.arm('B', 180, 179);
  reports.clear();
  assert.equal(reports.observe('A', 8), null);
  assert.equal(reports.observe('B', 181), null);
});

test('all supported passing-report word orders parse across the complete heading range', () => {
  for (let heading = 0; heading <= 360; heading += 1) {
    const digits = String(heading).padStart(3, '0');
    for (const phrase of [`report heading passing ${digits}`, `report passing heading ${digits}`, `report passing ${digits}`]) {
      const command = Radio.parseMessage(phrase, Voice, single);
      assert.equal(command?.accepted, true, phrase);
      assert.equal(command.intent, 'request-heading-passing', phrase);
      assert.equal(command.heading, normalize(heading), phrase);
    }
  }
});

test('passing-report speech supports heading digits, degrees and a trailing please', () => {
  const examples = [
    ['report heading passing zero zero seven', 7],
    ['report passing heading zero six three degrees', 63],
    ['report passing one four two please', 142],
    ['report heading passing two seven one degrees please', 271],
    ['report passing heading tree two fife', 325],
    ['report passing three fife niner degrees', 359],
    ['report heading passing three six zero please', 0]
  ];
  for (const [phrase, heading] of examples) {
    const command = Radio.parseMessage(phrase, Voice, single);
    assert.equal(command?.accepted, true, phrase);
    assert.equal(command.intent, 'request-heading-passing', phrase);
    assert.equal(command.heading, heading, phrase);
  }
});

test('passing reports resolve configured callsigns and require one in tactical mode', () => {
  for (const [phrase, aircraft] of [
    ['Falcon eleven report heading passing 063', 'A'],
    ['Raven twenty one report passing heading 142 degrees please', 'B'],
    ['Raven report passing two seven one', 'B']
  ]) {
    const command = Radio.parseMessage(phrase, Voice, tactical);
    assert.equal(command?.accepted, true, phrase);
    assert.equal(command.intent, 'request-heading-passing', phrase);
    assert.equal(command.aircraft, aircraft, phrase);
  }
  for (const options of [single, tactical]) {
    assert.equal(Radio.parseMessage('Eagle 31 report heading passing 090', Voice, options)?.accepted, false);
  }
  assert.equal(Radio.parseMessage('report heading passing 090', Voice, tactical)?.accepted, false);
  const similar = { single: false, callsigns: [
    { id: 'A', callsign: 'FALCON 11' }, { id: 'B', callsign: 'FALCON 12' }
  ] };
  assert.equal(Radio.parseMessage('Falcon report passing heading 090', Voice, similar)?.accepted, false);
});

test('malformed passing reports are rejected before immediate-report or informational fallback', () => {
  const phrases = [
    'report heading passing', 'report passing heading', 'report passing',
    'report heading passing 361', 'report passing heading 999',
    'report passing 063.5', 'report heading passing zero six',
    'report passing heading zero six three four', 'report passing heading [unk]',
    'report heading passing 063 then turn right 142',
    'report passing heading 142 and report distance',
    'report passing 271 unless instructed',
    'do not report heading passing 090',
    'cancel report heading passing 090',
    'report heading passing 063 correction 142'
  ];
  for (const phrase of phrases) {
    const command = Radio.parseMessage(phrase, Voice, single);
    assert.equal(command?.accepted, false, phrase);
  }
});

test('ordinary heading requests and turn instructions retain their original parser', () => {
  assert.equal(Radio.parseMessage('report heading', Voice, single), null);
  assert.equal(Radio.parseMessage('Falcon eleven turn right heading zero six three', Voice, single), null);
});
