# Orca（stablyai/orca）對照評估

更新日期：2026-10-17。本方案基準：`680a62c`。Orca 基準：v1.4.229（2026-10-17 release，main `6fcc183`）。

## 結論

1. **定位不同，不能也不必在程式碼層融合。** Orca 是給人用的「多 Agent 工作台 IDE」（Electron，約 3.7 萬個檔案，MIT）；它的編排（orchestration）只是一個實驗功能，而且是「一個 Agent 讀技能指引去指揮其他 Agent」。本方案是無人值守的「工頭派卡 → 成員做 → 自動交付」流程引擎（單一 Node 程序約 6,700 行，GPL-3）。
2. **流程層可以並用，但不急。** Orca 當人看畫面、改 diff 的駕駛艙，Studio 當背景執行器。Orca 的 CLI 要 Orca 本體開著才能用，兩邊沒有共同的程序登記，所以並用時要靠本方案現有的外部接手宣告（`/api/workspace/claim`）避免互搶寫入。等真的要用 Orca 再接。
3. **值得借的是觀念與幾個小機制。** 建議先做的三項改動都小：定時工作前置檢查、獨立 worktree 補齊被 gitignore 的檔案、成員完成回報附「改了哪些檔案」。

## 兩邊定位

| 面向 | 本方案 Multi-Agent Studio | Orca |
|---|---|---|
| 形態 | 本機網頁 + 單一 Node 程序，Windows 限定 | Electron 桌面 IDE，Win／mac／Linux，另有手機 App 與雲端 relay |
| 誰在指揮 | 程式（Studio）排程、工頭 AI 規劃、成員 AI 執行；人只在需要決定時介入 | 人開 worktree、啟動 Agent、看終端機；編排（Run／Task／Dispatch）是實驗功能，由協調者 Agent 跑 CLI 指揮 worker Agent |
| Agent 啟動方式 | AionCore 統一 API（Claude／Codex／Antigravity／外部 API 模型） | 各家 CLI 直接跑在 PTY 終端機；支援 30 多種 CLI |
| 狀態來源 | AionCore 對話事件 + 回覆末行 STATUS（DONE／WAITING_EXTERNAL／WAITING_AGENT／NEEDS_USER／BLOCKED） | Agent hooks 回報 working／waiting／done + `worker_done` 訊息（必帶 taskId、dispatchId、`--outcome`） |
| 寫入衝突 | 工作區租約：一棵樹一個寫入者，重開安全、外部宣告接手 | 每個任務一個 worktree，天生不撞；同一 worktree 多 Agent 靠人自己管 |
| 交付 | 自動做到 merge（可改停在 PR），review 一次，Recorded-not-fixed | 人在 IDE 內 commit／push／PR／看 CI；Annotate AI Diff、AI 行歸屬 |
| 定時 | 每專案「星期 + HH:MM」，忙碌時延後、錯過只補一次 | cron／RRULE、`--precheck`、missed-run grace、`--reuse-session`、跨主機 |
| 省額度 | 模型策略（省額度／均衡／品質）、每卡 token 上限、收尾者、撤出成員 | 讀本機 `~/.claude`、`~/.codex` 用量檔顯示額度；估算費用 |
| 授權 | GPL-3.0 | MIT |

## 融合可行性

- **程式碼層：不可行也不值得。** 語言、架構、授權都不同；Orca 的編排層綁死它的 runtime、PTY 與 SQLite，抽不出來。
- **流程層（並用）：可以，但不是現在。** Studio 照舊在背景跑；人要親手改同一個專案時用 Orca 開 worktree，並對 Studio 做 `POST /api/workspace/claim`（已有）。要做到「Orca 裡看到 Studio 的卡」或「Studio 把卡派進 Orca 的 worktree」，得寫一層橋接（`orca worktree create --agent --prompt` 回傳 handle，Studio 再用 `orca terminal read／wait` 收結果），而且要 Orca 開著。等有真實需求再評估。
- **觀念層：以下逐項。**

## 值得借鑒（依「對本方案的價值 ÷ 改動成本」排序）

### A. 建議做（改動小、補的是已知缺口）— 三項已於 2026-10-17 實作

