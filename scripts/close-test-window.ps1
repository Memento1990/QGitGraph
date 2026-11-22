param([Parameter(Mandatory=$true)][string]$OwnershipFile, [Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/windows-processes.ps1') -Library
$ownership = Get-Content -LiteralPath $OwnershipFile -Raw | ConvertFrom-Json
if (-not $ownership.runId -or @($ownership.roots).Count -eq 0) { throw 'An explicit run-owned PID/creation-time ledger is required.' }
$result = Stop-QGOwned $ownership
Write-QGJson $OutputFile $result
if (@($result.remaining).Count -or @($result.errors).Count) { throw 'Run-owned process cleanup was incomplete; see the output JSON.' }
