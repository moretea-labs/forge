import SwiftUI

struct ZenExecutionAuthorizationSnapshot: Equatable {
  let authorized: Bool
  let provider: String?
  let providerReady: Bool
  let model: String?
  let runtimeActive: Bool
  let requiresReapproval: Bool
  let requirementRevision: Int?
  let approvedRevision: Int?
  let runStatus: String?
  let runId: String?
  let pendingProcessId: String?
  let pendingCommandRequestId: String?
  let stopReason: String?
  let currentPlanId: String?
  let promptTokens: Int
  let completionTokens: Int
  let totalTokens: Int
  let maxTotalTokens: Int?
  let turns: Int
  let maxTurns: Int?
  let toolCalls: Int
  let maxToolCalls: Int?
  let checkpointPlanIds: [String]

  init(_ status: AutopilotStatusDetail) {
    authorized = status.authorized
    provider = status.provider
    providerReady = status.providerReady
    model = status.model
    runtimeActive = status.runtimeActive
    requiresReapproval = status.requiresReapproval
    requirementRevision = status.requirementRevision
    approvedRevision = status.approvedRevision
    runStatus = status.runStatus
    runId = status.runId
    pendingProcessId = status.pendingProcessId
    pendingCommandRequestId = status.pendingCommandRequestId
    stopReason = status.stopReason
    currentPlanId = status.currentPlanId
    promptTokens = status.promptTokens
    completionTokens = status.completionTokens
    totalTokens = status.totalTokens
    maxTotalTokens = status.maxTotalTokens
    turns = status.turns
    maxTurns = status.maxTurns
    toolCalls = status.toolCalls
    maxToolCalls = status.maxToolCalls
    checkpointPlanIds = status.checkpointPlanIds
  }
}

struct ZenExecutionApproval: Identifiable {
  let projectId: String
  let contextGeneration: Int
  let repoId: String
  let checkoutId: String
  let projectLabel: String
  let checkoutLabel: String
  let repositoryAccessMode: String
  let requirement: RequirementRecordDetail
  let status: AutopilotStatusDetail
  let plans: [ForgeRecord]

  var repositoryAccessLabel: String {
    repositoryAccessMode == "full_access" ? "完全访问" : "请求权限"
  }

  func matchesRepositoryAccessMode(_ currentMode: String) -> Bool {
    repositoryAccessMode == currentMode
  }

  var id: String {
    "\(projectId)|\(contextGeneration)|\(repoId)|\(checkoutId)|\(requirement.requirementId)|\(requirement.revision)|\(repositoryAccessMode)"
  }

  func matchesCurrentContext(
    projectId: String?, repoId: String?, checkoutId: String?, contextGeneration: Int
  ) -> Bool {
    self.projectId == projectId && self.repoId == repoId
      && self.checkoutId == checkoutId && self.contextGeneration == contextGeneration
  }

  func matchesAuthorizationStatus(_ current: AutopilotStatusDetail) -> Bool {
    ZenExecutionAuthorizationSnapshot(status) == ZenExecutionAuthorizationSnapshot(current)
  }

  var budgetRefreshOnly: Bool {
    !status.requiresReapproval && status.needsBudgetRenewal
  }

  var stalePausedRun: Bool {
    status.requiresReapproval && status.runStatus == "paused"
  }

  var runAllowsAuthorization: Bool {
    guard !status.runtimeActive, status.runStatus != "running" else { return false }
    if status.runStatus == "paused" { return budgetRefreshOnly || stalePausedRun }
    return true
  }
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
  @State private var staleRevision = false

  init(model: NativeWorkspace, approval: ZenExecutionApproval, onApproved: @escaping () -> Void) {
    self.model = model
    self.approval = approval
    self.onApproved = onApproved
    _maxTotalTokens = State(
      initialValue: min(500_000, max(1_000, approval.status.maxTotalTokens ?? 50_000)))
    _maxTurns = State(initialValue: min(48, max(1, approval.status.maxTurns ?? 12)))
    _maxToolCalls = State(initialValue: min(128, max(1, approval.status.maxToolCalls ?? 32)))
    let availablePlanIds = Set(approval.plans.map(\.recordId))
    _checkpointPlanIds = State(
      initialValue: Set(approval.status.checkpointPlanIds).intersection(availablePlanIds))
  }

  private var revisionIsCurrent: Bool {
    approval.status.requirementRevision == approval.requirement.revision
  }

  private var scopeIsCurrent: Bool {
    approval.matchesCurrentContext(
      projectId: model.selectedProjectId, repoId: model.repoId,
      checkoutId: model.checkoutId, contextGeneration: model.projectContextGeneration
    )
  }

