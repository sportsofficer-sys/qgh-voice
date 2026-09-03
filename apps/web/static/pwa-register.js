(() => {
  'use strict';

  if (!window.QGH_WEB_ENVIRONMENT?.isHostedBrowser() || !('serviceWorker' in navigator)) return;

  let reloadApproved = false;
  let updateNotice;

  const hasActiveExercise = () => Boolean(
    document.querySelector('#console.active, #tConsole.active')
  );

  const setNoticeText = (element, text) => {
    const copy = element.querySelector('[data-update-copy]');
    if (copy) copy.textContent = text;
  };

  const offerUpdate = registration => {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;

    if (!updateNotice) {
      updateNotice = document.createElement('section');
      updateNotice.className = 'pwa-update-notice';
      updateNotice.setAttribute('role', 'status');
      updateNotice.innerHTML = '<span data-update-copy>A new version is ready.</span><button type="button">UPDATE</button>';
      updateNotice.querySelector('button').addEventListener('click', () => {
        if (hasActiveExercise()) {
          setNoticeText(updateNotice, 'Finish or terminate the current exercise before updating.');
          return;
        }

        reloadApproved = true;
        setNoticeText(updateNotice, 'Updating QGH Simulator…');
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      });
      document.body.append(updateNotice);
    }
  };

  const observeRegistration = registration => {
    if (registration.waiting) offerUpdate(registration);

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') offerUpdate(registration);
      });
    });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadApproved) window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('service-worker.js', { scope: './' });
      observeRegistration(registration);

      let updateCheck;
      const checkForUpdate = () => {
        updateCheck ??= registration.update()
          .catch(() => {})
          .finally(() => { updateCheck = undefined; });
        return updateCheck;
      };

      window.addEventListener('online', checkForUpdate);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    } catch {
      // The simulator remains usable online if service-worker registration is unavailable.
    }
  });
})();
