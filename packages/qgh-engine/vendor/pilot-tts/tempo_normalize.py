"""Build-only, pitch-preserving normalization of the existing PCM speech clips."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import wave

import numpy as np

SAMPLE_RATE = 24000
TARGET_WPM = 100
MAX_DRIFT = 720  # at most 30ms of final silence; never cut a voiced ending.
FFMPEG_SHA256 = '2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3'

def run(command, **options):
    return subprocess.run(command, check=True, capture_output=True, timeout=30,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0, **options)

def tool_info(ffmpeg):
    binary = Path(ffmpeg)
    fingerprint = hashlib.sha256(binary.read_bytes()).hexdigest()
    if fingerprint != FFMPEG_SHA256:
        raise ValueError('Use the pinned FFmpeg 7.1 binary supplied by imageio-ffmpeg==0.6.0 for this render recipe.')
    version = run([str(binary), '-version']).stdout.decode('utf-8').splitlines()[0]
    return {'tool': version, 'sha256': fingerprint, 'method': 'atempo', 'targetWPM': TARGET_WPM,
            'minFactor': 0.5, 'maxFactor': 2.0, 'maxPaddingSamples': MAX_DRIFT}

def normalize_pcm(pcm, words, ffmpeg):
    target = round(words * 60 / TARGET_WPM * SAMPLE_RATE)
    factor = len(pcm) / target
    if not 0.5 <= factor <= 2.0:
        raise ValueError('Speech segment needs an excessive tempo change: ' + str(factor))
    original_factor = factor
    source = np.asarray(pcm, dtype='<i2').tobytes()
    for attempt in range(8):
        if not 0.5 <= factor <= 2.0:
            raise ValueError('Tempo correction exceeded the conservative stretch range.')
        command = [str(ffmpeg), '-hide_banner', '-loglevel', 'error', '-nostdin',
                   '-threads', '1', '-filter_threads', '1', '-f', 's16le', '-ar', str(SAMPLE_RATE),
                   '-ac', '1', '-i', 'pipe:0', '-af', 'atempo=' + format(factor, '.12g'),
                   '-f', 's16le', '-ar', str(SAMPLE_RATE), '-ac', '1', 'pipe:1']
        output = np.frombuffer(run(command, input=source).stdout, dtype='<i2').copy()
        drift = len(output) - target
        tail_is_silent = drift <= 0 or np.max(np.abs(output[target:].astype(np.int32)), initial=0) <= 131
        if abs(drift) <= MAX_DRIFT and tail_is_silent:
            if drift > 0:
                output = output[:target]
            elif drift < 0:
                output = np.pad(output, (0, -drift))
            return output.astype('<i2'), {'sourceSamples': len(pcm), 'nominalFactor': original_factor,
                                          'appliedFactor': factor, 'silenceAdjustmentSamples': -drift,
                                          'passes': attempt + 1}
        # FFmpeg's overlap windows can produce a small duration discrepancy.
        # Re-run from the original PCM, targeting a slight shortfall that can
        # safely be padded. Do not repeatedly transform already processed audio.
        factor *= len(output) / max(1, target - 120)
    raise ValueError('Could not reach target duration without trimming voiced audio.')

def normalize_banks(input_dir, output_dir, recipe_path, ffmpeg):
    input_dir, output_dir = Path(input_dir).resolve(), Path(output_dir).resolve()
    if input_dir == output_dir:
        raise ValueError('Preserve raw banks in a separate input directory before normalization.')
    index = json.loads((input_dir / 'index.json').read_text(encoding='utf-8'))
    recipe_bytes = Path(recipe_path).read_bytes()
    recipe = json.loads(recipe_bytes)
    metadata = tool_info(ffmpeg)
    metadata['sourceBanks'] = []
    metadata['segments'] = 0
    result = copy.deepcopy(index)
    all_factors = []
    output_dir.mkdir(parents=True, exist_ok=True)
    for voice in recipe['voices']:
        voice_id = voice['id']
        entry = index['voices'][voice_id]
        file = input_dir / entry['file']
        metadata['sourceBanks'].append({'file': entry['file'], 'bytes': file.stat().st_size,
                                       'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
        with wave.open(str(file), 'rb') as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError('Unexpected source bank audio format.')
            bank = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
        chunks, segments = [], {}
        cursor = 0
        for count, segment in enumerate(recipe['segments'], 1):
            raw = entry['segments'][segment['key']]
            if raw['words'] != segment['words']:
                raise ValueError('Recipe words changed for ' + segment['key'])
            pcm = bank[raw['offset']:raw['offset'] + raw['length']]
            adjusted, proof = normalize_pcm(pcm, segment['words'], ffmpeg)
            segments[segment['key']] = {'offset': cursor, 'length': len(adjusted), 'words': segment['words'],
                                        'tempo': proof}
            cursor += len(adjusted)
            chunks.append(adjusted)
            all_factors.append(proof['appliedFactor'])
            metadata['segments'] += 1
            if count % 20 == 0 or count == len(recipe['segments']):
                print(json.dumps({'voice': voice_id, 'normalized': count, 'total': len(recipe['segments'])}), flush=True)
        with wave.open(str(output_dir / entry['file']), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(SAMPLE_RATE)
            audio.writeframes(np.concatenate(chunks).tobytes())
        result['voices'][voice_id]['segments'] = segments
    metadata['observedFactorRange'] = [min(all_factors), max(all_factors)]
    result['version'] = 'qgh-pilot-kokoro-clips-en-2'
    result['tempoNormalization'] = metadata
    result['recipeSha256'] = hashlib.sha256(recipe_bytes).hexdigest()
    (output_dir / 'index.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'normalized': metadata['segments'], 'factorRange': metadata['observedFactorRange']}), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--recipe', required=True)
    parser.add_argument('--ffmpeg', required=True)
    args = parser.parse_args()
    normalize_banks(args.input, args.output, args.recipe, args.ffmpeg)
