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
- `live_controller_home` certification never uses the candidate snapshot runner because it is explicitly verifying the installed Runtime. A candidate snapshot missing its Forge-owned sidecar fails closed; no arbitrary executable override or second scheduler/store is introduced.
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
