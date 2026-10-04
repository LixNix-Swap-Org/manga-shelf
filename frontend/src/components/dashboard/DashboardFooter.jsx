import { useEffect, useState } from 'react';
import { Download, WifiOff, CircleCheck, Clock, ShieldAlert } from 'lucide-react';
import { formatAge } from '../../utils/offlineStore';
import { APP_VERSION } from './dashboardShell';
import { formatCount } from '../../utils/format';
import { needsHttps } from '../../hooks/usePwaInstall';

export const HTTPS_GUIDE_URL = 'https://github.com/MoltresHD/manga-shelf#6-https--eigene-domain-reverse-proxy-mit-nginx-oder-caddy';

/** "41 MB" for the storage this origin uses (offline copy, covers, app files); '' when unknown. */
export function formatStorageUsage(bytes) {
  const mb = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(mb) || mb <= 0) return '';
  return mb < 1 ? '< 1 MB' : `${Math.round(mb)} MB`;
}

/** Footer with app version, connection state, offline copy refresh and PWA install. */
export default function DashboardFooter({
  user, isOfflineMode, networkOffline, offlineCopyAt, refreshingCopy, refreshError, handleRefreshOfflineCopy,
  pendingPurchases = 0, isInstallable, isInstalledApp, handleInstallClick
}) {
  // formatAge depends on the clock, not only on props
  const [, setTick] = useState(0);
  const [storageUsed, setStorageUsed] = useState('');
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  const showHttpsGuide = user?.role === 'admin' && needsHttps();
  useEffect(() => {
    if (!offlineCopyAt) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, [offlineCopyAt]);

  useEffect(() => {
    let active = true;
    const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (!offlineCopyAt || typeof storage?.estimate !== 'function') {
      setStorageUsed('');
      return undefined;
    }
    storage.estimate()
      .then(({ usage }) => { if (active) setStorageUsed(formatStorageUsage(usage)); })
      .catch(() => {});
    return () => { active = false; };
  }, [offlineCopyAt]);

  return (
<footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-xs text-slate-400 border-t border-slate-800/60 mt-12 flex flex-col sm:flex-row items-center justify-between gap-3">
  <div className="flex items-center gap-2">
    <span className="font-semibold text-slate-400">Manga Shelf</span>
    <span className="text-slate-500" aria-hidden="true">•</span>
    <span className="inline-flex items-center gap-1 font-mono text-[11px] bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded-md border border-slate-700/60">
      v{APP_VERSION}
    </span>
  </div>
  <div className="flex flex-wrap items-center justify-center gap-3 text-slate-400">
    {isOfflineMode ? (
      <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
        <WifiOff className="w-3.5 h-3.5" />
        Offline-Modus aktiv
      </span>
    ) : pendingPurchases > 0 ? (
      <span className="inline-flex items-center gap-1.5 text-amber-300 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
        <Clock className="w-3.5 h-3.5" />
        Ausstehend: {formatCount(pendingPurchases, 'Kauf', 'Käufe')}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
        <CircleCheck className="w-3.5 h-3.5" />
        Online & abgeglichen
      </span>
    )}
    {!user?.offline && (
      <button
        type="button"
        onClick={handleRefreshOfflineCopy}
        disabled={refreshingCopy || networkOffline}
        className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default"
        title="Lädt die gesamte Sammlung für die Offline-Ansicht neu"
      >
        <Download className="w-3.5 h-3.5" />
        {refreshingCopy
          ? 'Aktualisiere...'
          : offlineCopyAt
            ? `Offline-Kopie: ${formatAge(offlineCopyAt)}${storageUsed ? `, ${storageUsed}` : ''} – aktualisieren`
            : 'Offline-Kopie erstellen'}
      </button>
    )}
    {refreshError && !refreshingCopy && (
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
        Offline-Modus, App-Installation und Live-Scanner brauchen HTTPS – Anleitung
      </a>
    ) : insecure && (
      <span className="text-slate-400">Offline-Start und App-Installation nur über HTTPS</span>
    )}
    {isInstallable && !isInstalledApp && (
      <button
        type="button"
        onClick={handleInstallClick}
        className="inline-flex items-center gap-1.5 text-brand-400 hover:text-brand-300 font-medium hover:underline cursor-pointer transition-colors"
      >
        <Download className="w-3.5 h-3.5" />
        App installieren
      </button>
    )}
  </div>
</footer>
  );
}
