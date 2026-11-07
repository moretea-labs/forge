import SwiftUI
import AppKit

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
                Button("新会话") { workspace.newThread() }.keyboardShortcut("n")
            }
            CommandMenu("导航") {
                Button("搜索会话") {
                    workspace.show(.agent)
                    workspace.showSearch.toggle()
                }.keyboardShortcut("k")
                Divider()
                Button("显示会话") { workspace.show(.agent) }.keyboardShortcut("1")
                Button("显示 Work") { workspace.show(.work) }.keyboardShortcut("2")
                Button("显示 Requirement") { workspace.show(.requirement) }.keyboardShortcut("3")
                Button("显示 Plan") { workspace.show(.plan) }.keyboardShortcut("4")
                Button("显示知识库") { workspace.show(.knowledge) }.keyboardShortcut("5")
                Divider()
                Button("刷新项目") { Task { await workspace.refresh() } }.keyboardShortcut("r")
            }
        }
    }
}

private struct ForgeWorkspaceView: View {
    @ObservedObject var model: NativeWorkspace
    @State private var visibility: NavigationSplitViewVisibility = .all

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

            Button(action:model.newThread) {
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
            .buttonStyle(.plain).padding(.horizontal,10).padding(.bottom,6)

            Button {
                model.show(.agent)
                model.showSearch.toggle()
            } label: {
                HStack(spacing:10) {
                    Image(systemName:"magnifyingglass")
                        .symbolRenderingMode(.hierarchical)
                        .frame(width:17)
                    Text("搜索会话")
                    Spacer()
                    Text("⌘K").font(.system(size:10)).foregroundStyle(.tertiary)
                }.font(.system(size:12)).padding(.horizontal,12).frame(height:35)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(ForgePalette.secondary)
                .padding(.horizontal,10)

            if model.showSearch {
                TextField("搜索标题或消息",text:$model.search)
                    .textFieldStyle(.plain)
                    .font(.system(size:12))
                    .padding(.horizontal,11)
                    .frame(height:34)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:11,style:.continuous))
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
                    ForEach(model.visibleThreads) { thread in
                        Button { model.selectThread(thread.id) } label: {
                            HStack(spacing:8) {
                                let selected = model.selectedThreadId == thread.id && model.page == .agent
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
                            .padding(.horizontal,10).frame(height:34)
                            .background(model.selectedThreadId == thread.id && model.page == .agent
                                ? ForgePalette.selectionStrong : .clear,
                                in:RoundedRectangle(cornerRadius:10,style:.continuous))
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .contextMenu {
                                Button("删除会话",role:.destructive) { model.deleteThread(thread.id) }
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
        }.buttonStyle(.plain).padding(.horizontal,10)
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
                    Label(thread.checkoutId == nil ? "未绑定" : "Checkout", systemImage:"point.3.connected.trianglepath.dotted")
                        .font(.system(size:10))
                        .foregroundStyle(ForgePalette.secondary)
                }
                Button { Task { await model.refresh() } } label: {
                    Image(systemName:"arrow.clockwise")
                        .font(.system(size:11.5,weight:.medium))
                        .frame(width:27,height:27)
                        .background(ForgePalette.softFill,in:Circle())
                }.buttonStyle(.plain).help("刷新真实 Forge 状态")
            }
            .padding(.horizontal,22).frame(height:48)
            .background(.ultraThinMaterial)
            .shadow(color:Color.black.opacity(0.025),radius:5,y:2)
            .zIndex(1)
            switch model.page {
            case .agent: AgentPane(model:model)
            case .work,.requirement,.plan: RecordsPane(model:model)
            case .knowledge: KnowledgePane(model:model)
            case .runtime: TextDetailPane(title:"Runtime / Recovery",subtitle:"仅显示真实健康信息；不会修改被冻结的 Runtime。",
                                           text:model.detail,refresh:{ Task { await model.loadPage() } })
            case .settings: TextDetailPane(title:"设置",subtitle:"Provider 凭据仍归现有 Rust Keychain 权限层管理。",
                                            text:model.settings,refresh:{ Task { await model.loadPage() } })
            }
        }
        .background(ForgePalette.canvas)
    }
}

private struct AgentPane: View {
    @ObservedObject var model: NativeWorkspace

