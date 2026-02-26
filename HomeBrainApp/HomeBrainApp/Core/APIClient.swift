import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case server(statusCode: Int, message: String)
    case parsingFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Server URL is invalid."
        case .invalidResponse:
            return "Server response was invalid."
        case .unauthorized:
            return "You are not authorized. Please sign in again."
        case .server(_, let message):
            return message
        case .parsingFailed:
            return "Failed to parse server response."
        }
    }
}

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

@MainActor
final class APIClient {
    unowned let sessionStore: SessionStore
    private let urlSession: URLSession

    init(sessionStore: SessionStore, urlSession: URLSession = .shared) {
        self.sessionStore = sessionStore
        self.urlSession = urlSession
    }

    func get(_ path: String, query: [URLQueryItem] = []) async throws -> Any {
        try await request(path: path, method: .get, body: nil, query: query)
    }

    func post(_ path: String, body: Any? = nil, authorized: Bool = true) async throws -> Any {
        try await request(path: path, method: .post, body: body, query: [], authorized: authorized)
    }

    func put(_ path: String, body: Any? = nil) async throws -> Any {
        try await request(path: path, method: .put, body: body, query: [])
    }

    func patch(_ path: String, body: Any? = nil) async throws -> Any {
        try await request(path: path, method: .patch, body: body, query: [])
    }

    func delete(_ path: String) async throws -> Any {
        try await request(path: path, method: .delete, body: nil, query: [])
    }

    private func request(
        path: String,
        method: HTTPMethod,
        body: Any?,
        query: [URLQueryItem],
        authorized: Bool = true,
        hasRetried: Bool = false
    ) async throws -> Any {
        guard let url = buildURL(path: path, query: query) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if authorized, let accessToken = sessionStore.accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            if JSONSerialization.isValidJSONObject(body) {
                request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
            } else {
                throw APIError.parsingFailed
            }
        }

        let (data, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        let statusCode = httpResponse.statusCode

        if statusCode == 401 || statusCode == 403,
           authorized,
           !hasRetried,
           path != "/api/auth/refresh",
           path != "/api/auth/login",
           path != "/api/auth/register" {
            try await sessionStore.refreshTokens()
            return try await request(
                path: path,
                method: method,
                body: body,
                query: query,
                authorized: authorized,
                hasRetried: true
            )
        }

        let payload = try parseJSONPayload(data: data)

        guard (200..<300).contains(statusCode) else {
            let message = parseErrorMessage(from: payload)
            if statusCode == 401 || statusCode == 403 {
                throw APIError.unauthorized
            }
            throw APIError.server(statusCode: statusCode, message: message)
        }

        return payload
    }

    private func buildURL(path: String, query: [URLQueryItem]) -> URL? {
        let trimmedBase = sessionStore.serverURLString
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"

        guard let rawURL = URL(string: "\(trimmedBase)\(normalizedPath)") else {
            return nil
        }

        guard !query.isEmpty else {
            return rawURL
        }

        var components = URLComponents(url: rawURL, resolvingAgainstBaseURL: false)
        components?.queryItems = query
        return components?.url
    }

    private func parseJSONPayload(data: Data) throws -> Any {
        if data.isEmpty {
            return [:]
        }

        do {
            return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            if let raw = String(data: data, encoding: .utf8), !raw.isEmpty {
                return ["message": raw]
            }
            throw APIError.parsingFailed
        }
    }

    private func parseErrorMessage(from payload: Any) -> String {
        let object = JSON.object(payload)

        if let message = JSON.optionalString(object, "message") {
            return message
        }

        if let error = JSON.optionalString(object, "error") {
            return error
        }

        let dataObject = JSON.object(object["data"])
        if let message = JSON.optionalString(dataObject, "message") {
            return message
        }

        return "The server returned an error."
    }
}
