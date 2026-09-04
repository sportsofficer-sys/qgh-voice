# Third-party notices

## IBM Plex fonts

This project redistributes unmodified IBM Plex Sans and IBM Plex Mono font files for offline use.

- Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"
- Licence: SIL Open Font License, Version 1.1 (OFL-1.1)
- Full licence text: `packages/qgh-engine/fonts/OFL-1.1.txt`, copied into the Windows and Android asset packages and the generated PWA
- Upstream licence: https://github.com/IBM/plex/blob/master/LICENSE.txt

The project MIT Licence does not relicense these font files. Their original licence and reserved font name continue to apply.

## Offline voice recognition

This project redistributes the following unmodified Apache-2.0 components for fully offline speech recognition:

- **Vosk Browser 0.0.8** — WebAssembly worker adapter by Ciaran O'Reilly, from https://github.com/ccoreilly/vosk-browser
- **Vosk small US English model 0.15** — Alpha Cephei model package, from https://alphacephei.com/vosk/models
- **Vosk Android 0.3.75** — resolved by Gradle from Maven Central for the Android application, from https://github.com/alphacep/vosk-api

The browser adapter is pinned and stored at `packages/qgh-engine/vendor/vosk-browser-0.0.8.js`. The model archive is stored at `packages/qgh-engine/voice-models/qgh-vosk-en-us-small-0.15.tar.gz`. The Apache License 2.0 text is provided at `packages/qgh-engine/vendor/Apache-2.0.txt` and is included in the native asset copies and generated web package.

The project's MIT Licence does not relicense these components or the language model.
