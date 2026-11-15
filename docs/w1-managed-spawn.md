# W1 managed-process 部分修復（受控修補包）

**W1 尚未解決。正式 Studio 仍使用官方 AionCore v0.2.2，這份修補不會自動套用或替換正式 binary。**

## 修復邊界

來源固定為 AionCore `47e66d0d151123e973b3fd1e77afcb5671b3f8c5`（v0.2.2）。`patches/aioncore-v0.2.2/` 包含兩個依序套用的 patch：

1. `regression-tests.patch`：先加入實際 Windows 程序 fixture、受控排程／原生 API 故障注入，以及非 test 組態的 smoke executable。只加測試觀測點，不修改原始 production 行為。
2. `managed-spawn.patch`：只修 managed-process 建立與 Job 指派的時序、失敗回收及 resume 錯誤處理。

原始 `ManagedProcess::spawn` 註解說 child 已 suspended，但 Windows `configure_platform_spawn` 是空函式，實際先執行一般 `spawn` 才指派 Job。測試在這個真實排程窗口讓 child 執行，舊版可建立不屬於目標 Job 的後代。

修補內容：

- 新增 Windows-only `Builder::spawn_suspended`，只由有 paired assign/resume 的 `ManagedProcess` 呼叫。普通 `spawn`、`output`、版本查詢等路徑維持原樣。
- 順序為 `CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread`，成功後才交付 stdio。
- Job 建立／設定／指派或 resume 失敗時，回報原始錯誤並 `child.kill().await`，在返回失敗前回收直接 child。Job、thread snapshot 和 thread handles 依既有 RAII／關閉路徑釋放。
- 無法開啟 thread、resume 失敗、沒有可 resume 的 thread、非預期 suspend count 或列舉錯誤，均 fail closed。ResumeThread 的錯誤在 CloseHandle 前擷取。
- 沒有新增 breakaway、程序名稱清理、程序樹輪詢或 shell 替換；沒有修改 cancel／restart 語意。

production 錯誤沿用既有錯誤回傳；不新增全域設定、遙測或敏感命令日誌。PID、creation FILETIME、image 和指定 Job 成員的詳細證據只由測試輸出。

## 使用與 Windows CI

需要 Git、Rust **1.95.0**、MSVC C++ Build Tools／Windows SDK。執行：

```powershell
.\scripts\test-w1-managed-spawn.ps1 -EvidenceDir "$env:TEMP\w1-evidence-unique"
```

`EvidenceDir` 必須不存在。預設從官方 GitHub 取得精確 commit，獨立 checkout 到新暫存目錄；不碰 `runtime/aioncore-src` 的工作樹。若本機已有來源，可將它當唯讀 clone 來源：

```powershell
.\scripts\test-w1-managed-spawn.ps1 `
  -SourceRepo '.\runtime\aioncore-src' `
  -EvidenceDir "$env:TEMP\w1-evidence-another-unique"
```

腳本會：

1. 驗證來源 commit，先套測試 patch。
2. 要求舊版 race test 以「child 在 Job 指派前執行」的實際 invariant 失敗。編譯錯誤、fixture 沒啟動等，不算有效失敗基線。
3. 執行舊版 classic／Store 完整路徑／Store alias 矩陣；每種各含正常 parent 與提前退出 parent，fixture 另有立即產生孫程序、延遲退出 parent、orphan leaf。使用含空白及中文的暫存路徑。
4. 執行原始 runtime 完整 suite，保留其 Windows 失敗。
5. 套 production 修補，執行 process suite、相同 shell 矩陣、相同 runtime 完整 suite；任何新增或改變的 failing-test 集合會阻擋此 gate。
6. 執行未啟用 `cfg(test)`／故障注入的實際 smoke binary，觀察 classic PowerShell 經 managed spawn 返回 exit code 42，以及普通短命令正常結束。

`result.json` 的 `fullW1Pass` 固定為 false。`runtimeSuites.fullSuitePass` 如為 false，表示完整上游 runtime suite **沒有通過**；不得將「與基線相同的失敗集合」描述為全套 PASS。本機原始／修補後皆為 80 passed、13 failed，含缺少 `sh`、Unix 格式預期及 fake Node 安裝 fixture 的 Windows 不相容情況；未修改或排除這些測試。CI 的失敗集合可能依 runner 環境不同，仍逐輪比較並上傳完整兩份日誌。

