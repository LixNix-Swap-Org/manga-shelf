import UIKit
import UniformTypeIdentifiers

/// Share sheet target: leaves { url, text, at } in the App Group for the app's SharedInbox and closes again. It never
/// opens the app (the responder-chain openURL trick is an App Review risk); the app confirms on its next start.
final class ShareViewController: UIViewController {
    static let suiteName = "group.de.mangashelf.app"
    static let key = "pendingShares"
    static let cap = 20
    static let maxText = 4000

    private let label = UILabel()
    private let icon = UIImageView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .systemGreen
        icon.contentMode = .scaleAspectFit
        icon.isAccessibilityElement = false
        label.translatesAutoresizingMaskIntoConstraints = false
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = UIFont.preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        let stack = UIStackView(arrangedSubviews: [icon, label])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            icon.heightAnchor.constraint(equalToConstant: 44),
            icon.widthAnchor.constraint(equalToConstant: 44),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        collect { [weak self] url, text in
            guard let self = self else { return }
            let stored = (url != nil || text != nil) && Self.store(url: url, text: text)
            self.icon.image = UIImage(systemName: stored ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
            self.icon.tintColor = stored ? .systemGreen : .systemOrange
            self.label.text = stored
                ? "An Manga Shelf übergeben – beim nächsten Öffnen bestätigen"
                : "Kein Link gefunden – nichts übergeben"
            UIAccessibility.post(notification: .announcement, argument: self.label.text)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }
    }

    private func collect(_ done: @escaping (String?, String?) -> Void) {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let group = DispatchGroup()
        let lock = NSLock()
        var url: String?
        var text: String?
        func keep(url found: String?) {
            guard let found = found, let scheme = URL(string: found)?.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
            lock.lock()
            if url == nil { url = found }
            lock.unlock()
        }
        func keep(text found: String?) {
            guard let found = found?.trimmingCharacters(in: .whitespacesAndNewlines), !found.isEmpty else { return }
            lock.lock()
            if text == nil { text = found }
            lock.unlock()
        }
        for item in items {
            keep(text: item.attributedContentText?.string)
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
                        keep(url: (value as? URL)?.absoluteString ?? (value as? String))
                        group.leave()
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
                        keep(text: value as? String)
                        group.leave()
                    }
                }
            }
        }
        group.notify(queue: .main) { done(url, text) }
    }

    static func store(url: String?, text: String?) -> Bool {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return false }
        var list = defaults.array(forKey: key) as? [[String: Any]] ?? []
        list.append([
            "url": String((url ?? "").prefix(2048)),
            "text": String((text ?? "").prefix(maxText)),
            "at": (Date().timeIntervalSince1970 * 1000).rounded()
        ])
        if list.count > cap { list.removeFirst(list.count - cap) }
        defaults.set(list, forKey: key)
        return true
    }
}
