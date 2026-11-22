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

/// Primary rail destinations for the four-column shell.
/// 会话 / 项目 / 看板 are first-class; utilities stay under More.
enum ForgeSidebarDestination: String, CaseIterable {
  case agent, projects, workbench, automations, resources, analytics, settings

  var title: String {
    switch self {
    case .agent: return "会话"
    case .projects: return "项目"
    case .workbench: return "看板"
    case .automations: return "自动任务"
    case .resources: return "资源"
    case .analytics: return "统计"
    case .settings: return "设置"
    }
  }

  var symbol: String {
    switch self {
    case .agent: return "bubble.left.and.bubble.right"
    case .projects: return "folder"
    case .workbench: return "rectangle.split.3x1"
    case .automations: return "clock.arrow.circlepath"
    case .resources: return "photo.on.rectangle"
    case .analytics: return "chart.bar"
    case .settings: return "gearshape"
    }
  }

  /// Primary icon-rail entries (会话 / 项目 / 看板).
  static var primaryRail: [ForgeSidebarDestination] { [.agent, .projects, .workbench] }

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
