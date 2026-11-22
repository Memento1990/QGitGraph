param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedExeSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedInstallerSha256,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Destination,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$ProfileState,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$RollbackInstaller,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedCurrentVersion,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPriorExeSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedRollbackInstallerSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedNewVersion,
  [ValidateRange(1,2147483647)][int]$ExpectedProcessId,
  [string]$ExpectedCreationTime,
  [switch]$InspectOnly,
  [string]$NodeExecutable = 'node.exe'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/install.ps1')

function Assert-QGPlainPath([string]$Path) {
  if (-not $Path -or $Path -notmatch '^[A-Za-z]:[\\/]') { throw 'Supply an explicit local absolute path; relative and UNC paths are not permitted.' }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -notmatch '^[A-Za-z]:\\' -or $full.Length -le 3 -or $full -match '[\x00-\x1f"*?<>|]' -or $full.Substring(2).Contains(':')) { throw 'Use a local absolute non-root path without command-line metacharacters or alternate streams.' }
  for ($part = $full; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -LiteralPath $part -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) { throw "Links are not permitted: $part" }
    }
  }
  return $full.TrimEnd('\')
}
function Test-QGWithin([string]$Parent, [string]$Child) { return (Test-QGSamePath $Parent $Child) -or $Child.StartsWith($Parent.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) }
function Get-QGUpgradeTree([string]$Root) {
  $null = Assert-QGPlainPath $Root
  # Inspect metadata without following links before reading even the manifest.
  $pending = New-Object 'Collections.Generic.Queue[string]'; $pending.Enqueue($Root)
  $entries = @()
  while ($pending.Count) {
    foreach ($item in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) { throw "Linked installation entry: $($item.FullName)" }
      $entries += $item
      if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
    }
  }
  $manifest = [IO.File]::ReadAllText((Join-Path $Root 'notices\manifest.json')) | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or -not $manifest.ownedFiles) { throw 'Missing supported notice ownership manifest.' }
  $allowed = @{'qgitgraph.exe'=$true; 'uninstall.exe'=$true; 'notices/manifest.json'=$true}
  # Older installations omit the application license; include and hash it only when present.
  $licensePath = Join-Path $Root 'LICENSE'
  if (Test-Path -LiteralPath $licensePath -PathType Leaf) {
    if ((Get-Item -LiteralPath $licensePath -Force).Length -le 0) { throw 'Application LICENSE must be nonempty when present.' }
    $allowed['LICENSE'] = $true
  }
  foreach ($property in $manifest.ownedFiles.PSObject.Properties) {
    $relative = $property.Name
    if (($relative -ne 'THIRD_PARTY_NOTICES.md' -and -not $relative.StartsWith('notices/')) -or $relative -match '[\\\x00-\x1f\x7f:<>"|?*]' -or @($relative.Split('/') | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' }).Count -or $property.Value -cnotmatch '^[a-f0-9]{64}$') { throw 'Unsafe notice ownership entry.' }
    if ($allowed.ContainsKey($relative)) { throw 'Duplicate/reserved notice ownership entry.' }
    $allowed[$relative] = $true
  }
  foreach ($item in $entries) {
    $relative = $item.FullName.Substring($Root.Length+1).Replace('\','/')
    if ($item.PSIsContainer) {
      if (-not @($allowed.Keys | Where-Object { $_.StartsWith($relative+'/',[StringComparison]::OrdinalIgnoreCase) }).Count) { throw "Unexpected installation directory; inspect manually: $relative" }
    } elseif (-not $allowed.ContainsKey($relative)) { throw "Unexpected installation file; inspect manually: $relative" }
  }
  $files = @($entries | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName)
  if ($files.Count -ne $allowed.Count) { throw 'Installation is missing product-owned files.' }
  foreach ($file in $files) {
    if ($file.Name -like '*qgitgraph-test-probe*') { throw 'Build-only probe found in product.' }
    [pscustomobject]@{ path=$file.FullName.Substring($Root.Length+1).Replace('\','/'); bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
}
function Get-QGUpgradeInstances { return @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Test-QGSamePath $_.ExecutablePath $app) } | ForEach-Object { Get-QGIdentity $_ }) }
function Save-QGUpgradeState([string]$Label) {
  $null = Assert-QGPlainPath $profile
  $present = Test-Path -LiteralPath $profile -PathType Leaf
  $hash = $null
  if ($present) {
    $bytes = [IO.File]::ReadAllBytes($profile)
    $copy = Join-Path $output ($Label+'.state.json')
    # Copies only: never write, restore, parse or log the user's state contents.
    $stream = [IO.File]::Open($copy,[IO.FileMode]::CreateNew)
    try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    $hash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $snapshot = [pscustomobject]@{ stage=$Label; at=[DateTime]::UtcNow.ToString('o'); exists=$present; sha256=$hash }
  $report.stateTrajectory += $snapshot
  return $snapshot
}

function Request-QGNormalClose($Identity) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  if (-not ('QGitGraphUpgradeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class QGitGraphUpgradeWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
  }
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$Identity.pid)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  $candidates = @($windows | Where-Object { $_.Current.ClassName -ceq 'Tauri Window' -and $_.Current.Name -ceq 'QGitGraph' -and $_.Current.NativeWindowHandle -ne 0 })
  if ($candidates.Count -ne 1) { throw 'Require one exact QGitGraph Tauri window belonging to the approved process. No window was closed.' }
  $handle = [IntPtr]$candidates[0].Current.NativeWindowHandle
  $actual = Get-QGProcess ([int]$Identity.pid)
  [uint32]$windowPid = 0
  $null = [QGitGraphUpgradeWindow]::GetWindowThreadProcessId($handle,[ref]$windowPid)
  $class = New-Object Text.StringBuilder 256
  $null = [QGitGraphUpgradeWindow]::GetClassNameW($handle,$class,256)
  if (-not (Test-QGIdentity $Identity $actual) -or -not (Test-QGSamePath $actual.executable $app) -or $windowPid -ne [uint32]$Identity.pid -or $class.ToString() -cne 'Tauri Window') { throw 'Approved process/window identity changed before normal close. No close request sent.' }
  # WM_CLOSE is the application's normal close path: no terminate/kill/WM_QUIT.
  if (-not [QGitGraphUpgradeWindow]::PostMessageW($handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'The exact normal close request could not be posted. No force-close was attempted.' }
  return [pscustomobject]@{ method='WM_CLOSE to exact observed Tauri Window'; pid=$Identity.pid; creationTime=$Identity.creationTime; windowHandle=$handle.ToInt64(); forced=$false }
}

$destinationPath = Assert-QGPlainPath $Destination
$profile = Assert-QGPlainPath $ProfileState
$output = Assert-QGPlainPath $OutputDirectory
if ([version]$ExpectedNewVersion -lt [version]$ExpectedCurrentVersion) { throw 'This upgrade helper never downgrades an existing installation.' }
# These explicit path/version/hash inputs pin each separately authorized run.
# There is no default destination, user-profile discovery or version bypass.
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifacts = Join-Path $project 'artifacts'
if ((Test-QGWithin $project $output) -and (-not (Test-QGWithin $artifacts $output) -or (Test-QGSamePath $artifacts $output))) { throw 'Private backups inside this project must be in a new artifacts subdirectory, never a release/source package.' }
foreach ($protected in @($destinationPath,[IO.Path]::GetDirectoryName($profile))) {
  if ((Test-QGWithin $protected $output) -or (Test-QGWithin $output $protected)) { throw 'Output must be outside the installation and profile trees.' }
}
if ((Test-QGWithin $output $project) -or (Test-Path -LiteralPath $output)) { throw 'Output must be absent: this script will create and own a new private backup directory.' }
if ([bool]$ExpectedProcessId -ne [bool]$ExpectedCreationTime) { throw 'Supply both ExpectedProcessId and its exact Get-QGProcess creationTime, or neither if the installed app is already closed.' }
$installerPath = Assert-QGPlainPath $Installer
$rollbackPath = Assert-QGPlainPath $RollbackInstaller
foreach ($file in @($installerPath,$rollbackPath)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installer not found: $file" } }
$null = New-Item -ItemType Directory -Path $output
# Backups contain private user state. Do not inherit a source/share directory ACL.
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $output -AclObject $acl
$runId = [Guid]::NewGuid().ToString()
$marker = [IO.File]::Open((Join-Path $output '.qgitgraph-local-upgrade'),[IO.FileMode]::CreateNew); $marker.Dispose()
$app = Join-Path $destinationPath 'qgitgraph.exe'
$ledgerFile = Join-Path $output 'process-ownership.json'
$ledger = [pscustomobject]@{ schemaVersion=1; runId=$runId; roots=@(); known=@() }
$report = [ordered]@{ schemaVersion=1; kind='local-upgrade'; runId=$runId; status='running'; startedAt=[DateTime]::UtcNow.ToString('o'); destination=$destinationPath; profileState=$profile; inspectOnly=[bool]$InspectOnly; expectedCurrentVersion=$ExpectedCurrentVersion; expectedPriorExeSha256=$ExpectedPriorExeSha256.ToLowerInvariant(); expectedNewVersion=$ExpectedNewVersion; expectedExeSha256=$ExpectedExeSha256.ToLowerInvariant(); expectedInstallerSha256=$ExpectedInstallerSha256.ToLowerInvariant(); expectedRollbackInstallerSha256=$ExpectedRollbackInstallerSha256.ToLowerInvariant(); privacy=[pscustomobject]@{ localOnly=$true; publicReleaseEligible=$false; containsPrivatePathsAndStateFingerprints=$true }; stateTrajectory=@(); installerStarted=$false; automaticRestore=$false; userAppRelaunched=$false }
$failure = $null
$baseline = $null
try {
  $registrations = @(Get-QGProductRegistrations 'QGitGraph')
  if ($registrations.Count -ne 1 -or -not (Test-QGSamePath $registrations[0].installLocation $destinationPath)) { throw 'Require exactly one QGitGraph registration at the approved destination; do not redirect registry or uninstall anything.' }
  $version = $registrations[0].displayVersion
  if ($version -cne $ExpectedCurrentVersion -or -not $registrations[0].key) { throw 'Require the independently supplied exact current registration version and an original registration key.' }
  $null = Assert-QGPlainPath $app
  if ((Get-Item -LiteralPath $app).VersionInfo.ProductVersion -cne $ExpectedCurrentVersion) { throw 'Registered and installed executable versions differ from the supplied current version.' }
  $report.registrationBefore = $registrations[0]
  $report.installer = [pscustomobject]@{ path=$installerPath; signature=(Get-QGSignature $installerPath) }
  if ($report.installer.signature.sha256 -ine $ExpectedInstallerSha256) { throw 'Upgrade installer does not match the independently supplied SHA-256.' }
  $report.rollbackInstaller = [pscustomobject]@{ path=$rollbackPath; signature=(Get-QGSignature $rollbackPath) }
  if ($report.rollbackInstaller.signature.sha256 -ine $ExpectedRollbackInstallerSha256) { throw 'Rollback installer does not match the independently supplied SHA-256.' }
  $currentInstallerVersion = '^' + [regex]::Escape($ExpectedCurrentVersion) + '(?:\.0)?$'
  $newInstallerVersion = '^' + [regex]::Escape($ExpectedNewVersion) + '(?:\.0)?$'
  if ((Get-Item -LiteralPath $rollbackPath).VersionInfo.ProductVersion -cnotmatch $currentInstallerVersion) { throw 'Rollback installer version does not match the supplied prior version.' }
  if ((Get-Item -LiteralPath $installerPath).VersionInfo.ProductVersion -cnotmatch $newInstallerVersion) { throw 'Upgrade installer version does not match the supplied new version.' }
  $before = @(Get-QGUpgradeTree $destinationPath)
  $oldExeHash = ($before | Where-Object { $_.path -eq 'qgitgraph.exe' }).sha256
  if ($oldExeHash -ine $ExpectedPriorExeSha256) { throw 'Current executable does not match the independently supplied prior installation SHA-256.' }
  $instances = @(Get-QGUpgradeInstances)
  $identity = if ($ExpectedProcessId) { Get-QGProcess $ExpectedProcessId } else { $null }
  if ($ExpectedProcessId -and ($null -eq $identity -or $identity.creationTime -cne $ExpectedCreationTime -or -not (Test-QGSamePath $identity.executable $app))) { throw 'Expected PID/path/creation time no longer matches. Inspect again; never substitute another process.' }
  if ($instances.Count -gt 1 -or ($instances.Count -and (-not $ExpectedProcessId -or $instances[0].pid -ne $ExpectedProcessId))) { throw 'An unapproved instance is running at the target path. No process was closed.' }
  $report.approvedCloseIdentity = $identity
  $null = Save-QGUpgradeState 'before-close'
  Write-QGJson (Join-Path $output 'old-install-files.json') $before
  if ($InspectOnly) { $report.status='inspected'; return }
  if ($identity) {
    Write-Host 'Requesting normal application close. Confirm any app/OS prompt so it can flush preferences; timeout is 30 seconds, with no forced termination.'
    $process = Get-Process -Id $ExpectedProcessId
    try {
      $actual = Get-QGProcess $ExpectedProcessId
      if (-not (Test-QGIdentity $identity $actual) -or -not (Test-QGSamePath $actual.executable $app) -or [Math]::Abs(($process.StartTime.ToUniversalTime() - ([DateTime]$identity.creationTime).ToUniversalTime()).Ticks) -gt 10) { throw 'Process identity changed before normal close.' }
      $report.normalClose = Request-QGNormalClose $identity
      if (-not $process.WaitForExit(30000)) { throw 'Application did not exit within 30 seconds. No force-close was attempted; finish/cancel any prompt manually.' }
    } finally { $process.Dispose() }
  }
  if (@(Get-QGUpgradeInstances).Count) { throw 'Target application is still running; no upgrade attempted.' }
  $baseline = Save-QGUpgradeState 'after-close'
  $backup = Join-Path $output 'old-installation'
  foreach ($file in $before) {
    $source = Join-Path $destinationPath $file.path
    $null = Assert-QGPlainPath $source
    $target = Join-Path $backup $file.path
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force
    [IO.File]::Copy($source,$target,$false)
  }
  $backedUp = @(Get-QGUpgradeTree $backup)
  if (($before | ConvertTo-Json -Depth 5 -Compress) -cne ($backedUp | ConvertTo-Json -Depth 5 -Compress) -or ($before | ConvertTo-Json -Depth 5 -Compress) -cne (@(Get-QGUpgradeTree $destinationPath) | ConvertTo-Json -Depth 5 -Compress)) { throw 'Old installation changed or the complete backup failed hash verification.' }
  & $NodeExecutable (Join-Path $PSScriptRoot 'verify-notices.mjs') --directory $backup --output (Join-Path $output 'old-notice-verification.json')
  if ($LASTEXITCODE -ne 0) { throw 'Old notice/resource backup failed verification.' }
  Write-QGJson (Join-Path $output 'upgrade-witness.json') ([pscustomobject]@{ runId=$runId; userOwnedInstallation=$true; registration=$registrations[0]; backup=$backup; files='old-install-files.json'; state=$baseline; rollbackInstaller=$report.rollbackInstaller; noAutomaticDowngrade=$true })
  $currentRegistrations = @(Get-QGProductRegistrations 'QGitGraph')
  if (($registrations | ConvertTo-Json -Compress) -cne ($currentRegistrations | ConvertTo-Json -Compress) -or @(Get-QGUpgradeInstances).Count) { throw 'Registration/process precondition changed before installer launch.' }
  $preInstall = Save-QGUpgradeState 'before-installer'
  if ($preInstall.exists -ne $baseline.exists -or $preInstall.sha256 -ne $baseline.sha256) { throw 'User state changed after normal close; inspect manually rather than overwrite/restore it.' }
  if ((Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash -ine $report.installer.signature.sha256) { throw 'Installer changed after inspection.' }
  $report.installerStarted = $true
  Write-QGJson (Join-Path $output 'upgrade-report.json') $report
  # NSIS requires /D last, without quotes. No user PID ever enters this ledger.
  $exitCode = Invoke-QGProgram $installerPath ("/S /D=$destinationPath") $ledger $ledgerFile 180
  if ($exitCode -ne 0) { throw "Installer exited $exitCode. Do not automatically downgrade or restore state." }
  Wait-QGCondition -TimeoutMilliseconds 30000 -Label 'owned installer descendants to exit (no force termination)' -Condition { $ledger.known=@(Get-QGOwned $ledger); Write-QGJson $ledgerFile $ledger; @($ledger.known).Count -eq 0 }
  $afterState = Save-QGUpgradeState 'after-installer'
  if ($afterState.exists -ne $baseline.exists -or $afterState.sha256 -ne $baseline.sha256) { throw 'User state changed during upgrade. Preserved all snapshots; manual attention required, no state restore attempted.' }
  $after = @(Get-QGUpgradeTree $destinationPath)
  $registrationAfter = @(Get-QGProductRegistrations 'QGitGraph')
  if ($registrationAfter.Count -ne 1 -or -not (Test-QGSamePath $registrationAfter[0].installLocation $destinationPath) -or $registrationAfter[0].key -cne $registrations[0].key -or $registrationAfter[0].displayVersion -cne $ExpectedNewVersion) { throw 'Upgrade registration does not match the supplied new version at the original key/destination.' }
  if ((Get-Item -LiteralPath $app).VersionInfo.ProductVersion -cne $ExpectedNewVersion -or ($after | Where-Object { $_.path -eq 'qgitgraph.exe' }).sha256 -ine $ExpectedExeSha256) { throw 'Installed version or executable SHA-256 does not match the independently supplied new payload.' }
  & $NodeExecutable (Join-Path $PSScriptRoot 'verify-notices.mjs') --directory $destinationPath --output (Join-Path $output 'notice-verification.json')
  if ($LASTEXITCODE -ne 0) { throw 'Installed notice hashes/MPL source archives failed verification.' }
  $notice = [IO.File]::ReadAllText((Join-Path $output 'notice-verification.json')) | ConvertFrom-Json
  if ($notice.status -ne 'passed' -or $notice.checkedFileCount -lt 1) { throw 'Notice verifier did not report actual passing checks.' }
  Write-QGJson (Join-Path $output 'installed-files.json') $after
  $report.installed = [pscustomobject]@{ registration=$registrationAfter[0]; fileCount=$after.Count; signature=(Get-QGSignature $app); noticesVerified=$true; completeStateBytesUnchanged=$true; trustAndPreferences='Preserved by whole-state byte identity after normal close; no GUI launch/profile migration tested.' }
  $report.status = 'passed'
} catch {
  $failure = $_.Exception.Message
  $report.status = if ($report.installerStarted) { 'needs-attention' } else { 'blocked' }
  $report.error = $failure
} finally {
  try {
    $finalState = Save-QGUpgradeState 'final'
    if ($baseline -and ($finalState.exists -ne $baseline.exists -or $finalState.sha256 -ne $baseline.sha256)) { $report.status='needs-attention'; $report.stateChangedAfterClose=$true }
  } catch { $report.status='needs-attention'; $report.stateInspectionError=$_.Exception.Message }
  try {
    $report.remainingInstallerProcesses = @(Get-QGOwned $ledger); Write-QGJson $ledgerFile $ledger
    if ($report.status -eq 'passed' -and $report.remainingInstallerProcesses.Count) { $report.status='needs-attention'; $failure='Installer-owned processes remain; no force termination was attempted.' }
  } catch { $report.processInspectionError=$_.Exception.Message; $report.status='needs-attention'; $failure=$_.Exception.Message }
  $report.recovery = 'Private complete old-file and state backups only. Never uninstall, automatically downgrade/restore, terminate the user app or relaunch it. If interrupted, inspect installer/process/registry/state evidence before manual recovery; a running installer is not force-stopped.'
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  Write-QGJson (Join-Path $output 'upgrade-report.json') $report
  if ($report.status -eq 'passed') {
    $installedExe = $after | Where-Object { $_.path -eq 'qgitgraph.exe' }
    Write-QGJson (Join-Path $output 'installer-report.json') ([pscustomobject]@{
      schemaVersion=1; kind='installer'; status='passed'; startedAt=$report.startedAt; finishedAt=$report.finishedAt
      scope="Actual existing-user $ExpectedCurrentVersion to $ExpectedNewVersion upgrade only; not fresh-install, uninstall, clean-VM or GUI startup coverage."
      binary=[pscustomobject]@{ sha256=$installedExe.sha256; bytes=$installedExe.bytes }
      installer=[pscustomobject]@{ sha256=$report.installer.signature.sha256; bytes=(Get-Item -LiteralPath $installerPath).Length; signature=$report.installer.signature }
      uninstall=[pscustomobject]@{ status='not-run'; reason='Existing user installation deliberately retained.' }
      results=@(
        [pscustomobject]@{ label='upgrade exact already-installed product preserving complete profile state bytes after normal close'; status='passed' },
        [pscustomobject]@{ label='exact original registration/destination, supplied new version and independently verified executable SHA-256'; status='passed' },
        [pscustomobject]@{ label='manifest notices/MPL resource tree hashes'; status='passed'; checkedFiles=$notice.checkedFileCount; mplArchives=$notice.mplArchives },
        [pscustomobject]@{ label='complete old installation backup hash verified and installed tree excludes build-only probe'; status='passed'; installedFileCount=$after.Count }
      )
    })
  }
  Write-Host "Local upgrade $($report.status). Private report: $(Join-Path $output 'upgrade-report.json')"
}
if ($failure) { throw $failure }
if ($report.status -eq 'needs-attention') { throw 'Upgrade requires manual attention. See the private report; no automatic restore, downgrade or force-close was attempted.' }
