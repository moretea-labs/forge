# Implementation Notes: 20260801-round2-performance-reliability-runtime

> **Status**: Active
> **Plan**: plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md
> **Contract**: tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md
> **Review**: tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md
> **Last Updated**: 2026-08-01 20:53
> **Lifecycle**: notes

## Design Decisions

- Supervisor release publication now normalizes same-revision external worktrees to the authoritative runtime source root and preflights duplicate daemons from the active owner epoch while preserving the adopted daemon PID.
- Controller context projections are keyed by source identity plus variant/toolset/profile. Legacy `controller-context.json` remains read-compatible; new Summary/Detail records are independent and refresh through an in-process single-flight with persisted owner, attempt, failure and backoff metadata.
- Summary responses and persisted Summary projection payloads are compact projection reads and stale-while-revalidate; Detail remains a bounded live build. `responseMeta` and the round-two benchmark report phase, routing and byte cost.
- Scheduler idle source scans are safety-bounded instead of per-tick; Process Runtime owns and clears its log poller with the monitor; session caches have LRU/TTL bounds and session-close cleanup.

## Deviations From Plan Or Spec

- The external Recovery Tailscale MCP endpoint remained unreachable after local recovery; evidence is recorded as unavailable and no external success is claimed.
- The captured harness contract was generated with placeholder gates; it was corrected to the actual round-two files and checks rather than restoring deleted tests or fabricating `docs/spec.md`.
- The documented `bun run check:task` gate was missing from this checkout's `package.json`; the alias and project-init template injection were added to route to the existing strict workflow check. `bun run check:task` now passes, with only the existing read-only bootstrap advisories for ignored generated runtime files.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Legacy single JSON projection | Keep as sole authoritative cache | Preserves compatibility while keyed files prevent variant/repository pollution. |
| Per-tick idle source scan | Bounded safety rescan plus persisted heartbeat | `fs.watch`/wake signals remain fast-path; idle scan cost is observable and bounded. |
| Unbounded process/session resources | Explicit lifecycle and LRU/TTL cleanup | Prevents terminal pollers and closed-session caches from accumulating. |

## Open Questions

- Formal external endpoint measurement is still unavailable and must remain separately marked in follow-up performance runs.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Benchmark: `scripts/benchmark-controller-round2.ts`
- Round-two tests: `tests/runtime/controller-context-projection-round2.test.ts`, `tests/runtime/mcp-e2e-round2.test.ts`, `tests/runtime/process-runtime-round2.test.ts`, `tests/cli/session-cache-round2.test.ts`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
