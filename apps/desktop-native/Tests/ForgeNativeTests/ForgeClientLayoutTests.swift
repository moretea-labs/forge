import AppKit
import Foundation
import XCTest

@testable import ForgeNative

final class ForgeClientLayoutTests: XCTestCase {
  func testCompactWindowsReclaimSidebarWidthWithoutCollapsingNavigation() {
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 720), 201.6, accuracy: 0.001)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 800), 218)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 860), 218)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1100), 231)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260), 264.6, accuracy: 0.001)
    XCTAssertEqual(ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1800), 266)
  }

  func testSidebarWidthStaysWithinExistingDesignBounds() {
    let widths = [CGFloat(600), 860, 1100, 1260, 1440, 1800, 2400]
    let result = widths.map { ForgeClientDesign.Shell.sidebarWidth(windowWidth: $0) }
    XCTAssertEqual(result, result.sorted())
    XCTAssertTrue(
      result.allSatisfy {
        $0 >= ForgeClientDesign.Shell.iconRailWidth + ForgeClientDesign.Shell.compactSidebarListMin
          && $0 <= ForgeClientDesign.Shell.sidebarIdeal
      })
  }

  func testSidebarWidthChangesContinuouslyAboveCompactMinimum() {
    let narrowBefore = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 719)
    let narrowAfter = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 720)
    XCTAssertEqual(narrowAfter - narrowBefore, 0.28, accuracy: 0.001)

    let before = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1259)
    let after = ForgeClientDesign.Shell.sidebarWidth(windowWidth: 1260)
    XCTAssertEqual(after - before, 0.21, accuracy: 0.001)
  }

  func testChromeIconMetricsAndNavigationSymbolsAreConsistent() {
    XCTAssertEqual(ForgeClientDesign.Icon.point, 13)
    XCTAssertEqual(ForgeClientDesign.Icon.hit, 28)
    XCTAssertEqual(ForgeClientDesign.Icon.railPoint, 14)
    XCTAssertEqual(ForgeClientDesign.Icon.railLabel, 9.5)
    XCTAssertEqual(ForgeClientDesign.Shell.iconRailWidth, 42)
    XCTAssertEqual(ForgeClientDesign.Shell.destinationRowHeight, 36)
    let glyphs = ForgeSidebarDestination.allCases.map(\.glyph)
    XCTAssertEqual(Set(glyphs).count, glyphs.count)
    XCTAssertEqual(glyphs, [.chat, .folder, .board, .tasks, .library, .analytics, .settings])

    let railSymbols = ForgeSidebarDestination.allCases.map(\.railSystemImage)
    XCTAssertEqual(Set(railSymbols).count, railSymbols.count)
    XCTAssertTrue(railSymbols.allSatisfy { !$0.isEmpty })
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
    XCTAssertEqual(ForgeClientDesign.Shell.workspaceHeaderHeight, 30)
    XCTAssertEqual(ForgeClientDesign.Shell.workspaceStatusSlotWidth, 28)
    XCTAssertEqual(ForgeClientDesign.Shell.composerTextHeight, 38)
    XCTAssertEqual(ForgeClientDesign.Shell.readingGutter, 18)
    XCTAssertEqual(ForgeClientDesign.Shell.compactSidebarListMin, 152)
    XCTAssertEqual(ForgeClientDesign.Shell.compactSidebarListIdeal, 176)
  }

  func testDropdownsDoNotRegressToRaisedPopupPickers() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let packageRoot = testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourcesRoot = packageRoot.appendingPathComponent("Sources/ForgeNative")
    let fileManager = FileManager.default
    let sourceURLs = (fileManager.enumerator(
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
}
