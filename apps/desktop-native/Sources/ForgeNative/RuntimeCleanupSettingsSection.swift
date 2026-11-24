import Foundation
import SwiftUI

struct RuntimeCleanupCandidate: Identifiable {
  let kind: String
  let candidateID: String?
  let path: String?
  let reason: String
  let ageMinutes: Int?
  let occupiedByPid: Int?
  let safe: Bool
  let logicalBytes: Int64?
  let sizeTruncated: Bool

  var id: String { "\(kind):\(candidateID ?? path ?? reason)" }

  var displayName: String {
    if let candidateID, !candidateID.isEmpty { return candidateID }
    if let path, !path.isEmpty { return URL(fileURLWithPath: path).lastPathComponent }
    return "未知项目"
  }

  var kindLabel: String {
    switch kind {
    case "temp_dir": return "临时目录"
    case "local_job": return "Local Job"
    case "legacy_run": return "Legacy Run"
    case "attention_marker": return "历史 Attention"
    default: return "Runtime 项目"
    }
  }

  init?(value: [String: Any]) {
    guard let kind = value["kind"] as? String,
      let reason = value["reason"] as? String,
      let safe = value["safe"] as? Bool
    else { return nil }
    self.kind = kind
    self.candidateID = value["id"] as? String
    self.path = value["path"] as? String
    self.reason = reason
    self.ageMinutes = value["ageMinutes"] as? Int
    self.occupiedByPid = value["occupiedByPid"] as? Int
    self.safe = safe
    self.logicalBytes = (value["logicalBytes"] as? NSNumber)?.int64Value
    self.sizeTruncated = value["sizeTruncated"] as? Bool ?? false
  }
}

struct RuntimeCleanupSummary {
  let total: Int
  let safe: Int
  let unsafe: Int
  let tempDirs: Int
  let localJobs: Int
  let legacyRuns: Int
  let attentionMarkers: Int
  let logicalBytes: Int64
  let logicalBytesTruncated: Bool

  init(value: [String: Any]) {
    total = value["total"] as? Int ?? 0
    safe = value["safe"] as? Int ?? 0
    unsafe = value["unsafe"] as? Int ?? 0
    tempDirs = value["tempDirs"] as? Int ?? 0
    localJobs = value["localJobs"] as? Int ?? 0
    legacyRuns = value["legacyRuns"] as? Int ?? 0
    attentionMarkers = value["attentionMarkers"] as? Int ?? 0
    logicalBytes = (value["logicalBytes"] as? NSNumber)?.int64Value ?? 0
    logicalBytesTruncated = value["logicalBytesTruncated"] as? Bool ?? false
  }
}

struct RuntimeCleanupFilesystemSnapshot: Identifiable {
  let label: String
  let deviceId: String
  let totalBytes: Int64
  let freeBytes: Int64
  let availableBytes: Int64

  var id: String { deviceId }
  var displayLabel: String { label == "temporary" ? "临时目录磁盘" : "项目磁盘" }

  init?(value: [String: Any]) {
    guard let label = value["label"] as? String,
      let deviceId = value["deviceId"] as? String,
      let totalBytes = (value["totalBytes"] as? NSNumber)?.int64Value,
      let freeBytes = (value["freeBytes"] as? NSNumber)?.int64Value,
      let availableBytes = (value["availableBytes"] as? NSNumber)?.int64Value
    else { return nil }
    self.label = label
    self.deviceId = deviceId
    self.totalBytes = totalBytes
    self.freeBytes = freeBytes
    self.availableBytes = availableBytes
  }
}

struct RuntimeCleanupFilesystemDelta: Identifiable {
  let label: String
  let deviceId: String
  let beforeAvailableBytes: Int64
  let afterAvailableBytes: Int64
  let deltaAvailableBytes: Int64

  var id: String { deviceId }
  var displayLabel: String { label == "temporary" ? "临时目录磁盘" : "项目磁盘" }

  init?(value: [String: Any]) {
    guard let label = value["label"] as? String,
      let deviceId = value["deviceId"] as? String,
      let before = (value["beforeAvailableBytes"] as? NSNumber)?.int64Value,
      let after = (value["afterAvailableBytes"] as? NSNumber)?.int64Value,
      let delta = (value["deltaAvailableBytes"] as? NSNumber)?.int64Value
    else { return nil }
    self.label = label
    self.deviceId = deviceId
    self.beforeAvailableBytes = before
    self.afterAvailableBytes = after
    self.deltaAvailableBytes = delta
  }
}

