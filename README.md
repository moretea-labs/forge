<a id="english"></a>

<p align="center"><img src="docs/images/forge-banner.svg" alt="Forge — ChatGPT decides, Forge acts" width="1280"></p>
<p align="center"><strong>Give ChatGPT real, controlled hands on your computer, code, browser, and services.</strong></p>
<p align="center"><a href="#english">English</a> · <a href="#zh-cn">简体中文</a> · <a href="docs/README.md">Docs</a> · <a href="docs/operations/features.md">Features</a> · <a href="docs/forge-plugin-management.md">Plugins</a> · <a href="https://github.com/moretea-labs/forge/releases">Releases</a></p>
<p align="center"><img alt="CI" src="https://github.com/moretea-labs/forge/actions/workflows/ci.yml/badge.svg"> <img alt="Release" src="https://img.shields.io/github/v/release/moretea-labs/forge?include_prereleases&sort=semver"> <img alt="npm next" src="https://img.shields.io/npm/v/%40moretea-labs%2Fforge?tag=next&label=npm%20next"> <img alt="License" src="https://img.shields.io/github/license/moretea-labs/forge"></p>

**ChatGPT is the controller. Forge is the action layer.** Keep the conversation as your primary workspace, then let Forge perform the parts chat alone cannot: read and write authorized local files, execute commands, work across repositories, operate browsers and macOS, call service plugins, keep long-running work attached, and bring back evidence you can review.

For the normal ChatGPT Connector path, Forge does **not** require a separate OpenAI API key or a second per-token model budget. Your existing ChatGPT plan/session limits still apply. Optional Codex, Claude, OpenAI API, or other model providers are separate delegation paths—not a requirement for using Forge.

## What Forge gives ChatGPT

| Capability | What that means for you |
| --- | --- |
| **Your local computer** | Authorize a folder, then let ChatGPT list/read/write/copy/move files, create directories, open documents or Finder, run bounded commands, inspect processes, and manage verified macOS LaunchAgents. |
| **Real software work** | Inspect and edit repositories, run tests/builds, use Git and worktrees, keep long commands attached, verify results, commit, and clean temporary work. |
| **Browser + desktop** | Navigate, inspect, click, fill, screenshot, transfer files, and hand off when human interaction is required; Chrome/Vivaldi native attach and macOS desktop actions are supported where available. |
| **Apple workflows** | Build and inspect iOS projects, work with simulators/devices, and use App Store Connect for apps, builds, TestFlight, review state, and Xcode Cloud workflows. |
| **Your services** | Typed plugins for GitHub, Gmail, Google Calendar, Google Tasks, Resend, plus independently released Forge providers. |
| **Automation + recovery** | Long commands stay attached instead of being restarted; scheduled/recurring work can persist outside chat and hand control back to ChatGPT when reasoning is needed. Repository identity, checks, approvals, and recovery facts survive outside the conversation. |

### Ask for outcomes, not tools

```text
“Clean up these generated files, run the project checks, commit the fix, and remove the worktree.”
“Read this authorized folder, reorganize the documents, and open the result in Finder.”
“Open the web app, test this flow in Chrome, capture evidence, then fix the UI regression.”
“Summarize today’s inbox, archive obvious promotions, and prepare the important replies.”
“Check the latest TestFlight build and tell me what blocks release.”
```

Forge deliberately keeps the tool mechanics below the conversation. You describe the goal; ChatGPT chooses the next action, Forge enforces scope and execution policy, and optional specialist agents can be delegated only when they add value.

## Start in minutes

Requirements: **Git, Node.js 20.10+, npm**, and a writable home directory. Bun 1.0+ is recommended for source development.

```bash
npm install -g @moretea-labs/forge@next
forge setup open --target both
forge setup next     # repeat until ready
forge setup close
forge doctor
```

Then follow [Install and start](docs/tutorials/01-install-and-start.md) and [Connect ChatGPT](docs/tutorials/02-connect-chatgpt.md). To adopt a project: `forge adopt --repo /path/to/your-project`.

For a reviewed source checkout: `git clone https://github.com/moretea-labs/forge.git && cd forge && npm ci --ignore-scripts --no-audit --no-fund && npm install -g . --omit=optional --no-audit --no-fund`.

## Built in, and extensible

Forge ships typed local/browser/desktop/iOS/GitHub/Gmail/Calendar/Tasks/App Store Connect/Resend capabilities. The public provider catalog currently includes **Forge Desktop Operator**, **Forge Design**, and **Personal Knowledge Assistant**; install with `forge plugin catalog` / `forge plugin install <id>`. See [Features](docs/operations/features.md) and [Plugin Management](docs/forge-plugin-management.md).

## Controlled by design

