# 全庫檢查與修復（2026-11-14）

基準：`174bab36d909605044be18404dc32dc7c14d74f5`。在獨立雲端 Linux checkout 檢查，沒有操作使用者本機、登入、正式工作卡或 provider。三個 Astra/high 審查分工覆蓋工作生命週期、runtime/程序所有權、UI/文件/CI/啟動器與實驗工具；主線整合並交叉檢查差異。這是有界的程式碼審查與回歸修正，不代表能證明專案沒有其他缺陷。

## 本次修復

- **工作交接互斥**：同卡交接與唯讀切換不能重入；等待停止、讀取對話及查工作區後，重新驗證工作、原 agent、世代與路徑。失敗停止仍保持阻擋。避免第二次交接撤銷已開始的新 owner 租約。
- **歷史工作切換**：舊工作仍有執行／恢復／runtime 啟動或未確認停止的程序時，拒絕替換卡片與追蹤紀錄。
- **完成卡保護**：UI 不再顯示工作中／已完成卡的改派，後端也拒絕完成卡改派或直接交接。
- **程序身分**：根 PID 必須有可核對身分，且符合呼叫者保存的身分；終止前再查一次。缺失或查詢失敗保持阻擋，不以空值匹配終止程序。setup 清理傳遞既有身分。
- **子程序 listener**：不再把啟動時尚未登記的 listener 子程序直接當成未知程序；以登記 port 找候選，再驗父程序與即時後代關係。
- **UI 安全及過期回應**：health 錯誤當文字顯示；詳情與歷史忽略舊回應；送出請求不再清除另一專案或新修改的草稿。
- **歷史上下文**：歷史頁不借用目前專案的租約／runtime，也不提供作用於目前卡片的清理按鈕。
- **小型一致性**：移除重複 DOM id；README 中英 token 上限預設修正為實際的 0（不限）。沒有改動預算行為。
- **回歸測試**：新增 UI、程序身分、工作交接三組測試並加入 Windows CI。

## 驗證範圍

雲端 Node 24 的 JavaScript 語法檢查及以下測試通過：

- test-codex-provider、test-codex-runtime
- test-card-files、test-turn-stall
- test-runtime-server、test-ui-ownership、test-workspace-lease
- test-ui-safety、test-runtime-identity、test-audit-lifecycle
- git diff --check

新 UI 與 runtime 測試另在基準版本上執行，分別在工作中卡改派與缺根身分終止斷言失敗。這只證明它們能抓到該首個缺陷，不宣稱基準逐一跑完每個新情境。

**不能宣稱完整 CI 通過**：正式 CI 為 Windows Node 22。Linux 基準的 test-state-files 因無 Windows 程序建立時間／執行檔資料而保守拒絕重新取得 runtime；test-runtime 在 Windows listener 查詢案例失敗；lifecycle-check 的 cmd.exe precheck 案例亦不能在 Linux 執行。未以跳過或放寬斷言掩飾。真實 Windows 瀏覽器、AionCore/provider 端到端流程仍需 Windows 驗證；未啟動任何真實付費模型。

## 留待審閱（未自動改）

1. **租約鎖 crash recovery**：`workspace-lease.mjs` 的 `.lock.reclaim` 沒有持有者身分。程序在取得它後崩潰會留下檔案，後續接管持續失敗。空檔亦可能是活著的程序剛建立，不能直接刪除；需設計可恢復且無競爭的鎖協議及 crash 測試。
2. **平台範圍**：核心程序查詢、port 查詢與工作指令為 Windows-first；Linux 可跑純邏輯測試不代表可當正式 Studio host。跨平台支援需獨立需求。
3. **已知程序樹限制**：快照後新生或已脫離的後代仍不保證全部追蹤；本次身分檢查不等於 OS 級程序容器。若要更強保證，需評估 Windows Job Objects／原生 helper。
4. **可用性與維護**：`readProjectProgress()` 讀檔錯誤可能使整個 `/api/state` 失敗；server 與 inline UI 較大，適合後續按模組漸進拆分，避免這次廣泛重構造成行為差異。
5. **清理候選**：UI 少量未使用宣告、重複文案；spikes/fixtures 與歷史審查記錄仍有診斷用途，未僅憑檔案舊就刪除。

不合併 main，不更改正式登入或訂閱設定，不對已完成的修正宣稱真實 provider 驗證。
