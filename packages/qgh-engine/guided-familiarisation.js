(function initializeQghGuidedFamiliarisation(root) {
  'use strict';

  const documentRef = root.document;
  if (!documentRef) return;
  const STORAGE_KEY = 'qgh-guided-familiarisation-v1';
  const PENDING_KEY = 'qgh-guided-familiarisation-pending';
  const $ = selector => documentRef.querySelector(selector);

  function readStore(key) {
    try { return root.localStorage?.getItem(key) || ''; } catch { return ''; }
  }

  function writeStore(key, value) {
    try { root.localStorage?.setItem(key, value); } catch { /* Private browsing still supports the optional tour. */ }
  }

  function removeStore(key) {
    try { root.localStorage?.removeItem(key); } catch { /* Nothing to remove. */ }
  }

  function pageKind() {
    const workspaceKind = root.QGHVoiceWorkspace?.pageKind?.();
    if (workspaceKind) return workspaceKind;
    if ($('#tSetup')) return 'tactical';
    if ($('#setup')) return 'single';
    return 'entry';
  }

  function markSeen() { writeStore(STORAGE_KEY, 'seen'); }

  function removeOverlay() {
    documentRef.querySelectorAll('.qgh-guide-overlay').forEach(node => node.remove());
    documentRef.querySelectorAll('.qgh-guide-target').forEach(node => node.classList.remove('qgh-guide-target'));
  }

  function removeOverlayCard() {
    documentRef.querySelectorAll('.qgh-guide-overlay').forEach(node => node.remove());
  }

  function makeButton(label, className, action) {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = `qgh-guide-button ${className || ''}`.trim();
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  function createOverlay(title, kicker, content, actions, progress) {
    removeOverlayCard();
    const overlay = documentRef.createElement('section');
    overlay.className = 'qgh-guide-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const card = documentRef.createElement('div');
    card.className = 'qgh-guide-card';
    const head = documentRef.createElement('header');
    head.className = 'qgh-guide-head';
    const label = documentRef.createElement('span');
    label.textContent = kicker;
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.className = 'qgh-guide-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close guided familiarisation');
    close.addEventListener('click', () => { markSeen(); removeOverlay(); });
    head.append(label, close);
    const body = documentRef.createElement('div');
    body.className = 'qgh-guide-body';
    const heading = documentRef.createElement('h2');
    heading.textContent = title;
    body.append(heading);
    if (content) body.append(content);
    const foot = documentRef.createElement('footer');
    foot.className = 'qgh-guide-foot';
    const dots = documentRef.createElement('span');
    dots.className = 'qgh-guide-progress';
    if (progress) {
      for (let index = 0; index < progress.total; index += 1) {
        const dot = documentRef.createElement('i');
        dot.dataset.active = String(index === progress.index);
        dots.append(dot);
      }
    }
    const actionRow = documentRef.createElement('div');
    actionRow.className = 'qgh-guide-actions';
    actions.forEach(action => actionRow.append(action));
    foot.append(dots, actionRow);
    card.append(head, body, foot);
    overlay.append(card);
    documentRef.body.append(overlay);
    const focusTarget = actions.find(button => button.classList.contains('qgh-guide-button--primary')) || close;
    root.setTimeout(() => focusTarget.focus(), 0);
    return overlay;
  }

  function addExamples(parent, examples) {
    if (!examples?.length) return;
    const block = documentRef.createElement('div');
    block.className = 'qgh-guide-examples';
    examples.forEach(example => {
      const code = documentRef.createElement('code');
      code.textContent = `“${example}”`;
      block.append(code);
    });
    parent.append(block);
  }

  function addCallPattern(parent, label, detail) {
    if (!label || !detail) return;
    const pattern = documentRef.createElement('div');
    pattern.className = 'qgh-guide-call-pattern';
    const heading = documentRef.createElement('span');
    heading.textContent = label;
    const copy = documentRef.createElement('strong');
    copy.textContent = detail;
    pattern.append(heading, copy);
    parent.append(pattern);
  }

  function entryWelcome() {
    const content = documentRef.createElement('div');
    const copy = documentRef.createElement('p');
    copy.textContent = 'New to the simulator? Take a short, optional guided familiarisation of live controller calls. It teaches the exercise controls without changing flight behaviour.';
    content.append(copy);
    addCallPattern(content, 'THE TOUR FOCUSES ON', 'LIVE D/F · TURN CALLS · FORMATION CONTROL');
    const skip = makeButton('SKIP FOR NOW', 'qgh-guide-button--quiet', () => { markSeen(); removeOverlay(); });
    const tactical = makeButton('TACTICAL TOUR', '', () => { writeStore(PENDING_KEY, 'tactical'); root.location.assign('tactical.html'); });
    const single = makeButton('SINGLE AIRCRAFT TOUR', 'qgh-guide-button--primary', () => { writeStore(PENDING_KEY, 'single'); root.location.assign('single.html'); });
    createOverlay('WELCOME TO QGH SIMULATOR', 'GUIDED FAMILIARISATION · OPTIONAL', content, [skip, tactical, single]);
  }

  function tourSteps(kind) {
    const single = kind === 'single';
    const setupSelector = single ? '#setup .fields' : '#tSetup .tactical-setup-fields';
    const startSelector = single ? '#setup .start' : '#tSetup .tactical-start';
    const dfSelector = single ? '.df-card' : '.tactical-df-stage';
    const controlsSelector = single ? '#controls' : '.tactical-controls';
    const start = {
      selector: startSelector,
      title: 'START A PRACTICE EXERCISE',
      text: 'Start with the values already on screen. The familiarisation then stays with live exercise controls; setup and review are left out so the RT flow stays clear.',
      startSample: true
    };
    const voice = {
      selector: '.voice-dock',
      title: 'PREPARE VOICE CONTROL',
      text: 'Open VOICE to prepare offline recognition. Hold PTT for one complete controller call, then release; Continuous Listening is optional. Pilot sound starts muted. For replies, wear headphones, select HEADPHONES · PILOT READBACKS, complete the audio test and confirm. Never use pilot replies on speakers. Open VOICE to mute before disconnecting headphones. Pilot voices target 150 words per minute; your new call interrupts the old reply without delaying the aircraft.',
      pattern: ['PTT DISCIPLINE', 'ONE AIRCRAFT · ONE ACTION · ONE CLEAR TARGET']
    };
    const normal = {
      selector: controlsSelector,
      title: 'NORMAL QGH · ASSIGN A HEADING',
      text: 'For Normal QGH, state the turn direction and assigned heading. The aircraft turns at the configured rate; a clear heading target is required for an initial turn.',
      pattern: ['RT CALL', 'TURN DIRECTION · HEADING'],
      examples: ['turn right heading zero six zero', 'turn left heading two seven zero']
    };
    const usCompass = {
      selector: controlsSelector,
      title: 'U/S COMPASS · TURN NOW',
      text: 'For U/S Compass, use only immediate turn calls. Do not give a heading assignment: turn left now, turn right now, then stop turn now when the required heading is reached.',
      pattern: ['RT CALL', 'TURN LEFT NOW · TURN RIGHT NOW · STOP TURN NOW'],
      examples: ['turn right now', 'stop turn now']
    };

    if (single) {
      return [
        {
          selector: setupSelector,
          title: 'PREPARE MANUALLY',
          text: 'Set runway, tracks, aircraft and procedure with the visible controls. Voice familiarisation begins in the live exercise, where controller RT calls matter most.'
        },
        voice,
        start,
        {
          selector: dfSelector,
          title: 'REQUEST DIRECTION FINDING',
          text: 'Select QDM or QTE, then transmit. The direction-finding indication is shown only for the transmission window and is quiet between calls.',
          pattern: ['RT CALL', 'MODE · TRANSMIT FOR D/F'],
          examples: ['show QDM', 'transmit for D/F']
        },
        normal,
        {
          selector: controlsSelector,
          title: 'CONTINUE AN ACTIVE TURN',
          text: '“Continue zero six zero” means continue the turn already in progress until heading 060. Use it only while a same-direction turn is active. If no matching turn is underway, issue a full left or right heading call instead.',
          pattern: ['ACTIVE TURN ONLY', 'CONTINUE · HEADING'],
          examples: ['continue zero six zero', 'turn right heading zero six zero']
        },
        usCompass
      ];
    }

    return [
      {
        selector: setupSelector,
        title: 'PREPARE THE FLIGHT MANUALLY',
        text: 'Set the aircraft list, levels and formation before starting. The voice demonstration begins on the live tactical console, not in the setup or review pages.'
      },
      voice,
      start,
      {
        selector: '#tAircraftRail',
        title: 'CALLSIGN FIRST',
        text: 'Every tactical call begins with the complete aircraft callsign. Replace Raven Twenty One in these examples with the exact callsign shown in the left rail. A full callsign makes the instruction unambiguous.',
        pattern: ['RT CALL', 'CALLSIGN · ACTION · TARGET'],
        examples: ['Raven Twenty One turn right heading zero six zero', 'Raven Twenty One transmit for D/F']
      },
      {
        selector: dfSelector,
        title: 'TRANSMIT FOR THAT AIRCRAFT',
        text: 'Use the callsign in the same call that requests D/F. The selected aircraft channel supplies the momentary QDM or QTE indication; another aircraft is not changed.',
        pattern: ['RT CALL', 'CALLSIGN · TRANSMIT FOR D/F'],
        examples: ['show QDM', 'Raven Twenty One transmit for D/F']
      },
      {
        ...normal,
        title: 'NORMAL QGH · CALL THE AIRCRAFT',
        text: 'In tactical Normal QGH, include the callsign, direction and heading. The instruction applies only to that aircraft unless it remains following its formation leader.',
        pattern: ['RT CALL', 'CALLSIGN · TURN DIRECTION · HEADING'],
        examples: ['Raven Twenty One turn right heading zero six zero', 'Raven Twenty One continue zero six zero']
      },
      {
        ...usCompass,
        title: 'U/S COMPASS · CALL THE AIRCRAFT',
        text: 'In tactical U/S Compass, include the callsign and use immediate turns only. Stop the named aircraft with a separate stop-turn call.',
        pattern: ['RT CALL', 'CALLSIGN · TURN RIGHT NOW · STOP TURN NOW'],
        examples: ['Raven Twenty One turn right now', 'Raven Twenty One stop turn now']
      },
      {
        selector: controlsSelector,
        title: 'RELEASE A FORMATION AIRCRAFT',
        text: 'A formation aircraft continues to follow its leader until it is released. Say the aircraft callsign first, then stop following leader. It will hold its last assigned heading and can then receive individual calls.',
        pattern: ['RT CALL', 'CALLSIGN · STOP FOLLOWING LEADER'],
        examples: ['Raven Twenty One stop following leader', 'Raven Twenty One turn left heading two seven zero']
      }
    ];
  }

  function openTour(kind, startingStep) {
    const steps = tourSteps(kind);
    let index = Math.max(0, Math.min(steps.length - 1, Number(startingStep) || 0));
    function render() {
      removeOverlay();
      const step = steps[index];
      const target = $(step.selector);
      target?.classList.add('qgh-guide-target');
      const content = documentRef.createElement('div');
      const count = documentRef.createElement('span');
      count.className = 'qgh-guide-step';
      count.textContent = `STEP ${String(index + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
      const copy = documentRef.createElement('p');
      copy.textContent = step.text;
      content.append(count, copy);
      if (step.pattern) addCallPattern(content, step.pattern[0], step.pattern[1]);
      addExamples(content, step.examples);
      const skip = makeButton('SKIP TOUR', 'qgh-guide-button--quiet', () => { markSeen(); removeOverlay(); });
      const back = index > 0 ? makeButton('BACK', '', () => { index -= 1; render(); }) : null;
      const next = makeButton(step.startSample ? 'START SAMPLE' : index === steps.length - 1 ? 'FINISH' : 'NEXT', 'qgh-guide-button--primary', () => {
        if (step.startSample) {
          const start = $(kind === 'single' ? '#startExercise' : '#tStart');
          if (start && !start.disabled) start.click();
          index += 1;
          root.setTimeout(render, 120);
          return;
        }
        if (index === steps.length - 1) { markSeen(); removeOverlay(); return; }
        index += 1;
        render();
      });
      createOverlay(step.title, 'GUIDED FAMILIARISATION', content, [skip, ...(back ? [back] : []), next], { index, total: steps.length });
    }
    render();
  }

  function insertLaunchControl(kind) {
    const brand = kind === 'entry' ? $('.entry-brand') : kind === 'single' ? $('.brand') : $('.tactical-brand');
    const guideLink = brand?.querySelector('a[href="user-guide.html"]');
    if (!brand || brand.querySelector('.qgh-guide-launch')) return;
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'qgh-guide-launch';
    button.textContent = 'GUIDED TOUR';
    button.addEventListener('click', () => kind === 'entry' ? entryWelcome() : openTour(kind, 0));
    if (guideLink) brand.insertBefore(button, guideLink);
    else brand.append(button);
  }

  const kind = pageKind();
  insertLaunchControl(kind);
  const pending = readStore(PENDING_KEY);
  if (pending === kind && kind !== 'entry') {
    removeStore(PENDING_KEY);
    root.setTimeout(() => openTour(kind, 0), 120);
  } else if (kind === 'entry' && !readStore(STORAGE_KEY)) {
    root.setTimeout(entryWelcome, 120);
  }
})(typeof globalThis === 'undefined' ? this : globalThis);
