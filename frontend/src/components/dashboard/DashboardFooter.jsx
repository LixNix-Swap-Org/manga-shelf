import { Download, WifiOff, CheckCircle2 } from 'lucide-react';
import { formatAge } from '../../utils/offlineStore';

/** Footer with app version, connection state, offline copy refresh and PWA install. */
export default function DashboardFooter({
  user, isOfflineMode, networkOffline, offlineCopyAt, refreshingCopy, handleRefreshOfflineCopy, isInstallable, isInstalledApp, handleInstallClick
}) {
  return (
<footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-xs text-slate-500 border-t border-slate-800/60 mt-12 flex flex-col sm:flex-row items-center justify-between gap-3">
  <div className="flex items-center gap-2">
    <span className="font-semibold text-slate-400">Manga Shelf</span>
    <span className="text-slate-600">•</span>
    <span className="inline-flex items-center gap-1 font-mono text-[11px] bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded-md border border-slate-700/60">
      v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2.11.0'}
    </span>
  </div>
  <div className="flex flex-wrap items-center justify-center gap-3 text-slate-400">
    {isOfflineMode ? (
      <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
        <WifiOff className="w-3.5 h-3.5" />
        Offline-Modus aktiv
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Online & Synchronisiert
      </span>
    )}
    {!user?.offline && offlineCopyAt && (
      <button
        onClick={handleRefreshOfflineCopy}
        disabled={refreshingCopy || networkOffline}
        className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default"
        title="Lädt die gesamte Sammlung für die Offline-Ansicht neu"
      >
        <Download className="w-3.5 h-3.5" />
        {refreshingCopy ? 'Aktualisiere...' : `Offline-Kopie: ${formatAge(offlineCopyAt)} – aktualisieren`}
      </button>
    )}
    {isInstallable && !isInstalledApp && (
      <button
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
