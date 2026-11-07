import SwiftUI
import AppKit
import UniformTypeIdentifiers

private enum ForgePalette {
    static let canvas = Color(nsColor:.textBackgroundColor)
    static let ink = Color(red:0.16,green:0.18,blue:0.17)
    static let secondary = Color(red:0.45,green:0.47,blue:0.46)
    static let accent = Color(red:0.25,green:0.31,blue:0.26)
    static let selection = Color.primary.opacity(0.072)
    static let selectionStrong = Color.primary.opacity(0.095)
    static let userBubble = Color(red:0.945,green:0.949,blue:0.938)
    static let raisedSurface = Color.white.opacity(0.90)
    static let softFill = Color.primary.opacity(0.045)
    static let composer = Color.white.opacity(0.76)
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
                Button("显示 Requirement") { workspace.show(.requirement) }.keyboardShortcut("2")
                Button("显示 Plan") { workspace.show(.plan) }.keyboardShortcut("3")
                Button("显示知识库") { workspace.show(.knowledge) }.keyboardShortcut("4")
                Divider()
                Button("刷新项目") { Task { await workspace.refresh() } }.keyboardShortcut("r")
            }
        }
    }
}

private struct ForgeWorkspaceView: View {
    @ObservedObject var model: NativeWorkspace
    @State private var visibility: NavigationSplitViewVisibility = .all
    @State private var renameThreadId: String?
    @State private var renameThreadTitle = ""
    @State private var hoveredThreadId: String?
    @State private var deleteThreadId: String?
    @FocusState private var sidebarSearchFocused: Bool

    var body: some View {
        NavigationSplitView(columnVisibility:$visibility) {
            sidebar
                .navigationSplitViewColumnWidth(min:218,ideal:246,max:285)
        } detail: {
            main
        }
        .navigationSplitViewStyle(.balanced)
        .preferredColorScheme(.light)
        .toolbar {
            ToolbarItem(placement:.navigation) {
                Text(model.project?.label ?? "Forge")
                    .font(.system(size:12,weight:.semibold))
                    .foregroundStyle(ForgePalette.ink)
                    .lineLimit(1)
            }
            ToolbarItem(placement:.automatic) {
                HStack(spacing:7) {
                    Circle().fill(model.connection == "已连接" ? Color.green : Color.orange)
                        .frame(width:6,height:6)
                    Text(model.connection).font(.system(size:11))
                }.foregroundStyle(ForgePalette.secondary)
            }
        }
        .onChange(of:model.showSearch) { visible in
            sidebarSearchFocused = visible
        }
    }

