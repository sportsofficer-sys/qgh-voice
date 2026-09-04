'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Voice = require('../voice-control.js');

test('normalises transcripts and aviation digit language deterministically', () => {
  assert.equal(
    Voice.normalizeTranscript('  Turn-right, heading TWO seven niner.  '),
    'turn right heading two seven niner'
  );
  assert.equal(Voice.normalizeTranscript('Q D M'), 'qdm');
  assert.equal(Voice.normaliseTranscript('  ZERO / TREE / FIFE / NINER '), 'zero tree fife niner');
});

test('parses complete aviation headings within the 000–360 range', () => {
  assert.equal(Voice.parseHeading('zero zero zero'), 0);
  assert.equal(Voice.parseHeading('two seven zero'), 270);
  assert.equal(Voice.parseHeading('tree fife niner'), 359);
  assert.equal(Voice.parseHeading('three six zero'), 360);
  assert.equal(Voice.parseHeading('270'), 270);
  assert.equal(Voice.parseHeading('360'), 360);
  assert.equal(Voice.parseHeading('three six one'), null);
  assert.equal(Voice.parseHeading('two seven'), null);
});

test('exposes the same parser as a browser global without network or recognition APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'voice-control.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  assert.equal(typeof sandbox.QGHVoiceControl.parseCommand, 'function');
  assert.equal(sandbox.QGHVoiceControl.parseCommand('turn left now').intent, 'us-turn');
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|SpeechRecognition|webkitSpeechRecognition)\b/);
});

test('maps strict Normal QGH and U/S Compass turn commands without guessing', () => {
  assert.deepEqual(Voice.parseCommand('turn right heading two seven zero'), {
    accepted: true,
    transcript: 'turn right heading two seven zero',
    intent: 'normal-turn-heading',
    side: 'right',
    heading: 270
  });
  assert.deepEqual(Voice.parseCommand('turn left to heading 005'), {
    accepted: true,
    transcript: 'turn left to heading 005',
    intent: 'normal-turn-heading',
    side: 'left',
    heading: 5
  });
  assert.deepEqual(Voice.parseCommand('turn left now'), {
    accepted: true,
    transcript: 'turn left now',
    intent: 'us-turn',
    side: 'left'
  });
  assert.deepEqual(Voice.parseCommand('stop turn now'), {
    accepted: true,
    transcript: 'stop turn now',
    intent: 'us-turn-stop'
  });
  assert.deepEqual(Voice.parseCommand('turn left'), {
    accepted: false,
    transcript: 'turn left',
    reason: 'unrecognized-command'
  });
  assert.deepEqual(Voice.parseCommand('turn right heading two seven zero please'), {
    accepted: false,
    transcript: 'turn right heading two seven zero please',
    reason: 'unrecognized-command'
  });
});

test('maps D/F, reports, clock, advance, and exercise commands', () => {
  assert.deepEqual(Voice.parseCommand('select qdm'), {
    accepted: true,
    transcript: 'select qdm',
    intent: 'set-bearing-mode',
    mode: 'qdm'
  });
  assert.deepEqual(Voice.parseCommand('transmit for qte'), {
    accepted: true,
    transcript: 'transmit for qte',
    intent: 'transmit-df',
    mode: 'qte'
  });
  assert.equal(Voice.parseCommand('report heading').intent, 'report-heading');
  assert.equal(Voice.parseCommand('request distance').intent, 'request-distance');
  assert.deepEqual(Voice.parseCommand('start clock'), {
    accepted: true,
    transcript: 'start clock',
    intent: 'clock',
    action: 'start'
  });
  assert.equal(Voice.parseCommand('advance flight one minute').intent, 'advance-flight');
  assert.equal(Voice.parseCommand('terminate exercise').intent, 'terminate-exercise');
  assert.equal(Voice.parseCommand('restart exercise').intent, 'restart-exercise');
});

test('maps review and entry controls, including exact numeric field updates', () => {
  assert.equal(Voice.parseCommand('replay track').intent, 'replay-play');
  assert.equal(Voice.parseCommand('pause replay').intent, 'replay-pause');
  assert.equal(Voice.parseCommand('new exercise').intent, 'new-exercise');
  assert.equal(Voice.parseCommand('return to console').intent, 'return-console');
  assert.deepEqual(Voice.parseCommand('select tactical qgh'), {
    accepted: true,
    transcript: 'select tactical qgh',
    intent: 'select-simulator-mode',
    mode: 'tactical'
  });
  assert.deepEqual(Voice.parseCommand('select normal qgh'), {
    accepted: true,
    transcript: 'select normal qgh',
    intent: 'set-procedure',
    procedure: 'normal'
  });
  assert.deepEqual(Voice.parseCommand('set runway orientation two three zero'), {
    accepted: true,
    transcript: 'set runway orientation two three zero',
    intent: 'set-field',
    field: 'runway',
    value: 230,
    unit: 'degrees'
  });
  assert.deepEqual(Voice.parseCommand('set ground speed two four zero knots'), {
    accepted: true,
    transcript: 'set ground speed two four zero knots',
    intent: 'set-field',
    field: 'speed',
    value: 240,
    unit: 'knots'
  });
  assert.deepEqual(Voice.parseCommand('set rate of turn three point five'), {
    accepted: true,
    transcript: 'set rate of turn three point five',
    intent: 'set-field',
    field: 'turn-rate',
    value: 3.5,
    unit: 'degrees-per-second'
  });
  assert.equal(Voice.parseCommand('set ground speed very fast').accepted, false);
  assert.equal(Voice.parseCommand('set ground speed two four one knots').accepted, false);
  assert.deepEqual(Voice.parseCommand('set aircraft count four'), {
    accepted: true,
    transcript: 'set aircraft count four',
    intent: 'set-fleet-size',
    count: 4
  });
});

