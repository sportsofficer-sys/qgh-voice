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
    const hasAlphabeticDesignator = normalized.split(' ').some(token => /^[a-z]{3,}$/.test(token));
    const abbreviated = hasAlphabeticDesignator
      ? callsignCandidates(options).filter(candidate => candidate.spoken.startsWith(normalized + ' '))
      : [];
    if (abbreviated.length === 1) return { aircraft: abbreviated[0].value };
    if (abbreviated.length > 1) return { reason: 'ambiguous-aircraft' };
    // Tactical voice control always names a configured callsign. A row number is not a
    // reliable RT target and must never be substituted for a callsign or a heading digit.
    return { reason: 'unknown-aircraft' };
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
    const spokenChunks = suffix.map(token => parseNumber(token));
    const cardinalNumber = parseNumber(suffix.join(' '));
    const number = digitSuffix.every(digit => digit !== null)
      ? digitSuffix.join('')
      : cardinalNumber !== null
        ? cardinalNumber
        // Controllers can naturally say a mixed callsign such as "twelve three".
        // When it is not a cardinal number, preserve each unambiguous spoken chunk.
        : spokenChunks.every(chunk => Number.isInteger(chunk)) ? spokenChunks.join('') : null;
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

  function parseStrictCommand(value, options) {
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

  // Flexible voice recognition is deliberately conservative. It accepts natural RT word order
  // and filler words only after the intent has every essential slot (for example: direction +
  // valid heading). A lone keyword must never move an aircraft or alter an exercise.
  const SEMANTIC_FILLERS = new Set([
    'a', 'an', 'and', 'can', 'could', 'do', 'it', 'kindly', 'please', 'the', 'this', 'that',
    'to', 'we', 'will', 'would', 'you', 'your'
  ]);
  const SEMANTIC_ALIASES = Object.freeze({
    begin: 'start', commence: 'start', launch: 'start', fresh: 'new',
    direct: 'turn', steer: 'turn', vector: 'turn',
    port: 'left', starboard: 'right',
    stopwatch: 'clock', timer: 'clock',
    approach: 'inbound', final: 'inbound', radial: 'track',
    bearing: 'df', range: 'distance',
    make: 'set', adjust: 'set', update: 'set',
    end: 'terminate', finish: 'terminate',
    faster: 'replay', slower: 'replay',
    view: 'track'
  });
  const CONFIRMATION_INTENTS = new Set([
    'new-exercise', 'restart-exercise', 'return-to-mode-selection', 'select-simulator-mode',
    'set-aircraft-callsign'
  ]);

  function semanticTokens(transcript) {
    return normalizeTranscript(transcript).split(' ')
      .filter(Boolean)
      .map(token => SEMANTIC_ALIASES[token] || token)
      .filter(token => !SEMANTIC_FILLERS.has(token));
  }

  function hasToken(tokens, ...candidates) {
    return candidates.some(candidate => tokens.includes(candidate));
  }

  function exactlyOneToken(tokens, candidates) {
    const matches = candidates.filter(candidate => tokens.includes(candidate));
    return matches.length === 1 ? matches[0] : null;
  }

  function firstTokenIndex(tokens, ...candidates) {
    const indexes = candidates.map(candidate => tokens.indexOf(candidate)).filter(index => index !== -1);
    return indexes.length ? Math.min(...indexes) : -1;
  }

  function numberFromTokens(tokens) {
    const normalized = tokens.join(' ').trim();
    if (!normalized) return null;
    return parseNumber(normalized);
  }

  function integerFromTokens(tokens, allowed) {
    const values = [];
    const permitted = new Set(allowed || []);
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= 4 && start + length <= tokens.length; length += 1) {
        const value = parseNumber(tokens.slice(start, start + length).join(' '));
        if (Number.isInteger(value) && permitted.has(value) && !values.includes(value)) values.push(value);
      }
    }
    return values.length === 1 ? values[0] : null;
  }

  function parseLooseHeading(value) {
    const normalized = normalizeTranscript(value);
    const strict = parseCommandHeading(normalized);
    if (strict !== null) return strict;
    if (/^\d{1,3}$/.test(normalized)) {
      const numeric = Number(normalized);
      return numeric >= 0 && numeric <= 360 ? numeric : null;
    }
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length === 2) {
      const hundred = digitFor(tokens[0]);
      const tens = TENS[tokens[1]];
      if (hundred !== null && Number.isFinite(tens)) {
        const heading = Number(hundred) * 100 + tens;
        return heading >= 0 && heading <= 360 ? heading : null;
      }
    }
    const cardinal = numberFromTokens(tokens);
    return Number.isInteger(cardinal) && cardinal >= 100 && cardinal <= 360 ? cardinal : null;
  }

  function valueFromTokens(tokens, field) {
    const candidates = [];
    const maximumTokens = Math.min(tokens.length, field === 'heading' ? 5 : 6);
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= maximumTokens && start + length <= tokens.length; length += 1) {
        const raw = tokens.slice(start, start + length).join(' ');
        const parsed = field === 'heading'
          ? (() => {
            const heading = parseLooseHeading(raw);
            return heading === null ? null : { value: heading, unit: 'degrees' };
          })()
          : parseFieldValue(raw, field);
        if (parsed) candidates.push({ ...parsed, length });
      }
    }
    if (!candidates.length) return null;
    // A spoken cardinal number contains valid shorter prefixes ("two hundred" within
    // "two hundred seventy"). Prefer the longest valid span rather than treating its
    // component as a competing controller value.
    const longest = Math.max(...candidates.map(candidate => candidate.length));
    const values = candidates.filter(candidate => candidate.length === longest)
      .filter((candidate, index, list) => list.findIndex(item => item.value === candidate.value) === index);
    return values.length === 1 ? { value: values[0].value, unit: values[0].unit } : null;
  }

  function semanticAccept(transcript, intent, detail, confidence) {
    const command = accept(transcript, intent, detail);
    command.match = 'semantic';
    command.confidence = confidence || 'high';
    if (CONFIRMATION_INTENTS.has(intent) || command.confidence === 'review') command.requiresConfirmation = true;
    return command;
  }

  const TARGET_ACTION_TOKENS = new Set([
    'turn', 'transmit', 'send', 'report', 'request', 'show', 'continue', 'maintain',
    'stop', 'break', 'select', 'focus', 'set', 'change', 'assign', 'add', 'remove',
    'include', 'exclude', 'formation'
  ]);

  function isNumericCallsignContinuation(token) {
    if (!token) return false;
    if (/^\d+$/.test(token)) return true;
    return Number.isFinite(parseNumber(token));
  }

  function exactAircraftMention(tokens, options) {
    const candidates = callsignCandidates(options);
    const exact = [];
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= 6 && start + length <= tokens.length; length += 1) {
        const phrase = tokens.slice(start, start + length).join(' ');
        const normalized = normalizedCallsign(phrase);
        const matches = candidates.filter(candidate => candidate.spoken === normalized);
        // Do not treat a configured numeric suffix as complete when the speaker continues
        // with another number. For example, "Raven Twelve Three" must not be routed to
        // configured "Raven Twelve" when "Raven 123" is not an aircraft in the exercise.
        if (matches.length === 1 && !isNumericCallsignContinuation(tokens[start + length])) {
          exact.push({ aircraft: matches[0].value, start, end: start + length });
        }
      }
    }

    const exactTargets = exact.filter((match, index, all) => (
      all.findIndex(candidate => candidate.aircraft === match.aircraft) === index
    ));
    if (exactTargets.length === 1) return exactTargets[0];
    if (exactTargets.length > 1) return null;

    // A shortened designator is allowed only when it is unique and immediately followed by
    // an RT action. This prevents "Raven 13" from being silently routed to "Raven 12".
    const abbreviated = [];
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= 5 && start + length < tokens.length; length += 1) {
        const normalized = normalizedCallsign(tokens.slice(start, start + length).join(' '));
        const hasAlphabeticDesignator = normalized.split(' ').some(token => /^[a-z]{3,}$/.test(token));
        if (!hasAlphabeticDesignator || !TARGET_ACTION_TOKENS.has(tokens[start + length])) continue;
        const matches = candidates.filter(candidate => candidate.spoken.startsWith(normalized + ' '));
        if (matches.length === 1) abbreviated.push({ aircraft: matches[0].value, start, end: start + length });
      }
    }
    const abbreviatedTargets = abbreviated.filter((match, index, all) => (
      all.findIndex(candidate => candidate.aircraft === match.aircraft) === index
    ));
    return abbreviatedTargets.length === 1 ? abbreviatedTargets[0] : null;
  }

  function hasUnresolvedCallsignAttempt(tokens, options) {
    const designators = new Set(callsignCandidates(options)
      .map(candidate => candidate.spoken.split(' ').find(token => /^[a-z]{3,}$/.test(token)))
      .filter(Boolean));
    return tokens.some(token => designators.has(token));
  }

  function valueAfter(tokens, anchors, field) {
    const index = firstTokenIndex(tokens, ...anchors);
    return index === -1 ? null : valueFromTokens(tokens.slice(index + 1), field);
  }

  function profileFromTokens(tokens, options) {
    for (let start = 0; start < tokens.length; start += 1) {
      const profile = profileFor(tokens.slice(start).join(' '), options);
      if (profile) return profile;
    }
    return null;
  }

  function fieldAnchor(tokens) {
    const anchors = [
      { terms: ['runway'], field: 'runway' },
      { terms: ['inbound'], field: 'inbound' },
      { terms: ['outbound'], field: 'outbound' },
      { terms: ['distance'], field: 'distance' },
      { terms: ['speed'], field: 'speed' },
      { terms: ['rate'], field: 'turn-rate' },
      { terms: ['level'], field: 'level' },
      { terms: ['heading'], field: 'heading' }
    ];
    for (const anchor of anchors) {
      const index = firstTokenIndex(tokens, ...anchor.terms);
      if (index !== -1) return { field: anchor.field, index };
    }
    return null;
  }

  function parseSemanticCommand(value, options) {
    const transcript = normalizeTranscript(value);
    if (!transcript) return null;
    const tokens = semanticTokens(transcript);
    if (!tokens.length) return null;
    const target = exactAircraftMention(tokens, options);
    if (!target && hasUnresolvedCallsignAttempt(tokens, options)) return null;
    const targetDetail = target ? { aircraft: target.aircraft } : {};
    const direction = hasToken(tokens, 'left') && !hasToken(tokens, 'right')
      ? 'left'
      : hasToken(tokens, 'right') && !hasToken(tokens, 'left') ? 'right' : null;

    if (tokens.length === 1 && (tokens[0] === 'qdm' || tokens[0] === 'qte')) {
      return semanticAccept(transcript, 'set-bearing-mode', { mode: tokens[0] });
    }

    if (hasToken(tokens, 'single') && hasToken(tokens, 'qgh') && hasToken(tokens, 'open', 'select', 'start')) {
      return semanticAccept(transcript, 'select-simulator-mode', { mode: 'single' }, 'high');
    }
    if (hasToken(tokens, 'tactical') && hasToken(tokens, 'qgh') && hasToken(tokens, 'open', 'select', 'start')) {
      return semanticAccept(transcript, 'select-simulator-mode', { mode: 'tactical' }, 'high');
    }
    if (hasToken(tokens, 'qgh') && hasToken(tokens, 'mode', 'type') && hasToken(tokens, 'change', 'set', 'return')) {
      return semanticAccept(transcript, 'return-to-mode-selection', {}, 'high');
    }
    const normalProcedure = hasToken(tokens, 'normal') && hasToken(tokens, 'qgh', 'mode');
    const usProcedure = hasToken(tokens, 'us') && hasToken(tokens, 'compass', 'mode');
    if (normalProcedure && usProcedure) return null;
    if (normalProcedure) {
      return semanticAccept(transcript, 'set-procedure', { procedure: 'normal' });
    }
    if (usProcedure) {
      return semanticAccept(transcript, 'set-procedure', { procedure: 'us' });
    }

    if (hasToken(tokens, 'confirm') && hasToken(tokens, 'voice', 'command', 'instruction')) {
      return semanticAccept(transcript, 'confirm-voice-command');
    }
    if (hasToken(tokens, 'cancel', 'reject', 'ignore') && hasToken(tokens, 'voice', 'command', 'instruction')) {
      return semanticAccept(transcript, 'cancel-voice-command');
    }

    const clockAction = exactlyOneToken(tokens, ['start', 'stop', 'reset']);
    if (hasToken(tokens, 'clock') && clockAction) {
      const action = clockAction;
      return semanticAccept(transcript, 'clock', { action });
    }
    if (hasToken(tokens, 'clock') && hasToken(tokens, 'start', 'stop', 'reset')) return null;
    if (hasToken(tokens, 'advance') && hasToken(tokens, 'flight', 'minute')) {
      return semanticAccept(transcript, 'advance-flight', { seconds: 60 });
    }
    if (hasToken(tokens, 'terminate') && hasToken(tokens, 'exercise', 'flight')) {
      return semanticAccept(transcript, 'terminate-exercise');
    }
    if (hasToken(tokens, 'restart') && hasToken(tokens, 'exercise', 'flight')) {
      return semanticAccept(transcript, 'restart-exercise');
    }
    if (hasToken(tokens, 'new') && hasToken(tokens, 'exercise', 'flight')) {
      return semanticAccept(transcript, 'new-exercise');
    }
    if (hasToken(tokens, 'start') && hasToken(tokens, 'simulator', 'exercise', 'tactical')) {
      return semanticAccept(transcript, 'start-exercise');
    }

    if (hasToken(tokens, 'replay') && hasToken(tokens, 'speed', 'times', 'time', 'x')) {
      const speed = integerFromTokens(tokens, [1, 2, 3, 10]);
      if ([1, 2, 3, 10].includes(speed)) return semanticAccept(transcript, 'set-replay-speed', { speed });
    }
    const replayPause = hasToken(tokens, 'pause', 'stop');
    const replayPlay = hasToken(tokens, 'play', 'resume', 'start');
    if (hasToken(tokens, 'replay', 'track') && replayPause && replayPlay) return null;
    if (hasToken(tokens, 'replay', 'track') && replayPause) {
      return semanticAccept(transcript, 'replay-pause');
    }
    if (hasToken(tokens, 'replay', 'track') && replayPlay) {
      return semanticAccept(transcript, 'replay-play');
    }
    const zoomEnabled = hasToken(tokens, 'enable', 'on');
    const zoomDisabled = hasToken(tokens, 'disable', 'off');
    if (hasToken(tokens, 'zoom') && zoomEnabled && zoomDisabled) return null;
    if (hasToken(tokens, 'zoom') && zoomEnabled) return semanticAccept(transcript, 'review-zoom', { enabled: true });
    if (hasToken(tokens, 'zoom') && zoomDisabled) return semanticAccept(transcript, 'review-zoom', { enabled: false });
    const zoomDirection = exactlyOneToken(tokens, ['in', 'out']);
    if (hasToken(tokens, 'zoom') && zoomDirection) {
      return semanticAccept(transcript, 'review-zoom-step', { direction: zoomDirection });
    }
    if (hasToken(tokens, 'pan', 'move')) {
      const panDirection = exactlyOneToken(tokens, ['left', 'right', 'up', 'down']);
      if (panDirection) return semanticAccept(transcript, 'review-pan', { direction: panDirection });
      if (hasToken(tokens, 'left', 'right', 'up', 'down')) return null;
    }
    if (hasToken(tokens, 'fit') && hasToken(tokens, 'track', 'all', 'view')) return semanticAccept(transcript, 'fit-review');
    if (hasToken(tokens, 'return') && hasToken(tokens, 'console')) return semanticAccept(transcript, 'return-console');

    if (hasToken(tokens, 'focus', 'show') && hasToken(tokens, 'all') && hasToken(tokens, 'aircraft')) {
      return semanticAccept(transcript, 'focus-all-aircraft');
    }
    if (target && hasToken(tokens, 'focus', 'show') && hasToken(tokens, 'track', 'aircraft')) {
      return semanticAccept(transcript, 'focus-aircraft', targetDetail);
    }
    if (target && hasToken(tokens, 'select')) return semanticAccept(transcript, 'select-aircraft', targetDetail);

    if (hasToken(tokens, 'formation')) {
      const formationEnabled = hasToken(tokens, 'on', 'enable', 'start');
      const formationDisabled = hasToken(tokens, 'off', 'disable', 'stop');
      if (formationEnabled && formationDisabled) return null;
      if (formationEnabled) return semanticAccept(transcript, 'set-formation', { enabled: true });
      if (formationDisabled) return semanticAccept(transcript, 'set-formation', { enabled: false });
      if (target && hasToken(tokens, 'leader')) return semanticAccept(transcript, 'set-formation-leader', targetDetail);
      if (target && hasToken(tokens, 'add', 'include')) return semanticAccept(transcript, 'set-formation-member', { ...targetDetail, enabled: true });
      if (target && hasToken(tokens, 'remove', 'exclude')) return semanticAccept(transcript, 'set-formation-member', { ...targetDetail, enabled: false });
    }
    if (target && hasToken(tokens, 'stop') && hasToken(tokens, 'following', 'formation', 'leader')) {
      return semanticAccept(transcript, 'stop-following-leader', targetDetail);
    }
    if (target && hasToken(tokens, 'break') && hasToken(tokens, 'formation')) {
      return semanticAccept(transcript, 'stop-following-leader', targetDetail);
    }

    const bearingMode = exactlyOneToken(tokens, ['qdm', 'qte']);
    if (hasToken(tokens, 'qdm', 'qte') && !bearingMode) return null;
    if (bearingMode && hasToken(tokens, 'show', 'select', 'set')) {
      return semanticAccept(transcript, 'set-bearing-mode', { mode: bearingMode });
    }
    if (hasToken(tokens, 'transmit', 'send') && (target || hasToken(tokens, 'df', 'qdm', 'qte'))) {
      const detail = { ...targetDetail };
      if (bearingMode === 'qdm' || bearingMode === 'qte') detail.mode = bearingMode;
      return semanticAccept(transcript, 'transmit-df', detail);
    }
    if (hasToken(tokens, 'report', 'request', 'show') && hasToken(tokens, 'heading')) {
      return semanticAccept(transcript, 'report-heading', targetDetail);
    }
    if (hasToken(tokens, 'report', 'request', 'show') && hasToken(tokens, 'distance')) {
      return semanticAccept(transcript, 'request-distance', targetDetail);
    }

    if (hasToken(tokens, 'continue', 'maintain') && !direction && !hasToken(tokens, 'speed', 'flight')) {
      const heading = valueAfter(tokens, ['continue', 'maintain'], 'heading');
      if (heading) return semanticAccept(transcript, 'continue-turn-heading', target ? { ...targetDetail, heading: heading.value } : { heading: heading.value });
    }
    if (hasToken(tokens, 'stop') && hasToken(tokens, 'turn') && !hasToken(tokens, 'heading')) {
      return target ? semanticAccept(transcript, 'us-turn-stop', targetDetail) : semanticAccept(transcript, 'us-turn-stop');
    }
    if (direction && hasToken(tokens, 'turn') && hasToken(tokens, 'now') && !hasToken(tokens, 'heading')) {
      const detail = target ? { ...targetDetail, side: direction } : { side: direction };
      return semanticAccept(transcript, 'us-turn', detail);
    }
    if (direction && (hasToken(tokens, 'turn', 'heading') || target)) {
      const heading = valueAfter(tokens, ['heading'], 'heading') || valueAfter(tokens, [direction], 'heading');
      if (heading) {
        const detail = target ? { ...targetDetail, side: direction, heading: heading.value } : { side: direction, heading: heading.value };
        return semanticAccept(transcript, 'normal-turn-heading', detail);
      }
    }
    // In tactical U/S Compass control a callsign is essential for a terse RT call
    // such as "Raven turn right". The page router still enforces the active procedure.
    if (target && direction && hasToken(tokens, 'turn')) {
      return semanticAccept(transcript, 'us-turn', { ...targetDetail, side: direction });
    }
    if (target && hasToken(tokens, 'stop') && hasToken(tokens, 'turn')) {
      return semanticAccept(transcript, 'us-turn-stop', targetDetail);
    }

    const callsignIndex = firstTokenIndex(tokens, 'callsign', 'rename');
    if (callsignIndex !== -1) {
      const reference = exactAircraftMention(tokens.slice(0, callsignIndex), options)
        || exactAircraftMention(tokens.slice(0, callsignIndex).filter(token => token !== 'aircraft'), options);
      const callsign = callsignFor(tokens.slice(callsignIndex + 1).join(' '));
      if (reference?.aircraft && callsign) {
        return semanticAccept(transcript, 'set-aircraft-callsign', { aircraft: reference.aircraft, callsign }, 'review');
      }
    }

    const profile = profileFromTokens(tokens, options);
    if (profile && hasToken(tokens, 'set', 'select', 'change')) {
      return target
        ? semanticAccept(transcript, 'set-aircraft-profile', { ...targetDetail, profile })
        : semanticAccept(transcript, 'set-aircraft-profile', { profile });
    }

    const anchor = fieldAnchor(tokens);
    if (anchor && anchor.field !== 'heading' && hasToken(tokens, 'set', 'change', 'assign')) {
      const fieldTokens = tokens.slice(anchor.index + 1);
      const parsed = valueFromTokens(fieldTokens, anchor.field);
      if (parsed) {
        if (target && ['speed', 'distance', 'turn-rate', 'level'].includes(anchor.field)) {
          return semanticAccept(transcript, 'set-aircraft-field', { ...targetDetail, field: anchor.field, ...parsed });
        }
        return semanticAccept(transcript, 'set-field', { field: anchor.field, ...parsed });
      }
    }

    if (hasToken(tokens, 'fleet', 'aircraft') && hasToken(tokens, 'set', 'select', 'choose')) {
      const count = integerFromTokens(tokens, [2, 3, 4]);
      if ([2, 3, 4].includes(count)) return semanticAccept(transcript, 'set-fleet-size', { count });
    }

    if (hasToken(tokens, 'controls') && hasToken(tokens, 'show', 'open')) return semanticAccept(transcript, 'mobile-controls', { expanded: true });
    if (hasToken(tokens, 'controls') && hasToken(tokens, 'hide', 'close')) return semanticAccept(transcript, 'mobile-controls', { expanded: false });
    const continuousEnabled = hasToken(tokens, 'on', 'start', 'enable');
    const continuousDisabled = hasToken(tokens, 'off', 'stop', 'disable');
    if (hasToken(tokens, 'continuous') && continuousEnabled && continuousDisabled) return null;
    if (hasToken(tokens, 'continuous') && continuousEnabled) return semanticAccept(transcript, 'set-listening-mode', { mode: 'continuous' });
    if (hasToken(tokens, 'continuous') && continuousDisabled) return semanticAccept(transcript, 'set-listening-mode', { mode: 'push-to-talk' });
    if (hasToken(tokens, 'press') && hasToken(tokens, 'talk', 'ptt')) return semanticAccept(transcript, 'set-listening-mode', { mode: 'push-to-talk' });

    return null;
  }

  function parseCommand(value, options) {
    const strict = parseStrictCommand(value, options);
    if (strict.accepted) return strict;
    // A strict parser can distinguish an unknown or ambiguous callsign. Never let a
    // permissive semantic pass reinterpret a rejected aircraft target as a different one.
    const semantic = parseSemanticCommand(value, options);
    if (strict.reason === 'ambiguous-aircraft') return strict;
    if (strict.reason === 'unknown-aircraft') {
      // Natural lead-ins such as "would you" can make the rigid grammar think it saw an
      // aircraft. Allow the semantic result only when it independently resolved a configured
      // callsign, or when every word before the first RT action is a recognized filler.
      if (!semantic?.accepted) return strict;
      if (semantic.aircraft) return semantic;
      const rawTokens = normalizeTranscript(value).split(' ').filter(Boolean);
      const actionIndex = rawTokens.findIndex(token => TARGET_ACTION_TOKENS.has(SEMANTIC_ALIASES[token] || token));
      const onlyFillersBeforeAction = actionIndex > 0 && rawTokens.slice(0, actionIndex)
        .every(token => SEMANTIC_FILLERS.has(SEMANTIC_ALIASES[token] || token));
      return onlyFillersBeforeAction ? semantic : strict;
    }
    return semantic || strict;
  }

  function requiresVoiceConfirmation(command) {
    return Boolean(command?.requiresConfirmation || CONFIRMATION_INTENTS.has(command?.intent));
  }

  function describeCommand(command) {
    if (!command?.accepted) return 'COMMAND NOT RECOGNISED';
    const target = command.aircraft ? `${String(command.aircraft).toUpperCase()} · ` : '';
    if (command.intent === 'normal-turn-heading') return `${target}TURN ${String(command.side || '').toUpperCase()} HEADING ${String(command.heading).padStart(3, '0')}`;
    if (command.intent === 'us-turn') return `${target}TURN ${String(command.side || '').toUpperCase()} NOW`;
    if (command.intent === 'set-field' || command.intent === 'set-aircraft-field') return `${target}${String(command.field || '').toUpperCase()} ${command.value}`;
    if (command.intent === 'set-replay-speed') return `REPLAY SPEED ${command.speed}×`;
    if (command.intent === 'set-bearing-mode') return String(command.mode || '').toUpperCase();
    return `${target}${String(command.intent || '').replace(/-/g, ' ').toUpperCase()}`;
  }

  return Object.freeze({
    normalizeTranscript,
    normaliseTranscript: normalizeTranscript,
    parseNumber,
    parseHeading,
    parseCommand,
    requiresVoiceConfirmation,
    describeCommand
  });
});
