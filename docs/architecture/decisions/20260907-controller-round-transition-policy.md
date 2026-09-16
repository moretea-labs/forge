# ControllerRound uses one provider-neutral transition policy

Status: Accepted design contract for PLAN-forge-v2-assistant-loop-execution-degradation-20260907-r3.

## Decision

Every durable ControllerRound lifecycle mutation MUST pass through one provider-neutral Kernel transition policy. Scheduler, Launcher, MCP compatibility, ChatGPT/Browser adapters, recovery jobs, Runtime bootstrap/restart code and provider hosts may only:

1. observe durable state,
2. submit a typed lifecycle event plus bounded fenced evidence,
3. perform an external effect explicitly authorized by the returned transition/effect intent, and
4. persist only the transition decision produced by the canonical policy.

They MUST NOT directly invent status changes, clear blocker strings, reset budgets, rotate round authority, promote dispatch outcome, reopen waits, or create provider-specific recovery exceptions. Provider-specific facts are translated into provider-neutral evidence before reaching the Kernel.

The canonical owner belongs under `packages/kernel/controller/**`. Persistence remains atomic/CAS guarded, but persistence is an executor of the policy decision rather than a second lifecycle authority.

## Why

The existing lifecycle has ten relay statuses and four lifecycle stages, but transition authority is distributed across initial launch, dispatch settlement, claim acknowledgement, stalled recovery, explicit authority recovery, disposition submission, release handling, successor handoff and terminal cleanup. `blocked` additionally carries several unrelated meanings. Local guards are individually sensible but the combined system permits gaps, duplicated recovery rules and route-dependent semantics.

The fix is not another blocked-reason branch. The invariant is one lifecycle decision authority.

## Durable state classes

| Class | Relay status | Meaning | Automatic recovery |
| --- | --- | --- | --- |
| Open execution | `dispatching`, `dispatched`, `claimed`, `pending_release` | One semantic round is still mechanically open or closing | Yes, only idempotent recovery of the same semantic round |
| Semantic pause | `waiting`, `waiting_for_user` | Controller intentionally stopped semantic progression | No stalled-time recovery; requires an explicit legal event |
| Semantic terminal | `goal_complete`, `handed_off` | This lineage node is semantically closed | Never automatically reopened |
| Failure/fuse | `failed`, `blocked` | Mechanical failure or an explicit policy fuse | Only according to typed failure class and matching evidence |

`lifecycleStage` remains orthogonal evidence of the semantic boundary:

- `dispatching`
- `dispatch_confirmed`
- `controller_claimed`
- `semantic_round_closed`

A status and lifecycle stage combination not admitted by the transition policy is invalid durable state and must fail closed.

## Canonical event model

External layers submit events, never target statuses. The exact TypeScript names may differ during implementation, but the semantics are frozen here.

| Event | Required evidence | Policy responsibility |
| --- | --- | --- |
| `occurrence_requested` | occurrence identity, origin, Work/Requirement state, caller authority | Decide whether this is a legal genuinely new occurrence or an illegal fuse/wait bypass |
| `provider_dispatch_succeeded` | exact round authority + relay scope + provider dispatch receipt/effect identity | Confirm dispatch, clear only provider-dispatch failure state for this round |
| `provider_dispatch_failed` | exact round identity + classified failure evidence | Increment provider-failure budget and choose retry/fail/fuse |
| `provider_dispatch_outcome_unknown` | exact effect identity, no contradictory settlement | Enter outcome-unknown reconciliation state; never blind replay |
| `provider_effect_reconciled` | exact previously unknown effect identity + confirmed executed/not-executed evidence | Confirm existing dispatch or authorize a new dispatch only when absence is proven |
| `controller_claim_observed` | active ControllerSession ownership + exact round authority/scope | Move the same round to claimed; never create a new semantic round |
| `semantic_disposition_submitted` | exact claimed round identity + disposition + required handoff/evidence | Close semantic round and consume semantic budgets exactly once |
| `controller_release_observed` | exact released controller epoch + already persisted disposition | Mechanically continue post-disposition flow without re-submitting disposition |
| `successor_bound` | completed predecessor + already-admitted successor lineage | Atomically close predecessor relay and create successor round according to authority rule |
| `stalled_round_observed` | exact current relay revision, liveness evidence, no active conflicting execution/claim | Recover only an unfinished open mechanical transition; elapsed time is never semantic evidence |
| `semantic_state_changed` | new mechanical/semantic fingerprint tied to exact relay lineage | May rearm `repeated_state`; cannot clear unrelated fuse classes |
| `provider_environment_recovered` | exact blocked relay revision + verified provider/runtime capability evidence + failure-class match | May rearm `consecutive_failures` for the same undispatched round without consuming another semantic round |
| `user_resume_requested` | explicit user authority + exact paused/failure lineage | Resume only states whose policy explicitly permits user resume |
| `terminal_work_observed` | failed/cancelled Work + no active claim | Retire surviving relay mechanically; never fabricate semantic completion |
| `authority_recovery_requested` | explicit authorized recovery + no active execution/claim + exact current relay | Rekey capability only where policy permits; never change semantic budgets |
| `runtime_or_session_evicted` | durable round still current, transport/session gone | Preserve semantic round and authority unless an explicit authority-recovery rule applies |

