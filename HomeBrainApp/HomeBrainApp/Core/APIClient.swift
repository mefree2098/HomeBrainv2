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

    func download(
        _ path: String,
        method: HTTPMethod = .get,
        body: Any? = nil,
        query: [URLQueryItem] = [],
        authorized: Bool = true
    ) async throws -> (data: Data, suggestedFilename: String?) {
        let (data, response) = try await dataRequest(path: path, method: method, body: body, query: query, authorized: authorized)
        return (data, suggestedFilename(from: response))
    }

    func streamURL(_ path: String, query: [URLQueryItem] = [], includeAccessTokenQuery: Bool = false) -> URL? {
        var resolvedQuery = query

        if includeAccessTokenQuery,
           let accessToken = sessionStore.accessToken,
           !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            resolvedQuery.append(URLQueryItem(name: "token", value: accessToken))
        }

        return buildURL(path: path, query: resolvedQuery)
    }

    private func request(
        path: String,
        method: HTTPMethod,
        body: Any?,
        query: [URLQueryItem],
        authorized: Bool = true,
        hasRetried: Bool = false
    ) async throws -> Any {
        let (data, _) = try await dataRequest(
            path: path,
            method: method,
            body: body,
            query: query,
            authorized: authorized,
            hasRetried: hasRetried
        )
        return try parseJSONPayload(data: data)
    }

    private func dataRequest(
        path: String,
        method: HTTPMethod,
        body: Any?,
        query: [URLQueryItem],
        authorized: Bool = true,
        hasRetried: Bool = false
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = buildURL(path: path, query: query) else {
            throw APIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method.rawValue
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        urlRequest.setValue("no-cache", forHTTPHeaderField: "Pragma")

        for (header, value) in sessionStore.clientHeaders {
            urlRequest.setValue(value, forHTTPHeaderField: header)
        }

        if authorized {
            let accessToken = try await sessionStore.validAccessToken()
            urlRequest.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            if JSONSerialization.isValidJSONObject(body) {
                urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
            } else {
                throw APIError.parsingFailed
            }
        }

        let (data, response) = try await urlSession.data(for: urlRequest)

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
            return try await dataRequest(
                path: path,
                method: method,
                body: body,
                query: query,
                authorized: authorized,
                hasRetried: true
            )
        }

        guard (200..<300).contains(statusCode) else {
            let message = parseErrorMessage(from: payloadForError(from: data))
            if statusCode == 401 {
                if authorized {
                    sessionStore.expireAuthentication(message: message)
                }
                throw APIError.unauthorized
            }
            throw APIError.server(statusCode: statusCode, message: message)
        }

        return (data, httpResponse)
    }

    private func buildURL(path: String, query: [URLQueryItem]) -> URL? {
        guard var components = sessionStore.normalizedServerURL.flatMap({
            URLComponents(url: $0, resolvingAgainstBaseURL: false)
        }) else {
            return nil
        }

        let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let pathComponents = [basePath, normalizedPath].filter { !$0.isEmpty }
        components.percentEncodedPath = pathComponents.isEmpty ? "" : "/\(pathComponents.joined(separator: "/"))"
        components.queryItems = query.isEmpty ? nil : query

        return components.url
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

    private func payloadForError(from data: Data) -> Any {
        (try? parseJSONPayload(data: data)) ?? [:]
    }

    private func suggestedFilename(from response: HTTPURLResponse) -> String? {
        guard let contentDisposition = response.value(forHTTPHeaderField: "Content-Disposition") else {
            return nil
        }

        let parts = contentDisposition.split(separator: ";")
        for rawPart in parts {
            let part = rawPart.trimmingCharacters(in: .whitespacesAndNewlines)
            guard part.lowercased().hasPrefix("filename=") else { continue }
            let value = part.dropFirst("filename=".count)
            return String(value).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }

        return nil
    }
}
