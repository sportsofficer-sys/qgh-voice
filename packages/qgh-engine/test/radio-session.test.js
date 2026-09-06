'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Radio = require('../radio-session.js');
const Voice = require('../voice-control.js');

test('orbit RT phrases distinguish circling, continuation and resume, with no guessed direction or target', () => {
  const callsigns = [{ id: 'A', callsign: 'FALCON 11' }, { id: 'B', callsign: 'RAVEN 21' }];
  for (const [phrase, intent, side] of [
    ['orbit left', 'start-orbit', 'left'], ['orbit right', 'start-orbit', 'right'],
    ['left hand orbit', 'start-orbit', 'left'], ['right orbit', 'start-orbit', 'right'],
    ['commence left orbit', 'start-orbit', 'left'], ['start orbit right now', 'start-orbit', 'right'],
    ['continue', 'continue-orbit'], ['continue orbit', 'continue-orbit'], ['resume normal', 'resume-normal']
  ]) {
    const single = Radio.parseMessage(phrase, Voice, { callsigns, single: true });
    assert.equal(single.accepted, true, phrase); assert.equal(single.intent, intent); assert.equal(single.side, side);
    const tactical = Radio.parseMessage('Raven twenty one ' + phrase, Voice, { callsigns });
    assert.equal(tactical.accepted, true, phrase); assert.equal(tactical.aircraft, 'B');
    assert.equal(Radio.parseMessage(phrase, Voice, { callsigns }).accepted, false, 'Tactical needs callsign');
  }
  for (const phrase of ['orbit', 'orbit 325', 'orbit left right', 'orbit left and turn right 090',
    'do not orbit left', 'if overhead orbit right', 'resume normal and turn left 140', 'unknown orbit left']) {
    assert.equal(Radio.parseMessage(phrase, Voice, { callsigns, single: true }).accepted, false, phrase);
  }
  assert.equal(Radio.parseMessage('continue 060', Voice, { single: true }), null);
  assert.equal(Voice.parseCommand('continue 060').intent, 'continue-turn-heading');
});

test('orbit readbacks do not disclose headings and immediate resume feedback differs from deferred resume', () => {
  const aircraft = { callsign: 'RAVEN 21', procedure: 'us', heading: 325, orbitSide: 'right' };
  for (const intent of ['start-orbit', 'continue-orbit', 'orbit-complete']) {
    const reply = Radio.replyFor({ intent, side: 'right' }, aircraft);
    assert.ok(reply); assert.doesNotMatch(reply.text, /325|HEADING/);
  }
  assert.match(Radio.replyFor({ intent: 'resume-normal' }, aircraft).text, /AFTER THIS ORBIT/);
  assert.match(Radio.replyFor({ intent: 'resume-normal' }, { ...aircraft, orbitSide: null }).text, /^RESUMING NORMAL/);
});

test('QGH information and briefing calls are receipts, never keyword-driven manoeuvres', () => {
  const options = { callsigns: [{ id: 'single', callsign: 'RAVEN 21' }], single: true };
  for (const phrase of ['Raven surface wind two three zero degrees ten knots', 'temperature two eight',
    'Raven overhead turn will be right longer way for outbound track zero six five',
    'Raven stand by for left turn for outbound', 'Raven timing you outbound for two minutes now']) {
    const call = Radio.parseMessage(phrase, Voice, options);
    assert.equal(call.accepted, true, phrase);
    assert.equal(call.intent, 'radio-exchange');
    assert.equal(call.radioKind, 'receipt');
  }
  const descent = Radio.parseMessage('Raven commence descent now', Voice, options);
  assert.equal(descent.radioKind, 'unmodelled');
  assert.match(Radio.replyFor(descent, { callsign: 'RAVEN 21' }).text, /NOT SIMULATED/);
  assert.equal(Radio.parseMessage('wind two three zero at ten knots turn left one four zero', Voice, options).accepted, false);
  assert.equal(Radio.parseMessage('Falcon surface wind calm', Voice, options).accepted, false);
  assert.equal(Radio.parseMessage('Raven wind [unk] knots', Voice, options).accepted, false);
  assert.equal(Radio.parseMessage('wind calm', Voice, { ...options, single: false }).accepted, false);
  assert.equal(Radio.parseMessage('Raven turn right now', Voice, options), null, 'ordinary controls retain the existing parser');
  assert.equal(Radio.parseMessage('unrelated background conversation', Voice, options), null);
  for (const phrase of ['weather banana', 'wind two three zero knots climb to four thousand feet', 'temperature if you can twenty', 'homing check compass']) {
    assert.equal(Radio.parseMessage(phrase, Voice, options).accepted, false, phrase);
  }
  assert.equal(Radio.parseMessage('confirm voice command', Voice, options), null);
  assert.equal(Radio.parseMessage('confirm termination', Voice, options), null);
});