1. **定時工作加「前置檢查」（Orca `--precheck`）** — 已實作：routine 的 `precheck` 欄位、`routine.skip` 事件、UI「上次略過」
   - Orca：一句 shell 指令，exit 非 0 就記一筆 skipped、不啟動 Agent。例：`gh pr list --json number -q .[0].number` 沒有 PR 就不跑「審 PR」。
   - 本方案：`runRoutines` 時間到就 `start(w, r.request)`，工頭至少花一回合才知道沒事做。
   - 改法：routine 多一個選填 `precheck` 欄位；時間到先在工作區內執行它（逾時 30 秒），非 0 就寫 `routine.skip` 事件、`lastResult` 註明「前置檢查未通過」、不開 job。約 20 行 + UI 一個輸入框。

2. **獨立 worktree 補齊被 gitignore 的檔案（Orca `.worktreeinclude` + `sharedDirectories`）** — 已實作：`includeIgnored`（檔案複製、資料夾 junction）與清理前的 `removeIncluded`
   - Orca：`.worktreeinclude` 列出要「複製」進新 worktree 的 gitignored 檔（`.env`、`.vscode/settings.json`）；`orca.yaml` 的 `worktree.sharedDirectories` 列出要「連結」的大目錄（`node_modules`、`.cache`）。只處理確實被 gitignore 且存在的路徑。
   - 本方案：選項③「使用獨立 worktree」只做 `git worktree add -b`（`studio/server.mjs` 約 1590 行），新目錄沒有 `.env`、`node_modules`，成員第一件事就是裝依賴或卡在缺設定，燒額度。
   - 改法：worktree 建好後讀專案根的 `.worktreeinclude`（沿用 Orca 的檔名與語法：純字面路徑、`#` 註解），逐一用 `git check-ignore` 確認後複製；目錄用 junction（`fs.symlink(..., 'junction')`，Windows 不需要管理員）。沒有這個檔就維持現狀。約 30 行。

3. **成員完成時回報「改了哪些檔案」（Orca `worker_done --files-modified`）** — 已實作：`STATUS_RULES` 的 `FILES:` 行、`reportFiles` 比對前後快照、`card.files` 事件
   - Orca：`worker_done` 必帶 `--outcome succeeded|failed`，可附 `--files-modified`、`--report-path`；另有 AI 行歸屬（Attribution）記錄哪些行是 Agent 寫的。
   - 本方案：README 明寫「Agent 執行當中的修改，無法分辨是它自己改的還是別人改的」。卡結束時 Studio 有樹指紋（HEAD、branch、檔案 mtime），但沒有成員自己的清單可對照。
   - 改法：`STATUS_RULES` 多一行選填 `FILES: a, b, c`（成員列出自己改過的檔）；卡結束時比對指紋差異，有改動但不在清單的檔記進 activity 與事件（只標記，不阻擋）。在 `EXTERNAL_MODIFICATION_DETECTED` 之外多一個弱證據，約 15 行。

### B. 可考慮（有價值，但要先想清楚觸發條件）

4. **「沉默不等於死亡」：停止前要正面證據（Orca liveness 三值 `live / unverifiable / exited`）**
   - Orca：協調者只有在「程序已退出」「worker 自己回報退出」「transcript 最後一回合沒送 worker_done」才可以 stop／retry；逾時、空等、聯絡不上一律是 `unverifiable`，只能繼續等或檢查，不可當失敗處理。
   - 本方案：`CARD_STALL_MS` = 15 分鐘沒有新訊息就切斷那一步，交給工頭重試；8 分鐘顯示「可能卡住」。租約那邊已經是同一哲學（心跳逾時不算死、未知保留所有權），但卡片這邊還是純逾時。
   - 改法：15 分鐘到時先看證據：Codex 已有 `codex-runtime.mjs` 的程序樹（工具子程序還活著、CPU 有動就延長一次再等）；Claude／Antigravity 若 AionCore 仍有進行中的 tool call 事件也延長。真的無任何活體證據才切。要先定義「最多延長幾次」避免無限等；建議先量現在 15 分鐘誤殺的實際頻率再決定。

