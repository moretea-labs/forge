import SwiftUI

// A presentation of existing Repository, Requirement, Plan and Autopilot facts.
// Zen never owns a second plan, project registry, or execution state.
enum ZenNodeAction {
    case addPlan, edit, optimize, review, complete, cancel
    case toggleExecution, executionSettings

    var requiresRepository:Bool {
        switch self {
        case .toggleExecution, .executionSettings: return true
        default: return false
        }
    }
}

enum ZenBoardBucket: Int, CaseIterable {
    case todo, planned, active, waitingForUser, running, done, cancelled

    var title: String {
        switch self {
        case .todo: return "待规划"
        case .planned: return "待开始"
        case .active: return "进行中"
        case .waitingForUser: return "待你处理"
        case .running: return "执行中"
        case .done: return "已完成"
        case .cancelled: return "已取消"
        }
    }

    static func classify(
        requirementState: String, taskStatus: String? = nil,
        runtimeActive: Bool, hasPlan: Bool = false
    ) -> Self {
        if requirementState == "completed" || requirementState == "done" { return .done }
        if requirementState == "cancelled" { return .cancelled }
        if taskStatus == "done" { return .done }
        if taskStatus == "cancelled" { return .cancelled }
        if runtimeActive { return .running }
        switch taskStatus {
        case "planned": return .planned
        case "active": return .active
        case "waiting_for_user": return .waitingForUser
        default: break
        }
        if hasPlan { return .planned }
        return .todo
    }

    static func completedCount(_ requirements:[ForgeRecord]) -> Int {
        requirements.filter {
            classify(requirementState:$0.state,taskStatus:$0.taskStatus,runtimeActive:false) == .done
        }.count
    }
}

struct ZenSidebar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var model: NativeWorkspace
    @Binding var screen: ZenScreen
    @Binding var focusedRequirementId: String?
    let decisionCount: Int
    let onInbox: () -> Void

    // Quick-switch only to other recently used projects. The shared
    // project/checkout picker remains the sole full project selector.
    static func recentProjects(_ projects:[ForgeProject],threads:[ChatThread],
                               selectedRepoId:String?,limit:Int=7) -> [ForgeProject] {
        var lastActivity:[String:Date]=[:]
        for thread in threads {
            guard let repoId=thread.repoId else { continue }
            lastActivity[repoId]=max(lastActivity[repoId] ?? .distantPast,thread.updatedAt)
        }
        let candidates=projects.filter {
            $0.repoId != selectedRepoId && lastActivity[$0.repoId] != nil
        }
        return Array(candidates.sorted { lhs,rhs in
            let left=lastActivity[lhs.repoId] ?? .distantPast
            let right=lastActivity[rhs.repoId] ?? .distantPast
            if left != right { return left > right }
            return lhs.displayName.localizedStandardCompare(rhs.displayName) == .orderedAscending
        }.prefix(max(0,limit)))
    }

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            Button(action:onInbox) {
                HStack(spacing:9) {
                    Image(systemName:"tray").frame(width:18)
                    Text("需要决策")
                    Spacer()
                    if decisionCount > 0 {
                        Text("\(decisionCount)")
                            .font(.system(size:10,weight:.semibold))
                            .foregroundStyle(.orange)
                    }
                }
                .frame(height:34).padding(.horizontal,10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal,9)
            .accessibilityIdentifier("zen.inbox")

            Text("最近使用")
                .font(.system(size:11,weight:.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal,15).frame(height:42)

            ScrollView {
                LazyVStack(alignment:.leading,spacing:3) {
                    let recent=Self.recentProjects(model.projects,threads:model.threads,
                                                   selectedRepoId:model.repoId)
                    if recent.isEmpty {
                        Text("暂无其他最近项目")
                            .font(.system(size:11))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal,11).padding(.vertical,8)
                    } else {
                        ForEach(recent) { project in
                            Button {
                                guard model.canSwitchZenProject else { return }
                                withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                                    model.focusZenProject(project.repoId)
                                }
                            } label: {
                                HStack(spacing:9) {
                                    Image(systemName:"folder")
                                        .font(.system(size:11)).foregroundStyle(.secondary)
                                        .frame(width:17)
                                    Text(project.displayName)
                                        .font(.system(size:12)).lineLimit(1)
                                    Spacer(minLength:0)
                                }
                                .padding(.horizontal,10).frame(height:35)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(ZenPressStyle())
                            .disabled(!model.canSwitchZenProject)
                            .help(model.zenProjectSwitchBlockReason ?? project.displayName)
                            .accessibilityHint(model.zenProjectSwitchBlockReason ?? "切换到此项目")
                            .accessibilityIdentifier("zen.project.\(project.repoId)")
                        }
                    }
                }
                .padding(.horizontal,9).padding(.top,8)
            }
            .scrollIndicators(.hidden)
            Spacer(minLength:0)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.leading)
    }
}

struct ZenWorkspacePane: View {
    enum BoardPresentation: String, CaseIterable {
        case board
        case list

        var title: String {
            switch self {
            case .board: return "看板"
            case .list: return "列表"
            }
        }
    }

    enum RequirementSortOrder: String, CaseIterable {
        case source
        case priority
        case title

        var title: String {
            switch self {
            case .source: return "默认"
            case .priority: return "优先级"
            case .title: return "名称"
            }
        }
    }

    private struct SemanticCreationContext: Hashable {
        let projectId:String
        let repoId:String?
    }

    @ObservedObject var model: NativeWorkspace
    @Binding var screen: ZenScreen
    @Binding var focusedRequirementId: String?
    let onDraftGoal: (String) -> Void
    let onOpenInbox: () -> Void
    let onOpenAgent: (ForgeRecord, String, String?, Bool) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var searchFocused: Bool
    @State private var requirementQuery = ""
    @State private var boardPresentation: BoardPresentation = .board
    @State private var requirementSortOrder: RequirementSortOrder = .source
    @State private var hideEmptyColumns = true

    @State private var boardMode = "forge"
    @State private var showingGoalSheet = false
    @State private var goalDraft = ""
    @State private var showingRequirementSheet = false
    @State private var showingProjectDirectory = false
    @State private var showingPlanSheet = false
    @State private var pendingReviewRecord: ForgeRecord?
    @State private var pendingProposal: ZenChangeProposal?
    @State private var pendingExecutionApproval: ZenExecutionApproval?
    @State private var pendingCheckpointReview: AutopilotCheckpointReview?
    @State private var proposalSourceProjectId = ""
    @State private var proposalSourceRepoId: String?
    @State private var proposalSourceCheckoutId: String?
    @State private var proposalProblem = ""
    @State private var showingProposalProblem = false
    @State private var editingRecord: ForgeRecord?
    @State private var pendingAcceptanceRecord: ForgeRecord?
    @State private var acceptanceReferences = ""
    @State private var acceptanceRemainingWork = ""
    @State private var acceptanceAcknowledged = false
    @State private var cancellingRequirement: RequirementRecordDetail?
    @State private var editRevision = 0
    @State private var editTitle = ""
    @State private var editOutcome = ""
    @State private var editCriteria = ""
    @State private var editTaskStatus: String?
    @State private var editTaskStatusOptions: [String] = []
    @State private var editPriority = "unset"
    @State private var editAssignee = ""
    @State private var editRemainingWork = ""
    @State private var editDependencyRequirementIds:[String] = []
    @State private var editDependencyDetails:[RequirementDependencyDetail] = []
    @State private var editBlockingDependencyIds:[String] = []
    @State private var editDependencyIdDraft = ""

    @State private var newTitle = ""
    @State private var newOutcome = ""
    @State private var newCriteria = ""
    @State private var newTaskStatus = "planned"
    @State private var newPriority = "normal"
    @State private var newAssignee = ""
    @State private var newDependencyRequirementIds:[String] = []
    @State private var newDependencyIdDraft = ""
    @State private var newPlanGoal = ""
    @State private var newParentPlanId: String?
    @State private var pendingRequirementReadbacks:[SemanticCreationContext:String] = [:]
    @State private var pendingPlanReadbacks:[SemanticCreationContext:String] = [:]
    @State private var saving = false

    private var currentSemanticCreationContext:SemanticCreationContext? {
        guard let projectId=model.selectedProjectId else { return nil }
        return SemanticCreationContext(projectId:projectId,repoId:model.projectRepositoryId)
    }

    private var pendingCreatedRequirementId:String? {
        guard let context=currentSemanticCreationContext else { return nil }
        return pendingRequirementReadbacks[context]
    }

    private var pendingCreatedPlanId:String? {
        guard let context=currentSemanticCreationContext else { return nil }
        return pendingPlanReadbacks[context]
    }

    static func createdRequirementRecord(_ id:String,in records:[ForgeRecord]) -> ForgeRecord? {
        records.first(where:{$0.kind == .requirement && $0.recordId == id})
    }

    static func createdPlanRecord(_ id:String,in records:[ForgeRecord]) -> ForgeRecord? {
        records.first(where:{$0.kind == .plan && $0.recordId == id})
    }

    private var requirements: [ForgeRecord] {
        model.records.filter { $0.kind == .requirement }
    }

    private var visibleRequirements: [ForgeRecord] {
        Self.sortRequirements(
            Self.filterRequirements(requirements,query:requirementQuery),
            order:requirementSortOrder
        )
    }

