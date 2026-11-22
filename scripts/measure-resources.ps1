param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$Driver,
  [string]$TauriDriver,
  [string]$Installer,
  [string]$Git,
  [ValidateRange(60,3600)][int]$Seconds = 60,
  [ValidateRange(1,50)][int]$InteractiveSamples = 5,
  [long]$ReferenceExecutableBytes,
  [long]$ReferenceInstallerBytes,
  [string]$NodeExecutable = 'node.exe'
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'measure-resources.mjs'),'--binary',$Executable,'--output',$OutputDirectory,'--seconds',"$Seconds",'--interactive-samples',"$InteractiveSamples")
if ($Driver) { $arguments += @('--driver',$Driver) }
if ($TauriDriver) { $arguments += @('--tauri-driver',$TauriDriver) }
if ($Installer) { $arguments += @('--installer',$Installer) }
if ($Git) { $arguments += @('--git',$Git) }
if ($ReferenceExecutableBytes -gt 0) { $arguments += @('--reference-exe-bytes',"$ReferenceExecutableBytes") }
if ($ReferenceInstallerBytes -gt 0) { $arguments += @('--reference-installer-bytes',"$ReferenceInstallerBytes") }
# All profile/HOME/fixture/session creation and finally cleanup is centralized.
& $NodeExecutable @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
