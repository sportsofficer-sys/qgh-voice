(() => {
  'use strict';

  if (!window.QGH_WEB_ENVIRONMENT?.isHostedBrowser() || !('serviceWorker' in navigator)) return;

  let reloadApproved = false;
  let updateNotice;
  let pilotRegistration;
  let pilotNotice;
  let pilotCopy;
  let pilotRetry;

  const prepareOfflinePilots = () => {
    pilotRegistration?.active?.postMessage({ type: 'CACHE_PILOT_PACK' });
  };

  const showPilotStatus = status => {
    // Keep download progress on the entry page, outside exercise controls.
    const entry = document.querySelector('.entry-app .entry-card');
    if (!entry) return;
    if (!pilotNotice) {
      pilotNotice = document.createElement('p');
      pilotNotice.className = 'entry-release-availability';
      pilotNotice.setAttribute('role', 'status');
      pilotNotice.setAttribute('aria-live', 'polite');
      pilotCopy = document.createElement('span');
      pilotRetry = document.createElement('button');
      pilotRetry.type = 'button';
      pilotRetry.textContent = 'Retry download';
      pilotRetry.addEventListener('click', () => {
        showPilotStatus({ state: 'checking' });
        prepareOfflinePilots();
      });
      pilotNotice.append(pilotCopy, document.createTextNode(' '), pilotRetry);
      entry.append(pilotNotice);
    }
    pilotRetry.hidden = status.state !== 'incomplete';
    if (status.state === 'ready') {
      pilotCopy.textContent = 'Pilot voices are saved for offline use.';
    } else if (status.state === 'incomplete') {
      pilotCopy.textContent = status.reason === 'storage'
        ? 'Pilot voices could not be saved. Free some browser storage and retry. You can still use the simulator.'
        : 'Pilot voice download is incomplete. Reconnect and retry for offline voices. You can still use the simulator.';
    } else if (status.state === 'downloading') {
      const total = Number(status.totalBytes);
      const loaded = Math.min(Number(status.loadedBytes) || 0, total);
      const progress = total > 0 ? ` ${Math.floor(loaded / 1000000)} of ${Math.ceil(total / 1000000)} MB.` : '';
      pilotCopy.textContent = `Saving pilot voices for offline use…${progress} Keep this page open until complete.`;
    } else {
      pilotCopy.textContent = 'Checking offline pilot voices…';
    }
  };

  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'PILOT_PACK_STATUS') showPilotStatus(event.data);
  });

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
      // The small application shell activates first. Downloading the voice pack
      // is a separate extendable message so it cannot delay manual exercises.
      void navigator.serviceWorker.ready.then(activeRegistration => {
        pilotRegistration = activeRegistration;
        showPilotStatus({ state: 'checking' });
        prepareOfflinePilots();
      }).catch(() => {});
      window.addEventListener('online', prepareOfflinePilots);

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
