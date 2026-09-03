import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

test('release version stays aligned across PWA, Windows, and Android', () => {
  execFileSync(
    process.execPath,
    [resolve(repositoryRoot, 'scripts', 'verify-release-version.mjs')],
    { cwd: repositoryRoot, stdio: 'pipe' }
  );
});

test('release version guard rejects an empty prerelease identifier', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'qgh-release-version-'));

  try {
    const webDirectory = join(fixtureRoot, 'apps', 'web', 'static');
    const windowsDirectory = join(fixtureRoot, 'apps', 'windows');
    const androidDirectory = join(fixtureRoot, 'apps', 'android', 'app');
    mkdirSync(webDirectory, { recursive: true });
    mkdirSync(windowsDirectory, { recursive: true });
    mkdirSync(androidDirectory, { recursive: true });

    const malformedRelease = JSON.parse(readFileSync(
      resolve(repositoryRoot, 'apps', 'web', 'static', 'app-version.json'),
      'utf8'
    ));
    malformedRelease.version = '4.0.2-a..b';

    writeFileSync(
      join(webDirectory, 'app-version.json'),
      JSON.stringify(malformedRelease, null, 2) + '\n'
    );
    writeFileSync(
      join(windowsDirectory, 'package.json'),
      readFileSync(resolve(repositoryRoot, 'apps', 'windows', 'package.json'))
    );
    writeFileSync(
      join(androidDirectory, 'build.gradle.kts'),
      readFileSync(resolve(repositoryRoot, 'apps', 'android', 'app', 'build.gradle.kts'))
    );

    assert.throws(
      () => execFileSync(
        process.execPath,
        [resolve(repositoryRoot, 'scripts', 'verify-release-version.mjs')],
        {
          cwd: repositoryRoot,
          env: { ...process.env, QGH_RELEASE_VALIDATION_ROOT: fixtureRoot },
          stdio: 'pipe',
        }
      ),
      /must contain a semantic release version/
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test(
  'PowerShell release updater rejects an empty prerelease identifier',
  { skip: process.platform !== 'win32' },
  () => {
    assert.throws(
      () => execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve(repositoryRoot, 'scripts', 'Set-QghReleaseVersion.ps1'),
          '-Version',
          '4.0.2-a..b',
          '-AndroidVersionCode',
          '12',
        ],
        { cwd: repositoryRoot, stdio: 'pipe' }
      ),
      (error) => /Cannot validate argument on\s+parameter 'Version'/i.test(
        error.stderr?.toString() ?? ''
      )
    );
  }
);
