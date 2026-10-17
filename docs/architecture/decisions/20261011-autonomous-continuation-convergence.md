# 自动推进端到端架构收敛设计

Status: R0 REVIEWED; G0a LIVE FORGE TOOL PASS; D1/D2 SOURCE CANDIDATE; G0b/G4 AND R2–R4 NOT YET ACCEPTED
Date: 2026-10-11
Owner: ChatGPT (semantic decisions) / Forge Controller (mechanical durability)
Scope: Workflow Supervisor → Computer exact-conversation delivery → ChatGPT Forge App receipt

## 2026-10-15 后续收敛候选（下文为历史设计与审查记录）

本文件关于 `PreferredChatgptConversationTargetPort`、`MacOsChatgptConversationTargetPort` 和扩展/native 兼容接管的描述，仅是当时的事实与阶段设计，**不再代表收敛候选的当前路径**。后续源码候选规定：Work-bound ChatGPT conversation 只由 Chrome Extension 提供 Computer exact-target observe/prepare/dispatch，Supervisor 独占 effect/重放 Authority；Apple Events 保留为通用显式 macOS Computer/Browser 操作，不再作为 ChatGPT 发送候选。

同批删除 `adapters/computer/chatgpt-target-router.ts`、`src/runtime/plugins/computer-chatgpt-macos-target.ts` 和 `src/runtime/plugins/browser-provider-registry.ts`。通用 Browser 操作在执行前只绑定一个 Provider；attach 使用单一 CDP endpoint 或明确 native browser product，不再自动跨 CDP/native/managed 试错。对应源提交 `fa65b2d1`、`c4842a4c`、`208fd065`，详见 `docs/architecture/CURRENT.md`；架构 gate 已禁止恢复旧 writer。

静态检查与五组聚焦测试已通过；8 组 Browser 测试在改动前后均为 79 通过 / 10 失败，没有新增失败。候选尚未合入被其他 Work 占用的 main，未发布和执行 Runtime 重连后真实三轮验收。**不得将此源码收敛记为自动推进产品验收 DONE。**

## 2026-10-14 用户收敛指令（优先于下文历史阶段记录）

交付目标只有一个：无需人工发送“继续”，自动完成多轮真实源码修改、检查与提交，并在 Runtime 重启/重连后从同一 Task 继续；未知发送结果不得重发，不得破坏已有工作。目前未验收。静态审查与修复由当前工作负责，实际运行、发布和验收由另一工作负责；静态通过不能代替其证据。

### 冻结范围与事实基线

- 审查起点为 `b596d0d3e`。它是源码基线，不是已验证可用的历史基线。冻结新增 Supervisor 状态、恢复策略、兼容层及自动化功能；只接受直接阻断最小闭环的共同根因修正，每次必须列明替代/删除的旧逻辑。
- `1a03e0d17` 删除工具 automation receipt 写入路径，改为最终 assistant 回复结算。历史 completion 数量必须按这两种来源分开；尚无同场景对比证据证明某历史提交可作为可靠回退点。
- 当前 `adapters/computer/chatgpt-target-router.ts` 的 `wrap` 会在扩展观察异常或回复换行缺失时读取 native，并改变后续 prepare/dispatch 的 provider。这是待收敛的双轨结构，不能把 targetId 相同当作已证明物理标签页相同。
- 同一 URL 的多标签页必须核对现有 Computer binding 的 provider instance、tab/window 与实际目标。先查清唯一观察者和发送者，不能靠前台窗口猜测、合并两个页面的观察结果或新增备用通道解决。

### 最小闭环与交付终点

1. 使用一个 Forge 源码 Task 和一个明确绑定的会话，冻结初始 source commit、Runtime/extension 身份、原始目标、Task/effect 及物理 binding；不把无关业务 Task 纳入实验。
2. 第一轮真实修改源码、执行与改动相关的检查并提交；最终 assistant 回复产生可验证的 CONTINUE。保留实际 commit、检查结果、最终回复与原 effect 的因果证据。
3. Supervisor 自动预留并发送下一轮，第二轮再次产生真实源码改动和提交。期间不得人工发送“继续”、注入 completion 或手工派发来补齐链路。
4. 在仍有真实剩余工作的情况下跨 Runtime 重启/重连，证明同一 Task 从既有账本继续，最终到达经验证的 DONE。保留重连前后 effect、dispatch generation、completion、commit 的对应关系，确认没有未知结果重发或丢失已有改动。
5. 仅上述真实证据齐备才可宣布能力完成；Runtime 健康、Send 成功、模拟测试及静态检查均只证明各自局部性质。

### 失败退出与替代关系

一次验收失败后先保存从绑定、发送、最终回复到结算的完整因果证据，定位被违反的共同不变量；不立即发布下一个症状补丁。再次尝试必须有能够解释失败、替代旧结构且可被验收否证的修正。若同一方案重复失败且没有新的可验证根因，不再增加 recovery；由模型作出回退结构或更换传输路线的明确决定。此纪律是交付决策，不新增 Runtime 状态机或自动阈值。

| 既有义务 | 本次处理 |
| --- | --- |
| 唯一 Task/Effect/Completion authority、精确目标、unknown 禁重发 | KEEP：沿用 Store 与 Computer 既有契约，不放宽保护 |
| 扩展/native 自动兼容补洞 | CHANGE：收敛为同一绑定上的唯一观察和发送通道；先完成同场景身份与回执对比，再删除竞争路径，不保留隐形 fallback |
| 工具回执计数作为完成证据 | DROP：仅最终回复加真实源码成果证明外层轮次完成；旧数据保留为历史证据 |
| 首轮恢复三个业务 Task、更多自动化能力 | DEFER：本节 Forge 最小闭环验收通过后再决定，不能扩张本次范围 |
| 发布、健康与测试通过作为自动推进完成声明 | DROP：以本节真实闭环为唯一产品验收 |

