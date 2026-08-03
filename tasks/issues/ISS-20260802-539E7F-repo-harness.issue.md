---
id: "ISS-20260802-539E7F"
kind: "governance"
status: "planned"
updated_at: "2026-08-02T06:53:30.543Z"
source: "repo-harness-controller-v8"
---

# 让 Repo Harness 升级和重启时保持可用

唯一的主运行时可用性需求。核心运行时通过固定 Bootstrap、自包含发布、单一 authority/config、Supervisor 单 owner、last-known-good 切流和独立 Recovery 消除断联；同时明确外部插件不属于主运行时 release 或进程组，Controller rollout 必须保持健康插件服务与领域 session 存活。通用插件协议与迁移由 ISS-20260802-3EC105 负责。

## Goals

- 减少主运行时长期进程管理器、状态权威、配置来源和兼容分支。
- 让 launchd 启动与普通 runtime release 和 mutable worktree 无关的固定 Bootstrap。
- 让每个主运行时和 Recovery release 自包含、不可变、可验证。
- 只允许 Supervisor 修改主运行时 authority；Daemon/Gateway 只报告健康。
- 以临时候选与上一 release 实例替代长期 blue/green slot 权威。
- 在 candidate 完整就绪和切换后验证前，stable ingress 始终保持 last-known-good。
- Recovery 使用独立监督、独立状态和独立 tunnel，不成为第二个 primary writer。
- 把 Plugin Broker 视为核心边界，但把 iOS、Browser 等领域服务排除在主 runtime 进程组和 release 生命周期之外。
- 保证 Controller/Supervisor/Gateway rollout 不停止、重签名、重建或清空健康外部插件及其 session。
- 完成单向迁移并删除旧 dual-read、dual-write、slot config、argv override 和嵌入式领域生命周期路径。

## Non-goals

- 不长期保留内部 runtime state 兼容。
- 不创建独立 Recovery Git 仓库。
- 不实现多主机共识或通用分布式平台。
- 不允许 Recovery 写 primary authority 或执行任意 shell。
- 不在本 Issue 中实现完整 Plugin Protocol、SDK、registry 或领域插件迁移，这些由 ISS-20260802-3EC105 负责。
- 不要求 Supervisor 直接作为 iOS WDA、浏览器 profile 或其他领域服务的进程 owner。
- 不推送远程变更。
- 不保留当前长期 blue/green 数据模型。

## Acceptance Criteria

- [ ] launchd 主运行时服务引用固定 bootstrap/stable pointer，而非 mutable worktree 或 active slot。
- [ ] 主运行时和 Recovery 可在源码仓库不可用时冷启动。
- [ ] 迁移后仅有一个 primary authority 文件和一个 primary runtime config；root/blue/green 重复配置与 argv business overrides 被删除。
- [ ] Supervisor 直接拥有 primary Daemon/Gateway 生命周期，不存在嵌套 Gateway KeepAlive 第二 owner。
- [ ] 核心运行时拓扑与可选插件服务拓扑明确分离；插件服务使用独立 release、state 和 supervision。
- [ ] Candidate 失败不影响 last-known-good；post-cutover 失败原子回滚到已验证 previous release。
- [ ] Controller rollout/restart 后可重新连接原有外部插件，且不丢失健康插件的领域 session/Runner。
- [ ] 插件故障不得触发 primary runtime rollout；primary runtime 故障不得无条件重启插件。
- [ ] Primary Gateway 与 Recovery reachability 相互隔离。
- [ ] 迁移单向、事务化、有备份；无法迁移时返回 MIGRATION_REQUIRED，不静默猜测。
- [ ] 故障注入覆盖 rollout、launchd restart、stale process、port conflict、cold boot、tunnel failure、interrupted install 和 core/plugin 独立重启。
- [ ] 切换后旧生命周期、兼容 reader/writer、stale services、嵌入式插件 owner 和冗余 Issues 被删除或明确 supersede。

## GitHub

- Not published.

## Tasks

### T1 — 冻结核心运行时架构、插件边界和删除地图

- Status: `blocked`
- Objective: 定义主运行时进程拓扑、唯一 authority/config、Recovery 边界、可用性不变量、单向迁移与删除地图；核心运行时服务和可选外部插件服务必须分层描述，并引用 ISS-20260802-3EC105 的插件协议决策。
- Depends on: none
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `docs/runbooks/**`, `tasks/issues/**`
- Checks: `package:check:public-docs`
- Execution hint: agent / codex

### T2 — 构建固定 Bootstrap 与自包含核心 release

- Status: `planned`
- Objective: 让 launchd 永远启动固定 bootstrap/stable activation path；将 Supervisor、Daemon、Gateway 和核心执行闭包打包为不可变 release，同时明确不把外部插件二进制、Runner 或领域状态打入核心 release。
- Depends on: `T1`
- Allowed paths: `src/runtime/bootstrap/**`, `src/runtime/supervisor/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/runtime/execution/**`, `scripts/**`, `tests/runtime/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:ci`
- Execution hint: agent / codex

