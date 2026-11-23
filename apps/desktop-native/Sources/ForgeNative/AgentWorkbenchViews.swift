import SwiftUI
import AppKit
import UniformTypeIdentifiers

enum AgentSemanticContextInspector: String, Identifiable {
    case planning
    case knowledge
    var id: String { rawValue }
}

/// Cursor-style editor tabs: only working surfaces are actionable.
/// Browser is deliberately unavailable until an authorized web pane exists.
enum AgentWorkSurface: String, CaseIterable, Identifiable, Equatable {
    case changes, files
    var id: String { rawValue }
    var title: String { self == .changes ? "改动" : "附件" }
    var symbol: String { self == .changes ? "doc.text.magnifyingglass" : "paperclip" }
}

/// Stable AX ids for Agent actions hosted in the conversation toolbar.
enum AgentConversationToolbarContract {
    static let changesIdentifier = "agent.changes"
    static let filesIdentifier = "agent.files"
    static let moreIdentifier = "agent.tools.more"
    static let requiredActionIdentifiers = [changesIdentifier, filesIdentifier, moreIdentifier]
}

/// The split is available only when both real pane minima and native divider
/// clearance fit. Width changes affect presentation, never selected-pane state.
enum AgentWorkSurfaceLayout {
    static let conversationMinimumWidth: CGFloat = 420
    static let workSurfaceMinimumWidth: CGFloat = 360
    static let splitDividerAndSpacingAllowance: CGFloat = 60
    static var minimumSideBySideWidth: CGFloat {
        conversationMinimumWidth + workSurfaceMinimumWidth + splitDividerAndSpacingAllowance
    }

    enum Presentation: Equatable {
        case conversationOnly
        case sideBySide
        case replacement
    }

    static func supportsSideBySide(availableWidth: CGFloat) -> Bool {
        availableWidth >= minimumSideBySideWidth
    }

    static func presentation(
        availableWidth: CGFloat,
        isVisible: Bool,
        isMaximized: Bool
    ) -> Presentation {
        guard isVisible else { return .conversationOnly }
        guard !isMaximized, supportsSideBySide(availableWidth: availableWidth) else {
            return .replacement
        }
        return .sideBySide
    }
}

struct AgentScrollMetrics: Equatable {
    let offset: CGFloat
    let contentHeight: CGFloat
    let viewportHeight: CGFloat

    var distanceToBottom: CGFloat { max(0, contentHeight - offset - viewportHeight) }
    var isNearBottom: Bool { viewportHeight > 0 && distanceToBottom <= 72 }
}

struct AgentScrollMetricsPreferenceKey: PreferenceKey {
    static var defaultValue = AgentScrollMetrics(offset:0, contentHeight:0, viewportHeight:0)

    static func reduce(value: inout AgentScrollMetrics, nextValue: () -> AgentScrollMetrics) {
        value = nextValue()
    }
}

