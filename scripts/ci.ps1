param([ValidateSet('Auto', 'Full')][string]$Mode = 'Auto')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoRoot
try {
    foreach ($file in @('studio/server.mjs', 'studio/workspace-lease.mjs', 'studio/lifecycle-harness.cjs', 'studio/test-workspace-lease.cjs', 'studio/runtime-registry.mjs', 'studio/isolated-env.mjs', 'studio/runtime-readiness.mjs', 'studio/test-runtime.cjs', 'studio/test-runtime-server.cjs', 'studio/lifecycle-check.cjs')) {
        & node --check $file
        if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $file" }
    }
    & node studio/test-runtime.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio runtime checks failed' }
    & node studio/lifecycle-check.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio lifecycle checks failed' }
    & git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'Git whitespace check failed' }
    Write-Host "Studio CI $Mode PASS"
} finally { Pop-Location }
