# Runtime Ownership, Readiness & Test Isolation (Workstreams B+C+D)

本文件說明 Multi-Agent Studio 的 **Runtime Ownership Registry**、**程序樹生命週期清理**、**連接埠所有權（Port Ownership）檢查** 與 **測試／煙霧測試環境隔離（Test/Smoke Isolation）** 架構。

---

## 1. 架構概述與職責解耦

Multi-Agent Studio 管理多個 Agent、背景進程與測試執行。為確保背景程序不相互干擾、系統當機後可安全清理殘留資源，並防止測試程序搶佔正式環境資料庫或鎖，由以下模組統一負責：

- **`studio/runtime-registry.mjs`**：
  - 持久化記錄 Studio 啟動的所有長時間程序（`runtimes.json`）。
  - 提供作業系統層級（Windows PID Tree）的進程管理與清理（只逐一終止已驗證的 PID，不用 `taskkill /T`，**禁止依名稱 `Stop-Process -Name python/node` 殺程序**）。
  - 啟動與掃描時自動清理確認 stale 的程序與殘留暫存目錄（具備 PID 重複使用安全防護）。
  - 連接埠所有權檢查：**未知 process 絕不 kill**，精確回報 PID、指令、連接埠與鎖狀態。

- **`studio/isolated-env.mjs`**：
  - 專門為 Smoke／整合測試分配隔離的暫存環境 `%TEMP%\MultiAgentStudio\<project>\<run-id>\data`。
  - 將隔離目錄注入為環境變數 `DATA_DIR`，使檔案鎖（如 `mining_process_lock`）、快取與狀態與正式目錄完全分離。
  - 動態配置測試用連接埠（避開正式環境的 3018 與 3011），執行完畢後自動清理暫存目錄。
- **`studio/runtime-readiness.mjs`**：
  - `BACKEND_READY` 必須同時滿足已登記 PID 存活、連接埠可連線、`GET /health` 回 HTTP 200，以及 response `ready: true`、`status: "ready"` 或既有 TWstock `/health` 的 `status: "ok"`；明確 `ready: false` 或 startup error 一律拒絕。程序身分與 listener owner 也必須相符。
  - 健康端點回報的 `error`、`reason` 或 `detail` 會保留在 blocked 原因中，例如 `MiningProcessLockError`。
  - 自動恢復只處理明確標記為 Studio 建立、restart command／data owner 已確認且不需帳密的 runtime；依序 cleanup、restart、readiness、smoke，再喚醒原卡。未知 owner、PID、data owner、命令或需要憑證時停止並回報具體原因。

---

## 2. 資料模型（`runtimes.json`）

持久化於 `runtime/studio/runtimes.json`，格式如下：

```json
[
  {
    "runtime_id": "rt_1762500000_abc123",
    "job_id": "20261007183000-abcd",
    "card_id": "card-1",
    "workspace": "E:\\CodexProject\\MyProject",
    "purpose": "dev_backend",
    "root_pid": 12345,
    "child_pids": [12346, 12347],
    "executable": "python.exe",
    "command": "python -m uvicorn app.main:app --port 3028",
    "args": ["-m", "uvicorn", "app.main:app", "--port", "3028"],
    "cwd": "E:\\CodexProject\\MyProject",
    "created_by": "studio",
    "restart_safe": true,
    "port": 3028,
    "data_dir": "C:\\Users\\User\\AppData\\Local\\Temp\\MultiAgentStudio\\MyProject\\run-1\\data",
    "temp_dir": "C:\\Users\\User\\AppData\\Local\\Temp\\MultiAgentStudio\\MyProject\\run-1",
    "started_at": "2026-10-07T10:30:00.000Z",
    "heartbeat_at": "2026-10-07T10:30:20.000Z",
    "status": "running"
  }
]
```

- `purpose` 包含：`dev_backend`、`frontend`、`smoke`、`test`、`preview`、`helper`。
- `status` 包含：`running`、`stopped`、`stale`、`cleaned`。
- `restart_safe` 只有在啟動參數已保存、`DATA_DIR`／`PORT` 可安全重建且不需要帳號憑證時才可為 `true`。任意環境變數及 credentials 不會持久化。