struct AgentPane: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let onChooseProject: () -> Void
    @Binding var selectedWorkSurfaceRaw: String
    @Binding var workSurfaceVisible: Bool
    @Binding var workSurfaceMaximized: Bool
    @Binding var semanticInspector: AgentSemanticContextInspector?
    @State private var showActivityDetails = false
    @State private var expandedMessageActivities: Set<String> = []
    @State private var expandedUserInstructions: Set<String> = []
    @State private var pendingAgentCommand: String?
    @State private var showProviderThinking = false
    @State private var isComposerDropTarget = false
    @State private var conversationScrollMetrics: AgentScrollMetrics?
    @State private var conversationViewportHeight: CGFloat = 0
    @State private var followsLatestConversation = true
    @StateObject private var voiceDictation = AgentVoiceDictation()
    @State private var voiceBaseDraft = ""
    @State private var restoreComposerFocusAfterWorkSurface = false
    @State private var fileSelectedRepoId = ""
    @State private var fileShowLocalResources = true
    @State private var fileShowRemoteImages = true
    @State private var fileSearchQuery = ""
    @State private var fileSelectedResourceID: String?
    @FocusState private var composerFocused: Bool

    private var selectedWorkSurface: AgentWorkSurface {
        AgentWorkSurface(rawValue:selectedWorkSurfaceRaw) ?? .changes
    }

    var body: some View {
        GeometryReader { geometry in
            agentContent(availableWidth:geometry.size.width)
        }
        // No titlebar content band: tools sit as plain icons with a hidden
        // toolbar background so traffic lights + content share one surface.
        .toolbar {
            ToolbarItemGroup(placement:.primaryAction) {
                if !workSurfaceVisible {
                    workspaceChangesControl
                    workspaceFilesControl
                    additionalAgentTools
                }
            }
        }
        .toolbarBackground(.hidden, for:.windowToolbar)
        .task(id: workSurfaceVisible && selectedWorkSurface == .changes
              ? model.checkoutId : nil) {
            // Right pane stays hidden until Changes/Files is opened.
            guard workSurfaceVisible,
                  selectedWorkSurface == .changes,
                  model.checkoutId != nil else { return }
            await model.refreshAgentChanges(staged:model.agentChanges?.staged ?? false)
        }
    }

    private var agentScopeLabel: String {
        [model.semanticProject?.displayName, model.project?.label, model.checkoutBranch]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator:" › ")
    }

    private var agentWorkspaceStatusColor: Color {
        if model.busy || model.zenRefinementActive { return .orange }
        if !model.checkoutIsAvailable { return .orange }
        if model.selectedProviderReady { return .green }
        return ForgePalette.secondary
    }

    /// Quiet in-content status — never hosted in a titlebar band.
    private var agentWorkspaceStatusChip: some View {
        Button { Task { await model.refresh() } } label: {
            HStack(spacing:5) {
                Circle().fill(agentWorkspaceStatusColor).frame(width:5,height:5)
                Text(model.agentWorkspaceStatusLabel)
                    .font(.system(size:10.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(agentScopeLabel.isEmpty ? model.agentWorkspaceStatusDetail : agentScopeLabel)\n\(model.agentWorkspaceStatusDetail)\n点击刷新")
        .accessibilityLabel("工作区")
        .accessibilityValue("\(agentScopeLabel.isEmpty ? (model.thread?.title ?? "Forge") : agentScopeLabel) · \(model.agentWorkspaceStatusLabel)")
        .accessibilityHint("点击刷新会话状态和模型服务")
        .accessibilityIdentifier("agent.workspace-scope")
    }

    /// Cursor-style editor tabs: text weight + underline, no pill cards.
    private var rightPaneTabStrip: some View {
        HStack(spacing:4) {
            ForEach(AgentWorkSurface.allCases) { surface in
                let selected = semanticInspector == nil && selectedWorkSurface == surface
                Button {
                    openWorkSurface(surface)
                } label: {
                    HStack(spacing:4) {
                        Text(surface.title)
                            .font(.system(size:12,weight:selected ? .semibold : .regular))
                        if surface == .changes, workspaceReviewFileCount > 0 {
                            Text("\(workspaceReviewFileCount)")
                                .font(.system(size:10)).monospacedDigit()
                                .foregroundStyle(ForgePalette.secondary)
                        }
                    }
                    .foregroundStyle(selected ? ForgePalette.ink : ForgePalette.secondary)
                    .padding(.horizontal,6)
                    .frame(height:28)
                    .overlay(alignment:.bottom) {
                        Rectangle()
                            .fill(selected ? ForgePalette.ink.opacity(0.55) : .clear)
                            .frame(height:1.5)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(surface == .changes && model.checkoutId == nil)
                .accessibilityLabel(surface.title)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
                .accessibilityIdentifier(surface == .changes
                                         ? "agent.right-pane.tab.changes"
                                         : "agent.right-pane.tab.files")
            }
            Menu {
                Button {
                    closeWorkSurface(); semanticInspector = .planning
                } label: { Label("规划上下文",systemImage:"list.bullet.indent") }
                    .disabled(model.thread?.projectId == nil)
                Button {
                    closeWorkSurface(); semanticInspector = .knowledge
                } label: { Label("知识上下文",systemImage:"books.vertical") }
                    .disabled(model.repoId == nil)
                Divider()
                Button("浏览器（尚未接入）") {}.disabled(true)
            } label: {
                Image(systemName:"ellipsis").forgeChromeIcon()
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("更多会话工具")
            .accessibilityIdentifier("agent.right-pane.tools")
        }
    }

    private var workspaceReviewFileCount: Int {
        model.agentChanges?.reviewScopeFileCount ?? 0
    }

    private var workspaceReviewSummary: String {
        guard let changes = model.agentChanges else { return "尚未读取改动" }
        let scope = changes.staged ? "已暂存" : "未暂存"
        let count = changes.reviewScopeFileCount
        return count > 0 ? "\(scope) \(count) 个文件" : "\(scope)范围无改动"
    }

    private var workspaceChangesControl: some View {
        let active = workSurfaceVisible && selectedWorkSurface == .changes && semanticInspector == nil
        return Button {
            if workSurfaceVisible && selectedWorkSurface == .changes {
                closeWorkSurface()
            } else {
                openWorkSurface(.changes)
            }
        } label: {
            HStack(spacing:3) {
                Image(systemName:"doc.text.magnifyingglass").forgeChromeIcon(active:active)
                if workspaceReviewFileCount > 0 {
                    Text("\(workspaceReviewFileCount)")
                        .font(.system(size:10,weight:.medium))
                        .monospacedDigit()
                        .foregroundStyle(active ? ForgePalette.ink : ForgePalette.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.checkoutId == nil)
        .help("改动：\(workspaceReviewSummary)")
        .accessibilityLabel("改动审查")
        .accessibilityValue(workspaceReviewSummary)
        .accessibilityIdentifier(AgentConversationToolbarContract.changesIdentifier)
    }

    private var workspaceFilesControl: some View {
        let active = workSurfaceVisible && selectedWorkSurface == .files && semanticInspector == nil
        return Button {
            if workSurfaceVisible && selectedWorkSurface == .files {
                closeWorkSurface()
            } else {
                openWorkSurface(.files)
            }
        } label: {
            Image(systemName:"paperclip").forgeChromeIcon(active:active)
        }
        .buttonStyle(.plain)
        .help("查看会话文件与图片")
        .accessibilityLabel("附件")
        .accessibilityIdentifier(AgentConversationToolbarContract.filesIdentifier)
    }

    private var additionalAgentTools: some View {
        Menu {
            Button("规划上下文") {
                semanticInspector = semanticInspector == .planning ? nil : .planning
                if semanticInspector != nil { closeWorkSurface() }
            }
            .disabled(model.thread?.projectId == nil)
            Button("知识上下文") {
                semanticInspector = semanticInspector == .knowledge ? nil : .knowledge
                if semanticInspector != nil { closeWorkSurface() }
            }
            .disabled(model.repoId == nil)
            Divider()
            Button("浏览器（尚未接入）") {}
                .disabled(true)
        } label: {
            Image(systemName:"ellipsis").forgeChromeIcon()
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("更多会话工具；浏览器尚未接入")
        .accessibilityIdentifier(AgentConversationToolbarContract.moreIdentifier)
    }

    private var composerInputHeight: CGFloat {
        let lines = model.draft.split(separator:"\n",omittingEmptySubsequences:false).count
        let wrapped = max(lines, (model.draft.count + 69) / 70)
        return min(112,max(38,CGFloat(wrapped) * 19 + 19))
    }

    private func agentContent(availableWidth:CGFloat) -> some View {
        let workSurfacePresentation = AgentWorkSurfaceLayout.presentation(
            availableWidth:availableWidth,
            isVisible:workSurfaceVisible,
            isMaximized:workSurfaceMaximized
        )
        return VStack(spacing:0) {
            HSplitView {
                ZStack {
                    // Keep the composer and transcript mounted during review.
                    // No titleband and no in-content tool strip.
                    VStack(spacing:0) {
                        ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:16) {
                        if model.thread?.messages.isEmpty != false {
                            VStack(spacing:12) {
                                VStack(spacing:5) {
                                    Text("今天想完成什么？")
                                        .font(.system(size:18,weight:.semibold)).tracking(-0.25)
                                    Text(agentEmptyStateDescription)
                                        .font(.system(size:12))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .multilineTextAlignment(.center)
                                        .lineSpacing(3)
                                        .frame(maxWidth:420)
                                }
                                if model.isProjectOnlyConversation {
                                    if model.agentSendBlockReason == nil {
                                        HStack(spacing:8) {
                                            starterPromptButton("梳理项目需求",systemImage:"list.bullet.clipboard",
                                                                prompt:"读取当前项目的 Requirement 与 Plan，整理目标、约束和待确认事项。",
                                                                requiresCheckout:false)
                                            starterPromptButton("制定下一步",systemImage:"arrow.turn.down.right",
                                                                prompt:"基于当前项目的 Requirement 与 Plan，提出一个最小可验收的下一步；只分析，不执行代码操作。",
                                                                requiresCheckout:false)
                                        }
                                    } else if !model.selectedProviderReady {
                                        Button("设置模型") { model.show(.settings) }
                                            .buttonStyle(.forgeText)
                                            .accessibilityIdentifier("agent.onboarding.provider")
                                    }
                                } else if !model.checkoutIsAvailable || !model.selectedProviderReady {
                                    HStack(spacing:12) {
                                        if !model.checkoutIsAvailable {
                                            Button(model.thread?.repoId == nil ? "选择或添加项目" : "选择工作区",action:onChooseProject)
                                                .buttonStyle(.borderedProminent)
                                                .accessibilityIdentifier("agent.onboarding.project")
                                        }
                                        if !model.selectedProviderReady {
                                            Button("设置模型") { model.show(.settings) }
                                                .buttonStyle(.forgeText)
                                                .accessibilityIdentifier("agent.onboarding.provider")
                                        }
                                    }
                                } else {
                                    HStack(spacing:8) {
                                        starterPromptButton("审查当前改动",systemImage:"doc.text.magnifyingglass",
                                                            prompt:"检查当前 checkout 的未提交改动，指出风险并完成必要修复与验证。")
                                        starterPromptButton("定位问题",systemImage:"scope",
                                                            prompt:"读取当前项目真实状态，定位最高价值的问题并直接修复，完成必要验证。")
                                        starterPromptButton("实现需求",systemImage:"hammer",
                                                            prompt:"读取当前 Requirement / Plan 与代码现状，选择最高价值的下一项实现并完成验证。")
                                    }
                                }
                            }
                            .frame(maxWidth:.infinity,minHeight:260)
                            .padding(.top,36)
                        }
                        ForEach(model.thread?.messages ?? []) { message in
                            if message.role == "user" {
                                // Long Requirement instructions stay intact but
                                // no longer consume the whole conversation viewport.
                                let isLongInstruction = message.text.count > 480
                                    || message.text.filter { $0 == "\n" }.count > 10
                                let instructionExpanded = expandedUserInstructions.contains(message.id)
                                HStack(alignment:.top) {
                                    Spacer(minLength:0)
                                    VStack(alignment:.leading,spacing:7) {
                                        if isLongInstruction {
                                            HStack(spacing:7) {
                                                Label("已发送指令",systemImage:"text.alignleft")
                                                    .font(.system(size:11,weight:.semibold))
                                                    .foregroundStyle(ForgePalette.secondary)
                                                Text("\(message.text.count) 字")
                                                    .font(.system(size:10))
                                                    .foregroundStyle(.tertiary)
                                                    .monospacedDigit()
                                                Spacer(minLength:6)
                                                Button(instructionExpanded ? "收起" : "展开全文") {
                                                    if instructionExpanded {
                                                        expandedUserInstructions.remove(message.id)
                                                    } else {
                                                        expandedUserInstructions.insert(message.id)
                                                    }
                                                }
                                                .font(.system(size:11,weight:.medium))
                                                .buttonStyle(.plain)
                                                .foregroundStyle(ForgePalette.secondary)
                                                .accessibilityLabel(instructionExpanded ? "收起原始指令" : "展开原始指令")
                                                .accessibilityIdentifier("agent.message.\(message.id).expand")
                                            }
                                        }
                                        Text(message.text)
                                            .font(.system(size:13))
                                            .lineSpacing(4)
                                            .lineLimit(isLongInstruction && !instructionExpanded ? 4 : nil)
                                            .textSelection(.enabled)
                                        if let contextPaths = message.contextPaths, !contextPaths.isEmpty {
                                            HStack(alignment:.center,spacing:8) {
                                                ForEach(Array(contextPaths.enumerated()),id:\.offset) { index,relativePath in
                                                    let name = URL(fileURLWithPath:relativePath).lastPathComponent
                                                    let fileURL = resolveLocalContextFileURL(
                                                        rootPath:model.checkoutRoot?.path,
                                                        relativePath:relativePath
                                                    )
                                                    Button {
                                                        if let fileURL { NSWorkspace.shared.open(fileURL) }
                                                    } label: {
                                                        Label(name,systemImage:"doc.text")
                                                            .font(.system(size:10.5,weight:.medium))
                                                            .foregroundStyle(fileURL == nil ? ForgePalette.secondary.opacity(0.5) : ForgePalette.secondary)
                                                            .lineLimit(1)
                                                            .truncationMode(.middle)
                                                    }
                                                    .buttonStyle(.plain)
                                                    .help(fileURL == nil ? "原文件已移动或当前 checkout 不可用" : relativePath)
                                                    .accessibilityLabel("打开上下文文件：\(name)")
                                                    .accessibilityHint(fileURL == nil ? "当前 checkout 中找不到该文件" : "使用 macOS 默认应用打开")
                                                    .accessibilityIdentifier("agent.message.\(message.id).context-file.\(index)")
                                                    .disabled(fileURL == nil)
                                                }
                                            }
                                        }
                                        if let imagePaths = message.attachmentPaths, !imagePaths.isEmpty {
                                            HStack(alignment:.center,spacing:8) {
                                                ForEach(Array(imagePaths.enumerated()),id:\.offset) { index,path in
                                                    let name = URL(fileURLWithPath:path).lastPathComponent
                                                    Button {
                                                        NSWorkspace.shared.open(URL(fileURLWithPath:path))
                                                    } label: {
                                                        AgentLocalImagePreview(
                                                            path:path,
                                                            accessibilityLabel:"图片附件：\(name)",
                                                            width:82,
                                                            height:82,
                                                            maxWidth:82,
                                                            maxHeight:82
                                                        )
                                                    }
                                                    .buttonStyle(.plain)
                                                    .help("打开图片：\(name)")
                                                    .accessibilityLabel("打开图片附件：\(name)")
                                                    .accessibilityHint("使用 macOS 默认应用打开原图")
                                                    .accessibilityIdentifier("agent.message.\(message.id).attachment.\(index)")
                                                    .disabled(!FileManager.default.fileExists(atPath:path))
                                                }
                                            }
                                        }
                                        if let attachments = message.attachmentNames, !attachments.isEmpty {
                                            Label(attachments.joined(separator:" · "),systemImage:"photo")
                                                .font(.system(size:10.5,weight:.medium))
                                                .foregroundStyle(ForgePalette.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                    .frame(maxWidth:isLongInstruction ? 740 : 880,alignment:.leading)
                                    .padding(.horizontal,15).padding(.vertical,10)
                                    .background(ForgePalette.userBubble,
                                                in:RoundedRectangle(cornerRadius:16,style:.continuous))
                                    .contextMenu {
                                        Button { copyAgentText(message.text) } label: {
                                            Label("复制",systemImage:"doc.on.doc")
                                        }
                                        Button { model.reeditMessage(message) } label: {
                                            Label("重新编辑",systemImage:"arrow.uturn.backward")
                                        }
                                        .disabled(model.busy)
                                    }
                                }
                                .frame(maxWidth:ForgeClientDesign.Shell.readingColumn * 0.82,alignment:.trailing)
                                .frame(maxWidth:.infinity,alignment:.trailing)
                                .id(message.id)
                            } else {
                                HStack(alignment:.top,spacing:0) {
                                    VStack(alignment:.leading,spacing:8) {
                                        AgentAssistantMessageBody(
                                            text:message.text,
                                            accessibilityIdentifierPrefix: AgentAssistantMessageBody.accessibilityPrefix(for: message.id),
                                            onExecuteCommand: { command in
                                                guard !model.busy,!model.zenRefinementActive else { return }
                                                guard model.repoId != nil, model.checkoutId != nil else {
                                                    model.error = "执行命令前请先绑定项目与 checkout。"
                                                    return
                                                }
                                                guard model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
                                                    model.error = "输入框已有未发送内容。请先发送或保存，再执行这段命令，避免覆盖草稿。"
                                                    return
                                                }
                                                pendingAgentCommand = command
                                            },
                                            onReplySelection: { reply in
                                                guard !model.busy,!model.zenRefinementActive else { return }
                                                model.draft += model.draft.isEmpty ? reply : "\n\n" + reply
                                                composerFocused = true
                                            }
                                        )
                                        HStack(spacing:10) {
                                            if message.activityEvents?.isEmpty == false {
                                                Button {
                                                    if expandedMessageActivities.contains(message.id) {
                                                        expandedMessageActivities.remove(message.id)
                                                    } else {
                                                        expandedMessageActivities.insert(message.id)
                                                    }
                                                } label: {
                                                    HStack(spacing:5) {
                                                        Label(message.toolActivityCount.map { "\($0) 次工具调用 · 过程" } ?? "查看过程",
                                                              systemImage:"list.bullet.rectangle")
                                                        Image(systemName:expandedMessageActivities.contains(message.id)
                                                              ? "chevron.up" : "chevron.down")
                                                            .font(.system(size:8,weight:.semibold))
                                                    }
                                                }
                                                .buttonStyle(.plain)
                                            } else if let count = message.toolActivityCount, count > 0 {
                                                Label("\(count) 次工具调用",systemImage:"hammer")
                                            }
                                            if let usage = message.usage {
                                                Label(
                                                    "\(usage.totalTokens.formatted()) tokens" + (usage.complete ? "" : " · 部分回合"),
                                                    systemImage:"chart.bar"
                                                )
                                                .help("输入 \(usage.inputTokens.formatted()) · 输出 \(usage.outputTokens.formatted())")
                                            }
                                            Spacer(minLength:0)
                                            Button {
                                                copyAgentText(message.text)
                                            } label: {
                                                Label("复制",systemImage:"doc.on.doc")
                                            }
                                            .buttonStyle(.plain)
                                            .help("复制完整回复")
                                        }
                                        .font(.system(size:10.5,weight:.medium))
                                        .foregroundStyle(ForgePalette.secondary)
                                        if message.incomplete == true,
                                           message.id == model.thread?.messages.last?.id {
                                            let requiresReview = NativeWorkspace.incompleteTurnRequiresReview(message)
                                            HStack(alignment:.center,spacing:9) {
                                                Image(systemName:requiresReview
                                                    ? "exclamationmark.arrow.triangle.2.circlepath" : "checkmark.circle")
                                                    .font(.system(size:15))
                                                    .foregroundStyle(ForgePalette.secondary)
                                                    .accessibilityHidden(true)
                                                VStack(alignment:.leading,spacing:3) {
                                                    Text(requiresReview ? "上次执行未完成" : "可以继续执行")
                                                        .font(.system(size:11,weight:.semibold))
                                                        .foregroundStyle(ForgePalette.ink)
                                                    Text(requiresReview
                                                        ? "工具操作结果尚未完全核实。先查看改动并发送核对指令。"
                                                        : "工具回执完整，没有待核对的操作。")
                                                        .font(.system(size:10))
                                                        .foregroundStyle(ForgePalette.secondary)
                                                }
                                                Spacer(minLength:6)
                                                Button("查看改动") {
                                                    openWorkSurface(.changes)
                                                }
                                                .buttonStyle(.plain)
                                                .font(.system(size:10.5,weight:.medium))
                                                .disabled(model.checkoutId == nil)
                                                Button {
                                                    guard !voiceDictation.blocksSend else { return }
                                                    model.draft = NativeWorkspace.incompleteTurnContinuationPrompt
                                                    if !requiresReview { Task { await model.send() } }
                                                } label: {
                                                    Label(
                                                        requiresReview ? "填入核对指令" : "继续执行",
                                                        systemImage:requiresReview
                                                            ? "doc.text.magnifyingglass" : "play.fill"
                                                    )
                                                        .font(.system(size:10.5,weight:.medium))
                                                }
                                                .buttonStyle(.forgeText)
                                                // Review only fills the composer; it is safe to prepare
                                                // while the Provider is offline. One-click execution still
                                                // requires a ready Provider and an empty composer.
                                                .disabled(model.busy || model.zenRefinementActive || voiceDictation.blocksSend
                                                    || !model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                                                    || (!requiresReview && model.agentSendBlockReason != nil))
                                                .accessibilityIdentifier("agent.continue-incomplete")
                                            }
                                            .padding(10)
                                            .background(ForgePalette.softFill,
                                                        in:RoundedRectangle(cornerRadius:10,style:.continuous))
                                            .accessibilityIdentifier("agent.incomplete-recovery")
                                        }
                                        if expandedMessageActivities.contains(message.id),
                                           let events = message.activityEvents, !events.isEmpty {
                                            VStack(alignment:.leading,spacing:7) {
                                                ForEach(events) { event in
                                                    activityTrailRow(event)
                                                }
                                            }
                                            .padding(.leading,4).padding(.vertical,4)
                                        }
                                    }
                                    Spacer(minLength:0)
                                }
                                .frame(maxWidth:.infinity,alignment:.leading)
                                .id(message.id)
                            }
                        }
                        if model.busy || model.zenRefinementActive {
                            VStack(alignment:.leading,spacing:10) {
                                HStack(spacing:10) {
                                    ZStack {
                                        Circle().fill(ForgePalette.accent.opacity(0.10))
                                            .frame(width:28,height:28)
                                        ProgressView().controlSize(.mini)
                                    }
                                    VStack(alignment:.leading,spacing:2) {
                                        Text(agentActivityTitle)
                                            .font(.system(size:11.5,weight:.semibold))
                                            .foregroundStyle(ForgePalette.ink)
                                        Text(model.liveActivity?.lastActivity
                                             ?? (model.zenRefinementActive ? "正在只读核对 Requirement / Plan…" : "正在处理请求…"))
                                            .font(.system(size:10.5))
                                            .foregroundStyle(ForgePalette.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength:8)
                                    if let count = model.liveActivity?.toolActivityCount, count > 0 {
                                        Text("\(count) tools")
                                            .font(.system(size:9.5,weight:.medium))
                                            .foregroundStyle(.tertiary)
                                    }
                                    if let count = model.liveActivity?.events?.count, count > 4 {
                                        Button(showActivityDetails ? "收起" : "全部") {
                                            withAnimation(reduceMotion ? nil : .easeOut(duration:0.16)) {
                                                showActivityDetails.toggle()
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10.5,weight:.medium))
                                    }
                                }

                                if !model.streamedReasoning.isEmpty {
                                    VStack(alignment:.leading,spacing:5) {
                                        Button {
                                            showProviderThinking.toggle()
                                        } label: {
                                            HStack(spacing:6) {
                                                Image(systemName:"brain.head.profile")
                                                Text("思考过程")
                                                Image(systemName:showProviderThinking ? "chevron.up" : "chevron.down")
                                                    .font(.system(size:9))
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10.5,weight:.medium))
                                        .foregroundStyle(ForgePalette.secondary)
                                        Text(model.streamedReasoning)
                                            .font(.system(size:11))
                                            .foregroundStyle(ForgePalette.secondary)
                                            .lineSpacing(4)
                                            .lineLimit(showProviderThinking ? nil : 3)
                                            .textSelection(.enabled)
                                    }
                                    .accessibilityIdentifier("agent.streaming-reasoning")
                                }
                                if !model.streamedAnswer.isEmpty {
                                    AgentAssistantMessageBody(
                                        text:model.streamedAnswer,
                                        accessibilityIdentifierPrefix:"agent.streaming-response"
                                    )
                                        .accessibilityIdentifier("agent.streaming-response")
                                }

                                let allActivityEvents = model.liveActivity?.events ?? []
                                let activityEvents = showActivityDetails
                                    ? allActivityEvents
                                    : Array(allActivityEvents.suffix(4))
                                if !activityEvents.isEmpty {
                                    VStack(alignment:.leading,spacing:7) {
                                        ForEach(activityEvents) { event in
                                            activityTrailRow(event)
                                        }
                                    }
                                }
                            }
                            .padding(.vertical,9).padding(.horizontal,12)
                            .id("pending")
                        }
                    }
                    .frame(maxWidth:ForgeClientDesign.Shell.readingColumn,alignment:.leading)
                    .frame(maxWidth:.infinity)
                    .padding(.horizontal,32).padding(.top,32).padding(.bottom,22)
                    .background {
                        GeometryReader { content in
                            Color.clear.preference(
                                key:AgentScrollMetricsPreferenceKey.self,
                                value:AgentScrollMetrics(
                                    offset:max(0,-content.frame(in:.named("agent.conversation")).minY),
                                    contentHeight:content.size.height,
                                    viewportHeight:conversationViewportHeight
                                )
                            )
                        }
                    }
                }
                .coordinateSpace(name:"agent.conversation")
                .onPreferenceChange(AgentScrollMetricsPreferenceKey.self) { metrics in
                    let previous = conversationScrollMetrics
                    guard previous != metrics else { return }
                    conversationScrollMetrics = metrics
                    guard let previous else {
                        followsLatestConversation = metrics.isNearBottom
                        return
                    }
                    if metrics.offset < previous.offset - 2 {
                        followsLatestConversation = false
                        return
                    }
                    if metrics.offset > previous.offset + 2 && metrics.isNearBottom {
                        followsLatestConversation = true
                    }
                    let contentGrew = metrics.contentHeight > previous.contentHeight + 1
                    if contentGrew {
                        guard followsLatestConversation else { return }
                        Task { @MainActor in
                            await Task.yield()
                            guard followsLatestConversation else { return }
                            withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                                reader.scrollTo("pending",anchor:.bottom)
                            }
                        }
                        return
                    }
                    if metrics.isNearBottom {
                        followsLatestConversation = true
                    }
                }
                .scrollIndicators(.automatic)
                .background {
                    GeometryReader { viewport in
                        Color.clear
                            .onAppear { conversationViewportHeight = viewport.size.height }
                            .onChange(of:viewport.size.height) { height in
                                conversationViewportHeight = height
                            }
                    }
                }
                .overlay(alignment:.bottomTrailing) {
                    if (model.busy || model.zenRefinementActive) && !followsLatestConversation {
                        Button {
                            followsLatestConversation = true
                            withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                                reader.scrollTo("pending",anchor:.bottom)
                            }
                        } label: {
                            Label("最新进度",systemImage:"arrow.down.to.line")
                                .font(.system(size:10.5,weight:.medium))
                        }
                        .buttonStyle(.forgeText)
                        .controlSize(.small)
                        .padding(.trailing,16).padding(.bottom,12)
                        .accessibilityIdentifier("agent.scroll-to-progress")
                    }
                }
                .task(id:model.conversationScrollRequest) {
                    guard let request = model.conversationScrollRequest else { return }
                    await Task.yield()
                    guard !Task.isCancelled,
                          model.conversationScrollRequest == request,
                          model.selectedThreadId == request.threadId else { return }
                    withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                        if let messageId = request.messageId {
                            followsLatestConversation = false
                            reader.scrollTo(messageId,anchor:.center)
                        } else if let last = model.thread?.messages.last {
                            followsLatestConversation = true
                            reader.scrollTo(last.id,anchor:.bottom)
                        }
                    }
                    model.consumeConversationScrollRequest(request)
                }
                .onChange(of:model.thread?.messages.count) { _ in
                    if followsLatestConversation, let last = model.thread?.messages.last {
                        withAnimation(reduceMotion ? nil : .easeOut(duration:0.2)) { reader.scrollTo(last.id,anchor:.bottom) }
                    }
                }
                .onChange(of:model.busy) { busy in
                    guard busy else { return }
                    followsLatestConversation = true
                    Task { @MainActor in
                        await Task.yield()
                        withAnimation(reduceMotion ? nil : .easeOut(duration:0.2)) { reader.scrollTo("pending",anchor:.bottom) }
                    }
                }
            }
            VStack(alignment:.leading,spacing:0) {
                ZStack(alignment:.topLeading) {
                    if model.draft.isEmpty {
                        Text("输入消息或描述目标…")
                            .font(.system(size:13))
                            .foregroundStyle(.tertiary)
                            .padding(.leading,17).padding(.top,8)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text:$model.draft)
                        .focused($composerFocused)
                        .font(.system(size:13))
                        .foregroundStyle(ForgePalette.ink)
                        .scrollContentBackground(.hidden)
                        .frame(height:composerInputHeight)
                        .padding(.horizontal,12).padding(.top,8)
                        .disabled(voiceDictation.isRecording || voiceDictation.isStarting || model.zenRefinementActive)
                        .accessibilityLabel("Agent 消息")
                        .accessibilityHint("输入任务描述，按 Command Return 发送")
                        .accessibilityIdentifier("agent.composer")
                }
                if !model.pendingContextPaths.isEmpty || !model.pendingImageURLs.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing:7) {
                            ForEach(model.pendingContextPaths,id:\.self) { path in
                                contextChip(path,systemImage:"doc.text") {
                                    model.removePendingContextPath(path)
                                }
                            }
                            ForEach(model.pendingImageURLs,id:\.path) { url in
                                contextChip(url.lastPathComponent,systemImage:"photo") {
                                    model.removePendingImage(url)
                                }
                            }
                        }
                        .padding(.horizontal,13).padding(.bottom,7)
                    }
                    .scrollIndicators(.hidden)
                }
                HStack(spacing:7) {
                    Menu {
                        Button {
                            chooseAgentFiles(model)
                        } label: {
                            Label("添加文件上下文",systemImage:"doc.text")
                        }
                        .disabled(model.checkoutRoot == nil)
                        Divider()
                        Button {
                            chooseAgentImages(model)
                        } label: {
                            Label("添加图片",systemImage:"photo")
                        }
                        .disabled(!model.selectedProviderSupportsImages)
                    } label: {
                        Image(systemName:"paperclip").forgeChromeIcon()
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    .fixedSize()
                    .disabled(model.busy || model.zenRefinementActive
                        || (model.checkoutRoot == nil && !model.selectedProviderSupportsImages))
                    .help("添加当前工作区文件或图片")
                    .accessibilityLabel("添加上下文")
                    .accessibilityHint("添加当前工作区文件或当前模型服务支持的图片")
                    .accessibilityIdentifier("agent.attach")

                    composerQuickConfigurationControls
                        .disabled(model.busy || model.zenRefinementActive)

                    Spacer(minLength:12)

                    if voiceDictation.isRecording || voiceDictation.isStarting {
                        Text(voiceDictation.isStarting ? "正在请求麦克风…" : "正在听写…")
                            .font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                            .accessibilityLabel(voiceDictation.isStarting ? "正在请求麦克风" : "正在听写")
                            .accessibilityHint("完成或取消语音输入后才能发送消息")
                            .accessibilityIdentifier("agent.voice.recording")
                    } else if let issue = voiceDictation.error {
                        Text(issue)
                            .font(.system(size:10.5))
                            .foregroundStyle(.orange)
                            .lineLimit(1)
                            .help(issue)
                    }
                    if voiceDictation.isRecording {
                        Button {
                            voiceDictation.stop()
                            composerFocused = true
                        } label: {
                            Label("完成",systemImage:"checkmark")
                                .font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(ForgePalette.accent)
                                .frame(height:30)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                        .help("完成语音输入并保留已识别文字")
                        .accessibilityLabel("完成语音输入")
                        .accessibilityHint("停止听写并保留已识别的文字")
                        .accessibilityIdentifier("agent.voice.finish")

                        Button { cancelVoiceDictation() } label: {
                            Label("取消",systemImage:"xmark")
                                .font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                                .frame(height:30)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                        .help("取消语音输入并恢复开始前的草稿")
                        .accessibilityLabel("取消语音输入")
                        .accessibilityHint("丢弃本次识别文字并恢复原草稿")
                        .accessibilityIdentifier("agent.voice.cancel")
                    } else if voiceDictation.isStarting {
                        Button { cancelVoiceDictation() } label: {
                            Label("取消",systemImage:"xmark")
                                .font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                                .frame(height:30)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                        .help("取消语音输入并恢复开始前的草稿")
                        .accessibilityLabel("取消语音输入")
                        .accessibilityHint("取消权限请求，不会启动麦克风")
                        .accessibilityIdentifier("agent.voice.cancel")
                    } else {
                        Button {
                            voiceBaseDraft = model.draft
                            Task { await voiceDictation.start() }
                        } label: {
                            Image(systemName:"mic").forgeChromeIcon()
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy || model.zenRefinementActive)
                        .help("语音输入（只填入草稿，不自动发送）")
                        .accessibilityLabel("开始语音输入")
                        .accessibilityIdentifier("agent.voice.toggle")
                    }

                    if model.busy || model.zenRefinementActive {
                        Button { Task { await model.cancel() } } label: {
                            Image(systemName:"stop.fill").forgeChromeIcon()
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.escape,modifiers:[])
                        .help(model.zenRefinementActive ? "停止自动精化（Esc）" : "停止 Agent（Esc）")
                        .accessibilityLabel(model.zenRefinementActive ? "停止自动精化" : "停止 Agent")
                        .accessibilityHint(model.zenRefinementActive
                            ? "停止自动精化，并保留已收到的消息和工具回执"
                            : "停止当前正在进行的 Agent 请求"
                        )
                        .accessibilityIdentifier("agent.cancel")
                    } else {
                        let sendDisabled = model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                            || model.agentSendBlockReason != nil
                            || voiceDictation.blocksSend
                        Button {
                            guard !voiceDictation.blocksSend else { return }
                            Task { await model.send() }
                        } label: {
                            Image(systemName:"arrow.up")
                                .font(.system(size:ForgeClientDesign.Icon.point,weight:.bold))
                                .foregroundStyle(.white)
                                .frame(width:ForgeClientDesign.Icon.hit,height:ForgeClientDesign.Icon.hit)
                                .background(ForgePalette.accent,in:Circle())
                                .opacity(sendDisabled ? 0.34 : 1)
                        }
                        .buttonStyle(.plain)
                        .disabled(sendDisabled)
                        .keyboardShortcut(.return,modifiers:.command)
                        .help(voiceDictation.blocksSend ? "请先完成或取消语音输入" : model.agentSendBlockReason ?? "发送消息（⌘↵）")
                        .accessibilityLabel("发送消息")
                        .accessibilityValue(sendDisabled
                            ? (voiceDictation.blocksSend ? "听写中，完成或取消后可发送" : "不可发送")
                            : "可发送")
                        .accessibilityHint(voiceDictation.blocksSend
                            ? "请先完成或取消语音输入，再发送消息"
                            : "按 Command Return 发送")
                        .accessibilityIdentifier("agent.send")
                    }
                }.padding(.horizontal,13).padding(.bottom,8)
                if !model.busy,!model.zenRefinementActive,let reason = model.agentSendBlockReason {
                    HStack(alignment:.firstTextBaseline,spacing:5) {
                        Circle().fill(Color.orange.opacity(0.7)).frame(width:5,height:5)
                            .accessibilityHidden(true)
                        Text(reason)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .help(reason)
                        Spacer(minLength:6)
                        if !model.selectedProviderReady {
                            Button(model.selectedProvider == "codex" ? "刷新状态" : "打开设置") {
                                if model.selectedProvider == "codex" {
                                    Task { await model.refresh() }
                                } else {
                                    model.show(.settings)
                                }
                            }
                            .buttonStyle(.plain)
                            .fontWeight(.semibold)
                            .foregroundStyle(ForgePalette.accent)
                            .accessibilityIdentifier("agent.configure-provider")
                        }
                    }
                    .font(.system(size:10))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal,18).padding(.bottom,10)
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .accessibilityIdentifier("agent.send-block-reason")
                }
            }
            .background(ForgePalette.composer,
                        in:RoundedRectangle(cornerRadius:12,style:.continuous))
            .overlay {
                RoundedRectangle(cornerRadius:12,style:.continuous)
                    .strokeBorder(isComposerDropTarget ? ForgePalette.accent.opacity(0.5)
                                  : composerFocused ? ForgePalette.primaryHairlineFocused : Color.clear,
                                  lineWidth:isComposerDropTarget || composerFocused ? 1 : 0)
            }
            .animation(reduceMotion ? nil : .easeOut(duration:0.12),value:composerFocused)
            .dropDestination(for:URL.self) { urls, _ in
                guard !model.busy,!model.zenRefinementActive,!urls.isEmpty else { return false }
                model.addDroppedAttachments(urls)
                return true
            } isTargeted: { targeted in
                isComposerDropTarget = targeted && !model.busy && !model.zenRefinementActive
            }
                    .frame(maxWidth:ForgeClientDesign.Shell.readingColumn + 16)
                    .padding(.horizontal,14).padding(.bottom,12)
                    .frame(maxWidth:.infinity)
                }
                // Compact and maximized work surfaces replace the *presentation*,
                // not the mounted Agent transcript or its input state.
                .opacity(workSurfacePresentation == .replacement ? 0 : 1)
                .allowsHitTesting(workSurfacePresentation != .replacement)
                .accessibilityHidden(workSurfacePresentation == .replacement)

                if workSurfacePresentation == .replacement {
                    workSurfacePane()
                        .transition(reduceMotion ? .identity : .opacity)
                }
            }
            .frame(minWidth:AgentWorkSurfaceLayout.conversationMinimumWidth)
            .frame(maxWidth:.infinity,maxHeight:.infinity)

            if workSurfacePresentation == .sideBySide {
                workSurfacePane()
                    .frame(minWidth:AgentWorkSurfaceLayout.workSurfaceMinimumWidth,
                           idealWidth:max(390,availableWidth * 0.43),
                           maxWidth:max(480,availableWidth * 0.60))
            }
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
        }
        .background(ForgePalette.canvas)
        .overlay(alignment:.topTrailing) {
            agentWorkspaceStatusChip
                .padding(.top,8)
                .padding(.trailing,14)
        }
        .safeAreaInset(edge:.trailing,spacing:0) {
            if availableWidth >= 900, !workSurfaceVisible,
               let inspector = semanticInspector {
                semanticInspectorContent(inspector,inline:true)
                    .frame(width:320)
                    .frame(maxHeight:.infinity)
                    .background(ForgePalette.sidePanel)
                    .transition(reduceMotion ? .identity
                                : .move(edge:.trailing).combined(with:.opacity))
                    .accessibilityIdentifier("agent.context-inspector")
            }
        }
        // Only Planning/Knowledge remain lightweight floating context tools.
        .popover(isPresented:Binding(
            get:{ availableWidth < 900 && !workSurfaceVisible && semanticInspector != nil },
            set:{ if !$0 { semanticInspector = nil } }
        ),arrowEdge:.trailing) {
            if let inspector=semanticInspector {
                semanticInspectorContent(inspector,inline:false)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration:0.20),value:workSurfaceVisible)
        .onChange(of:workSurfaceVisible) { visible in
            if visible && (!AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: availableWidth) || workSurfaceMaximized) {
                restoreComposerFocusAfterWorkSurface = composerFocused
                composerFocused = false
            } else if !visible && restoreComposerFocusAfterWorkSurface {
                restoreComposerFocusAfterWorkSurface = false
                if !model.busy && !model.zenRefinementActive && !voiceDictation.blocksSend {
                    composerFocused = true
                }
            }
        }
        .onChange(of:workSurfaceMaximized) { maximized in
            guard workSurfaceVisible else { return }
            if maximized {
                restoreComposerFocusAfterWorkSurface = composerFocused
                composerFocused = false
            } else if AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: availableWidth) && restoreComposerFocusAfterWorkSurface {
                restoreComposerFocusAfterWorkSurface = false
                if !model.busy && !voiceDictation.blocksSend { composerFocused = true }
            }
        }
        .onChange(of:!AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: availableWidth)) { isCompact in
            // Keep the selected work surface mounted and selected. Only focus
            // changes when the compact presentation temporarily replaces chat.
            guard workSurfaceVisible && !workSurfaceMaximized else { return }
            if isCompact {
                restoreComposerFocusAfterWorkSurface = composerFocused
                composerFocused = false
            } else if restoreComposerFocusAfterWorkSurface {
                restoreComposerFocusAfterWorkSurface = false
                if !model.busy && !voiceDictation.blocksSend { composerFocused = true }
            }
        }
        .confirmationDialog(
            "将命令交给 Forge Agent？",
            isPresented:Binding(
                get:{ pendingAgentCommand != nil },
                set:{ if !$0 { pendingAgentCommand = nil } }
            ),
            titleVisibility:.visible
        ) {
            Button("发送执行请求") {
                guard let command = pendingAgentCommand, !model.busy,
                      !voiceDictation.blocksSend,
                      model.repoId != nil, model.checkoutId != nil else { return }
                pendingAgentCommand = nil
                model.draft = AgentMessageBlock.commandExecutionPrompt(command)
                Task { await model.send() }
            }
            .disabled(model.busy || voiceDictation.blocksSend)
            Button("取消",role:.cancel) { pendingAgentCommand = nil }
        } message: {
            Text("这会把命令发送给当前 Agent，可能修改项目文件。请先确认命令内容。")
        }
        .onAppear {
            // A restored selected surface remains selected at compact widths;
            // the layout presents it in place until side-by-side space returns.
            if !model.busy && !model.zenRefinementActive
                && !(workSurfaceVisible && (!AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: availableWidth) || workSurfaceMaximized)) {
                composerFocused = true
            }
        }
        .onChange(of:model.selectedThreadId) { _ in
            // The draft binding already targets the newly selected thread here.
            // Clear only transient recorder state; the old thread keeps its partial transcript.
            voiceDictation.cancel()
            semanticInspector = nil
            if workSurfaceVisible && selectedWorkSurface == .changes {
                Task { await model.refreshAgentChanges() }
            }
            if !workSurfaceVisible && !model.busy && !model.zenRefinementActive {
                composerFocused = true
            }
        }
        .onChange(of:voiceDictation.transcript) { transcript in
            guard !transcript.isEmpty else { return }
            model.draft = AgentVoiceDictation.mergedDraft(voiceBaseDraft,transcript:transcript)
        }
        .onChange(of:model.busy) { busy in
            if busy { voiceDictation.stop() }
        }
        .onDisappear { voiceDictation.stop() }
    }

    private func cancelVoiceDictation() {
        voiceDictation.cancel()
        model.draft = voiceBaseDraft
        composerFocused = true
    }

    private var agentActivityTitle: String {
        if model.zenRefinementActive { return "自动精化 · 第 \(model.zenRefinementRound)/\(ZenChangeProposal.refinementMaximumRounds) 轮" }
        return NativeWorkspace.agentActivityTitle(
            phase:model.liveActivity?.phase,
            lastActivity:model.liveActivity?.lastActivity,
            hasStreamedAnswer:!model.streamedAnswer.isEmpty,
            hasStreamedReasoning:!model.streamedReasoning.isEmpty
        )
    }

    private var agentEmptyStateDescription: String {
        if model.isProjectOnlyConversation {
            if let reason = model.agentSendBlockReason { return reason }
            return "当前项目可用于需求与计划对话；关联本地工作区后即可执行代码操作。"
        }
        if model.thread?.repoId != nil && model.thread?.checkoutId == nil {
            return "当前会话关联了项目，但没有可用工作区；请选择工作区后即可执行代码操作。"
        }
        if model.thread?.repoId == nil {
            return model.projects.isEmpty
                ? "添加本地项目后即可处理代码；也可以不选项目直接对话。"
                : "选择项目和工作区后即可处理代码；也可以不选项目直接对话。"
        }
        if !model.checkoutIsAvailable { return "当前工作区尚未就绪，请重新选择项目或工作区。" }
        if !model.selectedProviderReady { return "已选择项目。设置可用模型后即可开始任务。" }
        return "描述你想完成的工作，或选择下方的常用操作。"
    }

    private func openWorkSurface(_ surface: AgentWorkSurface) {
        let newlyOpened = !workSurfaceVisible || selectedWorkSurface != surface
        selectedWorkSurfaceRaw = surface.rawValue
        workSurfaceVisible = true
        semanticInspector = nil
        // Do not reset file selection when the already-selected tab is clicked.
        if newlyOpened && surface == .changes {
            Task { await model.refreshAgentChanges() }
        }
    }

    private func closeWorkSurface() {
        workSurfaceVisible = false
        workSurfaceMaximized = false
    }

    private func workSurfacePane() -> some View {
        VStack(spacing:0) {
            HStack(spacing:6) {
                rightPaneTabStrip
                Spacer(minLength:6)
                Button {
                    withAnimation(reduceMotion ? nil : .easeOut(duration:0.18)) {
                        workSurfaceMaximized.toggle()
                    }
                } label: {
                    Image(systemName:workSurfaceMaximized
                          ? "arrow.down.right.and.arrow.up.left"
                          : "arrow.up.left.and.arrow.down.right")
                        .forgeChromeIcon()
                }
                .buttonStyle(.plain)
                .help(workSurfaceMaximized ? "退出扩展视图" : "扩展右侧分栏")
                .accessibilityIdentifier("agent.work-surface.maximize")
                Button {
                    closeWorkSurface()
                } label: {
                    Image(systemName:"xmark").forgeChromeIcon()
                }
                .buttonStyle(.plain)
                .help("关闭右侧分栏")
                .accessibilityLabel("关闭右侧分栏")
                .accessibilityIdentifier("agent.work-surface.close")
            }
            .padding(.horizontal,10)
            .frame(height:ForgeClientDesign.Icon.hit)

            ZStack {
                AgentChangesPane(model:model)
                    .opacity(selectedWorkSurface == .changes ? 1 : 0)
                    .allowsHitTesting(selectedWorkSurface == .changes)
                    .accessibilityHidden(selectedWorkSurface != .changes)

                AgentAssetsDashboard(
                    model:model,
                    selectedRepoId:$fileSelectedRepoId,
                    showLocalResources:$fileShowLocalResources,
                    showRemoteImages:$fileShowRemoteImages,
                    searchQuery:$fileSearchQuery,
                    selectedResourceID:$fileSelectedResourceID
                )
                .opacity(selectedWorkSurface == .files ? 1 : 0)
                .allowsHitTesting(selectedWorkSurface == .files)
                .accessibilityHidden(selectedWorkSurface != .files)
            }
            .frame(maxWidth:.infinity,maxHeight:.infinity)
        }
        .background(ForgePalette.canvas)
    }

    @ViewBuilder
    private func semanticInspectorContent(_ kind: AgentSemanticContextInspector,
                                          inline:Bool) -> some View {
        switch kind {
        case .planning:
            AgentPlanningInspector(model:model,inline:inline) { semanticInspector = nil }
        case .knowledge:
            AgentKnowledgeInspector(model:model,inline:inline) { semanticInspector = nil }
        }
    }

    private func starterPromptButton(
        _ title: String,
        systemImage: String,
        prompt: String,
        requiresCheckout: Bool = true
    ) -> some View {
        Button {
            guard !voiceDictation.blocksSend else { return }
            model.draft = prompt
            composerFocused = true
        } label: {
            HStack(spacing:6) {
                Image(systemName:systemImage).font(.system(size:11,weight:.medium))
                Text(title)
            }
            .font(.system(size:11.5,weight:.medium))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.horizontal,12)
            .frame(height:30)
            .contentShape(Rectangle())
            .forgeHoverFill(cornerRadius:9)
        }
        .buttonStyle(.plain)
        .disabled(model.busy || voiceDictation.blocksSend || (requiresCheckout && model.checkoutId == nil))
        .help(voiceDictation.blocksSend
            ? "请先完成或取消语音输入"
            : requiresCheckout && model.checkoutId == nil ? "请先选择包含可用工作区的项目" : title)
    }

    @State private var expandedActivityEventIDs: Set<String> = []
    @State private var copiedActivityEventID: String?

    private func activityTrailRow(_ event: AgentLiveActivityEvent) -> some View {
        HStack(alignment:.top,spacing:8) {
            ZStack {
                Circle()
                    .fill(activityStatusColor(event).opacity(event.status == "running" ? 0.07 : 0.11))
                    .frame(width:21,height:21)
                Image(systemName:activityStatusIcon(event))
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(activityStatusColor(event))
            }
            VStack(alignment:.leading,spacing:2) {
                Text(event.label)
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size:9.5,design:.monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(event.phase == "message" ? 7 : 2)
                        .textSelection(.enabled)
                }
                if let output=NativeWorkspace.activityOutputPresentation(for:event) {
                    let isExpanded=expandedActivityEventIDs.contains(event.id)
                    let isCopied=copiedActivityEventID == event.id
                    VStack(alignment:.leading,spacing:5) {
                        HStack(spacing:8) {
                            Text("工具输出")
                                .font(.system(size:9,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                            Spacer(minLength:4)
                            Button {
                                if isExpanded { expandedActivityEventIDs.remove(event.id) }
                                else { expandedActivityEventIDs.insert(event.id) }
                                if copiedActivityEventID == event.id { copiedActivityEventID=nil }
                            } label: {
                                Text(isExpanded ? "收起" : "展开")
                                    .font(.system(size:9,weight:.medium))
                            }
                            .buttonStyle(.plain)
                            .help(isExpanded ? "收起此条工具输出" : "展开查看此条保留的完整输出")
                            .accessibilityLabel(isExpanded ? "收起此条工具输出" : "展开此条工具输出")
                            .accessibilityHint("展开后可滚动查看当前保留的输出内容。")
                            .accessibilityIdentifier("agent.activity.output.toggle.\(event.id)")
                            Button {
                                copyAgentText(output.text)
                                copiedActivityEventID=event.id
                            } label: {
                                Image(systemName:isCopied ? "checkmark" : "doc.on.doc")
                                    .font(.system(size:9,weight:.medium))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(isCopied ? Color.green : ForgePalette.secondary)
                            .help(isCopied ? "已复制此条工具输出" : "复制此条工具输出")
                            .accessibilityLabel(isCopied ? "已复制此条工具输出" : "复制此条工具输出")
                            .accessibilityIdentifier("agent.activity.output.copy.\(event.id)")
                        }
                        if let truncationLabel=output.truncationLabel {
                            Text(truncationLabel)
                                .font(.system(size:10.5,weight:.medium))
                                .foregroundStyle(Color.orange)
                                .fixedSize(horizontal:false,vertical:true)
                                .frame(maxWidth:.infinity,alignment:.leading)
                                .help(truncationLabel)
                                .accessibilityLabel(truncationLabel)
                                .accessibilityHint("当前输出可能不完整，不应当作完整日志。")
                                .accessibilityIdentifier("agent.activity.output.truncation.\(event.id)")
                        }
                        if isExpanded {
                            ScrollView {
                                Text(output.text)
                                    .font(.system(size:9,design:.monospaced))
                                    .foregroundStyle(ForgePalette.ink.opacity(0.82))
                                    .frame(maxWidth:.infinity,alignment:.leading)
                                    .fixedSize(horizontal:false,vertical:true)
                                    .textSelection(.enabled)
                            }
                            .frame(maxHeight:220)
                            .accessibilityIdentifier("agent.activity.output.detail.\(event.id)")
                        } else {
                            Text(output.text)
                                .font(.system(size:9,design:.monospaced))
                                .foregroundStyle(ForgePalette.ink.opacity(0.82))
                                .lineLimit(6)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.top,2)
                }
            }
            Spacer(minLength:8)
            if event.status == "failed" {
                Text("失败")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(Color.red)
            } else if event.status == "unknown" {
                Text("结果未知")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(Color.orange)
            }
        }
    }

    private func activityStatusColor(_ event: AgentLiveActivityEvent) -> Color {
        if event.phase == "message" { return ForgePalette.secondary }
        switch event.status {
        case "completed": return Color.green
        case "failed": return Color.red
        case "unknown": return Color.orange
        default: return ForgePalette.secondary
        }
    }

    private func activityStatusIcon(_ event: AgentLiveActivityEvent) -> String {
        if event.phase == "message" { return "text.bubble" }
        switch event.status {
        case "completed": return "checkmark"
        case "failed": return "exclamationmark"
        case "unknown": return "questionmark.circle"
        default: return activityIcon(event.phase)
        }
    }

    @ViewBuilder
    private var composerQuickConfigurationControls: some View {
        if model.thread?.readOnly == true {
            Label("只读",systemImage:"lock.fill")
                .font(.system(size:10,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .accessibilityIdentifier("agent.read-only")
            Button {
                model.openWorkbench()
            } label: {
                Label("返回 Zen",systemImage:"arrow.uturn.backward")
                    .font(.system(size:10,weight:.medium))
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            .help("返回 Zen 审阅提案")
            .accessibilityIdentifier("agent.return-to-zen")
        }
        if showsQuickProviderPicker {
            quickProviderMenu
        }
        quickModelMenu
        if model.selectedProvider == "codex" && !model.selectedReasoningOptions.isEmpty {
            quickReasoningMenu
        }
        if model.thread?.readOnly != true,
           model.checkoutId != nil,
           NativeWorkspace.matchesExternalProvider(model.selectedProvider) {
            quickRepositoryAccessMenu
        }
    }

    private var showsQuickProviderPicker: Bool {
        !providerSelectionLocked && quickProviderCount > 1
    }

    private var quickProviderCount: Int {
        let profiles = model.localApiSettings?.profiles ?? []
        var count = model.localProviderReady ? 1 : 0
        count += profiles.filter(\.endpointReady).count
        if model.joyCodeProfileReady { count += 1 }
        // Preserve the currently bound provider even if its profile is temporarily unavailable.
        if model.selectedProvider == "codex" && !model.localProviderReady { count += 1 }
        if model.selectedProvider == "joycode" && !model.joyCodeProfileReady { count += 1 }
        if let selectedProfile = profiles.first(where: { $0.providerId == model.selectedProvider }) {
            if !selectedProfile.endpointReady { count += 1 }
        } else if model.selectedProvider != "codex" && model.selectedProvider != "joycode" {
            count += 1
        }
        return count
    }

    private var providerSelectionLocked: Bool {
        model.busy
    }

    private var quickProviderMenu: some View {
        Menu {
            Button {
                model.selectThreadProvider("codex")
            } label: {
                if model.selectedProvider == "codex" {
                    Label("Codex",systemImage:"checkmark")
                } else {
                    Text("Codex")
                }
            }
            .disabled(model.thread?.readOnly == true || (!model.localProviderReady && model.selectedProvider != "codex"))

            if let profiles = model.localApiSettings?.profiles {
                ForEach(profiles) { profile in
                    Button {
                        model.selectThreadProvider(profile.providerId)
                    } label: {
                        if model.selectedProvider == profile.providerId {
                            Label(profile.label,systemImage:"checkmark")
                        } else {
                            Text(profile.label)
                        }
                    }
                    .disabled(!profile.endpointReady && model.selectedProvider != profile.providerId)
                }
            }

            if model.joyCodeProfileReady || model.selectedProvider == "joycode" {
                Button {
                    model.selectThreadProvider("joycode")
                } label: {
                    if model.selectedProvider == "joycode" {
                        Label("JoyCode",systemImage:"checkmark")
                    } else {
                        Text("JoyCode")
                    }
                }
                .disabled(!model.joyCodeProfileReady)
            }
        } label: {
            quickControlLabel(
                quickProviderLabel,
                systemImage:model.selectedProvider == "joycode" ? "sparkles" :
                    (NativeWorkspace.matchesExternalProvider(model.selectedProvider) ? "server.rack" : "cpu")
            )
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize()
        .disabled(providerSelectionLocked)
        .help("切换当前会话的模型服务；已有消息保留，默认服务只影响新会话")
        .accessibilityLabel("模型服务")
        .accessibilityValue(quickProviderLabel)
        .accessibilityIdentifier("agent.provider.quick")
    }

    private var quickModelMenu: some View {
        Menu {
            if model.selectedProvider == "codex" {
                ForEach(model.agentModels) { option in
                    Button {
                        model.selectAgentModel(option.slug)
                    } label: {
                        if model.selectedAgentModel?.slug == option.slug {
                            Label(option.displayName,systemImage:"checkmark")
                        } else {
                            Text(option.displayName)
                        }
                    }
                    .disabled(model.busy)
                }
            } else {
                let label = model.selectedApiModel.isEmpty ? "未配置模型" : model.selectedApiModel
                Button(label) {}
                    .disabled(true)
                Divider()
                Button("前往模型服务设置…") {
                    model.show(.settings)
                }
                .disabled(model.busy)
            }
        } label: {
            quickControlLabel(quickModelLabel,systemImage:"cube")
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.busy || (model.selectedProvider == "codex" && model.agentModels.isEmpty))
        .help(model.selectedProvider == "codex" ? "切换模型" : "当前模型由外部服务提供；配置可在设置中管理")
        .accessibilityLabel("模型")
        .accessibilityValue(quickModelLabel)
        .accessibilityIdentifier("agent.model.quick")
    }

    private var quickReasoningMenu: some View {
        Menu {
            ForEach(model.selectedReasoningOptions) { option in
                Button {
                    model.selectReasoningEffort(option.effort)
                } label: {
                    let label = reasoningLabel(option.effort)
                    if model.selectedReasoningEffort == option.effort {
                        Label(label,systemImage:"checkmark")
                    } else {
                        Text(label)
                    }
                }
                .disabled(model.busy)
            }
        } label: {
            quickControlLabel(reasoningLabel(model.selectedReasoningEffort),systemImage:"brain.head.profile")
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.busy)
        .help("切换当前模型的推理强度")
        .accessibilityLabel("推理强度")
        .accessibilityValue(reasoningLabel(model.selectedReasoningEffort))
        .accessibilityIdentifier("agent.reasoning.quick")
    }

    private var quickRepositoryAccessMenu: some View {
        Menu {
            Button {
                Task { _ = await model.setRepositoryAccessMode("request") }
            } label: {
                if model.repositoryAccessMode == "request" {
                    Label("请求权限",systemImage:"checkmark")
                } else {
                    Text("请求权限")
                }
            }

            Button {
                Task { _ = await model.setRepositoryAccessMode("full_access") }
            } label: {
                if model.repositoryAccessMode == "full_access" {
                    Label("完全访问",systemImage:"checkmark")
                } else {
                    Text("完全访问")
                }
            }
            Divider()
            Button {
                Task { await model.loadRepositoryAccess() }
            } label: {
                Label("重新读取权限",systemImage:"arrow.clockwise")
            }
            .help("从当前项目重新读取已保存的权限模式")
            .accessibilityLabel("重新读取项目权限")
            .accessibilityHint("重新读取当前项目的权限状态；读取期间暂停发送")
            .accessibilityIdentifier("agent.repository-access.retry")
        } label: {
            quickControlLabel(
                model.repositoryAccessMode == "full_access" ? "完全访问" : "请求权限",
                systemImage:model.repositoryAccessMode == "full_access" ? "checkmark.shield" : "lock"
            )
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.busy || model.repositoryAccessLoading)
        .help("当前模型服务的项目权限")
        .accessibilityLabel("项目权限")
        .accessibilityValue(model.repositoryAccessMode == "full_access" ? "完全访问" : "请求权限")
        .accessibilityIdentifier("agent.repository-access.quick")
    }

    private func quickControlLabel(_ title:String,systemImage:String) -> some View {
        HStack(spacing:4) {
            Image(systemName:systemImage)
                .font(ForgeClientDesign.Icon.font)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(ForgePalette.secondary)
            Text(title)
                .font(.system(size:11,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName:"chevron.down")
                .font(.system(size:7,weight:.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal,4)
        .frame(height:ForgeClientDesign.Icon.hit)
        .contentShape(Rectangle())
    }

    private var quickProviderLabel: String {
        if model.selectedProvider == "codex" { return "Codex" }
        if model.selectedProvider == "joycode" { return "JoyCode" }
        return model.localApiSettings?.profiles.first(where: { $0.providerId == model.selectedProvider })?.label ?? "API"
    }

    private var quickModelLabel: String {
        if model.selectedProvider == "codex" {
            return model.selectedAgentModel?.displayName ?? "模型"
        }
        return model.selectedApiModel.isEmpty ? "模型" : model.selectedApiModel
    }

    private func activityIcon(_ phase: String) -> String {
        switch phase {
        case "tool": return "hammer"
        case "responding": return "text.bubble"
        case "finishing": return "checkmark.circle"
        case "thinking": return "brain.head.profile"
        default: return "bolt"
        }
    }

    private func contextChip(_ title: String, systemImage: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing:6) {
            Image(systemName:systemImage)
                .font(.system(size:9.5,weight:.medium))
            Text(title).lineLimit(1)
            Button(action:remove) {
                Image(systemName:"xmark")
                    .font(.system(size:8,weight:.semibold))
            }
            .buttonStyle(.plain)
        }
        .font(.system(size:10.5,weight:.medium))
        .foregroundStyle(ForgePalette.secondary)
        .padding(.horizontal,8)
        .frame(height:25)
        .background(ForgePalette.softFill,
                    in:RoundedRectangle(cornerRadius:8,style:.continuous))
    }

    private func reasoningLabel(_ effort: String) -> String {
        switch effort.lowercased() {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "XHigh"
        case "max": return "Max"
        case "ultra": return "Ultra"
        case "": return "Reasoning"
        default: return effort
        }
    }
}

@MainActor
private func chooseAgentFiles(_ model: NativeWorkspace) {
    guard let checkoutRoot = model.checkoutRoot else { return }
    let panel = NSOpenPanel()
    panel.directoryURL = checkoutRoot
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    panel.prompt = "添加"
    panel.message = "选择当前 checkout 内的文件作为 Agent 上下文"
    if panel.runModal() == .OK {
        model.addPendingContextFiles(panel.urls)
    }
}

@MainActor
private func chooseAgentImages(_ model: NativeWorkspace) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [.image]
    panel.prompt = "添加"
    if panel.runModal() == .OK {
        model.addPendingImages(panel.urls)
    }
}

func copyAgentText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text,forType:.string)
}

struct AgentChangesPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var commitMessage = ""
    @State private var restoreSnapshot: AgentGitDiff?
    @State private var focusedPath: String?
    @State private var focusedChanges: AgentGitDiff?
    @State private var focusedLoading = false
    @State private var reviewStaged = false

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            if model.changesLoading {
                VStack(spacing:9) {
                    ProgressView().controlSize(.small)
                    Text("读取当前工作区…")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let changes = model.agentChanges {
                let reviewed = focusedChanges ?? changes
                GeometryReader { geometry in
                    if changes.nameOnly.isEmpty {
                        ScrollView {
                            VStack(alignment:.leading,spacing:14) {
                                changeScopeHeader(changes)
                                if !changes.untrackedFiles.isEmpty {
                                    untrackedChangesNotice(changes.untrackedFiles)
                                }
                                VStack(spacing:10) {
                                    Image(systemName:"checkmark.circle")
                                        .font(.system(size:24,weight:.light))
                                        .foregroundStyle(ForgePalette.secondary)
                                    Text(changes.untrackedFiles.isEmpty
                                         ? (changes.staged ? "暂存区没有改动" : "工作区没有未提交改动")
                                         : "没有可审查的已跟踪文件改动")
                                        .font(.system(size:12,weight:.medium))
                                        .foregroundStyle(ForgePalette.secondary)
                                }
                                .frame(maxWidth:.infinity)
                                .padding(.vertical,48)
                            }
                            .padding(14)
                        }
                    } else if geometry.size.width >= 780 {
                        // A file navigator and an independent patch reader,
                        // both in the original reviewed checkout scope.
                        HStack(alignment:.top,spacing:0) {
                            ScrollView {
                                VStack(alignment:.leading,spacing:14) {
                                    changeScopeHeader(changes)
                                    if !changes.untrackedFiles.isEmpty {
                                        untrackedChangesNotice(changes.untrackedFiles)
                                    }
                                    changeFileNavigator(changes)
                                }
                                .padding(12)
                            }
                            .frame(width:min(300,max(230,geometry.size.width * 0.27)))
                            .frame(maxHeight:.infinity)
                            .accessibilityIdentifier("changes.file-navigator")

                            ScrollView {
                                changeReviewContent(reviewed)
                                    .padding(.horizontal,18)
                                    .padding(.vertical,14)
                            }
                            .frame(maxWidth:.infinity,maxHeight:.infinity)
                            .accessibilityIdentifier("changes.patch-reader")
                        }
                        .accessibilityIdentifier("changes.review-split")
                    } else {
                        // Keep the diff visible at all times on a 400–700pt
                        // right work surface; a file menu replaces stacked file rows.
                        VStack(alignment:.leading,spacing:0) {
                            HStack(spacing:8) {
                                compactChangeFileMenu(changes)
                                Spacer(minLength:8)
                                Text("\(changes.nameOnly.count) 个文件")
                                    .font(.system(size:10.5))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .monospacedDigit()
                            }
                            .padding(.horizontal,14)
                            .frame(height:36)
                            .accessibilityIdentifier("changes.compact-file-toolbar")

                            ScrollView {
                                VStack(alignment:.leading,spacing:12) {
                                    changeReviewContent(reviewed)
                                    if !changes.untrackedFiles.isEmpty {
                                        untrackedChangesNotice(changes.untrackedFiles)
                                    }
                                }
                                .padding(.horizontal,12).padding(.vertical,8)
                            }
                            .frame(maxWidth:.infinity,maxHeight:.infinity)
                            .accessibilityIdentifier("changes.patch-reader")
                        }
                        .accessibilityIdentifier("changes.review-compact")
                    }
                }
            } else {
                VStack(spacing:10) {
                    Image(systemName:"doc.text.magnifyingglass")
                        .font(.system(size:24,weight:.light))
                        .foregroundStyle(ForgePalette.secondary)
                    Text("打开改动审查后读取当前工作区。")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity)
            }
        }
        .onChange(of:model.agentChanges?.staged) { staged in
            if let staged { reviewStaged = staged }
        }
        .onChange(of:model.changesLoading) { loading in
            guard loading else { return }
            focusedPath = nil
            focusedChanges = nil
            focusedLoading = false
            restoreSnapshot = nil
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
        .background(ForgePalette.canvas)
        .alert("放弃已审查改动？",isPresented:Binding(
            get:{ restoreSnapshot != nil },
            set:{ if !$0 { restoreSnapshot = nil } }
        )) {
            Button("取消",role:.cancel) { restoreSnapshot = nil }
            Button("放弃改动",role:.destructive) {
                guard let snapshot = restoreSnapshot else { return }
                restoreSnapshot = nil
                Task {
                    if await model.restoreAgentChanges(snapshot) {
                        focusedPath = nil
                        focusedChanges = nil
                    }
                }
            }
        } message: {
            Text("仅恢复本次审查中的未暂存文件；已暂存、新文件或内容已变化的文件不会被恢复。")
        }
        .accessibilityElement(children:.contain)
        .accessibilityLabel("改动审查")
    }

    private func selectReviewPath(_ path: String?) {
        guard !focusedLoading else { return }
        if let path {
            focusedPath = path
            focusedChanges = nil
            focusedLoading = true
            Task {
                let snapshot = await model.reviewAgentChanges(paths:[path],staged:reviewStaged)
                focusedLoading = false
                if let snapshot {
                    focusedChanges = snapshot
                } else {
                    focusedPath = nil
                }
            }
        } else {
            focusedPath = nil
            focusedChanges = nil
        }
    }

    private func compactChangeFileMenu(_ changes:AgentGitDiff) -> some View {
        Menu {
            Button {
                selectReviewPath(nil)
            } label: {
                if focusedPath == nil {
                    Label("全部改动",systemImage:"checkmark")
                } else {
                    Text("全部改动")
                }
            }
            Divider()
            ForEach(changes.nameOnly,id:\.self) { path in
                Button {
                    selectReviewPath(path)
                } label: {
                    if focusedPath == path {
                        Label(fileName(path),systemImage:"checkmark")
                    } else {
                        Text(fileName(path))
                    }
                }
                .help(path)
            }
        } label: {
            HStack(spacing:5) {
                Image(systemName:"doc.text")
                Text(focusedPath.map(fileName) ?? "全部改动")
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName:"chevron.down")
                    .font(.system(size:9,weight:.medium))
            }
            .font(.system(size:11,weight:.medium))
            .foregroundStyle(ForgePalette.ink)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .fixedSize()
        .frame(maxWidth:230,alignment:.leading)
        .disabled(focusedLoading)
        .accessibilityLabel("选择审查文件")
        .accessibilityIdentifier("changes.file-selector")
    }

    private func changeFileNavigator(_ changes:AgentGitDiff) -> some View {
        VStack(alignment:.leading,spacing:6) {
            Button {
                selectReviewPath(nil)
            } label: {
                HStack(spacing:7) {
                    Image(systemName:"rectangle.stack")
                        .font(.system(size:10))
                    Text("全部改动")
                        .font(.system(size:10.5,weight:.medium))
                    Spacer(minLength:0)
                    Text("\(changes.nameOnly.count)")
                        .font(.system(size:9.5))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal,8)
                .frame(height:26)
                .background(focusedPath == nil ? ForgePalette.selection : Color.clear)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(focusedLoading)

            ForEach(changes.nameOnly,id:\.self) { path in
                Button {
                    selectReviewPath(path)
                } label: {
                    HStack(spacing:8) {
                        Image(systemName:"doc")
                            .font(.system(size:10))
                            .foregroundStyle(ForgePalette.secondary)
                            .frame(width:14)
                        VStack(alignment:.leading,spacing:1) {
                            Text(fileName(path))
                                .font(.system(size:10.5,weight:.medium))
                                .lineLimit(1)
                            if !parentPath(path).isEmpty {
                                Text(parentPath(path))
                                    .font(.system(size:9,design:.monospaced))
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                        Spacer(minLength:0)
                    }
                    .padding(.horizontal,8)
                    .frame(height:26)
                    .background(focusedPath == path ? ForgePalette.selection : Color.clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(focusedLoading)
            }
        }
    }

    private func changeReviewContent(_ reviewed:AgentGitDiff) -> some View {
        VStack(alignment:.leading,spacing:14) {
            if focusedLoading {
                HStack(spacing:7) {
                    ProgressView().controlSize(.small)
                    Text("读取文件改动…")
                        .font(.system(size:10.5))
                        .foregroundStyle(ForgePalette.secondary)
                }
            } else {
                HStack(spacing:8) {
                    if !reviewed.stat.isEmpty {
                        Text(reviewed.stat.split(separator:"\n").last.map(String.init)?
                                .trimmingCharacters(in:.whitespaces) ?? reviewed.stat)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .lineLimit(1)
                            .textSelection(.enabled)
                    }
                    Spacer(minLength:8)
                    if !reviewed.patch.isEmpty {
                        Button {
                            copyAgentText(reviewed.patch)
                        } label: {
                            Label("复制改动",systemImage:"doc.on.doc")
                                .font(.system(size:9.5,weight:.medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(ForgePalette.secondary)
                        .help("复制当前已审查改动")
                    }
                }
            }

            if !focusedLoading && !reviewed.patch.isEmpty {
                ScrollView(.horizontal) {
                    AgentDiffPatchView(patch:reviewed.patch)
                        .fixedSize(horizontal:true,vertical:false)
                }
                .scrollIndicators(.automatic)
                .accessibilityIdentifier("changes.patch-scroll")
            }

            if reviewed.truncated {
                Label("改动内容过多，无法提交。请缩小本次审查范围。",systemImage:"exclamationmark.triangle")
                    .font(.system(size:10.5))
                    .foregroundStyle(ForgePalette.secondary)
            }

            VStack(alignment:.leading,spacing:8) {
                HStack {
                    Text("提交已审查改动")
                        .font(.system(size:11,weight:.semibold))
                    Spacer()
                    Text(focusedPath ?? "\(reviewed.nameOnly.count) 个文件")
                        .font(.system(size:10))
                        .foregroundStyle(.tertiary)
                }
                TextField("提交说明",text:$commitMessage)
                    .textFieldStyle(.plain)
                    .font(.system(size:11.5))
                    .padding(.vertical,6)
                HStack(spacing:10) {
                    Text("提交前会再次确认这些改动未变化。")
                        .font(.system(size:9.5))
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                    Spacer(minLength:8)
                    if reviewed.staged {
                        Text("已暂存改动仅支持提交")
                            .font(.system(size:9.5,weight:.medium))
                            .foregroundStyle(.tertiary)
                            .help("不会跨越暂存区边界放弃改动")
                    } else {
                        Button(role:.destructive) {
                            restoreSnapshot = reviewed
                        } label: {
                            Text("放弃")
                                .font(.system(size:11,weight:.medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.red)
                        .disabled(model.changesLoading || focusedLoading
                                  || reviewed.truncated || reviewed.patch.isEmpty)
                        .help("放弃当前已复查的未暂存改动")
                    }
                    Button {
                        let snapshot = reviewed
                        let message = commitMessage
                        Task {
                            if await model.commitAgentChanges(snapshot,message:message) {
                                commitMessage = ""
                                focusedPath = nil
                                focusedChanges = nil
                            }
                        }
                    } label: {
                        Text("提交")
                            .font(.system(size:11,weight:.semibold))
                            .foregroundStyle(ForgePalette.accent)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.changesLoading || focusedLoading || reviewed.truncated
                              || reviewed.patch.isEmpty
                              || commitMessage.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.top,4)
        }
        .frame(maxWidth:.infinity,alignment:.leading)
    }

    private func untrackedChangesNotice(_ paths:[String]) -> some View {
        VStack(alignment:.leading,spacing:4) {
            Text("\(paths.count) 个新文件未纳入本次审查")
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(Color.orange.opacity(0.9))
            ForEach(Array(paths.prefix(4)),id:\.self) { path in
                Text(path)
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if paths.count > 4 {
                Text("另有 \(paths.count - 4) 个新文件")
                    .font(.system(size:9.5))
                    .foregroundStyle(.tertiary)
            }
            Text("这些文件不会自动纳入提交或放弃操作。")
                .font(.system(size:9.5))
                .foregroundStyle(.tertiary)
        }
        .accessibilityIdentifier("changes.untracked")
    }

    private func changeScopeHeader(_ changes: AgentGitDiff) -> some View {
        VStack(alignment:.leading,spacing:8) {
            HStack(spacing:8) {
                Label(changes.branch,systemImage:"arrow.triangle.branch")
                    .font(.system(size:11,weight:.semibold))
                    .lineLimit(1)
                Spacer(minLength:8)
                Text(changes.staged ? "已暂存" : "未暂存")
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(changes.staged ? ForgePalette.accent : ForgePalette.secondary)
                    .padding(.horizontal,7)
                    .frame(height:20)

            }
            HStack {
                Text("\(changes.nameOnly.count) 个文件")
                    .font(.system(size:9.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer(minLength:0)
            }
        }
        .padding(.horizontal,2)
        .padding(.vertical,4)
    }

    private func fileName(_ path: String) -> String {
        path.split(separator:"/").last.map(String.init) ?? path
    }

    private func parentPath(_ path: String) -> String {
        let parts = path.split(separator:"/")
        guard parts.count > 1 else { return "" }
        return parts.dropLast().joined(separator:"/")
    }
}

struct AgentDiffPatchView: View {
    let patch: String

    private var lines: [String] {
        patch.split(separator:"\n",omittingEmptySubsequences:false).map(String.init)
    }

    var body: some View {
        LazyVStack(alignment:.leading,spacing:0) {
            ForEach(Array(lines.enumerated()),id:\.offset) { _, line in
                Text(line.isEmpty ? " " : line)
                    .font(.system(size:10,design:.monospaced))
                    .foregroundStyle(foreground(line))
                    .textSelection(.enabled)
                    .padding(.horizontal,2)
                    .padding(.vertical,1)
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .background(background(line))
            }
        }
        .padding(.vertical,2)
    }

    private func background(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.07) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.065) }
        if line.hasPrefix("@@") { return ForgePalette.selection.opacity(0.72) }
        return .clear
    }

    private func foreground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.82) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.80) }
        if line.hasPrefix("@@") || line.hasPrefix("diff --git") { return ForgePalette.secondary }
        return ForgePalette.ink
    }
}

struct PlanningAuthoringContext: Identifiable {
    enum Kind { case requirement, plan }
    let id = UUID()
    let kind: Kind
    let requirementId: String?
    let parentPlanId: String?
}

struct AutopilotApprovalContext: Identifiable {
    let repoId: String
    let checkoutId: String
    let requirement: RequirementRecordDetail
    let status: AutopilotStatusDetail?
    var id: String { "\(repoId)|\(checkoutId)|\(requirement.requirementId)|\(requirement.revision)" }
}

struct AgentPlanningInspector: View {
    @ObservedObject var model: NativeWorkspace
    var inline: Bool = false
    let dismiss: () -> Void
    @State private var records: [ForgeRecord] = []
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var loadToken = UUID()
    @State private var loadedScopeKey: String?

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.top,spacing:10) {
                VStack(alignment:.leading,spacing:3) {
                    Text("规划上下文").font(.system(size:13,weight:.semibold))
                    Text("只关联当前会话，不会修改需求或计划。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName:"xmark")
                        .font(.system(size:9,weight:.semibold))
                        .frame(width:24,height:24)
                }
                .buttonStyle(.plain)
                .help("关闭规划上下文")
                .accessibilityLabel("关闭规划上下文")
                .accessibilityIdentifier("agent.planning-inspector.close")
            }
            .padding(.horizontal,14).padding(.vertical,12)

            Color.clear.frame(height:6)
            HStack(alignment:.top,spacing:9) {
                Image(systemName:currentBoundRecord == nil ? "paperclip" : "paperclip.circle.fill")
                    .font(.system(size:10,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:18,height:18)
                VStack(alignment:.leading,spacing:3) {
                    Text("当前会话")
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(.tertiary)
                    if let record=currentBoundRecord {
                        Text(record.title)
                            .font(.system(size:11.5,weight:.semibold))
                            .lineLimit(2)
                        Text(currentContextLabel ?? record.recordId)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    } else if let contextLabel=currentContextLabel {
                        Text(contextLabel)
                            .font(.system(size:10.5,weight:.medium,design:.monospaced))
                            .lineLimit(1).truncationMode(.middle)
                    } else {
                        Text("未绑定规划 · 会话可以直接工作")
                            .font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                }
                Spacer(minLength:6)
                if currentContextLabel != nil {
                    Button("移除") {
                        model.clearCurrentThreadPlanningContext()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size:10.5,weight:.medium))
                    .disabled(model.busy)
                    .accessibilityIdentifier("agent.planning-inspector.clear")
                }
            }
            .padding(.horizontal,14).padding(.vertical,11)
            .accessibilityIdentifier("agent.planning-inspector.current")

            Color.clear.frame(height:6)

            HStack(spacing:7) {
                Image(systemName:"magnifyingglass")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                TextField("筛选需求和计划",text:$query)
                    .textFieldStyle(.plain)
                    .font(.system(size:11))
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName:"xmark.circle.fill").font(.system(size:9))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除规划筛选")
                }
            }
            .padding(.horizontal,10).frame(height:32)
            .background(ForgePalette.softFill)
            .padding(.horizontal,14).padding(.top,9).padding(.bottom,7)

            HStack {
                Text(query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? "可关联规划" : "筛选结果")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer()
                if !loading {
                    Text("\(availableRecords.count)")
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal,14).padding(.bottom,5)

            if loading && records.isEmpty {
                ProgressView("正在读取规划…").controlSize(.small)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let error {
                VStack(alignment:.leading,spacing:7) {
                    Label("规划暂不可用",systemImage:"exclamationmark.circle")
                        .font(.system(size:11,weight:.medium))
                    Text(error).font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    Button("重试") { Task { await reload() } }
                        .buttonStyle(.plain).font(.system(size:10.5,weight:.medium))
                }
                .padding(14).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            } else if availableRecords.isEmpty {
                Text(query.isEmpty ? "没有其他可关联的需求或计划。" : "没有匹配的规划记录。")
                    .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                    .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                    .padding(14)
            } else {
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:0) {
                        ForEach(Array(availableRecords.prefix(10))) { record in
                            planningRow(record)
                        }
                    }
                }
                .scrollIndicators(.automatic)
            }

            Color.clear.frame(height:6)
            HStack {
                Text("关联只影响当前会话，不会修改需求或计划。")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                Spacer()
                if loading { ProgressView().controlSize(.mini) }
            }
            .padding(.horizontal,14).frame(height:34)
        }
        .frame(width:inline ? nil : 390,height:inline ? nil : 455)
        .task(id:planningScopeKey) { await reload() }
    }

    private var planningScopeKey:String {
        "\(model.thread?.projectId ?? "")|\(model.thread?.repoId ?? "")"
    }

    private var currentContextLabel: String? {
        if let planId=model.thread?.planId,!planId.isEmpty { return "计划 · \(String(planId.prefix(18)))" }
        if let requirementId=model.thread?.requirementId,!requirementId.isEmpty {
            return "需求 · \(String(requirementId.prefix(18)))"
        }
        return nil
    }

    private var currentBoundRecord: ForgeRecord? {
        if let planId=model.thread?.planId,!planId.isEmpty {
            return records.first { $0.kind == .plan && $0.recordId == planId }
        }
        if let requirementId=model.thread?.requirementId,!requirementId.isEmpty {
            return records.first { $0.kind == .requirement && $0.recordId == requirementId }
        }
        return nil
    }

    private var availableRecords: [ForgeRecord] {
        prioritizedRecords.filter { record in
            if record.kind == .plan { return record.recordId != model.thread?.planId }
            return !(model.thread?.planId == nil && record.recordId == model.thread?.requirementId)
        }
    }

    private var prioritizedRecords: [ForgeRecord] {
        let needle=query.trimmingCharacters(in:.whitespacesAndNewlines)
        let filtered = records.filter { record in
            needle.isEmpty
                || record.title.localizedCaseInsensitiveContains(needle)
                || record.recordId.localizedCaseInsensitiveContains(needle)
        }
        return filtered.enumerated().sorted { lhs,rhs in
            let lp=priority(lhs.element),rp=priority(rhs.element)
            return lp == rp ? lhs.offset < rhs.offset : lp < rp
        }.map(\.element)
    }

    private func priority(_ record:ForgeRecord) -> Int {
        if record.kind == .plan,record.recordId == model.thread?.planId { return 0 }
        if record.kind == .requirement,record.recordId == model.thread?.requirementId { return 1 }
        if let requirementId=model.thread?.requirementId,record.requirementId == requirementId { return 2 }
        if record.kind == .requirement,record.state == "open" { return 3 }
        if record.kind == .requirement { return 4 }
        return 5 + min(record.depth,4)
    }

    private func planningRow(_ record:ForgeRecord) -> some View {
        let bound = record.kind == .plan
            ? model.thread?.planId == record.recordId
            : (model.thread?.planId == nil && model.thread?.requirementId == record.recordId)
        return Button {
            if record.kind == .plan {
                model.bindCurrentThreadPlanningContext(
                    requirementId:record.requirementId,planId:record.recordId,
                    projectId:model.thread?.projectId,repoId:model.thread?.repoId
                )
            } else {
                model.bindCurrentThreadPlanningContext(
                    requirementId:record.recordId,planId:nil,
                    projectId:model.thread?.projectId,repoId:model.thread?.repoId
                )
            }
        } label: {
            HStack(alignment:.top,spacing:9) {
                Image(systemName:record.kind == .requirement ? "doc.text" : "list.bullet.rectangle")
                    .font(.system(size:10))
                    .foregroundStyle(bound ? ForgePalette.ink : ForgePalette.secondary)
                    .frame(width:18,height:18)
                VStack(alignment:.leading,spacing:3) {
                    Text(record.title)
                        .font(.system(size:11.5,weight:bound ? .semibold : .medium))
                        .foregroundStyle(ForgePalette.ink)
                        .lineLimit(2)
                    HStack(spacing:6) {
                        Text(record.kind == .requirement ? "需求" : "计划")
                        if record.kind == .requirement { Text(record.state) }
                    }
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                }
                Spacer(minLength:5)
                if bound {
                    Image(systemName:"checkmark")
                        .font(.system(size:9.5,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                } else {
                    Text("关联")
                        .font(.system(size:9.5,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                }
            }
            .padding(.horizontal,14).padding(.vertical,9)
            .contentShape(Rectangle())
            .background(bound ? ForgePalette.selection.opacity(0.65) : .clear)
        }
        .buttonStyle(.plain)
        .disabled(model.busy || loadedScopeKey != planningScopeKey)
        .accessibilityLabel(record.title + "，" + (bound ? "已关联当前会话" : "关联到当前会话"))
        .accessibilityIdentifier("agent.planning-inspector.bind.\(record.recordId)")
    }

    @MainActor
    private func reload() async {
        let token=UUID()
        loadToken=token
        let scopeKey=planningScopeKey
        let projectId=model.thread?.projectId
        let repoId=model.thread?.repoId
        records=[]
        loadedScopeKey=nil
        error=nil
        guard let projectId else {
            loading=false
            return
        }
        loading=true
        defer { if loadToken == token { loading=false } }
        do {
            let fresh=try await model.readPlanningRecords(projectId:projectId,repoId:repoId)
            guard loadToken == token, planningScopeKey == scopeKey, !Task.isCancelled else { return }
            records=fresh
            loadedScopeKey=scopeKey
        } catch {
            guard loadToken == token, planningScopeKey == scopeKey, !Task.isCancelled else { return }
            self.error=error.localizedDescription
        }
    }
}

struct AgentKnowledgeInspector: View {
    @ObservedObject var model: NativeWorkspace
    var inline: Bool = false
    let dismiss: () -> Void
    @State private var query = ""
    @State private var result: KnowledgeAuditDetail?
    @State private var loading = false
    @State private var error: String?
    @State private var loadToken = UUID()
    @State private var expandedMemoryIds: Set<String> = []
    @State private var resultOrigin: (repoId: String, checkoutId: String?, threadId: String)?

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.top,spacing:10) {
                VStack(alignment:.leading,spacing:3) {
                    Text("项目知识").font(.system(size:13,weight:.semibold))
                    Text("先看可复用判断；加入当前草稿后仍可编辑，不会自动发送。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName:"xmark")
                        .font(.system(size:9,weight:.semibold))
                        .frame(width:24,height:24)
                }
                .buttonStyle(.plain)
                .help("关闭项目知识")
                .accessibilityLabel("关闭项目知识")
                .accessibilityIdentifier("agent.knowledge-inspector.close")
            }
            .padding(.horizontal,14).padding(.vertical,12)
            Color.clear.frame(height:6)

            HStack(spacing:7) {
                Image(systemName:"magnifyingglass")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                TextField("搜索经验、概念、技术决策",text:$query)
                    .textFieldStyle(.plain)
                    .font(.system(size:11))
                    .onSubmit { Task { await reload() } }
                    .accessibilityIdentifier("agent.knowledge-inspector.search")
                if !query.isEmpty {
                    Button {
                        query=""
                        Task { await reload() }
                    } label: {
                        Image(systemName:"xmark.circle.fill").font(.system(size:9))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除知识搜索")
                }
            }
            .padding(.horizontal,10).frame(height:32)
            .background(ForgePalette.softFill)
            .padding(.horizontal,14).padding(.top,9).padding(.bottom,7)

            HStack {
                Text(query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? "当前项目知识" : "搜索结果")
                    .font(.system(size:9.5,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                Spacer()
                if let result,!loading {
                    Text("\(result.items.count)")
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal,14).padding(.bottom,5)

            if loading && result == nil {
                ProgressView("正在读取知识…").controlSize(.small)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let error {
                VStack(alignment:.leading,spacing:7) {
                    Label("知识暂不可用",systemImage:"exclamationmark.circle")
                        .font(.system(size:11,weight:.medium))
                    Text(error).font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    Button("重试") { Task { await reload() } }
                        .buttonStyle(.plain).font(.system(size:10.5,weight:.medium))
                }
                .padding(14).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            } else if memories.isEmpty {
                Text("没有匹配的知识记录。")
                    .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                    .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                    .padding(14)
            } else {
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:0) {
                        ForEach(memories) { memory in
                            knowledgeRow(memory)
                        }
                    }
                }
                .scrollIndicators(.automatic)
            }

            Color.clear.frame(height:6)
            HStack(spacing:6) {
                if let result {
                    Text("\(result.items.count) 条结果")
                    if result.truncated { Text("· 已截断") }
                } else {
                    Text("只读 · advisory")
                }
                if result != nil { Text("· 按 Cognitive 返回顺序") }
                Spacer()
                if loading { ProgressView().controlSize(.mini) }
            }
            .font(.system(size:9.5)).foregroundStyle(.tertiary)
            .padding(.horizontal,14).frame(height:34)
        }
        .frame(width:inline ? nil : 410,height:inline ? nil : 455)
        .task(id:[model.repoId ?? "", model.checkoutId ?? "", model.selectedThreadId ?? ""]) { await reload() }
    }

    private var memories:[KnowledgeMemoryDetail] {
        result?.items.map(\.memory) ?? []
    }

    private func knowledgeRow(_ memory:KnowledgeMemoryDetail) -> some View {
        let expanded = expandedMemoryIds.contains(memory.id)
        let alreadyInDraft = model.draft.contains(memory.canonicalText)
        return VStack(alignment:.leading,spacing:6) {
            HStack(spacing:6) {
                Text(scopeLabel(memory.scope.kind))
                    .font(.system(size:9,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                if let concept=memory.concepts.first,!concept.isEmpty {
                    Text(concept).font(.system(size:9.5,weight:.medium))
                }
                Spacer()
                Button(alreadyInDraft ? "已在草稿" : "加入草稿") {
                    guard !alreadyInDraft,
                          let origin=resultOrigin,
                          origin.repoId == model.repoId,
                          origin.checkoutId == model.checkoutId,
                          origin.threadId == model.selectedThreadId else { return }
                    model.useKnowledgeInCurrentConversation(memory,expectedThreadId:origin.threadId)
                }
                .buttonStyle(.plain)
                .font(.system(size:10,weight:.semibold))
                .foregroundStyle(alreadyInDraft ? ForgePalette.secondary.opacity(0.55) : ForgePalette.secondary)
                .disabled(alreadyInDraft || model.busy || resultOrigin?.repoId != model.repoId
                          || resultOrigin?.checkoutId != model.checkoutId
                          || resultOrigin?.threadId != model.selectedThreadId)
                .accessibilityIdentifier("agent.knowledge-inspector.use.\(memory.id)")
            }
            Text(memory.canonicalText)
                .font(.system(size:11)).lineSpacing(3)
                .foregroundStyle(ForgePalette.ink)
                .lineLimit(expanded ? nil : 3)
                .fixedSize(horizontal:false,vertical:expanded)
                .textSelection(.enabled)
            if memory.canonicalText.count > 110 {
                Button(expanded ? "收起全文" : "展开全文") {
                    if !expandedMemoryIds.insert(memory.id).inserted {
                        expandedMemoryIds.remove(memory.id)
                    }
                }
                .buttonStyle(.plain)
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .accessibilityIdentifier("agent.knowledge-inspector.expand.\(memory.id)")
            }
        }
        .padding(.horizontal,14).padding(.vertical,10)
    }

    private func scopeLabel(_ kind:String) -> String {
        switch kind { case "project": return "项目"; case "workspace": return "工作空间"; default: return kind }
    }

    @MainActor
    private func reload() async {
        let token=UUID()
        loadToken=token
        result=nil
        resultOrigin=nil
        expandedMemoryIds=[]
        error=nil
        guard let repoId=model.repoId,
              let threadId=model.selectedThreadId else { loading=false; return }
        let checkoutId=model.checkoutId
        let contextGeneration=model.projectContextGeneration
        let searchQuery=query.trimmingCharacters(in:.whitespacesAndNewlines)
        loading=true
        defer { if loadToken == token { loading=false } }
        do {
            let fresh=try await model.readKnowledge(
                repoId:repoId,checkoutId:checkoutId,query:searchQuery
            )
            guard loadToken == token, model.repoId == repoId, model.checkoutId == checkoutId,
                  model.projectContextGeneration == contextGeneration,
                  model.selectedThreadId == threadId,
                  query.trimmingCharacters(in:.whitespacesAndNewlines) == searchQuery,
                  !Task.isCancelled else { return }
            result=fresh
            resultOrigin=(repoId,checkoutId,threadId)
        } catch {
            guard loadToken == token, model.repoId == repoId, model.checkoutId == checkoutId,
                  model.projectContextGeneration == contextGeneration,
                  model.selectedThreadId == threadId,
                  query.trimmingCharacters(in:.whitespacesAndNewlines) == searchQuery,
                  !Task.isCancelled else { return }
            self.error=error.localizedDescription
        }
    }
}
