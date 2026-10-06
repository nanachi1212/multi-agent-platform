# Multi-Agent Collaboration Platform — Architecture V1 (Reconciled)

- 日期：2026-10-06　狀態：**Architecture V1 / Planning only**（未安裝、未執行 P0、未寫產品程式、未 clone、未 commit）
- 輸入：
  - 原始架構 `MULTI_AGENT_PLATFORM_ARCHITECTURE.md`（下稱 **ARCH-0**）
  - Codex Red-Team Review `ARCHITECTURE_REVIEW_CODEX.md`（下稱 **REVIEW**）
  - 使用者產品決策（2026-10-06，下稱 **DECISION**）
- 本文件取代 ARCH-0 作為後續工作的基準；ARCH-0 與 REVIEW 保留原狀作為歷史紀錄。
- 證據標記：
  - `OBSERVED`：本輪或前輪直接由 pinned source、官方文件或本機指令確認。
  - `INFERRED`：由 OBSERVED 證據推導，未實測。
  - `UNVERIFIED`：沒有足夠直接證據；必須由 P0 或後續 gate 確認。
- 原則：不預設 ARCH-0 或 REVIEW 正確；`REJECT` 必須附原始碼或官方證據；沒有新證據時，安全與 correctness 問題採較保守方案。

---

## 0. Reconciliation Summary

| 項目 | V1 結論 |
|---|---|
| 整體方向 | **保留** AionCore（Agent runtime）+ external Conductor（policy / state / verification）。 |
| Runtime 擁有權 | **Conductor-owned AionCore**：Conductor 自己啟動 pinned `aioncore` 子程序並解析其 stdout endpoint。不附著到 AionUi 啟動的動態 endpoint。 |
| AionUi | **不在 MVP 執行鏈**。MVP-3 以後再評估作為 UI。 |
| Fork | **不 fork**。只有 P0 某個具體 acceptance test 失敗且沒有 supported workaround 時才評估最小 patch。 |
| 安全定位 | P0/MVP-0 只處理 disposable、non-sensitive repo；Agent 視為 **cooperative**。Conductor、AionCore local/webui mode、worktree **都不是**抵禦惡意 Agent 的邊界。 |
| Codex P0/P1 findings | 9 項全部 **ACCEPT**、**0 PARTIAL**、**0 REJECT**。其中 P0-1 附修正：新證據顯示問題比 REVIEW 描述更嚴重。P2/P3 共 4 項，全部 ACCEPT。另有 REVIEW §9.4 的一個子項判 **PARTIAL**：Windows 沒有 OS sandbox 時，verification 無法強制關閉網路。詳見 §13。 |
| 本輪新證據 | 6 項（§14）。其中 2 項改變設計：(1) runtime token 在非 local mode 可通過整個 user API；(2) send message 不接受 client idempotency key。 |
| 下一步 | 只有使用者另行授權後才執行 P0 Spike（§11）。依 §12 GO/NO-GO 判定是否進入 MVP-0。 |

---

## 1. Final Architecture

```
                    使用者（CLI；MVP-3 前無 Web UI）
                                │  manual approval / task input
┌───────────────────────────────▼────────────────────────────────────────────┐
│ Conductor（Node 24 + TypeScript，單一 process，單一 SQLite writer）          │
│                                                                            │
│  Orchestrator（deterministic 狀態機；唯一 state writer）                    │
│  Approval Owner（唯一 approval 回應者；CAS decision record）                 │
│  Protocol（strict single-JSON-object envelope + Ajv；MVP-1 起）            │
│  Verification Service（trusted argv、evidence binding）                    │
│  Workspace Manager（per-task-attempt worktree；Git correctness boundary）  │
│  Runtime Supervisor（啟動/版本檢查/監看 aioncore 子程序）                    │
│  Persistence：current-state tables + append-only audit + inbox/outbox      │
└──────────────┬────────────────────────────────────┬────────────────────────┘
               │ spawn + stdout AIONCORE_LISTENING   │ git CLI / verify runner
               │ REST + WebSocket（127.0.0.1）        │（shell:false，Job Object）
┌──────────────▼──────────────────────────────┐      ▼
│ aioncore.exe（pinned release，Conductor 專用   │   per-task-attempt worktrees
│ --data-dir；不與 AionUi 共用）                 │
│  Direct CLI: claude / codex / agy           │
│  ACP: gemini（MVP-3，需通過同一 contract）     │
└─────────────────────────────────────────────┘
```

### 1.1 元件與責任（V1 版）

| 元件 | 責任 | 首次出現階段 |
|---|---|---|
| Runtime Supervisor | 啟動 pinned `aioncore`；解析 `AIONCORE_LISTENING`；版本檢查 fail-closed；監看退出；停止時清理 process tree | MVP-0 |
| AionCoreClient | 唯一的 AionCore API adapter（conversation、message、stream、confirmation、cancel、restart） | MVP-0 |
| Orchestrator | Task 狀態機；唯一 current-state writer | MVP-0（單 task）→ MVP-1（Leader→Worker） |
| Approval Owner | 接收 pending confirmation、寫 decision record、向 AionCore 回應一次 | MVP-0 |
| Workspace Manager | worktree preflight / create / diff / scope / preserve | MVP-0 |
| Verification Service | trusted command 執行與 evidence binding | MVP-0 |
| Protocol | strict envelope、Ajv、dedupe | MVP-1 |
| Inbox/Outbox | external side-effect boundary 的 durable 記錄與 reconcile | MVP-1 |
| Handoff Saga | Leader handoff 的 durable phase 機 | MVP-2 |
| Experiment / Local LLM / UI / 更多 Role / Gemini | — | MVP-3 |

### 1.2 不做的事（V1 明確排除）

- 完整 event sourcing（狀態不由 event replay 重建）。
- 修改 AionCore / AionUi 原始碼；使用 AionCore Team Mode。
- 自動 push / merge 到 main / PR / deploy / 刪除 worktree。
- 任何「worktree 或 approval 能隔離 Agent」的宣稱。
- 修改使用者全域設定（Claude/Codex/Gemini/agy 設定、git global config、環境變數、PATH、Registry、防火牆）。

---

## 2. Trust Model

### 2.1 V1 範圍內的信任假設

| 對象 | 假設 | 依據 |
|---|---|---|
| 使用者 | trusted；唯一能核准 mutating 動作與外部副作用 | DECISION |
| Conductor 程式 | trusted（使用者本機、同一 Windows 帳號） | — |
| AionCore pinned binary | trusted-for-function，**不 trusted-for-isolation** | REVIEW P0-1；§14 E2 |
| Agent（Claude / Codex / agy） | **cooperative**：預期遵守 prompt 與 approval，但不依賴其遵守來保護資料 | DECISION；REVIEW P0-1 |
| Repository 內容 | **disposable、non-sensitive**；無 production remote、無 secrets、無 `.env` | DECISION |
| Agent 輸出（含 JSON envelope、HandoffNote、`.conductor/` 檔案） | **untrusted data**；只能「提議」 | REVIEW P1-3 |

