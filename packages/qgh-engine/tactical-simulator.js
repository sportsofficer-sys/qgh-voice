(function initialiseTacticalSimulator() {
  'use strict';

  const Core = window.QGHCore;
  const Tactical = window.QGHTacticalCore;
  if (!Core || !Tactical) throw new Error('Tactical QGH flight core failed to load.');

  const DF_WINDOW_MS = 4000;
  const REPLAY_FRAME_MS = 37;
  const ADVANCE_FLIGHT_SECONDS = 60;
  const profiles = {
    fighter: { label: 'Fighter', speed: 240, rate: 3 },
    transport: { label: 'Transport', speed: 200, rate: 2 },
    helicopter: { label: 'Helicopter', speed: 120, rate: 2.5 },
    tejas: { label: 'Tejas', speed: 250, rate: 3 },
    rafale: { label: 'Rafale', speed: 250, rate: 3 },
    su30: { label: 'Su-30 MKI', speed: 250, rate: 3 },
    mirage: { label: 'Mirage 2000', speed: 240, rate: 3 },
    jaguar: { label: 'Jaguar', speed: 230, rate: 2.8 },
    c17: { label: 'C-17', speed: 220, rate: 1.8 },
    c130: { label: 'C-130J', speed: 180, rate: 2 },
    an32: { label: 'An-32', speed: 160, rate: 2 },
    mi17: { label: 'Mi-17', speed: 110, rate: 2.5 },
    chinook: { label: 'Chinook', speed: 120, rate: 2.2 },
    apache: { label: 'Apache', speed: 120, rate: 3 },
    alh: { label: 'ALH', speed: 110, rate: 2.5 }
  };

  const initialFleet = [
    { id: 'A', callsign: 'FALCON 11', profile: 'fighter', color: '#007d7d', lineStyle: 'solid', distance: 25, level: 6000 },
    { id: 'B', callsign: 'RAVEN 21', profile: 'transport', color: '#296aa7', lineStyle: 'dash', distance: 25, level: 7000 },
    { id: 'C', callsign: 'VIPER 31', profile: 'helicopter', color: '#a36316', lineStyle: 'dot', distance: 25, level: 8000 },
    { id: 'D', callsign: 'HAWK 41', profile: 'fighter', color: '#7b4e80', lineStyle: 'dashdot', distance: 25, level: 9000 }
  ];

  const state = {
    procedure: 'normal',
    bearingMode: 'qdm',
    fleetCount: 3,
    fleetDrafts: initialFleet.map(item => ({ ...item, speed: profiles[item.profile].speed, rate: profiles[item.profile].rate })),
    formationEnabled: false,
    formationLeaderId: 'A',
    formationMemberIds: ['A', 'B', 'C'],
    exercise: null,
    activeAircraftId: null,
    railItems: new Map(),
    dfLive: false,
    dfAircraftId: null,
    dfExpiry: null,
    flightTimer: null,
    clockTimer: null,
    clockRunning: false,
    clockSeconds: 0,
    terminationPending: null,
    commands: [],
    reviewMaxRange: null,
    focusedReviewId: null,
    replaySpeed: 1,
    replayIndex: 0,
    replayTimer: null,
    replayPaused: false,
    reviewZoomEnabled: false,
    toastTimer: null,
    speedChangeTimer: null,
    pendingSpeedChange: null,
    lastLoggedSpeedById: {},
    initialSignatures: new Set()
  };

  const $ = id => document.getElementById(id);
  const padHeading = value => Tactical.padHeading(value);

  function exerciseRandom() {
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const values = new Uint32Array(1);
      window.crypto.getRandomValues(values);
      return values[0] / 4294967296;
    }
    return Math.random();
  }

  function formatTime(seconds) {
    const minutes = String(Math.floor(Number(seconds) / 60)).padStart(2, '0');
    const remaining = String(Math.floor(Number(seconds) % 60)).padStart(2, '0');
    return minutes + ':' + remaining;
  }

  function setPressed(element, selected) {
    element.setAttribute('aria-pressed', String(Boolean(selected)));
  }

  function setAircraftColour(element, color) {
    element.style.setProperty('--aircraft-colour', color);
  }

  function inputDegrees(id, label) {
    const element = $(id);
    const raw = String(element.value || '').trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0 || value > 359) {
      throw new Error((label || id) + ' must be from 000 to 359.');
    }
    return Core.normalize(value);
  }

  function inputNumberElement(element, minimum, maximum, label) {
    const raw = String(element.value || '').trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(label + ' must be from ' + minimum + ' to ' + maximum + '.');
    }
    return value;
  }

  function showToast(message) {
    const toast = $('tToast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
  }

  function currentAircraft() {
    if (!state.exercise || !state.activeAircraftId) return null;
    try {
      return Tactical.getAircraft(state.exercise, state.activeAircraftId);
    } catch (error) {
      return null;
    }
  }

  function aircraftById(id) {
    if (!state.exercise || !id) return null;
    try {
      return Tactical.getAircraft(state.exercise, id);
    } catch (error) {
      return null;
    }
  }

  function bearingLabel() {
    return state.bearingMode === 'qte' ? 'QTE · TRUE BEARING' : 'QDM · HOMING';
  }

  function phaseLabel(aircraft) {
    const map = { recovery: 'RECOVERY', overhead: 'OVERHEAD', outbound: 'OUTBOUND', inbound: 'INBOUND' };
    return map[aircraft.phase] || String(aircraft.phase || 'RECOVERY').toUpperCase();
  }

  function levelLabel(aircraft) {
    return 'LEVEL ' + Number(aircraft.level || 0).toLocaleString('en-IN') + ' FT';
  }

  function formationRole(aircraft) {
    if (!state.exercise || !aircraft) return 'INDEPENDENT';
    return Tactical.formationRoleFor(state.exercise, aircraft.id);
  }

  function formationLeader() {
    if (!state.exercise || !state.exercise.formation || !state.exercise.formation.enabled) return null;
    return aircraftById(state.exercise.formation.leaderId);
  }

  function formationStatus(aircraft) {
    const role = formationRole(aircraft);
    const leader = formationLeader();
    if (role === 'LEAD') {
      const followers = state.exercise.formation.memberIds.filter(id => id !== aircraft.id && !state.exercise.formation.detachedIds.includes(id)).length;
      return 'LEAD · ' + followers + ' ' + (followers === 1 ? 'WINGMAN' : 'WINGMEN');
    }
    if (role === 'FORMATION') return 'FOLLOWING ' + (leader ? leader.callsign : 'LEADER');
    return 'INDEPENDENT';
  }

  function logCommand(aircraftId, type, detail) {
    const aircraft = aircraftById(aircraftId);
    state.commands.push({
      time: formatTime(state.clockSeconds),
      aircraftId: aircraft ? aircraft.id : null,
      callsign: aircraft ? aircraft.callsign : 'FLIGHT',
      color: aircraft ? aircraft.color : '#617177',
      type,
      detail
    });
  }

  function logEvents(events) {
    events.forEach(item => logCommand(item.aircraftId, item.type, item.detail));
  }

  function updateClock() {
    $('tClock').textContent = formatTime(state.clockSeconds);
  }

  function startClock() {
    if (state.clockRunning) return;
    state.clockRunning = true;
    state.clockTimer = setInterval(() => {
      state.clockSeconds += 1;
      updateClock();
    }, 1000);
  }

  function stopClock() {
    state.clockRunning = false;
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }

  function resetClock() {
    stopClock();
    state.clockSeconds = 0;
    updateClock();
  }

  function stopFlightLoop() {
    clearInterval(state.flightTimer);
    state.flightTimer = null;
  }

  function startFlightLoop() {
    if (!state.exercise || state.flightTimer) return;
    state.flightTimer = setInterval(() => physicsStep(Tactical.STEP_SECONDS), Tactical.STEP_SECONDS * 1000);
  }

  function setSignal(live, text) {
    const signal = $('tSignal');
    signal.className = live ? 'tactical-signal live' : 'tactical-signal';
    signal.replaceChildren();
    const dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    signal.append(dot, document.createTextNode(text));
  }

  function clearDF() {
    clearTimeout(state.dfExpiry);
    state.dfExpiry = null;
    state.dfLive = false;
    state.dfAircraftId = null;
    renderDF();
  }

  function renderDF() {
    const selected = currentAircraft();
    const transmitted = state.dfLive ? aircraftById(state.dfAircraftId) : null;
    const aircraft = transmitted || selected;
    $('tActiveCallsign').textContent = aircraft ? aircraft.callsign : 'SELECT AN AIRCRAFT';
    $('tBearingType').textContent = bearingLabel();

    if (!state.dfLive || !transmitted) {
      $('tBearing').textContent = '---';
      $('tDfState').textContent = 'NO SIGNAL';
      setSignal(false, 'NO TRANSMISSION');
      return;
    }

    const bearing = Tactical.bearingFor(transmitted);
    if (bearing.overhead) {
      $('tBearing').textContent = '---';
      $('tBearingType').textContent = 'D/F · OVERHEAD INDICATION';
      $('tDfState').textContent = 'OVERHEAD';
      setSignal(true, transmitted.callsign + ' SIGNAL LIVE');
      return;
    }

    const value = state.bearingMode === 'qte' ? bearing.qte : bearing.qdm;
    $('tBearing').textContent = padHeading(value) + '°';
    $('tDfState').textContent = 'SIGNAL LIVE';
    setSignal(true, transmitted.callsign + ' SIGNAL LIVE');
  }

  function clearSpeedChange() {
    clearTimeout(state.speedChangeTimer);
    state.speedChangeTimer = null;
    state.pendingSpeedChange = null;
  }

  function commitLiveSpeedChange() {
    const pending = state.pendingSpeedChange;
    clearTimeout(state.speedChangeTimer);
    state.speedChangeTimer = null;
    state.pendingSpeedChange = null;
    if (!pending || !state.exercise) return;
    const last = state.lastLoggedSpeedById[pending.id];
    if (last === pending.speed) return;
    state.lastLoggedSpeedById[pending.id] = pending.speed;
    logCommand(pending.id, 'GROUND SPEED', pending.speed + ' KT selected.');
  }

  function updateLiveSpeed(showError) {
    const aircraft = currentAircraft();
    if (!aircraft || !state.exercise) return;
    if (formationRole(aircraft) === 'FORMATION') {
      const leader = formationLeader();
      $('tLiveSpeed').value = String(Math.round(leader ? leader.cfg.speed : aircraft.cfg.speed));
      if (showError) showToast('GROUND SPEED FOLLOWS THE FORMATION LEADER');
      return;
    }
    try {
      const speed = inputNumberElement($('tLiveSpeed'), 60, 600, 'Ground speed');
      Tactical.setSpeed(state.exercise, aircraft.id, speed);
      clearTimeout(state.speedChangeTimer);
      state.pendingSpeedChange = { id: aircraft.id, speed };
      state.speedChangeTimer = setTimeout(commitLiveSpeedChange, 450);
      renderRail();
    } catch (error) {
      if (showError) {
        $('tLiveSpeed').value = String(aircraft.cfg.speed);
        showToast(error.message);
      }
    }
  }

  function buildRailItem(id) {
    const item = document.createElement('article');
    item.className = 'tactical-rail-item';
    item.dataset.aircraftId = id;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tactical-rail-select';
    select.addEventListener('click', () => selectAircraft(id));
    const name = document.createElement('strong');
    const level = document.createElement('small');
    const status = document.createElement('small');
    select.append(name, level, status);

    const transmit = document.createElement('button');
    transmit.type = 'button';
    transmit.className = 'tactical-rail-tx';
    transmit.textContent = 'TX';
    transmit.addEventListener('click', () => transmitForDF(id));

    item.append(select, transmit);
    return { item, select, transmit, name, level, status };
  }

  function renderRail() {
    const rail = $('tAircraftRail');
    if (!state.exercise) {
      rail.replaceChildren();
      state.railItems.clear();
      return;
    }

    const aircraftIds = state.exercise.aircraft.map(aircraft => aircraft.id);
    const needsBuild = state.railItems.size !== aircraftIds.length || aircraftIds.some(id => {
      const record = state.railItems.get(id);
      return !record || record.item.parentElement !== rail;
    });

    if (needsBuild) {
      state.railItems.clear();
      const fragment = document.createDocumentFragment();
      aircraftIds.forEach(id => {
        const record = buildRailItem(id);
        state.railItems.set(id, record);
        fragment.appendChild(record.item);
      });
      rail.replaceChildren(fragment);
    }

    state.exercise.aircraft.forEach(aircraft => {
      const record = state.railItems.get(aircraft.id);
      if (!record) return;
      const active = aircraft.id === state.activeAircraftId;
      record.item.classList.toggle('active', active);
      setAircraftColour(record.item, aircraft.color);
      setAircraftColour(record.transmit, aircraft.color);
      record.select.setAttribute('aria-pressed', String(active));
      record.select.setAttribute('aria-label', 'Select ' + aircraft.callsign);
      record.transmit.setAttribute('aria-label', 'Transmit ' + aircraft.callsign + ' for D/F');
      record.name.textContent = aircraft.callsign;
      record.level.textContent = levelLabel(aircraft);
      record.status.textContent = formationStatus(aircraft) + ' · ' + phaseLabel(aircraft) + ' · ' + Tactical.rangeFor(aircraft).toFixed(1) + ' NM';
    });
  }

  function updateUsTurnControls() {
    const aircraft = currentAircraft();
    const turning = Boolean(aircraft && (aircraft.manualTurnSide || aircraft.initialTurnSide));
    $('tUsLeft').disabled = turning;
    $('tUsRight').disabled = turning;
    $('tUsStop').disabled = !turning;
  }

  function updateNormalContinueControl() {
    const aircraft = currentAircraft();
    const control = $('tContinueHeading');
    control.disabled = state.procedure !== 'normal' || !aircraft?.forcedTurnSide;
    control.dataset.turnSide = aircraft?.forcedTurnSide || '';
  }

  function renderSelectedAircraft() {
    const aircraft = currentAircraft();
    if (!aircraft) return;
    $('tControlCallsign').textContent = aircraft.callsign;
    const following = formationRole(aircraft) === 'FORMATION';
    const leader = formationLeader();
    $('tFormationStatus').textContent = levelLabel(aircraft) + ' · ' + formationStatus(aircraft);
    $('tLiveSpeed').value = String(Math.round(following && leader ? leader.cfg.speed : aircraft.cfg.speed));
    $('tLiveSpeed').disabled = following;
    $('tLiveSpeed').title = following ? 'Ground speed follows the formation leader.' : '';
    $('tStopFollowing').hidden = !following;
    $('tStopFollowing').disabled = !following;
    $('tHeadingReply').textContent = 'HEADING —';
    $('tDistanceReply').textContent = 'RANGE —';
    updateUsTurnControls();
    updateNormalContinueControl();
    renderDF();
  }

  function selectAircraft(id) {
    if (!aircraftById(id)) return;
    commitLiveSpeedChange();
    state.activeAircraftId = id;
    renderRail();
    renderSelectedAircraft();
  }

  function transmitForDF(id) {
    const aircraft = aircraftById(id);
    if (!aircraft) return;
    selectAircraft(id);
    state.dfLive = true;
    state.dfAircraftId = id;
    const bearing = Tactical.bearingFor(aircraft);
    const detail = bearing.overhead
      ? 'Overhead / no-bearing indication.'
      : 'QDM ' + padHeading(bearing.qdm) + '°M · QTE ' + padHeading(bearing.qte) + '°T · ' + bearing.range.toFixed(1) + ' NM.';
    logCommand(id, 'TRANSMIT FOR D/F', detail);
    renderDF();
    clearTimeout(state.dfExpiry);
    state.dfExpiry = setTimeout(clearDF, DF_WINDOW_MS);
    showToast(aircraft.callsign + ' D/F TRANSMISSION RECEIVED');
  }

  function stopFollowingLeader() {
    if (!state.exercise || !currentAircraft()) return;
    try {
      const result = Tactical.stopFollowingLeader(state.exercise, state.activeAircraftId);
      if (!result) {
        showToast('SELECT A FORMATION WINGMAN');
        return;
      }
      logEvents(result.events);
      state.lastLoggedSpeedById[result.aircraft.id] = result.speed;
      renderRail();
      renderSelectedAircraft();
      showToast(result.aircraft.callsign + ' NOW INDEPENDENT');
    } catch (error) {
      showToast(error.message || 'Formation break unavailable.');
    }
  }

  function chooseProcedure(procedure) {
    state.procedure = procedure;
    setPressed($('tProcedureNormal'), procedure === 'normal');
    setPressed($('tProcedureUs'), procedure === 'us');
  }

  function chooseBearingMode(mode) {
    state.bearingMode = mode;
    setPressed($('tQdm'), mode === 'qdm');
    setPressed($('tQte'), mode === 'qte');
    renderDF();
  }

  function setConsoleProcedure() {
    const usCompass = state.procedure === 'us';
    $('tConsoleTitle').textContent = usCompass ? 'U/S Compass console' : 'Normal QGH console';
    $('tConsoleBadge').textContent = usCompass ? 'U/S COMPASS' : 'NORMAL QGH';
    $('tConsoleBadge').classList.toggle('us', usCompass);
    $('tNormalControls').hidden = usCompass;
    $('tUsControls').hidden = !usCompass;
    $('tRequestHeading').hidden = usCompass;
    $('tInfoRow').classList.toggle('single', usCompass);
    updateNormalContinueControl();
  }

  function showScreen(id) {
    ['tSetup', 'tConsole', 'tAnalysis'].forEach(screen => {
      $(screen).classList.toggle('active', screen === id);
    });
    const focusTarget = id === 'tConsole' ? $('tConsoleTitle') : (id === 'tAnalysis' ? $('tAnalysisTitle') : $('tSetup'));
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll: true });
  }

  function syncDraftsFromRows() {
    document.querySelectorAll('.tactical-aircraft-row').forEach(row => {
      const id = row.dataset.aircraftId;
      const draft = state.fleetDrafts.find(item => item.id === id);
      if (!draft) return;
      const callsign = row.querySelector('[data-tactical-field="callsign"]');
      const profile = row.querySelector('[data-tactical-field="profile"]');
      const speed = row.querySelector('[data-tactical-field="speed"]');
      const rate = row.querySelector('[data-tactical-field="rate"]');
      const distance = row.querySelector('[data-tactical-field="distance"]');
      const level = row.querySelector('[data-tactical-field="level"]');
      draft.callsign = callsign.value;
      draft.profile = profile.value;
      draft.speed = speed.value;
      draft.rate = rate.value;
      draft.distance = distance.value;
      draft.level = level.value;
    });
  }

  function addFleetField(row, field, label) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tactical-field';
    wrapper.dataset.label = label;
    wrapper.appendChild(field);
    row.appendChild(wrapper);
  }

  function makeFleetInput(type, value, fieldName, label, minimum, maximum, step) {
    const input = document.createElement('input');
    input.type = type;
    if (type === 'number') input.inputMode = step && Number(step) % 1 ? 'decimal' : 'numeric';
    input.value = value;
    input.dataset.tacticalField = fieldName;
    input.setAttribute('aria-label', label);
    if (minimum !== undefined) input.min = String(minimum);
    if (maximum !== undefined) input.max = String(maximum);
    if (step !== undefined) input.step = String(step);
    return input;
  }

  function activeDrafts() {
    return state.fleetDrafts.slice(0, state.fleetCount);
  }

  function ensureFormationSelection() {
    const ids = activeDrafts().map(draft => draft.id);
    if (!ids.includes(state.formationLeaderId)) state.formationLeaderId = ids[0];
    state.formationMemberIds = state.formationMemberIds.filter(id => ids.includes(id));
    if (!state.formationMemberIds.includes(state.formationLeaderId)) {
      state.formationMemberIds.unshift(state.formationLeaderId);
    }
    if (state.formationEnabled && state.formationMemberIds.length < 2) {
      state.formationMemberIds = [...ids];
    }
  }

  function renderFormationOptions() {
    ensureFormationSelection();
    setPressed($('tFormationOff'), !state.formationEnabled);
    setPressed($('tFormationOn'), state.formationEnabled);
    $('tFormationOptions').hidden = !state.formationEnabled;

    const leader = $('tFormationLeader');
    leader.replaceChildren();
    activeDrafts().forEach(draft => {
      const option = document.createElement('option');
      option.value = draft.id;
      option.textContent = draft.callsign || draft.id;
      leader.appendChild(option);
    });
    leader.value = state.formationLeaderId;

    const members = $('tFormationMembers');
    members.replaceChildren();
    activeDrafts().forEach(draft => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tactical-member-chip';
      button.textContent = draft.callsign || draft.id;
      button.setAttribute('aria-pressed', String(state.formationMemberIds.includes(draft.id)));
      button.setAttribute('aria-label', 'Include ' + (draft.callsign || draft.id) + ' in formation');
      setAircraftColour(button, draft.color);
      if (draft.id === state.formationLeaderId) {
        button.disabled = true;
        button.title = 'The selected formation leader remains in formation.';
      } else {
        button.addEventListener('click', () => {
          if (state.formationMemberIds.includes(draft.id)) {
            state.formationMemberIds = state.formationMemberIds.filter(id => id !== draft.id);
          } else {
            state.formationMemberIds.push(draft.id);
          }
          renderFormationOptions();
        });
      }
      members.appendChild(button);
    });
  }

  function chooseFormation(enabled) {
    syncDraftsFromRows();
    state.formationEnabled = enabled;
    if (enabled) {
      state.formationMemberIds = activeDrafts().map(draft => draft.id);
      if (!activeDrafts().some(draft => draft.id === state.formationLeaderId)) {
        state.formationLeaderId = activeDrafts()[0].id;
      }
    }
    renderFormationOptions();
  }

  function formationConfiguration() {
    ensureFormationSelection();
    if (!state.formationEnabled) return { enabled: false };
    return {
      enabled: true,
      leaderId: state.formationLeaderId,
      memberIds: [...state.formationMemberIds]
    };
  }

  function buildFleetRows() {
    syncDraftsFromRows();
    const rows = $('tAircraftRows');
    rows.replaceChildren();
    state.fleetDrafts.slice(0, state.fleetCount).forEach(draft => {
      const row = document.createElement('article');
      row.className = 'tactical-aircraft-row';
      row.dataset.aircraftId = draft.id;
      setAircraftColour(row, draft.color);

      const callsign = makeFleetInput('text', draft.callsign, 'callsign', draft.id + ' callsign');
      callsign.maxLength = 20;
      const profile = document.createElement('select');
      profile.dataset.tacticalField = 'profile';
      profile.setAttribute('aria-label', draft.id + ' aircraft profile');
      Object.keys(profiles).forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = profiles[key].label;
        profile.appendChild(option);
      });
      profile.value = profiles[draft.profile] ? draft.profile : 'fighter';

      const level = makeFleetInput('number', draft.level, 'level', draft.id + ' level', 1000, 45000, 1000);
      const speed = makeFleetInput('number', draft.speed, 'speed', draft.id + ' ground speed', 60, 600, 5);
      const rate = makeFleetInput('number', draft.rate, 'rate', draft.id + ' rate of turn', .5, 8, .1);
      const distance = makeFleetInput('number', draft.distance, 'distance', draft.id + ' initial distance', 5, 50, .5);
      profile.addEventListener('change', () => {
        const selected = profiles[profile.value];
        speed.value = String(selected.speed);
        rate.value = String(selected.rate);
      });

      addFleetField(row, callsign, 'CALLSIGN');
      addFleetField(row, profile, 'PROFILE');
      addFleetField(row, level, 'LEVEL · FT');
      addFleetField(row, speed, 'SPEED · KT');
      addFleetField(row, rate, 'TURN RATE · °/SEC');
      addFleetField(row, distance, 'RANGE · NM');
      rows.appendChild(row);
    });
    renderFormationOptions();
  }

  function chooseFleetCount(count) {
    state.fleetCount = count;
    setPressed($('tFleet2'), count === 2);
    setPressed($('tFleet3'), count === 3);
    setPressed($('tFleet4'), count === 4);
    buildFleetRows();
  }

  function readFleetConfiguration() {
    syncDraftsFromRows();
    return state.fleetDrafts.slice(0, state.fleetCount).map(draft => ({
      id: draft.id,
      callsign: draft.callsign,
      color: draft.color,
      lineStyle: draft.lineStyle,
      type: draft.profile,
      level: String(draft.level || '').trim() ? Number(draft.level) : undefined,
      speed: Number(draft.speed),
      rate: Number(draft.rate),
      distance: Number(draft.distance)
    }));
  }

  function resetConsole() {
    clearDF();
    $('tHeadingReply').textContent = 'HEADING —';
    $('tDistanceReply').textContent = 'RANGE —';
    $('tHeadingInput').value = String(inputDegrees('tInbound', 'Inbound / final track'));
    setConsoleProcedure();
    renderRail();
    renderSelectedAircraft();
  }

  function startExercise() {
    try {
      clearReplay();
      clearSpeedChange();
      stopFlightLoop();
      clearDF();
      stopClock();
      const cfg = {
        procedure: state.procedure,
        runway: inputDegrees('tRunway', 'Runway orientation'),
        inbound: inputDegrees('tInbound', 'Inbound / final track'),
        outbound: inputDegrees('tOutbound', 'Outbound track'),
        aircraft: readFleetConfiguration(),
        formation: formationConfiguration(),
        random: exerciseRandom,
        initialSignatures: state.initialSignatures
      };
      state.exercise = Tactical.createExercise(cfg);
      state.activeAircraftId = state.exercise.formation && state.exercise.formation.enabled
        ? state.exercise.formation.leaderId
        : state.exercise.aircraft[0].id;
      state.commands = [];
      state.reviewMaxRange = null;
      state.focusedReviewId = null;
      state.lastLoggedSpeedById = {};
      resetClock();
      state.exercise.aircraft.forEach(aircraft => {
        const draft = state.fleetDrafts.find(item => item.id === aircraft.id);
        if (draft) draft.level = String(aircraft.level);
        state.lastLoggedSpeedById[aircraft.id] = aircraft.cfg.speed;
        const bearing = Tactical.bearingFor(aircraft);
        const turn = aircraft.initialTurnSide ? 'initial ' + aircraft.initialTurnSide.toUpperCase() + ' turn' : 'initial level flight';
        logCommand(aircraft.id, 'SETUP', aircraft.cfg.type.toUpperCase() + ' · ' + levelLabel(aircraft) + ' · QTE ' + padHeading(bearing.qte) + '°T · ' + bearing.range.toFixed(1) + ' NM · ' + aircraft.cfg.speed + ' KT · ' + formationStatus(aircraft) + ' · ' + turn + '.');
      });
      resetConsole();
      $('tTrackMeta').textContent = 'RUNWAY ' + padHeading(state.exercise.cfg.runway) + ' · OUTBOUND ' + padHeading(state.exercise.cfg.outbound) + ' · INBOUND ' + padHeading(state.exercise.cfg.inbound);
      showScreen('tConsole');
      scrollToScreenTop();
      startFlightLoop();
      showToast('TACTICAL EXERCISE STARTED');
    } catch (error) {
      showToast(error.message || 'Check the exercise inputs.');
    }
  }

  function physicsStep(duration) {
    if (!state.exercise) return;
    const events = Tactical.step(state.exercise, duration);
    if (events.length) logEvents(events);
    if (state.dfLive) renderDF();
    renderRail();
    updateUsTurnControls();
    updateNormalContinueControl();
  }

  function issueHeading(side) {
    if (!state.exercise || !currentAircraft()) return;
    try {
      const heading = inputDegrees('tHeadingInput', 'Assigned heading');
      const result = Tactical.issueHeading(state.exercise, state.activeAircraftId, side, heading);
      const turn = result.turn;
      if (result.events && result.events.length) logEvents(result.events);
      logCommand(result.aircraft.id, 'TURN ' + side.toUpperCase(), 'Heading ' + padHeading(heading) + '°M · ' + Math.round(turn.degrees) + '° turn · ' + turn.way + ' · nominal radius ' + result.radius.toFixed(2) + ' NM.');
      startFlightLoop();
      renderRail();
      renderSelectedAircraft();
      showToast(result.aircraft.callsign + ' TURN ' + side.toUpperCase() + ' ACCEPTED');
    } catch (error) {
      showToast(error.message || 'Heading command unavailable.');
    }
  }

  function continueHeading() {
    if (!state.exercise || !currentAircraft()) return;
    try {
      const heading = inputDegrees('tHeadingInput', 'Assigned heading');
      const result = Tactical.continueHeading(state.exercise, state.activeAircraftId, heading);
      if (!result) {
        showToast('NO HEADING TURN TO CONTINUE');
        return;
      }
      const turn = result.turn;
      if (result.events && result.events.length) logEvents(result.events);
      logCommand(result.aircraft.id, 'CONTINUE ' + turn.side.toUpperCase(), 'Heading ' + padHeading(heading) + '°M · ' + Math.round(turn.degrees) + '° turn · ' + turn.way + ' · nominal radius ' + result.radius.toFixed(2) + ' NM.');
      startFlightLoop();
      renderRail();
      renderSelectedAircraft();
      showToast(result.aircraft.callsign + ' CONTINUE ' + turn.side.toUpperCase() + ' ACCEPTED');
    } catch (error) {
      showToast(error.message || 'Continue heading unavailable.');
    }
  }

  function startTurn(side) {
    if (!state.exercise || !currentAircraft()) return;
    try {
      const result = Tactical.startTurn(state.exercise, state.activeAircraftId, side);
      if (!result) {
        showToast('STOP THE CURRENT TURN BEFORE GIVING A NEW TURN');
        return;
      }
      if (result.events && result.events.length) logEvents(result.events);
      logCommand(result.aircraft.id, 'TURN ' + side.toUpperCase() + ' NOW', 'Timed turn at ' + result.aircraft.cfg.rate.toFixed(1) + '°/sec · nominal radius ' + result.radius.toFixed(2) + ' NM.');
      startFlightLoop();
      renderRail();
      renderSelectedAircraft();
      updateUsTurnControls();
      showToast(result.aircraft.callsign + ' TURN ' + side.toUpperCase() + ' NOW');
    } catch (error) {
      showToast(error.message || 'Timed turn unavailable.');
    }
  }

  function stopTurn() {
    if (!state.exercise || !currentAircraft()) return;
    try {
      const result = Tactical.stopTurn(state.exercise, state.activeAircraftId);
      if (!result) {
        showToast('NO TURN IS IN PROGRESS');
        return;
      }
      const detail = result.turn
        ? 'Aircraft levels on ' + padHeading(result.aircraft.plane.heading) + '°M · ' + Tactical.formatTurn(result.turn) + '.'
        : 'Aircraft levels on ' + padHeading(result.aircraft.plane.heading) + '°M.';
      logCommand(result.aircraft.id, 'STOP TURN NOW', detail);
      startFlightLoop();
      renderRail();
      updateUsTurnControls();
      showToast(result.aircraft.callsign + ' TURN STOPPED');
    } catch (error) {
      showToast(error.message || 'Stop turn unavailable.');
    }
  }

  function requestHeading() {
    const aircraft = currentAircraft();
    if (!aircraft) return;
    $('tHeadingReply').textContent = 'HEADING ' + padHeading(aircraft.plane.heading) + '°M';
    logCommand(aircraft.id, 'REPORT HEADING', 'Aircraft reports ' + padHeading(aircraft.plane.heading) + '°M.');
    showToast(aircraft.callsign + ' HEADING RECEIVED');
  }

  function requestDistance() {
    const aircraft = currentAircraft();
    if (!aircraft) return;
    const range = Tactical.rangeFor(aircraft);
    $('tDistanceReply').textContent = 'RANGE ' + range.toFixed(1) + ' NM';
    logCommand(aircraft.id, 'REQUEST DISTANCE', 'Aircraft reports ' + range.toFixed(1) + ' NM from overhead.');
    showToast(aircraft.callsign + ' RANGE RECEIVED');
  }

  function advanceFlight() {
    if (!state.exercise) return;
    const before = state.exercise.aircraft.map(aircraft => ({
      id: aircraft.id,
      heading: aircraft.plane.heading,
      range: Tactical.rangeFor(aircraft)
    }));
    const events = Tactical.advance(state.exercise, ADVANCE_FLIGHT_SECONDS);
    logEvents(events);
    const detail = state.exercise.aircraft.map(aircraft => {
      const start = before.find(item => item.id === aircraft.id);
      return aircraft.callsign + ' ' + padHeading(start.heading) + '°/' + start.range.toFixed(1) + ' NM → ' + padHeading(aircraft.plane.heading) + '°/' + Tactical.rangeFor(aircraft).toFixed(1) + ' NM';
    }).join(' · ');
    logCommand(null, 'ADVANCE FLIGHT · 1 MIN', '60 seconds simulated for all aircraft. ' + detail + '.');
    if (state.dfLive) renderDF();
    renderRail();
    updateUsTurnControls();
    showToast('FLIGHT ADVANCED 1 MINUTE');
  }

  function updateReplayButton() {
    const button = $('tReplay');
    if (!button) return;
    const replaying = Boolean(state.replayTimer);
    button.textContent = replaying ? 'PAUSE REPLAY' : (state.replayPaused ? 'RESUME REPLAY' : 'REPLAY TRACK');
    setPressed(button, replaying);
  }

  function setReviewZoom(enabled) {
    state.reviewZoomEnabled = Boolean(enabled);
    const button = $('tZoomToggle');
    if (button) {
      button.textContent = state.reviewZoomEnabled ? 'ZOOM ON' : 'ZOOM OFF';
      setPressed(button, state.reviewZoomEnabled);
    }
    if (window.QGHTacticalReview && typeof window.QGHTacticalReview.setZoomEnabled === 'function') {
      window.QGHTacticalReview.setZoomEnabled(state.reviewZoomEnabled);
    }
  }

  function fitReview() {
    if (window.QGHTacticalReview && typeof window.QGHTacticalReview.fit === 'function') {
      window.QGHTacticalReview.fit();
    }
    showToast('TRACK VIEW FIT');
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

  function maxPathLength() {
    if (!state.exercise) return 0;
    return state.exercise.aircraft.reduce((maximum, aircraft) => Math.max(maximum, aircraft.path.length), 0);
  }

  function drawReview(count, replaying) {
    if (!state.exercise) return;
    const fullLength = maxPathLength();
    const visibleCount = count === undefined ? fullLength : Math.max(1, Math.min(fullLength, count));
    const elapsed = Math.max(0, (visibleCount - 1) * Tactical.STEP_SECONDS);
    $('tReplayElapsed').textContent = (replaying ? 'REPLAY ' : 'TRACK ') + formatTime(elapsed);
    window.QGHTacticalReview.draw({
      canvas: $('tTacticalPlot'),
      cfg: state.exercise.cfg,
      aircraft: state.exercise.aircraft.map(aircraft => ({ ...aircraft, formationRole: formationRole(aircraft) })),
      maxRange: state.reviewMaxRange,
      count: visibleCount,
      focusedId: state.focusedReviewId,
      activeId: null
    });
  }

  function scheduleReplay() {
    const fullLength = maxPathLength();
    if (!fullLength || state.replayIndex >= fullLength) {
      state.replayTimer = null;
      state.replayPaused = false;
      updateReplayButton();
      return;
    }
    state.replayTimer = setTimeout(() => {
      state.replayIndex = Math.min(fullLength, state.replayIndex + state.replaySpeed);
      drawReview(state.replayIndex, true);
      scheduleReplay();
    }, REPLAY_FRAME_MS);
  }

  function replay() {
    if (!state.exercise || !maxPathLength()) return;
    if (state.replayTimer) {
      clearReplay(false);
      state.replayPaused = true;
      updateReplayButton();
      showToast('REPLAY PAUSED');
      return;
    }
    if (state.replayPaused && state.replayIndex < maxPathLength()) {
      state.replayPaused = false;
      scheduleReplay();
      updateReplayButton();
      showToast('REPLAY ' + state.replaySpeed + '×');
      return;
    }
    clearReplay(false);
    state.replayIndex = 1;
    state.replayPaused = false;
    drawReview(state.replayIndex, true);
    scheduleReplay();
    updateReplayButton();
    showToast('REPLAY ' + state.replaySpeed + '×');
  }

  function chooseReplaySpeed(speed) {
    state.replaySpeed = speed;
    document.querySelectorAll('[data-tactical-replay-speed]').forEach(button => {
      setPressed(button, Number(button.dataset.tacticalReplaySpeed) === speed);
    });
    if (state.replayTimer) {
      clearReplay(false);
      scheduleReplay();
      updateReplayButton();
    }
  }

  function renderReviewLegend() {
    const legend = $('tReviewLegend');
    legend.replaceChildren();
    if (!state.exercise) return;
    state.exercise.aircraft.forEach(aircraft => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tactical-legend-item';
      setAircraftColour(button, aircraft.color);
      setPressed(button, state.focusedReviewId === aircraft.id);
      const name = document.createElement('strong');
      name.textContent = aircraft.callsign;
      const status = document.createElement('small');
      status.textContent = levelLabel(aircraft) + ' · ' + formationStatus(aircraft);
      button.append(name, status);
      button.addEventListener('click', () => {
        state.focusedReviewId = aircraft.id;
        renderReviewLegend();
        drawReview();
      });
      legend.appendChild(button);
    });
  }

  function renderReviewRows() {
    const rows = $('tReviewRows');
    rows.replaceChildren();
    if (!state.exercise) return;
    state.exercise.aircraft.forEach(aircraft => {
      const row = document.createElement('article');
      row.className = 'tactical-review-row';
      const header = document.createElement('header');
      const chip = document.createElement('span');
      chip.className = 'tactical-summary-chip';
      setAircraftColour(chip, aircraft.color);
      chip.textContent = aircraft.callsign;
      const phase = document.createElement('small');
      phase.textContent = levelLabel(aircraft) + ' · ' + formationStatus(aircraft);
      header.append(chip, phase);
      const pathStart = aircraft.path[0];
      const startRange = Math.hypot(pathStart.x, pathStart.y);
      const tx = state.commands.filter(item => item.aircraftId === aircraft.id && item.type === 'TRANSMIT FOR D/F').length;
      const details = document.createElement('p');
      details.textContent = phaseLabel(aircraft) + ' · Start ' + startRange.toFixed(1) + ' NM · Final ' + Tactical.rangeFor(aircraft).toFixed(1) + ' NM · ' + Math.round(aircraft.cfg.speed) + ' KT · D/F ' + tx + ' · OH ' + Tactical.formatTurn(aircraft.procedureTurns.overhead) + ' · Base ' + Tactical.formatTurn(aircraft.procedureTurns.base) + '.';
      row.append(header, details);
      rows.appendChild(row);
    });
  }

  function renderCommands() {
    const logs = $('tLogs');
    logs.replaceChildren();
    state.commands.forEach(command => {
      const item = document.createElement('article');
      item.className = 'tactical-log';
      setAircraftColour(item, command.color);
      const title = document.createElement('span');
      title.textContent = command.time + ' · ' + command.callsign + ' · ' + command.type;
      const detail = document.createElement('small');
      detail.textContent = command.detail;
      item.append(title, detail);
      logs.appendChild(item);
    });
  }

  function prepareReview() {
    if (!state.exercise) return;
    let maximum = 35;
    state.exercise.aircraft.forEach(aircraft => {
      aircraft.path.forEach(point => {
        maximum = Math.max(maximum, Math.hypot(point.x, point.y));
      });
    });
    state.reviewMaxRange = maximum;
    $('tSumRunway').textContent = padHeading(state.exercise.cfg.runway) + '°M';
    $('tSumOutbound').textContent = padHeading(state.exercise.cfg.outbound) + '°M';
    $('tSumInbound').textContent = padHeading(state.exercise.cfg.inbound) + '°M';
    $('tSumProcedure').textContent = state.procedure === 'us' ? 'U/S COMPASS' : 'NORMAL QGH';
    $('tSumFleet').textContent = String(state.exercise.aircraft.length).padStart(2, '0') + ' AIRCRAFT';
    const formation = state.exercise.formation;
    if (formation && formation.enabled) {
      const leader = aircraftById(formation.leaderId);
      const wingmen = formation.memberIds.filter(id => id !== formation.leaderId && !formation.detachedIds.includes(id)).length;
      const breakaways = formation.detachedIds.length;
      $('tSumFormation').textContent = leader ? leader.callsign + ' LEAD' : 'FORMATION';
      $('tReviewFormation').textContent = 'VERTICAL SEPARATION · 1,000 FT · ' + (leader ? leader.callsign : 'FORMATION') + ' LEAD · ' + wingmen + ' ' + (wingmen === 1 ? 'WINGMAN' : 'WINGMEN') + (breakaways ? ' · ' + breakaways + ' BREAKAWAY' : '');
    } else {
      $('tSumFormation').textContent = 'INDEPENDENT';
      $('tReviewFormation').textContent = 'VERTICAL SEPARATION · 1,000 FT · INDEPENDENT FLIGHT';
    }
    $('tReviewBadge').textContent = state.procedure === 'us' ? 'U/S COMPASS' : 'NORMAL QGH';
    $('tReviewBadge').classList.toggle('us', state.procedure === 'us');
    renderReviewLegend();
    renderReviewRows();
    renderCommands();
    drawReview();
    setReviewZoom(false);
  }

  function terminate() {
    if (!state.exercise) return;
    state.terminationPending = null;
    commitLiveSpeedChange();
    stopFlightLoop();
    clearDF();
    stopClock();
    clearReplay();
    logCommand(null, 'TERMINATED', 'Tactical exercise terminated by controller.');
    prepareReview();
    showScreen('tAnalysis');
    scrollToScreenTop();
    showToast('FLIGHT PATH REVIEW READY');
  }

  function requestTermination() {
    if (!state.exercise) return;
    const dialog = $('tTerminateDialog');
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
    const dialog = $('tTerminateDialog');
    if (dialog && typeof dialog.close === 'function' && dialog.open) dialog.close();
    const pending = state.terminationPending;
    state.terminationPending = null;
    if (!resumeExercise || !pending || !state.exercise) return;
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

  function restartExercise() {
    startExercise();
  }

  function returnToConsole() {
    if (!state.exercise) return;
    clearReplay();
    showScreen('tConsole');
    scrollToScreenTop();
    startFlightLoop();
  }

  function newExercise() {
    clearReplay();
    stopFlightLoop();
    clearDF();
    showScreen('tSetup');
    scrollToScreenTop();
  }

  function bindEvents() {
    $('tProcedureNormal').addEventListener('click', () => chooseProcedure('normal'));
    $('tProcedureUs').addEventListener('click', () => chooseProcedure('us'));
    $('tFleet2').addEventListener('click', () => chooseFleetCount(2));
    $('tFleet3').addEventListener('click', () => chooseFleetCount(3));
    $('tFleet4').addEventListener('click', () => chooseFleetCount(4));
    $('tFormationOff').addEventListener('click', () => chooseFormation(false));
    $('tFormationOn').addEventListener('click', () => chooseFormation(true));
    $('tFormationLeader').addEventListener('change', event => {
      state.formationLeaderId = event.target.value;
      ensureFormationSelection();
      renderFormationOptions();
    });
    $('tQdm').addEventListener('click', () => chooseBearingMode('qdm'));
    $('tQte').addEventListener('click', () => chooseBearingMode('qte'));
    $('tStart').addEventListener('click', startExercise);
    $('tTransmit').addEventListener('click', () => transmitForDF(state.activeAircraftId));
    $('tStopFollowing').addEventListener('click', stopFollowingLeader);
    $('tRequestHeading').addEventListener('click', requestHeading);
    $('tRequestDistance').addEventListener('click', requestDistance);
    $('tTurnLeft').addEventListener('click', () => issueHeading('left'));
    $('tTurnRight').addEventListener('click', () => issueHeading('right'));
    $('tContinueHeading').addEventListener('click', continueHeading);
    $('tUsLeft').addEventListener('click', () => startTurn('left'));
    $('tUsRight').addEventListener('click', () => startTurn('right'));
    $('tUsStop').addEventListener('click', stopTurn);
    $('tLiveSpeed').addEventListener('input', () => updateLiveSpeed(false));
    $('tLiveSpeed').addEventListener('change', () => {
      updateLiveSpeed(true);
      commitLiveSpeedChange();
    });
    $('tClockStart').addEventListener('click', startClock);
    $('tClockStop').addEventListener('click', stopClock);
    $('tClockReset').addEventListener('click', resetClock);
    $('tAdvance').addEventListener('click', advanceFlight);
    $('tRestart').addEventListener('click', restartExercise);
    $('tTerminate').addEventListener('click', requestTermination);
    $('tReturnConsole').addEventListener('click', returnToConsole);
    $('tReplay').addEventListener('click', replay);
    $('tNewExercise').addEventListener('click', newExercise);
    const confirmTerminate = $('tConfirmTerminate');
    const cancelTerminate = $('tCancelTerminate');
    if (confirmTerminate) confirmTerminate.addEventListener('click', confirmTermination);
    if (cancelTerminate) cancelTerminate.addEventListener('click', closeTerminationDialog);
    const terminateDialog = $('tTerminateDialog');
    if (terminateDialog) terminateDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeTerminationDialog();
    });
    const zoomToggle = $('tZoomToggle');
    const fitReviewButton = $('tFitReview');
    if (zoomToggle) zoomToggle.addEventListener('click', () => setReviewZoom(!state.reviewZoomEnabled));
    if (fitReviewButton) fitReviewButton.addEventListener('click', fitReview);
    $('tFocusAll').addEventListener('click', () => {
      state.focusedReviewId = null;
      renderReviewLegend();
      drawReview();
    });
    document.querySelectorAll('[data-tactical-replay-speed]').forEach(button => {
      button.addEventListener('click', () => chooseReplaySpeed(Number(button.dataset.tacticalReplaySpeed)));
    });
  }

  bindEvents();
  chooseProcedure('normal');
  chooseFleetCount(3);
  chooseBearingMode('qdm');
  setReviewZoom(false);
  updateReplayButton();
  updateClock();
})();
