# 工具使用最佳实践指南

## 目的

指导模型（Claude/Codex）如何高效、自然地使用 Forge 提供的工具和终端能力，避免不必要的抽象和复杂流程。

## 核心原则

### 1. 简单操作直接使用终端

**优先**使用简单、直接的终端命令，而不是复杂的工具。

✅ **推荐**：
```bash
# 搜索代码
grep -r "function prepareWork" src/

# 查找文件
find src -name "*work*.ts" -type f

# 查看文件
cat src/file.ts

# Git 操作
git status
git log --oneline -10
git diff
```

❌ **避免**：
```typescript
// 不要总是使用复杂工具
rh_context.search({ query: "prepareWork", mode: "implementation" })
```

### 2. 何时使用高级工具

仅在确实需要结构化信息或复杂分析时使用高级工具。

#### rh_context.search

**使用场景**：
- 需要理解代码结构和关系
- 需要跨文件的上下文
- 需要类型定义和依赖

**示例**：
```typescript
// 理解复杂的模块关系
rh_context.search({
  query: "Work preparation flow",
  mode: "plan",
  structural_context: true
})
```

#### codegraph explore

**使用场景**：
- 追踪函数调用链
- 理解复杂的依赖关系
- 分析架构模式

**示例**：
```typescript
codegraph_explore({
  query: "prepareWork WorkHandle WorkContract",
  maxFiles: 10
})
```

### 3. 工作流选择

根据任务复杂度选择合适的工作流。

#### 简单任务（90%场景）

```bash
# 直接在当前分支工作
grep -r "TODO" src/
vim src/file.ts
npm test
git commit -am "fix: issue"
```

**无需**：
- work_prepare
- 复杂的 Work 生命周期
- 多层验证

#### 中等任务

```typescript
// 使用轻量级会话
work_prepare({
  isolation: 'reuse',
  lightweight: true,  // 快速准备
  objective: 'Quick refactor'
})

// 编辑、测试、提交
```

#### 复杂任务

```typescript
// 使用完整 Work（需要隔离）
work_prepare({
  isolation: 'new_worktree',
  objective: 'Long-running feature',
  acceptance_criteria: [...]
})
```

## 常见场景指南

### 场景 1: 搜索代码

**目标**：找到包含特定模式的代码

**推荐方案**：
```bash
# 简单搜索
grep -r "prepareWork" src/

# 带上下文
grep -r -A 5 -B 5 "prepareWork" src/

# 排除特定目录
grep -r "prepareWork" src/ --exclude-dir=node_modules

# 只搜索特定文件类型
grep -r "prepareWork" --include="*.ts" src/

# 使用正则表达式
grep -rE "function (prepare|create)Work" src/
```

**何时升级到 rh_context**：
- 需要理解代码结构
- 需要类型信息
- 需要跨文件上下文

### 场景 2: 查找文件

**目标**：找到特定的文件

**推荐方案**：
```bash
# 按名称查找
find src -name "work-preparation*.ts"

# 按类型查找
find src -type f -name "*.ts"

# 最近修改的文件
find src -name "*.ts" -mtime -7

# 组合条件
find src -name "*.ts" -not -path "*/node_modules/*" -mtime -1
```

**何时升级到工具**：
- 需要按内容搜索
- 需要语义搜索

### 场景 3: 理解代码

**目标**：理解函数/模块的工作原理

**方案选择**：

**简单理解**（直接阅读）：
```bash
# 查看函数
cat src/file.ts | grep -A 50 "function prepareWork"

# 查看文件
cat src/work-preparation-service.ts

# 查看特定行
sed -n '100,150p' src/file.ts
```

**深度理解**（使用工具）：
```typescript
// 追踪调用链
codegraph_explore({
  query: "prepareWork validation flow"
})

// 获取结构化上下文
rh_context.search({
  query: "prepareWork implementation",
  structural_context: true
})
```

### 场景 4: 修改代码

**目标**：修改一个或多个文件

**简单修改**（1-2 个文件）：
```bash
# 直接编辑
vim src/file.ts

# 或使用工具
apply_patch({
  path: "src/file.ts",
  changes: [...]
})
```

**批量修改**（多个文件）：
```bash
# 使用 sed 批量替换
find src -name "*.ts" -exec sed -i 's/oldName/newName/g' {} +

# 或用 grep + vim
grep -r "oldName" src/ -l | xargs vim
```

### 场景 5: 运行测试

**目标**：验证代码修改

**推荐方案**：
```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- --test-name-pattern="work"

# 运行单个文件
npm test tests/work.test.ts

# 监视模式
npm test -- --watch
```

**无需**：
- 复杂的验证工作流
- 多层测试编排

### 场景 6: Git 操作

**目标**：版本控制操作

**推荐方案**：
```bash
# 查看状态
git status

# 查看历史
git log --oneline -20
git log --grep="work" -10

# 查看差异
git diff
git diff HEAD~1

# 提交
git add src/file.ts
git commit -m "fix: issue"

# 分支操作
git checkout -b feature/new-feature
git branch -d old-branch
```

**何时创建 Work**：
- 需要长期跟踪
- 需要独立的工作树
- 需要完整的审计日志

## 命令组合示例

### 示例 1: 快速 Bug 修复

