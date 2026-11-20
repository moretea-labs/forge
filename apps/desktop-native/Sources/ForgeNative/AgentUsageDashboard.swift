import SwiftUI

/// Actual provider receipts from the canonical persisted conversation store.
/// No token estimation, price catalog, shadow database or separate scheduler.
struct AgentUsageDashboard: View {
    @ObservedObject var model: NativeWorkspace
    @Binding var days: Int
    @Binding var selectedProjectId: String
    @Binding var selectedProviderId: String
    @Binding var selectedEntryID: String?

    struct Entry: Identifiable {
        let id: String
        let threadId: String
        let messageId: String
        let threadTitle: String
        let date: Date
        let projectGroupId: String
        let project: String
        let model: String
        let provider: String
        let usage: AgentTokenUsage
    }

    struct UnreportedEntry: Identifiable {
        let id: String
        let threadId: String
        let messageId: String
        let threadTitle: String
        let date: Date
        let model: String
        let provider: String
        let incomplete: Bool
    }

    struct UsageSnapshot {
        let entries: [Entry]
        let unreportedEntries: [UnreportedEntry]
        let inputTotal: Int
        let outputTotal: Int
        let total: Int
        let partiallyReported: Int
    }

    private struct DayTotal: Identifiable {
        let date: Date
        let count: Int
        var id: Date { date }
    }

    static let unassignedProjectFilter = "__unassigned__"

    struct ProjectOption: Identifiable {
        let id: String
        let label: String
    }

    static func normalizedProjectId(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized?.isEmpty == false ? normalized : nil
    }

