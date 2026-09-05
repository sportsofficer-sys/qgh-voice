// Verify/package pre-rendered pilot clips. --render reproduces them using native
// ONNX Runtime 1.22.0, NumPy and FFmpeg in the build environment, outside the app.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../packages/qgh-engine/', import.meta.url));
const manifestPath = path.join(root, 'pilot-voices/manifest.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const hf = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${MODEL_REVISION}/`;
const VOICES = ['am_michael', 'am_fenrir', 'am_puck', 'bm_george'];
const sources = [
  ['model_quantized.onnx', 'onnx/model_quantized.onnx', 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'],
  ['am_michael.bin', 'voices/am_michael.bin', '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1'],
  ['am_fenrir.bin', 'voices/am_fenrir.bin', 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43'],
  ['am_puck.bin', 'voices/am_puck.bin', 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0'],
  ['bm_george.bin', 'voices/bm_george.bin', 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc']
];
if (process.argv.includes('--verify')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(root, asset.path));
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error(`Pilot pack verification failed: ${asset.path}`);
  }
  console.log(`Verified ${manifest.assets.length} pilot voice assets (${manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0)} bytes).`);
  process.exit(0);
}
if (process.argv.includes('--render')) {
  const directory = path.resolve(option('--source-cache', path.join(tmpdir(), 'qgh-pilot-render-v1')));
  await mkdir(directory, { recursive: true });
  for (const [filename, upstream, expected] of sources) {
    const target = path.join(directory, filename);
    let bytes;
    try { bytes = await readFile(target); } catch (_) { /* Download a missing build input. */ }
    if (!bytes || digest(bytes) !== expected) {
      console.log(`Downloading build input ${filename}`);
      const response = await fetch(hf + upstream);
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${filename}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== expected) throw new Error(`Build input checksum mismatch: ${filename}`);
      await writeFile(target, bytes);
    }
  }
  await copyFile(path.join(root, 'vendor/pilot-tts/render-recipe.json'), path.join(directory, 'render-recipe.json'));
  if (!option('--ffmpeg')) throw new Error('Provide the pinned build-only FFmpeg executable with --ffmpeg.');
  const args = [path.join(root, 'vendor/pilot-tts/render-bank.py'), '--source', directory, '--output', path.join(root, 'pilot-voices'), '--ffmpeg', option('--ffmpeg')];
  if (process.argv.includes('--python-libs')) args.push('--python-libs', option('--python-libs'));
  const render = spawnSync(option('--python', 'python'), args, { stdio: 'inherit', windowsHide: true });
  if (render.error) throw render.error;
  if (render.status !== 0) throw new Error('Native pilot clip rendering failed. Use Python with NumPy and onnxruntime==1.22.0.');
}
if (process.argv.includes('--normalize')) {
  if (!option('--raw-banks') || !option('--ffmpeg')) throw new Error('--normalize requires separate --raw-banks and --ffmpeg paths.');
  const args = [path.join(root, 'vendor/pilot-tts/tempo_normalize.py'), '--input', option('--raw-banks'),
    '--output', path.join(root, 'pilot-voices'), '--recipe', path.join(root, 'vendor/pilot-tts/render-recipe.json'),
    '--ffmpeg', option('--ffmpeg')];
  const normalize = spawnSync(option('--python', 'python'), args, { stdio: 'inherit', windowsHide: true });
  if (normalize.error) throw normalize.error;
  if (normalize.status !== 0) throw new Error('Pilot clip tempo normalization failed.');
}
const paths = [
  'pilot-voices/index.json', ...VOICES.map(voice => `pilot-voices/${voice}.wav`),
  'vendor/pilot-tts/runtime.mjs', 'vendor/pilot-tts/NOTICE.md',
  'vendor/pilot-tts/KOKORO-LICENSE.txt', 'vendor/pilot-tts/CMUDICT-LICENSE.txt'
];
const assets = [];
for (const relative of paths) {
  const bytes = await readFile(path.join(root, relative));
  assets.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
}
const recipe = await readFile(path.join(root, 'vendor/pilot-tts/render-recipe.json'));
const index = JSON.parse(await readFile(path.join(root, 'pilot-voices/index.json'), 'utf8'));
if (index.recipeSha256 !== digest(recipe)) throw new Error('Voice index does not match the current render recipe. Re-render the banks.');
const manifest = {
  version: 'qgh-pilot-kokoro-clips-en-2', format: 'pcm16-wav-segment-banks', sampleRate: 24000,
  targetWPM: 100, voices: VOICES, model: 'onnx-community/Kokoro-82M-v1.0-ONNX', modelRevision: MODEL_REVISION,
  buildRuntime: 'onnxruntime==1.22.0', buildNumpy: 'numpy==2.3.5', recipeSha256: digest(recipe),
  tempoNormalization: index.tempoNormalization,
  buildInputs: sources.map(([filename, upstream, sha256]) => ({ filename, url: hf + upstream, sha256 })),
  assets: assets.sort((a, b) => a.path.localeCompare(b.path))
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${assets.length} local assets (${assets.reduce((sum, asset) => sum + asset.bytes, 0)} bytes).`);
