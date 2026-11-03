$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot '../scripts/windows/Watch-GraflyTunnel.ps1'
$testState = Join-Path $PSScriptRoot ('../.gepa-shadow/tunnel-proof-' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
$testPort = 10532
$occupied = Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue
if ($occupied) { throw 'Test port 10532 is occupied; refusing to disturb it.' }
[System.IO.Directory]::CreateDirectory($testState) | Out-Null
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File `"$scriptFile`" -LocalPort $testPort -StateDirectory `"$testState`" -PollSeconds 2 -RunSeconds 120"
$watcher = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList $arguments -WindowStyle Hidden -PassThru

function Wait-TestModels {
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        if ($watcher.HasExited) { throw 'Test watcher exited before model response' }
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1/models" -TimeoutSec 3
            if ($response.data.id -contains 'gpt-5.6-luna') { return }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Test model endpoint did not recover in 40 seconds'
}

try {
    Wait-TestModels
    Start-Sleep -Seconds 2
    $first = Get-Content -LiteralPath (Join-Path $testState 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $first.sshPid) { throw 'No owned test SSH process recorded' }
    $duplicate = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $duplicate.WaitForExit(8000) -or $duplicate.ExitCode -ne 0) { throw 'Duplicate watcher was not safely skipped' }
    $listener = Get-NetTCPConnection -LocalPort $testPort -State Listen
    if ($listener.OwningProcess -ne $first.sshPid) { throw 'Test listener ownership changed unexpectedly' }
    Stop-Process -Id $first.sshPid -Force
    Wait-TestModels
    Start-Sleep -Seconds 2
    $second = Get-Content -LiteralPath (Join-Path $testState 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $second.sshPid -or $first.sshPid -eq $second.sshPid) { throw 'Test SSH process was not replaced' }
    $result = @{ model = 'gpt-5.6-luna'; firstSshPid = $first.sshPid; replacementSshPid = $second.sshPid; duplicateSkipped = $true; reconnected = $true; testPort = $testPort }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testState 'result.json') -Encoding UTF8
    $result | ConvertTo-Json
} finally {
    New-Item -ItemType File -Path (Join-Path $testState 'paused.flag') -Force | Out-Null
    if (-not $watcher.WaitForExit(10000)) { throw 'Test watcher did not stop gracefully; inspect its recorded process IDs.' }
    if (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue) {
        throw 'Test listener remained open after watcher shutdown'
    }
}
