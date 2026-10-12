import Foundation
import AppKit
import CoreGraphics

let arguments = CommandLine.arguments
if arguments.count < 3 { fputs("usage: swift render-pdf.swift OUTPUT.pdf INPUT.svg...\n", stderr); exit(2) }
let destination = URL(fileURLWithPath: arguments[1])
guard let consumer = CGDataConsumer(url: destination as CFURL) else { fputs("Cannot create output\n", stderr);exit(1) }
let metadata: [CFString: Any] = [kCGPDFContextTitle: "LLMによる会計帳票編集 - 実装と検証結果", kCGPDFContextAuthor: "", kCGPDFContextCreator: "Offline SVG slide export", kCGPDFContextSubject: "2026-10-12 PoC; implementation, tool interaction, results and estimated API cost"]
guard let pdf = CGContext(consumer: consumer, mediaBox: nil, metadata as CFDictionary) else { fputs("Cannot create PDF context\n", stderr);exit(1) }
for filename in arguments.dropFirst(2) {
    guard let source = NSImage(contentsOfFile: filename) else { fputs("Cannot load SVG: \(filename)\n", stderr);exit(1) }
    var pageBox = CGRect(x: 0, y: 0, width: source.size.width, height: source.size.height)
    let pageData = NSData(bytes: &pageBox, length: MemoryLayout<CGRect>.size)
    pdf.beginPDFPage([kCGPDFContextMediaBox:pageData] as CFDictionary)
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(cgContext: pdf, flipped: false)
    context.imageInterpolation = .high
    NSGraphicsContext.current = context
    source.draw(in: pageBox, from: .zero, operation: .sourceOver, fraction: 1)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    pdf.endPDFPage()
}
pdf.closePDF()
print("Exported \(arguments.count - 2) pages to \(arguments[1])")
