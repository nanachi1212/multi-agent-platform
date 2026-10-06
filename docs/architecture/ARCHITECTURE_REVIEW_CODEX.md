# Multi-Agent Platform Architecture Red-Team Review

> Review target: `MULTI_AGENT_PLATFORM_ARCHITECTURE.md`  
> Review mode: read-only architecture and source review  
> Platform baseline: Windows 11, Node.js v24.16.0, Git 2.54.0.windows.1  
> Evidence labels: **OBSERVED** means directly confirmed in a pinned source or local state. **INFERENCE** means a conclusion derived from observed evidence. **UNVERIFIED** means the review did not obtain enough direct evidence.

## 1. Verdict

**APPROVE WITH CHANGES**

This verdict approves only the direction and a bounded P0 feasibility Spike. It does **not** approve product implementation from the current document.

The strongest direction is still **AionCore as the agent conversation runtime, with a small external Conductor as the policy and orchestration layer**. Do not fork AionUi or AionCore now. The design must first resolve five implementation blockers:

1. AionCore local mode is not a security boundary between agents, AionUi, and Conductor.
2. Attaching an external Conductor to an AionUi-managed dynamic endpoint has no observed public discovery contract.
3. Approval state is process-local and non-idempotent. AionUi and Conductor can race.
4. Worktrees isolate ordinary Git state, but do not isolate processes, credentials, network, shared Git metadata, or hostile code.
5. The Windows Job Object path has an observed child-start race that needs a live process-tree test.

The architecture should retain its separation of runtime and policy, but reduce the initial scope. Implement a CLI-only, sequential path before dynamic roles, leader handoff, experiments, local LLM routing, or a full UI.

## 2. Strong Parts

