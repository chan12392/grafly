param(
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string]$PythonwPath
)
$ErrorActionPreference = 'Stop'
$node = (Resolve-Path -LiteralPath $NodePath).Path
$cli = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dist\mc-runtime\cli.js')).Path
$launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dist\mc-runtime\launcher.py')).Path
$config = Join-Path $env:USERPROFILE '.grafly\mc-runtime\config.json'
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Trusted MC enrollment config is required first.' }
if (-not $PythonwPath) {
    $python = (Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).python
    $PythonwPath = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
}
$pythonw = (Resolve-Path -LiteralPath $PythonwPath).Path
# The token is read only from the ACL-protected config, never command arguments.
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $launcher + '" "' + $node + '" "' + $cli + '" watch')
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
if (Get-ScheduledTask -TaskName 'Grafly-MC-Updater' -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName 'Grafly-MC-Updater'
}
# A historical task wrapper may leave its Node child alive after the task stops.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match ([regex]::Escape($cli) + '"?\s+watch(?:\s|$)')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Register-ScheduledTask -TaskName 'Grafly-MC-Updater' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Verify and apply signed MoreCoffee code and approved models; MC owns learning' -Force | Out-Null
Start-ScheduledTask -TaskName 'Grafly-MC-Updater'
Get-ScheduledTask -TaskName 'Grafly-MC-Updater' | Select-Object TaskName, State
