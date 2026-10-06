# Multi-Agent Collaboration Platform — Architecture & Plan (Phase 0: Research)

- 日期：2026-10-06　狀態：Research / Planning only（未修改任何程式）
- 研究方法：`gh api` 唯讀讀取原始碼（指定 commit）、GitHub Issues/PR、本機唯讀偵測。三個子研究結論已由主 Agent 抽查關鍵路徑。
- 標記：`UNVERIFIED` = 未能由程式碼或官方資料確認；`(suspected)` = 程式碼跡象但未實測。

| Repo | Commit | 日期 | License | 規模/活躍度 |
|---|---|---|---|---|
| iOfficeAI/AionUi | `6744099b279b` (v2.2.2) | 2026-09-09 | Apache-2.0 | 33k★, 703 open issues, Electron+TS |
| iOfficeAI/AionCore | `4a707fc3d3cd` (v0.2.2) | 2026-09-30 | Apache-2.0 | 21 contributors, Rust (Axum/Tokio/SQLite), 每週 release |
| paperclipai/paperclip | `7eadc714d239` | 2026-10-06 | MIT | 97.7k★, web + Postgres |
| OrchestratorInc/agent-orchestrator (AO) | `d86288526dd9` | 2026-10-06 | Apache-2.0 | 12.8k★, Go daemon + Electron |
| GreenSheep01201/claw-empire | `66a24ea7df24` | 2026-03-16（停滯 7 個月） | Apache-2.0 | 1.4k★ |
| sojei1989/ai-meeting-room | `5ec944db44ff` | 2026-10-06（建立當天） | Apache-2.0 | 3★ |

---

## 1. Executive Summary

**判定：CONDITIONAL GO — 以 AionUi/AionCore 作為「Agent 執行底座（runtime）」；不以其 Team Mode 作為「協作編排底座」。**

- **適合的部分（直接重用、不改 code）**：AionCore 真的透過官方 CLI 執行 Claude Code（`claude --print --input-format stream-json …`）、Codex（`codex app-server` JSON-RPC）、Antigravity（`agy -p … --output-format stream-json`），Gemini CLI 走 ACP（`gemini --acp`）；有 per-conversation workspace / model / reasoning、session resume、approval 卡片 REST API、MCP/Skills 以「session 注入」方式傳入而不寫使用者全域設定、Windows Job Object + `taskkill /T`。
- **不適合的部分**：Team Mode 的 Leader 是寫死的 enum 且不可更換（AionUi #4269 OPEN）、所有成員共用同一 workspace（`workspace_mode: "shared"` 寫死）、teammate 預設 YOLO、任務完成只靠 Agent 自我回報、Mailbox 是自由文字、crash watchdog 未接線、team run 不跨重啟保存。這些正是本需求核心，若在 fork 中改，會集中在上游最活躍的高衝突檔案。
- **建議架構**：新增一個獨立的 **Conductor（編排層）**，以 AionCore 的 Conversation REST/WebSocket API 為 adapter 驅動各 Agent；Role、Leader、Task Graph、Policy、Worktree、Verification、Handoff、Experiment 全部在 Conductor，**MVP 對 AionUi/AionCore 零修改**（使用官方 release）。Windows bug 修正以 upstream PR 方式回饋。
- **條件（P0 Spike 必須通過才進 P1）**：(1) 外部本機 client 可通過 AionCore 認證並呼叫 conversation/confirmations API；(2) 可為每個 conversation 指定 `extra.workspace`（worktree 路徑）、backend、model、effort；(3) 可由外部程式回應 approval；(4) Windows 下 Claude native exe、Codex/Gemini npm shim、agy 長 prompt 的實際行為符合預期或有可行 workaround。
- **對三個選項的結論**：選 **A. Fork AionUi/AionCore** 的最低分歧版本——「上游作為底座 + 外掛 Conductor」，fork 僅在必要時用於修 Windows bug（且目標是 upstream 合併）。不選 B（沒有更適合的單一專案），不選 C（自建 Agent 執行層成本最高、Windows 坑最多）。

---

## 2. Current Architecture（以實際程式碼路徑說明）

### 2.1 整體
- AionUi（`packages/desktop`，Electron 37 + React）只是殼與 UI；後端是 Rust 二進位 `aioncore`，由 `packages/desktop/src/process/backend/binaryResolver.ts` 解析：**環境變數 `AIONUI_BACKEND_BIN` 覆寫 → 內建 → PATH**。`package.json` 綁定 `"aioncoreVersion": "v0.2.2"`。
- AionCore 架構（`ARCHITECTURE.md`）：24 個 crate，分 Foundation（`aionui-common`、`aionui-api-types`、`aionui-db`、`aionui-runtime`、`aionui-process`）→ Capability（`aionui-auth`、`aionui-realtime`）→ Domain（`aionui-conversation`、`aionui-session`、`aionui-team`、`aionui-ai-agent`、`aionui-mcp`、`aionui-extension`、`aionui-project`…）→ Composition（`aionui-app`）。HTTP REST + WebSocket，SQLite（sqlx）。

