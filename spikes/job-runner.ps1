# W2 candidate v2: run one argv inside a KILL_ON_JOB_CLOSE Job Object.
# Pattern: CreateProcessW(CREATE_SUSPENDED) -> AssignProcessToJobObject(child) -> ResumeThread.
# The child is a job member before its first instruction, so all descendants inherit the job.
# Killing this wrapper closes the only job handle -> the OS kills every job member.
# (v1 assigned the wrapper itself and used .NET Process.Start; P0 observed that child was NOT in the job.)
# Usage: pwsh -NoProfile -NonInteractive -File job-runner.ps1 -ArgvB64 <base64(JSON array)> [-Cwd <dir>]
param([Parameter(Mandatory)][string]$ArgvB64, [string]$Cwd = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class P0Job4 {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p, q, r, s; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string r, d, t; public int x, y, w, h, xc, yc, fa, fl; public short sw, cr2; public IntPtr r2, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hProcess, hThread; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint c);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint c);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  // CommandLineToArgvW-compatible quoting.
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[]{' ','\t','\n','\v','"'}) < 0) return a;
    var sb = new StringBuilder("\""); int bs = 0;
    foreach (char c in a) { if (c == '\\') { bs++; continue; } if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; } sb.Append('\\', bs); bs = 0; sb.Append(c); }
    sb.Append('\\', bs * 2); sb.Append('"'); return sb.ToString();
  }
  public static int Run(string[] argv, string cwd, string diagFile) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var e = new EXT(); e.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref e, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    var cmd = new StringBuilder(); foreach (var a in argv) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Q(a)); }
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); PI pi;
    // Pass the wrapper's stdin/stdout/stderr to the child so verification output is captured (P0 W8 finding).
    si.fl = 0x100; /* STARTF_USESTDHANDLES */ si.i = GetStdHandle(-10); si.o = GetStdHandle(-11); si.e = GetStdHandle(-12);
    const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcessW " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, pi.hProcess)) { int err = Marshal.GetLastWin32Error(); TerminateProcess(pi.hProcess, 1); throw new Exception("AssignProcessToJobObject " + err); }
    bool inJob; IsProcessInJob(pi.hProcess, job, out inJob);
    if (!string.IsNullOrEmpty(diagFile)) System.IO.File.AppendAllText(diagFile, "{\"wrapper\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"child\":" + pi.pid + ",\"childInJob\":" + (inJob ? "true" : "false") + ",\"pattern\":\"suspended-assign-resume\"}\n");
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code); return (int)code;
  }
}
'@
$argv = [System.Text.Json.JsonSerializer]::Deserialize([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgvB64)), [string[]])
exit [P0Job4]::Run($argv, $Cwd, $env:P0_JOB_DIAG)
