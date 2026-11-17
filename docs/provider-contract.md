# AionCore 邊界與契約測試

## 模組責任

- `studio/aion-client.mjs`：固定 release／SHA-256、登入、Bearer／CSRF、HTTP 回應 envelope、逾時錯誤。直接匯入不啟動程序、不讀設定檔。
- `studio/server.mjs`：後端啟動及退出、runtime 登記、供應商／工作區狀態、派工與生命週期。仍由 server 決定重試、取消與租約釋放。
- `studio/live-models.mjs`：透過正式 client 讀取 runtime config snapshot，在同一對話設定模型與思考強度。

這次只抽離通訊與版本邊界，保留原來 30 秒 timeout 與 `stopUnconfirmed` 語意；沒有改寫派工狀態機、租約協定或使用者規則同步。

## 兩層驗證

1. `node studio/test-aion-client.cjs`：無網路單元測試，直接匯入正式 client，驗證登入／CSRF、回應解析、後端退出後拒絕呼叫，以及等待 headers／body 逾時都保留停止未確認旗標。已加入 `scripts/ci.ps1`。
2. `node studio/test-aion-contract.mjs`：Windows 真實契約測試。驗證與 Studio 相同的官方 ZIP／執行檔雜湊，再啟動隔離資料目錄的 AionCore。註冊本機 ACP fixture，實際走 HTTP 與 stdio，驗證登入、認證／CSRF 拒絕、`runtime/ensure`、模型／思考強度設定、舊 GET 路徑 404，以及沒有重開對話。

第二層在 GitHub 的 **AionCore contract (no models)** job 執行；不放進一般離線 CI 腳本，避免每次本機回歸都必須下載後端。下載、hash、平台或契約失敗都會讓 gate 失敗，不會略過後宣稱通過。

執行檔快取在 `runtime/contract-aioncore/`，不替換正式 Studio 執行檔。測試 data／work／home 皆在專用暫存目錄，環境只繼承啟動所需系統變數；不繼承供應商 keys、使用者 Codex home 或規則檔。fixture 不呼叫模型、網路或工具；記錄所收方法並斷言沒有 prompt。結束核對程序身分、清理程序樹，再刪除測試目錄。argv 包含空白，workspace 包含中文與空白。

## 驗證邊界與固定版本限制

此 gate 驗證 **Studio ↔ 真實 AionCore ↔ ACP wire protocol**；ACP 端是可重現的本機 fixture，不能代替 Claude／Codex／Antigravity 真實版本、登入、配額與工具行為的人工 smoke。W1 不在範圍內。

建置測試時實際發現 AionCore v0.2.2 的 custom-agent probe 先用空白切 `command`，因此 `C:\Program Files\...\node.exe` 會被截成 `C:\Program`；單純加引號也不是它支援的解析契約。裸 `node` 另會選擇 AionCore managed Node runtime；fixture 使用其支援的 `node.exe` PATH lookup，不更動正式使用者設定。這些是上游已確認限制，未宣稱本輪修復所有自訂命令相容性。

## 契約來源與升級方式

- [固定版本的 HTTP config-options 測試](https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-app/tests/acp_config_options_e2e.rs)
- [固定版本 custom-agent probe](https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-ai-agent/src/protocol/custom_agent_probe.rs)
- [固定版本命令解析](https://github.com/iOfficeAI/AionCore/blob/47e66d0d151123e973b3fd1e77afcb5671b3f8c5/crates/aionui-runtime/src/node_runtime/mod.rs)
- ACP v1：[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[session 建立](https://agentclientprotocol.com/protocol/v1/session-setup)、[config options](https://agentclientprotocol.com/protocol/v1/session-config-options)

上游程式僅用於查證契約；fixture 依公開 wire protocol 實作，沒有複製上游 Rust 實作。升級時先更新 `AION_RELEASE` 的版本、URL 與已驗證雜湊，再跑單元及真實契約 gate；介面改動須同步檢查正式呼叫端，不能只改 mock 讓測試變綠。
