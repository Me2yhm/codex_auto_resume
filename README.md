# codex_auto_resume

Private development repository for the **Codex Auto Resume** VS Code companion extension.

The user-facing extension documentation is kept separately in [README.extension.md](README.extension.md). That file is embedded into the VSIX and shown on the extension details page.

## Goal

The project provides unattended recovery for VS Code Codex tasks interrupted by usage limits.

The implementation has two independent automation paths:

- **Auto Resume** monitors Codex quota/thread state, persists a work turn with a structured quota error, confirms quota availability through two independent reads at least 10 seconds apart, and resumes the exact conversation through official Codex UI IPC. Confirmed availability can resume work before the expected reset time; the resumed turn is verified before disarming.
- **Quota Window Primer** tracks primary/secondary rolling reset boundaries and, when a reset would otherwise remain dormant, sends one tiny request in a dedicated persistent low-cost-model thread so the next rolling window starts immediately.

## v0.3.10 changes and review status

- Both modules share a fail-closed quota classifier. Network errors, malformed responses, and contradictory quota fields do not permit a send. An account quota blocker alone never makes a manual Stop eligible for Auto Resume; a structured quota error on the work turn is required.
- Work recovery has priority over Primer across VS Code windows sharing one host's extension storage. Pending, Armed, and Verifying work suppress Primer sends while quota monitoring continues.
- Automatic work continuations persist a durable dispatch claim before official UI IPC. Other windows adopt that attempt, and an ambiguous acknowledgement or a delayed new turn cannot trigger a duplicate send. A definitive no-owner result permits a later confirmed retry.
- Primer combines a short shared send lock with a persistent send journal. Automatic sends require fresh moving-window evidence from observations at least 15 seconds apart, including when jitter is zero. Manual Prime Quota Now also respects quota, active-work, recovery-priority, and unresolved-send guards.
- Reset Primer Thread preserves known conversation IDs and unresolved confirmations. A bounded history of 256 IDs and trusted Primer metadata keep historical Primer conversations out of work discovery; ordinary work titles containing “Primer” remain eligible.
- Work conversations keep their original model and reasoning settings. The official UI owner route and Remote proxy resolution remain unchanged.

This version is prepared for Code Review. Local VSIX installation/UI smoke and real Remote SSH proxy, reload, and recovery smoke remain outstanding; deterministic automated tests do not replace those checks. Merge and release follow review and validation. To roll back, disable both features, inspect and resolve any unconfirmed continuation, then reinstall the 0.3.9 VSIX before re-enabling automation.

Same-host coordination covers windows sharing extension storage on the same Local or Remote host. It does not coordinate different physical hosts or separate storage profiles. For one Codex account, enable automatic Primer in one designated Local or Remote environment only.

## Project layout

```text
src/
  extension.ts              VS Code activation and commands
  autoResumeController.ts   quota/thread state machine
  codexRpcClient.ts         read-only Codex app-server client
  codexSpawnEnvironment.ts  VS Code/proxy-aware child environment resolution
  codexUiIpc.ts             Codex UI IPC follower client
  codexLocator.ts           locates the Codex executable
  diagnosticRedaction.ts   output-channel and error-message redaction
  quotaAvailability.ts      shared fail-closed quota classification
  recoveryCoordination.ts  same-host work-priority leases
  workRecoveryDispatch.ts  durable automatic work-dispatch claims
  quotaPrimerController.ts  quota-window priming state machine
  quotaPrimerState.ts       persistent primer state
  quotaPrimerWindowLogic.ts moving/fixed rolling-window classification
  quotaPrimerLock.ts        short same-host send lock
  quotaPrimerSendJournal.ts shared pending-send and boundary state
  primerIdentity.ts         current/historical Primer exclusion
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

Run tests:

```bash
npm test
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

GitHub Actions is configured to run type-checking, the full regression suite, VSIX packaging, and artifact upload on pull requests and pushes to `main`.

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

## Previously validated behavior

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

Remote SSH uses the same extension package but is validated separately because the Codex executable, account-network path, and IPC endpoint are provided by the remote environment. Account quota reads are best-effort for thread observation: timeouts preserve the exact pending/armed target while sending remains blocked. In 0.3.10, an ambiguous interruption must acquire a structured quota error before it can arm; later account-level exhaustion alone is insufficient. Version 0.3.9 introduced the effective VS Code `http.proxy` setting before spawning the monitoring app-server, so Remote User Settings can directly supply the same SSH-forwarded proxy path used by the official Codex extension. That network-resolution chain is retained in 0.3.10.

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


## Remote SSH network environment

Before spawning its monitoring app-server, `CodexRpcClient` resolves network configuration in this order:

1. VS Code's effective `http.proxy` value;
2. proxy variables already present in the extension-host process;
3. on Linux, proxy/CA variables from a same-user official Codex sibling using the same executable;
4. direct access.

The effective VS Code value is obtained through `vscode.workspace.getConfiguration("http").get("proxy")`; the extension never hard-codes a proxy host or port. When that setting is present, the child receives the same value as `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, and `https_proxy`.

The Linux sibling fallback copies only a fixed network allowlist. Secret authentication variables and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` are intentionally excluded. Logs report only the chosen source and variable names; proxy values are redacted.
