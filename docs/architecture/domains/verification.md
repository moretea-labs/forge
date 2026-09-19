# Architecture Domain: Verification

> **Source**: `.ai/context/capabilities.json`
> **Owner**: Regression tests, workflow gates, eval harness, CodeGraph readiness, and advisory tooling checks.

## Purpose

Verification protects the contract from drifting across self-host, generated
repos, command facades, hooks, migration helpers, and installed runtime copies.

## Capabilities

- `verification-codegraph-readiness` -> `docs/architecture/modules/verification/codegraph-readiness.md`
- `verification-evals-checks` -> `docs/architecture/modules/verification/evals-checks.md`

## Stable Rules

- Self-host and generated behavior must be checked together when shared assets change.
- `bun test` is the broad regression gate.
- Governed tests preserve typed per-file failure evidence (`source`, `fixture`, `infrastructure`, `interrupted`) in bounded receipts; Check/Work verification may collapse that evidence only to the existing acceptance-vs-infrastructure authority, never by reparsing human stderr.
- The active Runtime always owns Process admission, leases, terminal Process state, and Work verification receipts. For ordinary repositories, persisted checks execute through that Runtime's immutable Check Runner.
- Self-hosting Forge Work verification is the bounded exception to runner location, not to lifecycle authority: when the verified repository has the same durable `repoId` as the Runtime Source authority, a non-live verification snapshot executes the Check Runner from that exact candidate snapshot. Candidate runner/content identity is folded into the existing Check execution fingerprint so evidence cannot cross runner revisions.
- A Work verification snapshot establishes its package dependency closure inside the existing Check Process before loading candidate Check Runner modules. Exact canonical `node_modules` reuse remains valid only when dependency metadata is equivalent; otherwise the disposable snapshot materializes dependencies from its own supported frozen lockfile. Bootstrap failure is infrastructure failure and never repository acceptance evidence.
- `live_controller_home` certification never uses the candidate snapshot runner because it is explicitly verifying the installed Runtime. A candidate snapshot missing its Forge-owned sidecar fails closed; no arbitrary executable override or second scheduler/store is introduced.
- Public `rh_work verify` accepts either one `check_id` or one non-empty `check_ids` batch, never both. A batch is admitted only when the registered checks form one ordinary resource-compatible wave according to Process Runtime `buildCheckExecutionSchedule`; invalid, cross-wave, release, and multi-phase batches fail closed before partial execution. Every admitted member still runs through the canonical Work verification service, Work snapshot, Process Runtime claims, Failure Contract, and VerificationRecord authority; batch aggregation is not a scheduler or lifecycle authority.
- Work verification persistence is one read-modify-write authority: any decision derived from current `checkRefs`, scope evidence, review state, or lifecycle state must read the latest Work and derive its patch inside the existing Work-store writer critical section. Synchronous writer contention remains fail-fast/retryable rather than sleeping on the Gateway path; a retry must re-read current state before deriving its mutation, so stale snapshots cannot silently erase compatible evidence.
- Legacy Work lifecycle inference is migration-only. The exact bounded historical shapes accepted by the compatibility migrator, including the pre-review-checkpoint schema-v3 row, are canonicalized and persisted once with revision-fenced Controller Home authority. Normal current-schema reads validate canonical state; malformed schema-v3 rows outside those historical shapes fail closed instead of receiving generic read-time repair.
- `check-task-sync.sh` enforces that substantive repo changes update `tasks/`.
- `check-task-workflow.sh --strict` is the repo-local harness readiness gate.
- `sync-brain-docs.sh --check` verifies manifest-controlled repo-to-brain mirrors without making gbrain or MCP part of hook correctness.
- External tooling probes remain read-only by default; CodeGraph readiness is required for agent code navigation, while other external tooling remains advisory.
- This self-host repo may use a vendored CodeGraph dev dependency; generated downstream repos keep global CodeGraph MCP setup explicit unless policy opts in.

## Verification Surface

- `bun test`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bash scripts/ensure-codegraph.sh --check --json`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`
