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

Read-only. It reads the Armed work thread, or the selected recent workspace work thread when nothing is Armed, and opens an **untitled JSON diagnostic**. It does not start, resume or write a work turn. The report contains thread/turn/message IDs, source fingerprint, items-view/type information, byte counts, classification reason and official extension version. It excludes original prompt text, tool output and credentials. Inspect IDs and metadata before sharing the report.

Useful sample classes are (1) a work turn that executed and then exhausted quota, (2) a new task submitted after quota was already exhausted, and (3) a selection-generated question-plus-answer submitted after exhaustion. No artificial quota depletion is needed.

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

**Not yet verified live:** the new native attachment IPC payload has not yet been exercised in the user's Remote workspace after this patch. Deterministic tests verify the exact payload shape and fail-closed version gate, but do not prove the installed UI renders the attachment card or that the model reads the entire 40,224-byte plan. Keep PR #4 Draft until that live test passes.

## Native TXT attachment transport follow-up (2026-10-18)

The installed Remote official extension diagnostic identified the UI-only attachment field at `turnStart.context.attachments` for `openai.chatgpt 26.1007.21434` / `thread-follower-start-turn v2`. The implementation now preserves the exact original serialized input and supplies the existing pasted TXT file separately as `{label, path, fsPath, isPastedText: true}`. It does not append the TXT body, marker, or hash to the prompt. The payload is guarded by the exact inspected extension version/method combination; unknown versions fail closed and move the saved input to Review.

The original file path, byte length, and SHA-256 remain pinned in workspace state. The file is rechecked before IPC; missing/changed/unsafe/unreadable/oversized attachments block the send. The code reuses the existing official-managed file and does not write the official registry or call unverified attachment-creation internals.

Latest automated validation: [GitHub Actions #185](https://github.com/Me2yhm/codex_auto_resume/actions/runs/39137146542) PASS — `npm ci`, typecheck, **271/271 tests**, VSIX package and artifact upload. Artifact: `codex-auto-resume-vsix` (ID `12139852366`, SHA-256 `f3484c5cb5fa2dc04e71c73bfb89fab422f174da5eecae67adf2b1d7f62abef6`).

**Live Remote confirmation remains required.** The report directly proves the context field and pasted-file metadata preparation, but the diagnostic did not fully expose the helper that normalizes attachments before assigning the official context array. Therefore deterministic tests prove the payload we construct, not yet that the installed UI renders it identically to the original paste. In a non-critical Remote test, verify the message body is unchanged, the TXT appears as a separate attachment, the model can read the full plan, and only one turn is created. Keep PR #4 Draft until this passes. High-confidence automatic replay remains unchanged and deferred.
## Required real-environment review

Install only a review VSIX in a non-critical workspace initially. Keep `userOnlyPolicy=review`. Use `Inspect Recovery Input` for the three actual sample classes, verify original input completeness locally with `Review Recovery Input`, and confirm the official installed extension version. A real replay into the same conversation, new input during an Armed wait, reload persistence and a second quota exhaustion must be checked before broad release. Avoid manufacturing quota exhaustion or changing existing active task permissions.

Until these checks and independent code review pass, PR #4 stays Draft. Main and the stable 0.3.10 build are unchanged. No claim is made that all installed Codex versions can be classified automatically or that every attachment/approval type is supported.
