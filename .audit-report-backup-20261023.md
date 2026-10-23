# Forge 架构审计报告 — 第一轮（2026-10-21）

---

# 未合并分支归因与二次清理（2026-10-22 续）

用户追问「到底是为什么没合并、很多是不是你做的、不合并不是白做了」——逐分支给出**决定性归因**（GitHub PR 记录 + squash 重命名场景下 subject/行包含/符号三层内容测试）。

## 归因结论（为什么显示未合并）

1. **squash 断链（主体原因，非丢失）**：GitHub squash 合并使分支 commit 与 main 上的 squash commit 不同 hash、subject 也可能改写 → `git branch --no-merged` 误报。逐分支用 PR head-ref 记录证实：20 个本地分支实为已合并/已被取代（#331/#338/#339/#342/#362-#372 系、issue294 系、code-search 系——其中 code-search/issue294 用 subject 与 main **逐字一致**证实；12 个 grant/keychain/gateway 系用 PR=MERGED 证实）。全部删除（本地），远端由 GitHub merge 时自动删。
2. **外部贡献者 PR 无人评审（真正的"漏合"）**：#155/#156（author `liubingbing0920-wq`，2026-08）——connector 子进程持有 LISTEN socket 被误判"不拥有端口"的真实修复。已 rebase 到当前 main（解决与 #336-#372 测试大改的冲突 + Linux 测试的 lsof 命令形状断言适配），保留原作者署名，经 **#376 squash 合入：main = `a0f2b760e`**；#155/#156 以 "landed via #376" 关闭。合前验证：tsc/六门禁全绿，standalone-recovery 失败集与基线**逐名 delta=0**（39 预存不变）。
3. **#344 OPEN 已死**：Batch1 的 orchestrator/Agent-Job aliases 两项已由 #325/#327 落地；唯一残项（删 legacy-context.ts）前提失效——main 的 `server.ts:231` 正在使用 `createLegacyMcpToolContext`（非 controller profile 活路径）。带证据关闭，删本地分支。
4. **#263 设计性取代**：其 host-conversation-session 绑定方案与后来接受的架构相反（main 明确 hostConversationSessionId "Never authorization"；真实机制由 #336-#342/#353-#357/#359/#371 浪潮落地），核心符号按设计不存在于 main。带证据关闭。
5. **#252 超存续**：新增行 96% 已在 main，源补丁 #250 已合，base 是废弃的 kernel-v2/architecture。关闭。
6. **我自己的审计工作（round 1-5）无一件丢失**：全部随 #375 在 main（`26bc92123`），本轮 #376 又入恢复域修复。`origin/main` 现含两笔审计交付。

## 二次清理账目

- 删分支：20 个 squash 断链/已关 PR 本地分支（含 #344/#263/#252 head 中本地存在者）+ 同血缘三份去重（`workbuddy/main-5e039fb6`、`work/forge-module-guardrails-20261021` 与 `main-pre-triage-20261022` tip 完全相同 `1246a50e2`，仅保留 main-pre-triage 作安全网）。
- 移除 worktree：`forge-issue294-bounded-worker`、`forge-issue294-tab-rebind`（subject 已逐字在 main + worktree 干净）、我的三个临时比对/集成的 worktree（audit-baseline/chk-origin/chk-branch/fix155/triage）全部回收；`git worktree prune` 完成。
- 现状：**本地 36 分支、OPEN PR=0、worktree 13（主 + 12 managed）、main==origin/main=a0f2b760e 干净**。

## 保留清单（有唯一内容或按机制应保留，未擅删）

- `main-pre-triage-20261022`：旧 main 的 15 commit 血缘（1246a50e2），形态为 #329-#340 前置工作；**未逐 commit 语义对账前不删**（防白做）。
- `codex/archive-worktree-*` ×14、`archive/*` ×2：worktree 收敛机制的显式归档出口产物（含脏态 bundle），按设计保留。
- 5 个 managed-worktree 绑定分支（`e2eca85c8b96/#372 已合`、`4f0697639169`、`9d20c69655fd`、`90f9392b38c9`、`4737a27f9931`）：归 Work 终态 + maintenance 孤儿扫描（7 天宽限）收敛，不在 shell 层强删。
- 6 个无 PR 记录、内容归因未做的历史实验分支（`work/forge-offline-presend-minimal-20261016` 11c、`work/p0-work-semantic-closure-...5b3bb38ccbd5` 6c、`work/forge-release-retention-193`、`work/gmail-unknown-notification-receipt-evidence-20261018`、`work/supervisor-bootstrap-live-contract-20261016`、`perf/computer-hydration-observer-20261014`）：subject 与 main 不逐字对应（rework 型吸收不可证），**逐个语义对账是后续审计候选**，暂全保留。

---

# 合并与工作区清理（2026-10-22）

用户指令「先去合并清理工作区」——显式授权合并（偏离 #275「不自动合 main」默认约定，按指令执行）。**PR #375 已 squash 合入 main：`origin/main = 26bc92123`**，round 1-5 全部整改 + 并发写者 host-grant 批次（cf38f657a/c484f3657/d62eaaedb）进入主线。

## 合并执行记录

- 预演 `git merge-tree` 发现与上游 #342-#372 的 4 处真实冲突；在**隔离 worktree**（不触碰共享 checkout 与并发写者指针）建 `work/audit-integration-20261022` 执行合并，逐文件语义解决（无 ours/theirs）：
  - `multi-repository.ts`：取上游 #361/#372 显式收窄的 `REPOSITORY_LOCKED_TOOLS`（edit 变异改走 `withLegacyEditMutation` 内锁）+ 保留我侧对已退役 `configure_github_plugin` 的移除。
  - `legacy-tool-service.ts`：保留我侧对孤儿 `local-bridge-surface` import 的删除（遮蔽分支已清）+ effects/controller-home 路径。
  - `local-bridge/server.ts`：上游 leases/store + edit-session-worker import 与我侧 effects 路径重写并存。
  - `leases/store.ts`：上游扩展 locks import（readControllerLock/withControllerLockAsync）与我侧 effects 路径并存。
- 合并验证：tsc（两树）+ 全治理门绿；`check:main` 首跑遇 `workflow-supervisor-conversation-switch` flake 失败——三方对照复跑证明**上游 origin/main 自身 flake 率 26/40，合并树 18/40**，失败断言与测试文件与上游逐字一致（merged test 文件 == origin/main 版），复跑 `check:main` 通过（receipt 71d1d602）；CI Main gate + windows-smoke 双绿。
- **新基线发现 #R5**：该 supervisor 轮换测试是上游预存 flaky（~45-65% 失败率），与 round 1-5 无关，列为基线调查项。
- 仓库禁 merge commit → 按仓库 squash 约定合入；各轮 commit hash（15f153106…d74468112）保留在 PR #375 引用历史中。

