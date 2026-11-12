import SwiftUI

// The proposal is ephemeral view state. Source of truth remains the existing
// Requirement/Plan revision writer; no approval or Plan state is persisted here.
struct ZenProposalReviewSheet: View {
    @ObservedObject var model: NativeWorkspace
    let sourceRepoId: String
    let proposal: ZenChangeProposal
    let onApplied: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var currentRequirement: RequirementRecordDetail?
    @State private var currentPlan: PlanRecordDetail?
    @State private var loading = true
    @State private var saving = false
    @State private var acknowledged = false
    @State private var problem: String?

    private var ready: Bool {
        guard !loading,!saving,problem == nil,model.repoId == sourceRepoId else { return false }
        switch proposal.operation {
        case .createRequirement: return true
        case .reviseRequirement:
            return currentRequirement?.revision == proposal.expectedRevision
                && currentRequirement?.state == "open"
        case .createPlan:
            return currentRequirement?.state == "open"
        case .revisePlan:
            return currentPlan?.revision == proposal.expectedRevision
        }
    }

    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            HStack {
                VStack(alignment:.leading,spacing:3) {
                    Text("审核 AI 变更提案").font(.system(size:17,weight:.semibold))
                    Text(proposal.operation.displayName).font(.system(size:11))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("关闭") { dismiss() }.buttonStyle(.plain)
            }
            Divider()
            ScrollView {
                VStack(alignment:.leading,spacing:17) {
                    Text("建议理由").font(.system(size:12,weight:.semibold))
                    Text(proposal.rationale).font(.system(size:12))
                        .textSelection(.enabled)
                    if loading {
                        ProgressView("正在读取 Forge 当前修订…")
                            .font(.system(size:11))
                    } else if let problem {
                        Label(problem,systemImage:"exclamationmark.triangle")
                            .font(.system(size:11)).foregroundStyle(.orange)
                            .textSelection(.enabled)
                    } else {
                        proposedChanges
                    }
                }
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(.vertical,4)
            }

            Divider()
            Toggle("已核对提案内容、目标项目和影响范围，同意写入 Forge",isOn:$acknowledged)
                .font(.system(size:11))
            HStack {
                Spacer()
                Button("放弃") { dismiss() }
                Button(saving ? "应用中…" : "批准并应用") {
                    Task { await applyProposal() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!ready || !acknowledged)
                .accessibilityIdentifier("zen.proposal.approve")
            }
        }
        .padding(22)
        .frame(width:550,height:565)
        .task(id:proposal.id) { await preflight() }
        .accessibilityIdentifier("zen.proposal.review")
    }

    @ViewBuilder
    private var proposedChanges: some View {
        switch proposal.operation {
        case .createRequirement:
            comparison("新需求名称",before:nil,after:proposal.title)
            comparison("预期目标",before:nil,after:proposal.outcome)
            criteriaView
        case .reviseRequirement:
            comparison("需求名称",before:currentRequirement?.title,after:proposal.title)
            comparison("预期目标",before:currentRequirement?.outcomeStatement,after:proposal.outcome)
            if let currentRequirement {
                Text("修订：v\(currentRequirement.revision) → v\(currentRequirement.revision+1)")
                    .font(.system(size:11,design:.monospaced)).foregroundStyle(.secondary)
                comparison("当前验收标准",
                           before:currentRequirement.acceptanceCriteria.joined(separator:"\n"),
                           after:proposal.acceptanceCriteria?.joined(separator:"\n"))
            }
        case .createPlan:
            comparison("所属 Requirement",before:nil,after:currentRequirement?.title)
            comparison("新增计划目标",before:nil,after:proposal.objective)
        case .revisePlan:
            if let currentPlan {
                Text("修订：v\(currentPlan.revision) → v\(currentPlan.revision+1)")
                    .font(.system(size:11,design:.monospaced)).foregroundStyle(.secondary)
            }
            comparison("计划目标",before:currentPlan?.goal,after:proposal.objective)
        }
    }

    @ViewBuilder
    private var criteriaView: some View {
        if let criteria=proposal.acceptanceCriteria,!criteria.isEmpty {
            VStack(alignment:.leading,spacing:6) {
                Text("验收标准").font(.system(size:12,weight:.semibold))
                ForEach(criteria,id:\.self) { criterion in
                    Text("• \(criterion)").font(.system(size:11))
                }
            }
        }
    }

