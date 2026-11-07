import Foundation
import Combine

struct ForgeProject: Identifiable, Decodable {
    let repoId: String
    let displayName: String
    let localRoot: String?
    let checkoutId: String?
    let remoteUrl: String?
    let defaultBranch: String?
    var id: String { repoId }
    var label: String {
        guard let remoteUrl, remoteUrl.contains("github.com") else { return displayName }
        return remoteUrl.replacingOccurrences(of: ".git", with: "").split(separator: "/").suffix(2).joined(separator: "/")
    }
}
struct AgentReasoningOption: Codable, Identifiable {
    let effort: String
    let description: String
    var id: String { effort }
}

struct AgentModelOption: Codable, Identifiable {
    let slug: String
    let displayName: String
    let description: String
    let defaultReasoningLevel: String
    let supportedReasoningLevels: [AgentReasoningOption]
    var id: String { slug }
}

struct AgentGitDiff: Codable {
    let repoId: String
    let checkoutId: String
    let branch: String
    let head: String
    let staged: Bool
    let paths: [String]
    let nameOnly: [String]
    let stat: String
    let patch: String
    let truncated: Bool
    var untracked: [String]? = nil
    var untrackedFiles: [String] { untracked ?? [] }
}

struct AgentLiveActivityEvent: Codable, Identifiable {
    let phase: String
    let label: String
    let detail: String?
    let status: String
    let startedAt: String
    let completedAt: String?
    var id: String { "\(startedAt)|\(phase)|\(label)" }
}

struct AgentLiveActivity: Codable {
    let conversationId: String
    let status: String
    let phase: String?
    let toolActivityCount: Int
    let lastActivity: String?
    let startedAt: String?
    let updatedAt: String?
    let events: [AgentLiveActivityEvent]?

    var priorEvents: [AgentLiveActivityEvent] {
        guard let events, events.count > 1 else { return [] }
        return Array(events.dropLast())
    }

    var recentPriorEvents: [AgentLiveActivityEvent] {
        Array(priorEvents.suffix(4))
    }
}

enum AgentMessageBlock: Equatable {
    case markdown(String)
    case code(language: String?, text: String)

    static func parse(_ source: String) -> [AgentMessageBlock] {
        let lines = source.components(separatedBy:"\n")
        var blocks: [AgentMessageBlock] = []
        var prose: [String] = []
        var code: [String] = []
        var language: String?
        var inCode = false

        func normalizedProse(_ lines: [String]) -> String {
            lines.joined(separator:"\n").trimmingCharacters(in:.newlines)
        }
        func fenceLanguage(_ line: String) -> String? {
            let trimmed = line.trimmingCharacters(in:.whitespaces)
            guard trimmed.hasPrefix("```") else { return nil }
            let suffix = String(trimmed.dropFirst(3)).trimmingCharacters(in:.whitespaces)
            return suffix.isEmpty ? nil : suffix
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in:.whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    blocks.append(.code(language:language,text:code.joined(separator:"\n")))
                    code.removeAll(keepingCapacity:true)
                    language = nil
                    inCode = false
                } else {
                    let text = normalizedProse(prose)
                    if !text.isEmpty { blocks.append(.markdown(text)) }
                    prose.removeAll(keepingCapacity:true)
                    language = fenceLanguage(line)
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line) } else { prose.append(line) }
        }

        if inCode {
            blocks.append(.code(language:language,text:code.joined(separator:"\n")))
        } else {
            let text = normalizedProse(prose)
            if !text.isEmpty { blocks.append(.markdown(text)) }
        }
        return blocks
    }
}

struct ChatMessage: Codable, Identifiable {
    var id = UUID().uuidString
    let role: String
    let text: String
    var attachmentNames: [String]?
    var contextPaths: [String]?
    var toolActivityCount: Int?
    var activityEvents: [AgentLiveActivityEvent]?
    var createdAt = Date()
}
struct ChatThread: Codable, Identifiable {
    var id = UUID().uuidString
    var title = "新会话"
    var repoId: String?
    var checkoutId: String?
    var provider: String?
    var providerSessionId: String?
    var model: String?
    var reasoningEffort: String?
    var messages: [ChatMessage] = []
    var updatedAt = Date()
}
struct ForgeRecord: Identifiable {
    let id: String
    let title: String
    let state: String
}
struct RequirementRecordDetail {
    let requirementId: String
    let revision: Int
    let title: String
    let outcomeStatement: String
    let state: String
    let acceptanceCriteria: [String]
    let progressSummary: String
    let remainingWork: [String]
}

struct PlanRecordItem: Identifiable {
    let id: String
    let objective: String
}

struct PlanRecordDetail {
    let planId: String
    let revision: Int
    let requirementId: String?
    let sourceBasisRevision: String?
    let goal: String
    let items: [PlanRecordItem]
    let resolvedDecisions: [String]
    let nonGoals: [String]
}

enum SemanticRecordDetail {
    case requirement(RequirementRecordDetail)
    case plan(PlanRecordDetail)
}
struct RuntimeStatusDetail {
    let running: Bool
    let ready: Bool
    let stale: Bool
    let label: String
    let detail: String
    let pid: Int?
    let releaseId: String?
    let endpoint: String?
    let observedAt: String?
    let reasonCount: Int
}

struct RuntimeProbeDetail: Identifiable {
    let id: String
    let label: String
    let ok: Bool
}

struct RuntimeDiagnosticsDetail {
    let ok: Bool
    let checkedAt: String?
    let passed: Int
    let failed: Int
    let probes: [RuntimeProbeDetail]
}

struct ConnectionComponentDetail {
    let ready: Bool
    let title: String
    let detail: String
}

struct ControllerConnectionDetail {
    let configured: Bool
    let ready: Bool
    let controller: ConnectionComponentDetail
    let tunnel: ConnectionComponentDetail
    let repairAvailable: Bool
    let repairLabel: String
}
struct KnowledgeScopeDetail: Codable {
    let kind: String
    let id: String
}

struct KnowledgeProvenanceDetail: Codable {
    let sourceKind: String?
    let recordedAt: String?
}

struct KnowledgeMemoryDetail: Codable, Identifiable {
    let id: String
    let revision: Int
    let canonicalText: String
    let concepts: [String]
    let facets: [String]
    let confidence: Double
    let scope: KnowledgeScopeDetail
    let provenance: KnowledgeProvenanceDetail?
}

struct KnowledgeItemDetail: Codable {
    let memory: KnowledgeMemoryDetail
}

struct KnowledgeAuditDetail: Codable {
    let readonly: Bool
    let advisoryOnly: Bool
    let scopes: [KnowledgeScopeDetail]
    let items: [KnowledgeItemDetail]
    let inspected: Int
    let truncated: Bool
    let gaps: [String]
}

