---
id: "ISS-20260727-197BBE"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-28T09:09:16.571Z"
source: "repo-harness-controller-v8"
---

# Converge V2 runtime performance and execution routing

基于已切换的 V2 SuperController + Unified Process Runtime 架构继续收敛，不恢复新 ExecutionJob 创建。先统一公开 MCP 命令路由并补 requestId 级幂等，再收敛 Claim、只读诊断隔离、Context/版本状态、端口与历史降噪。

## Goals

- 所有普通本地命令和检查统一由 Unified Process Runtime 单次 Spawn 执行
- 同一 requestId 和命令指纹在重试、502、Controller 重启后返回同一 Process，不重复执行
- Durable 业务生命周期由 WorkContract/Plan + 已认领 SuperController 承担，不恢复 ExecutionJob 创建
- 减少不必要的 workspace write Claim、Job/Worker/LocalJob 包装和默认状态负载
- 建立端到端行为基线和回归门禁

## Non-goals

- 不重写 V2 总体架构
- 不重新启用新 ExecutionJob 或旧 Agent Run 创建
- 不削弱远程写、破坏性操作和审批边界
- 不删除历史审计数据

## Acceptance Criteria

- [ ] 长 focused test 和 typecheck 在交互等待内未完成时返回 processId，且 ExecutionJob/LocalJob/Worker 增量均为 0
- [ ] 相同 requestId + 相同命令返回同一 processId；相同 requestId + 不同命令 fail closed
- [ ] timeout 只控制 Process 生命周期，不再决定普通本地命令进入旧 Durable 链路
- [ ] 需要 durable 生命周期的动作返回 external controller / WorkContract 路径，不创建新 ExecutionJob
- [ ] 相关 focused tests、typecheck、runtime architecture、MCP compatibility 和 controller-v8 通过
- [ ] 最终提交合并到 main，工作树、临时分支和 worktree 清理完成

## GitHub

- Not published.

## Tasks

### T1 — Unify Process Runtime routing and request idempotency

- Status: `done`
- Objective: 建立唯一公开命令执行判定入口。让 repository_command_execute、run_check、work_execute 等普通本地命令共享 Process Runtime route decision，移除 timeout>15s 回退旧 ExecutionJob/LocalJob/Worker 的行为；为 Process Runtime 增加 repoId+checkoutId+requestId+command fingerprint 的持久原子幂等索引，重试返回同一 Process，指纹冲突 fail closed，completed_unknown 不自动重跑。保持远程写、破坏性操作和 WorkContract/SuperController 授权边界。增加端到端路由、502/重试、重启恢复和无重复执行测试。
- Depends on: none
- Allowed paths: `src/runtime/execution/process-runtime/**`, `src/runtime/execution/thin-harness/**`, `src/runtime/gateway/mcp/**`, `src/cli/mcp/**`, `src/cli/repositories/**`, `tests/runtime/**`, `tests/cli/**`, `docs/operations/**`, `docs/architecture/current/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T2 — Converge resource claims for checks and local commands

- Status: `ready`
- Objective: 基于真实副作用收敛 Process Resource Claims。Typecheck/lint/静态分析默认 workspace read + 声明的 cache/output write，不再同时申请同一 workspace read/write；为命名检查增加显式 reads/writes/cache/temp/git/network effects，未知副作用继续 fail closed；验证长检查期间无冲突读取可并发。
- Depends on: `T1`
- Allowed paths: `src/runtime/execution/process-runtime/**`, `src/runtime/resources/claims/**`, `src/runtime/gateway/mcp/resource-policy.ts`, `src/cli/controller/check-runner.ts`, `tests/runtime/**`, `tests/cli/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T3 — Move read-only diagnostics to isolated process execution

- Status: `ready`
- Objective: 将 workflow_watchdog_report、runtime_maintenance_status、cleanup preview 等只读但可能阻塞的诊断从 ExecutionJob 包装迁到隔离诊断 Process/Worker Thread；不得直接阻塞 Gateway event loop，不创建 Evidence/Projection write/Scheduler wake，短时间未完成返回可查询句柄。apply/repair/restart 继续走受控 WorkContract/SuperController。
- Depends on: `T1`
- Allowed paths: `src/runtime/gateway/mcp/**`, `src/runtime/watchdog/**`, `src/runtime/diagnostics/**`, `src/runtime/execution/process-runtime/**`, `tests/runtime/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T4 — Shrink context and expose runtime coherence

- Status: `running`
- Objective: 压缩 rh_context/controller_ready 默认摘要，只返回当前决策所需字段并提供 detailPointer；区分 current/historical attention；新增 stableSupervisorRevision、activeRuntimeRevision、activeSlotRevision、gatewayRevision、sourceRevision、expectedRevision 和 coherence 状态，并加入实际 route behavior fingerprint。
- Depends on: `T1`
- Allowed paths: `src/runtime/gateway/mcp/**`, `src/runtime/projections/**`, `src/runtime/supervisor/**`, `src/cli/controller/**`, `tests/runtime/**`, `tests/cli/**`, `docs/operations/**`, `docs/architecture/current/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T5 — Complete performance baselines, port boundaries and historical noise reduction

- Status: `planned`
- Objective: 建立正式 before/after 性能与副作用基线；修复 slot port 超界和测试端口冲突，测试优先使用 OS 分配端口并原子记录候选 slot binding；历史 ExecutionJob/Campaign/Agent/Attention 保留审计但不污染默认摘要；执行完整回归并验证连续 package:test。
- Depends on: `T2`, `T3`, `T4`
- Allowed paths: `scripts/**`, `src/cli/controller/**`, `src/runtime/**`, `tests/**`, `docs/operations/**`, `docs/architecture/current/**`, `tasks/issues/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:test`
- Execution hint: selected at runtime

## Related Artifacts

- [runtime-note] `src/cli/mcp/auth.ts` — Slot Gateway OAuth token store authority resolves through stable root controllerHome and merges root/blue/green/legacy snapshots on startup.
- [test] `tests/cli/mcp-authority.test.ts` — Covers stable-root OAuth token authority and slot/legacy token-store merge for cutover continuity.
