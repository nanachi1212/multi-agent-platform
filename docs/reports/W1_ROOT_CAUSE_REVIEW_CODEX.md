# W1 Root-Cause & Supported-Workaround Review — Codex

日期：2026-10-06。範圍只有 W1；沒有實作修正、patch AionCore、修改 Agent 設定、執行完整 P0 或進行 Git 寫入。

**Recommendation：`UPSTREAM FIX REQUIRED`，針對保留原始 cancel 語意的嚴格 W1。**

**TESTED**：已找到並驗證 Windows 原生 containment workaround 的一部分：`PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY = PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE`。同一個 packaged PowerShell 在此 policy 下不再讓 fixture descendants 離開外層 Job。但原始 Claude interrupt 仍留下 orphan leaf；官方 shell-launcher flag 也不能單獨修復 cancel。

**INFERENCE**：目前不能宣告完整 `SUPPORTED WORKAROUND` 或 W1 PASS。以既有 runtime-restart API 取代 cancel 的組合方案保留為 **UNVERIFIED** 候選，尚不能斷言所有 supported workaround 都不存在。若該組合通過第 9 節的完整窄驗收，應優先改採 supported workaround。

## 判讀規則與基準

| 標記 | 意義 |
|---|---|
| OBSERVED | 直接讀到的 pinned source、既有原始 evidence 或官方文件；不等同本輪 runtime 實測 |
| TESTED | 本輪隔離診斷，具體 argv、Job membership、結果與清理記錄已保存 |
| INFERENCE | 根據 source／實測推導；列出適用邊界 |
| UNVERIFIED | 未取得相應 run 的直接證據，或尚未實測完整組合 |

- **OBSERVED**：完整閱讀 [Architecture V1][v1]、[P0 Spike Report][p0]；W1 要求 direct exe、npm `.cmd`、立即 spawn grandchild 的 agent，在 cancel / runtime restart / AionCore 停止後，事前記錄的 descendant PID 全部結束；任何殘留 = FAIL。沒有把「turn 已 idle」當作 process tree 清理成功。
- **OBSERVED**：AionCore tag `v0.2.2` 指向 `47e66d0d151123e973b3fd1e77afcb5671b3f8c5`；本輪 source review 全部固定此 commit，不使用 V1 曾參考的較新 `4a707fc`。
- **OBSERVED**：現有 binary SHA-256 重新核對為 `67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892`。Claude 本機版本 `2.1.290`，既有 AionCore transcript 說明其驗證版為 `2.1.236`；不能假設跨版本行為一致。
- **OBSERVED**：專案目錄不是 Git repository，沒有可用的 branch / local-remote / Git diff；沒有替它初始化 Git。原有輸入 hash 保存在 [review-input-sha256.json][inputhash]，下載的 pinned source hash 保存在 [pinned-source-sha256.json][sourcehash]。
- **TESTED**：本輪只啟動直接 Claude 與 Windows shell fixture；沒有啟動新的 AionCore server。既有 AionCore evidence 與本輪直接 Claude diagnostics 分開判讀。

## 1. Exact process/job topology

### 1.1 歷史 workaround run：只能精確還原 process edges，不能補造 Job membership

**OBSERVED**：[before snapshot][oldbefore]、[result][oldresult]、`w1-claude-kill-aioncore.out` 顯示：

```text
Node probe / Conductor 21844
└─ job-runner wrapper 31152                 owns intended outer Job
   └─ AionCore 14944
      └─ Claude 34608
         └─ tool launcher cmd 7612
            └─ packaged pwsh 19328
               └─ node root 41860
                  ├─ node sleeper 19788
                  └─ node mid 30104        exits by fixture design
                     └─ node leaf 23320    survives parent exit
```

另有 Claude MCP descendants 與 conhost；它們記錄在原 snapshot，沒有把它們誤認為 tool shell 的 root/mid/leaf。上圖省略側枝，只表示本案的關鍵 edges。

| 層／程序 | 是否在 Job | limit flags／breakaway | 誰建立／持有 Job | 證據等級 |
|---|---|---|---|---|
| Conductor 21844、wrapper 31152 | 該 run 的 ambient／outer membership 沒有直接記錄；wrapper source 沒有把自己 assign 到新 Job | 新建 outer Job 設 `0x2000`，兩種 breakaway limit 均 off | wrapper 建立並持有 non-inheritable Job handle | OBSERVED source；run membership UNVERIFIED |
| AionCore 14944 | **該 workaround run 的 `childInJob` = UNVERIFIED** | intended outer `0x2000`；實際 chain 未記錄 | wrapper intended owner | OBSERVED argv/source；不是 membership 證明 |
| Claude 34608 | 該 run 沒有 specific-Job query | Aion source 會另建 per-ManagedProcess Job `0x2000`；是否在此 run 成功及何時 assign 未記錄 | Aion `ManagedProcess` source owner | OBSERVED source；runtime chain UNVERIFIED |
| launcher cmd 7612 | 未記錄 | 未記錄 | 未記錄 | UNVERIFIED |
| packaged pwsh 19328 | 未記錄 specific outer membership | **不能把另一個 run 的 `0x800` 填在這裡** | immediate Job creator 未記錄 | OBSERVED process/path；Job UNVERIFIED |
| root / sleeper / leaf | 關閉 wrapper 後仍存活 | 不能從存活反推是哪個 Job／哪個 syscall | 未記錄 | OBSERVED historical survivors；Job UNVERIFIED |

