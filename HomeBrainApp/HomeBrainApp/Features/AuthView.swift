import SwiftUI

struct AuthView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case login = "Login"
        case register = "Register"

        var id: String { rawValue }
    }

    @EnvironmentObject private var session: SessionStore

    @State private var mode: Mode = .login
    @State private var serverURL = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""

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
