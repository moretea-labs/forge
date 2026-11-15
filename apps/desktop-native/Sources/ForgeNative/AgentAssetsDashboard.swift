import SwiftUI
import AppKit

/// A projection of actual conversation attachments and explicit Markdown image
/// links. The conversation transcript remains the sole asset index authority.
struct AgentAssetsDashboard: View {
    @ObservedObject var model: NativeWorkspace
    @State private var selectedRepoId = ""
    @State private var showLocalResources = true
    @State private var showRemoteImages = true

    static func accessibilityIdentifier(for resourceID: String, control: String? = nil) -> String {
        let prefix = "agent.assets.resource.\(resourceID)"
        return control.map { "\(prefix).\($0)" } ?? prefix
    }

    struct Resource: Identifiable {
        enum Kind: Equatable {
            case localImage
            case remoteImage
            case file
        }

        let id: String
        let title: String
        let threadTitle: String
        let threadId: String
        let repoId: String?
        let checkoutId: String?
        let messageId: String
        let date: Date
        let source: String
        let kind: Kind
        let localRoot: String?

        var remote: Bool { kind == .remoteImage }
    }

    static func makeResources(
        from sourceThreads: [ChatThread],
        projects: [ForgeProject],
        selectedRepoId: String,
        showLocalResources: Bool,
        showRemoteImages: Bool
    ) -> [Resource] {
        let threads = sourceThreads.filter { selectedRepoId.isEmpty || $0.repoId == selectedRepoId }
        let items = threads.flatMap { thread -> [Resource] in
            let localRoot: String?
            if let repoId = thread.repoId, let checkoutId = thread.checkoutId {
                localRoot = projects.first(where: { $0.repoId == repoId && $0.checkoutId == checkoutId })?.localRoot
            } else {
                localRoot = nil
            }
            return thread.messages.flatMap { message -> [Resource] in
                var values: [Resource] = []
                if message.role == "assistant", showRemoteImages {
                    for (index, block) in AgentMessageBlock.parse(message.text).enumerated() {
                        if case .image(let label, let url) = block {
                            values.append(Resource(
                                id: "\(thread.id):\(message.id):remote:\(index)",
                                title: label.isEmpty ? "图片" : label,
                                threadTitle: thread.title,
                                threadId: thread.id,
                                repoId: thread.repoId,
                                checkoutId: thread.checkoutId,
                                messageId: message.id,
                                date: message.createdAt,
                                source: url,
                                kind: .remoteImage,
                                localRoot: nil
                            ))
                        }
                    }
                }
                if message.role == "user", showLocalResources {
                    for (index, path) in (message.attachmentPaths ?? []).enumerated() {
                        values.append(Resource(
                            id: "\(thread.id):\(message.id):local:\(index)",
                            title: URL(fileURLWithPath: path).lastPathComponent,
                            threadTitle: thread.title,
                            threadId: thread.id,
                            repoId: thread.repoId,
                            checkoutId: thread.checkoutId,
                            messageId: message.id,
                            date: message.createdAt,
                            source: path,
                            kind: .localImage,
                            localRoot: nil
                        ))
                    }
                }
                if message.role == "user", showLocalResources {
                    for (index, path) in (message.contextPaths ?? []).enumerated() {
                        values.append(Resource(
                            id: "\(thread.id):\(message.id):file:\(index)",
                            title: URL(fileURLWithPath: path).lastPathComponent,
                            threadTitle: thread.title,
                            threadId: thread.id,
                            repoId: thread.repoId,
                            checkoutId: thread.checkoutId,
                            messageId: message.id,
                            date: message.createdAt,
                            source: path,
                            kind: .file,
                            localRoot: localRoot
                        ))
                    }
                }
                return values
            }
        }
        return items.sorted { $0.date > $1.date }
    }

    private var resources: [Resource] {
        Self.makeResources(
            from: model.threads,
            projects: model.projects,
            selectedRepoId: selectedRepoId,
            showLocalResources: showLocalResources,
            showRemoteImages: showRemoteImages
        )
    }

    var body: some View {
        let items = resources
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 16) {
                    Label("\(items.count) 个资源", systemImage: "square.stack.3d.up")
                        .font(.system(size: 12, weight: .medium))
                    Toggle("我的附件", isOn: $showLocalResources)
                        .accessibilityIdentifier("agent.assets.filter.local")
                    Toggle("回复图片", isOn: $showRemoteImages)
                        .accessibilityIdentifier("agent.assets.filter.remote")
                    Spacer(minLength: 8)
                    Picker("项目", selection: $selectedRepoId) {
                        Text("全部项目").tag("")
                        ForEach(model.projects) { project in
                            Text(project.label).tag(project.repoId)
                        }
                    }
                    .frame(maxWidth: 200)
                    .accessibilityIdentifier("agent.assets.project-filter")
                }
                .toggleStyle(.checkbox)
                .font(.system(size: 11.5))
                .padding(.bottom, 5)

