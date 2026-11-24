import AppKit
import SwiftUI

/// Forge's primary chrome icons are official Tabler outline assets, not hand-drawn paths.
enum ForgeGlyphKind: String, CaseIterable {
    case chat = "message-circle"
    case folder = "folder"
    case board = "layout-kanban"
    case tasks = "checklist"
    case library = "books"
    case analytics = "chart-line"
    case settings = "settings"
    case back = "arrow-left"
    case refresh = "refresh"
    case compose = "edit"
    case search = "search"
    case inbox = "inbox"
    case inspector = "layout-sidebar-right-expand"
    case capabilities = "components"
    case close = "x"
    case expand = "arrows-maximize"
    case restore = "arrows-minimize"
    case attachment = "paperclip"
    case microphone = "microphone"
    case stop = "square"
    case send = "send"
    case copy = "copy"
}

struct ForgeGlyph: View {
    enum Role: Equatable {
        case chrome
        case rail
        case inline
    }

    let kind: ForgeGlyphKind
    var role: Role = .chrome
    var active = false
    var tint: Color?

    init(
        _ kind: ForgeGlyphKind,
        role: Role = .chrome,
        active: Bool = false,
        tint: Color? = nil
    ) {
        self.kind = kind
        self.role = role
        self.active = active
        self.tint = tint
    }

    private var glyphSize: CGFloat {
        role == .rail ? ForgeClientDesign.Icon.railPoint : ForgeClientDesign.Icon.point
    }

    private var frameSize: CGFloat {
        role == .inline ? glyphSize : ForgeClientDesign.Icon.hit
    }

    @ViewBuilder
    private var glyphImage: some View {
        if let image = Self.image(for: kind, active: active) {
            Image(nsImage: image)
                .resizable()
                .renderingMode(.template)
        }
    }

    var body: some View {
        glyphImage
            .frame(width: glyphSize, height: glyphSize)
            .foregroundStyle(tint ?? (active ? ForgePalette.ink : ForgePalette.secondary))
            .frame(width: frameSize, height: frameSize)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }

    static let iconSetVersion = "3.52.0"

    static func assetName(for kind: ForgeGlyphKind, active: Bool = false) -> String {
        if kind == .inspector && active {
            return "layout-sidebar-right-collapse"
        }
        return kind.rawValue
    }

    static func assetURL(for kind: ForgeGlyphKind, active: Bool = false) -> URL? {
        Bundle.module.url(
            forResource: assetName(for: kind, active: active),
            withExtension: "svg",
            subdirectory: "Tabler"
        )
    }

    static func image(for kind: ForgeGlyphKind, active: Bool = false) -> NSImage? {
        ForgeTablerIconCache.image(named: assetName(for: kind, active: active))
    }
}

private enum ForgeTablerIconCache {
    private static let images = NSCache<NSString, NSImage>()

    static func image(named name: String) -> NSImage? {
        let key = name as NSString
        if let cached = images.object(forKey: key) {
            return cached
        }
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "svg",
            subdirectory: "Tabler"
        ), let image = NSImage(contentsOf: url) else {
            return nil
        }
        image.isTemplate = true
        images.setObject(image, forKey: key)
        return image
    }
}
