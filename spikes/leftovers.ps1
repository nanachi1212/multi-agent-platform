# List any process whose command line references the spike's fixtures or scripts (read-only check).
$needles = @('fixtures\tree.mjs', 'spikes\serve.mjs', 'spikes\turn.mjs', 'spikes\w1-tree.mjs', 'spikes\job-runner.ps1', 'runtime\aioncore\aioncore.exe')
$hits = Get-CimInstance Win32_Process | Where-Object {
  $cl = [string]$_.CommandLine
  $cl -and ($cl.Contains('multi-agent-platform')) -and ($needles | Where-Object { $cl.Contains($_) })
}
if ($hits) { $hits | Select-Object ProcessId, Name | Format-Table -AutoSize | Out-String } else { 'no leftover spike processes' }
