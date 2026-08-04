---
id: "ISS-20260720-66E25D"
kind: "feature"
status: "in_progress"
updated_at: "2026-08-03T06:42:16.873Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 稳定、快速地操作物理 iPhone

保留为唯一的物理 iPhone 自动化用户需求，但执行方案已重新定基线：不再继续把签名、WDA/Runner、CoreDevice tunnel、interaction session 和 App adapter 生命周期修补在 Controller 内嵌 ios-adapter 中。新方案以 ISS-20260802-3EC105 的进程外插件协议为基础，把 ios-device 建成 controller-scoped 独立服务，Repo Harness 只负责 ChatGPT 桥接、权限、资源互斥、Durable Work 和审计；既有 provider、selector/ref 恢复、证据分层和跨引擎互斥提交作为迁移资产保留。

## Goals

- 可靠发现并独占用户选择的物理 iPhone，并以 device:ios:<udid> 作为跨引擎共享资源权威。
- 将物理设备自动化实现为独立 ios-device 插件服务，拥有独立进程、状态、release、签名配置和恢复策略。
- 使用固定稳定版 Xcode、单一 Apple signing context、预构建/预安装并长驻的 WDA 或等价 XCTest Runner，消除正常热路径 xcodebuild。
- 让 Controller/Gateway rollout、MCP 重连和 repo-harness 升级不销毁健康 Runner、tunnel 或 interaction session。
- 对已知 App 使用语义 App Adapter；Accessibility 为主，局部视觉仅作为受控兜底。
- 在不处理密码、验证码、支付或生物识别的前提下，稳定完成京东等已知 App 的搜索、浏览和读取。
- 提供明确故障分类与局部恢复：semantic、app state、runner、transport、signing、locked device 分别处理。
- 建立冷启动、暖路径和真实 JD 流程的可重复 p50/p95、成功率和恢复时间基准。

## Non-goals

- 不越狱、不绕过 iOS 安全控制。
- 不自动处理密码、验证码、生物识别、购买、结算或支付。
- 不把 ios-device 服务作为 Supervisor 子进程或打进主 Controller release。
- 不让 Recovery Gateway 直接管理 WDA、签名或设备 session。
- 不继续扩展旧 monolithic ios-adapter 的长期生命周期职责；迁移窗口只允许明确 proxy。
- 不在运行时下载或临时引入未固定版本的自动化工具。
- 不把 ios-development 的项目 build/simulator 职责与物理 ios-device 服务重新合并。

## Acceptance Criteria

- [ ] ios-device 作为 controller-scoped 外部插件注册，Repo Harness 核心不直接拥有 WDA、签名、tunnel 或 interaction daemon 生命周期。
- [ ] 同一 iPhone 在 CoreDevice、WDA/agent-device 或后续引擎之间共享一个 device:ios:<udid> 写锁和审计身份。
- [ ] Apple Team、signing identity、Runner bundle、DeveloperDir 和工具版本由一个持久化 signing authority 管理；普通 action 不临时改变。
- [ ] 暖路径不得执行 xcodebuild 或重新签名；Runner 健康时直接复用，进程死亡只重启 Runner，签名失效才进入重签流程。
- [ ] Controller/Gateway 两次重启或一次 rollout 后，健康 ios-device 服务仍存活或无损重连，已有可恢复 session 不因核心升级被清空。
- [ ] recoverable selector/ref/type/app-state 失败不销毁健康 session；runner/transport/unknown-outcome 故障 fail closed 并隔离资源。
- [ ] JD 搜索遵循真实两页语义路径并通过 fixture、故障注入和实机验证；不依赖首页不可编辑 proxy。
- [ ] 稳定连接且设备已解锁时，暖 Snapshot 目标 p50≤1.5 秒、p95≤3 秒；任何未达到目标的阶段必须有分解耗时而非统一 timeout。
- [ ] 稳定连接且设备已解锁时，10 次暖 JD 搜索至少 9 次成功，目标 p50≤12 秒、p95≤20 秒；失败必须归类到明确层级。
- [ ] 证据默认有界并返回 compact receipt、阶段耗时和 artifact references；完整 tree、截图或日志只通过明确 detail 路径读取。
- [ ] 敏感操作边界保持不变，插件与视觉兜底不能绕过核心授权和确认。

## GitHub

- Issue: https://github.com/moretea-labs/matea/issues/45
- Repository: `moretea-labs/matea`
- Last synced: 2026-08-03T06:40:33.753Z

## Tasks

### T1 — Implement bounded iOS session direct execution

