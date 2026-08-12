param(
  [switch]$DryRun,
  [ValidateSet("auto", "bun", "node")]
  [string]$Runtime
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PackageName = "@moretea-labs/forge"
$PackageVersion = if ($env:FORGE_VERSION) { $env:FORGE_VERSION } else { "next" }
$InstallRuntime = if ($Runtime) { $Runtime.ToLowerInvariant() } elseif ($env:FORGE_INSTALL_RUNTIME) { $env:FORGE_INSTALL_RUNTIME.ToLowerInvariant() } else { "auto" }
$MinimumNodeVersion = [version]"20.10.0"
$BunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME ".bun" }
$BunBin = Join-Path $BunInstall "bin"
function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Add-PathEntry([string]$PathEntry) { if ($PathEntry -and (Test-Path $PathEntry)) { $entries = $env:PATH -split [System.IO.Path]::PathSeparator; if ($entries -notcontains $PathEntry) { $env:PATH = "$PathEntry$([System.IO.Path]::PathSeparator)$env:PATH" } } }
function Refresh-InstallerPath { Add-PathEntry $BunBin; if ($env:APPDATA) { Add-PathEntry (Join-Path $env:APPDATA "npm") }; if (Test-Command "npm") { $npmPrefix = (& npm config get prefix 2>$null | Select-Object -First 1).Trim(); Add-PathEntry $npmPrefix } }
function Assert-Prerequisites {
  if ($PSVersionTable.PSVersion -lt [version]"5.1") { throw "PowerShell 5.1 or newer is required. PowerShell 7 is recommended." }
  if (-not (Test-Command "node")) { throw "Node.js 20.10 or newer is required because the published Forge launcher uses Node." }
  $nodeText = (& node -p "process.versions.node").Trim(); if ($LASTEXITCODE -ne 0 -or -not $nodeText) { throw "Node.js is present, but its version could not be read." }
  if ([version]$nodeText -lt $MinimumNodeVersion) { throw "Node.js 20.10 or newer is required; found $nodeText." }
}
function Install-BunIfNeeded { if (Test-Command "bun") { return }; Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression; Refresh-InstallerPath; if (-not (Test-Command "bun")) { throw "Bun installation completed, but bun is still not on PATH." } }
function Select-InstallRuntime {
  switch ($InstallRuntime) {
    "bun" { Install-BunIfNeeded; return "bun" }
    "node" { if (-not (Test-Command "npm")) { throw "npm is required for FORGE_INSTALL_RUNTIME=node." }; return "node" }
    "auto" { if (Test-Command "bun") { return "bun" }; if (Test-Command "npm") { return "node" }; throw "Neither Bun nor npm is available." }
    default { throw "Invalid FORGE_INSTALL_RUNTIME=$InstallRuntime. Expected auto, bun, or node." }
  }
}
if ($DryRun -or $env:FORGE_DRY_RUN -eq "1") { Write-Host "DRY RUN: would require Node.js 20.10+ and npm/Bun, install $PackageName@$PackageVersion, and verify the Forge CLI. Git is optional until repository features are enabled."; exit 0 }
Refresh-InstallerPath
Assert-Prerequisites
$Runtime = Select-InstallRuntime
$PackageSpec = "$PackageName@$PackageVersion"
if ($Runtime -eq "bun") { & bun add -g $PackageSpec } else { & npm install -g $PackageSpec --omit=optional --no-audit --no-fund }
if ($LASTEXITCODE -ne 0) { throw "Package installation failed with exit code $LASTEXITCODE." }
Refresh-InstallerPath
if (-not (Test-Command "forge")) { throw "forge is not on PATH after installation." }
$Version = (& forge --version | Select-Object -First 1).Trim(); if ($LASTEXITCODE -ne 0 -or -not $Version) { throw "Forge installed, but version readback failed." }
& forge doctor --help *> $null; if ($LASTEXITCODE -ne 0) { throw "Forge installed, but the doctor command could not be loaded." }
Write-Host "Forge $Version installed."
Write-Host "Next:"
Write-Host "  forge setup"
Write-Host ""
Write-Host "Git is only needed when you enable repository/software-work features."
