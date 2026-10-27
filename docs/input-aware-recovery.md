# v0.3.11 input-aware quota recovery — implementation and review guide

Status: implemented on `feature/input-aware-quota-recovery`, draft PR #4. Not merged or released. Base: main `951d9dd40ca88fd0cf7ca457dfb36cd5a6a4c2c3` (0.3.10).

## What changed

A saved recovery now selects `continue`, `replay_input`, or `needs_review` for a particular failed user input, instead of always sending the generic continuation. The existing official conversation and UI IPC route are reused. This is not a general outbox, task queue, or new-thread creator.

| Observed evidence | Default action |
| --- | --- |
| Full history, one processed input or a verified in-turn structured Q&A followed by an explicit assistant acknowledgement | `continue`, using the existing configured prompt |
| Full history contains only one replayable plain-text user input | `needs_review`, with a replay candidate and the exact original text retained |
| Missing, summary-only, paginated-incomplete or unknown history; empty activity placeholders; steering; multiple unresolved inputs; unsupported structured payload | `needs_review`, no automatic send |

A newly rejected answer while the conversation is already Armed replaces the old recovery source, rather than being lost behind the original interruption. New quota-failed input can also supersede an older interrupted-null verification. Existing active/native continuations are observed rather than submitted again. After a replay starts doing work and exhausts quota again, it is reclassified as continued work, not repeatedly restarted from the original task prompt.

## The evidence boundary is intentional

The public protocol exposes turn items and full-history reads, but the inspected interfaces do not promise a universal `rejectedBeforeExecution` field. A new turn ID, `inProgress`, a quick failure, 100% account quota, or no visible assistant output is not sufficient proof of non-execution. Two identical full-history reads mitigate synchronization delay, but do not establish that no hidden work happened.

Therefore the default is **review**, not automatic replay of every user-only turn. Real full-history samples from the user's installed Local and Remote Codex versions have not yet been supplied. Public schemas and simulated fixtures are not presented as real-environment validation.

### Optional automatic policy

`codexAutoResume.inputRecovery.userOnlyPolicy` accepts:

- `review` (default): the user reviews and explicitly chooses replay or continuation for an eligible saved input.
- `replayStableUserOnly` (opt-in): a full, stable, single plain-text user-only quota failure becomes replayable after at least two full observations separated by 10 seconds. This is a named **heuristic**, not authoritative proof of execution phase. Do not enable globally before validating the installed Codex build.

Both policies retain two independent available-quota reads before dispatch. Automatic replay attempts are bounded to two for the tracked retry chain; new independent user input and positive execution progress are classified separately. A known-unsent cancellation refunds the attempt count; ambiguous delivery never creates an automatic duplicate.

`codexAutoResume.inputRecovery.enabled` defaults to true for this review build. Turning it off affects recovery without an existing input plan; it cannot silently discard or bypass a plan already saved in Armed state. Normal Auto Resume Disable still explicitly clears the workspace recovery, so inspect/copy needed content before disabling or downgrading.

## Commands

### `Codex Auto Resume: Inspect Recovery Input`

Read-only. It reads the Armed work thread, or the selected recent workspace work thread when nothing is Armed, and opens an **untitled JSON diagnostic**. It does not start, resume or write a work turn. The report contains thread/turn/message IDs, source fingerprint, items-view/type information, byte counts, classification reason and official extension version. It excludes original prompt text, tool output and credentials. Inspect reports its latest-history classification separately from persisted Armed/Verifying state. It also includes up to 32 source-free workspace decision transitions so manual continuation does not erase why a former turn was held. Earlier version decisions cannot be recreated. Inspect IDs and metadata before sharing the report.

Useful sample classes are (1) a work turn that executed and then exhausted quota, (2) a new task submitted after quota was already exhausted, and (3) a selection-generated question-plus-answer submitted after exhaustion. No artificial quota depletion is needed.

### `Codex Auto Resume: Inspect Recovery Interactions (Read-Only)`

New **diagnosis-only** command for the user-observed `questionSignals` at indices such as 12 and 86. It reads the exact saved recovery source turn by `thread/turns/list` with full items; up to five pages, ten turns per page and 4 MiB total. Unlike the ordinary recovery-history reader, this target-specific lookup does not silently stop on a newer completed turn or substitute a different latest turn. It uses an **independent temporary Codex app-server reader**, invokes no quota reads, `tick()`, UI IPC, permissions, state updates, or recovery classification, and closes the reader after inspection. If the Armed state has cleared after manual continuation, it uses the **latest workspace-saved `unanswered_question_or_approval` recovery decision** to identify the exact historical thread and turn; it never guesses the latest conversation. If neither record exists, it stops with a warning.