### 2.2 明確不宣稱的保護

1. **Agent 可以繞過 Conductor。** `OBSERVED`：Agent 子程序取得 AionCore base URL 與 runtime token（REVIEW P0-1 引用 `aionui-ai-agent/src/types.rs`）。local mode 的 REST 不需認證；非 local mode 的 runtime token 經 `auth_middleware` 的 `runtime_token_channel` 注入完整 `CurrentUser`，可通過所有掛在 `auth_middleware` 下的 route group（§14 E2）。所以 Agent 技術上能自行建立 conversation、送訊息、回應 approval。
2. **Worktree 不是 sandbox。** `OBSERVED`：linked worktree 共用 object store、refs、`info/exclude`、hooks 與 config（§14 E4；Git 官方文件）。Agent 子程序繼承同一 Windows 帳號的檔案、網路與憑證權限。
3. **Approval 不是 containment。** Approval 只限制 Agent 透過 CLI 工具「宣告」的動作；子程序直接使用 OS 權限不受限制。
4. **agy 的 approval gate 由 workspace 內的檔案控制。** `OBSERVED`（ARCH-0 §3）：AionCore 把 PreToolUse hook 寫入 `<workspace>/.agents/hooks.json`。`INFERRED`：Agent 可改寫此檔而移除自己的 gate。P0 記錄此結果（R9）。

### 2.3 殘餘風險（V1 接受，僅限 cooperative + disposable 範圍）

| 風險 | 說明 | V1 緩解 |
|---|---|---|
| CLI 登入憑證 | Claude/Codex/agy 的使用者登入資料位於使用者 profile，Agent 子程序可讀 | 接受（cooperative）；不提供其他 secrets |
| Git Credential Manager | Agent 的 shell 可能使用 GCM 對其他 repo push | disposable repo 無 remote；shell/git/network 類 approval 一律 manual；P0 記錄 Agent 繼承的 env 名稱（不記值） |
| Browser drive-by 到 local mode API | `OBSERVED`：local mode CORS `allow_origin(Any)`、無 auth、無 CSRF（routes.rs L428-470）。`INFERRED`：使用者瀏覽的任意網頁可能對 127.0.0.1 動態 port 發送 mutating request | P0 測試 `--identity-mode webui`（JWT + CSRF + 非 Any CORS）；MVP-0 的條件見 §4.3 |
| 同帳號其他 process | 可讀 Conductor / AionCore data dir | 接受；data dir 不放 secrets |

### 2.4 升級門檻（不可跳過）

處理 **hostile repository、sensitive credentials、production remote 或 TWstock 等正式 repo** 之前，必須先完成以下至少一項並通過對應 acceptance test：

- OS-level isolation：專用低權限 Windows 帳號、VM、Windows Sandbox、WSL/container 或 AppContainer；或
- Authenticated + scoped AionCore client：Agent 的 runtime token 不能呼叫 conversation create / message send / confirmation confirm（需 upstream 支援或經 §12.3 程序核准的最小 patch）。

在此之前，任何文件、UI 或報告都不得宣稱「Agent 無法繞過 Conductor」。

---

## 3. Runtime Ownership

### 3.1 決策

Conductor 啟動並擁有自己的 `aioncore` 子程序。AionUi 不參與。

### 3.2 可行性證據（source-level；P0 仍需實測）

`OBSERVED`（AionCore `4a707fc`，`crates/aionui-app/src/cli.rs` L16-66、L72-83）：

| Flag | 用途 | V1 用法 |
|---|---|---|
| `--host`（預設 loopback） | 綁定位址 | 保持 `127.0.0.1` |
| `--port`（`0` = OS 指定） | port | `0`，由 stdout 取得實際 port |
| `--data-dir` | DB 與檔案儲存 | Conductor 專用目錄（例如 `<conductor-data>\aioncore`），不與 AionUi `%APPDATA%\AionUi` 共用 |
| `--work-dir` | conversation 預設工作目錄 | 設為空的專用目錄；實際 workspace 一律以 `extra.workspace` 指定 worktree |
| `--parent-pid` | 父程序結束時終止 backend | 設為 Conductor PID |
| `--local` / `--identity-mode {local,webui,aionpro}`（預設 `webui`） | 認證模式 | P0 測兩種；見 §4.3 |
| `--managed-resources-mode {bundled,download}`（預設 `download`） | managed runtime 資源來源 | P0 記錄啟動時的網路下載與寫入位置；優先 `bundled`（R15） |

`OBSERVED`：`cmd_server.rs` 在 bind 後輸出 `AIONCORE_LISTENING {"host","port"}`，並另有「authoritative ready signal」（L23-27、L233-243、L346）。

`OBSERVED`：GitHub release `v0.2.2`（2026-09-09）提供 `aioncore-v0.2.2-x86_64-pc-windows-msvc.zip` 與 `aioncore-checksums.txt`。

`OBSERVED`（版本 pin 修正）：tag `v0.2.2` 指向 `47e66d0`；ARCH-0 與 REVIEW 引用的 `4a707fc` 比 tag 多 21 個 commit。兩者之間只有 12 個檔案不同，**其中不含**本文件引用的任何檔案（auth middleware、cli、routes、process、spawn、conversation service/routes/runtime_create、api-types conversation/confirmation、permission_router、ai-agent types、antigravity）。所以 v0.2.2 release binary 對應的 source 與引用證據一致。

### 3.3 Runtime Supervisor 規則

1. 只執行 `aioncore-checksums.txt` 驗證通過的 pinned binary；binary 路徑與 SHA-256 寫入設定與 audit。
2. 啟動 argv 固定（`shell:false`、`windowsHide:true`）；不經 `cmd.exe`。
3. 只接受 stdout 第一個 `AIONCORE_LISTENING` 機器可讀行；再等 ready signal。不解析一般 log、不列舉 listening socket。
4. 啟動後版本檢查；版本或必要 route 不符 → fail closed，停止子程序，Run 狀態 `BLOCKED`。（版本查詢的實際 route 為 `UNVERIFIED`，P0 R2 確認。）
5. 子程序意外退出 → 所有 RUNNING attempt 轉 `RUNTIME_LOST`，pending approval 轉 `ORPHANED`；不自動重送任何 mutating command（§6.6）。
6. Conductor 結束時：cancel 進行中的 turn → 停止 aioncore → 驗證 process tree 已全部結束（W1）。

---

## 4. Approval Ownership

### 4.1 規則

