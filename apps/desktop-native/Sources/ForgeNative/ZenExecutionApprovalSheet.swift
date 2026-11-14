import SwiftUI

struct ZenExecutionApproval: Identifiable {
    let repoId: String
    let checkoutId: String
    let projectLabel: String
    let checkoutLabel: String
    let requirement: RequirementRecordDetail
    let status: AutopilotStatusDetail
    let plans: [ForgeRecord]

    var id: String { "\(repoId)|\(checkoutId)|\(requirement.requirementId)|\(requirement.revision)" }
}

struct ZenExecutionApprovalSheet: View {
    @ObservedObject var model: NativeWorkspace
    let approval: ZenExecutionApproval
    let onApproved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var maxTotalTokens: Int
    @State private var maxTurns: Int
    @State private var maxToolCalls: Int
    @State private var checkpointPlanIds: Set<String>
    @State private var acknowledged = false
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var outcomeUnknown = false
    @State private var staleRevision = false

    init(model: NativeWorkspace, approval: ZenExecutionApproval, onApproved: @escaping () -> Void) {
        self.model = model
        self.approval = approval
        self.onApproved = onApproved
        _maxTotalTokens = State(initialValue: min(500_000, max(1_000, approval.status.maxTotalTokens ?? 50_000)))
        _maxTurns = State(initialValue: min(48, max(1, approval.status.maxTurns ?? 12)))
        _maxToolCalls = State(initialValue: min(128, max(1, approval.status.maxToolCalls ?? 32)))
        let availablePlanIds = Set(approval.plans.map(\.recordId))
        _checkpointPlanIds = State(initialValue: Set(approval.status.checkpointPlanIds).intersection(availablePlanIds))
    }

    private var revisionIsCurrent: Bool {
        approval.status.requirementRevision == approval.requirement.revision
    }

    private var scopeIsCurrent: Bool {
        model.repoId == approval.repoId && model.checkoutId == approval.checkoutId
    }

    private var budgetRefreshOnly: Bool {
        !approval.status.requiresReapproval
            && approval.status.runStatus == "paused"
            && ["max_total_tokens_reached", "max_turns_reached", "max_tool_calls_reached"].contains(approval.status.stopReason ?? "")
    }

    private var stalePausedRun: Bool {
        approval.status.requiresReapproval && approval.status.runStatus == "paused"
    }

    private var runAllowsAuthorization: Bool {
        if approval.status.runStatus == "running" { return false }
        if approval.status.runStatus == "paused" { return budgetRefreshOnly || stalePausedRun }
        return true
    }

    private var tokenMinimum: Int {
        budgetRefreshOnly ? min(500_000, max(1_000, approval.status.maxTotalTokens ?? 50_000)) : 1_000
    }

    private var turnMinimum: Int {
        budgetRefreshOnly ? min(48, max(1, approval.status.maxTurns ?? 12)) : 1
    }

    private var toolCallMinimum: Int {
        budgetRefreshOnly ? min(128, max(1, approval.status.maxToolCalls ?? 32)) : 1
    }

    private var budgetIncreaseSelected: Bool {
        maxTotalTokens > (approval.status.maxTotalTokens ?? 0)
            || maxTurns > (approval.status.maxTurns ?? 0)
            || maxToolCalls > (approval.status.maxToolCalls ?? 0)
    }

    private var canApprove: Bool {
        revisionIsCurrent && scopeIsCurrent && approval.status.providerReady && runAllowsAuthorization
            && acknowledged && !saving && !outcomeUnknown && !staleRevision
    }

    private var providerLabel: String {
        switch approval.status.provider ?? "" {
        case "deepseek": return "DeepSeek"
        case "joycode": return "JoyCode"
        case let value where !value.isEmpty: return value
        default: return "Provider"
        }
    }

