(function initializeHeadphones(root) {
  'use strict';

  // This records a person's confirmation, not hardware detection. Nothing is
  // restored from storage: a previous visit cannot prove today's audio route.
  function create(options) {
    const state = { open: false, testing: false, tested: false, confirmed: false, message: '' };
    let generation = 0;
    const publish = () => options.onChange?.({ ...state });
    function invalidateTest() {
      generation++;
      state.testing = state.tested = false;
      options.stopTest?.();
      publish();
    }
    function mute(message = 'Pilot replies muted.') {
      state.confirmed = false;
      options.setEnabled(false);
      invalidateTest();
      state.message = message;
      publish();
    }
    return Object.freeze({
      status: () => ({ ...state }),
      open() { mute('Connect and wear headphones, then test the audio.'); state.open = true; publish(); },
      close() { mute(); state.open = false; publish(); },
      mute,
      invalidateTest,
      deviceChanged() { mute('Audio devices changed. Pilot replies muted — check your headphones again.'); },
      async test() {
        if (!state.open || state.testing) return false;
        invalidateTest();
        const ticket = generation;
        state.testing = true;
        state.message = 'Preparing offline pilot audio…';
        publish();
        let ok = false;
        try { ok = await options.playTest() === true; } catch { /* Keep confirmation locked. */ }
        if (ticket !== generation || !state.open) return false;
        state.testing = false;
        state.tested = ok;
        state.message = ok ? 'Did you hear the test through your headphones?' : 'Audio test could not finish. Retry, or keep pilot replies muted.';
        publish();
        return ok;
      },
      confirm(checked) {
        if (!state.open || state.testing || !state.tested || checked !== true) return false;
        state.confirmed = true;
        state.open = false;
        state.message = 'Headphones confirmed by you · pilot replies on.';
        options.setEnabled(true);
        publish();
        return true;
      }
    });
  }
  if (typeof module === 'object' && module.exports) { module.exports = { create }; return; }
  if (!root.document || !root.QGHRadioWorkspace) return;
  const document = root.document;
  let dialog;
  let testButton;
  let checkbox;
  let enableButton;
  let status;
  let previousFocus;
  let testingTicket = 0;
  let testingTimer;
  let settleTest;
  let blocking = false;
  const notify = () => root.dispatchEvent(new root.CustomEvent('qgh-pilot-audio-change'));
  function stopTest() {
    testingTicket++;
    root.clearTimeout(testingTimer);
    if (settleTest) {
      root.QGHPilotVoiceEngine?.cancel();
      const settle = settleTest; settleTest = null; settle(false);
    }
  }
  const controller = create({
    setEnabled: enabled => root.QGHRadioWorkspace.setAudioEnabled(enabled),
    stopTest,
    playTest: () => new Promise(resolve => {
      const ticket = ++testingTicket;
      settleTest = resolve;
      const finish = ok => {
        if (ticket !== testingTicket) return;
        testingTicket++;
        root.clearTimeout(testingTimer);
        settleTest = null;
        resolve(ok);
      };
      const engine = root.QGHPilotVoiceEngine;
      if (!engine) { finish(false); return; }
      // Recognition is blocked for the entire dialog, including loading and
      // the audio tail. Test speech never generates a simulated transmission.
      testingTimer = root.setTimeout(() => { engine.cancel(); finish(false); }, 120000);
      engine.prepare({ onProgress: message => { if (ticket === testingTicket && status) status.textContent = typeof message === 'string' ? message : 'Preparing offline voices…'; } })
        .then(() => {
          if (ticket !== testingTicket) return;
          return engine.speak({ id: `headphone-test-${ticket}`, source: 'single',
            text: 'Roger, turning right two three zero, Falcon one one.',
            onend: () => {
              if (ticket !== testingTicket) return;
              root.clearTimeout(testingTimer);
              testingTimer = root.setTimeout(() => finish(true), 350);
            },
            onerror: () => finish(false) });
        }).catch(() => finish(false));
    }),
    onChange: state => {
      const changed = blocking !== state.open;
      blocking = state.open;
      // Changing this gate invalidates late controller transcripts before a
      // test can start. It does not pause aircraft or change their instructions.
      if (changed) root.QGHVoiceWorkspace?.setPilotSpeaking(state.open);
      if (dialog) {
        status.textContent = state.message;
        testButton.disabled = state.testing;
        testButton.textContent = state.testing ? 'PREPARING / TESTING…' : 'TEST HEADPHONE AUDIO';
        checkbox.disabled = !state.tested || state.testing;
        if (!state.tested) checkbox.checked = false;
        enableButton.disabled = !state.tested || !checkbox.checked || state.testing;
        if (!state.open && dialog.open) { dialog.close(); previousFocus?.focus?.(); }
      }
      notify();
    }
  });
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function requestEnable() {
    if (!dialog) {
      dialog = element('dialog', '', 'headphone-dialog');
      dialog.setAttribute('aria-labelledby', 'headphoneTitle');
      const eyebrow = element('p', 'PILOT AUDIO · OFFLINE', 'headphone-eyebrow');
      const heading = element('h2', 'Connect your headphones'); heading.id = 'headphoneTitle';
      const warning = element('p', 'Speaker audio can enter your microphone and be mistaken for controller commands, causing unintended actions. Wear headphones and mute pilot replies before removing or disconnecting them.', 'headphone-warning');
      const pace = element('p', 'Four male pilot voices · target 100 words/minute', 'headphone-pace');
      const explanation = element('p', 'The test plays a sample pilot readback without changing the exercise. This is your confirmation, not automatic headphone detection. Audio-device changes are monitored where the browser supports it. Some changes may not be reported.', 'headphone-help');
      testButton = element('button', 'TEST HEADPHONE AUDIO'); testButton.type = 'button';
      testButton.addEventListener('click', () => controller.test());
      status = element('p', '', 'headphone-test-status'); status.setAttribute('role', 'status');
      const label = element('label', '', 'headphone-check');
      checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.id = 'headphoneConfirmed';
      checkbox.addEventListener('change', () => { enableButton.disabled = !checkbox.checked || !controller.status().tested; });
      label.append(checkbox, element('span', 'I am wearing headphones and heard the test through them.'));
      const actions = element('div', '', 'headphone-actions');
      const cancel = element('button', 'KEEP MUTED'); cancel.type = 'button';
      cancel.addEventListener('click', () => controller.close());
      enableButton = element('button', 'ENABLE PILOT REPLIES', 'headphone-enable'); enableButton.type = 'button';
      enableButton.addEventListener('click', () => controller.confirm(checkbox.checked));
      actions.append(cancel, enableButton);
      dialog.append(eyebrow, heading, warning, pace, explanation, testButton, status, label, actions);
      dialog.addEventListener('cancel', event => { event.preventDefault(); controller.close(); });
      document.body.append(dialog);
    }
    previousFocus = document.activeElement;
    controller.open();
    dialog.showModal();
    testButton.focus();
  }
  root.QGHHeadphones = Object.freeze({
    requestEnable,
    confirmed: () => controller.status().confirmed,
    blocksMicrophone: () => blocking,
    mute: () => controller.mute(),
    status: controller.status
  });
  root.navigator?.mediaDevices?.addEventListener?.('devicechange', () => {
    // Do not infer physical device type from names, or equate "connected" with
    // the TTS output route. A conservative recheck also covers ambiguous events.
    controller.deviceChanged();
  });
  root.addEventListener('pagehide', () => controller.close());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') controller.close();
  });
})(typeof globalThis === 'undefined' ? this : globalThis);
