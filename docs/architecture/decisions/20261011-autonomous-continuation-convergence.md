# 自动推进端到端架构收敛设计

Status: R0 REVIEWED; G0a LIVE FORGE TOOL PASS; D1/D2 SOURCE CANDIDATE; G0b/G4 AND R2–R4 NOT YET ACCEPTED
Date: 2026-10-11
Owner: ChatGPT (semantic decisions) / Forge Controller (mechanical durability)
Scope: Workflow Supervisor → Computer exact-conversation delivery → ChatGPT Forge App receipt

## 0. 用户目标与必须遵守的设计纪律

最初目标只有一个：长期任务在已登录 ChatGPT 中持续执行，模型调用 Forge 干活，按 CONTINUE / DONE / NEEDS_USER 决定下一轮；不需要用户反复输入“继续”。目标不是构建第二个模型、第二套 Task/Work 状态机或第二套 Browser 业务执行架构。

本次必须先通过可行性证明，才允许生产代码迁移；在同一个原始 Work 中一次性迁移所有调用者并删除旧 writer/旧恢复路径。Review 穿插于设计、契约、完整 changeset、发布、真实验收五个边界。发现新的错误先核对本文件的设计责任和唯一 authority，不允许症状驱动地新增 manager/state/retry/refund。仅主线真正被独立缺陷阻塞时才将其纳入本范围。

## 1. 当前事实基线与不能误判的地方

已查证的生产源码：
- supervisor/store.ts 是 Supervisor Task/Effect/Completion 和 append-only journal 的现有唯一持久 owner，包含 generation、未知结果对账、发送前失败证据。
- supervisor/control-plane.ts 持有任务 enrollment、会话迁移、完成 validator、因果后继 effect。
- supervisor/native-browser-adapter.ts 混入了物理 tab/target 发现、恢复、provider 发送与节流：这些职责必须移走，不需要创建新的 Supervisor。
- packages/plugin-runtime/computer/conversation-target.ts 已定义 ComputerChatgptConversationTargetPort（ensureExact / openBootstrap / promoteBootstrap / prepare / dispatch / observe）。这是现成唯一 transport contract，而不是待新建的第二层。
- adapters/computer/chatgpt-target-router.ts、chatgpt-extension-target.ts、chrome-extension/{background,content}.js、src/runtime/plugins/computer-chatgpt-macos-target.ts 是现有机械 provider。Chrome Extension 为主，Mac native 只能在可证明未发送的前提下兼容接管。
- src/runtime/root/controller-progression-composition.ts 对 Work-bound ChatGPT 已以 Supervisor enrollment 为主：不能笼统宣称 Work-bound 存在两个真实 writer。
- src/runtime/control-plane/launcher/chatgpt-work-continuation.ts 的 runStandaloneChatgptPrompt 有现存无 Work Schedule 调用者（src/runtime/workflow/schedules/engine.ts）。这条独立使用场景在本次范围外，不可凭名字直接删除。
- docs/architecture/decisions/20261001-supervisor-turn-authority.md 和 docs/architecture/CURRENT.md 已约定 conversation-stable Supervisor 与唯一 outer-turn effect authority。
- supervisor/protocol.ts 当前对 objective 使用 slice(0, 8_000)，存在确切静默截断风险。
- Chrome/Mac provider 已检查 app-mention-name=forge 与精确 app-mention-path；单纯文本 @forge 不证明绑定。现有测试不等于真实 Forge MCP 工具调用回执。
- 独立 Recovery 与 Browser Extension 的运行版本可能落后于主仓库源码；源码提交、canary 通过、Runtime 健康都不能等同于真实 continuation 成功。

早期的整个 Browser/Desktop 插件统一和 Swift sidecar 迁移讨论属于另一个产品级重构。本次不合并 Desktop Operator，不碰 TCC 权限架构、WSL/Cloud、无关 Work/Requirement 或 Avela 业务源码。

## 2. 不可协商的成功条件

1. 保存不截断的原始 Task objective、终止与用户边界。
2. 一个 Task 对应一个真实 exact conversation；同 Project 的两个 Task 也不抢相同物理 tab。
3. 首轮及后续每轮的完整 effect.prompt 经 UTF-8 字节数、字符数、SHA-256、结构化终止标记、effect marker、真实 Forge App chip 身份验证，发送前再次复验。
4. 只有 Supervisor 能授权 provider Send；对同一 effect 的一次 Send 最多点击一次。未知结果永不盲重发。
5. ChatGPT 真实执行 Forge 工具后产生有因果来源的 automation receipt；CONTINUE 原子预留唯一后继并无人操作继续，DONE 和 NEEDS_USER 经原有 validator。
6. Chrome tab 关闭、Extension worker、Runtime/MCP 重连后可凭 exact conversation 恢复；登录或授权是真正 UserRequest。
7. 首先隔离测试会话真实证明工具调用和 CONTINUE → CONTINUE → DONE，然后逐条恢复并验收既有 Forge、Avela iOS、Avela Android 三条 Task。三个业务任务不作为首轮破坏性实验。

