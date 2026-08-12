# 安装与连接故障排查

## 安装后找不到 `forge`

先重新打开终端。npm 用户可执行 `npm config get prefix`，确认其可执行目录已加入 `PATH`；Bun 用户确认 Bun bin 目录已加入 `PATH`。

```bash
node --version
npm --version
bun --version   # 可选
forge --version
```

## Doctor 提示缺少 Git 或 Node

Node.js 20.10+ 是基础依赖，即使 package 由 Bun 安装也需要 Node。Git **不是**基础安装依赖；只有启用仓库/软件开发能力时才需要。如果普通 `forge setup` 只是被未选择的 Codex/Claude/CodeGraph 检查挡住，应更新 Forge——主控优先 setup 会过滤无关 host tooling。

## Windows 原生流程停在 shell 步骤

仓库接入、Bash Hook、源码发布检查或 shell 生命周期脚本请使用 WSL2。Windows 原生会主动跳过 Bash skill 同步和 CodeGraph 自动配置。

## 本机 MCP 正常，但 ChatGPT 无法连接

`http://127.0.0.1:8765/mcp` 本来就只允许本机访问。执行 `forge setup next` 并检查当前选择的远程 provider。

- **OpenAI Secure MCP Tunnel：** 执行 `tunnel-client runtimes status forge --json`；只有 runtime 同时 running、healthy、ready 才算成功。`CONTROL_PLANE_API_KEY` 不进入 Forge state。
- **Cloudflare/Tailscale/已有 HTTPS：** 检查稳定 `/mcp` 地址、Provider 状态以及 `forge mcp doctor`。

不要把本地 Utility Console 端口暴露到公网。

## MCP 配置看起来写到了错误的位置

当前 service-level MCP 配置以 Controller Home 为主，不再以仓库内文件作为新安装主路径：

- `controllerHome/mcp/mcp.local.json`
- `controllerHome/mcp/mcp.tokens.json`
- `controllerHome/mcp/mcp.oauth.json`
- `controllerHome/mcp/mcp.oauth-tokens.json`
- `controllerHome/mcp/mcp.runtime.json`

Controller Home 是 service-level MCP 配置的唯一权威来源；仓库级 `.forge/mcp.policy.json` 仍是仓库访问策略。普通 ChatGPT 路径重新执行 `forge mcp setup chatgpt --user-level`，或直接继续 `forge setup next`；repo-scoped setup 仅保留兼容入口。

## ChatGPT 只显示少量工具

默认 Controller 故意暴露收敛后的稳定 facade，而不是所有内部原子 handler。Request/Full Access 改变授权，不改变工具 schema。通过 `rh_status` 检查 fingerprint 和缺失/意外工具；只有 ChatGPT app 的工具快照过期或定义发生变化时才刷新/重建。

## runtime storage 未就绪，或本地 UI 看起来是旧状态

不要把删除 `.ai/harness`、`.forge` 或 Controller Home 状态当成第一反应。先做有界诊断：

```bash
forge mcp doctor --repo /path/to/your-project
forge repo list --json
```

如果你正在使用运维/高级工具面，先走 runtime maintenance 路径，再决定是否重启或重放写操作。安全恢复流程见：

- `runtime_maintenance_status`
- `runtime_maintenance_apply`
- [自修复闭环](../forge-runtime-self-healing-loop.md)
- [Controller 可靠性 runbook](controller-reliability-runbook.md)

看到 `502`、重连或大结果截断，不代表 durable 写入一定失败；先回到 Job、Run 或证据摘要确认真实状态。

## Codex 或 Claude 控制入口不可用

Forge 没有一个必须修复的内部 Agent。没有选择 Codex/Claude 时直接忽略它们；明确选择为主控后，才安装/登录对应客户端，并执行 `forge mcp setup codex --scope user --profile controller` 或 `forge mcp setup claude --scope user --profile controller`，随后继续 `forge setup next`。

## Windows 与 WSL2 路径行为不一致

不要让一个 checkout 同时由 Windows 和 WSL2 操作。在哪个环境运行 Forge，就在该环境内 clone 并注册仓库，避免文件 mode、换行、symlink 和性能问题。

## 发布检查发现个人路径或日志

应删除被跟踪的运行态、绝对用户目录、凭据、日志、PID 和生成物，不要用大范围 allowlist 掩盖真实问题。
