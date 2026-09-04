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
  const $ = id => documentRef.getElementById(id);
  const voiceEffectTimers = new WeakMap();
  const state = {
    engine: null,
    listening: false,
    starting: false,
    pressHeld: false,
    continuous: false,
    manuallyStopped: false,
    localAvailability: 'unknown',
    lastTranscript: '',
    lastTranscriptAt: 0,
    statusTimer: null,
    feedbackTimer: null,
    restartTimer: null,
    readinessTimer: null,
    availabilityPromise: null,
    preparePromise: null,
    startAttempt: 0,
    lastNativeGrammarJson: null,
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

  function buttonText(button) {
    return (button?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isAvailable(element) {
    if (!element || element.disabled || element.hidden || element.closest('[hidden]')) return false;
    const screen = element.closest('.screen, .tactical-screen');
    return !screen || screen.classList.contains('active');
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
      ? `HEARD\n${tone === 'success' ? 'ACCEPTED' : 'CHECK CALL'}`
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
    state.mic.setAttribute('aria-pressed', String(state.listening));
    state.mic.dataset.listening = String(state.listening);
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
    if (state.engineNote) {
      state.engineNote.textContent = state.localAvailability === 'ready'
        ? 'OFFLINE VOICE READY'
        : 'ON-DEVICE SPEECH ONLY';
    }
    if (state.listeningIndicator) state.listeningIndicator.hidden = !(state.continuous && (state.listening || state.starting));
  }

  function updatePrepareVisibility(visible) {
    if (!state.prepareButton) return;
    state.prepareButton.hidden = !visible;
  }

  function setSettingsOpen(open) {
    if (!state.settings || !state.settingsToggle) return;
    state.settings.hidden = !open;
    state.settingsToggle.setAttribute('aria-expanded', String(open));
  }

  function storedDockPosition() {
    try {
      const value = root.localStorage?.getItem(VOICE_DOCK_POSITION_KEY);
      const parsed = value ? JSON.parse(value) : null;
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
    const maxLeft = Number.isFinite(viewportWidth) && viewportWidth > 0 ? Math.max(margin, viewportWidth - width - margin) : left;
    const maxTop = Number.isFinite(viewportHeight) && viewportHeight > 0 ? Math.max(margin, viewportHeight - height - margin) : top;
    const safeLeft = Math.round(Math.min(Math.max(margin, left), maxLeft));
    const safeTop = Math.round(Math.min(Math.max(margin, top), maxTop));
    dock.style.left = `${safeLeft}px`;
    dock.style.top = `${safeTop}px`;
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
    const popupWidth = 260;
    dock.dataset.popoverSide = safeLeft < popupWidth + margin ? 'right' : 'left';
    if (!persist) return;
    try { root.localStorage?.setItem(VOICE_DOCK_POSITION_KEY, JSON.stringify({ left: safeLeft, top: safeTop })); } catch { /* Position persistence is optional. */ }
  }

  function restoreVoiceDockPosition() {
    const saved = storedDockPosition();
    if (saved) positionVoiceDock(saved.left, saved.top, false);
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
    if (Number.isFinite(left) && Number.isFinite(top)) positionVoiceDock(left, top, true);
  }

  function moveDockByKeyboard(event) {
    const steps = { ArrowUp: [0, -16], ArrowDown: [0, 16], ArrowLeft: [-16, 0], ArrowRight: [16, 0] };
    const movement = steps[event?.key];
    if (!movement) return;
    const rect = state.dock?.getBoundingClientRect?.();
    if (!rect) return;
    event.preventDefault?.();
    positionVoiceDock(Number(rect.left) + movement[0], Number(rect.top) + movement[1], true);
  }

  function emitChange(element, type) {
    element.dispatchEvent(new root.Event(type, { bubbles: true }));
  }

  function markVoiceAffected(element) {
    if (!element?.classList) return;
    const priorTimer = voiceEffectTimers.get(element);
    if (priorTimer !== undefined) root.clearTimeout(priorTimer);
    element.classList.remove('voice-command-effect');
    element.classList.add('voice-command-effect');
    const timer = root.setTimeout(() => {
      element.classList?.remove('voice-command-effect');
      voiceEffectTimers.delete(element);
    }, 900);
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
    if (command.intent === 'request-distance') return clickId('requestDistance', 'DISTANCE REQUESTED');
    if (command.intent === 'normal-turn-heading') {
      if (command.aircraft) return result(false, 'AIRCRAFT CALLSIGN COMMANDS APPLY TO TACTICAL QGH');
      if (isHidden($('turnHeadingLeft'))) return result(false, 'HEADING TURNS ARE NOT AVAILABLE IN U/S COMPASS');
      if (!isAvailable($('turnHeadingLeft'))) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      const heading = applyHeading($('headingInput'), command.heading);
      return heading.ok ? clickId(command.side === 'left' ? 'turnHeadingLeft' : 'turnHeadingRight', `TURN ${command.side.toUpperCase()} ${String(command.heading).padStart(3, '0')}°`) : heading;
    }
    if (command.intent === 'continue-turn-heading') {
      if (command.aircraft) return result(false, 'AIRCRAFT CALLSIGN COMMANDS APPLY TO TACTICAL QGH');
      if (isHidden($('turnHeadingLeft'))) return result(false, 'CONTINUE HEADING IS NOT AVAILABLE IN U/S COMPASS');
      const heading = applyHeading($('headingInput'), command.heading);
      if (!heading.ok) return heading;
      const side = $('continueHeading')?.dataset.turnSide;
      if (side === 'left' || side === 'right') markVoiceAffected($(side === 'left' ? 'turnHeadingLeft' : 'turnHeadingRight'));
      return clickId('continueHeading', `CONTINUE ACTIVE TURN ${String(command.heading).padStart(3, '0')}°`);
    }
    if (command.intent === 'us-turn') {
      if (isHidden($('turnLeft'))) return result(false, 'U/S TURNS ARE NOT AVAILABLE IN NORMAL QGH');
      if (!isAvailable($('turnLeft'))) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      return clickId(command.side === 'left' ? 'turnLeft' : 'turnRight', `TURN ${command.side.toUpperCase()} NOW`);
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
      'report-heading', 'request-distance', 'set-field', 'set-aircraft-field', 'stop-following-leader'
    ]);
    if (callsignRequired.has(command.intent) && !command.aircraft) {
      return result(false, 'SAY THE AIRCRAFT CALLSIGN FOR A TACTICAL COMMAND');
    }
    if (command.intent === 'select-aircraft') return selectTacticalAircraft(command.aircraft);
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
      if (!isAvailable($('tTurnLeft'))) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      const heading = applyHeading($('tHeadingInput'), command.heading);
      return heading.ok ? clickId(command.side === 'left' ? 'tTurnLeft' : 'tTurnRight', `TURN ${command.side.toUpperCase()} ${String(command.heading).padStart(3, '0')}°`) : heading;
    }
    if (command.intent === 'continue-turn-heading') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      if (isHidden($('tTurnLeft'))) return result(false, 'CONTINUE HEADING IS NOT AVAILABLE IN U/S COMPASS');
      const heading = applyHeading($('tHeadingInput'), command.heading);
      if (!heading.ok) return heading;
      const side = $('tContinueHeading')?.dataset.turnSide;
      if (side === 'left' || side === 'right') markVoiceAffected($(side === 'left' ? 'tTurnLeft' : 'tTurnRight'));
      return clickId('tContinueHeading', `CONTINUE ACTIVE TURN ${String(command.heading).padStart(3, '0')}°`);
    }
    if (command.intent === 'us-turn') {
      if (command.aircraft) {
        const selected = selectTacticalAircraft(command.aircraft);
        if (!selected.ok) return selected;
      }
      if (isHidden($('tUsLeft'))) return result(false, 'U/S TURNS ARE NOT AVAILABLE IN NORMAL QGH');
      if (!isAvailable($('tUsLeft'))) return result(false, 'TURN CONTROL IS NOT AVAILABLE');
      return clickId(command.side === 'left' ? 'tUsLeft' : 'tUsRight', `TURN ${command.side.toUpperCase()} NOW`);
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
    if (pageKind() === 'single') return runSingleCommand(command);
    if (pageKind() === 'tactical') return runTacticalCommand(command);
    return runEntryCommand(command);
  }

  function clearPendingVoiceCommand() {
    root.clearTimeout(state.pendingTimer);
    state.pendingCommand = null;
    state.pendingContext = null;
    state.pendingTimer = null;
    if (state.confirmationPanel) state.confirmationPanel.hidden = true;
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
    const description = typeof Voice.describeCommand === 'function'
      ? Voice.describeCommand(command)
      : String(command.intent || 'COMMAND').replace(/-/g, ' ').toUpperCase();
    if (state.confirmationDetail) state.confirmationDetail.textContent = `HEARD · ${description}`;
    if (state.confirmationPanel) state.confirmationPanel.hidden = false;
    markVoiceAffected(state.confirmationButton);
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
    return outcome;
  }

  function cancelPendingVoiceCommand() {
    if (!state.pendingCommand) return result(false, 'NO VOICE COMMAND AWAITS CONFIRMATION');
    clearPendingVoiceCommand();
    setStatus('VOICE COMMAND CANCELLED', 'neutral');
    return result(true, 'VOICE COMMAND CANCELLED');
  }

  function dispatchTranscript(transcript) {
    const command = Voice.parseCommand(transcript, {
      callsigns: tacticalCallsignOptions(),
      profiles: availableProfileOptions()
    });
    if (state.pendingCommand) {
      const response = pendingVoiceResponse(transcript, command);
      if (response === 'confirm') return confirmPendingVoiceCommand();
      if (response === 'cancel') return cancelPendingVoiceCommand();
      setStatus('CONFIRM OR CANCEL THE PENDING VOICE COMMAND', 'error');
      return result(false, 'CONFIRM OR CANCEL THE PENDING VOICE COMMAND');
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
    const kind = pageKind();
    return {
      screen: currentVoiceContext(),
      // Tactical identifiers are meaningful only on a tactical page. Keeping them out of
      // the single-aircraft plan prevents needless grammar growth during every PTT re-arm.
      callsigns: kind === 'tactical' ? tacticalCallsignOptions() : []
    };
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
    const normalized = Voice.normalizeTranscript(transcript);
    const now = Date.now();
    if (!normalized || (normalized === state.lastTranscript && now - state.lastTranscriptAt < RECENT_TRANSCRIPT_WINDOW_MS)) return;
    state.lastTranscript = normalized;
    state.lastTranscriptAt = now;
    const outcome = dispatchTranscript(transcript);
    setVoiceFeedback(transcript, outcome.message, outcome.ok ? 'success' : 'error');
  }

  function rememberNoSpeech() {
    setVoiceFeedback('', 'NO SPEECH DETECTED · TRY AGAIN', 'error');
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
      && !state.manuallyStopped
      && state.localAvailability === 'ready'
      && documentRef.visibilityState === 'visible';
  }

  function handleTerminalRecognitionError(error) {
    clearRestartTimer();
    clearReadinessTimer();
    state.startAttempt += 1;
    state.starting = false;
    state.listening = false;
    state.manuallyStopped = true;
    state.pressHeld = false;
    state.continuous = false;
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
    state.starting = false;
    state.listening = false;
    updateMicState();
    if (canContinueListening()) scheduleContinuousRestart();
    else if (state.pressHeld && !state.continuous && !state.manuallyStopped && state.localAvailability === 'ready') beginListening(false);
    else if (state.localAvailability === 'ready') setStatus('PTT READY', 'neutral');
  }

  function receiveNativeVoiceEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'started') {
      if (state.manuallyStopped || (!state.continuous && !state.pressHeld)) {
        state.starting = false;
        nativeVoiceBridge()?.cancel();
        return;
      }
      state.starting = false;
      state.listening = true;
      updateMicState();
      setStatus(state.continuous ? 'VOICE ASSISTANT LISTENING' : 'LISTENING', 'active');
      return;
    }
    if (event.type === 'result') {
      if (typeof event.transcript === 'string') rememberTranscript(event.transcript);
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
        const plan = currentRecognitionPlan();
        const grammarJson = plan.grammarJson || '';
        if (typeof bridge.setGrammar === 'function' && state.lastNativeGrammarJson !== grammarJson) {
          bridge.setGrammar(grammarJson);
          state.lastNativeGrammarJson = grammarJson;
        }
        bridge.start(Boolean(continuous));
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
        onResult: rememberTranscript,
        onNoResult: rememberNoSpeech,
        onPartial: () => {
          if (state.listening) setStatus(state.continuous ? 'VOICE ASSISTANT LISTENING' : 'LISTENING', 'active');
        },
        onError: handleRecognitionError
      });
      return startOutcome === true || Boolean(startOutcome?.started);
    } catch {
      if (attempt === state.startAttempt) handleTerminalRecognitionError('unavailable');
      return false;
    }
  }

  function beginListening(continuous, options) {
    if (options?.clearFeedback) clearVoiceFeedback();
    state.manuallyStopped = false;
    return startListening(continuous);
  }

  function stopListening(options) {
    const cancel = Boolean(options?.cancel);
    state.manuallyStopped = true;
    state.startAttempt += 1;
    clearRestartTimer();
    const bridge = nativeVoiceBridge();
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
    dragHandle.textContent = 'MOVE';
    dragHandle.setAttribute('aria-label', 'Drag to move voice controls');
    dragHandle.title = 'Drag to move voice controls';

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
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'SET UP OFFLINE VOICE';

    const feedback = documentRef.createElement('output');
    feedback.className = 'voice-feedback';
    feedback.setAttribute('aria-live', 'polite');
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
    settings.append(continuousLabel, prepare, engineNote);

    const listeningIndicator = documentRef.createElement('output');
    listeningIndicator.className = 'voice-listening-indicator';
    listeningIndicator.hidden = true;
    listeningIndicator.setAttribute('aria-live', 'polite');
    listeningIndicator.textContent = 'LISTENING';

    const confirmation = documentRef.createElement('section');
    confirmation.className = 'voice-confirmation';
    confirmation.hidden = true;
    confirmation.setAttribute('aria-live', 'assertive');
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
    documentRef.body.appendChild(dock);

    Object.assign(state, {
      dock, dragHandle, mic, status, feedback, settings, settingsToggle, continuousInput, prepareButton: prepare,
      listeningIndicator, engineNote, confirmationPanel: confirmation, confirmationDetail,
      confirmationButton, cancellationButton
    });
    settingsToggle.addEventListener('click', () => {
      const opening = settings.hidden;
      setSettingsOpen(opening);
      if (opening) checkLocalAvailability({ force: true });
    });
    prepare.addEventListener('click', prepareLocalVoice);
    continuousInput.addEventListener('change', () => setListeningMode(continuousInput.checked ? 'continuous' : 'push-to-talk'));
    confirmationButton.addEventListener('click', confirmPendingVoiceCommand);
    cancellationButton.addEventListener('click', cancelPendingVoiceCommand);
    dragHandle.addEventListener('pointerdown', beginDockDrag);
    dragHandle.addEventListener('lostpointercapture', endDockDrag);
    dragHandle.addEventListener('keydown', moveDockByKeyboard);

    const beginPressToTalk = event => {
      if (state.continuous) return;
      event.preventDefault();
      state.pressHeld = true;
      if (typeof mic.setPointerCapture === 'function' && event.pointerId !== undefined) mic.setPointerCapture(event.pointerId);
      primeOfflineAudio();
      beginListening(false, { clearFeedback: true });
    };
    const endPressToTalk = event => {
      if (state.continuous) return;
      event?.preventDefault();
      state.pressHeld = false;
      stopListening();
    };
    mic.addEventListener('pointerdown', beginPressToTalk);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => mic.addEventListener(type, endPressToTalk));
    mic.addEventListener('keydown', event => {
      if (state.continuous || (event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
      event.preventDefault();
      state.pressHeld = true;
      primeOfflineAudio();
      beginListening(false, { clearFeedback: true });
    });
    mic.addEventListener('keyup', event => {
      if (state.continuous || (event.key !== ' ' && event.key !== 'Enter')) return;
      endPressToTalk(event);
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
    root.addEventListener('pointerup', endDockDrag);
    root.addEventListener('pointercancel', endDockDrag);
    root.addEventListener('resize', () => {
      const left = Number.parseFloat(dock.style.left);
      const top = Number.parseFloat(dock.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) positionVoiceDock(left, top, true);
    });
    root.addEventListener('blur', () => {
      endDockDrag();
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
    checkLocalAvailability({ force: true });
  }

  createOfflineVoiceDock();
  root.QGHVoiceWorkspace = Object.freeze({
    dispatchTranscript,
    runCommand,
    pageKind,
    stopListening,
    receiveNativeVoiceEvent
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
