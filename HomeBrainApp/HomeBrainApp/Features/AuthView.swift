import SwiftUI

struct AuthView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case login = "Login"
        case register = "Register"

        var id: String { rawValue }
    }

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var uiPreview: UIPreviewStore

    @State private var mode: Mode = .login
    @State private var serverURL = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""

    private let previewSections: [AppShellView.AppSection] = [
        .dashboard,
        .devices,
        .scenes,
        .workflows,
        .voiceDevices,
        .settings,
        .ollama
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                HBPageBackground()
                    .ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 18) {
                        HStack {
                            Spacer(minLength: 0)
                            HBThemeToggleMenu()
                        }

                        HBDeckSurface(cornerRadius: 32) {
                            VStack(alignment: .leading, spacing: 22) {
                                heroPanel
                                authPanel
                                previewPanel
                            }
                            .padding(20)
                        }
                        .frame(maxWidth: 720)
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .onAppear {
                if serverURL.isEmpty {
                    serverURL = session.serverURLString
                }
            }
        }
    }

    private var heroPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 14) {
                    Image("HomeBrainBrandIcon")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 42, height: 42)
                        .padding(10)
                        .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Identity Layer")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .textCase(.uppercase)
                            .tracking(2.8)
                            .foregroundStyle(HBPalette.textMuted)

                        Text("HomeBrain iOS Command Deck")
                            .font(.system(size: 32, weight: .bold, design: .rounded))
                            .foregroundStyle(
                                LinearGradient(
                                    colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                            )

                        Text("Authenticate to the residence control mesh, sync with your hub, and bring the native app into the same cinematic command layer as the web deck.")
                            .font(.system(size: 16, weight: .medium, design: .rounded))
                            .foregroundStyle(HBPalette.textSecondary)
                    }
                }

                HStack(spacing: 10) {
                    HBBadge(text: "Glass UI online")
                    HBBadge(text: "Adaptive themes ready")
                }
            }
        }
    }

    private var authPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 18) {
                Text("Secure Access")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.8)
                    .foregroundStyle(HBPalette.textMuted)

                Picker("Mode", selection: $mode) {
                    ForEach(Mode.allCases) { value in
                        Text(value.rawValue).tag(value)
                    }
                }
                .pickerStyle(.segmented)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Hub Endpoint")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)

                    HStack(spacing: 10) {
                        TextField("https://homebrain.local", text: $serverURL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .hbPanelTextField()

                        Button("Save") {
                            session.updateServerURL(serverURL)
                        }
                        .buttonStyle(HBSecondaryButtonStyle())
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Credentials")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HBPalette.textSecondary)

                    TextField("Email", text: $email)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                        .keyboardType(.emailAddress)
                        .hbPanelTextField()

                    SecureField("Password", text: $password)
                        .hbPanelTextField()

                    if mode == .register {
                        SecureField("Confirm password", text: $confirmPassword)
                            .hbPanelTextField()
                    }
                }

                if let authError = session.authError, !authError.isEmpty {
                    InlineErrorView(message: authError, retry: nil)
                }

                HStack(spacing: 12) {
                    Button {
                        submit()
                    } label: {
                        if session.isProcessingAuth {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text(mode == .login ? "Signing In..." : "Creating Account...")
                            }
                            .frame(maxWidth: .infinity)
                        } else {
                            Label(mode == .login ? "Sign In" : "Create Account", systemImage: mode == .login ? "arrow.right.circle" : "person.crop.circle.badge.plus")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(HBPrimaryButtonStyle())
                    .disabled(session.isProcessingAuth || email.isEmpty || password.isEmpty || serverURL.isEmpty)

                    Button("Use Saved Hub") {
                        serverURL = session.serverURLString
                    }
                    .buttonStyle(HBSecondaryButtonStyle())
                }

                Text(mode == .login ? "Enter your HomeBrain credentials to rejoin the command deck." : "Create an operator account to personalize favorites, voice routines, and access control.")
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)
            }
        }
    }

    private var previewPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("UI Preview")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(2.8)
                    .foregroundStyle(HBPalette.textMuted)

                Text("Jump directly into the app shell without authentication to inspect layouts, theme behavior, and spacing on each module.")
                    .font(.system(size: 15, weight: .medium, design: .rounded))
                    .foregroundStyle(HBPalette.textSecondary)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 10)], spacing: 10) {
                    ForEach(previewSections) { section in
                        Button {
                            uiPreview.enter(section: section)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: section.icon)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(HBPalette.accentBlue)
                                    .frame(width: 32, height: 32)
                                    .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(section.title)
                                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                                        .foregroundStyle(HBPalette.textPrimary)
                                        .lineLimit(1)
                                    Text(section.chromeKicker)
                                        .font(.system(size: 10, weight: .bold, design: .rounded))
                                        .textCase(.uppercase)
                                        .tracking(1.6)
                                        .foregroundStyle(HBPalette.textMuted)
                                        .lineLimit(1)
                                }

                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(HBSecondaryButtonStyle())
                    }
                }
            }
        }
    }

    private func submit() {
        session.updateServerURL(serverURL)

        if mode == .register {
            guard password == confirmPassword else {
                session.authError = "Passwords do not match."
                return
            }
            Task {
                await session.register(email: email, password: password)
            }
            return
        }

        Task {
            await session.login(email: email, password: password)
        }
    }
}
