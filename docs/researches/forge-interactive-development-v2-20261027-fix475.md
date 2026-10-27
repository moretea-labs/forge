# 连续开发 v2：#475 源码修复检查点

这是尚未完成的整体任务的源码检查点。此前的[调查与试验报告](forge-interactive-development-v2-20261027.md)及[回放数据](forge-interactive-development-v2-20261027-pilot.json)保留为历史证据，不能当成最终 A/B 验收。当前源码修复的[审查与真实 MCP 回执](forge-interactive-development-v2-20261027-fix475.json)独立保存。

## 当前修改与证据

#475 已在现有 Gateway 验证入口修复：普通 Direct Edit 从已解析 checkout 和已认证 principal 派生既有 binding；显式或存储的 Work 继续使用原 Work 身份解析。普通编辑不推断 transport Session 中无关的 Work。身份断言未删除；缺失/错误 principal 仍拒绝，且不产生 Process 或 Session 写入。

没有新增 API、持久 writer、schema、生命周期、进程、Context、重试、权限或 effect。身份仍由请求认证及 Repository/Work authority 所有；验证仍由原 coordinator 所有。资源 lease、Revision/输入/环境回执绑定、保留/恢复和完整 Runtime 回滚契约保持不变，无新部署单元或迁移路径。

源码基于 `fb75fbbb7e3d2db99b4bbdb9ac64e8032becb575`；三个已跟踪修改文件的完整 Diff SHA-256：`22af26b32f927971cf6eccb0bc409e55c82a8a8bef66f7ae3cd13d0900ae9feb`。独立审查后已核对字节未变。

- 复现 RED：`proc_mvqi633s_85a38267`，旧入口在缺失 binding 处失败。
- 定向 GREEN：`proc_mvqi6ibv_6852ad72`，2 项通过、28 断言。
- 相关编辑/检查回归：`proc_mvqi7wip_48e70711`，25 项通过、189 断言。
- 类型检查：`proc_mvqi92hb_c8600464`，exit 0。
- 模块边界：`proc_mvqiacqd_fb9edb10`，exit 0。
- 独立只读 Claude 审查（claude-sonnet-5-5）：**ACCEPT**，全文及模型用量在附件。
- 真实 MCP SDK 协议链：begin → patch → failed check → disconnect/reconnect → patch → passed check → finalize；同一 Session、2 次 Revision、0 Work。隔离 Controller Home，没有冒充已安装 Runtime。
- 首轮临时验收命令存在换行转义错误，原始失败保留；仅修复临时 checker，在新的隔离 fixture 重新验证成功，未为此改变生产候选。
- `check:task` Process `proc_mvqicb1k_86360b99` 的静态检查通过，但整个命令在本次设置的 300 秒预算耗尽后终止。日志有长度上限，不据此推断某个测试挂死或源代码失败。后续须按原测试预算、复用有效 checkpoint，继续同一候选的未完成检查；不得把超时报告成通过。

## 尚未完成

1. 最终 Git 候选交付（完整 task gate 已通过，见下方最新证据）。
2. 构建并验证完整候选发布；已通过既有本地 Recovery helper 确认当前 Runtime ready，source 为 2cc71021db0a291037c4755dc04ce9c1884417e6，尚不包含本修复。
3. 修复的实际 Runtime 激活、原实际 Home 下受阻 Edit Session 的精确检查和最终关闭。
4. 三类任务的受控真实模型 A/B：原始请求至首次修改、总交付、重复调用、失败恢复、成功率/质量和可核验成本。现有故障注入回放不满足这一条。
5. 两个最大的非生产性环节和至少 30% 效率收益的证据。调用组合只有回放样本信号，不能宣称最终达标。

已向用户请求本会话规则所要求的独立测试代理授权及固定本机模型配置；尚无回复时不启动代理、不把沉默视为授权。目标保持 active，不把本次源代码修复、局部绿灯或审查 ACCEPT 代替整体完成。


## 完整候选检查结果更新

原 5 分钟超时后，同一候选按较长预算继续检查并复用了原有有效 checkpoint。Process `proc_mvqiksc8_c75a5816` 已 exit 0：15 个测试文件被选中、14 个 checkpoint 命中、0 失败；Gateway 文件 70 项测试、605 断言均通过。静态架构、模块边界、类型、仓库卫生、生成权威和测试治理检查通过。没有为获得绿灯修改测试门槛。

本地 Recovery `runtime_status` 返回 ready=true，实际 Runtime 的 releaseId 为 `1793063073070-2cc71021db0a291037c4755dc04ce9c1884417e6`，authorityRevision=981；当前源码修复尚未激活。只读发布准入查询检查了 676 个 ReleaseSession，无损坏文件、无未终结 Session；没有接管或修改其他任务。`list_releases` 查询超时不改变上述独立已知事实。
