# AionCore 邊界與契約測試

## 模組責任

- `studio/aion-client.mjs`：固定 release／SHA-256、登入、Bearer／CSRF、HTTP 回應 envelope、逾時錯誤。直接匯入不啟動程序、不讀設定檔。
- `studio/server.mjs`：後端啟動及退出、runtime 登記、供應商／工作區狀態、派工與生命週期。仍由 server 決定重試、取消與租約釋放。
- `studio/live-models.mjs`：透過正式 client 讀取 runtime config snapshot，在同一對話設定模型與思考強度。
- `studio/acp-command.mjs`／`studio/acp-launcher.cjs`：適配固定版本的自訂執行檔路徑限制，保留原始 argv 與 ACP stdio。
- `studio/windows-batch.cjs`：僅為 `.cmd`／`.bat` 建立經驗證的 `cmd.exe` 呼叫，不處理其他命令。

這次只抽離通訊與版本邊界，保留原來 30 秒 timeout 與 `stopUnconfirmed` 語意；沒有改寫派工狀態機、租約協定或使用者規則同步。

## 兩層驗證

1. `node studio/test-aion-client.cjs`：無網路單元測試，直接匯入正式 client，驗證登入／CSRF、回應解析、後端退出後拒絕呼叫，以及等待 headers／body 逾時都保留停止未確認旗標。已加入 `scripts/ci.ps1`。
2. `node studio/test-aion-contract.mjs`：Windows 真實契約測試。驗證與 Studio 相同的官方 ZIP／執行檔雜湊，再啟動隔離資料目錄的 AionCore。註冊本機 ACP fixture，實際走 HTTP 與 stdio，驗證登入、認證／CSRF 拒絕、`runtime/ensure`、模型／思考強度設定、舊 GET 路徑 404，以及沒有重開對話。

第二層在 GitHub 的 **AionCore contract (no models)** job 執行；不放進一般離線 CI 腳本，避免每次本機回歸都必須下載後端。下載、hash、平台或契約失敗都會讓 gate 失敗，不會略過後宣稱通過。

執行檔快取在 `runtime/contract-aioncore/`，不替換正式 Studio 執行檔。測試 data／work／home 皆在專用暫存目錄，環境只繼承啟動所需系統變數；不繼承供應商 keys、使用者 Codex home 或規則檔。fixture 不呼叫真實模型、網路或工具；以本機回覆驗證 `session/prompt`、`session/cancel`、取消後回到 idle，以及同一 session 再次接受工作。結束核對程序身分、清理程序樹，再刪除測試目錄。測試包含 `Agent 中文 Tools/contract agent.exe` 與同名 `.cmd`／`.bat` wrapper，驗證新增探測及實際對話使用完整路徑、支援的參數原樣傳遞。批次檔另外核對 launcher → cmd.exe → Agent 的程序歸屬，以及探測後、後端關閉後皆無殘留。

## 真實 Agent 介面驗收（2026-11-17）

在 Windows 的正式 Studio／固定版 AionCore 上，沿用既有 Claude 帳號與 Studio 專用 Codex 的 ChatGPT 登入；未重新登入或複製憑證。以 `STUDIO_RUNTIME` 隔離設定與工作紀錄，`STUDIO_CODEX_HOME` 指向原本已登入的 Studio 目錄，測試專案與正式專案分開。

| 真實 Worker | 工頭 | 連線、開始工作 | 暫停 | 恢復 | 停止 |
| --- | --- | --- | --- | --- | --- |
| Codex | Claude Code | PASS | PASS | PASS | PASS |
| Claude Code | Codex | PASS | PASS | PASS | PASS |

所有操作由 Studio 介面觸發。Worker 實際執行每秒寫入 heartbeat、90 秒內自行結束的 Node 命令；核對 UI 與後端狀態、程序 PID／建立時間及 heartbeat，並非只看畫面文字。暫停後工具程序結束、heartbeat 不再增加、寫入租約為 `RESERVED`；恢復沿用同一工作與卡片，啟動新工具程序且 heartbeat 繼續增加；停止後工作卡記為「已停止」、無未確認停止旗標、工具程序消失且租約釋放。原專案未產生程式變更，四份既有自訂／全域規則檔的 SHA-256 前後一致。

驗收須明確要求 Agent 等待前景命令完成：Codex 若取得執行中工具的 session ID，持續以 `write_stdin` 等待；Claude 使用前景 Bash，若取得背景 task 則持續查詢它。首次 Codex 嘗試提早回報 `WAITING_EXTERNAL`，因此不算「執行中暫停」通過；補明等待要求後重新驗收通過，未為此改動 Studio 排程或取消邏輯。這是特定日期、既有登入與受控本機命令的實測，不代表所有工具、供應商版本或模型行為都已驗證；W1／Store／MSIX pwsh 程序隔離仍不在範圍內。