如果 UI 路线不能可靠绑定会话和观察最终回复，必须评估稳定模型调用通道，比较工具执行、持久恢复、授权、运行方式和实际调用成本。该评估不授权偷偷切换付费通道，也不预设 UI 或 API 必然可靠。历史可用基线、唯一 provider 的最终选择与真实验收结果仍待证据，不在静态审查中猜定。

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

### R3 Connector cutover admission deadlock (same Work)

2026-10-11 live evidence: active source commit 84eb656e became portable Candidate B in ReleaseSession release-1791719073349-7afca2aebb3d4320, phase cutover_eligible. Stable A remained 1791516536412-49a9ee89461079a0091f843afd64ecde2ba01542, known-good. Primary Connector health reported activePosts=5 then 6 with no active streams; direct canonical Recovery release-session-advance attempt timed out without cutover (session revision 6, Stable A revision 824 unchanged). No retry of the unknown process was made.

Root cause at Recovery daemon entry.ts: pre-checking probeReleaseCutoverReadiness before dispatching action=cutover suppresses entry into cutoverConfiguredRuntimeReleaseSession, which is the existing sole owner of armPackageConnectorCutoverDrain and bounded 30s quiet-window/180s drain behavior. Change: remove the duplicative automatic pre-gate and use only the canonical ReleaseSession cutover. When that transaction reports RELEASE_SESSION_CUTOVER_DEFERRED_FOR_MCP_ACTIVITY, feed it into the existing phase/revision exponential backoff (15s → max 15min), rather than retrying the same potentially disruptive drain every 15s. No new state, lock, daemon, release path, Work, or provider writer. This is **source only** until standalone Recovery is upgraded and its active revision independently verified; it is not a G0b/G4 live pass.

### R3 installed Connector compatibility evidence (2026-10-11 13:40–13:44 UTC)

Independent Recovery `runtime_status` now proves its running source is `5d625bc788e6c775605be6fbfc3204e1d87eb004`. Stable Runtime and its immutable Connector still use `1791516536412-49a9ee89461079a0091f843afd64ecde2ba01542`, authority revision 824. The existing ReleaseSession remains `cutover_eligible`, revision 6; no cutover or G0b/G4 acceptance occurred.

A canonical `cutover_runtime_release_session` call through the existing local Recovery transport returned `attempted=false`: the automatic transaction already owned the mutation. Its exact PID 33720 was verified live running `__reconcile-runtime-release-step`, then observed absent. The Recovery journal recorded `release_session_cutover_deferred_for_mcp_activity` at 13:41:32.804 UTC with `activePosts=6`, `activeStreams=0`, `initializing=0`, and `connectorDrainArmed=true`. This is a completed deferred observation, not a live process to wait on or an unknown activation to replay.

The installed Stable Connector's `package/adapters/mcp/transports/http.ts` has the old scalar `admitMcpPost` counter and **no cutover-drain admission reader**. Current source has `packageConnectorCutoverDrainIsActive`; arming its marker does not make the old running process consume it. Thus the earlier Recovery entry correction reached the canonical drain owner but did not establish admission fencing in the predecessor Connector. Its legacy health `oldestPostAgeMs=0` and `protected=0` exclude modern stateless POSTs; `oldestActivePostAgeMs` is absent. These counters do not prove that the unfinished modern responses are stale or safe to terminate.

Next design obligation: close predecessor Connector upgrade bootstrap through the existing Recovery whole-release transaction, preserving admitted-response and unknown-effect fences. Do not hot-patch an immutable release, independently upgrade the Connector, bypass the quietness gate, force-close unknown operations, or add another lifecycle owner. Any bounded compatibility transition must name its owner and retirement condition before implementation. The original G0b/G4 and Forge/iOS/Android live acceptance requirements remain intact.

### R3 explicit transport recovery decision

Use the existing independent Recovery `restart_primary_connector` operation to recover the installed **same-release** transport before resuming the existing ReleaseSession. This is explicit operator recovery, not a cutover fallback or an independently upgraded component. The existing Runtime restart already distinguishes explicit healthy restart from watchdog recovery; reuse that distinction for Connector recovery. Explicit RPC requests restart once even when endpoint probes pass; autonomous watchdog calls retain their healthy no-op behavior. Re-verify local listener ownership and the public endpoint after the restart rather than reusing a pre-restart success.

Recovery remains the sole lifecycle writer under its existing operation lock. No new persistence, protocol enum, release identity, service, or retry owner is introduced. Transport response loss must not cancel or resend durable Work, Process, Supervisor effects, or external mutations; lost responses remain unknown observations under their existing owners. This action may interrupt HTTP responses and requires the model's explicit recovery choice; ordinary cutover must still prove zero admitted requests and its quiet window. The old Connector is restarted with its unchanged immutable binding; only the verified whole-runtime ReleaseSession may later advance that binding. This closes a general missing explicit recovery capability, with no permanent predecessor-version fallback to retire.

### R3 whole-runtime cutover evidence and remaining live boundary

2026-10-11 UTC: the existing Recovery operation restarted the unchanged predecessor Connector once, then independently verified its listener/public endpoint; the resulting health observation had `activePosts=0`. The existing ReleaseSession `release-1791719073349-7afca2aebb3d4320` subsequently completed canonical cutover to `1791719091233-84eb656e3718673dd3b95bba16a756779b812d6a`, authority revision 825. Its journal recorded stable activation at 13:57:16.935, commit at 13:57:22.033, soaking at 13:57:22.088 and candidate cleanup at 13:57:22.554. Independent Recovery status confirmed Runtime source `84eb656e3718673dd3b95bba16a756779b812d6a` and Recovery source `e4f64b3d3251bb7860a6bd6ac2e722e69ccbd079`; a real post-cutover MCP `rh_status` returned ready with 158 tools (trace `d4bd4346-555b-47e3-9a0a-b07cd47cabb6`). This proves cutover and reconnect, not `known_good`, G0b or G4.

