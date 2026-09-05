import { loadRuntime } from './vendor/pilot-tts/runtime.mjs';

let runtime = null;
let preparing = null;
let latest = 0;
let pending = null;
let generating = false;

function prepare() {
  if (runtime) return Promise.resolve(runtime);
  if (!preparing) preparing = loadRuntime(progress => self.postMessage({ type: 'progress', progress }))
    .then(loaded => { runtime = loaded; return runtime; })
    .catch(error => { preparing = null; throw error; });
  return preparing;
}

async function drain() {
  if (generating) return;
  generating = true;
  try {
    while (pending) {
      const request = pending;
      pending = null;
      try {
        if (!runtime) throw new Error('Pilot voice pack has not been prepared.');
        const result = await runtime.generate(request.text, request.voice);
        if (request.token === latest) self.postMessage({ type: 'audio', token: request.token, ...result }, [result.samples.buffer]);
      } catch (error) {
        if (request.token === latest) self.postMessage({ type: 'error', token: request.token, error: error.message });
      }
    }
  } finally { generating = false; }
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'prepare') {
    prepare().then(() => self.postMessage({ type: 'ready' }))
      .catch(error => self.postMessage({ type: 'error', error: error.message }));
  } else if (message.type === 'cancel') {
    latest = message.token;
    pending = null;
  } else if (message.type === 'speak') {
    latest = message.token;
    pending = message;
    void drain();
  }
};
