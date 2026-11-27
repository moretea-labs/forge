import XCTest

@testable import ForgeNative

final class ForgeClientToolbarOwnershipTests: XCTestCase {
  func testZenWorkbenchKeepsNativeToolbarVisibleWithoutShellBackAction() {
    XCTAssertTrue(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: false,
        isAgentPage: false,
        inspectorVisible: false,
        isZenWorkbench: true
      )
    )
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowShellBackAction(
        canNavigateBack: true,
        isAgentPage: false,
        inspectorVisible: false,
        isZenWorkbench: true
      )
    )
  }

  func testNonZenBackActionRemainsOwnedByTheShell() {
    XCTAssertTrue(
      ForgeClientDesign.Shell.shouldShowShellBackAction(
        canNavigateBack: true,
        isAgentPage: false,
        inspectorVisible: false,
        isZenWorkbench: false
      )
    )
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowShellBackAction(
        canNavigateBack: false,
        isAgentPage: false,
        inspectorVisible: false,
        isZenWorkbench: false
      )
    )
  }

  func testAgentInspectorOwnsDismissalAndHidesTheWindowToolbar() {
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowShellBackAction(
        canNavigateBack: true,
        isAgentPage: true,
        inspectorVisible: true,
        isZenWorkbench: false
      )
    )
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: true,
        isAgentPage: true,
        inspectorVisible: true,
        isZenWorkbench: false
      )
    )
    XCTAssertTrue(
      ForgeClientDesign.Shell.shouldShowShellBackAction(
        canNavigateBack: true,
        isAgentPage: true,
        inspectorVisible: false,
        isZenWorkbench: false
      )
    )
    XCTAssertTrue(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: true,
        isAgentPage: true,
        inspectorVisible: false,
        isZenWorkbench: false
      )
    )
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: false,
        isAgentPage: false,
        inspectorVisible: false,
        isZenWorkbench: false
      )
    )
  }
}
