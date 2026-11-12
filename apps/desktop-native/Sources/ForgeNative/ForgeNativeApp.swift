import SwiftUI
import AppKit
import UniformTypeIdentifiers

func shellQuotedMcpPath(_ path:String) -> String {
    "'" + path.replacingOccurrences(of:"'",with:"'\\''") + "'"
}

// Native visual contract: content first, icon-only secondary actions, quiet selection,
// one consistent input surface; avoid decorative cards around navigation and status.
private enum ForgePalette {
    static let canvas = Color(nsColor:.textBackgroundColor)
    static let ink = Color.primary
    static let secondary = Color(nsColor:.secondaryLabelColor)
    static let accent = Color(nsColor:NSColor(name:nil) { appearance in
        appearance.bestMatch(from:[.darkAqua,.aqua]) == .darkAqua
            ? NSColor.controlAccentColor
            : NSColor.labelColor
    })
    static let selection = Color.primary.opacity(0.072)
    static let selectionStrong = Color.primary.opacity(0.095)
    static let userBubble = Color.primary.opacity(0.055)
    static let raisedSurface = Color(nsColor:.controlBackgroundColor)
    static let softFill = Color.primary.opacity(0.045)
    static let composer = Color(nsColor:.controlBackgroundColor).opacity(0.95)
}

@main
struct ForgeNativeApp: App {
    @StateObject private var workspace = NativeWorkspace()

    var body: some Scene {
        WindowGroup("Forge") {
            ForgeWorkspaceView(model: workspace)
                .frame(minWidth:860,minHeight:570)
                .tint(ForgePalette.accent)
                .task { await workspace.refresh() }
        }
        .defaultSize(width:1260,height:790)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing:.newItem) {
                Button("新会话") {
                    workspace.show(.agent)
                    workspace.newThread()
                }.keyboardShortcut("n")
            }
            CommandMenu("导航") {
                Button("搜索会话") {
                    workspace.toggleConversationSearch()
                }.keyboardShortcut("k")
                Divider()
                Button("显示会话") { workspace.show(.agent) }.keyboardShortcut("1")
                Button("显示 Requirement") { workspace.zenMode = true; workspace.show(.requirement) }.keyboardShortcut("2")
                Button("显示 Plan") { workspace.show(.plan) }.keyboardShortcut("3")
                Button("显示知识库") { workspace.show(.knowledge) }.keyboardShortcut("4")
                Button("消耗统计") { workspace.zenMode = false; workspace.show(.usage) }.keyboardShortcut("5")
                Button("图片资源") { workspace.zenMode = false; workspace.show(.assets) }.keyboardShortcut("6")
                Divider()
                Button("刷新项目") { Task { await workspace.refresh() } }.keyboardShortcut("r")
            }
        }
    }
}

private struct SidebarThreadSection: Identifiable {
    let id: String
    let title: String
    let repoId: String?
    let threads: [ChatThread]
}

private struct ProjectCheckoutChoice: Identifiable {
    let id: String
    let path: String
    let branch: String?
    let worktree: Bool
    let active: Bool

    static func fromRepository(_ value:[String:Any]) -> [ProjectCheckoutChoice] {
        let data = value["repository"] as? [String:Any] ?? [:]
        let rows = data["checkouts"] as? [[String:Any]] ?? []
        return rows.compactMap { row -> ProjectCheckoutChoice? in
            guard let id = row["checkoutId"] as? String, !id.isEmpty,
                  let path = row["path"] as? String, !path.isEmpty,
                  (row["lifecycle"] as? String ?? "active") == "active" else { return nil }
            return ProjectCheckoutChoice(
                id:id,path:path,branch:row["branch"] as? String,
                worktree:row["worktree"] as? Bool ?? false,
                active:row["active"] as? Bool ?? false
            )
        }.sorted { left,right in
            if left.active != right.active { return left.active }
            return left.path.localizedStandardCompare(right.path) == .orderedAscending
        }
    }
}

