(function initializeQghVoiceWorkspace(root) {
  'use strict';

  const documentRef = root.document;
  const Voice = root.QGHVoiceControl;
  if (!documentRef || !Voice) return;

  const OfflineVoice = root.QGHOfflineVoiceEngine;
  const RECENT_TRANSCRIPT_WINDOW_MS = 900;
  const VOICE_CONFIRMATION_WINDOW_MS = 15_000;
  const VOICE_FEEDBACK_WINDOW_MS = 4_200;
  const VOICE_DOCK_POSITION_KEY = 'qgh-voice-dock-position-v2';
  const nativeVoiceDocumentId = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const $ = id => documentRef.getElementById(id);
  const voiceEffectTimers = new WeakMap();
  const state = {
    engine: null,
    listening: false,
    starting: false,
    pressHeld: false,
    pressPointerId: null,
    processing: false,
    continuous: false,
    pilotSpeaking: false,
    dispatchingRadioCommand: false,
    manuallyStopped: false,
    localAvailability: 'unknown',
    lastTranscript: '',
    lastTranscriptAt: 0,
    statusTimer: null,
    feedbackTimer: null,
    commandAcknowledgementTimer: null,
    acknowledgementStageTimer: null,
    feedbackSequence: 0,
    lastCall: null,
    currentOutcome: null,
    lastCallDetail: null,
    announcement: null,
    effectBatch: null,
    callTranscripts: new Set(),
    restartTimer: null,
    radioQuietTimer: null,
    readinessTimer: null,
    availabilityPromise: null,
    preparePromise: null,
    startAttempt: 0,
    recognitionContext: null,
    lastNativeGrammarJson: null,
    nativeRequestId: null,
    nativeResultReceived: false,
    mic: null,
    status: null,
    feedback: null,
    dock: null,
    dragHandle: null,
    dockDrag: null,
    settings: null,
    settingsToggle: null,
    continuousInput: null,
    prepareButton: null,
    listeningIndicator: null,
    engineNote: null,
    pendingCommand: null,
    pendingContext: null,
    pendingTimer: null,
    confirmationPanel: null,
    confirmationDetail: null,
    confirmationButton: null,
    cancellationButton: null
  };

  function pageKind() {
    if ($('tSetup')) return 'tactical';
    if ($('setup')) return 'single';
    return 'entry';
  }

  function activeScreen(id) {
    const screen = $(id);
    return Boolean(screen && screen.classList.contains('active'));
  }

  function currentVoiceContext() {
    const kind = pageKind();
    if (kind === 'single') {
      const screen = ['setup', 'console', 'analysis'].find(activeScreen) || 'unknown';
      return `${kind}:${screen}`;
    }
    if (kind === 'tactical') {
      const screen = ['tSetup', 'tConsole', 'tAnalysis'].find(activeScreen) || 'unknown';
      return `${kind}:${screen}`;
    }
    return 'entry';
  }

  function currentProcedure() {
    const usControl = pageKind() === 'tactical' ? $('tProcedureUs') : $('us');
    return usControl?.getAttribute('aria-pressed') === 'true' ? 'us' : 'normal';
  }

  function buttonText(button) {
    return (button?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isAvailable(element) {
    if (!element || element.disabled || element.hidden || element.closest('[hidden]')) return false;
    const screen = element.closest('.screen, .tactical-screen');
    return !screen || screen.classList.contains('active');
  }

  function browserBottomInset() {
    const viewport = root.visualViewport;
    const layoutHeight = Number(root.innerHeight);
    const visibleHeight = Number(viewport?.height);
    const visibleTop = Number(viewport?.offsetTop || 0);
    if (!viewport || !Number.isFinite(layoutHeight) || !Number.isFinite(visibleHeight)) return 0;
    // iPhone Safari's bottom controls reduce visualViewport.height, but are not
    // consistently included in env(safe-area-inset-bottom). Keep fixed UI clear.
    return Math.max(0, Math.round(layoutHeight - visibleHeight - visibleTop));
  }

  function syncBrowserBottomInset() {
    documentRef.documentElement?.style?.setProperty('--qgh-browser-bottom-inset', `${browserBottomInset()}px`);
  }

  function refreshViewportLayout() {
    syncBrowserBottomInset();
    positionVoicePopovers();
  }

  function scheduleBrowserBottomInset() {
    refreshViewportLayout();
    if (!root.visualViewport) return;
    // Safari may finish expanding its first-load browser controls after the
    // workspace script runs, without a later viewport event for this document.
    const nextFrame = () => {
      refreshViewportLayout();
      if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(refreshViewportLayout);
    };
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(nextFrame);
    else root.setTimeout(nextFrame, 0);
    root.setTimeout(refreshViewportLayout, 240);
  }

  function result(ok, message) {
    return { ok: Boolean(ok), message };
  }

  function setStatus(message, tone) {
    if (!state.status) return;
    root.clearTimeout(state.statusTimer);
    state.status.textContent = message;
    state.status.dataset.tone = tone || 'neutral';
    if (tone === 'success') {
      state.statusTimer = root.setTimeout(() => {
        if (state.listening) setStatus('LISTENING', 'active');
        else if (state.localAvailability === 'ready') setStatus('PTT READY', 'neutral');
      }, 2400);
    }
  }

  function clearVoiceFeedback() {
    if (!state.feedback) return;
    root.clearTimeout(state.feedbackTimer);
    state.feedbackTimer = null;
    state.feedback.hidden = true;
    state.feedback.textContent = '';
    state.feedback.removeAttribute?.('aria-label');
    state.feedback.removeAttribute?.('title');
    delete state.feedback.dataset.tone;
  }

  function setVoiceFeedback(transcript, message, tone) {
    if (!state.feedback) return;
    const heard = String(transcript || '').trim();
    const compactMessage = heard
      ? `HEARD\n${tone === 'success' ? 'APPLIED' : message.startsWith('CONFIRM REQUIRED') ? 'CONFIRM' : 'CHECK CALL'}`
      : 'NO SPEECH\nTRY AGAIN';
    const detail = heard ? `Heard ${heard}. ${message}` : message;
    root.clearTimeout(state.feedbackTimer);
    state.feedback.hidden = false;
    state.feedback.textContent = compactMessage;
    state.feedback.setAttribute('aria-label', detail);
    state.feedback.title = detail;
    state.feedback.dataset.tone = tone || 'neutral';
    state.feedbackTimer = root.setTimeout(clearVoiceFeedback, VOICE_FEEDBACK_WINDOW_MS);
  }

  function commandAcknowledgementTarget() {
    if (pageKind() === 'single' && activeScreen('console')) return $('voiceCommandAck');
    if (pageKind() === 'tactical' && activeScreen('tConsole')) return $('tVoiceCommandAck');
    if (activeScreen('analysis')) return $('reviewVoiceAck');
    if (activeScreen('tAnalysis')) return $('tReviewVoiceAck');
    return null;
  }

  function describeWorkspaceVoiceCommand(command, fallback) {
    if (command?.intent === 'radio-exchange') return String(command.radioMessage).toUpperCase();
    if (command?.intent === 'request-heading-passing') return `REPORT HEADING PASSING ${String(command.heading).padStart(3, '0')}°M`;
    if (command?.intent === 'start-orbit') return `ORBIT ${command.side.toUpperCase()}`;
    if (command?.intent === 'continue-orbit') return 'CONTINUE ORBIT';
    if (command?.intent === 'resume-normal') return 'RESUME NORMAL';
    const targetLabel = command?.aircraft
      ? pageKind() === 'tactical' ? tacticalCallsign(command.aircraft) : singleCallsign()
      : undefined;
    return typeof Voice.describeCommand === 'function'
      ? Voice.describeCommand(command, { targetLabel })
      : String(fallback || command?.intent || 'COMMAND').replace(/-/g, ' ').toUpperCase();
  }

  function appliedExerciseReply(command) {
    const tactical = pageKind() === 'tactical';
    if (!activeScreen(tactical ? 'tConsole' : 'console')) return '';
    let reply = '';
    if (command.intent === 'start-orbit') {
      reply = `ORBITING ${command.side.toUpperCase()}`;
    } else if (command.intent === 'continue-orbit') {
      reply = 'CONTINUING ORBIT';
    } else if (command.intent === 'resume-normal') {
      reply = root.QGHRadioAdapter?.snapshot(command.aircraft)?.orbitSide
        ? 'WILL RESUME NORMAL AFTER THIS ORBIT' : 'RESUMING NORMAL';
    } else if (command.intent === 'request-heading-passing') {
      reply = `WILL REPORT HEADING PASSING ${String(command.heading).padStart(3, '0')}°M`;
    } else if (command.intent === 'report-heading') {
      const reported = $(tactical ? 'tHeadingReply' : 'headingReply')?.textContent || '';
      if (/^HEADING \d{3}°M$/.test(reported)) reply = reported;
    } else if (command.intent === 'request-distance') {
      const reported = $(tactical ? 'tDistanceReply' : 'distanceReply')?.textContent || '';
      if (/^RANGE \d+(?:\.\d+)? NM$/.test(reported)) reply = reported;
    } else if (command.intent === 'normal-turn-heading' || command.intent === 'continue-turn-heading') {
      const heading = String(((command.heading % 360) + 360) % 360).padStart(3, '0');
      const side = command.intent === 'normal-turn-heading'
        ? command.side : $(tactical ? 'tContinueHeading' : 'continueHeading')?.dataset.turnSide;
      reply = side === 'left' || side === 'right'
        ? `TURNING ${side.toUpperCase()} ${heading}°M` : `CONTINUING TO ${heading}°M`;
    } else if (command.intent === 'us-turn') {
      reply = `TURNING ${command.side.toUpperCase()}`;
    } else if (command.intent === 'us-turn-stop') {
      reply = 'TURN STOPPED';
    }
    return reply && command.aircraft ? `${tactical ? tacticalCallsign(command.aircraft) : singleCallsign()} · ${reply}` : reply;
  }

  function presentVoiceResult(command, outcome, transcript) {
    state.feedbackSequence += 1;
    state.processing = false;
    updateMicState();
    const pending = Boolean(state.pendingCommand) || /CONFIRMATION OPEN/.test(outcome.message);
    const cancelled = /CANCELLED/.test(outcome.message);
    const applied = outcome.ok && !pending && !cancelled;
    const radioOnly = applied && command.intent === 'radio-exchange';
    const phase = pending ? 'CONFIRM REQUIRED' : cancelled ? 'CANCELLED' : radioOnly ? 'RECEIVED' : applied ? 'APPLIED' : command?.accepted ? 'REJECTED' : 'NOT RECOGNISED';
    state.currentOutcome = phase;
    const description = command?.accepted ? describeWorkspaceVoiceCommand(command, outcome.message) : String(transcript || '').trim();
    // Snapshot the synchronous control reply now, before the display transition:
    // the aircraft may keep turning or the selected tactical aircraft may change.
    const appliedReply = radioOnly ? outcome.message : applied ? appliedExerciseReply(command) : '';
    const resultDetail = appliedReply || outcome.message;
    state.lastCall = { heard: String(transcript || '').trim(), interpreted: description, result: phase, reason: resultDetail };
    setStatus(phase, applied ? 'success' : pending ? 'active' : 'error');
    if (state.lastCallDetail) state.lastCallDetail.textContent = `HEARD · ${state.lastCall.heard}\nINTERPRETED · ${description || '—'}\n${phase} · ${resultDetail}`;
    setVoiceFeedback(transcript, `${phase} · ${resultDetail}`, applied ? 'success' : pending ? 'neutral' : 'error');
    root.clearTimeout(state.acknowledgementStageTimer);
    root.clearTimeout(state.commandAcknowledgementTimer);
    if (state.announcement) state.announcement.textContent = '';
    const acknowledgement = commandAcknowledgementTarget();
    const paint = message => {
      if (!acknowledgement) return;
      acknowledgement.textContent = message;
      acknowledgement.setAttribute?.('aria-label', message);
      acknowledgement.title = message;
      acknowledgement.hidden = false;
    };
    if (acknowledgement) {
      const wasActive = acknowledgement.classList?.contains?.('voice-command-ack-active');
      acknowledgement.classList?.remove('voice-command-ack-active');
      if (wasActive) void acknowledgement.offsetWidth;
      acknowledgement.classList?.add('voice-command-ack-active');
    }
    paint(`HEARD · ${description || '—'}`);
    // Execution is immediate. Only the visual transition waits, never the command.
    state.acknowledgementStageTimer = root.setTimeout(() => {
      const message = `${phase} · ${applied ? appliedReply || description : pending ? description : outcome.message}`;
      paint(message);
      if (state.announcement) state.announcement.textContent = message;
    }, 250);
    state.commandAcknowledgementTimer = root.setTimeout(() => {
      if (acknowledgement) {
        acknowledgement.hidden = true;
        acknowledgement.classList?.remove('voice-command-ack-active');
      }
    }, 5500);
  }

  function showPilotReply(reply) {
    const acknowledgement = commandAcknowledgementTarget();
    if (!acknowledgement || !reply?.text) return;
    root.clearTimeout(state.acknowledgementStageTimer);
    root.clearTimeout(state.commandAcknowledgementTimer);
    acknowledgement.textContent = `PILOT · ${reply.text}`;
    acknowledgement.title = acknowledgement.textContent;
    acknowledgement.hidden = false;
    state.commandAcknowledgementTimer = root.setTimeout(() => { acknowledgement.hidden = true; }, 7000);
  }

  function nativeVoiceBridge() {
    const bridge = root.QghNativeVoice;
    if (!bridge) return null;
    return ['getCapability', 'start', 'stop', 'cancel'].every(method => typeof bridge[method] === 'function')
      ? bridge
      : null;
  }

  function clearRestartTimer() {
    root.clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }

  function updateMicState() {
    if (!state.mic) return;
    state.mic.setAttribute('aria-pressed', String(state.pressHeld || (state.listening && !state.processing)));
    state.mic.dataset.listening = String(state.listening && !state.processing);
    state.mic.dataset.processing = String(state.processing);
    state.mic.disabled = ['unavailable', 'downloadable', 'downloading'].includes(state.localAvailability);
    state.mic.textContent = state.continuous && (state.listening || state.starting) ? 'STOP' : (state.continuous ? 'VOICE' : 'PTT');
    state.mic.setAttribute('aria-label', state.continuous
      ? 'Stop or resume continuous local voice listening'
      : 'Press and hold to talk using local voice recognition');
    if (state.continuousInput) {
      state.continuousInput.checked = state.continuous;
      state.continuousInput.disabled = state.localAvailability !== 'ready';
    }
    if (state.prepareButton) {
      state.prepareButton.disabled = state.localAvailability === 'downloading' || Boolean(state.preparePromise);
    }
    if (state.engineNote) state.engineNote.textContent = state.localAvailability === 'permission-denied'
      ? 'MICROPHONE BLOCKED. Allow microphone access in browser site settings, then press PTT to retry. Manual controls remain available.'
      : state.localAvailability === 'ready' ? 'VOICE READY. Speech stays on this device. Hold PTT, speak, then release. Continuous mode is optional.'
      : nativeVoiceBridge() ? 'Preparing the bundled voice model on this device. Manual controls remain available.'
      : 'One-time download: approximately 40 MB, only when you choose Setup. Speech is processed on this device, never uploaded. Manual controls always work.';
    if (state.listeningIndicator) state.listeningIndicator.hidden = !(state.continuous && state.listening && !state.processing);
    positionVoicePopovers();
  }

  function updatePrepareVisibility(visible) {
    if (!state.prepareButton) return;
    state.prepareButton.hidden = !visible;
  }

  function setSettingsOpen(open) {
    if (!state.settings || !state.settingsToggle) return;
    state.settings.hidden = !open;
    state.settingsToggle.setAttribute('aria-expanded', String(open));
    positionVoicePopovers();
  }

  function phoneDock() {
    return Boolean(root.matchMedia?.('(max-width: 600px) and (orientation: portrait)').matches);
  }

  function safeArea() {
    const styles = root.getComputedStyle?.(state.dock);
    const inset = side => Number.parseFloat(styles?.getPropertyValue(`--voice-safe-${side}`)) || 0;
    return { left: Math.max(8, inset('left')), right: Math.max(8, inset('right')), top: Math.max(8, inset('top')), bottom: Math.max(8, inset('bottom')) };
  }

  function positionVoicePopovers() {
    if ([state.settings, state.confirmationPanel].every(panel => !panel || panel.hidden)) return;
    const rect = state.dock?.getBoundingClientRect?.();
    if (!rect) return;
    const safe = safeArea();
    [state.settings, state.confirmationPanel].forEach(panel => {
      if (!panel || panel.hidden) return;
      const size = panel.getBoundingClientRect?.();
      if (!size) return;
      const left = phoneDock() ? rect.left : rect.left > size.width + 16 ? rect.left - size.width - 8 : rect.right + 8;
      const top = phoneDock() ? (rect.top > size.height + 16 ? rect.top - size.height - 8 : rect.bottom + 8) : rect.top;
      panel.style.left = `${Math.max(safe.left, Math.min(left, root.innerWidth - size.width - safe.right))}px`;
      panel.style.top = `${Math.max(safe.top, Math.min(top, root.innerHeight - size.height - safe.bottom))}px`;
    });
  }

  function storedDockPosition() {
    try {
      const value = root.localStorage?.getItem(VOICE_DOCK_POSITION_KEY + (phoneDock() ? '-phone' : ''));
      const parsed = value ? JSON.parse(value) : null;
      if (phoneDock()) return parsed?.edge === 'top' || parsed?.edge === 'bottom' ? parsed : null;
      return Number.isFinite(parsed?.left) && Number.isFinite(parsed?.top) ? parsed : null;
    } catch {
      return null;
    }
  }

  function positionVoiceDock(left, top, persist) {
    const dock = state.dock;
    if (!dock?.style || !Number.isFinite(left) || !Number.isFinite(top)) return;
    const rect = dock.getBoundingClientRect?.();
    const width = Number(rect?.width) || 68;
    const height = Number(rect?.height) || 196;
    const viewportWidth = Number(root.innerWidth);
    const viewportHeight = Number(root.innerHeight);
    const margin = 8;
    const safe = safeArea();
    const maxLeft = Number.isFinite(viewportWidth) && viewportWidth > 0 ? Math.max(safe.left, viewportWidth - width - safe.right) : left;
    const maxTop = Number.isFinite(viewportHeight) && viewportHeight > 0 ? Math.max(safe.top, viewportHeight - height - safe.bottom) : top;
    const safeLeft = Math.round(Math.min(Math.max(safe.left, left), maxLeft));
    const safeTop = Math.round(Math.min(Math.max(safe.top, top), maxTop));
    dock.style.left = `${safeLeft}px`;
    dock.style.top = `${safeTop}px`;
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
    const popupWidth = 260;
    dock.dataset.popoverSide = safeLeft < popupWidth + margin ? 'right' : 'left';
    positionVoicePopovers();
    if (!persist) return;
    try { root.localStorage?.setItem(VOICE_DOCK_POSITION_KEY, JSON.stringify({ left: safeLeft, top: safeTop })); } catch { /* Position persistence is optional. */ }
  }

  function restoreVoiceDockPosition() {
    if (!state.dock) return;
    state.dock.dataset.phone = String(phoneDock());
    ['left', 'top', 'right', 'bottom'].forEach(property => { state.dock.style[property] = ''; });
    const saved = storedDockPosition();
    if (phoneDock()) {
      state.dock.dataset.edge = saved?.edge || 'bottom';
    } else if (saved) positionVoiceDock(saved.left, saved.top, false);
    positionVoicePopovers();
  }

  function resetVoiceDockPosition() {
    try {
      root.localStorage?.removeItem(VOICE_DOCK_POSITION_KEY);
      root.localStorage?.removeItem(VOICE_DOCK_POSITION_KEY + '-phone');
    } catch { /* A temporary position remains usable without storage. */ }
    restoreVoiceDockPosition();
    state.dragHandle?.focus();
  }

  function beginDockDrag(event) {
    const dock = state.dock;
    if (!dock || (event?.button !== undefined && event.button !== 0)) return;
    const rect = dock.getBoundingClientRect?.();
    if (!rect) return;
    state.dockDrag = {
      pointerId: event?.pointerId,
      offsetX: Number(event?.clientX) - rect.left,
      offsetY: Number(event?.clientY) - rect.top
    };
    dock.dataset.dragging = 'true';
    try { state.dragHandle?.setPointerCapture?.(event?.pointerId); } catch { /* Pointer capture is optional. */ }
    event?.preventDefault?.();
  }

  function moveDock(event) {
    const drag = state.dockDrag;
    if (!drag || (drag.pointerId !== undefined && event?.pointerId !== drag.pointerId)) return;
    positionVoiceDock(Number(event?.clientX) - drag.offsetX, Number(event?.clientY) - drag.offsetY, false);
    event?.preventDefault?.();
  }

  function endDockDrag(event) {
    const drag = state.dockDrag;
    if (!drag || (drag.pointerId !== undefined && event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    state.dockDrag = null;
    const dock = state.dock;
    if (dock?.dataset) delete dock.dataset.dragging;
    const left = Number.parseFloat(dock?.style?.left);
    const top = Number.parseFloat(dock?.style?.top);
    if (phoneDock()) {
      const edge = top < root.innerHeight / 2 ? 'top' : 'bottom';
      try { root.localStorage?.setItem(VOICE_DOCK_POSITION_KEY + '-phone', JSON.stringify({ edge })); } catch { /* Optional preference. */ }
      restoreVoiceDockPosition();
      dock.dataset.edge = edge;
      return;
    }
    if (Number.isFinite(left) && Number.isFinite(top)) positionVoiceDock(left, top, true);
  }

  function moveDockByKeyboard(event) {
    const steps = { ArrowUp: [0, -16], ArrowDown: [0, 16], ArrowLeft: [-16, 0], ArrowRight: [16, 0] };
    const movement = steps[event?.key];
    if (!movement) return;
    const rect = state.dock?.getBoundingClientRect?.();
    if (!rect) return;
    event.preventDefault?.();
    if (phoneDock()) {
      state.dock.dataset.edge = event.key === 'ArrowUp' ? 'top' : 'bottom';
      try { root.localStorage?.setItem(VOICE_DOCK_POSITION_KEY + '-phone', JSON.stringify({ edge: state.dock.dataset.edge })); } catch { /* Optional preference. */ }
      restoreVoiceDockPosition();
      return;
    }
    positionVoiceDock(Number(rect.left) + movement[0], Number(rect.top) + movement[1], true);
  }

  function emitChange(element, type) {
    element.dispatchEvent(new root.Event(type, { bubbles: true }));
  }

  function markVoiceAffected(element) {
    if (!element?.classList) return;
    if (state.effectBatch) { state.effectBatch.add(element); return; }
    const priorTimer = voiceEffectTimers.get(element);
    if (priorTimer !== undefined) root.clearTimeout(priorTimer);
    const wasActive = element.classList?.contains?.('voice-command-effect');
    element.classList.remove('voice-command-effect');
    // A repeated instruction can target the same control before its prior pulse ends.
    // Force a fresh visual transition so the controller can see every accepted RT call.
    if (wasActive) void element.offsetWidth;
    element.classList.add('voice-command-effect');
    const timer = root.setTimeout(() => {
      element.classList?.remove('voice-command-effect');
      voiceEffectTimers.delete(element);
    }, 1800);
    voiceEffectTimers.set(element, timer);
  }

  function applyInputValue(element, value, events) {
    if (!element || element.disabled) return result(false, 'CONTROL IS NOT AVAILABLE');
    const numeric = Number(value);
    if (element.type === 'number') {
      if (!Number.isFinite(numeric)) return result(false, 'INVALID VALUE');
      const minimum = Number(element.min);
      const maximum = Number(element.max);
      if (element.min !== '' && numeric < minimum) return result(false, 'VALUE IS OUT OF RANGE');
      if (element.max !== '' && numeric > maximum) return result(false, 'VALUE IS OUT OF RANGE');
      const stepText = element.getAttribute('step');
      const step = Number(stepText);
      if (stepText && Number.isFinite(step) && step > 0) {
        const base = element.min === '' ? 0 : minimum;
        const steps = (numeric - base) / step;
        if (Math.abs(steps - Math.round(steps)) > 1e-7) return result(false, 'VALUE DOES NOT MATCH CONTROL STEP');
      }
    }
    element.value = String(value);
    (events || []).forEach(type => emitChange(element, type));
    markVoiceAffected(element);
    return result(true, 'VALUE SET');
  }

  function applySelectValue(element, value) {
    if (!element) return result(false, 'CONTROL IS NOT AVAILABLE');
    element.value = String(value);
    emitChange(element, 'change');
    markVoiceAffected(element);
    return result(true, 'VALUE SELECTED');
  }

  function applyHeading(element, heading) {
    return applyInputValue(element, heading === 360 ? 0 : heading, []);
  }

  function applyFieldValue(field, element, value, events) {
    return ['runway', 'inbound', 'outbound', 'heading'].includes(field)
      ? applyHeading(element, value)
      : applyInputValue(element, value, events);
  }

  function clickElement(element, label) {
    if (!isAvailable(element)) return result(false, `${label || 'CONTROL'} IS NOT AVAILABLE`);
    markVoiceAffected(element);
    element.click();
    return result(true, label || buttonText(element));
  }

  function clickId(id, label) {
    return clickElement($(id), label);
  }

  function isHidden(element) {
    return Boolean(element?.hidden || element?.closest('[hidden]'));
  }

  function requireActiveScreen(screen, message) {
    return activeScreen(screen) ? null : result(false, message || 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
  }

  function tacticalRows() {
    return Array.from(documentRef.querySelectorAll('.tactical-aircraft-row'));
  }

  function tacticalCallsignOptions() {
    return tacticalRows().map(row => {
      const callsign = row.querySelector('[data-tactical-field="callsign"]');
      return { id: row.dataset.aircraftId, callsign: callsign?.value || row.dataset.aircraftId };
    });
  }

  function singleCallsign() {
    return String((!activeScreen('setup') && $('console')?.dataset.callsign) || $('callsign')?.value || 'FALCON 11').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function voiceCallsignOptions() {
    return pageKind() === 'single' ? [{ id: 'single', callsign: singleCallsign() }] : tacticalCallsignOptions();
  }

  function availableProfileOptions() {
    const profileValues = {};
    const selectors = pageKind() === 'tactical'
      ? '[data-tactical-field="profile"]'
      : '#aircraft';
    documentRef.querySelectorAll(selectors).forEach(select => {
      Array.from(select.options || []).forEach(option => {
        const value = String(option.value || '').trim();
        if (!value) return;
        [value, option.textContent].forEach(label => {
          const spoken = Voice.normalizeTranscript(label || '');
          if (spoken) profileValues[spoken] = value;
        });
      });
    });
    return profileValues;
  }

  function tacticalId(reference) {
    const rows = tacticalRows();
    const value = String(reference || '');
    const direct = rows.find(row => row.dataset.aircraftId === value);
    if (direct) return direct.dataset.aircraftId;
    return null;
  }

  function tacticalRow(reference) {
    const id = tacticalId(reference);
    return id ? tacticalRows().find(row => row.dataset.aircraftId === id) || null : null;
  }

  function tacticalCallsign(reference) {
    const row = tacticalRow(reference);
    return row?.querySelector('[data-tactical-field="callsign"]')?.value || String(reference || 'AIRCRAFT');
  }

  function useTacticalRailControl(reference, selector, label) {
    const id = tacticalId(reference);
    const railItem = id && documentRef.querySelector(`.tactical-rail-item[data-aircraft-id="${id}"]`);
    return clickElement(railItem?.querySelector(selector), `${tacticalCallsign(id)} ${label}`);
  }

  function selectTacticalAircraft(reference) {
    return useTacticalRailControl(reference, '.tactical-rail-select', 'SELECTED');
  }

  function transmitTacticalAircraft(reference) {
    return useTacticalRailControl(reference, '.tactical-rail-tx', 'D/F TRANSMIT');
  }

  function setSingleField(command) {
    const onSetup = activeScreen('setup');
    const onConsole = activeScreen('console');
    if (onSetup) {
      const setupFields = {
        runway: 'runway',
        inbound: 'inbound',
        outbound: 'outbound',
        distance: 'distance',
        speed: 'speed',
        'turn-rate': 'rate'
      };
      const field = setupFields[command.field];
      if (!field) return result(false, 'FIELD IS NOT AVAILABLE IN SETUP');
      const change = applyFieldValue(command.field, $(field), command.value, []);
      return change.ok ? result(true, `${command.field.toUpperCase()} SET`) : change;
    }
    if (onConsole && command.field === 'heading') {
      if (isHidden($('headingInput')) || !isAvailable($('headingInput'))) {
        return result(false, 'HEADING ENTRY IS NOT AVAILABLE IN U/S COMPASS');
      }
      const change = applyHeading($('headingInput'), command.value);
      return change.ok ? result(true, `HEADING ${String(command.value).padStart(3, '0')}° SET`) : change;
    }
    if (onConsole && command.field === 'speed') {
      const change = applyInputValue($('liveSpeed'), command.value, ['input', 'change']);
      return change.ok ? result(true, `SPEED ${command.value} KT SET`) : change;
    }
    return result(false, 'FIELD IS NOT AVAILABLE ON THIS SCREEN');
  }

  function setTacticalField(command) {
    const setupRequired = requireActiveScreen('tSetup');
    if (setupRequired) return setupRequired;
    const setupFields = {
      runway: 'tRunway',
      inbound: 'tInbound',
      outbound: 'tOutbound'
    };
    const id = setupFields[command.field];
    if (!id) return result(false, 'FIELD REQUIRES AN AIRCRAFT CALLSIGN');
    const change = applyFieldValue(command.field, $(id), command.value, []);
    return change.ok ? result(true, `${command.field.toUpperCase()} SET`) : change;
  }

  function runReviewCommand(command, tactical) {
    const required = requireActiveScreen(tactical ? 'tAnalysis' : 'analysis');
    if (required) return required;
    const replay = $(tactical ? 'tReplay' : 'replay');
    const zoom = $(tactical ? 'tZoomToggle' : 'zoomToggle');
    const canvas = $(tactical ? 'tTacticalPlot' : 'plot');
    const replaySpeedSelector = tactical ? '[data-tactical-replay-speed]' : '[data-replay-speed]';

    if (command.intent === 'replay-play') {
      return replay?.getAttribute('aria-pressed') === 'true'
        ? result(true, 'REPLAY ALREADY RUNNING')
        : clickElement(replay, 'REPLAY STARTED');
    }
    if (command.intent === 'replay-pause') {
      return replay?.getAttribute('aria-pressed') === 'true'
        ? clickElement(replay, 'REPLAY PAUSED')
        : result(true, 'REPLAY ALREADY PAUSED');
    }
    if (command.intent === 'set-replay-speed') {
      const control = documentRef.querySelector(`${replaySpeedSelector}[data-${tactical ? 'tactical-' : ''}replay-speed="${command.speed}"]`);
      return clickElement(control, `REPLAY SPEED ${command.speed}×`);
    }
    if (command.intent === 'review-zoom') {
      const enabled = zoom?.getAttribute('aria-pressed') === 'true';
      return enabled === command.enabled
        ? result(true, command.enabled ? 'ZOOM ALREADY ON' : 'ZOOM ALREADY OFF')
        : clickElement(zoom, command.enabled ? 'ZOOM ON' : 'ZOOM OFF');
    }
    if (command.intent === 'review-zoom-step') {
      if (zoom?.getAttribute('aria-pressed') !== 'true') clickElement(zoom, 'ZOOM ON');
      if (!canvas) return result(false, 'TRACK VIEW IS NOT AVAILABLE');
      canvas.focus({ preventScroll: true });
      canvas.dispatchEvent(new root.KeyboardEvent('keydown', {
        key: command.direction === 'in' ? '+' : '-', bubbles: true, cancelable: true
      }));
      return result(true, `ZOOM ${command.direction.toUpperCase()}`);
    }
    if (command.intent === 'review-pan') {
      if (zoom?.getAttribute('aria-pressed') !== 'true') return result(false, 'ENABLE ZOOM BEFORE PANNING');
      const keys = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
      if (!canvas || !keys[command.direction]) return result(false, 'TRACK VIEW IS NOT AVAILABLE');
      canvas.focus({ preventScroll: true });
      canvas.dispatchEvent(new root.KeyboardEvent('keydown', {
        key: keys[command.direction], bubbles: true, cancelable: true
      }));
      return result(true, `VIEW PANNED ${command.direction.toUpperCase()}`);
    }
    if (command.intent === 'fit-review') return clickId(tactical ? 'tFitReview' : 'fitReview', 'TRACK FIT');
    if (command.intent === 'return-console') return clickId(tactical ? 'tReturnConsole' : 'returnConsole', 'RETURNING TO CONSOLE');
    if (command.intent === 'new-exercise') return clickId(tactical ? 'tNewExercise' : 'newExercise', 'NEW EXERCISE');
    if (tactical && command.intent === 'focus-all-aircraft') return clickId('tFocusAll', 'ALL AIRCRAFT FOCUSED');
    if (tactical && command.intent === 'focus-aircraft') {
      const callsign = tacticalCallsign(command.aircraft);
      const control = Array.from(documentRef.querySelectorAll('.tactical-legend-item')).find(button => (
        Voice.normalizeTranscript(button.querySelector('strong')?.textContent || '') === Voice.normalizeTranscript(callsign)
      ));
      return clickElement(control, `${callsign} FOCUSED`);
    }
    return result(false, 'COMMAND IS NOT AVAILABLE IN REVIEW');
  }

  function runSingleCommand(command) {
    if (command.aircraft && command.aircraft !== 'single') return result(false, 'AIRCRAFT CALLSIGN DOES NOT MATCH THIS EXERCISE');
    if (command.intent === 'return-to-mode-selection') {
      root.location.assign('index.html');
      return result(true, 'OPENING QGH TYPE SELECTION');
    }
    if (command.intent === 'set-listening-mode') return setListeningMode(command.mode);
    if (command.intent === 'set-procedure') {
      const required = requireActiveScreen('setup');
      return required || clickId(command.procedure === 'us' ? 'us' : 'normal', `${command.procedure === 'us' ? 'U/S COMPASS' : 'NORMAL QGH'} SELECTED`);
    }
    if (command.intent === 'set-field') return setSingleField(command);
    if (command.intent === 'set-aircraft-field') return setSingleField(command);
    if (command.intent === 'set-aircraft-profile') {
      const required = requireActiveScreen('setup');
      if (required) return required;
      const aircraft = $('aircraft');
      if (!aircraft?.querySelector(`option[value="${command.profile}"]`)) return result(false, 'AIRCRAFT PROFILE IS NOT AVAILABLE');
      const selected = applySelectValue(aircraft, command.profile);
      return selected.ok ? result(true, 'AIRCRAFT PROFILE SELECTED') : selected;
    }
    if (command.intent === 'start-exercise') {
      const required = requireActiveScreen('setup');
      return required || clickId('startExercise', 'SIMULATOR STARTED');
    }
    if (activeScreen('analysis')) return runReviewCommand(command, false);
    if (!activeScreen('console')) return result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');

    if (command.intent === 'set-bearing-mode') return clickId(command.mode, `${command.mode.toUpperCase()} SELECTED`);
    if (command.intent === 'transmit-df') {
      if (command.mode) {
        const mode = clickId(command.mode, `${command.mode.toUpperCase()} SELECTED`);
        if (!mode.ok) return mode;
      }
      return clickId('transmit', 'D/F TRANSMIT');
    }
    if (command.intent === 'report-heading') return clickId('requestHeading', 'HEADING REQUESTED');
    if (command.intent === 'start-orbit') return clickId(command.side === 'left' ? 'orbitLeft' : 'orbitRight', `ORBIT ${command.side.toUpperCase()}`);
    if (command.intent === 'continue-orbit') return clickId('continueOrbit', 'CONTINUING ORBIT');
    if (command.intent === 'resume-normal') return clickId('resumeNormal', 'RESUME NORMAL AFTER ORBIT');
    if (command.intent === 'request-distance') return clickId('requestDistance', 'DISTANCE REQUESTED');
    if (command.intent === 'normal-turn-heading') {
      if (isHidden($('turnHeadingLeft'))) return result(false, 'HEADING TURNS ARE NOT AVAILABLE IN U/S COMPASS');
      const turnControl = $(command.side === 'left' ? 'turnHeadingLeft' : 'turnHeadingRight');
      if (!isAvailable(turnControl)) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      const heading = applyHeading($('headingInput'), command.heading);
      return heading.ok ? clickElement(turnControl, `TURN ${command.side.toUpperCase()} ${String(command.heading).padStart(3, '0')}°`) : heading;
    }
    if (command.intent === 'continue-turn-heading') {
      if (isHidden($('turnHeadingLeft'))) return result(false, 'CONTINUE HEADING IS NOT AVAILABLE IN U/S COMPASS');
      const continueControl = $('continueHeading');
      if (!isAvailable(continueControl)) return result(false, 'CONTINUE TURN IS NOT AVAILABLE');
      const heading = applyHeading($('headingInput'), command.heading);
      if (!heading.ok) return heading;
      const side = continueControl.dataset.turnSide;
      if (side === 'left' || side === 'right') markVoiceAffected($(side === 'left' ? 'turnHeadingLeft' : 'turnHeadingRight'));
      return clickElement(continueControl, `CONTINUE ACTIVE TURN ${String(command.heading).padStart(3, '0')}°`);
    }
    if (command.intent === 'us-turn') {
      if (isHidden($('turnLeft'))) return result(false, 'U/S TURNS ARE NOT AVAILABLE IN NORMAL QGH');
      const turnControl = $(command.side === 'left' ? 'turnLeft' : 'turnRight');
      if (!isAvailable(turnControl)) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      return clickElement(turnControl, `TURN ${command.side.toUpperCase()} NOW`);
    }
    if (command.intent === 'us-turn-stop') return clickId('turnStop', 'TURN STOPPED');
    if (command.intent === 'clock') return clickId(`clock${command.action[0].toUpperCase()}${command.action.slice(1)}`, `CLOCK ${command.action.toUpperCase()}`);
    if (command.intent === 'advance-flight') return clickId('advanceFlight', 'FLIGHT ADVANCED ONE MINUTE');
    if (command.intent === 'restart-exercise') return clickId('restartExercise', 'EXERCISE RESTARTED');
    if (command.intent === 'mobile-controls') {
      const toggle = $('mobileControlsToggle');
      const expanded = toggle?.getAttribute('aria-expanded') === 'true';
      return expanded === command.expanded ? result(true, command.expanded ? 'CONTROLS SHOWN' : 'CONTROLS HIDDEN') : clickElement(toggle, command.expanded ? 'CONTROLS SHOWN' : 'CONTROLS HIDDEN');
    }
    if (command.intent === 'terminate-exercise') return clickId('terminate', 'TERMINATION CONFIRMATION OPEN');
    if (command.intent === 'confirm-termination') {
      return $('terminateDialog')?.open ? clickId('confirmTerminate', 'EXERCISE TERMINATED') : result(false, 'NO TERMINATION CONFIRMATION IS OPEN');
    }
    if (command.intent === 'cancel-termination') {
      return $('terminateDialog')?.open ? clickId('cancelTerminate', 'EXERCISE CONTINUED') : result(false, 'NO TERMINATION CONFIRMATION IS OPEN');
    }
    return result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
  }

  function runTacticalCommand(command) {
    if (command.intent === 'return-to-mode-selection') {
      root.location.assign('index.html');
      return result(true, 'OPENING QGH TYPE SELECTION');
    }
    if (command.intent === 'set-listening-mode') return setListeningMode(command.mode);
    if (activeScreen('tAnalysis')) return runReviewCommand(command, true);

    if (activeScreen('tSetup')) {
      if (command.intent === 'set-procedure') return clickId(command.procedure === 'us' ? 'tProcedureUs' : 'tProcedureNormal', `${command.procedure === 'us' ? 'U/S COMPASS' : 'NORMAL QGH'} SELECTED`);
      if (command.intent === 'set-field') return setTacticalField(command);
      if (command.intent === 'set-fleet-size') return clickId(`tFleet${command.count}`, `${command.count} AIRCRAFT SELECTED`);
      if (command.intent === 'set-aircraft-callsign') {
        const row = tacticalRow(command.aircraft);
        const field = row?.querySelector('[data-tactical-field="callsign"]');
        const change = applyInputValue(field, command.callsign, ['input', 'change']);
        return change.ok ? result(true, `${command.callsign} SET`) : change;
      }
      if (command.intent === 'set-aircraft-profile') {
        const row = tacticalRow(command.aircraft);
        const field = row?.querySelector('[data-tactical-field="profile"]');
        if (!field || !field.querySelector(`option[value="${command.profile}"]`)) return result(false, 'AIRCRAFT PROFILE IS NOT AVAILABLE');
        const selected = applySelectValue(field, command.profile);
        return selected.ok ? result(true, `${tacticalCallsign(command.aircraft)} PROFILE SELECTED`) : selected;
      }
      if (command.intent === 'set-aircraft-field') {
        const row = tacticalRow(command.aircraft);
        const names = { speed: 'speed', distance: 'distance', 'turn-rate': 'rate', level: 'level' };
        const field = row?.querySelector(`[data-tactical-field="${names[command.field] || ''}"]`);
        const change = applyInputValue(field, command.value, ['input', 'change']);
        return change.ok ? result(true, `${tacticalCallsign(command.aircraft)} ${command.field.toUpperCase()} SET`) : change;
      }
      if (command.intent === 'set-formation') return clickId(command.enabled ? 'tFormationOn' : 'tFormationOff', command.enabled ? 'FORMATION ON' : 'FORMATION OFF');
      if (command.intent === 'set-formation-leader') {
        const id = tacticalId(command.aircraft);
        const leader = $('tFormationLeader');
        if (!isAvailable(leader) || !id) return result(false, 'FORMATION LEADER IS NOT AVAILABLE');
        const selected = applySelectValue(leader, id);
        return selected.ok ? result(true, `${tacticalCallsign(id)} IS FORMATION LEADER`) : selected;
      }
      if (command.intent === 'toggle-formation-member') {
        const callsign = tacticalCallsign(command.aircraft);
        const chip = Array.from(documentRef.querySelectorAll('.tactical-member-chip')).find(button => (
          Voice.normalizeTranscript(button.textContent) === Voice.normalizeTranscript(callsign)
        ));
        return clickElement(chip, `${callsign} FORMATION MEMBERSHIP UPDATED`);
      }
      if (command.intent === 'set-formation-member') {
        const callsign = tacticalCallsign(command.aircraft);
        const chip = Array.from(documentRef.querySelectorAll('.tactical-member-chip')).find(button => (
          Voice.normalizeTranscript(button.textContent) === Voice.normalizeTranscript(callsign)
        ));
        if (!chip) return result(false, 'FORMATION MEMBER IS NOT AVAILABLE');
        const included = chip.getAttribute('aria-pressed') === 'true';
        if (included === command.enabled) return result(true, `${callsign} ALREADY ${included ? 'IN' : 'OUT OF'} FORMATION`);
        return clickElement(chip, `${callsign} ${command.enabled ? 'ADDED TO' : 'REMOVED FROM'} FORMATION`);
      }
      if (command.intent === 'start-exercise') return clickId('tStart', 'TACTICAL EXERCISE STARTED');
      return result(false, 'COMMAND IS NOT AVAILABLE IN TACTICAL SETUP');
    }

    if (!activeScreen('tConsole')) return result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
    if (command.aircraft && !tacticalId(command.aircraft)) return result(false, 'AIRCRAFT IS NOT AVAILABLE');
    const callsignRequired = new Set([
      'transmit-df', 'normal-turn-heading', 'continue-turn-heading', 'us-turn', 'us-turn-stop',
      'report-heading', 'request-distance', 'set-field', 'set-aircraft-field', 'stop-following-leader', 'start-orbit', 'continue-orbit', 'resume-normal'
    ]);
    if (callsignRequired.has(command.intent) && !command.aircraft) {
      return result(false, 'SAY THE AIRCRAFT CALLSIGN FOR A TACTICAL COMMAND');
    }
    if (command.intent === 'select-aircraft') return selectTacticalAircraft(command.aircraft);
    if (['start-orbit', 'continue-orbit', 'resume-normal'].includes(command.intent)) {
      const selected = selectTacticalAircraft(command.aircraft);
      if (!selected.ok) return selected;
      const control = command.intent === 'continue-orbit' ? 'tContinueOrbit' : command.intent === 'resume-normal' ? 'tResumeNormal'
        : command.side === 'left' ? 'tOrbitLeft' : 'tOrbitRight';
      return clickId(control, 'ORBIT COMMAND ACCEPTED');
    }
    if (command.intent === 'set-bearing-mode') return clickId(command.mode === 'qdm' ? 'tQdm' : 'tQte', `${command.mode.toUpperCase()} SELECTED`);
    if (command.intent === 'transmit-df') {
      if (command.mode) {
        const mode = clickId(command.mode === 'qdm' ? 'tQdm' : 'tQte', `${command.mode.toUpperCase()} SELECTED`);
        if (!mode.ok) return mode;
      }
      return command.aircraft ? transmitTacticalAircraft(command.aircraft) : clickId('tTransmit', 'D/F TRANSMIT');
    }
    if (command.intent === 'normal-turn-heading') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      if (isHidden($('tTurnLeft'))) return result(false, 'HEADING TURNS ARE NOT AVAILABLE IN U/S COMPASS');
      const turnControl = $(command.side === 'left' ? 'tTurnLeft' : 'tTurnRight');
      if (!isAvailable(turnControl)) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      const heading = applyHeading($('tHeadingInput'), command.heading);
      return heading.ok ? clickElement(turnControl, `TURN ${command.side.toUpperCase()} ${String(command.heading).padStart(3, '0')}°`) : heading;
    }
    if (command.intent === 'continue-turn-heading') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      if (isHidden($('tTurnLeft'))) return result(false, 'CONTINUE HEADING IS NOT AVAILABLE IN U/S COMPASS');
      const continueControl = $('tContinueHeading');
      if (!isAvailable(continueControl)) return result(false, 'CONTINUE TURN IS NOT AVAILABLE');
      const heading = applyHeading($('tHeadingInput'), command.heading);
      if (!heading.ok) return heading;
      const side = continueControl.dataset.turnSide;
      if (side === 'left' || side === 'right') markVoiceAffected($(side === 'left' ? 'tTurnLeft' : 'tTurnRight'));
      return clickElement(continueControl, `CONTINUE ACTIVE TURN ${String(command.heading).padStart(3, '0')}°`);
    }
    if (command.intent === 'us-turn') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      if (isHidden($('tUsLeft'))) return result(false, 'U/S TURNS ARE NOT AVAILABLE IN NORMAL QGH');
      const turnControl = $(command.side === 'left' ? 'tUsLeft' : 'tUsRight');
      if (!isAvailable(turnControl)) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      return clickElement(turnControl, `TURN ${command.side.toUpperCase()} NOW`);
    }
    if (command.intent === 'us-turn-stop') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      return clickId('tUsStop', 'TURN STOPPED');
    }
    if (command.intent === 'report-heading') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      return clickId('tRequestHeading', 'HEADING REQUESTED');
    }
    if (command.intent === 'request-distance') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      return clickId('tRequestDistance', 'DISTANCE REQUESTED');
    }
    if (command.intent === 'set-aircraft-field' && command.field === 'speed') {
      const selected = selectTacticalAircraft(command.aircraft);
      if (!selected.ok) return selected;
      const change = applyInputValue($('tLiveSpeed'), command.value, ['input', 'change']);
      return change.ok ? result(true, `${tacticalCallsign(command.aircraft)} SPEED ${command.value} KT SET`) : change;
    }
    if (command.intent === 'clock') return clickId(`tClock${command.action[0].toUpperCase()}${command.action.slice(1)}`, `CLOCK ${command.action.toUpperCase()}`);
    if (command.intent === 'advance-flight') return clickId('tAdvance', 'FLIGHT ADVANCED ONE MINUTE');
    if (command.intent === 'restart-exercise') return clickId('tRestart', 'EXERCISE RESTARTED');
    if (command.intent === 'stop-following-leader') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      return clickId('tStopFollowing', 'FORMATION FOLLOWING STOPPED');
    }
    if (command.intent === 'terminate-exercise') return clickId('tTerminate', 'TERMINATION CONFIRMATION OPEN');
    if (command.intent === 'confirm-termination') {
      return $('tTerminateDialog')?.open ? clickId('tConfirmTerminate', 'EXERCISE TERMINATED') : result(false, 'NO TERMINATION CONFIRMATION IS OPEN');
    }
    if (command.intent === 'cancel-termination') {
      return $('tTerminateDialog')?.open ? clickId('tCancelTerminate', 'EXERCISE CONTINUED') : result(false, 'NO TERMINATION CONFIRMATION IS OPEN');
    }
    return result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
  }

  function runEntryCommand(command) {
    if (command.intent === 'select-simulator-mode') {
      root.location.assign(command.mode === 'tactical' ? 'tactical.html' : 'single.html');
      return result(true, command.mode === 'tactical' ? 'OPENING TACTICAL QGH' : 'OPENING SINGLE AIRCRAFT QGH');
    }
    if (command.intent === 'set-listening-mode') return setListeningMode(command.mode);
    return result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
  }

  function runCommand(command) {
    if (!command?.accepted) return result(false, 'COMMAND NOT RECOGNISED');
    if (command.intent === 'request-heading-passing') {
      const tactical = pageKind() === 'tactical';
      if (!activeScreen(tactical ? 'tConsole' : 'console')) return result(false, 'START AN EXERCISE FIRST');
      const targets = voiceCallsignOptions();
      const aircraft = targets.find(item => item.id === command.aircraft) || (!tactical && !command.aircraft ? targets[0] : null);
      if (!aircraft) return result(false, 'AIRCRAFT CALLSIGN REQUIRED');
      const outcome = root.QGHRadioWorkspace?.requestHeadingPassing({ ...command, aircraft: aircraft.id });
      if (outcome?.ok) markVoiceAffected($(tactical ? 'tRequestHeading' : 'requestHeading'));
      return outcome || result(false, 'HEADING PASSING REPORT UNAVAILABLE');
    }
    if (command.intent === 'radio-exchange') {
      const tactical = pageKind() === 'tactical';
      if (!activeScreen(tactical ? 'tConsole' : 'console')) return result(false, 'RT CALLS ARE AVAILABLE DURING THE EXERCISE');
      const targets = voiceCallsignOptions();
      const aircraft = targets.find(item => item.id === command.aircraft) || (!tactical && !command.aircraft ? targets[0] : null);
      if (!aircraft) return result(false, 'AIRCRAFT CALLSIGN REQUIRED');
      const reply = root.QGHRadioSession?.replyFor(command, aircraft);
      return reply ? result(true, reply.text) : result(false, 'RT CALL NOT AVAILABLE');
    }
    const effects = new Set();
    state.effectBatch = effects;
    let outcome;
    try {
      outcome = pageKind() === 'single' ? runSingleCommand(command)
        : pageKind() === 'tactical' ? runTacticalCommand(command) : runEntryCommand(command);
    } finally { state.effectBatch = null; }
    if (outcome.ok) effects.forEach(markVoiceAffected);
    return outcome;
  }

  function clearPendingVoiceCommand() {
    const restoreFocus = state.confirmationPanel?.contains?.(documentRef.activeElement);
    root.clearTimeout(state.pendingTimer);
    state.pendingCommand = null;
    state.pendingContext = null;
    state.pendingTimer = null;
    if (state.confirmationPanel) state.confirmationPanel.hidden = true;
    if (restoreFocus) state.mic?.focus();
    updateMicState();
  }

  function canQueueVoiceConfirmation(command) {
    if (command.intent === 'select-simulator-mode') {
      return pageKind() === 'entry'
        ? result(true, 'COMMAND AVAILABLE')
        : result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
    }
    if (command.intent === 'set-aircraft-callsign') {
      const row = tacticalRow(command.aircraft);
      const field = row?.querySelector('[data-tactical-field="callsign"]');
      return pageKind() === 'tactical' && activeScreen('tSetup') && isAvailable(field)
        ? result(true, 'COMMAND AVAILABLE')
        : result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
    }
    if (command.intent === 'restart-exercise') {
      const control = pageKind() === 'tactical' ? $('tRestart') : $('restartExercise');
      const screen = pageKind() === 'tactical' ? 'tConsole' : 'console';
      return activeScreen(screen) && isAvailable(control)
        ? result(true, 'COMMAND AVAILABLE')
        : result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
    }
    if (command.intent === 'new-exercise') {
      const tactical = pageKind() === 'tactical';
      const control = $(tactical ? 'tNewExercise' : 'newExercise');
      return activeScreen(tactical ? 'tAnalysis' : 'analysis') && isAvailable(control)
        ? result(true, 'COMMAND AVAILABLE')
        : result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
    }
    return result(true, 'COMMAND AVAILABLE');
  }

  function queueVoiceConfirmation(command) {
    const available = canQueueVoiceConfirmation(command);
    if (!available.ok) return available;
    state.pendingCommand = command;
    state.pendingContext = currentVoiceContext();
    const description = describeWorkspaceVoiceCommand(command);
    if (state.confirmationDetail) state.confirmationDetail.textContent = `HEARD · ${description}`;
    if (state.confirmationPanel) state.confirmationPanel.hidden = false;
    updateMicState();
    state.pendingTimer = root.setTimeout(() => {
      if (state.pendingCommand !== command) return;
      clearPendingVoiceCommand();
      setStatus('VOICE COMMAND EXPIRED', 'error');
    }, VOICE_CONFIRMATION_WINDOW_MS);
    return result(true, `CONFIRM · ${description}`);
  }

  function pendingVoiceResponse(transcript, command) {
    if (command?.intent === 'confirm-voice-command') return 'confirm';
    if (command?.intent === 'cancel-voice-command') return 'cancel';
    const normalized = Voice.normalizeTranscript(transcript);
    if (['yes', 'confirm', 'proceed', 'go ahead', 'execute'].includes(normalized)) return 'confirm';
    if (['no', 'cancel', 'reject', 'ignore'].includes(normalized)) return 'cancel';
    return null;
  }

  function commandPreemptsPendingConfirmation(command) {
    if (!command?.accepted) return false;
    if (command.intent === 'clock') return command.action === 'stop';
    return new Set([
      'normal-turn-heading', 'continue-turn-heading', 'us-turn', 'us-turn-stop',
      'start-orbit', 'continue-orbit', 'resume-normal', 'transmit-df',
      'report-heading', 'request-distance', 'advance-flight'
    ]).has(command.intent);
  }

  function confirmPendingVoiceCommand() {
    const command = state.pendingCommand;
    if (!command) return result(false, 'NO VOICE COMMAND AWAITS CONFIRMATION');
    if (state.pendingContext !== currentVoiceContext()) {
      clearPendingVoiceCommand();
      setStatus('VOICE COMMAND EXPIRED AFTER SCREEN CHANGE', 'error');
      return result(false, 'VOICE COMMAND EXPIRED AFTER SCREEN CHANGE');
    }
    clearPendingVoiceCommand();
    const outcome = runCommand(command);
    setStatus(outcome.message, outcome.ok ? 'success' : 'error');
    presentVoiceResult(command, outcome, state.lastCall?.heard || command.intent);
    return outcome;
  }

  function cancelPendingVoiceCommand() {
    if (!state.pendingCommand) return result(false, 'NO VOICE COMMAND AWAITS CONFIRMATION');
    const command = state.pendingCommand;
    clearPendingVoiceCommand();
    setStatus('VOICE COMMAND CANCELLED', 'neutral');
    const outcome = result(true, 'VOICE COMMAND CANCELLED');
    presentVoiceResult(command, outcome, state.lastCall?.heard || command.intent);
    return outcome;
  }

  function dispatchTranscript(transcript) {
    if (pilotBlocksMicrophone()) return result(false, 'PILOT TRANSMITTING');
    const radio = activeScreen(pageKind() === 'tactical' ? 'tConsole' : 'console')
      ? root.QGHRadioSession?.parseMessage(transcript, Voice, { callsigns: voiceCallsignOptions(), single: pageKind() === 'single' }) : null;
    const command = radio || Voice.parseCommand(transcript, {
      callsigns: voiceCallsignOptions(),
      profiles: availableProfileOptions()
    });
    const sequence = state.feedbackSequence;
    let outcome;
    state.dispatchingRadioCommand = true;
    try { outcome = routeTranscript(transcript, command); }
    finally { state.dispatchingRadioCommand = false; }
    if (sequence === state.feedbackSequence) presentVoiceResult(command, outcome, transcript);
    if (outcome.ok && !state.pendingCommand) root.QGHRadioWorkspace?.acknowledge(command);
    return outcome;
  }

  function routeTranscript(transcript, command) {
    if (state.pendingCommand) {
      const response = pendingVoiceResponse(transcript, command);
      if (response === 'confirm') return confirmPendingVoiceCommand();
      if (response === 'cancel') return cancelPendingVoiceCommand();
      if (commandPreemptsPendingConfirmation(command)) {
        clearPendingVoiceCommand();
      } else {
        setStatus('CONFIRM OR CANCEL THE PENDING VOICE COMMAND', 'error');
        return result(false, 'CONFIRM OR CANCEL THE PENDING VOICE COMMAND');
      }
    }
    if (!command.accepted) {
      setStatus('COMMAND NOT RECOGNISED', 'error');
      return result(false, 'COMMAND NOT RECOGNISED');
    }
    if (command.intent === 'confirm-voice-command' || command.intent === 'cancel-voice-command') {
      const noPending = result(false, 'NO VOICE COMMAND AWAITS CONFIRMATION');
      setStatus(noPending.message, 'error');
      return noPending;
    }
    if (typeof Voice.requiresVoiceConfirmation === 'function' && Voice.requiresVoiceConfirmation(command)) {
      const pending = queueVoiceConfirmation(command);
      setStatus(pending.message, 'active');
      return pending;
    }
    const outcome = runCommand(command);
    setStatus(outcome.message, outcome.ok ? 'success' : 'error');
    return outcome;
  }

  function scheduleContinuousRestart() {
    if (!canContinueListening() || state.listening || state.starting || state.restartTimer) return;
    clearRestartTimer();
    state.restartTimer = root.setTimeout(() => {
      state.restartTimer = null;
      if (canContinueListening() && !state.listening && !state.starting) beginListening(true);
    }, 180);
  }

  // The browser path below is deliberately independent of browser-provider speech services. Windows and
  // the PWA use the bundled Vosk WebAssembly worker; Android presents the same contract
  // through its bundled Vosk bridge.
  function grammarContext() {
    return {
      screen: currentVoiceContext(),
      procedure: currentProcedure(),
      callsigns: voiceCallsignOptions()
    };
  }

  function recognitionContextSignature() {
    const context = grammarContext();
    const callsigns = context.callsigns.map(item => `${item.id || ''}:${item.callsign || item}`).join('\u0001');
    return [context.screen, context.procedure, callsigns].join('\u0000');
  }

  function reconfigureRecognitionContext(signature) {
    if (!signature || signature === state.recognitionContext) return;
    state.recognitionContext = signature;
    const resumeContinuous = state.continuous && !state.manuallyStopped && !pilotBlocksMicrophone();
    // A capture opened for another screen, procedure or callsign roster cannot
    // be allowed to finalize later against the new exercise context.
    state.startAttempt += 1;
    state.nativeRequestId = null;
    state.nativeResultReceived = false;
    state.lastNativeGrammarJson = null;
    state.callTranscripts.clear();
    state.lastTranscript = '';
    state.lastTranscriptAt = 0;
    state.processing = false;
    state.starting = false;
    state.listening = false;
    clearRestartTimer();
    root.clearTimeout(state.radioQuietTimer);
    state.radioQuietTimer = null;
    clearPendingVoiceCommand();
    try {
      if (nativeVoiceBridge()) nativeVoiceBridge().cancel();
      else state.engine?.cancel();
    } catch { /* The incremented attempt gate rejects any late result. */ }
    root.QGHRadioWorkspace?.controllerEnd();
    updateMicState();
    if (resumeContinuous) scheduleContinuousRestart();
  }

  function currentRecognitionPlan() {
    if (typeof OfflineVoice?.buildRecognitionPlan === 'function') {
      return OfflineVoice.buildRecognitionPlan(grammarContext());
    }
    const grammar = typeof OfflineVoice?.buildQghGrammar === 'function'
      ? OfflineVoice.buildQghGrammar(grammarContext()) : null;
    return { grammar, grammarJson: grammar ? JSON.stringify(grammar) : '' };
  }

  function releasePrimedAudio() {
    if (nativeVoiceBridge()) return;
    try { state.engine?.releasePrimedAudio?.(); } catch { /* Cleanup must never block controls. */ }
  }

  function clearReadinessTimer() {
    root.clearTimeout(state.readinessTimer);
    state.readinessTimer = null;
  }

  function rememberTranscript(transcript) {
    if (pilotBlocksMicrophone()) return;
    const normalized = Voice.normalizeTranscript(transcript);
    const now = Date.now();
    if (!normalized || (normalized === state.lastTranscript && now - state.lastTranscriptAt < RECENT_TRANSCRIPT_WINDOW_MS)) return;
    if (!state.continuous && state.callTranscripts.has(normalized)) return;
    if (!state.continuous) state.callTranscripts.add(normalized);
    state.lastTranscript = normalized;
    state.lastTranscriptAt = now;
    if (state.continuous) root.QGHRadioWorkspace?.controllerStart();
    dispatchTranscript(transcript);
    if (state.continuous) scheduleRadioQuietEnd();
  }

  function scheduleRadioQuietEnd() {
    root.clearTimeout(state.radioQuietTimer);
    state.radioQuietTimer = root.setTimeout(() => {
      state.radioQuietTimer = null;
      if (!state.pilotSpeaking && !state.pressHeld) root.QGHRadioWorkspace?.controllerEnd();
    }, 900);
  }

  function rememberNoSpeech() {
    state.currentOutcome = 'NO SPEECH';
    state.processing = false;
    updateMicState();
    setVoiceFeedback('', 'NO SPEECH DETECTED · TRY AGAIN', 'error');
    if (state.announcement) state.announcement.textContent = 'NO SPEECH DETECTED · TRY AGAIN';
  }

  function ensureOfflineEngine() {
    if (state.engine) return state.engine;
    if (!OfflineVoice || typeof OfflineVoice.create !== 'function') return null;
    state.engine = OfflineVoice.create({
      onEnded: () => handleRecognitionEnd()
    });
    return state.engine;
  }

  // Must be called directly from an input event. It starts the browser audio
  // context before any asynchronous readiness or permission work can consume
  // the transient user gesture. The engine reports a failure during startup.
  function primeOfflineAudio() {
    if (nativeVoiceBridge()) return;
    const engine = ensureOfflineEngine();
    if (!engine || typeof engine.primeAudio !== 'function') return;
    try {
      const task = engine.primeAudio();
      task?.catch?.(() => {});
    } catch { /* Startup surfaces a recoverable audio status to the user. */ }
  }

  function nativeCapability() {
    const bridge = nativeVoiceBridge();
    if (!bridge) return null;
    try { return String(bridge.getCapability() || 'unavailable'); } catch { return 'unavailable'; }
  }

  function scheduleNativeReadinessCheck() {
    if (!nativeVoiceBridge() || state.localAvailability !== 'downloading' || state.readinessTimer) return;
    state.readinessTimer = root.setTimeout(async () => {
      state.readinessTimer = null;
      await checkLocalAvailability({ force: true });
      if (state.localAvailability === 'downloading') scheduleNativeReadinessCheck();
    }, 650);
  }

  function canContinueListening() {
    return state.continuous
      && !pilotBlocksMicrophone()
      && !state.manuallyStopped
      && state.localAvailability === 'ready'
      && documentRef.visibilityState === 'visible';
  }

  function pilotBlocksMicrophone() {
    return Boolean(root.QGHHeadphones?.blocksMicrophone?.()) || (state.pilotSpeaking && !root.QGHRadioWorkspace?.allowsBargeIn?.());
  }

  function setPilotSpeaking(speaking) {
    state.pilotSpeaking = Boolean(speaking);
    if (pilotBlocksMicrophone()) {
      state.startAttempt += 1;
      state.nativeRequestId = null;
      clearRestartTimer();
      state.starting = false;
      try {
        if (nativeVoiceBridge()) nativeVoiceBridge().cancel();
        else state.engine?.cancel();
      } catch { /* The result gate also excludes late playback transcripts. */ }
      state.listening = false;
      state.processing = false;
      setStatus('PILOT TRANSMITTING', 'active');
    } else if (canContinueListening()) scheduleContinuousRestart();
    updateMicState();
  }

  function handleTerminalRecognitionError(error) {
    state.nativeRequestId = null;
    state.processing = false;
    clearRestartTimer();
    clearReadinessTimer();
    state.startAttempt += 1;
    state.starting = false;
    state.listening = false;
    state.manuallyStopped = true;
    state.pressHeld = false;
    state.continuous = false;
    root.clearTimeout(state.radioQuietTimer);
    state.radioQuietTimer = null;
    root.QGHRadioWorkspace?.controllerEnd();
    releasePrimedAudio();
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      state.localAvailability = 'permission-denied';
      setStatus('MICROPHONE ACCESS DENIED', 'error');
    } else if (error === 'audio-suspended') {
      state.localAvailability = 'ready';
      setStatus('AUDIO IS BLOCKED · HOLD PTT AND TRY AGAIN', 'error');
    } else {
      state.localAvailability = 'unavailable';
      setStatus('OFFLINE VOICE UNAVAILABLE', 'error');
    }
    updatePrepareVisibility(state.localAvailability === 'unavailable' && !nativeVoiceBridge());
    updateMicState();
  }

  function handleRecognitionError(error) {
    if (error === 'no-speech' || error === 'aborted') return;
    handleTerminalRecognitionError(error);
  }

  function handleRecognitionEnd() {
    state.nativeRequestId = null;
    state.processing = false;
    state.starting = false;
    state.listening = false;
    if (!state.pressHeld && !state.pilotSpeaking) {
      root.clearTimeout(state.radioQuietTimer);
      state.radioQuietTimer = null;
      root.QGHRadioWorkspace?.controllerEnd();
    }
    updateMicState();
    if (canContinueListening()) scheduleContinuousRestart();
    else if (state.pressHeld && !state.continuous && !state.manuallyStopped && state.localAvailability === 'ready') beginListening(false);
    else if (state.localAvailability === 'ready') setStatus(state.currentOutcome || 'PTT READY', state.currentOutcome === 'APPLIED' ? 'success' : 'neutral');
  }

  function receiveNativeVoiceEvent(event) {
    if (!event || typeof event !== 'object') return;
    // Each start is tied to this document and attempt; queued callbacks cannot
    // interrupt a newer call or execute after cancellation/navigation.
    if (typeof event.requestId !== 'string' || !state.nativeRequestId
        || event.requestId !== state.nativeRequestId) return;
    if (event.type === 'started') {
      if (!state.starting) return;
      if (state.manuallyStopped || (!state.continuous && !state.pressHeld)) {
        state.starting = false;
        state.nativeRequestId = null;
        nativeVoiceBridge()?.cancel();
        return;
      }
      state.starting = false;
      state.listening = true;
      updateMicState();
      setStatus(state.continuous ? 'VOICE ASSISTANT LISTENING' : 'LISTENING', 'active');
      return;
    }
    if (event.type === 'speech-activity') {
      if (!state.listening || state.processing || state.nativeResultReceived
          || !canContinueListening()) return;
      root.QGHRadioWorkspace?.controllerStart();
      scheduleRadioQuietEnd();
      return;
    }
    if (event.type === 'result') {
      if (!state.listening || state.nativeResultReceived) return;
      if (typeof event.transcript === 'string' && event.transcript.trim()) {
        state.nativeResultReceived = true;
        rememberTranscript(event.transcript);
      }
      return;
    }
    if (event.type === 'no-result') {
      rememberNoSpeech();
      return;
    }
    if (event.type === 'error') {
      handleRecognitionError(String(event.code || 'unavailable'));
      return;
    }
    if (event.type === 'ended') handleRecognitionEnd();
  }

  function updatePreparationProgress(progress) {
    if (!progress || state.localAvailability !== 'downloading') return;
    if (progress.phase === 'downloading' && Number.isFinite(progress.loaded) && Number.isFinite(progress.total) && progress.total > 0) {
      const percent = Math.max(0, Math.min(100, Math.round((progress.loaded / progress.total) * 100)));
      setStatus(`DOWNLOADING OFFLINE VOICE ${percent}%`, 'active');
    } else if (progress.phase === 'cached') {
      setStatus('PREPARING OFFLINE VOICE', 'active');
    }
  }

  async function checkLocalAvailability(options) {
    const force = Boolean(options?.force);
    const bridge = nativeVoiceBridge();
    if (bridge) {
      const capability = nativeCapability();
      if (capability === 'available') {
        clearReadinessTimer();
        state.localAvailability = 'ready';
        updatePrepareVisibility(false);
        updateMicState();
        return true;
      }
      if (capability === 'preparing') {
        state.localAvailability = 'downloading';
        updatePrepareVisibility(false);
        updateMicState();
        setStatus('PREPARING OFFLINE VOICE', 'active');
        scheduleNativeReadinessCheck();
        return false;
      }
      state.localAvailability = 'unavailable';
      updatePrepareVisibility(false);
      updateMicState();
      setStatus('OFFLINE VOICE UNAVAILABLE', 'error');
      return false;
    }

    if (!force && state.localAvailability === 'ready') return true;
    if (state.availabilityPromise) return state.availabilityPromise;
    const task = (async () => {
      const engine = ensureOfflineEngine();
      if (!engine || !OfflineVoice?.supportsOfflineVoice?.()) {
        state.localAvailability = 'unavailable';
        updatePrepareVisibility(false);
        updateMicState();
        setStatus('OFFLINE VOICE UNAVAILABLE', 'error');
        releasePrimedAudio();
        return false;
      }
      if (engine.isReady()) {
        state.localAvailability = 'ready';
        updatePrepareVisibility(false);
        updateMicState();
        return true;
      }

      const cachedPack = typeof OfflineVoice?.hasCachedArchive === 'function'
        && await OfflineVoice.hasCachedArchive();
      if (cachedPack) {
        state.localAvailability = 'downloading';
        updatePrepareVisibility(false);
        updateMicState();
        setStatus('PREPARING OFFLINE VOICE', 'active');
        try {
          await engine.prepare(updatePreparationProgress);
          state.localAvailability = 'ready';
          updatePrepareVisibility(false);
          updateMicState();
          setStatus('PTT READY', 'success');
          return true;
        } catch {
          state.localAvailability = 'downloadable';
          updatePrepareVisibility(true);
          updateMicState();
          setStatus('SET UP OFFLINE VOICE', 'neutral');
          releasePrimedAudio();
          return false;
        }
      }

      state.localAvailability = 'downloadable';
      updatePrepareVisibility(true);
      updateMicState();
      setStatus('SET UP OFFLINE VOICE', 'neutral');
      releasePrimedAudio();
      return false;
    })();
    state.availabilityPromise = task;
    try { return await task; } finally { if (state.availabilityPromise === task) state.availabilityPromise = null; }
  }

  async function prepareLocalVoice() {
    if (state.preparePromise) return state.preparePromise;
    if (nativeVoiceBridge()) {
      await checkLocalAvailability({ force: true });
      return state.localAvailability === 'ready';
    }
    const engine = ensureOfflineEngine();
    if (!engine) {
      handleTerminalRecognitionError('unavailable');
      return false;
    }
    const task = (async () => {
      try {
        state.localAvailability = 'downloading';
        updateMicState();
        setStatus('PREPARING OFFLINE VOICE', 'active');
        await engine.prepare(updatePreparationProgress);
        state.localAvailability = 'ready';
        updatePrepareVisibility(false);
        updateMicState();
        setStatus('PTT READY', 'success');
        return true;
      } catch {
        state.localAvailability = 'unavailable';
        updatePrepareVisibility(true);
        updateMicState();
        setStatus('OFFLINE VOICE SETUP FAILED', 'error');
        return false;
      }
    })();
    state.preparePromise = task;
    updateMicState();
    try { return await task; } finally { if (state.preparePromise === task) state.preparePromise = null; updateMicState(); }
  }

  async function startListening(continuous) {
    if (pilotBlocksMicrophone()) return false;
    // The engine owns final-result replacement. A finalizing session is allowed through
    // so `start()` can atomically replace it without the workspace duplicating lifecycle state.
    const pendingFinal = Boolean(state.listening && state.engine?.isFinalizing?.());
    if ((state.listening && !pendingFinal) || state.starting) return true;
    const attempt = ++state.startAttempt;
    const available = await checkLocalAvailability();
    const shouldStart = continuous
      ? state.continuous && !state.manuallyStopped
      : state.pressHeld && !state.continuous;
    if (attempt !== state.startAttempt || !available || !shouldStart) {
      releasePrimedAudio();
      return false;
    }
    const bridge = nativeVoiceBridge();
    state.starting = true;
    updateMicState();
    if (bridge) {
      try {
        state.nativeRequestId = `${nativeVoiceDocumentId}-${attempt}`;
        state.nativeResultReceived = false;
        const plan = currentRecognitionPlan();
        const grammarJson = plan.grammarJson || '';
        if (typeof bridge.setGrammar === 'function' && state.lastNativeGrammarJson !== grammarJson) {
          bridge.setGrammar(grammarJson);
          state.lastNativeGrammarJson = grammarJson;
        }
        bridge.start(Boolean(continuous), state.nativeRequestId);
        return true;
      } catch {
        handleTerminalRecognitionError('unavailable');
        return false;
      }
    }

    const engine = ensureOfflineEngine();
    if (!engine) {
      handleTerminalRecognitionError('unavailable');
      return false;
    }
    try {
      const plan = currentRecognitionPlan();
      const startOutcome = await engine.start({
        grammar: plan.grammar,
        grammarJson: plan.grammarJson,
        onStarted: () => {
          const stillRequested = continuous
            ? state.continuous && !state.manuallyStopped
            : state.pressHeld && !state.continuous;
          if (attempt !== state.startAttempt || !stillRequested) {
            engine.cancel();
            return;
          }
          state.starting = false;
          state.listening = true;
          updateMicState();
          setStatus(state.continuous ? 'VOICE ASSISTANT LISTENING' : 'LISTENING', 'active');
        },
        onResult: transcript => { if (attempt === state.startAttempt) rememberTranscript(transcript); },
        onNoResult: rememberNoSpeech,
        onPartial: partial => {
          if (attempt !== state.startAttempt || pilotBlocksMicrophone()) return;
          if (state.continuous && partial) {
            root.QGHRadioWorkspace?.controllerStart();
            scheduleRadioQuietEnd();
          }
          if (state.listening) setStatus(state.continuous ? 'VOICE ASSISTANT LISTENING' : 'LISTENING', 'active');
        },
        onError: error => { if (attempt === state.startAttempt) handleRecognitionError(error); }
      });
      return startOutcome === true || Boolean(startOutcome?.started);
    } catch {
      if (attempt === state.startAttempt) handleTerminalRecognitionError('unavailable');
      return false;
    }
  }

  function beginListening(continuous, options) {
    state.processing = false;
    state.currentOutcome = null;
    if (options?.clearFeedback) clearVoiceFeedback();
    state.manuallyStopped = false;
    return startListening(continuous);
  }

  function stopListening(options) {
    const cancel = Boolean(options?.cancel);
    root.clearTimeout(state.radioQuietTimer);
    state.radioQuietTimer = null;
    if (cancel) root.QGHRadioWorkspace?.reset();
    // PTT release asks the recognizer to flush; pilot playback waits for its
    // ended callback so no later final segment is cancelled by our own reply.
    else if (!state.listening) root.QGHRadioWorkspace?.controllerEnd();
    state.processing = !cancel && state.listening;
    if (state.processing) setStatus('PROCESSING', 'active');
    updateMicState();
    state.manuallyStopped = true;
    if (cancel || state.starting) state.startAttempt += 1;
    clearRestartTimer();
    const bridge = nativeVoiceBridge();
    if (bridge && cancel) {
      state.nativeRequestId = null;
      state.starting = false;
      state.listening = false;
      try { bridge.cancel(); } catch { /* The cancelled request is already invalidated. */ }
      handleRecognitionEnd();
      return;
    }
    if (state.starting && !state.listening) {
      state.starting = false;
      state.listening = false;
      try {
        if (bridge) bridge.cancel();
        else state.engine?.cancel();
      } catch { /* A stopped session cannot be cancelled again. */ }
      updateMicState();
      return;
    }
    if (state.listening) {
      try {
        if (bridge) {
          if (cancel) bridge.cancel();
          else bridge.stop();
        } else if (cancel) state.engine?.cancel();
        else state.engine?.stop({ cancel: false });
      } catch { handleRecognitionEnd(); }
    } else if (!bridge) {
      try { state.engine?.cancel(); } catch { /* No active audio path remains. */ }
      updateMicState();
    }
  }

  function setListeningMode(mode) {
    const continuous = mode === 'continuous';
    if (continuous && state.localAvailability !== 'ready') {
      state.continuous = false;
      updateMicState();
      setStatus('SET UP OFFLINE VOICE FIRST', 'error');
      return result(false, 'SET UP OFFLINE VOICE FIRST');
    }
    state.continuous = continuous;
    updateMicState();
    if (!continuous) {
      stopListening({ cancel: true });
      return result(true, 'PTT MODE');
    }
    primeOfflineAudio();
    beginListening(true);
    return result(true, 'VOICE ASSISTANT ON');
  }

  function createOfflineVoiceDock() {
    const dock = documentRef.createElement('aside');
    dock.className = 'voice-dock';
    dock.setAttribute('aria-label', 'Offline voice controls');

    const dragHandle = documentRef.createElement('button');
    dragHandle.type = 'button';
    dragHandle.className = 'voice-drag-handle';
    dragHandle.textContent = 'DRAG';
    dragHandle.setAttribute('aria-label', 'Hold and drag to move voice controls');
    dragHandle.title = 'Hold and drag to move voice controls';

    const mic = documentRef.createElement('button');
    mic.type = 'button';
    mic.className = 'voice-mic';
    mic.textContent = 'PTT';
    mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-label', 'Press and hold to talk using local voice recognition');

    const settingsToggle = documentRef.createElement('button');
    settingsToggle.type = 'button';
    settingsToggle.className = 'voice-settings-toggle';
    settingsToggle.textContent = 'VOICE';
    settingsToggle.setAttribute('aria-expanded', 'false');
    settingsToggle.setAttribute('aria-label', 'Voice settings');

    const status = documentRef.createElement('output');
    status.className = 'voice-status';
    status.setAttribute('aria-live', 'off');
    status.textContent = 'SET UP OFFLINE VOICE';

    const feedback = documentRef.createElement('output');
    feedback.className = 'voice-feedback';
    feedback.setAttribute('aria-live', 'off');
    feedback.hidden = true;

    const settings = documentRef.createElement('section');
    settings.className = 'voice-settings';
    settings.hidden = true;
    const continuousLabel = documentRef.createElement('label');
    continuousLabel.className = 'voice-continuous';
    const continuousInput = documentRef.createElement('input');
    continuousInput.type = 'checkbox';
    continuousInput.setAttribute('aria-label', 'Continuous listening');
    const continuousCopy = documentRef.createElement('span');
    continuousCopy.textContent = 'CONTINUOUS LISTENING';
    continuousLabel.append(continuousInput, continuousCopy);
    const prepare = documentRef.createElement('button');
    prepare.type = 'button';
    prepare.className = 'voice-prepare';
    prepare.textContent = 'SET UP OFFLINE VOICE · 40 MB';
    const engineNote = documentRef.createElement('small');
    engineNote.textContent = 'ON-DEVICE SPEECH ONLY';
    const resetPosition = documentRef.createElement('button');
    resetPosition.type = 'button';
    resetPosition.className = 'voice-reset-position';
    resetPosition.textContent = 'RESET POSITION';
    const lastCall = documentRef.createElement('details');
    lastCall.className = 'voice-last-call';
    const lastCallTitle = documentRef.createElement('summary');
    lastCallTitle.textContent = 'LAST CALL';
    const lastCallDetail = documentRef.createElement('p');
    lastCallDetail.textContent = 'No voice call yet. Kept only until this page closes.';
    lastCall.append(lastCallTitle, lastCallDetail);
    settings.append(continuousLabel, prepare, engineNote, resetPosition, lastCall);
    let updatePilotNote = () => {};
    if (root.QGHRadioWorkspace) {
      const setupPilotReadbacks = $('setupPilotReadbacks');
      const pilotLabel = documentRef.createElement('label');
      pilotLabel.className = 'voice-continuous';
      const pilotAudio = documentRef.createElement('input');
      pilotAudio.type = 'checkbox';
      pilotAudio.id = 'pilotAudio';
      pilotAudio.checked = root.QGHRadioWorkspace.status().audioEnabled;
      pilotLabel.append(pilotAudio, 'HEADPHONES · PILOT READBACKS');
      const pilotNote = documentRef.createElement('small');
      pilotNote.className = 'voice-engine-note';
      const mutePilot = documentRef.createElement('button');
      mutePilot.type = 'button';
      mutePilot.className = 'voice-mute-pilot';
      mutePilot.textContent = 'MUTE PILOT REPLIES';
      const isPilotSetupStage = () => /:(?:setup)$/.test(currentVoiceContext());
      const requestPilotReadbacks = () => {
        if (!isPilotSetupStage()) {
          setStatus('SET UP PILOT REPLIES BEFORE START', 'neutral');
          updatePilotNote();
          return false;
        }
        pilotAudio.checked = false;
        setSettingsOpen(false);
        root.QGHHeadphones?.requestEnable();
        return true;
      };
      updatePilotNote = () => {
        const radioStatus = root.QGHRadioWorkspace.status();
        const enabled = radioStatus.audioEnabled;
        const rate = radioStatus.pilotRate || 1;
        const inSetup = isPilotSetupStage();
        pilotAudio.checked = enabled;
        pilotLabel.hidden = !inSetup;
        mutePilot.hidden = !enabled;
        pilotNote.textContent = root.QGHPilotVoiceEngine
          ? inSetup
            ? `${enabled ? 'Headphones confirmed by you.' : 'Muted. Connect headphones and complete the audio check to enable.'} Pilot speed ${rate}× · ${rate * 150} words/minute. PTT and continuous controller speech take priority.`
            : `${enabled ? 'Pilot replies are on. You can mute them here.' : 'Pilot replies are muted.'} Headphone setup is available before starting the next exercise.`
          : root.QGHRadioWorkspace.audioAvailable()
            ? 'Off by default: muted. Enable only with headphones. In continuous mode, your speech interrupts pilot audio. PTT always takes priority.'
            : 'No local English output voice available. Captions and timed pilot D/F still work offline.';
        const message = root.QGHHeadphones?.status?.().message;
        if (!enabled && message) pilotNote.textContent = `${message} ${pilotNote.textContent}`;
      };
      updatePilotNote();
      root.speechSynthesis?.addEventListener?.('voiceschanged', updatePilotNote);
      root.addEventListener?.('qgh-pilot-audio-change', updatePilotNote);
      pilotAudio.addEventListener('change', () => {
        if (pilotAudio.checked && root.QGHHeadphones) {
          requestPilotReadbacks();
        } else {
          if (root.QGHHeadphones) root.QGHHeadphones.mute();
          else root.QGHRadioWorkspace.setAudioEnabled(pilotAudio.checked);
        }
        updatePilotNote();
      });
      mutePilot.addEventListener('click', () => {
        if (root.QGHHeadphones) root.QGHHeadphones.mute();
        else root.QGHRadioWorkspace.setAudioEnabled(false);
        updatePilotNote();
      });
      setupPilotReadbacks?.addEventListener('click', requestPilotReadbacks);
      settings.append(pilotLabel, mutePilot, pilotNote);
    }

    const listeningIndicator = documentRef.createElement('output');
    listeningIndicator.className = 'voice-listening-indicator';
    listeningIndicator.hidden = true;
    listeningIndicator.setAttribute('aria-live', 'off');
    listeningIndicator.textContent = 'LISTENING';

    const confirmation = documentRef.createElement('section');
    confirmation.className = 'voice-confirmation';
    confirmation.hidden = true;
    confirmation.setAttribute('aria-label', 'Confirm voice command');
    const confirmationTitle = documentRef.createElement('strong');
    confirmationTitle.textContent = 'CONFIRM VOICE COMMAND';
    const confirmationDetail = documentRef.createElement('small');
    confirmationDetail.textContent = 'HEARD · —';
    const confirmationActions = documentRef.createElement('div');
    const confirmationButton = documentRef.createElement('button');
    confirmationButton.type = 'button';
    confirmationButton.className = 'voice-confirm';
    confirmationButton.textContent = 'CONFIRM';
    const cancellationButton = documentRef.createElement('button');
    cancellationButton.type = 'button';
    cancellationButton.className = 'voice-cancel';
    cancellationButton.textContent = 'CANCEL';
    confirmationActions.append(confirmationButton, cancellationButton);
    confirmation.append(confirmationTitle, confirmationDetail, confirmationActions);
    dock.append(dragHandle, mic, listeningIndicator, status, settingsToggle, feedback, settings, confirmation);
    const announcement = documentRef.createElement('div');
    announcement.className = 'voice-announcement voice-command-only';
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    announcement.setAttribute('aria-atomic', 'true');
    dock.append(announcement);
    documentRef.body.appendChild(dock);

    Object.assign(state, {
      dock, dragHandle, mic, status, feedback, settings, settingsToggle, continuousInput, prepareButton: prepare,
      listeningIndicator, engineNote, confirmationPanel: confirmation, confirmationDetail,
      confirmationButton, cancellationButton, lastCallDetail, announcement
    });
    scheduleBrowserBottomInset();
    settingsToggle.addEventListener('click', () => {
      const opening = settings.hidden;
      setSettingsOpen(opening);
      if (opening) {
        updatePilotNote();
        checkLocalAvailability({ force: true });
      }
    });
    prepare.addEventListener('click', prepareLocalVoice);
    resetPosition.addEventListener('click', resetVoiceDockPosition);
    settings.addEventListener('keydown', event => {
      if (event.key === 'Escape') { setSettingsOpen(false); settingsToggle.focus(); }
    });
    lastCall.addEventListener('toggle', positionVoicePopovers);
    continuousInput.addEventListener('change', () => setListeningMode(continuousInput.checked ? 'continuous' : 'push-to-talk'));
    confirmationButton.addEventListener('click', confirmPendingVoiceCommand);
    cancellationButton.addEventListener('click', cancelPendingVoiceCommand);
    dragHandle.addEventListener('pointerdown', beginDockDrag);
    dragHandle.addEventListener('lostpointercapture', endDockDrag);
    dragHandle.addEventListener('keydown', moveDockByKeyboard);

    const beginPressToTalk = event => {
      if (state.continuous || state.pressHeld || mic.disabled || (event.button !== undefined && event.button !== 0)) return;
      event.preventDefault();
      root.QGHRadioWorkspace?.controllerStart();
      state.pressHeld = true;
      state.pressPointerId = event.pointerId ?? null;
      state.lastTranscript = '';
      state.lastTranscriptAt = 0;
      state.callTranscripts.clear();
      updateMicState();
      setStatus('STARTING MICROPHONE', 'neutral');
      try { if (event.pointerId !== undefined) mic.setPointerCapture?.(event.pointerId); } catch { /* Window release fallback remains active. */ }
      primeOfflineAudio();
      beginListening(false, { clearFeedback: true });
    };
    const endPressToTalk = event => {
      if (state.continuous || !state.pressHeld) return;
      if (event?.pointerId !== undefined && event.pointerId !== state.pressPointerId) return;
      event?.preventDefault();
      state.pressHeld = false;
      state.pressPointerId = null;
      stopListening({ cancel: ['pointercancel', 'lostpointercapture'].includes(event?.type) });
    };
    mic.addEventListener('pointerdown', beginPressToTalk);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => mic.addEventListener(type, endPressToTalk));
    mic.addEventListener('keydown', event => {
      if (state.continuous || (event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
      beginPressToTalk(event);
    });
    mic.addEventListener('keyup', event => {
      if (state.continuous || (event.key !== ' ' && event.key !== 'Enter')) return;
      endPressToTalk(event);
    });
    mic.addEventListener('blur', () => {
      if (state.pressHeld && state.pressPointerId === null) {
        state.pressHeld = false;
        stopListening({ cancel: true });
      }
    });
    mic.addEventListener('click', () => {
      if (!state.continuous) return;
      if (state.listening || state.starting) stopListening({ cancel: true });
      else {
        primeOfflineAudio();
        beginListening(true, { clearFeedback: true });
      }
    });
    root.addEventListener('pointermove', moveDock);
    root.addEventListener('pointerup', event => { endDockDrag(event); endPressToTalk(event); });
    root.addEventListener('pointercancel', event => { endDockDrag(event); endPressToTalk(event); });
    root.visualViewport?.addEventListener?.('resize', refreshViewportLayout);
    root.visualViewport?.addEventListener?.('scroll', refreshViewportLayout);
    root.addEventListener('orientationchange', scheduleBrowserBottomInset);
    root.addEventListener('pageshow', scheduleBrowserBottomInset);
    root.addEventListener('resize', () => {
      refreshViewportLayout();
      if (state.dock.dataset.phone !== String(phoneDock())) { restoreVoiceDockPosition(); return; }
      const left = Number.parseFloat(dock.style.left);
      const top = Number.parseFloat(dock.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) positionVoiceDock(left, top, true);
      positionVoicePopovers();
    });
    root.addEventListener('blur', () => {
      endDockDrag();
      state.pressHeld = false;
      clearPendingVoiceCommand();
      stopListening({ cancel: true });
    });
    root.addEventListener('pagehide', () => {
      state.pressHeld = false;
      clearPendingVoiceCommand();
      stopListening({ cancel: true });
    });
    documentRef.addEventListener('visibilitychange', () => {
      if (documentRef.visibilityState !== 'visible') {
        state.pressHeld = false;
        clearPendingVoiceCommand();
        stopListening({ cancel: true });
      }
    });
    updateMicState();
    restoreVoiceDockPosition();
    // Phone content has its own scroll area above the dock. Reset that area only
    // when the existing simulator changes screens; no simulator state is touched.
    const app = documentRef.querySelector('.app, .tactical-app') || documentRef.body;
    if (app && root.MutationObserver) {
      let screen = currentVoiceContext();
      let context = recognitionContextSignature();
      state.recognitionContext = context;
      const refreshRecognitionContext = () => {
        const nextScreen = currentVoiceContext();
        const nextContext = recognitionContextSignature();
        if (nextContext === context) return;
        if (nextScreen !== screen) root.QGHRadioWorkspace?.reset();
        reconfigureRecognitionContext(nextContext);
        screen = nextScreen;
        context = nextContext;
        if (phoneDock()) app.scrollTop = 0;
      };
      const observer = new root.MutationObserver(() => {
        refreshRecognitionContext();
      });
      observer.observe(app, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
      // Input values are properties rather than DOM attributes, so roster edits
      // need the same safe context refresh as a screen/procedure transition.
      documentRef.addEventListener('input', refreshRecognitionContext);
      documentRef.addEventListener('change', refreshRecognitionContext);
    }
    checkLocalAvailability({ force: true });
  }

  createOfflineVoiceDock();
  root.QGHVoiceWorkspace = Object.freeze({
    dispatchTranscript,
    runCommand,
    pageKind,
    stopListening,
    setPilotSpeaking,
    showPilotReply,
    isDispatchingRadioCommand: () => state.dispatchingRadioCommand,
    receiveNativeVoiceEvent
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
