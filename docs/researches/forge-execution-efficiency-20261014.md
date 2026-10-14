# Forge execution efficiency investigation, 2026-10-14

The objective remains Computer responsiveness and the wider Forge execution workflow. These measurements do not establish that all efficiency defects are resolved.

## Current evidence

- The observed installed Runtime was release `1791968531522-c8ea73e53af95a6214b3066689ed132bd2b34296`. Current source changes must not be reported as installed behavior without a separate reviewed release transaction.
- Four live MCP Finder observations took 547–2,850ms on the server and 2,498–4,387ms including connector transport. Three direct native-provider observations of the same application session took 7–24ms. This localizes substantial overhead outside the native observation, but does not yet identify a single cause for the slowest requests.
- The repaired Computer hot-path benchmark uses the advertised `computer.observe.v1` / `computer_execute` protocol. With 50 samples, warm dispatch p50 was 2.5ms and p95 11.1ms, with exactly one observe RPC per action and no warm handshakes, manifest/status probes, or connection creation. This isolated fixture measures dispatch, not native UI or remote transport latency.
- A local authenticated MCP status sample (five calls) measured client p50 7.8ms / p95 18.0ms and server p50 5.8ms / p95 13.9ms. Local transport overhead is therefore different from the remote connector observations above.
- The existing thin-harness MCP benchmark reported all acceptance fields true: fast paths created no ExecutionJobs, LocalJobs, workers, scheduler wakes, or projection invalidations.
- The legacy Work-efficiency benchmark failed before physical execution because it assumed `rh_work start` creates a worktree and used retired `verify`, `continue`, `finalize`, and `work_complete` operations. Its script and package entry were retired: comparing a removed lifecycle does not measure the current product. The existing thin-harness MCP benchmark remains the maintained execution-overhead measurement; current Work delivery acceptance still requires the canonical repository capabilities. No production compatibility APIs were restored.

## Plugin failure evidence

A live target-open attempt failed before dispatch with `PLUGIN_RESOURCE_CONTENTION`. The previous managed-process projection returned only `PLUGIN_ACTION_FAILED`; its failure receipt omitted retry disposition and blocker details. The initial contention's owner was not recoverable from that historical receipt, so its cause remains unknown.

The correction retains the existing plugin receipt/request index as the only effect authority. A failed sidecar with a settled receipt reattaches through the existing store, which validates argument identity, scope and Work attribution. MCP projects a known failed receipt as an error with its original code, retry disposition and redacted bounded diagnostics. Success and outcome-unknown receipts retain their canonical meaning across sidecar exit failure. This does not authorize another provider attempt.

Verification used a compiled current-source plugin sidecar, an isolated Runtime authority, a real Desktop Operator registration, and a held `provider-state:computer` lease. The MCP adapter returned `PLUGIN_RESOURCE_CONTENTION`, `retryable=true`, the exact blocker and `effectOutcome=failed`. Reattachment returned the same receipt; changing the target under the same request was rejected. No provider mutation was dispatched. Existing replay/cutover fencing tests passed. Diagnostic serialization failure or details over 8KiB cannot replace the primary failure. Protected console actions remain outside durable receipts.

## Supervisor terminal lookup decision

The installed Runtime's supported two-second JSC sampler showed Supervisor reconciliation SQL and repeated target cleanup in the active stacks. The database snapshot contained 177 tasks, 1,634 effects, 37,697 events and 1,240 completions. Terminal predicates used `events_task_order` and scanned ordinary task events to establish the absence of a terminal event.

On an in-memory backup of that real database, ten unchanged-query samples gave:

| Query | Before p50 | With terminal index p50 | Result comparison |
| --- | ---: | ---: | --- |
| Tasks without causal obligation | 7.731ms | 0.060ms | Same rows |
| CONTINUE completions awaiting successor | 0.402ms | 0.295ms | Same rows |
| Active-task terminal predicate | 9.107ms | 0.028ms | Same three tasks |

Decision: add the partial `events_terminal_task_order(task_id,event_id)` index for the existing three terminal event kinds. Queries and semantic decisions stay unchanged. This reduces recurring historical-log scan cost; it does not prove the entire live Computer latency is fixed.

