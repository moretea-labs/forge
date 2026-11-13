import SwiftUI

// A presentation of existing Repository, Requirement, Plan and Autopilot facts.
// Zen never owns a second plan, project registry, or execution state.
enum ZenScreen {
    case projects, board, canvas
}

enum ZenNodeAction {
    case addPlan, edit, optimize, review, complete, cancel
    case toggleExecution, executionSettings
}

enum ZenBoardBucket: Int, CaseIterable {
    case todo, planned, running, done, cancelled

    var title: String {
        switch self {
        case .todo: return "待规划"
        case .planned: return "已规划"
        case .running: return "执行中"
        case .done: return "已完成"
        case .cancelled: return "已取消"
        }
    }

    static func classify(requirementState: String, runtimeActive: Bool, hasPlan: Bool = false) -> Self {
        if requirementState == "completed" || requirementState == "done" { return .done }
        if requirementState == "cancelled" { return .cancelled }
        if runtimeActive { return .running }
        if hasPlan { return .planned }
        return .todo
    }
}

struct ZenRail: View {
    @Binding var screen: ZenScreen
    let onOpenSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing:10) {
            Image(systemName:"square.stack.3d.up.fill")
                .font(.system(size:18,weight:.medium))
                .frame(width:42,height:42)
                .accessibilityLabel("Forge")
                .padding(.bottom,14)
            navigation(.projects,symbol:"square.grid.2x2",label:"全部项目")
            navigation(.board,symbol:"rectangle.split.3x1",label:"工作看板")
            navigation(.canvas,symbol:"point.3.connected.trianglepath.dotted",label:"需求画布")
            Spacer(minLength:12)
            Button(action:onOpenSettings) {
                Image(systemName:"gearshape").frame(width:42,height:40)
            }
            .buttonStyle(.plain)
            .help("设置")
            .accessibilityLabel("设置")
        }
        .padding(.top,14).padding(.bottom,14)
        .frame(width:62)
        .frame(maxHeight:.infinity)
        .background(.regularMaterial)
    }

    private func navigation(_ target:ZenScreen,symbol:String,label:String) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                screen=target
            }
        } label: {
            Image(systemName:symbol)
                .font(.system(size:15,weight:screen == target ? .semibold : .regular))
                .foregroundStyle(screen == target ? Color.primary : Color.secondary)
                .frame(width:42,height:40)
                .background(screen == target ? Color.primary.opacity(0.095) : .clear,
                            in:RoundedRectangle(cornerRadius:11,style:.continuous))
                .contentShape(RoundedRectangle(cornerRadius:11,style:.continuous))
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityIdentifier("zen.nav.\(label)")
    }
}

struct ZenSidebar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var model: NativeWorkspace
    @Binding var screen: ZenScreen
    @Binding var focusedRequirementId: String?
    let decisionCount: Int
    let onInbox: () -> Void
    let onAddProject: () -> Void

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack {
                Text("项目").font(.system(size:13,weight:.semibold))
                Spacer()
                Text("\(model.projects.count)").font(.system(size:11)).foregroundStyle(.secondary)
                Button(action:onAddProject) {
                    Image(systemName:"plus").frame(width:28,height:28)
                }
                .buttonStyle(.plain)
                .help("添加本地项目")
                .accessibilityLabel("添加项目")
                .accessibilityIdentifier("zen.project.add")
            }
            .padding(.horizontal,15).frame(height:54)

            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                    screen = .projects
                }
            } label: {
                Label("全部项目",systemImage:"square.grid.2x2")
                    .frame(maxWidth:.infinity,alignment:.leading).frame(height:33)
                    .padding(.horizontal,10)
                    .background(screen == .projects ? Color.primary.opacity(0.075) : .clear,
                                in:RoundedRectangle(cornerRadius:9))
            }
            .buttonStyle(.plain)
            .padding(.horizontal,9)

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

            ScrollView {
                LazyVStack(alignment:.leading,spacing:3) {
                    ForEach(model.projects) { project in
                        Button {
                            guard !model.busy else { return }
                            model.focusZenProject(project.repoId)
                            focusedRequirementId = nil
                            withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                                screen = .board
                            }
                        } label: {
                            HStack(spacing:9) {
                                Image(systemName:"folder")
                                    .font(.system(size:11)).foregroundStyle(.secondary)
                                    .frame(width:17)
                                Text(project.displayName)
                                    .font(.system(size:12,weight:model.repoId == project.repoId ? .semibold : .regular))
                                    .lineLimit(1)
                                Spacer(minLength:0)
                                if model.repoId == project.repoId {
                                    Circle().fill(Color.accentColor.opacity(0.7))
                                        .frame(width:5,height:5)
                                }
                            }
                            .padding(.horizontal,10).frame(height:35)
                            .background(model.repoId == project.repoId ? Color.primary.opacity(0.075) : .clear,
                                        in:RoundedRectangle(cornerRadius:9))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(ZenPressStyle())
                        .disabled(model.busy)
                        .help(project.displayName)
                        .accessibilityIdentifier("zen.project.\(project.repoId)")
                    }
                }
                .padding(.horizontal,9).padding(.top,16)
            }
            .scrollIndicators(.hidden)
            Spacer(minLength:0)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.leading)
        .background(.regularMaterial)
    }
}