**OBSERVED**：19328 的 executable 位於 `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`。wrapper 被 kill 後約 6.856 秒，19328、41860、19788、23320 與 conhost 31992 仍在存活清單。[原始結果][oldresult]

**OBSERVED**：另一個 `p0d-injob` run 在 07:45:40Z 啟動；conversation `3e670d42` 的 jobdiag 在 07:45:57Z 之後回報 probe PID 28436：`inJob:true`、immediate flags `0x800`、kill-on-close off、breakaway on、silent-breakaway off。[jobdiag transcript][oldjobdiag]

**UNVERIFIED**：28436 是該 tool 執行的診斷程序，不是上述 kill run 的 19328；沒有同一個 outer Job handle 的 membership query。先前口頭 `childInJob:true`、W2 的另一組紀錄、以及「AionCore 不在 survivors」都不能替代此 run 的證據。

**OBSERVED**：`w2-env.log` 也記錄一般 host shell 21108 及 Node 啟動的 shell 9064 都看到 immediate `0x800`。因此 `0x800` 不足以證明是 Claude 建立 Job。

### 1.2 Pinned AionCore 的實際 Windows source path

**OBSERVED**：內建 Claude 走 `DirectCli`，不是 `CliAgentProcess::spawn_for_sdk`。路徑為：

```text
factory/acp.rs: backend == claude → build_session_instance
  → ClaudeConn / ClaudeAdapter::start_turn
  → RealSpawner::spawn
  → ManagedProcess::spawn
  → runtime::spawn::Builder::spawn → tokio Child
  → JobObject::assign_and_resume(child handle, pid)
```

來源：[factory/acp.rs L41–45、106–140][factory]、[ClaudeAdapter L1051–1152][adapter]、[RealSpawner L52–127][spawner]、[ManagedProcess L164–215][process]。

**OBSERVED**：`ManagedProcess` 已有 Windows `JobObject`；不是「AionCore 完全沒有 Job」。`assign_and_resume` 建立 unnamed Job，設 **只有 `KILL_ON_JOB_CLOSE` (`0x2000`)**，呼叫 `AssignProcessToJobObject`，再透過 ToolHelp 尋找 child threads 並 resume。Aion 持有 handle；Drop 關閉它。[process.rs L539–601][process]

**OBSERVED**：同一 pinned source 的 non-Unix `configure_platform_spawn` 是空函式，`Builder::spawn` 正常 spawn；`ManagedProcess` 的註解宣稱 child 已 `CREATE_SUSPENDED`，但此呼叫鏈沒有設定該 flag。註解不是執行證據。[spawn.rs L97–105、212–215、296–297][spawn]

**INFERENCE**：這是 assign-before-first-instruction 保證的缺口；agent 能在 assign 前建立 child。**UNVERIFIED**：此 race 是否實際造成歷史 workaround run 殘留，尚無 timing／syscall evidence。

### 1.3 本輪能直接證明的 topology

**TESTED**：每次 wrapper 都先建立唯一 named Job `0x2000`，`CREATE_SUSPENDED → assign → record childInJob → resume`。probe 用 `IsProcessInJob(process, namedJobHandle)` 查指定 Job，也另查 any-Job；查詢 handle 在 wrapper kill 前關閉。

