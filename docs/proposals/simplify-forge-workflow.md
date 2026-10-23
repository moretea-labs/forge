# Forge 工作流简化提案

## 当前问题分析

### 1. 过度抽象的问题
Forge 当前设计存在明显的过度工程化：

- **547 个 TypeScript 文件**，控制平面就有多层嵌套（execution/facade/governance/launcher/...）
- **Work 准备流程**涉及 WorkHandle、WorkContract、ExecutionSession、PrepareRequest 等多个状态机
- **每个简单操作**都要经过复杂的协调：准备 -> 验证 -> 绑定 -> 激活 -> 清理
- **重复的状态同步**：SQLite + JSON 文件 + 内存状态 + 会话绑定

### 2. 与实际使用模式不符

观察 Codex 和 Claude 的实际工作方式：
- **频繁读文件**：`cat`、`head`、`grep` - 简单直接
- **频繁运行命令**：`git status`、`npm test`、`ls` - 无需准备
- **快速迭代**：改代码 -> 测试 -> 再改 - 无需复杂的 Work 生命周期

而 Forge 强制要求：
1. 创建 Work
2. 准备 checkout
3. 绑定 session
4. 执行操作
5. 验证结果
6. 清理资源

**这对于简单的"读文件-改代码-测试"循环来说太重了。**

### 3. rh_context 的问题

现在所有搜索都统一到 `rh_context`，但这带来了：
- **降低了灵活性**：模型不能自由组合 `grep`、`find`、`ag` 等工具
- **隐藏了工作原理**：模型看不到实际的搜索过程
- **限制了创造性**：模型不能根据具体情况选择最优策略

观察 Codex：
```bash
# Codex 会根据情况选择不同工具
grep -r "function.*prepare" src/  # 简单搜索
find src -name "*work*.ts" | head -20  # 文件查找
git log --grep="session" -n 20  # Git 历史
```

而 Forge 只给：
```typescript
rh_context.search({ query: "prepare work session" })  // 黑盒
```

## 核心问题

**Forge 试图成为一个"智能编排系统"，但实际上模型需要的是"强大的工具箱"。**

## 改进方向

### 方向 1：回归 Unix 哲学（推荐）

**核心思想**：Forge 应该是增强的终端 + 持久化层，而不是复杂的编排系统。

#### 具体改进：

1. **简化 Work 概念**
   ```typescript
   // 当前：复杂的状态机
   Work {
     WorkHandle (prepared/editing/validating/committed/merged/cleaned)
     WorkContract (open/completed/cancelled)
     ExecutionSession (bound/unbound)
     PrepareRequest (claimed/prepared)
   }
   
   // 简化为：
   WorkSession {
     id: string
     branch: string  // 可选，用于隔离
     dirty_files: string[]  // 跟踪修改
     started_at: timestamp
   }
   ```

2. **让模型直接使用终端**
   ```bash
   # 不需要 rh_context.search，直接用：
   grep -r "prepareWork" src/ | head -50
   find src -name "*.ts" -mtime -7
   git log --oneline --grep="session" -n 20
   
   # 不需要复杂的 Work 准备，直接：
   git checkout -b fix/issue-123
   vim src/file.ts
   npm test
   git commit -am "fix: issue 123"
   ```

3. **保留必要的高级能力**
   - **原子编辑**：`apply_patch` - 用于安全的代码修改
   - **验证**：`run_checks` - 用于运行测试和 lint
   - **上下文缓存**：`codegraph` - 用于快速理解代码结构
   - **效果追踪**：记录哪些文件被改了，方便回滚

4. **简化架构**
   ```
   当前架构（过度复杂）：
   Controller -> Gateway -> WorkPreparation -> WorkHandle -> ExecutionSession -> Repository -> Git
   
   简化后：
   Controller -> ExecutionEnv（终端 + 文件系统 + Git）
              -> ContextCache（codegraph + 文件索引）
              -> StateTracker（跟踪修改，方便回滚）
   ```

### 方向 2：混合模式（折中）

保留 Work 概念用于**真正需要隔离的场景**：
- 长期运行的特性开发
- 需要独立 worktree 的并行工作
- 需要严格验证的生产部署

