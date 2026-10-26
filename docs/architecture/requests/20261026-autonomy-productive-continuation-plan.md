# Forge #313 — 让自动推进产生可验收交付，而非无限 CONTINUE（设计审查稿）

> **Draft / DESIGN-ONLY / 未获独立 ACCEPT / 禁止按本文直接修改生产源码或发布。**
> 用户 2026-10-26 指令：先读足必要源码与工程制度，提供精确文件/函数/竞争边界和验收方案；以固定文档 PR 经两个独立 ChatGPT 会话多轮审查，REVISE 回同一 Plan/PR，双方 ACCEPT 后再实现。
>
> 设计基线：canonical Windows WSL2 repo `repo_f37fe508f6e8dabb8fe607e4`，`/home/greyson/src/forge`，检查时 HEAD `db7c463d`（2026-10-26）。当前源代码工作树另有 `src/cli/controller/launch-agents.ts` +41 行未提交，归原 P0 代码 Owner，不属于本文 PR。GitHub 文档分支独立、不触碰 WSL 源码工作树。
>
> 事实源：原 Plan `PLAN-forge-thin-delivery-efficiency-code-slimming-20261019` **revision 4**（14 项），原源码 Work `work-forge-source-bug-convergence-v1`，原唯一 WSL A-line Writer `supervisor:d09f4e6bb4014a894db105ec`。协作 Issue [#313](https://github.com/moretea-labs/forge/issues/313)；关联但不得冒名实施的 UI 重构 [#465](https://github.com/moretea-labs/forge/issues/465)。本文仅为方案审查候选，不创建 Work、Writer、Scheduler 或 Approval Authority。

## 0. 目的、成功标准与边界

**用户真正要的结果**：在持久 Work 上，无需人工反复说“继续”，Forge 能识别“看似在运行、实际零交付”的病态，及时由原模型/Owner 调整合法执行路线，恢复有效源码修改和 CI/Review/merge/Runtime 真实交付。自动续跑本身、测试通过、Plan 修订次数、Review 或 ControllerRound 轮数均不是成功。

不可退让：Task/Effect/Completion 由既有 Supervisor SQLite 唯一持久 Authority 负责；实际 Chrome Browser 操作只使用当下授权的同一原始 Chrome extension/provider profile/window/tab；Git 与 Work CAS、单源码 Writer、未知外部 Send 不重放；Mac 仅远程运维/Release 实验和 E2E，不再是 Forge 源码 Writer。源代码实现由**原 WSL Writer**完成，不因本方案 PR 获得第二权限。文档 PR 是 Plan Writer 的隔离提案，不是源码实现 PR，不授予原 effect 重发权限。

不做：新状态机、第二套 Kernel Planner、第二套进度 SQLite、重复 Work/Plan/Supervisor、无限 Review Supervisor、Chromium 品牌白名单/跨 profile fallback、扩展以外的 ChatGPT 自动发送、重启服务替代因果核对、增加过度通用恢复开关；不得调整 unrelated `launch-agents.ts` dirty 改动。遵守 AGENTS.md 的“质量/审查在实际边界进行”和不默认扩张测试套件要求。

> **需要先审的潜在 Plan 不一致**：原 r3 继承 2026-10-19 “Mac/WSL Git sync、代码瘦身” S0–S4 旧条目，其目标措辞中还有旧的 Mac 场景；P0–P7 聚焦此次产出恢复。Reviewer 必须判定修同一 Plan 的目标/优先级/旧 S 条目即可，还是需要重定界。不可据旧 S0 给 Mac 源码写权限，也不可因未完成 GPU/代码瘦身阻挡此次 P0。

## 1. 已确认事实 vs. 假设（不得相互替代）

| 证据 | 状态与边界 |
| --- | --- |
| Runtime / WSL Recovery / 主 Connector | 健康，控制面可达；并不说明 ChatGPT 原目标页面可生成或可 Send |
| 唯一 Writer | `supervisor:d09f4e6bb4014a894db105ec`；`fx_170155dcd5cfe2a220238aff61d04f20` 为 `recovery/send/generation=1`，查账未见 `effect_dispatch_started` 或 `effect_applied` |
| 旧因果债务 | 有 5 条旧 `effect_applied` 无有效完成回执，其中包含多级 recovery。可能有晚到有效回复；**绝不可改写或删除这些历史事件** |
| Writer 错误 | 有 `COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED` 的 task-local pre-mutation 诊断；某些 Chrome 绑定时间戳更新，只证明某次 heartbeat/target attachment 存在 |
| Reviewer 空转 | 同时段 Writer 0 新 dispatch/0 completion，独立 Reviewer 却曾产生约 230 dispatch / 228 completion、约 200 browser-failure 事件。该数量不等于新候选源码/交付 |
| Stop-pending 假设 | `supervisor/native-browser-adapter.ts` 的 recovery prepare 对 `provider_recovery_stop_pending` 直接返回；Chrome content.prepare 检测旧 Stop control，recover dispatch 才可能执行 Stop，存在逻辑不可前进风险。**没有可信的 Writer 当前精确 DOM/Stop 状态，暂未证明这是唯一现场根因** |
| 浏览器心跳假设 | `adapters/computer/chatgpt-extension-target.ts` 以 15 秒检测 fresh provider，`background.js` MV3/service-worker/Native Messaging tick；短暂无心跳或 receiver timeout 可能令确保/发送入口失效。需真实 timestamp/timeout 而非猜测 |
| 现成迁移出口 | `supervisor/control-plane.ts:migrateConversation` / `supervisor/store.ts` 具备原 task explicit migration；`appliedEffectAwaitingCompletionWithin` 在旧 applied 未完成时拒绝迁移。必须保留该护栏 |

已存在的架构约束：`docs/architecture/decisions/20261001-supervisor-turn-authority.md`、`docs/architecture/decisions/20261011-autonomous-continuation-convergence.md`、`docs/researches/20261019-supervisor-transport-observation-convergence.md`。后者已实现相同 error fingerprint 最多写三次，不再无限记失败，但这只是降噪**并没有恢复产出**。

## 2. 当前调用链 / Authority 图

```text
Existing Work + user Objective
  -> original Workflow Supervisor Task (task_id / conversation_id)
    -> supervisor/store.ts canonical effects/events/completions
      -> supervisor/native-browser-adapter.ts runOnce()
         -> serviceFreshSend() (due effects fairness)
           -> processTask() targetPort.ensureExact()
             -> executeCommand()
               -> exact target.observe() (current conversation, history, composer)
               -> prepare() [recovery + stop_pending currently returns early]
               -> exact target.observe() (re-validate after await)
               -> withChatgptProviderDispatchLane
                 -> browserPoll exact same effect/gen
                 -> browserBeginEffect (durable dispatch CAS)
                 -> target.dispatch(mode=recover) -> Chrome background -> content
                    -> Stop old turn? -> exact editor -> Send
                 -> browserObserveEffect (applied / not_applied / unknown)
      -> valid model final reply -> canonical assistant_completion -> next CONTINUE
    -> Work/Git/Process/CI real artifact -> fixed-HEAD review -> authorized merge/release
```

不得把 Reviewer 的 assistant completions 当作源码 Writer 交付；不得把“消息投递成功”当作 Git mutation；不得把“生成中”或“无 Stop”推断为旧 effect 的完成回执。

## 3. 修改提案（按最小因果切片）

### P0. 仅只读冻结现场账本（实施前提，不改 schema）

读取 `supervisor/store.ts`：`appliedEffectAwaitingCompletionWithin`、`effectDispatchLedger`、`taskStall`、`latestAppliedLeafEffectWithoutCompletion`、`migrateToFreshConversation` 和 `migrateConversation`；`supervisor/control-plane.ts` 的 `browserPoll`、`migrateConversation`；`supervisor/server.ts` 的相关 RPC；Computer Target Authority 的当前 exact binding。

输出 3 类证据：A. zero-dispatch effect（可以受原权威调度）；B. `effect_dispatch_started` 但 outcome unknown（只能 reconcile，不得再次 Send）；C. `effect_applied` 但 completion absent（必须继续观察晚到 reply/causal successor 或显示人工所需确切证明）。原 Writer 的 5 个旧 applied 与 `fx_170...` 必须在同一因果图，不能只检查最新一条。

### P1. 收敛“旧生成 / 新 recovery Send”的单一 mutation Authority（核心，首选最薄修正）

拟检查/修改：
- `supervisor/native-browser-adapter.ts`：`processTask`、`executeCommand` 中 recovery prepare + `provider_recovery_stop_pending` 早退，以及 `withChatgptProviderDispatchLane` / `browserBeginEffect` / `browserObserveDispatchFailure`。
- `adapters/computer/chrome-extension/background.js`：`executePrepare`、`executeDispatch`；`adapters/computer/chrome-extension/content.js`：prepare-only Stop 检测、`dispatchPrompt(mode=recover)` 对 Stop、composer 和 Send 的顺序。
- 对照 `packages/plugin-runtime/computer` 既有 `prepare/dispatch/observe` typed contract，**不新增 stop provider / effect writer / fallback path**。

三个可选策略必须通过独立审查比较：
1. 只读等待与明确人工 Stop：最少代码但不解决无人值守自治；可作为有界安全退出，不算 DONE。
2. **优先评估**复用现有 recover dispatch 通道：当 exact target（同原 profile、window、tab）明确是旧生成 Stop pending，且原 effect generation 仍为 0，携带准备前、lane 内 fresh observe / exact `browserPoll`，再由原 `browserBeginEffect` 原子授权唯一 mutator；原 Chrome content 可在同一受控 `dispatchPrompt(recover)` 里 Stop 旧生成、再写 composer、最终单次 Send。**设计 Reviewer 必须先确认“Stop 已按下但 Send 未按下”的副作用分类**：不能用 `not_attempted` 虚假否定已发生的 Stop；不能凭 Stop 结束就宣布原 effect `applied`。所有试图重入的线程依赖同一 owner 和 generation，若任何 transport exception 发生在可能 Send 之后，保留 `unknown` 只读 reconcile。
3. 跨会话或跨 Provider 自动迁移：**当前排除**，因为有 applied-without-completion 祖先且身份约束未满足；后续只有原显式有 CAS、证据完备时才可迁移。

late reply 优先：在对旧 Stop 采取任何 mutation 前，同一 exact conversation 先尝试观察合法 final reply / effect marker，若旧 source 已完成则由原模型 completion 先结算，不再 Stop/Send。若无法证明旧 Stop 属于哪个源效应，禁止自动取消并给原 Owner 一个**有界且单次**可执行的阻塞事实，而非无限重试。

### P1.1 已确认的 Stop-only 副作用分类缺口（Plan r4 作者修订，不代表独立 Review）

源码中 `adapters/computer/chrome-extension/content.js:245–254` 的 recover 分支先执行 `stop.click()`，再检查 editor 是否可安全占用或存在人工/其他 effect 的草稿。若 Stop 已按下而后续遭遇 `composer_not_empty`、`send_button_disabled`、`target_identity_changed`，content 可能返回 `{dispatched:false}`。`adapters/computer/chrome-extension/background.js:executeDispatch` 对所有 `dispatched:false` 统一返回 `mutation:'not_attempted'`，而 `supervisor/native-browser-adapter.ts:executeCommand` 将其当作可证明未发生 provider mutation 的失败。**这是源码层已证实的风险，不是现场 Writer Stop 按钮状态的已证实原因。**

**实施之前必须由独立 Reviewer A 定案：**

1. **Stop 前的因果与用户草稿归属证明**：验证旧正在生成的 Turn 对应唯一真实已应用但未完成的源 effect，尚无有效晚到 completion；精确 profile/session/window/tab 与 URL 未漂移；单一 composer 无陌生草稿；未通过任何一项就不得点击 Stop 或 Send。
2. **两种副作用区别**：Stop 旧回复可以发生而新消息 Send 没发生。Stop-only 不是 `mutation:'not_attempted'`（如果“mutation”字段泛指外部页面副作用），也不是新 effect `applied`。须在既有 Supervisor/Computer receipt 内表达可观测阶段，并防止 Resume CAS 将 Stop-only 当作可盲重试的新恢复发送。原则上不添加第二个持久 effect Owner。
3. **未知时只读对账**：当 Native RPC/Extension claim 在 Stop 点击后失去回复，无法证明 Send 是否发生，保持原 effect unknown 与 exact-target 只读 reconcile；禁止利用浏览器刷新或另一 tab 回避未知副作用。
4. **不只删除 `provider_recovery_stop_pending` 早退**：只有完整跨 `content.js → background.js → chatgpt-extension-target.ts → native-browser-adapter.ts → supervisor/store.ts` 的真实阶段证明，才能让原恢复在同一 effect dispatch lane 内推进。

### P1.2 与历史 S0–S4 的范围边界

原 Forge Plan r4 仍保留 2026-10-19 的 S0–S4（旧 Mac/WSL 同步、GPU/Ollama、代码瘦身等）。它们是**长期效率工作，非此次 #313 P0 自动推进恢复的前置条件**；原目标中 Mac 源码同步表述是历史事实，2026-10-24 后唯一 Forge 源码 Writer 为 Windows WSL2。双独立 Review 仅评价 P0–P7 的这次故障收敛以及不得破坏 S0–S4 长期边界，不得让实验 GPU 或大规模瘦身拖延最小有效修复。Reviewer B 仍必须判断如此复用原 Plan 是否过度混合，若 REVISE，原地修 Plan 和同一 PR。

### P2. 只在实证支持时修复 Extension 的连接不稳定

- `adapters/computer/chatgpt-extension-target.ts`：`HEARTBEAT_FRESH_MS=15_000`、`freshProviders`、`selectProviderInstance`、`submit`、`ensureExact`。
- `adapters/computer/chrome-extension/background.js`：`providerTick`、`heartbeatTick`、`nativeRpc`、`tabMessage`、MV3 alarms/timeout。
- `supervisor/native-messaging/host.ts`：Native Message transport 本身。

观测必需有 providerInstanceId 同源、最后 heartbeat age、command claimed 状态、实际 command timeout、Native Messaging 断链、tab receiver 是否重新 hydration。对比 15s freshness / 12s command / 背景 alarm，**不允许无证据简单提高 timeout 或加密轮询**。若原扩展不可达，必须保留原 tab binding 和未确认 Send，不能默认换另一浏览器/登录档案。

### P3. 有效产出 / 无效路线信号（只读衍生，不新建 Authoritative Work 状态）

复用 `supervisor/store.ts` events/completions、`src/runtime/root/workflow-supervisor-runtime.ts` 的 `reportTransportState` / `reportTaskStall`、`packages/kernel/controller/domain/execution-quality.ts`、`src/runtime/control-plane/execution/work-evidence-policy.ts`、现有 Git WorkHandle 和 Process/PR receipt。

最小字段：`activity_count`、`last_material_delta_at`、`time_to_first_mutation`、`repeated_same_error/verification`、`same_head_review_without_new_evidence`、`causal_blocker`、`coverage=known|unknown`。物质性进展因 Work 类型而异：仓库变更看可归属的源 diff/commit 和当次 PR HEAD；文档/研究 Work 看可校验独立成果；真实外部等待标为 WAIT，不可当低效。

触发条件为**建议**：例如同一错误连续 2–3 次、同固定 SHA Reviewer 20 次没有新候选、同一合法执行窗口中 Writer 3 次没有新可验证修改。由模型判定继续、改道、按唯一 effect owner 恢复或合法交接；不能由机械检测器擅自 Send/迁移/停止任务。提示按原 Work+证据指纹只出现一次；纠偏后的下一可验证成果必须明确。

### P4. Review 只在发生真正差异时唤醒

检查 `src/runtime/root/workflow-supervisor-runtime.ts:reconcileReviewNotices`、`supervisor/control-plane.ts` / `supervisor/store.ts` 固定 HEAD/CI/Review notice，以及**现有**独立 Reviewer 目标。保留单 Reviewer 身份，不因每次 CONTINUE 新建 reviewer 或 approval Work；如果 HEAD/Plan revision/CI/finding 均未变，应返回等待真实新事件/复用结论，不再发几百次相同 Review。真正出现新 PR HEAD、CI 结果或 REVISION 才重新固定目标审查。

## 4. 契约与并发负例（需在 Plan Review 通过前逐条反驳）

1. Stop visible 无限存在：不消耗新 Send、能以有界事实退出，并且提示精确 UI 阻塞；不能“degraded but considered done”。
2. Stop 恰好消失：prepare 状态改变后继续 same effect，不双发。
3. Stop click 后崩溃 / response unknown：账本要区分旧生成取消与新 Send；不能将仅取消旧生成当作新消息已应用或可无条件重放。
4. 旧 effect 回复晚到：优先识别原 completion，不产生竞争的 recovery 子消息。
5. 精确标签页 URL、ownerToken、providerSessionId、windowId 或 tabId 任一变：拒绝 mutation，不能偷切别的 Tab/Profile。
6. 两个 Chrome Profile 同 URL：只认原 pin；ambiguous 不是选当前前台。
7. `COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED` 与 NativePort heartbeat 间歇：不能凭单次成功 inventory 宣布可发送。
8. `browserBeginEffect` CAS 失败 / 已有 dispatch：新执行者不能追送。
9. 普通 non-recovery 工作生成中：不得自动 Stop 老回复。
10. Applied-but-uncompleted 祖先：正式 migration 必须拒绝，不得换会话消除旧 causal obligation。
11. 相同 PR HEAD/CI 反复 poll 20 次：只读复用结论且不花费 20 次模型审查。
12. 有效非代码 Work、真实 WAIT、性能分析阶段：不能“Git diff 为零”就误报失败。
13. 多任务共享 Provider lane：一个 target 的 task-local 失败不应拖垮其他任务；但必须保持 Send 串行保护。
14. Runtime 重启前后同一效果：exactly-once 与 C→C→D 的凭证严格保持，任何 unknown 永不变为自动重发。

## 5. 测试与验收计划

**现有测试优先**，在遵守 AGENTS.md“不默认新增测试文件”的条件下，核对/必要时定向扩充：`tests/runtime/workflow-supervisor-control-plane.test.ts`（Stop pending，迁移 guard，recovery），`tests/runtime/computer-interaction-target.test.ts`（精确 profile/tab/target），`tests/runtime/workflow-supervisor-duplicate-failure.test.ts`，`tests/runtime/workflow-supervisor-automation-receipt.test.ts`（C→C→D），`tests/runtime/execution-quality.test.ts`。`bun test`、TypeScript、architecture check、diff 检查以最终相同 change set 的必要命中路径为准；对已证明不变条件复用旧结果，不重复全量 Gate。

真实 Live 产品验收：Windows Chrome exact original target 恢复同一 Work 的首次有效源码变更/提交，自动至少 CONTINUE→CONTINUE→DONE，期间至少一次合法 Runtime restart/reconnect，证实原 effect/最终 completion 对应、无人工注入 C 结算；固定 HEAD 的独立 code Review 与 CI 之后由唯一 Writer 安全集成，并在 active Runtime 做真实结果验证。Reviewer 在没有 HEAD 差异时确实进入 WAIT/event driven，不继续无限消耗。

效率 A/B 基线需可比，最少 3 个真实源码交付任务，尽可能保持依赖和验收条件相同；测 `time_to_first_material_change`、无效前奏、完整交付 wall-clock、成功率、重复外部副作用。目标前三者**至少下降 30%**，成功率不下降、重复副作用**0**。若历史缺足够样本则标记不可比较，补同条件对照，不得造数据。PR/Plan static ACCEPT 本身不算达到任何性能目标。

## 6. Review / 迭代顺序（现阶段最重要的 Gate）

1. **本 PR 仅为文档提案，Draft**，固定本 PR HEAD 与 Forge Plan r4。它不修改任一 src/、tests/、runtime、Scheduler 或旧 Writer effect；不能 merge 当作代码修复。
2. **Reviewer A：独立 ChatGPT 会话**，审 `supervisor/store.ts` 因果链 / Stop+Send 单 writer / unknown effect / release rollback。回答：真实可安全恢复路线是否足够具体？是否有更简单方式？给出 `ACCEPT/REVISE/BLOCK` 与文件:函数证据。
3. **Reviewer B：与 A 不同的独立 ChatGPT 会话**，审 Thin 架构、Plan r3 旧 S0–S4 混合、文件级范围、非代码 Work、Review 去重、30% 对照可比性、对现有 AGENTS.md 的符合性。给出独立 `ACCEPT/REVISE/BLOCK`。
4. 任一 `REVISE`：由同一 Plan 作者改原 Forge Plan 和同一文档 PR，固定新 HEAD；两位 Reviewer 对**新候选**复审差量/受影响全局。不因“已评论”视作 ACCEPT；同一 HEAD 无新证据不重复计数。
5. **双 ACCEPT + 必要 Docs CI** 才可解锁下一阶段原唯一 WSL 源码 Writer 的实现。原源码 Work 与原 Git dirty P0 保持，不再建第二源码 Writer。#465 Interaction 改造的 Plan Review 不自动替代 #313。
6. 实现是**另一个唯一源码实现 PR**（与设计 PR 不混，且不复制成多个实现 PR）；固定 HEAD 独立累计 Review/CI 后才能 merge。Runtime 激活与真实 C→C→D 是 merge 之后单独验收。
7. Reviewer/Source Writer 当前在途 Effect 无可证实完成时，不额外创建会话权威；若审查工具接口失配或 Reviewer 不可用，应明确 BLOCK 原因，不冒称审查完成，也不回头开始源码试错。

## 7. 危险路径与回滚

任何基于新逻辑的候选产生 `unknown` external mutation 后，仅持久化原 effect 及同 target 的只读对账；不重发，不清库，不改历史 completion。文档方案若未获同版独立 ACCEPT，不实施。源码候选若首次负例不通过，先固定最小证据、分析旧假设，不叠加恢复门槛。若安全性/性能无法兑现，在原 Plan 上 REVISE 或回滚同 PR 相关改动，ReleaseSession/Recovery 独立许可后才恢复已知稳定 Runtime。

---

**冻结索引（待 reviewer 使用）**：

- 原 Plan：`PLAN-forge-thin-delivery-efficiency-code-slimming-20261019` r3
- 原唯一源码 Work：`work-forge-source-bug-convergence-v1`
- 原唯一源码 Writer：`supervisor:d09f4e6bb4014a894db105ec`
- 原待发送 effect：`fx_170155dcd5cfe2a220238aff61d04f20`
- Issue #313：<https://github.com/moretea-labs/forge/issues/313>
- 本 PR：只审设计，**未实施、未合并、未完成自动推进修复**。
