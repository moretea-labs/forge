import SwiftUI

/// Geometry shared by the shell and conversation; visual tokens remain in ForgeClientDesign.
extension ForgeClientDesign.Shell {
  static let workspaceHeaderHeight: CGFloat = 36
  static let workspaceStatusSlotWidth: CGFloat = 112
  static let composerTextHeight: CGFloat = 38
  static let readingGutter: CGFloat = 20
  /// 52pt icon rail + 176pt compact list; desktop still grows to the existing 288pt ideal.
  static let compactSidebarMin: CGFloat = iconRailWidth + 176

  /// Keep navigation usable on compact windows without reserving desktop-width space.
  static func sidebarWidth(windowWidth: CGFloat) -> CGFloat {
    min(sidebarIdeal, max(compactSidebarMin, windowWidth * 0.21))
  }
}

extension View {
  /// Both transcript and composer use the same width cap, centering and gutter.
  func forgeConversationColumn() -> some View {
    self
      .frame(maxWidth: ForgeClientDesign.Shell.readingColumn, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.horizontal, ForgeClientDesign.Shell.readingGutter)
  }
}
