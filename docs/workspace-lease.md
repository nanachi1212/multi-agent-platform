# Workspace ownership lifecycle

`studio/workspace-lease.mjs` exports `createWorkspaceLeaseStore`. It reuses the existing JSON lease records and retains camelCase fields for compatibility: `key` / `path` (canonical physical tree), `repo`, `branch`, `worktree`, `jobId`, `cardId`, `owner.agent`, `provider`, `mode`, `acquiredAt`, `heartbeatAt`, `status`. Older records without `worktree` or `provider` remain readable.

A tree can have multiple read leases and one active or reserved write lease. Linked Git worktrees have independent keys and writers. Admission takes an exclusive persistence lock, merges disk state, then atomically renames the updated JSON. Corrupt stores, unverified locks, and failed writes prevent agent startup. A Git-directory mirror also coordinates installations with different runtime directories; mirror timers are per physical tree.

## Public actions

- `GET /api/leases`: current leases, including `EXTERNAL` owners.
- `POST /api/pause` with `ws`: save progress, cancel and confirm execution, keep a `RESERVED` write lease and its mirror. No automatic restart resume.
- `POST /api/resume` with `ws` or history `id`: verify orphan conversations stopped, check ownership, reacquire/reserve writers, then run the existing scheduler. `confirmExternal: true` explicitly acknowledges unknown changes.
- `POST /api/stop` with `ws`: save a terminal record, cancel/confirm execution, release leases after cleanup. Conversations and history remain. Stopped-job lease records fence stale snapshots; STOP also removes reserved Git mirrors and timers.
- `POST /api/handoff` with `ws`, `agent`, optional `taskId`: hold the old card, save progress, drain execution, revoke the old writer, acquire the new writer's reservation, and continue in the same branch/worktree. Each handoff increments the card/lease ownership generation, so an explicit return to a prior Agent is allowed while stale prior executions remain revoked. `POST /api/reassign` uses this path for writing cards.
- `POST /api/workspace/claim` with `path` or `ws`: external ownership, optional `label`, `pid`, `description` (legacy `note`), `session`. Studio writers stop before acknowledgment. The persistent `EXTERNAL` claim and mirror require explicit release, including after PID exit/restart. Readers remain permitted.
- `POST /api/workspace/release-claim`: explicitly return external ownership; a paused job still needs manual resume.

`drainExecution` is the runtime integration point: `stopTurn` must return true only after cancellation is confirmed; the lease cannot move before card cleanup settles. The current AionCore adapter checks conversation idle state. OS process-tree supervision belongs to the runtime workstream; this lease workstream does not introduce a second process runner.

## External modifications

Each leased worktree has a snapshot of HEAD, branch, Git status, and file size/mtime/ctime. A repeated edit to an already-dirty file is detected even when Git status stays the same. Changes while the writer is idle, or another program's mirror while it executes, set `EXTERNAL_MODIFICATION_DETECTED` and pause writes. No reset, stash, checkout, or deletion of workspace files occurs. While a cooperative agent is actively executing, its edits cannot be distinguished from an unannounced external editor's edits without runtime provenance; snapshots do not claim that attribution.

## Validation

- Targeted: `node studio/test-workspace-lease.cjs` (A/B/C/D/E/F/G/M plus cancellation failure, persistence failure, canonical paths, independent runtime stores, and two OS processes).
- Auto: `.\scripts\ci.ps1 -Mode Auto` (Node syntax checks, the existing lifecycle suite including lease checks, `git diff --check`; no live providers).

The worktree remains locked and retained for integration. After integration, explicitly unlock it before removing it.
