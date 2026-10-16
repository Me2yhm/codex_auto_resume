# Input-aware quota recovery

Base: main 951d9dd40ca88fd0cf7ca457dfb36cd5a6a4c2c3 (0.3.10).

## Scope

Reuse the existing official work conversation and UI IPC sender. Select a recovery action for a quota-failed user input: `continue`, `replay_input`, or `needs_review`. This is not a general outbox, task queue, or new-thread creator.

Persist the exact source thread/turn/message identity and input version. Inspect new user input while Armed, not only at reset. Recheck the source immediately before sending. Retain quota confirmation, workspace/Primer isolation, known-unsent cancellation and ambiguous-send fences.

## Evidence boundary

The deployed Codex version's `thread/turns/list` full-history payloads must be inspected. A summary view, `inProgress`, elapsed duration, account percentage, or missing visible assistant text is not proof that a prompt was unexecuted. Full user-only failed history is a replay candidate, not an unconditional proof of rejection before execution. Unsupported/missing/ambiguous history must not silently drop input or automatically replay potentially executed work.

Ordinary selection-generated user messages can be recovered verbatim. Expired approval RPCs must never be replayed as permission grants. Structured input that cannot be reproduced losslessly must be retained for review, not flattened.

## Implementation and release gates

- Add a pure evidence classifier and bounded read-only history reader.
- Persist content snapshots and source fingerprints; expose review/status diagnostics without leaking prompt text into Output.
- Integrate source refresh during Armed, final-send validation, replay/continue transition and reload safety.
- Cover late answers, newly rejected tasks, multiple user inputs, steering, incomplete history, repeated exhaustion, manual retry, ambiguous delivery and Primer exclusion with deterministic tests.
- Validate real Local/Remote full-history samples before declaring automatic classification release-ready. Keep main unchanged and use a draft PR until independent review.
