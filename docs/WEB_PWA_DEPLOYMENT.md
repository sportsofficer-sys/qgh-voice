# QGH Voice web and iPhone deployment

## Purpose

The web edition makes QGH Voice available from a browser on iPhone, iPad, Android, Windows, macOS, and Linux. It packages the canonical simulator engine and is designed to work offline after the first successful load.

It is a Progressive Web App (PWA), not an App Store package. The current simulator does not use a backend, cloud account, analytics, location, or device files. Voice control requests microphone permission only when the user activates it and uses the self-hosted Vosk offline engine; it remains unavailable rather than using a cloud fallback. On first voice use, the user selects **SET UP OFFLINE VOICE** while online to cache the model (about 40 MB). Apart from that same-origin model request, QGH makes no network request for audio, recognised speech, or exercise data. Its service worker stores the application shell and the user-requested voice model for offline use; no personal data or exercise state is retained after a reload.

The hosted PWA is the supported iPhone and iPad route for this release.

## Before publishing

The source repository is public, but the browser app is not published until its deployment workflow completes. The repository owner has selected the **Public web app** access model for this release. The alternatives remain here for a future private or internal release:

| Access model | Suitable when | Important consequence |
| --- | --- | --- |
| Public web app | The simulator is approved for unrestricted access | Anyone with the link can use it. GitHub Release download links can work publicly. |
| Protected web app | Access should be restricted to named users or an organisation | Use Cloudflare Access or an equivalent identity layer before production deployment. A private GitHub repository alone does not make a Pages URL private. |
| Internal-only web app | It must stay inside an organisation network | Host it on the organisation's approved internal web service and do not expose a public URL or QR code. |

This decision also controls how Windows and Android installers are distributed. Direct GitHub Release asset links are suitable only when their repository and release permissions match the intended audience. A protected source repository needs a separately approved binary-delivery location for public downloads, such as Cloudflare R2 or an organisation software portal.

## 1. Create and connect the GitHub repository

Create a GitHub repository named `qgh-voice` under the approved owner or organisation. Choose its visibility based on the access decision above. Do not upload installers, APKs, keystores, provisioning profiles, certificates, passwords, or local signing files.

Build the public source release from a clean checkout. Do not run `git add .`; inspect and stage only the reviewed source paths. Never add generated installers, APKs, build folders, dependency folders, signing material, local state, or validation files for platforms that are not part of the release.

~~~powershell
git status --short
git diff --cached --name-only
~~~

Review the staged file list and the full staged diff before committing. The existing `.gitignore` excludes generated web output, installers, Android build products, and common private signing material; it is an additional safeguard, not a substitute for review.

## 2. Build the deployable web package

The web package is generated rather than deployed directly from `packages/qgh-engine`.

~~~powershell
$tests = Get-ChildItem .\packages\qgh-engine\test\*.test.js | ForEach-Object FullName
node --test $tests .\apps\web\test\*.test.mjs
~~~

The verification command creates a fresh `apps/web/dist` package before checking it. To build without running the verification test, use `node .\scripts\build-web.mjs`.

The output directory is `apps/web/dist`. The build copies only the current entry, single-aircraft, tactical, CSS, JavaScript, and font files, then adds the PWA files. It intentionally excludes the stale `screens` folder, local runtime state, tests, installers, and native signing material.

## 3. Deploy with GitHub Pages

The repository includes a GitHub Actions deployment workflow. In the repository's **Settings** → **Pages**, select **GitHub Actions** as the build and deployment source. A push to `main` builds the PWA and deploys it to:

`https://reds-aviation.github.io/qgh-voice/`

Wait for the **Deploy QGH PWA to GitHub Pages** workflow to complete, then run the checks in the next section before sharing the URL.

Before relying on the public deployment, protect `main` in **Settings** → **Branches**: require pull requests, require the **Validate QGH source / validate** and **Android Gradle Wrapper Integrity / Validate Gradle wrapper** checks to pass, require branches to be up to date, and restrict bypass permissions. In **Settings** → **Environments** → **github-pages**, restrict deployments to the protected `main` branch. The workflow itself also refuses to deploy a manually selected non-`main` branch.

## 4. Alternative deployment with Cloudflare Pages

1. Sign in to the approved Cloudflare account.
2. Open **Workers & Pages** and choose **Create application** → **Pages** → **Connect to Git**.
3. Select the `qgh-voice` repository.
4. Use these build settings:
   - Framework preset: **None**
   - Build command: `node scripts/build-web.mjs`
   - Build output directory: `apps/web/dist`
   - Root directory: repository root
   - Environment variables: none
5. Before clicking **Save and Deploy**, apply the selected public, protected, or internal access policy. For restricted access, configure Cloudflare Access before sending the URL to users.
6. Deploy and record the resulting `https://…pages.dev` URL.

For Cloudflare Pages, the `_headers` file applies a restrictive content-security policy, disables framing, disables unused browser permissions, and prevents the service worker manifest/version files from being long-cached by the host. GitHub Pages does not apply `_headers`; the application pages include their own restrictive Content Security Policy meta tag.

