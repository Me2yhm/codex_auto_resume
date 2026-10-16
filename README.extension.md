# Codex Auto Resume

Codex Auto Resume is a companion extension for the official OpenAI Codex VS Code extension.

It provides two independent automation features:

1. **Auto Resume** — continues a real work conversation after a usage-limit interruption.
2. **Quota Window Primer** — sends a tiny request after a rolling quota reset so the next quota window starts counting immediately instead of waiting for your next real work session.

The two features use separate state and separate conversations.

## Auto Resume

When a work turn reports a structured quota error, Auto Resume remembers that exact turn and conversation. It independently reads account quota twice, at least 10 seconds apart, before reopening the same conversation and sending the configured continuation prompt. Confirmed quota recovery can resume work before the reported reset time, including an unexpected early account reset.

The reported reset time is an expectation, not a required wait. Network errors, unknown quota state, and contradictory responses cancel availability confirmation while keeping the recovery target. An interrupted turn without a structured quota error, including a manual Stop, cannot become eligible just because the account is blocked.

The continuation uses the official Codex UI owner and inherits the work conversation's model and reasoning settings. Before submitting, Auto Resume persists a dispatch record shared by windows on the same host. If acknowledgement is lost or the new turn is slow to appear, it keeps verifying that attempt without resending, including after a window reload. A definitive no-owner response leaves the task armed for a later confirmed retry.

A resumed turn briefly marked `interrupted` without an error remains under verification. A completed turn disarms immediately; an in-progress turn must remain continuously stable for the configured stability interval.

Enable it from the Command Palette:

```text
Codex Auto Resume: Enable
```

Inspect its state with:

```text
Codex Auto Resume: Show Status
```

Auto Resume never uses the Quota Primer conversation as a work thread.

## Quota Window Primer

Codex rolling quota windows can begin when the first request is made after a reset. If you do not use Codex immediately after a reset, the next reset can therefore move later.

Quota Window Primer watches the primary and secondary Codex quota reset times. After a tracked reset:

- it waits for a configurable grace period;
- checks whether another real Codex request has already started the new window;
- checks whether another Codex thread is currently active;
- gives priority to Pending, Armed, or Verifying work recovery in any window sharing the same host storage;
- checks for remaining account-level quota blockers;
- performs a final randomized preflight check;
- only then sends one tiny primer request.

If both the primary and secondary windows reset together, only **one** primer request is sent.

Primer does not treat every future `resetAt` as proof that a new rolling window is active. After a reset, Codex can report a dormant window whose `resetAt` moves forward with wall-clock time (approximately `now + windowDuration`). The extension therefore samples the window across polls:

- a **moving** `resetAt` means the window is still dormant and should be primed;
- a **fixed** `resetAt` means a real Codex request has already started the new window, so Primer skips it;
- an ambiguous sample is left pending until another observation is available.

Automatic sends require fresh observations at least 15 seconds apart. This confirmation interval still applies when jitter is set to zero. After sending a primer, the window is only confirmed as activated once `resetAt` stops moving.

When quota is blocked or unknown, work recovery has priority, or a previous send is unresolved, Primer pauses sending and continues monitoring quota boundaries. A request that fails because of transport uncertainty stays pending instead of being sent again blindly.

### Dedicated conversation

The first time a primer is actually needed, the extension creates a dedicated persistent conversation named:

```text
Codex Auto Resume - Quota Primer
```

Future primer requests reuse that conversation instead of creating a new one.

The current and historical Primer conversations are isolated from Auto Resume work-thread discovery. The extension retains up to 256 known Primer IDs and also recognizes trusted Primer metadata when the current ID is missing. A normal work conversation whose title merely contains “Primer” is still eligible.

### Low-cost model policy

Before each primer request, the extension calls Codex `model/list` and dynamically selects a low-cost model.

The default preference is:

```text
luna
```

If multiple matching models are available, lightweight variants are preferred. Primer also selects the lowest supported reasoning effort by default.

If the preferred model is unavailable, Primer now **skips the automatic request by default** rather than silently falling back to a potentially more expensive model. You can opt into fallback behavior with `codexAutoResume.quotaPrimer.allowModelFallback`.

