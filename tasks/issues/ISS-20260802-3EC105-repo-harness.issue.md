---
id: "ISS-20260802-3EC105"
kind: "feature"
status: "planned"
updated_at: "2026-08-02T06:53:19.457Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 通过独立插件安全接入本机能力

把 Repo Harness 收敛为 ChatGPT 与本机能力之间的控制平面、策略中心、资源权威、Durable Execution 和审计桥梁；通过版本化的进程外插件协议接入 iOS、浏览器、Google 等领域能力。插件可以与主仓库共同开发，但必须具备独立进程、状态、发布和恢复边界，核心升级不得重启或重建健康插件资源。

## Goals

- 保留 list_plugins、get_plugin、plugin_action_execute 等稳定且有界的 ChatGPT/MCP 表面。
- 将现有静态编译的 AssistantPluginAdapter Map 演进为支持外部注册、握手、健康检查、执行、取消、进度和 Artifact 的 Plugin Broker。
- 分离静态 Manifest 与动态 Health，建立协议版本、插件版本和能力兼容性检查。
- 由 Repo Harness 核心统一负责权限、确认、请求去重、Durable Work、资源锁、审计与证据；领域插件只负责能力实现和领域恢复。
- 让插件拥有独立进程、独立状态目录、独立 release、独立重启策略和局部降级边界。
- 支持 controller-scoped 主机能力与 repository-scoped 项目能力，并使用可扩展资源 URI 实现跨插件互斥。
- 优先以物理 iOS 能力验证架构：ios-device 作为 controller-scoped 外部服务，ios-development 作为 repository-scoped 项目插件。
- 提供 Plugin Protocol、SDK、Contract Tests 和 reference plugin，使新增能力无需修改核心静态 Adapter Map。

## Non-goals

- 不让 ChatGPT 直接连接多个不受控 MCP Server 绕过 Repo Harness 权限与审计。
- 不在第一阶段实现远程插件市场、任意第三方代码自动安装或跨主机插件调度。
- 不要求立即拆分所有轻量内置插件；允许经过协议包装后分阶段迁移。
- 不把 Xcode 签名、WDA、浏览器 profile、邮箱分页等领域状态迁入 Repo Harness 核心。
- 不以仅拆 Git 仓库或 npm package 作为完成标准；没有独立运行时边界不算解耦。
- 不降低敏感操作确认、设备互斥、外部写入和 destructive action 的现有安全要求。

## Acceptance Criteria

- [ ] 至少一个外部插件可在不修改核心静态注册表、不重新编译 Controller 的情况下注册、握手、健康检查并执行 typed action。
- [ ] Controller/Gateway rollout 或重启不会终止健康外部插件进程，也不会清除其领域 session、Runner 或连接状态。
- [ ] 插件崩溃、升级或协议不兼容只使该插件 degraded/error，Repo Harness 核心和其他插件继续可用。
- [ ] 静态 Manifest 与动态 Health 分离；普通 action 响应返回紧凑 receipt，不重复完整 action schema。
- [ ] 协议支持 handshake、manifest、health、execute、operation status/events/cancel、artifact reference 和 graceful shutdown，并具有版本协商与超时边界。
- [ ] 核心统一执行权限、确认、幂等、资源 claim、审计和证据；外部插件不能自行绕过这些策略。
- [ ] 资源模型支持 device:ios:<udid>、browser:profile:<id>、account:<provider>:<id> 等扩展 URI，并能在不同插件/引擎间互斥同一资源。
- [ ] 物理 iOS 的设备、WDA、签名和 interaction session 生命周期迁出 Controller release；ios-development 与 ios-device 不再由一个 monolithic adapter 混合所有职责。
- [ ] Contract Tests 覆盖协议兼容、插件重启、核心重启、取消、超时、重复请求、局部故障和版本不兼容。
- [ ] 旧静态 Adapter Map、内嵌插件生命周期和重复 manifest 探测路径在迁移完成后删除或仅保留明确的内置兼容适配层。

## GitHub

- Not published.

## Tasks

### T1 — 冻结进程外插件架构与迁移地图

