param([Parameter(Mandatory=$true)][string]$OutputFile,[Parameter(Mandatory=$true)][string]$AllowedDirectory)
$ErrorActionPreference='Stop'
$processes=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$AllowedDirectory*" })
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$windows=@()
foreach($p in $processes){
 $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$p.ProcessId)
 $found=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
 foreach($w in $found){
   $nodes=@();$all=$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
   for($i=0;$i -lt [Math]::Min($all.Count,200);$i++){ $n=$all.Item($i);$nodes += [pscustomobject]@{name=$n.Current.Name;id=$n.Current.AutomationId;type=$n.Current.ControlType.ProgrammaticName;class=$n.Current.ClassName} }
   $windows += [pscustomobject]@{pid=$p.ProcessId;name=$w.Current.Name;class=$w.Current.ClassName;nodes=$nodes}
 }
}
[IO.File]::WriteAllText($OutputFile,($windows|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
Write-Output "Owned-window accessibility snapshot saved."
