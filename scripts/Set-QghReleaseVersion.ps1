[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')]
    [string]$Version,

    [Parameter(Mandatory)]
    [ValidateRange(1, 2147483647)]
    [int]$AndroidVersionCode,

    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$Updated = (Get-Date -Format 'yyyy-MM-dd')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webVersionPath = Join-Path $repositoryRoot 'apps\web\static\app-version.json'
$windowsPackagePath = Join-Path $repositoryRoot 'apps\windows\package.json'
$androidBuildPath = Join-Path $repositoryRoot 'apps\android\app\build.gradle.kts'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

try {
    $webReleaseText = [System.IO.File]::ReadAllText($webVersionPath)
    $windowsPackage = [System.IO.File]::ReadAllText($windowsPackagePath)
    $androidBuild = [System.IO.File]::ReadAllText($androidBuildPath)
} catch {
    throw "Could not read QGH release metadata: $($_.Exception.Message)"
}

try {
    $webRelease = $webReleaseText | ConvertFrom-Json -ErrorAction Stop
    $windowsPackage | ConvertFrom-Json -ErrorAction Stop | Out-Null
} catch {
    throw "Could not parse QGH release metadata: $($_.Exception.Message)"
}

if ($webRelease.name -ne 'QGH Simulator') {
    throw 'The PWA release metadata has an unexpected application name.'
}

$webRelease | Add-Member -NotePropertyName 'version' -NotePropertyValue $Version -Force
$webRelease | Add-Member -NotePropertyName 'androidVersionCode' -NotePropertyValue $AndroidVersionCode -Force
$webRelease | Add-Member -NotePropertyName 'updated' -NotePropertyValue $Updated -Force
$webReleaseJson = $webRelease | ConvertTo-Json -Depth 16

if ($windowsPackage -notmatch '(?m)^  "version":\s*"[^"]+",$') {
    throw 'Could not find the Windows package version field.'
}
$updatedWindowsPackage = $windowsPackage -replace '(?m)^  "version":\s*"[^"]+",$', ('  "version": "' + $Version + '",')

if ($androidBuild -notmatch '(?m)^\s*versionCode\s*=\s*\d+\s*$' -or
    $androidBuild -notmatch '(?m)^\s*versionName\s*=\s*"[^"]+"\s*$') {
    throw 'Could not find Android versionCode and versionName fields.'
}
$updatedAndroidBuild = [regex]::Replace(
    $androidBuild,
    '(?m)^(\s*versionCode\s*=\s*)\d+\s*$',
    {
        param($match)
        $match.Groups[1].Value + $AndroidVersionCode
    }
)
$updatedAndroidBuild = [regex]::Replace(
    $updatedAndroidBuild,
    '(?m)^(\s*versionName\s*=\s*)"[^"]+"\s*$',
    {
        param($match)
        $match.Groups[1].Value + '"' + $Version + '"'
    }
)

$originalContents = [ordered]@{
    $webVersionPath = $webReleaseText
    $windowsPackagePath = $windowsPackage
    $androidBuildPath = $androidBuild
}

try {
    [System.IO.File]::WriteAllText(
        $webVersionPath,
        $webReleaseJson + [Environment]::NewLine,
        $utf8NoBom
    )
    [System.IO.File]::WriteAllText($windowsPackagePath, $updatedWindowsPackage, $utf8NoBom)
    [System.IO.File]::WriteAllText($androidBuildPath, $updatedAndroidBuild, $utf8NoBom)
} catch {
    $writeError = $_
    foreach ($entry in $originalContents.GetEnumerator()) {
        try {
            [System.IO.File]::WriteAllText($entry.Key, $entry.Value, $utf8NoBom)
        } catch {
            Write-Warning "Could not restore $($entry.Key)."
        }
    }
    throw "Could not save QGH release metadata; attempted to restore the original values. $($writeError.Exception.Message)"
}

Write-Output "QGH release metadata set to v$Version (Android versionCode $AndroidVersionCode)."
