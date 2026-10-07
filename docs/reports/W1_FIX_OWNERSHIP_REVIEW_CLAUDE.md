# W1 Fix Ownership Review — Claude

日期：2026-10-06。環境：家用 Windows 11 電腦（不是辦公室 W1 evidence 的重現環境）。

範圍：只回答「W1 的最小、正確 upstream fix 應該由誰負責」。本輪沒有重新證明 W1，沒有啟動 AionCore 或 Claude probe，沒有 patch，沒有修改 global config，沒有建立 upstream Issue/PR，沒有 commit。

## 證據標記

| 標記 | 本報告中的意義 |
|---|---|
| OBSERVED | 本輪直接讀到的 pinned source、官方文件、公開 Issue，或家用電腦上的唯讀觀察。家用觀察**不是**辦公室 W1 的 TESTED |
| TESTED | 只引用已保存的辦公室 evidence（[W1 Root-Cause Review][review]、[W1 Workaround Result][result]）。本輪沒有新的 TESTED |
| INFERENCE | 由 OBSERVED / TESTED 推導；會寫出適用邊界 |
| UNVERIFIED | 沒有直接證據；包括 Claude Code 的私有 implementation |

---

## 1. Verdict

**`BOTH`**

W1 有兩個彼此獨立的缺陷，分別只有一方能修。另有一個殘餘類別，目前沒有任何 supported 修法。

| 缺陷 | 唯一能修的一方 | 證據強度 | 為什麼另一方修不到 |
|---|---|---|---|
| **D1：packaged `pwsh.exe` 在建立時離開祖先 Job**（A4+A5 實際失敗的原因） | **Claude Code**：它選擇並建立這個 shell | TESTED（失敗）；修法方向有 TESTED 類比 | AionCore 位於逃逸邊的上兩層。Windows 文件中能影響 Job 歸屬的機制（`CREATE_SUSPENDED`+assign、`PROC_THREAD_ATTRIBUTE_JOB_LIST`、`PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY`）都只作用在呼叫者**自己建立**的 process。辦公室 edge probe 在沒有 AionCore、也沒有 Claude 的情況下仍重現逃逸 |
| **D2：`ManagedProcess::spawn` 沒有用 `CREATE_SUSPENDED`，child 在 assign 到 per-process Job 之前已經在執行** | **AionCore** | OBSERVED source（程式與自己的註解、capability 宣告矛盾）；runtime 影響 UNVERIFIED | Claude Code 無法影響 AionCore 怎麼建立 Claude。Conductor 外層 Job 只在「停掉整個 AionCore」時有用，無法提供 Task Cancel = `/runtime/restart` 所需的單一 conversation teardown |
| **R1（殘餘）：agent 指令中由「未封裝」的後代再啟動任何 packaged app**（例如 node → `pwsh`、Store 版 `python`） | 無 | INFERENCE（由 TESTED edge probe 推出） | 建立這類 process 的是 agent 執行的任意程式，不是 AionCore 或 Claude Code。Microsoft 文件沒有讓祖先保證 packaged 後代留在祖先 Job 的機制（見 §5） |

為什麼不是單修一邊：
- **只修 AionCore（D2）**：A4+A5 的實測失敗完全不受影響。逃逸發生在 `cmd.exe → packaged pwsh` 這條邊，這條邊不經過 AionCore 的任何 spawn call（TESTED edge probe）。
- **只修 Claude Code（D1）**：W1 定義（[V1 §9][v1]）要求「啟動後立即 spawn grandchild 的 agent」與 npm `.cmd` shim 在 cancel/restart 後也零殘留。D2 讓這類 child 有機會在 assign 前建立 grandchild，grandchild 只在 Conductor Job 裡，不在 Claude 的 per-process Job 裡，所以 `/runtime/restart` 收不到它。這個情境與 Claude Code 無關（W1 的 immediate-spawn agent 甚至不是 Claude）。

不選其他選項的原因：
- `AIONCORE_FIX`：AionCore 無法控制 D1（§3.3）。
- `CLAUDE_CODE_FIX`：留下 D2，W1 的 immediate-spawn 子案例在 source 層面仍不成立。
- `OTHER_SUPPORTED_WINDOWS_FIX`：沒有找到（§5）。
- `NO_SUPPORTED_UPSTREAM_FIX`：D1、D2 都有使用已文件化 Win32 API 的修法。只有 R1 沒有，而 R1 不在目前 W1 fixture 的路徑上；它應寫成 W1 的已知限制，不應讓整個 verdict 變成無解。

---

## 2. Evidence reviewed

### 2.1 專案文件（已完整閱讀）

| 文件 | 用到的結論 |
|---|---|
| [Architecture V1][v1] | W1 定義（§9）、NO-GO 處理順序（§12.3）、禁止修改 PATH/Registry（§1.2） |
| [P0 Spike Report][p0] | W1 原始失敗；Claude tool shell 所在 Job 的 immediate flags 是 `0x800` |
| [W1 Root-Cause Review][review] | AionCore source path；packaged/unpackaged/policy-2 的 native 對照（TESTED） |
| [W1 Supported-Workaround Result][result] | A4+A5 FAILED；escape edge 是 `cmd → packaged pwsh`；edge probe（TESTED） |

