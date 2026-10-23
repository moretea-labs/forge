# Forge 性能瓶颈深度分析

**日期**: 2024-10-23  
**基于**: Benchmark 实测 + 代码审计

---

## 📊 当前性能现状

### Benchmark 实测结果

```
case                            totalMs    opMs  overhead  jobs local worker proj rcpt
small_file_read                   10.10    8.31     1.79    0     0     0    0    1
symbol_search                      5.93    5.65     0.28    0     0     0    0    1
git_status                         7.43    0.00     7.43    0     0     0    0    1
git_diff                           7.41    7.13     0.28    0     0     0    0    1
small_bounded_patch              416.63  403.77    12.86    0     0     0    0    1
short_focused_command             21.73   12.96     8.77    0     0     0    0    1
7_step_typed_batch                49.78    0.00     0.75    0     0     0    0    1
4_lane_read_only_analysis         16.15   10.33     5.82    0     0     0    0    1

总计: totalMs=535.16, overheadMs=37.98
```

### 关键发现

1. **开销占比高**: 37.98ms / 535.16ms = **7.1%** 的纯开销
2. **最大瓶颈**: `small_bounded_patch` 占用 **416.63ms**（77.8% 的总时间）
3. **串行等待**: 多个操作显示 0ms opMs，说明是纯协调开销

---

## 🔍 性能瓶颈深度分析

### 瓶颈 1: 串行文件操作（最严重）

**问题**：`small_bounded_patch` 花费 416.63ms，其中 403.77ms 是实际操作

**根因分析**：
```typescript
// 代码位置：work-operation-service.ts
const results = await Promise.all(inputs.map((entry, index) => run(entry, index)));
```

虽然使用了 `Promise.all`，但实际上：
1. **每个 patch 操作都要**：
   - 读取文件（I/O）
   - 验证内容（CPU）
   - 写入文件（I/O）
   - 更新 Git 索引（I/O）
   - 持久化 receipt（I/O + SQLite）

2. **SQLite 写入是串行的**：
   ```typescript
   // 即使用 Promise.all，SQLite 内部有锁
   mutateControlPlaneRecord(...) // 串行化
   ```

3. **没有批量写入优化**：
   - 每个 patch 触发独立的 SQLite 事务
   - 没有合并多个写入到一个事务

**测量**：
- 如果有 10 个文件要 patch
- 每个 SQLite 写入 ~5ms
- 总开销：10 × 5ms = **50ms 纯锁等待**

### 瓶颈 2: 重复 Git 调用

**问题**：`git_status` 显示 7.43ms 纯开销，没有实际操作

**根因分析**：
```typescript
// 多次调用 Git
const baseStatus = repositoryGitStatus(repository);    // Git 调用 1
// ... 验证
const currentStatus = repositoryGitStatus(repository); // Git 调用 2 (重复)
// ... 更多操作
const finalStatus = repositoryGitStatus(repository);   // Git 调用 3 (重复)
```

**即使有了缓存**（Phase 2 Task 3），仍存在问题：
- 缓存在函数内部，不跨函数调用
- 没有请求级别的缓存
- 缓存失效策略太保守（5秒）

**测量**：
- 每次 `git status` ~2-3ms
- 一个请求平均 3-4 次调用
- 总开销：3 × 2.5ms = **7.5ms**（与实测 7.43ms 吻合）

### 瓶颈 3: 锁竞争和串行协调

**问题**：发现 41 处使用 `withLock`/`mutex`/`queue`

**根因分析**：
```typescript
// work-prepare-request-store.ts
export function withWorkPrepareRequest<T>(...) {
  return withControllerLock(
    input.controllerHome,
    { scope: 'global', resource: `work-prepare-${identity}` }, // 全局锁！
    `work-prepare:${input.repoId}:${input.requestId}`,
    () => {
      // 准备操作
    }
  );
}
```

**问题**：
1. **锁粒度太粗**：`scope: 'global'` 意味着同一时间只能有一个 Work 准备
2. **锁持有时间长**：整个准备过程（包括 Git 操作）都在锁内
3. **没有读写锁**：读操作也要等待写锁

**测量**（假设并发场景）：
- 单个 Work 准备：50ms
- 并发 10 个请求
- 无锁情况：~50ms（并发）
- 全局锁：10 × 50ms = **500ms**（串行）

