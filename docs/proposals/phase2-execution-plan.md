# Phase 2 执行计划：简化 Forge 工作流

## 目标

基于 Phase 1 的成功（消除冗余会话读取），Phase 2 聚焦于：
1. **大幅简化 `isolation=reuse` 模式**的 Work 准备流程
2. **放开终端使用限制**，让模型自由使用 grep/find/git 等工具
3. **减少不必要的状态同步**，特别是在非隔离场景

## 当前问题分析

### 1. `isolation=reuse` 模式仍然太重

即使是 `isolation=reuse`（在当前分支工作），仍需要：
- 创建 WorkPrepareRequest
- 持久化 WorkHandle
- 创建 WorkContract
- 激活 Work phase
- 绑定 ExecutionSession
- 创建 GoalDelegation

**实际上只需要**：
- 确认当前 checkout 可用
- 绑定 session 到 repository
- 记录一个轻量级的"工作上下文"

### 2. 状态持久化过度

对于 reuse 模式：
- WorkHandle 写入 SQLite + JSON
- WorkContract 写入 SQLite
- ExecutionSession 写入 SQLite + JSON
- PrepareRequest 写入 JSON + SQLite

**实际上只需要**：
- ExecutionSession（用于恢复）
- 简单的 dirty 文件跟踪（用于回滚）

### 3. 验证开销重复

每次 Work 准备都要：
- 检查 Git 状态
- 验证权限快照
- 检查活动租约
- 验证 checkout 状态

**对于 reuse 模式可以**：
- 延迟验证，仅在实际修改前检查
- 缓存 Git 状态（几秒内有效）
- 合并多个检查为一次

## Phase 2 改进任务

### Task 1: 引入 LightweightWorkSession（2-3 天）

创建轻量级工作会话，用于 reuse 模式：

```typescript
interface LightweightWorkSession {
  sessionId: string;
  repoId: string;
  checkoutId: string;
  branch: string;
  startedAt: string;
  baselineHead: string;
  baselineDirtyPaths?: string[];  // 开始时的 dirty 文件
  // 不需要：WorkHandle, WorkContract, PrepareRequest
}
```

**实施**：
- `src/runtime/control-plane/execution/lightweight-session.ts`
- 仅内存 + 最小持久化（用于恢复）
- 跳过 WorkContract/WorkHandle 创建

### Task 2: 简化 prepareWork 的 reuse 路径（2-3 天）

修改 `work-preparation-service.ts`：

```typescript
export function prepareWork(ctx: McpExecutionContext, args: Record<string, unknown>) {
  const session = requireSession(ctx, args);
  const repository = selectedRepository(ctx, session, args, true);
  const isolation = requestedWorkPrepareIsolation(args) ?? 'auto';
  
  // 新增：快速路径 for reuse
  if (isolation === 'reuse' && !args.work_id) {
    return prepareLightweightSession(ctx, session, repository, args);
  }
  
  // 现有的完整 Work 流程
  // ...
}

function prepareLightweightSession(
  ctx: McpExecutionContext,
  session: ExecutionSessionContext,
  repository: ReturnType<typeof selectedRepository>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // 1. 快速验证（无需创建 WorkHandle）
  const baseStatus = repositoryGitStatus(repository);
  if (!baseStatus.branch) throw new Error('DETACHED_HEAD_NOT_SUPPORTED');
  
  // 2. 记录 baseline（用于后续 diff）
  const baselineDirtyPaths = baseStatus.clean ? undefined : [...currentDirtyPaths(repository.canonicalRoot)];
  
  // 3. 创建轻量级会话
  const lightSession = createLightweightSession({
    sessionId: session.sessionId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    branch: baseStatus.branch,
    baselineHead: baseStatus.head!,
    baselineDirtyPaths,
  });
  
  // 4. 绑定到 ExecutionSession
  const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.activeCheckoutId,
    // 不设置 activeWorkId - 轻量级会话不是完整 Work
  });
  
  return {
    session: nextSession,
    mode: 'lightweight',
    checkout: {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      branch: baseStatus.branch,
      head: baseStatus.head,
    },
  };
}
```

**收益**：
- 跳过 WorkContract/WorkHandle 创建
- 跳过 PrepareRequest 锁
- 减少 5+ 次数据库写入
- 准备时间从 ~50ms 降至 ~5ms

### Task 3: 延迟验证和缓存（1-2 天）

对于轻量级会话，延迟验证到实际需要时：

