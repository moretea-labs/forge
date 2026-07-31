---
id: "ISS-20260730-CCF211"
kind: "investigation"
status: "planned"
updated_at: "2026-07-31T00:04:56.058Z"
source: "repo-harness-controller-v8"
---

# Validate a bounded bug-reduction Shadow mechanism

Result Goal 4 of ISS-20260730-AE1BCC. Empirically validate a bounded bug-reduction Shadow mechanism. Launch blocked until RC6 is terminal and the execution-evidence foundation, relevant Apple context foundation, and Core/Advanced/Full callability E2E are complete. No Shadow result may block production before predeclared promotion gates pass.

## Goals

- Define bounded risk signals and verification packs for persistence, migration, retry/idempotency, uncertainty, contradictory evidence, and residual risk.
- Add low-cost Risk Probe and selectively invoked Challenge review without making either an autonomous blocker.
- Run Baseline, Equal-budget Review, and Mechanism experiments with predeclared metrics and stop conditions.
- Promote only mechanisms that improve actionable early findings without unacceptable latency, false positives, or Harness self-failure.

## Non-goals

- Do not claim bugs can be eliminated or require exhaustive testing.
- Do not run a heavy multi-agent review on every task.
- Do not let Challenge output alone reject or finalize work.
- Do not enable production blocking gates before Shadow evidence meets declared thresholds.
- Do not begin this Issue while foundational reliability Issues remain incomplete.

## Acceptance Criteria

- [ ] Risk signals and verification packs are bounded, deterministic where possible, and connected to actual task/evidence/context state.
- [ ] The mechanism records Finding type, evidence, affected acceptance criterion, actionability, disposition, and whether it was found earlier than baseline.
- [ ] Experiments compare Baseline, Equal-budget Review, and Mechanism under matched task/budget conditions.
- [ ] Reported metrics include precision, actionable rate, early-detection rate, escaped-defect rate where measurable, latency/cost overhead, and Harness self-failure rate.
- [ ] False positives, duplicated findings, contradictory probes, and infrastructure failures are separated from product defects.
- [ ] No blocking gate is enabled unless predeclared precision, actionability, overhead, and stability thresholds pass across representative task classes.
- [ ] A failed experiment leaves the existing execution path unchanged and produces a reusable evidence report.

## GitHub

- Not published.

## Tasks

### T1 — Freeze experiment questions, corpus, metrics, and stop conditions

- Status: `blocked`
- Objective: After the three foundational result Issues are stable, select representative historical and new tasks; define matched budgets, baseline conditions, finding taxonomy, metrics, promotion thresholds, rollback, and stop conditions before implementing the mechanism.
- Depends on: none
- Allowed paths: `docs/**`, `tests/fixtures/**`, `benchmarks/**`
- Checks: `typecheck`
- Execution hint: selected at runtime

### T2 — Implement verification packs and finding persistence

- Status: `planned`
- Objective: Add bounded verification packs for persistence, migration, retry/idempotency, uncertainty, contradictory evidence, and residual risk; persist structured findings with evidence links, disposition, and deduplication/idempotency.
- Depends on: `T1`
- Allowed paths: `src/runtime/**`, `src/plugins/**`, `tests/**`, `benchmarks/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T3 — Add bounded Risk Probe and selective Challenge review

- Status: `planned`
- Objective: Introduce a cheap Risk Probe that selects relevant verification packs and a separately budgeted Challenge review invoked only for high-uncertainty/high-impact cases; neither may be the sole completion authority.
- Depends on: `T2`
- Allowed paths: `src/runtime/**`, `tests/**`, `benchmarks/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T4 — Instrument Shadow execution and matched-budget controls

- Status: `planned`
- Objective: Run the mechanism without changing task outcomes; add Baseline, Equal-budget Review, and Mechanism assignment, timing/cost capture, finding lifecycle, fallback, and Harness self-failure telemetry.
- Depends on: `T3`
- Allowed paths: `src/runtime/**`, `scripts/**`, `tests/**`, `benchmarks/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T5 — Run the experiment and classify every finding

- Status: `planned`
- Objective: Execute the predeclared corpus and representative live Shadow tasks; independently classify findings as true/false, actionable/non-actionable, earlier/not-earlier, duplicate/novel, and product/Harness/infrastructure.
- Depends on: `T4`
- Allowed paths: `benchmarks/**`, `tests/**`, `docs/**`, `artifacts/**`
- Checks: `test`, `ci`
- Execution hint: selected at runtime

### T6 — Decide promotion, revision, or rejection of the mechanism

- Status: `planned`
- Objective: Compare results with predeclared gates; either promote a narrowly scoped gate, continue Shadow with revised hypotheses, or reject/remove the mechanism. Record exact scope, rollback, and remaining uncertainty.
- Depends on: `T5`
- Allowed paths: `docs/**`, `src/runtime/**`, `tests/**`, `scripts/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260730-AE1BCC`
- `ISS-20260730-A1EA53 (must be complete)`
- `ISS-20260730-84CE88 (context evidence dependency)`
- `ISS-20260730-B55445 (tool-callability and Shadow infrastructure dependency)`
- `ISS-20260729-BF2F89`
- `docs/architecture/RELIABILITY-PROGRAM.md`
