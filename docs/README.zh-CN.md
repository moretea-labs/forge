# Forge 中文文档

> 这里维护 Forge 当前产品与 Runtime 的公开文档。可执行代码与 [`architecture/current/`](architecture/current/) 是当前事实来源；历史设计与研究文档只提供背景，不覆盖当前契约。

[English docs](README.md) · [GitHub](https://github.com/moretea-labs/forge) · [版本发布](https://github.com/moretea-labs/forge/releases) · [支持](../SUPPORT.md)

## 从这里开始

| 目标 | 先读 | 接着读 |
| --- | --- | --- |
| 安装 Forge | [安装并启动](tutorials/01-install-and-start.zh-CN.md) | [平台支持](operations/platform-support.zh-CN.md) |
| 连接 ChatGPT | [连接 ChatGPT](tutorials/02-connect-chatgpt.zh-CN.md) | [MCP 配置](forge-chatgpt-mcp-setup.md) |
| 完成第一个任务 | [第一个仓库任务](tutorials/03-first-repository-task.zh-CN.md) | [公开使用指南](public-usage-guide.zh-CN.md) |
| 安装官方 Provider | [插件管理](forge-plugin-management.md) | [Provider 配置](operations/provider-configuration.md) |
| 理解 Forge | [核心概念](wiki/Core-Concepts.md) | [架构](wiki/Architecture.md) |
| 运维与恢复 | [Operations](wiki/Operations.md) | [故障排查](operations/troubleshooting.zh-CN.md) |
| 贡献与发布 | [贡献指南](../CONTRIBUTING.md) | [发布流程](operations/releasing.zh-CN.md) |

## 当前产品面

普通 ChatGPT Connector 默认暴露 **19 个 MCP 工具**。`rh_status`、`rh_access`、`rh_inbox`、`rh_context`、`rh_work` 五个 facade 覆盖主要控制循环，其余默认工具负责仓库、源码/补丁、check、Process、插件分发与结果读取。

Forge 默认 Direct-first：仅调查不会创建 durable Work；只有真正需要隔离时才建立 worktree。长命令由同一个 Process 生命周期管理，并返回有界摘要与可继续读取的引用。

## 文档地图

### 学习与使用
- [教程目录](tutorials/README.zh-CN.md)
- [公开使用指南](public-usage-guide.zh-CN.md)
- [功能与配置层级](operations/features.zh-CN.md)
- [平台支持](operations/platform-support.zh-CN.md)

### 理解架构
- [核心概念](wiki/Core-Concepts.md)
- [架构](wiki/Architecture.md)
- [Runtime 架构](wiki/Runtime-Architecture.md)
- [工作生命周期](wiki/Work-Lifecycle.md)
- [实现地图](wiki/Implementation.md)

### 集成能力
- [插件管理](forge-plugin-management.md)
- [Provider 配置](operations/provider-configuration.md)
- [桌面 Provider](operations/controller-desktop-plugin.md)
- [本地系统助手](operations/local-system-assistant.zh-CN.md)
- [iOS 开发助手](forge-ios-development-assistant.md)

### 运维与维护
- [故障排查](operations/troubleshooting.zh-CN.md)
- [发布流程](operations/releasing.zh-CN.md)
- [GitHub 仓库基线](operations/github-repository.md)
- [版本策略](versioning.md)
- [安全策略](../SECURITY.md)

## 当前事实与历史

Controller 是全局多仓库服务，但执行始终由稳定 `repoId` 和必要时的 `checkoutId` 明确限定。Controller Home 保存服务配置、认证、Provider、持久状态与发布元数据；公网 MCP 与仅本机可见的 Controller UI 相互分离。

当前架构以 [`architecture/current/`](architecture/current/) 为准；[`architecture/history.md`](architecture/history.md) 与 [`researches/`](researches/) 用于追溯历史和证据，不是当前运行契约。
