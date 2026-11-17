# Read a local Node process's startup state so maintenance preserves its environment.
function Get-SiteProcessState([int]$ProcessId) {
  if (-not ('SiteProcessReader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SiteProcessReader {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr process, int kind, byte[] buffer, int size, out int returned);
  public static byte[] Read(IntPtr process, long address, int length) {
    byte[] buffer=new byte[length]; IntPtr read;
    ReadProcessMemory(process,new IntPtr(address),buffer,length,out read);
    if(read.ToInt64()==0)throw new InvalidOperationException("Cannot read process startup state.");
    Array.Resize(ref buffer,(int)read.ToInt64()); return buffer;
  }
}
'@
  }
  $handle = [SiteProcessReader]::OpenProcess(0x410, $false, $ProcessId)
  if ($handle -eq [IntPtr]::Zero) { throw 'Cannot inspect site process.' }
  try {
    $basic = [byte[]]::new(48); $returned = 0
    if ([SiteProcessReader]::NtQueryInformationProcess($handle, 0, $basic, 48, [ref]$returned) -ne 0) { throw 'Cannot query site process.' }
    $peb = [BitConverter]::ToInt64($basic, 8)
    $parameters = [BitConverter]::ToInt64([SiteProcessReader]::Read($handle, $peb + 32, 8), 0)
    $startup = [SiteProcessReader]::Read($handle, $parameters, 136)
    $cwdSize = [BitConverter]::ToUInt16($startup, 56)
    $cwdAddress = [BitConverter]::ToInt64($startup, 64)
    $cwd = [Text.Encoding]::Unicode.GetString([SiteProcessReader]::Read($handle, $cwdAddress, $cwdSize))
    $envAddress = [BitConverter]::ToInt64($startup, 128)
    $envText = [Text.Encoding]::Unicode.GetString([SiteProcessReader]::Read($handle, $envAddress, 65536))
    $end = $envText.IndexOf("`0`0", [StringComparison]::Ordinal)
    if ($end -lt 0) { throw 'Incomplete environment; refusing to reconstruct startup.' }
    $environment = @{}
    foreach ($line in $envText.Substring(0, $end).Split([char]0)) {
      if ($line.Length -lt 2) { continue }
      $separator = $line.IndexOf('=', 1)
      if ($separator -gt 0) { $environment[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
    }
    [PSCustomObject]@{Directory=$cwd; Environment=$environment}
  } finally { [void][SiteProcessReader]::CloseHandle($handle) }
}
