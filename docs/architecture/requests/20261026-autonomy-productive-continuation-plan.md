# Forge #313 — 自动续跑、可靠投递与有效产出（Plan r7 审查稿）

> **DESIGN ONLY · Draft PR #468 · 尚无本候选独立 ACCEPT · 禁止生产源码实施。**
> 本文须与唯一 Forge Plan `PLAN-forge-thin-delivery-efficiency-code-slimming-20261019` **r7** 和本 PR 当前完整 HEAD 同时审查。历史 r4/r5/r6 的 REVISE 不是本候选 ACCEPT。评审冻结后任何修改都必须重新以新 HEAD 审查。

## 0. Authority、优先级与成功判据

- **唯一生产源码 Writer：** Windows WSL2 `/home/greyson/src/forge`, repo_id `repo_f37fe508f6e8dabb8fe607e4`，原 Supervisor `supervisor:d09f4e6bb4014a894db105ec`，原 Work `work-forge-source-bug-convergence-v1`。Mac 只做只读 Review、远程维护和独立 E2E，绝不恢复 Mac 源码 Writer。
- **源码审查快照：** PR base `2cc71021db0a291037c4755dc04ce9c1884417e6`；WSL checkout 上另一个 P0 原 Owner 有未提交 `src/cli/controller/launch-agents.ts`，不允许该设计 PR 或新实现 PR 触碰。
- **当前优先交付 P0–P2：** 原 Writer 的合法发送/Provider 诊断/真实来源修改；**P3–P4** 是同一 Plan/Work 中后续独立实施切片，仍须解决自动发现低产出问题，但不得假装现有组件已经支持全部信号或自动唤醒。历史 **S0–S4** 的 Mac/WSL sync、GPU/Ollama、代码瘦身是*保留的非阻塞后续目标*，不能覆盖本次优先级或授权 Mac 写 Forge 源码。
- **最终成功**不是 Reviewer CONTINUE、Runtime READY 或 PR 评论：原 WSL Writer 完成真实 Work 的 CONTINUE→CONTINUE→DONE、可归属的第一笔有效源码修改、固定 HEAD Review/CI、安全合并、Recovery 下真实 Runtime 验收；3 个可比工程任务的首有效修改/无效前奏/完整交付时间目标均下降 ≥30%，成功率不降，重复外部副作用 = 0。缺少可比历史样本时必须写 **IMPROVEMENT NOT PROVEN**，不捏造数据。
- **架构禁止项：** 新 Kernel Planner/独立任务大脑、新 Work/Plan/Supervisor、新进度数据库、新 browser fallback 或 profile 自动切换、第二源码 Writer、未知 Send 重发、为这次修复新建多份实现 PR。遵守 `AGENTS.md` 的 Forge-source PR continuation 与现有 ADR。

## 1. 事实基线与必须保留的不确定性

| 事实/证据 | 可证明的结论 | 不能由此推断 |
| --- | --- | --- |
| 原 Writer 待发送 `fx_170155dcd5cfe2a220238aff61d04f20`，`recovery/send/generation 1`，无新的 dispatch_started/applied | 这一条原效应仍未观察到实际 Send | 旧生成已结束、其五个 applied 祖先已经结算 |
| 五条已 applied、未取得有效 completion 的历史 effect | `supervisor/store.ts` 的 `appliedEffectAwaitingCompletionWithin` 会阻止直接会话迁移 | 可清空 ledger、用新会话重发 |
| 原 Writer 曾报 `COMPUTER_CHATGPT_EXTENSION_NOT_CONNECTED` | 目标 Provider 的某次准备/连接不可用 | Chrome 本次确实有 Stop；一定是心跳造成 |
| 2026-10-26 00–09Z 原 Reviewer 218 `TAB_MESSAGE_TIMEOUT`、2 `RECEIVER_TARGET_CHANGED`、2 `NOT_CONNECTED`；Writer 1 `NOT_CONNECTED` | Reviewer 消费了大量执行时间而 Writer 没有交付；需要按不同错误类型定位 | 218 次 Timeout 与 Writer 的 NOT_CONNECTED 必为同一根因；全部是同 HEAD 无效 Review |
| Mac Codex r6 双独立 Reviewer A/B REVISE，固定 HEAD `45e17d7` | r6 没有达到设计 ACCEPT；需 r7 修订重审 | r7 因作者修订自动变为 ACCEPT |

