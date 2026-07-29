# repo-harness Controller Runtime

<p align="center">
  <img src="docs/images/repo-harness-banner.svg" alt="repo-harness Controller Runtime" width="1280">
</p>

<p align="center">
  <strong>本地优先、可恢复、可审查的 ChatGPT 仓库执行桥。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

repo-harness 让 ChatGPT 能够读取仓库、进行有边界的修改、运行检查、管理长期任务并返回证据，而不是把聊天记录当成事实来源。工作状态与仓库绑定，即使请求中断或换了会话，也可以继续推进。

## 能做什么

- **有边界的仓库工具**：读取文件、搜索代码、应用可审查补丁，以及使用结构化 Git 操作。
- **可恢复的工作状态**：仓库绑定的计划、任务状态、执行记录与审查证据。
- **更安全的执行方式**：隔离 worktree、路径限制、检查门禁，以及远程或破坏性操作的显式授权。
- **ChatGPT 接入**：通过 MCP endpoint 连接，同时提供本地 CLI 与 Controller UI 用于诊断和审查。
- **可选 Agent 与插件**：大范围实现和外部服务可以按需启用，但不能绕过仓库工作流与权限边界。

## 发布状态

仓库正在准备 `1.4.0-rc.6`，作为下一条可信 RC 基线。npm 包 `@moretea-labs/repo-harness-controller` **目前尚未公开发布**，因此文档会说明未来的 registry 安装命令，但不会把它描述成现在已经可用。

首次 npm 发布前，请从经过审查的源码 checkout 安装。

## 快速开始

需要 Git、Node.js 20.10 或更高版本、npm 和可写的用户目录。Bun 1.0+ 是可选项，推荐用于源码开发和完整测试。

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund

repo-harness --version
repo-harness init --target both
repo-harness doctor
```

接入一个仓库：

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
repo-harness repo list --json
```

npm RC 发布后，可以使用：

```bash
npm install -g @moretea-labs/repo-harness-controller@next
# 或从同一个 npm 包安装：
bun add -g @moretea-labs/repo-harness-controller@next
```

Bun 只是另一种 package client 和 runtime，不需要单独发布一份 repo-harness 包。

## 连接 ChatGPT

按下面顺序操作：

1. [安装并启动](docs/tutorials/01-install-and-start.zh-CN.md)
2. [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)
3. [完成第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)

Connector 使用稳定的 HTTPS `/mcp` endpoint。详细教程包含本地监听、认证、Tailscale Funnel、Cloudflare 和故障排查；这些运维细节不再塞进主 README。

## 文档

- [文档中心](docs/README.md)
- [公开使用指南](docs/public-usage-guide.zh-CN.md)
- [功能与配置层级](docs/operations/features.zh-CN.md)
- [平台支持](docs/operations/platform-support.zh-CN.md)
- [故障排查](docs/operations/troubleshooting.zh-CN.md)
- [发布流程](docs/operations/releasing.zh-CN.md)
- [架构 Wiki](https://github.com/moretea-labs/repo-harness-controller-runtime/wiki) 与 [版本化 Wiki 源文件](docs/wiki/Home.md)

主 README 有意保持面向用户。架构、生命周期、不变量、恢复机制和运维设计统一放到 Wiki 与版本化文档。

## 项目状态与支持

项目仍处于 RC 收敛阶段，在 `1.4.0` 前接口可能调整。稳定版只会从通过公开 release gate 的不可变 revision 发布。

- Bug 和文档问题：[GitHub Issues](https://github.com/moretea-labs/repo-harness-controller-runtime/issues)
- 使用问题：[SUPPORT.md](SUPPORT.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)

## 许可证与归属

项目采用 [MIT License](LICENSE)，源自 `AncientTwo/repo-harness`，并由 Moretea Labs contributors 进行了大量修改。详细信息见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