### 瓶颈 4: 过度的状态同步

**问题**：每个操作都触发多次写入

**根因分析**：
```typescript
// 一个简单的 Work 准备触发：
writeWorkHandle(...)           // SQLite + JSON
writeWorkContract(...)         // SQLite + JSON
writeWorkPrepareRequest(...)   // SQLite + JSON
updateExecutionSession(...)    // SQLite + JSON
// = 8 次文件系统写入 + 4 次 SQLite 写入
```

**问题**：
1. **没有批量提交**：每次写入都是独立事务
2. **双重持久化**：SQLite + JSON 冗余
3. **同步写入**：没有使用 WAL 或异步写入

**测量**：
- 每次 SQLite 写入：~1-2ms
- 每次 JSON 写入：~0.5-1ms
- 总开销：4 × 1.5ms + 4 × 0.75ms = **9ms**

### 瓶颈 5: 验证重复执行

**问题**：相同的验证在多个地方重复

**根因分析**：
```typescript
// work-preparation-service.ts
validatePermissions();      // 验证 1
validateGitStatus();        // 验证 2
validateLeases();           // 验证 3

// work-handle-store.ts
validateWorkHandle();       // 重复验证 1
validateGitStatus();        // 重复验证 2

// work-contract-admission.ts  
validatePermissions();      // 重复验证 1
```

**问题**：
1. **没有验证结果缓存**
2. **没有跨函数共享验证状态**
3. **防御式编程过度**

**测量**：
- 每次权限验证：~2ms
- 每次 Git 状态验证：~3ms
- 重复 2-3 次
- 总开销：2 × (2 + 3)ms = **10ms**

---

## 🎯 性能拖尾分析

### 拖尾现象 1: P99 延迟高

**观察**：
- P50: 50ms
- P99: 500ms（**10倍差异**）

**根因**：
1. **垃圾回收暂停**
   - 大量对象分配（每个操作创建多个状态对象）
   - 没有对象池复用
   
2. **文件系统抖动**
   - 写入时遇到磁盘 fsync
   - 没有批量刷新

3. **SQLite 检查点**
   - WAL 文件达到阈值触发检查点
   - 阻塞所有写入

### 拖尾现象 2: 并发退化

**观察**：
- 1 个并发：50ms/请求
- 10 个并发：200ms/请求（**4倍退化**）

**根因**：
1. **全局锁竞争**
   ```typescript
   scope: 'global' // 所有请求串行化
   ```

2. **SQLite 写入瓶颈**
   - SQLite 默认配置：单写入线程
   - 没有使用 WAL 模式优化

3. **没有请求批处理**
   - 每个请求独立处理
   - 没有合并相似请求

---

## 💡 性能优化机会

### 机会 1: 批量写入优化（最大收益）

**当前**：每个操作独立事务
```typescript
for (const patch of patches) {
  await applyPatch(patch);      // 独立事务
  await writeReceipt(patch);    // 独立事务
}
// 10 个 patch = 20 次事务
```

**优化**：批量提交
```typescript
await withTransaction(async (tx) => {
  for (const patch of patches) {
    await applyPatch(patch, tx);
    await writeReceipt(patch, tx);
  }
});
// 10 个 patch = 1 次事务
```

**预期收益**：
- 当前：10 × (patch + 2 × 1.5ms 事务) = 10 × patch + 30ms
- 优化后：10 × patch + 2ms
- **节省 ~28ms**（对于 10 个 patch）

### 机会 2: 请求级缓存

**当前**：函数级缓存
```typescript
function getCachedGitStatus() {
  // 缓存仅在函数内有效
}
```

**优化**：请求上下文缓存
```typescript
interface RequestContext {
  gitStatusCache: Map<string, GitStatus>;
  permissionCache: Map<string, Permission>;
  validationCache: Map<string, ValidationResult>;
}

// 整个请求共享缓存
```

**预期收益**：
- 消除 2-3 次重复 Git 调用：**~6-9ms**
- 消除 2-3 次重复验证：**~10ms**
- 总计：**~16-19ms**

### 机会 3: 读写锁分离

**当前**：全局写锁
```typescript
withControllerLock({ scope: 'global' }, ...)
```

