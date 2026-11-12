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
    // AppKit coordinates run bottom-to-top. Keep the crown above the crossbar.
    let shell = NSBezierPath(roundedRect: NSRect(x: 56, y: 56, width: 912, height: 912),
                             xRadius: 210, yRadius: 210)
    NSGradient(starting: color(25, 29, 34), ending: color(49, 54, 61))!
        .draw(in: shell, angle: 90)
    shell.lineWidth = 2
    color(255, 255, 255, 0.14).setStroke()
    shell.stroke()

    // One open, upright F: a substantial stem and two chamfered tool faces.
    // The broad silhouette and generous counter survive compact Dock sizes.
    let mark = NSBezierPath()
    mark.move(to: NSPoint(x: 302, y: 250))
    for point in [
        NSPoint(x: 302, y: 772), NSPoint(x: 758, y: 772),
        NSPoint(x: 702, y: 642), NSPoint(x: 446, y: 642),
        NSPoint(x: 446, y: 541), NSPoint(x: 678, y: 541),
        NSPoint(x: 626, y: 417), NSPoint(x: 446, y: 417),
        NSPoint(x: 446, y: 250),
    ] { mark.line(to: point) }
    mark.close()

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = color(0, 0, 0, 0.30)
    shadow.shadowBlurRadius = 20
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.set()
    color(231, 120, 58).setFill()
    mark.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGradient(starting: color(221, 99, 48), ending: color(255, 199, 120))!
        .draw(in: mark, angle: 90)

    // A single narrow bevel, subordinate to the solid F silhouette.
    polygon([
        (302, 250), (322, 268), (322, 752), (302, 772),
    ], fill: color(255, 216, 158, 0.45))
    polygon([
        (302, 772), (758, 772), (746, 752), (322, 752),
    ], fill: color(255, 231, 192, 0.54))
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
