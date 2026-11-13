import SwiftUI

/// Actual provider receipts from the canonical persisted conversation store.
/// No token estimation, price catalog, shadow database or separate scheduler.
struct AgentUsageDashboard: View {
    @ObservedObject var model: NativeWorkspace
    @State private var days = 30
    @State private var selectedRepoId = ""

    struct Entry: Identifiable {
        let id: String
        let date: Date
        let projectId: String?
        let project: String
        let model: String
        let provider: String
        let usage: AgentTokenUsage
    }

    struct UsageSnapshot {
        let entries: [Entry]
        let unreportedCount: Int
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

    private var relevantThreads: [ChatThread] {
        model.threads.filter { selectedRepoId.isEmpty || $0.repoId == selectedRepoId }
    }

    static func isUsageEligibleAssistantMessage(_ message: ChatMessage, since cutoff: Date) -> Bool {
        message.role == "assistant" && message.createdAt >= cutoff
    }

    static func usageCoverageCaption(unreportedMessages: Int, partiallyReportedMessages: Int) -> String {
        "无用量记录 \(unreportedMessages) 条 · 用量不完整 \(partiallyReportedMessages) 条"
    }

    static func makeUsageSnapshot(
        from threads: [ChatThread],
        projectLabels: [String: String],
        since cutoff: Date
    ) -> UsageSnapshot {
        var entries: [Entry] = []
        var unreportedCount = 0
        var inputTotal = 0
        var outputTotal = 0
        var total = 0
        var partiallyReported = 0
        for thread in threads {
            for message in thread.messages where Self.isUsageEligibleAssistantMessage(message, since: cutoff) {
                guard let usage = message.usage else {
                    unreportedCount += 1
                    continue
                }
                inputTotal += usage.inputTokens
                outputTotal += usage.outputTokens
                total += usage.totalTokens
                if !usage.complete { partiallyReported += 1 }
                let projectName = thread.repoId.flatMap { projectLabels[$0] }
                    ?? thread.repoId ?? "未关联项目"
                entries.append(Entry(
                    id: message.id, date: message.createdAt,
                    projectId: thread.repoId, project: projectName,
                    model: message.modelUsed ?? thread.model ?? "未标记模型",
                    provider: message.providerUsed ?? thread.provider ?? "未知",
                    usage: usage
                ))
            }
        }
        entries.sort { $0.date > $1.date }
        return UsageSnapshot(
            entries: entries, unreportedCount: unreportedCount,
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
        let grouped = Dictionary(grouping: entries, by: \.projectId)
        return grouped.map { projectId, values in
            (values.first?.project ?? "未关联项目",
             values.reduce(0) { $0 + $1.usage.totalTokens }, projectId ?? "")
        }
        .sorted {
            if $0.1 != $1.1 { return $0.1 > $1.1 }
            return $0.2 < $1.2
        }
        .map { ($0.0, $0.1) }
    }

    var body: some View {
        let threads = relevantThreads
        let today = Calendar.current.startOfDay(for: Date())
        let cutoff = Calendar.current.date(byAdding: .day, value: -(days - 1), to: today) ?? today
        let projectLabels = Dictionary(
            model.projects.map { ($0.repoId, $0.label) },
            uniquingKeysWith: { _, latest in latest }
        )
        let usageSnapshot = Self.makeUsageSnapshot(from: threads, projectLabels: projectLabels, since: cutoff)
        let usageEntries = usageSnapshot.entries
        let unreportedMessages = usageSnapshot.unreportedCount
        let inputTotal = usageSnapshot.inputTotal
        let outputTotal = usageSnapshot.outputTotal
        let total = usageSnapshot.total
        let partiallyReported = usageSnapshot.partiallyReported
        let timeline = makeTimeline(from: usageEntries, today: today)
        let byModel = makeModelDistribution(from: usageEntries)
        let byProject = makeProjectDistribution(from: usageEntries)
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Spacer()
                    Picker("项目", selection: $selectedRepoId) {
                        Text("全部项目").tag("")
                        ForEach(model.projects) { project in
                            Text(project.label).tag(project.repoId)
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
                        Text("暂无用量数据")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("agent.usage.daily-chart")

                HStack(alignment: .top, spacing: 32) {
                    distribution("agent.usage.model-distribution", title: "模型用量", values: byModel)
                    distribution("agent.usage.project-distribution", title: "项目用量", values: byProject)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("最近用量").font(.system(size: 15, weight: .semibold))
                    if usageEntries.isEmpty {
                        Text("暂无用量记录").font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(usageEntries.prefix(12))) { item in
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
                            }
                            .font(.system(size: 11.5))
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("agent.usage.entry.\(item.id)")
                            Divider().opacity(0.3)
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("agent.usage.recent-records")

            }
            .padding(26)
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .accessibilityIdentifier("agent.usage.dashboard")
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

    private func distribution(_ identifier: String, title: String, values: [(String, Int)]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 15, weight: .semibold))
            if values.isEmpty {
                Text("暂无数据").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(Array(values.prefix(6).enumerated()), id: \.offset) { _, value in
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
                                           CGFloat(max(1, values.first?.1 ?? 1)))
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
