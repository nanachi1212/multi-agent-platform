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

第一次啟動會下載 AionCore v0.2.2（官方版本，SHA-256 驗證）到 `runtime/`。Studio 的 Codex 使用獨立資料夾（`runtime/studio/codex-home`），不會出現在你平常的 Codex 紀錄裡；第一次要在 Codex 卡片按「登入 Codex（Studio 專用）」。

### 功能

**多專案同時工作**
- 每個專案一個分頁，各自有工頭、成員、模型、工作卡、對話、暫停／Stop 和歷史；切換分頁不會停止工作。
- 「總覽」頁：每個專案一張卡（狀態、進度、下一步、你要做什麼）、一鍵暫停／繼續、「誰在做什麼」表格。
- 每個專案完成或需要你處理時發 Windows 通知，點通知會打開該專案分頁。

**工作流程（不用盯著看）**
- 成員每次回覆都要標明狀態：完成／等外部結果（例如 CI）／等其他 AI／需要你決定。一回合結束不等於完成。
- 在等的工作卡會自動接續：等的 AI 做完、GitHub PR 的 CI 跑完（用 `gh`，每分鐘檢查）、或你回覆。Studio 無法自己確認的等待（例如 nightly build）：先每 5 分鐘請成員自己看一次、最多 3 次，之後才明說「需要你按繼續」，不會假裝在背景等；查 PR 狀態失敗會先重試兩次。
- 專案有自己的後端服務時，在專案頁填「驗證用後端 port」：成員會請 Studio 代管啟動它，卡片在等它時 Studio 自動檢查 health 並安全恢復；留空就完全不管。
- 工作卡可以設定「等前一張完成才開始」。全部做完後，工頭會確認整體需求是否真的完成，沒完成會自己追加工作卡（最多 3 輪，之後問你）。
- 「現在發生什麼」：進度、在等什麼、接下來誰做什麼、你現在要不要處理（🔴 需要 Nana，可直接按選項回覆）。