## 工作区清理结果

- ✅ 已删：本地+远端 `work/audit-remediation-round1-20261021`、远端 `work/audit-integration-20261022`（GitHub merge 后自动删）、14 个已合并旧分支（gmail/chrome-pid/pre-send/provider-recovery/294-connector 等）、`/private/tmp/forge-module-guardrails-20261021` worktree、`.worktrees/work-codex-294-connector-post-20261018` worktree + 分支、`.worktrees/fix-runtime-rollout-convergence` 与 `runtime-b80f210c` 空残留（回收站可恢复）、比对用临时 worktree ×3。
- ✅ 主 checkout 已切至 `main @ 26bc92123`，工作树干净（仅审计报告 untracked）。
- ⚠️ **main 分叉处置**：本地旧 main 有 13 个非补丁等价 commit（形态与 #336-#340 时代 squash 前工作一致，subject 未见于上游）。按约定未销毁：保存在 `main-pre-triage-20261022`，本地 main 已快进到 origin/main。待用户对账后删除该分支。
- ⚠️ **stash 事故与修复**：清理我 3 条 `audit-verify-*` 时因输出被摘要吞掉、误连续 drop 多删 2 条外域 stash（`preexisting-work-bound-continuation-edits-before-standalone-proof`、`forge-preserve-unowned-recovery-source-root-20260922`）——已用 `git stash store` 按 drop 打印的 SHA 原样恢复，各存一份，零丢失。教训：批量 stash drop 必须逐条确认归属，不能凭 head 截断视图推断全量。
- 📋 **遗留待用户决策（不擅动）**：
  1. **~120 条历史 stash**（多为 `forge-finish:work-*` 自动保留态，含 14 组同消息预存重复）——是否批量对账清理。
  2. **40 个未合并本地分支**（`codex/archive-worktree-*` ×14、`archive/*` ×2、`forge/code-search-*` 等旧实验分支、`fix/issue294-*` ×2 含 DevProjects worktree）——含唯一 commit，逐个对账后再删。
  3. **12 个 managed worktrees**（`~/.forge/controller/managed-worktrees/`）——归 Work 终态/maintenance 孤儿扫描（round 1 交付的 7 天宽限机制）收敛，不在 shell 层强删。
  4. `main-pre-triage-20261022` 的 13 commit 对账（疑似已被 squash PR 取代）。

---

# 第五轮审计与整改（2026-10-21 深夜续）

主题：#R1 首个切片——standalone-recovery/core.ts 纯移动拆分。修复 commit `d74468112`（3 文件 +1281/-1106，已推送）。

## 已验证（round 5）

1. **core.ts 零模块级可变状态**：全部顶层声明为函数/接口/类型/常量（无 let/var），纯移动拆分可行性成立。
2. **切割线裁决**：探测/观察段（原 1033-1528：runtimeStatus → observeRecentMacNetworkExtensionChanges，~500 行）前向依赖闭包最小（仅 json/audit/loadWatchdogState/normalizeRecoveryReadOnlyTool/configured×2/persistWatchdogDiagnosticEvidence/recoveryMachineIdentity + command runner）；反向被 core 尾部大量调用。**persistOpenAiTransportIncidentEvidence、probeMcp、probeRuntimeExecutionSurface 留在 core**——它们调用 cutover 编排（probeReleaseCutoverReadiness），移动会造成回边。
3. **门禁环规则裁决**：check-runtime-architecture 的 `production TypeScript import cycle` 检查把 type-only 回边也算环——第一版切割（新文件 `import type ... from './core'`）被门禁拒绝。正确修法是类型前导区（RecoveryConfig/VerifyResult/WatchdogState/ReleaseEvidence 等 ~360 行）一并下沉，得到干净分层 **core → probe-observation → recovery-shared**（shared 为叶子）。这是门禁自身规则 dictate 的落点，与 check-module-boundaries 决定模块落点的先例同构。
4. **39-fail 长期预存基线（重要发现）**：`tests/runtime/standalone-recovery.test.ts` 存在 39 个失败（launchd/systemd 激活、rollback、known-good attest、ReleaseSession preparation 主题）。归因证据链：(a) 我的拆分后失败名单与 `git stash` 纯净 HEAD **逐名一致**（39=39，仅计时不同）；(b) 临时 worktree bisect 显示 39 fail 在 2e3f2bfe9/44e3eb0d3/cac20fde9/7b5c67a4c/ba04852e9/15f153106 全部存在，且**审计起点 26c564929（#340）就已存在**——与整个审计批次（round 1-5）无关。此前各轮只跑过 MCP/policy 聚焦测试，从未跑过该套件，故未早发现。根因未查（推测与另一写者 #336-340 批次或更早有关），列为待修复基线调查项。

## 已执行（round 5，commit d74468112）

- **recovery-shared.ts**（626 行，叶子）：类型前导区（PublicTunnelRecoveryPolicy…RuntimeReleaseActivationResult + RecoveryConfig/WatchdogState/VerifyResult/机器身份函数组）+ 稳定只读工具常量 + json/writeJson/路径助手 + audit + watchdog 诊断持久化 + configured tunnel 访问器 + 有界 command runner（recoveryCommandPath/recoveryCommandEnvironment）。
- **probe-observation.ts**（527 行）：runtime/tunnel/MCP 探测与观察函数段。
- **core.ts 7292 → 6314 行**：保留全部编排权威（verifyStableRuntime、watchdogTick、release-session 生命周期、restart/recover、activate/cutover），作为 facade re-export 全部原公共符号——外部消费面（entry/installer/local-system-adapter/cli recovery/recovery-client-adapter/全部测试）零改动。

## 验证（round 5）

- 全门禁绿：type（主树+supervisor）/ runtime-architecture（103 modules，含环检测）/ module-boundaries / repository-hygiene / architecture-sync / bootstrap-files / mcp-compatibility。
- 聚焦测试：release-session 21 pass 0 fail；local-system-target-grant + controller-home 61 pass 0 fail；standalone-recovery 81 pass + 39 fail（=已验证预存基线，零新增失败）。
- 临时 worktree（wt-audit-baseline）已清理移除。

## 待修复（round 5 新增）

**#R4 standalone-recovery.test.ts 39-fail 基线调查**：失败集中在 launchd/systemd 服务激活、rollback、known-good attest、ReleaseSession preparation；在 26c564929 即存在。需独立归因（另一写者批次或环境性），修复不属于本轮拆分范围——拆分切片已证明未加剧。

