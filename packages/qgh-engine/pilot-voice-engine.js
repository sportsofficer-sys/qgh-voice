(function exposeQghPilotVoiceEngine(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QGHPilotVoiceEngine = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function createQghPilotVoiceEngine(root) {
  'use strict';

  // Voice clip assembly belongs to a worker. This adapter only owns the user-gesture
  // audio context, the current radio transmission and cancellation boundaries.
  const baseUrl = root.document?.currentScript?.src || root.location?.href || '';
  const voices = Object.freeze([
    Object.freeze({ id: 'am_michael', name: 'Michael' }),
    Object.freeze({ id: 'am_fenrir', name: 'Fenrir' }),
    Object.freeze({ id: 'am_puck', name: 'Puck' }),
    Object.freeze({ id: 'bm_george', name: 'George' })
  ]);
  const PREPARE_TIMEOUT_MS = 120000;
  const GENERATION_TIMEOUT_MS = 5000;
  // The pre-rendered bank contains reusable phrases and individual number clips.
  // A short readback can therefore contain more natural clip duration than its
  // nominal word count allows.  Correct its *actual* duration at playback so
  // pilot replies meet the published 100 WPM target on every browser.
  const PILOT_TARGET_WPM = 100;
  const MAX_PACE_CORRECTION = 1.75;
  let state = 'unprepared';
  let worker = null;
  let context = null;
  let audio = null;
  let preparation = null;
  let active = null;
  let serial = 0;
  let generationTimer = null;

  function available() {
    return typeof root.Worker === 'function'
      && typeof (root.AudioContext || root.webkitAudioContext) === 'function';
  }

  function capability() { return available() ? state : 'unavailable'; }

  function profile(source) {
    const value = String(source?.id ?? source ?? 'single').trim();
    const explicit = voices.find(voice => voice.id === value);
    if (explicit) return explicit;
    if (/^(single|single-aircraft|default|A)$/i.test(value)) return voices[0];
    const slot = value.match(/^(?:aircraft[-:]?)?([A-D])$/i);
    if (slot) return voices[slot[1].toUpperCase().charCodeAt(0) - 65];
    const numbered = value.match(/^(?:aircraft[-:]?)?([1-4])$/);
    if (numbered) return voices[Number(numbered[1]) - 1];
    let hash = 0;
    for (const letter of value.toLowerCase()) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
    return voices[hash % voices.length];
  }

  function notify(callback, value) {
    if (typeof callback === 'function') {
      try { callback(value); } catch (error) { root.console?.error?.('Pilot voice callback failed', error); }
    }
  }

  function clearGenerationTimer() {
    if (generationTimer !== null) root.clearTimeout(generationTimer);
    generationTimer = null;
  }

  function spokenWordCount(text) {
    // Keep numeric expansion aligned with the packaged runtime, where headings
    // are spoken digit by digit rather than as one number word.
    const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    return String(text || '')
      .normalize('NFKC')
      .replace(/(\d)\.(?=\d)/g, '$1 decimal ')
      .replace(/\d/g, digit => ` ${digits[Number(digit)]} `)
      .replace(/[^a-zA-Z ]/g, ' ')
      .trim().split(/\s+/).filter(Boolean).length;
  }

  function paceFor(text, sampleCount, sampleRate) {
    const words = spokenWordCount(text);
    const duration = sampleCount / sampleRate;
    if (!words || !Number.isFinite(duration) || duration <= 0) return 1;
    const targetDuration = words * 60 / PILOT_TARGET_WPM;
    return Math.max(1, Math.min(MAX_PACE_CORRECTION, duration / targetDuration));
  }

  function stopAudio() {
    if (!audio) return;
    audio.onended = null;
    try { audio.stop(); } catch (_) { /* Already ended. */ }
    try { audio.disconnect(); } catch (_) { /* Already disconnected. */ }
    audio = null;
  }

  function cancel() {
    serial += 1;
    active = null;
    clearGenerationTimer();
    stopAudio();
    try { worker?.postMessage({ type: 'cancel', token: serial }); } catch (_) { /* Failed worker is reset on its error. */ }
  }

  function fail(error) {
    const pending = active;
    cancel();
    worker?.terminate();
    worker = null;
    state = 'unprepared';
    if (preparation) {
      const failed = preparation;
      preparation = null;
      root.clearTimeout(failed.timer);
      failed.reject(error);
    }
    notify(pending?.onerror, error);
  }

  function receive(event) {
    const message = event.data || {};
    if (message.type === 'progress') {
      preparation?.listeners.forEach(listener => notify(listener, message.progress));
      return;
    }
    if (message.type === 'ready') {
      if (!preparation) return;
      state = 'ready';
      const ready = preparation;
      preparation = null;
      root.clearTimeout(ready.timer);
      ready.resolve();
      return;
    }
    if (message.type === 'error' && message.token == null) {
      fail(new Error(message.error || 'Pilot voice preparation failed'));
      return;
    }
    if (!active || message.token !== active.token) return;
    if (message.type === 'error') {
      const pending = active;
      active = null;
      clearGenerationTimer();
      notify(pending.onerror, new Error(message.error || 'Pilot voice generation failed'));
      return;
    }
    if (message.type !== 'audio') return;
    clearGenerationTimer();
    const pending = active;
    try {
      if (context.state !== 'running') throw new Error('Pilot audio is suspended. Test pilot voice again.');
      const samples = message.samples instanceof Float32Array ? message.samples : new Float32Array(message.samples);
      if (!samples.length || message.sampleRate !== 24000) throw new Error('Invalid pilot audio');
      const buffer = context.createBuffer(1, samples.length, message.sampleRate);
      buffer.copyToChannel(samples, 0);
      audio = context.createBufferSource();
      audio.buffer = buffer;
      const pace = paceFor(pending.text, samples.length, message.sampleRate);
      // The correction only shortens an over-long assembled reply. It never
      // slows a naturally brisk clip, and does not affect flight or D/F timing.
      audio.playbackRate.value = pace;
      audio.connect(context.destination);
      const playing = audio;
      playing.onended = () => {
        playing.disconnect();
        if (audio === playing) audio = null;
        if (active?.token !== pending.token) return;
        active = null;
        notify(pending.onend);
      };
      playing.start();
      notify(pending.onstart, { durationSeconds: samples.length / message.sampleRate / pace });
    } catch (error) {
      active = null;
      stopAudio();
      notify(pending.onerror, error);
    }
  }

  function prepare(options) {
    if (!available()) return Promise.reject(new Error('Bundled pilot voices are unavailable in this browser.'));
    let resume;
    try {
      // Called before the first await so browser autoplay permission is captured
      // by the explicit headphone test, including Safari and installed PWAs.
      if (!context || context.state === 'closed') {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        context = new AudioContext();
      }
      resume = context.resume();
    } catch (error) { return Promise.reject(error); }
    const unlock = Promise.resolve(resume).then(() => {
      if (context.state !== 'running') throw new Error('Pilot audio is suspended. Test pilot voice again.');
    });
    if (state === 'ready') return unlock;
    if (preparation) {
      if (options?.onProgress) preparation.listeners.add(options.onProgress);
      return Promise.all([unlock, preparation.promise]).then(() => undefined);
    }
    state = 'preparing';
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    preparation = { promise, resolve, reject, listeners: new Set(), timer: null };
    const pendingPreparation = preparation;
    if (options?.onProgress) preparation.listeners.add(options.onProgress);
    preparation.timer = root.setTimeout(() => fail(new Error('Pilot voice preparation timed out. Test again.')), PREPARE_TIMEOUT_MS);
    try {
      const created = new root.Worker(new URL('pilot-voice-worker.js', baseUrl).href, { type: 'module', name: 'qgh-pilot-voice' });
      pendingPreparation.worker = created;
      worker = created;
      created.onmessage = event => { if (worker === created) receive(event); };
      created.onerror = () => { if (worker === created) fail(new Error('Pilot voice worker failed. Test again.')); };
      created.onmessageerror = () => { if (worker === created) fail(new Error('Pilot voice worker returned unreadable audio.')); };
      worker.postMessage({ type: 'prepare' });
    } catch (error) { fail(error); }
    return Promise.all([unlock, promise]).then(() => undefined).catch(error => {
      if (worker && worker === pendingPreparation.worker) fail(error);
      throw error;
    });
  }

  function speak(request) {
    cancel();
    const text = String(request?.text || '').trim();
    if (state !== 'ready' || !worker) {
      notify(request?.onerror, new Error('Test pilot voice before starting the exercise.'));
      return;
    }
    if (!text || text.length > 600) {
      notify(request?.onerror, new Error('Pilot transmission is empty or too long.'));
      return;
    }
    active = { ...request, token: ++serial };
    generationTimer = root.setTimeout(() => fail(new Error('Pilot voice generation timed out. Test again.')), GENERATION_TIMEOUT_MS);
    try {
      worker.postMessage({ type: 'speak', token: active.token, text, voice: profile(request.source).id });
    } catch (error) { fail(error); }
  }

  return Object.freeze({ prepare, capability, profile, voices, speak, cancel });
});
