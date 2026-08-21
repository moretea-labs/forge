# Harness convergence evidence — bounded execution and progressive context

Date: 2026-08-20 to 2026-08-21

Status: evidence/history only. Current architecture authority is `docs/architecture/CURRENT.md`.

## Goal

Reduce Forge fixed overhead and duplicate authority while preserving the behavior that matters to a semantic controller:

```text
understand -> retrieve/explore -> implement -> verify -> review impact
```

The convergence targeted context retrieval, command execution lanes, Work/Plan admission, process attachment, legacy harness ceremony, and measurable regression evidence. It explicitly avoided creating another scheduler, recovery owner, semantic database, or autonomous-agent lifecycle.

## Decisions that survived review

- Current raw repository source remains authoritative. `rh_context` can cache/reuse lexical, range, structural, and compiler-semantic work, but retrieval coverage is evidence rather than a frozen scope contract.
- Ordinary local work uses Ephemeral Direct. A command that outlives the interactive window may expose a Lightweight Managed handle; active lightweight state is intentionally Runtime-memory state, not SQLite/Lease/recovery membership.
- Durable Work/Process is reserved for real continuity, independent deliverables, scheduling, release/recovery, or multi-controller coordination.
- Process attachment never reconstructs a missing result by re-executing the original command.
- Work is an orchestration/continuity mechanism, not a complexity or coding-quality score. Plan remains optional intent/coordination state.
- Old assistant, personal-assistant, goal/portfolio/finding, heartbeat/maintenance-triage, trace-grade, and duplicated project-level workflow authorities are retired from the current path.
- Legacy migration catalogs may retain retired generated-file names only so old projects can remove known generated artifacts safely; those names are not live execution authority.
- Tests and review artifacts remain verification/impact evidence, not parser-owned completion authorities.
- External and non-idempotent effects retain explicit policy, authorization, receipt, and ambiguous-outcome boundaries.

## Integrated commits

- `7f699b0d` — Kernel authority deletion and verification-snapshot correctness.
- `61ea8971` — thin execution lanes, process attach semantics, context/Git hot-path convergence.
- `029e0e91` — isolated evaluation framework.
- `3840435e` — legacy harness/workflow authority retirement.
- `7848f5f1` — readonly fast-path and test-governance coverage.

## Verification evidence

- Kernel candidate: TypeScript passed; runtime architecture contract 37/37 passed; test governance passed.
- Runtime/controller candidate: TypeScript passed; MCP compatibility reported the stable 19-tool surface with no collisions; scheduling 4/4 passed; direct regressions passed after one stale assertion was updated to the compact managed-handle contract.
- Evaluation framework: 3/3 tests passed; it executes in an isolated clone, rejects report output inside the source repository, and requires positive/negative ground truth for changed-path validation.
- Harness/workflow candidate: bootstrap 16/16; strict task-workflow check passed; focused hook/workflow/scaffold/contract regressions 147/147.
- Test governance: current manifest validates 122 test files; readonly/governance/browser handoff focused tests 7/7.
- Public documentation check passed again after the final documentation correction.

## Measured/observed architecture effects

- Default Controller MCP remains a stable 19-tool surface.
- Ordinary commands can remain outside durable Process/Lease/recovery state.
- A readonly repository command remains available even with more than 200 dirty paths and does not require write-path fingerprints.
- The legacy harness convergence commit removed 4,398 lines while adding 323, including complete removal of heartbeat-triage, maintenance-triage, and harness-trace-grade current execution surfaces.
- The evaluation framework provides an isolated scenario/trace/validator/report path for future before/after architecture measurements.

## Residual risks

- Explicit `toolset=full` still carries supported legacy compatibility definitions.
- Some large modules remain mixed-responsibility; split them only when a real ownership boundary and validation target exist.
- CodeGraph can be structurally stale; changed raw source stays authoritative.
- Lightweight running-state continuity ends with the current Runtime lifetime by design; a requirement for crash-durable ordinary commands would need a deliberate product decision rather than accidental promotion.

No Runtime activation, remote publication, or release is implied by this evidence record.