```bash
# 1. 搜索问题
grep -r "buggy function" src/

# 2. 查看文件
cat src/problematic-file.ts

# 3. 修改
vim src/problematic-file.ts

# 4. 测试
npm test -- --test-name-pattern="problematic"

# 5. 提交
git add src/problematic-file.ts
git commit -m "fix: resolve issue with buggy function"
```

**耗时**：< 5 分钟  
**无需**：work_prepare、复杂验证

### 示例 2: 功能重构

```bash
# 1. 理解当前代码
codegraph_explore({
  query: "target module structure"
})

# 2. 创建轻量级会话
work_prepare({
  isolation: 'reuse',
  lightweight: true,
  objective: 'Refactor target module'
})

# 3. 批量修改
find src -name "*.ts" -exec sed -i 's/oldAPI/newAPI/g' {} +

# 4. 测试
npm test

# 5. 提交
git add src/
git commit -m "refactor: modernize API"
```

**耗时**：10-30 分钟  
**使用**：轻量级会话追踪变更

### 示例 3: 新功能开发

```typescript
// 1. 创建完整 Work（需要隔离）
work_prepare({
  isolation: 'new_worktree',
  objective: 'Implement new feature X',
  acceptance_criteria: [
    'Feature works correctly',
    'Tests pass',
    'Documentation updated'
  ]
})

// 2. 开发和测试
// ... 多次迭代

// 3. 完成
work_complete({
  work_id: '...',
  summary: 'Feature X implemented and tested'
})
```

**耗时**：数小时到数天  
**使用**：完整 Work 隔离和追踪

## 性能最佳实践

### 1. 避免重复工具调用

❌ **低效**：
```typescript
// 每次都查询
const status1 = rh_context.search({ query: "module A" });
const status2 = rh_context.search({ query: "module A" }); // 重复
```

✅ **高效**：
```typescript
// 查询一次，复用结果
const status = rh_context.search({ query: "module A B C" });
// 从结果中提取需要的信息
```

### 2. 使用缓存的信息

✅ **利用 Git 状态缓存**：
```typescript
// 连续操作自动使用缓存（5秒内）
work_prepare({ isolation: 'reuse' });  // Git 查询
// ... 其他操作
work_inspect({ work_id: '...' });      // 使用缓存
```

### 3. 批量操作

❌ **低效**：
```bash
# 逐个文件搜索
grep "pattern" file1.ts
grep "pattern" file2.ts
grep "pattern" file3.ts
```

✅ **高效**：
```bash
# 一次搜索多个文件
grep "pattern" file1.ts file2.ts file3.ts

# 或使用通配符
grep "pattern" src/**/*.ts
```

## 决策树

使用此决策树选择合适的方法：

```
任务复杂度？
├─ 简单（读文件、搜索、查看状态）
│  └─ 使用终端命令（grep、cat、git）
│
├─ 中等（快速编辑、小重构）
│  └─ 轻量级会话 + 终端命令
│
└─ 复杂（新功能、大重构、需要隔离）
   └─ 完整 Work + 结构化工具
```

```
搜索需求？
├─ 简单文本搜索
│  └─ grep -r "pattern" src/
│
├─ 需要上下文和结构
│  └─ rh_context.search()
│
└─ 需要调用链和依赖
   └─ codegraph_explore()
```

```
修改范围？
├─ 1-2 个文件
│  └─ 直接编辑或 apply_patch
│
├─ 3-10 个文件
│  └─ 轻量级会话 + 批量编辑
│
└─ 大范围重构
   └─ 完整 Work + 结构化工具
```

## 反模式

### ❌ 反模式 1: 过度使用高级工具

```typescript
// 不好：简单查询使用复杂工具
rh_context.search({
  query: "find TODO comments",
  mode: "implementation",
  structural_context: true,
  max_results: 100
})

// 好：直接用 grep
grep -r "TODO" src/
```

### ❌ 反模式 2: 总是创建 Work

```typescript
// 不好：简单修改也创建 Work
work_prepare({
  isolation: 'new_worktree',
  objective: 'Fix typo'
})

// 好：直接修改
vim src/file.ts
git commit -am "fix: typo"
```

### ❌ 反模式 3: 重复读取相同信息

```bash
# 不好：每次都重新查询
git status
# ... 操作
git status  # 重复
# ... 操作
git status  # 重复
```

## 工具速查表

| 需求 | 简单方案（推荐） | 高级方案 |
|------|------------------|----------|
| **搜索文本** | `grep -r "pattern" src/` | `rh_context.search()` |
| **查找文件** | `find src -name "*.ts"` | `rh_context.search()` |
| **查看文件** | `cat file.ts` | `Read({ file_path })` |
| **理解代码** | `cat + grep` | `codegraph_explore()` |
| **修改文件** | `vim` | `apply_patch()` |
| **Git 状态** | `git status` | `work_inspect()` |
| **运行测试** | `npm test` | `execute_command()` |
| **快速修改** | 直接编辑 | 轻量级会话 |
| **大重构** | 轻量级会话 | 完整 Work |

## 总结

**核心理念**：
1. **简单操作用简单工具**：grep、find、cat、git
2. **需要理解用高级工具**：rh_context、codegraph
3. **按需使用 Work**：90% 场景不需要完整 Work
4. **性能优先**：避免重复调用，利用缓存

**记住**：
- 快速 > 完美
- 直接 > 抽象
- 终端 > 工具（大多数情况）
- 轻量 > 重量（除非必要）

遵循这些原则，你的工作流会更快、更自然、更高效。
