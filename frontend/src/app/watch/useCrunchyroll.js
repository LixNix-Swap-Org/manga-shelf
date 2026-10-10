import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { hasSecret } from './crunchyrollSecret';
import { connectCrunchyroll, disconnectCrunchyroll, syncNow, isSyncRunning, subscribeRunning } from './crunchyrollSync';
import { readState, patchState, subscribeState, watchBridge, desktopCall, readSkipped, clearSkipped } from './watchState';

const REASONS = ['unavailable', 'locked', 'unreadable'];

async function loginStatus(bridge) {
  if (bridge.kind !== 'desktop') return { connected: await hasSecret(bridge), available: true, reason: null };
  const status = await desktopCall(bridge, 'status').catch(() => ({ available: false, reason: 'unreadable', connected: false }));
  const available = status.available !== false;
  return { connected: Boolean(status.connected), available, reason: available ? null : REASONS.includes(status.reason) ? status.reason : 'unreadable' };
}

const autoAddOf = (answer) => (typeof answer?.watch?.auto_add === 'boolean' ? answer.watch.auto_add : null);

// The settings card's view of the sync: { loading, enabled, connected, available, reason, state, skipped, autoAdd } (the secret
// never enters React state) and its actions. `busy` names the running action ('toggle', 'connect', 'sync', 'disconnect', 'unskip',
// 'autoAdd'); `running` is true while any sync runs, also the automatic one.
export default function useCrunchyroll({ bridge = watchBridge() } = {}) {
  const [view, setView] = useState({ loading: true, enabled: false, connected: false, available: true, reason: null, state: {}, skipped: 0 });
  const [autoAdd, setAutoAddValue] = useState(null);
  const [busy, setBusy] = useState(null);
  const [running, setRunning] = useState(isSyncRunning);
  const mounted = useRef(true);

  const load = useCallback(async (known) => {
    if (!bridge) return;
    const [state, login, skipped] = await Promise.all([
      known ? Promise.resolve(known) : readState(bridge), loginStatus(bridge), readSkipped(bridge)
    ]);
    if (mounted.current) setView({ loading: false, enabled: Boolean(state.enabled), ...login, state, skipped: skipped.length });
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

  useEffect(() => {
    if (!bridge) return undefined;
    let active = true;
    api.get('/api/anime/sync')
      .then((answer) => { if (active) setAutoAddValue(autoAddOf(answer)); })
      .catch(() => {});
    return () => { active = false; };
  }, [bridge]);

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

  const setAutoAdd = useCallback((on) => act('autoAdd', async () => {
    const value = autoAddOf(await api.put('/api/anime/sync', { watch: { auto_add: Boolean(on) } }));
    if (value !== null && mounted.current) setAutoAddValue(value);
  }), [act]);

  return {
    ...view, platform: bridge?.platform ?? null, autoAdd, busy, running, setEnabled, connect, sync, disconnect, unskip, setAutoAdd
  };
}
