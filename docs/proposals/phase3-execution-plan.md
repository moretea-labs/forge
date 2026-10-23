# Phase 3 执行计划：性能优化

**目标**: 基于深度性能分析，实施批量写入、并发优化和缓存改进

---

## 📊 Phase 3 目标

### 性能目标

- **单请求延迟**: 114ms → 54ms (**52% 提升**)
- **并发能力**: 10 并发 1140ms → 54ms (**95% 提升**)
- **P99 延迟**: 500ms → 100ms (**80% 改善**)
- **吞吐量**: 8.8 req/s → 18.5 req/s (**2x**)

### 与 Phase 2 累计

- **轻量级模式**: 10x（已达成）
- **完整 Work**: 5x（2.5x Phase 2 + 2x Phase 3）
- **并发场景**: 10x（Phase 3）

---

## 🎯 优化任务

### P0: 最高优先级（最大收益）

#### Task 1: 批量写入优化
**预期收益**: 节省 ~28ms/10-patch 操作

**实施**:
1. 引入事务批处理机制
2. 合并多个 SQLite 写入到一个事务
3. 延迟 JSON 文件写入到操作完成后

**目标代码位置**:
- `src/runtime/control-plane/persistence/sqlite-store.ts`
- `src/runtime/control-plane/execution/work-operation-service.ts`

#### Task 2: 读写锁分离
**预期收益**: 并发场景 90% 提升

**实施**:
1. 实现读写锁机制
2. 将全局锁细化为资源级锁
3. 读操作使用共享锁，写操作使用独占锁

**目标代码位置**:
- `src/cli/repositories/locks.ts`
- `src/runtime/control-plane/execution/work-prepare-request-store.ts`

#### Task 3: 请求级缓存
**预期收益**: 节省 ~16-19ms

**实施**:
1. 引入 RequestContext 概念
2. Git 状态缓存提升到请求级别
3. 验证结果在请求内共享

**目标代码位置**:
- `src/runtime/control-plane/execution/validation-optimization.ts`
- `src/runtime/control-plane/execution/work-preparation-service.ts`

---

### P1: 重要优化

#### Task 4: 异步写入
**预期收益**: 节省 ~4-8ms

**实施**:
1. 非关键路径的写入异步化
2. 批量刷新机制
3. 保证数据一致性

#### Task 5: 消除重复验证
**预期收益**: 节省 ~8ms

**实施**:
1. 验证结果缓存和共享
2. 减少防御式重复检查
3. 明确验证边界

#### Task 6: SQLite 优化
**预期收益**: P99 延迟改善

**实施**:
1. 启用 WAL 模式
2. 调优参数（cache_size, page_size）
3. 预分配连接池

---

### P2: 改进项

#### Task 7: 对象池
**预期收益**: GC 压力降低

#### Task 8: 请求批处理
**预期收益**: 吞吐量提升

#### Task 9: 性能监控
**预期收益**: 持续优化能力

---

## 📅 实施时间表

### Week 1: P0 任务
- Day 1-2: Task 1 批量写入
- Day 3-4: Task 2 读写锁
- Day 5: Task 3 请求级缓存

### Week 2: P1 任务
- Day 1-2: Task 4 异步写入
- Day 3: Task 5 消除重复验证
- Day 4-5: Task 6 SQLite 优化

### Week 3: P2 + 验证
- Day 1-2: Task 7-9
- Day 3-4: 性能测试和调优
- Day 5: 文档和总结

---

## 🔧 技术方案

### 1. 批量写入机制

```typescript
// 新增事务批处理
interface BatchContext {
  transaction: SQLiteTransaction;
  pendingWrites: Write[];
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

export async function withBatchWrites<T>(
  fn: (ctx: BatchContext) => Promise<T>
): Promise<T> {
  const batch = createBatchContext();
  try {
    const result = await fn(batch);
    await batch.commit();
    return result;
  } catch (error) {
    await batch.rollback();
    throw error;
  }
}

// 使用
await withBatchWrites(async (batch) => {
  for (const patch of patches) {
    await applyPatch(patch, batch);
    await writeReceipt(patch, batch);
  }
});
```

### 2. 读写锁

