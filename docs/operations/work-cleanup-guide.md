# Work Cleanup and Finalization Tools

## 问题背景

Forge工作流存在一个架构问题：**Git交付完成 ≠ Work自动清理**

### 核心问题

1. **Work已经merge到main分支，但语义状态仍然是`open`**
   - 导致worktree无法被清理
   - 分支持续累积
   - 资源浪费

2. **Dirty worktree保护机制变成堆积陷阱**
   - 原本设计用于保护未提交代码
   - 但Work永远不会自动终结
   - DIRTY_WORKTREE_RETAINED错误阻止清理

3. **缺少自动终结机制**
   - `deliverWork`需要显式的`complete_work: true`参数
   - Controller/Model经常忘记传递这个参数
   - 导致delivered-but-open状态累积

## 解决方案

### 1. 自动终结模块 (`work-auto-finalization.ts`)

自动检测并修复以下情况：

- **delivered_but_open**: Work已交付但语义上仍open → 自动完成
- **clean_terminal**: Work已终结且clean → 触发清理
- **abandoned_dirty**: 超过7天的dirty worktree → 标记需要人工审查

### 2. 定期清理调度器 (`work-finalization-scheduler.ts`)

集成到现有的periodic cleanup基础设施，每15分钟自动运行一次。

### 3. 手动清理工具

#### `bun run cleanup:works:dry` - 干跑模式（安全预览）

仅扫描和报告，不做任何修改：

```bash
bun run cleanup:works:dry
```

输出示例：
```
Scanned: 50 Work items
Candidates found: 3
  - delivered_but_open: 1
  - clean_terminal: 2
```

#### `bun run cleanup:works` - 执行清理

**这是主要的清理命令**：

```bash
bun run cleanup:works
```

执行两步：
1. **自动终结**: 关闭delivered-but-open的Work
2. **清理**: 删除终结Work的worktree和分支

安全保障：
- ✅ 只处理clean worktree（没有未提交修改）
- ✅ 保留dirty worktree不动
- ✅ 只删除已合并到target branch的分支
- ✅ 创建bundle备份唯一提交

#### `bun run cleanup:works:force` - 强制清理clean worktrees

针对被阻塞的clean worktree：

```bash
bun run cleanup:works:force
```

遍历所有managed worktree：
- 检查是否clean
- 如果是delivered-but-open → 自动完成
- 如果是terminal → 触发清理

#### 高级选项

```bash
# 限制处理数量
bun run cleanup:works -- --max-work 10

# 只清理超过30分钟的Work
bun run cleanup:works -- --min-age-minutes 30

# 完整示例
bun tools/cleanup-works.ts --min-age-minutes 5 --max-work 50
```

## 使用流程

### 日常使用

**推荐定期运行（每天或每周）：**

```bash
# 1. 先看看有什么
bun run cleanup:works:dry

# 2. 确认无误后执行
bun run cleanup:works

# 3. 如果还有残留的clean worktree
bun run cleanup:works:force
```

### 首次清理（现在）

你的仓库现在有：
- 12个managed worktrees
- 5个clean（可以立即清理）
- 7个dirty（需要审查）

执行步骤：

```bash
# 1. 清理所有可以安全清理的
bun run cleanup:works

# 2. 检查剩余的worktree
ls -la ~/.forge/controller/managed-worktrees/repo_*/work-*

# 3. 对于dirty worktree，手动检查每一个
cd ~/.forge/controller/managed-worktrees/repo_123b7cf58b6b17b5cbe46a56/work-XXXXX
git status
# 决定是提交、丢弃还是保留
```

### 手动处理dirty worktree

对于每个dirty worktree：

**选项A - 提交保留的改动：**
```bash
cd <worktree-path>
git add .
git commit -m "Preserve work from <work-id>"
git push origin <branch>
# 然后运行 bun run cleanup:works
```

**选项B - 丢弃改动：**
```bash
cd <worktree-path>
git reset --hard HEAD
git clean -fd
# 然后运行 bun run cleanup:works
```

**选项C - 保留worktree（长期）：**
在WorkContract中标记为retained（目前需要手动编辑数据库或等待人工审查工具）

## 集成到Runtime

自动终结已经集成到periodic cleanup中：

**文件**: `src/runtime/control-plane/global-scheduler/periodic-cleanup-entry.ts`

修改内容：
```typescript
// 在terminal work cleanup之前运行Work auto-finalization
const finalizationReport = await executeAutoFinalization(controllerHome, {
  minAgeMinutes: 5,
  maxWork: 20,
  dryRun: false,
});
```

这意味着Runtime每次periodic cleanup（默认每小时）都会：
1. 先自动完成delivered-but-open的Work
2. 然后清理terminal Work
3. 最后做process GC

## 监控

查看当前状态：

```bash
# 查看work分支
git branch | grep work/

# 查看worktrees
git worktree list

# 查看managed worktrees存储
ls -la ~/.forge/controller/managed-worktrees/repo_*/

# 统计
git branch | grep work/ | wc -l
ls -d ~/.forge/controller/managed-worktrees/repo_*/work-* | wc -l
```

## 预防措施

为了避免未来累积：

1. **Controller应该在deliverWork时传递`complete_work: true`**
   ```typescript
   await deliverWork(ctx, {
     ...args,
     complete_work: true,  // 关键！
   });
   ```

2. **定期运行清理**（现在已自动化）
   - Periodic cleanup每小时自动执行
   - 或者手动：`bun run cleanup:works`

3. **监控累积指标**
   - 关注`git branch | grep work/ | wc -l`
   - 如果超过20个分支 → 运行清理

## 故障排除

### "DIRTY_WORKTREE_RETAINED"

**原因**: Worktree有未提交修改
**解决**: 手动审查并commit或reset

### "BRANCH_UNPRESERVED"

**原因**: 分支有唯一提交但无法创建bundle
**解决**: 通常是临时Git错误，重试即可

### "LIVE_WORK_OWNS_CHECKOUT"

**原因**: 另一个Work仍在使用这个checkout
**解决**: 等待另一个Work完成，或手动检查冲突

## 文件清单

- `src/runtime/maintenance/work-auto-finalization.ts` - 核心自动终结逻辑
- `src/runtime/maintenance/work-finalization-scheduler.ts` - 调度器
- `tools/cleanup-works.ts` - 主清理CLI工具
- `tools/force-cleanup-clean-works.ts` - 强制清理工具
- `src/runtime/control-plane/global-scheduler/periodic-cleanup-entry.ts` - 集成点

## 下一步

1. **立即执行**: `bun run cleanup:works`
2. **审查dirty worktrees**: 手动检查那7个有未提交修改的
3. **监控**: 一周后检查`git branch | grep work/`确认不再累积
