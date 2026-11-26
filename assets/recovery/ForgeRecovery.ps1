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
        'forge_cloud_verify', 'full_recover', 'watch'
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
$WslRescuePathPattern = '^/' + 'home/[A-Za-z0-9._-]+/\.forge-recovery/bin/forge-wsl-rescue$'
if ($Config.distro -match "[\r\n'`"`$;&|<>]" -or $Config.wslRescuePath -notmatch $WslRescuePathPattern) {
    throw 'FORGE_RESCUE_CONFIG_UNSAFE'
}

$Wsl = Join-Path $env:WINDIR 'System32\wsl.exe'
$PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TaskName = 'Forge Independent Recovery WSL'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValueName = 'ForgeIndependentRecoveryWSL'
$WatchCommand = ('"' + $PowerShell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" watch')
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
            $ActionMatches = ($Task.Actions.Count -eq 1 -and ('"' + [string]$Task.Actions[0].Execute + '" ' + [string]$Task.Actions[0].Arguments) -eq $WatchCommand)
            [PSCustomObject]@{ installed = $true; method = 'scheduled_task'; taskName = $TaskName; identityMatches = $ActionMatches; watchdog = $ActionMatches; state = [string]$Task.State; execute = $Task.Actions[0].Execute; arguments = $Task.Actions[0].Arguments } | ConvertTo-Json -Depth 4
        } else {
            $RunValue = (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction SilentlyContinue).$RunValueName
            [PSCustomObject]@{ installed = ($RunValue -eq $WatchCommand); method = $(if ($RunValue) { 'hkcu_run' } else { 'none' }); taskName = $TaskName; runValueName = $RunValueName; identityMatches = ($RunValue -eq $WatchCommand); watchdog = ($RunValue -eq $WatchCommand) } | ConvertTo-Json -Depth 4
        }
    }
    'task_install' {
        $ActionObject = New-ScheduledTaskAction -Execute $PowerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" watch')
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
        try {
            $null = Register-ScheduledTask -TaskName $TaskName -Action $ActionObject -Trigger $Trigger -Settings $Settings -Description 'Forge independent Windows/WSL continuous recovery watchdog.' -Force -ErrorAction Stop
            $Verify = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            $VerifyCommand = ('"' + [string]$Verify.Actions[0].Execute + '" ' + [string]$Verify.Actions[0].Arguments)
            if ($Verify.Actions.Count -ne 1 -or $VerifyCommand -ne $WatchCommand) { throw 'FORGE_RESCUE_WATCHDOG_IDENTITY_MISMATCH' }
            [PSCustomObject]@{ installed = $true; method = 'scheduled_task'; taskName = $TaskName; identityMatches = $true; watchdog = $true } | ConvertTo-Json -Depth 3
        } catch {
            if (-not (Test-Path -LiteralPath $RunKey)) { $null = New-Item -Path $RunKey -Force }
            Set-ItemProperty -LiteralPath $RunKey -Name $RunValueName -Value $WatchCommand -Type String -Force
            $InstalledValue = (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction Stop).$RunValueName
            if ($InstalledValue -ne $WatchCommand) { throw 'FORGE_RESCUE_LOGON_TRIGGER_IDENTITY_MISMATCH' }
            [PSCustomObject]@{ installed = $true; method = 'hkcu_run'; taskName = $TaskName; schedulerError = $_.Exception.HResult } | ConvertTo-Json -Depth 3
        }
    }
    'task_run' {
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -ne $Task) {
            Start-ScheduledTask -InputObject $Task
            [PSCustomObject]@{ started = $true; method = 'scheduled_task'; taskName = $TaskName; identityMatches = $true; watchdog = $true } | ConvertTo-Json -Depth 3
        } else {
            # HKCU Run is only evaluated at logon. When task_install falls back
            # to that mechanism during an already-running session, start the
            # same watchdog immediately instead of doing a one-shot recovery.
            $WatchArguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" watch')
            $WatchProcess = Start-Process -FilePath $PowerShell -ArgumentList $WatchArguments -WindowStyle Hidden -PassThru
            if ($null -eq $WatchProcess) { throw 'FORGE_RESCUE_WATCHDOG_START_FAILED' }
            [PSCustomObject]@{ started = $true; method = 'hkcu_run_watch_process'; taskName = $TaskName; identityMatches = $true; watchdog = $true; pid = $WatchProcess.Id } | ConvertTo-Json -Depth 3
        }
    }
    'wsl_start' {
        & $Wsl --distribution $Config.distro --exec /bin/true
        if ($LASTEXITCODE -ne 0) { throw "FORGE_RESCUE_WSL_START_FAILED: exitCode=$LASTEXITCODE" }
        Invoke-WslRescue 'wsl_status'
    }
    'watch' {
        # Keep exactly one watchdog owner per interactive Windows session.
        # Repeated task_run/logon triggers may race; the losing process exits
        # while the existing owner keeps supervising WSL recovery.
        $CreatedNew = $false
        $WatchMutex = New-Object System.Threading.Mutex($true, 'Local\ForgeIndependentRecoveryWSLWatch', [ref]$CreatedNew)
        if (-not $CreatedNew) {
            [PSCustomObject]@{ running = $true; owner = 'existing_process'; taskName = $TaskName } | ConvertTo-Json -Depth 3
            $WatchMutex.Dispose()
            return
        }
        try {
            # Keep the Windows logon owner alive even if WSL is restarted,
            # terminated, or the inner rescue watcher exits after a transient
            # failure. The fixed WSL rescue path remains the only executed target.
            while ($true) {
                try {
                    Invoke-WslRescue 'watch'
                } catch {
                    Write-Warning ("FORGE_RESCUE_WSL_WATCH_RESTART: " + $_.Exception.Message)
                }
                Start-Sleep -Seconds 10
            }
        } finally {
            try { $WatchMutex.ReleaseMutex() } catch [System.ApplicationException] {}
            $WatchMutex.Dispose()
        }
    }
    default { Invoke-WslRescue $Action }
}
