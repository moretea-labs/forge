# 公开使用指南

这是当前最短的 Forge 使用路径。

## 1. 安装并选择外部主控

```bash
npm install -g @moretea-labs/forge
forge setup
```

Forge 自己没有 AI 大脑。选择一个 primary 外部主控；推荐 ChatGPT，也可以明确选择 Codex、Claude 或其他 MCP 客户端。可以配置多个控制入口，但没被选择的客户端不会变成依赖。

```bash
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

## 2. 按 Next 完成所选路径

远程主控会继续配置 Package Runtime 和远程连接。有权限时优先 OpenAI Secure MCP Tunnel；也可以选择 Cloudflare Tunnel、Tailscale Funnel、已有 HTTPS `/mcp`，或暂缓远程连接。

普通 package Runtime 是 `forge runtime service install-package`。源码 immutable Runtime 与 Standalone Recovery 属于高级维护路径。

## 3. 只增加需要的能力

首次 setup 不要求 Git 仓库。需要软件开发时再接入：

```bash
forge adopt --repo /path/to/project --dry-run
forge adopt --repo /path/to/project
```

也可以之后授权普通目录，或配置 Browser、Desktop、Gmail、Calendar、Apple、GitHub 等类型化 Provider。Git、Codex、Claude、服务凭证和 tunnel CLI 都是按能力出现的依赖。

## 4. 用真实主控调用验收

ChatGPT 用户继续阅读[连接 ChatGPT](tutorials/02-connect-chatgpt.zh-CN.md)，先做只读 `rh_status`。本机进程在运行或 endpoint 已保存不等于真正完成；第一次主控到 Forge 的真实工具调用成功才是有意义的 setup 里程碑。

更多内容见[功能清单](operations/features.zh-CN.md)、[平台支持](operations/platform-support.zh-CN.md)、[插件管理](forge-plugin-management.md)和[故障排查](operations/troubleshooting.zh-CN.md)。
