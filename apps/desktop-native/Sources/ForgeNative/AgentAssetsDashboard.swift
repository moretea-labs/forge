import AppKit
import QuickLook
import SwiftUI

/// A projection of actual conversation attachments and explicit Markdown image
/// links. The conversation transcript remains the sole asset index authority.
struct AgentAssetsDashboard: View {
  @ObservedObject var model: NativeWorkspace
  @Binding var selectedRepoId: String
  @Binding var showLocalResources: Bool
  @Binding var showRemoteImages: Bool
  @Binding var searchQuery: String
  @Binding var selectedResourceID: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var focusedResourceId: String?

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
    showRemoteImages: Bool,
    searchQuery: String = ""
  ) -> [Resource] {
    let threads = sourceThreads.filter { selectedRepoId.isEmpty || $0.repoId == selectedRepoId }
    let items = threads.flatMap { thread -> [Resource] in
      let localRoot: String?
      if let repoId = thread.repoId, let checkoutId = thread.checkoutId {
        localRoot =
          projects.first(where: { $0.repoId == repoId && $0.checkoutId == checkoutId })?.localRoot
      } else {
        localRoot = nil
      }
      return thread.messages.flatMap { message -> [Resource] in
        var values: [Resource] = []
        if message.role == "assistant", showRemoteImages {
          for (index, block) in AgentMessageBlock.parse(message.text).enumerated() {
            if case .image(let label, let url) = block {
              values.append(
                Resource(
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
            values.append(
              Resource(
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
            values.append(
              Resource(
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
    let needle = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    let matching =
      needle.isEmpty
      ? items
      : items.filter { item in
        item.title.localizedStandardContains(needle)
          || item.threadTitle.localizedStandardContains(needle)
          || item.source.localizedStandardContains(needle)
          || (item.repoId?.localizedStandardContains(needle) ?? false)
      }
    return matching.sorted { $0.date > $1.date }
  }

  private var resources: [Resource] {
    Self.makeResources(
      from: model.threads,
      projects: model.projects,
      selectedRepoId: selectedRepoId,
      showLocalResources: showLocalResources,
      showRemoteImages: showRemoteImages,
      searchQuery: searchQuery
    )
  }

  var body: some View {
    GeometryReader { geometry in
      let items = resources
      let compact = geometry.size.width < 740
      let chosen = items.first(where: { $0.id == focusedResourceId })

      VStack(spacing: 0) {
        let hasQuery = !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        resourceToolbar(count: items.count, compact: geometry.size.width < 640)

        if items.isEmpty {
          let filtered = hasQuery || !selectedRepoId.isEmpty || !showLocalResources || !showRemoteImages
          VStack(spacing: 10) {
            Image(systemName: "paperclip")
              .font(.system(size: 22, weight: .light))
              .foregroundStyle(.tertiary)
              .accessibilityHidden(true)
            Text(filtered ? "没有匹配的资源" : "暂无附件")
              .font(.system(size: 12.5, weight: .medium))
              .foregroundStyle(ForgePalette.secondary)
            if filtered {
              Button("清除筛选") {
                searchQuery = ""
                selectedRepoId = ""
                showLocalResources = true
                showRemoteImages = true
                focusedResourceId = nil
              }
              .buttonStyle(.plain)
              .font(ForgeClientDesign.Shell.control)
              .foregroundStyle(ForgePalette.accent)
              .accessibilityIdentifier("agent.assets.reset-filters")
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        } else if compact, let chosen {
          resourceDetail(chosen, compact: true)
            .id(chosen.id)
        } else {
          HStack(alignment: .top, spacing: 0) {
            resourceList(items: items, compact: compact)
              .frame(width: compact ? nil : min(300, max(240, geometry.size.width * 0.34)))
              .frame(maxWidth: compact ? .infinity : nil)
            if !compact, let preview = chosen ?? items.first {
              resourceDetail(preview, compact: false)
                .id(preview.id)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .onChange(of: searchQuery) { _ in
        // A filtered-out selection should not leave a blank preview.
        if !resources.contains(where: { $0.id == focusedResourceId }) {
          focusedResourceId = nil
        }
      }
      .onChange(of: selectedRepoId) { _ in
        if !resources.contains(where: { $0.id == focusedResourceId }) {
          focusedResourceId = nil
        }
      }
      .accessibilityIdentifier("agent.assets.dashboard")
    }
  }

  /// On a narrow work surface, filters belong in a plain toolbar row and
  /// search gets its own line instead of forcing 600pt of controls into 400pt.
  private func resourceToolbar(count: Int, compact: Bool) -> some View {
    Group {
      if compact {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 10) {
            resourceCount(count)
            Spacer(minLength: 8)
            resourceFilters
            resourceRepositoryMenu
          }
          resourceSearch
        }
      } else {
        HStack(spacing: 12) {
          resourceCount(count)
          resourceSearch.frame(maxWidth: 330)
          Spacer(minLength: 0)
          resourceFilters
          resourceRepositoryPicker
        }
      }
    }
    .padding(.horizontal, compact ? 12 : 14)
    .padding(.vertical, 6)
    .accessibilityIdentifier("agent.assets.toolbar")
  }

  private func resourceCount(_ count: Int) -> some View {
    Text("\(count) 项")
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(.secondary)
      .monospacedDigit()
  }

  private var resourceSearch: some View {
    HStack(spacing: 7) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
      TextField("搜索文件、图片或会话", text: $searchQuery)
        .textFieldStyle(.plain)
        .font(.system(size: 11.5))
        .accessibilityLabel("搜索资源")
        .accessibilityIdentifier("agent.assets.search")
      if !searchQuery.isEmpty {
        Button {
          searchQuery = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.tertiary)
        }
        .buttonStyle(.plain)
        .help("清除搜索")
        .accessibilityLabel("清除资源搜索")
      }
    }
    .forgeInspectorSearchSurface()
  }

  private var resourceFilters: some View {
    Menu {
      Toggle("我的附件", isOn: $showLocalResources)
        .accessibilityIdentifier("agent.assets.filter.local")
      Toggle("回复图片", isOn: $showRemoteImages)
        .accessibilityIdentifier("agent.assets.filter.remote")
    } label: {
      Image(systemName: "line.3.horizontal.decrease")
        .frame(width: 28, height: 28)
    }
    .menuStyle(.borderlessButton).menuIndicator(.hidden)
    .fixedSize()
    .help("筛选资源")
    .accessibilityLabel("筛选资源")
  }

  private var resourceRepositoryPicker: some View {
    Picker("代码仓库", selection: $selectedRepoId) {
      Text("全部仓库").tag("")
      ForEach(model.projects) { project in
        Text(project.label).tag(project.repoId)
      }
    }
    .labelsHidden()
    .frame(maxWidth: 160)
    .accessibilityIdentifier("agent.assets.project-filter")
  }

  private var resourceRepositoryMenu: some View {
    Menu {
      Button("全部仓库") { selectedRepoId = "" }
      ForEach(model.projects) { project in
        Button {
          selectedRepoId = project.repoId
        } label: {
          if selectedRepoId == project.repoId {
            Label(project.label, systemImage: "checkmark")
          } else {
            Text(project.label)
          }
        }
      }
    } label: {
      Label(
        model.projects.first(where: { $0.repoId == selectedRepoId })?.label ?? "全部仓库",
        systemImage: "folder"
      )
      .font(.system(size: 11))
      .lineLimit(1)
    }
    .menuStyle(.borderlessButton).menuIndicator(.hidden)
    .frame(maxWidth: 155)
    .accessibilityLabel("代码仓库筛选")
    .accessibilityIdentifier("agent.assets.project-filter")
  }

  private func resourceIcon(_ item: Resource) -> String {
    switch item.kind {
    case .remoteImage: return "photo"
    case .localImage: return "photo.on.rectangle"
    case .file: return "doc.text"
    }
  }

  private func resourceList(items: [Resource], compact: Bool) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 3) {
          ForEach(items) { item in
            let selected = !compact && item.id == (focusedResourceId ?? items.first?.id)
            Button {
              withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
                focusedResourceId = item.id
              }
            } label: {
              HStack(alignment: .center, spacing: 10) {
                Image(systemName: resourceIcon(item))
                  .font(.system(size: 13))
                  .foregroundStyle(.secondary)
                  .frame(width: 22)
                VStack(alignment: .leading, spacing: 4) {
                  Text(item.title)
                    .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                  Text(item.threadTitle)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
                if compact {
                  Image(systemName: "chevron.right")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                }
              }
              .padding(.horizontal, 10).padding(.vertical, 8)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(selected ? ForgePalette.selection : Color.clear)
            .accessibilityLabel("预览资源：\(item.title)")
            .accessibilityIdentifier(Self.accessibilityIdentifier(for: item.id))
            .id(item.id)
          }
        }
        .padding(.horizontal, 4).padding(.vertical, 4)
      }
      .scrollIndicators(.automatic)
      .onAppear {
        guard let target = selectedResourceID, items.contains(where: { $0.id == target }) else {
          return
        }
        focusedResourceId = target
        proxy.scrollTo(target, anchor: .center)
        selectedResourceID = nil
      }
    }
  }

  private func resourceDetail(_ item: Resource, compact: Bool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        if compact {
          Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
              focusedResourceId = nil
            }
          } label: {
            Image(systemName: "chevron.left")
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.plain)
          .help("返回资源列表")
          .accessibilityLabel("返回资源列表")
          .accessibilityIdentifier("agent.assets.back-to-list")
        }
        VStack(alignment: .leading, spacing: 4) {
          Text(item.title)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1).truncationMode(.middle)
          Text(item.date.formatted(.dateTime.year().month().day().hour().minute()))
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 6)
        Button {
          selectedResourceID = item.id
          model.selectThread(item.threadId, messageId: item.messageId)
        } label: {
          Label("来源会话", systemImage: "arrow.up.right")
            .font(.system(size: 10.5, weight: .medium))
        }
        .buttonStyle(.plain)
        .help(item.threadTitle)
        .accessibilityLabel("打开来源会话：\(item.threadTitle)")
        .accessibilityHint("切换到原始对话")
        .accessibilityIdentifier(
          Self.accessibilityIdentifier(for: item.id, control: "source-thread"))
      }
      .padding(.horizontal, 14).padding(.vertical, 10)

      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          switch item.kind {
          case .remoteImage:
            AgentRemoteImageView(
              label: item.title,
              source: item.source,
              showsLabel: false,
              accessibilityIdentifierPrefix: Self.accessibilityIdentifier(
                for: item.id, control: "remote-image")
            )
          case .localImage:
            AgentLocalImageResourceView(
              path: item.source,
              accessibilityIdentifierPrefix: Self.accessibilityIdentifier(
                for: item.id, control: "local-image")
            )
          case .file:
            AgentLocalFileResourceView(
              model: model,
              repoId: item.repoId,
              checkoutId: item.checkoutId,
              relativePath: item.source,
              rootPath: item.localRoot,
              accessibilityIdentifierPrefix: Self.accessibilityIdentifier(
                for: item.id, control: "local-file")
            )
          }
        }
        .padding(14)
        .frame(maxWidth: 720, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
      }
      .scrollIndicators(.automatic)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ForgePalette.canvas)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("agent.assets.preview")
  }

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
        try await copyLocalFileAtomically(from: source, to: destination)
        status = "已保存到 " + destination.lastPathComponent
      } catch {
        status = "保存失败：" + error.localizedDescription
      }
    }
  }
}

