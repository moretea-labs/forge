---
id: "ISS-20260802-7E1D69"
kind: "governance"
status: "planned"
updated_at: "2026-08-02T06:33:10.691Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 只展示清晰需求并自动管理执行细节

把当前以 Issue/Task/Run 状态为中心的执行账本，重构为以用户需求为中心的控制面。用户只管理可读的 Requirement；技术方案是可替换的 Execution Plan；Work 是唯一执行合同；Attempt、Process、Check、Receipt 和 Maintenance Finding 保留为内部证据。Requirement、Plan、Work 关系与状态迁移到 Controller-home SQLite 单一权威，Git 只保留源码、架构文档和可选导出快照，不再承担运行时状态双写。运行时 Bootstrap authority/config 继续使用独立极小原子文件，避免管理数据库故障影响启动与 Recovery。

## Goals

- 让用户默认只看到需求目标、当前状态、已交付结果、阻塞原因和需要用户决定的事项。
- 将用户需求、技术方案、执行合同、执行尝试和系统维护债务分成明确层次。
- 以 Controller-home SQLite 统一管理 Requirement、Execution Plan、Plan Step、Work 关联、状态、审计和幂等写入。
- 让 Work 成为唯一执行合同，消除 Task 与 Work 重复保存 objective、scope、checks、status 和 completion evidence。
- 把历史 Receipt 缺失、清理警告、投影落后等问题变成内部 Maintenance Finding，不再阻止已满足验收的用户需求关闭。
- 通过一次性迁移收敛当前 Issue 组合，保留历史证据，同时停止 Git Issue/Task JSON/Markdown 运行时双写。
- 提供用户需求面板和独立执行诊断视图，默认隐藏内部 Task、Run、Process、Lease 和 Receipt。

## Non-goals

- 不把 Supervisor 启动权威、runtime-authority.json、runtime-config.json 或 Recovery 最小状态放进控制面 SQLite。
- 不把日志、二进制、截图、大型 diff 或完整命令输出存入 SQLite；数据库只保存有界元数据和 artifact 引用。
- 不长期支持 Requirement 与旧 Issue/Task 的双写或双向同步。
- 不保留当前二十种 Task 状态作为用户生命周期。
- 不创建新的元治理 Issue 树或恢复已取消的 Campaign/Task 调度模型。
- 不在本 Issue 中实现主运行时 Bootstrap、rollout 或 Recovery 服务重构。
- 不执行远程 push、发布或不可逆外部操作。

## Acceptance Criteria

- [ ] 用户可见实体只有 Requirement，默认状态限定为 planned、active、waiting_for_user、done、cancelled，并可单独显示 needs_attention 健康标记。
- [ ] Requirement 标题使用用户语言描述结果，不使用 Converge、Harden、Rebaseline 等技术方案动词作为默认名称。
- [ ] Execution Plan 可版本化和 retired；替换方案不会创建重复用户需求。
- [ ] Plan Step 不拥有独立复杂生命周期，只引用一个 Work 或声明尚未生成 Work。
- [ ] Work 是 objective、scope、risk、checks、verification 和 delivery 的唯一执行合同；Attempt/Process 只描述一次执行事实。
- [ ] Requirement 完成由用户验收标准、交付结果和关键验证决定；非关键 cleanup warning 或历史 Receipt 缺失不会重新打开需求。
- [ ] Controller-home SQLite 是 Requirement/Plan/Work 关系和状态的唯一写入权威，使用版本、revision、audit、WAL、busy timeout 和事务化 CAS。
- [ ] 旧 Issue/Task JSON/Markdown 只允许一次性导入；迁移完成后不得覆盖 SQLite，Git 快照只能由 SQLite 单向生成。
- [ ] 运行时最小 authority/config、Recovery 最小状态和大型 artifacts 继续保持独立边界，SQLite 不成为启动单点故障。
- [ ] 迁移后默认项目面板不再统计 verified、integrated 或 integration_blocked Task 数量，而是展示真实未完成需求、等待用户决定和维护提醒。
- [ ] 故障注入覆盖并发更新、迁移中断、旧投影晚写、SQLite 损坏/备份恢复、进程重启和导出失败；任何失败不得产生双权威。
- [ ] 当前 Issue 组合完成一轮一次性迁移和归并，历史提交、验证和取消原因可追溯，源码仓库不再因运行时状态更新持续变脏。

