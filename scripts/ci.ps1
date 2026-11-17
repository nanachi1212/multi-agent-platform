# One suite; -Mode Auto is kept so existing callers keep working.
param([ValidateSet('Auto')][string]$Mode = 'Auto')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repoRoot
try {
    foreach ($file in @('studio/aion-client.mjs', 'studio/acp-command.mjs', 'studio/acp-launcher.cjs', 'studio/windows-batch.cjs', 'studio/test-aion-client.cjs', 'studio/test-aion-contract.mjs', 'studio/fixtures/contract-acp.cjs')) {
        & node --check $file
        if ($LASTEXITCODE -ne 0) { throw "AionCore contract syntax failed: $file" }
    }
    & node studio/test-aion-client.cjs
    if ($LASTEXITCODE -ne 0) { throw 'AionCore client checks failed' }
    foreach ($file in @('studio/live-models.mjs', 'studio/server.mjs', 'studio/state-files.mjs', 'studio/test-state-files.cjs', 'studio/test-cleanup.cjs', 'studio/test-card-files.cjs', 'studio/test-turn-stall.cjs', 'studio/test-codex-provider.cjs', 'studio/workspace-lease.mjs', 'studio/lifecycle-harness.cjs', 'studio/test-workspace-lease.cjs', 'studio/runtime-registry.mjs', 'studio/isolated-env.mjs', 'studio/runtime-readiness.mjs', 'studio/test-runtime.cjs', 'studio/test-runtime-server.cjs', 'studio/test-ui-ownership.cjs', 'studio/lifecycle-check.cjs')) {
        & node --check $file
        if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $file" }
    }
    & node studio/test-state-files.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio state file checks failed' }
    & node studio/test-codex-provider.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio Codex provider checks failed' }
    & node --check studio/local-maintenance.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio local maintenance syntax failed' }
    & node studio/test-local-maintenance.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio local maintenance checks failed' }
    & node --check studio/codex-runtime.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio Codex runtime syntax check failed' }
    & node studio/test-codex-runtime.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio Codex runtime checks failed' }
    & node studio/test-cleanup.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio worktree cleanup checks failed' }
    & node studio/test-card-files.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio card file report checks failed' }
    & node studio/test-turn-stall.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio stall evidence checks failed' }
    # lifecycle-check includes test-runtime, runtime-server and UI ownership checks.
    # Keep that standalone entry point complete; do not run the same runtime suite twice.
    & node studio/lifecycle-check.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Studio lifecycle checks failed' }
    foreach ($file in @('studio/test-office-scene.cjs', 'studio/test-live-models.cjs', 'studio/test-ui-safety.cjs', 'studio/test-runtime-identity.cjs', 'studio/test-audit-lifecycle.cjs', 'studio/test-external-wait.cjs', 'studio/test-stop-retry.cjs', 'studio/test-project-state-action.cjs', 'studio/test-progress-read.cjs', 'studio/test-lease-recovery.cjs', 'studio/test-ui-async.cjs', 'studio/test-state-recovery.cjs', 'studio/test-runtime-endpoint.cjs', 'studio/test-leader-lifecycle.cjs', 'studio/test-resume-orphan.cjs', 'studio/test-card-interrupt.cjs', 'studio/test-api-token.cjs', 'studio/test-workspace-lookup.cjs')) {
        & node --check $file
        if ($LASTEXITCODE -ne 0) { throw "Audit regression syntax failed: $file" }
        & node $file
        if ($LASTEXITCODE -ne 0) { throw "Audit regression failed: $file" }
    }
    & git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'Git whitespace check failed' }
    Write-Host "Studio CI $Mode PASS"
} finally { Pop-Location }
