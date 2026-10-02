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
still verifies the exact source effect. Browser resources have the disposable
lifecycle defined below; task/effect history survives resource retirement.
A real b388b27c canary exposed
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

## Disposable browser resources

The existing native Supervisor consumer owns tab retention and restoration.
When browser work is suspended by durable cooldown or unknown-observation
spacing, it may close its created canonical tab only after a readable snapshot
proves that no provider generation is running. An unbound bootstrap's sole
observation resource remains until binding or explicit task termination.
An applied effect awaiting its model receipt remains eligible for observation.
DONE, NEEDS_USER and explicit STOPPED retire owned resources; after restart the
same owner reconstructs ownership from exact task identity and window.name.
An adopted user tab loses only the Supervisor marker and stays open.

When delivery or read-only observation is due, complete supported-browser
inventory must prove the exact enrolled conversation absent before the owner
opens its persisted conversation URL. An unreadable inventory, foreign owner,
ambiguous exact candidate or unresolved resource close fails closed. At most one
restoration per conversation is attempted in a consumer pass, with existing
transport backoff after failure. Reopening a tab neither creates a ChatGPT
conversation nor changes provider effect admission, generation or outcome.
Outcome unknown is still read-only and never authorizes resend. No persistent
state, extra lifecycle owner, schema or provider retry policy is added.

The operator's three-goal consolidation explicitly stops historical duplicate
tasks through the Supervisor API. It does not infer completion, clear effects,
cancel another execution owner's claim or delete ControllerRound authority.

Project discovery attributes a conversation to a project page only when its
canonical route carries the same project id. Sidebar presence is not project
membership. The existing discovery store validates both incoming and retained
metadata against that route, including projects whose URLs omit a title slug;
a conflicting observation cannot displace a proven title from another source.
Discovery remains observation, never task enrollment or dispatch authority.

## Provider observation and explicit recovery (20261002)

The same native consumer reads the visible hydrated conversation surface.
Hidden server-rendered copies, profile loading and unrelated page busy markers
are not provider activity. Current-turn reasoning/tool text contributes only to
the existing activity digest, even before an assistant role message exists.
Current provider status regions include localized disconnect/delivery-timeout
messages. A status region is evidence; arbitrary chat prose is not.

A reserved recovery remains authorized across consumer passes and provider
cooldown, but never authorizes stopping a live turn. Unchanged reasoning/tool
activity and local wait expiry do not prove provider termination. A latest user
role without a settled assistant remains unresolved even if the Stop button is
absent. Only a settled idle assistant or explicit provider failure admits the
existing bounded recovery; a resumed live provider delays its dispatch. The
original applied prompt is never replayed. A dispatch function returning
without clicking Send supplies a dispatch-owner negative proof. Browser observers
still cannot turn absence or a transport exception into that proof.

After bounded automatic recovery stops, an explicit user recovery may reserve
one causally keyed recovery of the current applied leaf. The local operator RPC
requires exact task/source effect, a request id and reason; Native Messaging has
no access to it. Duplicate calls reuse the same recovery. Existing exhausted
events, provider generations and task/conversation identity are retained; the
new recovery itself cannot recursively auto-recover. No schema, enum, process,
readiness authority or recovery owner is added. Existing terminal states remain
terminal and an unresolved unknown effect blocks this operation.

Bounded migration exception: the pre-20261002 native adapter recorded its own
returned pre-click failures as unknown. Explicit recovery may reconstruct a
negative proof only from the current dispatch's persisted native pre-send reason,
never a browser snapshot or generic exception. Remove this reader after those
historical effects reconcile; new producers write the negative proof directly.
The same whole-Runtime release/rollback and existing Supervisor retention apply.

## Productive turns and frozen tool context (20261002)

Every newly rendered Supervisor prompt includes the existing `@forge` tool
invocation used by the ordinary ChatGPT delivery adapter. Normal continuations
retain conversation context instead of repeating the full historical objective,
and ask for the next unfinished product change or acceptance check. Unchanged
infrastructure summaries do not satisfy a work checkpoint.
Normal turns carry the existing registered repository identity and name the
direct read/edit/command/check tools. An explicitly registered checkout is carried
with that identity, so concurrent platform tasks do not follow one mutable
repository default. This is execution context, not checkout allocation or an
authorization bypass; domain tools still validate the selected checkout and fences.
Existing registration may fill this hint only once when it was initially absent
and every task/conversation/repository/objective/policy/semantic obligation is
unchanged. The existing Store transaction is the sole writer; conflicting
checkout selections fail. One diagnostic event in the existing journal records
the selected ids; retries of the original registration retain the selected hint.
No schema, lifecycle enum, RPC, process or alternate routing
authority is added. Effect prompts, unknowns, budgets and completion history are
untouched; existing retention, backup and whole-Runtime rollback still apply.
Semantic Work records are not execution.
Retrieval readiness describes bounded evidence gaps; the model resolves relevant
gaps and owns semantic sufficiency. It is not a second authorization/approval gate.
Missing implementation requires a scoped architecture decision and implementation,
rather than repeated substrate discovery. This adds prompt context only, with no
dispatch authority, schema, lifecycle or heuristic productivity gate.
Model judgment owns
which coherent wave advances the authorized objective; no keyword/count/score
gate, claim bypass, forced code mutation or automatic goal completion is added.
Context materialization owns bounded, redacted source bytes and their line/hash/
truncation metadata; the MCP facade must preserve them together. Explicit code
needles retain lexical coverage even when fuzzy structural candidates fill the
discovery budget. Existing current-turn provider status also recognizes analysis
paused as unavailable response delivery, retaining outcome-unknown classification
and the same single bounded resume. A live generating surface still blocks Send.
The read-only Work continuation projection directs open Work toward its next
authorized scoped step rather than prescribing a retired model-facing claim
operation. Existing execution admission and writer/resource fences still apply.

The receipt instruction includes the exact two-field `rh_work` JSON carrier.
Existing frozen clients' optional `repo_id`, `checkout_id` and `reason` annotations are bounded
strings and stripped at the compatibility boundary; neither can select a task,
effect, conversation, terminal outcome or repository mutation. Unknown fields
and unsafe keys still fail closed. The existing canonical Supervisor derives
receipt identity and reserves the successor transactionally. No schema, writer,
tool, extra receipt parser or replay authority is introduced.

An explicitly launched child ChatGPT Work already goes through
`ensureWorkflowSupervisorEnrollmentForWork`: a distinct canonical conversation
gets its own existing task/effect journal, while a reused conversation returns
its original owner. Subsequent turns and accepted termination use the same
Supervisor and disposable tab cleanup. Prompt guidance requires enrollment
before a handoff; it does not create child conversations or a second parent
lifecycle. Existing typed Work relations carry decomposition when needed.

Verification extends retained compatibility, provider-wait and continuation
scenarios. Whole-Runtime activation follows canonical gates; actual productive
successive turns remain separate live acceptance evidence. Original exhausted
records are preserved and may only receive the existing explicit operator
recovery after the exact provider turn is proven settled or failed.
