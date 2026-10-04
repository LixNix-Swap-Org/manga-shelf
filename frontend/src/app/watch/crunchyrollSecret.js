// The Crunchyroll login of this device (etp_rt cookie, web client id, device id, account id). It lives only in the
// Keychain/Keystore, never in Preferences, the device database or a request to a Manga Shelf server; per device, so a
// server switch keeps it.
import crunchyroll from '../../../../core/watch/crunchyroll.js';
import { t } from '../../i18n/index.js';

export const SECRET_KEY = 'watch-secret:crunchyroll';
// KeychainAccess.whenUnlockedThisDeviceOnly of @aparajita/capacitor-secure-storage: no iCloud, no device migration
const THIS_DEVICE_ONLY = 1;

const accessOf = (bridge) => bridge?.constants?.KeychainAccess?.whenUnlockedThisDeviceOnly ?? THIS_DEVICE_ONLY;

/** The stored secret or null (missing, damaged, or unreadable after a passcode change: all count as not connected). */
export async function readSecret(bridge) {
  let value;
  try {
    value = await bridge.plugins.SecureStorage.get(SECRET_KEY, false, false);
  } catch (_) {
    return null;
  }
  return value ? crunchyroll.parseSecret(value) : null;
}

/** Stores the secret (checked by core/watch/crunchyroll.js parseSecret) with this-device-only access, never synced. */
export async function writeSecret(bridge, secret, now = Date.now()) {
  const value = crunchyroll.parseSecret({ ...secret, saved_at: now });
  if (!value) throw new TypeError(t('Crunchyroll-Anmeldung unvollständig'));
  await bridge.plugins.SecureStorage.set(SECRET_KEY, value, false, false, accessOf(bridge));
  return value;
}

export async function deleteSecret(bridge) {
  try {
    await bridge.plugins.SecureStorage.remove(SECRET_KEY, false);
  } catch (_) { /* already gone */ }
}

export const hasSecret = async (bridge) => Boolean(await readSecret(bridge));
