import { useState, useEffect } from 'react';
import { loadMeta, syncOfflineCopy, OFFLINE_SYNCED_EVENT } from '../utils/offlineStore';

/**
 * Network state and the offline copy. `onOnlineRef.current()` runs when the browser comes back online (a ref, so it
 * can point at functions defined after this hook). `offlineCopyAt` follows every stored snapshot and a logout.
 */
export default function useOfflineStatus({ user, onOnlineRef }) {
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);
  const isOfflineMode = networkOffline || Boolean(user?.offline);
  const [offlineCopyAt, setOfflineCopyAt] = useState(null);
  const [refreshingCopy, setRefreshingCopy] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  // Online / Offline Network Listeners
  useEffect(() => {
    const handleOnline = () => {
      setNetworkOffline(false);
      onOnlineRef.current();
    };
    const handleOffline = () => {
      setNetworkOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [onOnlineRef]);

  useEffect(() => {
    const onSynced = (event) => setOfflineCopyAt(event.detail?.synced_at ?? null);
    window.addEventListener(OFFLINE_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(OFFLINE_SYNCED_EVENT, onSynced);
  }, []);

  useEffect(() => {
    let active = true;
    // a sync that finished while loadMeta was reading must not be replaced by the older value
    loadMeta().then((meta) => {
      if (active) setOfflineCopyAt((prev) => Math.max(prev || 0, meta?.synced_at || 0) || null);
    });
    return () => { active = false; };
  }, [user?.offline]);

  const handleRefreshOfflineCopy = async () => {
    setRefreshingCopy(true);
    setRefreshError(null);
    try {
      const ok = await syncOfflineCopy({ force: true });
      if (!ok) setRefreshError('Aktualisierung fehlgeschlagen');
    } finally {
      setRefreshingCopy(false);
    }
  };

  return {
    networkOffline, setNetworkOffline, isOfflineMode, offlineCopyAt, refreshingCopy, refreshError, handleRefreshOfflineCopy
  };
}