## 3. 唯一 Authority 表

| 持久事实 / 决策 | 唯一 Owner | 禁止 |
| --- | --- | --- |
| Goal 和 Work 的语义完结 | Requirement / WorkContract、模型与现有 validator | Browser 根据文本擅自 DONE |
| 首次 Work 控制身份和准入 | ControllerSession / ControllerRound | 后续 ChatGPT turn 还从此处发送、充值 |
| 长期 Task、效果许可、effect、completion、terminal | Supervisor Store 现有 SQLite/journal | Scheduler/Provider 新建 effect 数据表 |
| 逻辑会话 Target 和受控恢复 | ComputerInteractionTargetAuthority | Supervisor 将 tab/window 视为 durable conversation |
| tab、Extension instance、AX/DOM handle | Computer provider ephemeral binding | 将这些资源写成 Task 语义身份 |
| ChatGPT UI prepare、真实 Send 与 readback | 一个 ComputerChatgptConversationTargetPort | 多个 provider 作为独立 writer |
| 模型推理、调用 Forge、是否 CONTINUE | ChatGPT | Forge 形成第二套 AI workflow |
| 发布/回滚 | 已有独立 Recovery / ReleaseSession | Supervisor 直接修改发布状态 |
| 必须用户介入 | 既有 UserRequest | 新增私有 blocker 记录 |

唯一 Work-bound 发送路径：

  Launcher / Scheduler / user → 首次准入和 Supervisor enrollment（不发送）
  → Supervisor 已持久的 effect 与 CAS send 权限
  → Computer.ensureExact / openBootstrap
  → Computer.prepare（验证真实 App 节点和完整 Prompt，绝不 Send）
  → Supervisor.recordEffectDispatchStarted
  → Computer.dispatch（再核对身份、全文、mark，最多一次 Send）
  → Supervisor.observe(applied | proven_not_applied | unknown)
  → ChatGPT + Forge MCP 工具执行 → causal completion receipt
  → Supervisor validates CONTINUE/DONE/NEEDS_USER
  → CONTINUE 时原子生成一个后继 effect

## 4. 现有接口收敛设计（不新增 Manager）

### 4.1 Computer Target

继续使用现有 ComputerChatgptConversationTargetPort，不创建 DeliveryCoordinator、RetryManager 或 ProgressionStore。

- ensureExact(conversationId, canonicalUrl)：首先验证 Controller 保存的精确 binding；失效则扫描实际会话；唯一匹配才 rebind；没有匹配可打开 canonical conversation URL，导航稳定后再从真实 URL 验证 /c/<id>。多个候选不猜测、不写入。
- openBootstrap(projectUrl, bootstrapKey)：仅为指定 Task 建立专属 tab；同一 Project 的另外一个 Task 不能借用这个 tab；Extension worker 重启仅可凭 Controller 中精确 provider binding 恢复。
- prepare(prompt)：允许本地草稿输入、真实 Forge App 选择和只读回查，不点击 Send、不修改 Supervisor 状态；失败必须能证明没有 provider mutation。
- dispatch(prompt)：只能在 Supervisor 先写 dispatch intent 后调用。再复验 exact conversation、prompt、marker、插件身份，然后至多一次 Send；返回 not_attempted、attempted confirmed 或 attempted unknown。
- observe()：Computer 只读提供 exact user-history marker、页面 assistant 文本、生成/登录状态；它**不拥有真实 Forge MCP 工具或 automation receipt 的判定**。真实工具和完成回执必须由现有 Supervisor automation_receipt RPC（supervisor/server.ts）及对应 Forge MCP 工具链按 Task/Effect 因果校验。只有 user prose 没出现不代表没有 tool-only completion。
- release/cleanup：仅清理物理 binding，不能删除 Task、effect 或重置未知提交的历史事实。
- Provider Router 仅选择机械 provider。只有严格 no-send 时才能 fallback；任何点击可能成功后的超时都是 unknown，不允许切换 provider 再发。

