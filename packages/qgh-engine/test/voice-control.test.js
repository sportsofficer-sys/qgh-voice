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

test('maps Normal QGH and U/S Compass turns, including a clear spoken variant', () => {
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
    accepted: true,
    transcript: 'turn right heading two seven zero please',
    intent: 'normal-turn-heading',
    side: 'right',
    heading: 270,
    match: 'semantic',
    confidence: 'high'
  });
});

test('Normal turn commands have the same target and readback with or without the word heading', () => {
  const options = { callsigns: [{ id: 'A', callsign: 'FALCON 11' }, { id: 'B', callsign: 'RAVEN 21' }] };
  const targets = ['', 'Falcon', 'Falcon Eleven', 'Falcon one one', 'Raven 21', 'Raven two one'];
  const headings = [['140', 140], ['one four zero', 140], ['zero zero five', 5], ['tree fife niner', 359]];

  for (const target of targets) {
    for (const side of ['left', 'right']) {
      for (const [spoken, heading] of headings) {
        const prefix = target ? `${target} ` : '';
        const concise = Voice.parseCommand(`${prefix}turn ${side} ${spoken}`, options);
        const expanded = Voice.parseCommand(`${prefix}turn ${side} heading ${spoken}`, options);
        for (const command of [concise, expanded]) {
          assert.equal(command.accepted, true, command.transcript);
          assert.equal(command.intent, 'normal-turn-heading', command.transcript);
          assert.equal(command.side, side, command.transcript);
          assert.equal(command.heading, heading, command.transcript);
          assert.equal(command.aircraft, target ? target.startsWith('Falcon') ? 'A' : 'B' : undefined);
          assert.equal(Voice.requiresVoiceConfirmation(command), false, command.transcript);
        }
        assert.equal(Voice.describeCommand(concise), Voice.describeCommand(expanded));
      }
      const timedTurn = Voice.parseCommand(`${target ? `${target} ` : ''}turn ${side} now`, options);
      assert.equal(timedTurn.intent, 'us-turn');
      assert.equal(timedTurn.side, side);
      assert.equal(timedTurn.heading, undefined, 'timed U/S turns must not acquire an assigned heading');
    }
  }
});

test('routes standalone numeric callsigns from 100 to 999 in written and spoken forms', () => {
  const options = { callsigns: [
    { id: 'A', callsign: '123' },
    { id: 'B', callsign: '456' }
  ] };

  for (const phrase of [
    '123 turn right heading two three zero',
    'one two three turn right heading two three zero',
    'one hundred twenty three turn right heading two three zero'
  ]) {
    const command = Voice.parseCommand(phrase, options);
    assert.equal(command.accepted, true, phrase);
    assert.equal(command.aircraft, 'A', phrase);
    assert.equal(command.heading, 230, phrase);
  }

  assert.equal(Voice.parseCommand('four five six transmit for df', options).aircraft, 'B');
  assert.equal(Voice.parseCommand('124 transmit for df', options).accepted, false);
  assert.equal(Voice.parseCommand('23 transmit for df', options).accepted, false);
});

test('never mistakes a heading or other numeric value for a standalone numeric callsign', () => {
  const options = { callsigns: [
    { id: 'F', callsign: 'FALCON 11' },
    { id: 'N', callsign: '230' }
  ] };

  const bareTurn = Voice.parseCommand('turn right heading two three zero', options);
  assert.equal(bareTurn.accepted, true);
  assert.equal(bareTurn.aircraft, undefined);
  assert.equal(bareTurn.heading, 230);

  const falconTurn = Voice.parseCommand('Falcon turn right heading two three zero', options);
  assert.equal(falconTurn.aircraft, 'F');
  assert.equal(falconTurn.heading, 230);

  const numericTurn = Voice.parseCommand('two three zero turn right heading one four zero', options);
  assert.equal(numericTurn.aircraft, 'N');
  assert.equal(numericTurn.heading, 140);

  const conciseNumericTurn = Voice.parseCommand('two three zero right heading one four zero', options);
  assert.equal(conciseNumericTurn.aircraft, 'N');
  assert.equal(conciseNumericTurn.heading, 140);

  const speed = Voice.parseCommand('set speed 230', options);
  assert.equal(speed.intent, 'set-field');
  assert.equal(speed.aircraft, undefined);
});

