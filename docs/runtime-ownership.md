# Runtime Ownership, Readiness & Test Isolation (Workstreams B+C+D)

本文件說明 Multi-Agent Studio 的 **Runtime Ownership Registry**、**程序樹生命週期清理**、**連接埠所有權（Port Ownership）檢查** 與 **測試／煙霧測試環境隔離（Test/Smoke Isolation）** 架構。

---

## 1. 架構概述與職責解耦

Multi-Agent Studio 管理多個 Agent、背景進程與測試執行。為確保背景程序不相互干擾、系統當機後可安全清理殘留資源，並防止測試程序搶佔正式環境資料庫或鎖，由以下模組統一負責：

- **`studio/runtime-registry.mjs`**：
  - 持久化記錄 Studio 啟動的所有長時間程序（`runtimes.json`）。
  - 提供作業系統層級（Windows PID Tree）的進程管理與清理（嚴格使用 `taskkill /F /T /PID` 或 PID 樹遞迴，**禁止依名稱 `Stop-Process -Name python/node` 殺程序**）。
  - 啟動與掃描時自動清理確認 stale 的程序與殘留暫存目錄（具備 PID 重複使用安全防護）。
  - 連接埠所有權檢查：**未知 process 絕不 kill**，精確回報 PID、指令、連接埠與鎖狀態。

- **`studio/isolated-env.mjs`**：
  - 專門為 Smoke／整合測試分配隔離的暫存環境 `%TEMP%\MultiAgentStudio\<project>\<run-id>\data`。
  - 將隔離目錄注入為環境變數 `DATA_DIR`，使檔案鎖（如 `mining_process_lock`）、快取與狀態與正式目錄完全分離。
  - 動態配置測試用連接埠（避開正式環境的 3018 與 3011），執行完畢後自動清理暫存目錄。
- **`studio/runtime-readiness.mjs`**：
  - `BACKEND_READY` 必須同時滿足已登記 PID 存活、連接埠可連線、`GET /health` 回 HTTP 200，以及 response `ready: true` 或 `status: "ready"`。
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

- `POST /api/runtime/start` 只接受進行中工作卡、絕對 executable、字串 args、工作區內的 cwd 與既有 data directory；Studio 直接啟動並登記 PID。
- `POST /api/runtime/readiness` 以 `runtimeId` 查詢 readiness；`GET /api/runtimes` 與 `/api/state` 也提供 runtime readiness。
- 一般 `WAITING_EXTERNAL` 若明確提到 backend 3018／`MiningProcessLockError`，Studio 會尋找該卡建立的 runtime。已確認可安全重啟時會自動清理、重啟、檢查 `/health`、執行 smoke path 並繼續原卡；否則 UI 顯示 `Blocked` 原因，要求人工處理。
- listener 存在但 FastAPI startup 失敗時仍是 `BLOCKED`，health response 的啟動錯誤會顯示給使用者。

---

## 4. 程序清理原則（Windows Process Tree）

1. **嚴格針對目標 Job PID 樹**：
   - 終止程序時使用 `taskkill /F /T /PID <root_pid>`。
   - 只有登記於該 Job 下的進程才會被終止，絕不會影響其他 Job 或系統中執行的其他 python/node 程序。
2. **PID 重複利用（Recycling）防護**：
   - 當判定過期的 Runtime 紀錄時，若該 PID 存在但啟動指令或執行檔不相符，代表該 PID 已被作業系統指派給無關的程式；**絕對不殺此程序**，僅將紀錄標記為 `stale` 並清理其孤兒暫存目錄。

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

- 煙霧測試後端啟動時，自動建立 `%TEMP%\MultiAgentStudio\<project>\<run-id>\data`，並設定 `DATA_DIR` 環境變數。
- 測試連接埠自動在 3020–3099 間配置，保證不佔用正式環境 3018（後端）與 3011（前端）。
- 由於檔案鎖（`.mining_process.lock`）位於各自的 `DATA_DIR` 內，即便煙霧測試（例如 3028 埠）正在執行並持鎖，正式環境 3018 仍可順利取得正式環境的資料庫與進程鎖，兩者互不干擾。
- 測試結束後由 `cleanupIsolatedDir` 清理；若發生異常崩潰，則在下次 Studio 啟動時由 `cleanupStaleRuntimes` 自動掃描清除。