基准 ADR：`docs/architecture/decisions/20261001-supervisor-turn-authority.md:212–220` 明确 **恢复绝不授权停止仍在运行的生成**。Provider 正在生成一小时也不是旧效应可取消的证据。当前 live Writer 的 DOM/Stop 状态、Extension 构建版本、具体 claim/heartbeat 尚无独立可信现场证明；在 P2 实测前，Stop-pending 属于*源码支持的故障假设*，不是已确诊现场根因。

## 2. P0：一张只读因果账本，不新增数据库

**落点：** `supervisor/store.ts:178,1722,1785,1866,1941`；`supervisor/control-plane.ts:migrateConversation/browserPoll`；`supervisor/server.ts` 已存在的只读查询；Computer Target Authority 绑定。

从唯一 Controller Home 现有 SQLite 只读投影，为五个应用祖先逐条列出：`effect_id`、kind/origin、已记录 dispatch generation、applied receipt、原 valid completion 或 completed recovery child、unknown/未结、所属精确会话/物理 tab、允许的下一操作。另列当前未发送 `fx_170155...`。该矩阵是评审与操作诊断材料，不是新持久状态或第二 Authority；旧数据可能有晚到完成回执，实施之前只读刷新。没有真实回执不补写“已完成”，不得移除迁移拒绝条件。

## 3. P1：合法、有限、能说明真实阻塞的恢复链

**目标修改文件/函数：**

1. `adapters/computer/chrome-extension/content.js:dispatchPrompt(mode=recover)`：移除当前先于草稿所有权检查的 `stop.click()` 行为。**Prepare 与 Dispatch 都检查精确 tab 上可见 Stop/真正 live generation；有则立即拒绝并且零 Stop、零 editor 写入、零 Send。** 历史 user-only turn 与真实直播信号必须区分；Stop 消失但旧回复未 settled，不得误判已可新 Send。保留既有 profile/tab/草稿/URL fail-closed 检查。
2. `supervisor/native-browser-adapter.ts:executeCommand`：保留 `provider_recovery_stop_pending` 的 prepare 早退；仅增加已有的 `noteTaskFailure('WORKFLOW_SUPERVISOR_RECOVERY_WAITING_LIVE_TURN', task, effectId, false)`，不产生重复 event、不扣预发送失败预算、不新设终态。
3. **关键 CAS 时序：** `supervisor/native-browser-adapter.ts:withChatgptProviderDispatchLane` 内，在第二次 `browserPoll`、新鲜 `target.observe` / exactConversation 确认之后，**调用 `browserBeginEffect` 之前**也要检查恢复任务的 `ready.isGenerating`（由 Chrome 现有 `hasLiveGenerationSignal` 在精确观察中派生的真实 live/Stop 信号）；若仍 live，就以只读结果离开，不发消息、不进入 begin/不产生新的 generation，也不退款。正常旧父效应完成与 recovery CAS 仍在 `supervisor/store.ts` 同一事务内竞争，禁止双 successor。
4. **CAS 之后又恢复 live 的竞争：** content.js 终端检查继续拒绝，确保零 Stop/editor/Send；但 `effect_dispatch_started` **可能已经存在**，此时严禁声称“零 generation”。只有真的收到可信 `not_attempted` 证据才能走既有 `browserObserveDispatchFailure` 与 generation budget-refund；Native/claim/Send outcome 不明只读 reconcile，绝不能自动重发。
5. `src/runtime/root/workflow-supervisor-runtime.ts:reportTransportState`：沿用原 per-task failure 和约 30 秒已有降级投影。对 `WORKFLOW_SUPERVISOR_RECOVERY_WAITING_LIVE_TURN` 显示可操作的代码专属理由“原会话仍在生成，按既有 ADR 不自动 Stop，需等待 settled/failure 或经原 Owner 明确处理”，**不显示“auto-recovering”或伪造 NEEDS_USER/terminal**。Transport degraded 是观察，不是 C→C→D 成功。
6. **合法进展条件：** settled idle assistant 或有真实 explicit provider failure，在同一 exact-target/同原 effect`browserPoll→browserBeginEffect CAS→唯一 Send`；未知外部 Send 仍拒绝重放。**真实 live turn 下自动恢复可能仍然无法完成，这是安全要求的可解释 WAIT，不是对用户保证全自动取消旧生成。** 五个已 applied 祖先没有合法完成之前，会话迁移仍被禁止。

