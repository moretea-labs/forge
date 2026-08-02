---
id: "ISS-20260720-66E25D"
kind: "feature"
status: "in_progress"
updated_at: "2026-08-02T00:47:00.257Z"
source: "repo-harness-controller-v8"
---

# Optimize iOS device interaction latency and Thin Harness follow-ups

Converge iOS physical-device automation into a fast, stable and provider-neutral subsystem. Incorporate real-device evidence from iOS 27/Xcode 27: recoverable XCTest DTX failure after reboot, expensive shallow snapshots versus fast deep-tree warm snapshots, JD search controls hidden below default depth, wrapper use of unsupported agent-device flags, opaque fill failures, cleanup/session fencing defects, and the need for a CoreDevice read-only fallback. Review and refactor Repo Harness integration and, where evidence justifies it, patch or fork the upstream agent-device implementation behind a provider adapter.

## Goals

- Make trusted warm iOS actions behave like local API calls with bounded latency and zero model/vision work on the normal path.
- Separate provider capability negotiation, device/session lifecycle, semantic tree operations, App adapters, evidence, and fallback routing.
- Remove hard-coded CLI assumptions; detect agent-device versions/capabilities and compile only supported commands.
- Make snapshots, selectors, refs, waits, fill/press, batching, cleanup and failure classification deterministic and testable offline.
- Support optional patched/forked agent-device integration without coupling Repo Harness to one upstream implementation.
- Measure cold/warm latency and failure recovery using repeatable fixtures and optional live-device benchmarks.

## Non-goals

- Jailbreaking, bypassing iOS security controls, automating credentials, verification codes, biometrics, checkout, purchase or payment.
- Unbounded screen-coordinate exploration or model-driven clicking on the trusted fast path.
- Publishing, pushing, releasing, or modifying the user's Apple account as part of this work.

## Acceptance Criteria

- [ ] Known supported App-adapter paths execute with version-negotiated provider commands and do not send unsupported CLI flags.
- [ ] Default tree depth cannot hide known semantic controls without bounded automatic escalation or adapter-declared scope.
- [ ] A single action failure does not automatically destroy an otherwise healthy provider session unless failure classification proves the session is unusable.
- [ ] Session cleanup is idempotent; device ownership and runner processes cannot remain fenced by already-absent provider sessions.
- [ ] CoreDevice screenshot/open remain available as an explicit read-only fallback when XCTest automation is unavailable.
- [ ] Provider and App-adapter behavior has fixture-based, property/fault-injection and compatibility coverage, plus type, runtime architecture and MCP compatibility gates.
- [ ] Benchmarks report real p50/p95 cold/warm phases and identify provider, wrapper and evidence costs separately.
- [ ] No sensitive action boundary is weakened.

## GitHub

- Not published.

## Tasks

### T1 — Implement bounded iOS session direct execution

