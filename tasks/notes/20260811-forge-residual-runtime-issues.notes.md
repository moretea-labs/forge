# Forge residual runtime / execution issues (2026-08-11)

> **Status:** Final reconciliation record. Historical issues are closed unless this
> ledger explicitly says `operational follow-up`; do not reopen an item without a
> new reproduction and current Runtime evidence.
> **Scope:** Runtime/MCP execution, Recovery, Process/Lease, Direct maintenance,
> registry identity, generated contracts, and macOS Desktop Operator operations.
> **Safety:** This ledger is evidence, not lifecycle authority. Runtime release
> mutation remains fail-closed and unique uncommitted source changes are never
> maintenance-cleaned. `auth/` is unrelated untracked local state and remains
> untouched and ignored as local authentication state.

## Production baseline and live evidence

- Code baseline: `e79896a2` (`fix(plugins): fail closed after stale provider validation`), containing the earlier residual closeout commits `3f2d9cbb`, `b456019d`, `cd049225`, `3046820d`, `5c881848`, and `3a991e1a`.
- Canonical Runtime: `1786427833613-e79896a2ace5bfff72ae37a905f2d34677148664`, artifact `sha256:2639e1ffa9112f290d2c37042cc920a49fa6c8f0ccebe092abce169051b0de23`.
- Recovery: `1786427972869-e79896a2ace5bfff72ae37a905f2d34677148664`; Gateway and Watchdog were cleanly handed over, with the prior complete Recovery release retained.
- Live acceptance after activation: Runtime/release authority coherent and ready; Recovery verify passed; public MCP initialize/notification/close passed; `tools/list` returned exactly **19** tools with fingerprint `682741764164c5fa79681055bc2ef0d65fb6abb67cfa2855a5be6ccb14059745`; the bounded read-only call passed.

## Resolved / do not reopen without regression evidence

### Recovery Watchdog degraded diagnostics

- The real intermittent failure is a bounded public `mcp_tools_list` deadline (`RECOVERY_HTTP_TIMEOUT`), followed by the dependent read-only-call failure. It is public ingress/MCP, not a local Runtime, Recovery Gateway, or tunnel failure.
- `watchdog-diagnostics.json` now keeps at most 32 release-scoped, deduplicated records with failed-probe component attribution (`runtime`, `gateway`, `public_mcp`, `recovery_gateway`, `recovery_tunnel`) before audit emission. Release-scoped restart budget and `recovery_exhausted` semantics were not changed.
- Observation included one failed full verification followed by a successful full verification. The current watchdog decision is healthy; no rollback, restart storm, or PID churn occurred during the final Runtime/Recovery activation. Historical restart counters are retained as evidence and are not reset by a Recovery release handoff.

### Resource claims and ordinary source writes

- Typed host/system/browser/plugin/repository readonly actions carry host/read claims rather than workspace/Git write claims. Real multi-repository and same-repository/different-checkout acceptance had success rate 1 and contention rate 0; same-checkout write contention remains intentionally exclusive.
- `5c881848` routes an explicit ephemeral non-Git source workspace write through the existing bounded direct executor. It no longer mints a Runtime-fenced Process lease or Git snapshot. Runtime activation/release mutation remains fail-closed; unknown shell, Python, and Node remain conservative managed operations.

### Process index and latency experiment

- Normal Process create/terminal recovery index updates are incremental (`O(1)`/`O(active)`); authoritative Process records remain the only authority. A full rebuild is retained solely for missing/corrupt-index crash recovery.
- The uncommitted single-`ps` experiment was reviewed, passed 65 focused tests plus typecheck, then was rejected: clean same-machine A/B was not attributable (baseline/candidate/repeated baseline process-start p50: 102.49/184.19/225.50 ms). Its changes were reverted and must not be revived without controlled evidence.
- Cold Git observation is an accepted fixed OS/Git cost, not a reason to add a cache layer. Latest cold/warm context p50: 15.90/0.12 ms.

### Direct Edit maintenance lifecycle

- Committed exact-after-image Direct sessions reconcile to completed; mismatches supersede; unique uncommitted source remains dirty and untouched. Cleanup is idempotent.
- Earlier reconciliation moved 15 dirty plus 6 empty-open sessions to zero. A final full maintenance pass found and reconciled a separate 32 historical contract-free Direct metadata records; the post-pass status is again **0 stale Edit Sessions** and no safe/actionable candidates. All **163** ownership-unproven temp entries remain explicitly retained rather than guessed/deleted.

### External provider validation reuse

