import XCTest

@testable import ForgeNative

final class AgentWorkSurfaceLayoutTests: XCTestCase {
  func testInspectorOpeningUsesOverlayAndNeverWidthDependentReplacement() {
    let widths: [CGFloat] = [560, 840, 958, 1400]
    let presentations = widths.map { _ in
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: false)
    }
    XCTAssertEqual(presentations, [.overlay, .overlay, .overlay, .overlay])
  }

  func testInspectorOverlayWidthIsClampedWithoutChangingConversationGeometry() {
    XCTAssertEqual(AgentWorkSurfaceLayout.overlayWidth(availableWidth: 560), 360)
    XCTAssertEqual(
      AgentWorkSurfaceLayout.overlayWidth(availableWidth: 958),
      402.36,
      accuracy: 0.001)
    XCTAssertEqual(AgentWorkSurfaceLayout.overlayWidth(availableWidth: 1400), 460)
  }

  func testClosedAndMaximizedWorkSurfacePresentationIsExplicit() {
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: false, isMaximized: false),
      .conversationOnly
    )
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: true),
      .replacement
    )
  }

  func testWindowToolbarExposesOnlyInspectorByDefault() {
    XCTAssertEqual(
      AgentConversationToolbarContract.requiredActionIdentifiers, ["agent.inspector.toggle"])
    XCTAssertEqual(
      AgentWorkSurface.allCases.map(\.rawValue), ["changes", "files", "planning", "knowledge"])
    XCTAssertEqual(AgentConversationToolbarContract.filesIdentifier, "agent.files")
    XCTAssertFalse(
      AgentConversationToolbarContract.requiredActionIdentifiers.contains("agent.changes"))
  }

  func testInspectorReopensLastAvailableTabAndFallsBackWhenContextChanges() {
    let all = AgentWorkSurface.availableTabs(
      hasCheckout: true, hasProject: true, hasRepository: true)
    XCTAssertEqual(all, AgentWorkSurface.allCases)
    XCTAssertEqual(AgentWorkSurface.preferredTab(selected: .knowledge, available: all), .knowledge)
    let noWorkspace = AgentWorkSurface.availableTabs(
      hasCheckout: false, hasProject: false, hasRepository: false)
    XCTAssertEqual(noWorkspace, [.files])
    XCTAssertEqual(
      AgentWorkSurface.preferredTab(selected: .changes, available: noWorkspace), .files)
    XCTAssertEqual(AgentWorkSurface.preferredTab(selected: .files, available: noWorkspace), .files)
  }
}
