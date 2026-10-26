import AppKit
import Quartz
import Foundation

// This is a genuine Finder Quick Look extension entry point, not an editor
// window. The extension has no network entitlement or JavaScript surface.
@objc(PreviewViewController)
final class PreviewViewController: NSViewController, QLPreviewingController, NSTextViewDelegate {
    private let maximumBytes = 8 * 1024 * 1024
    private let maximumCharacters = 65_536
    private var textView: NSTextView!

    override func loadView() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 800, height: 700))
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let text = NSTextView(frame: scroll.contentView.bounds)
        text.isEditable = false
        text.isSelectable = true
        text.isRichText = true
        text.importsGraphics = false
        text.usesFindPanel = true
        text.isAutomaticLinkDetectionEnabled = false
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.textContainerInset = NSSize(width: 26, height: 24)
        text.delegate = self
        scroll.documentView = text
        textView = text
        view = scroll
        preferredContentSize = NSSize(width: 800, height: 700)
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        _ = view
        let granted = url.startAccessingSecurityScopedResource()
        defer { if granted { url.stopAccessingSecurityScopedResource() } }
        do {
            guard url.isFileURL else { throw previewError("Only local files can be previewed.") }
            guard ["md", "markdown", "mdown", "mkd", "txt"].contains(url.pathExtension.lowercased()) else {
                throw previewError("This preview extension supports Markdown and TXT files.")
            }
            let info = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard info.isRegularFile == true, let bytes = info.fileSize, bytes <= maximumBytes else {
                throw previewError("Quick Look previews are limited to regular text files up to 8 MiB.")
            }
            let file = try FileHandle(forReadingFrom: url)
            defer { try? file.close() }
            let data = try file.read(upToCount: maximumBytes + 1) ?? Data()
            guard data.count <= maximumBytes else { throw previewError("The file grew beyond the preview limit.") }
            guard let source = decodeText(data) else { throw previewError("This text encoding is not supported by the native preview.") }
            guard !source.contains("\0") else { throw previewError("Binary content cannot be previewed as text.") }
            var excerpt = ""
            var scalarCount = 0
            for scalar in source.unicodeScalars {
                if scalarCount == maximumCharacters { break }
                excerpt.unicodeScalars.append(scalar)
                scalarCount += 1
            }
            let truncated = source.unicodeScalars.count > scalarCount
            let parsed: NSAttributedString
            if url.pathExtension.lowercased() == "txt" {
                parsed = NSAttributedString(string: excerpt)
            } else {
                // Foundation's bounded native Markdown parser; no HTML importer,
                // script evaluation, URL fetching or application IPC is used.
                parsed = try NSAttributedString(markdown: excerpt,
                    options: .init(interpretedSyntax: .full), baseURL: nil)
            }
            let result = NSMutableAttributedString(attributedString: parsed)
            let full = NSRange(location: 0, length: result.length)
            result.removeAttribute(.attachment, range: full)
            result.removeAttribute(.link, range: full)
            let values = sharedPresentation()
            let size = boundedNumber(values["fontSize"], fallback: 17, minimum: 9, maximum: 48)
            let height = boundedNumber(values["lineHeight"], fallback: 1.85, minimum: 1, maximum: 3.5)
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = size * max(0, height - 1)
            paragraph.paragraphSpacing = size * 0.75
            paragraph.firstLineHeadIndent = values["indented"] as? Bool == true ? size * 2 : 0
            paragraph.alignment = values["justify"] as? Bool == true ? .justified : .natural
            let ink = color(values["ink"] as? String) ?? .textColor
            result.addAttributes([.font: selectedFont(values["font"] as? String, size: size),
                                  .foregroundColor: ink, .paragraphStyle: paragraph], range: full)
            if truncated {
                result.append(NSAttributedString(string: "\n\n仅显示文档开头 / Opening excerpt",
                    attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
            }
            textView.backgroundColor = color(values["paper"] as? String) ?? .textBackgroundColor
            textView.textStorage?.setAttributedString(result)
            textView.setSelectedRange(NSRange(location: 0, length: 0))
            textView.scrollToBeginningOfDocument(nil)
            handler(nil)
        } catch {
            textView.string = error.localizedDescription
            handler(error)
        }
    }

    // Clicking a copied link never launches another process from the extension.
    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool { true }

    private func decodeText(_ data: Data) -> String? {
        if data.starts(with: [0xff, 0xfe]) { return String(data: data.dropFirst(2), encoding: .utf16LittleEndian) }
        if data.starts(with: [0xfe, 0xff]) { return String(data: data.dropFirst(2), encoding: .utf16BigEndian) }
        if data.starts(with: [0xef, 0xbb, 0xbf]) { return String(data: data.dropFirst(3), encoding: .utf8) }
        return String(data: data, encoding: .utf8)
    }
    private func previewError(_ message: String) -> NSError {
        NSError(domain: "com.moye.editor.QuickLook", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private func boundedNumber(_ value: Any?, fallback: CGFloat, minimum: CGFloat, maximum: CGFloat) -> CGFloat {
        guard let number = value as? NSNumber, number.doubleValue.isFinite else { return fallback }
        return min(maximum, max(minimum, CGFloat(number.doubleValue)))
    }
    private func selectedFont(_ raw: String?, size: CGFloat) -> NSFont {
        guard let raw = raw, raw.count <= 200 else { return NSFont.systemFont(ofSize: size) }
        for name in raw.split(separator: ",") {
            let family = String(name).trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
            if let font = NSFont(name: family, size: size) { return font }
        }
        return NSFont.systemFont(ofSize: size)
    }
    private func color(_ value: String?) -> NSColor? {
        guard let raw = value, raw.range(of: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", options: .regularExpression) != nil else { return nil }
        var hex = String(raw.dropFirst())
        if hex.count <= 4 { hex = hex.map { "\($0)\($0)" }.joined() }
        if hex.count == 6 { hex += "ff" }
        guard let number = UInt32(hex, radix: 16) else { return nil }
        return NSColor(srgbRed: CGFloat((number >> 24) & 255) / 255,
                       green: CGFloat((number >> 16) & 255) / 255,
                       blue: CGFloat((number >> 8) & 255) / 255,
                       alpha: CGFloat(number & 255) / 255)
    }
    private func sharedPresentation() -> [String: Any] {
        guard let suite = Bundle.main.object(forInfoDictionaryKey: "MoyeAppGroup") as? String,
              let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suite) else { return [:] }
        let url = group.appendingPathComponent("moye-preview-settings.json")
        guard let info = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              info.isRegularFile == true, info.isSymbolicLink != true, (info.fileSize ?? Int.max) <= 65_536,
              let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["version"] as? Int == 1,
              let values = object["presentation"] as? [String: Any] else { return [:] }
        return values
    }
}