struct LocalApiSettingsDetail {
    let provider: String
    let endpoint: String
    let model: String
    let apiProtocol: String
    let hasKey: Bool
}

struct RepositoryCheckoutContext {
    let checkoutId: String?
    let checkoutRoot: URL?
    let checkoutBranch: String?
}
enum NativePage: String, CaseIterable, Identifiable {
    case agent = "会话", requirement = "Requirement", plan = "Plan",
         knowledge = "知识库", runtime = "Runtime", settings = "设置"
    var id: String { rawValue }
    var accessibilityId: String {
        switch self {
        case .agent: return "nav.agent"
        case .requirement: return "nav.requirement"
        case .plan: return "nav.plan"
        case .knowledge: return "nav.knowledge"
        case .runtime: return "nav.runtime"
        case .settings: return "nav.settings"
        }
    }
    var symbol: String {
        switch self {
        case .agent: return "bubble.left.and.bubble.right"
        case .requirement: return "doc.text"
        case .plan: return "list.bullet.rectangle"
        case .knowledge: return "books.vertical"
        case .runtime: return "waveform.path.ecg"
        case .settings: return "gearshape"
        }
    }
    var recordIdKey: String {
        switch self {
        case .requirement: return "requirementId"
        case .plan: return "planId"
        default: return "id"
        }
    }
}

@MainActor
final class NativeWorkspace: ObservableObject {
    @Published var page: NativePage = .agent
    @Published private(set) var projects: [ForgeProject] = []
    @Published var repoId: String?
    @Published var checkoutId: String?
    @Published var threads: [ChatThread] = []
    @Published var selectedThreadId: String?
    @Published var draft = ""
    @Published var search = ""
    @Published var showSearch = false
    @Published var busy = false
    @Published private(set) var activeConversationId: String?
    private var activeApiTurn: ForgeApiTurn?
    private var activeTurnProvider: String?
    @Published var provider = "未检测"
    @Published private(set) var localProviderReady = false
    @Published var imageInputAvailable = false
    @Published var allowApiEffects = false
    @Published var pendingImageURLs: [URL] = []
    @Published var pendingContextPaths: [String] = []
    @Published var checkoutRoot: URL?
    @Published var checkoutBranch: String?
    @Published private(set) var agentModels: [AgentModelOption] = []
    @Published var agentChanges: AgentGitDiff?
    @Published var changesLoading = false
    @Published var liveActivity: AgentLiveActivity?
    @Published var connection = "未检测"
    @Published var error: String?
    @Published var records: [ForgeRecord] = []
    @Published var selectedRecord: String?
    @Published var recordDetail: SemanticRecordDetail?
    @Published var detail = ""
    @Published var runtimeStatus: RuntimeStatusDetail?
    @Published var runtimeDiagnostics: RuntimeDiagnosticsDetail?
    @Published var runtimeLoading = false
    @Published var connectionStatus: ControllerConnectionDetail?
    @Published var connectionLoading = false
    @Published var knowledgeQuery = ""
    @Published var knowledgeResult: KnowledgeAuditDetail?
    @Published var knowledgeLoading = false
    @Published var localApiSettings: LocalApiSettingsDetail?
    @Published var settingsLoading = false
    let store: URL

    init(store: URL? = nil) {
        self.store = store ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ForgeNative/conversations.json")
        if let bytes = try? Data(contentsOf: self.store),
           let items = try? JSONDecoder().decode([ChatThread].self, from: bytes) {
            threads = Array(items.prefix(100))
            if let first = threads.first {
                selectedThreadId = first.id
                repoId = first.repoId
                checkoutId = first.checkoutId
            }
        }
        if threads.isEmpty { newThread() }
    }

