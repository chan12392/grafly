# Windows-only filesystem acceptance. No accounts, tasks or network changes.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/windows/TunnelSecurity.ps1')
$root = Join-Path $env:ProgramData ('GraflyTunnelAclTest-' + [Guid]::NewGuid().ToString('N'))
$unsafe = Join-Path $root 'unsafe-parent'
$file = Join-Path $unsafe 'sample.ps1'
$checks = 0
function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
try {
    Protect-GraflyTunnelDirectory $root
    Assert-GraflyTrustedParents $root
    [System.IO.Directory]::CreateDirectory($unsafe) | Out-Null
    $acl = Get-Acl -LiteralPath $unsafe
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl',
        'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    $denySid = 'S-1-5-21-111-222-333-4444'
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($denySid), 'Write',
        'ContainerInherit, ObjectInherit', 'None', 'Deny'))
    Set-Acl -LiteralPath $unsafe -AclObject $acl
    $rejected = $false
    try { Assert-GraflyTrustedParents $unsafe } catch { $rejected = $true }
    Assert-Test $rejected 'An Everyone-writable ancestor was accepted'
    Protect-GraflyTunnelDirectory $unsafe
    Assert-GraflyTrustedParents $unsafe
    $acl = Get-Acl -LiteralPath $unsafe
    Assert-Test $acl.AreAccessRulesProtected 'Directory inheritance was not protected'
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    Assert-Test (@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq 'S-1-1-0' }).Count -eq 0) 'Everyone still has access'
    Assert-Test (@($rules | Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -eq $denySid }).Count -eq 1) 'Existing deny rule was removed'
    [System.IO.File]::WriteAllText($file, '# Harmless ACL fixture')
    Assert-GraflyTunnelAcl $file
    Assert-Test ((Get-Content -LiteralPath $file -Raw) -eq '# Harmless ACL fixture') 'The owning user cannot use the protected file'
    $before = (Get-Acl -LiteralPath $unsafe).Sddl
    Protect-GraflyTunnelDirectory $unsafe
    Assert-Test ((Get-Acl -LiteralPath $unsafe).Sddl -eq $before) 'Repeated protection changed permissions'
    $junction = Join-Path $root 'redirected'
    New-Item -ItemType Junction -Path $junction -Target $unsafe | Out-Null
    try {
        $rejected = $false
        try { Assert-GraflyTrustedParents $junction } catch { $rejected = $true }
        Assert-Test $rejected 'A redirected ancestor was accepted'
    } finally { [System.IO.Directory]::Delete($junction) }
    @{ passed = $checks; path = $root; denyRulesPreserved = $true; reparsePointsRejected = $true } | ConvertTo-Json
} finally {
    # Exact, nonrecursive removal: never follow links or enumerate another root.
    if ([System.IO.Path]::GetDirectoryName($root) -ne $env:ProgramData -or
        [System.IO.Path]::GetFileName($root) -notmatch '^GraflyTunnelAclTest-[0-9a-f]{32}$') { throw 'Unexpected test cleanup path' }
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    if (Test-Path -LiteralPath $unsafe) { [System.IO.Directory]::Delete($unsafe) }
    if (Test-Path -LiteralPath $root) { [System.IO.Directory]::Delete($root) }
}
