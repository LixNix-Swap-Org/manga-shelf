import Foundation
import Capacitor
import UIKit

/// Hands what the ShareToMangaShelf extension left in the App Group to JS; link detection happens in JS.
@objc(SharedInboxPlugin)
public class SharedInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedInboxPlugin"
    public let jsName = "SharedInbox"
    public let pluginMethods: [CAPPluginMethod] = []

    static let suiteName = "group.de.mangashelf.app"
    static let key = "pendingShares"

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(drain),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
        drain()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func drain() {
        guard let defaults = UserDefaults(suiteName: Self.suiteName),
              let items = defaults.array(forKey: Self.key), !items.isEmpty else { return }
        defaults.removeObject(forKey: Self.key)
        for case let item as [String: Any] in items {
            // retained until the first JS listener subscribes (cold start)
            notifyListeners("shareReceived", data: [
                "text": item["text"] as? String ?? "",
                "url": item["url"] as? String ?? ""
            ], retainUntilConsumed: true)
        }
    }
}
