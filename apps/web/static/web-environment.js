(() => {
  'use strict';

  const isLoopback = hostname => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const isHostedBrowser = () => {
    const { protocol, hostname } = window.location;
    if (hostname === 'appassets.androidplatform.net' || protocol === 'file:') return false;
    return protocol === 'https:' || (protocol === 'http:' && isLoopback(hostname));
  };

  window.QGH_WEB_ENVIRONMENT = Object.freeze({ isHostedBrowser });
})();
