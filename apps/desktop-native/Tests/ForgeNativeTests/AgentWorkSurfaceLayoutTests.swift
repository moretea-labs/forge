import XCTest

@testable import ForgeNative

final class AgentWorkSurfaceLayoutTests: XCTestCase {
  func testInspectorDocksWhenBothPanesFitAndUsesFullWidthInCompactWindows() {
    let widths: [CGFloat] = [560, 889, 890, 958, 1400]
    let presentations = widths.map {
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: false, availableWidth: $0)
    }
    XCTAssertEqual(presentations, [.replacement, .replacement, .docked, .docked, .docked])
  }

  func testDockedWidthDefaultsToHalfAndClampsDragWithoutSacrificingEitherPane() {
    XCTAssertEqual(AgentWorkSurfaceLayout.dockedWidth(availableWidth: 560), 560)
    XCTAssertEqual(AgentWorkSurfaceLayout.dockedWidth(availableWidth: 890), 440)
    XCTAssertEqual(AgentWorkSurfaceLayout.dockedWidth(availableWidth: 958), 474)
    XCTAssertEqual(AgentWorkSurfaceLayout.dockedWidth(availableWidth: 1400), 695)
    XCTAssertEqual(AgentWorkSurfaceLayout.dockedWidth(availableWidth: 1400, preferredWidth: 100), 440)
    XCTAssertEqual(AgentWorkSurfaceLayout.dockedWidth(availableWidth: 1400, preferredWidth: 1200), 950)
  }

  func testClosedAndMaximizedWorkSurfacePresentationIsExplicit() {
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: false, isMaximized: false, availableWidth: 1400),
      .conversationOnly
    )
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: true, availableWidth: 1400),
      .replacement
    )
  }

  func testWindowToolbarExposesOnlyInspectorByDefault() {
    XCTAssertEqual(
      AgentConversationToolbarContract.requiredActionIdentifiers, ["agent.inspector.toggle"])
    XCTAssertEqual(
      AgentWorkSurface.allCases.map(\.rawValue),
      ["changes", "files", "planning", "knowledge", "capabilities"])
    XCTAssertEqual(AgentConversationToolbarContract.filesIdentifier, "agent.files")
    XCTAssertFalse(
      AgentConversationToolbarContract.requiredActionIdentifiers.contains("agent.changes"))
  }

  func testCapabilityExtensionSlotsKeepStableBackendIndependentIdentity() {
    XCTAssertEqual(AgentCapabilitiesContract.panelIdentifier, "agent.capabilities.panel")
    XCTAssertEqual(AgentCapabilitiesContract.pluginIdentifier, "agent.capability.plugins")
    XCTAssertEqual(
      AgentCapabilityExtension.allCases.map(\.rawValue),
      ["skills", "mcp", "agents", "commands", "hooks"])
    XCTAssertEqual(
      AgentCapabilityExtension.allCases.map(\.title),
      ["Skills", "MCP / 外部工具", "Agents", "Commands", "Hooks"])
    XCTAssertEqual(
      AgentCapabilityExtension.allCases.map(\.accessibilityIdentifier),
      [
        "agent.capability.skills",
        "agent.capability.mcp",
        "agent.capability.agents",
        "agent.capability.commands",
        "agent.capability.hooks",
      ])
  }

  func testInspectorReopensLastAvailableTabAndFallsBackWhenContextChanges() {
    let all = AgentWorkSurface.availableTabs(
      hasCheckout: true, hasProject: true, hasRepository: true)
    XCTAssertEqual(all, AgentWorkSurface.allCases)
    XCTAssertEqual(AgentWorkSurface.preferredTab(selected: .knowledge, available: all), .knowledge)
    let noWorkspace = AgentWorkSurface.availableTabs(
      hasCheckout: false, hasProject: false, hasRepository: false)
    XCTAssertEqual(noWorkspace, [.files, .capabilities])
    XCTAssertEqual(
      AgentWorkSurface.preferredTab(selected: .changes, available: noWorkspace), .files)
    XCTAssertEqual(AgentWorkSurface.preferredTab(selected: .files, available: noWorkspace), .files)
    XCTAssertEqual(
      AgentWorkSurface.preferredTab(selected: .capabilities, available: noWorkspace), .capabilities)
  }
}
