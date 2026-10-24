# Work cleanup

Work 的语义状态由现有 Controller/Work Writer 显式决定。Git 已合并、工作树干净或经过一定时间，都不能证明用户目标已完成，也不能自动完成开放的 Work。

## 清理已经终结的 Work

```bash
bun run cleanup:works
```

此命令调用现有 `reconcileTerminalWorkCleanups`，只处理规范状态已经是 completed 或 cancelled 的 Work；不会完成开放 Work。资源归属、Git 包含性、未提交修改、保留包和清理回执由同一个 canonical cleanup owner 检查和维护。

可以限制单次处理数量和最短终结时间：

```bash
bun run cleanup:works -- --max-work 10 --min-age-minutes 30
```

输出包括 scanned、eligible、attempted、cleaned、blocked 和 errors。被阻塞时，检查具体 Work 的清理回执和当前 Git/Process/lease 证据；保留尚未证明可清理的源文件、分支和保留包。

## 无写入模式

```bash
bun run cleanup:works:dry
```

当前实现只报告不会修改 Work，然后退出；它不会枚举或预测清理候选。

## 开放或放弃的 Work

先由原语义 Writer 核对用户目标、交付证据和未完成义务，再显式完成或取消原 Work。放弃包含未提交内容的 managed checkout 时，使用现有 `discard_work` 能力，通过语义 CAS 和已有保留/清理事务处理；不要用 Git reset/clean 代替 Work 的语义决定或来源保护。

历史自动终结模块及强制自动完成脚本已退役。普通终结清理命令继续可用，源码合并不会自动关闭 Work 或激活 Runtime。

实现入口：[cleanup-works.ts](../../tools/cleanup-works.ts)、[Work terminal cleanup](../../src/runtime/control-plane/execution/work-terminal-cleanup.ts)。
