(function initializeQghVoiceWorkspace(root) {
  'use strict';

  const documentRef = root.document;
  const Voice = root.QGHVoiceControl;
  if (!documentRef || !Voice) return;

  const LOCAL_LANGUAGE = 'en-IN';
  const LOCAL_PACK_CHECK = { langs: [LOCAL_LANGUAGE], processLocally: true };
  const RECENT_TRANSCRIPT_WINDOW_MS = 900;
  const PACK_RECHECK_DELAY_MS = 1000;
  const MAX_PACK_RECHECKS = 15;
  const $ = id => documentRef.getElementById(id);
  const state = {
    recognition: null,
    recognitionConstructor: null,
    listening: false,
    starting: false,
    stopping: false,
    pressHeld: false,
    continuous: false,
    manuallyStopped: false,
    localAvailability: 'unknown',
    lastTranscript: '',
    lastTranscriptAt: 0,
    statusTimer: null,
    restartTimer: null,
    packRecheckTimer: null,
    packRecheckAttempts: 0,
    availabilityPromise: null,
    installPromise: null,
    startAttempt: 0,
    dock: null,
    mic: null,
    status: null,
    settings: null,
    settingsToggle: null,
    continuousInput: null,
    prepareButton: null
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
        else if (state.localAvailability === 'ready') setStatus('HOLD TO TALK', 'neutral');
      }, 2400);
    }
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

  function clearPackRecheck() {
    root.clearTimeout(state.packRecheckTimer);
    state.packRecheckTimer = null;
    state.packRecheckAttempts = 0;
  }

  function updateMicState() {
    if (!state.mic) return;
    state.mic.setAttribute('aria-pressed', String(state.listening));
    state.mic.dataset.listening = String(state.listening);
    state.mic.disabled = ['unavailable', 'downloadable', 'downloading'].includes(state.localAvailability);
    state.mic.textContent = state.continuous ? 'VOICE' : 'HOLD TO TALK';
    if (state.continuousInput) {
      state.continuousInput.checked = state.continuous;
      state.continuousInput.disabled = state.localAvailability !== 'ready';
    }
    if (state.prepareButton) {
      state.prepareButton.disabled = state.localAvailability === 'downloading' || Boolean(state.installPromise);
    }
  }

  function updatePrepareVisibility(visible) {
    if (!state.prepareButton) return;
    state.prepareButton.hidden = !visible;
  }

  function schedulePackRecheck() {
    if (nativeVoiceBridge() || state.localAvailability !== 'downloading' || state.packRecheckTimer) return;
    if (state.packRecheckAttempts >= MAX_PACK_RECHECKS) {
      state.localAvailability = 'unavailable';
      updatePrepareVisibility(false);
      updateMicState();
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return;
    }
    state.packRecheckAttempts += 1;
    state.packRecheckTimer = root.setTimeout(async () => {
      state.packRecheckTimer = null;
      await checkLocalAvailability({ force: true, fromPackRecheck: true });
      if (state.localAvailability === 'downloading') schedulePackRecheck();
    }, PACK_RECHECK_DELAY_MS);
  }

  function setSettingsOpen(open) {
    if (!state.settings || !state.settingsToggle) return;
    state.settings.hidden = !open;
    state.settingsToggle.setAttribute('aria-expanded', String(open));
  }

  function emitChange(element, type) {
    element.dispatchEvent(new root.Event(type, { bubbles: true }));
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
    return result(true, 'VALUE SET');
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
    if (/^[1-4]$/.test(value)) return rows[Number(value) - 1]?.dataset.aircraftId || null;
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
      aircraft.value = command.profile;
      emitChange(aircraft, 'change');
      return result(true, 'AIRCRAFT PROFILE SELECTED');
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
        field.value = command.profile;
        emitChange(field, 'change');
        return result(true, `${tacticalCallsign(command.aircraft)} PROFILE SELECTED`);
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
        leader.value = id;
        emitChange(leader, 'change');
        return result(true, `${tacticalCallsign(id)} IS FORMATION LEADER`);
      }
      if (command.intent === 'toggle-formation-member') {
        const callsign = tacticalCallsign(command.aircraft);
        const chip = Array.from(documentRef.querySelectorAll('.tactical-member-chip')).find(button => (
          Voice.normalizeTranscript(button.textContent) === Voice.normalizeTranscript(callsign)
        ));
        return clickElement(chip, `${callsign} FORMATION MEMBERSHIP UPDATED`);
      }
      if (command.intent === 'start-exercise') return clickId('tStart', 'TACTICAL EXERCISE STARTED');
      return result(false, 'COMMAND IS NOT AVAILABLE IN TACTICAL SETUP');
    }

    if (!activeScreen('tConsole')) return result(false, 'COMMAND IS NOT AVAILABLE ON THIS SCREEN');
    if (command.aircraft && !tacticalId(command.aircraft)) return result(false, 'AIRCRAFT IS NOT AVAILABLE');
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
    if (command.intent === 'set-field' && command.field === 'speed') {
      const change = applyInputValue($('tLiveSpeed'), command.value, ['input', 'change']);
      return change.ok ? result(true, `SPEED ${command.value} KT SET`) : change;
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

  function dispatchTranscript(transcript) {
    const command = Voice.parseCommand(transcript, {
      callsigns: tacticalCallsignOptions(),
      profiles: availableProfileOptions()
    });
    if (!command.accepted) {
      setStatus('COMMAND NOT RECOGNISED', 'error');
      return result(false, 'COMMAND NOT RECOGNISED');
    }
    const outcome = runCommand(command);
    setStatus(outcome.message, outcome.ok ? 'success' : 'error');
    return outcome;
  }

  function canContinueListening() {
    return state.continuous
      && !state.manuallyStopped
      && state.localAvailability === 'ready'
      && documentRef.visibilityState === 'visible';
  }

  function scheduleContinuousRestart() {
    if (!canContinueListening() || state.listening || state.starting || state.restartTimer) return;
    clearRestartTimer();
    state.restartTimer = root.setTimeout(() => {
      state.restartTimer = null;
      if (canContinueListening() && !state.listening && !state.starting) beginListening(true);
    }, 180);
  }

  function handleTerminalRecognitionError(error) {
    clearRestartTimer();
    clearPackRecheck();
    state.startAttempt += 1;
    state.starting = false;
    state.stopping = false;
    state.listening = false;
    state.manuallyStopped = true;
    state.pressHeld = false;
    state.continuous = false;
    if (error === 'language-not-supported') {
      state.localAvailability = 'downloadable';
      updatePrepareVisibility(true);
      setStatus('PREPARE LOCAL VOICE', 'neutral');
    } else if (error === 'not-allowed' || error === 'service-not-allowed') {
      state.localAvailability = 'permission-denied';
      updatePrepareVisibility(false);
      setStatus('MICROPHONE ACCESS DENIED', 'error');
    } else {
      state.localAvailability = 'unavailable';
      updatePrepareVisibility(false);
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
    }
    updateMicState();
  }

  function handleRecognitionError(error) {
    if (error === 'no-speech' || error === 'aborted') return;
    handleTerminalRecognitionError(error);
  }

  function handleRecognitionEnd() {
    state.starting = false;
    state.stopping = false;
    state.listening = false;
    updateMicState();
    if (canContinueListening()) scheduleContinuousRestart();
    else if (state.pressHeld && !state.continuous && !state.manuallyStopped && state.localAvailability === 'ready') beginListening(false);
    else if (state.localAvailability === 'ready') setStatus('HOLD TO TALK', 'neutral');
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
      state.stopping = false;
      state.listening = true;
      updateMicState();
      setStatus('LISTENING', 'active');
      return;
    }
    if (event.type === 'result') {
      if (typeof event.transcript === 'string' && event.transcript.trim()) dispatchTranscript(event.transcript);
      return;
    }
    if (event.type === 'error') {
      handleRecognitionError(String(event.code || 'unavailable'));
      return;
    }
    if (event.type === 'ended') handleRecognitionEnd();
  }

  function initializeRecognition() {
    if (nativeVoiceBridge()) return null;
    if (state.recognition) return state.recognition;
    const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (typeof Recognition !== 'function') {
      state.localAvailability = 'unavailable';
      updateMicState();
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return null;
    }
    try {
      const recognition = new Recognition();
      if (!('processLocally' in recognition)) {
        state.localAvailability = 'unavailable';
        updateMicState();
        setStatus('LOCAL VOICE UNAVAILABLE', 'error');
        return null;
      }
      recognition.lang = LOCAL_LANGUAGE;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.processLocally = true;
      recognition.onstart = () => {
        if (state.manuallyStopped || (!state.continuous && !state.pressHeld)) {
          state.starting = false;
          try {
            if (typeof recognition.abort === 'function') recognition.abort();
            else recognition.stop();
          } catch { /* The cancelled recognizer has already stopped. */ }
          return;
        }
        state.starting = false;
        state.stopping = false;
        state.listening = true;
        updateMicState();
        setStatus('LISTENING', 'active');
      };
      recognition.onresult = event => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const item = event.results[index];
          if (!item?.isFinal) continue;
          const transcript = item[0]?.transcript || '';
          const normalized = Voice.normalizeTranscript(transcript);
          const now = Date.now();
          if (!normalized || (normalized === state.lastTranscript && now - state.lastTranscriptAt < RECENT_TRANSCRIPT_WINDOW_MS)) continue;
          state.lastTranscript = normalized;
          state.lastTranscriptAt = now;
          dispatchTranscript(transcript);
        }
      };
      recognition.onerror = event => {
        handleRecognitionError(event.error);
      };
      recognition.onend = handleRecognitionEnd;
      state.recognition = recognition;
      state.recognitionConstructor = Recognition;
      return recognition;
    } catch {
      state.localAvailability = 'unavailable';
      updateMicState();
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return null;
    }
  }

  async function checkLocalAvailability(options) {
    const force = Boolean(options?.force);
    const nativeBridge = nativeVoiceBridge();
    if (nativeBridge) {
      let capability = 'unavailable';
      try { capability = String(nativeBridge.getCapability() || 'unavailable'); } catch { /* Native bridge is unavailable. */ }
      state.localAvailability = capability === 'available' ? 'ready' : 'unavailable';
      updatePrepareVisibility(false);
      updateMicState();
      if (state.localAvailability !== 'ready') setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return state.localAvailability === 'ready';
    }
    if (!force && state.localAvailability === 'ready') return true;
    if (state.availabilityPromise) return state.availabilityPromise;

    const check = (async () => {
      const recognition = initializeRecognition();
      if (!recognition) return false;
      const Recognition = state.recognitionConstructor;
      if (typeof Recognition.available !== 'function') {
        state.localAvailability = 'ready';
        updateMicState();
        return true;
      }
      try {
        const availability = await Recognition.available(LOCAL_PACK_CHECK);
        state.localAvailability = availability;
        updatePrepareVisibility(availability === 'downloadable');
        updateMicState();
        if (availability === 'available') {
          state.localAvailability = 'ready';
          clearPackRecheck();
          updatePrepareVisibility(false);
          updateMicState();
          return true;
        }
        if (availability === 'downloadable') {
          clearPackRecheck();
          setSettingsOpen(true);
          setStatus('PREPARE LOCAL VOICE', 'neutral');
        } else if (availability === 'downloading') {
          setStatus('LOCAL VOICE PREPARING', 'active');
          if (!options?.fromPackRecheck) schedulePackRecheck();
        } else {
          clearPackRecheck();
          setStatus('LOCAL VOICE UNAVAILABLE', 'error');
        }
      } catch {
        clearPackRecheck();
        state.localAvailability = 'unavailable';
        updateMicState();
        setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      }
      return false;
    })();
    state.availabilityPromise = check;
    try {
      return await check;
    } finally {
      if (state.availabilityPromise === check) state.availabilityPromise = null;
    }
  }

  async function prepareLocalVoice() {
    if (state.installPromise) return state.installPromise;
    if (nativeVoiceBridge()) {
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return false;
    }
    const recognition = initializeRecognition();
    const Recognition = state.recognitionConstructor;
    if (!recognition || typeof Recognition?.install !== 'function') {
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return false;
    }
    const install = (async () => {
      try {
        state.localAvailability = 'downloading';
        updateMicState();
        setStatus('LOCAL VOICE PREPARING', 'active');
        const installed = await Recognition.install({ langs: [LOCAL_LANGUAGE] });
        if (!installed) throw new Error('installation failed');
        return checkLocalAvailability({ force: true });
      } catch {
        state.localAvailability = 'unavailable';
        updateMicState();
        setStatus('LOCAL VOICE UNAVAILABLE', 'error');
        return false;
      }
    })();
    state.installPromise = install;
    updateMicState();
    try {
      return await install;
    } finally {
      if (state.installPromise === install) state.installPromise = null;
      updateMicState();
    }
  }

  async function startListening(continuous) {
    if (state.listening || state.starting) return true;
    const attempt = ++state.startAttempt;
    const available = await checkLocalAvailability();
    const shouldStart = continuous
      ? state.continuous && !state.manuallyStopped
      : state.pressHeld && !state.continuous;
    if (attempt !== state.startAttempt || !available || !shouldStart) return false;
    const nativeBridge = nativeVoiceBridge();
    state.starting = true;
    state.stopping = false;
    if (nativeBridge) {
      try {
        nativeBridge.start(Boolean(continuous));
        return true;
      } catch {
        state.starting = false;
        setStatus('LOCAL VOICE UNAVAILABLE', 'error');
        return false;
      }
    }
    const recognition = state.recognition;
    if (!recognition) {
      state.starting = false;
      return false;
    }
    recognition.continuous = Boolean(continuous);
    try {
      recognition.start();
      return true;
    } catch {
      state.starting = false;
      setStatus('LOCAL VOICE UNAVAILABLE', 'error');
      return false;
    }
  }

  function beginListening(continuous) {
    state.manuallyStopped = false;
    return startListening(continuous);
  }

  function stopListening(options) {
    const cancel = Boolean(options?.cancel);
    state.manuallyStopped = true;
    state.startAttempt += 1;
    clearRestartTimer();
    const nativeBridge = nativeVoiceBridge();
    if (state.starting && !state.listening) {
      state.starting = false;
      state.stopping = false;
      state.listening = false;
      try {
        if (nativeBridge) nativeBridge.cancel();
        else if (typeof state.recognition?.abort === 'function') state.recognition.abort();
        else state.recognition?.stop();
      } catch { /* The cancelled recognizer has already stopped. */ }
      updateMicState();
      return;
    }
    if (state.recognition && state.listening) {
      state.stopping = true;
      try {
        if (cancel && typeof state.recognition.abort === 'function') state.recognition.abort();
        else state.recognition.stop();
      } catch { /* Recognition is already stopped. */ }
    } else if (nativeBridge && state.listening) {
      state.stopping = true;
      try {
        if (cancel) nativeBridge.cancel();
        else nativeBridge.stop();
      } catch { /* Native recognition is already stopped. */ }
    }
  }

  function setListeningMode(mode) {
    const continuous = mode === 'continuous';
    state.continuous = continuous;
    updateMicState();
    if (!continuous) {
      stopListening({ cancel: true });
      return result(true, 'PRESS TO TALK MODE');
    }
    beginListening(true);
    return result(true, 'CONTINUOUS LISTENING ON');
  }

  function createDock() {
    const dock = documentRef.createElement('aside');
    dock.className = 'voice-dock';
    dock.setAttribute('aria-label', 'Local voice controls');

    const mic = documentRef.createElement('button');
    mic.type = 'button';
    mic.className = 'voice-mic';
    mic.textContent = 'HOLD TO TALK';
    mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-label', 'Hold to speak a local voice command');

    const settingsToggle = documentRef.createElement('button');
    settingsToggle.type = 'button';
    settingsToggle.className = 'voice-settings-toggle';
    settingsToggle.textContent = 'VOICE';
    settingsToggle.setAttribute('aria-expanded', 'false');
    settingsToggle.setAttribute('aria-label', 'Voice settings');

    const status = documentRef.createElement('output');
    status.className = 'voice-status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'HOLD TO TALK';

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
    prepare.textContent = 'PREPARE LOCAL VOICE';
    prepare.hidden = true;

    const localOnly = documentRef.createElement('small');
    localOnly.textContent = 'LOCAL SPEECH ONLY';
    settings.append(continuousLabel, prepare, localOnly);
    dock.append(mic, settingsToggle, status, settings);
    documentRef.body.appendChild(dock);

    state.dock = dock;
    state.mic = mic;
    state.status = status;
    state.settings = settings;
    state.settingsToggle = settingsToggle;
    state.continuousInput = continuousInput;
    state.prepareButton = prepare;

    settingsToggle.addEventListener('click', () => {
      const opening = settings.hidden;
      setSettingsOpen(opening);
      if (opening) checkLocalAvailability({ force: true });
    });
    prepare.addEventListener('click', prepareLocalVoice);
    continuousInput.addEventListener('change', () => setListeningMode(continuousInput.checked ? 'continuous' : 'push-to-talk'));

    const beginPressToTalk = event => {
      if (state.continuous) return;
      event.preventDefault();
      state.pressHeld = true;
      if (typeof mic.setPointerCapture === 'function' && event.pointerId !== undefined) mic.setPointerCapture(event.pointerId);
      beginListening(false);
    };
    const endPressToTalk = event => {
      if (state.continuous) return;
      if (event) event.preventDefault();
      state.pressHeld = false;
      stopListening();
    };
    mic.addEventListener('pointerdown', beginPressToTalk);
    ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].forEach(type => mic.addEventListener(type, endPressToTalk));
    mic.addEventListener('keydown', event => {
      if (state.continuous || (event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
      event.preventDefault();
      state.pressHeld = true;
      beginListening(false);
    });
    mic.addEventListener('keyup', event => {
      if (state.continuous || (event.key !== ' ' && event.key !== 'Enter')) return;
      endPressToTalk(event);
    });
    mic.addEventListener('click', () => {
      if (!state.continuous) return;
      if (state.listening || state.starting) stopListening({ cancel: true });
      else beginListening(true);
    });

    root.addEventListener('blur', () => {
      state.pressHeld = false;
      stopListening({ cancel: true });
    });
    documentRef.addEventListener('visibilitychange', () => {
      if (documentRef.visibilityState !== 'visible') {
        state.pressHeld = false;
        stopListening({ cancel: true });
      }
    });
    updateMicState();
  }

  createDock();
  root.QGHVoiceWorkspace = Object.freeze({
    dispatchTranscript,
    runCommand,
    pageKind,
    stopListening,
    receiveNativeVoiceEvent
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