CI 的 `W1 managed-spawn partial fix (no models)` job 執行同一入口並上傳 `w1-managed-spawn-evidence`。Hosted runner 如沒有可啟動的 Store package，Store 案例必須明記 `NOT_TESTED`，不是 PASS。既有 Studio CI 獨立執行，不被此 patch 替代。

腳本保留 disposable source／target 供檢查；位置寫入 `result.json`。它不會編譯或安裝完整 AionCore 服務，也不會將產物複製到正式 `runtime/`。手動升格到上游或受控 fork 前，仍須完整應用編譯與 caller 相容性驗收。

## 已觀察到的結果

原生 `aionui-process` suite：17 passed、2 ignored。兩個 ignored 入口是供子程序呼叫的有限 fixture 和由腳本明確執行的 shell 矩陣，不是默默跳過的驗收。

- 舊版：race test 實際失敗；child 能在指派前執行並留下指定 Job 外後代。
- 修補後：race test 通過；assign／resume 失敗時 child 已回收、普通短命令不掛起、parent 提前退出後 Job close 清理後代，均通過。
- 非 test 組態 smoke：managed PowerShell 的實際 image、PID、FILETIME 與 exit 42 已觀察；普通短命令通過。
- classic PowerShell：修補前後、兩種 parent 情況，關閉 Job 六秒後都無殘留。
- Store PowerShell 7.7.0 的 alias／完整路徑：修補前後都仍有 Job 外後代。正常 parent 案例六秒後仍有 root／sleeper／leaf／igc；提前退出 parent 案例仍有 sleeper／leaf／igc。這是**明確未修復的限制**，不是測試成功。

fixture 自然壽命 16 秒；故意重現的殘留只經 retained process handle 清理。採用 marker 的 PID＋完整 creation FILETIME 確認身分，不以 PPID／名稱猜測所有權。已退出的 mid／imm 不補造 Job 查詢結果。

## Claude 真正 shell 啟動層

[官方環境變數契約](https://code.claude.com/docs/en/env-vars)確認：

- 預設 PowerShell tool 透過 `cmd.exe` launcher；`CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER=1` 改成直接啟動 PowerShell，並改變背景命令跨 session process 的延續行為。
- `CLAUDE_CODE_PROCESS_WRAPPER` 在 Windows 被忽略。
- `CLAUDE_CODE_SHELL` 只控制 Bash tool 的 bash／zsh；`SHELL_PREFIX` 沒有提供 PowerShell tool 建立時的 Job／desktop-policy 契約。

AionCore 的 Claude adapter 建立的是 Claude executable，不是它後來建立的 PowerShell tool process。這輪沒有重試模型、反編譯／修改 Claude 封閉 binary，也沒有 ETW／syscall trace；因此未新增證據判定封裝 activation 的實際 broker、CreateProcess flags 或目前 Claude 版本的完整工具程序鏈。

先前非 AppContainer 桌面證據顯示：只在祖先 cmd 設 policy 2 仍逃逸；在**真正建立封裝 shell 的啟動點**設定 policy 2 並明確指派 Job，原生 fixture 才能保持 containment。這份部分修補沒有取得那個 shell 啟動點的控制權，不能單靠它宣稱 W1 修好。相關 API：[UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。

## 額度重置後待驗證

本輪模型請求數為 **0**。以下逐項待驗證，不以 fixture 或閒置 runtime 控制代替：

- [ ] 修補版 AionCore → Claude → 實際 PowerShell tool 的建立鏈及逐層 Job 身分。
- [ ] 活動工具的 cancel：指定 session 的所有後代結束，不只是 runtime idle。
- [ ] 活動工具的單對話 restart：無孤兒程序、其他對話程序身分及工作區不變。
- [ ] 正常關閉／Job owner 關閉時的完整清理。
- [ ] 同一 backend session 的歷史／記憶恢復，而不只是重建一個 idle CLI。
- [ ] Codex／其他 managed-process caller、`.cmd` agent 及完整 AionCore 應用建置的相容性。

Issue [#1](https://github.com/nanachi1212/multi-agent-platform/issues/1)維持開啟。這份修補可供 upstream／受控 fork review 與重現，不自動部署、不自動合併。