## 4. P2：Provider 投递诊断先于改动

**候选落点：** `adapters/computer/chatgpt-extension-target.ts:freshProviders/ensureExact/submit`，`adapters/computer/chrome-extension/background.js:tabMessage/providerTick/heartbeatTick/nativeRpc`，`supervisor/native-messaging/host.ts`。

只读收集同一 Writer 的 pinned `providerSessionId/windowId/tabId`、Chrome profile、真实 Extension build、command ID、是否 claimed、claim/超时/回复时间、last heartbeat 与 receiver hydration；验证背景 `tabMessage` 的约 7s deadline 和 Provider 新鲜度窗口。Reviewer 的 `TAB_MESSAGE_TIMEOUT` 与 Writer 的 `NOT_CONNECTED` **先分别分析**，不能未经验证宣布共同根因、直接延长超时、增密轮询或启动 fallback。只有在实际日志证明某个最窄路径故障后才允许原 WSL Writer 在该文件修改。

## 5. P3：有效产出检测，不把 Activity 冒充 Progress

**状态：同 Plan 后续切片；实施 P1/P2 并取得首笔真实产出后再设计验证和编码。** 现有源码边界：

- `supervisor/types.ts` / `supervisor/store.ts`：`WorkflowSupervisorTask.completionContract.repo_id/work_id` 仅在明确绑定时是可信 Task→Work 标识，未绑定视为 `coverage=unknown`，不能从 Objective 文本猜 Work。
- `src/runtime/root/workflow-supervisor-runtime.ts:383–413,467–469`：已有按 Work context 读取 `getWorkContract` 的只读装配路径，是后续 advisory 的**候选消费者**；需先确认该 Work 可提供带归属、带时间戳的真实 Process/Git/PR/evidence refs。
- `packages/kernel/controller/domain/execution-quality.ts:deriveExecutionQualitySignals` 的输入是 ControllerRound；既有消费者 `controller-round-store.ts:795–801`，**不能直接说它已经统计 Supervisor 产出**。
- `src/runtime/control-plane/execution/work-evidence-policy.ts:evaluateWorkImplementationEvidence` 只判断当次 Work 的 `repository_change`，被 `goal-workloop.ts:1247–1266` 用于 Work 转换，**不是每 Work 的首次修改时间或非代码交付指标**。

后续只读 coverage audit 先判哪项可靠：`activity_count`、`last_material_delta_at`、`time_to_first_mutation`、相同错误指纹、Work 类型、真实外部等待。没有 timestamp/可归属的 artifact → **UNKNOWN**，不是 0。若真实 producer/consumer 未明确，则 P3 只能保持未完成，不能添加第二数据库、独立 Plan 大脑、任务状态机或假冒低效自动提醒。任何已有事实驱动的建议由**同一个模型 Owner**判断路线并检查下一轮是否真出现物质性增量。

## 6. P4：Review 去重先是可执行的模型制度，不是假自动唤醒

`src/runtime/root/workflow-supervisor-runtime.ts:reconcileReviewNotices` 负责约 30s 低成本 GitHub read-only 观察。`supervisor/control-plane.ts:observeReviewNotice` / `supervisor/store.ts:recordReviewNotice` 持有现有同 PR/reviewId/HEAD/outcome 去重事实，但返回 `deferred:true`，**不会发新 effect、唤醒 Reviewer 或阻止模型重复 CONTINUE**。

因此本次 P4 的合法首步是**原 Reviewer 行为规则**：没有新的 PR HEAD、Plan revision、CI、实质 Finding/外部事件时，使用既有审查结论返回 WAIT，不再主动消耗重复模型回合；后续由原 Writer 新候选或手工授权唤醒。它还不是自动化实现/自动化测试通过。只有发现现成的合法 reviewer-turn admission 可消费上述事实，才可设计真正自动的事件唤醒；严禁新增 review scheduler/table/替模型执行的第二脑。重复无效执行 2–3 次由 Owner 记录单次诊断、下一可验证产出，不在同一旧指纹上无限修改 Plan。

## 7. P5：定向测试、负例和真实验证