**自動交付與寫入鎖**
- 交付方式（每個專案，預設 🚚 自動做到 merge）：需求清楚、沒有高風險時，AI 一路做完：修改 → 針對性驗證 → commit → push → PR → CI → 一次 review → 修正 blocker／有效 finding → CI → squash merge → 同步 main → 清理分支 → 下一張卡，不會因為 commit、push、開 PR、CI 通過或正常 merge 停下來等你。只有以下情況才問你：需求有重大歧義、可能永久遺失你的重要資料、需要新的付費服務／憑證／外部發布、review 的 blocker 無法在原範圍安全修正、CI 持續失敗且最小修正無效、merge conflict 碰到你或其他 AI 還沒提交的修改、無法合理回滾的操作。一般 P1/P2 review 意見直接在原 PR 修正並補測試。可改成「✋ 做到 PR 就停（merge 等我）」。
- **工作區租約（Workspace Lease）：同一個實體資料夾同一時間只有一位寫入者。** 任何會修改檔案的工作，在 Agent 真正啟動前必須先拿到這個資料夾的「寫入租約」；拿不到就不啟動，也不會偷搶。租約記錄：資料夾（路徑經過正規化，大小寫、斜線不同也算同一個）、repository、branch、哪個 job／工作卡、哪個 Agent、讀或寫、開始時間、最後心跳、狀態；存在 `runtime/studio/leases.json`，Studio 重開後仍知道重開前誰持有。狀態：`ACTIVE`（正在執行）、`RESERVED`（暫停或等待中，仍屬於原持有者）、`STALE`（持有者已消失：Studio 當掉、行程不在、很久沒有心跳）、`RELEASED`。唯讀的工作（Review、讀程式、查 GitHub）不需要租約、可以多位同時，而且 Codex、Claude 以不可寫入的模式啟動（read-only、dontAsk），不只靠提示（Antigravity 的不可寫入模式會讓工具在中文路徑下全部被擋，所以仍靠提示）；不同的 git worktree 各自有自己的寫入者。
- **被擋下時**，工作卡不是籠統的「等待」，而是寫出「此工作區目前由 Claude Code 使用中（工作卡「…」），branch …，幾點開始，狀態」，並給三個選項：① 等待（Studio 自動再試）、② 改成唯讀 Review、③ 使用獨立 worktree（建立自己的 branch 和資料夾，各自有租約；merge 後自動清掉）。專案頁固定顯示「寫入者／資料夾／branch／唯讀者」。
- **交接（Handoff）**：專案頁「改由…接手」。流程：停下現在的寫入者 → 保存這張卡、對話、進度 → 等它真的停住（沒停住就不交接）→ 放下它的租約 → 新的 Agent 取得租約、從目前的資料夾和 branch 接續。舊 Agent 的對話和紀錄保留，但不再是寫入者，也不會因為恢復或重開而拿回來。
- **重開安全**：重開後 Studio 不會因為看到暫停／中斷的工作就直接恢復寫入。要「繼續」前會重新檢查租約：資料夾已經由另一個 Agent 或外部接手時，顯示「工作區已由另一個 Agent 接手，本工作保持暫停」；租約還是自己的才允許。Studio 當掉留下的租約不會永遠鎖死：持有者行程不在（或很久沒有心跳）就判定 `STALE`，才能被安全接手；持有者明確還活著時，不會被搶。
- **外部 Agent／非 Studio 的修改**：另一個 AI 視窗或你自己要改這個資料夾時，宣告接手（專案頁「外部 Agent／我要自己改」，或用 API）：Studio 會停下並暫停自己的寫入、等它真的停住、放下自己的租約，租約改成外部持有；原本的 Studio 工作保持暫停，重開也不會自己恢復。做完用「外部已歸還」或 release-claim。宣告時可帶 `pid` 作為資訊；外部租約狀態為 `EXTERNAL`，即使行程退出或 Studio 重開也保留，必須明確 release-claim 才歸還。
```
curl -X POST http://127.0.0.1:4848/api/workspace/claim -H "content-type: application/json" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\",\"label\":\"Claude 視窗\",\"pid\":1234}"
curl -X POST http://127.0.0.1:4848/api/workspace/release-claim -H "content-type: application/json" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\"}"
```
- **來源不明的修改**：持有租約的 Agent 沒有在執行、資料夾卻被改動，或寫入期間出現另一個程式的鎖定檔，Studio 會標記 `EXTERNAL_MODIFICATION_DETECTED`、停止寫入並暫停，**不會 reset、不會 stash、不會覆蓋**；你確認後按「確認接手並繼續」。（Agent 執行當中的修改，無法分辨是它自己改的還是別人改的，所以規則要求 Agent 的檔案修改都在自己的回合內完成、不要留下會改檔案的背景程序。）
- 租約之外，另有一個放在 git 目錄的 `studio-writer.lock` 供不認識 Studio 的程式查看，以及每次停止寫入時記下的資料夾指紋（HEAD、branch、未提交檔案）：自動恢復前比對，幾秒前才被改過就等、離開期間被改過就先問你。
- **暫停 vs 停止**：暫停＝成員馬上停下（手上那一步可能做到一半）、卡片和對話都保留、租約改成 `RESERVED`（工作仍屬於它）、Studio 不會自己恢復（重開也不會），要你按「繼續」，而且繼續前會重新檢查租約。停止＝這件工作到此為止、終止執行、釋放租約、未完成的卡標成失敗、不能再「繼續」、重開也不會復活；卡片、對話和紀錄都保留，要接著做用「▶ 接著處理」開新的一輪。

**專案記憶與接續**
- 每個專案保存「專案狀態」：上次目標、已完成、目前、下一步，並用 `git`／`gh` 核對真實狀態（main SHA、開著與已合併的 PR、每項 CI、未解決的 review 意見）。Git／GitHub 的結果優先於 AI 以前留下的文字。
- 重開 Studio、按「▶ 接著處理」或更換工頭，都會拿到同一份接力棒，不用重新解釋。

