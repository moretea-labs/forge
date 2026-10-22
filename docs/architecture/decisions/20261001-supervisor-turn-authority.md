# Supervisor owns the enrolled prompt chain

Status: accepted implementation contract for the autonomous-continuation candidate.

## Decision

An explicitly enrolled logical conversation is a durable task. Workflow Supervisor
monitors its exact provider effect, commits the model's structured receipt, and
reserves the next fixed prompt for CONTINUE. DONE and NEEDS_USER retain their
configured semantic validators; STOPPED remains explicit operator authority.

A standalone task may name an existing Work solely for semantic completion proof.
Initial bootstrap must not acquire or replace that Work's provider conversation.
An explicit same-task conversation migration may carry only an existing Work
projection of its exact source; unrelated bindings remain under their own authority.
Work-owned enrollment retains its existing exact-conversation conflict fence.

Transport observation failure is never conversation-migration authority. A missing
extension receiver or repeated unreadable snapshot leaves the same exact causal
obligation intact under existing bounded diagnostics/backoff; it cannot prove
that an applied provider turn is no longer active. Automatic migration requires
the existing committed continuation boundary or a live terminal capacity banner;
other conversation changes remain explicit operator decisions.

The Supervisor Effect prompt carries immutable task identity, outcome objective and terminal receipt; it is not a per-turn checklist, execution-time budget, or reason to perform a status probe before work. Ordinary CONTINUE turns should resume substantive work for as long as safe, useful actions remain. A terminal C receipt is a protocol acknowledgment, not evidence of productive progress; observed tool calls and deliverables are separate evidence. JSON metadata and Project instructions do not grant a missing ChatGPT App capability.

The first Work-bound enrollment still requires authenticated launcher admission,
canonical Work lookup and a prepared ControllerRound. Before consulting that lower
admission gate, the Runtime checks whether the exact conversation already has a
Supervisor task. Once enrolled, that existing task/effect/completion journal is the
only cross-turn authority and is reused even if its original ControllerRound is now
closed, exhausted or absent. Neither Work absence/turnover nor ControllerRound
status/budget is a second gate on a committed CONTINUE. Supervisor must not manufacture Controller claims,
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
| Persistence / replay | Existing Supervisor SQLite schema and append-only event journal; every nonterminal task must mechanically derive one causal obligation (unapplied effect, applied effect awaiting completion, or committed completion awaiting successor/terminal settlement). Restart reconciliation repairs the same obligation without a new table, enum or writer. |
| Unknown / recovery | Existing bounded provider attempts and independently spaced unknown observations. Retired Work does not suppress read-only effect reconciliation. |
| Lifecycle / retention | Supervisor terminal receipts/operator stop own task termination; existing retention/backup policies remain. Missing Work is not semantic terminality. |
| Evidence / privacy | Existing causal completion hashes, allowlisted provider evidence and redaction; no page-body persistence added. |
| Capacity / time / performance | Existing send lane, bounded scanner and observation budgets. Provider-wide inventory/backpressure may delay the consumer globally; exact-conversation target failures are task-local and cannot back off unrelated Supervisor tasks. |
| Topology / portability | Same in-process Runtime/Supervisor owner and native Browser adapter; no process, credential flow or platform dependency added. |
| Release / rollback | ReleaseSession verifies isolated Candidate B, then cutover retains rollback authority during soak. The new Stable release cannot become known-good until the canonical Supervisor ledger proves a causal CONTINUE → CONTINUE → DONE on the exact active release: one dispatch and applied receipt per source effect, terminal_done after the third assistant_completion, and at least two Runtime incarnations. A bounded disposable acceptance task supplies this proof; long-running production Work need not terminate. Historical receipts before the active-release boundary never qualify. No component activation or manual live database repair. |

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
The consumer passes actual provider generation evidence through unchanged. A last
visible user role does not establish generation. A provider-idle user-only turn
with the exact applied effect marker and no unresolved successor may enter the
same missing-receipt observation as an idle text-only or invalid-receipt reply.
Production recovery waits for 30 continuous minutes of unchanged provider
activity/response evidence. A change restarts the existing durable observation
clock; Runtime ticks never reset it. Active generation, ambiguous target or an
unknown Send cannot authorize recovery merely because 30 minutes elapsed.
The existing effect ledger reserves one causal recovery per source, retaining
the two-resume chain ceiling and late valid receipt reconciliation. Explicit
provider failure can still recover earlier. No new scheduler, persistent state,
notification authority or provider is introduced; complete Runtime rollback
restores this behavior together with its code and configuration.

