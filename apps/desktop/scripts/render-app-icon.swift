import AppKit
import Foundation

// The approved, unmasked artwork is the single source for all client surfaces.
let sourceURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../assets/app-icon-source.png").standardizedFileURL
let sourceData = try Data(contentsOf: sourceURL)
guard let source = NSBitmapImageRep(data: sourceData),
      source.pixelsWide == source.pixelsHigh,
      source.pixelsWide >= 1024,
      let image = NSImage(data: sourceData) else {
    fatalError("App icon source must be a square image of at least 1024 pixels")
}
for y in 0..<source.pixelsHigh {
    for x in 0..<source.pixelsWide {
        guard source.colorAt(x: x, y: y)?.alphaComponent == 1 else {
            fatalError("App icon source must be fully opaque, including its corners")
        }
    }
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
    // Fill the whole canvas; the operating system owns the outer icon mask.
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
               from: .zero, operation: .copy, fraction: 1)
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
print("Forge icon assets rendered from approved opaque artwork: 32px, 128px, 256px, 1024px, ICNS")
