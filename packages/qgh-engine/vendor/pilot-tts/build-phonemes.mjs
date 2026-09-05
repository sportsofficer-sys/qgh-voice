// Maintenance-only pronunciation helper. The model's input convention follows
// kokoro-js 1.2.1 (Apache-2.0); phonemes come from CMUdict (BSD-2-Clause).
// No eSpeak, phonemizer.js, Transformers.js, system voices or remote inference.

export const VOICE_IDS = Object.freeze(['am_michael', 'am_fenrir', 'am_puck', 'bm_george']);
export const SAMPLE_RATE = 24000;
const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
const ARPA_IPA = Object.freeze({
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ',
  D: 'd', DH: 'ð', EH: 'ɛ', ER: 'ɜɹ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h',
  IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ',
  OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ',
  UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ'
});
const AVIATION = Object.freeze({
  // Aviation pronunciations, spelling alphabet and abbreviations absent from CMUdict.
  alfa: 'ˈælfə', juliett: 'dʒuːliˈɛt', niner: 'nˈaɪnəɹ', fife: 'fˈaɪf', tree: 'tɹˈi',
  qgh: 'kjˈu dʒˈi ˈeɪtʃ', qdm: 'kjˈu dˈi ˈɛm', qte: 'kjˈu tˈi ˈi',
  qnh: 'kjˈu ˈɛn ˈeɪtʃ', qfe: 'kjˈu ˈɛf ˈi', df: 'dˈi ˈɛf',
  dme: 'dˈi ˈɛm ˈi', nm: 'nˈɔtɪkəl mˈaɪlz', kt: 'nˈɑts', kts: 'nˈɑts',
  aerodrome: 'ˈɛɹədɹoʊm', octas: 'ˈɑktəz', roger: 'ɹˈɑdʒəɹ',
  simulated: 'sˈɪmjəleɪtɪd', orbiting: 'ˈɔɹbɪtɪŋ', resuming: 'ɹɪzˈumɪŋ',
  transmitting: 'tɹænzmˈɪtɪŋ', nautical: 'nˈɔtɪkəl'
});
const LETTERS = Object.freeze([
  'ˈeɪ', 'bˈi', 'sˈi', 'dˈi', 'ˈi', 'ˈɛf', 'dʒˈi', 'ˈeɪtʃ', 'ˈaɪ',
  'dʒˈeɪ', 'kˈeɪ', 'ˈɛl', 'ˈɛm', 'ˈɛn', 'ˈoʊ', 'pˈi', 'kjˈu', 'ˈɑɹ',
  'ˈɛs', 'tˈi', 'jˈu', 'vˈi', 'dˈʌbəl jˈu', 'ˈɛks', 'wˈaɪ', 'zˈi'
]);
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export function parseDictionary(text) {
  const dictionary = new Map();
  for (const line of text.split(/\r?\n/)) {
    const split = line.indexOf(' ');
    if (split < 1) continue;
    const word = line.slice(0, split);
    if (word.includes('(') || dictionary.has(word)) continue;
    dictionary.set(word, line.slice(split + 1).split(' #')[0].trim());
  }
  return dictionary;
}

export function arpaToIPA(pronunciation) {
  return pronunciation.split(/\s+/).map(phone => {
    const base = phone.replace(/[012]$/, '');
    let sound = ARPA_IPA[base];
    if (!sound) throw new Error(`Unsupported pronunciation symbol: ${phone}`);
    if (phone === 'AH0') sound = 'ə';
    if (phone === 'ER0') sound = 'əɹ';
    const stress = VOWELS.has(base) ? (phone.endsWith('1') ? 'ˈ' : phone.endsWith('2') ? 'ˌ' : '') : '';
    return stress + sound;
  }).join('');
}

export function phonemize(text, dictionary) {
  const normalized = String(text).normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d)\.(?=\d)/g, '$1 decimal ')
    .replace(/\d/g, digit => ` ${DIGITS[Number(digit)]} `)
    .replace(/d\s*\/\s*f/g, 'df');
  const words = normalized.match(/[a-z]+(?:'[a-z]+)?|[;:,.!?]/g) || [];
  return words.map(word => {
    if (/^[;:,.!?]$/.test(word)) return word;
    if (AVIATION[word]) return AVIATION[word];
    if (dictionary.has(word)) return arpaToIPA(dictionary.get(word));
    // Callsigns are user-entered. Unknown names retain every letter in stable
    // spoken spelling rather than disappearing or receiving a guessed word.
    return Array.from(word.replace(/'/g, ''), letter => LETTERS[letter.charCodeAt(0) - 97]).join(' ');
  }).join(' ').replace(/\s+([;:,.!?])/g, '$1').trim();
}

export function tokenize(phonemes, vocabulary) {
  const symbols = Array.from(phonemes);
  if (!symbols.length || symbols.length > 510) throw new Error('Pilot transmission exceeds the local voice model limit.');
  const ids = symbols.map(symbol => {
    if (!Object.hasOwn(vocabulary, symbol)) throw new Error(`Unsupported pilot phoneme: ${symbol}`);
    return vocabulary[symbol];
  });
  return BigInt64Array.from([0, ...ids, 0], BigInt);
}
