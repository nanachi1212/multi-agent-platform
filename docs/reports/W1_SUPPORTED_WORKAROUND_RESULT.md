# W1 Final Supported-Workaround Gate — Result

日期：2026-10-06。範圍只有 `W1_ROOT_CAUSE_REVIEW_CODEX.md` 的 A4 + A5。沒有 patch AionCore、沒有修改 Claude Code、沒有修改任何 global/user 設定、沒有重跑其他 P0 gate、沒有 commit/push/PR。

## Verdict

**`UPSTREAM FIX REQUIRED`**

（依本 gate 定義：`SUPPORTED WORKAROUND FAILED → UPSTREAM FIX REQUIRED`）

失敗條件中有兩項直接成立：

1. **Descendant 殘留**：Task Cancel = `/runtime/restart` 之後，orphan `leaf` 與 immediate grandchild `igc` 在 6 秒 deadline 後仍存活（r2、r3 兩次都重現）。
2. **Containment 仍可 escape**：在實際 AionCore → Claude → cmd → PowerShell 鏈中，Claude 選用的 packaged `pwsh.exe` **在建立時就不在 Conductor Job 內**（`inOwnedJob:false`，但 `inAnyJob:true`）。關閉 Conductor Job（kill-on-close）也殺不到它的 orphan descendants。

其他條件都通過：AionCore 保持可用、其他 conversation 不受影響、同一 session 可以 resume、worktree 保留、global settings 無 drift。

## 1. 環境與固定項

| 項目 | 值 |
|---|---|
| AionCore | `runtime/aioncore/aioncore.exe`，SHA-256 `67eb0277…0892`（pinned，每次 run 重新驗證） |
| AionCore source | tag `v0.2.2` = `47e66d0d`（restart/cancel route 與 service 的 hash 與 pinned-source 清單一致） |
| Claude Code | `2.1.290`。AionCore 自己回報 `CLI_VERSION_NEWER`：已驗證版本是 `2.1.236` |
| Conductor launcher | `reports/evidence/w1-workaround-20261006/runner.ps1`，由 **unpackaged** System32 Windows PowerShell 5.1 執行 |
| A4 pattern | `CreateProcessW(CREATE_SUSPENDED + PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY=2)` → `AssignProcessToJobObject`（named Job，flags 查回 `0x2000`，沒有任何 breakaway bit）→ `IsProcessInJob` 確認 → `ResumeThread` |
| Fixture | `tree.mjs`：root → imm（detached，立即 spawn igc 後退出）＋ sleeper（attached）＋ mid（detached，300ms 後退出並留下 orphan leaf）。TTL 180 秒 |
| Identity | 所有 survivor 判定都用 PID + creation FILETIME（CIM）。沒有任何以 process name 判斷或 kill 的步驟 |
| Isolation | Env 只設在 wrapper child。AionCore 使用 disposable `--data-dir`/`--work-dir` 與 `--local`。worktree 來自既有 disposable sandbox repo；`git -c safe.directory=*` 只作用於該次 command |

Evidence 目錄：`reports/evidence/w1-workaround-20261006/`（80 個檔案，hash 列在 `artifact-sha256.json`）。

## 2. 案例矩陣

| # | 案例 | Run | 結果 |
|---|---|---|---|
| 1 | Claude + native/unpackaged PowerShell path | r3（要求 native） | **NOT_TESTED**：見 §5 |
| 2 | Claude + packaged PowerShell path | r1c、r2、r3（Claude 實際都選 packaged pwsh） | TESTED：shell 不在 Conductor Job |
| 3 | packaged path + desktop policy `2` | r1c、r2、r3（都已套用 policy 2）；native edge probes p0/p2 | TESTED：policy 2 **沒有**阻止 escape |
| 4 | orphan leaf fixture | r1c、r2、r3 | TESTED：restart 後殘留；Job close 後仍殘留 |
| 5 | immediate grandchild fixture | r1c、r2、r3（`imm`→`igc`） | TESTED：restart 後殘留；Job close 後仍殘留 |
| 6 | raw cancel control | r1c | TESTED：FAIL（預期中） |
| 7 | runtime restart candidate | r2、r3 | TESTED：FAIL（只剩 leaf + igc） |
| 8 | restart 後同一 session resume | r2、r3 | TESTED：PASS |

