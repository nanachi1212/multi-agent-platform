#requires -Version 7.3
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 4859,
    [ValidateRange(0, 86400)][int]$DurationSeconds = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$tempParent = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))
$owned = [IO.Directory]::CreateTempSubdirectory('studio-browser-')
$root = $owned.FullName
$studioProcess = $null
try {
    # Studio installs or repairs its pinned binary relative to its source tree.
    # Stage the app as well as its data so even a first launch writes only here.
    Copy-Item -LiteralPath (Join-Path $repo 'studio') -Destination $root -Recurse
    $binary = 'runtime/aioncore/aioncore.exe'
    if (Test-Path -LiteralPath (Join-Path $repo $binary) -PathType Leaf) {
        $null = [IO.Directory]::CreateDirectory((Join-Path $root 'runtime/aioncore'))
        Copy-Item -LiteralPath (Join-Path $repo $binary) -Destination (Join-Path $root $binary)
    }
    $project = Join-Path $root 'project'
    $runtime = Join-Path $root 'runtime'
    $profileDir = Join-Path $root 'profile'
    foreach ($dir in @($project, "$runtime/studio", "$profileDir/AppData/Roaming", "$profileDir/AppData/Local", "$root/temp")) {
        $null = [IO.Directory]::CreateDirectory($dir)
    }
    $settings = @{ notify = $false; workspaces = @(@{ project = $project; name = '瀏覽器驗證'; workers = @() }) }
    [IO.File]::WriteAllText("$runtime/studio/settings.json", ($settings | ConvertTo-Json -Depth 5))

    $start = [Diagnostics.ProcessStartInfo]::new($node)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.WorkingDirectory = $root
    $start.ArgumentList.Add((Join-Path $root 'studio/server.mjs'))
    $start.Environment.Clear()
    foreach ($name in 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT') {
        $start.Environment[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    foreach ($pair in @{
        USERPROFILE = $profileDir; HOME = $profileDir; APPDATA = "$profileDir/AppData/Roaming"
        LOCALAPPDATA = "$profileDir/AppData/Local"; TEMP = "$root/temp"; TMP = "$root/temp"
        CODEX_HOME = "$profileDir/.codex"; CLAUDE_CONFIG_DIR = "$profileDir/.claude"
        STUDIO_RUNTIME = $runtime; STUDIO_CODEX_HOME = "$runtime/studio/codex-home"
        STUDIO_PORT = [string]$Port; STUDIO_NO_OPEN = '1'
    }.GetEnumerator()) { $start.Environment[$pair.Key] = $pair.Value }

    Write-Host "測試專案 $project"
    Write-Host "Studio 專用 Codex home $runtime/studio/codex-home"
    Write-Host '請在隔離瀏覽器開啟下方網址。按 Ctrl+C 結束並清除測試資料。'
    $studioProcess = [Diagnostics.Process]::Start($start)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $line = $studioProcess.StandardOutput.ReadLineAsync()
    while ($true) {
        if ($line.Wait(200)) {
            $message = $line.GetAwaiter().GetResult()
            if ($null -eq $message) { break }
            Write-Host $message
            $line = $studioProcess.StandardOutput.ReadLineAsync()
        }
        if ($DurationSeconds -and $clock.Elapsed.TotalSeconds -ge $DurationSeconds) { break }
    }
    if ($studioProcess.HasExited -and $studioProcess.ExitCode -ne 0) {
        throw "測試 Studio 提早結束，exit code $($studioProcess.ExitCode)"
    }
} finally {
    if ($studioProcess) {
        if (!$studioProcess.HasExited) { $studioProcess.Kill($true); $studioProcess.WaitForExit() }
        $studioProcess.Dispose()
    }
    $target = (Get-Item -LiteralPath $root -Force).FullName
    if ([string]::IsNullOrWhiteSpace($target) -or $target -eq [IO.Path]::GetPathRoot($target) -or
        [IO.Path]::GetDirectoryName($target) -ne $tempParent -or $target -ne $owned.FullName -or
        (Get-Item -LiteralPath $target -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
        throw "無法確認測試暫存目錄的所有權，保留 $target"
    }
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host '測試暫存目錄已清除。'
}