Supervisor adapter 中的物理 tab 恢复、窗口 ID/名称和 Extension worker 策略迁移回以上现有 TargetPort；Supervisor adapter 只保留 effect projection、消费者公平性/单 lane、发送权威调用和 observation 交付。实施时同时迁移所有调用者并删除原实现，不长期双轨。

### 4.2 Prompt 不能静默截断

- 删除 supervisor/protocol.ts 中 task.objective.slice(0,8000)。如有正式协议上限，入口必须明确拒绝超长 objective（OBJECTIVE_TOO_LARGE），不得悄悄裁剪；不自行重写用户原目标。
- 完整字节与 hash 应来自持久的 effect.prompt。编辑器输入后完整 readback，与排除已证明 Forge chip 展示字符后的 canonical 文本逐字相同；JSON goal.objective、首尾、effect marker、END marker 均需验证。
- 仅长度相同、包含 marker、只看片段或文本 @forge 都不合格。发送前最后一刻重查 app-mention-name、精确 app-mention-path、exact conversation URL、editor 全文。
- 发送后必须用历史中的唯一 marker 或其他可靠 provider receipt 确认 applied；真实 Forge 工具执行须单独使用 MCP causal receipt 证明。App chip 不等于插件调用成功。
- 不必另建持久 promptHash 表；可以对已存在的不可变 effect.prompt 计算并记录审查证据。过去已被截断的任务不凭新算法虚构原文。

### 4.3 发送、失败与有界恢复

| 事件 | 合法处理 | 禁止 |
| --- | --- | --- |
| Extension 未连接、tab 不在、插件未选、编辑器缺失 | no-send 证据，Computer 有界健康恢复，同 effect 等待 | 消耗 generation；无限 tick；新任务 |
| Send 前资源状态变化 | not_attempted、无 provider mutation | 发送截断文本 |
| 点击可能成功但链路中断 | unknown，原 exact conversation 只读对账 | provider failover 后再发 |
| user history 存在 exact effect marker | applied，等待 Forge tool/receipt | 重复 Send |
| 严格可靠负证明 | 同 effect 在原有预算内重试 | 不受限 refund/rearm |
| Runtime、tab 或 Extension 重启 | 恢复现有 Task/effect、重新 resolve binding | 重置 Task/send 额度 |
| 登录/权限失效 | 既有 UserRequest 与明确 UI 提示 | 当普通循环重试 |
| 长时 degraded | 既有 Activity/transport 投影，显示单一根因 | 每个报错码生成新状态机 |

现有 effect_preflight_rejected、release-specific limit、operator rearm/refund 逐项做调用者和故障注入审查。简化不得使自动重试变成无限；历史事件只读兼容，新的发送权威仍是同一个 journal。再次尝试必须有新的、可验证的 provider 健康变化证据并服从现有总预算。不得用 Runtime 重启本身重置上限。

### 4.4 并发与会话身份

一个 effect 任一时刻只允许一个 provider mutation owner；复用现有 Supervisor CAS、Computer Surface lease 和共享 provider lane，不发明另一把跨进程锁。一个逻辑 conversation 只有一个稳定 Task；tab ID、window ID、AX ref 不成为业务身份。所有已启动或结果 unknown 的旧 effect 在原 conversation 只读观察，不迁到新 conversation 重发。Observation backlog 不可永久阻塞新 effect；沿用现有 cooperative scheduling，不增公平性持久表。

## 5. G0a 外部调用可行性、G0b 恢复验证、G4 连续执行

**G0a — 生产重构前只验证外部能力，不要求系统已能连续推进。** 在真实已登录 Chrome 中新建独立、无不可逆副作用的测试 conversation（不触碰三条业务 Task）；构造含长文本、完整目标和起止 marker 的一次性 prompt，逐字回读完整内容及 App chip，至多点击一次 Send，并拿到此 turn **真实 Forge MCP 工具调用回执**。不能用 DOM chip、mock、文本 @forge 或 ChatGPT 纯文字声明代替。

**G0b — D1/D2 阶段验证可恢复性。** 在隔离测试 conversation 中关闭 tab、重启 Extension worker、重绑 exact identity，故障注入 no-send / unknown 并验证绝不二发。

**G4 — 实现后最终验收。** 在真实隔离 Supervisor Task 中无人干预形成 CONTINUE → CONTINUE → DONE，再逐条恢复和验收 Forge、iOS、Android 三个原 Task。三轮能力不能被错误地当成重构前置条件。