## 下一轮候选

1. **core.ts 第二切片**：进程/服务管理段（原 2635-4100 剩余部分 ~1400 行：launchd/systemd owner、端口观察、stop/restart/recover 编排）与 cutover/session 段（原 4818-6600）——按本切片方法继续。
2. **#R4 39-fail 基线归因**（与另一写者对账）。
3. JD 电商逻辑移出 ios-agent-device.ts 进 plugin 层（~400 行离开 Forge 核心）。
4. WSL 源同步现状（#312 S0）验证。
5. legacy-tool-service 按域拆分评估（编辑会话域最先）。

---

# 第四轮审计与整改（2026-10-21 深夜）

主题：codex CLI 残余面裁决 + 死策略字段清理。修复 commit `2e6e2096a`（7 文件 +3/-10，已推送）。

## 已验证（round 4）——裁决修正：codex CLI 残余面不是死代码

Round 3 遗留观察曾把 codex CLI 残余面（installer/doctor/init/setup-profile/security/dev-runner）列为"下一批候选"。本轮逐面核查后**推翻可直接退役的假设**——它是活跃的、测试覆盖的、门禁冻结的产品面：

1. **hooks 模板被治理门固化**：`assets/hooks/codex.hooks.template.json` 被 `check:bootstrap-files`（治理门，tests/bootstrap-files.test.ts:240-257）与 `hook-contracts.test.ts:262-283` 逐条断言（SessionStart/pre-edit-guard/post-edit-guard 等）；AGENTS.md 的 Architecture Contract 块本身声明 `.ai/hooks` 为 functional block（capability `runtime-harness/hook-adapters`）。这是**仓库侧对 codex CLI 使用者的防护 harness**（session context、edit guards），与已退役的"MCP controller/executor 集成"是不同事实。
2. **init/security 有活跃测试**：init.test.ts:497,512-530 断言 `--target codex` 写 ~/.codex/AGENTS.md 的合并行为；security.test.ts:173-193 断言 codex hooks 扫描。installer/targets/codex.ts（174 行）经 registry.ts 挂入 `forge install --target`。
3. **doctor/setup-profile 是 setup 向导活性面**：`forge doctor` 的 codex-trust-state 检查、`forge setup` 的 'codex' controller kind + codexUserControllerConfigured。
4. **dev-runner 通道同时服务 claude**（保留面）：`agentRunner + allowedAgents` 经 executor-health（agent-jobs/executor-health.ts:94）分类 codex/claude 本地执行器健康，DEFAULT_LOCAL_AGENT_RUNNERS = ['codex','claude']；Agent Run 历史读取面是 CURRENT.md 已声明的迁移证据（"Historical Agent Run ... readback remain available"）。

**结论**：删除此面 = 产品决策（丧失对 codex CLI 使用者的仓库防护、安全扫描、doctor 信任检查），且需同片修改 AGENTS.md 架构契约块、bootstrap-files 门禁断言与 4 个测试文件约 30 条断言。列为**待用户决策**，不单方面执行（与"项目不集成 codex"的用户意图存在真实歧义：hooks harness 是 repo 防护面而非 agent 集成面）。

## 已执行（round 4，commit 2e6e2096a）

- **删除 `McpPolicy.execution.codexRunner` 死字段**：Codex 集成退役后该字段零行为读取者（仅构造写入 + context-pack sidecar 序列化镜像）。同片收缩 types.ts 类型、policy.ts controller profile 构造、两个 sidecar、file-policy.ts 3 处字面量、2 个测试夹具。dev-runner 通道（agentRunner + allowedAgents）保留服务 claude。

## 已执行（round 4 续，commit 2e3f2bfe9，7 文件 ±7，已推送）

用户产品决策（AskUserQuestion 确认）：**只退役 dev-runner codex half，保留 hooks harness**。

- dev-runner 允许集收窄 codex+claude → **仅 claude**：`McpAgentRunnerName` 类型、`DEFAULT_LOCAL_AGENT_RUNNERS`、multi-repository 的 config/env 解析过滤、context-pack sidecar 过滤、`--dev-runner-agents` CLI help、check-mcp-compatibility 策略构造。
- executor-health 零行为改动：历史 codex 分类经收窄后的 allowedAgents 自然报 `local_agent_disabled`（includes 断言类型适配）。
- **明确保留**（证据裁定非 dev-runner 面）：`controller_type` 传输身份词表（chatgpt/codex/claude/grok——识别外部 MCP 调用者，历史会话仍可能以 codex 类型连接）、Agent Run 历史记录域（issue-store ControllerAgent、legacy harness_doctor 枚举）、`.ai/hooks` 仓库侧防护 harness、`forge mcp setup claude`。

## 验证（round 4）

- 治理门全绿：type（两树）/ runtime-architecture / module-boundaries（零新增边）/ repository-hygiene / architecture-sync / bootstrap-files / mcp-compatibility；`codexRunner` 全树零残留。
- 聚焦测试：mcp-policy + governance-rule-resolution + local-bridge 36 pass + 1 fail——`local-bridge "serves a hardened localhost API surface"` 经 `git stash` 纯净 HEAD 复核**预存**（另一写者 host-command-lane 进行中工作的基线状态），与本轮无关；repository-mcp-command 6 个预存失败仍逐名一致。
- round 4 续（2e3f2bfe9）：type（两树）干净；四门禁 + module-boundaries 全绿；mcp-policy + governance-rule + mcp-http 35 pass 0 fail；local-bridge 仍仅那 1 个已验证预存失败（fixture 中 allowedAgents ["codex"] 未产生新失败）；repository-mcp-command 6 预存失败逐名一致。

## 并发写者记录（round 4）

审计期间另一写者再次同 checkout 活动：host-process-authorization 批次（`src/cli/index.ts`、`src/runtime/execution/process-runtime/host-command-lane.ts` 修改 + `src/cli/commands/host-process-authorization.ts`、`tests/runtime/host-process-authorization.test.ts`、`docs/operations/host-process-authorization.md` 新增 + `tests/test-manifest.v1.json` +4 行）。处置：stash 验证时注意隔离、提交只 stage 自己的 7 文件（零重叠），他人改动完好保留。该写者随后将此批次以 `cf38f657a fix(security): add local interactive ForgeInstance host grant authorization` 提交到同一整改分支，我的两个 commit（2e6e2096a、2e3f2bfe9）叠加其上，无冲突。

---

# 第三轮审计与整改（2026-10-21 晚）

主题：legacy-tool-service 退役执行 + #R3 裁决。修复 commit `cac20fde9`（4 文件 +9/-326，已推送）。

## 已验证（round 3）

