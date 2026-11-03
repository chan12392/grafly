# Explicit Windows login-tunnel installation. Never called by hooks/postinstall.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TunnelSecurity.ps1')
$taskName = 'Grafly-Oracle-Model-Tunnel'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$destination = Join-Path $env:ProgramData ('GraflyModelTunnel-' + $identity.User.Value)
$legacy = Join-Path $env:LOCALAPPDATA 'Grafly\model-tunnel'
$sourceScript = Join-Path $PSScriptRoot 'Watch-GraflyTunnel.ps1'
$targetScript = Join-Path $destination 'Watch-GraflyTunnel.ps1'
$legacyScript = Join-Path $legacy 'Watch-GraflyTunnel.ps1'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$oldXml = $null
if ($existing) {
    $oldXml = Export-ScheduledTask -TaskName $taskName
    $taskUser = [System.Security.Principal.NTAccount]::new($existing.Principal.UserId)
    try { $taskSid = $taskUser.Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { $taskSid = $existing.Principal.UserId }
    $expectedExecutable = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $safeActions = @($legacyScript, $targetScript) | ForEach-Object {
        "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$_`""
    }
    if ($taskSid -ne $identity.User.Value -or @($existing.Actions).Count -ne 1 -or
        $existing.Actions[0].Execute -ine $expectedExecutable -or
        $safeActions -notcontains $existing.Actions[0].Arguments) {
        throw 'The named task is not this user''s Grafly tunnel. Refusing to replace it.'
    }
}

Protect-GraflyTunnelDirectory $destination
$backup = Join-Path $destination ('backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
[System.IO.Directory]::CreateDirectory($backup) | Out-Null
if ($oldXml) { $oldXml | Set-Content -LiteralPath (Join-Path $backup 'task.xml') -Encoding UTF8 }
foreach ($oldPath in @($legacyScript, $targetScript)) {
    if (Test-Path -LiteralPath $oldPath) {
        $label = if ($oldPath -eq $legacyScript) { 'legacy' } else { 'protected' }
        $copy = Join-Path $backup "$label-Watch-GraflyTunnel.ps1"
        Copy-Item -LiteralPath $oldPath -Destination $copy
        if ((Get-FileHash -LiteralPath $oldPath).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) {
            throw 'Backup verification failed'
        }
        (Get-Acl -LiteralPath $oldPath).Sddl | Set-Content -LiteralPath (Join-Path $backup "$label-acl.txt") -Encoding UTF8
    }
}

# Stop only the validated old watcher. Its independent existing SSH stays open.
$oldDirectory = if ($existing -and $existing.Actions[0].Arguments -like "*$legacyScript*") { $legacy } else { $destination }
if ($existing -and $existing.State -eq 'Running') {
    $pause = Join-Path $oldDirectory 'paused.flag'
    [System.IO.File]::WriteAllText($pause, 'Superseded by protected installation')
    $deadline = (Get-Date).AddSeconds(25)
    do {
        Start-Sleep -Seconds 1
        $running = (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'
    } while ($running -and (Get-Date) -lt $deadline)
    if ($running) { throw 'Existing watcher did not stop gracefully; retained backup and original task.' }
}

Copy-Item -LiteralPath $sourceScript -Destination $targetScript -Force
$hash = (Get-FileHash -LiteralPath $sourceScript).Hash
if ((Get-FileHash -LiteralPath $targetScript).Hash -ne $hash) { throw 'Installed script hash mismatch' }
Assert-GraflyTunnelAcl $targetScript
$pause = Join-Path $destination 'paused.flag'
if (Test-Path -LiteralPath $pause) { Remove-Item -LiteralPath $pause }
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$targetScript`"" -WorkingDirectory $destination
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Grafly loopback-only model tunnel; protected per-user installation, hidden login startup and reconnection.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $destination 'task.xml') -Encoding UTF8
Start-ScheduledTask -TaskName $taskName
@{ task = $taskName; script = $targetScript; sha256 = $hash; backup = $backup } | ConvertTo-Json
