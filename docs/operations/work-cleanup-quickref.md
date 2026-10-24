# Work清理工具 - 快速参考

## 快速命令

```bash
# 预览将要清理什么（安全，不做修改）
bun run cleanup:works:dry

# 执行自动清理（推荐）
bun run cleanup:works

# 强制清理所有clean worktrees
bun run cleanup:works:force
```

## 当前状态检查

```bash
# 查看work分支数量
git branch | grep work/ | wc -l

# 查看worktrees
git worktree list

# 查看managed worktrees
ls -la ~/.forge/controller/managed-worktrees/repo_*/work-*

# 检查哪些是dirty的
for wt in ~/.forge/controller/managed-worktrees/repo_*/work-*; do
  if [ -d "$wt" ]; then
    name=$(basename "$wt")
    dirty=$(cd "$wt" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$dirty" != "0" ]; then
      echo "DIRTY: $name ($dirty changes)"
    fi
  fi
done
```

## 手动清理单个dirty worktree

```bash
# 1. 进入worktree
cd ~/.forge/controller/managed-worktrees/repo_XXXXX/work-XXXXX

# 2. 查看修改
git status

# 3. 决定：提交、丢弃或保留
# 提交：
git add . && git commit -m "保存工作" && git push

# 丢弃：
git reset --hard HEAD && git clean -fd

# 4. 再次运行清理
cd /Users/greyson/DevProjects/forge
bun run cleanup:works
```

## 解决问题

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| DIRTY_WORKTREE_RETAINED | 有未提交修改 | 手动commit或reset |
| BRANCH_UNPRESERVED | 无法创建bundle | 重试或手动检查Git状态 |
| LIVE_WORK_OWNS_CHECKOUT | 另一个Work在用 | 等待或手动解决冲突 |

## 预防累积

定期运行（已自动化，每小时一次）：
```bash
bun run cleanup:works
```

或者添加到你的日常流程中。
