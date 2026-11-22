param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [string]$NodeExecutable = 'node.exe'
)
$ErrorActionPreference='Stop'
# One implementation owns whitelist, notice verification, ZIP SHA inventory and
# refusal to overwrite. Never archive with a wildcard that drops dotfiles.
& $NodeExecutable (Join-Path $PSScriptRoot 'archive-source.mjs') --source $SourceDirectory --output $OutputDirectory
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