优先在**已有测试文件**做定向补充：`tests/runtime/workflow-supervisor-control-plane.test.ts` 的 Stop-pending 旧测试、`tests/runtime/computer-interaction-target.test.ts`、`tests/runtime/computer-chatgpt-extension-preflight.test.ts:805–818`、`tests/runtime/workflow-supervisor-duplicate-failure.test.ts`、`tests/runtime/workflow-supervisor-automation-receipt.test.ts`。P3 证据链真实接入时再使用 `execution-quality.test.ts`。现有 Gate 同 change set 复用，不增加无必要套件。

须至少区分：**CAS 之前** live Stop → 无 Stop/editor/Send/dispatch-start；**CAS 之后** Stop 突现 → 页面零修改但可能耗费 dispatch generation，按可信 not-applied vs unknown 对账；旧 valid completion 在 begin CAS 前/后竞争；Send clicked 回执丢失绝不重发；错 tab/profile/草稿 fail closed；五个已 applied 祖先不得非法迁移；Runtime restart 下原 effect 没有重复副作用；已 settled/provider failure 才允许唯一恢复。30s 诊断要可见但不伪装为自动修复。P4 WAIT 目前只按模型制度人工/原任务证据核对，**不能写“自动 stop reviewer loop”测试并声称通过**；非代码 Work/外部 WAIT 不能被 Git diff 零错误定性。

验收先做到真实 Windows Chrome original-source Writer C→C→D、第一笔有效源码修改、Git/PR fixed HEAD Review+CI、授权唯一集成和独立 Recovery 发布。三组可比 A/B 仍追求首修改/无效前奏/完整交付 >=30% 降低，成功率不降，重复作用零；不可比则仍 OPEN 且明确“不具备改善量化证明”。

## 8. P6 / P7：固定版本两名独立 Reviewer → 原 Writer 实施

现有 PR #468 只含本文 docs；此前固定版本意见：r4 Windows Codex A REVISE（[6413904259](https://github.com/moretea-labs/forge/pull/468#issuecomment-6413904259)），r5 Mac Claude B REVISE（[6414169206](https://github.com/moretea-labs/forge/pull/468#issuecomment-6414169206)），r6 两个不同 Mac Codex 会话 A/B REVISE（[6414528933](https://github.com/moretea-labs/forge/pull/468#issuecomment-6414528933)、[6414507281](https://github.com/moretea-labs/forge/pull/468#issuecomment-6414507281)）。**这些旧候选没有给 r7 授权。**

1. 本 PR 固定最新 HEAD 与 Forge Plan r7 → 由两个不同已授权 ChatGPT/Codex/Claude **只读会话**分别审因果安全和 Thin/交付完整性；每个给出 `ACCEPT/REVISE/BLOCK` 和 source filename:line 证据。未运行/超时/评论数都不算 ACCEPT。
2. 任一 REVISE → **同一个 Plan、同一个 PR** 原地修订，固定新 HEAD 再审，不新建工作流或无限审同 HEAD。
3. **两份当前固定 HEAD 的 ACCEPT + 必要文档 CI** 才允许现有 WSL 唯一源码 Writer 在原 Work 进行 P1/P2 最小代码实施；它的原未结 effect 和五个已应用祖先不得越过防重放护栏。P3/P4 后续片段不自动授权。
4. 源码实现仅一个新的 #313 实现 PR（与独立 #465 无关）；固定 HEAD 独立 Reviewer ACCEPT、必要 CI、原唯一集成 Owner 合并，Recovery 批准更新 Runtime，完成实际有效修改/零重复副作用/性能可比验收。文档 PR 本身从不等于 Runtime 发布。

## 9. 回滚与禁止路径

不因 Gateway 工具表指纹失配换不稳定 Runtime；不因 Mac/WSL 任一连接超时重复发送已可能产生副作用的原效应；不因检测到 Stop 擅自终止旧回复；不抹除旧 completion，不降低 applied ancestor 会话迁移拒绝；任何未知 Send 先同原 exact target 只读 reconcile。模型纠偏必须验证下一次真实产出，失败返回原 Plan 的 REVISE 或同一个实现 PR 修复，而非新 Scheduler/Layer/Plan/Writer。

**冻结标识（审查时以 GitHub 当前 HEAD 为准）：** PR #468 / canonical Plan r7 / Git base 2cc71021d / 原 Writer supervisor:d09f4e6bb4014a894db105ec / 原 Work work-forge-source-bug-convergence-v1 / 原待发送 fx_170155dcd5cfe2a220238aff61d04f20。