- `285e3e0e` is in the active Runtime ancestry. Two real active-Runtime `desktop_operator/desktop_status` actions in one MCP session both returned 200 without RPC errors.
- The only live proof cache is the existing bounded 5-second manifest item cache. Integration evidence is `manifest, health, execute, execute`; after cache invalidation and provider version drift it performs manifest validation and rejects with `EXTERNAL_PLUGIN_VERSION_MISMATCH`. A degraded/unprobed manifest is no longer incorrectly treated as provider-identity-prevalidated.

### Registry, MCP surface, and generated contracts

- Registry identity is correct: stable `repo_123b7cf58b6b17b5cbe46a56` is `/Users/greyson/DevProjects/forge`, remote/GitHub `moretea-labs/matea`. Forge is the product/package name and `matea` the repository/historical source name; plugin and Issue routing agree. No remap is required.
- Tool discovery/invocation coherence is closed at the 19-tool default surface above. Do not reopen old legacy-schema reports without a current discovery/invoke mismatch.
- The test budget remains **42200** (no baseline increase); redundant tests were removed instead. Self-host strict workflow advisory is expected: `.ai/harness/workflow-contract.json` is a generated downstream runtime artifact, while `assets/workflow-contract.v1.json` is the tracked source contract. It is documented, not an unknown missing-contract blocker.

### Requirement / Issue / Task authority

- The SQLite Requirement Board is the only current authority: 11 requirements (5 active, 3 planned, 3 done), zero Execution Queue entries, and zero completion-backlog or stuck-state findings. The active/planned Apple, physical-iOS, user-Chrome, experiment, and broader recovery outcomes are separate product work and were not falsely closed by this Runtime closeout.
- The old Route Integrity maintenance text is superseded by the exact-HEAD benchmark and acceptance in this ledger, but its frozen legacy Issue/Task adapter cannot mutate it after SQLite cutover. No semantic duplicate Runtime Issue/Task was created; this ledger is the durable evidence pointer.

## Latest measured benchmark (7 iterations, 2026-08-11T06:00Z)

| Scenario | p50 / p95 |
| --- | --- |
| Cold / warm context read | 15.90 / 26.76 ms; 0.12 / 0.13 ms |
| Readonly Direct / Direct edit claim | 1.83 / 14.17 ms; 11.19 / 13.41 ms |
| Durable Process submit | 39.45 / 49.91 ms |
| Known-long handle return | 36.64 / 48.52 ms |
| Tiny Process start / focused check | 86.75 / 101.06 ms; 82.80 / 105.55 ms |
| Multi-repo / same-repo different checkout | 196.75 / 262.42 ms; 202.99 / 313.98 ms |
| Check coalesce/reuse | 445.18 / 476.67 ms; 7 coalesced, 7 cache hits, 7 cross-checkout reuses, 14 physical / 28 logical |

The remaining Process cost is OS spawn/tool work, and the intentional same-checkout conflict has a 1.0 contention rate. There is no measured false Lease contention or justified new caching/coordination layer.

## Operational follow-up (P2; no correctness debt)

- **macOS Automation historical grants:** UI audit found the stable signed `Forge Desktop Operator` grant enabled only for Chrome and Vivaldi; preserve it. Historical `bash → Terminal`, `bootstrap → System Events/Chrome/Vivaldi`, `bun`, `repo-harness.js`, and multiple `forge-runtime` principals remain visible. Cleanup must be selector-bound in System Settings with readback; never edit TCC DB or run `tccutil reset`. Toggling these macOS security permissions requires the user's action-time confirmation.

## Active remediation: live schema authority and Recovery probe (2026-08-11)

- The active Canonical Runtime is the schema authority for every Gateway HTTP
  MCP session: initialize reads its `tools/list`, session calls re-check its
  fingerprint, and a tool name not in the initialized Runtime schema receives a
  recoverable reinitialize response. Gateway status files and
  `mcp.runtime.json` remain lifecycle diagnostics only.
- Connector freshness now treats unavailable live discovery as unverified, not
  as a healthy or callable schema. The local controller snapshot likewise does
  not infer Connector health from persisted server metadata.
- Standalone Recovery normalizes both retired probes (`controller_context` and
  `controller_ready`) to bounded `repository_list {}`. Configuration reads are
  non-mutating; the next authorized configuration write persists the migration.
  Immutable Runtime restart-budget and rollback behavior remain unchanged.
- Source verification passed: TypeScript check plus 79 focused MCP-session,
  HTTP, capability-recovery, and standalone-Recovery tests. Formal immutable
  Runtime/Recovery activation and live acceptance are the remaining steps for
  this remediation.

## Final debt classification

- P0: none known.
- P1: none known.
- P2: one user-confirmed operational Automation cleanup only; it is not a Runtime correctness/reliability blocker.
