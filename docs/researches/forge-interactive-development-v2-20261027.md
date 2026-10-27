# Forge 连续开发工作流 v2：第一阶段调查

最新源码修复状态见 [#475 源码检查点](forge-interactive-development-v2-20261027-fix475.md)；下文保留各次历史调查和回放边界。

日期：2026-10-27。范围：交互式源码开发效率。源码观察点：`fb75fbbb7e3d2db99b4bbdb9ac64e8032becb575`。

## 决策与当前状态

沿用用户提供的 v2：模型在当前会话中连续调查、修改、检查和完整 Diff Review；Forge 提供组合能力，不增加第二套开发模式、Agent Loop、Execution Context 生命周期或任务状态机。普通开发不强制创建 Requirement / Plan / Work / ControllerRound / Supervisor。

**本次完成源码调用链核查和三个历史案例的局部时间线重建，尚未完成第一阶段验收。** 原始请求起点、完整交付终点及同配置对照不足，无法诚实地选出耗时最大的两个非生产性环节。因此没有修改生产执行路径，没有启动第二阶段优化或 Runtime 切换，也不声明达到 30% 目标。

既有 [#312](https://github.com/moretea-labs/forge/issues/312) 当前为 CLOSED；其混合了源码瘦身、主机同步、自动续跑等历史范围，不能作为当前三组源码任务的完整性能基线。既有 [效率验收状态](../proposals/phase3-completion-report.md) 也明确保留三组真实 A/B 义务。本报告仅记录本次交互式源码调查，不承接其他任务或修改其状态。

## 已核实的调用路径

| 位置 | 可核实事实 | 本次判断 |
| --- | --- | --- |
| `src/runtime/control-plane/facade/goal-workloop.ts` | `routeWorkStart` / `startGoalWorkloop` / `continueGoalWorkloop` 处理显式 Work；固定 placement 仍是 auto/current、显式 isolated | 函数存在不证明普通编辑被迫调用它；未获得逐任务冗余调用证据，不修改 |
| `src/cli/editing/edit-session.ts` | `applyEditOperations` 递增 Revision；检查失败不关闭 Session；保留 revision、文件指纹、base revision 约束 | 现有能力已经支持连续修复；没有发现按 Revision 次数强制结束的逻辑 |
| `src/runtime/execution/process-runtime/check-scheduling.ts` | `buildCheckExecutionSchedule` 复用资源 claim 冲突模型，产生兼容 wave | 复用现有能力；不新增并行调度器 |
| `src/runtime/control-plane/execution/work-verification-service.ts` | 批量验证校验同一 wave，再通过 `Promise.all` 调用现有验证路径 | 有真实重叠回执，不能将其重复“优化”为新能力 |
| `src/runtime/diagnostics/mcp-timing.ts` | 已记录 layer、startedAt、requestId、tool duration、分阶段时间及会话关联；诊断写入有界、尽力而为 | 复用现有数据；不能把服务端耗时当成客户端完整往返 |
| `src/runtime/control-plane/execution/work-preparation-service.ts` | `execution-tools.ts` 的 `work_prepare` 分支仍调用 `prepareWork`，`session_bind_repository` 仍调用现有绑定入口 | 仍有实际消费者，不删除整个模块，不恢复已退役 lightweight 路径 |

另做了一次实际 Forge 插件调用：`execute_command(workspace_root=<当前 checkout>, command=["git","status","--short"])` 返回 `process_direct / readonly_fast_path`，服务端耗时 259.11ms，未要求先创建 Work。这只证明该次只读命令的直接路径；不是源码任务 A/B，也不是写操作安全验证。

`recordEditSessionProcessCheckReceipts` 已校验 repo、checkout、Session、Revision 和回执矛盾；不能为了复用检查而去掉这些绑定。更广的输入、定义、环境匹配继续由既有 Check authority 负责，本次不放宽。

## 历史证据与计时口径

读取的现有 Controller Home 证据（只读）：

- `~/.forge/controller/repositories/repo_123b7cf58b6b17b5cbe46a56/edit-sessions/<ID>/session.json`
- 同一仓库 `controller/worklog.jsonl`、`processes/<processId>.json` 和 `audit/commands.jsonl`
- `~/.forge/controller/audit/mcp-timings.jsonl` 及其 `.previous`；旧 `~/.forge-controller/audit` 为空

初次统计时当前 timing 文件有 43,522 条记录，时间范围为 2026-10-24T22:44:47.097Z 至 2026-10-27T09:16:32.457Z。包含 canonical_runtime 21,873 条、public_gateway 21,589 条、无 layer 60 条。两层通常是同一次调用的嵌套 span，不能相加当成工具调用量或墙钟成本。仓库命令审计在下述测试恢复案例的 Session 窗口内没有匹配记录；不能据此断言当时没有执行命令，Process 记录证明命令确实执行过。

下表用 Session 创建至首个 Revision 记录、创建至 finalized 的差值。它们**不是用户请求至首次有效修改、也不是完整交付时间**；Revision 记录时间也不是每个文件的精确写入时刻。Session finalized 不证明独立 review、集成、Runtime 激活或用户验收。三个案例是不同任务，不是前后 A/B。

| 案例 | Session ID | 文件 / Revision | 创建至首 Revision | 创建至 finalized |
| --- | --- | --- | ---: | ---: |
| 明确的小型修复：#446 本地 Codex send 重复 --version 准备 | EDIT-1792808472817-d1e1d20b | 2 / 1 | 16.397s | 87.990s |
| 多文件修改：#432 WorkHandle retention 归属识别 | EDIT-1792810595279-02ecb365 | 3 / 2 | 15.996s | 185.309s |
| 测试失败后修复：#434 隐式 Session / WorkHandle 集成 | EDIT-1792809296173-45aa949d | 4 / 6 | 168.950s | 608.435s |

精确历史源码起点分别为：

1. `adebdc4077131648bda5255c95b9d27c1849354b`，2026-10-24T02:21:12.817Z 创建，02:21:29.214Z 首 Revision，02:22:40.807Z finalized。
2. `ea0e71a54db1b221dee41bd9f8a26962aba9090e`，2026-10-24T02:56:35.279Z 创建，02:56:51.275Z 首 Revision，02:59:40.588Z finalized。
3. `3544dbf34c2dbded212685dd112a0bae0c9290c9`，2026-10-24T02:34:56.173Z 创建，02:37:45.123Z 首 Revision，02:45:04.608Z finalized。

### 失败后连续修复的实际时间线（UTC）

| 时间 | 原始证据 | 结果 |
| --- | --- | --- |
| 02:40:30.979 | Session Revision 3 | 修改 |
| 02:40:44.208–02:40:46.160 | proc_mvlskmul_1977f9cf | 定向 Gateway 测试 exit 1 |
| 02:41:08.895 | Session Revision 4 | 再次修改 |
| 02:41:15.294–02:41:18.497 | proc_mvlslau5_7d03d0d0 | 扩展定向测试 exit 1 |
| 02:42:06.386 | Session Revision 5 | 再次修改 |
| 02:42:14.486–02:42:17.787 | proc_mvlsmkic_aff67cfc | 定向测试通过 |
| 02:42:45.025 | Session Revision 6 | 同 Session 继续修改 |
| 02:42:58.365–02:43:45.426 | proc_mvlsnid5_f692a88a | 完整 Gateway 测试文件通过 |

两次失败完成至下一 Revision 记录分别为 22.735s、47.889s。它们是可观察的“失败至再次修改记录”间隔，缺少客户端结果接收时间和调查调用，不能当成模型时间、纯空转或 v2 的有效恢复性能验收。定向测试的选择也发生了变化，不能据此计算同任务失败率。

### 检查重叠和回执复用

多文件案例有两项通过回执：`proc_mvlt80jk_b0ce0c8f`、`proc_mvlt81fu_5ece11be`；记录的执行区间总和为 39.708s，区间并集为 25.253s。

失败修复案例有三项通过回执：`proc_mvlsovje_df0cf904`、`proc_mvlsowb1_f18e954c`、`proc_mvlsoxc4_b61dec58`；记录的执行区间总和为 57.131s，区间并集为 23.263s。三项启动分别是 02:44:02.094Z、02:44:03.088Z、02:44:04.425Z，末项结束为 02:44:25.357Z。该连续并集也是此组执行 span 的墙钟覆盖区间；不包含未记录的提交/排队/返回成本。

上述五项回执均标记 `reusedExecution=true`，证明存在既有共享执行证据，不能把重复接收回执算成新的物理检查。第一个小修复 Session 的 `checkResults=[]`；其 reviewNote 声称既有检查通过，但不能拿这段文字补算本 Session 的检查时间或精确候选验证。

## 尚不能归因的指标

| v2 指标 | 当前证据边界 |
| --- | --- |
| 请求至首次有效修改、总交付墙钟 | 缺原始用户请求及最终交付时间；只有局部 Session 窗口 |
| 模型时间 | 缺可信模型阶段时间戳；全部保持未知 |
| 工具往返 / 实际执行 | 三个案例早于保留的 MCP timing；部分 Process 执行区间仍在 |
| 状态协调 / 无信息增益调用 | 缺完整调用参数、返回和语义用途；相同工具名、相同结果并不自动代表冗余 |
| 检查与 Review | 有部分精确检查回执；独立 Review 完整区间缺失，#434 finalize note 明确写了 independent review pending |
| 模型配置、tokens、费用、最终成功率 | 原始受控样本和可核验账单不足；不估算 |

**最大的两个非生产性环节：尚未证实，不能排名。** #446 曾有重复准备的历史修复，但已经改过的旧路径不是当前新优化点。也不能把 168.950s 的首 Revision 前间隔直接指认为无效准备。

## 下一步与验收约束

先补齐三类案例的原始会话/任务标识、请求和交付时间、完整调用参数与结果、固定模型配置，以及真实 checkout / 基线 / 验证标准。优先显式导出现有记录；缺失历史证据时，从下一组三类真实任务按同口径采样，不增加遥测服务或运行时状态机。

时间分析按请求关联 public_gateway 与 canonical_runtime，工具往返依赖客户端时间；内部 span 先确认嵌套关系。用途标签与时间组成分开；并行区间取并集/关键路径。无法归因的间隙保持未知，不从“墙钟减去工具时间”推算模型思考。

只有证实冗余并找出实际调用位置后，才选择一个可独立回退的最小执行路径修改。随后按相同模型、等价输入、相同源码起点和验收标准做真实 A/B；报告首次有效修改、总交付时间、无信息增益调用、失败恢复、成功率/质量及可核验成本。10%–15% 的小样本信号不算验收，30% 是争取目标而非本次结果。无改善撤回优化，必要核验和 Review 不减免。

本次仅增加本报告；autonomous-continuation、Supervisor、#313 外部 effect 和另一个 Codex 的上下文优化未修改。未新增服务、持久事实源、状态、Writer、授权、重试、fallback 或 Runtime release。当前目标保持未验收，待证据补齐后继续同一调查。

## 追加实验：用户指定使用 Forge 源码小任务（2026-10-27）

用户随后指定“用 forge 源码做小任务测试”。已在同一源码 revision 的临时副本完成三个任务，并对现有 `execute_command` 的调用组合方式做初步对照。[原始回执、计时、候选哈希和实验脚本](forge-interactive-development-v2-20261027-pilot.json) 随报告保存。

### 实验边界

这是**真实源码上的故障注入与确定性修复回放**，不是新发现的生产缺陷，也不是最终模型 A/B 验收。实验由当前同一 Controller 会话执行；没有启动另一个 Agent，没有更换模型，但未获得该会话精确模型 ID / reasoning 配置和 tokens。先准备已知补丁，再回放组合调用，不测盲查问题的能力。CLI 默认配置虽然被查看过，实验没有使用 CLI 模型，不能拿它充当实际配置。

三份起点来自 `git archive fb75fbbb7e3d2db99b4bbdb9ac64e8032becb575`，各自有独立 Git index 和限定修改路径；Node 依赖复用当前 checkout。对照副本的注入后文件 SHA-256 逐项等于基线起点。实验脚本和行为断言只保存在临时目录与 JSON 附件，没有进入生产模块或测试套件。行为检查的 Controller Home 显式隔离到临时目录。

- 小 Bug：把 `normalizeEditOperation` 的 prepend 错误转换为 append；检查操作类型保真。
- 多文件：从公开操作枚举删去 append，同时把实际 append 执行误写为 prepend；同时修复契约和执行器。通过真实注册、存储绑定、Edit Session、文件修改与 finalize 验证文件最终字节和 Revision。
- 失败后修复：把调度 wave 的“零冲突”条件改为“冲突数大于等于零”；运行原有 `check-scheduling.test.ts`，从 3 pass / 3 fail 修复到 6 pass / 0 fail。

三个任务都保留原有检查；两种方式修复后的限定源码 SHA-256 完全相同。每个候选的完整 Diff 已读取并由当前 Controller 自审，独立审查未执行，因此不声称通过独立验收。

### 对照方式与结果

分散调用依次执行调查、复现检查、修改、通过检查、输出完整 Diff，共 5 次工具调用；失败恢复案例先检查后调查。组合调用保留同样步骤及顺序，分为调查/复现和修改/检查/Diff 两次调用。修改后的检查若失败，组合命令立即非零退出，不继续生成完成结论。最终 Diff 仍返回给模型审查。

任务起点取首个正式实验工具调用发出时间；终点取完整 Diff 返回时间。首次写入在修复脚本中即时记录。下表**不包含任务设计、准备脚本、源码复制、补丁预编写、实验整理、最终用户交付或独立 Review**，因此不能命名为用户请求至首次修改或完整交付墙钟。

| 任务 | 调用数（分散→组合） | 首次写入（秒） | 至完整 Diff 返回（秒） | 累计工具往返（秒） |
| --- | ---: | ---: | ---: | ---: |
| 小 Bug | 5 → 2 | 29.476 → 3.575 | 45.732 → 4.657 | 34.082 → 4.657 |
| 多文件 | 5 → 2 | 14.255 → 3.029 | 21.204 → 4.696 | 13.851 → 4.696 |
| 失败后修复 | 5 → 2 | 13.190 → 2.562 | 17.407 → 3.681 | 13.836 → 3.680 |

失败恢复案例中，失败工具结果收到至下一源码写入为 9.571s → 0.869s。这是已知补丁回放间隔，不代表真实模型重新诊断和修复耗时。

所有正式任务调用都走 `ephemeral_workspace_bounded_direct / process_direct`；没有调用 Work / Plan / Session 状态查询。开始时有一次脚本路径超出所选 workspace 的 `COMMAND_SCOPE_DENIED`，往返 8.335s，尚未执行脚本。随后把 workspace 选为包含三个副本和实验脚本的共同父目录，正常执行。该拒绝源于本次实验的范围选择错误，不是已证实的 Forge 缺陷；原始失败回执也已保留。另有一次准备脚本使用本机 Python 不支持的 tarfile 参数而失败，已修正；准备时间同样不在任务表中。不能通过排除这些准备成本声称端到端开发收益。

### 耗时归因与下一步决定

分散方式正式调用往返合计 61.769s，其中回执报告的服务端时间合计 8.142s，实验子步骤实际执行合计 1.339s。往返减服务端约 53.627s 是服务端计时之外的残差，可能包含连接器、传输、客户端编排与调度；没有证据把它全部归因于网络或 Forge。服务端时间还包含启动、安全检查和结果处理，不能与内部子步骤重复加总。

组合方式往返合计 13.033s，服务端合计 1.927s，子步骤合计 1.079s。每个任务只有一次分散和一次组合样本，且组合始终后跑；缓存升温、链路变化和已知答案都会影响结果，不能把表中降幅解释成稳定因果收益。分散方式工具调用外间隙合计 22.574s，组合为 0.001s；这些间隙属于实验控制/准备与未知时间，不冒充模型推理。

已证实的可减少环节是：**本实验在不需要模型中间判断时仍把既定步骤拆成多次工具往返**。实际位置是小 Bug / 多文件的 `inspect → check-before` 边界，以及三类任务的 `apply → check → diff` 边界；附件保留每次 requestId 与时间。两个边界属于同一个调用组合问题，不包装成两个独立根因。当前仍不足以排出全工作流最大的两个非生产性环节。

因此暂不修改 Runtime 源码；优先让模型直接组合现有命令，在需要新判断、检查失败、授权或候选变化时回到模型。这是现有能力的使用改进，不增加 Context、Loop 或状态机。后续应进行多轮、交错顺序、固定可核验模型配置的真实盲任务 A/B，并把准备与最终审查纳入总墙钟。当前三例均修复通过只能报告样本内 3/3，不能推断成功率不下降。外部 effect、并发 Writer、跨重启和无依据 DONE 等边界没有被本地源码实验覆盖。

生产源码与 HEAD 均保持原状，当前仓库新增交付仅为本报告与证据 JSON；注入回归没有提交或发布。v2 的最终 30% 和完整真实交付验收仍然开放。

### 实验后的真实缺陷与检查结果

证据归档时，普通 `begin_edit_session` / `apply_patch` 成功，但 `verify_edit_session` 在启动检查前返回 `EDIT_SESSION_IDENTITY_MISMATCH: binding`。源码定位到 Gateway 使用 Work 专用的 `claimedSessionEditBinding`：无 Work 时返回 undefined，而非 Work Session 仍保存 repo/checkout/principal，因而正确的身份断言拒绝了缺失 binding。不能靠省略身份检查或制造 Work 解决。

已按仓库要求检索去重后，通过 [GitHub 插件](https://github.com/moretea-labs/forge/issues/475) 提交 #475；#303 是已关闭的 controllerInstanceId finalization 问题，不是同一验证阶段。独立 `run_check(package:check:type)` 的真实 Process `proc_mvqhs1ht_e1cf03b5` 已 exit 0；它没有替代当前 Edit Session 所需的精确 Revision 回执。报告/JSON Session `EDIT-1793093698789-481bfb17` 因此仍为 dirty，没有绕过校验、直接写 Controller Home 或宣称 finalize 成功。

这项缺陷是当前可复现的真实阻塞，优先级高于继续调优已知补丁回放：下一源码修改点应修正既有验证入口对非 Work 身份的派生，并保留 Work/principal/checkout/Revision 的反向安全验证。本轮没有实施该身份修复或切换 Runtime。
