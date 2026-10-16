# Studio 審查修正批次

更新日期：2026-10-16。審查基準：`4c88c60`。沿用既有架構，不覆蓋其他 Agent 的修改；未授權 commit、push 或重啟使用中的 Studio。

## 第一批：可信的結果與分工 — 完成

- [x] 缺少有效 STATUS、工頭 JSON 欄位不合法時，不判定完成。
- [x] 唯讀切換同步角色、對話與租約，先確認舊執行停止。
- [x] 工作卡依賴與等待循環回交工頭，不放行交付。
- [x] 阻止自審，包含歷史作者與間接依賴。
- [x] 無 Studio 歷史時仍可接續專案現況。
- [x] lifecycle 30–34 回歸案例及 `scripts/ci.ps1 -Mode Full` 通過。

## 第二批：安全停止與清理 — 完成

- [x] worktree 清理：查核失敗保留；當前 HEAD 必須有交付證據；不用強制刪除；分別確認 worktree 與 branch 清理結果。分支以驗證過的 commit 比對刪除，保留並行移動的分支。
- [x] 租約／工作區鏡像鎖：存活持有者不能因心跳逾時被接管；未知狀態保留所有權。相同工作快照也不能接管另一個存活實例；手動釋放不能繞過 RESERVED。
- [x] 設定與工作紀錄採原子 JSON 寫入，失敗保留上一份資料。
- [x] 同一 runtime 僅允許一個 Studio 實例，避免設定與排程互蓋。
- [x] 對應回歸測試與 `scripts/ci.ps1 -Mode Full` 全部通過。日誌：`runtime/audit-20261016/batch-2-ci.log`。

測試調整：舊案例原本允許存活 PID 因心跳過期而被接管，已改為確認死亡的 PID。真實 Git／程序等待上限由 12 秒調為 30 秒，完成條件不變；Windows 雙程序鎖競爭的測試子程序對暫時 EPERM/EBUSY 有限重試，仍斷言只能有一位寫入者。相關競爭另連續三次通過。正式程式遇到無法取得的鎖仍拒絕寫入。

## 第三批：真實 Agent 驗證 — 完成

僅使用新建的拋棄式專案與獨立 `STUDIO_RUNTIME`，不得拿正在使用的專案、工作卡、程序或設定做測試。保存測試步驟、檔案狀態、HTTP 回覆與程序身分證據，不保存憑證。

- [x] 真實交接：Claude → Antigravity、Claude → Codex 均確實啟動新工具程序；最新補驗也通過 Codex 工具執行中直接交回 Claude，接手程序確認前任已退出。
- [x] Studio 重啟後的工作與租約恢復：保留 PAUSED／RESERVED 與檔案，沒有自行恢復執行。
- [x] 中文路徑與 Agent 工具執行：Claude、Antigravity、Codex 均有實際執行與 PID 證據。
- [x] 取消後的工具子程序殘留：Claude／Antigravity 與登記 backend 通過；Codex 原本失敗的 `exec_command` 子程序已修復並真實補驗通過，確認原程序樹退出後才允許交接，另一個 Codex 對話保持存活。
- [x] 正式 runtime API 的 smoke 資料與連接埠隔離：要求 3018 時改配 3020；測試檔只寫入新建 temp data，暫停後 backend 與 temp 目錄都清除，原資料 sentinel 保留。
- [x] 彙整實際通過／失敗／未驗證項目；已修正本批直接揭露的 smoke API 缺陷並補回歸測試、跑完整 CI。

修正前的真實證據：`runtime/audit-20261016/live-BOaCif/evidence.json`。正式 API 原本只保存 `purpose=smoke` 標籤，仍使用呼叫者的資料目錄；此項確實失敗。現已接上既有 `createSmokeEnvironment`，補上隔離／恢復／啟動失敗與寫入權變更清理的回歸案例；修正後 `scripts/ci.ps1 -Mode Full` 已通過，日誌為 `runtime/audit-20261016/batch-3-ci.log`。

修正後真實證據：`runtime/audit-20261016/live-Y9cQsL/evidence.json`，2026-10-16 15:58（台灣時間）完成。17 個檢查 PASS、3 次 provider 狀態觀察、1 個 Codex coverage BLOCKED，沒有 FAIL。三次測試 Studio 的程序樹清理均 PASS，未操作原本使用中的 Studio。重現腳本保存在 `runtime/audit-20261016/verify-live.cjs`，會建立全新 fixture，使用真實 provider；不放入一般 CI。因 Codex 受阻，真實驗證整體保持非零結束狀態，不宣稱所有 provider 通過。