1. **單一 writer（policy）**：只有 Conductor 的 Approval Owner 可以回應 managed conversation 的 confirmation。AionUi 不連到 Conductor 的 AionCore。
2. **技術上非唯一**：§2.2 第 1 點說明 Agent 仍可直接呼叫 confirm。V1 把這視為 cooperative 假設下的已知風險，並由 P0 R9 量測，不宣稱已防止。
3. **Manual first**：P0 與 MVP-0 的所有 mutating approval（寫檔、shell、git mutation、網路、process control、worktree 外路徑）都由使用者在 Conductor CLI 核准。沒有 "always allow"。
4. **Auto-allow 只限唯讀**：只有在 confirmation payload 含**typed** path，且解析後的 final path 位於指定 worktree 內時，才可自動允許讀檔/搜尋。缺欄位或無法解析 → manual 或 deny。
5. **No approval by prose**：Agent 的文字或 envelope 不能核准任何動作。
6. **逾時**：未決 → `EXPIRED`，對 AionCore 回 deny（若 route 仍接受）。agy hook 約 30 秒自動 deny（ARCH-0 §3，`UNVERIFIED` 精確值，P0 R8 量測）；若人工核准無法在時限內完成，agy 在 MVP-0 只能擔任唯讀角色或接受「逾時即 deny」。

### 4.2 Decision record（SQLite）

```
approvals(
  approval_id TEXT PK,            -- Conductor 產生
  aion_call_id TEXT NOT NULL,     -- AionCore callId
  conversation_id TEXT NOT NULL,
  task_id TEXT, task_attempt INTEGER,
  observed_action TEXT NOT NULL,  -- 原始 payload（UTF-8，大小上限）
  normalized_resource TEXT,       -- 可解析時才填；否則 NULL
  state TEXT NOT NULL CHECK(state IN
        ('PENDING','APPROVED','DENIED','EXPIRED','ORPHANED','DELIVERY_UNKNOWN')),
  decision_by TEXT,               -- user / policy:<version>
  policy_version TEXT,
  created_at, resolved_at,
  aion_result TEXT,               -- AionCore 回應原文或錯誤碼
  UNIQUE(conversation_id, aion_call_id)
)
```

- 轉移只允許 `PENDING → APPROVED | DENIED | EXPIRED | ORPHANED`，以 `UPDATE … WHERE state='PENDING'` 做 compare-and-swap；affected rows = 0 → conflict，不送第二次 confirm。
- Resolved 記錄保留為 tombstone；同一 `aion_call_id` 再次出現 → 不建立新記錄，記 audit。
- 先寫 decision（transaction commit）再呼叫 AionCore confirm。confirm 回 "not found" → `aion_result` 記錄並將 state 標為 `DELIVERY_UNKNOWN`（可能已被他方處理或 runtime 已重啟），不重試。
- AionCore 重啟後 pending 清單消失（REVIEW P1-1，`OBSERVED` in-memory）→ 所有 PENDING 轉 `ORPHANED`；對應 attempt 轉 `BLOCKED`。

### 4.3 Identity mode 決策

| 模式 | 優點 | 缺點 | V1 地位 |
|---|---|---|---|
| `--local` | 最簡單；AionUi 實際使用的模式 | 無 auth、無 CSRF、CORS Any（browser drive-by 面） | P0 baseline |
| `--identity-mode webui` | JWT + CSRF + 非 Any CORS；阻擋無 token 的 browser/同帳號 process 呼叫 | Conductor 需建立本機 user 並保存一組本機產生的密碼（user-only ACL，不寫入 log/audit）；runtime token 仍可通過整個 user API（§14 E2）；功能相容性 `UNVERIFIED` | **MVP-0 優先目標** |

MVP-0 條件：`webui` 模式通過 R3 功能 probe → 使用 `webui`。若失敗 → 使用者必須明確接受 local mode 的 drive-by 風險才可進 MVP-0，並在 audit 記錄此決定。理由：沒有新證據證明 local mode 安全時，採較保守方案。

---

## 5. Revised Protocol

### 5.1 適用範圍

- **MVP-0 不使用 control protocol**：只有一個 Agent；完成判定完全由 Conductor 的 gate 決定（§6）。Agent 回覆是自由文字，只寫入 audit。
- **MVP-1 起**：Leader/Worker 的控制訊息使用本節協定。一般對話文字不在控制協定內。

### 5.2 Response 單位

- 協定 response = 該 turn 完成（`turn.completed`）時的 **final assistant message 全文**。
- 該 message 去除前後空白後必須**恰好是一個 JSON object**。Markdown fence、前後 prose、多個 object → 拒絕。
- 同一 turn 中 tool call 之前的中間 narration 只記 audit，永不解析。
- `UNVERIFIED`：AionCore stream 是否能區分 final assistant message 與中間 message（P0 R6）。若無法區分，改為「整個 turn 的 assistant text 合併後必須是單一 JSON object」（更嚴格）。

### 5.3 Parse 與驗證順序（每步失敗即拒絕）

1. UTF-8 byte 上限：64 KiB。
2. **Duplicate key 檢查**：`JSON.parse` 與 Ajv 都不會拒絕重複 key（ECMAScript `JSON.parse` 取最後值）。所以先用一個小型 strict scanner 檢查重複 key、nesting depth ≤ 8、單一 string ≤ 16 KiB、array ≤ 256。Scanner 必須有正反 fixture 測試。
3. `JSON.parse`。
4. Ajv（唯一 runtime schema dependency，pinned 版本）：每個 `type` 一個 closed schema，`additionalProperties:false`；未知 `type` 或未知 `v` → fail closed。
5. Sender binding：sender = `conversation_id → role_assignment` 的對應；JSON 內不得有 `from` / `sender` 欄位（schema 不允許）。
6. Generation 檢查（§5.5）。
7. Dedupe：`(message_id, payload_sha256)` 相同 → idempotent replay（不重複處理）；`message_id` 相同但 hash 不同 → security audit error，attempt 轉 `BLOCKED`。
8. 寫 inbox + 狀態 CAS + audit + outbox，在同一 `BEGIN IMMEDIATE` transaction。

### 5.4 共同欄位

```json
{
  "v": 1,
  "type": "Result",
  "message_id": "msg_01J9ZK3Q7X8M4N2P5R6S7T8V9W",
  "in_reply_to": "cmd_01J9ZK2A1B2C3D4E5F6G7H8J9K",
  "task_id": "tsk_01J9ZJ…",
  "task_attempt": 1
}
```

- ID 格式：`^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$`（prefix + ULID）。
- 序號/revision：非負 safe integer。
- `in_reply_to` 必須等於 Conductor 送出的 `command_id`。

### 5.5 Message types（依階段）

| 階段 | Conductor → Agent | Agent → Conductor | Generation 檢查 |
|---|---|---|---|
| MVP-1 | `Task`、`Answer`、`RevisionRequest`、`ReviewRequest` | Worker：`Result`、`Question`；Leader：`Plan`、`Decision`、`Review` | Worker 訊息：`task_attempt` = 目前 assignment；Leader 訊息：`leader_epoch`（MVP-1 固定為 1）+ `decision_revision` CAS |
| MVP-2 | `HandoffPacket` | `HandoffNote`（舊 Leader，untrusted）、`HandoffAck`（新 Leader） | 加上 `handoff_id`、`phase`、`snapshot_audit_seq` |

- `Plan` 中的 verification command 只是**提議**；必須經使用者核准才成為 trusted policy（§6.1）。
- 驗證失敗 → `RevisionRequest`（含錯誤碼，不含 Agent 原文的再解讀），計入 `protocol_retry`；上限 2 次，超過 → `BLOCKED`。
- `Decision` 必須帶 `decision_revision`；新的 decision 以 `supersedes_id` 指向舊的；遲到的舊 revision 記為 `STALE`，永不覆寫。

