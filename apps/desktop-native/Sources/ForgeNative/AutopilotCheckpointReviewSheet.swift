import SwiftUI

// Snapshot of the canonical paused Run; never a second acceptance or execution ledger.
struct AutopilotCheckpointReview: Identifiable {
    let repoId: String
    let checkoutId: String
    let requirementId: String
    let runId: String
    let planId: String
    let planTitle: String
    let summary: String?
    let evidenceRefs: [String]

    var id: String { "\(repoId)|\(checkoutId)|\(runId)|\(planId)" }

    @MainActor
    init?(model: NativeWorkspace, requirementId: String, status: AutopilotStatusDetail) {
        guard let repoId=model.repoId,let checkoutId=model.checkoutId,
              let runId=status.runId,let planId=status.checkpointPlanId,
              !runId.isEmpty else { return nil }
        self.repoId=repoId
        self.checkoutId=checkoutId
        self.requirementId=requirementId
        self.runId=runId
        self.planId=planId
        self.planTitle=model.records.first(where: { $0.kind == .plan && $0.recordId == planId })?.title ?? planId
        self.summary=status.lastSummary
        self.evidenceRefs=status.evidenceRefs
    }
}

struct AutopilotCheckpointReviewSheet: View {
    @ObservedObject var model: NativeWorkspace
    let review: AutopilotCheckpointReview
    let onAccepted: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var acknowledged=false
    @State private var submitting=false
    @State private var errorMessage: String?

    private var current: Bool {
        guard model.repoId == review.repoId,model.checkoutId == review.checkoutId,
              let status=model.planningAutopilotStatuses[review.requirementId] else { return false }
        return status.runId == review.runId && status.runStatus == "paused"
            && status.checkpointPlanId == review.planId
            && status.nextExecutionOperation() == "accept_checkpoint"
    }

    private var outcomeUnknown: Bool {
        model.autopilotOutcomeUnknown(for:review.requirementId)
    }

    var body: some View {
        VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.section) {
            Text("验收检查点").font(ForgeClientDesign.Typography.sheetTitle)
            Text(review.planTitle).font(ForgeClientDesign.Typography.body)
            Text(review.planId).font(ForgeClientDesign.Typography.identifier)
                .foregroundStyle(.secondary).textSelection(.enabled)
            if let summary=review.summary,!summary.isEmpty {
                ForgeClientFormSection(title: "执行摘要") {
                    Text(summary).font(ForgeClientDesign.Typography.body).textSelection(.enabled)
                }
            }
            Text("已有交付证据").font(ForgeClientDesign.Typography.sectionTitle)
            if review.evidenceRefs.isEmpty {
                Text("当前执行未登记证据，请先核对实际交付再决定是否继续。")
                    .font(ForgeClientDesign.Typography.control).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.row) {
                        ForEach(review.evidenceRefs,id:\.self) { evidence in
                            Text(evidence).font(ForgeClientDesign.Typography.identifier)
                                .textSelection(.enabled)
                                .frame(maxWidth:.infinity,alignment:.leading)
                        }
                    }
                }
                .frame(maxHeight:135)
            }
            if !current {
                Label("执行状态或工作区已变化，请刷新后重新验收。",systemImage:"exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(ForgeClientDesign.Typography.supporting)
            }
            if outcomeUnknown {
                Label("操作结果未确认。请先刷新执行状态，不要重复提交。",systemImage:"exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(ForgeClientDesign.Typography.supporting)
            }
            if let errorMessage {
                Text(errorMessage).font(ForgeClientDesign.Typography.supporting).foregroundStyle(.orange).textSelection(.enabled)
            }
            Toggle("我已核对此 Plan 的实际结果与证据，同意恢复原运行",isOn:$acknowledged)
                .font(ForgeClientDesign.Typography.control)
            HStack {
                Spacer()
                Button("取消") { dismiss() }.disabled(submitting)
                Button(submitting ? "确认中…" : "确认验收并继续") { confirm() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!current || !acknowledged || submitting || outcomeUnknown
                              || model.autopilotLoading || model.autopilotControlPending)
                    .accessibilityIdentifier("autopilot.checkpoint.accept")
            }
        }
        .padding(ForgeClientDesign.Spacing.sheetPadding)
        .frame(width:ForgeClientDesign.Size.checkpointSheet)
        .interactiveDismissDisabled(submitting)
        .accessibilityIdentifier("autopilot.checkpoint.review")
    }

    private func confirm() {
        guard current,acknowledged,!submitting,!outcomeUnknown else { return }
        submitting=true
        errorMessage=nil
        Task {
            let ok=await model.controlAutopilot(
                requirementId:review.requirementId,operation:"resume",
                approvedCheckpointRunId:review.runId,
                approvedCheckpointPlanId:review.planId
            )
            submitting=false
            guard model.repoId == review.repoId,model.checkoutId == review.checkoutId else { return }
            if ok {
                dismiss()
                onAccepted()
            } else {
                errorMessage=model.error ?? model.planningAutopilotStatusError
                    ?? "执行状态未确认，请刷新后重新验收。"
            }
        }
    }
}