Historical owner-notification reconciliation uses the existing Runtime timer
at a 30-second maintenance cadence, beginning after the initial startup window.
It must not compete with readiness or causal delivery on every two-second pass.
A retained plugin receipt owns the notification outcome and any provider retry;
the observer never resubmits that request. A shared mailbox authorization blocker
contains the grant's stable identity, not the currently scanned task id, so old
tasks cannot repeatedly rewrite the same UserRequest presentation. This adds no
timer, durable cursor, notification queue or alternative authorization owner.
Parser rejection caches stay ephemeral and keyed by applied source plus response;
they never accept an invalid challenge, bypass a semantic terminal validator,
replay an unknown Send, or introduce persistence/schema/release changes.
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

An operator-STOPPED bootstrap may have written an entire machine-authored effect to a
Project composer without clicking Send. A subsequent bootstrap for that **same Project**
may replace the residue only if the canonical Supervisor ledger proves the prior task is
STOPPED, the prior effect has zero dispatch generations, and its last pre-Send failure
durably attests that exact, single visible editor (classification=current_effect,
send_clicked=false, matching full text length and SHA-256 fingerprint). The permitted editor payload must either match the canonical
immutable effect bytes exactly or match that persisted pre-Send observation's
full length and fingerprint exactly. This dual exact check handles a corrected
ProseMirror reader that no longer synthesizes layout newlines inside auto-linked
URLs, without ignoring any other whitespace or allowing arbitrary human edits.
New observations reconstruct text from the direct ProseMirror paragraphs' text
nodes rather than CSS-rendered layout text. The sole Chrome extension
rechecks the stopped effect marker and a fresh exact editor fingerprint immediately
before its prepare-only replacement. If ChatGPT hydrates this exact STOPPED-owned draft
after the first bootstrap snapshot, the same pinned Computer target may obtain
one fresh read-only observation following a `composer_not_empty` prepare refusal
and attempt exactly one guarded second **prepare**, still before any Send
generation. Unknown mutation, foreign text or missing precise evidence remain
blocked; no task, effect or provider is duplicated. This grants no replay or
new provider authority. Ambiguous/applied/possibly-sent effects, user or foreign drafts,
and a generating assistant always fail closed. A successful prepare still requires the
normal exact-effect Send and completion checks; never count typing as delivery.

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

Newly rendered Supervisor prompts use the typed outer automation metadata already
present on Forge tools: exact `automation_task_id`,
`automation_type=autonomous_continuation`, and `automation_status`. Intermediate
calls use `working`; the final Forge call for the turn uses `continue`, `done` or
`needs_user`. The provider-facing continuation is intentionally close to a
human "continue working" request: the model reads the previous result and
live project evidence, chooses useful actions and keeps executing while meaningful
authorized work remains. It does not prescribe an existing Work, checkout,
sequence or phase as a mandatory path, nor treat one successful check or tool
call as completion. Parallel user and autonomous efforts may share an outcome
without sharing a Work; models assess ownership and live source evidence,
while Forge enforces mechanical writer/resource boundaries at execution. The
prompt discourages repeated status-only rounds and requests actual results and
remaining gaps. This is model guidance, not a semantic scoring gate, new state
store or second Work/progress authority. An `automation:*` or `receipt:*` causal checkpoint
is retained in the durable completion ledger but omitted from model-facing
`continuity.summary`: it is a transport reference, not an engineering handoff.
Meaningful non-receipt checkpoints and recovery/correction reasons remain
bounded advisory context. No elapsed-time quota, forced operation count,
semantic scoring gate, extra state store, or new lifecycle authority is added.
Receipt processing still derives the exact source effect from the canonical
Supervisor task and reserves the successor transactionally; tool payloads do
not choose another task/effect/conversation. The historical
`rh_work repair` / `automation.receipt:*` parser remains a bounded migration reader
only for prompts already issued before cutover and must not be used by new prompt
producers or become a second replay authority.

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

## Chrome attachment continuity (20261015)

