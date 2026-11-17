import SwiftUI

// The proposal is ephemeral view state. Source of truth remains the existing
// Requirement/Plan revision writer; no approval or Plan state is persisted here.
struct ZenProposalReviewSheet: View {
    @ObservedObject var model: NativeWorkspace
    let sourceProjectId: String
    let sourceRepoId: String?
    let sourceCheckoutId: String?
    let proposal: ZenChangeProposal
    let onApplied: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var currentRequirement: RequirementRecordDetail?
    @State private var currentPlan: PlanRecordDetail?
    @State private var loading = true
    @State private var saving = false
    @State private var acknowledged = false
    @State private var problem: String?
    @State private var pendingCreationReadback: PendingCreationReadback?

    private struct PendingCreationReadback: Equatable {
        let operation: ZenChangeProposal.Operation
        let recordId: String
    }

    private var contextIsCurrent: Bool {
        model.selectedProjectId == sourceProjectId
            && model.repoId == sourceRepoId
            && model.checkoutId == sourceCheckoutId
    }

    private var sourceScopeSummary: String {
        let project = contextIsCurrent ? (model.semanticProject?.displayName ?? sourceProjectId) : sourceProjectId
        let repository = sourceRepoId.map { contextIsCurrent ? (model.project?.label ?? $0) : $0 } ?? "项目级"
        let checkout = sourceCheckoutId.map { contextIsCurrent ? (model.checkoutBranch ?? $0) : $0 } ?? "无 Checkout"
        return [project,repository,checkout].joined(separator:" · ")
    }

    static func creationReadbackConfirmed(
        proposal: ZenChangeProposal,
        recordId: String,
        selectedRecord: String?,
        detail: SemanticRecordDetail?
    ) -> Bool {
        let expectedKind: SemanticRecordKind
        switch proposal.operation {
        case .createRequirement: expectedKind = .requirement
        case .createPlan: expectedKind = .plan
        default: return false
        }
        guard selectedRecord == "\(expectedKind.rawValue):\(recordId)" else { return false }
        switch (proposal.operation, detail) {
        case (.createRequirement, .requirement(let requirement)):
            let criteria=(proposal.acceptanceCriteria ?? [])
                .map{$0.trimmingCharacters(in:.whitespacesAndNewlines)}
                .filter{!$0.isEmpty}
            return requirement.requirementId == recordId && requirement.revision > 0
                && requirement.state == "planned"
                && requirement.title == proposal.title?.trimmingCharacters(in:.whitespacesAndNewlines)
                && requirement.outcomeStatement == proposal.outcome?.trimmingCharacters(in:.whitespacesAndNewlines)
                && requirement.acceptanceCriteria == criteria
        case (.createPlan, .plan(let plan)):
            guard let expectedRequirementRevision=proposal.expectedRequirementRevision else { return false }
            return plan.planId == recordId && plan.revision > 0
                && plan.requirementId == proposal.requirementId
                && plan.requirementBasisRevision == expectedRequirementRevision
                && plan.goal == proposal.objective?.trimmingCharacters(in:.whitespacesAndNewlines)
        default:
            return false
        }
    }

