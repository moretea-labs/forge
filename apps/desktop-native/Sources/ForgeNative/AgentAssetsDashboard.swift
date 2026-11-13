import SwiftUI
import AppKit

/// A projection of actual conversation attachments and explicit Markdown image
/// links. The conversation transcript remains the sole asset index authority.
struct AgentAssetsDashboard: View {
    @ObservedObject var model: NativeWorkspace
    @State private var selectedRepoId = ""
    @State private var showUserImages = true
    @State private var showRemoteImages = true

    static func accessibilityIdentifier(for resourceID: String, control: String? = nil) -> String {
        let prefix = "agent.assets.resource.\(resourceID)"
        return control.map { "\(prefix).\($0)" } ?? prefix
    }

    struct Resource: Identifiable {
        let id: String
        let title: String
        let threadTitle: String
        let threadId: String
        let messageId: String
        let date: Date
        let source: String
        let remote: Bool
    }

    static func makeResources(
        from sourceThreads: [ChatThread],
        selectedRepoId: String,
        showUserImages: Bool,
        showRemoteImages: Bool
    ) -> [Resource] {
        let threads = sourceThreads.filter { selectedRepoId.isEmpty || $0.repoId == selectedRepoId }
        let items = threads.flatMap { thread -> [Resource] in
            thread.messages.flatMap { message -> [Resource] in
                var values: [Resource] = []
                if message.role == "assistant", showRemoteImages {
                    for (index, block) in AgentMessageBlock.parse(message.text).enumerated() {
                        if case .image(let label, let url) = block {
                            values.append(Resource(
                                id: "\(thread.id):\(message.id):remote:\(index)",
                                title: label.isEmpty ? "图片" : label,
                                threadTitle: thread.title,
                                threadId: thread.id,
                                messageId: message.id,
                                date: message.createdAt,
                                source: url,
                                remote: true
                            ))
                        }
                    }
                }
                if message.role == "user", showUserImages {
                    for (index, path) in (message.attachmentPaths ?? []).enumerated() {
                        values.append(Resource(
                            id: "\(thread.id):\(message.id):local:\(index)",
                            title: URL(fileURLWithPath: path).lastPathComponent,
                            threadTitle: thread.title,
                            threadId: thread.id,
                            messageId: message.id,
                            date: message.createdAt,
                            source: path,
                            remote: false
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
            selectedRepoId: selectedRepoId,
            showUserImages: showUserImages,
            showRemoteImages: showRemoteImages
        )
    }

    var body: some View {
        let items = resources
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 16) {
                    Label("\(items.count) 个资源", systemImage: "photo.on.rectangle")
                        .font(.system(size: 12, weight: .medium))
                    Toggle("我的图片", isOn: $showUserImages)
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
                        Image(systemName: "photo").font(.system(size: 28)).foregroundStyle(.tertiary)
                        Text("暂无图片").font(.system(size: 14, weight: .medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(items) { item in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 10) {
                                    Image(systemName: item.remote ? "network" : "photo")
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
                                if item.remote {
                                    AgentRemoteImageView(
                                        label: item.title,
                                        source: item.source,
                                        showsLabel: false,
                                        accessibilityIdentifierPrefix: Self.accessibilityIdentifier(for: item.id, control: "remote-image")
                                    )
                                } else {
                                    AgentLocalImageResourceView(
                                        path: item.source,
                                        accessibilityIdentifierPrefix: Self.accessibilityIdentifier(for: item.id, control: "local-image")
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
    @State private var previewLoading = false
    @State private var previewError: String?
    @State private var previewImage: NSImage?
    @State private var previewSource: String?

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
                    .disabled(!exists || previewLoading || isSaving)
                    .accessibilityIdentifier("\(accessibilityIdentifierPrefix).save")
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            if revealed {
                if let previewImage, exists, imagePreviewMatchesSource(previewSource, currentSource: path) {
                    Image(nsImage: previewImage)
                        .resizable().scaledToFit().frame(maxWidth: 500, maxHeight: 300)
                        .accessibilityLabel("本地图片：\(URL(fileURLWithPath: path).lastPathComponent)")
                } else if previewLoading || (previewError == nil && exists && !imagePreviewMatchesSource(previewSource, currentSource: path)) {
                    ProgressView().frame(height: 80)
                } else if let previewError {
                    Label("图片预览失败", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                        .help(previewError)
                }
            }
            if let status {
                Text(status).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
        .task(id: revealed ? path : nil) {
            guard revealed, exists else {
                previewImage = nil
                previewSource = nil
                previewError = nil
                previewLoading = false
                return
            }
            previewSource = nil
            previewLoading = true
            previewError = nil
            defer { if !Task.isCancelled { previewLoading = false } }
            do {
                try Task.checkCancellation()
                guard let thumbnail = try await makeLocalImageThumbnail(at: path) else {
                    previewError = "原图无法解码或格式不受支持"
                    return
                }
                try Task.checkCancellation()
                previewImage = NSImage(
                    cgImage: thumbnail,
                    size: NSSize(width: thumbnail.width, height: thumbnail.height)
                )
                previewSource = path
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                previewError = error.localizedDescription
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
