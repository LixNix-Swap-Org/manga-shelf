import { useEffect, useRef } from 'react';
import { WATCH_BUILD, watchAvailable } from './watchState';

/**
 * Apps: starts the opt-in Crunchyroll history sync (crunchyrollSync.startWatchSync, loaded on demand) for a signed-in
 * user or the opened device collection, and stops it on logout, user or server change (`scopeKey`). Nothing on the web.
 */
export default function useWatchSync(user, scopeKey) {
  const userRef = useRef(user);
  userRef.current = user;
  const key = user && !user.offline && scopeKey ? `${scopeKey}:${user.id}:${user.role}` : null;
  useEffect(() => {
    if (!WATCH_BUILD) return undefined;
    if (!key || !watchAvailable()) return undefined;
    let stop = null;
    let cancelled = false;
    import('./crunchyrollSync.js')
      .then(({ startWatchSync }) => { if (!cancelled) stop = startWatchSync({ user: userRef.current }); })
      .catch((err) => console.warn('[App] Crunchyroll-Abgleich nicht geladen:', err?.message || err));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [key]);
}
