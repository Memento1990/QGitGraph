param(
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [Parameter(Mandatory=$true)][string]$FileList,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Source staging directory already exists.' }
$source = [IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\')
$target = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$null = New-Item -ItemType Directory -Path $target
$list = Get-Content -LiteralPath $FileList -Raw | ConvertFrom-Json
foreach ($item in @($list.files)) {
  $relative = [string]$item.path
  if ($relative -match '\\|(^|/)\.{1,2}(/|$)|^/|[\x00-\x1f<>:"|?*]' -or [string]::IsNullOrWhiteSpace($relative)) { throw 'Unsafe source archive path.' }
  $from = [IO.Path]::GetFullPath((Join-Path $source $relative))
  $to = [IO.Path]::GetFullPath((Join-Path $target $relative))
  if (-not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Source archive path escapes root.' }
  if ((Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw "Source changed after whitelist inventory: $relative" }
  $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($to)) -Force
  Copy-Item -LiteralPath $from -Destination $to
  if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw 'Source copy SHA-256 mismatch.' }
}
