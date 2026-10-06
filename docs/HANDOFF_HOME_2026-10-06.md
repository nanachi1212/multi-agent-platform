# Handoff — 2026-10-06（辦公室 → 家中 Windows 電腦）

本文件只記錄交接時的狀態與證據摘要，不搬 Claude/Codex session 本身。在另一台電腦上 clone 或 pull 本 repo 後，即可從這裡接續。

## 1. 目前狀態

| 項目 | 狀態 |
|---|---|
| Architecture | [Architecture V1](architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md)（另有 [Codex Architecture Review](architecture/ARCHITECTURE_REVIEW_CODEX.md)） |
| P0 verdict | **NO-GO for MVP-0**（[P0 Spike Report](reports/P0_SPIKE_REPORT.md)） |
| 目前優先處理 | **W1** |
| MVP-0 | **不得開始**。所有 P0 blocker 關閉前都不開始 |
| Safety | Git worktree **不是** security sandbox。只能用於 disposable、非敏感的 repo |

### 目前的 blockers

1. **W1**：process containment（cancel／restart／stop 後 descendant 殘留）
2. **R8**：approval semantics
3. **W10 / R16**：config drift
4. **R15**：Antigravity hook

## 2. W1 最終結果

報告：
- [W1 Root-Cause & Supported-Workaround Review](reports/W1_ROOT_CAUSE_REVIEW_CODEX.md)
- [W1 Supported-Workaround Gate Result](reports/W1_SUPPORTED_WORKAROUND_RESULT.md)

- Supported workaround **A4 + A5 = FAILED**。
  - A4：Conductor 以 `CREATE_SUSPENDED` 啟動 AionCore，assign 到 `KILL_ON_JOB_CLOSE` Job，並加上 desktop policy `2`，再 resume。
  - A5：Task Cancel 改用 `/runtime/restart`。
- 逃逸點：packaged `pwsh.exe` 在 `cmd → pwsh` 這條邊離開 Conductor Job（`inOwnedJob:false`，`inAnyJob:true`）。policy 0 與 policy 2、完整路徑與 App Execution Alias 的 edge probe 全部逃逸。
- `/runtime/restart` 只重啟單一 conversation：另一個 conversation 的 process identity 全部保留，下一輪也成功。
- Restart 後 session resume **PASS**：新 Claude 以 `--resume <same session id>` 啟動，並答對前一輪給的 codeword。
- Orphan `leaf` 與 immediate grandchild `igc` 在 restart 後**仍然殘留**，關閉 Conductor Job 後也還在。
- AionCore 保持健康、worktree 保留、global/user 設定沒有 drift。
- Native（unpackaged）PowerShell 的 AionCore end-to-end 測試：**NOT_TESTED**。AionCore 會自己重建 PATH，Claude 也沒有 supported 方式可以指定 PowerShell executable。要強制 native shell 只能修改 user/system PATH，這次禁止。
- **W1 verdict = `UPSTREAM FIX REQUIRED`**

## 3. 下一步

**Fix Ownership Review**：判斷 W1 的修正應該由誰負責：
- AionCore：例如 managed spawn 的 `CREATE_SUSPENDED`、cancel 時 teardown session Job；
- Claude Code：例如 PowerShell executable 的選擇與 launcher；
- 兩者都要；
- 或改用其他 Windows containment mechanism。

前提：packaged shell 的 activation 逃逸，只修 AionCore 無法單獨解決。這一點是 INFERENCE，見 result 報告 §7。

交接時**尚未開始**這項 review。也沒有建立 upstream issue/PR，沒有 patch AionCore。

## 4. 交接時的版本

| 元件 | 版本 |
|---|---|
| AionCore | `v0.2.2`（tag → `47e66d0d151123e973b3fd1e77afcb5671b3f8c5`）。Windows binary SHA-256 `67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892` |
| Claude Code | `2.1.290`（AionCore 已驗證的版本是 `2.1.236`，會回報 `CLI_VERSION_NEWER`） |
| Codex CLI | `codex-cli 0.160.0` |
| Node.js | `v24.16.0` |
| PowerShell | pwsh `7.6.6`（Microsoft Store packaged，`Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe`）。Windows PowerShell `5.1.26100.9444` |
| Git | `2.54.0.windows.1` |
| OS | Windows 11（NT 10.0.26200） |

家中電腦版本不同時，先記錄差異，不要假設行為一致。W1 的結果特別依賴 PowerShell 是不是 packaged 安裝。

## 5. 沒有上 GitHub 的內容

以下內容依 `.gitignore` 刻意不版本化，家中電腦**不會有**：

| 內容 | 原位置（repo 相對路徑） | 說明 |
|---|---|---|
| P0 / W1 raw evidence | `reports/evidence/`（含 `w1-review-20261006/`、`w1-workaround-20261006/`） | logs、API traces、process topology JSON、diagnostic scripts、harness（`w1w.mjs`、`runner.ps1`、`topo.ps1`、`tree.mjs`）。可能含本機路徑與 session id |
| AionCore binary 與 runtime data | `runtime/` | 包含 `aioncore.exe`、disposable data/work dirs、approvals |
| Sandbox repos / worktrees | `p0-sandbox/` | disposable 測試 repo |
| Isolated CODEX_HOME 與 credentials | 不在 repo | 不搬 |

另有既存、未追蹤也未提交的 `spikes/` 與 `fixtures/`（不是本次交接建立的）。要不要版本化，由維護者另外決定。

### 回家後若需要重現

- 不要依賴辦公室的絕對路徑（`E:\CodexProject\...`）。報告中的 evidence 連結是 repo 相對路徑，在家中電腦上不存在是正常的。
- 重新下載 AionCore `v0.2.2` binary，並驗證上面的 SHA-256 後才使用。
- 在新的空目錄重新產生 evidence。不要覆寫或沿用舊 evidence。
- 需要 W1 harness 時，依兩份報告描述的方法重寫，或由維護者另外把它從辦公室帶出。目前 harness 只存在於辦公室的 `reports/evidence/`。
- 只在 disposable repo 上測試，所有 env 只設在 child process，不修改 global/user 設定。