### 5.6 送出端與 delivery 不確定性

- `OBSERVED`（§14 E3）：`SendMessageRequest` 的 `msg_id` 由 server 產生，「clients must not provide one」。所以 AionCore 沒有 client idempotency key，**不宣稱 exactly-once**。
- Conductor 送出的每則訊息內文包含 `command_id`（例如第一行 `conductor-command-id: cmd_…`）。
- 送出前先在 outbox 記 `PENDING_SEND`；收到 `msg_id` 後記 `SENT`。
- 若在兩者之間 crash：重啟後以 message list 搜尋該 conversation 是否已有含此 `command_id` 的 user message。找到 → `SENT`；找不到 → `DELIVERY_UNKNOWN`，由使用者決定重送或放棄（重送沿用同一 `command_id`）。
- Conversation create 同理：把 `conductor_command_id` 放進 `extra`，重啟後以 list 對帳。
- `UNVERIFIED`：message list 是否原樣回傳內文、`extra` 是否 round-trip（P0 R10）。若不成立，crash 後一律 `DELIVERY_UNKNOWN` + manual。
- Large content（>16 KiB）寫入 Conductor 控制的儲存區；放進 worktree `.conductor/` 的只是 untrusted copy，訊息內附 expected SHA-256。

---

## 6. Verification Contract

### 6.1 Trusted command 來源

- 只有三個來源：**使用者**、**trusted project policy**（Conductor 設定目錄中、使用者核准過的檔案；不是 worktree 內可被 Agent 修改的檔案）、**Conductor 內建 gate**。
- Agent 可以提議 command；提議必須經使用者核准，並以新的 `policy_version` 存檔。Agent 不能移除、放寬或替換既有 command。
- 每個 command 以 argv 陣列保存，記錄 `command_sha256`（argv + cwd 規則 + env allowlist 的 canonical JSON hash）。

### 6.2 Gates（依序；DONE 的唯一途徑）

| Gate | 內容 | 失敗結果 |
|---|---|---|
| G1 Process | turn 正常完成（非 cancel/error/timeout），且該 attempt 的 owned process tree 已停止 | `FAILED` |
| G2 Change | `git status --porcelain=v2 -z` 與 `git diff --name-only -z <base>`：所有變更落在 `allowed_scope`；已知 runtime artifact（例如 `.agents/hooks.json`）只在 hash 符合 AionCore 產生內容時才排除；其他未宣告檔案 → 失敗 | `FAILED`，worktree 保留 |
| G3 Protected paths | 若變更觸及 test runner 設定、CI/build 設定、package scripts、lockfile、verification policy 或 acceptance 資產 → 需使用者明確核准；核准後必須另有 worktree 外的 acceptance probe | `BLOCKED` |
| G4 Artifact | 宣告的 deliverable 檔案存在 | `FAILED` |
| G5 Test/Build | Conductor 執行 trusted argv（§6.3） | `FAILED` / `BLOCKED` |
| G6 Review（條件式） | 只在 high-risk task（security、schema/migration、data integrity、跨核心 contract）要求不同 principal 的 reviewer；reviewer 不能是作者，也不能是審自己工作的 Leader | `REVISION` |

全部通過 → `DONE`。Agent 的 "done" 宣告只會把 attempt 推到 `VERIFYING`。

### 6.3 執行規則

1. `spawn(argv, {shell:false, windowsHide:true})`；不把 Agent 文字插入 PowerShell 或 `cmd.exe` 字串。
2. 每個 command 有 timeout 與 output byte 上限；逾時 → 終止整個 owned process tree（W2）。
3. env 以 allowlist 建立；設 `PYTHONUTF8=1`；git 指令加 `-c core.quotepath=false`；使用 porcelain 格式，不解析本地化輸出。
4. temp/cache 目錄盡可能指向 attempt 專用目錄。
5. **網路**：Windows 上沒有 OS sandbox 時，Conductor 無法對單一子程序關閉網路（關閉需改防火牆或使用 AppContainer，屬系統設定變更，V1 禁止）。所以 evidence 記錄 `network: not_isolated`。這是 REVIEW §9.4 的 PARTIAL（§13）。
6. 一般 task 只跑 targeted checks；完整驗證只用於跨核心 contract、依賴、schema/migration、大型重構、security 或高資料完整性風險。

### 6.4 Evidence record

```
verifications(
  verification_id PK, task_id, task_attempt,
  gate TEXT, result TEXT CHECK(result IN ('PASS','FAIL','BLOCKED','NOT_TESTED')),
  policy_version, command_argv_json, command_sha256, cwd,
  base_commit, head_commit, tree_id,
  dirty_untracked_digest,          -- 排序後 (path, mode, sha256) 清單的 hash
  started_at, ended_at, exit_code, timed_out INTEGER,
  stdout_sha256, stderr_sha256, output_tail TEXT,
  process_tree_terminated INTEGER, network_isolation TEXT
)
```

- 任何後續檔案變更（`tree_id` 或 `dirty_untracked_digest` 改變）→ 先前 evidence 失效，必須重跑。
- 失敗的 worktree 與 evidence 一律保留；不自動 restore、不自動刪除。

---

## 7. Worktree Model

### 7.1 定義

Worktree = **Git correctness / concurrency boundary**：固定 base、明確 owner、可界定的 diff、可 fence 的 attempt。**不是 security sandbox**（§2.2）。

### 7.2 規則

| 項目 | V1 規則 |
|---|---|
| 粒度 | 每個 write task **attempt** 一個 worktree + branch。Retry = 新 attempt = 新 worktree（從同一 base）。舊 attempt 的 worktree 保留供檢查。 |
| 唯讀 Role | MVP-1 的 Leader / Reviewer 使用 detached worktree（base commit 或待審 attempt 的 commit）；不寫回。 |
| Branch | `conductor/<run_id>/<task_id>/a<attempt>` |
| Path | 短根目錄（預設 `E:\cw\<repo_key>\<task_short>-a<attempt>`，可設定），位於 repo 外 |
| 建立 | `git -C <repo> -c core.longpaths=true worktree add -b <branch> <path> <base_commit>`；只用 per-command `-c`，不改 global/system config |
| AionCore | conversation 以 `extra.workspace = <worktree absolute path>` 建立；建立後讀回確認（P0 R5） |
| Staging | Conductor 只 stage 通過 G2 的明確路徑（`git add -- <paths>`）；不使用 `git add -A` |
| Integration | MVP-0：不 merge，結果留在 attempt branch 給使用者檢查。MVP-1：Conductor 在使用者核准後 `merge --no-ff` 到 `conductor/<run_id>/integration`；衝突 → 停止並回報，不自動派工解衝突（MVP-3 再評估）。 |
| 最終交付 | 合併到 main、push、PR 一律由使用者另行授權 |
| 清理 | 只在使用者確認後執行 `git worktree remove`（不加 `--force`）+ `git worktree prune`。遇到 `ERROR_SHARING_VIOLATION`：只停止 owned process，bounded backoff 重試，仍失敗 → 保留並回報 `BLOCKED` |