The existing Supervisor store owns index creation during database open. The index is a rebuildable projection over canonical events, not a new durable fact or lifecycle. It adds no authorization, writer, resource lease, retry, evidence, provider, process, or deployment owner. Existing SQLite transactions, backup/restore, retention, terminal contracts and sensitive-data rules apply. The additive index leaves schema-version-1 records unchanged and older Runtime readers compatible; rollback may leave the harmless index in place. It can be dropped and recreated without losing task facts. Creation takes SQLite's existing writer lock at startup; no query writes or live database edits were used for the comparison. Remove it if the terminal predicate or event authority is retired. Existing stop, terminal and crash/reconciliation scenarios pass without adding tests.

## Native observation transport isolation, 2026-10-14

Live Runtime and Desktop Operator OS samples established that the provider's client connection was spending time in `BrowserAutomationBroker.runCommand` while native observation itself remained short. `UnixSocketServer.handleClient` processes JSONL requests synchronously on each connection. The Runtime provider's single retained channel carried both legacy Browser RPCs and native snapshots, creating head-of-line blocking across independent resources.

A controlled overlap used the real installed provider, the same already-open Finder session, and Chrome `metadata` reads. No tabs were created, activated, navigated, or mutated. Each native observation began 25ms after the Browser request. Before the correction, three Browser calls took 293–313ms and the native observations waited 277–293ms. After the correction, Browser calls still took 286–339ms, but overlapping observations took 9–14ms. This proves the transport coupling and its removal for the real provider; source hot-path benchmarks alone would not expose it.

Decision: the existing provider composition owns a maximum of two lazy retained connections under the same registration identity. Native observation, element observation and capture use the observation connection. All native input, protected-console calls and legacy Browser RPCs retain their original connection. The existing per-session/target epoch locks, physical-input protection, capability authorization, byte/time budgets, generation negotiation, no-replay contracts and durable target authority remain unchanged. A registration/endpoint change closes both connections, each connection negotiates independently, and Runtime disposal closes both. This adds no process, persistent state, provider/session authority, policy inference, fallback, or scheduler. Whole-Runtime release/rollback remains the deployment boundary. If the legacy Browser bridge is retired, remove its consumers rather than preserving a transport solely for compatibility history.

The retained element-v2 stale-reference scenario originally asserted a single aggregate handshake across observation and input. That implementation-shape assertion was removed; exact stale-ref rejection, one successful action and one provider session remain asserted. Existing per-stream warm reuse, registration drift, disconnect fencing, protected console and unknown-send scenarios remain. The first run passed 42 of 43 existing scenarios; only the obsolete aggregate count failed. The repaired scenario then passed. No new test cases or test files were added. The dispatch benchmark still measured one observe RPC per warm action, no warm handshake/reconnection and p95 1.7ms in the isolated fixture. A separate read-only Codex CLI review using the account's advertised `gpt-5.6-sol` model returned `No actionable findings.` This is same-vendor independent review, not cross-vendor evidence. The CLI's default `gpt-6.1-sol` was rejected by that account and was not used; global model settings were not changed. Installed-MCP overlap acceptance remains pending for this candidate.

## Remaining verification

A concurrent release transaction subsequently moved the installed Runtime to `1791970357578-65ec0095e56973e870254d8a4c6c96fd051cf269` (observed ready, PID 13324). The code changes above are newer than that source revision. The full local `check:main` gate passed for the reviewed source candidate; commits through `443e6dd435bdfeb099f4859bbb9647fd16d76266` were pushed. GitHub reported admin bypass of expected Main gate status; no GitHub Actions run was returned for that last commit, so local gate evidence must not be described as remote CI success.

On the newer installed Runtime, three remote observations of the same new Finder target reported 2,009ms, 49ms and 2,684ms at the Gateway. Existing `audit/mcp-timings.jsonl` traces for those exact request IDs measured Canonical Runtime durations of 2,000ms, 30ms and 2,660ms respectively. The proxy connection was reused, dispatch lag was 3–10ms and return time was 1–8ms. Five following direct local MCP reads of that same target measured server p50 19.9ms / p95 35.2ms. Thus the slow calls are predominantly intermittent waits inside Canonical Runtime, with a separate remote network residual; they are not explained by Gateway reconnect alone. These are measurements, not proof of a particular native-provider, manifest, target-lock or event-loop cause. The next investigation should split those stages using the existing tracing path and reproduce the slow interval before changing execution semantics.

The live latency distribution, scheduler/cleanup cost, remote connector internal errors, and current canonical Work execution/delivery efficiency still need investigation. A Finder diagnostic target was retired through the same original request after connector observation errors; its stored receipt confirmed success. Claude CLI review could not run because it was not logged in. Focused checks, source review and isolated acceptance are evidence, but do not substitute for independent candidate review and installed-Runtime acceptance.
