# P0 Feasibility Spike Report（正式版）

- 日期：2026-10-06（時間皆為 UTC，括號內為 +08:00 本地時間）
- 唯一驗收標準：`MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md` §9（W1–W10）、§11（R1–R17）、§12（GO / NO-GO）
- 狀態只用：`PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED`。推論標 `INFERRED`，未查證標 `UNVERIFIED`。
- 本報告只根據既有 evidence 撰寫；撰寫本報告時**未**再執行任何 probe、AionCore、Agent 或 PowerShell 測試。
- Evidence：`reports/evidence/`（約 226 檔）；scripts：`spikes/`；fixtures：`fixtures/`。

---

## 0. Verdict

**NO-GO for MVP-0 under Architecture V1 current gates.**

| # | Blocker | V1 依據 |
|---|---|---|
| 1 | **W1 / R13 FAIL**：Claude tool descendants 在 cancel / runtime restart / AionCore termination 後存活；supported-workaround probe（Conductor Job 包 AionCore）仍失敗 | §12.3「R13/R14：process tree 有殘留且無 supported workaround」 |
| 2 | **R8 FAIL**：duplicate / conflicting / restart 後的 confirm 全部回 HTTP 200 `{"success":true}`，Conductor 無法從回應判定結果，會誤記為成功 | §12.3「R8：…回應結果無法判定」 |
| 3 | **W10 / R16 FAIL**：`~/.codex/config.toml` 在測試窗口內改變。Attribution：**UNKNOWN / NOT ATTRIBUTED TO P0** | §12.3「R16/R15：任何全域設定被修改」；W10「任何差異 = FAIL」 |

另外：
- **R15 FAIL**（啟動與執行時的全域 side effect，見 §2）同樣符合 §12.3 的 NO-GO 條件。
- **Backend-specific blocker / caveat — Antigravity (agy)**：AionCore 寫入 worktree 的 `.agents/hooks.json` PreToolUse hook 在每次 tool call 都執行失敗，所有 tool 被擋下（fail-closed）。在此 build 上 agy 不能做 one-turn edit，approval timeout probe 也是 BLOCKED。
- §12.1 的 GO 條件也不成立：R9 未執行（條件 2）；沒有任何 agent 同時通過 R8 與 W1（條件 3）。

---

## 1. Tested binary identity

| Item | Value |
|---|---|
| Source | https://github.com/iOfficeAI/AionCore/releases/tag/v0.2.2（asset 由 github-actions[bot] 上傳，2026-09-09） |
| Asset | `aioncore-v0.2.2-x86_64-pc-windows-msvc.zip`，36,264,906 bytes，SHA-256 `d1ed8d1da869230c18701747d07e8f068db5b8c9442e65261304aeb4c27eacf6`（與 `aioncore-checksums.txt` 及 GitHub asset digest 一致） |
| Binary | `runtime/aioncore/aioncore.exe`，SHA-256 `67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892`；`--version` = `aioncore 0.2.2`；`/health` = `{"version":"0.2.2",…}` |
| Revision | tag v0.2.2 → commit `47e66d0`。V1 source review 用的是 `4a707fc`（晚 21 commits）；本次只執行 v0.2.2 binary。 |
| Zip 內容 | 只有 `aioncore.exe`。所有 run 都用 `--managed-resources-mode bundled`；`download` 模式從未使用。 |

Environment：Windows 11、Node 24.16.0、Git 2.54.0.windows.1、pwsh 7.6、claude 2.1.290（AionCore 驗證版 2.1.236）、codex-cli 0.160.0（驗證版 0.151.0）、agy 1.2.17（驗證版 1.1.28）、gemini 0.45.0。執行測試的 shell 本身位於一個帶 `BREAKAWAY_OK` 的 Job Object 內（`w2-env.log`）。

---

## 2. R matrix（§11）

