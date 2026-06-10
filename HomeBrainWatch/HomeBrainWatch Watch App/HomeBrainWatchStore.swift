import Foundation
import Combine
import SwiftUI

@MainActor
final class HomeBrainWatchStore: ObservableObject {
    @AppStorage("homebrain.serverURL") var serverURL = "http://homebrain.local:3000"
    @AppStorage("homebrain.email") var email = ""
    @AppStorage("homebrain.deviceID") private var storedDeviceID = ""

    @Published var password = ""
    @Published var dashboard: WatchDashboard?
    @Published var isAuthenticated = false
    @Published var isLoading = false
    @Published var isSigningIn = false
    @Published var commandInFlight: String?
    @Published var errorMessage: String?
    @Published var companionStatusMessage: String?

  private let accessTokenAccount = "accessToken"
  private let refreshTokenAccount = "refreshToken"
  private let isPreviewMode: Bool
  private var companionSync: WatchCompanionSync?

    var deviceID: String {
        if storedDeviceID.isEmpty {
            storedDeviceID = UUID().uuidString
        }
        return storedDeviceID
    }

  init() {
    isPreviewMode = Self.previewEnabledFromLaunch()
    if isPreviewMode {
      isAuthenticated = true
      dashboard = Self.previewDashboard()
      companionStatusMessage = "Preview mode"
      return
    }

    isAuthenticated = KeychainStore.read(account: accessTokenAccount)?.isEmpty == false
        let companionSync = WatchCompanionSync(store: self)
        self.companionSync = companionSync
        companionSync.activate()
        companionSync.requestSessionSync()
    }