前輪 Codex 的可用性探測回覆 `The model provider rejected the request`，當時尚未確認拒絕原因，故保留為受阻。下列補驗已修復登入問題，並進一步發現工具停止缺口。全程沒有手動修改帳號或複製憑證；不得將部分工具的取消成功推論為所有 provider／程序都已涵蓋。

### 前次 Codex 補驗（16:12）：登入修正完成，發現程序停止缺口

- 原 AionCore 日誌實際記錄 `401 Unauthorized: Missing bearer or basic authentication in header`；`codex login status` 在舊測試 home 回覆 `Not logged in`（exit 1），在原 Studio 專用 home 回覆 `Logged in using ChatGPT`（exit 0）。原因是每次隔離測試新建 `STUDIO_RUNTIME`，連帶選到沒有登入狀態的新 Codex home；不是已確認的模型權限／配額問題。去除敏感資訊的診斷紀錄：`runtime/audit-20261016/codex-diagnosis.json`。
- 最小修正：新增明確的 `STUDIO_CODEX_HOME` 覆寫；未設定時維持原本每個 runtime 獨立的 home。Agent 啟動、登入、額度讀取及錯誤診斷都沿用同一值，沒有複製或輸出憑證。此選項會共用指定 home 的 Codex 設定、登入與 session 紀錄；工作卡、租約及測試資料維持獨立。
- 可用性檢查遭拒時，以 CLI 確認是否未登入，再顯示具體處理方式；已登入、配額或其他失敗不冒充登入問題。回歸案例也涵蓋舊診斷不得覆蓋較新的檢查結果。
- 補驗使用 `STUDIO_CODEX_HOME=E:\CodexProject\multi-agent-platform\runtime\studio\codex-home`，執行既有 `runtime/audit-20261016/verify-live.cjs`，2026-10-16 16:12（台灣時間）結束。證據：`runtime/audit-20261016/live-RV02jd/evidence.json`，17 PASS、3 次 provider 狀態觀察、1 FAIL、0 BLOCKED；腳本 exit 1，未把失敗改為通過。三次啟動中的三個 provider 全部 available；Claude → Codex 真實交接、Codex 中文路徑工具執行、smoke 隔離清理、暫停後重啟與資料保留均通過。
- **當時發現的缺口**：Codex 的 `exec_command` 啟動 worker PID 25916；AionCore cancel 回覆 HTTP 200，Codex 記錄 `turn_aborted: interrupted`，但該程序仍存活。Studio 的 `stopTurn()` 只確認 conversation idle，而 runtime registry 僅清理登記的程序；這是不同於登入的程序停止問題。本次測試核對 executable 與建立時間後已清理該 worker，三次測試 Studio 程序樹也都清理成功。獨立證據：`runtime/audit-20261016/codex-cancellation.json`。
- 當次修改範圍為 provider 登入原因、設定與診斷，沒有藉此新增跨 provider 的 OS 程序追蹤機制。當時第三批尚未全數通過；下節記錄後續完成的工具停止修正，不再只靠 turn 中斷放行交接。
- `node studio/test-codex-provider.cjs` 與 `scripts/ci.ps1 -Mode Full` 均通過，日誌：`runtime/audit-20261016/batch-3-codex-ci.log`。CI 使用可控制的 fixture，因此與本次真實 Codex 程序停止失敗分開呈現。
- 登入儲存方式參考 [OpenAI 官方文件](https://learn.chatgpt.com/docs/auth#credential-storage)。此處的實際原因另由本機日誌與 CLI 狀態交叉確認。

### Codex 工具停止修正（2026-10-16 17:04，完成）

- 沿用 AionCore 的單一對話 `runtime/restart` 與既有 runtime registry；新增 `studio/codex-runtime.mjs`，只辨識本 Studio 所啟動的 Codex session。初始化／重建序列化，候選不唯一、程序身分不明或 CIM 查詢失敗時不允許工具繼續執行。
- 回合結束及暫停／停止／交接前，先保存 PID、建立時間與程序樹，透過原生 Windows Job Object 結束舊 runtime，再確認已記錄程序全部退出。失敗會保留 `stopping` 紀錄、子 PID 及寫入租約；完成判定、唯讀切換和外部接管共用既有 drain 路徑。停止同一個 session 的重複呼叫會合併，避免重建兩次。
- `test-codex-runtime.cjs` 覆蓋退出確認、子程序殘留、PID 重用、查詢／身分欄位失敗、重試、舊 AionCore 身分、其他對話與重複停止；`test-runtime-server.cjs` 覆蓋未確認停止不得交接、完成卡不得放掉寫入權，以及停止確認中的交接順序。舊 lifecycle／lease 測試擷取環境已同步更新；遇到 already-running 而重送訊息時，也重新登記新回合，避免漏掉重建後的工具程序。
- 真實重現腳本另存 `runtime/audit-20261016/verify-codex-stop.cjs`，保留前輪腳本與失敗證據；增加 Codex 工具仍活著時直接交接、接手程序自行確認前任已退出，以及另一個 Codex 對話存活的檢查。所有 worker 都有 120 秒上限，超過上限不當成取消成功。
- 第一輪 `live-ZOcgeV/evidence.json` 的 Codex 暫停已通過，但拋棄式工作卡累計 28,046 tokens 超過原本 20,000 上限，後續直接交接與重啟檢查失敗（16 PASS、3 OBSERVED、2 FAIL，exit 1）；保留原始證據。測試卡改為 100,000 上限，明確要求每次恢復時依 marker 重跑；PID／tick 標記列入 fixture 的 Git exclude，避免測試本身的控制檔變更觸發外部寫入警報。正式專案的 token 上限與設定未改動。
- 最終真實證據：`runtime/audit-20261016/live-MCZ6zL/evidence.json`，2026-10-16 17:04:17（台灣時間）完成，**21 PASS、3 OBSERVED、0 FAIL、0 BLOCKED，exit 0**。Codex 暫停、執行中直接交回 Claude、接手程序確認前任 PID 42572 已退出、其他 Codex 對話存活、重啟後 PAUSED／RESERVED 與檔案保留均通過；三次測試 Studio 程序清理全數 PASS。清理只處理本次已核對建立時間與 executable 的程序。
- 最終 `scripts/ci.ps1 -Mode Full` **PASS，exit 0**；日誌：`runtime/audit-20261016/batch-3-tool-stop-ci.log`。保留前次執行日誌，沒有覆蓋前兩批或登入補驗的證據。
- 原生停止介面依據：[AionCore v0.2.2 conversation service](https://github.com/iOfficeAI/AionCore/blob/v0.2.2/crates/aionui-conversation/src/service.rs) 與 [Windows Job Object 實作](https://github.com/iOfficeAI/AionCore/blob/v0.2.2/crates/aionui-process/src/process.rs)。此護欄目前限定 Windows；每次 Codex 回合結束會多一次 CLI 重建。使用中的 Studio 未重啟，新程式在下次啟動生效。

## 保存與交付

- 起始工作目錄已有第一批的 `studio/server.mjs`、`studio/lifecycle-check.cjs` 修改，以及其他 Agent 的 `studio/.claude/`；全部保留。
- `studio/index.html`、`fixtures/`、`spikes/` 維持原樣。
- 每批完成時更新本檔的實際結果與證據位置，保留批次差異快照，不自行提交 Git。
- 第一批快照：`runtime/audit-20261016/batch-1.patch`。第二批：`batch-2-cumulative.patch`、`batch-2-files/` 與 `batch-2-ci.log`，均位於同一目錄；cumulative patch 以審查基準為起點，包含之前批次，新增檔另存快照。
- 第三批：同目錄的 `batch-3-cumulative.patch`、`batch-3-files/`、`batch-3-ci.log` 與上述真實測試目錄。`runtime/` 是本機忽略目錄，原始證據與差異快照不會自動隨 Git 提交；本檔則是可提交的批次索引。
- Codex 補驗保存為 `batch-3-codex-cumulative.patch`、`batch-3-codex-files/`、`batch-3-codex-ci.log` 與上述兩份診斷 JSON；補驗前另存 `batch-3-before-codex.patch`，不覆蓋先前批次快照。
- Codex 工具停止修正保存為 `batch-3-tool-stop-cumulative.patch`、`batch-3-tool-stop-files/`、`batch-3-tool-stop-ci.log` 與兩輪真實證據；修正前另存 `batch-3-before-tool-stop.patch`。
- 其他 Agent 的 `studio/.claude/progress.md` SHA256 維持 `216C95F44E80BE83CCA8A96D75DF0D9F2C4CC1AAC1E27FC32C121D623298F039`。沒有 commit／push，也未執行遠端 GitHub CI；本文 CI 結果均指完整本機腳本。
- 原審查的效能、重複測試、API 逾時、預算說明與廣泛拆檔建議，不因本次修正一併擴張；第三批若直接被阻塞，再記錄並處理必要項目。
