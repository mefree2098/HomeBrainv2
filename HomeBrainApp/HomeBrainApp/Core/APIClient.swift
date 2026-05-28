import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case server(statusCode: Int, message: String)
    case parsingFailed
    case transientBackendUnavailable(message: String)

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
        case .transientBackendUnavailable(let message):
            return message
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
    private static let transientRetryDelays: [TimeInterval] = [0.75, 1.5, 3.0, 5.0]

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

    func streamURL(_ path: String, query: [URLQueryItem] = []) -> URL? {
        buildURL(path: path, query: query)
    }

    func mediaURL(_ path: String) -> URL? {
        if let absoluteURL = URL(string: path), absoluteURL.scheme != nil {
            return absoluteURL
        }

        return buildURL(path: path, query: [])
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
        hasRetried: Bool = false,
        transientAttempt: Int = 0
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

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: urlRequest)
        } catch {
            guard isTransientTransportError(error) else {
                throw error
            }

            sessionStore.reportTransientBackendFailure(error, path: path)
            if shouldRetryTransientRequest(method: method, attempt: transientAttempt) {
                try await sleepBeforeTransientRetry(attempt: transientAttempt)
                return try await dataRequest(
                    path: path,
                    method: method,
                    body: body,
                    query: query,
                    authorized: authorized,
                    hasRetried: hasRetried,
                    transientAttempt: transientAttempt + 1
                )
            }

            throw APIError.transientBackendUnavailable(message: transientBackendMessage())
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        let statusCode = httpResponse.statusCode
        let parsedErrorMessage = { self.parseErrorMessage(from: self.payloadForError(from: data)) }

        if isTransientHTTPStatus(statusCode) {
            let message = parsedErrorMessage()
            sessionStore.reportTransientBackendFailure(
                APIError.server(statusCode: statusCode, message: message),
                path: path
            )

            if shouldRetryTransientRequest(method: method, attempt: transientAttempt) {
                try await sleepBeforeTransientRetry(attempt: transientAttempt)
                return try await dataRequest(
                    path: path,
                    method: method,
                    body: body,
                    query: query,
                    authorized: authorized,
                    hasRetried: hasRetried,
                    transientAttempt: transientAttempt + 1
                )
            }

            throw APIError.transientBackendUnavailable(message: transientBackendMessage())
        }

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
                hasRetried: true,
                transientAttempt: transientAttempt
            )
        }

        guard (200..<300).contains(statusCode) else {
            let message = parsedErrorMessage()
            if statusCode == 401 {
                if authorized {
                    sessionStore.expireAuthentication(message: message)
                }
                throw APIError.unauthorized
            }
            throw APIError.server(statusCode: statusCode, message: message)
        }

        sessionStore.reportBackendRequestSucceeded()
        return (data, httpResponse)
    }

    private func buildURL(path: String, query: [URLQueryItem]) -> URL? {
        guard var components = sessionStore.normalizedServerURL.flatMap({
            URLComponents(url: $0, resolvingAgainstBaseURL: false)
        }) else {
            return nil
        }

        let pathParts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let requestPath = pathParts.first.map(String.init) ?? ""
        let inlineQueryItems: [URLQueryItem]
        if pathParts.count > 1 {
            inlineQueryItems = URLComponents(string: "?\(String(pathParts[1]))")?.queryItems ?? []
        } else {
            inlineQueryItems = []
        }

        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = requestPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let pathComponents = [basePath, normalizedPath].filter { !$0.isEmpty }
        components.path = pathComponents.isEmpty ? "" : "/\(pathComponents.joined(separator: "/"))"

        let queryItems = inlineQueryItems + query
        components.queryItems = queryItems.isEmpty ? nil : queryItems

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

    private func isTransientTransportError(_ error: Error) -> Bool {
        guard let urlError = urlError(from: error) else {
            return false
        }

        switch urlError.code {
        case .badServerResponse,
             .cannotConnectToHost,
             .cannotFindHost,
             .dnsLookupFailed,
             .networkConnectionLost,
             .notConnectedToInternet,
             .secureConnectionFailed,
             .timedOut:
            return true
        default:
            return false
        }
    }

    private func urlError(from error: Error) -> URLError? {
        if let urlError = error as? URLError {
            return urlError
        }

        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else {
            return nil
        }

        return URLError(URLError.Code(rawValue: nsError.code))
    }

    private func isTransientHTTPStatus(_ statusCode: Int) -> Bool {
        statusCode == 408 || statusCode == 502 || statusCode == 503 || statusCode == 504
    }

    private func shouldRetryTransientRequest(method: HTTPMethod, attempt: Int) -> Bool {
        method == .get && attempt < Self.transientRetryDelays.count
    }

    private func sleepBeforeTransientRetry(attempt: Int) async throws {
        let delay = Self.transientRetryDelays[min(attempt, Self.transientRetryDelays.count - 1)]
        try await Task.sleep(for: .seconds(delay))
    }

    private func transientBackendMessage() -> String {
        "HomeBrain is restarting or temporarily unreachable. Reconnecting..."
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
