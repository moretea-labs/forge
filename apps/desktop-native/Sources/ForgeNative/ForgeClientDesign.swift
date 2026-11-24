import AppKit
import SwiftUI

/// Native visual contract: content first, icon-only secondary actions, quiet selection,
/// one consistent input surface; avoid decorative cards around navigation and status.
enum ForgePalette {
  // The window itself is glass. Content gets only a light adaptive wash so
  // text stays readable without turning the main workspace back into an opaque panel.
  static let canvas = Color.clear
  static let ink = Color.primary
  static let secondary = Color(nsColor: .secondaryLabelColor)
  static let accent = Color(
    nsColor: NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor.controlAccentColor
        : NSColor.labelColor
    })
  // Selection and hover are light floating washes, not opaque rows.
  static let selection = Color(nsColor: .labelColor).opacity(0.036)
  static let selectionStrong = Color(nsColor: .labelColor).opacity(0.060)
  // Semantic washes adapt to appearance instead of disappearing on light glass.
  private static func wash(dark: CGFloat, light: CGFloat) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      return isDark ? NSColor.white.withAlphaComponent(dark)
        : NSColor.black.withAlphaComponent(light)
    })
  }
  static let userBubble = wash(dark: 0.065, light: 0.045)
  static let raisedSurface = wash(dark: 0.055, light: 0.035)
  static let softFill = wash(dark: 0.030, light: 0.025)
  static let inputFill = wash(dark: 0.035, light: 0.025)
  static let composer = wash(dark: 0.025, light: 0.018)
  static let hairline = wash(dark: 0.065, light: 0.055)
  static let primaryHairlineFocused = wash(dark: 0.20, light: 0.16)
  // Keep the reading surface neutral and distinguish navigation by tone,
  // rather than stacking multiple equally gray translucent layers.
  static let windowTint = Color.clear
  static let railTint = Color.clear
  static let listTint = Color.clear
  static let sidePanel = Color.clear
  static let floatingTint = wash(dark: 0.022, light: 0.012)
  static let floatingStroke = wash(dark: 0.032, light: 0.024)
}

extension ForgeClientDesign {
  /// One optical size for chrome icons (rail / window toolbar / sidebar / composer).
  enum Icon {
    static let point: CGFloat = 13
    static let railPoint: CGFloat = 14
    static let railGlyphHeight: CGFloat = 18
    static let railLabel: CGFloat = 9.5
    static let hit: CGFloat = 28
    static let weight: Font.Weight = .regular
    static var font: Font { .system(size: point, weight: weight) }
    static var railFont: Font { .system(size: railPoint, weight: weight) }
    static var railLabelFont: Font { .system(size: railLabel, weight: .regular) }
  }
}

extension Image {
  /// Toolbar / sidebar / composer glyph with shared optical size.
  func forgeChromeIcon(active: Bool = false) -> some View {
    self
      .font(ForgeClientDesign.Icon.font)
      .symbolRenderingMode(.monochrome)
      .foregroundStyle(active ? ForgePalette.ink : ForgePalette.secondary)
      .frame(width: ForgeClientDesign.Icon.hit, height: ForgeClientDesign.Icon.hit)
      .contentShape(Rectangle())
  }

  func forgeRailIcon(active: Bool) -> some View {
    self
      .font(ForgeClientDesign.Icon.railFont)
      .symbolRenderingMode(.monochrome)
      .foregroundStyle(active ? ForgePalette.ink : ForgePalette.secondary)
      .frame(width: 24, height: ForgeClientDesign.Icon.railGlyphHeight)
  }
}

/// Quiet hover feedback for plain list/starter buttons.
struct ForgeHoverFill: ViewModifier {
  var cornerRadius: CGFloat = 7
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var hovering = false
  func body(content: Content) -> some View {
    content
      .background(
        hovering ? ForgePalette.selection.opacity(0.65) : .clear,
        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      )
      .onHover { hovering = $0 }
      .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
  }
}

/// Shared toolbar/rail interaction surface. Selected chrome stays deliberately
/// close to hover so navigation never turns into a stack of opaque buttons.
struct ForgeChromeSurface: ViewModifier {
  let selected: Bool
  var cornerRadius: CGFloat = 9
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var hovering = false

  func body(content: Content) -> some View {
    content
      .background(
        selected
          ? ForgePalette.selection
          : (hovering ? ForgePalette.selection.opacity(0.65) : .clear),
        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      )
      .onHover { hovering = $0 }
      .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: selected)
  }
}

extension View {
  func forgeHoverFill(cornerRadius: CGFloat = 8) -> some View {
    modifier(ForgeHoverFill(cornerRadius: cornerRadius))
  }