    private var actionTitle: String {
        if budgetRefreshOnly { return budgetIncreaseSelected ? "增加预算" : "续期预算" }
        if approval.status.requiresReapproval { return "重新批准" }
        return approval.status.authorized ? "更新授权" : "批准执行"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(approval.status.requiresReapproval ? "重新批准执行" : (approval.status.authorized ? "执行设置" : "批准执行"))
                        .font(.system(size: 17, weight: .semibold))
                    Text(approval.requirement.title)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(2)
                }
                Spacer()
                Text("v\(approval.requirement.revision)")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            Divider()
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("项目")
                    Spacer()
                    Text(approval.projectLabel).lineLimit(1)
                }
                HStack {
                    Text("Checkout")
                    Spacer()
                    Text(approval.checkoutLabel).lineLimit(1).textSelection(.enabled)
                }
                HStack {
                    Text("Provider")
                    Spacer()
                    Text("\(providerLabel) · \(approval.status.model ?? "默认模型")").lineLimit(1)
                }
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)

            Divider()
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text("Token 上限").font(.system(size: 11))
                    Spacer()
                    Stepper(value: $maxTotalTokens, in: tokenMinimum...500_000, step: 10_000) {
                        Text(maxTotalTokens.formatted()).font(.system(size: 11, design: .monospaced))
                    }
                }
                HStack {
                    Text("模型轮数").font(.system(size: 11))
                    Spacer()
                    Stepper(value: $maxTurns, in: turnMinimum...48) {
                        Text("\(maxTurns)").font(.system(size: 11, design: .monospaced))
                    }
                }
                HStack {
                    Text("工具调用").font(.system(size: 11))
                    Spacer()
                    Stepper(value: $maxToolCalls, in: toolCallMinimum...128) {
                        Text("\(maxToolCalls)").font(.system(size: 11, design: .monospaced))
                    }
                }
            }

            if !approval.plans.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 7) {
                    Text("人工验收节点").font(.system(size: 11, weight: .semibold))
                    Text(budgetRefreshOnly ? "预算续期时保持现有验收节点不变。" : "选择需要暂停并等待验收的 Plan。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                    ForEach(approval.plans) { plan in
                        Toggle(isOn: Binding(
                            get: { checkpointPlanIds.contains(plan.recordId) },
                            set: { selected in
                                if selected { checkpointPlanIds.insert(plan.recordId) }
                                else { checkpointPlanIds.remove(plan.recordId) }
                            }
                        )) {
                            Text(plan.title).font(.system(size: 11))
                        }
                        .toggleStyle(.checkbox)
                        .disabled(budgetRefreshOnly)
                        .accessibilityIdentifier("zen.execution.checkpoint.\(plan.recordId)")
                    }
                }
            }

            if !revisionIsCurrent {
                Label("需求版本已变化，请刷新后重新打开批准面板。", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10)).foregroundStyle(.orange)
            } else if !scopeIsCurrent {
                Label("项目或 Checkout 已切换，请重新打开批准面板。", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10)).foregroundStyle(.orange)
            } else if !approval.status.providerReady {
                Label("当前 Provider 凭据未就绪，暂时无法批准执行。", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10)).foregroundStyle(.orange)
            } else if approval.status.runStatus == "running" {
                Label("当前执行仍在运行，请先暂停后再重新批准。", systemImage: "pause.circle")
                    .font(.system(size: 10)).foregroundStyle(.orange)
            } else if approval.status.runStatus == "paused" && !runAllowsAuthorization {
                Label("当前运行正在等待人工验收，请先处理该节点。", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10)).foregroundStyle(.orange)
            }

            if stalePausedRun {
                Text("需求或 Checkout 已变化；批准后会结束旧的暂停运行，并绑定当前修订。")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
            if let errorMessage {
                Text(errorMessage).font(.system(size: 10)).foregroundStyle(.orange).textSelection(.enabled)
            }
            Text(budgetRefreshOnly
                 ? (budgetIncreaseSelected
                    ? "本次按调整后的上限开启新的预算窗口，历史累计用量保留。"
                    : "本次按当前上限开启新的预算窗口，历史累计用量保留。")
                 : "授权仅绑定当前 Requirement 修订与 Checkout，不包含远程推送、发布或破坏性操作。批准后仍需选择开始执行。")
                .font(.system(size: 10)).foregroundStyle(.secondary)
            Toggle("我已核对当前修订、执行预算和工作区范围", isOn: $acknowledged)
                .font(.system(size: 11))

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(actionTitle) { approve() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canApprove)
                    .accessibilityIdentifier("zen.execution.approve")
            }
        }
        .padding(22)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("zen.execution.approval")
    }

    private func approve() {
        guard canApprove else { return }
        saving = true
        errorMessage = nil
        model.error = nil
        model.planningAutopilotStatusError = nil
        Task {
            let succeeded = await model.controlAutopilot(
                requirementId: approval.requirement.requirementId,
                operation: "authorize",
                confirmAuthorization: true,
                expectedRequirementRevision: approval.requirement.revision,
                model: approval.status.model,
                maxTotalTokens: maxTotalTokens,
                maxTurns: maxTurns,
                maxToolCalls: maxToolCalls,
                checkpointPlanIds: checkpointPlanIds.sorted()
            )
            saving = false
            if succeeded {
                dismiss()
                onApproved()
                return
            }
            let message = model.error ?? model.planningAutopilotStatusError ?? "授权未完成，请刷新执行状态后再试。"
            errorMessage = message
            outcomeUnknown = message.contains("操作结果未确认")
            staleRevision = message.contains("AUTOPILOT_REQUIREMENT_REVISION_MISMATCH")
            if staleRevision {
                errorMessage = "需求版本已变化，请刷新后重新打开批准面板。"
            }
        }
    }
}