1. **MCP 调度优先级链（死代码判定依据）**：所有生产 server 入口（stdio/http/gateway-adapter）都经 `createMcpToolContext` 构造上下文，`isMultiRepositoryContext`（server.ts:46，`'controllerHome' in ctx`）恒真；`executeLocalTool`（server.ts:1062-1101）先 `callRuntimeTool`（现代网关 16 个 adapter 链），仅返回 undefined 才落到 `callMultiRepositoryTool → callMcpTool`（legacy）。durable Worker 同序（`executor.ts:522-544`：controller profile 先 `callRuntimeTool`）。因此凡现代 adapter 有同名 case 且无条件 return 的 legacy 分支都是**不可达死代码**。
2. **4 个死分支（本轮已删）**：`controller_context`、`local_bridge_status`、`get_local_job`、`get_local_job_output` 在 `runtime-observation-adapter.ts`（:471, :630, :650, :664）有同名 case 且 switch 内无 fall-through（仅 default: return undefined :1196）。legacy-tool-service 中的对应实现（原 :1553-1699, :1711-1750）在生产与 Worker 两条路径都执行不到。测试引用复核：`tests/cli/runtime-command.test.ts:202,232` 断言的是**现代文件**的 case 排序，`mcp-policy.test.ts:18` 断言 definitions 含 get_local_job（定义保留，仅删实现），均不受影响。
3. **4 个可退役名（本轮已退役，等价性验证）**：
   - `get_git_diff` → `repository_git_diff`（repository-tools.ts:907，`repositoryGitDiff(repository, { staged, paths, maxBytes })` 为其超集）+ `git_diff_paths`；legacy 版全树零外部引用。
   - `get_github_plugin_status` / `configure_github_plugin` → `get_plugin` 的 GitHub plugin manifest（`github-adapter.ts:286-63` health 字段即 `getGitHubPluginStatus` 派生）+ `plugin_action_execute` action `configure`（github-adapter.ts:348，与 legacy 同一 `saveGitHubPluginConfig`）。
   - `github_status` → 同一 manifest health 投影（available/authenticated/errors 同源）。
4. **#R3 裁决为有界已声明迁移债，非缺陷（不实施原建议）**：CURRENT.md:286 显式声明 `work-contract-store.ts` "owns locked persistence and **one-time legacy normalization**"；源码 :526 给出 removal condition（"delete this migration branch after supported Controller Homes report zero schema<4 Work rows across one full release boundary"），:477-480 说明 persist-once-during-read 是刻意设计（避免读路径反复推断迁移）。原建议「迁移写显式化到启动迁移 owner」会新增机制，违反 Thin & Decoupled——**撤销该待修复项，改列暂不处理**，删除触发条件即源码已注明的 release 边界观察。
5. **Round 2 假设修正（证据推翻原候选清单）**：
   - `list_local_jobs` **不可退役**：现代 `list_jobs` 读 `listExecutionJobs`（controller-home 执行 Job，runtime-observation-adapter.ts:1101），legacy 读 local-bridge 票据（`listLocalBridgeJobs(ctx.repoRoot)`）——不同后端事实，无等价物。
   - `run_workflow_check` **暂缓**：在 `REQUIRED_CODEX_TOOLS`（setup.ts:38-47），退役需改 codex 集成契约，属产品边界决策。
   - `search_repository` **暂缓**：instructions.ts:15 显式声明其为 "internal compatibility surface"，退役需同步三处 prose（instructions/toolset-names/routing-policy）。

## 已执行（round 3，commit cac20fde9）

- 删 legacy-tool-service.ts 8 个 dispatch 分支 + 4 个 tool 定义 + 4 条孤儿导入（gitDiff/getGitHubStatus/getGitHubPluginStatus/saveGitHubPluginConfig/getLocalBridgeJob{Events,Snapshot}/readLocalBridgeJobOutput/reconcileLocalBridgeJobs/resolveLocalBridgeSurface/summarizeRecentJobs）。
- 清死引用：multi-repository.ts `REPOSITORY_LOCKED_TOOLS` 的 `configure_github_plugin`、:290 github_status 默认 repo 注入；governance/external-effects.ts `EXPLICIT_AUTHORIZATION_OPERATIONS` 的 `configure_github_plugin`。
- fingerprint 基线 `8cb7153fa2de1612` → `2134f5ca8294c5fc`（check-mcp-compatibility.ts:23，注释注明四名退役与等价落点）；legacyCompatibility 组 42 → 38，注册表总数 142 → 138，preferred 名/Schema 指纹不变。

## 验证（round 3）

- 治理门全绿：check:type / check:runtime-architecture（103 modules）/ check-module-boundaries.mjs（21 kernel + 184 runtime→cli 边，零新增）/ repository-hygiene / architecture-sync（advisory，0 blocking）/ bootstrap-files（12 pass）/ check:mcp-compatibility。
- 聚焦测试：mcp-policy + runtime-command 18 pass；repository-mcp-command 38 pass + 6 fail——经 `git stash` 纯净 HEAD 复核，失败集合逐名一致，确认为 round 2 已记录的基线预存失败（另一写者 Work mutation authority 主题），与本轮无关。
- `controller_capabilities` 快照中 `githubPluginConfiguration: true` 保留：该能力经 plugin_action_execute 仍存在，仅退役了专用别名。

## 遗留观察（round 3）

- 退役名的已部署客户端可能持旧 schema snapshot：fingerprint 失效机制即为此设计（check-mcp-compatibility.ts:40-42 注释），历史会话重连后自然收敛，无兼容解码需求。
- `controller_capabilities` 快照中 `githubPluginConfiguration: true` 保留：该能力经 plugin_action_execute 仍存在，仅退役了专用别名。
- `github_status` 的任意 `repo` 参数探测能力随退役移除（plugin manifest health 仅覆盖已配置仓库）——记录为已接受的能力损失。
- legacy-tool-service.ts 剩 34 名、~1950 行，全部为唯一实现（编辑会话 10、PRD/sprint 写入 8、浏览器 5、诊断 8 等）；后续按域拆出到正式 owner 的建议不变。
- **codex 残余面（下一批候选）**：MCP 面已清，但 CLI 侧仍有 codex hooks/AGENTS.md 安装器（`src/cli/installer/targets/codex.ts`、`src/cli/commands/doctor.ts:198`、`init.ts:198`、`setup-profile.ts:277`、`security.ts:403`）与 `McpPolicy.execution.codexRunner` 标志、dev-runner（agentRunner codex,claude）通道。用户已确认不集成外部 agent，这批可在下一轮以同样方法退役，但涉及 installer/agents 配置面更大，未在本 slice 强行扩界。

