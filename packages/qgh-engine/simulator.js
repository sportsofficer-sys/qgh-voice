(function initialiseSimulator() {
  'use strict';

  const Core = window.QGHCore;
  if (!Core) throw new Error('QGH flight core failed to load.');

  const { advanceArc, closestApproachToOverhead, normalize, radians, turnRadiusNm } = Core;
  const PHYSICS_STEP_SECONDS = .25;
  const OVERHEAD_ZONE_NM = .25;
  const DF_WINDOW_MS = 4000;
  // The original 3× review pace is the new 1× baseline.  Replay then advances
  // one, two, or three recorded quarter-second samples at a smooth cadence.
  const REPLAY_FRAME_MS = 37;
  const ADVANCE_FLIGHT_SECONDS = 60;
  const profiles = {
    fighter: { speed: 240, rate: 3 }, transport: { speed: 200, rate: 2 }, helicopter: { speed: 120, rate: 2.5 },
    tejas: { speed: 250, rate: 3 }, rafale: { speed: 250, rate: 3 }, su30: { speed: 250, rate: 3 }, mirage: { speed: 240, rate: 3 }, jaguar: { speed: 230, rate: 2.8 },
    c17: { speed: 220, rate: 1.8 }, c130: { speed: 180, rate: 2 }, an32: { speed: 160, rate: 2 }, mi17: { speed: 110, rate: 2.5 },
    chinook: { speed: 120, rate: 2.2 }, apache: { speed: 120, rate: 3 }, alh: { speed: 110, rate: 2.5 }
  };

  const state = {
    procedure: 'normal',
    bearingMode: 'qdm',
    cfg: null,
    plane: null,
    phase: 'recovery',
    targetHeading: null,
    forcedTurnSide: null,
    initialTurnSide: null,
    manualTurnSide: null,
    manualTurnRecord: null,
    pendingLeg: null,
    flightTimer: null,
    dfExpiry: null,
    dfLive: false,
    clockTimer: null,
    clockRunning: false,
    clockSeconds: 0,
    terminationPending: null,
    path: [],
    commands: [],
    procedureTurns: { overhead: null, base: null },
    reviewMaxRange: null,
    initialSignatures: new Set(),
    replaySpeed: 1,
    replayIndex: 0,
    replayTimer: null,
    replayPaused: false,
    reviewZoomEnabled: false,
    toastTimer: null,
    speedChangeTimer: null
  };

  const $ = id => document.getElementById(id);
  const padHeading = value => String(Math.round(normalize(value))).padStart(3, '0');
  const signedHeadingDelta = (from, to) => normalize(to - from + 180) - 180;
  const headingError = (a, b) => Math.abs(signedHeadingDelta(b, a));
  const rangeNm = () => Math.hypot(state.plane.x, state.plane.y);
  const qte = () => normalize(Math.atan2(state.plane.x, -state.plane.y) * 180 / Math.PI);
  const qdm = () => normalize(qte() + 180);
  const bearingLabel = () => state.bearingMode === 'qdm' ? 'QDM · HOMING' : 'QTE · TRUE BEARING';

  function turnDescriptor(side, from, to) {
    const degrees = side === 'right' ? normalize(to - from) : normalize(from - to);
    return { side, degrees, way: degrees <= 180 ? 'SHORTER WAY' : 'LONGER WAY' };
  }

  function formatTurn(turn) {
    return turn ? `${turn.side.toUpperCase()} · ${Math.round(turn.degrees)}° · ${turn.way}` : '—';
  }

  function formatTime(seconds) {
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    const remaining = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `${minutes}:${remaining}`;
  }

  function randomInteger() {
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const values = new Uint32Array(1);
      window.crypto.getRandomValues(values);
      return values[0] % 360;
    }
    return Math.floor(Math.random() * 360);
  }

  function inputDegrees(id) {
    const value = Number($(id).value);
    if (!Number.isFinite(value) || value < 0 || value > 359) {
      throw new Error(`${id} must be from 000 to 359.`);
    }
    return normalize(value);
  }

  function inputNumber(id, minimum, maximum, label) {
    const value = Number($(id).value);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${label} must be from ${minimum} to ${maximum}.`);
    }
    return value;
  }

  function setPressed(element, selected) {
    element.setAttribute('aria-pressed', String(selected));
  }

  function chooseProcedure(procedure) {
    state.procedure = procedure;
    setPressed($('normal'), procedure === 'normal');
    setPressed($('us'), procedure === 'us');
  }

  function chooseBearingMode(mode) {
    state.bearingMode = mode;
    setPressed($('qdm'), mode === 'qdm');
    setPressed($('qte'), mode === 'qte');
    renderDF();
  }

  function chooseReplaySpeed(speed) {
    state.replaySpeed = speed;
    document.querySelectorAll('[data-replay-speed]').forEach(button => {
      setPressed(button, Number(button.dataset.replaySpeed) === speed);
    });
    if (state.replayTimer) {
      clearReplay(false);
      scheduleReplay();
      updateReplayButton();
    }
  }

  function updateReplayButton() {
    const button = $('replay');
    if (!button) return;
    const replaying = Boolean(state.replayTimer);
    button.textContent = replaying ? 'PAUSE REPLAY' : (state.replayPaused ? 'RESUME REPLAY' : 'REPLAY TRACK');
    setPressed(button, replaying);
  }

  function setReviewZoom(enabled) {
    state.reviewZoomEnabled = Boolean(enabled);
    const button = $('zoomToggle');
    if (button) {
      button.textContent = state.reviewZoomEnabled ? 'ZOOM ON' : 'ZOOM OFF';
      setPressed(button, state.reviewZoomEnabled);
    }
    if (window.QGHReview && typeof window.QGHReview.setZoomEnabled === 'function') {
      window.QGHReview.setZoomEnabled(state.reviewZoomEnabled);
    }
  }

  function fitReview() {
    if (window.QGHReview && typeof window.QGHReview.fit === 'function') window.QGHReview.fit();
    showToast('TRACK VIEW FIT');
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 1150);
  }

  function logCommand(type, detail) {
    state.commands.push({ time: formatTime(state.clockSeconds), type, detail });
  }

  function updateClock() {
    const time = formatTime(state.clockSeconds);
    $('clock').textContent = time;
    const readout = $('homingClock');
    if (readout) {
      readout.textContent = time;
      readout.setAttribute('aria-label', `Exercise clock, ${state.clockRunning ? 'running' : 'stopped'}: ${time}`);
    }
  }

  function startClock() {
    if (state.clockRunning) return;
    state.clockRunning = true;
    if ($('homingClock')) $('homingClock').hidden = false;
    updateClock();
    state.clockTimer = setInterval(() => {
      state.clockSeconds += 1;
      updateClock();
    }, 1000);
  }

  function stopClock() {
    state.clockRunning = false;
    clearInterval(state.clockTimer);
    state.clockTimer = null;
    updateClock();
  }

  function resetClock() {
    stopClock();
    state.clockSeconds = 0;
    if ($('homingClock')) $('homingClock').hidden = true;
    updateClock();
  }

  function stopFlightLoop() {
    clearInterval(state.flightTimer);
    state.flightTimer = null;
  }

  function startFlightLoop() {
    if (state.flightTimer) return;
    state.flightTimer = setInterval(() => physicsStep(PHYSICS_STEP_SECONDS), PHYSICS_STEP_SECONDS * 1000);
  }

  function clearDF() {
    clearTimeout(state.dfExpiry);
    state.dfExpiry = null;
    state.dfLive = false;
    $('bearing').textContent = '---';
    $('bearingType').textContent = bearingLabel();
    $('dfState').textContent = 'NO SIGNAL';
    $('signal').className = 'signal';
    $('signal').innerHTML = '<i></i>NO TRANSMISSION';
  }

  function renderDF() {
    if (!state.dfLive || !state.plane) {
      $('bearingType').textContent = bearingLabel();
      return;
    }
    if (rangeNm() <= OVERHEAD_ZONE_NM) {
      $('bearing').textContent = '---';
      $('bearingType').textContent = 'D/F · OVERHEAD INDICATION';
      $('dfState').textContent = 'OVERHEAD';
      return;
    }
    const bearing = state.bearingMode === 'qdm' ? qdm() : qte();
    $('bearing').textContent = `${padHeading(bearing)}°`;
    $('bearingType').textContent = bearingLabel();
    $('dfState').textContent = 'SIGNAL LIVE';
  }

  function transmit() {
    if (!state.plane) return;
    state.dfLive = true;
    const atOverhead = rangeNm() <= OVERHEAD_ZONE_NM;
    logCommand('TRANSMIT FOR D/F', atOverhead
      ? 'Overhead / no-bearing indication.'
      : `QDM ${padHeading(qdm())}°M · QTE ${padHeading(qte())}°T · ${rangeNm().toFixed(1)} NM.`);
    $('signal').className = 'signal live';
    $('signal').innerHTML = '<i></i>SIGNAL LIVE';
    renderDF();
    clearTimeout(state.dfExpiry);
    state.dfExpiry = setTimeout(() => clearDF(), DF_WINDOW_MS);
    showToast('D/F TRANSMISSION RECEIVED');
  }

  function requestHeading() {
    if (!state.plane) return;
    $('headingReply').textContent = `HEADING ${padHeading(state.plane.heading)}°M`;
    logCommand('REQUEST AIRCRAFT HEADING', `Aircraft reports ${padHeading(state.plane.heading)}°M.`);
    showToast('AIRCRAFT HEADING RECEIVED');
  }

  function requestDistance() {
    if (!state.plane) return;
    $('distanceReply').textContent = `RANGE ${rangeNm().toFixed(1)} NM`;
    logCommand('REQUEST DISTANCE', `Aircraft reports ${rangeNm().toFixed(1)} NM from overhead.`);
    showToast('RANGE RECEIVED');
  }

  function record() {
    state.path.push({
      x: state.plane.x,
      y: state.plane.y,
      heading: state.plane.heading
    });
  }

  function turnDeltaForStep(duration) {
    const maximum = state.cfg.rate * duration;
    if (state.manualTurnSide) return state.manualTurnSide === 'left' ? -maximum : maximum;
    if (state.initialTurnSide) return state.initialTurnSide === 'left' ? -maximum : maximum;
    if (state.targetHeading === null) return 0;

    if (state.forcedTurnSide) {
      const remaining = state.forcedTurnSide === 'right'
        ? normalize(state.targetHeading - state.plane.heading)
        : normalize(state.plane.heading - state.targetHeading);
      const direction = state.forcedTurnSide === 'right' ? 1 : -1;
      if (remaining < .001) {
        state.forcedTurnSide = null;
        return 0;
      }
      if (remaining <= maximum) {
        state.forcedTurnSide = null;
        return direction * remaining;
      }
      return direction * maximum;
    }

    const shortest = signedHeadingDelta(state.plane.heading, state.targetHeading);
    if (Math.abs(shortest) < .001) return 0;
    return Math.sign(shortest) * Math.min(Math.abs(shortest), maximum);
  }

  function markOverheadIfPassed(previous, next) {
    if (state.phase !== 'recovery') return;
    const closest = closestApproachToOverhead(previous, next);
    if (closest.rangeNm > OVERHEAD_ZONE_NM) return;
    state.phase = 'overhead';
    logCommand('OVERHEAD', `Overhead zone passed at ${closest.rangeNm.toFixed(2)} NM; continuous path retained.`);
  }

  function checkPendingLeg(distanceFlown) {
    const pending = state.pendingLeg;
    if (!pending || state.manualTurnSide || state.forcedTurnSide || headingError(state.plane.heading, pending.target) > .2) return;
    pending.distance += distanceFlown;
    if (pending.distance < .05) return;
    state.phase = pending.phase;
    state.procedureTurns[pending.turnKey] = pending.turn;
    logCommand(pending.label, `${formatTurn(pending.turn)} · established on ${padHeading(pending.target)}°M.`);
    state.pendingLeg = null;
  }

  function physicsStep(duration) {
    if (!state.plane || !state.cfg) return;
    const previous = { x: state.plane.x, y: state.plane.y };
    const deltaHeading = turnDeltaForStep(duration);
    const motion = advanceArc(state.plane, state.plane.heading, state.cfg.speed, deltaHeading / duration, duration);
    state.plane = { x: motion.x, y: motion.y, heading: motion.heading };
    markOverheadIfPassed(previous, state.plane);
    checkPendingLeg(motion.distanceNm);
    if (state.dfLive) renderDF();
    record();
    updateNormalContinueControl();
  }

  function advanceFlight() {
    if (!state.plane || !state.cfg) return;
    const startingHeading = state.plane.heading;
    const startingRange = rangeNm();
    const steps = ADVANCE_FLIGHT_SECONDS / PHYSICS_STEP_SECONDS;
    for (let step = 0; step < steps; step += 1) physicsStep(PHYSICS_STEP_SECONDS);
    logCommand(
      'ADVANCE FLIGHT · 1 MIN',
      `60 seconds simulated · ${padHeading(startingHeading)}°M / ${startingRange.toFixed(1)} NM to ${padHeading(state.plane.heading)}°M / ${rangeNm().toFixed(1)} NM.`
    );
    showToast('FLIGHT ADVANCED 1 MINUTE');
  }

  function establishLegIfNeeded(side, actualHeading, tolerance = .2, turn = null) {
    if (state.phase === 'overhead' && headingError(actualHeading, state.cfg.outbound) <= tolerance) {
      state.pendingLeg = {
        phase: 'outbound', target: actualHeading, side, distance: 0,
        turnKey: 'overhead', turn,
        label: 'OUTBOUND TRACK'
      };
      return;
    }
    if (state.phase === 'outbound' && headingError(actualHeading, state.cfg.inbound) <= tolerance) {
      state.pendingLeg = {
        phase: 'inbound', target: actualHeading, side, distance: 0,
        turnKey: 'base', turn,
        label: `${side.toUpperCase()} BASE TURN`
      };
    }
  }

  function updateNormalContinueControl() {
    const control = $('continueHeading');
    if (!control) return;
    control.disabled = state.procedure !== 'normal' || !state.forcedTurnSide;
    control.dataset.turnSide = state.forcedTurnSide || '';
  }

  function issueHeading(side, continuation = false) {
    const heading = inputDegrees('headingInput');
    const turn = turnDescriptor(side, state.plane.heading, heading);
    state.initialTurnSide = null;
    state.manualTurnSide = null;
    state.targetHeading = heading;
    state.forcedTurnSide = side;
    establishLegIfNeeded(side, heading, .2, turn);
    const radius = turnRadiusNm(state.cfg.speed, state.cfg.rate);
    const label = continuation ? `CONTINUE ${side.toUpperCase()}` : `TURN ${side.toUpperCase()}`;
    logCommand(label, `Heading ${padHeading(heading)}°M · ${Math.round(turn.degrees)}° turn · nominal radius ${radius.toFixed(2)} NM.`);
    updateNormalContinueControl();
    startFlightLoop();
    showToast(`${label} ACCEPTED`);
  }

  function continueHeading() {
    if (!state.plane || state.procedure !== 'normal' || !state.forcedTurnSide) {
      showToast('NO HEADING TURN TO CONTINUE');
      return;
    }
    issueHeading(state.forcedTurnSide, true);
  }

  function updateUsTurnControls() {
    const turning = Boolean(state.manualTurnSide || state.initialTurnSide);
    $('turnLeft').disabled = turning;
    $('turnRight').disabled = turning;
    $('turnStop').disabled = !turning;
  }

  function startTurn(side) {
    if (!state.plane || state.manualTurnSide || state.initialTurnSide) return;
    state.initialTurnSide = null;
    state.targetHeading = null;
    state.forcedTurnSide = null;
    state.manualTurnSide = side;
    const target = state.phase === 'overhead' ? state.cfg.outbound : state.phase === 'outbound' ? state.cfg.inbound : null;
    state.manualTurnRecord = { side, target, startHeading: state.plane.heading };
    updateUsTurnControls();
    logCommand(`TURN ${side.toUpperCase()} NOW`, `Timed turn at ${state.cfg.rate.toFixed(1)}°/sec · nominal radius ${turnRadiusNm(state.cfg.speed, state.cfg.rate).toFixed(2)} NM.`);
    startFlightLoop();
    showToast(`TURN ${side.toUpperCase()} NOW`);
  }

  function stopTurn() {
    if (!state.manualTurnSide && !state.initialTurnSide) return;
    const record = state.manualTurnRecord;
    state.manualTurnSide = null;
    state.initialTurnSide = null;
    state.targetHeading = state.plane.heading;
    state.forcedTurnSide = null;
    if (record && record.target !== null && headingError(state.plane.heading, record.target) <= 2) {
      establishLegIfNeeded(record.side, state.plane.heading, 2, turnDescriptor(record.side, record.startHeading, state.plane.heading));
    }
    state.manualTurnRecord = null;
    updateUsTurnControls();
    updateNormalContinueControl();
    logCommand('STOP TURN NOW', `Aircraft levels on ${padHeading(state.plane.heading)}°M.`);
    startFlightLoop();
    showToast('TURN STOPPED');
  }

  function setConsoleProcedure() {
    const usCompass = state.procedure === 'us';
    $('consoleTitle').textContent = usCompass ? 'U/S Compass console' : 'Normal QGH console';
    $('badge').textContent = usCompass ? 'U/S COMPASS' : 'NORMAL QGH';
    $('badge').classList.toggle('us', usCompass);
    $('normalCtl').hidden = usCompass;
    $('usCtl').hidden = !usCompass;
    $('requestHeading').hidden = usCompass;
    $('infoRow').classList.toggle('single', usCompass);
    updateNormalContinueControl();
  }

  function resetConsole() {
    clearDF();
    $('headingReply').textContent = 'HEADING —';
    $('distanceReply').textContent = 'RANGE —';
    $('controls').classList.remove('mobile-collapsed');
    $('mobileControlsToggle').setAttribute('aria-expanded', 'true');
    updateUsTurnControls();
    setConsoleProcedure();
  }

  function clearReplay(reset = true) {
    clearTimeout(state.replayTimer);
    state.replayTimer = null;
    if (reset) {
      state.replayPaused = false;
      state.replayIndex = 0;
    }
    updateReplayButton();
  }

  function drawReview(count, replaying = false) {
    const visibleCount = count ?? state.path.length;
    const elapsedSeconds = Math.max(0, (Math.min(visibleCount, state.path.length) - 1) * PHYSICS_STEP_SECONDS);
    $('replayElapsed').textContent = `${replaying ? 'REPLAY' : 'TRACK'} ${formatTime(elapsedSeconds)}`;
    window.QGHReview.draw({ cfg: state.cfg, path: state.path, maxRange: state.reviewMaxRange, turns: state.procedureTurns, count: visibleCount });
  }

  function scheduleReplay() {
    if (!state.path.length || state.replayIndex >= state.path.length) {
      state.replayTimer = null;
      state.replayPaused = false;
      updateReplayButton();
      return;
    }
    state.replayTimer = setTimeout(() => {
      state.replayIndex = Math.min(state.path.length, state.replayIndex + state.replaySpeed);
      drawReview(state.replayIndex, true);
      scheduleReplay();
    }, REPLAY_FRAME_MS);
  }

  function replay() {
    if (!state.path.length) return;
    if (state.replayTimer) {
      clearReplay(false);
      state.replayPaused = true;
      updateReplayButton();
      showToast('REPLAY PAUSED');
      return;
    }
    if (state.replayPaused && state.replayIndex < state.path.length) {
      state.replayPaused = false;
      scheduleReplay();
      updateReplayButton();
      showToast(`REPLAY ${state.replaySpeed}×`);
      return;
    }
    clearReplay(false);
    state.replayIndex = 1;
    state.replayPaused = false;
    drawReview(state.replayIndex, true);
    scheduleReplay();
    updateReplayButton();
    showToast(`REPLAY ${state.replaySpeed}×`);
  }

  function renderCommands() {
    const logs = $('logs');
    logs.replaceChildren();
    state.commands.forEach(command => {
      const item = document.createElement('article');
      item.className = 'log';
      const title = document.createElement('span');
      const detail = document.createElement('small');
      title.textContent = `${command.time} · ${command.type}`;
      detail.textContent = command.detail;
      item.append(title, detail);
      logs.appendChild(item);
    });
  }

  function prepareReview() {
    let furthestRange = state.cfg.distance;
    state.path.forEach(point => {
      furthestRange = Math.max(furthestRange, Math.hypot(point.x, point.y));
    });
    state.reviewMaxRange = furthestRange;
    $('sumRunway').textContent = `${padHeading(state.cfg.runway)}°M`;
    $('sumOutbound').textContent = `${padHeading(state.cfg.outbound)}°M`;
    $('sumInbound').textContent = `${padHeading(state.cfg.inbound)}°M`;
    $('sumProcedure').textContent = state.procedure === 'us' ? 'U/S COMPASS' : 'NORMAL QGH';
    $('sumInitial').textContent = `${state.cfg.distance.toFixed(1)} NM`;
    $('sumTerminal').textContent = `${rangeNm().toFixed(1)} NM`;
    $('sumSpeed').textContent = `${state.cfg.speed} KT`;
    $('sumTx').textContent = String(state.commands.filter(command => command.type === 'TRANSMIT FOR D/F').length);
    $('sumOverheadTurn').textContent = formatTurn(state.procedureTurns.overhead);
    $('sumBaseTurn').textContent = formatTurn(state.procedureTurns.base);
    renderCommands();
    drawReview(state.path.length);
    setReviewZoom(false);
  }

  function showScreen(id) {
    ['setup', 'console', 'analysis'].forEach(screen => $(screen).classList.toggle('active', screen === id));
    const focusTarget = id === 'console' ? $('consoleTitle') : (id === 'analysis' ? $('analysisTitle') : $('setup'));
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll: true });
  }

  function terminate() {
    if (!state.plane) return;
    state.terminationPending = null;
    commitLiveSpeedChange();
    stopFlightLoop();
    clearDF();
    stopClock();
    clearReplay();
    logCommand('TERMINATED', 'Exercise terminated by controller.');
    prepareReview();
    showScreen('analysis');
    scrollToScreenTop();
    showToast('FLIGHT PATH READY');
  }

  function requestTermination() {
    if (!state.plane) return;
    const dialog = $('terminateDialog');
    if (dialog && typeof dialog.showModal === 'function') {
      if (!dialog.open) {
        state.terminationPending = {
          flightWasRunning: Boolean(state.flightTimer),
          clockWasRunning: state.clockRunning
        };
        stopFlightLoop();
        stopClock();
        dialog.showModal();
      }
      return;
    }
    terminate();
  }

  function closeTerminationDialog(resumeExercise = true) {
    const dialog = $('terminateDialog');
    if (dialog && typeof dialog.close === 'function' && dialog.open) dialog.close();
    const pending = state.terminationPending;
    state.terminationPending = null;
    if (!resumeExercise || !pending || !state.plane) return;
    if (pending.flightWasRunning) startFlightLoop();
    if (pending.clockWasRunning) startClock();
  }

  function confirmTermination() {
    closeTerminationDialog(false);
    terminate();
  }

  function scrollToScreenTop() {
    if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  function startExercise() {
    try {
      clearReplay();
      clearLiveSpeedChange();
      stopFlightLoop();
      clearDF();
      stopClock();
      state.cfg = {
        runway: inputDegrees('runway'),
        inbound: inputDegrees('inbound'),
        outbound: inputDegrees('outbound'),
        speed: inputNumber('speed', 60, 600, 'Ground speed'),
        rate: inputNumber('rate', .5, 8, 'Rate of turn'),
        distance: inputNumber('distance', 5, 50, 'Initial distance'),
        type: $('aircraft').value
      };
      let initialBearing;
      let initialHeading;
      let initialTurn;
      let signature;
      do {
        initialBearing = randomInteger();
        initialHeading = randomInteger();
        initialTurn = ['straight', 'left', 'right'][randomInteger() % 3];
        signature = `${initialBearing}|${initialHeading}|${initialTurn}`;
      } while (state.initialSignatures.has(signature));
      state.initialSignatures.add(signature);
      state.plane = {
        x: Math.sin(radians(initialBearing)) * state.cfg.distance,
        y: -Math.cos(radians(initialBearing)) * state.cfg.distance,
        heading: initialHeading
      };
      state.phase = 'recovery';
      state.targetHeading = initialHeading;
      state.forcedTurnSide = null;
      state.initialTurnSide = initialTurn === 'straight' ? null : initialTurn;
      state.manualTurnSide = null;
      state.manualTurnRecord = null;
      state.pendingLeg = null;
      state.path = [];
      state.commands = [];
      state.procedureTurns = { overhead: null, base: null };
      state.reviewMaxRange = null;
      resetClock();
      record();
      $('headingInput').value = Math.round(state.cfg.inbound);
      $('liveSpeed').value = state.cfg.speed;
      $('liveSpeed').dataset.lastLogged = String(state.cfg.speed);
      resetConsole();
      logCommand('SETUP', `${state.cfg.type.toUpperCase()} · random QTE ${padHeading(initialBearing)}°T · ${state.cfg.distance.toFixed(1)} NM · ${state.cfg.speed} KT · initial ${initialTurn.toUpperCase()} flight.`);
      showScreen('console');
      scrollToScreenTop();
      startFlightLoop();
      showToast('EXERCISE STARTED');
    } catch (error) {
      alert(error.message);
    }
  }

  function newExercise() {
    clearReplay();
    showScreen('setup');
    scrollToScreenTop();
  }

  function returnToConsole() {
    clearReplay();
    showScreen('console');
    scrollToScreenTop();
  }

  function updateProfile() {
    const profile = profiles[$('aircraft').value];
    $('speed').value = profile.speed;
    $('rate').value = profile.rate;
  }

  function clearLiveSpeedChange() {
    clearTimeout(state.speedChangeTimer);
    state.speedChangeTimer = null;
  }

  function commitLiveSpeedChange() {
    clearLiveSpeedChange();
    if (!state.cfg || !state.plane) return;
    const speed = state.cfg.speed;
    if (Number($('liveSpeed').dataset.lastLogged) === speed) return;
    logCommand('GROUND SPEED', `Set to ${speed} KT; subsequent turn radius updates continuously.`);
    $('liveSpeed').dataset.lastLogged = String(speed);
    showToast(`GROUND SPEED ${speed} KT`);
  }

  function updateLiveSpeed() {
    if (!state.cfg || !state.plane) return;
    const speed = Number($('liveSpeed').value);
    if (!Number.isFinite(speed) || speed < 60 || speed > 600) return;
    state.cfg.speed = speed;
    clearLiveSpeedChange();
    state.speedChangeTimer = setTimeout(commitLiveSpeedChange, 450);
  }

  function toggleMobileControls() {
    const collapsed = $('controls').classList.toggle('mobile-collapsed');
    $('mobileControlsToggle').setAttribute('aria-expanded', String(!collapsed));
    showToast(collapsed ? 'CONTROLS COLLAPSED' : 'CONTROLS EXPANDED');
  }

  function bindEvents() {
    $('normal').addEventListener('click', () => chooseProcedure('normal'));
    $('us').addEventListener('click', () => chooseProcedure('us'));
    $('qdm').addEventListener('click', () => chooseBearingMode('qdm'));
    $('qte').addEventListener('click', () => chooseBearingMode('qte'));
    $('aircraft').addEventListener('change', updateProfile);
    $('startExercise').addEventListener('click', startExercise);
    $('transmit').addEventListener('click', transmit);
    $('terminate').addEventListener('click', requestTermination);
    $('advanceFlight').addEventListener('click', advanceFlight);
    $('requestHeading').addEventListener('click', requestHeading);
    $('requestDistance').addEventListener('click', requestDistance);
    $('turnHeadingLeft').addEventListener('click', () => issueHeading('left'));
    $('turnHeadingRight').addEventListener('click', () => issueHeading('right'));
    $('continueHeading').addEventListener('click', continueHeading);
    $('turnLeft').addEventListener('click', () => startTurn('left'));
    $('turnRight').addEventListener('click', () => startTurn('right'));
    $('turnStop').addEventListener('click', stopTurn);
    $('liveSpeed').addEventListener('input', updateLiveSpeed);
    $('liveSpeed').addEventListener('change', () => {
      updateLiveSpeed();
      commitLiveSpeedChange();
    });
    $('mobileControlsToggle').addEventListener('click', toggleMobileControls);
    $('clockStart').addEventListener('click', startClock);
    $('clockStop').addEventListener('click', stopClock);
    $('clockReset').addEventListener('click', resetClock);
    $('restartExercise').addEventListener('click', startExercise);
    $('returnConsole').addEventListener('click', returnToConsole);
    $('replay').addEventListener('click', replay);
    $('newExercise').addEventListener('click', newExercise);
    const confirmTerminate = $('confirmTerminate');
    const cancelTerminate = $('cancelTerminate');
    if (confirmTerminate) confirmTerminate.addEventListener('click', confirmTermination);
    if (cancelTerminate) cancelTerminate.addEventListener('click', closeTerminationDialog);
    const terminateDialog = $('terminateDialog');
    if (terminateDialog) terminateDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeTerminationDialog();
    });
    const zoomToggle = $('zoomToggle');
    const fitReviewButton = $('fitReview');
    if (zoomToggle) zoomToggle.addEventListener('click', () => setReviewZoom(!state.reviewZoomEnabled));
    if (fitReviewButton) fitReviewButton.addEventListener('click', fitReview);
    document.querySelectorAll('[data-replay-speed]').forEach(button => {
      button.addEventListener('click', () => chooseReplaySpeed(Number(button.dataset.replaySpeed)));
    });
  }

  bindEvents();
  chooseProcedure('normal');
  chooseBearingMode('qdm');
  chooseReplaySpeed(1);
  setReviewZoom(false);
  updateReplayButton();
  updateClock();
})();