### 2.2 AionCore source（OBSERVED）

- Pinned `v0.2.2` = `47e66d0d151123e973b3fd1e77afcb5671b3f8c5`。目前 upstream `main` 的 HEAD = `4a707fc3`（2026-09-30），沒有更新的 release。
- 用 `gh api` 下載兩個 ref 的 `aionui-runtime/src/spawn.rs`、`aionui-process/src/{process,proc_tree,spawner}.rs`：**兩個 ref 完全相同**。所以 upstream 目前沒有修正 D2。
- 另外讀了 `aionui-process/src/capabilities.rs`、`aionui-process/Cargo.toml`、`aionui-session/src/backend/claude_conn.rs`。
- Upstream issue [iOfficeAI/AionCore#752](https://github.com/iOfficeAI/AionCore/issues/752)（已關閉）：處理「離開 process group 的 tool subprocess 在 Cancel 後存活」，只量測 Unix/agy。修法是 pre-kill descendant snapshot sweep。Windows 的 `parent_table()` 仍然回傳空 table，所以這個 sweep 在 Windows 不做任何事。

### 2.3 Microsoft 官方文件（OBSERVED）

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)（`JOB_LIST`、`DESKTOP_APP_POLICY`、`PARENT_PROCESS`）
- [Understanding how packaged desktop apps run on Windows](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)
- [Install PowerShell 7 on Windows](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows)（MSIX 版的限制；7.6 起 winget 預設裝 MSIX；7.7 起沒有 MSI）

### 2.4 Claude Code 官方文件與 Issue（OBSERVED）

