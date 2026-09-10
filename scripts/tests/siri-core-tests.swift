import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

nonisolated final class HTTPFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var responder: (@Sendable (URLRequest) throws -> (Int, Data))?
    private var requests: [URLRequest] = []
    func install(_ responder: @escaping @Sendable (URLRequest) throws -> (Int, Data)) {
        lock.lock(); defer { lock.unlock() }
        self.responder = responder; requests = []
    }
    func respond(_ request: URLRequest) throws -> (Int, Data) {
        lock.lock(); requests.append(request); let handler = responder; lock.unlock()
        return try handler!(request)
    }
    func captured() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}
nonisolated final class MockURLProtocol: URLProtocol {
    static let fixture = HTTPFixture()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            var request = request
            if request.httpBody == nil, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 2048)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    data.append(contentsOf: buffer.prefix(count))
                }
                request.httpBody = data
            }
            let (status, data) = try Self.fixture.respond(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor final class TestCredentials: HBSiriSessionProviding {
    var context = UUID()
    var token = "test-access-token"
    var refreshes = 0
    var validations = 0
    var invalidateAfterFirstValidation = false
    let url = URL(string: "https://example.test/homebrain")!
    func snapshot() async throws -> HBSiriSession { HBSiriSession(baseURL: url, accessToken: token, context: context) }
    func refresh(_ previous: HBSiriSession) async throws -> HBSiriSession {
        try validate(previous); refreshes += 1; token = "refreshed-token"
        return try await snapshot()
    }
    func validate(_ previous: HBSiriSession) throws {
        validations += 1
        if invalidateAfterFirstValidation && validations > 1 { context = UUID() }
        guard previous.context == context else { throw HBSiriError.changedHome }
    }
}
nonisolated enum Samples {
    static let target = HBSiriTarget(kind: "workflow", id: "w1", name: "Night TV", room: "", aliases: ["Movie time"])
    static let catalog = HBSiriCatalog(success: true, accountId: "u1", canExecute: true, targets: [target])
    static var catalogData: Data { try! JSONEncoder().encode(catalog) }
    static func result(id: String, state: String = "completed", success: Bool = true) -> Data {
        try! JSONEncoder().encode(HBSiriCommandResult(success: success, requestId: id, state: state,
                                  message: state == "running" ? "Started Night TV. Check HomeBrain for completion." : "Finished Night TV."))
    }
}
nonisolated struct Failure: Error, CustomStringConvertible { let description: String }

@main struct SiriCoreTests {
    @MainActor static func main() async throws {
        var tests = 0
        func check(_ condition: Bool, _ message: String) throws {
            guard condition else { throw Failure(description: message) }
        }
        func passes(_ name: String, _ test: () throws -> Void) throws {
            try test(); tests += 1; print("PASS \(name)")
        }
        func rejects(_ action: () throws -> Void) throws {
            do { try action() } catch { return }
            throw Failure(description: "Expected an error")
        }
        func rejectsAsync(_ action: () async throws -> Void) async throws {
            do { try await action() } catch { return }
            throw Failure(description: "Expected an async error")
        }
        func makeClient(_ responder: @escaping @Sendable (URLRequest) throws -> (Int, Data)) -> (HBSiriClient, TestCredentials) {
            MockURLProtocol.fixture.install(responder)
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [MockURLProtocol.self]
            let credentials = TestCredentials()
            return (HBSiriClient(credentials: credentials, clientType: "watchos", session: URLSession(configuration: config)), credentials)
        }
        let identity = HBSiriIdentity(server: "https://example.test/homebrain", account: "u1", kind: "workflow", target: "w1")
        let encoded = try identity.encoded()
        try passes("identity round trip and no credential storage") {
            try check(try HBSiriIdentity.decode(encoded) == identity, "identity mismatch")
            try check(!String(data: Data(base64Encoded: encoded)!, encoding: .utf8)!.contains("token"), "credential in identity")
        }
        try passes("malformed identities rejected") {
            for id in ["garbage", "", String(repeating: "x", count: 8193)] { try rejects { _ = try HBSiriIdentity.decode(id) } }
        }
        try passes("home/account binding and removed targets") {
            try rejects { _ = try identity.resolve(server: "https://other.test", catalog: Samples.catalog) }
            try rejects { _ = try identity.resolve(server: identity.server, catalog: HBSiriCatalog(success: true, accountId: "other", canExecute: true, targets: [Samples.target])) }
            try rejects { _ = try identity.resolve(server: identity.server, catalog: HBSiriCatalog(success: true, accountId: "u1", canExecute: true, targets: [])) }
        }
        try passes("exact names and aliases normalize whitespace and case") {
            try check(HBSiriPolicy.matching("  MOVIE   TIME  ", in: [Samples.target]).count == 1, "alias missing")
            try check(HBSiriPolicy.matching("night tv", in: [Samples.target]).count == 1, "name missing")
        }
        try passes("ambiguous aliases stay ambiguous") {
            let other = HBSiriTarget(kind: "workflow", id: "w2", name: "Other", room: "", aliases: ["Movie time"])
            try check(HBSiriPolicy.matching("Movie time", in: [Samples.target, other]).count == 2, "ambiguity dropped")
        }
        try passes("base paths and canonical server identity") {
            let url = URL(string: "https://EXAMPLE.test:443/homebrain/")!
            try check(HBSiriPolicy.serverIdentity(url) == identity.server, "canonical identity")
            try check(try HBSiriPolicy.endpoint(baseURL: url, path: "/api/siri/catalog").path == "/homebrain/api/siri/catalog", "base path lost")
        }
        try passes("untrusted request paths and URL credentials rejected") {
            for path in ["https://evil.test", "/api/siri/../auth", "/api/siri/catalog?token=x"] {
                try rejects { _ = try HBSiriPolicy.endpoint(baseURL: URL(string: identity.server)!, path: path) }
            }
            try rejects { _ = try HBSiriPolicy.endpoint(baseURL: URL(string: "https://user:pass@example.test")!, path: "/api/siri/catalog") }
        }
        try passes("failure/unknown result never becomes a success dialog") {
            for state in ["failed", "unknown", "invalid"] {
                try rejects { _ = try HBSiriPolicy.dialog(HBSiriCommandResult(success: false, requestId: "1", state: state, message: "Not complete")) }
            }
        }
        do {
            let (client, credentials) = makeClient { request in
                if request.value(forHTTPHeaderField: "Authorization") == "Bearer test-access-token" { return (401, Data()) }
                return (200, Samples.catalogData)
            }
            let (catalog, _) = try await client.catalog()
            try check(catalog.accountId == "u1" && credentials.refreshes == 1, "401 refresh")
            try check(MockURLProtocol.fixture.captured().count == 2, "unexpected retries")
            tests += 1; print("PASS expired token refreshes once")
        }
        do {
            let (client, credentials) = makeClient { _ in (401, Data()) }
            try await rejectsAsync { _ = try await client.catalog() }
            try check(credentials.refreshes == 1 && MockURLProtocol.fixture.captured().count == 2, "401 loop")
            tests += 1; print("PASS second 401 stops")
        }
        do {
            let (client, credentials) = makeClient { _ in (403, Data("{\"error\":\"Permission denied\"}".utf8)) }
            try await rejectsAsync { _ = try await client.catalog() }
            try check(credentials.refreshes == 0 && MockURLProtocol.fixture.captured().count == 1, "403 refresh")
            tests += 1; print("PASS permission denial does not refresh or sign out")
        }
        do {
            let (client, _) = makeClient { request in
                if request.httpMethod != "POST" { return (200, Samples.catalogData) }
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                guard body["kind"] as? String == "workflow", body["targetId"] as? String == "w1", body["action"] as? String == "run", body["accountId"] as? String == "u1" else { throw Failure(description: "wrong command") }
                return (200, Samples.result(id: body["requestId"] as! String))
            }
            try check(try await client.execute(identity: encoded, action: "run") == "Finished Night TV.", "workflow dialog")
            let requests = MockURLProtocol.fixture.captured()
            try check(requests.count == 2 && requests.allSatisfy { $0.url!.path.hasPrefix("/homebrain/api/siri/") }, "endpoint mismatch")
            try check(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-HomeBrain-Client-Type") == "watchos" }, "client type missing")
            tests += 1; print("PASS typed Night TV command with authenticated account and prefix")
        }
        do {
            let (client, _) = makeClient { request in
                if request.url!.path.hasSuffix("catalog") { return (200, Samples.catalogData) }
                if request.httpMethod == "POST" {
                    let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                    return (202, Samples.result(id: body["requestId"] as! String, state: "running"))
                }
                return (200, Samples.result(id: request.url!.lastPathComponent))
            }
            try check(try await client.execute(identity: encoded, action: "run") == "Finished Night TV.", "polling result")
            try check(MockURLProtocol.fixture.captured().count == 3, "poll count")
            tests += 1; print("PASS asynchronous workflow acceptance is polled to completion")
        }
        do {
            let (client, _) = makeClient { request in
                if request.httpMethod == "POST" { throw URLError(.timedOut) }
                return (200, Samples.catalogData)
            }
            try await rejectsAsync { _ = try await client.execute(identity: encoded, action: "run") }
            try check(MockURLProtocol.fixture.captured().filter { $0.httpMethod == "POST" }.count == 1, "mutation repeated")
            tests += 1; print("PASS uncertain POST timeout never blindly repeats a workflow")
        }
        do {
            let (client, _) = makeClient { request in
                if request.httpMethod != "POST" { return (200, Samples.catalogData) }
                return (200, Samples.result(id: "wrong"))
            }
            try await rejectsAsync { _ = try await client.execute(identity: encoded, action: "run") }
            tests += 1; print("PASS mismatched invocation result rejected")
        }
        do {
            let (client, _) = makeClient { _ in (200, Samples.catalogData) }
            let wrong = try HBSiriIdentity(server: "https://other.test", account: "u1", kind: "workflow", target: "w1").encoded()
            try await rejectsAsync { _ = try await client.execute(identity: wrong, action: "run") }
            try check(MockURLProtocol.fixture.captured().allSatisfy { $0.httpMethod != "POST" }, "wrong home executed")
            tests += 1; print("PASS old home shortcut cannot send a mutation")
        }
        do {
            let readOnly = try JSONEncoder().encode(HBSiriCatalog(success: true, accountId: "u1", canExecute: false, targets: [Samples.target]))
            let (client, _) = makeClient { _ in (200, readOnly) }
            try await rejectsAsync { _ = try await client.execute(identity: encoded, action: "run") }
            try check(MockURLProtocol.fixture.captured().allSatisfy { $0.httpMethod != "POST" }, "read-only mutation")
            tests += 1; print("PASS read-only account blocked before mutation")
        }
        do {
            let (client, credentials) = makeClient { _ in (200, Samples.catalogData) }
            credentials.invalidateAfterFirstValidation = true
            try await rejectsAsync { _ = try await client.catalog() }
            tests += 1; print("PASS in-flight account switch rejects the stale response")
        }
        do {
            let (client, _) = makeClient { _ in (200, Data("not JSON".utf8)) }
            try await rejectsAsync { _ = try await client.catalog() }
            tests += 1; print("PASS malformed backend response rejected")
        }
        print("Siri core: \(tests) tests passed")
    }
}
