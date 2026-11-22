param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/install.ps1')
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new process regression directory.' }
$null = New-Item -ItemType Directory -Path $output
$ledger = [pscustomobject]@{ schemaVersion=1; runId=[Guid]::NewGuid().ToString(); roots=@(); known=@() }
$ledgerFile = Join-Path $output 'process-ownership.json'
$report = [ordered]@{ schemaVersion=1; kind='installer-process'; status='running'; results=@(); cleanup=$null }
try {
  $cases = @(
    [pscustomobject]@{ label='immediate successful exit'; file=$env:ComSpec; arguments='/d /c exit 0'; expected=0 },
    [pscustomobject]@{ label='immediate nonzero exit is retained'; file=$env:ComSpec; arguments='/d /c exit 23'; expected=23 },
    [pscustomobject]@{ label='observable running process exits normally'; file=(Join-Path $PSHOME 'powershell.exe'); arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 2500; exit 0"'; expected=0 }
  )
  foreach ($case in $cases) {
    $exitCode = Invoke-QGProgram $case.file $case.arguments $ledger $ledgerFile 30
    if ($exitCode -ne $case.expected) { throw "Wrong exit code for $($case.label): $exitCode" }
    $launch = @($ledger.launches)[-1]
    if (-not $launch.creationTime -or $launch.source -ne 'retained process handle' -or $launch.exitCode -ne $case.expected) { throw 'Retained handle identity or exit status missing.' }
    $report.results += [pscustomobject]@{ label=$case.label; status='passed'; exitCode=$exitCode; pid=$launch.pid; creationTime=$launch.creationTime }
  }
  $report.status = 'passed'
} catch { $report.status='failed'; $report.error=$_.Exception.Message; throw }
finally {
  $report.cleanup = Stop-QGOwned $ledger
  if (@($report.cleanup.remaining).Count -or @($report.cleanup.errors).Count) { $report.status='failed' }
  Write-QGJson (Join-Path $output 'test-report.json') $report
}
if ($report.status -ne 'passed') { throw 'Installer process regression failed.' }
Write-Output "Installer process regression passed. Report: $output"
