import { useCallback, useEffect, useRef, useState } from 'react';
import useAccountDefaults, { rememberAccountDefaults } from './useAccountDefaults';
import { apiFetch, getApiBase, isLocalMode, readJson } from '../utils/api';
import { compareVersions, isVersion } from '../utils/whatsNew.js';
import { APP_VERSION } from '../components/dashboard/dashboardShell';

// "Was ist neu": which version's news this account has seen. The server keeps it per account (users.whats_new_seen,
// PUT /api/auth/profile), so the hint after an update shows once on any device. A server before 4.3 has no such field:
// then this device remembers it per server. "Später" hides the hint for this browser session only.
const DEVICE_KEY = 'mangashelf_whats_new_seen';
const LATER_KEY = 'mangashelf_whats_new_later';

const deviceKey = () => `${DEVICE_KEY}:${isLocalMode() ? 'local' : getApiBase() || 'web'}`;

function readStorage(storage, key) {
  try { return globalThis[storage]?.getItem(key) ?? null; } catch (_) { return null; }
}

function writeStorage(storage, key, value) {
  try { globalThis[storage]?.setItem(key, value); } catch (_) { /* storage unavailable */ }
}

/**
 * `{ ready, current, seen, unseen, later, markSeen, putOff }` for the signed-in account. `unseen` is true while the app
 * is newer than the last version the account saw. A new account (no version yet) takes the running version without a
 * hint; an older app than the one seen (after going back) shows nothing. `enabled: false` (offline copy) asks nothing.
 */
export default function useWhatsNew({ user, enabled = true } = {}) {
  const active = enabled && Boolean(user) && !user?.offline;
  const defaults = useAccountDefaults({ enabled: active });
  const current = isVersion(APP_VERSION) ? APP_VERSION : null;
  const [deviceSeen, setDeviceSeen] = useState(() => readStorage('localStorage', deviceKey()));
  const [later, setLater] = useState(() => readStorage('sessionStorage', LATER_KEY) === APP_VERSION);
  const saving = useRef(null);

  const ready = active && defaults.loaded && Boolean(current);
  const seen = defaults.whatsNewKnown ? defaults.whatsNewSeen : deviceSeen;

  const markSeen = useCallback(async () => {
    if (!current || saving.current === current) return;
    saving.current = current;
    try {
      if (!defaults.whatsNewKnown) {
        writeStorage('localStorage', deviceKey(), current);
        setDeviceSeen(current);
        return;
      }
      const res = await apiFetch('/api/auth/profile', { method: 'PUT', body: { whats_new_seen: current } });
      const data = res.ok ? await readJson(res) : null;
      if (data?.user) rememberAccountDefaults(data.user);
    } catch (_) {
      // offline or refused: the hint comes again next time
    } finally {
      if (saving.current === current) saving.current = null;
    }
  }, [current, defaults.whatsNewKnown]);

  // a new account, or a device that never kept a version for an older server: start at the running version
  useEffect(() => {
    if (ready && !isVersion(seen)) markSeen();
  }, [ready, seen, markSeen]);

  const putOff = useCallback(() => {
    writeStorage('sessionStorage', LATER_KEY, APP_VERSION);
    setLater(true);
  }, []);

  const unseen = ready && isVersion(seen) && compareVersions(current, seen) > 0;
  return { ready, current, seen: isVersion(seen) ? seen : null, unseen, later, markSeen, putOff };
}
