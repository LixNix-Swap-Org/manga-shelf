// Bundled by scripts/prepare-web.js into www/native-bridge.js (a classic script that runs before the app's module):
// the Capacitor plugins the app build uses, as window.mangashelfNative. The frontend has no Capacitor dependency;
// frontend/src/app/shell/capacitor.js and frontend/src/local/capacitor.js feature-detect this object.
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { StatusBar, Style } from '@capacitor/status-bar';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

export const BRIDGE_VERSION = 3;

// app-module plugin of the Android project (ShareIntentPlugin.java); iOS has no native side for it
const ShareIntent = registerPlugin('ShareIntent');
// plugins/mangashelf-native: WebLogin on both platforms, SharedInbox (share extension inbox) on iOS only
const WebLogin = registerPlugin('WebLogin');
const SharedInbox = registerPlugin('SharedInbox');
const NATIVE = new Set(['ios', 'android']);
// the TS enum carries reverse entries (0: 'whenUnlocked'); only the named values go out
const KEYCHAIN_ACCESS = Object.freeze(Object.fromEntries(Object.entries(KeychainAccess).filter(([, v]) => typeof v === 'number')));

export function createBridge() {
  const platform = Capacitor.getPlatform();
  return Object.freeze({
    version: BRIDGE_VERSION,
    platform,
    convertFileSrc: (uri) => Capacitor.convertFileSrc(uri),
    plugins: Object.freeze({
      App, AppLauncher, Browser, Filesystem, Haptics, Network, Preferences, Share, StatusBar, SecureStorage, BarcodeScanner, CapacitorHttp,
      ...(NATIVE.has(platform) ? { WebLogin } : {}),
      ...(platform === 'android' ? { ShareIntent } : {}),
      ...(platform === 'ios' ? { SharedInbox } : {})
    }),
    constants: Object.freeze({
      Directory, Encoding, ImpactStyle, NotificationType, StatusBarStyle: Style, BarcodeFormat, KeychainAccess: KEYCHAIN_ACCESS
    })
  });
}

if (typeof globalThis.window !== 'undefined' && Capacitor.isNativePlatform()) {
  globalThis.window.mangashelfNative = createBridge();
}
