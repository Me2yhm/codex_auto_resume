# codex_auto_resume

A private companion project for resuming VS Code Codex work automatically after a usage-limit interruption.

The key idea is **not** to wait a hard-coded five hours. The extension reads Codex's reported rate-limit reset timestamp, remembers the exact VS Code thread that failed because of quota, waits for the reset, verifies quota is available again, and then starts a new turn on that same thread with a continuation prompt.

## Project layout

```text
src/
  extension.ts              VS Code activation and commands
  autoResumeController.ts   quota/thread state machine
  codexRpcClient.ts         JSON-RPC client for Codex app-server
  codexLocator.ts           finds Codex bundled with openai.chatgpt
  types.ts                  minimal protocol types

scripts/windows/
  resume-codex.ahk          Phase 1 UI-automation fallback

docs/
  architecture.md           Phase 2 design and safety model
  phase1-windows.md         Task Scheduler + AutoHotkey setup
```

## Phase 2 behavior

When `codexAutoResume.enabled` is enabled, the extension periodically:

1. starts Codex app-server using the executable bundled with the official `openai.chatgpt` VS Code extension;
2. reads `account/rateLimits/read`;
3. lists recent threads from `sourceKinds: ["vscode"]` for the current workspace;
4. reads the newest thread's latest turn;
5. only arms auto-resume when that turn failed with structured `usageLimitExceeded` or `rateLimitExceeded`;
6. persists the thread ID and actual reset timestamp;
7. after reset + a configurable grace period, rechecks quota;
8. calls `thread/resume` and then `turn/start` with the configured continuation prompt.

Normal task completion does **not** trigger an automatic continuation.

## Development

Requirements:

- Node.js 22+
- VS Code
- official OpenAI Codex extension (`openai.chatgpt`)

Install and type-check:

```bash
npm install
npm run check
```

Compile:

```bash
npm run compile
```

Open the repository in VS Code and press `F5` to launch an Extension Development Host.

In the development host, run:

```text
Codex Auto Resume: Enable
```

Useful commands:

- `Codex Auto Resume: Enable`
- `Codex Auto Resume: Disable`
- `Codex Auto Resume: Show Status`
- `Codex Auto Resume: Resume Now`

The status bar shows whether the extension is Off, Monitoring, or waiting for a reset.

## Important settings

```json
{
  "codexAutoResume.enabled": false,
  "codexAutoResume.resumePrompt": "继续。从中断处恢复，先检查当前工作区已有修改和上一轮状态，不要重复已经完成的工作。",
  "codexAutoResume.pollIntervalSeconds": 60,
  "codexAutoResume.resetGraceSeconds": 90,
  "codexAutoResume.recentThreadMinutes": 180
}
```

Auto resume is disabled by default until the integration is validated on a real quota interruption.

## Phase 1 fallback

If the app-server integration breaks after a Codex extension update, use `scripts/windows/resume-codex.ahk` with Windows Task Scheduler. See `docs/phase1-windows.md`.

## Python policy

There are currently no Python helpers in this repository. If Python scripts are added later, use **uv** for dependency/project management and configure the requested index in `pyproject.toml`:

```toml
[[tool.uv.index]]
url = "https://mirrors.aliyun.com/pypi/simple"
```

Do not introduce pip/requirements.txt-based project management alongside uv.

## Current status

The first implementation is in place. Before relying on it for unattended overnight work, validate these cases in an Extension Development Host:

- the bundled Codex executable is found correctly on Windows;
- the current VS Code thread is returned by `thread/list` with the workspace `cwd`;
- a real 5-hour quota interruption is reported as `usageLimitExceeded` or `rateLimitExceeded`;
- `resetsAt` matches the reset shown by Codex usage UI;
- after reset, `thread/resume` + `turn/start` continues the same conversation;
- approval-required tool calls remain gated rather than being auto-approved.

See `docs/architecture.md` for the design and known risks.
