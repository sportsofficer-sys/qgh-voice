# QGH Voice

Offline-first QGH training simulator for Windows, Android, iPhone, iPad, and modern web browsers.

See [USER_GUIDE.md](USER_GUIDE.md) for installation, exercise, replay, tactical, and voice-control guidance.

The simulator provides Normal QGH and U/S Compass exercises, live D/F homing and QTE/QDM displays, timed turns, aircraft-specific training defaults, optional local voice control, and a recorded flight-path review. It is designed to work entirely offline after installation.

## Projects

| Location | Platform | Implementation |
| --- | --- | --- |
| apps/windows | Windows | Electron desktop application |
| apps/android | Android | Local Android WebView application |
| apps/web | Web, iPhone, and iPad | Hosted Progressive Web App build layer and supported Apple-device route |
| packages/qgh-engine | Shared | Canonical HTML, CSS, JavaScript, and local fonts |

Windows and Android package the canonical files from `packages/qgh-engine`. The hosted PWA is the supported iPhone and iPad route for this release.

~~~powershell
.\scripts\Sync-WebAssets.ps1 -Target Android
.\scripts\Sync-WebAssets.ps1 -Target Windows
.\scripts\Verify-WebAssets.ps1
~~~

`Verify-WebAssets.ps1` checks SHA-256 hashes so that the Android and Windows source bundles remain identical to the canonical engine.

### Web PWA

The hosted web edition is built from the canonical engine as a clean static package:

~~~powershell
node .\scripts\build-web.mjs
$tests = Get-ChildItem .\packages\qgh-engine\test\*.test.js | ForEach-Object FullName
node --test $tests .\apps\web\test\*.test.mjs
~~~

The generated `apps/web/dist` directory supports a browser-installed PWA on desktop, Android, iPhone, and iPad. It works offline after the first successful load, but exercise data remains in memory and is intentionally cleared by a page reload. The public PWA is published independently at `https://sportsofficer-sys.github.io/qgh-voice/` after its Pages workflow completes. See [docs/WEB_PWA_DEPLOYMENT.md](docs/WEB_PWA_DEPLOYMENT.md) for Cloudflare Pages, GitHub, access-control, QR, iPhone installation, and release-download instructions.

### Versioned releases

The PWA release record at 'apps/web/static/app-version.json' is shared by every platform. Set every platform's version together, then verify it before building:

~~~powershell
.\scripts\Set-QghReleaseVersion.ps1 -Version 4.0.3 -AndroidVersionCode 13
node .\scripts\verify-release-version.mjs
~~~

The GitHub checks and Pages deployment refuse a version mismatch. A push to 'main' automatically updates the hosted PWA. Windows and Android are deliberately rebuilt and distributed separately, so their installer or store release is tested before users install it.

## Building

### Windows

Install Node.js and pnpm, then run the following from apps/windows:

~~~powershell
pnpm install --frozen-lockfile
pnpm dist
~~~

The portable Windows build is generated locally and intentionally not stored in Git.

### Android

Open apps/android in Android Studio or use the Gradle wrapper:

~~~powershell
.\gradlew.bat :app:lintRelease :app:assembleDebug
~~~

Run the wrapper only from a trusted, protected commit that has passed the Android Gradle Wrapper Integrity workflow; do not execute it from an untrusted pull request, fork, or downloaded checkout.

The Android release and Play Store guide is in apps/android/RELEASE_AND_PLAY_STORE.md.

### iPhone and iPad

Use the hosted PWA in Safari. Its installation and offline-use instructions are in [docs/WEB_PWA_DEPLOYMENT.md](docs/WEB_PWA_DEPLOYMENT.md).

## Privacy and security

All shipped app variants are intended to be offline-first. The hosted PWA caches only its same-origin application shell; it does not retain exercise tracks or download installers into its cache. Do not add signing keys, provisioning profiles, credentials, installers, or generated builds to this repository.

See SECURITY.md for reporting guidance.

## Copyright and licence

Copyright (c) 2026 Flt Lt Balaram Reddy, Service No. 38703. This project is open source under the MIT License; see LICENSE. The bundled IBM Plex fonts retain their own SIL Open Font License; see THIRD_PARTY_NOTICES.md.
