param([string]$Example)
$ErrorActionPreference = 'Stop'
$stageFile = [IO.Path]::Combine([Environment]::CurrentDirectory, 'fixture-stage')
[IO.File]::WriteAllText($stageFile, 'entry')
$config = Get-Content -Raw -LiteralPath (Join-Path $env:DATA_DIR 'fixture.json') | ConvertFrom-Json
[IO.File]::WriteAllText($stageFile, 'config-read')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobMembershipProbe {
  [DllImport("kernel32", CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  public static bool Member(string name) {
    IntPtr job = OpenJobObject(4, false, name);
    if (job == IntPtr.Zero) return false;
    try { bool member; return IsProcessInJob(GetCurrentProcess(), job, out member) && member; }
    finally { CloseHandle(job); }
  }
}
'@
[IO.File]::WriteAllText($stageFile, 'membership-probe-loaded')
$listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$env:PORT)
$listener.Start()
[IO.File]::WriteAllText($stageFile, 'listener-started')
try {
  # An ordinary background timer belonging to the managed backend.
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $config.node
  $start.Arguments = '-e "setTimeout(()=>{},45000)"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $worker = [Diagnostics.Process]::Start($start)
  [IO.File]::WriteAllText($stageFile, 'worker-started')
  $status = @{ pid = $PID; member = [JobMembershipProbe]::Member($config.job); child = $worker.Id
    cwd = (Get-Location).Path; argument = $Example; image = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }
  $json = $status | ConvertTo-Json -Compress
  $out = Join-Path $env:DATA_DIR 'observed.json'
  [IO.File]::WriteAllText("$out.pending", $json)
  [IO.File]::Move("$out.pending", $out)
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  while ($elapsed.Elapsed.TotalSeconds -lt 40 -and !(Test-Path -LiteralPath (Join-Path $env:DATA_DIR 'finish'))) {
    Start-Sleep -Milliseconds 100
  }
} finally { $listener.Stop() }
exit 42