| 本輪 run | 精確主鏈／fixture PID | specific outer membership | shell immediate flags |
|---|---|---|---|
| native System32 Windows PowerShell | wrapper 39480 → shell 19604 → root 34500 → mid 31152 → leaf 31712；sleeper 10360 | shell、root、mid、sleeper、leaf 全 true | `0x2000` |
| native unpackaged pwsh | wrapper 22308 → shell 22336 → root 26432 → mid 40848 → leaf 41504；sleeper 40612 | 全 true | `0x2000` |
| native packaged pwsh | wrapper 24172 → shell 24844 → root 40200 → mid 17088 → leaf 21908；sleeper 23588 | shell true；所有 fixture descendants false | `0x2000` |
| 同一 packaged pwsh + desktop policy `2` | wrapper 33868 → shell 42796 → root 23856 → mid 8952 → leaf 30588；sleeper 7528 | 全 true | `0x2000` |
| Claude default launcher | wrapper 27860 → Claude 7380 → cmd 40056 → shell 11592 → root 37608 → mid 38796 → leaf 29584；sleeper 7932 | snapshot 中存活的 Claude、cmd、shell、root、sleeper、leaf 全 true | `0x2000` |
| Claude disable launcher | wrapper 36372 → Claude 25748 → shell 17552 → root 28328 → mid 15120 → leaf 39508；sleeper 24628 | snapshot 中存活的 Claude、shell、root、sleeper、leaf 全 true | `0x3C00` |

**TESTED**：Claude 中 mid 已退出，所以其 PID 來自 fixture 記錄，不把它的 Job membership 當成已查到。default 的 cmd 層存在；disabled 模式沒有該 cmd 層。direct-Claude probe 未保存 shell executable 完整路徑；僅由 inherited PATH 推定為 native pwsh 是 **INFERENCE**，不當作 historical packaged shell 的同條件重測。

**UNVERIFIED**：disabled run 的 immediate `0x3C00` Job 是 Claude、shell 或其 runtime 哪一層建立，沒有 syscall trace；不能因 flags 不同就指定 creator。`0x3C00` 包含 kill-on-close、silent-breakaway、breakaway 與 die-on-unhandled-exception；它仍與 restrictive outer Job 同時存在。

## 2. Root cause

### 2.1 Cancel 的確定原因：interrupt 不等於 subtree teardown

**OBSERVED**：`ClaudeConn::dispatch(Command::Cancel)` 對 Turn / Session 呼叫 `interrupt_turn()`，只送 stream-json `control_request { subtype: "interrupt" }`；它刻意保留 persistent Claude process。`SessionAgent::cancel` 路由到此分支。[claude_conn.rs L1350–1372、3191–3219][connection]、[session_agent.rs L1395–1403][session]

**TESTED**：本輪直接 Claude 使用同一 interrupt request。default 與官方 disable-launcher 模式，在 interrupt 後 2 秒分別留下 **leaf 29584 / 39508**，Claude leader 也仍活著。兩個 leaf 都已證明仍屬 outer Job；不需要 escape 就能重現 cancel 殘留。[兩份 Claude result][claudedefault]、[disabled result][claudedisabled]

**INFERENCE**：對嚴格 W1，現有 cancel contract 沒有保證 terminate 所有 descendants。即使 containment 完全正確，若 cancel 只 interrupt 而不終止 session Job，仍會 FAIL。沒有把 persistent leader 的存活當成唯一失敗理由；實際 orphan tool leaf 也存活。

### 2.2 Escape 的可重現原因：packaged desktop-app launch policy 是獨立變因

**TESTED**：不用 AionCore 或 Claude，直接把上述 packaged pwsh **確認 assign** 到無 breakaway flags 的 `0x2000` Job。shell 自身在 Job，但它建立的 Node descendants 全不在該 Job；close 後 root 40200、sleeper 23588、leaf 21908 存活。相同 fixture 經 System32 / unpackaged pwsh 全部保持 membership，close 後為零。[native results][packaged]、[systemresult]、[unpackaged]

**TESTED**：保持 packaged executable、fixture 與 Job flags 不變，只在建立 shell 時加 desktop-app policy `DISABLE_PROCESS_TREE` (`2`)；shell 及全部 descendants 均 specific-Job true，close 後為零。[policy result][policyresult]

**OBSERVED**：Microsoft 將 desktop-app policy 與 Job limit flags 分開定義；policy `1` 是 desktop environment 的 child breakaway 預設，`2` 讓 children 留在環境並可向 descendants 繼承，後續明確 `ENABLE_PROCESS_TREE` 可覆寫。此 API 適用 Desktop Bridge packaged Win32。[UpdateProcThreadAttribute][desktopdocs]

**INFERENCE**：本輪可把 packaged fixture 的 membership escape 收斂到可由此原生 policy 控制的行為，不需假設 Claude 設了 `CREATE_BREAKAWAY_FROM_JOB`。packaged／unpackaged 比較含 executable 版本差異；同一 packaged exe 的 policy-only intervention 則消除了該項混淆。

**UNVERIFIED**：歷史 kill run 的 pwsh 本身也存活，而本輪 native baseline 是 shell 被殺、其 children 存活；兩者不是完全相同 topology。歷史 escape 發生在 AionCore→Claude、Claude→cmd、cmd→packaged pwsh 或後續 child 邊界，仍缺 specific membership／launch attribute trace，不能指定唯一逃逸 edge 或聲稱歷史根因已完整證實。