- [Environment variables](https://code.claude.com/docs/en/env-vars)、[Tools reference — PowerShell tool](https://code.claude.com/docs/en/tools-reference#powershell-tool)、[Advanced setup — Windows](https://code.claude.com/docs/en/setup)。
- 在 `anthropics/claude-code` 搜尋 `job object windows`、`pwsh WindowsApps`、`powershell executable path`、`powershell store msix`、`CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER`、`orphan windows`、`pwsh` 等關鍵字。**沒有找到處理「PowerShell tool 啟動的 packaged pwsh 離開 caller Job」或「指定 PowerShell executable」的 Issue/PR。** 相關但不同的 Issue：
  - [anthropics/claude-code#91763](https://github.com/anthropics/claude-code/issues/91763)（open）：Claude Desktop MSIX 的 AppX container Job 被 Claude Code 間接啟動的 `git fsmonitor--daemon` 撐住。第三方報告，可作為「Windows 為 packaged app 維護 per-package Job」的旁證，但不是官方說明。
  - [anthropics/claude-code#92583](https://github.com/anthropics/claude-code/issues/92583)（open）：Windows 上 auto-background 的 Bash 指令在 session 結束後成為 orphan。
  - [anthropics/claude-code#84464](https://github.com/anthropics/claude-code/issues/84464)（closed, stale）：background task 的 shell 被結束，但 descendant tree 成為 orphan。
- Claude Code 的 CLI source 不公開。本報告不推測其私有 implementation，相關項目一律標 UNVERIFIED。

### 2.5 家用電腦唯讀觀察（OBSERVED，不是 TESTED）

| 項目 | 家用電腦 | 辦公室（handoff） | 影響 |
|---|---|---|---|
| OS | Windows 11 Pro 10.0.26200 | NT 10.0.26200 | 相同 |
| PowerShell 7 | `Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe`（packaged），另有 App Execution Alias `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` | 相同 package | 相同 |
| Claude Code | **2.1.268** | 2.1.290 | 家用版本早於 `CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER` 的最低版本 2.1.269 |
| AionCore runtime | 沒有 | `runtime/aioncore` | 家用電腦無法重現 AionCore 鏈，本輪也沒有嘗試 |

**本 session 自身的 process 鏈**（不是 probe：只用 `IsProcessInJob`、`GetPackageFullName`，以及 `QueryInformationJobObject(NULL, …)` 查詢「目前 PowerShell tool 自己」）：

```text
claude.exe 32924     inAnyJob=True  pkg=none
└─ claude.exe 38764  inAnyJob=True  pkg=none
   └─ cmd.exe 38160  inAnyJob=True  pkg=none          ← Claude 的 shell launcher
      └─ pwsh.exe 44312  inAnyJob=True  pkg=Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe
```

pwsh 44312 的 **immediate Job**：
- limit flags = `0x800`（只有 `BREAKAWAY_OK`，沒有 kill-on-close）；
- 6 個 member：44312 本身，另外 5 個 packaged `pwsh.exe`，它們的 parent 是 `WindowsTerminal.exe` 31096（2 個）與**另一個** `claude.exe` 39272（3 個）；
- 它的 parent `cmd.exe` 38160 和 `claude.exe` 38764 **不是**這個 Job 的 member。

**INFERENCE**：這個 `0x800` Job 是 PowerShell package 共用的 Job，跨越互不相關的 process tree，不是 Claude 為這次指令建立的 Job。一個 nested child job 的 member 必須是 parent job 的子集；這個 Job 同時包含 Windows Terminal 啟動的 pwsh，所以它不可能是 Claude 那條 Job chain 底下的 child job（前提：Windows Terminal 那一支不在 Claude 的 Job chain 裡，這點沒有直接查證）。這也解釋了 [P0 §5][p0] 和 [review §1.1][review] 看到的 `0x800`：那很可能是同一種 package Job，不是 Claude 自建的 nested job。家用觀察與辦公室 TESTED 的 `inOwnedJob:false, inAnyJob:true` 一致，但它**不是**辦公室 W1 的重測。

### 2.6 既有 evidence 一致性檢查

[Review §1.3][review] 的「Claude default launcher」run 顯示 `cmd → shell` 在 outer Job 內（true）；[Workaround result §3][result] 顯示 `cmd → packaged pwsh` 不在 owned Job（false）。表面上互相矛盾。

- **OBSERVED**：review 自己說明 direct-Claude probe 沒有保存 shell executable 的完整路徑，而且同一輪 review 有一個「native unpackaged pwsh」case。所以當時有可用的 unpackaged pwsh，並經由 inherited PATH 提供。
- **OBSERVED**：result §5 記錄 AionCore 啟動時會重建 PATH，之後 Claude 以完整路徑啟動 packaged pwsh。
- **INFERENCE**：兩份 evidence 的 shell 不是同一個 executable，所以不構成真正的矛盾。**UNVERIFIED**：review 那次 run 實際用的 shell 路徑。依指示，家用電腦不重測。

---

## 3. AionCore responsibility

### 3.1 AionCore 實際做了什麼（OBSERVED，pinned = upstream main）

| 位置 | 行為 |
|---|---|
| [`spawn.rs` L289–297][spawn-cfg] | Unix 設 `process_group(0)`；**Windows 的 `configure_platform_spawn` 是空函式** |
| [`spawn.rs` L97–106、L212–215][spawn-new] | `Builder::new` / `Builder::spawn` 直接 spawn。整個檔案沒有任何 `creation_flags` |
| [`process.rs` L164–215][proc-spawn] | `ManagedProcess::spawn` → `builder.spawn()` → `JobObject::assign_and_resume`。L191 註解寫「the child was spawned CREATE_SUSPENDED」，但實際沒有設這個 flag |
| [`process.rs` L539–601][proc-job] | 建立 unnamed Job，只設 `KILL_ON_JOB_CLOSE`（沒有 breakaway bit）→ `AssignProcessToJobObject` → ToolHelp 找 thread 並 resume。`terminate()` 沒有檢查回傳值 |
| [`capabilities.rs` L98–119][caps] | Windows capability 宣告「hot-kill subtree: Job Object (CREATE_SUSPENDED → assign → resume)」，並註明 runtime 行為只做過 cross-compile，要在真實 Windows 上驗證 |
| [`process.rs` L393–454][proc-kill] | `kill()`：leader 在 grace 內退出就直接 return，不呼叫 `TerminateJobObject`。Job 內其他 member 要等 `ManagedProcess` 被 Drop、Job handle 關閉後才被 kill-on-close 結束 |
| [`proc_tree.rs` L65–77][proctree] | `parent_table()` 在 Windows 回傳空 Vec。#752 的 escaped-descendant sweep 在 Windows 什麼都不做 |
| [`claude_conn.rs` L3191–3219][cancel] | `Command::Cancel` 只寫 `control_request{subtype:"interrupt"}`，刻意保留 persistent Claude process |

### 3.2 AionCore 能修的部分

| 問題 | 判斷 | 理由 |
|---|---|---|
| **Start race（D2）** | **OWNER，W1 需要** | 只有 AionCore 能決定 child 建立時是 suspended 的。程式與自己的註解、capability 宣告不一致，這是 correctness bug。W1 的 immediate-spawn agent、npm `.cmd` shim 都經過這條路 |
| `kill()` 的 early return | OWNER，hardening，不是 W1 的 blocker | TESTED：r2/r3 的 restart 在約 1.4 秒內清掉了所有 Job 內 member，說明 Drop 路徑在該情境有效。但「leader 退出 ≠ subtree 退出」，Windows 應無條件 terminate Job，並檢查回傳值 |
| Raw cancel 只 interrupt | OWNER（API 語意），**W1 不需要改** | TESTED：Task Cancel = `/runtime/restart` 的語意通過（只影響單一 conversation、可 resume、worktree 保留、無 drift）。Conductor 可以用既有 API 滿足嚴格 Task Cancel，不需要改 AionCore 的 cancel contract |
| Windows orphan sweep | CAN_MITIGATE，**不算修正** | 補 Windows `parent_table()`（ToolHelp）只是 best-effort 的 PID snapshot sweep。parent 已經退出的 orphan（例如 leaf、igc）在 snapshot 時就找不到 parent 連結。這等於 process-tree polling + kill，不能當作正式解法 |

### 3.3 AionCore 無法控制的部分：packaged descendant launch boundary（D1）

**TESTED**（[result §3][result]）：`Conductor Job → cmd.exe → packaged pwsh`，不經 AionCore、不經 Claude，policy 0 / policy 2、完整路徑 / alias 四種組合都逃逸。`GetCurrentPackageFullName` 確認 pwsh 有 package identity。

逐一檢查 AionCore 可用的 Windows 機制（OBSERVED 文件 + TESTED evidence）：

| 機制 | 作用對象（官方文件） | 能不能修 D1 |
|---|---|---|
| `CREATE_SUSPENDED` + `AssignProcessToJobObject` | 呼叫者自己建立的 process | 不能。AionCore 建立的是 Claude，不是 pwsh。修好後 Claude 會更早進 Job，但 pwsh 的逃逸發生在下兩層 |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST` | 「a list of job handles to be assigned to **the child process**」 | 不能。只指定 direct child 的 Job，不會傳到後代的 CreateProcess |
| Nested Jobs | 「When processes are implicitly associated with a job **during process creation**, a child process is associated with every job in the job chain of its parent process」 | 不能。逃逸的 process 根本沒有走這條隱式繼承。TESTED：cmd 在 Job 內、Job 沒有 breakaway bit，pwsh 仍不在 Job |
| `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` | 「relevant only to win32 applications that have been converted to UWP packages by using the Desktop Bridge」；`DISABLE_PROCESS_TREE` 讓**被建立的 process 所建立的 children** 留在「desktop app runtime environment」，並繼承給後代 | 不能。TESTED：Conductor 在 AionCore（A4）或 cmd（edge p2）上設 policy 2，`cmd → pwsh` 仍逃逸。此 policy 只在**被設定的 process 本身是 packaged** 時才有實際效果（review 中 policy 2 成功，是因為 wrapper 直接建立 packaged pwsh 並自己 assign） |
| Breakaway 語意 | Job 沒有 `BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK` 時，一般 CreateProcess 的 child 不能離開 | 不適用。AionCore Job 與 Conductor Job 都沒有 breakaway bit（OBSERVED source、TESTED `0x2000`），逃逸仍發生。逃逸不是一般的 breakaway |
| Packaged / Desktop Bridge activation | **Microsoft 沒有文件說明**從未封裝 process 啟動 packaged exe 時 Job 怎麼分配 | — |

**INFERENCE**：AionCore 改善 Job 管理（D2 修正、unconditional terminate）能讓「Job 內」的部分更正確，但**無法**讓一個由第三方程式（Claude 的 cmd launcher）建立的 packaged process 留在 AionCore 的 Job 裡。這與 [handoff §3][handoff] 的前提一致，現在有官方 API 範圍的依據。

唯一的間接影響是環境變數：AionCore 會重建 PATH 並傳 env 給 Claude（OBSERVED log：`startup: PATH ready path_segments=51`）。Claude 文件說明它會「auto-detect `pwsh.exe` … with a fallback to `powershell.exe`」，但沒有說明偵測規則是否依照 PATH（UNVERIFIED）。用 PATH 隱藏 pwsh 並不是 contract，所以只能算有限的 CAN_MITIGATE，不算修法。

---

## 4. Claude Code responsibility

### 4.1 官方文件明確寫了什麼（OBSERVED）

| 主題 | 官方說法 |
|---|---|
| Shell 選擇 | 「On Windows, Claude Code auto-detects `pwsh.exe` for PowerShell 7+ with a fallback to `powershell.exe` for PowerShell 5.1」。沒有說明偵測順序、是否依照 PATH、是否區分 MSIX/Store 版 |
| PowerShell tool 開關 | 沒有 Git Bash 時自動啟用；有 Git Bash 時 claude.ai/Console 帳號預設開啟；`CLAUDE_CODE_USE_POWERSHELL_TOOL=0` 關閉 |
| 指定 executable | **沒有**指定 PowerShell executable 的 env var 或 setting。對照組：Git Bash 有 `CLAUDE_CODE_GIT_BASH_PATH`（會驗證路徑與檔名） |
| `CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER` | 「start PowerShell tool commands on Windows directly instead of through the `cmd.exe` launcher. By default, the launcher lets a PowerShell command running in the background carry over to the session's next process」。需要 v2.1.269 以上 |
| 其他相關 | `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY`；`defaultShell: "powershell"`（只影響 `!` 指令）；hook 的 `shell: "powershell"`；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`、`CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF`、`CLAUDE_DISABLE_ADOPT` |
| Job / process tree | 文件沒有提到 Job Object，也沒有承諾 tool subprocess tree 的終止語意 |

### 4.2 為什麼 Claude Code 選 packaged pwsh

- **OBSERVED**：文件只說 auto-detect `pwsh.exe` 並以 `powershell.exe` 作為 fallback。
- **OBSERVED**：Microsoft 文件說明 7.6 起 winget 預設安裝 MSIX，7.7 起只有 MSIX。所以「`pwsh.exe` = packaged」在新安裝會越來越普遍。
- **UNVERIFIED**：實際的偵測規則（PATH、alias、`WindowsApps` 完整路徑、registry 等）。辦公室 TESTED 只顯示「AionCore 重建 PATH 後，Claude 以完整 package 路徑啟動 pwsh」。沒有公開 source，不推測。

### 4.3 Claude Code 能不能在 spawn shell 時保留 Job containment

**INFERENCE，有 TESTED 類比**：能，而且是唯一能在這條邊上做到的一方。

1. **TESTED 類比**（[review §1.3][review]「native packaged pwsh」與「packaged pwsh + policy 2」）：**直接建立** packaged pwsh 的 process 若以 `CREATE_SUSPENDED` 建立、明確 `AssignProcessToJobObject` 到自己持有的 Job、並在建立時加 `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY = DISABLE_PROCESS_TREE (0x02)`，則 shell 與所有 fixture 後代都在該 Job，關閉 Job 後零殘留。只做 assign、不加 policy 時，shell 在 Job 內，但後代逃逸。
2. 在 Claude 的 default 模式，建立 pwsh 的是 `cmd.exe`，不是 Claude 本身。cmd 無法設定這些 attribute。所以 Claude 必須自己建立 packaged shell（類似 disable-launcher 模式），或不要讓 packaged shell 由 cmd 建立。
3. Claude 拿不到祖先 Job（AionCore 的 unnamed Job、Conductor 的 Job）的 handle。所以 Claude 應使用**自己持有的** kill-on-close Job。containment 會變成一條「持有鏈」：Conductor Job → Claude（被 AionCore restart 或 Job close 殺掉）→ Claude 的 Job handle 被關閉 → kill-on-close 殺掉 shell tree。這不是 nested membership，**完整鏈 UNVERIFIED**。
4. 更小的替代方案：Claude 提供指定 PowerShell executable 的 supported 設定，讓整合者選擇未封裝的 shell（System32 `powershell.exe` 5.1，或 MSI/ZIP 版 pwsh）。TESTED native baseline：未封裝 shell 的後代都留在 Job，關閉後零殘留。

### 4.4 已知 flag 為什麼不夠

| Flag | 結論 |
|---|---|
| `CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER=1` | TESTED（review）：去掉 cmd 層，但 interrupt 後仍留下 orphan leaf。在 packaged pwsh + AionCore 鏈中是否仍逃逸：UNVERIFIED。家用 2.1.268 不支援；AionCore 已驗證的 2.1.236 也不支援 |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` | 改用 Bash（Git Bash）。agent 指令仍可以從 bash 執行 `pwsh`，又回到 D1/R1。不是 containment contract |
| Background 相關 flags | 只控制 Claude 的 background 功能與 handoff，不約束 foreground 指令自己建立的 detached children |

### 4.5 Raw interrupt

**TESTED**（review）：Claude interrupt 後，foreground tool 的 orphan leaf 仍存活（即使它在外層 Job 內）。Claude Code 可以改善（CAN_MITIGATE），例如以 per-command Job 在 interrupt 時 terminate。但 W1 的 Task Cancel 已改用 `/runtime/restart`（A5），所以這**不是**本輪需要的修正。

---

## 5. Windows mechanism analysis

**問題**：父 / 祖先 process 是否有 supported Windows mechanism，可以在不知道、不能控制後代 `CreateProcess` call 的情況下，保證 packaged Win32 後代永遠留在祖先 Job？

**答案：沒有（就公開的 Microsoft 文件而言）。** 有三項限制：

1. **Job 的隱式繼承只限一般 CreateProcess child。** 官方說明「by default any child processes it creates using CreateProcess are also associated with the job」，並列出例外：breakaway limits，以及「Child processes created using Win32_Process.Create are not associated with the job」。也就是說，Windows 本身就存在**不是由 caller 自己建立**的 process 建立路徑，它們不繼承 Job。Packaged app activation 不在文件的例外清單裡。但 TESTED 結果顯示它的行為與一般 CreateProcess child 不同。家用 OBSERVED 結果也一致：所有來源的 packaged pwsh 都在同一個 per-package `0x800` Job。**UNVERIFIED**：實際的 broker 或 kernel 路徑（本輪與辦公室都沒有 ETW/syscall trace）。
2. **所有能指定 Job 的 attribute 都只作用於 caller 自己建立的 process。** `JOB_LIST`、`PARENT_PROCESS`（「Attributes inherited from the specified process include … job object」）、`CREATE_SUSPENDED`+assign 都需要 caller 執行那次 `CreateProcess`。祖先無法注入到後代的 CreateProcess call。
3. **唯一會沿著後代繼承的 attribute（`DESKTOP_APP_POLICY`）管的是 desktop app runtime environment，不是任意祖先 Job。** 文件說「relevant only to … Desktop Bridge」。TESTED：從未封裝的祖先設定這個 policy，對 `unpackaged → packaged` 這條邊沒有效果。第三方討論（[Microsoft Tech Community，MVP 回覆，非 Microsoft 員工](https://techcommunity.microsoft.com/t5/msix/are-child-processes-quot-break-away-quot-or-not-by-default/td-p/1671578)）還指出不同 Windows 版本的預設 breakaway 行為不一致；這是 UNVERIFIED 旁證，只加強「不是穩定 contract」的判斷。

其他 Windows 機制與排除原因：

| 候選 | 結論 |
|---|---|
| Job 的 `JOB_OBJECT_MSG_NEW_PROCESS` 通知 | 逃逸的 process 不在 Job 內，收不到通知 |
| ETW / WMI process-creation 監控 + kill | 本質上是 process polling + kill，依指示不採用為正式解法 |
| 關閉 App Execution Alias、解除安裝 Store PowerShell、修改 PATH/Registry、Group Policy | 依指示與 [V1 §1.2][v1] 排除。而且 TESTED 顯示用完整 package 路徑啟動也會逃逸，所以只關閉 alias 不夠 |
| AppContainer / silo | 會改變 agent 的執行與安全語意，不是「讓祖先 Job 包住後代」的機制。本輪沒有證據顯示它能修 D1：UNVERIFIED |
| OS-level isolation（VM、Windows Sandbox、專用帳號，[V1 §2.4][v1]） | 能透過「整個環境一起收掉」保證沒有殘留，但需要啟用系統功能或改變架構，不是 W1 的最小修正。保留為 R1 的長期選項 |

**INFERENCE**：結論是 `OTHER_SUPPORTED_WINDOWS_FIX` 不成立。D1 只能由「直接建立 packaged process 的那一方」處理；R1（任意後代再啟動 packaged app）目前沒有 supported 修法。

---

## 6. Responsibility matrix

標記：OWNER / CAN_MITIGATE / CANNOT_CONTROL / UNVERIFIED。「Windows/Conductor」欄指 Conductor 能用的 supported Windows 機制。

| 問題 | AionCore | Claude Code | Windows/Conductor |
|---|---|---|---|
| spawn-before-Job-assign race | **OWNER**（OBSERVED source；runtime 影響 UNVERIFIED） | CANNOT_CONTROL | CAN_MITIGATE：Conductor 自己的 launch 已用 suspended→assign（TESTED `childInJob:true`）。外層 Job 會收進 race 漏掉的 children，但只在停掉整個 AionCore 時有用 |
| raw cancel 只 interrupt | **OWNER**（API 設計，OBSERVED） | CAN_MITIGATE：interrupt 時可 terminate tool tree（TESTED：目前會留下 leaf） | CAN_MITIGATE：Task Cancel 改用 `/runtime/restart`（TESTED 語意 PASS） |
| session teardown | **OWNER**（TESTED：restart 會清掉所有 Job 內 member；`kill()` early return 是 hardening 項目） | CAN_MITIGATE：shell launcher 的設計目的就是讓 background 指令延續到下一個 process；它自己的 exit cleanup 語意沒有文件 | CAN_MITIGATE：外層 kill-on-close Job 是 stop-all 的保底 |
| packaged pwsh escape | CANNOT_CONTROL（§3.3） | **OWNER**：它選擇並建立 packaged shell；修法方向有 TESTED 類比，完整鏈 UNVERIFIED | CANNOT_CONTROL：沒有 supported 祖先機制（§5）。Activation 本身是 Windows 平台行為，沒有文件，也沒有控制點 |
| shell executable selection | CAN_MITIGATE（有限）：只能透過傳給 Claude 的 env/PATH；Claude 是否依照 PATH 選擇：UNVERIFIED | **OWNER** | CANNOT_CONTROL：剩下的手段（PATH/Registry/解除安裝）都被禁止 |
| orphan descendant cleanup | **OWNER**（Job 內的 orphan：TESTED 有效）；已逃逸的：CANNOT_CONTROL | CAN_MITIGATE：從源頭避免逃逸（D1 修正）、在 interrupt 時收掉 tool tree | CANNOT_CONTROL（已逃逸）：只剩 polling + kill，排除 |

---

## 7. Minimal upstream fix strategy

### 7.1 AionCore 要修什麼（D2）

**必要（W1）**

1. `crates/aionui-runtime/src/spawn.rs`：在 `Builder` 上新增一個只限 `#[cfg(windows)]` 的方法（例如 `suspended()`），對內部 `tokio::process::Command` 呼叫 `creation_flags(CREATE_SUSPENDED)`。**不要**改 `configure_platform_spawn`，因為它也作用在 `Builder::clean_cli`，那些 caller 沒有對應的 resume，會永久等待。目前檔案沒有任何其他 `creation_flags`，所以不會覆蓋既有 flag（OBSERVED）。
2. `crates/aionui-process/src/process.rs::ManagedProcess::spawn`：只在這條路徑呼叫上述方法。現有的 `assign_and_resume` 與失敗時 `start_kill()` 的 fail-closed 邏輯維持不變。這樣註解（L191）、`assign_and_resume` 的前置條件（L533–538）與 `capabilities.rs` 的宣告才會和實作一致。
3. `JobObject::assign_and_resume`／`resume_threads`：確認至少 resume 了一個 thread。找不到 thread 時回錯並 kill child，避免留下永久 suspended 的 process。

**建議放在同一個 PR（hardening，不是 W1 的 blocker）**

4. `ManagedProcess::kill`：在 Windows，即使 leader 在 grace 內退出，也呼叫 `JobObject::terminate()`；並檢查 `TerminateJobObject` 的回傳值。

**不需要**：改變 raw cancel 語意。Conductor 用既有 `/runtime/restart` 作為 Task Cancel（TESTED）。

### 7.2 Claude Code 要提供什麼 supported Windows contract（D1）

**最小 contract（W1 需要）**

- **C1：可設定的 PowerShell executable path**，例如 `CLAUDE_CODE_POWERSHELL_PATH`，行為比照既有的 `CLAUDE_CODE_GIT_BASH_PATH`（驗證路徑與檔名，無效時記錄 warning 並退回 auto-detect）。
- 同時在文件說明 auto-detect 的規則，以及 MSIX/Store 版 pwsh 不會留在 caller 的 Job Object。

這讓整合者（Conductor → AionCore → Claude）能透過 child env 指定未封裝的 shell，不需要修改 user/system PATH。containment 會回到一般 Job 繼承（TESTED native baseline）。

**完整修正（建議，default 使用者也安全）**

- **C2**：當選到的 shell 有 package identity（位於 PackageVolume 或是 App Execution Alias）時，Claude 自己建立它（不經 `cmd.exe`）：`CREATE_SUSPENDED` + `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY = DISABLE_PROCESS_TREE` → assign 到 Claude 持有、沒有 breakaway bit 的 kill-on-close Job → resume。interrupt、timeout 或 session 結束時 terminate 該 Job。
- 這和 launcher「background 指令延續到下一個 process」的設計互相衝突，需要 Claude Code 自己定義取捨（例如只在 disable-launcher 或 non-interactive 模式套用）。

### 7.3 修正後的預期與殘餘

- **INFERENCE**：D1（C1 或 C2）+ D2 + Conductor 的 A4/A5 → W1 的 direct exe、npm `.cmd`、immediate-spawn、restart、AionCore stop 這些情境都應零殘留。需要 §9 的回歸測試確認，目前 **UNVERIFIED**。
- **R1 殘餘**：agent 指令中由未封裝後代啟動的 packaged app 仍會逃逸。W1 acceptance 應明確寫出：fixture 不啟動 packaged app，且這是已知限制。處理敏感資料前，依 [V1 §2.4][v1] 用 OS-level isolation 補上。

---

## 8. What should NOT be changed

| 不要做 | 原因 |
|---|---|
| 修改 user/system PATH、Registry、App Execution Alias 設定；解除安裝 Store PowerShell；firewall 變更 | 依指示與 [V1 §1.2][v1] 禁止。而且用完整 package 路徑啟動也會逃逸（TESTED） |
| 以 process name 或 PID polling + kill 作為正式解法（包括在 Windows 補 `parent_table()` 後宣稱已修好） | parent 已退出的 orphan 會漏掉；有 PID reuse 誤殺的前例（[P0 Incident 1][p0]） |
| 在 `configure_platform_spawn` 全域加 `CREATE_SUSPENDED` | `clean_cli` 類 caller（`--version`、`taskkill`）沒有 resume，會永久等待 |
| 在任何 Job 加 breakaway bit，或期待 Conductor 端的 `DESKTOP_APP_POLICY` 能修 D1 | 前者會擴大逃逸；後者 TESTED 無效 |
| 把 `CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER=1` 當作 W1 的修法 | TESTED 仍有 orphan leaf；舊版 Claude 不支援 |
| 改 AionCore raw cancel 的語意 | 不需要（A5 TESTED）；改了會影響所有 backend 的 cancel contract |
| Fork 或 patch AionCore／Claude Code | [V1 §12.3][v1] 的順序：先 supported workaround、再 upstream issue/PR |
| 把家用電腦的觀察寫成辦公室 W1 的 TESTED | 環境與版本不同（§2.5） |

---

## 9. Targeted regression tests

全部只在 disposable 目錄執行，env 只設在 child，以 PID + creation time 判定身分。shell 的完整路徑與 package identity 必須記錄（補上 [review][review] 缺的欄位）。

| ID | 屬於 | 測試 | PASS 條件 |
|---|---|---|---|
| T1 | AionCore D2 | Windows unit/integration test：用 `ManagedProcess::spawn` 啟動一個「第一個動作就是 CreateProcess grandchild」的極小 exe，重複 ≥100 次 | 每次 grandchild 都在該 `ManagedProcess` 的 Job 內（用 Job handle 做 `IsProcessInJob`）；`kill()` 後 Job active process 數 = 0 |
| T2 | AionCore D2 | 同 T1，改用 npm `.cmd` shim（`cmd /d /c`） | 同 T1；argv quoting 與 stdio capture 不變（W3 的 small case） |
| T3 | AionCore D2 regression | `Builder::clean_cli` 的短指令（例如 `--version` capture） | 正常結束，沒有 suspended process |
| T4 | AionCore hardening | Leader 在 grace 內退出，但 Job 內還有 member | `kill()` 返回時 Job active process 數 = 0 |
| T5 | Claude Code D1 | Job 內的 Claude（PowerShell tool）執行 W1 fixture，機器上只有 packaged pwsh；C1 設為未封裝 shell；C2 不設 | shell、root、sleeper、leaf、igc 都在 caller 的 Job 內（或在 Claude 持有的 Job 內）；interrupt、Claude 結束、caller Job 關閉後零殘留 |
| T6 | 整合（W1 重跑） | A4（Conductor suspended→assign）+ A5（Task Cancel = `/runtime/restart`），重跑 [result §2][result] 的 r2/r3 矩陣：orphan leaf、immediate grandchild、direct exe、`.cmd` | 6 秒內 owned descendants = 0；另一個 conversation 不受影響；session resume PASS；worktree 保留；global settings 無 drift |
| T7 | Windows baseline（預期 FAIL） | 保留 edge probe：`Job → cmd → packaged pwsh` | 持續記錄 R1 仍存在；**不計入** W1 PASS/FAIL，只用來偵測 Windows 行為是否改變 |
| T8 | 其他 backend regression | Codex、agy 各一次 spawn + restart smoke | 啟動正常，restart 後零殘留（共用 spawn 修改的影響） |

---

## 10. Recommended upstream issue(s)

本輪**沒有建立**任何 Issue。以下是建議內容，等使用者決定。

### 10.1 `anthropics/claude-code`（優先，對應 D1）

- **標題建議**：Windows: PowerShell tool launches MSIX/Store `pwsh.exe` outside the caller's Job Object; no supported way to choose the PowerShell executable
- **內容**：
  - 最小重現：Job（kill-on-close、沒有 breakaway bit）→ `cmd.exe` → packaged `pwsh.exe`。pwsh 不在 caller Job；關閉 Job 後 pwsh 與 fixture 後代存活（辦公室 TESTED edge probe，附 topology）。
  - 家用 OBSERVED：Claude 的 PowerShell tool shell 落在 PowerShell package 共用的 `0x800` Job。
  - 請求：C1（`CLAUDE_CODE_POWERSHELL_PATH` 或同等 setting）＋說明 auto-detect 規則；C2 作為後續改進。
- **重複檢查**：§2.4 的搜尋沒有找到重複 Issue。送出前要再搜一次。

### 10.2 `iOfficeAI/AionCore`（對應 D2）

- **標題建議**：Windows: `ManagedProcess::spawn` never sets `CREATE_SUSPENDED`, so Job assignment races the child (comment and `capabilities.rs` say it does)
- **內容**：附上 §3.1 的 source 行號、§7.1 的最小修改、T1–T4。可另外提 `kill()` early return 的 hardening。註明 #752 的 sweep 在 Windows 是 no-op（`parent_table()` 回傳空）。
- **不建議**現在就 raw cancel 語意開 issue。W1 不需要；如果要開，應作為 feature request，與 W1 分開。

### 10.3 Microsoft（可選）

- 透過 Feedback Hub 或文件 feedback，請 Microsoft 說明 packaged Win32 app activation 與 caller Job Object 的關係。這只影響 R1 的長期處理，不在 W1 的關鍵路徑上。

---

## 11. Remaining UNVERIFIED items

1. Packaged activation 的實際 broker 或 kernel 路徑，以及 pwsh 被放進哪個 Job、由誰放入（沒有 ETW/syscall trace）。
2. Claude Code 的 PowerShell executable 偵測規則（PATH、alias、`WindowsApps` 路徑、registry），以及 default launcher 與 disable-launcher 的實際 spawn 方式（私有 implementation）。
3. 辦公室 review 中 direct-Claude run 使用的 shell 是否為未封裝 pwsh（§2.6）。
4. Review 中 disable-launcher run 的 immediate `0x3C00` Job 是誰建立的。INFERENCE：這組 flags（kill-on-close + breakaway + silent-breakaway + die-on-unhandled-exception）和 libuv 的 global job 一致，但 Claude Code 是否使用 libuv 沒有公開確認。
5. D2 race 在真實 AionCore 鏈中是否曾造成殘留（只有 source 證據；T1 可確認）。
6. C1/C2 修正後，完整 `Conductor → AionCore → Claude → shell` 鏈的 W1 結果（T5/T6）。
7. C2 的「Claude 持有的 Job」是否能在 Claude 本身位於 nested Job 時成功 assign 一個已在 package Job 中的 pwsh。Review 的 TESTED 類比中，建立者不在任何 Job 內。
8. Windows 不同版本對 packaged app 子程序預設 breakaway 的差異（只有第三方旁證）。
9. AppContainer、silo 等機制能否處理 D1/R1（本輪沒有評估到可實作的程度）。
10. 家用 Claude Code 2.1.268 與辦公室 2.1.290、AionCore 已驗證的 2.1.236 之間的行為差異。

[v1]: ../architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md
[p0]: ./P0_SPIKE_REPORT.md
[review]: ./W1_ROOT_CAUSE_REVIEW_CODEX.md
[result]: ./W1_SUPPORTED_WORKAROUND_RESULT.md
[spawn-cfg]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-runtime/src/spawn.rs#L289-L297
[spawn-new]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-runtime/src/spawn.rs#L97-L106
[proc-spawn]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/process.rs#L164-L215
[proc-kill]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/process.rs#L393-L454
[proc-job]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/process.rs#L539-L601
[caps]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/capabilities.rs#L98-L119
[proctree]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-process/src/proc_tree.rs#L65-L77
[cancel]: https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-session/src/backend/claude_conn.rs#L3191-L3219