    func signIn() async {
        isSigningIn = true
        errorMessage = nil

        do {
            let client = try makeClient()
            let tokens = try await client.login(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            try store(tokens: tokens)
            password = ""
            isAuthenticated = true
            await refreshDashboard()
        } catch {
            isAuthenticated = false
            errorMessage = displayMessage(for: error)
        }

        isSigningIn = false
    }

    func signOut() {
        KeychainStore.delete(account: accessTokenAccount)
        KeychainStore.delete(account: refreshTokenAccount)
        dashboard = nil
        password = ""
        isAuthenticated = false
        errorMessage = nil
    }

    func requestCompanionSignIn() {
        companionStatusMessage = "Checking iPhone..."
        companionSync?.requestSessionSync()
    }

    func applyCompanionPayload(_ payload: [String: Any]) {
        let type = payload["type"] as? String

        if type == "homebrain.session.clear" {
            signOut()
            companionStatusMessage = "Signed out from iPhone."
            return
        }

        guard type == "homebrain.session" else {
            return
        }

        guard let accessToken = normalized(payload["accessToken"] as? String),
              let refreshToken = normalized(payload["refreshToken"] as? String),
              let serverURL = normalized(payload["serverURL"] as? String) else {
            companionStatusMessage = "The iPhone did not send a complete HomeBrain session."
            return
        }

        do {
            self.serverURL = serverURL
            if let email = normalized(payload["email"] as? String) {
                self.email = email
            }
            try KeychainStore.save(accessToken, account: accessTokenAccount)
            try KeychainStore.save(refreshToken, account: refreshTokenAccount)
            isAuthenticated = true
            errorMessage = nil
            companionStatusMessage = "Signed in from iPhone."
            Task { await refreshDashboard() }
        } catch {
            companionStatusMessage = displayMessage(for: error)
        }
    }

  func refreshDashboard() async {
    guard isAuthenticated else { return }
    if isPreviewMode {
      dashboard = Self.previewDashboard()
      isLoading = false
      return
    }

    isLoading = true
        errorMessage = nil

        do {
            dashboard = try await withValidAccessToken { client, token in
                try await client.dashboard(accessToken: token)
            }
        } catch {
            errorMessage = displayMessage(for: error)
            if let apiError = error as? HomeBrainAPIError, apiError == .unauthorized || apiError == .missingToken {
                signOut()
            }
        }

        isLoading = false
    }

  func controlSecurity(_ action: String) async {
    if isPreviewMode { return }
    commandInFlight = action
        errorMessage = nil

        do {
            _ = try await withValidAccessToken { client, token in
                try await client.controlSecurity(action: action, accessToken: token)
            }
            await refreshDashboard()
        } catch {
            errorMessage = displayMessage(for: error)
        }

        commandInFlight = nil
    }

  func controlLights(room: String? = nil, action: String, brightness: Int? = nil) async {
    if isPreviewMode { return }
    commandInFlight = "lights-\(action)"
        errorMessage = nil

        do {
            _ = try await withValidAccessToken { client, token in
                try await client.controlLights(room: room, action: action, brightness: brightness, accessToken: token)
            }
            await refreshDashboard()
        } catch {
            errorMessage = displayMessage(for: error)
        }

        commandInFlight = nil
    }

    func registerPushDevice(_ registration: PushDeviceRegistrationRequest) async throws {
        try await withValidAccessToken { client, token in
            try await client.registerPushDevice(registration, accessToken: token)
        }
    }

    func unregisterPushDevice(installationId: String) async throws {
        try await withValidAccessToken { client, token in
            try await client.unregisterPushDevice(installationId: installationId, accessToken: token)
        }
    }

  private func makeClient() throws -> HomeBrainAPIClient {
    try HomeBrainAPIClient(baseURLString: serverURL, deviceID: deviceID)
  }

  private static func previewEnabledFromLaunch() -> Bool {
    let processInfo = ProcessInfo.processInfo
    if processInfo.arguments.contains("-ui-preview") {
      return true
    }
    if let environmentValue = processInfo.environment["UI_PREVIEW_ENABLED"] {
      return ["1", "true", "yes"].contains(environmentValue.lowercased())
    }
    return false
  }

  private static func previewDashboard() -> WatchDashboard {
    return WatchDashboard(
      generatedAt: "2026-06-09T18:00:00.000Z",
      user: WatchUser(
        id: "preview-user",
        name: "HomeBrain",
        email: "review@example.com"
      ),
      config: WatchConfig(
        sections: [.security, .lights, .power, .weather],
        primaryRoom: "Living Room",
        lightDeviceIds: [],
        defaultLightBrightness: 70
      ),
      availableRooms: [
        WatchRoomSummary(
          name: "Living Room",
          lightCount: 3,
          onlineCount: 3,
          onCount: 2,
          dimmableCount: 3
        ),
        WatchRoomSummary(
          name: "Kitchen",
          lightCount: 2,
          onlineCount: 2,
          onCount: 1,
          dimmableCount: 2
        )
      ],
      sections: WatchSections(
        security: WatchSecuritySection(
          available: true,
          alarmState: "disarmed",
          stateLabel: "Disarmed",
          isArmed: false,
          isTriggered: false,
          isOnline: true,
          sensorCount: 6,
          activeSensorCount: 0,
          attentionSensorCount: 1,
          offlineSensorCount: 0,
          lowBatterySensorCount: 1,
          doorLockCount: 2,
          unlockedDoorCount: 0,
          error: nil
        ),
        lights: WatchLightsSection(
          available: true,
          room: "Living Room",
          totalCount: 3,
          onCount: 2,
          onlineCount: 3,
          dimmableCount: 3,
          averageBrightness: 68,
          defaultLightBrightness: 70,
          devices: [
            WatchLightDevice(
              id: "preview-living-room",
              name: "Living Room Lamp",
              room: "Living Room",
              type: "light",
              isOn: true,
              isOnline: true,
              brightness: 68,
              dimmable: true
            ),
            WatchLightDevice(
              id: "preview-patio",
              name: "Patio Lights",
              room: "Patio",
              type: "light",
              isOn: true,
              isOnline: true,
              brightness: 45,
              dimmable: true
            )
          ],
          rooms: [
            WatchLightRoom(
              available: true,
              name: "Living Room",
              room: "Living Room",
              totalCount: 3,
              onCount: 2,
              onlineCount: 3,
              dimmableCount: 3,
              averageBrightness: 68,
              defaultLightBrightness: 70,
              devices: nil,
              error: nil
            ),
            WatchLightRoom(
              available: true,
              name: "Kitchen",
              room: "Kitchen",
              totalCount: 2,
              onCount: 1,
              onlineCount: 2,
              dimmableCount: 2,
              averageBrightness: 52,
              defaultLightBrightness: 70,
              devices: nil,
              error: nil
            )
          ],
          error: nil
        ),
        power: WatchPowerSection(
          available: true,
          monitorName: "Sense Energy",
          observedAt: "6:00 PM",
          powerW: 642,
          solarW: 0,
          netW: 642,
          alwaysOnW: 126,
          activeDeviceCount: 5,
          currentCostUsdPerHour: 0.09,
          dayKwh: 18.4,
          projectedMonthUsd: 118.75,
          activeDevices: [
            WatchPowerDevice(name: "Climate", powerW: 310, sharePct: 48),
            WatchPowerDevice(name: "Lighting", powerW: 84, sharePct: 13)
          ],
          error: nil
        ),
        weather: WatchWeatherSection(
          available: true,
          fetchedAt: "6:00 PM",
          locationName: "Home",
          temperatureF: 67,
          apparentTemperatureF: 65,
          condition: "Partly Cloudy",
          icon: "cloud.sun.fill",
          humidity: 44,
          windSpeedMph: 7,
          highF: 74,
          lowF: 49,
          precipitationChance: 20,
          error: nil
        )
      )
    )
  }

  private func withValidAccessToken<T>(
        operation: (HomeBrainAPIClient, String) async throws -> T
    ) async throws -> T {
        let client = try makeClient()
        guard let accessToken = KeychainStore.read(account: accessTokenAccount), !accessToken.isEmpty else {
            throw HomeBrainAPIError.missingToken
        }

        do {
            return try await operation(client, accessToken)
        } catch HomeBrainAPIError.unauthorized {
            let refreshedToken = try await refreshAccessToken(with: client)
            return try await operation(client, refreshedToken)
        }
    }

    private func refreshAccessToken(with client: HomeBrainAPIClient) async throws -> String {
        guard let refreshToken = KeychainStore.read(account: refreshTokenAccount), !refreshToken.isEmpty else {
            throw HomeBrainAPIError.missingToken
        }

        let tokens = try await client.refresh(refreshToken: refreshToken)
        try store(tokens: tokens)

        guard let accessToken = tokens.accessToken, !accessToken.isEmpty else {
            throw HomeBrainAPIError.missingToken
        }

        return accessToken
    }

    private func store(tokens: AuthTokens) throws {
        guard let accessToken = tokens.accessToken, !accessToken.isEmpty else {
            throw HomeBrainAPIError.missingToken
        }

        try KeychainStore.save(accessToken, account: accessTokenAccount)

        if let refreshToken = tokens.refreshToken, !refreshToken.isEmpty {
            try KeychainStore.save(refreshToken, account: refreshTokenAccount)
        }
    }

    private func displayMessage(for error: Error) -> String {
        if let localizedError = error as? LocalizedError, let description = localizedError.errorDescription {
            return description
        }

        return error.localizedDescription
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