  private var repositoryAccessIsCurrent: Bool {
    !model.repositoryAccessLoading
      && approval.matchesRepositoryAccessMode(model.repositoryAccessMode)
  }

  private var statusIsCurrent: Bool {
    guard let latest = model.planningAutopilotStatuses[approval.requirement.requirementId] else {
      return false
    }
    return approval.matchesAuthorizationStatus(latest)
  }

  private var outcomeUnknown: Bool {
    model.autopilotOutcomeUnknown(for: approval.requirement.requirementId)
  }

  private var budgetRefreshOnly: Bool { approval.budgetRefreshOnly }

  private var stalePausedRun: Bool { approval.stalePausedRun }

  private var runAllowsAuthorization: Bool { approval.runAllowsAuthorization }

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
    revisionIsCurrent && scopeIsCurrent && repositoryAccessIsCurrent && statusIsCurrent
      && approval.status.providerReady && runAllowsAuthorization
      && !model.autopilotLoading && !model.autopilotControlPending
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

  private var approvalScope: some View {
    VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.row) {
      Text("执行目标").font(ForgeClientDesign.Typography.sectionTitle)
      Text(approval.requirement.outcomeStatement)
        .font(ForgeClientDesign.Typography.body)
        .textSelection(.enabled)

      Text("验收标准（\(approval.requirement.acceptanceCriteria.count)）")
        .font(ForgeClientDesign.Typography.sectionTitle)
        .padding(.top, 3)
      if approval.requirement.acceptanceCriteria.isEmpty {
        Text("当前需求没有登记验收标准。")
          .foregroundStyle(.secondary)
          .font(ForgeClientDesign.Typography.control)
      } else {
        ForEach(Array(approval.requirement.acceptanceCriteria.enumerated()), id: \.offset) {
          index, criterion in
          Text("\(index + 1). \(criterion)")
            .font(ForgeClientDesign.Typography.control)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
      }
    }
    .accessibilityIdentifier("zen.execution.scope")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.section) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.titleDetail) {
          Text(
            approval.status.requiresReapproval
              ? "重新批准执行" : (approval.status.authorized ? "执行设置" : "批准执行")
          )
          .font(ForgeClientDesign.Typography.sheetTitle)
          Text(approval.requirement.title)
            .font(.system(size: 12, weight: .medium))
            .lineLimit(2)
        }
        Spacer()
        Text("v\(approval.requirement.revision)")
          .font(ForgeClientDesign.Typography.identifier)
          .foregroundStyle(.secondary)
      }

      ScrollView {
        VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.section) {
          ForgeClientFormSection(title: "执行范围") {
            ForgeClientMetadataRow(label: "项目", value: approval.projectLabel)
            ForgeClientMetadataRow(label: "Checkout", value: approval.checkoutLabel)
            ForgeClientMetadataRow(label: "仓库权限", value: approval.repositoryAccessLabel)
            ForgeClientMetadataRow(
              label: "Provider", value: "\(providerLabel) · \(approval.status.model ?? "默认模型")")
          }

          approvalScope
          VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.row) {
            HStack {
              Text("Token 上限").font(ForgeClientDesign.Typography.control)
              Spacer()
              Stepper(value: $maxTotalTokens, in: tokenMinimum...500_000, step: 10_000) {
                Text(maxTotalTokens.formatted()).font(ForgeClientDesign.Typography.identifier)
              }
            }
            HStack {
              Text("模型轮数").font(ForgeClientDesign.Typography.control)
              Spacer()
              Stepper(value: $maxTurns, in: turnMinimum...48) {
                Text("\(maxTurns)").font(ForgeClientDesign.Typography.identifier)
              }
            }
            HStack {
              Text("工具调用").font(ForgeClientDesign.Typography.control)
              Spacer()
              Stepper(value: $maxToolCalls, in: toolCallMinimum...128) {
                Text("\(maxToolCalls)").font(ForgeClientDesign.Typography.identifier)
              }
            }
          }

          if !approval.plans.isEmpty {
            VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.row) {
              Text("执行计划（\(approval.plans.count)）").font(ForgeClientDesign.Typography.sectionTitle)
              Text(
                budgetRefreshOnly
                  ? "下列 Plan 均属于本次执行，预算续期时保持验收节点不变。"
                  : "下列 Plan 均属于执行范围；勾选仅表示在该节点暂停并等待人工验收。"
              )
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.secondary)
              ForEach(approval.plans) { plan in
                Toggle(
                  isOn: Binding(
                    get: { checkpointPlanIds.contains(plan.recordId) },
                    set: { selected in
                      if selected {
                        checkpointPlanIds.insert(plan.recordId)
                      } else {
                        checkpointPlanIds.remove(plan.recordId)
                      }
                    }
                  )
                ) {
                  Text(plan.title).font(ForgeClientDesign.Typography.control)
                }
                .toggleStyle(.checkbox)
                .disabled(budgetRefreshOnly)
                .accessibilityIdentifier("zen.execution.checkpoint.\(plan.recordId)")
              }
            }
          }

          if approval.plans.isEmpty {
            Text("当前需求尚无执行 Plan，请确认是否要按现有需求直接执行。")
              .font(ForgeClientDesign.Typography.control)
              .foregroundStyle(.secondary)
          }

          if !revisionIsCurrent {
            Label("需求版本已变化，请刷新后重新打开批准面板。", systemImage: "exclamationmark.triangle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          } else if !scopeIsCurrent {
            Label("项目或 Checkout 已切换，请重新打开批准面板。", systemImage: "exclamationmark.triangle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          } else if model.repositoryAccessLoading {
            Label("正在读取仓库权限，请稍候。", systemImage: "hourglass")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          } else if !repositoryAccessIsCurrent {
            Label("仓库权限已变化，请关闭并重新打开批准面板。", systemImage: "exclamationmark.triangle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          } else if !approval.status.providerReady {
            Label("当前 Provider 凭据未就绪，暂时无法批准执行。", systemImage: "exclamationmark.triangle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          } else if approval.status.runtimeActive || approval.status.runStatus == "running" {
            Label("当前执行尚未结束，请等待运行结束后再重新批准。", systemImage: "pause.circle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          } else if approval.status.runStatus == "paused" && !runAllowsAuthorization {
            Label("当前运行正在等待人工验收，请先处理该节点。", systemImage: "exclamationmark.triangle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          }
          if outcomeUnknown {
            Label("操作结果未确认。请先刷新执行状态，不要重复提交。", systemImage: "exclamationmark.triangle")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          }
          if !statusIsCurrent {
            Label("执行状态已变化，请关闭面板并刷新后重新批准。", systemImage: "arrow.clockwise")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange)
          }

          if stalePausedRun {
            Text("需求或 Checkout 已变化；批准后会结束旧的暂停运行，并绑定当前修订。")
              .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.secondary)
          }
          if let errorMessage {
            Text(errorMessage).font(ForgeClientDesign.Typography.supporting).foregroundStyle(
              .orange
            ).textSelection(.enabled)
          }
          Text(
            budgetRefreshOnly
              ? (budgetIncreaseSelected
                ? "本次按调整后的上限开启新的预算窗口，历史累计用量保留。"
                : "本次按当前上限开启新的预算窗口，历史累计用量保留。")
              : "授权仅绑定当前 Requirement 修订与 Checkout，不包含远程推送、发布或破坏性操作。批准后仍需选择开始执行。"
          )
          .font(ForgeClientDesign.Typography.supporting).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 465)
      Toggle("我已核对执行目标、验收标准、计划、预算和工作区范围", isOn: $acknowledged)
        .font(ForgeClientDesign.Typography.control)

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
    .padding(ForgeClientDesign.Spacing.sheetPadding)
    .frame(width: ForgeClientDesign.Size.approvalSheet)
    .fixedSize(horizontal: false, vertical: true)
  }

  private func approve() {
    guard canApprove else { return }
    saving = true
    errorMessage = nil
    model.error = nil
    model.planningAutopilotStatusError = nil
    Task {
      let refreshed = await model.loadAutopilotStatus(approval.requirement.requirementId)
      guard refreshed else {
        saving = false
        errorMessage = model.error ?? model.planningAutopilotStatusError ?? "执行状态刷新失败，请稍后重试。"
        return
      }
      guard revisionIsCurrent, scopeIsCurrent, repositoryAccessIsCurrent,
        statusIsCurrent, approval.status.providerReady, runAllowsAuthorization,
        !outcomeUnknown
      else {
        saving = false
        errorMessage = "执行状态、Provider 或权限范围已变化，请关闭并重新打开批准面板。"
        return
      }
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
        guard scopeIsCurrent else {
          errorMessage = "授权已提交到原项目和工作区，但当前上下文已切换。请切回原项目刷新执行状态；不要重复授权。"
          return
        }
        dismiss()
        onApproved()
        return
      }
      let message = model.error ?? model.planningAutopilotStatusError ?? "授权未完成，请刷新执行状态后再试。"
      errorMessage = message
      staleRevision = message.contains("AUTOPILOT_REQUIREMENT_REVISION_MISMATCH")
      if staleRevision {
        errorMessage = "需求版本已变化，请刷新后重新打开批准面板。"
      }
    }
  }
}