## 已执行（round 3 续，commit 44e3eb0d3，19 文件 +21/-516，已推送）

用户裁决：两项遗留退役均同意，且确认**项目不集成 codex 等外部 agent**——契约顾虑解除，Codex 专属 MCP 面整体退役：

- **`forge mcp setup codex` CLI + `runMcpSetupCodex`/`codexMcpBlock`/`patchCodexConfigToml` + `REQUIRED_CODEX_TOOLS` + doctor 的 codex 报告块**（setup.ts）全删；生成 guide 模板与三处文档（forge-chatgpt-mcp-setup.md、troubleshooting.md、troubleshooting.zh-CN.md）同步去掉 codex 行。`forge mcp setup claude` 保留。
- **`forge mcp prepare-goal` CLI + `prepare_codex_goal_from_sprint`/`write_codex_goal` MCP 工具**（legacy-tool-service 定义+分支+`renderCodexGoalFromSprint`/`validateGoal`/`goalFromSprintSchema` 专属 helper ~115 行）全删。
- **`run_workflow_check` 退役**：唯一契约锚点就是 REQUIRED_CODEX_TOOLS。连带删除 **`fixedWorkflowCheck` 死策略字段**（唯一消费者是该工具定义门；McpPolicy 类型、policy.ts 全 profile、file-policy.ts、两个 sidecar、两个测试夹具同片收缩）。
- **`search_repository` 退役**：现代等价 = rh_context 语义检索 + execute_command + 精确文件读；instructions.ts 指令、toolset-names.ts 注释、routing-policy.ts 路由表、thin-harness fast-executor 的 `search_repository` 别名（内部名 `search` 存活保留）与 execution-router 条目同片清理。
- fingerprint `2134f5ca8294c5fc` → `e6e3c8ade6c5a8d5`；legacy 组 38 → 34，注册表总数 138 → 134。

## 验证（round 3 续）

- 治理门全绿：type（主树+supervisor）/ runtime-architecture / module-boundaries（零新增边）/ repository-hygiene / architecture-sync / bootstrap-files / mcp-compatibility。
- 聚焦测试：mcp-policy + runtime-command + governance-rule-resolution 25 pass 0 fail；mcp-http 16 pass 0 fail（覆盖 setup/doctor/guide 生成链）；repository-mcp-command 38 pass + 6 fail = 与已验证基线预存失败逐名一致（另一写者 Work mutation authority 主题）。
- 全树残留扫描：`run_workflow_check`/`prepare_codex_goal`/`write_codex_goal`/`REQUIRED_CODEX_TOOLS`/`fixedWorkflowCheck`/`search_repository` 生产/测试/脚本零残留（唯一保留为 docs/architecture/reviews/ 历史评审记录，属归档证据）。

---

# 第二轮审计（2026-10-21 下午）

聚焦三个高影响域：control-plane 重复 authority 裁决、Recovery 域聚类、legacy-tool-service 退役条件。修复分支同轮新增 commit `ba04852e9`。

## 已验证（round 2）

1. **session-store 三写候选裁决：非重复 authority**。三处文件各 owns 不同事实（已验证）：
   - `packages/kernel/controller/infrastructure/controller-session-store.ts`（830 行）：Work 所有权租约/claim 权威，写 `controller_session_claim_store`/`controller_session_identity` 命名空间；
   - `src/runtime/control-plane/execution/session-store.ts`（223 行）：传输/执行会话上下文，写 `execution_session` 命名空间；
   - `src/runtime/control-plane/facade/controller-session-store.ts`：**纯 re-export shim，零生产调用者**（仅 5 测试 + 3 脚本引用）。
2. **第一轮待修复 #4 已处置**：shim 按 gate 自身规则（test-only shim = 有界债务，与其测试一同删除）退休——9 个消费者迁移至 `packages/kernel/controller/api/index`，shim 文件与 2 条 gate 条目（requireText + B7 shim 台账）同片删除，兼容 shim 台账 4→3。commit `ba04852e9`。
3. **Recovery 域权威干净**（round 2 核查）：release phase 唯一 writer 是 `release-session.ts:126 writeSession`（core.ts 24 处全经 advance/create/record API）；known-good/pin/quarantine/watchdog 写入点仅在 core.ts；`maintenance-executor.ts` 与 release 域零交叉；watchdog 副作用唯一入口 `watchdogTick`（core.ts:6957）；无第二自动恢复 owner。
4. **sqlite 单打开点声明成立**：全树生产打开点仅 `sqlite-store.ts:185`（control-plane.sqlite）与 `supervisor/store.ts:74`（supervisor.sqlite，独立库符合 2026-09-16 ADR）。
5. **`maintenance-executor` 的 5 处 `readWorkContractStore` 均为只读用途**（.find/filter 快照）；但底层 read 函数内嵌 legacy schema 迁移写（`work-contract-store.ts:535,554-563`）——"read 内嵌写迁移"列为后续收敛项。

## 待修复（round 2）

**#R1 standalone-recovery/core.ts（7292 行）按职责拆分**——最高优先级精简项。
- 证据：2026-08-01 以来 **147 commits**（全仓最高频热点文件），且是 6-7 个职责挤一个文件：release-session 编排（~1900 行，4716-6600）、Runtime 进程/服务管理（~1450 行，2646-4102）、探测/HTTP/MCP 客户端（~600 行，1033-1660）、watchdog 决策+tick、tunnel 修复、known-good 持久化、锁/身份。
- 最小修复：纯移动拆分（core.ts 留门面 re-export，零行为变化），最优先切割线为 cutover/session 段与进程管理段（耦合最弱、变更最密）。**有真实维护痛点支撑，非为整洁而拆。**

**#R2 legacy-tool-service.ts（2688 行）定性修正**：它不是"翻译层"而是**遗留实现聚集地**——47 个工具名与现代 registry（100 定义）零重叠，全部是唯一实现。可退役仅 6-10 个有现代等价能力的名字（get_git_diff/search_repository/run_workflow_check/list_local_jobs/github_status 等，需同步 fingerprint 基线 `8cb7153fa2de1612`）；主体（编辑会话 10、PRD/sprint 写入 10、浏览器 5、诊断 8）是唯一实现，建议按域拆出到正式 owner 后该文件缩为兼容薄层（1-2 个 MCP slice）。
- **round 3 处置**：逐名验证后修正假设——实际退役 4 名（get_git_diff/get_github_plugin_status/configure_github_plugin/github_status，见 round 3），另删 4 个被现代网关遮蔽的死分支；`list_local_jobs` 后端不同不可退役、`run_workflow_check` 锁在 codex 契约、`search_repository` 为显式声明的兼容面。fingerprint 已更新为 `2134f5ca8294c5fc`。文件剩 38 名 ~2360 行。

