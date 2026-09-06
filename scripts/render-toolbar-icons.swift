import AppKit
let root = CommandLine.arguments[1]
let source = URL(fileURLWithPath: root + "/Shared (Extension)/Resources/images/toolbar-icon.svg")
guard let image = NSImage(contentsOf: source) else { fatalError("Cannot load SVG") }
for size in [16, 19, 24, 32, 38, 48, 64, 96, 128] {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = CGFloat(size) * 0.1
    image.draw(in: NSRect(x: inset, y: inset, width: CGFloat(size) * 0.8, height: CGFloat(size) * 0.8), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: root + "/Shared (Extension)/Resources/images/toolbar-small-\(size).png"))
    var minX = size, maxX = -1, minY = size, maxY = -1
    for y in 0..<size { for x in 0..<size {
        if rep.colorAt(x: x, y: y)!.alphaComponent > 0.1 { minX = min(minX,x); maxX = max(maxX,x); minY = min(minY,y); maxY = max(maxY,y) }
    }}
    print("\(size)px canvas: artwork \(maxX-minX+1)x\(maxY-minY+1), bounds \(minX),\(minY)–\(maxX),\(maxY)")
}
