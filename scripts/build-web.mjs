import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = resolve(repositoryRoot, 'packages', 'qgh-engine');
const webRoot = resolve(repositoryRoot, 'apps', 'web');
const staticRoot = resolve(webRoot, 'static');
const outputRoot = resolve(webRoot, 'dist');

const engineFiles = [
  'index.html',
  'entry.css',
  'user-guide.html',
  'rt-reference.md',
  'single.html',
  'simulator-core.js',
  'radio-session.js',
  'radio-workspace.js',
  'headphone-consent.js',
  'pilot-voice-engine.js',
  'pilot-voice-worker.js',
  'pilot-voices/manifest.json',
  'simulator.js',
  'voice-control.js',
  'offline-voice-engine.js',
  'voice-workspace.js',
  'voice.css',
  'guided-familiarisation.js',
  'guided-familiarisation.css',
  'workspace.css',
  'workspace.js',
  'tactical.html',
  'tactical.css',
  'tactical-core.js',
  'tactical-workspace.js',
  'tactical-simulator.js',
  'fonts/ibm-plex-mono-500.ttf',
  'fonts/ibm-plex-sans-400.ttf',
  'fonts/ibm-plex-sans-600.ttf',
  'fonts/OFL-1.1.txt',
  'vendor/vosk-browser-0.0.8.js',
  'vendor/Apache-2.0.txt',
  'voice-models/qgh-vosk-en-us-small-0.15.tar.gz',
  'voice-models/NOTICE.txt',
];

