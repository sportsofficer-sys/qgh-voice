# Bundled pilot voices

This offline English voice pack uses four fixed male Kokoro voices: Michael
(`am_michael`), Fenrir (`am_fenrir`), Puck (`am_puck`) and George (`bm_george`).
The application distributes pre-rendered PCM audio segment banks. It does not
ship a neural model or run inference on the trainee's device. The model input
revision, rendered asset sizes and SHA-256 digests are recorded in
`../../pilot-voices/manifest.json`.

## Components and redistribution

- Build source: Kokoro 82M v1.0 ONNX q8 weights, tokenizer and four voice profiles:
  Apache License 2.0. Source model:
  https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231
  Licence text: `KOKORO-LICENSE.txt`.
- Model input and style-index conventions follow Kokoro JS 1.2.1 by hexgrad
  and Xenova (Apache License 2.0), revision
  `664c76a704021239ba59c84dcbaa4d3dece01fe9`:
  https://github.com/hexgrad/kokoro/tree/664c76a704021239ba59c84dcbaa4d3dece01fe9/kokoro.js
- Build tool: native ONNX Runtime 1.22.0, Copyright Microsoft Corporation:
  MIT License. Licence and dependency notices retained with the build sources:
  `onnxruntime-LICENSE.txt`, `onnxruntime-ThirdPartyNotices.txt`.
  https://github.com/microsoft/onnxruntime/tree/v1.22.0
- Build source: CMU Pronouncing Dictionary, Copyright 1993–2015 Carnegie Mellon University:
  BSD-style two-clause licence. Unmodified dictionary at revision
  `74790861f652b15e4ac49015a90074ad62a27690`.
  Licence text: `CMUDICT-LICENSE.txt`. The application only uses the resulting
  audio; the render recipe retains the selected pronunciations and token IDs.
  https://github.com/cmusphinx/cmudict/tree/74790861f652b15e4ac49015a90074ad62a27690
- QGH's `runtime.mjs` and worker/audio adapters are provided under the
  application MIT License. `runtime.mjs` assembles the local audio clips.
  `build-phonemes.mjs` converts CMUdict pronunciations to the model's IPA
  character vocabulary and adds aviation pronunciations. `render-bank.py`
  runs the ONNX graph on a maintenance computer, producing the clip banks.

The application licence does not relicense these third-party assets. The licence
and attribution files listed in the pack manifest accompany the audio banks.
Build-tool notices remain with the source repository; those tools are not
included in the deployed application.

## Pronunciation and offline behaviour

The four timbres are independent of operating-system voice installations.
Supported radio reply phrases are rendered as complete segments. Falcon,
Raven, Viper, Hawk and Eagle have spoken callsign segments. Unknown custom
callsigns are spoken as individual English letter names, preserving all letters;
digits are spoken individually. No pronunciation is fetched online.

Audio assembly runs in a dedicated worker. The browser needs Web Audio and
workers; it does not require WebAssembly, WebGPU, SharedArrayBuffer, cloud
inference or a public CDN. The initial offline download saves all four banks.
The user's pilot voice test loads and decodes Michael only; other banks are
decoded on first use, with coalesced requests and a serial loading queue.
The render speeds are calibrated per voice toward a deliberate
training pace. A build-only FFmpeg `atempo` pass then normalizes each segment to
0.6 seconds per spoken word without changing pitch. The applied tempo factors
are limited to 0.5–2.0; the committed segments needed approximately 0.71–1.76.
Small output-length differences are corrected only in silence, with a maximum
30ms adjustment; voiced endings are preserved by reprocessing from the original
PCM when necessary. Each segment's source length, applied factor and silence
adjustment are recorded in the index. The app adds a 30ms gap between segments,
so composed replies play at approximately 95–100 words per minute. Custom spelled
names take longer because each letter is a spoken item.

Canonical tempo tool: FFmpeg 7.1 essentials from the Windows x86_64
`imageio-ffmpeg==0.6.0` distribution. Its executable SHA-256 is
`2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3`.
This GPL-enabled executable is a maintenance tool outside the repository and
is not distributed or loaded by the application. Its use does not add FFmpeg
code to the PCM audio output. Documentation: https://ffmpeg.org/ffmpeg-filters.html#atempo

No eSpeak NG, phonemizer.js or Kokoro JS browser bundle is distributed. Although
phonemizer.js declares Apache-2.0 for its wrapper, its embedded eSpeak NG code
has GPL obligations. This pack instead uses the separately licensed CMUdict
and QGH's own conversion code during asset preparation.

Verify checked-in assets with `node scripts/prepare-pilot-voices.mjs --verify`.
After an intentional asset update, `node scripts/prepare-pilot-voices.mjs`
rebuilds the manifest. Reproduce the banks with Python containing
`numpy==2.3.5` and `onnxruntime==1.22.0`, then run
`node scripts/prepare-pilot-voices.mjs --render --python <python-executable> --ffmpeg <ffmpeg-executable>`.
Optional `--python-libs <directory>` selects an isolated dependency directory;
`--source-cache <directory>` selects the build input cache. The maintenance
script downloads and verifies the pinned model and style files into a temporary
build directory, never the application. The committed `render-recipe.json`
contains every rendered phrase, its IPA, exact token IDs and per-voice speed.
Two native render jobs use two CPU threads each. Every application runtime URL
is local to the installed application.

To normalize preserved raw banks without running the neural model, keep their
four WAV files and `index.json` in a separate directory and use
`node scripts/prepare-pilot-voices.mjs --normalize --raw-banks <raw-directory> --python <python-executable> --ffmpeg <ffmpeg-executable>`.
`tempo_normalize.py` refuses an identical input/output directory and enforces
the tool hash and conservative factor limits. The index records the original
bank SHA-256 values as provenance. Raw build inputs are never copied into the
deployed voice pack.
