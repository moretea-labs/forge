# Forge 2.0 candidate certification

Accepted by the user on 2026-09-06. This is an authored implementation and
acceptance contract, not a second Runtime queue or completion authority.
Source work stays on `kernel-v2/architecture`. Codex native tools are the default
executor; installed Runtime effects stay with their existing platform owner.

## Predecessor reconciliation

The complete r15 acceptance criteria, decisions, boundaries and inherited
obligations remain binding except for the explicit changes below. Evidence
must be reconciled against current source rather than inferred from plan status.

| Predecessor obligation | Disposition | Successor location and rationale |
| --- | --- | --- |
| r15 D0d actual Recovery lock | KEEP | Implementation closure: mutual exclusion in both directions, cleanup on failure and exact live identity |
| r15 D0e managed Recovery upgrade | KEEP | Implementation closure: dedicated typed action using existing installer and whole-release rollback |
| r15 D0f live upgrade evidence | KEEP | Integrated certification: reconcile existing operation before admitting another upgrade |
| r15 D integrated certification, including all earlier lifecycle/portability obligations | KEEP | Integrated certification below; preserve every predecessor acceptance criterion |
| r15 E production baseline promotion/known-good attestation | DEFER | Beyond candidate-ready endpoint; requires a later release decision |
| Evaluation S1–S4 | KEEP | Verify current evaluator and fix demonstrated validity failures |
| Evaluation S5 freeze/A/A | CHANGE | Recalibrate changed evaluator; freeze release thresholds and engineering-task protocol separately before V2 measurements |
| Evaluation S6 previously non-blocking A/B | CHANGE | Required release-readiness evidence, with quality preceding efficiency |
| Post-V2 Workflow Runtime and publishing | DEFER | Remain dependent on later accepted production baseline/release |

No obligation is dropped. Reconciliation of remaining predecessor records must
preserve their individual acceptance criteria and dependency edges.

## Implementation closure

Reuse Goal/Plan/Work/ControllerRound/Process/Scheduler and Recovery authorities.
No new daemon, persistence authority, readiness lifecycle, facade tool or generic
host execution escape hatch is admitted. Context is advisory. Effects with unknown
outcomes require reconciliation, not replay. Persistent writers retain their
owner, single-writer fence, schema, terminal condition, retention and recovery rules.

Evaluation changes stay candidate-neutral in `evaluation/`. The evaluator owns
protocol validity and derived statistics; it cannot attest Runtime readiness.
Each experiment writes a fresh external output directory, preserves completed
samples on failure, never resumes by silently mixing artifacts, and never writes
candidate code or mutable Runtime records into the source repository. Calibration
summaries are authored evidence with separate digests, not implementation bytes.

## Integrated certification

- Bind source SHA, complete package digest, configuration, entrypoint, schema and
  backup compatibility to every final receipt. Rebuild/revalidate affected evidence
  after candidate changes. Do not activate incomplete slices as Stable Baseline.
- Prove a real three-step requirement through dependency wait, duplicate wake,
  Controller/MCP replacement, Runtime restart and semantic completion.
- Prove cancellation, contention, permission/provider failure and ambiguous-effect
  fencing; preserve user resources and clean only owned disposable resources.
- macOS and WSL each require clean-package install, upgrade, whole-release rollback,
  24-hour stability and at least 20 execution/recovery/cleanup cycles. Native Windows
  remains limited to its advertised preview capabilities. Missing remote evidence
  is not a pass.

## Evaluation acceptance

- Baseline: exact published v1.7.2 artifact from the existing freeze authority.
- Shared suite: 24 scenarios × 2 cache modes × 3 repetitions × 2 arms per platform.
  Both arms share an environment; every trial has fresh repository/Home/cache state.
- Engineering suite: two cross-file bug fixes, two features with failure paths,
  one compatible refactor and one interrupted multi-stage task; each repeats twice
  per arm and platform. Pin identical Codex model/reasoning/tool access, a 45-minute
  budget and 100 tool calls. Independent behavioral oracles judge final work.
- Quality: zero unresolved P0/P1, no confirmed candidate-introduced regression,
  no timeout/crash exclusion or unsupported completion claim.
- Performance: at most 10% core latency/attributable CPU/peak-memory regression;
  at least 15% paired end-to-end latency improvement in the preselected discovery
  and bounded-mutation subset, separately per platform. Use scenario-blocked 95%
  intervals; absent resource data and insufficient precision remain inconclusive.
- Allow one separately identified 10-repetition performance confirmation batch;
  never change metrics after viewing results. Engineering repeats remain two.

## Verification and delivery

Run focused checks first, then the repository architecture checks and `check:main`.
The final candidate additionally requires explicit `test:full`, `check:release`,
portable package/compatibility and live platform evidence. Avoid duplicate full
suites. Independently review the exact diff against these obligations. Commit and
push verified slices. Deliver package checksums, obligation/evidence mapping,
raw A/B data, platform reports, upgrade/rollback instructions and a truthful
Go/No-Go verdict. Publishing and production baseline promotion are excluded.