### 2.3 AionCore 的其他具體缺口

1. **OBSERVED source / INFERENCE risk**：缺 `CREATE_SUSPENDED`，Job assign 在 child 已可執行後發生。這是 start race；沒有證明它是本次歷史失敗唯一原因。
2. **OBSERVED source**：`ManagedProcess::kill` 若 leader 在 grace 內退出，會在 Windows `TerminateJobObject` 之前返回；leader exit 不代表 Job members 已退出。[process.rs L393–454][process]
3. **OBSERVED source / 限制**：`ManagedProcess::Drop` 的 Job field 仍會 close，可能補做清理；所以前項不能直接解釋每次 runtime-restart 殘留。若 descendant 已 escape，Drop 也救不到。
4. **OBSERVED source**：Windows `proc_tree::parent_table()` 返回空 table；Unix escaped-descendant sweep 不是 Windows fallback。[proc_tree.rs L74–77、165–170][proctree]
5. **OBSERVED source**：Job terminate 的 Win32 回傳值未檢查；resume-thread path 可能忽略無法開啟的 thread。**UNVERIFIED runtime**：沒有證據顯示這些 error 本輪實際發生。

## 3. Evidence 與實驗邊界

### 3.1 既有資料

| 證據 | 本次可支持的結論 |
|---|---|
| `w1-claude-cancel.{log,result.json}` | OBSERVED：約 7.325 秒後 leaf 23700 存活 |
| `w1-claude-restart.{log,result.json}` | OBSERVED：約 8.096 秒後 leaf 19276 存活 |
| `w1-claude-kill-aioncore.{out,before.json,result.json}` | OBSERVED：wrapper kill 後 packaged shell / root / sleeper / leaf 存活；Aion childInJob UNVERIFIED |
| `jobdiag-claude.messages.json`、`p0d-injob.*` | OBSERVED：**另一個 run** 的診斷程序 immediate flags `0x800`；沒有 named outer membership |
| `w2-env.log` | OBSERVED：非 Claude 專屬 host/probe 也可看到 `0x800`，Job creator 未辨識 |
| `spikes/job-runner.ps1`、`job-diag.ps1`、`w1-tree.mjs`、`fixtures/tree.mjs` | OBSERVED：測試設計與查詢範圍；source 不替代 run 證據 |

**OBSERVED 限制**：舊 `w1-tree.mjs` 的 creation-time guard 用於 parent-chain traversal；最終 survivors 只比 PID，未保存並比對同一 PID 的 creation time。fixture 自述 PID、commandline 與連續時間記錄仍是有用 evidence，但不能宣稱這是完整 identity-safe post-action 驗證。舊 run 沒有 CreateProcess flags trace。

### 3.2 本輪最小診斷結果

| 診斷 | interrupt 後 | outer Job close 後 | 結論 |
|---|---|---|---|
| System32 Windows PowerShell + finite tree | 未測 | survivors `[]` | TESTED：native baseline PASS |
| unpackaged pwsh + finite tree | 未測 | survivors `[]` | TESTED：native baseline PASS |
| packaged pwsh + finite tree | 未測 | `40200,23588,21908` | TESTED：containment FAIL；清理後 0 |
| 同一 packaged pwsh + desktop policy `2` | 未測 | survivors `[]` | TESTED：此 containment case PASS |
| Claude default launcher | leaf `29584` | survivors `[]` | TESTED：interrupt cleanup FAIL；outer close PASS |
| Claude disable launcher | leaf `39508` | survivors `[]` | TESTED：interrupt cleanup FAIL；outer close PASS |

**TESTED**：fixture root/sleeper/leaf 最長 30 秒；mid 約 300ms 後退出並使 leaf orphan。結果在 fixture 自然到期前取得。native cases 使用 retained process handles；Claude corrected runs 以 PID + 字串 FILETIME identity 比對，避免 JavaScript Number 精度丟失。所有 Job query handles 在 close action 前關閉。

**TESTED**：Claude probes 使用 `--strict-mcp-config '{}' --setting-sources '' --no-session-persistence --tools PowerShell`；只批准 exact fixture command，其他 tool request 拒絕；保留既有登入，沒有登入新帳號。環境值只寫入 child `ProcessStartInfo.Environment` / Node spawn env，不改 process-wide、user 或 machine environment。

**OBSERVED**：第一次 default-Claude harness 因 cleanup exit code 與 FILETIME Number 序列化問題被標為 INVALID；不採其結果。失敗註記與原始輸出保留；修正後的 `run2` 才是上表 evidence。[INVALID note][invalid]