**中途控制**
- 工作進行中可以「📣 告訴工頭」補充或修改指示：工頭決定轉告哪位成員、取消或追加工作卡。勾「⚡ 立刻打斷」會讓正在做的成員馬上停下，看完指示再接著做。
- 「做完之後」：① 完成就停（預設）、② 完成後建議 1–3 個下一步、③ 自動持續開發（需自己開啟並確認，最多連續 5 件）。

**省額度**
- 工頭不讀檔、不查 repo、不跑指令，只規劃與確認；調查和動手都交給成員。Claude Code 只在 Codex 和 Antigravity 做不了時才拿到工作卡。
- 模型策略（每個專案）：💰 省額度（預設，普通卡 Sonnet／Luna，困難卡自動升級 Opus／Sol）、⚖️ 均衡、🚀 品質優先、🛠️ 自訂。工頭自己判斷普通或困難；普通卡失敗會自動改用強模型重試一次。
- 員工卡顯示 Claude（5 小時＋每週）與 Codex（每週）的額度條。Claude 額度只在 Studio 啟動和按「更新」時讀取一次。
- **收尾者**：每個專案可指定一位便宜成員（例如本地模型）。CI 跑完後，merge／同步 main／清分支改由它接手，原成員的額度留給寫程式；等 CI 本身不花額度（Studio 自己用 `gh` 查）。
- **撤出成員**：員工卡上「⏏ 撤出，卡改派給…」。額度用完時把它移出這個專案，手上未完成的卡（正在寫入的會先停下再交接）改派給你選的人。
- **外部模型（API）**：總覽頁「外部模型（API）」按「＋ 新增外部模型」，填顯示名稱、API 格式（OpenAI 相容／Anthropic／Gemini）、Base URL、API Key、模型名稱（可按「取得模型清單」挑選；網址已是完整請求位址時勾選對應選項），按「儲存並測試」。它會成為和 Codex、Claude 一樣的團隊成員（可當工頭或成員，會讀寫專案檔案，同樣受工作區租約管理）。API key 只交給 AionCore 加密保存，Studio 的設定檔、畫面、紀錄都不含 key；編輯時 key 留空 = 不變；本機位址（如 Ollama）可不填 key。每個外部模型固定一個模型名稱，要換模型就新增一個。
- **工作詳情／詢問進度**：工作中的卡、員工卡、總覽「誰在做什麼」都顯示「🟠 工作中 · 14 分鐘 · 最近活動 1 分鐘前」；超過 8 分鐘沒有新活動顯示「🟡 可能卡住」（只是提醒，不會停掉它，工作很久本身不算卡住）；等工具確認、等 CI 會直接寫出來。按「查看工作詳情」看開始時間、已執行多久、最近活動（白話）、最近一句 AI 訊息，完整執行紀錄預設收合。「💬 詢問進度」或在詳情裡自己打問題：不會中斷工作、不會新增工作卡、不拿寫入租約。能在工作中途插話的 AI 會馬上收到；若它不在工作中途回答（實測 Claude Code、Antigravity 都是這樣），Studio 會在它這段工作告一段落（例如卡片在等 CI）時補問；卡片在那之前就做完時，照實顯示「問題送達前這張卡已經結束」和它最後的回報，畫面會照實寫「已詢問，等待 AI 回覆」。工頭看到的工作卡也帶有工作時間、最近活動和「可能卡住」提示。

### 已知限制（v0.1.0）

- 「模型策略」搭配真的 Codex、以及困難卡實際自動升級，目前只用模擬回覆驗證過；其餘功能已在真實專案（PDF 編輯器、股票面板）上使用。
- 本機 CI：`.\scripts\ci.ps1 -Mode Auto`（語法與模擬 AI lifecycle／租約測試）；真實 provider 操作另行驗證。
- 成員正在進行的那一步不會被「告訴工頭」中途打斷，要用「立刻打斷」。
- AionCore 在 Antigravity 工作時，會在專案裡寫一個 `.agents/` 資料夾。
- 目前只支援 Windows。

### 安全

**成員會在你選的資料夾裡直接修改檔案、執行指令，不會先問**（Claude：`bypassPermissions`，Codex：`auto`）。Git worktree 不是安全沙箱。只適合拋棄式或有版本控制、不含敏感資料的專案；用在正式環境專案或有機密憑證的資料夾，尚未被核准。

