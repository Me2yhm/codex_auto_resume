# Architecture

## Objective

Resume a VS Code Codex thread automatically after a usage-limit interruption, using the actual quota reset time rather than a fixed five-hour delay.

## Design principles

1. Do not automate the UI unless necessary.
2. Reuse the Codex executable bundled with the official `openai.chatgpt` extension.
3. Treat the Codex app-server protocol as an adapter boundary because it can evolve.
4. Resume only after a structured quota-related failure has been observed.
5. Prefer the exact VS Code thread for the current workspace.
6. Persist an armed resume record so a VS Code restart does not lose the pending resume.

## Phase 2 flow

```text
VS Code extension activates
        |
        v
resolve official Codex executable
        |
        v
start `codex app-server --stdio`
        |
        +--> account/rateLimits/read
        |
        +--> thread/list
               sourceKinds = ["vscode"]
               cwd = current workspace folder(s)
               sortKey = updated_at
        |
        v
thread/turns/list (latest turn)
        |
        +--> normal completion -> do nothing
        |
        +--> usageLimitExceeded / rateLimitExceeded
                  |
                  v
          persist ArmedResume
          {threadId, cwd, resetAtMs, reason}
                  |
                  v
          wait until reset + grace
                  |
                  v
          re-read quota
                  |
          quota available?
             /        \
           no          yes
           |            |
     update wait       thread/resume
                       turn/start("继续...")
                       clear ArmedResume
```

## Thread selection

The extension asks app-server for recent threads with:

- `sourceKinds: ["vscode"]`
- `cwd`: every currently open workspace folder
- newest `updated_at` first
- non-archived only

The initial implementation selects the newest matching thread. A later iteration should track the active thread more directly if the official extension exposes a stable integration point.

## Quota handling

The app-server exposes `RateLimitSnapshot` with primary and secondary windows. Each window includes:

- `usedPercent`
- `windowDurationMins`
- `resetsAt` (Unix seconds)

When multiple windows are exhausted, the implementation waits for the latest reset among exhausted windows. A small configurable grace period is added before attempting the resume.

## Safety against accidental resumes

Auto resume is deliberately conservative:

- disabled by default;
- only considers recently updated workspace threads;
- requires the latest turn to carry a structured `usageLimitExceeded` or `rateLimitExceeded` error;
- stores the exact thread ID before waiting;
- clears the armed record after a successful `turn/start`;
- does not interpret ordinary task completion as an interruption.

## Known risks

### App-server compatibility

The official Codex app-server protocol is real and typed, but a companion extension is still coupled to interfaces that may evolve. All protocol calls should remain isolated from VS Code presentation code.

### Separate app-server process

This extension starts a separate app-server process using the same Codex executable and account state as the official extension. It resumes persisted VS Code threads by ID; it does not inject directly into the official extension's already-running process.

### Approval prompts

Auto-resuming a thread can still encounter a Codex approval request. This project does not automatically approve privileged actions. The goal is to continue safe unattended work, not bypass Codex approval controls.

## Future work

- Add unit tests around reset selection and error classification.
- Add an explicit per-workspace arm/disarm control.
- Surface primary/secondary usage and reset timestamps in the status bar.
- Verify behavior across Codex extension upgrades.
- Add a compatibility probe before enabling unattended resume.
- Package a `.vsix` through CI.