Computer owns browser/profile selection and tab attachments. The extension keeps
one random provider instance id in `chrome.storage.local`, scoped by Chrome to
that extension/profile. Worker suspension, extension reload and browser restart
therefore preserve profile identity. The id is removed on extension uninstall;
there is no task/effect state, credential, URL, or conversation content in this
cache. The existing Computer Controller authority remains the only durable
attachment writer. The extension owns only this constant-size transport identity,
requires the standard storage permission and grants no new host access. Discovery
and target-command heartbeats derive their source identity from this same
persisted profile id; a worker restart must not orphan discovery or change
the physical-tab binding. See the
[Chrome storage contract](https://developer.chrome.com/docs/extensions/reference/api/storage#storage_areas).

The native Browser primitive treats Runtime's process lookup as liveness
only. Desktop Operator exclusively establishes exact Chrome GUI PID and Tab ID
authority through ScriptingBridge and revalidates bundle/executable identity.
Independent headless Chrome roots may coexist; zero or multiple GUI roots fail
closed in Desktop Operator before Apple Events. Runtime must not re-implement
process selection by counting every pgrep match or fall back to another
provider.

A missing pinned profile stays unavailable even when another profile is the sole
live provider. Within the same profile, Chrome tab id takes precedence over
window id so moving a tab between windows preserves attachment. An existing pin
at another conversation URL is identity drift. Only a positive Chrome tab-missing
result permits recovery through complete exact-conversation inventory: reuse the
unique existing conversation tab, or reopen the persisted conversation URL when
absent. This preserves the existing disposable-resource restoration rule without
creating a new ChatGPT conversation. Ambiguous matches and unreadable inventory
remain unresolved; they do not authorize profile replacement or another tab.
Bootstrap recovery still requires the same live provider's positive missing-tab
proof and the existing Computer binding CAS.

Tab creation and conversation hydration are separate outcomes. An ensure failure
may return its exact physical attachment alongside the error. The existing
Computer surface lease stores that attachment before reporting failure; page
readiness and Send remain unavailable. A subsequent worker uses that binding
instead of creating another Project tab. Claimed commands without a result stay
unknown and cannot authorize provider fallback or another tab creation. The
optional failure binding is backward compatible; only updated extensions supply
it. No database schema, lifecycle, process, retry budget, external send, or second
writer is added. Existing leases, redacted receipts, task terminalization,
tombstone retention, backpressure and unknown-effect fences remain. Complete
Runtime release/rollback includes the adapter contract and matching extension.

Incident evidence: read-only Runtime calls on 2026-10-15 observed 188 historical
Supervisor tasks and zero active tasks; recent retrieved acceptance tasks were
terminal. That inventory is not evidence of current autonomous sends. Computer
reported 227 saved records, 221 unverified and six dead native records; metadata
is not proof of a live tab. Existing discovery stays observation-only and never
enrolls historical conversations. A source reproduction combined unavailable
content scripts with worker restart: the old code changed instance id, returned
no binding, and created two tabs for one bootstrap key. The candidate retained
one instance and returned the failed page's binding, keeping one tab and sending
nothing. A separate Controller probe verified failed-binding persistence, broker
restart reuse and no commands to a foreign profile. These are bounded adapter
facts; live release acceptance remains separate.

### Live Chrome content contract at Bootstrap

A projected Chrome extension on disk is not evidence that an existing Chrome tab has loaded the same content script. Before Supervisor consumes an exact, single-use authorization to back up and replace an unrelated Project composer draft, the actual pinned tab must attest `composerReplacementContract=exact-backed-up-project-draft-v1` in its read-only snapshot. An absent attestation is a task-local `COMPUTER_CHATGPT_BOOTSTRAP_LOADED_SCRIPT_STALE` pre-send failure, not permission to clear the editor, switch providers, create a replacement tab, or record Send. The Chrome background independently checks this exact-tab capability when preparing a guarded draft replacement. The original draft and one-use authorization remain intact when the loaded script is stale; after reloading the extension, the original unspent effect may be rearmed only within its existing bounded operator-retry contract. Projection checks and MCP health cannot substitute for this live evidence. Final release acceptance still requires independent actual multi-turn work to DONE.


### 2026-10-23 continuation context and execution granularity

Continuation resumes coherent implementation, verification and delivery within the
current model turn; CONTINUE is reserved for work that actually needs another
turn. Task reads restore missing or changed context rather than being mandatory
on every wake. This is advisory guidance, not an automatic progress gate.

The existing compact completion parser retains up to 2,000 characters of the
assistant text preceding the validated terminal receipt as its checkpoint. The
same completion journal supplies successor prompts, including crash reconciliation;
receipt-only replies remain causal references and are not displayed as progress.
Continuation prompts carry a current objective excerpt, bounded advisory checkpoints and correction reasons within 4,000
characters, preserving the immutable three-line identity header. Truncated excerpts
are marked. Live semantic/resource owners remain authoritative; checkpoint prose
cannot authorize effects or prove completion. No schema, process, retry policy,
writer, deployment topology or retention owner changes. Existing exact-conversation,
unknown-send and terminal validators remain in force. Whole-runtime activation and
rollback remain separate delivery decisions.


Work preparation replay preserves existing semantic phase and evidence. Only a
claimed preparation whose handle exists but whose Work has never dispatched may
finish its initial implementation activation after a crash. Replaying a completed
preparation reuses an identical scoped delegation and does not refresh validation
timestamps. The existing execution-session owner skips unchanged patches after
normal principal/instance validation. A changed policy, scope, invalidation or
controller instance still uses the existing validation and write path. Direct Edit
continues through its existing EditSession/Process owners without Work creation.
No schema, lease, authorization policy, semantic owner or retention changes.