1. **Clear runtime/control-plane separation.** The proposal keeps AionCore responsible for agent sessions and gives Conductor ownership of task state, policy, verification, and recovery. This is the right boundary in principle and avoids rebuilding four CLI adapters.
2. **Use of structured agent runtimes.** AionCore has source-level routes for conversation CRUD, messages, cancel, runtime restart, confirmation, and WebSocket streaming. This is materially better than screen scraping or terminal-text parsing. [AionCore routes at `4a707fc`](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-conversation/src/routes.rs#L114-L146)
3. **Deterministic verification is separate from agent claims.** The architecture correctly treats an agent saying “done” as insufficient and proposes executable completion gates. That principle must remain.
4. **Worktrees are useful for Git correctness.** A per-write-task worktree gives a clear base, diff, owner, and evidence boundary. It is a good correctness mechanism when it is not mislabeled as a sandbox.
5. **Version pinning and contract tests are present.** Pinning AionCore/AionUi revisions and testing the adapter surface are appropriate because the intended API is not documented as a stable public integration contract.
6. **Leader handoff is modeled as state, not prompt text.** The proposed `leader_epoch`, database-derived handoff packet, and explicit acknowledgement are a sound start. They need additional generations and a durable saga, but the base direction is correct.
7. **External side effects are intentionally restricted.** The design does not require automatic push, merge, deploy, or cleanup. This is consistent with safe local development.
8. **The document already proposes a feasibility gate.** A P0 Spike is the correct place to prove the unstable boundaries before product code is built.

## 3. Critical Findings P0–P3

### P0-1 — AionCore local mode is not a security boundary

- **Claim:** Conductor cannot currently be treated as the exclusive authority for agent permissions when it shares an AionUi local AionCore instance.
- **Evidence:** **OBSERVED.** AionUi launches AionCore in local mode. Local REST middleware skips JWT and injects a fixed system user. Local WebSocket authentication also uses a fixed identity. Local CORS allows any origin, headers, and common mutating methods. AionCore binds to `127.0.0.1`, which limits network exposure but does not separate same-user local processes. [AionUi launcher](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/web-host/src/backend-launcher.ts#L665-L695), [REST local auth](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-auth/src/middleware.rs#L91-L100), [WebSocket local auth](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/router/state.rs#L1147-L1155), [local CORS](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/router/routes.rs#L456-L468), [loopback default](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-common/src/constants.rs#L52-L54)
- **Evidence:** **OBSERVED.** Agent subprocesses receive the AionCore base URL and a runtime token in environment variables. The token limits helper routes, but ordinary local REST routes do not require it. [agent environment](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-ai-agent/src/types.rs#L55-L102)
- **Failure mode:** **INFERENCE.** A compromised prompt, repository script, extension, or ordinary same-user process can call create, send, delete, cancel, or confirm routes directly. It can bypass Conductor's audit and approval policy. AionUi can also mutate the same runtime behind Conductor.
- **Required fix:** Define the initial trust model as **cooperative agents on a disposable, non-sensitive repository**. Use manual approvals. Do not claim containment. A production boundary requires an authenticated AionCore instance or an upstream/forked capability with scoped clients, exclusive approval ownership, and structured authorization data.
- **Scope:** **P0 Spike and MVP blocker.** The Spike may test the behavior. MVP use on sensitive repositories or credentials is blocked.

### P0-2 — External endpoint discovery and API stability are not established

- **Claim:** An external process cannot reliably attach to an AionUi-managed AionCore instance using an observed public contract.
- **Evidence:** **OBSERVED.** AionCore prints `AIONCORE_LISTENING {"host","port"}` when started. AionUi consumes that stdout, stores the dynamic port in its parent process, and exposes it to its own renderer through private Electron IPC. No public port file, discovery endpoint, or named pipe was observed. [AionCore listening output](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/commands/cmd_server.rs#L233-L243), [AionUi stdout discovery](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/web-host/src/backend-launcher.ts#L779-L815), [private preload IPC](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/desktop/src/preload/main.ts#L56-L60)
- **Evidence:** **OBSERVED.** Conversation creation has a typed override for model, permission, thought level, skills, and MCP IDs. Workspace is accepted through untyped `extra.workspace` and handled by implementation code. This works at the pinned commit, but it is not a documented versioned external API. [request type](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-api-types/src/conversation.rs#L52-L88), [workspace handling](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-conversation/src/service.rs#L1115-L1168)
- **Failure mode:** A desktop update changes launch behavior, an internal field, or event semantics. Conductor cannot discover the endpoint or silently creates a conversation with the wrong workspace or backend configuration.
- **Required fix:** The P0 adapter must own the AionCore child process and parse the documented machine-readable stdout for the pinned build, or obtain an upstream-supported discovery/auth contract. It must version-check the server and fail closed. Do not parse logs or enumerate listening sockets as a product design.
- **Scope:** **P0 Spike blocker.** If the Conductor must attach to the existing AionUi desktop process and no supported discovery contract is available, reject this architecture or request a small upstream change.

### P0-3 — Worktree isolation is being asked to perform security work it cannot perform

- **Claim:** A Git worktree is a correctness boundary, not a process or security sandbox.
- **Evidence:** **OBSERVED.** Linked worktrees share the object store, refs, and repository-level metadata. Git documents incomplete submodule support. `.git/info/exclude` is in the shared common directory; it is not per-worktree. [Git worktree documentation](https://git-scm.com/docs/git-worktree), [Git repository layout](https://git-scm.com/docs/gitrepository-layout/2.43.0.html)
- **Failure mode:** An agent reads or modifies another worktree, shared refs/config/hooks, credentials, caches, ports, daemons, or external APIs. It can also use a junction or reparse point to escape a string-prefix path check.
- **Required fix:** State the trust boundary precisely. Use per-task-attempt worktrees for Git correctness. Protect credentials and production repositories separately. If hostile repository content or hostile prompts are in scope, use a dedicated low-privilege Windows account, VM, WSL/container boundary, or another OS sandbox before production use.
- **Scope:** **MVP blocker for sensitive use.** OS isolation may be deferred only for a disposable, trusted Spike/MVP environment.

### P0-4 — Windows process containment has an observed start race

- **Claim:** The pinned Windows process path does not prove that every descendant is placed in the Job Object before it can execute or spawn children.
- **Evidence:** **OBSERVED.** `aionui-process` assumes a suspended child during Job assignment, while the Windows `configure_platform_spawn` path in `aionui-runtime` is empty at the pinned revision. [Job assignment path](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-process/src/process.rs), [runtime spawn path](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-runtime/src/spawn.rs)
- **Failure mode:** A child executes or spawns a descendant before assignment. Cancel or restart appears successful while a descendant remains alive and continues changing files or holding locks.
- **Required fix:** Add a Windows live gate that launches a known process tree, immediately spawns a grandchild, then cancels/restarts and proves that all process IDs exit. Treat any survivor as FAIL. Fix upstream or in a minimal maintained patch before MVP.
- **Scope:** **P0 Spike blocker.** Source inspection alone is insufficient.

### P1-1 — Approval state is volatile, non-idempotent, and has multiple writers

- **Claim:** The current approval route cannot safely support AionUi and Conductor as concurrent clients.
- **Evidence:** **OBSERVED.** Pending confirmations are read from the active in-memory agent task. ACP pending permission state is a process-local `HashMap`; confirm removes an item and a repeat returns “not found.” The schema has no revision, idempotency key, resolver identity, or durable resolved state. [confirmation service](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-conversation/src/service.rs#L3416-L3470), [permission router](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-ai-agent/src/manager/acp/permission_router.rs#L17-L41), [confirmation schema](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-common/src/types.rs#L50-L67), [confirm request](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-api-types/src/confirmation.rs#L6-L13)
- **Evidence:** **OBSERVED.** AionUi's recovery hook can re-add a stale confirmation if a remove event arrives before an older list response. [AionUi recovery hook](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/desktop/src/renderer/pages/conversation/Messages/usePendingConfirmationsRecovery.ts#L76-L111)
- **Failure mode:** Approval is lost on restart, answered twice, answered by the wrong client, or visually reappears after resolution.
- **Required fix:** One approval writer. Persist a Conductor-side decision record with compare-and-swap state. Keep resolved tombstones. Reconcile AionCore errors. Until AionCore exposes exclusive ownership and durable idempotence, the AionUi view must be observational for managed conversations.
- **Scope:** **MVP.** P0 must demonstrate the race and crash behavior.

### P1-2 — `leader_epoch` is necessary but insufficient

- **Claim:** One generation counter cannot fence leader commands, task retries, decision revisions, and handoff phases.
- **Evidence:** **OBSERVED.** The architecture increments `leader_epoch` during handoff but does not define separate task attempt or decision revision generations. [`MULTI_AGENT_PLATFORM_ARCHITECTURE.md` §6](MULTI_AGENT_PLATFORM_ARCHITECTURE.md)
- **Failure mode:** A result from an old retry is accepted, D1 overwrites newer D2 within the same leader epoch, or a crash between database update and conversation creation leaves two effective leaders.
- **Required fix:** Add `task_attempt`, `decision_revision`, `handoff_id`, `phase`, and `snapshot_event_seq`. Use unique `message_id` and `command_id`, durable inbox/outbox, payload hashes, and database compare-and-swap. Never reduce an epoch after an acknowledgement timeout.
- **Scope:** **MVP-2.** Dynamic handoff stays out of earlier MVPs.

### P1-3 — The proposed JSON extraction is not a protocol boundary

- **Claim:** Extracting one fenced `json` block from prose is ambiguous and unauthenticated.
- **Evidence:** **OBSERVED.** The architecture proposes finding a JSON code block in an agent response. [`MULTI_AGENT_PLATFORM_ARCHITECTURE.md` §5.2](MULTI_AGENT_PLATFORM_ARCHITECTURE.md)
- **Failure mode:** Multiple blocks, duplicate keys, trailing content, excessive nesting, or a self-claimed sender identity produces parser differentials or unauthorized actions. RFC 8259 notes that duplicate object names lead to unpredictable behavior across implementations. [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)
- **Required fix:** Accept exactly one whole-message JSON object for protocol messages. Enforce byte/depth/array limits, reject duplicate keys, use fixed-format IDs, and reject unknown fields. Bind sender identity to the transport conversation, never to an identity in JSON.
- **Scope:** **MVP-1.** Plain conversational text can remain outside the control protocol.

### P1-4 — Verification inputs and evidence are not sufficiently trusted

- **Claim:** A worker must not be able to redefine the command or evidence that marks its own task complete.
- **Evidence:** **OBSERVED.** The architecture carries `verify_commands` in task data and executes them in the worker worktree. [`MULTI_AGENT_PLATFORM_ARCHITECTURE.md` §5.1–5.3](MULTI_AGENT_PLATFORM_ARCHITECTURE.md)
- **Failure mode:** An agent changes package scripts, test configuration, verification commands, cached artifacts, or the tests themselves and receives a false PASS.
- **Required fix:** Verification commands come only from the user, trusted repository policy, or Conductor. Store argv and policy hashes. Use `shell:false`. Bind evidence to base commit, tree/dirty/untracked digest, command hash, and task attempt. Put acceptance probes outside the writable worktree when feasible. Any later file change invalidates prior evidence.
- **Scope:** **MVP-0 and later.** The first usable path requires this rule.

### P1-5 — Side-effect delivery is not exactly-once

- **Claim:** A durable Conductor outbox cannot by itself make AionCore conversation creation or message sending exactly-once.
- **Evidence:** **UNVERIFIED.** No idempotency-key contract was observed for conversation create or message send in the reviewed routes.
- **Failure mode:** Conductor crashes after AionCore accepts a request but before the local transaction records success. Retry creates a duplicate conversation or sends a duplicate command.
- **Required fix:** Use stable command IDs where AionCore preserves them. Otherwise classify delivery as unknown, fence the old task attempt, and require manual handling for irreversible side effects. Do not claim exactly-once semantics.
- **Scope:** **MVP-1 for recovery; P0 should characterize behavior.**

### P2-1 — The MVP contains several products at once

- **Claim:** Seven roles, a generic DAG, dynamic leader handoff, full event replay, experiments, a full UI, local LLM routing, and multi-backend normalization are not one MVP.
- **Evidence:** **OBSERVED.** These are all included before the architecture has proven the runtime boundary. [`MULTI_AGENT_PLATFORM_ARCHITECTURE.md` §8–10](MULTI_AGENT_PLATFORM_ARCHITECTURE.md)
- **Failure mode:** The project spends most effort building generic orchestration state before one reliable task can run and be verified.
- **Required fix:** Use the staged plan in section 15. Start with one task, one agent, one worktree, fixed verification, and manual approval.
- **Scope:** **Deferred beyond MVP-0 unless a stage proves the need.**

### P2-2 — Full event sourcing is unnecessary for the first product

- **Claim:** Rebuilding all current state from an append-only event stream adds migration, ordering, replay, and repair work without an established need.
- **Evidence:** **OBSERVED.** The document makes event replay central to recovery. [`MULTI_AGENT_PLATFORM_ARCHITECTURE.md` §4 and §6](MULTI_AGENT_PLATFORM_ARCHITECTURE.md)
- **Failure mode:** State-machine bugs become replay bugs, and operational repair requires understanding both projections and historical events.
- **Required fix:** Use ordinary current-state SQLite tables plus an append-only audit log. Add a durable inbox/outbox only at external side-effect boundaries. Use explicit schema migrations through `PRAGMA user_version`.
- **Scope:** **MVP simplification.** Event-derived projections remain deferred until a measured need appears.

### P2-3 — Direct TypeScript execution and `node:sqlite` need explicit limits

- **Claim:** The proposed Node 24 stack is viable, but the document understates its constraints.
- **Evidence:** **OBSERVED.** Local Node is v24.16.0. Node type stripping is stable in Node 24.12+, but it does not type-check, ignores `tsconfig.json`, and supports only erasable syntax unless transformation is enabled. `node:sqlite` is Release Candidate stability in Node 24.15+ and `DatabaseSync` is synchronous. [Node TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html), [Node SQLite documentation](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md)
- **Failure mode:** Code passes direct execution but fails type correctness, or synchronous database calls block a UI/event loop under avoidable load.
- **Required fix:** Direct type stripping is acceptable for the Spike. For a release, pin Node >=24.15, run `tsc --noEmit`, and emit or bundle JavaScript. Keep one writer, short transactions, foreign keys, WAL, busy timeout, and backups.
- **Scope:** **MVP.** No language rewrite is justified.

### P3-1 — “Different reviewer” does not guarantee independent verification

- **Claim:** A different conversation or model instance can still share the same blind spot, editable tests, and compromised environment.
- **Evidence:** **INFERENCE.** Identity separation improves process discipline but is weaker than executable evidence from a trusted harness.
- **Failure mode:** Two agents agree on the same incorrect implementation or approve altered tests.
- **Required fix:** Require a separate reviewer only for high-correctness, security, schema, migration, or data-integrity work. Always prefer trusted deterministic evidence over reviewer count.
- **Scope:** **Policy refinement; not a blocker.**

## 4. AionCore Runtime Feasibility

**CONDITIONAL PASS**

| Capability | Result | Evidence and condition |
|---|---|---|
| Conversation create/list/get/update/delete | PASS, source-level | Routes exist at pinned AionCore commit. No live runtime test was performed. [routes](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-conversation/src/routes.rs#L114-L146) |
| Send/read messages | PASS, source-level | GET/POST message routes exist. |
| Stream events | PASS, source-level | `/ws`, `message.stream`, and `turn.completed` are present. [WebSocket route](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/router/routes.rs#L364-L366), [stream payload](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-conversation/src/stream_relay.rs#L848-L877) |
| Cancel/restart/resume | CONDITIONAL PASS | Cancel and runtime ensure/restart routes exist. Exact resume behavior across backend crash and Conductor crash needs a live test. |
| Archive | UNVERIFIED | No explicit archive route was observed in the reviewed conversation route list. Delete is not archive. |
| Per-conversation workspace | PASS at pinned commit | `extra.workspace` is normalized and checked as an existing directory. It remains an untyped/private integration surface. |
| Model/permission/thought level/skills/MCP overrides | CONDITIONAL PASS | Typed overrides exist, but backend meanings differ. Antigravity MCP behavior and cross-backend equivalence are **UNVERIFIED**. |
| External endpoint discovery | FAIL for attach; PASS for owned child | Conductor can parse `AIONCORE_LISTENING` only when it owns the child stdout. Existing AionUi attachment has no observed public discovery contract. |
| Authentication and client isolation | FAIL in local mode | REST and WebSocket local modes do not separate same-user clients. |
| Approval durability/idempotence | FAIL | Pending state is process-local; confirm is destructive and non-idempotent. |
| Windows descendant containment | UNVERIFIED / source concern | The observed Job Object start race requires a live process-tree gate. |

The reviewed AionCore and AionUi commits exist: [AionCore `4a707fc3d3cd`](https://github.com/iOfficeAI/AionCore/commit/4a707fc3d3cd1f06a86004745e2c1bbf08b16068), [AionUi `6744099b279b`](https://github.com/iOfficeAI/AionUi/commit/6744099b279b991c17e31c243f0920477bd31cb6).

No AionCore installation or live process was present during this review. The result is therefore source-level plus local toolchain evidence, not a runtime acceptance test.

## 5. Permission Model Review

The proposed policy engine has a useful default-deny shape, but it cannot enforce its claims through an unauthenticated shared local runtime.

Minimum policy for the first usable version:

1. **Single authority:** Conductor is the only component allowed by policy to answer managed approvals. AionUi must not be used to answer them.
2. **Manual first:** All mutating tool approvals remain manual in Spike and MVP-0. There is no “always allow” for shell, Git mutation, network, credentials, process control, or paths outside the assigned worktree.
3. **Structured decision record:** Store `approval_id`, conversation, task attempt, observed action, normalized resource, decision, resolver, policy version, created time, resolved time, and AionCore result.
4. **Compare-and-swap:** Only `PENDING -> APPROVED|DENIED|EXPIRED` is valid. A second response is a conflict, not another decision.
5. **No approval by prose:** The agent may explain or request. It cannot approve itself through an output envelope.
6. **No uniform command assumptions:** The current AionCore confirmation schema does not guarantee typed argv, cwd, path, network destination, or resource identity for every backend. Missing fields require denial or manual review.
7. **Permission and containment are separate:** Approval policy limits intended operations. It does not stop a subprocess from directly using inherited OS authority.

**Blocker:** If the product requirement is “an untrusted agent cannot bypass Conductor,” local AionCore mode fails that requirement. Upstream authentication/scoped capability support, a small maintained fork, or OS isolation is required.

## 6. Worktree and Security Isolation Review

Use **one worktree per write task attempt**, not one persistent worktree per worker.

Per-task-attempt worktrees provide:

- a fixed base commit;
- an unambiguous owner and task attempt;
- a bounded diff and evidence digest;
- safe fencing of late results after retry or reassignment;
- preservation of failed evidence for manual inspection.

Persistent worker lanes save checkout and cache time, but they accumulate contamination, make retry bases ambiguous, and allow delayed processes from the prior task to modify the next task. They are acceptable only for trusted, read-only, strictly sequential work.

Required fail-closed cases:

- dirty or untracked base state not explicitly included in the task;
- nested repositories;
- `.gitmodules` or initialized submodules;
- sparse checkout;
- Git LFS objects not materialized or verified;
- tracked case collisions on Windows;
- branch already checked out elsewhere;
- branch/worktree naming collision;
- unknown reparse points or final paths outside the assigned root;
- cleanup blocked by live processes or open handles.

Do not use `--force` to remove a dirty or locked worktree. Stop the owned process tree, retry for a bounded period, then preserve the worktree and report `BLOCKED`.

The architecture must correct one factual error: `.git/info/exclude` is shared through the common Git directory. It is not a per-worktree exclusion mechanism. Do not blanket-ignore `.agents/hooks.json` or `.conductor/`; classify exact files, validate their hashes, and prevent them from being committed unless the task explicitly requires them.

## 7. Leader Handoff Race Review

Minimum durable identifiers:

- `leader_epoch` for leader control authority;
- `task_attempt` for task dispatch and results;
- `decision_revision` plus `supersedes_id` for decisions;
- `handoff_id`, `phase`, and `snapshot_event_seq` for a handoff;
- unique `message_id` and `command_id` plus payload hash for deduplication;
- durable inbox/outbox records and database compare-and-swap.

| Case | Red-team result | Required behavior |
|---|---|---|
| A. Old Leader sends a delayed Task | `leader_epoch` rejects a stale leader command, but it cannot validate a worker result. | Reject old control commands. Accept a result only when `task_attempt` equals the current assignment attempt. Record stale input for audit. |
| B. D1 arrives after newer D2 | **FAIL with epoch only.** Both can come from the same leader epoch. | Apply decisions with CAS on `decision_revision`. D2 names D1 in `supersedes_id`. Late D1 becomes `STALE`; it never overwrites D2. |
| C. Worker Result arrives during handoff | An in-memory temporary queue loses data on crash. | First commit the message to a durable inbox. If its task attempt is current, hold it as pending. After new-Leader acknowledgement, send all events after `snapshot_event_seq`. |
| D. Conductor crashes mid-handoff | A database transaction cannot atomically include an external create/send operation. | Use a durable saga: `PREPARING -> SWITCHED -> BOOTSTRAPPING -> ACTIVE|BLOCKED`. Update assignment and write the outbox in one transaction. Replay the same command ID after restart. |
| E. New Leader acknowledgement times out | Rolling back the epoch can revive stale authority. | Never reduce the epoch. Stay `HANDOFF_BLOCKED`; resend the same handoff or select another leader and increment the epoch again. Ack must match handoff, epoch, assignment, session, and snapshot sequence. |
| F. Leader is also a worker | A single conversation can self-review and mix control/data messages. | Use separate role assignments and conversations. Leader commands validate epoch; worker results validate task attempt. `not_creator` compares stable principal identity, and the leader cannot review its own work. |

Apply each incoming control message in one SQLite transaction: insert inbox record, authenticate the transport-bound sender, check the expected generation, update with CAS, append audit event, and write any outbox command. Use `BEGIN IMMEDIATE` for the single-writer transition. [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)

## 8. Protocol Review

The protocol must be smaller and stricter than the architecture currently proposes.

Minimum envelope rules:

1. A protocol response is exactly one JSON object. Markdown fences and surrounding prose are rejected for control messages.
2. Maximum UTF-8 byte size, nesting depth, string size, and array length are fixed.
3. Duplicate object keys are rejected before ordinary JSON decoding.
4. Each message type has a closed schema with `additionalProperties: false`.
5. IDs use a fixed ASCII format and length.
6. Numbers that represent sequence/revision values are non-negative safe integers.
7. The sender identity is bound to the AionCore conversation and Conductor assignment. JSON cannot override it.
8. Unknown message types and future schema versions fail closed.
9. Same message ID plus same payload hash is an idempotent replay. Same ID plus different hash is a security/audit error.
10. Large artifacts remain in Conductor-controlled storage. Agent-visible `.conductor` files are untrusted copies with expected hashes.

One runtime validation dependency is justified. Because the protocol is defined as JSON Schema, **Ajv** is the direct choice. Handwriting a validator to preserve “zero dependencies” would add more security-sensitive code than one pinned dependency. If code-first types are preferred later, Zod is a reasonable alternative, but do not use both.

## 9. Verification Architecture Review

The verification service should produce evidence, not a boolean supplied by an agent.

Required completion contract:

- trusted command argv and cwd;
- policy version and command hash;
- base commit;
- resulting `HEAD` and tree ID;
- digest of dirty and untracked files;
- task and task-attempt IDs;
- start/end timestamps, exit code, stdout/stderr digest, timeout, and process-tree termination result;
- explicit `PASS`, `FAIL`, `BLOCKED`, or `NOT_TESTED`.

Execution rules:

1. Commands come from the user, trusted repository policy, or Conductor. Agents may propose commands but cannot silently make them authoritative.
2. Execute argv arrays with `shell:false`. Do not interpolate agent text into PowerShell or `cmd.exe` command strings.
3. Use a fresh process with bounded time, output, CPU/memory where available, and an owned process tree.
4. Isolate temp, cache, and home-like directories where practical. Disable network by default for verification.
5. Protect test runners, CI/build configuration, and acceptance assets. If the task changes them, require explicit approval and an external acceptance probe.
6. Invalidate evidence after any repository change.
7. Preserve failed worktrees. Do not auto-restore or auto-delete evidence.
8. Run only targeted checks for normal tasks. Full validation is reserved for cross-core contracts, dependencies, schemas/migrations, large refactors, security, or high data-integrity risk.

A separate reviewer is a policy supplement. It is not a substitute for trusted executable evidence.

## 10. Windows Compatibility Review

The Windows-first intent is correct, but these are mandatory gates:

1. **Process tree:** Prove Job Object containment for direct executables, `.cmd` shims, and grandchildren. Cancel/restart must leave no descendant.
2. **Argument transport:** Test Unicode, spaces, quotes, newlines, long prompts, and the Antigravity/Gemini/Claude/Codex launcher forms. Prefer stdin or a temporary UTF-8 file for large prompts instead of command-line concatenation.
3. **PowerShell:** Use PowerShell-native commands and capture native exit codes. Do not depend on Bash/GNU behavior.
4. **File locks:** On `ERROR_SHARING_VIOLATION`, stop only owned processes, retry with a bounded backoff, then preserve and report. Windows file sharing semantics are documented by `CreateFile`. [CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
5. **Path containment:** Resolve final paths, check reparse points, apply case-insensitive comparison, and reject paths outside the worktree. [reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points), [junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)
6. **Path names:** Preflight case collisions, trailing spaces/dots, reserved device names, and long paths. [Windows file naming](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
7. **Git features:** Fail closed for submodules and sparse checkout in early MVPs. Treat LFS as a separate tested capability.
8. **Encoding:** Use UTF-8 explicitly for protocol and persisted evidence. Do not parse localized human-readable Git output when porcelain formats exist.

Local observations: Windows 11, PowerShell 7.6.5, Node v24.16.0, and Git 2.54.0.windows.1 are suitable for the proposed Spike. AionCore was not installed or run, so no Windows runtime claim is yet verified.

## 11. Stack Review

**Recommendation: keep Node 24 + TypeScript. Do not rewrite in Go, Rust, or .NET for the MVP.**

- Pin Node >=24.15 for `node:sqlite` behavior used by the project.
- Use direct TypeScript execution only for the Spike and small local tools.
- Add `typescript` and `@types/node` as development dependencies. Run `tsc --noEmit` in targeted validation.
- Emit or bundle JavaScript for a distributed release. Avoid unsupported type syntax and `tsconfig` path alias assumptions in directly executed files.
- Use `node:sqlite` for a single-user, single-writer Conductor. Enable foreign keys, WAL, busy timeout, short transactions, integrity checks, and backups.
- Use `PRAGMA user_version` with explicit ordered migrations. Do not add a migration framework yet.
- Use Node built-ins for HTTP, SSE, fetch, WebSocket client, tests, and child processes.
- Prefer HTTP + SSE for the first local UI. Node's global WebSocket is a client, not a server.
- Permit one runtime schema-validation dependency, Ajv. “Zero dependency” is not a security goal.

`better-sqlite3` is more mature but adds a native-addon distribution surface on Windows and Node 24. It is not justified until `node:sqlite` causes a measured problem. A language rewrite would delay the risk-discovery Spike without solving the AionCore trust boundary.

## 12. Alternatives Review

| Candidate | Strength | Material limitation | Decision |
|---|---|---|---|
| AionCore + Conductor | Best structured runtime coverage for Claude, Codex, Antigravity, and Gemini; reusable sessions and streaming | Local auth, endpoint discovery, approval durability, and Windows containment need proof/fixes | **Primary, conditional** |
| Agent Orchestrator (AO) | Strong Windows handling, worktree lifecycle, roster, OpenAPI, and agent switching | Antigravity and Gemini are terminal-only in the reviewed capability matrix; adding Conductor duplicates an existing orchestration control plane | **Fallback only if P0 fails**. [architecture](https://github.com/OrchestratorInc/agent-orchestrator/blob/d86288526dd91c58904cc35f4515f75070488cab/docs/architecture.md), [capability matrix](https://github.com/OrchestratorInc/agent-orchestrator/blob/d86288526dd91c58904cc35f4515f75070488cab/frontend/src/docs/content/plugins/agents/index.mdx) |
| Paperclip | Strongest completion-contract, evidence, organization, and reassignment concepts | Native Windows spawn and worktree cleanup have open blockers; Postgres/web stack is larger than needed | **Borrow data-model ideas only**. [completion contracts](https://github.com/paperclipai/paperclip/blob/7eadc714d239368eda4fdbfdbdcf9d6a958f761f/packages/db/src/schema/completion_contracts.ts), [Windows spawn issue #10012](https://github.com/paperclipai/paperclip/issues/10012), [cleanup issue #10765](https://github.com/paperclipai/paperclip/issues/10765) |
| Claw-Empire | Existing leader selection and worktree lifecycle | Automatic Git operations are too aggressive for a state-preserving local tool; runtime boundary is less suitable | **Reference only**. [leader selection](https://github.com/GreenSheep01201/claw-empire/blob/66a24ea7df2435ef897c48c147deb7ec572c01c2/server/modules/workflow/orchestration/meetings/leader-selection.ts), [worktree lifecycle](https://github.com/GreenSheep01201/claw-empire/blob/66a24ea7df2435ef897c48c147deb7ec572c01c2/server/modules/workflow/core/worktree/lifecycle.ts) |
| AI Meeting Room | Useful checkpoint/diff/scope/rollback verification pattern | README is macOS-only; fixed Claude/Codex flow and no general worktree/runtime layer | **Reference only**. [README](https://github.com/sojei1989/ai-meeting-room/blob/5ec944db44ffdbcac8e9b199fea522599ed7973f/README.md), [Git verification](https://github.com/sojei1989/ai-meeting-room/blob/5ec944db44ffdbcac8e9b199fea522599ed7973f/server/git.js) |

Do not implement AionCore and AO adapters in parallel. Prove the primary P0 path. Switch only if a defined blocker fails.

## 13. Overengineering Review

Remove or defer these items from the first implementation:

- seven generic roles;
- arbitrary task DAG scheduling;
- dynamic leader handoff before ordinary crash recovery works;
- full event-sourced state reconstruction;
- experiment orchestration and comparative metrics;
- local LLM routing and summarization;
- a full multi-pane UI;
- universal independent reviewers;
- automatic worktree restore or cleanup;
- a custom policy language;
- a handwritten JSON Schema validator;
- a database abstraction or migration framework;
- generalized backend capability normalization before three real adapters pass the same bounded scenario.

Each item can be added when a measured workflow requires it. None is needed to prove one reliable task from dispatch through verified completion.

## 14. Underengineering Review

The current document needs more precision in these areas:

- authenticated client identity and exclusive approval ownership;
- AionCore endpoint discovery and API/version compatibility;
- WebSocket event ordering, reconnect cursor, deduplication, and gap recovery;
- durable approval state and crash reconciliation;
- external side-effect uncertainty and idempotency;
- leader/task/decision/handoff generations;
- trusted protocol parsing and transport-bound identity;
- protected verification inputs and evidence binding;
- Windows Job Object, shim, quoting, Unicode, and long-argument behavior;
- worktree dirty/untracked state, branch collisions, locks, reparse points, case collisions, submodules, sparse checkout, and LFS;
- SQLite migration, backup, integrity, and corruption recovery;
- localhost UI Origin/CSRF/session-token protection;
- threat model for credentials, repository hooks, package scripts, caches, daemons, ports, and external APIs.

These are not requests for an enterprise framework. They are the minimum boundaries needed to make the existing claims true.

## 15. Revised MVP

### P0 Spike — runtime boundary only

Run only after separate user authorization to install or start the exact pinned AionUi/AionCore release. Use a disposable repository, disposable credentials, no secrets, and no production remotes.

Acceptance probes:

1. Conductor-owned AionCore launch and machine-readable endpoint discovery.
2. Server/version check and fail-closed mismatch behavior.
3. Conversation create/get/list/update/delete; confirm that archive is absent or identify its contract.
4. Workspace, backend, model, thought/effort, permission, skills, and MCP configuration per target agent.
5. Send/read/stream completion, disconnect/reconnect, duplicate and out-of-order events.
6. Cancel/restart/resume and crash recovery.
7. Approval list/confirm, concurrent AionUi/Conductor response, duplicate response, restart during pending approval, and stale-list race.
8. Direct local API bypass from an agent-side process. Record this as a security result, not only a functional test.
9. Claude, Codex, and Antigravity one-turn probes. Gemini is optional until the first three pass.
10. `.cmd`, Unicode, multiline and long prompt transport.
11. Job Object process-tree termination with a fast-spawning grandchild.

Stop on a P0 failure. Do not build product orchestration around an unproven adapter.

### MVP-0 — one verified task

- CLI only.
- One disposable repository, one task, one agent, one task-attempt worktree.
- Sequential execution.
- Manual approvals only.
- Fixed trusted verification commands.
- Current-state SQLite tables plus audit records.
- No leader, reviewer, web UI, experiments, local LLM, or automatic cleanup.

Acceptance: a task is dispatched, changed files remain in scope, trusted targeted verification passes, evidence binds to the exact tree/dirty state, and all owned processes stop.

### MVP-1 — bounded cooperation

- One fixed leader, one write worker, and a reviewer only for high-risk tasks.
- Per-task-attempt worktrees.
- Strict JSON envelope with Ajv validation.
- Durable inbox/outbox, task attempt fencing, and explicit unknown-delivery state.
- Trusted verification service and protected acceptance probe.
- Concurrency remains 1 until deterministic recovery passes; then allow 2.

No dynamic leader handoff, experiments, local LLM, or full UI.

### MVP-2 — durable handoff and recovery

- Durable handoff saga.
- `leader_epoch`, `task_attempt`, `decision_revision`, and handoff phase fencing.
- Crash injection for all handoff phases.
- Automated tests for race cases A–F.
- Reconnect cursor/gap handling and duplicate message tests.
- Retry/reassignment with stale-result rejection.

### MVP-3 — optional product surface

Add only after measured need:

- minimal local web UI over authenticated localhost HTTP + SSE;
- richer role templates and task graphs;
- experiment comparison;
- local LLM summarization/routing;
- Gemini integration if its adapter passes the same contract;
- OS sandbox for broader threat models;
- AionUi visual integration if exclusive approval ownership is solved.

OS isolation cannot be deferred when production credentials, sensitive repositories, or hostile repository content are in scope.

## 16. Required Changes Before Implementation

Only these items block implementation beyond the Spike:

1. **Define the trust model.** State whether agents and repository content are cooperative or hostile. Remove every claim that worktrees or approval policy provide process containment.
2. **Resolve runtime ownership.** Choose Conductor-owned AionCore with supported stdout discovery, or obtain an upstream-supported authenticated attach contract. Do not depend on private Electron IPC or socket enumeration.
3. **Resolve approval authority.** Establish one writer, durable decision records, conflict behavior, and the rule that AionUi cannot approve managed conversations. If bypass-resistant enforcement is required, change AionCore or add OS isolation.
4. **Pass the Windows Job Object gate.** Prove full descendant termination for direct executables and command shims, or fix the runtime before use.
5. **Replace the initial scope with section 15.** Begin with the P0 Spike and MVP-0. Dynamic handoff, experiments, local LLM, and full UI are not implementation prerequisites.

## 17. Final Recommendation

1. **Should the project use AionCore + Conductor?** Yes, conditionally. It is the best fit for structured access to the target agent backends, but only as a pinned runtime behind a proven adapter. The current local desktop mode is not an enforceable multi-client security boundary.
2. **Should the project fork AionUi/AionCore now?** No. First run the P0 Spike. Request an upstream change or create a narrow fork only if endpoint discovery, authenticated/scoped clients, exclusive approval ownership, or Windows process containment cannot be solved through supported behavior. Keep any fork minimal and tied to an explicit failing acceptance test.
3. **Must the architecture change before implementation?** Yes. Reduce the MVP, separate Git isolation from security isolation, make verification inputs trusted, add durable message/attempt fencing, and remove the assumption that `leader_epoch` or event replay solves all recovery races.
4. **Should worktrees be per worker or per task?** Per task attempt for all write work. Persistent worker lanes are only for trusted read-only or strictly sequential jobs.
5. **Should Node 24 + TypeScript + `node:sqlite` remain?** Yes. Add type checking, one JSON Schema validator, explicit SQLite safeguards, and a release build. Do not rewrite the stack.
6. **What may proceed now?** Only a separately authorized P0 Spike in a disposable environment. No installation, runtime execution, fork, or product implementation was authorized or performed by this review.

**Final decision: CONDITIONAL GO for the P0 Spike; NO-GO for product implementation until section 16 is satisfied.**


