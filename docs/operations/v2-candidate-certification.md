# Forge V2 release candidate certification (current evidence)

This report is the authored evidence index for the current Forge V2 release candidate under `PLAN-forge-v2-release-certification-20260910-r8` revision 9. Controller Home remains the runtime/process receipt authority, and the frozen cross-version files under `evaluation/` remain the benchmark protocol authority. This document records evidence; it does not create a second release, lifecycle, or benchmark authority.

Older candidate revisions and the superseded `plans/plan-20260906-v2-release-ready.md` evidence are historical only after the current Plan refroze S7 on the exact source below. `evaluation/lib/certification.ts` remains a stricter machine-checkable full-evidence evaluator; it deliberately fails closed on an inconclusive A/B manifest. It is not silently reinterpreted here as a passing result, and it does not replace the current r8 Plan's explicit S7-S10 release acceptance authority.

## Current candidate identity

- Source revision: `d7537a19e87f43574ce57222af81ec9c9ecd767a`
- Active immutable Runtime release: `1789285905610-d7537a19e87f43574ce57222af81ec9c9ecd767a`
- Runtime artifact identity: `sha256:c4fa5b3fd7c9ffe30f993459459da2a0727d8f161de8b74a0d61827d45438625`
- Runtime instance observed during certification: `runtime_93d898d7bf684c5194c4403431b7b5c0`
- Stable MCP surface: 19 tools, with the frozen compatibility gate passing on this exact candidate.

S7 reran `package:test:full`, `package:check:mcp-compatibility`, `package:check:portable-package`, and `package:check:release` from the beginning on the exact source, then activated the immutable Runtime through Recovery and passed the live `package:check:stable-baseline`. Earlier candidate receipts are not reused as final S7 evidence after source drift.

## Automatic progression evidence

S8 proved the live V2 controller progression contract on the certified candidate:

- A → B → C advanced without a user `继续` message;
- a same-principal transport/session rollover was reclaimed without changing semantic authority;
- a recoverable provider path preserved authority;
- duplicate handoff attempts were suppressed;
- A and B ended `handed_off`, C and the recovery round ended `goal_complete`;
- all canary Work records ended completed; and
- `package:check:runtime-architecture` passed after the canary.

This is the current release evidence for automatic eligible-round progression. It does not remove explicit human boundaries such as `wait_for_user`, strong confirmation, authentication, or ambiguous external-effect judgement. Repeated multi-hour/multi-day Schedule wake operation remains a post-V2 roadmap target rather than evidence claimed by this release.

## Formal frozen v1.7.2 vs V2 A/B

S9 ran the frozen cross-version evaluator without changing the immutable V2 product source or the frozen protocol. The S9 Work completed as `completed_no_change` because its Contract intentionally forbade commit/merge; Controller Home retains the process, edit-session/report, review, verification, and completion receipts, while S10 reconciles this authored report into canonical documentation.

### Frozen authority and identities

- Formal protocol digest: `sha256:b383b97aacc5995ba69525d1aac5f031046c8708db3c32011e484444818d2700`
- Environment fingerprint: `sha256:8539cc92fdae3510d7f9342f50f7ef835fb83aec09cb95969e6b4f305a807383`
- Baseline candidate: `forge-v1.7.2`
- Baseline source revision: `c873cfeb11a223ced342e7101c016261b4a93b38`
- Reconstructed baseline artifact: `sha256:1a0bb50ad97c414f4c553ef790b29c8786a76d0f6ca29e04bbd9fed3bb46d43e`
- Baseline reconstruction digest: `sha256:d9a0a99a5bf7eeccdbaf2f186bceeaf8a29b33400e8ac6d9c21edfb1d0d0fc3b`
- V2 candidate label: `forge-v2-d7537a19`
- Formal runner process: `proc_mtzkspwm_d2a37a3b`
- Formal output directory at execution time: `/tmp/forge-v2-s9-formal-ab-d7537a19-r2`
- `statistics.json` digest: `sha256:4daa138fa65317f4769f8e8fd4c2a49fd9bfac67ba6e58e7259562b29aa6b248`
- Paired sample count: 144 across 24 scenarios.
- S9 completion receipt: `REC-controller_work-8591623708853b61`.

### Correctness and reliability first

The measured blocking correctness signal did not regress:

- `task_correctness`: baseline mean `1.0`, V2 mean `1.0`;
- directional regression count: `0`;
- newly introduced candidate failures: `0`;
- newly introduced candidate timeouts: `0`;
- 95% confidence interval for the absolute task-correctness delta: `[0, 0]` across 24 scenario-level samples.

The formal runner exited non-zero because the aggregate verdict was not eligible for a complete superiority claim, not because the V2 candidate failed a scenario. The evaluator verdict is exactly `inconclusive_missing_metrics`, with `blockingMetricIds=[]`, `newlyIntroducedFailureCount=0`, and `newlyIntroducedTimeoutCount=0`.

### Measured efficiency and performance

Measured non-blocking tiers do not establish a V2 superiority claim:

- `tool_interaction_count`: identical baseline/V2 mean `1.5416666667`; 95% CI for the absolute delta `[0, 0]`.
- `latency_ms`: baseline mean `341.0225 ms`, V2 mean `357.0181 ms`, absolute mean delta `+15.9956 ms`; 95% CI `[-6.4918, 38.4831] ms`, which crosses zero. This is not evidence of a statistically established aggregate regression or improvement under the frozen evaluator.
- `peak_rss_bytes`: baseline mean `47,676,529.78`, V2 mean `47,678,805.33`, absolute mean delta `+2,275.56` bytes; 95% CI `[-22,704.72, 27,255.83]` bytes, also crossing zero.
- `cpu_ms`: both means `0.2778 ms`; the absolute-delta 95% CI crosses zero.

The evaluator marked the efficiency and performance tiers `passed`, while correctness/reliability remained informational with no blocking regression.

### Unmeasured execution-quality metrics

The formal corpus did not emit enough data to measure four declared metrics:

- `behavioral_invariant_success`: 288/288 trial values missing;
- `change_precision`: 216/288 trial values missing;
- `impact_coverage`: 288/288 trial values missing;
- `regression_reintroduction_rate`: 288/288 trial values missing.

These gaps are the reason the aggregate verdict remains `inconclusive_missing_metrics`. They must not be rewritten as passing evidence, and the current A/B does not support a claim that V2 is globally superior to v1.7.2. Under the current r8 release Plan, S9's obligation is to run the frozen comparison and record the result, uncertainty, failures/timeouts, and interpretation boundary honestly; it is not an authority to mutate V2 product source until a favorable benchmark appears.

## Current release interpretation

Current evidence supports these bounded statements only:

1. the exact `d7537a19...` V2 candidate passed the current S7 release and live Stable Baseline gates;
2. automatic A → B → C eligible progression was proven live without user continuation, including bounded recovery behavior;
3. the formal frozen v1.7.2 vs V2 comparison introduced no measured correctness failure or timeout and no blocking correctness regression;
4. measured efficiency/performance did not produce a blocking aggregate regression, but the latency confidence interval also does not justify a superiority claim; and
5. the cross-version benchmark is statistically incomplete for four execution-quality metrics, so its overall verdict remains inconclusive.

S9 is semantically accepted by the current release Plan with the above interpretation boundary intact. S10 owns lifecycle/document reconciliation only; public version bump, tag, package publication, and final release re-certification are later release effects and are not implied by this candidate report.