### 7.3 ARCH-0 更正：`info/exclude`

ARCH-0 §7 說「寫入該 worktree 的 `info/exclude`（per-worktree）」——**錯誤**。`OBSERVED`（§14 E4）：在 linked worktree 中 `git rev-parse --git-path info/exclude` 解析到 main repo 的 `.git/info/exclude`（shared common dir）。V1 不修改 `info/exclude`；以 G2 的 exact-file + hash 分類與 explicit staging 取代。

### 7.4 Preflight（任一成立 → fail closed，attempt `BLOCKED`）

- base repo 有未宣告的 dirty / untracked 狀態；
- nested repository、`.gitmodules` 或已初始化 submodule；
- sparse checkout；
- Git LFS pointer 未 materialize（LFS 為獨立能力，MVP-0 不支援）；
- tracked path 在 Windows 上 case collision、結尾空白/句點、保留裝置名稱（`CON`、`NUL`…）、超長路徑；
- branch 已在其他 worktree checkout、branch 或 path 名稱衝突；
- worktree final path（解析 reparse point 後）不在指定根目錄下，或比較時未使用 case-insensitive 規則。

---

## 8. Persistence Model

- **Current-state SQLite tables**：`runs`、`tasks`、`task_attempts`、`role_assignments`、`approvals`、`verifications`、`decisions`（MVP-1）、`handoffs`（MVP-2）。
- **Append-only audit log**：`audit(seq INTEGER PK AUTOINCREMENT, at, actor, kind, ref_id, payload_json)`。用於稽核與 handoff snapshot 定位（`snapshot_audit_seq`），**不用於重建 state**。
- **Durable inbox/outbox 只在 external side-effect boundary**：AionCore conversation create、message send、confirmation confirm、cancel/restart；以及 MVP-1 起的 agent 控制訊息 inbox。
- SQLite 設定：`foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout`、短 transaction、單一 writer、狀態轉移用 `BEGIN IMMEDIATE`。
- Migration：`PRAGMA user_version` + 依序 SQL 檔；不引入 migration framework。
- 備份：每次 Run 開始前 `VACUUM INTO` 一份備份；啟動時 `PRAGMA quick_check`，失敗 → 停止並回報，不自動修復。
- Stack：Node `>=24.15`（本機 24.16，§14 E5）；直接 type stripping 只用於 P0 spike 與開發；release 前 `tsc --noEmit`（`typescript`、`@types/node` 為 dev dependency）並輸出 JS。Runtime dependency 只有 Ajv。

---

## 9. Windows Gates

每個 gate 在 P0 或指定 MVP 必須實測；source inspection 不算通過。

| ID | Gate | PASS 條件 | 階段 |
|---|---|---|---|
| W1 | AionCore 側 process tree 終止 | 對 direct exe、npm `.cmd` shim、以及「啟動後立即 spawn grandchild」的 agent，執行 cancel / runtime restart / aioncore 停止後，事前記錄的所有 descendant PID 都已結束；任何殘留 = FAIL | P0（blocker） |
| W2 | Conductor 側 verify runner process tree 終止 | 逾時 verify command（含快速 spawn 的 grandchild 與 orphan 化的 descendant）全部結束。`INFERRED`：`taskkill /T` 依 parent PID 走訪，父程序先結束的 orphan 可能遺漏；Node 沒有 Job Object API。候選做法：以 PowerShell 7 wrapper（`Add-Type` P/Invoke）先建立 `KILL_ON_JOB_CLOSE` Job Object 並把自己加入，再啟動 command，使所有 descendant 在建立時即屬於 Job。不新增 npm dependency。 | P0（blocker for MVP-0） |
| W3 | Argument transport | Unicode（中文）、空白、引號、換行、>8,191 字元與 >32,767 字元 prompt，分別經 Claude（native exe）、Codex（npm shim）、agy（argv）傳遞；內容逐字一致或明確失敗（不得靜默截斷）。截斷或 `os error 206` 的 agent → 長內容改用檔案引用 | P0 |
| W4 | 中文 + 空白路徑 | repo、worktree、data dir 位於含中文與空白的路徑時，R4/R5/R6 正常 | P0 |
| W5 | Long path | worktree 內 >260 字元路徑可建立、diff、移除（per-command `core.longpaths=true`；系統 `LongPathsEnabled=1` 已存在） | MVP-0 |
| W6 | File lock | worktree 內有 open handle 時 remove → `ERROR_SHARING_VIOLATION` → bounded retry → 保留並 `BLOCKED`；不 `--force` | MVP-0 |
| W7 | Path containment | junction / symlink 指向 worktree 外時，G2 與 approval path 判定為外部（final path + case-insensitive） | MVP-0 |
| W8 | Encoding | verify 輸出與 git porcelain 以 UTF-8 解碼並保存原始 bytes hash；中文檔名在 `-z` 輸出中正確 | MVP-0 |
| W9 | Console window | aioncore 與 agent 子程序不彈出 console 視窗（`windowsHide`；AionCore 端無 `CREATE_NO_WINDOW`，P0 記錄實際行為；非 blocker） | P0 |
| W10 | 全域設定未變 | P0 前後比對：`git config --global --list`、`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.gemini/` 下設定檔、agy 設定的 SHA-256；任何差異 = FAIL | P0（blocker） |

---

## 10. MVP Scope

### P0 Spike — runtime boundary only

見 §11、§12。需要使用者另行授權：下載 pinned AionCore release（`aioncore-v0.2.2-x86_64-pc-windows-msvc.zip`，以 `aioncore-checksums.txt` 驗證）、啟動它、使用 Claude/Codex/agy 的現有登入在 disposable repo 執行一次性 probe。Spike 腳本不屬於產品程式。

### MVP-0 — one verified task（CLI-only）

- 1 disposable repo、1 task、1 agent、1 task-attempt worktree、sequential。
- Agent 選擇：P0 中通過 R5/R6/R7/R8/W1/W3 且 caveat 最少者（建議優先 Claude Code native exe；最終由 P0 結果決定）。
- Manual approval（§4）；trusted verification（§6）；SQLite current state + audit（§8）。
- 無 control protocol、無 Leader、無 Reviewer、無 UI、無 Experiment、無 Local LLM、無自動 merge/cleanup。
- Acceptance：
  1. Task 送出；Agent 只在 worktree 內修改；
  2. G1–G5 全部執行，結果與 evidence 綁定到 tree/dirty digest；
  3. 「Agent 宣稱完成但測試失敗」「改到範圍外」「改 protected path」「deliverable 不存在」皆不得 `DONE`（各有自動化測試）；
  4. 所有 owned process 結束（W1、W2）；
  5. Conductor crash 後重啟：current state 一致，pending approval 正確轉 `ORPHANED` / `DELIVERY_UNKNOWN`，不重複送出 mutating command；
  6. W5–W8、W10 PASS。