  func forgeChromeSurface(selected: Bool = false, cornerRadius: CGFloat = 9) -> some View {
    modifier(ForgeChromeSurface(selected: selected, cornerRadius: cornerRadius))
  }

  /// Shared behind-window material for the whole application shell.
  func forgeWindowMaterial() -> some View {
    background {
      ZStack {
        ForgeVisualEffectView(material: .underWindowBackground, blendingMode: .behindWindow)
          .ignoresSafeArea()
        ForgePalette.windowTint.ignoresSafeArea()
      }
    }
  }

  /// Slightly stronger vibrancy for navigation rails/list columns. Depth comes
  /// from tonal material, never a separator line or opaque sidebar slab.
  func forgeSidebarMaterial() -> some View {
    background {
      ZStack {
        ForgeVisualEffectView(material: .sidebar, blendingMode: .behindWindow)
          .ignoresSafeArea()
        ForgePalette.sidePanel.ignoresSafeArea()
      }
    }
  }

  /// Rounded outer glass panel used by the left navigation and main workspace.
  /// This is the primary visual separation in the shell; no hard split lines.
  func forgePanelGlass(
    cornerRadius: CGFloat = 18,
    material: NSVisualEffectView.Material = .underWindowBackground
  ) -> some View {
    background {
      ZStack {
        ForgeVisualEffectView(material: material, blendingMode: .behindWindow)
        ForgePalette.windowTint
      }
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
    .overlay {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(ForgePalette.floatingStroke, lineWidth: 0.5)
    }
  }

  /// Nested floating glass for composer/search/work-surface controls.
  func forgeFloatingGlass(cornerRadius: CGFloat = 14) -> some View {
    background {
      ZStack {
        ForgeVisualEffectView(material: .popover, blendingMode: .withinWindow)
        ForgePalette.floatingTint
      }
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
    .overlay {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(ForgePalette.floatingStroke, lineWidth: 0.5)
    }
  }

  /// Covers the system split divider with the same behind-window glass so column
  /// separation reads as air/gap instead of a black IDE-style rule.
  func forgeSplitSeamMask(material: NSVisualEffectView.Material = .underWindowBackground)
    -> some View
  {
    overlay(alignment: .trailing) {
      ForgeVisualEffectView(material: material, blendingMode: .behindWindow)
        .frame(width: 6)
        .offset(x: 3)
        .allowsHitTesting(false)
    }
  }
}

/// AppKit vibrancy host — SwiftUI `.ultraThinMaterial` alone is painted over by
/// NavigationSplitView's opaque column chrome on macOS.
struct ForgeVisualEffectView: NSViewRepresentable {
  var material: NSVisualEffectView.Material = .sidebar
  var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow

  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = material
    view.blendingMode = blendingMode
    view.state = .followsWindowActiveState
    view.isEmphasized = true
    return view
  }

  func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
    nsView.material = material
    nsView.blendingMode = blendingMode
  }
}

/// SwiftUI's WindowGroup is opaque by default. Configure the hosting NSWindow once
/// it exists so behind-window material can remain visible across the entire client.
struct ForgeWindowConfigurator: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let view = NSView(frame: .zero)
    DispatchQueue.main.async { configure(view.window) }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async { configure(nsView.window) }
  }

  private func configure(_ window: NSWindow?) {
    guard let window else { return }
    // Follow the user's macOS appearance. Palette washes and native materials
    // are semantic, so light and dark modes share the same visual hierarchy.
    window.appearance = nil
    window.isOpaque = false
    window.backgroundColor = .clear
    window.titlebarAppearsTransparent = true
  }
}

/// The only secondary-action style: plain accent text, hover tint, no bezel/card.
struct ForgeTextButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(
        isEnabled ? Color(nsColor: .controlAccentColor) : ForgePalette.secondary.opacity(0.55)
      )
      .padding(.horizontal, 8).padding(.vertical, 4)
      .forgeHoverFill(cornerRadius: 6)
      .opacity(configuration.isPressed ? 0.6 : 1)
      .contentShape(Rectangle())
  }
}

extension ButtonStyle where Self == ForgeTextButtonStyle {
  static var forgeText: ForgeTextButtonStyle { ForgeTextButtonStyle() }
}

