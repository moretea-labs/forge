# 执行与验证生命周期

Forge 的 **Work / WorkHandle / WorkContract 一等执行生命周期已经退役**（含历史与只读兼容）。当前开发与自动运行不应创建、恢复、完成、读取或借用旧 Work 获得权限。残余 Controller Home 中的 Work 字节属于离线物理 purge 待删 backlog，不是可查询审计 API。当前架构依据以 [CURRENT.md](https://github.com/moretea-labs/forge/blob/main/docs/architecture/CURRENT.md) 为准。

## 当前事实所有者

1. **GitHub Issue / Project**：开发目标、优先级、进度、最终验收与关闭。
2. **Requirement / Plan**：需求验收语义与可替换的实施记忆；不独立判定 GitHub Issue 完成。
3. **Repository / Checkout / Git**：源码事实、未提交修改、提交、分支、Git SHA / CAS。
4. **Process / Job / Run / Check / ResourceLease**：单次执行、验证、并发归属及结果回执。
5. **Schedule / WorkflowRun / Launcher**：明确的触发、工作流执行和模型会话投递。
6. **UserRequest**：需要真人确认的授权、输入或决策。

## 安全执行与恢复

在选定仓库和 checkout 上读取最新 Issue 决定、实际源码和 Git 状态；只针对当前目标编辑，保留他人的 dirty、staged 修改与未合并提交。通过 Git / checkout / ResourceLease 所有者管理实际资源冲突，并保留权限、幂等、未知外部副作用的 fail-closed 边界。执行之后复核 diff，运行与变更相关的检查，提交明确路径，将证据记录到既有 Issue。

后续会话依据 Issue、Requirement、源码、Git 和 Process/Check 回执重新建立上下文；既不要求恢复 WorkHandle，也不因为旧 Work 存储状态是 `open` 就视其为仍在运行的 Writer。

需要清理分支或 checkout 时，使用当前仓库的 Git 安全操作和实际资源占用证据；**不要**调用已退役的 `cleanup:works`、`discard_work` 或 Work 完成/取消接口，也不要通过 `git reset --hard`、`git clean` 绕过保护。

相关审计历史见 [Forge #483](https://github.com/moretea-labs/forge/issues/483)。
