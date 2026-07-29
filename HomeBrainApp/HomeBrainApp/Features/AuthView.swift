import SwiftUI

struct AuthView: View {
    private enum Field: Hashable {
        case endpoint
        case email
        case password
    }

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject private var session: SessionStore
    #if DEBUG
    @EnvironmentObject private var uiPreview: UIPreviewStore
    #endif

    @FocusState private var focusedField: Field?
    @State private var serverURL = ""
    @State private var email = ""
    @State private var password = ""

    #if DEBUG
    private let previewSections: [AppShellView.AppSection] = [
        .dashboard,
        .senseEnergy,
        .devices,
        .scenes,
        .workflows,
        .voiceDevices,
        .settings,
        .ollama
    ]
    #endif

    private var usesCompactSpacing: Bool {
        horizontalSizeClass == .compact
    }

    private var usesStackedControls: Bool {
        horizontalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize
    }

    private var hasRequiredCredentials: Bool {
        !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
    }

    var body: some View {
        NavigationStack {
            ZStack {
                HBPageBackground()
                    .ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(spacing: usesCompactSpacing ? 12 : 18) {
                        HStack {
                            if session.isAddingInstance {
                                Button("Cancel") {
                                    session.cancelAddingInstance()
                                }
                                .buttonStyle(HBSecondaryButtonStyle())
                                .accessibilityIdentifier("auth.addInstance.cancel")
                            }
                            Spacer(minLength: 0)
                            HBThemeToggleMenu()
                        }

                        HBDeckSurface(cornerRadius: usesCompactSpacing ? 26 : 32) {
                            VStack(alignment: .leading, spacing: usesCompactSpacing ? 12 : 18) {
                                heroPanel
                                if !session.isAddingInstance && !session.savedInstances.isEmpty {
                                    savedInstancesPanel
                                }
                                authPanel
                                #if DEBUG
                                previewPanel
                                #endif
                            }
                            .padding(usesCompactSpacing ? 10 : 18)
                        }
                        .frame(maxWidth: 680)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, usesCompactSpacing ? 14 : 28)
                    .padding(.vertical, usesCompactSpacing ? 8 : 24)
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollBounceBehavior(.basedOnSize)
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
            if usesStackedControls {
                VStack(alignment: .leading, spacing: 14) {
                    brandIcon(size: 42)
                    heroCopy
                }
            } else {
                HStack(alignment: .top, spacing: usesCompactSpacing ? 12 : 16) {
                    brandIcon(size: usesCompactSpacing ? 38 : 48)
                    heroCopy
                }
            }
        }
    }

    private var heroCopy: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Private Home Control")
                .font(HBTypography.display(.caption2, weight: .bold))
                .textCase(.uppercase)
                .tracking(2.2)
                .foregroundStyle(HBPalette.textMuted)

            Text(session.isAddingInstance ? "Add a HomeBrain" : "Welcome to HomeBrain")
                .font(HBTypography.display(.title, weight: .bold))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HBPalette.accentBlue, HBPalette.accentPurple],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            Text(session.isAddingInstance
                ? "Sign in to another HomeBrain platform. Your existing platforms stay saved and completely separate."
                : "Connect securely to your HomeBrain hub and manage your home from iPhone, iPad, and Apple Watch.")
                .font(HBTypography.body(.body, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if !usesCompactSpacing || usesStackedControls {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        HBBadge(text: "Private hub")
                        HBBadge(text: "Secure access")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HBBadge(text: "Private hub")
                        HBBadge(text: "Secure access")
                    }
                }
            }
        }
    }

    private func brandIcon(size: CGFloat) -> some View {
        Image("HomeBrainBrandIcon")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .padding(10)
            .background(HBGlassBackground(cornerRadius: 18, variant: .panelSoft))
            .accessibilityHidden(true)
    }

    private var authPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(session.isAddingInstance ? "Sign In to New Platform" : "Sign In")
                        .font(HBTypography.display(.title2, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)
                        .accessibilityAddTraits(.isHeader)

                    Text("Use the account credentials supplied by your HomeBrain administrator.")
                        .font(HBTypography.body(.subheadline, weight: .medium))
                        .foregroundStyle(HBPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                endpointSection
                credentialSection

                if let authError = session.authError, !authError.isEmpty {
                    InlineErrorView(message: authError, retry: nil)
                }

                signInActions

                Label {
                    Text("Accounts are created on the HomeBrain hub. This app does not offer public or in-app registration.")
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .foregroundStyle(HBPalette.accentBlue)
                }
                .font(HBTypography.body(.footnote, weight: .medium))
                .foregroundStyle(HBPalette.textSecondary)
                .accessibilityIdentifier("auth.provisioningNotice")

                legalLinks
            }
        }
    }

    private var savedInstancesPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Saved HomeBrains")
                        .font(HBTypography.display(.title3, weight: .bold))
                        .foregroundStyle(HBPalette.textPrimary)

                    Text("Select a saved platform to switch instantly, or enter a password below if that session needs to be renewed.")
                        .font(HBTypography.body(.subheadline, weight: .medium))
                        .foregroundStyle(HBPalette.textSecondary)
                }

                ForEach(session.savedInstances) { instance in
                    Button {
                        serverURL = instance.serverURL
                        email = instance.user.email
                        session.switchInstance(to: instance.id)
                        focusedField = .password
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: instance.id == session.activeInstanceID ? "house.circle.fill" : "house.circle")
                                .font(.system(size: 26))
                                .foregroundStyle(HBPalette.accentBlue)

                            VStack(alignment: .leading, spacing: 3) {
                                Text(instance.displayName)
                                    .font(HBTypography.body(.body, weight: .semibold))
                                    .foregroundStyle(HBPalette.textPrimary)
                                Text(instance.accountSummary)
                                    .font(HBTypography.body(.caption, weight: .medium))
                                    .foregroundStyle(HBPalette.textSecondary)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .foregroundStyle(HBPalette.textMuted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(HBSecondaryButtonStyle())
                    .accessibilityIdentifier("auth.savedInstance.\(instance.id)")
                }
            }
        }
    }

    private var legalLinks: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                supportLink
                privacyLink
            }

            VStack(alignment: .leading, spacing: 10) {
                supportLink
                privacyLink
            }
        }
        .font(HBTypography.body(.footnote, weight: .semibold))
        .tint(HBPalette.accentBlue)
    }

    private var supportLink: some View {
        Link(destination: URL(string: "https://freestonefamily.com/support")!) {
            Label("Support", systemImage: "questionmark.circle")
        }
        .accessibilityIdentifier("auth.support")
    }

    private var privacyLink: some View {
        Link(destination: URL(string: "https://freestonefamily.com/privacy")!) {
            Label("Privacy Policy", systemImage: "hand.raised")
        }
        .accessibilityIdentifier("auth.privacy")
    }

    private var endpointSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("HomeBrain Hub")
                .font(HBTypography.body(.subheadline, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)

            if usesStackedControls {
                VStack(spacing: 10) {
                    endpointField
                    saveEndpointButton
                        .frame(maxWidth: .infinity)
                }
            } else {
                HStack(spacing: 10) {
                    endpointField
                    saveEndpointButton
                }
            }

            Text("Enter the secure address provided with your HomeBrain setup.")
                .font(HBTypography.body(.caption, weight: .medium))
                .foregroundStyle(HBPalette.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var endpointField: some View {
        TextField("https://your-homebrain.example", text: $serverURL)
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .disableAutocorrection(true)
            .submitLabel(.next)
            .focused($focusedField, equals: .endpoint)
            .onSubmit { focusedField = .email }
            .hbPanelTextField()
            .accessibilityLabel("HomeBrain hub address")
            .accessibilityIdentifier("auth.endpoint")
    }

    private var saveEndpointButton: some View {
        Button("Save Hub") {
            saveEndpoint()
        }
        .buttonStyle(HBSecondaryButtonStyle())
        .accessibilityHint("Validates and saves this HomeBrain hub address")
        .accessibilityIdentifier("auth.endpoint.save")
    }

    private var credentialSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Account")
                .font(HBTypography.body(.subheadline, weight: .semibold))
                .foregroundStyle(HBPalette.textSecondary)

            TextField("Email", text: $email)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)
                .keyboardType(.emailAddress)
                .textContentType(.username)
                .submitLabel(.next)
                .focused($focusedField, equals: .email)
                .onSubmit { focusedField = .password }
                .hbPanelTextField()
                .accessibilityIdentifier("auth.email")

            SecureField("Password", text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focusedField, equals: .password)
                .onSubmit { submit() }
                .hbPanelTextField()
                .accessibilityIdentifier("auth.password")
        }
    }

    @ViewBuilder
    private var signInActions: some View {
        if usesStackedControls {
            VStack(spacing: 10) {
                signInButton
                useSavedHubButton
            }
        } else {
            HStack(spacing: 12) {
                signInButton
                useSavedHubButton
            }
        }
    }

    private var signInButton: some View {
        Button {
            submit()
        } label: {
            Group {
                if session.isProcessingAuth {
                    HStack(spacing: 8) {
                        ProgressView()
                            .tint(.white)
                        Text("Signing In…")
                    }
                } else {
                    Label("Sign In", systemImage: "arrow.right.circle.fill")
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(HBPrimaryButtonStyle())
        .disabled(session.isProcessingAuth || !hasRequiredCredentials)
        .accessibilityIdentifier("auth.signIn")
    }

    private var useSavedHubButton: some View {
        Button("Use Saved Hub") {
            serverURL = session.serverURLString
            focusedField = .email
        }
        .buttonStyle(HBSecondaryButtonStyle())
        .frame(maxWidth: usesStackedControls ? .infinity : nil)
        .accessibilityIdentifier("auth.endpoint.restore")
    }

    #if DEBUG
    private var previewPanel: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("UI Preview")
                    .font(HBTypography.display(.caption2, weight: .bold))
                    .textCase(.uppercase)
                    .tracking(2.2)
                    .foregroundStyle(HBPalette.textMuted)

                Text("Jump directly into the app shell without authentication to inspect layouts, theme behavior, and spacing on each module.")
                    .font(HBTypography.body(.subheadline, weight: .medium))
                    .foregroundStyle(HBPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

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
                                        .font(HBTypography.body(.subheadline, weight: .semibold))
                                        .foregroundStyle(HBPalette.textPrimary)
                                        .lineLimit(1)
                                    Text(section.chromeKicker)
                                        .font(HBTypography.display(.caption2, weight: .bold))
                                        .textCase(.uppercase)
                                        .tracking(1.4)
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
    #endif

    private func saveEndpoint() {
        if session.updateServerURL(serverURL) {
            serverURL = session.serverURLString
            session.authError = nil
            focusedField = .email
        } else {
            session.authError = "Enter a valid HomeBrain hub address."
            focusedField = .endpoint
        }
    }

    private func submit() {
        guard hasRequiredCredentials else {
            if serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                focusedField = .endpoint
            } else if email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                focusedField = .email
            } else {
                focusedField = .password
            }
            return
        }

        let submittedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedPassword = password

        guard session.updateServerURL(serverURL) else {
            session.authError = "Enter a valid HomeBrain hub address."
            focusedField = .endpoint
            return
        }

        serverURL = session.serverURLString
        session.authError = nil
        focusedField = nil

        Task {
            await session.login(
                email: submittedEmail,
                password: submittedPassword
            )
        }
    }
}