## Blocked policy is typed, not a free-form string switch

`blockedReason` may remain as a compatibility projection, but policy decisions use a typed blocker class. At minimum:

| Blocker class | Meaning | Legal exit | Budget behavior | Authority behavior |
| --- | --- | --- | --- | --- |
| `repeated_state` | semantic continuation repeated without meaningful state progress | `semantic_state_changed` with a changed exact fingerprint | reset repeated-state counter only; round/provider-failure budgets preserved | same semantic-round authority when rearming the same undispatched/claimed lineage |
| `provider_unavailable` / `consecutive_failures` | provider/runtime path repeatedly failed before successful progression | `provider_environment_recovered` with exact relay and verified environment/provider evidence | provider failure streak may start a new recovery epoch; historical failures remain auditable; round/repeated budgets unchanged | preserve authority for the same undispatched semantic round |
| `round_budget_exhausted` | hard semantic continuation budget reached | no automatic exit; only explicit higher-level replanning/new authorized occurrence that does not pretend to be the same exhausted round | never reset because time passed or provider recovered | old round authority cannot be reused as a fresh semantic round |
| `provider_dispatch_outcome_unknown` | provider effect may already have happened | exact `provider_effect_reconciled`; positive evidence confirms existing effect, negative evidence may authorize one new dispatch | no blind retry; no semantic-round budget duplication | preserve same authority/effect identity until reconciled |
| `provider_user_action_required` | provider needs human/auth action | explicit user/handoff resolution followed by legal resume event | no background retry budget churn | same lineage; new semantic round only if policy says the resolved occurrence is new |

No generic `blocked -> dispatching` transition exists.

For the ChatGPT Controller provider, `provider_environment_recovered` is admitted only through exact ControllerRound authority plus a fresh non-semantic provider probe. The probe must use the same runtime provider selection as ordinary Controller dispatch, must not replay the blocked Work prompt, and must produce a server-authored durable Recovery audit record only after dispatch is confirmed. The audit identity is recovery evidence, not a second lifecycle authority: the Kernel still performs the exact relay-scope/authority/CAS checks and the canonical `provider_environment_recovered` transition. Failed, ambiguous, user-action-required, stale, or mismatched probes cannot rearm the fuse. MCP compatibility may expose this as a bounded repair intent, but it must not duplicate `controller.authority.recover` or invent a provider-specific round state.

## Budget contract

ControllerRound has three independent budget dimensions. No code path may use one to reset another.

### `roundCount`

Counts semantic `continue_immediately` progression rounds, not transport retries, Runtime restarts, claim migration, release recovery, provider recovery, outcome reconciliation or stalled-transition repair. It is consumed exactly once at semantic close/open according to the canonical policy.

### `repeatedStateCount`

Measures semantic continuation without meaningful state fingerprint progress. It resets only when policy observes a changed canonical semantic/mechanical fingerprint. Provider health changes alone do not reset it.

### Provider failure budget

Tracks failed provider dispatch/recovery attempts for the exact provider-neutral dispatch responsibility. A verified environment/provider repair may begin a bounded recovery epoch for the same semantic round, but must not erase historical failure evidence or change `roundCount`/`repeatedStateCount`. The implementation may store a typed recovery epoch or derive it from immutable evidence; either way, `consecutiveFailures = 0` alone is not sufficient evidence of recovery.

Time passage is never a budget reset signal.

## Authority contract

There are distinct authorities and they must not be conflated:

- `authorityId`: opaque per-semantic-round ControllerRound capability.
- `relayScopeId`: durable semantic lineage scope.
- `claimGeneration`: ControllerSession ownership epoch.
- provider effect/dispatch identity: evidence identity for an external effect, never Controller authority.
- MCP/browser/session ids: transport identities only.

Rules:

1. The same undispatched semantic round keeps `authorityId` through transport loss, Runtime restart, MCP eviction, stalled mechanical recovery and verified provider/environment recovery.
2. A genuinely new semantic round rotates `authorityId`.
3. Successor Work handoff creates the successor round under the same relay lineage and rotates to a new round capability.
4. Claim/session migration changes ControllerSession identity/`claimGeneration`, not semantic round identity.
5. Explicit authority recovery is a separate fenced capability-rekey operation. It must not silently consume a new round or reset budgets.
6. Provider, Browser and MCP adapters can never mint lifecycle authority by presenting a transport/session id.

## Fresh occurrence rule

`launcher_start` or a schedule/manual trigger is not automatically proof of a fresh semantic occurrence. The transition policy must classify `occurrence_requested` against the latest lineage.

A new occurrence is legal only when the prior semantic state and trigger contract explicitly allow it, for example a designed future schedule occurrence after a semantic `wait`, or an explicit higher-level user/replan action after a recoverable failure.

A launch request MUST NOT bypass:

- `round_budget_exhausted`,
- an unresolved `provider_dispatch_outcome_unknown`,
- `waiting_for_user`,
- `goal_complete`,
- `handed_off`, or
- a `consecutive_failures` fuse that lacks verified provider/environment recovery evidence.

Whether ordinary `waiting` permits a later scheduled occurrence is determined by the Schedule/occurrence contract and an explicit occurrence identity, not merely because `beginInitialControllerRoundDispatch` was called again.

## Legal lifecycle skeleton

The policy must preserve this semantic ordering while allowing idempotent retries of each mechanical edge:

```text
legal new occurrence
  -> dispatching
  -> dispatched          (or blocked/failed/waiting_for_user by typed provider outcome)
  -> claimed
  -> semantic disposition
       continue_immediately -> pending_release -> release -> next dispatching/new authority
       wait                 -> waiting
       wait_for_user        -> waiting_for_user
       goal_complete        -> goal_complete

completed predecessor + admitted successor
  -> predecessor handed_off + successor dispatching (atomic lineage transition)
```

Recovery never skips semantic edges. It only completes or replays an idempotent mechanical edge of the same semantic decision.

## Persistence boundary

The transition policy consumes an immutable current snapshot plus one event and returns one of:

- `accept`: exact next relay record and optional external-effect intent,
- `no_op`: idempotent duplicate with the already-authoritative record,
- `reject`: stable reason/error code,
- `needs_evidence`: missing exact evidence required to decide safely.

The store applies accepted decisions under the relay-scope lock / transaction using the expected record revision. External effects occur only where the policy explicitly emits an effect intent. After the effect, the adapter submits its receipt as a new event; it never writes the post-effect relay state directly.

This separates lifecycle decision authority from persistence and provider execution while preserving CAS fencing.

## Crash-window contract

Each window has exactly one legal recovery interpretation.

| Crash window | Durable fact | Recovery rule | Forbidden shortcut |
| --- | --- | --- | --- |
| before provider dispatch starts | `dispatching`, no effect receipt | same-round dispatch may be authorized by policy | rotate authority or increment semantic round |
| after provider may have acted but before receipt persistence | effect outcome uncertain | enter/reconcile exact outcome-unknown identity | blind replay |
| after dispatch receipt, before relay becomes `dispatched` | durable receipt exists | replay `provider_dispatch_succeeded` idempotently | send provider effect again |
| after `dispatched`, before Controller claim | dispatch confirmed | claim same round from exact ownership evidence | create fresh occurrence |
| after claim persistence, before prompt/controller observes response | claimed + live/recoverable ownership | duplicate claim is no-op/migration if fenced | consume another round |
| after semantic disposition persistence, before controller release | `pending_release`/semantic terminal | retry release/post-disposition mechanics only | resubmit disposition |
| after controller release, before next round creation | closed disposition + released exact epoch | create/restore exactly one next round according to disposition | repeat prior round close |
| during predecessor/successor handoff | transaction must contain both lineage writes or neither | retry atomic handoff | independently mutate predecessor and successor |
| Runtime restart | durable relay survives transport | reconstruct from durable state and same round authority | treat restart as fresh occurrence |
| MCP/session eviction | transport lost only | reclaim/migrate ControllerSession if fenced; preserve relay identity | use new MCP session as authority |

## Fault-injection matrix frozen for the next Plan step

The implementation step must add focused failures at least at:

1. crash before provider call,
2. provider call succeeds but receipt write is lost,
3. receipt exists but `dispatched` transition is lost,
4. `dispatched` exists but claim response is lost,
5. claim persists then Runtime/MCP restarts,
6. disposition persists then release fails,
7. release persists then next-round creation fails,
8. successor handoff crashes between predecessor/successor writes,
9. repeated-state block with unchanged fingerprint,
10. repeated-state block with changed fingerprint,
11. provider failures reach fuse,
12. verified provider/environment recovery for that exact fuse,
13. stale/mismatched provider recovery evidence,
14. outcome-unknown positive reconciliation,
15. outcome-unknown proven-not-executed reconciliation,
16. hard round-budget exhaustion,
17. waiting scheduled occurrence with explicit occurrence identity,
18. waiting_for_user without explicit user/handoff resolution,
19. goal_complete/handed_off relaunch attempt,
20. failed/cancelled Work terminal cleanup with and without active claim.

Assertions must cover status, lifecycleStage, `roundCount`, `repeatedStateCount`, provider-failure epoch/history, `authorityId`, `claimGeneration`, provider dispatch/effect receipt identity, duplicate-effect count and durable revision/CAS behavior.

## ControllerRound validation Supervisor Work acceptance sequence

Here, “Supervisor” is the historical name of the existing long-lived **ControllerRound validation Work lineage**. It is not the cross-assistant-turn Workflow Supervisor defined by `20260916-workflow-supervisor-authority.md` and owns no outer WorkflowRun scheduling authority.

Production validation uses that existing ControllerRound validation Work lineage. It may not manufacture a new Work/Requirement/relay to make the test pass.

1. Build and activate one exact candidate Runtime containing the transition policy.
2. Verify required provider/plugin capability on that installed Runtime before relay mutation.
3. Re-read the exact existing ControllerRound validation Supervisor Work, Requirement, relay scope, authority, blocked class, budgets and current record revision.
4. Submit verified provider/environment recovery evidence for the existing `consecutive_failures` block.
5. Prove the same semantic round is rearmed without changing `roundCount`, `repeatedStateCount`, relay scope or per-round authority, and without erasing historical failure evidence.
6. Prove provider dispatch occurs at most once and exact Controller claim succeeds.
7. Let ChatGPT submit its semantic disposition.
8. Prove at least one `continue_immediately -> pending_release -> controller release -> successor/next dispatch` sequence completes automatically without a human sending `继续`.
9. Verify round authority rotates only at the true new-round boundary and no duplicate disposition/provider effect exists.
10. Only after this sequence may the Automatic Progression acceptance step be considered complete.

## Required implementation shape

The next Plan step must converge existing mutation helpers onto one policy rather than wrapping the old special cases with another layer of exceptions. A suitable shape is:

```ts
type ControllerRoundEvent = ... // provider-neutral typed events
type ControllerRoundTransitionDecision = Accept | NoOp | Reject | NeedsEvidence

function decideControllerRoundTransition(
  current: ControllerRoundAggregateSnapshot,
  event: ControllerRoundEvent,
): ControllerRoundTransitionDecision
```

Existing public helpers may remain as compatibility facades during migration, but they become thin event builders around the canonical policy. Scheduler, Launcher, MCP and provider adapters must contain no independent status/blocker transition tables after convergence.

## Explicit non-solutions

Do not:

- add a one-off `consecutive_failures` rearm branch,
- raise `maxFailures`/`maxRounds`,
- clear durable counters or edit SQLite by hand,
- use elapsed time as provider recovery proof,
- treat Browser/ChatGPT registration as Kernel-specific lifecycle logic,
- infer successful dispatch from a transport session id,
- reopen semantic terminal states from stalled recovery,
- create another ControllerRound validation Supervisor Work/relay to avoid the blocked lineage, or
- keep parallel mutation tables in Scheduler/Launcher/MCP while claiming a central policy exists.

This ADR is the acceptance authority for the r3 ControllerRound recovery-convergence implementation.

## Explicit migration map from current implementation

Current `controller-round-store.ts` exposes ten lifecycle mutators and contains fifteen direct ControllerRound persistence write sites. Migration is complete only when these entry points no longer contain independent lifecycle decision tables.