test('interprets flexible local RT phrasing only when the essential command slots are present', () => {
  const options = { callsigns: [{ id: 'A', callsign: 'FALCON 11' }, { id: 'B', callsign: 'RAVEN 21' }] };

  assert.deepEqual(Voice.parseCommand('vector right two seventy', options), {
    accepted: true,
    transcript: 'vector right two seventy',
    intent: 'normal-turn-heading',
    side: 'right',
    heading: 270,
    match: 'semantic',
    confidence: 'high'
  });
  assert.equal(Voice.parseCommand('vector right two hundred seventy', options).heading, 270);
  assert.equal(Voice.parseCommand('set speed two hundred forty', options).value, 240);
  assert.deepEqual(Voice.parseCommand('Falcon Eleven right heading two seven zero please', options), {
    accepted: true,
    transcript: 'falcon eleven right heading two seven zero please',
    intent: 'normal-turn-heading',
    aircraft: 'A',
    side: 'right',
    heading: 270,
    match: 'semantic',
    confidence: 'high'
  });
  assert.equal(Voice.parseCommand('make the runway two three zero', options).intent, 'set-field');
  assert.equal(Voice.parseCommand('set final to two two five', options).field, 'inbound');
  assert.equal(Voice.parseCommand('make it a fleet of four', options).intent, 'set-fleet-size');
  assert.equal(Voice.parseCommand('Falcon Eleven set level six thousand', options).field, 'level');
  assert.equal(Voice.parseCommand('set Falcon Eleven profile Rafale', options).intent, 'set-aircraft-profile');
  assert.equal(Voice.parseCommand('Falcon Eleven break formation', options).intent, 'stop-following-leader');
  assert.equal(Voice.parseCommand('replay at ten times', options).speed, 10);
  assert.equal(Voice.parseCommand('start the stopwatch', options).intent, 'clock');
  assert.equal(Voice.parseCommand('show Falcon Eleven track', options).intent, 'focus-aircraft');
  assert.deepEqual(Voice.parseCommand('continue zero six zero', options), {
    accepted: true,
    transcript: 'continue zero six zero',
    intent: 'continue-turn-heading',
    heading: 60,
    match: 'semantic',
    confidence: 'high'
  });
  assert.deepEqual(Voice.parseCommand('Raven Twenty One turn right', options), {
    accepted: true,
    transcript: 'raven twenty one turn right',
    intent: 'us-turn',
    aircraft: 'B',
    side: 'right',
    match: 'semantic',
    confidence: 'high'
  });
  assert.equal(Voice.parseCommand('Raven turn right heading zero six zero', options).aircraft, 'B');
  assert.equal(Voice.parseCommand('Raven transmit for D/F', options).aircraft, 'B');
  assert.deepEqual(Voice.parseCommand('Raven turn right two two zero', options), {
    accepted: true,
    transcript: 'raven turn right two two zero',
    intent: 'normal-turn-heading',
    aircraft: 'B',
    side: 'right',
    heading: 220,
    match: 'semantic',
    confidence: 'high'
  });
  assert.deepEqual(Voice.parseCommand('Raven Twenty One transmit for D/F', options), {
    accepted: true,
    transcript: 'raven twenty one transmit for df',
    intent: 'transmit-df',
    aircraft: 'B',
    match: 'semantic',
    confidence: 'high'
  });
  assert.deepEqual(Voice.parseCommand('add Raven Twenty One to formation', options), {
    accepted: true,
    transcript: 'add raven twenty one to formation',
    intent: 'set-formation-member',
    aircraft: 'B',
    enabled: true,
    match: 'semantic',
    confidence: 'high'
  });
  assert.deepEqual(Voice.parseCommand('remove Raven Twenty One from formation', options), {
    accepted: true,
    transcript: 'remove raven twenty one from formation',
    intent: 'set-formation-member',
    aircraft: 'B',
    enabled: false,
    match: 'semantic',
    confidence: 'high'
  });

  for (const incomplete of ['right', 'turn', 'heading', 'two seven zero', 'transmit', 'continue', 'Falcon Eleven right']) {
    assert.equal(Voice.parseCommand(incomplete, options).accepted, false, `must not execute incomplete command: ${incomplete}`);
  }
  assert.equal(Voice.parseCommand('Falcon turn right heading zero six zero', {
    callsigns: ['FALCON 11', 'FALCON 12']
  }).accepted, false, 'an abbreviated callsign must be rejected when it is not unique');
  assert.equal(Voice.parseCommand('continue right zero six zero', options).accepted, false, 'continue must not ignore a stated turn direction');
  assert.equal(Voice.parseCommand('Raven stop', options).accepted, false, 'a U/S stop call requires the word turn');
  assert.equal(Voice.parseCommand('Raven right now', options).accepted, false, 'a U/S turn call requires the word turn');
  assert.equal(Voice.parseCommand('Raven Twelve Three transmit for D/F', {
    callsigns: [{ id: 'R12', callsign: 'RAVEN 12' }]
  }).accepted, false, 'a longer unknown numeric callsign must not route to a configured prefix');
  assert.equal(Voice.parseCommand('Raven Twelve Three transmit for D/F', {
    callsigns: [{ id: 'R123', callsign: 'RAVEN 123' }]
  }).aircraft, 'R123', 'a mixed spoken numeric callsign must resolve when configured');
  assert.equal(Voice.parseCommand('Raven One Two Three transmit for D/F', {
    callsigns: [{ id: 'R12', callsign: 'RAVEN 12' }, { id: 'R123', callsign: 'RAVEN 123' }]
  }).aircraft, 'R123', 'the complete configured numeric callsign must win over its prefix');
  assert.equal(Voice.parseCommand('would you turn right heading two seven zero', options).heading, 270, 'recognized lead-in fillers must not block a valid RT call');
  assert.equal(Voice.parseCommand('Tiger turn right heading two seven zero', options).accepted, false, 'an unknown callsign must not become a generic command');
  assert.equal(Voice.parseCommand('the speed is two hundred', options).accepted, false, 'conversation must not alter a field');
  [
    'start stop clock',
    'formation on off',
    'show qdm qte',
    'enable disable zoom',
    'replay play pause',
    'continuous listening on off'
  ].forEach(transcript => {
    assert.equal(Voice.parseCommand(transcript, options).accepted, false, `conflicting call must be rejected: ${transcript}`);
  });
});