struct ZenWorkspacePane: View {
    @ObservedObject var model: NativeWorkspace
    @Binding var screen: ZenScreen
    @Binding var focusedRequirementId: String?
    let onOpenPlanning: () -> Void
    let onDraftGoal: (String) -> Void
    let onOpenInbox: () -> Void
    let onOpenAgent: (ForgeRecord, String, String?, Bool) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var searchFocused: Bool
    @State private var requirementQuery = ""
    @State private var hideEmptyColumns = true

    @State private var boardMode = "forge"
    @State private var showingGoalSheet = false
    @State private var goalDraft = ""
    @State private var showingRequirementSheet = false
    @State private var showingPlanSheet = false
    @State private var pendingReviewRecord: ForgeRecord?
    @State private var pendingProposal: ZenChangeProposal?
    @State private var proposalSourceRepoId = ""
    @State private var proposalProblem = ""
    @State private var showingProposalProblem = false
    @State private var editingRecord: ForgeRecord?
    @State private var pendingAcceptanceRecord: ForgeRecord?
    @State private var acceptanceReferences = ""
    @State private var acceptanceAcknowledged = false
    @State private var cancellingRequirement: RequirementRecordDetail?
    @State private var editRevision = 0
    @State private var editTitle = ""
    @State private var editOutcome = ""
    @State private var editCriteria = ""
    @State private var newTitle = ""
    @State private var newOutcome = ""
    @State private var newCriteria = ""
    @State private var newPlanGoal = ""
    @State private var newParentPlanId: String?
    @State private var saving = false

    private var requirements: [ForgeRecord] {
        model.records.filter { $0.kind == .requirement }
    }

    private var visibleRequirements: [ForgeRecord] {
        Self.filterRequirements(requirements,query:requirementQuery)
    }

