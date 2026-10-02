import { useState, useEffect } from 'react';
import { loadMeta, syncOfflineCopy } from '../utils/offlineStore';

/**
 * Network state and the offline copy. `onOnlineRef.current()` is called whenever the browser comes back online
 * (a ref so the caller can point it at functions that are defined after this hook).
 */
export default function useOfflineStatus({ user, onOnlineRef }) {
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);
  const isOfflineMode = networkOffline || Boolean(user?.offline);
  const [offlineCopyAt, setOfflineCopyAt] = useState(null);
  const [refreshingCopy, setRefreshingCopy] = useState(false);

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
  }, []);

  useEffect(() => {
    loadMeta().then(meta => setOfflineCopyAt(meta?.synced_at || null));
  }, [user?.offline]);

  const handleRefreshOfflineCopy = async () => {
    setRefreshingCopy(true);
    try {
      await syncOfflineCopy({ force: true });
      const meta = await loadMeta();
      setOfflineCopyAt(meta?.synced_at || null);
    } finally {
      setRefreshingCopy(false);
    }
  };

  return { networkOffline, setNetworkOffline, isOfflineMode, offlineCopyAt, refreshingCopy, handleRefreshOfflineCopy };
}