| ID | Result | Evidence / 說明 |
|---|---|---|
| R1 | **PASS** | `--port 0` 啟動；解析 `AIONCORE_LISTENING` + `AIONCORE_READY`；owner 被 `taskkill /F` 後約 1 秒 aioncore 自行結束（`r1-local-bundled.*`、`r1-ppid.*`）。 |
| R2 | **PASS** | `/health` 版本檢查；版本不符 → Conductor 停止 aioncore 且 PID 消失；binary 被竄改 → spawn 前即拒絕（`r2.log`）。`/health` 不提供 commit hash。 |
| R3-local | **PASS** | R4–R8 的 local-mode probe 皆可執行（R8 本身 FAIL 是語意問題，與 identity mode 無關）。Local mode：無 auth，CORS `*`。 |
| R3-webui | **PASS（功能）** | 未登入 401；POST 無 CSRF 403；login 取得 JWT；CRUD；Claude edit 經 manual approval（`r3-explore-webui.log`、`claude-webui-1.*`）。WS auth 需 header/cookie，query string 會被拒絕。CORS 會反射任意 Origin（含 credentials）；cookie `SameSite=Lax`（作為緩解屬 `INFERRED`）。READY 後立即 create 曾回 400（assistant catalog race）。**§4.3 MVP-0 identity mode 尚未由使用者決定**；本報告不自行核准 local mode。 |
| R4 | **PASS** | create / get / list / update（extra merge）/ delete 全部可用；兩種 mode 都沒有 archive route（404），已記錄（`r4-explore-*.log`）。 |
| R5 | **PASS**（Claude、Codex）；agy **BLOCKED** | CLI transcript 讀回：Claude `claude-sonnet-5-5`、effort low、cwd = worktree；Codex `gpt-6-luna`、effort low、`on-request`、sandbox read-only、cwd = worktree。agy：每個 tool call 都被失敗的 hook 擋下，實際 cwd / 設定無法由 tool 執行驗證（`agy-1.*`）。舊版 partial report 曾記 agy FAIL；依現有 evidence 改記 BLOCKED。Gate 要求至少 1 agent → 達成。 |
| R6 | **PASS** | `r6.log`：WS 在 14 個事件後斷線，5,040 ms 後重連。斷線期間 WS 事件 0 筆、無 replay；ws2 未收到 `turn.completed`；WS 文字缺 1,220 字元。REST message list 完整（`restComplete:true`、`restTextLen` 1491）。內容 32 行順序正確；重複事件：`acp_config_option` ×2（同 msg_id）。Turn 結果可由 message list 補齊，符合 §11 R6 判準。WS 為 broadcast，無 cursor / seq。 |
| R7 | **PASS** | Cancel → 200，turn cancelled。Runtime restart → `recovered:true`。**AionCore crash**（`r8-crash-pre/post.log`）：重啟後 conversation 可讀、runtime idle、pending 清空；follow-up turn 不使用 tool 即正確回答前一 turn 的檔案路徑（`src/add.mjs`），session context 已 resume。**Conductor crash**（`r7-conductor-crash.log`）：client 在 approval pending 時被 kill；新 client 以 `command_id` 找回 conversation、user message 與 pending approval（`recovered_by_command_id:true`）。狀態可對帳，resume 行為已記錄。 |
| R8 | **FAIL** | 見 §4。 |
| R9 | **NOT_TESTED** | Agent 子程序以繼承 env 呼叫 REST 的 probe 未執行，只有 source-level / 間接 evidence：local mode 無 auth（R3 已觀察）；agent 子程序繼承環境（Codex `shell_environment_policy.inherit=all`）。agy 修改 `.agents/hooks.json` 未測。**§12.1 條件 2 因此不成立。** |
| R10 | **PASS** | 訊息內文中的 `command_id` 可由 message list 與 `/api/messages/search` 找回；`extra.conductor_command_id` round-trip 成功。 |
| R11 | Claude **PASS**；Codex **PASS（附 security findings）**；agy **FAIL** | **One-turn edit**：Claude 經 manual approval 完成 edit，final message 為單一 JSON；Codex 完成（findings 見 §6）；agy 的 hook 失敗導致所有 tool 被擋，無 edit。**JSON compliance**（`r11-json.log`）：Claude **10/10**、Codex **10/10**、agy **10/10**（另有一次 Codex 補跑 1/1）。Gate 要求 ≥1 agent 完成 one-turn → 達成。 |
| R12 | **PASS** | = W3。 |
| R13 | **FAIL** | = W1。 |
| R14 | **PASS** | = W2。 |
| R15 | **FAIL** | (a) 啟動時對 PATH 上每個 CLI 執行 `--version`，包括無關的 `hermes`，它又執行了 `git` → `git-remote-https`（對外網路）（`r15-*.log`、`w10-startup-attr.out`）。(b) AionCore 寫入 `.agents/hooks.json` 到 agy worktree。(c) CLI 寫 transcript 到 `~/.claude/projects`、`~/.codex/sessions`。(d) Claude 啟動時**沒有** `--strict-mcp-config` → 使用者全域 MCP server（google-drive-mcp、scrapling）被啟動；Codex 載入使用者 MCP 與帳號層級 `codex_apps` connectors。(e) 全域設定檔改變見 R16。 |
| R16 | **FAIL** | = W10。 |
| R17 | **NOT_TESTED** | Gemini 為選填（使用者決定）。 |

