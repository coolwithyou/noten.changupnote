import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
  fputs("usage: macos-vision-ocr.swift <image-path>\n", stderr)
  exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard NSImage(contentsOf: imageURL) != nil else {
  fputs("image_open_failed\n", stderr)
  exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ko-KR", "en-US"]

do {
  let handler = VNImageRequestHandler(url: imageURL, options: [:])
  try handler.perform([request])
  let observations = (request.results ?? []).sorted { left, right in
    let yDifference = left.boundingBox.midY - right.boundingBox.midY
    return abs(yDifference) > 0.01 ? yDifference > 0 : left.boundingBox.minX < right.boundingBox.minX
  }
  let lines = observations.compactMap { observation -> [String: Any]? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    return ["text": text, "confidence": Double(candidate.confidence)]
  }
  let confidence = lines.isEmpty ? 0.0 : lines.reduce(0.0) { sum, line in
    sum + (line["confidence"] as? Double ?? 0.0)
  } / Double(lines.count)
  let payload: [String: Any] = [
    "text": lines.compactMap { $0["text"] as? String }.joined(separator: "\n"),
    "averageConfidence": confidence,
    "lineCount": lines.count,
    "lines": lines,
  ]
  let data = try JSONSerialization.data(withJSONObject: payload, options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fputs("vision_ocr_failed: \(error)\n", stderr)
  exit(4)
}
