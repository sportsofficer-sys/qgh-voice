// The application plays locally rendered Kokoro segments. Neural inference is
// performed only by the maintenance renderer, never on a trainee's device.
export const VOICE_IDS = Object.freeze(['am_michael', 'am_fenrir', 'am_puck', 'bm_george']);
export const SAMPLE_RATE = 24000;
const PACK_ROOT = new URL('../../pilot-voices/', import.meta.url);
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export function normalize(text) {
  return String(text).normalize('NFKC').toLowerCase()
    .replace(/(\d)\.(?=\d)/g, '$1 decimal ')
    .replace(/\d/g, digit => ` ${DIGITS[Number(digit)]} `)
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function selectSegments(text, index) {
  const words = normalize(text).split(' ').filter(Boolean);
  const phrases = index.phrases.map(key => ({ key, words: key.split(' ') }))
    .sort((a, b) => b.words.length - a.words.length);
  const selected = [];
  for (let position = 0; position < words.length;) {
    const match = phrases.find(phrase => phrase.words.every((word, offset) => words[position + offset] === word));
    if (match) {
      selected.push(match.key);
      position += match.words.length;
    } else {
      // Unknown names are spelled using all their English letter names.
      for (const letter of words[position]) selected.push(`letter:${letter}`);
      position += 1;
    }
  }
  if (!selected.length) throw new Error('Pilot transmission has no speakable text.');
  return selected;
}

export function decodeBank(buffer) {
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (view.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Invalid bundled pilot audio.');
  let data = null;
  let format = false;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > view.byteLength) throw new Error('Incomplete bundled pilot audio.');
    if (tag(offset) === 'fmt ') {
      format = size >= 16 && view.getUint16(offset + 8, true) === 1
        && view.getUint16(offset + 10, true) === 1 && view.getUint32(offset + 12, true) === SAMPLE_RATE
        && view.getUint16(offset + 22, true) === 16;
    } else if (tag(offset) === 'data') data = { offset: offset + 8, size };
    offset += 8 + size + size % 2;
  }
  if (!format || !data || data.size % 2) throw new Error('Unsupported bundled pilot audio format.');
  const samples = new Float32Array(data.size / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(data.offset + i * 2, true) / 32768;
  return samples;
}

export function assemble(text, voice, index, bank) {
  const selected = selectSegments(text, index);
  const segments = selected.map(key => {
    const segment = index.voices[voice]?.segments[key];
    if (!segment || !Number.isInteger(segment.offset) || !Number.isInteger(segment.length)
      || segment.offset < 0 || segment.length < 1 || segment.offset + segment.length > bank.length) {
      throw new Error(`Missing bundled pilot segment: ${key}`);
    }
    return segment;
  });
  const samplesLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const spokenWords = segments.reduce((sum, segment) => sum + segment.words, 0);
  // Fill inter-segment pauses toward 100 WPM. Playback keeps its natural pitch.
  const targetLength = Math.ceil(spokenWords * 60 / 100 * SAMPLE_RATE);
  const gapCount = Math.max(0, segments.length - 1);
  const gap = gapCount ? Math.max(720, Math.min(7200, Math.round((targetLength - samplesLength) / gapCount))) : 0;
  const total = samplesLength + gap * gapCount;
  if (total > SAMPLE_RATE * 90) throw new Error('Pilot transmission is too long.');
  const samples = new Float32Array(total);
  let offset = 0;
  for (const segment of segments) {
    samples.set(bank.subarray(segment.offset, segment.offset + segment.length), offset);
    offset += segment.length + gap;
  }
  return { samples, sampleRate: SAMPLE_RATE };
}

export async function loadRuntime(onProgress) {
  const response = await fetch(new URL('index.json', PACK_ROOT), { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Bundled pilot voice index is missing.');
  const index = await response.json();
  if (index.sampleRate !== SAMPLE_RATE || !Array.isArray(index.phrases)) throw new Error('Invalid pilot voice index.');
  for (const voice of VOICE_IDS) {
    if (index.voices?.[voice]?.file !== `${voice}.wav`) throw new Error('Invalid pilot voice bank path.');
  }
  const banks = new Map();
  const pending = new Map();
  let loading = Promise.resolve();
  function loadBank(voice) {
    if (!VOICE_IDS.includes(voice)) return Promise.reject(new Error('Unknown bundled pilot voice.'));
    if (banks.has(voice)) return Promise.resolve(banks.get(voice));
    if (pending.has(voice)) return pending.get(voice);
    // Keep only one encoded bank in flight while retaining successfully decoded voices.
    const request = loading.then(async () => {
      const audio = await fetch(new URL(`${voice}.wav`, PACK_ROOT), { credentials: 'same-origin' });
      if (!audio.ok) throw new Error(`Bundled pilot voice is missing: ${voice}`);
      const bank = decodeBank(await audio.arrayBuffer());
      banks.set(voice, bank);
      return bank;
    });
    pending.set(voice, request);
    // A failed voice can be retried and must not block the next queued voice.
    loading = request.then(() => { pending.delete(voice); }, () => { pending.delete(voice); });
    return request;
  }
  // The headphone check uses Michael; other profiles load on their first transmission.
  onProgress?.({ phase: 'loading', loaded: 0, total: 1 });
  await loadBank(VOICE_IDS[0]);
  onProgress?.({ phase: 'loading', loaded: 1, total: 1 });
  return Object.freeze({
    async generate(text, voice) {
      return assemble(text, voice, index, await loadBank(voice));
    }
  });
}
