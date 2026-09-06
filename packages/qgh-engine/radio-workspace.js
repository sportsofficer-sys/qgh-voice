(function initializeRadioWorkspace(root) {
  'use strict';
  const adapter = root.QGHRadioAdapter;
  const Radio = root.QGHRadioSession;
  if (!adapter || !Radio) return;
  // Android WebView uses the wrapper's explicitly offline-only speech service.
  // Its presence must never fall through to a browser/default network voice.
  const nativeSpeech = root.QghNativePilotSpeech;
  const bundledSpeech = root.QGHPilotVoiceEngine;
  // A late native callback from a same-URL reload must not match a new document.
  const speechDocumentId = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Audible readbacks are an explicit headphones opt-in, never a speaker default.
  let audioEnabled = false;
  let pilotRate = 1;
  let controllerHeld = false;
  let generation = 0;
  let pending = [];
  let active = null;
  let pumpTimer = null;
  let endTimer = null;
  let startTimer = null;
  let echoTimer = null;
  const headingReports = Radio.createHeadingReports();
  // Condition reports are flight obligations, not disposable command readbacks.
  // They survive microphone changes and wait for an available radio channel.
  const reports = new Map();

  // Ordinary reports describe aircraft state.  They must be sampled when the
  // pilot is about to transmit, not when a controller call is first accepted
  // and may still be queued behind a held channel.
  const liveSampleIntents = new Set(['report-heading', 'request-distance']);

  function refreshLiveSample(item) {
    if (!item?.liveSample) return item;
    const aircraft = adapter.snapshot(item.source);
    if (!aircraft) return null;
    const reply = Radio.replyFor(item.command, aircraft);
    return reply ? { ...item, reply } : null;
  }

  function localVoice() {
    try {
      return root.speechSynthesis?.getVoices().find(voice => voice.localService === true && /^en(?:-|_)/i.test(voice.lang)) || null;
    } catch { return null; }
  }

  function nativeAudioAvailable() {
    try { return nativeSpeech?.getCapability() === 'ready'; } catch { return false; }
  }

  function receiveNativeSpeechEvent(event) {
    if (!nativeSpeech || !event || typeof event.id !== 'string' || active?.nativeId !== event.id) return;
    // Cancellation clears the identity before calling into Android, so even an
    // immediate/late callback cannot resurrect an interrupted transmission.
    if (event.type === 'start') active.nativeCallbacks?.start();
    else if (event.type === 'end') active.nativeCallbacks?.end();
    else if (event.type === 'error') active.nativeCallbacks?.error();
  }

  function clearTimers() {
    for (const timer of [pumpTimer, endTimer, startTimer, echoTimer]) root.clearTimeout(timer);
    pumpTimer = endTimer = startTimer = echoTimer = null;
  }

  function stopOutput() {
    if (active?.bundledId) {
      active.bundledId = null;
      try { bundledSpeech.cancel(); } catch { /* Keep manual and muted radio controls usable. */ }
    }
    if (active?.nativeId) {
      active.nativeId = null;
      active.nativeCallbacks = null;
      try { nativeSpeech.cancel(); } catch { /* Keep the muted radio fallback usable. */ }
    }
    if (active?.utterance) {
      active.utterance.onstart = active.utterance.onend = active.utterance.onerror = null;
      try { root.speechSynthesis.cancel(); } catch { /* Manual control must remain available. */ }
    }
  }

  function interrupt() {
    if (active?.report && active.token == null && !reports.has(active.report.queueKey)) reports.set(active.report.queueKey, active.report);
    generation += 1;
    clearTimers();
    pending = [];
    stopOutput();
    if (active?.token != null) adapter.endTransmit(active.token);
    active = null;
    root.QGHVoiceWorkspace?.setPilotSpeaking(false);
  }

  function reset() {
    interrupt();
    controllerHeld = false;
    schedule();
  }

  function resetExercise() {
    interrupt();
    headingReports.clear();
    reports.clear();
    controllerHeld = false;
  }

  function controllerStart() {
    if (controllerHeld) return;
    interrupt();
    controllerHeld = true;
    adapter.controllerStart();
  }

  function controllerEnd() {
    controllerHeld = false;
    schedule();
  }

  function schedule() {
    if (controllerHeld || active || echoTimer || pumpTimer || (!pending.length && !reports.size) || !adapter.active()) return;
    pumpTimer = root.setTimeout(() => { pumpTimer = null; playNext(); }, 300);
  }

  function releaseMicrophoneAfterAudio(ticket) {
    root.clearTimeout(echoTimer);
    echoTimer = root.setTimeout(() => {
      if (ticket !== generation) return;
      echoTimer = null;
      root.QGHVoiceWorkspace?.setPilotSpeaking(false);
      schedule();
    }, 250);
  }

  function finish(ticket) {
    if (ticket !== generation || !active) return;
    root.clearTimeout(startTimer);
    root.clearTimeout(endTimer);
    stopOutput();
    if (active.token != null) adapter.endTransmit(active.token);
    active = null;
    // Discard the audio tail before resuming a still-requested continuous microphone.
    releaseMicrophoneAfterAudio(ticket);
  }

  function playNext() {
    if (controllerHeld || active || echoTimer || (!pending.length && !reports.size) || !adapter.active()) return;
    // A manual TRANSMIT button also owns the receiver, outside this speech queue.
    if (adapter.observation?.().phase === 'live') { schedule(); return; }
    let item = pending.shift();
    if (!item) {
      const [key, report] = reports.entries().next().value;
      const source = report.source;
      reports.delete(key);
      const current = adapter.snapshot(source);
      if (!current || (report.intent === 'heading-passing-report' && current.procedure === 'us')) { schedule(); return; }
      const delayed = Number.isFinite(current.simulationSeconds) && current.simulationSeconds - report.simulationSeconds > 2;
      item = { source, report, intent: report.intent,
        reply: Radio.replyFor({ intent: report.intent, heading: report.heading, delayed }, report) };
      if (!item.reply) { schedule(); return; }
    }
    item = refreshLiveSample(item);
    if (!item || !adapter.snapshot(item.source)) { schedule(); return; }
    const ticket = ++generation;
    active = { ...item, token: null, utterance: null };
    const duration = item.intent === 'transmit-df' ? 4000 : Math.max(1500, Math.min(5000, item.reply.speech.split(/\s+/).length * 340));
    active.duration = duration;
    const begin = () => {
      if (ticket !== generation || !active || active.token != null) return;
      active.token = adapter.beginTransmit(item.source);
      root.QGHVoiceWorkspace?.showPilotReply(item.reply);
    };
    const fallback = () => {
      if (ticket !== generation || !active) return;
      root.clearTimeout(startTimer);
      stopOutput();
      begin();
      releaseMicrophoneAfterAudio(ticket);
      root.clearTimeout(endTimer);
      endTimer = root.setTimeout(() => finish(ticket), duration);
    };
    const onAudioStart = playback => {
      if (ticket !== generation || !active) return;
      root.clearTimeout(startTimer);
      begin();
      if (active.bundledId) {
        root.clearTimeout(endTimer);
        // The bank caps generated audio at 90 seconds. Written callsigns can
        // expand into many spoken letters, so use the actual playback duration.
        const audioSeconds = Number.isFinite(playback?.durationSeconds) && playback.durationSeconds > 0
          ? Math.min(playback.durationSeconds, 90) : 90;
        endTimer = root.setTimeout(() => finish(ticket), audioSeconds * 1000 + 5000);
      }
    };
    const onAudioEnd = () => {
      if (ticket !== generation || !active) return;
      if (active.token == null) fallback();
      else finish(ticket);
    };
    const armAudioWatchdogs = () => {
      startTimer = root.setTimeout(fallback, 1500);
      endTimer = root.setTimeout(() => finish(ticket), 15000);
    };
    if (bundledSpeech) {
      // Never silently replace the packaged voice with a device or cloud voice.
      if (!audioEnabled || bundledSpeech.capability() !== 'ready') { fallback(); return; }
      root.QGHVoiceWorkspace?.setPilotSpeaking(true);
      active.bundledId = `qgh-pilot-${speechDocumentId}-${ticket}`;
      const bundledId = active.bundledId;
      const guarded = callback => payload => {
        if (ticket === generation && active?.bundledId === bundledId) callback(payload);
      };
      startTimer = root.setTimeout(fallback, 60000);
      try {
        const result = bundledSpeech.speak({ id: active.bundledId, text: item.reply.speech, source: item.source, rateMultiplier: pilotRate,
          onstart: guarded(onAudioStart), onend: guarded(onAudioEnd), onerror: guarded(fallback) });
        if (result?.catch) result.catch(guarded(fallback));
      } catch { fallback(); }
      return;
    }
    if (nativeSpeech) {
      if (!audioEnabled || !nativeAudioAvailable()) { fallback(); return; }
      root.QGHVoiceWorkspace?.setPilotSpeaking(true);
      active.nativeId = `qgh-pilot-${speechDocumentId}-${ticket}`;
      active.nativeCallbacks = { start: onAudioStart, end: onAudioEnd, error: fallback };
      armAudioWatchdogs();
      try { nativeSpeech.speak(active.nativeId, item.reply.speech, pilotRate); }
      catch { fallback(); }
      return;
    }
    const voice = audioEnabled && localVoice();
    if (!voice || typeof root.SpeechSynthesisUtterance !== 'function') {
      fallback();
      return;
    }
    // Only an explicitly local voice is eligible. Never use the UA's potentially
    // remote default voice, and never introduce a cloud fallback.
    root.QGHVoiceWorkspace?.setPilotSpeaking(true);
    try {
      const utterance = new root.SpeechSynthesisUtterance(item.reply.speech);
      active.utterance = utterance;
      utterance.voice = voice;
      utterance.lang = voice.lang;
      // Device voices use their ordinary rate at 1×; the bundled pack follows
      // the same 150 WPM baseline. This affects audio only, never flight/D-F.
      // This affects headphone readbacks only, never simulation or muted DF timing.
      utterance.rate = pilotRate;
      utterance.onstart = onAudioStart;
      utterance.onend = onAudioEnd;
      utterance.onerror = fallback;
      // A missing start/end event must never leave a permanent transmitter or mic lock.
      armAudioWatchdogs();
      root.speechSynthesis.speak(utterance);
    } catch { fallback(); }
  }

  function acknowledge(command) {
    if (!adapter.active()) return;
    const aircraft = adapter.snapshot(command.aircraft);
    const reply = Radio.replyFor(command, aircraft);
    if (!reply) return;
    // The controller has already executed the new command. Never wait for an
    // obsolete readback to finish before acknowledging its replacement.
    if (active || echoTimer) interrupt();
    // An accepted newer manoeuvre supersedes a not-yet-spoken manoeuvre for this
    // aircraft. Do not narrate a stale turn after the pilot has been told to stop.
    const manoeuvres = ['normal-turn-heading', 'continue-turn-heading', 'us-turn', 'us-turn-stop', 'start-orbit', 'continue-orbit', 'resume-normal'];
    if (manoeuvres.includes(command.intent)) reports.delete(`orbit:${aircraft.source}`);
    if (manoeuvres.includes(command.intent)) pending = pending.filter(item => item.source !== aircraft.source || !manoeuvres.includes(item.intent));
    if (command.field === 'speed') pending = pending.filter(item => item.source !== aircraft.source || item.field !== 'speed');
    pending.push({ source: aircraft.source, callsign: aircraft.callsign, intent: command.intent, field: command.field,
      command: liveSampleIntents.has(command.intent) ? { ...command, aircraft: aircraft.source } : null,
      liveSample: liveSampleIntents.has(command.intent), reply });
    if (pending.length > 4) pending.shift();
    schedule();
  }

  function requestHeadingPassing(command) {
    if (!adapter.active()) return { ok: false, message: 'START AN EXERCISE FIRST' };
    const aircraft = adapter.snapshot(command.aircraft);
    if (!aircraft || aircraft.procedure === 'us') return { ok: false, message: 'HEADING REPORTS UNAVAILABLE WITH U/S COMPASS' };
    const reply = Radio.replyFor({ ...command, intent: 'request-heading-passing' }, aircraft);
    if (!reply) return { ok: false, message: 'INVALID PASSING HEADING' };
    if (!headingReports.arm(aircraft.source, command.heading, aircraft.heading)) return { ok: false, message: 'INVALID PASSING HEADING' };
    reports.delete(aircraft.source);
    if (active?.source === aircraft.source && active.report?.intent === 'heading-passing-report') active.report = null;
    pending = pending.filter(item => item.source !== aircraft.source || item.intent !== 'request-heading-passing');
    adapter.reportEvent?.(aircraft.source, reply.text);
    return { ok: true, message: reply.text };
  }

  function observeHeading(source, heading) {
    const crossing = headingReports.observe(source, heading);
    if (!crossing || !adapter.active()) return;
    const aircraft = adapter.snapshot(source);
    if (!aircraft || aircraft.procedure === 'us') return;
    const report = Object.freeze({ ...aircraft, heading: crossing.heading, intent: 'heading-passing-report', queueKey: source });
    pending = pending.filter(item => item.source !== source || item.intent !== 'request-heading-passing');
    reports.set(source, report);
    adapter.reportEvent?.(source, `HEADING PASSED ${String(crossing.heading).padStart(3, '0')}°M`);
    schedule();
  }

  function notifyOrbitComplete(source, resumed = false) {
    if (!adapter.active()) return;
    const aircraft = adapter.snapshot(source);
    if (!aircraft) return;
    const queueKey = `orbit:${source}`;
    // If several laps pass while the controller owns the channel, one latest
    // completion report is sufficient; never replay a backlog of obsolete laps.
    reports.set(queueKey, Object.freeze({ ...aircraft, queueKey, intent: resumed ? 'orbit-resumed' : 'orbit-complete' }));
    pending = pending.filter(item => item.source !== source || !['start-orbit', 'continue-orbit', 'resume-normal'].includes(item.intent));
    schedule();
  }

  function setAudioEnabled(enabled) {
    audioEnabled = Boolean(enabled) && (!root.QGHHeadphones || root.QGHHeadphones.confirmed());
    // Muting audio does not cancel the simulated pilot transmission.
    if (!audioEnabled && (active?.utterance || active?.nativeId || active?.bundledId)) {
      stopOutput();
      if (active.token == null) {
        active.token = adapter.beginTransmit(active.source);
        root.QGHVoiceWorkspace?.showPilotReply(active.reply);
      }
      root.clearTimeout(startTimer);
      root.clearTimeout(endTimer);
      const ticket = generation;
      releaseMicrophoneAfterAudio(ticket);
      endTimer = root.setTimeout(() => finish(ticket), active.duration);
    }
  }

  function setPilotRate(value) {
    pilotRate = [1, 2, 3].includes(Number(value)) ? Number(value) : 1;
  }

  root.QGHRadioWorkspace = Object.freeze({ acknowledge, controllerStart, controllerEnd, interrupt, reset, resetExercise, requestHeadingPassing, observeHeading, notifyOrbitComplete, channelAvailable: schedule,
    manualCommand: command => {
      if (!root.QGHVoiceWorkspace?.isDispatchingRadioCommand()) acknowledge(command);
    },
    setAudioEnabled, setPilotRate, receiveNativeSpeechEvent, audioAvailable: () => bundledSpeech ? bundledSpeech.capability() === 'ready' : nativeSpeech ? nativeAudioAvailable() : Boolean(localVoice()),
    allowsBargeIn: () => audioEnabled,
    status: () => ({ audioEnabled, pilotRate, controllerHeld, phase: active ? 'pilot' : controllerHeld ? 'controller' : pending.length ? 'pending' : 'idle', pending: pending.length })
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
