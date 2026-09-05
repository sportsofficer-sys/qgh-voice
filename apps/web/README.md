# QGH Simulator web app

This folder creates the hosted Progressive Web App (PWA) edition of QGH Voice. The current release is v4.4.0 - Radio & Orbit. It packages the canonical files in `packages/qgh-engine` into `apps/web/dist` without modifying the Windows or Android native bundles.

## Build locally

From the repository root:

~~~powershell
node .\scripts\build-web.mjs
python -m http.server 57172 --bind 127.0.0.1 --directory .\apps\web\dist
~~~

Open `http://127.0.0.1:57172/index.html`. A service worker is enabled for HTTPS deployments and for localhost only. The output directory is generated and intentionally excluded from Git.

## What is included

- A web app manifest and Apple home-screen metadata.
- A service worker that caches the QGH application shell for offline use after the first successful load, plus the self-hosted Vosk model only after the user explicitly chooses offline voice setup.
- User-controlled updates: an update never reloads an active exercise.
- A hosted-web-only install area on the entry page. It is absent from the native application bundles.
- Optional Vosk-powered offline voice control with **PTT** by default and an optional Continuous Listening assistant. The PWA downloads its self-hosted model (about 40 MB) only when the user selects **SET UP OFFLINE VOICE** while online, then uses the local cache.
- An optional first-run Guided Familiarisation with Skip and later Guided Tour access.
- A clean allowlist build that excludes local state, stale duplicate screens, tests, installers, and signing material.

The simulator itself remains browser-only and keeps exercise state in memory. Reloading the page starts a new exercise; no flight data is stored by the PWA.

## Native download links

`static/release-links.js` deliberately begins with `null` values. Once real HTTPS release asset URLs exist, add those URLs there and rebuild. Do not add APKs, EXEs, certificates, passwords, or signing keys to this repository or to the PWA cache.

For complete Cloudflare Pages, GitHub, iPhone, and access-control instructions, see [WEB_PWA_DEPLOYMENT.md](../../docs/WEB_PWA_DEPLOYMENT.md).