const pageFiles = ['index.html', 'user-guide.html', 'single.html', 'tactical.html'];
const pwaFiles = [
  'manifest.webmanifest',
  'service-worker.js',
  'pwa-register.js',
  'web-environment.js',
  'web-distribution.js',
  'release-links.js',
  'pwa.css',
  'app-version.json',
  '_headers',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const webHead = version => `
  <!-- QGH_WEB_HEAD -->
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Reds QGH">
  <meta property="og:title" content="Reds QGH Simulator">
  <meta property="og:description" content="Offline single-aircraft and tactical QGH training simulator.">
  <link rel="stylesheet" href="pwa.css?v=${version}">
`;

const webDistribution = version => `
        <!-- QGH_WEB_DISTRIBUTION -->
        <section class="entry-web-distribution" id="webDistribution" aria-label="Install and downloads" hidden>
          <div class="entry-web-distribution-head">
            <span>QGH SIMULATOR · WEB APP</span>
            <small id="webVersion">VERSION ${version}</small>
          </div>
          <div class="entry-web-grid">
            <button class="entry-web-install" id="installWebApp" type="button">INSTALL QGH ON THIS DEVICE</button>
            <div class="entry-native-downloads" id="nativeDownloads" hidden>
              <a id="downloadWindows" href="#" target="_blank" rel="noopener noreferrer" hidden>WINDOWS INSTALLER</a>
              <a id="downloadAndroid" href="#" target="_blank" rel="noopener noreferrer" hidden>ANDROID APK</a>
            </div>
          </div>
          <p class="entry-release-availability" id="releaseAvailability">Native downloads are added with the public release.</p>
        </section>
        <dialog class="pwa-install-sheet" id="pwaInstallSheet" aria-labelledby="pwaInstallTitle">
          <div class="pwa-install-sheet-card">
            <button class="pwa-install-close" id="closeInstallSheet" type="button" aria-label="Close install instructions">×</button>
            <span>QGH WEB APP</span>
            <h2 id="pwaInstallTitle">Install QGH Simulator</h2>
            <div id="pwaInstallContent"></div>
          </div>
        </dialog>
`;

function assertReplaced(html, target, replacement, pageName) {
  if (!html.includes(target)) {
    throw new Error(`Could not locate the expected ${pageName} insertion point.`);
  }
  return html.replace(target, replacement);
}

function addPwaMarkup(pageName, source, version) {
  // The simulator's shared pages intentionally use versioned asset URLs. Rewrite
  // their query strings for each PWA build so a browser cannot retain a previous
  // voice or simulator script after the service worker has updated.
  let html = source.replace(/\?v=[0-9][a-zA-Z0-9.+-]*/g, `?v=${version}`);

  if (!html.includes("worker-src 'self'")) {
    html = assertReplaced(
      html,
      "frame-src 'none'",
      "frame-src 'none'; worker-src 'self'",
      pageName
    );
  }

  if (!html.includes('QGH_WEB_HEAD')) {
    html = assertReplaced(html, '</head>', `${webHead(version)}</head>`, pageName);
  }

  if (pageName === 'index.html' && !html.includes('QGH_WEB_DISTRIBUTION')) {
    const quote = '        <p class="entry-quote">“Order in the air begins with clarity on the ground.”</p>';
    html = assertReplaced(html, quote, `${quote}${webDistribution(version)}`, pageName);
  }

  if (!html.includes('pwa-register.js')) {
    const scripts = pageName === 'index.html'
      ? `  <script defer src="web-environment.js?v=${version}"></script>\n  <script defer src="release-links.js?v=${version}"></script>\n  <script defer src="web-distribution.js?v=${version}"></script>\n  <script defer src="pwa-register.js?v=${version}"></script>\n`
      : `  <script defer src="web-environment.js?v=${version}"></script>\n  <script defer src="pwa-register.js?v=${version}"></script>\n`;
    html = assertReplaced(html, '</body>', `${scripts}</body>`, pageName);
  }

  // Older deployed workers normalize any lone ?v= query to their old cache.
  // A second release key keeps new HTML and its scripts coherent even before
  // the user activates the waiting update. The new worker caches this exact
  // current-release shape, so the same URLs remain usable offline.
  return html.replace(/\?v=[0-9][a-zA-Z0-9.+-]*(?=["'])/g, `?v=${version}&amp;release=${version}`);
}

async function copyEngineFile(relativePath) {
  const source = resolve(engineRoot, relativePath);
  const destination = resolve(outputRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyStaticFile(relativePath) {
  const source = resolve(staticRoot, relativePath);
  const destination = resolve(outputRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function readWebVersion() {
  const versionFile = resolve(staticRoot, 'app-version.json');
  const { version } = JSON.parse(await readFile(versionFile, 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) {
    throw new Error('apps/web/static/app-version.json must contain a safe semantic version string.');
  }
  return version;
}

async function applyVersionToServiceWorker(version) {
  const workerPath = resolve(outputRoot, 'service-worker.js');
  const worker = await readFile(workerPath, 'utf8');
  if (!worker.includes('__QGH_VERSION__')) {
    throw new Error('The service worker is missing its version token.');
  }
  await writeFile(workerPath, worker.replaceAll('__QGH_VERSION__', version), 'utf8');
}

async function build() {
  const version = await readWebVersion();
  const pilotPack = JSON.parse(await readFile(resolve(engineRoot, 'pilot-voices/manifest.json'), 'utf8'));
  if (!Array.isArray(pilotPack.assets) || !pilotPack.assets.length) throw new Error('Pilot voice pack manifest is empty.');
  const filesToCopy = [...engineFiles];
  const seen = new Set(filesToCopy);
  for (const asset of pilotPack.assets) {
    if (typeof asset.path !== 'string' || !/^(?:pilot-voices|vendor\/pilot-tts)\/[a-zA-Z0-9_./-]+$/.test(asset.path)
      || asset.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(asset.path)
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) {
      throw new Error('Invalid or duplicate pilot voice asset in manifest.');
    }
    const data = await readFile(resolve(engineRoot, asset.path));
    if (data.length !== asset.bytes || createHash('sha256').update(data).digest('hex') !== asset.sha256) {
      throw new Error(`Pilot voice asset checksum mismatch: ${asset.path}`);
    }
    seen.add(asset.path);
    filesToCopy.push(asset.path);
  }
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  await Promise.all(filesToCopy.map(copyEngineFile));

  await Promise.all(pwaFiles.map(copyStaticFile));
  await applyVersionToServiceWorker(version);

  await Promise.all(pageFiles.map(async pageName => {
    const pagePath = resolve(outputRoot, pageName);
    const source = await readFile(pagePath, 'utf8');
    await writeFile(pagePath, addPwaMarkup(pageName, source, version), 'utf8');
  }));

  await Promise.all([...filesToCopy, ...pwaFiles].map(async relativePath => {
    try {
      await access(resolve(outputRoot, relativePath));
    } catch {
      throw new Error(`Web build is missing required output: ${relativePath}`);
    }
  }));

  console.log(`Built QGH Simulator v${version} web package at ${outputRoot}`);
}

await build();