    private var sidebar: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:9) {
                Image(systemName:"bolt.horizontal.circle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:20,weight:.medium))
                    .foregroundStyle(ForgePalette.ink)
                    .accessibilityHidden(true)
                Text("Forge")
                    .font(.system(size:14,weight:.semibold))
                Spacer()
                Text("Agent")
                    .font(.system(size:10,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
            }
            .padding(.horizontal,13).padding(.top,13).padding(.bottom,14)

            Button {
                model.show(.agent)
                model.newThread()
            } label: {
                HStack(spacing:10) {
                    Image(systemName:"plus")
                        .font(.system(size:10,weight:.semibold))
                        .frame(width:21,height:21)
                        .background(ForgePalette.accent.opacity(0.09),
                                    in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    Text("新会话")
                    Spacer()
                    Text("⌘N").font(.system(size:10)).foregroundStyle(.tertiary)
                }
                .font(.system(size:12,weight:.medium)).padding(.horizontal,10)
                .frame(height:40)
                .background(ForgePalette.raisedSurface,
                            in:RoundedRectangle(cornerRadius:13,style:.continuous))
                .shadow(color:Color.black.opacity(0.035),radius:7,y:2)
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            .padding(.horizontal,10).padding(.bottom,6)

            Button {
                model.toggleConversationSearch()
            } label: {
                HStack(spacing:10) {
                    Image(systemName:"magnifyingglass")
                        .symbolRenderingMode(.hierarchical)
                        .frame(width:17)
                    Text("搜索会话")
                    Spacer()
                    Text("⌘K").font(.system(size:10)).foregroundStyle(.tertiary)
                }
                .font(.system(size:12)).padding(.horizontal,12).frame(height:35)
                .background(model.showSearch ? ForgePalette.softFill : .clear,
                            in:RoundedRectangle(cornerRadius:10,style:.continuous))
                .contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(ForgePalette.secondary)
                .padding(.horizontal,10)

            if model.showSearch {
                HStack(spacing:7) {
                    Image(systemName:"magnifyingglass")
                        .font(.system(size:10.5))
                        .foregroundStyle(ForgePalette.secondary.opacity(0.8))
                    TextField("搜索标题或消息",text:$model.search)
                        .focused($sidebarSearchFocused)
                        .textFieldStyle(.plain)
                        .font(.system(size:12))
                    if !model.search.isEmpty {
                        Button { model.search = "" } label: {
                            Image(systemName:"xmark.circle.fill")
                                .font(.system(size:11))
                                .foregroundStyle(ForgePalette.secondary.opacity(0.72))
                        }
                        .buttonStyle(.plain)
                        .help("清除搜索")
                    }
                }
                .padding(.horizontal,10)
                .frame(height:34)
                .background(ForgePalette.raisedSurface,
                            in:RoundedRectangle(cornerRadius:11,style:.continuous))
                .overlay(RoundedRectangle(cornerRadius:11,style:.continuous)
                    .stroke(Color.black.opacity(0.055),lineWidth:0.7))
                .padding(.horizontal,12).padding(.vertical,7)
            }

            sectionLabel("工作空间").padding(.top,19)
            ForEach(NativePage.allCases.filter { $0 != .settings }) { section in
                navigationRow(section)
            }

            sectionLabel("最近会话")
                .padding(.top,21)
                .padding(.bottom,4)
            ScrollView {
                LazyVStack(alignment:.leading,spacing:2) {
                    if model.visibleThreads.isEmpty {
                        threadListEmptyState
                    } else {
                        ForEach(model.visibleThreads) { thread in
                            threadRow(thread)
                        }
                    }
                }.padding(.horizontal,10)
            }.scrollIndicators(.hidden)
            Spacer(minLength:5)

            Menu {
                ForEach(model.projects) { project in
                    Button {
                        model.selectProject(project.repoId)
                    } label: {
                        if project.repoId == model.repoId {
                            Label(project.label,systemImage:"checkmark")
                        } else {
                            Text(project.label)
                        }
                    }
                }
                Divider()
                Button("刷新项目") { Task { await model.refresh() } }
            } label: {
                HStack(spacing:9) {
                    Image(systemName:"folder.fill")
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:13))
                        .foregroundStyle(ForgePalette.secondary)
                        .frame(width:20)
                    VStack(alignment:.leading,spacing:2) {
                        Text(model.project?.label ?? "选择项目").font(.system(size:12,weight:.semibold))
                            .lineLimit(1)
                        Text(model.project?.defaultBranch ?? "Forge Registry")
                            .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    Image(systemName:"chevron.up.chevron.down").font(.system(size:10))
                }
                .padding(.horizontal,11).frame(height:50)
                .background(ForgePalette.softFill,
                            in:RoundedRectangle(cornerRadius:13,style:.continuous))
                .contentShape(Rectangle())
            }.menuStyle(.borderlessButton).padding(.horizontal,10).padding(.top,5)
            navigationRow(.settings).padding(.bottom,11)
        }
        .foregroundStyle(ForgePalette.ink)
        .background(.ultraThinMaterial)
    }

    private func threadRow(_ thread: ChatThread) -> some View {
        let selected = model.selectedThreadId == thread.id && model.page == .agent
        let hovered = hoveredThreadId == thread.id
        let deleting = deleteThreadId == thread.id
        let running = model.activeConversationId == thread.id
        let showDelete = hovered || deleting

        return HStack(spacing:4) {
            Button { model.selectThread(thread.id) } label: {
                HStack(spacing:8) {
                    Image(systemName:selected ? "bubble.left.fill" : "bubble.left")
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:11))
                        .frame(width:17)
                    Text(thread.title)
                        .font(.system(size:12,weight:selected ? .medium : .regular))
                        .lineLimit(1)
                    Spacer(minLength:0)
                }
                .frame(maxWidth:.infinity,alignment:.leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy && !running)
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
        .padding(.leading,10).padding(.trailing,5)
        .frame(height:34)
        .background(selected ? ForgePalette.selectionStrong : (hovered ? ForgePalette.softFill : .clear),
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
        .contentShape(RoundedRectangle(cornerRadius:10,style:.continuous))
        .onHover { inside in
            if inside {
                hoveredThreadId = thread.id
            } else if hoveredThreadId == thread.id {
                hoveredThreadId = nil
            }
        }
        .animation(.easeOut(duration:0.12),value:hovered)
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

    private func sectionLabel(_ name: String) -> some View {
        Text(name.uppercased())
            .font(.system(size:9.5,weight:.semibold))
            .tracking(0.55)
            .foregroundStyle(ForgePalette.secondary.opacity(0.88))
            .padding(.horizontal,21).padding(.bottom,7)
    }

    private func navigationRow(_ section: NativePage) -> some View {
        Button { model.show(section) } label: {
            HStack(spacing:10) {
                Image(systemName:section.symbol)
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:12.5,weight:model.page == section ? .semibold : .regular))
                    .foregroundStyle(model.page == section ? ForgePalette.ink : ForgePalette.secondary)
                    .frame(width:18)
                Text(section.rawValue).font(.system(size:12,weight:model.page == section ? .semibold : .regular))
                Spacer()
            }
            .padding(.horizontal,12)
            .frame(height:36)
            .background(model.page == section ? ForgePalette.selection : .clear,
                        in:RoundedRectangle(cornerRadius:11,style:.continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(section.accessibilityId)
        .padding(.horizontal,10)
    }

    private var main: some View {
        VStack(spacing:0) {
            if let error = model.error {
                HStack(spacing:9) {
                    Image(systemName:"exclamationmark.circle")
                    Text(error).lineLimit(2)
                    Spacer()
                    Button("关闭") { model.error = nil }.buttonStyle(.plain)
                }
                .font(.system(size:11))
                .foregroundStyle(Color(red:0.58,green:0.26,blue:0.24))
                .padding(.horizontal,12).frame(height:38)
                .background(Color(red:0.99,green:0.95,blue:0.93),
                            in:RoundedRectangle(cornerRadius:11,style:.continuous))
                .padding(.horizontal,14).padding(.top,8)
            }
            HStack(spacing:9) {
                Image(systemName:model.page.symbol)
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:11.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:25,height:25)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:8,style:.continuous))
                Text(model.page.rawValue)
                    .font(.system(size:13,weight:.semibold))
                Spacer()
                if model.page == .agent, let thread = model.thread {
                    Label(thread.checkoutId == nil ? "未绑定" : (model.checkoutBranch ?? "Checkout"),
                          systemImage:"point.3.connected.trianglepath.dotted")
                        .font(.system(size:10))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1)
                }
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
            switch model.page {
            case .agent: AgentPane(model:model)
            case .requirement,.plan: RecordsPane(model:model)
            case .knowledge: KnowledgePane(model:model)
            case .runtime: RuntimePane(model:model)
            case .settings: SettingsPane(model:model)
            }
        }
        .background(ForgePalette.canvas)
    }
}

private struct AgentPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var showChanges = false
    @State private var showActivityDetails = false
    @State private var expandedMessageActivities: Set<String> = []
    @State private var isComposerDropTarget = false
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
                                ZStack {
                                    Circle()
                                        .fill(ForgePalette.accent.opacity(0.09))
                                        .frame(width:54,height:54)
                                    Image(systemName:"bolt.fill")
                                        .font(.system(size:20,weight:.medium))
                                        .foregroundStyle(ForgePalette.accent)
                                }
                                .accessibilityHidden(true)
                                VStack(spacing:7) {
                                    Text("把结果交给 Forge")
                                        .font(.system(size:24,weight:.medium)).tracking(-0.45)
                                    Text("当前项目、checkout 与 Forge 语义记录保持为真实上下文；Agent 负责执行，Requirement / Plan 仍是唯一语义事实。")
                                        .font(.system(size:12))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .multilineTextAlignment(.center)
                                        .lineSpacing(4)
                                        .frame(maxWidth:470)
                                }
                                HStack(spacing:8) {
                                    starterPromptButton("审查当前改动",systemImage:"doc.text.magnifyingglass",
                                                        prompt:"检查当前 checkout 的未提交改动，指出风险并完成必要修复与验证。")
                                    starterPromptButton("定位问题",systemImage:"scope",
                                                        prompt:"读取当前项目真实状态，定位最高价值的问题并直接修复，完成必要验证。")
                                    starterPromptButton("实现需求",systemImage:"hammer",
                                                        prompt:"读取当前 Requirement / Plan 与代码现状，选择最高价值的下一项实现并完成验证。")
                                }
                            }
                            .padding(.top,70)
                            .frame(maxWidth:.infinity)
                        }
                        ForEach(model.thread?.messages ?? []) { message in
                            if message.role == "user" {
                                HStack(alignment:.top) {
                                    Spacer(minLength:96)
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
                                .frame(maxWidth:.infinity)
                                .id(message.id)
                            } else {
                                HStack(alignment:.top,spacing:10) {
                                    Image(systemName:"bolt.circle")
                                        .foregroundStyle(ForgePalette.accent)
                                        .font(.system(size:17))
                                        .padding(.top,1)
                                        .accessibilityHidden(true)
                                    VStack(alignment:.leading,spacing:8) {
                                        AgentAssistantMessageBody(text:message.text)
                                        HStack(spacing:10) {
                                            if let count = message.toolActivityCount, count > 0 {
                                                if message.activityEvents?.isEmpty == false {
                                                    Button {
                                                        if expandedMessageActivities.contains(message.id) {
                                                            expandedMessageActivities.remove(message.id)
                                                        } else {
                                                            expandedMessageActivities.insert(message.id)
                                                        }
                                                    } label: {
                                                        HStack(spacing:5) {
                                                            Label("\(count) 次工具调用",systemImage:"hammer")
                                                            Image(systemName:expandedMessageActivities.contains(message.id)
                                                                  ? "chevron.up" : "chevron.down")
                                                                .font(.system(size:8,weight:.semibold))
                                                        }
                                                    }
                                                    .buttonStyle(.plain)
                                                } else {
                                                    Label("\(count) 次工具调用",systemImage:"hammer")
                                                }
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
                                        if expandedMessageActivities.contains(message.id),
                                           let events = message.activityEvents, !events.isEmpty {
                                            VStack(alignment:.leading,spacing:5) {
                                                ForEach(events) { event in
                                                    HStack(spacing:7) {
                                                        Image(systemName:activityIcon(event.phase))
                                                            .font(.system(size:9.5,weight:.medium))
                                                            .frame(width:12)
                                                        VStack(alignment:.leading,spacing:2) {
                                                            Text(event.label).lineLimit(1)
                                                            if let detail = event.detail, !detail.isEmpty {
                                                                Text(detail)
                                                                    .font(.system(size:9.5,design:.monospaced))
                                                                    .foregroundStyle(.tertiary)
                                                                    .lineLimit(2)
                                                            }
                                                        }
                                                        Spacer(minLength:8)
                                                        Image(systemName:event.status == "completed" ? "checkmark" : "circle.fill")
                                                            .font(.system(size:event.status == "completed" ? 8 : 5,weight:.semibold))
                                                    }
                                                }
                                            }
                                            .font(.system(size:10.5))
                                            .foregroundStyle(ForgePalette.secondary)
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
                                        Text("Agent 正在执行")
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
                                    if let count = model.liveActivity?.priorEvents.count, count > 4 {
                                        Button(showActivityDetails ? "收起" : "全部") {
                                            withAnimation(.easeOut(duration:0.16)) {
                                                showActivityDetails.toggle()
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10.5,weight:.medium))
                                    }
                                }

                                let activityEvents = showActivityDetails
                                    ? model.liveActivity?.priorEvents ?? []
                                    : model.liveActivity?.recentPriorEvents ?? []
                                if !activityEvents.isEmpty {
                                    Divider().opacity(0.45)
                                    VStack(alignment:.leading,spacing:7) {
                                        ForEach(activityEvents) { event in
                                            activityTrailRow(event)
                                        }
                                    }
                                }
                            }
                            .padding(11)
                            .background(ForgePalette.raisedSurface,
                                        in:RoundedRectangle(cornerRadius:12,style:.continuous))
                            .overlay(RoundedRectangle(cornerRadius:12,style:.continuous)
                                .stroke(Color.black.opacity(0.055),lineWidth:0.7))
                            .shadow(color:Color.black.opacity(0.025),radius:5,y:2)
                            .id("pending")
                        }
                    }
                    .frame(maxWidth:790,alignment:.leading)
                    .frame(maxWidth:.infinity)
                    .padding(.horizontal,34).padding(.top,24).padding(.bottom,26)
                }.scrollIndicators(.automatic)
                .onChange(of:model.thread?.messages.count) { _ in
                    if let last = model.thread?.messages.last {
                        withAnimation(.easeOut(duration:0.2)) { reader.scrollTo(last.id,anchor:.bottom) }
                    }
                }
            }
            VStack(alignment:.leading,spacing:0) {
                ZStack(alignment:.topLeading) {
                    if model.draft.isEmpty {
                        Text("描述要完成的任务…")
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
                        .frame(minHeight:56,maxHeight:105)
                        .padding(.horizontal,12).padding(.top,10)
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
                    ViewThatFits(in:.horizontal) {
                        HStack(spacing:7) { agentConfigurationControls }
                        compactAgentConfigurationControl
                    }
                    .frame(maxWidth:430,alignment:.leading)
                    .layoutPriority(-1)

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
                            .frame(width:25,height:25)
                            .background(ForgePalette.softFill,
                                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(model.busy || (model.checkoutRoot == nil && !model.selectedProviderSupportsImages))
                    .help("添加当前 checkout 文件上下文或图片")
                    .accessibilityLabel("添加上下文")
                    .accessibilityHint("添加当前 checkout 文件或当前 Provider 支持的图片")
                    .accessibilityIdentifier("agent.attach")

                    if model.selectedProvider == "api", model.checkoutId != nil {
                        Button {
                            model.allowApiEffects.toggle()
                        } label: {
                            Image(systemName:model.allowApiEffects ? "shield.checkered" : "shield")
                                .font(.system(size:10,weight:.medium))
                                .foregroundStyle(model.allowApiEffects ? ForgePalette.accent : ForgePalette.secondary)
                                .frame(width:25,height:25)
                                .background(model.allowApiEffects ? ForgePalette.selectionStrong : ForgePalette.softFill,
                                            in:RoundedRectangle(cornerRadius:8,style:.continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                        .help(model.allowApiEffects
                              ? "本轮 API Agent 可执行受 Forge 约束的写操作；发送后自动关闭"
                              : "本轮 API Agent 只允许只读工具；点击后仅授权下一次发送的写操作")
                        .accessibilityLabel("API 写操作授权")
                        .accessibilityValue(model.allowApiEffects ? "下一次发送已授权" : "未授权")
                        .accessibilityHint("授权仅对下一次 API 发送有效")
                        .accessibilityIdentifier("agent.api-effects")
                    }

                    Button {
                        withAnimation(.easeOut(duration:0.18)) { showChanges.toggle() }
                        if showChanges {
                            Task { await model.refreshAgentChanges() }
                        }
                    } label: {
                        HStack(spacing:5) {
                            Image(systemName:"doc.text.magnifyingglass")
                                .font(.system(size:9.5,weight:.medium))
                            Text(model.changedFileCount > 0 ? "Changes \(model.changedFileCount)" : "Changes")
                        }
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(showChanges ? ForgePalette.ink : ForgePalette.secondary)
                        .padding(.horizontal,8)
                        .frame(height:25)
                        .background(showChanges ? ForgePalette.selectionStrong : ForgePalette.softFill,
                                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(model.checkoutId == nil)
                    .help("查看当前 checkout 的未提交改动")
                    .accessibilityLabel("Git Changes")
                    .accessibilityValue(model.changedFileCount > 0 ? "\(model.changedFileCount) 个文件" : "无已加载改动")
                    .accessibilityIdentifier("agent.changes")

                    Circle()
                        .fill(model.selectedProvider == "api"
                              ? (model.apiProfileReady ? Color.green : Color.red)
                              : (model.provider.contains("已连接") ? Color.green : Color.orange))
                        .frame(width:6,height:6)
                        .help(model.selectedProvider == "api"
                              ? (model.apiProfileReady ? "兼容 API profile 已就绪" : "兼容 API profile 未完成")
                              : model.provider)
                        .accessibilityLabel("Provider 状态")
                        .accessibilityValue(model.selectedProvider == "api"
                                            ? (model.apiProfileReady ? "API 已就绪" : "API 未完成配置")
                                            : model.provider)
                    Spacer()
                    Text("⌘↵").font(.system(size:10)).foregroundStyle(.tertiary)
                    if model.busy {
                        Button { Task { await model.cancel() } } label: {
                            Image(systemName:"stop.fill")
                                .font(.system(size:9,weight:.semibold))
                                .frame(width:29,height:29)
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
                            || (model.selectedProvider == "api" && !model.apiProfileReady)
                            || (model.thread?.repoId != nil && model.thread?.checkoutId == nil)
                        Button { Task { await model.send() } } label: {
                            Image(systemName:"arrow.up")
                                .font(.system(size:11,weight:.bold))
                                .foregroundStyle(.white)
                                .frame(width:29,height:29)
                                .background(ForgePalette.accent,in:Circle())
                                .opacity(sendDisabled ? 0.34 : 1)
                        }
                        .buttonStyle(.plain)
                        .disabled(sendDisabled)
                        .keyboardShortcut(.return,modifiers:.command)
                        .help("发送消息（⌘↵）")
                        .accessibilityLabel("发送消息")
                        .accessibilityValue(sendDisabled ? "不可发送" : "可发送")
                        .accessibilityHint("按 Command Return 发送")
                        .accessibilityIdentifier("agent.send")
                    }
                }.padding(.horizontal,13).padding(.bottom,11)
            }
            .background(ForgePalette.composer,
                        in:RoundedRectangle(cornerRadius:19,style:.continuous))
            .background(.ultraThinMaterial,
                        in:RoundedRectangle(cornerRadius:19,style:.continuous))
            .overlay {
                RoundedRectangle(cornerRadius:19,style:.continuous)
                    .stroke(isComposerDropTarget ? ForgePalette.accent.opacity(0.55) : .clear,lineWidth:1.25)
            }
            .dropDestination(for:URL.self) { urls, _ in
                guard !model.busy, !urls.isEmpty else { return false }
                model.addDroppedAttachments(urls)
                return true
            } isTargeted: { targeted in
                isComposerDropTarget = targeted && !model.busy
            }
            .shadow(color:Color.black.opacity(0.060),radius:18,y:7)
            .frame(maxWidth:760)
            .padding(.horizontal,30).padding(.bottom,20)
            .frame(maxWidth:.infinity)
        }
        .background(ForgePalette.canvas)
        .overlay(alignment:.trailing) {
            if showChanges {
                AgentChangesPane(model:model,isPresented:$showChanges)
                    .frame(width:390)
                    .padding(.vertical,10)
                    .padding(.trailing,10)
                    .transition(.move(edge:.trailing).combined(with:.opacity))
            }
        }
        .animation(.easeOut(duration:0.18),value:showChanges)
        .onAppear {
            if !model.busy { composerFocused = true }
        }
        .onChange(of:model.selectedThreadId) { _ in
            if !model.busy { composerFocused = true }
        }
    }

    private var agentWorkspaceBar: some View {
        HStack(spacing:10) {
            HStack(spacing:7) {
                Image(systemName:"folder.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                Text(model.project?.label ?? "未选择项目")
                    .font(.system(size:11.5,weight:.semibold))
                    .lineLimit(1)
                if let context = checkoutContextLabel {
                    Text(context)
                        .font(.system(size:9.5,weight:.medium,design:.monospaced))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1)
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
                    semanticContextButton("Requirement",page:.requirement,systemImage:"doc.text")
                    semanticContextButton("Plan",page:.plan,systemImage:"list.bullet.rectangle")
                    semanticContextButton("Knowledge",page:.knowledge,systemImage:"books.vertical")
                }
                HStack(spacing:3) {
                    semanticContextButton("Requirement",page:.requirement,systemImage:"doc.text",compact:true)
                    semanticContextButton("Plan",page:.plan,systemImage:"list.bullet.rectangle",compact:true)
                    semanticContextButton("Knowledge",page:.knowledge,systemImage:"books.vertical",compact:true)
                }
            }

            Divider().frame(height:18)

            HStack(spacing:6) {
                Circle()
                    .fill(model.busy ? ForgePalette.accent : Color.green)
                    .frame(width:6,height:6)
                Text(model.busy ? "执行中" : "就绪")
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
            }
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

    private func semanticContextButton(_ title: String, page: NativePage, systemImage: String,
                                       compact: Bool = false) -> some View {
        Button { model.show(page) } label: {
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
        .help("打开当前项目的 \(title)")
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
            .frame(height:30)
            .background(ForgePalette.raisedSurface,
                        in:RoundedRectangle(cornerRadius:9,style:.continuous))
            .overlay(RoundedRectangle(cornerRadius:9,style:.continuous)
                .stroke(Color.black.opacity(0.055),lineWidth:0.7))
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
    }

    private func activityTrailRow(_ event: AgentLiveActivityEvent) -> some View {
        HStack(alignment:.top,spacing:8) {
            ZStack {
                Circle()
                    .fill(event.status == "completed" ? Color.green.opacity(0.11) : ForgePalette.softFill)
                    .frame(width:21,height:21)
                Image(systemName:event.status == "completed" ? "checkmark" : activityIcon(event.phase))
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(event.status == "completed" ? Color.green : ForgePalette.secondary)
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
                        .lineLimit(2)
                }
            }
            Spacer(minLength:8)
        }
    }

    private var compactAgentConfigurationControl: some View {
        Menu {
            Menu("项目") {
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
            }
            .disabled(model.projects.isEmpty || model.busy)

            Menu("Provider") {
                Button {
                    model.selectThreadProvider("codex")
                } label: {
                    if model.selectedProvider == "codex" {
                        Label("Codex CLI",systemImage:"checkmark")
                    } else {
                        Text("Codex CLI")
                    }
                }
                Button {
                    model.selectThreadProvider("api")
                } label: {
                    if model.selectedProvider == "api" {
                        Label("兼容 API",systemImage:"checkmark")
                    } else {
                        Text("兼容 API")
                    }
                }
                .disabled(!model.apiProfileReady)
            }
            .disabled(model.busy || model.thread?.messages.isEmpty == false)

            if model.selectedProvider == "codex" {
                Menu("模型") {
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
                    }
                }
                .disabled(model.agentModels.isEmpty || model.busy)

                Menu("Reasoning") {
                    ForEach(model.selectedReasoningOptions) { option in
                        Button {
                            model.selectReasoningEffort(option.effort)
                        } label: {
                            if model.selectedReasoningEffort == option.effort {
                                Label(reasoningLabel(option.effort),systemImage:"checkmark")
                            } else {
                                Text(reasoningLabel(option.effort))
                            }
                        }
                    }
                }
                .disabled(model.selectedReasoningOptions.isEmpty || model.busy)
            } else {
                Button(compactApiModelLabel) {}
                    .disabled(true)
            }
        } label: {
            HStack(spacing:5) {
                Image(systemName:"slider.horizontal.3")
                    .font(.system(size:9.5,weight:.medium))
                Text("配置")
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.ink)
            .padding(.horizontal,8)
            .frame(height:25)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Agent 配置")
        .accessibilityValue(compactConfigurationAccessibilityValue)
        .accessibilityIdentifier("agent.configuration.compact")
    }

    private var compactApiModelLabel: String {
        "模型 · \(model.localApiSettings?.model ?? "API 模型")"
    }

    private var compactConfigurationAccessibilityValue: String {
        let project = model.project?.label ?? "未选择项目"
        let provider = model.selectedProvider == "api" ? "兼容 API" : "Codex CLI"
        return "\(project)，\(provider)"
    }

    @ViewBuilder
    private var agentConfigurationControls: some View {
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
            HStack(spacing:5) {
                Image(systemName:"folder.fill")
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size:9.5,weight:.medium))
                Text(model.project?.label ?? "选择项目").lineLimit(1)
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.horizontal,8)
            .frame(height:25)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.projects.isEmpty || model.busy)
        .help("切换项目会创建新的会话，避免改变已有 Agent 上下文")
        .accessibilityLabel("项目")
        .accessibilityValue(model.project?.label ?? "未选择")
        .accessibilityIdentifier("agent.project")

        Menu {
            Button { model.selectThreadProvider("codex") } label: {
                if model.selectedProvider == "codex" { Label("Codex CLI",systemImage:"checkmark") }
                else { Text("Codex CLI") }
            }
            Button { model.selectThreadProvider("api") } label: {
                if model.selectedProvider == "api" { Label("兼容 API",systemImage:"checkmark") }
                else { Text("兼容 API") }
            }
            .disabled(!model.apiProfileReady)
        } label: {
            HStack(spacing:5) {
                Image(systemName:model.selectedProvider == "api" ? "network" : "terminal")
                    .font(.system(size:9.5,weight:.medium))
                Text(model.selectedProvider == "api" ? "API" : "Codex")
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.ink)
            .padding(.horizontal,8)
            .frame(height:25)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.busy || model.thread?.messages.isEmpty == false)
        .help(model.thread?.messages.isEmpty == false
              ? "已有历史的会话固定 Provider；新建会话可切换"
              : "选择当前会话 Provider")
        .accessibilityLabel("Provider")
        .accessibilityValue(model.selectedProvider == "api" ? "兼容 API" : "Codex CLI")
        .accessibilityIdentifier("agent.provider")

        agentModelControl

        Menu {
            ForEach(model.selectedReasoningOptions) { option in
                Button {
                    model.selectReasoningEffort(option.effort)
                } label: {
                    if model.selectedReasoningEffort == option.effort {
                        Label(reasoningLabel(option.effort),systemImage:"checkmark")
                    } else {
                        Text(reasoningLabel(option.effort))
                    }
                }
            }
        } label: {
            HStack(spacing:5) {
                Image(systemName:"brain.head.profile")
                    .font(.system(size:9.5,weight:.medium))
                Text(model.selectedProvider == "api" ? "API" : reasoningLabel(model.selectedReasoningEffort))
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.ink)
            .padding(.horizontal,8)
            .frame(height:25)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.selectedProvider != "codex" || model.selectedReasoningOptions.isEmpty || model.busy)
        .help(model.selectedProvider == "api" ? "兼容 API 不使用 Codex reasoning 目录" : "当前模型的推理强度")
    }

    private var agentModelControl: some View {
        Menu {
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
            }
        } label: {
            HStack(spacing:5) {
                Image(systemName:model.selectedProvider == "api" ? "server.rack" : "cpu")
                    .font(.system(size:9.5,weight:.medium))
                Text(agentModelLabel).lineLimit(1)
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.ink)
            .padding(.horizontal,8)
            .frame(height:25)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.selectedProvider != "codex" || model.agentModels.isEmpty || model.busy)
        .help(model.selectedProvider == "api"
              ? "API 模型来自保存的本地 profile"
              : (model.selectedAgentModel?.description ?? "从 Codex 当前模型目录选择"))
    }

    private var agentModelLabel: String {
        if model.selectedProvider == "api" {
            return model.localApiSettings?.model ?? "API 模型"
        }
        return model.selectedAgentModel?.displayName ?? "选择模型"
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

private struct AgentAssistantMessageBody: View {
    let text: String
    private var blocks: [AgentMessageBlock] { AgentMessageBlock.parse(text) }

    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            ForEach(Array(blocks.enumerated()),id:\.offset) { _, block in
                switch block {
                case .markdown(let markdown):
                    markdownView(markdown)
                case .code(let language,let code):
                    AgentCodeBlockView(language:language,code:code)
                }
            }
        }
        .frame(maxWidth:.infinity,alignment:.leading)
    }

    @ViewBuilder
    private func markdownView(_ markdown: String) -> some View {
        if let attributed = try? AttributedString(markdown:markdown) {
            Text(attributed)
                .font(.system(size:13))
                .lineSpacing(6)
                .textSelection(.enabled)
        } else {
            Text(markdown)
                .font(.system(size:13))
                .lineSpacing(6)
                .textSelection(.enabled)
        }
    }
}

private struct AgentCodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:8) {
                Image(systemName:"chevron.left.forwardslash.chevron.right")
                    .font(.system(size:9,weight:.semibold))
                    .foregroundStyle(.tertiary)
                Text(language?.isEmpty == false ? language! : "code")
                    .font(.system(size:9.5,weight:.medium,design:.monospaced))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
                Spacer()
                Button {
                    copyAgentText(code)
                } label: {
                    Label("复制",systemImage:"doc.on.doc")
                        .font(.system(size:9.5,weight:.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(ForgePalette.secondary)
                .help("复制代码")
            }
            .padding(.horizontal,10)
            .frame(height:30)
            .background(ForgePalette.selection)

            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(size:11.5,design:.monospaced))
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .fixedSize(horizontal:true,vertical:false)
                    .padding(11)
            }
            .scrollIndicators(.automatic)
            .frame(maxWidth:.infinity,alignment:.leading)
            .background(ForgePalette.softFill)
        }
        .clipShape(RoundedRectangle(cornerRadius:10,style:.continuous))
        .overlay {
            RoundedRectangle(cornerRadius:10,style:.continuous)
                .strokeBorder(Color.primary.opacity(0.055),lineWidth:0.5)
        }
    }
}
private struct AgentChangesPane: View {
    @ObservedObject var model: NativeWorkspace
    @Binding var isPresented: Bool
    @State private var commitMessage = ""
    @State private var restoreSnapshot: AgentGitDiff?
    @State private var focusedPath: String?
    @State private var focusedChanges: AgentGitDiff?
    @State private var focusedLoading = false

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:9) {
                Image(systemName:"doc.text.magnifyingglass")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(ForgePalette.accent)
                Text("Changes")
                    .font(.system(size:13,weight:.semibold))
                if model.changedFileCount > 0 {
                    Text("\(model.changedFileCount)")
                        .font(.system(size:10,weight:.semibold))
                        .padding(.horizontal,7).padding(.vertical,3)
                        .background(ForgePalette.selectionStrong,in:Capsule())
                }
                Spacer()
                Button {
                    focusedPath = nil
                    focusedChanges = nil
                    Task { await model.refreshAgentChanges() }
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
                    withAnimation(.easeOut(duration:0.16)) { isPresented = false }
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
                        VStack(alignment:.leading,spacing:4) {
                            Text(changes.branch)
                                .font(.system(size:11,weight:.semibold))
                                .lineLimit(1)
                            Text(String(changes.head.prefix(10)))
                                .font(.system(size:10,design:.monospaced))
                                .foregroundStyle(.tertiary)
                        }

                        if changes.nameOnly.isEmpty {
                            VStack(spacing:10) {
                                Image(systemName:"checkmark.circle")
                                    .font(.system(size:24,weight:.light))
                                    .foregroundStyle(ForgePalette.secondary)
                                Text("工作区没有未提交改动")
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
                                            let snapshot = await model.reviewAgentChanges(paths:[path])
                                            focusedLoading = false
                                            if let snapshot {
                                                focusedPath = path
                                                focusedChanges = snapshot
                                            }
                                        }
                                    } label: {
                                        HStack(spacing:7) {
                                            Image(systemName:"doc")
                                                .font(.system(size:10))
                                                .foregroundStyle(ForgePalette.secondary)
                                            Text(path)
                                                .font(.system(size:10.5))
                                                .lineLimit(1)
                                                .truncationMode(.middle)
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
                            } else if !reviewed.stat.isEmpty {
                                Text(reviewed.stat)
                                    .font(.system(size:10.5,design:.monospaced))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .textSelection(.enabled)
                            }

                            if !focusedLoading {
                                Text(reviewed.patch)
                                    .font(.system(size:10.5,design:.monospaced))
                                    .lineSpacing(3)
                                    .textSelection(.enabled)
                                    .frame(maxWidth:.infinity,alignment:.leading)
                                    .padding(11)
                                    .background(ForgePalette.softFill,
                                                in:RoundedRectangle(cornerRadius:10,style:.continuous))
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
                                    .disabled(model.changesLoading || focusedLoading || reviewed.staged
                                              || reviewed.truncated || reviewed.patch.isEmpty)
                                    .help("放弃当前已复查的 tracked / unstaged 改动")
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
        .background(.ultraThinMaterial,
                    in:RoundedRectangle(cornerRadius:16,style:.continuous))
        .shadow(color:Color.black.opacity(0.12),radius:22,y:8)
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
}

private struct RecordsPane: View {
    @ObservedObject var model: NativeWorkspace

    var body: some View {
        HStack(spacing:12) {
            ScrollView {
                LazyVStack(alignment:.leading,spacing:5) {
                    Text("\(model.records.count) 项")
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(ForgePalette.secondary)
                        .padding(.horizontal,3).padding(.bottom,9)
                    ForEach(model.records) { item in
                        Button {
                            Task { await model.openRecord(item.id) }
                        } label: {
                            VStack(alignment:.leading,spacing:6) {
                                Text(item.title).font(.system(size:12,weight:.medium))
                                    .lineLimit(2).multilineTextAlignment(.leading)
                                HStack {
                                    Text(item.id).lineLimit(1)
                                    Spacer()
                                    Text(item.state)
                                }.font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                            }
                            .padding(.horizontal,11).padding(.vertical,10)
                            .frame(maxWidth:.infinity,alignment:.leading)
                            .background(item.id == model.selectedRecord ?
                                ForgePalette.selection : .clear,
                                in:RoundedRectangle(cornerRadius:12,style:.continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(item.title)
                        .accessibilityValue("\(item.id) · \(item.state)")
                        .accessibilityIdentifier("semantic.record.\(item.id)")
                    }
                }.padding(11)
            }
            .frame(width:300)
            .background(.ultraThinMaterial,
                        in:RoundedRectangle(cornerRadius:16,style:.continuous))
            .padding(.leading,12).padding(.vertical,12)

            ScrollView {
                VStack(alignment:.leading,spacing:17) {
                    if let selected = model.records.first(where:{$0.id == model.selectedRecord}) {
                        HStack(alignment:.top,spacing:12) {
                            VStack(alignment:.leading,spacing:7) {
                                Text(selected.title).font(.system(size:20,weight:.medium))
                                Text(selected.id).font(.system(size:11,design:.monospaced))
                                    .foregroundStyle(ForgePalette.secondary)
                            }
                            Spacer()
                            Text(selected.state)
                                .font(.system(size:10,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                                .padding(.horizontal,9).frame(height:24)
                                .background(ForgePalette.softFill,
                                            in:Capsule())
                        }
                    } else {
                        VStack(alignment:.leading,spacing:11) {
                            Image(systemName:"doc.text.magnifyingglass")
                                .symbolRenderingMode(.hierarchical)
                                .font(.system(size:21))
                                .foregroundStyle(ForgePalette.secondary)
                                .frame(width:42,height:42)
                                .background(ForgePalette.softFill,
                                            in:RoundedRectangle(cornerRadius:13,style:.continuous))
                            Text("选择左侧记录以查看详情")
                                .font(.system(size:14)).foregroundStyle(ForgePalette.secondary)
                        }.padding(.top,16)
                    }
                    if let recordDetail = model.recordDetail {
                        semanticRecordDetail(recordDetail)
                    }
                }
                .frame(maxWidth:790,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(.horizontal,22).padding(.vertical,24)
            }
        }.background(ForgePalette.canvas)
    }

    @ViewBuilder
    private func semanticRecordDetail(_ detail: SemanticRecordDetail) -> some View {
        switch detail {
        case .requirement(let requirement):
            VStack(alignment:.leading,spacing:18) {
                semanticSection("目标") {
                    Text(requirement.outcomeStatement.isEmpty ? "未提供 outcome。" : requirement.outcomeStatement)
                        .font(.system(size:12.5)).lineSpacing(4).textSelection(.enabled)
                }
                if !requirement.acceptanceCriteria.isEmpty {
                    semanticSection("验收标准") {
                        semanticBulletList(requirement.acceptanceCriteria)
                    }
                }
                if !requirement.progressSummary.isEmpty {
                    semanticSection("当前进度") {
                        Text(requirement.progressSummary)
                            .font(.system(size:12.5)).lineSpacing(4).textSelection(.enabled)
                    }
                }
                if !requirement.remainingWork.isEmpty {
                    semanticSection("剩余工作") {
                        semanticBulletList(requirement.remainingWork)
                    }
                }
                Text("Requirement · r\(requirement.revision) · \(requirement.state)")
                    .font(.system(size:10,design:.monospaced)).foregroundStyle(.tertiary)
            }
        case .plan(let plan):
            VStack(alignment:.leading,spacing:18) {
                semanticSection("目标") {
                    Text(plan.goal).font(.system(size:12.5)).lineSpacing(4).textSelection(.enabled)
                }
                if let requirementId = plan.requirementId, !requirementId.isEmpty {
                    Button {
                        Task { await model.openRequirement(requirementId) }
                    } label: {
                        HStack(spacing:7) {
                            Image(systemName:"doc.text")
                            Text("打开 Requirement")
                            Text(requirementId).font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary)
                            Spacer(minLength:0)
                            Image(systemName:"chevron.right").font(.system(size:9,weight:.semibold))
                        }
                        .font(.system(size:11,weight:.medium))
                        .padding(.horizontal,11).frame(height:34)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("打开 Requirement")
                    .accessibilityValue(requirementId)
                    .accessibilityIdentifier("semantic.open-requirement")
                }
                if !plan.items.isEmpty {
                    semanticSection("计划项") {
                        VStack(alignment:.leading,spacing:9) {
                            ForEach(plan.items) { item in
                                VStack(alignment:.leading,spacing:3) {
                                    Text(item.objective).font(.system(size:12.5)).lineSpacing(3)
                                    Text(item.id).font(.system(size:9.5,design:.monospaced)).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }
                if !plan.resolvedDecisions.isEmpty {
                    semanticSection("已确认决策") { semanticBulletList(plan.resolvedDecisions) }
                }
                if !plan.nonGoals.isEmpty {
                    semanticSection("不做") { semanticBulletList(plan.nonGoals) }
                }
                HStack(spacing:8) {
                    Text("Plan · r\(plan.revision)")
                    if let source = plan.sourceBasisRevision, !source.isEmpty {
                        Text(String(source.prefix(10))).textSelection(.enabled)
                    }
                }
                .font(.system(size:10,design:.monospaced)).foregroundStyle(.tertiary)
            }
        }
    }

    private func semanticSection<Content:View>(_ title:String,@ViewBuilder content:() -> Content) -> some View {
        VStack(alignment:.leading,spacing:9) {
            Text(title).font(.system(size:11,weight:.semibold)).foregroundStyle(ForgePalette.secondary)
            content()
        }
        .padding(14)
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:13,style:.continuous))
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

private struct RuntimePane: View {
    @ObservedObject var model: NativeWorkspace

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                VStack(alignment:.leading,spacing:6) {
                    Text("Runtime 与连接").font(.system(size:22,weight:.medium))
                    Text("读取现有 Recovery 与 controller.connection 权威；此页面不提供版本切换、回滚或 Runtime 激活。")
                        .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                }
                runtimeCard
                connectionCard
                if let diagnostics = model.runtimeDiagnostics {
                    VStack(alignment:.leading,spacing:12) {
                        HStack {
                            Text("诊断").font(.system(size:12,weight:.semibold))
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
                    .padding(15)
                    .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:14,style:.continuous))
                }
            }
            .frame(maxWidth:850,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.leading)
            .padding(30)
        }
    }

    private var runtimeCard: some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(spacing:9) {
                Circle().fill(runtimeColor).frame(width:8,height:8)
                Text(model.runtimeStatus?.label ?? (model.runtimeLoading ? "正在读取运行时" : "运行时状态未知"))
                    .font(.system(size:14,weight:.semibold))
                Spacer()
                Button("刷新") { Task { await model.loadRuntimePage() } }
                    .buttonStyle(.plain).disabled(model.runtimeLoading)
                    .accessibilityIdentifier("runtime.refresh")
                Button(model.runtimeLoading ? "诊断中…" : "诊断") { Task { await model.diagnoseRuntime() } }
                    .buttonStyle(.bordered).disabled(model.runtimeLoading)
                    .accessibilityIdentifier("runtime.diagnose")
            }
            Text(model.runtimeStatus?.detail ?? "等待独立 Recovery 返回主运行时状态。")
                .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            if let status = model.runtimeStatus {
                HStack(spacing:14) {
                    if let release = status.releaseId { runtimeMeta("Release",String(release.prefix(18))) }
                    if let pid = status.pid { runtimeMeta("PID","\(pid)") }
                    runtimeMeta("Reasons","\(status.reasonCount)")
                }
            }
        }
        .padding(16)
        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:15,style:.continuous))
    }

    private var connectionCard: some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(spacing:9) {
                Circle().fill(connectionColor).frame(width:8,height:8)
                Text(connectionTitle).font(.system(size:14,weight:.semibold))
                Spacer()
                Button("刷新连接") { Task { await model.loadRuntimePage() } }
                    .buttonStyle(.plain).disabled(model.connectionLoading)
                    .accessibilityIdentifier("connection.refresh")
                if model.connectionStatus?.repairAvailable == true {
                    Button(model.connectionStatus?.repairLabel ?? "刷新 Connector") {
                        Task { await model.repairControllerConnection() }
                    }
                    .buttonStyle(.bordered).disabled(model.connectionLoading)
                    .accessibilityIdentifier("connection.repair")
                }
            }
            if let status = model.connectionStatus {
                connectionRow("控制器",status.controller)
                connectionRow("传输",status.tunnel)
            } else {
                Text("连接状态来自 Forge setup authority；客户端不保存第二份连接配置。")
                    .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            }
        }
        .padding(16)
        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:15,style:.continuous))
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

    private var connectionTitle: String {
        guard let status = model.connectionStatus else { return model.connectionLoading ? "正在读取连接" : "MCP 连接状态未知" }
        if status.ready { return "MCP 连接已就绪" }
        if !status.controller.ready { return "控制器需要处理" }
        if !status.tunnel.ready { return "远程传输需要处理" }
        return status.configured ? "连接未就绪" : "连接尚未配置"
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
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                VStack(alignment:.leading,spacing:6) {
                    Text("记忆与知识").font(.system(size:21,weight:.medium))
                    Text("读取当前 Forge 项目/工作空间的 Cognitive 记录；结果只读、仅供参考，不更改 Requirement、Plan 或执行授权。")
                        .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                }
                HStack(spacing:9) {
                    TextField("搜索经验、概念、技术决策…",text:$model.knowledgeQuery)
                        .textFieldStyle(.plain)
                        .padding(.horizontal,12)
                        .frame(height:38)
                        .background(ForgePalette.softFill,
                                    in:RoundedRectangle(cornerRadius:12,style:.continuous))
                        .onSubmit { Task { await model.searchKnowledge() } }
                        .accessibilityLabel("知识库搜索")
                        .accessibilityIdentifier("knowledge.query")
                    Button { Task { await model.searchKnowledge() } } label: {
                        if model.knowledgeLoading { ProgressView().controlSize(.small) }
                        else { Label("检索",systemImage:"magnifyingglass") }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .disabled(model.knowledgeLoading || model.repoId == nil)
                    .accessibilityIdentifier("knowledge.search")
                }
                HStack {
                    Text(model.project.map { "项目：\($0.label)" } ?? "未选择项目")
                    Spacer()
                    if let result = model.knowledgeResult {
                        Text("已检索 \(result.inspected) 条 · 返回 \(result.items.count) 条")
                    } else {
                        Text("Forge Cognitive · 只读")
                    }
                }
                .font(.system(size:10.5)).foregroundStyle(.tertiary)

                if model.repoId == nil {
                    knowledgeEmpty("先选择已注册的 Forge 项目，以限定知识检索范围。")
                } else if let result = model.knowledgeResult, result.items.isEmpty {
                    knowledgeEmpty("当前没有匹配的记忆记录。")
                } else if let result = model.knowledgeResult {
                    LazyVStack(alignment:.leading,spacing:10) {
                        ForEach(result.items.map(\.memory)) { memory in
                            VStack(alignment:.leading,spacing:10) {
                                HStack(spacing:8) {
                                    Text(scopeLabel(memory.scope.kind))
                                        .font(.system(size:9.5,weight:.semibold))
                                        .padding(.horizontal,7).frame(height:21)
                                        .background(ForgePalette.selection,in:Capsule())
                                    Text(memory.provenance?.sourceKind ?? "Cognitive")
                                    Spacer()
                                    Text("r\(memory.revision)")
                                }
                                .font(.system(size:9.5)).foregroundStyle(ForgePalette.secondary)
                                Text(memory.canonicalText)
                                    .font(.system(size:12.5)).lineSpacing(4).textSelection(.enabled)
                                if !memory.concepts.isEmpty {
                                    HStack(spacing:6) {
                                        ForEach(Array(memory.concepts.prefix(6)),id:\.self) { concept in
                                            Text(concept).font(.system(size:9.5))
                                                .padding(.horizontal,7).frame(height:22)
                                                .background(ForgePalette.softFill,in:Capsule())
                                        }
                                    }
                                }
                                Text("\(memory.scope.kind) / \(memory.scope.id) · \(memory.id)")
                                    .font(.system(size:9,design:.monospaced)).foregroundStyle(.tertiary)
                                    .textSelection(.enabled)
                            }
                            .padding(14)
                            .frame(maxWidth:.infinity,alignment:.leading)
                            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:14,style:.continuous))
                        }
                    }
                    if result.truncated {
                        Label("结果已达到单次上限，可输入关键词缩小范围。",systemImage:"info.circle")
                            .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    }
                    if !result.gaps.isEmpty {
                        Label("部分范围不可达：\(result.gaps.joined(separator:"、"))",systemImage:"exclamationmark.triangle")
                            .font(.system(size:10.5)).foregroundStyle(.orange)
                    }
                }
            }
            .frame(maxWidth:850,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.leading)
            .padding(28)
        }
    }

    private func knowledgeEmpty(_ message:String) -> some View {
        Text(message).font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            .padding(18).frame(maxWidth:.infinity,alignment:.leading)
            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:14,style:.continuous))
    }

    private func scopeLabel(_ kind:String) -> String {
        switch kind { case "project": return "项目"; case "workspace": return "工作空间"; default: return kind }
    }
}

