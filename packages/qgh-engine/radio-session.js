(function exposeRadio(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QGHRadioSession = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function createRadioModule() {
  'use strict';
  const HOLD_MS = 2000;
  const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const spokenDigits = value => String(value).replace(/\d/g, digit => `${DIGITS[Number(digit)]} `).trim();

  // This is an RT-only vocabulary, not a procedure or a second flight controller.
  // Entries are short generic cues, not reproductions of the supplied manual pages.
  const RADIO_CUES = [
    { pattern: /\b(?:weather|surface wind|wind|temperature|visibility|cloud|trend)\b/, kind: 'receipt', label: 'WEATHER' },
    { pattern: /\b(?:(?:df|qgh) profile|outbound track|inbound track|overhead turn (?:will|is)|(?:stand by|standby)|timing you outbound|indication approaching overhead)\b/, kind: 'receipt', label: 'PROFILE' },
    { pattern: /\b(?:homing|bearing|runway in use|indication (?:crossing|crossed|overhead))\b/, kind: 'receipt', label: 'INFORMATION' },
    { pattern: /\b(?:commence descent|continue descent|climb|descend|descending|maintain altitude|maintain level|cleared for|cleared to land|contact tower|change frequency|set qnh|set qfe)\b/, kind: 'unmodelled', label: 'INSTRUCTION' },
    { pattern: /\b(?:report aerodrome|report runway|report visual|report passing|report steady|check|confirm|give (?:a )?long transmission|give (?:a )?short transmission|speechless aircraft|compass appears|runway (?!in use))\b/, kind: 'unmodelled', label: 'REPORT OR CHECK' },
    { pattern: /\b(?:make all turns|start and stop all turns|fly wings level|continue wings level|commence (?:left|right|level) base turn)\b/, kind: 'unmodelled', label: 'PROCEDURE INSTRUCTION' }
  ];
  const GRAMMAR_EXAMPLES = Object.freeze([
    'surface wind two three zero degrees ten knots', 'wind calm', 'wind variable five knots',
    'weather surface wind zero six zero at fifteen knots visibility five kilometres cloud broken two thousand feet',
    'temperature twenty eight', 'temperature minus five', 'visibility three thousand metres', 'cloud few scattered broken overcast eight octas trend no change',
    'qgh profile outbound track zero six five left base turn inbound track two two five',
    'df profile outbound track zero six five right base turn inbound track two two five',
    'overhead turn will be right longer way for outbound track zero six five',
    'overhead turn will be left shorter way for outbound track two two five',
    'stand by for left turn for outbound', 'stand by for right turn for outbound',
    'indication approaching overhead', 'homing two three zero', 'bearing zero six zero',
    'timing you outbound for two minutes thirty seconds now', 'runway in use two three',
    'commence descent now', 'continue descent', 'descend to four thousand feet', 'climb to five thousand feet',
    'check altitude three thousand feet minimum descent altitude two thousand feet',
    'report passing heading one four zero', 'report steady heading two two five',
    'report aerodrome visual', 'report runway in sight', 'report visual',
    'cleared for straight in approach', 'cleared for circling approach', 'cleared to land runway two three',
    'contact tower frequency one two three decimal four', 'set qnh one zero one three', 'set qfe nine nine eight',
    'check compass synchronized', 'check demisters on', 'confirm fuel', 'confirm engine', 'confirm hydraulic', 'confirm oxygen', 'confirm any other emergency',
    'make all turns three degrees per second', 'start and stop all turns on the command now',
    'give a long transmission passing heading one four zero', 'give a long transmission at minimum descent altitude',
    'give a long transmission for three greens', 'give a long transmission on final', 'give a long transmission for runway in sight'
  ]);

  function parseMessage(value, Voice, options = {}) {
    const transcript = Voice.normalizeTranscript(value);
    if (/^(?:(?:confirm|cancel) voice command|confirm termination|keep exercise)$/.test(transcript)) return null;
    if (/\borbit\b/.test(transcript) || /(?:^| )continue$/.test(transcript) || /\bresume normal\b/.test(transcript)) {
      const reject = reason => ({ accepted: false, transcript, reason });
      const match = /^(.*?)(?:(?:commence|start|make)(?: an?| the)? )?(?:orbit (left|right)(?: now)?|(left|right)(?: hand)? orbit(?: now)?|(continue(?: (?:the )?orbit)?)|(resume normal))(?: please)?$/.exec(transcript);
      if (!match) return reject('specify-left-or-right-orbit');
      const prefix = match[1].trim().replace(/^please(?:\s+|$)/, '');
      let aircraft;
      if (prefix) {
        const target = Voice.parseCommand(`${prefix} transmit for df`, { callsigns: options.callsigns });
        if (!target.accepted || !target.aircraft) return reject('unknown-aircraft');
        aircraft = target.aircraft;
      } else if (!options.single) return reject('callsign-required');
      return { accepted: true, transcript, intent: match[5] ? 'resume-normal' : match[4] ? 'continue-orbit' : 'start-orbit',
        ...(match[2] || match[3] ? { side: match[2] || match[3] } : {}), ...(aircraft ? { aircraft } : {}) };
    }
    // Claim malformed passing requests too: never let them fall through to an
    // immediate heading report, or infer a turn from a future reporting condition.
    if (/\breport\b/.test(transcript) && /\bpassing\b/.test(transcript)) {
      const reject = reason => ({ accepted: false, transcript, reason });
      const match = /^(.*?)\breport (?:heading passing|passing(?: heading)?) (.+)$/.exec(transcript);
      if (!match || /\b(?:cancel|not|negative|correction|unless|if|don't)\b/.test(transcript)) return reject('unclear-passing-report');
      const heading = Voice.parseHeading(match[2].replace(/\s+please$/, '').replace(/\s+degrees?(?: magnetic)?$/, ''));
      if (heading == null) return reject('invalid-passing-heading');
      const prefix = match[1].trim().replace(/^please(?:\s+|$)/, '');
      let aircraft;
      if (prefix) {
        const target = Voice.parseCommand(`${prefix} transmit for df`, { callsigns: options.callsigns });
        if (!target.accepted || !target.aircraft) return reject('unknown-aircraft');
        aircraft = target.aircraft;
      } else if (!options.single) return reject('callsign-required');
      return { accepted: true, transcript, intent: 'request-heading-passing', heading: heading % 360, ...(aircraft ? { aircraft } : {}) };
    }
    const candidates = RADIO_CUES.map(cue => ({ ...cue, match: cue.pattern.exec(transcript) })).filter(cue => cue.match)
      .sort((a, b) => a.match.index - b.match.index);
    if (!candidates.length) return null;
    const cue = candidates[0];
    const prefix = transcript.slice(0, cue.match.index).trim().replace(/^(?:please|aircraft)\s+/, '');
    const body = transcript.slice(cue.match.index);
    const reject = reason => ({ accepted: false, transcript, reason });
    if (/\bunk\b/.test(body)) return reject('unclear-radio-message');
    if (/\b(?:if|unless|correction|negative|not|do not|do nt|don't)\b/.test(body)) return reject('unclear-radio-message');
    // Coherent known RT vocabulary is required; an arbitrary sentence beginning
    // with "weather" is not enough to manufacture a pilot acknowledgement.
    const vocabulary = new Set(Voice.normalizeTranscript(GRAMMAR_EXAMPLES.join(' ') + ' zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand tree fife niner degrees degree knots knot at is the and minus plus point decimal metres meters kilometres kilometers per hour indication crossing crossed overhead no compass unreliable appears will follow profile obstacle clearance altitude minimum descent your minima channel hydraulic instruments oxygen fuel emergency endurance litres kilograms pounds every nearest half final follow me vehicle yes affirmative negative now traffic').split(' '));
    if (body.split(' ').some(word => !/^\d+(?:\.\d+)?$/.test(word) && !vocabulary.has(word))) return reject('unclear-radio-message');
    if (cue.kind === 'receipt' && candidates.some(item => item.kind === 'unmodelled')) return reject('separate-radio-and-control-calls');
    let aircraft;
    if (prefix) {
      const target = Voice.parseCommand(`${prefix} transmit for df`, { callsigns: options.callsigns });
      if (!target.accepted || !target.aircraft) return reject('unknown-aircraft');
      aircraft = target.aircraft;
    } else if (!options.single) return reject('callsign-required');
    // Never extract a manoeuvre from a weather/briefing call. Compound operational
    // instructions need a separate clear call; future/standby turns remain briefings.
    if (/\b(?:turn (?:left|right)(?: heading)? (?:now|\d|zero|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner)|stop turn now)\b/.test(body)
      && !/^(?:overhead turn (?:will|is)|stand by|standby)/.test(body)) return reject('separate-radio-and-control-calls');
    if (cue.kind === 'receipt' && body.trim() === cue.match[0]) return reject('incomplete-radio-message');
    return { accepted: true, transcript, intent: 'radio-exchange', ...(aircraft ? { aircraft } : {}),
      radioKind: cue.kind, radioLabel: cue.label, radioMessage: body };
  }

  function createHeadingReports() {
    const requests = new Map();
    const norm = value => (value % 360 + 360) % 360;
    return Object.freeze({
      arm(source, heading, currentHeading) {
        if (!source || !Number.isInteger(heading) || heading < 0 || heading > 360 || !Number.isFinite(currentHeading)) return false;
        requests.set(source, { heading: heading % 360, previous: norm(currentHeading) });
        return true;
      },
      observe(source, currentHeading) {
        const request = requests.get(source);
        if (!request || !Number.isFinite(currentHeading)) return null;
        const previous = request.previous;
        const current = norm(currentHeading);
        request.previous = current;
        // Inputs are consecutive quarter-second physics samples, never minute endpoints.
        const movement = norm(current - previous + 180) - 180;
        const distance = movement > 0 ? norm(request.heading - previous) : norm(previous - request.heading);
        if (Math.abs(movement) < 1e-9 || distance < 1e-9 || distance > Math.abs(movement) + 1e-9) return null;
        requests.delete(source);
        return Object.freeze({ source, heading: request.heading });
      },
      clear(source) { if (source == null) requests.clear(); else requests.delete(source); }
    });
  }

  function createReceiver({ observe, now = () => performance.now(), onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let generation = 0;
    let source = null;
    let held = null;
    let holdUntil = 0;
    let expiryTimer = null;
    function reset() {
      clearTimer(expiryTimer);
      expiryTimer = null;
      generation += 1;
      source = null;
      held = null;
      holdUntil = 0;
    }
    function transmit(id) {
      reset();
      source = id;
      return generation;
    }
    function release(token = generation) {
      if (token !== generation || source === null) return;
      const observation = observe(source);
      held = observation ? { ...observation } : null;
      source = null;
      holdUntil = now() + HOLD_MS;
      if (onChange) expiryTimer = setTimer(() => {
        if (token !== generation || source !== null) return;
        held = null;
        expiryTimer = null;
        onChange();
      }, HOLD_MS);
    }
    function read() {
      if (source !== null) {
        const observation = observe(source);
        return observation ? { ...observation, phase: 'live' } : { phase: 'idle' };
      }
      return held && now() < holdUntil ? { ...held, phase: 'hold' } : { phase: 'idle' };
    }
    // Ground suppression is the explicitly selected training configuration.
    return Object.freeze({ transmit, release, read, reset, controllerStart: reset });
  }

  function replyFor(command, aircraft) {
    if (!aircraft?.callsign) return null;
    let text;
    let speech;
    if (command.intent === 'radio-exchange') {
      if (command.radioKind === 'receipt') { text = 'ROGER'; speech = 'Roger'; }
      else {
        text = `${command.radioLabel} RECEIVED · NOT SIMULATED`;
        speech = 'Instruction received. This action is not simulated';
      }
    } else if (['resume-normal', 'orbit-resumed'].includes(command.intent)) {
      const pending = command.intent === 'resume-normal' && aircraft.orbitSide;
      text = pending ? 'WILL RESUME NORMAL AFTER THIS ORBIT' : 'RESUMING NORMAL';
      speech = pending ? 'Will resume normal after this orbit' : 'Resuming normal';
    } else if (['start-orbit', 'continue-orbit', 'orbit-complete'].includes(command.intent)) {
      const side = command.side || aircraft.orbitSide;
      if (!['left', 'right'].includes(side)) return null;
      const action = command.intent === 'orbit-complete' ? `Orbit complete, continuing ${side} orbit`
        : command.intent === 'continue-orbit' ? `Continuing ${side} orbit` : `Orbiting ${side}`;
      text = action.toUpperCase(); speech = action;
    } else if (command.intent === 'us-turn') {
      if (!['left', 'right'].includes(command.side)) return null;
      text = `TURNING ${command.side.toUpperCase()}`;
      speech = `Turning ${command.side}`;
    } else if (command.intent === 'us-turn-stop') {
      text = 'STOP TURN'; speech = 'Stop turn';
    } else if (['normal-turn-heading', 'continue-turn-heading'].includes(command.intent)) {
      if (aircraft.procedure === 'us' || !Number.isFinite(command.heading)) return null;
      const heading = String((Math.round(command.heading) % 360 + 360) % 360).padStart(3, '0');
      const side = command.side || aircraft.turnSide;
      if (!['left', 'right'].includes(side)) return null;
      text = `TURNING ${side.toUpperCase()} ${heading}°M`;
      speech = `Roger, turning ${side}, ${spokenDigits(heading)}`;
    } else if (['request-heading-passing', 'heading-passing-report'].includes(command.intent)) {
      if (aircraft.procedure === 'us' || !Number.isInteger(command.heading) || command.heading < 0 || command.heading > 360) return null;
      const heading = String(command.heading % 360).padStart(3, '0');
      const action = command.intent === 'request-heading-passing' ? 'Will report passing' : command.delayed ? 'Passed' : 'Passing';
      text = `${action.toUpperCase()} ${heading}°M`; speech = `${action} ${spokenDigits(heading)}`;
    } else if (command.intent === 'report-heading') {
      if (aircraft.procedure === 'us' || !Number.isFinite(aircraft.heading)) return null;
      const heading = String((Math.round(aircraft.heading) % 360 + 360) % 360).padStart(3, '0');
      text = `HEADING ${heading}°M`; speech = `Heading ${spokenDigits(heading)}`;
    } else if (command.intent === 'request-distance') {
      if (!Number.isFinite(aircraft.range)) return null;
      const range = aircraft.range.toFixed(1);
      text = `RANGE ${range} NM`; speech = `Range ${spokenDigits(range).replace('.', ' decimal ')} nautical miles`;
    } else if (command.intent === 'transmit-df') {
      text = 'TRANSMITTING FOR D/F'; speech = 'Transmitting for direction finding';
    } else if (['set-field', 'set-aircraft-field'].includes(command.intent) && command.field === 'speed') {
      text = `SPEED ${command.value} KT`; speech = `Speed ${command.value} knots`;
    } else if (command.intent === 'stop-following-leader') {
      text = 'FLYING INDEPENDENTLY'; speech = 'Flying independently';
    } else return null;
    return Object.freeze({ text: `${text} · ${aircraft.callsign}`, speech: `${speech}, ${aircraft.callsign}.` });
  }

  return Object.freeze({ createReceiver, createHeadingReports, replyFor, parseMessage, GRAMMAR_EXAMPLES, HOLD_MS });
});
