// "Bei anderen vorhanden": volumes other users own in series I also collect, with "Ich habe ihn auch" (split from
// ShoppingListView.jsx).
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { FROM_SHOPPING, ListProgress } from './ShoppingSections';
import { t } from '../../../i18n/index.js';

export default function OthersOwnSection({ pages, claiming, claimErrors, canEdit, isOfflineMode, onClaim }) {
  return (
    <div className="mt-8">
      <h3 className="text-sm font-bold text-slate-200 mb-1">{t('Bei anderen vorhanden')}</h3>
      <p className="text-xs text-slate-400 mb-3">{t('Diese Bände besitzen andere Nutzer in Reihen, die du auch sammelst.')}</p>
      <ul className="divide-y divide-slate-800/80 rounded-2xl border border-slate-800 bg-slate-950/60">
        {pages.visible.map(item => {
          const busy = claiming.has(item.id);
          return (
            <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs [content-visibility:auto] [contain-intrinsic-block-size:auto_48px]">
              <div className="min-w-0">
                <Link to={`/manga/${item.manga_id}`} state={FROM_SHOPPING} className="font-semibold text-slate-100 hover:text-brand-300 truncate block">
                  {item.manga_title} {getVolumeDisplayTitle({ volume_number: item.volume_number, type: item.type, notes: item.notes })}
                </Link>
                <span className="text-slate-400">{t('Besitzt: {owners}', { owners: item.owned_by_others })}</span>
                {claimErrors[item.id] && <span className="block text-rose-300" role="alert">{claimErrors[item.id]}</span>}
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onClaim(item)}
                  disabled={busy || isOfflineMode}
                  aria-busy={busy || undefined}
                  className="shrink-0 px-2.5 py-1 rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-700 hover:text-white font-semibold disabled:opacity-50 disabled:hover:bg-transparent flex items-center gap-1"
                  title={isOfflineMode ? t('Nur online möglich') : t('Ich besitze diesen Band auch')}
                >
                  {busy && <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />}
                  {t('Ich habe ihn auch')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {pages.hasMore && (
        <ListProgress shown={pages.shown} total={pages.total} onMore={pages.showMore} sentinelRef={pages.sentinelRef} />
      )}
    </div>
  );
}