但对于**日常开发**，提供轻量级模式：
```typescript
// 轻量级：直接在当前分支工作
execute_command({ command: "grep -r pattern src/" })
edit_file({ path: "src/file.ts", changes: [...] })
run_test({ pattern: "work-*" })

// 重量级：需要隔离时才用 Work
prepare_work({ objective: "refactor work module", isolation: "new_worktree" })
```

## 具体建议

### 立即行动（保持兼容）

1. **放开终端限制**
   - 让模型更自由地使用 `grep`、`find`、`ack`、`ag` 等工具
   - 不要强制所有搜索都走 `rh_context`
   - 提供 shell 别名和常用工具组合

2. **简化 Work 准备**
   - 对于 `isolation=reuse`（当前分支），跳过大部分协调
   - 直接绑定 session，无需创建 WorkHandle
   - 延迟创建 WorkContract，直到真正需要时

3. **减少状态同步**
   - 会话状态优先使用内存，仅在必要时持久化
   - 消除 SQLite + JSON 的重复
   - Work 状态尽量从 Git 派生，而不是维护独立状态机

### 中期重构（需要设计）

4. **引入 ExecutionEnv 抽象**
   ```typescript
   interface ExecutionEnv {
     // 简单的执行环境，替代复杂的 Work
     run(command: string): Result
     read(path: string): Content
     write(path: string, content: string): void
     git(args: string[]): Result
   }
   ```

5. **分离关注点**
   - **执行层**：终端 + 文件系统（无状态）
   - **缓存层**：codegraph + 索引（可重建）
   - **追踪层**：记录修改历史（用于回滚）
   - **协调层**：仅用于真正需要隔离的场景

### 长期愿景（需要验证）

6. **工作流分级**
   ```
   L0: 直接终端（90% 的日常操作）
   - grep、find、cat、编辑文件、运行测试
   
   L1: 带追踪的会话（需要回滚时）
   - 记录哪些文件被改了
   - 支持 savepoint 和 rollback
   
   L2: 隔离的 Work（真正需要隔离时）
   - 独立 worktree
   - 完整的生命周期管理
   ```

## 参考对比

### Cursor 的做法
- **简单**：直接在当前文件/目录工作
- **快速**：无需准备和清理
- **透明**：显示实际运行的命令

### Aider 的做法
- **Git 优先**：所有状态从 Git 派生
- **最小抽象**：直接操作文件系统
- **可选隔离**：通过 Git branch 实现

### Forge 的优势
- **可恢复**：中断后可以继续
- **并发安全**：多个工作隔离
- **企业级**：完整的审计和权限

### Forge 应该做的
**保留优势，降低日常成本**

## 实施路径

### Phase 1: 观察和度量（1 周）
- 统计实际使用中，有多少操作真正需要 Work 隔离
- 分析 Work 准备的实际开销（时间 + 代码复杂度）
- 收集 Codex/Claude 实际使用的命令模式

### Phase 2: 快速胜利（2-3 周）
- 为 `isolation=reuse` 模式大幅简化流程
- 放开终端使用限制，让模型自由组合工具
- 消除会话状态的冗余读写（如本次优化）

### Phase 3: 架构简化（1-2 月）
- 引入 ExecutionEnv 抽象
- 将 Work 概念降级为"可选的隔离机制"
- 默认模式变为"直接终端 + 轻量追踪"

### Phase 4: 验证和推广（持续）
- 在实际项目中验证新模式
- 收集反馈，持续优化
- 保持向后兼容，逐步迁移

## 衡量标准

改进是否成功，看：

1. **代码行数**：src/ 目录是否显著减少
2. **操作延迟**："读文件-改代码-测试"循环是否更快
3. **模型体验**：模型是否能更自然地工作（观察 prompt 和工具调用）
4. **系统复杂度**：新人是否更容易理解 Forge 的工作原理

## 总结

**Forge 不应该是"智能编排系统"，而应该是"增强的开发终端"。**

核心改变：
- ✅ 让模型**直接使用终端**（grep、find、git）
- ✅ **简化 Work**：从复杂状态机变为可选的隔离机制
- ✅ **减少抽象**：从 5 层嵌套变为 2-3 层
- ✅ **延迟协调**：只在真正需要时才创建复杂状态
- ✅ **保留优势**：可恢复、并发安全、审计能力

这样既保持了 Forge 的企业级能力，又降低了日常使用的复杂度。
