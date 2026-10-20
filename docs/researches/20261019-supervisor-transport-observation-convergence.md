# Supervisor transport observation convergence — 2026-10-19

## Field evidence

The Mac production Runtime initially had three independent `tunnel-client run --profile forge-current` processes (25449, 84345 and 90351), all connected to the same local MCP gateway on port 8767. Two unmanaged processes were terminated; the sole launchd-owned connection (84345) remained. This is a transport-instance ownership defect, not proof that it alone caused every ChatGPT conversation failure. Do not create another tunnel owner or manually spawn the canonical profile.

In the Supervisor journal, the 60-minute sample before containment held 97 `browser_delivery_attempt_failed` events. Forty-seven belonged to one task and code `WORKFLOW_SUPERVISOR_PROVIDER_NO_PROGRESS_WATCHDOG`. A separate run showed repeated `WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH` parser errors for an unchanged assistant response. An exact user-owned Chrome tab showed `无法加载此 ChatGPT 对话`, while another conversation in the same logged-in Chrome browser successfully returned its assistant history. A browser error shell is never negative evidence for a Send.

## Single-authority fix

`WorkflowSupervisorStore.recordBrowserDeliveryAttemptFailure` remains the **only** owner of task-local failure events. For a task/conversation/effect/error-code signature, at most three identical failure observations after the latest actual delivery/progress event are retained as diagnostics. Further unchanged browser polls do not insert new randomized event keys. A different failure code, effect, or actual progress resumes journaling. Failure counts grant no conversation-migration or Send authority. No state machine, durable status, provider writer, or authority was added.

The native consumer records a *rejected* compact receipt's observed assistant fingerprint together with its pending effect identity. It must still reject incorrect challenges; it only avoids re-parsing and re-logging the same immutable text under the same effect on every poll. Changed text or a changed pending effect is evaluated anew. This cache is ephemeral and is never completion evidence.

A frontend stream interruption and an unreadable conversation remain independent from confirmed provider mutation. Reconciliation still requires the exact Supervisor effect ledger and cannot replay an outcome-unknown Send.

## 2026-10-20 continuation follow-up

The canonical journal showed the source Supervisor accepting `NEEDS_USER` at
06:14:28Z; its final reply named `HOST_PROCESS_GRANT_REQUIRED`. Later user messages
did not reopen that terminal task. Two newly started standalone tasks named the
same Work and both hit `WORKFLOW_SUPERVISOR_BOOTSTRAP_WORK_CONVERSATION_CONFLICT`
after Send; exact-message reconciliation subsequently proved both applied. The
later duplicate was explicitly stopped. Runtime health alone did not prove the
prompt chain or Work transport binding was usable.

Standalone `work_id` is semantic proof, so its initial bootstrap no longer writes
Work conversation authority. Separately, a rejected syntactic receipt must remain
eligible for the existing missing-valid-receipt recovery after a completed idle
reply with an exact applied marker. The response cache retains parser rejection
alongside the applied source identity; semantic DONE rejection still follows its
existing correction path. Genuine provider generation is passed through without
inventing it from the last visible role. User-only idle snapshots stay read-only.
These corrections reuse the same journal, idle grace, two-recovery ceiling and
exact-target/unknown-send fences; they add no state schema or retry owner.

The same live investigation then observed a more direct duplicate-execution cause:
at 07:07Z, three `COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED` failures caused an
`automatic-delivery-fuse` migration while the original conversation was visibly
generating and had no committed completion. A fresh enrollment was sent at
07:08Z; this was **not** a CONTINUE successor. The generic migration fuse, its
store count projection and the watchdogs used only to advance that count are
removed. Transport loss retains exact original task/effect observation; existing
capacity/committed-continuation migration and explicit operator actions remain.
An actual-source disconnect/reconnect probe preserves the original conversation,
then consumes its late valid CONTINUE without opening a bootstrap or sending
another enrollment. This probe is source evidence, not deployed live acceptance.

## Required acceptance

1. Forty repeated observations of one error yield at most three diagnostic events and never authorize migration or Send.
2. A different code or an actual `effect_applied` causes the next genuine observation to be recorded.
3. An old conversation identity cannot charge a successor conversation.
4. Two identical invalid compact-receipt observations emit one parsing error, zero completions, and zero provider submissions.
5. Existing Supervisor behavior suite, typecheck, runtime-architecture gate and architecture synchronization pass.
6. **Not proved by this source change:** end-user old-conversation loading, platform-side ChatGPT service repair, fresh continuation `CONTINUE -> CONTINUE -> DONE` after Runtime cutover, or host-level tunnel singleton enforcement. These require independent production receipts. Related issue authorities: #235 (transport/outcome), #265 (failure convergence), #294 (Chrome receiver).

## Source gate alignment

Rebase onto the concurrent `f63383bce` Supervisor prompt refactor exposed three pre-existing architecture checks matching removed literal prompt strings. The checks were retargeted to the new explicit W/C/U outcome mapping, immutable task/effect receipt header, durable `supervisor_task get`, bounded objective excerpt and both continuation/enrollment prompt ceilings. This is a source/gate synchronization repair, not gate relaxation; existing receipt and exactly-once behavior tests remain mandatory.