## 驗證邊界與固定版本限制

此 gate 驗證 **Studio ↔ 真實 AionCore ↔ ACP wire protocol**；ACP 端是可重現的本機 fixture，不能代替 Claude／Codex／Antigravity 真實版本、登入、配額與工具行為的人工 smoke。W1 不在範圍內。

建置測試時實際發現 AionCore v0.2.2 的 custom-agent probe 先用空白切 `command`，因此 `C:\Program Files\...\node.exe` 會被截成 `C:\Program`；單純加引號也無法解決。Studio 對含空白的 `.exe` 完整路徑使用 Node launcher：後端接收 `node.exe`，原始執行檔與參數放在 argv，以 `spawn(..., { shell: false, stdio: 'inherit' })` 執行，不搬移使用者執行檔、不解讀 shell 符號。設定檔及 UI 仍保留使用者原始命令。AionCore 子程序的 PATH 前置 Studio 所用 Node 的目錄，讓新增探測及後續啟動都能找到 launcher runtime；不修改系統 PATH。

明確以 `.cmd`／`.bat` 結尾的自訂命令都使用 launcher，包含含空白的完整路徑及 PATH 上的批次檔名稱。launcher 呼叫 `cmd.exe /d /s /v:off /c`，關閉 AutoRun 與預設延遲變數展開。參數先依 Windows 原生 CLI 規則保留空值、引號前與尾端的整段反斜線，再處理兩層 shell 跳脫，分別通過啟動解析與批次檔 `%*` 轉交。命令路徑只經一次跳脫，路徑中的 `%`／`!` 也保留原值。

批次檔參數支援內嵌雙引號、`%` 與 `!`；`%NAME%`／`!NAME!` 傳入字面值，不展開成環境變數。參數欄可用既有引號語法或 JSON 字串陣列輸入，設定仍儲存原始參數。NUL、CR／LF，以及編碼後超過 8,000 字元的命令仍會在新增前及 launcher 啟動前拒絕；Windows 檔案路徑本身仍不能包含雙引號。`.exe` 仍不經 shell，沿用原有 argv 支援。

驗證範圍是直接用 `%*` 轉交給原生 CLI 的 wrapper，以及 npm 的 `endLocal ... & ... %*` 形式。`test-local-maintenance.cjs` 實跑兩種副檔名、PATH 查找、stdin／stdout／stderr、cwd／env、退出碼、連續反斜線與引號組合，並確認注入字串原樣收到且沒有執行額外命令。真實 AionCore gate 對兩種 wrapper 都驗證新增、啟動、特殊參數及程序清理。腳本本身若自行拆參數、啟用延遲展開或再次用 `call`／shell 組合命令，其行為仍由腳本決定。

其他無空白命令沿用原有處理；含空白路徑可帶一組外層雙引號，參數仍須另填。不接受將 `node --acp` 整行誤填為執行檔。裸 `node` 仍採 AionCore 的 managed runtime 語意。上游日後修正解析時，可移除對應適配，但須先通過真實契約測試。

## 契約來源與升級方式

- [固定版本的 HTTP config-options 測試](https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-app/tests/acp_config_options_e2e.rs)
- [固定版本 custom-agent probe](https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-ai-agent/src/protocol/custom_agent_probe.rs)
- [固定版本命令解析](https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-runtime/src/node_runtime/mod.rs)
- ACP v1：[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[session 建立](https://agentclientprotocol.com/protocol/v1/session-setup)、[config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- Windows：[cmd 的引號、AutoRun 與變數展開規則](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)、[原生 CLI 的反斜線／引號解析](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments)
- 兩層跳脫設計比對 ISC 授權的 [npm/promise-spawn 命令組裝](https://github.com/npm/promise-spawn/blob/3b123db4dabbd9ed80abb7ba477ec7a0acef3399/lib/index.js)與[參數編碼](https://github.com/npm/promise-spawn/blob/3b123db4dabbd9ed80abb7ba477ec7a0acef3399/lib/escape.js)。本地以整段反斜線比對實作原生 argv 編碼，避免只處理最後一個反斜線或使用可能反覆回溯的模式；沒有加入套件依賴。

上游程式僅用於查證契約；fixture 依公開 wire protocol 實作，沒有複製上游 Rust 實作。升級時先更新 `AION_RELEASE` 的版本、URL 與已驗證雜湊，再跑單元及真實契約 gate；介面改動須同步檢查正式呼叫端，不能只改 mock 讓測試變綠。
