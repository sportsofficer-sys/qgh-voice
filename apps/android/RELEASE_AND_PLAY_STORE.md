# QGH Simulator Android release guide

## What is ready now

- `app/build/outputs/apk/debug/app-debug.apk` is the installable **test** app. It is signed with the Android debug certificate and is suitable only for testing on a phone.
- A Play Store `.aab` is deliberately not created until the owner supplies an upload key. This prevents accidentally distributing an unsigned production package.
- The application works from bundled local files. It declares no Internet permission, uses no advertising or analytics SDK, and does not request device permissions.

## Create the upload key once

Keep this key. Losing it makes future release management much harder.

1. Create a secure folder outside this project, for example `C:\Users\YourName\Documents\QGH-Simulator-Keys`.
2. Open a terminal in that folder and run:

   ```powershell
   & "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v -keystore qgh-upload-key.jks -alias qgh-upload -keyalg RSA -keysize 4096 -validity 10000
   ```

3. Use a unique strong password and store the key plus its password in a secure password manager or offline safe.
4. Copy `qgh-release.properties.example` to `qgh-release.properties.local`, then fill in the keystore path, alias, and passwords. Do not share the `.local` file.

## Build the Play Store upload file

Before every Android release, set the shared simulator version from the repository root. AndroidVersionCode must be a new, larger integer for every Play Store update:

~~~powershell
.\scripts\Set-QghReleaseVersion.ps1 -Version 4.0.2 -AndroidVersionCode 12
node .\scripts\verify-release-version.mjs
~~~

Then, from this folder, run:

```powershell
.\gradlew.bat --no-daemon clean :app:lintRelease :app:bundleRelease
```

The signed upload bundle will be at:

```text
app\build\outputs\bundle\release\app-release.aab
```

## Install the test app on an Android phone

1. Copy `app-debug.apk` to the phone using USB, WhatsApp as a document, or a trusted file-transfer service.
2. On the phone, allow installs from the file manager only for this installation.
3. Open the APK and install it.
4. Turn on Airplane mode, open QGH Simulator, and run an exercise. It should work completely offline.

Do not put the debug APK on the Play Store.

## Google Play release checklist

1. Create or use the owner’s Google Play Developer account and complete Google’s required verification.
2. In Play Console, create the app using package name `in.qgh.simulator`.
3. Enable Play App Signing when prompted and upload the signed `.aab` to Internal testing first.
4. Test the Internal-testing install on current Android phones, including an Airplane-mode test.
5. Complete the store listing, content rating, privacy policy, and Data safety form based on the final artifact. This build is designed to collect no data and request no device permissions; confirm that remains true before submission.
6. Promote the tested build through closed/open testing and then production when Play Console requirements are satisfied.

## Security notes

- Never commit or send `qgh-release.properties.local`, `.jks`, or `.keystore` files.
- Keep the upload key and its passwords separate from the app source and installer.
- The repository includes the `Android Gradle Wrapper Integrity` workflow. When hosting this repository on GitHub, do **not** rely only on a required status-check name: a pull request can otherwise alter the workflow that provides that check.
- For protected wrapper validation, use a GitHub organization or enterprise branch ruleset for `main` with **Require workflows to pass before merging**. Select `.github/workflows/android-gradle-wrapper-integrity.yml` from a trusted source and pin that source to an immutable commit SHA (or keep it in a separately governed CI-policy repository). Require pull requests for `main` and security-owner approval for workflow changes. The required workflow must be configured from the hosted repository; this local checkout has no GitHub remote or ruleset to activate.
- Build a release only from a protected commit after the required wrapper-integrity workflow has passed. Do not run Gradle from an untrusted pull-request, fork, or downloaded checkout.
- Re-run `:app:lintRelease` and test the signed build before every Play Store upload.
- Increase `versionCode` for every Play Store update.