    static func sortRequirements(_ items:[ForgeRecord],order:RequirementSortOrder) -> [ForgeRecord] {
        guard order != .source else { return items }
        return items.enumerated().sorted { lhs,rhs in
            switch order {
            case .priority:
                let left=prioritySortRank(lhs.element.priority)
                let right=prioritySortRank(rhs.element.priority)
                if left != right { return left < right }
            case .title:
                let comparison=lhs.element.title.localizedStandardCompare(rhs.element.title)
                if comparison != .orderedSame { return comparison == .orderedAscending }
            case .source:
                break
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    private static func prioritySortRank(_ priority:String?) -> Int {
        switch priority {
        case "urgent": return 0
        case "high": return 1
        case "normal": return 2
        case "low": return 3
        default: return 4
        }
    }

    static func filterRequirements(_ items:[ForgeRecord],query:String) -> [ForgeRecord] {
        let term=query.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !term.isEmpty else { return items }
        return items.filter {
            $0.title.localizedStandardContains(term)
            || $0.recordId.localizedStandardContains(term)
            || ($0.assignee?.localizedStandardContains(term) ?? false)
            || (taskStatusLabel($0.taskStatus)?.localizedStandardContains(term) ?? false)
            || (priorityLabel($0.priority)?.localizedStandardContains(term) ?? false)
        }
    }

    static func nonEmptyLines(_ text:String) -> [String] {
        text.components(separatedBy:.newlines)
            .map{$0.trimmingCharacters(in:.whitespacesAndNewlines)}
            .filter{!$0.isEmpty}
    }

    static func taskStatusLabel(_ value:String?) -> String? {
        guard let value,!value.isEmpty else { return nil }
        switch value {
        case "planned": return "待开始"
        case "active": return "进行中"
        case "waiting_for_user": return "待你处理"
        case "done": return "已完成"
        case "cancelled": return "已取消"
        default: return value
        }
    }

    static func requirementAllowsActions(_ state:String) -> Bool {
        state == "planned" || state == "open"
    }

    static func priorityLabel(_ value:String?) -> String? {
        switch value {
        case "low": return "低"
        case "normal": return "普通"
        case "high": return "高"
        case "urgent": return "紧急"
        default: return nil
        }
    }

    static func editableTaskStatuses(from current:String?) -> [String] {
        switch current {
        case nil: return ["unset","planned","active","waiting_for_user"]
        case "planned": return ["planned","active","waiting_for_user"]
        case "active": return ["active","waiting_for_user"]
        case "waiting_for_user": return ["waiting_for_user","planned","active"]
        case let value?: return [value]
        }
    }

    static func executionOperation(status:AutopilotStatusDetail?,outcomeUnknown:Bool) -> String? {
        status?.nextExecutionOperation(outcomeUnknown:outcomeUnknown)
    }

    static func executionLabel(
        operation:String,runStatus:String?,needsBudgetRenewal:Bool=false,
        hasPendingProcessRecovery:Bool=false
    ) -> String {
        if operation == "resume" && hasPendingProcessRecovery { return "核对并恢复" }
        switch operation {
        case "authorize": return needsBudgetRenewal ? "续期预算" : "批准执行"
        case "accept_checkpoint": return "验收检查点"
        case "pause": return "暂停执行"
        case "resume": return runStatus == "running" ? "恢复执行" : "继续执行"
        default: return "开始执行"
        }
    }

    static func nodeStatus(
        for item:ForgeRecord,
        root:ForgeRecord,
        executionStatuses:[String:AutopilotStatusDetail],
        unresolvedOutcomeRequirementIds:Set<String> = []
    ) -> (label:String,symbol:String,color:Color)? {
        if item.kind == .requirement && unresolvedOutcomeRequirementIds.contains(item.recordId) {
            return ("操作结果未确认","exclamationmark.triangle",.orange)
        }
        if let lifecycle=inspectorLifecycleLabel(for:item) {
            if lifecycle == "已完成" {
                return ("已完成","checkmark.circle.fill",.green)
            }
            if lifecycle == "已取消" {
                return ("已取消","xmark.circle",.secondary)
            }
        }

        let requirementId=item.kind == .requirement ? item.recordId : root.recordId
        guard let status=executionStatuses[requirementId] else { return nil }
        if item.kind == .plan {
            guard status.currentPlanId == item.recordId,
                  ["running","paused","blocked","failed"].contains(status.runStatus ?? "") else {
                return nil
            }
        }

        if status.hasPendingProcessRecovery {
            return ("等待原命令回执","hourglass",.orange)
        }
        if status.requiresReapproval {
            return ("需重新批准","lock.circle",.orange)
        }
        if let checkpointPlanId=status.checkpointPlanId,
           item.kind == .requirement || checkpointPlanId == item.recordId {
            return ("等待确认","checkmark.seal",.orange)
        }

        switch status.runStatus {
        case "running":
            return status.runtimeActive
                ? (item.kind == .plan ? "当前执行" : "执行中","circle.lefthalf.filled",.accentColor)
                : ("运行未激活","pause.circle",.orange)
        case "paused":
            return (item.kind == .plan ? "当前暂停" : "已暂停","pause.circle",.orange)
        case "blocked":
            return (item.kind == .plan ? "当前受阻" : "受阻","exclamationmark.circle",.orange)
        case "failed":
            return (item.kind == .plan ? "当前失败" : "执行失败","xmark.octagon",.red)
        case "completed":
            return ("执行完成","checkmark.circle.fill",.green)
        case "cancelled":
            return ("执行已取消","xmark.circle",.secondary)
        default:
            return item.kind == .requirement && status.authorized
                ? ("已批准","checkmark.seal",.accentColor)
                : nil
        }
    }

    static func requirementExecutionStatus(
        for item:ForgeRecord,
        executionStatuses:[String:AutopilotStatusDetail],
        unresolvedOutcomeRequirementIds:Set<String> = []
    ) -> (label:String,symbol:String,color:Color)? {
        guard item.kind == .requirement else { return nil }
        let unresolved=unresolvedOutcomeRequirementIds.contains(item.recordId)
        if !unresolved,let lifecycle=inspectorLifecycleLabel(for:item),
           lifecycle == "已完成" || lifecycle == "已取消" {
            return nil
        }
        return nodeStatus(
            for:item,root:item,executionStatuses:executionStatuses,
            unresolvedOutcomeRequirementIds:unresolvedOutcomeRequirementIds
        )
    }

    private var executionOutcomeUnknownRequirementIds: Set<String> {
        model.unresolvedAutopilotRequirementIds
    }

    private var visibleStages:[ZenBoardBucket] {
        ZenBoardBucket.allCases.filter { stage in
            !hideEmptyColumns || visibleRequirements.contains(where:{bucket($0) == stage})
        }
    }

    private func navigate(_ next:ZenScreen) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
            screen=next
        }
    }

    private func bucket(_ item:ForgeRecord) -> ZenBoardBucket {
        ZenBoardBucket.classify(
            requirementState:item.state,taskStatus:item.taskStatus,
            runtimeActive:model.planningAutopilotStatuses[item.recordId]?.runtimeActive == true,
            hasPlan:model.records.contains(where:{$0.kind == .plan && $0.requirementId == item.recordId})
        )
    }

    @ViewBuilder
    private func requirementExecutionStatusView(for item:ForgeRecord) -> some View {
        if let status=Self.requirementExecutionStatus(
            for:item,executionStatuses:model.planningAutopilotStatuses,
            unresolvedOutcomeRequirementIds:executionOutcomeUnknownRequirementIds
        ) {
            VStack(alignment:.leading,spacing:2) {
                Label(status.label,systemImage:status.symbol)
                    .font(.system(size:11.5,weight:.semibold))
                    .foregroundStyle(status.color)
                    .lineLimit(1)
                if status.label == "操作结果未确认" {
                    Text("先刷新核对，勿重复提交")
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(status.color)
                        .lineLimit(1)
                }
            }
            .help(status.label == "操作结果未确认"
                ? "先刷新状态并核对原命令回执；不要重复提交。" : status.label)
            .accessibilityElement(children:.combine)
            .accessibilityLabel(status.label)
            .accessibilityHint(status.label == "操作结果未确认"
                ? "操作结果尚未确认。先刷新状态并核对原命令回执；不要重复提交。"
                : "当前 Requirement 的 Autopilot 执行状态。")
            .accessibilityIdentifier("zen.requirement.execution-status.\(item.recordId)")
        }
    }

    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:10) {
                if screen == .canvas {
                    Button {
                        navigate(.board)
                        focusedRequirementId = nil
                        model.clearRecordSelection()
                    } label: {
                        Image(systemName:"chevron.left").frame(width:28,height:28)
                    }
                    .buttonStyle(.plain).help("返回看板")
                    .accessibilityLabel("返回看板")
                }
                Text(screen == .board ? "工作台" :
                     (requirements.first(where:{$0.recordId == focusedRequirementId})?.title ?? "Requirement"))
                    .font(.system(size:16,weight:.semibold))
                    .lineLimit(1)
                Spacer(minLength:0)
                if screen == .board {
                    Button {
                        showingProjectDirectory = true
                    } label: {
                        Label("项目",systemImage:"folder")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("zen.projects.open")
                    Button {
                        goalDraft = ""
                        showingGoalSheet = true
                    } label: {
                        Label("描述目标",systemImage:"sparkles")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.selectedProjectId == nil || model.busy)
                    .accessibilityIdentifier("zen.goal.describe")
                    if reviewableProposals.count > 1 {
                        Menu {
                            ForEach(reviewableProposals,id:\.threadId) { candidate in
                                Button(candidate.menuLabel) {
                                    reviewProposal(threadId:candidate.threadId)
                                }
                            }
                        } label: {
                            Label("审阅提案",systemImage:"doc.text.magnifyingglass")
                        }
                        .menuStyle(.borderedButton)
                        .disabled(model.selectedProjectId == nil || model.busy)
                        .accessibilityIdentifier("zen.proposal.open")
                    } else {
                        Button {
                            reviewLatestProposal()
                        } label: {
                            Label("审阅提案",systemImage:"doc.text.magnifyingglass")
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.selectedProjectId == nil || model.busy || reviewableProposals.isEmpty)
                        .accessibilityIdentifier("zen.proposal.open")
                    }
                    Menu {
                        Button("新建任务") {
                            newTitle = ""; newOutcome = ""; newCriteria = ""
                            newTaskStatus = "planned"; newPriority = "normal"; newAssignee = ""
                            newDependencyRequirementIds=[]; newDependencyIdDraft=""
                            model.error = nil
                            showingRequirementSheet = true
                        }
                    } label: {
                        Image(systemName:"plus").frame(width:28,height:28)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(model.selectedProjectId == nil)
                    .help("新建任务")
                    .accessibilityIdentifier("zen.requirement.new")
                }
                Button {
                    if model.selectedProjectId != nil {
                        Task {
                            await model.loadPage()
                            await model.refreshPlanningAutopilotStatuses()
                            if boardMode == "github",model.projectRepositoryId != nil {
                                await model.loadZenGitHubBoard()
                            }
                        }
                    }
                } label: {
                    Image(systemName:"arrow.clockwise").frame(width:28,height:28)
                }
                .buttonStyle(.plain)
                .disabled(model.selectedProjectId == nil || model.checkoutContextLoading)
                .help("刷新当前项目")
                .accessibilityLabel("刷新当前项目")
            }
            .padding(.horizontal,24).frame(height:54)

            if let error=model.error {
                HStack {
                    Image(systemName:"exclamationmark.circle")
                    Text(error).textSelection(.enabled)
                    Spacer()
                    Button("关闭") { model.error=nil }
                }
                .font(.system(size:11))
                .foregroundStyle(.orange)
                .padding(.horizontal,24).padding(.vertical,8)
            }

            Group {
                switch screen {
                case .board:
                    boardView
                case .canvas:
                    canvasContent
                }
            }
            .transition(reduceMotion ? .identity : .opacity)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
        .background(Color(nsColor:.textBackgroundColor))
        .onChange(of:screen) { next in
            selectDefaultRequirementIfNeeded(next)
        }
        .onChange(of:requirements.map(\.recordId)) { _ in
            selectDefaultRequirementIfNeeded(screen)
        }
        .sheet(isPresented:$showingGoalSheet) { goalSheet }
        .sheet(item:$pendingProposal) { item in
            ZenProposalReviewSheet(model:model,sourceProjectId:proposalSourceProjectId,
                                   sourceRepoId:proposalSourceRepoId,sourceCheckoutId:proposalSourceCheckoutId,
                                   proposal:item) { requirementId in
                focusedRequirementId=requirementId
                screen = .canvas
            }
        }
        .sheet(item:$pendingExecutionApproval) { approval in
            ZenExecutionApprovalSheet(model:model,approval:approval) {
                pendingExecutionApproval=nil
            }
        }
        .sheet(item:$pendingCheckpointReview) { review in
            AutopilotCheckpointReviewSheet(model:model,review:review) {
                pendingCheckpointReview=nil
            }
        }
        .alert("提案不可用",isPresented:$showingProposalProblem) {
            Button("确定",role:.cancel) {}
        } message: {
            Text(proposalProblem)
        }
        .sheet(isPresented:$showingRequirementSheet) { createRequirementSheet }
        .sheet(isPresented:$showingProjectDirectory) {
            ZenProjectDirectorySheet(
                model:model,
                onOpenTasks:{ projectId,repositoryId in
                    showingProjectDirectory=false
                    Task {
                        await model.openProjectTasks(projectId:projectId,repositoryId:repositoryId)
                    }
                },
                onOpenRequirement:{ projectId,repositoryId,requirementId in
                    showingProjectDirectory=false
                    Task {
                        await model.openProjectRequirement(
                            projectId:projectId,repositoryId:repositoryId,requirementId:requirementId)
                        guard model.selectedProjectId == projectId,
                              model.projectRepositoryId == repositoryId,
                              case .requirement(let detail)=model.recordDetail,
                              detail.requirementId == requirementId else { return }
                        focusedRequirementId=requirementId
                        navigate(.canvas)
                    }
                }
            )
        }
        .sheet(isPresented:$showingPlanSheet) { createPlanSheet }
        .sheet(item:$editingRecord) { item in editSheet(for:item) }
        .sheet(item:$pendingAcceptanceRecord) { item in acceptanceSheet(item) }
        .confirmationDialog("取消 Requirement？",isPresented:Binding(
            get:{ cancellingRequirement != nil },
            set:{ if !$0 { cancellingRequirement=nil } }
        )) {
            if let detail=cancellingRequirement {
                Button("确认取消（无法恢复）",role:.destructive) {
                    Task {
                        _ = await model.transitionRequirement(
                            id:detail.requirementId,expectedRevision:detail.revision,
                            title:detail.title,outcome:detail.outcomeStatement,
                            acceptanceCriteria:detail.acceptanceCriteria,state:"cancelled",
                            acceptedEvidenceRefs:nil
                        )
                    }
                }
            }
        } message: {
            Text("取消是不可逆的终态变更，仅用于已经决定不再交付的需求。")
        }
        .sheet(item:$pendingReviewRecord) { item in
            ZenReviewSheet(model:model,record:item) { prompt,provider in
                pendingReviewRecord = nil
                onOpenAgent(item,prompt,provider,false)
            }
        }
        .onChange(of:"\(model.repoId ?? "none")|\(model.selectedProjectId ?? "none")") { _ in
            boardMode = "forge"
            requirementQuery = ""
            searchFocused = false
        }
        .task(id:"\(model.projectRepositoryId ?? "none")|\(model.selectedProjectId ?? "none")|\(model.planningRequirementIds.joined(separator:"|"))|\(scenePhase == .active ? "active" : "inactive")") {
            guard scenePhase == .active,!model.planningRequirementIds.isEmpty else { return }
            await model.refreshPlanningAutopilotStatuses()
            while !Task.isCancelled {
                do { try await Task.sleep(for:.seconds(12)) }
                catch { return }
                guard !Task.isCancelled,scenePhase == .active else { return }
                await model.refreshPlanningAutopilotStatuses()
            }
        }
    }

    private func selectDefaultRequirementIfNeeded(_ next:ZenScreen) {
        guard next == .canvas,focusedRequirementId == nil,
              let first=requirements.first else { return }
        focusedRequirementId=first.recordId
        Task { await model.openRecord(first.id) }
    }

    private var boardView: some View {
        VStack(alignment:.leading,spacing:0) {
            if model.selectedProjectId == nil {
                ZenEmptyState(title:"选择项目",subtitle:"从左侧选择要推进的项目。",symbol:"folder")
                Spacer()
            } else {
                HStack(spacing:12) {
                    if boardMode == "forge" {
                        Text("\(requirements.count) 个需求")
                        Text("\(ZenBoardBucket.completedCount(requirements)) 已完成")
                        if let issue=model.planningAutopilotStatusError {
                            Text(issue).foregroundStyle(.orange).lineLimit(1)
                        }
                        let unresolvedCount=model.unresolvedAutopilotRequirementIds.count
                        if unresolvedCount > 0 {
                            Text("操作结果未确认 · \(unresolvedCount) 项")
                                .foregroundStyle(.orange).lineLimit(1)
                        }
                    }
                    if !model.relevantUserRequests.isEmpty {
                        Button("\(model.relevantUserRequests.count) 项待决策") { onOpenInbox() }
                            .buttonStyle(.plain)
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("zen.board.inbox")
                    }
                    Spacer()
                }
                .font(.system(size:11)).foregroundStyle(.secondary)
                .padding(.horizontal,24).padding(.bottom,13)
                HStack(spacing:10) {
                    if boardMode == "forge" {
                        HStack(spacing:7) {
                            Button {
                                searchFocused=true
                            } label: {
                                Image(systemName:"magnifyingglass")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .keyboardShortcut("f",modifiers:.command)
                            .help("搜索需求（⌘F）")
                            .accessibilityLabel("搜索需求")
                            TextField("搜索名称、ID、负责人、状态或优先级",text:$requirementQuery)
                                .textFieldStyle(.plain)
                                .focused($searchFocused)
                                .accessibilityIdentifier("zen.board.search")
                            if !requirementQuery.isEmpty {
                                Button {
                                    requirementQuery = ""
                                    searchFocused = true
                                } label: {
                                    Image(systemName:"xmark.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .help("清除搜索")
                            }
                        }
                        .font(.system(size:12))
                        .padding(.horizontal,10).frame(height:30)
                        .background(Color.primary.opacity(0.045),
                                    in:RoundedRectangle(cornerRadius:8))
                        .frame(maxWidth:320)
                    }
                    Spacer()
                    if boardMode == "forge" {
                        Picker("视图",selection:$boardPresentation) {
                            ForEach(BoardPresentation.allCases,id:\.self) { presentation in
                                Text(presentation.title).tag(presentation)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .fixedSize()
                        .accessibilityIdentifier("zen.board.presentation")

                        Menu {
                            ForEach(RequirementSortOrder.allCases,id:\.self) { order in
                                Button {
                                    requirementSortOrder=order
                                } label: {
                                    if requirementSortOrder == order {
                                        Label(order.title,systemImage:"checkmark")
                                    } else {
                                        Text(order.title)
                                    }
                                }
                            }
                        } label: {
                            Label(requirementSortOrder.title,systemImage:"arrow.up.arrow.down")
                                .font(.system(size:11))
                        }
                        .menuStyle(.borderlessButton)
                        .help("按默认顺序、优先级或名称排列任务")
                        .accessibilityLabel("排序：\(requirementSortOrder.title)")
                        .accessibilityIdentifier("zen.board.sort")

                        if boardPresentation == .board {
                            Button {
                                hideEmptyColumns.toggle()
                            } label: {
                                Label(hideEmptyColumns ? "显示空列" : "隐藏空列",
                                      systemImage:hideEmptyColumns ? "rectangle.split.3x1" : "rectangle.split.3x1.fill")
                                    .labelStyle(.iconOnly)
                                    .frame(width:28,height:28)
                            }
                            .buttonStyle(.plain)
                            .help(hideEmptyColumns ? "显示所有状态列" : "隐藏空状态列")
                            .accessibilityIdentifier("zen.board.toggleEmptyColumns")
                        }
                    }
                    Menu {
                        Button("需求视图") { boardMode = "forge" }
                        Button("GitHub Project · 进度") {
                            boardMode = "github"
                            Task { await model.loadZenGitHubBoard() }
                        }
                        .disabled(model.projectRepositoryId == nil)
                    } label: {
                        Label(boardMode == "forge" ? "需求视图" : "GitHub Project",systemImage:"chevron.down")
                    }
                    .menuStyle(.borderlessButton)
                    .frame(width:130)
                }
                .padding(.horizontal,24).padding(.bottom,10)
                if boardMode == "github",let problem=model.zenGitHubBoardError {
                    Text("GitHub Project 不可用；当前展示 Requirement。\(problem)")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                        .lineLimit(2).padding(.horizontal,24).padding(.bottom,11)
                } else if boardMode == "github" && model.zenGitHubBoardConfigured == false {
                    Text("未配置 GitHub Project；下方显示需求视图。")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                        .padding(.horizontal,24).padding(.bottom,11)
                }
                if boardMode == "github",
                   model.zenGitHubBoardConfigured == nil,
                   model.zenGitHubBoardLoading {
                    VStack(spacing:9) {
                        ProgressView()
                            .controlSize(.small)
                        Text("正在读取 GitHub Project…")
                            .font(.system(size:11))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
                    .accessibilityIdentifier("zen.github.board.loading")
                } else if model.zenGitHubBoardConfigured == true && boardMode == "github" {
                    ZenGitHubBoardView(items:model.zenGitHubBoardItems,
                                       truncated:model.zenGitHubBoardTruncated)
                } else if boardMode == "forge" && boardPresentation == .list {
                    ScrollView {
                        LazyVStack(spacing:0) {
                            ForEach(visibleRequirements) { item in
                                requirementListRow(item)
                            }
                        }
                        .padding(.horizontal,24)
                        .padding(.bottom,24)
                    }
                    .scrollIndicators(.hidden)
                } else {
                GeometryReader { frame in
                    ScrollView(.horizontal) {
                        HStack(alignment:.top,spacing:14) {
                            ForEach(visibleStages,id:\.rawValue) { stage in
                                let items = visibleRequirements.filter { bucket($0) == stage }
                                VStack(alignment:.leading,spacing:0) {
                                    HStack(spacing:9) {
                                        Circle().fill(ForgeBoardAppearance.marker(boardTone(stage)))
                                            .frame(width:7,height:7)
                                        Text(stage.title).font(.system(size:12.5,weight:.semibold))
                                        Spacer(minLength:5)
                                        Text("\(items.count)")
                                            .font(.system(size:10.5,weight:.medium))
                                            .foregroundStyle(.secondary)
                                            .padding(.horizontal,9).padding(.vertical,4)
                                            .background(ForgeBoardAppearance.cardSurface.opacity(0.9),
                                                        in:Capsule())
                                    }
                                    .padding(.bottom,13)
                                    ScrollView {
                                        LazyVStack(spacing:8) {
                                            ForEach(items) { item in
                                                Button {
                                                    focusedRequirementId = item.recordId
                                                    navigate(.canvas)
                                                    Task { await model.openRecord(item.id) }
                                                } label: {
                                                    VStack(alignment:.leading,spacing:9) {
                                                        Text(item.title)
                                                            .font(.system(size:12,weight:.medium))
                                                            .foregroundStyle(.primary)
                                                            .multilineTextAlignment(.leading)
                                                            .frame(maxWidth:.infinity,alignment:.leading)
                                                            .lineLimit(3)
                                                        requirementExecutionStatusView(for:item)
                                                        if let status=model.planningAutopilotStatuses[item.recordId],
                                                           let summary=status.lastSummary,!summary.isEmpty {
                                                            Text(summary)
                                                                .font(.system(size:10))
                                                                .foregroundStyle(.secondary)
                                                                .multilineTextAlignment(.leading)
                                                                .lineLimit(2)
                                                        }
                                                        HStack(spacing:7) {
                                                            Text(item.recordId)
                                                                .font(.system(size:9,design:.monospaced))
                                                                .lineLimit(1).truncationMode(.middle)
                                                                .frame(maxWidth:105,alignment:.leading)
                                                                .help(item.recordId)
                                                            Spacer(minLength:0)
                                                            if item.priority != nil || item.assignee?.isEmpty == false {
                                                             HStack(spacing:7) {
                                                                 if let priority=ZenWorkspacePane.priorityLabel(item.priority) {
                                                                     Text(priority)
                                                                         .foregroundStyle(priority == "紧急" ? Color.orange : Color.secondary)
                                                                         .padding(.horizontal,7).padding(.vertical,3)
                                                                         .background(priority == "紧急" ? Color.orange.opacity(0.10) : Color.primary.opacity(0.045),
                                                                                     in:Capsule())
                                                                 }
                                                                 if let assignee=item.assignee,!assignee.isEmpty {
                                                                     Text(assignee)
                                                                         .foregroundStyle(.secondary)
                                                                         .lineLimit(1)
                                                                         .padding(.horizontal,7).padding(.vertical,3)
                                                                         .background(Color.primary.opacity(0.045),in:Capsule())
                                                                         .help(assignee)
                                                                 }
                                                             }
                                                             .font(.system(size:9.5))
                                                         }
                                                        }
                                                        .foregroundStyle(.secondary)
                                                    }
                                                    .padding(13)
                                                    .frame(maxWidth:.infinity,alignment:.leading)
                                                    .background(ForgeBoardAppearance.cardSurface,
                                                                in:RoundedRectangle(cornerRadius:10,style:.continuous))
                                                    .contentShape(RoundedRectangle(cornerRadius:10,style:.continuous))
                                                }
                                                .buttonStyle(ZenPressStyle())
                                                .accessibilityIdentifier("zen.requirement.\(item.recordId)")
                                            }
                                        }
                                    }
                                    .scrollIndicators(.hidden)
                                }
                                .padding(13)
                                .frame(width:ForgeBoardAppearance.columnWidth(available:frame.size.width,
                                                                             columnCount:visibleStages.count),
                                       alignment:.topLeading)
                                .frame(maxHeight:.infinity)
                                .background(ForgeBoardAppearance.columnColor(boardTone(stage),scheme:colorScheme),
                                            in:RoundedRectangle(cornerRadius:13,style:.continuous))
                            }
                        }
                        .padding(.horizontal,24).padding(.bottom,24)
                    }
                    .scrollIndicators(.hidden)
                }
                if requirements.isEmpty && model.checkoutContextLoading {
                    ProgressView("正在读取当前项目…")
                        .controlSize(.small)
                        .font(.system(size:11))
                        .frame(maxWidth:.infinity,maxHeight:.infinity)
                } else if requirements.isEmpty {
                    ZenEmptyState(title:"暂无 Requirement",
                                  subtitle:"使用“描述目标”开始，或直接创建一项需求。",
                                  symbol:"checklist")
                } else if visibleRequirements.isEmpty {
                    VStack(spacing:10) {
                        Text("没有匹配的需求")
                            .font(.system(size:12,weight:.medium))
                        Button("清除搜索") {
                            requirementQuery=""
                            searchFocused=true
                        }
                        .buttonStyle(.link)
                    }
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
                }
                }
            }
        }
    }

    private func openRequirement(_ item:ForgeRecord) {
        focusedRequirementId=item.recordId
        navigate(.canvas)
        Task { await model.openRecord(item.id) }
    }

    private func boardTone(_ stage:ZenBoardBucket) -> ForgeBoardTone {
        switch stage {
        case .todo,.planned: return .todo
        case .active,.running: return .progress
        case .waitingForUser: return .blocked
        case .done: return .done
        case .cancelled: return .neutral
        }
    }

    private func bucketColor(_ stage:ZenBoardBucket) -> Color {
        switch stage {
        case .done: return .green.opacity(0.75)
        case .running,.active: return .accentColor
        case .waitingForUser: return .orange
        case .todo,.planned,.cancelled: return .secondary.opacity(0.5)
        }
    }

    private func requirementListRow(_ item:ForgeRecord) -> some View {
        let stage=bucket(item)
        return Button { openRequirement(item) } label: {
            HStack(spacing:12) {
                VStack(alignment:.leading,spacing:3) {
                    Text(item.title)
                        .font(.system(size:12,weight:.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    requirementExecutionStatusView(for:item)
                    if let summary=model.planningAutopilotStatuses[item.recordId]?.lastSummary,
                       !summary.isEmpty {
                        Text(summary).font(.system(size:10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth:.infinity,alignment:.leading)
                HStack(spacing:10) {
                    HStack(spacing:5) {
                        Circle().fill(bucketColor(stage)).frame(width:6,height:6)
                        Text(stage.title)
                    }
                    if let priority=ZenWorkspacePane.priorityLabel(item.priority) {
                        Text(priority).foregroundStyle(priority == "紧急" ? Color.orange : Color.secondary)
                    }
                    if let assignee=item.assignee,!assignee.isEmpty {
                        Text(assignee).lineLimit(1).foregroundStyle(.secondary)
                    }
                }
                .font(.system(size:10))
                Image(systemName:"chevron.right")
                    .font(.system(size:9,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical,11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment:.bottom) {
            Rectangle().fill(Color.primary.opacity(0.055)).frame(height:1)
        }
        .accessibilityIdentifier("zen.requirement.list.\(item.recordId)")
    }

    private var canvasContent: some View {
        Group {
            if let root = requirements.first(where:{$0.recordId == focusedRequirementId}) {
                GeometryReader { viewport in
                    let selected = model.records.first(where:{
                        $0.id == model.selectedRecord
                        && ($0.id == root.id || $0.requirementId == root.recordId)
                    })
                    // On compact windows the detail replaces the canvas instead of
                    // shrinking a wide, interactive tree to an unusable strip.
                    if viewport.size.width < 920, let selected {
                        detailInspector(selected,compact:true)
                            .frame(maxWidth:.infinity,maxHeight:.infinity)
                    } else {
                        HStack(spacing:0) {
                            ZenTreeCanvas(
                                root:root,records:model.records,selectedId:model.selectedRecord,
                                executionStatuses:model.planningAutopilotStatuses,
                                hasRepository:model.projectRepositoryId != nil,
                                executionBusy:model.autopilotLoading || model.autopilotControlPending,
                                unresolvedOutcomeRequirementIds:executionOutcomeUnknownRequirementIds,
                                onSelect:{ item in
                                    Task { await model.openRecord(item.id) }
                                },onAction:{ item,action in
                                    handleNodeAction(item,action)
                                }
                            )
                            if let selected {
                                detailInspector(selected)
                                    .frame(width:304)
                            }
                        }
                    }
                }
            } else {
                ZenEmptyState(title:"选择 Requirement",subtitle:"从工作看板选择一个需求查看计划树。",symbol:"point.3.connected.trianglepath.dotted")
            }
        }
    }

    static func createdRecordDetailMatches(
        _ item:ForgeRecord,detail:SemanticRecordDetail?
    ) -> Bool {
        switch detail {
        case .requirement(let value):
            return item.kind == .requirement && value.requirementId == item.recordId
                && item.title == value.title && item.state == value.state
        case .plan(let value):
            return item.kind == .plan && value.planId == item.recordId
                && item.title == value.goal && item.requirementId == value.requirementId
                && item.parentPlanId == value.parentPlanId
        case nil:
            return false
        }
    }

    private func detailLoaded(for item:ForgeRecord) -> Bool {
        Self.createdRecordDetailMatches(item,detail:model.recordDetail)
    }

    // Plan records have no lifecycle in this view; their 'Plan' source marker is a kind.
    // Requirement labels describe its canonical lifecycle, not Autopilot activity.
    static func inspectorLifecycleLabel(for item:ForgeRecord) -> String? {
        guard item.kind == .requirement else { return nil }
        switch item.state {
        case "planned": return "已规划"
        case "open": return "未完成"
        case "completed", "done": return "已完成"
        case "cancelled": return "已取消"
        default: return nil
        }
    }

    private func detailInspector(_ item:ForgeRecord,compact:Bool = false) -> some View {
        ScrollView {
            VStack(alignment:.leading,spacing:15) {
                HStack {
                    Text(item.kind == .requirement ? "Requirement" : "Plan")
                        .font(.system(size:10,weight:.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    if detailLoaded(for:item) {
                         Button(item.kind == .requirement ? "编辑任务" : "编辑") {
                             beginEdit(item)
                         }
                         .buttonStyle(.plain)
                         .font(.system(size:10))
                     }
                    if let state=Self.inspectorLifecycleLabel(for:item) {
                        Text(state).font(.system(size:10)).foregroundStyle(.secondary)
                    }
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                            model.clearRecordSelection()
                        }
                    } label: {
                        Image(systemName:compact ? "chevron.left" : "xmark").frame(width:26,height:26)
                    }
                    .buttonStyle(.plain)
                    .help(compact ? "返回画布" : "关闭详情")
                    .accessibilityLabel(compact ? "返回画布" : "关闭详情")
                    .accessibilityIdentifier("zen.inspector.close")
                }
                Text(item.title).font(.system(size:16,weight:.semibold))
                Text(item.recordId).font(.system(size:10,design:.monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Divider()
                switch model.recordDetail {
                case .requirement(let detail) where item.kind == .requirement && detail.requirementId == item.recordId:
                     HStack(alignment:.top,spacing:18) {
                         VStack(alignment:.leading,spacing:3) {
                             Text("状态").font(.system(size:10)).foregroundStyle(.secondary)
                             Text(Self.taskStatusLabel(detail.taskStatus) ?? "未设置")
                                 .font(.system(size:11,weight:.medium))
                         }
                         VStack(alignment:.leading,spacing:3) {
                             Text("优先级").font(.system(size:10)).foregroundStyle(.secondary)
                             Text(Self.priorityLabel(detail.priority) ?? "未设置")
                                 .font(.system(size:11,weight:.medium))
                         }
                         if let assignee=detail.assignee,!assignee.isEmpty {
                             VStack(alignment:.leading,spacing:3) {
                                 Text("负责人").font(.system(size:10)).foregroundStyle(.secondary)
                                 Text(assignee).font(.system(size:11,weight:.medium)).lineLimit(1)
                             }
                         }
                     }
                     Divider()

                    Text("目标").font(.system(size:12,weight:.semibold))
                    Text(detail.outcomeStatement).font(.system(size:12))
                        .textSelection(.enabled)
                    if !detail.acceptanceCriteria.isEmpty {
                        Divider()
                        Text("验收标准").font(.system(size:12,weight:.semibold))
                        ForEach(detail.acceptanceCriteria,id:\.self) { criterion in
                            Label(criterion,systemImage:"circle")
                                .font(.system(size:11))
                        }
                    }
                    if !detail.dependencyRequirementIds.isEmpty {
                        Divider()
                        Text("依赖任务").font(.system(size:12,weight:.semibold))
                        ForEach(detail.dependencyRequirementIds,id:\.self) { id in
                            let dependency=detail.dependencyRequirements.first(where:{$0.requirementId == id})
                            HStack {
                                VStack(alignment:.leading,spacing:2) {
                                    Text(dependency?.title ?? id).font(.system(size:11))
                                    Text(id).font(.system(size:9,design:.monospaced)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if dependency?.missing == true {
                                    Text("未找到").font(.system(size:10)).foregroundStyle(.orange)
                                } else if detail.blockingDependencyIds.contains(id) {
                                    Text("阻塞中").font(.system(size:10)).foregroundStyle(.orange)
                                } else if let status=dependency?.status {
                                    Text(Self.taskStatusLabel(status) ?? status).font(.system(size:10)).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Divider()
                    VStack(alignment:.leading,spacing:9) {
                        Text("依赖此任务").font(.system(size:12,weight:.semibold))
                        if let dependents = detail.dependentRequirements {
                            if dependents.isEmpty {
                                Text(detail.dependentRequirementsTruncated == true
                                     ? "依赖扫描不完整，暂时无法确认下游任务"
                                     : "暂无下游任务")
                                    .font(.system(size:11)).foregroundStyle(.secondary)
                            } else {
                                ForEach(dependents) { dependent in
                                    let projectName=dependent.projectId.flatMap { projectId in
                                        model.semanticProjects.first(where:{$0.projectId == projectId})?.displayName
                                    }
                                    let repositoryName=dependent.repoId.flatMap { repoId in
                                        model.projects.first(where:{$0.repoId == repoId})?.label
                                    }
                                    VStack(alignment:.leading,spacing:3) {
                                        HStack(alignment:.firstTextBaseline,spacing:8) {
                                            Text(dependent.title).font(.system(size:11,weight:.medium))
                                                .frame(maxWidth:.infinity,alignment:.leading)
                                            Text(dependent.blocksDependent.map { $0 ? "仍被此任务阻塞" : "已解除阻塞" } ?? "阻塞状态未知")
                                                .font(.system(size:10))
                                                .foregroundStyle(dependent.blocksDependent == true ? .orange : .secondary)
                                        }
                                        HStack(spacing:5) {
                                            Text(dependent.requirementId)
                                                .font(.system(size:9,design:.monospaced))
                                            if let projectName {
                                                Text("· \(projectName)").font(.system(size:9))
                                            }
                                            if let repositoryName {
                                                Text("· \(repositoryName)").font(.system(size:9))
                                            }
                                            Spacer(minLength:4)
                                            if let status=dependent.status {
                                                Text(Self.taskStatusLabel(status) ?? status)
                                                    .font(.system(size:10)).foregroundStyle(.secondary)
                                            }
                                        }
                                        .foregroundStyle(.secondary)
                                    }
                                    .accessibilityIdentifier("zen.record.dependent.\(dependent.requirementId)")
                                }
                                if detail.dependentRequirementsTruncated == true {
                                    Text(detail.dependentRequirementCount.map { "仅显示前 20 项，共 \($0) 项" }
                                         ?? "依赖任务扫描达到上限，当前结果可能不完整")
                                        .font(.system(size:10)).foregroundStyle(.secondary)
                                }
                            }
                        } else {
                            Text("依赖信息暂不可用")
                                .font(.system(size:11)).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("zen.record.dependents")
                    if !detail.progressSummary.isEmpty {
                        Divider()
                        Text("当前进展").font(.system(size:12,weight:.semibold))
                        Text(detail.progressSummary).font(.system(size:11))
                            .textSelection(.enabled)
                    }
                    if !detail.acceptedEvidenceRefs.isEmpty {
                        Divider()
                        Text("验收证据").font(.system(size:12,weight:.semibold))
                        ForEach(detail.acceptedEvidenceRefs,id:\.self) { reference in
                            Text(reference).font(.system(size:10,design:.monospaced))
                                .textSelection(.enabled)
                        }
                    }
                    if !detail.remainingWork.isEmpty {
                        Divider()
                        Text("尚待完成").font(.system(size:12,weight:.semibold))
                        ForEach(detail.remainingWork,id:\.self) { work in
                            Text("· \(work)").font(.system(size:11))
                        }
                    }
                case .plan(let detail) where item.kind == .plan && detail.planId == item.recordId:
                    Text("目标").font(.system(size:12,weight:.semibold))
                    Text(detail.goal).font(.system(size:12)).textSelection(.enabled)
                    Divider()
                    Text("计划事项").font(.system(size:12,weight:.semibold))
                    ForEach(detail.items) { step in
                        Text(step.objective).font(.system(size:11))
                            .frame(maxWidth:.infinity,alignment:.leading)
                    }
                default:
                    ProgressView("正在读取当前节点…")
                        .font(.system(size:11))
                        .controlSize(.small)
                }

                if detailLoaded(for:item) && item.kind == .requirement
                    && model.projectRepositoryId != nil {
                    zenExecutionSection(item)
                }
            }
            .padding(18)
            .frame(maxWidth:.infinity,alignment:.leading)
        }
        .accessibilityIdentifier("zen.record.inspector")
    }



    private func prepareExecutionApproval(_ item:ForgeRecord,repoId activeRepoId:String) {
        guard !model.autopilotOutcomeUnknown(for:item.recordId) else {
            model.error="操作结果未确认。请先刷新执行状态，不要重复提交。"
            return
        }
        guard item.kind == .requirement,
              let activeProjectId=model.selectedProjectId,
              let activeCheckoutId=model.checkoutId else { return }
        let activeContextGeneration=model.projectContextGeneration
        Task {
            await model.openRecord(item.id)
            guard model.selectedProjectId == activeProjectId,
                  model.projectContextGeneration == activeContextGeneration,
                  model.repoId == activeRepoId,model.checkoutId == activeCheckoutId,
                  model.selectedRecord == item.id,
                  case .requirement(let detail)=model.recordDetail,
                  detail.requirementId == item.recordId,Self.requirementAllowsActions(detail.state) else { return }
            let statusLoaded = await model.loadAutopilotStatus(item.recordId)
            guard statusLoaded,
                  model.selectedProjectId == activeProjectId,
                  model.projectContextGeneration == activeContextGeneration,
                  model.repoId == activeRepoId,model.checkoutId == activeCheckoutId,
                  model.selectedRecord == item.id,
                  !model.autopilotLoading,!model.autopilotControlPending,
                  let status=model.autopilotStatus else { return }
            guard status.requirementRevision == detail.revision else {
                model.error="需求已变化，请刷新后重新批准。"
                return
            }
            guard !model.repositoryAccessLoading else {
                model.error="正在读取仓库权限，请稍后重新打开批准面板。"
                return
            }
            let plans=model.records.filter {
                $0.kind == .plan && $0.requirementId == item.recordId && $0.state == "active"
            }
            pendingExecutionApproval=ZenExecutionApproval(
                projectId:activeProjectId,
                contextGeneration:activeContextGeneration,
                repoId:activeRepoId,
                checkoutId:activeCheckoutId,
                projectLabel:model.project?.displayName ?? activeRepoId,
                checkoutLabel:model.checkoutBranch ?? activeCheckoutId,
                repositoryAccessMode:model.repositoryAccessMode,
                requirement:detail,
                status:status,
                plans:plans
            )
        }
    }

    private func handleNodeAction(_ item:ForgeRecord,_ action:ZenNodeAction) {
        guard let context=currentSemanticCreationContext,
              let root=requirements.first(where:{$0.recordId == focusedRequirementId}),
              item.id == root.id || item.requirementId == root.recordId,
              !action.requiresRepository || context.repoId != nil else { return }
        switch action {
        case .addPlan:
            guard Self.requirementAllowsActions(root.state) else { return }
            newPlanGoal=""
            newParentPlanId=item.kind == .plan ? item.recordId : nil
            showingPlanSheet=true
        case .edit, .complete, .cancel:
            guard Self.requirementAllowsActions(root.state) else { return }
            Task {
                await model.openRecord(item.id)
                guard model.selectedProjectId == context.projectId,
                      model.projectRepositoryId == context.repoId,
                      model.selectedRecord == item.id,
                      detailLoaded(for:item) else { return }
                switch action {
                case .edit:
                    beginEdit(item)
                case .complete:
                    guard case .requirement(let detail)=model.recordDetail,
                          detail.requirementId == item.recordId,Self.requirementAllowsActions(detail.state) else { return }
                    acceptanceReferences=detail.acceptedEvidenceRefs.joined(separator:"\n")
                    acceptanceRemainingWork=detail.remainingWork.joined(separator:"\n")
                    acceptanceAcknowledged=false
                    pendingAcceptanceRecord=item
                case .cancel:
                    guard case .requirement(let detail)=model.recordDetail,
                          detail.requirementId == item.recordId,Self.requirementAllowsActions(detail.state) else { return }
                    cancellingRequirement=detail
                default:
                    break
                }
            }
        case .optimize:
            onOpenAgent(item,"请基于当前 Requirement / Plan 的实际修订与关联信息分析并提出最小必要优化，先给出差异和影响范围，不要在未经确认时新增同义记录。",nil,true)
        case .review:
            pendingReviewRecord=item
        case .executionSettings:
            guard let repoId=context.repoId else { return }
            prepareExecutionApproval(item,repoId:repoId)
        case .toggleExecution:
            guard let repoId=context.repoId,
                  item.kind == .requirement,Self.requirementAllowsActions(root.state),
                  let operation=Self.executionOperation(
                    status:model.planningAutopilotStatuses[item.recordId],
                    outcomeUnknown:model.autopilotOutcomeUnknown(for:item.recordId)
                  ) else { return }
            if operation == "authorize" { prepareExecutionApproval(item,repoId:repoId) }
            else if operation == "accept_checkpoint" {
                guard let status=model.planningAutopilotStatuses[item.recordId] else { return }
                pendingCheckpointReview=AutopilotCheckpointReview(
                    model:model,requirementId:item.recordId,status:status
                )
            } else { runExecution(item.recordId,operation) }
        }
    }

    private func acceptanceSheet(_ item:ForgeRecord) -> some View {
        VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.section) {
            Text("完成 Requirement").font(ForgeClientDesign.Typography.sheetTitle)
            Text("终态不可重开。请先核查验收标准和交付证据；这里只登记已经存在的证据引用，不创建或伪造证据。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            if case .requirement(let detail) = model.recordDetail,
               detail.requirementId == item.recordId {
                Text(detail.title).font(.system(size:12,weight:.semibold))
                if !detail.acceptanceCriteria.isEmpty {
                    Text("验收标准").font(.system(size:11,weight:.semibold))
                    ScrollView {
                        VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.row) {
                            ForEach(detail.acceptanceCriteria,id:\.self) { criterion in
                                Label(criterion,systemImage:"checkmark.circle")
                                    .font(.system(size:11))
                            }
                        }
                    }
                    .frame(maxHeight:ForgeClientDesign.Size.acceptanceCriteriaMaxHeight)
                    .scrollIndicators(.hidden)
                    .accessibilityIdentifier("zen.acceptance.criteria")
                }
                if !Self.nonEmptyLines(acceptanceRemainingWork).isEmpty {
                    Text("还有 \(Self.nonEmptyLines(acceptanceRemainingWork).count) 项剩余工作，清空后才能完成。")
                        .font(.system(size:11)).foregroundStyle(.orange)
                }
                ForgeClientFormField(label: "剩余工作") {
                    TextField("每行一项；清空后可完成",text:$acceptanceRemainingWork,axis:.vertical)
                        .lineLimit(3...6)
                        .accessibilityIdentifier("zen.acceptance.remainingWork")
                }
                ForgeClientFormField(label: "验收证据引用") {
                    TextField("每行一条真实证据",text:$acceptanceReferences,axis:.vertical)
                        .lineLimit(4...6)
                        .accessibilityIdentifier("zen.acceptance.references")
                }
                Toggle("验收标准均已核对，证据引用真实可复查",isOn:$acceptanceAcknowledged)
                    .font(.system(size:11))
                    .accessibilityIdentifier("zen.acceptance.acknowledgement")
                HStack {
                    Spacer()
                    Button("返回") { pendingAcceptanceRecord=nil }
                        .accessibilityIdentifier("zen.acceptance.cancel")
                    Button(saving ? "提交中…" : "确认完成") {
                        saving=true
                        Task {
                            let ok=await model.transitionRequirement(
                                id:detail.requirementId,expectedRevision:detail.revision,
                                title:detail.title,outcome:detail.outcomeStatement,
                                acceptanceCriteria:detail.acceptanceCriteria,state:"completed",
                                acceptedEvidenceRefs:acceptanceReferences.components(separatedBy:.newlines),
                                remainingWork:Self.nonEmptyLines(acceptanceRemainingWork)
                            )
                            saving=false
                            if ok { pendingAcceptanceRecord=nil }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("zen.acceptance.confirm")
                    .disabled(saving || !acceptanceAcknowledged
                              || !Self.nonEmptyLines(acceptanceRemainingWork).isEmpty
                              || acceptanceReferences.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                }
            } else {
                Text("无法确认当前 Requirement，请返回刷新。")
                    .font(.system(size:11)).foregroundStyle(.orange)
                Button("关闭") { pendingAcceptanceRecord=nil }
            }
            if let error=model.error {
                Text(error).font(.system(size:10)).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("zen.acceptance.error")
            }
        }
        .padding(ForgeClientDesign.Spacing.sheetPadding)
        .frame(width:ForgeClientDesign.Size.taskAcceptanceSheet)
        .accessibilityIdentifier("zen.acceptance.confirm")
    }

    private func beginEdit(_ item:ForgeRecord) {
        guard let detail=model.recordDetail else { return }
        switch detail {
        case .requirement(let value) where item.kind == .requirement:
            editRevision=value.revision
            editTitle=value.title
            editOutcome=value.outcomeStatement
            editCriteria=value.acceptanceCriteria.joined(separator:"\n")
            editTaskStatus=value.taskStatus
            editTaskStatusOptions=Self.editableTaskStatuses(from:value.taskStatus)
            editPriority=value.priority ?? "unset"
            editAssignee=value.assignee ?? ""
            editRemainingWork=value.remainingWork.joined(separator:"\n")
            editDependencyRequirementIds=value.dependencyRequirementIds
            editDependencyDetails=value.dependencyRequirements
            editBlockingDependencyIds=value.blockingDependencyIds
            editDependencyIdDraft=""

        case .plan(let value) where item.kind == .plan:
            editRevision=value.revision
            editTitle=value.goal
        default:
            return
        }
        model.error = nil
        editingRecord=item
    }

    private func editSheet(for item:ForgeRecord) -> some View {
        VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.section) {
            Text(item.kind == .requirement ? "编辑任务" : "编辑计划")
                .font(ForgeClientDesign.Typography.sheetTitle)
            Text(item.recordId + " · v\(editRevision)")
                .font(.system(size:10,design:.monospaced))
                .foregroundStyle(.secondary)

            ScrollView {
                if item.kind == .requirement {
                ForgeClientFormField(label: "名称") {
                    TextField("任务名称",text:$editTitle)
                        .accessibilityIdentifier("zen.record.edit.title")
                }
                ForgeClientFormField(label: "预期结果") {
                    TextField("预期结果",text:$editOutcome,axis:.vertical).lineLimit(3...6)
                        .accessibilityIdentifier("zen.record.edit.outcome")
                }
                ForgeClientFormField(label: "验收标准") {
                    TextField("每行一项",text:$editCriteria,axis:.vertical).lineLimit(3...7)
                        .accessibilityIdentifier("zen.record.edit.acceptance-criteria")
                }
                HStack(alignment:.top,spacing:ForgeClientDesign.Spacing.row) {
                    ForgeClientFormField(label:"状态") {
                        Picker("",selection:Binding(
                            get:{ editTaskStatus ?? "unset" },
                            set:{ editTaskStatus=$0 == "unset" ? nil : $0 }
                        )) {
                            ForEach(editTaskStatusOptions,id:\.self) { status in
                                Text(status == "unset" ? "未设置" : Self.taskStatusLabel(status) ?? status)
                                    .tag(status)
                            }
                        }
                        .labelsHidden()
                        .accessibilityLabel("状态")
                        .accessibilityIdentifier("zen.record.edit.status")
                    }
                    ForgeClientFormField(label:"优先级") {
                        Picker("",selection:$editPriority) {
                            if editPriority == "unset" { Text("未设置").tag("unset") }
                            Text("低").tag("low")
                            Text("普通").tag("normal")
                            Text("高").tag("high")
                            Text("紧急").tag("urgent")
                        }
                        .labelsHidden()
                        .accessibilityLabel("优先级")
                        .accessibilityIdentifier("zen.record.edit.priority")
                    }
                }
                 ForgeClientFormField(label: "负责人") {
                     TextField("留空表示未指派",text:$editAssignee)
                         .accessibilityIdentifier("zen.record.edit.assignee")
                 }
                  dependencyEditor(
                      selection:$editDependencyRequirementIds,excluding:item.recordId,
                      details:editDependencyDetails,blockingIds:editBlockingDependencyIds,
                      idDraft:$editDependencyIdDraft
                  )
                  ForgeClientFormField(label: "剩余工作") {
                      TextField("每行一项",text:$editRemainingWork,axis:.vertical).lineLimit(2...5)
                          .accessibilityIdentifier("zen.record.edit.remaining-work")
                  }
            } else {
                ForgeClientFormField(label: "计划目标") {
                    TextField("计划目标",text:$editTitle,axis:.vertical).lineLimit(3...6)
                        .accessibilityIdentifier("zen.record.edit.plan-title")
                }
                }
            }
            .frame(maxHeight:ForgeClientDesign.Size.taskFormContentMaxHeight)

            if let problem=model.error {
                Text(problem)
                    .font(.system(size:11))
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("zen.record.edit.error")
            }
            HStack {
                Spacer()
                Button("取消") { editingRecord=nil }
                Button(saving ? "保存中…" : "保存修改") {
                    model.error = nil
                    saving=true
                    Task {
                        let ok:Bool
                        if item.kind == .requirement {
                            ok=await model.reviseRequirement(
                                id:item.recordId,expectedRevision:editRevision,
                                title:editTitle,outcome:editOutcome,
                                acceptanceCriteria:editCriteria.components(separatedBy:.newlines),
                                 taskStatus:editTaskStatus,
                                 priority:editPriority == "unset" ? nil : editPriority,
                                 assignee:editAssignee,
                                  dependencyRequirementIds:editDependencyRequirementIds,
                                  remainingWork:Self.nonEmptyLines(editRemainingWork)
                            )
                        } else {
                            ok=await model.revisePlan(
                                id:item.recordId,expectedRevision:editRevision,objective:editTitle
                            )
                        }
                        saving=false
                        if ok { editingRecord=nil }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || editTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                          || (item.kind == .requirement
                              && (editOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || editAssignee.utf16.count > 160)))
            }
        }
        .padding(ForgeClientDesign.Spacing.sheetPadding)
        .frame(width:ForgeClientDesign.Size.taskEditSheet)
        .accessibilityIdentifier("zen.record.edit")
    }



    struct ReviewableProposal {
        let threadId: String
        let threadTitle: String
        let proposal: ZenChangeProposal

        var menuLabel: String {
            let subject=proposal.title ?? proposal.objective ?? proposal.targetId
                ?? proposal.requirementId ?? "未命名"
            return "\(proposal.operation.displayName) · \(subject.prefix(36)) · \(threadTitle.prefix(24))"
        }
    }

    // Candidates must be final assistant replies from a read-only conversation
    // bound to this Project/Repo/Checkout. Superseded ACCEPTs never reappear.
    static func reviewableProposals(
        threads:[ChatThread],repoId:String?,checkoutId:String?,projectId:String? = nil
    ) -> [ReviewableProposal] {
        threads.sorted(by:{$0.updatedAt > $1.updatedAt}).compactMap { thread in
            guard NativeWorkspace.readOnlyThreadMatchesContext(
                thread,repoId:repoId,checkoutId:checkoutId,projectId:projectId
            ),let response=thread.messages.last,
              response.role == "assistant",response.incomplete != true,
              let proposal=try? ZenChangeProposal.parse(response.text),
              proposal.matchesAnalysisContext(requirementId:thread.requirementId,planId:thread.planId)
            else { return nil }
            return ReviewableProposal(threadId:thread.id,threadTitle:thread.title,proposal:proposal)
        }
    }

    static func latestReviewableProposal(
        threads:[ChatThread],repoId:String?,checkoutId:String?,projectId:String? = nil
    ) -> ZenChangeProposal? {
        reviewableProposals(
            threads:threads,repoId:repoId,checkoutId:checkoutId,projectId:projectId
        ).first?.proposal
    }

    private var reviewableProposals: [ReviewableProposal] {
        Self.reviewableProposals(
            threads:model.threads,repoId:model.repoId,checkoutId:model.checkoutId,
            projectId:model.selectedProjectId
        )
    }

    private func reviewLatestProposal() {
        reviewProposal(threadId:reviewableProposals.first?.threadId)
    }

    private func reviewProposal(threadId:String?) {
        guard let projectId=model.selectedProjectId,!model.busy else { return }
        guard model.repoId == nil || model.projectRepositoryId == model.repoId else {
            proposalProblem="当前仓库不属于所选项目，请重新选择项目或仓库后再审阅。"
            showingProposalProblem=true
            return
        }
        guard let candidate=reviewableProposals.first(where:{$0.threadId == threadId}) else {
            proposalProblem="当前项目没有可审阅的最终 ACCEPT。请先在只读 Agent 分析会话完成精化。"
            showingProposalProblem=true
            return
        }
        proposalSourceProjectId=projectId
        proposalSourceRepoId=model.repoId
        proposalSourceCheckoutId=model.checkoutId
        pendingProposal=candidate.proposal
    }

    private var goalSheet: some View {
        VStack(alignment:.leading,spacing:14) {
            Text("描述你的目标").font(.system(size:17,weight:.semibold))
            Text("分析过程为只读；多轮澄清后生成提案，只有你批准后才会修改记录。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            ForgeClientFormField(label:"目标描述") {
                TextField("希望解决什么问题？",text:$goalDraft,axis:.vertical)
                    .lineLimit(5...8)
                    .accessibilityLabel("目标描述")
                    .accessibilityIdentifier("zen.goal.input")
            }
            HStack {
                Spacer()
                Button("取消") { showingGoalSheet=false }
                    .accessibilityIdentifier("zen.goal.cancel")
                Button("分析需求") {
                    let description=goalDraft.trimmingCharacters(in:.whitespacesAndNewlines)
                    showingGoalSheet=false
                    onDraftGoal(description)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("zen.goal.analyze")
                .disabled(goalDraft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22).frame(width:475)
        .accessibilityIdentifier("zen.goal.compose")
    }

    @ViewBuilder
    private func zenExecutionSection(_ item:ForgeRecord) -> some View {
        Divider()
        VStack(alignment:.leading,spacing:10) {
            HStack {
                Text("自主执行").font(.system(size:12,weight:.semibold))
                Spacer()
                if model.autopilotLoading { ProgressView().controlSize(.small) }
            }
            if let status=model.planningAutopilotStatuses[item.recordId] {
                HStack(spacing:7) {
                    Circle()
                        .fill(status.runtimeActive ? Color.accentColor : Color.secondary.opacity(0.55))
                        .frame(width:6,height:6)
                    Text(status.runStatus == "running" && !status.runtimeActive
                         ? "运行未激活" : (status.runStatus ?? "未开始")).font(.system(size:11))
                        .foregroundStyle(.secondary)
                    if status.requiresReapproval {
                        Text("需求已修订，需重新批准").font(.system(size:10))
                            .foregroundStyle(.orange)
                    }
                }
                if let summary=status.lastSummary,!summary.isEmpty {
                    Text(summary).font(.system(size:11)).textSelection(.enabled)
                }
                if let reason=status.stopReason,!reason.isEmpty {
                    Text(reason).font(.system(size:10))
                        .foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let processId=status.pendingProcessId {
                    Label("等待 Process 终态回执",systemImage:"hourglass")
                        .font(.system(size:10)).foregroundStyle(.orange)
                    Text(processId).font(.system(size:9.5,design:.monospaced))
                        .foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let requestId=status.pendingCommandRequestId {
                    Label(status.pendingProcessId == nil ? "命令受理结果待核对" : "原始请求 ID",systemImage:"arrow.triangle.2.circlepath")
                        .font(.system(size:10)).foregroundStyle(.orange)
                    Text(requestId).font(.system(size:9.5,design:.monospaced))
                        .foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let recoverySummary=status.pendingProcessRecoverySummary {
                    Text(recoverySummary)
                        .font(.system(size:10)).foregroundStyle(.secondary)
                }
                if let plan=status.currentPlanId,!plan.isEmpty {
                    Text("当前 Plan · \(plan)").font(.system(size:10,design:.monospaced))
                        .foregroundStyle(.secondary)
                }
                if !status.hasPendingProcessRecovery && (!status.authorized || status.requiresReapproval) {
                    Label("需要批准执行",systemImage:"lock")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                }
            } else {
                Text("尚未读取到执行状态。").font(.system(size:11))
                    .foregroundStyle(.secondary)
            }
            if model.autopilotOutcomeUnknown(for:item.recordId) {
                Text("操作结果未确认。请先刷新执行状态，不要重复提交。")
                    .font(.system(size:10)).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("zen.execution.outcome-unknown")
            }
            if let issue=model.planningAutopilotStatusError {
                Text(issue).font(.system(size:10)).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("zen.execution.error")
            }
            if Self.requirementAllowsActions(item.state) {
                HStack(spacing:9) {
                    if let operation=Self.executionOperation(
                        status:model.planningAutopilotStatuses[item.recordId],
                        outcomeUnknown:model.autopilotOutcomeUnknown(for:item.recordId)
                    ) {
                        Button(Self.executionLabel(
                            operation:operation,
                            runStatus:model.planningAutopilotStatuses[item.recordId]?.runStatus,
                            needsBudgetRenewal:model.planningAutopilotStatuses[item.recordId]?.needsBudgetRenewal == true,
                            hasPendingProcessRecovery:model.planningAutopilotStatuses[item.recordId]?.hasPendingProcessRecovery == true
                        )) {
                            handleNodeAction(item,operation == "authorize" ? .executionSettings : .toggleExecution)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.autopilotLoading || model.autopilotControlPending)
                        .accessibilityIdentifier("zen.execution.primary")
                    }
                    Button {
                        Task { await model.loadAutopilotStatus(item.recordId) }
                    } label: {
                        Label("刷新执行状态",systemImage:"arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                    .disabled(model.autopilotLoading || model.autopilotControlPending)
                    .accessibilityIdentifier("zen.execution.refresh")
                }
            }
        }
        .accessibilityIdentifier("zen.execution.summary")
    }

    private func runExecution(_ requirementId:String,_ operation:String) {
        guard let projectId=model.selectedProjectId,
              let repoId=model.repoId,let checkoutId=model.checkoutId,
              !model.autopilotLoading,!model.autopilotControlPending,
              Self.executionOperation(
                status:model.planningAutopilotStatuses[requirementId],
                outcomeUnknown:model.autopilotOutcomeUnknown(for:requirementId)
              ) == operation else { return }
        let contextGeneration=model.projectContextGeneration
        Task {
            guard model.selectedProjectId == projectId,
                  model.projectContextGeneration == contextGeneration,
                  model.repoId == repoId,model.checkoutId == checkoutId else { return }
            _ = await model.controlAutopilot(requirementId:requirementId,operation:operation)
        }
    }

    private func dependencyEditor(
        selection:Binding<[String]>,excluding requirementId:String?,
        details:[RequirementDependencyDetail] = [],blockingIds:[String] = [],idDraft:Binding<String>
    ) -> some View {
        let available=requirements.filter{$0.recordId != requirementId && $0.state != "cancelled"}
        return VStack(alignment:.leading,spacing:7) {
            HStack {
                Text("依赖任务").font(.system(size:11,weight:.semibold))
                Spacer()
                Menu {
                    ForEach(available) { candidate in
                        Button { toggleDependency(candidate.recordId,selection:selection) } label: {
                            Label(candidate.title,systemImage:selection.wrappedValue.contains(candidate.recordId) ? "checkmark.circle.fill" : "circle")
                        }
                        .disabled(selection.wrappedValue.count >= 50 && !selection.wrappedValue.contains(candidate.recordId))
                    }
                } label: { Label("选择任务",systemImage:"plus") }
                .disabled(available.isEmpty)
            }
            if !selection.wrappedValue.isEmpty {
                ScrollView {
                    VStack(alignment:.leading,spacing:7) {
                        ForEach(selection.wrappedValue,id:\.self) { id in
                            let dependency=details.first(where:{$0.requirementId == id})
                            let candidate=requirements.first(where:{$0.recordId == id})
                            HStack {
                                Text("\(dependency?.title ?? candidate?.title ?? id) · \(id)").font(.system(size:11))
                                Spacer()
                                if dependency?.missing == true { Text("未找到").font(.system(size:10)).foregroundStyle(.orange) }
                                else if blockingIds.contains(id) { Text("阻塞中").font(.system(size:10)).foregroundStyle(.orange) }
                                else if let status=dependency?.status ?? candidate?.taskStatus { Text(Self.taskStatusLabel(status) ?? status).font(.system(size:10)).foregroundStyle(.secondary) }
                                Button { selection.wrappedValue.removeAll{$0 == id} } label: { Image(systemName:"xmark.circle") }
                                    .buttonStyle(.plain).help("移除依赖")
                            }
                        }
                    }
                }
                .frame(maxHeight:112)
            }
            HStack(spacing:8) {
                TextField("其他任务 ID",text:idDraft).font(.system(size:11,design:.monospaced))
                    .accessibilityIdentifier("zen.requirement.dependencies.id")
                Button("添加") { addDependency(idDraft.wrappedValue,selection:selection,excluding:requirementId); idDraft.wrappedValue="" }
                    .disabled(!canAddDependency(idDraft.wrappedValue,selection:selection.wrappedValue,excluding:requirementId))
            }
        }
    }

    private func toggleDependency(_ id:String,selection:Binding<[String]>) {
        var ids=selection.wrappedValue
        if ids.contains(id) { ids.removeAll{$0 == id} } else if ids.count < 50 { ids.append(id) }
        selection.wrappedValue=ids
    }

    private func addDependency(_ id:String,selection:Binding<[String]>,excluding:String?) {
        let clean=id.trimmingCharacters(in:.whitespacesAndNewlines)
        guard canAddDependency(clean,selection:selection.wrappedValue,excluding:excluding) else { return }
        selection.wrappedValue.append(clean)
    }

    private func canAddDependency(_ id:String,selection:[String],excluding:String?) -> Bool {
        let clean=id.trimmingCharacters(in:.whitespacesAndNewlines)
        return !clean.isEmpty && clean.utf16.count <= 160 && (excluding == nil || clean != excluding)
            && !selection.contains(clean) && selection.count < 50
    }

    private var createRequirementSheet: some View {
        VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.section) {
            Text("新建任务").font(ForgeClientDesign.Typography.sheetTitle)
            ScrollView {
                ForgeClientFormSection(title: "任务内容") {
                ForgeClientFormField(label: "名称") {
                    TextField("任务名称",text:$newTitle)
                        .accessibilityIdentifier("zen.requirement.create.title")
                }
                ForgeClientFormField(label: "预期结果") {
                    TextField("预期结果",text:$newOutcome,axis:.vertical).lineLimit(3...5)
                        .accessibilityIdentifier("zen.requirement.create.outcome")
                }
                ForgeClientFormField(label: "验收标准") {
                    TextField("每行一项",text:$newCriteria,axis:.vertical).lineLimit(3...6)
                        .accessibilityIdentifier("zen.requirement.create.acceptance-criteria")
                }
                HStack(alignment:.top,spacing:ForgeClientDesign.Spacing.row) {
                    ForgeClientFormField(label:"状态") {
                        Picker("",selection:$newTaskStatus) {
                            Text("待开始").tag("planned")
                            Text("进行中").tag("active")
                            Text("待你处理").tag("waiting_for_user")
                        }
                        .labelsHidden()
                        .accessibilityLabel("状态")
                        .accessibilityIdentifier("zen.requirement.create.status")
                    }
                    ForgeClientFormField(label:"优先级") {
                        Picker("",selection:$newPriority) {
                            Text("低").tag("low")
                            Text("普通").tag("normal")
                            Text("高").tag("high")
                            Text("紧急").tag("urgent")
                        }
                        .labelsHidden()
                        .accessibilityLabel("优先级")
                        .accessibilityIdentifier("zen.requirement.create.priority")
                    }
                }
                ForgeClientFormField(label: "负责人") {
                    TextField("可选",text:$newAssignee)
                        .accessibilityIdentifier("zen.requirement.create.assignee")
                }
                dependencyEditor(selection:$newDependencyRequirementIds,excluding:nil,idDraft:$newDependencyIdDraft)
            }
            }
            .frame(maxHeight:ForgeClientDesign.Size.taskFormContentMaxHeight)
            .disabled(pendingCreatedRequirementId != nil)
            if pendingCreatedRequirementId != nil {
                Text("任务已创建，等待详情确认。")
                    .font(.system(size:12)).foregroundStyle(.secondary)
                    .accessibilityIdentifier("zen.requirement.create.pending-readback")
            }
            if let problem=model.error {
                Text(problem)
                    .font(.system(size:11))
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("zen.requirement.create.error")
            }
            HStack {
                Spacer()
                Button("取消") { showingRequirementSheet=false }
                    .disabled(saving)
                Button(saving ? "处理中…" : pendingCreatedRequirementId == nil ? "创建" : "刷新列表") {
                    if let pendingId=pendingCreatedRequirementId {
                        refreshCreatedRequirement(pendingId)
                    } else {
                        createRequirement()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || newTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                          || newOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                          || newAssignee.utf16.count > 160)
            }
        }
        .padding(ForgeClientDesign.Spacing.sheetPadding)
        .frame(width:ForgeClientDesign.Size.taskCreateSheet)
        .accessibilityIdentifier("zen.requirement.create")
    }

    private func createRequirement() {
        guard let context=currentSemanticCreationContext else {
            model.error="请先选择项目。"
            return
        }
        model.error=nil
        saving=true
        Task {
            let id=await model.createRequirement(
                title:newTitle,outcome:newOutcome,
                acceptanceCriteria:newCriteria.components(separatedBy:.newlines),
                taskStatus:newTaskStatus,priority:newPriority,
                assignee:newAssignee,dependencyRequirementIds:newDependencyRequirementIds
            )
            saving=false
            guard let id,model.selectedProjectId == context.projectId,
                  model.projectRepositoryId == context.repoId,model.page == .requirement else { return }
            if let record=Self.createdRequirementRecord(id,in:model.records) {
                guard model.selectedRecord == id else { return }
                guard detailLoaded(for:record) else {
                    pendingRequirementReadbacks[context]=id
                    model.error="任务已创建，但详情尚未读回。请刷新列表核对，不要重复创建。"
                    return
                }
                focusedRequirementId=id
                screen = .canvas
                showingRequirementSheet=false
            } else {
                guard model.selectedRecord == nil else { return }
                pendingRequirementReadbacks[context]=id
            }
        }
    }

    private func refreshCreatedRequirement(_ id:String) {
        guard let context=currentSemanticCreationContext,
              pendingRequirementReadbacks[context] == id,
              model.page == .requirement,
              model.selectedRecord == nil || model.selectedRecord == id else { return }
        let targetCheckoutId=model.checkoutId
        let targetContextGeneration=model.projectContextGeneration
        let targetPageRequestGeneration=model.planningPageRequestGeneration
        let expectedPageRequestGeneration=targetPageRequestGeneration + 1
        model.error=nil
        saving=true
        Task {
            await model.loadPage()
            guard model.selectedProjectId == context.projectId,
                  model.projectRepositoryId == context.repoId,
                  model.checkoutId == targetCheckoutId,
                  NativeWorkspace.semanticRecordCreationNavigationIsCurrent(
                    targetPage:.requirement,currentPage:model.page,
                    targetRecordId:nil,currentRecordId:model.selectedRecord,
                    targetContextGeneration:targetContextGeneration,
                    currentContextGeneration:model.projectContextGeneration,
                    targetPlanningPageRequestGeneration:expectedPageRequestGeneration,
                    currentPlanningPageRequestGeneration:model.planningPageRequestGeneration
                  ) else {
                saving=false
                return
            }
            guard let record=Self.createdRequirementRecord(id,in:model.records) else {
                model.error="任务已创建并确认，但项目任务列表仍未读回该记录。请稍后刷新，不要重复创建。"
                saving=false
                return
            }
            await model.openRecord(record.id)
            guard model.selectedProjectId == context.projectId,
                  model.projectRepositoryId == context.repoId,
                  model.checkoutId == targetCheckoutId,
                  NativeWorkspace.semanticRecordCreationNavigationIsCurrent(
                    targetPage:.requirement,currentPage:model.page,
                    targetRecordId:record.id,currentRecordId:model.selectedRecord,
                    targetContextGeneration:targetContextGeneration,
                    currentContextGeneration:model.projectContextGeneration,
                    targetPlanningPageRequestGeneration:expectedPageRequestGeneration,
                    currentPlanningPageRequestGeneration:model.planningPageRequestGeneration
                  ) else {
                saving=false
                return
            }
            guard detailLoaded(for:record) else {
                model.error="任务已创建并确认，但详情仍未读回。请稍后刷新核对，不要重复创建。"
                saving=false
                return
            }
            pendingRequirementReadbacks.removeValue(forKey:context)
            focusedRequirementId=id
            screen = .canvas
            showingRequirementSheet=false
            saving=false
        }
    }

    private var createPlanSheet: some View {
        VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.section) {
            Text(newParentPlanId == nil ? "新增 Plan" : "新增子 Plan")
                .font(ForgeClientDesign.Typography.sheetTitle)
            ForgeClientFormField(label: "计划目标") {
                TextField("填写计划目标",text:$newPlanGoal,axis:.vertical).lineLimit(3...5)
                    .accessibilityLabel("计划目标")
                    .accessibilityIdentifier("zen.plan.create.goal")
                    .disabled(pendingCreatedPlanId != nil)
            }
            if pendingCreatedPlanId != nil {
                Text("Plan 已创建，等待详情确认。")
                    .font(.system(size:12)).foregroundStyle(.secondary)
                    .accessibilityIdentifier("zen.plan.create.pending-readback")
            }
            if let problem=model.error {
                Text(problem).font(.system(size:11)).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("zen.plan.create.error")
            }
            HStack {
                Spacer()
                Button("取消") { showingPlanSheet=false }
                    .accessibilityIdentifier("zen.plan.create.cancel")
                    .disabled(saving)
                Button(saving ? "处理中…" : pendingCreatedPlanId == nil ? "创建" : "刷新列表") {
                    if let pendingId=pendingCreatedPlanId {
                        refreshCreatedPlan(pendingId)
                    } else {
                        createPlan()
                    }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("zen.plan.create.submit")
                .disabled(saving || (pendingCreatedPlanId == nil
                    && newPlanGoal.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }
        .padding(ForgeClientDesign.Spacing.sheetPadding).frame(width:400)
        .accessibilityIdentifier("zen.plan.create")
    }

    private func createPlan() {
        guard let context=currentSemanticCreationContext else {
            model.error="请先选择项目。"
            return
        }
        model.error=nil
        saving=true
        Task {
            let id=await model.createPlan(objective:newPlanGoal,
                                          requirementId:focusedRequirementId,
                                          parentPlanId:newParentPlanId)
            saving=false
            guard let id,model.selectedProjectId == context.projectId,
                  model.projectRepositoryId == context.repoId,model.page == .requirement else { return }
            if let record=Self.createdPlanRecord(id,in:model.records) {
                guard model.selectedRecord == id else { return }
                guard detailLoaded(for:record) else {
                    pendingPlanReadbacks[context]=id
                    model.error="Plan 已创建，但详情尚未读回。请刷新列表核对，不要重复创建。"
                    return
                }
                showingPlanSheet=false
                newPlanGoal=""
                newParentPlanId=nil
            } else {
                guard model.selectedRecord == nil else { return }
                pendingPlanReadbacks[context]=id
            }
        }
    }

    private func refreshCreatedPlan(_ id:String) {
        guard let context=currentSemanticCreationContext,
              pendingPlanReadbacks[context] == id,
              model.page == .requirement,
              model.selectedRecord == nil || model.selectedRecord == id else { return }
        let targetCheckoutId=model.checkoutId
        let targetContextGeneration=model.projectContextGeneration
        let targetPageRequestGeneration=model.planningPageRequestGeneration
        let expectedPageRequestGeneration=targetPageRequestGeneration + 1
        model.error=nil
        saving=true
        Task {
            await model.loadPage()
            guard model.selectedProjectId == context.projectId,
                  model.projectRepositoryId == context.repoId,
                  model.checkoutId == targetCheckoutId,
                  NativeWorkspace.semanticRecordCreationNavigationIsCurrent(
                    targetPage:.requirement,currentPage:model.page,
                    targetRecordId:nil,currentRecordId:model.selectedRecord,
                    targetContextGeneration:targetContextGeneration,
                    currentContextGeneration:model.projectContextGeneration,
                    targetPlanningPageRequestGeneration:expectedPageRequestGeneration,
                    currentPlanningPageRequestGeneration:model.planningPageRequestGeneration
                  ) else {
                saving=false
                return
            }
            guard let record=Self.createdPlanRecord(id,in:model.records) else {
                model.error="Plan 已创建并确认，但项目计划列表仍未读回该记录。请稍后刷新，不要重复创建。"
                saving=false
                return
            }
            await model.openRecord(record.id)
            guard model.selectedProjectId == context.projectId,
                  model.projectRepositoryId == context.repoId,
                  model.checkoutId == targetCheckoutId,
                  NativeWorkspace.semanticRecordCreationNavigationIsCurrent(
                    targetPage:.requirement,currentPage:model.page,
                    targetRecordId:record.id,currentRecordId:model.selectedRecord,
                    targetContextGeneration:targetContextGeneration,
                    currentContextGeneration:model.projectContextGeneration,
                    targetPlanningPageRequestGeneration:expectedPageRequestGeneration,
                    currentPlanningPageRequestGeneration:model.planningPageRequestGeneration
                  ) else {
                saving=false
                return
            }
            guard detailLoaded(for:record) else {
                model.error="Plan 已创建并确认，但详情仍未读回。请稍后刷新核对，不要重复创建。"
                saving=false
                return
            }
            pendingPlanReadbacks.removeValue(forKey:context)
            showingPlanSheet=false
            newPlanGoal=""
            newParentPlanId=nil
            saving=false
        }
    }
}

// Geometry is calculated once for both node positions and connectors.
// Leaf slots preserve each branch as a contiguous subtree rather than
// distributing unrelated plans evenly across every depth.
struct ZenTreeGeometry {
    static let columnStep: CGFloat = 250
    static let rowStep: CGFloat = 166
    static let nodeHeight: CGFloat = 104

    let width: CGFloat
    let height: CGFloat
    let parentById: [String:String]
    private let xById: [String:CGFloat]

    init(rows: [[ForgeRecord]], viewport: CGSize) {
        let knownIds = Set(rows.flatMap { $0 }.map(\.recordId))
        var parentById: [String:String] = [:]
        var childIds: [String:[String]] = [:]
        if rows.count > 1 {
            for row in 1..<rows.count {
                for child in rows[row] {
                    guard let parent = rows[row-1].first(where: {
                        child.parentPlanId == $0.recordId ||
                        ($0.kind == .requirement &&
                         !knownIds.contains(child.parentPlanId ?? ""))
                    }) else { continue }
                    parentById[child.id] = parent.id
                    childIds[parent.id,default:[]].append(child.id)
                }
            }
        }

        var leafIndex = 0
        var naturalX: [String:CGFloat] = [:]
        func position(_ id: String) -> CGFloat {
            let children = childIds[id] ?? []
            let x: CGFloat
            if let first = children.first {
                let firstX = position(first)
                var lastX = firstX
                for child in children.dropFirst() { lastX = position(child) }
                x = (firstX + lastX) / 2
            } else {
                x = CGFloat(leafIndex) * Self.columnStep + 160
                leafIndex += 1
            }
            naturalX[id] = x
            return x
        }
        if let root = rows.first?.first { _ = position(root.id) }
        for node in rows.flatMap({ $0 }) where naturalX[node.id] == nil {
            _ = position(node.id)
        }

        let naturalWidth = CGFloat(max(leafIndex,1)) * Self.columnStep + 70
        width = max(viewport.width,naturalWidth)
        height = max(viewport.height,CGFloat(rows.count) * Self.rowStep + 60)
        self.parentById = parentById
        let offset = (width-naturalWidth)/2
        xById = naturalX.mapValues { $0 + offset }
    }

    func point(for node: ForgeRecord,row: Int) -> CGPoint {
        CGPoint(x:xById[node.id] ?? width/2,
                y:CGFloat(row)*Self.rowStep+92)
    }
}

private struct ZenTreeCanvas: View {
    let root: ForgeRecord
    let records: [ForgeRecord]
    let selectedId: String?
    let executionStatuses: [String:AutopilotStatusDetail]
    let hasRepository:Bool
    let executionBusy: Bool
    let unresolvedOutcomeRequirementIds: Set<String>
    let onSelect: (ForgeRecord) -> Void
    let onAction: (ForgeRecord,ZenNodeAction) -> Void
    @State private var hoveredNodeId: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var zoom:CGFloat = 1

    private func setZoom(_ value:CGFloat) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration:0.16)) {
            zoom = min(1.65,max(0.35,value))
        }
    }


    @ViewBuilder
    private func nodeToolbar(_ item:ForgeRecord) -> some View {
        let canChange=ZenWorkspacePane.requirementAllowsActions(root.state)
            && (item.kind == .requirement || item.requirementId == root.recordId)
        HStack(spacing:1) {
            if canChange {
                Button {
                    onAction(item,.addPlan)
                } label: {
                    Image(systemName:"plus").frame(width:26,height:26)
                }
                .help(item.kind == .requirement ? "新增 Plan" : "新增子 Plan")
                .accessibilityLabel(item.kind == .requirement ? "新增 Plan" : "新增子 Plan")
                .accessibilityIdentifier("zen.node.add-plan.\(item.recordId)")
                Button {
                    onAction(item,.edit)
                } label: {
                    Image(systemName:"pencil").frame(width:26,height:26)
                }
                .help("编辑节点")
                .accessibilityLabel("编辑节点")
                .accessibilityIdentifier("zen.node.edit.\(item.recordId)")
            }
            Menu {
                if canChange {
                    Button("使用 Agent 优化",systemImage:"sparkles") {
                        onAction(item,.optimize)
                    }
                }
                Button("Review",systemImage:"checkmark.seal") {
                    onAction(item,.review)
                }
                if canChange && item.kind == .requirement {
                    Divider()
                    if let status=executionStatuses[item.recordId],
                       let operation=ZenWorkspacePane.executionOperation(
                         status:status,outcomeUnknown:unresolvedOutcomeRequirementIds.contains(item.recordId)
                       ) {
                        Button(
                            ZenWorkspacePane.executionLabel(
                                operation:operation,runStatus:status.runStatus,
                                needsBudgetRenewal:status.needsBudgetRenewal,
                                 hasPendingProcessRecovery:status.hasPendingProcessRecovery
                            ),
                            systemImage:operation == "authorize" ? "lock.open" :
                                operation == "accept_checkpoint" ? "checkmark.seal" :
                                (operation == "pause" ? "pause" : "play")
                        ) {
                            onAction(item,operation == "authorize" ? .executionSettings : .toggleExecution)
                        }
                        .disabled(executionBusy)
                    }
                    if hasRepository && !unresolvedOutcomeRequirementIds.contains(item.kind == .requirement ? item.recordId : (item.requirementId ?? "")) {
                        Button("执行设置",systemImage:"slider.horizontal.3") {
                            onAction(item,.executionSettings)
                        }
                    }
                    if hasRepository { Divider() }
                    Button("验收完成",systemImage:"checkmark.circle") {
                        onAction(item,.complete)
                    }
                    Button("取消 Requirement",systemImage:"xmark.circle",role:.destructive) {
                        onAction(item,.cancel)
                    }
                }
            } label: {
                Image(systemName:"ellipsis").frame(width:27,height:26)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .simultaneousGesture(TapGesture().onEnded {
                onSelect(item)
            })
            .help("更多节点操作")
            .accessibilityLabel("更多节点操作")
            .accessibilityIdentifier("zen.node.menu.\(item.recordId)")
        }
        .font(.system(size:11,weight:.medium))
        .buttonStyle(.plain)
        .foregroundStyle(Color.primary)
        // The card reserves this header area for actions; no second raised surface.
    }

    private var levels: [[ForgeRecord]] {
        var result:[[ForgeRecord]]=[[root]]
        var visited:Set<String>=[root.id]
        let plans=records.filter{$0.kind == .plan && $0.requirementId == root.recordId}
        let ids=Set(plans.map(\.recordId))
        while let parents=result.last,!parents.isEmpty,result.count <= plans.count {
            var next:[ForgeRecord]=[]
            for parent in parents {
                let children=plans.filter { record in
                    if parent.kind == .requirement {
                        guard let parentId=record.parentPlanId else { return true }
                        return !ids.contains(parentId)
                    }
                    return record.parentPlanId == parent.recordId
                }
                for child in children where visited.insert(child.id).inserted {
                    next.append(child)
                }
            }
            if next.isEmpty { break }
            result.append(next)
        }
        return result
    }

    var body: some View {
        GeometryReader { viewport in
            let rows=levels
            let layout=ZenTreeGeometry(rows:rows,viewport:viewport.size)
            let width=layout.width
            let height=layout.height
            ScrollView([.horizontal,.vertical]) {
                ZStack(alignment:.topLeading) {
                    Canvas { context,_ in
                        for row in 1..<rows.count {
                            for child in rows[row] {
                                guard let parentId=layout.parentById[child.id],
                                      let parent=rows[row-1].first(where:{$0.id == parentId})
                                else { continue }
                                let start=layout.point(for:parent,row:row-1)
                                let end=layout.point(for:child,row:row)
                                var path=Path()
                                path.move(to:CGPoint(x:start.x,y:start.y+ZenTreeGeometry.nodeHeight/2))
                                path.addCurve(to:CGPoint(x:end.x,y:end.y-ZenTreeGeometry.nodeHeight/2),
                                              control1:CGPoint(x:start.x,y:(start.y+end.y)/2),
                                              control2:CGPoint(x:end.x,y:(start.y+end.y)/2))
                                context.stroke(path,with:.color(.secondary.opacity(0.28)),
                                               style:StrokeStyle(lineWidth:1.2,lineCap:.round))
                            }
                        }
                    }
                    .frame(width:width,height:height)

                    ForEach(0..<rows.count,id:\.self) { row in
                        ForEach(rows[row]) { item in
                            ZStack(alignment:.topTrailing) {
                                Button { onSelect(item) } label: {
                                    VStack(alignment:.leading,spacing:0) {
                                        HStack(spacing:6) {
                                            Image(systemName:item.kind == .requirement ? "scope" : "list.bullet.rectangle")
                                                .font(.system(size:11,weight:.medium))
                                            Text(item.kind == .requirement ? "Requirement" : "Plan")
                                                .font(.system(size:10,weight:.medium))
                                            Spacer(minLength:0)
                                        }
                                        .foregroundStyle(.secondary)
                                        .frame(height:28,alignment:.topLeading)
                                        .padding(.trailing,92)
                                        .padding(.bottom,4)
                                        Text(item.title)
                                            .font(.system(size:13,weight:.semibold))
                                            .foregroundStyle(.primary)
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                            .frame(maxWidth:.infinity,alignment:.leading)
                                        Spacer(minLength:0)
                                        if let status=ZenWorkspacePane.nodeStatus(
                                            for:item,root:root,executionStatuses:executionStatuses,
                                             unresolvedOutcomeRequirementIds:unresolvedOutcomeRequirementIds
                                        ) {
                                            HStack(spacing:5) {
                                                Image(systemName:status.symbol)
                                                    .font(.system(size:9,weight:.semibold))
                                                    .foregroundStyle(status.color)
                                                Text(status.label)
                                                    .font(.system(size:9.5,weight:.medium))
                                                    .foregroundStyle(.secondary)
                                                    .lineLimit(1)
                                            }
                                            .padding(.top,3)
                                        }
                                    }
                                    .frame(width:194,height:80,alignment:.topLeading)
                                    .padding(.horizontal,13)
                                    .padding(.vertical,12)
                                    .background(Color(nsColor:.controlBackgroundColor),
                                                in:RoundedRectangle(cornerRadius:12,style:.continuous))
                                    .overlay {
                                        RoundedRectangle(cornerRadius:12,style:.continuous)
                                            .strokeBorder(item.id == selectedId
                                                          ? Color.accentColor.opacity(0.85) : .clear,
                                                          lineWidth:1.5)
                                    }
                                    .contentShape(RoundedRectangle(cornerRadius:12,style:.continuous))
                                }
                                .buttonStyle(ZenPressStyle())
                                .accessibilityIdentifier("zen.canvas.node.\(item.recordId)")
                                if hoveredNodeId == item.id || selectedId == item.id {
                                    nodeToolbar(item)
                                        .padding(5)
                                        .transition(reduceMotion ? .identity : .opacity)
                                }
                            }
                            .onHover { isHovering in
                                withAnimation(reduceMotion ? nil : .easeOut(duration:0.12)) {
                                    if isHovering {
                                        hoveredNodeId=item.id
                                    } else if hoveredNodeId == item.id {
                                        hoveredNodeId=nil
                                    }
                                }
                            }
                            .position(layout.point(for:item,row:row))
                        }
                    }
                }
                .frame(width:width,height:height)
                .scaleEffect(zoom,anchor:.topLeading)
                .frame(width:width*zoom,height:height*zoom,alignment:.topLeading)
            }
            .scrollIndicators(.visible)
            .overlay(alignment:.topTrailing) {
                HStack(spacing:4) {
                    Button {
                        setZoom(zoom-0.15)
                    } label: {
                        Image(systemName:"minus.magnifyingglass").frame(width:30,height:30)
                    }
                    .disabled(zoom <= 0.35)
                    .help("缩小画布")
                    .accessibilityLabel("缩小画布")
                    Text("\(Int((zoom*100).rounded()))%")
                        .font(.system(size:10,weight:.medium,design:.monospaced))
                        .frame(width:43)
                        .accessibilityLabel("画布缩放 \(Int((zoom*100).rounded()))%")
                    Button {
                        setZoom(zoom+0.15)
                    } label: {
                        Image(systemName:"plus.magnifyingglass").frame(width:30,height:30)
                    }
                    .disabled(zoom >= 1.65)
                    .help("放大画布")
                    .accessibilityLabel("放大画布")
                    Button {
                        setZoom(min(1,viewport.size.width/width,viewport.size.height/height))
                    } label: {
                        Image(systemName:"arrow.up.left.and.arrow.down.right")
                            .frame(width:30,height:30)
                    }
                    .help("适配全图")
                    .accessibilityLabel("适配全图")
                }
                .buttonStyle(.plain)
                .padding(.horizontal,7).padding(.vertical,5)
                .background(.regularMaterial,in:RoundedRectangle(cornerRadius:10))
                .padding(15)
            }
        }
        .onChange(of:root.id) { _ in
            zoom=1
            hoveredNodeId=nil
        }
        .background(Color(nsColor:.textBackgroundColor))
        .accessibilityIdentifier("zen.requirement.canvas")
    }
}


private struct ZenPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.76 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.986 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration:0.12),
                       value:configuration.isPressed)
    }
}

private struct ZenEmptyState: View {
    let title: String
    let subtitle: String
    let symbol: String

    var body: some View {
        VStack(spacing:10) {
            Image(systemName:symbol)
                .font(.system(size:25,weight:.light))
                .foregroundStyle(.tertiary)
            Text(title).font(.system(size:14,weight:.semibold))
            Text(subtitle).font(.system(size:11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
    }
}

private enum ZenReviewRole: String, CaseIterable, Identifiable {
    case product = "产品"
    case staff = "Staff Engineer"
    case quality = "质量与验收"
    var id: String { rawValue }
    var focus: String {
        switch self {
        case .product: return "用户价值、范围、验收标准和需求重复"
        case .staff: return "架构边界、实现可行性、耦合和技术风险"
        case .quality: return "验收标准、测试证据、失败风险及未验证项"
        }
    }
}

private struct ZenReviewSheet: View {
    @ObservedObject var model: NativeWorkspace
    let record: ForgeRecord
    let onStart: (String, String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var role: ZenReviewRole = .staff
    @State private var provider = ""
    @State private var secondProvider = ""
    @State private var reviewProviders: [String] = []
    @State private var reviewRole = ""
    @State private var reviewFocus = ""
    @AppStorage("forge.zen.review.secondProvider") private var preferredSecondProvider = ""
    @AppStorage("forge.zen.review.role") private var preferredRole = ZenReviewRole.staff.rawValue
    @AppStorage("forge.zen.review.provider") private var preferredProvider = ""

    private var effectiveReviewProvider: String? {
        NativeWorkspace.resolveReadOnlyAnalysisProvider(
            preferred:provider.isEmpty ? nil : provider,
            fallback:model.readOnlyAnalysisProvider
        )
    }

    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text("Review").font(ForgeClientDesign.Typography.sheetTitle)
                Spacer()
                Button { dismiss() } label: { Image(systemName:"xmark") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("取消 Review")
            }
            Text(record.title).font(ForgeClientDesign.Typography.body).lineLimit(2)
            if !reviewProviders.isEmpty {
                ScrollView {
                    ZenReadOnlyReviewPane(
                        model:model,record:record,role:reviewRole,focus:reviewFocus,
                        providers:reviewProviders
                    )
                }
            } else {
            Picker("审查角色",selection:$role) {
                ForEach(ZenReviewRole.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.menu)
            Text(role.focus).font(.system(size:11)).foregroundStyle(.secondary)
            Picker("只读 Provider / Model",selection:$provider) {
                Text("默认只读 Provider").tag("")
                if model.localApiSettings?.joyCodeReady == true {
                    Text("JoyCode · \(model.localApiSettings?.joyCodeModel ?? "JoyCode")").tag("joycode")
                }
                ForEach(model.localApiSettings?.profiles.filter(\.endpointReady) ?? []) { profile in
                    Text("\(profile.label) · \(profile.model)").tag(profile.providerId)
                }
            }
            .pickerStyle(.menu)
            Picker("第二模型（可选）",selection:$secondProvider) {
                Text("不启用").tag("")
                if model.localApiSettings?.joyCodeReady == true,effectiveReviewProvider != "joycode" {
                    Text("JoyCode").tag("joycode")
                }
                ForEach(model.localApiSettings?.profiles.filter({
                    $0.endpointReady && $0.providerId != effectiveReviewProvider
                }) ?? []) { profile in
                    Text("\(profile.label) · \(profile.model)").tag(profile.providerId)
                }
            }
            .pickerStyle(.menu)
            Text("Agent Review 使用已配置的 API Provider / JoyCode，并以只读会话运行；需要执行修改时，请在普通 Agent 中单独发起。Zen 不自动应用审查建议。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            HStack {
                if let effectiveReviewProvider {
                    Button("在 Zen 中只读审查") {
                        reviewRole=role.rawValue
                        reviewFocus=role.focus
                        reviewProviders=[effectiveReviewProvider] + (secondProvider.isEmpty || secondProvider == effectiveReviewProvider ? [] : [secondProvider])
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.repoId == nil || model.checkoutId == nil)
                }
                Spacer()
                Button("取消") { dismiss() }
                Button("在只读 Agent 中审查") {
                    let instruction = "请扮演\(role.rawValue)，对当前 \(record.kind == .requirement ? "Requirement" : "Plan") 做 Review。重点检查：\(role.focus)。仅返回问题、证据与建议；请核对 Agent 当前 Repo Access 权限，不要自动写入或执行。"
                    dismiss()
                    onStart(instruction,provider.isEmpty ? nil : provider)
                }
                .buttonStyle(.bordered)
            }
            }
        }
        .padding(ForgeClientDesign.Spacing.sheetPadding)
        .frame(width:reviewProviders.isEmpty ? 450 : 650,
               height:reviewProviders.isEmpty ? nil : 580)
        .accessibilityIdentifier("zen.review.configure")
        .onAppear {
            role = ZenReviewRole(rawValue:preferredRole) ?? .staff
            let available = model.localApiSettings?.profiles.filter(\.endpointReady).map(\.providerId) ?? []
            provider = preferredProvider == "joycode" && model.localApiSettings?.joyCodeReady == true
                || available.contains(preferredProvider) ? preferredProvider : ""
            if preferredProvider != provider { preferredProvider = provider }
            secondProvider = preferredSecondProvider == "joycode" && model.localApiSettings?.joyCodeReady == true
                || available.contains(preferredSecondProvider) ? preferredSecondProvider : ""
        }
        .onChange(of:secondProvider) { preferredSecondProvider = $0 }
        .onChange(of:role) { preferredRole = $0.rawValue }
        .onChange(of:provider) { preferredProvider = $0 }
    }
}

struct ZenProjectDirectorySheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: NativeWorkspace
    let onOpenTasks: (String,String?) -> Void
    let onOpenRequirement: (String,String?,String) -> Void
    @State private var query = ""
    @State private var editingProjectId: String?
    @State private var creating = false
    @State private var draftName = ""
    @State private var newProjectRepositoryId: String?
    @State private var detailProjectId: String?
    @State private var saving = false

    private var availableRepositories: [ForgeProject] {
        NativeWorkspace.availableProjectPlacementRepositories(
            repositories:model.projects,semanticProjects:model.semanticProjects
        )
    }

    private var visibleProjects: [ForgeSemanticProject] {
        let term = query.trimmingCharacters(in:.whitespacesAndNewlines)
        return model.semanticProjects
            .filter { term.isEmpty || $0.displayName.localizedStandardContains(term)
                || $0.projectId.localizedStandardContains(term) }
            .sorted {
                if ($0.status == "archived") != ($1.status == "archived") {
                    return $0.status != "archived"
                }
                return $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
            }
    }

    private var editingProject: ForgeSemanticProject? {
        model.semanticProjects.first { $0.projectId == editingProjectId }
    }

    var body: some View {
        Group {
            if let detailProjectId {
                ZenProjectDetailPane(
                    model:model,projectId:detailProjectId,
                    onOpenTasks:onOpenTasks,onOpenRequirement:onOpenRequirement
                ) {
                    self.detailProjectId=nil
                }
                .id(detailProjectId)
            } else {
                projectDirectory
            }
        }
        .frame(minWidth:540,minHeight:470)
        .task { await model.refreshSemanticProjects() }
        .accessibilityIdentifier("zen.projects.directory")
    }

    private var projectDirectory: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                Text("项目").font(.system(size:19,weight:.semibold))
                Spacer()
                Button("完成") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }

            HStack(spacing:12) {
                TextField("搜索项目",text:$query)
                    .accessibilityLabel("搜索项目")
                    .accessibilityIdentifier("zen.projects.search")
                Button {
                    editingProjectId = nil
                    creating = true
                    draftName = ""
                    newProjectRepositoryId = nil
                    model.error = nil
                } label: {
                    Label("新建项目",systemImage:"plus")
                }
                .disabled(saving || model.busy)
                .accessibilityIdentifier("zen.projects.create")
            }

            if creating || editingProjectId != nil {
                VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.row) {
                    Text(creating ? "新建项目" : "重命名项目")
                        .font(ForgeClientDesign.Typography.sectionTitle)
                    ForgeClientFormField(label: "项目名称") {
                        TextField("项目名称",text:$draftName)
                            .accessibilityLabel("项目名称")
                            .accessibilityIdentifier("zen.projects.name")
                            .onSubmit { save() }
                    }
                    if creating {
                        Picker("关联仓库",selection:$newProjectRepositoryId) {
                            Text("仅项目").tag(Optional<String>.none)
                            ForEach(availableRepositories) { repository in
                                Text(repository.label).tag(Optional(repository.repoId))
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(model.projectsLoading || model.semanticProjectsLoading
                                  || model.projectsError != nil || model.semanticProjectsError != nil)
                        .accessibilityIdentifier("zen.projects.repository")
                        if model.projectsLoading || model.semanticProjectsLoading {
                            ProgressView("正在读取可关联仓库…").controlSize(.small)
                        } else if let repositoryError=model.projectsError {
                            Text("仓库列表暂不可用：\(repositoryError)")
                                .font(.system(size:11)).foregroundStyle(.secondary)
                        }
                    }
                    HStack {
                        Spacer()
                        Button("取消") {
                            creating = false
                            editingProjectId = nil
                            newProjectRepositoryId = nil
                        }
                        Button(saving ? "保存中…" : "保存") { save() }
                            .buttonStyle(.borderedProminent)
                            .disabled(saving || draftName.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                      || (creating && newProjectRepositoryId != nil
                                          && (model.projectsLoading || model.semanticProjectsLoading
                                              || model.projectsError != nil || model.semanticProjectsError != nil)))
                            .accessibilityIdentifier("zen.projects.save")
                    }
                }
                .padding(.vertical,8)
            }

            if model.semanticProjectsLoading {
                ProgressView().controlSize(.small)
            }
            if let problem = model.error {
                Text(problem).font(.system(size:12)).foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
            if let problem = model.semanticProjectsError {
                Text("项目列表刷新失败：\(problem)")
                    .font(.system(size:12)).foregroundStyle(.orange)
                    .textSelection(.enabled)
            }

            List {
                ForEach(visibleProjects) { project in
                    let isSelected=model.selectedProjectId == project.projectId
                    let selectedPlacement=isSelected
                        ? model.projectRepositoryId.flatMap { repositoryId in
                            model.projects.first(where:{$0.repoId == repositoryId})?.label
                        }
                        : nil
                    HStack(spacing:10) {
                        Image(systemName:project.status == "archived" ? "archivebox" :
                              isSelected ? "checkmark.circle.fill" : "folder")
                            .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                            .frame(width:19)
                            .accessibilityHidden(true)
                        VStack(alignment:.leading,spacing:3) {
                            Button(project.displayName) {
                                Task { await model.selectSemanticProject(project.projectId) }
                                dismiss()
                            }
                            .buttonStyle(.plain)
                            .font(.system(size:13,weight:.medium))
                            .disabled(model.busy || saving || project.status == "archived")
                            .accessibilityIdentifier("zen.projects.open.\(project.projectId)")
                            .accessibilityLabel(isSelected ? "\(project.displayName)，当前项目" : project.displayName)
                            .accessibilityValue(isSelected ? selectedPlacement ?? "项目级" : "")
                            HStack(spacing:8) {
                                if isSelected {
                                    Text("当前 · \(selectedPlacement ?? "项目级")")
                                        .foregroundStyle(Color.accentColor)
                                }
                                if project.status == "archived" {
                                    Text("已归档")
                                }
                                if let count = project.requirementCount {
                                    Text("\(count) 个任务")
                                }
                                Text(project.repositoryIds.isEmpty ? "无关联仓库" :
                                     "\(project.repositoryIds.count) 个仓库")
                            }
                            .font(.system(size:11)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength:0)
                        Menu {
                            Button {
                                detailProjectId=project.projectId
                            } label: { Label("查看详情",systemImage:"info.circle") }
                            Divider()
                            Button {
                                editingProjectId = project.projectId
                                creating = false
                                draftName = project.displayName
                                model.error = nil
                            } label: { Label("重命名",systemImage:"pencil") }
                            if !project.repositoryIds.isEmpty {
                                Menu {
                                    Button {
                                        Task { await model.selectSemanticProject(project.projectId,projectScope:true) }
                                        dismiss()
                                    } label: {
                                        Label("项目级",systemImage:isSelected && model.projectRepositoryId == nil
                                              ? "checkmark.circle.fill" : "folder")
                                    }
                                    .disabled(project.status != "active")
                                    Divider()
                                    ForEach(project.repositoryIds,id:\.self) { repositoryId in
                                        Button {
                                            Task {
                                                await model.selectSemanticProject(
                                                    project.projectId,repositoryId:repositoryId)
                                            }
                                            dismiss()
                                        } label: {
                                            let label=model.projects.first(where:{$0.repoId == repositoryId})?.label
                                                ?? repositoryId
                                            Label(label,systemImage:model.projectRepositoryId == repositoryId
                                                  ? "checkmark.circle.fill" : "folder")
                                        }
                                        .disabled(project.status != "active")
                                    }
                                } label: {
                                    Label("任务范围",systemImage:"arrow.left.arrow.right")
                                }
                            }
                            Button {
                                changeStatus(project,to:project.status == "archived" ? "active" : "archived")
                            } label: {
                                Label(project.status == "archived" ? "恢复项目" : "归档项目",
                                      systemImage:project.status == "archived" ? "arrow.uturn.backward" : "archivebox")
                            }
                        } label: {
                            Image(systemName:"ellipsis")
                                .frame(width:28,height:28)
                                .contentShape(Rectangle())
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                        .disabled(saving || model.busy)
                        .accessibilityLabel("\(project.displayName) 的操作")
                    }
                    .padding(.vertical,4)
                    .accessibilityIdentifier("zen.projects.row.\(project.projectId)")
                }
            }
            .listStyle(.plain)
            .overlay {
                if visibleProjects.isEmpty && !model.semanticProjectsLoading {
                    VStack(spacing:10) {
                        Image(systemName:"folder")
                            .font(.system(size:24)).foregroundStyle(.secondary)
                        Text(query.isEmpty ? "暂无项目" : "没有匹配的项目")
                            .font(.system(size:13)).foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Text(model.semanticProjects.count >= 100 ? "当前显示前 100 个项目" :
                     "共 \(model.semanticProjects.count) 个项目")
                    .font(.system(size:11)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    Task { await model.refreshSemanticProjects() }
                } label: { Label("刷新",systemImage:"arrow.clockwise") }
                    .disabled(model.semanticProjectsLoading || saving)
            }
        }
        .padding(22)
    }

    private func save() {
        guard !saving else { return }
        let name = draftName.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let project = editingProject
        guard creating || project != nil else { return }
        saving = true
        Task {
            let ok: Bool
            if creating {
                ok = await model.createSemanticProject(
                    displayName:name,repositoryId:newProjectRepositoryId)
            } else if let project {
                ok = await model.reviseSemanticProject(
                    projectId:project.projectId,expectedRevision:project.revision,displayName:name)
            } else {
                ok = false
            }
            saving = false
            if ok {
                creating = false
                editingProjectId = nil
                draftName = ""
                newProjectRepositoryId = nil
            }
        }
    }

    private func changeStatus(_ project:ForgeSemanticProject,to status:String) {
        guard !saving else { return }
        saving = true
        Task {
            _ = await model.reviseSemanticProject(
                projectId:project.projectId,expectedRevision:project.revision,status:status)
            saving = false
        }
    }
}


enum ZenProjectRevisionPresentation {
    static let scopeDescription="记录项目创建、仓库关联与更新，不包含字段级变更内容。"

    static func actionLabel(_ action:String) -> String {
        switch action {
        case "project_semantic_create": return "创建项目"
        case "project_semantic_onboard": return "关联仓库"
        case "project_semantic_write": return "更新项目"
        default: return "其他操作"
        }
    }
}

struct ZenProjectDetailPane: View {
    @ObservedObject var model: NativeWorkspace
    let projectId: String
    let onOpenTasks: (String,String?) -> Void
    let onOpenRequirement: (String,String?,String) -> Void
    let onBack: () -> Void
    @State private var detail: ForgeSemanticProjectDetail?
    @State private var loading = false
    @State private var loadingMore = false
    @State private var error: String?

    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                Button(action:onBack) { Label("返回项目",systemImage:"chevron.left") }.buttonStyle(.plain)
                Spacer()
                Button { Task { await load(reset:true) } } label: { Label("刷新",systemImage:"arrow.clockwise") }
                    .disabled(loading || loadingMore)
            }
            if loading { ProgressView().controlSize(.small) }
            if let detail {
                ScrollView {
                    VStack(alignment:.leading,spacing:12) {
                        HStack {
                            Text(detail.project.displayName).font(.system(size:18,weight:.semibold))
                            Spacer()
                            Text("v\(detail.project.revision)").font(.system(size:11,design:.monospaced)).foregroundStyle(.secondary)
                        }
                        Text(projectId).font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary)
                        HStack {
                            Text(placementSummary(detail.project)).font(.system(size:11)).foregroundStyle(.secondary)
                            Spacer()
                            if detail.project.status == "active" {
                                if detail.project.repositoryIds.isEmpty {
                                    Button("打开任务列表") { onOpenTasks(projectId,nil) }
                                        .buttonStyle(.plain).disabled(model.busy)
                                        .accessibilityIdentifier("zen.projects.detail.open-tasks")
                                } else {
                                    Menu {
                                        Button {
                                            onOpenTasks(projectId,nil)
                                        } label: {
                                            Label("项目级任务",systemImage:"folder")
                                        }
                                        Divider()
                                        ForEach(detail.project.repositoryIds,id:\.self) { repositoryId in
                                            let repository=model.projects.first(where:{$0.repoId == repositoryId})
                                            Button {
                                                onOpenTasks(projectId,repositoryId)
                                            } label: {
                                                Label(repository?.label ?? repositoryId,systemImage:"folder")
                                            }
                                            .disabled(repository == nil)
                                        }
                                    } label: {
                                        Label("打开任务列表",systemImage:"arrow.right")
                                    }
                                    .menuStyle(.borderlessButton)
                                    .fixedSize()
                                    .disabled(model.busy)
                                    .accessibilityIdentifier("zen.projects.detail.open-tasks")
                                }
                            }
                        }
                        Divider()
                        Text("任务概况").font(.system(size:12,weight:.semibold))
                        Text("待开始 \(detail.taskStatusCounts["planned"] ?? 0) · 进行中 \(detail.taskStatusCounts["active"] ?? 0) · 待你处理 \(detail.taskStatusCounts["waiting_for_user"] ?? 0) · 已完成 \(detail.taskStatusCounts["done"] ?? 0) · 已取消 \(detail.taskStatusCounts["cancelled"] ?? 0) · 阻塞 \(detail.blockedTaskCount)")
                            .font(.system(size:10)).foregroundStyle(.secondary)
                        Text("优先级 · 紧急 \(detail.taskPriorityCounts["urgent"] ?? 0) · 高 \(detail.taskPriorityCounts["high"] ?? 0) · 普通 \(detail.taskPriorityCounts["normal"] ?? 0) · 低 \(detail.taskPriorityCounts["low"] ?? 0)")
                            .font(.system(size:10)).foregroundStyle(.secondary)
                        Divider()
                        HStack {
                            Text("任务").font(.system(size:12,weight:.semibold))
                            Spacer()
                            Text("\(detail.requirements.count) / \(detail.requirementCount)").font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary)
                        }
                        ForEach(detail.requirements) { task in
                            Button { onOpenRequirement(projectId,task.repoId,task.requirementId) } label: {
                                VStack(alignment:.leading,spacing:4) {
                                HStack {
                                    Text(task.title).font(.system(size:12,weight:.medium)).lineLimit(2)
                                    Spacer()
                                    Text(ZenWorkspacePane.taskStatusLabel(task.status) ?? task.status).font(.system(size:10)).foregroundStyle(.secondary)
                                }
                                HStack(spacing:7) {
                                    Text(task.requirementId).font(.system(size:9,design:.monospaced))
                                    if let repoId=task.repoId { Text(model.projects.first(where:{$0.repoId == repoId})?.label ?? repoId) }
                                    if let priority=task.priority { Text(taskPriorityLabel(priority)) }
                                    if let assignee=task.assignee,!assignee.isEmpty { Text(assignee) }
                                }
                                .font(.system(size:9)).foregroundStyle(.secondary)
                                if !task.progressSummary.isEmpty {
                                    Text(task.progressSummary).font(.system(size:10)).foregroundStyle(.secondary).lineLimit(2)
                                }
                                Text("剩余 \(task.remainingWorkCount) · 证据 \(task.acceptedEvidenceCount) · 依赖 \(task.dependencyCount) · 计划 \(task.linkedPlanCount)")
                                    .font(.system(size:9)).foregroundStyle(.tertiary)
                            }
                            .padding(.trailing,14)
                            }
                            .buttonStyle(.plain)
                            .disabled(detail.project.status != "active")
                            .padding(.vertical,7)
                            .overlay(alignment:.trailing) { Image(systemName:"chevron.right").font(.system(size:9,weight:.semibold)).foregroundStyle(.tertiary) }
                            .overlay(alignment:.bottom) { Rectangle().fill(Color.primary.opacity(0.055)).frame(height:1) }
                            .accessibilityIdentifier("zen.projects.detail.task.\(task.requirementId)")
                            .accessibilityLabel("打开任务 \(task.title)")
                        }
                        if loadingMore { ProgressView("正在读取更多任务…").controlSize(.small) }
                        if detail.hasMore {
                            Button("加载更多任务") { Task { await load(reset:false) } }
                                .disabled(loading || loadingMore)
                                .accessibilityIdentifier("zen.projects.detail.load-more")
                        }
                        if let error { Text(error).font(.system(size:10)).foregroundStyle(.orange) }
                        Divider()
                        Text("操作记录").font(.system(size:12,weight:.semibold))
                        if detail.revisionHistory.isEmpty {
                            Text("暂无操作记录")
                                .font(.system(size:10))
                                .foregroundStyle(.tertiary)
                                .accessibilityIdentifier("zen.projects.detail.history.empty")
                        } else {
                            ForEach(detail.revisionHistory) { record in
                                HStack(spacing:8) {
                                    Text("v\(record.revision)").font(.system(size:10,design:.monospaced))
                                    Text(actionLabel(record.action)).font(.system(size:10))
                                    Spacer()
                                    Text(record.recordedAt).font(.system(size:9,design:.monospaced)).foregroundStyle(.tertiary)
                                }
                                .accessibilityElement(children:.combine)
                                .accessibilityLabel("版本 \(record.revision)，\(actionLabel(record.action))，\(record.recordedAt)")
                            }
                        }
                    }
                    .frame(maxWidth:.infinity,alignment:.leading)
                }
            } else if let error {
                Text(error).font(.system(size:11)).foregroundStyle(.orange).textSelection(.enabled)
                Button("重试") { Task { await load(reset:true) } }.disabled(loading)
            }
        }
        .padding(22)
        .frame(minWidth:540,minHeight:470)
        .task { await load(reset:true) }
        .accessibilityIdentifier("zen.projects.detail")
    }

    private func load(reset:Bool) async {
        guard !loading && !loadingMore else { return }
        let offset=reset ? 0 : (detail?.nextRequirementOffset ?? 0)
        if reset { loading=true } else { loadingMore=true }
        error=nil
        defer { loading=false; loadingMore=false }
        do {
            let page=try await model.readSemanticProjectDetail(projectId:projectId,offset:offset)
            guard !Task.isCancelled else { return }
            if reset || detail == nil { detail=page }
            else if let current=detail { detail=current.appending(page) }
        } catch {
            guard !Task.isCancelled else { return }
            self.error=error.localizedDescription
        }
    }

    private func placementSummary(_ project:ForgeSemanticProject) -> String {
        let names=project.repositoryIds.map { id in model.projects.first(where:{$0.repoId == id})?.label ?? id }
        return names.isEmpty ? "仅项目级" : "关联仓库 · " + names.joined(separator:"、")
    }

    private func taskPriorityLabel(_ priority:String) -> String {
        switch priority {
        case "urgent": return "紧急"
        case "high": return "高"
        case "normal": return "普通"
        case "low": return "低"
        default: return priority
        }
    }

    private func actionLabel(_ action:String) -> String {
        switch action {
        case "project_semantic_create": return "创建项目"
        case "project_semantic_onboard": return "关联仓库"
        case "project_semantic_write": return "更新项目"
        default: return "其他操作"
        }
    }
}