### MVP-1 — Fixed Leader + Worker → Verification

- 1 固定 Leader（唯讀 detached worktree）+ 1 write Worker；Reviewer 只用於 high-risk task。
- Leader `Plan` → 使用者核准（含 verification command 提議）→ Conductor 派 `Task` 給 Worker → `Result` → G1–G6 → Leader `Review`（若需要）→ 使用者核准後 merge 到 integration branch。
- Worker `Question` → Leader `Decision`（`decision_revision` CAS）→ `Answer`。
- Strict envelope + Ajv（§5）；durable inbox/outbox；`task_attempt` fencing；`DELIVERY_UNKNOWN` 狀態。
- Concurrency = 1；在 deterministic recovery 測試通過後才允許 2。
- Acceptance：舊 attempt 的遲到 `Result` 被拒並記 audit；重複 `message_id` 為 idempotent；同 ID 不同 hash 被拒；協定違規 2 次後 `BLOCKED`；Leader 無法核准 approval 或修改 trusted verification。

### MVP-2 — Runtime Leader Handoff + durable saga

- Fencing：`leader_epoch` + `task_attempt` + `decision_revision`/`supersedes_id` + `handoff_id`/`phase`/`snapshot_audit_seq` + `message_id`/`command_id` + payload hash。
- Saga：`PREPARING → SWITCHED → BOOTSTRAPPING → ACTIVE | HANDOFF_BLOCKED`；assignment 更新與 outbox 寫入在同一 transaction；重啟後以同一 `command_id` 繼續。
- Epoch 永不遞減；ack 逾時 → `HANDOFF_BLOCKED`，重送同一 handoff 或另選 Leader 並再次遞增 epoch。
- Handoff 期間 Worker 訊息先進 durable inbox；新 Leader ack 後補送 `snapshot_audit_seq` 之後的事件。
- 新 Leader 一律新建 conversation；舊 Leader 改派的新 role 也新建 conversation。
- HandoffPacket 由 DB 決定論產生（ARCH-0 §6 第 3 點的內容保留），舊 Leader 的 `HandoffNote` 標記 untrusted。
- Acceptance：REVIEW §7 的 A–F 六個 race case 全部有自動化測試；每個 saga phase 都做 crash injection；reconnect cursor / gap / duplicate event 測試通過。

### MVP-3 — Product surface（依實測需要加入）

- Experiment（同任務多組合；token/cost 缺值標 `unknown`）。
- Local LLM（LM Studio OpenAI-compatible；無 tool 權限）。
- UI：authenticated localhost HTTP + SSE；之後再評估 AionUi 作 UI（前提：exclusive approval ownership 已解決）。
- 更多 Role 與一般 Task DAG。
- Gemini CLI（需通過與其他 agent 相同的 P0/MVP contract）。
- OS sandbox / scoped AionCore client（§2.4 門檻；處理敏感資料前必須完成，不受 MVP-3 排程限制）。

---

## 11. P0 Acceptance Matrix

前置條件（全部滿足才開始）：使用者授權；disposable repo（無 remote、無 secrets）；Conductor 專用 data dir；W10 基準快照已記錄；AionCore binary checksum 通過。

| ID | Probe | 方法 | PASS 條件 | Blocker | 對應 |
|---|---|---|---|---|---|
| R1 | Conductor-owned launch | spawn pinned `aioncore`（`--port 0 --data-dir … --work-dir … --parent-pid …`） | 取得 `AIONCORE_LISTENING` 與 ready signal；Conductor 結束時 aioncore 也結束 | **Y** | REVIEW P0-2 |
| R2 | Version / contract check | 查詢版本與必要 route | 可取得版本；不符時 Conductor fail closed | **Y** | REVIEW P0-2 |
| R3 | Identity mode | 分別以 `--local` 與 `--identity-mode webui` 執行 R4–R8 | local：功能 PASS；webui：記錄 PASS/FAIL（決定 §4.3 的 MVP-0 條件） | local **Y**／webui N | REVIEW P0-1 |
| R4 | Conversation CRUD | create/get/list/update/delete；確認 archive 是否存在 | 全部可用；archive 有或無皆明確記錄 | **Y** | REVIEW §4 |
| R5 | Per-conversation config | 每個 agent：workspace（worktree）、backend、model、effort、permission mode；建立後讀回 | 讀回值與設定一致；agent 實際 cwd = worktree | **Y**（至少 1 agent） | ARCH-0 §1 條件 2 |
| R6 | Stream / reconnect | send → stream → `turn.completed`；中途斷線重連；記錄重複/亂序事件；確認可辨識 final assistant message | 可得完整 final message；重連後不遺失 turn 結果（或可由 message list 補齊） | **Y** | REVIEW §14 |
| R7 | Cancel / restart / resume / crash | cancel 進行中 turn；runtime restart；kill aioncore 後重啟並 resume session；kill Conductor 後重啟 | 狀態可對帳；resume 行為明確記錄 | **Y** | REVIEW §4 |
| R8 | Approval | list/confirm；重複 confirm；第二個 client 同時 confirm；pending 時重啟 aioncore；stale list race；agy 逾時秒數 | Conductor 能回應；重複/並行回應的結果被記錄且 Conductor 不會誤記為成功；重啟後 pending 行為明確 | **Y** | REVIEW P1-1 |
| R9 | Agent-side bypass（security 量測） | 由 agent 子程序以繼承的 env 呼叫 REST（create/send/confirm）；agy 修改 `.agents/hooks.json` | 只記錄結果，**不作為 PASS/FAIL**；結果寫入 trust model | N（記錄必填） | REVIEW P0-1；§2.2 |
| R10 | Delivery reconciliation | 訊息內文含 `command_id` 後由 message list 搜尋；`extra.conductor_command_id` round-trip | 可對帳 → 採 §5.6；不可 → crash 後一律 manual | N | REVIEW P1-5 |
| R11 | Agent one-turn + protocol compliance | Claude、Codex、agy 各跑一個讀檔 + 小改動 turn；另跑 10 次「只回單一 JSON object」測試 | 每個 agent 個別判定；≥1 agent 完成 one-turn 為 blocker；JSON 合規率記錄供 MVP-1 判斷 | **Y**（≥1） | REVIEW §15 |
| R12 | Argument transport | W3 | 見 W3 | N（決定長內容策略） | REVIEW §10 |
| R13 | AionCore process tree | W1 | 見 W1 | **Y** | REVIEW P0-4 |
| R14 | Conductor verify runner tree | W2 | 見 W2 | **Y** | REVIEW §9 |
| R15 | Startup side effects | 記錄 aioncore 啟動時的網路下載、寫入 data dir 以外的檔案（含 `%APPDATA%`、workspace 內 `.agents/`）；比較 `--managed-resources-mode bundled` | 所有寫入位置與下載來源已列出；無寫入使用者全域設定 | **Y**（全域設定部分） | DECISION |
| R16 | 全域設定未變 | W10 | 見 W10 | **Y** | 全域規則 |
| R17 | Gemini（選填） | 同 R5/R6/R11 | 只記錄；不影響 GO | N | DECISION（MVP-3） |

