# 用 Chrome DevTools MCP 驗證 Studio

這個流程在 Windows 的獨立 Chrome 裡操作真正的 Studio，適合核對按鈕送出的 HTTP 請求、回應內容與畫面效能。瀏覽器驗證由本機手動執行。

## 啟動測試 Studio

準備 PowerShell 7.3 以上、Node.js、npx 與 Chrome。在 repository 根目錄執行：

```powershell
pwsh -NoProfile -File .\scripts\start-test-studio.ps1
```

腳本會建立一個名為「瀏覽器驗證」的空專案，印出測試專案、Studio 專用 Codex home，以及包含 `#t=` 的本機網址。保留這個終端機，請 MCP 在它啟動的隔離 Chrome 裡開啟該網址。連接埠預設為 4859，若已被使用可以加上 `-Port 4860`。按 Ctrl+C 結束，也可用 `-DurationSeconds 180` 限時執行。

`STUDIO_RUNTIME`、AionCore 資料、成員設定和專案都在本次的暫存資料夾。腳本會複製 Studio 與已安裝的 AionCore 執行檔供測試用；尚未安裝時由 Studio 在暫存資料夾下載並驗證固定版本。只在清理時通過路徑驗證的本次資料夾會被刪除。

## 手動設定 MCP

**Codex**　將這段加到上方印出的 Studio 專用 Codex home 下的 `config.toml`。可在暫存專案目錄用新的 PowerShell 視窗將該次程序的 `CODEX_HOME` 指向印出的目錄，再啟動 Codex。若使用新建的 home，執行模型另需可用的登入。[Codex MCP 設定](https://developers.openai.com/codex/mcp/)

```toml
[mcp_servers.studio-browser]
command = "cmd"
args = ["/c", "npx", "-y", "chrome-devtools-mcp@latest", "--isolated", "--usage-statistics=false", "--redact-network-headers", "--performance-crux=false"]
startup_timeout_sec = 60
```

**Claude Code**　在上方印出的暫存專案內手動建立 `.mcp.json`，從該目錄啟動 Claude Code 並核准此專案的 MCP。已有其他 MCP 時將項目加進原本的 `mcpServers`。[Claude Code 專案層級 MCP](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)

```json
{
  "mcpServers": {
    "studio-browser": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "chrome-devtools-mcp@latest", "--isolated", "--usage-statistics=false", "--redact-network-headers", "--performance-crux=false"]
    }
  }
}
```

`--isolated` 建立拋棄式 Chrome 使用者資料夾，結束 MCP 時一併清除。保持此設定，勿連線日常登入的 Chrome。`--usage-statistics=false` 關閉 MCP 使用統計，`--performance-crux=false` 關閉追蹤網址的 CrUX 查詢。[上游設定](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)

**只對測試 runtime 使用。** 首次開頁時，Studio 從網址片段 `#t=` 讀取通行碼，之後用 `x-studio-token` 請求 header 存取 API。`--redact-network-headers` 依 DevTools 內建的敏感 header 清單遮罩，未保證涵蓋 Studio 的自訂 header。保留請求路徑與回應碼即可，分享紀錄前把網址片段及 header 值換成 `<redacted>`。[上游參數說明](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)

## 三個驗證情境

1. **按「繼續」**。用測試專案的一件已暫停工作。在 MCP 的 `take_snapshot` 找出「繼續」按鈕的 uid，用 `click` 點擊，再用 `list_network_requests` 找這次的 `POST /api/resume`。確認 HTTP 2xx，並在畫面或 `GET /api/state` 確認同一個工作恢復執行。空專案可使用內附的本機 ACP fixture 建立工作，見下方。
2. **核對模型選單**。在專案開啟成員的模型下拉選單，從最新的 `GET /api/state` 讀取該成員的 `agents[].models`，比對選單標籤和選項值。這個選單使用先前取得的狀態，點擊當下可能沒有新請求。若測的是總覽「外部模型 → 取得模型清單」，則選用拋棄式本機服務，核對 `POST /api/external/models` 的回應陣列及選單。
3. **檢查辦公室畫面**。進入辦公室，用 `performance_start_trace` 開始記錄，操作畫面數秒，再用 `performance_stop_trace` 結束。在瀏覽器 Performance 面板對照 Main 與 Frames 軌，查看超過 50 ms 的長任務是否與掉幀同時發生。把操作、記錄時間與觀察到的幀寫在一起。

### 用本機 fixture 準備暫停中的工作

在總覽的「ACP Agent」加入兩個自訂成員，分別命名為「瀏覽器工頭」和「瀏覽器成員」。兩者的啟動指令都填 `node.exe`，參數填下列兩個帶引號的完整路徑，將尖括號部分換成實際位置。第二個成員使用另一個紀錄檔名。

```text
"<repository>\studio\fixtures\contract-acp.cjs" "<測試專案>\leader.jsonl"
```

等兩位都可用後，進入「瀏覽器驗證」專案，選「瀏覽器工頭」為工頭，只勾選「瀏覽器成員」為成員，輸入 `STUDIO_LIFECYCLE` 再按「交給團隊」。等工作卡顯示執行中後按「暫停」，待畫面顯示「繼續」就能驗證第一個情境。fixture 的回覆來自本機固定腳本。
