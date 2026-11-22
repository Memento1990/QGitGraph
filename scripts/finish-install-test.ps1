param(
  [Parameter(Mandatory=$true)][string]$WitnessFile,
  [Parameter(Mandatory=$true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/install.ps1')
if (Test-Path -LiteralPath $OutputFile) { throw 'Recovery report must be a new file.' }
$witness = Get-Content -LiteralPath $WitnessFile -Raw | ConvertFrom-Json
$ledgerFile = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputFile))) ('recovery-processes-'+[Guid]::NewGuid().ToString()+'.json')
$ledger = [pscustomobject]@{ schemaVersion=1; runId=$witness.runId; roots=@(); known=@() }
$result = [ordered]@{ kind='installer-recovery'; status='running'; startedAt=[DateTime]::UtcNow.ToString('o'); witness=$WitnessFile }
try { $result.uninstall=Remove-QGOwnedInstall $witness $ledger $ledgerFile; $result.status='passed' }
catch { $result.status='failed'; $result.error=$_.Exception.Message }
finally { $result.cleanup=Stop-QGOwned $ledger; $result.finishedAt=[DateTime]::UtcNow.ToString('o'); Write-QGJson $OutputFile $result }
if ($result.status -ne 'passed') { throw $result.error }
