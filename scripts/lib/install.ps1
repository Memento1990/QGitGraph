# Dot-source only. Helpers never discover a user installation for deletion.
. (Join-Path $PSScriptRoot 'windows-processes.ps1') -Library
function Get-QGProductRegistrations([string]$ProductName) {
  $result = @()
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($entry in @(Get-ChildItem -LiteralPath $root)) {
      $value = Get-ItemProperty -LiteralPath $entry.PSPath
      if ($value.DisplayName -eq $ProductName -or $value.PSChildName -eq $ProductName -or $value.PSChildName -eq 'app.qgitgraph.desktop') {
        $result += [pscustomobject]@{ key=$entry.Name; displayName=$value.DisplayName; installLocation=$value.InstallLocation; uninstallString=$value.UninstallString; displayVersion=$value.DisplayVersion }
      }
    }
  }
  return $result
}
function Get-QGProductShortcuts([string]$ProductName) {
  $result = @()
  $shell = New-Object -ComObject WScript.Shell
  foreach ($root in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu')) | Select-Object -Unique) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
      $shortcut = $shell.CreateShortcut($file.FullName)
      if ($file.BaseName -eq $ProductName -or [IO.Path]::GetFileName($shortcut.TargetPath) -ieq 'qgitgraph.exe' -or $file.Directory.Name -eq $ProductName) {
        $result += [pscustomobject]@{ path=$file.FullName; target=$shortcut.TargetPath }
      }
    }
  }
  return $result
}
function Test-QGSamePath([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  # NSIS writes InstallLocation with one outer quote pair. Do not strip or
  # reinterpret embedded quotes, arguments, or an uninstall command line.
  if ($Left.Length -ge 2 -and $Left[0] -eq '"' -and $Left[$Left.Length-1] -eq '"') { $Left = $Left.Substring(1,$Left.Length-2) }
  if ($Right.Length -ge 2 -and $Right[0] -eq '"' -and $Right[$Right.Length-1] -eq '"') { $Right = $Right.Substring(1,$Right.Length-2) }
  return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\')
}
function Invoke-QGProgram([string]$File, [string]$Arguments, $ProcessLedger, [string]$LedgerFile, [int]$TimeoutSeconds = 180) {
  $process = New-Object Diagnostics.Process
  $process.StartInfo.FileName = [IO.Path]::GetFullPath($File)
  $process.StartInfo.Arguments = $Arguments
  $process.StartInfo.UseShellExecute = $false
  try {
    if (-not $process.Start()) { throw 'Failed to start the test-owned installer/uninstaller.' }
    # The retained process handle preserves creation time and exit code even if
    # a short-lived NSIS launcher exits before the slower CIM query returns.
    $started = $process.StartTime.ToUniversalTime()
    $launch = [pscustomobject]@{ pid=$process.Id; creationTime=$started.ToString('o'); executable=$process.StartInfo.FileName; arguments=$Arguments; source='retained process handle'; exitCode=$null }
    if (-not $ProcessLedger.PSObject.Properties['launches']) { $ProcessLedger | Add-Member -NotePropertyName launches -NotePropertyValue @() }
    $ProcessLedger.launches = @($ProcessLedger.launches) + @($launch)
    Write-QGJson $LedgerFile $ProcessLedger
    $identity = Get-QGProcess $process.Id
    if ($null -ne $identity) {
      if ([Math]::Abs((([DateTime]$identity.creationTime).ToUniversalTime() - $started).Ticks) -gt 10) { throw 'Installer PID was reused before CIM identity capture.' }
      $ProcessLedger.roots = @($ProcessLedger.roots) + @($identity)
    } elseif (-not $process.WaitForExit(1000)) {
      throw 'Cannot establish the identity of a still-running test installer/uninstaller.'
    }
    Write-QGJson $LedgerFile $ProcessLedger
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.HasExited) {
      $ProcessLedger.known = @(Get-QGOwned $ProcessLedger)
      Write-QGJson $LedgerFile $ProcessLedger
      if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'Timed out waiting for the test-owned installer/uninstaller.' }
      Start-Sleep -Milliseconds 125
      $process.Refresh()
    }
    $process.WaitForExit()
    $launch.exitCode = $process.ExitCode
    Write-QGJson $LedgerFile $ProcessLedger
    return $process.ExitCode
  } finally { $process.Dispose() }
}
function Remove-QGOwnedInstall($Witness, $Ledger, [string]$LedgerFile) {
  if (-not $Witness.runId -or -not $Witness.absentBefore -or -not $Witness.installCompleted) { throw 'Recovery requires a completed run-owned installation witness with an absent-before precondition.' }
  $directory = [IO.Path]::GetFullPath($Witness.destination)
  $uninstaller = [IO.Path]::GetFullPath($Witness.uninstaller)
  if (-not $uninstaller.StartsWith($directory.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstaller is outside the witnessed run installation.' }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'The witnessed uninstaller is missing; no default user installation is searched.' }
  if ((Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Witness.uninstallerSha256) { throw 'Witnessed uninstaller hash changed.' }
  $registration = @(Get-QGProductRegistrations $Witness.productName)
  if ($registration.Count -ne 1 -or -not (Test-QGSamePath $registration[0].installLocation $directory)) { throw 'Current installer registration no longer matches the owned installation. Manual/VM recovery is required.' }
  $exitCode = Invoke-QGProgram $uninstaller '/S' $Ledger $LedgerFile
  if ($exitCode -ne 0) { throw "Uninstaller exited $exitCode" }
  Wait-QGCondition -TimeoutMilliseconds 45000 -Label 'application, installation directory, shortcut and registry removal' -Condition {
    -not (Test-Path -LiteralPath $directory) -and @(Get-QGProductRegistrations $Witness.productName).Count -eq 0 -and @(Get-QGProductShortcuts $Witness.productName).Count -eq 0
  }
  return [pscustomobject]@{ exitCode=$exitCode; executableRemaining=(Test-Path -LiteralPath (Join-Path $directory 'qgitgraph.exe')); directoryRemaining=(Test-Path -LiteralPath $directory); registrationsRemaining=@(Get-QGProductRegistrations $Witness.productName); shortcutsRemaining=@(Get-QGProductShortcuts $Witness.productName); status='passed'; userDataDeleted=$false }
}