                if items.isEmpty {
                    VStack(spacing: 9) {
                        Image(systemName: "square.stack.3d.up").font(.system(size: 28)).foregroundStyle(.tertiary)
                        Text("暂无资源").font(.system(size: 14, weight: .medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(items) { item in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 10) {
                                    Image(systemName: item.kind == .file ? "doc" : item.remote ? "network" : "photo")
                                        .foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(item.title).font(.system(size: 12, weight: .medium))
                                            .lineLimit(1)
                                        Text(item.date.formatted(.dateTime.year().month().day().hour().minute()))
                                            .font(.system(size: 10.5)).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button {
                                        model.selectThread(item.threadId, messageId: item.messageId)
                                    } label: {
                                        Label("来源会话", systemImage: "arrow.up.right")
                                    }
                                    .buttonStyle(.plain)
                                    .help(item.threadTitle)
                                    .accessibilityLabel("打开来源会话：\(item.threadTitle)")
                                    .accessibilityHint("切换到原始对话")
                                    .accessibilityIdentifier(Self.accessibilityIdentifier(for: item.id, control: "source-thread"))
                                }
                                switch item.kind {
                                case .remoteImage:
                                    AgentRemoteImageView(
                                        label: item.title,
                                        source: item.source,
                                        showsLabel: false,
                                        accessibilityIdentifierPrefix: Self.accessibilityIdentifier(for: item.id, control: "remote-image")
                                    )
                                case .localImage:
                                    AgentLocalImageResourceView(
                                        path: item.source,
                                        accessibilityIdentifierPrefix: Self.accessibilityIdentifier(for: item.id, control: "local-image")
                                    )
                                case .file:
                                    AgentLocalFileResourceView(
                                        model: model,
                                        repoId: item.repoId,
                                        checkoutId: item.checkoutId,
                                        relativePath: item.source,
                                        rootPath: item.localRoot,
                                        accessibilityIdentifierPrefix: Self.accessibilityIdentifier(for: item.id, control: "local-file")
                                    )
                                }
                            }
                            .padding(.vertical, 14)
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier(Self.accessibilityIdentifier(for: item.id))
                            Divider().opacity(0.4)
                        }
                    }
                }
            }
            .padding(26)
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .accessibilityIdentifier("agent.assets.dashboard")
    }
}

func copyLocalImageAtomically(from source: URL, to destination: URL) async throws {
    let copying = Task.detached(priority: .utility) {
        let data = try Data(contentsOf: source, options: .mappedIfSafe)
        try data.write(to: destination, options: .atomic)
    }
    try await copying.value
}

private struct AgentLocalImageResourceView: View {
    let path: String
    let accessibilityIdentifierPrefix: String
    @State private var revealed = false
    @State private var status: String?
    @State private var isSaving = false

    private var exists: Bool {
        FileManager.default.fileExists(atPath: path)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(exists ? "本地图片" : "原图已移动或删除")
                    .foregroundStyle(.secondary).font(.system(size: 11))
                Spacer()
                Button(revealed ? "收起" : "预览") { revealed.toggle() }
                    .disabled(!exists)
                    .accessibilityIdentifier("\(accessibilityIdentifierPrefix).preview")
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                } label: {
                    Image(systemName: "folder")
                }
                .buttonStyle(.plain)
                .help("在 Finder 中显示")
                .accessibilityLabel("在 Finder 中显示")
                .accessibilityIdentifier("\(accessibilityIdentifierPrefix).finder")
                .disabled(!exists)
                Button(isSaving ? "保存中…" : "另存为…") { save() }
                    .disabled(!exists || isSaving)
                    .accessibilityIdentifier("\(accessibilityIdentifierPrefix).save")
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            if revealed {
                AgentLocalImagePreview(
                    path: path,
                    accessibilityLabel: "本地图片：\(URL(fileURLWithPath: path).lastPathComponent)",
                    maxWidth: 500,
                    maxHeight: 300
                )
            }
            if let status {
                Text(status).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }

    @MainActor
    private func save() {
        guard exists, !isSaving else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: path).lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        let source = URL(fileURLWithPath: path)
        isSaving = true
        status = "正在保存…"
        Task {
            defer { isSaving = false }
            do {
                try await copyLocalImageAtomically(from: source, to: destination)
                status = "已保存到 " + destination.lastPathComponent
            } catch {
                status = "保存失败：" + error.localizedDescription
            }
        }
    }
}