INVALID runs（harness 的 approval 比對錯誤，fixture 根本沒有啟動，不是 A4/A5 結果）：`INVALID-r1-*`、`INVALID-r1b-*`，原因寫在各自的 `.NOTE.md`。兩次都是 afterJobClose=0、afterCleanup=0。

## 3. 實際 process topology（r2，代表性案例）

```text
harness/Conductor node 30736                     not in Job（Conductor 本身）
└─ wrapper powershell.exe 15312 (unpackaged)     not in Job；持有 named Job 0x2000
   └─ aioncore 29096                             inOwnedJob TRUE  （assign 時 childInJob:true）
      ├─ claude B 27740 (+ MCP descendants)      TRUE
      └─ claude A 23776                          TRUE
         ├─ cmd / MCP（npx、scrapling、python）    TRUE
         └─ cmd.exe（Claude shell launcher）       TRUE
            └─ pwsh.exe 42924  PACKAGED            **inOwnedJob FALSE, inAnyJob TRUE**   ← escape edge
               └─ node root 39564                 FALSE / any TRUE
                  ├─ sleeper 15904                FALSE / any TRUE
                  ├─ imm（已退出）→ igc 26944      FALSE / any FALSE
                  └─ mid（已退出）→ leaf 21316     FALSE / any FALSE
```

每個 PID 的 creation time、parent PID、executable、owned-Job／any-Job membership，以及 Conductor Job flags / active / member list，都在 `<run>.topo-*.json` 裡（action 前、action 後、run 結束時各一份）。從外部無法查詢 AionCore 的 per-process Job 和 pwsh 所在 Job 的 limit flags，所以標為 not available。

r1c、r3 的 topology 結構相同：每次逃逸的都是 `cmd(in Job) → packaged pwsh(not in Job)` 這條邊。

### Escape edge 隔離驗證（不含 AionCore／Claude）

`edge-p{0,2}-cmd-{direct,alias}.*`：Conductor Job → cmd.exe → packaged pwsh（用完整 package 路徑和 App Execution Alias 各測一次）→ fixture。

| policy | 啟動方式 | cmd in Job | pwsh in Job | Job close 後存活 |
|---|---|---|---|---|
| 0 | direct path | TRUE | **FALSE**（any TRUE） | pwsh + 所有 fixture |
| 0 | alias | TRUE | **FALSE**（any TRUE） | pwsh + 所有 fixture |
| 2 | direct path | TRUE | **FALSE**（any TRUE） | pwsh + 所有 fixture |
| 2 | alias | TRUE | **FALSE**（any TRUE） | pwsh + 所有 fixture |

**TESTED**：Job 內的未封裝 process 建立 packaged PowerShell（`GetCurrentPackageFullName` 確認兩種啟動路徑都有 package identity）時，新 process 不會進入 Conductor Job，而是落在另一個 Job。設在 Conductor 直接 child 上的 desktop policy `2` 對這條邊沒有作用。先前 review 中 policy 2 能成功，是因為 wrapper **自己**建立 packaged shell 並明確 assign 它；在真實鏈中，packaged shell 是由 Claude 的 cmd launcher 建立的，Conductor 碰不到。

**INFERENCE**：這是 Windows packaged-app 的 activation 行為，不是 Claude 或 AionCore 主動使用 breakaway flag。本輪沒有 syscall/ETW trace 可以證明它是由哪個 broker 建立的。

## 4. A5 結果：raw cancel vs Task Cancel = `/runtime/restart`

Pinned source（`service.rs::restart_runtime`）：「Cancel any active turn, recycle the agent process, and eagerly rebuild it … so the rebuilt runtime can resume the existing backend session」。只作用於 `conversation_id`，並 `kill_and_wait` 該 task。這是既有的 supported route。

