# Single-window multi-session recovery (development branch)

Status: **experimental; do not release or merge until native Windows acceptance passes**.

## Scope

The new backlog contains multiple quota-failed work conversations observed as **open Codex custom editor tabs in this VS Code window**. It does not attempt to orchestrate work in separate VS Code windows, workspaces, local/SSH extension hosts, or accounts. The existing same-host dispatch claim and Quota Primer priority registry remain shared safety measures, not a global task queue.

The extension cannot prove window ownership from `thread/list` or `cwd` alone. Consequently, additional conversations are discovered only when a matching `chatgpt.conversationEditor` tab has an `openai-codex://route/local/<threadId>` URI in `vscode.window.tabGroups`. Some official Codex sidebar-only sessions may not have such editor tabs and **will not be queued automatically** by this version. Such sessions retain the pre-existing single-target behavior, subject to the recorded target's safety conditions. Do not advertise generic sidebar-only session discovery as supported.

## State and migration

- `codexAutoResume.armed` remains the legacy active recovery record.
- `codexAutoResume.pendingQuotaCandidate` remains the legacy pending quota candidate.
- `codexAutoResume.recoveryBacklog.v1` stores up to 64 additional `ArmedResume` records, keyed by their unique `threadId`.
- Each record retains its original source turn and input-aware recovery plan (including original evidence and attachment integrity).
- Invalid/duplicate persisted entries cause a **fail-closed** error, not silent deletion or unsafe dispatch.
- Both current and backlog records are preserved on VS Code reload. A backlog entry not open in the current window remains saved but cannot be selected automatically until its editor is opened.
- If `workspaceState` is shared by two windows opened on exactly the same workspace, the state may be visible to both; **window-local open-editor evidence is required for new multi-session candidates and queue promotion**. This is not a replacement for an authoritative official window-to-thread owner API. Do not treat this as a formally proven durable per-window storage namespace.

## Dispatcher

- Existing active recovery remains authoritative until its dispatch is resolved or is safely moved to the backlog.
- An active `needs_review` target yields to a safe backlog target rather than starving other conversations.
- On definitive `no-client-found` (nothing sent), an active target yields behind other eligible open-window targets. Ambiguous delivery or an outstanding dispatch **never** yields in this manner.
- Recovery submissions remain sequential in the controller, with at least two independent available-quota reads (10 seconds apart), input fingerprint/attachment validation, and same-host durable dispatch protection for every message.
- A resumed turn must be verified before it is disarmed; an interrupted resumed turn can re-arm its exact conversation.
- UI Review offers a conversation picker for saved, open-window entries; an unresolved dispatch cannot be switched away.
- Quota Primer gives way to outstanding backlog work through the existing same-host recovery registry.

## Validation

Run `npm ci && npm test` on Linux and the targeted Windows CI suite. Test cases cover queue input validation, visible-thread discovery, same-cwd nonvisible threads, independent review gating, restart replay-state retention, no-owner yielding, cross-window no-dispatch, and legacy single-target compatibility.

Native Windows acceptance must additionally demonstrate: three real Codex conversations opened as editor tabs in one window; mixed running/rejected-input states; quota reset; FIFO advancement; second quota exhaustion; manual Review; restart with outstanding items; and no duplicate IPC sends. Test with a second VS Code window opening the same workspace, and with sidebar-only conversations, to document behavior accurately.

## Release blockers

1. Confirm actual official Codex tab `TabInputCustom` identity and URI shape in Windows Local/Remote builds.
2. Validate same-workspace multi-window isolation in a native VS Code extension host, including reloads.
3. Decide whether sidebar-only sessions require a user-explicit enrollment command or a new verified official window ownership API before calling the feature generally available.
4. Verify that all recovery commands (Status, Review, Inspect) can address the intended target without stale targeting or losing stored input.

Do not change Marketplace/Release/version packaging until these checks pass.

## Legacy v0.3.11 late answer after a quota-blocked question

A separately discovered recovery deadlock occurs when Codex has already edited files, poses a question, and the user's delayed answer is rejected by the account quota: the failed turn may contain two user messages, so the old classifier returns `multiple_unresolved_inputs`. The old Review command only accepts one replayable input and offers no selectable action.

The repair deliberately preserves the original instruction and all prior recorded work. **Only** the final ordinary-text answer can become a human-only replay candidate, and only if an individual quota-failed turn contains (a) exactly two user messages, (b) independently recorded pre-answer work, (c) a preceding agent question, (d) no unknown item types, pending question/permission RPC, explicit pending question, or post-answer activity other than neutral waiting metadata. A structured question-response envelope or unrelated third instruction is not converted to ordinary text. No automatic policy enables this replay.

The Review UI shows the single action **Replay latest saved answer only after quota recovery**, with a modal warning and exact locally previewed input; it does not offer generic Continue for this case. The action is bound to the full history fingerprint and exact message identity. A later history change removes the approval. All existing dispatch claims, quota rechecks, attachment security checks and verification remain mandatory.

This is a narrow repair, **not** permission to bypass `multiple_unresolved_inputs` generally. If the real Codex history represents a still-pending question tool or a different structure, the recovery correctly remains blocked. Inspect Recovery Input and Inspect Recovery Interactions (Read-Only) can provide the redacted structural evidence needed to design another safe variant without weakening the security rules.


## 2026-11-09: three user messages / two native structured question replies

