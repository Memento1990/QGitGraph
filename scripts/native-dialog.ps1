param([Parameter(Mandatory=$true)][int]$ProcessId,[string]$Path,[switch]$Cancel)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QGNativeDialog {
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr window,string text);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wparam,string lparam);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
}
'@
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
$clock=[Diagnostics.Stopwatch]::StartNew()
$dialog=$null
while($clock.ElapsedMilliseconds -lt 15000){
 $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
 foreach($window in $windows){if($window.Current.ClassName -eq '#32770'){$dialog=$window;break}}
 if($dialog){
   $editReady=[QGNativeDialog]::GetDlgItem([IntPtr]$dialog.Current.NativeWindowHandle,1152)
   $inputCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1001')
   $nestedInputs=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,$inputCondition)
   foreach($candidate in $nestedInputs){if($candidate.Current.ClassName -eq 'Edit'){$editReady=[IntPtr]$candidate.Current.NativeWindowHandle;break}}
   if($Cancel -or $editReady -ne [IntPtr]::Zero){break}
   $dialog=$null
 };Start-Sleep -Milliseconds 100
}
if(-not $dialog){
 $debugWindows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
 $found=@();foreach($window in $debugWindows){$nodes=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);$found += [pscustomobject]@{name=$window.Current.Name;class=$window.Current.ClassName;nodes=@($nodes|ForEach-Object{[pscustomobject]@{name=$_.Current.Name;id=$_.Current.AutomationId;class=$_.Current.ClassName}})}}
 $found|ConvertTo-Json -Depth 8|Write-Output
 throw 'No native dialog with the observed input belongs to this test-owned application process.'
}
$handle=[IntPtr]$dialog.Current.NativeWindowHandle
if($Cancel){$button=[QGNativeDialog]::GetDlgItem($handle,2);if($button -eq [IntPtr]::Zero){throw 'Owned dialog has no cancel button.'};$null=[QGNativeDialog]::PostMessage($button,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero);Write-Output 'Cancelled owned native dialog.';exit}
if(-not [IO.Path]::IsPathRooted($Path)){throw 'A native dialog test requires an absolute run-owned path.'}
$edit=$editReady
if($edit -eq [IntPtr]::Zero){throw 'Observed native filename/folder input is missing.'}
$null=[QGNativeDialog]::SendMessage($edit,0x000c,[IntPtr]::Zero,$Path)
$button=[QGNativeDialog]::GetDlgItem($handle,1)
if($button -eq [IntPtr]::Zero){throw 'Observed native confirm button 1 is missing.'}
$null=[QGNativeDialog]::PostMessage($button,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero)
Write-Output 'Selected the absolute test path in the owned native dialog.'
