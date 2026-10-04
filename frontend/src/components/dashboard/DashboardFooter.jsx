import { useEffect, useState } from 'react';
import { Download, WifiOff, CircleCheck, Clock, ShieldAlert, HardDrive, TriangleAlert } from 'lucide-react';
import { formatAge } from '../../utils/offlineStore';
import { APP_VERSION } from './dashboardShell';
import { formatCount } from '../../utils/format';
import { needsHttps } from '../../hooks/usePwaInstall';
import { isAppMode, isLocalMode } from '../../utils/api';
import { loadedLocalRuntime } from '../../local/localTransport';
import { LOCAL_STORE_EVENT } from '../../local/store';
import { useOutboxPending } from '../../app/useOutbox';
import ConnectQr from '../common/ConnectQr';
import { t as tr } from '../../i18n/index.js';

export const HTTPS_GUIDE_URL = 'https://github.com/LixNix-Swap-Org/manga-shelf#6-https--eigene-domain-reverse-proxy-mit-nginx-oder-caddy';

/** "41 MB" for the storage this origin uses (offline copy, covers, app files); '' when unknown. */
export function formatStorageUsage(bytes) {
  const mb = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(mb) || mb <= 0) return '';
  return mb < 1 ? '< 1 MB' : `${Math.round(mb)} MB`;
}

/** "Ausstehend: …" text: purchases by name, a mix of changes as "Änderungen". */
export function pendingLabel(total, purchases) {
  return total > purchases ? formatCount(total, 'Änderung', 'Änderungen') : formatCount(total, 'Kauf', 'Käufe');
}

/** Save state of the device database in standalone mode: { error, savedAt } from the runtime's status and events. */
function useDeviceSaveState(active) {
  const [state, setState] = useState({ error: null, savedAt: null });
  useEffect(() => {
    if (!active) return undefined;
    const read = (status) => {
      if (!status) return;
      setState((prev) => ({ error: status.saveError || null, savedAt: status.savedAt ?? prev.savedAt }));
    };
    try { read(loadedLocalRuntime()?.status?.()); } catch (_) { /* runtime closing */ }
    const onStore = (event) => read(event.detail?.status);
    window.addEventListener(LOCAL_STORE_EVENT, onStore);
    return () => window.removeEventListener(LOCAL_STORE_EVENT, onStore);
  }, [active]);
  return state;
}

/** Footer with app version, connection state, offline copy refresh, PWA install and the QR code for the apps. */
export default function DashboardFooter({
  user, isOfflineMode, networkOffline, offlineCopyAt, refreshingCopy, refreshError, handleRefreshOfflineCopy,
  pendingPurchases = 0, isInstallable, isInstalledApp, handleInstallClick
}) {
  // formatAge depends on the clock, not only on props
  const [, setTick] = useState(0);
  const [storageUsed, setStorageUsed] = useState('');
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  const showHttpsGuide = user?.role === 'admin' && needsHttps();
  const outbox = useOutboxPending(user?.id ?? null);
  const pendingTotal = Math.max(outbox.total, pendingPurchases);
  const pendingBuys = Math.max(outbox.purchases, pendingPurchases);
  const showConnectQr = !isAppMode() && !user?.offline && (user?.role === 'admin' || user?.role === 'editor');
  // standalone mode: no server to sync with, the footer shows the device database instead
  const onDevice = Boolean(user?.local) || isLocalMode();
  const device = useDeviceSaveState(onDevice);
  const ticking = onDevice ? device.savedAt : offlineCopyAt;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    let active = true;
    const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (!offlineCopyAt || onDevice || typeof storage?.estimate !== 'function') {
      setStorageUsed('');
      return undefined;
    }
    storage.estimate()
      .then(({ usage }) => { if (active) setStorageUsed(formatStorageUsage(usage)); })
      .catch(() => {});
    return () => { active = false; };
  }, [offlineCopyAt, onDevice]);

  return (
<footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-xs text-slate-400 border-t border-slate-800/60 mt-12 flex flex-col sm:flex-row items-center justify-between gap-3">
  <div className="flex items-center gap-2">
    <span className="font-semibold text-slate-400">{tr('Manga Shelf')}</span>
    <span className="text-slate-500" aria-hidden="true">•</span>
    <span className="inline-flex items-center gap-1 font-mono text-[11px] bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded-md border border-slate-700/60">{/* i18n-ignore: version number */}
      v{APP_VERSION}
    </span>
  </div>
  <div className="flex flex-wrap items-center justify-center gap-3 text-slate-400">
    {onDevice ? (
      <>
        <span className="inline-flex items-center gap-1.5 text-slate-300 font-medium bg-slate-800/80 px-2.5 py-1 rounded-full border border-slate-700/60">
          <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
          {tr('Auf diesem Gerät')}{user?.username ? ` · ${user.username}` : ''}
        </span>
        {device.error ? (
          <span role="status" className="inline-flex items-center gap-1.5 text-amber-300 font-medium">
            <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
            {tr('Nicht gespeichert')}
          </span>
        ) : device.savedAt ? (
          <span className="text-slate-400">{tr('Gespeichert {age}', { age: formatAge(device.savedAt) })}</span>
        ) : null}
      </>
    ) : isOfflineMode ? (
      <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
        <WifiOff className="w-3.5 h-3.5" />
        {tr('Offline-Modus aktiv')}
      </span>
    ) : pendingTotal > 0 ? (
      <span className="inline-flex items-center gap-1.5 text-amber-300 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
        <Clock className="w-3.5 h-3.5" />
        {tr('Ausstehend: {changes}', { changes: pendingLabel(pendingTotal, pendingBuys) })}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
        <CircleCheck className="w-3.5 h-3.5" />
        {tr('Online & abgeglichen')}
      </span>
    )}
    {!user?.offline && !onDevice && (
      <button
        type="button"
        onClick={handleRefreshOfflineCopy}
        disabled={refreshingCopy || networkOffline}
        className="hit-44 inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default"
        title={tr('Lädt die gesamte Sammlung für die Offline-Ansicht neu')}
      >
        <Download className="w-3.5 h-3.5" />
        {refreshingCopy
          ? tr('Aktualisiere...')
          : offlineCopyAt
            ? (storageUsed
              ? tr('Offline-Kopie: {age}, {size} – aktualisieren', { age: formatAge(offlineCopyAt), size: storageUsed })
              : tr('Offline-Kopie: {age} – aktualisieren', { age: formatAge(offlineCopyAt) }))
            : tr('Offline-Kopie erstellen')}
      </button>
    )}
    {refreshError && !refreshingCopy && !onDevice && (
      <span role="status" className="text-amber-400">{refreshError}</span>
    )}
    {showHttpsGuide ? (
      <a
        id="footer-https-guide"
        href={HTTPS_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-amber-300 hover:text-amber-200 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20"
      >
        <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
        {tr('Offline-Modus, App-Installation und Live-Scanner brauchen HTTPS – Anleitung')}
      </a>
    ) : insecure && (
      <span className="text-slate-400">{tr('Offline-Start und App-Installation nur über HTTPS')}</span>
    )}
    {showConnectQr && <ConnectQr />}
    {isInstallable && !isInstalledApp && (
      <button
        type="button"
        onClick={handleInstallClick}
        className="hit-44 inline-flex items-center gap-1.5 text-brand-400 hover:text-brand-300 font-medium hover:underline cursor-pointer transition-colors"
      >
        <Download className="w-3.5 h-3.5" />
        {tr('App installieren')}
      </button>
    )}
  </div>
</footer>
  );
}
