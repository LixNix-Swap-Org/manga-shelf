import Foundation
import Capacitor
import UIKit

/// Isolated sign-in (in-memory WKWebsiteDataStore) and cookie-less requests; parsing stays in the app's JS.
@objc(WebLoginPlugin)
public class WebLoginPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebLoginPlugin"
    public let jsName = "WebLogin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
    ]

    static let cookieDomains: Set<String> = ["crunchyroll.com"]
    static let requestHosts: Set<String> = ["www.crunchyroll.com", "beta-api.crunchyroll.com"]

    private var active: WebLoginController?

    static func hostMatches(_ host: String?, domain: String) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == domain || host.hasSuffix("." + domain)
    }

    @objc func open(_ call: CAPPluginCall) {
        let domain = (call.getString("cookieDomain") ?? "").lowercased()
        let cookieName = call.getString("cookieName") ?? ""
        let pathNotContaining = call.getObject("doneWhen")?["pathNotContaining"] as? String ?? ""
        guard Self.cookieDomains.contains(domain), !cookieName.isEmpty, !pathNotContaining.isEmpty,
              let url = URL(string: call.getString("url") ?? ""), url.scheme == "https",
              Self.hostMatches(url.host, domain: domain) else {
            call.reject("not_allowed", "not_allowed")
            return
        }
        let options = WebLoginController.Options(
            url: url, cookieDomain: domain, cookieName: cookieName, pathNotContaining: pathNotContaining,
            readScript: call.getString("readScript"), title: call.getString("title") ?? "Bei Crunchyroll anmelden",
            cancelLabel: call.getString("cancelLabel") ?? "Abbrechen")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.active == nil, let presenter = self.bridge?.viewController else {
                call.reject("busy", "busy")
                return
            }
            let controller = WebLoginController(options: options) { [weak self] outcome in
                self?.active = nil
                switch outcome {
                case .success(let value, let expires, let scriptResult):
                    call.resolve([
                        "cookie": ["value": value, "expires": expires.map { $0 as Any } ?? NSNull()],
                        "scriptResult": scriptResult.map { $0 as Any } ?? NSNull()
                    ])
                case .cancelled:
                    call.reject("cancelled", "cancelled")
                }
            }
            self.active = controller
            controller.present(from: presenter)
        }
    }

    @objc func request(_ call: CAPPluginCall) {
        let method = (call.getString("method") ?? "GET").uppercased()
        guard let url = URL(string: call.getString("url") ?? ""), url.scheme == "https",
              let host = url.host?.lowercased(), Self.requestHosts.contains(host),
              method == "GET" || method == "POST" else {
            call.reject("not_allowed", "not_allowed")
            return
        }
        var headers: [String: String] = [:]
        for (key, value) in call.getObject("headers") ?? [:] {
            if let text = value as? String { headers[key] = text }
        }
        WebLoginRequest.send(url: url, method: method, headers: headers, body: call.getString("body")) { result in
            switch result {
            case .success(let response):
                call.resolve(response)
            case .failure(let error):
                call.reject(error.localizedDescription, "network")
            }
        }
    }
}