## GitHub

- Not published.

## Tasks

### T1 — 冻结需求中心模型和存储边界

- Status: `ready`
- Objective: 编写并接受新的控制面架构决策，定义 Requirement、ExecutionPlan、PlanStep、Work、Attempt、MaintenanceFinding、用户状态、内部状态、完成语义和存储边界；明确替代旧 Issue/Task Git-authority 条款，并提供当前 31 个 Issue 的迁移映射。
- Depends on: none
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `docs/researches/**`, `tasks/issues/**`
- Checks: `package:check:public-docs`
- Execution hint: selected at runtime

### T2 — 建立 SQLite Requirement 与 Plan 权威

- Status: `planned`
- Objective: 在现有 control-plane SQLite envelope 上实现版本化 Requirement、ExecutionPlan、PlanStep、关系、状态事件和审计命名空间，并提供一次性旧 Issue/Task 导入、事务校验、备份与恢复。
- Depends on: `T1`
- Allowed paths: `src/runtime/persistence/**`, `src/runtime/control-plane/**`, `src/cli/controller/**`, `tests/runtime/**`, `tests/cli/**`, `scripts/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T3 — 让 Work 成为唯一执行合同

- Status: `planned`
- Objective: 移除 ControllerTask 与 WorkContract 之间重复的 objective、scope、checks、risk、status 和 completion authority。PlanStep 只引用 Work；Attempt/Run/Process 成为 Work 的执行尝试和证据，不再反向决定用户需求生命周期。
- Depends on: `T1`, `T2`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/execution/**`, `src/runtime/workflow/**`, `src/cli/controller/**`, `src/cli/mcp/**`, `tests/**`, `docs/architecture/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T4 — 提供用户需求面板和独立执行诊断

- Status: `planned`
- Objective: 新增默认 Requirement Board，展示用户标题、结果、五态生命周期、最新交付、阻塞和用户决策；将 Work、Attempt、Process、Lease、Check、Receipt 和维护问题移到按需 Execution Diagnostics。
- Depends on: `T2`, `T3`
- Allowed paths: `src/cli/controller/**`, `src/cli/mcp/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T5 — 迁移并收敛当前需求组合

- Status: `planned`
- Objective: 使用已审核映射把当前用户需求、计划版本、历史完成记录和合并关系一次性导入新模型；保留历史 Issue ID 作为 alias/evidence reference，验证结果后切换默认面板。
- Depends on: `T2`, `T3`, `T4`
- Allowed paths: `scripts/**`, `src/cli/controller/**`, `src/runtime/control-plane/**`, `tests/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:task-sync`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T6 — 删除旧 Issue/Task 双写和兼容路径

- Status: `planned`
- Objective: 在新面板和迁移验证通过后，删除运行时写 tasks/issues JSON/Markdown、旧 currentIssue 指针、二十态 Task project board、旧 Task readiness/terminal 假设和相关 fallback；保留显式离线导出命令。
- Depends on: `T5`
- Allowed paths: `src/**`, `scripts/**`, `tests/**`, `docs/**`, `package.json`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

### T7 — 完成故障注入、备份恢复和切换

- Status: `planned`
- Objective: 验证并发写入、进程中断、旧 projection 晚写、迁移中断、数据库损坏、备份恢复、导出失败和冷启动；完成正式切换并清理旧投影与治理残留。
- Depends on: `T5`, `T6`
- Allowed paths: `tests/**`, `scripts/**`, `docs/operations/**`, `src/runtime/persistence/**`, `src/runtime/control-plane/**`, `src/cli/controller/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260731-CCF3E3`
- `docs/architecture/decisions/20260801-controller-home-sqlite-state.md`
- `docs/researches/20260801-control-plane-state-store-inventory.md`
- `ISS-20260802-539E7F`
- `ISS-20260730-A1EA53`
- `current Issue portfolio audit 2026-08-02`