    static func filterRequirements(_ items:[ForgeRecord],query:String) -> [ForgeRecord] {
        let term=query.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !term.isEmpty else { return items }
        return items.filter {
            $0.title.localizedStandardContains(term)
            || $0.recordId.localizedStandardContains(term)
        }
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
            requirementState:item.state,
            runtimeActive:model.planningAutopilotStatuses[item.recordId]?.runtimeActive == true,
            hasPlan:model.records.contains(where:{$0.kind == .plan && $0.requirementId == item.recordId})
        )
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
                VStack(alignment:.leading,spacing:3) {
                    Text(screen == .projects ? "全部项目" :
                         screen == .board ? (model.project?.displayName ?? "工作看板") :
                         (requirements.first(where:{$0.recordId == focusedRequirementId})?.title ?? "Requirement"))
                        .font(.system(size:18,weight:.semibold))
                        .lineLimit(1)
                    Text(screen == .canvas ? "Requirement → Plan" :
                         screen == .board ? "需求与交付" : "选择项目开始")
                        .font(.system(size:10.5)).foregroundStyle(.secondary)
                }
                Spacer(minLength:0)
                if screen == .board {
                    Button {
                        goalDraft = ""
                        showingGoalSheet = true
                    } label: {
                        Label("描述目标",systemImage:"sparkles")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.repoId == nil || model.busy)
                    .accessibilityIdentifier("zen.goal.describe")
                    Button {
                        reviewLatestProposal()
                    } label: {
                        Label("审阅提案",systemImage:"checkmark.document")
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.repoId == nil || model.busy)
                    .accessibilityIdentifier("zen.proposal.open")
                    Menu {
                        Button("直接创建 Requirement") {
                            newTitle = ""; newOutcome = ""; newCriteria = ""
                            showingRequirementSheet = true
                        }
                    } label: {
                        Image(systemName:"plus").frame(width:28,height:28)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(model.repoId == nil)
                    .help("直接创建 Requirement")
                    .accessibilityIdentifier("zen.requirement.new")
                }
                Button {
                    if model.repoId != nil {
                        Task {
                            await model.loadPage()
                            await model.refreshPlanningAutopilotStatuses()
                            if boardMode == "github" { await model.loadZenGitHubBoard() }
                        }
                    }
                } label: {
                    Image(systemName:"arrow.clockwise").frame(width:28,height:28)
                }
                .buttonStyle(.plain)
                .disabled(model.repoId == nil || model.checkoutContextLoading)
                .help("刷新当前项目")
                .accessibilityLabel("刷新当前项目")
            }
            .padding(.horizontal,24).frame(height:66)

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
                case .projects:
                    projectOverview
                case .board:
                    boardView
                case .canvas:
                    canvasContent
                }
            }
            .transition(.opacity)
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
            ZenProposalReviewSheet(model:model,sourceRepoId:proposalSourceRepoId,proposal:item) { requirementId in
                focusedRequirementId=requirementId
                screen = .canvas
            }
        }
        .alert("提案不可用",isPresented:$showingProposalProblem) {
            Button("确定",role:.cancel) {}
        } message: {
            Text(proposalProblem)
        }
        .sheet(isPresented:$showingRequirementSheet) { createRequirementSheet }
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
        .onChange(of:model.repoId) { _ in
            boardMode = "forge"
            requirementQuery = ""
            searchFocused = false
        }
        .task(id:"\(model.repoId ?? "none")|\(model.planningRequirementIds.joined(separator:"|"))|\(scenePhase == .active ? "active" : "inactive")") {
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

    private var projectOverview: some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                ForEach(model.projects) { project in
                    Button {
                        guard !model.busy else { return }
                        model.focusZenProject(project.repoId)
                        focusedRequirementId = nil
                        navigate(.board)
                    } label: {
                        HStack(spacing:15) {
                            Image(systemName:"folder")
                                .font(.system(size:17)).foregroundStyle(.secondary)
                                .frame(width:35,height:38)
                            VStack(alignment:.leading,spacing:4) {
                                Text(project.displayName).font(.system(size:14,weight:.medium))
                                Text(project.defaultBranch ?? project.localRoot ?? project.repoId)
                                    .font(.system(size:11)).foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName:"chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(.vertical,12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(ZenPressStyle())
                    .disabled(model.busy)
                    Divider()
                }
            }
            .padding(.horizontal,29).padding(.top,20)
        }
        .overlay {
            if model.projects.isEmpty {
                ZenEmptyState(title:"暂无项目",subtitle:"请先在 Forge 中注册项目。",symbol:"folder")
            }
        }
    }

    private var boardView: some View {
        VStack(alignment:.leading,spacing:0) {
            if model.repoId == nil {
                ZenEmptyState(title:"选择项目",subtitle:"从左侧选择要推进的项目。",symbol:"folder")
                Spacer()
            } else {
                HStack(spacing:12) {
                    Text("\(requirements.count) 个 Requirement")
                    Text("\(requirements.filter{$0.state == "completed"}.count) 已完成")
                    if !model.relevantUserRequests.isEmpty {
                        Button("\(model.relevantUserRequests.count) 项待决策") { onOpenInbox() }
                            .buttonStyle(.plain)
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("zen.board.inbox")
                    }
                    Spacer()
                    if let issue=model.planningAutopilotStatusError {
                        Text(issue).foregroundStyle(.orange).lineLimit(1)
                    }
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
                            TextField("搜索需求名称或 ID",text:$requirementQuery)
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
                    Menu {
                        Button("Forge 原生管理") { boardMode = "forge" }
                        Button("GitHub Project（可选）") {
                            boardMode = "github"
                            Task { await model.loadZenGitHubBoard() }
                        }
                    } label: {
                        Label(boardMode == "forge" ? "Forge 看板" : "GitHub 看板",systemImage:"chevron.down")
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
                    Text("未配置 GitHub Project；Forge 原生管理不受影响。")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                        .padding(.horizontal,24).padding(.bottom,11)
                }
                if model.zenGitHubBoardConfigured == true && boardMode == "github" {
                    ZenGitHubBoardView(items:model.zenGitHubBoardItems,
                                       truncated:model.zenGitHubBoardTruncated)
                } else {
                GeometryReader { frame in
                    ScrollView(.horizontal) {
                        HStack(alignment:.top,spacing:14) {
                            ForEach(visibleStages,id:\.rawValue) { stage in
                                let items = visibleRequirements.filter { bucket($0) == stage }
                                VStack(alignment:.leading,spacing:0) {
                                    HStack(spacing:9) {
                                        Circle()
                                            .fill(stage == .done ? Color.green.opacity(0.75) :
                                                  stage == .running ? Color.accentColor : Color.secondary.opacity(0.5))
                                            .frame(width:7,height:7)
                                        Text(stage.title).font(.system(size:12,weight:.semibold))
                                        Text("\(items.count)").font(.system(size:10)).foregroundStyle(.secondary)
                                        Spacer()
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
                                                            Spacer(minLength:0)
                                                            if let status=model.planningAutopilotStatuses[item.recordId],
                                                               stage == .running {
                                                                Text(status.runStatus ?? "执行中")
                                                                    .font(.system(size:9))
                                                            }
                                                        }
                                                        .foregroundStyle(.secondary)
                                                    }
                                                    .padding(.horizontal,8).padding(.vertical,11)
                                                    .contentShape(Rectangle())
                                                }
                                                .buttonStyle(ZenPressStyle())
                                                .accessibilityIdentifier("zen.requirement.\(item.recordId)")
                                            }
                                        }
                                    }
                                    .scrollIndicators(.hidden)
                                }
                                .padding(13)
                                .frame(width:max(225,(frame.size.width - 76)/3),alignment:.topLeading)
                                .frame(maxHeight:.infinity)
                                .background(Color.primary.opacity(0.025),
                                            in:RoundedRectangle(cornerRadius:12))
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

    private var canvasContent: some View {
        Group {
            if let root = requirements.first(where:{$0.recordId == focusedRequirementId}) {
                HStack(spacing:0) {
                    ZenTreeCanvas(
                        root:root,records:model.records,selectedId:model.selectedRecord,
                        executionStatuses:model.planningAutopilotStatuses,
                        executionBusy:model.autopilotLoading,
                        onSelect:{ item in
                            Task { await model.openRecord(item.id) }
                        },onAction:{ item,action in
                            handleNodeAction(item,action)
                        }
                    )
                    if let selected = model.records.first(where:{$0.id == model.selectedRecord}),
                       selected.id == root.id || selected.requirementId == root.recordId {
                        detailInspector(selected)
                            .frame(width:320)
                            .background(.ultraThinMaterial)
                    }
                }
            } else {
                ZenEmptyState(title:"选择 Requirement",subtitle:"从工作看板选择一个需求查看计划树。",symbol:"point.3.connected.trianglepath.dotted")
            }
        }
    }

    private func detailLoaded(for item:ForgeRecord) -> Bool {
        switch model.recordDetail {
        case .requirement(let detail):
            return item.kind == .requirement && detail.requirementId == item.recordId
        case .plan(let detail):
            return item.kind == .plan && detail.planId == item.recordId
        case nil:
            return false
        }
    }

    private func detailInspector(_ item:ForgeRecord) -> some View {
        ScrollView {
            VStack(alignment:.leading,spacing:15) {
                HStack {
                    Text(item.kind == .requirement ? "Requirement" : "Plan")
                        .font(.system(size:10,weight:.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text(item.state).font(.system(size:10)).foregroundStyle(.secondary)
                    Button {
                        withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                            model.clearRecordSelection()
                        }
                    } label: {
                        Image(systemName:"xmark").frame(width:26,height:26)
                    }
                    .buttonStyle(.plain)
                    .help("关闭详情")
                    .accessibilityLabel("关闭详情")
                    .accessibilityIdentifier("zen.inspector.close")
                }
                Text(item.title).font(.system(size:16,weight:.semibold))
                Text(item.recordId).font(.system(size:10,design:.monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Divider()
                switch model.recordDetail {
                case .requirement(let detail) where item.kind == .requirement && detail.requirementId == item.recordId:
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

                if detailLoaded(for:item) && item.kind == .requirement {
                    zenExecutionSection(item)
                }
            }
            .padding(18)
            .frame(maxWidth:.infinity,alignment:.leading)
        }
        .accessibilityIdentifier("zen.record.inspector")
    }



    private func handleNodeAction(_ item:ForgeRecord,_ action:ZenNodeAction) {
        guard let activeRepoId=model.repoId,
              let root=requirements.first(where:{$0.recordId == focusedRequirementId}),
              item.id == root.id || item.requirementId == root.recordId else { return }
        switch action {
        case .addPlan:
            guard root.state == "open" else { return }
            newPlanGoal=""
            newParentPlanId=item.kind == .plan ? item.recordId : nil
            showingPlanSheet=true
        case .edit, .complete, .cancel:
            guard root.state == "open" else { return }
            Task {
                await model.openRecord(item.id)
                guard model.repoId == activeRepoId,
                      model.selectedRecord == item.id,
                      detailLoaded(for:item) else { return }
                switch action {
                case .edit:
                    beginEdit(item)
                case .complete:
                    guard case .requirement(let detail)=model.recordDetail,
                          detail.requirementId == item.recordId,detail.state == "open" else { return }
                    acceptanceReferences=detail.acceptedEvidenceRefs.joined(separator:"\n")
                    acceptanceAcknowledged=false
                    pendingAcceptanceRecord=item
                case .cancel:
                    guard case .requirement(let detail)=model.recordDetail,
                          detail.requirementId == item.recordId,detail.state == "open" else { return }
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
            onOpenPlanning()
        case .toggleExecution:
            guard item.kind == .requirement,root.state == "open",
                  let status=model.planningAutopilotStatuses[item.recordId] else { return }
            if !status.authorized || status.requiresReapproval {
                onOpenPlanning()
            } else if status.runtimeActive {
                runExecution(item.recordId,"pause")
            } else if status.providerReady {
                let operation=["paused","blocked","failed"].contains(status.runStatus ?? "") ? "resume" : "start"
                runExecution(item.recordId,operation)
            }
        }
    }

    private func acceptanceSheet(_ item:ForgeRecord) -> some View {
        VStack(alignment:.leading,spacing:14) {
            Text("完成 Requirement").font(.system(size:17,weight:.semibold))
            Text("终态不可重开。请先核查验收标准和交付证据；这里只登记已经存在的证据引用，不创建或伪造证据。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            if case .requirement(let detail) = model.recordDetail,
               detail.requirementId == item.recordId {
                Text(detail.title).font(.system(size:12,weight:.semibold))
                if !detail.acceptanceCriteria.isEmpty {
                    Text("验收标准").font(.system(size:11,weight:.semibold))
                    ForEach(detail.acceptanceCriteria,id:\.self) { criterion in
                        Label(criterion,systemImage:"checkmark.circle")
                            .font(.system(size:11))
                    }
                }
                if !detail.remainingWork.isEmpty {
                    Text("还有 \(detail.remainingWork.count) 项剩余工作，不能标记完成。")
                        .font(.system(size:11)).foregroundStyle(.orange)
                }
                TextField("验收证据引用（每行一条）",text:$acceptanceReferences,axis:.vertical)
                    .lineLimit(4...6)
                    .accessibilityIdentifier("zen.acceptance.references")
                Toggle("验收标准均已核对，证据引用真实可复查",isOn:$acceptanceAcknowledged)
                    .font(.system(size:11))
                HStack {
                    Spacer()
                    Button("返回") { pendingAcceptanceRecord=nil }
                    Button(saving ? "提交中…" : "确认完成") {
                        saving=true
                        Task {
                            let ok=await model.transitionRequirement(
                                id:detail.requirementId,expectedRevision:detail.revision,
                                title:detail.title,outcome:detail.outcomeStatement,
                                acceptanceCriteria:detail.acceptanceCriteria,state:"completed",
                                acceptedEvidenceRefs:acceptanceReferences.components(separatedBy:.newlines)
                            )
                            saving=false
                            if ok { pendingAcceptanceRecord=nil }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving || !acceptanceAcknowledged
                              || !detail.remainingWork.isEmpty
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
            }
        }
        .padding(22).frame(width:490)
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
        case .plan(let value) where item.kind == .plan:
            editRevision=value.revision
            editTitle=value.goal
        default:
            return
        }
        editingRecord=item
    }

    private func editSheet(for item:ForgeRecord) -> some View {
        VStack(alignment:.leading,spacing:14) {
            Text(item.kind == .requirement ? "编辑 Requirement" : "编辑 Plan")
                .font(.system(size:17,weight:.semibold))
            Text(item.recordId + " · v\(editRevision)")
                .font(.system(size:10,design:.monospaced))
                .foregroundStyle(.secondary)

            if item.kind == .requirement {
                TextField("名称",text:$editTitle)
                TextField("预期结果",text:$editOutcome,axis:.vertical)
                    .lineLimit(3...6)
                TextField("验收标准（每行一项）",text:$editCriteria,axis:.vertical)
                    .lineLimit(3...7)
            } else {
                TextField("计划目标",text:$editTitle,axis:.vertical)
                    .lineLimit(3...6)
            }

            HStack {
                Spacer()
                Button("取消") { editingRecord=nil }
                Button(saving ? "保存中…" : "保存修改") {
                    saving=true
                    Task {
                        let ok:Bool
                        if item.kind == .requirement {
                            ok=await model.reviseRequirement(
                                id:item.recordId,expectedRevision:editRevision,
                                title:editTitle,outcome:editOutcome,
                                acceptanceCriteria:editCriteria.components(separatedBy:.newlines)
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
                              && editOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }
        .padding(22)
        .frame(width:465)
        .accessibilityIdentifier("zen.record.edit")
    }



    private func reviewLatestProposal() {
        guard let repoId=model.repoId,
              let thread=model.thread,thread.repoId == repoId,
              let response=thread.messages.last,
              response.role == "assistant",response.incomplete != true else {
            proposalProblem="请选择当前项目中已经完成分析的 Agent 会话；若模型还未返回，请先完成分析。"
            showingProposalProblem=true
            return
        }
        do {
            let proposal=try ZenChangeProposal.parse(response.text)
            proposalSourceRepoId=repoId
            pendingProposal=proposal
        } catch {
            proposalProblem=error.localizedDescription
            showingProposalProblem=true
        }
    }

    private var goalSheet: some View {
        VStack(alignment:.leading,spacing:14) {
            Text("描述你的目标").font(.system(size:17,weight:.semibold))
            Text("由现有 Agent 提出修改或新增建议。Agent 的工具权限不由这个页面限制；请使用只读访问进行分析，Zen 仅在你批准后应用结构化提案。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            TextField("希望解决什么问题？",text:$goalDraft,axis:.vertical)
                .lineLimit(5...8)
                .accessibilityIdentifier("zen.goal.input")
            HStack {
                Spacer()
                Button("取消") { showingGoalSheet=false }
                Button("分析需求") {
                    let description=goalDraft.trimmingCharacters(in:.whitespacesAndNewlines)
                    showingGoalSheet=false
                    onDraftGoal(description)
                }
                .buttonStyle(.borderedProminent)
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
                if let plan=status.currentPlanId,!plan.isEmpty {
                    Text("当前 Plan · \(plan)").font(.system(size:10,design:.monospaced))
                        .foregroundStyle(.secondary)
                }
                if !status.authorized || status.requiresReapproval {
                    Label("需要批准执行",systemImage:"lock")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                }
            } else {
                Text("尚未读取到执行状态。").font(.system(size:11))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("zen.execution.summary")
    }

    private func runExecution(_ requirementId:String,_ operation:String) {
        guard !model.autopilotLoading else { return }
        Task {
            _ = await model.controlAutopilot(requirementId:requirementId,operation:operation)
        }
    }

    private var createRequirementSheet: some View {
        VStack(alignment:.leading,spacing:12) {
            Text("新建 Requirement").font(.system(size:17,weight:.semibold))
            TextField("名称",text:$newTitle)
            TextField("预期结果",text:$newOutcome,axis:.vertical).lineLimit(3...5)
            TextField("验收标准（每行一项）",text:$newCriteria,axis:.vertical).lineLimit(3...6)
            HStack {
                Spacer()
                Button("取消") { showingRequirementSheet=false }
                Button(saving ? "保存中…" : "创建") {
                    saving=true
                    Task {
                        let id=await model.createRequirement(
                            title:newTitle,outcome:newOutcome,
                            acceptanceCriteria:newCriteria.components(separatedBy:.newlines)
                        )
                        saving=false
                        if let id {
                            focusedRequirementId=id
                            screen = .canvas
                            showingRequirementSheet=false
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || newTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                          || newOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22).frame(width:430)
        .accessibilityIdentifier("zen.requirement.create")
    }

    private var createPlanSheet: some View {
        VStack(alignment:.leading,spacing:12) {
            Text(newParentPlanId == nil ? "新增 Plan" : "新增子 Plan")
                .font(.system(size:17,weight:.semibold))
            TextField("计划目标",text:$newPlanGoal,axis:.vertical).lineLimit(3...5)
            HStack {
                Spacer()
                Button("取消") { showingPlanSheet=false }
                Button(saving ? "保存中…" : "创建") {
                    saving=true
                    Task {
                        let id=await model.createPlan(objective:newPlanGoal,
                                                      requirementId:focusedRequirementId,
                                                      parentPlanId:newParentPlanId)
                        saving=false
                        if let id {
                            showingPlanSheet=false
                            if let record=model.records.first(where:{
                                $0.kind == .plan && $0.recordId == id
                            }) {
                                await model.openRecord(record.id)
                            }
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || newPlanGoal.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22).frame(width:400)
    }
}

private struct ZenTreeCanvas: View {
    let root: ForgeRecord
    let records: [ForgeRecord]
    let selectedId: String?
    let executionStatuses: [String:AutopilotStatusDetail]
    let executionBusy: Bool
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
        let canChange=root.state == "open"
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
                    if let status=executionStatuses[item.recordId] {
                        if status.authorized && !status.requiresReapproval {
                            if status.runtimeActive {
                                Button("暂停执行",systemImage:"pause") {
                                    onAction(item,.toggleExecution)
                                }
                                .disabled(executionBusy)
                            } else if status.providerReady {
                                Button(["paused","blocked","failed"].contains(status.runStatus ?? "")
                                       ? "继续执行" : "开始执行",systemImage:"play") {
                                    onAction(item,.toggleExecution)
                                }
                                .disabled(executionBusy)
                            }
                        } else {
                            Button("批准执行",systemImage:"lock.open") {
                                onAction(item,.executionSettings)
                            }
                        }
                    }
                    Button("执行设置",systemImage:"slider.horizontal.3") {
                        onAction(item,.executionSettings)
                    }
                    Divider()
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
        .padding(.horizontal,3).padding(.vertical,2)
        .background(.regularMaterial,in:RoundedRectangle(cornerRadius:8))
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

    private func position(_ row:Int,_ index:Int,width:CGFloat,columns:Int) -> CGPoint {
        let columnWidth=width/CGFloat(max(1,columns))
        return CGPoint(x:columnWidth * (CGFloat(index) + 0.5),y:CGFloat(row)*156+89)
    }

    var body: some View {
        GeometryReader { viewport in
            let rows=levels
            let maxNodes=rows.map(\.count).max() ?? 1
            let width=max(viewport.size.width,CGFloat(maxNodes)*240+70)
            let height=max(viewport.size.height,CGFloat(rows.count)*156+60)
            let scopedIds=Set(rows.flatMap{$0}.map(\.recordId))
            ScrollView([.horizontal,.vertical]) {
                ZStack(alignment:.topLeading) {
                    Canvas { context,_ in
                        for row in 1..<rows.count {
                            for (index,child) in rows[row].enumerated() {
                                let parents=rows[row-1]
                                guard let parentIndex=parents.firstIndex(where:{ parent in
                                    child.parentPlanId == parent.recordId
                                    || (parent.kind == .requirement &&
                                         !scopedIds.contains(child.parentPlanId ?? ""))
                                }) else { continue }
                                let start=position(row-1,parentIndex,width:width,columns:parents.count)
                                let end=position(row,index,width:width,columns:rows[row].count)
                                var path=Path()
                                path.move(to:CGPoint(x:start.x,y:start.y+41))
                                path.addCurve(to:CGPoint(x:end.x,y:end.y-41),
                                              control1:CGPoint(x:start.x,y:(start.y+end.y)/2),
                                              control2:CGPoint(x:end.x,y:(start.y+end.y)/2))
                                context.stroke(path,with:.color(.secondary.opacity(0.28)),
                                               style:StrokeStyle(lineWidth:1.2,lineCap:.round))
                            }
                        }
                    }
                    .frame(width:width,height:height)

                    ForEach(0..<rows.count,id:\.self) { row in
                        ForEach(Array(rows[row].enumerated()),id:\.element.id) { index,item in
                            ZStack(alignment:.topTrailing) {
                                Button { onSelect(item) } label: {
                                    VStack(alignment:.leading,spacing:7) {
                                        HStack(spacing:7) {
                                            Image(systemName:item.kind == .requirement ? "scope" : "list.bullet.rectangle")
                                                .font(.system(size:12)).foregroundStyle(.secondary)
                                            Text(item.kind == .requirement ? "Requirement" : "Plan")
                                                .font(.system(size:10,weight:.semibold))
                                                .foregroundStyle(.secondary)
                                            Spacer()
                                        }
                                        Text(item.title).font(.system(size:12,weight:.medium))
                                            .foregroundStyle(.primary)
                                            .lineLimit(2).multilineTextAlignment(.leading)
                                        Text(item.recordId)
                                            .font(.system(size:9,design:.monospaced))
                                            .foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    .frame(width:184,height:62,alignment:.topLeading)
                                    .padding(10)
                                    .background(item.id == selectedId
                                                ? Color.accentColor.opacity(0.09)
                                                : Color(nsColor:.controlBackgroundColor),
                                                in:RoundedRectangle(cornerRadius:12))
                                    .contentShape(RoundedRectangle(cornerRadius:12))
                                }
                                .buttonStyle(ZenPressStyle())
                                .accessibilityIdentifier("zen.canvas.node.\(item.recordId)")
                                if hoveredNodeId == item.id || selectedId == item.id {
                                    nodeToolbar(item)
                                        .padding(5)
                                        .transition(.opacity)
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
                            .position(position(row,index,width:width,columns:rows[row].count))
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

    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text("Review").font(.system(size:17,weight:.semibold))
                Spacer()
                Button { dismiss() } label: { Image(systemName:"xmark") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("取消 Review")
            }
            Text(record.title).font(.system(size:12)).lineLimit(2)
            Divider()
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
            Picker("Provider / Model",selection:$provider) {
                Text("默认 Provider").tag("")
                Text("Codex").tag("codex")
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
                if model.localApiSettings?.joyCodeReady == true,provider != "joycode" {
                    Text("JoyCode").tag("joycode")
                }
                ForEach(model.localApiSettings?.profiles.filter({
                    $0.endpointReady && $0.providerId != provider
                }) ?? []) { profile in
                    Text("\(profile.label) · \(profile.model)").tag(profile.providerId)
                }
            }
            .pickerStyle(.menu)
            Text("Zen 内审查只支持已配置的 API / JoyCode，强制禁用工具写入；Codex 保留 Agent 入口。Zen 不自动应用审查建议。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            HStack {
                if provider == "joycode" || provider.hasPrefix("api:") {
                    Button("在 Zen 中只读审查") {
                        reviewRole=role.rawValue
                        reviewFocus=role.focus
                        reviewProviders=[provider] + (secondProvider.isEmpty || secondProvider == provider ? [] : [secondProvider])
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.repoId == nil || model.checkoutId == nil)
                }
                Spacer()
                Button("取消") { dismiss() }
                Button("在 Agent 中审查") {
                    let instruction = "请扮演\(role.rawValue)，对当前 \(record.kind == .requirement ? "Requirement" : "Plan") 做 Review。重点检查：\(role.focus)。仅返回问题、证据与建议；请核对 Agent 当前 Repo Access 权限，不要自动写入或执行。"
                    dismiss()
                    onStart(instruction,provider.isEmpty ? nil : provider)
                }
                .buttonStyle(.bordered)
            }
            }
        }
        .padding(22)
        .frame(width:reviewProviders.isEmpty ? 450 : 650,
               height:reviewProviders.isEmpty ? nil : 580)
        .accessibilityIdentifier("zen.review.configure")
        .onAppear {
            role = ZenReviewRole(rawValue:preferredRole) ?? .staff
            let available = model.localApiSettings?.profiles.filter(\.endpointReady).map(\.providerId) ?? []
            provider = preferredProvider == "codex"
                || (preferredProvider == "joycode" && model.localApiSettings?.joyCodeReady == true)
                || available.contains(preferredProvider) ? preferredProvider : ""
            secondProvider = preferredSecondProvider == "joycode" && model.localApiSettings?.joyCodeReady == true
                || available.contains(preferredSecondProvider) ? preferredSecondProvider : ""
        }
        .onChange(of:secondProvider) { preferredSecondProvider = $0 }
        .onChange(of:role) { preferredRole = $0.rawValue }
        .onChange(of:provider) { preferredProvider = $0 }
    }
}
