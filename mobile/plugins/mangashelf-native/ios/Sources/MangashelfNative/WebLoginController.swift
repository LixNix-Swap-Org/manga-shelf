import Foundation
import UIKit
import WebKit

/// Modal sign-in page. Its WKWebsiteDataStore lives in memory only and is separate from the app's WebView, so
/// dropping the controller is the wipe.
final class WebLoginController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIAdaptivePresentationControllerDelegate {
    struct Options {
        let url: URL
        let cookieDomain: String
        let cookieName: String
        let pathNotContaining: String
        let readScript: String?
        let title: String
        let cancelLabel: String
    }

    enum Outcome {
        case success(value: String, expires: Double?, scriptResult: String?)
        case cancelled
    }

    private let options: Options
    private let completion: (Outcome) -> Void
    private var store: WKWebsiteDataStore?
    private var webView: WKWebView?
    private var timer: Timer?
    private var checking = false
    private var finished = false

    init(options: Options, completion: @escaping (Outcome) -> Void) {
        self.options = options
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    func present(from presenter: UIViewController) {
        let nav = UINavigationController(rootViewController: self)
        nav.modalPresentationStyle = .pageSheet
        nav.presentationController?.delegate = self
        var top = presenter
        while let next = top.presentedViewController { top = next }
        top.present(nav, animated: true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = options.title
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: options.cancelLabel, style: .plain, target: self, action: #selector(cancelTapped))

        let store = WKWebsiteDataStore.nonPersistent()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        // the stock WebKit name plus Safari's suffix: some sign-in pages refuse a bare WKWebView
        let version = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        config.applicationNameForUserAgent = "Version/\(version) Mobile/15E148 Safari/604.1"
        let webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        view.addSubview(webView)
        self.store = store
        self.webView = webView
        webView.load(URLRequest(url: options.url))
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.check() }
    }

    @objc private func cancelTapped() {
        finish(.cancelled)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(.cancelled)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        check()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        decisionHandler(["https", "about", "blob", "data"].contains(scheme) ? .allow : .cancel)
    }

    // popups (window.open, target=_blank) load in the same view instead of a second WebView
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    private func check() {
        guard !finished, !checking, let webView = webView, let url = webView.url,
              WebLoginPlugin.hostMatches(url.host, domain: options.cookieDomain),
              !url.path.lowercased().contains(options.pathNotContaining.lowercased()) else { return }
        checking = true
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self else { return }
            let match = cookies.first { cookie in
                let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                return cookie.name == self.options.cookieName && WebLoginPlugin.hostMatches(domain, domain: self.options.cookieDomain)
                    && !cookie.value.isEmpty
            }
            guard let cookie = match else {
                self.checking = false
                return
            }
            let expires = cookie.expiresDate.map { ($0.timeIntervalSince1970 * 1000).rounded() }
            guard let script = self.options.readScript, !script.isEmpty else {
                self.finish(.success(value: cookie.value, expires: expires, scriptResult: nil))
                return
            }
            let wrapped = "(function(){try{var v=(\(script));return v==null?null:String(v);}catch(e){return null;}})()"
            webView.evaluateJavaScript(wrapped) { [weak self] result, _ in
                self?.finish(.success(value: cookie.value, expires: expires, scriptResult: result as? String))
            }
        }
    }

    private func finish(_ outcome: Outcome) {
        guard !finished else { return }
        finished = true
        timer?.invalidate()
        timer = nil
        if let webView = webView {
            webView.stopLoading()
            webView.navigationDelegate = nil
            webView.uiDelegate = nil
        }
        store?.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
        let done = completion
        if let presenting = navigationController?.presentingViewController {
            presenting.dismiss(animated: true)
        }
        webView = nil
        store = nil
        done(outcome)
    }
}