### 2.2 需求 20 項對照
| # | 項目 | 實際位置 | 現況摘要 |
|---|---|---|---|
| 1 | Team Mode | `crates/aionui-team/src/{service.rs,session.rs,provisioning.rs,scheduler/*,work_coordinator/*,team_run/*}` | 一個 team = 多個 conversation slot，in-memory `TeamSession` |
| 2 | Leader | `types.rs` `enum TeammateRole { Lead, Teammate }`、`Team.lead_agent_id`；`provisioning.rs` 要求「exactly one team agent must have role lead」 | 建立時可選任一成員；之後不可換 |
| 3 | Teammate | `types.rs` `TeamAgent { slot_id, role, conversation_id, backend, model, assistant_id, status, cli_path }` | 每成員一個 conversation |
| 4 | Agent abstraction | `crates/aionui-ai-agent/src/factory/mod.rs`（`Acp` / `Aionrs` / `Antigravity`）、`factory/acp.rs` 將 claude/codex 路由到 `BackendRoute::DirectCli`；`crates/aionui-session/src/backend/*` | 三類 backend：Direct CLI、ACP、內建 aionrs |
| 5 | Agent Registry | `crates/aionui-ai-agent/src/registry.rs`、DB `agent_metadata`（migrations 003/008/009/025/034…） | builtin + custom + extension 三來源 |
| 6 | Session | `crates/aionui-session/src/{state.rs,reducer.rs,backend/rehydrate.rs,backend/suspend.rs}` | `conversations.backend_session_id` 保存 resume anchor |
| 7 | Task | `aionui-team/src/task_board.rs`、`types.rs` `TeamTask { subject, description, status, owner, blocked_by, blocks, metadata }`，`TaskStatus { Pending, InProgress, Completed, Deleted }` | 有依賴，無 AC/budget/retry/artifact |
| 8 | Permission | `aionui-ai-agent/src/manager/acp/permission_router.rs`、`aionui-conversation/src/routes.rs` `/confirmations/{callId}/confirm`；Team 端 `mcp/tools.rs` `authorize_tool`（只分 LeadOnly/AnyTeamAgent） | 外部可經 REST 回應 approval |
| 9 | Claude Code adapter | `aionui-session/src/adapter/claude.rs`、`backend/claude_conn.rs`、`aionui-ai-agent/src/claude_flags.rs` | 見 §3 |
| 10 | Codex adapter | `aionui-session/src/backend/codex_conn.rs`、`factory/acp_launch_policy.rs` | 見 §3 |
| 11 | Antigravity adapter | `aionui-session/src/backend/antigravity/{argv.rs,conn.rs,…}`、`aionui-ai-agent/src/antigravity_hook.rs` | 見 §3 |
| 12 | Gemini adapter | 無專屬 code；DB seed `gemini --acp`（migration 001→025），走通用 ACP manager `manager/acp/*` | 見 §3 |
| 13 | Local Model | `factory/aionrs.rs`、`aionui-system/src/model_fetcher/fetchers.rs`（`{base}/models`） | 只當 OpenAI-compatible provider |
| 14 | MCP | `crates/aionui-mcp/src/{session_injection.rs,sync_service.rs,adapters/*}` | session 注入；`sync_service` 註明 read-only |
| 15 | Skills | `aionui-ai-agent/src/skill_delivery_plan.rs`、`aionui-extension/src/skill_view.rs`（migration 043 `skill_delivery`） | Claude argv / Codex protocol / 其他 prompt 注入 |
| 16 | Workspace | `aionui-team/src/workspace.rs`、`service.rs:802` `workspace_mode: "shared".into()`；conversation 端 `extra.workspace`（`aionui-conversation/src/runtime_create.rs`） | Team 共用；單一 conversation 可指定任意絕對路徑 |
| 17 | Windows process | `crates/aionui-process/src/{process.rs,proc_tree.rs,proc_control.rs}`、`crates/aionui-runtime/src/spawn.rs` | Job Object + taskkill /T；見 §9 |
| 18 | Persistence | `crates/aionui-db/migrations/001…044`、`repository/sqlite_*.rs` | teams/mailbox/team_tasks 落 DB；run state 在記憶體 |
| 19 | Frontend Team UI | AionUi `packages/desktop/src/renderer/pages/team/*`、`common/types/team/teamTypes.ts`、`TeamCreateModal.tsx` | 建立時選 Leader；UI 寫死 `workspace_mode: 'shared'` |
| 20 | Backend orchestration | `aionui-team/src/{scheduler/*,work_coordinator/*,team_run/manager.rs,mailbox.rs,mcp/server.rs}` | wake-based；13 個 Team MCP tools |

### 2.3 Team Mode 細節（判斷不採用其編排的依據）
- **Leader 固定**：`routes.rs` 無更換 Leader 的 route；`UpdateTeamParams.lead_agent_id` 只在 test mock 使用。Leader 角色同時存在 `TeamRow.lead_agent_id`、`TeamAgent.role`、conversation `extra.role` 三處；role prompt 只在第一次 wake 注入（`scheduler/state.rs` `take_needs_role_prompt`）；Leader 不可 context reset（`LeaderNotTargetable`）；`service.rs:1036` `"cannot remove the team lead"`。AionUi PRD `docs/prds/teams/team-runtime-experience.md`：Leader「恒为成员列表第一个，不可移除」。
- **權限**：`service/spawn_support.rs` `session_mode_for_backend` 預設回傳 `yolo_id`（claude `bypassPermissions`、codex `agent-full-access`、agy `yolo`）——註解說明是避免 teammate 卡在無人回應的權限提示。治理規則（`aionui-team-prompts/src/governance.rs`）只存在 prompt。
- **通訊**：`mailbox.rs` `MailboxMessageType { Message, IdleNotification, ShutdownRequest }`，content 自由文字；控制訊號用魔術字串（`"shutdown_approved"`、`"shutdown_rejected:"`）。13 個 MCP tools 定義於 `crates/aionui-api-types/src/team_tools.rs`。
- **完成判定**：teammate prompt「When done, use team_task_update to mark the task "completed"」（`role_prompt.rs`），無任何 exit code/test/diff 檢查。
- **Crash**：`scheduler/crash_recovery.rs` `handle_agent_crash` 經 code search 只出現在本檔、tests、docs（production 未接線，suspected）；`MAX_MESSAGE_DELIVERY_FAILURES = 3` 後暫停 slot。Team run 狀態在記憶體（`team_run/manager.rs`），重啟遺失（AionCore PR #682 OPEN）。
- **相關 Issues**：AionUi #4269（換 Leader）、#3747（teammate 不能改 model/reasoning, Windows）、#4279（team run 永不結束）、#4116、#3389、#3931（Persistent Teams + Work Board 提案）；AionCore #953（teammate 未注入 assistant rule）、#950、#390。

---

## 3. Agent Integration Matrix

| Agent | Current Support | Execution Method | CLI/API | Session Resume | Permission | Windows | Known Gap |
|---|---|---|---|---|---|---|---|
| **Claude Code** | 完整（Direct CLI，非 ACP） | 長駐 process：`claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio`，加 `--append-system-prompt`、`--mcp-config <json> --strict-mcp-config`、`--permission-mode`（`adapter/claude.rs`、`claude_conn.rs`） | 真 CLI（使用者自裝，不 bundle） | `--session-id` → `--resume <id>`（`--fork-session` 分叉）；in-flight turn 不保留 | `can_use_tool` → 卡片 → allow/deny；mode：default/acceptEdits/bypassPermissions/plan/dontAsk/auto；刻意不用 `--dangerously-skip-permissions` | npm 安裝時走 `cmd /d /c claude.cmd`：多行參數被截斷 + 8191 字元上限（AionUi #4296）。**本機為 native `~\.local\bin\claude.exe`，可避開** | model 以 in-band `set_model` 套用；驗證版本 2.1.280（本機 2.1.290） |
| **OpenAI Codex** | 完整（Direct CLI，非 ACP） | `codex app-server` JSON-RPC over stdio；`thread/start{approvalPolicy, sandbox, cwd, config.mcp_servers, developerInstructions}`（`codex_conn.rs`） | 真 CLI | `thread/resume` / `thread/fork` | `approvalPolicy` on-request/never + `sandbox`（預設 workspace-write）；`*/requestApproval` → `{decision}` | full-access 加 `-c windows.sandbox="unelevated"`；本機為 npm `.cmd` shim（prompt 走 stdin，推定不受 #4296 影響，UNVERIFIED） | effort 取自 `model/list` 的 `supportedReasoningEfforts`；驗證版本 0.151.0（本機 0.160.0） |
| **Google Antigravity** (`agy`) | 支援（專屬 backend，非 ACP） | 每 turn 一個 process：`agy -p <prompt> --output-format stream-json --dangerously-skip-permissions --print-timeout 1h [--conversation id] --add-dir <ws> --model --mode`（`antigravity/argv.rs`） | 真 CLI | `--conversation <id>` | CLI 層一律 skip-permissions，再以寫入 `<workspace>/.agents/hooks.json` 的 PreToolUse hook 回呼 AionCore 實作審批；~30 秒未回應自動 deny；yolo = 不裝 hook | prompt 以 argv 傳遞 → >32,767 字元 `os error 206`（AionUi #4294）；`agy --help` 顯示支援 `--input-format stream-json`（stdin） | **無 MCP**（agy 只讀 `~/.gemini/config/mcp_config.json`，AionCore 刻意不寫）；skills 只能 prompt 注入；hook 檔寫進 workspace |
| **Gemini CLI** | 支援（通用 ACP） | `gemini --acp`（PATH binary，migration 025） | 真 CLI（ACP） | ACP `session/load`（若支援）否則重建 | ACP `request_permission` → 卡片；full-auto `yolo` | 本機為 npm `.cmd` shim；Gemini 專屬行為 UNVERIFIED | 無專屬整合測試；skill 用 prompt 注入 |
| **Ollama** | 僅作 OpenAI-compatible provider | 由內建 aionrs 引擎（in-process Rust agent，`aionrs v0.2.11`）直接打 HTTP | Model API（非 CLI） | `{data_dir}/aionrs-sessions` | aionrs `ToolApprovalManager`；yolo 自動核准 | HTTP，無 process 問題 | 無 preset/偵測；**本機未安裝 Ollama** |
| **LM Studio** | 同 Ollama（code search `lmstudio` 無結果） | 同上（`http://localhost:1234/v1`） | Model API | 同上 | 同上 | 同上 | 本機已安裝 `lms` |
| 其他 ACP Agent | 20+ registry agents（`npx -y <pkg@pinned>`，`runtime/resources/acp-registry-npx-lock.json`） | ACP | 依 agent | ACP | ACP | managed Node | custom agent 必須講 ACP |

