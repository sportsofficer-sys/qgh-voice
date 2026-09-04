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
  const END_GRACE_MS = 950;
  const AVIATION_DIGITS = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];
  const STATIC_COMMANDS = [
    'select single aircraft qgh', 'open single aircraft qgh', 'select tactical qgh', 'open tactical qgh',
    'select normal qgh', 'set normal qgh', 'normal qgh', 'select us compass', 'set us compass', 'us compass',
    'select qdm', 'set qdm', 'show qdm', 'select qte', 'set qte', 'show qte',
    'transmit df', 'transmit for df', 'transmit qdm', 'transmit for qdm', 'transmit qte', 'transmit for qte',
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
  const AIRCRAFT_TERMS = [
    'fighter', 'fighter general', 'transport', 'transport general', 'helicopter', 'helicopter general',
    'tejas', 'rafale', 'su thirty mki', 'mirage two thousand', 'jaguar', 'c seventeen',
    'c one thirty j', 'an thirty two', 'mi seventeen v five', 'chinook', 'apache', 'alh dhurv'
  ];
  let staticGrammar = null;
  let cachedGrammarKey = null;
  let cachedGrammar = null;

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

  function phraseForNumber(value) {
    return String(Math.round(Number(value) || 0)).split('').map(digit => AVIATION_DIGITS[Number(digit)]).join(' ');
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
    addPhrases(phrases, AIRCRAFT_TERMS.map(profile => `select aircraft profile ${profile}`));
    addPhrases(phrases, AIRCRAFT_TERMS.map(profile => `set aircraft profile ${profile}`));

    for (let heading = 0; heading <= 360; heading += 1) {
      const spoken = phraseForHeading(heading);
      addPhrases(phrases, [
        `set runway orientation ${spoken}`, `set runway ${spoken}`,
        `set inbound track ${spoken}`, `set final track ${spoken}`,
        `set outbound track ${spoken}`, `set assigned heading ${spoken}`, `set heading ${spoken}`,
        `turn left heading ${spoken}`, `turn left to heading ${spoken}`,
        `turn right heading ${spoken}`, `turn right to heading ${spoken}`
      ]);
    }

    for (let distance = 5; distance <= 50; distance += 1) {
      const spoken = phraseForNumber(distance);
      addPhrases(phrases, [`set initial distance ${spoken}`, `set distance ${spoken}`]);
    }
    for (let speed = 60; speed <= 600; speed += 5) {
      const spoken = phraseForNumber(speed);
      addPhrases(phrases, [`set ground speed ${spoken}`, `set speed ${spoken}`]);
    }
    for (let rate = 5; rate <= 80; rate += 1) {
      const whole = Math.floor(rate / 10);
      const fraction = rate % 10;
      const spoken = fraction ? `${phraseForNumber(whole)} point ${AVIATION_DIGITS[fraction]}` : phraseForNumber(whole);
      addPhrases(phrases, [`set rate of turn ${spoken}`, `set turn rate ${spoken}`]);
    }

    staticGrammar = Object.freeze([...phrases]);
    return staticGrammar;
  }

  function buildQghGrammar(context) {
    const callsigns = (Array.isArray(context?.callsigns) ? context.callsigns : [])
      .map(raw => String(raw?.callsign || raw || '').trim().toLowerCase())
      .filter(Boolean);
    const cacheKey = callsigns.join('\u0000');
    if (cachedGrammar && cachedGrammarKey === cacheKey) return [...cachedGrammar];

    const phrases = new Set(staticGrammarPhrases());

    callsigns.forEach(callsign => {
      addPhrases(phrases, [
        `select aircraft ${callsign}`, `transmit aircraft ${callsign}`,
        `transmit df ${callsign}`, `transmit for df ${callsign}`,
        `transmit qdm ${callsign}`, `transmit qte ${callsign}`,
        `report heading ${callsign}`, `report distance ${callsign}`,
        `select formation leader ${callsign}`, `select formation member ${callsign}`,
        `stop following leader ${callsign}`, `focus aircraft ${callsign}`
      ]);
      for (let heading = 0; heading <= 360; heading += 1) {
        const spoken = phraseForHeading(heading);
        addPhrases(phrases, [
          `${callsign} turn left heading ${spoken}`, `${callsign} turn left to heading ${spoken}`,
          `${callsign} turn right heading ${spoken}`, `${callsign} turn right to heading ${spoken}`
        ]);
      }
      addPhrases(phrases, [`${callsign} turn left now`, `${callsign} turn right now`, `${callsign} stop turn now`]);
    });

    // [unk] makes an out-of-grammar phrase an explicit non-command, never a nearest match.
    phrases.add('[unk]');
    cachedGrammarKey = cacheKey;
    cachedGrammar = Object.freeze([...phrases]);
    return [...cachedGrammar];
  }

  // Vosk performs this transcription entirely on-device. The semantic command parser is
  // intentionally responsible for interpreting wording variation after recognition, rather
  // than trying to enumerate every controller phrase in a fragile closed grammar.
  function buildRecognitionPlan() {
    return Object.freeze({ grammar: null });
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
    }

    isReady() { return Boolean(this.model); }

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

    async start(options) {
      if (this.listening) return true;
      const settings = options || {};
      const model = await this.prepare(settings.onProgress);
      const AudioContext = root.AudioContext || root.webkitAudioContext;
      let stream;
      try {
        stream = await root.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false
        });
      } catch (error) {
        settings.onError?.(error?.name === 'NotAllowedError' ? 'not-allowed' : 'unavailable');
        throw error;
      }

      const audioContext = new AudioContext();
      try { await audioContext.resume?.(); } catch { /* A muted processing path still works on supported browsers. */ }
      const grammar = Array.isArray(settings.grammar) && settings.grammar.length
        ? JSON.stringify(settings.grammar)
        : undefined;
      let recognizer;
      try {
        recognizer = new model.KaldiRecognizer(audioContext.sampleRate, grammar);
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        try { await audioContext.close(); } catch { /* Best effort. */ }
        settings.onError?.('unavailable');
        throw error;
      }

      this.stream = stream;
      this.audioContext = audioContext;
      this.recognizer = recognizer;
      this.listening = true;
      this.ending = false;
      this.ended = false;
      recognizer.on('result', message => {
        const transcript = transcriptFrom(message);
        if (transcript) settings.onResult?.(transcript);
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
      return true;
    }

    disconnectAudioInput() {
      try { this.processor?.disconnect(); } catch { /* Best effort. */ }
      try { this.source?.disconnect(); } catch { /* Best effort. */ }
      try { this.silentGain?.disconnect(); } catch { /* Best effort. */ }
    }

    finish() {
      if (this.ended) return;
      this.ended = true;
      this.listening = false;
      this.ending = false;
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
      if (context) context.close?.().catch?.(() => {});
      this.options.onEnded?.();
    }

    stop(options) {
      if (!this.listening || this.ending) return;
      const cancel = Boolean(options?.cancel);
      this.ending = true;
      this.disconnectAudioInput();
      this.stream?.getTracks().forEach(track => track.stop());
      if (cancel) {
        this.finish();
        return;
      }
      try { this.recognizer?.retrieveFinalResult(); } catch { /* Final text is optional on an interrupted device stream. */ }
      this.finalizeTimer = root.setTimeout(() => this.finish(), END_GRACE_MS);
    }

    cancel() { this.stop({ cancel: true }); }
  }

  function create(options) { return new OfflineVoiceSession(options); }

  return Object.freeze({
    MODEL_FILE,
    MODEL_SIZE_BYTES,
    MODEL_CACHE,
    supportsOfflineVoice,
    buildRecognitionPlan,
    buildQghGrammar,
    create
  });
});
