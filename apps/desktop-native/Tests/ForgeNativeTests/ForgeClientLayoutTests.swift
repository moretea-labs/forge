import AppKit
import XCTest

@testable import ForgeNative

final class ForgeClientLayoutTests: XCTestCase {
  func testCompactWindowsReclaimSidebarWidthWithoutCollapsingNavigation() {
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 860), 228)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1100), 231)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260), 264.6, accuracy: 0.001)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1800), 288)
  }

  func testSidebarWidthStaysWithinExistingDesignBounds() {
    let widths = [CGFloat(600), 860, 1100, 1260, 1440, 1800, 2400]
    let result = widths.map { ForgeClientDesign.Shell.sidebarWidth(windowWidth: $0) }
    XCTAssertEqual(result, result.sorted())
    XCTAssertTrue(
      result.allSatisfy {
        $0 >= ForgeClientDesign.Shell.compactSidebarMin
          && $0 <= ForgeClientDesign.Shell.sidebarIdeal
      })
  }

  func testSidebarWidthChangesContinuouslyAboveCompactMinimum() {
    let before = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1259)
    let after = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260)
    XCTAssertEqual(after - before, 0.21, accuracy: 0.001)
  }

  func testChromeIconMetricsAndNavigationSymbolsAreConsistent() {
    XCTAssertEqual(ForgeClientDesign.Icon.point, 14)
    XCTAssertEqual(ForgeClientDesign.Icon.hit, 30)
    XCTAssertEqual(ForgeClientDesign.Icon.railPoint, 17)
    XCTAssertEqual(ForgeClientDesign.Icon.railLabel, 10)
    XCTAssertEqual(ForgeClientDesign.Shell.destinationRowHeight, 46)
    let glyphs = ForgeSidebarDestination.allCases.map(\.glyph)
    XCTAssertEqual(Set(glyphs).count, glyphs.count)
    XCTAssertEqual(glyphs, [.chat, .folder, .board, .tasks, .library, .analytics, .settings])
  }

  func testEveryCustomGlyphFitsTheSharedOutlineGrid() {
    for glyph in ForgeGlyphKind.allCases {
      for size: CGFloat in [16, 18, 22, 24] {
        let rect = CGRect(x: 0, y: 0, width: size, height: size)
        let path = ForgeGlyphShape(kind: glyph).path(in: rect)
        XCTAssertFalse(path.isEmpty, glyph.rawValue)
        XCTAssertTrue(rect.contains(path.boundingRect), glyph.rawValue)
        XCTAssertGreaterThan(path.boundingRect.width, size * 0.2, glyph.rawValue)
        XCTAssertGreaterThan(path.boundingRect.height, size * 0.2, glyph.rawValue)
      }
    }
  }

  func testComposerUsesSeparateConfigurationRowInNarrowConversation() {
    for width: CGFloat in [0, 440, 474, 600, 625] {
      XCTAssertTrue(ForgeClientDesign.Shell.composerUsesTwoControlRows(conversationWidth: width))
    }
    for width: CGFloat in [626, 695, 760, 1400] {
      XCTAssertFalse(ForgeClientDesign.Shell.composerUsesTwoControlRows(conversationWidth: width))
    }
    XCTAssertEqual(ForgeClientDesign.Shell.composerControlHeight, ForgeClientDesign.Icon.hit)
  }

  func testReadingRhythmAndThreadControlsUseSharedMetrics() {
    let shell = ForgeClientDesign.Shell.self
    let transcript = ForgeClientDesign.Transcript.self
    XCTAssertGreaterThanOrEqual(shell.threadRowHeight, ForgeClientDesign.Icon.hit)
    XCTAssertLessThan(shell.threadActionWidth, shell.threadRowHeight)
    XCTAssertGreaterThan(transcript.blockSpacing, transcript.listSpacing)
    XCTAssertGreaterThan(transcript.bodyPoint, shell.threadTitlePoint)
    XCTAssertGreaterThanOrEqual(transcript.lineSpacing, 4)
  }

  func testHeaderAndReadingGutterHaveSharedMetrics() {
    XCTAssertEqual(ForgeClientDesign.Shell.workspaceHeaderHeight, 36)
    XCTAssertEqual(ForgeClientDesign.Shell.workspaceStatusSlotWidth, 112)
    XCTAssertEqual(ForgeClientDesign.Shell.composerTextHeight, 38)
    XCTAssertEqual(ForgeClientDesign.Shell.readingGutter, 20)
    XCTAssertEqual(ForgeClientDesign.Shell.compactSidebarMin, 228)
  }
}
