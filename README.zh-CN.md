# Forge

<p align="center"><img src="docs/images/forge-banner-cn.svg" alt="Forge——ChatGPT 决策，Forge 执行" width="1280"></p>
<p align="center"><strong>让 ChatGPT 真正、安全地操作你的电脑、代码、浏览器和外部服务。</strong></p>
<p align="center"><a href="https://github.com/moretea-labs/forge#english">English</a> · <a href="https://github.com/moretea-labs/forge#zh-cn">仓库首页中文</a> · <a href="docs/README.zh-CN.md">中文文档</a> · <a href="docs/operations/features.zh-CN.md">功能清单</a> · <a href="https://github.com/moretea-labs/forge/releases">版本发布</a></p>
<p align="center"><img alt="CI" src="https://github.com/moretea-labs/forge/actions/workflows/ci.yml/badge.svg"> <img alt="Release" src="https://img.shields.io/github/v/release/moretea-labs/forge?include_prereleases&sort=semver"> <img alt="npm latest" src="https://img.shields.io/npm/v/%40moretea-labs%2Fforge?tag=latest&label=npm%20latest"> <img alt="License" src="https://img.shields.io/github/license/moretea-labs/forge"></p>

**Forge 自己没有 AI 大脑。** 每次语义决策都由一个外部主控负责，Forge 负责执行、持久状态、权限和恢复。默认推荐 ChatGPT，也可以明确选择 Codex、Claude 或其他 MCP 客户端；可以配置多个控制入口，但同一时刻只有一个主控拥有语义控制权。

选择 ChatGPT 时**不要求单独配置 OpenAI API Key，也不需要额外准备一套按 token 计费的模型预算**；仍受你的 ChatGPT 套餐和会话限制。没有选择 Codex/Claude，就不会把它们当成安装或就绪依赖。

## 为什么这和普通 Coding Agent 不一样

- **外部主控就是大脑**：推荐把 ChatGPT 对话作为主工作台；也可明确让 Codex、Claude 或其他 MCP 客户端担任主控，Forge 本身不参与语义决策。
- **不只会写代码**：同一个对话可以处理目录文件、命令、浏览器、桌面、邮件、日历、GitHub、iOS 与 App Store Connect。
- **真实执行状态在聊天之外**：长命令、检查、仓库身份、授权和恢复状态可以继续接上；定时/周期任务也可以持久化，在需要判断时再交回 ChatGPT。
- **没选就不依赖**：Codex/Claude 不会因为安装在机器上就进入 Forge readiness；只有你明确配置它们为主控或外部执行入口时才检查。
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

基础安装只需要 **Node.js 20.10+、npm（或 Bun）和可写用户目录**；Git 只在启用仓库/软件开发能力时需要，源码开发建议 Bun 1.0+。

```bash
npm install -g @moretea-labs/forge
forge --version
forge setup
forge setup configure --controller chatgpt --tunnel auto
forge setup next     # 按每次显示的 Next 动作继续
```

`forge setup` 会持久化进度。对 ChatGPT，`--tunnel auto` 现在明确表示 **优先 OpenAI Secure MCP Tunnel**：Forge 保持 Canonical Runtime 私有，安装一个仅监听 loopback 的 OAuth Gateway，再由官方 `tunnel-client` 通过出站连接接入 OpenAI。Secure Tunnel 不可用时，再显式选择 Cloudflare Tunnel、Tailscale Funnel、已有 HTTPS `/mcp` 或暂缓远程连接。本地主控 Codex/Claude 不需要 tunnel。ChatGPT App/connector 是应用身份，Secure Tunnel 是网络传输层；切换 tunnel 不会创建另一套 Forge 工具 schema。

接着阅读：[安装与启动](docs/tutorials/01-install-and-start.zh-CN.md) · [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md) · [第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)。仓库不是首次 setup 的前置条件；需要时再 `forge adopt --repo /path/to/your-project`。

已安装用户升级：`npm install -g @moretea-labs/forge@latest` → `forge --version` → `forge setup next`。

从源码安装已审查 checkout：

```bash
git clone https://github.com/moretea-labs/forge.git && cd forge
bun install --frozen-lockfile
npm install -g . --omit=optional --no-audit --no-fund
```

## 插件与能力

Forge 内置本机、Browser、Desktop、iOS、GitHub、Gmail、Calendar、Tasks、App Store Connect、Resend 等类型化插件；公开 Provider 目录还提供 **Forge Desktop Operator**、**Forge Design**、**Personal Knowledge Assistant**。运行 `forge plugin catalog` 查看当前固定版本目录，详见[插件管理](docs/forge-plugin-management.md)和[功能清单](docs/operations/features.zh-CN.md)。

## 安全不是宣传词

Forge 把读取、普通本地写入、远程操作、破坏性操作、工作区外访问和密钥访问分开处理。本机目录采用显式授权；高风险行为需要更强确认。Full Access 只减少普通工作的重复提示，不会取消这些硬边界。详见 [SECURITY.md](SECURITY.md) 和[安全模型](docs/wiki/Security-Model.md)。

## 文档与项目

[中文文档中心](docs/README.zh-CN.md) · [Wiki](docs/wiki/Home.md) · [SUPPORT.md](SUPPORT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md)

当前稳定版本是 `1.7.0`，稳定安装使用 npm `latest`。
