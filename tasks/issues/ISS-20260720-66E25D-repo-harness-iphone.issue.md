---
id: "ISS-20260720-66E25D"
kind: "feature"
status: "launch_blocked"
updated_at: "2026-08-02T06:29:12.324Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 稳定、快速地操作物理 iPhone

保留为唯一的物理 iPhone 自动化用户需求。已完成的 Provider 边界、CoreDevice、agent-device、跨引擎互斥和证据分层继续保留；JD 搜索、热路径延迟和剩余验证将在新运行时与需求/Work 架构切换后重新生成执行 Work。当前没有可调度旧 Task。

## Goals

- 可靠发现并独占用户选择的物理 iPhone。
- 在不处理密码、验证码、支付或生物识别的前提下，稳定完成已知 App 的语义操作。
- 让正常热路径延迟可测量、可优化，并在失败后保留可恢复的 session。
- 统一 CoreDevice、agent-device 和 signed runner 的能力边界与证据。

## Non-goals

- 不越狱、不绕过 iOS 安全控制。
- 不自动处理密码、验证码、生物识别、购买、结算或支付。
- 不在运行时下载或临时引入未经固定版本的自动化工具。
- 不在新的控制面架构完成前继续扩展旧 Task/Run 模型。

## Acceptance Criteria

- [ ] 同一物理设备在所有自动化引擎间只有一个资源所有者。
- [ ] 已知语义路径可以在一个有界 session 中执行，并返回有界证据和阶段耗时。
- [ ] 可恢复的 selector/ref/语义失败不会无条件销毁健康 session。
- [ ] Runner、传输或结果不确定故障会 fail closed 并正确释放或隔离资源。
- [ ] JD 等真实流程通过 fixture、故障注入和可选实机验证。

## GitHub

- Not published.

## Tasks

### T1 — Implement bounded iOS session direct execution