A real user preview showed a single quota-failed turn with **three** \`userMessage\` entries: an original request, a previously answered \`request_user_input_async\`, and a second structured answer submitted just as the account quota was exhausted. The initial late-answer patch only handled two messages and rejected native reply envelopes, so its Review command still produced no actionable choice.

The repair now recognizes multiple native replies when all earlier replies are followed by agent activity, the last answer is validated as an official structured question-reply envelope, recorded work precedes the last reply, and **no work or acknowledgement after the last reply** is present. Unknown items, unmatched pending question tools, explicit pending permissions, malformed envelopes, unrelated user steering, additional unanswered questions, or changed history remain blocked.

Because official \`thread-follower-start-turn\` accepts a regular user message rather than the original \`request_user_input_async\` RPC completion, **do not send the raw native \`<send_user_message_question_reply>\` serializer as plain chat text**. Instead, explicit per-source human approval queues a new ordinary-text continuation that quotes only the final recorded question and answer, with an instruction to inspect existing work and not expand authorization. The earlier inputs, prior code changes, and complete saved evidence remain untouched. This is an **opt-in manual decision**, never enabled by \`replayStableUserOnly\`.

Review now offers **Continue using last saved question answer after quota recovery** when eligible. Otherwise, a modal explains why the multiple inputs cannot safely resume and can open read-only interaction evidence. Fingerprint checks, independent quota confirmation, host dispatch deduplication, and repeat inspection immediately before IPC delivery remain required.

Simulated Linux/Windows CI can establish classifier/controller safety but **cannot prove that this exact real Codex history matches the qualifying item sequence**. The user must verify on Windows with the experimental VSIX, and may need to provide a redacted, metadata-only Inspect Recovery Interactions trace if the actual turn is structured differently.


## 2026-11-09: Remote SSH shows Monitoring after a rejected prompt

A screenshot showed the official Codex UI warning "You've hit your usage limit. Contact your workspace owner for more access" after the user submitted a prompt in Remote SSH, while Show Status repeatedly said "Monitoring; no interrupted thread is armed." This is a **discovery** or **pre-turn persistence** problem, not an availability countdown. Without a recorded quota-failed turn, never invent an Armed target or resend an unsaved prompt.

Changes to candidate selection:
- Filter thread IDs against Codex custom-editor tabs in this window *during paginated selection*, not after choosing the newest workspace thread. A newer session from the same cwd cannot conceal an older visible interrupted session.
- Accept exact \`openai-codex://route/remote/<UUID>\` or \`/local/<UUID>\` routes for a \`chatgpt.conversationEditor\` tab. Without a tab, do not infer remote-window ownership from an unfiltered list.
- When an **exact window tab ID** exists, permit an additional read against unfiltered thread sources on the Remote host; it is still required to match an open workspace and the exact tab ID before auto-enrollment. This is not general cross-window discovery.
- Do not display a fabricated January 1970 reset time when the backend supplies none. A workspace credits depletion may require owner action; availability revalidation is mandatory.

New command: **Codex Auto Resume: Diagnose Monitoring (Read-Only)**. It samples both \`sourceKinds=["vscode"]\` and unfiltered thread listings, verifies limited latest-turn structural statuses, and reports redacted workspace/tab match counts and the account quota classification. It does not show raw input, full thread IDs or workspace paths, and it never changes recovery state, sends a continuation, or approves input.

Native acceptance:
1. Install the test VSIX in the **same SSH extension host** where Codex executes, then reload that VS Code window.
2. Submit a prompt while quota is blocked; run Show Status. If not Armed/Pending, run Diagnose Monitoring (Read-Only).
3. If the report finds a quota-failed matching turn, verify it can be saved without adopting any foreign-window thread. If the newest turn is not failed/interrupted, the official UI may have rejected the message **before any App Server turn was recorded**. That case requires a separately verified native IPC capture/explicit enrollment design and is not solved by scanning more threads.
4. Check \`ordinaryUsageAllowed\`, \`rateLimitReachedType\` and whether an actual reset time exists, without inventing reset times or sending requests while blocked.
5. Validate exact Local vs Remote extension-host installation using the extension host indicator and a real Codex owner. The GitHub Actions mocks cannot prove remote process account/store identity.


## 2026-11-09: exact Remote SSH conversation and UI placeholder Turn

A Codex Output \`Rebinding placeholder latest turn to incoming event conversationId=<UUID> turnId=<UUID>\` line provides a stronger **candidate identity** than a workspace-wide newest-thread scan. However, a UI placeholder lifecycle event is not conclusive evidence that the App Server persisted a completed/failed Turn, or that the user prompt was accepted.

The new VS Code command **Codex Auto Resume: Inspect Exact Thread (Read-Only)** asks for the two UUIDs separately, and performs a bounded, paginated \`thread/turns/list\` lookup through the same App Server executable and extension host. It distinguishes:
- exact Turn exists and has structured \`usageLimitExceeded\` or \`rateLimitExceeded\`;
- exact Turn exists but has \`completed\` / other non-quota status;
- UI-referenced Turn is absent from the bounded persisted history (potential transient placeholder or wrong App Server host);
- unavailable App Server read.

The report contains only hashed IDs, short allowlisted status/error categories, host identity, whether this window has a matching editor tab, and an account-quota summary. It is created as an unsaved editor document; it does not write \`workspaceState\`, choose a recovery action, dispatch an IPC message, or assume a placeholder is a recoverable failed turn. **An exact UUID provided by the user is a diagnostic locator, not automatic permission to restore a message.**

Native Remote SSH acceptance: paste the target \`conversationId\` and \`turnId\` from the same Codex Output line. If the exact Turn is missing, check whether the original prompt is visibly preserved in the Codex composer; do not create an inferred continuation from the screenshot or from the quota banner. If the Turn has a structured quota failure, investigate why normal window-scoped discovery did not register the target, preserving ownership and duplicate-send protections.
