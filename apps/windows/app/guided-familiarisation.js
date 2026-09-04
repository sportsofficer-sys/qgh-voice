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

  function entryWelcome() {
    const content = documentRef.createElement('div');
    const copy = documentRef.createElement('p');
    copy.textContent = 'New to the simulator? Take a short guided familiarisation of the real controls, including the offline voice assistant. It is optional and does not change exercise behaviour.';
    content.append(copy);
    addExamples(content, ['PTT for a spoken command', 'VOICE → Continuous listening']);
    const skip = makeButton('SKIP FOR NOW', 'qgh-guide-button--quiet', () => { markSeen(); removeOverlay(); });
    const tactical = makeButton('TACTICAL TOUR', '', () => { writeStore(PENDING_KEY, 'tactical'); root.location.assign('tactical.html'); });
    const single = makeButton('SINGLE AIRCRAFT TOUR', 'qgh-guide-button--primary', () => { writeStore(PENDING_KEY, 'single'); root.location.assign('single.html'); });
    createOverlay('WELCOME TO QGH SIMULATOR', 'GUIDED FAMILIARISATION · OPTIONAL', content, [skip, tactical, single]);
  }

  function tourSteps(kind) {
    const single = kind === 'single';
    return [
      {
        selector: single ? '#setup .fields' : '#tSetup .tactical-setup-fields',
        title: 'SET THE EXERCISE',
        text: single
          ? 'Enter runway orientation, final track, outbound track, aircraft profile, range, speed and turn rate. Select Normal QGH or U/S Compass before starting.'
          : 'Set the common runway, final and outbound tracks, then choose Normal QGH or U/S Compass for the tactical flight.',
        examples: ['set runway orientation two three zero', 'select normal qgh']
      },
      {
        selector: single ? '#setup .start' : '#tSetup .tactical-start',
        title: 'START A SAMPLE EXERCISE',
        text: 'This opens the normal simulator console with the values already on screen. You remain in full control and can terminate or restart at any time.',
        examples: ['start simulator'],
        startSample: true
      },
      {
        selector: single ? '.df-card' : '.tactical-df-stage',
        title: 'READ THE D/F DISPLAY',
        text: 'Use QDM or QTE, then transmit to receive a momentary direction-finding indication. The display stays quiet between transmissions, just as in the exercise.',
        examples: ['select qdm', 'transmit for qdm']
      },
      {
        selector: single ? '#controls' : '.tactical-controls',
        title: 'ISSUE CONTROLLER CALLS',
        text: single
          ? 'Normal QGH uses heading-based turns. U/S Compass uses turn left now, turn right now and stop turn now. The aircraft follows the selected turn rate.'
          : 'Select an aircraft, transmit on its colour-coded channel, then issue the command. Formation aircraft follow their leader until explicitly released.',
        examples: single ? ['turn right heading two seven zero', 'advance flight one minute'] : ['select aircraft falcon one one', 'falcon one one turn right heading two seven zero']
      },
      {
        selector: '.voice-dock',
        title: 'USE OFFLINE VOICE',
        text: 'Open VOICE once to set up the local speech pack. Then hold PTT to speak. Continuous listening is optional and opens a compact voice-assistant panel with a clear stop action.',
        examples: ['report heading', 'continuous listening on']
      },
      {
        selector: single ? '#terminate' : '#tTerminate',
        title: 'REVIEW THE FLIGHT PATH',
        text: 'Terminate the exercise when ready. The review retains the flown path, command history, reference radials and replay controls. No tutorial marks are added to the analysis.',
        examples: ['terminate exercise', 'replay track']
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