**「真正 Agent CLI 還是只有 model API？」**：Claude Code / Codex / Antigravity / Gemini 是**真 CLI**（使用者自己安裝的 binary，AionCore 不安裝 CLI）；Ollama / LM Studio 是 **model API**（由 aionrs 引擎提供 tool loop）。`cli_version.rs` 記錄驗證版本，版本漂移只報告不阻擋。

**本機偵測（唯讀）**：claude 2.1.290（native exe）、codex 0.160.0（npm shim）、agy 1.2.17（exe）、gemini 0.45.0（npm shim）、lms 存在、Ollama 未安裝、AionUi 未安裝、pwsh 7.6.6、Git for Windows 2.54、Node 24.16、WSL 存在、`LongPathsEnabled=1`、git `core.longpaths` 未設定、主控台 UTF-8、culture zh-TW。

---

## 4. Requirement Gap Analysis

| 需求 | 狀態 | 證據 / 說明 |
|---|---|---|
| 單一桌面程式管理多 Agent | SUPPORTED | AionUi 本體 |
| 真實執行 Claude Code / Codex / Antigravity / Gemini | SUPPORTED | §3 |
| Ollama / LM Studio / OpenAI-compatible | PARTIAL | 只經 aionrs provider；無 preset |
| Agent 與 Role 分離、自訂 Role | MISSING | Role 只有 Lead/Teammate；assistant「rule」不是 role 系統 |
| 任務前指定 Leader | SUPPORTED | `TeamCreateModal.tsx` leaderSelectionId |
| 任一 Agent 可當 Leader | SUPPORTED | 同一 provisioning 路徑，只需 team-capable |
| Runtime 更換 Leader / Handoff | MISSING | #4269 OPEN；多處假設 Leader 固定（§2.3） |
| 每成員不同 Agent | SUPPORTED | `TeamAgent.backend`（由 assistant 決定） |
| 每成員不同 Model | PARTIAL | `PATCH …/agents/{slot}/model` 存在；UI 有 bug #3747 |
| 每成員不同 Reasoning Level | PARTIAL | 只能經 conversation config option，未存 roster（UNVERIFIED 重建後是否保留） |
| Task Graph（依賴、狀態） | PARTIAL | 有 blocked_by/blocks；無 cycle 檢查、無狀態機、任何 agent 可改任何 task |
| Task 的 AC / Budget / Retry / Artifacts / Evidence | MISSING | 無欄位 |
| 結構化通訊（Task/Result/Question/Decision/Review/Handoff） | MISSING | Mailbox 自由文字 + 魔術字串 |
| Decision 成為 state | MISSING | — |
| Worktree / per-task branch 隔離 | MISSING | 共用 workspace；全 repo 無 worktree 隔離 code |
| 程式強制的 Policy（檔案範圍、shell、git、網路、budget、concurrency、timeout） | MISSING / RISKY | teammate 預設 YOLO；治理只在 prompt |
| Approval 由外部程式回應 | SUPPORTED | `/api/conversations/{id}/confirmations/{callId}/confirm` |
| Verification Layer（PROCESS_SUCCESS ≠ TASK_SUCCESS） | MISSING | 完成 = 自我回報 |
| Experiment Mode / Metrics | MISSING | 無 token/cost/run 指標表 |
| Crash resume（CLI session） | PARTIAL | session anchor 可 resume；in-flight turn 遺失 |
| Leader crash 恢復 | RISKY | 只能使用者手動 restart；無接手 |
| MCP / Skills 傳給不同 Agent 且不寫全域設定 | SUPPORTED（agy 例外） | session 注入；agy 無 MCP、hook 寫 workspace |
| 不修改既有全域設定 | SUPPORTED（需監控） | `mcp/src/adapters/*` 有 `install_server`（`claude mcp add-json -s user` 等）但 production 無呼叫；`POST /api/skills/export-symlink` 為使用者觸發 |
| Windows 原生 | PARTIAL / RISKY | #4296、#4294、#4208、#3124；無 `CREATE_NO_WINDOW`、無 UTF-8 code page / long path 處理（§9） |
| Upstream 可持續合併 | RISKY（若改 Team core） | Team crate 是最活躍區；migration 序號衝突 |

---

## 5. Proposed Architecture

核心原則：**AionCore = Agent Runtime（不改）；Conductor = 唯一的狀態寫入者與政策執行者；Agent 只「提議」，Conductor「驗證後套用」。**

```
┌──────────────────────── AionUi（官方 release，不改）────────────────────────┐
│  各 Agent conversation 照常可見（名稱如 [T-12][Developer] codex）            │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ REST + WebSocket（本機）
┌───────────────┴──────────── AionCore（官方 release，不改）──────────────────┐
│ Direct CLI: claude / codex / agy │ ACP: gemini … │ aionrs: Ollama/LM Studio │
│ Job Object、session resume、approval 卡片、MCP/Skills session 注入           │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ AionCore Client（adapter）
┌───────────────┴──────────────── Conductor（新模組）─────────────────────────┐
│ UI Panel │ Orchestrator │ Role System │ Agent Registry │ Task Graph          │
│ Permission Engine │ Workspace Manager │ Verification Layer │ Experiment Engine│
│ Persistence（SQLite, append-only event log）│ Context / Handoff Builder      │
└──────────────────┬───────────────────────────────┬─────────────────────────┘
                   │ git CLI（worktree/diff/merge）  │ HTTP（本機 LLM：摘要/分類）
```

