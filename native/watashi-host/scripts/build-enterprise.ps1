param(
  [string]$Target = "x86_64-pc-windows-msvc",
  [string]$Profile = "release",
  [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ExeDir = Join-Path $Root "target\$Target\$Profile"
$ExePath = Join-Path $ExeDir "watashi.exe"

Write-Host "Building watashi-host for enterprise-local distribution..."
Write-Host "Target:  $Target"
Write-Host "Profile: $Profile"

Push-Location $Root
try {
  cargo build --profile $Profile --target $Target
} finally {
  Pop-Location
}

if (-not (Test-Path $ExePath)) {
  throw "Build succeeded but executable not found: $ExePath"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Version = if ($env:GITHUB_REF_NAME) { $env:GITHUB_REF_NAME } else { "local" }
$ZipName = "watashi-$Version-windows-x64-localbuild.zip"
$ZipPath = Join-Path $OutDir $ZipName
$HashPath = Join-Path $OutDir "$ZipName.sha256.txt"

if (Test-Path $ZipPath) {
  Remove-Item $ZipPath -Force
}

Compress-Archive -Path $ExePath -DestinationPath $ZipPath

$Hash = (Get-FileHash -Algorithm SHA256 $ZipPath).Hash.ToLowerInvariant()
$Hash | Set-Content -NoNewline $HashPath

Write-Host ""
Write-Host "Artifacts:"
Write-Host "  EXE:  $ExePath"
Write-Host "  ZIP:  $ZipPath"
Write-Host "  SHA:  $HashPath"
Write-Host ""
Write-Host "Next steps for enterprise deployment:"
Write-Host "  1. Sign watashi.exe or the package with the customer's internal code-signing pipeline."
Write-Host "  2. Distribute through Intune, SCCM, AppLocker allowlisting, or equivalent."
Write-Host "  3. Prefer relay/TLS mode over LAN UDP when deploying inside GlobalProtect environments."
