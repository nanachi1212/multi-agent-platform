# Diagnose Job Object membership/limits of the current process (W1/W2 environment evidence).
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class P0JobDiag {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] public struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p, q, r, s; }
  [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j, int c, out EXT i, uint l, IntPtr r);
}
'@
$in = $false; [void][P0JobDiag]::IsProcessInJob([P0JobDiag]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$in)
$e = New-Object P0JobDiag+EXT
$ok = [P0JobDiag]::QueryInformationJobObject([IntPtr]::Zero, 9, [ref]$e, [Runtime.InteropServices.Marshal]::SizeOf([type][P0JobDiag+EXT]), [IntPtr]::Zero)
$f = $e.Basic.LimitFlags
[pscustomobject]@{ pid = $PID; inJob = $in; queryOk = $ok; limitFlagsHex = ('0x{0:X}' -f $f);
  KILL_ON_JOB_CLOSE = [bool]($f -band 0x2000); BREAKAWAY_OK = [bool]($f -band 0x800); SILENT_BREAKAWAY_OK = [bool]($f -band 0x1000) } | ConvertTo-Json -Compress
