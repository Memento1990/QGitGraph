param(
  [ValidateSet('Inspect','Snapshot','Cleanup','Signature','VerifyDriver','VerifyPorts','Metrics')][string]$Action,
  [int]$ProcessId,
  [string]$InputFile,
  [string]$Executable,
  [switch]$Library
)
$ErrorActionPreference = 'Stop'

function Get-QGIdentity($Item) {
  [pscustomobject]@{
    pid = [int]$Item.ProcessId
    parentPid = [int]$Item.ParentProcessId
    creationTime = $Item.CreationDate.ToUniversalTime().ToString('o')
    executable = $Item.ExecutablePath
    commandLine = $Item.CommandLine
  }
}
function Get-QGProcess([int]$Id) {
  $item = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
  if ($null -ne $item) { Get-QGIdentity $item }
}
function Test-QGIdentity($Expected, $Actual) {
  return $null -ne $Actual -and [int]$Expected.pid -eq [int]$Actual.pid -and [string]$Expected.creationTime -eq [string]$Actual.creationTime
}
function Get-QGOwned($Ownership) {
  $all = @(Get-CimInstance Win32_Process | ForEach-Object { Get-QGIdentity $_ })
  $lookup = @{}
  foreach ($item in $all) { $lookup[[int]$item.pid] = $item }
  $owned = @{}
  foreach ($item in @($Ownership.roots) + @($Ownership.known)) {
    if ($null -ne $item -and (Test-QGIdentity $item $lookup[[int]$item.pid])) { $owned[[int]$item.pid] = $lookup[[int]$item.pid] }
  }
  do {
    $changed = $false
    foreach ($item in $all) {
      if ($owned.ContainsKey([int]$item.pid)) { continue }
      $parent = $owned[[int]$item.parentPid]
      if ($null -ne $parent -and [DateTime]$item.creationTime -ge [DateTime]$parent.creationTime) {
        $owned[[int]$item.pid] = $item
        $changed = $true
      }
    }
  } while ($changed)
  return @($owned.Values | Sort-Object creationTime,pid)
}
function Stop-QGOwned($Ownership) {
  $current = @(Get-QGOwned $Ownership)
  $stopped = @()
  $errors = @()
  foreach ($item in @($current | Sort-Object creationTime -Descending)) {
    # Input-method, accessibility and system broker processes are not application
    # owned merely because Windows starts them on behalf of a window.
    if ($item.executable -and $item.executable -match '(?i)\\(?:SogouInput|Microsoft Shared\\ink)\\|\\(?:ctfmon|TextInputHost|TabTip)\.exe$') { continue }
    $actual = Get-QGProcess ([int]$item.pid)
    if (-not (Test-QGIdentity $item $actual)) { continue }
    try { Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop; $stopped += $item }
    catch { $errors += [pscustomobject]@{ pid=$item.pid; message=$_.Exception.Message } }
  }
  $remaining = @()
  foreach ($item in $current) {
    if ($item.executable -and $item.executable -match '(?i)\\(?:SogouInput|Microsoft Shared\\ink)\\|\\(?:ctfmon|TextInputHost|TabTip)\.exe$') { continue }
    if (Test-QGIdentity $item (Get-QGProcess ([int]$item.pid))) { $remaining += $item }
  }
  return [pscustomobject]@{ stopped=$stopped; remaining=$remaining; errors=$errors; scope='PID plus exact creation time and observed descendants only; no process-name termination.' }
}
function Get-QGSignature([string]$Path) {
  $path = (Resolve-Path -LiteralPath $Path).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  [pscustomobject]@{
    status = $signature.Status.ToString()
    subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
function Write-QGJson([string]$Path, $Value) {
  $full = [IO.Path]::GetFullPath($Path)
  $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($full)) -Force
  [IO.File]::WriteAllText($full, ($Value | ConvertTo-Json -Depth 30) + "`n", (New-Object Text.UTF8Encoding($false)))
}
function Wait-QGCondition([scriptblock]$Condition, [int]$TimeoutMilliseconds = 30000, [string]$Label = 'condition') {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  do {
    if (& $Condition) { return }
    # Polling interval only. Completion always depends on the observed condition.
    Start-Sleep -Milliseconds 125
  } while ($clock.ElapsedMilliseconds -lt $TimeoutMilliseconds)
  throw "Timed out waiting for $Label"
}

if ($Library) { return }
switch ($Action) {
  'Inspect' { $result = Get-QGProcess $ProcessId; if ($null -eq $result) { throw 'The spawned process exited before its identity could be recorded.' } }
  'Snapshot' { $ownership = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json; $result = @(Get-QGOwned $ownership) }
  'Cleanup' { $ownership = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json; $result = Stop-QGOwned $ownership }
  'Metrics' {
    $ownership = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
    $current = @(Get-QGOwned $ownership)
    $metrics = @()
    foreach ($item in $current) {
      $native = Get-Process -Id ([int]$item.pid) -ErrorAction SilentlyContinue
      if ($null -eq $native -or -not (Test-QGIdentity $item (Get-QGProcess ([int]$item.pid)))) { continue }
      $metrics += [pscustomobject]@{ pid=$item.pid; parentPid=$item.parentPid; creationTime=$item.creationTime; executable=$item.executable; workingSetBytes=$native.WorkingSet64; privateBytes=$native.PrivateMemorySize64; cpuSeconds=$native.TotalProcessorTime.TotalSeconds }
    }
    $result = [pscustomobject]@{ at=[DateTime]::UtcNow.ToString('o'); processes=$metrics; logicalProcessors=[Environment]::ProcessorCount }
  }
  'VerifyPorts' {
    $ownership = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
    $owned = @(Get-QGOwned $ownership)
    $ownedIds = @($owned | ForEach-Object { [int]$_.pid })
    $listeners = @()
    foreach ($port in @($ownership.ports.webdriver, $ownership.ports.native)) {
      $connections = @(Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue)
      if ($connections.Count -eq 0) { throw "Run port $port has no listener yet." }
      foreach ($connection in $connections) {
        if ($ownedIds -notcontains [int]$connection.OwningProcess) { throw "Run port $port belongs to a process outside this run." }
        if ($connection.LocalAddress -notin @('127.0.0.1', '::1')) { throw "Run port $port is not loopback-only." }
        $listeners += [pscustomobject]@{ port=[int]$port; pid=[int]$connection.OwningProcess; address=$connection.LocalAddress }
      }
    }
    $result = $listeners
  }
  'Signature' { $result = Get-QGSignature $Executable }
  'VerifyDriver' {
    $result = Get-QGSignature $Executable
    if ($result.status -ne 'Valid' -or $result.subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'WebDriver requires a valid Microsoft Corporation Authenticode signature.' }
    $version = ([string](& $Executable --version)).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(?:MSEdgeDriver|Microsoft Edge WebDriver)\s+\d+\.\d+\.\d+\.\d+(?:\s|$)') { throw 'The verified binary is not Microsoft Edge WebDriver.' }
    $result | Add-Member -NotePropertyName version -NotePropertyValue $version
  }
  default { throw 'An explicit process-helper action is required.' }
}
ConvertTo-Json -InputObject $result -Depth 20 -Compress
