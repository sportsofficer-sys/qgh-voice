"""Maintenance-only native Kokoro renderer; never loaded by the application."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--python-libs')
parser.add_argument('--ffmpeg', required=True)
args = parser.parse_args()
if args.python_libs:
    sys.path.insert(0, args.python_libs)
import numpy as np
import onnxruntime as ort
if ort.__version__ != '1.22.0':
    raise RuntimeError('Use the pinned native build dependency onnxruntime==1.22.0.')
if np.__version__ != '2.3.5':
    raise RuntimeError('Use the pinned build dependency numpy==2.3.5.')
from tempo_normalize import normalize_pcm, tool_info
tempo_metadata = tool_info(args.ffmpeg)

source = Path(args.source)
output = Path(args.output)
recipe = json.loads((source / 'render-recipe.json').read_text(encoding='utf-8'))
output.mkdir(parents=True, exist_ok=True)

def render_voice(voice):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(source / 'model_quantized.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    styles = np.fromfile(source / (voice['id'] + '.bin'), dtype=np.float32)
    chunks = []
    segments = {}
    cursor = 0
    for index, segment in enumerate(recipe['segments']):
        started = time.perf_counter()
        ids = np.array([segment['ids']], dtype=np.int64)
        offset = 256 * min(ids.shape[-1] - 2, 509)
        pcm = session.run(None, {
            'input_ids': ids,
            'style': styles[offset:offset + 256].reshape(1, 256),
            'speed': np.array([voice['speed']], dtype=np.float32)
        })[0].reshape(-1)
        # Trim only the outer silence. A 20ms margin preserves consonant attacks;
        # interior pauses in complete phrases remain untouched.
        audible = np.flatnonzero(np.abs(pcm) > 0.004)
        if len(audible) == 0:
            raise ValueError('Silent voice segment: ' + voice['id'] + ' / ' + segment['key'])
        margin = 480
        pcm = pcm[max(0, int(audible[0]) - margin):min(len(pcm), int(audible[-1]) + margin + 1)]
        pcm = np.clip(pcm, -1, 1)
        encoded = np.rint(pcm * 32767).astype('<i2')
        encoded, tempo = normalize_pcm(encoded, segment['words'], args.ffmpeg)
        segments[segment['key']] = {'offset': cursor, 'length': len(encoded), 'words': segment['words'], 'tempo': tempo}
        cursor += len(encoded)
        chunks.append(encoded)
        if (index + 1) % 5 == 0 or index == 0 or index + 1 == len(recipe['segments']):
            print(json.dumps({'voice': voice['id'], 'rendered': index + 1, 'total': len(recipe['segments']), 'lastSeconds': round(time.perf_counter() - started, 2)}), flush=True)
    bank = np.concatenate(chunks)
    filename = voice['id'] + '.wav'
    with wave.open(str(output / filename), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(bank.tobytes())
    return voice['id'], {'file': filename, 'sampleRate': 24000, 'speed': voice['speed'], 'segments': segments}

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    rendered = dict(pool.map(render_voice, recipe['voices']))
index = {'version': 'qgh-pilot-kokoro-clips-en-2', 'sampleRate': 24000, 'targetWPM': 100, 'voices': rendered,
         'phrases': [segment['key'] for segment in recipe['segments'] if segment['kind'] == 'phrase'],
         'modelRevision': recipe['modelRevision'], 'recipeSha256': hashlib.sha256((source / 'render-recipe.json').read_bytes()).hexdigest(),
         'tempoNormalization': tempo_metadata}
(output / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'done': True, 'voices': len(rendered), 'segmentsPerVoice': len(recipe['segments'])}), flush=True)