test('flags semantic navigation and reset actions for a separate confirmation step', () => {
  const restart = Voice.parseCommand('start a fresh exercise please');
  const changeType = Voice.parseCommand('go back and change qgh mode');
  assert.equal(restart.accepted, true);
  assert.equal(restart.requiresConfirmation, true);
  assert.equal(changeType.accepted, true);
  assert.equal(changeType.requiresConfirmation, true);
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
  assert.equal(Voice.parseCommand('transmit for D/F please').intent, 'transmit-df');
  assert.equal(Voice.parseCommand('transmit for direction finding now').intent, 'transmit-df');
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
  assert.deepEqual(Voice.parseCommand('set aircraft Falcon Eleven callsign Falcon One One', options), {
    accepted: true,
    transcript: 'set aircraft falcon eleven callsign falcon one one',
    intent: 'set-aircraft-callsign',
    aircraft: 'A',
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
  assert.equal(Voice.parseCommand('two turn right heading two two zero', options).accepted, false, 'a row number is not a tactical callsign');
  assert.equal(Voice.parseCommand('Raven Thirteen turn right heading two two zero', {
    callsigns: [{ id: 'B', callsign: 'RAVEN 12' }]
  }).accepted, false, 'an unknown numeric callsign must not resolve to a shortened designator');
  const sharedDesignators = {
    callsigns: [{ id: 'B', callsign: 'RAVEN 21' }, { id: 'C', callsign: 'RAVEN 22' }]
  };
  assert.equal(Voice.parseCommand('Raven turn right heading two two zero', sharedDesignators).accepted, false, 'a shared designator is ambiguous');
  assert.equal(Voice.parseCommand('Raven Twenty One turn right heading two two zero', sharedDesignators).aircraft, 'B', 'the full callsign remains valid when a designator is shared');

  const ravenTwelve = { callsigns: [{ id: 'B', callsign: 'RAVEN 12' }] };
  [
    'Raven Thirteen turn right two two zero',
    'Raven Thirteen turn right now',
    'Raven Thirteen continue zero six zero',
    'Raven Thirteen transmit',
    'Raven Thirteen stop following leader'
  ].forEach(transcript => {
    assert.equal(Voice.parseCommand(transcript, ravenTwelve).accepted, false, `unknown callsign must not route: ${transcript}`);
  });
});

test('describes a tactical command with its configured callsign instead of an internal aircraft ID', () => {
  const command = {
    accepted: true,
    intent: 'normal-turn-heading',
    aircraft: 'B',
    side: 'right',
    heading: 270
  };

  assert.equal(
    Voice.describeCommand(command, { targetLabel: 'Raven 21' }),
    'RAVEN 21 · TURN RIGHT HEADING 270'
  );
  assert.equal(Voice.describeCommand(command), 'B · TURN RIGHT HEADING 270');
});

test('parses every documented controller voice-command example through the live control or RT parser', () => {
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
    const parsed = require('../radio-session.js').parseMessage(command, Voice, { ...options, single: true }) || Voice.parseCommand(command, options);
    assert.equal(parsed.accepted, true, `expected documented command to parse: ${command}`);
  }
});
