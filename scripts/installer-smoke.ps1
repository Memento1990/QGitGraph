param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$Destination,
  [string]$NodeExecutable = 'node.exe'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/install.ps1')
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { if (@(Get-ChildItem -LiteralPath $output -Force).Count -ne 0) { throw 'Use a new empty installation run directory.' } }
else { $null = New-Item -ItemType Directory -Path $output }
$runId = [Guid]::NewGuid().ToString()
$marker = Join-Path $output '.qgitgraph-install-run'
$stream = [IO.File]::Open($marker,[IO.FileMode]::CreateNew); $stream.Dispose()
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$destinationPath = if ($Destination) { [IO.Path]::GetFullPath($Destination) } else { Join-Path $output 'installation' }
if (-not $destinationPath.StartsWith($output.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test installation destination must be inside its new run directory.' }
if ($destinationPath -match '[\r\n"]') { throw 'Installation test path contains unsupported characters.' }
$reportPath = Join-Path $output 'test-report.json'
$ledgerFile = Join-Path $output 'process-ownership.json'
$ledger = [pscustomobject]@{ schemaVersion=1; runId=$runId; roots=@(); known=@() }
$productName = 'QGitGraph'
$report = [ordered]@{
  schemaVersion=1; kind='installer'; runId=$runId; status='running'; startedAt=[DateTime]::UtcNow.ToString('o'); finishedAt=$null
  installer=[pscustomobject]@{ path=$installerPath; sha256=(Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $installerPath).Length; signature=(Get-QGSignature $installerPath) }
  destination=$destinationPath; results=@(); cleanup=$null
  scope='Real NSIS current-user registration and shortcuts are shared OS state, not isolated by --profile-dir. Refuse existing product installation; use a clean VM if blocked. This does not test missing Git/WebView2/DPI variants.'
}
$witness = $null
$failure = $null
try {
  $existing = @(Get-QGProductRegistrations $productName)
  $shortcuts = @(Get-QGProductShortcuts $productName)
  $knownDirectories = @((Join-Path $env:LOCALAPPDATA 'QGitGraph'),(Join-Path $env:LOCALAPPDATA 'Programs\QGitGraph'))
  if ($env:ProgramFiles) { $knownDirectories += Join-Path $env:ProgramFiles 'QGitGraph' }
  if (${env:ProgramFiles(x86)}) { $knownDirectories += Join-Path ${env:ProgramFiles(x86)} 'QGitGraph' }
  $existingDirectories = @($knownDirectories | Where-Object { Test-Path -LiteralPath $_ })
  $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFileName($_.ExecutablePath) -ieq 'qgitgraph.exe' })
  if ($existing.Count -or $shortcuts.Count -or $existingDirectories.Count -or $running.Count) {
    $report.status = 'blocked'
    $report.existing = [pscustomobject]@{ registrations=$existing; shortcuts=$shortcuts; directories=$existingDirectories; runningProcessIds=@($running | ForEach-Object { $_.ProcessId }) }
    throw 'BLOCKED: An existing same-product installation, shortcut or running instance was found. Do not overwrite it. Use a clean VM; a different app profile does not isolate NSIS registration.'
  }
  if (Test-Path -LiteralPath $destinationPath) { throw 'Destination must be absent before installation.' }
  # /D must be last and its path must not be quoted (NSIS command-line contract).
  $installExit = Invoke-QGProgram $installerPath ("/S /D=$destinationPath") $ledger $ledgerFile
  if ($installExit -ne 0) { throw "Installer exited $installExit" }
  $app = Join-Path $destinationPath 'qgitgraph.exe'
  if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw 'Application missing from requested run-owned destination. No fallback/default installation will be uninstalled automatically.' }
  $uninstallers = @(Get-ChildItem -LiteralPath $destinationPath -Filter '*uninstall*.exe' -File)
  if ($uninstallers.Count -ne 1) { throw 'Expected exactly one owned NSIS uninstaller.' }
  $registrations = @(Get-QGProductRegistrations $productName)
  if ($registrations.Count -ne 1 -or -not (Test-QGSamePath $registrations[0].installLocation $destinationPath)) { throw 'Installer registration does not point at the owned requested destination; manual/VM recovery is required.' }
  $witness = [pscustomobject]@{
    schemaVersion=1; runId=$runId; productName=$productName; destination=$destinationPath; absentBefore=$true; installCompleted=$true
    uninstaller=$uninstallers[0].FullName; uninstallerSha256=(Get-FileHash -LiteralPath $uninstallers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    installerSha256=$report.installer.sha256; registryKey=$registrations[0].key
  }
  Write-QGJson (Join-Path $output 'install-witness.json') $witness
  $report.results += [pscustomobject]@{ label='fresh run-owned install and exact requested destination'; status='passed'; exitCode=$installExit }
  $noticeReport = Join-Path $output 'notice-verification.json'
  & $NodeExecutable (Join-Path $PSScriptRoot 'verify-notices.mjs') --directory $destinationPath --output $noticeReport
  if ($LASTEXITCODE -ne 0) { throw 'Installed notice SHA-256 tree verification failed, including covered MPL source archives.' }
  $notice = Get-Content -LiteralPath $noticeReport -Raw | ConvertFrom-Json
  $report.results += [pscustomobject]@{ label='all manifest notice hashes and MPL archives'; status='passed'; checkedFiles=$notice.checkedFileCount; mplArchives=$notice.mplArchives }
  $files = @(Get-ChildItem -LiteralPath $destinationPath -Recurse -File)
  $testProbes = @($files | Where-Object { $_.Name -like '*qgitgraph-test-probe*' })
  if ($testProbes.Count) { throw 'Build-only host-test probe was found in the installed product.' }
  $report.results += [pscustomobject]@{ label='installed tree excludes build-only host-test probe'; status='passed'; probeCount=$testProbes.Count }
  $report.installed = [pscustomobject]@{ fileCount=$files.Count; bytes=($files | Measure-Object Length -Sum).Sum; executableBytes=(Get-Item -LiteralPath $app).Length; executableSha256=(Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash.ToLowerInvariant(); executableSignature=(Get-QGSignature $app); registrations=$registrations; shortcuts=@(Get-QGProductShortcuts $productName) }
  $capturedDirectory = Join-Path $output 'product'
  $null = New-Item -ItemType Directory -Path $capturedDirectory
  $capturedBinary = Join-Path $capturedDirectory 'qgitgraph.exe'
  Copy-Item -LiteralPath $app -Destination $capturedBinary
  $capturedHash = (Get-FileHash -LiteralPath $capturedBinary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($capturedHash -ne $report.installed.executableSha256) { throw 'Captured installed executable differs from the verified installed product.' }
  $report.binary = [pscustomobject]@{ path=$capturedBinary; sha256=$capturedHash; bytes=$report.installed.executableBytes; source='exact installed NSIS payload retained before witnessed uninstall' }
  $report.results += [pscustomobject]@{ label='exact installed executable retained for matching desktop, resources and portable release'; status='passed'; sha256=$capturedHash }
  $report.status = 'passed'
} catch {
  $failure = $_.Exception.Message
  if ($report.status -ne 'blocked') { $report.status = 'failed' }
  $report.error = $failure
} finally {
  if ($null -ne $witness) {
    try {
      $report.uninstall = Remove-QGOwnedInstall $witness $ledger $ledgerFile
      $report.results += [pscustomobject]@{ label='uninstall executable, directory, shortcuts and registry all absent'; status='passed' }
    } catch { $report.status='failed'; $report.uninstall=[pscustomobject]@{ status='failed'; error=$_.Exception.Message; userDataDeleted=$false }; $failure=$_.Exception.Message }
  } elseif ($report.status -ne 'blocked') {
    $report.recovery = 'No validated ownership witness exists. No default user application was searched or removed. Inspect shared NSIS state manually or in the test VM.'
  }
  try { $report.cleanup = Stop-QGOwned $ledger; if (@($report.cleanup.remaining).Count -or @($report.cleanup.errors).Count) { $report.status='failed' } }
  catch { $report.status='failed'; $report.cleanup=[pscustomobject]@{ error=$_.Exception.Message } }
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  Write-QGJson $reportPath $report
}
Write-Output "Installation test $($report.status). Report: $reportPath"
if ($report.status -eq 'blocked') { exit 2 }
if ($report.status -ne 'passed') { throw $failure }
