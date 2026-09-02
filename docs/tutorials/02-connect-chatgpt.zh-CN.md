# 教程 2：连接 ChatGPT

本教程把 ChatGPT 接成 Forge 的外部主控。Forge 和 MCP 仍只监听本机 loopback；ChatGPT 通过 OpenAI Secure MCP Tunnel，或用户明确选择的 HTTPS tunnel 访问它。

## 1. 先确认 ChatGPT 当前支持范围

ChatGPT 的 MCP 能力由套餐、工作区和管理员策略决定，会独立于 Forge 变化。开始前请查看 OpenAI 当前的[开发者模式和 MCP 应用](https://help.openai.com/zh-hans-cn/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta)说明。

本文更新时，包含写入/修改的完整 MCP 正在 ChatGPT Business、Enterprise、Edu 网页版中以 beta 提供；Pro 的开发者模式 MCP 当前是 read/fetch 范围。工作区还可能要求管理员开启 Developer Mode / RBAC。

Forge 不会绕过这些 ChatGPT 产品权限。

## 2. 让 Forge 准备本地运行环境

```bash
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

每次只按一个 `Next` 动作继续。普通用户的本地路径最终会使用：

```bash
forge mcp setup chatgpt --user-level
forge runtime service install-package
```

MCP 默认只监听：

```text
http://127.0.0.1:8765/mcp
```

首次 user-level setup 会保持 repository-centric Utility Console 关闭，直到你之后配置仓库/工作台目标；启用后它使用独立 loopback 端口（通常是 `8766`）。**不要把 Utility Console 暴露到公网。**

连接 ChatGPT 不要求先注册 Git 仓库。仓库、普通目录、Browser、Gmail 等能力可以之后按需配置。

## 3. 选择远程连接方式

执行 `forge setup next`，Forge 支持以下 provider。

### A. OpenAI Secure MCP Tunnel——有权限时优先

Secure MCP Tunnel 通过出站连接把本机/private MCP 接到 OpenAI 托管产品，不要求给 Forge 开公网入站。 `--tunnel auto` 会把它作为 ChatGPT 的第一优先传输，不会仅仅因为机器上装了 cloudflared/Tailscale 就静默改用公网方案。详见 OpenAI 的 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 与官方 [`openai/tunnel-client`](https://github.com/openai/tunnel-client)。

需要先在 OpenAI Platform 获得 tunnel ID 和使用权限。Forge 只记录**非秘密**的 tunnel ID：

```bash
forge setup configure \
  --controller chatgpt \
  --tunnel openai \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef
forge setup next
```

Forge 不要求、读取或保存 tunnel runtime API key。把它留在运行官方 tunnel-client 的环境中：

```bash
export CONTROL_PLANE_API_KEY='...'
```

安装 `tunnel-client` 后，setup 会引导官方的受管 runtime 路径，本质上是：

```bash
tunnel-client runtimes connect \
  --alias forge \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-server-url http://127.0.0.1:8767/mcp

tunnel-client runtimes status forge --json
```

只有 tunnel-client 返回 `process_running + healthy + ready` 后，Forge 才把这个连接判为 ready。

#### 地址到底变成什么？

使用 Secure Tunnel 后，不再需要给 Forge 准备一个公网 `/mcp` 地址。ChatGPT App 选择 `tunnel_id`；本机 `tunnel-client` 把命令转发到 Forge 的 **loopback OAuth Gateway**（默认 `127.0.0.1:8767/mcp`），再由 Gateway 代理到内部 bearer-only Runtime（默认 `127.0.0.1:8765/mcp`）。如果改过端口，以 `forge mcp setup chatgpt --user-level` 输出的 OAuth endpoint 为准。

App/connector 身份及 Forge 工具 schema 与网络传输层是两件事。Cloudflare/HTTPS 切到 Secure Tunnel 改变的是网络路径，不会生成另一套 19-tool Forge schema。同一个 App 已连接且 schema 没变化时，单纯切换网络不要求新开会话；新会话主要用于隔离 A/B 或排查客户端缓存。

### B. Cloudflare Tunnel

需要稳定公网 HTTPS、并且你管理 Cloudflare 账号/域名时使用：

```bash
forge setup configure --controller chatgpt --tunnel cloudflare
forge setup next
```

setup 会检测当前平台与 `cloudflared`。macOS 有 Homebrew 时可直接给出安装命令；Linux/WSL2 与 Windows 会给对应的官方安装路径，不会假设所有机器都是 Mac。

named tunnel 建好后，只记录最终 `/mcp` URL：

```bash
forge setup configure \
  --controller chatgpt \
  --tunnel existing \
  --endpoint https://forge.example.com/mcp
```

### C. Tailscale Funnel

已有 Tailscale 时可以选择：

```bash
forge setup configure --controller chatgpt --tunnel tailscale
forge setup next
```

Forge 检查当前平台的 Tailscale CLI 并引导 Funnel；获得最终 HTTPS `/mcp` URL 后再记录。

### D. 已有 HTTPS 或暂缓远程连接

```bash
forge setup configure \
  --controller chatgpt \
  --tunnel existing \
  --endpoint https://forge.example.com/mcp

# 暂时只完成本地配置：
forge setup configure --controller chatgpt --tunnel none
```

Cloudflare/Tailscale/已有 HTTPS 本质上会让 MCP endpoint 成为公网或互联网可达地址；OpenAI Secure MCP Tunnel 是组织有权限时的私有出站方案。

## 4. 在 ChatGPT 创建 App / Connector

ChatGPT UI 会变化，所以以 OpenAI 当前 Developer Mode 文档为准，不在 Forge 文档中固定截图路径。

使用 Secure MCP Tunnel 时选择 **Tunnel** 连接方式并选择/填入 tunnel ID，然后选择 **无身份验证**：已认证的 OpenAI Tunnel 就是外部授权边界；使用 HTTPS 时填入稳定、以 `/mcp` 结尾的 URL，并走 Forge 生成的 OAuth 流程。

创建后扫描/刷新工具。不要为了看到更多工具名而直接切到 exhaustive compatibility toolset；默认收敛工具面是安全和可用性设计的一部分。

## 5. 验证真实调用

先从只读提示开始：

```text
使用 Forge。调用 rh_status，告诉我 Forge Runtime 是否 ready。
先不要做任何修改。
```

之后再授权一个仓库或普通目录做读取验证。**真正 setup 成功的证据是 ChatGPT 已经实际调用 Forge**；只保存了 tunnel ID，或本机进程在运行，都不等于端到端已经连通。

## 6. 安全规则

- Forge MCP 与 Utility Console 都保持 loopback。
- 条件允许时优先使用私有出站的 Secure MCP Tunnel。
- 使用公网 HTTPS tunnel 时只暴露 MCP，不暴露本地 Utility Console。
- 不要把 MCP token、OAuth secret、tunnel runtime API key、admin key 发到聊天或写入 Forge setup state。
- 远程 Git、GitHub、邮件、破坏性清理、发布和密钥仍分别授权。
- Codex/Claude 只有明确选择为主控或执行入口时才配置。

需要软件开发能力时继续[教程 3：第一个仓库任务](03-first-repository-task.zh-CN.md)。Runtime、tunnel、Connector 或工具面异常时查看[故障排查](../operations/troubleshooting.zh-CN.md)。
