# Work 清理快速参考

```bash
# 只清理已经由语义 Writer 完成或取消的 Work
bun run cleanup:works

# 限制本轮范围
bun run cleanup:works -- --max-work 10 --min-age-minutes 30

# 无写入模式：当前只报告安全退出，不列举候选
bun run cleanup:works:dry

# 查看当前 Git 状态和 checkout
git status --short
git worktree list
```

Git 已合并或工作树干净，不会自动完成开放 Work。已退役的自动终结/强制完成入口不能用于绕过语义 Writer。

出现 blocked/errors 时，检查原 Work 的清理回执、Git 包含性、活跃 Process/lease 和来源保留证据。放弃 Work 时使用现有 `discard_work` 事务，不直接 reset/clean 或删除工作树。

详见 [Work cleanup](work-cleanup-guide.md)。