func resolveLocalContextFileURL(rootPath: String?, relativePath: String) -> URL? {
    guard let rootPath, !rootPath.isEmpty,
          !relativePath.isEmpty, !relativePath.hasPrefix("/") else { return nil }
    let root = URL(fileURLWithPath: rootPath, isDirectory: true)
        .resolvingSymlinksInPath().standardizedFileURL
    var rootIsDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: root.path, isDirectory: &rootIsDirectory),
          rootIsDirectory.boolValue else { return nil }
    let candidate = root.appendingPathComponent(relativePath)
        .resolvingSymlinksInPath().standardizedFileURL
    let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
    guard candidate.path.hasPrefix(rootPrefix) else { return nil }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
          !isDirectory.boolValue else { return nil }
    return candidate
}

func copyLocalFile(from source: URL, to destination: URL) async throws {
    let copying = Task.detached(priority: .utility) {
        let temporary = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try FileManager.default.copyItem(at: source, to: temporary)
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
    }
    try await copying.value
}

private struct AgentLocalFileResourceView: View {
    @ObservedObject var model: NativeWorkspace
    let repoId: String?
    let checkoutId: String?
    let relativePath: String
    let rootPath: String?
    let accessibilityIdentifierPrefix: String
    @State private var resolvedRootPath: String?
    @State private var isResolving = false
    @State private var isSaving = false
    @State private var status: String?

    private var effectiveRootPath: String? {
        resolvedRootPath ?? rootPath
    }

    private var fileURL: URL? {
        resolveLocalContextFileURL(rootPath: effectiveRootPath, relativePath: relativePath)
    }

    private var canResolveCheckout: Bool {
        repoId != nil && checkoutId != nil
    }

    private var canOpen: Bool {
        fileURL != nil || canResolveCheckout
    }

    private var fileName: String {
        URL(fileURLWithPath: relativePath).lastPathComponent
    }

    private var sourceLabel: String {
        if isResolving { return "正在定位原 checkout…" }
        guard effectiveRootPath != nil else {
            return canResolveCheckout ? "按需定位原 checkout" : "原 checkout 不可用"
        }
        return fileURL == nil ? "原文件已移动或删除" : "本地文件"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(sourceLabel)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    open()
                } label: {
                    Label("打开",systemImage:"arrow.up.right.square")
                }
                .buttonStyle(.plain)
                .help("使用默认应用打开文件")
                .accessibilityLabel("打开文件：\(fileName)")
                .accessibilityHint("使用 macOS 默认应用打开此文件")
                .accessibilityIdentifier("\(accessibilityIdentifierPrefix).open")
                .disabled(!canOpen || isResolving || isSaving)
                Button {
                    reveal()
                } label: {
                    Image(systemName: "folder")
                }
                .buttonStyle(.plain)
                .help("在 Finder 中显示")
                .accessibilityLabel("在 Finder 中显示：\(fileName)")
                .accessibilityIdentifier("\(accessibilityIdentifierPrefix).finder")
                .disabled(!canOpen || isResolving || isSaving)
                Button(isSaving ? "保存中…" : "另存为…") { save() }
                    .disabled(!canOpen || isSaving || isResolving)
                    .accessibilityIdentifier("\(accessibilityIdentifierPrefix).save")
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            if let status {
                Text(status).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }

    @MainActor
    private func resolveSourceURL() async -> URL? {
        guard !isResolving else { return nil }
        if let fileURL { return fileURL }
        guard let repoId, let checkoutId else {
            status = "原 checkout 不可用"
            return nil
        }
        isResolving = true
        status = "正在定位原 checkout…"
        defer { isResolving = false }
        do {
            guard let root = try await model.resolveCheckoutRoot(
                repoId: repoId, checkoutId: checkoutId
            ) else {
                status = "原 checkout 不可用"
                return nil
            }
            resolvedRootPath = root.path
            guard let source = resolveLocalContextFileURL(
                rootPath: root.path, relativePath: relativePath
            ) else {
                status = "原文件已移动或删除"
                return nil
            }
            return source
        } catch {
            status = "无法定位原 checkout"
            return nil
        }
    }

    @MainActor
    private func open() {
        Task {
            guard let source = await resolveSourceURL() else { return }
            status = NSWorkspace.shared.open(source) ? "已使用默认应用打开" : "无法打开文件"
        }
    }

    @MainActor
    private func reveal() {
        Task {
            guard let source = await resolveSourceURL() else { return }
            NSWorkspace.shared.activateFileViewerSelecting([source])
        }
    }

    @MainActor
    private func save() {
        guard !isSaving, !isResolving else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            guard let source = await resolveSourceURL() else { return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = source.lastPathComponent
            guard panel.runModal() == .OK, let destination = panel.url else { return }
            status = "正在保存…"
            do {
                try await copyLocalFile(from: source, to: destination)
                status = "已保存到 " + destination.lastPathComponent
            } catch {
                status = "保存失败：" + error.localizedDescription
            }
        }
    }
}
