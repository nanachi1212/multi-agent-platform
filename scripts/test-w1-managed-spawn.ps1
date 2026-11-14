param(
    [string]$SourceRepo,
    [string]$EvidenceDir,
    [string]$TargetDir
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This gate requires Windows.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$pin = '47e66d0d151123e973b3fd1e77afcb5671b3f8c5'
$patches = Join-Path $repoRoot 'patches/aioncore-v0.2.2'
$git = (Get-Command git.exe -ErrorAction Stop).Source
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$run = Join-Path ([IO.Path]::GetTempPath()) ('w1-managed-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $run 'source'
if (!$EvidenceDir) { $EvidenceDir = Join-Path $run 'evidence' }
$EvidenceDir = [IO.Path]::GetFullPath($EvidenceDir)
if (Test-Path -LiteralPath $EvidenceDir) { throw "Evidence directory must be new: $EvidenceDir" }
New-Item -ItemType Directory -Path $run, $EvidenceDir -Force | Out-Null
$oldTarget = $env:CARGO_TARGET_DIR
$oldStore = $env:W1_STORE_SHELL
$oldAlias = $env:W1_STORE_ALIAS
$env:CARGO_TARGET_DIR = if ($TargetDir) { [IO.Path]::GetFullPath($TargetDir) } else { Join-Path $run 'target' }
$result = [ordered]@{ sourceCommit = $pin; productionDependencyChanged = $false; modelRequests = 0; fullW1Pass = $false; completed = $false }
$result.disposableSource = $source
$result.buildTarget = $env:CARGO_TARGET_DIR

function Invoke-Git([string[]]$NativeArgs) {
    & $git @NativeArgs
    if ($LASTEXITCODE -ne 0) { throw "git failed ($LASTEXITCODE): $($NativeArgs[0])" }
}
function Invoke-Cargo([string]$Name, [string[]]$NativeArgs) {
    $log = Join-Path $EvidenceDir ($Name + '.txt')
    # A nonzero old-version test is expected; preserve its real diagnostic, not just its exit code.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $cargo @NativeArgs 2>&1 | Tee-Object -FilePath $log | Out-Host; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $savedPreference }
    return [PSCustomObject]@{ Code = $code; Text = [IO.File]::ReadAllText($log) }
}
function Read-Matrix([string]$Text) {
    $match = [regex]::Match($Text, 'W1_MATRIX (\[.*\])')
    if (!$match.Success) { throw 'Native shell matrix did not emit evidence.' }
    $rows = ConvertFrom-Json $match.Groups[1].Value
    foreach ($row in $rows) { Write-Output $row }
}
function Read-TestFailures([PSCustomObject]$Run) {
    if ($Run.Code -eq 0) { return @() }
    $failures = @([regex]::Matches($Run.Text, '(?m)^test (\S+) \.\.\. FAILED\r?$') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    if (!$failures.Count -or !$Run.Text.Contains('test result: FAILED.')) {
        throw 'Runtime suite did not reach test execution; a compiler/setup failure is not a baseline.'
    }
    return $failures
}
try {
    if ($SourceRepo) {
        $readOnlySource = [IO.Path]::GetFullPath($SourceRepo)
        Invoke-Git -NativeArgs @('clone', '--no-hardlinks', '--no-checkout', $readOnlySource, $source)
        Invoke-Git -NativeArgs @('-C', $source, 'checkout', '--detach', $pin)
    } else {
        Invoke-Git -NativeArgs @('init', '-q', $source)
        Invoke-Git -NativeArgs @('-C', $source, 'fetch', '--depth=1', 'https://github.com/iOfficeAI/AionCore.git', $pin)
        Invoke-Git -NativeArgs @('-C', $source, 'checkout', '--detach', 'FETCH_HEAD')
    }
    $actual = & $git -C $source rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $actual -ne $pin) { throw 'AionCore source pin mismatch.' }
    Invoke-Git -NativeArgs @('-C', $source, 'apply', '--check', (Join-Path $patches 'regression-tests.patch'))
    Invoke-Git -NativeArgs @('-C', $source, 'apply', (Join-Path $patches 'regression-tests.patch'))
    $storeNote = 'NOT_TESTED: Store package unavailable to this runner.'
    try {
        $package = Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction Stop | Select-Object -First 1
        if ($package) {
            $env:W1_STORE_SHELL = Join-Path $package.InstallLocation 'pwsh.exe'
            $env:W1_STORE_ALIAS = Join-Path $env:LOCALAPPDATA 'Microsoft/WindowsApps/pwsh.exe'
            if (!(Test-Path -LiteralPath $env:W1_STORE_ALIAS)) { $env:W1_STORE_ALIAS = $null }
            $storeNote = $package.PackageFullName
        } else { $env:W1_STORE_SHELL = $null; $env:W1_STORE_ALIAS = $null }
    } catch { $env:W1_STORE_SHELL = $null; $env:W1_STORE_ALIAS = $null; $storeNote = 'NOT_TESTED: package query denied or unavailable.' }
    $result.storePackage = $storeNote
    Push-Location -LiteralPath $source
    try {
        $prefix = @('test', '--locked', '-p', 'aionui-process', '--lib')
        $race = 'process::windows_spawn_tests::managed_child_cannot_execute_before_job_assignment'
        $old = Invoke-Cargo 'old-race' ($prefix + @($race, '--', '--exact', '--nocapture'))
        if ($old.Code -eq 0 -or !$old.Text.Contains('child executed and spawned descendants before owned Job assignment')) {
            throw 'Old source must fail the actual containment invariant; compilation/setup errors do not count.'
        }
        $result.oldRace = 'EXPECTED_FAIL: child executed before assignment'
        $matrix = 'process::windows_spawn_tests::shell_containment_matrix'
        $oldMatrix = Invoke-Cargo 'old-shells' ($prefix + @($matrix, '--', '--exact', '--ignored', '--nocapture'))
        if ($oldMatrix.Code -ne 0) { throw 'Old shell fixture failed to execute; inspect old-shells.txt.' }
        $result.oldShells = @(Read-Matrix $oldMatrix.Text)
        $runtimeArgs = @('test', '--locked', '-p', 'aionui-runtime', '--lib')
        $oldRuntime = Invoke-Cargo 'old-runtime-tests' $runtimeArgs
        $oldFailures = @(Read-TestFailures $oldRuntime)
        Invoke-Git -NativeArgs @('-C', $source, 'apply', '--check', (Join-Path $patches 'managed-spawn.patch'))
        Invoke-Git -NativeArgs @('-C', $source, 'apply', (Join-Path $patches 'managed-spawn.patch'))
        $fixed = Invoke-Cargo 'fixed-process-tests' ($prefix + @('--', '--nocapture'))
        if ($fixed.Code -ne 0) { throw 'Patched process regression tests failed.' }
        $fixedMatrix = Invoke-Cargo 'fixed-shells' ($prefix + @($matrix, '--', '--exact', '--ignored', '--nocapture'))
        if ($fixedMatrix.Code -ne 0) { throw 'Patched shell fixture failed to execute.' }
        $result.fixedShells = @(Read-Matrix $fixedMatrix.Text)
        $runtime = Invoke-Cargo 'fixed-runtime-tests' $runtimeArgs
        $fixedFailures = @(Read-TestFailures $runtime)
        $result.runtimeSuites = [ordered]@{
            oldExitCode = $oldRuntime.Code; fixedExitCode = $runtime.Code
            oldFailures = $oldFailures; fixedFailures = $fixedFailures
            fullSuitePass = ($runtime.Code -eq 0)
        }
        if (($oldFailures -join "`n") -cne ($fixedFailures -join "`n")) {
            throw 'Shared runtime failure set changed; inspect both full-suite logs.'
        }
        if ($runtime.Code -ne 0) {
            Write-Warning 'The complete upstream runtime suite is NOT passing on Windows. Baseline failures are preserved, not suppressed or counted as passed.'
        }
        $smoke = Invoke-Cargo 'production-cfg-smoke' @('run', '--locked', '-p', 'aionui-process', '--example', 'w1_managed_smoke')
        if ($smoke.Code -ne 0 -or !$smoke.Text.Contains('W1_ORDINARY_SMOKE PASS') -or !$smoke.Text.Contains('W1_MANAGED_SMOKE')) {
            throw 'Production-cfg managed/ordinary process smoke failed.'
        }
        $result.productionCfgSmoke = 'PASS'
        $result.fixedRace = 'PASS'; $result.completed = $true
        Write-Host 'W1 managed-spawn PARTIAL FIX gate passed. Packaged-shell activation and live Claude W1 remain unverified/unfixed.'
    } finally { Pop-Location }
} finally {
    $json = $result | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText((Join-Path $EvidenceDir 'result.json'), $json, [Text.UTF8Encoding]::new($false))
    $env:CARGO_TARGET_DIR = $oldTarget; $env:W1_STORE_SHELL = $oldStore; $env:W1_STORE_ALIAS = $oldAlias
    Write-Host "W1 evidence: $EvidenceDir"
    # No name-based process killing, no production runtime, no global agent configuration.
    # Preserve the disposable source/target on failure for inspection; fixtures have finite TTLs.
}