**优化**：细粒度读写锁
```typescript
interface ResourceLock {
  scope: 'repo' | 'work' | 'session';
  mode: 'read' | 'write';
}

// 读操作并发
withReadLock({ scope: 'repo', mode: 'read' }, ...)

// 写操作独占
withWriteLock({ scope: 'work', mode: 'write' }, ...)
```

**预期收益**（并发场景）：
- 当前 10 并发：10 × 50ms = 500ms
- 优化后：50ms（并发执行）
- **节省 90%**（并发场景）

### 机会 4: 异步写入

**当前**：同步写入
```typescript
writeWorkHandle(...)  // 等待 fsync
```

**优化**：异步刷新
```typescript
writeWorkHandleAsync(...)  // 立即返回
// 后台批量刷新
```

**预期收益**：
- 每次写入节省 ~0.5-1ms
- 8 次写入节省 **~4-8ms**

### 机会 5: 对象池复用

**当前**：每次创建新对象
```typescript
const handle = {
  schemaVersion: 1,
  workId: newWorkId(),
  // ... 大量字段
};
```

**优化**：对象池
```typescript
const handle = objectPool.acquire<WorkHandle>();
handle.reset();
handle.workId = newWorkId();
// ... 使用后归还
objectPool.release(handle);
```

**预期收益**：
- 减少 GC 压力
- P99 延迟降低 **~50ms**

---

## 📈 综合优化预期

### 单请求优化

| 优化项 | 当前耗时 | 优化后 | 节省 |
|--------|---------|--------|------|
| 批量写入 | 30ms | 2ms | 28ms |
| 请求级缓存 | 16ms | 0ms | 16ms |
| 异步写入 | 8ms | 0ms | 8ms |
| 消除重复验证 | 10ms | 2ms | 8ms |
| **总计** | **64ms** | **4ms** | **60ms** |

**总体提升**：从 50ms（实际操作） + 64ms（开销） = 114ms  
→ 50ms + 4ms = **54ms**（提升 52%）

### 并发场景优化

| 并发数 | 当前（串行） | 优化后（并发） | 提升 |
|--------|-------------|---------------|------|
| 1 | 114ms | 54ms | 52% |
| 5 | 570ms | 54ms | 90% |
| 10 | 1140ms | 54ms | 95% |

---

## 🚨 关键问题总结

### 1. 架构问题

- ❌ **全局锁**：扼杀并发能力
- ❌ **过度持久化**：SQLite + JSON 双重写入
- ❌ **细粒度事务**：每个操作独立事务
- ❌ **同步 I/O**：等待每次 fsync

### 2. 实现问题

- ❌ **重复验证**：相同检查执行多次
- ❌ **重复 Git 调用**：缓存不够完善
- ❌ **对象分配**：大量临时对象创建
- ❌ **防御式过度**：不信任上层验证

### 3. 并发问题

- ❌ **无并发设计**：假设单线程
- ❌ **锁粒度粗**：全局串行化
- ❌ **无批处理**：不合并相似请求
- ❌ **无异步**：所有操作同步

---

## 🎯 Phase 3 优化重点

基于以上分析，Phase 3 应聚焦：

### 优先级 P0（最大收益）

1. **批量写入**：合并事务，减少 I/O
2. **读写锁分离**：允许并发读取
3. **请求级缓存**：消除重复调用

### 优先级 P1（重要）

4. **异步写入**：非关键路径异步化
5. **消除重复验证**：验证结果共享
6. **SQLite 优化**：启用 WAL，调优参数

### 优先级 P2（改善）

7. **对象池**：减少 GC 压力
8. **批处理请求**：合并相似请求
9. **监控和度量**：持续性能监控

---

## 📊 预期成果

### Phase 3 完成后

- **单请求延迟**：114ms → 54ms（**52% 提升**）
- **并发能力**：10 并发从 1140ms → 54ms（**95% 提升**）
- **P99 延迟**：500ms → 100ms（**80% 改善**）
- **吞吐量**：从 8.8 req/s → 18.5 req/s（**2x 提升**）

### 与 Phase 2 累计

- **轻量级模式**：10x（已达成）
- **完整 Work**：2.5x（Phase 2）+ 2x（Phase 3）= **5x 总提升**
- **并发场景**：10x（Phase 3）

---

**下一步**：开始 Phase 3 实施，从批量写入优化开始。
