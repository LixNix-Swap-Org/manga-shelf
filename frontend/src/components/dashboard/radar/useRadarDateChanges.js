import { useState, useEffect, useRef } from 'react';
import { withId, withoutId } from '../../../utils/radarHelpers';
import { apiFetch, readJson, TIMEOUTS } from '../../../utils/api';
import { notify, notifyResponseError } from '../../../utils/notify';

/**
 * Pre-orders whose Manga-Passion date changed; loaded once per radar visit (the server walks several months).
 * `invalidate()` reloads it the next time `enabled` is true.
 */
export default function useRadarDateChanges({ enabled, onApplied }) {
  const [changes, setChanges] = useState([]);
  const [applyingIds, setApplyingIds] = useState(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!enabled || loadedRef.current) return undefined;
    loadedRef.current = true;
    const controller = new AbortController();
    let settled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/release-radar/changes', { signal: controller.signal, timeout: TIMEOUTS.remote });
        const data = res.ok ? await readJson(res) : null;
        if (!data) {
          loadedRef.current = false;
          return;
        }
        if (!controller.signal.aborted) setChanges(data.changes || []);
      } catch (err) {
        if (err?.name !== 'AbortError') loadedRef.current = false;
      } finally {
        settled = true;
      }
    })();
    // an aborted load (StrictMode remount, tab switch before the answer) is repeated the next time it is enabled
    return () => {
      controller.abort();
      if (!settled) loadedRef.current = false;
    };
  }, [enabled, reloadToken]);

  const invalidate = () => {
    loadedRef.current = false;
    setReloadToken(t => t + 1);
  };

  const dropVolume = (volumeId) => setChanges(prev => prev.filter(c => c.volume_id !== volumeId));

  const apply = async (change) => {
    if (applyingIds.has(change.volume_id)) return;
    setApplyingIds(s => withId(s, change.volume_id));
    try {
      const res = await apiFetch(`/api/volumes/${change.volume_id}`, { method: 'PUT', body: { release_date: change.new_date } });
      if (res.ok) {
        dropVolume(change.volume_id);
        onApplied?.();
      } else {
        await notifyResponseError(res, 'Termin konnte nicht übernommen werden');
      }
    } catch (err) {
      notify.error(err);
    } finally {
      setApplyingIds(s => withoutId(s, change.volume_id));
    }
  };

  return { changes, applyingIds, apply, dropVolume, invalidate };
}