### 文件

- [Workspace lease API 與生命週期](docs/workspace-lease.md)
- [Runtime ownership 與後端恢復](docs/runtime-ownership.md)
- [多模型協作設計原則](docs/multi-model-principles.md)

### 授權

以 [GNU GPL v3.0](LICENSE) 授權。你可以使用、修改、散布；散布修改後的版本時，必須同樣以 GPL-3.0 公開原始碼。AionCore 是另外下載的第三方程式，有它自己的授權，不包含在本授權內。

---

## English

A Windows-first multi-agent collaboration platform. **Multi-Agent Studio** is a local web page where Claude Code, Codex and Antigravity work as one team. You pick one as the **Leader**; the others are **Workers**. You say what you want in plain words, the Leader splits it into cards and assigns them, Workers do the work inside your project folder, and the Leader finally checks that the whole request is really done.

### Quick start

1. Install [Node.js](https://nodejs.org) and log in to the agents you want: `claude auth login`, `codex login` (Antigravity must be installed and logged in).
2. Double-click `start-studio.cmd`. The browser opens `http://127.0.0.1:4848` (the next free port is used if it is taken). Close the console window to stop.
3. Open a project folder in the sidebar, type what you want under "今天想讓「<project>」做什麼？", and press "▶ 交給團隊".

The first start downloads AionCore v0.2.2 (official release, SHA-256 checked) into `runtime/`. Studio runs Codex with its own home (`runtime/studio/codex-home`), so its sessions never appear in your normal Codex history; log in once with the "登入 Codex（Studio 專用）" button on the Codex card.

### Features

**Several projects at once**
- One tab per project with its own Leader, Workers, models, cards, chat, pause / Stop and history. Switching tabs never stops work.
- Overview tab: one card per project (status, progress, next step, what you must do), one-click pause / continue, and an agents × projects table.
- A Windows notification when a project finishes or needs you; clicking it opens that project tab.

**Autonomous delivery and the writer lock**
- Delivery (per project, default 🚚 auto to merge): when the request is clear and nothing is high-risk, the AI goes all the way: change → targeted validation → commit → push → PR → CI → one review → fix blockers / valid findings → CI → squash merge → sync main → delete the branch → next card. It does not stop for a commit, a push, a PR, green CI or a normal merge. It asks only for: a materially ambiguous requirement, a destructive operation that could permanently lose your important data, a new paid service / credential / external publication, a review blocker that cannot be fixed safely inside the original scope, CI that keeps failing after a minimal fix, a merge conflict touching uncommitted changes of you or another agent, or anything that cannot reasonably be rolled back. Ordinary P1/P2 review findings are fixed inside the original PR with a regression test. Switchable to "✋ stop at the PR (you merge)".
- **Workspace lease: one writer per physical working tree.** Before an agent starts any work that modifies files, Studio must obtain the write lease of that folder; if it cannot, the agent is not started and nothing is stolen. A lease records the folder (path canonicalized: case and slash differences are the same tree), repository, branch, job / card, agent, read or write, start time, last heartbeat and status, and lives in `runtime/studio/leases.json`, so after a restart Studio still knows who held the tree. Status: `ACTIVE` (executing), `RESERVED` (paused or waiting, still the owner's), `STALE` (the owner is gone: crashed Studio, dead process, long silence), `RELEASED`. Read-only work (review, reading, GitHub) needs no lease, any number may run, and Codex / Claude start it in their non-writing mode (read-only, dontAsk), not just on a prompt (Antigravity's non-writing mode blocks every tool under a non-ASCII path, so it keeps the prompt fence); different git worktrees each have their own writer.
- **When refused**, the card does not just say "waiting": it says "this workspace is currently used by Claude Code (card …), branch …, since …, status …" with three options: ① wait (Studio retries), ② switch to read-only review, ③ use an independent worktree (own branch and folder, own lease; cleaned up after merge). The project page always shows writer / folder / branch / readers.
- **Handoff**: "改由…接手" on the project page. Flow: stop the current writer → save its card, conversation and progress → wait until it has really stopped (no handoff if it has not) → release its lease → the new agent takes the lease and continues from the current folder and branch. The old agent's conversation and history stay, but it is no longer the writer and cannot get the role back by resume or restart.
- **Restart safety**: after a restart Studio never resumes writing just because it sees a paused / interrupted job. Before "continue" it re-checks the lease: if another agent or an external party now holds the tree it says "the workspace was taken over by another agent, this job stays paused"; only the lease's own owner may resume. A lease left by a crashed Studio never locks forever: when the holder process is gone (or silent for long) it is `STALE` and can be reclaimed; a holder that is clearly alive is never taken over.
- **External agents / non-Studio edits**: when another AI window or you want to edit the folder, declare it (project page button, or the API): Studio stops and pauses its own writers, waits until they really stopped, gives up its lease and records the external owner; the paused Studio job stays paused and a restart does not revive it. Give it back with "外部已歸還" or release-claim. A claim can carry a `pid` for reference. Its `EXTERNAL` ownership survives process exit and Studio restart and requires explicit release-claim.
```
curl -X POST http://127.0.0.1:4848/api/workspace/claim -H "content-type: application/json" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\",\"label\":\"Claude window\",\"pid\":1234}"
curl -X POST http://127.0.0.1:4848/api/workspace/release-claim -H "content-type: application/json" -d "{\"path\":\"E:\\\\CodexProject\\\\MyProject\"}"
```
- **Unknown changes**: if the lease holder is not executing but the folder changed, or another program's lock file appears while it writes, Studio flags `EXTERNAL_MODIFICATION_DETECTED`, stops writing and pauses; it does **not** reset, stash or overwrite; after you confirm, press "確認接手並繼續". (Changes made while an agent is executing cannot be told apart from its own, so the rules require agents to finish all file changes inside their own turn and leave no background process that edits files.)
- Besides the lease there is a `studio-writer.lock` in the git dir for programs that know nothing about Studio, and a fingerprint of the tree (HEAD, branch, uncommitted files) taken whenever Studio stops writing: compared before an automatic resume (files changed seconds ago → wait; changed while away → ask you).
- **Pause vs stop**: pause = workers stop now (the current step may be half done), card and conversation are kept, the lease becomes `RESERVED` (the work still belongs to its owner), Studio never resumes it by itself (not even after a restart), you press "繼續", and the lease is re-checked first. Stop = this job ends for good: execution is terminated, the lease is released, unfinished cards fail, no "繼續", no revival after a restart; cards, conversations and records are kept, use "▶ 接著處理" to start a new round.

**Project memory and handoff**
- Every worker reply states a status: done / waiting for something external (e.g. CI) / waiting for another agent / needs your decision. A turn ending is not "done".
- Waiting cards continue by themselves when the awaited agent finishes, when a GitHub PR's CI finishes (`gh`, checked every minute), or when you answer. A wait Studio cannot check (e.g. a nightly build): the worker is asked to look itself every 5 minutes, 3 times, before the card says "needs you to press continue"; it is never a fake background wait. A failed PR status query is retried twice first.
- If the project has its own backend, set "驗證用後端 port" on the project page: workers ask Studio to own that process, and a card waiting on it gets an automatic health check and safe recovery; leave it empty and Studio stays out of it.
- Cards can depend on earlier cards. When all cards end, the Leader checks the whole request and adds cards if it is not complete (max 3 extra rounds, then it asks you).
- "現在發生什麼" (what is happening now): progress, what is awaited, what happens next, and whether you need to act (🔴 needs Nana, with answer buttons).

**Project memory and handoff**
- Each project keeps a Project State: last goal, done, current, next, verified against real `git` / `gh` data (main SHA, open and merged PRs, CI per check, unresolved review threads). Git / GitHub wins over older agent notes.
- Restarting Studio, pressing "▶ 接著處理", or changing the Leader all hand over the same state, so you never re-explain.

**Control mid-job**
- "📣 告訴工頭" sends new instructions while a job runs: the Leader decides which worker to tell, which cards to cancel or add. "⚡ 立刻打斷" stops the working workers at once; they continue after reading the instruction.
- After a job is done: ① stop (default), ② suggest 1–3 next steps, ③ auto-continue (opt-in with a confirmation, max 5 in a row).

**Saving quota**
- The Leader does not read files, search the repo or run commands; it only plans and checks, and sends investigation and work to workers. Claude Code gets a card only when Codex and Antigravity cannot do it.
- Model strategy per project: 💰 save (default; normal cards Sonnet / Luna, hard cards auto-upgrade to Opus / Sol), ⚖️ balanced, 🚀 quality, 🛠️ custom. The Leader marks cards normal or hard by itself; a failed normal card is retried once on the strong model.
- Seat cards show Claude (5-hour + weekly) and Codex (weekly) usage bars. Claude usage is read only at Studio start and on refresh.
- **Finisher**: per project, a cheap agent (e.g. a local model) that takes a card over once its CI is done and does the merge / sync main / cleanup chain, so the strong model's quota goes to coding. Waiting for CI itself costs nothing (Studio polls `gh`).
- **Withdraw**: "⏏ 撤出，卡改派給…" on a seat card removes an agent from the project (e.g. its quota is gone) and moves its unfinished cards (a writing card is stopped first, then handed over) to the agent you pick.
- **External models (API)**: on the overview page press "＋ 新增外部模型" under "外部模型（API）" and fill in display name, API format (OpenAI-compatible / Anthropic / Gemini), base URL, API key and model name ("取得模型清單" lists what the service offers; tick the full-URL option if the URL already is the complete request address), then "儲存並測試". It becomes a team member like Codex or Claude (Leader or Worker, reads and edits project files, governed by the same workspace lease). The API key is handed to AionCore, which stores it encrypted; Studio settings, UI and logs never contain it; leave the key blank when editing to keep it; local addresses (e.g. Ollama) need no key. One external model = one fixed model name; add another entry to use a different model.
- **Work details / ask for progress**: working cards, seat cards and the overview show "🟠 working · 14 min · last activity 1 min ago"; after 8 minutes without new activity it says "🟡 possibly stuck" (a hint only: nothing is stopped, long work alone is not stuck); waiting for a tool permission or CI is shown as such. "查看工作詳情" shows start time, elapsed time, recent activity in plain words and the latest AI message; the full log is collapsed. "💬 詢問進度" or your own question in the details: it never interrupts the work, never creates a card and never takes the write lease. Agents that accept a message mid-turn get it at once; if the agent does not answer mid-turn (observed for Claude Code and Antigravity), Studio asks again when that stretch of work pauses (e.g. the card waits for CI); if the card finishes first, it honestly says so and shows the card's last report; the page honestly says "asked, waiting for the AI". The Leader also sees each working card's time, last activity and the possibly-stuck hint.

### Known limits (v0.1.0)

- The model strategy with real Codex, and a hard card actually auto-upgrading, were verified with scripted replies only; everything else has been used on real projects (a PDF editor, a stock panel).
- Local CI: `.\scripts\ci.ps1 -Mode Auto` (syntax and scripted lifecycle/lease checks). Live providers are verified separately.
- "告訴工頭" does not cut into a worker's current step; use "立刻打斷" for that.
- AionCore writes an `.agents/` folder into the project when Antigravity works there.
- Windows only.

### Safety

**Workers edit files and run commands in the chosen folder without asking** (Claude: `bypassPermissions`, Codex: `auto`). A Git worktree is not a security sandbox. Use it only on disposable or version-controlled projects without sensitive data; use on production repositories or folders with secrets has not been approved.

### Documentation

- [Workspace lease API and lifecycle](docs/workspace-lease.md)
- [Runtime ownership and backend recovery](docs/runtime-ownership.md)
- [Multi-model collaboration principles](docs/multi-model-principles.md) (Traditional Chinese)

### License

Licensed under the [GNU GPL v3.0](LICENSE). You may use, modify and distribute it; if you distribute a modified version, you must release its source under GPL-3.0 as well. AionCore is a separately downloaded third-party program with its own license and is not covered here.
