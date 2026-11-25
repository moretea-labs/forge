# Forge 工具使用最佳实践

## 目标与边界

Forge 是模型的本地执行环境，不是替模型理解代码的检索代理。**模型负责决定搜什么、为什么搜、何时扩大范围；Forge 提供直接、可靠的 Shell、文件读取、编辑和验证能力。**

- 源码发现默认使用 `execute_command` 执行 Shell 命令。
- 精确阅读使用 `read_repository_file`，按路径和行范围读取。
- `rh_context` 不再提供源码搜索、候选排序、源码片段打包或 Context Closure。
- CodeGraph / 结构索引不属于当前源码发现路径。
- `rh_context.list` 用于能力发现；`rh_context.get` 用于仓库/运行状态，以及显式的 Cognitive 召回或符号导航。
- Cognitive 记忆只提供建议，不授予权限、执行或验收权。

## 默认检索循环

从小范围开始，沿着实际证据逐步扩展，不要先构建一份大而全的 Context Pack。

```bash
# 1. 按文件名定位
rg --files src | rg 'repository|context|scheduler'

# 2. 搜索函数、类型、字段或日志标识
rg -n -C 3 'runProcess|ProcessRecord|contextClosure' src adapters tests

# 3. 查看命中位置附近的真实源码
sed -n '120,220p' src/runtime/example.ts

# 4. 追踪调用方、实现方和测试
rg -n 'runProcess\(' src adapters tests
rg -n 'ProcessRecord' src packages tests

# 5. 查看当前修改和历史
git status --short
git diff -- src/runtime/example.ts
git log -S 'runProcess' --oneline -- src/runtime/example.ts
```

随后使用 `read_repository_file` 对确定的路径做精确读取。大型文件优先读取相关范围；需要完整理解类型、状态机或协议时，再扩大到完整文件。

## 如何逐步扩大搜索

1. **入口**：从用户可见行为、命令、工具名、路由、公开 API 或界面事件开始。
2. **实现**：搜索调用的函数、状态字段、事件、持久化和副作用。
3. **反向调用**：查找所有 callers、注册点、调度器、transport 和未修改的入口。
4. **验证面**：搜索相关测试、fixture、脚本、文档、配置和发布清单。
5. **停止条件**：模型能够解释真实数据流、所有相关入口和受影响验证面后停止；发现新依赖或源码变化时再定向扩展。

中文需求对应英文标识符时，由模型自行提炼英文函数名、类型名、字段名和业务短语，分别检索。不要期待 Forge 自动翻译或语义推断。

## 什么时候使用 rh_context

### 能力发现

`rh_context.list` 可按自然语言意图查找可用的 typed capability，再使用对应的执行器。它不是源码搜索入口。

### 仓库与运行状态

`rh_context.get` 返回有界仓库、检查项、进程和待处理事项摘要。仅在这些状态会影响当前决策时调用，不作为每次编辑的固定前置步骤。

### Cognitive 召回

当历史项目决策、用户纠正或已知经验可能改变当前判断时，才通过 `rh_context.get` 的 query 显式召回。记忆是 advisory；模型需要核对当前源码和最新用户决定，不能把旧记忆当作当前事实。

### 编译器符号导航

当已经定位到具体文件和符号，并且需要准确的定义、引用或实现关系时，可在 `rh_context.get` 中显式提供 `semantic_navigation`（path、line、column、navigation）。这是按需 LSP，不是普通搜索的默认步骤。

- TypeScript 使用短生命周期 Language Service。
- Swift 使用现有 SourceKit-LSP/build settings；Forge 不会为导航隐式触发构建。
- 其他语言仅在已安装语言服务器和项目环境可用时导航。
- 返回结果必须结合当前源码验证；LSP 结果不是代码或验收权威。

## 编辑与验证

- 已知路径的修改优先使用 `capability_execute(repository.direct_edit)` 的 sessionless atomic CAS。
- Shell 用于搜索、阅读辅助、Git 和本地命令；不要通过宽泛脚本覆盖未知或其他 Writer 的 dirty。
- 写入前核对目标文件最新内容，只对真实重叠片段做语义合并。
- 选择与改动风险相称的定向测试、构建或运行验证。编译通过不等于模拟器或真机验收。
- 复用当前会话已读取的源码和测试结果；只有文件变化或证据不足时才重读，不要每轮重新做全仓库搜索。

## 不要做的事

- 不调用已退役的 `rh_context.search`。
- 不恢复 Context Pack、Context Closure、CodeGraph 或另一套源码候选索引。
- 不为普通任务自动加载大量源码、历史记录或所有关联模块。
- 不因结果数量、Top-N、命中率或单次检索返回成功就宣称语义完整。
- 不把 Cognitive 召回、Capability discovery 或 LSP 导航混成普通源码搜索。
