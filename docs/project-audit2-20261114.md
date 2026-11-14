# 第二輪審查與修復（2026-11-14）

基準為 PR #57 合併後 `3e0142a586d72853b0ec4248c701692ca14cf7a2`。使用獨立雲端工作副本，三位 Astra/high 審查者分別檢查生命週期、程序／鎖與 UI／排程。未操作使用者本機或真實付費模型。

## 已重現的問題

1. **P1：舊 Leader 計畫污染新工作。** 建立對話尚未回來時暫停並開新工作，舊流程沒有核對 run identity，會送出舊請求並將其卡片加入新看板。使用實際來源函式與延遲 gate，證實 OLD REQUEST 與 NEW REQUEST 混入同一新工作；沒有真的派付費模型。
2. **P1：已關閉專案仍由排程啟動。** 定時工作的 precheck 尚未完成時關閉專案，成功回覆後仍呼叫 start，產生不在看板中的 active run。重現驗證到 planPhase 邊界，未實際執行 agent 或修改專案。
3. **P2：歷史詳情的舊回應覆蓋新選擇。** A 請求晚於 B 回來時會替換視窗與繼續工作的目標，關閉後也可能重開。
4. **P2：送出指示的延遲成功清除新草稿。** 送出後繼續打字，前一筆成功會清除後一筆尚未送出的內容。
5. **P2：狀態輪詢倒退。** 先回來的新狀態會被晚到的舊狀態覆蓋，造成看板短暫回到舊工作／進度。
6. **P2：Studio 啟動鎖恢復競爭。** instance.lock 與 reclaim 都為死亡 owner 時，兩個接管者可以刪除對方新鎖。真實暫存檔＋可控身分查詢重現一方成功、一方 ENOENT，最後主鎖空白而後續啟動被阻擋。沒有宣稱已重現兩個 controller 同時成功。
7. **P2：同 port 不同地址可能驗錯後端。** listener PID 查詢忽略 LocalAddress，但 health 固定連 IPv4 loopback。使用真實 IPv6／IPv4 測試 HTTP 服務與模擬 Windows PID 回覆，重現 managed IPv6 回報未就緒，另一 IPv4 服務回報就緒，卻判定 BACKEND_READY。這不是 Windows 實機 listener 查詢測試。

## 驗證與限制

修復前，既有 11 組可在 Linux 執行的回歸皆通過，所有受版本控制 JavaScript 語法與 whitespace 檢查通過，以上新情境仍可重現。這說明既有綠燈沒有覆蓋這些交錯順序，並非測試通過就沒有問題。

本輪將增加專用回歸；正式 Windows Node 22 CI 與真實供應商端到端測試須分開報告。未知／毀損舊鎖不能憑猜測刪除。快照後才出生或先前已脫離的程序限制仍存在，不能把本輪修復宣稱成 OS 級程序樹隔離。

## 本輪修復與回歸

- Leader 計畫、提問、補充指示及收尾步驟先登記再執行，Pause/Stop 會使其世代失效；建立對話、送出前、讀取結果後與發布卡片皆有工作身分／狀態保護。新的工作或 Resume 不得跨過尚未排空的 Leader 步驟。
- routine precheck 返回後核對 workspace 仍在開啟列表。
- 歷史詳情與 state 輪詢加入序號及關閉取消；指示草稿只清除原本送出的相同內容。
- Studio runtime 恢復鎖改完整內容原子發布的 immutable guard，不刪除前代 guard；相同死亡 guard 的競爭者只爭同一後繼路徑。
- listener 查詢以 health 真正連線的 IPv4 loopback 為目標；不明／多 PID／查詢失敗保守阻擋，不把別的地址上的服務當成同一個後端。
- 新增 `test-leader-lifecycle.cjs`、`test-ui-async.cjs`、`test-state-recovery.cjs`、`test-runtime-endpoint.cjs` 並納入 Windows CI。舊 state 測試的死 guard 預期改成保留（安全協定刻意不刪前代），不是略過斷言。

雲端整合覆跑 15 組可跨平台回歸均通過，語法與 whitespace 檢查通過；Leader 修復另由 UI 審查者交叉驗證重入、自等和自動下一步。Linux 的完整 lifecycle suite 到 Windows `cmd.exe` precheck 才遇到平台缺失，未改掉平台斷言。正式 Windows CI 結果請以 PR 所列相同 head 的 Actions 紀錄為準。
