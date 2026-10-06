# Codex Auto Resume

Codex Auto Resume is a companion extension for the official OpenAI Codex VS Code extension.

When a Codex task stops because the usage limit has been reached, this extension remembers the interrupted conversation and Codex's reported reset time. After quota becomes available again, it reopens the same Codex conversation and sends a continuation prompt automatically.

## What it does

The extension is designed for long-running Codex work that may be interrupted by usage limits.

It can:

- detect a Codex turn that stopped because of `usageLimitExceeded` or `rateLimitExceeded`;
- remember the exact Codex thread that should be resumed;
- persist the pending resume state across Extension Host restarts;
- wait for the reported quota reset instead of using a fixed five-hour timer;
- reopen the target conversation even if another conversation is currently visible;
- ask the existing official Codex client to start a new turn on that same thread;
- verify that the resumed turn actually started before clearing the pending state;
- keep monitoring if Codex is still quota-blocked after the nominal reset time.

It does **not** bypass Codex approval prompts or automatically approve tool calls.

## Requirements

- VS Code
- the official OpenAI Codex extension: `openai.chatgpt`
- Codex Auto Resume installed in the same VS Code extension host as Codex

For a normal local workspace, install both extensions locally.

For a Remote SSH workspace, install both the Codex extension and Codex Auto Resume on the **SSH remote** side.

## Quick start

After installing the extension, open the Command Palette and run:

```text
Codex Auto Resume: Enable
```

The extension will begin monitoring the current workspace.

When Codex later stops because of a usage limit, Auto Resume records the interrupted thread and waits for quota recovery. No further action is required.

To inspect the current state, run:

```text
Codex Auto Resume: Show Status
```

To disable monitoring:

```text
Codex Auto Resume: Disable
```

## Commands

### Codex Auto Resume: Enable

Enables automatic monitoring for the current workspace.

If a recent Codex thread in the workspace is already quota-blocked, the extension can arm that thread immediately.

### Codex Auto Resume: Disable

Disables monitoring and stops automatic resume attempts.

### Codex Auto Resume: Show Status

Shows whether the extension is:

- disabled;
- monitoring;
- armed and waiting for a quota reset;
- verifying a newly resumed turn.

### Codex Auto Resume: Resume Now

Manually sends the configured continuation prompt to the selected target Codex thread through the official Codex client.

This is mainly useful for testing the integration.

### Diagnostic commands

The extension also includes diagnostic commands used to validate compatibility with the installed Codex extension:

- `Codex Auto Resume: Test Official UI IPC Bridge`
- `Codex Auto Resume: Diagnose Official Codex Integration`
- `Codex Auto Resume: Test Official Submit Bridge (Legacy)`

Normal use does not require these commands.

## Configuration

Open VS Code Settings and search for **Codex Auto Resume**, or configure the settings directly in JSON.

### `codexAutoResume.enabled`

Default:

```json
false
```

Controls whether automatic monitoring is enabled.

You can also change this through the Enable and Disable commands.

### `codexAutoResume.resumePrompt`

Default:

```text
继续。从中断处恢复，先检查当前工作区已有修改和上一轮状态，不要重复已经完成的工作。
```

This is the prompt sent to Codex when a quota-interrupted thread is resumed.

You can replace it with any continuation instruction you prefer.

### `codexAutoResume.pollIntervalSeconds`

Default:

```text
60
```

How often the extension refreshes Codex usage and thread state while monitoring.

Minimum: 15 seconds.

### `codexAutoResume.resetGraceSeconds`

Default:

```text
90
```

Additional delay after Codex's reported reset time before Auto Resume attempts to continue the task.

The grace period helps avoid resuming during the short interval where the backend reset time has passed but quota state has not yet propagated.

### `codexAutoResume.resumeStabilitySeconds`

Default:

```text
15
```

How long a newly resumed turn should remain active without another quota error before Auto Resume considers the resume successful.

If the turn completes sooner, it is accepted immediately.

### `codexAutoResume.recentThreadMinutes`

Default:

```text
480
```

Only recent Codex threads are considered when looking for a quota-interrupted task to arm.

The default eight-hour window comfortably covers a five-hour quota cycle.

### `codexAutoResume.codexCommand`

Default: empty.

Normally the extension automatically finds the Codex executable bundled with the official `openai.chatgpt` extension.

Use this setting only when you intentionally need to override that executable path.

## Example settings

```json
{
  "codexAutoResume.enabled": true,
  "codexAutoResume.resumePrompt": "继续。从中断处恢复，先检查当前工作区已有修改和上一轮状态，不要重复已经完成的工作。",
  "codexAutoResume.pollIntervalSeconds": 60,
  "codexAutoResume.resetGraceSeconds": 90,
  "codexAutoResume.resumeStabilitySeconds": 15,
  "codexAutoResume.recentThreadMinutes": 480
}
```

## Status and logs

Auto Resume exposes its current state in the VS Code status bar.

Detailed logs are available from:

```text
View -> Output -> Codex Auto Resume
```

Useful log events include:

- a thread being armed;
- the expected quota reset time;
- quota becoming available;
- the target Codex conversation being surfaced;
- UI IPC owner discovery;
- a continuation turn being started;
- resume verification succeeding or remaining armed after another quota error.

## Local and Remote SSH behavior

The extension is a workspace extension.

For local projects, it runs locally beside the local Codex extension.

For Remote SSH projects, install the same VSIX on the remote host beside the remote Codex extension. Auto Resume then uses the Codex executable, thread state, and IPC endpoint from that remote environment.

## Safety behavior

Auto Resume is intentionally conservative:

- it resumes only the persisted target thread;
- it does not send to an arbitrary currently visible conversation;
- if the correct Codex thread owner cannot be found, the extension keeps the task armed instead of sending elsewhere;
- if the resumed turn is immediately quota-blocked again, the task remains armed;
- approval-required Codex actions remain subject to the normal Codex approval flow.