**#R3 `readWorkContractStore` 的迁移内嵌写收敛**：读路径隐式写 `work_contract_schema_v4_migrated`，与"read 是纯投影"原则冲突；建议迁移写显式化到写路径或启动迁移 owner。
- **round 3 裁决**：CURRENT.md:286 已显式声明该 store 拥有 "one-time legacy normalization"，源码 :526 带 removal condition——判为有界已声明迁移债而非缺陷，撤销原建议（新增迁移 owner 违反 Thin），移至暂不处理。

## 可删除（round 2）

- ✅ 已删：facade controller-session-store shim（`ba04852e9`）。
- **`ios-agent-device.ts` 的 JD 电商专属逻辑**（`JD_BUNDLE_ID = 'com.360buy.jdmobile'`，:64,1358-1759,2187 约 400+ 行）：项目化 one-off 能力进 Forge 核心，违反"Forge-core 不收项目专属机器"规则，应移入 plugin/adapter 层。中低变更密度（14 commits），适合独立 slice。
- 其余 B7 shim 台账 3 项（work-contract-store、types、schedules/settlement）：均有存活消费者，按各自 removal 条件到时删除。

## 暂不处理（round 2）

- **work-contract-store 读路径迁移写（原 #R3，round 3 裁决移入）**：有界已声明迁移债，removal condition = 一个完整 release 边界内受支持 Controller Home 报告零 schema<4 行后删除迁移分支（work-contract-store.ts:526）。
- **browser-adapter.ts（5428 行）**：120 commits 高度活跃，且双轨（browser/computer plugin）均有消费者——近期不动。
- **ios-physical-device.ts（2124 行）**：39 commits、正常消费，非死代码；与 ios-agent-device 同批考虑。
- core.ts 与 release-store 的 `readCurrentRecoveryRelease` 并存：分别服务 recovery 身份与 Runtime 权威，不同事实（低风险，文档注明即可）。
- `recovery/quarantine-retention.ts` 与 core.ts 的 `quarantine.json` 同名不同事实：无写冲突，留意命名。

## 并发写者记录（round 2）

审计/修复执行期间，另一写者在同一 checkout 进行 placement-policy 修改（AGENTS.md、work-preparation-service.ts、work-terminal-cleanup.ts 等 10 文件，含 gate 断言 `useWorktree` 从 `!== 'reuse'` 改为 `=== 'new_worktree'`）。处置：通过 `git stash push --staged` 隔离验证 + 只提交自己的 11 文件，他人改动完好保留工作树。**附带发现**：该写者的半套改动曾一度混入我的 staged gate 文件（stash pop 交叉污染），已甄别还原——多人共用 checkout 时 staged/stash 交叉是真实风险，建议其改用独立 worktree（AGENTS.md 自己的 placement 政策也是这么规定的）。

**基线预存失败证明**（避免误归因）：`capability-recovery` 的 1 个 fail（stale Work bulk-cancel）与 `repository-mcp-command` 的 6 个 fail 在纯净分支 tip（无任何工作树改动）上即可复现，属另一写者进行中工作的基线状态，与审计收缩无关。

## 下一轮候选

1. #R1 core.ts 拆分（最大、证据最充分，仍是最高优先级精简项）。
2. ~~codex CLI 残余面~~（round 4 已处置：codexRunner 死字段 + dev-runner codex half 已退役，hooks harness/`controller_type` 词表/历史记录域按用户决策与证据裁定保留）。
3. JD 电商逻辑移出 ios-agent-device.ts 进 plugin 层（~400 行离开 Forge 核心，`JD_BUNDLE_ID = 'com.360buy.jdmobile'` 仍在核心 :64,1358-2056）。
4. WSL 源同步现状（#312 S0）验证。
5. legacy-tool-service 按域拆分评估（编辑会话域最先，10 个工具名自成一域）。

---

> - `src/cli/repositories/controller-home.ts` → `src/effects/controller-home.ts`（git 100% rename，纯移动），新增 `check-module-boundaries.mjs` runtime→cli 规则 + `docs/architecture/runtime-cli-edge-debt.json` 收缩台账（seed 184 条，禁止新增）。
> - `supervisor/entry.ts` 复用 `reconcileWorkflowSupervisorSocket` 写者围栏（含 `--socket` 覆盖时的规范路径检查）。
> - 删除 `local-bridge/server.ts:98` 死导入与 `adapters/mcp/auth.ts` 全部 5 处 `_legacyRepoRoot` 忽略参数及调用方。
> - 新增 OAuth 单一 owner 护栏测试（corrupt fail-closed 不改写文件 + 单文件 round-trip），追加于既有 `tests/cli/mcp-oauth-state.test.ts`（用户显式解冻测试冻结）。
> - 验证：check:type / check:runtime-architecture / check:module-boundaries / check:repository-hygiene / check:architecture-sync / check:bootstrap-files 全过；聚焦测试 mcp-oauth-state（4 pass）、runtime-command（6 pass）、canonical-single-runtime（28 pass）。
> - 未做：runtime→cli 剩余 184 条边的逐条迁移（后续 slice 按台账收缩）；main 合并与 PR 开启属交付边界决策，未自动执行。

审计者：独立架构审计（只读）。审计对象：`moretea-labs/forge`，主 checkout。沿用 #312（Thin Forge delivery efficiency / codebase simplification）既有计划，不建立新任务体系，不修改生产 Runtime。

**审计环境事实**：审计期间主 checkout 被另一写者从 `work/forge-chatgpt-empty-shell-evidence-20261021`（beadef290）切换至 `work/forge-cleaned-workhandle-optional-policy-20261021`（b9d49400e）。本报告所有 `文件:行号` 引用以 b9d49400e 时点源码为准，empty-shell 相关结论以 beadef290 为基线并复核未受影响。

---

## 一、模块职责与依赖图（已验证基线）

