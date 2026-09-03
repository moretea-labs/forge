# 平台支持

本文描述 Forge **普通 package 用户路径**的真实支持范围，并把源码/维护者基础设施与首次使用依赖分开，避免用户为了使用 Forge 被迫安装开发工具链。

## 支持矩阵

| 平台 | 状态 | 普通用户路径 |
| --- | --- | --- |
| macOS | 支持 | Package 安装、主控优先 setup、launchd Package Runtime、仓库/普通目录、MCP、插件与统一 `Computer` 产品。Browser 语义内置；原生 Desktop 语义需要已注册的 macOS Computer provider。 |
| 现代 Linux | 支持 | Package 安装、主控优先 setup、优先 `systemd --user` 的 Package Runtime、仓库/普通目录、MCP 与可移植 Provider。 |
| Windows + WSL2 | 支持且为 Windows 推荐路径 | Forge Runtime 在 WSL2 内按 Linux 方式运行；Windows 仍可承载 ChatGPT/浏览器客户端。 |
| Windows 原生 | 预览 | Package 安装、setup、portable Runtime/MCP、仓库注册/读取和可移植能力；暂不宣称重启后 Runtime 自动持久化和所有外部 Provider 组合都完整。 |

## 基础安装依赖

普通安装只要求：

- Node.js 20.10 或更高；
- npm（Node 自带）或 Bun；
- 可写用户目录。

**Git 只在启用仓库/软件开发能力时才需要。** 普通 package 用户不要求 Bun、Forge 源码 checkout、CodeGraph、Codex、Claude、Standalone Recovery、Cloudflare、Tailscale 或 OpenAI tunnel-client。

按能力才出现的依赖包括：Git 仓库操作；明确选择的 Codex/Claude 主控或执行入口；GitHub CLI；Computer Browser/Desktop provider 平台依赖；Google/Apple 等账号凭证；以及远程主控连接本机 MCP 时选择的 tunnel/provider。

## 各平台 Runtime owner

普通用户使用：

```bash
forge runtime service install-package
```

它会对已安装 `@moretea-labs/forge` 的 Runtime 表面做内容指纹；package 内容与记录身份不一致时拒绝启动，而不是静默跨版本执行。

- **macOS：** launchd 用户服务。
- **Linux / WSL2 且 user systemd 可用：** `systemd --user`，异常退出自动重启。
- **Linux 无 user systemd：** 明确退化为 portable detached-session，并提示不具备重启持久化。
- **Windows 原生：** 当前是 portable user-process 预览，不宣称重启持久化。

`forge runtime service install --repo ...` 的 Git/source immutable release 路径和 Standalone Recovery 都属于高级维护能力，不是普通用户初始化依赖。

## ChatGPT / 远程 MCP 连接方式

Forge MCP 始终保持 loopback。远程主控明确选择一种连接方式：

| Provider | 是否需要公网入站 | 典型用途 |
| --- | --- | --- |
| OpenAI Secure MCP Tunnel | 不需要 | OpenAI 组织有 tunnel 权限时优先；使用官方 `tunnel-client`，Forge 只记录非秘密 tunnel ID。 |
| Cloudflare Tunnel | 是 / HTTPS 互联网可达 | 用户管理 Cloudflare 账号/域名，需要稳定 named HTTPS endpoint。 |
| Tailscale Funnel | 是 / HTTPS 互联网可达 | 已有兼容 Tailscale 环境。 |
| 已有 HTTPS `/mcp` | 取决于用户基础设施 | 用户已有反代或 tunnel。 |
| None | 不需要 | 本地主控，或稍后再接远程。 |

setup 会检测操作系统与 provider CLI，不会假定所有用户都是 macOS + Homebrew。第三方登录始终由用户明确完成，Forge 不要求把账号密码/API key 粘贴进 setup。

## Windows 原生范围

PowerShell 路径会检查安装器/CLI、doctor、setup/profile、仓库 Registry、Windows 路径/进程和 portable Node 行为。依赖 Bash 的仓库迁移、所有 Browser/Provider 组合，以及 Windows 持久 Service owner 仍不属于完整支持；这些场景优先使用 WSL2。

## 验证边界

仓库有平台/public-doc 检查和 Windows smoke。这里的“支持”只代表列出的主路径有验证证据，不表示每台机器都已安装每个第三方 Provider。
