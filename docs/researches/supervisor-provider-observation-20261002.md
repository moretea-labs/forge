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