---

## 12. GO / NO-GO Criteria for P0

### 12.1 GO（進入 MVP-0）

全部成立：

1. Blocker probe（R1、R2、R3-local、R4、R5、R6、R7、R8、R11、R13、R14、R15 全域設定部分、R16）全部 `PASS`。
2. R9 已執行並把結果寫入 trust model（不論結果）。
3. 至少 1 個 agent 同時通過 R5、R6、R7、R8、R11、W1、W3（不需長 prompt）。
4. §4.3 identity mode 條件已決定（webui PASS，或使用者明確接受 local mode 風險並記錄）。
5. 所有 `UNVERIFIED` 項目都已轉成 `PASS` / `FAIL` / `NOT_TESTED`（附理由）。

### 12.2 CONDITIONAL GO

Blocker 全部 PASS，但有非 blocker 失敗（例如 agy 長 prompt 截斷、R10 無法對帳、W9 視窗閃爍）。條件：每項失敗都有記錄的 workaround 或範圍縮減（例如 agy 不進 MVP-0；crash 後一律 manual 對帳），並寫入 V1 附錄後才開始 MVP-0。

### 12.3 NO-GO

任一成立即停止，不寫產品程式：

- R1/R2：Conductor 無法擁有並辨識 aioncore（無機器可讀 endpoint 或無法版本檢查）。
- R5：`extra.workspace` 未被實際採用（agent cwd 不是 worktree）。
- R8：Conductor 無法回應 approval，或回應結果無法判定。
- R13/R14：process tree 有殘留且無 supported workaround。
- R16/R15：任何全域設定被修改。
- R11：沒有任何 agent 完成 one-turn。

NO-GO 後的處理順序（依 DECISION 的 fork 規則）：

1. 找 supported workaround（AionCore 既有 flag、設定、API）。
2. 對上游提出 issue / 小 PR，附失敗的 acceptance test。
3. 只有前兩步都不可行，且失敗的是**具體 acceptance test**，才評估以 `AIONUI_BACKEND_BIN` 等價方式使用的最小 patch build；範圍只限該 test。
4. 若 runtime boundary 本身不成立（例如 R1/R5 無解），回到架構決策：依 REVIEW §12，AO 為唯一 fallback 候選，且只在 primary 路徑確定失敗後評估。不平行實作兩個 adapter。

---

## 13. Codex Findings Reconciliation Table

| ID | Codex finding | Verdict | 理由 / 證據 | V1 變更 | 階段 |
|---|---|---|---|---|---|
| P0-1 | AionCore local mode 不是 security boundary | **ACCEPT（附修正：問題更嚴重）** | `OBSERVED` local auth/CORS（REVIEW 引用）。本輪 `OBSERVED`：非 local mode 的 `runtime_token_channel` 驗證 token 後注入完整 `CurrentUser`，註解明說「making ordinary user-scoped handlers work unchanged」，且所有 route group 共用同一 `auth_middleware`（§14 E2）。所以 REVIEW「token limits helper routes」對非 local mode 不成立：持有 runtime token 的 agent 可通過整個 user API。切換 webui mode 不能讓 agent 與 Conductor 隔離 | §2 trust model：cooperative + disposable；不宣稱 containment；§2.4 升級門檻；§4.3 identity mode；R3、R9 | P0 / MVP-0 |
| P0-2 | 外部 endpoint discovery 與 API 穩定性未建立 | **ACCEPT** | `OBSERVED`：`cli.rs` 有 `--port 0`、`--data-dir`、`--parent-pid`、`--identity-mode`；`cmd_server.rs` 輸出 `AIONCORE_LISTENING`（§14 E1）。Conductor-owned 在 source 層可行；attach AionUi 沒有 public contract | §3 Conductor-owned AionCore；AionUi 移出執行鏈；R1、R2 | P0 |
| P0-3 | Worktree 被要求做無法做到的 security 工作 | **ACCEPT** | `OBSERVED`：本機 Git 2.54 實測 linked worktree 的 `info/exclude` 解析到 shared common dir（§14 E4）；Git 官方文件 | §7 worktree = correctness boundary；更正 ARCH-0 §7；preflight fail-closed 清單 | MVP-0 |
| P0-4 | Windows Job Object start race | **ACCEPT** | ARCH-0 §9 已標為 suspected；REVIEW 引用 `spawn.rs` 空的 Windows `configure_platform_spawn`。本輪確認該檔在 v0.2.2 與 `4a707fc` 之間未變（§14 E6）。無實測前不能排除 | W1（blocker）；另加 W2（Conductor 自己的 verify runner 同樣需要） | P0 |
| P1-1 | Approval state volatile、non-idempotent、多 writer | **ACCEPT** | `OBSERVED`（REVIEW 引用 in-memory HashMap、destructive confirm）。AionUi 移出執行鏈後，多 writer 仍存在：agent 本身可透過 REST 回應（P0-1 修正） | §4：單一 writer（policy）、CAS decision record、tombstone、`ORPHANED`/`DELIVERY_UNKNOWN`；R8 | MVP-0 |
| P1-2 | `leader_epoch` 必要但不足 | **ACCEPT（調整命名）** | 單一 epoch 無法區分同一 Leader 的 D1/D2 或 retry attempt（推理成立，無反證）。因 V1 不做 event sourcing，`snapshot_event_seq` 改為 `snapshot_audit_seq`，語意相同 | §5.5、§10 MVP-1（`task_attempt`、`decision_revision`）、MVP-2（handoff 欄位與 saga） | MVP-1 / MVP-2 |
| P1-3 | Fenced JSON extraction 不是 protocol boundary | **ACCEPT** | RFC 8259 duplicate name 行為未定義；`JSON.parse` 取最後值、Ajv 不檢查重複 key → 需要獨立 duplicate-key 檢查 | §5：完整 final message = 單一 JSON object；限制、dup-key scanner、closed schema、transport-bound sender | MVP-1 |
| P1-4 | Verification inputs 與 evidence 不夠可信 | **ACCEPT** | ARCH-0 §5.1 把 `verify_commands` 放在 task data，§5.3 在 agent 可寫的 worktree 執行 | §6 trusted sources only、protected paths、evidence binding、evidence 失效規則 | MVP-0 |
| P1-5 | Side-effect delivery 不是 exactly-once | **ACCEPT（由 UNVERIFIED 升為 OBSERVED）** | `OBSERVED`：`SendMessageRequest` 註解「`msg_id` is server-generated — clients must not provide one」（§14 E3） | §5.6：`command_id` 嵌入內文 + list 對帳；`DELIVERY_UNKNOWN`；不宣稱 exactly-once；R10 | MVP-0（crash 處理）/ MVP-1 |
| P2-1 | MVP 同時包含多個產品 | **ACCEPT** | 與 DECISION 一致 | §10 重新分階段 | — |
| P2-2 | 不需要完整 event sourcing | **ACCEPT** | 與 DECISION 一致 | §8 current state + audit + boundary inbox/outbox | — |
| P2-3 | Type stripping 與 `node:sqlite` 需明確限制 | **ACCEPT** | `OBSERVED`：本機 Node 24.16.0；`process.features.typescript = 'strip'`；`node:sqlite` 可載入且未顯示 ExperimentalWarning（§14 E5） | §8：Node ≥24.15、`tsc --noEmit`、release 輸出 JS、Ajv 為唯一 runtime dependency | MVP-0 |
| P3-1 | 「不同 reviewer」不保證獨立驗證 | **ACCEPT** | 推理成立 | §6.2 G6 只用於 high-risk；trusted evidence 優先 | MVP-1 |
| REVIEW §9.4 子項 | Verification 預設關閉網路 | **PARTIAL** | Windows 上沒有 OS sandbox 時，對單一子程序關閉網路需要防火牆規則或 AppContainer；修改防火牆屬系統設定變更，V1 與使用者全域規則禁止。目標保留，但 MVP-0 無法強制 | §6.3 第 5 點：evidence 記錄 `network: not_isolated`；OS isolation 到位後再強制 | MVP-0 記錄 / §2.4 後強制 |

