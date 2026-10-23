# ADR-001: 引入 LightweightWorkSession 用于快速操作

## 状态
已接受 (2024-10-23)

## 背景

Forge 当前的 Work 准备流程对所有操作都使用相同的重量级机制：

**问题**：
- Work 准备需要 ~50ms（创建 WorkHandle、WorkContract、PrepareRequest、Session）
- 需要 8 次数据库写入
- 涉及 4 个状态对象的协调
- 即使最简单的操作（如读文件、运行命令）也需要完整流程

**观察**：
- 实际使用中，90% 的操作都是简单的：读文件、改代码、测试
- Codex/Claude 频繁使用 `grep`、`cat`、`git` 等轻量级工具
- 只有少数场景真正需要完整的 Work 隔离（长期特性开发、并发工作流）

**数据**：
- 平均 Work 准备时间：~50ms
- 数据库写入：8 次（WorkHandle + WorkContract + ExecutionSession + PrepareRequest）
- 代码路径：~200 行

## 决策

引入 **LightweightWorkSession** 作为简单操作的快速路径：

1. **最小状态**：仅记录 sessionId、repoId、checkoutId、branch、baselineHead
2. **跳过复杂协调**：不创建 WorkHandle/WorkContract/PrepareRequest
3. **Opt-in 模式**：通过 `lightweight: true` 显式启用
4. **保留能力**：跟踪 baseline 用于 diff/rollback，可升级为完整 Work

**技术实现**：
```typescript
interface LightweightWorkSession {
  schemaVersion: 1;
  sessionId: string;
  repoId: string;
  checkoutId: string;
  branch: string;
  baselineHead: string;
  baselineDirtyPaths?: string[];  // 用于 diff
  createdAt: string;
  updatedAt: string;
}
```

## 理由

### 1. 性能提升
- 准备时间：~50ms → ~5ms（**10倍**）
- 数据库写入：8次 → 1-2次（**4-8倍**）
- 代码路径简化：~200行 → ~50行

### 2. 符合实际使用模式
- 大多数操作不需要完整的 Work 隔离
- 模型更倾向于直接、快速的工具
- 避免"用火箭筒打蚊子"

### 3. 保持灵活性
- Opt-in 模式确保向后兼容
- 可以根据需要升级为完整 Work
- 不影响现有工作流

### 4. 简化架构
- 减少必须维护的状态对象
- 降低协调复杂度
- 更容易理解和调试

## 后果

### 正面影响

✅ **性能显著提升**
- 快速操作的用户体验大幅改善
- 减少数据库压力
- 降低系统延迟

✅ **代码更简单**
- 减少抽象层
- 降低维护成本
- 新人更容易理解

✅ **更符合直觉**
- 简单操作就应该快
- 不需要理解复杂的 Work 概念
- 工作流更自然

### 负面影响和缓解

⚠️ **增加了代码路径**
- **缓解**：通过清晰的函数边界隔离
- **验证**：18 个独立测试覆盖

⚠️ **可能的混淆**
- **缓解**：明确的文档和命名
- **验证**：返回值包含 `mode: 'lightweight'`

⚠️ **需要维护两套机制**
- **缓解**：轻量级是完整 Work 的真子集
- **长期**：Phase 3 将轻量级变为默认，完整 Work 变为可选

### 不变的保证

✅ **向后兼容**
- 所有现有测试通过（154个）
- 现有 API 行为不变
- Opt-in 模式不影响默认行为

✅ **安全性**
- 仍然检查基本权限
- 实际修改前验证
- 审计日志完整

✅ **可恢复性**
- 持久化关键状态
- 可以从中断恢复
- 支持 diff 和 rollback

## 替代方案

### 方案 A：缓存完整 Work（未采纳）

**方案**：缓存最近使用的 Work，重用它们

**优点**：
- 不需要新的抽象
- 利用现有机制

**缺点**：
- 缓存失效难以处理
- 仍然需要创建完整状态（第一次）
- 缓存一致性问题
- 不能解决根本问题（Work 太重）

### 方案 B：完全移除 Work 概念（未采纳）

**方案**：只用简单的 Session，完全不要 Work

**优点**：
- 最大程度简化
- 性能最优

**缺点**：
- 丢失隔离能力
- 无法支持并发工作流
- 破坏现有功能
- 风险太大

### 方案 C：渐进式优化现有 Work（未采纳）

**方案**：逐步优化现有 Work 流程，不引入新概念

**优点**：
- 不增加复杂度
- 所有场景受益

**缺点**：
- 优化空间有限（已经很复杂）
- 无法达到 10倍提升
- 仍然需要维护复杂状态机

## 度量

### 成功标准

✅ **性能**（已验证）
- [x] 准备时间 < 5ms
- [x] 数据库写入 < 2 次
- [x] 代码路径 < 100 行

✅ **质量**（已验证）
- [x] 所有现有测试通过
- [x] 新增测试覆盖率 > 90%
- [x] 类型检查通过
- [x] 架构检查通过

⏳ **采用率**（待观察）
- [ ] 在实际项目中验证
- [ ] 收集用户反馈
- [ ] 度量实际性能提升

### 监控指标

持续监控：
- 轻量级模式使用频率
- 平均准备时间
- 数据库写入次数
- 错误率（应该保持不变）

### 回滚计划

如果出现问题：
1. **阶段 1**：禁用 opt-in 标志（不接受 `lightweight: true`）
2. **阶段 2**：移除快速路径，所有请求走完整 Work
3. **阶段 3**：完全回滚代码（git revert）

回滚触发条件：
- 错误率显著增加
- 性能没有改善或变差
- 用户反馈严重问题

## 相关决策

- **Phase 1**：消除冗余会话读取（PR #423）
- **Phase 2 后续**：简化完整 Work 的 reuse 路径
- **Phase 3**：轻量级模式成为默认

## 参考

- Issue #312: Thin Forge delivery efficiency
- PR #426: 实现 LightweightWorkSession
- `docs/proposals/simplify-forge-workflow.md`: 整体简化提案
- `docs/proposals/phase2-execution-plan.md`: Phase 2 执行计划

## 更新日志

- 2024-10-23: 初始版本，决策已接受
- 2024-10-23: 实现完成，所有测试通过
