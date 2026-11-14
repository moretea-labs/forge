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
        return status.runId == review.runId
            && status.checkpointPlanId == review.planId
            && status.nextExecutionOperation() == "accept_checkpoint"
    }

    private var outcomeUnknown: Bool {
        model.planningAutopilotStatusError?.contains("操作结果未确认") == true
    }

    var body: some View {
        VStack(alignment:.leading,spacing:13) {
            Text("验收检查点").font(.system(size:17,weight:.semibold))
            Text(review.planTitle).font(.system(size:13,weight:.medium))
            Text(review.planId).font(.system(size:10,design:.monospaced))
                .foregroundStyle(.secondary).textSelection(.enabled)
            if let summary=review.summary,!summary.isEmpty {
                Text("执行摘要").font(.system(size:11,weight:.semibold))
                Text(summary).font(.system(size:11)).textSelection(.enabled)
            }
            Text("已有交付证据").font(.system(size:11,weight:.semibold))
            if review.evidenceRefs.isEmpty {
                Text("当前执行未登记证据，请先核对实际交付再决定是否继续。")
                    .font(.system(size:11)).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment:.leading,spacing:5) {
                        ForEach(review.evidenceRefs,id:\.self) { evidence in
                            Text(evidence).font(.system(size:10,design:.monospaced))
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
                    .font(.system(size:10))
            }
            if let errorMessage {
                Text(errorMessage).font(.system(size:10)).foregroundStyle(.orange).textSelection(.enabled)
            }
            Toggle("我已核对此 Plan 的实际结果与证据，同意恢复原运行",isOn:$acknowledged)
                .font(.system(size:11))
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
        .padding(22)
        .frame(width:500)
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
                errorMessage=model.planningAutopilotStatusError ?? model.error
                    ?? "执行状态未确认，请刷新后重新验收。"
            }
        }
    }
}
