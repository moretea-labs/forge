import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct SidebarThreadSection: Identifiable {
    let id: String
    let title: String
    let repoId: String?
    let threads: [ChatThread]
}

struct ProjectCheckoutChoice: Identifiable {
    let id: String
    let path: String
    let branch: String?
    let worktree: Bool
    let active: Bool

    static func fromRepository(_ value:[String:Any]) -> [ProjectCheckoutChoice] {
        let data = value["repository"] as? [String:Any] ?? [:]
        let rows = data["checkouts"] as? [[String:Any]] ?? []
        return rows.compactMap { row -> ProjectCheckoutChoice? in
            guard let id = row["checkoutId"] as? String, !id.isEmpty,
                  let path = row["path"] as? String, !path.isEmpty,
                  (row["lifecycle"] as? String ?? "active") == "active" else { return nil }
            return ProjectCheckoutChoice(
                id:id,path:path,branch:row["branch"] as? String,
                worktree:row["worktree"] as? Bool ?? false,
                active:row["active"] as? Bool ?? false
            )
        }.sorted { left,right in
            if left.active != right.active { return left.active }
            return left.path.localizedStandardCompare(right.path) == .orderedAscending
        }
    }
}

// The sidebar selection is derived from the single current workspace/page.
enum ForgeSidebarDestination: String, CaseIterable {
    case workbench, agent, automations, resources, analytics, settings

    var title: String {
        switch self {
        case .workbench: return "工作台"
        case .agent: return "Agent"
        case .automations: return "自动任务"
        case .resources: return "资源"
        case .analytics: return "统计"
        case .settings: return "设置"
        }
    }

    var symbol: String {
        switch self {
        case .workbench: return "square.grid.2x2"
        case .agent: return "bubble.left.and.bubble.right"
        case .automations: return "clock.arrow.circlepath"
        case .resources: return "folder"
        case .analytics: return "chart.bar"
        case .settings: return "gearshape"
        }
    }

    static func resolve(zenMode: Bool, page: NativePage) -> Self {
        if zenMode { return .workbench }
        switch page {
        case .agent: return .agent
        case .schedule: return .automations
        case .assets, .knowledge: return .resources
        case .usage: return .analytics
        case .settings, .plugins: return .settings
        case .requirement, .plan: return .workbench
        }
    }
}
