#Requires -RunAsAdministrator
<#
  Installs CC Sessions' administrator helper (admin-host.js) in a folder only administrators can
  write. Run it elevated, from the reviewed commit of the repo:

    powershell -NoProfile -File admin-host\install.ps1 [-Destination <folder>] [-NodeExe <node.exe>]

  It copies the files listed in manifest.json, then checks the SHA-256 of each one in the
  destination folder, so nothing changed in the repo after the review gets installed (the repo is
  the user's to write). node.exe, which changes with every Node update, is copied only with a valid
  Authenticode signature from the OpenJS Foundation, checked again once copied. The configuration
  (admin-host.json) is written from the example only if there isn't one: edit it afterwards.
  Finally it says who, other than SYSTEM, Administrators and TrustedInstaller, may write the folder.
#>
param(
  [string]$Destination = 'C:\Program Files\CC Sessions\admin-host',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
# Only the system's modules (Get-FileHash, Get-Acl…), whatever this session's environment says.
$env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"

$repo = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') | ConvertFrom-Json

function Assert-Signed([string]$file, [string]$signer) {
  $s = Get-AuthenticodeSignature -LiteralPath $file
  if ($s.Status -ne 'Valid') { throw "${file}: signature is $($s.Status)" }
  if (-not $s.SignerCertificate.Subject.StartsWith($signer)) { throw "${file}: signed by $($s.SignerCertificate.Subject)" }
}

Assert-Signed $NodeExe $manifest.node.signer
$major = [int]((Get-Item -LiteralPath $NodeExe).VersionInfo.ProductMajorPart)
if ($major -lt $manifest.node.minMajor) { throw "node.exe $major is too old (at least $($manifest.node.minMajor))" }

# A clean copy: what was installed before goes (the configuration and the logs stay).
if (Test-Path -LiteralPath $Destination) {
  foreach ($old in 'admin-host.js', 'node.exe', 'node_modules', 'run') {
    $p = Join-Path $Destination $old
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
  }
} else {
  New-Item -ItemType Directory -Path $Destination | Out-Null
}

foreach ($f in $manifest.files) {
  $dst = Join-Path $Destination $f.target
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo $f.source) -Destination $dst -Force
}
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $Destination 'node.exe') -Force
foreach ($d in 'run', 'logs') { New-Item -ItemType Directory -Force -Path (Join-Path $Destination $d) | Out-Null }

# What landed, checked where it landed.
$bad = @()
foreach ($f in $manifest.files) {
  $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Destination $f.target)).Hash.ToLowerInvariant()
  if ($h -ne $f.sha256) { $bad += $f.target }
}
if ($bad.Count) {
  Remove-Item -LiteralPath (Join-Path $Destination 'admin-host.js') -Force
  throw "SHA-256 mismatch (the helper was removed): $($bad -join ', ')"
}
Assert-Signed (Join-Path $Destination 'node.exe') $manifest.node.signer

$config = Join-Path $Destination 'admin-host.json'
if (-not (Test-Path -LiteralPath $config)) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'admin-host.example.json') -Destination $config
  Write-Host "Wrote $config from the example: set configDir, profileDir, tempDir and allowedRoots."
}

# Who else may write it. The helper checks this too, every time it starts a session.
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0')
$write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
$sidType = [System.Security.Principal.SecurityIdentifier]
$acl = Get-Acl -LiteralPath $Destination
$writers = @(foreach ($r in $acl.GetAccessRules($true, $true, $sidType)) {
  if ([string]$r.AccessControlType -eq 'Allow' -and $trusted -notcontains $r.IdentityReference.Value -and (([int]$r.FileSystemRights -band $write) -ne 0)) { $r.IdentityReference.Value }
})
$owner = $acl.GetOwner($sidType).Value
if ($writers.Count -or $trusted -notcontains $owner) {
  Write-Warning "$Destination can be written by others (owner $owner; $($writers -join ', ')): the helper will refuse to start sessions."
}

Write-Host "Installed $($manifest.files.Count) files and node.exe $major in $Destination (protocol $($manifest.version), node-pty $($manifest.nodePty))."
