# Workspace ownership lifecycle

`studio/workspace-lease.mjs` exports `createWorkspaceLeaseStore`. It reuses the existing JSON lease records and retains camelCase fields for compatibility: `key` / `path` (canonical physical tree), `repo`, `branch`, `worktree`, `jobId`, `cardId`, `owner.agent`, `provider`, `mode`, `acquiredAt`, `heartbeatAt`, `status`. Older records without `worktree` or `provider` remain readable.

A tree can have multiple read leases and one active or reserved write lease. Linked Git worktrees have independent keys and writers. Admission takes an exclusive persistence lock, merges disk state, then atomically renames the updated JSON. Corrupt stores, unverified locks, and failed writes prevent agent startup. A Git-directory mirror also coordinates installations with different runtime directories; mirror timers are per physical tree.

Heartbeat age alone never authorizes takeover. Live or unknown Studio owners keep their leases and Git mirrors; even an identical job/card snapshot cannot claim a live instance's ownership. A confirmed dead Studio's active lease is stale; its reservation retains the existing 12-hour grace period. This is controller liveness, not proof that an unregistered tool subprocess stopped.

Each runtime directory now has one controller lock acquired before settings are read or AionCore starts. Settings and job history use a flushed temporary JSON file and atomic replacement; a failed replacement preserves the previous file. When upgrading an already-running older Studio without this lock, stop it normally before launching the new version.

Automatic worktree cleanup requires Studio-owned path/branch registration, clean status (including ignored files), and delivery evidence for the current HEAD. Any failed query preserves the tree. Removal uses no force; branch deletion compares the verified commit so a moved branch survives. A partial cleanup is recorded as an error, never `cleaned: true`.

## Public actions

- `GET /api/leases`: current leases, including `EXTERNAL` owners.
- `POST /api/pause` with `ws`: save progress, cancel and confirm execution, keep a `RESERVED` write lease and its mirror. No automatic restart resume.
- `POST /api/resume` with `ws` or history `id`: verify orphan conversations stopped, check ownership, reacquire/reserve writers, then run the existing scheduler. `confirmExternal: true` explicitly acknowledges unknown changes.
- `POST /api/stop` with `ws`: save a terminal record, cancel/confirm execution, release leases after cleanup. Conversations and history remain. Stopped-job lease records fence stale snapshots; STOP also removes reserved Git mirrors and timers.
- `POST /api/handoff` with `ws`, `agent`, optional `taskId`: hold the old card, save progress, drain execution, revoke the old writer, acquire the new writer's reservation, and continue in the same branch/worktree. Each handoff increments the card/lease ownership generation, so an explicit return to a prior Agent is allowed while stale prior executions remain revoked. `POST /api/reassign` uses this path for writing cards.
- `POST /api/workspace/claim` with `path` or `ws`: external ownership, optional `label`, `pid`, `description` (legacy `note`), `session`. Studio writers stop before acknowledgment. The persistent `EXTERNAL` claim and mirror require explicit release, including after PID exit/restart. Readers remain permitted.
- `POST /api/workspace/release-claim`: explicitly return external ownership; a paused job still needs manual resume.
- All `/api` routes except `POST /api/workspace/claim` need the `x-studio-token` header (Studio's pass in `runtime/api-token`); a worker gets a pass that only opens `POST /api/runtime/start` for its own card.

`drainExecution` is the runtime integration point: `stopTurn` must return true only after cancellation is confirmed; the lease cannot move before card cleanup settles. For Codex on Windows, idle is followed by the existing AionCore conversation runtime restart and an OS check of the recorded process tree. Pending or failed confirmation retains the write lease and blocks handoff, external claims and read-only conversion. Terminal card cleanup uses the same gate.

## External modifications

Each leased worktree has a snapshot of HEAD, branch, Git status, and file size/mtime/ctime. A repeated edit to an already-dirty file is detected even when Git status stays the same. Changes while the writer is idle, or another program's mirror while it executes, set `EXTERNAL_MODIFICATION_DETECTED` and pause writes. No reset, stash, checkout, or deletion of workspace files occurs. While a cooperative agent is actively executing, its edits cannot be distinguished from an unannounced external editor's edits without runtime provenance; snapshots do not claim that attribution.

## Validation

- Targeted: `node studio/test-workspace-lease.cjs` (A/B/C/D/E/F/G/M plus cancellation failure, persistence failure, canonical paths, independent runtime stores, and two OS processes).
- Auto: `.\scripts\ci.ps1 -Mode Auto` (Node syntax checks, the existing lifecycle suite including lease checks, `git diff --check`; no live providers).

The worktree remains locked and retained for integration. After integration, explicitly unlock it before removing it.
