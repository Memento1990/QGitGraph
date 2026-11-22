param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Repository,[Parameter(Mandatory=$true)][string]$IsolatedHome,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$p=Start-Process -FilePath $Executable -ArgumentList @('--git-terminal-v2',('"'+$Repository+'"'),('"'+$IsolatedHome+'"')) -PassThru
$marker=Join-Path $IsolatedHome 'console-result.txt'
$command='$PWD.Path | Set-Content -LiteralPath '''+$marker.Replace("'","''")+''' -Encoding UTF8; exit'
& (Join-Path $PSScriptRoot 'native-console-input.ps1') -ProcessId $p.Id -CommandText $command
$clock=[Diagnostics.Stopwatch]::StartNew()
while(-not(Test-Path -LiteralPath $marker) -and $clock.ElapsedMilliseconds -lt 15000){Start-Sleep -Milliseconds 100}
if(-not(Test-Path -LiteralPath $marker)){throw 'Owned terminal did not accept input and produce output.'}
$value=[IO.File]::ReadAllText($marker).Trim([char]0xfeff).Trim()
if([IO.Path]::GetFullPath($value) -ne [IO.Path]::GetFullPath($Repository)){throw "Terminal cwd mismatch: $value"}
if(-not $p.WaitForExit(10000)){throw 'Owned terminal did not exit after exit command.'}
[pscustomobject]@{status='passed';label='real native console accepts input, prints repository cwd, exits';repository=$Repository;pid=$p.Id;exitCode=$p.ExitCode} | ConvertTo-Json | Set-Content -LiteralPath $OutputFile -Encoding UTF8