For a custom domain later, add it through the Pages project's **Custom domains** settings, complete the required DNS verification, and retest the install and offline flow on the final HTTPS domain.

## 5. Test before sharing

Test the deployed URL on at least one desktop browser and one Android or iPhone browser before distributing it:

1. Open the entry page. Verify the optional Guided Familiarisation can be started, skipped, and reopened through **Guided Tour**.
2. Run a Normal QGH exercise.
3. Run a U/S Compass exercise.
4. Run a Tactical QGH exercise.
5. Confirm manual controls still operate. While online, open **VOICE**, select **SET UP OFFLINE VOICE**, then test **PTT** and Continuous Listening, including the assistant's **Stop** action.
6. Terminate and review an exercise, including replay speed and zoom controls.
7. Reload once after the initial successful load and voice setup, then put the device into airplane mode and reopen the PWA. The application shell and prepared offline voice feature should still open.
8. Confirm that starting a new exercise after a reload is expected; current exercise data is intentionally not persistent.
9. Publish a harmless update to a test deployment and confirm the update notice does not reload an active console. Finish or terminate first, then choose **UPDATE**.

Safari requires manual device testing because it does not offer Chromium's `beforeinstallprompt` event. Test the actual **Add to Home Screen** flow rather than assuming a desktop browser represents Safari.

## iPhone and iPad installation

On the iPhone or iPad:

1. Open the HTTPS QGH URL in **Safari**.
2. Tap **Share**.
3. Choose **Add to Home Screen**.
4. Enable **Open as Web App** when Safari offers it.
5. Tap **Add**.
6. Launch **QGH Simulator** from the Home Screen.

Apple controls this installation flow. A website cannot silently install itself or bypass Safari's confirmation. The PWA will work offline after its initial successful load, subject to the device's normal browser-storage policies.

## Android and desktop browser installation

On Chrome, Edge, and many Android browsers, use the entry-page **Install QGH on this device** button when the browser offers an install prompt. If the browser does not offer it, use its menu and choose **Install app** or **Add to Home screen**.

The browser-installed PWA is separate from the signed Android APK and Windows application. It is ideal for quick access; the native packages remain available where local installation is preferred.

## 6. Add Windows and Android download links

After the team has published real release assets to an approved location, edit only these two values in `apps/web/static/release-links.js`:

~~~javascript
window.QGH_RELEASES = Object.freeze({
  windows: 'https://approved-host.example/QGH-Simulator.exe',
  android: 'https://approved-host.example/QGH-Simulator.apk',
});
~~~

Use direct HTTPS download URLs. Rebuild and redeploy the PWA afterward. If either value remains `null`, its button is safely hidden rather than leading users to a broken link. Do not place a 385 MB Windows executable or an APK inside the Pages output or Git history.

## 7. Create a QR code after the final URL exists

Generate the QR code only after the production HTTPS URL and access policy are final. Encode the exact production URL, scan it with an iPhone and Android phone, and verify it opens the intended site. Do not print or circulate a QR code for a preview deployment.

## Releasing an update across web, Windows, and Android

The PWA release record is the shared version source. For every simulator release:

1. Choose a new semantic version and a new, larger Android version code.
2. From the repository root, run:

   ~~~powershell
   .\scripts\Set-QghReleaseVersion.ps1 -Version 4.1.0 -AndroidVersionCode 14
   node .\scripts\verify-release-version.mjs
   ~~~

3. Run the web tests and the platform-specific checks, then build a fresh Windows installer and signed Android package from that protected commit.
4. Push or merge the reviewed release to `main`. GitHub Pages automatically deploys the PWA after its version check passes.
5. Publish or distribute the tested native packages through the approved channel. Native installers are not silently updated by the PWA.

The web build injects the shared release version into the cache name, entry-page label, and asset-version references. Existing installed PWAs show a user-controlled update notice when the new service worker is ready; they never force-reload an active exercise.

## Security boundaries

- The PWA caches its same-origin application shell and, only after explicit user setup, the same-origin offline voice model. It does not cache installer links, user inputs, or exercise tracks.
- The service worker accepts only same-origin GET requests.
- The browser content-security policy permits same-origin model retrieval through `connect-src 'self'` and restricts scripts, styles, images, and workers to self-hosted content. The bundled Vosk WebAssembly adapter requires the narrowly scoped `wasm-unsafe-eval` and `unsafe-eval` script permissions; no third-party script or cloud speech endpoint is allowed.
- Release links use `rel="noopener noreferrer"` and accept only HTTPS URLs.
- The native apps remain local-only and do not gain web links, service workers, or external navigation from this work.

For Cloudflare Pages configuration details, see the official [Cloudflare Pages deploy guide](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/) and [Pages headers documentation](https://developers.cloudflare.com/pages/configuration/headers/). For Apple's current Home Screen web-app flow, see [Apple's iPhone guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).