The model override applies only to the dedicated Primer conversation. Auto Resume never changes the model of your real work conversation.

### Enable Primer

Run:

```text
Codex Auto Resume: Enable Quota Primer
```

Primer is intentionally disabled by default.

**Important:** For a single Codex account, enable automatic Primer in one designated Local or Remote environment only.

The setting is machine-scoped so local and Remote SSH instances can be configured independently.

Windows sharing the extension's global storage on the same Local or Remote host coordinate work-recovery priority and Primer sends. Primer uses a short atomic send lock and a durable shared journal, so a second window sees pending attempts and already-handled boundaries even if its local state is stale. Coordination does not span different physical hosts or separate storage profiles.

### Test Primer immediately

Run:

```text
Codex Auto Resume: Prime Quota Now
```

This requests one manual primer, subject to quota, active-work, work-recovery priority, and unresolved-send guards. When those checks pass, it can be used to smoke-test:

- first-time dedicated thread creation;
- low-cost model selection;
- thread naming;
- later thread reuse;
- local or Remote SSH transport compatibility.

`Prime Quota Now` works even when automatic Primer is disabled and does **not** enable automatic priming. A blocked or unknown quota state, pending/armed/verifying work, an active thread, or an unresolved Primer attempt suppresses the request with a message. Run `Codex Auto Resume: Enable Quota Primer` separately when you are ready for reset-time automation.

The dedicated Primer conversation is created in the workspace where the first primer is created so it can appear in that workspace's Codex conversation history. The stored thread is then reused globally by that extension host.

### Primer status

Run:

```text
Codex Auto Resume: Show Quota Primer Status
```

To select a new dedicated conversation for the next permitted primer:

```text
Codex Auto Resume: Reset Quota Primer Thread
```

Reset preserves historical Primer identities and any unresolved send. It cannot bypass pending confirmation or make an old Primer conversation eligible for work recovery.

## Requirements

- VS Code
- official OpenAI Codex extension: `openai.chatgpt`
- Codex Auto Resume installed in the same VS Code extension host as Codex

For local workspaces, install both extensions locally.

For Remote SSH workspaces, install both extensions on the **SSH remote** side.

## Commands

### Auto Resume

- `Codex Auto Resume: Enable`
- `Codex Auto Resume: Disable`
- `Codex Auto Resume: Show Status`
- `Codex Auto Resume: Resume Now`

### Quota Primer

- `Codex Auto Resume: Enable Quota Primer`
- `Codex Auto Resume: Disable Quota Primer`
- `Codex Auto Resume: Show Quota Primer Status`
- `Codex Auto Resume: Prime Quota Now`
- `Codex Auto Resume: Reset Quota Primer Thread`

### Diagnostics

- `Codex Auto Resume: Test Official UI IPC Bridge`
- `Codex Auto Resume: Diagnose Official Codex Integration`
- `Codex Auto Resume: Test Official Submit Bridge (Legacy)`

## Configuration

Open VS Code Settings and search for **Codex Auto Resume**, or edit Settings JSON.

### Auto Resume settings

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

#### `resetGraceSeconds`

Legacy allowance for the expected Auto Resume reset time. It is not a minimum wait: two independent available quota reads at least 10 seconds apart can resume an armed work conversation earlier. Primer has a separate `quotaPrimer.graceSeconds` setting.

### Quota Primer settings

```json
{
  "codexAutoResume.quotaPrimer.enabled": false,
  "codexAutoResume.quotaPrimer.primaryEnabled": true,
  "codexAutoResume.quotaPrimer.secondaryEnabled": true,
  "codexAutoResume.quotaPrimer.pollIntervalSeconds": 60,
  "codexAutoResume.quotaPrimer.graceSeconds": 90,
  "codexAutoResume.quotaPrimer.jitterSeconds": 15,
  "codexAutoResume.quotaPrimer.modelPreference": "luna",
  "codexAutoResume.quotaPrimer.reasoningEffort": "lowest",
  "codexAutoResume.quotaPrimer.allowModelFallback": false,
  "codexAutoResume.quotaPrimer.prompt": "Quota window primer. Reply exactly OK. Do not inspect files, run tools, or modify anything."
}
```

