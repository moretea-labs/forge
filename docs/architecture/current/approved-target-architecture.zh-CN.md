# 已批准的 Forge 目标架构

> 状态：**Approved Architecture Input**  
> 日期：2026-06-25  
> 本文保留本轮重构所依据的用户目标架构原文；运行时落实情况见 [`target-requirements-traceability.md`](target-requirements-traceability.md)。

Forge 目标架构清单
一、总体判断

现在的 Forge 已经不是一个简单的 MCP 工具集，也不只是一个“让 ChatGPT 调 Codex”的桥。

它实际上正在演化成一个：

面向多个本地代码仓库、由上层 AI 负责决策、以文件状态为事实源、可调度多个 Agent、可恢复执行、可验证交付的工程控制系统。

当前最核心的问题不是功能不足，而是：

控制面、调度面和执行面还没有彻底分离。

目前同一个 MCP/Node 进程既负责：

HTTP/MCP 会话
仓库选择
状态读取
锁管理
长命令执行
检查任务
Agent 调度
部分状态恢复

这意味着一个同步命令、一次大范围扫描、一个长期持有的仓库锁，都可能拖住整个事件循环，最终表现为：

短查询也出现 502
长任务结果丢失
同一个任务重复启动
一个项目阻塞其他项目
MCP 连接断开后不知道任务到底有没有执行
Controller 重启后只能靠扫描和猜测恢复

所以目标架构不应继续在现有链路上逐个加特殊处理，而应明确收敛为：

Thin Gateway + Global Scheduler + Per-Repository Actor + Durable Job + Isolated Worker + Evidence Plane

中文可以称为：

薄网关、全局调度、仓库自治、持久任务、隔离执行、证据闭环。

二、当前架构清单
1. 接入层：MCP Gateway

当前实现主要位于：

src/cli/mcp/server.ts
src/cli/mcp/transports/http.ts
src/cli/mcp/multi-repository.ts
src/cli/mcp/tools.ts

当前职责：

OAuth/Bearer 鉴权
Streamable HTTP MCP Session
工具定义和参数校验
仓库选择
多仓库上下文注入
直接调用工具实现
拼装完整返回结果
当前优点
已支持稳定 repoId
已支持 checkoutId
已支持多仓库选择
MCP 工具按 Profile 控制权限
有 /health
有 Tool Surface、Schema Version、Fingerprint
当前问题

http.ts 中的请求处理会等待整个工具调用：

handleMcpPost
  -> transport.handleRequest
     -> callMultiRepositoryTool
        -> callMcpTool
           -> 实际工作执行结束

也就是说，MCP 请求和实际工作仍然在同一条调用栈中。

另外：

src/cli/repositories/command-executor.ts

仍存在 spawnSync 执行命令的路径。它最多可以阻塞十几分钟。即使异步版本使用 spawn，如果 MCP Handler 一直 await 到任务结束，外部代理仍会超时。

目标定位

MCP Gateway 以后只允许做四件事：

鉴权
参数校验
读取轻量快照
创建持久 Job 并立即返回 ID

任何可能超过 1～2 秒的操作，都不能在 MCP 请求线程里完成。

2. 全局仓库控制层

当前实现主要位于：

src/cli/repositories/registry.ts
src/cli/repositories/types.ts
src/cli/repositories/runtime-storage.ts
src/cli/repositories/workbench.ts
src/cli/repositories/umbrella.ts

当前已有：

稳定 repoId
一个仓库多个 Checkout
Git Remote 映射
GitHub 插件映射
Controller Home
每仓库独立运行存储
Umbrella 跨仓库任务的初步模型

这是很重要的基础，应该保留。

当前问题

Umbrella 目前更像一个跨仓库状态聚合对象，还不是完整调度模型：

没有跨仓库 DAG
没有失败补偿策略
没有资源预算
没有跨仓库依赖门
没有分阶段发布协议
没有公平调度
目标定位

全局控制层只负责：

