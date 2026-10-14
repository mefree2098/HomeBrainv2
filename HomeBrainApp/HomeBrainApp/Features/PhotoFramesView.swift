import SwiftUI
import PhotosUI
import WebKit
import UIKit

private struct HBFrameLine: Codable, Equatable {
    var metric: String
    var label: String
    var text: String
}
private struct HBFrameOverlay: Codable, Equatable {
    var enabled: Bool
    var lines: [HBFrameLine]
    var font: String
    var fontSize: Double
    var color: String
    var textOpacity: Double
    var panelOpacity: Double
}
private struct HBFrameSleep: Codable, Equatable {
    var enabled: Bool
    var start: String
    var end: String
}
private struct HBFrameConfig: Codable, Equatable {
    var version: Int
    var timeZone: String
    var hour12: Bool
    var orientation: String
    var intervalSeconds: Double
    var transition: String
    var transitionSeconds: Double
    var fit: String
    var shuffle: Bool
    var paused: Bool
    var brightness: Double
    var margin: Double
    var securityControlsEnabled: Bool?
    var sleep: HBFrameSleep
    var overlays: [String: HBFrameOverlay]
}
private struct HBFramePhoto: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    var url: String
    let contentType: String
    let bytes: Int
}
private struct HBPhotoFrame: Decodable, Identifiable {
    let id: String
    let name: String
    let room: String
    let config: HBFrameConfig
    let photos: [HBFramePhoto]
    let online: Bool
    let lastSeen: String?
    let software: HBFrameSoftware?
    let ota: HBFrameUpdate?
}
private struct HBFrameSoftware: Decodable { let versionName: String; let versionCode: Int; let otaCapable: Bool }
private struct HBFrameUpdate: Decodable {
    let id: String
    let versionName: String
    let versionCode: Int
    let status: String
    let progress: Double
    let message: String
}
private struct HBFrameRelease: Decodable, Identifiable {
    let releaseId: String
    let versionName: String
    let versionCode: Int
    var id: String { releaseId }
}
private struct HBFramePosition: Decodable, Identifiable {
    let id: String
    let label: String
    let maxLines: Int
}
private struct HBFrameMetric: Decodable, Identifiable {
    let id: String
    let label: String
}
private struct HBFrameCatalog: Decodable {
    let positions: [HBFramePosition]
    let metrics: [HBFrameMetric]
    let defaults: HBFrameConfig
}
private enum HBFrameJSON {
    static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    static func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }
}

struct PhotoFramesView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var frames: [HBPhotoFrame] = []
    @State private var catalog: HBFrameCatalog?
    @State private var selectedID = ""
    @State private var errorMessage: String?
    @State private var isLoading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HBSectionHeader(title: "Photo Frames", subtitle: "Your photos, with the HomeBrain information you choose.")
                if let errorMessage { InlineErrorView(message: errorMessage) { Task { await load() } } }
                HStack {
                    Button("Add Frame", systemImage: "plus") { Task { await addFrame() } }
                        .buttonStyle(HBPrimaryButtonStyle(compact: true))
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }.disabled(isLoading)
                if isLoading { ProgressView() }
                if !frames.isEmpty {
                    Picker("Photo frame", selection: $selectedID) {
                        ForEach(frames) { frame in Text(frame.name).tag(frame.id) }
                    }
                    .pickerStyle(.menu)
                } else if !isLoading {
                    Text("Add a frame, choose photos, and arrange your overlays before pairing the display.")
                        .foregroundStyle(.secondary)
                }
                if let frame = frames.first(where: { $0.id == selectedID }), let catalog {
                    PhotoFrameEditor(frame: frame, catalog: catalog) { updated in
                        frames = frames.map { $0.id == updated.id ? updated : $0 }
                    }
                    .id(frame.id)
                }
            }
            .padding()
        }
        .groupBoxStyle(HBPanelGroupBoxStyle())
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let catalogResponse = try await session.apiClient.get("/api/photo-frames/catalog")
            catalog = try HBFrameJSON.decode(HBFrameCatalog.self, catalogResponse)
            let response = JSON.object(try await session.apiClient.get("/api/photo-frames"))
            frames = try HBFrameJSON.decode([HBPhotoFrame].self, response["frames"] ?? [])
            if !frames.contains(where: { $0.id == selectedID }) { selectedID = frames.first?.id ?? "" }
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
    private func addFrame() async {
        guard var config = catalog?.defaults else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            config.timeZone = TimeZone.current.identifier
            let response = JSON.object(try await session.apiClient.post("/api/photo-frames", body: ["name": "HomeBrainScreen", "config": try HBFrameJSON.object(config)]))
            let created = try HBFrameJSON.decode(HBPhotoFrame.self, response["frame"] ?? [:])
            frames.append(created)
            selectedID = created.id
        } catch { errorMessage = error.localizedDescription }
    }
}