**TESTED**：每個 native case 開始前檢查 fixture 為零，結束後亦為零；兩個有效 Claude run 的 `afterCleanup:[]`。最終 process audit 另保存為 [final-process-audit.json][audit]。清理只終止本輪記錄且確認 identity 的 owned process／handle，沒有依 process name 大範圍 kill。

**UNVERIFIED / NOT_TESTED**：本輪沒有重新跑 pinned AionCore API cancel/restart/kill acceptance、沒有 Codex／Antigravity runtime regression、沒有 syscall debugger／ETW trace；這些不冒充 PASS。診斷腳本與 raw results 都在 [review evidence directory][evidence]，重跑須先複製 scripts 到新的空 TEMP 目錄，避免覆寫或追加既有 evidence。

## 4. Why outer Conductor Job failed

**OBSERVED**：`QueryInformationJobObject(NULL, ...)` 查的是 current process 的 **immediate Job**，不是完整 ancestor chain；`IsProcessInJob(process,NULL)` 也只回答是否在任何 Job。[QueryInformationJobObject][querydocs]

**OBSERVED**：Windows 11 支援 nested Jobs；普通 child 會繼承 Job chain，breakaway 受 ancestor 限制；outer terminate／kill-on-close 可作用到 child Jobs。[Nested Jobs][nesteddocs]

因此：

1. **INFERENCE**：P0 舊敘述「另一個 Job／inner 沒有 kill-on-close，所以 outer 無法涵蓋」不能作為充分原因。本輪 inner `0x3C00` 且 specific outer true、outer close 零殘留是直接反例。
2. **UNVERIFIED**：歷史 outer run 首先缺少 AionCore 14944 的 `childInJob`；不能排除最初 containment 未建立。即使相同 runner 在 W2 正確，也不能補此缺口。
3. **TESTED**：確認 root child membership 的 native packaged case 仍能在下一個 spawn 邊界失去 descendant membership；outer Job 只殺 Job members，不是沿 PPID 任意追殺全部後代。desktop policy `2` 修復該 case。
4. **OBSERVED source / INFERENCE**：cancel 既不 close Conductor Job，也不 terminate per-session Job；外層設 kill-on-close 沒有被觸發，故 containment 正確也不等於 cancel 正確。
5. **UNVERIFIED**：歷史 run 的完整 Job hierarchy、Job creator、明確 `CREATE_BREAKAWAY_FROM_JOB` 呼叫者與 packaged activation attributes 未落盤。沒有據此判定 Claude 惡意 escape，亦不宣稱 Aion 設了 breakaway flag。

## 5. A — Supported workaround candidates（優先）