| 元件 | 職責 | 實作要點 |
|---|---|---|
| **UI** | 提需求、看 Task Board、核准、換 Leader、看 Experiment 結果 | MVP：Conductor 本機 Web Panel（127.0.0.1）；之後以 AionUi extension（`aionui-extension` 的 `settings_tab`/`webui` resolver）嵌入，或在 AionUi 新增獨立 page（新檔案為主，低衝突）。Agent 對話本身仍在 AionUi 看 |
| **Orchestrator** | 狀態機推進、派工、併發控制、timeout、retry | 決定論（deterministic）迴圈；只有它能改 state |
| **Role System** | Role 定義（prompt 範本、允許的 permission profile、驗證職責）；Role ↔ Agent 指派 | Role 為設定檔（JSON），內建 Leader/Planner/Developer/Debugger/Reviewer/Tester/Researcher，可新增自訂 Role；指派表帶 `leader_epoch` |
| **Agent Registry** | 可用 Agent、能力旗標（can_write / can_shell / trust_level / 支援 MCP）、model/effort 選項 | 由 AionCore agent/assistant API 同步 + 本地能力設定 |
| **Agent Adapter** | 統一介面：create session(workspace, model, effort, role brief)、send envelope、stream events、list/answer approvals、cancel、restart | 唯一實作：`AionCoreClient`（不另寫 CLI adapter——重用 AionCore） |
| **Task Graph** | Task/Subtask、依賴 DAG（含 cycle 檢查）、狀態機 | 狀態：BACKLOG→PLANNING→WAITING_APPROVAL→READY→RUNNING→REVIEW→DONE，另 BLOCKED/FAILED/CANCELLED |
| **Permission Engine** | 規則化決策：auto-allow / deny / escalate-to-user | 見 §8 |
| **Workspace Manager** | per-task worktree + branch、diff、scope 檢查、integration merge | 見 §7 |
| **Verification Layer** | DONE 的唯一閘門 | 見 §5.3 |
| **Experiment Engine** | 同一任務 × 多種團隊組合，記錄指標 | 見 §5.4 |
| **Persistence** | SQLite（Node 內建 `node:sqlite`）+ append-only `events` 表 | 重啟後可重建全部 state |
| **Memory / Context** | Project Context = Decisions + AC + Task Graph 摘要；長 log 由本機 LLM 壓縮 | 不把聊天紀錄當 state；既有 ai-memory 只讀參考（P後期） |

### 5.1 Task 資料模型（最小欄位）
`id, run_id, parent_id, goal, role, owner_agent, depends_on[], allowed_scope[]（glob）, deliverables[], acceptance_criteria[], verify_commands[]（來自專案設定或經核准）, status, budget{max_turns, max_wall_min}, retry_count/max_retries, worktree_path, branch, base_commit, artifacts[], evidence[]（verification 紀錄 id）, blockers[], created_at, updated_at, version`
另有：`decisions(id, run_id, question_ref, decision, decided_by, leader_epoch, at)`、`envelopes`、`approvals`、`verifications`、`role_assignments(run_id, role, agent, conversation_id, leader_epoch, active)`、`metrics`、`events`。