/// Shared native form vocabulary: semantic system colors, no parallel theme engine.
enum ForgeClientDesign {
  enum Spacing {
    static let sheetPadding: CGFloat = 20
    static let section: CGFloat = 16
    static let row: CGFloat = 8
    static let titleDetail: CGFloat = 3
  }
  enum Typography {
    static let sheetTitle: Font = .system(size: 16, weight: .semibold)
    static let sectionTitle: Font = .system(size: 11.5, weight: .semibold)
    static let body: Font = .system(size: 11.75)
    static let control: Font = .system(size: 10.5)
    static let supporting: Font = .system(size: 10.5)
    static let identifier: Font = .system(size: 10.5, design: .monospaced)
  }
  enum Shell {
    /// Narrow left activity rail (会话 / 项目 / 看板), Cursor-like density.
    static let iconRailWidth: CGFloat = 42
    static let listMin: CGFloat = 188
    static let listIdeal: CGFloat = 224
    static let listMax: CGFloat = 268
    static let sidebarMin: CGFloat = iconRailWidth + listMin
    static let sidebarIdeal: CGFloat = iconRailWidth + listIdeal
    static let sidebarMax: CGFloat = iconRailWidth + listMax
    static let workSurfaceMin: CGFloat = 360
    /// Centered reading column shared by transcript and composer (Cursor/Claude style).
    static let readingColumn: CGFloat = 760
    static let destinationRowHeight: CGFloat = 36
    static let threadRowHeight: CGFloat = 30
    static let threadActionWidth: CGFloat = 22
    static let threadSectionSpacing: CGFloat = 12
    static let threadSectionTitle: Font = .system(size: 10, weight: .medium)
    static let threadTitlePoint: CGFloat = 12
    static let sessionTitle: Font = .system(size: 13, weight: .semibold)
    static let sidebarTitle: Font = .system(size: 10.5, weight: .medium)
    static let threadTitle: Font = .system(size: threadTitlePoint, weight: .regular)
    static let threadTitleSelected: Font = .system(size: threadTitlePoint, weight: .medium)
    static let body: Font = .system(size: 12.5)
    static let supporting: Font = .system(size: 11)
    static let control: Font = .system(size: 10.5, weight: .medium)
  }
  enum Transcript {
    static let bodyPoint: CGFloat = 13
    static let body: Font = .system(size: bodyPoint)
    static let lineSpacing: CGFloat = 4
    static let blockSpacing: CGFloat = 10
    static let listSpacing: CGFloat = 5
    static let heading1: Font = .system(size: 18, weight: .semibold)
    static let heading2: Font = .system(size: 15.5, weight: .semibold)
    static let heading3: Font = .system(size: 14, weight: .semibold)
    static let heading4: Font = .system(size: 12.75, weight: .medium)
    static let table: Font = .system(size: 11.25)
    static let code: Font = .system(size: 12, design: .monospaced)
    static let codeHeader: Font = .system(size: 9.75, weight: .medium, design: .monospaced)
  }
  enum Size {
    static let approvalSheet: CGFloat = 520
    static let checkpointSheet: CGFloat = 500
    static let taskCreateSheet: CGFloat = 430
    static let taskEditSheet: CGFloat = 465
    static let taskFormContentMaxHeight: CGFloat = 420
    static let acceptanceCriteriaMaxHeight: CGFloat = 120
    static let taskAcceptanceSheet: CGFloat = 490
    static let metadataLabel: CGFloat = 90
  }
}

/// Use type and spacing instead of cards and separator lines.
struct ForgeInspectorEmptyState: View {
  let title: String
  let symbol: String

  var body: some View {
    Label(title, systemImage: symbol)
      .font(.system(size: 12))
      .foregroundStyle(ForgePalette.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
  }
}

extension View {
  func forgeInspectorSearchSurface() -> some View {
    self.padding(.horizontal, 10)
      .frame(height: 32)
      .background(ForgePalette.softFill, in: RoundedRectangle(cornerRadius: 8))
  }
}


struct ForgeClientFormSection<Content: View>: View {
  let title: String
  var detail: String? = nil
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.row) {
      Text(title).font(ForgeClientDesign.Typography.sectionTitle)
      if let detail, !detail.isEmpty {
        Text(detail)
          .font(ForgeClientDesign.Typography.supporting)
          .foregroundStyle(.secondary)
      }
      content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Persistent labels stay visible while fields are being edited.
struct ForgeClientFormField<Content: View>: View {
  let label: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.titleDetail) {
      Text(label)
        .font(ForgeClientDesign.Typography.control)
        .foregroundStyle(.secondary)
      content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct ForgeClientMetadataRow: View {
  let label: String
  let value: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: ForgeClientDesign.Spacing.row) {
      Text(label)
        .frame(width: ForgeClientDesign.Size.metadataLabel, alignment: .leading)
        .foregroundStyle(.secondary)
      Text(value)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
    .font(ForgeClientDesign.Typography.control)
    .accessibilityElement(children: .combine)
  }
}
