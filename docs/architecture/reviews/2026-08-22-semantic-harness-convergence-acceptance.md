# Semantic harness convergence acceptance — 2026-08-22

## Scope

This is the S4 exact-main acceptance record for `PLAN-FORGE-SEMANTIC-HARNESS-CONVERGENCE-20260821-V3R2`. The evaluation snapshot is `f69ad7d1282a8de2335ffe12adb2e54f01fd1b10`, the S3-integrated main revision.

## Explicit evaluation ground truth

The isolated evaluation catalog now has dedicated scenarios for:

- semantic context plus root-to-nearest `AGENTS.md` / `CLAUDE.md` instruction recognition;
- Scale coordination through approved Plan steps and independent bounded Work;
- Direct/Lightweight execution with zero durable lifecycle side effects on the fast path.

Each scenario freezes intended behavior, affected domains, invariants, regression risks, an immutable Git snapshot, and an executable focused validator. These scenarios do not create a second runtime or semantic authority.

## Performance acceptance

The Plan references the controller-recorded `03121020` baseline. That identifier is not stored as a repository artifact, so this repository record does not invent missing historical sample values. The durable comparison point available from the Plan is the historical 4–5 second public-gateway spike that motivated S3. Current exact-main measurements are materially below that failure mode:

| Path | Current evidence | Acceptance |
| --- | ---: | --- |
| MCP file-read facade | p50 0.8 ms, p95 15.4 ms | no multi-second gateway tax |
| MCP bounded readonly commands | p50 24.9–28.5 ms, p95 27.2–36.7 ms | no multi-second gateway tax |
| MCP async Process handle admission | p50 13.9 ms, p95 14.4 ms | bounded and zero legacy Job/Worker side effects |
| Context steady cold | p50 11.96 ms, p95 12.14 ms | stable after startup |
| Context hot | p50 0.85 ms, p95 0.93 ms | session cache reuse proven |
| Context startup cold | 221.79 ms | isolated startup cost, not steady-state |
| Lightweight pre-spawn harness | p95 15 ms | zero durable Process writes and zero Lease operations |

The gateway benchmark separately attributes classification and routing at approximately 0 ms; observed command time is in the concrete operation. The historical 4–5 second spike was not reproduced.

### Concurrent semantic admission tail

The 32-controller admission stress test remains semantically correct: one shared Requirement resolves to one authority, while 32 independent Requirements resolve to 32 authorities. Holder CPU p95 remains bounded (about 4 ms shared and 9 ms independent in the latest exact-main-aligned run), while wall-clock holder p95 can rise under simultaneous 32-process host scheduling. That divergence is attributed to OS scheduling/preemption rather than additional canonical persistence CPU. The correctness race discovered during S3 (`LOCK_OWNERSHIP_MISMATCH`) was repaired by identity-checked stale-lock reaping, with regression coverage. The benchmark deliberately keeps the wall-clock 10 ms assertion visible rather than hiding host-scheduling variance.

## Architecture outcome

The final contract remains: ChatGPT owns semantic judgement; Forge owns deterministic repository/runtime mechanisms; Plan/Work are the semantic lifecycle authorities; Scale coordinates existing authorities; Direct/Lightweight paths avoid unnecessary durable machinery; `rh_context` returns bounded source and applicable guidance evidence without turning guidance into scope authority.
