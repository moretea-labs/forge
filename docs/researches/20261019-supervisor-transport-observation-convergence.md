# Supervisor transport observation convergence — 2026-10-19

## Field evidence

The Mac production Runtime initially had three independent `tunnel-client run --profile forge-current` processes (25449, 84345 and 90351), all connected to the same local MCP gateway on port 8767. Two unmanaged processes were terminated; the sole launchd-owned connection (84345) remained. This is a transport-instance ownership defect, not proof that it alone caused every ChatGPT conversation failure. Do not create another tunnel owner or manually spawn the canonical profile.

In the Supervisor journal, the 60-minute sample before containment held 97 `browser_delivery_attempt_failed` events. Forty-seven belonged to one task and code `WORKFLOW_SUPERVISOR_PROVIDER_NO_PROGRESS_WATCHDOG`. A separate run showed repeated `WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH` parser errors for an unchanged assistant response. An exact user-owned Chrome tab showed `无法加载此 ChatGPT 对话`, while another conversation in the same logged-in Chrome browser successfully returned its assistant history. A browser error shell is never negative evidence for a Send.

## Single-authority fix

`WorkflowSupervisorStore.recordBrowserDeliveryAttemptFailure` remains the **only** owner of task-local failure events. For a task/conversation/effect/error-code signature, the most recent three identical failure observations after the latest actual delivery/progress event are sufficient for the existing automatic-conversation-failure threshold. Further unchanged browser polls do not insert new randomized event keys or create a new migration fingerprint. A different failure code, effect, or actual progress resumes journaling. No state machine, durable status, provider writer, or authority was added.

The native consumer records a *rejected* compact receipt's observed assistant fingerprint together with its pending effect identity. It must still reject incorrect challenges; it only avoids re-parsing and re-logging the same immutable text under the same effect on every poll. Changed text or a changed pending effect is evaluated anew. This cache is ephemeral and is never completion evidence.

A frontend stream interruption and an unreadable conversation remain independent from confirmed provider mutation. Reconciliation still requires the exact Supervisor effect ledger and cannot replay an outcome-unknown Send.

## Required acceptance

1. Forty repeated observations of one error yield at most three events and retain existing automatic-migration threshold semantics.
2. A different code or an actual `effect_applied` causes the next genuine observation to be recorded.
3. An old conversation identity cannot charge a successor conversation.
4. Two identical invalid compact-receipt observations emit one parsing error, zero completions, and zero provider submissions.
5. Existing Supervisor behavior suite, typecheck, runtime-architecture gate and architecture synchronization pass.
6. **Not proved by this source change:** end-user old-conversation loading, platform-side ChatGPT service repair, fresh continuation `CONTINUE -> CONTINUE -> DONE` after Runtime cutover, or host-level tunnel singleton enforcement. These require independent production receipts. Related issue authorities: #235 (transport/outcome), #265 (failure convergence), #294 (Chrome receiver).

## Source gate alignment

Rebase onto the concurrent `f63383bce` Supervisor prompt refactor exposed three pre-existing architecture checks matching removed literal prompt strings. The checks were retargeted to the new explicit W/C/U outcome mapping, immutable task/effect receipt header, durable `supervisor_task get`, bounded objective excerpt and both continuation/enrollment prompt ceilings. This is a source/gate synchronization repair, not gate relaxation; existing receipt and exactly-once behavior tests remain mandatory.