5. **成員能問工頭、不必問人（Orca `ask` → 協調者 `reply`）** — 已實作（2026-10-17）：`STATUS: ASK_LEADER`、`askLeader`、每卡最多 2 次
   - Orca：worker 用 `ask --options --timeout` 問協調者，協調者 `reply`；問題有 message id，逾時後可恢復同一題。另有協調者自己的 decision gate 擋住 DAG 任務。
   - 本方案：STATUS 只有 NEEDS_USER（問人）、WAITING_AGENT（等另一位成員）、BLOCKED。規則已禁止拿技術問題問人，所以成員碰到「兩種做法選哪個」時只能自己猜或 BLOCKED。
   - 改法：新增 `STATUS: ASK_LEADER: <問題>` + `OPTIONS:`，Studio 用一回合問工頭（工頭本來就是強模型、只規劃不讀檔，便宜），把答案 wake 回成員。符合 [multi-model-principles.md](multi-model-principles.md) 第 4 條「不確定時往上」。要防循環（同一卡最多問 2 次）。

6. **任務規格五要素（Orca Task-spec contract）**
   - Orca 要求每個 Task 自含：Target（範圍）、Change（結果）、Constraints（不可碰）、Ownership（可編輯哪些檔）、Observable acceptance（驗收證據）。
   - 本方案已有驗收標準；缺 Ownership／do-not-touch。在工頭規劃 prompt 裡加一句「列出這張卡不可修改的範圍」即可，純 prompt 改動。

### C. 不需要借（本方案已有等價物，或不在定位內）

- **Run／Task／Dispatch／FIFO inbox／ack／重播**：Orca 需要這套是因為 Agent 彼此是對等的終端機、靠郵箱通訊；本方案所有訊息都經過 Studio 單點，租約與卡片已有 generation 防舊執行回寫。
- **worktree 註解欄（checkpoint comment）**：本方案「最近活動（白話）」與「詢問進度」已涵蓋。
- **三個 Agent 賽跑同一題選贏家**：用現有「獨立 worktree + 審查卡」就能組出來，但要三倍額度，與「省額度」策略相反；不做預設功能。
- **Agent hooks 推播狀態**：Orca 靠在 `~/.claude`、`~/.codex` 裝 hooks 回報 working／waiting／done。本方案的 Claude 走 AionCore 已拿得到事件；裝 hooks 會動到使用者平常的 Claude 設定，違反「Studio 不污染使用者紀錄」。等第 4 項做了還不夠再考慮。
- **休眠（hibernation）、session 恢復、SSH worktree、手機 App、Design Mode、Annotate AI Diff、Linear／Jira**：IDE 功能，本方案是無人值守引擎，不在範圍。
- **讀本機用量檔算額度**：本方案已讀 Claude／Codex 額度；Orca 的估算費用表是推算值，不比較準。
- **版本相容（legacy contract、capability negotiation）**：Orca 要處理 client 與遠端 server 版本不同；本方案單機單程序，無此問題。

## 工程上順帶可學的小點（不排程，記下）

- Windows 子程序一律 `windowsHide`、拒絕 `shell: true`、`.cmd` 參數要編碼；讀程序表用原生 API 而不是每次 fork `powershell.exe`（EDR 評分與速度）。本方案目前用 CIM 查詢，單人使用可接受。
- 稽核證據放 `docs/audits/<題目>/{README, reproduce, results.json, fix.patch}`，與本方案 `runtime/audit-*/evidence.json` + [audit-batches.md](audit-batches.md) 同一思路，不用改。
- 指引由程式本身提供（`orca skills get`）以免與版本脫節；本方案 prompt 內嵌在 `server.mjs`，效果相同。

## 來源

- https://github.com/stablyai/orca（v1.4.229，2026-10-17；MIT；GitHub 約 9.5 萬星）
- 倉庫內 `skill-guides/orchestration.md` 及 `skill-guides/orchestration/references/*.md`（worker contract、messaging、recovery）
- `skill-guides/orca-cli.md`、`skill-guides/orca-cli/references/automations.md`
- `docs/site/content/docs/`：`cli/orchestration.mdx`、`model/worktrees.mdx`、`cli/automations.mdx`、`agents/hooks-memory.mdx`、`agents/hibernation.mdx`、`review/attribution.mdx`、`recipes/parallel-agents.mdx`
- 本方案：`studio/server.mjs`（`STATUS_RULES`、`CARD_STALL_MS`、`runRoutines`、worktree 建立）、[workspace-lease.md](workspace-lease.md)、[runtime-ownership.md](runtime-ownership.md)、[multi-model-principles.md](multi-model-principles.md)
- 工具索引：nanachi1212/nana-index-collection#165
