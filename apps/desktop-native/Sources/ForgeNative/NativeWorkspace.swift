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
struct ChatMessage: Codable, Identifiable {
    var id = UUID().uuidString
    let role: String
    let text: String
    var createdAt = Date()
}
struct ChatThread: Codable, Identifiable {
    var id = UUID().uuidString
    var title = "新会话"
    var repoId: String?
    var checkoutId: String?
    var providerSessionId: String?
    var messages: [ChatMessage] = []
    var updatedAt = Date()
}
struct ForgeRecord: Identifiable {
    let id: String
    let title: String
    let state: String
}
enum NativePage: String, CaseIterable, Identifiable {
    case agent = "会话", work = "Work", requirement = "Requirement", plan = "Plan",
         knowledge = "知识库", runtime = "Runtime", settings = "设置"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .agent: return "bubble.left.and.bubble.right"
        case .work: return "checkmark.square"
        case .requirement: return "doc.text"
        case .plan: return "list.bullet.rectangle"
        case .knowledge: return "books.vertical"
        case .runtime: return "waveform.path.ecg"
        case .settings: return "gearshape"
        }
    }
    var recordIdKey: String {
        switch self {
        case .work: return "workId"
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
    @Published var provider = "未检测"
    @Published var connection = "未检测"
    @Published var error: String?
    @Published var records: [ForgeRecord] = []
    @Published var selectedRecord: String?
    @Published var detail = ""
    @Published var knowledgeQuery = ""
    @Published var settings = ""
    let store: URL

    init(store: URL? = nil) {
        self.store = store ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ForgeNative/conversations.json")
        if let bytes = try? Data(contentsOf: self.store),
           let items = try? JSONDecoder().decode([ChatThread].self, from: bytes) {
            threads = Array(items.prefix(100))
            selectedThreadId = threads.first?.id
        }
        if threads.isEmpty { newThread() }
    }

    var project: ForgeProject? { projects.first { $0.repoId == repoId } }
    var thread: ChatThread? { threads.first { $0.id == selectedThreadId } }
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
    func newThread() {
        let item = ChatThread(repoId: repoId, checkoutId: checkoutId)
        threads.insert(item, at: 0)
        selectedThreadId = item.id
        page = .agent
        draft = ""
        persist()
    }
    func selectThread(_ id: String) { selectedThreadId = id; page = .agent; draft = "" }
    func deleteThread(_ id: String) {
        guard !busy || selectedThreadId != id else {
            self.error = "请先停止正在运行的会话。"
            return
        }
        threads.removeAll { $0.id == id }
        if selectedThreadId == id { selectedThreadId = threads.first?.id }
        if threads.isEmpty { newThread() } else { persist() }
    }
    func selectProject(_ id: String) {
        guard repoId != id else { return }
        repoId = id
        checkoutId = nil
        Task {
            await refreshProject()
            // New scope creates a new chat identity, never mutates old history.
            newThread()
        }
    }
    func show(_ page: NativePage) {
        self.page = page
        if page != .agent { Task { await loadPage() } }
    }

    func refresh() async {
        do {
            let result = try await ForgeBridge.request("read_projects")
            let rows = result["repositories"] as? [[String: Any]] ?? []
            let bytes = try JSONSerialization.data(withJSONObject: rows)
            projects = try JSONDecoder().decode([ForgeProject].self, from: bytes)
            if repoId == nil || !projects.contains(where: { $0.repoId == repoId }) {
                repoId = result["preferredRepoId"] as? String ?? projects.first?.repoId
            }
            let status = try? await ForgeBridge.request("read_local_provider_status")
            provider = status?["status"] as? String ?? "unavailable"
            let health = try? await ForgeBridge.request("read_connection_status")
            connection = health?["ready"] as? Bool == true ? "已连接" : "未就绪"
            await refreshProject()
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    func refreshProject() async {
        guard let repoId else { return }
        do {
            let result = try await ForgeBridge.request("read_project_repository", ["repoId":repoId])
            checkoutId = (result["repository"] as? [String: Any])?["activeCheckoutId"] as? String
            if page != .agent { await loadPage() }
        } catch { self.error = error.localizedDescription }
    }
    func loadPage() async {
        if page == .runtime {
            await loadRaw("read_recovery_status", [:])
            return
        }
        if page == .settings {
            do {
                let value = try await ForgeBridge.request("read_local_api_settings")
                let provider = value["provider"] as? String ?? "codex"
                let model = value["model"] as? String ?? "默认"
                settings = "Provider: \(provider)\nModel: \(model)\nKeychain API Key: \(value["hasKey"] as? Bool == true ? "已配置" : "未配置")"
            } catch { self.error = error.localizedDescription }
            return
        }
        guard let repoId, [.work,.requirement,.plan].contains(page) else { return }
        do {
            let action = page == .work ? "read_project_work_list" :
                page == .plan ? "read_project_plan_list" : "read_project_overview"
            let result = try await ForgeBridge.request(action, ["repoId":repoId])
            let data = result["data"] as? [String: Any] ?? result
            let rows: [[String: Any]]
            switch page {
            case .work: rows = data["works"] as? [[String:Any]] ?? data["activeWork"] as? [[String:Any]] ?? []
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
    static func prettyJSON(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let bytes = try? JSONSerialization.data(withJSONObject: value, options:[.prettyPrinted,.sortedKeys])
        else { return "" }
        return String(data:bytes,encoding:.utf8) ?? ""
    }
    func openRecord(_ id: String) async {
        guard let repoId else { return }
        selectedRecord = id
        let action = page == .work ? "read_work_detail" : page == .plan ? "read_plan_detail" : "read_requirement_detail"
        await loadRaw(action, ["repoId": repoId, page.recordIdKey:id])
    }
    func searchKnowledge() async {
        guard let repoId else { return }
        await loadRaw("read_project_knowledge",["repoId":repoId,"query":knowledgeQuery])
    }
    func send() async {
        let prompt = draft.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !prompt.isEmpty, !busy, let id = selectedThreadId,
              let index = threads.firstIndex(where:{$0.id == id}) else { return }
        let item = threads[index]
        if item.repoId != nil && item.checkoutId == nil {
            self.error = "此会话没有有效 checkout；请选择项目后新建会话。"
            return
        }
        busy = true
        draft = ""
        threads[index].messages.append(ChatMessage(role:"user",text:prompt))
        if threads[index].messages.count == 1 { threads[index].title = String(prompt.prefix(46)) }
        threads[index].updatedAt = Date()
        persist()
        var args: [String:Any] = ["conversationId":id,"prompt":prompt]
        if let repo = item.repoId { args["repoId"] = repo }
        if let checkout = item.checkoutId { args["checkoutId"] = checkout }
        if let session = item.providerSessionId { args["providerSessionId"] = session }
        defer { busy = false }
        do {
            let response = try await ForgeBridge.request("send_local_conversation",args)
            guard let current = threads.firstIndex(where:{$0.id == id}) else { return }
            let answer = response["output"] as? String ?? ""
            threads[current].messages.append(ChatMessage(role:"assistant",text:answer))
            threads[current].providerSessionId = response["providerSessionId"] as? String ??
                threads[current].providerSessionId
            threads[current].updatedAt = Date()
            persist()
            error = nil
        } catch {
            // Message retained, but no fabricated success or automatic retry.
            self.self.error = error.localizedDescription
        }
    }
    func cancel() async {
        guard busy, let id = selectedThreadId else { return }
        do { _ = try await ForgeBridge.request("cancel_local_conversation",["conversationId":id]) }
        catch { self.error = error.localizedDescription }
    }
}