记录每次测试的 Task/Effect/Conversation/Prompt hash/真实 Tool Receipt ID、源码版本和时间；不公开敏感正文。

若 G0a 无法证明真实 Forge App 可用，判 **NO-GO**：明确当前外部 UI/provider 前提不成立；不得叠加 Browser retry、装作插件调用或增加第二套 manager 来假装通过。选择其他受支持传输需要重新做架构 R0 Review。

## 6. 一次性实施及旧代码删除清单

D0 设计冻结：本决策 + 全调用者清点 + G0a 单次真实 Forge Tool PoC。**Review R0**：范围、可行性、唯一 authority、外部依赖、失败闭环；未通过不修改生产链。

D1 契约与红绿测试：对现有 conversation-target.ts、supervisor/protocol.ts、Store 编写 no-truncation、pre-send zero generation、unknown never resend、实际 chip 与 receipt 分离、跨 Project/Task 身份和重启回归。**Review R1**：是否多出 state/manager，是否破坏原有历史账本或无 Work standalone 用例。只保留可以清晰解释其唯一 owner 的 API。

D2 同一 Work 批量迁移：现有 supervisor/{native-browser-adapter,control-plane,store,protocol}.ts、Computer TargetPort、Chrome Extension/Mac Provider 的必要修改同步交付。移动物理恢复逻辑到 Computer，删掉 Supervisor 旧副本；对所有 submitChatgptPrompt/runStandaloneChatgptPrompt、Scheduler、Launcher 调用者做 census。Work-bound 只 enrollment 到 Supervisor；真正多余的旧 Work-bound direct writer 必须删掉。已证实独立、无 Work 的 standalone schedule 直接发送不在本次范围，保留。**Review R2**：全 changeset、删除账本、并发/安全/故障测试。旧 writer 没删完不视为通过。

D3 Release 收敛：保留现有 immutable ReleaseSession 和独立 Recovery；明确 Runtime/Recovery/Chrome Extension 各自**实际运行的版本**与协议兼容性，验证 Connector drain、回滚、独立 Recovery 自举。不能让“修复在候选里，但执行升级的 Recovery 仍是旧版本”持续阻断。若现有 release 闭环出现确定的实现缺陷，只在本文已列发布边界内做最小修复。**Review R3**：安全门 unchanged、active request 不被强断、代码版本和运行版本对应；候选通过不能等于线上通过。

D4 实际交付：G0a/G0b 已通过且完成主体改造后，对 Forge 主线、Avela iOS、Avela Android 三条原 Task 逐项核对旧 unknown effect 和迁移记录；保留原 Task ID、完整 objective，绑定各自真实 /c/<id>，验证真实 Forge 工具调用与无人续跑。**Review R4**：以 causal live receipts 为唯一完成证明；三条 Task 未都通过则不宣布整项 DONE。

### 函数与文件处置登记

| 对象 | 处置 | 删除前的必要证明 |
| --- | --- | --- |
| Supervisor SQLite、validator | KEEP | exactly-once、历史事件可读 |
| ComputerInteractionTargetAuthority、ConversationTargetPort | KEEP + 收敛 | stable identity、provider binding 可替换 |
| native-browser-adapter 的 tab/window/worker 机械恢复 | MOVE TO COMPUTER + DELETE old logic | callgraph、restart、close-tab、wrong-project 测试 |
| Chrome Extension / Mac Native | KEEP as providers | 同一 Computer effect owner，未知不重发 |
| Launcher、Scheduler 的 Work-bound ChatGPT | KEEP enrollment-only | 证明没有第二个直接 provider writer |
| 无 Work Standalone Schedule 的 runStandaloneChatgptPrompt | KEEP OUT OF SCOPE | 已发现真实调用者，不得误删 |
| 复杂 preflight/rearm/refund 分支 | SIMPLIFY / DELETE only if proven redundant | 不破坏重试上限和历史读兼容 |
| Recovery / ReleaseSession | KEEP，修复版本自举 | live running revision、rollback、cutover proof |
| Desktop Operator、TCC、WSL/Cloud、其他 Work | OUT OF SCOPE | 不动无关文件 |

## 7. 穿插 Review 的强制模板

每次 Review 都由当前 ChatGPT 基于源码、实际 diff、测试和 receipts 完成；旧文档中的外部代理讨论不得替代本轮源码审查。Review 记录必须包含：①直接事实/源文件/回执；②架构不变量是否满足；③新增 abstraction 替代并**删除**了什么；④反例与故障注入结果；⑤ PASS / CHANGES REQUIRED / NO-GO 与精确阻断理由。