| 候選 | 支持／結果 | 能否直接關閉 W1 |
|---|---|---|
| A1：AionCore 既有 flags／permission mode | OBSERVED pinned root CLI 沒有 Windows containment／kill-all-on-cancel flag；`--parent-pid` 是 owner liveness，bundled-resource mode 不是 subtree policy。permission 只管 tool admission | 不能據此宣告 PASS |
| A2：`CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER=1` | OBSERVED 官方變數，自 2.1.269 起；本機 2.1.290 可用。TESTED：去掉 cmd 層，但仍 orphan leaf | 單獨 FAIL；對 Aion 驗證版 2.1.236 不保證可用 |
| A3：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF=1`／`CLAUDE_DISABLE_ADOPT` | OBSERVED 官方功能分別控制 Claude background tool／session handoff。UNVERIFIED 本輪未逐一 runtime 測。不能禁止 foreground 命令自身建立 detached children | 不足以 source-level 保證任意 W1 fixture 清理 |
| A4：Conductor 原生 launcher + policy `2` + 每次 stop/cancel 關閉 owned Job | TESTED policy `2` 解決 packaged native fixture；TESTED direct Claude outer close 全清。UNVERIFIED policy 在 Conductor→Aion→Claude→packaged tool 的完整鏈及重新覆寫情況 | **最值得窄驗收的 supported containment 組合**；若 cancel 要 stop 整個 Aion，會影響其他 conversations，須評估 contract |
| A5：policy／native shell containment + 既有 `/runtime/restart` 作為 cancel cleanup | OBSERVED restart 已有 backend terminate/drop 路由。INFERENCE 可避免只 interrupt 保留 session。UNVERIFIED 完整 pinned API 行為、早回覆時序與 resume | 候選仍保留；沒有本輪 end-to-end PASS，不宣告不存在也不先採用 |
| A6：per-child PATH 優先 native pwsh／`CLAUDE_CODE_USE_POWERSHELL_TOOL=0` 使用 Bash | TESTED native shells containment正常。OBSERVED PowerShell toggle 是官方功能；shell selection 最終可能不只依 PATH。UNVERIFIED pinned Aion complete-chain / Bash fixture | 可做窄比較；只限 child env，不改使用者 PATH。不能單獨修復 interrupt |
| A7：`--bare`／strict MCP／default permissions／shell prefix | OBSERVED 官方 CLI 支持 discovery／permissions 設定；shell prefix 不通用於 PowerShell。拒絕所有 process tool 會讓 W1 fixture 根本不能執行 | 不算通過 acceptance；本輪 isolation flags 只用於控制 probe 範圍 |

官方來源：[Claude environment variables][claudeenv]、[CLI reference][claudecli]。沒有反編譯 Claude，也沒有把未公開 implementation 當作已驗證 source。

**OBSERVED semantics**：`CREATE_BREAKAWAY_FROM_JOB` (`0x01000000`) 是 process-creation request；`JOB_OBJECT_LIMIT_BREAKAWAY_OK` (`0x800`) 只是容許 request，`SILENT_BREAKAWAY_OK` (`0x1000`) 才是普通 child 自動 breakaway 的 limit。`CREATE_NEW_PROCESS_GROUP`／Node `detached` 不是已觀察到該 request 的證據。[Process creation flags][creationdocs]、[Job limit information][limitdocs]

**Recommendation for A**：先保留 A4/A5 作為最小窄驗收候選；不要修改 Claude／Aion 或全域設定來嘗試不支持的 hidden flag。若原始 cancel API 與 persistent-session 語意必須保留，A2/A3/A6 已無足夠保證，進入 B。

## 6. B — Upstream fix candidate

**INFERENCE／design only**：最小修正需處理「開始前 containment」及「cancel 完成前 teardown」；只調 Job flags 或只補 suspended 不能修復全部 W1。

| 修正點 | 最小設計 | 為何在這裡 |
|---|---|---|
| `crates/aionui-runtime/src/spawn.rs` 的 `Builder`；`crates/aionui-process/src/process.rs::ManagedProcess::spawn` | 加受 Windows cfg 限制的窄 builder operation，僅 ManagedProcess 路徑設定 `CREATE_SUSPENDED`；沿用現有 plan/stdio/Job assign/resume，成功後才交還 io | 已有 helper，不另造 process subsystem；不能直接讓所有 Builder／clean_cli output 都 suspended 而無人 resume |
| `process.rs::job_windows::JobObject::assign_and_resume` | 保留現有 `0x2000`，查 assignment 成功、至少一個合法 thread 確實 resume；任何失敗終止本次 owned child 並回錯 | 修復註解與實際 spawn 不一致；不使用 PID name sweep |
| `process.rs::ManagedProcess::kill` / `JobObject::terminate` | Windows 必須 terminate owned Job，即使 leader 在 grace 內已退出；檢查 Win32 結果並以 Job active-process count／已記錄 identity 的退出確認清理完成 | leader exit 不能代表 subtree exit；Drop 最終 close 不等於 await cleanup contract |
| `crates/aionui-session/src/backend/claude_conn.rs::dispatch(Command::Cancel)`、`crates/aionui-ai-agent/src/session_agent.rs::cancel` | 對嚴格 W1 的 cancel 使用既有 backend teardown／SuspendController path；可先送 interrupt 作短 grace，然後無條件 terminate/drop 本 session Job。後續 turn 以現有 session resume 路徑重開 | 本案 raw cancel 只 interrupt；不該在錯誤的 `CliAgentProcess::spawn_for_sdk` 加修補 |
| 已有 terminate chain：`backend/suspend.rs::terminate` → `adapter.rs::ManagedProcessIo::terminate` | cleanup error 必須能傳回／記錄，cancel completion 等待 cleanup；不先把 Finish／idle 當 OS cleanup 完成 | 既有 `ManagedProcessIo` 吞/log kill error，`SessionAgent::kill` 某些路徑 fire-and-forget；須讓窄驗收能判斷退出證據 |

來源：[spawn][spawn]、[process][process]、[session][session]、[SuspendController L180–188][suspend]、[ManagedProcessIo L97–129][agentio]。

**是否需要 `CREATE_SUSPENDED`？** INFERENCE：需要，除非選擇 Windows `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 creation 時原子加入既有 Job；後者原生支持但本輪未實測，且比沿用現有 assign/resume 改動更大。[native attribute API][desktopdocs]

**是否調整 Job flags／禁止 breakaway？** OBSERVED：Aion 已設 `0x2000` 且兩種 breakaway off；不需要再「清掉」本來沒有的 bits。INFERENCE：保持 session owned Job 不允許 ordinary breakaway；不修改 ambient host 或 Claude inner Job。若使用 packaged tool，另保留 supported launcher policy/native shell 候選；單靠 suspended 不足以防止已實測的 packaged-policy escape。若 A4 在完整鏈失效，最小 upstream spawn policy 才考慮在同一窄 ManagedProcess creation 路徑傳 `DISABLE_PROCESS_TREE`，並以 packaged probe 驗證；未指定需全面換 native spawn backend。

