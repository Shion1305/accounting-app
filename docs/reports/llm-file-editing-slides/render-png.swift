import Foundation
import AppKit

let args = CommandLine.arguments
if args.count < 3 { fputs("usage: swift render-png.swift INPUT.svg OUTPUT.png [scale]\n", stderr); exit(2) }
let scale = args.count > 3 ? Double(args[3]) ?? 1.0 : 1.0
guard let source = NSImage(contentsOfFile: args[1]) else { fputs("NSImage could not decode SVG\n", stderr); exit(1) }
let size = source.size
let width = Int((size.width * scale).rounded())
let height = Int((size.height * scale).rounded())
guard width > 0, height > 0, let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fputs("Cannot make bitmap\n", stderr); exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
source.draw(in: NSRect(x: 0, y: 0, width: width, height: height), from: .zero, operation: .copy, fraction: 1)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fputs("Cannot encode PNG\n", stderr); exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
print("Rendered \(width)x\(height), \(png.count) bytes: \(args[2])")
