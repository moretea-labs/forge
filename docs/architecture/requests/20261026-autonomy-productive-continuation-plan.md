# Forge #313 — 自动续跑、可靠投递与有效产出（Plan r10 审查稿）

> **DESIGN ONLY · Draft PR #468 · 尚无本候选独立 ACCEPT · 禁止生产源码实施。**
> 本文须与唯一 Forge Plan `PLAN-forge-thin-delivery-efficiency-code-slimming-20261019` **r10** 和本 PR 当前完整 HEAD 同时审查。历史 r4/r5/r6 的 REVISE 不是本候选 ACCEPT。评审冻结后任何修改都必须重新以新 HEAD 审查。

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

## 3. P1：唯一恢复效应 + 精确内容脚本能力确认（r8 首要修订）

安全权威：`docs/architecture/decisions/20261001-supervisor-turn-authority.md:212–220` 明文禁止恢复时自动 Stop 正在生成的旧回复。源码已有 `content.js:244` 的 stop.click，与此契约不符。实施仅由原 WSL Writer 在双 ACCEPT 后进行。

- **旧版脚本不能假冒安全实现**：当前 `background.js:445–505` 已有向 exact tab 发送 `forge-computer-chatgpt-capabilities` 的路径，但主要用于 bootstrap/草稿替换。对普通 conversation recovery **在 executePrepare 与 executeDispatch 两处**都要求原精确 tab 当前加载的 content script 返回 `recover-no-stop-prewrite-v1`。旧/缺失/错误版本在调用内容脚本变更前即拒绝；仅背景 service worker 更新不代表 tab 脚本更新。复用此消息与现有 typed 结果，不添第二 Provider、数据库或认证权威。
- **content.js:dispatchPrompt(recover)**：删除自动 `stop.click()`；调用 `writeComposer` **之前**检查 visible Stop / live generation、exact identity、草稿归属；不安全即零 Stop、零 Editor 写入、零 Send。写入后 React readiness/Send 之前若重新变为 live：仍禁止 Stop/Send，**但可能已写入恢复草稿**，必须如实报告 Editor-touched，而不是声称页面完全没改动。
- **真正的未执行证明**：`background.js:executeDispatch` 不能再将所有 `dispatched:false` 无条件转换为 `mutation:not_attempted`。只有完成上述 exact-tab 能力证明且内容明确回复 pre-write/pre-click 失败，才可产生 no-mutation 负面证明、沿 `native-browser-adapter.ts:browserObserveDispatchFailure` / `supervisor/store.ts` refund。发生 Editor 改动、旧 script 版本不明、Send/Native claim 结果未知时保守记录 attempted/UNKNOWN，只读 reconcile，绝不盲重发。
- **两次 live 检查的因果边界**：`supervisor/native-browser-adapter.ts:executeCommand` 保留 `provider_recovery_stop_pending` 早退；加原有 `noteTaskFailure('WORKFLOW_SUPERVISOR_RECOVERY_WAITING_LIVE_TURN',task,effectId,false)`。第二次检查在现有 `withChatgptProviderDispatchLane` 内、fresh exact `target.observe` 后且 `browserBeginEffect` CAS **之前**：若真正 live，就零 Stop/Editor/Send/dispatch-start，不生成新 generation。**CAS 之后**才出现 live 则 generation 可能已消耗，Editor 也可能变化；不能再宣称“零 generation/零 Editor”，需按已证实负面结果或 UNKNOWN 对账。
- **可解释但不伪造成功**：现有约 30s 的 per-task transport degraded 投影只给这条代码具体 WAIT/原 Owner 操作理由，不能笼统说 auto-recovering 或制造 NEEDS_USER/DONE。只有旧回复 settled idle 或明确 Provider failure 后，原 effect 才能在 CAS 下 Send 一次。Stop 缺失并不单独证明已结束；五条旧 applied 祖先、late completion 与未知外部 mutation 仍按原账本保护。

### P1.1 内容脚本负面证明回执：必须有类型、有身份、有明确阶段

