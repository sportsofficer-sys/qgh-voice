(function exposeQghOfflineVoiceEngine(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QGHOfflineVoiceEngine = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function createQghOfflineVoiceEngine(root) {
  'use strict';

  // This adapter owns only local microphone capture and Vosk WebAssembly. It deliberately
  // exposes final text to the workspace; the local voice command parser remains the
  // authority that decides whether a simulator control may be activated.
  const MODEL_FILE = 'voice-models/qgh-vosk-en-us-small-0.15.tar.gz';
  const MODEL_CACHE = 'qgh-offline-voice-pack-v1';
  const MODEL_SIZE_BYTES = 41160778;
  // Vosk returns the last decoded phrase asynchronously after PTT is released.
  // Keep the recognizer alive until that result arrives; this is only a failsafe
  // for a device or worker that never replies, not the normal completion path.
  const FINAL_RESULT_TIMEOUT_MS = 5000;
  const MAX_ANDROID_GRAMMAR_PHRASES = 11_999;
  const MAX_ANDROID_GRAMMAR_BYTES = 490_000;
  const AVIATION_DIGITS = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];
  const STATIC_COMMANDS = [
    'select single aircraft qgh', 'open single aircraft qgh', 'select tactical qgh', 'open tactical qgh',
    'select normal qgh', 'set normal qgh', 'normal qgh', 'select us compass', 'set us compass', 'us compass',
    'select qdm', 'set qdm', 'show qdm', 'select qte', 'set qte', 'show qte',
    'transmit df', 'transmit for df', 'transmit d f', 'transmit for d f',
    'transmit direction finding', 'transmit for direction finding',
    'send df', 'send for df', 'send d f', 'send for d f', 'send direction finding', 'send for direction finding',
    'transmit qdm', 'transmit for qdm', 'transmit qte', 'transmit for qte',
    'turn left now', 'turn right now', 'stop turn now', 'report heading', 'request distance', 'report distance',
    'start clock', 'stop clock', 'reset clock', 'start exercise clock', 'stop exercise clock', 'reset exercise clock',
    'advance flight', 'advance flight one minute', 'advance flight by one minute', 'terminate exercise',
    'confirm termination', 'keep exercise', 'cancel termination', 'restart exercise', 'new exercise',
    'start simulator', 'start exercise', 'start tactical exercise', 'change qgh type',
    'continuous listening on', 'continuous listening off', 'press to talk mode',
    'replay track', 'play replay', 'resume replay', 'pause replay', 'return to console',
    'show controls', 'hide controls', 'enable zoom', 'disable zoom', 'zoom in', 'zoom out',
    'pan left', 'pan right', 'pan up', 'pan down', 'fit track', 'focus all aircraft',
    'formation flight on', 'formation flight off', 'formation on', 'formation off', 'stop following leader'
  ];
  let staticGrammar = null;
  const recognitionPlanCache = new Map();
  const MAX_RECOGNITION_PLANS = 16;

  function documentRef() {
    return root.document || null;
  }

  function assetUrl(relativePath) {
    const currentScript = documentRef()?.currentScript;
    const source = currentScript?.src || root.location?.href || '';
    try { return new URL(relativePath, source).href; } catch { return relativePath; }
  }

  function modelUrl() {
    return assetUrl(MODEL_FILE);
  }

  function phraseForHeading(value) {
    const heading = Math.max(0, Math.min(360, Math.round(Number(value) || 0)));
    return String(heading).padStart(3, '0').split('').map(digit => AVIATION_DIGITS[Number(digit)]).join(' ');
  }

  function phraseForDigits(value) {
    return String(value || '').replace(/\D/g, '').split('')
      .map(digit => AVIATION_DIGITS[Number(digit)]).join(' ');
  }

  function phraseForCardinal(value) {
    const number = Math.round(Number(value));
    if (!Number.isInteger(number) || number < 0 || number > 999) return '';
    const small = [
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
      'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
      'eighteen', 'nineteen'
    ];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    if (number < 20) return small[number];
    if (number < 100) return `${tens[Math.floor(number / 10)]}${number % 10 ? ` ${small[number % 10]}` : ''}`;
    const remainder = number % 100;
    return `${small[Math.floor(number / 100)]} hundred${remainder ? ` ${phraseForCardinal(remainder)}` : ''}`;
  }

  function callsignVariants(value, options) {
    const callsign = String(value?.callsign || value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!callsign) return [];
    const variants = new Set([callsign]);
    const numeric = callsign.match(/^(.*?)(\d{1,3})$/);
    if (numeric) {
      const prefix = numeric[1].trim();
      const cardinal = phraseForCardinal(Number(numeric[2]));
      if (cardinal) variants.add(`${prefix ? `${prefix} ` : ''}${cardinal}`);
      if (options?.includeDigitWords) {
        const digits = phraseForDigits(numeric[2]);
        if (digits) variants.add(`${prefix ? `${prefix} ` : ''}${digits}`);
      }
    }
    return [...variants];
  }

  function plainDigitCallsignVariant(value) {
    const callsign = String(value?.callsign || value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const numeric = callsign.match(/^(\d{1,3})$/);
    if (!numeric) return '';
    const digits = phraseForDigits(numeric[1])
      .replace(/\btree\b/g, 'three').replace(/\bfife\b/g, 'five').replace(/\bniner\b/g, 'nine');
    return digits;
  }

  function callsignDesignator(value) {
    const callsign = String(value?.callsign || value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return callsign.replace(/\s+\d{1,3}$/, '') || callsign;
  }

  function addPhrases(target, phrases) {
    phrases.forEach(phrase => {
      const normalized = String(phrase || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (normalized) target.add(normalized);
    });
  }

  function staticGrammarPhrases() {
    if (staticGrammar) return staticGrammar;
    const phrases = new Set();
    addPhrases(phrases, STATIC_COMMANDS);

    staticGrammar = Object.freeze([...phrases]);
    return staticGrammar;
  }

  function grammarScreen(context, callsigns) {
    const requested = String(context?.screen || context?.scope || context?.page || '').trim().toLowerCase();
    if (requested.includes('tactical')) {
      if (requested.includes('analysis')) return 'tactical:analysis';
      if (requested.includes('setup')) return 'tactical:setup';
      return 'tactical:console';
    }
    if (requested.includes('single')) {
      if (requested.includes('analysis')) return 'single:analysis';
      if (requested.includes('setup')) return 'single:setup';
      return 'single:console';
    }
    if (requested.includes('entry')) return 'entry';
    return callsigns.length ? 'tactical:console' : 'single:console';
  }

  function grammarScope(screen) {
    return screen.startsWith('tactical:') ? 'tactical' : 'single';
  }

  function isExerciseScreen(screen) {
    return screen === 'single:console' || screen === 'tactical:console';
  }

  function headingAliases(rawCallsign, allCallsigns, compactMode) {
    const designator = callsignDesignator(rawCallsign);
    const designatorCount = allCallsigns.filter(candidate => callsignDesignator(candidate) === designator).length;
    const numericOnly = /^\d{3}$/.test(String(rawCallsign?.callsign || rawCallsign || '').trim());
    // A unique designator is the concise RT form the parser accepts. When two aircraft share
    // one designator, grammar phrases must carry a complete callsign so routing stays exact.
    if (designatorCount === 1 && !numericOnly) return [designator];
    const preserveLeadingZeros = /\s0\d{1,2}$/.test(String(rawCallsign?.callsign || rawCallsign || ''));
    const variants = callsignVariants(rawCallsign, {
      includeDigitWords: numericOnly || compactMode === 'digits' || Boolean(compactMode && preserveLeadingZeros)
    });
    return compactMode ? variants.slice(-1) : variants;
  }

  function addSingleExerciseHeadings(phrases) {
    for (let heading = 0; heading <= 360; heading += 1) {
      const spoken = phraseForHeading(heading);
      addPhrases(phrases, [
        `turn left heading ${spoken}`, `turn right heading ${spoken}`,
        `turn left ${spoken}`, `turn right ${spoken}`,
        `continue ${spoken}`
      ]);
    }
  }

  function addTacticalExerciseHeadings(phrases, callsigns) {
    const aliases = callsigns.flatMap(rawCallsign => headingAliases(rawCallsign, callsigns));
    aliases.forEach(callsign => {
      addPhrases(phrases, [`${callsign} turn left now`, `${callsign} turn right now`, `${callsign} stop turn now`]);
    });
    // Keep the two Normal turn phrasings together. If expanded callsign aliases exceed
    // Android's limits, use one complete spoken callsign per shared designator instead.
    // Digit words provide a shorter fallback for long cardinal suffixes such as 999.
    const hasStandaloneNumeric = callsigns.some(callsign => /^\d{3}$/.test(String(callsign || '').trim()));
    const compactModes = hasStandaloneNumeric ? [null, 'digits', 'cardinal'] : [null, 'cardinal', 'digits'];
    for (const compactMode of compactModes) {
      const candidate = new Set(phrases);
      const headingCallsigns = callsigns.flatMap(rawCallsign => headingAliases(rawCallsign, callsigns, compactMode));
      headingCallsigns.forEach(callsign => {
        for (let heading = 0; heading <= 360; heading += 1) {
          const spoken = phraseForHeading(heading);
          addPhrases(candidate, [
            `${callsign} turn left ${spoken}`, `${callsign} turn right ${spoken}`,
            `${callsign} turn left heading ${spoken}`, `${callsign} turn right heading ${spoken}`,
            `${callsign} continue ${spoken}`
          ]);
        }
        addPhrases(candidate, [`${callsign} turn left now`, `${callsign} turn right now`, `${callsign} stop turn now`]);
      });
      if (withinAndroidGrammarLimits([...candidate])) {
        addPhrases(phrases, [...candidate]);
        return;
      }
    }
  }

  function withinAndroidGrammarLimits(grammar) {
    return grammar.length <= MAX_ANDROID_GRAMMAR_PHRASES
      && JSON.stringify(grammar).length <= MAX_ANDROID_GRAMMAR_BYTES;
  }

  function safeFallbackGrammar() {
    const fallback = new Set(staticGrammarPhrases());
    fallback.add('[unk]');
    return [...fallback];
  }

  function grammarProcedure(context) {
    const requested = String(context?.procedure || context?.mode || '').trim().toLowerCase();
    return requested === 'us' || requested.includes('u/s') || requested.includes('unserviceable')
      ? 'us' : 'normal';
  }

  function recognitionPlanContext(context) {
    const callsigns = (Array.isArray(context?.callsigns) ? context.callsigns : [])
      .map(raw => String(raw?.callsign || raw || '').trim().toLowerCase())
      .filter(Boolean);
    const screen = grammarScreen(context, callsigns);
    const scope = grammarScope(screen);
    const procedure = grammarProcedure(context);
    // Callsigns only alter an exercise grammar. Keeping them out of every other
    // cache key avoids rebuilding a large grammar while a user edits setup fields.
    const activeCallsigns = isExerciseScreen(screen) ? callsigns : [];
    return { screen, scope, procedure, callsigns: activeCallsigns,
      cacheKey: [screen, procedure, ...activeCallsigns].join('\u0000') };
  }

  function buildGrammar(context) {
    const details = recognitionPlanContext(context);
    const { screen, scope, procedure, callsigns } = details;

    // Keep the recognizer's local bias aligned to the visible console.  U/S
    // Compass has no heading display/control, so do not spend recognition
    // budget on an unavailable report-heading call.
    const phrases = new Set(staticGrammarPhrases().filter(phrase => !(
      isExerciseScreen(screen) && procedure === 'us' && /^report heading$/.test(phrase)
    )));

    if (isExerciseScreen(screen)) callsigns.forEach(rawCallsign => {
      const variants = callsignVariants(rawCallsign, { includeDigitWords: true });
      const plainDigits = plainDigitCallsignVariant(rawCallsign);
      if (plainDigits) variants.push(plainDigits);
      if (scope === 'single') variants.push(callsignDesignator(rawCallsign));
      new Set(variants).forEach(callsign => {
        const transmitPhrases = [
          'transmit df', 'transmit for df', 'transmit d f', 'transmit for d f',
          'transmit direction finding', 'transmit for direction finding',
          'send df', 'send for df', 'send d f', 'send for d f', 'send direction finding', 'send for direction finding'
        ];
        addPhrases(phrases, [
          `select aircraft ${callsign}`, `transmit aircraft ${callsign}`,
          `transmit qdm ${callsign}`, `transmit qte ${callsign}`,
          ...(procedure === 'normal' ? [`report heading ${callsign}`] : []), `report distance ${callsign}`,
          ...(scope === 'single' ? [
            ...(procedure === 'normal' ? [`${callsign} report heading`] : []), `${callsign} report distance`,
            `${callsign} turn left now`, `${callsign} turn right now`, `${callsign} stop turn now`] : []),
          `select formation leader ${callsign}`, `select formation member ${callsign}`,
          `stop following leader ${callsign}`, `focus aircraft ${callsign}`,
          ...transmitPhrases.flatMap(phrase => [`${phrase} ${callsign}`, `${callsign} ${phrase}`])
        ]);
      });
    });

    // Vosk uses these examples as a language-model bias, not an exact whitelist.
    // Unknown output and whole-message intent must still be checked by the parser.
    phrases.add('[unk]');
    if (isExerciseScreen(screen)) {
      addPhrases(phrases, ['orbit left', 'orbit right', 'left hand orbit', 'right hand orbit', 'continue orbit', 'resume normal']);
    }
    if (isExerciseScreen(screen) && procedure === 'normal') {
      // Vosk's compositional language model already contains all heading digits.
      // Reserve the new word-order/callsign transitions before optional aliases
      // consume the budget; the parser validates every resulting 000–360 value.
      const prefixes = scope === 'single' ? [''] : [];
      callsigns.forEach(callsign => headingAliases(callsign, callsigns, 'digits').forEach(alias => prefixes.push(`${alias} `)));
      prefixes.forEach(prefix => addPhrases(phrases, [
        `${prefix}report heading passing tree two fife`,
        `${prefix}report passing heading zero niner zero`,
        `${prefix}report passing two four zero`
      ]));
    }
    // Add headings after the other commands so the tactical alias budget accounts for
    // the entire grammar. They are relevant only during a Normal QGH exercise.
    if (isExerciseScreen(screen) && procedure === 'normal') {
      if (scope === 'tactical') addTacticalExerciseHeadings(phrases, callsigns);
      else {
        addSingleExerciseHeadings(phrases);
        if (callsigns.length) {
          addTacticalExerciseHeadings(phrases, callsigns);
          // Add the full digit-spoken callsign as well as the concise designator,
          // without letting longer custom callsigns exhaust the offline grammar budget.
          for (const full of callsignVariants(callsigns[0], { includeDigitWords: true }).reverse()) {
            const candidate = new Set(phrases);
            for (let heading = 0; heading <= 360; heading += 1) {
              const spoken = phraseForHeading(heading);
              addPhrases(candidate, [`${full} turn left ${spoken}`, `${full} turn right ${spoken}`,
                `${full} turn left heading ${spoken}`, `${full} turn right heading ${spoken}`, `${full} continue ${spoken}`]);
            }
            if (withinAndroidGrammarLimits([...candidate])) addPhrases(phrases, [...candidate]);
          }
        }
      }
    }
    if (isExerciseScreen(screen)) {
      const radio = root.QGHRadioSession || (typeof module === 'object' && module.exports ? require('./radio-session.js') : null);
      const examples = (radio?.GRAMMAR_EXAMPLES || []).filter(phrase => (
        procedure !== 'us' || !/\b(?:heading|passing)\b/i.test(phrase)
      ));
      const additional = [...examples];
      callsigns.forEach(callsign => headingAliases(callsign, callsigns, 'digits').forEach(alias =>
        additional.unshift(...['orbit left', 'orbit right', 'left hand orbit', 'right hand orbit', 'continue orbit', 'continue', 'resume normal'].map(phrase => `${alias} ${phrase}`))));
      callsigns.forEach(callsign => headingAliases(callsign, callsigns).forEach(alias =>
        additional.push(...examples.map(phrase => `${alias} ${phrase}`))));
      // Flight-control phrases retain priority if unusually long callsigns fill
      // the native bridge budget. Never replace working heading commands with RT.
      let grammarLength = JSON.stringify([...phrases]).length;
      for (const phrase of additional) {
        const nextLength = grammarLength + JSON.stringify(phrase).length + (phrases.size ? 1 : 0);
        if (!phrases.has(phrase) && phrases.size < MAX_ANDROID_GRAMMAR_PHRASES && nextLength < MAX_ANDROID_GRAMMAR_BYTES) {
          phrases.add(phrase);
          grammarLength = nextLength;
        }
      }
    }
    const grammar = [...phrases];
    // Android rejects oversize JSON grammars by replacing them with [unk]. A conservative
    // fallback keeps core on-device commands available instead of silently disabling voice.
    return Object.freeze(withinAndroidGrammarLimits(grammar) ? grammar : safeFallbackGrammar());
  }

  function cacheRecognitionPlan(details, grammar) {
    const plan = Object.freeze({
      screen: details.screen,
      scope: details.scope,
      procedure: details.procedure,
      grammar,
      grammarJson: JSON.stringify(grammar)
    });
    recognitionPlanCache.set(details.cacheKey, plan);
    if (recognitionPlanCache.size > MAX_RECOGNITION_PLANS) {
      const oldestKey = recognitionPlanCache.keys().next().value;
      recognitionPlanCache.delete(oldestKey);
    }
    return plan;
  }

  function buildQghGrammar(context) {
    return buildRecognitionPlan(context).grammar;
  }

  // A small offline model is substantially more dependable with an RT command grammar than
  // with unrestricted dictation. The semantic parser still handles the accepted wording,
  // while this grammar contains the operational variants that give Vosk a reliable target.
  function buildRecognitionPlan(context) {
    const details = recognitionPlanContext(context);
    const cached = recognitionPlanCache.get(details.cacheKey);
    if (cached) return cached;
    return cacheRecognitionPlan(details, buildGrammar(context));
  }

  function supportsOfflineVoice() {
    const AudioContext = root.AudioContext || root.webkitAudioContext;
    return Boolean(
      root.Vosk && typeof root.Vosk.createModel === 'function'
      && root.navigator?.mediaDevices?.getUserMedia
      && typeof AudioContext === 'function'
      && typeof root.Worker === 'function'
    );
  }

  function canCacheArchive() {
    const protocol = root.location?.protocol || '';
    return (protocol === 'https:' || protocol === 'http:')
      && typeof root.caches?.open === 'function'
      && typeof root.fetch === 'function';
  }

  async function cacheArchive(onProgress) {
    if (!canCacheArchive()) return false;
    const url = modelUrl();
    const request = new Request(url, { credentials: 'same-origin' });
    const cache = await root.caches.open(MODEL_CACHE);
    if (await cache.match(request)) {
      onProgress?.({ phase: 'cached', loaded: MODEL_SIZE_BYTES, total: MODEL_SIZE_BYTES });
      return true;
    }

    const response = await root.fetch(request, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok || !response.body) throw new Error('offline voice pack could not be downloaded');
    const total = Number(response.headers.get('content-length')) || MODEL_SIZE_BYTES;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      loaded += part.value.byteLength;
      onProgress?.({ phase: 'downloading', loaded, total });
    }
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/gzip');
    await cache.put(request, new Response(new Blob(chunks, { type: 'application/gzip' }), { headers }));
    onProgress?.({ phase: 'cached', loaded: total, total });
    return true;
  }

  async function hasCachedArchive() {
    if (!canCacheArchive()) return false;
    try {
      const cache = await root.caches.open(MODEL_CACHE);
      const request = new Request(modelUrl(), { credentials: 'same-origin' });
      return Boolean(await cache.match(request));
    } catch {
      return false;
    }
  }

  function transcriptFrom(result) {
    const text = result?.result?.text;
    return typeof text === 'string' && text.trim() && text.trim() !== '[unk]' ? text.trim() : '';
  }

  class OfflineVoiceSession {
    constructor(options) {
      this.options = options || {};
      this.model = null;
      this.modelPromise = null;
      this.stream = null;
      this.audioContext = null;
      this.source = null;
      this.processor = null;
      this.silentGain = null;
      this.recognizer = null;
      this.listening = false;
      this.ending = false;
      this.ended = false;
      this.finalizeTimer = null;
      this.audioUnlockPromise = null;
      this.callbacks = null;
      this.awaitingFinalResult = false;
      this.hasFinalResult = false;
      this.noResultReported = false;
    }

    isReady() { return Boolean(this.model); }
    isFinalizing() { return Boolean(this.listening && this.ending); }

    async prepare(onProgress) {
      if (this.model) return this.model;
      if (this.modelPromise) return this.modelPromise;
      if (!supportsOfflineVoice()) throw new Error('offline voice is not supported in this runtime');
      const task = (async () => {
        onProgress?.({ phase: 'preparing', loaded: 0, total: MODEL_SIZE_BYTES });
        await cacheArchive(onProgress);
        this.model = await root.Vosk.createModel(modelUrl());
        onProgress?.({ phase: 'ready', loaded: MODEL_SIZE_BYTES, total: MODEL_SIZE_BYTES });
        return this.model;
      })();
      this.modelPromise = task;
      try { return await task; } finally { if (this.modelPromise === task) this.modelPromise = null; }
    }

    // This is intentionally synchronous up to the `resume()` call. Browser user
    // activation can expire while an async microphone permission prompt is open;
    // priming from the PTT event keeps the audio processing graph eligible to run.
    primeAudio() {
      if (this.audioContext) return this.audioUnlockPromise || Promise.resolve(this.audioContext);
      const AudioContext = root.AudioContext || root.webkitAudioContext;
      if (typeof AudioContext !== 'function') return Promise.reject(new Error('audio context is unavailable'));

      let audioContext;
      try {
        audioContext = new AudioContext();
      } catch (error) {
        return Promise.reject(error);
      }
      this.audioContext = audioContext;

      let resume;
      try {
        resume = audioContext.resume?.();
      } catch (error) {
        resume = Promise.reject(error);
      }
      this.audioUnlockPromise = Promise.resolve(resume).then(() => {
        if (audioContext.state && audioContext.state !== 'running') {
          throw new Error('audio context is suspended');
        }
        return audioContext;
      }).catch(error => {
        this.discardAudioContext(audioContext);
        throw error;
      });
      return this.audioUnlockPromise;
    }

    discardAudioContext(audioContext) {
      if (!audioContext) return;
      if (this.audioContext === audioContext) {
        this.audioContext = null;
        this.audioUnlockPromise = null;
      }
      try {
        const closed = audioContext.close?.();
        closed?.catch?.(() => {});
      } catch { /* Best effort cleanup for a blocked context. */ }
    }

    // A PTT gesture primes audio before model readiness is known. If startup is abandoned
    // before capture begins, release that user-activated context immediately.
    releasePrimedAudio() {
      if (this.listening || this.ending || !this.audioContext) return false;
      this.discardAudioContext(this.audioContext);
      return true;
    }

    async start(options) {
      // PTT can be pressed again before a slow worker posts the previous final result.
      // Retire that stale result without sending its lifecycle callbacks into the new press.
      const replacedPendingFinalResult = this.replacePendingFinalResult();
      if (this.listening) return Object.freeze({ started: true, replacedPendingFinalResult });
      const settings = options || {};
      let audioContext;
      try {
        audioContext = await this.primeAudio();
      } catch (error) {
        this.discardAudioContext(this.audioContext);
        settings.onError?.('audio-suspended');
        throw error;
      }

      let model;
      try {
        model = await this.prepare(settings.onProgress);
      } catch (error) {
        this.discardAudioContext(audioContext);
        throw error;
      }
      if (this.audioContext !== audioContext) return Object.freeze({ started: false, replacedPendingFinalResult });

      let stream;
      try {
        stream = await root.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false
        });
      } catch (error) {
        this.discardAudioContext(audioContext);
        settings.onError?.(error?.name === 'NotAllowedError' ? 'not-allowed' : 'unavailable');
        throw error;
      }
      if (this.audioContext !== audioContext) {
        stream.getTracks().forEach(track => track.stop());
        return Object.freeze({ started: false, replacedPendingFinalResult });
      }

      const grammar = Array.isArray(settings.grammar) && settings.grammar.length
        ? JSON.stringify(settings.grammar)
        : undefined;
      let recognizer;
      try {
        recognizer = new model.KaldiRecognizer(audioContext.sampleRate, grammar);
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        this.discardAudioContext(audioContext);
        settings.onError?.('unavailable');
        throw error;
      }

      this.stream = stream;
      this.audioContext = audioContext;
      this.recognizer = recognizer;
      this.listening = true;
      this.ending = false;
      this.ended = false;
      this.callbacks = settings;
      this.awaitingFinalResult = false;
      this.hasFinalResult = false;
      this.noResultReported = false;
      recognizer.on('result', message => {
        // A late worker message from a retired recognizer must never affect a
        // subsequent PTT press on the same session object.
        if (this.recognizer !== recognizer) return;
        const shouldFinish = this.ending;
        try {
          const transcript = transcriptFrom(message);
          if (transcript) {
            this.hasFinalResult = true;
            settings.onResult?.(transcript);
          } else if (shouldFinish) {
            this.reportNoResult();
          }
        } finally {
          // `retrieveFinalResult()` delivers through this same event channel.
          // Do not remove the recognizer before the worker has posted it.
          if (shouldFinish) this.finish();
        }
      });
      recognizer.on('partialresult', message => {
        if (!this.ending) settings.onPartial?.(String(message?.result?.partial || '').trim());
      });

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processor.onaudioprocess = event => {
        if (!this.listening || this.ending) return;
        try {
          recognizer.acceptWaveform(event.inputBuffer);
        } catch {
          settings.onError?.('unavailable');
          this.finish();
        }
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      this.source = source;
      this.processor = processor;
      this.silentGain = silentGain;
      stream.getTracks().forEach(track => track.addEventListener?.('ended', () => this.finish(), { once: true }));
      settings.onStarted?.();
      return Object.freeze({ started: true, replacedPendingFinalResult });
    }

    reportNoResult() {
      if (this.noResultReported || this.hasFinalResult) return;
      this.noResultReported = true;
      try { this.callbacks?.onNoResult?.(); } catch { /* A status update must not block cleanup. */ }
    }

    disconnectAudioInput() {
      try { this.processor?.disconnect(); } catch { /* Best effort. */ }
      try { this.source?.disconnect(); } catch { /* Best effort. */ }
      try { this.silentGain?.disconnect(); } catch { /* Best effort. */ }
    }

    finish(options) {
      if (this.ended) return;
      const suppressCallbacks = Boolean(options?.suppressCallbacks);
      this.ended = true;
      if (this.awaitingFinalResult && !suppressCallbacks) this.reportNoResult();
      this.listening = false;
      this.ending = false;
      this.awaitingFinalResult = false;
      root.clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
      this.disconnectAudioInput();
      this.stream?.getTracks().forEach(track => track.stop());
      try { this.recognizer?.remove(); } catch { /* The worker may already be gone. */ }
      const context = this.audioContext;
      this.stream = null;
      this.source = null;
      this.processor = null;
      this.silentGain = null;
      this.recognizer = null;
      this.audioContext = null;
      this.audioUnlockPromise = null;
      this.callbacks = null;
      if (context) context.close?.().catch?.(() => {});
      if (!suppressCallbacks) this.options.onEnded?.();
    }

    stop(options) {
      const cancel = Boolean(options?.cancel);
      if (this.ending) {
        if (cancel) {
          this.awaitingFinalResult = false;
          this.finish();
        }
        return;
      }
      if (!this.listening) return;
      this.ending = true;
      this.awaitingFinalResult = !cancel;
      this.disconnectAudioInput();
      this.stream?.getTracks().forEach(track => track.stop());
      if (cancel) {
        this.finish();
        return;
      }
      try { this.recognizer?.retrieveFinalResult(); } catch { /* Final text is optional on an interrupted device stream. */ }
      this.finalizeTimer = root.setTimeout(() => this.finish(), FINAL_RESULT_TIMEOUT_MS);
    }

    cancel() {
      if (this.listening || this.ending) this.stop({ cancel: true });
      else this.discardAudioContext(this.audioContext);
    }

    replacePendingFinalResult() {
      if (!this.isFinalizing()) return false;
      this.finish({ suppressCallbacks: true });
      return true;
    }
  }

  function create(options) { return new OfflineVoiceSession(options); }

  return Object.freeze({
    MODEL_FILE,
    MODEL_SIZE_BYTES,
    MODEL_CACHE,
    supportsOfflineVoice,
    hasCachedArchive,
    buildRecognitionPlan,
    buildQghGrammar,
    create
  });
});
