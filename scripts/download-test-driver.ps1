param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedArchiveSha256
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/windows-processes.ps1') -Library
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Driver acquisition requires a new absent directory.' }
$root = [IO.Path]::GetFullPath($OutputDirectory)
$download = Join-Path $root 'download'
$extracted = Join-Path $root 'extracted'
$null = New-Item -ItemType Directory -Path $download
$null = New-Item -ItemType Directory -Path $extracted
$url = "https://msedgedriver.microsoft.com/$Version/edgedriver_win64.zip"
$archive = Join-Path $download 'edgedriver_win64.zip'
$report = [ordered]@{ schemaVersion=1; kind='driver-acquisition'; status='running'; requestedVersion=$Version; url=$url; startedAt=[DateTime]::UtcNow.ToString('o') }
try {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -MaximumRedirection 0
  $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExpectedArchiveSha256 -and $archiveHash -ne $ExpectedArchiveSha256.ToLowerInvariant()) { throw 'Downloaded archive SHA-256 mismatch.' }
  $report.archiveSha256 = $archiveHash
  # Download and extraction are separate new empty directories. No interpreter or
  # build tool is started from either, and no unsigned extracted program is run.
  Expand-Archive -LiteralPath $archive -DestinationPath $extracted
  $driver = Join-Path $extracted 'msedgedriver.exe'
  $signature = Get-QGSignature $driver
  if ($signature.status -ne 'Valid' -or $signature.subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'Edge WebDriver Microsoft Authenticode verification failed.' }
  $observed = & $driver --version
  if ($LASTEXITCODE -ne 0 -or $observed -notmatch ('^MSEdgeDriver\s+'+[regex]::Escape($Version)+'\b')) { throw 'Verified driver returned the wrong requested version.' }
  $report.driver = [pscustomobject]@{ path=$driver; sha256=$signature.sha256; signature=$signature; version=([string]$observed).Trim() }
  $report.status = 'passed'
} catch { $report.status='failed'; $report.error=$_.Exception.Message; throw }
finally { $report.finishedAt=[DateTime]::UtcNow.ToString('o'); Write-QGJson (Join-Path $root 'verification.json') $report }
Write-Output "Verified Microsoft Edge WebDriver: $driver"