本条是 r9 独立因果安全 Reviewer A 的 P0 REVISE 修订，详见 [6415169634](https://github.com/moretea-labs/forge/pull/468#issuecomment-6415169634)。目前 `background.js:505` 会把任意 `dispatched:false` 当成 `mutation:not_attempted`，`supervisor/control-plane.ts:744,750` 的 `browserObserveDispatchFailure` 又记 `pre_send_rejection:true`，`supervisor/store.ts:1929` 可能据此退还 generation。**因此仅凭布尔 `dispatched:false` 不得退款。**

在原 Native command、Computer Target 与 Supervisor effect 之间定义**唯一类型化负面证明**（下列是待审的新源码契约，不是声称现已存在）：

```text
kind: prewrite_no_mutation_proof
instanceId + commandId: match original claimed Native/Extension command
providerSessionId + profile/window/tab/owner binding: match the exact pinned target
loadedCapability: recover-no-stop-prewrite-v1 (attested at prepare AND dispatch)
phase: content_script_prewrite_or_preclick
reason: closed set of reasons proven before ANY mutation
editor_touched: false
stop_clicked: false
send_clicked: false
effectId + dispatchGeneration: verified at Supervisor boundary against original CAS
```

- **正面授权边界：** 只有当前已加载、已确认版本的内容脚本在**尚未改动任何页面/草稿或点击按钮**时，才能返回上述证明。后台必须验证该回复属于相同已 claim 的 `instanceId + commandId`、同一 exact profile/tab/owner；Target Adapter 保留并传递原命令关联，Supervisor 只对**匹配的 effect + generation**按现有幂等账本记一次已证实的 `not_attempted`，调用 `browserObserveDispatchFailure` 退还一次预算。
- **反面边界：** 目标查找失败、加载内容脚本陈旧/版本不明、Prepare 与 Dispatch 间换版、Native/receiver 超时、无效格式、claim 不可验证、任何 `editor_touched:true`、Stop/Send 可能已点击或新消息提交结果未知，都不具备上述负面证明。不得从 `dispatched:false` 降级猜成 `not_attempted`；保留 attempted/unknown、仅只读 reconcile，绝不再次 Send。
- **竞态解释：** 若恢复在 `browserBeginEffect` **之前**因 live/Stop 被拒绝，则没有 dispatch-start，本来就无需 refund。若 **CAS 之后**内容脚本给出完整、同代次写入前负面证明，才可能合法 refund；CAS 之后若草稿已写入或回执丢失，不能退款，也不能承诺 generation 从未消耗。**同一旧 generation 的证明不得退还较新代次。**
- **不扩权：** 不新增 Effect Writer、认证 Provider、持久状态库或替代迁移通道；仅在原有 `content.js → background.js → chatgpt-extension-target.ts → native-browser-adapter.ts → control-plane.ts/store.ts` 证据链做最小 typed result/验证。

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

## 7. P5：定向验证与真实验收

只在既有 `tests/runtime/workflow-supervisor-control-plane.test.ts`、`computer-interaction-target.test.ts`、`computer-chatgpt-extension-preflight.test.ts`、`workflow-supervisor-automation-receipt.test.ts` 必需的位置补充测试，不增加通用新套件。测试必须明确区分三个阶段：

1. PRE-CAS live：同一精确 tab 上没有 Stop/Editor/Send/dispatch-start；30s 后只有真实降级提示，不等于 DONE。
2. POST-CAS、PRE-WRITE live：可能已有 dispatch generation，但通过**已证明加载的新 content 能力**，零 Stop/Editor/Send；任何真正的退款必须有可信 pre-write/pre-click negative proof。
3. POST-WRITE live：generation 与 Editor 草稿可能已变化，仍不 Stop/Send；必须如实记录 Editor touched，不能以 `not_attempted` 伪造无页面变更，也不能直接重发。

补充 r10 类型化负面证明测试：旧/缺失能力、不同的 prepare/dispatch 加载脚本、错 profile/tab/owner、错 instanceId/commandId、非法 reason、格式错误、接收超时、post-write provider_busy 或 editor_touched 都不产生 not_attempted/refund/重复 Send；有效同命令同代次 prewrite_no_mutation_proof 才退还对应 generation 恰好一次，旧代次不能退新代次。

额外负例：旧 content.js + 新 background 的版本组合；能力接口缺失/过期；同 tab 的 Prepare 通过但 Dispatch 时加载不同代码；错 Profile/Tab、陌生草稿、晚到 parent completion、五条已 applied 未完成导致迁移拒绝；Native 发送/响应未知跨 Runtime 重启零重复外部副作用。只有 settled idle/provider failure 可以单次恢复。P3/P4 后续片段不得假装当前已有自动 Reviewer wake。真实 Windows Chrome 原 Work C→C→D + 有效源码修改 + 固定 HEAD 审查/CI + Recovery 授权发布；三组可比 A/B 30% 目标缺可比证据则保留 IMPROVEMENT NOT PROVEN。

## 8. P6/P7：双独立设计 ACCEPT 只授权 P1/P2 实施

**当前只是 r10 / #468 Draft 的候选，0/2 独立 ACCEPT。** 历史 r9 因果 Reviewer A REVISE、Reviewer B 超时无结论，均不能跨版本计票（[6415169634](https://github.com/moretea-labs/forge/pull/468#issuecomment-6415169634)）。 历史 r4–r7 均有独立 REVISE，最近 r7 两份固定 HEAD 证据见 [6414844309](https://github.com/moretea-labs/forge/pull/468#issuecomment-6414844309)。

- **实际 Plan r10 依赖字段（无环）：** `P0 → P6（仅设计双独立审查）→ P1/P2 代码实施 → P5 验证`；P7 在 P6 批准后才取得唯一 Writer 交付授权。P6 不再以 P1/P2/P5 的代码完成为前置。P3/P4 仍是同 Plan/Work 最终有效产出和自动审查治理的必交付切片，但不阻塞本次 P1/P2 安全恢复。
- **P6 依赖是设计前置，不是代码完成：** P0 因果矩阵、P1/P2 的路径和安全契约、P5 测试设计接受审查；P3/P4 是后续非阻塞实施切片，P5 测试的实际执行也不是 P6 的设计 Review 前提。
- 两个**不同**独立只读模型会话必须审查同一个原 Plan r10 与同一个 #468 固定最新 HEAD，并各给 `ACCEPT/REVISE/BLOCK` + 精确源码行证据。任一 REVISE 只能返回原 Plan/同 PR，新 HEAD 重审，不允许把旧版 ACCEPT 转移过来。
- 双 ACCEPT + 必要 docs CI 才允许原唯一 Windows WSL2 Writer 在原 Work 上修改 P1（no Stop、exact tab script attestation、负面证明）与证据证明必要的 P2 最小传输路径，之后按 P5 运行测试/Live；**P3/P4 没有因此被授权提前实施，也不能反向卡住 P1/P2**。
- 源码实现为同一 #313 任务下的一条代码 PR，和 #465 分开；固定 HEAD 独立源码 Review/CI、唯一集成 Writer 合并、Recovery 真实发布、零重复外部副作用。Mac 只负责只读 Review/原生 E2E，不持有 Forge 源码写入权。

## 9. 回滚与禁止路径

不因 Gateway 工具表指纹失配换不稳定 Runtime；不因 Mac/WSL 任一连接超时重复发送已可能产生副作用的原效应；不因检测到 Stop 擅自终止旧回复；不抹除旧 completion，不降低 applied ancestor 会话迁移拒绝；任何未知 Send 先同原 exact target 只读 reconcile。模型纠偏必须验证下一次真实产出，失败返回原 Plan 的 REVISE 或同一个实现 PR 修复，而非新 Scheduler/Layer/Plan/Writer。

**冻结标识（审查时以 GitHub 当前 HEAD 为准）：** PR #468 / canonical Plan r10 / Git base 2cc71021d / 原 Writer supervisor:d09f4e6bb4014a894db105ec / 原 Work work-forge-source-bug-convergence-v1 / 原待发送 fx_170155dcd5cfe2a220238aff61d04f20。