REJECT：**0 項**。本輪沒有取得能推翻任何 Codex P0/P1 finding 的原始碼或官方證據。

### 13.1 ARCH-0 更正清單（errata）

| ARCH-0 位置 | 原內容 | V1 更正 |
|---|---|---|
| 表頭 | AionCore `4a707fc3d3cd` = v0.2.2 | v0.2.2 tag = `47e66d0`；`4a707fc` 多 21 commit；引用檔案未變（§3.2） |
| §1 條件 1 | 外部本機 client 可通過 AionCore 認證 | 改為 Conductor-owned AionCore（§3） |
| §2.2 / §4 | Approval 由外部程式回應 = SUPPORTED | 功能上可回應；但非唯一、非 durable、非 idempotent（§4） |
| §5 Persistence | append-only events 重建全部 state | current state + audit（§8） |
| §5.2 | Agent 回覆含一個 fenced json 區塊 | 完整 final message = 單一 JSON object（§5） |
| §5.2 | runtime token 機制日後可用於身分綁定 | runtime token 在非 local mode 可通過整個 user API，不是 scoped identity（§14 E2） |
| §5.1 / §5.3 | `verify_commands` 存於 task、在 worktree 執行 | trusted sources only + evidence binding（§6） |
| §5.3 第 5 點 | 一律需要不同 Reviewer | 只用於 high-risk（§6.2 G6） |
| §7 | `info/exclude` 是 per-worktree | 錯誤；shared common dir（§7.3） |
| §8 第 2 層 | 讀檔/編輯/allowlist shell 自動允許 | P0/MVP-0 所有 mutating approval 為 manual（§4.1） |
| §8 第 3 層 | 即使 Agent 繞過 approval 也無法讓越界變更進入 integration | 只對 integration 內容成立（G2）；不代表 containment（§2.2） |
| §11 | 單一 MVP 含 Handoff、Experiment、UI、Local LLM | 拆為 MVP-0/1/2/3（§10） |
| §13 | 零第三方 runtime 依賴 | 允許 Ajv；`typescript`/`@types/node` 為 dev dependency（§8） |

---

## 14. New Evidence Collected This Round

只查詢存在實質分歧且影響 V1 的證據。全部為唯讀查詢（`gh api` 讀 pinned source、本機 scratch 測試）；未安裝、未 clone、未啟動 AionCore。

| ID | 證據 | 標記 | 來源 | 影響 |
|---|---|---|---|---|
| E1 | `aioncore` CLI 提供 `--host`、`--port`（0 = 動態）、`--data-dir`、`--work-dir`、`--parent-pid`、`--local`、`--identity-mode {local,webui,aionpro}`（預設 webui）、`--managed-resources-mode {bundled,download}`（預設 download） | OBSERVED | [`cli.rs` L16-83 @4a707fc](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/cli.rs#L16-L83)；[`cmd_server.rs`](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/commands/cmd_server.rs#L23-L27) | §3 Conductor-owned 可行；R15 |
| E2 | 非 local mode：沒有 JWT 時 fallback 到 `runtime_token_channel`，驗證 token 與 (user, conversation) 綁定後注入完整 `CurrentUser`，「making ordinary user-scoped handlers work unchanged」；所有 route group 共用同一 `auth_middleware` | OBSERVED（agent 能否實際呼叫 confirm：UNVERIFIED，R9） | [`middleware.rs` L91-205](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-auth/src/middleware.rs#L91-L205)；[`routes.rs` L281-361](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/router/routes.rs#L281-L361) | P0-1 修正；§2.2；§4.3 |
| E3 | `SendMessageRequest`：「`msg_id` is server-generated — clients must not provide one」 | OBSERVED | [`api-types/src/conversation.rs` L177-196](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-api-types/src/conversation.rs#L177-L196) | P1-5；§5.6 |
| E4 | Linked worktree 的 `git rev-parse --git-path info/exclude` → `<main>/.git/info/exclude`；`HEAD` → `<main>/.git/worktrees/<id>/HEAD` | OBSERVED（本機 Git 2.54.0.windows.1，scratchpad 暫存 repo，測後已刪除） | 本機指令輸出 | P0-3；§7.3 |
| E5 | Node v24.16.0；`process.features.typescript = 'strip'`；`require('node:sqlite')` 成功（`DatabaseSync` 為 function），stderr 無 ExperimentalWarning | OBSERVED | 本機指令輸出 | P2-3；§8 |
| E6 | Tag `v0.2.2` → `47e66d0`；`4a707fc` ahead 21 / behind 0；12 個不同檔案中不含本文件引用的檔案；v0.2.2 release 含 Windows x64 zip 與 checksums | OBSERVED | `gh api repos/iOfficeAI/AionCore/compare/v0.2.2...4a707fc`、`releases` | §3.2 版本 pin |

另有 local mode CORS / CSRF 條件分支：[`routes.rs` L428-470](https://github.com/iOfficeAI/AionCore/blob/4a707fc3d3cd1f06a86004745e2c1bbf08b16068/crates/aionui-app/src/router/routes.rs#L428-L470)（local mode 不加 CSRF layer、CORS `allow_origin(Any)`）。

---

## 15. Open Decisions（不阻擋本文件；P0 前需使用者決定）

1. **P0 授權**：下載並執行 `aioncore-v0.2.2-x86_64-pc-windows-msvc.zip`（約數十 MB，`UNVERIFIED` 實際大小）；是否允許 `--managed-resources-mode download` 的啟動下載（若 `bundled` 不可用）。
2. **Disposable repo 位置**（建議新建空 repo，不使用 TWstock 或任何正式 repo）。
3. **P0 納入哪些 agent**：預設 Claude、Codex、agy；Gemini 選填。
4. **agy approval**：接受 workspace hook gate 與約 30 秒逾時自動 deny，或 MVP-0 只讓 agy 擔任唯讀角色。
5. **Identity mode 風險**：若 R3 webui 失敗，是否接受 local mode 進 MVP-0（§4.3）。
