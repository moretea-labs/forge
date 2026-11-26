import AppKit
import Foundation
import XCTest

@testable import ForgeNative

final class ForgeClientLayoutTests: XCTestCase {
  func testCompactWindowsReclaimSidebarWidthWithoutCollapsingNavigation() {
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 720), 228)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 800), 228)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 860), 228)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1100), 231)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260), 264.6, accuracy: 0.001)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1440), 288)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1800), 288)
  }

  func testSidebarWidthStaysWithinExistingDesignBounds() {
    let widths = [CGFloat(600), 860, 1100, 1260, 1440, 1800, 2400]
    let result = widths.map { ForgeClientDesign.Shell.sidebarWidth(windowWidth: $0) }
    XCTAssertEqual(result, result.sorted())
    XCTAssertTrue(
      result.allSatisfy {
        $0 >= ForgeClientDesign.Shell.sidebarMin
          && $0 <= ForgeClientDesign.Shell.sidebarIdeal
      })
  }

  func testUtilityDestinationsWithoutSubnavigationCollapseToIconRail() {
    XCTAssertFalse(ForgeSidebarDestination.automations.showsListColumn)
    XCTAssertFalse(ForgeSidebarDestination.analytics.showsListColumn)
    for destination in [
      ForgeSidebarDestination.agent, .projects, .workbench, .resources, .settings,
    ] {
      XCTAssertTrue(destination.showsListColumn)
    }
    XCTAssertEqual(
      ForgeClientDesign.Shell.sidebarWidth(windowWidth: 860, showsListColumn: false),
      ForgeClientDesign.Shell.iconRailWidth
    )
    XCTAssertEqual(
      ForgeClientDesign.Shell.sidebarWidth(windowWidth: 860, showsListColumn: true),
      228
    )
  }

  func testSidebarWidthChangesContinuouslyAboveCompactMinimum() {
    let narrowBefore = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1087)
    let narrowAfter = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1088)
    XCTAssertEqual(narrowAfter - narrowBefore, 0.21, accuracy: 0.001)

    let before = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1259)
    let after = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260)
    XCTAssertEqual(after - before, 0.21, accuracy: 0.001)
  }

  func testChromeIconMetricsAndNavigationAssetsAreConsistent() {
    XCTAssertEqual(ForgeClientDesign.Icon.point, 13)
    XCTAssertEqual(ForgeClientDesign.Icon.hit, 30)
    XCTAssertEqual(ForgeClientDesign.Icon.railPoint, 13)
    XCTAssertEqual(ForgeClientDesign.Shell.iconRailWidth, 52)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarMin, 228)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarIdeal, 288)
    XCTAssertEqual(ForgeClientDesign.Shell.destinationRowHeight, 36)
    let glyphs = ForgeSidebarDestination.allCases.map(\.glyph)
    XCTAssertEqual(Set(glyphs).count, glyphs.count)
    let navigationIdentifiers = ForgeSidebarDestination.allCases.map(\.accessibilityIdentifier)
    XCTAssertEqual(
      navigationIdentifiers,
      [
        "forge.nav.agent", "forge.nav.projects", "forge.nav.workbench",
        "forge.nav.automations", "forge.nav.resources", "forge.nav.analytics", "forge.nav.settings",
      ])
    XCTAssertEqual(Set(navigationIdentifiers).count, navigationIdentifiers.count)

    XCTAssertEqual(glyphs, [.chat, .folder, .board, .tasks, .library, .analytics, .settings])

    let assetNames = ForgeSidebarDestination.allCases.map { ForgeGlyph.assetName(for: $0.glyph) }
    XCTAssertEqual(Set(assetNames).count, assetNames.count)
    XCTAssertTrue(assetNames.allSatisfy { !$0.isEmpty })
  }

  func testEveryTablerGlyphResolvesFromTheBundledAssetSet() {
    for glyph in ForgeGlyphKind.allCases {
      XCTAssertNotNil(ForgeGlyph.assetURL(for: glyph), glyph.rawValue)
    }
    XCTAssertEqual(
      ForgeGlyph.assetName(for: .inspector, active: true),
      "layout-sidebar-right-collapse"
    )
    XCTAssertNotNil(ForgeGlyph.assetURL(for: .inspector, active: true))
  }

  func testComposerUsesSeparateConfigurationRowInNarrowConversation() {
    for width: CGFloat in [0, 440, 474, 600, 629] {
      XCTAssertTrue(ForgeClientDesign.Shell.composerUsesTwoControlRows(conversationWidth: width))
    }
    for width: CGFloat in [630, 695, 760, 1400] {
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
    XCTAssertEqual(ForgeClientDesign.Shell.conversationHeaderHeight, 36)
    XCTAssertEqual(ForgeClientDesign.Shell.workspaceStatusSlotWidth, 28)
    XCTAssertEqual(ForgeClientDesign.Shell.composerTextHeight, 38)
    XCTAssertEqual(ForgeClientDesign.Shell.readingGutter, 20)
    XCTAssertEqual(ForgeClientDesign.Shell.composerControlHeight, 30)
  }

  func testWindowConfiguratorKeepsHostingSurfaceTransparentForBehindWindowGlass() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
      styleMask: [.titled],
      backing: .buffered,
      defer: false
    )
    let contentView = NSView(frame: window.contentView?.bounds ?? .zero)
    contentView.wantsLayer = true
    contentView.layer?.backgroundColor = NSColor.red.cgColor
    contentView.layer?.isOpaque = true
    window.contentView = contentView

    ForgeWindowConfigurator.configure(window)

    XCTAssertFalse(window.isOpaque)
    XCTAssertEqual(window.backgroundColor.alphaComponent, 0, accuracy: 0.001)
    XCTAssertTrue(contentView.wantsLayer)
    XCTAssertFalse(contentView.layer?.isOpaque ?? true)
    XCTAssertEqual(contentView.layer?.backgroundColor?.alpha ?? 1, 0, accuracy: 0.001)
  }

  func testClientOwnsDarkGlassAppearanceIndependentOfSystemTheme() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot =
      testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let appSource = try String(
      contentsOf: packageRoot.appendingPathComponent("Sources/ForgeNative/ForgeNativeApp.swift"),
      encoding: .utf8
    )
    let designSource = try String(
      contentsOf: packageRoot.appendingPathComponent("Sources/ForgeNative/ForgeClientDesign.swift"),
      encoding: .utf8
    )
    let agentSource = try String(
      contentsOf: packageRoot.appendingPathComponent("Sources/ForgeNative/AgentWorkbenchViews.swift"),
      encoding: .utf8
    )
    XCTAssertTrue(appSource.contains(".preferredColorScheme(.dark)"))
    XCTAssertTrue(appSource.contains(".forgeTransparentWindowContainer()"))
    XCTAssertTrue(designSource.contains("containerBackground(.clear, for: .window)"))
    XCTAssertTrue(
      agentSource.contains(
        ".scrollIndicators(.automatic)\n                .scrollContentBackground(.hidden)\n                .background {"
      )
    )
    XCTAssertTrue(designSource.contains("static let windowTint = Color.black.opacity(0.18)"))
    XCTAssertTrue(designSource.contains("static let sidePanel = Color.black.opacity(0.10)"))
    XCTAssertTrue(designSource.contains("window.appearance = NSAppearance(named: .darkAqua)"))
    XCTAssertFalse(designSource.contains("window.appearance = nil"))
  }

  func testDropdownsDoNotRegressToRaisedPopupPickers() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot =
      testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourcesRoot = packageRoot.appendingPathComponent("Sources/ForgeNative")
    let fileManager = FileManager.default
    let sourceURLs =
      (fileManager.enumerator(
        at: sourcesRoot,
        includingPropertiesForKeys: nil
      )?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }

    var raisedMenuPickerFiles: [String] = []
    var nonSegmentedPickerFiles: [String] = []
    var raisedTextFieldFiles: [String] = []

    for url in sourceURLs {
      let source = try String(contentsOf: url, encoding: .utf8)
      let relativePath = url.path.replacingOccurrences(
        of: packageRoot.path + "/",
        with: ""
      )
      if source.contains(".pickerStyle(.menu)") {
        raisedMenuPickerFiles.append(relativePath)
      }
      if source.contains(".textFieldStyle(.roundedBorder)") {
        raisedTextFieldFiles.append(relativePath)
      }

      let pickerSegments = source.components(separatedBy: "Picker(").dropFirst()
      for segment in pickerSegments {
        let localControl = String(segment.prefix(600))
        if !localControl.contains(".pickerStyle(.segmented)") {
          nonSegmentedPickerFiles.append(relativePath)
          break
        }
      }
    }

    XCTAssertTrue(
      raisedMenuPickerFiles.isEmpty,
      "Dropdowns must use Menu + ForgeMenuTriggerLabel, not raised .pickerStyle(.menu): \(raisedMenuPickerFiles)"
    )
    XCTAssertTrue(
      nonSegmentedPickerFiles.isEmpty,
      "Picker is reserved for segmented controls; dropdowns must use Menu + ForgeMenuTriggerLabel: \(nonSegmentedPickerFiles)"
    )
    XCTAssertTrue(
      raisedTextFieldFiles.isEmpty,
      "Text fields must use forgeInputSurface or another flat shared surface, not .roundedBorder: \(raisedTextFieldFiles)"
    )
  }

  func testClientNoticeLivesBesideSettingsInsteadOfConsumingTopSpace() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot =
      testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let shellURL = packageRoot.appendingPathComponent("Sources/ForgeNative/ForgeClientShell.swift")
    let source = try String(contentsOf: shellURL, encoding: .utf8)

    XCTAssertTrue(source.contains("forge.settings.notice"))
    XCTAssertTrue(source.contains("private var clientNoticePopover"))
    XCTAssertFalse(
      source.contains(
        "if let error = model.error, model.page != .schedule && model.page != .plugins"),
      "Client errors must not consume a persistent row above the main workspace."
    )
  }

  func testWindowToolbarOnlyReservesSpaceForAnAvailableBackAction() {
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: false, isAgentPage: false, inspectorVisible: false))
    XCTAssertTrue(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: true, isAgentPage: false, inspectorVisible: false))
    XCTAssertFalse(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: true, isAgentPage: true, inspectorVisible: true))
    XCTAssertTrue(
      ForgeClientDesign.Shell.shouldShowWindowToolbar(
        canNavigateBack: true, isAgentPage: true, inspectorVisible: false))
  }

}
