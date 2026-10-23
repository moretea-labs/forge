# Forge 架构和代码质量规则

## 目的

确保 Forge 代码库在简化过程中保持高质量，防止复杂度反弹，指导后续开发工作。

## 核心原则

### 1. 简单性优先（Simplicity First）

**规则**：默认选择最简单的实现，复杂性需要明确的理由。

✅ **好的做法**：
```typescript
// 直接返回结果
function getStatus() {
  return repositoryGitStatus(repo);
}
```

❌ **避免**：
```typescript
// 不必要的抽象和状态管理
class StatusManager {
  private cache: Map<string, Status>;
  private observers: Set<Observer>;
  
  async getStatusWithCaching() { ... }
  notifyObservers() { ... }
}
```

**检查点**：
- 新增的抽象是否真正必要？
- 能否用现有机制解决？
- 是否可以用函数代替类？

### 2. 延迟创建状态（Lazy State Creation）

**规则**：只在真正需要时才创建持久化状态。

✅ **好的做法**：
```typescript
// 轻量级操作不创建 Work
if (isSimpleOperation(args)) {
  return executeDirectly(args);
}

// 仅复杂操作创建完整状态
return createFullWork(args);
```

❌ **避免**：
```typescript
// 总是创建完整状态，即使不需要
const work = await createWork(args);
const handle = await createWorkHandle(work);
const contract = await createWorkContract(work);
// ... 然后可能根本不用这些状态
```

**检查点**：
- 这个状态是否立即需要？
- 能否延迟到实际使用时创建？
- 是否可以用临时状态代替持久化？

### 3. 避免过度协调（Avoid Over-Coordination）

**规则**：不要为了"万一"而添加协调逻辑。

✅ **好的做法**：
```typescript
// 简单操作直接执行
if (isReadOnly(command)) {
  return exec(command);
}

// 仅写操作需要锁
return withLock(() => exec(command));
```

❌ **避免**：
```typescript
// 所有操作都经过复杂协调
async function execute(command) {
  await acquireLock();
  await validatePermissions();
  await checkLeases();
  await recordIntent();
  const result = await exec(command);
  await recordResult();
  await releaseLock();
  return result;
}
```

**检查点**：
- 这个协调是否真正防止了并发问题？
- 能否用更简单的机制（如原子操作）？
- 是否可以将协调推迟到真正冲突时？

### 4. 最小持久化（Minimal Persistence）

**规则**：只持久化无法重建的关键信息。

✅ **好的做法**：
```typescript
// 仅持久化关键信息
interface LightweightSession {
  sessionId: string;
  repoId: string;
  baselineHead: string;  // 无法重建
  baselineDirtyPaths?: string[];  // 用于 diff
}
```

❌ **避免**：
```typescript
// 持久化所有可推导的信息
interface HeavySession {
  sessionId: string;
  repoId: string;
  checkoutId: string;  // 可从 repo 查询
  branch: string;  // 可从 git 查询
  upstream: string;  // 可从 git 查询
  clean: boolean;  // 可从 git 查询
  ahead: number;  // 可从 git 查询
  behind: number;  // 可从 git 查询
  lastStatus: GitStatus;  // 可重新查询
  // ... 更多冗余信息
}
```

**检查点**：
- 这个信息能否重新查询或推导？
- 丢失这个信息会有什么后果？
- 持久化的成本是否合理？

### 5. 单一职责（Single Responsibility）

**规则**：每个函数/类只做一件事，做好一件事。

✅ **好的做法**：
```typescript
// 每个函数职责清晰
function validateCheckout(checkout: Checkout): void { ... }
function bindSession(session: Session, checkout: Checkout): void { ... }
function recordBaseline(repo: Repository): Baseline { ... }

// 组合使用
function prepareLightweight(args) {
  validateCheckout(checkout);
  bindSession(session, checkout);
  return recordBaseline(repo);
}
```

❌ **避免**：
```typescript
// 一个函数做太多事
function prepareWorkWithEverything(args) {
  // 验证
  validatePermissions();
  validateCheckout();
  validateLeases();
  
  // 创建状态
  const work = createWork();
  const handle = createHandle();
  const contract = createContract();
  
  // 绑定
  bindSession();
  bindWork();
  
  // 激活
  activateWork();
  notifyObservers();
  
  // 记录
  recordMetrics();
  writeAuditLog();
  
  return { work, handle, contract };
}
```

