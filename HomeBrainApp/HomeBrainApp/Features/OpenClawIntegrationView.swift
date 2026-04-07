import SwiftUI
import UIKit

struct OpenClawIntegrationView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isLoading = true
    @State private var isSaving = false
    @State private var isRotating = false
    @State private var isRevoking = false
    @State private var isDownloadingBundle = false
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    @State private var displayName = "HomeBrain OpenClaw Admin"
    @State private var publishedBaseUrl = ""
    @State private var notes = ""
    @State private var enabled = true

    @State private var tokenConfigured = false
    @State private var tokenPrefix = ""
    @State private var lastUsedAt = ""
    @State private var lastUsedIp = ""
    @State private var endpointUrl = ""
    @State private var cliCommand = ""
    @State private var serverDefinitionText = ""
    @State private var skillMarkdown = ""
    @State private var jetsonGuide = ""
    @State private var freshToken = ""
    @State private var bundleShareItem: SharedFile?

    var body: some View {
        VStack(spacing: 12) {
            if isLoading {
                LoadingView(title: "Loading OpenClaw integration...")
            } else {
                HBSectionHeader(
                    title: "OpenClaw",
                    subtitle: "Connect an external OpenClaw instance to HomeBrain with a managed admin token, MCP endpoint, and shipped skill pack."
                )

                HStack(spacing: 10) {
                    Button("Refresh") {
                        Task { await loadStatus(preserveFreshToken: true) }
                    }
                    .buttonStyle(.bordered)

                    Button(isDownloadingBundle ? "Downloading..." : "Download Bundle") {
                        Task { await downloadBundle() }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(HBPalette.accentBlue)
                    .disabled(isDownloadingBundle || freshToken.isEmpty)
                }

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            HBPanel {
                                InlineErrorView(message: errorMessage) {
                                    Task { await loadStatus(preserveFreshToken: true) }
                                }
                            }
                        }

                        if !infoMessage.isEmpty {
                            HBPanel {
                                Text(infoMessage)
                                    .font(.subheadline)
                                    .foregroundStyle(HBPalette.textSecondary)
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Status")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                statusRow(label: "Integration", value: enabled ? "Enabled" : "Disabled")
                                statusRow(label: "Token", value: tokenConfigured ? "Configured" : "Missing")
                                statusRow(label: "Prefix", value: tokenPrefix.isEmpty ? "not configured" : tokenPrefix)
                                statusRow(label: "Last used", value: lastUsedAt.isEmpty ? "Never" : lastUsedAt)

                                if !lastUsedIp.isEmpty {
                                    statusRow(label: "Last IP", value: lastUsedIp)
                                }
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Identity")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                TextField("Display Name", text: $displayName)
                                    .hbPanelTextField()

                                TextField("Published HomeBrain URL", text: $publishedBaseUrl)
                                    .textInputAutocapitalization(.never)
                                    .disableAutocorrection(true)
                                    .hbPanelTextField()

                                TextField("Notes", text: $notes, axis: .vertical)
                                    .lineLimit(3, reservesSpace: true)
                                    .hbPanelTextField()

                                Toggle("Integration Enabled", isOn: $enabled)
                                    .tint(HBPalette.accentBlue)

                                HStack(spacing: 10) {
                                    Button(isSaving ? "Saving..." : "Save Settings") {
                                        Task { await saveSettings() }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .tint(HBPalette.accentBlue)
                                    .disabled(isSaving)

                                    Button("Refresh") {
                                        Task { await loadStatus(preserveFreshToken: true) }
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Token")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                HStack(spacing: 10) {
                                    Button(isRotating ? "Rotating..." : "Rotate Token") {
                                        Task { await rotateToken() }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .tint(HBPalette.accentBlue)
                                    .disabled(isRotating)

                                    Button(isRevoking ? "Revoking..." : "Revoke Token") {
                                        Task { await revokeToken() }
                                    }
                                    .buttonStyle(.bordered)
                                    .disabled(isRevoking)

                                    Button(isDownloadingBundle ? "Preparing..." : "Download Bundle") {
                                        Task { await downloadBundle() }
                                    }
                                    .buttonStyle(.bordered)
                                    .disabled(isDownloadingBundle || freshToken.isEmpty)
                                }

                                Text("Fresh Token")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HBPalette.textSecondary)

                                MonospaceBlock(text: freshToken.isEmpty ? "Rotate the token to reveal a new value once." : freshToken)

                                Text("Rotate a token immediately before deployment. The fresh token powers the inline JSON, CLI command, and downloaded Jetson bundle.")
                                    .font(.footnote)
                                    .foregroundStyle(HBPalette.textMuted)

                                Button("Copy Fresh Token") {
                                    copyToClipboard(freshToken, label: "Fresh token")
                                }
                                .buttonStyle(.bordered)
                                .disabled(freshToken.isEmpty)
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Endpoint")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                MonospaceBlock(text: endpointUrl)

                                HStack(spacing: 10) {
                                    Button("Copy Endpoint") {
                                        copyToClipboard(endpointUrl, label: "Endpoint URL")
                                    }
                                    .buttonStyle(.bordered)

                                    Button("Copy CLI Command") {
                                        copyToClipboard(cliCommand, label: "CLI command")
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("MCP Server Definition")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                MonospaceBlock(text: serverDefinitionText)

                                Button("Copy JSON") {
                                    copyToClipboard(serverDefinitionText, label: "MCP server definition")
                                }
                                .buttonStyle(.bordered)
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Jetson Guide")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                MonospaceBlock(text: jetsonGuide)

                                Button("Copy Jetson Guide") {
                                    copyToClipboard(jetsonGuide, label: "Jetson guide")
                                }
                                .buttonStyle(.bordered)
                            }
                        }

                        HBPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Shipped Skill")
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                                    .textCase(.uppercase)
                                    .tracking(2.4)
                                    .foregroundStyle(HBPalette.textMuted)

                                MonospaceBlock(text: skillMarkdown)

                                Button("Copy Skill Markdown") {
                                    copyToClipboard(skillMarkdown, label: "Skill markdown")
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                    .padding(.bottom, 16)
                }
            }
        }
        .padding()
        .task {
            await loadStatus(preserveFreshToken: true)
        }
        .sheet(item: $bundleShareItem, onDismiss: cleanupSharedFile) { item in
            ActivityView(activityItems: [item.url])
        }
    }

    private func statusRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HBPalette.textSecondary)
            Spacer()
            Text(value)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .foregroundStyle(HBPalette.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func applyStatus(from object: [String: Any], preserveFreshToken: Bool) {
        let integration = JSON.object(object["integration"])
        let mcp = JSON.object(object["mcp"])
        let skill = JSON.object(object["skill"])

        displayName = JSON.string(integration, "displayName", fallback: displayName)
        publishedBaseUrl = JSON.string(integration, "publishedBaseUrl", fallback: publishedBaseUrl)
        notes = JSON.string(integration, "notes", fallback: notes)
        enabled = JSON.bool(integration, "enabled", fallback: enabled)

        tokenConfigured = JSON.bool(integration, "tokenConfigured", fallback: false)
        tokenPrefix = JSON.string(integration, "tokenPrefix", fallback: "")
        lastUsedAt = JSON.displayDate(from: integration["lastUsedAt"])
        lastUsedIp = JSON.string(integration, "lastUsedIp", fallback: "")

        endpointUrl = JSON.string(mcp, "endpointUrl", fallback: endpointUrl)
        cliCommand = JSON.string(mcp, "cliCommand", fallback: cliCommand)
        if let serverDefinition = mcp["serverDefinition"] {
            if let data = try? JSONSerialization.data(withJSONObject: serverDefinition, options: [.prettyPrinted]),
               let text = String(data: data, encoding: .utf8) {
                serverDefinitionText = text
            }
        }

        skillMarkdown = JSON.string(skill, "markdown", fallback: skillMarkdown)
        jetsonGuide = JSON.string(object, "jetsonGuide", fallback: jetsonGuide)

        if !preserveFreshToken {
            freshToken = ""
        }
    }

    private func loadStatus(preserveFreshToken: Bool) async {
        isLoading = true
        errorMessage = nil

        do {
            let response = try await session.apiClient.get("/api/openclaw")
            let object = JSON.object(response)
            applyStatus(from: object, preserveFreshToken: preserveFreshToken)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func saveSettings() async {
        isSaving = true
        errorMessage = nil

        do {
            let payload: [String: Any] = [
                "enabled": enabled,
                "displayName": displayName,
                "publishedBaseUrl": publishedBaseUrl,
                "notes": notes
            ]
            let response = try await session.apiClient.put("/api/openclaw", body: payload)
            let object = JSON.object(response)
            applyStatus(from: object, preserveFreshToken: true)
            infoMessage = JSON.string(object, "message", fallback: "OpenClaw settings saved.")
        } catch {
            errorMessage = error.localizedDescription
        }

        isSaving = false
    }

    private func rotateToken() async {
        isRotating = true
        errorMessage = nil

        do {
            let response = try await session.apiClient.post("/api/openclaw/token/rotate")
            let object = JSON.object(response)
            applyStatus(from: object, preserveFreshToken: true)
            freshToken = JSON.string(object, "token", fallback: "")
            infoMessage = JSON.string(object, "message", fallback: "OpenClaw token rotated.")
        } catch {
            errorMessage = error.localizedDescription
        }

        isRotating = false
    }

    private func revokeToken() async {
        isRevoking = true
        errorMessage = nil

        do {
            let response = try await session.apiClient.delete("/api/openclaw/token")
            let object = JSON.object(response)
            freshToken = ""
            infoMessage = JSON.string(object, "message", fallback: "OpenClaw token revoked.")
            await loadStatus(preserveFreshToken: false)
        } catch {
            errorMessage = error.localizedDescription
        }

        isRevoking = false
    }

    private func downloadBundle() async {
        isDownloadingBundle = true
        errorMessage = nil

        do {
            guard !freshToken.isEmpty else {
                throw APIError.server(statusCode: 400, message: "Rotate the OpenClaw token before downloading a ready bundle.")
            }
            cleanupSharedFile()
            let result = try await session.apiClient.download(
                "/api/openclaw/bundle",
                method: .post,
                body: ["token": freshToken]
            )
            let fileName = result.suggestedFilename ?? "homebrain-openclaw-bundle.zip"
            let fileURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString)-\(fileName)")
            try result.data.write(to: fileURL, options: [.atomic])
            bundleShareItem = SharedFile(url: fileURL)
            infoMessage = "OpenClaw bundle downloaded."
        } catch {
            errorMessage = error.localizedDescription
        }

        isDownloadingBundle = false
    }

    private func cleanupSharedFile() {
        guard let fileURL = bundleShareItem?.url else { return }
        try? FileManager.default.removeItem(at: fileURL)
        bundleShareItem = nil
    }

    private func copyToClipboard(_ value: String, label: String) {
        guard !value.isEmpty else { return }
        UIPasteboard.general.string = value
        infoMessage = "\(label) copied."
    }
}

private struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

private struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {
    }
}

private struct MonospaceBlock: View {
    let text: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(text.isEmpty ? "Not available." : text)
                .font(.system(size: 12, weight: .regular, design: .monospaced))
                .foregroundStyle(HBPalette.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(HBPalette.fieldFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HBPalette.fieldStroke, lineWidth: 1)
        )
    }
}
