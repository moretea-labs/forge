# Runtime performance diagnostics

Forge exposes a read-only runtime_performance_diagnostics MCP tool for host-level performance inspection.

It is intended for questions such as:

- Why is Forge using CPU while the queue is empty?
- Are there orphan job-worker processes?
- Is the Local Controller actually running even if persisted runtime state is stale?
- Which temporary Forge directories are stale cleanup candidates?

The tool returns controller queue state, bounded Forge process samples, orphan worker detection, Local Controller process inference, temporary directory accumulation, and a no-side-effect cleanup preview.

The cleanup preview is intentionally non-destructive. Terminating processes or deleting temporary directories must remain a separate explicit operation.

## Quality Harness benchmark evidence

`bun run check:quality-harness` runs `scripts/benchmark-quality-harness.ts` on an isolated temporary Git repository. It checks cache correctness and latency, a successful physical `git status` invocation, and the lightweight Process lane. Empty optional structural timing samples are reported as `null`, never invented as `0 ms`; a missing required pre-spawn sample fails the check.

`durableProcessWrites` and `leaseOperations` are **runtime-reported** execution metrics collected per invocation, not independently instrumented physical-write/lease counters. `durableProcessRecordsObserved` is a separate read of the canonical managed Process store for each returned lightweight process ID. `persistedHandleIndexEntriesObserved` independently reads the existing SQLite handle-index projection and **must equal the number of commands**, because lightweight commands do persist handles even though they do not create managed Process records. Neither metric claims zero total filesystem/SQLite writes or measures write frequency. No result may be presented as proof of zero underlying operations beyond the evidence each observer covers. The benchmark is an internal diagnostic gate, **not** a cross-version superiority verdict; formal comparisons remain under `evaluation/` with frozen candidate and environment identities.

The governed `check:main` candidate gate now runs `check:quality-harness` after the reusable task receipt; normal `check:task`/inner-loop checks do **not** run it. The `check:release` gate inherits the main result rather than creating another Benchmark authority. The threshold is an in-version diagnostic guard, not an A/B superiority conclusion.
