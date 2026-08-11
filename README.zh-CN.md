# Forge

<p align="center">
  <img src="docs/images/forge-banner-cn.svg" alt="Forge——本地优先的行动型助手" width="1280">
</p>

<p align="center"><strong>面向软件工作的本地优先行动型助手。</strong></p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

Forge 把 ChatGPT 连接到真实的本地开发环境，让它读取当前项目状态、执行有边界的修改、运行检查、管理长时间命令，并返回可审查证据，而不是只依赖聊天上下文。

## Forge 能做什么

- **操作真实本地仓库**：一次注册多个仓库，后续执行显式绑定具体 repository 和 checkout。
- **小任务保持轻量**：范围明确的修改默认走 Direct；仅仅先调查代码不会自动创建 Plan、Issue、Agent 或 worktree。
- **长命令不重复执行**：build、test 等使用一个稳定 Process 生命周期，之后可以查询、等待、查看日志或取消。
- **支持真实并发**：不同仓库可并行；同一仓库需要隔离时可使用不同 worktree；同一个 checkout 仍保持单写者。
- **复用有效验证**：等价 check 可以合并执行或复用证据；代码或环境变化会使旧证据失效。
- **显式操作未注册目录**：一次性的本地目录任务不会偷偷注册仓库或初始化 Git。
- **执行状态可恢复**：仓库身份、工作状态、Process、验证、发布和恢复信息不依赖某一轮聊天。
- **硬边界明确**：远程写入、破坏性操作、工作区外访问和密钥访问继续受策略约束。
- **通过类型化插件扩展**：可选能力复用同一个本地 Controller，但不扩大普通 ChatGPT 默认工具面。

## ChatGPT 如何使用 Forge

普通 ChatGPT Connector 的默认 MCP 工具面收敛为 **19 个工具**。五个稳定 facade——`rh_status`、`rh_access`、`rh_inbox`、`rh_context`、`rh_work`——覆盖主要编排，其余工具负责仓库、源码/补丁、check、Process、插件分发和结果读取。

正常使用时不需要自己选工具，直接描述目标即可。Forge 的目标是选择**最短的有效执行路径**。

```text
小任务：状态 -> 相关上下文 -> Direct Edit -> focused check -> commit
长任务：确定身份 -> 确有需要才建 durable work -> Process/worktree -> verify -> integrate -> clean
```

例如：
- “用 Forge 找出这个测试为什么失败，修复、跑相关测试并提交。”
- “比较这两个已注册仓库，并分别完成修改。”
- “执行 build；如果时间较长，继续复用同一个 Process，不要重复启动。”
- “检查这个本地目录，但不要注册成仓库。”
- “检查当前 Runtime，告诉我真正阻塞发布的是什么。”

## 为什么使用 Forge

- **真实状态不只在聊天里**：Git、仓库身份、执行状态、检查和证据都可以在本地继续读取。
- **Direct-first**：重型流程只用于恢复、隔离、依赖、长时间执行或真实风险。
- **执行身份明确**：`repoId + checkoutId` 防止一个会话误操作另一个 checkout。
- **结果可审查**：局部 diff、精确 check、Process receipt 和 release evidence 都能说明实际发生了什么。
- **本地控制**：Canonical Runtime 与 Recovery authority 保留在本机。
- **客户端契约稳定**：工具 schema 变化通过可恢复 reinitialize fence 处理，而不是继续使用过期 schema。

## 发布状态

源码当前版本是 `1.4.0-rc.6`。npm 包 `@moretea-labs/forge` **目前尚未公开**。源码版本、release-ready、GitHub Release 和 npm 发布是不同事实；只有不可变 revision 通过 release gate 后才进入对外发布。

## 快速开始

需要 Git、Node.js 20.10 或更高版本、npm 和可写的用户目录。Bun 1.0+ 对安装使用不是强制要求，推荐用于源码开发和完整测试。

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund

forge --version
forge setup open --target both
# 完成提示的配置动作，然后继续：
forge setup next
forge setup close
forge doctor
```

接入一个仓库：

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

维护中的首次使用路径：
1. [安装并启动](docs/tutorials/01-install-and-start.zh-CN.md)
2. [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)
3. [完成第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)

npm RC 发布后：

```bash
npm install -g @moretea-labs/forge@next
# 或使用 Bun 消费同一个包：
bun add -g @moretea-labs/forge@next
```

## 执行模型

**Direct** 是范围明确、小型工作的默认路径。**Process Runtime** 管理需要进程生命周期的命令和检查：命令只 spawn 一次，后续 status/wait/log/cancel 都连接到同一次执行。**Durable work 与 worktree** 仅用于确实需要恢复、隔离、依赖、并发或更长生命周期的目标。**Canonical Runtime + Recovery** 提供一个活动本地 Runtime authority 和一个独立恢复边界。

详见[核心概念](docs/wiki/Core-Concepts.md)、[工作生命周期](docs/wiki/Work-Lifecycle.md)、[Runtime 架构](docs/wiki/Runtime-Architecture.md)与[实现地图](docs/wiki/Implementation.md)。

## 安全与产品标识

Forge 区分读取、普通本地修改、远程影响、破坏性操作、工作区外访问和密钥访问。Full Access 只减少普通本地仓库工作的重复授权，不会削弱 destructive、remote 或 secret 边界。详见[安全模型](docs/wiki/Security-Model.md)。

当前产品统一使用 **Forge**。公开命令为 `forge`、`forge-hook` 与 `forge-runtime`。历史法律归属和明确的只读迁移 fallback 可以保留旧上游标识，因为改写历史证据本身是不正确的。

## 文档与支持

- [文档中心](docs/README.md) · [Wiki](docs/wiki/Home.md) · [架构](docs/wiki/Architecture.md) · [实现地图](docs/wiki/Implementation.md)
- [公开使用指南](docs/public-usage-guide.zh-CN.md) · [平台支持](docs/operations/platform-support.zh-CN.md) · [故障排查](docs/operations/troubleshooting.zh-CN.md) · [发布流程](docs/operations/releasing.zh-CN.md)
- Bug/文档：[GitHub Issues](https://github.com/moretea-labs/forge/issues) · 使用：[SUPPORT.md](SUPPORT.md) · 安全：[SECURITY.md](SECURITY.md)
- 贡献：[CONTRIBUTING.md](CONTRIBUTING.md) · 版本：[CHANGELOG.md](CHANGELOG.md)

Forge 仍处于 RC 收敛阶段；发布只能来自通过公开 release gate 的 revision。

## 许可证与归属

项目采用 [MIT License](LICENSE)。上游版权与许可声明依法保留，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