func resolveLocalContextFileURL(rootPath: String?, relativePath: String) -> URL? {
  guard let rootPath, !rootPath.isEmpty,
    !relativePath.isEmpty, !relativePath.hasPrefix("/")
  else { return nil }
  let root = URL(fileURLWithPath: rootPath, isDirectory: true)
    .resolvingSymlinksInPath().standardizedFileURL
  var rootIsDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: root.path, isDirectory: &rootIsDirectory),
    rootIsDirectory.boolValue
  else { return nil }
  let candidate = root.appendingPathComponent(relativePath)
    .resolvingSymlinksInPath().standardizedFileURL
  let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
  guard candidate.path.hasPrefix(rootPrefix) else { return nil }
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
    !isDirectory.boolValue
  else { return nil }
  return candidate
}

func copyLocalFileAtomically(from source: URL, to destination: URL) async throws {
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
  @State private var previewURL: URL?
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
          preview()
        } label: {
          Label("预览", systemImage: "eye")
        }
        .buttonStyle(.plain)
        .help("使用 Quick Look 预览文件")
        .accessibilityLabel("预览文件：\(fileName)")
        .accessibilityHint("使用 macOS 快速查看")
        .accessibilityIdentifier("\(accessibilityIdentifierPrefix).preview")
        .disabled(!canOpen || isResolving || isSaving)
        Button {
          open()
        } label: {
          Label("打开", systemImage: "arrow.up.right.square")
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
    .quickLookPreview($previewURL)
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
      guard
        let root = try await model.resolveCheckoutRoot(
          repoId: repoId, checkoutId: checkoutId
        )
      else {
        status = "原 checkout 不可用"
        return nil
      }
      resolvedRootPath = root.path
      guard
        let source = resolveLocalContextFileURL(
          rootPath: root.path, relativePath: relativePath
        )
      else {
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
  private func preview() {
    Task {
      guard let source = await resolveSourceURL() else { return }
      previewURL = source
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
        try await copyLocalFileAtomically(from: source, to: destination)
        status = "已保存到 " + destination.lastPathComponent
      } catch {
        status = "保存失败：" + error.localizedDescription
      }
    }
  }
}
