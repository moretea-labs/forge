# Forge Computer 与官方插件中文使用指南

Forge 是本地优先的 **ChatGPT MCP 执行工具**：由 ChatGPT 理解任务和决定下一步，Forge 管理权限、执行与证据。Forge 的主程序和独立 Provider **不是同一个升级渠道**。

## 第一步：安装 Forge，连接 ChatGPT

基础要求：Node.js 20.10+、npm（或 Bun），macOS / Linux 或 Windows WSL2。打开终端：

~~~bash
npm install -g @moretea-labs/forge@latest
forge --version
forge setup
forge setup configure --controller chatgpt --tunnel auto
forge setup next
~~~

按程序提示完成 Package Runtime 和 ChatGPT MCP 连接。详见[连接 ChatGPT 中文教程](https://github.com/moretea-labs/forge/blob/main/docs/tutorials/02-connect-chatgpt.zh-CN.md)。

## 第二步：macOS 安装 Computer

~~~bash
forge computer setup
forge computer doctor
forge computer status --json
~~~

已经安装 Computer 的用户可以更新到当前 Forge 官方目录固定的版本：

~~~bash
forge computer update
forge computer doctor
~~~

Computer 原生实现是 [Forge Desktop Operator](https://github.com/moretea-labs/forge-desktop-operator)，Forge v1.8.1 官方目录固定版本为 **v0.4.5**。使用桌面观察、截图、点击、输入时，macOS 可能需要手动授予**辅助功能**和**屏幕录制**权限。

**Linux/Windows 没有这款 macOS 原生 Computer Provider**；不要把内置的文件/浏览器能力误认作跨平台原生桌面控制。Browser 使用独立的浏览器会话和权限边界。

## 第三步：按需要安装插件

先检查当前官方目录与已安装插件：

~~~bash
forge plugin catalog
forge plugin list --refresh
~~~

| 插件 | v1.8.1 固定版本 | 用途 | 平台 |
| --- | --- | --- | --- |
| Computer / Desktop Operator | v0.4.5 | 原生桌面观察与交互 | macOS |
| Forge Design | v0.3.0 | 仓库设计工作区与设计产物 | macOS / Linux / Windows |
| Personal Knowledge Assistant | v0.2.1 | 本地知识检索、安全写入 | macOS / Linux / Windows |
| Forge Figma Bridge | v0.3.0 | Figma 画布与组件操作 | macOS |

按需执行安装，**不必全部安装**：

~~~bash
forge plugin install design
forge plugin install personal_knowledge
forge plugin install figma
forge plugin list --refresh
~~~

Figma Bridge 还需要相应 Figma 插件与本地服务运行。插件安装成功不代表健康状态就绪；如果显示 degraded，应根据诊断信息检查应用、授权、Socket、浏览器连接或依赖。

## 第四步：在 ChatGPT 中实际使用

连接 Forge MCP 并授权目标资源后，直接用自然语言描述任务：

- “检查当前 Chrome 页面中的表单字段，先报告问题，不要提交。”
- “观察 Mac 当前桌面应用，截图并告诉我界面有什么异常。”
- “整理这个已授权文件夹里的文档，并列出更改前后情况。”
- “在已连接的本地知识库里搜索上次的架构决策。”
- “查看当前 Figma 文件的组件结构。”（需要 Figma Bridge 健康就绪）

Forge 不会因为连接成功就允许不受限的远程写入、破坏性操作、密钥获取或越权访问。

## 第五步：升级和排查

~~~bash
npm install -g @moretea-labs/forge@latest
forge setup next
forge computer update       # 仅 macOS
forge computer doctor       # 仅 macOS
forge plugin list --refresh
forge doctor
~~~

[English Computer Guide](Computer-and-Plugins) · [插件管理](https://github.com/moretea-labs/forge/blob/main/docs/forge-plugin-management.md) · [平台支持说明](https://github.com/moretea-labs/forge/blob/main/docs/operations/platform-support.zh-CN.md)