- **R0：设计/编码前**。审核需求与 G0 可行性；未通过不进入 D1/D2。
- **R1：接口契约/测试后，主体修改前**。审核唯一 journal、no-send 与 unknown 的判定边界、历史兼容。
- **R2：完整批量修改和删除旧路径之后**。对整体 diff 检查 callsite census、并发、重放、资源泄漏、性能和新增代码量。只增加复杂度且不删旧逻辑 = FAIL。
- **R3：发布切换前**。核对候选/Recovery/Extension/Runtime 实际 revision、活动请求、安全回滚，不能把 Git HEAD 当 live proof。
- **R4：真实运行验收**。隔离三轮真实 Forge 调用和三条生产任务各自的独立会话及后续自动推进回执。

相同根因始终在同一 Work 中完成，测试失败、canary、Runtime 切换不机械创建新 Work。新的独立缺陷单独登记，除非直接阻断当前目标否则不混入修改。

## 8. 验收矩阵与发布边界

| 级别 | 必须通过 |
| --- | --- |
| 静态协议 | objective 原文字节完整；超限明确拒绝；结构化 prompt 无静默 slice |
| Computer 交互 | exact URL/Project、真实 Forge App chip、全文 readback、错误目标 fail-closed |
| 发送与账本 | no-send generation=0；confirmed once；unknown 不二发、不 failover |
| Runtime 重启 | 原 Task/Effect/未知状态完整保留，不因重启而无限预算 |
| 多任务 | 同 Project 不抢 tab；三个逻辑会话不会交叉写入 |
| Failure injection | tab/worker/Chrome 关闭、连接中断、login/permission、已点击 Send 后掉线 |
| Release | Recovery 自举、immutable candidate、safe cutover、rollback、版本证明 |
| 模型与 Forge | tool-only 也能确认 causal MCP receipt；连续 CONTINUE → CONTINUE → DONE |
| 最终业务 | 三条原任务真实 /c/<id>，完整首次 prompt，每条至少一次无人干预 continuation |

最后静态 gate 应禁止 Work-bound Browser 直发、Supervisor 重新维护物理 tab 身份、静默裁剪原始 goal、出现第二个 effect writer。代码、测试、本文、CURRENT.md、architecture gate 同批修改。

## 9. 中止规则与 R0 结论

停止 provider mutation 的条件：可能重复发送、无法证明真实 Forge App binding、无法完整回读 prompt、认证权限不明、未知 Send 被当成 not_attempted、真实业务 side effect 未授权。发生后只做只读现场保全与模型根因判断，不调高重试上限或清空历史。

R0 审核：**DESIGN REVIEWED；PRODUCTION IMPLEMENTATION NO-GO UNTIL G0a**。当前已确认有足够的现有 Supervisor/Computer 组件可以收敛且不必重写全套产品；已确认静默 goal 截断风险与 standalone 直接调用者；真实 Forge 工具唤起和发布自举仍待 live proof。冻结的是责任和实施边界，具体待删函数必须到 R2 经全调用者审计逐个签核。若 G0a 不通过，报告证据与传输选型 NO-GO，不继续堆状态掩盖限制。

**完成定义不是某个 patch、单测、commit、发布或 Work 的绿色状态，而是 R0–R4 全部通过，且真实任务无人干预完成规定的因果轮次。**


## 10. R0 架构 Review 记录（2026-10-11）

**结论：CHANGES REQUIRED → 本节修正后 DESIGN PASS / PRODUCTION NO-GO pending G0a。**

### 直接核验的事实

- store.ts 与 control-plane.ts 已持有 Supervisor Task/Effect 的唯一持久 journal；不再造新 owner。
- conversation-target.ts 的 TargetPort 已有 prepare、dispatch、observe；重构应移走 native-browser-adapter.ts 的 provider 细节，不重复造 dispatcher。
- controller-progression-composition.ts 的 Work-bound ChatGPT 是 Supervisor enrollment；schedules/engine.ts 的无 Work standalone 调用确实存在。不能误删所有 Launcher 入口。
- protocol.ts 静默裁剪 objective 是源代码确认的正确性缺陷；UI chip 身份与实际 Forge MCP 调用是两种不同的证据。
- ReleaseSession/Recovery/Extension 的**运行中版本**必须独立验证，Git HEAD 不能代替 live proof。

### 反向审查发现并处理的矛盾

