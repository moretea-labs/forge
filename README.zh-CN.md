# Matea

<p align="center">
  <img src="docs/images/matea-banner-cn.svg" alt="Matea——本地优先的行动型助手" width="1280">
</p>

<p align="center"><strong>面向软件工作的本地优先行动型助手。</strong></p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

Matea 为 ChatGPT 提供持久、本地、可审查的工作空间，用来理解项目、执行有边界的操作并返回证据。当前重点是软件仓库，同时保留扩展到工具、服务、设备与个人工作流的能力，而且不会牺牲本地控制权。

## 为什么使用 Matea

- **上下文不随聊天消失**：仓库注册、计划、工作状态、handoff 与验证证据可以跨会话保留。
- **执行边界清晰**：普通本地工作可以顺畅完成；远程写入、破坏性操作和密钥访问仍需显式授权。
- **结果可以审查**：补丁、独立分支或 worktree、精确检查与不可变发布证据都能被复核。
- **一个本地控制器管理多个仓库**：ChatGPT 只需连接一次，再显式路由到具体仓库与 checkout。
- **默认工作流足够简单**：先查看状态和上下文，再执行、验证；只有复杂任务才需要更深层工具。

## 发布状态

Matea 正在准备 `1.4.0-rc.6`。npm 包 `@moretea-labs/matea` **目前尚未公开发布**，所以当前可验证路径仍是源码安装。下面的 registry 命令描述即将发布的 RC 渠道，不能作为 npm 已发布的证据。

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

随后按维护中的路径完成首次使用：

1. [安装并启动](docs/tutorials/01-install-and-start.zh-CN.md)
2. [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)
3. [完成第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)

npm RC 发布后可以使用：

```bash
npm install -g @moretea-labs/matea@next
# 或从同一个 npm 包安装：
bun add -g @moretea-labs/matea@next
```

Bun 直接消费同一个 npm 包，不建立单独的发布渠道或版本线。

## 安全模型

Matea 区分读取、本地仓库修改、远程影响、破坏性操作和密钥访问。工作始终绑定到已注册仓库；当发布身份、运行时所有权或操作边界不明确时，系统会失败关闭。详见[核心概念](docs/wiki/Core-Concepts.md)、[工作生命周期](docs/wiki/Work-Lifecycle.md)与[安全模型](docs/wiki/Security-Model.md)。

## 兼容策略

`repo-harness` 与 `repo-harness-hook` 在 Matea 1.x 迁移期继续作为兼容命令。现有 `.repo-harness` 运行目录和协议标识也会保留，避免产品更名破坏本地状态与已有集成。

## 文档

- [文档中心](docs/README.md)
- [Wiki 首页](docs/wiki/Home.md)与 [GitHub Wiki](https://github.com/moretea-labs/matea/wiki)
- [公开使用指南](docs/public-usage-guide.zh-CN.md)
- [平台支持](docs/operations/platform-support.zh-CN.md)
- [故障排查](docs/operations/troubleshooting.zh-CN.md)
- [发布流程](docs/operations/releasing.zh-CN.md)

主 README 只保留首次使用信息；架构、生命周期、集成、恢复和运维流程统一放在版本化文档与 Wiki 源文件中。

## 项目状态与支持

Matea 仍处于 RC 收敛阶段，在 `1.4.0` 前接口可能调整。发布只能来自通过公开 release gate 的不可变 revision。

- Bug 和文档问题：[GitHub Issues](https://github.com/moretea-labs/matea/issues)
- 使用问题：[SUPPORT.md](SUPPORT.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)

## 许可证与归属

项目采用 [MIT License](LICENSE)。Matea 最初基于 `AncientTwo/repo-harness` 开发，之后形成了大量修改并由 Moretea Labs 独立维护。上游版权和许可声明仍依法保留，详细信息见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
