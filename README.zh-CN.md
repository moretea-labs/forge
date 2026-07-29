# Matea

<p align="center">
  <img src="docs/images/matea-banner-cn.svg" alt="Matea——本地优先的行动型助手" width="1280">
</p>

<p align="center"><strong>面向软件工作的本地优先行动型助手。</strong></p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

Matea 为 ChatGPT 提供一个持久、本地、可审查的工作空间，用来理解项目、执行有边界的操作并返回证据。当前重点是软件仓库，但产品模型并不局限于 Repo Controller，后续可以自然扩展到浏览器、外部服务、设备和个人工作流。

## Matea 能做什么

- **理解项目上下文**：读取仓库、文档、任务状态和历史证据。
- **有边界地执行操作**：使用可审查补丁、隔离 worktree、检查门禁，以及远程或破坏性操作的显式授权。
- **保存可恢复的工作状态**：把计划、Run、handoff 和验证记录与仓库绑定，而不是依赖某一次聊天记录。
- **连接 ChatGPT 与本地执行环境**：提供 MCP、CLI 和本地运行时。
- **按需扩展工具与助手能力**：可接入编码 Agent、浏览器、GitHub 和其他插件，但不能绕过权限、策略和审查。

## 发布状态

Matea 正在准备 `1.4.0-rc.6`。npm 包 `@moretea-labs/matea` **目前尚未公开发布**，因此当前可验证路径仍是源码安装；下面的 registry 命令用于即将发布的 RC。

## 快速开始

需要 Git、Node.js 20.10 或更高版本、npm 和可写的用户目录。Bun 1.0+ 是可选项，推荐用于源码开发和完整测试。

```bash
git clone https://github.com/moretea-labs/matea.git
cd matea
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund

matea --version
matea init --target both
matea doctor
```

接入一个仓库：

```bash
matea adopt --repo /path/to/your-project --dry-run
matea adopt --repo /path/to/your-project
matea repo list --json
```

npm RC 发布后可以使用：

```bash
npm install -g @moretea-labs/matea@next
# 或从同一个 npm 包安装：
bun add -g @moretea-labs/matea@next
```

Bun 直接消费同一个 npm 包，不建立单独的发布渠道或版本线。

## 兼容策略

`repo-harness` 与 `repo-harness-hook` 在 Matea 1.x 迁移期继续作为兼容命令。现有 `.repo-harness` 运行目录和协议标识也会保留，避免品牌升级破坏本地状态与已有集成。

## 连接 ChatGPT

1. [安装并启动](docs/tutorials/01-install-and-start.zh-CN.md)
2. [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)
3. [完成第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)

Connector 使用稳定的 HTTPS `/mcp` endpoint。维护中的教程包含认证、本地监听、Tailscale Funnel、Cloudflare 和故障排查。

## 文档

- [文档中心](docs/README.md)
- [公开使用指南](docs/public-usage-guide.zh-CN.md)
- [功能与配置层级](docs/operations/features.zh-CN.md)
- [平台支持](docs/operations/platform-support.zh-CN.md)
- [故障排查](docs/operations/troubleshooting.zh-CN.md)
- [发布流程](docs/operations/releasing.zh-CN.md)
- [架构 Wiki](https://github.com/moretea-labs/matea/wiki) 与 [版本化 Wiki 源文件](docs/wiki/Home.md)

架构、生命周期、恢复机制和运维细节统一放在 Wiki 与版本化文档中，不再堆入主 README。

## 项目状态与支持

Matea 仍处于 RC 收敛阶段，在 `1.4.0` 前接口可能调整。稳定版本只会从通过公开 release gate 的不可变 revision 发布。

- Bug 和文档问题：[GitHub Issues](https://github.com/moretea-labs/matea/issues)
- 使用问题：[SUPPORT.md](SUPPORT.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)

## 许可证与归属

项目采用 [MIT License](LICENSE)。Matea 最初基于 `AncientTwo/repo-harness` 开发，之后形成了大量修改并由 Moretea Labs 独立维护。上游版权和许可声明仍依法保留，详细信息见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