- Status: `ready`
- Objective: Design and implement a short allowlisted interaction-session execution path with ownership, cancellation, timeout, receipt and durable escalation.
- Depends on: none
- Allowed paths: `src/runtime/gateway/**`, `src/runtime/plugins/**`, `src/runtime/execution/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T2 — Complete tiered iOS accessibility evidence

- Status: `ready`
- Objective: Add selector or ref reuse, settle diff, exact wait, scoped snapshot and full snapshot fallback tiers with bounded redacted evidence.
- Depends on: none
- Allowed paths: `src/runtime/plugins/ios-agent-device.ts`, `tests/runtime/ios-agent-device-provider.test.ts`, `scripts/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`
- Execution hint: agent / codex

### T3 — Build repeatable iOS latency benchmark

- Status: `planned`
- Objective: Measure controller overhead, process startup, runner round trips, settle, snapshot and artifact costs for cold and warm simulator and optional physical-device runs.
- Depends on: `T2`
- Allowed paths: `scripts/**`, `src/runtime/plugins/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T4 — Close measured Thin Harness follow-ups

- Status: `ready`
- Objective: Measure and reduce patch savepoint and command-policy costs, large-repository read variance, Workbench schema size and Fast/Durable adapter duplication.
- Depends on: none
- Allowed paths: `src/runtime/execution/thin-harness/**`, `src/runtime/gateway/**`, `src/cli/mcp/**`, `scripts/benchmark-thin-harness-gateway-ab.ts`, `tests/runtime/thin-harness.test.ts`, `tests/cli/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T5 — Audit and refactor the iOS automation provider boundary

- Status: `integrated`
- Objective: Perform a whole-subsystem review using the real-device failures from 2026-08-01 as primary evidence. Split the monolithic ios-agent-device integration into provider capability negotiation, command compilation, session/runner lifecycle, semantic snapshots/selectors, App adapters, failure classification, evidence and fallback routing. Fix unsupported-flag emission, shallow-tree false negatives, opaque fill/press failures, over-eager session destruction, idempotent cleanup and CoreDevice fallback. Evaluate the installed and current upstream agent-device sources; patch or fork them only where the defect belongs below the Repo Harness adapter, keeping the integration replaceable and version-pinned.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `src/plugins/ios/**`, `tests/runtime/**`, `tests/fixtures/**`, `scripts/**`, `docs/architecture/**`, `docs/operations/**`, `docs/researches/**`, `package.json`, `bun.lock`, `third_party/**`, `vendor/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T6 — Separate physical iOS resource ownership from automation engine identity

- Status: `changes_requested`
- Objective: Keep ios-device as the shared physical-iPhone ownership and mutual-exclusion domain while adding a backward-compatible explicit automation-engine identity to InteractionSession records and evidence. New agent-device sessions must declare the agent-device engine; CoreDevice/WDA sessions must declare the coredevice engine. Replace interaction-id/reason heuristics with engine-aware validation plus bounded legacy compatibility, ensure actions cannot consume another engine's session, and prove that active sessions from either engine block the other on the same target. Preserve all public action IDs and do not require a connected phone.
- Depends on: none
- Allowed paths: `src/runtime/plugins/interaction-session.ts`, `src/runtime/plugins/ios-agent-device.ts`, `src/runtime/plugins/ios-physical-device.ts`, `tests/runtime/ios-agent-device-provider.test.ts`, `tests/runtime/ios-physical-device-provider.test.ts`, `docs/architecture/ios-semantic-automation-provider-v2.md`, `docs/architecture/current/human-interaction-plane.md`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T7 — Defer Task verification on repository check lease conflicts

- Status: `ready`
- Objective: Fix verify_task so repository-wide Process Runtime lease contention is classified as deferred infrastructure coordination rather than failed source verification. A PROCESS_LEASE_CONFLICT must return before recordTaskVerification, preserve the Task's current lifecycle and existing acceptance evidence, expose the conflicting process and a deterministic fresh retry_request_id, and allow a later quiet-window retry without reusing the terminal failed Process. Real completed check failures remain authoritative.
- Depends on: none
- Allowed paths: `src/cli/mcp/legacy-tool-service.ts`, `tests/cli/mcp-controller.test.ts`, `docs/architecture/current/human-interaction-plane.md`, `docs/architecture/ios-semantic-automation-provider-v2.md`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T8 — Close live JD correctness and warm-path latency regressions

- Status: `ready`
- Objective: Use the 2026-08-01 JD real-device transcript as primary evidence. In an isolated checkout, reproduce and fix the remaining Repo Harness defects: compile the JD semantic adapter as focus/navigate -> resolve real editable control -> fill -> submit instead of filling the home-page proxy; preserve healthy sessions for selector/ref/type/semantic failures and destroy only classified transport/runner/unknown-outcome failures; make page-transition diffs and ref generations safe so a contradictory zero-diff cannot authorize stale refs; carry the resolved Apple signing context through every lazy Runner start in an interaction; and replace repeated full plugin manifest/action-schema payloads on normal plugin_action_execute responses with a bounded compact receipt plus an explicit detail path. Then add a warm multi-step execution primitive or adapter batch that performs known semantic steps without returning to the model after every action, with phase timings and bounded evidence. Keep public action IDs and sensitive-action policy unchanged.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/gateway/**`, `src/cli/mcp/**`, `tests/runtime/**`, `tests/cli/**`, `tests/fixtures/**`, `scripts/**`, `docs/architecture/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `06f764806499cded38841b1313b04ae45759d5fa`
- `EVD-1784559905279-a7d408c8`
- `EVD-1784560990334-cbe69246`
- `EVD-1784561013476-2d15a634`
