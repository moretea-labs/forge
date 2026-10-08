# Four enrolled conversations stalled at the provider observation boundary

Observed on 2026-10-02 (Asia/Shanghai), source/runtime f87c4a08.
Repair Work: work-semantic-2371fcc14110.

Facts from the canonical Supervisor journal and the exact signed-in ChatGPT
conversations:

- Forge task `supervisor:three-goals-forge-source-20261001` had CONTINUE receipts,
  then `fx_9622394f756cdb2bcea2397abfc77ac8` was classified unknown. Its exact
  committed user marker and subsequent assistant response are present in the
  original conversation; read-only reconciliation can establish application.
- Android task `supervisor:avela-android-development-20261001` and design task
  `supervisor:three-goals-shenbaobao-design-20261001` exhausted their one automatic
  recovery without a committed receipt. Both pages contain substantial reasoning
  and tool work which the old final-message-only snapshot omitted from activity.
- iOS task `supervisor:three-goals-avela-release-20261001` retains the unsent
  recovery `fx_c7836cf4e8cc62fe8a052296b0fa392e`. Its first current-dispatch native
  observation explicitly recorded `composer_missing`, before any Send click.
  A concurrent extension observer reported a message-port error first; that
  observer is not the native dispatch owner and cannot supersede its no-click
  return. Historical reconstruction requires the generation's dispatch-start
  record to name the native owner, then reads that owner's first observation.
  The original applied enrollment has iOS candidate/regression work in its
  reasoning region. Changing the task objective did not settle the effect.
- The current UI has both hidden SSR and visible hydrated `main` surfaces.
  `aria-busy=true` on profile loading made the old global selector report model
  generation. The current reasoning region has no assistant role key until a
  final response commits. The disconnect banner is a `role=status` element,
  which the old status selector omitted. Localized delivery timeout is also
  observed. The old snapshot therefore cannot prove healthy or stale execution.
- Persisted recovery commands were blocked again on later passes by the last
  visible user role, despite their existing causal recovery authorization.

Inference: incorrect observation caused premature recovery/stopping and missed
later status changes; it does not imply the product tasks did no work. Whether
their product changes meet acceptance must be decided in their original tasks.

Correction: reuse the native adapter, Supervisor effect journal and provider
failure classifier. Read visible current-turn activity, keep reserved recovery
authorization, distinguish dispatch-owner no-click proof from unknown sends,
and expose reasoned/idempotent local operator recovery after automatic exhaustion.
No DB surgery, budget reset, task duplication, new auth session or provider owner.

The separate CONTROLLER_CONTINUATION_ALREADY_DISPATCHING incident is already
tracked as work-incident-f876753ee0085f49c7e370e3-g1. It is not the authority or
root cause of these four Supervisor observation facts; do not absorb it here.

Validation: retained Supervisor behavior cases cover exactly-once automatic
recovery, operator idempotency, unknown refusal, bounded no-click retry and
localized status classification. Real signed-in-page snapshots verify reasoning
activity and status extraction. Compiler/governed checks and whole-Runtime
activation precede four-task live acceptance; source PASS alone is insufficient.

## 2026-10-04: loaded URL mistaken for loaded conversation

The three active original conversations rendered "Could not load this ChatGPT
conversation" with no message content or composer. The Android page's resource
timing showed HTTP 429 on its exact `/backend-api/conversations/<id>` history
read, including after one explicit same-page Retry. This is not evidence that a
prompt was submitted or that model execution failed. The paused design task is
outside this repair scope.

The native consumer used the currently due task projection for resource cleanup.
An unknown effect disappears from that projection during its observation delay,
so the consumer closed its tab and reopened the same URL on the next due tick.
This creates repeated history requests; it plausibly amplifies the observed 429,
but does not prove the provider's original reason for rate limiting.

Correction: retain exact conversation resources for nonterminal tasks through
observation spacing and refuse to treat an empty conversation shell as effect or
provider-turn evidence. Use the existing task-local transport diagnostic and
spaced DOM observation. No new writer, persistent state, task, conversation,
dispatch-budget reset or inference of non-submission is introduced. Terminal
cleanup still retires owned tabs. Productive continuation of the original tasks
remains the acceptance criterion; a harmless new probe is insufficient.

## 2026-10-04: the liveness digest had no live signal

