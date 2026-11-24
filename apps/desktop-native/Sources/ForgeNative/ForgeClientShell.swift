import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct ForgeWorkspaceView: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    // Restore the last tab, but open every new window with the inspector closed.
    @SceneStorage("forge.shell.v5.surface.tab") private var selectedWorkSurfaceRaw = "changes"
    @State private var workSurfaceVisible = false
    @State private var workSurfaceMaximized = false
    @SceneStorage("forge.shell.v5.rail") private var primaryRailRaw = "agent"

    var body: some View {
        GeometryReader { geometry in
        HStack(spacing:6) {
            unifiedSidebar
                .frame(width:ForgeClientDesign.Shell.sidebarWidth(windowWidth:geometry.size.width))
                .padding(.leading,6)
                .padding(.bottom,6)
                .background(Color.clear)

            Group {
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
            .padding(.trailing,6)
            .padding(.bottom,6)
            .forgePanelGlass(cornerRadius:18)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
        }
        .forgeWindowMaterial()
        .toolbar {
            ToolbarItemGroup(placement:.automatic) {
                unifiedWindowToolbarActions
            }
        }
        // Hide the toolbar fill so traffic lights sit on the same surface as content.
        .toolbarBackground(.hidden, for:.windowToolbar)
        .task {
            if model.zenMode { model.show(.requirement) }
        }
        .onChange(of:model.showSearch) { visible in
            sidebarSearchFocused = visible
        }
        .onChange(of:model.repoId) { _ in
            Task { await model.loadUserRequests() }
        }
        .onChange(of:model.zenMode) { zen in
            if zen {
                primaryRailRaw = ForgeSidebarDestination.workbench.rawValue
            } else if primaryRailRaw == ForgeSidebarDestination.workbench.rawValue
                        || primaryRailRaw == ForgeSidebarDestination.projects.rawValue {
                primaryRailRaw = ForgeSidebarDestination.resolve(zenMode:false,page:model.page).rawValue
            }
        }
        .onChange(of:model.page) { page in
            guard primaryRailRaw != ForgeSidebarDestination.projects.rawValue else { return }
            primaryRailRaw = ForgeSidebarDestination.resolve(zenMode:model.zenMode,page:page).rawValue
        }
    }

    @ViewBuilder
    private var unifiedWindowToolbarActions: some View {
        if model.canNavigateBack {
            Button { model.goBack() } label: {
                ForgeGlyph(.back)
                    .forgeChromeSurface(cornerRadius:8)
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            .help("返回 \(model.navigationBackLabel ?? "上一页")")
            .accessibilityLabel("返回上一页")
            .accessibilityIdentifier("forge.toolbar.back")
        }
    }

    private var activeSidebarDestination: ForgeSidebarDestination {
        if primaryRailRaw == ForgeSidebarDestination.projects.rawValue {
            return .projects
        }
        return ForgeSidebarDestination.resolve(zenMode:model.zenMode,page:model.page)
    }

    private func openSidebarDestination(_ destination:ForgeSidebarDestination) {
        primaryRailRaw = destination.rawValue
        switch destination {
        case .projects:
            // List column shows projects; keep current main surface mounted.
            return
        case .workbench:
            model.openWorkbench()
        case .agent:
            model.show(.agent)
        case .automations:
            model.show(.schedule)
        case .resources:
            model.show(.assets)
        case .analytics:
            model.show(.usage)
        case .settings:
            model.show(.settings)
        }
    }

    private func sidebarDestinationButton(_ destination:ForgeSidebarDestination) -> some View {
        let selected = activeSidebarDestination == destination
        return Button {
            openSidebarDestination(destination)
        } label: {
            Image(systemName:destination.railSystemImage)
                .font(.system(size:ForgeClientDesign.Icon.railPoint,weight:.regular))
                .symbolRenderingMode(.monochrome)
                .foregroundStyle(selected ? ForgePalette.ink : ForgePalette.secondary)
                .frame(width:32,height:32)
                .contentShape(RoundedRectangle(cornerRadius:8,style:.continuous))
                .forgeChromeSurface(selected:selected,cornerRadius:8)
                .frame(width:34,height:ForgeClientDesign.Shell.destinationRowHeight)
        }
        .buttonStyle(.plain)
        .help(destination.title)
        .accessibilityLabel(destination.title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("forge.nav.\(destination.rawValue)")
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
            .contentShape(RoundedRectangle(cornerRadius:8,style:.continuous))
            .forgeChromeSurface(selected:selected,cornerRadius:8)
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
                Text("设置").font(.system(size:11,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.leading,11).padding(.top,10).padding(.bottom,2)
                utilitySidebarButton("模型与运行时",icon:"cpu",page:.settings)
                utilitySidebarButton("项目插件",icon:"puzzlepiece",page:.plugins)
            }
        }
        .padding(.horizontal,10)
        .padding(.bottom,4)
    }

    private var iconRail: some View {
        VStack(spacing:3) {
            ForEach(ForgeSidebarDestination.primaryRail, id: \.self) { destination in
                sidebarDestinationButton(destination)
            }
            Color.clear.frame(height:4)
            ForEach(ForgeSidebarDestination.toolRail, id: \.self) { destination in
                sidebarDestinationButton(destination)
            }
            Spacer(minLength:0)
            sidebarDestinationButton(.settings)
        }
        .padding(.top,4)
        .padding(.bottom,8)
        .frame(width:ForgeClientDesign.Shell.iconRailWidth)
        .frame(maxHeight:.infinity)
        .background(ForgePalette.railTint)
        .accessibilityElement(children:.contain)
        .accessibilityIdentifier("forge.navigation.rail")
    }

    private var listColumn: some View {
        VStack(alignment:.leading,spacing:0) {
            projectSwitcher
                .padding(.horizontal,10)
                .frame(height:ForgeClientDesign.Shell.workspaceHeaderHeight)

            // Keep contextual panes mounted across destination changes so
            // conversation search, thread scroll, and Zen state survive.
            ZStack(alignment:.topLeading) {
                projectsListColumn
                    .opacity(activeSidebarDestination == .projects ? 1 : 0)
                    .allowsHitTesting(activeSidebarDestination == .projects)
                    .accessibilityHidden(activeSidebarDestination != .projects)

                ZenSidebar(model:model,screen:$model.zenScreen,
                           focusedRequirementId:$model.zenFocusedRequirementId,
                           decisionCount:model.relevantUserRequests.count,
                           onInbox:{
                    inboxShown = true
                    Task { await model.loadUserRequests() }
                })
                .opacity(activeSidebarDestination == .workbench ? 1 : 0)
                .allowsHitTesting(activeSidebarDestination == .workbench)
                .accessibilityHidden(activeSidebarDestination != .workbench)
                .popover(isPresented:$inboxShown,arrowEdge:.trailing) {
                    inboxPanel
                }

                VStack(alignment:.leading,spacing:0) {
                    // Utility destinations show their own section nav, not the
                    // conversation list (which belongs to 会话 only).
                    if activeSidebarDestination == .agent {
                        sidebar
                    } else if activeSidebarDestination != .projects
                                && activeSidebarDestination != .workbench {
                        contextualSidebar
                        Spacer(minLength:0)
                    }
                }
                .opacity(activeSidebarDestination == .projects || activeSidebarDestination == .workbench ? 0 : 1)
                .allowsHitTesting(!(activeSidebarDestination == .projects || activeSidebarDestination == .workbench))
                .accessibilityHidden(activeSidebarDestination == .projects || activeSidebarDestination == .workbench)
            }
            .frame(maxWidth:.infinity,maxHeight:.infinity)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        .background(ForgePalette.listTint)
    }

    private var unifiedSidebar: some View {
        // Column 1: icon rail. Column 2: sessions / projects / board list.
        HStack(spacing:0) {
            iconRail
            listColumn
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        .forgePanelGlass(cornerRadius:18, material:.underWindowBackground)
    }

    private var projectsListColumn: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:6) {
                Text("项目")
                    .font(.system(size:11.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer(minLength:0)
                Button { Task { await model.refresh() } } label: {
                    if model.projectsLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName:"arrow.clockwise")
                            .font(.system(size:11,weight:.regular))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.projectsLoading)
                .help("刷新项目列表")
                .accessibilityLabel("刷新项目列表")
            }
            .padding(.horizontal,12)
            .frame(height:30)
            .padding(.top,4).padding(.bottom,2)

            HStack(spacing:7) {
                Image(systemName:"magnifyingglass")
                    .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                TextField("搜索项目或路径",text:$projectSearch)
                    .textFieldStyle(.plain).font(.system(size:11.5))
            }
            .padding(.horizontal,9).frame(height:28)
            .background(ForgePalette.inputFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
            .padding(.horizontal,10)
            .padding(.bottom,6)

            ScrollView {
                LazyVStack(spacing:2) {
                    if filteredProjects.isEmpty {
                        Text(model.projects.isEmpty ? "暂无已注册项目" : "没有匹配的项目")
                            .font(.system(size:11))
                            .foregroundStyle(ForgePalette.secondary)
                            .frame(maxWidth:.infinity,minHeight:80)
                    }
                    ForEach(filteredProjects) { project in
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
                            projectSearch = ""
                        } label: {
                            HStack(spacing:8) {
                                Image(systemName:project.repoId == model.repoId ? "folder.fill" : "folder")
                                    .font(.system(size:11.5,weight:.regular))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .frame(width:15)
                                VStack(alignment:.leading,spacing:1) {
                                    Text(project.label)
                                        .font(.system(size:11.25,weight:project.repoId == model.repoId ? .medium : .regular))
                                        .lineLimit(1)
                                    Text(project.localRoot ?? project.defaultBranch ?? project.repoId)
                                        .font(.system(size:9.25))
                                        .foregroundStyle(ForgePalette.secondary.opacity(0.82))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer(minLength:0)
                            }
                            .padding(.horizontal,9)
                            .frame(height:40)
                            .contentShape(RoundedRectangle(cornerRadius:8,style:.continuous))
                            .forgeChromeSurface(selected:project.repoId == model.repoId,cornerRadius:8)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy || model.zenRefinementActive)
                        .padding(.horizontal,8)
                    }
                }
                .padding(.bottom,12)
            }
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        .accessibilityIdentifier("forge.list.projects")
    }

    private var sidebar: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:2) {
                Text("会话")
                    .font(ForgeClientDesign.Shell.sidebarTitle)
                    .foregroundStyle(ForgePalette.secondary.opacity(0.90))
                    .lineLimit(1)
                Spacer(minLength:0)

                Button {
                    guard !model.zenRefinementActive else { return }
                    model.show(.agent)
                    model.newThread()
                } label: {
                    ForgeGlyph(.compose)
                        .forgeChromeSurface(cornerRadius:8)
                }
                .buttonStyle(.plain)
                .disabled(model.busy || model.zenRefinementActive)
                .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : "新会话 (⌘N)")
                .accessibilityLabel("新会话")
                .accessibilityIdentifier("sidebar.thread.new")

                Button { model.toggleConversationSearch() } label: {
                    ForgeGlyph(model.showSearch ? .close : .search, active:model.showSearch)
                        .forgeChromeSurface(selected:model.showSearch,cornerRadius:8)
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
                        ForgeGlyph(.inbox, active:inboxShown)
                        if !model.relevantUserRequests.isEmpty {
                            let visibleCount = model.relevantUserRequests.count
                            let exactCount = model.userRequestsTotalCount
                            Text(exactCount.map { $0 > 99 ? "99+" : "\($0)" }
                                 ?? "\(min(visibleCount,99))+")
                                .font(.system(size:8,weight:.semibold))
                                .padding(.horizontal,3).frame(minWidth:13,minHeight:13)
                                .background(Capsule().fill(Color.white.opacity(0.12)))
                                .foregroundStyle(ForgePalette.ink.opacity(0.88))
                                .offset(x:2,y:0)
                        }
                    }
                    .contentShape(Rectangle())
                    .forgeChromeSurface(selected:inboxShown,cornerRadius:8)
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
            .padding(.leading,10).padding(.trailing,6)
            .frame(height:ForgeClientDesign.Icon.hit)
            .padding(.top,2).padding(.bottom,2)

            if model.showSearch {
                HStack(spacing:7) {
                    Image(systemName:"magnifyingglass")
                        .font(.system(size:11,weight:.medium))
                        .foregroundStyle(ForgePalette.secondary.opacity(0.72))
                        .accessibilityHidden(true)
                    TextField("搜索会话",text:$model.search)
                        .focused($sidebarSearchFocused)
                        .textFieldStyle(.plain)
                        .font(.system(size:11.75))
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
                .padding(.horizontal,10)
                .frame(height:30)
                .background(ForgePalette.inputFill,in:RoundedRectangle(cornerRadius:11,style:.continuous))
                .forgeFloatingGlass(cornerRadius:11)
                .padding(.horizontal,10).padding(.bottom,5)
            }

            ScrollView {
                LazyVStack(alignment:.leading,spacing:2) {
                    if model.visibleThreads.isEmpty {
                        threadListEmptyState
                    } else {
                        ForEach(sidebarThreadSections) { section in
                            HStack(spacing:6) {
                                Text(section.title)
                                    .font(ForgeClientDesign.Shell.threadSectionTitle)
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
                            .padding(.leading,10).padding(.trailing,5)
                            .padding(.top,ForgeClientDesign.Shell.threadSectionSpacing)
                            ForEach(section.threads) { thread in
                                threadRow(thread)
                            }
                        }
                    }
                }.padding(.horizontal,10)
            }
            .scrollIndicators(.hidden)
            .task(id:sidebarCheckoutLookupKey) { await refreshSidebarCheckoutLabels() }
            .padding(.top,4)
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
                if model.page != .agent { model.show(.agent) }
                if model.showSearch { model.toggleConversationSearch() }
            } label: {
                HStack(spacing:6) {
                    Text(thread.title)
                        .font(selected ? ForgeClientDesign.Shell.threadTitleSelected
                                       : ForgeClientDesign.Shell.threadTitle)
                        .lineLimit(1)
                        .frame(maxWidth:.infinity,alignment:.leading)
                    if running {
                        ProgressView().controlSize(.mini)
                            .accessibilityHidden(true)
                    } else if thread.hasUnsentContent {
                        Circle()
                            .fill(ForgePalette.secondary)
                            .frame(width:5,height:5)
                            .padding(.horizontal,3)
                            .accessibilityHidden(true)
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
            .accessibilityAddTraits(selected ? [.isSelected] : [])
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
                    .frame(width:ForgeClientDesign.Shell.threadActionWidth,height:24)
                    .contentShape(Rectangle())
                    .forgeChromeSurface(selected:deleting,cornerRadius:6)
            }
            .buttonStyle(.plain)
            .foregroundStyle(protectedDuringRefinement || running ? ForgePalette.secondary.opacity(0.35) : deleting ? Color.red : ForgePalette.secondary)
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
        .padding(.leading,8).padding(.trailing,4)
        .frame(height:ForgeClientDesign.Shell.threadRowHeight)
        .background(selected ? ForgePalette.selection : (hovered ? ForgePalette.softFill : .clear),
                    in:RoundedRectangle(cornerRadius:9,style:.continuous))
        .contentShape(RoundedRectangle(cornerRadius:9,style:.continuous))
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
            HStack(spacing:5) {
                Image(systemName:"folder")
                    .font(.system(size:11.5,weight:.medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(ForgePalette.secondary.opacity(0.82))
                HStack(spacing:5) {
                    Text(model.project?.label ?? "选择代码工作区")
                        .font(.system(size:11.75,weight:.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(2)
                    if let branch = model.checkoutBranch, model.project != nil {
                        Text(branch)
                            .font(.system(size:10.25,weight:.regular,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary.opacity(0.66))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .layoutPriority(0)
                    }
                }
                .layoutPriority(1)
                Spacer(minLength:4)
                Image(systemName:"chevron.down")
                    .font(.system(size:7.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary.opacity(0.48))
            }
            .padding(.horizontal,9)
            .frame(height:30)
            .background(ForgePalette.inputFill,
                        in:RoundedRectangle(cornerRadius:11,style:.continuous))
            .forgeFloatingGlass(cornerRadius:11)
            .contentShape(RoundedRectangle(cornerRadius:11,style:.continuous))
        }
        .buttonStyle(.plain)
        .help(model.project == nil
              ? "选择代码仓库与 checkout"
              : "\(model.project?.label ?? "") · \(projectSwitcherSummary)")
        .accessibilityLabel("代码工作区：\(model.project?.label ?? "未选择")")
        .accessibilityValue(projectSwitcherSummary)
        .accessibilityIdentifier("forge.workspace.switcher")
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
            .background(ForgePalette.inputFill,in:RoundedRectangle(cornerRadius:10,style:.continuous))

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

    private var main: some View {
        VStack(spacing:0) {
            if let error = model.error, model.page != .schedule && model.page != .plugins {
                HStack(spacing:7) {
                    Image(systemName:"exclamationmark.circle")
                        .font(.system(size:10.5,weight:.medium))
                    Text(error)
                        .font(.system(size:10.5))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(error)
                    Spacer(minLength:8)
                    Button { model.error = nil } label: {
                        Image(systemName:"xmark")
                            .font(.system(size:9,weight:.semibold))
                            .frame(width:22,height:22)
                    }
                    .buttonStyle(.plain)
                    .help("关闭")
                    .accessibilityLabel("关闭错误提示")
                }
                .foregroundStyle(Color.orange.opacity(0.92))
                .padding(.horizontal,10)
                .frame(height:30)
                .background(Color.orange.opacity(0.065),
                            in:RoundedRectangle(cornerRadius:8,style:.continuous))
                .padding(.horizontal,10).padding(.top,4)
            }
            switch model.page {
            case .agent:
                AgentPane(
                    model:model,
                    onChooseProject:{ projectPickerShown = true },
                    selectedWorkSurfaceRaw:$selectedWorkSurfaceRaw,
                    workSurfaceVisible:$workSurfaceVisible,
                    workSurfaceMaximized:$workSurfaceMaximized
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