Local read/write grants are explicit and expiring; remote or destructive effects are distinguished from ordinary local work; high-impact actions require stronger confirmation. Full Access reduces repetitive prompts for normal work without removing the hard boundaries around secrets, destructive actions, and outside-workspace access. See [Security](SECURITY.md) and the [Security Model](docs/wiki/Security-Model.md).

**Docs:** [Wiki](docs/wiki/Home.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md). Current release candidate: `1.5.0-rc.1`; RCs use npm `next`. Stable releases use `latest` after a stable version exists.

---
<a id="zh-cn"></a>

<p align="center"><img src="docs/images/forge-banner-cn.svg" alt="Forge——ChatGPT 决策，Forge 执行" width="1280"></p>
<p align="center"><strong>让 ChatGPT 真正、安全地操作你的电脑、代码、浏览器和外部服务。</strong></p>
<p align="center"><a href="#english">English</a> · <a href="#zh-cn">简体中文</a> · <a href="docs/README.zh-CN.md">中文文档</a> · <a href="docs/operations/features.zh-CN.md">功能</a> · <a href="docs/forge-plugin-management.md">插件</a></p>

**ChatGPT 是主控，Forge 是行动层。** 你仍然把 ChatGPT 对话当作主要工作入口，但 Forge 能把“聊天”扩展成真实执行：读写授权的本机目录、运行命令、修改代码和 Git、操作浏览器与 macOS、调用邮件/日历/Apple 等插件，并把长任务状态和验证证据保存在聊天之外。

正常的 ChatGPT Connector 路径**不要求你再为 Forge 配一份 OpenAI API Key，也不需要额外准备一套按 token 计费的模型预算**；仍然受你自己的 ChatGPT 套餐和会话限制。Codex、Claude、OpenAI API 等只是可选委派能力，不是 Forge 的前置条件。

## Forge 能让 ChatGPT 做什么

| 能力 | 用户真正得到什么 |
| --- | --- |
| **操作本机** | 授权一个目录后，可列出/读取/写入/复制/移动文件，创建目录，打开文档或 Finder，执行受控命令，查看进程并管理经过身份校验的 macOS LaunchAgent。 |
| **完成真实开发任务** | 读取和修改仓库、运行测试/构建、操作 Git/worktree、持续跟踪长命令、验证结果、提交并清理临时工作区。 |
| **浏览器与桌面** | 页面导航、读取、点击、填写、截图、文件传输；需要人工时再 handoff；可使用 Chrome/Vivaldi 原生 attach 与 macOS 桌面能力。 |
| **Apple 工作流** | iOS 构建、模拟器/设备，以及 App Store Connect 的版本、构建、TestFlight、审核状态和 Xcode Cloud。 |
| **连接你的服务** | GitHub、Gmail、Google Calendar、Google Tasks、Resend，以及独立发布的 Forge Provider。 |
| **自动化与可恢复执行** | 长命令不会因为聊天继续而重跑；定时/周期工作可以持久化，在需要判断时再交回 ChatGPT。仓库身份、检查、授权与恢复状态也不只存在于聊天上下文里。 |

```text
“把这个 bug 修好，跑完测试，提交，然后把临时 worktree 清掉。”
“读取我授权的这个目录，整理文件，并在 Finder 里打开结果。”
“在 Chrome 里把这个流程走一遍，截图核对，然后修 UI。”
“汇总今天邮件，把明显广告归档，重要邮件整理给我。”
“看最新 TestFlight 构建，告诉我离发布还差什么。”
```

## 快速开始

需要 **Git、Node.js 20.10+、npm**；源码开发建议 Bun 1.0+。

```bash
npm install -g @moretea-labs/forge@next
forge setup open --target both
forge setup next     # 重复直到 ready
forge setup close
forge doctor
```

继续阅读[安装与启动](docs/tutorials/01-install-and-start.zh-CN.md)和[连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)。源码安装：`git clone https://github.com/moretea-labs/forge.git && cd forge && npm ci --ignore-scripts --no-audit --no-fund && npm install -g . --omit=optional --no-audit --no-fund`。

Forge 内置本机、Browser、Desktop、iOS、GitHub、Gmail、Calendar、Tasks、App Store Connect、Resend 等类型化能力；公开 Provider 目录还有 **Forge Desktop Operator / Forge Design / Personal Knowledge Assistant**。详见[功能清单](docs/operations/features.zh-CN.md)与[插件管理](docs/forge-plugin-management.md)。

安全上，普通本地修改、远程影响、破坏性操作、密钥和工作区外访问是不同边界；Full Access 不会取消高风险确认。详见[安全说明](SECURITY.md)和[安全模型](docs/wiki/Security-Model.md)。

**文档：** [Wiki](docs/wiki/Home.md) · [支持](SUPPORT.md) · [贡献](CONTRIBUTING.md) · [更新日志](CHANGELOG.md)。当前 RC 为 `1.5.0-rc.1`，RC 的 npm 使用 `next`；首个稳定版发布后稳定通道使用 `latest`。
