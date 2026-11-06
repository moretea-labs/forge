import AppKit
import Foundation

// Canonical Forge desktop app mark. The app, dock, and in-app identity all
// consume PNGs generated from this single vector drawing.
private let canvas: CGFloat = 1024

private func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

private func polygon(_ coordinates: [(CGFloat, CGFloat)], fill: NSColor) {
    guard let first = coordinates.first else { return }
    let path = NSBezierPath()
    path.move(to: NSPoint(x: first.0, y: first.1))
    for point in coordinates.dropFirst() {
        path.line(to: NSPoint(x: point.0, y: point.1))
    }
    path.close()
    fill.setFill()
    path.fill()
}

private func paint() {
    let shell = NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944),
                             xRadius: 222, yRadius: 222)
    NSGraphicsContext.saveGraphicsState()
    shell.addClip()
    NSGradient(starting: color(54, 44, 141), ending: color(132, 110, 231))!
        .draw(in: shell, angle: 118)

    // Fine satin highlight, never a noisy glow; preserves legibility at 16 px.
    let topLight = NSBezierPath(ovalIn: NSRect(x: 90, y: 370, width: 800, height: 880))
    color(193, 173, 255, 0.075).setFill()
    topLight.fill()
    let bottomShade = NSBezierPath(ovalIn: NSRect(x: 380, y: -210, width: 770, height: 690))
    color(25, 21, 80, 0.12).setFill()
    bottomShade.fill()
    NSGraphicsContext.restoreGraphicsState()

    shell.lineWidth = 7
    color(238, 230, 255, 0.26).setStroke()
    shell.stroke()

    // Chiselled, faceted F. The broad stem and open counters stay distinctive
    // in macOS Dock, Finder, the menu bar, and compact sidebar placement.
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = color(19, 12, 63, 0.22)
    shadow.shadowBlurRadius = 27
    shadow.shadowOffset = NSSize(width: 0, height: -16)
    shadow.set()

    polygon([
        (316, 258), (745, 258), (695, 369), (445, 369),
        (445, 474), (666, 474), (624, 574), (445, 574),
        (445, 759), (316, 805),
    ], fill: color(251, 249, 255))
    NSGraphicsContext.restoreGraphicsState()

    // Two restrained facet tones supply a recognizable forged-metal depth
    // without compromising the white F silhouette.
    polygon([
        (316, 258), (388, 315), (388, 780), (316, 805),
    ], fill: color(205, 201, 255, 0.60))
    polygon([
        (388, 780), (445, 759), (316, 805),
    ], fill: color(178, 179, 245, 0.8))
    polygon([
        (445, 474), (666, 474), (624, 574), (445, 574),
    ], fill: color(227, 223, 255, 0.72))
}

private func render(size: Int, output: URL) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else { throw NSError(domain: "ForgeIcon", code: 1) }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let scale = NSAffineTransform()
    scale.scale(by: CGFloat(size) / canvas)
    scale.concat()
    paint()
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "ForgeIcon", code: 2)
    }
    try png.write(to: output, options: .atomic)
}

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift render-app-icon.swift <src-tauri/icons-directory>\n", stderr)
    exit(2)
}
let outputDir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let fm = FileManager.default
try fm.createDirectory(at: outputDir, withIntermediateDirectories: true)
for (name, px) in [
    ("icon.png", 1024),
    ("32x32.png", 32),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
] {
    try render(size: px, output: outputDir.appendingPathComponent(name))
}

// Finder/Dock use a single canonical .icns with correctly rasterized retina
// variants rather than scaling the old 32px placeholder at runtime.
let iconset = outputDir.appendingPathComponent("Forge.iconset", isDirectory: true)
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
for (basename, px) in [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
] {
    try render(size: px, output: iconset.appendingPathComponent(basename))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", "-o",
    outputDir.appendingPathComponent("icon.icns").path, iconset.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
    throw NSError(domain: "ForgeIcon", code: Int(iconutil.terminationStatus))
}
try fm.removeItem(at: iconset)
print("Forge icon assets rendered from canonical vector: 32px, 128px, 256px, 1024px, ICNS")
