import SwiftUI
import AppKit

/// Declarative assistant content: links and choices are user-driven; model
/// text never gets an implicit command-execution capability.
struct AgentAssistantMessageBody: View {
    let text: String
    var onExecuteCommand: ((String) -> Void)? = nil
    var onReplySelection: ((String) -> Void)? = nil
    @State private var taskSelections: [String: Bool] = [:]

    private var blocks: [AgentMessageBlock] { AgentMessageBlock.parse(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                content(block, blockIndex: index)
            }
            if !selectedTasks.isEmpty, onReplySelection != nil {
                Button {
                    onReplySelection?("我选择：\n" + selectedTasks.map { "- " + $0 }.joined(separator: "\n"))
                } label: {
                    Label("将勾选项填入输入框", systemImage: "arrow.turn.down.right")
                        .font(.system(size: 10.5, weight: .medium))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("agent.reply-checked-options")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            // Reject file://, javascript: and custom actions from model text.
            guard let scheme = url.scheme?.lowercased(),
                  ["https", "http", "mailto"].contains(scheme) else { return .discarded }
            NSWorkspace.shared.open(url)
            return .handled
        })
    }

    private var selectedTasks: [String] {
        blocks.enumerated().flatMap { blockIndex, block -> [String] in
            guard case .list(let items) = block else { return [] }
            return items.enumerated().compactMap { itemIndex, item in
                guard let initial = item.checked,
                      taskSelections["\(blockIndex):\(itemIndex)"] ?? initial else { return nil }
                return item.text
            }
        }
    }

    @ViewBuilder
    private func content(_ block: AgentMessageBlock, blockIndex: Int) -> some View {
        switch block {
        case .markdown(let markdown):
            AgentInlineMarkdown(text: markdown)
        case .heading(let level, let title):
            AgentInlineMarkdown(
                text: title,
                font: .system(size: level == 1 ? 20 : level == 2 ? 17 : level == 3 ? 15 : 13,
                              weight: level <= 3 ? .semibold : .medium)
            )
                .padding(.top, level <= 2 ? 7 : 3)
        case .divider:
            Divider().opacity(0.5).padding(.vertical, 3)
        case .quote(let quote):
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(Color.secondary.opacity(0.34)).frame(width: 2)
                AgentInlineMarkdown(text: quote, color: .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { itemIndex, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Color.clear.frame(width: CGFloat(item.indent * 14), height: 1)
                        if let original = item.checked {
                            let key = "\(blockIndex):\(itemIndex)"
                            let isChecked = taskSelections[key] ?? original
                            Button {
                                taskSelections[key] = !isChecked
                            } label: {
                                Image(systemName: isChecked ? "checkmark.square.fill" : "square")
                                    .font(.system(size: 13))
                                    .foregroundStyle(isChecked ? Color.accentColor : Color.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(isChecked ? "取消选择" : "选择") \(item.text)")
                            .accessibilityIdentifier("agent.checklist.\(blockIndex).\(itemIndex)")
                        } else {
                            Text(item.marker)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 17, alignment: .trailing)
                        }
                        AgentInlineMarkdown(text: item.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        case .table(let headers, let rows):
            ScrollView(.horizontal) {
                Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(headers.indices, id: \.self) { column in
                            tableCell(headers[column], header: true)
                        }
                    }
                    ForEach(rows.indices, id: \.self) { row in
                        Divider().gridCellColumns(headers.count).opacity(0.35)
                        GridRow {
                            ForEach(headers.indices, id: \.self) { column in
                                tableCell(rows[row][column])
                            }
                        }
                    }
                }
            }
            .scrollIndicators(.automatic)
            .accessibilityIdentifier("agent.markdown-table")
        case .choices(let prompt, let options):
            VStack(alignment: .leading, spacing: 8) {
                AgentInlineMarkdown(text: prompt)
                FlowChoiceButtons(options: options, onSelect: onReplySelection)
                Text("选择后填入输入框，可以修改再发送")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            .accessibilityIdentifier("agent.interactive-options")
        case .code(let language, let code):
            AgentCodeBlockView(language: language, code: code, onExecuteCommand: onExecuteCommand)
        }
    }

    private func tableCell(_ text: String, header: Bool = false) -> some View {
        AgentInlineMarkdown(
            text: text,
            font: .system(size: 11.5, weight: header ? .semibold : .regular)
        )
        .frame(minWidth: 96, maxWidth: 310, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}

private struct AgentInlineMarkdown: View {
    let text: String
    var font: Font = .system(size: 13)
    var color: Color = .primary

    var body: some View {
        Group {
            if let attributed = try? AttributedString(
                markdown: text,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                )
            ) {
                Text(attributed)
            } else {
                Text(text)
            }
        }
        .font(font)
        .foregroundStyle(color)
        .lineSpacing(5)
        .textSelection(.enabled)
    }
}

private struct FlowChoiceButtons: View {
    let options: [AgentResponseChoice]
    let onSelect: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button {
                    onSelect?(option.value)
                } label: {
                    HStack(spacing: 7) {
                        Text(option.label)
                        Image(systemName: "arrow.turn.down.right")
                            .font(.system(size: 9))
                    }
                    .font(.system(size: 11))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 5)
                }
                .buttonStyle(.borderless)
                .disabled(onSelect == nil)
                .accessibilityIdentifier("agent.choice.\(index)")
            }
        }
    }
}

struct AgentCodeBlockView: View {
    let language: String?
    let code: String
    var onExecuteCommand: ((String) -> Void)? = nil

    private var isCommand: Bool { AgentMessageBlock.isShellLanguage(language) }
    private var rows: [String] { code.components(separatedBy: "\n") }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                Text(language?.isEmpty == false ? language! : "code")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                }
                .buttonStyle(.plain)
                .help("复制原始代码")
                .accessibilityIdentifier("agent.code-copy")
                if isCommand, let onExecuteCommand {
                    Button {
                        onExecuteCommand(code)
                    } label: {
                        Label("交给 Agent 执行", systemImage: "terminal")
                    }
                    .buttonStyle(.plain)
                    .help("需再次确认；由现有 Forge Agent 按仓库权限执行")
                    .accessibilityIdentifier("agent.command-run")
                }
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .frame(height: 31)

            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        Text(row.isEmpty ? " " : row)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(diffColor(row))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 11)
                .padding(.vertical, 9)
            }
            .scrollIndicators(.automatic)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.035))
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.5)
        }
    }

    private func diffColor(_ line: String) -> Color {
        guard language?.lowercased() == "diff" else { return .primary }
        if line.hasPrefix("+"), !line.hasPrefix("+++") { return .green }
        if line.hasPrefix("-"), !line.hasPrefix("---") { return .red }
        if line.hasPrefix("@@") { return .blue }
        return .primary
    }
}
