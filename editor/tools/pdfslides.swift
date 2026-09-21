// Renders every page of a PDF deck to PNG and prints each page's text as JSON, using Apple's PDFKit.
//   pdfslides <deck.pdf> <outDir> [longEdgePx]
// → [{ "page": 1, "file": "slide-001.png", "width": 1920, "height": 1080, "text": "…" }, …]
import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count >= 3, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("usage: pdfslides <deck.pdf> <outDir> [longEdgePx]\n".data(using: .utf8)!)
  exit(2)
}
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
let longEdge = CGFloat(args.count > 3 ? Double(args[3]) ?? 1920 : 1920)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

var pages: [[String: Any]] = []
for i in 0..<min(doc.pageCount, 300) {
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .mediaBox)
  let rotated = page.rotation % 180 != 0
  let size = rotated ? CGSize(width: box.height, height: box.width) : box.size
  let scale = longEdge / max(size.width, size.height)
  let w = Int((size.width * scale).rounded()), h = Int((size.height * scale).rounded())

  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let ctx = NSGraphicsContext(bitmapImageRep: rep) else { continue }
  let cg = ctx.cgContext
  cg.setFillColor(NSColor.white.cgColor)
  cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
  cg.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: cg)

  // Document-style pages carry wide empty margins: keep only the content (plus a little air), so the slide fills
  // the card on screen instead of floating small in white.
  var minX = w, minY = h, maxX = -1, maxY = -1
  if let data = rep.bitmapData {
    let bpr = rep.bytesPerRow
    for y in stride(from: 0, to: h, by: 2) {
      for x in stride(from: 0, to: w, by: 2) {
        let p = data + (y * bpr + x * 4)
        if Int(p[0]) + Int(p[1]) + Int(p[2]) < 738 {
          minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
      }
    }
  }
  var crop = CGRect(x: 0, y: 0, width: w, height: h)
  if maxX > minX && maxY > minY {
    let pad = Int(Double(max(maxX - minX, maxY - minY)) * 0.04)
    let box = CGRect(x: max(0, minX - pad), y: max(0, minY - pad), width: min(w, maxX + pad) - max(0, minX - pad), height: min(h, maxY + pad) - max(0, minY - pad))
    if box.width * box.height < CGFloat(w * h) * 0.9 { crop = box }
  }
  var image = rep.cgImage!
  if crop.size != CGSize(width: w, height: h), let cut = image.cropping(to: crop) { image = cut }
  let out = NSBitmapImageRep(cgImage: image)

  let name = String(format: "slide-%03d.png", i + 1)
  guard let png = out.representation(using: .png, properties: [:]) else { continue }
  try png.write(to: outDir.appendingPathComponent(name))
  let text = (page.string ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  pages.append(["page": i + 1, "file": name, "width": image.width, "height": image.height, "text": String(text.prefix(1200))])
}
let json = try JSONSerialization.data(withJSONObject: pages, options: [])
FileHandle.standardOutput.write(json)
