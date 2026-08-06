# 教程 1：安装并启动

本教程完成 CLI 安装、用户级运行时初始化、环境检查和第一个仓库注册。

## 1. 平台与基础环境

- macOS / Linux：完整支持。
- Windows：完整工作流推荐 WSL2。
- Windows 原生 PowerShell：预览支持安装、doctor、仓库注册/读取和可移植 Controller 操作。

需要 Git、Node.js 20.10 或更高版本、npm 和可写的用户目录。Bun 1.0+ 是可选项，推荐用于源码开发和完整测试。

```bash
git --version
node --version
npm --version
```

详细范围见[平台支持说明](../operations/platform-support.zh-CN.md)。

## 2. 当前安装方式

npm 包 `@moretea-labs/forge` 目前尚未公开，请从经过审查的源码 checkout 安装：

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

也可以让 Bun 使用同一个源码 package：

```bash
bun install
bun add -g .
```

RC 发布后，registry 安装命令会是：

```bash
npm install -g @moretea-labs/forge@next
# 或
bun add -g @moretea-labs/forge@next
```

该 package 只提供 `forge`、`forge-hook` 与 `forge-runtime`。不再发布此前产品的命令别名，也不要使用未加 scope 的替代包。

## 3. 打开引导式配置会话

```bash
forge --version
forge setup open --target both
```

`forge setup open` 会在 `~/.forge/setup/` 下创建或恢复同一个用户级配置会话，执行就绪检查，并且每次只给出一个下一步配置动作。完成该动作后继续执行：

```bash
forge setup next
```

反复执行 `forge setup next`，直到状态变成 `ready`，然后关闭会话：

```bash
forge setup close
```

可使用 `forge setup status` 查看持久化进度，使用 `forge setup check` 获取一次性只读报告。只使用一个 host 时可改为 `--target codex` 或 `--target claude`。配置会话不会静默执行远程写入、读取秘密、破坏性操作或服务安装。

## 4. 接入或注册仓库

macOS、Linux、WSL2 先预览再执行完整接入：

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
```

所有平台均可显式注册：

```bash
forge repo register /path/to/your-project --name my-project --json
forge repo list --json
```

保存返回的 `repoId`，它是 ChatGPT 和 Controller 使用的稳定仓库身份。

## 5. 确认环境就绪

```bash
forge setup status
forge doctor
forge status --json
forge repo list --json
```

运行态应保存在 Controller Home 和被忽略的仓库链接中，不应进入公开源码。不要提交 token、MCP runtime 文件、Local Job、日志或 worktree。

下一步阅读[教程 2：连接 ChatGPT](02-connect-chatgpt.zh-CN.md)，出现问题时看[故障排查](../operations/troubleshooting.zh-CN.md)。
