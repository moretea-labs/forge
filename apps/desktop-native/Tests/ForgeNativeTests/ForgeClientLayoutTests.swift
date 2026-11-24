import XCTest

@testable import ForgeNative

final class ForgeClientLayoutTests: XCTestCase {
  func testCompactWindowsReclaimSidebarWidthWithoutCollapsingNavigation() {
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 860), 228)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1100), 231)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260), 265)
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

  func testHeaderAndReadingGutterHaveSharedMetrics() {
    XCTAssertEqual(ForgeClientDesign.Shell.workspaceHeaderHeight, 36)
    XCTAssertEqual(ForgeClientDesign.Shell.readingGutter, 20)
    XCTAssertEqual(ForgeClientDesign.Shell.compactSidebarMin, 228)
  }
}