    var body: some View {
        VStack(spacing:0) {
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:20) {
                        if model.thread?.messages.isEmpty != false {
                            VStack(spacing:13) {
                                Image(systemName:"bolt.circle")
                                    .symbolRenderingMode(.hierarchical)
                                    .font(.system(size:30,weight:.light))
                                    .foregroundStyle(ForgePalette.accent)
                                    .accessibilityHidden(true)
                                Text("开始一个 Agent 任务")
                                    .font(.system(size:24,weight:.medium)).tracking(-0.45)
                                Text("直接描述要完成的结果。Forge 会继续使用当前项目、checkout 与既有 Work 事实。")
                                    .font(.system(size:12))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .multilineTextAlignment(.center)
                                    .lineSpacing(4)
                                    .frame(maxWidth:440)
                            }
                            .padding(.top,88)
                            .frame(maxWidth:.infinity)
                        }
                        ForEach(model.thread?.messages ?? []) { message in
                            if message.role == "user" {
                                HStack(alignment:.top) {
                                    Spacer(minLength:96)
                                    Text(message.text)
                                        .font(.system(size:13))
                                        .lineSpacing(5)
                                        .textSelection(.enabled)
                                        .padding(.horizontal,14).padding(.vertical,11)
                                        .background(ForgePalette.userBubble,
                                                    in:RoundedRectangle(cornerRadius:14,style:.continuous))
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
                                    Text(message.text)
                                        .font(.system(size:13))
                                        .lineSpacing(6)
                                        .textSelection(.enabled)
                                    Spacer(minLength:56)
                                }
                                .frame(maxWidth:.infinity,alignment:.leading)
                                .id(message.id)
                            }
                        }
                        if model.busy {
                            Label("Agent 正在处理请求…",systemImage:"ellipsis")
                                .font(.system(size:12))
                                .foregroundStyle(ForgePalette.secondary)
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
                TextEditor(text:$model.draft)
                    .font(.system(size:13))
                    .foregroundStyle(ForgePalette.ink)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight:56,maxHeight:105)
                    .padding(.horizontal,12).padding(.top,10)
                    .accessibilityLabel("Agent 消息")
                HStack(spacing:7) {
                    Label(model.project?.label ?? "未选择项目",systemImage:"folder.fill")
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1)

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
                            Image(systemName:"cpu")
                                .font(.system(size:9.5,weight:.medium))
                            Text(model.selectedAgentModel?.displayName ?? "选择模型")
                                .lineLimit(1)
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
                    .disabled(model.agentModels.isEmpty || model.busy)
                    .help(model.selectedAgentModel?.description ?? "从 Codex 当前模型目录选择")

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
                            Text(reasoningLabel(model.selectedReasoningEffort))
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
                    .disabled(model.selectedReasoningOptions.isEmpty || model.busy)
                    .help("当前模型的推理强度")

                    Circle()
                        .fill(model.provider.contains("已连接") ? Color.green : Color.orange)
                        .frame(width:6,height:6)
                        .help(model.provider)
                    Spacer()
                    Text("⌘↵").font(.system(size:10)).foregroundStyle(.tertiary)
                    if model.busy {
                        Button { Task { await model.cancel() } } label: {
                            Image(systemName:"stop.fill")
                                .font(.system(size:9,weight:.semibold))
                                .frame(width:29,height:29)
                                .background(ForgePalette.softFill,in:Circle())
                        }.buttonStyle(.plain).help("请求停止 Agent")
                    } else {
                        let sendDisabled = model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
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
                        .help("发送消息")
                    }
                }.padding(.horizontal,13).padding(.bottom,11)
            }
            .background(ForgePalette.composer,
                        in:RoundedRectangle(cornerRadius:19,style:.continuous))
            .background(.ultraThinMaterial,
                        in:RoundedRectangle(cornerRadius:19,style:.continuous))
            .shadow(color:Color.black.opacity(0.060),radius:18,y:7)
            .frame(maxWidth:760)
            .padding(.horizontal,30).padding(.bottom,20)
            .frame(maxWidth:.infinity)
        }
        .background(ForgePalette.canvas)
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
                        }.buttonStyle(.plain)
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
                    if !model.detail.isEmpty {
                        Text(model.detail)
                            .font(.system(size:11,design:.monospaced))
                            .textSelection(.enabled)
                            .padding(16)
                            .frame(maxWidth:.infinity,alignment:.leading)
                            .background(ForgePalette.softFill,
                                        in:RoundedRectangle(cornerRadius:15,style:.continuous))
                    }
                }
                .frame(maxWidth:790,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(.horizontal,22).padding(.vertical,24)
            }
        }.background(ForgePalette.canvas)
    }
}

private struct KnowledgePane: View {
    @ObservedObject var model: NativeWorkspace
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Text("知识库搜索").font(.system(size:21,weight:.medium))
            Text("基于所选 Forge 项目的现有知识能力，不维护第二份搜索索引。")
                .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            HStack(spacing:9) {
                TextField("输入搜索内容",text:$model.knowledgeQuery)
                    .textFieldStyle(.plain)
                    .padding(.horizontal,12)
                    .frame(height:38)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:12,style:.continuous))
                    .onSubmit { Task { await model.searchKnowledge() } }
                Button { Task { await model.searchKnowledge() } } label: {
                    Label("搜索",systemImage:"magnifyingglass")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .disabled(model.knowledgeQuery.isEmpty)
            }
            ScrollView {
                Text(model.detail).font(.system(size:12,design:.monospaced))
                    .textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)
            }
            Spacer()
        }.padding(28).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
    }
}

private struct TextDetailPane: View {
    let title:String
    let subtitle:String
    let text:String
    let refresh: () -> Void
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack {
                    VStack(alignment:.leading,spacing:7) {
                        Text(title).font(.system(size:22,weight:.medium))
                        Text(subtitle).font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    Button(action:refresh) {
                        Label("刷新",systemImage:"arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
                Group {
                    if text.isEmpty {
                        Text("暂无数据。请刷新以读取真实 Forge 状态。")
                            .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                    } else {
                        Text(text)
                            .font(.system(size:12,design:.monospaced))
                            .textSelection(.enabled)
                    }
                }
                .padding(17)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(ForgePalette.softFill,
                            in:RoundedRectangle(cornerRadius:15,style:.continuous))
            }.frame(maxWidth:850,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(30)
        }
    }
}
