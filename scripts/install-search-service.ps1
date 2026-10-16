param(
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string]$PythonwPath = (Get-Command pythonw -ErrorAction Stop).Source,
    [string]$OracleHost,
    [ValidateRange(1024,65533)][int]$XerjPort = 19330
)
$ErrorActionPreference = 'Stop'
$node = (Resolve-Path -LiteralPath $NodePath).Path
$pythonw = (Resolve-Path -LiteralPath $PythonwPath).Path
$server = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dist\entry.js')).Path
$launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\service\search-launcher.py')).Path
$cli = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dist\cli.js')).Path
$state = Join-Path $env:USERPROFILE '.grafly\search-service'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$configPath = Join-Path $state 'config.json'
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination ($configPath + '.' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.bak') }
if ($OracleHost) { $config = @{ oracleHost=$OracleHost; xerjPort=$XerjPort; xerjUrl="http://127.0.0.1:$XerjPort" } }
else {
    $binding = Join-Path $PSScriptRoot '..\dist\search\native\xerj-win32-x64.node'
    if (!(Test-Path -LiteralPath $binding)) {
        & $node (Join-Path $PSScriptRoot 'build-xerj.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Embedded XERJ build failed; existing service retained' }
    }
    $config = @{ xerjUrl='embedded' }
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
& $node $cli daemon stop | Out-Null
if (Get-ScheduledTask -TaskName 'Grafly-Search' -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName 'Grafly-Search' }
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $launcher + '" "' + $node + '" "' + $server + '" serve')
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Grafly-Search' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Resident Grafly CLI with embedded XERJ, shared by coding agents and repositories' -Force | Out-Null
Start-ScheduledTask -TaskName 'Grafly-Search'
Get-ScheduledTask -TaskName 'Grafly-Search' | Select-Object TaskName,State
