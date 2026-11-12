import SwiftUI
import AppKit

/// A projection of actual conversation attachments and explicit Markdown image
/// links. The conversation transcript remains the sole asset index authority.
struct AgentAssetsDashboard: View {
    @ObservedObject var model: NativeWorkspace
    @State private var selectedRepoId = ""
    @State private var showUserImages = true
    @State private var showRemoteImages = true

    private struct Resource: Identifiable {
        let id: String
        let title: String
        let threadTitle: String
        let threadId: String
        let date: Date
        let source: String
        let remote: Bool
    }

    private var resources: [Resource] {
        let threads = model.threads.filter { selectedRepoId.isEmpty || $0.repoId == selectedRepoId }
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .firstTextBaseline) {
                    Text("图片资源").font(.system(size: 24, weight: .semibold))
                    Spacer()
                    Picker("项目", selection: $selectedRepoId) {
                        Text("全部项目").tag("")
                        ForEach(model.projects) { project in
                            Text(project.displayName).tag(project.repoId)
                        }
                    }
                    .frame(maxWidth: 200)
                }

                HStack(spacing: 16) {
                    Label("\(resources.count) 个资源", systemImage: "photo.on.rectangle")
                        .font(.system(size: 12, weight: .medium))
                    Toggle("我的图片", isOn: $showUserImages)
                    Toggle("回复图片", isOn: $showRemoteImages)
                    Spacer()
                }
                .toggleStyle(.checkbox)
                .font(.system(size: 11.5))
                .padding(.bottom, 5)

                if resources.isEmpty {
                    VStack(spacing: 9) {
                        Image(systemName: "photo").font(.system(size: 28)).foregroundStyle(.tertiary)
                        Text("暂无图片").font(.system(size: 14, weight: .medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(resources) { item in
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
                                        model.selectThread(item.threadId)
                                    } label: {
                                        Label("来源会话", systemImage: "arrow.up.right")
                                    }
                                    .buttonStyle(.plain)
                                    .help(item.threadTitle)
                                }
                                if item.remote {
                                    AgentRemoteImageView(label: item.title, source: item.source, showsLabel: false)
                                } else {
                                    AgentLocalImageResourceView(path: item.source)
                                }
                            }
                            .padding(.vertical, 14)
                            Divider().opacity(0.4)
                        }
                    }
                }
            }
            .padding(26)
            .frame(maxWidth: 940, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .accessibilityIdentifier("agent.assets.dashboard")
    }
}

private struct AgentLocalImageResourceView: View {
    let path: String
    @State private var revealed = false
    @State private var status: String?

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
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                } label: {
                    Image(systemName: "folder")
                }
                .buttonStyle(.plain)
                .help("在 Finder 中显示")
                .accessibilityLabel("在 Finder 中显示")
                .disabled(!exists)
                Button("另存为…") { save() }.disabled(!exists)
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            if revealed, let image = NSImage(contentsOfFile: path) {
                Image(nsImage: image)
                    .resizable().scaledToFit().frame(maxWidth: 500, maxHeight: 300)
            }
            if let status {
                Text(status).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }

    @MainActor
    private func save() {
        guard exists else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: path).lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            let source = URL(fileURLWithPath: path)
            // Atomic Data write also supports replacing an existing destination
            // selected in NSSavePanel; no implicit deletion of unrelated files.
            try Data(contentsOf: source, options: .mappedIfSafe)
                .write(to: destination, options: .atomic)
            status = "已保存到 " + destination.lastPathComponent
        } catch {
            status = "保存失败：" + error.localizedDescription
        }
    }
}