| 檢查 | r1c raw `/cancel` | r2 restart（packaged） | r3 restart（native 要求 → 實際 packaged） |
|---|---|---|---|
| HTTP | 200 / 3ms | 200 / 710ms | 200 / 712ms |
| 1. current turn 停止 | turn 已 cancel；Claude A leader 保留（persistent） | 是；Claude A 被回收 | 是 |
| 2. owned descendants 在 6s 內為 0 | **FAIL**：12 個存活（Claude A、cmd、MCP、python、igc、leaf） | **FAIL**：igc 26944、leaf 21316 | **FAIL**：igc 24700、leaf 27812 |
| 3. 其他 conversation 不受影響 | 不適用 | PASS：B 的 10/10 owned process identity 都存活，B turn 2 回覆 `B-OK-2` | PASS（10/10，`B-OK-2`） |
| 4. AionCore 健康 | PASS | PASS（同一 PID+creation，GET 200） | PASS |
| 5. 同一 session resume | 不適用 | PASS：新 Claude 以 `--resume c5ca46e8-…` 啟動，正確答出 codeword | PASS：`--resume 27d19099-…`，正確答出 codeword |
| 6. worktree 保留 | PASS | PASS（HEAD、porcelain status、sentinel hash 都相同） | PASS |
| 7. global/user setting drift | 無 | 無 | 無 |
| 關閉 Conductor Job 後 | igc、leaf 仍存活 | igc、leaf 仍存活 | igc、leaf 仍存活 |

每 300ms 取樣一次（`afterActionSamples`）：r2/r3 在 ~1.4s 時已只剩 2 個 survivor，到 6.3s 仍是 2 個。Restart 確實清掉了 Job 內的所有成員（Claude、cmd、MCP），也清掉了 PPID 可追到的 pwsh/root/sleeper。只有 parent 已退出、又位於 Job 外的 orphan 存活。

## 5. NOT_TESTED：native/unpackaged PowerShell path

- 本機唯一的 unpackaged PowerShell 是 System32 `powershell.exe` 5.1。兩個 pwsh 路徑都有 package identity。
- r3 只從 wrapper child PATH 移除了兩個 pwsh 位置（`childPathRemoved` 已記錄），但 AionCore 啟動時會重建 PATH（log：`startup: PATH ready path_segments=51`），Claude 仍以完整路徑啟動 packaged pwsh。
- Claude 官方 env var 只有 `CLAUDE_CODE_GIT_BASH_PATH`、`CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER` 等，沒有指定 PowerShell executable 的 supported 設定。
- 要強制 native shell，就必須修改 user/system PATH 或解除安裝 packaged PowerShell，這兩者本 gate 都禁止。所以標 **NOT_TESTED**，不偽造 PASS。r3 的資料只當作 packaged path 的第二次重現。
- **INFERENCE**：如果 shell 是 unpackaged，先前 review 的 native baseline 顯示 Job 會保住所有 descendants，restart 也會清掉 Job 成員，所以這個組合很可能通過。但它不屬於本 gate 允許的 supported 手段，也未在 AionCore 鏈中證實。

## 6. 清理與限制

- 每次 run 結束時都先關閉 Conductor Job，再只依 PID + creation identity 清理。r1c 的 harness 第一版用 `Get-Process` 的 100ns 精度和 CIM 的微秒精度比對，所以 igc/leaf 沒被清掉。之後以 PID + CIM creation + fixture command line 確認身分後手動清理（過程已在本 session 記錄），並把 harness 修正為一律用 CIM 比對；r2/r3 的 afterCleanup 都是 0。
- 最終檢查：沒有任何 fixture、`w1w-` 或 aioncore process 殘留。
- Policy `0` 下的 AionCore 端到端 run 沒有執行：edge probes 已直接證明 policy 0 與 2 在逃逸邊上的結果相同，所以不重複耗費 model turn。
- 沒有 syscall/ETW trace，沒有 Codex／Antigravity 測試，也沒有 `.cmd` agent 變體（不在本 gate 範圍）。
- Claude 2.1.290 比 AionCore 已驗證的 2.1.236 新。

## 7. 對 upstream 的含義（只描述，不實作）

- A5 的語意本身可用：`/runtime/restart` 只影響單一 conversation，會回收整個 session process，而且可以 resume。因此「Task Cancel = restart」這部分**沒有**失敗。
- 失敗點在於 packaged PowerShell 會在建立時離開所有 Job，使 orphan descendants 不受 Conductor Job 和 AionCore per-process Job 約束。只做 review 第 6 節的 AionCore 修正（`CREATE_SUSPENDED`、cancel 時 terminate session Job），**無法單獨**處理這條邊。upstream 修正還必須涵蓋 shell selection／launch：例如讓 Claude Code 提供 supported 的 PowerShell executable 選擇，或在 packaged shell 的情況下由 launcher 明確控制 process creation。這是 INFERENCE，未實作也未驗證。

本 gate 完成，停止。
