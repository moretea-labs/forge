# Plan: 第二轮性能、可靠性与运行时收敛计划

> **Status**: Executing
> **Created**: 20260801-2053
> **Slug**: 20260801-round2-performance-reliability-runtime
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md`
> **Task Review**: `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md`
> **Implementation Notes**: `tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md`
- Sprint contract: `tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md`
- Sprint review: `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md`
- Implementation notes: `tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md`
- Review file: `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md`
- Implementation notes file: `tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md`, `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md`, and `tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md`; after execution revert branch `codex/20260801-round2-performance-reliability-runtime` or the generated task artifacts

## Captured Planning Output

使用 `repo-harness6` 继续推进 `repo-harness-controller-runtime` 第二轮性能、可靠性与运行时收敛工作。

## 稳定仓库身份

Repository ID：

`repo_123b7cf58b6b17b5cbe46a56`

仓库：

`moretea-labs/repo-harness-controller-runtime`

已知主目录：

`/Users/greyson/DevProjects/repo-harness-controller-runtime`

已知主 checkout：

`checkout_79d467b771d6c6f0e6c103a7`

相关 Program：

`ISS-20260730-AE1BCC`

工具面相关 Result Issue：

`ISS-20260730-B55445`

不要依赖本 Prompt 中可能过时的分支、HEAD、Work、Edit Session、进程或运行时状态。必须以 Controller、Git、Stable Supervisor 和当前文件状态为准。

## 当前已知第一轮成果

当前工作树已经保留但尚未提交第一轮性能优化，已知包括：

* `controller_context` 改为 projection-first。
* 支持 fresh hit、stale-while-revalidate、detail 实时扫描和缓存元数据。
* Issue/Task、Plugin、Git、Check 变化可使投影失效。
* Board/Ledger 已消除部分重复扫描。
* Context Pack 增加 ignore-aware 文件清单缓存。
* 工具面目前约为：

  * Core 17
  * Advanced 133
  * Full 262
* Core 不支持的能力可返回 `unsupported_in_core`。
* Process Runner 使用增量日志流。
* Scheduler 主要使用 `fs.watch`，fallback 轮询约为 250–1000ms。
* 沿用 Controller Home 现有 SQLite-first 架构，没有引入文件与 SQLite 双写。
* 已有基准脚本：

`/Users/greyson/DevProjects/repo-harness-controller-runtime/scripts/benchmark-controller-hotpath.ts`

已知验证：

* `check:type` 通过。
* Controller 测试 33/33 通过。
* Process Runtime 等相关测试 83/83 通过。
* SQL、架构同步、任务同步、工作流检查通过。
* 当前原始工作树存在用户已有的大量测试删除，导致 `check:task` 的测试 manifest 数量门槛失败。
* 禁止覆盖、恢复、stash、reset 或擅自提交这些用户变更。

这些信息仅用于定位，必须重新读取当前事实，不得直接假设仍然成立。

---

# 核心原则

## 1. 不机械限制工具数量

不要把 128、133 或任何固定工具数当成天然正确的性能门槛。

Core、Advanced、Full 的设计应根据以下指标共同决定：

* 能力是否完整。
* 高频任务是否容易完成。
* facade 能否稳定路由到所需能力。
* 工具之间是否语义重复。
* schema 总字节数。
* `tools/list` 加载与解析成本。
* 模型选错工具的概率。
* 完整 MCP 调用延迟。
* 维护复杂度。
* 是否存在无实际价值的兼容入口。

只有证据显示某些工具重复、无用、影响选择或产生明显性能成本时，才删除、合并或移出 Advanced。

不得仅为了满足一个历史数字删除有效能力。

## 2. 优先解决真实端到端缺陷

不要只优化进程内微基准。

第二轮重点是：

* 完整 MCP 端到端调用路径。
* SWR 并发与失效正确性。
* Primary MCP 与 Recovery MCP 的故障隔离。
* Stable Supervisor 和 Tailscale 入口恢复能力。
* Process Runtime 与 Scheduler 的真实空闲资源成本。
* Context Pack 缓存正确性和内存生命周期。
* 多仓库、多 checkout 和 revision 隔离。
* 性能回归可观测性。

## 3. 不引入新的双写真相源

继续使用当前 Controller Home SQLite-first 架构。

JSON、Markdown 和运行证据可用于：

* 审计
* 导出
* 恢复
* 人类阅读

但不得新增一套需要业务调用者维护一致性的双写状态。

## 4. 当前用户工作树必须保持安全

当前工作树包含第一轮优化和用户已有测试删除。

禁止：

* `git reset`
* `git stash`
* rebase 当前用户工作树
* 强制切换分支
* 恢复用户删除的测试
* 覆盖用户未提交文件
* 使用 `git commit -a`
* 把无关用户改动混入性能优化提交

需要提交和验证时，优先创建隔离 worktree，只迁移本轮相关变更。

---

# 启动流程

1. 调用 `session_start`。
2. 显式调用 `session_bind_repository` 绑定：

   * repo ID `repo_123b7cf58b6b17b5cbe46a56`
   * 当前权威 checkout。
3. 读取：

   * 当前 Git HEAD、branch、status、worktree。
   * 最近 Edit Session。
   * 活跃 Work、Run、Local Job 和 Agent。
   * `ISS-20260730-AE1BCC`。
   * `ISS-20260730-B55445`。
   * 与第一轮性能优化对应的现有 Issue、Task 和 Work。
   * 当前 Stable Supervisor、active release、previous release、known-good release。
4. 不要创建重复 Issue 或重复 Work。
5. 如果已有 Work 正在承载该性能任务，则继续原 Work。
6. 如果现有 Issue 的 Task 范围不足，优先向现有 Result Issue 追加有界 Task。
7. 只有确实不存在合适归属时，才创建新的性能/可靠性 Issue。
8. 检查是否存在遗留 Edit Session；不得盲目覆盖或回滚。

---

# 第二轮工作内容

## T1：建立最新事实和可复现实验基线

先只读审计，不立即修改代码。

确认：

* 第一轮实际修改了哪些文件。
* 哪些变更属于性能优化。
* 哪些变更属于用户已有测试删除。
* 当前实现和第一轮描述是否一致。
* 当前 Core、Advanced、Full 的真实工具数量和 schema 大小。
* 当前 Primary MCP、Recovery MCP、Stable Supervisor 和外部入口状态。
* 当前运行时 revision 是否仍为旧实现。
* 当前 benchmark 是否只测进程内投影，还是已覆盖 MCP transport。
* 当前是否有未完成或重复的 refresh、Job、Process、watcher。

建立修改前基线，至少记录：

* `controller_context` cold miss。
* fresh hit。
* stale hit。
* detail。
* 本机 MCP E2E。
* 外部 MCP E2E；若外部入口不可达，记录故障证据。
* Core/Advanced/Full `tools/list`：

  * 工具数量
  * 序列化字节数
  * 响应时间
* Controller 空闲 CPU、wakeups 或近似系统调用证据。
* Scheduler 空闲行为。
* Process Runtime 无进程时和有进程时的轮询行为。
* Context Pack 重复查询行为。

不要用第一轮已有数字替代重新测量。

## T2：修复 SWR 与投影一致性缺陷

审计并补齐：

* 同一 projection key 的 single-flight refresh。
* 多个并发 stale hit 不重复启动完整扫描。
* refresh 开始后再次发生 invalidation 时，旧 refresh 不得覆盖新 generation。
* repo、checkout、HEAD、worktree fingerprint、projection generation 必须隔离。
* Summary 与 Detail 缓存不得相互污染。
* Core、Advanced、Full 不得错误共享工具面相关投影。
* refresh 失败时可以返回 stale，但必须：

  * 保留错误元数据
  * 有合理退避
  * 不形成永久 refreshing
* Controller 重启后不会遗留不可恢复的 refresh 状态。
* 多仓库并发调用不会串数据。
* 所有底层 mutation 都能使相关 revision 或 fingerprint 变化。

失效逻辑应尽量绑定底层权威 store 或 revision，而不是依赖每个 MCP handler 手工调用 invalidation。

加入并发和破坏性测试，至少包括：

* 30–100 个并发 Summary 请求。
* refresh 过程中修改 Issue。
* refresh 过程中修改 Git HEAD 或 worktree。
* refresh 过程中修改 Plugin 或 Check。
* refresh 失败后恢复。
* Controller 重启。
* 两个 repo、两个 checkout 同时请求。

## T3：完善真实 MCP 端到端性能路径

分析以下完整路径：

```text
ChatGPT / MCP Client
→ Stable ingress
→ MCP transport
→ session identity
→ repository routing
→ tool authorization/exposure
→ Controller handler
→ projection or runtime
→ serialization
→ response
```

寻找并修复有证据的重复成本，例如：

* 每次调用重复解析工具 schema。
* 重复加载 plugin manifest。
* 重复解析 repository registry。
* session routing 重复扫描。
* checkout identity 重复执行 Git 子进程。
* Controller handler 返回前重复序列化大型对象。
* Core facade 额外执行不必要的 capability discovery。
* stale hit 返回前仍执行阻塞扫描。
* MCP 错误重试造成重复执行。

不得为了降低工具数量而降低能力。

若 Advanced 133 工具在 schema 大小、工具选择和真实调用性能上没有明显问题，可以保留。

若发现工具重复，应基于功能重叠和实测影响处理，而不是为了凑到 128。

## T4：加强 Primary 与 Recovery 的故障隔离

上一轮实际尝试测试时出现：

* Primary `repo-harness6` 返回 502。
* Recovery MCP 同时网络不可达。

必须分析这是否说明 Primary 与 Recovery 共享了故障域。

检查：

* 是否共享同一个进程。
* 是否共享同一个反向代理。
* 是否共享同一个 Tailscale Serve/Funnel 路由。
* 是否共享同一个监听端口或认证入口。
* Stable Supervisor 崩溃时 Recovery 是否仍能访问。
* Tailscale 路由丢失时 Recovery 是否有独立恢复路径。
* Recovery 是否只是代码上独立，部署上并不独立。
* 是否存在外部探针持续验证两条入口。
* Primary 502 时是否会自动触发有界恢复。
* 自动恢复是否可能形成重启风暴。

目标：

* Primary 失败时 Recovery 仍可查询状态并执行有界恢复。
* Recovery 失败不能影响 Primary。
* 已知良好 release 可以安全回滚。
* 重连 Primary connector 不要求修改代码。
* 所有恢复动作有 request ID、审计证据和幂等性。
* 不进行未经证据支持的破坏性回滚。

需要加入实际故障注入或受控验证：

* 停止 Primary 服务。
* 保留 Recovery。
* 验证 Recovery 外部可达。
* 恢复 Primary。
* 验证 Connector 重连。
* 模拟错误 active slot。
* 验证 previous known-good rollback。
* 验证不会覆盖当前仓库未提交工作树。

## T5：验证 Process Runtime 和 Scheduler 的真实收益

Process Runtime：

* 正常运行时使用直接增量流，不恢复 100ms 文件 tail 轮询。
* Controller 重启恢复后日志游标正确。
* stdout/stderr 不丢行、不重复、不乱序。
* 高频日志有背压或有界缓冲。
* 日志文件截断、轮转、删除有明确语义。
* 进程结束后 watcher 和资源能释放。
* 1、5、20 个并发进程时资源增长合理。

Scheduler：

* `fs.watch` 是主唤醒路径。
* fallback 只是容错路径。
* 空闲时不得保持高频 10–50ms 文件轮询。
* 队列活跃时可以暂时提高检查频率，但必须有上限。
* macOS `fs.watch` 合并或漏事件时不会永久睡眠。
* watcher 关闭后无句柄泄漏。
* 多次 restart 不重复注册 watcher。

为这些行为增加确定性测试和必要的资源指标。

## T6：完善 Context Pack 缓存

验证并补齐：

* 缓存 key 包含 repo、checkout、HEAD 和必要的 ignore fingerprint。
* `.gitignore`、`.git/info/exclude`、全局 ignore 变化能失效。
* tracked、untracked、deleted、renamed 文件语义明确。
* known_paths 和 query 不错误复用结果。
* symlink、submodule、worktree 可正确处理。
* 大仓库不会无限扫描。
* 缓存具有容量上限或 LRU/TTL。
* checkout 删除后缓存可回收。
* HEAD 不变但 worktree 变化时不会返回错误旧清单。
* 不缓存敏感文件内容，只缓存必要索引和元数据。

## T7：增加性能与架构回归门禁

门禁应围绕能力和真实成本，不机械规定工具数量。

建议至少加入：

### 确定性门禁

* fresh Summary 不得调用完整 `projectBoard()`。
* fresh Summary 不得启动 Git 子进程。
* 同一 generation 并发 refresh 必须 single-flight。
* 旧 generation 不得覆盖新 projection。
* Summary payload 有合理上限。
* Core 必须保留启动、状态、上下文、执行、验证、恢复所需主路径。
* Advanced 必须覆盖日常完整开发能力。
* Full 保留全部原子和兼容能力。
* 不得重新引入 100ms 常驻日志文件轮询。
* Scheduler 空闲时不得重新引入 10–50ms 文件轮询。
* Context Pack 缓存必须有失效和容量控制。
* Recovery 必须独立于 Primary 的主要进程故障域。

### 趋势门禁

性能数字不应使用过度脆弱的绝对纳秒门槛。

采用：

* 基准样本数量。
* p50、p95、p99。
* 相对于已提交基线的退化比例。
* 合理噪声区间。
* CI 与本机结果分开记录。

性能结果至少输出机器、Node 版本、进程模式、Issue 数量、缓存状态和运行次数。

---

# 工具面评估方式

不要先决定工具数量再改实现。

应生成工具面报告，至少包含：

| 指标                   | Core | Advanced | Full |
| -------------------- | ---: | -------: | ---: |
| 工具数量                 |      |          |      |
| schema 字节数           |      |          |      |
| `tools/list` p50/p95 |      |          |      |
| 首次会话加载时间             |      |          |      |
| 高频任务覆盖率              |      |          |      |
| facade 可覆盖能力         |      |          |      |
| 语义重复工具数              |      |          |      |
| 专用低频工具数              |      |          |      |
| 不可替代能力数              |      |          |      |

基于报告决定是否调整。

允许：

* Advanced 保持 133。
* Advanced 高于或低于 133。
* Core 高于或低于 17。

前提是有事实证明能力和体验更好。

禁止：

* 为满足 128 删除有效能力。
* 仅因数量小就认为 Core 更快。
* 把底层能力删除来降低 schema。
* 让 facade 成为没有完整错误语义的黑盒。
* Core 返回模糊的“工具不存在”，导致用户不知道如何切换能力面。

Core 不支持能力时，应返回结构化信息，至少说明：

* `unsupported_in_core`
* 所需 capability 或 toolset
* 是否可通过 facade 完成
* 推荐切换到 Advanced 还是 Full
* 不自动进行高风险切换

---

# 修改与提交策略

1. 不在包含用户测试删除的原始工作树直接形成混合提交。
2. 确认第一轮变更文件清单。
3. 创建隔离 worktree 或使用现有正确隔离 checkout。
4. 将第一轮性能相关变更精确迁移到隔离 worktree。
5. 在隔离环境继续第二轮。
6. 每个 Task 使用有界 Edit Session 或 Work。
7. 每一批修改保持可审查。
8. 不进行大规模无关格式化。
9. 不顺手修改无关功能。
10. 先补测试和观测，再进行高风险重构。
11. 所有修改提交到明确分支。
12. 完整验证后合并到目标分支。
13. 合并后删除隔离 branch、worktree、临时 checkout 和无用 Edit Session。
14. 不删除仍有证据价值的 Run、benchmark 和发布证据。

---

# 验证要求

必须运行当前仓库实际存在的检查，不要假设名称。

至少覆盖：

* 类型检查。
* Controller 测试。
* MCP/toolset 测试。
* Projection/SWR 并发测试。
* Process Runtime 测试。
* Scheduler 测试。
* Context Pack 测试。
* SQLite/架构同步。
* Issue/Task/工作流同步。
* Recovery/Stable Supervisor 测试。
* 完整 task gate。

如果原始工作树的用户测试删除导致 gate 失败：

* 不修改用户工作树。
* 在隔离 worktree 使用干净基线和本轮变更运行 gate。
* 记录原始工作树失败原因。
* 不把该失败误归因于性能实现。
* 不通过降低测试数量门槛来掩盖问题。

所有检查需要保存：

* 命令。
* revision。
* 工作目录。
* exit code。
* duration。
* stdout/stderr 摘要。
* 完整日志或 result reference。

---

# 切换最新实现

第二轮实现完成、提交、合并且正确性验证通过后，必须将 Stable Runtime 切换到最新合并 revision。

切换前：

1. 记录当前 active、previous、known-good slot。
2. 验证新 revision 已提交且工作树干净。
3. 构建或准备新的 release slot。
4. 运行离线正确性检查。
5. 验证 Recovery MCP 在切换过程中保持可达。
6. 准备明确的 previous known-good rollback。

切换时：

* 使用 Controller/Stable Supervisor 正式发布流程。
* 不直接手工替换正在运行的文件。
* 不让运行时指向未提交工作树。
* 不跳过 release evidence。
* 不覆盖用户仓库工作树。
* 不删除 previous known-good slot。

切换后只执行可用性与正确性 smoke test：

* Primary MCP 外部可达。
* Recovery MCP 外部可达。
* `session_start` 成功。
* `session_bind_repository` 成功。
* `controller_context` Summary 成功。
* Detail 成功。
* Core、Advanced、Full 暴露符合实现。
* 至少一个只读 Git/Issue/Check 请求成功。
* 至少一个受控 Process Runtime 请求成功。
* Stable Supervisor 报告 active revision 与最新合并 commit 一致。
* Connector 已重新连接。
* 没有持续 502。
* 没有 crash loop。
* previous known-good rollback 仍然可用。

不要在本会话宣称完成正式性能验收。

---

# 交接给下一性能测试会话

切换并完成 smoke test 后停止继续优化，输出一份完整交接。

交接必须包含：

## 代码与 Git

* 最终 commit SHA。
* 合并 commit SHA。
* 目标分支。
* active runtime revision。
* previous known-good revision。
* 工作树是否干净。
* 临时 branch/worktree 是否已清理。

## Issue/Task/Work

* 使用的 Issue ID。
* 完成的 Task ID。
* Work ID。
* Run/Job ID。
* Edit Session ID。
* 当前状态。
* 未完成项。

## 实现摘要

* 第一轮和第二轮分别解决了什么。
* 修改文件清单。
* 关键架构决定。
* 保留 Advanced 当前工具数量的理由，或调整工具面的证据。
* SWR、Recovery、Process Runtime、Scheduler、Context Pack 的最新语义。

## 验证证据

* 所有检查结果。
* smoke test 结果。
* 外部 Primary 与 Recovery 可达结果。
* 已知失败及其归属。
* benchmark 脚本位置。
* 运行 benchmark 所需命令。
* 结果文件位置。

## 下一会话性能测试入口

明确告诉下一会话：

1. 当前已经切换到哪个 runtime revision。
2. 哪些测试不能重复修改代码。
3. 应先执行只读性能测试。
4. 应测试：

   * cold/fresh/stale/detail
   * SWR concurrency
   * local MCP E2E
   * external MCP E2E
   * Core/Advanced/Full schema 与调用成本
   * idle CPU/wakeup
   * Process Runtime concurrency
   * Scheduler fallback
   * Context Pack 大仓库缓存
   * Primary/Recovery 故障注入
5. 性能测试发现缺陷后，再决定是否创建第三轮 Task。
6. 不应预设 128、133、17 或其他固定工具数量是正确答案。

最终交接必须足够让新的 ChatGPT 会话直接开始性能测试，不需要依赖聊天记忆或猜测当前状态。

---

# 完成标准

只有同时满足以下条件，第二轮才能标记完成：

* 第一轮改动已经从用户无关变更中安全隔离。
* 第二轮缺陷已经修复。
* SWR 并发和 generation fencing 有测试证明。
* Primary 与 Recovery 的故障域得到实际验证。
* Process Runtime 和 Scheduler 没有明显资源回退。
* Context Pack 缓存失效与容量语义明确。
* 工具面由能力和实测数据决定，而不是固定数量决定。
* 正确性检查和完整 gate 在隔离干净环境通过。
* 修改已提交并合并。
* Stable Runtime 已切换到最新合并 revision。
* Primary 和 Recovery 都可外部访问。
* previous known-good rollback 保留。
* 临时 worktree、branch、checkout 和无用 session 已清理。
* 已输出完整性能测试交接。
* 未把 smoke test 冒充正式性能验收。

执行过程中持续汇报关键发现，但不要频繁输出低层命令。发现架构假设错误、故障域未隔离、运行时切换风险或用户工作树污染风险时，应立即暂停对应危险动作，先修正执行路径。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Execute captured plan: 第二轮性能、可靠性与运行时收敛计划