struct RuntimeCleanupPreview {
  let generatedAt: String
  let summary: RuntimeCleanupSummary
  let candidates: [RuntimeCleanupCandidate]
  let warnings: [String]
  let truncated: Bool
  let filesystems: [RuntimeCleanupFilesystemSnapshot]

  init?(value: [String: Any]) {
    guard let generatedAt = value["generatedAt"] as? String,
      let summary = value["summary"] as? [String: Any],
      let rows = value["candidates"] as? [[String: Any]]
    else { return nil }
    self.generatedAt = generatedAt
    self.summary = RuntimeCleanupSummary(value: summary)
    self.candidates = rows.compactMap(RuntimeCleanupCandidate.init)
    self.warnings = value["warnings"] as? [String] ?? []
    self.truncated = (value["truncated"] as? [String: Any])?["candidates"] as? Bool == true
    self.filesystems = (value["filesystems"] as? [[String: Any]] ?? []).compactMap(
      RuntimeCleanupFilesystemSnapshot.init)
  }
}

struct RuntimeCleanupAppliedCandidate: Identifiable {
  let candidate: RuntimeCleanupCandidate
  let applied: Bool
  let error: String?

  var id: String { candidate.id }

  init?(value: [String: Any]) {
    guard let candidate = RuntimeCleanupCandidate(value: value),
      let applied = value["applied"] as? Bool
    else { return nil }
    self.candidate = candidate
    self.applied = applied
    self.error = value["error"] as? String
  }
}

struct RuntimeCleanupApplyResult {
  let attempted: Int
  let removed: Int
  let failed: Int
  let items: [RuntimeCleanupAppliedCandidate]
  let warnings: [String]
  let filesystemBefore: [RuntimeCleanupFilesystemSnapshot]
  let filesystemAfter: [RuntimeCleanupFilesystemSnapshot]
  let availableBytesDelta: [RuntimeCleanupFilesystemDelta]

  init?(value: [String: Any]) {
    guard value["mode"] as? String == "apply",
      let cycle = value["cycle"] as? [String: Any],
      let rows = value["applied"] as? [[String: Any]]
    else { return nil }
    self.attempted = cycle["attempted"] as? Int ?? rows.count
    self.removed = cycle["removed"] as? Int ?? rows.filter { $0["applied"] as? Bool == true }.count
    self.failed = cycle["failed"] as? Int ?? rows.filter { $0["error"] != nil }.count
    self.items = rows.compactMap(RuntimeCleanupAppliedCandidate.init)
    self.warnings = value["warnings"] as? [String] ?? []
    self.filesystemBefore = (value["filesystemBefore"] as? [[String: Any]] ?? []).compactMap(
      RuntimeCleanupFilesystemSnapshot.init)
    self.filesystemAfter = (value["filesystemAfter"] as? [[String: Any]] ?? []).compactMap(
      RuntimeCleanupFilesystemSnapshot.init)
    self.availableBytesDelta = (value["availableBytesDelta"] as? [[String: Any]] ?? []).compactMap(
      RuntimeCleanupFilesystemDelta.init)
  }
}

struct RuntimeCleanupSettingsSection: View {
  @ObservedObject var model: NativeWorkspace

  @SceneStorage("forge.storage.cleanup.process-id") private var storedProcessId = ""
  @SceneStorage("forge.storage.cleanup.process-repo") private var storedRepoId = ""
  @SceneStorage("forge.storage.cleanup.process-action") private var storedAction = ""
  @SceneStorage("forge.storage.cleanup.request-id") private var storedRequestId = ""

  @State private var minAgeMinutes = 60
  @State private var includeTempDirs = true
  @State private var includeTerminalLocalJobs = false
  @State private var includeLegacyRuns = false
  @State private var includeHistoricalAttention = false
  @State private var preview: RuntimeCleanupPreview?
  @State private var previewRepoId: String?
  @State private var previewAt: Date?
  @State private var applyResult: RuntimeCleanupApplyResult?
  @State private var isPreviewing = false
  @State private var isApplying = false
  @State private var isWaiting = false
  @State private var confirmationPresented = false
  @State private var processStatus: String?
  @State private var errorMessage: String?