---

## 3. Readiness 與恢復 API

- `POST /api/runtime/start` 只接受持有 write lease 的進行中工作卡、絕對 executable、字串 args 與工作區內的 cwd；Studio 直接啟動並登記 PID。一般 runtime 須明確指定工作區內既有的 `dataDir` 與 `port`；`purpose: "smoke"`／`"test"` 改由 Studio 配置隔離資料與連接埠。
- `POST /api/runtime/readiness` 以 `runtimeId` 查詢 readiness；`GET /api/runtimes` 與 `/api/state` 也提供 runtime readiness。
- 只有專案頁設定了「驗證用後端 port」（例如 3018）時才啟用：一般 `WAITING_EXTERNAL` 若明確提到 backend 該 port／`MiningProcessLockError`，Studio 會尋找該卡建立的 runtime。已確認可安全重啟時會自動清理、重啟、檢查 `/health`、執行 smoke path 並繼續原卡；否則 UI 顯示 `Blocked` 原因，要求人工處理。
- listener 存在但 FastAPI startup 失敗時仍是 `BLOCKED`，health response 的啟動錯誤會顯示給使用者。

---

## 4. 程序清理原則（Windows Process Tree）

1. **嚴格針對目標 Job PID 樹**：
   - 一次讀取全部程序後建樹：子程序的建立時間必須不早於父程序才算後代（Windows 會重用 PID，只看 ParentProcessId 曾誤殺無關的 Vite dev server）。只逐一終止根程序與這些後代，不用 `taskkill /T`；程序清單讀取失敗時不終止任何程序，回報未停止並保留租約。
   - 只有登記於該 Job 下的進程才會被終止，絕不會影響其他 Job 或系統中執行的其他 python/node 程序。
2. **PID 重複利用（Recycling）防護**：
   - 當判定過期的 Runtime 紀錄時，若該 PID 存在但啟動指令或執行檔不相符，代表該 PID 已被作業系統指派給無關的程式；**絕對不殺此程序**，僅將紀錄標記為 `stale` 並保留其暫存目錄，等待 ownership 確認。

---

## 5. 連接埠所有權（Port Ownership）

在啟動需要監聽連接埠的服務前，呼叫 `checkPortOwnership(port, options)`：
1. 若連接埠未被佔用：回傳 `{ status: 'free', available: true }`。
2. 若被佔用且為本 Studio 已知且相符的進程：回傳相應所有權狀態。
3. 若被佔用但 **Owner 不明**（外部程序或非 Studio 紀錄）：
   - **絕不強制 kill**。
   - 查詢其行程資訊（PID、CommandLine、Executable）。
   - 回傳 `{ status: 'blocked', available: false, owner: 'unknown', pid, command, port, reason }`。
   - `reason` 明確指出阻擋原因，如：
     `Blocked: unknown process PID 21996 ("python.exe" -m uvicorn ...) occupies port 3018`。

---

## 6. 測試／煙霧測試環境隔離（Smoke Isolation）

- 正式 `/api/runtime/start` 的 `smoke`／`test` 會忽略呼叫者的 `dataDir`，建立 `%TEMP%\MultiAgentStudio\<project>\<run-id>\data`，並登記 `temp_dir`、設定 `DATA_DIR`、`PORT` 與 `STUDIO_ISOLATED=1`。啟動前失敗或租約變更時清理本次配置；啟動後沿用 runtime 的程序身分確認與清理流程。
- `port` 是偏好值，未指定時從 3020 開始；若不可用則搜尋 3020–3099，最後由 OS 配置，排除 3018（後端）與 3011（前端）。呼叫端須使用回傳的 `runtime.port`。
- 執行的程式必須遵守 `DATA_DIR` 與 `PORT` 環境變數；這是啟動設定的隔離，並非禁止程式自行讀寫其他目錄的 OS sandbox。不要在 args 中覆蓋這兩個值。
- 由於檔案鎖（`.mining_process.lock`）位於各自的 `DATA_DIR` 內，即便煙霧測試（例如 3028 埠）正在執行並持鎖，正式環境 3018 仍可順利取得正式環境的資料庫與進程鎖，兩者互不干擾。
- 測試結束後由 `cleanupIsolatedDir` 清理；若發生異常崩潰，則在下次 Studio 啟動時由 `cleanupStaleRuntimes` 自動掃描清除。