Canonical Supervisor journal evidence on source `ac6021a1` (six-hour window):
111 `effect_dispatch_started`, 36 `assistant_recovery_reserved` and 27
`assistant_recovery_exhausted`, with every reservation carrying
`stale_generation: true`. The committed receipts for those same turns arrived
12-50 minutes after the send, so the turns being replaced were still working.
The account-wide request volume that produced the conversation-read 429s was
therefore mostly Forge's own duplicate prompts.

Cause: the applied-turn liveness digest is
`sha256(latestAssistantResponse + providerActivityText)`. The Computer Chrome
content script reported `providerActivityText: ''` unconditionally, and
`latestAssistantResponse` is the previous *committed* answer, which cannot
change while a new turn runs. The digest was constant for the entire life of
every in-flight turn, so any turn that outlasted the quiet window (60s, then
180s) was classified stalled and earned a duplicate recovery prompt. Widening
the window reduced but could not remove the false positive: the window was
measured against a signal that never moved.

Two smaller defects sat in the same page observation. Role and message
extraction read the whole document, so hidden SSR shells could supply turns the
signed-in page was not showing, and `isGenerating()` accepted any page-global
`aria-busy="true"`, which unrelated profile/route loading also sets. A third
defect was ordering: `ensureExact` ran before the provider-pressure gate, so a
missing exact conversation could still be opened (a provider history read)
while shared backpressure was active.

Correction: the Chrome content script observes the visible hydrated `main`
surface, reports the live current-turn text as `providerActivityText`, and
scopes generation evidence to the current turn. The quiet window moves to the
store's existing bounded maximum (10 minutes), which is still shorter than an
observed real turn. Computer target acquisition now respects the shared
provider backpressure cooldown instead of opening a conversation while the
account is explicitly rate limited. No new writer, owner, state, budget or
provider path is introduced: the macOS provider already reported live
current-turn activity and localized status, so this is contract parity for the
Computer extension provider.

Verification: a local synthetic-DOM comparison of the previous and current
content script (not committed) shows the old script reported an empty activity
string that never changed as the live turn progressed, while the new script
reports and tracks the current turn text; the same comparison shows the old
script reporting `isGenerating` for an unrelated page-global `aria-busy` and the
new script not doing so. Retained Supervisor behavior cases, the Computer target
tests, the Chrome adapter smoke and the compiler checks pass. The synthetic page
was built from the recorded DOM roles, so residual uncertainty remains about how
often ChatGPT's own reasoning surface keeps the last turn text moving between
tokens: a genuinely silent 10-minute turn still earns its one bounded resume.

## 2026-10-08 native Apple Events contention follow-up

Live exact-tab metadata completed in 368 ms for the retained Forge conversation in Vivaldi (correct URL, active and frontmost). The subsequent minimal DOM request was rejected as `BROWSER_AUTOMATION_SERIALIZATION_BUSY` while a separate `osascript` holder was executing against another tab in the same browser. The known Desktop Operator timeout path now bounds and reaps that holder; this does **not** prove that the Forge conversation was successfully rendered or delivered.

The native browser bridge must preserve the broker's distinct `BROWSER_AUTOMATION_TIMEOUT` and `BROWSER_AUTOMATION_SERIALIZATION_BUSY` codes. Supervisor spaces only the affected task using its existing failure ledger; it must not interpret either rejection as provider acceptance or retry the same task every tick. The existing fresh-send fairness map must survive tick boundaries and prune retired effects in its existing service routine. Active Runtime live acceptance still requires an independent `CONTINUE → CONTINUE → DONE` receipt, not just local tests.


### Exact conversation binding integrity (2026-10-08)

The same transient native observation failure was also treated as identity revocation in `MacOsChatgptConversationTargetPort.ensureExact`. Cached and durably reattached exact tabs were deleted or unbound on a DOM timeout/busy result; a newly created tab could also be closed and unbound when its first observation failed after the stable binding was already persisted. The resulting tab scan and possible fresh creation did not have positive evidence that the originally bound tab was gone.

The correction keeps the existing Computer target authority. A native tab is positively absent only when `PLUGIN_BROWSER_NATIVE_TAB_IDENTITY_UNPROVEN` reports `candidateCount=0` with `inventoryTruncated=false`; an observed different conversation URL is also a positive mismatch. All other observation failures return the native failure code while preserving the exact binding, including after first successful creation. Existing binding-clear and native-close failures must not silently authorize a duplicate tab. Regression tests cover cached and reattach failures, first-observation failure, confirmed native absence, and task-local retry spacing. Active release acceptance remains subject to independently observed `CONTINUE → CONTINUE → DONE` receipts.
