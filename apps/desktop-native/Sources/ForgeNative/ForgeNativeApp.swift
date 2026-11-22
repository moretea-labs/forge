import SwiftUI
import AppKit
import UniformTypeIdentifiers

func shellQuotedMcpPath(_ path:String) -> String {
    "'" + path.replacingOccurrences(of:"'",with:"'\\''") + "'"
}

@main
struct ForgeNativeApp: App {
    @StateObject private var workspace = NativeWorkspace()

    var body: some Scene {
        WindowGroup("Forge") {
            ForgeWorkspaceView(model: workspace)
                .frame(minWidth:860,minHeight:570)
                .tint(ForgePalette.accent)
                .task { await workspace.refresh() }
        }
        .defaultSize(width:1260,height:790)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing:.newItem) {
                Button("新会话") {
                    guard !workspace.zenRefinementActive else { return }
                    workspace.show(.agent)
                    workspace.newThread()
                }
                .disabled(workspace.zenRefinementActive)
                .help(workspace.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : "新建会话")
                .keyboardShortcut("n")
            }
            CommandMenu("导航") {
                Button("搜索会话") {
                    workspace.toggleConversationSearch()
                }.keyboardShortcut("k")
                Divider()
                Button("显示会话") { workspace.show(.agent) }.keyboardShortcut("1")
                Button("显示工作台") { workspace.openWorkbench() }.keyboardShortcut("2")
                Button("显示自动任务") { workspace.show(.schedule) }.keyboardShortcut("3")
                Button("显示资源") { workspace.show(.assets) }.keyboardShortcut("4")
                Button("显示统计") { workspace.show(.usage) }.keyboardShortcut("5")
                Button("显示设置") { workspace.show(.settings) }.keyboardShortcut("6")
                Divider()
                Button("刷新项目") { Task { await workspace.refresh() } }.keyboardShortcut("r")
            }
        }
    }
}
