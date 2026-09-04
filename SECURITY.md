# Security policy

## Scope

This repository contains an offline-first aviation-training simulator for Windows, Android, and hosted web browsers, including browser-installed PWA use on iPhone and iPad. It should not send simulator inputs, exercise results, or user information to a server.

Android and Windows packages should retain their local-only content-security policy when the shared engine is updated. The hosted PWA may cache only its same-origin application shell and, after the user explicitly selects offline voice setup, its fixed self-hosted Vosk model. Do not add exercise data, credentials, installer binaries, or arbitrary third-party responses to the service-worker cache.

The self-hosted Vosk browser adapter requires WebAssembly and its pinned worker bundle currently requires the narrowly scoped `wasm-unsafe-eval` and `unsafe-eval` script-policy allowances. Keep all scripts self-hosted, retain the remaining restrictive policy directives, and do not add external script or network origins.

## Reporting a concern

Please report suspected vulnerabilities privately to the repository owner with:

- the affected platform and version;
- clear reproduction steps;
- the possible impact; and
- a safe proof of concept, if available.

Do not include credentials, certificates, signing keys, or personal data in an issue or pull request.

## Release safeguards

- Keep all generated installers, APKs, AABs, IPAs, archives, build folders, and dependency folders out of Git.
- Never commit keystores, provisioning profiles, certificates, passwords, or local signing files.
- Run .\scripts\Verify-WebAssets.ps1 before a release to confirm the Android and Windows packages contain the same offline engine.
- Run `node .\scripts\build-web.mjs` and the full canonical-engine plus PWA test suite before a web release.
- Do not rely on a private source repository alone to protect a hosted Pages URL; apply the selected public, protected, or internal access policy before sharing it.
- Build and test each release from a clean checkout.
