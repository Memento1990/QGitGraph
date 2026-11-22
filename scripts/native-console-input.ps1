param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$CommandText)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QGConsoleInput {
 [StructLayout(LayoutKind.Explicit)] public struct InputRecord {
   [FieldOffset(0)] public short EventType;
   [FieldOffset(4)] public int KeyDown;
   [FieldOffset(8)] public short Repeat;
   [FieldOffset(10)] public short VirtualKey;
   [FieldOffset(12)] public short Scan;
   [FieldOffset(14)] public char Character;
   [FieldOffset(16)] public int Control;
 }
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint id);
 [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool WriteConsoleInputW(IntPtr handle,InputRecord[] events,uint count,out uint written);
 public static void Type(uint id,string value){
  FreeConsole(); bool attached=false;for(int attempt=0;attempt<100;attempt++){if(AttachConsole(id)){attached=true;break;}System.Threading.Thread.Sleep(100);}if(!attached)throw new InvalidOperationException("Could not attach to owned console "+id);
  IntPtr input=CreateFileW("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero); var list=new System.Collections.Generic.List<InputRecord>();
  foreach(char c in value+"\r") { var e=new InputRecord {EventType=1,KeyDown=1,Repeat=1,Character=c,VirtualKey=(short)(c=='\r'?13:0)};list.Add(e);e.KeyDown=0;list.Add(e); }
  uint written;if(!WriteConsoleInputW(input,list.ToArray(),(uint)list.Count,out written)||written!=list.Count)throw new InvalidOperationException("Console input was not accepted");FreeConsole();
 }
}
'@
[QGConsoleInput]::Type([uint32]$ProcessId,$CommandText)