- Status: `blocked`
- Objective: Design and implement a short allowlisted interaction-session execution path with ownership, cancellation, timeout, receipt and durable escalation.
- Depends on: none
- Allowed paths: `src/runtime/gateway/**`, `src/runtime/plugins/**`, `src/runtime/execution/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T2 — Complete tiered iOS accessibility evidence

- Status: `blocked`
- Objective: Add selector or ref reuse, settle diff, exact wait, scoped snapshot and full snapshot fallback tiers with bounded redacted evidence.
- Depends on: none
- Allowed paths: `src/runtime/plugins/ios-agent-device.ts`, `tests/runtime/ios-agent-device-provider.test.ts`, `scripts/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`
- Execution hint: agent / codex

### T3 — Build repeatable iOS latency benchmark

- Status: `blocked`
- Objective: Measure controller overhead, process startup, runner round trips, settle, snapshot and artifact costs for cold and warm simulator and optional physical-device runs.
- Depends on: `T2`
- Allowed paths: `scripts/**`, `src/runtime/plugins/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T4 — Close measured Thin Harness follow-ups

- Status: `superseded`
- Objective: Measure and reduce patch savepoint and command-policy costs, large-repository read variance, Workbench schema size and Fast/Durable adapter duplication. Code and correctness verification closed on 2026-08-01: event-driven SWR freshness, compact startup summary, toolset tiers, runtime identity, git-identity hot-path caching, supervised check bridge. Formal performance acceptance is deferred to a dedicated follow-up session.
- Depends on: none
- Allowed paths: `src/runtime/execution/thin-harness/**`, `src/runtime/gateway/**`, `src/cli/mcp/**`, `scripts/benchmark-thin-harness-gateway-ab.ts`, `tests/runtime/thin-harness.test.ts`, `tests/cli/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T5 — Audit and refactor the iOS automation provider boundary

- Status: `done`
- Objective: Perform a whole-subsystem review using the real-device failures from 2026-08-01 as primary evidence. Split the monolithic ios-agent-device integration into provider capability negotiation, command compilation, session/runner lifecycle, semantic snapshots/selectors, App adapters, failure classification, evidence and fallback routing. Fix unsupported-flag emission, shallow-tree false negatives, opaque fill/press failures, over-eager session destruction, idempotent cleanup and CoreDevice fallback. Evaluate the installed and current upstream agent-device sources; patch or fork them only where the defect belongs below the Repo Harness adapter, keeping the integration replaceable and version-pinned.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/safe-tooling/**`, `src/plugins/ios/**`, `tests/runtime/**`, `tests/fixtures/**`, `scripts/**`, `docs/architecture/**`, `docs/operations/**`, `docs/researches/**`, `package.json`, `bun.lock`, `third_party/**`, `vendor/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T6 — Separate physical iOS resource ownership from automation engine identity

- Status: `blocked`
- Objective: Keep ios-device as the shared physical-iPhone ownership and mutual-exclusion domain while adding a backward-compatible explicit automation-engine identity to InteractionSession records and evidence. New agent-device sessions must declare the agent-device engine; CoreDevice/WDA sessions must declare the coredevice engine. Replace interaction-id/reason heuristics with engine-aware validation plus bounded legacy compatibility, ensure actions cannot consume another engine's session, and prove that active sessions from either engine block the other on the same target. Preserve all public action IDs and do not require a connected phone.
- Depends on: none
- Allowed paths: `src/runtime/plugins/interaction-session.ts`, `src/runtime/plugins/ios-agent-device.ts`, `src/runtime/plugins/ios-physical-device.ts`, `tests/runtime/ios-agent-device-provider.test.ts`, `tests/runtime/ios-physical-device-provider.test.ts`, `docs/architecture/ios-semantic-automation-provider-v2.md`, `docs/architecture/current/human-interaction-plane.md`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T7 — Defer Task verification on repository check lease conflicts

- Status: `superseded`
- Objective: Fix verify_task so repository-wide Process Runtime lease contention is classified as deferred infrastructure coordination rather than failed source verification. A PROCESS_LEASE_CONFLICT must return before recordTaskVerification, preserve the Task's current lifecycle and existing acceptance evidence, expose the conflicting process and a deterministic fresh retry_request_id, and allow a later quiet-window retry without reusing the terminal failed Process. Real completed check failures remain authoritative.
- Depends on: none
- Allowed paths: `src/cli/mcp/legacy-tool-service.ts`, `tests/cli/mcp-controller.test.ts`, `docs/architecture/current/human-interaction-plane.md`, `docs/architecture/ios-semantic-automation-provider-v2.md`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T8 — Close live JD correctness and warm-path latency regressions

- Status: `blocked`
- Objective: Use the 2026-08-01 JD real-device transcript as primary evidence. In an isolated checkout, reproduce and fix the remaining Repo Harness defects: compile the JD semantic adapter as focus/navigate -> resolve real editable control -> fill -> submit instead of filling the home-page proxy; preserve healthy sessions for selector/ref/type/semantic failures and destroy only classified transport/runner/unknown-outcome failures; make page-transition diffs and ref generations safe so a contradictory zero-diff cannot authorize stale refs; carry the resolved Apple signing context through every lazy Runner start in an interaction; and replace repeated full plugin manifest/action-schema payloads on normal plugin_action_execute responses with a bounded compact receipt plus an explicit detail path. Then add a warm multi-step execution primitive or adapter batch that performs known semantic steps without returning to the model after every action, with phase timings and bounded evidence. Keep public action IDs and sensitive-action policy unchanged.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/gateway/**`, `src/cli/mcp/**`, `tests/runtime/**`, `tests/cli/**`, `tests/fixtures/**`, `scripts/**`, `docs/architecture/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `ISS-20260720-E8E871 merged and cancelled`
- `ISS-20260719-F77E4C completed foundations`
- `ISS-20260802-539E7F`
- `ISS-20260802-7E1D69`
- `commits 85f9604d, 2125ddda, 4ce2269e`
