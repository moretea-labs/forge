# Workflow Supervisor authority above the ChatGPT-turn / Forge execution boundary

Status: **Accepted architecture contract; implementation and live canary proof remain pending.**

Date: 2026-09-16

## Context

Forge already has durable authorities for repository Work, Controller ownership, ControllerRound transition, Scheduler occurrences, provider recovery, verification evidence, Outcome and Experience. Those authorities are inside the Forge execution/control plane. They can record that more semantic work is required and can prepare or dispatch a lower-layer continuation while the controlling call stack is alive.

That does not solve the outer lifecycle gap for a ChatGPT Web controller. A typical development loop is:

```text
ChatGPT assistant turn
  -> calls Forge
  -> Forge Work / ControllerRound executes
  -> Forge returns evidence
  -> ChatGPT reasons over the evidence
  -> assistant response commits
  -> original assistant/MCP call stack ends
  X  no durable authority outside that call stack owns starting the next assistant turn
```

A ControllerRound continuation record is therefore not, by itself, an assistant-turn scheduler. Likewise, an MCP session, Browser session, Work lease, Schedule occurrence, or conversation binding is not the authority to decide and durably execute the next outer ChatGPT turn.

The missing authority is a **Workflow Supervisor** above the ChatGPT-turn / Forge execution boundary. It is part of Forge's general autonomous-workflow architecture, but it is not another Work, ControllerRound, Scheduler, or MCP lifecycle owner.

## Decision

Introduce one logical `WorkflowRun` supervised by one durable **Workflow Supervisor**. The Supervisor owns only cross-turn continuation of the original Goal. It delegates each semantic turn to ChatGPT and delegates repository execution to Forge.

```text
Original Goal / logical WorkflowRun
              |
              v
       Workflow Supervisor
       durable single writer
              |
              v
        ChatGPT assistant turn
              |
              v
       Forge Controller / Work
              |
              v
       repository execution
```

The first implementation may live outside the existing Forge execution process, but the protocol, persistence and recovery rules are Forge architecture contracts. ChatGPT Web is the first execution target, not the definition of the Supervisor.

### Authority matrix

| Concern | Authority | What it may decide | What it must not decide |
| --- | --- | --- | --- |
| 1. Forge Work completion | Forge Work finalization / completion receipt | Whether one Work has satisfied its declared Work contract and delivery gates | Whether the original multi-turn Goal is globally DONE |
| 2. ControllerRound continuation | Canonical provider-neutral ControllerRound transition policy | Lower-layer round transitions and fenced continuation obligations | Whether a new outer assistant turn should be scheduled after the caller has disappeared |
| 3. MCP / execution-session recovery | MCP/session/Controller ownership recovery authorities | Rebind transport, recover session/claim, preserve exact lower-layer authority | Goal semantics, outer turn scheduling, or user escalation |
| 4. ChatGPT assistant-turn commit | Workflow Supervisor completion contract, based on a complete final assistant message | Whether one supervised assistant turn committed a valid completion proposal | Goal acceptance merely because the page stopped generating |
| 5. Next assistant-turn startup | Workflow Supervisor | Reserve/reconcile and submit one next turn to the exact execution target | Forge Work internals or repository mutation |
| 6. Long-lived Goal completion | Requirement/Goal semantics plus the WorkflowRun `completionContract` | Validate that a model `DONE` proposal actually satisfies the original Goal and required gates | Treat one Work, patch, test, round or model assertion as sufficient by itself |
| 7. Stagnation / no-progress detection | Workflow Supervisor using execution-quality / evidence observations | Detect repeated checkpoints, no new evidence, repeated failure/verification/recovery patterns | Rewrite lower-layer verification gates or silently terminate the Goal |
| 8. Workflow strategy adaptation | Semantic Controller, guided by Supervisor correction policy and Experience/evaluation evidence | Choose a different execution strategy for the same Goal; later evaluate cross-Work candidates | Create a second execution state machine or promote policy without evidence |

The separation is deliberate. A lower layer may report facts upward, but it does not acquire the upper layer's lifecycle authority by exposing more states.

## Logical WorkflowRun contract

The generic upper-layer contract is intentionally small:

```text
WorkflowRun
  objective
  executionTarget
  completionContract
  continuationPolicy
  userBlockerPolicy
```

`executionTarget` is an adapter identity. Initial support is ChatGPT Web; future targets may include ChatGPT Work, Forge local, Forge Cloud, browser/desktop automation, or another agent runtime.