The same three original tasks remain incomplete. Canonical Supervisor RPC reads on this follow-up independently returned `generations=0`, `maxGenerations=3`, `exhausted=false` and a deliverable generation-1 enrollment for each:

- Android `supervisor:avela-android-development-20261001`: `fx_9b7a9f78bc3151c1aa25ae36877b977b`.
- Forge `supervisor:b1439a4da2e44752d9c44893`: `fx_feff473ca43d7a2f01bbdbbfdd6eeec2`.
- iOS `supervisor:69e0a38039a955324b1dd523`: `fx_9ed5a0f02c7df22a29e0d4406b8ba04b`.

At 14:05:40 UTC the consumer was enabled/running without transport failure or provider backpressure, but its last preflight failed with `COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING`. That fact proves absence only in the responding extension's exact-tab inventory; it does not prove complete browser coverage, a working authenticated editor, or successful continuation. Actual computer inspection and a later native-app recheck reported the Mac locked and automatic unlock unsuccessful. Browser enumeration separately failed to load its request-header policy, so an empty enumeration must not be treated as proof that the user's tabs are gone. Manual unlock is an external prerequisite for the outstanding physical-browser review.

Current-source closure: `migrateToFreshConversation` rejects an already-bootstrap task, while `close_session` consumes `browser.session.v1` compatibility records that these extension targets do not have. Computer already owns locked/CAS `clearBinding` and exact-target `release`; neither absence of a tool exposure nor zero send generations authorizes a second database writer. Preserve the original Task/effect identities and unknown-outcome fences. Before a restoration change, verify the real physical target and account, distinguish proven missing attachments from lost create/send observations, and reuse Computer's existing authority. Do not clear bindings, mint replacement enrollments, fabricate receipts, or infer G0b/G4 PASS from this source analysis. The isolated CONTINUE→CONTINUE→DONE, restart recovery, and three original business-task live acceptances remain required.

### Source-development scope correction and semantic response integrity

The user clarified that the current objective is Forge source development, not operating autonomous browser tasks. The physical-browser observations above remain live acceptance evidence only; they do not block independent source implementation, review or static/focused verification. Continue the existing core-repair Plan before new V3 client features. Do not restore business conversations or activate another Runtime merely to advance source development.

The apparent lost `work_result_refs` was narrowed to response serialization: `reviseWorkSemanticContext` persists up to 100 references, while generic `buildFacadeResult` clips every array at 50 and nested strings at 1,000 characters. The current MCP revision increased from 12 to 13 after submitting 51 references, but its public Work projection still exposed only 50. Thus the earlier projection alone did **not** prove a failed write. Reusing that partial response in a replacement-style revision can discard references or replace a valid objective with an ellipsis.

Correction owner: the existing Work MCP adapter preserves canonical `work`, conflict `currentWork` and bounded semantic revision records after building the ordinary diagnostic envelope. Repository admission uses the same serializer. The semantic Store, CAS, revision archive, authorization, schemas, state and release topology do not change; execution/continuation diagnostics retain generic clipping. No new persistent writer, compatibility path, recovery mechanism or lifecycle is added. An existing semantic lifecycle test now checks 100 references and an objective exceeding the diagnostic text limit across mutation, read/revise round trip, history and stale-CAS conflict response. This source correction is not live-runtime deployment or browser acceptance.

### G0b after active Runtime cutover: actual Browser pre-send recovery

- 2026-10-12 live active Runtime is 1791719091233-84eb656e (authority revision 825), verified healthy by standalone Recovery; original ReleaseSession is soaking. Browser Adapter projection was stale after cutover and has been synchronized via its existing Controller-owned install authority, now projectionCurrent=true.
- The three original Supervisor bootstrap effects remained deliverable, generation 1, preserving exact effect IDs and immutable prompts. Chrome Extension target records were pinned to old physical tabIds, resulting in COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING. The Forge task's precise stale provider binding alone was retired under Computer Surface lease with matching Supervisor pre-send state and fresh live missing-tab proof, preserving targetId and effectId. The consumer subsequently created a new exact Forge target but failed during reasoning preflight without sending.
- Live Runtime stderr: COMPUTER_CHATGPT_REASONING_CONTROL_UNAVAILABLE. The first mock-DOM regression proved that limiting the picker search to main can miss a header control. Subsequent direct observation of the *actual* Forge Chrome Project tab superseded the assumption that its header mode switch is the reasoning picker: the genuine reasoning picker is inside main with aria-label 选择 ChatGPT 模型 and the current level 中. Source must select the exact model picker over the distinct ChatGPT/Work mode switch, and prove React's reported level. Neither mock case alone proves live first-send.
- The Chrome Extension/Native Host packaging must be rebuilt and reprojected from a new verified active Runtime before claiming G0b/G4. No current proof of any provider submission or original three-task completion from this source-level fix.

### G0b real Chrome GPT-6 reasoning picker observed on original Forge bootstrap tab

- Mac native Computer read-only exact-tab reattachment observed Chrome windowId 2095969763 / tabId 2095970002, same stable Forge Project ID g-p-6a922010db348191a84d1a5306c083e8; URL uses short /g/<project-id>/project rather than slug variant. No navigation, prompt edit, or Send.
- Header button aria-label 切换模式，当前模式：ChatGPT controls ChatGPT/Work mode, **not** reasoning. Inside visible main, actual button aria-label is 选择 ChatGPT 模型, showing 中. Its menu selects GPT-6 and contains menuitem data-reasoning-slider=true, nested aria-hidden slider span min=0 max=2 current=1, and React status 中，第 2 项，共 3 项。
- One actual ArrowRight on outer menuitem changed React aria-valuenow 1 → 2 and status 高，第 3 项，共 3 项. This proves High, NOT Extra High. No message Send or Supervisor effect mutation occurred.
- Source fix: prefer exact model picker over distinct mode switch; send keyboard input to outer control; require numeric and actual announced level readback; report actual high for three-position xhigh request. For unknown/disabled UI, refuse before Send; do not infer a level from a number alone. Legacy five-position selector remains supported only with verifiable level text.
- Actual-content.js mock of the exact Chinese control and keyboard path failed before change and passed afterward. This is source-level proof only: canonical Runtime/Extension redeployment and true causal Supervisor first-send receipts remain required.