    private func comparison(_ label:String,before:String?,after:String?) -> some View {
        VStack(alignment:.leading,spacing:7) {
            Text(label).font(.system(size:12,weight:.semibold))
            if let before,!before.isEmpty, before != after {
                Text(before).font(.system(size:11)).foregroundStyle(.secondary)
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .padding(10)
                    .background(Color.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:8))
                    .textSelection(.enabled)
            }
            Text(after ?? "").font(.system(size:12))
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(10)
                .background(Color.accentColor.opacity(0.07),in:RoundedRectangle(cornerRadius:8))
                .textSelection(.enabled)
        }
    }

    private func preflight() async {
        loading=true
        problem=nil
        currentRequirement=nil
        currentPlan=nil
        defer { loading=false }
        guard model.repoId == sourceRepoId else {
            problem="项目已切换。此提案仅属于原项目，不能跨项目应用。"
            return
        }
        do {
            switch proposal.operation {
            case .createRequirement:
                if model.records.contains(where: {
                    $0.kind == .requirement &&
                    $0.title.compare(proposal.title ?? "",options:[.caseInsensitive,.diacriticInsensitive]) == .orderedSame
                }) {
                    throw ZenProposalIssue.validation("已存在同名 Requirement。请先检查是否应修改现有需求。")
                }
            case .reviseRequirement,.createPlan:
                guard let id=proposal.operation == .reviseRequirement ? proposal.targetId : proposal.requirementId else {
                    throw ZenProposalIssue.validation("缺少 Requirement ID。")
                }
                let receipt=try await ForgeBridge.request("read_requirement_detail",[
                    "repoId":sourceRepoId,"requirementId":id
                ])
                guard let detail=NativeWorkspace.requirementDetail(receipt),
                      detail.requirementId == id else {
                    throw ZenProposalIssue.validation("无法确认当前 Requirement。")
                }
                currentRequirement=detail
                if detail.state != "open" {
                    throw ZenProposalIssue.validation("Requirement 已处于终态，不能修改或追加 Plan。")
                }
                if proposal.operation == .reviseRequirement &&
                    detail.revision != proposal.expectedRevision {
                    throw ZenProposalIssue.validation("Requirement 版本已变化，提案过期；请重新分析。")
                }
            case .revisePlan:
                guard let id=proposal.targetId else {
                    throw ZenProposalIssue.validation("缺少 Plan ID。")
                }
                let receipt=try await ForgeBridge.request("read_plan_detail",[
                    "repoId":sourceRepoId,"planId":id
                ])
                guard let detail=NativeWorkspace.planDetail(receipt),detail.planId == id else {
                    throw ZenProposalIssue.validation("无法确认当前 Plan。")
                }
                currentPlan=detail
                if detail.revision != proposal.expectedRevision {
                    throw ZenProposalIssue.validation("Plan 版本已变化，提案过期；请重新分析。")
                }
            }
        } catch {
            problem=error.localizedDescription
        }
    }

    private func applyProposal() async {
        guard ready,acknowledged else { return }
        saving=true
        defer { saving=false }
        let changedId:String?
        switch proposal.operation {
        case .createRequirement:
            changedId=await model.createRequirement(
                title:proposal.title ?? "",outcome:proposal.outcome ?? "",
                acceptanceCriteria:proposal.acceptanceCriteria ?? []
            )
        case .reviseRequirement:
            let ok=await model.reviseRequirement(
                id:proposal.targetId ?? "",expectedRevision:proposal.expectedRevision ?? 0,
                title:proposal.title ?? "",outcome:proposal.outcome ?? "",
                acceptanceCriteria:proposal.acceptanceCriteria ?? []
            )
            changedId=ok ? proposal.targetId : nil
        case .createPlan:
            let id=await model.createPlan(
                objective:proposal.objective ?? "",requirementId:proposal.requirementId,
                parentPlanId:nil
            )
            changedId=id != nil ? proposal.requirementId : nil
        case .revisePlan:
            let ok=await model.revisePlan(
                id:proposal.targetId ?? "",expectedRevision:proposal.expectedRevision ?? 0,
                objective:proposal.objective ?? ""
            )
            changedId=ok ? currentPlan?.requirementId : nil
        }
        if let changedId {
            onApplied(changedId)
            dismiss()
        } else {
            problem=model.error ?? "Forge 未确认写入；请先核对当前记录，不要重复提交。"
        }
    }
}

private enum ZenProposalIssue: LocalizedError {
    case validation(String)
    var errorDescription: String? {
        if case .validation(let message)=self { return message }
        return nil
    }
}
