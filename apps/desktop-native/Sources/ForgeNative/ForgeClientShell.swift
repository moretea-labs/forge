import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct ForgeWorkspaceView: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visibility: NavigationSplitViewVisibility = .automatic
    @State private var renameThreadId: String?
    @State private var renameThreadTitle = ""
    @State private var hoveredThreadId: String?
    @State private var deleteThreadId: String?
    @State private var projectPickerShown = false
    @State private var projectSearch = ""
    @State private var registeringProject = false
    @State private var expandedProjectRepoId: String?
    @State private var expandedProjectCheckouts: [ProjectCheckoutChoice] = []
    @State private var projectCheckoutsLoading = false
    @State private var projectCheckoutsRequestGeneration = 0
    @State private var projectCheckoutError: String?
    @State private var sidebarCheckoutLabels: [String:String] = [:]
    @State private var inboxShown = false
    @State private var assetsSelectedRepoId = ""
    @State private var assetsShowLocalResources = true
    @State private var assetsShowRemoteImages = true
    @State private var assetsSearchQuery = ""
    @State private var assetsReturnResourceID: String?
    @State private var usageSelectedProjectId = ""
    @State private var usageSelectedProviderId = ""
    @State private var usageDays = 30
    @State private var usageReturnEntryID: String?
    @State private var inboxDecisionRequestId: String?
    @State private var inboxDecision = ""
    @State private var inboxDismissRequestId: String?
    @State private var expandedInboxRequestIds: Set<String> = []
    @FocusState private var sidebarSearchFocused: Bool
    // One owner for the native window's right pane, shared by the toolbar
    // and Agent body. A fresh shell starts with three visible columns.
    @SceneStorage("forge.shell.v3.surface.tab") private var selectedWorkSurfaceRaw = "changes"
    @SceneStorage("forge.shell.v3.surface.visible") private var workSurfaceVisible = true
    @SceneStorage("forge.shell.v3.surface.maximized") private var workSurfaceMaximized = false
    @State private var agentSemanticInspector: AgentSemanticContextInspector?

    var body: some View {
        NavigationSplitView(columnVisibility:$visibility) {
            unifiedSidebar
                .navigationSplitViewColumnWidth(min:ForgeClientDesign.Shell.sidebarMin,ideal:ForgeClientDesign.Shell.sidebarIdeal,max:ForgeClientDesign.Shell.sidebarMax)
        } detail: {
            if model.zenMode {
                ZenWorkspacePane(model:model,screen:$model.zenScreen,
                                 focusedRequirementId:$model.zenFocusedRequirementId,
                                 onDraftGoal:{ description in
                    guard !model.zenRefinementActive else {
                        model.error="自动精化进行中，请先按 Esc 停止后再创建新目标。"
                        return
                    }
                    guard model.selectedProjectId != nil else {
                        model.error="请先选择项目。"
                        return
                    }
                    guard let provider=model.readOnlyAnalysisProvider else {
                        model.error="请先配置一个可用的 API Provider，再进行需求分析。"
                        return
                    }
                    if model.repoId != nil && model.projectRepositoryId == nil {
                        model.error="当前仓库不属于所选项目，请重新选择项目或仓库。"
                        return
                    }
                    if model.projectRepositoryId != nil {
                        guard model.checkoutId != nil,model.checkoutIsAvailable else {
                            model.error="当前项目工作区尚未就绪，请稍后重试。"
                            return
                        }
                    }
                    guard !model.busy else {
                        model.error="请先停止正在运行的会话。"
                        return
                    }
                    model.newThread(provider:provider,readOnly:true)
                    guard let launchedThreadId=model.selectedThreadId else { return }
                    let evidenceScope = model.projectRepositoryId == nil
                        ? "当前项目没有关联仓库；只基于项目内现有 Requirement / Plan 和真实回执分析，不假设文件或命令可用。"
                        : "先读取现有 Requirement / Plan 和当前 checkout 的只读工作区证据。"
                    model.draft = """
                    当前项目目标：\(description)

                    请以 Requirement-first 方式分析。\(evidenceScope) 信息不足时通过本会话多轮澄清，不要猜测，也不要输出未确认提案。

                    \(ZenChangeProposal.outputContract)
                    """
                    Task { await model.sendZenRefinement(expectedThreadId:launchedThreadId) }
                },onOpenInbox:{
                    inboxShown = true
                    Task { await model.loadUserRequests() }
                }) { item, prompt, provider, wantsProposal in
                    guard !model.zenRefinementActive else {
                        model.error="自动精化进行中，请先按 Esc 停止后再打开其他会话。"
                        return
                    }
                    guard !model.busy else {
                        model.error="请先停止正在运行的会话。"
                        return
                    }
                    guard let selectedProvider = NativeWorkspace.resolveReadOnlyAnalysisProvider(
                        preferred:provider,fallback:model.readOnlyAnalysisProvider
                    ) else {
                        model.error="请先配置一个可用的 API Provider，再进行只读审查或生成 Zen 提案。"
                        return
                    }
                    model.newThread(
                        provider:selectedProvider,
                        requirementId:item.kind == .requirement ? item.recordId : item.requirementId,
                        planId:item.kind == .plan ? item.recordId : nil,
                        readOnly:true
                    )
                    guard let launchedThreadId=model.selectedThreadId else { return }
                    model.draft = wantsProposal
                        ? prompt + "\n\n" + ZenChangeProposal.outputContract
                        : prompt
                    // "优化" and "在只读 Agent 中审查" are actions, not draft-only navigation.
                    // Start their analysis immediately, bound to the new conversation.
                    Task {
                        if wantsProposal {
                            await model.sendZenRefinement(expectedThreadId:launchedThreadId)
                        } else {
                            await model.send(expectedThreadId:launchedThreadId)
                        }
                    }
                }
            } else {
                main
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement:.principal) {
                HStack(spacing:7) {
                    Text(model.semanticProject?.displayName ?? "Forge")
                        .font(.system(size:12,weight:.medium))
                        .lineLimit(1)
                    if let repository=model.project {
                        Image(systemName:"chevron.right")
                            .font(.system(size:9))
                            .foregroundStyle(.tertiary)
                        Text(repository.label)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if !model.zenMode && model.page == .agent {
                        Image(systemName:"chevron.right")
                            .font(.system(size:9))
                            .foregroundStyle(.tertiary)
                        Text(model.thread?.title ?? "新会话")
                            .font(.system(size:12,weight:.semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(model.zenMode ? "工作台" : model.page.rawValue)
                            .font(.system(size:12,weight:.semibold))
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth:550)
                .accessibilityIdentifier("forge.toolbar.context")
            }
            ToolbarItemGroup(placement:.automatic) {
                unifiedWindowToolbarActions
            }
        }
        .task {
            if model.zenMode { model.show(.requirement) }
        }
        .onChange(of:model.showSearch) { visible in
            sidebarSearchFocused = visible
        }
        .onChange(of:model.repoId) { _ in
            Task { await model.loadUserRequests() }
        }
    }

    private var activeSurface: AgentWorkSurface {
        AgentWorkSurface(rawValue:selectedWorkSurfaceRaw) ?? .changes
    }

    private func openWindowSurface(_ surface:AgentWorkSurface) {
        let changed = !workSurfaceVisible || activeSurface != surface
        selectedWorkSurfaceRaw = surface.rawValue
        workSurfaceVisible = true
        workSurfaceMaximized = false
        agentSemanticInspector = nil
        if changed && surface == .changes {
            Task { await model.refreshAgentChanges() }
        }
    }

    @ViewBuilder
    private var unifiedWindowToolbarActions: some View {
        if model.canNavigateBack {
            Button { model.goBack() } label: {
                Image(systemName:"chevron.left")
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            .help("返回 \(model.navigationBackLabel ?? "上一页")")
            .accessibilityLabel("返回上一页")
            .accessibilityIdentifier("forge.toolbar.back")
        }
        if !model.zenMode && model.page == .agent {
            Button {
                if workSurfaceVisible && activeSurface == .changes {
                    workSurfaceVisible = false
                    workSurfaceMaximized = false
                } else {
                    openWindowSurface(.changes)
                }
            } label: {
                Label("改动",systemImage:"doc.text.magnifyingglass")
                    .foregroundStyle(workSurfaceVisible && activeSurface == .changes
                                     ? ForgePalette.ink : ForgePalette.secondary)
            }
            .buttonStyle(.plain)
            .disabled(model.checkoutId == nil)
            .help("切换右侧改动审查")
            .accessibilityLabel("改动审查")
            .accessibilityIdentifier("agent.changes")

            Button {
                if workSurfaceVisible && activeSurface == .files {
                    workSurfaceVisible = false
                    workSurfaceMaximized = false
                } else {
                    openWindowSurface(.files)
                }
            } label: {
                Label("附件",systemImage:"paperclip")
                    .foregroundStyle(workSurfaceVisible && activeSurface == .files
                                     ? ForgePalette.ink : ForgePalette.secondary)
            }
            .buttonStyle(.plain)
            .help("切换右侧会话资源")
            .accessibilityIdentifier("agent.files")

            if workSurfaceVisible && activeSurface == .changes {
                Menu {
                    Button {
                        Task { await model.refreshAgentChanges(staged:false) }
                    } label: {
                        Label("未暂存",systemImage:model.agentChanges?.staged == false ? "checkmark" : "circle")
                    }
                    Button {
                        Task { await model.refreshAgentChanges(staged:true) }
                    } label: {
                        Label("已暂存",systemImage:model.agentChanges?.staged == true ? "checkmark" : "circle")
                    }
                    Divider()
                    Button("刷新改动") {
                        Task {
                            await model.refreshAgentChanges(staged:model.agentChanges?.staged ?? false)
                        }
                    }
                } label: {
                    Label(model.agentChanges?.staged == true ? "已暂存" : "未暂存",
                          systemImage:"line.3.horizontal.decrease")
                }
                .menuStyle(.borderlessButton)
                .disabled(model.checkoutId == nil || model.changesLoading)
                .help("代码审查范围")
                .accessibilityIdentifier("agent.review.scope")
            }

            Menu {
                Button("规划上下文") {
                    agentSemanticInspector = agentSemanticInspector == .planning ? nil : .planning
                    if agentSemanticInspector != nil { workSurfaceVisible = false }
                }
                .disabled(model.thread?.projectId == nil)
                Button("知识上下文") {
                    agentSemanticInspector = agentSemanticInspector == .knowledge ? nil : .knowledge
                    if agentSemanticInspector != nil { workSurfaceVisible = false }
                }
                .disabled(model.repoId == nil)
                Divider()
                Button("浏览器尚未接入") {}.disabled(true)
            } label: {
                Image(systemName:"ellipsis")
            }
            .menuStyle(.borderlessButton)
            .help("更多会话工具")
            .accessibilityLabel("更多会话工具")
            .accessibilityIdentifier("agent.tools.more")

            if workSurfaceVisible {
                Button {
                    workSurfaceMaximized.toggle()
                } label: {
                    Image(systemName:workSurfaceMaximized
                          ? "arrow.down.right.and.arrow.up.left"
                          : "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.plain)
                .help(workSurfaceMaximized ? "恢复三栏" : "扩展右侧工作区")
                .accessibilityLabel(workSurfaceMaximized ? "恢复三栏" : "扩展右侧工作区")
                .accessibilityIdentifier("agent.work-surface.maximize")
                Button {
                    workSurfaceVisible = false
                    workSurfaceMaximized = false
                } label: {
                    Image(systemName:"xmark")
                }
                .buttonStyle(.plain)
                .help("关闭右侧工作区")
                .accessibilityLabel("关闭工作区")
                .accessibilityIdentifier("agent.work-surface.close")
            }
            Button { Task { await model.refresh() } } label: {
                Circle()
                    .fill(model.busy ? Color.orange
                          : model.selectedProviderReady ? Color.green : ForgePalette.secondary)
                    .frame(width:7,height:7)
            }
            .buttonStyle(.plain)
            .help(model.agentWorkspaceStatusDetail)
            .accessibilityLabel("刷新 Agent 状态")
            .accessibilityValue(model.agentWorkspaceStatusLabel)
            .accessibilityIdentifier("agent.workspace-refresh")
        } else if !model.zenMode {
            Button { refreshCurrentPage() } label: {
                if pageRefreshIsLoading {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName:"arrow.clockwise")
                }
            }
            .buttonStyle(.plain)
            .disabled(pageRefreshIsDisabled)
            .help(pageRefreshHelp)
            .accessibilityIdentifier("app.refresh")
        }
    }

    private var activeSidebarDestination: ForgeSidebarDestination {
        ForgeSidebarDestination.resolve(zenMode:model.zenMode,page:model.page)
    }

    private func openSidebarDestination(_ destination:ForgeSidebarDestination) {
        if destination == .workbench {
            model.openWorkbench()
            return
        }
        if destination == .agent {
            // Route directly; exiting Zen must not depend on a later view callback.
            model.show(.agent)
            return
        }
        switch destination {
        case .workbench, .agent: break
        case .automations: model.show(.schedule)
        case .resources: model.show(.assets)
        case .analytics: model.show(.usage)
        case .settings: model.show(.settings)
        }
    }

    private func sidebarDestinationButton(_ destination:ForgeSidebarDestination) -> some View {
        let selected = activeSidebarDestination == destination
        return Button {
            openSidebarDestination(destination)
        } label: {
            HStack(spacing:7) {
                Image(systemName:destination.symbol).frame(width:16)
                Text(destination.title).lineLimit(1)
                Spacer(minLength:0)
            }
            .font(selected
                  ? ForgeClientDesign.Shell.control.weight(.semibold)
                  : ForgeClientDesign.Shell.control)
            .foregroundStyle(selected ? ForgePalette.ink : ForgePalette.secondary)
            .padding(.horizontal,9)
            .frame(height:ForgeClientDesign.Shell.destinationRowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(destination.title)
        .accessibilityLabel(destination.title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("forge.nav.\(destination.rawValue)")
    }

    private var sidebarSecondaryDestinationMenu: some View {
        let selected = ![ForgeSidebarDestination.agent,.workbench,.automations]
            .contains(activeSidebarDestination)
        return Menu {
            ForEach([ForgeSidebarDestination.resources,.analytics,.settings],id:\.self) { destination in
                Button {
                    openSidebarDestination(destination)
                } label: {
                    if activeSidebarDestination == destination {
                        Label(destination.title,systemImage:"checkmark")
                    } else {
                        Label(destination.title,systemImage:destination.symbol)
                    }
                }
            }
        } label: {
            HStack(spacing:7) {
                Image(systemName:selected ? activeSidebarDestination.symbol : "ellipsis")
                    .frame(width:16)
                Text(selected ? activeSidebarDestination.title : "更多")
                    .lineLimit(1)
                Spacer(minLength:0)
            }
            .font(selected
                  ? ForgeClientDesign.Shell.control.weight(.semibold)
                  : ForgeClientDesign.Shell.control)
            .foregroundStyle(selected ? ForgePalette.ink : ForgePalette.secondary)
            .padding(.horizontal,9)
            .frame(height:ForgeClientDesign.Shell.destinationRowHeight)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .accessibilityLabel("更多导航")
        .accessibilityIdentifier("forge.nav.more")
    }

    private func utilitySidebarButton(_ title:String,icon:String,page:NativePage) -> some View {
        let selected = model.page == page
        return Button { model.show(page) } label: {
            HStack(spacing:10) {
                Image(systemName:icon).frame(width:18)
                Text(title)
                Spacer(minLength:0)
            }
            .font(.system(size:11.5,weight:selected ? .semibold : .regular))
            .foregroundStyle(selected ? ForgePalette.ink : ForgePalette.secondary)
            .padding(.horizontal,11)
            .frame(height:32)
            .background(selected ? ForgePalette.selection : .clear,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("forge.sidebar.\(page.rawValue)")
    }

    private var contextualSidebar: some View {
        VStack(alignment:.leading,spacing:5) {
            if activeSidebarDestination == .resources {
                utilitySidebarButton("文件与图片",icon:"photo.on.rectangle",page:.assets)
                utilitySidebarButton("知识库",icon:"books.vertical",page:.knowledge)
            } else if activeSidebarDestination == .settings {
                utilitySidebarButton("项目插件",icon:"puzzlepiece",page:.plugins)
            }
            Spacer(minLength:0)
        }
        .padding(.horizontal,10)
        .padding(.top,14)
    }

    private var unifiedSidebar: some View {
        // One navigation surface, not two permanently nested sidebars.
        // The project, destinations and conversations share the same column.
        VStack(alignment:.leading,spacing:0) {
            projectSwitcher
                .padding(.horizontal,10)
                .padding(.top,8)
                .padding(.bottom,2)

            VStack(spacing:2) {
                sidebarDestinationButton(.agent)
                sidebarDestinationButton(.workbench)
                sidebarDestinationButton(.automations)
                sidebarSecondaryDestinationMenu
            }
            .padding(.horizontal,10)
            .padding(.bottom,8)
            // Leave children identifiable in AX. The old parent identifier
            // shadowed every button and broke semantic navigation.
            .accessibilityElement(children:.contain)

            // Keep contextual panes mounted across destination changes so
            // conversation search, thread scroll, and Zen state survive.
            ZStack(alignment:.topLeading) {
                ZenSidebar(model:model,screen:$model.zenScreen,
                           focusedRequirementId:$model.zenFocusedRequirementId,
                           decisionCount:model.relevantUserRequests.count,
                           onInbox:{
                    inboxShown = true
                    Task { await model.loadUserRequests() }
                })
                .opacity(model.zenMode ? 1 : 0)
                .allowsHitTesting(model.zenMode)
                .accessibilityHidden(!model.zenMode)
                .popover(isPresented:$inboxShown,arrowEdge:.trailing) {
                    inboxPanel
                }

                sidebar
                    .opacity(!model.zenMode && model.page == .agent ? 1 : 0)
                    .allowsHitTesting(!model.zenMode && model.page == .agent)
                    .accessibilityHidden(model.zenMode || model.page != .agent)

                contextualSidebar
                    .opacity(!model.zenMode && model.page != .agent ? 1 : 0)
                    .allowsHitTesting(!model.zenMode && model.page != .agent)
                    .accessibilityHidden(model.zenMode || model.page == .agent)
            }
            .frame(maxWidth:.infinity,maxHeight:.infinity)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        .background(.ultraThinMaterial)
    }

    private var sidebar: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:6) {
                Text("会话")
                    .font(.system(size:13,weight:.semibold))
                    .lineLimit(1)
                Spacer(minLength:0)
                Button {
                    model.newThread()
                } label: {
                    Image(systemName:"square.and.pencil")
                        .font(.system(size:12.5,weight:.medium))
                        .frame(width:28,height:30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.busy || model.zenRefinementActive)
                .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : model.repoId == nil ? "创建不绑定项目的会话 (⌘N)" : "在当前项目新建会话 (⌘N)")
                .accessibilityLabel("新会话")
                .accessibilityIdentifier("sidebar.thread.new")

                Button { model.toggleConversationSearch() } label: {
                    Image(systemName:model.showSearch ? "xmark" : "magnifyingglass")
                        .font(.system(size:12.5,weight:.medium))
                        .frame(width:28,height:30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(model.showSearch ? "关闭会话搜索 (Esc)" : "搜索全部会话 (⌘K)")
                .accessibilityLabel(model.showSearch ? "关闭搜索" : "搜索会话")
                .accessibilityIdentifier(model.showSearch ? "sidebar.search.close" : "sidebar.search.open")

                Button {
                    inboxShown.toggle()
                    if inboxShown { Task { await model.loadUserRequests() } }
                } label: {
                    ZStack(alignment:.topTrailing) {
                        Image(systemName:"tray")
                            .font(.system(size:12.5,weight:.medium))
                            .frame(width:28,height:30)
                        if !model.relevantUserRequests.isEmpty {
                            let visibleCount = model.relevantUserRequests.count
                            let exactCount = model.userRequestsTotalCount
                            Text(exactCount.map { $0 > 99 ? "99+" : "\($0)" }
                                 ?? "\(min(visibleCount,99))+")
                                .font(.system(size:8,weight:.bold))
                                .padding(.horizontal,3).frame(minWidth:13,minHeight:13)
                                .background(Capsule().fill(ForgePalette.accent))
                                .foregroundStyle(Color.white)
                                .offset(x:3,y:1)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("待处理请求")
                .accessibilityLabel(model.userRequestsTotalCount.map { "待处理请求 \($0)" }
                    ?? "待处理请求至少 \(model.relevantUserRequests.count)")
                .accessibilityIdentifier("sidebar.inbox.open")
                .popover(isPresented:$inboxShown,arrowEdge:.trailing) {
                    inboxPanel
                }
            }
            .padding(.horizontal,18)
            .frame(height:34)
            .padding(.top,9).padding(.bottom,4)

            if model.showSearch {
                HStack(spacing:7) {
                    TextField("搜索会话",text:$model.search)
                        .focused($sidebarSearchFocused)
                        .textFieldStyle(.plain)
                        .font(.system(size:12))
                        .onSubmit {
                            if !model.busy,
                               !model.search.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
                               let first=model.visibleThreads.first {
                                model.selectThread(first.id)
                                model.toggleConversationSearch()
                            }
                        }
                        .onExitCommand { model.toggleConversationSearch() }
                        .accessibilityIdentifier("sidebar.search.field")
                    if !model.search.isEmpty {
                        Button { model.search = "" } label: {
                            Image(systemName:"xmark.circle.fill")
                                .font(.system(size:10))
                        }
                        .buttonStyle(.plain)
                        .help("清除搜索")
                        .accessibilityLabel("清除搜索")
                    }
                }
                .padding(.horizontal,7)
                .frame(height:30)
                .overlay(alignment:.bottom) {
                    Rectangle().fill(ForgePalette.secondary.opacity(0.25)).frame(height:0.5)
                }
                .padding(.horizontal,16).padding(.bottom,4)
            }

            ScrollView {
                LazyVStack(alignment:.leading,spacing:2) {
                    if model.visibleThreads.isEmpty {
                        threadListEmptyState
                    } else {
                        ForEach(sidebarThreadSections) { section in
                            HStack(spacing:6) {
                                Text(section.title)
                                    .font(.system(size:9.5,weight:.semibold))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .lineLimit(1)
                                Spacer()
                                if let repoId = section.repoId {
                                    Button {
                                        model.newThread(inProject:repoId)
                                    } label: {
                                        Image(systemName:"plus")
                                            .font(.system(size:9.5,weight:.semibold))
                                            .frame(width:20,height:20)
                                    }
                                    .buttonStyle(.plain)
                                    .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : "在此项目中新建会话")
                                    .disabled(model.busy || model.zenRefinementActive)
                                }
                            }
                            .padding(.leading,10).padding(.trailing,5).padding(.top,8)
                            ForEach(section.threads) { thread in
                                threadRow(thread)
                            }
                        }
                    }
                }.padding(.horizontal,10)
            }
            .scrollIndicators(.hidden)
            .task(id:sidebarCheckoutLookupKey) { await refreshSidebarCheckoutLabels() }
            .padding(.top,16)
            Spacer(minLength:5)

        }
        .foregroundStyle(ForgePalette.ink)
    }

    private var inboxPanel: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack {
                VStack(alignment:.leading,spacing:2) {
                    Text("待处理").font(.system(size:13,weight:.semibold))
                    Text(model.repoId == nil ? "全局请求" : "当前项目与全局请求")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    if model.userRequestsPossiblyTruncated {
                        Text(model.userRequestsTotalCount == nil
                             ? "当前 Runtime 仅能确认这些请求；可能还有更早项目外请求"
                             : "列表已截断；徽标数量仍来自完整 scoped count")
                            .font(.system(size:9.5)).foregroundStyle(.tertiary)
                    }
                }
                Spacer()
                Button {
                    Task { await model.loadUserRequests() }
                } label: {
                    if model.userRequestsLoading { ProgressView().controlSize(.small) }
                    else { Image(systemName:"arrow.clockwise") }
                }
                .buttonStyle(.plain)
                .disabled(model.userRequestsLoading)
                .accessibilityLabel("刷新待处理请求")
                .accessibilityIdentifier("inbox.refresh")
            }
            .padding(.horizontal,14).padding(.vertical,12)

            Divider()

            if let error = model.userRequestsError {
                HStack(alignment:.top,spacing:8) {
                    Image(systemName:"exclamationmark.circle")
                    Text("请求状态未确认：\(error)。请刷新核对后再提交。")
                        .font(.system(size:11))
                        .fixedSize(horizontal:false,vertical:true)
                        .textSelection(.enabled)
                    Spacer(minLength:6)
                    Button("刷新") { Task { await model.loadUserRequests() } }
                        .buttonStyle(.plain)
                        .font(.system(size:10.5,weight:.semibold))
                        .disabled(model.userRequestsLoading)
                        .accessibilityIdentifier("inbox.retry")
                }
                .foregroundStyle(.orange)
                .padding(.horizontal,14).padding(.vertical,10)
                .accessibilityIdentifier("inbox.error")
            }
            if model.userRequestsLoading && model.relevantUserRequests.isEmpty {
                ProgressView("正在读取…").controlSize(.small).padding(14)
            } else if model.relevantUserRequests.isEmpty && model.userRequestsError == nil {
                Text("当前没有需要处理的请求。")
                    .font(.system(size:11.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(14)
            } else if !model.relevantUserRequests.isEmpty {
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:0) {
                        ForEach(Array(model.relevantUserRequests.enumerated()),id:\.element.id) { index,item in
                            inboxRequestRow(item)
                            if index < model.relevantUserRequests.count - 1 { Divider() }
                        }
                    }
                    .padding(.horizontal,14)
                }
            }
        }
        .frame(width:410,height:460)
        .confirmationDialog(
            "忽略这个请求？",
            isPresented:Binding(
                get:{ inboxDismissRequestId != nil },
                set:{ if !$0 { inboxDismissRequestId = nil } }
            ),
            titleVisibility:.visible
        ) {
            Button("忽略并关闭",role:.destructive) {
                guard let id=inboxDismissRequestId,
                      let item=model.relevantUserRequests.first(where:{ $0.requestId == id }) else { return }
                inboxDismissRequestId=nil
                Task { await model.resolveUserRequest(item,decision:"",dismiss:true) }
            }
            .disabled(model.userRequestsLoading)
            Button("取消",role:.cancel) { inboxDismissRequestId=nil }
        } message: {
            if let id=inboxDismissRequestId,
               let item=model.relevantUserRequests.first(where:{ $0.requestId == id }) {
                Text("“\(item.title)”将从待处理列表关闭，不会执行请求中的操作。")
            }
        }
    }

    private func inboxRequestRow(_ item:UserRequestDetail) -> some View {
        let editing = inboxDecisionRequestId == item.requestId
        let expanded = expandedInboxRequestIds.contains(item.requestId)
        return VStack(alignment:.leading,spacing:7) {
            HStack(alignment:.top,spacing:8) {
                Image(systemName:inboxActionIcon(item.actionRequired))
                    .font(.system(size:10.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:16,height:16)
                VStack(alignment:.leading,spacing:4) {
                    Text(item.title)
                        .font(.system(size:12,weight:.semibold))
                        .lineLimit(editing || expanded ? nil : 2)
                        .fixedSize(horizontal:false,vertical:editing || expanded)
                    Text(item.summary)
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(editing || expanded ? nil : 3)
                        .textSelection(.enabled)
                    if (item.summary.count > 80 || item.title.count > 44) && !editing {
                        Button(expanded ? "收起说明" : "查看完整说明") {
                            if !expandedInboxRequestIds.insert(item.requestId).inserted {
                                expandedInboxRequestIds.remove(item.requestId)
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(ForgePalette.secondary)
                        .accessibilityIdentifier("inbox.\(item.requestId).details")
                    }
                    HStack(spacing:8) {
                        Text(inboxActionLabel(item.actionRequired))
                        if item.targetRepoId == nil { Text("全局") }
                    }
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                }
                Spacer(minLength:4)
            }

            if editing {
                TextField(inboxDecisionPlaceholder(item.actionRequired),
                          text:$inboxDecision,axis:.vertical)
                    .lineLimit(2...4)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size:11))
                    .accessibilityIdentifier("inbox.\(item.requestId).decision")
                Text("此处只记录回复，不会代你完成登录、授权或其他操作。")
                    .font(.system(size:10)).foregroundStyle(.tertiary)

                HStack(spacing:10) {
                    Button("提交回复并关闭") {
                        let decision=inboxDecision
                        Task {
                            await model.resolveUserRequest(item,decision:decision)
                            if model.userRequestsError == nil {
                                inboxDecisionRequestId=nil
                                inboxDecision=""
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(inboxDecision.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || model.userRequestsLoading)
                    Button("忽略请求") { inboxDismissRequestId=item.requestId }
                        .buttonStyle(.plain)
                        .controlSize(.small)
                        .foregroundStyle(ForgePalette.secondary)
                        .disabled(model.userRequestsLoading)
                    Button("取消") {
                        inboxDecisionRequestId=nil
                        inboxDecision=""
                    }
                    .buttonStyle(.plain)
                    .controlSize(.small)
                    .foregroundStyle(ForgePalette.secondary)
                    Spacer()
                }
            } else {
                HStack {
                    Spacer()
                    Button(inboxHandleLabel(item.actionRequired)) {
                        inboxDecisionRequestId=item.requestId
                        inboxDecision=""
                    }
                    .buttonStyle(.plain)
                    .font(.system(size:10.5,weight:.medium))
                    .disabled(model.userRequestsLoading)
                    .accessibilityIdentifier("inbox.\(item.requestId).handle")
                }
            }
        }
        .padding(.vertical,10)
    }

    private func inboxHandleLabel(_ action:String) -> String {
        switch action {
        case "login": return "报告登录结果"
        case "grant_permission": return "报告授权结果"
        case "confirm_destructive": return "填写确认决定"
        case "product_decision": return "作出决定"
        default: return "填写处理结果"
        }
    }

    private func inboxDecisionPlaceholder(_ action:String) -> String {
        switch action {
        case "login": return "说明登录是否已完成"
        case "grant_permission": return "说明授权是否已完成"
        case "confirm_destructive": return "明确填写批准或拒绝及原因"
        default: return "填写你的决定或处理结果"
        }
    }

    private func inboxActionLabel(_ action:String) -> String {
        switch action {
        case "login": return "需要登录"
        case "grant_permission": return "需要授权"
        case "confirm_destructive": return "需要确认"
        default: return "需要决定"
        }
    }

    private func inboxActionIcon(_ action:String) -> String {
        switch action {
        case "login": return "person.crop.circle.badge.checkmark"
        case "grant_permission": return "key"
        case "confirm_destructive": return "exclamationmark.triangle"
        default: return "questionmark.circle"
        }
    }

    private func threadRow(_ thread: ChatThread) -> some View {
        let selected = model.selectedThreadId == thread.id && model.page == .agent
        let hovered = hoveredThreadId == thread.id
        let deleting = deleteThreadId == thread.id
        let refinementThread = model.isZenRefinementThread(thread.id)
        let running = model.activeConversationId == thread.id || refinementThread
        let protectedDuringRefinement = model.zenRefinementActive
            && (refinementThread || model.selectedThreadId == thread.id)
        let showDelete = hovered || deleting
        let projectLabel = model.projects.first(where: { $0.repoId == thread.repoId })?.label
            ?? thread.repoId.map { String($0.prefix(16)) }
            ?? "未绑定项目"
        let checkoutLabel = threadCheckoutLabel(thread)
        let accessibilityContext = [projectLabel,checkoutLabel,thread.checkoutId.map { "Checkout \($0)" },
                                    thread.hasUnsentContent ? "有未发送草稿" : nil,running ? "执行中" : nil]
            .compactMap { $0 }.joined(separator:" · ")

        return HStack(spacing:4) {
            Button {
                model.selectThread(thread.id)
                if model.showSearch { model.toggleConversationSearch() }
            } label: {
                HStack(spacing:7) {
                    VStack(alignment:.leading,spacing:1) {
                        Text(thread.title)
                            .font(.system(size:12,weight:selected ? .medium : .regular))
                            .lineLimit(1)
                        if let checkoutLabel {
                            Text(checkoutLabel)
                                .font(.system(size:9.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .frame(maxWidth:.infinity,alignment:.leading)
                    Spacer(minLength:0)
                    if thread.hasUnsentContent {
                        Text("草稿")
                            .font(.system(size:10,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                            .accessibilityLabel("有未发送草稿")
                    }
                    if running {
                        ProgressView().controlSize(.mini)
                            .accessibilityLabel("执行中")
                    }
                }
                .frame(maxWidth:.infinity,alignment:.leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled((model.busy && !running) || (model.zenRefinementActive && !refinementThread))
            .help(model.zenRefinementActive && !refinementThread
                ? "自动精化进行中，请先按 Esc 停止后再切换会话"
                : refinementThread ? "自动精化进行中" : accessibilityContext + " · " + thread.title)
            .accessibilityLabel(thread.title)
            .accessibilityValue(accessibilityContext)
            .accessibilityHint("打开此会话")
            .accessibilityIdentifier("sidebar.thread.\(thread.id)")
            .popover(isPresented:Binding(
                get:{ renameThreadId == thread.id },
                set:{ if !$0 && renameThreadId == thread.id { renameThreadId = nil } }
            ),arrowEdge:.trailing) {
                renameEditor(thread)
            }

            Button {
                guard !running else { return }
                deleteThreadId = thread.id
            } label: {
                Image(systemName:"trash")
                    .font(.system(size:10.5,weight:.medium))
                    .frame(width:24,height:24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(protectedDuringRefinement || running ? ForgePalette.secondary.opacity(0.35) : Color.red.opacity(0.78))
            .opacity(showDelete ? 1 : 0)
            .allowsHitTesting(showDelete && !protectedDuringRefinement && !running)
            .accessibilityHidden(!showDelete || protectedDuringRefinement || running)
            .accessibilityLabel("删除会话 \(thread.title)")
            .help(protectedDuringRefinement ? "自动精化进行中，请先按 Esc 停止后再删除" : running ? "请先停止正在运行的会话" : "删除会话")
            .popover(isPresented:Binding(
                get:{ deleteThreadId == thread.id },
                set:{ if !$0 && deleteThreadId == thread.id { deleteThreadId = nil } }
            ),arrowEdge:.trailing) {
                deleteConfirmation(thread)
            }
        }
        .padding(.leading,9).padding(.trailing,5)
        .frame(height:checkoutLabel == nil ? 32 : 40)
        .background(selected ? ForgePalette.selection.opacity(0.75) : (hovered ? ForgePalette.softFill.opacity(0.5) : .clear),
                    in:RoundedRectangle(cornerRadius:7,style:.continuous))
        .contentShape(RoundedRectangle(cornerRadius:7,style:.continuous))
        .onHover { inside in
            if inside {
                hoveredThreadId = thread.id
            } else if hoveredThreadId == thread.id {
                hoveredThreadId = nil
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration:0.12),value:hovered)
        .contextMenu {
            Button {
                renameThreadId = thread.id
                renameThreadTitle = thread.title
            } label: {
                Label("重命名",systemImage:"pencil")
            }
            Button {
                model.duplicateThread(thread.id)
            } label: {
                Label("复制会话",systemImage:"plus.square.on.square")
            }
            .disabled(running || model.zenRefinementActive)
            .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止后再复制会话" : "复制会话")
            Button {
                copyAgentText(thread.markdownTranscript)
            } label: {
                Label("复制会话为 Markdown",systemImage:"doc.on.doc")
            }
            .disabled(thread.messages.isEmpty)
            Button("删除会话…",role:.destructive) { deleteThreadId = thread.id }
                .disabled(protectedDuringRefinement || running)
        }
    }

    private var sidebarCheckoutLookupTargets: [String:[String]] {
        var contextsByRepo:[String:[String?]]=[:]
        for thread in sidebarThreadSections.flatMap(\.threads) {
            guard let repoId=thread.repoId else { continue }
            contextsByRepo[repoId,default:[]].append(thread.checkoutId)
        }
        var targets:[String:[String]] = [:]
        for (repoId,contexts) in contextsByRepo {
            let checkoutIds=Set(contexts.compactMap { $0 })
            let hasUnbound=contexts.contains { $0 == nil }
            guard checkoutIds.count > 1 || (hasUnbound && !checkoutIds.isEmpty) else { continue }
            targets[repoId]=checkoutIds.sorted()
        }
        return targets
    }

    private var sidebarCheckoutLookupKey: String {
        let targets=sidebarCheckoutLookupTargets
        let revision=model.projectRepositoryRefreshRevision
        let targetKey=targets.keys.sorted().map { repoId in
            "\(repoId):\((targets[repoId] ?? []).joined(separator:","))"
        }.joined(separator:"|")
        return "\(revision)|\(targetKey)"
    }

    private func threadCheckoutLabel(_ thread:ChatThread) -> String? {
        guard let repoId=thread.repoId else { return nil }
        let peers=sidebarThreadSections.flatMap(\.threads).filter { $0.repoId == repoId }
        let checkoutIds=Set(peers.compactMap { $0.checkoutId })
        let hasUnbound=peers.contains { $0.checkoutId == nil }
        guard checkoutIds.count > 1 || (hasUnbound && !checkoutIds.isEmpty) else { return nil }
        guard let checkoutId=thread.checkoutId else { return "未绑定工作区" }
        return sidebarCheckoutLabels["\(repoId)|\(checkoutId)"] ?? "工作区 · \(checkoutId.prefix(8))"
    }

    private func refreshSidebarCheckoutLabels() async {
        let targets=sidebarCheckoutLookupTargets
        sidebarCheckoutLabels=[:]
        for repoId in targets.keys.sorted() {
            guard !Task.isCancelled else { return }
            let checkoutIds=targets[repoId] ?? []
            do {
                let result=try await ForgeBridge.request("read_project_repository",["repoId":repoId])
                guard !Task.isCancelled else { return }
                let labels=NativeWorkspace.repositoryCheckoutLabels(
                    result,requestedCheckoutIds:checkoutIds
                )
                var updated=sidebarCheckoutLabels
                for checkoutId in checkoutIds {
                    updated["\(repoId)|\(checkoutId)"]=labels[checkoutId]
                        ?? "工作区不可用 · \(checkoutId.prefix(8))"
                }
                sidebarCheckoutLabels=updated
            } catch {
                guard !Task.isCancelled else { return }
                var updated=sidebarCheckoutLabels
                for checkoutId in checkoutIds {
                    updated["\(repoId)|\(checkoutId)"]="工作区信息不可用 · \(checkoutId.prefix(8))"
                }
                sidebarCheckoutLabels=updated
            }
        }
    }

    private var threadListEmptyState: some View {
        let searching = !model.search.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
        return VStack(spacing:7) {
            Image(systemName:searching ? "magnifyingglass" : "bubble.left.and.bubble.right")
                .font(.system(size:15))
                .foregroundStyle(ForgePalette.secondary.opacity(0.68))
            Text(searching ? "没有匹配的会话" : "暂无会话")
                .font(.system(size:11,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            if searching {
                Button("清除搜索") { model.search = "" }
                    .buttonStyle(.plain)
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.accent)
            }
        }
        .frame(maxWidth:.infinity)
        .padding(.vertical,18)
    }

    private func renameEditor(_ thread: ChatThread) -> some View {
        VStack(alignment:.leading,spacing:11) {
            HStack(spacing:8) {
                Image(systemName:"pencil")
                    .font(.system(size:11.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                Text("重命名会话")
                    .font(.system(size:13,weight:.semibold))
            }
            TextField("会话名称",text:$renameThreadTitle)
                .textFieldStyle(.roundedBorder)
                .font(.system(size:12))
                .onSubmit {
                    guard !renameThreadTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { return }
                    model.renameThread(thread.id,to:renameThreadTitle)
                    renameThreadId = nil
                }
            Text("名称仅用于本地会话列表。")
                .font(.system(size:10.5))
                .foregroundStyle(ForgePalette.secondary)
            HStack(spacing:8) {
                Spacer()
                Button("取消") { renameThreadId = nil }
                    .keyboardShortcut(.cancelAction)
                Button("保存") {
                    model.renameThread(thread.id,to:renameThreadTitle)
                    renameThreadId = nil
                }
                .keyboardShortcut(.defaultAction)
                .disabled(renameThreadTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .frame(width:270)
    }

    private func deleteConfirmation(_ thread: ChatThread) -> some View {
        VStack(alignment:.leading,spacing:11) {
            HStack(spacing:8) {
                Image(systemName:"trash.fill")
                    .font(.system(size:12,weight:.semibold))
                    .foregroundStyle(Color.red.opacity(0.82))
                Text("删除会话？")
                    .font(.system(size:13,weight:.semibold))
            }
            Text(thread.title)
                .font(.system(size:12,weight:.medium))
                .lineLimit(2)
            Text("仅删除这条本地记录，不影响项目、需求与计划或模型会话。")
                .font(.system(size:11))
                .foregroundStyle(ForgePalette.secondary)
                .fixedSize(horizontal:false,vertical:true)
            HStack(spacing:8) {
                Spacer()
                Button("取消") { deleteThreadId = nil }
                    .keyboardShortcut(.cancelAction)
                Button("删除",role:.destructive) {
                    model.deleteThread(thread.id)
                    deleteThreadId = nil
                }
                .disabled(model.isZenRefinementThread(thread.id)
                    || (model.zenRefinementActive && model.selectedThreadId == thread.id))
                .help(model.isZenRefinementThread(thread.id)
                    || (model.zenRefinementActive && model.selectedThreadId == thread.id)
                    ? "自动精化进行中，请先按 Esc 停止后再删除会话" : "删除本地会话记录")
            }
        }
        .padding(14)
        .frame(width:280)
    }

    private var isGlobalThreadSearch: Bool {
        model.showSearch
    }

    private var threadSections: [SidebarThreadSection] {
        let grouped = Dictionary(grouping:model.visibleThreads) { $0.repoId ?? "__unbound__" }
        return grouped.map { key, threads in
            let repoId = key == "__unbound__" ? nil : key
            let project = repoId.flatMap { id in model.projects.first(where: { $0.repoId == id }) }
            return SidebarThreadSection(
                id:key,
                title:project?.label ?? (repoId.map { String($0.prefix(18)) } ?? "未绑定项目"),
                repoId:repoId,
                threads:threads.sorted { $0.updatedAt > $1.updatedAt }
            )
        }.sorted { lhs, rhs in
            if lhs.repoId == model.repoId { return true }
            if rhs.repoId == model.repoId { return false }
            let left = lhs.threads.first?.updatedAt ?? .distantPast
            let right = rhs.threads.first?.updatedAt ?? .distantPast
            return left > right
        }
    }

    private var sidebarThreadSections: [SidebarThreadSection] {
        if isGlobalThreadSearch { return threadSections }

        let ordered=model.visibleThreads
        let currentRepoId=model.repoId
        let currentThreads=Array(ordered.filter { $0.repoId == currentRepoId }.prefix(12))
        var result:[SidebarThreadSection]=[]
        if !currentThreads.isEmpty {
            result.append(SidebarThreadSection(
                id:"__current__",
                title:"当前项目",
                repoId:currentRepoId,
                threads:currentThreads
            ))
        }

        var seenProjects=Set<String>()
        var recentOther:[ChatThread]=[]
        for thread in ordered where thread.repoId != currentRepoId {
            let key=thread.repoId ?? "__unbound__"
            guard seenProjects.insert(key).inserted else { continue }
            recentOther.append(thread)
            if recentOther.count == 5 { break }
        }
        if !recentOther.isEmpty {
            result.append(SidebarThreadSection(
                id:"__recent-other__",
                title:"其他项目",
                repoId:nil,
                threads:recentOther
            ))
        }
        return result
    }

    private func projectConversationCount(_ repoId:String) -> Int {
        model.threads.filter { $0.repoId == repoId }.count
    }

    private func projectLastActivity(_ repoId:String) -> Date {
        model.threads
            .filter { $0.repoId == repoId }
            .map(\.updatedAt)
            .max() ?? .distantPast
    }

    private var filteredProjects: [ForgeProject] {
        let needle = projectSearch.trimmingCharacters(in:.whitespacesAndNewlines)
        let candidates = needle.isEmpty ? model.projects : model.projects.filter {
            $0.label.localizedCaseInsensitiveContains(needle)
                || $0.displayName.localizedCaseInsensitiveContains(needle)
                || ($0.localRoot?.localizedCaseInsensitiveContains(needle) ?? false)
        }
        return candidates.sorted { lhs,rhs in
            if lhs.repoId == model.repoId { return true }
            if rhs.repoId == model.repoId { return false }
            let leftActivity=projectLastActivity(lhs.repoId)
            let rightActivity=projectLastActivity(rhs.repoId)
            if leftActivity != rightActivity { return leftActivity > rightActivity }
            return lhs.label.localizedStandardCompare(rhs.label) == .orderedAscending
        }
    }

    private var projectSwitcherSummary: String {
        if model.projectsLoading && model.projects.isEmpty { return "正在加载项目…" }
        if model.projectsError != nil && model.projects.isEmpty { return "项目列表加载失败" }
        if model.projects.isEmpty { return "暂无已注册项目" }
        return model.checkoutBranch ?? "选择工作区"
    }

    private var projectSwitcher: some View {
        Button {
            projectPickerShown.toggle()
            if !projectPickerShown { projectSearch = "" }
        } label: {
            HStack(spacing:9) {
                Image(systemName:"folder.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:13))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:20)
                VStack(alignment:.leading,spacing:2) {
                    Text(model.project?.label ?? "选择代码工作区")
                        .font(.system(size:12,weight:.semibold))
                        .lineLimit(1)
                    Text(projectSwitcherSummary)
                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName:"chevron.up.chevron.down").font(.system(size:10))
            }
            .padding(.horizontal,9).frame(height:42)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("代码仓库与 checkout；产品项目和任务在工作台管理")
        .accessibilityLabel("代码工作区：\(model.project?.label ?? "未选择")")
        .popover(isPresented:$projectPickerShown,arrowEdge:.trailing) {
            projectPicker
        }
    }

    private var projectPicker: some View {
        VStack(alignment:.leading,spacing:10) {
            HStack {
                VStack(alignment:.leading,spacing:2) {
                    Text("代码仓库与工作区").font(.system(size:14,weight:.semibold))
                    Text("选择仓库及其 checkout；产品项目在工作台管理。")
                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { Task { await model.refresh() } } label: {
                    if model.projectsLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName:"arrow.clockwise")
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.projectsLoading)
                .accessibilityLabel(model.projectsLoading ? "正在加载项目" : "刷新项目列表")
                .help(model.projectsLoading ? "正在加载项目列表" : "刷新项目列表")
            }

            HStack(spacing:7) {
                Image(systemName:"magnifyingglass")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                TextField("搜索项目或路径",text:$projectSearch)
                    .textFieldStyle(.plain).font(.system(size:12))
            }
            .padding(.horizontal,9).frame(height:32)
            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))

            ScrollView {
                LazyVStack(spacing:4) {
                    if let projectError = model.projectsError, !model.projects.isEmpty {
                        Text("无法更新项目列表，仍显示上次加载的项目")
                            .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                            .help(projectError)
                            .accessibilityHint(projectError)
                            .lineLimit(2)
                            .frame(maxWidth:.infinity,alignment:.leading)
                            .padding(.horizontal,8)
                    }
                    if model.projectsLoading && model.projects.isEmpty {
                        HStack(spacing:8) {
                            ProgressView().controlSize(.small)
                            Text("正在加载项目…")
                                .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                        }
                        .frame(maxWidth:.infinity,minHeight:76)
                    } else if model.projects.isEmpty, let projectError = model.projectsError {
                        Text("无法加载项目列表，请重试")
                            .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                            .help(projectError)
                            .accessibilityHint(projectError)
                            .frame(maxWidth:.infinity,minHeight:76)
                            .padding(.horizontal,12)
                    } else if filteredProjects.isEmpty {
                        Text(model.projects.isEmpty ? "暂无已注册项目" : "没有匹配的项目")
                            .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                            .frame(maxWidth:.infinity,minHeight:76)
                    }
                    ForEach(filteredProjects) { project in
                        VStack(spacing:3) {
                            HStack(spacing:6) {
                                Button {
                                    guard !model.zenMode || model.canSwitchZenProject else {
                                        model.focusZenProject(project.repoId)
                                        return
                                    }
                                    if model.zenMode {
                                        model.focusZenProject(project.repoId)
                                    } else {
                                        model.openProject(project.repoId)
                                    }
                                    projectPickerShown = false
                                    projectSearch = ""
                                } label: {
                                    HStack(spacing:9) {
                                        Image(systemName:project.repoId == model.repoId ? "folder.fill" : "folder")
                                            .symbolRenderingMode(.hierarchical)
                                            .frame(width:18)
                                        VStack(alignment:.leading,spacing:2) {
                                            Text(project.label)
                                                .font(.system(size:11.5,weight:.medium)).lineLimit(1)
                                            HStack(spacing:6) {
                                                Text(project.localRoot ?? project.defaultBranch ?? project.repoId)
                                                    .lineLimit(1).truncationMode(.middle)
                                                let count=projectConversationCount(project.repoId)
                                                if count > 0 { Text("· \(count) 会话").lineLimit(1) }
                                            }
                                            .font(.system(size:9.5))
                                            .foregroundStyle(ForgePalette.secondary)
                                        }
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(model.busy || model.zenRefinementActive)
                                .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止后再切换项目" : "切换到此项目")
                                if !model.zenMode {
                                    Button {
                                        model.newThread(inProject:project.repoId)
                                        projectPickerShown = false
                                        projectSearch = ""
                                    } label: {
                                        Image(systemName:"plus")
                                            .font(ForgeClientDesign.Shell.control.weight(.semibold))
                                            .frame(width:25,height:25)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : "在当前项目新建会话")
                                    .disabled(model.busy || model.zenRefinementActive)
                                }
                                Button {
                                    toggleProjectCheckouts(project.repoId)
                                } label: {
                                    Image(systemName:expandedProjectRepoId == project.repoId ? "chevron.up" : "chevron.down")
                                        .font(.system(size:10,weight:.medium))
                                        .frame(width:24,height:25)
                                }
                                .buttonStyle(.plain)
                                .help("展开项目的工作区")
                                .accessibilityIdentifier("project.checkouts.\(project.repoId)")
                            }
                            .padding(.horizontal,8).frame(height:46)
                            .background(project.repoId == model.repoId ? ForgePalette.selection : .clear,
                                        in:RoundedRectangle(cornerRadius:10,style:.continuous))

                            if expandedProjectRepoId == project.repoId {
                                if projectCheckoutsLoading {
                                    ProgressView().controlSize(.small).padding(.vertical,10)
                                } else if let projectCheckoutError {
                                    Text(projectCheckoutError)
                                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                                        .padding(.horizontal,14).padding(.vertical,7)
                                } else {
                                    ForEach(expandedProjectCheckouts) { checkout in
                                        HStack(spacing:4) {
                                            Button {
                                                if model.zenMode {
                                                    guard model.canSwitchZenProject else {
                                                         model.focusZenProject(project.repoId,requestedCheckoutId:checkout.id)
                                                         return
                                                     }
                                                     model.focusZenProject(project.repoId,requestedCheckoutId:checkout.id)
                                                } else {
                                                    model.openCheckout(inProject:project.repoId,checkoutId:checkout.id)
                                                }
                                                projectPickerShown = false
                                                projectSearch = ""
                                            } label: {
                                                HStack(spacing:8) {
                                                    Image(systemName:checkout.worktree ? "arrow.triangle.branch" : "house")
                                                        .font(.system(size:10))
                                                    VStack(alignment:.leading,spacing:2) {
                                                        HStack(spacing:5) {
                                                            Text(checkout.branch ?? "未关联分支")
                                                                .font(.system(size:10.5,weight:.medium))
                                                            if checkout.active {
                                                                Text("默认").font(.system(size:9))
                                                                    .foregroundStyle(ForgePalette.secondary)
                                                            }
                                                        }
                                                        Text(checkout.path)
                                                            .font(.system(size:9))
                                                            .lineLimit(1).truncationMode(.middle)
                                                            .foregroundStyle(ForgePalette.secondary)
                                                    }
                                                    Spacer()
                                                    if project.repoId == model.repoId && checkout.id == model.checkoutId {
                                                        Image(systemName:"checkmark").font(.system(size:10))
                                                    }
                                                }
                                                .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain)
                                            .disabled(model.busy || model.zenRefinementActive)
                                            .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止后再切换工作区" : "切换到此工作区")
                                            if !model.zenMode {
                                                Button {
                                                    model.newThread(inProject:project.repoId,checkoutId:checkout.id)
                                                    projectPickerShown = false
                                                    projectSearch = ""
                                                } label: {
                                                    Image(systemName:"plus")
                                                        .font(.system(size:10,weight:.medium))
                                                        .frame(width:24,height:24)
                                                }
                                                .buttonStyle(.plain)
                                                .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : "在此工作区新建会话")
                                                .disabled(model.busy || model.zenRefinementActive)
                                            }
                                        }
                                        .padding(.leading,21).padding(.trailing,10)
                                        .frame(height:39)
                                        .accessibilityIdentifier("project.checkout.\(checkout.id)")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .frame(height:260)

            Divider()
            Button {
                chooseProjectDirectory(keepZen:model.zenMode)
            } label: {
                HStack(spacing:8) {
                    if registeringProject {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName:"folder.badge.plus")
                    }
                    Text(registeringProject ? "正在添加…" : "添加本地项目…")
                    Spacer()
                }
                .font(.system(size:11.5,weight:.medium))
            }
            .buttonStyle(.plain)
            .disabled(registeringProject || model.busy)
        }
        .padding(14).frame(width:380)
    }

    private func toggleProjectCheckouts(_ targetRepoId:String) {
        if expandedProjectRepoId == targetRepoId {
            projectCheckoutsRequestGeneration &+= 1
            expandedProjectRepoId = nil
            expandedProjectCheckouts = []
            projectCheckoutError = nil
            projectCheckoutsLoading = false
            return
        }
        projectCheckoutsRequestGeneration &+= 1
        let requestGeneration = projectCheckoutsRequestGeneration
        expandedProjectRepoId = targetRepoId
        expandedProjectCheckouts = []
        projectCheckoutError = nil
        projectCheckoutsLoading = true
        Task {
            defer {
                if NativeWorkspace.projectCheckoutRequestIsCurrent(
                    requestGeneration:requestGeneration,
                    currentGeneration:projectCheckoutsRequestGeneration,
                    requestedRepoId:targetRepoId,
                    expandedRepoId:expandedProjectRepoId
                ) { projectCheckoutsLoading = false }
            }
            do {
                let value = try await ForgeBridge.request("read_project_repository",["repoId":targetRepoId])
                guard NativeWorkspace.projectCheckoutRequestIsCurrent(
                    requestGeneration:requestGeneration,
                    currentGeneration:projectCheckoutsRequestGeneration,
                    requestedRepoId:targetRepoId,
                    expandedRepoId:expandedProjectRepoId
                ) else { return }
                expandedProjectCheckouts = ProjectCheckoutChoice.fromRepository(value)
                if expandedProjectCheckouts.isEmpty {
                    projectCheckoutError = "此仓库没有可用的 Checkout。"
                }
            } catch {
                guard NativeWorkspace.projectCheckoutRequestIsCurrent(
                    requestGeneration:requestGeneration,
                    currentGeneration:projectCheckoutsRequestGeneration,
                    requestedRepoId:targetRepoId,
                    expandedRepoId:expandedProjectRepoId
                ) else { return }
                projectCheckoutError = error.localizedDescription
            }
        }
    }

    private func chooseProjectDirectory(keepZen: Bool = false) {
        let panel = NSOpenPanel()
        panel.title = "添加 Forge 项目"
        panel.prompt = "添加"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        registeringProject = true
        Task {
            let ok = await model.registerProject(path:url.path,openConversation: !keepZen)
            registeringProject = false
            if ok {
                projectPickerShown = false
                projectSearch = ""
            }
        }
    }

    private var pageRefreshIsLoading: Bool {
        model.settingsLoading || model.schedulesLoading || model.pluginsLoading
    }

    private var pageRefreshIsDisabled: Bool {
        pageRefreshIsLoading || ((model.page == .schedule || model.page == .plugins) && model.repoId == nil)
    }

    private var pageRefreshHelp: String {
        switch model.page {
        case .settings: return "刷新设置与服务状态"
        case .schedule: return "刷新计划任务"
        case .plugins: return "刷新插件"
        default: return "刷新真实 Forge 状态"
        }
    }

    private var pageRefreshAccessibilityLabel: String {
        pageRefreshIsLoading ? "页面操作进行中" : pageRefreshHelp
    }

    private func refreshCurrentPage() {
        let page = model.page
        Task {
            switch page {
            case .settings: await model.loadSettingsPage()
            case .schedule: await model.loadSchedulePage()
            case .plugins: await model.loadPluginsPage()
            default: await model.refresh()
            }
        }
    }

    private var main: some View {
        VStack(spacing:0) {
            if let error = model.error, model.page != .schedule && model.page != .plugins {
                HStack(spacing:9) {
                    Image(systemName:"exclamationmark.circle")
                    Text(error)
                        .lineLimit(4)
                        .fixedSize(horizontal:false,vertical:true)
                        .textSelection(.enabled)
                    Spacer()
                    Button("关闭") { model.error = nil }.buttonStyle(.plain)
                }
                .font(.system(size:11))
                .foregroundStyle(Color.orange)
                .padding(.horizontal,12).padding(.vertical,9)
                .frame(minHeight:38)
                .background(Color.orange.opacity(0.10),
                            in:RoundedRectangle(cornerRadius:9,style:.continuous))
                .padding(.horizontal,14).padding(.top,8)
            }
            switch model.page {
            case .agent:
                AgentPane(
                    model:model,
                    onChooseProject:{ projectPickerShown = true },
                    selectedWorkSurfaceRaw:$selectedWorkSurfaceRaw,
                    workSurfaceVisible:$workSurfaceVisible,
                    workSurfaceMaximized:$workSurfaceMaximized,
                    semanticInspector:$agentSemanticInspector
                )
            case .requirement,.plan: RecordsPane(model:model)
            case .schedule: SchedulePane(model:model)
            case .plugins: PluginsPane(model:model)
            case .knowledge: KnowledgePane(model:model)
            case .assets:
                AgentAssetsDashboard(
                    model:model,
                    selectedRepoId:$assetsSelectedRepoId,
                    showLocalResources:$assetsShowLocalResources,
                    showRemoteImages:$assetsShowRemoteImages,
                    searchQuery:$assetsSearchQuery,
                    selectedResourceID:$assetsReturnResourceID
                )
            case .usage:
                AgentUsageDashboard(
                    model:model,
                    days:$usageDays,
                    selectedProjectId:$usageSelectedProjectId,
                    selectedProviderId:$usageSelectedProviderId,
                    selectedEntryID:$usageReturnEntryID
                )
            case .settings: SettingsPane(model:model)
            }
        }
        .background(ForgePalette.canvas)
    }
}
