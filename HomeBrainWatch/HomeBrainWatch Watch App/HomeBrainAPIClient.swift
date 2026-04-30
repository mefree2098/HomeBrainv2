import Foundation

enum HomeBrainAPIError: LocalizedError, Equatable {
    case invalidServerURL
    case missingToken
    case unauthorized
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "Enter a valid HomeBrain URL."
        case .missingToken:
            return "Sign in again."
        case .unauthorized:
            return "Your HomeBrain session expired."
        case .server(let message):
            return message
        }
    }
}

struct LoginRequest: Encodable {
    let email: String
    let password: String
}

struct RefreshRequest: Encodable {
    let refreshToken: String
}

struct SecurityCommandRequest: Encodable {
    let action: String
}

struct LightCommandRequest: Encodable {
    let action: String
    let brightness: Int?
}

final class HomeBrainAPIClient {
    private let baseURL: URL
    private let deviceID: String
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURLString: String, deviceID: String) throws {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw HomeBrainAPIError.invalidServerURL
        }

        let withScheme = trimmed.contains("://") ? trimmed : "\(Self.defaultScheme(for: trimmed))://\(trimmed)"
        guard let url = URL(string: withScheme) else {
            throw HomeBrainAPIError.invalidServerURL
        }

        self.baseURL = url
        self.deviceID = deviceID
    }

    func login(email: String, password: String) async throws -> AuthTokens {
        try await send(
            path: "/api/auth/login",
            method: "POST",
            token: nil,
            body: LoginRequest(email: email, password: password),
            responseType: AuthTokens.self
        )
    }

    func refresh(refreshToken: String) async throws -> AuthTokens {
        let response: RefreshResponse = try await send(
            path: "/api/auth/refresh",
            method: "POST",
            token: nil,
            body: RefreshRequest(refreshToken: refreshToken),
            responseType: RefreshResponse.self
        )

        return response.tokens
    }

    func dashboard(accessToken: String) async throws -> WatchDashboard {
        let response: WatchDashboardResponse = try await send(
            path: "/api/watch/dashboard",
            method: "GET",
            token: accessToken,
            responseType: WatchDashboardResponse.self
        )

        return response.dashboard
    }

    func controlSecurity(action: String, accessToken: String) async throws -> WatchSecuritySection {
        let response: WatchSecurityResponse = try await send(
            path: "/api/watch/security",
            method: "POST",
            token: accessToken,
            body: SecurityCommandRequest(action: action),
            responseType: WatchSecurityResponse.self
        )

        return response.security
    }

    func controlLights(action: String, brightness: Int?, accessToken: String) async throws -> WatchLightsSection {
        let response: WatchLightsResponse = try await send(
            path: "/api/watch/lights",
            method: "POST",
            token: accessToken,
            body: LightCommandRequest(action: action, brightness: brightness),
            responseType: WatchLightsResponse.self
        )

        return response.lights
    }

    private func send<Response: Decodable>(
        path: String,
        method: String,
        token: String?,
        responseType: Response.Type
    ) async throws -> Response {
        var request = try makeRequest(path: path, method: method, token: token)
        request.httpBody = nil
        return try await run(request, responseType: responseType)
    }

    private func send<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        token: String?,
        body: Body,
        responseType: Response.Type
    ) async throws -> Response {
        var request = try makeRequest(path: path, method: method, token: token)
        request.httpBody = try encoder.encode(body)
        return try await run(request, responseType: responseType)
    }

    private func makeRequest(path: String, method: String, token: String?) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw HomeBrainAPIError.invalidServerURL
        }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("watchos", forHTTPHeaderField: "X-HomeBrain-Client-Type")
        request.setValue("Apple Watch", forHTTPHeaderField: "X-HomeBrain-Client-Name")
        request.setValue(deviceID, forHTTPHeaderField: "X-HomeBrain-Device-Id")

        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        return request
    }

    private static func defaultScheme(for rawValue: String) -> String {
        prefersHTTP(for: rawValue) ? "http" : "https"
    }

    private static func prefersHTTP(for rawValue: String) -> Bool {
        guard let host = URLComponents(string: "http://\(rawValue)")?.host?.lowercased(),
              !host.isEmpty else {
            return false
        }

        if host == "localhost" || host == "::1" || host.hasSuffix(".local") || !host.contains(".") {
            return true
        }

        if host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") {
            return true
        }

        let octets = host.split(separator: ".")
        if octets.count >= 2,
           octets[0] == "172",
           let second = Int(octets[1]),
           (16...31).contains(second) {
            return true
        }

        return false
    }

    private func run<Response: Decodable>(_ request: URLRequest, responseType: Response.Type) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HomeBrainAPIError.server("HomeBrain did not return an HTTP response.")
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
                throw HomeBrainAPIError.unauthorized
            }

            if let apiError = try? decoder.decode(APIErrorResponse.self, from: data) {
                throw HomeBrainAPIError.server(apiError.message ?? apiError.error ?? "HomeBrain request failed.")
            }

            throw HomeBrainAPIError.server("HomeBrain request failed with HTTP \(httpResponse.statusCode).")
        }

        do {
            return try decoder.decode(responseType, from: data)
        } catch {
            throw HomeBrainAPIError.server("HomeBrain returned data the watch app could not read.")
        }
    }
}
