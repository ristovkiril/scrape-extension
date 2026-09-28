# Packages the extension into dist/ingatlan-exporter-<version>.zip for the Chrome Web Store.
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File .\build.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$version = (Get-Content "$root\manifest.json" -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$zipPath = Join-Path $dist "ingatlan-exporter-$version.zip"

# Only what the extension needs at runtime.
$include = @('manifest.json', 'icons', 'lib', 'popup', 'src')

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($item in $include) {
    $full = Join-Path $root $item
    $files = if ((Get-Item $full).PSIsContainer) { Get-ChildItem $full -Recurse -File } else { Get-Item $full }
    foreach ($f in $files) {
      # Forward slashes: the Chrome Web Store rejects zip entries with backslashes.
      $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entry, 'Optimal') | Out-Null
    }
  }
} finally {
  $zip.Dispose()
}

Write-Host "Created $zipPath"