  private var hasPendingProcess: Bool { !storedProcessId.isEmpty }
  private var hasPendingRequest: Bool { !storedRequestId.isEmpty }
  private var hasPendingWork: Bool { hasPendingProcess || hasPendingRequest }

  private var canUseWorkspace: Bool {
    model.repoId != nil && model.checkoutIsAvailable
  }

  private var previewIsFresh: Bool {
    guard preview != nil,
      previewRepoId == model.repoId,
      let previewAt
    else { return false }
    return Date().timeIntervalSince(previewAt) <= 120
  }

  private var canApply: Bool {
    guard canUseWorkspace,
      previewIsFresh,
      (preview?.summary.safe ?? 0) > 0,
      !hasPendingProcess,
      !isPreviewing,
      !isApplying
    else { return false }
    if !storedRequestId.isEmpty && storedRepoId != model.repoId { return false }
    return true
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text("存储与清理")
          .font(.system(size: 15, weight: .semibold))
        Text("仅展示 Runtime 自己确认的候选。清理前会重新扫描并再次检查所有权与活动进程。")
          .font(.system(size: 10.5))
          .foregroundStyle(ForgePalette.secondary)
      }

      if !canUseWorkspace {
        Text("请先选择项目和可用工作区，再扫描 Runtime 暂存。")
          .font(.system(size: 11))
          .foregroundStyle(ForgePalette.secondary)
      } else {
        cleanupOptions
        HStack(spacing: 9) {
          Button(isPreviewing ? "扫描中…" : "预览候选") {
            Task { await requestPreview() }
          }
          .buttonStyle(.bordered)
          .disabled(isPreviewing || isApplying || hasPendingWork)
          .accessibilityIdentifier("settings.storage.preview")

          Button(storedRequestId.isEmpty ? "清理安全项" : "重试同一请求") {
            confirmationPresented = true
          }
          .buttonStyle(.borderedProminent)
          .disabled(!canApply)
          .accessibilityIdentifier("settings.storage.apply")

          Spacer()
          if previewIsFresh {
            Text("预览有效")
              .font(.system(size: 10))
              .foregroundStyle(ForgePalette.secondary)
          } else if preview != nil {
            Text("预览已过期")
              .font(.system(size: 10))
              .foregroundStyle(Color.orange)
          }
        }

        if let preview {
          previewSummary(preview)
        }

        if let applyResult {
          applySummary(applyResult)
        }

        if hasPendingRequest && !hasPendingProcess {
          Text(processStatus ?? "清理请求尚未确认；重试会复用同一 request_id。")
            .font(.system(size: 10))
            .foregroundStyle(Color.orange)
        }

        if hasPendingProcess {
          HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
              Text(storedAction == "apply" ? "清理进程仍有结果待读取" : "扫描进程仍有结果待读取")
                .font(.system(size: 11, weight: .medium))
              Text(processStatus ?? "进程 \(storedProcessId)")
                .font(.system(size: 10))
                .foregroundStyle(ForgePalette.secondary)
                .lineLimit(2)
            }
            Spacer()
            Button(isWaiting ? "读取中…" : "读取结果") {
              Task { await readProcessResult() }
            }
            .buttonStyle(.forgeText)
            .disabled(isWaiting)
            .accessibilityIdentifier("settings.storage.process.read")
          }
          .padding(.vertical, 6)
        }
      }

      if let errorMessage {
        Text(errorMessage)
          .font(.system(size: 10.5))
          .foregroundStyle(Color.orange)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }

      Divider().opacity(0.5)
      Text(
        "逻辑大小是最多 12,000 个目录项的有界扫描，截断时仅代表下限；可用空间变化由 Runtime 在清理前后读取 statfs，可能受其他系统活动影响。此入口只处理 Runtime 已登记的临时目录、已终止 Local Job、Legacy Run 与历史 Attention；项目构建缓存、SQLite、Git Worktree 和有效证据仍由各自 Owner 管理。"
      )
      .font(.system(size: 10))
      .foregroundStyle(.tertiary)
      .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 10)
    .onChange(of: model.repoId) { _ in invalidatePreview() }
    .onChange(of: minAgeMinutes) { _ in invalidatePreview() }
    .onChange(of: includeTempDirs) { _ in invalidatePreview() }
    .onChange(of: includeTerminalLocalJobs) { _ in invalidatePreview() }
    .onChange(of: includeLegacyRuns) { _ in invalidatePreview() }
    .onChange(of: includeHistoricalAttention) { _ in invalidatePreview() }
    .confirmationDialog(
      "清理 \(preview?.summary.safe ?? 0) 个 Runtime 安全候选？",
      isPresented: $confirmationPresented,
      titleVisibility: .visible
    ) {
      Button("清理安全项", role: .destructive) {
        Task { await submitCleanup() }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text(
        "Runtime 会按当前筛选重新扫描，只处理它再次判定为安全的候选。不会传入任意路径，也不会清理构建缓存、SQLite 或 Git Worktree。历史 Attention 只写入确认记录。"
      )
    }
  }

  private var cleanupOptions: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 18) {
        Toggle("Forge 临时目录", isOn: $includeTempDirs)
          .accessibilityIdentifier("settings.storage.include-temp")
        Toggle("已终止 Local Jobs", isOn: $includeTerminalLocalJobs)
          .accessibilityIdentifier("settings.storage.include-local-jobs")
      }
      HStack(spacing: 18) {
        Toggle("Legacy Runs", isOn: $includeLegacyRuns)
          .accessibilityIdentifier("settings.storage.include-legacy-runs")
        Toggle("历史 Attention（确认记录）", isOn: $includeHistoricalAttention)
          .accessibilityIdentifier("settings.storage.include-attention")
      }
      .toggleStyle(.checkbox)
      HStack(spacing: 10) {
        Text("最小保留时间")
          .font(.system(size: 10.5))
          .foregroundStyle(ForgePalette.secondary)
        Stepper("\(minAgeMinutes / 60) 小时", value: $minAgeMinutes, in: 60...10_080, step: 60)
          .font(.system(size: 10.5))
          .fixedSize()
          .accessibilityIdentifier("settings.storage.minimum-age")
        Spacer()
        Text("最多扫描 100 项")
          .font(.system(size: 10))
          .foregroundStyle(.tertiary)
      }
    }
    .font(.system(size: 10.5))
    .toggleStyle(.checkbox)
    .disabled(isPreviewing || isApplying || hasPendingWork)
  }

  private func previewSummary(_ value: RuntimeCleanupPreview) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 14) {
        summaryMetric("候选", value.summary.total)
        summaryMetric("安全", value.summary.safe)
        summaryMetric("保护", value.summary.unsafe)
        Spacer()
        Text(value.generatedAt)
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
      HStack(spacing: 12) {
        Text("临时目录 \(value.summary.tempDirs)")
        Text("Local Jobs \(value.summary.localJobs)")
        Text("Legacy Runs \(value.summary.legacyRuns)")
        Text("Attention \(value.summary.attentionMarkers)")
      }
      .font(.system(size: 9.5))
      .foregroundStyle(ForgePalette.secondary)
      HStack(spacing: 12) {
        Text(
          "逻辑大小 \(value.summary.logicalBytesTruncated ? "≥ " : "")\(formatBytes(value.summary.logicalBytes))"
        )
        ForEach(value.filesystems) { filesystem in
          Text("\(filesystem.displayLabel) 可用 \(formatBytes(filesystem.availableBytes))")
        }
      }
      .font(.system(size: 9.5))
      .foregroundStyle(ForgePalette.secondary)

      if value.truncated {
        Text("候选数量达到扫描上限；当前列表不完整。清理时 Runtime 仍会重新扫描并应用自己的预算。")
          .font(.system(size: 10))
          .foregroundStyle(Color.orange)
      }

      if value.candidates.isEmpty {
        Text("当前筛选条件下没有 Runtime 清理候选。")
          .font(.system(size: 10.5))
          .foregroundStyle(ForgePalette.secondary)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(value.candidates.prefix(20))) { candidate in
            candidateRow(candidate)
            Divider().opacity(0.35)
          }
        }
      }

      if value.candidates.count > 20 {
        Text("当前列表仅展示前 20 项；清理时 Runtime 仍会重新扫描并按自身预算处理。")
          .font(.system(size: 9.5))
          .foregroundStyle(.tertiary)
      }
      ForEach(Array(value.warnings.prefix(2).enumerated()), id: \.offset) { entry in
        Text(entry.element)
          .font(.system(size: 9.5))
          .foregroundStyle(.tertiary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.top, 4)
    .accessibilityIdentifier("settings.storage.preview-result")
  }

  private func candidateRow(_ candidate: RuntimeCleanupCandidate) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 7) {
        Text(candidate.kindLabel)
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(ForgePalette.secondary)
        Text(candidate.displayName)
          .font(.system(size: 10.5, design: .monospaced))
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: 6)
        Text(candidate.safe ? "可清理" : "保留")
          .font(.system(size: 9.5, weight: .medium))
          .foregroundStyle(candidate.safe ? Color.green : Color.orange)
      }
      Text(candidate.reason)
        .font(.system(size: 9.5))
        .foregroundStyle(ForgePalette.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 9) {
        if let age = candidate.ageMinutes {
          Text(age < 60 ? "年龄 \(age) 分钟" : "年龄 \(age / 60) 小时")
        }
        if let logicalBytes = candidate.logicalBytes {
          Text("逻辑 \(candidate.sizeTruncated ? "≥ " : "")\(formatBytes(logicalBytes))")
        }
        if let pid = candidate.occupiedByPid {
          Text("占用 PID \(pid)")
        }
      }
      .font(.system(size: 9))
      .foregroundStyle(.tertiary)
    }
    .padding(.vertical, 7)
    .accessibilityElement(children: .combine)
  }

  private func applySummary(_ value: RuntimeCleanupApplyResult) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 12) {
        Text("清理结果")
          .font(.system(size: 11, weight: .semibold))
        summaryMetric("尝试", value.attempted)
        summaryMetric("移除", value.removed)
        summaryMetric("失败", value.failed)
      }
      ForEach(value.items.filter { !$0.applied || $0.error != nil }) { item in
        HStack(alignment: .top, spacing: 7) {
          Text(item.candidate.displayName)
            .font(.system(size: 9.5, design: .monospaced))
            .lineLimit(1)
          Text(item.error ?? "未移除")
            .font(.system(size: 9.5))
            .foregroundStyle(Color.orange)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if value.availableBytesDelta.isEmpty {
        Text("未能读取清理前后的磁盘可用空间变化。")
          .font(.system(size: 9.5))
          .foregroundStyle(.tertiary)
      } else {
        ForEach(value.availableBytesDelta) { delta in
          Text(
            "\(delta.displayLabel) 可用空间变化 \(delta.deltaAvailableBytes >= 0 ? "+" : "")\(formatBytes(delta.deltaAvailableBytes))"
          )
          .font(.system(size: 9.5))
          .foregroundStyle(ForgePalette.secondary)
        }
      }
      ForEach(Array(value.warnings.prefix(2).enumerated()), id: \.offset) { entry in
        Text(entry.element)
          .font(.system(size: 9.5))
          .foregroundStyle(.tertiary)
      }
    }
    .padding(.top, 5)
    .accessibilityIdentifier("settings.storage.apply-result")
  }

  private func formatBytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
  }

  private func summaryMetric(_ title: String, _ value: Int) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.system(size: 9)).foregroundStyle(.tertiary)
      Text("\(value)").font(.system(size: 12, weight: .semibold).monospacedDigit())
    }
  }

  private func optionsArguments(repoId: String) -> [String: Any] {
    [
      "repoId": repoId,
      "minAgeMinutes": minAgeMinutes,
      "includeTempDirs": includeTempDirs,
      "includeTerminalLocalJobs": includeTerminalLocalJobs,
      "includeLegacyRuns": includeLegacyRuns,
      "includeHistoricalAttention": includeHistoricalAttention,
      "maxCandidates": 100,
    ]
  }

  private func requestPreview() async {
    guard let repoId = model.repoId, model.checkoutIsAvailable,
      !hasPendingWork, !isPreviewing
    else { return }
    isPreviewing = true
    errorMessage = nil
    preview = nil
    previewAt = nil
    previewRepoId = nil
    applyResult = nil
    storedRequestId = ""
    storedRepoId = repoId
    storedAction = "preview"
    processStatus = "Runtime 正在扫描候选…"
    defer { isPreviewing = false }

    do {
      var arguments = optionsArguments(repoId: repoId)
      arguments["applyMode"] = "async"
      arguments["interactiveWaitMs"] = 0
      let response = try await ForgeBridge.request("runtime_cleanup_preview", arguments)
      if let processId = response["processId"] as? String {
        storedProcessId = processId
        await readProcessResult()
      } else if let parsed = RuntimeCleanupPreview(value: response) {
        preview = parsed
        previewRepoId = repoId
        previewAt = Date()
        storedAction = ""
        storedRepoId = ""
        processStatus = nil
      } else {
        throw ForgeBridgeError.invalidResponse
      }
    } catch {
      errorMessage = error.localizedDescription
      storedAction = ""
      storedRepoId = ""
      processStatus = nil
    }
  }

  private func submitCleanup() async {
    guard let repoId = model.repoId, canApply else { return }
    isApplying = true
    errorMessage = nil
    if storedRequestId.isEmpty {
      storedRequestId = "native-cleanup-\(UUID().uuidString)"
    }
    storedRepoId = repoId
    storedAction = "apply"
    processStatus = "Runtime 正在提交清理请求…"
    defer { isApplying = false }

    do {
      var arguments = optionsArguments(repoId: repoId)
      arguments["confirmCleanup"] = true
      arguments["requestId"] = storedRequestId
      arguments["applyMode"] = "async"
      arguments["interactiveWaitMs"] = 0
      let response = try await ForgeBridge.request("runtime_cleanup_apply", arguments)
      if let processId = response["processId"] as? String {
        storedProcessId = processId
        await readProcessResult()
      } else if let parsed = RuntimeCleanupApplyResult(value: response) {
        applyResult = parsed
        preview = nil
        previewAt = nil
        previewRepoId = nil
        storedRequestId = ""
        storedRepoId = ""
        storedAction = ""
        processStatus = nil
      } else {
        throw ForgeBridgeError.invalidResponse
      }
    } catch {
      // Keep the same request ID so a retry cannot create a second cleanup.
      errorMessage = error.localizedDescription
      processStatus = "请求未确认；重试会复用同一 request_id。"
    }
  }

  private func readProcessResult() async {
    guard !storedProcessId.isEmpty, !storedRepoId.isEmpty, !isWaiting else { return }
    isWaiting = true
    errorMessage = nil
    defer { isWaiting = false }

    do {
      let response = try await ForgeBridge.request(
        "runtime_process_wait",
        [
          "repoId": storedRepoId,
          "processId": storedProcessId,
          "timeoutMs": 5_000,
        ])
      guard let process = response["process"] as? [String: Any] else {
        throw ForgeBridgeError.invalidResponse
      }
      guard process["completed"] as? Bool == true else {
        processStatus = "仍在执行。此处不做周期轮询，可在需要结果时再次读取。"
        return
      }
      let ok = process["ok"] as? Bool ?? ((process["exitCode"] as? Int ?? 1) == 0)
      if !ok {
        let detail =
          (process["stderr"] as? String) ?? (process["stderrTail"] as? String) ?? "Runtime 清理进程失败。"
        errorMessage = detail
        clearStoredProcess()
        return
      }
      let output = (process["stdout"] as? String) ?? (process["stdoutTail"] as? String) ?? ""
      guard let data = output.data(using: .utf8),
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        throw ForgeBridgeError.invalidResponse
      }

      if storedAction == "preview" {
        guard let parsed = RuntimeCleanupPreview(value: value) else {
          throw ForgeBridgeError.invalidResponse
        }
        preview = parsed
        previewRepoId = storedRepoId
        previewAt = Date()
      } else if storedAction == "apply" {
        guard let parsed = RuntimeCleanupApplyResult(value: value) else {
          throw ForgeBridgeError.invalidResponse
        }
        applyResult = parsed
        preview = nil
        previewAt = nil
        previewRepoId = nil
      } else {
        throw ForgeBridgeError.invalidResponse
      }
      clearStoredProcess()
    } catch {
      errorMessage = error.localizedDescription
      processStatus = "读取失败；进程仍由 Runtime 管理，可重试读取。"
    }
  }

  private func clearStoredProcess() {
    storedProcessId = ""
    storedRepoId = ""
    storedAction = ""
    storedRequestId = ""
    processStatus = nil
  }

  private func invalidatePreview() {
    preview = nil
    previewAt = nil
    previewRepoId = nil
    applyResult = nil
    if !hasPendingWork {
      storedRequestId = ""
      storedRepoId = ""
      storedAction = ""
      processStatus = nil
    }
  }
}