```typescript
// 当前：prepare 时验证所有
function prepareWork() {
  validatePermissions();
  validateGitStatus();
  validateLeases();
  validateCheckout();
  // ... 然后才创建 Work
}

// 改进：延迟到实际修改时
function prepareWork() {
  // 仅基本检查
  if (!repository.exists) throw error;
  // 其他验证延迟
}

function applyEdit() {
  // 实际修改前才验证
  validatePermissionsOnDemand();
  validateGitStatusOnDemand();
  // ...
}
```

### Task 4: 减少 Git 调用（1-2 天）

```typescript
// 当前：多次调用 git
const branch = gitBranch(root);
const head = gitHead(root);
const clean = gitClean(root);
const upstream = gitUpstream(root);

// 改进：一次调用获取所有
const gitStatus = getGitStatusOnce(root);  // 缓存 5 秒
// 从缓存读取
const branch = gitStatus.branch;
const head = gitStatus.head;
// ...
```

### Task 5: 放开终端限制（1 天）

创建"工具使用指南"，鼓励模型直接使用终端：

```markdown
# 工具使用指南

## 搜索代码

推荐直接使用：
- `grep -r "pattern" src/` - 简单快速
- `find src -name "*.ts" -mtime -7` - 查找文件
- `git log --grep="keyword" -n 20` - 搜索提交

仅在需要结构化上下文时使用 `rh_context.search`

## 理解代码

优先顺序：
1. `cat` - 读小文件
2. `head`/`tail` - 快速查看
3. `grep -A 5 -B 5` - 带上下文搜索
4. `codegraph explore` - 理解复杂关系
5. `rh_context` - 需要完整分析时

## 修改代码

直接场景：
- `git checkout -b feature` - 创建分支
- 编辑文件
- `npm test` - 运行测试
- `git commit` - 提交

需要隔离时才用 `work_prepare`
```

## 实施顺序

### Week 1: 基础设施
- [ ] Day 1-2: 创建 LightweightWorkSession 接口和存储
- [ ] Day 3-4: 实现 prepareLightweightSession 函数
- [ ] Day 5: 测试和验证

### Week 2: 集成和优化
- [ ] Day 1-2: 集成到 prepareWork 主流程
- [ ] Day 3: 实现延迟验证
- [ ] Day 4: 优化 Git 调用
- [ ] Day 5: 更新文档和指南

### Week 3: 验证和推广
- [ ] Day 1-2: 完整测试（单元 + 集成）
- [ ] Day 3-4: 在实际项目中验证
- [ ] Day 5: 收集反馈，准备发布

## 度量指标

### 性能指标
- **Work 准备时间**（reuse 模式）
  - 当前：~50ms
  - 目标：<5ms
  - 方法：time from prepare call to ready

- **数据库写入次数**（reuse 模式）
  - 当前：~8 次（WorkHandle + WorkContract + Session + PrepareRequest）
  - 目标：1-2 次（仅 Session）

- **Git 调用次数**（prepare）
  - 当前：4-10 次
  - 目标：1-2 次

### 代码指标
- **准备流程代码行数**
  - 当前：~200 行（prepareWork 主路径）
  - 目标：<50 行（轻量级路径）

- **状态机复杂度**
  - 当前：4 个状态对象（WorkHandle/Contract/Session/Request）
  - 目标：1 个（LightweightSession）

### 使用体验
- **模型工具调用模式**
  - 观察是否更多使用 grep/find/git
  - 观察是否更少使用 rh_context
  - 准备 Work 的频率是否下降

## 风险和缓解

### 风险 1: 破坏现有功能
**缓解**：
- 保持完整 Work 流程不变
- 轻量级模式作为新增路径
- 充分的测试覆盖

### 风险 2: 恢复能力下降
**缓解**：
- LightweightSession 仍然持久化基本信息
- 可以随时升级为完整 Work
- 保留 baseline 用于 diff 和回滚

### 风险 3: 权限和安全
**缓解**：
- 轻量级模式仍然检查基本权限
- 实际修改前执行完整验证
- 审计日志保持不变

## 成功标准

Phase 2 成功的标志：

1. ✅ **性能改善**：reuse 模式准备时间 <5ms
2. ✅ **代码简化**：轻量级路径 <50 行
3. ✅ **向后兼容**：所有现有测试通过
4. ✅ **实际验证**：在真实项目中工作良好
5. ✅ **模型体验**：更自然的工具使用模式

## 后续 Phase 3 预告

基于 Phase 2 的成功，Phase 3 将：
- 让轻量级模式成为默认
- 完整 Work 降级为"需要隔离时"的可选机制
- 进一步简化架构（删除不必要的抽象层）
