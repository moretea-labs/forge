<a id="english"></a>

<p align="center"><img src="docs/images/forge-banner.svg" alt="Forge — local-first action runtime" width="1280"></p>
<p align="center"><strong>Local-first action runtime for ChatGPT and AI coding assistants.</strong></p>
<p align="center"><a href="#english">English</a> · <a href="#zh-cn">简体中文</a> · <a href="docs/README.md">Docs</a> · <a href="docs/forge-plugin-management.md">Plugins</a> · <a href="https://github.com/moretea-labs/forge/releases">Releases</a></p>
<p align="center"><img alt="CI" src="https://github.com/moretea-labs/forge/actions/workflows/ci.yml/badge.svg"> <img alt="Release" src="https://img.shields.io/github/v/release/moretea-labs/forge?include_prereleases&sort=semver"> <img alt="npm next" src="https://img.shields.io/npm/v/%40moretea-labs%2Fforge?tag=next&label=npm%20next"> <img alt="License" src="https://img.shields.io/github/license/moretea-labs/forge"></p>

Forge gives ChatGPT a bounded, auditable way to work with **real local repositories, processes, plugins, and recovery state**. It keeps durable execution facts outside the chat, uses the lightest valid path for small work, and preserves explicit safety boundaries for remote, destructive, secret, and outside-workspace effects.

## Why Forge

| Need | Forge behavior |
| --- | --- |
| Work on real code | Stable `repoId + checkoutId` identity binds every repository operation to the intended checkout. |
| Keep small tasks fast | Direct-first execution avoids Plan/Issue/Agent/worktree overhead when the change is already understood. |
| Run long work once | Process Runtime owns build/test/process lifecycle; status, wait, logs, and cancel attach to the same process. |
| Work concurrently | Independent repositories run in parallel; worktrees are introduced only when isolation is actually needed. |
| Trust the result | Focused checks, diffs, receipts, evidence, immutable runtime releases, and Recovery make outcomes reviewable. |
| Extend safely | Typed external providers install through Forge's pinned catalog and reuse the same authorization/evidence path. |

## Quick start

Requirements: Git, Node.js 20.10+, npm, and a writable home directory. Bun 1.0+ is recommended for source development and the full test suite.

```bash
npm install -g @moretea-labs/forge@next
forge --version
forge setup open --target both
forge setup next     # repeat until ready
forge setup close
forge doctor
```

Connect ChatGPT with [Tutorial 2](docs/tutorials/02-connect-chatgpt.md), then adopt a repository:

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

For source development, follow [Install and start](docs/tutorials/01-install-and-start.md) or install the reviewed checkout directly:

```bash
git clone https://github.com/moretea-labs/forge.git && cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund
```

## How ChatGPT uses Forge

The normal ChatGPT connector exposes a bounded **19-tool MCP surface**. Five preferred facades—`rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`—cover most orchestration; repository, source/patch, check, Process, plugin-dispatch, and result tools complete the default surface.

```text
Small task  → inspect → relevant context → Direct Edit → focused check → commit
Long task   → resolve identity → durable work only if needed → Process/worktree → verify → integrate → clean
```

<p align="center"><img src="docs/images/forge-controller-flow.svg" alt="Forge canonical runtime flow" width="980"></p>

Ask for the outcome, not the tool: “fix this failing test and commit”, “compare these repositories in parallel”, or “run the build and keep using the same Process”.

## Official providers