**是否會破壞 `.cmd`、Codex、Antigravity、其他 Agent？** UNVERIFIED：未實作、未 runtime regression。INFERENCE：只 suspend ManagedProcess 的實際 native image（npm shim 仍由既有 `cmd /d /c` plan 啟動），assign cmd 再 resume 可維持 quoting；Codex 同走 DirectCli，所以共享 spawn 變更須測它；Antigravity／ACP 若走 RealSpawner 也可能受影響。不得全域改 `configure_platform_spawn`，避免 version probes、short tools 和沒有 paired resume 的 caller 卡住。Claude cancel teardown 是 backend-specific contract 改動，需確認 resume 可用，而不是順便把所有 Agent cancel 改成同一策略。

**UNVERIFIED**：尚未向 upstream 發 issue／PR，沒有取得上游接受或拒絕。這是可附 failing acceptance test 的修正候選，不是已完成或已保證 PASS 的 patch。

## 7. C — Minimal maintained patch design

**不啟用 C。** V1 §12.3 要求先 supported workaround，再 upstream issue／小 PR，只有兩者都不可行才評估 patch build。本輪找到可用 native containment 部分方案，A4/A5 完整驗收尚未做；B 有明確窄修正點且未被上游拒絕，沒有證據滿足轉入 maintained patch 的前提。

**UNVERIFIED**：沒有聲稱 A/B 都無法解決，沒有設計第二套 process subsystem、fork adapter 或 patch distribution。若未來 A 的窄驗收失敗且 B 不可行，再以同一具體 W1 failing fixture 評估 bounded patch；本輪沒有實作它。

## 8. Regression risks

| 風險 | 相稱檢查／限制 |
|---|---|
| 全域 suspended 造成 `--version`／短工具永久等待 | 只對 ManagedProcess 設定；其他 Builder callers 保持原行為，測一個短 CLI capture |
| npm `.cmd` quoting、中文空白 cwd、stdin/stdout capture | 沿用既有 ProgramPlan；direct exe 與 `.cmd` 各測立即 spawn grandchild，不重跑全部 W3 |
| Windows nested Job assignment 失敗／UI limits | 保留 fail-closed spawn error、記錄 Win32 error；nested 普通 Job fixture 驗證，不借添加 breakaway 放過它 |
| packaged desktop-app policy 改變 package 環境／可被 child 覆寫 | policy-only probe 已驗證；完整鏈需記錄每個 edge membership；只認可實際 supported native flag，不假設安全沙箱 |
| cancel teardown 丟失 volatile session、背景任務、MCP connection | 保存 session id，用同一 cwd 的既有 resume；cancel + cleanup 完成後才能接新 turn；與其他 conversation 隔離 |
| close／terminate leader 後尚有 Job members | 等待 Job members 清空，不只 leader status；避免 leaked/inherited Job handle；記錄 timeout / API error |
| cleanup PID reuse、orphan root 不在 PPID tree | 用 retained handle 或 PID + creation-time；fixture 自行記錄 leaf，不依名稱 kill 或僅用 PPID traversal |
| Codex／agy 或其他 RealSpawner caller 受共有 spawn 變更影響 | 只在未來實作 B 時跑各一個相關 spawn/teardown smoke；本輪皆 NOT_TESTED，不擴展其他 blocker |

## 9. Narrow W1 retest plan（本輪不執行產品修正）