| Current helper | Compatibility role after convergence | Policy event / responsibility |
| --- | --- | --- |
| `bindControllerRoundSuccessorWork` | thin facade | submit `successor_bound`; policy validates predecessor/successor lineage and atomic handoff eligibility |
| `submitControllerRoundDisposition` | thin facade | submit `semantic_disposition_submitted`; all semantic-close budget/status decisions move to policy |
| `beginInitialControllerRoundDispatch` | thin facade | submit `occurrence_requested`; policy decides whether occurrence is genuinely new and legal |
| `beginControllerRoundRelayAfterRelease` | thin facade | submit `controller_release_observed`; policy chooses same-lineage next-round transition and authority rotation |
| `reconcileControllerRoundAfterAbandonedRelease` | thin facade | submit released-without-disposition evidence; policy chooses mechanical failure/retirement only |
| `reconcileControllerRoundAfterTerminalWork` | thin facade | submit `terminal_work_observed`; policy retires failed/cancelled Work relay only |
| `finishControllerRoundRelayDispatch` | thin facade | submit one of dispatch succeeded/failed/outcome-unknown/user-action events; no local status ternary remains |
| `acknowledgeControllerRoundClaim` | thin facade | submit `controller_claim_observed`; repeated-state/outcome-unknown recovery must not live in claim code |
| `recoverControllerRoundRelayAuthority` | thin facade | submit `authority_recovery_requested`; policy validates state and emits capability rekey only |
| `claimStalledControllerRoundRelays` | scanner/orchestrator only | identify candidates and submit `stalled_round_observed` / evidence events; it must not write recovered relay states itself |

### Persistence convergence

The current store has fifteen `writeControlPlaneRecord*` call sites associated with these lifecycle paths. The target is not necessarily one physical SQL statement, because successor handoff legitimately needs a two-record transaction, but there must be **one logical apply authority**:

- ordinary single-relay transitions go through one `applyControllerRoundTransitionDecision(...)` persistence executor;
- predecessor/successor handoff goes through one atomic `applyControllerRoundHandoffDecision(...)` executor produced by the same policy;
- no public mutation facade calls `writeControlPlaneRecord*` after making its own status/budget/blocker decision.

### Outer-layer convergence

Current outer composition demonstrates why this is necessary:

- `chatgpt-round-continuation.ts` currently composes initial dispatch, dispatch finish, claim acknowledgement, disposition and release/next-round helpers; after migration it orchestrates provider effects around policy events only.
- Scheduler maintenance currently claims stalled relays and directly records dispatch success/failure; after migration it scans/authorizes wake, performs the provider effect intent, then submits the resulting receipt event.
- MCP runtime tools currently invoke claim, disposition, release, launch and dispatch settlement helpers directly; after migration MCP is a compatibility/event translation surface only.
- ChatGPT/Browser provider adapters remain responsible for provider-specific observation and effect execution, never lifecycle status selection.

### Completion assertion

A static regression should fail if Scheduler, Launcher, MCP compatibility or provider adapters acquire a new direct ControllerRound status/blocker mutation table or write ControllerRound relay records outside the canonical apply executor. This is an architecture boundary, not a code-style preference.


## Workflow Supervisor boundary clarification

ControllerRound transition authority remains lower-layer execution authority. Any provider-observed `controller_turn_settled` event in this ADR is a mechanical liveness fallback for an exact claimed round. It must not be reused as the outer Workflow Supervisor's assistant-message commit event or next-turn scheduling authority. The latter requires the completed `FORGE_WORKFLOW_SUPERVISOR_V1` block, exact END marker, conversation identity and causal submission-effect evidence defined in [`20260916-workflow-supervisor-authority.md`](20260916-workflow-supervisor-authority.md).

## 2026-09-16 amendment: settled Controller turns cannot silently strand nonterminal Work

User-free continuation is a P0 lifecycle invariant. A provider may submit a typed `controller_turn_settled` fact only after the exact assistant turn is observably complete; prompt submission itself is not completion evidence. The provider supplies bounded completion evidence, never a disposition.

The canonical ControllerRound transition policy decides the consequence. If the current round is still `claimed`, its Work is nonterminal, and no explicit stop state exists, the policy records the existing `continue_immediately -> pending_release` lifecycle while preserving round/repeated/failure budgets. If an active control-plane Handoff proves a user decision is required, the same policy closes as `wait_for_user`. If `wait`, `wait_for_user`, `goal_complete`, `blocked`, `failed`, or another already-closed state won the race first, settled-turn replay is idempotent and changes nothing. Terminal Work is retired through the existing terminal-work transition.

This amendment does not create a second Scheduler or semantic Controller. It changes the default for one previously ambiguous state only: **a completed Controller turn may not leave a still-running Work silently claimed merely because the model failed to call the explicit continue helper.** The provider-specific observation and same-conversation dispatch mechanics remain adapter responsibilities, while all durable lifecycle mutation continues through this provider-neutral policy.
