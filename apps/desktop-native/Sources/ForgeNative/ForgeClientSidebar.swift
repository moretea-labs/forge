import AppKit
import SwiftUI
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

  static func fromRepository(_ value: [String: Any]) -> [ProjectCheckoutChoice] {
    let data = value["repository"] as? [String: Any] ?? [:]
    let rows = data["checkouts"] as? [[String: Any]] ?? []
    return rows.compactMap { row -> ProjectCheckoutChoice? in
      guard let id = row["checkoutId"] as? String, !id.isEmpty,
        let path = row["path"] as? String, !path.isEmpty,
        (row["lifecycle"] as? String ?? "active") == "active"
      else { return nil }
      return ProjectCheckoutChoice(
        id: id, path: path, branch: row["branch"] as? String,
        worktree: row["worktree"] as? Bool ?? false,
        active: row["active"] as? Bool ?? false
      )
    }.sorted { left, right in
      if left.active != right.active { return left.active }
      return left.path.localizedStandardCompare(right.path) == .orderedAscending
    }
  }
}

/// Primary destinations for the icon-only rail beside the workspace list.
/// 会话 / 项目 / 看板 are first-class; tool destinations stay visible in-rail.
enum ForgeSidebarDestination: String, CaseIterable {
  case agent, projects, workbench, automations, resources, analytics, settings

  var title: String {
    switch self {
    case .agent: return "会话"
    case .projects: return "项目"
    case .workbench: return "看板"
    case .automations: return "任务"
    case .resources: return "资源"
    case .analytics: return "统计"
    case .settings: return "设置"
    }
  }

  var accessibilityIdentifier: String { "forge.nav.\(rawValue)" }

  var glyph: ForgeGlyphKind {
    switch self {
    case .agent: return .chat
    case .projects: return .folder
    case .workbench: return .board
    case .automations: return .tasks
    case .resources: return .library
    case .analytics: return .analytics
    case .settings: return .settings
    }
  }

  /// Primary icon-rail entries (会话 / 项目 / 看板).
  static var primaryRail: [ForgeSidebarDestination] { [.agent, .projects, .workbench] }
  /// Tool destinations shown directly in the rail (never collapsed into a menu).
  static var toolRail: [ForgeSidebarDestination] { [.automations, .resources, .analytics] }

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