注册仓库
为每个仓库创建独立 Repo Actor
分配全局 Agent 并发资源
维护跨仓库工作流
做公平调度
管理全局发布窗口和系统级限流

它不能直接修改某个仓库的 Task、Run 或工作区。

3. 仓库控制层：Repo Actor

目前这部分职责分散在：

src/cli/controller/*
src/cli/local-bridge/*
src/cli/repositories/locks.ts
src/cli/agent-jobs/*

目标架构里，每个仓库应有一个逻辑上的 Repo Actor。

不一定立刻使用真正的 Actor Framework，但语义必须一致：

一个仓库的所有调度决策，都经过它自己的单线程邮箱顺序处理。

Repo Actor 负责：

当前仓库的 Requirement/Work 状态
任务依赖
资源占用
工作区写入权
Worktree 分配
检查排队
集成队列
发布冻结
运行状态恢复

不同仓库拥有不同 Repo Actor，因此：

Repository A 卡住
≠ Repository B 卡住

这会成为多项目并行能力的核心边界。

4. Workflow 层：Issue 与 Task

当前实体设计基本正确，位于：

src/cli/controller/types.ts
src/cli/controller/issue-store.ts
src/cli/controller/task-status-resolver.ts

当前模型：

Issue
  -> Task
      -> Run 1
      -> Run 2
      -> Verification

其中一个非常正确的设计是：

Task 表达业务意图，Run 表达执行事实。

task-status-resolver.ts 已经明确：

只有最新 Run 可以成为当前生命周期拥有者
历史 Run 只是证据
老 Run 不能让已完成 Task 复活
Task 的显式终态优先
失败 Run 必须显式 Retry
Superseded Task 可以迁移依赖

这部分应当升级为正式架构规则，不允许后续代码绕开。

架构规则
Issue：需求或缺陷容器
Task：可独立验收的工作单元
Run：一次执行尝试
Job：一次系统异步操作
Verification：针对某个精确 Revision 的证据
Acceptance：业务层最终认可

Run 成功不等于 Task 完成。

Run succeeded
  -> Integration
  -> Verification
  -> Acceptance
  -> Task done
5. Direct Edit 层

当前实现：

src/cli/editing/edit-session.ts

这部分是现有架构里最成熟的能力之一：

Allowed Paths
SHA-256 前置条件
多 Revision
Savepoint
Backup
Rollback
Aggregate Diff
Named Checks
Finalization

应继续坚持：

已知且边界明确的修改，优先 Direct Edit，而不是启动 Agent。

Direct Edit 使用条件

适合：

修改目标已知
改动通常不超过 8 个文件
不需要大范围探索
不需要长时间自主编译修复循环
风险可控
可以用局部测试验证

不适合：

大范围跨模块调查
不知道根因
需要不断编译、测试、修正
需要多个方案比较
需要长时间运行
6. Agent Run 层

当前实现：

src/cli/agent-jobs/job-manager.ts
src/cli/agent-jobs/job-worker.ts
src/cli/agent-jobs/integration.ts
src/cli/agent-jobs/types.ts

已有强项：

Run 持久化
Agent 可运行时选择
Workspace/Worktree/GitHub 三种模式
PID、Heartbeat、Deadline
stdout、stderr、result、events
Retry 保留历史
集成记录
自动集成状态
GitHub Copilot Session
目标定位

Agent Run 是：

Task 的一次实施尝试，而不是万能后台任务。

例如以下事情不应该伪装成 Agent Run：

单纯执行测试
验证 Edit Session
Git 命令
发布检查
周期巡检
状态同步

这些应是不同类型的 Durable Job。

7. Local Job 层

当前实现：

src/cli/local-bridge/job-store.ts
src/cli/local-bridge/types.ts

当前 Local Job 支持：

launch-task
quick-agent-session
run-check

并已经具备：

状态持久化
Atomic JSON
Event Log
Active Index
Deadline
Owner PID
Worker PID
Orphan Recovery
Request ID 的部分支持

这是正确方向，但现在 Local Job 和 Agent Run 的职责边界还不够清楚。

目标模型

统一定义一个系统级 Job：

ExecutionJob
  ├─ DispatchTaskJob
  ├─ AgentRunJob
  ├─ CheckJob
  ├─ VerifyEditJob
  ├─ RepositoryCommandJob
  ├─ IntegrationJob
  ├─ ReleaseGateJob
  ├─ ReconciliationJob
  └─ ScheduledOccurrenceJob

其中：

Job 是系统工作单元
Run 是 Agent 执行尝试
一个 Job 可以创建或关联一个 Run
Job 生命周期不能和 Run 生命周期混为一体

例如：

DispatchTaskJob
  -> 创建 Agent Run
  -> Job 状态 dispatched
  -> 等待 Run 终态
  -> Job 状态 succeeded/failed
三、目标架构拓扑
                         ┌─────────────────────┐
                         │ ChatGPT / Local UI  │
                         │ CLI / GitHub Plugin │
                         └──────────┬──────────┘
                                    │
                         short request / query
                                    │
                    ┌───────────────▼───────────────┐
                    │       Thin MCP Gateway         │
                    │ auth / validate / route / ack  │
                    └───────────────┬───────────────┘
                                    │
                            durable command
                                    │
                    ┌───────────────▼───────────────┐
                    │      Global Control Plane      │
                    │ registry / scheduler / quota   │
                    │ portfolio / cross-repo DAG     │
                    └───────┬───────────────┬────────┘
                            │               │
                 ┌──────────▼─────┐ ┌──────▼──────────┐
                 │ Repo Actor A   │ │ Repo Actor B    │
                 │ mailbox        │ │ mailbox         │
                 │ claims/leases  │ │ claims/leases   │
                 └──────┬─────────┘ └────────┬────────┘
                        │                    │
                ┌───────▼────────────────────▼───────┐
                │          Durable Job Queue          │
                │ requestId / state / events / lease  │
                └───────┬────────────────────┬────────┘
                        │                    │
               ┌────────▼────────┐  ┌────────▼────────┐
               │ Worker Process  │  │ Worker Process  │
               │ command/check   │  │ Codex/Claude    │
               └────────┬────────┘  └────────┬────────┘
                        │                    │
                ┌───────▼────────────────────▼───────┐
                │ Evidence / Artifacts / Event Ledger │
                └─────────────────────────────────────┘
四、架构宪法

后续所有新增功能都必须遵守以下规则。

宪法 1：MCP 不执行长任务

MCP Handler 的目标响应时间：

轻量读取：500ms 以内
复杂快照：2 秒以内
写入/执行请求：持久化后立即返回

标准返回：

{
  "accepted": true,
  "jobId": "JOB-...",
  "status": "queued",
  "next": "Call get_job"
}

禁止：

MCP 内直接 spawnSync
MCP 内等待 Agent 结束
MCP 内等待完整测试结束
MCP 内持有仓库锁几十秒
MCP 内扫描全部历史记录
MCP 返回完整日志
宪法 2：先持久化，再执行

正确顺序：

validate
-> persist intent
-> assign requestId
-> persist Job
-> return Job ID
-> worker starts

禁止：

spawn process
-> later try to save state

否则连接断开后系统不知道任务是否已经启动。

宪法 3：所有修改操作必须幂等

每个写入或执行请求都必须有：

requestId
repoId
operationType
semanticKey

推荐语义键：

requestId = caller + action + repoId + logical-request

Schedule 触发则使用：

requestId = scheduleId + repoId + occurrenceWindow

同一 Request ID：

不得创建重复 Job
不得创建重复 Run
不得重复执行发布
不得重复创建 Issue
宪法 4：Task 与 Run 永远分离

Task 是意图；Run 是尝试。

必须保持：

Task 1
  Run A failed
  Run B succeeded

不能通过修改 Run A 把它“变成成功”。

Retry 必须生成新 Run。

宪法 5：每个仓库只有一个调度所有者

一个 Repo Actor 是该仓库调度状态的唯一所有者。

它可以允许多个 Worker，但：

谁可以运行
用哪个工作区
是否冲突
是否进入集成队列
是否进入发布冻结

只能由 Repo Actor 决定。

宪法 6：未知 Scope 必须保守处理

当前实现中没有 Allowed Paths 时，不一定判定冲突，这在 Workspace 并发时风险较大。

目标策略：

allowedPaths 为空
=> write scope = repo-content:*

也就是和所有写入任务冲突。

除非该任务被明确归类为只读。

宪法 7：锁只保护状态事务，Lease 才保护长执行

当前 withControllerLockAsync 可能持有 Repository Lock 等待整个工具完成。

目标拆分：

短事务锁

用于：

创建 Job
修改 Task
更新索引
领取资源

持续时间应以毫秒计算。

执行 Lease

用于：

Workspace 写入权
Heavy Check
Git Ref 修改
Release Freeze
Worktree Slot

Lease 必须有：

leaseId
resourceKey
ownerJobId
fencingToken
acquiredAt
expiresAt
heartbeatAt

并支持续租。

状态写入时需要校验 Fencing Token，防止旧 Worker 复活后覆盖新状态。

宪法 8：所有热路径必须依赖索引

禁止热路径扫描全部历史。

至少维护：

active-jobs index
request-id index
task-to-runs index
repo-resource-claims index
schedule-active-occurrence index
pending-integration index

历史数据用于审计，不用于每次状态查询。

宪法 9：执行和观察必须隔离

长任务运行期间，下列查询必须始终可用：

health
repository_get
controller_context
get_job
get_run
local_bridge_status

因此：

Worker 不得运行在 MCP Gateway 事件循环
Heavy Check 不得阻塞状态读取
日志读取必须有 maxBytes
快照必须使用 Materialized View
宪法 10：验证绑定精确 Revision

一次验证结果必须绑定：

repoId
checkoutId
revision
command/checkId
environmentFingerprint
executedAt

Repository Revision 变化后，旧验证应变为：

stale

而不是继续当作成功证据。

宪法 11：冲突默认排队，不默认失败

资源冲突不是错误，而是调度状态。

例如：

waiting_for_workspace
waiting_for_heavy_check
waiting_for_integration
waiting_for_release_barrier
waiting_for_dependency

只有以下情况才失败：

Scope 违反
不可恢复状态损坏
明确 Fail Fast
Deadline 到期
人工取消
验证失败
宪法 12：外部副作用必须人工授权

以下操作不能由循环任务自动执行：

push
merge
publish
production deploy
删除分支
force push
reset/rebase
数据库破坏性变更
对外关闭 Issue

自动化可以准备发布，但不能擅自发布。

五、任务分派策略
1. 第一阶段：工作模式选择

输入需求后，先产生 WorkAssessment：

理解是否充分
目标文件是否已知
预计文件数
预计改动行数
是否需要探索
是否需要依赖图
是否需要并发
是否长时间检查
风险等级
外部副作用
Direct Edit

选择条件：

已理解实现
Scope 明确
改动边界较小
不需要长时间探索
可以局部验证
Quick Agent

选择条件：

目标明确
实现需要探索
不需要长期 Issue DAG
可以一次 Agent 会话完成
失败后可以整体重试
Issue → Task

选择条件：

多步骤依赖
高风险
跨模块
跨仓库
需要多个 Agent
需要长期跟踪
需要发布门
需要周期执行
2. Agent 角色划分

不应该把所有 Agent 都当成相同的“代码生成器”。

Controller / Architect

职责：

理解需求
架构设计
Task 拆分
Scope 定义
风险和冲突决策
审核结果

一般由 ChatGPT 承担。

Explorer

职责：

只读调查
架构定位
根因分析
产生候选文件和方案

不允许修改代码。

Implementer

职责：

在限定 Scope 内实现
执行局部测试
产出 Diff

Codex、Claude 都可以担任。

Verifier

只在高风险任务需要，职责：

按原 Task Acceptance Criteria 验证
不允许自己发明新的评价标准
不允许把“代码看起来不错”当作验收
Integrator

应该是确定性程序，不应交给 LLM。

职责：

检查 Base Revision
检查 Diff
应用 Patch
检测冲突
记录 Integration Evidence
Release Steward

职责：

检查发布屏障
生成发布清单
等待用户授权执行外部副作用
3. Agent 选择策略

Task 不永久绑定 Agent。

运行时根据任务能力选择：

场景	默认方式
已知小改动	Direct Edit
大范围代码探索和反复测试	Codex
架构、文档、跨模块语义梳理	Claude 或 ChatGPT
GitHub PR 协作	GitHub Copilot
只读排查	Explorer Agent
确定性集成	程序执行，不用 Agent

Agent 失败后不能盲目切换 Agent。要先分类：

infrastructure failure
scope conflict
implementation failure
acceptance failure
environment failure
agent capability mismatch

只有最后一种才优先换 Agent。

六、单项目并发与冲突策略
1. 资源 Claim 模型

不能只用文件路径判断冲突，应声明资源：

repo-state
workspace:<checkoutId>
worktree:<worktreeId>
path:<glob>
git-index:<checkoutId>
git-refs:<repoId>
heavy-check:<repoId>
integration:<repoId>
remote:<repoId>
release:<repoId>
2. 冲突矩阵
工作类型	是否允许并发	策略
纯读取	是	不加写锁
状态查询	是	读取快照
两个 Direct Edit	默认否	同 Checkout 单写者
Workspace Agent + Direct Edit	否	后者排队
两个 Workspace Agent	否	只能一个
两个 Worktree Agent	可以	独立 Worktree
Worktree Agent 路径重叠	可以执行	但集成时串行检查冲突
Light Check	可以配置并发	设置每仓库上限
Heavy Check	默认每仓库一个	进入队列
Git Ref 修改	否	Repo Exclusive
Integration	否	串行 Integration Queue
Release	否	启动 Release Freeze
Remote Write	否	明确授权、串行
3. 默认执行位置

遵循你的工作习惯：

单个串行任务
=> 当前 Workspace

检测到并发写入
=> 新任务进入 Worktree

用户明确要求隔离
=> Worktree

外部 GitHub Agent
=> GitHub Branch/PR

不能为了“看起来安全”而所有任务都建立 Worktree，否则会带来大量：

集成延迟
残留 Worktree
冲突处理
分支清理
状态漂移
4. Worktree 集成策略

并发 Worktree 可以同时实现，但集成必须串行。

Run 完成
-> 检查 Diff
-> 进入 Integration Queue
-> 校验 Base Revision
-> 校验主工作区状态
-> 应用补丁
-> 运行受影响检查
-> 记录 Integration Evidence
-> 清理 Worktree

若主分支发生变化：

不自动 rebase
不自动 reset
不静默覆盖
尝试确定性 Patch Integration
有冲突则进入 integration_conflict
保留 Worktree 等待修复
七、多项目并发策略
1. 全局调度器

多个项目之间不能共用 Repository Lock。

全局调度器只控制系统资源：

maxAgentProcesses
maxHeavyChecks
maxConcurrentRepositories
perAgentQuota
perRepoQuota
memoryBudget
cpuBudget

例如：

全局最多 4 个 Agent
每个仓库最多 2 个写入 Worker
每个仓库最多 1 个 Heavy Check
全局最多 2 个 Heavy Check
2. 公平调度

建议使用：

Aging Weighted Fair Queue

排序因素：

priority
wait time
dependency criticality
user initiated vs scheduled
risk
estimated cost
repo quota

优先级建议：

P0 外部故障/系统不可用
P1 用户显式任务
P2 当前 Issue 后续任务
P3 自动巡检修复
P4 健康扫描和优化建议

Schedule 任务不能长期挤占用户显式任务。

3. 跨仓库工作流

Umbrella 应升级为：

PortfolioWorkflow
  -> RepositoryTask A
  -> RepositoryTask B depends on A
  -> RepositoryTask C independent

跨仓库不应尝试“分布式原子事务”。

采用 Saga：

Prepare
-> Execute per repository
-> Verify per repository
-> Commit checkpoint
-> Continue dependent repositories
-> Compensate or stop on failure

例如一个 API 改动涉及三个项目：

Backend schema
  -> SDK generation
     -> Client migration

Backend 失败时，其他项目不能继续。

但无依赖的其他仓库任务仍可正常运行。

八、循环任务与 Schedule 架构

循环任务不能设计成：

启动一个 Agent
-> 让它永远循环

正确设计应是：

每次 Schedule 只产生一个有边界的 Occurrence。

1. 新增实体
Schedule
Trigger
Occurrence
Decision
Job
Outcome
Schedule

定义长期策略：

{
  "scheduleId": "SCH-...",
  "repoId": "repo-...",
  "trigger": {
    "type": "interval",
    "everyMinutes": 60
  },
  "policy": {
    "maxActiveOccurrences": 1,
    "maxFailures": 3,
    "cooldownMinutes": 120,
    "dailyBudgetMinutes": 180
  },
  "stopConditions": [
    "release_ready",
    "external_blocker",
    "human_review_required"
  ]
}
Occurrence

Schedule 的一次触发：

OCC-scheduleId-timeWindow

每个时间窗口只能创建一个 Occurrence。

2. 每次循环流程
Trigger
-> acquire schedule lease
-> read compact repo snapshot
-> deterministic triage
-> persist decision
-> no-op / create Task / create Job
-> execute one bounded unit
-> verify
-> record outcome
-> release lease

循环任务首先应该是 Triage Agent，而不是直接写代码。

它可以得出：

nothing_to_do
continue_existing_task
retry_infrastructure_failure
create_bug_task
create_improvement_candidate
release_ready
human_attention_required
3. 循环防失控策略

必须包含：

同一 Schedule 最多一个 Active Occurrence
同一问题有 Semantic Dedupe Key
最大连续失败次数
指数退避
每小时/每日预算
最大 Agent Run 数
Workspace Dirty 时不自动写入
Release Freeze 时不启动修改
外部服务异常时只记录，不无限重试
已经存在同类 Issue 时不重复创建
自动创建需求必须先进入 Candidate 状态
自动新增需求规则

Schedule 可以创建：

candidate finding

只有满足以下之一才升级为正式 Task：

可复现 Bug
检查明确失败
有结构化证据
连续多个周期出现
用户要求自动处理此类问题

不能因为 Agent “觉得可以优化”就不断创建需求。

九、状态存储架构

目前 file-backed 是正确方向，不建议现在立刻改成数据库。

目标分三类状态。

1. 业务意图状态

可追踪、可审查：

tasks/issues/
architecture decisions
release manifests
exported reports

可以进入 Git。

2. Controller Runtime 状态

位于 Controller Home：

repositories/<repoId>/
  jobs/
  runs/
  schedules/
  occurrences/
  leases/
  indexes/
  worktrees/
  edit-sessions/
  materialized-views/

不进入 Git。

3. Evidence 与 Artifact
checks/
logs/
diffs/
command-results/
integration-records/
release-evidence/

按 ID 可寻址。

4. Event Log 与 Snapshot

推荐继续文件模式，但采用：

append-only event log
+
atomic materialized snapshot
+
bounded indexes

每个事件统一包含：

{
  "eventId": "...",
  "eventType": "...",
  "repoId": "...",
  "entityType": "job",
  "entityId": "...",
  "correlationId": "...",
  "causationId": "...",
  "requestId": "...",
  "revision": 12,
  "occurredAt": "..."
}

任何状态都应该能回答：

谁创建的
为什么创建
由哪个请求触发
当前由谁持有
上一个状态是什么
最终证据在哪里
十、502 问题的架构级解决方案

当前 502 不是单一 Bug，而是架构耦合的结果。

当前高风险点
1. MCP 和执行共享进程

http.ts 的 Handler 等待完整工具调用。

2. 同步子进程

command-executor.ts 中存在 spawnSync。

3. Repository Lock 包裹整个工具 Promise

multi-repository.ts 中 Repository Lock 可能持续到整个 Tool 完成。

4. 检查去重主要存在于内存

check-runner.ts 中：

activeAsyncChecks
heavyCheckQueues

Controller 重启后会丢失订阅和队列信息。

5. 一个进程承担所有仓库

即使多仓库状态隔离，一个事件循环被阻塞仍会影响全部仓库。

目标进程结构

至少拆为三个进程：

Forge-gateway
Forge-controller-daemon
Forge-worker
Gateway
MCP/HTTP
鉴权
快速读取 Materialized View
接受 Command
返回 Job ID
Canonical Forge Runtime
Scheduler
Repo Actors
Lease
Reconciliation
Schedule Engine
Job Queue
Worker
Agent CLI
Check
Repository Command
Integration
Release Gate

Worker 崩溃不能导致 Gateway 崩溃。

Gateway 重启不能取消已经接受的 Job。

健康检查拆分
/health

只检查 Gateway Event Loop，必须始终快速返回。

/ready

检查：

Canonical Forge Runtime
State Store
Worker Pool
Repository Registry
/repos/<repoId>/health

检查单个仓库状态。

十一、验证与发布架构
1. 分层验证
修改过程中

运行最小专项检查。

Task 完成前

运行 Task 声明的 Checks。

Issue 完成前

运行集成测试。

发布前

运行完整 Release Gate。

不能每个小修改都跑完整发布检查，也不能只因为局部测试通过就认为可发布。

2. 发布屏障

进入 Release Candidate 前，Repo Actor 创建：

release:<repoId>

独占 Lease。

Release Freeze 后：

不接受新的写入任务
Schedule 只能执行只读巡检
等待当前写入任务完成
等待 Integration Queue 清空

发布条件：

工作区干净
无活跃写入 Job
无活跃 Agent Run
无未集成 Worktree
无脏 Edit Session
无 Orphan Job
所有 Required Task 完成
验证绑定当前 HEAD
Registry Remote 与 Git Origin 一致
GitHub Mapping 一致
MCP / Controller / Worker 健康
Package Metadata 正确
Public Export 正确
Release Check 全部通过

然后输出：

release_ready

Push、Tag、Publish 仍需用户明确授权。

十二、Agent 设计的“艺术”

真正好的 Agent 系统不是让 Agent 尽可能自由，而是：

把判断留给最擅长判断的角色，把确定性操作交给程序，把风险留在清晰边界内。

这里有四个关键平衡。

1. 不要把 Controller 变成 Worker

Controller 应该：

看全局
做权衡
分派
审核

它不应该长时间占用在一次编译或写代码中。

2. 不要让 Worker 决定自己是否成功

Worker 可以报告：

implementation complete

但最终是否成功应由：

Check
Acceptance Criteria
Integration Result
Controller Review

共同决定。

3. 不要为每个任务增加独立 Verifier

独立 Verifier 不是越多越好。

只在以下情况使用：

高风险
业务逻辑复杂
安全敏感
实现者自测偏差明显

Verifier 的 Rubric 必须等于 Task Acceptance Criteria。

4. 自动化的目标不是“永远做事”

好的循环会经常返回：

nothing_to_do

它应该节制、安静、可暂停。

自动化的价值是：

在正确时间发现正确问题，而不是不断制造工作。

十三、推荐目录重构

后续可逐步收敛成：

src/runtime/
  gateway/
    mcp/
    http/
    auth/

  control-plane/
    global-scheduler/
    repo-actor/
    portfolio/
    governance/

  workflow/
    issues/
    tasks/
    schedules/
    occurrences/

  execution/
    jobs/
    runs/
    workers/
    agents/
    commands/
    checks/

  resources/
    claims/
    leases/
    workspaces/
    worktrees/
    integration/

  evidence/
    checks/
    diffs/
    artifacts/
    verification/
    release/

  repositories/
    registry/
    identity/
    storage/
    github/

  projections/
    snapshots/
    indexes/
    dashboard/

src/cli/mcp/tools.ts 当前超过四千行，已经承担过多职责。后续工具文件只应负责：

schema
-> command conversion
-> service call
-> compact response

不能继续承载业务实现。

十四、架构文档治理

当前文档存在明显代际漂移。

例如：

docs/architecture/index.md

仍写着 Forge 不是 MCP Server，但当前产品已经包含完整 MCP Controller Runtime。

另外 V5、V6、V7、V8 文档中存在：

手工集成与自动集成并存
Approval Queue 与无 Approval Queue 并存
Focus 是否是执行锁的表述不一致
Worktree 默认策略不一致

后续应明确：

docs/architecture/current/

作为唯一事实源。

旧文档统一标记：

Historical Design
Not Runtime Authority

建议建立以下当前文档：

architecture-overview.md
entity-model.md
job-and-run-lifecycle.md
scheduler-and-resource-claims.md
multi-repository-execution.md
workspace-and-worktree-policy.md
automation-and-schedule-engine.md
verification-and-release-gates.md
failure-recovery.md
architecture-invariants.md

所有代码改动如果违反这些文档，必须先创建 ADR。

十五、实施顺序
P0：先稳定系统
修复 502
禁止 MCP 直接执行长任务
Repository Command Job 化
Verify Edit Session Job 化
Gateway 与 Worker 解耦
状态接口保证非阻塞

这一步未完成前，不应增加循环执行功能。

P1：统一执行模型
建立统一 Execution Job
规范 Job 与 Run 的关系
所有写操作支持 Request ID
持久化 Active Index
加入 Lease 与 Fencing Token
统一终态和恢复语义
P2：Repo Actor 与资源调度
每仓库单独邮箱
Resource Claim
Workspace 单写者
Worktree 并发
Integration Queue
Heavy Check Queue
Unknown Scope 保守冲突
P3：多仓库调度
全局 Worker Pool
每仓库配额
公平队列
Portfolio DAG
跨仓库 Saga
单仓库故障隔离
P4：Schedule Engine
Schedule
Occurrence
Triage Decision
Budget
Backoff
Dedupe
Stop Condition
Candidate Requirement
Shadow Mode

Schedule 应先运行两周 Shadow Mode，只记录“本来会做什么”，不自动修改代码。确认决策准确后再开启执行。

P5：发布门
Release Freeze
Exact Revision Evidence
Full Gate
Release Manifest
Human Authorization
Push/Publish
十六、以后执行任务的标准流程

以后无论是 ChatGPT、Claude 还是 Codex，都应按照下面流程执行：

1. Resolve Repository
2. Read compact snapshot
3. Classify work mode
4. Create or select Requirement/Work
5. Declare scope and resources
6. Persist requestId
7. Repo Actor schedules work
8. Return Job ID immediately
9. Worker executes
10. Persist heartbeat and events
11. Reconcile terminal state
12. Review Diff
13. Integrate serially
14. Verify exact Revision
15. Accept Task
16. Evaluate next dependency
17. Enter release gate or stop

任何 Agent 都不允许跳过：

Scope
Resource Claim
Persistent Job
Evidence
Verification
最终设计结论

这套系统不应该继续被定义为“ChatGPT 调用本地 Agent 的 MCP”。

它更准确的定位应该是：

一个以仓库为自治边界、以上层 AI 为决策者、以持久 Job 为执行协议、以证据为完成标准、支持多个项目并行和周期自治的 Agent Engineering Control Plane。

最关键的三个设计选择是：

Gateway 永远保持轻薄，所有长任务 Job 化。
每个仓库由独立 Repo Actor 自治，不使用跨仓库粗粒度锁。
循环任务是一次次有边界的 Occurrence，而不是永不结束的 Agent。

这三条落实后，502、任务重复、冲突误判、状态失真、多项目互相拖累和循环失控，才会从架构层面得到解决，而不是继续靠补丁维持。
