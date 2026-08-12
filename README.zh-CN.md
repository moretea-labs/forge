# Forge

<p align="center"><img src="docs/images/forge-banner-cn.svg" alt="Forge——ChatGPT 决策，Forge 执行" width="1280"></p>
<p align="center"><strong>让 ChatGPT 真正、安全地操作你的电脑、代码、浏览器和外部服务。</strong></p>
<p align="center"><a href="https://github.com/moretea-labs/forge#english">English</a> · <a href="https://github.com/moretea-labs/forge#zh-cn">仓库首页中文</a> · <a href="docs/README.zh-CN.md">中文文档</a> · <a href="docs/operations/features.zh-CN.md">功能清单</a> · <a href="https://github.com/moretea-labs/forge/releases">版本发布</a></p>
<p align="center"><img alt="CI" src="https://github.com/moretea-labs/forge/actions/workflows/ci.yml/badge.svg"> <img alt="Release" src="https://img.shields.io/github/v/release/moretea-labs/forge?include_prereleases&sort=semver"> <img alt="npm next" src="https://img.shields.io/npm/v/%40moretea-labs%2Fforge?tag=next&label=npm%20next"> <img alt="License" src="https://img.shields.io/github/license/moretea-labs/forge"></p>

**ChatGPT 是主控，Forge 是行动层。** ChatGPT 负责理解目标、判断下一步和与你沟通；Forge 负责把这些决定安全地落到真实世界：本机文件、命令、仓库、浏览器、macOS、Apple 开发流程以及你的外部服务。

正常的 ChatGPT Connector 路径**不要求单独配置 OpenAI API Key，也不需要额外准备一套按 token 计费的模型预算**；仍受你自己的 ChatGPT 套餐和会话限制。Codex、Claude、OpenAI API 或其他模型只是可选的委派/自动化后端，不是使用 Forge 的前置条件。

## 为什么这和普通 Coding Agent 不一样

- **对话就是主工作台**：不用切到另一个 Agent 产品里重新解释上下文；ChatGPT 直接做主控。
- **不只会写代码**：同一个对话可以处理目录文件、命令、浏览器、桌面、邮件、日历、GitHub、iOS 与 App Store Connect。
- **真实执行状态在聊天之外**：长命令、检查、仓库身份、授权和恢复状态可以继续接上；定时/周期任务也可以持久化，在需要判断时再交回 ChatGPT。
- **需要时才委派 Agent**：明确的小任务直接完成；Codex/Claude 等只在确实有价值时作为执行者加入。
- **权限不是全有或全无**：本机目录授权可过期；远程、破坏性、密钥和工作区外访问有独立边界。

## 你可以直接这样说

```text
“把这个 bug 修好，跑完测试，提交，然后把临时 worktree 清掉。”
“读取我授权的这个目录，整理文件，并在 Finder 里打开结果。”
“在 Chrome 里把这个流程走一遍，截图核对，然后修 UI。”
“汇总今天邮件，把明显广告归档，重要邮件整理给我。”
“看最新 TestFlight 构建，告诉我离发布还差什么。”
```

## 现在能做什么

| 领域 | 典型能力 |
| --- | --- |
| **本机文件与命令** | 授权目录后列出/读取/写入/复制/移动文件、创建目录、打开文件/Finder、typed command、校验过的项目脚本、系统与进程诊断、macOS LaunchAgent 管理。 |
| **软件开发** | 多仓库读取与修改、Git、patch、测试/构建、长进程、worktree、验证、提交与清理；支持 Direct-first 的快速任务路径。 |
| **Browser / Desktop** | 页面导航、读取、选择器、点击、填写、截图、文件传输、人工 handoff；Chrome/Vivaldi 原生 attach；macOS Desktop 与可安装的 Desktop Operator。 |
| **Apple** | iOS 项目/模拟器/设备；App Store Connect 应用、版本、Build、TestFlight、审核信息和 Xcode Cloud workflow。 |
| **生产力服务** | GitHub Issue/Project、Gmail、Google Calendar、Google Tasks、Resend Email。 |
| **扩展能力** | 官方目录中的 Forge Design、Personal Knowledge Assistant、Desktop Operator；外部 Provider 仍复用 Forge 的权限和执行边界。 |

> 具体能力依赖操作系统、已安装 Provider、账号授权和目标服务配置。Forge 不会因为 README 写了某项能力就绕过平台权限或服务认证。

## 快速开始

需要 **Git、Node.js 20.10+、npm** 和可写用户目录；源码开发建议 Bun 1.0+。

```bash
npm install -g @moretea-labs/forge@next
forge --version
forge setup open --target both
forge setup next     # 重复直到 ready
forge setup close
forge doctor
```

接着阅读：

1. [安装与启动](docs/tutorials/01-install-and-start.zh-CN.md)
2. [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)
3. [完成第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)

接入项目：

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

从源码安装已审查 checkout：

```bash
git clone https://github.com/moretea-labs/forge.git && cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

## 插件与能力

Forge 内置本机、Browser、Desktop、iOS、GitHub、Gmail、Calendar、Tasks、App Store Connect、Resend 等类型化插件；公开 Provider 目录还提供 **Forge Desktop Operator**、**Forge Design**、**Personal Knowledge Assistant**。运行 `forge plugin catalog` 查看当前固定版本目录，详见[插件管理](docs/forge-plugin-management.md)和[功能清单](docs/operations/features.zh-CN.md)。

## 安全不是宣传词

Forge 把读取、普通本地写入、远程操作、破坏性操作、工作区外访问和密钥访问分开处理。本机目录采用显式授权；高风险行为需要更强确认。Full Access 只减少普通工作的重复提示，不会取消这些硬边界。详见 [SECURITY.md](SECURITY.md) 和[安全模型](docs/wiki/Security-Model.md)。

## 文档与项目

[中文文档中心](docs/README.zh-CN.md) · [Wiki](docs/wiki/Home.md) · [SUPPORT.md](SUPPORT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md)

当前 Release Candidate 是 `1.5.0-rc.1`，RC 的 npm 使用 `next`；首个稳定版发布后稳定通道使用 `latest`。