1. **前置循环**：原 G0 要求生产重构前就完成三轮自动推进，而修复三轮正是重构目标。修正为 G0a 只证明单次真实工具调用与完整传输、G0b 证明资源恢复、G4 在实现后证明三轮。
2. **删除过度**：不能因 Launcher 路径存在就删除无 Work standalone caller。R2 必须有全调用者审计与删除登记。
3. **隐性无限重试**：简化 preflight/rearm 不等于撤销有限尝试与 unknown 禁重放约束；每一次再次尝试仍需可验证 provider 变化且受上限约束。
4. **模拟节点冒充插件运行**：选中 Forge App chip 仅是发送前提，真实 Forge tool receipt 必须单独确认。
5. **发布自举死锁**：源码中有 drain 逻辑，并不证明旧 Recovery 正在执行它。任何新修复必须核对运行中的组件版本和可信回滚。
6. **回执归属误判**：Computer 页面观察不能认定 Forge MCP 已执行；自动化 completion 仅由现有 automation_receipt 主路径因果结算，不新增第二 receipt owner。

### R0 审核矩阵

| 检查 | 结论 | 理由 |
| --- | --- | --- |
| 用户原始目标与范围 | PASS | 长期任务 / exact conversation / Forge tool / CONTINUE、DONE、NEEDS_USER |
| Authority 唯一性 | PASS | 沿用 Supervisor journal、Computer Target、现有 Controller 准入 |
| 禁止增加新状态 | PASS（设计） | 没有新表或第二 Manager；实施需 R2 验证 |
| 不误删 standalone | PASS（设计） | 明确保留经调用图确认的无 Work Schedule 路径 |
| Prompt 不截断 | PASS（目标） | 具体修改必须在 D1/D2 有红绿测试 |
| 真实 App 端到端可行性 | NOT YET PROVEN | G0a 必须给出实际 MCP tool receipt |
| 生产实现准入 | **NO-GO until G0a** | 避免两个月以来“修复基础设施却不证明产品前提”的循环 |

**允许的下一步只有 G0a 的隔离真实能力验证及现有调用图/兼容性只读审查；禁止直接开始 D2 批量生产重构。**


## 11. G0a 真实环境首次检查（2026-10-11）

状态：**BLOCKED — 无发送，无 Tool Receipt**。

- Browser Computer 使用 attach_preferred + 已知 Chrome 配置检查 chatgpt.com 首页，返回 PLUGIN_ACTION_ARGUMENT_INVALID / observed protocol: chrome-error:。请求 ID：forge-g0a-browser-authenticated-ui-inspect-20261011。
- 同样检查此前实际登录过的 Forge Project exact conversation URL，亦返回 chrome-error:。请求 ID：forge-g0a-chrome-project-session-exact-20261011。
- macOS Computer desktop_target_open 确认已安装/运行的 com.google.Chrome 可被原生定位；desktop_observe 显示 Chrome 当前窗口「首页 — TNT」。这说明**Chrome 应用本身存在**，并不能证明 ChatGPT 网站在该环境可访问。
- 没有可验证的 ChatGPT composer，没有 Forge App 节点、发送前全文校验或工具调用回执。**本轮 0 次 Send，没有新 conversation、没有改变三条业务 Task、没有改旧 effect/发送预算。**

判定：这是 **Browser/ChatGPT 可访问性与附着能力未满足**，不是“Forge 插件功能确定不可行”。先复核已登录 Chrome 的访问与 attach 支持，再用同一个 G0a 测试；不能因此在 Supervisor/Recovery 添加新补偿链，更不能用 mock 伪造 Go 结论。R0 生产实现仍 NO-GO，直到实际 Forge MCP receipt 出现。


### G0a 原生 Chrome 交叉核验（同日）

使用现有 com.google.Chrome 原生附着能力，已成功在**同一 Chrome** 新开标签页并导航到 https://chatgpt.com/；窗口 AX 标题为 ChatGPT，说明不是 Chrome 程序未运行。然而页面 AXWebArea 只呈现浅层骨架（“跳转到内容”和空组），无可发送的 Composer；同一 Chrome 的其他 chatgpt.com 标签明确显示 Network error。既有 Browser Computer URL 查询也返回 chrome-error:。

所以外部前提当前的准确分类是 **ChatGPT 页面/DOM 未能完整加载，或者 Browser 附着与站点访问不一致**，而不是“Forge 插件调用已被证明不可行”。本次新标签页访问没有写 ChatGPT 消息、没有创建独立业务 Conversation、没有点击 Send，没有 Forge Tool Receipt。禁止将 AX 页面标题 ChatGPT 当作 G0a PASS。下一步必须先以可观察的完整 ChatGPT 编辑器与登录态证明站点可用，才能启动隔离的真实 Forge App 调用试验。