private struct ForgeWorkspaceView: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visibility: NavigationSplitViewVisibility = .all
    @State private var zenScreen: ZenScreen = .board
    @State private var zenFocusedRequirementId: String?
    @State private var zenOpeningPlanning = false
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
    @State private var projectCheckoutError: String?
    @State private var inboxShown = false
    @State private var inboxDecisionRequestId: String?
    @State private var inboxDecision = ""
    @State private var inboxDismissRequestId: String?
    @State private var expandedInboxRequestIds: Set<String> = []
    @FocusState private var sidebarSearchFocused: Bool

    var body: some View {
        NavigationSplitView(columnVisibility:$visibility) {
            HStack(spacing:0) {
                if model.zenMode {
                    ZenRail(screen:$zenScreen) {
                        model.zenMode = false
                        model.show(.settings)
                    }
                    ZenSidebar(model:model,screen:$zenScreen,
                               focusedRequirementId:$zenFocusedRequirementId,
                               decisionCount:model.relevantUserRequests.count,
                               onInbox:{
                        inboxShown = true
                        Task { await model.loadUserRequests() }
                    },onAddProject:{
                        chooseProjectDirectory(keepZen:true)
                    })
                    .popover(isPresented:$inboxShown,arrowEdge:.trailing) {
                        inboxPanel
                    }
                } else {
                    navigationRail
                    sidebar
                }
            }
            .navigationSplitViewColumnWidth(min:296,ideal:318,max:352)
        } detail: {
            if model.zenMode {
                ZenWorkspacePane(model:model,screen:$zenScreen,
                                 focusedRequirementId:$zenFocusedRequirementId,
                                 onOpenPlanning:{
                    zenOpeningPlanning = true
                    model.zenMode = false
                },onDraftGoal:{ description in
                    model.zenMode = false
                    model.newThread()
                    model.draft = """
                    当前项目目标：\(description)

                    请以 Requirement-first 方式分析。优先复用现有 Requirement / Plan，新增独立目标或方案时说明理由。仅输出经核查的一个提案，不进行写操作。

                    \(ZenChangeProposal.outputContract)
                    """
                },onOpenInbox:{
                    inboxShown = true
                    Task { await model.loadUserRequests() }
                }) { item, prompt, provider, wantsProposal in
                    model.zenMode = false
                    model.newThread(
                        provider:provider,
                        requirementId:item.kind == .requirement ? item.recordId : item.requirementId,
                        planId:item.kind == .plan ? item.recordId : nil
                    )
                    model.draft = wantsProposal
                        ? prompt + "\n\n" + ZenChangeProposal.outputContract
                        : prompt
                }
            } else {
                main
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement:.principal) {
                Picker("工作模式",selection:$model.zenMode) {
                    Text("Zen").tag(true)
                    Text("Agent").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width:134)
                .accessibilityIdentifier("forge.mode")
            }
            ToolbarItem(placement:.navigation) {
                Text(model.project?.label ?? "Forge")
                    .font(.system(size:12,weight:.semibold))
                    .foregroundStyle(ForgePalette.ink)
                    .lineLimit(1)
            }
            ToolbarItem(placement:.automatic) {
                HStack(spacing:7) {
                    Circle().fill(model.connection == "配置已就绪" ? Color.green : Color.orange)
                        .frame(width:6,height:6)
                    Text(model.connection).font(.system(size:11))
                }.foregroundStyle(ForgePalette.secondary)
            }
        }
        .task {
            if model.zenMode { model.show(.requirement) }
        }
        .onChange(of:model.zenMode) { active in
            if zenOpeningPlanning {
                zenOpeningPlanning = false
                return
            }
            if active {
                model.show(.requirement)
            } else if model.page == .requirement {
                if let repoId=model.repoId,model.thread?.repoId != repoId {
                    model.openProject(repoId)
                } else {
                    model.show(.agent)
                }
            }
        }
        .onChange(of:model.showSearch) { visible in
            sidebarSearchFocused = visible
        }
        .onChange(of:model.repoId) { _ in
            Task { await model.loadUserRequests() }
        }
    }

    private var navigationRail: some View {
        VStack(spacing:10) {
            Image(systemName:"square.stack.3d.up.fill")
                .symbolRenderingMode(.hierarchical)
                .font(.system(size:18,weight:.medium))
                .foregroundStyle(ForgePalette.ink)
                .frame(width:40,height:40)
                .padding(.bottom,12)
                .accessibilityLabel("Forge")

            ForEach([NativePage.agent,.requirement,.schedule,.plugins,.knowledge,.assets,.usage]) { section in
                railButton(section)
            }
            Spacer(minLength:8)
            railButton(.settings)
        }
        .padding(.top,14)
        .padding(.bottom,14)
        .frame(width:62)
        .frame(maxHeight:.infinity)
        .background(.regularMaterial)
    }

    private func railButton(_ section:NativePage) -> some View {
        Button { model.show(section) } label: {
            Image(systemName:section.symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.system(size:16,weight:model.page == section ? .semibold : .regular))
                .foregroundStyle(model.page == section ? ForgePalette.ink : ForgePalette.secondary)
                .frame(width:40,height:38)
                .background(model.page == section ? ForgePalette.selectionStrong : .clear,
                            in:RoundedRectangle(cornerRadius:11,style:.continuous))
                .contentShape(RoundedRectangle(cornerRadius:11,style:.continuous))
        }
        .buttonStyle(.plain)
        .help(section.rawValue)
        .accessibilityLabel(section.rawValue)
        .accessibilityIdentifier(section.accessibilityId)
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
                .disabled(model.busy)
                .help(model.repoId == nil ? "创建不绑定项目的会话 (⌘N)" : "在当前项目新建会话 (⌘N)")
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
            .padding(.top,17).padding(.bottom,6)

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
                                    .help("在此项目中新建会话")
                                    .disabled(model.busy)
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
            .padding(.top,16)
            Spacer(minLength:5)

            projectSwitcher
                .padding(.horizontal,10).padding(.top,5).padding(.bottom,11)
        }
        .foregroundStyle(ForgePalette.ink)
        .background(.ultraThinMaterial)
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
        let running = model.activeConversationId == thread.id
        let showDelete = hovered || deleting
        let projectLabel = model.projects.first(where: { $0.repoId == thread.repoId })?.label
            ?? thread.repoId.map { String($0.prefix(16)) }
            ?? "未绑定项目"

        return HStack(spacing:4) {
            Button {
                model.selectThread(thread.id)
                if model.showSearch { model.toggleConversationSearch() }
            } label: {
                HStack(spacing:7) {
                    Text(thread.title)
                        .font(.system(size:12,weight:selected ? .medium : .regular))
                        .lineLimit(1)
                    Spacer(minLength:0)
                    if running {
                        ProgressView().controlSize(.mini)
                            .accessibilityLabel("执行中")
                    }
                }
                .frame(maxWidth:.infinity,alignment:.leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy && !running)
            .help(projectLabel + " · " + thread.title)
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
            .foregroundStyle(running ? ForgePalette.secondary.opacity(0.35) : Color.red.opacity(0.78))
            .opacity(showDelete ? 1 : 0)
            .allowsHitTesting(showDelete && !running)
            .accessibilityHidden(!showDelete)
            .accessibilityLabel("删除会话 \(thread.title)")
            .help(running ? "请先停止正在运行的会话" : "删除会话")
            .popover(isPresented:Binding(
                get:{ deleteThreadId == thread.id },
                set:{ if !$0 && deleteThreadId == thread.id { deleteThreadId = nil } }
            ),arrowEdge:.trailing) {
                deleteConfirmation(thread)
            }
        }
        .padding(.leading,9).padding(.trailing,5)
        .frame(height:32)
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
            Button("删除会话…",role:.destructive) { deleteThreadId = thread.id }
                .disabled(running)
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
            Text("仅删除这条本地记录，不影响项目、Requirement / Plan 或 Provider 会话。")
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
            let title = currentRepoId.flatMap { id in
                model.projects.first(where:{ $0.repoId == id })?.label
            } ?? "未绑定项目"
            result.append(SidebarThreadSection(
                id:"__current__",
                title:"当前 · \(title)",
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
                title:"其他项目 · 最近",
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
                    Text(model.project?.label ?? "选择项目")
                        .font(.system(size:12,weight:.semibold))
                        .lineLimit(1)
                    Text("\(model.projects.count) 个仓库 · 当前 \(model.checkoutBranch ?? "无 Checkout")")
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
        .popover(isPresented:$projectPickerShown,arrowEdge:.trailing) {
            projectPicker
        }
    }

    private var projectPicker: some View {
        VStack(alignment:.leading,spacing:10) {
            HStack {
                VStack(alignment:.leading,spacing:2) {
                    Text("仓库与工作树").font(.system(size:14,weight:.semibold))
                    Text("一个仓库可包含多个 Checkout；展开后选择工作树。")
                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { Task { await model.refresh() } } label: {
                    Image(systemName:"arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("刷新 Forge Registry")
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
                    ForEach(filteredProjects) { project in
                        VStack(spacing:3) {
                            HStack(spacing:6) {
                                Button {
                                    model.openProject(project.repoId)
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
                                Button {
                                    model.newThread(inProject:project.repoId)
                                    projectPickerShown = false
                                    projectSearch = ""
                                } label: {
                                    Image(systemName:"plus")
                                        .font(.system(size:10,weight:.semibold))
                                        .frame(width:25,height:25)
                                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                                }
                                .buttonStyle(.plain)
                                .help("在此仓库当前 Checkout 新建会话")
                                .disabled(model.busy)
                                Button {
                                    toggleProjectCheckouts(project.repoId)
                                } label: {
                                    Image(systemName:expandedProjectRepoId == project.repoId ? "chevron.up" : "chevron.down")
                                        .font(.system(size:10,weight:.medium))
                                        .frame(width:24,height:25)
                                }
                                .buttonStyle(.plain)
                                .help("展开仓库的工作树 / Checkout")
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
                                                model.openCheckout(inProject:project.repoId,checkoutId:checkout.id)
                                                projectPickerShown = false
                                                projectSearch = ""
                                            } label: {
                                                HStack(spacing:8) {
                                                    Image(systemName:checkout.worktree ? "arrow.triangle.branch" : "house")
                                                        .font(.system(size:10))
                                                    VStack(alignment:.leading,spacing:2) {
                                                        HStack(spacing:5) {
                                                            Text(checkout.branch ?? "detached HEAD")
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
                                            .help("在此 Checkout 创建会话")
                                            .disabled(model.busy)
                                        }
                                        .padding(.leading,21).padding(.trailing,10)
                                        .frame(height:39)
                                        .accessibilityIdentifier("project.checkout.\(checkout.id)")
                                    }
                                }
                            }
                        }
                    }
                    if filteredProjects.isEmpty {
                        Text("没有匹配的已注册项目")
                            .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                            .frame(maxWidth:.infinity).padding(.vertical,18)
                    }
                }
            }
            .frame(height:260)

            Divider()
            Button {
                chooseProjectDirectory()
            } label: {
                HStack(spacing:8) {
                    if registeringProject {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName:"folder.badge.plus")
                    }
                    Text(registeringProject ? "正在添加…" : "添加现有 Git 项目…")
                    Spacer()
                }
                .font(.system(size:11.5,weight:.medium))
            }
            .buttonStyle(.plain)
            .disabled(registeringProject || model.busy)
            Text("只写入 Forge Repository Registry；客户端不维护第二份项目列表。")
                .font(.system(size:9.5)).foregroundStyle(ForgePalette.secondary)
        }
        .padding(14).frame(width:380)
    }

    private func toggleProjectCheckouts(_ targetRepoId:String) {
        if expandedProjectRepoId == targetRepoId {
            expandedProjectRepoId = nil
            expandedProjectCheckouts = []
            projectCheckoutError = nil
            return
        }
        expandedProjectRepoId = targetRepoId
        expandedProjectCheckouts = []
        projectCheckoutError = nil
        projectCheckoutsLoading = true
        Task {
            do {
                let value = try await ForgeBridge.request("read_project_repository",["repoId":targetRepoId])
                guard expandedProjectRepoId == targetRepoId else { return }
                expandedProjectCheckouts = ProjectCheckoutChoice.fromRepository(value)
                if expandedProjectCheckouts.isEmpty {
                    projectCheckoutError = "此仓库没有可用的 Checkout。"
                }
            } catch {
                guard expandedProjectRepoId == targetRepoId else { return }
                projectCheckoutError = error.localizedDescription
            }
            if expandedProjectRepoId == targetRepoId { projectCheckoutsLoading = false }
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
                if keepZen {
                    model.zenMode = true
                    zenScreen = .board
                    zenFocusedRequirementId = nil
                }
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
            if model.page != .agent {
                HStack(spacing:9) {
                    if model.canNavigateBack {
                        Button { model.goBack() } label: {
                            Image(systemName:"chevron.left")
                                .font(.system(size:10.5,weight:.semibold))
                                .frame(width:27,height:27)
                                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                        }
                        .buttonStyle(.plain)
                        .help("返回 \(model.navigationBackLabel ?? "上一页")")
                        .accessibilityLabel("返回 \(model.navigationBackLabel ?? "上一页")")
                    }
                    Image(systemName:model.page.symbol)
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:11.5,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,
                                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
                    VStack(alignment:.leading,spacing:1) {
                        HStack(spacing:5) {
                            Text(model.project?.label ?? "未绑定项目")
                                .foregroundStyle(ForgePalette.secondary)
                            Image(systemName:"chevron.right")
                                .font(.system(size:7.5,weight:.semibold))
                                .foregroundStyle(ForgePalette.secondary.opacity(0.7))
                            Text(model.page.rawValue)
                                .foregroundStyle(ForgePalette.ink)
                        }
                        .font(.system(size:12.5,weight:.semibold))
                        if let branch = model.checkoutBranch, !branch.isEmpty {
                            Text("当前分支 · \(branch)")
                                .font(.system(size:10.5,weight:.medium,design:.monospaced))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                        } else if let checkout = model.checkoutId {
                            Text("Checkout · \(checkout.prefix(8))")
                                .font(.system(size:10.5,design:.monospaced))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Button { Task { await model.refresh() } } label: {
                        Image(systemName:"arrow.clockwise")
                            .font(.system(size:11.5,weight:.medium))
                            .frame(width:27,height:27)
                            .background(ForgePalette.softFill,in:Circle())
                    }
                    .buttonStyle(.plain)
                    .help("刷新真实 Forge 状态")
                    .accessibilityLabel("刷新当前页面")
                    .accessibilityIdentifier("app.refresh")
                }
                .padding(.horizontal,22).frame(height:48)
                .background(.ultraThinMaterial)
                .shadow(color:Color.black.opacity(0.025),radius:5,y:2)
                .zIndex(1)
            }
            switch model.page {
            case .agent: AgentPane(model:model,onChooseProject:{ projectPickerShown = true })
            case .requirement,.plan: RecordsPane(model:model)
            case .schedule: SchedulePane(model:model)
            case .plugins: PluginsPane(model:model)
            case .knowledge: KnowledgePane(model:model)
            case .assets: AgentAssetsDashboard(model:model)
            case .usage: AgentUsageDashboard(model:model)
            case .settings: SettingsPane(model:model)
            }
        }
        .background(ForgePalette.canvas)
    }
}

private enum AgentSemanticContextInspector: String, Identifiable {
    case planning
    case knowledge
    var id: String { rawValue }
}

private struct AgentPane: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let onChooseProject: () -> Void
    @State private var showChanges = false
    @State private var showActivityDetails = false
    @State private var expandedMessageActivities: Set<String> = []
    @State private var pendingAgentCommand: String?
    @State private var showProviderThinking = false
    @State private var isComposerDropTarget = false
    @StateObject private var voiceDictation = AgentVoiceDictation()
    @State private var voiceBaseDraft = ""
    @State private var semanticInspector: AgentSemanticContextInspector?
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing:0) {
            agentWorkspaceBar
            Divider().opacity(0.45)
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:20) {
                        if model.thread?.messages.isEmpty != false {
                            VStack(spacing:16) {
                                Image(systemName:"bolt")
                                    .font(.system(size:25,weight:.light))
                                    .foregroundStyle(ForgePalette.secondary)
                                .accessibilityHidden(true)
                                VStack(spacing:7) {
                                    Text("开始一个任务")
                                        .font(.system(size:24,weight:.medium)).tracking(-0.45)
                                    Text(agentEmptyStateDescription)
                                        .font(.system(size:12))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .multilineTextAlignment(.center)
                                        .lineSpacing(4)
                                        .frame(maxWidth:470)
                                }
                                if !model.checkoutIsAvailable || !model.selectedProviderReady {
                                    HStack(spacing:12) {
                                        if !model.checkoutIsAvailable {
                                            Button("选择或添加项目",action:onChooseProject)
                                                .buttonStyle(.borderedProminent)
                                                .accessibilityIdentifier("agent.onboarding.project")
                                        }
                                        if !model.selectedProviderReady {
                                            Button("设置模型") { model.show(.settings) }
                                                .buttonStyle(.bordered)
                                                .accessibilityIdentifier("agent.onboarding.provider")
                                        }
                                    }
                                } else {
                                    HStack(spacing:8) {
                                        starterPromptButton("审查当前改动",systemImage:"doc.text.magnifyingglass",
                                                            prompt:"检查当前 checkout 的未提交改动，指出风险并完成必要修复与验证。")
                                        starterPromptButton("定位问题",systemImage:"scope",
                                                            prompt:"读取当前项目真实状态，定位最高价值的问题并直接修复，完成必要验证。")
                                        starterPromptButton("实现需求",systemImage:"hammer",
                                                            prompt:"读取当前 Requirement / Plan 与代码现状，选择最高价值的下一项实现并完成验证。")
                                    }
                                }
                            }
                            .frame(maxWidth:.infinity,minHeight:360)
                        }
                        ForEach(model.thread?.messages ?? []) { message in
                            if message.role == "user" {
                                HStack(alignment:.top) {
                                    Spacer(minLength:0)
                                    VStack(alignment:.leading,spacing:7) {
                                        Text(message.text)
                                            .font(.system(size:13))
                                            .lineSpacing(5)
                                            .textSelection(.enabled)
                                        if let contextPaths = message.contextPaths, !contextPaths.isEmpty {
                                            Label(contextPaths.joined(separator:" · "),systemImage:"doc.text")
                                                .font(.system(size:10.5,weight:.medium))
                                                .foregroundStyle(ForgePalette.secondary)
                                                .lineLimit(1)
                                        }
                                        if let attachments = message.attachmentNames, !attachments.isEmpty {
                                            Label(attachments.joined(separator:" · "),systemImage:"photo")
                                                .font(.system(size:10.5,weight:.medium))
                                                .foregroundStyle(ForgePalette.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                    .padding(.horizontal,14).padding(.vertical,11)
                                    .background(ForgePalette.userBubble,
                                                in:RoundedRectangle(cornerRadius:14,style:.continuous))
                                    .contextMenu {
                                        Button { copyAgentText(message.text) } label: {
                                            Label("复制",systemImage:"doc.on.doc")
                                        }
                                        Button { model.reeditMessage(message) } label: {
                                            Label("重新编辑",systemImage:"arrow.uturn.backward")
                                        }
                                        .disabled(model.busy)
                                    }
                                }
                                .frame(maxWidth:920,alignment:.trailing)
                                .frame(maxWidth:.infinity,alignment:.trailing)
                                .id(message.id)
                            } else {
                                HStack(alignment:.top,spacing:10) {
                                    Image(systemName:"bolt.circle")
                                        .foregroundStyle(ForgePalette.accent)
                                        .font(.system(size:17))
                                        .padding(.top,1)
                                        .accessibilityHidden(true)
                                    VStack(alignment:.leading,spacing:8) {
                                        AgentAssistantMessageBody(
                                            text:message.text,
                                            onExecuteCommand: { command in
                                                guard !model.busy else { return }
                                                guard model.repoId != nil, model.checkoutId != nil else {
                                                    model.error = "执行命令前请先绑定项目与 checkout。"
                                                    return
                                                }
                                                guard model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
                                                    model.error = "输入框已有未发送内容。请先发送或保存，再执行这段命令，避免覆盖草稿。"
                                                    return
                                                }
                                                pendingAgentCommand = command
                                            },
                                            onReplySelection: { reply in
                                                guard !model.busy else { return }
                                                model.draft += model.draft.isEmpty ? reply : "\n\n" + reply
                                                composerFocused = true
                                            }
                                        )
                                        HStack(spacing:10) {
                                            if message.activityEvents?.isEmpty == false {
                                                Button {
                                                    if expandedMessageActivities.contains(message.id) {
                                                        expandedMessageActivities.remove(message.id)
                                                    } else {
                                                        expandedMessageActivities.insert(message.id)
                                                    }
                                                } label: {
                                                    HStack(spacing:5) {
                                                        Label(message.toolActivityCount.map { "\($0) 次工具调用 · 过程" } ?? "查看过程",
                                                              systemImage:"list.bullet.rectangle")
                                                        Image(systemName:expandedMessageActivities.contains(message.id)
                                                              ? "chevron.up" : "chevron.down")
                                                            .font(.system(size:8,weight:.semibold))
                                                    }
                                                }
                                                .buttonStyle(.plain)
                                            } else if let count = message.toolActivityCount, count > 0 {
                                                Label("\(count) 次工具调用",systemImage:"hammer")
                                            }
                                            if let usage = message.usage {
                                                Label(
                                                    "\(usage.totalTokens.formatted()) tokens" + (usage.complete ? "" : " · 部分回合"),
                                                    systemImage:"chart.bar"
                                                )
                                                .help("输入 \(usage.inputTokens.formatted()) · 输出 \(usage.outputTokens.formatted())")
                                            }
                                            Spacer(minLength:0)
                                            Button {
                                                copyAgentText(message.text)
                                            } label: {
                                                Label("复制",systemImage:"doc.on.doc")
                                            }
                                            .buttonStyle(.plain)
                                            .help("复制完整回复")
                                        }
                                        .font(.system(size:10.5,weight:.medium))
                                        .foregroundStyle(ForgePalette.secondary)
                                        if message.incomplete == true,
                                           message.id == model.thread?.messages.last?.id {
                                            HStack(alignment:.center,spacing:9) {
                                                Image(systemName:"exclamationmark.arrow.triangle.2.circlepath")
                                                    .font(.system(size:15))
                                                    .foregroundStyle(ForgePalette.secondary)
                                                    .accessibilityHidden(true)
                                                VStack(alignment:.leading,spacing:3) {
                                                    Text("上次执行未完成")
                                                        .font(.system(size:11,weight:.semibold))
                                                        .foregroundStyle(ForgePalette.ink)
                                                    Text("继续时先核对 Process 终态与当前改动。")
                                                        .font(.system(size:10))
                                                        .foregroundStyle(ForgePalette.secondary)
                                                }
                                                Spacer(minLength:6)
                                                Button("查看改动") {
                                                    showChanges = true
                                                    Task { await model.refreshAgentChanges() }
                                                }
                                                .buttonStyle(.plain)
                                                .font(.system(size:10.5,weight:.medium))
                                                .disabled(model.checkoutId == nil)
                                                Button {
                                                    model.draft = "继续执行上一次未完成的开发任务。上次未完成回执（仅作线索）：\n\(String(message.text.prefix(1100)))\n若有 Process ID，先调用 process_status 获取终态；否则先核对 checkout 的 Git 状态和最近工具回执。不要重放未知或仍在运行的写操作，再继续实施和验证。"
                                                    Task { await model.send() }
                                                } label: {
                                                    Label("继续执行",systemImage:"play.fill")
                                                        .font(.system(size:10.5,weight:.medium))
                                                }
                                                .buttonStyle(.bordered)
                                                .disabled(model.busy || !model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                                    || model.agentSendBlockReason != nil)
                                                .accessibilityIdentifier("agent.continue-incomplete")
                                            }
                                            .padding(10)
                                            .background(ForgePalette.softFill,
                                                        in:RoundedRectangle(cornerRadius:10,style:.continuous))
                                            .accessibilityIdentifier("agent.incomplete-recovery")
                                        }
                                        if expandedMessageActivities.contains(message.id),
                                           let events = message.activityEvents, !events.isEmpty {
                                            VStack(alignment:.leading,spacing:7) {
                                                ForEach(events) { event in
                                                    activityTrailRow(event)
                                                }
                                            }
                                            .padding(.horizontal,9).padding(.vertical,7)
                                            .background(ForgePalette.softFill,
                                                        in:RoundedRectangle(cornerRadius:9,style:.continuous))
                                        }
                                    }
                                    Spacer(minLength:56)
                                }
                                .frame(maxWidth:.infinity,alignment:.leading)
                                .id(message.id)
                            }
                        }
                        if model.busy {
                            VStack(alignment:.leading,spacing:10) {
                                HStack(spacing:10) {
                                    ZStack {
                                        Circle().fill(ForgePalette.accent.opacity(0.10))
                                            .frame(width:28,height:28)
                                        ProgressView().controlSize(.mini)
                                    }
                                    VStack(alignment:.leading,spacing:2) {
                                        Text(agentActivityTitle)
                                            .font(.system(size:11.5,weight:.semibold))
                                            .foregroundStyle(ForgePalette.ink)
                                        Text(model.liveActivity?.lastActivity ?? "正在处理请求…")
                                            .font(.system(size:10.5))
                                            .foregroundStyle(ForgePalette.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength:8)
                                    if let count = model.liveActivity?.toolActivityCount, count > 0 {
                                        Text("\(count) tools")
                                            .font(.system(size:9.5,weight:.medium))
                                            .foregroundStyle(.tertiary)
                                    }
                                    if let count = model.liveActivity?.events?.count, count > 4 {
                                        Button(showActivityDetails ? "收起" : "全部") {
                                            withAnimation(reduceMotion ? nil : .easeOut(duration:0.16)) {
                                                showActivityDetails.toggle()
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10.5,weight:.medium))
                                    }
                                }

                                if !model.streamedReasoning.isEmpty {
                                    VStack(alignment:.leading,spacing:5) {
                                        Button {
                                            showProviderThinking.toggle()
                                        } label: {
                                            HStack(spacing:6) {
                                                Image(systemName:"brain.head.profile")
                                                Text("Provider 返回的思考内容")
                                                Image(systemName:showProviderThinking ? "chevron.up" : "chevron.down")
                                                    .font(.system(size:9))
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10.5,weight:.medium))
                                        .foregroundStyle(ForgePalette.secondary)
                                        Text(model.streamedReasoning)
                                            .font(.system(size:11))
                                            .foregroundStyle(ForgePalette.secondary)
                                            .lineSpacing(4)
                                            .lineLimit(showProviderThinking ? nil : 3)
                                            .textSelection(.enabled)
                                    }
                                    .accessibilityIdentifier("agent.streaming-reasoning")
                                }
                                if !model.streamedAnswer.isEmpty {
                                    AgentAssistantMessageBody(text:model.streamedAnswer)
                                        .accessibilityIdentifier("agent.streaming-response")
                                }

                                let allActivityEvents = model.liveActivity?.events ?? []
                                let activityEvents = showActivityDetails
                                    ? allActivityEvents
                                    : Array(allActivityEvents.suffix(4))
                                if !activityEvents.isEmpty {
                                    Divider().opacity(0.45)
                                    VStack(alignment:.leading,spacing:7) {
                                        ForEach(activityEvents) { event in
                                            activityTrailRow(event)
                                        }
                                    }
                                }
                            }
                            .padding(.vertical,9).padding(.horizontal,12)
                            .background(ForgePalette.softFill.opacity(0.55),
                                        in:RoundedRectangle(cornerRadius:9,style:.continuous))
                            .id("pending")
                        }
                    }
                    .frame(maxWidth:1320,alignment:.leading)
                    .frame(maxWidth:.infinity)
                    .padding(.horizontal,28).padding(.top,18).padding(.bottom,22)
                }.scrollIndicators(.automatic)
                .overlay(alignment:.bottomTrailing) {
                    if model.busy {
                        Button {
                            withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                                reader.scrollTo("pending",anchor:.bottom)
                            }
                        } label: {
                            Label("最新进度",systemImage:"arrow.down.to.line")
                                .font(.system(size:10.5,weight:.medium))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .padding(.trailing,16).padding(.bottom,12)
                        .accessibilityIdentifier("agent.scroll-to-progress")
                    }
                }
                .onChange(of:model.selectedThreadId) { _ in
                    Task { @MainActor in
                        await Task.yield()
                        if let last = model.thread?.messages.last {
                            reader.scrollTo(last.id,anchor:.bottom)
                        }
                    }
                }
                .onChange(of:model.thread?.messages.count) { _ in
                    if let last = model.thread?.messages.last {
                        withAnimation(reduceMotion ? nil : .easeOut(duration:0.2)) { reader.scrollTo(last.id,anchor:.bottom) }
                    }
                }
                .onChange(of:model.busy) { busy in
                    guard busy else { return }
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(reduceMotion ? nil : .easeOut(duration:0.2)) { reader.scrollTo("pending",anchor:.bottom) }
                    }
                }
            }
            VStack(alignment:.leading,spacing:0) {
                ZStack(alignment:.topLeading) {
                    if model.draft.isEmpty {
                        Text("输入消息或描述目标…")
                            .font(.system(size:13))
                            .foregroundStyle(.tertiary)
                            .padding(.leading,16).padding(.top,18)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text:$model.draft)
                        .focused($composerFocused)
                        .font(.system(size:13))
                        .foregroundStyle(ForgePalette.ink)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight:46,maxHeight:116)
                        .padding(.horizontal,10).padding(.top,7)
                        .disabled(voiceDictation.isRecording)
                        .accessibilityLabel("Agent 消息")
                        .accessibilityHint("输入任务描述，按 Command Return 发送")
                        .accessibilityIdentifier("agent.composer")
                }
                if !model.pendingContextPaths.isEmpty || !model.pendingImageURLs.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing:7) {
                            ForEach(model.pendingContextPaths,id:\.self) { path in
                                contextChip(path,systemImage:"doc.text") {
                                    model.removePendingContextPath(path)
                                }
                            }
                            ForEach(model.pendingImageURLs,id:\.path) { url in
                                contextChip(url.lastPathComponent,systemImage:"photo") {
                                    model.removePendingImage(url)
                                }
                            }
                        }
                        .padding(.horizontal,13).padding(.bottom,7)
                    }
                    .scrollIndicators(.hidden)
                }
                HStack(spacing:7) {
                    Menu {
                        Button {
                            chooseAgentFiles(model)
                        } label: {
                            Label("添加文件上下文",systemImage:"doc.text")
                        }
                        .disabled(model.checkoutRoot == nil)
                        Divider()
                        Button {
                            chooseAgentImages(model)
                        } label: {
                            Label("添加图片",systemImage:"photo")
                        }
                        .disabled(!model.selectedProviderSupportsImages)
                    } label: {
                        Image(systemName:"paperclip")
                            .font(.system(size:10,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                            .frame(width:27,height:27)
                            .background(ForgePalette.softFill,
                                        in:RoundedRectangle(cornerRadius:9,style:.continuous))
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(model.busy || (model.checkoutRoot == nil && !model.selectedProviderSupportsImages))
                    .help("添加当前 checkout 文件上下文或图片")
                    .accessibilityLabel("添加上下文")
                    .accessibilityHint("添加当前 checkout 文件或当前 Provider 支持的图片")
                    .accessibilityIdentifier("agent.attach")

                    composerQuickConfigurationControls

                    Spacer(minLength:12)

                    if voiceDictation.isRecording || voiceDictation.isStarting {
                        Text(voiceDictation.isStarting ? "正在请求麦克风…" : "正在听写…")
                            .font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                            .accessibilityIdentifier("agent.voice.recording")
                    } else if let issue = voiceDictation.error {
                        Text(issue)
                            .font(.system(size:10.5))
                            .foregroundStyle(.orange)
                            .lineLimit(1)
                            .help(issue)
                    }
                    Button {
                        if voiceDictation.isRecording || voiceDictation.isStarting {
                            voiceDictation.stop()
                            composerFocused = true
                        } else {
                            voiceBaseDraft = model.draft
                            Task { await voiceDictation.start() }
                        }
                    } label: {
                        Image(systemName:(voiceDictation.isRecording || voiceDictation.isStarting) ? "stop.circle.fill" : "mic")
                            .font(.system(size:14,weight:.medium))
                            .foregroundStyle((voiceDictation.isRecording || voiceDictation.isStarting) ? Color.red : ForgePalette.secondary)
                            .frame(width:30,height:30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.busy)
                    .help((voiceDictation.isRecording || voiceDictation.isStarting) ? "取消语音输入" : "语音输入（只填入草稿，不自动发送）")
                    .accessibilityLabel((voiceDictation.isRecording || voiceDictation.isStarting) ? "停止语音输入" : "开始语音输入")
                    .accessibilityIdentifier("agent.voice.toggle")

                    if model.busy {
                        Button { Task { await model.cancel() } } label: {
                            Image(systemName:"stop.fill")
                                .font(.system(size:9,weight:.semibold))
                                .frame(width:30,height:30)
                                .background(ForgePalette.softFill,in:Circle())
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.escape,modifiers:[])
                        .help("停止 Agent（Esc）")
                        .accessibilityLabel("停止 Agent")
                        .accessibilityHint("停止当前正在进行的 Agent 请求")
                        .accessibilityIdentifier("agent.cancel")
                    } else {
                        let sendDisabled = model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                            || model.agentSendBlockReason != nil
                        Button { Task { await model.send() } } label: {
                            Image(systemName:"arrow.up")
                                .font(.system(size:11,weight:.bold))
                                .foregroundStyle(.white)
                                .frame(width:30,height:30)
                                .background(ForgePalette.accent,in:Circle())
                                .opacity(sendDisabled ? 0.34 : 1)
                        }
                        .buttonStyle(.plain)
                        .disabled(sendDisabled)
                        .keyboardShortcut(.return,modifiers:.command)
                        .help(model.agentSendBlockReason ?? "发送消息（⌘↵）")
                        .accessibilityLabel("发送消息")
                        .accessibilityValue(sendDisabled ? "不可发送" : "可发送")
                        .accessibilityHint("按 Command Return 发送")
                        .accessibilityIdentifier("agent.send")
                    }
                }.padding(.horizontal,13).padding(.bottom,11)
                if !model.busy, let reason = model.agentSendBlockReason {
                    HStack(alignment:.firstTextBaseline,spacing:6) {
                        Image(systemName:"info.circle")
                            .accessibilityHidden(true)
                        Text(reason)
                            .lineLimit(2)
                        Spacer(minLength:6)
                        if !model.selectedProviderReady {
                            Button(model.selectedProvider == "codex" ? "刷新状态" : "打开设置") {
                                if model.selectedProvider == "codex" {
                                    Task { await model.refresh() }
                                } else {
                                    model.show(.settings)
                                }
                            }
                            .buttonStyle(.plain)
                            .fontWeight(.semibold)
                            .foregroundStyle(ForgePalette.accent)
                            .accessibilityIdentifier("agent.configure-provider")
                        }
                    }
                    .font(.system(size:10.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.horizontal,16).padding(.bottom,11)
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .accessibilityIdentifier("agent.send-block-reason")
                }
            }
            .background(.regularMaterial,
                        in:RoundedRectangle(cornerRadius:17,style:.continuous))
            .overlay {
                if isComposerDropTarget {
                    RoundedRectangle(cornerRadius:17,style:.continuous)
                        .strokeBorder(ForgePalette.accent.opacity(0.5),lineWidth:1)
                }
            }
            .dropDestination(for:URL.self) { urls, _ in
                guard !model.busy, !urls.isEmpty else { return false }
                model.addDroppedAttachments(urls)
                return true
            } isTargeted: { targeted in
                isComposerDropTarget = targeted && !model.busy
            }
            .frame(maxWidth:980)
            .padding(.horizontal,24).padding(.bottom,16)
            .frame(maxWidth:.infinity)
        }
        .background(ForgePalette.canvas)
        .safeAreaInset(edge:.trailing,spacing:0) {
            if showChanges {
                HStack(spacing:0) {
                    Divider()
                    AgentChangesPane(model:model,isPresented:$showChanges)
                        .frame(width:340)
                }
                .transition(reduceMotion ? .identity : .move(edge:.trailing).combined(with:.opacity))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration:0.18),value:showChanges)
        .confirmationDialog(
            "将命令交给 Forge Agent？",
            isPresented:Binding(
                get:{ pendingAgentCommand != nil },
                set:{ if !$0 { pendingAgentCommand = nil } }
            ),
            titleVisibility:.visible
        ) {
            Button("发送执行请求") {
                guard let command = pendingAgentCommand, !model.busy,
                      model.repoId != nil, model.checkoutId != nil else { return }
                pendingAgentCommand = nil
                model.draft = AgentMessageBlock.commandExecutionPrompt(command)
                Task { await model.send() }
            }
            Button("取消",role:.cancel) { pendingAgentCommand = nil }
        } message: {
            Text("仅将这段命令作为请求提交给现有 Agent；执行必须经过 Forge Repository AccessPolicy 和 Process Runtime。可能产生文件改动，请先确认命令内容。")
        }
        .onAppear {
            if !model.busy { composerFocused = true }
        }
        .onChange(of:model.selectedThreadId) { _ in
            voiceDictation.stop()
            showChanges = false
            if !model.busy { composerFocused = true }
        }
        .onChange(of:voiceDictation.transcript) { transcript in
            guard !transcript.isEmpty else { return }
            model.draft = AgentVoiceDictation.mergedDraft(voiceBaseDraft,transcript:transcript)
        }
        .onChange(of:model.busy) { busy in
            if busy { voiceDictation.stop() }
        }
        .onDisappear { voiceDictation.stop() }
    }

    private var agentActivityTitle: String {
        switch model.liveActivity?.phase {
        case "thinking", "starting", "model": return "正在思考"
        case "tool": return "正在执行工具"
        case "responding": return "正在生成回复"
        default: return model.streamedAnswer.isEmpty ? "正在等待模型" : "正在生成回复"
        }
    }

    private var agentEmptyStateDescription: String {
        if model.checkoutId == nil {
            return model.projects.isEmpty
                ? "添加本地 Git 项目后即可处理代码；不绑定项目也可以直接对话。"
                : "选择项目与 checkout 后即可处理代码；不绑定项目也可以直接对话。"
        }
        if !model.checkoutIsAvailable { return "当前 checkout 尚未就绪，请重新选择项目或 checkout。" }
        if !model.selectedProviderReady { return "已选择项目。设置可用模型后即可开始任务。" }
        return "描述你想完成的工作，或选择下方的常用操作。"
    }

    private var agentWorkspaceStatusLabel: String {
        if model.busy { return "执行中" }
        if !model.selectedProviderReady {
            if model.selectedProvider == "joycode" { return "JoyCode 未就绪" }
            return model.selectedProvider == "api" ? "API 未配置" : "Codex 未就绪"
        }
        if model.thread?.repoId != nil && model.thread?.checkoutId == nil { return "缺 checkout" }
        if model.thread?.repoId == nil { return "未绑定项目" }
        if model.checkoutContextLoading { return "验证 checkout" }
        if !model.checkoutIsAvailable { return "checkout 不可用" }
        return "本地可执行"
    }

    private var agentWorkspaceStatusColor: Color {
        if model.busy { return ForgePalette.accent }
        if !model.selectedProviderReady
            || (model.thread?.repoId != nil && (
                model.thread?.checkoutId == nil || model.checkoutContextLoading || !model.checkoutIsAvailable
            )) {
            return Color.orange
        }
        return model.thread?.repoId == nil ? Color.secondary : Color.green
    }

    private var agentWorkspaceStatusDetail: String {
        if model.busy { return model.liveActivity?.lastActivity ?? "Agent 正在执行" }
        if !model.selectedProviderReady {
            if model.selectedProvider == "joycode" {
                return "JoyCode 尚未就绪；请先在本机 JoyCode 登录并确认模型配置。"
            }
            return model.selectedProvider == "api" ? "兼容 API 配置尚未就绪；请检查 Endpoint、必要的 API Key 与模型" : model.provider
        }
        if model.thread?.repoId != nil && model.thread?.checkoutId == nil {
            return "当前会话绑定了项目，但没有有效 checkout；请选择项目后新建会话。"
        }
        if model.checkoutContextLoading { return "正在从 Forge Registry 验证当前会话绑定的 checkout。" }
        if model.thread?.repoId != nil && !model.checkoutIsAvailable {
            return "当前 checkout 路径不可用或缺少 Git 元数据；请切换到有效 checkout，避免在未验证的项目上执行。"
        }
        if model.thread?.repoId == nil { return "当前会话可以对话，但没有项目/checkout 执行上下文。" }
        return "本地 Provider 与当前 Git checkout 可用于执行；远程 MCP 隧道状态单独显示。"
    }

    private var agentWorkspaceBar: some View {
        HStack(spacing:10) {
            HStack(spacing:7) {
                workspaceProjectControl
                if let context = checkoutContextLabel {
                    Text(context)
                        .font(.system(size:9.5,weight:.medium,design:.monospaced))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth:170,alignment:.leading)
                        .padding(.horizontal,7)
                        .frame(height:21)
                        .background(ForgePalette.softFill,
                                    in:RoundedRectangle(cornerRadius:7,style:.continuous))
                }
            }
            .help(model.checkoutId.map { "checkout: \($0)" } ?? "当前项目没有 checkout")

            Spacer(minLength:12)

            ViewThatFits(in:.horizontal) {
                HStack(spacing:3) {
                    planningContextControl()
                    semanticContextButton("知识",kind:.knowledge,systemImage:"books.vertical")
                }
                HStack(spacing:3) {
                    planningContextControl(compact:true)
                    semanticContextButton("知识",kind:.knowledge,systemImage:"books.vertical",compact:true)
                }
            }

            workspaceChangesControl

            Divider().frame(height:18)

            Button { Task { await model.refresh() } } label: {
                HStack(spacing:6) {
                    Circle()
                        .fill(agentWorkspaceStatusColor)
                        .frame(width:6,height:6)
                    Text(agentWorkspaceStatusLabel)
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(ForgePalette.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("\(agentWorkspaceStatusDetail)\n点击刷新 Agent 上下文与 Provider 状态")
            .accessibilityLabel("Agent 状态")
            .accessibilityValue(agentWorkspaceStatusLabel)
            .accessibilityIdentifier("agent.workspace-refresh")
        }
        .padding(.horizontal,18)
        .frame(height:43)
        .background(ForgePalette.raisedSurface.opacity(0.64))
        .accessibilityElement(children:.contain)
        .accessibilityIdentifier("agent.workspace-context")
    }

    private var checkoutContextLabel: String? {
        if let branch = model.checkoutBranch, !branch.isEmpty { return branch }
        if let checkout = model.checkoutId, !checkout.isEmpty { return String(checkout.prefix(8)) }
        return nil
    }

    private var workspaceProjectControl: some View {
        Menu {
            ForEach(model.projects) { project in
                Button {
                    model.selectProject(project.repoId)
                } label: {
                    if model.project?.repoId == project.repoId {
                        Label(project.label,systemImage:"checkmark")
                    } else {
                        Text(project.label)
                    }
                }
            }
        } label: {
            HStack(spacing:6) {
                Image(systemName:"folder.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                Text(model.project?.label ?? "选择项目")
                    .font(.system(size:11.5,weight:.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth:185,alignment:.leading)
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .fixedSize(horizontal:false,vertical:true)
        .disabled(model.projects.isEmpty || model.busy)
        .help("切换项目会打开该项目最近会话；没有历史会话时创建新会话")
        .accessibilityLabel("项目")
        .accessibilityValue(model.project?.label ?? "未选择")
        .accessibilityIdentifier("agent.project")
    }

    private var workspaceWorkingChangeCount: Int {
        guard let changes = model.agentChanges, !changes.staged else { return 0 }
        return changes.nameOnly.count + changes.untrackedFiles.count
    }

    private var workspaceChangesControl: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) { showChanges.toggle() }
            if showChanges {
                Task { await model.refreshAgentChanges() }
            }
        } label: {
            HStack(spacing:5) {
                Image(systemName:"doc.text.magnifyingglass")
                    .font(.system(size:9.5,weight:.medium))
                if workspaceWorkingChangeCount > 0 {
                    Text("\(workspaceWorkingChangeCount)")
                        .font(.system(size:9.5,weight:.semibold))
                        .monospacedDigit()
                }
            }
            .foregroundStyle(showChanges ? ForgePalette.ink : ForgePalette.secondary)
            .padding(.horizontal,7)
            .frame(minWidth:25,minHeight:24)
            .background(showChanges ? ForgePalette.selectionStrong : Color.clear,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.checkoutId == nil)
        .help(workspaceWorkingChangeCount > 0
              ? "查看当前 checkout 的 \(workspaceWorkingChangeCount) 个 Working Tree 文件"
              : "查看当前 checkout 的未提交改动")
        .accessibilityLabel("Git Changes")
        .accessibilityValue(workspaceWorkingChangeCount > 0 ? "\(workspaceWorkingChangeCount) 个 Working Tree 文件" : "未加载 Working Tree 计数")
        .accessibilityIdentifier("agent.changes")
    }

    private func semanticInspectorBinding(_ kind: AgentSemanticContextInspector) -> Binding<Bool> {
        Binding(
            get: { semanticInspector == kind },
            set: { visible in
                if visible { semanticInspector = kind }
                else if semanticInspector == kind { semanticInspector = nil }
            }
        )
    }

    @ViewBuilder
    private func semanticInspectorContent(_ kind: AgentSemanticContextInspector) -> some View {
        switch kind {
        case .planning:
            AgentPlanningInspector(model:model) { semanticInspector = nil }
        case .knowledge:
            AgentKnowledgeInspector(model:model) { semanticInspector = nil }
        }
    }

    private func planningContextControl(compact: Bool = false) -> some View {
        let planId = model.thread?.planId
        let requirementId = model.thread?.requirementId
        let title: String
        if let planId, !planId.isEmpty {
            title = compact ? "" : "Plan · \(String(planId.prefix(8)))"
        } else if let requirementId, !requirementId.isEmpty {
            title = compact ? "" : "Req · \(String(requirementId.prefix(8)))"
        } else {
            title = compact ? "" : "规划"
        }

        return Button {
            semanticInspector = semanticInspector == .planning ? nil : .planning
        } label: {
            HStack(spacing:4) {
                Image(systemName:"point.3.connected.trianglepath.dotted").font(.system(size:9))
                if !title.isEmpty { Text(title) }
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.horizontal,7)
            .frame(minWidth:compact ? 25 : nil,minHeight:24)
            .background((planId?.isEmpty == false || requirementId?.isEmpty == false) ? ForgePalette.softFill : Color.clear,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.repoId == nil)
        .help(planId?.isEmpty == false
              ? "当前会话已绑定 Plan；点击查看或更换"
              : (requirementId?.isEmpty == false
                 ? "当前会话已绑定 Requirement；点击查看或更换"
                 : "在当前会话中选择规划上下文"))
        .accessibilityLabel("规划")
        .accessibilityValue(planId?.isEmpty == false
                            ? "已绑定 Plan"
                            : (requirementId?.isEmpty == false ? "已绑定 Requirement" : "未绑定"))
        .accessibilityHint("在当前会话中打开规划上下文，不切换工作区页面")
        .accessibilityIdentifier("agent.semantic-context.planning")
        .popover(isPresented:semanticInspectorBinding(.planning),arrowEdge:.top) {
            semanticInspectorContent(.planning)
        }
    }

    private func semanticContextButton(_ title: String, kind: AgentSemanticContextInspector, systemImage: String,
                                       compact: Bool = false) -> some View {
        Button {
            semanticInspector = semanticInspector == kind ? nil : kind
        } label: {
            HStack(spacing:4) {
                Image(systemName:systemImage).font(.system(size:9))
                if !compact { Text(title) }
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.horizontal,7)
            .frame(minWidth:compact ? 25 : nil,minHeight:24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.repoId == nil)
        .help("在当前会话中查看 \(title)")
        .accessibilityLabel(title)
        .accessibilityHint("在当前会话中打开上下文，不切换工作区页面")
        .accessibilityIdentifier("agent.semantic-context.\(kind.rawValue)")
        .popover(isPresented:semanticInspectorBinding(kind),arrowEdge:.top) {
            semanticInspectorContent(kind)
        }
    }

    private func starterPromptButton(_ title: String, systemImage: String, prompt: String) -> some View {
        Button {
            model.draft = prompt
            composerFocused = true
        } label: {
            HStack(spacing:6) {
                Image(systemName:systemImage).font(.system(size:9.5,weight:.medium))
                Text(title)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.horizontal,10)
            .frame(height:28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.busy || model.checkoutId == nil)
        .help(model.checkoutId == nil ? "先选择带有 active checkout 的项目" : title)
    }

    private func activityTrailRow(_ event: AgentLiveActivityEvent) -> some View {
        HStack(alignment:.top,spacing:8) {
            ZStack {
                Circle()
                    .fill(activityStatusColor(event).opacity(event.status == "running" ? 0.07 : 0.11))
                    .frame(width:21,height:21)
                Image(systemName:activityStatusIcon(event))
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(activityStatusColor(event))
            }
            VStack(alignment:.leading,spacing:2) {
                Text(event.label)
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size:9.5,design:.monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(event.phase == "message" ? 7 : 2)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength:8)
            if event.status == "failed" {
                Text("失败")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(Color.red)
            } else if event.status == "unknown" {
                Text("结果未知")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(Color.orange)
            }
        }
    }

    private func activityStatusColor(_ event: AgentLiveActivityEvent) -> Color {
        if event.phase == "message" { return ForgePalette.secondary }
        switch event.status {
        case "completed": return Color.green
        case "failed": return Color.red
        case "unknown": return Color.orange
        default: return ForgePalette.secondary
        }
    }

    private func activityStatusIcon(_ event: AgentLiveActivityEvent) -> String {
        if event.phase == "message" { return "text.bubble" }
        switch event.status {
        case "completed": return "checkmark"
        case "failed": return "exclamationmark"
        case "unknown": return "questionmark.circle"
        default: return activityIcon(event.phase)
        }
    }

    @ViewBuilder
    private var composerQuickConfigurationControls: some View {
        if showsQuickProviderPicker {
            quickProviderMenu
        }
        quickModelMenu
        if model.selectedProvider == "codex" && !model.selectedReasoningOptions.isEmpty {
            quickReasoningMenu
        }
        if model.checkoutId != nil && NativeWorkspace.matchesExternalProvider(model.selectedProvider) {
            quickRepositoryAccessMenu
        }
    }

    private var showsQuickProviderPicker: Bool {
        !providerSelectionLocked && quickProviderCount > 1
    }

    private var quickProviderCount: Int {
        let profiles = model.localApiSettings?.profiles ?? []
        var count = model.localProviderReady ? 1 : 0
        count += profiles.filter(\.endpointReady).count
        if model.joyCodeProfileReady { count += 1 }
        // Preserve the currently bound provider even if its profile is temporarily unavailable.
        if model.selectedProvider == "codex" && !model.localProviderReady { count += 1 }
        if model.selectedProvider == "joycode" && !model.joyCodeProfileReady { count += 1 }
        if let selectedProfile = profiles.first(where: { $0.providerId == model.selectedProvider }) {
            if !selectedProfile.endpointReady { count += 1 }
        } else if model.selectedProvider != "codex" && model.selectedProvider != "joycode" {
            count += 1
        }
        return count
    }

    private var providerSelectionLocked: Bool {
        model.busy
    }

    private var quickProviderMenu: some View {
        Menu {
            Button {
                model.selectThreadProvider("codex")
            } label: {
                if model.selectedProvider == "codex" {
                    Label("Codex",systemImage:"checkmark")
                } else {
                    Text("Codex")
                }
            }
            .disabled(!model.localProviderReady && model.selectedProvider != "codex")

            if let profiles = model.localApiSettings?.profiles {
                ForEach(profiles) { profile in
                    Button {
                        model.selectThreadProvider(profile.providerId)
                    } label: {
                        if model.selectedProvider == profile.providerId {
                            Label(profile.label,systemImage:"checkmark")
                        } else {
                            Text(profile.label)
                        }
                    }
                    .disabled(!profile.endpointReady && model.selectedProvider != profile.providerId)
                }
            }

            if model.joyCodeProfileReady || model.selectedProvider == "joycode" {
                Button {
                    model.selectThreadProvider("joycode")
                } label: {
                    if model.selectedProvider == "joycode" {
                        Label("JoyCode",systemImage:"checkmark")
                    } else {
                        Text("JoyCode")
                    }
                }
                .disabled(!model.joyCodeProfileReady)
            }
        } label: {
            quickControlLabel(
                quickProviderLabel,
                systemImage:model.selectedProvider == "joycode" ? "sparkles" :
                    (NativeWorkspace.matchesExternalProvider(model.selectedProvider) ? "server.rack" : "cpu")
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(providerSelectionLocked)
        .help("切换当前会话的 Provider；已有消息保留，默认值只影响新会话")
        .accessibilityLabel("Provider")
        .accessibilityValue(quickProviderLabel)
        .accessibilityIdentifier("agent.provider.quick")
    }

    private var quickModelMenu: some View {
        Menu {
            if model.selectedProvider == "codex" {
                ForEach(model.agentModels) { option in
                    Button {
                        model.selectAgentModel(option.slug)
                    } label: {
                        if model.selectedAgentModel?.slug == option.slug {
                            Label(option.displayName,systemImage:"checkmark")
                        } else {
                            Text(option.displayName)
                        }
                    }
                    .disabled(model.busy)
                }
            } else {
                let label = model.selectedApiModel.isEmpty ? "未配置模型" : model.selectedApiModel
                Button(label) {}
                    .disabled(true)
                Divider()
                Button("前往 Provider 设置…") {
                    model.show(.settings)
                }
                .disabled(model.busy)
            }
        } label: {
            quickControlLabel(quickModelLabel,systemImage:"cube")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.busy || (model.selectedProvider == "codex" && model.agentModels.isEmpty))
        .help(model.selectedProvider == "codex" ? "切换模型" : "当前外部 Provider 模型；模型配置在设置中管理")
        .accessibilityLabel("模型")
        .accessibilityValue(quickModelLabel)
        .accessibilityIdentifier("agent.model.quick")
    }

    private var quickReasoningMenu: some View {
        Menu {
            ForEach(model.selectedReasoningOptions) { option in
                Button {
                    model.selectReasoningEffort(option.effort)
                } label: {
                    let label = reasoningLabel(option.effort)
                    if model.selectedReasoningEffort == option.effort {
                        Label(label,systemImage:"checkmark")
                    } else {
                        Text(label)
                    }
                }
                .disabled(model.busy)
            }
        } label: {
            quickControlLabel(reasoningLabel(model.selectedReasoningEffort),systemImage:"brain.head.profile")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.busy)
        .help("切换当前模型的推理强度")
        .accessibilityLabel("推理强度")
        .accessibilityValue(reasoningLabel(model.selectedReasoningEffort))
        .accessibilityIdentifier("agent.reasoning.quick")
    }

    private var quickRepositoryAccessMenu: some View {
        Menu {
            Button {
                Task { _ = await model.setRepositoryAccessMode("request") }
            } label: {
                if model.repositoryAccessMode == "request" {
                    Label("Request",systemImage:"checkmark")
                } else {
                    Text("Request")
                }
            }

            Button {
                Task { _ = await model.setRepositoryAccessMode("full_access") }
            } label: {
                if model.repositoryAccessMode == "full_access" {
                    Label("Full Access",systemImage:"checkmark")
                } else {
                    Text("Full Access")
                }
            }
        } label: {
            quickControlLabel(
                model.repositoryAccessMode == "full_access" ? "Full Access" : "Request",
                systemImage:model.repositoryAccessMode == "full_access" ? "checkmark.shield" : "lock"
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.busy || model.repositoryAccessLoading)
        .help("当前外部 Provider 的仓库权限")
        .accessibilityLabel("仓库权限")
        .accessibilityValue(model.repositoryAccessMode == "full_access" ? "Full Access" : "Request")
        .accessibilityIdentifier("agent.repository-access.quick")
    }

    private func quickControlLabel(_ title:String,systemImage:String) -> some View {
        HStack(spacing:5) {
            Image(systemName:systemImage)
                .font(.system(size:9,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            Text(title)
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.ink)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName:"chevron.down")
                .font(.system(size:6.5,weight:.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal,5)
        .frame(height:27)
        .contentShape(Rectangle())
    }

    private var quickProviderLabel: String {
        if model.selectedProvider == "codex" { return "Codex" }
        if model.selectedProvider == "joycode" { return "JoyCode" }
        return model.localApiSettings?.profiles.first(where: { $0.providerId == model.selectedProvider })?.label ?? "API"
    }

    private var quickModelLabel: String {
        if model.selectedProvider == "codex" {
            return model.selectedAgentModel?.displayName ?? "模型"
        }
        return model.selectedApiModel.isEmpty ? "模型" : model.selectedApiModel
    }

    private func activityIcon(_ phase: String) -> String {
        switch phase {
        case "tool": return "hammer"
        case "responding": return "text.bubble"
        case "finishing": return "checkmark.circle"
        case "thinking": return "brain.head.profile"
        default: return "bolt"
        }
    }

    private func contextChip(_ title: String, systemImage: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing:6) {
            Image(systemName:systemImage)
                .font(.system(size:9.5,weight:.medium))
            Text(title).lineLimit(1)
            Button(action:remove) {
                Image(systemName:"xmark")
                    .font(.system(size:8,weight:.semibold))
            }
            .buttonStyle(.plain)
        }
        .font(.system(size:10.5,weight:.medium))
        .foregroundStyle(ForgePalette.secondary)
        .padding(.horizontal,8)
        .frame(height:25)
        .background(ForgePalette.softFill,
                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
    }

    private func reasoningLabel(_ effort: String) -> String {
        switch effort.lowercased() {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "XHigh"
        case "max": return "Max"
        case "ultra": return "Ultra"
        case "": return "Reasoning"
        default: return effort
        }
    }
}

@MainActor
private func chooseAgentFiles(_ model: NativeWorkspace) {
    guard let checkoutRoot = model.checkoutRoot else { return }
    let panel = NSOpenPanel()
    panel.directoryURL = checkoutRoot
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    panel.prompt = "添加"
    panel.message = "选择当前 checkout 内的文件作为 Agent 上下文"
    if panel.runModal() == .OK {
        model.addPendingContextFiles(panel.urls)
    }
}

@MainActor
private func chooseAgentImages(_ model: NativeWorkspace) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [.image]
    panel.prompt = "添加"
    if panel.runModal() == .OK {
        model.addPendingImages(panel.urls)
    }
}

private func copyAgentText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text,forType:.string)
}

private struct AgentChangesPane: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var isPresented: Bool
    @State private var commitMessage = ""
    @State private var restoreSnapshot: AgentGitDiff?
    @State private var focusedPath: String?
    @State private var focusedChanges: AgentGitDiff?
    @State private var focusedLoading = false
    @State private var reviewStaged = false

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:9) {
                Image(systemName:"doc.text.magnifyingglass")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(ForgePalette.accent)
                Text("Changes")
                    .font(.system(size:13,weight:.semibold))
                if let changes = model.agentChanges, !changes.nameOnly.isEmpty {
                    Text("\(changes.nameOnly.count)")
                        .font(.system(size:10,weight:.semibold))
                        .padding(.horizontal,7).padding(.vertical,3)
                        .background(ForgePalette.selectionStrong,in:Capsule())
                }
                Picker("Review scope",selection:reviewScopeBinding) {
                    Text("Working").tag(false)
                    Text("Staged").tag(true)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(width:122)
                .disabled(model.changesLoading || focusedLoading)
                .accessibilityIdentifier("changes.scope")
                Spacer(minLength:4)
                Button {
                    focusedPath = nil
                    focusedChanges = nil
                    Task { await model.refreshAgentChanges(staged:reviewStaged) }
                } label: {
                    Image(systemName:"arrow.clockwise")
                        .font(.system(size:11,weight:.medium))
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,
                                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .disabled(model.changesLoading || focusedLoading)
                .help("刷新改动")

                Button {
                    withAnimation(reduceMotion ? nil : .easeOut(duration:0.16)) { isPresented = false }
                } label: {
                    Image(systemName:"xmark")
                        .font(.system(size:10,weight:.semibold))
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,
                                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help("关闭 Changes")
            }
            .padding(14)

            if model.changesLoading {
                VStack(spacing:9) {
                    ProgressView().controlSize(.small)
                    Text("读取当前 checkout…")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let changes = model.agentChanges {
                let reviewed = focusedChanges ?? changes
                ScrollView {
                    VStack(alignment:.leading,spacing:14) {
                        changeScopeHeader(changes)

                        if !changes.untrackedFiles.isEmpty {
                            untrackedChangesNotice(changes.untrackedFiles)
                        }

                        if changes.nameOnly.isEmpty {
                            VStack(spacing:10) {
                                Image(systemName:"checkmark.circle")
                                    .font(.system(size:24,weight:.light))
                                    .foregroundStyle(ForgePalette.secondary)
                                Text(changes.untrackedFiles.isEmpty
                                     ? (changes.staged ? "暂存区没有改动" : "工作区没有未提交改动")
                                     : "没有可审查的 tracked diff")
                                    .font(.system(size:12,weight:.medium))
                                    .foregroundStyle(ForgePalette.secondary)
                            }
                            .frame(maxWidth:.infinity)
                            .padding(.vertical,48)
                        } else {
                            VStack(alignment:.leading,spacing:6) {
                                Button {
                                    focusedPath = nil
                                    focusedChanges = nil
                                } label: {
                                    HStack(spacing:7) {
                                        Image(systemName:"rectangle.stack")
                                            .font(.system(size:10))
                                        Text("All changes")
                                            .font(.system(size:10.5,weight:.medium))
                                        Spacer(minLength:0)
                                        Text("\(changes.nameOnly.count)")
                                            .font(.system(size:9.5))
                                            .foregroundStyle(.tertiary)
                                    }
                                    .padding(.horizontal,9)
                                    .frame(height:29)
                                    .background(focusedPath == nil ? ForgePalette.selectionStrong : ForgePalette.softFill,
                                                in:RoundedRectangle(cornerRadius:8,style:.continuous))
                                }
                                .buttonStyle(.plain)
                                .disabled(focusedLoading)

                                ForEach(changes.nameOnly,id:\.self) { path in
                                    Button {
                                        Task {
                                            focusedLoading = true
                                            let snapshot = await model.reviewAgentChanges(paths:[path],staged:reviewStaged)
                                            focusedLoading = false
                                            if let snapshot {
                                                focusedPath = path
                                                focusedChanges = snapshot
                                            }
                                        }
                                    } label: {
                                        HStack(spacing:8) {
                                            Image(systemName:"doc")
                                                .font(.system(size:10))
                                                .foregroundStyle(ForgePalette.secondary)
                                                .frame(width:14)
                                            VStack(alignment:.leading,spacing:1) {
                                                Text(fileName(path))
                                                    .font(.system(size:10.5,weight:.medium))
                                                    .lineLimit(1)
                                                if !parentPath(path).isEmpty {
                                                    Text(parentPath(path))
                                                        .font(.system(size:9,design:.monospaced))
                                                        .foregroundStyle(.tertiary)
                                                        .lineLimit(1)
                                                        .truncationMode(.middle)
                                                }
                                            }
                                            Spacer(minLength:0)
                                        }
                                        .padding(.horizontal,9)
                                        .frame(height:29)
                                        .background(focusedPath == path ? ForgePalette.selectionStrong : ForgePalette.softFill,
                                                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(focusedLoading)
                                }
                            }

                            if focusedLoading {
                                HStack(spacing:7) {
                                    ProgressView().controlSize(.small)
                                    Text("读取文件 diff…")
                                        .font(.system(size:10.5))
                                        .foregroundStyle(ForgePalette.secondary)
                                }
                            } else {
                                HStack(spacing:8) {
                                    if !reviewed.stat.isEmpty {
                                        Text(reviewed.stat)
                                            .font(.system(size:9.5,design:.monospaced))
                                            .foregroundStyle(ForgePalette.secondary)
                                            .lineLimit(1)
                                            .textSelection(.enabled)
                                    }
                                    Spacer(minLength:8)
                                    if !reviewed.patch.isEmpty {
                                        Button {
                                            copyAgentText(reviewed.patch)
                                        } label: {
                                            Label("Copy patch",systemImage:"doc.on.doc")
                                                .font(.system(size:9.5,weight:.medium))
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(ForgePalette.secondary)
                                        .help("复制当前已审查 diff")
                                    }
                                }
                            }

                            if !focusedLoading && !reviewed.patch.isEmpty {
                                AgentDiffPatchView(patch:reviewed.patch)
                            }

                            if reviewed.truncated {
                                Label("Diff 已按 20 KB 上限截断，不能提交",systemImage:"exclamationmark.triangle")
                                    .font(.system(size:10.5))
                                    .foregroundStyle(ForgePalette.secondary)
                            }

                            VStack(alignment:.leading,spacing:8) {
                                HStack {
                                    Label("Commit reviewed changes",systemImage:"checkmark.seal")
                                        .font(.system(size:11,weight:.semibold))
                                    Spacer()
                                    Text(focusedPath ?? "\(reviewed.nameOnly.count) files")
                                        .font(.system(size:10))
                                        .foregroundStyle(.tertiary)
                                }
                                TextField("Commit message",text:$commitMessage)
                                    .textFieldStyle(.plain)
                                    .font(.system(size:11.5))
                                    .padding(.horizontal,10)
                                    .frame(height:32)
                                    .background(ForgePalette.canvas,
                                                in:RoundedRectangle(cornerRadius:8,style:.continuous))
                                HStack(spacing:8) {
                                    Text("提交前会重新核对 patch / HEAD / branch / checkout")
                                        .font(.system(size:9.5))
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(2)
                                    Spacer(minLength:8)
                                    if reviewed.staged {
                                        Text("Staged 仅支持提交")
                                            .font(.system(size:9.5,weight:.medium))
                                            .foregroundStyle(.tertiary)
                                            .help("不跨越 index 边界执行 Discard")
                                    } else {
                                        Button(role:.destructive) {
                                            restoreSnapshot = reviewed
                                        } label: {
                                            Label("Discard",systemImage:"arrow.uturn.backward.circle")
                                                .font(.system(size:11,weight:.semibold))
                                                .padding(.horizontal,9)
                                                .frame(height:29)
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(.red)
                                        .disabled(model.changesLoading || focusedLoading
                                                  || reviewed.truncated || reviewed.patch.isEmpty)
                                        .help("放弃当前已复查的 tracked / unstaged 改动")
                                    }
                                    Button {
                                        let snapshot = reviewed
                                        let message = commitMessage
                                        Task {
                                            if await model.commitAgentChanges(snapshot,message:message) {
                                                commitMessage = ""
                                                focusedPath = nil
                                                focusedChanges = nil
                                            }
                                        }
                                    } label: {
                                        Label("Commit",systemImage:"checkmark.circle.fill")
                                            .font(.system(size:11,weight:.semibold))
                                            .padding(.horizontal,10)
                                            .frame(height:29)
                                            .background(ForgePalette.selectionStrong,
                                                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(model.changesLoading || focusedLoading || reviewed.truncated
                                              || reviewed.patch.isEmpty
                                              || commitMessage.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                                }
                            }
                            .padding(10)
                            .background(ForgePalette.softFill,
                                        in:RoundedRectangle(cornerRadius:11,style:.continuous))
                        }
                    }
                    .padding(.horizontal,14).padding(.bottom,14)
                }
            } else {
                VStack(spacing:10) {
                    Image(systemName:"doc.text.magnifyingglass")
                        .font(.system(size:24,weight:.light))
                        .foregroundStyle(ForgePalette.secondary)
                    Text("打开 Changes 后读取当前 checkout")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity)
            }
        }
        .onChange(of:model.agentChanges?.staged) { staged in
            if let staged { reviewStaged = staged }
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
        .background(ForgePalette.canvas.opacity(0.34))
        .alert("放弃已审查改动？",isPresented:Binding(
            get:{ restoreSnapshot != nil },
            set:{ if !$0 { restoreSnapshot = nil } }
        )) {
            Button("取消",role:.cancel) { restoreSnapshot = nil }
            Button("放弃改动",role:.destructive) {
                guard let snapshot = restoreSnapshot else { return }
                restoreSnapshot = nil
                Task {
                    if await model.restoreAgentChanges(snapshot) {
                        focusedPath = nil
                        focusedChanges = nil
                    }
                }
            }
        } message: {
            Text("只恢复当前已审查的 tracked / unstaged 文件。staged、untracked 或已变化的 patch 会被拒绝。")
        }
        .accessibilityElement(children:.contain)
        .accessibilityLabel("Agent Changes")
    }

    private var reviewScopeBinding: Binding<Bool> {
        Binding(
            get:{ reviewStaged },
            set:{ staged in switchReviewScope(staged) }
        )
    }

    private func switchReviewScope(_ staged: Bool) {
        guard reviewStaged != staged else { return }
        reviewStaged = staged
        focusedPath = nil
        focusedChanges = nil
        Task { await model.refreshAgentChanges(staged:staged) }
    }

    private func untrackedChangesNotice(_ paths:[String]) -> some View {
        VStack(alignment:.leading,spacing:7) {
            HStack(spacing:7) {
                Image(systemName:"questionmark.square.dashed")
                    .foregroundStyle(Color.orange)
                Text("\(paths.count) 个未跟踪文件尚未进入可审查 patch")
                    .font(.system(size:10.5,weight:.semibold))
            }
            ForEach(Array(paths.prefix(4)),id:\.self) { path in
                Text(path)
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if paths.count > 4 {
                Text("另有 \(paths.count - 4) 个未跟踪文件")
                    .font(.system(size:9.5))
                    .foregroundStyle(.tertiary)
            }
            Text("Git 在 add 前没有 tracked diff；Forge 不会把这些文件自动纳入 Commit 或 Discard。")
                .font(.system(size:9.5))
                .foregroundStyle(.tertiary)
                .lineSpacing(2)
        }
        .padding(10)
        .background(Color.orange.opacity(0.055),
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
        .accessibilityIdentifier("changes.untracked")
    }

    private func changeScopeHeader(_ changes: AgentGitDiff) -> some View {
        VStack(alignment:.leading,spacing:8) {
            HStack(spacing:8) {
                Label(changes.branch,systemImage:"arrow.triangle.branch")
                    .font(.system(size:11,weight:.semibold))
                    .lineLimit(1)
                Spacer(minLength:8)
                Text(changes.staged ? "STAGED" : "WORKING TREE")
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(changes.staged ? ForgePalette.accent : ForgePalette.secondary)
                    .padding(.horizontal,7)
                    .frame(height:20)
                    .background(changes.staged ? ForgePalette.selectionStrong : ForgePalette.softFill,
                                in:Capsule())
            }
            HStack(spacing:7) {
                Text(String(changes.head.prefix(10)))
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                Text("·")
                    .foregroundStyle(.quaternary)
                Text("\(changes.nameOnly.count) files")
                    .font(.system(size:9.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer(minLength:0)
                Text("checkout \(String(changes.checkoutId.prefix(8)))")
                    .font(.system(size:9,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(10)
        .background(ForgePalette.raisedSurface,
                    in:RoundedRectangle(cornerRadius:11,style:.continuous))
        .overlay(RoundedRectangle(cornerRadius:11,style:.continuous)
            .stroke(Color.primary.opacity(0.05),lineWidth:0.7))
    }

    private func fileName(_ path: String) -> String {
        path.split(separator:"/").last.map(String.init) ?? path
    }

    private func parentPath(_ path: String) -> String {
        let parts = path.split(separator:"/")
        guard parts.count > 1 else { return "" }
        return parts.dropLast().joined(separator:"/")
    }
}

private struct AgentDiffPatchView: View {
    let patch: String

    private var lines: [String] {
        patch.split(separator:"\n",omittingEmptySubsequences:false).map(String.init)
    }

    var body: some View {
        LazyVStack(alignment:.leading,spacing:0) {
            ForEach(Array(lines.enumerated()),id:\.offset) { _, line in
                Text(line.isEmpty ? " " : line)
                    .font(.system(size:10,design:.monospaced))
                    .foregroundStyle(foreground(line))
                    .textSelection(.enabled)
                    .padding(.horizontal,9)
                    .padding(.vertical,1.5)
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .background(background(line))
            }
        }
        .padding(.vertical,7)
        .background(ForgePalette.softFill,
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
        .clipShape(RoundedRectangle(cornerRadius:10,style:.continuous))
        .overlay(RoundedRectangle(cornerRadius:10,style:.continuous)
            .stroke(Color.primary.opacity(0.05),lineWidth:0.5))
    }

    private func background(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.07) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.065) }
        if line.hasPrefix("@@") { return ForgePalette.selection.opacity(0.72) }
        return .clear
    }

    private func foreground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.82) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.80) }
        if line.hasPrefix("@@") || line.hasPrefix("diff --git") { return ForgePalette.secondary }
        return ForgePalette.ink
    }
}

private struct PlanningAuthoringContext: Identifiable {
    enum Kind { case requirement, plan }
    let id = UUID()
    let kind: Kind
    let requirementId: String?
    let parentPlanId: String?
}

private struct AutopilotApprovalContext: Identifiable {
    let requirement: RequirementRecordDetail
    var id: String { requirement.requirementId }
}

private struct AgentPlanningInspector: View {
    @ObservedObject var model: NativeWorkspace
    let dismiss: () -> Void
    @State private var records: [ForgeRecord] = []
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var loadToken = UUID()
    @State private var loadedRepoId: String?

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.top,spacing:10) {
                VStack(alignment:.leading,spacing:3) {
                    Text("规划上下文").font(.system(size:13,weight:.semibold))
                    Text("选择只会绑定当前会话，不修改 Requirement / Plan。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName:"xmark")
                        .font(.system(size:9,weight:.semibold))
                        .frame(width:24,height:24)
                }
                .buttonStyle(.plain)
                .help("关闭规划上下文")
                .accessibilityLabel("关闭规划上下文")
                .accessibilityIdentifier("agent.planning-inspector.close")
            }
            .padding(.horizontal,14).padding(.vertical,12)

            Divider()
            HStack(alignment:.top,spacing:9) {
                Image(systemName:currentBoundRecord == nil ? "paperclip" : "paperclip.circle.fill")
                    .font(.system(size:10,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:18,height:18)
                VStack(alignment:.leading,spacing:3) {
                    Text("当前会话")
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(.tertiary)
                    if let record=currentBoundRecord {
                        Text(record.title)
                            .font(.system(size:11.5,weight:.semibold))
                            .lineLimit(2)
                        Text(currentContextLabel ?? record.recordId)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    } else if let contextLabel=currentContextLabel {
                        Text(contextLabel)
                            .font(.system(size:10.5,weight:.medium,design:.monospaced))
                            .lineLimit(1).truncationMode(.middle)
                    } else {
                        Text("未绑定规划 · 会话可以直接工作")
                            .font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                }
                Spacer(minLength:6)
                if currentContextLabel != nil {
                    Button("移除") {
                        model.clearCurrentThreadPlanningContext()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size:10.5,weight:.medium))
                    .disabled(model.busy)
                    .accessibilityIdentifier("agent.planning-inspector.clear")
                }
            }
            .padding(.horizontal,14).padding(.vertical,11)
            .accessibilityIdentifier("agent.planning-inspector.current")

            Divider()

            HStack(spacing:7) {
                Image(systemName:"magnifyingglass")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                TextField("筛选 Requirement / Plan",text:$query)
                    .textFieldStyle(.plain)
                    .font(.system(size:11))
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName:"xmark.circle.fill").font(.system(size:9))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除规划筛选")
                }
            }
            .padding(.horizontal,10).frame(height:32)
            .background(ForgePalette.softFill)
            .padding(.horizontal,14).padding(.top,9).padding(.bottom,7)

            HStack {
                Text(query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? "可绑定规划" : "筛选结果")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer()
                if !loading {
                    Text("\(availableRecords.count)")
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal,14).padding(.bottom,5)

            if loading && records.isEmpty {
                ProgressView("正在读取规划…").controlSize(.small)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let error {
                VStack(alignment:.leading,spacing:7) {
                    Label("规划暂不可用",systemImage:"exclamationmark.circle")
                        .font(.system(size:11,weight:.medium))
                    Text(error).font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    Button("重试") { Task { await reload() } }
                        .buttonStyle(.plain).font(.system(size:10.5,weight:.medium))
                }
                .padding(14).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            } else if availableRecords.isEmpty {
                Text(query.isEmpty ? "当前没有其他可绑定的 Requirement / Plan。" : "没有匹配的规划记录。")
                    .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                    .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                    .padding(14)
            } else {
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:0) {
                        ForEach(Array(availableRecords.prefix(10))) { record in
                            planningRow(record)
                            Divider().padding(.leading,38)
                        }
                    }
                }
                .scrollIndicators(.automatic)
            }

            Divider()
            HStack {
                Text("绑定只影响当前会话，不会修改 Requirement / Plan。")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                Spacer()
                if loading { ProgressView().controlSize(.mini) }
            }
            .padding(.horizontal,14).frame(height:34)
        }
        .frame(width:390,height:455)
        .task(id:model.repoId) { await reload() }
    }

    private var currentContextLabel: String? {
        if let planId=model.thread?.planId,!planId.isEmpty { return "Plan · \(String(planId.prefix(18)))" }
        if let requirementId=model.thread?.requirementId,!requirementId.isEmpty {
            return "Requirement · \(String(requirementId.prefix(18)))"
        }
        return nil
    }

    private var currentBoundRecord: ForgeRecord? {
        if let planId=model.thread?.planId,!planId.isEmpty {
            return records.first { $0.kind == .plan && $0.recordId == planId }
        }
        if let requirementId=model.thread?.requirementId,!requirementId.isEmpty {
            return records.first { $0.kind == .requirement && $0.recordId == requirementId }
        }
        return nil
    }

    private var availableRecords: [ForgeRecord] {
        prioritizedRecords.filter { record in
            if record.kind == .plan { return record.recordId != model.thread?.planId }
            return !(model.thread?.planId == nil && record.recordId == model.thread?.requirementId)
        }
    }

    private var prioritizedRecords: [ForgeRecord] {
        let needle=query.trimmingCharacters(in:.whitespacesAndNewlines)
        let filtered = records.filter { record in
            needle.isEmpty
                || record.title.localizedCaseInsensitiveContains(needle)
                || record.recordId.localizedCaseInsensitiveContains(needle)
        }
        return filtered.enumerated().sorted { lhs,rhs in
            let lp=priority(lhs.element),rp=priority(rhs.element)
            return lp == rp ? lhs.offset < rhs.offset : lp < rp
        }.map(\.element)
    }

    private func priority(_ record:ForgeRecord) -> Int {
        if record.kind == .plan,record.recordId == model.thread?.planId { return 0 }
        if record.kind == .requirement,record.recordId == model.thread?.requirementId { return 1 }
        if let requirementId=model.thread?.requirementId,record.requirementId == requirementId { return 2 }
        if record.kind == .requirement,record.state == "open" { return 3 }
        if record.kind == .requirement { return 4 }
        return 5 + min(record.depth,4)
    }

    private func planningRow(_ record:ForgeRecord) -> some View {
        let bound = record.kind == .plan
            ? model.thread?.planId == record.recordId
            : (model.thread?.planId == nil && model.thread?.requirementId == record.recordId)
        return Button {
            if record.kind == .plan {
                model.bindCurrentThreadPlanningContext(requirementId:record.requirementId,planId:record.recordId)
            } else {
                model.bindCurrentThreadPlanningContext(requirementId:record.recordId,planId:nil)
            }
        } label: {
            HStack(alignment:.top,spacing:9) {
                Image(systemName:record.kind == .requirement ? "doc.text" : "list.bullet.rectangle")
                    .font(.system(size:10))
                    .foregroundStyle(bound ? ForgePalette.ink : ForgePalette.secondary)
                    .frame(width:18,height:18)
                VStack(alignment:.leading,spacing:3) {
                    Text(record.title)
                        .font(.system(size:11.5,weight:bound ? .semibold : .medium))
                        .foregroundStyle(ForgePalette.ink)
                        .lineLimit(2)
                    HStack(spacing:6) {
                        Text(record.kind == .requirement ? "Requirement" : "Plan")
                        if record.kind == .requirement { Text(record.state) }
                    }
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                }
                Spacer(minLength:5)
                if bound {
                    Image(systemName:"checkmark")
                        .font(.system(size:9.5,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                } else {
                    Text("绑定")
                        .font(.system(size:9.5,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                }
            }
            .padding(.horizontal,14).padding(.vertical,9)
            .contentShape(Rectangle())
            .background(bound ? ForgePalette.selection.opacity(0.65) : .clear)
        }
        .buttonStyle(.plain)
        .disabled(model.busy || loadedRepoId != model.repoId)
        .accessibilityLabel(record.title + "，" + (bound ? "已绑定当前会话" : "绑定到当前会话"))
        .accessibilityIdentifier("agent.planning-inspector.bind.\(record.recordId)")
    }

    @MainActor
    private func reload() async {
        let token=UUID()
        loadToken=token
        records=[]
        loadedRepoId=nil
        error=nil
        guard let repoId=model.repoId else { loading=false; return }
        loading=true
        defer { if loadToken == token { loading=false } }
        do {
            let fresh=try await model.readPlanningRecordsForCurrentProject()
            guard loadToken == token, model.repoId == repoId, !Task.isCancelled else { return }
            records=fresh
            loadedRepoId=repoId
        } catch {
            guard loadToken == token, model.repoId == repoId, !Task.isCancelled else { return }
            self.error=error.localizedDescription
        }
    }
}

private struct AgentKnowledgeInspector: View {
    @ObservedObject var model: NativeWorkspace
    let dismiss: () -> Void
    @State private var query = ""
    @State private var result: KnowledgeAuditDetail?
    @State private var loading = false
    @State private var error: String?
    @State private var loadToken = UUID()
    @State private var expandedMemoryIds: Set<String> = []
    @State private var resultOrigin: (repoId: String, threadId: String)?

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.top,spacing:10) {
                VStack(alignment:.leading,spacing:3) {
                    Text("项目知识").font(.system(size:13,weight:.semibold))
                    Text("先看可复用判断；加入当前草稿后仍可编辑，不会自动发送。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName:"xmark")
                        .font(.system(size:9,weight:.semibold))
                        .frame(width:24,height:24)
                }
                .buttonStyle(.plain)
                .help("关闭项目知识")
                .accessibilityLabel("关闭项目知识")
                .accessibilityIdentifier("agent.knowledge-inspector.close")
            }
            .padding(.horizontal,14).padding(.vertical,12)
            Divider()

            HStack(spacing:7) {
                Image(systemName:"magnifyingglass")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                TextField("搜索经验、概念、技术决策",text:$query)
                    .textFieldStyle(.plain)
                    .font(.system(size:11))
                    .onSubmit { Task { await reload() } }
                    .accessibilityIdentifier("agent.knowledge-inspector.search")
                if !query.isEmpty {
                    Button {
                        query=""
                        Task { await reload() }
                    } label: {
                        Image(systemName:"xmark.circle.fill").font(.system(size:9))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除知识搜索")
                }
            }
            .padding(.horizontal,10).frame(height:32)
            .background(ForgePalette.softFill)
            .padding(.horizontal,14).padding(.top,9).padding(.bottom,7)

            HStack {
                Text(query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? "当前项目知识" : "搜索结果")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer()
                if let result,!loading {
                    Text("\(result.items.count)")
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal,14).padding(.bottom,5)

            if loading && result == nil {
                ProgressView("正在读取知识…").controlSize(.small)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let error {
                VStack(alignment:.leading,spacing:7) {
                    Label("知识暂不可用",systemImage:"exclamationmark.circle")
                        .font(.system(size:11,weight:.medium))
                    Text(error).font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    Button("重试") { Task { await reload() } }
                        .buttonStyle(.plain).font(.system(size:10.5,weight:.medium))
                }
                .padding(14).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            } else if memories.isEmpty {
                Text("没有匹配的知识记录。")
                    .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                    .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                    .padding(14)
            } else {
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:0) {
                        ForEach(memories) { memory in
                            knowledgeRow(memory)
                            Divider().padding(.leading,14)
                        }
                    }
                }
                .scrollIndicators(.automatic)
            }

            Divider()
            HStack(spacing:6) {
                if let result {
                    Text("\(result.items.count) 条结果")
                    if result.truncated { Text("· 已截断") }
                } else {
                    Text("只读 · advisory")
                }
                if result != nil { Text("· 按 Cognitive 返回顺序") }
                Spacer()
                if loading { ProgressView().controlSize(.mini) }
            }
            .font(.system(size:9.5)).foregroundStyle(.tertiary)
            .padding(.horizontal,14).frame(height:34)
        }
        .frame(width:410,height:455)
        .task(id:[model.repoId ?? "", model.selectedThreadId ?? ""]) { await reload() }
    }

    private var memories:[KnowledgeMemoryDetail] {
        result?.items.map(\.memory) ?? []
    }

    private func knowledgeRow(_ memory:KnowledgeMemoryDetail) -> some View {
        let expanded = expandedMemoryIds.contains(memory.id)
        let alreadyInDraft = model.draft.contains(memory.canonicalText)
        return VStack(alignment:.leading,spacing:6) {
            HStack(spacing:6) {
                Text(scopeLabel(memory.scope.kind))
                    .font(.system(size:9,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                if let concept=memory.concepts.first,!concept.isEmpty {
                    Text(concept).font(.system(size:9.5,weight:.medium))
                }
                Spacer()
                Button(alreadyInDraft ? "已在草稿" : "加入草稿") {
                    guard !alreadyInDraft,
                          let origin=resultOrigin,
                          origin.repoId == model.repoId,
                          origin.threadId == model.selectedThreadId else { return }
                    model.useKnowledgeInCurrentConversation(memory,expectedThreadId:origin.threadId)
                }
                .buttonStyle(.plain)
                .font(.system(size:10,weight:.semibold))
                .foregroundStyle(alreadyInDraft ? ForgePalette.secondary.opacity(0.55) : ForgePalette.secondary)
                .disabled(alreadyInDraft || model.busy || resultOrigin?.repoId != model.repoId
                          || resultOrigin?.threadId != model.selectedThreadId)
                .accessibilityIdentifier("agent.knowledge-inspector.use.\(memory.id)")
            }
            Text(memory.canonicalText)
                .font(.system(size:11)).lineSpacing(3)
                .foregroundStyle(ForgePalette.ink)
                .lineLimit(expanded ? nil : 3)
                .fixedSize(horizontal:false,vertical:expanded)
                .textSelection(.enabled)
            if memory.canonicalText.count > 110 {
                Button(expanded ? "收起全文" : "展开全文") {
                    if !expandedMemoryIds.insert(memory.id).inserted {
                        expandedMemoryIds.remove(memory.id)
                    }
                }
                .buttonStyle(.plain)
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .accessibilityIdentifier("agent.knowledge-inspector.expand.\(memory.id)")
            }
        }
        .padding(.horizontal,14).padding(.vertical,10)
    }

    private func scopeLabel(_ kind:String) -> String {
        switch kind { case "project": return "项目"; case "workspace": return "工作空间"; default: return kind }
    }

    @MainActor
    private func reload() async {
        let token=UUID()
        loadToken=token
        result=nil
        resultOrigin=nil
        expandedMemoryIds=[]
        error=nil
        guard let repoId=model.repoId,
              let threadId=model.selectedThreadId else { loading=false; return }
        let searchQuery=query.trimmingCharacters(in:.whitespacesAndNewlines)
        loading=true
        defer { if loadToken == token { loading=false } }
        do {
            let fresh=try await model.readKnowledge(searchQuery)
            guard loadToken == token, model.repoId == repoId,
                  model.selectedThreadId == threadId,
                  query.trimmingCharacters(in:.whitespacesAndNewlines) == searchQuery,
                  !Task.isCancelled else { return }
            result=fresh
            resultOrigin=(repoId,threadId)
        } catch {
            guard loadToken == token, model.repoId == repoId,
                  model.selectedThreadId == threadId,
                  query.trimmingCharacters(in:.whitespacesAndNewlines) == searchQuery,
                  !Task.isCancelled else { return }
            self.error=error.localizedDescription
        }
    }
}

private struct RecordsPane: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var authoring: PlanningAuthoringContext?
    @State private var autopilotApproval: AutopilotApprovalContext?
    @State private var draftTitle = ""
    @State private var draftOutcome = ""
    @State private var draftCriteria = ""
    @State private var autopilotModel = "deepseek-chat"
    @State private var autopilotTokenBudget = "50000"
    @State private var autopilotTurnBudget = "12"
    @State private var autopilotToolBudget = "32"
    @State private var autopilotCheckpoints = Set<String>()
    @State private var saving = false
    @State private var autopilotSaving = false

    @State private var planningViewMode = "list"
    @State private var hoveredPlanningRecordId: String?
    @State private var planningSearch = ""
    @State private var collapsedPlanningRecordIds = Set<String>()
    @State private var planningZoom: CGFloat = 1
    @State private var planningFitToView = false
    @State private var planningFitScale: CGFloat = 1
    @State private var planningShowUnlinked = false
    @State private var planningScrollTarget: String?

    private let planningNodeWidth: CGFloat = 228
    private let planningNodeHeight: CGFloat = 92
    private let planningColumnGap: CGFloat = 66
    private let planningRowGap: CGFloat = 30
    private let planningLaneHeaderHeight: CGFloat = 36

    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < 900
            HStack(spacing:0) {
                if !compact || model.selectedRecord == nil {
                    planningNavigator
                        .frame(minWidth:compact ? 0 : 520,maxWidth:.infinity)
                        .padding(.leading,compact ? 8 : 12)
                }

            if let selected = model.records.first(where:{$0.id == model.selectedRecord}) {
                ScrollView {
                    VStack(alignment:.leading,spacing:17) {
                        HStack(alignment:.top,spacing:12) {
                            VStack(alignment:.leading,spacing:7) {
                                Text(selected.title).font(.system(size:18,weight:.medium))
                                Text(planningNodeRole(selected))
                                    .font(.system(size:10,weight:.semibold))
                                    .foregroundStyle(ForgePalette.secondary)
                                Text(selected.recordId).font(.system(size:9.5,design:.monospaced))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer()
                            Button {
                                model.clearRecordSelection()
                            } label: {
                                if compact {
                                    Label("返回规划",systemImage:"chevron.left")
                                        .font(.system(size:11,weight:.medium))
                                } else {
                                    Image(systemName:"xmark")
                                        .font(.system(size:9,weight:.semibold))
                                        .frame(width:24,height:24)
                                }
                            }
                            .buttonStyle(.plain)
                            .help("关闭详情，返回规划")
                            .accessibilityIdentifier("planning.detail.back")
                        }

                        if let recordDetail = model.recordDetail {
                            semanticRecordDetail(recordDetail)
                        }
                    }
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .padding(.horizontal,18).padding(.vertical,20)
                }
                .frame(minWidth:compact ? 0 : 280,
                       idealWidth:compact ? geometry.size.width : 330,
                       maxWidth:compact ? .infinity : 390)
                .overlay(alignment:.leading) {
                    if !compact {
                        Rectangle()
                            .fill(Color.primary.opacity(0.09))
                            .frame(width:1)
                    }
                }
                .padding(.trailing,compact ? 8 : 12)
                .transition(reduceMotion ? .identity : .move(edge:.trailing).combined(with:.opacity))
            }
            }
        }
        .background(ForgePalette.canvas)
        .sheet(item:$authoring) { context in
            planningAuthoringSheet(context)
        }
        .sheet(item:$autopilotApproval) { context in
            autopilotApprovalSheet(context)
        }
        .task(id:planningOperationalRefreshKey) {
            guard scenePhase == .active,!model.planningRequirementIds.isEmpty else { return }
            await model.refreshPlanningAutopilotStatuses()
            while !Task.isCancelled {
                do { try await Task.sleep(for:.seconds(12)) }
                catch { return }
                guard !Task.isCancelled else { return }
                await model.refreshPlanningAutopilotStatuses()
            }
        }
    }

    private var planningOperationalRefreshKey: String {
        "\(model.repoId ?? "none")|\(scenePhase == .active ? "active" : "inactive")|\(model.planningRequirementIds.joined(separator:"|"))"
    }

    private var planningOverview: some View {
        let requirements=model.records.filter { $0.kind == .requirement }
        let plans=model.records.filter { $0.kind == .plan }
        let openCount=requirements.filter { $0.state == "open" }.count
        let completedCount=requirements.filter { $0.state == "completed" }.count
        return HStack(spacing:12) {
            Image(systemName:"folder")
                .foregroundStyle(ForgePalette.secondary)
            VStack(alignment:.leading,spacing:2) {
                Text("当前项目")
                    .font(.system(size:9))
                    .foregroundStyle(ForgePalette.secondary)
                Text(model.project?.label ?? model.repoId ?? "未选择项目")
                    .font(.system(size:11,weight:.semibold))
                    .lineLimit(1)
            }
            Spacer(minLength:4)
            VStack(alignment:.trailing,spacing:3) {
                Text("Requirement \(requirements.count)  ·  Plan \(plans.count)")
                    .font(.system(size:10,weight:.medium))
                Text("开放 \(openCount)  ·  已完成 \(completedCount)  ·  执行进度以真实验收为准")
                    .font(.system(size:9))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal,12).padding(.vertical,10)
        .overlay(alignment:.bottom) { Divider() }
        .accessibilityIdentifier("planning.project.overview")
    }

    private var planningNavigator: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.top,spacing:8) {
                VStack(alignment:.leading,spacing:4) {
                    Text("规划结构")
                        .font(.system(size:13,weight:.semibold))
                    Text("从左到右表示语义层级；不是执行顺序")
                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer(minLength:4)
                Button { beginRequirement() } label: {
                    Image(systemName:"doc.badge.plus")
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help("新建 Requirement（可选）")
                .disabled(model.repoId == nil)
                Button { beginPlan(requirementId:nil,parentPlanId:nil) } label: {
                    Image(systemName:"plus")
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help("直接新建独立 Plan；不要求 Requirement")
                .disabled(model.repoId == nil)
            }
            .padding(.horizontal,13).padding(.top,13).padding(.bottom,9)

            planningOverview
                .padding(.horizontal,13).padding(.bottom,12)

            HStack(spacing:8) {
                Picker("规划视图",selection:$planningViewMode) {
                    Label("关系图",systemImage:"point.3.connected.trianglepath.dotted").tag("map")
                    Label("列表",systemImage:"list.bullet").tag("list")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width:168)
                .onChange(of:planningViewMode) { mode in
                    guard mode == "map",
                          let selectedId=model.selectedRecord,
                          let selected=model.records.first(where:{$0.id == selectedId}),
                          planningParent(of:selected) == nil,
                          (planningChildrenByParent[selected.id] ?? []).isEmpty else { return }
                    planningShowUnlinked = true
                    planningScrollTarget = selected.id
                }

                HStack(spacing:6) {
                    Image(systemName:"magnifyingglass")
                        .font(.system(size:9.5))
                        .foregroundStyle(ForgePalette.secondary)
                    TextField("查找 Requirement / Plan",text:$planningSearch)
                        .textFieldStyle(.plain)
                        .font(.system(size:10.5))
                        .onSubmit {
                            if let first=planningSearchMatches.first {
                                locatePlanningRecord(first)
                            }
                        }
                        .accessibilityIdentifier("planning.search.field")
                    if !planningSearch.isEmpty {
                        Button {
                            planningSearch = ""
                        } label: {
                            Image(systemName:"xmark.circle.fill")
                                .font(.system(size:9.5))
                                .foregroundStyle(ForgePalette.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("清除")
                    }
                }
                .padding(.horizontal,8)
                .frame(minWidth:110,idealWidth:155,maxWidth:190,minHeight:25)
                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))

                if let focus=planningExecutionFocusRecord,
                   let status=planningExecutionStatus(focus) {
                    Button {
                        locatePlanningRecord(focus)
                    } label: {
                        HStack(spacing:4) {
                            Circle()
                                .fill(planningExecutionColor(status))
                                .frame(width:5.5,height:5.5)
                            Image(systemName:"scope")
                                .font(.system(size:10,weight:.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    .help("定位执行焦点 · \(planningExecutionLabel(focus,status)) · \(focus.recordId)")
                    .accessibilityLabel("定位执行焦点")
                    .accessibilityValue("\(planningExecutionLabel(focus,status)) · \(focus.recordId)")
                    .accessibilityIdentifier("planning.execution.focus")
                }

                if let refreshError=model.planningAutopilotStatusError {
                    Button {
                        Task { await model.refreshPlanningAutopilotStatuses() }
                    } label: {
                        Image(systemName:"exclamationmark.triangle.fill")
                            .font(.system(size:10))
                            .foregroundStyle(.orange)
                    }
                    .buttonStyle(.plain)
                    .help("执行态刷新失败，点击重试\n\(refreshError)")
                    .accessibilityLabel("执行态刷新失败，点击重试")
                    .accessibilityIdentifier("planning.execution.refresh-error")
                }

                if planningViewMode == "map" {
                    Button {
                        planningFitToView = true
                        planningScrollTarget = "planning.origin"
                    } label: {
                        Image(systemName:"arrow.left.and.right")
                    }
                    .buttonStyle(.plain)
                    .help("适配关系宽度并回到起点")
                    .accessibilityIdentifier("planning.zoom.fit")

                    Button {
                        let base=planningFitToView ? planningFitScale : planningZoom
                        planningZoom = max(0.55,base - 0.1)
                        planningFitToView = false
                    } label: {
                        Image(systemName:"minus.magnifyingglass")
                    }
                    .buttonStyle(.plain)
                    .help("缩小")
                    .accessibilityIdentifier("planning.zoom.out")

                    Text(planningFitToView ? "适配宽度" : "\(Int(planningZoom * 100))%")
                        .font(.system(size:9,design:.monospaced))
                        .foregroundStyle(ForgePalette.secondary)
                        .frame(minWidth:32)

                    Button {
                        let base=planningFitToView ? planningFitScale : planningZoom
                        planningZoom = min(1.6,base + 0.1)
                        planningFitToView = false
                    } label: {
                        Image(systemName:"plus.magnifyingglass")
                    }
                    .buttonStyle(.plain)
                    .help("放大")
                    .accessibilityIdentifier("planning.zoom.in")
                }

                Spacer(minLength:0)

                if planningViewMode == "map",!planningUnlinkedRecords.isEmpty {
                    Button {
                        planningShowUnlinked.toggle()
                        planningFitToView = false
                        planningScrollTarget = "planning.origin"
                    } label: {
                        HStack(spacing:4) {
                            Image(systemName:planningShowUnlinked ? "eye.slash" : "circle.dashed")
                                .font(.system(size:8.5,weight:.semibold))
                            Text(planningShowUnlinked ? "隐藏未关联" : "未关联 \(planningUnlinkedRecords.count)")
                        }
                        .font(.system(size:9,weight:.medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ForgePalette.secondary)
                    .help(planningShowUnlinked
                          ? "隐藏没有父子关系的 Requirement / Plan"
                          : "显示 \(planningUnlinkedRecords.count) 个没有父子关系的节点")
                    .accessibilityIdentifier("planning.unlinked.toggle")
                }

                if model.selectedRecord != nil {
                    Button("显示全部") { model.clearRecordSelection() }
                        .buttonStyle(.plain)
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(ForgePalette.accent)
                }
            }
            .padding(.horizontal,13).padding(.bottom,7)

            if !planningSearch.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
                planningSearchResults
                    .padding(.horizontal,13)
                    .padding(.top,5)
            }

            planningSelectionContext
                .padding(.horizontal,13)
                .padding(.top,6)

            if planningViewMode == "map" {
                planningRelationLegend
                    .padding(.horizontal,13)
                    .padding(.top,4).padding(.bottom,7)
            } else {
                HStack(spacing:6) {
                    Image(systemName:"list.bullet.indent")
                    Text("列表显示全部规划节点；父级关系写在每一行标题上方")
                    Spacer(minLength:0)
                }
                .font(.system(size:9.2,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .padding(.horizontal,13)
                .padding(.top,6).padding(.bottom,9)
            }

            Divider().opacity(0.55)

            if model.records.isEmpty {
                VStack(alignment:.leading,spacing:8) {
                    Image(systemName:"sparkles.rectangle.stack")
                        .font(.system(size:18))
                        .foregroundStyle(ForgePalette.secondary)
                    Text("这个项目还没有规划树")
                        .font(.system(size:12,weight:.semibold))
                    Text("普通 Agent 不依赖 Requirement。需要长期无人值守或可追踪拆解时，再创建 Requirement / Plan。")
                        .font(.system(size:10.5)).lineSpacing(3)
                        .foregroundStyle(ForgePalette.secondary)
                }
                .padding(15)
                .frame(maxWidth:.infinity,alignment:.leading)
                Spacer(minLength:0)
            } else if planningViewMode == "map" {
                if planningVisibleRecords.isEmpty {
                    VStack(alignment:.leading,spacing:10) {
                        Image(systemName:"point.3.connected.trianglepath.dotted")
                            .font(.system(size:20))
                            .foregroundStyle(ForgePalette.secondary)
                        Text("当前没有父子关系可画")
                            .font(.system(size:12,weight:.semibold))
                        Text("关系图只显示 Requirement → 根 Plan / Plan → 子 Plan。没有关系的节点仍可在列表、搜索或“未关联”中访问。")
                            .font(.system(size:10.5))
                            .foregroundStyle(ForgePalette.secondary)
                            .fixedSize(horizontal:false,vertical:true)
                        if !planningUnlinkedRecords.isEmpty {
                            Button("显示 \(planningUnlinkedRecords.count) 个未关联节点") {
                                planningShowUnlinked = true
                            }
                            .buttonStyle(.plain)
                            .font(.system(size:10,weight:.semibold))
                            .foregroundStyle(ForgePalette.accent)
                        }
                    }
                    .padding(18)
                    .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                } else {
                    planningCanvas
                }
            } else {
                planningList
            }
        }
    }

    private var planningSearchMatches: [ForgeRecord] {
        let needle=planningSearch.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        return Array(model.records.filter {
            $0.title.localizedCaseInsensitiveContains(needle)
                || $0.recordId.localizedCaseInsensitiveContains(needle)
        }.prefix(5))
    }

    private var planningSearchResults: some View {
        VStack(alignment:.leading,spacing:2) {
            if planningSearchMatches.isEmpty {
                Text("没有匹配节点")
                    .font(.system(size:9.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.horizontal,8).padding(.vertical,6)
            } else {
                ForEach(planningSearchMatches) { item in
                    Button {
                        locatePlanningRecord(item)
                    } label: {
                        HStack(spacing:7) {
                            Image(systemName:item.kind == .requirement ? "scope" : "arrow.triangle.branch")
                                .font(.system(size:9.5,weight:.semibold))
                            Text(item.title)
                                .font(.system(size:10.5,weight:.medium))
                                .lineLimit(1)
                            Spacer(minLength:4)
                            Text(item.recordId)
                                .font(.system(size:8.5,design:.monospaced))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal,8).frame(height:27)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("planning.search.result.\(item.recordId)")
                }
            }
        }
        .padding(3)
        .background(.thinMaterial,in:RoundedRectangle(cornerRadius:9,style:.continuous))
    }

    private func planningNodeRole(_ item:ForgeRecord) -> String {
        if item.kind == .requirement { return "需求 · Requirement" }
        if item.parentPlanId != nil { return "子计划 · Plan" }
        if item.requirementId != nil { return "主计划 · Plan" }
        return "独立计划 · Plan"
    }

    private var planningSelectedPath: [ForgeRecord] {
        guard let selectedId=model.selectedRecord,
              let selected=model.records.first(where:{ $0.id == selectedId }) else { return [] }
        var path:[ForgeRecord]=[selected]
        var cursor:ForgeRecord?=selected
        var visited:Set<String>=[selected.id]
        while let current=cursor,
              let parent=planningParent(of:current),
              visited.insert(parent.id).inserted {
            path.append(parent)
            cursor=parent
        }
        return path.reversed()
    }

    private var planningSelectedPathIds: Set<String> {
        Set(planningSelectedPath.map(\.id))
    }

    @ViewBuilder
    private var planningSelectionContext: some View {
        if let selectedId=model.selectedRecord,
           let selected=model.records.first(where:{ $0.id == selectedId }) {
            let children=planningChildrenByParent[selected.id] ?? []
            HStack(spacing:8) {
                Image(systemName:"point.3.connected.trianglepath.dotted")
                    .font(.system(size:10,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)

                ScrollView(.horizontal,showsIndicators:false) {
                    HStack(spacing:5) {
                        ForEach(Array(planningSelectedPath.enumerated()),id:\.element.id) { index,node in
                            if index > 0 {
                                Image(systemName:"chevron.right")
                                    .font(.system(size:7,weight:.bold))
                                    .foregroundStyle(ForgePalette.secondary.opacity(0.65))
                            }
                            Button {
                                locatePlanningRecord(node)
                            } label: {
                                HStack(spacing:4) {
                                    Image(systemName:node.kind == .requirement ? "scope" : "arrow.triangle.branch")
                                        .font(.system(size:8.5,weight:.semibold))
                                    Text(node.title)
                                        .font(.system(size:9.5,weight:node.id == selected.id ? .semibold : .medium))
                                        .lineLimit(1)
                                }
                                .foregroundStyle(node.id == selected.id ? ForgePalette.ink : ForgePalette.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Spacer(minLength:4)

                HStack(spacing:5) {
                    Text(planningNodeRole(selected))
                    if !children.isEmpty {
                        Text("·")
                        Text("\(children.count) 个直接子节点")
                    }
                }
                .font(.system(size:9,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .lineLimit(1)
            }
            .padding(.horizontal,9).padding(.vertical,7)
            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
            .accessibilityIdentifier("planning.selection.path")
        }
    }

    private var planningRelationLegend: some View {
        HStack(spacing:7) {
            Label("Requirement",systemImage:"scope")
            Image(systemName:"arrow.right")
                .font(.system(size:8,weight:.bold))
            Text("拥有根 Plan")
            Image(systemName:"arrow.right")
                .font(.system(size:8,weight:.bold))
            Text("细化为子 Plan")
            Spacer(minLength:4)
            Text(planningShowUnlinked ? "包含未关联节点" : "默认隐藏无关系节点")
                .foregroundStyle(ForgePalette.secondary.opacity(0.82))
        }
        .font(.system(size:9.2,weight:.medium))
        .foregroundStyle(ForgePalette.secondary)
        .accessibilityIdentifier("planning.relationship.legend")
    }

    private func locatePlanningRecord(_ item:ForgeRecord) {
        var cursor:ForgeRecord?=item
        var visited=Set<String>()
        while let current=cursor,visited.insert(current.id).inserted {
            if let parent=planningParent(of:current) {
                collapsedPlanningRecordIds.remove(parent.id)
                cursor=parent
            } else {
                cursor=nil
            }
        }
        if planningParent(of:item) == nil,
           (planningChildrenByParent[item.id] ?? []).isEmpty {
            planningShowUnlinked = true
        }
        planningSearch=""
        planningScrollTarget=item.id
        Task { await model.openRecord(item.id) }
    }

    private var planningListVisibleRecords: [ForgeRecord] {
        // planningRecords is canonical preorder: hiding a collapsed parent's
        // descendants requires no second graph or relationship state.
        var result:[ForgeRecord]=[]
        var hiddenBelowDepth:Int?
        for item in model.records {
            if let depth=hiddenBelowDepth {
                if item.depth > depth { continue }
                hiddenBelowDepth=nil
            }
            result.append(item)
            if collapsedPlanningRecordIds.contains(item.id) {
                hiddenBelowDepth=item.depth
            }
        }
        return result
    }

    private var planningList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment:.leading,spacing:5) {
                    ForEach(planningListVisibleRecords) { item in
                        planningListRow(item).id(item.id)
                    }
                }
                .padding(10)
            }
            .scrollIndicators(.visible)
            .onChange(of:planningScrollTarget) { target in
                guard planningViewMode == "list",let target else { return }
                DispatchQueue.main.async {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                        proxy.scrollTo(target,anchor:.center)
                    }
                    planningScrollTarget=nil
                }
            }
        }
    }

    private func planningListRow(_ item:ForgeRecord) -> some View {
        let parent=planningParent(of:item)
        let children=planningChildrenByParent[item.id] ?? []
        let collapsed=collapsedPlanningRecordIds.contains(item.id)
        return HStack(spacing:4) {
            Button {
                Task { await model.openRecord(item.id) }
            } label: {
                HStack(alignment:.center,spacing:10) {
                    Image(systemName:item.kind == .requirement ? "scope" :
                          item.parentPlanId != nil ? "arrow.turn.down.right" : "arrow.triangle.branch")
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:12,weight:.medium))
                        .foregroundStyle(item.kind == .requirement ? ForgePalette.ink : ForgePalette.secondary)
                        .frame(width:19,height:20)
                    VStack(alignment:.leading,spacing:4) {
                        HStack(spacing:7) {
                            Text(planningNodeRole(item))
                                .font(.system(size:9,weight:.semibold))
                                .foregroundStyle(ForgePalette.secondary)
                            if item.kind == .requirement,!item.state.isEmpty {
                                Text(item.state == "completed" ? "已完成" :
                                     item.state == "open" ? "开放" :
                                     item.state == "cancelled" ? "已取消" : item.state)
                                    .font(.system(size:9,weight:.medium))
                                    .foregroundStyle(ForgePalette.secondary)
                            }
                            if let status=planningExecutionStatus(item) {
                                Text(planningExecutionLabel(item,status))
                                    .font(.system(size:9,weight:.semibold))
                                    .foregroundStyle(planningExecutionColor(status))
                                    .help(planningExecutionHelp(item,status))
                            }
                            if let parent {
                                Text("属于 \(parent.title)")
                                    .font(.system(size:9))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Text(item.title)
                            .font(.system(size:item.kind == .requirement ? 13 : 12.5,
                                          weight:item.kind == .requirement ? .semibold : .medium))
                            .foregroundStyle(ForgePalette.ink)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text(item.recordId)
                            .font(.system(size:9,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength:0)
                }
                .padding(.horizontal,8).padding(.vertical,9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("semantic.record.\(item.kind.rawValue).\(item.recordId)")

            if !children.isEmpty {
                Button {
                    if collapsed {
                        collapsedPlanningRecordIds.remove(item.id)
                    } else {
                        collapsedPlanningRecordIds.insert(item.id)
                    }
                } label: {
                    HStack(spacing:4) {
                        Text("\(children.count)")
                            .font(.system(size:9,weight:.medium,design:.monospaced))
                        Image(systemName:collapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size:9,weight:.semibold))
                    }
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(minWidth:38,minHeight:34)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help(collapsed ? "展开 \(children.count) 个直接子节点" : "折叠 \(children.count) 个直接子节点")
                .accessibilityLabel(collapsed ? "展开子节点" : "折叠子节点")
                .accessibilityIdentifier("planning.list.children.\(item.recordId)")
                .padding(.trailing,8)
            }
        }
        .padding(.leading,CGFloat(min(item.depth,6) * 18))
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(item.id == model.selectedRecord ? ForgePalette.selectionStrong :
                    item.kind == .requirement ? ForgePalette.raisedSurface : ForgePalette.softFill.opacity(0.45),
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
        .overlay(alignment:.leading) {
            if item.kind == .requirement {
                RoundedRectangle(cornerRadius:1.5)
                    .fill(ForgePalette.accent.opacity(0.46))
                    .frame(width:3)
                    .padding(.leading,2)
            }
        }
    }

    private var planningCanvas: some View {
        GeometryReader { viewport in
            let positions = planningCanvasPositions
            let size = planningCanvasSize
            let scale = planningCanvasScale(viewport:viewport.size,content:size)
            let focusIds = planningFocusIds
            let selectedPathIds = planningSelectedPathIds
            let hasSelection = model.selectedRecord != nil
            let columnStep = planningNodeWidth + planningColumnGap
            let maxX = positions.values.map(\.x).max() ?? 0
            let maxDepth = max(0,Int((maxX / max(CGFloat(1),columnStep)).rounded()))

            ScrollViewReader { proxy in
                ScrollView([.horizontal,.vertical]) {
                    ZStack(alignment:.topLeading) {
                        Color.clear
                            .frame(width:1,height:1)
                            .position(x:1,y:1)
                            .id("planning.origin")

                        ForEach(0...maxDepth,id:\.self) { depth in
                            let x=CGFloat(depth) * columnStep
                            RoundedRectangle(cornerRadius:12,style:.continuous)
                                .fill(depth.isMultiple(of:2) ? Color.black.opacity(0.018) : Color.black.opacity(0.010))
                                .frame(width:planningNodeWidth,height:size.height)
                                .offset(x:x,y:0)

                            VStack(alignment:.leading,spacing:2) {
                                Text(depth == 0 ? "起点" : "Plan 第 \(depth) 层")
                                    .font(.system(size:9.5,weight:.semibold))
                                    .foregroundStyle(ForgePalette.ink.opacity(0.82))
                                Text(depth == 0 ? "Requirement / 独立 Plan" : "沿箭头读取父子关系")
                                    .font(.system(size:8.3))
                                    .foregroundStyle(ForgePalette.secondary)
                            }
                            .padding(.horizontal,9)
                            .offset(x:x,y:7)
                        }

                        Canvas { context, _ in
                            for item in planningVisibleRecords {
                                guard let child = positions[item.id],
                                      let parent = planningParent(of:item),
                                      let parentPoint = positions[parent.id] else { continue }
                                let start = CGPoint(
                                    x:parentPoint.x + planningNodeWidth,
                                    y:parentPoint.y + planningNodeHeight / 2
                                )
                                let end = CGPoint(
                                    x:child.x,
                                    y:child.y + planningNodeHeight / 2
                                )
                                let bend = max(start.x + 24,(start.x + end.x) / 2)
                                var path = Path()
                                path.move(to:start)
                                path.addCurve(
                                    to:end,
                                    control1:CGPoint(x:bend,y:start.y),
                                    control2:CGPoint(x:bend,y:end.y)
                                )
                                let onSelectedPath = hasSelection
                                    && selectedPathIds.contains(item.id)
                                    && selectedPathIds.contains(parent.id)
                                let structurallyRelated = !hasSelection
                                    || (focusIds.contains(item.id) && focusIds.contains(parent.id))
                                let edgeColor = onSelectedPath
                                    ? ForgePalette.accent.opacity(0.82)
                                    : (structurallyRelated
                                        ? ForgePalette.accent.opacity(hasSelection ? 0.34 : 0.26)
                                        : ForgePalette.secondary.opacity(0.14))
                                let edgeWidth: CGFloat = onSelectedPath ? 2.35 : (structurallyRelated ? 1.45 : 1)
                                context.stroke(
                                    path,
                                    with:.color(edgeColor),
                                    style:StrokeStyle(lineWidth:edgeWidth,lineCap:.round)
                                )
                                let arrowSize: CGFloat = onSelectedPath ? 7 : (structurallyRelated ? 6 : 5)
                                var arrow = Path()
                                arrow.move(to:end)
                                arrow.addLine(to:CGPoint(x:end.x - arrowSize,y:end.y - arrowSize * 0.72))
                                arrow.move(to:end)
                                arrow.addLine(to:CGPoint(x:end.x - arrowSize,y:end.y + arrowSize * 0.72))
                                context.stroke(
                                    arrow,
                                    with:.color(edgeColor),
                                    style:StrokeStyle(lineWidth:edgeWidth,lineCap:.round,lineJoin:.round)
                                )
                            }
                        }
                        .frame(width:size.width,height:size.height)

                        ForEach(planningVisibleRecords) { item in
                            if let child=positions[item.id],
                               let parent=planningParent(of:item),
                               let parentPoint=positions[parent.id] {
                                let onSelectedPath = hasSelection
                                    && selectedPathIds.contains(item.id)
                                    && selectedPathIds.contains(parent.id)
                                let structurallyRelated = !hasSelection
                                    || (focusIds.contains(item.id) && focusIds.contains(parent.id))
                                if structurallyRelated {
                                let startX=parentPoint.x + planningNodeWidth
                                let endX=child.x
                                let midX=(startX + endX) / 2
                                let midY=((parentPoint.y + child.y) / 2) + planningNodeHeight / 2
                                Text(parent.kind == .requirement ? "拥有" : "细化")
                                    .font(.system(size:7.8,weight:.semibold))
                                    .foregroundStyle(onSelectedPath ? ForgePalette.accent : ForgePalette.secondary)
                                    .padding(.horizontal,5).padding(.vertical,2)
                                    .background(ForgePalette.raisedSurface.opacity(0.94),in:Capsule())
                                    .overlay(Capsule().stroke(
                                        (onSelectedPath ? ForgePalette.accent : ForgePalette.secondary).opacity(0.18),
                                        lineWidth:0.6
                                    ))
                                    .position(x:midX,y:midY)
                                }
                            }
                        }

                        ForEach(planningVisibleRecords) { item in
                            if let point = positions[item.id] {
                                planningCanvasNode(item,focused:!hasSelection || focusIds.contains(item.id))
                                    .offset(x:point.x,y:point.y)
                                    .id(item.id)
                            }
                        }
                    }
                    .frame(width:size.width,height:size.height,alignment:.topLeading)
                    .scaleEffect(scale,anchor:.topLeading)
                    .frame(width:size.width * scale,height:size.height * scale,alignment:.topLeading)
                    .padding(12)
                }
                .scrollIndicators(.visible)
                .onChange(of:planningScrollTarget) { target in
                    guard let target else { return }
                    DispatchQueue.main.async {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                            proxy.scrollTo(target,anchor:.center)
                        }
                        planningScrollTarget=nil
                    }
                }
                .onAppear {
                    planningFitScale=scale
                }
                .onChange(of:scale) { newScale in
                    planningFitScale=newScale
                }
                .overlay(alignment:.bottomLeading) {
                    HStack(spacing:7) {
                        if !collapsedPlanningRecordIds.isEmpty {
                            Button("展开全部") {
                                collapsedPlanningRecordIds.removeAll()
                            }
                            .buttonStyle(.plain)
                            .font(.system(size:9,weight:.medium))
                            .accessibilityIdentifier("planning.expand.all")
                            Divider().frame(height:10)
                        }
                        Text(planningFitToView ? "适配宽度 · \(Int(scale * 100))%" : "\(Int(scale * 100))%")
                    }
                    .font(.system(size:9,design:.monospaced))
                    .foregroundStyle(ForgePalette.secondary.opacity(0.86))
                    .padding(.horizontal,10).padding(.vertical,6)
                    .background(.thinMaterial,in:Capsule())
                    .padding(10)
                }
            }
        }
    }

    private func planningCanvasScale(viewport:CGSize,content:CGSize) -> CGFloat {
        guard planningFitToView else { return planningZoom }
        let width=max(1,viewport.width - 28)
        let fit=width / max(1,content.width)
        return min(1,max(0.72,fit))
    }

    private var planningChildrenByParent: [String:[ForgeRecord]] {
        var result:[String:[ForgeRecord]] = [:]
        for item in model.records {
            guard let parent=planningParent(of:item) else { continue }
            result[parent.id,default:[]].append(item)
        }
        return result
    }

    private var planningUnlinkedRecords: [ForgeRecord] {
        let children=planningChildrenByParent
        return model.records.filter {
            planningParent(of:$0) == nil && (children[$0.id] ?? []).isEmpty
        }
    }

    private var planningGraphRecords: [ForgeRecord] {
        guard !planningShowUnlinked else { return model.records }
        let children=planningChildrenByParent
        return model.records.filter {
            planningParent(of:$0) != nil || !(children[$0.id] ?? []).isEmpty
        }
    }

    private var planningVisibleRecords: [ForgeRecord] {
        let children=planningChildrenByParent
        let graphRecords=planningGraphRecords
        let graphIds=Set(graphRecords.map(\.id))
        var result:[ForgeRecord]=[]
        var visited=Set<String>()

        func append(_ item:ForgeRecord) {
            guard graphIds.contains(item.id),visited.insert(item.id).inserted else { return }
            result.append(item)
            guard !collapsedPlanningRecordIds.contains(item.id) else { return }
            for child in children[item.id] ?? [] where graphIds.contains(child.id) {
                append(child)
            }
        }

        for root in graphRecords where planningParent(of:root) == nil {
            append(root)
        }
        return result
    }

    private var planningCanvasPositions: [String:CGPoint] {
        let children=planningChildrenByParent
        let visible=planningVisibleRecords
        let visibleIds=Set(visible.map(\.id))
        let rowStep=planningNodeHeight + planningRowGap
        let columnStep=planningNodeWidth + planningColumnGap
        var positions:[String:CGPoint] = [:]
        var placed=Set<String>()
        var visiting=Set<String>()
        var nextLeaf:CGFloat=0

        func place(_ item:ForgeRecord,depth:Int) -> CGFloat {
            if let existing=positions[item.id] {
                return existing.y + planningNodeHeight / 2
            }
            if visiting.contains(item.id) {
                let center=planningLaneHeaderHeight + nextLeaf * rowStep + planningNodeHeight / 2
                nextLeaf += 1
                positions[item.id]=CGPoint(x:CGFloat(depth) * columnStep,y:center - planningNodeHeight / 2)
                placed.insert(item.id)
                return center
            }

            visiting.insert(item.id)
            let childItems=(children[item.id] ?? []).filter {
                visibleIds.contains($0.id) && !placed.contains($0.id)
            }
            let center:CGFloat
            if childItems.isEmpty {
                center=planningLaneHeaderHeight + nextLeaf * rowStep + planningNodeHeight / 2
                nextLeaf += 1
            } else {
                let centers=childItems.map { place($0,depth:depth + 1) }
                center=((centers.first ?? 0) + (centers.last ?? 0)) / 2
            }
            visiting.remove(item.id)
            if !placed.contains(item.id) {
                positions[item.id]=CGPoint(x:CGFloat(depth) * columnStep,y:center - planningNodeHeight / 2)
                placed.insert(item.id)
            }
            return positions[item.id]!.y + planningNodeHeight / 2
        }

        let roots=visible.filter { planningParent(of:$0) == nil }
        for root in roots where !placed.contains(root.id) {
            _=place(root,depth:0)
            nextLeaf += 0.35
        }
        for item in visible where !placed.contains(item.id) {
            _=place(item,depth:0)
            nextLeaf += 0.35
        }
        return positions
    }

    private var planningCanvasSize: CGSize {
        let positions=planningCanvasPositions
        let maxX=positions.values.map(\.x).max() ?? 0
        let maxY=positions.values.map(\.y).max() ?? 0
        return CGSize(
            width:max(380,maxX + planningNodeWidth),
            height:max(300,maxY + planningNodeHeight)
        )
    }

    private var planningFocusIds: Set<String> {
        guard let selectedId=model.selectedRecord,
              let selected=model.records.first(where:{ $0.id == selectedId }) else {
            return Set(model.records.map(\.id))
        }
        let children=planningChildrenByParent
        var result:Set<String>=[selected.id]

        var cursor:ForgeRecord?=selected
        var ancestorGuard=Set<String>()
        while let current=cursor,
              ancestorGuard.insert(current.id).inserted,
              let parent=planningParent(of:current) {
            result.insert(parent.id)
            cursor=parent
        }

        var stack=children[selected.id] ?? []
        while let child=stack.popLast() {
            guard result.insert(child.id).inserted else { continue }
            stack.append(contentsOf:children[child.id] ?? [])
        }
        return result
    }

    private func planningParent(of item:ForgeRecord) -> ForgeRecord? {
        guard item.kind == .plan else { return nil }
        if let parentId = item.parentPlanId,!parentId.isEmpty {
            return model.records.first { $0.kind == .plan && $0.recordId == parentId }
        }
        if let requirementId = item.requirementId,!requirementId.isEmpty {
            return model.records.first { $0.kind == .requirement && $0.recordId == requirementId }
        }
        return nil
    }

    private var planningExecutionFocusRecord: ForgeRecord? {
        let activeStates:Set<String>=["running","paused","blocked","failed"]
        for item in model.records where item.kind == .plan {
            guard let status=planningExecutionStatus(item),
                  activeStates.contains(status.runStatus ?? "") else { continue }
            return item
        }
        for item in model.records where item.kind == .requirement {
            guard let status=model.planningAutopilotStatuses[item.recordId] else { continue }
            if status.requiresReapproval || activeStates.contains(status.runStatus ?? "") {
                return item
            }
        }
        return nil
    }

    private func planningExecutionStatus(_ item:ForgeRecord) -> AutopilotStatusDetail? {
        let requirementId = item.kind == .requirement ? item.recordId : item.requirementId
        guard let requirementId,
              let status=model.planningAutopilotStatuses[requirementId] else { return nil }
        if item.kind == .plan {
            guard status.currentPlanId == item.recordId,
                  ["running","paused","blocked","failed"].contains(status.runStatus ?? "") else { return nil }
        } else if !status.authorized && status.runStatus == nil && !status.requiresReapproval {
            return nil
        }
        return status
    }

    private func planningExecutionLabel(_ item:ForgeRecord,_ status:AutopilotStatusDetail) -> String {
        if status.requiresReapproval { return "需重新批准" }
        if item.kind == .plan,
           status.runStatus == "paused",
           status.stopReason == "human_checkpoint:\(item.recordId)" {
            return "等待确认"
        }
        if item.kind == .requirement,
           status.runStatus == "paused",
           status.stopReason?.hasPrefix("human_checkpoint:") == true {
            return "等待确认"
        }
        switch status.runStatus {
        case "running": return status.runtimeActive ? (item.kind == .plan ? "当前执行" : "执行中") : "运行未激活"
        case "paused": return item.kind == .plan ? "当前暂停" : "已暂停"
        case "blocked": return item.kind == .plan ? "当前受阻" : "受阻"
        case "failed": return item.kind == .plan ? "当前失败" : "失败"
        case "completed": return "已完成"
        case "cancelled": return "已取消"
        default: return status.authorized ? "已批准" : "未授权"
        }
    }

    private func planningExecutionColor(_ status:AutopilotStatusDetail) -> Color {
        if status.requiresReapproval { return .orange }
        switch status.runStatus {
        case "running": return status.runtimeActive ? .green : .orange
        case "paused","blocked","failed": return .orange
        case "completed": return .green
        default: return status.authorized ? ForgePalette.accent : ForgePalette.secondary
        }
    }

    private func planningExecutionHelp(_ item:ForgeRecord,_ status:AutopilotStatusDetail) -> String {
        var parts=[planningExecutionLabel(item,status)]
        if let summary=status.lastSummary,!summary.isEmpty { parts.append(summary) }
        if let reason=status.stopReason,!reason.isEmpty { parts.append(reason) }
        return parts.joined(separator:" · ")
    }

    private func planningCanvasNode(_ item:ForgeRecord,focused:Bool) -> some View {
        let selected = item.id == model.selectedRecord
        let hovered = hoveredPlanningRecordId == item.id
        let children=planningChildrenByParent[item.id] ?? []
        let collapsed=collapsedPlanningRecordIds.contains(item.id)
        let execution=planningExecutionStatus(item)
        let nodeBackground:Color = selected
            ? ForgePalette.raisedSurface
            : (item.kind == .requirement ? ForgePalette.accent.opacity(0.075) : ForgePalette.raisedSurface.opacity(0.78))
        let nodeBorder:Color = selected
            ? ForgePalette.ink.opacity(0.34)
            : (item.kind == .requirement ? ForgePalette.accent.opacity(0.22) : ForgePalette.secondary.opacity(0.13))
        return ZStack(alignment:.bottomTrailing) {
            Button {
                Task { await model.openRecord(item.id) }
            } label: {
                VStack(alignment:.leading,spacing:7) {
                    HStack(spacing:6) {
                        Image(systemName:item.kind == .requirement ? "scope" : "arrow.triangle.branch")
                            .symbolRenderingMode(.hierarchical)
                            .font(.system(size:10.5,weight:.semibold))
                        Text(planningNodeRole(item).uppercased())
                            .font(.system(size:8.5,weight:.bold))
                            .tracking(0.45)
                        if item.kind == .requirement,!item.state.isEmpty {
                            Text(item.state.uppercased())
                                .font(.system(size:7.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength:4)
                        if let execution {
                            HStack(spacing:4) {
                                Circle()
                                    .fill(planningExecutionColor(execution))
                                    .frame(width:5.5,height:5.5)
                                Text(planningExecutionLabel(item,execution))
                                    .font(.system(size:8,weight:.semibold))
                                    .lineLimit(1)
                            }
                            .padding(.horizontal,6).padding(.vertical,3)
                            .background(planningExecutionColor(execution).opacity(0.10),in:Capsule())
                            .help(planningExecutionHelp(item,execution))
                        }
                    }
                    .foregroundStyle(item.kind == .requirement ? ForgePalette.ink : ForgePalette.secondary)

                    Text(item.title)
                        .font(.system(size:11.5,weight:item.kind == .requirement ? .semibold : .medium))
                        .foregroundStyle(ForgePalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth:.infinity,alignment:.leading)

                    Text(item.recordId)
                        .font(.system(size:8.5,design:.monospaced))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                .padding(11)
                .frame(width:planningNodeWidth,height:planningNodeHeight,alignment:.topLeading)
                .background(nodeBackground,in:RoundedRectangle(cornerRadius:13,style:.continuous))
                .overlay(
                    RoundedRectangle(cornerRadius:13,style:.continuous)
                        .stroke(nodeBorder,lineWidth:selected ? 1.25 : 0.75)
                )
                .overlay(alignment:.leading) {
                    Capsule()
                        .fill(item.kind == .requirement ? ForgePalette.accent.opacity(0.72) : ForgePalette.secondary.opacity(0.28))
                        .frame(width:3)
                        .padding(.vertical,12)
                        .padding(.leading,2)
                }
                .shadow(color:Color.primary.opacity(selected ? 0.035 : 0),radius:4,y:1)
                .contentShape(RoundedRectangle(cornerRadius:13,style:.continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(item.title)
            .accessibilityValue({
                let relation=planningNodeRole(item)
                if let execution {
                    return "\(relation) · \(item.recordId) · \(planningExecutionLabel(item,execution))"
                }
                return "\(relation) · \(item.recordId)"
            }())
            .accessibilityIdentifier("semantic.canvas.\(item.kind.rawValue).\(item.recordId)")

            if !children.isEmpty || hovered || selected {
                HStack(spacing:4) {
                    if !children.isEmpty {
                        Button {
                            if collapsed {
                                collapsedPlanningRecordIds.remove(item.id)
                            } else {
                                collapsedPlanningRecordIds.insert(item.id)
                            }
                        } label: {
                            HStack(spacing:3) {
                                Image(systemName:collapsed ? "chevron.right" : "chevron.down")
                                Text("\(children.count)")
                                    .font(.system(size:8.5,weight:.bold,design:.monospaced))
                            }
                            .font(.system(size:9,weight:.bold))
                            .padding(.horizontal,6)
                            .frame(height:22)
                            .background(.thinMaterial,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                        }
                        .buttonStyle(.plain)
                        .help(collapsed ? "展开 \(children.count) 个直接子节点" : "折叠 \(children.count) 个直接子节点")
                        .accessibilityLabel(collapsed ? "展开分支" : "折叠分支")
                        .accessibilityValue("\(children.count) 个直接子节点")
                        .accessibilityIdentifier("planning.collapse.\(item.recordId)")
                    }

                    if hovered || selected {
                        Button {
                        if item.kind == .requirement {
                            beginPlan(requirementId:item.recordId,parentPlanId:nil)
                        } else {
                            beginPlan(requirementId:item.requirementId,parentPlanId:item.recordId)
                        }
                    } label: {
                        Image(systemName:"plus")
                            .font(.system(size:9.5,weight:.bold))
                            .frame(width:24,height:22)
                            .background(.thinMaterial,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .help(item.kind == .requirement ? "添加根 Plan" : "细化子 Plan")

                    Button {
                        if item.kind == .requirement {
                            model.newThreadForRequirement(item.recordId)
                        } else {
                            model.newThread(requirementId:item.requirementId,planId:item.recordId)
                        }
                    } label: {
                        Image(systemName:"bubble.left")
                            .font(.system(size:9.5,weight:.semibold))
                            .frame(width:24,height:22)
                            .background(.thinMaterial,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    }
                        .buttonStyle(.plain)
                        .help("以此节点新建会话")
                    }
                }
                .padding(7)
                .transition(reduceMotion ? .identity : .opacity)
            }
        }
        .opacity(focused ? 1 : 0.52)
        .onHover { inside in
            if inside { hoveredPlanningRecordId=item.id }
            else if hoveredPlanningRecordId == item.id { hoveredPlanningRecordId=nil }
        }
        .animation(reduceMotion ? nil : .easeOut(duration:0.12),value:hovered)
        .animation(reduceMotion ? nil : .easeOut(duration:0.16),value:focused)
        .accessibilityElement(children:.contain)
    }

    private func beginRequirement() {
        draftTitle = ""
        draftOutcome = ""
        draftCriteria = ""
        authoring = PlanningAuthoringContext(kind:.requirement,requirementId:nil,parentPlanId:nil)
    }

    private func beginPlan(requirementId:String?,parentPlanId:String?) {
        draftTitle = ""
        draftOutcome = ""
        draftCriteria = ""
        authoring = PlanningAuthoringContext(kind:.plan,requirementId:requirementId,parentPlanId:parentPlanId)
    }

    @ViewBuilder
    private func planningAuthoringSheet(_ context: PlanningAuthoringContext) -> some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                VStack(alignment:.leading,spacing:4) {
                    Text(authoringTitle(context))
                        .font(.system(size:18,weight:.semibold))
                    Text(authoringSubtitle(context))
                        .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { authoring = nil } label: { Image(systemName:"xmark") }
                    .buttonStyle(.plain).disabled(saving)
            }

            if context.kind == .requirement {
                VStack(alignment:.leading,spacing:6) {
                    Text("标题").font(.system(size:11,weight:.medium))
                    TextField("例如：实现无人值守规划",text:$draftTitle)
                        .textFieldStyle(.roundedBorder)
                }
            }

            VStack(alignment:.leading,spacing:6) {
                Text(context.kind == .requirement ? "目标 / Outcome" : "Plan 目标")
                    .font(.system(size:11,weight:.medium))
                TextEditor(text:$draftOutcome)
                    .font(.system(size:12))
                    .frame(height:92)
                    .padding(6)
                    .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
            }

            if context.kind == .requirement {
                VStack(alignment:.leading,spacing:6) {
                    Text("验收标准（每行一条，可选）").font(.system(size:11,weight:.medium))
                    TextEditor(text:$draftCriteria)
                        .font(.system(size:12))
                        .frame(height:82)
                        .padding(6)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
                }
            }

            HStack {
                Text("创建只写入 Forge canonical Requirement / Plan；不会启动执行。")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                Spacer()
                Button("取消") { authoring = nil }.disabled(saving)
                Button(saving ? "创建中…" : "创建") { submitAuthoring(context) }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving || draftOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ||
                              (context.kind == .requirement && draftTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }
        .padding(20)
        .frame(width:460)
        .interactiveDismissDisabled(saving)
    }

    private func authoringTitle(_ context: PlanningAuthoringContext) -> String {
        if context.kind == .requirement { return "新建 Requirement" }
        if context.parentPlanId != nil { return "细化子 Plan" }
        if context.requirementId != nil { return "新建根 Plan" }
        return "新建 Plan"
    }

    private func authoringSubtitle(_ context: PlanningAuthoringContext) -> String {
        if context.kind == .requirement { return "Requirement 是可选的持久需求根，不是使用 Forge 的前置条件。" }
        if let parentPlanId = context.parentPlanId {
            let parentTitle = model.records.first(where: { $0.kind == .plan && $0.recordId == parentPlanId })?.title
            return parentTitle.map { "在「\($0)」下继续细化子 Plan。" }
                ?? "在父 Plan \(parentPlanId) 下继续细化。"
        }
        if let requirementId = context.requirementId {
            let requirementTitle = model.records.first(where: { $0.kind == .requirement && $0.recordId == requirementId })?.title
            return requirementTitle.map { "在 Requirement「\($0)」下创建根 Plan。" }
                ?? "在 Requirement \(requirementId) 下创建根 Plan。"
        }
        return "独立 Plan；无需先创建 Requirement。"
    }

    private func submitAuthoring(_ context: PlanningAuthoringContext) {
        guard !saving else { return }
        saving = true
        Task {
            let created: String?
            switch context.kind {
            case .requirement:
                created = await model.createRequirement(
                    title:draftTitle,
                    outcome:draftOutcome,
                    acceptanceCriteria:draftCriteria.components(separatedBy:.newlines)
                )
            case .plan:
                created = await model.createPlan(
                    objective:draftOutcome,
                    requirementId:context.requirementId,
                    parentPlanId:context.parentPlanId
                )
            }
            saving = false
            if created != nil { authoring = nil }
        }
    }

    @ViewBuilder
    private func autopilotSection(_ requirement:RequirementRecordDetail) -> some View {
        semanticSection("Autopilot · 无人值守") {
            VStack(alignment:.leading,spacing:11) {
                HStack(spacing:8) {
                    Circle()
                        .fill(autopilotStatusColor(model.autopilotStatus))
                        .frame(width:7,height:7)
                    Text(autopilotStatusLabel(model.autopilotStatus))
                        .font(.system(size:12,weight:.semibold))
                    if let status=model.autopilotStatus,
                       let approved=status.approvedRevision {
                        Text("批准 r\(approved)")
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    if model.autopilotLoading { ProgressView().controlSize(.small) }
                }

                if let status=model.autopilotStatus {
                    if status.requiresReapproval {
                        Label("Requirement 已修订到 r\(status.requirementRevision ?? requirement.revision)，旧授权失效，需要重新批准。",systemImage:"exclamationmark.triangle.fill")
                            .font(.system(size:10.5)).foregroundStyle(.orange)
                    }
                    HStack(spacing:14) {
                        autopilotMetric("Token","\(status.totalTokens) / \(status.maxTotalTokens.map(String.init) ?? "—")")
                        autopilotMetric("Turns","\(status.turns) / \(status.maxTurns.map(String.init) ?? "—")")
                        autopilotMetric("Tools","\(status.toolCalls) / \(status.maxToolCalls.map(String.init) ?? "—")")
                        if let modelName=status.model { autopilotMetric("Model",modelName) }
                    }
                    if let currentPlanId=status.currentPlanId,!currentPlanId.isEmpty {
                        HStack(spacing:7) {
                            Image(systemName:"location.fill")
                                .font(.system(size:9))
                                .foregroundStyle(ForgePalette.accent)
                            Text("当前 Plan")
                                .font(.system(size:9.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                            Text(currentPlanId)
                                .font(.system(size:9.5,design:.monospaced))
                                .textSelection(.enabled)
                            Spacer()
                            if let plan=model.records.first(where:{ $0.kind == .plan && $0.recordId == currentPlanId }) {
                                Button("定位") { locatePlanningRecord(plan) }
                                    .buttonStyle(.plain)
                                    .font(.system(size:9.5,weight:.medium))
                                    .foregroundStyle(ForgePalette.accent)
                            }
                        }
                    }
                    if let summary=status.lastSummary,!summary.isEmpty {
                        Text(summary)
                            .font(.system(size:10.5))
                            .foregroundStyle(ForgePalette.ink)
                            .textSelection(.enabled)
                    }
                    if let reason=status.stopReason,!reason.isEmpty {
                        Text(reason)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .textSelection(.enabled)
                    }
                    if !status.providerReady {
                        Text("Runtime 尚未检测到 DeepSeek 凭据；可以先批准，但开始执行前需要 Runtime provider 就绪。")
                            .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    }
                } else {
                    Text("Requirement 才需要显式批准无人值守；普通会话与独立 Plan 不受影响。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }

                HStack(spacing:8) {
                    let status=model.autopilotStatus
                    if status?.authorized != true || status?.requiresReapproval == true {
                        Button(status?.requiresReapproval == true ? "重新配置并批准" : "配置并批准") {
                            beginAutopilotApproval(requirement)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        switch status?.runStatus {
                        case "running":
                            Button("暂停") { runAutopilotAction(requirement.requirementId,"pause") }
                                .buttonStyle(.borderedProminent)
                        case "paused", "blocked", "failed":
                            Button("继续") { runAutopilotAction(requirement.requirementId,"resume") }
                                .buttonStyle(.borderedProminent)
                                .disabled(status?.providerReady != true)
                        default:
                            Button(status?.runStatus == "completed" ? "再次运行" : "开始无人值守") {
                                runAutopilotAction(requirement.requirementId,"start")
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(status?.providerReady != true)
                        }
                        Button("重新配置") { beginAutopilotApproval(requirement) }
                            .buttonStyle(.bordered)
                        Button("撤销授权",role:.destructive) {
                            runAutopilotAction(requirement.requirementId,"revoke")
                        }
                        .buttonStyle(.bordered)
                    }
                    Button { Task { await model.loadAutopilotStatus(requirement.requirementId) } } label: {
                        Image(systemName:"arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                    .disabled(model.autopilotLoading)
                }
                Text("批准与开始执行是两个动作。Autopilot 只拥有 workspace-write 上限，不允许 push、发布、部署、Runtime 切换或破坏性操作。")
                    .font(.system(size:9.5)).foregroundStyle(ForgePalette.secondary)
            }
        }
    }

    private func autopilotMetric(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:2) {
            Text(label).font(.system(size:9)).foregroundStyle(ForgePalette.secondary)
            Text(value).font(.system(size:10.5,weight:.medium,design:.monospaced)).lineLimit(1)
        }
    }

    private func autopilotStatusLabel(_ status:AutopilotStatusDetail?) -> String {
        guard let status else { return "未授权" }
        if status.requiresReapproval { return "需要重新批准" }
        if status.runStatus == "paused",status.stopReason?.hasPrefix("human_checkpoint:") == true { return "等待确认" }
        switch status.runStatus {
        case "running": return status.runtimeActive ? "执行中" : "运行未激活"
        case "paused": return "已暂停"
        case "blocked": return "受阻"
        case "failed": return "失败"
        case "completed": return "已完成"
        case "cancelled": return "已取消"
        default: return status.authorized ? "已批准，未启动" : "未授权"
        }
    }

    private func autopilotStatusColor(_ status:AutopilotStatusDetail?) -> Color {
        guard let status else { return ForgePalette.secondary }
        if status.requiresReapproval || status.runStatus == "failed" || status.runStatus == "blocked" { return .orange }
        if status.runStatus == "running" && status.runtimeActive { return .green }
        if status.authorized { return ForgePalette.ink }
        return ForgePalette.secondary
    }

    private func beginAutopilotApproval(_ requirement:RequirementRecordDetail) {
        let status=model.autopilotStatus
        autopilotModel=status?.model ?? "deepseek-chat"
        autopilotTokenBudget=status?.maxTotalTokens.map(String.init) ?? "50000"
        autopilotTurnBudget=status?.maxTurns.map(String.init) ?? "12"
        autopilotToolBudget=status?.maxToolCalls.map(String.init) ?? "32"
        autopilotCheckpoints=[]
        autopilotApproval=AutopilotApprovalContext(requirement:requirement)
    }

    @ViewBuilder
    private func autopilotApprovalSheet(_ context:AutopilotApprovalContext) -> some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                VStack(alignment:.leading,spacing:4) {
                    Text("批准无人值守执行").font(.system(size:18,weight:.semibold))
                    Text("绑定 \(context.requirement.requirementId) · revision \(context.requirement.revision)")
                        .font(.system(size:10.5,design:.monospaced)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { autopilotApproval=nil } label:{ Image(systemName:"xmark") }
                    .buttonStyle(.plain).disabled(autopilotSaving)
            }
            Text("Requirement 的任何后续语义修订都会使本次授权失效；普通 Forge 使用不需要此授权。")
                .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
            Grid(alignment:.leading,horizontalSpacing:12,verticalSpacing:10) {
                GridRow { Text("模型"); TextField("deepseek-chat",text:$autopilotModel).textFieldStyle(.roundedBorder) }
                GridRow { Text("Token 上限"); TextField("50000",text:$autopilotTokenBudget).textFieldStyle(.roundedBorder) }
                GridRow { Text("最大 turns"); TextField("12",text:$autopilotTurnBudget).textFieldStyle(.roundedBorder) }
                GridRow { Text("最大 tool calls"); TextField("32",text:$autopilotToolBudget).textFieldStyle(.roundedBorder) }
            }
            .font(.system(size:11))

            let plans=model.records.filter { $0.kind == .plan && $0.requirementId == context.requirement.requirementId }
            if !plans.isEmpty {
                VStack(alignment:.leading,spacing:7) {
                    Text("人工验收检查点").font(.system(size:11,weight:.semibold))
                    Text("模型推进到选中的 Plan 节点并报告阶段完成时会暂停。")
                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                    ScrollView {
                        VStack(alignment:.leading,spacing:5) {
                            ForEach(plans) { plan in
                                Toggle(isOn:Binding(
                                    get:{ autopilotCheckpoints.contains(plan.recordId) },
                                    set:{ enabled in
                                        if enabled { autopilotCheckpoints.insert(plan.recordId) }
                                        else { autopilotCheckpoints.remove(plan.recordId) }
                                    }
                                )) {
                                    Text(plan.title).font(.system(size:11)).lineLimit(1)
                                }
                                .toggleStyle(.checkbox)
                            }
                        }
                    }
                    .frame(maxHeight:130)
                }
            }
            HStack {
                Text("这里只授予 workspace-write；不会自动 push / release / deploy。")
                    .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                Spacer()
                Button("取消") { autopilotApproval=nil }.disabled(autopilotSaving)
                Button(autopilotSaving ? "批准中…" : "批准") { submitAutopilotApproval(context) }
                    .buttonStyle(.borderedProminent)
                    .disabled(autopilotSaving || parsedAutopilotBudgets() == nil || autopilotModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20).frame(width:520)
        .interactiveDismissDisabled(autopilotSaving)
    }

    private func parsedAutopilotBudgets() -> (Int,Int,Int)? {
        guard let tokens=Int(autopilotTokenBudget),tokens >= 1000,tokens <= 500000,
              let turns=Int(autopilotTurnBudget),turns >= 1,turns <= 48,
              let tools=Int(autopilotToolBudget),tools >= 1,tools <= 128 else { return nil }
        return (tokens,turns,tools)
    }

    private func submitAutopilotApproval(_ context:AutopilotApprovalContext) {
        guard let budgets=parsedAutopilotBudgets(),!autopilotSaving else { return }
        autopilotSaving=true
        Task {
            let ok=await model.controlAutopilot(
                requirementId:context.requirement.requirementId,
                operation:"authorize",confirmAuthorization:true,
                model:autopilotModel.trimmingCharacters(in:.whitespacesAndNewlines),
                maxTotalTokens:budgets.0,maxTurns:budgets.1,maxToolCalls:budgets.2,
                checkpointPlanIds:Array(autopilotCheckpoints).sorted()
            )
            autopilotSaving=false
            if ok { autopilotApproval=nil }
        }
    }

    private func runAutopilotAction(_ requirementId:String,_ operation:String) {
        guard !autopilotSaving else { return }
        autopilotSaving=true
        Task {
            _=await model.controlAutopilot(requirementId:requirementId,operation:operation)
            autopilotSaving=false
        }
    }

    @ViewBuilder
    private func semanticRecordDetail(_ detail: SemanticRecordDetail) -> some View {
        switch detail {
        case .requirement(let requirement):
            VStack(alignment:.leading,spacing:16) {
                HStack(spacing:9) {
                    Button {
                        model.bindCurrentThreadPlanningContext(
                            requirementId:requirement.requirementId,
                            planId:nil
                        )
                        if model.error == nil { model.show(.agent) }
                    } label: {
                        Label("在当前会话中继续",systemImage:"arrow.turn.down.right")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.thread == nil)
                    .help("把此 Requirement 绑定到当前会话，不修改 Requirement 本身")
                    .accessibilityIdentifier("planning.requirement.use-current")

                    Button {
                        model.newThreadForRequirement(requirement.requirementId)
                    } label: {
                        Label("新建会话",systemImage:"plus.bubble")
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.busy)

                    Menu {
                        Button {
                            beginPlan(requirementId:requirement.requirementId,parentPlanId:nil)
                        } label: {
                            Label("添加根 Plan",systemImage:"plus")
                        }
                    } label: {
                        Image(systemName:"ellipsis")
                            .frame(width:24,height:24)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }

                semanticSection("目标") {
                    Text(requirement.outcomeStatement.isEmpty ? "未提供 outcome。" : requirement.outcomeStatement)
                        .font(.system(size:13,weight:.medium))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }

                if !requirement.progressSummary.isEmpty {
                    semanticSection("当前进度") {
                        Text(requirement.progressSummary)
                            .font(.system(size:12.5))
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                }

                if !requirement.remainingWork.isEmpty {
                    semanticSection("下一步") {
                        VStack(alignment:.leading,spacing:8) {
                            ForEach(Array(requirement.remainingWork.enumerated()),id:\.offset) { index, value in
                                HStack(alignment:.top,spacing:9) {
                                    Text("\(index + 1)")
                                        .font(.system(size:9.5,weight:.semibold,design:.rounded))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .frame(width:17,height:17)
                                        .background(ForgePalette.softFill,in:Circle())
                                    Text(value)
                                        .font(.system(size:12))
                                        .lineSpacing(3)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }

                autopilotSection(requirement)

                if !requirement.acceptanceCriteria.isEmpty {
                    DisclosureGroup {
                        semanticBulletList(requirement.acceptanceCriteria)
                            .padding(.top,8)
                    } label: {
                        HStack {
                            Text("验收标准")
                            Spacer()
                            Text("\(requirement.acceptanceCriteria.count)")
                                .foregroundStyle(.tertiary)
                        }
                        .font(.system(size:11,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                    }
                    .padding(.vertical,11)
                    .overlay(alignment:.top) {
                        Rectangle().fill(Color.primary.opacity(0.10)).frame(height:1)
                    }
                }

                DisclosureGroup("记录信息") {
                    VStack(alignment:.leading,spacing:6) {
                        Text(requirement.requirementId)
                            .textSelection(.enabled)
                        Text("revision \(requirement.revision) · \(requirement.state)")
                    }
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .padding(.top,7)
                }
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            }

        case .plan(let plan):
            VStack(alignment:.leading,spacing:16) {
                HStack(spacing:9) {
                    Button {
                        model.bindCurrentThreadPlanningContext(
                            requirementId:plan.requirementId,
                            planId:plan.planId
                        )
                        if model.error == nil { model.show(.agent) }
                    } label: {
                        Label("在当前会话中继续",systemImage:"arrow.turn.down.right")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.thread == nil)
                    .help("把此 Plan 绑定到当前会话，不修改 Plan 本身")
                    .accessibilityIdentifier("planning.plan.use-current")

                    Button {
                        model.newThreadForPlan(plan)
                    } label: {
                        Label("新建会话",systemImage:"plus.bubble")
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.busy)

                    Menu {
                        Button {
                            beginPlan(requirementId:plan.requirementId,parentPlanId:plan.planId)
                        } label: {
                            Label("细化子 Plan",systemImage:"arrow.turn.down.right")
                        }
                    } label: {
                        Image(systemName:"ellipsis")
                            .frame(width:24,height:24)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }

                semanticSection("目标") {
                    Text(plan.goal.isEmpty ? "未提供目标。" : plan.goal)
                        .font(.system(size:13,weight:.medium))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }

                if !plan.items.isEmpty {
                    semanticSection("实施顺序") {
                        VStack(alignment:.leading,spacing:10) {
                            ForEach(Array(plan.items.enumerated()),id:\.element.id) { index,item in
                                HStack(alignment:.top,spacing:9) {
                                    Text("\(index + 1)")
                                        .font(.system(size:9.5,weight:.semibold,design:.rounded))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .frame(width:17,height:17)
                                        .background(ForgePalette.softFill,in:Circle())
                                    VStack(alignment:.leading,spacing:3) {
                                        Text(item.objective)
                                            .font(.system(size:12.5))
                                            .lineSpacing(3)
                                        Text(item.id)
                                            .font(.system(size:9,design:.monospaced))
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }
                    }
                }

                if plan.parentPlanId != nil || plan.requirementId != nil {
                    semanticSection("关系") {
                        VStack(alignment:.leading,spacing:5) {
                            if let parentPlanId=plan.parentPlanId,!parentPlanId.isEmpty {
                                semanticRelationButton(
                                    title:"上级 Plan",
                                    id:parentPlanId,
                                    systemImage:"arrow.turn.up.left"
                                ) {
                                    Task { await model.openPlan(parentPlanId) }
                                }
                            }
                            if let requirementId=plan.requirementId,!requirementId.isEmpty {
                                semanticRelationButton(
                                    title:"所属 Requirement",
                                    id:requirementId,
                                    systemImage:"doc.text"
                                ) {
                                    Task { await model.openRequirement(requirementId) }
                                }
                            }
                        }
                    }
                }

                if !plan.resolvedDecisions.isEmpty || !plan.nonGoals.isEmpty {
                    DisclosureGroup("决策与边界") {
                        VStack(alignment:.leading,spacing:13) {
                            if !plan.resolvedDecisions.isEmpty {
                                VStack(alignment:.leading,spacing:7) {
                                    Text("已确认决策")
                                        .font(.system(size:10.5,weight:.semibold))
                                        .foregroundStyle(ForgePalette.secondary)
                                    semanticBulletList(plan.resolvedDecisions)
                                }
                            }
                            if !plan.nonGoals.isEmpty {
                                VStack(alignment:.leading,spacing:7) {
                                    Text("不做")
                                        .font(.system(size:10.5,weight:.semibold))
                                        .foregroundStyle(ForgePalette.secondary)
                                    semanticBulletList(plan.nonGoals)
                                }
                            }
                        }
                        .padding(.top,9)
                    }
                    .font(.system(size:11,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.vertical,11)
                    .overlay(alignment:.top) {
                        Rectangle().fill(Color.primary.opacity(0.10)).frame(height:1)
                    }
                }

                DisclosureGroup("记录信息") {
                    VStack(alignment:.leading,spacing:6) {
                        Text(plan.planId).textSelection(.enabled)
                        Text("revision \(plan.revision)")
                        if let source=plan.sourceBasisRevision,!source.isEmpty {
                            Text("source \(source)").textSelection(.enabled)
                        }
                    }
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .padding(.top,7)
                }
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            }
        }
    }

    private func semanticRelationButton(
        title:String,
        id:String,
        systemImage:String,
        action:@escaping () -> Void
    ) -> some View {
        Button(action:action) {
            HStack(spacing:7) {
                Image(systemName:systemImage)
                    .font(.system(size:9.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:16)
                Text(title)
                    .font(.system(size:11,weight:.medium))
                Text(id)
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength:0)
                Image(systemName:"chevron.right")
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(height:29)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func semanticSection<Content:View>(_ title:String,@ViewBuilder content:() -> Content) -> some View {
        VStack(alignment:.leading,spacing:9) {
            Text(title).font(.system(size:11,weight:.semibold)).foregroundStyle(ForgePalette.secondary)
            content()
        }
        .padding(.vertical,12)
        .frame(maxWidth:.infinity,alignment:.leading)
        .overlay(alignment:.top) {
            Rectangle()
                .fill(Color.primary.opacity(0.10))
                .frame(height:1)
        }
    }

    private func semanticBulletList(_ values:[String]) -> some View {
        VStack(alignment:.leading,spacing:7) {
            ForEach(Array(values.enumerated()),id:\.offset) { _, value in
                HStack(alignment:.top,spacing:8) {
                    Circle().frame(width:4,height:4).padding(.top,6)
                    Text(value).font(.system(size:12)).lineSpacing(3).textSelection(.enabled)
                }
            }
        }
    }
}

private struct SchedulePane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var expandedIds: Set<String> = []
    @State private var pendingAction: (item: ProjectScheduleDetail, action: ProjectScheduleAction)?

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:5) {
                        Text("计划任务").font(.system(size:22,weight:.medium))
                        Text("查看定时与条件触发任务，检查执行状态，并管理暂停与恢复。")
                            .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    Button { Task { await model.loadSchedulePage() } } label: {
                        if model.schedulesLoading { ProgressView().controlSize(.small) }
                        else { Label("刷新",systemImage:"arrow.clockwise") }
                    }
                    .buttonStyle(.plain)
                    .disabled(model.schedulesLoading || model.repoId == nil)
                    .accessibilityIdentifier("schedule.refresh")
                }

                if let error = model.error, model.repoId != nil {
                    HStack(alignment:.firstTextBaseline,spacing:9) {
                        Image(systemName:"exclamationmark.circle")
                        Text(error).font(.system(size:11.5)).textSelection(.enabled)
                        Spacer(minLength:8)
                        Button("重试") { Task { await model.loadSchedulePage() } }
                            .buttonStyle(.plain)
                            .disabled(model.schedulesLoading)
                            .accessibilityIdentifier("schedule.retry")
                    }
                    .foregroundStyle(.orange)
                    .padding(.vertical,8)
                    .accessibilityIdentifier("schedule.error")
                }
                if model.repoId == nil {
                    emptyState("先选择项目","计划任务按项目读取。")
                } else if model.schedulesLoading && model.schedules.isEmpty {
                    ProgressView("正在读取 Scheduler…").controlSize(.small)
                } else if model.schedules.isEmpty && model.error == nil {
                    emptyState("暂无计划任务","当前项目尚未配置定时或条件触发任务。")
                } else if !model.schedules.isEmpty {
                    VStack(alignment:.leading,spacing:0) {
                        ForEach(Array(model.schedules.enumerated()),id:\.element.id) { index,item in
                            scheduleRow(item)
                            if index < model.schedules.count - 1 { Divider() }
                        }
                    }
                }
            }
            .frame(maxWidth:960,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.leading)
            .padding(30)
        }
        .confirmationDialog("确认任务操作",isPresented:Binding(
            get:{ pendingAction != nil },
            set:{ if !$0 { pendingAction = nil } }
        ),titleVisibility:.visible) {
            if let pending = pendingAction {
                Button(pending.action == .pause ? "暂停任务" : (pending.action == .resume ? "恢复任务" : "立即运行"),
                       role:pending.action == .pause ? .destructive : nil) {
                    let selected = pending
                    pendingAction = nil
                    Task { await model.controlSchedule(selected.item,action:selected.action) }
                }
            }
            Button("取消",role:.cancel) { pendingAction = nil }
        } message: {
            if let pending = pendingAction {
                Text("\(pending.item.name) · \(pending.item.trigger)\n\(pending.action == .trigger ? "将请求 Forge Scheduler 立即触发；是否产生执行实例以 Runtime 回执为准。" : "此操作将更新 Forge Scheduler 中的任务状态。")")
            }
        }
    }

    private func scheduleRow(_ item:ProjectScheduleDetail) -> some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(alignment:.top,spacing:10) {
                Button {
                    if !expandedIds.insert(item.id).inserted { expandedIds.remove(item.id) }
                } label: {
                    HStack(alignment:.top,spacing:10) {
                        Circle().fill(item.enabled ? Color.green : Color.secondary)
                            .frame(width:7,height:7).padding(.top,6)
                        VStack(alignment:.leading,spacing:5) {
                            HStack(spacing:7) {
                                Text(item.name).font(.system(size:13,weight:.semibold))
                                    .lineLimit(2)
                                if !item.enabled {
                                    Text("已暂停").font(.system(size:10)).foregroundStyle(.secondary)
                                }
                            }
                            Text(item.trigger).font(.system(size:11.5))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(2)
                            if let next = item.nextEligibleAt {
                                Text("下次 · \(next)").font(.system(size:10))
                                    .foregroundStyle(.tertiary).lineLimit(1)
                            }
                        }
                        Spacer(minLength:6)
                        Image(systemName:expandedIds.contains(item.id) ? "chevron.up" : "chevron.down")
                            .font(.system(size:10,weight:.medium)).foregroundStyle(.secondary)
                            .padding(.top,5)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(item.name)，\(item.enabled ? "已启用" : "已暂停")，\(expandedIds.contains(item.id) ? "收起详情" : "展开详情")")
                .accessibilityIdentifier("schedule.\(item.scheduleId).details")
                Menu {
                    Button(item.enabled ? "暂停" : "恢复") {
                        pendingAction = (item,item.enabled ? .pause : .resume)
                    }
                    Button("立即运行") {
                        pendingAction = (item,.trigger)
                    }
                    .disabled(!item.enabled)
                } label: {
                    Image(systemName:"ellipsis").frame(width:26,height:26)
                }
                .menuStyle(.borderlessButton).fixedSize()
                .disabled(model.schedulesLoading)
                .accessibilityIdentifier("schedule.\(item.scheduleId).actions")
            }
            if expandedIds.contains(item.id) {
                VStack(alignment:.leading,spacing:9) {
                    if let reason = item.pausedReason,!reason.isEmpty {
                        Label(reason,systemImage:"pause.circle")
                            .font(.system(size:11))
                            .foregroundStyle(.orange)
                    }
                    HStack(spacing:18) {
                        if let last = item.lastTriggeredAt {
                            meta("上次运行",last)
                        } else {
                            meta("上次运行","尚无")
                        }
                        if let next = item.nextEligibleAt {
                            meta("下次运行",next)
                        }
                    }
                    DisclosureGroup("技术信息") {
                        VStack(alignment:.leading,spacing:6) {
                            meta("任务 ID",item.scheduleId)
                            meta("执行动作",item.operation)
                            if let updated = item.updatedAt { meta("更新",updated) }
                        }
                        .padding(.top,7)
                    }
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                }
                .padding(.leading,17)
                .accessibilityIdentifier("schedule.\(item.scheduleId).expanded")
            }
        }.padding(.vertical,12)
    }

    private func meta(_ label:String,_ value:String) -> some View {
        Text("\(label) · \(value)")
            .font(.system(size:10.5,design:.monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal:false,vertical:true)
    }

    private func emptyState(_ title:String,_ detail:String) -> some View {
        VStack(alignment:.leading,spacing:5) {
            Text(title).font(.system(size:13,weight:.medium))
            Text(detail).font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
        }.padding(.vertical,16)
    }
}

private struct PluginsPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var searchOpen = false
    @State private var query = ""
    @State private var expandedIds: Set<String> = []
    @FocusState private var searchFocused: Bool

    private var visiblePlugins: [ProjectPluginDetail] {
        let term = query.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !term.isEmpty else { return model.plugins }
        return model.plugins.filter { item in
            item.displayName.localizedCaseInsensitiveContains(term)
                || item.pluginId.localizedCaseInsensitiveContains(term)
                || (item.provider?.localizedCaseInsensitiveContains(term) == true)
                || item.capabilities.contains(where:{ $0.localizedCaseInsensitiveContains(term) })
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:5) {
                        Text("插件").font(.system(size:22,weight:.medium))
                        Text("查看当前项目可用的插件、连接状态与能力。")
                            .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    Button { Task { await model.loadPluginsPage() } } label: {
                        if model.pluginsLoading { ProgressView().controlSize(.small) }
                        else { Label("刷新",systemImage:"arrow.clockwise") }
                    }
                    .buttonStyle(.plain)
                    .disabled(model.pluginsLoading || model.repoId == nil)
                    .accessibilityIdentifier("plugins.refresh")
                    Button {
                        searchOpen.toggle()
                        if !searchOpen { query = "" }
                        else { searchFocused = true }
                    } label: {
                        Image(systemName:searchOpen ? "xmark" : "magnifyingglass")
                            .frame(width:28,height:28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(searchOpen ? "关闭插件搜索" : "搜索插件")
                    .accessibilityIdentifier("plugins.search.toggle")
                }

                if searchOpen {
                    HStack(spacing:7) {
                        Image(systemName:"magnifyingglass")
                            .foregroundStyle(ForgePalette.secondary)
                        TextField("搜索名称、Provider 或能力",text:$query)
                            .textFieldStyle(.plain)
                            .focused($searchFocused)
                            .font(.system(size:12))
                            .accessibilityIdentifier("plugins.search.field")
                        if !query.isEmpty {
                            Button { query = "" } label: {
                                Image(systemName:"xmark.circle.fill")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("清除插件搜索")
                        }
                    }
                    .padding(.vertical,8)
                    .overlay(alignment:.bottom) { Divider() }
                }
                if let error = model.error, model.repoId != nil {
                    HStack(alignment:.firstTextBaseline,spacing:9) {
                        Image(systemName:"exclamationmark.circle")
                        Text(error).font(.system(size:11.5)).textSelection(.enabled)
                        Spacer(minLength:8)
                        Button("重试") { Task { await model.loadPluginsPage() } }
                            .buttonStyle(.plain)
                            .disabled(model.pluginsLoading)
                            .accessibilityIdentifier("plugins.retry")
                    }
                    .foregroundStyle(.orange)
                    .padding(.vertical,8)
                    .accessibilityIdentifier("plugins.error")
                }
                if model.repoId == nil {
                    emptyState("先选择项目","插件能力会结合当前项目返回。")
                } else if model.pluginsLoading && model.plugins.isEmpty {
                    ProgressView("正在读取插件…").controlSize(.small)
                } else if model.plugins.isEmpty && model.error == nil {
                    emptyState("没有可用插件","Runtime 当前没有为这个项目注册插件。")
                } else if !model.plugins.isEmpty {
                    if visiblePlugins.isEmpty {
                        emptyState("无匹配插件","尝试其他名称、Provider 或能力关键词。")
                    } else {
                        VStack(alignment:.leading,spacing:0) {
                            Text("显示 \(visiblePlugins.count) / \(model.plugins.count) 项")
                                .font(.system(size:10)).foregroundStyle(.tertiary)
                                .padding(.bottom,6)
                            ForEach(Array(visiblePlugins.enumerated()),id:\.element.id) { index,item in
                                pluginRow(item)
                                if index < visiblePlugins.count - 1 { Divider() }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth:960,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.leading)
            .padding(30)
        }
    }

    private func pluginRow(_ item:ProjectPluginDetail) -> some View {
        VStack(alignment:.leading,spacing:10) {
            Button {
                if !expandedIds.insert(item.id).inserted { expandedIds.remove(item.id) }
            } label: {
                HStack(alignment:.top,spacing:10) {
                    Circle().fill(!item.enabled ? Color.secondary : (item.ready ? Color.green : Color.orange))
                        .frame(width:7,height:7).padding(.top,6)
                    VStack(alignment:.leading,spacing:5) {
                        HStack(spacing:7) {
                            Text(item.displayName).font(.system(size:13,weight:.semibold))
                                .lineLimit(2)
                            if !item.enabled {
                                Text("已禁用").font(.system(size:10)).foregroundStyle(.secondary)
                            }
                        }
                        Text(item.pluginId).font(.system(size:10,design:.monospaced))
                            .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        Text("\(item.actionCount) 个动作 · \(item.ready ? "可用" : "未就绪")")
                            .font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer(minLength:6)
                    Image(systemName:expandedIds.contains(item.id) ? "chevron.up" : "chevron.down")
                        .font(.system(size:10,weight:.medium)).foregroundStyle(.secondary)
                        .padding(.top,5)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.displayName)，\(item.ready ? "就绪" : "未就绪")，\(expandedIds.contains(item.id) ? "收起详情" : "展开详情")")
            .accessibilityIdentifier("plugins.\(item.pluginId).details")
            if expandedIds.contains(item.id) {
                VStack(alignment:.leading,spacing:11) {
                    if !item.capabilities.isEmpty {
                        Text("可用能力").font(.system(size:10.5,weight:.semibold))
                        LazyVGrid(columns:[GridItem(.adaptive(minimum:180,maximum:300),spacing:12,alignment:.leading)],
                                  alignment:.leading,spacing:7) {
                            ForEach(Array(item.capabilities.enumerated()),id:\.offset) { _, capability in
                                HStack(alignment:.top,spacing:7) {
                                    Image(systemName:"checkmark")
                                        .font(.system(size:8.5,weight:.semibold))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .padding(.top,3)
                                    Text(capability).font(.system(size:11.5))
                                        .foregroundStyle(ForgePalette.ink)
                                        .frame(maxWidth:.infinity,alignment:.leading)
                                        .fixedSize(horizontal:false,vertical:true)
                                }
                            }
                        }
                        if item.capabilities.count < item.actionCount {
                            Text("展示 \(item.capabilities.count) / \(item.actionCount) 项代表能力。")
                                .font(.system(size:10)).foregroundStyle(.tertiary)
                        }
                    } else {
                        Text("当前没有可展示的能力摘要。")
                            .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                    }

                    DisclosureGroup("技术信息") {
                        LazyVGrid(columns:[GridItem(.adaptive(minimum:180,maximum:300),spacing:12,alignment:.leading)],
                                  alignment:.leading,spacing:8) {
                            meta("插件 ID",item.pluginId)
                            if let version = item.pluginVersion { meta("版本",version) }
                            if let provider = item.provider { meta("Provider",provider) }
                            meta("生命周期",item.lifecycle == "enabled" ? "已启用" : item.lifecycle)
                            meta("健康",item.health == "ready" ? "就绪" : item.health)
                            meta("启用状态",item.enabled ? "已启用" : "已禁用")
                            meta("动作数","\(item.actionCount)")
                        }
                        .padding(.top,7)
                    }
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                }
                .padding(.leading,17)
                .accessibilityIdentifier("plugins.\(item.pluginId).expanded")
            }
        }.padding(.vertical,12)
    }

    private func meta(_ label:String,_ value:String) -> some View {
        Text("\(label) · \(value)")
            .font(.system(size:10.5,design:.monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal:false,vertical:true)
    }

    private func emptyState(_ title:String,_ detail:String) -> some View {
        VStack(alignment:.leading,spacing:5) {
            Text(title).font(.system(size:13,weight:.medium))
            Text(detail).font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
        }.padding(.vertical,16)
    }
}

private struct PluginSettingsSection: View {
    @ObservedObject var model: NativeWorkspace
    @State private var pendingInstallation: PluginManagementItem?

    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                VStack(alignment:.leading,spacing:4) {
                    Text("插件管理").font(.system(size:13,weight:.semibold))
                    Text("管理官方插件版本；安装不会自动授予插件操作权限。")
                        .font(.system(size:10.5)).foregroundStyle(.tertiary)
                }
                Spacer()
                Button { Task { await model.loadPluginManagement() } } label: {
                    if model.pluginManagementLoading { ProgressView().controlSize(.small) }
                    else { Image(systemName:"arrow.clockwise") }
                }
                .buttonStyle(.plain)
                .disabled(model.pluginManagementLoading)
                .accessibilityLabel("刷新插件管理")
                .accessibilityIdentifier("settings.plugins.refresh")
            }

            if let error = model.pluginManagementError {
                HStack(alignment:.top,spacing:8) {
                    Image(systemName:"exclamationmark.circle")
                    Text(error.contains("controller.plugins") || error.contains("CORE_CAPABILITY")
                         ? "当前运行时不支持插件管理；仍可在工作区查看已注册的插件。"
                         : "插件状态无法确认：\(error)")
                        .font(.system(size:11))
                        .fixedSize(horizontal:false,vertical:true)
                        .textSelection(.enabled)
                    Spacer(minLength:6)
                    Button("重试") { Task { await model.loadPluginManagement() } }
                        .buttonStyle(.plain)
                        .disabled(model.pluginManagementLoading)
                        .accessibilityIdentifier("settings.plugins.retry")
                }
                .foregroundStyle(.orange)
                .accessibilityIdentifier("settings.plugins.error")
            }
            if model.pluginManagement.isEmpty {
                if model.pluginManagementLoading {
                    ProgressView("正在读取官方插件目录…").controlSize(.small)
                } else if model.pluginManagementError == nil {
                    Text("暂无可安装的官方插件。")
                        .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                }
            } else {
                VStack(alignment:.leading,spacing:0) {
                    ForEach(Array(model.pluginManagement.enumerated()),id:\.element.id) { index,item in
                        HStack(alignment:.top,spacing:11) {
                            Circle()
                                .fill(item.installedVersion == nil ? Color.secondary : (item.enabled == false ? Color.orange : Color.green))
                                .frame(width:7,height:7).padding(.top,6)
                            VStack(alignment:.leading,spacing:4) {
                                HStack(spacing:7) {
                                    Text(item.name).font(.system(size:11.5,weight:.semibold))
                                    Text(item.version).font(.system(size:9.5,design:.monospaced)).foregroundStyle(.tertiary)
                                }
                                Text(item.description).font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary).lineLimit(2)
                                HStack(spacing:10) {
                                    Text(item.installedVersion.map { "已安装 \($0)" } ?? "未安装")
                                    if item.enabled == false && item.installedVersion != nil { Text("已禁用") }
                                    if item.authorizationCount > 0 { Text("授权 \(item.authorizationCount)") }
                                }
                                .font(.system(size:9.5)).foregroundStyle(.tertiary)
                                if !item.compatible {
                                    Text(item.compatibilityReason ?? "当前平台不兼容")
                                        .font(.system(size:10.5)).foregroundStyle(.orange)
                                        .fixedSize(horizontal:false,vertical:true)
                                }
                            }
                            Spacer(minLength:8)
                            Button(item.installedVersion == item.version ? "已安装" : (item.installedVersion == nil ? "安装" : "更新")) {
                                pendingInstallation = item
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(model.pluginManagementLoading || !item.compatible || item.installedVersion == item.version)
                            .accessibilityIdentifier("settings.plugins.\(item.pluginId).install")
                        }
                        .padding(.vertical,9)
                        if index < model.pluginManagement.count - 1 { Divider() }
                    }
                }
            }
        }
        .padding(.vertical,8)
        .confirmationDialog("确认安装官方插件",isPresented:Binding(
            get:{ pendingInstallation != nil },
            set:{ if !$0 { pendingInstallation = nil } }
        ),titleVisibility:.visible) {
            if let item = pendingInstallation {
                Button(item.installedVersion == nil ? "确认安装" : "确认更新") {
                    pendingInstallation = nil
                    Task { await model.installOfficialPlugin(item) }
                }
            }
            Button("取消",role:.cancel) { pendingInstallation = nil }
        } message: {
            if let item = pendingInstallation {
                Text("\(item.name) · \(item.version)\n将更改 Forge 中的插件安装状态，不会自动授予操作权限。")
            }
        }
    }
}

private struct RuntimeSettingsSection: View {
    @ObservedObject var model: NativeWorkspace
    @State private var setupController = "chatgpt"
    @State private var copiedMcpCommand: String?

    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            VStack(alignment:.leading,spacing:5) {
                Text("连接").font(.system(size:13,weight:.semibold))
                Text("连接配置和外部客户端接入；Runtime 细节按需展开。")
                    .font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
            }

            connectionCard

            Divider()

            externalClientGuide

            Divider()

            DisclosureGroup {
                VStack(alignment:.leading,spacing:12) {
                    runtimeCard
                    if let diagnostics = model.runtimeDiagnostics {
                        Divider()
                        runtimeDiagnostics(diagnostics)
                    }
                }
                .padding(.top,10)
            } label: {
                HStack(spacing:8) {
                    Circle().fill(runtimeColor).frame(width:7,height:7)
                    Text("Runtime 与诊断")
                        .font(.system(size:11.5,weight:.semibold))
                    Spacer()
                    Text(model.runtimeLabel)
                        .font(.system(size:10.5))
                        .foregroundStyle(ForgePalette.secondary)
                }
            }
        }
    }

    private func runtimeDiagnostics(_ diagnostics: RuntimeDiagnosticsDetail) -> some View {
        VStack(alignment:.leading,spacing:12) {
            HStack(alignment:.top) {
                VStack(alignment:.leading,spacing:3) {
                    Text("上次诊断").font(.system(size:12,weight:.semibold))
                    if let checkedAt = diagnostics.checkedAt, !checkedAt.isEmpty {
                        Text(checkedAt)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
                Text("\(diagnostics.passed) 通过 · \(diagnostics.failed) 失败")
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(diagnostics.ok ? Color.green : Color.orange)
            }
            ForEach(diagnostics.probes) { probe in
                HStack(spacing:9) {
                    Image(systemName:probe.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(probe.ok ? Color.green : Color.orange)
                    Text(probe.label).font(.system(size:11.5))
                    Spacer()
                }
            }
        }
        .padding(.vertical,6)
    }

    private var externalClientGuide: some View {
        DisclosureGroup("在其他客户端使用 Forge") {
            VStack(alignment:.leading,spacing:12) {
                VStack(alignment:.leading,spacing:5) {
                    Text("ChatGPT").font(.system(size:11.5,weight:.semibold))
                    Text("在 ChatGPT 的连接设置中添加 Forge，使用现有 Secure MCP Tunnel 或 HTTPS /mcp 地址。")
                    Text("添加后用下面的提示进行只读连通性验证。")
                    copyableMcpCommand("Use Forge. Call rh_status and report whether the Runtime is ready. Do not modify anything yet.")
                }
                if model.checkoutIsAvailable, let checkoutPath = model.checkoutRoot?.path {
                    let repoArgument = shellQuotedMcpPath(checkoutPath)
                    Divider()
                    VStack(alignment:.leading,spacing:5) {
                        Text("Claude Code").font(.system(size:11.5,weight:.semibold))
                        Text("写入 Claude Code 用户级 MCP 配置；执行后用 claude mcp get forge 验证。")
                        copyableMcpCommand("forge mcp setup claude --repo \(repoArgument) --scope user --profile controller")
                    }
                    Divider()
                    VStack(alignment:.leading,spacing:5) {
                        Text("其他支持 stdio 的 MCP 客户端").font(.system(size:11.5,weight:.semibold))
                        Text("将命令配置为 MCP 服务启动命令。它会固定暴露当前选中的 Checkout。")
                        copyableMcpCommand("forge mcp serve --repo \(repoArgument) --transport stdio --profile controller")
                    }
                } else {
                    Text("先在左侧选择有效的项目与 Checkout，再显示绑定该工作区的本地客户端命令。")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
            }
            .font(.system(size:11))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.top,10)
        }
        .font(.system(size:12))
        .accessibilityIdentifier("connection.external-guide")
    }

    private func copyableMcpCommand(_ command:String) -> some View {
        HStack(spacing:10) {
            Text(command)
                .font(.system(size:10.5,design:.monospaced))
                .textSelection(.enabled)
            Spacer(minLength:8)
            Button(copiedMcpCommand == command ? "已复制" : "复制") {
                NSPasteboard.general.clearContents()
                if NSPasteboard.general.setString(command,forType:.string) {
                    copiedMcpCommand = command
                } else {
                    model.error = "复制失败，请手动选择命令。"
                }
            }
            .buttonStyle(.bordered)
        }
    }

    private var runtimeCard: some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(spacing:9) {
                Circle().fill(runtimeColor).frame(width:8,height:8)
                Text(model.runtimeLabel)
                    .font(.system(size:14,weight:.semibold))
                Spacer()
                Button("刷新") { Task { await model.loadRuntimePage() } }
                    .buttonStyle(.plain).disabled(model.runtimeLoading)
                    .accessibilityIdentifier("runtime.refresh")
                Button("诊断") { Task { await model.diagnoseRuntime() } }
                    .buttonStyle(.bordered).disabled(model.runtimeLoading)
                    .accessibilityIdentifier("runtime.diagnose")
            }
            Text(model.runtimeDescription)
                .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            if let status = model.runtimeStatus {
                HStack(spacing:14) {
                    if let release = status.releaseId { runtimeMeta("Release",String(release.prefix(18))) }
                    if let pid = status.pid { runtimeMeta("PID","\(pid)") }
                    runtimeMeta("Reasons","\(status.reasonCount)")
                }
            }
        }
        .padding(.vertical,8)
    }

    private var connectionCard: some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(spacing:9) {
                Circle().fill(connectionColor).frame(width:8,height:8)
                Text(model.connection).font(.system(size:14,weight:.semibold))
                Spacer()
                Button("刷新连接") { Task { await model.loadRuntimePage() } }
                    .buttonStyle(.plain).disabled(model.connectionLoading)
                    .accessibilityIdentifier("connection.refresh")
                if model.connectionStatus?.repairAvailable == true {
                    Button(model.connectionStatus?.repairLabel ?? "重新连接") {
                        Task { await model.repairControllerConnection() }
                    }
                    .buttonStyle(.bordered).disabled(model.connectionLoading)
                    .accessibilityIdentifier("connection.repair")
                }
            }
            if let status = model.connectionStatus {
                connectionRow("本机服务",status.controller)
                connectionRow("远程连接",status.tunnel)
                if status.ready {
                    Text("连接配置已就绪。请在对应客户端发送一条消息确认可用。")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
                if status.configured, !status.ready, let setup = status.setup, let summary = setup.summary {
                    Divider()
                    VStack(alignment:.leading,spacing:6) {
                        HStack(spacing:8) {
                            Text(setup.requiresUser ? "需要你的操作" : "下一步")
                                .font(.system(size:11.5,weight:.semibold))
                            Spacer()
                            Button("重新检测") { Task { await model.loadRuntimePage() } }
                                .buttonStyle(.plain)
                                .disabled(model.connectionLoading)
                        }
                        Text(summary).font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
                        if let risk = setup.risk {
                            let riskLabel: String? = switch risk {
                            case "readonly": "只读操作"
                            case "workspace_write": "将修改本机文件或配置"
                            case "remote_write": "将修改远程服务中的数据"
                            case "destructive": "可能删除或覆盖数据"
                            default: nil
                            }
                            if let riskLabel {
                                Text(riskLabel).font(.system(size:10.5)).foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .padding(.top,2)
                    .accessibilityIdentifier("connection.setup.next")
                }
                if !status.configured {
                    Divider()
                    VStack(alignment:.leading,spacing:8) {
                        Text("首次连接").font(.system(size:11.5,weight:.semibold))
                        HStack(spacing:10) {
                            Picker("客户端",selection:$setupController) {
                                Text("ChatGPT").tag("chatgpt")
                                Text("Codex").tag("codex")
                                Text("Claude Code").tag("claude")
                                Text("MCP Client").tag("mcp")
                            }
                            .pickerStyle(.menu)
                            .frame(width:220,alignment:.leading)
                            .accessibilityIdentifier("connection.setup.controller")
                            Spacer()
                            Button(model.connectionLoading ? "配置中…" : "保存连接配置") {
                                Task { await model.configureInitialControllerConnection(setupController) }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.connectionLoading)
                            .accessibilityIdentifier("connection.setup.apply")
                        }
                        Text(setupController == "chatgpt" || setupController == "mcp"
                             ? "通过 Forge 远程连接。"
                             : "直接连接本机服务。")
                            .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                        Text("保存后，在对应客户端发送一条消息确认可用。")
                            .font(.system(size:10.5)).foregroundStyle(.tertiary)
                    }
                    .padding(.top,2)
                }
            } else {
                Text(model.connectionLoading ? "正在读取连接状态。" : "暂时无法读取连接状态。请刷新后重试。")
                    .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            }
        }
        .padding(.vertical,8)
    }

    private var runtimeColor: Color {
        guard let status = model.runtimeStatus else { return .secondary }
        if status.ready && !status.stale { return .green }
        return status.running ? .orange : .red
    }

    private var connectionColor: Color {
        guard let status = model.connectionStatus else { return .secondary }
        return status.ready ? .green : status.configured ? .orange : .red
    }

    private func runtimeMeta(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:2) {
            Text(label).font(.system(size:9.5,weight:.medium)).foregroundStyle(.tertiary)
            Text(value).font(.system(size:10.5,design:.monospaced)).textSelection(.enabled)
        }
    }

    private func connectionRow(_ label:String,_ item:ConnectionComponentDetail) -> some View {
        HStack(alignment:.top,spacing:10) {
            Image(systemName:item.ready ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(item.ready ? Color.green : Color.orange)
            VStack(alignment:.leading,spacing:3) {
                Text("\(label) · \(item.title)").font(.system(size:11.5,weight:.medium))
                Text(item.detail).font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
            }
        }
    }
}

private struct KnowledgePane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var selectedMemoryId: String?

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            VStack(alignment:.leading,spacing:11) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:4) {
                        Text("知识库")
                            .font(.system(size:20,weight:.medium))
                        Text("先找可复用判断，再决定是否带回当前会话。Cognitive 记录保持只读、仅供参考。")
                            .font(.system(size:11.5))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    if let result=model.knowledgeResult {
                        Text("\(result.items.count) 条结果")
                            .font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                }

                HStack(spacing:8) {
                    HStack(spacing:7) {
                        Image(systemName:"magnifyingglass")
                            .font(.system(size:10))
                            .foregroundStyle(.tertiary)
                        TextField("搜索经验、概念、技术决策…",text:$model.knowledgeQuery)
                            .textFieldStyle(.plain)
                            .font(.system(size:11.5))
                            .onSubmit { runSearch() }
                            .accessibilityIdentifier("knowledge.query")
                        if !model.knowledgeQuery.isEmpty {
                            Button {
                                model.knowledgeQuery=""
                                runSearch()
                            } label: {
                                Image(systemName:"xmark.circle.fill")
                                    .font(.system(size:9.5))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("清除知识搜索")
                        }
                    }
                    .padding(.horizontal,10)
                    .frame(height:34)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:9,style:.continuous))

                    Button { runSearch() } label: {
                        if model.knowledgeLoading {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName:"arrow.right")
                                .font(.system(size:10,weight:.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width:30,height:30)
                    .help("检索")
                    .disabled(model.knowledgeLoading || model.repoId == nil)
                    .accessibilityLabel("检索知识")
                    .accessibilityIdentifier("knowledge.search")
                }
            }
            .padding(.horizontal,22).padding(.top,20).padding(.bottom,14)

            Divider()

            if model.repoId == nil {
                knowledgeEmpty("先选择已注册的 Forge 项目，以限定知识检索范围。")
            } else if model.knowledgeLoading && model.knowledgeResult == nil {
                ProgressView("正在读取知识…")
                    .controlSize(.small)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let result=model.knowledgeResult,result.items.isEmpty {
                knowledgeEmpty("没有匹配的知识记录。换一个更具体的概念或技术决策再试。")
            } else if model.knowledgeResult == nil {
                knowledgeEmpty("输入问题或概念开始检索。")
            } else {
                GeometryReader { geometry in
                    let listWidth=min(max(280,geometry.size.width * 0.34),360)
                    HStack(spacing:0) {
                        knowledgeList
                            .frame(width:listWidth)
                        Divider()
                        knowledgeDetail
                            .frame(maxWidth:.infinity,maxHeight:.infinity)
                    }
                }
            }

            Divider()
            knowledgeStatusBar
        }
        .background(ForgePalette.canvas)
        .onChange(of:model.knowledgeResult?.items.map(\.memory.id) ?? []) { ids in
            if let selectedMemoryId,!ids.contains(selectedMemoryId) {
                self.selectedMemoryId=nil
            }
        }
    }

    private var memories:[KnowledgeMemoryDetail] {
        model.knowledgeResult?.items.map(\.memory) ?? []
    }

    private var selectedMemory:KnowledgeMemoryDetail? {
        if let selectedMemoryId,
           let exact=memories.first(where:{$0.id == selectedMemoryId}) {
            return exact
        }
        return memories.first
    }

    private var knowledgeList: some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                ForEach(memories) { memory in
                    let selected=selectedMemory?.id == memory.id
                    Button {
                        selectedMemoryId=memory.id
                    } label: {
                        VStack(alignment:.leading,spacing:6) {
                            HStack(spacing:6) {
                                Text(scopeLabel(memory.scope.kind))
                                    .font(.system(size:9,weight:.semibold))
                                    .foregroundStyle(ForgePalette.secondary)
                                if let concept=memory.concepts.first,!concept.isEmpty {
                                    Text(concept)
                                        .font(.system(size:9.5,weight:.medium))
                                        .lineLimit(1)
                                }
                                Spacer()
                                if selected {
                                    Image(systemName:"chevron.right")
                                        .font(.system(size:8.5,weight:.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            Text(memory.canonicalText)
                                .font(.system(size:11.5))
                                .foregroundStyle(ForgePalette.ink)
                                .lineLimit(3)
                                .multilineTextAlignment(.leading)
                            if let source=memory.provenance?.sourceKind,!source.isEmpty {
                                Text(source)
                                    .font(.system(size:9))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal,14).padding(.vertical,11)
                        .frame(maxWidth:.infinity,alignment:.leading)
                        .contentShape(Rectangle())
                        .background(selected ? ForgePalette.selection.opacity(0.75) : .clear)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("knowledge.result.\(memory.id)")
                    Divider().padding(.leading,14)
                }
            }
        }
        .scrollIndicators(.automatic)
    }

    @ViewBuilder
    private var knowledgeDetail: some View {
        if let memory=selectedMemory {
            ScrollView {
                VStack(alignment:.leading,spacing:16) {
                    VStack(alignment:.leading,spacing:6) {
                        HStack(spacing:7) {
                            Text(scopeLabel(memory.scope.kind))
                                .font(.system(size:9.5,weight:.semibold))
                                .foregroundStyle(ForgePalette.secondary)
                            if let source=memory.provenance?.sourceKind,!source.isEmpty {
                                Text(source)
                                    .font(.system(size:9.5))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Text(memory.canonicalText)
                            .font(.system(size:14,weight:.medium))
                            .lineSpacing(5)
                            .textSelection(.enabled)
                    }

                    HStack(spacing:9) {
                        Button {
                            model.useKnowledgeInCurrentConversation(memory)
                        } label: {
                            Label("加入当前草稿",systemImage:"text.badge.plus")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || model.thread == nil)
                        .help("加入当前会话草稿，可编辑后再发送；不会自动发送")
                        .accessibilityIdentifier("knowledge.use.\(memory.id)")

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(memory.canonicalText,forType:.string)
                        } label: {
                            Label("复制",systemImage:"doc.on.doc")
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("knowledge.copy.\(memory.id)")
                    }

                    if !memory.concepts.isEmpty {
                        knowledgeDetailSection("相关概念") {
                            ScrollView(.horizontal) {
                                HStack(spacing:6) {
                                    ForEach(memory.concepts,id:\.self) { concept in
                                        Button(concept) {
                                            model.knowledgeQuery=concept
                                            selectedMemoryId=nil
                                            runSearch()
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10,weight:.medium))
                                        .padding(.horizontal,8).frame(height:24)
                                        .background(ForgePalette.softFill,in:Capsule())
                                        .help("检索 \(concept)")
                                    }
                                }
                            }
                            .scrollIndicators(.hidden)
                        }
                    }

                    if !memory.facets.isEmpty {
                        knowledgeDetailSection("适用侧面") {
                            Text(memory.facets.joined(separator:" · "))
                                .font(.system(size:11))
                                .foregroundStyle(ForgePalette.secondary)
                                .textSelection(.enabled)
                        }
                    }

                    DisclosureGroup("来源与元数据") {
                        VStack(alignment:.leading,spacing:7) {
                            knowledgeMetadata("Scope","\(memory.scope.kind) / \(memory.scope.id)")
                            if let source=memory.provenance?.sourceKind,!source.isEmpty {
                                knowledgeMetadata("Source",source)
                            }
                            if let recorded=memory.provenance?.recordedAt,!recorded.isEmpty {
                                knowledgeMetadata("Recorded",recorded)
                            }
                            knowledgeMetadata("Confidence",String(format:"%.2f",memory.confidence))
                            knowledgeMetadata("Revision","r\(memory.revision)")
                            knowledgeMetadata("Memory ID",memory.id)
                        }
                        .padding(.top,9)
                    }
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.top,2)
                }
                .frame(maxWidth:620,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(.horizontal,24).padding(.vertical,22)
            }
            .scrollIndicators(.automatic)
        } else {
            knowledgeEmpty("选择左侧知识记录查看详情。")
        }
    }

    private var knowledgeStatusBar: some View {
        HStack(spacing:7) {
            if let result=model.knowledgeResult {
                Text("检索 \(result.inspected) 条 · 返回 \(result.items.count) 条")
                if result.truncated {
                    Text("· 结果已截断，建议缩小关键词")
                }
                if !result.gaps.isEmpty {
                    Text("· 部分范围不可达")
                        .foregroundStyle(.orange)
                        .help(result.gaps.joined(separator:"、"))
                }
            } else {
                Text("Forge Cognitive · 只读 advisory")
            }
            Spacer()
            Text(model.project?.label ?? "未选择项目")
        }
        .font(.system(size:9.5))
        .foregroundStyle(.tertiary)
        .padding(.horizontal,18)
        .frame(height:33)
    }

    private func knowledgeDetailSection<Content:View>(
        _ title:String,
        @ViewBuilder content:() -> Content
    ) -> some View {
        VStack(alignment:.leading,spacing:8) {
            Text(title)
                .font(.system(size:10.5,weight:.semibold))
                .foregroundStyle(ForgePalette.secondary)
            content()
        }
        .padding(.top,12)
        .overlay(alignment:.top) {
            Rectangle().fill(Color.primary.opacity(0.10)).frame(height:1)
        }
    }

    private func knowledgeMetadata(_ key:String,_ value:String) -> some View {
        HStack(alignment:.top,spacing:10) {
            Text(key)
                .frame(width:72,alignment:.leading)
                .foregroundStyle(.tertiary)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth:.infinity,alignment:.leading)
        }
        .font(.system(size:9.5,design:.monospaced))
    }

    private func knowledgeEmpty(_ message:String) -> some View {
        Text(message)
            .font(.system(size:11.5))
            .foregroundStyle(ForgePalette.secondary)
            .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            .padding(22)
    }

    private func scopeLabel(_ kind:String) -> String {
        switch kind {
        case "project": return "项目"
        case "workspace": return "工作空间"
        case "requirement": return "Requirement"
        case "plan": return "Plan"
        default: return kind
        }
    }

    private func runSearch() {
        selectedMemoryId=nil
        Task { await model.searchKnowledge() }
    }
}

private struct ProviderProfileDraft: Identifiable, Equatable {
    let id:String
    var label:String
    var endpoint:String
    var model:String
    var apiProtocol:String
    var credentialRef:String?

    var providerId:String { "api:\(id)" }

    init(_ detail:ApiProviderProfileDetail) {
        id=detail.id
        label=detail.label
        endpoint=detail.endpoint
        model=detail.model
        apiProtocol=detail.apiProtocol
        credentialRef=detail.credentialRef
    }

    init(id:String,label:String,endpoint:String,model:String,apiProtocol:String,credentialRef:String?=nil) {
        self.id=id
        self.label=label
        self.endpoint=endpoint
        self.model=model
        self.apiProtocol=apiProtocol
        self.credentialRef=credentialRef
    }

    func detail(existing:ApiProviderProfileDetail?) -> ApiProviderProfileDetail {
        ApiProviderProfileDetail(
            id:id,providerId:providerId,label:label,endpoint:endpoint,model:model,
            apiProtocol:apiProtocol,credentialRef:credentialRef,
            hasKey:existing?.hasKey ?? false,
            endpointReady:existing?.endpointReady ?? false
        )
    }
}

private struct SettingsPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var defaultProvider = "codex"
    @State private var profiles:[ProviderProfileDraft] = []
    @State private var selectedProfileId = ""
    @State private var joyCodeModel = "JoyAI-Code-1.6"
    @State private var saving = false
    @State private var credentialToDelete: String?

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:6) {
                        Text("设置").font(.system(size:22,weight:.medium))
                    }
                    Spacer()
                    Button {
                        Task { await model.loadSettingsPage() }
                    } label: {
                        if model.settingsLoading { ProgressView().controlSize(.small) }
                        else { Label("刷新",systemImage:"arrow.clockwise") }
                    }
                    .buttonStyle(.bordered).disabled(model.settingsLoading)
                    .accessibilityIdentifier("settings.refresh")
                }

                VStack(alignment:.leading,spacing:12) {
                    HStack(spacing:9) {
                        Circle().fill(model.selectedProviderReady ? Color.green : Color.orange)
                            .frame(width:8,height:8)
                        Text("当前会话 · \(selectedProviderLabel)")
                            .font(.system(size:14,weight:.semibold))
                        Spacer()
                    }
                    Text(model.selectedProviderReady ? "配置完整" : "待完善")
                        .font(.system(size:11,weight:.medium))
                        .foregroundStyle(model.selectedProviderReady ? ForgePalette.secondary : Color.orange)
                    LazyVGrid(columns:[GridItem(.adaptive(minimum:145,maximum:260),spacing:14,alignment:.leading)],
                              alignment:.leading,spacing:10) {
                        settingMeta("会话模型",NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                    ? (model.selectedApiModel.isEmpty ? "未配置" : model.selectedApiModel)
                                    : (model.selectedAgentModel?.displayName ?? "Codex 默认"))
                        settingMeta("推理强度",model.selectedProvider == "joycode" || NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                    ? "默认"
                                    : (model.selectedReasoningEffort.isEmpty ? "默认" : model.selectedReasoningEffort))
                        settingMeta("图片输入",model.selectedProviderSupportsImages ? "可用" : "不可用")
                    }
                    Text("默认服务仅用于新会话。")
                        .font(.system(size:10.5)).foregroundStyle(.tertiary)
                }
                .padding(.vertical,10)

                Divider()

                VStack(alignment:.leading,spacing:14) {
                    HStack {
                        VStack(alignment:.leading,spacing:4) {
                            Text("模型与 API").font(.system(size:17,weight:.semibold))
                            Text("保存后，在新会话中发送消息验证连接。")
                                .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        }
                        Spacer()
                        Menu {
                            Button("DeepSeek（官方 API）") {
                                addProfile(label:"DeepSeek",endpoint:"https://api.deepseek.com",model:"deepseek-chat",apiProtocol:"openai")
                            }
                            Button("DeepSeek · Zro（第三方兼容）") {
                                addProfile(label:"DeepSeek · Zro",endpoint:"https://zro.moonmath.ai/v1",model:"deepseek-v4.1-flash",apiProtocol:"openai")
                            }
                            Button("OpenAI") {
                                addProfile(label:"OpenAI",endpoint:"https://api.openai.com/v1",model:"",apiProtocol:"responses")
                            }
                            Button("Anthropic") {
                                addProfile(label:"Anthropic",endpoint:"https://api.anthropic.com/v1",model:"",apiProtocol:"anthropic")
                            }
                            Divider()
                            Button("自定义兼容 API") {
                                addProfile(label:"自定义服务",endpoint:"https://api.example.com/v1",model:"",apiProtocol:"openai")
                            }
                        } label: {
                            Label("添加模型服务",systemImage:"plus")
                        }
                        .menuStyle(.borderlessButton)
                        .accessibilityIdentifier("settings.profile.add")
                    }

                    HStack(spacing:12) {
                        Text("新会话默认").font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                        Picker("新会话默认",selection:$defaultProvider) {
                            Text("Codex").tag("codex")
                            ForEach(profiles) { profile in
                                Text(profile.label).tag(profile.providerId)
                            }
                            Text("JoyCode").tag("joycode")
                        }
                        .labelsHidden().pickerStyle(.menu).frame(maxWidth:300,alignment:.leading)
                        .accessibilityIdentifier("settings.default-provider")
                    }

                    if profiles.isEmpty {
                        VStack(spacing:10) {
                            Image(systemName:"server.rack").font(.system(size:24))
                                .foregroundStyle(ForgePalette.secondary)
                            Text("还没有 API 配置").font(.system(size:14,weight:.semibold))
                            Text("点击「添加模型服务」，选择 DeepSeek 或其他服务。")
                                .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                        }
                        .frame(maxWidth:.infinity,minHeight:190)
                    } else {
                        HStack(alignment:.top,spacing:22) {
                            VStack(alignment:.leading,spacing:5) {
                                Text("模型服务")
                                    .font(.system(size:11,weight:.semibold))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .padding(.bottom,7)
                                ForEach(profiles) { profile in
                                    Button {
                                        selectedProfileId=profile.id
                                    } label: {
                                        HStack(spacing:10) {
                                            Image(systemName:profile.endpoint.contains("deepseek") || profile.endpoint.contains("zro.moonmath")
                                                  ? "sparkle" : "server.rack")
                                                .font(.system(size:13))
                                                .frame(width:22)
                                            VStack(alignment:.leading,spacing:4) {
                                                Text(profile.label)
                                                    .font(.system(size:12,weight:.semibold))
                                                    .lineLimit(1)
                                                Text(profile.model)
                                                    .font(.system(size:10,design:.monospaced))
                                                    .foregroundStyle(ForgePalette.secondary)
                                                    .lineLimit(1)
                                            }
                                            Spacer(minLength:0)
                                            if defaultProvider == profile.providerId {
                                                Image(systemName:"checkmark.circle.fill")
                                                    .foregroundStyle(.green)
                                            } else if profileReady(profile) {
                                                Circle().fill(.green).frame(width:6,height:6)
                                            }
                                        }
                                        .padding(.horizontal,11).padding(.vertical,11)
                                        .frame(maxWidth:.infinity,alignment:.leading)
                                        .background(selectedProfileId == profile.id
                                            ? ForgePalette.softFill : Color.clear,
                                            in:RoundedRectangle(cornerRadius:9))
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("settings.profile.\(profile.id)")
                                }
                            }
                            .frame(width:210,alignment:.leading)

                            Rectangle().fill(ForgePalette.softFill).frame(width:1)

                            VStack(alignment:.leading,spacing:14) {
                                if let index=selectedProfileIndex {
                                    HStack {
                                        VStack(alignment:.leading,spacing:4) {
                                            Text(profiles[index].label)
                                                .font(.system(size:16,weight:.semibold))
                                            Text(profileReadiness(profiles[index]))
                                                .font(.system(size:11))
                                                .foregroundStyle(profileReady(profiles[index]) ? Color.green : ForgePalette.secondary)
                                        }
                                        Spacer()
                                        Menu {
                                            Button("设为新会话默认") {
                                                defaultProvider=profiles[index].providerId
                                            }
                                            Button("删除配置",role:.destructive) {
                                                deleteProfile(index)
                                            }
                                            .accessibilityIdentifier("settings.profile.delete")
                                        } label: {
                                            Image(systemName:"ellipsis")
                                                .frame(width:28,height:28)
                                        }
                                        .menuStyle(.borderlessButton)
                                    }
                                    providerEditor(index:index)
                                }
                            }
                            .frame(maxWidth:.infinity,alignment:.leading)
                        }
                    }

                    Divider()

                    DisclosureGroup("JoyCode") {
                        VStack(alignment:.leading,spacing:10) {
                    settingsField("JoyCode 模型") {
                        TextField("JoyAI-Code-1.6",text:$joyCodeModel)
                            .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                            .accessibilityIdentifier("settings.joycode-model")
                    }
                    HStack(spacing:7) {
                        Circle().fill(model.localApiSettings?.joyCodeReady == true ? Color.green : Color.orange)
                            .frame(width:7,height:7)
                        Text(model.localApiSettings?.joyCodeReady == true
                             ? "已登录 JoyCode。"
                             : "尚未登录 JoyCode。")
                            .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    }

                        }
                    }
                    .font(.system(size:12))

                    HStack(spacing:10) {
                        Spacer()
                        Button(saving ? "保存中…" : "保存更改") {
                            saveApiSettings()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(saveDisabled)
                        .accessibilityIdentifier("settings.save")
                    }

                    Text("API Key 安全保存在 macOS 钥匙串中。")
                        .font(.system(size:11)).foregroundStyle(.tertiary)
                }
                .padding(.vertical,10)

                Divider()
                RuntimeSettingsSection(model:model)
                DisclosureGroup("插件管理") {
                    PluginSettingsSection(model:model)
                        .padding(.top,12)
                }
            }
            .frame(maxWidth:960,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.leading)
            .padding(28)
        }
        .task(id:settingsSignature) {
            syncSettingsDraft()
        }
        .alert("删除 API Key？", isPresented: Binding(
            get: { credentialToDelete != nil },
            set: { if !$0 { credentialToDelete=nil } }
        )) {
            Button("删除", role:.destructive) {
                guard let credentialToDelete else { return }
                deleteCredential(credentialToDelete)
                self.credentialToDelete=nil
            }
            .accessibilityIdentifier("settings.credential.delete.confirm")
            Button("取消", role:.cancel) { credentialToDelete=nil }
        } message: {
            Text("删除后，使用此 API Key 的模型服务将无法连接，直到重新配置密钥。")
        }
    }

    @ViewBuilder
    private func providerEditor(index:Int) -> some View {
        VStack(alignment:.leading,spacing:11) {
            settingsField("名称") {
                TextField("服务名称",text:$profiles[index].label)
                    .textFieldStyle(.plain)
                    .accessibilityIdentifier("settings.profile.name")
            }
            settingsField("服务地址") {
                TextField("https://api.example.com",text:$profiles[index].endpoint)
                    .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                    .accessibilityIdentifier("settings.endpoint")
            }
            settingsField("模型 ID") {
                TextField("模型 ID",text:$profiles[index].model)
                    .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                    .accessibilityIdentifier("settings.model")
            }
            HStack(spacing:12) {
                Text("API 协议").font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                Picker("API 协议",selection:$profiles[index].apiProtocol) {
                    Text("OpenAI Chat").tag("openai")
                    Text("OpenAI Responses").tag("responses")
                    Text("Anthropic").tag("anthropic")
                }
                .labelsHidden().pickerStyle(.menu).frame(maxWidth:300,alignment:.leading)
                .accessibilityIdentifier("settings.api-protocol")
            }

            let endpoint=profiles[index].endpoint.trimmingCharacters(in:.whitespacesAndNewlines)
            if endpoint == "https://zro.moonmath.ai/v1" {
                Text("此配置使用 Zro 自己的登录信息，无需在 Forge 重复输入 API Key。")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
            } else if endpoint.lowercased().hasPrefix("http://localhost")
                        || endpoint.lowercased().hasPrefix("http://127.0.0.1") {
                Text("本机服务不需要 API Key。")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
            } else {
                settingsField("API Key") {
                    Picker("API Key",selection:$profiles[index].credentialRef) {
                        Text("未选择").tag(nil as String?)
                        ForEach(model.managedApiCredentials.filter { $0.endpoint == endpoint }) { credential in
                            Text("\(credential.label) · \(credential.authorized ? "已授权" : "未授权")")
                                .tag(Optional(credential.credentialRef))
                        }
                    }
                    .labelsHidden().pickerStyle(.menu)
                    .accessibilityIdentifier("settings.credential")
                }
                HStack(spacing:10) {
                    Button("从剪贴板粘贴并授权") { importCredential(index:index) }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("settings.credential.import")
                        .disabled(saving || model.settingsLoading || endpoint.isEmpty)
                    if let credential=selectedCredential(index:index) {
                        Button("从剪贴板更新 API Key") { rotateCredential(credential.credentialRef) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings.credential.rotate")
                        Button(credential.authorized ? "撤销授权" : "授权使用") {
                            setCredentialAuthorization(credential.credentialRef,!credential.authorized)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("settings.credential.authorization")
                        Button("删除 API Key",role:.destructive) {
                            credentialToDelete=credential.credentialRef
                        }
                        .buttonStyle(.plain).foregroundStyle(.red)
                        .accessibilityIdentifier("settings.credential.delete")
                    }
                }
                if let credential=selectedCredential(index:index) {
                    Text("\(credential.hasSecret ? "密钥已保存" : "密钥未找到") · \(credential.authorized ? "已授权使用" : "尚未授权")")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        .accessibilityIdentifier("settings.credential.status")
                }
            }
        }
        .padding(.vertical,6)
    }

    private var selectedProfileIndex:Int? {
        profiles.firstIndex { $0.id == selectedProfileId }
    }

    private var selectedProviderLabel:String {
        if model.selectedProvider == "codex" { return "Codex" }
        if model.selectedProvider == "joycode" { return "JoyCode" }
        return model.selectedApiProfile?.label ?? "API 服务"
    }

    private var settingsSignature:String {
        guard let settings=model.localApiSettings else { return "none" }
        let rows=settings.profiles.map {
            [$0.id,$0.label,$0.endpoint,$0.model,$0.apiProtocol,$0.credentialRef ?? ""].joined(separator:"|")
        }.joined(separator:";")
        return [settings.defaultProvider,rows,settings.joyCodeModel].joined(separator:"::")
    }

    private var saveDisabled:Bool {
        if saving || model.settingsLoading || joyCodeModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
            return true
        }
        if profiles.contains(where: {
            $0.label.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                || $0.endpoint.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                || $0.model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
        }) { return true }
        if defaultProvider == "joycode" && model.localApiSettings?.joyCodeReady != true { return true }
        return false
    }

    private func syncSettingsDraft() {
        guard let settings=model.localApiSettings else { return }
        defaultProvider=settings.defaultProvider
        profiles=settings.profiles.map(ProviderProfileDraft.init)
        if let id=settings.defaultProvider.split(separator:":",maxSplits:1).dropFirst().first,
           profiles.contains(where:{$0.id == String(id)}) {
            selectedProfileId=String(id)
        } else if !profiles.contains(where:{$0.id == selectedProfileId}) {
            selectedProfileId=profiles.first?.id ?? ""
        }
        joyCodeModel=settings.joyCodeModel
    }

    private func addProfile(label:String,endpoint:String,model:String,apiProtocol:String) {
        let id="profile-" + UUID().uuidString.prefix(8).lowercased()
        let profile=ProviderProfileDraft(
            id:String(id),label:label,endpoint:endpoint,model:model,apiProtocol:apiProtocol
        )
        profiles.append(profile)
        selectedProfileId=profile.id
    }

    private func deleteProfile(_ index:Int) {
        guard profiles.indices.contains(index) else { return }
        let providerId=profiles[index].providerId
        profiles.remove(at:index)
        if defaultProvider == providerId { defaultProvider="codex" }
        selectedProfileId=profiles.first?.id ?? ""
    }

    private func existingProfile(_ id:String) -> ApiProviderProfileDetail? {
        model.localApiSettings?.profiles.first { $0.id == id }
    }

    private func profileReady(_ profile:ProviderProfileDraft) -> Bool {
        guard let saved=existingProfile(profile.id), saved.endpointReady else { return false }
        return saved.label == profile.label
            && saved.endpoint == profile.endpoint
            && saved.model == profile.model
            && saved.apiProtocol == profile.apiProtocol
            && saved.credentialRef == profile.credentialRef
    }

    private func profileReadiness(_ profile:ProviderProfileDraft) -> String {
        profileReady(profile) ? "已保存 · 尚未验证" : "有未保存更改或配置不完整"
    }

    private func saveApiSettings() {
        guard !saveDisabled else { return }
        saving=true
        let details=profiles.map { $0.detail(existing:existingProfile($0.id)) }
        Task {
            _ = await model.saveLocalApiSettings(
                defaultProvider:defaultProvider,
                profiles:details,
                joyCodeModel:joyCodeModel
            )
            saving=false
        }
    }

    private func selectedCredential(index:Int) -> ManagedApiCredentialDetail? {
        guard profiles.indices.contains(index), let ref=profiles[index].credentialRef else { return nil }
        return model.managedApiCredentials.first { $0.credentialRef == ref }
    }

    private func importCredential(index:Int) {
        guard !saving, profiles.indices.contains(index) else { return }
        let endpoint=profiles[index].endpoint
        saving=true
        Task {
            if let credentialRef=await model.createManagedApiCredential(endpoint:endpoint,label:profiles[index].label) {
                profiles[index].credentialRef=credentialRef
            }
            saving=false
        }
    }

    private func rotateCredential(_ credentialRef:String) {
        guard !saving else { return }
        saving=true
        Task { _ = await model.rotateManagedApiCredential(credentialRef); saving=false }
    }

    private func setCredentialAuthorization(_ credentialRef:String,_ authorized:Bool) {
        guard !saving else { return }
        saving=true
        Task { _ = await model.setManagedApiCredentialAuthorization(credentialRef,authorized:authorized); saving=false }
    }

    private func deleteCredential(_ credentialRef:String) {
        guard !saving else { return }
        saving=true
        Task {
            if await model.deleteManagedApiCredential(credentialRef) {
                for index in profiles.indices where profiles[index].credentialRef == credentialRef {
                    profiles[index].credentialRef=nil
                }
            }
            saving=false
        }
    }

    @ViewBuilder
    private func settingsField<Content:View>(_ label:String,@ViewBuilder content:() -> Content) -> some View {
        VStack(alignment:.leading,spacing:6) {
            Text(label).font(.system(size:11,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            content()
                .padding(.horizontal,11).frame(height:36)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
    }

    private func settingMeta(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:3) {
            Text(label).font(.system(size:9.5,weight:.medium)).foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size:11.5,weight:.medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(value)
                .textSelection(.enabled)
        }
        .frame(maxWidth:.infinity,alignment:.leading)
    }
}
