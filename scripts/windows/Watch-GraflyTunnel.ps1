param(
    [ValidateRange(1024, 65535)][int]$LocalPort = 10531,
    [string]$StateDirectory = (Join-Path $env:ProgramData ('GraflyModelTunnel-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)),
    [ValidateRange(2, 60)][int]$PollSeconds = 15,
    [ValidateRange(0, 600)][int]$RunSeconds = 0
)
$ErrorActionPreference = 'Stop'
$sshPath = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$guard = [System.Threading.Mutex]::new($false, "Local\GraflyOracleTunnel-$($identity.User.Value)-$LocalPort")
$locked = $false
$child = $null
$lastState = ''
$started = Get-Date

function Test-LocalListener {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $attempt = $client.ConnectAsync('127.0.0.1', $LocalPort)
        if (-not $attempt.Wait(1000)) { return $false }
        return $client.Connected
    } catch { return $false }
    finally { $client.Dispose() }
}

function Write-TunnelState([string]$State, [string]$Detail = '') {
    $statusPath = Join-Path $StateDirectory 'status.json'
    $ownedPid = if ($child -and -not $child.HasExited) { $child.Id } else { $null }
    $status = [ordered]@{
        state = $State; detail = $Detail; watcherPid = $PID; sshPid = $ownedPid
        localPort = $LocalPort; updatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $status | ConvertTo-Json | Set-Content -LiteralPath "$statusPath.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$statusPath.tmp" -Destination $statusPath -Force
    if ($script:lastState -ne "$State|$Detail") {
        $log = Join-Path $StateDirectory 'watcher.log'
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 262144) {
            Move-Item -LiteralPath $log -Destination "$log.1" -Force
        }
        Add-Content -LiteralPath $log -Encoding UTF8 -Value "$([DateTime]::UtcNow.ToString('o')) $State $Detail"
        $script:lastState = "$State|$Detail"
    }
}

try {
    try { $locked = $guard.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container)) { throw 'Run Install-GraflyTunnel.ps1 first.' }
    while (-not (Test-Path -LiteralPath (Join-Path $StateDirectory 'paused.flag'))) {
        if ($RunSeconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $RunSeconds) { break }
        try {
            if ($child -and $child.HasExited) {
                Write-TunnelState 'retrying' "SSH exited with code $($child.ExitCode)"
                $child.Dispose()
                $child = $null
            }
            if (Test-LocalListener) {
                Write-TunnelState 'connected' $(if ($child) { 'Owned SSH tunnel' } else { 'Existing listener preserved' })
            } elseif (-not $child) {
                $sshArgs = @('-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
                    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
                    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
                    '-L', "127.0.0.1:${LocalPort}:127.0.0.1:10531", 'oracle')
                $child = Start-Process -FilePath $sshPath -ArgumentList $sshArgs -WindowStyle Hidden -PassThru `
                    -RedirectStandardError (Join-Path $StateDirectory 'ssh.stderr.log')
                Write-TunnelState 'connecting' "SSH process $($child.Id)"
            } else {
                Write-TunnelState 'connecting' "SSH process $($child.Id)"
            }
        } catch {
            Write-TunnelState 'retrying' $_.Exception.Message
        }
        Start-Sleep -Seconds $PollSeconds
    }
    Write-TunnelState 'stopped'
} finally {
    if ($child) {
        if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
        $child.Dispose()
    }
    if ($locked) { $guard.ReleaseMutex() }
    $guard.Dispose()
}