`completionContract` is a read/validation contract for the original Goal and required evidence. For Forge-backed development Goals it may consult Requirement/Plan/Work receipts and semantic acceptance, but it does not mutate those lower authorities.

`continuationPolicy` defines the fixed enrollment/continuation template, exact target identity, recovery bounds and correction policy. It never accepts model-generated executable `next_prompt` content.

`userBlockerPolicy` validates whether a `NEEDS_USER` proposal is a genuine user-only action, authorization, consent/legal decision, or equivalent blocker with no autonomous recovery path.

### Namespace boundary

Forge already persists `workflow_run` for the declarative Workflow asset interpreter. That record is a checkpoint for executing a versioned Workflow asset; it is not the long-lived autonomous development Goal described here.

V1 Supervisor storage therefore uses a **dedicated Supervisor persistence authority/namespace**. It must not alias or reinterpret the existing declarative `workflow_run` record. Any future convergence requires an explicit migration and authority contract rather than a same-name shortcut.

## Assistant completion proposal protocol

Every supervised ChatGPT turn ends with exactly one machine-readable terminal block at the end of the assistant response:

```text
<<<FORGE_WORKFLOW_SUPERVISOR_V1>>>
{
  "action": "CONTINUE",
  "checkpoint": "...",
  "reason": "...",
  "evidence": ["..."]
}
<<<END_FORGE_WORKFLOW_SUPERVISOR_V1>>>
```

`action` is exactly one of:

- `CONTINUE`: the original Goal is not complete and autonomous work remains.
- `DONE`: a terminal **proposal** that requires `completionContract` validation.
- `NEEDS_USER`: a blocker **proposal** that requires `userBlockerPolicy` validation.

The exact `<<<END_FORGE_WORKFLOW_SUPERVISOR_V1>>>` marker is required before the Supervisor accepts the turn as committed. Prompt delivery, `Stop generating`, spinner/loading state, button state, DOM stability, a text-stability timer, Work completion, ControllerRound closure, or transport disconnection are not assistant-turn commit authority.

The Supervisor never executes arbitrary model-provided `next_prompt`. Enrollment, normal continuation, recovery correction and stagnation correction use Supervisor-owned fixed templates. The normal continuation semantics are:

```text
Continue the current original task.
Continue directly from the previous checkpoint without repeating completed work.
Preserve the original Goal, Requirement, Plan, applicable AGENTS, architecture invariants and verification requirements.
If the previous round failed, re-check root cause and invariants before changing strategy; do not patch only the failing assertion.
End this turn with the FORGE_WORKFLOW_SUPERVISOR_V1 control block.
```

Implementations may localize the wording, but not delegate prompt-chain control back to the assistant.

## DONE and NEEDS_USER validation

A model control block is evidence, not terminal authority.

For `DONE`, the Supervisor validates the configured `completionContract`. A Forge-backed development run must preserve the distinction between Requirement acceptance, Plan/Work delivery, verification/review evidence and outer Goal completion. Missing required evidence causes the `DONE` proposal to be rejected and converted into continuation/correction evidence; it does not lower the gate.

For `NEEDS_USER`, the Supervisor validates `userBlockerPolicy`. Test failures, tool failures, MCP errors, session replacement, provider recovery, implementation failures and ordinary Forge recovery are autonomous failure/recovery facts, not user blockers. A false `NEEDS_USER` proposal is rejected and routed to recovery/correction. Only a validated user-only blocker makes the WorkflowRun quiescent for user action.

## Single writer and event journal

The long-lived Supervisor daemon is the **only durable writer** for Supervisor task/run state. Chrome Extension, Native Messaging transport, Forge execution, and lower schedulers submit observations or execute authorized effects; they never independently mutate Supervisor state.

V1 persists a compact SQLite task/event journal instead of a collection of mutable status JSON files. Durable events include at least:

- enrollment / turn submission intent;
- assistant turn committed;
- continuation effect reserved;
- external effect observed `applied`, `not_applied`, or `unknown`;
- completion/blocker proposal validation;
- recovery/correction decisions;
- verified terminalization.

Current state is derived from the durable task identity and journal. Native Messaging host processes are thin relays and must not open the Supervisor database. On macOS, launchd owns the one long-lived daemon; relay processes may reconnect or respawn without becoming writers.

## Exactly-once continuation and external-effect reconciliation