**检查点**：
- 这个函数是否可以拆分为多个？
- 函数名是否需要用"and"连接多个动词？
- 测试是否需要模拟太多依赖？

### 6. 显式胜于隐式（Explicit Over Implicit）

**规则**：不要隐藏重要的行为，让调用者明确知道发生了什么。

✅ **好的做法**：
```typescript
// 明确的操作和返回值
const result = work_prepare({ isolation: 'reuse', lightweight: true });
if (result.mode === 'lightweight') {
  // 明确知道使用了轻量级模式
}
```

❌ **避免**：
```typescript
// 隐式的智能行为
const result = work_prepare({ objective: '...' });
// 不知道内部是否创建了 Work、是否使用了缓存、是否重用了现有状态
```

**检查点**：
- 调用者是否需要查看实现才能理解行为？
- 是否有隐藏的副作用？
- 返回值是否清晰表达了实际发生的事情？

## 代码审查清单

### 新增功能审查

在添加新功能时，必须回答以下问题：

- [ ] **必要性**：这个功能是否真正需要？能否用现有机制实现？
- [ ] **简单性**：这是最简单的实现吗？是否过度设计？
- [ ] **状态**：是否创建了新的持久化状态？是否必要？
- [ ] **抽象**：是否引入了新的抽象层？是否提供了足够的价值？
- [ ] **测试**：是否有足够的测试？测试是否简单清晰？
- [ ] **文档**：是否解释了为什么这样做（不仅仅是做了什么）？

### 重构审查

在重构代码时，验证以下改进：

- [ ] **减少行数**：代码行数是否减少？（除非有充分理由增加）
- [ ] **减少状态**：持久化状态是否减少？
- [ ] **减少依赖**：模块依赖是否减少？
- [ ] **提高性能**：关键路径是否更快？
- [ ] **保持行为**：所有现有测试是否通过？
- [ ] **改善可读性**：代码是否更容易理解？

### 性能敏感代码审查

对于高频调用的代码路径：

- [ ] **避免重复查询**：是否缓存了合理的结果？
- [ ] **避免重复写入**：是否消除了冗余的持久化？
- [ ] **避免重复验证**：是否合并了相同的检查？
- [ ] **延迟加载**：是否推迟了不必要的初始化？
- [ ] **测量性能**：是否有性能基准？是否验证了改进？

## 架构决策记录（ADR）模板

重要的架构决策必须记录，使用以下模板：

```markdown
# ADR-XXX: [决策标题]

## 状态
[提议 / 已接受 / 已废弃]

## 背景
[描述问题和背景]

## 决策
[描述决策内容]

## 理由
[解释为什么这样做]

## 后果
[描述这个决策的影响]

## 替代方案
[描述考虑过但未采纳的方案]

## 度量
[如何验证这个决策是否成功]
```

示例：见 `docs/adr/001-lightweight-work-session.md`

## 反模式识别

### 反模式 1：状态机膨胀

**症状**：
- Work 有 10+ 个状态
- 状态转换规则复杂
- 需要画图才能理解

**解决**：
- 简化为 3-5 个核心状态
- 用类型系统表达约束
- 分离临时状态和持久化状态

### 反模式 2：过度抽象

**症状**：
- 三层以上的继承
- 多个只有一个实现的接口
- 大量的 Manager/Service/Handler/Provider

**解决**：
- 优先使用组合而非继承
- 只在真正需要多实现时才用接口
- 用简单的函数代替单一职责的类

### 反模式 3：协调地狱

**症状**：
- 锁嵌套超过 2 层
- 多个协调机制共存（锁、信号量、队列等）
- 超过 50% 的代码是协调逻辑

**解决**：
- 重新设计数据流，减少共享状态
- 用消息传递代替共享内存
- 将协调推到边界（数据库级别的 CAS）

### 反模式 4：配置爆炸

**症状**：
- 超过 20 个配置项
- 配置项之间有复杂的依赖关系
- 需要文档解释配置

**解决**：
- 提供合理的默认值
- 减少可配置的维度
- 用类型系统表达配置约束

### 反模式 5：重复逻辑

**症状**：
- 相似的代码在多处出现
- Copy-paste 式的开发
- 修改一个 bug 需要改多个地方