private struct SettingsPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var defaultProvider = "codex"
    @State private var apiProtocol = "openai"
    @State private var endpoint = "https://api.openai.com/v1"
    @State private var apiModel = ""
    @State private var apiKey = ""
    @State private var saving = false

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:6) {
                        Text("Agent 设置").font(.system(size:22,weight:.medium))
                        Text("Provider 按会话固定：Codex 继续使用 Forge controller.local_conversation；兼容 API 复用同一 Rust Agent 核心、取消与工具事件协议。已有历史不会因默认配置改变而切换 Provider。")
                            .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
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

                VStack(alignment:.leading,spacing:13) {
                    HStack(spacing:9) {
                        Circle().fill(model.selectedProvider == "api"
                                           ? (model.apiProfileReady ? Color.green : Color.red)
                                           : (model.provider.contains("已连接") ? Color.green : Color.orange))
                            .frame(width:8,height:8)
                        Text("当前会话 · \(model.selectedProvider == "api" ? "兼容 API" : "Codex CLI")")
                            .font(.system(size:14,weight:.semibold))
                        Spacer()
                        Text("当前执行 Provider")
                            .font(.system(size:9.5,weight:.semibold))
                            .padding(.horizontal,8).frame(height:22)
                            .background(ForgePalette.selection,in:Capsule())
                    }
                    Text(model.selectedProvider == "api"
                         ? (model.apiProfileReady ? "使用保存的兼容 API profile；写操作仍需每轮显式授权。" : "API profile 尚未完成。")
                         : model.provider)
                        .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                    HStack(spacing:16) {
                        settingMeta("会话模型",model.selectedProvider == "api"
                                    ? (model.localApiSettings?.model ?? "未配置")
                                    : (model.selectedAgentModel?.displayName ?? "Codex 默认"))
                        settingMeta("Reasoning",model.selectedProvider == "api"
                                    ? "API profile"
                                    : (model.selectedReasoningEffort.isEmpty ? "默认" : model.selectedReasoningEffort))
                        settingMeta("图片输入",model.selectedProviderSupportsImages ? "可用" : "不可用")
                    }
                    Text("Provider 与模型上下文按会话保存；已有历史不会被默认设置静默改写。")
                        .font(.system(size:10.5)).foregroundStyle(.tertiary)
                }
                .padding(16)
                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:15,style:.continuous))

                VStack(alignment:.leading,spacing:13) {
                    HStack {
                        Text("保存的兼容 API profile").font(.system(size:13,weight:.semibold))
                        Spacer()
                        Text(model.apiProfileReady ? "可用于新会话" : "配置未完成")
                            .font(.system(size:9.5,weight:.semibold))
                            .foregroundStyle(model.apiProfileReady ? Color.green : Color.orange)
                    }
                    if let settings = model.localApiSettings {
                        HStack(spacing:16) {
                            settingMeta("新会话默认",settings.provider == "api" ? "兼容 API" : "Codex CLI")
                            settingMeta("协议",settings.apiProtocol)
                            settingMeta("Keychain",settings.hasKey ? "已存密钥" : "无密钥")
                        }
                    } else {
                        Text(model.settingsLoading ? "正在读取本地配置…" : "尚未读取本地 API 配置。")
                            .font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
                    }

                    VStack(alignment:.leading,spacing:11) {
                        HStack(spacing:12) {
                            Text("新会话默认").font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                            Picker("新会话默认",selection:$defaultProvider) {
                                Text("Codex CLI").tag("codex")
                                Text("兼容 API").tag("api")
                            }
                            .labelsHidden().pickerStyle(.segmented).frame(maxWidth:260)
                            .accessibilityIdentifier("settings.default-provider")
                        }
                        HStack(spacing:12) {
                            Text("API 协议").font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                            Picker("API 协议",selection:$apiProtocol) {
                                Text("OpenAI-compatible").tag("openai")
                                Text("Anthropic").tag("anthropic")
                            }
                            .labelsHidden().pickerStyle(.menu).frame(maxWidth:260,alignment:.leading)
                            .accessibilityIdentifier("settings.api-protocol")
                        }
                        settingsField("Endpoint") {
                            TextField("https://api.example.com/v1",text:$endpoint)
                                .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                                .accessibilityIdentifier("settings.endpoint")
                        }
                        settingsField("模型 ID") {
                            TextField("例如 gpt-5.6 / claude-sonnet",text:$apiModel)
                                .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                                .accessibilityIdentifier("settings.model")
                        }
                        settingsField("API Key") {
                            SecureField(model.localApiSettings?.hasKey == true ? "已存 Key；留空保持" : "本机服务可留空",text:$apiKey)
                                .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                                .accessibilityIdentifier("settings.api-key")
                        }
                        HStack(spacing:10) {
                            if model.localApiSettings?.hasKey == true {
                                Button("删除已存 Key",role:.destructive) {
                                    clearApiKey()
                                }
                                .buttonStyle(.plain).foregroundStyle(.red)
                                .disabled(saving || model.settingsLoading)
                                .accessibilityIdentifier("settings.clear-key")
                            }
                            Spacer()
                            Button(saving ? "保存中…" : "保存配置") {
                                saveApiSettings()
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(saving || model.settingsLoading
                                      || endpoint.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                      || (defaultProvider == "api" && apiModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
                            .accessibilityIdentifier("settings.save")
                        }
                    }
                    .padding(13)
                    .background(ForgePalette.canvas,in:RoundedRectangle(cornerRadius:12,style:.continuous))

                    Text("API Key 只写入 macOS Keychain；JSON 配置只保存 Provider、Endpoint、模型与协议。新会话读取默认 Provider，已有会话继续使用自己的 Provider。写操作授权仍只对下一次 API 发送有效。")
                        .font(.system(size:10.5)).foregroundStyle(.tertiary).lineSpacing(3)
                }
                .padding(16)
                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:15,style:.continuous))
            }
            .frame(maxWidth:850,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.leading)
            .padding(30)
        }
        .task(id:settingsSignature) {
            syncSettingsDraft()
        }
    }

    private var settingsSignature: String {
        guard let settings = model.localApiSettings else { return "none" }
        return [settings.provider,settings.endpoint,settings.model,settings.apiProtocol,settings.hasKey ? "1" : "0"].joined(separator:"|")
    }

    private func syncSettingsDraft() {
        guard let settings = model.localApiSettings else { return }
        defaultProvider = settings.provider
        endpoint = settings.endpoint
        apiModel = settings.model
        apiProtocol = settings.apiProtocol
        apiKey = ""
    }

    private func saveApiSettings() {
        guard !saving else { return }
        saving = true
        Task {
            let saved = await model.saveLocalApiSettings(
                provider:defaultProvider,
                endpoint:endpoint,
                model:apiModel,
                apiProtocol:apiProtocol,
                apiKey:apiKey
            )
            if saved { apiKey = "" }
            saving = false
        }
    }

    private func clearApiKey() {
        guard !saving else { return }
        saving = true
        Task {
            _ = await model.clearLocalApiKey()
            apiKey = ""
            saving = false
        }
    }

    @ViewBuilder
    private func settingsField<Content:View>(_ label:String,@ViewBuilder content:() -> Content) -> some View {
        HStack(spacing:12) {
            Text(label).font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
            content()
                .padding(.horizontal,10).frame(height:32)
                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
        }
    }

    private func settingMeta(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:3) {
            Text(label).font(.system(size:9.5,weight:.medium)).foregroundStyle(.tertiary)
            Text(value).font(.system(size:11.5,weight:.medium)).textSelection(.enabled)
        }
    }

    private func settingLine(_ label:String,_ value:String) -> some View {
        HStack(alignment:.firstTextBaseline,spacing:10) {
            Text(label).font(.system(size:10,weight:.medium)).foregroundStyle(ForgePalette.secondary)
                .frame(width:62,alignment:.leading)
            Text(value).font(.system(size:10.5,design:.monospaced)).textSelection(.enabled)
        }
    }
}
