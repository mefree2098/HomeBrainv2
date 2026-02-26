import SwiftUI

struct SSLView: View {
    @EnvironmentObject private var session: SessionStore

    @State private var status: [String: Any] = [:]
    @State private var certificates: [SSLCertificateItem] = []

    @State private var generatedCSR = ""

    @State private var csrDomain = ""
    @State private var csrEmail = ""

    @State private var uploadDomain = ""
    @State private var uploadCertificate = ""
    @State private var uploadPrivateKey = ""
    @State private var uploadChain = ""

    @State private var letsEncryptDomain = ""
    @State private var letsEncryptEmail = ""
    @State private var letsEncryptStaging = false

    @State private var isLoading = true
    @State private var isActing = false
    @State private var errorMessage: String?
    @State private var infoMessage = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if isLoading {
                    LoadingView(title: "Loading SSL status...")
                } else {
                    if let errorMessage {
                        InlineErrorView(message: errorMessage) {
                            Task { await loadSSLData() }
                        }
                    }

                    if !infoMessage.isEmpty {
                        Text(infoMessage)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .background(Color.blue.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    statusCard
                    certificatesCard
                    csrCard
                    uploadCard
                    letsEncryptCard
                }
            }
            .padding()
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh") {
                    Task { await loadSSLData() }
                }
            }
        }
        .task {
            await loadSSLData()
        }
        .refreshable {
            await loadSSLData()
        }
    }

    private var statusCard: some View {
        GroupBox("SSL Status") {
            VStack(alignment: .leading, spacing: 6) {
                Text("SSL Enabled: \(JSON.bool(status, "sslEnabled") ? "Yes" : "No")")
                Text("Certificates: \(JSON.int(status, "certificates", fallback: certificates.count))")
                Text("Expiring Soon: \(JSON.int(status, "expiringSoon"))")
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }

    private var certificatesCard: some View {
        GroupBox("Certificates") {
            if certificates.isEmpty {
                EmptyStateView(title: "No certificates", subtitle: "Upload or generate a certificate below.")
            } else {
                VStack(spacing: 10) {
                    ForEach(certificates) { certificate in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(certificate.domain)
                                .font(.headline)
                            Text("\(certificate.provider) · \(certificate.status) · expires \(certificate.expiryDate)")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            HStack {
                                actionButton("Activate") {
                                    await performAction(path: "/api/ssl/certificates/\(certificate.id)/activate")
                                }
                                actionButton("Deactivate") {
                                    await performAction(path: "/api/ssl/certificates/\(certificate.id)/deactivate")
                                }
                                actionButton("Renew") {
                                    await performAction(path: "/api/ssl/letsencrypt/renew/\(certificate.id)")
                                }
                                Button("Delete", role: .destructive) {
                                    Task {
                                        await deleteCertificate(certificate)
                                    }
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(Color.secondary.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private var csrCard: some View {
        GroupBox("Generate CSR") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Domain (commonName)", text: $csrDomain)
                    .textFieldStyle(.roundedBorder)
                TextField("Email (optional)", text: $csrEmail)
                    .textFieldStyle(.roundedBorder)

                actionButton("Generate CSR") {
                    var payload: [String: Any] = ["commonName": csrDomain]
                    if !csrEmail.isEmpty {
                        payload["emailAddress"] = csrEmail
                    }
                    await generateCSR(payload)
                }

                if !generatedCSR.isEmpty {
                    TextEditor(text: .constant(generatedCSR))
                        .frame(minHeight: 120)
                        .font(.caption.monospaced())
                }
            }
            .padding(.top, 4)
        }
    }

    private var uploadCard: some View {
        GroupBox("Upload Certificate") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Domain", text: $uploadDomain)
                    .textFieldStyle(.roundedBorder)

                TextEditor(text: $uploadCertificate)
                    .frame(minHeight: 100)
                    .overlay(alignment: .topLeading) {
                        if uploadCertificate.isEmpty {
                            Text("Certificate PEM")
                                .foregroundStyle(.secondary)
                                .padding(8)
                        }
                    }

                TextEditor(text: $uploadPrivateKey)
                    .frame(minHeight: 100)
                    .overlay(alignment: .topLeading) {
                        if uploadPrivateKey.isEmpty {
                            Text("Private Key PEM")
                                .foregroundStyle(.secondary)
                                .padding(8)
                        }
                    }

                TextEditor(text: $uploadChain)
                    .frame(minHeight: 80)
                    .overlay(alignment: .topLeading) {
                        if uploadChain.isEmpty {
                            Text("Certificate Chain PEM (optional)")
                                .foregroundStyle(.secondary)
                                .padding(8)
                        }
                    }

                actionButton("Upload") {
                    let payload: [String: Any] = [
                        "domain": uploadDomain,
                        "certificate": uploadCertificate,
                        "privateKey": uploadPrivateKey,
                        "certificateChain": uploadChain
                    ]
                    await performAction(path: "/api/ssl/upload", body: payload)
                }
                .disabled(uploadDomain.isEmpty || uploadCertificate.isEmpty || uploadPrivateKey.isEmpty)
            }
            .padding(.top, 4)
        }
    }

    private var letsEncryptCard: some View {
        GroupBox("Let's Encrypt") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Domain", text: $letsEncryptDomain)
                    .textFieldStyle(.roundedBorder)
                TextField("Email", text: $letsEncryptEmail)
                    .textFieldStyle(.roundedBorder)
                Toggle("Use staging", isOn: $letsEncryptStaging)

                actionButton("Request Certificate") {
                    let payload: [String: Any] = [
                        "domain": letsEncryptDomain,
                        "email": letsEncryptEmail,
                        "staging": letsEncryptStaging
                    ]
                    await performAction(path: "/api/ssl/letsencrypt/setup", body: payload)
                }
                .disabled(letsEncryptDomain.isEmpty || letsEncryptEmail.isEmpty)
            }
            .padding(.top, 4)
        }
    }

    private func actionButton(_ title: String, action: @escaping () async -> Void) -> some View {
        Button(title) {
            Task {
                await action()
            }
        }
        .buttonStyle(.bordered)
        .disabled(isActing)
    }

    private func loadSSLData() async {
        isLoading = true
        errorMessage = nil

        do {
            async let statusTask = session.apiClient.get("/api/ssl/status")
            async let certificatesTask = session.apiClient.get("/api/ssl/certificates")

            let statusResponse = try await statusTask
            let certificatesResponse = try await certificatesTask

            status = JSON.object(statusResponse)
            let certsObject = JSON.object(certificatesResponse)
            certificates = JSON.array(certsObject["certificates"]).map(SSLCertificateItem.from)
                .sorted { $0.domain.localizedCaseInsensitiveCompare($1.domain) == .orderedAscending }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private func performAction(path: String, body: [String: Any] = [:]) async {
        do {
            isActing = true
            defer { isActing = false }

            let response = try await session.apiClient.post(path, body: body)
            let object = JSON.object(response)
            infoMessage = JSON.string(object, "message", fallback: "Action completed.")
            await loadSSLData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func generateCSR(_ payload: [String: Any]) async {
        do {
            isActing = true
            defer { isActing = false }

            let response = try await session.apiClient.post("/api/ssl/generate-csr", body: payload)
            let object = JSON.object(response)
            generatedCSR = JSON.string(object, "csr")
            infoMessage = JSON.string(object, "message", fallback: "CSR generated.")
            await loadSSLData()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteCertificate(_ certificate: SSLCertificateItem) async {
        do {
            isActing = true
            defer { isActing = false }
            _ = try await session.apiClient.delete("/api/ssl/certificates/\(certificate.id)")
            infoMessage = "Certificate deleted."
            certificates.removeAll { $0.id == certificate.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
