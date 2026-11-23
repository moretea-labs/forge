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

    func testWindowToolbarExposesOnlyChangesByDefault() {
        XCTAssertEqual(
            AgentConversationToolbarContract.requiredActionIdentifiers,
            ["agent.changes"]
        )
        XCTAssertEqual(
            AgentWorkSurface.railTools.map(\.rawValue),
            ["files", "planning", "knowledge"]
        )
        XCTAssertEqual(AgentConversationToolbarContract.filesIdentifier, "agent.files")
        XCTAssertFalse(
            AgentConversationToolbarContract.requiredActionIdentifiers.contains("agent.files")
        )
    }
}