Each supervised outbound turn is assigned a daemon-minted `submission_effect_id`. The completion of that turn is causally tied to that effect. When a stable provider message id is unavailable, the completion fingerprint is derived from:

```text
task identity
+ exact conversation identity
+ source submission_effect_id
+ canonical full assistant-response hash
+ control-block hash
```

This prevents two different turns with identical assistant text from colliding.

One committed assistant completion may produce at most one logical next-turn effect. The local transaction reserves the next `submission_effect_id`, but local commit does **not** prove that the external ChatGPT send committed.

External send outcome uses the same three-way rule as Forge's non-idempotent effect reconciliation:

- `applied`: the exact fixed outbound effect is observed in the exact conversation; acknowledge it and never resend.
- `not_applied`: absence is positively established under the adapter contract; retry may use the same reserved effect identity.
- `unknown`: evidence is insufficient; keep reconciling and do not blindly resend.

The crash windows before reservation, after reservation/before send, after send/before acknowledgement, and after acknowledgement must all converge through this journal plus remote observation. Daemon restart, extension reload, Chrome restart, tab close/reopen/discard/freeze, Native Messaging reconnect and Forge/MCP session replacement never create a new original Goal or a second continuation for the same committed completion.

## ChatGPT Web adapter boundary

The Chrome Extension is an execution adapter, not a state authority. It may:

- locate or open only an allowlisted exact conversation id/URL;
- read the final complete assistant response and forward bounded evidence;
- submit a daemon-authorized fixed prompt for one exact `submission_effect_id`;
- observe whether that exact outbound effect is present for reconciliation;
- rediscover a closed/discarded tab without changing durable task identity.

It must not select durable tasks by mutable title, open the Supervisor database, decide `CONTINUE/DONE/NEEDS_USER`, invent prompts, weaken Forge gates, or depend on private ChatGPT APIs. Transient generation UI may help avoid pointless reads but is never commit evidence.

Existing conversations require an explicit enrollment handshake. The Supervisor first persists exact conversation identity, original objective and contracts, then reserves one fixed enrollment effect that tells subsequent assistant turns to emit the completion block. A pre-enrollment response without the END marker is never retroactively imported as a committed supervised turn.

## Relationship to existing Forge continuation

The ControllerRound turn-settled continuation contract integrated at `7cd81cf7` remains valid as lower-layer execution compatibility and evidence. It is not the authority that reactivates ChatGPT after the outer assistant call stack is gone, and it is not proof that the long-lived WorkflowRun progressed or completed.

The existing Scheduler likewise remains an execution/occurrence scheduler. It does not become the Workflow Supervisor merely because both systems schedule something.

No Supervisor state is added to Work, ControllerRound, relay, MCP session or existing declarative Workflow asset records in V1. Integration is through typed observations/read-only completion evidence and authorized execution effects.

## Stagnation and strategy evolution

P0 is cross-turn liveness and correctness: durable Supervisor, exactly-once/restart recovery and real unattended Avela development canaries.

After P0 proof, P1 may consume existing execution-quality and Experience evidence to detect repeated checkpoint/evidence/failure/verification/recovery patterns. First confirmed stagnation injects one fixed root-cause correction while keeping the same original Goal and gates. It does not immediately escalate to the user.

Only after P0/P1 evidence should P2 perform cross-Work strategy comparison, policy candidate trials, evaluation and bounded promotion. Existing Experience/evaluation authorities are reused rather than replaced.

## First P0 canary

The first live canary is Avela repository `repo_21712be862868339083670ec` with exactly three current development ChatGPT conversations enrolled by exact conversation id/URL. The two promotion conversations are explicitly excluded.

P0 is not complete when Forge can send one automatic `continue`. It is complete only after the real canary demonstrates multi-turn unattended progress with no user continuation messages, correct conversation isolation, no duplicate continuation, restart recovery, technical-failure recovery, MCP-session replacement, validated `DONE`, and validated `NEEDS_USER`, without lowering Forge verification/review/authorization gates.

## Consequences

- Forge gains one missing upper lifecycle authority instead of stretching lower state machines upward.
- The external protocol remains deliberately smaller than Forge's internal lifecycles.
- Exactly-once is treated as an external-effect reconciliation problem, not as a SQLite uniqueness problem pretending the network does not exist.
- ChatGPT remains the semantic reasoner, but model assertions do not bypass durable Goal or blocker evidence.
- The system can later add execution targets without making Chrome Extension behavior part of the kernel.
