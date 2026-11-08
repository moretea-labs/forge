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
    @State private var visibility: NavigationSplitViewVisibility = .all
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
                    Circle().fill(model.connection == "MCP 已连接" ? Color.green : Color.orange)
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

            HStack(spacing:7) {
                if model.showSearch {
                    HStack(spacing:8) {
                        Image(systemName:"magnifyingglass")
                            .foregroundStyle(ForgePalette.secondary)
                        TextField("搜索会话标题或消息",text:$model.search)
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
                            }
                            .help("清除搜索")
                            .accessibilityLabel("清除搜索")
                            .buttonStyle(.plain)
                        }
                        Button { model.toggleConversationSearch() } label: {
                            Image(systemName:"xmark")
                                .frame(width:22,height:24)
                        }
                        .help("关闭搜索")
                        .accessibilityLabel("关闭搜索")
                        .accessibilityIdentifier("sidebar.search.close")
                        .buttonStyle(.plain)
                    }
                    .font(.system(size:11))
                    .padding(.horizontal,11)
                    .frame(height:40)
                    .frame(maxWidth:.infinity)
                    .background(ForgePalette.raisedSurface,
                                in:RoundedRectangle(cornerRadius:11,style:.continuous))
                } else {
                    Button {
                        model.show(.agent)
                        model.newThread()
                    } label: {
                        HStack(spacing:9) {
                            Image(systemName:"plus")
                                .font(.system(size:11,weight:.semibold))
                                .frame(width:19,height:19)
                            VStack(alignment:.leading,spacing:2) {
                                Text("新会话").font(.system(size:12,weight:.semibold))
                                Text(model.project?.label ?? "未绑定项目")
                                    .font(.system(size:9))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength:0)
                            Text("⌘N").font(.system(size:10)).foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal,11)
                        .frame(height:40)
                        .frame(maxWidth:.infinity)
                        .background(ForgePalette.raisedSurface,
                                    in:RoundedRectangle(cornerRadius:11,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(model.busy)
                    .help(model.repoId == nil ? "创建不绑定项目的会话" : "在当前项目新建会话")
                    .accessibilityIdentifier("sidebar.thread.new")

                    Button { model.toggleConversationSearch() } label: {
                        Image(systemName:"magnifyingglass")
                            .font(.system(size:13,weight:.medium))
                            .frame(width:38,height:40)
                            .background(ForgePalette.softFill,
                                        in:RoundedRectangle(cornerRadius:11,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("搜索会话")
                    .help("搜索全部项目的会话 (⌘K)")
                    .accessibilityIdentifier("sidebar.search.open")
                }
            }
            .padding(.horizontal,10).padding(.bottom,7)

            sectionLabel("工作空间").padding(.top,19)
            ForEach(NativePage.allCases.filter { $0 != .settings && $0 != .plan }) { section in
                navigationRow(section)
            }

            sectionLabel(isGlobalThreadSearch ? "搜索结果 · \(model.visibleThreads.count)" : "会话")
                .padding(.top,21)
                .padding(.bottom,4)
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
            }.scrollIndicators(.hidden)
            Spacer(minLength:5)

            projectSwitcher
                .padding(.horizontal,10).padding(.top,5)
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
        let projectLabel = model.projects.first(where: { $0.repoId == thread.repoId })?.label
            ?? thread.repoId.map { String($0.prefix(16)) }
            ?? "未绑定项目"

        return HStack(spacing:4) {
            Button {
                model.selectThread(thread.id)
                if model.showSearch { model.toggleConversationSearch() }
            } label: {
                HStack(spacing:8) {
                    Image(systemName:selected ? "bubble.left.fill" : "bubble.left")
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:11))
                        .frame(width:17)
                    VStack(alignment:.leading,spacing:2) {
                        Text(thread.title)
                            .font(.system(size:12,weight:selected ? .medium : .regular))
                            .lineLimit(1)
                        HStack(spacing:5) {
                            Text(projectLabel).lineLimit(1)
                            if let planId = thread.planId, !planId.isEmpty {
                                Text("· Plan \(String(planId.prefix(12)))").lineLimit(1)
                            } else if let requirementId = thread.requirementId, !requirementId.isEmpty {
                                Text("· Req \(String(requirementId.prefix(12)))").lineLimit(1)
                            }
                        }
                        .font(.system(size:9.5))
                        .foregroundStyle(ForgePalette.secondary.opacity(0.82))
                    }
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
        .frame(height:44)
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
            .padding(.horizontal,11).frame(height:50)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:13,style:.continuous))
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

    private func chooseProjectDirectory() {
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
            let ok = await model.registerProject(path:url.path)
            registeringProject = false
            if ok {
                projectPickerShown = false
                projectSearch = ""
            }
        }
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
                    Text(error)
                        .lineLimit(4)
                        .fixedSize(horizontal:false,vertical:true)
                        .textSelection(.enabled)
                    Spacer()
                    Button("关闭") { model.error = nil }.buttonStyle(.plain)
                }
                .font(.system(size:11))
                .foregroundStyle(Color(red:0.58,green:0.26,blue:0.24))
                .padding(.horizontal,12).padding(.vertical,9)
                .frame(minHeight:38)
                .background(Color(red:0.99,green:0.95,blue:0.93),
                            in:RoundedRectangle(cornerRadius:11,style:.continuous))
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
                                    Text(agentEmptyStateDescription)
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
                                .frame(maxWidth:620,alignment:.trailing)
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
                                        if message.incomplete == true,
                                           message.id == model.thread?.messages.last?.id {
                                            Button {
                                                model.draft = "继续执行上一次未完成的开发任务。先核对当前 checkout 的 Git 状态和最近工具回执，确认哪些操作已经完成；不要重放未知写操作。继续实施并执行必要验证。"
                                                Task { await model.send() }
                                            } label: {
                                                Label("继续执行",systemImage:"play.fill")
                                                    .font(.system(size:11,weight:.semibold))
                                            }
                                            .buttonStyle(.bordered)
                                            .disabled(model.busy || !model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                                || (model.thread?.repoId != nil && !model.checkoutIsAvailable))
                                            .accessibilityIdentifier("agent.continue-incomplete")
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
                .onChange(of:model.busy) { busy in
                    guard busy else { return }
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(.easeOut(duration:0.2)) { reader.scrollTo("pending",anchor:.bottom) }
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

                    compactAgentConfigurationControl

                    Spacer(minLength:12)

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
                            || !model.selectedProviderReady
                            || (model.thread?.repoId != nil && model.thread?.checkoutId == nil)
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
        .safeAreaInset(edge:.trailing,spacing:0) {
            if showChanges {
                HStack(spacing:0) {
                    Divider()
                    AgentChangesPane(model:model,isPresented:$showChanges)
                        .frame(width:340)
                }
                .transition(.move(edge:.trailing).combined(with:.opacity))
            }
        }
        .animation(.easeOut(duration:0.18),value:showChanges)
        .onAppear {
            if !model.busy { composerFocused = true }
        }
        .onChange(of:model.selectedThreadId) { _ in
            showChanges = false
            if !model.busy { composerFocused = true }
        }
    }

    private var agentEmptyStateDescription: String {
        if model.checkoutId == nil {
            return "先选择带有 active checkout 的项目，再让 Forge 审查改动、定位问题或实施 Requirement / Plan。"
        }
        return "当前项目与 checkout 是执行上下文；Requirement / Plan 保持为可浏览的唯一语义事实。"
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
                if let planId = model.thread?.planId, !planId.isEmpty {
                    Button { Task { await model.openPlan(planId) } } label: {
                        Text("Plan · \(String(planId.prefix(12)))")
                            .font(.system(size:9.5,weight:.medium,design:.monospaced))
                            .lineLimit(1)
                            .padding(.horizontal,7).frame(height:21)
                            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .help("打开此会话附着的可选 Plan 上下文")
                } else if let requirementId = model.thread?.requirementId, !requirementId.isEmpty {
                    Button { Task { await model.openRequirement(requirementId) } } label: {
                        Text("Req · \(String(requirementId.prefix(12)))")
                            .font(.system(size:9.5,weight:.medium,design:.monospaced))
                            .lineLimit(1)
                            .padding(.horizontal,7).frame(height:21)
                            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .help("打开此会话附着的可选 Requirement 上下文")
                }
            }
            .help(model.checkoutId.map { "checkout: \($0)" } ?? "当前项目没有 checkout")

            Spacer(minLength:12)

            ViewThatFits(in:.horizontal) {
                HStack(spacing:3) {
                    semanticContextButton("规划",page:.requirement,systemImage:"point.3.connected.trianglepath.dotted")
                    semanticContextButton("Knowledge",page:.knowledge,systemImage:"books.vertical")
                }
                HStack(spacing:3) {
                    semanticContextButton("规划",page:.requirement,systemImage:"point.3.connected.trianglepath.dotted",compact:true)
                    semanticContextButton("Knowledge",page:.knowledge,systemImage:"books.vertical",compact:true)
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
            withAnimation(.easeOut(duration:0.18)) { showChanges.toggle() }
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
        .accessibilityLabel(title)
        .accessibilityIdentifier("agent.semantic-context.\(page.rawValue)")
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
                        .lineLimit(2)
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
        switch event.status {
        case "completed": return Color.green
        case "failed": return Color.red
        case "unknown": return Color.orange
        default: return ForgePalette.secondary
        }
    }

    private func activityStatusIcon(_ event: AgentLiveActivityEvent) -> String {
        switch event.status {
        case "completed": return "checkmark"
        case "failed": return "exclamationmark"
        case "unknown": return "questionmark.circle"
        default: return activityIcon(event.phase)
        }
    }

    private var compactAgentConfigurationControl: some View {
        Menu {
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

                Menu("推理强度") {
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
                Button("模型 · \(model.selectedApiModel.isEmpty ? "外部模型" : model.selectedApiModel)") {}
                    .disabled(true)
                if model.checkoutId != nil {
                    Divider()
                    Menu("仓库权限") {
                        Button {
                            Task { _ = await model.setRepositoryAccessMode("request") }
                        } label: {
                            if model.repositoryAccessMode == "request" {
                                Label("Request · 只读外部 Agent",systemImage:"checkmark")
                            } else {
                                Text("Request · 只读外部 Agent")
                            }
                        }
                        Button {
                            Task { _ = await model.setRepositoryAccessMode("full_access") }
                        } label: {
                            if model.repositoryAccessMode == "full_access" {
                                Label("Full Access · 持续允许普通仓库写入",systemImage:"checkmark")
                            } else {
                                Text("Full Access · 持续允许普通仓库写入")
                            }
                        }
                    }
                    .disabled(model.busy || model.repositoryAccessLoading)
                    .accessibilityLabel("仓库访问权限")
                    .accessibilityValue(model.repositoryAccessMode == "full_access" ? "Full Access" : "Request")
                    .accessibilityHint("权限属于当前仓库并持续生效，直到再次修改；密钥和破坏性操作仍使用独立安全边界")
                    .accessibilityIdentifier("agent.repository-access")
                }
            }
        } label: {
            HStack(spacing:5) {
                Image(systemName:model.repositoryAccessMode == "full_access" && NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                      ? "checkmark.shield.fill"
                      : (NativeWorkspace.matchesExternalProvider(model.selectedProvider) ? "server.rack" : "cpu"))
                    .font(.system(size:9.5,weight:.medium))
                    .foregroundStyle(model.repositoryAccessMode == "full_access" && NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                     ? ForgePalette.accent : ForgePalette.secondary)
                Text(composerConfigurationLabel)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth:210,alignment:.leading)
                Image(systemName:"chevron.down")
                    .font(.system(size:7,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size:10.5,weight:.medium))
            .foregroundStyle(ForgePalette.ink)
            .padding(.horizontal,8)
            .frame(height:27)
            .background(ForgePalette.softFill,
                        in:RoundedRectangle(cornerRadius:9,style:.continuous))
        }
        .menuStyle(.borderlessButton)
        .fixedSize(horizontal:false,vertical:true)
        .help(model.repositoryAccessMode == "full_access" && NativeWorkspace.matchesExternalProvider(model.selectedProvider)
              ? "当前仓库为 Full Access：普通仓库操作持续允许；密钥与破坏性操作仍单独受保护"
              : "选择 Provider、模型、推理强度与仓库访问权限")
        .accessibilityLabel("Agent 配置")
        .accessibilityValue(compactConfigurationAccessibilityValue)
        .accessibilityIdentifier("agent.configuration.compact")
    }

    private var composerConfigurationLabel: String {
        if NativeWorkspace.matchesExternalProvider(model.selectedProvider) {
            let externalModel = model.selectedApiModel.isEmpty ? "外部模型" : model.selectedApiModel
            return model.selectedProvider == "joycode"
                ? "JoyCode · \(externalModel)"
                : "API · \(externalModel)"
        }
        let modelName = model.selectedAgentModel?.displayName ?? "Codex"
        let reasoning = reasoningLabel(model.selectedReasoningEffort)
        return reasoning.isEmpty ? modelName : "\(modelName) · \(reasoning)"
    }

    private var compactConfigurationAccessibilityValue: String {
        let provider = model.selectedProvider == "joycode"
            ? "JoyCode"
            : (model.selectedProvider == "api" ? "兼容 API" : "Codex CLI")
        let writeScope = NativeWorkspace.matchesExternalProvider(model.selectedProvider)
            ? (model.repositoryAccessMode == "full_access" ? "，仓库 Full Access" : "，仓库 Request") : ""
        return "\(provider)，\(composerConfigurationLabel)\(writeScope)"
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

private struct RecordsPane: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.scenePhase) private var scenePhase
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
            HStack(spacing:12) {
            planningNavigator
                .frame(minWidth:geometry.size.width < 960 ? 330 : 620,maxWidth:.infinity)
                .background(.ultraThinMaterial,
                            in:RoundedRectangle(cornerRadius:16,style:.continuous))
                .padding(.leading,12).padding(.vertical,12)

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
                                Image(systemName:"xmark")
                                    .font(.system(size:9,weight:.semibold))
                                    .frame(width:24,height:24)
                                    .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                            }
                            .buttonStyle(.plain)
                            .help("关闭详情，返回完整关系图")
                        }

                        if let recordDetail = model.recordDetail {
                            semanticRecordDetail(recordDetail)
                        }
                    }
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .padding(.horizontal,18).padding(.vertical,20)
                }
                .frame(minWidth:geometry.size.width < 960 ? 240 : 310,
                       idealWidth:geometry.size.width < 960 ? 260 : 350,
                       maxWidth:geometry.size.width < 960 ? 290 : 390)
                .background(ForgePalette.raisedSurface.opacity(0.72),
                            in:RoundedRectangle(cornerRadius:16,style:.continuous))
                .padding(.trailing,12).padding(.vertical,12)
                .transition(.move(edge:.trailing).combined(with:.opacity))
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
        .background(ForgePalette.softFill,
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
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
                    withAnimation(.easeInOut(duration:0.18)) {
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
                        withAnimation(.easeInOut(duration:0.18)) {
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
            : (item.kind == .requirement ? ForgePalette.accent.opacity(0.075) : Color.white.opacity(0.68))
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
                .shadow(color:Color.black.opacity(selected ? 0.07 : 0.035),radius:selected ? 8 : 4,y:2)
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
                .transition(.opacity)
            }
        }
        .opacity(focused ? 1 : 0.52)
        .onHover { inside in
            if inside { hoveredPlanningRecordId=item.id }
            else if hoveredPlanningRecordId == item.id { hoveredPlanningRecordId=nil }
        }
        .animation(.easeOut(duration:0.12),value:hovered)
        .animation(.easeOut(duration:0.16),value:focused)
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
            VStack(alignment:.leading,spacing:18) {
                HStack(spacing:9) {
                    Button {
                        model.newThreadForRequirement(requirement.requirementId)
                    } label: {
                        Label("以此 Requirement 新建会话",systemImage:"bubble.left.and.bubble.right")
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        beginPlan(requirementId:requirement.requirementId,parentPlanId:nil)
                    } label: {
                        Label("添加根 Plan",systemImage:"plus")
                    }
                    .buttonStyle(.bordered)
                    Text("可选上下文，不影响普通 Agent 会话。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }
                autopilotSection(requirement)
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
                HStack(spacing:9) {
                    Button {
                        model.newThreadForPlan(plan)
                    } label: {
                        Label("以此 Plan 新建会话",systemImage:"bubble.left.and.bubble.right")
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        beginPlan(requirementId:plan.requirementId,parentPlanId:plan.planId)
                    } label: {
                        Label("细化子 Plan",systemImage:"arrow.turn.down.right")
                    }
                    .buttonStyle(.bordered)
                    Text("会话仍由 Project / checkout 承载；Plan 只是附加语义上下文。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }
                semanticSection("目标") {
                    Text(plan.goal).font(.system(size:12.5)).lineSpacing(4).textSelection(.enabled)
                }
                if let parentPlanId = plan.parentPlanId, !parentPlanId.isEmpty {
                    Button {
                        Task { await model.openPlan(parentPlanId) }
                    } label: {
                        HStack(spacing:7) {
                            Image(systemName:"arrow.turn.up.left")
                            Text("上级 Plan")
                            Text(parentPlanId).font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary)
                            Spacer(minLength:0)
                            Image(systemName:"chevron.right").font(.system(size:9,weight:.semibold))
                        }
                        .font(.system(size:11,weight:.medium))
                        .padding(.horizontal,11).frame(height:34)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
                    }
                    .buttonStyle(.plain)
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
    @State private var joyCodeModel = "JoyAI-Code-1.6"
    @State private var selectedCredentialRef = ""
    @State private var saving = false

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:6) {
                        Text("Agent 设置").font(.system(size:22,weight:.medium))
                        Text("Provider 按会话固定：Codex 使用 Forge controller.local_conversation；兼容 API 与 JoyCode 共用同一 Rust Agent 核心、取消与工具事件协议。已有历史不会因默认配置改变而切换 Provider。")
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
                        Circle().fill(model.selectedProviderReady ? Color.green : Color.orange)
                            .frame(width:8,height:8)
                        Text("当前会话 · \(model.selectedProvider == "joycode" ? "JoyCode" : (model.selectedProvider == "api" ? "兼容 API" : "Codex CLI"))")
                            .font(.system(size:14,weight:.semibold))
                        Spacer()
                        Text("当前执行 Provider")
                            .font(.system(size:9.5,weight:.semibold))
                            .padding(.horizontal,8).frame(height:22)
                            .background(ForgePalette.selection,in:Capsule())
                    }
                    Text(model.selectedProvider == "joycode"
                         ? (model.joyCodeProfileReady ? "复用本机 JoyCode 登录态；凭据不会写入 Forge 配置。" : "JoyCode 登录态尚未就绪。")
                         : (model.selectedProvider == "api"
                            ? (model.apiProfileReady ? "使用保存的兼容 API profile；仓库写权限按 Repository AccessPolicy 持续生效，密钥授权按 Grant 复用。" : "API profile 尚未完成。")
                            : model.provider))
                        .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
                    HStack(spacing:16) {
                        settingMeta("会话模型",NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                    ? (model.selectedApiModel.isEmpty ? "未配置" : model.selectedApiModel)
                                    : (model.selectedAgentModel?.displayName ?? "Codex 默认"))
                        settingMeta("Reasoning",NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                    ? (model.selectedProvider == "joycode" ? "JoyCode" : "API profile")
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
                            settingMeta("新会话默认",settings.provider == "joycode" ? "JoyCode" : (settings.provider == "api" ? "兼容 API" : "Codex CLI"))
                            settingMeta("协议",settings.apiProtocol)
                            settingMeta("Credential",settings.credentialRef ?? (settings.endpoint == "https://zro.moonmath.ai/v1" ? "zro 管理" : "未选择"))
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
                                Text("JoyCode").tag("joycode")
                            }
                            .labelsHidden().pickerStyle(.segmented).frame(maxWidth:260)
                            .accessibilityIdentifier("settings.default-provider")
                        }
                        HStack(spacing:12) {
                            Text("API 协议").font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                            Picker("API 协议",selection:$apiProtocol) {
                                Text("OpenAI Chat").tag("openai")
                                Text("OpenAI Responses").tag("responses")
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
                        settingsField("JoyCode 模型") {
                            TextField("JoyAI-Code-1.6",text:$joyCodeModel)
                                .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                                .accessibilityIdentifier("settings.joycode-model")
                        }
                        HStack(spacing:7) {
                            Circle().fill(model.localApiSettings?.joyCodeReady == true ? Color.green : Color.orange)
                                .frame(width:7,height:7)
                            Text(model.localApiSettings?.joyCodeReady == true
                                 ? "已检测到本机 JoyCode 登录态；凭据仅在请求时读取到内存。"
                                 : "未检测到 JoyCode 登录态，请先在 JoyCode 客户端登录。")
                                .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        }
                        if endpoint.trimmingCharacters(in:.whitespacesAndNewlines) == "https://zro.moonmath.ai/v1" {
                            Text("DeepSeek / zro 凭据由 zro 本机配置管理，Forge 不复制、不展示，也不创建第二份 secret。")
                                .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        } else if endpoint.lowercased().hasPrefix("http://localhost")
                                    || endpoint.lowercased().hasPrefix("http://127.0.0.1") {
                            Text("本机 loopback Endpoint 不要求受管密钥。")
                                .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        } else {
                            settingsField("受管密钥") {
                                Picker("受管密钥",selection:$selectedCredentialRef) {
                                    Text("未选择").tag("")
                                    ForEach(model.managedApiCredentials.filter { $0.endpoint == endpoint.trimmingCharacters(in:.whitespacesAndNewlines) }) { credential in
                                        Text("\(credential.label) · \(credential.authorized ? "已授权" : "未授权")")
                                            .tag(credential.credentialRef)
                                    }
                                }
                                .labelsHidden().pickerStyle(.menu)
                                .accessibilityIdentifier("settings.credential")
                            }
                            HStack(spacing:10) {
                                Button("从剪贴板导入并授权") { importCredential() }
                                    .buttonStyle(.bordered)
                                    .disabled(saving || model.settingsLoading || endpoint.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                                if let credential = selectedCredential {
                                    Button("从剪贴板轮换") { rotateCredential(credential.credentialRef) }
                                        .buttonStyle(.plain)
                                    Button(credential.authorized ? "撤销使用授权" : "授权使用") {
                                        setCredentialAuthorization(credential.credentialRef,!credential.authorized)
                                    }
                                    .buttonStyle(.plain)
                                    Button("删除",role:.destructive) { deleteCredential(credential.credentialRef) }
                                        .buttonStyle(.plain).foregroundStyle(.red)
                                }
                            }
                            if let credential = selectedCredential {
                                Text("Ref \(credential.credentialRef) · Keychain \(credential.hasSecret ? "已存" : "缺失") · \(credential.authorized ? "授权可复用" : "未授权")")
                                    .font(.system(size:9.5,design:.monospaced)).foregroundStyle(.tertiary)
                                    .textSelection(.enabled)
                            }
                        }
                        HStack(spacing:10) {
                            Spacer()
                            Button(saving ? "保存中…" : "保存配置") {
                                saveApiSettings()
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(saving || model.settingsLoading
                                      || endpoint.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                      || (defaultProvider == "api" && apiModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                                      || (defaultProvider == "joycode"
                                          && (joyCodeModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                              || model.localApiSettings?.joyCodeReady != true)))
                            .accessibilityIdentifier("settings.save")
                        }
                    }
                    .padding(13)
                    .background(ForgePalette.canvas,in:RoundedRectangle(cornerRadius:12,style:.continuous))

                    Text("Forge-managed secret 只存在 macOS Keychain；配置只保存 opaque credential ref、Endpoint、Provider 与模型。创建/轮换从剪贴板导入后立即清空剪贴板，模型与 MCP 永不获得 raw secret。JoyCode、Codex、zro 继续由各自本机凭据 Authority 管理。仓库写权限按 Repository AccessPolicy 持续生效，密钥使用按 canonical AuthorizationGrant 复用直到到期或撤销。")
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
        return [settings.provider,settings.endpoint,settings.model,settings.apiProtocol,
                settings.credentialRef ?? "",settings.joyCodeModel,settings.hasKey ? "1" : "0",settings.joyCodeReady ? "1" : "0"].joined(separator:"|")
    }

    private func syncSettingsDraft() {
        guard let settings = model.localApiSettings else { return }
        defaultProvider = settings.provider
        endpoint = settings.endpoint
        apiModel = settings.model
        joyCodeModel = settings.joyCodeModel
        apiProtocol = settings.apiProtocol
        selectedCredentialRef = settings.credentialRef ?? ""
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
                credentialRef:selectedCredentialRef.isEmpty ? nil : selectedCredentialRef,
                joyCodeModel:joyCodeModel
            )
            _ = saved
            saving = false
        }
    }

    private var selectedCredential: ManagedApiCredentialDetail? {
        model.managedApiCredentials.first { $0.credentialRef == selectedCredentialRef }
    }

    private func importCredential() {
        guard !saving else { return }
        saving = true
        Task {
            if let credentialRef = await model.createManagedApiCredential(endpoint:endpoint,label:URL(string:endpoint)?.host) {
                selectedCredentialRef = credentialRef
            }
            saving = false
        }
    }

    private func rotateCredential(_ credentialRef:String) {
        guard !saving else { return }
        saving = true
        Task { _ = await model.rotateManagedApiCredential(credentialRef); saving = false }
    }

    private func setCredentialAuthorization(_ credentialRef:String,_ authorized:Bool) {
        guard !saving else { return }
        saving = true
        Task { _ = await model.setManagedApiCredentialAuthorization(credentialRef,authorized:authorized); saving = false }
    }

    private func deleteCredential(_ credentialRef:String) {
        guard !saving else { return }
        saving = true
        Task {
            if await model.deleteManagedApiCredential(credentialRef), selectedCredentialRef == credentialRef {
                selectedCredentialRef = ""
            }
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
