[CmdletBinding()]
param(
    [ValidateSet('All', 'Android', 'Windows')]
    [string]$Target = 'All'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$availableRoots = @{
    Android = Join-Path $repoRoot 'apps\android\app\src\main\assets'
    Windows = Join-Path $repoRoot 'apps\windows\app'
}
$engineRoots = [ordered]@{
    Shared = Join-Path $repoRoot 'packages\qgh-engine'
}
$engineFiles = @(
    'index.html',
    'entry.css',
    'user-guide.html',
    'single.html',
    'simulator-core.js',
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
    'fonts\ibm-plex-mono-500.ttf',
    'fonts\ibm-plex-sans-400.ttf',
    'fonts\ibm-plex-sans-600.ttf',
    'fonts\OFL-1.1.txt',
    'vendor\vosk-browser-0.0.8.js',
    'vendor\Apache-2.0.txt',
    'voice-models\qgh-vosk-en-us-small-0.15.tar.gz',
    'voice-models\NOTICE.txt'
)

$selectedTargets = if ($Target -eq 'All') {
    @('Android', 'Windows')
} else {
    @($Target)
}

foreach ($targetName in $selectedTargets) {
    $engineRoots[$targetName] = $availableRoots[$targetName]
}

$mismatches = [System.Collections.Generic.List[string]]::new()

foreach ($relativeFile in $engineFiles) {
    $hashes = @{}
    foreach ($name in $engineRoots.Keys) {
        $candidate = Join-Path $engineRoots[$name] $relativeFile
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $mismatches.Add("$name is missing $relativeFile")
            continue
        }
        $hashes[$name] = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    }

    if ($hashes.Count -eq $engineRoots.Count) {
        $uniqueHashes = @($hashes.Values | Select-Object -Unique)
        if ($uniqueHashes.Count -ne 1) {
            $mismatches.Add("$relativeFile differs between platform bundles")
        }
    }

    $report = [ordered]@{ File = $relativeFile }
    foreach ($name in $engineRoots.Keys) {
        $report[$name] = $hashes[$name]
    }
    [PSCustomObject]$report
}

if ($mismatches.Count -gt 0) {
    $mismatches | ForEach-Object { Write-Error $_ }
    throw 'Shared engine verification failed. Run .\scripts\Sync-WebAssets.ps1 for the affected target and verify the result.'
}

Write-Output "Shared engine verification passed for $($selectedTargets -join ', ')."