### 2026-10-12 G0b physical-tab and model-menu retry root causes (same Work)

The next active whole-Runtime release is 1791754477828-afa97d1863f28b57297f41da4bb40132775bab34, authority 827. Its Browser Adapter was projected to the exact active release, but Supervisor still had no G0b effect submission. The live first-send tasks remained generation 1; Chrome-preflight stderr included COMPUTER_CHATGPT_REASONING_OPTION_UNAVAILABLE, and the consumer's incomplete native inventory was a degraded global observation rather than a veto on independently healthy exact Chrome delivery. A native exact-tab reattachment separately proved the earlier Forge tabId 2095970002 no longer existed.

Two coupled pre-send defects were isolated: (1) repeated reasoning preparation clicked an already-expanded ChatGPT model picker, closing the React portal and falsely reporting that the slider was unavailable; (2) a Controller-pinned bootstrap tab that Chrome proved absent remained a durable provider binding forever even though the source enrollment effect had not reached Send. The first root is fixed by honoring the picker aria-expanded state and waiting a bounded number of DOM frames for a real visible menu option/slider, with no synthesized verification. The actual-content.js regression failed before this change and passed after it.

The second root uses **only** Computer Surface authority and its existing lease/CAS: for openBootstrap (the caller's pre-dispatch enrollment path), if the same fresh Extension provider instance returns exact COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING, compare the entire prior target identity/provider binding inside its lease, clear only the replaceable physical attachment, and perform at most one same-provider re-open against the same stable Task target. A different provider/instance, concurrent target change, worker timeout, unknown create outcome, and previously submitted/reconciling effects must never enter this recovery. The Supervisor effect ledger remains the only Work-bound Send authority. Tests exercise recovery, different instance rejection, claimed-but-interrupted result, and CAS conflict. No parallel target store, manager, Supervisor state or default native failover was introduced.

This is still **not** causal G0b/G4 live proof. The source changes must pass review/checks, be released through the canonical Recovery whole-Runtime transaction, and demonstrate actual one-time Forge/iOS/Android effect send and subsequent CONTINUE progression before known-good promotion.

### 2026-10-12 original three-task preflight exhaustion: explicit operator repair

Read-only canonical Supervisor SQLite showed all three original enrollment effects have exactly three distinct effect_preflight_rejected events, with send_clicked=false and zero effect_dispatch_started events: Forge fx_feff473ca43d7a2f01bbdbbfdd6eeec2; iOS fx_9ed5a0f02c7df22a29e0d4406b8ba04b; Android fx_9b7a9f78bc3151c1aa25ae36877b977b. Hence they remain spaced / pre_send_infrastructure_blocked on Runtime 1791771060540-cd1d7bde (authority 828) even after the exact Chrome model-control and bootstrap-target fixes were released. This is an intentional durable three-release automatic-preparation cap, not transient provider backpressure.

The existing operator recovery method was itself unreachable after that cap: authorizeOperatorPreflightRetry rejected all requests with WORKFLOW_SUPERVISOR_PRE_SEND_ATTEMPTS_EXHAUSTED before it could record the already-defined single operator-rearmed event. Preserve the automatic 3-release ceiling, no-Send event history, original Task/effect identity, and exactly-once dispatch budget. After explicit operator authorization of an independently verified repair, the same existing rearm event permits exactly one more **pre-Send preparation** even on a successor Runtime; a new failed preparation blocks again and a second operator rearm is forbidden. No automatic authorization on Runtime cutover, no cleared failures, no new state/manager or worker retry loop. A real Chrome extension content-script version and actual provider Send receipt remain required before marking G0b/G4 passed.

### 2026-10-12 live Forge bootstrap hydration race after operator-authorized preflight (one original effect)

Release e6d8248f was active and Browser Adapter projection current; the original Forge effect fx_feff473ca43d7a2f01bbdbbfdd6eeec2 had three prior pre-send-only rejections and zero Send generations. One explicit operator preflight rearm was recorded as canonical event 36903. That single preflight rejected as event 36904 at 2026-10-12T02:48:43.888Z with COMPUTER_CHATGPT_REASONING_CONTROL_UNAVAILABLE and send_clicked=false; **no provider Send occurred**. The stable Computer bootstrap target bound newly created Chrome tab 2095970076 at 02:48:43.859Z, just 29 milliseconds before failure. A subsequent read-only exact-tab Mac browser observation of this same tab in Forge Project g-p-6a922010db348191a84d1a5306c083e8 confirmed a live contenteditable composer and visible menu button aria-label 选择 ChatGPT 模型. These facts strongly indicate a navigation-shell hydration race, not proof that every deployed content script is current.

Source root: extension worker waitForContent originally returned immediately on any snapshot URL, while content.js pageSnapshot already omits composerText until a real editor appears. New bootstrap wait must require both a real composerText and a visible reasoningControlReady observation derived from the current content script. The worker waits a bounded 20 × 250 ms on the *same* physical tab, below its broker command deadline; if readiness never arrives it reports TAB_NOT_READY before any Send. Ordinary existing conversation observations retain their previous bounded behavior. Old or stale content scripts lacking the new readiness receipt fail closed. The additional UI signal is transient read-only evidence, not a new effect authority, state table, or manager.

The first worker regression proved that a URL-only snapshot was incorrectly admitted after one observation; the second proved an editor-only unhydrated shell was also incorrectly admitted. Both were RED before the change and pass with the new worker gate. Forge's one operator-rearm has been consumed and its original preflight is blocked; the operator gate must not be reset or bypassed to manufacture G0b/G4 proof. iOS and Android original effects remain separately blocked and unspent. Release, browser script version, live send and downstream continuation acceptance are still outstanding.

### 2026-10-12 Chrome reload and real empty-editor ProseMirror proof

The active 840f7205 Runtime was healthy but G4 still lacked any Send. Chrome's own Extensions UI at `chrome://extensions/?id=glinahpcibpcfcimdcceplmfkgcjehin` proved the enabled Forge Computer ChatGPT Provider points to `~/.forge/controller/supervisor/browser-adapter/chrome-extension`; a single UI Reload succeeded without closing Chrome. The canonical Supervisor discovery table then recorded a *new* `chrome-extension:537b8d80-79eb-4733-b3c3-6c8633f78d57` worker after prior `chrome-extension:f77265d9-84a5-4297-a77e-6c607ad257f0`. Original Forge/iOS bootstrap tabs were verified empty, exact Project-bound, and individually refreshed through Computer native Browser automation; Android's old physical tab was not found and must not be replayed.

The original iOS effect `fx_9ed5a0f02c7df22a29e0d4406b8ba04b` had zero provider Send generations and no previous operator rearm. One explicit original-effect pre-send rearm was recorded; an actual iOS Project tab briefly redirected to `https://chatgpt.com/`, so extension correctly rejected `COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_IDENTITY_CHANGED` without Send. Returning that exact empty Task-owned tab to its recorded Project let preparation proceed, where it rejected `composer_not_empty` (canonical event 36906, send_clicked=false, zero generations). This is a consumed one-time operator rearm; do not reset the counter or claim a Send.

A fresh read-only inspection of the **actual iOS Project editor**, not a mock, proved its `contenteditable` ProseMirror editor has one paragraph whose entire `innerText` is a single newline (length 1, SHA-256 prefix 01ba4719c80b6f). It had no App chip, no effect marker, and was whitespace-only. The immutable original effect prompt is 2138 chars, so this is *not* a different user draft. Existing `composerText()` preserved the newline as a truthy string, and `dispatchPrompt` line 329 then incorrectly refused `composer_not_empty` before Send. Fix only this shared read boundary: normalize blank whitespace-only editors to `''`, and retain the exact bytes of all nonblank prompts including leading/trailing spaces and multiline content. The test using the actual content.js closure was RED before the fix and must be GREEN after it. No extra state, Work, effect or fallback writer is introduced.

Despite this source improvement the original Forge and iOS pre-send operator grants are exhausted, Android requires exact physical binding recovery, and G0b/G4 live first Send and three-round proof remain pending. Do not weaken the existing preflight or unknown-Send safety contracts to manufacture success.

### 2026-10-12 fresh Supervisor replacement and real ProseMirror multiline write proof

At the user's explicit request the three original Supervisor tasks were terminal-stopped through the canonical `supervisor_task stop` API only after each original effect ledger showed **zero dispatch generations and zero dispatch_started**. Three fresh standalone Supervisor tasks were registered instead, each with a separate Task ID, clean bootstrap effect, unchanged repository ownership, and a shorter current-goal objective. No old Work, Requirement, Plan or source commit was deleted or recreated. Fresh tasks are `supervisor:3ffffb37097d0926f2df4dfd` (Forge), `supervisor:ee55005515fd4a9968373909` (iOS), and `supervisor:de9f5e5fffe66ce8a5f58979` (Android). The deployed active Runtime 1791777422386-a3282542 reached healthy authorityRevision 831; Browser Adapter installation was projected onto it and its Chrome Extension was explicitly reloaded through the exact installed Chrome extension UI. Fresh task tabs were independently verified as Project-bound, empty and no-Send before refreshing their content scripts.

An iOS new-task single operator preflight rearm yielded event 36914 `composer_write_unconfirmed`, `send_clicked=false`, generation zero. Read-only inspection of its exact provider editor and immutable new-effect prompt proved that the 1887-character intended `payload + "\n@"` had exactly five newlines and was written to six direct `<p>` blocks with text length 1882 before block separators. Reading the *same complete payload* via `HTMLElement.innerText` produced 1892 characters and ten newlines (two between each block), causing the strict provider pre-send comparator to reject a byte-perfect editor draft. All six real DOM children were plain paragraph elements with zero intra-paragraph newlines. The correct single read path reconstructs text from direct ProseMirror `P` blocks joined by exactly one newline; only genuinely whitespace-only empty editors collapse to empty. For other editor shapes the conservative existing observation remains, preventing invented exactness. Immutable effect payloads, plugin chip identity, exact Project checks, provider Send fence and unknown-result safety remain unchanged. The real content-script regression was RED under the old `innerText` logic; full tests, release and G0b/G4 live acceptance must still be executed before declaring autonomy delivered. New tasks remain the sole live continuation authority; never restart the stopped historical ones.


## 14. 2026-10-12 最小发送链路减法（source candidate；未完成 live 验收）

- Supervisor bootstrap 和后续 effect 不再强制 `xhigh`，使用 ChatGPT 会话当前档位；Computer 的显式 reasoning API 仍可供其他调用者使用。
- Extension 新 tab 等待完整 composer hydrate，不再要求 reasoning picker；Forge 真实 App chip、完整 Prompt、effect CAS、unknown 禁重发保持不变。
- 精确 conversation 存在多个标签页时，Chrome worker 优先验证 Controller 已绑定 tabId/windowId，否则拒绝；多个 Extension instance 时不再靠前台窗口推测 browser profile。
- 没有证明纯文本提示在不绑定 Forge App 的情况下仍会调用 MCP，因此保留真实 App chip。ChatGPT 桌面 App 暂无更可靠外部发送通道的实测证据，不迁移。
- 现有隔离真实 G0b/G4 和 3 条业务 Task 的 causal receipts 仍是最终验收条件，不以通过源码测试替代。


### 2026-10-12 用户确定的验收策略

本主线不再新增测试案例或循环运行大规模自动化测试；本轮新增的 extension-worker 测试修改已撤回。后续以安装到运行中 Chrome 的精确会话发送回执、真实 Forge MCP causal CONTINUE → CONTINUE → DONE、切换会话和独立生产任务实际推进作为验收依据。保留原有未改动测试及安全约束；不通过删除其他人的未提交测试修改制造 clean tree 或假绿。

### 2026-10-12 全新目标会话 / Chrome App mention 真机根因与源修复

用户明确要求废弃旧 Supervisor 任务并改用新的独立目标会话。按 canonical Supervisor stop 回执，将 `supervisor:3ffffb37097d0926f2df4dfd`、`supervisor:ee55005515fd4a9968373909`、`supervisor:de9f5e5fffe66ce8a5f58979` 全部 STOPPED；不再恢复旧 tabs/effects。仅启动新的 `supervisor:37c1d807ce91731aa919b290`（Forge）、`supervisor:aafe5b660c19b13c6488657d`（iOS）、`supervisor:c764389c472e5e780a5c84cc`（Android），新 effect 分别为 `fx_e7e981f60452e9e07f0a4492c5088ed2`、`fx_78d916928144a66e732e2b19713d2521`、`fx_989fe32f7481cb46b75ad0b7c3261486`。三条任务的新 Chrome tabId 分别是 2095970480/2095970483/2095970486，均未产生 `effect_dispatch_started`（发送次数 0）。所有任务仍需等待真实首轮发送与完整三轮因果回执，不能仅凭注册成功宣称 ready。

三条新 Project 页最初意外包含相同的 79 字符无关草稿 `Use Desktop Commander Remote to find the 5 largest files in my Downloads folder`。仅在精确 Task/effect/tabId、Project URL 和全文相等、0 Send 后清理各自新任务的该草稿。新首轮预检均返回 `composer_not_empty`、`send_clicked=false`。Forge 新任务唯一的一次 operator preflight rearm 后又返回 `COMPUTER_CHATGPT_FORGE_PLUGIN_UNAVAILABLE`，仍无 Send；未再次 rearm。

真实 Chrome 页面、同一新 iOS Task 自有空编辑器上的**无发送探测**证明：在长篇 effect 正文尾部触发 `@forge` 时菜单缺失；空 ProseMirror 先输入单独 `@`，再输入 `forge`，页面正确显示 `[data-mention-section-items] > button` 中的唯一 `forge Current Forge 1.8.1 ...`；点击后编辑器出现 `app-mention-name="forge"`、`app-mention-path="app://asdk_app_6ac09022b26081918f20ff868c773824"` 的真实 App chip。然后在 chip 末尾追加两行受控文本，chip 保留，直接 P 段落可以按单换行重建精确内容。探测后验证删除全部探测文本和 App chip，未点击 Send。

对应唯一 Extension content-script 源改动：删除“先长文本、最后 @forge”的旧操作，先激活 `@forge` 的真正菜单并验证**唯一主 Forge App chip**，再在其末尾插入完整且未经截断的 immutable effect payload；在 Send 前再次核对 Project/Conversation identity、chip path、准确正文、Send 控件。仅允许字节级匹配本 effect 的旧未提交草稿原位修复，不覆盖任意非空用户草稿；旧 effect 提交预算、unknown outcome fencing 和 Supervisor 单 writer 不变，没有新增状态、Manager 或第二发送通路。

源码 `node --check` 与 `check-runtime-architecture.mjs` 通过；旧 `computer-chatgpt-reasoning-control.test.ts` fixture 与现行 exact Project guard 不一致、现有测试未通过；按用户指定不新增测试案例，也不以模拟测试代替真实生产验收。下一阶段仍必须先完成正常 code+release cutover、安装并重载精确 Chrome extension，以及新三任务真实 effect/browser/MCP receipt 后才可认定自主续跑可用。

### 2026-10-13 P0 Work semantic DONE convergence on current canonical Runtime source

The prior isolated P0 branch `573b4366` was not a current `main` ancestor, and could not be merged wholesale: alongside valid Work closure tests it contained obsolete `@forge` delivery and silent objective truncation in `supervisor/protocol.ts`. Current `main` had the necessary completion validator, but still treated `cancelled` Work as satisfying `forge_work_done` and missed `predecessorWorkId`/explicit `supersedes` and `supersededBy` successor links. This permitted premature DONE even while the accepted Goal's replacement Work remained open. A new isolated current-source test suite reproduced three failures (cancellation, successor, supersession) and confirmed parent/execution-child blocking already worked. No test required a new Work or a second semantic writer.

Only the P0 Work completion semantics were migrated into the existing Supervisor validator: Work-bound DONE now requires canonical `semanticState === 'completed'`; Requirement- and Work-bound descendant traversal includes existing predecessor/supersedes/supersededBy fields in addition to current parent/dependency edges. Terminal cancelled Work may still be terminal *for accepted Requirement lineage*, but does not independently prove successful Work delivery. Evidence and CAS semantics remain owned by Kernel WorkContract and Requirement, not by Supervisor. No changes to `supervisor/protocol.ts`, effect IDs, prompt rendering, App chip or scheduling.

These source and isolated regression proofs are **not** authorization to close arbitrary old Work: each actual Work still requires evidence-backed revisioned semantic completion. Production cutover and real business acceptance must be independently verified before declaring the overall autonomous Goal DONE.

### 2026-10-13 Work liveness must not re-register historical terminal Supervisor tasks

Live canonical Runtime stderr repeated `WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT` for Avela Work `work-avela-ios-quantity-stepper-direct-entry-20261008`. The source-of-truth Supervisor SQLite already contained exactly that Work-derived Task ID, its immutable original bootstrap objective and the durable `terminal_stopped` event; subsequent `task_objective_revised` and changes to Work/Requirement execution context mean a new call to `task_register` cannot be interpreted as the same immutable registration. The Scheduler's existing liveness loop rescanned the still-open Work, reached `ensureWorkflowSupervisorEnrollmentForWork`, and either returned a misleading lower-layer reason or tried to re-register the stopped task. This caused repeated terminal-task conflicts and noisy log volume without any legitimate new Work delivery. It is not a reason to create another Work, a second Supervisor, or to clear the stopped Task ledger.

Use the single existing Work → Supervisor enrollment composition and the canonical daemon read RPC before registration: if the same exact `repo_id` and `work_id` already have a Work-derived Supervisor Task, project its live/terminal state from the canonical Supervisor effect ledger; terminal state is an explicit `lower_layer_not_ready` skip with reason `WORKFLOW_SUPERVISOR_TASK_TERMINAL`, not a new enrollment. For a live Work-bound bootstrap task with no exact Work conversation binding yet, reserve its existing canonical enrollment effect instead of replacing its objective or recreating it; verify that the preserved Requirement identity still matches the Work, and fail closed on owner/Requirement conflicts. Existing exact-conversation authority continues through the prior conversation lookup. This creates **no new lifecycle state, manager, task, effect, writer or compatibility track**.

The concrete Supervisor socket fixture regression proved RED before the change (stopped task incorrectly reported `CONTROLLER_ROUND_NOT_PREPARED`) and GREEN afterward, also asserting active-task effect/objective identity is unchanged. Full tests, gates, source review and production Runtime activation are separate from this regression. No old STOPPED task is resurrected and no newly active Forge/iOS/Android conversation is replaced.

### Standalone Supervisor continuation — canonical Work binding

For standalone Supervisor tasks lacking an explicit Work field, resume context is resolved read-only from a **unique, exact ChatGPT conversation binding** in the existing canonical Work binding store. No Work identity is inferred from objective prose, and zero/multiple matches fail closed. This read only informs advisory cognition (bounded Work objective and recent resultRefs) and Work progress; it never replaces the full standalone Supervisor objective. The Supervisor Task/effect ledger remains the sole continuation/send authority. Existing explicit Work IDs continue to take precedence.


### 2026-10-14 Final-response receipt preservation (source correction; live acceptance pending)

The active `1a03e0d1799abf778cb83ff72fe2c390cda59cdd` Runtime sent enrollment effect `fx_40106e1827c6911bf4ae78da0c489643` exactly once (event 37739, generation 1), bound Task `supervisor:be9e9566f65a66601d16ee53` to conversation `6acec09e-8428-83e8-886d-a910250bb086`, and observed provider idle (37742). The real completed assistant reply ended with a separate paragraph `C ef207b8`, but no completion was committed. Two source defects broke the same receipt contract: Chrome messageText collapsed all whitespace, destroying the final-line boundary; compact parsing recomputed the challenge from the now-bound conversation (`0d3490b`) instead of the immutable sent bootstrap prompt (`ef207b8`).

Computer now preserves message text line boundaries, matching the native provider. Supervisor validates a V2 receipt against the persisted effect envelope after checking its schema, Task ID, effect ID, and challenge shape. Historical non-V2 prompts retain their existing parser compatibility. Exact conversation binding, applied-effect admission, final-reply observation, unique completion/successor transactions, and unknown-send protections are unchanged. No schema, lifecycle, owner, retry budget, or new automated test case is introduced. Existing pending effects can be observed after deployment without resending or rewriting history. This supersedes the earlier MCP automation-receipt writer design: only the completed assistant response closes a new outer turn.


### 2026-10-14 Stale browser extension snapshot compatibility

The live Supervisor continued to observe provider idle and reserve recovery after the source and Runtime had been updated. The installed Chrome extension can retain an older content script that collapses final-reply newlines; a Runtime deployment does not by itself reload that script. A focused existing Computer target-router regression reproduced the flattened final receipt while the native observation retained its last-line marker. The preferred target router now uses the existing native compatibility provider **read-only** when an idle assistant answer ends in a flattened compact-receipt candidate. It accepts that evidence only when the native target has the same durable target ID and returns a completed assistant answer with a real final-line marker. Unavailable or foreign native evidence cannot change the selected sender. Completion challenge/Task/Effect checks and no-replay authority remain unchanged. Live completion and source-production proof remain separate acceptance gates.


### 2026-10-14 Late completed reply behind an unsent recovery

Live task `supervisor:be9e9566f65a66601d16ee53` showed a completed `C 0d431d1` final reply but no new completion. A previously reserved recovery had failed its **pre-send** composer check (`composer_not_empty`), and the native consumer returned immediately on that blocked status. The source lookup also excluded the already-applied parent merely because the recovery child existed, even though no dispatch had begun. A focused regression reproduced the missing completion context and the stale recovery winning pending selection. The consumer now retains bounded read-only observation of the already-applied obligation without clearing the composer or sending the blocked recovery. The existing Supervisor journal derives the applied parent as eligible for a late receipt only until a child recovery actually starts dispatch, and excludes a never-applied recovery if its parent completion has committed. Existing challenge, exact-conversation, minimum-turn-spacing, and unknown-send boundaries remain unchanged. Live deployment and autonomous source-production acceptance are still separately required.


### 2026-10-14 Static review: late receipt versus recovery dispatch

Static review found that pending selection could hide an already-dispatched recovery after a parent completion, completion and recovery dispatch lacked transactional exclusion, and a queued first recovery skipped observation of the completed source reply. The existing Store now retires only never-dispatched recoveries. Within its existing immediate transaction, parent completion rejects a recovery that already has dispatch intent, while recovery dispatch rejects a parent that has completed; historical exact completion replay remains unchanged. The native consumer observes an idle assistant reply before dispatching a first recovery and then polls again. Unknown outcomes remain observable and cannot authorize resend.

No schema, lifecycle state, provider path, retry budget, or additional owner is introduced. This is a static-review correction; runtime deployment and real continuation acceptance belong to the separate validation work and are not claimed by this change.


### 2026-10-14 Native ProseMirror empty placeholder preflight correction

On the live Forge Supervisor task, the native macOS Computer provider repeatedly reported `composer_not_empty` during an otherwise unsent recovery preflight while the Computer read-only editor view appeared empty. Inspection found that the native preflight used raw `innerText` as the draft-presence test; a rendered empty ProseMirror `<p><br></p>` can report a layout newline. An existing native provider fixture reproduced RED (`composer_not_empty` for that strictly empty placeholder) and GREEN after recognizing exactly one `P` child with a `BR` and **literally empty** `textContent`. A second RED/GREEN guard ensures whitespace-only text with a trailing `BR` remains a protected draft. No composer content is cleared outside existing confirmed same-turn preparation, no previously applied Effect is replayed, and source-level regression success is not represented as live autonomous completion.


### 2026-10-14 Remove observation-time provider rebinding (static candidate)

Review of native `ensureExact` proves it can bind a different physical tab or create one after enumeration; equality of a logical targetId does not make this operation read-only. The router now deletes both observation-error reattachment and flattened-receipt native fallback, including the mutable selected-provider variables. Each returned target keeps its original observe/prepare/dispatch owner. This replaces the stale-snapshot compatibility section above; its historical regression case is removed with the retired behavior. Existing no-cross-provider mutation checks remain.

Initial pre-mutation provider selection and inventory remain unchanged pending the agreed same-scenario transport comparison. This deletion does not claim a globally single transport, reliable historical baseline, or live acceptance. No state, schema, recovery strategy or provider is added. Runtime validation must use a current extension script; flattened final replies now remain visible as unaccepted evidence instead of silently switching providers. This source candidate is not deployed by the static-review work.


### 2026-10-14 Remaining identity audit at `20e3e5860` (not live proof)

The remaining root cause spans selection and recovery, not reply formatting:

- `chrome-extension/background.js` initializes `PROVIDER_INSTANCE_ID` with a random ID at worker load. `chatgpt-extension-target.ts::selectProviderInstance` permits the sole fresh instance when the previous instance is absent; `ensureExact` falls back from a same-instance tab/window match to another instance. Thus worker identity is ephemeral and tab/window numbers alone cannot prove browser-profile continuity. A reconnect fix must distinguish a restarted worker from a different profile, using the existing Computer binding authority; neither arbitrary first match nor foreground focus is acceptable. No new identity store is authorized by this finding.
- `chatgpt-extension-target.ts::findBySubmittedMarker` deduplicates matches by conversationId before binding the first match. `chrome-extension/background.js::executeFindMarker` scans every matching tab and does not use the supplied bootstrapKey to select the original physical tab. Consequently, two physical tabs with the same conversation and marker become one ready result, bypassing `native-browser-adapter.ts::reconcileBootstrapTask`'s multiple-result ambiguity check. A correction must select a proven original binding before writing it, or preserve ambiguity without writing a winner. Removing only the Set would still bind competing targets and is not a complete correction.
- The router still performs native selection after initial extension failure and native marker search after an empty extension result. Removal of observation-time switching does not establish a globally unique provider across polling rounds. A final transport decision must cover ensure/open/marker recovery/promotion and cleanup together, including existing native-owned bindings; do not simply delete one fallback or silently adopt legacy targets.

Historical comparison: immediately before `1a03e0d17`, `observeAutomationReceipt` accepted a tool status, synthesized `automation:<status>:<receiptId>:<effectId>`, and called `reserveContinuation` without observing a completed assistant reply. Current code requires the final-reply receipt. Old completion counts therefore do not prove the new terminal-reply contract, nor establish a safe historical rollback point.

Next evidence needed from the separate live-validation work: the exact original Task/effect, pre/post-reconnect provider instance and physical tab/window binding, all same-URL candidates, actual submitted marker and final reply, and the active source/Runtime/extension versions. Use that one scenario to decide provider and identity continuity, then implement the whole selection/recovery correction as one candidate. Until that evidence exists, do not infer reliability from counts, choose a new transport on assumption, or publish another local identity patch. No browser or Runtime operation was performed for this audit.

### 2026-10-14 Terminal receipt after legacy extension whitespace normalization

The existing Supervisor task has a real completed assistant reply ending in `C 0d431d1` on its uniquely bound Chrome tab. The source Effect `fx_1eb8719c59fea476bf63b004a34bb69d` and persisted prompt validate that challenge, but the running consumer did not commit a second completion; the prior Chrome content-script version applied `core.normalizeText` to whole assistant messages, eliminating the required newline before the terminal receipt. Source updates, a page reload and a healthy Runtime alone do not prove the installed extension script was refreshed. This is a specific input representation incompatibility, not permission to create another target, resend the recovery, or resurrect an old effect.

The existing single Supervisor receipt parser now accepts a terminal `C/D/U` challenge token in **one-line whitespace-flattened replies only**. A reply containing any real newline still requires a separate terminal receipt line. In both cases, the parser validates the challenge against the exact immutable submitted Effect prompt, and the Computer consumer still requires the exact conversation, a fully idle assistant turn and an applied causal Effect. No new writer, observation provider, state, recovery effect or metadata is introduced. RED/GREEN tests cover flattened completed text, challenge mismatch and rejection of inline tokens in multiline text. Live completion and unattended multi-turn engineering output remain separate acceptance gates; neither is implied by this source change.

### 2026-10-14 One physical marker target after duplicate conversation matches

The original Extension marker discovery loop bound the first matching physical tab and deduplicated by `conversationId` before the Supervisor could detect multiple matches. The correction collects all physical matches, compares the full provider instance/browser/window/tab/owner-token binding, and lets the task-specific bootstrap pin outrank any existing conversation surface for the same `conversationId`. If the exact bootstrap pin is absent from marker results, the result stays unknown even when another conversation surface has the same marker; duplicate matches without a proven pin remain unbound. The focused regression proves both no-write ambiguity and pinned-target precedence. No second owner, lifecycle state, fallback transport, or recovery replay is added.
