[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet(
        'host_status',
        'wsl_status', 'wsl_start',
        'forge_source_status', 'controller_status',
        'runtime_status', 'runtime_start', 'runtime_restart',
        'connector_status', 'connector_start', 'connector_restart',
        'recovery_status', 'recovery_start', 'recovery_restart',
        'tunnel_status', 'tunnel_start', 'tunnel_restart',
        'forge_cloud_verify', 'full_recover'
    )]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
$ConfigPath = Join-Path $Root 'config.json'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "FORGE_RESCUE_CONFIG_MISSING: $ConfigPath"
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Config.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($Config.distro) -or [string]::IsNullOrWhiteSpace($Config.wslRescuePath)) {
    throw 'FORGE_RESCUE_CONFIG_INVALID'
}
if ($Config.distro -match "[\r\n'`"`$;&|<>]" -or $Config.wslRescuePath -notmatch '^/home/[A-Za-z0-9._-]+/\.forge-recovery/bin/forge-wsl-rescue$') {
    throw 'FORGE_RESCUE_CONFIG_UNSAFE'
}

$Wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
if (-not (Test-Path -LiteralPath $Wsl -PathType Leaf)) {
    throw "FORGE_RESCUE_WSL_MISSING: $Wsl"
}

function Invoke-WslRescue([string]$WslAction) {
    & $Wsl --distribution $Config.distro --exec $Config.wslRescuePath $WslAction
    if ($LASTEXITCODE -ne 0) {
        throw "FORGE_RESCUE_WSL_ACTION_FAILED: action=$WslAction exitCode=$LASTEXITCODE"
    }
}

switch ($Action) {
    'host_status' {
        [PSCustomObject]@{
            executionEnvironment = 'WINDOWS_WSL'
            hostname = $env:COMPUTERNAME
            user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            distro = $Config.distro
            wslRescuePath = $Config.wslRescuePath
        } | ConvertTo-Json -Depth 3
    }
    'wsl_start' {
        & $Wsl --distribution $Config.distro --exec /bin/true
        if ($LASTEXITCODE -ne 0) { throw "FORGE_RESCUE_WSL_START_FAILED: exitCode=$LASTEXITCODE" }
        Invoke-WslRescue 'wsl_status'
    }
    default { Invoke-WslRescue $Action }
}
