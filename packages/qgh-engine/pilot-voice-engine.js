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
      notify(pending.onstart, { durationSeconds: samples.length / message.sampleRate });
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
