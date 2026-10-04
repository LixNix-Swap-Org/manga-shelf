import Foundation

/// One request without any cookie jar: nothing is stored, nothing is sent that the caller did not set, no redirects.
final class WebLoginRequest: NSObject, URLSessionTaskDelegate {
    static let timeout: TimeInterval = 20
    static let maxBytes = 8 * 1024 * 1024

    static func send(url: URL, method: String, headers: [String: String], body: String?,
                     completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let delegate = WebLoginRequest()
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body = body { request.httpBody = body.data(using: .utf8) }
        session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            if let error = error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(.failure(URLError(.badServerResponse)))
                return
            }
            let bytes = data ?? Data()
            if bytes.count > maxBytes {
                completion(.failure(URLError(.dataLengthExceedsMaximum)))
                return
            }
            var fields: [String: String] = [:]
            var lower: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                guard let name = key as? String else { continue }
                let text = "\(value)"
                fields[name] = text
                lower[name.lowercased()] = lower[name.lowercased()].map { "\($0), \(text)" } ?? text
            }
            let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).map { cookie -> [String: Any] in
                ["name": cookie.name, "value": cookie.value,
                 "expires": cookie.expiresDate.map { ($0.timeIntervalSince1970 * 1000).rounded() as Any } ?? NSNull()]
            }
            completion(.success([
                "status": http.statusCode,
                "headers": lower,
                "text": String(data: bytes, encoding: .utf8) ?? String(decoding: bytes, as: UTF8.self),
                "cookies": cookies
            ]))
        }.resume()
    }

    // a 3xx comes back as is, so the host allow-list cannot be left through a redirect
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
