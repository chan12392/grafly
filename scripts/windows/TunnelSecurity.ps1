# Installation-only helpers. The scheduled watcher runs the protected copy.
function Get-GraflyTrustedSids {
    @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
        'S-1-5-18', 'S-1-5-32-544')
}

function Assert-GraflyTrustedParents([string]$Path) {
    $trusted = Get-GraflyTrustedSids
    $dangerous = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $itemPath = [System.IO.Path]::GetFullPath($Path)
    while ($itemPath) {
        if (Test-Path -LiteralPath $itemPath) {
            $item = Get-Item -LiteralPath $itemPath -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a reparse point in the installation path: $itemPath"
            }
            $acl = Get-Acl -LiteralPath $itemPath
            foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                if ($rule.AccessControlType -ne 'Allow' -or $trusted -contains $rule.IdentityReference.Value) { continue }
                if ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
                if ($rule.FileSystemRights -band $dangerous) {
                    throw "Untrusted principal can replace the protected directory through ancestor: $itemPath"
                }
            }
        }
        $parent = [System.IO.Directory]::GetParent($itemPath)
        $itemPath = if ($parent) { $parent.FullName } else { $null }
    }
}

function Assert-GraflyTunnelAcl([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing a reparse point: $Path" }
    $trusted = Get-GraflyTrustedSids
    $acl = Get-Acl -LiteralPath $Path
    if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {
        throw "Untrusted owner on tunnel artifact: $Path"
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) {
            throw "Unexpected allow entry $($rule.IdentityReference.Value) on tunnel artifact: $Path"
        }
    }
}

function Protect-GraflyTunnelDirectory([string]$Path) {
    Assert-GraflyTrustedParents ([System.IO.Directory]::GetParent([System.IO.Path]::GetFullPath($Path)).FullName)
    $trusted = Get-GraflyTrustedSids
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing a reparse point: $Path" }
        if ($trusted -notcontains (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {
            throw "Refusing a directory owned by another user: $Path"
        }
    } else {
        [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    }
    $previous = Get-Acl -LiteralPath $Path
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($previous.GetOwner([System.Security.Principal.SecurityIdentifier]))
    $acl.SetAccessRuleProtection($true, $false)
    # Rebuild the allow list while preserving every deny, including inherited
    # sandbox restrictions. Removing inherited allow rules in place is unreliable.
    foreach ($rule in @($previous.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        if ($rule.AccessControlType -eq 'Deny') {
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                $rule.IdentityReference, $rule.FileSystemRights, $rule.InheritanceFlags,
                $rule.PropagationFlags, 'Deny'))
        }
    }
    foreach ($sid in $trusted) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
            'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    Assert-GraflyTunnelAcl $Path
}
