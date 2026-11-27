# W1 managed-process 部分修復（受控修補包）

**W1 尚未解決。正式 Studio 仍使用官方 AionCore v0.2.2，這份修補不會自動套用或替換正式 binary。**

本文件中的 **Store PowerShell** 指 Microsoft 發行的 MSIX 版 PowerShell 7（`pwsh.exe`）。這描述的是使用者選用的 shell。Studio 可繼續用原有方式執行，無須上架 Microsoft Store。

## Studio 直接啟動的封裝 PowerShell

Windows 上，`POST /api/runtime/start` 與 backend 自動恢復都透過 `spawnManagedProcess`。直接指定 WindowsApps 內的 PowerShell 安裝路徑或已登記的執行別名時，Studio 使用 Windows 隨附的 .NET Framework 編譯一次性的 Job 持有程序。啟動握手透過本機 named pipe，helper 核對 Studio PID，Studio 核對本次隨機交握值，之後才傳入目標參數與環境。登記檔沿用原有的敏感參數省略規則。

持有程序以 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 和 `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` 建立使用者指定的 shell。在其主執行緒仍暫停時，以同一程序 handle 確認 Job 成員、映像路徑與建立時間。Studio 記錄實際 shell PID 後才允許執行。缺少編譯器、原生 API、Job 或可驗明的程序身分時，啟動會報錯。這條路徑管得到 Studio 直接建立的 shell；Claude 或其他工具另行建立的 shell 仍待上游處理。[Microsoft 的啟動屬性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

Studio 關閉後，Job 持有程序繼續監看根 shell。收到停止要求或根程序自行結束時，它回收該 Job 的剩餘工作，從原 Job handle 確認 `ActiveProcesses == 0`，再將根 PID 與實際退出碼原子寫入 registry 旁的 `studio/shell-jobs/<uuid>.drained`。重開 Studio 可讀回憑證並回收暫存 helper，再清理工作資料。若異常斷電、helper 提前結束或收據損壞，清理會回報受阻，保留資料與寫入租約；只有原 Job 產生的匹配收據能讓此處自動完成。沒有該證據時須人工核對。本機 registry 與收據沿用 Studio 對同一 Windows 帳號的信任邊界。[Microsoft 的 Job 計數定義](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)

2026-11-27 在 Windows 本機執行 `node studio/test-managed-shell.mjs`。測試經實際的 managed runtime 啟動處理函式，關閉原 Studio 測試程序後，從第二個程序讀取同一份登記檔確認 loopback port、根 PID 及 Job 所屬。每個 backend 都有一項獨立的背景工作。

| 執行方式 | 已驗證結果 |
| --- | --- |
| 傳統 Windows PowerShell 5.1 | 專用原生控制組確認 Job、重連與自然退出碼 42。正常 Studio 對傳統 shell 維持原啟動方式。 |
| Microsoft Store PowerShell 7.7.0 安裝路徑 | shell 驗明在指定 Job，逐字讀回含空白、Unicode、雙引號與尾端反斜線的獨立 argv。自然退出碼 42；背景工作一併回收。 |
| 該版本的 WindowsApps 執行別名 | 相同 argv、PID 與 Job 驗證通過。重連後停止 Job，讀回退出碼 1，確認 root 和背景工作均結束。 |
| 登記失敗或缺收據 | 登記被拒時清除暫存 helper；缺少排空證據時，保留測試資料並回報清理受阻。 |

手動 Windows CI 另列此項驗證。設定 `STUDIO_REQUIRE_STORE_TEST=1` 時，缺少 MSIX 安裝路徑或無法完成該路徑的測試會直接失敗。Runner 沒有註冊別名時單列 `stop-alias NOT TESTED`；Win32 控制組獨立執行。

## Windows 內建 Claude 的取消與對話恢復

Windows Studio 取消內建 Claude 工作時，先等同一對話已送出的訊息取得回應，再從 AionCore v0.2.2 的 SQLite 資料庫唯讀取得該對話的 Claude session ID（使用 Node.js 22.13 或更新版本）。Studio 記下 AionCore 直接啟動、帶有該 ID 的原生 `claude.exe` 及當時可辨識的子程序，取消當前回合並只重啟該對話。原 PID 與建立時間都已退出、新 CLI 使用原 ID 的 `--resume` 且對話回到可用的閒置狀態後，才確認停止。待確認紀錄存在 `runtime/studio/claude-stops/`，重試會核對先前看到的程序。身分、送信結果或恢復狀態無法確認時，Studio 保留寫入租約。

自動驗收使用正式 AionCore、隔離的本機模擬 Claude CLI 與兩段獨立對話。它檢查普通 Windows 子程序退出、新 CLI 讀回上一輪的隨機值，以及另一段對話持續可用。獨立的 ACP 測試驗證原訊息 ID 與 `session/load`。這些測試沒有呼叫雲端模型。取消前已脫離可辨識樹的程序、CLI 包裝器，以及真實 Claude 間接啟動的 Store PowerShell 仍缺完整隔離證據；故 #1 維持開啟。

## 停用 Studio 的內建 Claude Code

在 PowerShell 設定 `$env:STUDIO_DISABLE_BUILTIN_CLAUDE='1'`，從同一視窗執行 `.\start-studio.cmd`。Studio 啟動時讀取這個值；未設定或設為 `0` 會使用原有席位。啟用後，啟動探測、額度查詢、登入與既有對話送出工作都會被略過或拒絕。以該席位為工頭的定時工作會記錄未啟動原因；歷史工作若還有該席位的未完成卡片，會維持暫停並提示先改派。

此設定只約束 Studio 內建 Claude 席位。自訂 ACP、專案設定的命令與其他 Agent 仍可啟動其可用的工具。正式 v0.2.2 的命令列提供父程序監看與資源來源選擇；截至 2026-11-27，發行版及其命令列均未提供可據以認定 Store PowerShell 完整隔離的選項。[上游正式版](https://github.com/iOfficeAI/AionCore/releases/tag/v0.2.2)

## 單獨驗證正常直接子程序

在獨立 checkout 的固定版來源依下節順序套用兩個 patch 後，在該 checkout 執行 `cargo +1.95.0 run --locked --release -p aionui-process --example w1_managed_smoke`。這個 example 只啟動傳統 Win32 PowerShell 及一個短命令，不使用模型。它驗證直接子程序正常退出碼為 42，再等另一個子程序輸出就緒訊號，要求停止，並觀察同一個 Windows 程序 handle 在期限內轉為已退出。驗收輸出應包含 `W1_MANAGED_SMOKE`、`W1_MANAGED_STOP` 的 `handleSignaled=true` 和 `W1_ORDINARY_SMOKE PASS`。

這條路徑實際使用修補候選的 release 程序庫。它的覆蓋範圍限於正常直接子程序；Store PowerShell、Claude 本體和重啟後的 session 恢復需要各自取得驗收證據。

### 2026-11-27 完整應用與 ACP 實測

在獨立暫存 checkout 套用兩份 patch，以 Rust 1.95.0、`RUSTFLAGS=-C target-feature=+crt-static` 和 `cargo build --locked --release --target x86_64-pc-windows-msvc -p aionui-app` 建置完整候選。該次 `aioncore.exe` 的 SHA-256 為 `1cec1ffdc525feffb2118f2fe2442ace2369d1f6f6b27a3583fa0a8075e6532d`。所有 ACP 案例均先核對該值，再用全新暫存資料庫、loopback、臨時登入及本機 Node fixture 執行。外部模型請求數為 0。

| 對象 | 實測操作 | 觀察結果 |
| --- | --- | --- |
| 完整候選與 Win32 直接子程序 | 登入並讀取 provider 清單，另執行上述 release 程序庫 example | API 回應成功。傳統 PowerShell 正常退出碼 42；另一個子程序輸出就緒後被主動停止，退出碼 1，同一個 Windows handle 確認已退出。 |
| 既有 `studio/fixtures/contract-acp.cjs` | 建立對話、取得 OK、取消執行中的工作，再用同一 session 要求 OK | 收到 ACP `session/cancel`，狀態回到 idle，原 fixture 程序完成第二次回覆。 |
| 同一 fixture，未宣告 `loadSession` | 呼叫 `runtime/restart` 後，在原 conversation 送出下一輪；另開新 conversation 作對照 | 舊程序退出、新程序初始化、原兩筆回覆 ID 保留。原 conversation 的下一輪回報 `The selected Agent does not support this operation`，未收到新的 OK。另開的新 conversation 正常回覆 OK。 |
| 宣告 `loadSession: true` 的暫存 fixture | 記錄一個隨機測試值，重啟 runtime，再請新程序讀回該值 | 新程序收到原 sessionId 的 `session/load`，未收到 `session/new`。回覆與原測試值逐字相符，舊程序已退出、歷史回覆 ID 保留。 |

兩種 ACP 測試結束時，均核對已記錄的測試程序身分並確認退出。上述差異可用於判斷自訂 ACP 的恢復能力。正式 Studio 目前使用官方 SHA-256 `67eb02774bab3855b759ec9756c2e540cd17b64b850407fa4b8bad07fd8a0892`。Store PowerShell 程序隔離、真實 Claude 取消與 session 恢復仍待驗收。

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