private struct PhotoFrameEditor: View {
    @EnvironmentObject private var session: SessionStore
    let catalog: HBFrameCatalog
    let onSaved: (HBPhotoFrame) -> Void
    @State private var frame: HBPhotoFrame
    @State private var config: HBFrameConfig
    @State private var name: String
    @State private var room: String
    @State private var selections: [PhotosPickerItem] = []
    @State private var selectedPhotoID = ""
    @State private var previewPhoto: HBFramePhoto?
    @State private var previewValues: [String: Any] = [:]
    @State private var previewSecurity: [String: Any] = [:]
    @State private var generatedAt = ISO8601DateFormatter().string(from: Date())
    @State private var pairingURL: URL?
    @State private var replacePairing = false
    @State private var photoToDelete: HBFramePhoto?
    @State private var busy = false
    @State private var message: String?
    @State private var errorMessage: String?

    init(frame: HBPhotoFrame, catalog: HBFrameCatalog, onSaved: @escaping (HBPhotoFrame) -> Void) {
        self.catalog = catalog
        self.onSaved = onSaved
        _frame = State(initialValue: frame)
        _config = State(initialValue: frame.config)
        _name = State(initialValue: frame.name)
        _room = State(initialValue: frame.room)
    }
    private var dirty: Bool { config != frame.config || name != frame.name || room != frame.room }
    private var selectedPhoto: HBFramePhoto? { frame.photos.first { $0.id == selectedPhotoID } ?? frame.photos.first }
    private var metricSignature: String {
        String(config.securityControlsEnabled == true) + "|" + catalog.positions.map { position in
            let slot = config.overlays[position.id]
            return position.id + ":" + String(slot?.enabled ?? false) + ":" + (slot?.lines.map(\.metric).joined(separator: ",") ?? "")
        }.joined(separator: "|")
    }
    private var manifestJSON: String {
        do {
            let payload: [String: Any] = [
                "frameId": frame.id, "config": try HBFrameJSON.object(config),
                "photos": try HBFrameJSON.object(previewPhoto.map { [$0] } ?? []),
                "values": previewValues, "security": previewSecurity, "generatedAt": generatedAt
            ]
            return String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8) ?? "{}"
        } catch { return "{}" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(frame.online ? "Connected" : "Offline / awaiting pairing").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(dirty ? "Save Changes" : "Saved", systemImage: "checkmark") { Task { await save() } }
                    .buttonStyle(HBPrimaryButtonStyle(compact: true)).disabled(!dirty || busy)
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red).font(.callout) }
            if let message { Text(message).foregroundStyle(.secondary).font(.callout) }
            GroupBox("Display Preview") {
                VStack(alignment: .leading, spacing: 10) {
                    if let url = session.apiClient.mediaURL("/api/photo-frames/player/?preview=1") {
                        HBFramePreview(url: url, manifestJSON: manifestJSON)
                            .aspectRatio(config.orientation == "portrait" ? 800.0 / 1280 : 1280.0 / 800, contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    Text("Actual player layout, scaled to fit. Long lines truncate. Sleep is ignored in preview.")
                        .font(.caption).foregroundStyle(.secondary)
                    if !frame.photos.isEmpty {
                        Picker("Preview photo", selection: $selectedPhotoID) {
                            Text("First photo").tag("")
                            ForEach(frame.photos) { photo in Text(photo.name).tag(photo.id) }
                        }
                    }
                    Button("Refresh Live Information") { Task { await loadPreviewValues() } }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true))
                }.padding(.top, 8)
            }
            slideshowSettings
            GroupBox("Touchscreen Security") {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Allow arm/disarm on this frame", isOn: Binding(get: { config.securityControlsEnabled == true }, set: { config.securityControlsEnabled = $0 }))
                    Text("Tap the alarm status on the display to open controls. A Security button appears if no alarm status is shown. HomeBrain’s PIN settings apply, with a number pad in the center of the screen. Preview controls send no alarm commands.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(.top, 8)
            }
            ForEach(catalog.positions) { position in
                if config.overlays[position.id] != nil {
                    FrameOverlayEditor(position: position, metrics: catalog.metrics, slot: Binding(
                        get: { config.overlays[position.id]! },
                        set: { config.overlays[position.id] = $0 }
                    ))
                }
            }
            photoLibrary
            PhotoFrameUpdatesView(frameID: frame.id)
            GroupBox("Connect This Display") {
                VStack(alignment: .leading, spacing: 12) {
                    Text("A pairing link gives this display access to its photos and selected information. Replacing it disconnects the previous player.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Create / Replace Pairing Link") { replacePairing = true }
                        .buttonStyle(HBSecondaryButtonStyle(compact: true)).disabled(busy)
                    if let pairingURL { ShareLink("Share Private Pairing Link", item: pairingURL) }
                }.padding(.top, 8)
            }
        }
        .task(id: metricSignature) { await loadPreviewValues() }
        .task(id: selectedPhoto?.id) { await loadPreviewPhoto() }
        .onChange(of: selections) { _, items in Task { await upload(items) } }
        .confirmationDialog("Replace this display’s pairing credential?", isPresented: $replacePairing, titleVisibility: .visible) {
            Button("Create New Link") { Task { await pair() } }
        } message: { Text("Any current player will need the new link.") }
        .confirmationDialog("Remove this photo from the frame?", isPresented: Binding(get: { photoToDelete != nil }, set: { if !$0 { photoToDelete = nil } }), titleVisibility: .visible) {
            Button("Remove Photo", role: .destructive) { if let photo = photoToDelete { Task { await remove(photo) } } }
        }
    }

    private var slideshowSettings: some View {
        GroupBox("Slideshow & Display") {
            VStack(alignment: .leading, spacing: 14) {
                TextField("Frame name", text: $name).textFieldStyle(.roundedBorder)
                TextField("Room", text: $room).textFieldStyle(.roundedBorder)
                TextField("IANA time zone", text: $config.timeZone).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                Picker("Text font (all regions)", selection: Binding(get: {
                    let fonts = Set(config.overlays.values.map(\.font))
                    return fonts.count == 1 ? (fonts.first ?? "sans") : "mixed"
                }, set: { font in
                    for key in Array(config.overlays.keys) { config.overlays[key]?.font = font }
                })) {
                    Text("Different fonts by region").tag("mixed").disabled(true)
                    Text("Space Grotesk").tag("sans"); Text("Orbitron").tag("display"); Text("Monospace").tag("mono")
                }
                LabeledContent("Photo interval (seconds)") {
                    TextField("Seconds", value: $config.intervalSeconds, format: .number).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                }
                Picker("Transition", selection: $config.transition) {
                    Text("Crossfade").tag("fade"); Text("Slide").tag("slide"); Text("Instant").tag("cut")
                }
                frameSlider("Transition duration", value: $config.transitionSeconds, range: 0.2...4, step: 0.1, suffix: "s")
                Picker("Photo fit", selection: $config.fit) { Text("Whole photo").tag("contain"); Text("Fill screen").tag("cover") }
                Picker("Orientation", selection: $config.orientation) { Text("Landscape").tag("landscape"); Text("Portrait").tag("portrait") }
                frameSlider("Image brightness", value: $config.brightness, range: 10...100, suffix: "%")
                frameSlider("Distance from edges", value: $config.margin, range: 8...80, suffix: "px")
                Toggle("Shuffle photos", isOn: $config.shuffle)
                Toggle("Pause slideshow", isOn: $config.paused)
                Toggle("12-hour clock", isOn: $config.hour12)
                Toggle("Sleep schedule (black screen)", isOn: $config.sleep.enabled)
                if config.sleep.enabled {
                    HStack { Text("Sleep"); TextField("22:00", text: $config.sleep.start).multilineTextAlignment(.trailing).keyboardType(.numbersAndPunctuation) }
                    HStack { Text("Wake"); TextField("07:00", text: $config.sleep.end).multilineTextAlignment(.trailing).keyboardType(.numbersAndPunctuation) }
                    Text("Use HH:mm in the frame’s time zone.").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.top, 8)
        }
    }
    private var photoLibrary: some View {
        GroupBox("Photo Library · \(frame.photos.count) / 500") {
            VStack(alignment: .leading, spacing: 12) {
                PhotosPicker(selection: $selections, maxSelectionCount: 30, matching: .images) {
                    Label(busy ? "Uploading…" : "Add Photos", systemImage: "photo.badge.plus")
                }.disabled(busy)
                Text("Photos are resized to 2560 pixels and converted to JPEG before upload. Library limit: 1 GB.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(Array(frame.photos.enumerated()), id: \.element.id) { index, photo in
                    HStack {
                        Button { selectedPhotoID = photo.id } label: { Text(photo.name).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading) }
                        Button { Task { await move(index, offset: -1) } } label: { Image(systemName: "arrow.up") }
                            .disabled(index == 0 || busy).accessibilityLabel("Move photo earlier")
                        Button { Task { await move(index, offset: 1) } } label: { Image(systemName: "arrow.down") }
                            .disabled(index == frame.photos.count - 1 || busy).accessibilityLabel("Move photo later")
                        Button(role: .destructive) { photoToDelete = photo } label: { Image(systemName: "trash") }
                            .disabled(busy).accessibilityLabel("Remove photo")
                    }.padding(.vertical, 5)
                }
            }.padding(.top, 8)
        }
    }
    private func adopt(_ response: Any) throws {
        let result = JSON.object(response)
        frame = try HBFrameJSON.decode(HBPhotoFrame.self, result["frame"] ?? [:])
        onSaved(frame)
    }
    private func save() async {
        busy = true
        defer { busy = false }
        do {
            try adopt(await session.apiClient.put("/api/photo-frames/\(frame.id)", body: ["name": name, "room": room, "config": try HBFrameJSON.object(config)]))
            config = frame.config
            errorMessage = nil
            message = "Saved. Connected frames update within 15 seconds."
        } catch { errorMessage = error.localizedDescription }
    }
    private func loadPreviewValues() async {
        do {
            let result = JSON.object(try await session.apiClient.post("/api/photo-frames/preview", body: ["config": try HBFrameJSON.object(config)]))
            try Task.checkCancellation()
            previewValues = JSON.object(result["values"])
            previewSecurity = JSON.object(result["security"])
            generatedAt = JSON.string(result, "generatedAt")
        } catch is CancellationError { } catch { errorMessage = error.localizedDescription }
    }
    private func loadPreviewPhoto() async {
        previewPhoto = nil
        guard var photo = selectedPhoto else { return }
        do {
            let result = try await session.apiClient.download(photo.url)
            try Task.checkCancellation()
            photo.url = "data:\(photo.contentType);base64," + result.data.base64EncodedString()
            previewPhoto = photo
        } catch is CancellationError { } catch { errorMessage = error.localizedDescription }
    }
    private func upload(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        busy = true
        defer { busy = false; selections = [] }
        do {
            for (index, item) in items.enumerated() {
                guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { throw APIError.server(statusCode: 400, message: "This image could not be opened.") }
                let ratio = min(1, 2560 / max(image.size.width, image.size.height))
                let size = CGSize(width: max(1, floor(image.size.width * ratio)), height: max(1, floor(image.size.height * ratio)))
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let resized = UIGraphicsImageRenderer(size: size, format: format).image { context in
                    UIColor.black.setFill(); context.fill(CGRect(origin: .zero, size: size))
                    image.draw(in: CGRect(origin: .zero, size: size))
                }
                guard let jpeg = resized.jpegData(compressionQuality: 0.9) else { throw APIError.parsingFailed }
                try adopt(await session.apiClient.post("/api/photo-frames/\(frame.id)/photos", body: ["name": "Photo \(frame.photos.count + 1).jpg", "data": jpeg.base64EncodedString()]))
                message = "Uploaded \(index + 1) of \(items.count) photos."
            }
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
    private func remove(_ photo: HBFramePhoto) async {
        busy = true
        defer { busy = false; photoToDelete = nil }
        do { try adopt(await session.apiClient.delete("/api/photo-frames/\(frame.id)/photos/\(photo.id)")); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }
    private func move(_ index: Int, offset: Int) async {
        busy = true
        defer { busy = false }
        do {
            var ids = frame.photos.map(\.id)
            ids.swapAt(index, index + offset)
            try adopt(await session.apiClient.put("/api/photo-frames/\(frame.id)/photo-order", body: ["ids": ids]))
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
    private func pair() async {
        busy = true
        defer { busy = false }
        do {
            let response = JSON.object(try await session.apiClient.post("/api/photo-frames/\(frame.id)/pair"))
            guard let base = session.apiClient.mediaURL("/api/photo-frames/player/"),
                  var components = URLComponents(url: base, resolvingAgainstBaseURL: false),
                  let fragment = URLComponents(string: JSON.string(response, "playerPath"))?.fragment else {
                throw APIError.invalidURL
            }
            // APIClient builds paths and queries; the private credential must
            // remain a URL fragment rather than becoming an encoded path.
            components.fragment = fragment
            pairingURL = components.url
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
}

private struct PhotoFrameUpdatesView: View {
    @EnvironmentObject private var session: SessionStore
    let frameID: String
    @State private var software: HBFrameSoftware?
    @State private var update: HBFrameUpdate?
    @State private var releases: [HBFrameRelease] = []
    @State private var selected = ""
    @State private var busy = false
    @State private var errorMessage: String?
    private var active: Bool { ["queued", "downloading", "verifying", "installing", "restarting"].contains(update?.status ?? "") }

    var body: some View {
        GroupBox("Software Updates") {
            VStack(alignment: .leading, spacing: 12) {
                Text(software.map { "Installed: \($0.versionName) (build \($0.versionCode))" } ?? "Awaiting device software report")
                Text(software?.otaCapable == true ? "OTA ready" : "OTA installer not ready").font(.caption).foregroundStyle(.secondary)
                Text("HomeBrain sends signed updates to the display runtime. The frame verifies both signing keys before installation. Android boot/system images require a separate recovery procedure.").font(.caption).foregroundStyle(.secondary)
                if let errorMessage { Text(errorMessage).foregroundStyle(.red).font(.caption) }
                if let update {
                    Text("\(update.versionName) · \(update.status)").font(.callout)
                    Text(update.message).font(.caption).foregroundStyle(.secondary)
                    if active { ProgressView(value: update.progress, total: 100) }
                    if update.status == "queued" {
                        Button("Cancel Queued Update") { Task { await cancel() } }.disabled(busy)
                    }
                }
                Picker("Release", selection: $selected) {
                    Text("Choose a release").tag("")
                    ForEach(releases.filter { $0.versionCode > (software?.versionCode ?? 0) }) { release in
                        Text("\(release.versionName) · build \(release.versionCode)").tag(release.id)
                    }
                }
                Button("Send Update to Frame", systemImage: "arrow.down.circle") { Task { await send() } }
                    .buttonStyle(HBPrimaryButtonStyle(compact: true))
                    .disabled(busy || active || software?.otaCapable != true || !releases.contains { $0.id == selected && $0.versionCode > (software?.versionCode ?? 0) })
                Text("Upload a signed release APK in the HomeBrain web app, then choose it here.").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
        }
        .task(id: frameID) {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }
    private func refresh() async {
        do {
            let response = JSON.object(try await session.apiClient.get("/api/photo-frames"))
            if let frame = try HBFrameJSON.decode([HBPhotoFrame].self, response["frames"] ?? []).first(where: { $0.id == frameID }) {
                software = frame.software; update = frame.ota
            }
            let releaseResponse = JSON.object(try await session.apiClient.get("/api/photo-frames/releases"))
            releases = try HBFrameJSON.decode([HBFrameRelease].self, releaseResponse["releases"] ?? [])
            errorMessage = nil
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
    private func send() async {
        busy = true
        defer { busy = false }
        do {
            let response = JSON.object(try await session.apiClient.post("/api/photo-frames/\(frameID)/updates", body: ["releaseId": selected]))
            update = try HBFrameJSON.decode(HBFrameUpdate.self, response["job"] ?? [:]); errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
    private func cancel() async {
        busy = true
        defer { busy = false }
        do { _ = try await session.apiClient.delete("/api/photo-frames/\(frameID)/updates"); await refresh() }
        catch { errorMessage = error.localizedDescription }
    }
}

private func frameSlider(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double = 1, suffix: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
        Text("\(title) · \(value.wrappedValue.formatted(.number.precision(.fractionLength(0...1))))\(suffix)").font(.caption)
        Slider(value: value, in: range, step: step)
    }
}

private struct FrameOverlayEditor: View {
    let position: HBFramePosition
    let metrics: [HBFrameMetric]
    @Binding var slot: HBFrameOverlay

    var body: some View {
        GroupBox(position.label) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Show overlay", isOn: $slot.enabled)
                Text("\(position.maxLines) line\(position.maxLines > 1 ? "s" : "") maximum").font(.caption).foregroundStyle(.secondary)
                ForEach(0..<position.maxLines, id: \.self) { index in
                    Picker("Line \(index + 1)", selection: Binding(get: { index < slot.lines.count ? slot.lines[index].metric : "" }, set: { metric in
                        if metric.isEmpty {
                            if index < slot.lines.count { slot.lines.remove(at: index) }
                        } else if index < slot.lines.count { slot.lines[index] = HBFrameLine(metric: metric, label: "", text: "") }
                        else { slot.lines.append(HBFrameLine(metric: metric, label: "", text: "")) }
                    })) {
                        Text("Empty").tag("")
                        ForEach(metrics) { metric in Text(metric.label).tag(metric.id) }
                    }
                    if index < slot.lines.count {
                        if slot.lines[index].metric == "text" {
                            TextField("Your message", text: $slot.lines[index].text).textFieldStyle(.roundedBorder)
                        }
                        TextField("Optional label prefix", text: $slot.lines[index].label).textFieldStyle(.roundedBorder)
                    }
                }
                Picker("Font", selection: $slot.font) {
                    Text("Space Grotesk").tag("sans"); Text("Orbitron").tag("display"); Text("Monospace").tag("mono")
                }
                TextField("Text color (#rrggbb)", text: $slot.color).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                frameSlider("Font size", value: $slot.fontSize, range: 14...64, suffix: "px")
                frameSlider("Text opacity", value: $slot.textOpacity, range: 0.2...1, step: 0.05, suffix: "")
                frameSlider("Text background opacity", value: $slot.panelOpacity, range: 0...0.85, step: 0.05, suffix: "")
                Text("Backgrounds fit the text and scale with its font size. Set opacity to 0 to hide them.").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
        }
    }
}

private struct HBFramePreview: UIViewRepresentable {
    let url: URL
    let manifestJSON: String

    final class Coordinator: NSObject, WKNavigationDelegate {
        var manifestJSON = "{}"
        var ready = false
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; update(webView) }
        func update(_ webView: WKWebView) {
            guard ready else { return }
            webView.evaluateJavaScript("window.HomeBrainFramePreview && window.HomeBrainFramePreview(\(manifestJSON));", completionHandler: nil)
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        view.isOpaque = false
        view.backgroundColor = .black
        context.coordinator.manifestJSON = manifestJSON
        view.load(URLRequest(url: url))
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {
        guard context.coordinator.manifestJSON != manifestJSON else { return }
        context.coordinator.manifestJSON = manifestJSON
        context.coordinator.update(uiView)
    }
}
