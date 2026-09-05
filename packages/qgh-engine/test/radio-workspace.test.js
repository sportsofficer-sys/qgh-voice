'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Radio = require('../radio-session.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'radio-workspace.js'), 'utf8');

function harness(voices = [], enableAudio = true) {
  let time = 0;
  let next = 0;
  let selected = 'A';
  let qdm = 60;
  let enabled = true;
  const headings = { A: 230, B: 230 };
  let simulationSeconds = 0;
  let procedure = 'normal';
  const captions = [];
  const timers = new Map();
  const utterances = [];
  const gates = [];
  const snapshots = id => ({ source: id || selected, callsign: (id || selected) === 'A' ? 'FALCON 11' : 'RAVEN 21', procedure, heading: headings[id || selected], simulationSeconds, range: 10, qdm, qte: (qdm + 180) % 360 });
  const setTimer = (callback, ms) => { const id = ++next; timers.set(id, { callback, at: time + ms }); return id; };
  const clearTimer = id => timers.delete(id);
  let paints = 0;
  let queuedSpeech = null;
  let cancellations = 0;
  const receiver = Radio.createReceiver({ observe: snapshots, now: () => time, setTimer, clearTimer, onChange: () => paints++ });
  const sandbox = {
    QGHRadioSession: Radio,
    QGHRadioAdapter: { snapshot: snapshots, active: () => enabled, beginTransmit: id => receiver.transmit(id), endTransmit: token => receiver.release(token), observation: () => receiver.read(), controllerStart: () => receiver.controllerStart() },
    QGHVoiceWorkspace: { setPilotSpeaking: value => gates.push(value), showPilotReply: reply => captions.push(reply.text), isDispatchingRadioCommand: () => false },
    setTimeout: setTimer, clearTimeout: clearTimer,
    speechSynthesis: {
      getVoices: () => voices,
      cancel() { cancellations += 1; queuedSpeech = null; },
      speak(utterance) { queuedSpeech = utterance; utterances.push(utterance); }
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  if (enableAudio) sandbox.QGHRadioWorkspace.setAudioEnabled(true);
  const advance = ms => {
    const end = time + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      time = entry[1].at;
      timers.delete(entry[0]);
      entry[1].callback();
    }
    time = end;
  };
  return { radio: sandbox.QGHRadioWorkspace, receiver, utterances, gates, advance, captions,
    queuedSpeech: () => queuedSpeech, cancellations: () => cancellations,
    heading: (id, value, seconds = .25) => { headings[id] = value; simulationSeconds += seconds; sandbox.QGHRadioWorkspace.observeHeading(id, value); },
    procedure: value => { procedure = value; },
    select: id => { selected = id; }, move: bearing => { qdm = bearing; }, close: () => { enabled = false; }, paints: () => paints };
}
const local = [{ localService: true, lang: 'en-IN', name: 'Local test voice' }];
const turn = { intent: 'normal-turn-heading', aircraft: 'A', side: 'right', heading: 230 };

test('a passing report is deferred, one-shot, source-stable and includes DF while muted', () => {
  const h = harness([], false);
  assert.equal(h.radio.requestHeadingPassing({ aircraft: 'A', heading: 240 }).ok, true);
  h.advance(1000); assert.equal(h.captions.length, 0);
  h.heading('A', 239.9); h.advance(500); assert.equal(h.captions.length, 0);
  h.select('B'); h.heading('A', 240.1); h.advance(300);
  assert.equal(h.captions[0], 'PASSING 240°M · FALCON 11');
  assert.equal(h.receiver.read().source, 'A');
  assert.equal(h.receiver.read().phase, 'live');
  h.advance(8000); h.heading('A', 241); h.advance(8000);
  assert.equal(h.captions.length, 1);
  assert.equal(h.receiver.read().phase, 'idle');
});

test('reports survive microphone reset and PTT, but exercise reset clears obligations and queued events', () => {
  const h = harness([], false);
  h.radio.requestHeadingPassing({ aircraft: 'A', heading: 240 }); h.radio.reset();
  h.radio.controllerStart(); h.heading('A', 241); h.advance(1000);
  assert.equal(h.captions.length, 0);
  h.radio.reset(); h.advance(300);
  assert.equal(h.captions.length, 1);
  h.radio.resetExercise();
  h.radio.requestHeadingPassing({ aircraft: 'A', heading: 250 });
  h.radio.controllerStart(); h.heading('A', 251);
  h.radio.resetExercise(); h.advance(10000);
  assert.equal(h.captions.length, 1);
  h.radio.requestHeadingPassing({ aircraft: 'A', heading: 260 });
  h.radio.resetExercise(); h.heading('A', 261); h.advance(10000);
  assert.equal(h.captions.length, 1);
});

test('automatic reports wait for pilot and manual DF transmissions and survive a fresh controller call', () => {
  const h = harness(local);
  h.radio.acknowledge(turn); h.advance(300); h.utterances[0].onstart();
  h.radio.requestHeadingPassing({ aircraft: 'B', heading: 240 }); h.heading('B', 241); h.advance(500);
  assert.equal(h.utterances.length, 1, 'does not preempt pilot speech');
  h.radio.controllerStart(); h.radio.acknowledge({ ...turn, heading: 60 }); h.radio.controllerEnd();
  h.advance(300); h.utterances[1].onstart(); h.utterances[1].onend(); h.advance(550);
  assert.match(h.utterances[2].text, /^Passing two four zero, RAVEN 21/);
  h.utterances[2].onstart(); h.utterances[2].onend(); h.advance(3000);
  const token = h.receiver.transmit('A');
  h.radio.requestHeadingPassing({ aircraft: 'B', heading: 250 }); h.heading('B', 251); h.advance(1500);
  assert.equal(h.utterances.length, 3, 'manual DF remains the live transmitter');
  h.radio.interrupt(); h.receiver.release(token); h.radio.channelAvailable(); h.advance(300);
  assert.match(h.utterances[3].text, /^Passing two five zero, RAVEN 21/);
});

test('late reports say passed and use present DF, invalid replacement and U/S do not arm', () => {
  const h = harness([], false);
  h.radio.controllerStart();
  h.radio.requestHeadingPassing({ aircraft: 'A', heading: 240 });
  assert.equal(h.radio.requestHeadingPassing({ aircraft: 'A', heading: 400 }).ok, false);
  h.heading('A', 241); h.heading('A', 250, 20); h.move(190);
  h.radio.controllerEnd(); h.advance(300);
  assert.equal(h.captions[0], 'PASSED 240°M · FALCON 11');
  assert.equal(h.receiver.read().qdm, 190);
  h.radio.resetExercise(); h.procedure('us');
  assert.equal(h.radio.requestHeadingPassing({ aircraft: 'A', heading: 260 }).ok, false);
  h.heading('A', 261); h.advance(5000); assert.equal(h.captions.length, 1);
});

test('replacing a fired but unsent report cancels only that aircraft’s old report', () => {
  const h = harness([], false); h.radio.controllerStart();
  h.radio.requestHeadingPassing({ aircraft: 'A', heading: 240 }); h.heading('A', 241);
  h.radio.requestHeadingPassing({ aircraft: 'B', heading: 250 }); h.heading('B', 251);
  h.radio.requestHeadingPassing({ aircraft: 'A', heading: 270 });
  h.radio.controllerEnd(); h.advance(300);
  assert.equal(h.captions[0], 'PASSING 250°M · RAVEN 21');
  h.advance(5000); assert.equal(h.captions.length, 1);
  h.heading('A', 271); h.advance(300);
  assert.equal(h.captions[1], 'PASSING 270°M · FALCON 11');
});

test('a fresh device defaults to muted replies and headphones are an explicit opt-in', () => {
  const h = harness(local, false);
  assert.equal(h.radio.status().audioEnabled, false);
  assert.equal(h.radio.allowsBargeIn(), false);
  h.radio.acknowledge(turn); h.advance(300);
  assert.equal(h.utterances.length, 0);
  assert.equal(h.receiver.read().phase, 'live');
  h.radio.setAudioEnabled(true);
  assert.equal(h.radio.allowsBargeIn(), true);
});

test('pilot transmission waits for channel release and retains addressed identity across selection changes', () => {
  const h = harness(local);
  h.radio.controllerStart(); h.radio.acknowledge(turn); h.select('B'); h.advance(1000);
  assert.equal(h.utterances.length, 0);
  h.radio.controllerEnd(); h.advance(300);
  const speech = h.utterances[0];
  assert.match(speech.text, /two three zero, FALCON 11/);
  assert.equal(speech.rate, 100 / 150, 'headphone replies use an approximate 100 WPM pace');
  assert.equal(h.gates.at(-1), true);
  speech.onstart();
  assert.equal(h.receiver.read().source, 'A');
  h.move(70); speech.onend(); h.move(90);
  assert.equal(h.receiver.read().qdm, 70);
  h.advance(2000);
  assert.equal(h.receiver.read().phase, 'idle');
  assert.equal(h.paints(), 1, 'expiry repaint does not require a physics tick');
  assert.equal(h.gates.at(-1), false);
});

test('slower headphone replies retain a bounded fifteen-second audio watchdog', () => {
  const h = harness(local);
  h.radio.acknowledge(turn); h.advance(300); h.utterances[0].onstart();
  h.advance(10000);
  assert.equal(h.receiver.read().phase, 'live', 'a long slower reply is not cut off at ten seconds');
  h.advance(5000);
  assert.equal(h.queuedSpeech(), null, 'watchdog cancels synthesis, not just the D/F indicator');
  assert.ok(h.cancellations() > 0);
  assert.equal(h.radio.status().phase, 'idle', 'missing end events still release the pilot channel');
  assert.equal(h.receiver.read().phase, 'hold');
  h.advance(2000);
  assert.equal(h.receiver.read().phase, 'idle', 'D/F hold stays two seconds');
});

test('remote-only voices, disabled speakers and missing synthesis events have bounded DF fallback', () => {
  for (const scenario of ['remote', 'mute', 'no-start', 'end-before-start', 'error']) {
    const h = harness(scenario === 'remote' ? [{ localService: false, lang: 'en-US' }] : local);
    if (scenario === 'mute') h.radio.setAudioEnabled(false);
    h.radio.acknowledge({ intent: 'transmit-df', aircraft: 'A' }); h.advance(300);
    if (scenario === 'no-start') h.advance(1500);
    if (scenario === 'end-before-start') h.utterances[0].onend();
    if (scenario === 'error') h.utterances[0].onerror();
    assert.equal(h.receiver.read().phase, 'live', scenario);
    if (['remote', 'mute'].includes(scenario)) assert.equal(h.utterances.length, 0);
    h.advance(6500);
    assert.equal(h.receiver.read().phase, 'idle', scenario);
    assert.equal(h.radio.status().phase, 'idle', scenario);
  }
});

test('PTT interruption and stale synthesis callbacks cannot affect the next reply or ground suppression', () => {
  const h = harness(local);
  h.radio.acknowledge(turn); h.advance(300);
  const staleStart = h.utterances[0].onstart;
  const staleEnd = h.utterances[0].onend;
  h.radio.controllerStart();
  assert.equal(h.queuedSpeech(), null, 'PTT cancels the previous queued or speaking utterance');
  assert.equal(h.cancellations(), 1);
  assert.equal(h.receiver.read().phase, 'idle');
  h.radio.acknowledge({ intent: 'us-turn-stop', aircraft: 'B' }); h.radio.controllerEnd(); h.advance(300);
  staleStart(); staleEnd(); h.advance(1500);
  assert.equal(h.receiver.read().source, 'B', 'the new missing-start fallback was not cancelled');
  h.radio.reset(); h.close(); h.advance(15000);
  assert.equal(h.utterances.length, 2);
  assert.equal(h.receiver.read().phase, 'idle');
});

test('a newer pending manoeuvre supersedes an older one and muting does not extinguish transmission', () => {
  const h = harness(local);
  h.radio.controllerStart(); h.radio.acknowledge(turn);
  h.radio.acknowledge({ intent: 'us-turn-stop', aircraft: 'A' });
  assert.equal(h.radio.status().pending, 1);
  h.radio.controllerEnd(); h.advance(300); h.utterances[0].onstart();
  assert.match(h.utterances[0].text, /^Stop turn/);
  h.radio.setAudioEnabled(false);
  assert.equal(h.queuedSpeech(), null, 'muting must stop actual synthesis');
  assert.ok(h.cancellations() > 0);
  assert.equal(h.receiver.read().phase, 'live');
  h.advance(250);
  assert.equal(h.gates.at(-1), false, 'muting reopens requested continuous listening after the audio tail');
  assert.equal(h.receiver.read().phase, 'live', 'mute does not stop the aircraft radio observation');
  h.advance(10000);
  assert.equal(h.receiver.read().phase, 'idle');
});

test('a new accepted left 010 command interrupts a right 060 readback without waiting for its end', () => {
  const h = harness(local);
  h.radio.acknowledge({ ...turn, heading: 60 }); h.advance(300); h.utterances[0].onstart();
  const staleEnd = h.utterances[0].onend;
  h.radio.manualCommand({ ...turn, side: 'left', heading: 10 });
  assert.equal(h.queuedSpeech(), null, 'the old right-turn reply is cancelled immediately');
  assert.equal(h.cancellations(), 1);
  h.advance(300);
  assert.equal(h.utterances.length, 2);
  assert.equal(h.utterances[1].text, 'Roger, turning left, zero one zero, FALCON 11.');
  h.utterances[1].onstart(); staleEnd();
  assert.equal(h.receiver.read().phase, 'live');
  assert.equal(h.queuedSpeech(), h.utterances[1], 'a stale callback cannot cancel the fresh reply');
});

test('new speed readbacks replace obsolete speeds for that aircraft without dropping another aircraft', () => {
  const h = harness(local);
  h.radio.controllerStart();
  h.radio.acknowledge({ intent: 'set-field', aircraft: 'A', field: 'speed', value: 240 });
  h.radio.acknowledge({ intent: 'set-aircraft-field', aircraft: 'B', field: 'speed', value: 200 });
  h.radio.manualCommand({ intent: 'set-field', aircraft: 'A', field: 'speed', value: 300 });
  assert.equal(h.radio.status().pending, 2);
  h.radio.controllerEnd(); h.advance(300);
  assert.equal(h.utterances[0].text, 'Speed 200 knots, RAVEN 21.');
  h.utterances[0].onstart(); h.utterances[0].onend(); h.advance(550);
  assert.equal(h.utterances[1].text, 'Speed 300 knots, FALCON 11.');
  assert.ok(h.utterances.every(utterance => !utterance.text.includes('240')));
});

test('controller interruption discards the old reply and stale callbacks before or after audio start', () => {
  for (const alreadyStarted of [false, true]) {
    const h = harness(local);
    h.radio.acknowledge({ ...turn, heading: 60 }); h.advance(300);
    const previous = h.utterances[0];
    const staleCallbacks = [previous.onstart, previous.onend, previous.onerror];
    if (alreadyStarted) previous.onstart();
    h.radio.controllerStart();
    assert.equal(h.queuedSpeech(), null);
    h.radio.acknowledge({ ...turn, side: 'left', heading: 10 });
    h.radio.controllerEnd(); h.advance(300);
    const fresh = h.utterances[1]; fresh.onstart();
    staleCallbacks.forEach(callback => callback());
    assert.equal(h.queuedSpeech(), fresh);
    assert.equal(h.captions.at(-1), 'TURNING LEFT 010°M · FALCON 11');
    fresh.onend(); h.advance(20000);
    assert.equal(h.utterances.length, 2, 'interrupted reply is never restarted');
    assert.equal(h.receiver.read().phase, 'idle');
  }
});