另外未測 / 受阻的子項：
- **AionUi approval race**：**NOT_TESTED**（依授權未安裝 AionUi）。
- **Antigravity approval timeout probe**：**BLOCKED**。AionCore PreToolUse hook 在每次 tool call 都失敗（`'"…aioncore.exe"' is not recognized as an internal or external command`，`agy-1.ws.jsonl`），因此 agy 不會產生 approval，無法量測逾時秒數。

---

## 3. W matrix（§9）

| ID | Result | Evidence / 說明 |
|---|---|---|
| W1 | **FAIL** | 見 §5 與 §8。 |
| W2 | **PASS** | `spikes/job-runner.ps1` v3（CreateProcess SUSPENDED → AssignProcessToJobObject → ResumeThread，`KILL_ON_JOB_CLOSE`）：**3/3 runs 存活 0**（含 orphan 化的 leaf）；early-kill 1500 ms 3/3 存活 0。Baseline `taskkill /T`：3/3 leaf 存活（`w2.log`）。`childInJob:true`，5/5 筆記錄（`runtime/w2-*.jobdiag`）。失敗版本已保留：v1 自我 assign + .NET `Process.Start` → child 不在 Job（`w2-run1-v1-selfassign.log`）；v2 未繼承 stdout，空 diag path 會 throw（`w2-runner-v2.log`）。 |
| W3 | **PASS** | `r12.log`：payload 含中文、全形引號、`"` `'` `` ` ``、`$`、`%PATH%`、`^`、`&`、`|`、`<>`、tab、連續空白、反斜線、多行與行尾空白。Claude（native exe，以 transcript 驗證）small / 9k / 40k 逐字一致；Codex（npm shim，以 rollout 驗證）small / 9k / 40k 逐字一致；agy（argv，以 CommandLineToArgvW 規則解碼）small / 9k 逐字一致；agy 40k → **明確失敗** `os error 206`，顯示為 `UNKNOWN_UPSTREAM_ERROR`，無靜默截斷。agy 早期的 mismatch 是 probe 自身的編碼問題（CP950 輸出被當成 UTF-8 解碼），強制 UTF-8 後一致；mismatch run 仍保留在 log。長內容策略：agy 改用檔案引用。 |
| W4 | **PASS** | Repo `p0-sandbox\repo 測試 A`；worktree `p0-sandbox\wt 中文 空白\claude w4`；data dir `runtime\data\w4 中文 資料`。Create（R4）、workspace 讀回（R5）、stream 到 `turn.completed`（R6）都正常；Claude 經 approval 完成 edit（`w4-claude.*`、`w4 中文 資料.*`）。 |
| W5 | **PASS** | 完整路徑 338 字元；worktree 可 add、status、移除（per-command `core.longpaths=true`）（`w5-w8.log`）。 |
| W6 | **PASS**（結果條件） | Remove 3 次 bounded retry 都失敗 → worktree 保留；全程未用 `--force`；解除 handle 後可移除。**限制**：git 先以 "contains modified or untracked files" 拒絕，`ERROR_SHARING_VIOLATION` 路徑本身**未被觸發 → 該子項 NOT_TESTED**。W6 是 MVP-0 gate，不是 P0 blocker。 |
| W7 | **PASS** | Junction 指向 worktree 外：單純 prefix 判斷誤判為「在內」，final path 判定為「在外」；case-insensitive 判定正確；git 把 junction 視為 untracked；清理後 target 完好。 |
| W8 | **PASS** | Porcelain `-z` 中文檔名 `測試 檔案 ①.txt` 正確；verify 輸出 UTF-8 解碼並記錄 bytes hash（`verifyStdoutSha d3f51bae7dbff8e2`）。 |
| W9 | **PASS** | Claude + Codex run2：92 次取樣、151 個 descendant，`visibleWindows: []`（`w9.log`）。第一次 run 因 PowerShell hashtable key 型別錯誤導致 0 樣本，標為 INVALID（`w9.INVALID-run1.log`）。 |
| W10 | **FAIL** | 見 §7。 |

---

## 4. R8 Approval — FAIL（實際 evidence）

所有 R8 probe 都使用 Claude（`bare:2d23ff1c`，permission `default`）與 Edit approval。

| Probe | 實際請求 → 回應 | 觀察到的結果 | Decision semantics |
|---|---|---|---|
| Concurrent conflicting（`r8-dup.log`） | 同時送出 `allow` 與 `reject`，並平行 GET list | **allow → 200 `{"success":true}`；reject → 200 `{"success":true}`**；平行 list 長度 1 | **UNVERIFIED**：兩個衝突決定都回成功。之後觀察到 `git status` = `M src/add.mjs`（檔案被修改），但 API 沒有回報哪個決定生效，也無法排除其他機制。 |
| Duplicate after decision（`r8-dup.log`） | 決定後再 confirm 一次 | **200 `{"success":true}`**；之後 list 長度 0 | **UNVERIFIED**：重複 confirm 沒有被拒絕或標示為 no-op。 |
| Pending 時 runtime restart（`r8-restart.log`） | restart 200 → 對舊 call_id confirm | restart 後 list 長度 0，`pending_confirmations:0`；**舊 call 的 confirm 回 200 `{"success":true}`**，但 `git status` 為空（沒有發生 edit） | **UNVERIFIED**：回應是成功，但沒有觀察到任何效果。 |
| Pending 時 AionCore crash（`r8-crash-pre/post.log`） | 重啟後對舊 call confirm（reject） | **404 `No active agent for this conversation`**；list 長度 0 | 有明確錯誤。這個情境可判定。 |
| Stale list race | 與 concurrent probe 同時的 list | 長度 1（決定送出中仍顯示 pending） | 已記錄。 |
| 「第二個 client」 | 由同一 process 發出兩個並行 HTTP request 模擬；未使用獨立的第二個 client process | — | 已注明此限制。 |
| agy 逾時秒數 | — | — | **BLOCKED**（hook failure） |
| AionUi race | — | — | **NOT_TESTED** |

判定：V1 §11 R8 要求「重複/並行回應的結果被記錄且 Conductor 不會誤記為成功」。實測中，conflicting、duplicate 與 restart 後的 confirm 都回 200 success，其中 restart 後那一筆沒有任何效果。Conductor 只依回應**必然會誤記為成功** → **FAIL**。

其他 R8 觀察：
- REST confirmation 不含 path / description；path 只出現在 WS `acp_permission`（Claude raw_input）或之後關聯的 `fileChange` event（Codex）。
- Codex `call_id` 是每個 session 的計數器（`"0"`、`"1"`），不唯一（見 §9 incident 2）。

---

## 5. W1 / R13 — FAIL（完整記錄）

Fixture：`fixtures/tree.mjs`，產生 root → mid → leaf（mid 先結束，leaf 變成 orphan）以及 sleeper。由 agent 的 shell tool 經 manual approval 執行。存活判定以事前記錄的 PID 為準，並加上 creation-time guard。

| Agent | Action | AionCore 在外部 Job？ | 存活的 fixture | 存活的 AionCore descendants | Evidence |
|---|---|---|---|---|---|
| Claude | cancel | 否 | leaf | claude.exe、cmd、scrapling-mcp、python ×2、node ×2 等 | `w1-claude-cancel.*` |
| Claude | runtime restart | 否 | leaf | — | `w1-claude-restart.*` |
| Claude | kill AionCore | 否 | root、sleeper、leaf | pwsh.exe、node ×2、conhost | `w1-claude-kill-aioncore.run1-nojob.log` |
| Claude | kill AionCore（**workaround**） | **是**（job-runner v3，KILL_ON_JOB_CLOSE） | **root、sleeper、leaf** | **pwsh.exe 19328**、node 41860 / 19788、conhost | `w1-claude-kill-aioncore.{log,out,result.json}` |
| Codex | cancel | 否 | root、sleeper、leaf | cmd、node、codex.exe、MCP 等多個 | `w1-codex-cancel.*` |
| Codex | runtime restart | 否 | 無（0） | 0 | `w1-codex-restart.*` |
| Codex | kill AionCore | 否 | 無（0） | 0 | `w1-codex-kill-aioncore.*`（run3；run1 / run2 INVALID） |

重點事實：
1. **AionCore 本身位於外部 KILL_ON_JOB_CLOSE Job**：workaround run 的 spawn argv 是 `pwsh … spikes\job-runner.ps1 -ArgvB64 …`（`w1-claude-kill-aioncore.out`）。Kill 的對象是 wrapper，由 Job close 終止成員；存活清單中沒有 `aioncore.exe`。該 run 沒有設定 `P0_JOB_DIAG`，因此**AionCore 的 `childInJob` 沒有直接紀錄（UNVERIFIED）**。同一套 runner 程式碼在 W2 的 5/5 記錄中都是 `childInJob:true`。
2. **Claude tool shell 所在的 Job 沒有 KILL_ON_JOB_CLOSE**：在 AionCore 位於 Job 內時（`p0d-injob`，07:45:40Z 啟動；jobdiag 07:45:57Z），Claude 的 shell tool 執行 `spikes/job-diag.ps1`，回傳 `{"inJob":true,"limitFlagsHex":"0x800","KILL_ON_JOB_CLOSE":false,"BREAKAWAY_OK":true,"SILENT_BREAKAWAY_OK":false}`（`jobdiag-claude.messages.json`）。
3. **Claude tool descendants 在三種動作後都存活**：cancel、runtime restart、AionCore termination（含 workaround）。
4. **Codex**：cancel 時整棵樹存活（FAIL）；restart 與 kill-AionCore 時存活 0。Codex jobdiag 失敗，因為 read-only sandbox 對 `pwsh.exe` 回「存取被拒」（`jobdiag-codex.messages.json`），所以 Codex tool shell 的 Job 狀態**未取得**。
5. W1 判準是「任何殘留 = FAIL」，且沒有 agent 在三種動作都存活 0 → **W1 FAIL**。

`INFERRED`（未查證）：Claude 的 tool shell 位於另一個 Job，limit flags 只有 `BREAKAWAY_OK`。可能是 Claude 自建的 nested job，或是 breakaway。不論哪一種，外層 Job 的 KILL_ON_JOB_CLOSE 都沒有涵蓋這些程序。實際機制尚未查證。

---

## 6. Security findings（記錄用，不影響上表判定）

1. **Codex data egress**：Codex 透過帳號層級 cloud connector `codex_apps/remote_desktop_commander`（標記為 `read_only_hint`）讀取 worktree 檔案，**沒有經過 approval**，並在一台已登錄的遠端裝置上執行。Connector 寫入被拒後，Codex 改用原生 `fileChange` 完成 edit。
2. **Codex `default` permission = `auto`**：workspace 內 edit **不需 approval**。只有 `read-only` 才是 manual-first。
3. **Claude 以 `--allow-dangerously-skip-permissions` 啟動**：mode 之後可被切換成 bypass。
4. **REST approval payload 不含 resource identity**：V1 的「自動允許讀取」無法只靠 REST 實作。
5. **AionCore 不約束 agent tool subprocess tree**（W1）。
6. **agy hook gate 在此 build + agy 1.2.17 上失效**（fail-closed）。
7. **Codex 載入真實 `~/.codex`**（使用者 MCP、帳號 connectors）。之後的 run 必須在 child env 中使用隔離的 `CODEX_HOME`（見 §11 C）。

---

## 7. W10 / R16 — FAIL（Attribution：UNKNOWN / NOT ATTRIBUTED TO P0）

Snapshot：`spikes/snapshot-global.mjs`。只記錄 hash，不讀取或記錄任何值。

| Snapshot | 時間（UTC） | `.codex/config.toml` | `reg HKCU\Environment`（整鍵） |
|---|---|---|---|
| W10-before | 05:42:09 | `72ec84ce…` | `1da1813c…` |
| W10-after | 06:23:09 | `22c66c90…` ← 改變 | `1da1813c…` |
| W10-before-2 | 06:32:52 | `22c66c90…` | `1da1813c…` |
| W10-final | 07:36:27 | `1a8a04fb…` ← 改變 | `bb9dfa02…` ← 改變 |
| W10-attr-before | 07:37:47 | `1a8a04fb…` | `bb9dfa02…` |
| W10-attr-after | 07:39:04 | `e4748beb…` ← 改變 | `bb9dfa02…` |

其他項目在所有 snapshot 中都**沒有變化**：`.claude/settings.json`、`.codex/AGENTS.md`、`.gemini/*`、`.gemini/antigravity-cli/settings.json`、`.gitconfig`、`.claude.json#mcpServers`、`git config --global/--system`、`HKLM\…\Session Manager\Environment`、claude 版本 hash。W5–W8 另外確認 `gitGlobalConfigUnchanged:true`。

Attribution（`w10-attribution.log`）：
- 以 key 名稱 + 逐行 hash 比對的隔離重現（07:41–07:43Z）：
  - Codex read-only turn 執行 sandboxed command → identical；
  - Codex conversation + runtime/restart → identical；
  - Codex turn + runtime/restart（含 turn 期間與 restart 期間的 mtime 檢查）→ identical，`changedDuringTurn:false`，`changedDuringRestart:false`。
- **隔離重現都沒有重現這個改變。**
- 07:37:47–07:39:04Z 的窗口內 hash 也有改變，但 evidence 中沒有記錄任何 P0 的 AionCore / Agent 操作。不過「當時沒有任何 P0 程序在執行」本身是 **UNVERIFIED**。
- 限制：key / 逐行 hash 比對忽略註解與空行，因此只改註解、空行或行尾的變化無法被這個方法看到。
- 結論：**UNKNOWN / NOT ATTRIBUTED TO P0**。依 W10「任何差異 = FAIL」，判定仍為 **FAIL**。

**HKCU\Environment 寫入事件**：
- 整鍵 hash 在 06:32:52Z 到 07:36:27Z 之間改變。`w10-registry-lastwrite.log`：`LastWriteTime 2026-10-06 15:22:07.708`（+08:00，= 07:22:07Z）。
- Per-value hash 從 07:37 起才開始記錄；07:37–07:39 之間 `registry values changed: 0`。
- 改變發生在哪個 value，以及原因：**UNKNOWN**。不歸因給任何 Agent 或程序。
- 本次 spike 未讀取任何 value 內容。

---

## 8. Supported Workaround Investigation（W1）

依 V1 §12.3 NO-GO 處理順序第 1 步：先找 supported workaround，不 patch AionCore。

| 嘗試 | 內容 | 結果 |
|---|---|---|
| 1. Conductor 擁有的 KILL_ON_JOB_CLOSE Job 包住 AionCore | `P0_AION_IN_JOB=1` → `spikes/lib.mjs` 經 `job-runner.ps1` v3（SUSPENDED → Assign → Resume）啟動 aioncore；kill wrapper = 關閉 Job | AionCore 被終止；**Claude tool tree（pwsh 19328 → node root / sleeper → leaf）存活** → FAIL |
| 2. childInJob | W2 中同一 runner 5/5 `childInJob:true`（`runtime/w2-*.jobdiag`） | AionCore run 未設定 `P0_JOB_DIAG` → AionCore 本身的 `childInJob` **未直接紀錄（UNVERIFIED）**；它隨 Job close 結束與「在 Job 內」一致（`INFERRED`） |
| 3. Claude tool Job diagnostics | 在 AionCore-in-Job 的 server（`p0d-injob`）上，由 Claude shell tool 執行 `job-diag.ps1` | `inJob:true`、`limitFlags 0x800`、**`KILL_ON_JOB_CLOSE:false`**、`BREAKAWAY_OK:true` |
| 4. Codex tool Job diagnostics | 同上，Codex read-only | 執行被 sandbox 拒絕（`pwsh.exe` 存取被拒）→ 未取得 |

為何仍不能解決 W1：
- Claude 的 tool shell 位於一個**沒有 KILL_ON_JOB_CLOSE 的 Job**，而且該 Job 允許 breakaway。關閉 Conductor 的外層 Job 之後，這些程序實測仍存活。外層 Job 是否實際涵蓋它們，或它們是否已 breakaway，機制 UNVERIFIED。
- Cancel 與 runtime restart 不會關閉任何 Job，所以即使外層 Job 有效，也只涵蓋「AionCore 終止」這一種情境，無法涵蓋 W1 要求的 cancel / restart。
- AionCore v0.2.2 沒有 flag、設定或 API 可以要求在 cancel / restart 時終止 tool subprocess tree。這是根據本次使用的 CLI 參數與 REST route 得出；完整 flag 清單未逐一查證。
- 結論：**目前沒有已觀察到有效的 supported workaround** → 符合 §12.3「R13：process tree 有殘留且無 supported workaround」。

---

## 9. Incidents

### Incident 1 — PID reuse 誤殺（`reports/evidence/INCIDENT-w1-pid-reuse.md`）
- 約 14:16（+08:00），W1 cleanup 對 4 個被誤判為 AionCore descendant 的 PID 執行 `taskkill /F`：另一個專案前端的一組 Vite dev server（pnpm / vite / node / esbuild）。
- 原因：只依 ParentProcessId 走訪，PID reuse 造成誤判（`INFERRED`）。
- 損害：該 dev server 實例停止。沒有任何 repo 檔案被讀取、修改或刪除；未自行重啟。
- 修正：
  - descendant 必須符合 creation time ≥ parent；
  - cleanup 只 kill fixture 自行回報的 PID；
  - kill 前重新檢查 command line 是否包含 `tree.mjs`。

### Incident 2 — **P0 safety incident：stale approval 被自動套用**
- 發生於 `w1-codex-kill-aioncore` run2（07:12Z，conversation `c85e4197`），log 保留為 `w1-codex-kill-aioncore.INVALID-run2-stale-decisions.log`。
- **Codex 重用 approval ID**：每個 session 的 `call_id` 都從 `"0"`、`"1"` 開始。
- 當時 approval key 是 `${runTag}__${call_id}`，沒有 conversation ID。前一次 run 留下的 decision file `w1-codex-kill-aioncore__0`、`__1` **誤匹配新 conversation 的 request**。
- 兩個 `CommandExecution` approval 因此**在未經人工審查的情況下被自動 allow**（`approval_decided … status 200`）。
- 被套用的是**相同的測試 command**：同一 run 的 AionCore stdout log（`w1-codex-kill-aioncore.stdout.log`，07:12:0x–1xZ）顯示執行的是 `fixtures\tree.mjs root …`。REST confirmation 本身不含 command 內容。
- 影響：違反 manual-first approval 原則；該 run 判定 INVALID，不計入 W1。
- 修正：
  - approval key 改為 `${runTag}__${convId}__${call_id}`（`spikes/turn.mjs`、`spikes/w1-tree.mjs`）；
  - 修正後的 run3 才計入結果。
- `runtime/approvals/` 仍有約 20 個舊 record，未刪除。
- 教訓（供 MVP 設計）：Conductor 的 approval identity 不能只用 agent 提供的 `call_id`，必須至少包含 conversation + turn。

---

## 10. GO / NO-GO 對照（§12）

| §12.1 GO 條件 | 狀態 |
|---|---|
| 1. Blocker probe 全 PASS | ✗：R8、R13、R15、R16 FAIL |
| 2. R9 已執行並寫入 trust model | ✗：R9 NOT_TESTED |
| 3. ≥1 agent 同時通過 R5 / R6 / R7 / R8 / R11 / W1 / W3 | ✗：沒有 agent 通過 R8 與 W1 |
| 4. §4.3 identity mode 已決定 | ✗：webui 功能 PASS，但尚待使用者決定 |
| 5. 所有 UNVERIFIED 都已轉為四種狀態 | ✗：R8 decision semantics、AionCore `childInJob`、W10 attribution、HKCU 寫入原因仍為 UNVERIFIED / UNKNOWN |

→ 不符合 GO，也不符合 CONDITIONAL GO（blocker 未全部 PASS）。**NO-GO**。

---

## 11. 下一步候選（**未執行**，需使用者決定）

- **A. W1 upstream / minimal-patch investigation**：
  - 查 AionCore `47e66d0` 中 cancel / restart / shutdown 的 child-process 處理，以及 Claude tool shell 的 Job 來源（Claude 自建或 breakaway）；
  - 依 §12.3 第 2 步，先準備給上游的 issue，附上 W1 acceptance test；
  - 只有上游不可行時，才評估 §12.3 第 3 步的最小 patch build。
- **B. R8 semantic investigation**：在 source 中確認 confirm handler 對 duplicate / conflicting / 已失效 call_id 的實際行為，以及是否存在可判定的結果欄位或 event（例如 `confirmation.remove` 的內容）。之後再設計 Conductor 端的 result reconciliation。
- **C. Isolated `CODEX_HOME` W10 retest**：
  - `serve.mjs` / `startAioncore` 以 child env 傳入 `CODEX_HOME=E:\CodexProject\multi-agent-platform\runtime\codex-home`，不改 user / system env；
  - 重新取 W10 baseline，並加上逐行（含註解）的 hash 比對；
  - 隔離 home 沒有 Codex 登入，在其中登入前需先取得使用者同意。
- **D. Antigravity hook investigation**：查 AionCore 寫入的 `.agents/hooks.json` command 格式（疑似引號 / 路徑處理）與 agy 1.2.17 之間的不相容；完成後補測 agy R5 / R11 one-turn 與 approval timeout。

---

## 12. 新增檔案與下載

- **下載**（官方 release，checksum 已驗證）：`runtime/download/aioncore-v0.2.2-x86_64-pc-windows-msvc.zip`、`aioncore-checksums.txt`；解壓出 `runtime/aioncore/aioncore.exe`。
- **新增目錄**（全部位於 `E:\CodexProject\multi-agent-platform\`）：
  - `runtime/`：data / work dirs、approvals、pid / jobdiag / state files；
  - `spikes/`：probe scripts；
  - `fixtures/`：`tree.mjs` 與 prompts；
  - `reports/evidence/`：約 226 檔；
  - `p0-sandbox/`：`repo 測試 A`（base `e9c61dc`，無 remote）、約 24 個 worktree、`wt 中文 空白\`、`w3/`、`w11/`、`outside-target/`。
- **已刪除**（本次自建）：`fixtures/bypass-probe.mjs`、`spikes/r9-bypass.mjs`、webui 的 `auth.json` / `secret.json`。
- **未做**：
  - 未安裝 AionUi，未 fork 或 patch AionCore；
  - 未修改 PATH / Registry / Git global / MCP / Agent 全域設定，未升降級任何 CLI；
  - 未修改其他專案的 repo；
  - 未 commit、push、PR 或 deploy，未開始 MVP-0。
- **目前狀態**：AionCore 已全部停止，無殘留 spike 程序，無 endpoint file。
