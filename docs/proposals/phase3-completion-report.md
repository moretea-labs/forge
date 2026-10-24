# 源码瘦身与效率验收状态

日期：2026-10-23。关联：[GitHub #312](https://github.com/moretea-labs/forge/issues/312)。

原 Phase 2/3 方案和完成百分比、10～20 倍收益声明已撤回：缺少生产接入与可比真实任务回执，不再作为实施或验收依据。原文保留于 Git 历史。

## 已核实与退役

批写、读写锁、请求上下文没有生产消费者；批写 savedMs 由写入数乘常数推算，不是实测事务耗时。本次删除这些模块及只验证占位 API 的测试。

普通编辑复用 begin_edit_session/apply_patch/verify_edit_session/finalize_edit_session；命令复用 execute_command、ExecutionSession 和现有 Process。删除重复轻量会话 writer，历史 lightweight_work_session SQLite 记录保留，不做 schema 迁移。旧 lightweight=true 在写入前拒绝并指向现有路径，避免意外创建 Work。

Work 准备恢复实时 Git 状态读取，移除跨请求五秒 TTL 缓存及验证包装，保留权限、CAS、checkout writer 与集成 checkout 唯一性检查。不改变 placement 选择规则，不新增锁、缓存或异步写入改造。

## 待验收义务

沿用 #312：三组同类真实任务 A/B，首次有效修改、无效前奏调用及完整交付耗时目标各降低至少 30%，成功率不降、重复外部副作用为零。异构历史样本或接口微基准不能充当有效基线；当前尚未证实这些目标。

源码修改、main 集成、Runtime 激活、实际效率收益分别核实。本次报告不声明 Runtime 已激活此候选。检查和独立审查回执记录于原 #312 与既有上下文。
