# Multi-Agent Platform

[繁體中文](#繁體中文) · [English](#english)

> **v0.1.0 預覽版 / preview** — 實驗性專案，只適合拋棄式或有版本控制的專案。 / Experimental. Use it only on disposable or version-controlled projects.
>
> 授權 / License: [GPL-3.0](LICENSE)

---

## 繁體中文

Windows 優先的多 AI 協作平台。**Multi-Agent Studio** 是一個本機網頁：Claude Code、Codex、Antigravity 組成一個團隊，你選一位當「工頭」，其他是「成員」。你用白話說要做什麼，工頭拆成工作卡派給成員，成員在你的專案資料夾裡動手做，工頭最後確認整件事是否真的完成。

### 快速開始

1. 安裝 [Node.js](https://nodejs.org)，並先登入要用的 AI：`claude auth login`、`codex login`（Antigravity 需先安裝並登入）。
2. 雙擊 `start-studio.cmd`，瀏覽器會打開 `http://127.0.0.1:4848`（連接埠被佔用時自動改用下一個）。關掉黑色視窗就會停止。
3. 在左側「開啟專案」選一個資料夾，在「今天想讓『專案名』做什麼？」輸入需求，按「▶ 交給團隊」。

第一次啟動會下載 AionCore v0.2.2 到 `runtime/`，驗證官方 ZIP 與執行檔的 SHA-256；之後每次啟動也會驗證執行檔。損壞時先在暫存目錄驗證完整安裝，再替換執行檔，舊檔保留為 `aioncore.exe.unverified-*.bak`；下載／解壓縮／替換失敗會保留原檔並停止啟動。

Studio 的 Codex 使用獨立資料夾（`runtime/studio/codex-home`），不會出現在你平常的 Codex 紀錄裡；第一次要在 Codex 卡片按「登入 Codex（Studio 專用）」。沒有規則檔時，Studio 會複製全域 `~/.codex/AGENTS.md` 並記錄來源與雜湊；之後重啟只更新未被修改的管理副本，來源刪除時也只移除該副本。既有未標記的規則檔（含舊版副本）、自訂內容、連結檔一律保留，需自行維護；`STUDIO_CODEX_HOME` 同樣適用。Claude 本來就會讀 `~/.claude/CLAUDE.md`。

使用獨立 `STUDIO_RUNTIME` 測試時，預設也會建立未登入的 Codex home。可明確設定 `STUDIO_CODEX_HOME` 指向已登入的 **Studio 專用目錄**；登入、可用性檢查與 Agent 執行會使用同一目錄，不複製憑證。這會共用該 home 的 Codex 設定、登入與 session 紀錄；Studio 工作卡、租約及測試資料仍位於獨立 runtime。未設定時維持原本的隔離方式。

### 功能

**多專案同時工作**
- 每個專案一個分頁，各自有工頭、成員、模型、工作卡、對話、暫停／Stop 和歷史；切換分頁不會停止工作。
- 關閉專案分頁後，再開啟同一個資料夾會帶回專案名稱、團隊與模型、交付方式、預算、長期目標及定時工作。Studio 重開後也會保留這些設定；分頁關閉期間排程暫停，已暫停的工作可從歷史紀錄接續。
- 「總覽」頁：每個專案一張卡（狀態、進度、下一步、你要做什麼）、一鍵暫停／繼續、「誰在做什麼」表格。
- 每個專案完成或需要你處理時發 Windows 通知，點通知會打開該專案分頁。每日 API 用量達 80% 時，通知內文會列出已用 tokens 與當日上限。
- Studio 網頁在第一次播放提醒時才啟用音訊裝置。工作完成的兩個提示音由低到高，需要你處理時則由高到低。關閉通知會取消尚未播放的提示音，重新開啟後只播放新的提醒。

**工作流程（不用盯著看）**
- 成員每次回覆都要標明狀態：完成／等外部結果（例如 CI）／等其他 AI／問工頭／需要你決定。一回合結束不等於完成。
- 成員遇到「怎麼做」的問題（兩種合理做法選哪個、需求缺一個細節）先問工頭，不問你：工頭只看需求和工作卡回答（不讀檔、不跑指令），答案送回成員原本的對話接著做；工頭判斷是只有你能決定的產品問題時，才用白話問你。同一張卡最多問 2 次，第 3 次整張卡交給工頭自己完成。
- 在等的工作卡會自動接續：等的 AI 做完、GitHub PR 的 CI 跑完（用 `gh`，每分鐘檢查）、或你回覆。Studio 無法自己確認的等待（例如 nightly build）：先每 5 分鐘請成員自己看一次、最多 3 次，之後才明說「需要你按繼續」，不會假裝在背景等；查 PR 狀態失敗會先重試兩次。
- 專案有自己的後端服務時，在專案頁填「驗證用後端 port」：成員會請 Studio 代管啟動它，卡片在等它時 Studio 自動檢查 health 並安全恢復；留空就完全不管。
- 工作卡分三種：🛠 實作、🔍 檢查（能用證據對照的，給最便宜的成員，結果 PASS／FAIL）、🛡 審查（寫的人不審自己；不可逆的步驟前一定有一張強模型審查）。每張卡都要寫驗收標準。審查是 NO-GO 或檢查是 FAIL 時，後面的卡不會開始，交回工頭安排修正。檢查卡不改專案檔案，但一定要真的執行測試／建置（不放在唯讀沙盒裡，也不和寫的人共用對話）；審查卡才是唯讀。任何一張卡的 AI 超過 15 分鐘沒有任何新訊息（例如一個指令掛住），Studio 會停掉那一步並交給工頭決定重試；停掉之前先找活著的證據：那個指令還在跑而且專案檔案 90 秒內還在變、或它的程序 20 秒內有用到 CPU／新開子程序，就再等 15 分鐘（最多 3 次；單步 3 小時上限不變），找不到證據才停。Codex 的程序 Studio 認得到，Claude／Antigravity 看的是 AionCore 底下其他程序，只會多等、不會提早停。派給 Claude 的檢查卡、強模型審查卡，會交給你在 `~/.claude/agents/` 的 checker、reviewer 子 agent（沒有就自己做）。
- 檢查或審查開始及回報通過時，Studio 會比對實際工作樹的 HEAD 和檔案指紋。如果驗證期間版本改變，這張卡會標為結論已過期，交由工頭安排重驗。把檢查或審查卡改派、交接後重跑，會從重跑當下的版本重新比對。相依卡開始前若版本已改變，活動紀錄也會列出前後版本。驗證後若有寫入卡改檔，工頭收尾時也會看到提醒。沒有 Git 或 HEAD 的資料夾會記錄「無法綁定版本」，仍可繼續工作。
- 按「繼續」後，若寫入卡還在核對前一張卡的驗證版本，按「停止」就會取消這次派工。等核對與停止清理結束，未完成卡會標為失敗並釋放寫入租約，下一件工作就能使用同一個資料夾。
- 若舊版在這時停止，留下「工作中」的卡與寫入租約，升級後第一次開啟 Studio 會核對停止紀錄，將該卡標為失敗並歸還租約。同資料夾可以再派寫卡，其他工作的租約仍由原持有者保留。
- 工作卡可以設定「等前一張完成才開始」。全部做完後，工頭會確認整體需求是否真的完成，沒完成會自己追加工作卡（最多 3 輪，之後問你）。
- 相依卡首次進入工作資料夾時會核對前置結論。同一張卡改檔後等待你的回覆，回到原資料夾可以接著做。換到獨立 worktree 時會再核對一次。
- 「現在發生什麼」：進度、在等什麼、接下來誰做什麼、你現在要不要處理（🔴 需要 Nana，可直接按選項回覆）。

**自動交付與寫入鎖**
- 交付方式（每個專案，預設 🚚 自動做到 merge）：需求清楚、沒有高風險時，AI 一路做完：修改 → 針對性驗證 → commit → push → PR → CI → 一次 review → 修正 blocker／有效 finding → CI → squash merge → 同步 main → 清理分支 → 下一張卡，不會因為 commit、push、開 PR、CI 通過或正常 merge 停下來等你。只有以下情況才問你：需求有重大歧義、可能永久遺失你的重要資料、需要新的付費服務／憑證／外部發布、review 的 blocker 無法在原範圍安全修正、CI 持續失敗且最小修正無效、merge conflict 碰到你或其他 AI 還沒提交的修改、無法合理回滾的操作。一般 P1/P2 review 意見直接在原 PR 修正並補測試。可改成「✋ 做到 PR 就停（merge 等我）」。
- **工作區租約（Workspace Lease）：同一個實體資料夾同一時間只有一位寫入者。** 任何會修改檔案的工作，在 Agent 真正啟動前必須先拿到這個資料夾的「寫入租約」；拿不到就不啟動，也不會偷搶。租約記錄：資料夾（路徑經過正規化，大小寫、斜線不同也算同一個）、repository、branch、哪個 job／工作卡、哪個 Agent、讀或寫、開始時間、最後心跳、狀態；存在 `runtime/studio/leases.json`，Studio 重開後仍知道重開前誰持有。狀態：`ACTIVE`（正在執行）、`RESERVED`（暫停或等待中，仍屬於原持有者）、`STALE`（持有者已消失：已確認 Studio 行程不在；心跳逾時本身不算）、`RELEASED`。唯讀的工作（Review、讀程式、查 GitHub）不需要租約、可以多位同時，而且 Codex、Claude 以不可寫入的模式啟動（read-only、dontAsk），不只靠提示（Antigravity 的不可寫入模式會讓工具在中文路徑下全部被擋，所以仍靠提示）；不同的 git worktree 各自有自己的寫入者。
- **被擋下時**，工作卡不是籠統的「等待」，而是寫出「此工作區目前由 Claude Code 使用中（工作卡「…」），branch …，幾點開始，狀態」，並給三個選項：① 等待（Studio 自動再試）、② 改成唯讀 Review、③ 使用獨立 worktree（建立自己的 branch 和資料夾，各自有租約；merge 後自動清掉）。專案根目錄有 `.worktreeinclude`（一行一個被 gitignore 的路徑，例如 `.env`、`node_modules`，`#` 是註解）時，檔案會複製、資料夾會用 junction 連結進新 worktree，清理時一併移除；不存在、有追蹤、沒被 gitignore、萬用字元或 repo 外的路徑會略過並寫在紀錄裡。專案頁「worktree 建好後執行」可填一個指令（例如 `npm ci`），新 worktree 建好後先在裡面跑完（10 分鐘內）卡片才開始；準備期間（建立 worktree 和跑指令）卡片不會開始，也不能交接，專案不能關閉；外部接手會等它完成，按停止會終止指令（連同它開的子程序），超過 10 分鐘也是整棵程序樹一起終止，Studio 在途中關掉的話，重開時會終止還在跑的那個指令（只認同一個程序，不會誤殺重用的 PID），確認它真的結束後卡片才解除準備狀態，按「繼續」或外部接手都會等這一步；終止失敗時卡片保持阻擋並記下原因，下次按「繼續」、Stop、開新工作或外部接手會再試，確認前這些都會被拒絕；如果 Studio 關掉得太早、沒記到程序建立時間，而那個 PID 還在跑，Studio 無法確認它是不是同一個程序，就不終止、只保持阻擋，等你自行結束它；Stop 的終止失敗時工作保持暫停（重開後仍會接續清理），同一個專案的開始和繼續一次只跑一個（完整狀態與各入口的處理見 [docs/worktree-setup-lifecycle.md](docs/worktree-setup-lifecycle.md)）；失敗只記在紀錄、卡片照樣開始。它產生的被忽略檔案，只有在清理時和它剛做完時一樣（比對每個檔案的名稱、大小、修改時間，不是內容雜湊）才會跟著 worktree 刪掉（`node_modules` 可重建，一律刪），之後有人放進新檔或改過就保留整個 worktree；`.worktreeinclude` 的複本不算它的產物。專案頁固定顯示「寫入者／資料夾／branch／唯讀者」。merge 後清理 worktree 失敗時：網路／gh、GitHub 還沒顯示 merge、檔案被鎖住這類會自己好的原因，1 分鐘、5 分鐘後自動再試（最多失敗 3 次）；不是本卡的 worktree、還有修改、分支被移動過則馬上停下。工作卡上有「重試清理」和「保留」。
- **交接（Handoff）**：專案頁「改由…接手」。流程：停下現在的寫入者 → 保存這張卡、對話、進度 → 等它真的停住（沒停住就不交接）→ 放下它的租約 → 新的 Agent 取得租約、從目前的資料夾和 branch 接續。新的 Agent 會收到舊 Agent 在這張卡對話的最後一段原文（約 1.2 萬字以內，較早的省略並註明），不是 AI 寫的摘要。舊 Agent 的對話和紀錄保留，但不再是寫入者，也不會因為恢復或重開而拿回來。
- **重開安全**：重開後 Studio 不會因為看到暫停／中斷的工作就直接恢復寫入。要「繼續」前會重新檢查租約：資料夾已經由另一個 Agent 或外部接手時，顯示「工作區已由另一個 Agent 接手，本工作保持暫停」；租約還是自己的才允許。Studio 當掉留下的租約不會永遠鎖死：確認 Studio 持有者行程不在後，活躍租約才判定 `STALE`，才能被安全接手；持有者明確還活著時，不會被搶。
- **外部 Agent／非 Studio 的修改**：另一個 AI 視窗或你自己要改這個資料夾時，宣告接手（專案頁「外部 Agent／我要自己改」，或用 API）：Studio 會停下並暫停自己的寫入、等它真的停住（worktree 正在建立或跑設定指令時，也等那個指令結束）、放下自己的租約，租約改成外部持有；原本的 Studio 工作保持暫停，重開也不會自己恢復。做完用「外部已歸還」或 release-claim。宣告時可帶 `pid` 作為資訊；外部租約狀態為 `EXTERNAL`，即使行程退出或 Studio 重開也保留，必須明確 release-claim 才歸還。
- **本機 API 通行碼**：`/api` 只接受帶 `x-studio-token` 的請求，避免同一台電腦上的其他程式或沙箱 Agent 冒用你的身分下指令（Studio 開的頁面會自動帶）。通行碼每次啟動 Studio 都會換新、只放在記憶體，不寫進檔案；Studio 自動開的網頁會記住它，自己打開 `http://127.0.0.1:4848` 看到「沒有通行碼」時，請從 Studio 視窗印出的網址進入一次（`#t=` 後面那串就是通行碼）。宣告外部接手（claim）不需要通行碼，歸還（release-claim）需要。
```
curl -X POST http://127.0.0.1:4848/api/workspace/claim -H "content-type: application/json" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\",\"label\":\"Claude 視窗\",\"pid\":1234}"
curl -X POST http://127.0.0.1:4848/api/workspace/release-claim -H "content-type: application/json" -H "x-studio-token: <Studio 視窗網址中 #t= 後面那串>" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\"}"
```
- **來源不明的修改**：持有租約的 Agent 沒有在執行、資料夾卻被改動，或寫入期間出現另一個程式的鎖定檔，Studio 會標記 `EXTERNAL_MODIFICATION_DETECTED`、停止寫入並暫停，**不會 reset、不會 stash、不會覆蓋**；你確認後按「確認接手並繼續」。（Agent 執行當中的修改，無法分辨是它自己改的還是別人改的，所以規則要求 Agent 的檔案修改都在自己的回合內完成、不要留下會改檔案的背景程序。）成員每一步結束要用 `FILES:` 回報它改了哪些檔；Studio 比對這一步前後的檔案快照，有變動卻不在清單的檔會寫進活動紀錄與事件（只記錄，不阻擋、不改檔）。
- 租約之外，另有一個放在 git 目錄的 `studio-writer.lock` 供不認識 Studio 的程式查看，以及每次停止寫入時記下的資料夾指紋（HEAD、branch、未提交檔案）：自動恢復前比對，幾秒前才被改過就等、離開期間被改過就先問你。
- **暫停 vs 停止**：暫停＝成員馬上停下（手上那一步可能做到一半）、卡片和對話都保留、租約改成 `RESERVED`（工作仍屬於它）、Studio 不會自己恢復（重開也不會），要你按「繼續」，而且繼續前會重新檢查租約。停止＝這件工作到此為止、終止執行、釋放租約、未完成的卡標成失敗、不能再「繼續」、重開也不會復活；卡片、對話和紀錄都保留，要接著做用「▶ 接著處理」開新的一輪。

**專案記憶與接續**
- 每個專案保存「專案狀態」：上次目標、已完成、目前、下一步，並用 `git`／`gh` 核對真實狀態（main SHA、開著與已合併的 PR、每項 CI、未解決的 review 意見）。Git／GitHub 的結果優先於 AI 以前留下的文字。
- 重開 Studio、按「▶ 接著處理」或更換工頭，都會拿到同一份接力棒，不用重新解釋。

**中途控制**
- 工作進行中可以「📣 告訴工頭」補充或修改指示：工頭決定轉告哪位成員、取消或追加工作卡。送出方式三選一：「🕒 這一步做完再轉達」（預設）、「💬 插話」（不打斷，直接送進 Claude／Codex 正在做的這一步；其他成員或來不及送進去時自動改成做完再轉達）、「⚡ 立刻打斷」（正在做的成員馬上停下，看完指示再接著做）。成員的規則檔不是自己那一份時（例如專案只有 CLAUDE.md，卻派給 Codex），工作卡會請它先讀那份規則，Studio 不會替你複製或新增規則檔。
- 「做完之後」：① 完成就停（預設）、② 完成後建議 1–3 個下一步、③ 自動持續開發（需自己開啟並確認；預設最多連續 5 件，可改，0＝不限，一直做到工頭沒有下一步、失敗、需要你決定或你停下）。

**長期目標與定時工作**（專案頁「🎯 長期目標・⏰ 定時工作」）
- 按下「＋ 新增」後，這個專案會等儲存完成才再次開放新增，連點只會建立一筆定時工作。
- 長期目標：每個專案一段話，工頭規劃、每張工作卡、最後的整體確認都會帶著它，讓 AI 知道「為什麼做」，但仍只做這次交辦的事。
- 定時工作：設定「星期幾＋HH:MM」和一段需求，時間到就自動「交給團隊」，照這個專案的交付方式做，並發 Windows 通知。專案正在工作或暫停時不會插隊，等它空下來只跑一次（錯過好幾次也只跑一次）；開始失敗（例如工頭不可用）會通知你，不會每分鐘重試。修改或重新開啟一個定時工作時，從現在起算，不會補跑過去的時間。可加「前置檢查」：一個指令（在專案資料夾執行，30 秒內要結束），結束碼不是 0 就略過這次、不花額度，畫面顯示「上次略過」；檢查期間專案忙起來，這一格照樣等它空下來。
- 同一個專案有多筆定時工作同時到期時，會逐筆執行。上一件工作結束後，下一次排程檢查優先啟動尚未跑過或最久沒有執行的那一筆。
- 事件紀錄：`runtime/studio/events.jsonl` 一行一筆，記錄所有專案的操作（每個 API 操作、工作開始／結束、定時工作與自動持續開發觸發）。只記 id 和設定值，不記需求內容、指示或 API key；每件工作的對話與工作卡仍在 history 裡（`job` 就是 history 檔名）。事件檔每 5 MiB 輪替，保留 `.1` 到 `.5` 五份備份（`.1` 最新），超出時淘汰最舊事件備份；history 不受影響。

**省額度**
- 工頭不讀檔、不查 repo、不跑指令，只規劃與確認；調查和動手都交給成員。Claude Code 只在 Codex 和 Antigravity 做不了時才拿到工作卡。
- 模型策略（每個專案）：💰 省額度（預設，普通卡 Sonnet／Luna，困難卡自動升級 Opus／Sol）、⚖️ 均衡、🚀 品質優先、🛠️ 自訂。工頭固定用強的那檔（它負責規劃和拍板，回合少但錯了最貴）；成員的普通卡用便宜的，工頭自己判斷普通或困難，普通卡失敗會自動改用強模型重試一次。
- 每張卡 token 上限（每個專案，預設 0 = 不限）：一張卡用超過就停下來標成失敗，交給工頭決定要不要換方法重試。只在每一步之間檢查，正在跑的那一步不會中斷；AI 沒回報用量的卡無法計算。
- 在專案頁設定「外部 API 每日 token 上限」（0＝不限）。Studio 依本機日期加總外部模型工作卡的輸入與輸出 tokens，每一步只計入該對話新增的用量。達 80% 時每天提醒一次，額滿後，下一張外部卡或卡內的下一步會顯示「今日 API 預算已用完」。只在步驟之間檢查，可能略微超出。調高上限或隔天按「重新檢查預算」即可繼續，也可以改派其他成員。重開 Studio 會保留當日用量。
- 員工卡顯示 Claude（5 小時＋每週）與 Codex（每週）的額度條。Claude 額度只在 Studio 啟動和按「更新」時讀取一次。
- **收尾者**：每個專案可指定一位便宜成員（例如本地模型）。CI 跑完後，merge／同步 main／清分支改由它接手，原成員的額度留給寫程式；等 CI 本身不花額度（Studio 自己用 `gh` 查）。
- **撤出成員**：員工卡上「⏏ 撤出，卡改派給…」。額度用完時把它移出這個專案，手上未完成的卡（正在寫入的會先停下再交接）改派給你選的人。
- **額度用完到點續做**：成員回報額度用完或被限流、又沒有設「備援」成員時，那張卡停在「在等」，到額度重置時間自動交回同一位成員接著做（時間依序取：已滿的 5 小時／每週額度重置時間、錯誤訊息寫的時間、都沒有就 1 小時後；每張卡最多 5 次）。餘額不足、要儲值的錯誤不會等，照舊失敗。
- **外部模型（API）**：總覽頁「外部模型（API）」按「＋ 新增外部模型」，填顯示名稱、API 格式（OpenAI 相容／Anthropic／Gemini）、Base URL、API Key、模型名稱（可按「取得模型清單」挑選；網址已是完整請求位址時勾選對應選項），按「儲存並測試」。它會成為和 Codex、Claude 一樣的團隊成員（可當工頭或成員，會讀寫專案檔案，同樣受工作區租約管理）。API key 只交給 AionCore 加密保存，Studio 的設定檔、畫面、紀錄都不含 key；編輯時 key 留空 = 不變；本機位址（如 Ollama）可不填 key。切換供應商或修改連線欄位時，選單會清掉舊的模型清單；只有目前查詢的結果會顯示。每個外部模型固定一個模型名稱，要換模型就新增一個。
- **ACP Agent**：總覽頁「ACP Agent」按「＋ 新增 ACP Agent」，從 AionCore 內建的 ACP agent 清單（Gemini CLI、OpenCode、Kimi、Cursor…，標示已安裝／未安裝）選一個，或用自訂指令（顯示名稱、啟動指令、參數），按「加入並測試」。它會成為和 Codex、Claude 一樣的團隊成員，用你電腦上那個 CLI 自己的登入。成員卡用該 agent 的「全部允許」模式（清單有提供時），否則用預設模式並由 Studio 允許權限詢問；工頭和唯讀的審查卡用預設模式，Studio 拒絕所有權限詢問（預設模式不詢問就改檔的 agent，唯讀只靠提示約束）。未安裝的 agent 會顯示 AionCore 的安裝提示。
- **工作詳情／詢問進度**：工作中的卡、員工卡、總覽「誰在做什麼」都顯示「🟠 工作中 · 14 分鐘 · 最近活動 1 分鐘前」；超過 8 分鐘沒有新活動顯示「🟡 可能卡住」（只是提醒，不會停掉它，工作很久本身不算卡住）；等工具確認、等 CI 會直接寫出來。按「查看工作詳情」看開始時間、已執行多久、最近活動（白話）、最近一句 AI 訊息，完整執行紀錄預設收合。會改檔案的卡，每一步（一次派工到它回報）結束後都記下前後的檔案快照，詳情裡按「第 N 步」就看到那一步的 diff，做完的卡也能看。快照用暫存的 index 寫成 git tree，不改 HEAD、index 或檔案，也不執行 repo 設定的 filter 程式；每一步的快照另外記在 repo 的 `refs/studio/steps/` 底下（一般 push 不會推上去；寫入時不執行 repo 的 hook），git gc 不會清掉；超過 90 天的在下次有新步驟時刪除，之後就看不到那一步的 diff。看 diff 時可以按「↩ 復原這一步」：只把那一步改的檔案改回去（commit、branch、index 不動），有卡片正在改檔案、或之後又改過同一個檔案時什麼都不改；復原本身也記成一步，可以再復原回去。「💬 詢問進度」或在詳情裡自己打問題：不會中斷工作、不會新增工作卡、不拿寫入租約。能在工作中途插話的 AI 會馬上收到；若它不在工作中途回答（實測 Claude Code、Antigravity 都是這樣），Studio 會在它這段工作告一段落（例如卡片在等 CI）時補問；卡片在那之前就做完時，照實顯示「問題送達前這張卡已經結束」和它最後的回報，畫面會照實寫「已詢問，等待 AI 回覆」。工頭看到的工作卡也帶有工作時間、最近活動和「可能卡住」提示。 同一分頁裡尚未送出的進度問題會留在原專案的工作卡，回到該卡可以接著寫。

### 已知限制（v0.1.0）

- 「模型策略」搭配真的 Codex、以及困難卡實際自動升級，目前只用模擬回覆驗證過；其餘功能已在真實專案（PDF 編輯器、股票面板）上使用。
- 本機 CI：`.\scripts\ci.ps1 -Mode Auto`（語法與模擬 AI lifecycle／租約測試）；真實 provider 操作另行驗證。
- 固定版本契約：`node studio/test-aion-contract.mjs`，以真實 AionCore＋本機 ACP fixture 驗證登入、模型設定及對話不重啟，不呼叫付費模型；GitHub 另有獨立 gate。範圍與限制見[供應商契約測試](docs/provider-contract.md)。
- **W1 程序隔離尚未通過**：提供 [AionCore managed-spawn 部分修補與無模型驗證入口](docs/w1-managed-spawn.md)，只封閉 managed-process 指派 Job 的競態，不處理 Store PowerShell activation 逃逸；不自動替換正式依賴。真實 Claude cancel／restart／session 恢復仍待額度重置後驗收。
- 要用隔離 Chrome 實際檢查「繼續」、模型清單或辦公室效能，可執行 `pwsh -File .\scripts\start-test-studio.ps1`。操作與測試用 MCP 設定見[瀏覽器驗證指南](docs/browser-verification.md)。
- 測試用 Studio：設定 `STUDIO_RUNTIME` 指向另一個資料夾，就會用自己的設定、歷史、租約和 AionCore 資料，不碰你平常的 `runtime/`（AionCore 程式共用）。例如 PowerShell：`$env:STUDIO_RUNTIME="$env:TEMP\studio-test"; $env:STUDIO_PORT=4859; node studio/server.mjs`。只拿拋棄式專案測：兩個 Studio 的租約互相看不到。
- 「告訴工頭」預設不會中途打斷成員正在做的那一步；「💬 插話」只把話送進去、不停下（Claude／Codex），要停下請用「立刻打斷」。
- AionCore 在 Antigravity 工作時，會在專案裡寫一個 `.agents/` 資料夾。
- 目前只支援 Windows。

### 安全

**成員會在你選的資料夾裡直接修改檔案、執行指令，不會先問**（Claude：`bypassPermissions`，Codex：`auto`）。Git worktree 不是安全沙箱。只適合拋棄式或有版本控制、不含敏感資料的專案；用在正式環境專案或有機密憑證的資料夾，尚未被核准。

### 文件

- [Workspace lease API 與生命週期](docs/workspace-lease.md)
- [Runtime ownership 與後端恢復](docs/runtime-ownership.md)
- [多模型協作設計原則](docs/multi-model-principles.md)
- [Orca 對照評估：可借鑒與不需要借的地方](docs/orca-comparison.md)

### 授權

以 [GNU GPL v3.0](LICENSE) 授權。你可以使用、修改、散布；散布修改後的版本時，必須同樣以 GPL-3.0 公開原始碼。AionCore 是另外下載的第三方程式，有它自己的授權，不包含在本授權內。

---

## English

A Windows-first multi-agent collaboration platform. **Multi-Agent Studio** is a local web page where Claude Code, Codex and Antigravity work as one team. You pick one as the **Leader**; the others are **Workers**. You say what you want in plain words, the Leader splits it into cards and assigns them, Workers do the work inside your project folder, and the Leader finally checks that the whole request is really done.

### Quick start

1. Install [Node.js](https://nodejs.org) and log in to the agents you want: `claude auth login`, `codex login` (Antigravity must be installed and logged in).
2. Double-click `start-studio.cmd`. The browser opens `http://127.0.0.1:4848` (the next free port is used if it is taken). Close the console window to stop.
3. Open a project folder in the sidebar, type what you want under "今天想讓「<project>」做什麼？", and press "▶ 交給團隊".

The first start downloads AionCore v0.2.2 into `runtime/` and verifies both the official ZIP and executable SHA-256. Each later start verifies the executable too. Repairs are extracted and verified in a staging directory before publication; the old executable is retained as `aioncore.exe.unverified-*.bak`. Download, extraction or replacement failures leave the old file intact and stop startup.

Studio runs Codex with its own home (`runtime/studio/codex-home`), so its sessions never appear in your normal Codex history; log in once with the "登入 Codex（Studio 專用）" button. If no rules file exists, Studio copies global `~/.codex/AGENTS.md` and records its source and hash. Later starts update or remove only an unchanged managed copy. Unmarked existing files (including legacy copies), custom edits and links are preserved for manual maintenance, including in `STUDIO_CODEX_HOME`. Claude reads `~/.claude/CLAUDE.md` on its own.

A separate `STUDIO_RUNTIME` also gets a fresh, unauthenticated Codex home by default. Set `STUDIO_CODEX_HOME` explicitly to an authenticated **Studio-specific directory** to reuse its login without copying credentials. Login, availability checks, and execution use that same home, including its Codex configuration and session history; Studio cards, leases, and fixture data remain in the separate runtime. Without this override, the existing isolation behavior is unchanged.

### Features

**Several projects at once**
- One tab per project with its own Leader, Workers, models, cards, chat, pause / Stop and history. Switching tabs never stops work.
- Overview tab: one card per project (status, progress, next step, what you must do), one-click pause / continue, and an agents × projects table.
- A Windows notification when a project finishes or needs you; clicking it opens that project tab.

**Autonomous delivery and the writer lock**
- Delivery (per project, default 🚚 auto to merge): when the request is clear and nothing is high-risk, the AI goes all the way: change → targeted validation → commit → push → PR → CI → one review → fix blockers / valid findings → CI → squash merge → sync main → delete the branch → next card. It does not stop for a commit, a push, a PR, green CI or a normal merge. It asks only for: a materially ambiguous requirement, a destructive operation that could permanently lose your important data, a new paid service / credential / external publication, a review blocker that cannot be fixed safely inside the original scope, CI that keeps failing after a minimal fix, a merge conflict touching uncommitted changes of you or another agent, or anything that cannot reasonably be rolled back. Ordinary P1/P2 review findings are fixed inside the original PR with a regression test. Switchable to "✋ stop at the PR (you merge)".
- **Workspace lease: one writer per physical working tree.** Before an agent starts any work that modifies files, Studio must obtain the write lease of that folder; if it cannot, the agent is not started and nothing is stolen. A lease records the folder (path canonicalized: case and slash differences are the same tree), repository, branch, job / card, agent, read or write, start time, last heartbeat and status, and lives in `runtime/studio/leases.json`, so after a restart Studio still knows who held the tree. Status: `ACTIVE` (executing), `RESERVED` (paused or waiting, still the owner's), `STALE` (the owner is gone: confirmed dead Studio process; silence alone is insufficient), `RELEASED`. Read-only work (review, reading, GitHub) needs no lease, any number may run, and Codex / Claude start it in their non-writing mode (read-only, dontAsk), not just on a prompt (Antigravity's non-writing mode blocks every tool under a non-ASCII path, so it keeps the prompt fence); different git worktrees each have their own writer.
- **When refused**, the card does not just say "waiting": it says "this workspace is currently used by Claude Code (card …), branch …, since …, status …" with three options: ① wait (Studio retries), ② switch to read-only review, ③ use an independent worktree (own branch and folder, own lease; cleaned up after merge). With a `.worktreeinclude` at the repository root (one gitignored path per line, e.g. `.env`, `node_modules`, `#` comments) files are copied and directories junction-linked into the new worktree and removed again at cleanup; missing, tracked, not-ignored, wildcard or outside paths are skipped and named in the log. The project page field "worktree 建好後執行" takes one command (for example `npm ci`) that runs in a new worktree before its card starts (10-minute limit); while the worktree is made and the command runs, the card neither starts nor can be handed off and the project cannot be closed; an external claim waits for it, Stop ends the command with everything it started (so does the 10-minute limit), and a Studio restarted after closing mid-setup ends the command it left running (only that very process, never a reused PID) and keeps the card blocked until that process is confirmed gone, so Resume and an external claim wait for it; if it cannot be ended the card stays blocked with the reason, and the next Resume, Stop, new job or claim tries again (each refused until then); if Studio closed before the creation time was recorded and that PID is still alive, it cannot tell the process from a reused PID, so it does not kill it and keeps the card blocked until you end it yourself; a Stop whose kill fails keeps the job paused (so a restart picks the cleanup up again), and Start / Resume of one project run one at a time (states and every entry point: [docs/worktree-setup-lifecycle.md](docs/worktree-setup-lifecycle.md)); a failure is logged and the card starts anyway. An ignored path it made goes with the worktree at cleanup only while it is as the command left it (every file's name, size and modification time; not a content hash) (`node_modules` is rebuildable and always goes); a file added or changed there later keeps the whole worktree. `.worktreeinclude` copies never count as its output. The project page always shows writer / folder / branch / readers. When cleaning up a worktree after the merge fails for a reason that may pass (network / gh, a merge GitHub does not show yet, a locked file), Studio tries again after 1 and 5 minutes (3 failures at most); a worktree that is not the card's, still has changes, or whose branch moved stops at once. The card offers "重試清理" (retry) and "保留" (keep).
- **Handoff**: "改由…接手" on the project page. Flow: stop the current writer → save its card, conversation and progress → wait until it has really stopped (no handoff if it has not) → release its lease → the new agent takes the lease and continues from the current folder and branch. The new agent gets the last part of the old agent's conversation on the card as quoted messages (about 12,000 characters; older ones are left out and counted), not an AI-written summary. The old agent's conversation and history stay, but it is no longer the writer and cannot get the role back by resume or restart.
- **Restart safety**: after a restart Studio never resumes writing just because it sees a paused / interrupted job. Before "continue" it re-checks the lease: if another agent or an external party now holds the tree it says "the workspace was taken over by another agent, this job stays paused"; only the lease's own owner may resume. A lease left by a crashed Studio never locks forever: when the Studio holder process is confirmed gone its active lease is `STALE` and can be reclaimed; a holder that is clearly alive is never taken over.
- **External agents / non-Studio edits**: when another AI window or you want to edit the folder, declare it (project page button, or the API): Studio stops and pauses its own writers, waits until they really stopped (and until a worktree being made or set up has finished its command), gives up its lease and records the external owner; the paused Studio job stays paused and a restart does not revive it. Give it back with "外部已歸還" or release-claim. A claim can carry a `pid` for reference. Its `EXTERNAL` ownership survives process exit and Studio restart and requires explicit release-claim.
- **Local API pass**: `/api` only accepts requests with `x-studio-token`, so other programs or sandboxed agents on the same PC cannot act as you (the page Studio opens sends it). The pass is new at every Studio start and kept only in memory, never in a file; the page Studio opens remembers it. A page opened without it asks you to use the URL printed in the Studio window once (the part after `#t=` is the pass). A claim needs no pass; release-claim does.
```
curl -X POST http://127.0.0.1:4848/api/workspace/claim -H "content-type: application/json" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\",\"label\":\"Claude window\",\"pid\":1234}"
curl -X POST http://127.0.0.1:4848/api/workspace/release-claim -H "content-type: application/json" -H "x-studio-token: <the part after #t= in the URL the Studio window prints>" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\"}"
```
- **Unknown changes**: if the lease holder is not executing but the folder changed, or another program's lock file appears while it writes, Studio flags `EXTERNAL_MODIFICATION_DETECTED`, stops writing and pauses; it does **not** reset, stash or overwrite; after you confirm, press "確認接手並繼續". (Changes made while an agent is executing cannot be told apart from its own, so the rules require agents to finish all file changes inside their own turn and leave no background process that edits files.) Every worker step ends with a `FILES:` line naming the files it changed; Studio compares the tree before and after the step and records any changed file missing from that list in the activity and events (recorded only: nothing is blocked or touched).
- Besides the lease there is a `studio-writer.lock` in the git dir for programs that know nothing about Studio, and a fingerprint of the tree (HEAD, branch, uncommitted files) taken whenever Studio stops writing: compared before an automatic resume (files changed seconds ago → wait; changed while away → ask you).
- **Pause vs stop**: pause = workers stop now (the current step may be half done), card and conversation are kept, the lease becomes `RESERVED` (the work still belongs to its owner), Studio never resumes it by itself (not even after a restart), you press "繼續", and the lease is re-checked first. Stop = this job ends for good: execution is terminated, the lease is released, unfinished cards fail, no "繼續", no revival after a restart; cards, conversations and records are kept, use "▶ 接著處理" to start a new round.

**Workflow (hands-off)**
- Every worker reply states a status: done / waiting for something external (e.g. CI) / waiting for another agent / asking the leader / needs your decision. A turn ending is not "done".
- A worker's question about HOW to do its task (two reasonable ways, a missing detail) goes to the Leader, not to you: the Leader answers from the request and the cards (no files, no commands) and the answer returns to the worker's own conversation; only when the Leader judges it a product decision that only you can make does it ask you, in plain words. At most 2 questions per card; the third hands the whole card to the Leader.
- Waiting cards continue by themselves when the awaited agent finishes, when a GitHub PR's CI finishes (`gh`, checked every minute), or when you answer. A wait Studio cannot check (e.g. a nightly build): the worker is asked to look itself every 5 minutes, 3 times, before the card says "needs you to press continue"; it is never a fake background wait. A failed PR status query is retried twice first.
- If the project has its own backend, set "驗證用後端 port" on the project page: workers ask Studio to own that process, and a card waiting on it gets an automatic health check and safe recovery; leave it empty and Studio stays out of it.
- Cards have a role: 🛠 build, 🔍 check (verifiable against evidence, cheapest worker, PASS / FAIL), 🛡 review (never by the author; a strong-model review before any irreversible step). Every card carries an acceptance line. A NO-GO review or a FAIL check keeps the cards after it from starting and goes back to the Leader. A check card does not edit project files but must really run the tests / build (it is not in the read-only sandbox and does not share the author's conversation); only review cards are read-only. A card step whose agent shows no new message for 15 minutes (e.g. a hung command) is stopped and the Leader decides the retry; before stopping it looks for signs of life: a command still running whose project files changed in the last 90 s, or whose processes used CPU or spawned a child within 20 s, earns another 15 minutes (at most 3 times; the 3-hour cap per step stays), and only no evidence stops the step. Codex processes are known exactly; for Claude / Antigravity the other AionCore descendants are watched, which can only extend a wait, never shorten one. Claude hands its check cards and hard reviews to the checker / reviewer subagents in `~/.claude/agents/` when they exist.
- Cards can depend on earlier cards. When all cards end, the Leader checks the whole request and adds cards if it is not complete (max 3 extra rounds, then it asks you).
- "現在發生什麼" (what is happening now): progress, what is awaited, what happens next, and whether you need to act (🔴 needs Nana, with answer buttons).

**Project memory and handoff**
- Each project keeps a Project State: last goal, done, current, next, verified against real `git` / `gh` data (main SHA, open and merged PRs, CI per check, unresolved review threads). Git / GitHub wins over older agent notes.
- Restarting Studio, pressing "▶ 接著處理", or changing the Leader all hand over the same state, so you never re-explain.

**Control mid-job**
- "📣 告訴工頭" sends new instructions while a job runs: the Leader decides which worker to tell, which cards to cancel or add. Three ways to send it: "🕒 這一步做完再轉達" (default, after the current step), "💬 插話" (steer: goes into the step Claude / Codex is doing, without stopping it; other agents, or a step that ends first, get it after the step) and "⚡ 立刻打斷" (the working workers stop at once and continue after reading it). When a project keeps its agent rules in another agent's file (e.g. only CLAUDE.md, but the card goes to Codex), the brief asks the worker to read that file; Studio never copies or creates rules files.
- After a job is done: ① stop (default), ② suggest 1–3 next steps, ③ auto-continue (opt-in with a confirmation; default max 5 in a row, configurable, 0 = no limit).

**Long-term goal and routines** (project page, "🎯 長期目標・⏰ 定時工作")
- Long-term goal: one paragraph per project. The Leader's plan, every card brief and the final check carry it, so agents know why the work matters; they still do only what the request asks.
- Routines: weekdays + HH:MM + a request. At that time Studio hands the request to the team with the project's delivery mode and sends a Windows notification. A project that is working or paused is never pushed aside: the routine runs once when the project is free (several missed slots run once). A routine that cannot start (e.g. the Leader is unavailable) notifies you and is not retried every minute. Editing or re-enabling a routine counts from now; past slots never run. An optional precheck (one command run in the project folder, 30 s limit) skips the slot at no cost when its exit code is not 0, shown as "上次略過"; if the project gets busy while it runs, the slot waits as usual.
- Event log: `runtime/studio/events.jsonl`, one line per event across all projects: every API action, job start / end, routine and auto-continue starts. It keeps ids and settings only, never request text, notes or API keys; each job's chat and cards stay in its history file (`job` is the history file name). The log rotates at 5 MiB and retains five backups (`.1` newest through `.5`); the oldest event backup expires on rotation. Job history is unaffected.

**Saving quota**
- The Leader does not read files, search the repo or run commands; it only plans and checks, and sends investigation and work to workers. Claude Code gets a card only when Codex and Antigravity cannot do it.
- Model strategy per project: 💰 save (default; normal cards Sonnet / Luna, hard cards auto-upgrade to Opus / Sol), ⚖️ balanced, 🚀 quality, 🛠️ custom. The Leader always runs on the strong tier (it plans and signs off: few turns, costly mistakes); worker cards use the normal tier unless the Leader marks them hard, and a failed normal card is retried once on the strong model.
- Token cap per card (per project, default 0 = none): a card over it is stopped and marked failed; the Leader decides whether to retry another way. Checked between steps only (a running step is not cut), and only for agents that report usage.
- Seat cards show Claude (5-hour + weekly) and Codex (weekly) usage bars. Claude usage is read only at Studio start and on refresh.
- **Finisher**: per project, a cheap agent (e.g. a local model) that takes a card over once its CI is done and does the merge / sync main / cleanup chain, so the strong model's quota goes to coding. Waiting for CI itself costs nothing (Studio polls `gh`).
- **Withdraw**: "⏏ 撤出，卡改派給…" on a seat card removes an agent from the project (e.g. its quota is gone) and moves its unfinished cards (a writing card is stopped first, then handed over) to the agent you pick.
- **Resume at the quota reset**: when a worker reports a used-up quota or a rate limit and no fallback agent is set, its card waits and goes back to the same agent when the quota resets (the latest reset of its full 5-hour / weekly windows, else a time the error names, else in one hour; at most 5 times per card). An empty balance that needs a top-up does not wait; the card fails as before.
- **External models (API)**: on the overview page press "＋ 新增外部模型" under "外部模型（API）" and fill in display name, API format (OpenAI-compatible / Anthropic / Gemini), base URL, API key and model name ("取得模型清單" lists what the service offers; tick the full-URL option if the URL already is the complete request address), then "儲存並測試". It becomes a team member like Codex or Claude (Leader or Worker, reads and edits project files, governed by the same workspace lease). The API key is handed to AionCore, which stores it encrypted; Studio settings, UI and logs never contain it; leave the key blank when editing to keep it; local addresses (e.g. Ollama) need no key. One external model = one fixed model name; add another entry to use a different model.
- **ACP agents**: on the overview page press "＋ 新增 ACP Agent" under "ACP Agent" and pick one of AionCore's built-in ACP agents (Gemini CLI, OpenCode, Kimi, Cursor…, marked installed / not installed) or enter a custom command (display name, command, arguments), then "加入並測試". It becomes a team member like Codex or Claude and uses that CLI's own login on your machine. Worker cards use the agent's allow-everything mode when the catalog names one, otherwise its default mode, where Studio allows permission requests; the Leader and read-only review cards use the default mode, where Studio rejects every permission request (for an agent whose default mode edits without asking, read-only rests on the prompt only). An agent that is not installed shows AionCore's install guidance.
- **Work details / ask for progress**: working cards, seat cards and the overview show "🟠 working · 14 min · last activity 1 min ago"; after 8 minutes without new activity it says "🟡 possibly stuck" (a hint only: nothing is stopped, long work alone is not stuck); waiting for a tool permission or CI is shown as such. "查看工作詳情" shows start time, elapsed time, recent activity in plain words and the latest AI message; the full log is collapsed. For a card that edits files, every step (one dispatch until its report) records a snapshot of the tree before and after; "第 N 步" in the details shows that step's diff, also for finished cards. Snapshots are git trees written through a temporary index: HEAD, the index and the files are not changed, and no repo-configured filter program runs; each step is also kept under `refs/studio/steps/` in the repository (a normal push does not send it; no repository hook runs when it is written), so git gc keeps it; steps older than 90 days are dropped when a new step is kept, and then that step's diff is gone. "↩ 復原這一步" under a diff puts the files that step changed back (commits, branch and index stay); it changes nothing while a card edits files or when a later edit touched the same files, and the undo is recorded as a step, so it can be undone. "💬 詢問進度" or your own question in the details: it never interrupts the work, never creates a card and never takes the write lease. Agents that accept a message mid-turn get it at once; if the agent does not answer mid-turn (observed for Claude Code and Antigravity), Studio asks again when that stretch of work pauses (e.g. the card waits for CI); if the card finishes first, it honestly says so and shows the card's last report; the page honestly says "asked, waiting for the AI". The Leader also sees each working card's time, last activity and the possibly-stuck hint.

### Known limits (v0.1.0)

- The model strategy with real Codex, and a hard card actually auto-upgrading, were verified with scripted replies only; everything else has been used on real projects (a PDF editor, a stock panel).
- Local CI: `.\scripts\ci.ps1 -Mode Auto` (syntax and scripted lifecycle/lease checks). Live providers are verified separately.
- Pinned-backend contract: `node studio/test-aion-contract.mjs` runs real AionCore with a local ACP fixture, covering auth, model configuration and session reuse without paid model calls. GitHub runs it as a separate gate; see [scope and limitations](docs/provider-contract.md).
- **W1 process isolation remains open**: the [managed-spawn partial patch and no-model gate](docs/w1-managed-spawn.md) close only AionCore's spawn-to-Job race. They do not fix Store PowerShell activation escape or replace the production dependency. Live Claude cancel, restart and session-resume acceptance remains pending quota reset.
- Test Studio: set `STUDIO_RUNTIME` to another folder and Studio uses its own settings, history, leases and AionCore data there, never your normal `runtime/` (the AionCore program is shared). PowerShell example: `$env:STUDIO_RUNTIME="$env:TEMP\studio-test"; $env:STUDIO_PORT=4859; node studio/server.mjs`. Use disposable projects only: the two Studios cannot see each other's leases.
- "告訴工頭" does not cut into a worker's current step by default; "💬 插話" adds the note to it without stopping it (Claude / Codex); use "立刻打斷" to stop it.
- AionCore writes an `.agents/` folder into the project when Antigravity works there.
- Windows only.

### Safety

**Workers edit files and run commands in the chosen folder without asking** (Claude: `bypassPermissions`, Codex: `auto`). A Git worktree is not a security sandbox. Use it only on disposable or version-controlled projects without sensitive data; use on production repositories or folders with secrets has not been approved.

### Documentation

- [Workspace lease API and lifecycle](docs/workspace-lease.md)
- [Runtime ownership and backend recovery](docs/runtime-ownership.md)
- [Multi-model collaboration principles](docs/multi-model-principles.md) (Traditional Chinese)
- [Orca comparison: what to borrow and what not](docs/orca-comparison.md) (Traditional Chinese)

### License

Licensed under the [GNU GPL v3.0](LICENSE). You may use, modify and distribute it; if you distribute a modified version, you must release its source under GPL-3.0 as well. AionCore is a separately downloaded third-party program with its own license and is not covered here.

### 工作中切換模型

各專案的員工卡會自動顯示後端回報的模型／思考強度下拉清單。選擇時會切到自訂策略，其他員工原本的有效策略值會保留。可分別設定普通卡與困難卡／工頭。

切換在下一個步驟送出前，透過 AionCore 的 `config-options` 套用到原對話：不取消當下工具、不重建對話、不清掉歷史。若後端不支援選項或未確認設定，該步驟會報錯，不假稱切換成功。空白值沿用現有對話設定；新對話使用後端預設值。模型清單會隨後端事件及每步設定查詢更新。

外部 API (`aionrs`) 員工目前仍由供應商設定管理模型，後端未提供此處的對話內模型切換，不顯示虛假的可切換選單。Windows 真實供應商驗收仍需在可用登入與額度下確認；離線回歸測試不會發送付費模型請求。
