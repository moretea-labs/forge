import AppKit
import SwiftUI

/// Native visual contract: content first, icon-only secondary actions, quiet selection,
/// one consistent input surface; avoid decorative cards around navigation and status.
enum ForgePalette {
  static let canvas = Color(nsColor: .textBackgroundColor)
  static let ink = Color.primary
  static let secondary = Color(nsColor: .secondaryLabelColor)
  static let accent = Color(
    nsColor: NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor.controlAccentColor
        : NSColor.labelColor
    })
  static let selection = Color.primary.opacity(0.065)
  static let selectionStrong = Color.primary.opacity(0.095)
  static let userBubble = Color.primary.opacity(0.05)
  static let raisedSurface = Color(nsColor: .controlBackgroundColor)
  static let softFill = Color.primary.opacity(0.045)
  static let composer = Color(nsColor: .controlBackgroundColor).opacity(0.72)
  /// Near-invisible edge reserved for focus rings only — not column separators.
  static let hairline = Color.primary.opacity(0.08)
  static let primaryHairlineFocused = Color.primary.opacity(0.18)
  /// Soft tonal lift when a material backdrop is unavailable.
  static let sidePanel = Color.primary.opacity(0.02)
}

extension ForgeClientDesign {
  /// One optical size for chrome icons (rail / window toolbar / sidebar / composer).
  enum Icon {
    static let point: CGFloat = 13
    static let railPoint: CGFloat = 15
    static let railLabel: CGFloat = 9
    static let hit: CGFloat = 28
    static let weight: Font.Weight = .medium
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
      .symbolRenderingMode(.hierarchical)
      .foregroundStyle(active ? ForgePalette.ink : ForgePalette.secondary)
      .frame(width: ForgeClientDesign.Icon.hit, height: ForgeClientDesign.Icon.hit)
      .contentShape(Rectangle())
  }

  func forgeRailIcon(active: Bool) -> some View {
    self
      .font(.system(size: ForgeClientDesign.Icon.railPoint,
                    weight: active ? .semibold : ForgeClientDesign.Icon.weight))
      .symbolRenderingMode(.hierarchical)
      .foregroundStyle(active ? ForgePalette.ink : ForgePalette.secondary)
      .frame(height: 18)
  }
}

/// Quiet hover feedback for plain list/starter buttons (not toolbar/rail chrome).
struct ForgeHoverFill: ViewModifier {
  var cornerRadius: CGFloat = 8
  @State private var hovering = false
  func body(content: Content) -> some View {
    content
      .background(hovering ? ForgePalette.softFill : .clear,
                  in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .onHover { hovering = $0 }
      .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

extension View {
  func forgeHoverFill(cornerRadius: CGFloat = 8) -> some View {
    modifier(ForgeHoverFill(cornerRadius: cornerRadius))
  }
}

/// The only secondary-action style: plain accent text, hover tint, no bezel/card.
struct ForgeTextButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(isEnabled ? Color(nsColor: .controlAccentColor) : ForgePalette.secondary.opacity(0.55))
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
    static let sheetPadding: CGFloat = 22
    static let section: CGFloat = 18
    static let row: CGFloat = 9
    static let titleDetail: CGFloat = 4
  }
  enum Typography {
    static let sheetTitle: Font = .system(size: 17, weight: .semibold)
    static let sectionTitle: Font = .system(size: 12, weight: .semibold)
    static let body: Font = .system(size: 12)
    static let control: Font = .system(size: 11)
    static let supporting: Font = .system(size: 11)
    static let identifier: Font = .system(size: 11, design: .monospaced)
  }
  enum Shell {
    /// Narrow left activity rail (会话 / 项目 / 看板), Cursor-like density.
    static let iconRailWidth: CGFloat = 52
    static let listMin: CGFloat = 200
    static let listIdeal: CGFloat = 236
    static let listMax: CGFloat = 280
    static let sidebarMin: CGFloat = iconRailWidth + listMin
    static let sidebarIdeal: CGFloat = iconRailWidth + listIdeal
    static let sidebarMax: CGFloat = iconRailWidth + listMax
    static let workSurfaceMin: CGFloat = 360
    /// Centered reading column shared by transcript and composer (Cursor/Claude style).
    static let readingColumn: CGFloat = 760
    static let destinationRowHeight: CGFloat = 42
    static let threadRowHeight: CGFloat = 28
    static let sessionTitle: Font = .system(size: 13.5, weight: .semibold)
    static let body: Font = .system(size: 12.5)
    static let supporting: Font = .system(size: 11)
    static let control: Font = .system(size: 11, weight: .medium)
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
