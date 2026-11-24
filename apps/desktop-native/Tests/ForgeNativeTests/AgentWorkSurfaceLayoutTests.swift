import Foundation
import XCTest

@testable import ForgeNative

final class AgentWorkSurfaceLayoutTests: XCTestCase {
  func testInspectorUsesTrailingOverlayUntilExplicitlyMaximized() {
    let widths: [CGFloat] = [560, 889, 890, 958, 1400]
    let presentations = widths.map { _ in
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: false)
    }
    XCTAssertEqual(presentations, Array(repeating: .overlay, count: widths.count))
  }

  func testOverlayWidthStaysWithinReadableBounds() {
    XCTAssertEqual(AgentWorkSurfaceLayout.conversationMinimumWidth, 420)
    XCTAssertEqual(AgentWorkSurfaceLayout.workSurfaceMinimumWidth, 340)
    XCTAssertEqual(AgentWorkSurfaceLayout.workSurfaceMaximumWidth, 420)
    XCTAssertEqual(AgentWorkSurfaceLayout.overlayWidth(availableWidth: 560), 340)
    XCTAssertEqual(AgentWorkSurfaceLayout.overlayWidth(availableWidth: 890), 340)
    XCTAssertEqual(AgentWorkSurfaceLayout.overlayWidth(availableWidth: 958), 364.04, accuracy: 0.001)
    XCTAssertEqual(AgentWorkSurfaceLayout.overlayWidth(availableWidth: 1400), 420)
  }

  func testClosedAndMaximizedWorkSurfacePresentationIsExplicit() {
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: false, isMaximized: false),
      .conversationOnly
    )
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: false),
      .overlay
    )
    XCTAssertEqual(
      AgentWorkSurfaceLayout.presentation(isVisible: true, isMaximized: true),
      .replacement
    )
  }

  func testConversationHeaderExposesSingleInspectorToggleByDefault() {
    XCTAssertEqual(
      AgentConversationHeaderContract.requiredActionIdentifiers, ["agent.inspector.toggle"])
    XCTAssertEqual(
      AgentWorkSurface.allCases.map(\.rawValue),
      ["changes", "files", "planning", "knowledge", "capabilities"])
    XCTAssertEqual(AgentConversationHeaderContract.filesIdentifier, "agent.files")
    XCTAssertFalse(
      AgentConversationHeaderContract.requiredActionIdentifiers.contains("agent.changes"))
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

  func testInspectorOpensAndClosesFromTheSamePersistentControl() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot = testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourceURL = packageRoot.appendingPathComponent("Sources/ForgeNative/AgentWorkbenchViews.swift")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)

    XCTAssertTrue(source.contains("private var inspectorToggleButton"))
    XCTAssertTrue(source.contains("if workSurfaceVisible {"))
    XCTAssertTrue(source.contains("closeWorkSurface()"))
    XCTAssertFalse(source.contains(#".accessibilityIdentifier("agent.work-surface.close")"#))
  }

  func testInspectorOverlayIsBoundToTranscriptViewportAndNeverCoversComposer() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot = testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourceURL = packageRoot.appendingPathComponent("Sources/ForgeNative/AgentWorkbenchViews.swift")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)

    let scrollReader = try XCTUnwrap(source.range(of: "ScrollViewReader { reader in"))
    let composer = try XCTUnwrap(
      source.range(
        of: "VStack(alignment:.leading,spacing:0) {",
        range: scrollReader.upperBound..<source.endIndex
      )
    )
    XCTAssertNotNil(
      source.range(
        of: ".overlay(alignment:.trailing) {",
        range: scrollReader.upperBound..<composer.lowerBound
      )
    )
    XCTAssertFalse(source[composer.upperBound...].contains("if workSurfacePresentation == .overlay"))
  }

}
