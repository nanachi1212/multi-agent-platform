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

- Each agent has a seat card with its model and reasoning-effort picker (lists come from the agent itself; Antigravity uses its default). Changes apply from the next run.
- Leader, project, recent projects and model choices are saved in `runtime/studio/settings.json`. Every run is saved in `runtime/studio/history/` and can be reopened from the 歷史紀錄 list.
- The Leader spreads independent subtasks across Workers, which run at the same time (one task per Worker at a time).
- First start downloads AionCore v0.2.2 (official release, SHA-256 checked) into `runtime/`.
- Studio runs Codex with its own home (`runtime/studio/codex-home`), so Studio sessions never show up in your normal Codex history. Log in once with the 登入 Codex（Studio 專用） button on the Codex card.
- Agents must already be installed and logged in (`claude auth login`, `codex login`). The Team panel shows `Unavailable` with the reason otherwise; click 重新檢查 Agent after fixing.
- Workers can edit files and run commands in the chosen folder without asking (Claude: `bypassPermissions`, Codex: `auto`). Use disposable or version-controlled projects only.
- Known limits: AionCore writes an `.agents/` folder into the project when Antigravity works there. Restarting the Studio clears the current board (past runs stay in history).

## Documentation

- [Architecture V1](docs/architecture/MULTI_AGENT_PLATFORM_ARCHITECTURE_V1.md)
- [Codex Architecture Review](docs/architecture/ARCHITECTURE_REVIEW_CODEX.md)
- [P0 Spike Report](docs/reports/P0_SPIKE_REPORT.md)

## Safety Status

Currently suitable only for disposable, non-sensitive repositories. A Git worktree is not a security sandbox. Use with production repositories or sensitive credentials has not been approved.
