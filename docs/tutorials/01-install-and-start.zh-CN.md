# 教程 1：安装并选择主控

本教程把 Forge 从 package 安装带到可恢复的初始化流程。Forge **自己没有 AI 大脑**：始终由一个外部主控判断下一步，Forge 负责有边界的执行、持久状态、权限与证据。

## 1. 选择平台路径

- **macOS：** 支持；Package Runtime 使用 launchd 做用户级持久运行。
- **现代 Linux：** 支持；优先使用 `systemd --user`，不可用时会明确退化为当前会话的 portable 模式。
- **Windows + WSL2：** Windows 推荐路径；在 WSL2 内按 Linux 流程运行。
- **Windows 原生：** 预览；支持 CLI、setup、portable Runtime、MCP 和有边界的可移植能力，但暂不宣称重启后 Runtime 持久化与所有 Provider 组合都完整支持。

基础安装只需要 **Node.js 20.10 或更高版本**、npm（或 Bun）和可写用户目录。**Git 只在启用仓库/软件开发能力时才需要。** Codex、Claude、`gh`、Cloudflare、Tailscale、CodeGraph 和各服务账号都是按能力选装，不是 Forge 的安装前置条件。

```bash
node --version
npm --version
```

详细范围见[平台支持说明](../operations/platform-support.zh-CN.md)。

## 2. 安装 Forge

Release Candidate 使用 npm `next`：

```bash
npm install -g @moretea-labs/forge
# 或
bun add -g @moretea-labs/forge
forge --version
```

只有参与 Forge 源码开发时才需要源码安装：

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
bun install --frozen-lockfile
npm install -g . --omit=optional --no-audit --no-fund
```

发布 package 提供 `forge`、`forge-hook`、`forge-runtime`。普通 package 用户启动用户级 Runtime **不需要** Forge Git checkout、Bun 编译、CodeGraph 或 Standalone Recovery。

## 3. 开始引导式 setup

```bash
forge setup
```

首次执行会先选择外部主控。推荐 ChatGPT，但不是强制：

```bash
forge setup configure --controller chatgpt --tunnel auto
# 也可以：
# forge setup configure --controller codex
# forge setup configure --controller claude
# forge setup configure --controller mcp
```

可以预配置多个控制入口，但只有一个 primary controller：

```bash
forge setup configure \
  --controller chatgpt \
  --add-controller codex \
  --add-controller claude \
  --tunnel auto
```

机器上即使已经安装 Codex/Claude，只要没有明确选择，Forge 就不会把它们当成 readiness 依赖。

## 4. 每次只完成一个 Next 动作

```bash
forge setup next
```

setup 进度保存在用户级 Forge 目录，可以退出终端后继续。根据主控类型，流程会依次处理：

1. 主控注册；
2. Package Runtime；
3. 远程主控需要的安全 HTTPS；
4. 只能由用户完成的登录/浏览器认证；
5. 连接验证。

`forge setup status` 查看持久化进度；`forge setup check` 只读检查；ready 后使用 `forge setup close`。

普通用户的 Runtime 路径是：

```bash
forge runtime service install-package
```

对 ChatGPT，package 安装会同时维护两个本地服务边界：内部 bearer-only Canonical Runtime，以及独立的 loopback ChatGPT Connector。OpenAI Secure MCP Tunnel 在这个 Connector 上使用 tunnel/workspace authority，公网 HTTPS provider 则在这里使用 OAuth。绝不能把 tunnel 直接指向内部 Runtime 端口。

旧的 `forge runtime service install --repo ...` 会构建 Git/source immutable Runtime，属于**高级维护路径**；Standalone Recovery 同样不是普通用户初始化的前置条件。

## 5. 首次 setup 不要求仓库

只使用授权目录、浏览器/桌面或服务插件时，不需要先 adopt Git 仓库。需要软件开发能力时再接入项目：

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

从这一步开始，仓库工作流才需要 Git。

## 6. 验证基础环境

```bash
forge setup status
forge doctor
```

选择 ChatGPT 做主控时，继续阅读[教程 2：连接 ChatGPT](02-connect-chatgpt.zh-CN.md)。出现问题时看[故障排查](../operations/troubleshooting.zh-CN.md)。
