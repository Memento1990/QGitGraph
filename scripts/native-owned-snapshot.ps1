param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
$windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
$items=@()
foreach($window in $windows){$nodes=@();$all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);for($i=0;$i -lt [Math]::Min($all.Count,500);$i++){$e=$all.Item($i);$nodes += [pscustomobject]@{name=$e.Current.Name;id=$e.Current.AutomationId;type=$e.Current.ControlType.ProgrammaticName;class=$e.Current.ClassName}};$items += [pscustomobject]@{pid=$ProcessId;name=$window.Current.Name;class=$window.Current.ClassName;nodes=$nodes}}
[IO.File]::WriteAllText($OutputFile,($items|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
Write-Output "Snapshot of test-owned process $ProcessId saved."
