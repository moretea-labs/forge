import SwiftUI

/// Actual provider receipts from the canonical persisted conversation store.
/// No token estimation, price catalog, shadow database or separate scheduler.
struct AgentUsageDashboard: View {
    @ObservedObject var model: NativeWorkspace
    @State private var days = 30
    @State private var selectedRepoId = ""

    private struct Entry: Identifiable {
        let id: String
        let date: Date
        let projectId: String?
        let project: String
        let model: String
        let provider: String
        let usage: AgentTokenUsage
    }

    private struct DayTotal: Identifiable {
        let date: Date
        let count: Int
        var id: Date { date }
    }

    private var relevantThreads: [ChatThread] {
        model.threads.filter { selectedRepoId.isEmpty || $0.repoId == selectedRepoId }
    }

    private var entries: [Entry] {
        let cutoff = Calendar.current.date(byAdding: .day, value: -(days - 1),
                                           to: Calendar.current.startOfDay(for: Date())) ?? Date()
        return relevantThreads.flatMap { thread in
            thread.messages.compactMap { message -> Entry? in
                guard message.role == "assistant",
                      message.createdAt >= cutoff,
                      let usage = message.usage else { return nil }
                let projectName = model.projects.first(where: { $0.repoId == thread.repoId })?.label
                    ?? thread.repoId ?? "未关联项目"
                return Entry(id: message.id, date: message.createdAt,
                             projectId: thread.repoId, project: projectName,
                             model: message.modelUsed ?? thread.model ?? "未标记模型",
                             provider: message.providerUsed ?? thread.provider ?? "未知",
                             usage: usage)
            }
        }.sorted { $0.date > $1.date }
    }

    private var unreportedMessages: Int {
        let cutoff = Calendar.current.date(byAdding: .day, value: -(days - 1),
                                           to: Calendar.current.startOfDay(for: Date())) ?? Date()
        return relevantThreads.reduce(0) { count, thread in
            count + thread.messages.filter {
                $0.role == "assistant" && $0.createdAt >= cutoff && $0.usage == nil
            }.count
        }
    }

    private var inputTotal: Int { entries.reduce(0) { $0 + $1.usage.inputTokens } }
    private var outputTotal: Int { entries.reduce(0) { $0 + $1.usage.outputTokens } }
    private var total: Int { entries.reduce(0) { $0 + $1.usage.totalTokens } }
    private var partiallyReported: Int { entries.filter { !$0.usage.complete }.count }

    private var timeline: [DayTotal] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let totals = Dictionary(grouping: entries, by: { calendar.startOfDay(for: $0.date) })
            .mapValues { values in values.reduce(0) { $0 + $1.usage.totalTokens } }
        return (0..<days).reversed().compactMap { offset in
            calendar.date(byAdding: .day, value: -offset, to: today)
        }.map { DayTotal(date: $0, count: totals[$0] ?? 0) }
    }

    private var byModel: [(String, Int)] {
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

    private var byProject: [(String, Int)] {
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
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Token 消耗").font(.system(size: 24, weight: .semibold))
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
                    metric("总 Token", total.formatted())
                    metric("输入", inputTotal.formatted())
                    metric("输出", outputTotal.formatted())
                    metric("已记录回复", entries.count.formatted(), "未记录 \(unreportedMessages) 条")
                }
                .padding(.vertical, 4)

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("每日消耗").font(.system(size: 15, weight: .semibold))
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
                                        .font(.system(size: 8, design: .rounded))
                                        .foregroundStyle(.tertiary)
                                        .frame(width: 17)
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

                HStack(alignment: .top, spacing: 32) {
                    distribution("模型消耗", values: byModel)
                    distribution("项目消耗", values: byProject)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("最近记录").font(.system(size: 15, weight: .semibold))
                    if entries.isEmpty {
                        Text("暂无用量回执").font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(entries.prefix(12))) { item in
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
                                        .help("只汇总了 \(item.usage.reportedRounds)/\(item.usage.totalRounds) 个模型回合")
                                        .accessibilityLabel("部分回合用量")
                                }
                            }
                            .font(.system(size: 11.5))
                            Divider().opacity(0.3)
                        }
                    }
                }

                Text("仅统计 Provider 返回的实际用量；未记录数据不估算。\(partiallyReported > 0 ? "另有 \(partiallyReported) 条部分回合数据。" : "")")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
            }
            .padding(26)
            .frame(maxWidth: 1020, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .accessibilityIdentifier("agent.usage.dashboard")
    }

    private func metric(_ label: String, _ value: String, _ caption: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 23, weight: .medium, design: .rounded))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            if let caption {
                Text(caption).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func distribution(_ title: String, values: [(String, Int)]) -> some View {
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
    }
}