test('QGH information calls ending in continue remain receipts rather than accidental orbits', () => {
  const textOptions = { callsigns: [{ id: 'single', callsign: 'RAVEN 21' }], single: true };
  const numericOptions = { callsigns: [{ id: 'single', callsign: '430' }], single: true };
  for (const [phrase, options, aircraft] of [
    ['homing two three zero continue', textOptions, undefined],
    ['raven twenty one homing two three zero continue', textOptions, 'single'],
    ['four three zero homing two three zero continue', numericOptions, 'single']
  ]) {
    const call = Radio.parseMessage(phrase, Voice, options);
    assert.equal(call.accepted, true, phrase);
    assert.equal(call.intent, 'radio-exchange', phrase);
    assert.equal(call.radioKind, 'receipt', phrase);
    assert.equal(call.aircraft, aircraft, phrase);
  }
});

function receiver() {
  let now = 0;
  let bearing = { source: 'A', callsign: 'RAVEN 21', qdm: 60, qte: 240, overhead: false };
  const radio = Radio.createReceiver({ now: () => now, observe: () => bearing });
  return { radio, time: value => { now = value; }, move: value => { bearing = { ...bearing, ...value }; } };
}

test('DF is live only during TX, freezes a complete observation at release and blanks after two seconds', () => {
  const h = receiver();
  h.radio.transmit('A');
  assert.equal(h.radio.read().phase, 'live');
  h.move({ qdm: 70, qte: 250 });
  assert.equal(h.radio.read().qdm, 70);
  h.radio.release();
  h.move({ qdm: 80, qte: 260 });
  h.time(1999);
  assert.equal(h.radio.read().phase, 'hold');
  assert.equal(h.radio.read().qdm, 70);
  assert.equal(h.radio.read().qte, 250);
  h.time(2000);
  assert.equal(h.radio.read().phase, 'idle');
});

test('new transmissions supersede held bearings and stale release callbacks cannot end them', () => {
  const h = receiver();
  const first = h.radio.transmit('A');
  h.radio.release(first);
  h.time(1000);
  const second = h.radio.transmit('B');
  h.move({ source: 'B', callsign: 'FALCON 11', qdm: 20 });
  h.radio.release(first);
  h.time(3000);
  assert.equal(h.radio.read().phase, 'live');
  assert.equal(h.radio.read().source, 'B');
  h.radio.release(second);
  h.time(5000);
  assert.equal(h.radio.read().phase, 'idle');
});

test('overhead validity is frozen and suppressed controller TX never invents a ground bearing', () => {
  const h = receiver();
  h.radio.transmit('A');
  h.move({ overhead: true, qdm: null, qte: null });
  h.radio.release();
  h.move({ overhead: false, qdm: 20, qte: 200 });
  assert.equal(h.radio.read().overhead, true);
  h.radio.controllerStart();
  assert.equal(h.radio.read().phase, 'idle');
  h.radio.reset();
  assert.equal(h.radio.read().phase, 'idle');
});

test('pilot replies are bounded outcomes, U/S replies reveal no hidden heading', () => {
  assert.deepEqual(Radio.replyFor({ intent: 'us-turn', side: 'left' }, { callsign: 'RAVEN 21' }), {
    text: 'TURNING LEFT · RAVEN 21', speech: 'Turning left, RAVEN 21.'
  });
  assert.equal(Radio.replyFor({ intent: 'us-turn-stop' }, { callsign: 'RAVEN 21' }).text, 'STOP TURN · RAVEN 21');
  assert.match(Radio.replyFor({ intent: 'normal-turn-heading', side: 'right', heading: 230 }, { callsign: 'FALCON 11' }).speech, /two three zero/);
  assert.equal(Radio.replyFor({ intent: 'clock', action: 'start' }, { callsign: 'RAVEN 21' }), null);
});
