import SwiftUI
import AppKit

private enum ForgePalette {
    static let canvas = Color(nsColor:.textBackgroundColor)
    static let ink = Color(red:0.16,green:0.18,blue:0.17)
    static let secondary = Color(red:0.45,green:0.47,blue:0.46)
    static let accent = Color(red:0.25,green:0.31,blue:0.26)
    static let selection = Color(red:0.89,green:0.91,blue:0.87).opacity(0.84)
    static let userBubble = Color(red:0.945,green:0.949,blue:0.938)
    static let composer = Color.white.opacity(0.78)
    static let line = Color.primary.opacity(0.075)
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
                    Image(systemName:"square.and.pencil").frame(width:17)
                    Text("新会话")
                    Spacer()
                    Text("⌘N").font(.system(size:10)).foregroundStyle(.tertiary)
                }
                .font(.system(size:12,weight:.medium)).padding(.horizontal,11)
                .frame(height:38)
                .background(.white,in:RoundedRectangle(cornerRadius:10))
                .overlay(RoundedRectangle(cornerRadius:10).stroke(ForgePalette.line))
            }
            .buttonStyle(.plain).padding(.horizontal,11).padding(.bottom,6)

            Button {
                model.show(.agent)
                model.showSearch.toggle()
            } label: {
                HStack(spacing:10) {
                    Image(systemName:"magnifyingglass").frame(width:17)
                    Text("搜索会话")
                    Spacer()
                    Text("⌘K").font(.system(size:10)).foregroundStyle(.tertiary)
                }.font(.system(size:12)).padding(.horizontal,12).frame(height:35)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(ForgePalette.secondary)
                .padding(.horizontal,10)

            if model.showSearch {
                TextField("搜索标题或消息",text:$model.search)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size:12))
                    .padding(.horizontal,13).padding(.vertical,7)
            }

            sectionLabel("工作空间").padding(.top,19)
            ForEach(NativePage.allCases.filter { $0 != .settings }) { section in
                navigationRow(section)
            }

            Rectangle().fill(ForgePalette.line).frame(height:1)
                .padding(.horizontal,13).padding(.top,17).padding(.bottom,7)
            sectionLabel("最近会话").padding(.bottom,4)
            ScrollView {
                LazyVStack(alignment:.leading,spacing:2) {
                    ForEach(model.visibleThreads) { thread in
                        Button { model.selectThread(thread.id) } label: {
                            HStack(spacing:8) {
                                Image(systemName:"text.bubble")
                                    .font(.system(size:11))
                                    .frame(width:17)
                                Text(thread.title)
                                    .font(.system(size:12))
                                    .lineLimit(1)
                                Spacer(minLength:0)
                            }
                            .frame(maxWidth:.infinity,alignment:.leading)
                            .padding(.horizontal,10).frame(height:34)
                            .background(model.selectedThreadId == thread.id && model.page == .agent
                                ? ForgePalette.selection : .clear,in:RoundedRectangle(cornerRadius:9))
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .contextMenu {
                                Button("删除会话",role:.destructive) { model.deleteThread(thread.id) }
                            }
                    }
                }.padding(.horizontal,10)
            }.scrollIndicators(.hidden)
            Spacer(minLength:5)

            Rectangle().fill(ForgePalette.line).frame(height:1).padding(.horizontal,13)
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
                    Image(systemName:"folder").font(.system(size:14)).frame(width:20)
                    VStack(alignment:.leading,spacing:2) {
                        Text(model.project?.label ?? "选择项目").font(.system(size:12,weight:.semibold))
                            .lineLimit(1)
                        Text(model.project?.defaultBranch ?? "Forge Registry")
                            .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    Image(systemName:"chevron.up.chevron.down").font(.system(size:10))
                }
                .padding(.horizontal,12).frame(height:52)
                .contentShape(Rectangle())
            }.menuStyle(.borderlessButton).padding(.horizontal,8).padding(.top,4)
            navigationRow(.settings).padding(.bottom,11)
        }
        .foregroundStyle(ForgePalette.ink)
        .background(.ultraThinMaterial)
    }

    private func sectionLabel(_ name: String) -> some View {
        Text(name.uppercased())
            .font(.system(size:10,weight:.semibold))
            .tracking(0.6)
            .foregroundStyle(ForgePalette.secondary)
            .padding(.horizontal,21).padding(.bottom,7)
    }

    private func navigationRow(_ section: NativePage) -> some View {
        Button { model.show(section) } label: {
            HStack(spacing:10) {
                Image(systemName:section.symbol).font(.system(size:13)).frame(width:18)
                Text(section.rawValue).font(.system(size:12,weight:model.page == section ? .semibold : .regular))
                Spacer()
            }
            .padding(.horizontal,12)
            .frame(height:35)
            .background(model.page == section ? ForgePalette.selection : .clear,
                        in:RoundedRectangle(cornerRadius:9))
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
                .padding(10)
                .frame(maxWidth:.infinity)
                .background(Color(red:0.99,green:0.95,blue:0.93))
            }
            HStack(spacing:9) {
                Image(systemName:model.page.symbol)
                    .font(.system(size:12,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                Text(model.page.rawValue)
                    .font(.system(size:13,weight:.semibold))
                Spacer()
                if model.page == .agent, let thread = model.thread {
                    Label(thread.checkoutId == nil ? "未绑定" : "Checkout", systemImage:"point.3.connected.trianglepath.dotted")
                        .font(.system(size:10))
                        .foregroundStyle(ForgePalette.secondary)
                }
                Button { Task { await model.refresh() } } label: {
                    Image(systemName:"arrow.clockwise").font(.system(size:12))
                }.buttonStyle(.borderless).help("刷新真实 Forge 状态")
            }
            .padding(.horizontal,25).frame(height:44)
            Divider().overlay(ForgePalette.line)
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
    @FocusState private var composerFocused: Bool

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
                    .focused($composerFocused)
                    .frame(minHeight:56,maxHeight:105)
                    .padding(.horizontal,12).padding(.top,10)
                    .accessibilityLabel("Agent 消息")
                HStack(spacing:9) {
                    Label(model.project?.label ?? "未选择项目",systemImage:"folder")
                        .font(.system(size:10.5))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1)
                    Text(model.provider).font(.system(size:10)).foregroundStyle(.tertiary)
                    Spacer()
                    Text("⌘↵").font(.system(size:10)).foregroundStyle(.tertiary)
                    if model.busy {
                        Button { Task { await model.cancel() } } label: {
                            Image(systemName:"stop.fill").font(.system(size:10))
                                .frame(width:28,height:27)
                        }.buttonStyle(.bordered).help("请求停止 Agent")
                    } else {
                        Button { Task { await model.send() } } label: {
                            Image(systemName:"arrow.up").font(.system(size:12,weight:.semibold))
                                .frame(width:28,height:27)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.return,modifiers:.command)
                        .help("发送消息")
                    }
                }.padding(.horizontal,13).padding(.bottom,11)
            }
            .background(ForgePalette.composer,
                        in:RoundedRectangle(cornerRadius:16,style:.continuous))
            .background(.ultraThinMaterial,
                        in:RoundedRectangle(cornerRadius:16,style:.continuous))
            .overlay(RoundedRectangle(cornerRadius:16,style:.continuous).stroke(ForgePalette.line))
            .shadow(color:Color.black.opacity(0.055),radius:16,y:6)
            .frame(maxWidth:760)
            .padding(.horizontal,30).padding(.bottom,20)
            .frame(maxWidth:.infinity)
        }
        .background(ForgePalette.canvas)
    }
}

