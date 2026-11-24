import SwiftUI

/// Geometry shared by the shell and conversation; visual tokens remain in ForgeClientDesign.
extension ForgeClientDesign.Shell {
  static let workspaceHeaderHeight: CGFloat = 30
  static let workspaceStatusSlotWidth: CGFloat = 28
  static let composerTextHeight: CGFloat = 38
  static let readingGutter: CGFloat = 18
  static let composerControlInset: CGFloat = 13
  static let composerControlHeight: CGFloat = 28

  // The reading cap and gutters determine the actual Composer width.
  static func composerUsesTwoControlRows(conversationWidth: CGFloat) -> Bool {
    let width = min(readingColumn, max(0, conversationWidth - 2 * readingGutter))
    return width - 2 * composerControlInset < 564
  }

  /// A labeled 52pt rail and 176pt list remain readable at compact widths.
  /// The shell grows continuously to its 288pt desktop cap without breakpoint jumps.
  static func sidebarWidth(windowWidth: CGFloat) -> CGFloat {
    min(sidebarIdeal, max(sidebarMin, windowWidth * 0.21))
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
