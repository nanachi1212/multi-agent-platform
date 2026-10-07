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
- 在等的工作卡會自動接續：等的 AI 做完、GitHub PR 的 CI 跑完（用 `gh`，每分鐘檢查）、或你回覆。Studio 無法自己確認的等待，會明說「需要你按繼續」，不會假裝在背景等。
- 工作卡可以設定「等前一張完成才開始」。全部做完後，工頭會確認整體需求是否真的完成，沒完成會自己追加工作卡（最多 3 輪，之後問你）。
- 「現在發生什麼」：進度、在等什麼、接下來誰做什麼、你現在要不要處理（🔴 需要 Nana，可直接按選項回覆）。

**自動交付與寫入鎖**
- 交付方式（每個專案，預設 🚚 自動做到 merge）：需求清楚、沒有高風險時，AI 一路做完：修改 → 針對性驗證 → commit → push → PR → CI → 一次 review → 修正 blocker／有效 finding → CI → squash merge → 同步 main → 清理分支 → 下一張卡，不會因為 commit、push、開 PR、CI 通過或正常 merge 停下來等你。只有以下情況才問你：需求有重大歧義、可能永久遺失你的重要資料、需要新的付費服務／憑證／外部發布、review 的 blocker 無法在原範圍安全修正、CI 持續失敗且最小修正無效、merge conflict 碰到你或其他 AI 還沒提交的修改、無法合理回滾的操作。一般 P1/P2 review 意見直接在原 PR 修正並補測試。可改成「✋ 做到 PR 就停（merge 等我）」。
- **同一個資料夾同一時間只有一位寫入者**：同一個專案裡，會修改檔案的工作卡一次只有一張在做（其他排隊），審查、讀程式、調查的卡標成「唯讀」，可以同時進行。要同時修改，請用不同的 git worktree／分支（各有各的鎖）。
- 對外部也有鎖：寫入時會在 git 目錄放 `studio-writer.lock`（程式、時間、卡片）；另一個 Studio 或其他程式放了新的鎖，Studio 就不寫入，等對方做完（每 30 秒再看一次）。Studio 每次停止寫入時會記下這個資料夾的樣子（HEAD、分支、未提交檔案）；之後**自動恢復**（CI 結果、其他 AI 的結果、自動持續開發）前會比對：如果檔案幾秒前才被改過，就等；如果離開期間被改過，會先問你「要讓 Studio 接手嗎」。你自己按「繼續」或回答問題時，視為你已知道，不再多問。
- **暫停 vs 停止**：暫停＝成員馬上停下（手上那一步可能做到一半）、進度全部保留、Studio 不會自己恢復（重開 Studio 也不會），要你按「繼續」。停止＝這件工作到此為止、未完成的卡標成失敗、不能再「繼續」，要接著做用「▶ 接著處理」開新的一輪。暫停和停止時都會釋放寫入鎖。

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

### 已知限制（v0.1.0）

- 「模型策略」搭配真的 Codex、以及困難卡實際自動升級，目前只用模擬回覆驗證過；其餘功能已在真實專案（PDF 編輯器、股票面板）上使用。
- 沒有 CI；所有驗證都是手動的：`node studio/lifecycle-check.cjs`（模擬 AI 回覆的流程檢查）加上實際操作。
- 成員正在進行的那一步不會被「告訴工頭」中途打斷，要用「立刻打斷」。
- AionCore 在 Antigravity 工作時，會在專案裡寫一個 `.agents/` 資料夾。
- 目前只支援 Windows。

### 安全

**成員會在你選的資料夾裡直接修改檔案、執行指令，不會先問**（Claude：`bypassPermissions`，Codex：`auto`）。Git worktree 不是安全沙箱。只適合拋棄式或有版本控制、不含敏感資料的專案；用在正式環境專案或有機密憑證的資料夾，尚未被核准。

### 文件

- [架構 V1](docs/architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md)
- [Codex 架構審查](docs/architecture/ARCHITECTURE_REVIEW_CODEX.md)
- [P0 Spike 報告](docs/reports/P0_SPIKE_REPORT.md)（P0 在當時的閘門條件下，結論為 NO-GO；那份架構研究與 Studio 是分開的）

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
- **One writer per working tree**: inside a project only one card that modifies files runs at a time (the others queue); review, reading and investigation cards are marked read-only and run alongside. For parallel edits use separate git worktrees / branches (each has its own lock).
- A lock against outsiders too: while writing, Studio keeps `studio-writer.lock` in the git dir (program, time, card). A fresh lock from another Studio or program stops Studio from writing until it is gone (rechecked every 30 s). Whenever Studio stops writing it records what the tree looks like (HEAD, branch, uncommitted files); before an **automatic** resume (CI result, another agent's result, auto-continue) it compares: files changed seconds ago → wait; changed while Studio was away → it asks "may Studio take over?". When you press "繼續" or answer a question yourself, it assumes you know.
- **Pause vs stop**: pause = workers stop now (the current step may be half done), all progress is kept, Studio never resumes by itself (not even after a restart), you press "繼續". Stop = this job ends, unfinished cards fail, no "繼續"; use "▶ 接著處理" to start a new round. Both release the writer lock.

**Project memory and handoff**
- Every worker reply states a status: done / waiting for something external (e.g. CI) / waiting for another agent / needs your decision. A turn ending is not "done".
- Waiting cards continue by themselves when the awaited agent finishes, when a GitHub PR's CI finishes (`gh`, checked every minute), or when you answer. Waits Studio cannot check are shown as "needs you to press continue", never as a fake background wait.
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

### Known limits (v0.1.0)

- The model strategy with real Codex, and a hard card actually auto-upgrading, were verified with scripted replies only; everything else has been used on real projects (a PDF editor, a stock panel).
- No CI. All checks are manual: `node studio/lifecycle-check.cjs` (scripted-agent lifecycle check) plus hands-on use.
- "告訴工頭" does not cut into a worker's current step; use "立刻打斷" for that.
- AionCore writes an `.agents/` folder into the project when Antigravity works there.
- Windows only.

### Safety

**Workers edit files and run commands in the chosen folder without asking** (Claude: `bypassPermissions`, Codex: `auto`). A Git worktree is not a security sandbox. Use it only on disposable or version-controlled projects without sensitive data; use on production repositories or folders with secrets has not been approved.

### Documentation

- [Architecture V1](docs/architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md)
- [Codex Architecture Review](docs/architecture/ARCHITECTURE_REVIEW_CODEX.md)
- [P0 Spike Report](docs/reports/P0_SPIKE_REPORT.md) (the P0 spike ended NO-GO for MVP-0 under the gates of the time; that architecture track is separate from Studio)

### License

Licensed under the [GNU GPL v3.0](LICENSE). You may use, modify and distribute it; if you distribute a modified version, you must release its source under GPL-3.0 as well. AionCore is a separately downloaded third-party program with its own license and is not covered here.