| Provider | Purpose | Install |
| --- | --- | --- |
| [Forge Desktop Operator](https://github.com/moretea-labs/forge-desktop-operator) | Native macOS desktop automation | `forge plugin install desktop_operator` |
| [Forge Design](https://github.com/moretea-labs/forge-design) | Repository-native design workspace and `design.md` provider | `forge plugin install design` |
| [Personal Knowledge Assistant](https://github.com/moretea-labs/personal-knowledge-assistant) | Local-first personal knowledge retrieval, memory, and safe writes | `forge plugin install personal_knowledge` |

See [Plugin Management](docs/forge-plugin-management.md) for trust, distribution, update, and transport boundaries. Investment Decision System remains an independent product rather than a Forge plugin.

## Safety model

Forge distinguishes observation, normal local changes, remote effects, destructive actions, outside-workspace access, and secrets. Full Access reduces repetitive approval for ordinary local work; it does **not** weaken destructive, remote, or secret boundaries. See [Security Model](docs/wiki/Security-Model.md) and [SECURITY.md](SECURITY.md).

## Documentation

- **Start:** [Documentation hub](docs/README.md) · [Wiki](docs/wiki/Home.md) · [Quick Start](docs/wiki/Quick-Start.md) · [Public usage guide](docs/public-usage-guide.md)
- **Understand:** [Core Concepts](docs/wiki/Core-Concepts.md) · [Architecture](docs/wiki/Architecture.md) · [Work Lifecycle](docs/wiki/Work-Lifecycle.md)
- **Operate:** [Operations](docs/wiki/Operations.md) · [Troubleshooting](docs/operations/troubleshooting.md) · [Platform support](docs/operations/platform-support.md)
- **Maintain:** [Contributing](CONTRIBUTING.md) · [Release process](docs/operations/releasing.md) · [Changelog](CHANGELOG.md) · [Support](SUPPORT.md)

**Current release candidate:** `1.5.0-rc.1` on the npm `next` channel. Stable releases use `latest`. Forge is MIT licensed; see [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---
<a id="zh-cn"></a>

<p align="center"><img src="docs/images/forge-banner-cn.svg" alt="Forge——本地优先的行动运行时" width="1280"></p>
<p align="center"><strong>面向 ChatGPT 与 AI 编程助手的本地优先行动运行时。</strong></p>
<p align="center"><a href="#english">English</a> · <a href="#zh-cn">简体中文</a> · <a href="docs/README.zh-CN.md">中文文档</a> · <a href="docs/forge-plugin-management.md">插件</a> · <a href="https://github.com/moretea-labs/forge/releases">版本</a></p>

Forge 让 ChatGPT 在**真实本地仓库、进程、插件与恢复状态**上执行有边界、可审查的工作。小任务默认走最短路径；长任务复用同一个 Process；远程、破坏性、密钥和工作区外访问继续保持明确安全边界。

## 核心能力

- **Direct-first**：范围明确的小修改不因调查自动创建 Plan、Issue、Agent 或 worktree。
- **真实并发**：不同仓库可并行；需要隔离时再建立 worktree；同一 checkout 保持单写者。
- **可恢复执行**：build/test 只启动一次，后续 status/wait/log/cancel 连接同一个 Process。
- **明确身份**：`repoId + checkoutId` 防止一个会话误操作另一个 checkout。
- **可验证结果**：diff、focused check、receipt、evidence、不可变 Runtime release 与 Recovery 都可追溯。
- **类型化插件**：官方 Provider 从固定版本目录安装，并复用 Forge 的授权、资源声明与证据链。

## 快速开始

```bash
npm install -g @moretea-labs/forge@next
forge setup open --target both
forge setup next     # 重复直到 ready
forge setup close
forge doctor
```

接入仓库：

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

普通 ChatGPT Connector 默认收敛为 **19 个 MCP 工具**，其中 `rh_status`、`rh_access`、`rh_inbox`、`rh_context`、`rh_work` 五个 facade 覆盖主要编排。正常使用时直接描述目标，不需要自己挑工具。

## 官方 Provider

`forge plugin catalog` 可查看当前目录；官方 Provider 包括 [Forge Desktop Operator](https://github.com/moretea-labs/forge-desktop-operator)、[Forge Design](https://github.com/moretea-labs/forge-design) 与 [Personal Knowledge Assistant](https://github.com/moretea-labs/personal-knowledge-assistant)。详见[插件管理](docs/forge-plugin-management.md)。

## 文档与维护

[中文文档中心](docs/README.zh-CN.md) · [安装教程](docs/tutorials/01-install-and-start.zh-CN.md) · [公开使用指南](docs/public-usage-guide.zh-CN.md) · [架构](docs/wiki/Architecture.md) · [故障排查](docs/operations/troubleshooting.zh-CN.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

**当前候选版本：** `1.5.0-rc.1`，npm 使用 `next`；稳定版使用 `latest`。项目采用 [MIT License](LICENSE)。
