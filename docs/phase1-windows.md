# Phase 1: Windows fallback

Phase 1 exists as an emergency fallback while the VS Code extension is being validated.

## Requirements

- Windows
- VS Code
- Official OpenAI Codex extension
- AutoHotkey v2

## Script

Use `scripts/windows/resume-codex.ahk`.

The script:

1. starts VS Code if needed;
2. activates the VS Code window;
3. opens the Command Palette;
4. runs `Codex: Open Codex Sidebar`;
5. clicks the configured input coordinates;
6. sends the configured continuation prompt.

The click coordinates are intentionally explicit because the official extension does not expose a stable VS Code command for sending arbitrary text to the active Codex chat.

## Task Scheduler setup

Create a Windows Task Scheduler task that runs AutoHotkey with the script path after the reset time shown by Codex Usage.

Example program:

```text
C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe
```

Example argument:

```text
"C:\path\to\codex_auto_resume\scripts\windows\resume-codex.ahk"
```

Do not schedule it as a fixed five-hours-after-failure rule. The usage window may already be partway through when the limit is exhausted. Schedule from the actual reset timestamp.

## Limitations

- depends on window focus and screen coordinates;
- can fail on a locked Windows desktop;
- can target the wrong chat if the UI state changes;
- cannot reliably distinguish task completion from quota interruption by itself.

For unattended overnight work, Phase 2 is the intended solution.
