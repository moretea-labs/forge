import SwiftUI

/// Geometry shared by the shell and conversation; visual tokens remain in ForgeClientDesign.
extension ForgeClientDesign.Shell {
  static let workspaceHeaderHeight: CGFloat = 36
  static let workspaceStatusSlotWidth: CGFloat = 112
  static let composerTextHeight: CGFloat = 38
  static let readingGutter: CGFloat = 20
  static let composerControlInset: CGFloat = 13
  static let composerControlHeight: CGFloat = 30

  // The reading cap and gutters determine the actual Composer width.
  static func composerUsesTwoControlRows(conversationWidth: CGFloat) -> Bool {
    let width = min(readingColumn, max(0, conversationWidth - 2 * readingGutter))
    return width - 2 * composerControlInset < 560
  }
  /// Compact windows can reclaim up to 24pt from the list while keeping the icon rail unchanged.
  static let compactSidebarListMin: CGFloat = 152
  static let compactSidebarListIdeal: CGFloat = 176

  /// Keep navigation usable on compact windows without reserving desktop-width space.
  /// The compact list grows continuously from 152pt to 176pt, avoiding a resize breakpoint jump.
  static func sidebarWidth(windowWidth: CGFloat) -> CGFloat {
    let compactList = min(
      compactSidebarListIdeal,
      max(compactSidebarListMin, windowWidth * 0.28 - iconRailWidth)
    )
    let compactFloor = iconRailWidth + compactList
    return min(sidebarIdeal, max(compactFloor, windowWidth * 0.21))
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