| 模块 | 职责 | 权威实现（owner） |
|---|---|---|
| Controller | ControllerRound/Session/Binding 语义与续轮 | `packages/kernel/controller/`（`controller-round-store.ts` 1970 行等）；runtime 仅组合（`src/runtime/root/controller-round-composition.ts`） |
| Work | 语义契约 CAS + 准备/操作/交付/验证服务 | `packages/kernel/work/infrastructure/work-contract-store.ts`（2099 行）；`src/runtime/control-plane/execution/work-{preparation,operation,delivery,verification}-service.ts` |
| Scheduler | 仅触发/occurrence 权威 | `packages/kernel/scheduler/application/*`；编排 `src/runtime/control-plane/global-scheduler/scheduler.ts` |
| Workflow Supervisor | 跨 assistant-turn 外层调度 + task/effect/completion journal | `supervisor/{control-plane,store,server,chatgpt-conversation}.ts`；runtime 宿主 `src/runtime/root/workflow-supervisor-runtime.ts` |
| Plugin | 插件域模型与宿主 | `packages/plugin-runtime/`；宿主 `src/runtime/plugins/`（store.ts 2388 行、browser-adapter.ts 5428 行） |
| Computer | 目标权威 ComputerSurfaceTarget + Chrome 扩展 | `packages/plugin-runtime/computer/target-authority.ts`；`adapters/computer/`（chrome-extension） |
| Recovery | 独立恢复进程 + ReleaseSession/Coordinator | `src/runtime/standalone-recovery/core.ts`（7292 行）；`src/runtime/release/*` |
| MCP | 服务面所有权 | `adapters/mcp/`（runtime-gateway 47 adapter + transports） |

**持久化 Writer 清单**（SQLite 打开点仅 2 处 + 1 备份点）：
- `src/runtime/control-plane/persistence/sqlite-store.ts:184`（control-plane.sqlite，统一注入 kernel 各 store）
- `supervisor/store.ts:72`（supervisor.sqlite，唯一 journal writer）
- `src/runtime/root/release-store.ts:124`（仅备份快照）

**依赖方向机械证据**：`scripts/check-module-boundaries.mjs` 仅覆盖 `packages/kernel`（4 条规则：禁 import adapters/apps/supervisor；legacy 边须命中 `docs/architecture/kernel-legacy-edge-debt.json` 21 条 allowlist 且 stale 即报错；跨域只走 `api/index`；环检测）。**src 层不在覆盖内**，存在 runtime→cli 反向依赖（见待修复 #1）。

---

## 二、已验证（结论 + 证据）

1. **11 个精简提交独立复核通过，无高风险残留**（#318–#332、#335 系列）。所有被删路径在 `scripts/check-runtime-architecture.mjs` 有 `requireMissing`/forbid/fingerprint 断言与删除同步；被删导出主树零引用。合计净 **-1039 LOC**（+981/-2020），删除均为真删除，无"移动冒充删除"（#329 的 objective-graph→objective-relations 是带存活调用者的移动，已单独标注）。
2. **Supervisor 单一 writer 成立**：supervisor.sqlite 仅 `store.ts:72` 打开；runtime 侧有写者围栏（`supervisor/server.ts:16-60,137` owner 文件 + `getRuntimeWriteClaim()`）；adapter 内存缓存均标注 projection-only；Chrome 扩展仅存 provider 实例 ID，非 Supervisor 状态。例外见待修复 #2。
3. **empty-shell 轮转链证据严格**：`supervisor/store.ts:1869-1892` journal 事件仅统计 `verified_empty_shell=1` 且 `code=COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE` 的记录；`receiptLimit = unavailableReads>=2 ? 6 : 10`（:1871）；轮转与 `conversation_migrated` 事件同一事务提交。`supervisor/native-browser-adapter.ts:459-496` 要求 streak>=3、间隔>=2 分钟、精确 canonical URL、无 provider 失败文本、无账户级 backpressure 等硬条件；未发现把 UI 文本/tab pin/heartbeat 误当证据的路径。
4. **近期 Supervisor 提交未引入第二状态机**：532c5504e（cadence 由固定 15 改 receiptLimit）、94a2f2b8c/f8a7cdaf4（收紧观察分类）均无旧 cadence 分支残留。既有只读兼容（`store.ts:1796` `legacyRefundCoversGeneration`、`control-plane.ts:928` 旧回执解析）为已声明迁移债，无写入镜像。
5. **Scheduler/ControllerRound/Computer 边界无违规写入**：Scheduler 只写自己的 store 并自我暂停（`global-scheduler/.../engine.ts:462-470` `pausedReason:'workflow_supervisor_owns_outer_turn'`）；Supervisor 对 Work/Requirement 仅只读 import（`supervisor/control-plane.ts:5-6`）。
6. **Issue 对账**：
   - **#301（standalone DONE 终结 unbound Work）：已修**。`supervisor/forge-validators.ts:101-110` DONE 走 `validateSemanticCompletionBinding` 且只读，不触碰 Work 状态。
   - **#242（Supervisor auto-enroll 无限开 tab）：已修**。无 auto-enroll 代码；tab 重建仅限 send 模式或 applied 待回执（`native-browser-adapter.ts:774-777`）。
   - **#286（回收 Chrome tab）：部分实现**。idle 回收已落地（`native-browser-adapter.ts:659-686`，grace 5 分钟、上限 8）；CURRENT.md:81 明示 100-round/no-growth、schedule-near-wake、restart acceptance 仍 outstanding。
   - **#287（归档会话）：未实现，且为架构上的显式拒绝**（CURRENT.md:30 read path never performs one）——属产品决策项，非代码缺口。
   - **#313/#337（cleaned Work 恢复 lineage）**：206228a54、6ed854af7 已合并并有直接测试（`tests/runtime/work-terminal-cleanup.test.ts:782,960`），可标记已解决待线上验证。
7. **测试不变量覆盖总体良好**：CAS/陈旧写者拒绝（work-handle-store、repository-work-admission、release-session "one active per instance"）；幂等/不盲重放（`process-runtime.test.ts` request_id single-flight、`workflow-runtime-interpreter.test.ts:129` outcome_unknown 不重放、supervisor exactly-once reservation）；失败恢复（release-session 全 phase、worktree crash-race 清理、legacy cleaned handle 恢复）。**supervisor 进程重启恢复 smoke 已纳入治理门**：`scripts/run-governed-gate.ts:34` 包含 `check:smoke`（含 `smoke:workflow-supervisor-process-restart` / `-restart-recovery`，package.json:121-122）——此前疑似门盲区不存在。
8. **kernel 边界门有效且债务只减不增**：`kernel-legacy-edge-debt.json` 21 条边 + stale 检测（`check-module-boundaries.mjs:79-81`）。

---

## 三、待修复（按优先级）

**#1 runtime→cli 反向依赖（src 层无边界门覆盖）**
- 证据：`src/runtime/control-plane/persistence/sqlite-store.ts:5` import `../../../cli/repositories/controller-home`（durableControllerHome）；`workflow-content-store.ts:9`、`controller-home-migration.ts:17`（listRepositories）同模式；`src/runtime` 其他位置共 20+ 处。
- 风险：持久层依赖 CLI 模块，与 Kernel V2 方向（机制向上、语义向下）相反；当前无任何 gate 检查 src 层方向，此债务可无限生长。
- 最小修复：把 `controller-home` 路径解析与 `listRepositories` 提取为 runtime 可直接依赖的共享模块（或 kernel port），然后为 src/runtime→src/cli import 增加一条 check-module-boundaries 规则 + 债务台账（沿用 kernel 的只减不增模式）。**不建议**一次性大迁移。

