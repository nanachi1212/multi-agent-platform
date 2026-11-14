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

1. **舊格式／未知鎖**：續輪已修復帶完整 owner/token 的 recovery guard 當機殘留；舊版空 `.reclaim`、毀損內容及主 `.lock` 在建立後尚未寫入即當機的空檔，仍沒有可證明持有者死亡的資料，保守拒絕自動刪除。硬連結不支援的檔案系統會明確失敗，不降級成有競爭的刪鎖。
2. **平台範圍**：核心程序查詢、port 查詢與工作指令為 Windows-first；Linux 可跑純邏輯測試不代表可當正式 Studio host。跨平台支援需獨立需求。
3. **已知程序樹限制**：快照後新生或已脫離的後代仍不保證全部追蹤；本次身分檢查不等於 OS 級程序容器。若要更強保證，需評估 Windows Job Objects／原生 helper。
4. **維護**：server 與 inline UI 較大，適合後續按模組漸進拆分，避免這次廣泛重構造成行為差異。progress 單檔容錯已在續輪修復。
5. **清理候選**：UI 少量未使用宣告、重複文案；spikes/fixtures 與歷史審查記錄仍有診斷用途，未僅憑檔案舊就刪除。

本次修復在獨立分支進行，不更改正式登入或訂閱設定，不對已完成的修正宣稱真實 provider 驗證。

## 授權續輪修復

- 進度檔改直接讀取並局部捕捉錯誤；缺檔照常，權限／I/O 錯誤顯示於該專案進度面板，不讓整個狀態 API 失敗。不傳原始例外內容，下一次輪詢仍可恢復。
- 移除未使用的 `anyActive`，保留仍有引用的 `OPEN`；備援與收尾者的標籤不再重複誤導。
- 終止前已有的第二次快照不只驗根程序，也收納期間新生且仍能證明隸屬原根的子孫；逐一終止前仍驗原身分。同 PID 身分衝突不覆寫、不終止。最後一次快照之後才出生，或在可連回根的快照之前已脫離者仍不保證追蹤，不宣稱已具備 OS Job Object 保證。
- 新增 `test-progress-read.cjs`，擴充 `test-runtime-identity.cjs` 的晚生後代／重用／未知身分案例，已在雲端通過。

- 接管鎖改採不可變 owner/token 記錄與原子硬連結發布；死亡 guard 保留，接管者競爭同一 token 對應的後繼 guard，避免互刪另一人的新鎖。活著／未知持有者不接管，鏈深度有限、token 驗證，支援同實例暫時刪除失敗重試。`test-lease-recovery.cjs` 覆蓋死亡多代、活鎖、未知／毀損、交錯接管、鏈上限與硬連結失敗，雲端 PASS。
- progress 新測試另對基準程式補驗，在 EACCES 讀取失敗時確實拋出未捕捉例外；新版同情境局部回報錯誤。
- 程序身分快照與 `process.kill(pid)` 仍是兩個操作，並非 Windows process handle 級的原子身分終止；不可宣稱杜絕所有 PID 重用競爭。

使用者後續授權建立 PR，並在 Windows CI 全綠且無重大問題後合併；實際遠端 CI／合併結果另以 GitHub 為準。本文件只記已執行的雲端驗證，不預填未發生的成功。

## 第一輪 Windows CI 回饋

PR #57 的 `dd7cfbb` 在 `test-cleanup` 的早期 Stop 情境失敗：spawn 後先保存 PID，首次身分查詢仍在執行；Stop 立即帶著不完整身分終止，被新增的安全檢查拒絕。測試隨後刪工作目錄遇 EBUSY，並有尚未接錯誤處理的 promise 拒絕。

修正為 spawn 時保存唯一的身分查詢 promise；Stop 等待該次已發起查詢後才使用原身分，不另以新查詢重新認定未知 PID。查詢失敗、資料不完整或 child 已退出仍保守處理；不移除身分驗證。新增可控延遲回歸，並讓 Windows 測試及早處理 promise 拒絕，以免清理錯誤遮蔽真正原因。完整 Windows CI 需以修正後新 head 重跑確認。
