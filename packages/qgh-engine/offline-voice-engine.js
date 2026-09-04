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
      if (prefix && cardinal) variants.add(`${prefix} ${cardinal}`);
      if (options?.includeDigitWords) {
        const digits = phraseForDigits(numeric[2]);
        if (prefix && digits) variants.add(`${prefix} ${digits}`);
      }
    }
    return [...variants];
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

  function headingAliases(rawCallsign, allCallsigns) {
    const designator = callsignDesignator(rawCallsign);
    const designatorCount = allCallsigns.filter(candidate => callsignDesignator(candidate) === designator).length;
    // A unique designator is the concise RT form the parser accepts. When two aircraft share
    // one designator, grammar phrases must carry a complete callsign so routing stays exact.
    return designatorCount === 1 ? [designator] : callsignVariants(rawCallsign);
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
    // Standard controller phrasing without the extra word "heading" is supported on every
    // tactical grammar. Add the expanded variant only where it still leaves sufficient room
    // for a four-aircraft, 20-character callsign exercise on Android.
    const includeHeadingWord = aliases.length * 5 * 361 + staticGrammarPhrases().length < MAX_ANDROID_GRAMMAR_PHRASES;
    aliases.forEach(callsign => {
      for (let heading = 0; heading <= 360; heading += 1) {
        const spoken = phraseForHeading(heading);
        addPhrases(phrases, [
          `${callsign} turn left ${spoken}`, `${callsign} turn right ${spoken}`,
          `${callsign} continue ${spoken}`
        ]);
        if (includeHeadingWord) {
          addPhrases(phrases, [
            `${callsign} turn left heading ${spoken}`, `${callsign} turn right heading ${spoken}`
          ]);
        }
      }
      addPhrases(phrases, [`${callsign} turn left now`, `${callsign} turn right now`, `${callsign} stop turn now`]);
    });
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

  function recognitionPlanContext(context) {
    const callsigns = (Array.isArray(context?.callsigns) ? context.callsigns : [])
      .map(raw => String(raw?.callsign || raw || '').trim().toLowerCase())
      .filter(Boolean);
    const screen = grammarScreen(context, callsigns);
    const scope = grammarScope(screen);
    // Callsigns only alter a tactical exercise grammar. Keeping them out of every other
    // cache key avoids rebuilding a large grammar while a user edits setup fields.
    const activeCallsigns = scope === 'tactical' && isExerciseScreen(screen) ? callsigns : [];
    return { screen, scope, callsigns: activeCallsigns, cacheKey: [screen, ...activeCallsigns].join('\u0000') };
  }

  function buildGrammar(context) {
    const details = recognitionPlanContext(context);
    const { screen, scope, callsigns } = details;

    const phrases = new Set(staticGrammarPhrases());

    // Heading calls are relevant only during an exercise. Tactical callsigns never leak
    // into a single-aircraft, setup, entry, or review grammar.
    if (isExerciseScreen(screen)) {
      if (scope === 'tactical') addTacticalExerciseHeadings(phrases, callsigns);
      else addSingleExerciseHeadings(phrases);
    }

    if (scope === 'tactical' && isExerciseScreen(screen)) callsigns.forEach(rawCallsign => {
      callsignVariants(rawCallsign, { includeDigitWords: true }).forEach(callsign => {
        const transmitPhrases = [
          'transmit df', 'transmit for df', 'transmit d f', 'transmit for d f',
          'transmit direction finding', 'transmit for direction finding',
          'send df', 'send for df', 'send d f', 'send for d f', 'send direction finding', 'send for direction finding'
        ];
        addPhrases(phrases, [
          `select aircraft ${callsign}`, `transmit aircraft ${callsign}`,
          `transmit qdm ${callsign}`, `transmit qte ${callsign}`,
          `report heading ${callsign}`, `report distance ${callsign}`,
          `select formation leader ${callsign}`, `select formation member ${callsign}`,
          `stop following leader ${callsign}`, `focus aircraft ${callsign}`,
          ...transmitPhrases.flatMap(phrase => [`${phrase} ${callsign}`, `${callsign} ${phrase}`])
        ]);
      });
    });

    // [unk] makes an out-of-grammar phrase an explicit non-command, never a nearest match.
    phrases.add('[unk]');
    const grammar = [...phrases];
    // Android rejects oversize JSON grammars by replacing them with [unk]. A conservative
    // fallback keeps core on-device commands available instead of silently disabling voice.
    return Object.freeze(withinAndroidGrammarLimits(grammar) ? grammar : safeFallbackGrammar());
  }

  function cacheRecognitionPlan(details, grammar) {
    const plan = Object.freeze({
      screen: details.screen,
      scope: details.scope,
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
      recognizer.on('partialresult', () => {
        if (!this.ending) settings.onPartial?.();
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
        if (cancel) this.finish();
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
