[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet(
        'host_status', 'task_status', 'task_install', 'task_run',
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
$PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TaskName = 'Forge Independent Recovery WSL'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValueName = 'ForgeIndependentRecoveryWSL'
$RunCommand = ('"' + $PowerShell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" full_recover')
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
    'task_status' {
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -ne $Task) {
            [PSCustomObject]@{ installed = $true; method = 'scheduled_task'; taskName = $TaskName; state = [string]$Task.State; execute = $Task.Actions[0].Execute; arguments = $Task.Actions[0].Arguments } | ConvertTo-Json -Depth 4
        } else {
            $RunValue = (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction SilentlyContinue).$RunValueName
            [PSCustomObject]@{ installed = ($RunValue -eq $RunCommand); method = $(if ($RunValue) { 'hkcu_run' } else { 'none' }); taskName = $TaskName; runValueName = $RunValueName; identityMatches = ($RunValue -eq $RunCommand) } | ConvertTo-Json -Depth 4
        }
    }
    'task_install' {
        $ActionObject = New-ScheduledTaskAction -Execute $PowerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" full_recover')
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        try {
            $null = Register-ScheduledTask -TaskName $TaskName -Action $ActionObject -Trigger $Trigger -Description 'Forge independent Windows/WSL rescue cold-start trigger.' -Force -ErrorAction Stop
            [PSCustomObject]@{ installed = $true; method = 'scheduled_task'; taskName = $TaskName } | ConvertTo-Json -Depth 3
        } catch {
            if (-not (Test-Path -LiteralPath $RunKey)) { $null = New-Item -Path $RunKey -Force }
            Set-ItemProperty -LiteralPath $RunKey -Name $RunValueName -Value $RunCommand -Type String -Force
            $InstalledValue = (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction Stop).$RunValueName
            if ($InstalledValue -ne $RunCommand) { throw 'FORGE_RESCUE_LOGON_TRIGGER_IDENTITY_MISMATCH' }
            [PSCustomObject]@{ installed = $true; method = 'hkcu_run'; taskName = $TaskName; schedulerError = $_.Exception.HResult } | ConvertTo-Json -Depth 3
        }
    }
    'task_run' {
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -ne $Task) {
            Start-ScheduledTask -InputObject $Task
            [PSCustomObject]@{ started = $true; method = 'scheduled_task'; taskName = $TaskName } | ConvertTo-Json -Depth 3
        } else {
            & $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath full_recover
            if ($LASTEXITCODE -ne 0) { throw "FORGE_RESCUE_DIRECT_TRIGGER_FAILED: exitCode=$LASTEXITCODE" }
            [PSCustomObject]@{ started = $true; method = 'direct_fixed_action'; taskName = $TaskName } | ConvertTo-Json -Depth 3
        }
    }
    'wsl_start' {
        & $Wsl --distribution $Config.distro --exec /bin/true
        if ($LASTEXITCODE -ne 0) { throw "FORGE_RESCUE_WSL_START_FAILED: exitCode=$LASTEXITCODE" }
        Invoke-WslRescue 'wsl_status'
    }
    default { Invoke-WslRescue $Action }
}