### T3 — 收敛为一个主运行时 authority 和 config

- Status: `planned`
- Objective: 建立 Supervisor-only runtime authority 与单一 runtime config；Daemon/Gateway 只报告健康；完成 root/blue/green 和 legacy MCP config 的原子单向迁移，不可迁移时返回 MIGRATION_REQUIRED。插件 registry/config 由插件平台维护独立权威，不得混入 slot authority。
- Depends on: `T1`, `T2`
- Allowed paths: `src/cli/controller/stable-state/**`, `src/cli/controller/runtime-slots.ts`, `src/cli/mcp/**`, `src/runtime/supervisor/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/runtime/shared/**`, `scripts/**`, `tests/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:ci`
- Execution hint: agent / codex

### T4 — 折叠核心进程层级并隔离插件进程

- Status: `planned`
- Objective: 移除 Gateway KeepAlive 第二进程管理器，由 Supervisor 直接管理 Daemon/Gateway；用 active/candidate/previous release instance 替代长期 slot。Supervisor 不收养或重启 iOS、Browser 等领域插件进程，只通过 Plugin Broker 观察连接状态。
- Depends on: `T2`, `T3`
- Allowed paths: `src/runtime/supervisor/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/cli/mcp/keepalive.ts`, `src/cli/mcp/restart.ts`, `src/cli/controller/**`, `src/runtime/plugins/**`, `scripts/**`, `tests/runtime/**`, `tests/cli/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:ci`
- Execution hint: agent / codex

### T5 — 实现事务化 rollout 与 last-known-good ingress

- Status: `planned`
- Objective: 实现 prepare candidate、isolated readiness、authority CAS、atomic ingress switch、post-verify、rollback window 和 retire previous 的单一持久状态机；rollout 只切换核心流量，并在完成时验证对外 MCP 与 Plugin Broker 重连能力。
- Depends on: `T3`, `T4`
- Allowed paths: `src/runtime/bootstrap/**`, `src/runtime/supervisor/**`, `src/runtime/gateway/**`, `src/runtime/health/**`, `src/runtime/recovery/**`, `src/runtime/plugins/**`, `scripts/**`, `tests/runtime/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex

### T6 — 交付独立不可变 Recovery 与专用 tunnel

- Status: `planned`
- Objective: 按简化架构完成 ISS-20260802-27931A：Recovery 保持 monorepo 源码，但安装为独立 versioned binary，拥有独立 launchd、状态、endpoint 和 cloudflared，不依赖或写 primary authority，也不负责领域插件恢复。
- Depends on: `T1`, `T2`, `T3`
- Allowed paths: `src/runtime/standalone-recovery/**`, `scripts/install-standalone-recovery.ts`, `scripts/load-standalone-recovery.sh`, `tests/runtime/standalone-recovery.test.ts`, `tests/runtime/**`, `docs/operations/**`, `recovery/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:ci`
- Execution hint: agent / codex

### T7 — 删除旧兼容、slot 和嵌入式领域生命周期

- Status: `planned`
- Objective: 新架构可切换后删除 blue/green readers、repo-local MCP fallback、legacy toolset migration、nested keepalive、旧 restart coordinator、重复 projection，以及已经由外部插件接管的 daemon/session owner；迁移窗口只保留明确 proxy。
- Depends on: `T3`, `T4`, `T5`, `T6`
- Allowed paths: `src/**`, `scripts/**`, `tests/**`, `docs/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex

### T8 — 建立核心、Recovery 与插件隔离故障注入门禁

- Status: `planned`
- Objective: 杀死或破坏每个 rollout phase、launchd、stale callback、duplicate process、install、tunnel 和 cold boot，并加入 core/plugin 独立重启、插件崩溃、Broker 断线和 session 保留测试。
- Depends on: `T5`, `T6`, `T7`
- Allowed paths: `tests/**`, `scripts/smoke-runtime-control-plane.ts`, `scripts/smoke-runtime-recovery.ts`, `scripts/check-release-readiness.sh`, `scripts/verify-controller-v8.sh`, `docs/operations/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex

### T9 — 执行分阶段切换和治理清理

- Status: `planned`
- Objective: 用正式 migrator 切换 live Controller Home，激活新 bootstrap/runtime/Recovery，验证与外部插件的重连和 session 保持，运行冷启动及故障演练，保留有界 rollback backup 后删除 retired 服务与状态并收敛相关 Issues。
- Depends on: `T8`
- Allowed paths: `scripts/**`, `docs/operations/**`, `tasks/issues/**`, `tasks/notes/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: agent / codex

## Related Artifacts

- `ISS-20260802-3EC105`
- `ISS-20260802-27931A`
- `ISS-20260802-7E1D69`
- `ISS-20260731-CCF3E3`
- `retired blue-green and source-identity Issues`
