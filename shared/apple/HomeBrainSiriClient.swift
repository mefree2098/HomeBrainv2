import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

nonisolated struct HBSiriSession: Sendable {
    let baseURL: URL
    let accessToken: String
    let context: UUID
}

@MainActor
protocol HBSiriSessionProviding {
    func snapshot() async throws -> HBSiriSession
    func refresh(_ previous: HBSiriSession) async throws -> HBSiriSession
    func validate(_ previous: HBSiriSession) throws
}

/// Reject redirects before any credential-bearing request can be forwarded elsewhere.
nonisolated final class HBSiriRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class HBSiriClient {
    private let credentials: any HBSiriSessionProviding
    private let session: URLSession
    private let clientType: String

    init(credentials: any HBSiriSessionProviding, clientType: String, session: URLSession? = nil) {
        self.credentials = credentials
        self.clientType = clientType
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 15
        self.session = session ?? URLSession(configuration: config, delegate: HBSiriRedirectGuard(), delegateQueue: nil)
    }

    func catalog() async throws -> (HBSiriCatalog, HBSiriSession) {
        let snapshot = try await credentials.snapshot()
        let (catalog, latest): (HBSiriCatalog, HBSiriSession) = try await send("/api/siri/catalog", snapshot: snapshot)
        guard catalog.success, !catalog.accountId.isEmpty else { throw HBSiriError.invalidResponse }
        return (catalog, latest)
    }

    func targets(kinds: Set<String>) async throws -> [(HBSiriIdentity, HBSiriTarget)] {
        let (catalog, snapshot) = try await catalog()
        return catalog.targets.filter { kinds.contains($0.kind) }.map {
            (HBSiriIdentity(server: HBSiriPolicy.serverIdentity(snapshot.baseURL), account: catalog.accountId, kind: $0.kind, target: $0.id), $0)
        }
    }

    func execute(identity: String, action: String, brightness: Int? = nil) async throws -> String {
        let identity = try HBSiriIdentity.decode(identity)
        let (catalog, snapshot) = try await catalog()
        guard catalog.canExecute else { throw HBSiriError.readOnly }
        _ = try identity.resolve(server: HBSiriPolicy.serverIdentity(snapshot.baseURL), catalog: catalog)
        let requestId = UUID().uuidString.lowercased()
        var command: [String: Any] = ["accountId": catalog.accountId, "requestId": requestId,
                                     "kind": identity.kind, "targetId": identity.target, "action": action]
        if let brightness {
            guard (0...100).contains(brightness) else { throw HBSiriError.message("Brightness must be from 0 to 100 percent.") }
            command["brightness"] = brightness
        }
        let body = try JSONSerialization.data(withJSONObject: command)
        var result: HBSiriCommandResult
        var latest: HBSiriSession
        do {
            (result, latest) = try await send("/api/siri/commands", method: "POST", body: body, snapshot: snapshot)
        } catch let error as URLError {
            // The POST may already have reached the hub. Never blindly repeat a physical action.
            throw HBSiriError.message(error.code == .notConnectedToInternet
                ? "HomeBrain is unreachable. Check your connection."
                : "HomeBrain did not confirm receipt. Check device state or workflow history before trying again.")
        }
        guard result.requestId == requestId else { throw HBSiriError.invalidResponse }
        let deadline = Date().addingTimeInterval(6)
        while result.state == "running", Date() < deadline {
            try await Task.sleep(nanoseconds: 400_000_000)
            do {
                (result, latest) = try await send("/api/siri/commands/" + requestId, snapshot: latest)
                guard result.requestId == requestId else { throw HBSiriError.invalidResponse }
            } catch is URLError {
                return "HomeBrain accepted the command, but its result is not available yet. Check device state or workflow history."
            }
        }
        return try HBSiriPolicy.dialog(result)
    }

    func appleHomeStatus() async throws -> (HBAppleHomeStatus, HBSiriSession) {
        let snapshot = try await credentials.snapshot()
        let (status, latest): (HBAppleHomeStatus, HBSiriSession) = try await send("/api/apple-home/status", snapshot: snapshot)
        guard status.success else { throw HBSiriError.invalidResponse }
        return (status, latest)
    }

    func configureAppleHome(enabled: Bool) async throws -> HBAppleHomeStatus {
        let snapshot = try await credentials.snapshot()
        let body = try JSONSerialization.data(withJSONObject: ["enabled": enabled, "confirm": "SHARE WITH APPLE HOME"])
        let (status, _): (HBAppleHomeStatus, HBSiriSession) = try await send("/api/apple-home/configuration", method: "PUT", body: body, snapshot: snapshot)
        guard status.success else { throw HBSiriError.invalidResponse }
        return status
    }

    func appleHomePairing() async throws -> HBAppleHomePairing {
        let snapshot = try await credentials.snapshot()
        let (pairing, _): (HBAppleHomePairing, HBSiriSession) = try await send("/api/apple-home/pairing", method: "POST", body: Data("{}".utf8), snapshot: snapshot)
        guard pairing.success else { throw HBSiriError.invalidResponse }
        return pairing
    }

    private func send<Response: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
                                           snapshot: HBSiriSession, canRefresh: Bool = true) async throws -> (Response, HBSiriSession) {
        try credentials.validate(snapshot)
        var request = URLRequest(url: try HBSiriPolicy.endpoint(baseURL: snapshot.baseURL, path: path))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + snapshot.accessToken, forHTTPHeaderField: "Authorization")
        request.setValue(clientType, forHTTPHeaderField: "X-HomeBrain-Client-Type")
        request.setValue("HomeBrain Siri", forHTTPHeaderField: "X-HomeBrain-Client-Name")
        let (data, response) = try await session.data(for: request)
        try credentials.validate(snapshot)
        guard let response = response as? HTTPURLResponse else { throw HBSiriError.invalidResponse }
        if response.statusCode == 401, canRefresh {
            let refreshed = try await credentials.refresh(snapshot)
            try credentials.validate(refreshed)
            return try await send(path, method: method, body: body, snapshot: refreshed, canRefresh: false)
        }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 { throw HBSiriError.signIn }
            if response.statusCode == 404 && path == "/api/apple-home/status" {
                throw HBSiriError.message("Deploy the HomeBrain backend update with Apple Home bridge support, then retry.")
            }
            if response.statusCode == 404 && path == "/api/siri/catalog" {
                throw HBSiriError.message("Update the HomeBrain backend to the version with Siri support.")
            }
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["message"] as? String ?? object?["error"] as? String
            throw HBSiriError.message(message ?? "HomeBrain could not process this Siri request (HTTP \(response.statusCode)).")
        }
        guard let result = try? JSONDecoder().decode(Response.self, from: data) else { throw HBSiriError.invalidResponse }
        return (result, snapshot)
    }
}