### 5.2 結構化通訊（Envelope）
Conductor → Agent：`Task`、`Answer`、`RevisionRequest`、`Handoff`、`Decision`（通知）。
Agent → Conductor：`Plan`（Leader 提出 Task Graph/指派）、`Result`、`Question`、`Review`、`Decision`（Leader 對 Question 的裁決）、`HandoffAck`。
- 傳輸：Conductor 以一般訊息送出（含 envelope id、task id、schema 說明）；Agent 回覆中必須含一個 ```` ```json ```` 區塊符合該 type 的 schema。Conductor 解析、驗證，失敗則送 `RevisionRequest`（計入 retry）。
- 例：Agent 回 `{"type":"Question","task":"T-12","text":"API 日期用 ISO String 還是 Timestamp？"}` → Conductor 轉給 Leader → Leader 回 `{"type":"Decision","id":"D-7","answers":"Q-…","decision":"ISO 8601 String"}` → Conductor 寫入 `decisions` 並附在所有後續相關 Task 的 context。
- 為何不用 MCP tools 給 Leader（MVP）：MCP 呼叫者身分綁定需額外驗證（AionCore 有 `x-aionui-runtime-token` + conversation id 機制可用於日後），且「Agent 只提議、Conductor 套用」使權力邊界在程式裡。日後可加 Conductor MCP server 當另一種傳輸，schema 不變。
- 長內容（>~20k 字元）一律寫成 worktree 內 `.conductor/` 檔案並以路徑引用（同時避開 #4294 / #4296 的命令列長度問題）。

### 5.3 Verification Layer（DONE 閘門）
Agent 回 `Result` 只把 Task 推到 `REVIEW`。DONE 需依序通過：
1. **Process gate**：該 turn 正常結束（非 cancel/error/timeout）。
2. **Change gate**：`git -C <wt> status --porcelain` / `diff --name-only <base>...`：changed files 非空（若 deliverable 需要改檔）且全部落在 `allowed_scope`；超出 → FAILED 並可一鍵 `git restore`（ai-meeting-room 的 checkpoint→diff→scope→rollback 模式，套在 worktree 內）。排除 `.agents/hooks.json`（agy hook）、`.conductor/`。
3. **Artifact gate**：deliverables 中宣告的檔案存在。
4. **Test/Build gate**：Conductor 自己在 worktree 執行 `verify_commands`（不是採信 Agent 回報），記錄 exit code、耗時、輸出尾段；timeout 殺整棵 process tree。
5. **Review gate**：由**不同於作者**的 Reviewer 角色 Agent 回 `Review{verdict: approve|request_changes, findings[]}`（paperclip `reviewPolicy: not_creator` 概念）；reject → `RevisionRequest`，計 `review_reject_count`。
6. 全過 → Conductor commit（若 Agent 未 commit）→ DONE；任何 gate 結果都存 `verifications` 表作為 evidence。

### 5.4 Experiment Engine
- Experiment = 固定 `repo@base_commit` + Task 規格 + verify_commands + N 個 Team 組合（例如 A/B/C/D-單獨 Codex）。每個組合一個 Run，**依序執行**（避免互搶 rate limit 造成干擾），各自全新 worktree。
- 指標（Conductor 原生、精確）：success/failure、completion time、retry count、review reject count、test pass rate、human intervention count（使用者核准/手動操作次數）、merge conflict 數、agent error 數。
- Token/Cost：MVP 標 `unknown`（不填 0）；P後期以唯讀解析 CLI 自身 transcript（Claude `~/.claude/projects/*.jsonl`、Codex rollout）＋價目表取得（參考 AO `backend/internal/domain/usage.go` + `internal/pricing`）。
- Final Quality：gate 結果 + reviewer verdict + 選填人工 1–5 分。
- 每個 Run 記錄 CLI 版本、model、effort、role 指派，確保可重現。輸出 JSON/CSV。

---

## 6. Leader Handoff Design

前提：Leader 只是「被指派 Leader 角色的某個 Agent conversation」，真正的 state 在 Conductor DB，所以 Handoff 是**狀態轉移**而不是聊天轉移。

流程（使用者說「Codex 接手當工頭，Claude 改 Debugger」）：
1. **Freeze**：Run 進入 `HANDOFF` 子狀態；Conductor 停止接受舊 Leader 新的 `Plan/Decision`，不派新工作；執行中的 worker 繼續跑（結果先暫存佇列）。
2. **Exit note（可選、限時）**：請舊 Leader 回 `HandoffNote`（≤N 字、需含「進行中判斷與疑慮」）；舊 Leader 已 crash 或逾時則略過。內容標記為「untrusted summary」。
3. **Build HandoffPacket（決定論，由 DB 產生，不靠 LLM）**：原始需求、Acceptance Criteria、Task Graph（每 task 狀態/owner/依賴）、已完成/未完成清單、Decisions log、Open Questions、已知問題與 Blockers、各 Agent 目前任務、每個 worktree 的 branch / ahead-behind / dirty 狀態（由 git 即時計算）、最新 verification 結果、Artifacts、權限狀態（待核准項目、已授權範圍）、已用預算，附上舊 Leader 的 HandoffNote。
4. **Reassign（單一 DB transaction）**：`role_assignments` 舊 Leader 設 inactive、`leader_epoch += 1`、新 Leader 生效；此後帶舊 epoch 的訊息一律拒絕（防止舊 Leader 遲到的指令生效）。
5. **新 Leader session**：一律**新建** conversation（即使該 Agent 原本已有 Developer conversation），送 Leader role brief + HandoffPacket，要求回 `HandoffAck{understood_goal, plan_delta, questions}`；Conductor 驗證後解凍。避免舊角色 prompt 汙染（AionCore 的 role prompt 只注入一次的教訓）。
6. **舊 Leader 改派**：以新 role（Debugger）建立新 conversation 並給該 role 的任務 context；舊 Leader conversation 保留唯讀供稽核。
7. **Audit**：`events` 記錄 handoff 全程；Experiment 指標記一次 human intervention。

Leader crash 時：Conductor 偵測 turn error/timeout → Run 進 `LEADER_UNAVAILABLE`；選項 (a) `runtime/restart` 同一 Agent 並以 HandoffPacket 重建 context，(b) 直接 Handoff 給另一 Agent。兩者共用同一套 Packet。

---

## 7. Workspace Isolation Design

- **每個寫入型 Task 一個 worktree + branch**（唯讀 Role 如 Researcher/Reviewer 可用 detached worktree 或 base worktree 唯讀模式）：
  - branch：`conductor/<run>/<task>-<agent>`；路徑：短根目錄（預設 `E:\cw\<repo>\<task>`，可設定）——避開 MAX_PATH、避免放在 repo 內造成巢狀 repo/索引噪音。
  - 指令：`git -C <repo> -c core.longpaths=true worktree add -b <branch> <path> <base_commit>`（per-command `-c`，**不改 git 全域設定**）。
  - AionCore conversation 以 `extra.workspace = <worktree path>` 建立（已確認 `runtime_create.rs` 寫入 `extra.workspace`，要求絕對路徑且存在）。
- **Integration**：`conductor/<run>/integration` branch（從 base 建立）。Task DONE 後由 Conductor 依 DAG 順序 merge（`--no-ff`）；衝突 → 建 `Integrate/Resolve` 子任務指派給 Debugger 角色在新 worktree 解衝突，記 `merge_conflict` 指標。
- **最終交付**：integration branch 全部 verify 通過後，只做**本機 merge 提案**；merge 到 main / push / PR 一律 WAITING_APPROVAL 由使用者核准（MVP 不自動 push）。
- **清理**：Run 結束後 `git worktree remove`（使用者確認後）＋ `git worktree prune`；Windows 檔案鎖定（agent process 未退出）時延後重試，不 `--force` 刪除未提交內容（參考 AO `gitworktree/remove_repair_windows.go`）。
- agy 會在 workspace 寫 `.agents/hooks.json`：worktree 建立時寫入該 worktree 的 `info/exclude`（per-worktree，不改 repo 檔案）並在 scope 檢查排除。

---

## 8. Permission & Security Model

四層，全部由程式執行，不依賴 prompt：

1. **Agent 層權限模式（AionCore 參數）**：Conductor 建立 conversation 時指定 permission mode——寫入型 Role 用 `acceptEdits`（Claude）/ `workspace-write + on-request`（Codex）/ hook gate（agy）/ ACP 預設（Gemini）；唯讀 Role 用 `plan` / read-only。**MVP 禁止 bypass/yolo/full-access**。
2. **Approval 決策（Permission Engine）**：Conductor 監聽 approvals（`GET /confirmations` + WebSocket），依規則回應 `/confirm`：
   | 動作 | 決策 |
   |---|---|
   | 讀檔/搜尋（worktree 內） | 自動允許 |
   | 編輯/新增檔案（worktree 內且符合 allowed_scope） | 自動允許 |
   | 任何 worktree 外路徑的寫入 | 自動拒絕 |
   | Shell：allowlist（專案 test/build/lint、`git status/diff/log/add/commit`） | 自動允許 |
   | Shell：其他指令、網路存取（curl/npm install/pip install 等）、`git push/merge/reset --hard/clean/branch -D/worktree remove`、刪除檔案、修改全域設定/PATH/Registry、安裝軟體、部署 | 升級給使用者核准（或直接拒絕，依設定） |
   | 逾時未決 | 拒絕（agy hook 30 秒自動 deny 與此一致） |
3. **隔離與事後檢查**：worktree 隔離 + Change gate（超出範圍即判 FAILED 並可回復）——即使某 Agent 繞過 approval，也無法讓越界變更進入 integration。
4. **Conductor 保留動作**：merge 到 integration、刪 worktree、任何 push/PR/deploy 只有 Conductor 能做，且外發動作一律需使用者核准。
- **Budget/Concurrency/Timeout/Retry（Conductor 強制）**：同時 RUNNING conversation 上限（預設 2）、每 Task `max_turns`、`max_wall_min`（逾時 → `POST /cancel`，必要時 `runtime/restart`）、`max_retries`（預設 2，超過 → BLOCKED 等人處理）。Token/$ budget 待 metrics 可取得後加入（Deferred）。
- **Credentials**：Conductor 不讀、不存任何 token；各 CLI 使用既有登入。注意 AionCore 會**唯讀**讀 `~/.claude/settings.json` 與 `~/.cc-switch/*` 以注入 provider env（`aionui-ai-agent/src/cc_switch/*`）。
- **已知殘餘風險**：Agent 的 shell 子程序本身仍能存取網路與使用者憑證（例如 git credential manager）；MVP 以 approval 規則 + 無自動 push 緩解，作業系統層沙箱（Codex Windows sandbox、WSL）列 Deferred。

---

## 9. Windows Design

| 問題 | 現況（證據） | 方案 |
|---|---|---|
| npm `.cmd` shim 以 `cmd /d /c` 執行：多行參數截斷、8191 上限 | AionUi #4296；`aionui-runtime/src/spawn.rs` `resolve_program` | Claude 用 native `claude.exe`（本機已是）；長 prompt 改檔案引用；upstream PR：優先解析 `.exe`/node 直接執行 |
| CreateProcess 32,767 字元上限（agy prompt 走 argv） | AionUi #4294；`antigravity/argv.rs` 推 `-p <prompt>` | Envelope 保持精簡、長內容寫 `.conductor/*.md`；upstream PR 改用 `--input-format stream-json`（stdin） |
| Process tree 終止 | Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（`aionui-process/src/process.rs`）+ `taskkill /F /T`；但 Windows 的 `configure_platform_spawn` 為空（`spawn.rs:297`），未見 `CREATE_SUSPENDED`（suspected：assign 前可能已產生子程序）；crash cleanup 只 `TerminateProcess` 單一 process | Conductor 不自行 spawn Agent CLI；自己執行的 verify 指令用 `spawn(argv, {shell:false, windowsHide:true})`，逾時 `taskkill /T /F /PID`；回報 upstream |
| 主控台視窗閃爍 | repo 無 `CREATE_NO_WINDOW`（code search） | Conductor 端 `windowsHide:true`；AionCore 端 P0 實測 |
| UTF-8 / 中文 | 無 code page 處理 | verify 指令以 `pwsh -NoProfile -NonInteractive -Command` 並先設 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new()`；env `PYTHONUTF8=1`；git 加 `-c core.quotepath=false`；一律以 UTF-8 解碼並保留原始 bytes |
| 中文路徑、含空白路徑 | 本 repo 路徑 `E:\Git\台灣股票\…` 即為實例 | 全程 argv 陣列、不拼字串、不用 `shell:true`；P2 測試以中文+空白路徑為必測案例 |
| Long paths | 系統 `LongPathsEnabled=1`；git `core.longpaths` 未設 | per-command `git -c core.longpaths=true`；worktree 放短根目錄 |
| Git for Windows / worktree | 檔案鎖導致 remove 失敗（AO 有 Windows repair code） | 移除前確認相關 conversation 已停止；失敗延後重試，不 force |
| CLI discovery | AionCore `cli_probe.rs` + PATHEXT 解析 | 重用 AionCore 偵測結果；Conductor 不自行改 PATH |
| 環境變數 | AionCore spawn 前移除 `NODE_OPTIONS`、`CLAUDECODE` 等；`enhance_process_path` 只改自身 process | 不修改系統/使用者環境變數 |
| Prompt/skills 偏 bash | AionUi #4208 | Role brief 明確告知 Windows + PowerShell 7；verify_commands 以 pwsh 撰寫 |
| WSL | 存在但非必需 | Deferred：可選 execution backend（例如 sandbox 型任務） |

---

## 10. Upstream Compatibility

- **MVP 對 AionUi/AionCore 零修改**：使用官方 release；Conductor 為獨立 repo、只依賴公開的 REST/WS API（`aionui-conversation/src/routes.rs` 等）。上游升級時只需跑 Conductor 的 adapter contract tests。
- **API 漂移風險控管**：`AionCoreClient` 集中所有呼叫；記錄測試通過的 `aioncoreVersion`；`api-types` 有變更時 contract test 失敗即停。
- **必須 fork 時（僅 Windows bug）**：用 `AIONUI_BACKEND_BIN` 指向自建 `aioncore.exe`，AionUi 本體不 fork；patch 以小 PR 送 upstream（#4294 改 stdin、#4296 避免 `cmd /c`、`CREATE_NO_WINDOW`/`CREATE_SUSPENDED`）。
- **高衝突區（避免修改）**：`crates/aionui-team/src/{service.rs,provisioning.rs,types.rs,scheduler/*,mcp/tools.rs,mcp/server.rs}`、`crates/aionui-team-prompts/*`、`crates/aionui-api-types/src/{team.rs,team_tools.rs}`、`crates/aionui-db/migrations/*`（**序號遞增且有 immutability 檢查** `scripts/migration/check-immutability.*`，fork 新增 migration 必與上游撞號）、AionUi `renderer/pages/team/*`、`common/types/team/teamTypes.ts`。
- **可擴充點（不需 fork）**：custom agent（`POST /api/agents/custom`，需 ACP）、extension resolvers（`acp_adapter`、`model_provider`、`mcp_server`、`skill`、`settings_tab`、`webui`）、provider 設定（OpenAI-compatible base_url）。
- **Upstream contribution 機會**：Leader 更換（#4269）、per-member reasoning（#3747）、worktree 模式（`WorkspaceMode` 型別已有 `'isolated'` 但未實作）——待 Conductor 驗證設計後，再評估是否把成熟部分貢獻回 Team Mode。

---

## 11. MVP Scope（第一個可用閉環）

一個 repo、一個 Run、1 Leader + 1–2 Worker，完成「需求 → 計畫 → 派工 → worktree 實作 → Conductor 驗證 → Review → integration branch」並可中途換 Leader、記錄實驗指標。

包含：
1. AionCoreClient：建立 conversation（workspace/backend/model/effort/permission mode）、送訊息、事件串流、approvals 列表與回應、cancel、restart。
2. Role 設定檔（7 個內建 + 自訂）與指派（手動指定全部 / 只指定 Leader 由 Leader 提議 → 使用者確認）。
3. Task Graph + 狀態機 + SQLite + event log + 重啟重建。
4. Envelope 協定（JSON 區塊 + schema 驗證 + 重問）。
5. Workspace Manager（worktree、scope diff、integration merge、清理需確認）。
6. Permission Engine（§8 規則表 + 使用者升級核准）、concurrency/timeout/retry。
7. Verification Layer（§5.3 六道閘門）。
8. Leader Handoff（手動觸發）+ Leader/Worker crash 處理。
9. Experiment：同一任務跑多組合，輸出 JSON/CSV（token/cost 標 unknown）。
10. 最小 UI Panel：需求輸入、Task Board、Approvals、Handoff、Experiment 結果。
11. 本機 LLM（LM Studio OpenAI-compatible HTTP，無 tool 權限）：log 壓縮、Result 摘要。
支援 Agent：Claude Code、Codex、Antigravity（MVP 必測）；Gemini CLI（可用即納入）。

## 12. Deferred Features
- 系統自動選團隊、依歷史資料推薦團隊（需先累積 Experiment 資料）。
- Token/$ 精確計量與 budget hard stop（transcript 解析 + 價目表）。
- Conductor MCP server（Leader 以 tool call 操作）與 runtime token 身分綁定。
- 嵌入 AionUi（extension / 新 page）、Office 風格視覺化、部門/層級（Paperclip/Claw-Empire 式）。
- GitHub PR/CI 整合、自動 push、遠端 Agent、Channels（Slack/Lark…）。
- WSL / OS 層沙箱 backend、>3 併發、跨 repo 任務。
- 本機 LLM 取得 shell/寫檔權限（依 Experiment 結果再決定）。
- 與 ai-memory / STE80 等既有記憶系統雙向整合（MVP 只讀）。
- 把設計回饋到 AionCore Team Mode 的 upstream PR。

---

## 13. Implementation Plan

技術選擇：Conductor 用 **Node 24 + TypeScript（Node 原生 type stripping 直接執行）**，只用內建模組：`node:sqlite`、`node:test`、`fetch`、全域 `WebSocket`、`node:child_process`。**零第三方 runtime 依賴**；不需安裝 Rust toolchain（本機無 cargo）。位置：`E:\CodexProject\multi-agent-platform\conductor\`（新 repo）。

| Phase | Goal | Files / Modules | Risk | Tests | Acceptance Criteria |
|---|---|---|---|---|---|
| **P0 Spike**（需使用者核准安裝 AionUi） | 驗證 §1 四個條件 | `spikes/`（一次性腳本，不入產品） | AionUi 安裝會建立 `%APPDATA%\AionUi`、可能設開機啟動（#4281）；外部 client 認證方式（`AuthIdentityMode::Local` 是否可用）未知 | 手動腳本：建 conversation（指定 worktree workspace + model + effort）、送訊息、攔截並回應 approval、cancel、restart；agy 長 prompt；claude.exe 多行 brief | Spike 報告逐條 PASS/FAIL 附輸出；任一 FAIL 則回到架構決策 |
| **P1 Core state** | Task Graph、狀態機、DB、event log | `src/db/schema.sql`、`src/state/{task.ts,run.ts,roles.ts}`、`src/events.ts` | 狀態機邊界情況 | 狀態轉移表全覆蓋、DAG cycle 拒絕、重啟後由 events 重建一致 | 單元測試 PASS；非法轉移被拒並記錄 |
| **P2 Workspace Manager** | worktree/branch/diff/scope/merge/cleanup | `src/workspace/{git.ts,worktree.ts,scope.ts,integrate.ts}` | Windows 檔案鎖、長路徑、中文路徑 | 暫存 repo 整合測試：中文+空白路徑、>260 字元路徑、scope 越界偵測、merge 衝突產生、remove 鎖定重試 | 全部測試在 Windows PASS；不觸碰 git 全域設定（測試前後比對 `git config --global --list`） |
| **P3 AionCore adapter + Envelope** | 驅動 conversation、解析結構化回覆 | `src/agents/aioncoreClient.ts`、`src/protocol/{envelopes.ts,validate.ts}`、`src/agents/registry.ts` | API 漂移、Agent 不照格式回覆 | contract tests（錄製的 API 回應 fixture）、envelope validator 正反例、重問次數上限 | 對三個 Agent 各完成一次 Task→Result 往返 |
| **P4 Policy & Orchestrator** | approval 規則、concurrency/timeout/retry、派工迴圈 | `src/policy/{rules.ts,engine.ts}`、`src/orchestrator/loop.ts` | 規則誤放行；approval 競態（AionUi UI 同時可按） | 規則表逐項測試（含 worktree 外路徑、`git push`、`npm install`）、timeout 觸發 cancel | 越權動作 100% 被拒或升級；逾時 Task 進 FAILED/BLOCKED 並保留 worktree |
| **P5 Verification Layer** | 六道閘門、Reviewer 流程 | `src/verify/{gates.ts,runner.ts,review.ts}` | verify 指令輸出編碼、process tree 殘留 | 「Agent 宣稱完成但測試失敗」「改到範圍外」「artifact 不存在」「reviewer 與作者相同」皆不得 DONE；殺樹測試 | 只有全閘門通過才 DONE；每次判定都有 evidence 紀錄 |
| **P6 Handoff & Recovery** | Leader 更換、Leader/Worker crash 處理 | `src/handoff/{packet.ts,handoff.ts}`、`src/recovery.ts` | 舊 Leader 遲到訊息、packet 遺漏 | epoch 拒收測試、packet 欄位完整性快照測試、模擬 crash 後重啟重建 | 執行中換 Leader 不重開任務，未完成工作與 worktree 全保留 |
| **P7 Experiment** | 多組合同任務、指標輸出 | `src/experiment/{runner.ts,metrics.ts,export.ts}` | 組合間環境不一致 | 相同 base commit 驗證、指標計數單元測試 | 4 組合（A/B/C/D）可跑完並輸出 CSV/JSON，缺值標 unknown |
| **P8 UI Panel + 本機 LLM** | 最小操作介面、log 壓縮 | `src/ui/*`（靜態頁 + 本機 HTTP）、`src/llm/openaiCompat.ts` | UI 只綁 127.0.0.1 | 手動 E2E：從需求到 integration branch 全程 | 使用者只用 Panel + AionUi 即可完成一個閉環 |

每個 Phase 結束：本機驗證 → commit 到工作分支 → 依全域規則 §15 請 Codex review（push/PR 需使用者授權）。

---

## 14. Open Questions（無法由程式碼或官方資料確認，需使用者決定）
1. **是否同意 P0 安裝 AionUi**（新桌面程式，會建立自己的資料目錄與 DB；不修改 Claude/Codex/Gemini 設定，但 agy 的 hook 檔會寫進工作目錄）？
2. **訂閱與額度**：Claude / Codex / Antigravity 各自的方案與可接受的同時 session 數、每日用量上限？（影響 concurrency 與實驗排程；官方 rate limit 依帳號方案而定）
3. **Experiment 的目標 repo 與任務**：用哪個 repo（建議先用一個可拋棄的測試 repo，而非 TWstock 正式 repo）？
4. **Antigravity 審批方式**：接受 AionCore 的 workspace hook gate（寫 `.agents/hooks.json` 到 worktree），還是先讓 Antigravity 只擔任唯讀角色（Reviewer/Researcher）？
5. **是否需要安裝 Ollama**，或本機 LLM 先只用已安裝的 LM Studio？

（P0 Spike 會自行查證：外部 client 認證方式、per-conversation effort 保存、approval API 競態、console 視窗閃爍、Codex npm shim 行為。）

---

## 15. Recommendation

| 方案 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| **A. Fork AionUi/AionCore（最低分歧：上游當 runtime + 外掛 Conductor）** | 已有真 CLI 整合（Claude/Codex/agy/Gemini/20+ ACP）、Windows Job Object、session resume、approval API、不寫全域設定的 MCP/Skills 注入；Apache-2.0；活躍維護；MVP 不需改 upstream | Team Mode 不可用於核心需求；依賴其 REST API 穩定度；Windows 仍有已知 bug 需 workaround/upstream PR | **採用** |
| B. 其他專案 | AO：ConPTY、worktree、agy、harness switch saga；Paperclip：完整 task/approval/budget/evidence 模型 | AO 無 task graph/role/policy、Windows process bug 多、主要靠 TUI+hook；Paperclip 為 web+Postgres、Windows 執行多處壞（#10012、#10765）、YOLO Gemini；Claw-Empire 停滯；AI Meeting Room 為一天大的玩具專案 | 不採用；作為設計參考 |
| C. 自建 | 完全掌控 | 需自己處理 4 種 CLI 協定、Windows process/編碼/shim 坑、session resume——正是 AionCore 已解決的部分 | 不採用 |

**最終建議：A。** 以 AionUi/AionCore 官方版本為 Agent 執行底座，新建 Conductor 承擔 Role/Leader/Task Graph/Policy/Worktree/Verification/Handoff/Experiment；從其他專案只借設計、不搬程式：
- AO：`domain/agent_switching.go`（handoff saga 的冪等設計）、`adapters/workspace/gitworktree/*`（Windows remove/repair）、`domain/usage.go` + `internal/pricing`（token/cost）。
- Paperclip：`completion_contracts` + `server/src/services/native-runtime/evidence-classifier.ts`（證據式完成）、`budget_policies`/`cost_events`、`issue_relations`（blocks）、`reviewPolicy: not_creator`。
- AI Meeting Room：checkpoint → diff → scope → rollback（`server/orchestrator.js`、`server/git.js`）、唯讀規劃角色的 tool allowlist。
- Claw-Empire：`messages.message_type` 列舉、per-agent provider 綁定、各 CLI 的唯讀 plan 模式。

下一步：等待獨立 Architecture Review；通過後由使用者決定 Open Questions 第 1 項，才進入 P0 Spike。

---

## Appendix A. 核心問題 30 題直接回答

| # | 問題 | 回答 |
|---|---|---|
| 1 | AionUi/AionCore 適合當底座？ | 適合當 **Agent 執行底座**；不適合當 **協作編排底座**（§1、§2.3） |
| 2 | 不適合的原因 | Leader 固定、共用 workspace、預設 YOLO、自我回報完成、自由文字 mailbox、crash watchdog 未接線、run 不跨重啟 |
| 3 | 有更符合的專案？ | 沒有。AO 最接近（Windows ConPTY、worktree、agy、harness switch），但缺 task graph/role/policy；Paperclip 模型最完整但 Windows 執行多處壞（§15） |
| 4 | Leader 可動態指定？ | 建立 Team 時可選任一成員（`TeamCreateModal.tsx`）；之後不可 |
| 5 | Leader 可 runtime handoff？ | 不可（無 route；#4269 OPEN） |
| 6 | 每 teammate 不同 Agent？ | 可（`TeamAgent.backend`，由 assistant 決定） |
| 7 | 每 teammate 獨立 Model？ | 後端可（`PATCH …/agents/{slot}/model`）；UI bug #3747 |
| 8 | 每 teammate 獨立 Reasoning？ | 只能經 conversation config option，未存入 roster；#3747 OPEN。單一 conversation 則可（Codex `supportedReasoningEfforts`、Claude effort flag、agy model 後綴） |
| 9 | Claude Code adapter | 長駐 `claude --print` stream-json 雙向，`--permission-prompt-tool stdio`，`--resume`（§3） |
| 10 | Codex adapter | `codex app-server` JSON-RPC，`thread/start|resume|fork`，approvalPolicy + sandbox（§3） |
| 11 | Antigravity adapter | 每 turn `agy -p … --output-format stream-json --dangerously-skip-permissions`，以 workspace PreToolUse hook 回補審批，`--conversation` resume（§3） |
| 12 | 真 Agent CLI 還是 model API？ | Claude/Codex/agy/Gemini 為真 CLI；Ollama/LM Studio 為 model API（aionrs 引擎） |
| 13 | 目前共用 workspace？ | Team 是（`service.rs:802` 寫死 shared）；單一 conversation 可各自指定 `extra.workspace` |
| 14 | 多 Agent 同時寫檔會衝突？ | 會；Team 無鎖、無 worktree、無衝突處理（只靠 Leader prompt 依序派工） |
| 15 | Permission system | Agent CLI 權限模式 + AionCore approval 卡片（REST 可回應）；Team 只分 LeadOnly/AnyTeamAgent；teammate 預設 YOLO |
| 16 | Windows 已知限制 | #4296（cmd shim 截斷/8191）、#4294（argv 32767）、#4208（bash 導向 prompt）、#3124（ACP stdout）、無 CREATE_NO_WINDOW、Windows spawn 未 suspended（suspected）、無 UTF-8/long path 處理（§9） |
| 17 | Local LLM 接入 | OpenAI-compatible provider（base_url）→ aionrs；Conductor 另以 HTTP 直接呼叫做無權限用途 |
| 18 | MCP / Skills 如何傳 | MCP：Claude `--mcp-config --strict-mcp-config`、Codex `thread/start.config.mcp_servers`、ACP `session/new.mcpServers`、agy 無；Skills：Claude `--plugin-dir/--add-dir`、Codex `skills/extraRoots/set`、其他 prompt 注入；皆不寫全域設定 |
| 19 | Task State 保存 | AionCore：`team_tasks` 表；Conductor：自有 SQLite + event log |
| 20 | Team State 保存 | AionCore：`teams`（roster JSON）、`mailbox` 在 DB；`TeamSession`、run、佇列在記憶體 |
| 21 | Process crash 後 resume？ | CLI session 可經 anchor resume；in-flight turn 遺失；team run 遺失（PR #682 OPEN） |
| 22 | Leader crash 後恢復？ | AionCore：僅使用者手動 restart。Conductor：restart 同 Agent 或 Handoff，共用 HandoffPacket（§6） |
| 23 | CLI crash 處理？ | AionCore：turn error → slot Error，送達失敗 3 次暫停；Conductor：Task 計 retry → 超過上限 BLOCKED，worktree 保留 |
| 24 | 如何加 worktree isolation | Conductor Workspace Manager + conversation `extra.workspace`（§7），不改 AionCore |
| 25 | 如何加 Verification Layer | Conductor 六道閘門（§5.3） |
| 26 | 如何加 Leader Handoff | Conductor role_assignments + leader_epoch + 決定論 HandoffPacket（§6） |
| 27 | 如何加 Experiment Mode | Conductor Experiment Engine（§5.4） |
| 28 | 最可能 upstream 衝突的改動 | 修改 `aionui-team` 核心、team prompts、api-types team、DB migrations（序號）、AionUi team 頁面與型別（§10） |
| 29 | MVP 最少改哪裡 | AionUi/AionCore：**不改**；新增 Conductor（§11、§13） |
| 30 | 應延後的需求 | §12 |