**解决**：
- 提取共同逻辑
- 用高阶函数或组合
- 建立清晰的抽象边界

## 度量指标

### 代码复杂度指标

定期测量和监控：

```bash
# 代码行数（应该减少）
find src -name "*.ts" -exec wc -l {} + | tail -1

# 文件数量（应该减少）
find src -name "*.ts" | wc -l

# 平均函数长度（应该 < 30 行）
# 平均文件长度（应该 < 300 行）
# 圈复杂度（应该 < 10）
```

### 性能指标

关键路径的性能基准：

- Work 准备时间（轻量级）：< 5ms
- Work 准备时间（完整）：< 50ms
- Session 绑定时间：< 1ms
- Git 状态查询：< 10ms

### 质量指标

- 测试覆盖率：> 80%（关键路径 > 95%）
- 类型覆盖率：100%（严格模式）
- 所有测试必须通过
- 架构检查必须通过

## 自动化检查

### Pre-commit Hooks

```bash
# 类型检查
bun run check:type

# 架构检查
bun run check:runtime-architecture

# 代码格式
bun run format:check
```

### CI 检查

```yaml
# .github/workflows/quality.yml
- 运行所有测试
- 检查代码覆盖率
- 运行架构检查
- 检查是否有新的 TODO/FIXME
- 测量关键路径性能
```

## 技术债务管理

### 标记技术债务

使用统一的标记格式：

```typescript
// DEBT: [类别] 描述问题
// WHY: 为什么产生这个债务
// PLAN: 计划如何解决
// IMPACT: 影响范围
```

示例：
```typescript
// DEBT: [过度抽象] WorkHandle 和 WorkContract 职责重叠
// WHY: 历史演进导致，最初分开是为了隔离关注点
// PLAN: Phase 3 合并为统一的 Work 实体
// IMPACT: 高 - 影响所有 Work 相关代码
```

### 技术债务优先级

- **P0**：影响正确性或安全性 - 立即修复
- **P1**：影响性能或可维护性 - 本季度修复
- **P2**：代码质量问题 - 下季度修复
- **P3**：理想改进 - 有时间就做

## 新人指南

### 理解 Forge 架构

推荐阅读顺序：

1. `docs/proposals/simplify-forge-workflow.md` - 理解设计哲学
2. `docs/architecture/CURRENT.md` - 当前架构状态
3. `src/runtime/control-plane/execution/lightweight-session.ts` - 简单实现示例
4. `tests/runtime/lightweight-session.test.ts` - 测试模式

### 贡献代码

1. **先理解问题**：不要急于写代码
2. **寻找现有方案**：能否复用现有机制？
3. **选择最简单的实现**：YAGNI（You Aren't Gonna Need It）
4. **写测试**：先写测试，再写实现
5. **小步提交**：每个 PR 只做一件事
6. **请求审查**：让其他人审查你的代码

### 常见错误

❌ **添加新的状态机**：大多数情况下不需要
✅ 使用现有的状态管理或简单的枚举

❌ **创建新的抽象层**：通常会增加复杂度
✅ 直接使用现有的抽象或简单的函数

❌ **过早优化**：在没有性能问题时优化
✅ 先让代码正确，再让代码快

❌ **过度设计**：为未来可能的需求设计
✅ 只为当前需求设计，保持灵活性

## 持续改进

### 定期审查

每月进行代码库健康检查：

- [ ] 代码行数是否在减少？
- [ ] 新增的抽象是否必要？
- [ ] 技术债务是否在减少？
- [ ] 性能是否在提升？
- [ ] 测试覆盖率是否保持？

### 重构机会

识别重构信号：

- 相同的代码出现 3 次以上
- 函数超过 50 行
- 文件超过 500 行
- 修改一个功能需要改多个文件
- 测试难以编写

### 学习和分享

- 记录好的实践
- 分享踩过的坑
- 更新这份规则文档

## 总结

这些规则的核心目标是：

1. **保持简单**：默认选择最简单的实现
2. **避免过度设计**：只为当前需求设计
3. **减少状态**：只持久化必要的信息
4. **提高性能**：消除不必要的开销
5. **保证质量**：测试和架构检查

遵循这些规则，Forge 将变得更快、更简单、更易维护。
