import SwiftUI

/// Geometry shared by the shell and conversation; visual tokens remain in ForgeClientDesign.
extension ForgeClientDesign.Shell {
  static let workspaceHeaderHeight: CGFloat = 36
  static let conversationHeaderHeight: CGFloat = 36
  static let workspaceStatusSlotWidth: CGFloat = 28
  static let composerTextHeight: CGFloat = 38
  static let readingGutter: CGFloat = 20
  static let composerControlInset: CGFloat = 13
  static let composerControlHeight: CGFloat = 30

  /// Zen owns its contextual native toolbar; the shell only keeps the window toolbar visible.
  /// The shell must never add a second Back action to a Zen surface.
  static func shouldShowWindowToolbar(
    canNavigateBack: Bool,
    isAgentPage: Bool,
    inspectorVisible: Bool,
    isZenWorkbench: Bool = false
  ) -> Bool {
    isZenWorkbench
      || shouldShowShellBackAction(
        canNavigateBack: canNavigateBack,
        isAgentPage: isAgentPage,
        inspectorVisible: inspectorVisible,
        isZenWorkbench: isZenWorkbench
      )
  }

  static func shouldShowShellBackAction(
    canNavigateBack: Bool,
    isAgentPage: Bool,
    inspectorVisible: Bool,
    isZenWorkbench: Bool
  ) -> Bool {
    canNavigateBack && !isZenWorkbench && !(isAgentPage && inspectorVisible)
  }

  // The reading cap and gutters determine the actual Composer width.
  static func composerUsesTwoControlRows(conversationWidth: CGFloat) -> Bool {
    let width = min(readingColumn, max(0, conversationWidth - 2 * readingGutter))
    return width - 2 * composerControlInset < 564
  }

  /// A 52pt icon rail and 176pt contextual list remain readable at compact widths.
  /// The shell grows continuously to its 288pt desktop cap without breakpoint jumps.
  static func sidebarWidth(windowWidth: CGFloat, showsListColumn: Bool = true) -> CGFloat {
    guard showsListColumn else { return iconRailWidth }
    return min(sidebarIdeal, max(sidebarMin, windowWidth * 0.21))
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
