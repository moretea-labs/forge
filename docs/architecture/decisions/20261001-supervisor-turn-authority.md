# Supervisor owns the enrolled prompt chain

Status: accepted implementation contract for the autonomous-continuation candidate.

## Decision

An explicitly enrolled logical conversation is a durable task. Workflow Supervisor
monitors its exact provider effect, commits the model's structured receipt, and
reserves the next fixed prompt for CONTINUE. DONE and NEEDS_USER retain their
configured semantic validators; STOPPED remains explicit operator authority.

The first Work-bound enrollment still requires authenticated launcher admission,
canonical Work lookup and a prepared ControllerRound. Once enrolled, the existing
Supervisor task/effect/completion journal is the only cross-turn authority.
Neither Work absence/turnover nor ControllerRound status/budget is a second gate
on a committed CONTINUE. Supervisor must not manufacture Controller claims,
release another owner's lease, rotate round authority, or rearm lower budgets to
make an outer prompt runnable. Normal MCP execution still enforces principal,
Controller ownership, Work scope, resource and write fences independently.
The enrollment compatibility receipt may settle only its exact origin Work and
provider effect. A newer Requirement relay is never a substitute receipt target.

Explicit Requirement cancellation revokes new sends for that Goal; Work carrier
cancellation alone does not. An explicit Work conversation rebind fences new sends to the predecessor
conversation at dispatch admission. Already-started effects remain observable
on their original exact conversation: unknown never authorizes resend. New task
registration retains the initial Work id as provenance even for Requirement
contracts. Existing Work-named tasks provide the same provenance from their
registered identity. Legacy Requirement-only tasks retain their registered
conversation; no newest Requirement relay is selected as their transport owner.

Scheduler liveness discovers existing relay references as well as repo Work
projections and resolves them through canonical getWorkContract. A missing list
entry is not deletion. A genuinely missing Work never implies completion or
authorizes retiring an unresolved provider effect. This candidate does not add
orphan deletion, a new relay index, or a second cleanup lifecycle.

## Cross-cutting closure

| Area | Existing owner and candidate behavior |
| --- | --- |
| Identity / scope | Exact enrolled task + conversation + causal effect; Work is execution context. |
| Authority / authorization | Supervisor owns prompts; authenticated MCP and Controller own repository mutations. No lease or capability is synthesized by receipt processing. |
| Concurrency / fencing | Existing effect dispatch transaction, unique causal successor, Runtime write claim and provider lane remain. Rebind is checked again at dispatch admission. |
| Persistence / replay | Existing Supervisor SQLite schema and append-only event journal; completion replay repairs the same successor after restart. No new table, enum or writer. |
| Unknown / recovery | Existing bounded provider attempts and independently spaced unknown observations. Retired Work does not suppress read-only effect reconciliation. |
| Lifecycle / retention | Supervisor terminal receipts/operator stop own task termination; existing retention/backup policies remain. Missing Work is not semantic terminality. |
| Evidence / privacy | Existing causal completion hashes, allowlisted provider evidence and redaction; no page-body persistence added. |
| Capacity / time / performance | Existing send lane, bounded scanner, retry cooldown and observation budgets; remove per-turn whole-Requirement and session/round mutation chains. |
| Topology / portability | Same in-process Runtime/Supervisor owner and native Browser adapter; no process, credential flow or platform dependency added. |
| Release / rollback | One compatible whole-Runtime candidate; no component activation or manual live database repair. |

## Predecessor obligations

| Previous obligation | Disposition | Successor location |
| --- | --- | --- |
| 20260916 Supervisor authority: exact conversation, model receipt, fixed prompts, semantic validators | KEEP | Supervisor control-plane/protocol/store and forge-validators. |
| Restart-safe effects, no unknown resend, bounded recovery | KEEP | Existing Supervisor effect journal and Browser adapter. |
| 20261001 ambiguous-send reconciliation: observer snapshots never authorize provider mutation | KEEP | 19147d69 remains the candidate baseline; native reconciliation stays read-only. |
| Lower ControllerRound continuation/provider authority | CHANGE | Initial admission/direct non-ChatGPT effects remain Controller-owned; enrolled ChatGPT continuation belongs exclusively to Supervisor. |
| 20260919 autonomous Work liveness and same-occurrence recovery | CHANGE | Scheduler canonical lookup of relay-referenced semantic Work; subsequent prompt-chain repair stays in Supervisor. |
| Explicit successor lineage/conversation inheritance | KEEP | Existing typed Work lineage and explicit binding API; outer task/effect identity does not change with a Work carrier. |
| Real unattended restart, multiple CONTINUE, DONE/NEEDS_USER canary | KEEP | Existing focused scenarios, process-restart smoke and release-bound live continuation proof; candidate is not complete before that evidence. |

## Verification

Retained scenarios must prove causal CONTINUE successor idempotency through
lower budget exhaustion without mutating the lower round, exact-conversation
rebind fences, observation of old started effects, semantic Work discovery,
the automation receipt successor baseline, bounded retry/unknown behavior and
process restart. Compiler and canonical architecture gates precede deployment.
Live acceptance requires a real enrolled conversation advancing multiple turns
without human continuation and a validated terminal receipt.

The native consumer must accept a causally completed tool-only turn even when
ChatGPT renders no assistant prose and its last visible message role is user.
Provider generation and cooldown still delay a new send, and dispatch admission
still verifies the exact source effect. An owned observation tab survives sends
and unknown-observation spacing until the enrolled task becomes terminal; poll
eligibility is not resource retirement authority. A real b388b27c canary exposed
these consumer gaps after its first persisted CONTINUE, so source gates alone
did not establish unattended continuation acceptance.

## Timely consumption under observation backlog

The native consumer refreshes the canonical pending-send projection between
individual read-only tab inspections, including within bootstrap unknown-effect
inventory walks. At most one send is serviced at each checkpoint; least-recently
checked eligible effects receive the next opportunity. Busy/cooldown checks are
spaced by the existing active tick. Observation resumes after that opportunity,
so fresh sends cannot starve it and a full historical scan cannot hold a new
CONTINUE until the next pass. This is serial cooperative scheduling within the
same Runtime owner; its timestamps are ephemeral fairness hints, never dispatch
authority. Existing bounded native calls and admitted provider dispatches finish
before the next checkpoint; no operation is abandoned or allowed to race a
second writer. Unknown observation spacing/budgets, durable dispatch CAS,
source-completion validation and the shared provider lane remain authoritative.

Live acceptance also records completion-to-successor dispatch latency under
existing Browser backlog. An eventual CONTINUE/CONTINUE/DONE chain alone does
not establish timely continuation. The previous 5a6fc9cb canary's 688,144 ms
second-successor delay is failed timing evidence and remains in the incident
record; it must not be erased or relabeled as successful timing acceptance.