The untitled JSON contains:
- exact turn ID and read status (`found`, `not_found`, `malformed`, `too_large`, `unavailable`, `page_limit`), host and official extension version;
- bounded `questions` entries with item index, type, sanitized parent status and typed field-key shapes for each question and select nested metadata, plus known answered/pending boolean and allowlisted state fields;
- Keyed HMAC-SHA256 **tags** of candidate request/call identifiers rather than raw identifier values (the secret key remains in the extension process and is not exported), including a safe structural parse of serialized `questionItemId`;
- nearby item types/statuses and cross-item identifier matches, marked **identifier match only, not resolution proof**. Each match reports whether it came **before** or **after** the question, whether the matched identifier appeared inside a recognized structured reply envelope, and the matched item's allowlisted status. A user reply envelope may be examined locally for IDs; the answer and original text are never emitted.

No prompt, question title, choice, answer, attached TXT, user/path information, tool command/output or arbitrary string value is included. Arbitrary/sensitive field keys are hashed. This is an ephemeral local preview, not a file committed to this repository or a log of the full history. **Review the JSON locally before sharing it.** An absent cross-item match cannot prove a question remains pending; a match or later execution cannot prove that it was answered or permission granted.

The command does **not** change `waitingOnQuestion()`, `needs_review`, user-confirmed `continue`, the two-availability-read gate or the once-only dispatch journal. If the official history lacks a reliable resolution event, the next development decision will be whether to capture narrowly scoped interaction lifecycle events on future turns; do not invent resolution semantics or unblock prior work from this trace alone.

### `Codex Auto Resume: Review Recovery Input`

Opens a **local untitled preview containing the original input**. This preview may contain private text; it is not an automatically redacted report and must not be uploaded blindly. Editing the preview does not modify the stored payload.

For one supported, non-stale plain-text replay candidate, choose:

- `Replay saved input after quota recovery`: send the exact original text, preserving whitespace and the complete question/answer. Do not append the generic continuation.
- `Continue existing work after quota recovery`: explicitly choose the configured continuation.
- Cancel: keep the input waiting; send nothing.

A choice is bound to the exact source fingerprint. New input, edits, stale/incomplete reads or an in-flight dispatch invalidate stale choices. The command queues an action and **does not send immediately or bypass quota**. It does not approve commands, grant sandbox/network permissions or replay an expired approval request.

The status bar shows `Review Input` for unresolved evidence and opens this review action. `Show Status` distinguishes replay, continuation and verification. `Resume Now` on an input-aware Armed target no longer silently substitutes the generic prompt or bypasses the quota confirmation path.

## Input and storage limits

- Automatic/manual replay supports one plain-text content part with explicit empty `text_elements` and no unknown fields. Official pasted TXT references in the `# Files pasted by the user:` metadata block are handled as separate UI attachments: the extension reads and SHA-pins the existing UTF-8 file, preserves the original serialized input unchanged, and passes `{label, path, fsPath, isPastedText: true}` through the observed `turnStart.context.attachments` field. It does not append the TXT body to the prompt. This internal UI IPC shape is enabled only for inspected `openai.chatgpt 26.1007.21434` with `thread-follower-start-turn` v2; unknown versions fail closed. Images, skills, unsupported attachment types, multiple text parts and unknown metadata remain unsupported and are never silently flattened.
- Multiple **unresolved** user inputs are retained oldest-first for review. Recognized structured question replies within the same turn are treated as already handled only after explicit post-reply assistant acknowledgement. A new independent steer, unanswered question, or pending permission request remains blocked.
- Stored input is bounded to 256 KiB; a pasted TXT file is individually limited to 192 KiB, at most four TXT references are accepted, and original input bytes plus attached TXT contents must fit within 256 KiB. No prompt or attachment is truncated. Missing, modified, escaped/symlinked, unreadable or invalid UTF-8 files block replay with a specific `attachment_*` reason. The pinned digest is rechecked during ordinary monitoring and immediately before official owner IPC. The existing official attachment path is reused; Auto Resume does not create/register a new file or alter the official registry. The snapshot captures content at the first post-failure read, not necessarily the original paste instant, and is never silently replaced.
- Full-history reads are bounded to 5 pages of 10 turns and 4 MiB, stop at a prior execution/non-quota boundary, and fail closed for unsupported full views, duplicate IDs, malformed pages or cursor loops.
- Recovery plans, pasted TXT contents and digests are persisted in the extension's workspace state, not in the project repository. This is ordinary local extension storage, **not encrypted secret storage**. The structural Inspect report includes attachment status, count, byte length and SHA-256 but excludes raw TXT bodies and source paths. The Review preview displays the original user message and attachment metadata. Output never logs raw saved prompt or TXT body. Existing quota-failed history is not deleted or rewritten.
- UI-only input that never reaches a readable persisted turn cannot be recovered by this feature. There is no keyboard interception, clipboard scraping, DOM scraping or modification of the official extension.