#### `quotaPrimer.primaryEnabled`

Controls priming of the primary rolling quota window, normally the shorter 5-hour window.

#### `quotaPrimer.secondaryEnabled`

Controls priming of the secondary rolling quota window, normally the weekly window.

#### `quotaPrimer.graceSeconds`

Delay after the tracked reset time before Primer decides the window is still dormant.

#### `quotaPrimer.jitterSeconds`

Adds a small randomized preflight delay. The extension rereads quota and work-recovery priority before sending. Automatic moving-window confirmation still requires observations at least 15 seconds apart when this value is zero.

#### `quotaPrimer.modelPreference`

Model name or substring to prefer. Default: `luna`.

#### `quotaPrimer.reasoningEffort`

Default: `lowest`. The extension selects the lowest effort advertised by the chosen model. You may also provide an explicit supported effort.

#### `quotaPrimer.allowModelFallback`

Default: `false`. When disabled, Primer skips the request if the preferred low-cost model is unavailable instead of silently choosing a potentially more expensive model. Enable this only if you explicitly accept fallback model usage.

## Status and logs

Detailed logs are available from:

```text
View -> Output -> Codex Auto Resume
```

Auto Resume log lines use the `[auto-resume]` prefix.

Quota Primer log lines use the `[quota-primer]` prefix.

This separation makes it easy to distinguish work recovery from quota-window priming.

## Local and Remote SSH behavior

The extension is a workspace extension.

For Remote SSH projects, install the same VSIX on the remote host beside the remote Codex extension.

Auto Resume is workspace-oriented and can be enabled independently in local and remote workspaces.

On Remote SSH, the extension reads VS Code's **effective** `http.proxy` setting through the VS Code configuration API and passes that value to the spawned Codex app-server as HTTP/HTTPS proxy environment. The 0.3.9 proxy-resolution chain and official UI IPC route are retained in 0.3.10. The proxy value is never hard-coded, so changing Remote User Settings changes the next spawned monitoring app-server.

Network-source precedence is:

1. effective VS Code `http.proxy`;
2. proxy variables already present in the extension-host environment;
3. on Linux only, a same-user official Codex sibling app-server using the same executable (strict proxy/CA allowlist);
4. direct network access.

The Linux sibling path remains a fallback for environments where the official Codex extension injects network settings that are not visible through the shared extension host. Proxy values are never logged, and authentication/token variables are never copied.

Quota Primer should have a **single designated environment** for a Codex account. If the same account is used on both a Local host and a Remote SSH host, enable automatic Primer in only one of those environments. Same-host coordination does not provide a cross-machine lock.

## Safety behavior

Auto Resume:

- resumes only the persisted target work thread;
- arms new targets only when the work turn has a structured quota error;
- confirms quota availability through two independent reads before automatic submission;
- does not send to an arbitrary visible conversation;
- keeps a task armed if the correct Codex UI owner cannot be found;
- preserves an ambiguous dispatch across windows and reloads without sending a duplicate;
- inherits the work conversation's model and reasoning settings;
- verifies the resumed turn before disarming.

Quota Primer:

- uses a dedicated conversation;
- never intentionally primes a real work conversation;
- skips priming when a new window has already started naturally;
- skips while another Codex thread is active;
- yields to pending, armed, or verifying work across the same host's windows;
- keeps monitoring quota when sending is suppressed;
- does not repeatedly create new conversations;
- serializes automatic and manual sends across windows sharing the same host storage;
- persists uncertain sends before transport and waits for confirmation before another attempt;
- retains historical Primer identities when its current conversation is reset;
- uses a low-cost model preference and lowest supported reasoning effort;
- refuses expensive model fallback by default;
- does not bypass approval prompts;
- uses a prompt that explicitly forbids file inspection, tools, and modifications.

## v0.3.10 review status

This version adds early quota-recovery confirmation, shared fail-closed quota decisions, work-first same-host coordination, durable dispatch tracking, and historical Primer isolation.

Local VSIX installation/UI smoke and real Remote SSH proxy, reload, and recovery smoke remain outstanding during Code Review. Release follows review and validation. Roll back by reinstalling the 0.3.9 VSIX.