- Status: `superseded`
- Objective: Design and implement a short allowlisted interaction-session execution path with ownership, cancellation, timeout, receipt and durable escalation.
- Depends on: none
- Allowed paths: `src/runtime/gateway/**`, `src/runtime/plugins/**`, `src/runtime/execution/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T2 — Complete tiered iOS accessibility evidence

- Status: `superseded`
- Objective: Add selector or ref reuse, settle diff, exact wait, scoped snapshot and full snapshot fallback tiers with bounded redacted evidence.
- Depends on: none
- Allowed paths: `src/runtime/plugins/ios-agent-device.ts`, `tests/runtime/ios-agent-device-provider.test.ts`, `scripts/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`
- Execution hint: agent / codex

### T3 — Build repeatable iOS latency benchmark

- Status: `superseded`
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
- GitHub: https://github.com/moretea-labs/matea/issues/46

### T6 — Separate physical iOS resource ownership from automation engine identity

- Status: `superseded`
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

- Status: `superseded`
- Objective: Use the 2026-08-01 JD real-device transcript as primary evidence. In an isolated checkout, reproduce and fix the remaining Repo Harness defects: compile the JD semantic adapter as focus/navigate -> resolve real editable control -> fill -> submit instead of filling the home-page proxy; preserve healthy sessions for selector/ref/type/semantic failures and destroy only classified transport/runner/unknown-outcome failures; make page-transition diffs and ref generations safe so a contradictory zero-diff cannot authorize stale refs; carry the resolved Apple signing context through every lazy Runner start in an interaction; and replace repeated full plugin manifest/action-schema payloads on normal plugin_action_execute responses with a bounded compact receipt plus an explicit detail path. Then add a warm multi-step execution primitive or adapter batch that performs known semantic steps without returning to the model after every action, with phase timings and bounded evidence. Keep public action IDs and sensitive-action policy unchanged.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/gateway/**`, `src/cli/mcp/**`, `tests/runtime/**`, `tests/cli/**`, `tests/fixtures/**`, `scripts/**`, `docs/architecture/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T9 — 按通用插件协议重新定基线 iOS 迁移方案

- Status: `blocked`
- Objective: 在 ISS-20260802-3EC105 冻结 Plugin Protocol 与服务边界后，盘点现有 ios-adapter、ios-agent-device、ios-physical-device、InteractionSession、签名修复和 JD adapter 提交，形成迁移到独立 ios-device 服务的 keep/move/rewrite/delete 地图；不重新设计通用插件协议。
- Depends on: none
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `docs/researches/**`, `src/runtime/plugins/**`, `tests/runtime/**`
- Checks: `package:check:public-docs`
- Execution hint: agent / codex
- GitHub: https://github.com/moretea-labs/matea/issues/47

### T10 — 构建独立 ios-device 服务与兼容代理

- Status: `planned`
- Objective: 基于已交付的 External Plugin Registry、Broker 和 reference lifecycle，建立 controller-scoped ios-device 外部服务、独立 release/state/launchd、Plugin Protocol server 与 Repo Harness 兼容代理；旧 public action IDs 经单一代理转发，Controller 不再拥有领域 daemon。
- Depends on: `T9`
- Allowed paths: `plugins/ios/**`, `packages/**`, `src/runtime/plugins/**`, `src/cli/**`, `scripts/**`, `tests/plugin-contract/**`, `tests/runtime/**`, `docs/operations/**`, `package.json`, `bun.lock`, `package-lock.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex
- GitHub: https://github.com/moretea-labs/matea/issues/48

### T11 — 实现持久设备、签名、WDA 与 Session 生命周期

- Status: `planned`
- Objective: 在独立 ios-device 服务中实现 Device Authority、CoreDevice transport、单一 signing authority、预构建/预安装 WDA 或等价 Runner、长驻健康检查、interaction session 与故障分类恢复；迁移 74de9d90 的 signing-context 隔离思想，但不再依赖每次 CLI probe daemon。
- Depends on: `T10`
- Allowed paths: `plugins/ios/**`, `packages/**`, `scripts/**`, `tests/plugin-contract/**`, `tests/fixtures/**`, `tests/runtime/**`, `docs/operations/**`, `package.json`, `bun.lock`, `package-lock.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex
- GitHub: https://github.com/moretea-labs/matea/issues/49

### T12 — 迁移语义交互引擎并完成京东适配

- Status: `planned`
- Objective: 把 selector/ref 恢复、tiered evidence、failure classification 和 JD 两页搜索逻辑迁入独立 interaction engine 与 App Adapter；Accessibility 为主，局部视觉兜底必须受权限、证据和结果验证约束；已知 JD 搜索以单个 bounded semantic action 执行。
- Depends on: `T11`
- Allowed paths: `plugins/ios/**`, `packages/**`, `tests/fixtures/**`, `tests/plugin-contract/**`, `tests/runtime/**`, `scripts/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex
- GitHub: https://github.com/moretea-labs/matea/issues/50

### T13 — 完成实机性能、恢复和核心升级验收

- Status: `planned`
- Objective: 在用户物理 iPhone 上执行冷准备、暖 Snapshot、暖 JD 搜索、Runner 重启、transport 重连、设备锁屏、Controller 两次重启和一次 rollout 的受控验证；统计 p50/p95、成功率、恢复时间与失败分类，并完成旧内嵌 owner 的切除。
- Depends on: `T12`
- Allowed paths: `scripts/**`, `plugins/ios/**`, `tests/**`, `docs/operations/**`, `docs/researches/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex
- GitHub: https://github.com/moretea-labs/matea/issues/51

### T14 — 提供真机 Debug 构建、安装与日志采集闭环

- Status: `ready`
- Objective: 修复 iOS build 对真机 UDID 错投影为 iOS Simulator，并提供结构化的 Debug app 安装、带启动参数/环境变量启动、stdout/unified log 持续采集和有界日志 artifact。
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/plugins/ios/**`, `tests/runtime/**`, `tests/fixtures/**`, `docs/operations/**`, `scripts/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime
- GitHub: https://github.com/moretea-labs/matea/issues/52

## Related Artifacts

- `ISS-20260802-3EC105`
- `ISS-20260802-539E7F`
- `ISS-20260802-7E1D69`
- `ISS-20260720-E8E871 merged and cancelled`
- `ISS-20260719-F77E4C completed foundations`
- `commits 85f9604d, 2125ddda, 4ce2269e, cf0df13e, 4a22e00d, 74de9d90`
