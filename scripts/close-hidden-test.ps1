param([Parameter(Mandatory=$true)][string]$OwnershipFile, [Parameter(Mandatory=$true)][string]$OutputFile)
# Hidden windows have no special ownership exemption. Never enumerate by name.
& (Join-Path $PSScriptRoot 'close-test-window.ps1') -OwnershipFile $OwnershipFile -OutputFile $OutputFile