```typescript
type LockMode = 'read' | 'write';
type LockScope = 'global' | 'repo' | 'work' | 'session';

interface LockOptions {
  scope: LockScope;
  resource: string;
  mode: LockMode;
  timeout?: number;
}

export async function withRWLock<T>(
  options: LockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const lock = await acquireLock(options);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}

// 读操作并发
await withRWLock({ scope: 'repo', resource: repoId, mode: 'read' }, async () => {
  return readData();
});

// 写操作独占
await withRWLock({ scope: 'work', resource: workId, mode: 'write' }, async () => {
  return writeData();
});
```

### 3. 请求上下文

```typescript
interface RequestContext {
  requestId: string;
  startedAt: number;
  
  // 缓存
  gitStatusCache: Map<string, CachedGitStatus>;
  permissionCache: Map<string, Permission>;
  validationCache: Map<string, ValidationResult>;
  
  // 批处理
  batchContext?: BatchContext;
  
  // 度量
  metrics: RequestMetrics;
}

export function createRequestContext(): RequestContext {
  return {
    requestId: generateId(),
    startedAt: Date.now(),
    gitStatusCache: new Map(),
    permissionCache: new Map(),
    validationCache: new Map(),
    metrics: createMetrics(),
  };
}

// 使用
export async function prepareWork(
  ctx: McpExecutionContext,
  args: Record<string, unknown>
): Promise<unknown> {
  const reqCtx = createRequestContext();
  
  // 所有操作共享上下文
  const status = await getGitStatus(repository, reqCtx);
  const permissions = await getPermissions(session, reqCtx);
  
  // 验证结果自动缓存
  const valid = await validate(data, reqCtx);
}
```

---

## ✅ 成功标准

### 性能指标

- [ ] 单请求延迟 <60ms（目标 54ms）
- [ ] 10 并发延迟 <100ms（目标 54ms）
- [ ] P99 延迟 <150ms（目标 100ms）
- [ ] 吞吐量 >15 req/s（目标 18.5 req/s）

### 质量指标

- [ ] 所有现有测试通过
- [ ] 新增性能测试覆盖
- [ ] 并发测试通过
- [ ] 架构检查通过

### 兼容性

- [ ] 100% 向后兼容
- [ ] API 行为不变
- [ ] 数据格式不变

---

## 🚨 风险和缓解

### 风险 1: 批量写入失败回滚

**缓解**:
- 完整的事务支持
- 失败时自动回滚
- 充分的错误处理测试

### 风险 2: 读写锁死锁

**缓解**:
- 锁超时机制
- 死锁检测
- 清晰的锁顺序规则

### 风险 3: 缓存不一致

**缓解**:
- 写入后立即失效
- 请求结束后清理
- 明确的缓存边界

### 风险 4: 并发竞争条件

**缓解**:
- CAS 操作保证原子性
- 乐观锁机制
- 充分的并发测试

---

## 📊 度量和监控

### 实时度量

```typescript
interface RequestMetrics {
  totalMs: number;
  gitCallCount: number;
  sqliteWriteCount: number;
  cacheHitRate: number;
  lockWaitMs: number;
}
```

### Benchmark 扩展

新增并发场景测试：
- 1/5/10/20 并发请求
- 读写混合场景
- 高负载压力测试

---

## 🎯 Phase 3 路线图

```
Phase 3.1: 批量写入 (Week 1, Day 1-2)
├─ 实现事务批处理
├─ 集成到 work-operation-service
└─ 测试和验证

Phase 3.2: 读写锁 (Week 1, Day 3-4)
├─ 实现 RW 锁机制
├─ 替换全局锁
└─ 并发测试

Phase 3.3: 请求缓存 (Week 1, Day 5)
├─ RequestContext 实现
├─ 集成到 prepareWork
└─ 缓存测试

Phase 3.4: 异步和优化 (Week 2)
├─ 异步写入
├─ 消除重复验证
└─ SQLite 调优

Phase 3.5: 改进和验证 (Week 3)
├─ 对象池和批处理
├─ 性能监控
└─ 最终验证和文档
```

---

**开始日期**: 2024-10-23  
**预计完成**: 2024-11-13 (3 周)
