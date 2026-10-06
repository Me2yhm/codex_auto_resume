# Codex Auto Resume

A private VS Code companion extension that resumes OpenAI Codex work after a usage-limit interruption.

The extension reads Codex's reported reset timestamp, remembers the exact VS Code thread that was interrupted, waits for quota recovery, surfaces that same conversation, and asks the official Codex extension to continue it through Codex UI IPC.

## Current status

Phase 2 has been validated end-to-end on Windows with the official `openai.chatgpt` extension:

- real 5-hour quota interruption detected;
- exact Codex thread armed and persisted;
- quota reset observed;
- target conversation surfaced automatically;
- Codex UI IPC owner discovered;
- continuation turn started on the same thread;
- resumed turn verified before disarming.

The extension remains fail-closed: if it cannot identify the correct thread owner or verify the resumed turn, it keeps the thread armed instead of sending to another conversation.

## Project layout

```text
src/
  extension.ts              VS Code activation and commands
  autoResumeController.ts   quota/thread state machine
  codexRpcClient.ts         read-only Codex app-server client
  codexUiIpcClient.ts       Codex UI IPC follower client
  codexLocator.ts           finds Codex bundled with openai.chatgpt
  types.ts                  minimal protocol types

scripts/windows/
  resume-codex.ahk          Phase 1 UI-automation fallback

docs/
  architecture.md           architecture and safety model
  phase1-windows.md         Task Scheduler + AutoHotkey setup
```

## Development

Requirements:

- Node.js 22+
- VS Code
- official OpenAI Codex extension (`openai.chatgpt`)

Install dependencies and type-check:

```bash
npm ci
npm run check
```

Compile:

```bash
npm run compile
```

Press `F5` to launch an Extension Development Host.

## Build a VSIX

Build a locally installable VSIX:

```bash
npm ci
npm run package:vsix
```

The output is:

```text
codex-auto-resume.vsix
```

The GitHub Actions CI workflow also builds the same VSIX and uploads it as the `codex-auto-resume-vsix` artifact.

## Install the VSIX locally

In a normal VS Code window:

1. Open **Extensions**.
2. Open the Extensions `...` menu.
3. Choose **Install from VSIX...**.
4. Select `codex-auto-resume.vsix`.
5. Reload VS Code when prompted.

Then run:

```text
Codex Auto Resume: Enable
```

Useful commands:

- `Codex Auto Resume: Enable`
- `Codex Auto Resume: Disable`
- `Codex Auto Resume: Show Status`
- `Codex Auto Resume: Resume Now`
- `Codex Auto Resume: Test Official UI IPC Bridge`
- `Codex Auto Resume: Diagnose Official Codex Integration`

## Remote SSH installation

The extension declares:

```json
"extensionKind": ["workspace"]
```

Therefore, when working through VS Code Remote SSH, install the same VSIX into the **SSH remote extension host** alongside the remote instance of `openai.chatgpt`.

The same VSIX is intended for both local Windows workspaces and Remote SSH Linux workspaces. Remote SSH still requires its own validation because the Codex executable and IPC socket live on the remote host.

## Important settings

```json
{
  "codexAutoResume.enabled": false,
  "codexAutoResume.resumePrompt": "继续。从中断处恢复，先检查当前工作区已有修改和上一轮状态，不要重复已经完成的工作。",
  "codexAutoResume.pollIntervalSeconds": 60,
  "codexAutoResume.resetGraceSeconds": 90,
  "codexAutoResume.resumeStabilitySeconds": 15,
  "codexAutoResume.recentThreadMinutes": 480
}
```

## Safety model

Auto Resume does not bypass Codex approval prompts.

A quota interruption is armed only when the latest relevant thread state and account-level rate-limit state support that conclusion. After quota reset, the extension resumes only the persisted thread ID, verifies that a new turn appeared, and keeps verification state persisted until that turn is completed or stable.

## Phase 1 fallback

If a future Codex extension update breaks the UI IPC integration, `scripts/windows/resume-codex.ahk` remains available as the Phase 1 UI-automation fallback.

## Python policy

There are currently no Python helpers in this repository. If Python scripts are added later, use **uv** for dependency/project management and configure:

```toml
[[tool.uv.index]]
url = "https://mirrors.aliyun.com/pypi/simple"
```

Do not introduce pip/requirements.txt-based project management alongside uv.