## 整合補強：程序身分與清理邊界

`process_identity` 保存 OS 程序建立時間與完整 executable 路徑；PID 相同或程序名稱相同並不足以允許清理。舊紀錄若仍活著卻缺少此身分，會保留程序並回報 PID／command。`studio_pid` 用來避免啟動掃描清理另一個仍存活的 Studio 所持有的 runtime。Job 清理回傳 `blocked` 清單，只有程序樹全部停止才標記 cleaned。暫存資料只刪除實際位於系統 temp 的 `MultiAgentStudio/<project>/<run>` 子目錄，拒絕根目錄、相鄰路徑與 symlink／junction；每個 smoke 呼叫建立獨立 run 目錄。Registry 損毀會明確失敗並保留原檔，更新採用同目錄暫存檔原子取代。

## 恢復與 workspace 生命週期銜接

恢復採用該 job／card／port 最新的 runtime 紀錄，先檢查 write lease、OS 程序身分與 DATA_DIR owner。健康 runtime 直接通過 health／smoke 後續卡；stale runtime 才 cleanup → restart → health → smoke → continue。每個非同步階段重新確認原 job、card 與 lease generation；PAUSE、STOP、handoff 或 external claim 會阻止重啟／續卡，並等待在途的恢復與 managed start 結束後清理程序樹，再釋放租約。已知 ownership 的 startup failure 保持自動 health 輪詢並顯示 blocked 原因，不會每五秒重啟同一 replacement。未知 PID／data owner 或無法安全重建命令才要求人工。

## 驗證範圍

Codex 的 Windows 工具程序由 `codex-runtime.mjs` 接到既有 registry（`purpose: codex_session`）。初始化與重建序列化，在本 Studio 的 AionCore 程序下辨識唯一新增的 Codex app-server，保存 PID、OS 建立時間與 executable；候選不唯一或 CIM 查詢失敗時拒絕開始執行。程序名稱只用來辨識 CLI，不是刪除或終止程序的依據。

回合結束、暫停、停止與交接會使用 AionCore v0.2.2 的單一對話 `runtime/restart`，讓原生 Windows Job Object 結束舊 session 工具程序；原對話與歷史保留。Studio 先保存含建立時間檢查的程序樹，再確認原程序身分均已退出，才放行寫入權；HTTP 200 或 idle 本身不算通過。確認失敗的 `stopping` 紀錄及子 PID 保留，供再次確認及重啟後清理使用；另一個 conversation 不會被一起停止。每次 Codex 回合結束會多一次 CLI 重建；這項護欄目前限定 Windows 與專案固定的 AionCore v0.2.2。

`test-runtime.cjs` 除 H/I/J/L、readiness predicate 與恢復階段的取消外，亦啟動 OS 配置埠的真實 HTTP fixture：程序存活且 listener 可連線時，`MiningProcessLockError` 的 503 仍須 BLOCKED；同一程序改回既有 `status: "ok"` 契約後才 BACKEND_READY。`test-runtime-server.cjs` 執行 production server hooks，涵蓋最新 replacement、未知 PID／command、已知 startup failure 自動輪詢、不重複 restart、STOP 在 cleanup 期間的租約保留、handoff 前 OS drain，以及 write lease admission。延遲清理會固定原 job／card 範圍；前一輪 runtime 未停妥時禁止啟動新一輪。Auto CI 與 lifecycle-check 會執行上述回歸及 A–M 情境。

自動化 CI 使用隔離資料與子程序 fixture；2026-10-16 的真實 AionCore／Agent 驗證另見 `docs/audit-batches.md`，未使用正式 TWstock DATA_DIR。需要跨回合保留或 health／自動恢復的服務必須由 `/api/runtime/start` 管理；Codex 直接在 shell 啟動的工具隨該回合的 runtime 一起結束。沒有新增 AionCore 內部程序追蹤 API。
