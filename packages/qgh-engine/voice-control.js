(function exposeQghVoiceControl(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QGHVoiceControl = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function createQghVoiceControl() {
  'use strict';

  // This module deliberately parses text only. It does not access a microphone,
  // call a network service, or alter the QGH flight model.
  const AVIATION_DIGITS = Object.freeze({
    zero: '0',
    oh: '0',
    one: '1',
    two: '2',
    tree: '3',
    three: '3',
    four: '4',
    fife: '5',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    niner: '9',
    nine: '9'
  });

  const SMALL_NUMBERS = Object.freeze({
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19
  });

  const TENS = Object.freeze({
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
  });

  const AIRCRAFT_PROFILES = Object.freeze({
    fighter: 'fighter',
    'fighter general': 'fighter',
    transport: 'transport',
    'transport general': 'transport',
    helicopter: 'helicopter',
    'helicopter general': 'helicopter',
    tejas: 'tejas',
    rafale: 'rafale',
    'su 30 mki': 'su30',
    'su 30mki': 'su30',
    su30: 'su30',
    'mirage 2000': 'mirage',
    jaguar: 'jaguar',
    'c 17': 'c17',
    'c 17 globemaster iii': 'c17',
    c17: 'c17',
    'c 130j': 'c130',
    'c 130 j': 'c130',
    'c 130j super hercules': 'c130',
    c130: 'c130',
    'an 32': 'an32',
    an32: 'an32',
    'mi 17v 5': 'mi17',
    'mi 17 v 5': 'mi17',
    mi17: 'mi17',
    'ch 47f chinook': 'chinook',
    chinook: 'chinook',
    'ah 64e apache': 'apache',
    apache: 'apache',
    'alh dhurv': 'alh',
    alh: 'alh'
  });

  function normalizeTranscript(value) {
    if (typeof value !== 'string') return '';
    let text = value.normalize ? value.normalize('NFKD') : value;
    text = text.toLowerCase()
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/(\d)\s*[.,]\s*(\d)/g, '$1 point $2')
      .replace(/\bq\s*[\/-]?\s*d\s*[\/-]?\s*m\b/g, 'qdm')
      .replace(/\bq\s*[\/-]?\s*t\s*[\/-]?\s*e\b/g, 'qte')
      .replace(/\bd\s*[\/-]?\s*f\b/g, 'df')
      .replace(/\bu\s*[\/-]?\s*s\b/g, 'us')
      .replace(/[–—−-]/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  }

  function digitFor(token) {
    if (Object.prototype.hasOwnProperty.call(AVIATION_DIGITS, token)) return AVIATION_DIGITS[token];
    return /^\d$/.test(token) ? token : null;
  }

  function parseDigitSequence(tokens) {
    if (!tokens.length) return null;
    const digits = tokens.map(digitFor);
    return digits.every(digit => digit !== null) ? Number(digits.join('')) : null;
  }

  function parseCardinalInteger(tokens) {
    if (!tokens.length) return null;
    const thousandIndex = tokens.indexOf('thousand');
    if (thousandIndex !== -1) {
      if (tokens.lastIndexOf('thousand') !== thousandIndex || thousandIndex === 0) return null;
      const thousands = parseCardinalInteger(tokens.slice(0, thousandIndex));
      const remainderTokens = tokens.slice(thousandIndex + 1);
      const remainder = remainderTokens.length ? parseCardinalInteger(remainderTokens) : 0;
      if (thousands === null || thousands < 1 || remainder === null || remainder >= 1000) return null;
      return thousands * 1000 + remainder;
    }
    if (tokens.length === 1) {
      if (Object.prototype.hasOwnProperty.call(SMALL_NUMBERS, tokens[0])) return SMALL_NUMBERS[tokens[0]];
      if (Object.prototype.hasOwnProperty.call(TENS, tokens[0])) return TENS[tokens[0]];
      return null;
    }

    let index = 0;
    let value = 0;
    const first = tokens[index];
    if (Object.prototype.hasOwnProperty.call(SMALL_NUMBERS, first)
      && SMALL_NUMBERS[first] > 0
      && tokens[index + 1] === 'hundred') {
      value = SMALL_NUMBERS[first] * 100;
      index += 2;
    }

    if (index === tokens.length) return value || null;
    const token = tokens[index];
    if (Object.prototype.hasOwnProperty.call(TENS, token)) {
      value += TENS[token];
      index += 1;
      if (index < tokens.length && Object.prototype.hasOwnProperty.call(SMALL_NUMBERS, tokens[index]) && SMALL_NUMBERS[tokens[index]] < 10) {
        value += SMALL_NUMBERS[tokens[index]];
        index += 1;
      }
    } else if (Object.prototype.hasOwnProperty.call(SMALL_NUMBERS, token)) {
      value += SMALL_NUMBERS[token];
      index += 1;
    }

    return index === tokens.length ? value : null;
  }

  function parseIntegerWords(tokens) {
    const digitSequence = parseDigitSequence(tokens);
    return digitSequence === null ? parseCardinalInteger(tokens) : digitSequence;
  }

  function parseNumber(value) {
    const transcript = normalizeTranscript(value);
    if (!transcript) return null;
    if (/^\d+(?:\.\d+)?$/.test(transcript)) {
      const numeric = Number(transcript);
      return Number.isFinite(numeric) ? numeric : null;
    }

    const tokens = transcript.split(' ');
    const pointIndex = tokens.indexOf('point');
    if (pointIndex !== -1) {
      if (tokens.lastIndexOf('point') !== pointIndex || pointIndex === 0 || pointIndex === tokens.length - 1) return null;
      const whole = parseIntegerWords(tokens.slice(0, pointIndex));
      const fractionDigits = tokens.slice(pointIndex + 1).map(digitFor);
      if (whole === null || !fractionDigits.every(digit => digit !== null)) return null;
      return Number(whole + '.' + fractionDigits.join(''));
    }

    return parseIntegerWords(tokens);
  }

  function parseHeading(value) {
    const transcript = normalizeTranscript(value);
    if (!transcript) return null;
    let heading = null;
    if (/^\d{1,3}$/.test(transcript)) {
      heading = Number(transcript);
    } else {
      const tokens = transcript.split(' ');
      if (tokens.length !== 3) return null;
      heading = parseDigitSequence(tokens);
    }
    return Number.isInteger(heading) && heading >= 0 && heading <= 360 ? heading : null;
  }

  function parseCommandHeading(value) {
    const transcript = normalizeTranscript(value);
    const withoutUnit = stripSuffix(transcript, ['degrees', 'degree', 'degrees magnetic']);
    if (!withoutUnit) return null;
    if (/^\d{3}$/.test(withoutUnit)) return parseHeading(withoutUnit);
    const tokens = withoutUnit.split(' ');
    return tokens.length === 3 ? parseHeading(withoutUnit) : null;
  }

  function stripSuffix(value, suffixes) {
    for (const suffix of suffixes) {
      if (value === suffix) return '';
      if (value.endsWith(' ' + suffix)) return value.slice(0, -suffix.length - 1).trim();
    }
    return value;
  }

  function boundedNumber(value, minimum, maximum, options) {
    const numeric = parseNumber(value);
    const settings = options || {};
    if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) return null;
    if (settings.integer && !Number.isInteger(numeric)) return null;
    if (settings.step && Math.abs(numeric / settings.step - Math.round(numeric / settings.step)) > 1e-9) return null;
    return numeric;
  }

  function accept(transcript, intent, detail) {
    return Object.assign({ accepted: true, transcript, intent }, detail || {});
  }

  function reject(transcript, reason) {
    return { accepted: false, transcript, reason: reason || 'unrecognized-command' };
  }

  function callsignCandidates(options) {
    const raw = options && (Array.isArray(options.callsigns) ? options.callsigns : options.aircraft);
    if (!Array.isArray(raw)) return [];
    return raw.map(item => {
      if (typeof item === 'string') return { spoken: normalizedCallsign(item), value: item };
      if (!item || typeof item !== 'object') return null;
      const callsign = item.callsign || item.label || item.id;
      if (typeof callsign !== 'string') return null;
      return { spoken: normalizedCallsign(callsign), value: item.id || callsign };
    }).filter(item => item && item.spoken);
  }

  function resolveAircraft(reference, options) {
    const normalized = normalizedCallsign(reference);
    if (!normalized) return { reason: 'unknown-aircraft' };
    const candidates = callsignCandidates(options).filter(candidate => candidate.spoken === normalized);
    if (candidates.length === 1) return { aircraft: candidates[0].value };
    if (candidates.length > 1) return { reason: 'ambiguous-aircraft' };

    const ordinal = { one: '1', two: '2', three: '3', four: '4' }[normalized]
      || (/^[1-4]$/.test(normalized) ? normalized : null);
    return ordinal ? { aircraft: ordinal } : { reason: 'unknown-aircraft' };
  }

  function profileFor(value, options) {
    const normalized = normalizeTranscript(value);
    if (!normalized) return null;
    if (options && options.profiles && Object.prototype.hasOwnProperty.call(options.profiles, normalized)) {
      return options.profiles[normalized];
    }
    return AIRCRAFT_PROFILES[normalized] || null;
  }

  function callsignFor(value) {
    const normalized = normalizeTranscript(value);
    if (!normalized || normalized.length > 20) return null;
    const tokens = normalized.split(' ');
    if (tokens.length < 2 || tokens.some(token => !/^[a-z0-9]+$/.test(token))) return null;

    const numericStart = tokens.findIndex(token => (
      digitFor(token) !== null
      || Object.prototype.hasOwnProperty.call(SMALL_NUMBERS, token)
      || Object.prototype.hasOwnProperty.call(TENS, token)
    ));
    if (numericStart === -1) return normalized.toUpperCase();
    if (numericStart <= 0) return null;

    const prefix = tokens.slice(0, numericStart);
    const suffix = tokens.slice(numericStart);
    const digitSuffix = suffix.map(digitFor);
    const number = digitSuffix.every(digit => digit !== null)
      ? digitSuffix.join('')
      : parseNumber(suffix.join(' '));
    if (number === null || number === '' || Number(number) > 999) return null;

    const callsign = `${prefix.join(' ').toUpperCase()} ${number}`;
    return callsign.length <= 20 ? callsign : null;
  }

  function normalizedCallsign(value) {
    return normalizeTranscript(callsignFor(value) || value);
  }

  function parseFieldValue(transcript, field) {
    if (field === 'heading' || field === 'runway' || field === 'inbound' || field === 'outbound') {
      const heading = parseCommandHeading(transcript);
      return heading === null ? null : { value: heading, unit: 'degrees' };
    }
    if (field === 'distance') {
      const value = boundedNumber(stripSuffix(transcript, ['nautical miles', 'nautical mile', 'nm']), 5, 50);
      return value === null ? null : { value, unit: 'nautical-miles' };
    }
    if (field === 'speed') {
      const value = boundedNumber(stripSuffix(transcript, ['knots', 'knot', 'kt']), 60, 600, { integer: true, step: 5 });
      return value === null ? null : { value, unit: 'knots' };
    }
    if (field === 'turn-rate') {
      const value = boundedNumber(stripSuffix(transcript, [
        'degrees per second', 'degree per second', 'degrees per sec', 'degree per sec', 'deg per second', 'deg per sec'
      ]), .5, 8, { step: .1 });
      return value === null ? null : { value, unit: 'degrees-per-second' };
    }
    if (field === 'level') {
      const value = boundedNumber(stripSuffix(transcript, ['feet', 'foot', 'ft']), 1000, 45000, { integer: true, step: 1000 });
      return value === null ? null : { value, unit: 'feet' };
    }
    return null;
  }

  function parseSetupField(transcript) {
    const headingField = transcript.match(/^set (runway orientation|runway|inbound track|final track|outbound track|assigned heading|heading) (.+)$/);
    if (headingField) {
      const fields = {
        'runway orientation': 'runway',
        runway: 'runway',
        'inbound track': 'inbound',
        'final track': 'inbound',
        'outbound track': 'outbound',
        'assigned heading': 'heading',
        heading: 'heading'
      };
      const field = fields[headingField[1]];
      const parsed = parseFieldValue(headingField[2], field);
      return parsed ? accept(transcript, 'set-field', { field, ...parsed }) : reject(transcript);
    }

    const numericField = transcript.match(/^set (initial distance|distance|ground speed|speed|rate of turn|turn rate) (.+)$/);
    if (!numericField) return null;
    const fields = {
      'initial distance': 'distance',
      distance: 'distance',
      'ground speed': 'speed',
      speed: 'speed',
      'rate of turn': 'turn-rate',
      'turn rate': 'turn-rate'
    };
    const field = fields[numericField[1]];
    const parsed = parseFieldValue(numericField[2], field);
    return parsed ? accept(transcript, 'set-field', { field, ...parsed }) : reject(transcript);
  }

  function parseTacticalAircraftField(transcript, options) {
    const callsignMatch = transcript.match(/^set aircraft (.+) callsign (.+)$/);
    if (callsignMatch) {
      const target = resolveAircraft(callsignMatch[1], options);
      if (!target.aircraft) return reject(transcript, target.reason);
      const callsign = callsignFor(callsignMatch[2]);
      return callsign
        ? accept(transcript, 'set-aircraft-callsign', { aircraft: target.aircraft, callsign })
        : reject(transcript);
    }

    const profileMatch = transcript.match(/^(?:set|select) aircraft (.+) profile (.+)$/);
    if (profileMatch) {
      const target = resolveAircraft(profileMatch[1], options);
      if (!target.aircraft) return reject(transcript, target.reason);
      const profile = profileFor(profileMatch[2], options);
      return profile ? accept(transcript, 'set-aircraft-profile', { aircraft: target.aircraft, profile }) : reject(transcript);
    }

    const match = transcript.match(/^set aircraft (.+) (speed|ground speed|range|distance|turn rate|rate of turn|level) (.+)$/);
    if (!match) return null;
    const target = resolveAircraft(match[1], options);
    if (!target.aircraft) return reject(transcript, target.reason);
    const fields = {
      speed: 'speed',
      'ground speed': 'speed',
      range: 'distance',
      distance: 'distance',
      'turn rate': 'turn-rate',
      'rate of turn': 'turn-rate',
      level: 'level'
    };
    const field = fields[match[2]];
    const parsed = parseFieldValue(match[3], field);
    return parsed ? accept(transcript, 'set-aircraft-field', { aircraft: target.aircraft, field, ...parsed }) : reject(transcript);
  }

  function parseReplaySpeed(transcript) {
    const match = transcript.match(/^set replay speed (.+)$/);
    if (!match) return null;
    const requested = /^\d+x$/.test(match[1])
      ? match[1].slice(0, -1)
      : stripSuffix(match[1], ['times', 'time', 'x']);
    const speed = boundedNumber(requested, 1, 10, { integer: true });
    return [1, 2, 3, 10].includes(speed)
      ? accept(transcript, 'set-replay-speed', { speed })
      : reject(transcript);
  }

  function parseCommand(value, options) {
    const transcript = normalizeTranscript(value);
    if (!transcript) return reject(transcript, 'empty-transcript');

    const headingTurn = transcript.match(/^turn (left|right)(?: to)? heading (.+)$/);
    if (headingTurn) {
      const heading = parseCommandHeading(headingTurn[2]);
      return heading === null
        ? reject(transcript)
        : accept(transcript, 'normal-turn-heading', { side: headingTurn[1], heading });
    }

    const tacticalHeadingTurn = transcript.match(/^(?:aircraft )?(.+?) turn (left|right)(?: to)? heading (.+)$/);
    if (tacticalHeadingTurn) {
      const target = resolveAircraft(tacticalHeadingTurn[1], options);
      const heading = parseCommandHeading(tacticalHeadingTurn[3]);
      if (!target.aircraft) return reject(transcript, target.reason);
      return heading === null
        ? reject(transcript)
        : accept(transcript, 'normal-turn-heading', { aircraft: target.aircraft, side: tacticalHeadingTurn[2], heading });
    }

    const exactCommands = {
      'turn left now': ['us-turn', { side: 'left' }],
      'turn right now': ['us-turn', { side: 'right' }],
      'stop turn now': ['us-turn-stop'],
      'report heading': ['report-heading'],
      'request distance': ['request-distance'],
      'report distance': ['request-distance'],
      'start clock': ['clock', { action: 'start' }],
      'start exercise clock': ['clock', { action: 'start' }],
      'stop clock': ['clock', { action: 'stop' }],
      'stop exercise clock': ['clock', { action: 'stop' }],
      'reset clock': ['clock', { action: 'reset' }],
      'reset exercise clock': ['clock', { action: 'reset' }],
      'advance flight': ['advance-flight', { seconds: 60 }],
      'advance flight one minute': ['advance-flight', { seconds: 60 }],
      'advance flight 1 minute': ['advance-flight', { seconds: 60 }],
      'advance flight by one minute': ['advance-flight', { seconds: 60 }],
      'advance flight by 1 minute': ['advance-flight', { seconds: 60 }],
      'terminate exercise': ['terminate-exercise'],
      'restart exercise': ['restart-exercise'],
      'replay track': ['replay-play'],
      'play replay': ['replay-play'],
      'resume replay': ['replay-play'],
      'pause replay': ['replay-pause'],
      'new exercise': ['new-exercise'],
      'return to console': ['return-console'],
      'confirm termination': ['confirm-termination'],
      'keep exercise': ['cancel-termination'],
      'cancel termination': ['cancel-termination'],
      'show controls': ['mobile-controls', { expanded: true }],
      'hide controls': ['mobile-controls', { expanded: false }],
      'enable zoom': ['review-zoom', { enabled: true }],
      'disable zoom': ['review-zoom', { enabled: false }],
      'zoom in': ['review-zoom-step', { direction: 'in' }],
      'zoom out': ['review-zoom-step', { direction: 'out' }],
      'pan left': ['review-pan', { direction: 'left' }],
      'pan right': ['review-pan', { direction: 'right' }],
      'pan up': ['review-pan', { direction: 'up' }],
      'pan down': ['review-pan', { direction: 'down' }],
      'fit track': ['fit-review'],
      'start simulator': ['start-exercise'],
      'start exercise': ['start-exercise'],
      'start tactical exercise': ['start-exercise'],
      'change qgh type': ['return-to-mode-selection'],
      'continuous listening on': ['set-listening-mode', { mode: 'continuous' }],
      'continuous listening off': ['set-listening-mode', { mode: 'push-to-talk' }],
      'press to talk mode': ['set-listening-mode', { mode: 'push-to-talk' }],
      'formation flight on': ['set-formation', { enabled: true }],
      'formation flight off': ['set-formation', { enabled: false }],
      'formation on': ['set-formation', { enabled: true }],
      'formation off': ['set-formation', { enabled: false }],
      'stop following leader': ['stop-following-leader']
    };
    if (Object.prototype.hasOwnProperty.call(exactCommands, transcript)) {
      const [intent, detail] = exactCommands[transcript];
      return accept(transcript, intent, detail);
    }

    const simulatorMode = transcript.match(/^(?:select|open) (single aircraft qgh|tactical qgh)$/);
    if (simulatorMode) {
      return accept(transcript, 'select-simulator-mode', {
        mode: simulatorMode[1] === 'tactical qgh' ? 'tactical' : 'single'
      });
    }

    const procedure = transcript.match(/^(?:select|set) (normal qgh|us compass)$/);
    if (procedure) {
      return accept(transcript, 'set-procedure', {
        procedure: procedure[1] === 'normal qgh' ? 'normal' : 'us'
      });
    }

    if (transcript === 'normal qgh' || transcript === 'us compass') {
      return accept(transcript, 'set-procedure', {
        procedure: transcript === 'normal qgh' ? 'normal' : 'us'
      });
    }

    const bearingMode = transcript.match(/^(?:select|set|show) (qdm|qte)(?: mode)?$/);
    if (bearingMode) return accept(transcript, 'set-bearing-mode', { mode: bearingMode[1] });

    const transmission = transcript.match(/^transmit(?: for)? (df|qdm|qte)(?: aircraft)?(?: (.+))?$/);
    if (transmission) {
      const detail = transmission[1] === 'df' ? {} : { mode: transmission[1] };
      if (!transmission[2]) return accept(transcript, 'transmit-df', detail);
      const target = resolveAircraft(transmission[2], options);
      return target.aircraft
        ? accept(transcript, 'transmit-df', { ...detail, aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const directAircraftTransmission = transcript.match(/^transmit aircraft (.+)$/);
    if (directAircraftTransmission) {
      const target = resolveAircraft(directAircraftTransmission[1], options);
      return target.aircraft
        ? accept(transcript, 'transmit-df', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const targetedUsTurn = transcript.match(/^(?:aircraft )?(.+?) turn (left|right) now$/);
    if (targetedUsTurn) {
      const target = resolveAircraft(targetedUsTurn[1], options);
      return target.aircraft
        ? accept(transcript, 'us-turn', { aircraft: target.aircraft, side: targetedUsTurn[2] })
        : reject(transcript, target.reason);
    }

    const targetedUsStop = transcript.match(/^(?:aircraft )?(.+?) stop turn now$/);
    if (targetedUsStop) {
      const target = resolveAircraft(targetedUsStop[1], options);
      return target.aircraft
        ? accept(transcript, 'us-turn-stop', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const targetedReport = transcript.match(/^report (heading|distance) (.+)$/);
    if (targetedReport) {
      const target = resolveAircraft(targetedReport[2], options);
      if (!target.aircraft) return reject(transcript, target.reason);
      return accept(transcript, targetedReport[1] === 'heading' ? 'report-heading' : 'request-distance', {
        aircraft: target.aircraft
      });
    }

    const targetedStopFollowing = transcript.match(/^stop following leader (.+)$/);
    if (targetedStopFollowing) {
      const target = resolveAircraft(targetedStopFollowing[1], options);
      return target.aircraft
        ? accept(transcript, 'stop-following-leader', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const replaySpeed = parseReplaySpeed(transcript);
    if (replaySpeed) return replaySpeed;

    const aircraftCount = transcript.match(/^(?:set aircraft count|select fleet of) (.+)$/);
    if (aircraftCount) {
      const count = boundedNumber(aircraftCount[1], 2, 4, { integer: true });
      return count === null ? reject(transcript) : accept(transcript, 'set-fleet-size', { count });
    }

    const shortAircraftCount = transcript.match(/^(two|three|four|2|3|4) aircraft$/);
    if (shortAircraftCount) {
      const count = boundedNumber(shortAircraftCount[1], 2, 4, { integer: true });
      return accept(transcript, 'set-fleet-size', { count });
    }

    const profile = transcript.match(/^(?:select|set) aircraft profile (.+)$/);
    if (profile) {
      const selected = profileFor(profile[1], options);
      return selected ? accept(transcript, 'set-aircraft-profile', { profile: selected }) : reject(transcript);
    }

    const tacticalField = parseTacticalAircraftField(transcript, options);
    if (tacticalField) return tacticalField;

    const formationLeader = transcript.match(/^select formation leader (.+)$/);
    if (formationLeader) {
      const target = resolveAircraft(formationLeader[1], options);
      return target.aircraft
        ? accept(transcript, 'set-formation-leader', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const formationMember = transcript.match(/^select formation member (.+)$/);
    if (formationMember) {
      const target = resolveAircraft(formationMember[1], options);
      return target.aircraft
        ? accept(transcript, 'toggle-formation-member', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    if (transcript === 'focus all aircraft') return accept(transcript, 'focus-all-aircraft');
    const focusAircraft = transcript.match(/^focus aircraft (.+)$/);
    if (focusAircraft) {
      const target = resolveAircraft(focusAircraft[1], options);
      return target.aircraft
        ? accept(transcript, 'focus-aircraft', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const aircraftSelection = transcript.match(/^select aircraft (.+)$/);
    if (aircraftSelection) {
      const target = resolveAircraft(aircraftSelection[1], options);
      return target.aircraft
        ? accept(transcript, 'select-aircraft', { aircraft: target.aircraft })
        : reject(transcript, target.reason);
    }

    const setupField = parseSetupField(transcript);
    if (setupField) return setupField;

    return reject(transcript);
  }

  return Object.freeze({
    normalizeTranscript,
    normaliseTranscript: normalizeTranscript,
    parseNumber,
    parseHeading,
    parseCommand
  });
});