1. 只使用新的 disposable directory、現有 pinned binary／Claude；先保存 version、binary hash、owned PID identity baseline。維持既有登入與設定；所有 env／native policy 都只給 child。若 Aion 啟動會觸及使用者設定，先在 disposable profile／已支持的隔離方式確認，再啟動，不能以修改全域設定換取測試通過。
2. A 優先：Conductor native launcher 使用 `CREATE_SUSPENDED → named outer Job(0x2000) → record childInJob → resume`；比較 policy `2` 和 per-child native-shell 路徑，確實記錄 actual shell executable。沒有直接 Aion membership 就標 INVALID／UNVERIFIED，不能借先前run補值。
3. 一次只跑一個 action：raw cancel、runtime restart、終止 actual AionCore、終止 Conductor Job owner。Aion 自身 TerminateProcess 和 wrapper close 要分開，因 parent-pid shutdown 也可能造成 Aion 退出，不能互相冒充。若評估 A5，另清楚命名「cancel via runtime restart」，驗證同 conversation 的 resume，不把它當作 raw cancel。
4. 每個 run 建立有限生命週期的 root → mid → orphan leaf 及 sleeper；增加一個立即 spawn-grandchild case。用 direct exe 與 npm `.cmd` wrapper 各一次，採同一 membership 查詢；必要時才加一次 early-stop race case，不跑其他 P0 矩陣。
5. action 前對 Aion、Claude、cmd／shell、root、sleeper、leaf 查 specific outer 與 per-session Job，保存 limit flags；shell 自己查 immediate flags。若偵測到 membership 首次丟失，只在該 edge 追加 native attribute／CreateProcess flags 診斷，不先推定 `CREATE_BREAKAWAY_FROM_JOB`。
6. action 後採固定 deadline（例如 6 秒，fixture TTL 須更長），比對事前 PID + creation time 及 Job active members。cancel/restart 排除仍應存活的 Conductor/Aion 服務 owner，但不排除 Agent leader 或 tool/MCP descendants。**任何仍屬本 turn/session 的 owned descendant = FAIL**；沒有取得 identity 或 tool 未執行 = NOT_TESTED／INVALID，不能 PASS。
7. 每個 run 結束只清理 owned handles／已驗證 identity，確認 fixture 與 owned Agent tree 零殘留，再開始下一個 run。A 全數 PASS 才推薦 `SUPPORTED WORKAROUND`。若只能包含 tree 而 raw cancel 仍 FAIL，提出第 6 節 upstream candidate；upstream fix 可用後僅重跑此矩陣與相稱的 caller regression。

## 10. Recommendation 與停止條件

**`UPSTREAM FIX REQUIRED`：目前 raw cancel 的 source 與同 protocol 實測均不符合嚴格 W1；在不把 cancel 換成 restart／整個 runtime stop 的前提下，應修正既有 session teardown 及 managed spawn 保證。**

**INFERENCE**：這不是已證實無解的 `ARCHITECTURE BLOCKER`：原生 Job containment、policy-only intervention 與 direct Claude outer-close 均已有有效零殘留證據；也不到 `MINIMAL PATCH REQUIRED`，因 A 組合仍有候選，B 尚未不可行。

**W1 狀態：FAIL（既有 gate 未關閉）；本輪 diagnostics：有效結果已保存，packaged baseline 與 interrupt 故意重現 FAIL，對照及清理 PASS。** 本輪沒有升級任何其他 P0 結果，沒有實作修正。報告完成後停止。

[v1]: ../architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md
[p0]: ./P0_SPIKE_REPORT.md
[evidence]: ../../reports/evidence/w1-review-20261006
[inputhash]: ../../reports/evidence/w1-review-20261006/review-input-sha256.json
[sourcehash]: ../../reports/evidence/w1-review-20261006/pinned-source-sha256.json
[audit]: ../../reports/evidence/w1-review-20261006/final-process-audit.json
[oldbefore]: ../../reports/evidence/w1-claude-kill-aioncore.before.json
[oldresult]: ../../reports/evidence/w1-claude-kill-aioncore.result.json
[oldjobdiag]: ../../reports/evidence/jobdiag-claude.messages.json
[systemresult]: ../../reports/evidence/w1-review-20261006/system-powershell.result.json
[unpackaged]: ../../reports/evidence/w1-review-20261006/unpackaged-pwsh.result.json
[packaged]: ../../reports/evidence/w1-review-20261006/packaged-pwsh.result.json
[policyresult]: ../../reports/evidence/w1-review-20261006/packaged-pwsh-policy-disable.result.json
[claudedefault]: ../../reports/evidence/w1-review-20261006/claude-launcher-default-run2.result.json
[claudedisabled]: ../../reports/evidence/w1-review-20261006/claude-launcher-disabled-run2.result.json
[invalid]: ../../reports/evidence/w1-review-20261006/claude-launcher-default.INVALID-run1.md
[factory]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-ai-agent/src/factory/acp.rs#L106-L140
[adapter]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-session/src/adapter/claude.rs#L1051-L1152
[spawner]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/spawner.rs#L52-L127
[process]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/process.rs
[spawn]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-runtime/src/spawn.rs
[connection]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-session/src/backend/claude_conn.rs#L3191-L3219
[session]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-ai-agent/src/session_agent.rs
[suspend]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-session/src/backend/suspend.rs#L180-L188
[agentio]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-session/src/adapter.rs#L97-L129
[proctree]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/proc_tree.rs
[desktopdocs]: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
[querydocs]: https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject
[nesteddocs]: https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs
[creationdocs]: https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags
[limitdocs]: https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
[claudeenv]: https://code.claude.com/docs/en/env-vars
[claudecli]: https://code.claude.com/docs/en/cli-reference