## 12. R1 实施批次审查（2026-10-11）

用户明确要求基于最新 Forge/Computer 基线**集中修改后再统一验证**。该指令仅调整实施/验证粒度，不允许跳过 R2/R3/R4 真实功能验收。当前源码 `4c0d69bc`、运行 Runtime `49a9ee89`、Computer 插件修订 `124` 分开登记；`origin/main` 新增提交只涉及公开 Wiki/Computer 指引，不能把它当成更新后的可执行 Computer provider，也不在本 Work 合并无关文档。

R1 批次聚焦可以直接由真实代码证明的契约缺口：`registerTask` 原来可存入超 8000 字符目标，而 `renderSupervisorPrompt` 悄悄 `slice`；`reviseTaskObjective` 另有独立长度检查；`chatgptForgePluginMentionBound` 可能把不同 HTML 元素上的 `app-mention-name` 和 `app-mention-path` 错认为同一真实 App。统一使用现有 protocol 中的 objective validator，并让存储准入、修订与渲染共享它；不新增 manager/state/数据库。原目标保留原始字符串（含换行、引号和多字节字符）；超限明确拒绝，不能假成功。Browser App 绑定的 name/path 必须来自同一个 chip 节点。

**R1 Review: PASS for contract scope, pending batch checks and G0a live proof.** 安全缺陷修复不等于完整自动推进已经交付。下一次 R2 须核查调用者、无越界 direct writer、代码删除和 Browser 实际读取，不能以此批次为最终架构清理结论。

### R2 变更集审查补充

对完整 diff 审核时发现 `store.reviseTaskObjective()` 还保留了 `trim()` + 独立长度校验。它是绕过 Controller 边界的真实持久 writer，必须同步迁移到 `validateSupervisorObjective()` 并**删除**旧判断，否则任务目标可能在持久修订时改变首尾字符。本次修正使用原模块内已存在的导入，没有增加新状态或抽象。R2 的全系统自动推进交付仍未通过：已有 Computer UI 的归一化全文 readback、真实 Forge MCP causal receipt、运行时版本更新、三轮连续推进还需要真实验收，不因本次协议回归绿灯提前宣称完成。

## 13. G0a live Forge Tool proof 与 D2 bootstrap 路由审查（2026-10-11）

G0a **PASS（仅单次真实工具调用）**：独立会话 https://chatgpt.com/c/6acb51da-dc20-83ea-89a8-4b77679225ba；真实页面从同一 DOM 节点确认 forge App 的 name/path 为 app://asdk_app_6ac09022b26081918f20ff868c773824；发送前全文含 G0A_BEGIN/G0A_END，经浏览器读取验证；一次发送回执 PLG-1791709656265-902e7a3d。会话中真实 MCP 工具调用 rh_status，traceId 4cb9a117-c0a7-484b-896e-22ff836ef5de，requestId mcp-call:258a2d55-f9a3-4a8d-ac2f-79b60b04296b，返回 status=ok、readiness.ready=true、HEAD=1d96a458a8238e75fd61ee1e4a8aed41709b531d。此证明的是被明确选择的 Forge App 和单次只读工具调用，不代表 Supervisor 三轮可无人推进。

R2 现存路由核对：adapters/computer/chatgpt-target-router.ts 的 ensureExact 已允许 Extension 明确未触发浏览器变更时的原生 Computer 接管，但 openBootstrap 未执行同一证明规则。本批复用已有 ComputerChatgptConversationTargetPort 和 failoverSafe 证明条件；仅 pre_mutation 且 failoverSafe=true 可由现有 native provider 打开单个 bootstrap；已认领但结果未知时不跨 provider 重开。没有新增发送 writer/新状态/新 manager，原 Extension/Computer 生命周期不变。对应测试为 tests/runtime/computer-chatgpt-target-router.test.ts；完成整批 changeset 的 R2 review、运行时发布与 G0b/G4 仍待后续验收。

