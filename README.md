# codex_auto_resume

Companion tooling for automatically resuming interrupted Codex work in VS Code after usage limits reset.

## Goals

- Phase 1: provide a pragmatic Windows fallback using AutoHotkey + Task Scheduler.
- Phase 2: provide a VS Code companion extension that talks to Codex app-server, watches usage limits, finds the current VS Code thread for the workspace, and resumes it automatically after quota reset.
- Avoid depending on the standalone Codex CLI as a user-facing workflow.

## Status

Initial project bootstrap.
