import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = process.env.QGH_RELEASE_VALIDATION_ROOT
  ? resolve(process.env.QGH_RELEASE_VALIDATION_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(readFileSync(
  resolve(repositoryRoot, 'apps', 'web', 'static', 'app-version.json'),
  'utf8'
));
const windowsPackage = JSON.parse(readFileSync(
  resolve(repositoryRoot, 'apps', 'windows', 'package.json'),
  'utf8'
));
const androidBuild = readFileSync(
  resolve(repositoryRoot, 'apps', 'android', 'app', 'build.gradle.kts'),
  'utf8'
);

// SemVer 2.0.0: prerelease and build identifiers are non-empty dot-separated parts.
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const androidName = androidBuild.match(/versionName\s*=\s*"([^"]+)"/);
const androidCode = androidBuild.match(/versionCode\s*=\s*(\d+)/);

if (!versionPattern.test(release.version)) {
  throw new Error('apps/web/static/app-version.json must contain a semantic release version.');
}

if (!Number.isInteger(release.androidVersionCode) || release.androidVersionCode < 1) {
  throw new Error('apps/web/static/app-version.json must contain a positive androidVersionCode.');
}

if (!androidName || !androidCode) {
  throw new Error('Could not read Android versionName and versionCode from app/build.gradle.kts.');
}

const mismatches = [
  {
    label: 'Windows package version',
    actual: windowsPackage.version,
    expected: release.version,
  },
  {
    label: 'Android versionName',
    actual: androidName[1],
    expected: release.version,
  },
  {
    label: 'Android versionCode',
    actual: Number(androidCode[1]),
    expected: release.androidVersionCode,
  },
].filter(({ actual, expected }) => actual !== expected);

if (mismatches.length > 0) {
  const details = mismatches
    .map(({ label, actual }) => label + ' is ' + actual)
    .join('; ');
  throw new Error(
    'Cross-platform release versions are not aligned with PWA ' +
    release.version + ': ' + details + '.'
  );
}

console.log(
  'QGH release versions aligned: v' + release.version +
  ' (Android versionCode ' + release.androidVersionCode + ').'
);
