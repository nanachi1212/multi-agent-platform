# Multi-Agent Platform

Windows-first experimental multi-agent collaboration platform.

Core direction:

- AionCore as the agent runtime
- An external Conductor for orchestration, policy, and verification
- Heterogeneous agents: Claude Code, OpenAI Codex, Google Antigravity, and future Gemini CLI or local LLM support
- Separate Agent from Role
- Future runtime Leader handoff
- Per-task-attempt Git worktrees
- Deterministic verification
- Experiment mode

## Current Status

**Architecture V1 completed. P0 Spike completed with NO-GO for MVP-0 under current gates. Blocker resolution is in progress.**

This is an experimental research project and is not ready for product use.

## Multi-Agent Studio (MVP)

A local web page where Claude Code, Codex and Antigravity work as one team. Pick any available agent as Leader; the others are Workers. The Leader splits your request into tasks and assigns them, Workers do the work in your project folder, and the Leader writes a final report.

Start: double-click `start-studio.cmd` (needs Node.js). The browser opens `http://127.0.0.1:4848`. Close the console window to stop the Studio.

- Multiple projects at the same time: every opened project gets its own tab (`#p=<folder>`) with its own Leader, Workers (turn an agent off for one project), models, cards, team chat, pause/stop and history. Switching tabs never stops work. ✎ 改名 sets a display name used in tabs, overview and notifications. Projects run in parallel; one agent can work for two projects at once (separate conversations, shared plan limits).
- 總覽 (overview) tab: one card per project (status, progress bar, current cards), one-click 暫停／繼續 per project, a 誰在做什麼 table (agents × projects) and all staff seats.
- Work lifecycle: a worker's turn ending is not a card being done. Every worker reply ends with a STATUS line (DONE / WAITING_EXTERNAL / WAITING_AGENT / NEEDS_USER). Waiting cards are parked and woken in the same conversation: when the awaited agent finishes, when a GitHub PR's CI finishes (checked every minute with `gh`), or when you answer. Waits Studio cannot check say 「需要你按繼續」. Cards can depend on earlier cards (`after`). When every card has ended, the 工頭 checks the whole request and adds cards if it is not complete (max 3 extra rounds, then it asks you). Check: `node studio/lifecycle-check.cjs`.
- 現在發生什麼 (top of each project page) and every overview card answer: progress, what we wait for, what happens next, and 你現在需要做什麼 (🔴 需要 Nana with the question and answer buttons).
- Work memory: each project keeps a short summary of its latest job (goal, cards, results, PR / branch / commit, waits, open question). A new job gets it as background; 「↻ 接著上次的工作」 or a request starting with 繼續 continues from it (a paused job simply resumes), and a new 工頭 gets the same summary. Raw agent JSON and errors appear only under 查看技術細節.
- Project State / Handoff Memory: with no job running, each project shows a state card (上次目標 / 已完成 / 目前 / 接下來 / 你現在) built from the last job plus the real Git / GitHub state read with `git` and `gh` (main SHA, local branch, open and merged PRs, CI per check, unresolved review threads). Git / GitHub wins over older agent notes. Refreshed when Studio starts, when a project tab opens (if older than 2 minutes), when a job ends, before ▶ 接著處理 and before a 工頭 handoff, or with ↻ 重新整理狀態. ▶ 接著處理 and a new 工頭 get the same handoff text.
- 做完之後 (per project, on the project page): ① 完成就停 (default: report and wait), ② 完成後建議下一步 (the 工頭 adds 1–3 next steps with a reason; ▶ 做這個 starts one as a continuation), ③ 自動持續開發 (opt-in with a confirmation: after a done job the 工頭's first suggestion starts automatically; at most 5 in a row, and a failure, a question, pause or Stop ends the chain).
- Each agent has a seat card with its model and reasoning-effort picker (lists come from the agent itself; Antigravity uses its default). Model choices are per project (set on the project page) and apply from the next run.
- Open project tabs (with each Leader), recent projects and model choices are saved in `runtime/studio/settings.json`. Every run is saved in `runtime/studio/history/` and can be reopened from the 歷史紀錄 list.
- The Leader spreads independent subtasks across Workers, which run at the same time (one task per Worker at a time).
- Home page: today's finished cards, Leader office (hand the request to the Leader), staff seats showing model, effort, current card and last finished card.
- 接手當 Leader works mid-run: the new Leader gets the original request and the current cards; Workers keep their cards.
- 暫停 keeps cards and agent conversations; each open project's paused job is shown again after restarting the Studio and 繼續 picks it up. A working job is saved on every event, so closing the Studio mid-job shows it as 中斷（可繼續） after a restart. Older paused or interrupted jobs can be continued from 歷史紀錄.
- Plan limits: Claude (5-hour + weekly) and Codex (weekly) usage bars with reset time on each seat. Claude is read with one tiny Haiku request that is not saved as a session (on start, after each job, or 更新); Codex is read from Studio's own Codex logs. Antigravity does not report limits.
- Windows notifications (🔔 button): every finished job sends a Windows toast such as 「股票面板：Codex 已完成 3/3 工作」 or 「FamilyPDF：Claude Code 需要你處理」 (a card failed or the Leader could not plan). Clicking it opens that project tab. Open pages also play a sound. Turning 🔔 on shows a test toast. Windows Focus Assist / Do Not Disturb can hide toasts.
- Paseo: status light and 用 Paseo 開啟目前專案 (opens Paseo and registers the folder as a Paseo workspace) for Paseo's own remote / phone features.
- First start downloads AionCore v0.2.2 (official release, SHA-256 checked) into `runtime/`.
- Studio runs Codex with its own home (`runtime/studio/codex-home`), so Studio sessions never show up in your normal Codex history. Log in once with the 登入 Codex（Studio 專用） button on the Codex card.
- Agents must already be installed and logged in (`claude auth login`, `codex login`). The Team panel shows `Unavailable` with the reason otherwise; click 重新檢查 Agent after fixing.
- Workers can edit files and run commands in the chosen folder without asking (Claude: `bypassPermissions`, Codex: `auto`). Use disposable or version-controlled projects only.
- Known limits: AionCore writes an `.agents/` folder into the project when Antigravity works there. A finished run is not shown on the board after a restart (it stays in history).

## Documentation

- [Architecture V1](docs/architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md)
- [Codex Architecture Review](docs/architecture/ARCHITECTURE_REVIEW_CODEX.md)
- [P0 Spike Report](docs/reports/P0_SPIKE_REPORT.md)

## Safety Status

Currently suitable only for disposable, non-sensitive repositories. A Git worktree is not a security sandbox. Use with production repositories or sensitive credentials has not been approved.
