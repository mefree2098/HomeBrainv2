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

                VStack(spacing: 14) {
                    HBSectionHeader(
                        title: "HomeBrain iOS",
                        subtitle: "Secure sign in to your HomeBrain hub"
                    )

                    Form {
                        Section("Server") {
                            TextField("HomeBrain server URL", text: $serverURL)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)

                            Button("Save Server URL") {
                                session.updateServerURL(serverURL)
                            }
                        }

                        Section {
                            Picker("Mode", selection: $mode) {
                                ForEach(Mode.allCases) { value in
                                    Text(value.rawValue).tag(value)
                                }
                            }
                            .pickerStyle(.segmented)

                            TextField("Email", text: $email)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)
                                .keyboardType(.emailAddress)

                            SecureField("Password", text: $password)

                            if mode == .register {
                                SecureField("Confirm password", text: $confirmPassword)
                            }

                            Button {
                                submit()
                            } label: {
                                if session.isProcessingAuth {
                                    HStack {
                                        ProgressView()
                                        Text(mode == .login ? "Signing In..." : "Creating Account...")
                                    }
                                } else {
                                    Text(mode == .login ? "Sign In" : "Create Account")
                                }
                            }
                            .disabled(session.isProcessingAuth || email.isEmpty || password.isEmpty || serverURL.isEmpty)
                            .buttonStyle(.borderedProminent)
                            .tint(HBPalette.accentBlue)
                        }

                        if let authError = session.authError, !authError.isEmpty {
                            Section {
                                InlineErrorView(message: authError, retry: nil)
                            }
                        }
                    }
                    .hbFormStyle()
                }
                .padding()
            }
            .toolbar(.hidden, for: .navigationBar)
            .onAppear {
                if serverURL.isEmpty {
                    serverURL = session.serverURLString
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