    var project: ForgeProject? { projects.first { $0.repoId == repoId } }
    var thread: ChatThread? { threads.first { $0.id == selectedThreadId } }
    var selectedProvider: String {
        if let provider = thread?.provider { return provider }
        if thread?.messages.isEmpty == false { return "codex" }
        return localApiSettings?.provider ?? "codex"
    }
    var apiProfileReady: Bool {
        guard let settings = localApiSettings else { return false }
        return !settings.endpoint.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
            && !settings.model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
    }
    var selectedProviderReady: Bool {
        if selectedProvider == "api" {
            let endpoint = localApiSettings?.endpoint.trimmingCharacters(in:.whitespacesAndNewlines) ?? ""
            return !endpoint.isEmpty && !selectedApiModel.isEmpty
        }
        return localProviderReady
    }
    var selectedApiModel: String {
        let threadModel = thread?.model?.trimmingCharacters(in:.whitespacesAndNewlines) ?? ""
        if selectedProvider == "api" && !threadModel.isEmpty { return threadModel }
        return localApiSettings?.model.trimmingCharacters(in:.whitespacesAndNewlines) ?? ""
    }
    var selectedProviderSupportsImages: Bool {
        selectedProvider == "codex" && imageInputAvailable
    }
    var selectedAgentModel: AgentModelOption? {
        if let slug = thread?.model, let exact = agentModels.first(where: { $0.slug == slug }) { return exact }
        return agentModels.first
    }
    var selectedReasoningEffort: String {
        guard let model = selectedAgentModel else { return "" }
        if let current = thread?.reasoningEffort,
           model.supportedReasoningLevels.contains(where: { $0.effort == current }) {
            return current
        }
        return model.defaultReasoningLevel
    }
    var selectedReasoningOptions: [AgentReasoningOption] {
        selectedAgentModel?.supportedReasoningLevels ?? []
    }
    var changedFileCount: Int {
        guard let changes = agentChanges else { return 0 }
        return changes.nameOnly.count + changes.untrackedFiles.count
    }
    var visibleThreads: [ChatThread] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return threads.filter { t in
            needle.isEmpty || t.title.localizedCaseInsensitiveContains(needle) ||
            t.messages.contains { $0.text.localizedCaseInsensitiveContains(needle) }
        }.sorted { $0.updatedAt > $1.updatedAt }
    }
    func persist() {
        do {
            try FileManager.default.createDirectory(at: store.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(Array(threads.prefix(100))).write(to: store, options: .atomic)
        } catch { self.error = "无法保存会话：\(error.localizedDescription)" }
    }
    func newThread(provider providerOverride: String? = nil) {
        guard !busy else {
            self.error = "请先停止正在运行的会话。"
            return
        }
        let provider = providerOverride ?? localApiSettings?.provider
        let item = ChatThread(
            repoId:repoId,
            checkoutId:checkoutId,
            provider:provider,
            model:provider == "api" ? localApiSettings?.model : nil
        )
        threads.insert(item, at:0)
        selectedThreadId = item.id
        page = .agent
        draft = ""
        pendingImageURLs = []
        pendingContextPaths = []
        allowApiEffects = false
        agentChanges = nil
        persist()
    }
    func selectThread(_ id: String) {
        if busy {
            guard id == activeConversationId else {
                self.error = "请先停止正在运行的会话。"
                return
            }
            return
        }
        guard let item = threads.first(where: { $0.id == id }) else { return }
        selectedThreadId = id
        page = .agent
        draft = ""
        pendingImageURLs = []
        pendingContextPaths = []
        allowApiEffects = false
        agentChanges = nil
        checkoutRoot = nil
        checkoutBranch = nil
        if let boundRepoId = item.repoId {
            repoId = boundRepoId
            checkoutId = item.checkoutId
            Task { await refreshProject() }
        } else {
            repoId = nil
            checkoutId = nil
        }
    }
    func selectThreadProvider(_ value: String) {
        guard !busy, matchesProvider(value),
              let index = threads.firstIndex(where:{$0.id == selectedThreadId}),
              threads[index].messages.isEmpty else { return }
        if value == "api" && !apiProfileReady {
            self.error = "请先在设置中完成 API Endpoint 与模型配置。"
            return
        }
        threads[index].provider = value
        threads[index].providerSessionId = nil
        threads[index].model = value == "api" ? localApiSettings?.model : nil
        threads[index].reasoningEffort = nil
        threads[index].updatedAt = Date()
        pendingImageURLs = []
        allowApiEffects = false
        persist()
        self.error = nil
    }

    private func matchesProvider(_ value:String) -> Bool {
        value == "codex" || value == "api"
    }

    func selectAgentModel(_ slug: String) {
        guard let index = threads.firstIndex(where: { $0.id == selectedThreadId }),
              let model = agentModels.first(where: { $0.slug == slug }) else { return }
        threads[index].model = model.slug
        if !model.supportedReasoningLevels.contains(where: { $0.effort == threads[index].reasoningEffort }) {
            threads[index].reasoningEffort = model.defaultReasoningLevel
        }
        threads[index].updatedAt = Date()
        persist()
    }
    func selectReasoningEffort(_ effort: String) {
        guard let index = threads.firstIndex(where: { $0.id == selectedThreadId }),
              selectedReasoningOptions.contains(where: { $0.effort == effort }) else { return }
        threads[index].reasoningEffort = effort
        threads[index].updatedAt = Date()
        persist()
    }
    func renameThread(_ id: String, to title: String) {
        let title = title.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !title.isEmpty, let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].title = String(title.prefix(80))
        threads[index].updatedAt = Date()
        persist()
    }
    func deleteThread(_ id: String) {
        guard activeConversationId != id else {
            self.error = "请先停止正在运行的会话。"
            return
        }
        threads.removeAll { $0.id == id }
        if selectedThreadId == id { selectedThreadId = threads.first?.id }
        if threads.isEmpty { newThread() } else { persist() }
    }

    func reeditMessage(_ message: ChatMessage) {
        guard !busy else {
            self.error = "请先停止正在运行的会话。"
            return
        }
        draft = message.text
        pendingImageURLs = []
        pendingContextPaths = []

        var notes: [String] = []
        if let paths = message.contextPaths, !paths.isEmpty {
            if let checkoutRoot {
                addPendingContextFiles(paths.map { checkoutRoot.appendingPathComponent($0) })
                if let error { notes.append(error) }
            } else {
                notes.append("当前 checkout 不可用，文件上下文未恢复。")
            }
        }
        if message.attachmentNames?.isEmpty == false {
            notes.append("历史图片仅保存文件名，请重新附加图片后再发送。")
        }
        self.error = notes.isEmpty ? nil : Array(Set(notes)).sorted().joined(separator:" ")
    }
    func selectProject(_ id: String) {
        guard !busy else {
            self.error = "请先停止正在运行的会话。"
            return
        }
        guard thread?.repoId != id else { return }
        let sourceThreadId = selectedThreadId
        let sourceProvider = selectedProvider
        Task {
            do {
                let result = try await ForgeBridge.request("read_project_repository",["repoId":id])
                guard selectedThreadId == sourceThreadId, !busy else { return }
                let context = Self.repositoryCheckoutContext(result,requestedCheckoutId:nil)
                guard let targetCheckoutId = context.checkoutId else {
                    self.error = "目标项目没有可用的 active checkout。"
                    return
                }
                // Resolve first, then create a new conversation identity. The old selected
                // ChatThread remains the sole context authority until this exact point.
                repoId = id
                checkoutId = targetCheckoutId
                checkoutRoot = context.checkoutRoot
                checkoutBranch = context.checkoutBranch
                pendingContextPaths = []
                newThread(provider:sourceProvider)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
    func show(_ page: NativePage) {
        if self.page != page { error = nil }
        self.page = page
        if page != .agent { Task { await loadPage() } }
    }
    func toggleConversationSearch() {
        show(.agent)
        showSearch.toggle()
        if !showSearch { search = "" }
    }

    nonisolated static func localProviderStatusReady(_ status:[String:Any]) -> Bool {
        status["status"] as? String == "ready"
    }

    private func applyLocalProviderStatus(_ status:[String:Any]) {
        provider = status["label"] as? String ?? status["status"] as? String ?? "Codex 不可用"
        localProviderReady = Self.localProviderStatusReady(status)
        imageInputAvailable = status["imageInput"] as? Bool == true
    }

    func refresh() async {
        do {
            let result = try await ForgeBridge.request("read_projects")
            let rows = result["repositories"] as? [[String: Any]] ?? []
            let bytes = try JSONSerialization.data(withJSONObject: rows)
            projects = try JSONDecoder().decode([ForgeProject].self, from: bytes)
            // Agent repository context is owned by the selected ChatThread. Do not
            // fabricate a binding from preferredRepoId for an unbound conversation.
            if let status = try? await ForgeBridge.request("read_local_provider_status") {
                applyLocalProviderStatus(status)
            } else {
                provider = "Codex 不可用"
                localProviderReady = false
                imageInputAvailable = false
            }
            if !selectedProviderSupportsImages { pendingImageURLs = [] }
            if let settingsValue = try? await ForgeBridge.request("read_local_api_settings"),
               let parsed = Self.localApiSettingsDetail(settingsValue) {
                localApiSettings = parsed
            }
            if let catalog = try? await ForgeBridge.request("read_local_provider_models"),
               let rows = catalog["models"] as? [[String: Any]],
               let bytes = try? JSONSerialization.data(withJSONObject: rows),
               let decoded = try? JSONDecoder().decode([AgentModelOption].self, from: bytes) {
                agentModels = decoded
            }
            let health = try? await ForgeBridge.request("read_connection_status")
            connection = health?["ready"] as? Bool == true ? "已连接" : "未就绪"
            await refreshProject()
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    nonisolated static func repositoryCheckoutContext(
        _ result:[String:Any], requestedCheckoutId:String?
    ) -> RepositoryCheckoutContext {
        let repository = result["repository"] as? [String:Any] ?? [:]
        let targetCheckoutId = requestedCheckoutId ?? repository["activeCheckoutId"] as? String
        let checkouts = repository["checkouts"] as? [[String:Any]] ?? []
        let target = checkouts.first { $0["checkoutId"] as? String == targetCheckoutId }
        let root = target.flatMap { $0["path"] as? String }
            .map { URL(fileURLWithPath:$0).resolvingSymlinksInPath().standardizedFileURL }
        return RepositoryCheckoutContext(
            checkoutId:targetCheckoutId,
            checkoutRoot:root,
            checkoutBranch:target?["branch"] as? String
        )
    }

    func refreshProject() async {
        guard let repoId else { return }
        let requestedCheckoutId = checkoutId
        do {
            let result = try await ForgeBridge.request("read_project_repository", ["repoId":repoId])
            guard self.repoId == repoId, self.checkoutId == requestedCheckoutId else { return }
            let context = Self.repositoryCheckoutContext(result,requestedCheckoutId:requestedCheckoutId)
            checkoutId = context.checkoutId
            checkoutRoot = context.checkoutRoot
            checkoutBranch = context.checkoutBranch
            if page != .agent { await loadPage() }
        } catch {
            checkoutRoot = nil
            checkoutBranch = nil
            self.error = error.localizedDescription
        }
    }
    func loadPage() async {
        if page == .runtime {
            await loadRuntimePage()
            return
        }
        if page == .knowledge {
            await searchKnowledge()
            return
        }
        if page == .settings {
            await loadSettingsPage()
            return
        }
        guard let repoId, [.requirement,.plan].contains(page) else { return }
        do {
            let action = page == .plan ? "read_project_plan_list" : "read_project_overview"
            let result = try await ForgeBridge.request(action, ["repoId":repoId])
            let data = result["data"] as? [String: Any] ?? result
            let rows: [[String: Any]]
            switch page {
            case .plan: rows = data["plans"] as? [[String:Any]] ?? []
            case .requirement:
                let board = data["requirementBoard"] as? [String:Any] ?? result["requirementBoard"] as? [String:Any] ?? [:]
                rows = board["requirements"] as? [[String:Any]] ?? []
            default: rows = []
            }
            records = rows.compactMap { row -> ForgeRecord? in
                guard let id = row[page.recordIdKey] as? String else { return nil }
                return ForgeRecord(id:id, title:row["title"] as? String ?? row["objective"] as? String ??
                                   row["goal"] as? String ?? id, state:row["state"] as? String ?? "")
            }
            detail = ""
            selectedRecord = nil
            recordDetail = nil
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    func loadRaw(_ operation: String, _ args: [String:Any]) async {
        do {
            let result = try await ForgeBridge.request(operation, args)
            detail = Self.prettyJSON(result)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    nonisolated static func runtimeStatusDetail(_ result: [String:Any]) -> RuntimeStatusDetail {
        let status = result["data"] as? [String:Any] ?? result
        let running = status["running"] as? Bool == true
        let ready = status["ready"] as? Bool == true
        let stale = status["stale"] as? Bool == true
        let snapshot = status["snapshot"] as? [String:Any] ?? [:]
        let reasonCount = (status["reasonCodes"] as? [Any])?.count ?? 0
        let label: String
        let detail: String
        if stale {
            label = "运行时状态已过期"
            detail = "独立恢复能够读取状态，但最近的运行时投影已经过期。"
        } else if ready {
            label = "运行时正常"
            detail = "主运行时正在运行并通过就绪检查。"
        } else if running {
            label = "运行时未就绪"
            detail = "主运行时进程存在，但尚未通过完整就绪检查。"
        } else {
            label = "运行时未运行"
            detail = "主运行时当前未运行；客户端仍只通过独立恢复读取状态。"
        }
        return RuntimeStatusDetail(
            running:running, ready:ready, stale:stale, label:label, detail:detail,
            pid:snapshot["pid"] as? Int,
            releaseId:snapshot["releaseId"] as? String,
            endpoint:snapshot["endpoint"] as? String,
            observedAt:(snapshot["observedAt"] as? String) ?? (status["observedAt"] as? String),
            reasonCount:reasonCount
        )
    }

    nonisolated static func runtimeDiagnosticsDetail(_ result: [String:Any]) -> RuntimeDiagnosticsDetail {
        let raw = result["data"] as? [String:Any] ?? result
        let labels = [
            "runtime_status":"运行时状态", "active_gateway":"活动网关",
            "runtime_execution_surface":"运行时执行面", "primary_tunnel_runtime":"主隧道",
            "primary_connector_local":"主连接器", "recovery_gateway":"恢复网关",
            "recovery_watchdog":"恢复看门狗", "mcp_initialize":"MCP 初始化",
            "mcp_tools_list":"MCP 工具列表", "mcp_read_only_call":"MCP 只读调用",
            "mcp_session_close":"MCP 会话关闭"
        ]
        let probeMap = raw["probes"] as? [String:[String:Any]] ?? [:]
        let probes = probeMap.keys.sorted().map { id in
            RuntimeProbeDetail(id:id,label:labels[id] ?? id,ok:probeMap[id]?["ok"] as? Bool == true)
        }
        let passed = probes.filter(\.ok).count
        return RuntimeDiagnosticsDetail(
            ok:raw["ok"] as? Bool == true,
            checkedAt:raw["at"] as? String,
            passed:passed, failed:probes.count - passed, probes:probes
        )
    }

    nonisolated static func controllerConnectionDetail(_ result: [String:Any]) -> ControllerConnectionDetail? {
        let data = result["data"] as? [String:Any] ?? result
        let value = data["connection"] as? [String:Any] ?? data
        guard let controller = value["controller"] as? [String:Any],
              let tunnel = value["tunnel"] as? [String:Any] else { return nil }
        let repair = value["repair"] as? [String:Any] ?? [:]
        return ControllerConnectionDetail(
            configured:value["configured"] as? Bool == true,
            ready:value["ready"] as? Bool == true,
            controller:ConnectionComponentDetail(
                ready:controller["ready"] as? Bool == true,
                title:controller["title"] as? String ?? "控制器",
                detail:controller["detail"] as? String ?? ""
            ),
            tunnel:ConnectionComponentDetail(
                ready:tunnel["ready"] as? Bool == true,
                title:tunnel["title"] as? String ?? "隧道",
                detail:tunnel["detail"] as? String ?? ""
            ),
            repairAvailable:repair["available"] as? Bool == true,
            repairLabel:repair["label"] as? String ?? "刷新 Forge Connector"
        )
    }

    func loadRuntimePage() async {
        runtimeLoading = true
        connectionLoading = true
        defer { runtimeLoading = false; connectionLoading = false }
        var failures: [String] = []
        do {
            let value = try await ForgeBridge.request("read_recovery_status")
            runtimeStatus = Self.runtimeStatusDetail(value)
        } catch {
            runtimeStatus = nil
            failures.append("Runtime：\(error.localizedDescription)")
        }
        do {
            let value = try await ForgeBridge.request("read_connection_status")
            guard let parsed = Self.controllerConnectionDetail(value) else { throw ForgeBridgeError.invalidResponse }
            connectionStatus = parsed
            connection = parsed.ready ? "已连接" : "未就绪"
        } catch {
            connectionStatus = nil
            connection = "未就绪"
            failures.append("连接：\(error.localizedDescription)")
        }
        self.error = failures.isEmpty ? nil : failures.joined(separator:"\n")
    }

    func diagnoseRuntime() async {
        guard !runtimeLoading else { return }
        runtimeLoading = true
        defer { runtimeLoading = false }
        do {
            let value = try await ForgeBridge.request("verify_recovery_runtime")
            runtimeDiagnostics = Self.runtimeDiagnosticsDetail(value)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func repairControllerConnection() async {
        guard !connectionLoading else { return }
        connectionLoading = true
        defer { connectionLoading = false }
        do {
            let value = try await ForgeBridge.request("repair_connection")
            guard let parsed = Self.controllerConnectionDetail(value) else { throw ForgeBridgeError.invalidResponse }
            connectionStatus = parsed
            connection = parsed.ready ? "已连接" : "未就绪"
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    nonisolated static func localApiSettingsDetail(_ result:[String:Any]) -> LocalApiSettingsDetail? {
        guard let provider = result["provider"] as? String,
              let endpoint = result["endpoint"] as? String,
              let model = result["model"] as? String,
              let apiProtocol = result["apiProtocol"] as? String else { return nil }
        return LocalApiSettingsDetail(
            provider:provider, endpoint:endpoint, model:model,
            apiProtocol:apiProtocol, hasKey:result["hasKey"] as? Bool == true
        )
    }

    func loadSettingsPage() async {
        guard !settingsLoading else { return }
        settingsLoading = true
        defer { settingsLoading = false }

        async let statusRequest = ForgeBridge.request("read_local_provider_status")
        async let settingsRequest = ForgeBridge.request("read_local_api_settings")
        var failures: [String] = []

        do {
            applyLocalProviderStatus(try await statusRequest)
        } catch {
            provider = "Codex 状态不可用"
            localProviderReady = false
            imageInputAvailable = false
            failures.append("Provider：\(error.localizedDescription)")
        }

        do {
            let settingsValue = try await settingsRequest
            guard let parsed = Self.localApiSettingsDetail(settingsValue) else { throw ForgeBridgeError.invalidResponse }
            localApiSettings = parsed
        } catch {
            localApiSettings = nil
            failures.append("API 配置：\(error.localizedDescription)")
        }

        self.error = failures.isEmpty ? nil : failures.joined(separator:"\n")
    }

    func saveLocalApiSettings(
        provider:String,
        endpoint:String,
        model:String,
        apiProtocol:String,
        apiKey:String
    ) async -> Bool {
        guard !settingsLoading else { return false }
        settingsLoading = true
        defer { settingsLoading = false }
        do {
            var arguments: [String:Any] = [
                "provider":provider,
                "endpoint":endpoint.trimmingCharacters(in:.whitespacesAndNewlines),
                "model":model.trimmingCharacters(in:.whitespacesAndNewlines),
                "apiProtocol":apiProtocol
            ]
            let secret = apiKey.trimmingCharacters(in:.whitespacesAndNewlines)
            if !secret.isEmpty { arguments["apiKey"] = secret }
            let value = try await ForgeBridge.request("save_local_api_settings",arguments)
            guard let parsed = Self.localApiSettingsDetail(value) else { throw ForgeBridgeError.invalidResponse }
            localApiSettings = parsed
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func clearLocalApiKey() async -> Bool {
        guard !settingsLoading else { return false }
        settingsLoading = true
        defer { settingsLoading = false }
        do {
            let value = try await ForgeBridge.request("clear_local_api_key")
            guard let parsed = Self.localApiSettingsDetail(value) else { throw ForgeBridgeError.invalidResponse }
            localApiSettings = parsed
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
    static func prettyJSON(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let bytes = try? JSONSerialization.data(withJSONObject: value, options:[.prettyPrinted,.sortedKeys])
        else { return "" }
        return String(data:bytes,encoding:.utf8) ?? ""
    }
    nonisolated static func requirementDetail(_ result: [String:Any]) -> RequirementRecordDetail? {
        let data = result["data"] as? [String:Any] ?? result
        guard let value = data["requirement"] as? [String:Any],
              let id = value["requirementId"] as? String else { return nil }
        return RequirementRecordDetail(
            requirementId:id,
            revision:value["revision"] as? Int ?? 0,
            title:value["title"] as? String ?? id,
            outcomeStatement:value["outcomeStatement"] as? String ?? "",
            state:value["state"] as? String ?? "",
            acceptanceCriteria:value["acceptanceCriteria"] as? [String] ?? [],
            progressSummary:value["progressSummary"] as? String ?? "",
            remainingWork:value["remainingWork"] as? [String] ?? []
        )
    }

    nonisolated static func planDetail(_ result: [String:Any]) -> PlanRecordDetail? {
        let data = result["data"] as? [String:Any] ?? result
        guard let value = data["plan"] as? [String:Any],
              let id = value["planId"] as? String else { return nil }
        let items = (value["items"] as? [[String:Any]] ?? []).compactMap { item -> PlanRecordItem? in
            guard let itemId = item["id"] as? String else { return nil }
            return PlanRecordItem(id:itemId,objective:item["objective"] as? String ?? itemId)
        }
        return PlanRecordDetail(
            planId:id,
            revision:value["revision"] as? Int ?? 0,
            requirementId:value["requirementId"] as? String,
            sourceBasisRevision:value["sourceBasisRevision"] as? String,
            goal:value["goal"] as? String ?? id,
            items:items,
            resolvedDecisions:value["resolvedDecisions"] as? [String] ?? [],
            nonGoals:value["nonGoals"] as? [String] ?? []
        )
    }

    func openRecord(_ id: String) async {
        guard let repoId else { return }
        selectedRecord = id
        recordDetail = nil
        do {
            if page == .plan {
                let result = try await ForgeBridge.request("read_plan_detail",["repoId":repoId,"planId":id])
                guard let parsed = Self.planDetail(result) else { throw ForgeBridgeError.invalidResponse }
                recordDetail = .plan(parsed)
            } else {
                let result = try await ForgeBridge.request("read_requirement_detail",["repoId":repoId,"requirementId":id])
                guard let parsed = Self.requirementDetail(result) else { throw ForgeBridgeError.invalidResponse }
                recordDetail = .requirement(parsed)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func openRequirement(_ id: String) async {
        page = .requirement
        await loadPage()
        await openRecord(id)
    }
    nonisolated static func knowledgeAuditDetail(_ result: [String:Any]) -> KnowledgeAuditDetail? {
        guard JSONSerialization.isValidJSONObject(result),
              let bytes = try? JSONSerialization.data(withJSONObject:result) else { return nil }
        return try? JSONDecoder().decode(KnowledgeAuditDetail.self,from:bytes)
    }

    func searchKnowledge() async {
        guard let repoId else {
            knowledgeResult = nil
            return
        }
        guard !knowledgeLoading else { return }
        knowledgeLoading = true
        knowledgeResult = nil
        defer { knowledgeLoading = false }
        do {
            let value = try await ForgeBridge.request("read_project_knowledge",[
                "repoId":repoId,"query":knowledgeQuery
            ])
            guard let parsed = Self.knowledgeAuditDetail(value) else { throw ForgeBridgeError.invalidResponse }
            knowledgeResult = parsed
            error = nil
        } catch {
            knowledgeResult = nil
            self.error = error.localizedDescription
        }
    }
    func refreshLiveActivity(conversationId: String) async {
        do {
            let value = try await ForgeBridge.request("read_local_conversation_activity",[
                "conversationId":conversationId
            ])
            let bytes = try JSONSerialization.data(withJSONObject:value)
            let activity = try JSONDecoder().decode(AgentLiveActivity.self,from:bytes)
            liveActivity = activity.status == "running" ? activity : nil
        } catch {
            // Live activity is advisory UI only; the authoritative send result owns completion/errors.
        }
    }
    private func loadAgentChanges(paths: [String]? = nil, staged: Bool = false) async throws -> AgentGitDiff {
        guard let repoId, let checkoutId else {
            throw NSError(domain:"ForgeNative",code:1,userInfo:[
                NSLocalizedDescriptionKey:"当前会话未绑定 repository / checkout。"
            ])
        }
        var arguments: [String:Any] = [
            "repoId":repoId,
            "checkoutId":checkoutId,
            "staged":staged
        ]
        if let paths, !paths.isEmpty { arguments["paths"] = paths }
        let value = try await ForgeBridge.request("read_agent_git_diff",arguments)
        let bytes = try JSONSerialization.data(withJSONObject:value)
        return try JSONDecoder().decode(AgentGitDiff.self, from:bytes)
    }

    func refreshAgentChanges(staged: Bool = false) async {
        guard repoId != nil, checkoutId != nil else {
            agentChanges = nil
            return
        }
        changesLoading = true
        defer { changesLoading = false }
        do {
            agentChanges = try await loadAgentChanges(staged:staged)
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func reviewedChangesMatchPaths(_ changes: AgentGitDiff, paths: [String]) -> Bool {
        let requested = Set(paths.filter { !$0.isEmpty })
        return !requested.isEmpty && !changes.truncated
            && Set(changes.nameOnly) == requested
            && !changes.patch.isEmpty
    }

    func reviewAgentChanges(paths: [String], staged: Bool = false) async -> AgentGitDiff? {
        do {
            let changes = try await loadAgentChanges(paths:paths,staged:staged)
            guard Self.reviewedChangesMatchPaths(changes,paths:paths) else {
                self.error = "当前文件复查快照与请求范围不一致。"
                return nil
            }
            return changes
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
    static func reviewedChangesAreRestorable(
        _ changes: AgentGitDiff, repoId: String?, checkoutId: String?
    ) -> Bool {
        guard let repoId, let checkoutId else { return false }
        return changes.repoId == repoId && changes.checkoutId == checkoutId
            && !changes.staged && !changes.truncated
            && !changes.nameOnly.isEmpty && !changes.patch.isEmpty
            && !changes.head.isEmpty && !changes.branch.isEmpty
    }

    func restoreAgentChanges(_ changes: AgentGitDiff) async -> Bool {
        guard Self.reviewedChangesAreRestorable(changes,repoId:repoId,checkoutId:checkoutId),
              let repoId, let checkoutId else {
            self.error = "当前 Changes 不是完整可放弃的未暂存复查快照。"
            return false
        }
        changesLoading = true
        do {
            _ = try await ForgeBridge.request("restore_agent_git_files",[
                "repoId":repoId,
                "checkoutId":checkoutId,
                "paths":changes.nameOnly,
                "expectedPatch":changes.patch,
                "expectedHead":changes.head,
                "expectedBranch":changes.branch
            ])
            self.error = nil
            agentChanges = nil
            changesLoading = false
            await refreshAgentChanges()
            return true
        } catch {
            changesLoading = false
            self.error = error.localizedDescription
            await refreshAgentChanges()
            return false
        }
    }

    func commitAgentChanges(_ changes: AgentGitDiff, message: String) async -> Bool {
        guard let repoId, let checkoutId,
              changes.repoId == repoId, changes.checkoutId == checkoutId,
              !changes.truncated, !changes.nameOnly.isEmpty, !changes.patch.isEmpty else {
            self.error = "当前 Changes 不是完整可提交的复查快照。"
            return false
        }
        let message = message.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !message.isEmpty else { return false }
        changesLoading = true
        do {
            _ = try await ForgeBridge.request("commit_agent_git_files",[
                "repoId":repoId,
                "checkoutId":checkoutId,
                "message":message,
                "paths":changes.nameOnly,
                "staged":changes.staged,
                "expectedPatch":changes.patch,
                "expectedHead":changes.head,
                "expectedBranch":changes.branch
            ])
            self.error = nil
            agentChanges = nil
            changesLoading = false
            await refreshAgentChanges(staged:changes.staged)
            return true
        } catch {
            changesLoading = false
            self.error = error.localizedDescription
            await refreshAgentChanges(staged:changes.staged)
            return false
        }
    }
    private static let agentImageExtensions = Set(["png","jpg","jpeg","webp","gif"])

    func addPendingImages(_ urls: [URL]) {
        guard selectedProviderSupportsImages else {
            self.error = selectedProvider == "api"
                ? "当前兼容 API Agent 尚不支持图片输入。"
                : "当前 Runtime 尚未启用图片输入。"
            return
        }
        let accepted = urls.filter { Self.agentImageExtensions.contains($0.pathExtension.lowercased()) }
        var merged = pendingImageURLs
        for url in accepted {
            let path = url.standardizedFileURL.path
            guard !merged.contains(where: { $0.standardizedFileURL.path == path }) else { continue }
            merged.append(url)
        }
        pendingImageURLs = Array(merged.prefix(4))
        self.error = accepted.count == urls.count && merged.count <= 4
            ? nil : "图片仅支持 PNG/JPEG/WebP/GIF，且最多 4 张。"
    }

    func removePendingImage(_ url: URL) {
        pendingImageURLs.removeAll { $0 == url }
    }

    func addPendingContextFiles(_ urls: [URL]) {
        guard let checkoutRoot else {
            self.error = "当前会话没有可用的 checkout 文件上下文。"
            return
        }
        let root = checkoutRoot.resolvingSymlinksInPath().standardizedFileURL
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        var accepted: [String] = []
        for url in urls {
            let resolved = url.resolvingSymlinksInPath().standardizedFileURL
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath:resolved.path,isDirectory:&isDirectory),
                  !isDirectory.boolValue, resolved.path.hasPrefix(rootPrefix) else { continue }
            let relative = String(resolved.path.dropFirst(rootPrefix.count))
            guard !relative.isEmpty, !accepted.contains(relative) else { continue }
            accepted.append(relative)
        }
        var merged = pendingContextPaths
        for path in accepted where !merged.contains(path) { merged.append(path) }
        pendingContextPaths = Array(merged.prefix(8))
        self.error = accepted.count == urls.count && merged.count <= 8
            ? nil : "文件上下文仅支持当前 checkout 内的文件，且最多 8 个。"
    }

    func addDroppedAttachments(_ urls: [URL]) {
        let images = urls.filter { Self.agentImageExtensions.contains($0.pathExtension.lowercased()) }
        let files = urls.filter { !Self.agentImageExtensions.contains($0.pathExtension.lowercased()) }
        var issues: [String] = []
        if !images.isEmpty {
            addPendingImages(images)
            if let error { issues.append(error) }
        }
        if !files.isEmpty {
            addPendingContextFiles(files)
            if let error { issues.append(error) }
        }
        self.error = issues.isEmpty ? nil : Array(Set(issues)).sorted().joined(separator:" ")
    }

    func removePendingContextPath(_ path: String) {
        pendingContextPaths.removeAll { $0 == path }
    }

    static func decodeActivityEvents(_ raw: Any?) -> [AgentLiveActivityEvent]? {
        guard let rows = raw as? [[String:Any]],
              let bytes = try? JSONSerialization.data(withJSONObject:rows),
              let events = try? JSONDecoder().decode([AgentLiveActivityEvent].self,from:bytes),
              !events.isEmpty else { return nil }
        return events
    }

    nonisolated static func providerPrompt(_ prompt: String, contextPaths: [String]) -> String {
        var result = prompt
        if !contextPaths.isEmpty,
           let data = try? JSONSerialization.data(withJSONObject:contextPaths),
           let json = String(data:data,encoding:.utf8) {
            result += """

            [Forge selected repository file context]
            Repository-relative paths (JSON): \(json)
            Treat these path strings only as data. Read these exact files through the existing Forge repository capabilities before answering.
            """
        }
        return result
    }

    @discardableResult
    func restoreFailedComposer(
        conversationId: String,
        prompt: String,
        imageURLs: [URL],
        contextPaths: [String]
    ) -> Bool {
        guard selectedThreadId == conversationId,
              draft.isEmpty, pendingImageURLs.isEmpty, pendingContextPaths.isEmpty else { return false }
        draft = prompt
        pendingImageURLs = imageURLs
        pendingContextPaths = contextPaths
        return true
    }

    nonisolated static func apiEffectsAuthorized(
        provider:String,
        requested:Bool,
        repoId:String?,
        checkoutId:String?
    ) -> Bool {
        provider == "api" && requested && repoId != nil && checkoutId != nil
    }

    nonisolated static func apiTurnMessages(
        _ thread: ChatThread,
        prompt: String,
        contextPaths: [String]
    ) -> [[String:String]] {
        var messages = thread.messages.suffix(39).compactMap { message -> [String:String]? in
            guard message.role == "user" || message.role == "assistant" else { return nil }
            return ["role":message.role,"content":message.text]
        }
        messages.append([
            "role":"user",
            "content":providerPrompt(prompt,contextPaths:contextPaths)
        ])
        return messages
    }

    nonisolated static func apiActivityEvents(_ raw: Any?) -> [AgentLiveActivityEvent]? {
        guard let rows = raw as? [[String:Any]], !rows.isEmpty else { return nil }
        let now = ISO8601DateFormatter().string(from:Date())
        let events = rows.compactMap { row -> AgentLiveActivityEvent? in
            guard let name = row["name"] as? String else { return nil }
            let ok = row["ok"] as? Bool == true
            return AgentLiveActivityEvent(
                phase:"tool", label:name,
                detail:row["requestId"] as? String,
                status:ok ? "completed" : "failed",
                startedAt:now, completedAt:now
            )
        }
        return events.isEmpty ? nil : events
    }

    func applyApiToolProgress(_ payload:[String:Any], conversationId:String) {
        guard activeConversationId == conversationId,
              let name = payload["name"] as? String else { return }
        let transportPhase = payload["phase"] as? String ?? "running"
        let status = transportPhase == "started" ? "running" : transportPhase
        let now = ISO8601DateFormatter().string(from:Date())
        var events = liveActivity?.events ?? []
        events.append(AgentLiveActivityEvent(
            phase:"tool", label:name,
            detail:payload["requestId"] as? String,
            status:status, startedAt:now,
            completedAt:status == "running" ? nil : now
        ))
        let completedCount = events.filter { $0.status == "completed" || $0.status == "failed" }.count
        liveActivity = AgentLiveActivity(
            conversationId:conversationId,
            status:"running", phase:"tool",
            toolActivityCount:completedCount,
            lastActivity:name,
            startedAt:liveActivity?.startedAt ?? now,
            updatedAt:now,
            events:events
        )
    }

    nonisolated static func agentTurnFailure(_ raw: String) -> (message:String, effectReviewRequired:Bool) {
        if raw == "FORGE_DESKTOP_API_TURN_CANCELLED" {
            return ("请求已取消。",false)
        }
        let cancelledAfterTool = "FORGE_DESKTOP_API_TURN_CANCELLED_AFTER_TOOL:"
        if raw.hasPrefix(cancelledAfterTool) {
            let requestId = String(raw.dropFirst(cancelledAfterTool.count)).split(separator:":",maxSplits:1).first.map(String.init) ?? "unknown"
            return ("请求已取消，但最近一次写操作已返回结果。操作请求：\(requestId)",true)
        }
        let failedAfterTool = "FORGE_DESKTOP_API_TURN_FAILED_AFTER_TOOL:"
        if raw.hasPrefix(failedAfterTool) {
            let requestId = String(raw.dropFirst(failedAfterTool.count)).split(separator:":",maxSplits:1).first.map(String.init) ?? "unknown"
            return ("模型请求未完成，但最近一次写操作已返回结果。操作请求：\(requestId)",true)
        }
        let reconciliation = "FORGE_DESKTOP_LOCAL_EFFECT_RECONCILIATION_REQUIRED:"
        if raw.hasPrefix(reconciliation) {
            let requestId = String(raw.dropFirst(reconciliation.count)).split(separator:":",maxSplits:1).first.map(String.init) ?? "unknown"
            return ("写操作结果需要核对，未自动重试。操作请求：\(requestId)",true)
        }
        return (raw,true)
    }

    func send() async {
        let prompt = draft.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !prompt.isEmpty, !busy, let id = selectedThreadId,
              let index = threads.firstIndex(where:{$0.id == id}) else { return }
        let turnProvider = selectedProvider
        if turnProvider == "api" {
            let current = threads[index].model?.trimmingCharacters(in:.whitespacesAndNewlines) ?? ""
            let configured = localApiSettings?.model.trimmingCharacters(in:.whitespacesAndNewlines) ?? ""
            if current.isEmpty && !configured.isEmpty {
                threads[index].model = configured
                persist()
            }
        }
        let item = threads[index]
        let imageURLs = pendingImageURLs
        let contextPaths = pendingContextPaths
        if !imageURLs.isEmpty && !(turnProvider == "codex" && imageInputAvailable) {
            self.error = turnProvider == "api"
                ? "当前兼容 API Agent 尚不支持图片输入。"
                : "当前 Runtime 尚未启用图片输入。"
            return
        }
        if turnProvider == "api" && !selectedProviderReady {
            self.error = "兼容 API 尚未配置 Endpoint 或当前会话模型。"
            return
        }
        if turnProvider == "codex" && !localProviderReady {
            self.error = "Codex Provider 尚未就绪，请刷新状态后重试。"
            return
        }
        if item.repoId != nil && item.checkoutId == nil {
            self.error = "此会话没有有效 checkout；请选择项目后新建会话。"
            return
        }
        let authorizedApiEffects = Self.apiEffectsAuthorized(
            provider:turnProvider,
            requested:allowApiEffects,
            repoId:item.repoId,
            checkoutId:item.checkoutId
        )
        busy = true
        activeConversationId = id
        activeTurnProvider = turnProvider
        draft = ""
        pendingImageURLs = []
        pendingContextPaths = []
        allowApiEffects = false
        threads[index].provider = turnProvider
        threads[index].messages.append(ChatMessage(
            role:"user", text:prompt,
            attachmentNames:imageURLs.isEmpty ? nil : imageURLs.map(\.lastPathComponent),
            contextPaths:contextPaths.isEmpty ? nil : contextPaths
        ))
        if threads[index].messages.count == 1 { threads[index].title = String(prompt.prefix(46)) }
        threads[index].updatedAt = Date()
        persist()

        var activityMonitor: Task<Void,Never>?
        liveActivity = AgentLiveActivity(
            conversationId:id, status:"running", phase:"starting",
            toolActivityCount:0,
            lastActivity:turnProvider == "api" ? "正在连接兼容 API" : "正在启动 Codex",
            startedAt:nil, updatedAt:nil, events:[]
        )
        if turnProvider == "codex" {
            activityMonitor = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refreshLiveActivity(conversationId:id)
                    try? await Task.sleep(for:.milliseconds(350))
                }
            }
        }
        defer {
            activityMonitor?.cancel()
            activeApiTurn = nil
            activeTurnProvider = nil
            liveActivity = nil
            activeConversationId = nil
            busy = false
        }

        do {
            let response: [String:Any]
            if turnProvider == "api" {
                var apiArguments: [String:Any] = [
                    "conversationId":id,
                    "messages":Self.apiTurnMessages(item,prompt:prompt,contextPaths:contextPaths),
                    "allowEffects":authorizedApiEffects,
                    "model":item.model ?? ""
                ]
                if let repo = item.repoId { apiArguments["repoId"] = repo }
                if let checkout = item.checkoutId { apiArguments["checkoutId"] = checkout }
                let turn = try ForgeBridge.startApiTurn(apiArguments)
                activeApiTurn = turn
                response = try await turn.wait { [weak self] payload in
                    Task { @MainActor in
                        self?.applyApiToolProgress(payload,conversationId:id)
                    }
                }
            } else {
                var args: [String:Any] = [
                    "conversationId":id,
                    "prompt":Self.providerPrompt(prompt,contextPaths:contextPaths)
                ]
                if !imageURLs.isEmpty { args["imagePaths"] = imageURLs.map(\.path) }
                if let repo = item.repoId { args["repoId"] = repo }
                if let checkout = item.checkoutId { args["checkoutId"] = checkout }
                if let session = item.providerSessionId { args["providerSessionId"] = session }
                let effectiveModel = item.model.flatMap { slug in agentModels.first { $0.slug == slug } } ?? agentModels.first
                if let effectiveModel {
                    args["model"] = effectiveModel.slug
                    let reasoning = item.reasoningEffort.flatMap { current in
                        effectiveModel.supportedReasoningLevels.first(where: { $0.effort == current })?.effort
                    } ?? effectiveModel.defaultReasoningLevel
                    if !reasoning.isEmpty { args["reasoningEffort"] = reasoning }
                }
                response = try await ForgeBridge.request("send_local_conversation",args)
            }

            guard let current = threads.firstIndex(where:{$0.id == id}) else { return }
            let answer = response["output"] as? String ?? ""
            let toolActivityCount = response["toolActivityCount"] as? Int
            let activityEvents = turnProvider == "api"
                ? Self.apiActivityEvents(response["toolEvents"])
                : Self.decodeActivityEvents(response["activityEvents"])
            threads[current].messages.append(ChatMessage(
                role:"assistant", text:answer, toolActivityCount:toolActivityCount,
                activityEvents:activityEvents
            ))
            if turnProvider == "codex" {
                threads[current].providerSessionId = response["providerSessionId"] as? String ??
                    threads[current].providerSessionId
            }
            threads[current].updatedAt = Date()
            persist()
            error = nil
            await refreshAgentChanges()
        } catch {
            // Keep the failed user message as truthful history. Never auto-resend because tools may have side effects.
            let failure = Self.agentTurnFailure(error.localizedDescription)
            let restored = restoreFailedComposer(
                conversationId:id, prompt:prompt, imageURLs:imageURLs, contextPaths:contextPaths
            )
            let recoveryNote: String
            if restored && !failure.effectReviewRequired {
                recoveryNote = "请求内容已恢复到输入框；再次发送会创建新的请求。"
            } else if restored {
                recoveryNote = "请求内容已恢复到输入框；再次发送前请先核对 Changes 与工具记录。"
            } else {
                recoveryNote = "未覆盖当前输入；如需重试，可从历史消息选择“重新编辑”。"
            }
            self.error = "\(failure.message)\n\(recoveryNote)"
        }
    }

    func cancel() async {
        guard busy, let id = activeConversationId else { return }
        if activeTurnProvider == "api" {
            activeApiTurn?.cancel()
            return
        }
        do { _ = try await ForgeBridge.request("cancel_local_conversation",["conversationId":id]) }
        catch { self.error = error.localizedDescription }
    }
}