R2 bootstrap 身份补充（同一 Work）：Mac native 的 createSingleFlight 原按 Project URL 聚合同发创建，两个不同 taskId 可能复用一张物理标签；现在对 bootstrap 改用独立 bootstrapKey（URL 仍仅用于导航），仅同一 Task 合并同一 in-flight 创建。Extension 明确报告 provider mismatch 时，Computer Router 仅将原 targetId 交给归属 native provider 进行身份提升，不再由 Extension 冒充 native writer，也不重开标签或重复发送；不满足明确 no-mutation 证明一律不迁移。Supervisor 在 marker 对账已返回 exact-conversation target 时直接绑定，不重复 promote 已变成精确会话的目标（避免 tombstone 自身 binding）。相关回归：computer-chatgpt-target-router.test.ts、computer-chatgpt-macos-target.test.ts、workflow-supervisor-control-plane.test.ts。R2 整体、G0b/G4 和 Runtime live release 仍需后续证明。

### R2 provider-identity 与同次点击防线复核

- 对已有 Controller Computer Surface binding 的 bootstrap，Chrome Extension 离线时不能把“本次尚未调用 Send”误当作“此 Task 从未创建标签”；保留原 Extension 绑定并拒绝 native 新建。若原绑定由 native provider 持有，Extension 在选取实例前就明确报告 provider mismatch，由 native 恢复该同一 targetId。Mac 原生 provider 也独立拒绝已存在的外来 provider binding。
- Extension background 的 ensure 可能在 Chrome 创建标签后、拿到返回值前出错。未知 target 并不证明未创建标签；对 bootstrap，worker 已接到命令但执行失败时一律不得跨 provider 重建（即使本次没有新建，之前可能已有该 Task 的标签）。只有 Extension 根本未接到命令，且 Controller 无原有 binding，才允许 native 新建。对 exact-conversation 保留已有的已复用 tab 负证明分类。此收窄不增加 retry 或 authority。
- native Computer 的每个 prepare 和 dispatch 都携带同一个既有 ComputerChatgptTargetIdentity，通过 Apple Events 在真实浏览器文档内校验 exact conversation ID，或 bootstrap 的确切 Project ID 且无现存 /c/ 会话。最终 Send 点击和 URL 证明在同一个 page.evaluate 内完成，用户在准备与发送之间切换会话时无 provider mutation。
- 2026-10-11 开发候选针对 native/router/Extension/Controller Surface 的聚焦测试包含真实 JS 表达式模拟错位导航，类型检查通过。仅证明源代码与测试边界，不是实际发布、G0b 或 G4 的 live 回执.

### R2 Prompt 全文 readback 与空白保真审查

- Chrome Extension 与 Mac native 原先把用户消息/结构化 Supervisor effect prompt 的连续空格、制表符和换行压成单个空格。此比较不能证明原文未被静默更改。
- 两条 provider 现仅对 CRLF/CR 做平台换行标准化，不压缩正文空白；Forge App chip 的独立身份检查保留，UI 选项标签的宽松归一化仅服务于选项匹配。
- 两条真实 provider JavaScript 回归已验证：准备后丢失空格或换行时拒绝 Send，正文完全一致时允许一次 Send。Mac 最终 Send 的 URL、正文及 App chip 在同一个浏览器 JS 任务内校验。
- 这些结果仍属于源码和模拟浏览器的测试证据，尚须 G0b live recovery、发布版本一致性、G4 三轮及三条既有业务 Task 验收；不可把该局部 PASS 误写为原始目标 DONE。

### R2 G0b worker-restart calling chain proof (source/test boundary)

- Extension `target.prepare/dispatch` 已携带稳定 `providerBinding`，但 background worker 原本调用 `resolveTarget(identity, false)` 丢弃了该证明；service-worker 重启后其临时 `bootstrapTabs` 映射为空，即使 Controller 还绑定了唯一标签也无法完成后续首发。现在两条 worker 操作都传入原始持久 binding，严格恢复同一 tabId，且不会借用同 Project 的其他标签。
- 首发 prepare/dispatch 将目标 `expectedProjectId` 传给 content script；content script 在编辑前、最终 Send 前验证当前 Project 且不是现存 `/c/` 会话。新 worker 对精确标签先做 `bootstrapTargetGuard` capabilities 握手；旧 content script 未升级时直接拒绝，不可跨版本盲发。原有 reasoning 失败码保持不变。
- 源码里两种 provider 的 Supervisor @forge 表示层处理不再对整个 `effect.prompt` 调用 `trim()`，避免截掉最后换行或空格；effect marker 与真实 App chip 检查仍独立保持。
- 实际 background.js 和 content.js 在 VM 中的故障注入测试覆盖了 worker 映射丢失、Controller 精确绑定、混合新旧 content script、错误 Project、原有对话、Chrome 回调结果未知。测试证明可拒绝危险发送及正确恢复调用链，**尚不是实际浏览器关闭/worker 重启的 G0b live proof**。
