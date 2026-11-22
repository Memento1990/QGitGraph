param(
  [Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$FileList,
  [Parameter(Mandatory=$true)][string]$OutputFile
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
. (Join-Path $PSScriptRoot 'windows-processes.ps1') -Library
if (Test-Path -LiteralPath $Archive) { throw 'Archive already exists; never overwrite a staged release.' }
$root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
$list = Get-Content -LiteralPath $FileList -Raw | ConvertFrom-Json
$stream = $null
$zip = $null
$written = @()
try {
  $stream = [IO.File]::Open([IO.Path]::GetFullPath($Archive),[IO.FileMode]::CreateNew)
  $zip = New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
  foreach ($item in @($list.files)) {
    $relative = [string]$item.path
    if ($relative -match '\\|(^|/)\.{1,2}(/|$)|^/|[\x00-\x1f<>:"|?*]' -or [string]::IsNullOrWhiteSpace($relative)) { throw "Unsafe archive path: $relative" }
    $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes source root.' }
    $file = Get-Item -LiteralPath $full
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Archive inputs must be regular files without links.' }
    $sha = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sha -ne $item.sha256 -or $file.Length -ne $item.bytes) { throw "Archive input changed after inventory: $relative" }
    $entry = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$full,$relative,[IO.Compression.CompressionLevel]::Optimal)
    $written += [pscustomobject]@{ path=$relative; bytes=$file.Length; sha256=$sha }
  }
} finally { if ($null -ne $zip) { $zip.Dispose() }; if ($null -ne $stream) { $stream.Dispose() } }
# Reopen and hash every ZIP entry, not merely the source copy operation.
$readZip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  if ($readZip.Entries.Count -ne $written.Count) { throw 'ZIP entry count mismatch.' }
  foreach ($entry in $readZip.Entries) {
    $expected = @($written | Where-Object { $_.path -ceq $entry.FullName })
    if ($expected.Count -ne 1 -or $entry.Length -ne $expected[0].bytes) { throw "ZIP entry mismatch: $($entry.FullName)" }
    $hash = [Security.Cryptography.SHA256]::Create()
    $entryStream = $entry.Open()
    try { $actual = ([BitConverter]::ToString($hash.ComputeHash($entryStream))).Replace('-','').ToLowerInvariant() }
    finally { $entryStream.Dispose(); $hash.Dispose() }
    if ($actual -ne $expected[0].sha256) { throw "ZIP content hash mismatch: $($entry.FullName)" }
  }
} finally { $readZip.Dispose() }
$result = [pscustomobject]@{ schemaVersion=1; status='passed'; sha256=(Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $Archive).Length; files=$written; createdAt=[DateTime]::UtcNow.ToString('o') }
Write-QGJson $OutputFile $result
Write-Output "Verified archive with $($written.Count) entries."
