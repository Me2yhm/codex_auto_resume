# codex_auto_resume

Private development repository for the **Codex Auto Resume** VS Code companion extension.

The user-facing extension documentation is kept separately in [README.extension.md](README.extension.md). That file is embedded into the VSIX and shown on the extension details page.

## Goal

The project provides unattended recovery for VS Code Codex tasks interrupted by usage limits.

The implementation has two independent automation paths:

- **Auto Resume** monitors Codex quota/thread state, persists an interrupted work thread, waits for the reported reset, surfaces the exact conversation, resumes it through the official Codex UI IPC path, and verifies the resumed turn before disarming.
- **Quota Window Primer** tracks primary/secondary rolling reset boundaries and, when a reset would otherwise remain dormant, sends one tiny request in a dedicated persistent low-cost-model thread so the next rolling window starts immediately.

## Project layout

```text
src/
  extension.ts              VS Code activation and commands
  autoResumeController.ts   quota/thread state machine
  codexRpcClient.ts         read-only Codex app-server client
  codexUiIpcClient.ts       Codex UI IPC follower client
  codexLocator.ts           locates the Codex executable
  quotaPrimerController.ts  quota-window priming state machine
  quotaPrimerState.ts       persistent primer state
  officialCodexUi.ts        shared UI IPC transport
  types.ts                  minimal protocol types

scripts/windows/
  resume-codex.ahk          Phase 1 UI-automation fallback

docs/
  architecture.md           architecture and safety model
  phase1-windows.md         Phase 1 fallback setup
```

## Development

Requirements:

- Node.js 22+
- VS Code
- official OpenAI Codex extension (`openai.chatgpt`)

Install dependencies:

```bash
npm ci
```

Type-check:

```bash
npm run check
```

Compile:

```bash
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Build the VSIX

```bash
npm run package:vsix
```

This creates:

```text
codex-auto-resume.vsix
```

The packaging command explicitly uses `README.extension.md` as the VSIX README, so the project README and the installed extension description remain independent.

GitHub Actions also runs type-checking, compilation, VSIX packaging, and artifact upload on pushes to `main`.

## Install for testing

### Local workspace

Install `codex-auto-resume.vsix` from the normal VS Code Extensions view.

### Remote SSH workspace

Connect to the SSH host first, then install the same VSIX into the **remote extension host**.

The extension declares:

```json
"extensionKind": ["workspace"]
```

so it is intended to execute beside the Codex instance associated with the current workspace.

## Current validated behavior

The Windows local flow has been validated end-to-end with a real usage-limit reset:

```text
quota interruption
  -> arm exact thread
  -> persist reset state
  -> quota recovery
  -> surface exact Codex conversation
  -> discover official Codex UI owner
  -> start continuation turn
  -> verify resumed turn
  -> disarm
```

Boundary testing also covers thread switching, Extension Host restart persistence, and two-stage resume verification.

Remote SSH uses the same extension package but is validated separately because the Codex executable and IPC endpoint are provided by the remote environment.

## Packaging files

- `README.md`: repository/developer documentation
- `README.extension.md`: installed extension documentation
- `.vscodeignore`: controls VSIX contents
- `.github/workflows/ci.yml`: checks and packages the VSIX

## Python policy

There are currently no Python helpers in this repository.

If Python is introduced later, use **uv** and configure:

```toml
[[tool.uv.index]]
url = "https://mirrors.aliyun.com/pypi/simple"
```

Do not add pip/`requirements.txt` project management alongside uv.
