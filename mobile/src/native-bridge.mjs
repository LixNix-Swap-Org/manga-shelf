// Bundled by scripts/prepare-web.js into www/native-bridge.js (a classic script that runs before the app's module):
// the Capacitor plugins the app build uses, as window.mangashelfNative. The frontend has no Capacitor dependency;
// frontend/src/app/shell/capacitor.js and frontend/src/local/capacitor.js feature-detect this object.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

export const BRIDGE_VERSION = 1;

export function createBridge() {
  return Object.freeze({
    version: BRIDGE_VERSION,
    platform: Capacitor.getPlatform(),
    convertFileSrc: (uri) => Capacitor.convertFileSrc(uri),
    plugins: Object.freeze({
      App, Browser, Filesystem, Haptics, Network, Preferences, Share, StatusBar, SecureStorage, BarcodeScanner, CapacitorHttp
    }),
    constants: Object.freeze({ Directory, Encoding, ImpactStyle, NotificationType, StatusBarStyle: Style, BarcodeFormat })
  });
}

if (typeof globalThis.window !== 'undefined' && Capacitor.isNativePlatform()) {
  globalThis.window.mangashelfNative = createBridge();
}