    private var ready: Bool {
        guard !loading,!saving,problem == nil,pendingCreationReadback == nil,
              contextIsCurrent else { return false }
        switch proposal.operation {
        case .createRequirement: return true
        case .reviseRequirement:
            return currentRequirement?.revision == proposal.expectedRevision
                && currentRequirement?.state == "open"
        case .createPlan:
            return currentRequirement?.state == "open"
                && currentRequirement?.revision == proposal.expectedRequirementRevision
        case .revisePlan:
            return currentPlan.map(proposal.matchesCurrentPlan) == true
        }
    }

    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            HStack {
                VStack(alignment:.leading,spacing:3) {
                    Text("审核 AI 变更提案").font(.system(size:17,weight:.semibold))
                    Text(proposal.operation.displayName).font(.system(size:11))
                        .foregroundStyle(.secondary)
                    Text(sourceScopeSummary)
                        .font(.system(size:10)).foregroundStyle(.secondary)
                        .lineLimit(1).textSelection(.enabled)
                        .accessibilityIdentifier("zen.proposal.scope")
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
            if let pendingCreationReadback {
                HStack(spacing:10) {
                    Text("创建回执已确认 · \(pendingCreationReadback.recordId)。等待详情读回，请刷新核对，不要重复创建。")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                    Spacer(minLength:0)
                    Button(saving ? "核对中…" : "刷新并核对") {
                        Task { await reconcilePendingCreation() }
                    }
                    .disabled(saving || !contextIsCurrent)
                    .accessibilityIdentifier("zen.proposal.readback.refresh")
                }
            }
            Toggle("已核对提案内容、目标项目和影响范围，同意写入 Forge",isOn:$acknowledged)
                .font(.system(size:11))
                .disabled(pendingCreationReadback != nil || saving)
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
            if let currentRequirement {
                Text("依据版本 · Requirement v\(currentRequirement.revision)")
                    .font(.system(size:11,design:.monospaced)).foregroundStyle(.secondary)
                comparison("所属 Requirement",before:nil,after:currentRequirement.title)
                comparison("Requirement 预期目标",before:nil,after:currentRequirement.outcomeStatement)
                if !currentRequirement.acceptanceCriteria.isEmpty {
                    VStack(alignment:.leading,spacing:6) {
                        Text("当前验收标准").font(.system(size:12,weight:.semibold))
                        ForEach(currentRequirement.acceptanceCriteria,id:\.self) { criterion in
                            Text("• \(criterion)").font(.system(size:11))
                        }
                    }
                }
            }
            comparison("新增计划目标",before:nil,after:proposal.objective)
        case .revisePlan:
            if let currentPlan {
                Text("所属 Requirement · \(currentPlan.requirementId ?? "独立 Plan")")
                    .font(.system(size:11)).foregroundStyle(.secondary)
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
        pendingCreationReadback=nil
        currentRequirement=nil
        currentPlan=nil
        defer { loading=false }
        guard model.selectedProjectId == sourceProjectId,model.repoId == sourceRepoId,
              model.checkoutId == sourceCheckoutId else {
            problem="项目或工作区已切换。此提案仅属于原分析上下文，不能跨上下文应用。"
            return
        }
        do {
            var currentRecords:[ForgeRecord]=[]
            if proposal.operation == .createRequirement || proposal.operation == .createPlan {
                currentRecords=try await model.readPlanningRecords(
                    projectId:sourceProjectId,repoId:sourceRepoId)
                guard model.repoId == sourceRepoId,model.checkoutId == sourceCheckoutId,
                      model.selectedProjectId == sourceProjectId else {
                    problem="项目或工作区已切换。请返回原上下文核对后再继续。"
                    return
                }
            }
            switch proposal.operation {
            case .createRequirement:
                if currentRecords.contains(where: {
                    $0.kind == .requirement &&
                    $0.title.compare(proposal.title ?? "",options:[.caseInsensitive,.diacriticInsensitive]) == .orderedSame
                }) {
                    throw ZenProposalIssue.validation("已存在同名 Requirement。请先检查是否应修改现有需求。")
                }
            case .reviseRequirement,.createPlan:
                guard let id=proposal.operation == .reviseRequirement ? proposal.targetId : proposal.requirementId else {
                    throw ZenProposalIssue.validation("缺少 Requirement ID。")
                }
                var arguments:[String:Any]=[
                    "projectId":sourceProjectId,"requirementId":id
                ]
                if let sourceRepoId { arguments["repoId"]=sourceRepoId }
                let receipt=try await ForgeBridge.request("read_requirement_detail",arguments)
                guard model.selectedProjectId == sourceProjectId,
                      model.repoId == sourceRepoId,model.checkoutId == sourceCheckoutId else {
                    problem="项目或工作区已切换。请重新分析后再审阅。"
                    return
                }
                guard let detail=NativeWorkspace.requirementDetail(receipt),
                      detail.requirementId == id else {
                    throw ZenProposalIssue.validation("无法确认当前 Requirement。")
                }
                currentRequirement=detail
                if detail.state != "open" {
                    throw ZenProposalIssue.validation("Requirement 已处于终态，不能修改或追加 Plan。")
                }
                if proposal.operation == .createPlan,
                   currentRecords.contains(where: {
                       $0.kind == .plan && $0.requirementId == id &&
                       $0.title.compare(proposal.objective ?? "",options:[.caseInsensitive,.diacriticInsensitive]) == .orderedSame
                   }) {
                    throw ZenProposalIssue.validation("该 Requirement 已存在相同目标的 Plan。请先核对现有计划，避免重复创建。")
                }
                if proposal.operation == .reviseRequirement &&
                    detail.revision != proposal.expectedRevision {
                    throw ZenProposalIssue.validation("Requirement 版本已变化，提案过期；请重新分析。")
                }
                if proposal.operation == .createPlan &&
                    detail.revision != proposal.expectedRequirementRevision {
                    throw ZenProposalIssue.validation("父 Requirement 版本已变化，Plan 提案过期；请重新分析。")
                }
            case .revisePlan:
                guard let id=proposal.targetId else {
                    throw ZenProposalIssue.validation("缺少 Plan ID。")
                }
                var arguments:[String:Any]=[
                    "projectId":sourceProjectId,"planId":id
                ]
                if let sourceRepoId { arguments["repoId"]=sourceRepoId }
                let receipt=try await ForgeBridge.request("read_plan_detail",arguments)
                guard model.selectedProjectId == sourceProjectId,
                      model.repoId == sourceRepoId,model.checkoutId == sourceCheckoutId else {
                    problem="项目或工作区已切换。请重新分析后再审阅。"
                    return
                }
                guard let detail=NativeWorkspace.planDetail(receipt),detail.planId == id else {
                    throw ZenProposalIssue.validation("无法确认当前 Plan。")
                }
                currentPlan=detail
                guard proposal.matchesCurrentPlan(detail) else {
                    throw ZenProposalIssue.validation("Plan 版本或所属 Requirement 与当前分析不一致；请重新核对目标后再生成提案。")
                }
            }
        } catch {
            problem=error.localizedDescription
        }
    }

    private func applyProposal() async {
        guard ready,acknowledged,contextIsCurrent else { return }
        saving=true
        model.error=nil
        defer { saving=false }
        let changedId:String?
        switch proposal.operation {
        case .createRequirement:
            let id=await model.createRequirement(
                title:proposal.title ?? "",outcome:proposal.outcome ?? "",
                acceptanceCriteria:proposal.acceptanceCriteria ?? []
            )
            if let id {
                guard contextIsCurrent else {
                    pendingCreationReadback=PendingCreationReadback(operation:.createRequirement,recordId:id)
                    problem="Requirement 创建回执已确认，但项目或工作区已切换。请返回原上下文刷新核对，不要重复创建。"
                    return
                }
                guard Self.creationReadbackConfirmed(
                    proposal:proposal,recordId:id,
                    selectedRecord:model.selectedRecord,detail:model.recordDetail
                ) else {
                    pendingCreationReadback=PendingCreationReadback(operation:.createRequirement,recordId:id)
                    problem=model.error ?? "Requirement \(id) 已收到创建回执，但详情尚未确认。请刷新核对，不要重复创建。"
                    return
                }
                changedId=id
            } else {
                changedId=nil
            }
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
                parentPlanId:nil,expectedRequirementRevision:proposal.expectedRequirementRevision
            )
            if let id {
                guard contextIsCurrent else {
                    pendingCreationReadback=PendingCreationReadback(operation:.createPlan,recordId:id)
                    problem="Plan 创建回执已确认，但项目或工作区已切换。请返回原上下文刷新核对，不要重复创建。"
                    return
                }
                guard Self.creationReadbackConfirmed(
                    proposal:proposal,recordId:id,
                    selectedRecord:model.selectedRecord,detail:model.recordDetail
                ) else {
                    pendingCreationReadback=PendingCreationReadback(operation:.createPlan,recordId:id)
                    problem=model.error ?? "Plan \(id) 已收到创建回执，但详情尚未确认。请刷新核对，不要重复创建。"
                    return
                }
                changedId=proposal.requirementId
            } else {
                changedId=nil
            }
        case .revisePlan:
            let ok=await model.revisePlan(
                id:proposal.targetId ?? "",expectedRevision:proposal.expectedRevision ?? 0,
                objective:proposal.objective ?? ""
            )
            changedId=ok ? currentPlan?.requirementId : nil
        }
        if let changedId {
            guard contextIsCurrent else {
                problem="操作已返回成功，但项目或工作区已切换。请返回原上下文核对记录，不要重复提交。"
                return
            }
            onApplied(changedId)
            dismiss()
        } else {
            problem=model.error ?? "Forge 未确认写入；请先核对当前记录，不要重复提交。"
        }
    }

    private func reconcilePendingCreation() async {
        guard let pending=pendingCreationReadback else { return }
        guard contextIsCurrent else {
            problem="请先返回提案所属的原项目和工作区，再刷新核对创建回执。"
            return
        }
        saving=true
        defer { saving=false }
        problem=nil
        model.error=nil
        await model.loadPage()
        guard contextIsCurrent else {
            problem="刷新期间项目或工作区已切换。请返回原上下文核对，不要重复创建。"
            return
        }
        let record:ForgeRecord?
        switch pending.operation {
        case .createRequirement:
            record=model.records.first(where:{$0.kind == .requirement && $0.recordId == pending.recordId})
        case .createPlan:
            record=model.records.first(where:{$0.kind == .plan && $0.recordId == pending.recordId})
        default:
            record=nil
        }
        guard let record else {
            problem=model.error ?? "创建回执已确认，但列表仍未读回该记录。稍后可再次刷新核对，不要重复创建。"
            return
        }
        await model.openRecord(record.id)
        guard contextIsCurrent else {
            problem="详情读取期间项目或工作区已切换。请返回原上下文核对，不要重复创建。"
            return
        }
        guard Self.creationReadbackConfirmed(
            proposal:proposal,recordId:pending.recordId,
            selectedRecord:model.selectedRecord,detail:model.recordDetail
        ) else {
            problem=model.error ?? "记录已出现在列表，但精确详情尚未确认。稍后再次刷新核对。"
            return
        }
        let requirementId:String
        switch pending.operation {
        case .createRequirement:
            requirementId=pending.recordId
        case .createPlan:
            guard let parentId=proposal.requirementId else {
                problem="Plan 详情已确认，但缺少父 Requirement ID。请返回原上下文核对。"
                return
            }
            requirementId=parentId
        default:
            return
        }
        pendingCreationReadback=nil
        onApplied(requirementId)
        dismiss()
    }
}

private enum ZenProposalIssue: LocalizedError {
    case validation(String)
    var errorDescription: String? {
        if case .validation(let message)=self { return message }
        return nil
    }
}