- Status: `blocked`
- Objective: 定义 Repo Harness Core、Plugin Broker、外部插件服务、repository-scoped 插件、controller-scoped 插件、状态目录、release、权限、资源权威和故障域；审计现有每个 adapter，标记 keep/wrap/extract/delete，并明确与主运行时和 Requirement/Work 架构的边界。
- Depends on: none
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `docs/researches/**`, `tasks/issues/**`
- Checks: `package:check:public-docs`
- Execution hint: agent / codex

### T2 — 抽取版本化 Plugin Protocol、SDK 与 Contract Tests

- Status: `planned`
- Objective: 从 AssistantPluginManifest、ActionDescriptor、ActionExecutionInput 和现有 action receipts 中抽取语言无关协议 schema、TypeScript SDK、标准错误、operation、event、artifact 和 compatibility contract。
- Depends on: `T1`
- Allowed paths: `src/runtime/plugins/protocol/**`, `packages/plugin-protocol/**`, `packages/plugin-sdk/**`, `tests/plugin-contract/**`, `tests/runtime/**`, `docs/architecture/**`, `package.json`, `bun.lock`, `package-lock.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T3 — 实现 External Plugin Registry 与 Broker

- Status: `planned`
- Objective: 把硬编码 PLUGIN_ADAPTERS Map 替换为内置适配器加外部注册表的统一解析层；支持 Unix Domain Socket 或等价本机 IPC 的发现、握手、连接复用、健康缓存、超时、取消和有界重连。
- Depends on: `T2`
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/gateway/**`, `src/runtime/control-plane/**`, `src/cli/**`, `tests/runtime/**`, `tests/cli/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T4 — 扩展通用权限与资源 URI 模型

- Status: `planned`
- Objective: 将固定 repo-state/workspace/remote/git-refs claims 扩展为受控资源 URI 与 capability namespace，同时保持核心统一授权、确认、写入互斥和审计。
- Depends on: `T1`, `T2`
- Allowed paths: `src/runtime/plugins/**`, `src/runtime/execution/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T5 — 交付独立 reference plugin 与生命周期管理

- Status: `planned`
- Objective: 实现一个最小进程外 reference plugin 和安装/注册/启动/停止/升级/回滚流程，证明核心与插件的独立 release、状态和恢复边界。
- Depends on: `T2`, `T3`, `T4`
- Allowed paths: `plugins/reference/**`, `src/runtime/plugins/**`, `src/cli/**`, `scripts/**`, `tests/**`, `docs/operations/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex

### T6 — 建立 iOS 外部插件迁移接缝

- Status: `planned`
- Objective: 在不一次性重写 iOS 实现的前提下，建立 ios-device 外部服务代理和 ios-development 仓库插件边界；让旧 public action IDs 经兼容代理调用外部服务，并禁止 Controller 继续拥有 WDA、签名或 interaction daemon 生命周期。具体用户流程验收继续由物理 iPhone Requirement 承担。
- Depends on: `T3`, `T4`, `T5`
- Allowed paths: `src/runtime/plugins/**`, `plugins/ios/**`, `packages/**`, `tests/runtime/**`, `tests/plugin-contract/**`, `docs/architecture/**`, `docs/operations/**`, `scripts/**`, `package.json`, `bun.lock`, `package-lock.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T7 — 迁移适合外部化的插件并删除静态耦合

- Status: `planned`
- Objective: 根据 T1 迁移地图逐步外部化 Browser、Google 或其他重型能力；保留合理轻量内置插件，但统一通过同一 contract；最终删除不再需要的静态 imports、重复 manifest refresh 和领域生命周期代码。
- Depends on: `T5`, `T6`
- Allowed paths: `src/runtime/plugins/**`, `plugins/**`, `packages/**`, `tests/**`, `docs/**`, `scripts/**`, `package.json`, `bun.lock`, `package-lock.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex

## Related Artifacts

- `ISS-20260802-539E7F`
- `ISS-20260720-66E25D`
- `ISS-20260802-7E1D69`
- `src/runtime/plugins/types.ts`
- `src/runtime/plugins/store.ts`
- `src/runtime/plugins/ios-adapter.ts`