## Safety and compatibility

The monitoring app-server remains read-only for real work. Source fingerprints and selected action are rechecked after owner discovery immediately before official IPC submission. Disabled/replaced targets and unreadable preflight history cancel a definitely-unsent claim; post-transport ambiguity preserves the existing durable fence. The official IPC payload/routing, model inheritance, proxy resolution, workspace isolation and Primer exclusion are unchanged.

Stable `inProgress` confirmation now also requires substantive, unambiguous recorded input progress; lifecycle allocation, empty placeholders and prior work before a new steering input do not establish successful handling. `interrupted/error=none` remains tracked, not auto-retried. Normal completed-turn Disarm and structured re-exhaustion re-arm are retained.

A native/manual continuation already visible on the same thread prevents an additional automatic send. Content equality alone is not an exactly-once guarantee; it is used only to match an already-recorded replay attempt to an observed input. Cross-host coordination remains outside scope. Pending/Armed work still suppresses Primer on the same host storage; one Primer host per account remains required. Issue #3 (Primer failure retry hardening) is separate.

## Validation evidence

- Original 0.3.10 baseline: 173/173 tests passed before integration.
- Local Node 22 isolated working copy: `npm run check`, full `npm test` **249/249**, and `git diff --check` passed.
- Integration source commit: `bfe2312d3190cd56f35ea68b5aa03bc6d20347b5`.
- GitHub Actions [CI #153](https://github.com/Me2yhm/codex_auto_resume/actions/runs/38899023922): install, typecheck, tests, VSIX packaging and artifact upload PASS.
- The exact GitHub source snapshot was downloaded into a separate isolated runtime and re-tested: **249/249 PASS**. Its only difference from the earlier local copy was wording in an existing UI IPC diagnostic, not runtime behavior.
- A temporary read-only source-snapshot workflow was used to obtain locked compiler dependencies without credentials or account data. It is removed before final PR review; `.github/workflows/ci.yml` is unchanged.

The original 76 added tests cover source-specific classification, empty placeholders, history bounds, late answers while Armed/Verifying, same-turn steering, multiple inputs, structured payload retention, exact plain-text replay, explicit review, source edits during dialogs/owner discovery, quota failure during confirmation, lifecycle cancellation, repeated exhaustion, bounded retries, native continuation, replay lineage, reloads, secret-free diagnostics and completed Disarm. Original regression fixtures explicitly select legacy mode because they contain summary-only turn data; the new controller tests enable input-aware mode and exercise the real final-send guard. Additional TXT tests cover 40KB+ plans, digest pinning, missing/modified files, unsafe paths, symlinks, invalid encodings, payload size limits, multiple references, repeat quota rejection, saved-state reload and content changes during owner discovery.

## Native pasted-TXT attachment transport (2026-10-18)

The Remote-host diagnostic of the installed `openai.chatgpt 26.1007.21434` bundle established that `thread-follower-start-turn v2` carries the original turn request separately from UI-only `turnStart.context.attachments`. The official pasted-TXT object observed in this bundle contains `label`, `path`, `fsPath`, and `isPastedText: true`. This is a **version-specific internal UI IPC contract**, not a public App Server schema.

The current implementation now:
- Leaves the stored serialized user input unchanged; it no longer appends TXT body, integrity markers, or code fences to the prompt.
- Reuses the already existing official managed TXT path and sends the separate attachment metadata through `turnStart.context.attachments`.
- Preserves the source TXT snapshot/hash in workspace state, checks UTF-8, size and source confinement, and revalidates the file immediately before owner IPC dispatch.
- Refuses attachment sends unless the installed official extension is exactly `26.1007.21434` and `thread-follower-start-turn` is v2. Unsupported versions preserve the saved input and transition to review; they do not silently fall back to inline text.
- Does not create a new official attachment, write the official registry, modify the official bundle, or alter the user input. It assumes the referenced file is the existing managed attachment originally created by Codex.
- Keeps `userOnlyPolicy=review`; the separately requested high-confidence automatic replay policy has not changed.

Automated validation: [GitHub Actions #184](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39137048037) PASS — `npm ci`, `npm run check`, **271/271 tests**, VSIX packaging and artifact upload. The uploaded artifact is `codex-auto-resume-vsix` (artifact ID `12139573822`, SHA-256 `0c0f850cda49d7d255da63f815a18b229eb8a6c6362818047507f07c43136d93`).

**Native TXT live test:** the user confirmed a real Remote quota-reset replay delivered the pasted TXT as a separate attachment with the original request body preserved. This validates attachment transport on that installed version, not all future Codex builds. The later answered-question continuation regression has been repaired separately and still awaits a natural Remote E2E after this fix; keep PR #4 Draft pending review.

## Native TXT attachment transport follow-up (2026-10-18)

The installed Remote official extension diagnostic identified the UI-only attachment field at `turnStart.context.attachments` for `openai.chatgpt 26.1007.21434` / `thread-follower-start-turn v2`. The implementation now preserves the exact original serialized input and supplies the existing pasted TXT file separately as `{label, path, fsPath, isPastedText: true}`. It does not append the TXT body, marker, or hash to the prompt. The payload is guarded by the exact inspected extension version/method combination; unknown versions fail closed and move the saved input to Review.

The original file path, byte length, and SHA-256 remain pinned in workspace state. The file is rechecked before IPC; missing/changed/unsafe/unreadable/oversized attachments block the send. The code reuses the existing official-managed file and does not write the official registry or call unverified attachment-creation internals.

Latest automated validation: [GitHub Actions #185](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39137146542) PASS — `npm ci`, typecheck, **271/271 tests**, VSIX package and artifact upload. Artifact: `codex-auto-resume-vsix` (ID `12139852366`, SHA-256 `f3484c5cb5fa2dc04e71c73bfb89fab422f174da5eecae67adf2b1d7f62abef6`).

**Live Remote confirmation remains required.** The report directly proves the context field and pasted-file metadata preparation, but the diagnostic did not fully expose the helper that normalizes attachments before assigning the official context array. Therefore deterministic tests prove the payload we construct, not yet that the installed UI renders it identically to the original paste. In a non-critical Remote test, verify the message body is unchanged, the TXT appears as a separate attachment, the model can read the full plan, and only one turn is created. Keep PR #4 Draft until this passes. High-confidence automatic replay remains unchanged and deferred.
## In-turn Q&A continuation regression

A real quota-failed long turn contained an original task userMessage and a later serialized question reply userMessage within the **same turn**. After the reply, Codex visibly acknowledged the supplied information and continued working before exhausting quota. The old classifier stopped at `multiple_unresolved_inputs` before examining post-reply execution.

The narrow fix selects `continue` only when all subsequent user inputs match the official structured question-reply format, each has a later nonempty assistant acknowledgement, and no additional unanswered question or pending execution permission remains. Ordinary steering and separately rejected turns still require review. The opt-in user-only automatic replay policy is unchanged.

`Inspect Recovery Input` now displays the newly calculated historical classification **and** the currently persisted Armed/Verifying decision separately. Workspace state retains the last 32 redacted decision transitions (status, source turn, reason, input count and fingerprint), never raw prompt contents, to aid investigation after manual continuation. The transition log starts only after installation of this version.

## Windows mixed-separator TXT and recovery-status fixes (2026-10-22)

A real Windows Local Codex turn failed quota with a pasted TXT referenced in the official serializer as `C:\\Users\\...\\.codex/attachments/<uuid>/Pasted text.txt`. The prior validation required `path.resolve(rawPath) === rawPath` and rejected this **valid Windows mixed-slash** path as `attachment_unsafe_reference` even under `replayStableUserOnly`.

- The resolver now checks absolute origin, excludes explicit `.`/`..` components, confirms exactly `<uuid>/<filename>.txt` inside the expected Codex attachment root, and performs file IO on the normalized **host** path. It preserves the exact serialized attachment path and label in the stored original prompt and `turnStart.context.attachments` metadata. File SHA-256/size/UTF-8 validation, symlink checks (including the session directory) and the final pre-send guard remain mandatory. Win32 path tests also run on Linux using `path.win32`; Windows CI additionally verifies actual temp-file reading, unchanged original prompt+metadata, and hash-change rejection.
- `Show Status` and the status bar report `Classifying` when an Armed turn has not yet received a recovery plan; no longer call that state `continue`. Attachment integrity failures show `TXT Blocked`, route to **Inspect** instead of implying that Review can override a safety failure, and never dispatch a partial input.
- `Review Recovery Input` now distinguishes no Armed target from an active `dispatch_pending` or `verifying` attempt; neither can be replaced by a Review dialog. `Inspect Recovery Input` uses the **effective** `replayStableUserOnly`/`review` setting rather than silently defaulting its independent classification to review, and includes effective policy, host platform, remoteName, installed extension version and the persisted recovery phase. It never exposes private TXT body content.
- Changing the settings JSON is evaluated on the next classification without a window reload; **installing a new VSIX requires a VS Code window reload** to activate it. The user's old `noteOnTxt` preview said TXT was *appended*; this is evidence that an earlier extension build generated that preview, not proof that the current branch's native attachment code was running in that particular Windows window.

CI [Actions #39733388480](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39733388480): Linux complete **293 pass, 0 fail, 1 Windows-only test skipped**; Windows native targeted **137 pass, 0 fail**; both typechecks and VSIX packaging pass. The initial full Windows matrix run [#39733158486](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39733158486) had **291 pass/3 fail** in *unrelated* pre-existing chmod, Primer lock-file rename and coordination timeout tests. Full Windows parity is tracked separately in [issue #5](https://github.com/Me2yhm/codex_auto_resume/issues/5); Windows CI gates TXT, recovery, controller and official UI tests until those are hardened.

The repaired path and diagnostics have not yet been confirmed in the user's actual Windows VS Code host after installing this build. Do not re-send an already manually continued task; wait for another naturally occurring quota-failed input for E2E. Existing anti-duplicate and user approval fences remain enforced.

## Repeat quota exhaustion after an automatic input replay (2026-10-22)

A Windows Local review-build recovery successfully **replayed the original task and its separate TXT attachment**, and the second turn performed real Codex work (assistant messages, commands, reasoning and file changes) before hitting the 5h limit again. The history then contained two quota-failed turns in the **same** conversation, each with an identical serialized user input. The old classifier treated them as two independent unresolved inputs (`multiple_unresolved_inputs`) when the persisted replay-source association was absent, blocking the **next** normal continuation. This is not an attachment-read or user-only policy failure.

The repaired classifier accepts this narrow, positively evidenced case: the **newest** quota-failed turn must contain exactly one original user input first, have unambiguous execution progress and no pending question/approval; every older pending quota-failed turn must be **user-only** and contain the **exact same** structured input content. The plan retains both historical inputs for inspectability but selects `action=continue`, `reason=replayed_input_followed_by_execution`. No TXT bytes are sent again and the old replay-attempt budget resets only after proven execution. The existing durable dispatch fence and 10-second independent quota confirmation remain unchanged.

Different prompts, new steering, unanswered questions/permissions, malformed/unknown activity, earlier non-user-only failures and identical **but still unexecuted** retries stay on the review or established safe paths. The classifier does not silently discard independent user instructions. This also works when a VS Code restart or lost UI receipt means `replaySourceTurnId` is no longer available.

[GitHub Actions #39739232124](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39739232124) PASS: Linux full tests **303 pass, 0 fail, 1 Windows-specific skipped**; targeted Windows tests **147 pass, 0 fail**; both TS checks and VSIX packaging passed. The actual user's *next* Windows quota recovery with the new build remains an E2E check. Avoid manually replaying the entire plan, which is already running or was partially executed.

## Remote short authorization incorrectly flagged as attachment-invalid (2026-10-22)

A Linux SSH extension host running 0.3.11 auto-resumed a long optimization task successfully. Later, the user manually sent `授权G2` (executed), then `授权G3` while quota was about to exhaust. The latter turn contained **only one failed `userMessage`** (400 serialized input bytes, no execution records), but Input Recovery recorded `needs_review / attachment_invalid_reference`, `attachmentIntegrity.count=0` and `bytes=0`, despite the effective `replayStableUserOnly` setting. The user did not visibly submit a new TXT attachment with that authorization.

Code analysis identified two false-positive forms in `pastedTxtReferences`: (1) with no official `# Files pasted by the user:` heading, **any** mention of a `.codex/attachments/` path was treated as malformed attachment metadata, even in the IDE's `## Open tabs:` list or an ordinary instruction; (2) an official `# Files pasted by the user:` heading with an empty, properly closed block was considered invalid. Inspect does not contain the original input body, so **which exact form occurred in the reported G3 turn is still unverified**. Neither case proves a real attached file was missing or unsafe.

The parser now distinguishes:
- Actual **recognized official pasted-TXT metadata**: still SHA-pinned, checks path/size/encoding/digest/symlinks before delivery and sends a separate `turnStart.context.attachments` payload.
- **Explicit malformed or unrecognized attachment metadata** (e.g. `Pasted attachment: <managed path>`, altered section headers/entries, truncated official block): **still blocked**, fail closed.
- A managed TXT filename mentioned only in an IDE open-tab path or ordinary `## My request` text, **without a pasted-file entry**: normal text; do not read the file or infer an attachment.
- An empty *properly closed* official pasted-files section: no attached TXT.
  
With `replayStableUserOnly`, a stable user-only quota-rejected G3 input in the latter two categories can be replayed exactly **once** after ordinary quota confirmation, without adding stale TXT attachments. Pre-existing persisted `attachment_invalid_reference` plans are recalculated; when formerly stale, they require fresh stable observations before allowing replay. No override of dispatch/authorization safety is introduced.

[CI #39746264197](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39746264197): Linux full suite **311 pass, 0 fail, 1 Windows-only skipped**; Windows targeted native file, UI IPC and input-recovery suite **155 pass, 0 fail**; typechecks and VSIX package PASS. Native SSH E2E of **this specific G3 recovery** still remains unverified. The real user's failed-turn text is available only in their local `Review Recovery Input` preview and must be redacted before sharing if further diagnosis is needed.

## Automatic context compaction in an executed, quota-failed turn (2026-10-23)

A live Linux Remote SSH run showed `授权G4` successfully replayed on quota reset, followed by substantial agent work and another quota exhaustion. The official conversation displayed `Context automatically compacted`. The attached Inspect report for the second failed turn contained one userMessage, multiple agent/command/reasoning items, and an intervening `contextCompaction` item, but the saved plan was `needs_review / unknown_item_or_context_activity`. The `PROGRESS` classifier omitted this known lifecycle item and rejected the turn before using the extensive positive work evidence.

Fix: handle exactly `contextCompaction` as a **known, neutral** lifecycle/history item; do **not** treat it as execution evidence, a new user instruction, or an automatic approval. A userMessage + contextCompaction without substantive later work still cannot trigger Continue (or replay after incomplete activity). Unknown future events, new user steering, incomplete/async question or permission requests and ambiguous order remain fail-closed. Resolved structured Q&A can also contain compaction without becoming an unknown-item failure. Existing quota availability double confirmation and same-host dispatch fence are unchanged.

With a single original userMessage followed by demonstrated agent/tool work on the quota-failed turn, the classifier now selects `action=continue` with `reason=recorded_execution_after_input`, sending the configured default continuation after quota confirmation, **not** replaying `授权G4` a third time. Any prior `needs_review` plan is eligible for reclassification on the next normal monitor poll after installing this VSIX, unless a newer turn or uncertain dispatch has superseded it.

[CI #39888201030](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39888201030) PASS: Linux full suite **320 pass, 0 fail, 1 Windows-only skipped**; Windows targeted recovery/UI suite **164 pass, 0 fail**; both TS checks, VSIX packaging and artifact upload passed. The user's next actual Remote quota recovery with this repaired build still needs live observation. Inspect decision fingerprints in the shared trace alternated while the reason remained constant; this issue is separate and should not be interpreted as new user input or execution proof.

## Question metadata in a long executed quota-failed turn (2026-10-26)

A real Windows Local long task submitted a pasted TXT, ran many command/file-change/reasoning/webSearch steps, displayed `Compaction interrupted`, and then exhausted quota. Inspect showed a **single** failed turn with one userMessage plus substantial work (including a final webSearch) but `needs_review / unanswered_question_or_approval`. It reported no `dynamicToolCall` type. The prior question guard treated **any** nonempty `item.questions` array on any historical item as proof of an unanswered question, even when the item itself or later work had completed. Thus this failure is an interaction-history classification, not evidence that the TXT path or quota configuration is bad. The redacted Inspect does **not** include the embedded question metadata and cannot prove whether a question was actually still pending. The UI compaction-interruption banner alone is not the cause of this reason.

The repaired classifier:
- Keeps pending `request_user_input[_async]` and permission tools blocked; does **not** assume that a parent item with `status=completed` means its question was answered.
- Allows automatic default `continue` only when **each question** carries explicit resolved/answered structured metadata and there is independent actual work; conflicting/unknown/pending metadata never passes.
- Attaches a bounded, **content-free** `evidence[].questionSignals` list to Inspect: item index/type, sanitized parent status, question count, resolved/pending/unknown counts, later recorded progress count and pending-tool flag. No prompt, question text, choices, answer, tool args, credentials or attachment paths are included.
- Offers an explicit manual **Continue existing work after quota recovery** choice in Review for a specific narrow case: exactly one initial userMessage, full quota-failed turn, subsequent recorded work, known activity, ambiguous historical questions, **no** explicitly pending question/permission tool, and no independent steering. It does not replay the original prompt or any TXT. The modal warns that this is **not a grant of new execution permissions**. A second fresh full-history read and unchanged fingerprint are mandatory before saving the one-action choice; two independently available-quota observations and the existing exactly-once dispatch fence are still mandatory before sending. A newer pending question/approval, changed source or unknown item invalidates the choice.
- Does not auto-resume **unknown** historical question states merely because there was later tool activity; user confirmation or stronger source evidence is required.

The actual Windows question fields were not in the supplied redacted Inspect. Until the new build returns `questionSignals`, the specific question status remains unknown. The aim is to make this diagnosable and manually recoverable without unsafe automatic permission inference. Keep PR #4 Draft until reviewed and proven on the actual host.

## Windows Local clock.sleep compatibility in second quota-failed turn (2026-10-27)

A redacted live Windows Local `Inspect Recovery Input` report from `openai.chatgpt 26.1021.22027`
showed a successfully auto-continued task doing substantial real work before exhausting quota again.
Its latest full, failed turn contained **118 items**: one `userMessage`, 60 `reasoning`,
11 `agentMessage`, 28 `commandExecution`, 11 `fileChange` and seven `sleep` items.
The saved and freshly classified recovery both returned
`needs_review / unknown_item_or_context_activity`. No independent unanswered question
or attachment error was reported for this latest turn. The immediately preceding turn
had already been classified as `answered_question_followed_by_execution`.

The exact `sleep` type was absent from our known-history item list. Official Codex
exposes an interruptible `clock.sleep` display item with an ID and duration. Treat
**only** this exact item kind as known neutral wait/lifecycle metadata, like
`contextCompaction`: it is **not** execution progress, a user instruction, an
answer, or authorization. The ordinary recovery guard, structured Q&A
`answeredQuestionFollowedByWork` guard and read-only interaction trace all
recognize it consistently. Unknown item kinds still fail closed.

Synthetic regressions cover seven interleaved waits and real work, user-plus-wait
without work, an unanswered question/permission, other unknown items, steering,
a structured answered question requiring a separate post-answer acknowledgment,
repeat-quota replay lineage, and reclassification of a persisted `needs_review`
without bypassing two quota observations or once-only dispatch.

**Release gate:** Code/CI results do not constitute live recovery verification on
the original Windows extension host. Do not manually replay the original input:
a second quota interruption after work requires the normal default continuation.
On a newly installed VSIX, verify that `Inspect Recovery Input` reclassifies
the exact previously saved source to `continue / recorded_execution_after_input`
(if unchanged), then verify `Show Status`, quota gating and at most one owner
submission. Keep PR #4 Draft until this host-specific check succeeds.

## Required real-environment review

Install only a review VSIX in a non-critical workspace initially. Keep `userOnlyPolicy=review`. Use `Inspect Recovery Input` for the three actual sample classes, verify original input completeness locally with `Review Recovery Input`, and confirm the official installed extension version. A real replay into the same conversation, new input during an Armed wait, reload persistence and a second quota exhaustion must be checked before broad release. Avoid manufacturing quota exhaustion or changing existing active task permissions.

Until these checks and independent code review pass, PR #4 stays Draft. Main and the stable 0.3.10 build are unchanged. No claim is made that all installed Codex versions can be classified automatically or that every attachment/approval type is supported.
