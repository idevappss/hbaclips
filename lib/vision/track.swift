// vision-track: finds faces, people and salient objects in a video with Apple's on-device Vision framework.
// Usage: vision-track <video> <start> <end> <step> [--mouths]
// Prints one JSON object per sampled frame: {"t","faces","humans","objects"}; boxes are [x, y, w, h, confidence]
// normalized to the displayed frame with a top-left origin. With --mouths, each face box gets a sixth number: how
// open the mouth is (inner-lip height over face height), which is how lib/speaker.js tells who is talking.
import AVFoundation
import Foundation
import Vision

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

let args = CommandLine.arguments
guard args.count >= 5, let start = Double(args[2]), let end = Double(args[3]), let step = Double(args[4]), step > 0 else {
  fail("usage: vision-track <video> <start> <end> <step>")
}

let mouths = args.contains("--mouths")
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = mouths ? CGSize(width: 1280, height: 1280) : CGSize(width: 960, height: 960)
let tolerance = CMTime(seconds: min(0.25, step / 2), preferredTimescale: 600)
generator.requestedTimeToleranceBefore = tolerance
generator.requestedTimeToleranceAfter = tolerance

func boxes(_ observations: [VNDetectedObjectObservation]?) -> [[Double]] {
  (observations ?? []).map { o in
    let b = o.boundingBox
    return [b.minX, 1 - b.maxY, b.width, b.height, Double(o.confidence)].map { ($0 * 1000).rounded() / 1000 }
  }
}

var t = start
while t <= end + 1e-6 {
  autoreleasepool {
    let image: CGImage
    do {
      image = try generator.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
    } catch {
      print("{\"t\":\(t),\"error\":\"frame\"}")
      return
    }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    var row: [String: Any] = ["t": (t * 1000).rounded() / 1000]
    if mouths {
      // Faces with lip landmarks only: the speaker pass samples often, so it skips people and saliency.
      let landmarks = VNDetectFaceLandmarksRequest()
      try? handler.perform([landmarks])
      row["faces"] = (landmarks.results ?? []).map { face -> [Double] in
        let b = face.boundingBox
        var open = 0.0
        if let lips = face.landmarks?.innerLips?.normalizedPoints, lips.count > 2 {
          let ys = lips.map { Double($0.y) }
          open = (ys.max()! - ys.min()!) // already relative to the face box height
        }
        return [b.minX, 1 - b.maxY, b.width, b.height, Double(face.confidence), open].map { ($0 * 1000).rounded() / 1000 }
      }
      row["humans"] = []
      row["objects"] = []
    } else {
      let faces = VNDetectFaceRectanglesRequest()
      let humans = VNDetectHumanRectanglesRequest()
      humans.upperBodyOnly = false
      let saliency = VNGenerateObjectnessBasedSaliencyImageRequest()
      try? handler.perform([faces, humans, saliency])
      let objects = (saliency.results?.first as? VNSaliencyImageObservation)?.salientObjects
      row["faces"] = boxes(faces.results)
      row["humans"] = boxes(humans.results)
      row["objects"] = boxes(objects)
    }
    if let data = try? JSONSerialization.data(withJSONObject: row), let line = String(data: data, encoding: .utf8) { print(line) }
  }
  t += step
}