    static func projectOptions(
        from projects: [ForgeSemanticProject], threads: [ChatThread]
    ) -> [ProjectOption] {
        var labels = Dictionary(
            projects.map { ($0.projectId, $0.displayName) },
            uniquingKeysWith: { _, latest in latest }
        )
        for projectId in threads.compactMap({ normalizedProjectId($0.projectId) }) where labels[projectId] == nil {
            labels[projectId] = projectId
        }
        return labels.map { ProjectOption(id: $0.key, label: $0.value) }
            .sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    static func matchesProjectFilter(_ thread: ChatThread, selectedProjectId: String) -> Bool {
        guard !selectedProjectId.isEmpty else { return true }
        guard let projectId = normalizedProjectId(thread.projectId) else {
            return selectedProjectId == unassignedProjectFilter
        }
        return selectedProjectId == projectId
    }

    static func isUsageEligibleAssistantMessage(_ message: ChatMessage, since cutoff: Date) -> Bool {
        message.role == "assistant" && message.createdAt >= cutoff
    }

    static func usageCoverageCaption(unreportedMessages: Int, partiallyReportedMessages: Int) -> String {
        "无用量记录 \(unreportedMessages) 条 · 用量不完整 \(partiallyReportedMessages) 条"
    }

    static func availableProviderIds(from threads: [ChatThread]) -> [String] {
        Set(threads.flatMap { thread in
            thread.messages.filter { $0.role == "assistant" }.map {
                $0.providerUsed ?? thread.provider ?? "未知"
            }
        }).sorted()
    }

    static func makeUsageSnapshot(
        from threads: [ChatThread],
        projectLabels: [String: String],
        repositoryLabels: [String: String] = [:],
        since cutoff: Date,
        projectFilter: String = "",
        providerId: String = ""
    ) -> UsageSnapshot {
        var entries: [Entry] = []
        var unreportedEntries: [UnreportedEntry] = []
        var inputTotal = 0
        var outputTotal = 0
        var total = 0
        var partiallyReported = 0
        for thread in threads where Self.matchesProjectFilter(thread, selectedProjectId: projectFilter) {
            let semanticProjectId = Self.normalizedProjectId(thread.projectId)
            let projectGroupId: String
            let projectName: String
            if let semanticProjectId {
                projectGroupId = "project:\(semanticProjectId)"
                projectName = projectLabels[semanticProjectId] ?? semanticProjectId
            } else if let repoId = thread.repoId, !repoId.isEmpty {
                projectGroupId = "repository:\(repoId)"
                projectName = "未绑定项目 · \(repositoryLabels[repoId] ?? repoId)"
            } else {
                projectGroupId = "unassigned"
                projectName = "未关联项目"
            }
            for message in thread.messages where Self.isUsageEligibleAssistantMessage(message, since: cutoff) {
                let provider = message.providerUsed ?? thread.provider ?? "未知"
                guard providerId.isEmpty || provider == providerId else { continue }
                guard let usage = message.usage else {
                    unreportedEntries.append(UnreportedEntry(
                        id: "\(thread.id):\(message.id)",
                        threadId: thread.id,
                        messageId: message.id,
                        threadTitle: thread.title,
                        date: message.createdAt,
                        model: message.modelUsed ?? thread.model ?? "未标记模型",
                        provider: provider,
                        incomplete: message.incomplete == true
                    ))
                    continue
                }
                inputTotal += usage.inputTokens
                outputTotal += usage.outputTokens
                total += usage.totalTokens
                if !usage.complete { partiallyReported += 1 }
                entries.append(Entry(
                    id: "\(thread.id):\(message.id)",
                    threadId: thread.id, messageId: message.id, threadTitle: thread.title,
                    date: message.createdAt, projectGroupId: projectGroupId, project: projectName,
                    model: message.modelUsed ?? thread.model ?? "未标记模型",
                    provider: provider,
                    usage: usage
                ))
            }
        }
        entries.sort { $0.date > $1.date }
        unreportedEntries.sort { $0.date > $1.date }
        return UsageSnapshot(
            entries: entries, unreportedEntries: unreportedEntries,
            inputTotal: inputTotal, outputTotal: outputTotal,
            total: total, partiallyReported: partiallyReported
        )
    }

    private func makeTimeline(from entries: [Entry], today: Date) -> [DayTotal] {
        let calendar = Calendar.current
        let totals = Dictionary(grouping: entries, by: { calendar.startOfDay(for: $0.date) })
            .mapValues { values in values.reduce(0) { $0 + $1.usage.totalTokens } }
        return (0..<days).reversed().compactMap { offset in
            calendar.date(byAdding: .day, value: -offset, to: today)
        }.map { DayTotal(date: $0, count: totals[$0] ?? 0) }
    }

    private func makeModelDistribution(from entries: [Entry]) -> [(String, Int)] {
        let grouped = Dictionary(grouping: entries, by: { ModelKey(provider: $0.provider, model: $0.model) })
        return grouped.map { group in
            ("\(providerLabel(group.key.provider)) · \(group.key.model)",
             group.value.reduce(0) { $0 + $1.usage.totalTokens })
        }
            .sorted { $0.1 == $1.1 ? $0.0 < $1.0 : $0.1 > $1.1 }
    }

    private struct ModelKey: Hashable {
        let provider: String
        let model: String
    }

    static func distributionRows(
        _ values: [(String, Int)],
        limit: Int = 6,
        remainderLabel: String
    ) -> [(String, Int)] {
        guard limit > 0, values.count > limit else { return values }
        let visibleCount = limit - 1
        let visible = Array(values.prefix(visibleCount))
        let remainderTotal = values.dropFirst(visibleCount).reduce(0) { $0 + $1.1 }
        return visible + [(remainderLabel, remainderTotal)]
    }

    private func providerLabel(_ provider: String) -> String {
        if provider.hasPrefix("api:"),
           let label = model.localApiSettings?.profile(providerId: provider)?.label,
           !label.isEmpty {
            return label
        }
        switch provider {
        case "codex": return "Codex"
        case "joycode": return "JoyCode"
        case "api": return "API"
        default:
            guard provider.hasPrefix("api:") else { return provider }
            let profileId = String(provider.dropFirst(4))
            return profileId == "legacy-api" ? "兼容 API" : profileId
        }
    }

    private func makeProjectDistribution(from entries: [Entry]) -> [(String, Int)] {
        let grouped = Dictionary(grouping: entries, by: \.projectGroupId)
        return grouped.map { groupId, values in
            (values.first?.project ?? "未关联项目",
             values.reduce(0) { $0 + $1.usage.totalTokens }, groupId)
        }
        .sorted {
            if $0.1 != $1.1 { return $0.1 > $1.1 }
            return $0.2 < $1.2
        }
        .map { ($0.0, $0.1) }
    }

    var body: some View {
        let threads = model.threads
        let today = Calendar.current.startOfDay(for: Date())
        let cutoff = Calendar.current.date(byAdding: .day, value: -(days - 1), to: today) ?? today
        let projectLabels = Dictionary(
            model.semanticProjects.map { ($0.projectId, $0.displayName) },
            uniquingKeysWith: { _, latest in latest }
        )
        let repositoryLabels = Dictionary(
            model.projects.map { ($0.repoId, $0.label) },
            uniquingKeysWith: { _, latest in latest }
        )
        let projectOptions = Self.projectOptions(from: model.semanticProjects, threads: threads)
        let usageSnapshot = Self.makeUsageSnapshot(
            from: threads, projectLabels: projectLabels, repositoryLabels: repositoryLabels,
            since: cutoff, projectFilter: selectedProjectId, providerId: selectedProviderId
        )
        let usageEntries = usageSnapshot.entries
        let unreportedEntries = usageSnapshot.unreportedEntries
        let unreportedMessages = unreportedEntries.count
        let inputTotal = usageSnapshot.inputTotal
        let outputTotal = usageSnapshot.outputTotal
        let total = usageSnapshot.total
        let partiallyReported = usageSnapshot.partiallyReported
        let timeline = makeTimeline(from: usageEntries, today: today)
        let byModel = makeModelDistribution(from: usageEntries)
        let byProject = makeProjectDistribution(from: usageEntries)
        ScrollViewReader { proxy in
            ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Spacer()
                    Picker("服务", selection: $selectedProviderId) {
                        Text("全部服务").tag("")
                        ForEach(Self.availableProviderIds(from: model.threads), id: \.self) { provider in
                            Text(providerLabel(provider)).tag(provider)
                        }
                    }
                    .frame(maxWidth: 150)
                    .accessibilityIdentifier("agent.usage.provider-filter")
                    Picker("项目", selection: $selectedProjectId) {
                        Text("全部项目").tag("")
                        Text("未绑定项目").tag(Self.unassignedProjectFilter)
                        ForEach(projectOptions) { project in
                            Text(project.label).tag(project.id)
                        }
                    }
                    .frame(maxWidth: 190)
                    .accessibilityIdentifier("agent.usage.project-filter")
                    Picker("时间", selection: $days) {
                        Text("7 天").tag(7)
                        Text("30 天").tag(30)
                        Text("90 天").tag(90)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 192)
                    .accessibilityIdentifier("agent.usage.range-filter")
                }

                HStack(alignment: .top, spacing: 24) {
                    metric("agent.usage.total", "已记录 Token", total.formatted())
                    metric("agent.usage.input", "输入 Token", inputTotal.formatted())
                    metric("agent.usage.output", "输出 Token", outputTotal.formatted())
                    metric(
                        "agent.usage.recorded", "已记录消息", usageEntries.count.formatted(),
                        Self.usageCoverageCaption(
                            unreportedMessages: unreportedMessages,
                            partiallyReportedMessages: partiallyReported
                        )
                    )
                }
                .padding(.vertical, 4)

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("每日用量").font(.system(size: 15, weight: .semibold))
                        Spacer()
                        Text("最近 \(days) 天").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    let maximum = max(1, timeline.map(\.count).max() ?? 0)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .bottom, spacing: 5) {
                            ForEach(timeline) { day in
                                VStack(spacing: 5) {
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(day.count == 0 ? Color.primary.opacity(0.075) : Color.accentColor.opacity(0.7))
                                        .frame(width: 16, height: max(5, 100 * CGFloat(day.count) / CGFloat(maximum)))
                                        .frame(height: 100, alignment: .bottom)
                                    Text(Calendar.current.component(.day, from: day.date) == 1
                                         ? day.date.formatted(.dateTime.month(.abbreviated))
                                         : day.date.formatted(.dateTime.day()))
                                        .font(.system(size: 9.5, design: .rounded))
                                        .foregroundStyle(.tertiary)
                                        .frame(width: 20)
                                }
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("\(day.date.formatted(date: .complete, time: .omitted))，\(day.count.formatted()) Token")
                                .help("\(day.date.formatted(date: .abbreviated, time: .omitted)) · \(day.count.formatted()) tokens")
                            }
                        }
                        .padding(.vertical, 3)
                    }
                    if total == 0 {
                        Text(selectedProviderId.isEmpty ? "暂无用量数据" : "当前服务没有已记录 Token")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("agent.usage.daily-chart")

                HStack(alignment: .top, spacing: 32) {
                    distribution(
                        "agent.usage.model-distribution", title: "模型用量",
                        values: byModel, remainderLabel: "其他模型"
                    )
                    distribution(
                        "agent.usage.project-distribution", title: "项目用量",
                        values: byProject, remainderLabel: "其他项目"
                    )
                }

                LazyVStack(alignment: .leading, spacing: 10) {
                    Text("最近用量").font(.system(size: 15, weight: .semibold))
                    if usageEntries.isEmpty {
                        Text("暂无用量记录").font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        ForEach(usageEntries) { item in
                            HStack(spacing: 10) {
                                Text(item.date.formatted(.dateTime.month().day().hour().minute()))
                                    .foregroundStyle(.secondary).frame(width: 105, alignment: .leading)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.model).lineLimit(1)
                                    Text(providerLabel(item.provider))
                                        .font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
                                }
                                .frame(minWidth: 0, alignment: .leading)
                                .accessibilityElement(children: .combine)
                                Spacer()
                                Text(item.project).lineLimit(1).foregroundStyle(.secondary)
                                Text(item.usage.totalTokens.formatted())
                                    .monospacedDigit().frame(width: 90, alignment: .trailing)
                                if !item.usage.complete {
                                    Image(systemName: "exclamationmark.circle")
                                        .help("用量仅覆盖 \(item.usage.reportedRounds)/\(item.usage.totalRounds) 次模型请求")
                                        .accessibilityLabel("用量数据不完整")
                                }
                                Button {
                                    selectedEntryID = item.id
                                    model.selectThread(item.threadId, messageId: item.messageId)
                                } label: {
                                    Label("来源会话", systemImage: "arrow.up.right")
                                }
                                .buttonStyle(.plain)
                                .help(item.threadTitle)
                                .accessibilityLabel("打开来源会话：\(item.threadTitle)")
                                .accessibilityHint("跳转到产生这笔用量的回复")
                                .accessibilityIdentifier("agent.usage.entry.\(item.id).source-thread")
                            }
                            .font(.system(size: 11.5))
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("agent.usage.entry.\(item.id)")
                            .id(item.id)
                            Divider().opacity(0.3)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("agent.usage.recent-records")

                if !unreportedEntries.isEmpty {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("缺少用量回执")
                                .font(.system(size: 15, weight: .semibold))
                            Spacer()
                            Text("\(unreportedEntries.count) 条")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                        Text("这些回复没有可用的 Token 回执，因此未计入上方统计。")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)

                        ForEach(unreportedEntries) { item in
                            HStack(spacing: 10) {
                                Text(item.date.formatted(.dateTime.month().day().hour().minute()))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 105, alignment: .leading)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.model).lineLimit(1)
                                    Text(providerLabel(item.provider))
                                        .font(.system(size: 10))
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                                .frame(minWidth: 0, alignment: .leading)
                                Spacer(minLength: 8)
                                if item.incomplete {
                                    Text("中断")
                                        .font(.system(size: 10))
                                        .foregroundStyle(.secondary)
                                }
                                Text(item.threadTitle)
                                    .lineLimit(1)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: 160, alignment: .leading)
                                Button {
                                    selectedEntryID = item.id
                                    model.selectThread(item.threadId, messageId: item.messageId)
                                } label: {
                                    Label("定位回复", systemImage: "arrow.up.right")
                                }
                                .buttonStyle(.plain)
                                .help(item.threadTitle)
                                .accessibilityLabel("定位缺少用量回执的回复：\(item.threadTitle)")
                                .accessibilityHint("跳转到未收到 Token 用量回执的回复")
                                .accessibilityIdentifier("agent.usage.unreported.entry.\(item.id).source-thread")
                            }
                            .font(.system(size: 11.5))
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("agent.usage.unreported.entry.\(item.id)")
                            .id(item.id)
                            Divider().opacity(0.3)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("agent.usage.unreported-records")
                }
            }
            .padding(26)
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            }
            .onAppear {
                guard let target = selectedEntryID else { return }
                proxy.scrollTo(target, anchor: .center)
                selectedEntryID = nil
            }
            .accessibilityIdentifier("agent.usage.dashboard")
        }
    }

    private func metric(_ identifier: String, _ label: String, _ value: String, _ caption: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 23, weight: .medium, design: .rounded))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            if let caption {
                Text(caption).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private func distribution(
        _ identifier: String,
        title: String,
        values: [(String, Int)],
        remainderLabel: String
    ) -> some View {
        let displayedValues = Self.distributionRows(values, remainderLabel: remainderLabel)
        let maximum = max(1, displayedValues.map(\.1).max() ?? 0)
        return VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 15, weight: .semibold))
            if values.isEmpty {
                Text("暂无数据").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(Array(displayedValues.enumerated()), id: \.offset) { _, value in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(value.0).lineLimit(1)
                        Spacer()
                        Text(value.1.formatted()).monospacedDigit()
                    }
                    .font(.system(size: 11.5))
                    GeometryReader { geometry in
                        Capsule().fill(Color.primary.opacity(0.07))
                            .overlay(alignment: .leading) {
                                Capsule().fill(Color.accentColor.opacity(0.65))
                                    .frame(width: geometry.size.width * CGFloat(value.1) /
                                           CGFloat(maximum))
                            }
                    }
                    .frame(height: 5)
                    .accessibilityHidden(true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}