**#2 `workflow-supervisor` bin 入口是潜在第二写者**
- 证据：`package.json:119` `"workflow-supervisor": "bun supervisor/entry.ts"`；`supervisor/entry.ts` 直接 new `WorkflowSupervisorStore` + ControlPlane + server，不写 owner 围栏文件（对比 `supervisor/server.ts:137` `reconcileWorkflowSupervisorSocket`）。
- 风险：与 Canonical Runtime 并发运行时两个进程同时写 supervisor.sqlite（SQLite 有锁但 journal 语义上出现双写者）。未见部署使用证据，推测为诊断工具。
- 最小修复：要么 entry.ts 复用同一 owner 围栏（写 owner 文件、拒绝非本代写者），要么降级为只读诊断模式（open readonly）。二选一，不新增机制。

**#3 巨型文件聚焦（Thin & Decoupled 下的真实精简对象）**
- 证据：`standalone-recovery/core.ts` 7292 行、`plugins/browser-adapter.ts` 5428 行、`plugins/store.ts` 2388 行、`kernel/work/.../work-contract-store.ts` 2099 行、`supervisor/store.ts` 1914 行（全仓 ~24.1 万行 TS）。
- 风险：不是"行数即违规"（架构文档明确行数只是 review 启发式），而是这些文件同时是高变更密度权威（近期 Supervisor/Work 修复全部落在这里），review 面与回归面持续放大。
- 最小修复：按已有的所有权拆分（Recovery 已有 `operation-lock.ts` 先例）在各自后续真实修复 slice 中顺带切分，**不**为整洁发起专项重构。

**#4 三处同名 controller-session-store 职责文件**
- 证据：`packages/kernel/controller/infrastructure/controller-session-store.ts` vs `src/runtime/control-plane/facade/controller-session-store.ts` vs `src/runtime/control-plane/execution/session-store.ts`。
- 风险：重复 Authority 候选，违反"one fact, one authority"的命名可读性要求；是否真有第二写者待下一轮深入（本轮未验证是否有双写）。
- 行动：列入第二轮审计首位，先证明事实再决定合并方向。

**#5 OAuth token 单一 owner 无直接测试**
- 证据：`src/runtime/safe-tooling/google-oauth-broker.ts`、`google-credential-store.ts` 零测试引用（仅 resend-oauth 间接覆盖）；`tests/cli/mcp-oauth-state.test.ts` 只测 authorization code 一次性。
- 风险：#318 刚统一 OAuth token authority，回归无护栏。
- 最小修复：一个聚焦测试——第二写入点/fallback 路径被拒绝、corrupt 主文件报 `MCP_OAUTH_STORE_CORRUPT` 不静默换源。

---

## 四、可删除（低风险、证据充分）

1. **死导入**：`src/cli/local-bridge/server.ts:98` import `loadMcpLocalConfig`，文件内零调用（#319/#320 迁移遗留）。已复核全文件仅此一处出现。
2. **签名 shim 参数**：`adapters/mcp/auth.ts:217,221,267,295,337` 的 `_legacyRepoRoot?: string` 被忽略参数（#320 遗留）。无行为，仅签名兼容；更新 5 个调用方后即可删除。
3. **只读拒绝集合中的死名**：`adapters/mcp/runtime-gateway/router.ts:28-35` `RETIRED_AGENT_OPERATIONS` 及 `execution-router.ts:78,674,686`、`jobs/child-reference.ts:23` 分类集合仍列 #327 已退役的 Agent/Local Job 旧名。gate 刻意只对 legacy-tool-service.ts 断言。属可累积债务，建议在下一个 MCP slice 一并清空。
4. **旧 worktree 副本**：`.worktrees/work-codex-294-connector-post-20261018/`（保留 #321 删前源码的独立分支副本）；`.worktrees/` 另有 `fix-runtime-rollout-convergence`、`runtime-b80f210c`。
5. **陈旧 managed worktrees**：`~/.forge/controller/managed-worktrees/` 含 8 月底/9 月初目录（repo_73bff…、repo_ec526…、repo_f37fe… 等），git 注册 worktree 共 16 个。**前置条件**：必须逐个核对 Work 终态/清理回执后再删（AGENTS.md：完成交付的 worktree 不应累积为常驻环境）；本轮只登记事实，不主张直接删除。
6. **`bootstrap_bind_conversation` RPC 面**（`supervisor/server.ts:398`）：客户端封装已删但 RPC 有合法内部调用者（`native-browser-adapter.ts:1021,1060`）。标记为待内部调用者迁移后退役，非立即删除。

---

## 五、暂不处理（显式理由）

- `supervisor/store.ts:1796` legacyRefundCoversGeneration、`control-plane.ts:928` 旧回执解析：已声明的只读迁移债，有明确 removal 条件。
- `loadMcpLocalConfig`（`adapters/mcp/auth.ts:197`，非 Controller profile 使用）：CURRENT.md:24 明示设计保留。
- `requiredCapabilities` 字段（#335 后仅作 digest 身份，`workflow-asset.ts:175`）：设计保留。
- 64 个含 legacy/retired 关键词的测试文件：绝大多数是架构文档要求的"迁移 exactly-once"证据测试；Kernel V2 候选接受后统一重分类，现在逐个删除会破坏迁移证明。
- #317/#316/#305 等 WSL/打包问题与 #313 P0：属交付/验证轨道，非本轮架构精简范围。

---

## 六、下一轮计划

1. 深查待修复 #4（controller-session 三写候选）与 `maintenance-executor.ts`（1814 行）直接 `readWorkContractStore` 的 5 处读取点是否绕过 store 单一写者语义（只读，需确认无写路径）。
2. Recovery 域专项：`standalone-recovery/core.ts` 7292 行的职责聚类 + 与 `release/`、`recovery/maintenance-executor.ts` 的权威重叠。
3. `adapters/mcp/tool-mapping/legacy-tool-service.ts`（2688 行，CURRENT.md 承认仍生产使用）：评估其退役触发条件是否可枚举。
4. WSL 源同步现状（#312 S0）与 Mac 单仓推进的实际 Git 拓扑证据。

## 附：本轮证据方法

真实源码阅读 + `git show --stat` 逐提交复核 + 全树 grep 残留扫描 + 测试文件抽样 + `git worktree list` 实测。所有"已验证"结论均有文件:行号支撑；推测性判断均标注"推测"。
