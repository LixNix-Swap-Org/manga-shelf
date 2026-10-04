import { useCallback, useEffect, useRef, useState } from 'react';
import { hasSecret } from './crunchyrollSecret';
import { connectCrunchyroll, disconnectCrunchyroll, syncNow, isSyncRunning, subscribeRunning } from './crunchyrollSync';
import { readState, patchState, subscribeState, watchBridge, readSkipped, clearSkipped } from './watchState';

/**
 * The settings card's view of the sync: { loading, enabled, connected, state, skipped } (the secret itself never enters
 * React state) and its actions. `busy` names the running action ('toggle', 'connect', 'sync', 'disconnect', 'unskip');
 * `running` is true while any sync runs, also the automatic one.
 */
export default function useCrunchyroll({ bridge = watchBridge() } = {}) {
  const [view, setView] = useState({ loading: true, enabled: false, connected: false, state: {}, skipped: 0 });
  const [busy, setBusy] = useState(null);
  const [running, setRunning] = useState(isSyncRunning);
  const mounted = useRef(true);

  const load = useCallback(async (known) => {
    if (!bridge) return;
    const [state, connected, skipped] = await Promise.all([
      known ? Promise.resolve(known) : readState(bridge), hasSecret(bridge), readSkipped(bridge)
    ]);
    if (mounted.current) setView({ loading: false, enabled: Boolean(state.enabled), connected, state, skipped: skipped.length });
  }, [bridge]);

  useEffect(() => {
    mounted.current = true;
    load().catch(() => { if (mounted.current) setView((v) => ({ ...v, loading: false })); });
    const stop = subscribeState((state) => { load(state).catch(() => {}); });
    const stopRunning = subscribeRunning((on) => { if (mounted.current) setRunning(on); });
    setRunning(isSyncRunning());
    return () => {
      mounted.current = false;
      stop();
      stopRunning();
    };
  }, [load]);

  const act = useCallback(async (name, fn) => {
    setBusy(name);
    try {
      return await fn();
    } catch (_) {
      // the error text is in the state (shown by the card)
      return null;
    } finally {
      if (mounted.current) setBusy(null);
      await load().catch(() => {});
    }
  }, [load]);

  const setEnabled = useCallback((on) => act('toggle', () => (on
    ? patchState(bridge, { enabled: true })
    : disconnectCrunchyroll({ bridge, optOut: true }))), [act, bridge]);

  const connect = useCallback(() => act('connect', async () => {
    const result = await connectCrunchyroll({ bridge });
    if (result?.connected) {
      setBusy('sync');
      await syncNow({ bridge });
    }
    return result;
  }), [act, bridge]);

  const sync = useCallback(() => act('sync', () => syncNow({ bridge })), [act, bridge]);
  const disconnect = useCallback(() => act('disconnect', () => disconnectCrunchyroll({ bridge })), [act, bridge]);
  const unskip = useCallback(() => act('unskip', () => clearSkipped(bridge)), [act, bridge]);

  return { ...view, busy, running, setEnabled, connect, sync, disconnect, unskip };
}