test('accepts only supported replay speeds and complete command variants', () => {
  assert.deepEqual(Voice.parseCommand('set replay speed 10x'), {
    accepted: true,
    transcript: 'set replay speed 10x',
    intent: 'set-replay-speed',
    speed: 10
  });
  assert.equal(Voice.parseCommand('set replay speed ten times').speed, 10);
  assert.equal(Voice.parseCommand('advance flight by one minute').intent, 'advance-flight');
  assert.equal(Voice.parseCommand('set replay speed four').accepted, false);
});

test('maps tactical aircraft and formation commands only when a selected callsign is exact', () => {
  const options = { callsigns: ['Viper One', 'Falcon Two'] };
  assert.deepEqual(Voice.parseCommand('select aircraft viper one', options), {
    accepted: true,
    transcript: 'select aircraft viper one',
    intent: 'select-aircraft',
    aircraft: 'Viper One'
  });
  assert.deepEqual(Voice.parseCommand('transmit for df falcon two', options), {
    accepted: true,
    transcript: 'transmit for df falcon two',
    intent: 'transmit-df',
    aircraft: 'Falcon Two'
  });
  assert.deepEqual(Voice.parseCommand('select formation leader viper one', options), {
    accepted: true,
    transcript: 'select formation leader viper one',
    intent: 'set-formation-leader',
    aircraft: 'Viper One'
  });
  assert.equal(Voice.parseCommand('formation flight on', options).intent, 'set-formation');
  assert.equal(Voice.parseCommand('stop following leader', options).intent, 'stop-following-leader');
  assert.deepEqual(Voice.parseCommand('select aircraft unknown', options), {
    accepted: false,
    transcript: 'select aircraft unknown',
    reason: 'unknown-aircraft'
  });
  assert.deepEqual(Voice.parseCommand('select aircraft viper one', {
    callsigns: ['VIPER ONE', 'Viper One']
  }), {
    accepted: false,
    transcript: 'select aircraft viper one',
    reason: 'ambiguous-aircraft'
  });
});

test('accepts complete callsign, targeted-turn, voice-mode, and review-focus commands', () => {
  const options = { callsigns: [{ id: 'A', callsign: 'FALCON 11' }, { id: 'B', callsign: 'RAVEN 21' }] };
  assert.deepEqual(Voice.parseCommand('set aircraft one callsign Falcon One One', options), {
    accepted: true,
    transcript: 'set aircraft one callsign falcon one one',
    intent: 'set-aircraft-callsign',
    aircraft: '1',
    callsign: 'FALCON 11'
  });
  assert.deepEqual(Voice.parseCommand('set aircraft Falcon Eleven profile Rafale', options), {
    accepted: true,
    transcript: 'set aircraft falcon eleven profile rafale',
    intent: 'set-aircraft-profile',
    aircraft: 'A',
    profile: 'rafale'
  });
  assert.equal(Voice.parseCommand('select aircraft Falcon Eleven profile Rafale', options).accepted, true);
  assert.deepEqual(Voice.parseCommand('Falcon Eleven turn right heading two seven zero', options), {
    accepted: true,
    transcript: 'falcon eleven turn right heading two seven zero',
    intent: 'normal-turn-heading',
    aircraft: 'A',
    side: 'right',
    heading: 270
  });
  assert.deepEqual(Voice.parseCommand('Raven Twenty One turn left now', options), {
    accepted: true,
    transcript: 'raven twenty one turn left now',
    intent: 'us-turn',
    aircraft: 'B',
    side: 'left'
  });
  assert.equal(Voice.parseCommand('continuous listening on').intent, 'set-listening-mode');
  assert.equal(Voice.parseCommand('confirm termination').intent, 'confirm-termination');
  assert.equal(Voice.parseCommand('keep exercise').intent, 'cancel-termination');
  assert.deepEqual(Voice.parseCommand('focus aircraft Falcon Eleven', options), {
    accepted: true,
    transcript: 'focus aircraft falcon eleven',
    intent: 'focus-aircraft',
    aircraft: 'A'
  });
  assert.deepEqual(Voice.parseCommand('set aircraft Falcon Eleven level six thousand feet', options), {
    accepted: true,
    transcript: 'set aircraft falcon eleven level six thousand feet',
    intent: 'set-aircraft-field',
    aircraft: 'A',
    field: 'level',
    value: 6000,
    unit: 'feet'
  });
});

test('parses every documented v4.0.3 voice-command example', () => {
  const options = {
    callsigns: [
      { id: 'A', callsign: 'FALCON 11' },
      { id: 'B', callsign: 'RAVEN 21' }
    ]
  };

  const guideFiles = [
    path.join(__dirname, '..', '..', '..', 'USER_GUIDE.md'),
    path.join(__dirname, '..', 'user-guide.html')
  ];
  const documentedCommands = new Set();

  for (const guideFile of guideFiles) {
    const source = fs.readFileSync(guideFile, 'utf8');
    for (const match of source.matchAll(/“([^”]+)”/g)) documentedCommands.add(match[1]);
  }

  assert.ok(documentedCommands.size > 0, 'expected documented voice-command examples');
  for (const command of documentedCommands) {
    const parsed = Voice.parseCommand(command, options);
    assert.equal(parsed.accepted, true, `expected documented command to parse: ${command}`);
  }
});
