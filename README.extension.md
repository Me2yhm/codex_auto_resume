# Codex Auto Resume

Codex Auto Resume is a companion extension for the official OpenAI Codex VS Code extension.

It provides two independent automation features:

1. **Auto Resume** — continues a real work conversation after a usage-limit interruption.
2. **Quota Window Primer** — sends a tiny request after a rolling quota reset so the next quota window starts counting immediately instead of waiting for your next real work session.

The two features use separate state and separate conversations.

## Auto Resume

When a Codex task stops because a usage limit has been reached, Auto Resume remembers the exact work conversation and Codex's reported reset time. After quota becomes available again, it reopens that same conversation and sends the configured continuation prompt.

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
- checks for remaining account-level quota blockers;
- performs a final randomized preflight check;
- only then sends one tiny primer request.

If both the primary and secondary windows reset together, only **one** primer request is sent.

Primer does not treat every future `resetAt` as proof that a new rolling window is active. After a reset, Codex can report a dormant window whose `resetAt` moves forward with wall-clock time (approximately `now + windowDuration`). The extension therefore samples the window across polls:

- a **moving** `resetAt` means the window is still dormant and should be primed;
- a **fixed** `resetAt` means a real Codex request has already started the new window, so Primer skips it;
- an ambiguous sample is left pending until another observation is available.

After sending a primer, the extension uses the same rule in reverse: the window is only confirmed as activated once `resetAt` stops moving.

### Dedicated conversation

The first time a primer is actually needed, the extension creates a dedicated persistent conversation named:

```text
Codex Auto Resume - Quota Primer
```

Future primer requests reuse that conversation instead of creating a new one.

The Primer conversation is isolated from Auto Resume work-thread discovery.

### Low-cost model policy

Before each primer request, the extension calls Codex `model/list` and dynamically selects a low-cost model.

The default preference is:

```text
luna
```

If multiple matching models are available, lightweight variants are preferred. Primer also selects the lowest supported reasoning effort by default.

If Luna is unavailable, the extension falls back to another low-cost-looking model when possible, then to the current catalog default as a last resort, and logs the fallback.

The model override applies only to the dedicated Primer conversation. Auto Resume never changes the model of your real work conversation.

### Enable Primer

Run:

```text
Codex Auto Resume: Enable Quota Primer
```

Primer is intentionally disabled by default.

**Important:** Primer is account-wide in purpose but the extension state is local to one extension host. If you have both local VS Code and Remote SSH installed for the same Codex account, enable Quota Primer on only one of them.

The setting is machine-scoped so local and Remote SSH instances can be configured independently.

### Test Primer immediately

Run:

```text
Codex Auto Resume: Prime Quota Now
```

This sends one manual primer immediately and is the recommended smoke test for:

- first-time dedicated thread creation;
- low-cost model selection;
- thread naming;
- later thread reuse;
- local or Remote SSH transport compatibility.

`Prime Quota Now` is a manual smoke test. It works even when automatic Primer is disabled, and it does **not** enable automatic priming. Run `Codex Auto Resume: Enable Quota Primer` separately when you are ready for reset-time automation.

The dedicated Primer conversation is created in the workspace where the first primer is created so it can appear in that workspace's Codex conversation history. The stored thread is then reused globally by that extension host.

### Primer status

Run:

```text
Codex Auto Resume: Show Quota Primer Status
```

To forget the dedicated primer conversation and force a new one on the next primer:

```text
Codex Auto Resume: Reset Quota Primer Thread
```

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

Adds a small randomized preflight delay. The extension rereads rate limits after this delay, which helps suppress duplicate primers when multiple VS Code windows are running.

#### `quotaPrimer.modelPreference`

Model name or substring to prefer. Default: `luna`.

#### `quotaPrimer.reasoningEffort`

Default: `lowest`. The extension selects the lowest effort advertised by the chosen model. You may also provide an explicit supported effort.

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

Quota Primer should have a **single owner** for a Codex account. If the same account is used in both local and Remote SSH environments, enable Primer on only one extension host.

## Safety behavior

Auto Resume:

- resumes only the persisted target work thread;
- does not send to an arbitrary visible conversation;
- keeps a task armed if the correct Codex UI owner cannot be found;
- verifies the resumed turn before disarming.

Quota Primer:

- uses a dedicated conversation;
- never intentionally primes a real work conversation;
- skips priming when a new window has already started naturally;
- skips while another Codex thread is active;
- does not repeatedly create new conversations;
- uses a low-cost model preference and lowest supported reasoning effort;
- does not bypass approval prompts;
- uses a prompt that explicitly forbids file inspection, tools, and modifications.