private struct RecordsPane: View {
    @ObservedObject var model: NativeWorkspace

    var body: some View {
        HStack(spacing:0) {
            ScrollView {
                LazyVStack(alignment:.leading,spacing:5) {
                    Text("\(model.records.count) 项")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                        .padding(.bottom,13)
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
                            .padding(12)
                            .frame(maxWidth:.infinity,alignment:.leading)
                            .background(item.id == model.selectedRecord ?
                                ForgePalette.selection : .clear,
                                in:RoundedRectangle(cornerRadius:10))
                        }.buttonStyle(.plain)
                    }
                }.padding(14)
            }
            .frame(width:305)
            .background(.ultraThinMaterial)
            Divider()
            ScrollView {
                VStack(alignment:.leading,spacing:17) {
                    if let selected = model.records.first(where:{$0.id == model.selectedRecord}) {
                        Text(selected.title).font(.system(size:20,weight:.medium))
                        Text(selected.id).font(.system(size:11,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                    } else {
                        Image(systemName:"doc.text.magnifyingglass")
                            .font(.system(size:24)).foregroundStyle(ForgePalette.secondary)
                        Text("选择左侧记录以查看详情")
                            .font(.system(size:14)).foregroundStyle(ForgePalette.secondary)
                    }
                    if !model.detail.isEmpty {
                        Divider()
                        Text(model.detail)
                            .font(.system(size:11,design:.monospaced))
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth:780,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(26)
            }
        }.background(.white)
    }
}

private struct KnowledgePane: View {
    @ObservedObject var model: NativeWorkspace
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Text("知识库搜索").font(.system(size:21,weight:.medium))
            Text("基于所选 Forge 项目的现有知识能力，不维护第二份搜索索引。")
                .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            HStack {
                TextField("输入搜索内容",text:$model.knowledgeQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await model.searchKnowledge() } }
                Button("搜索") { Task { await model.searchKnowledge() } }
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
                    Button("刷新",action:refresh)
                }
                Divider()
                if text.isEmpty {
                    Text("暂无数据。请刷新以读取真实 Forge 状态。")
                        .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                } else {
                    Text(text)
                        .font(.system(size:12,design:.monospaced))
                        .textSelection(.enabled)
                }
            }.frame(maxWidth:850,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(30)
        }
    }
}
