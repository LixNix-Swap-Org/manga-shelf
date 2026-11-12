// The scan list of a store visit with "als gekauft abhaken" and the basket total (split from ShoppingListView.jsx).
import {
  ShoppingCart, PackageCheck, CirclePlus, CircleCheck, Users, Info, BookOpen, CircleQuestionMark, WifiOff, Clock, Check,
  TriangleExclamationPoint, X
} from 'lucide-react';
import { elsewhereText } from '../../../utils/scanHelpers';
import { formatMoney } from '../../../utils/format';
import { t } from '../../../i18n/index.js';

export const KIND_STYLE = {
  buy: [ShoppingCart, 'text-emerald-300'], claim: [PackageCheck, 'text-emerald-300'], add: [CirclePlus, 'text-emerald-300'],
  owned: [CircleCheck, 'text-slate-400'], partner: [Users, 'text-sky-300'],
  check: [Info, 'text-amber-300'], new: [BookOpen, 'text-sky-300'], unknown: [CircleQuestionMark, 'text-slate-400'],
  offline: [WifiOff, 'text-amber-300'], pending: [Clock, 'text-slate-400']
};

export default function ScanListPanel({ scanned, canEdit, buyable, basket, booking, bookingNote, isOfflineMode, onBookAll, onClear, onRecheck, onRemove }) {
  return (
    <div className="glass-panel p-4 rounded-2xl border border-emerald-500/30 space-y-3" id="shop-scan-list">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-white">{t('Gescannt ({count})', { count: scanned.length })}</p>
        <div className="flex items-center gap-2">
          {canEdit && buyable.length > 0 && (
            <button
              type="button"
              onClick={onBookAll}
              disabled={booking}
              className="btn-primary text-xs !bg-emerald-700 hover:!bg-emerald-800 disabled:opacity-50"
            >
              {booking ? t('Wird gebucht...') : t('{count} als gekauft abhaken', { count: buyable.length })}
            </button>
          )}
          <button type="button" onClick={onClear} className="btn-secondary text-xs px-3 py-1.5" disabled={booking}>{t('Leeren')}</button>
        </div>
      </div>
      {canEdit && basket.length > 0 && (
        <p className="text-xs text-slate-300" id="shop-scan-total">
          {t('Summe: {total}', { total: basket.map((b) => formatMoney(b.total, b.currency)).join(' + ') })}
        </p>
      )}
      {bookingNote && <p className="text-xs text-rose-300" role="status">{bookingNote}</p>}
      <ul className="space-y-1.5">
        {scanned.map((e) => {
          const [icon, color] = KIND_STYLE[e.kind] || KIND_STYLE.unknown;
          const Marker = e.done ? (e.queued ? Clock : Check) : (e.failed ? TriangleExclamationPoint : icon);
          const recheck = !e.done && !booking && !isOfflineMode && (e.kind === 'offline' || e.offline);
          return (
            <li key={e.isbn} className={`text-xs flex items-start gap-2 ${color}`} data-kind={e.kind}>
              <span aria-hidden="true" className="shrink-0"><Marker className="w-3.5 h-3.5" /></span>
              <span className="min-w-0 flex-1">
                {/* i18n-ignore: scanHelpers builds the label with t() */}
                <span className={e.done ? 'line-through opacity-60' : ''}>{e.label}</span>
                {e.done && e.queued && <span className="ml-1 text-slate-400">{t('(vorgemerkt)')}</span>}
                {e.done && e.gone && <span className="ml-1 text-slate-400">{t('(nicht mehr auf der Liste)')}</span>}
                {e.booking && <span className="ml-1 text-slate-400">{t('(wird gebucht…)')}</span>}
                {e.kind === 'add' && !e.done && !e.booking && canEdit && <span className="ml-1 text-slate-400">{t('(wird beim Buchen angelegt)')}</span>}
                {!e.done && e.failed && <span className="ml-1 text-rose-300">{t('– nicht gebucht: {error}', { error: e.error })}</span>}
                {e.elsewhere && !e.done && (
                  <span className="block text-amber-300" data-elsewhere>{elsewhereText(e.elsewhere)}</span>
                )}
              </span>
              {recheck && (
                <button
                  type="button"
                  onClick={() => onRecheck(e.isbn)}
                  className="shrink-0 text-[11px] text-brand-300 hover:text-white underline"
                >
                  {t('Erneut prüfen')}
                </button>
              )}
              {!e.booking && (
                <button
                  type="button"
                  onClick={() => onRemove(e.isbn)}
                  disabled={booking}
                  className="hit-44 shrink-0 text-slate-400 hover:text-white rounded disabled:opacity-50"
                  aria-label={t('Scan entfernen: {label}', { label: e.label })}
                  title={t('Scan entfernen: {label}', { label: e.label })}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
