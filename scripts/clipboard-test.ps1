param([ValidateSet('Save','Read','Restore')][string]$Action,[string]$File)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
if([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA'){throw 'Clipboard verification requires an STA PowerShell process.'}
function Invoke-Clipboard([scriptblock]$Work){for($n=0;$n -lt 20;$n++){try{return & $Work}catch{if($n -eq 19){throw};Start-Sleep -Milliseconds 100}}}
if($Action -eq 'Save'){
 if((Invoke-Clipboard{[Windows.Forms.Clipboard]::ContainsImage()}) -or (Invoke-Clipboard{[Windows.Forms.Clipboard]::ContainsFileDropList()})){throw 'Clipboard has non-text user data; run clipboard tests in a dedicated user/profile instead of overwriting it.'}
 $text=Invoke-Clipboard{if([Windows.Forms.Clipboard]::ContainsText()){[Windows.Forms.Clipboard]::GetText()}else{$null}}
 $state=[pscustomobject]@{text=$text}
 [IO.File]::WriteAllText($File,($state|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
}elseif($Action -eq 'Read'){[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);[Console]::Write((Invoke-Clipboard{[Windows.Forms.Clipboard]::GetText()}))}
else{$state=[IO.File]::ReadAllText($File)|ConvertFrom-Json;Invoke-Clipboard{if($null -eq $state.text){[Windows.Forms.Clipboard]::Clear()}else{[Windows.Forms.Clipboard]::SetText([string]$state.text)}}}
