import XCTest
@testable import ForgeNative

final class AgentWorkSurfaceLayoutTests: XCTestCase {
    func testSideBySideThresholdUsesDeclaredPaneMinimumsAndDividerAllowance() {
        XCTAssertEqual(AgentWorkSurfaceLayout.minimumSideBySideWidth, 840)
        XCTAssertTrue(AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: 958))
        XCTAssertTrue(AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: 840))
        XCTAssertFalse(AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: 839))
        XCTAssertFalse(AgentWorkSurfaceLayout.supportsSideBySide(availableWidth: 780))
    }

    func testSelectedSurfaceSurvivesWideCompactWidePresentationChanges() {
        let selectedSurface: AgentWorkSurface = .files
        let isVisible = true
        let widths: [CGFloat] = [958, 780, 958]
        let presentations = widths.map {
            AgentWorkSurfaceLayout.presentation(
                availableWidth: $0,
                isVisible: isVisible,
                isMaximized: false
            )
        }

        XCTAssertEqual(presentations, [.sideBySide, .replacement, .sideBySide])
        XCTAssertTrue(isVisible)
        XCTAssertEqual(selectedSurface, .files)
    }

    func testClosedAndMaximizedWorkSurfacePresentationIsExplicit() {
        XCTAssertEqual(
            AgentWorkSurfaceLayout.presentation(
                availableWidth: 958,
                isVisible: false,
                isMaximized: false
            ),
            .conversationOnly
        )
        XCTAssertEqual(
            AgentWorkSurfaceLayout.presentation(
                availableWidth: 958,
                isVisible: true,
                isMaximized: true
            ),
            .replacement
        )
    }

    func testWindowToolbarExposesOnlyInspectorByDefault() {
        XCTAssertEqual(AgentConversationToolbarContract.requiredActionIdentifiers, ["agent.inspector.toggle"])
        XCTAssertEqual(AgentWorkSurface.allCases.map(\.rawValue), ["changes", "files", "planning", "knowledge"])
        XCTAssertEqual(AgentConversationToolbarContract.filesIdentifier, "agent.files")
        XCTAssertFalse(AgentConversationToolbarContract.requiredActionIdentifiers.contains("agent.changes"))
    }

    func testInspectorReopensLastAvailableTabAndFallsBackWhenContextChanges() {
        let all = AgentWorkSurface.availableTabs(hasCheckout:true,hasProject:true,hasRepository:true)
        XCTAssertEqual(all, AgentWorkSurface.allCases)
        XCTAssertEqual(AgentWorkSurface.preferredTab(selected:.knowledge,available:all), .knowledge)
        let noWorkspace = AgentWorkSurface.availableTabs(hasCheckout:false,hasProject:false,hasRepository:false)
        XCTAssertEqual(noWorkspace, [.files])
        XCTAssertEqual(AgentWorkSurface.preferredTab(selected:.changes,available:noWorkspace), .files)
        XCTAssertEqual(AgentWorkSurface.preferredTab(selected:.files,available:noWorkspace), .files)
    }
}
