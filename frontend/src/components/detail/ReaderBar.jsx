import { useId } from 'react';
import { BookOpen } from 'lucide-react';
import { localDateString } from '../../hooks/useVolumeActions';
import { rich } from '../../i18n/react.jsx';
import { t } from '../../i18n/index.js';

/**
 * Reader switcher with read / unread progress of the selected reader. With setReadDate (and canToggle) a "Gelesen am"
 * date for the next read toggles; an empty field (the default) means now.
 */
export default function ReaderBar({
  readers, selectedReaderId, setSelectedReaderId, user, ownedCount, currentReaderReadCount, currentReaderUnreadCount,
  canToggle = false, readDate = null, setReadDate
}) {
  const dateId = useId();
  if (readers.length === 0) return null;
  // reads of volumes that are not (or no longer) owned must not push the bar past 100 %
  const readOfOwned = Math.min(currentReaderReadCount, ownedCount);
  const pct = ownedCount > 0 ? Math.min(100, Math.round((readOfOwned / ownedCount) * 100)) : 0;
  const unread = Math.max(0, currentReaderUnreadCount);
  return (
          <div className="mb-4 p-3.5 bg-slate-950/80 rounded-2xl border border-slate-800 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 shadow-inner">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-emerald-400" />
                {t('Leser:')}
              </span>
              
              {/* Readers switcher */}
              <div role="group" aria-label={t('Leser auswählen')} className="flex flex-wrap items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs">
                {readers.map(r => {
                  const isSelected = String(selectedReaderId) === String(r.user_id) || (selectedReaderId === 'ALL' && String(r.user_id) === String(user?.id));
                  return (
                    <button
                      key={r.user_id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedReaderId(r.user_id)}
                      className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-2 ${
                        isSelected 
                          ? 'bg-brand-700 text-white shadow-sm font-semibold' 
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span>{r.display_name || r.username}</span>
                      <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded-md ${isSelected ? 'bg-black/30 text-emerald-200' : 'bg-slate-800 text-slate-300'}`}>
                        {Math.min(r.read_count, r.total_owned)} / {r.total_owned}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {canToggle && setReadDate && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <label htmlFor={dateId} className="font-semibold text-slate-300 whitespace-nowrap">{t('Gelesen am')}</label>
                <input
                  id={dateId}
                  type="date"
                  max={localDateString()}
                  value={readDate || ''}
                  onChange={(e) => setReadDate(e.target.value)}
                  aria-describedby={readDate ? undefined : `${dateId}-hint`}
                  className="input-field text-base sm:text-xs py-1 px-2 !w-auto min-w-[9rem] min-h-[2rem]"
                  title={t('Datum für die nächsten Häkchen „gelesen“ (leer = jetzt)')}
                />
                {!readDate && (
                  <span id={`${dateId}-hint`} className="text-slate-400 whitespace-nowrap">{t('leer = jetzt')}</span>
                )}
              </div>
            )}

            {/* Reading Progress Percentage Bar for current selected reader */}
            <div className="flex items-center gap-3 w-full lg:w-auto justify-between lg:justify-end">
              <div className="text-xs text-slate-300 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="whitespace-nowrap">{rich('Gelesen: {read} von {owned}', { read: <strong className="font-mono text-emerald-400">{readOfOwned}</strong>, owned: <span className="font-mono">{ownedCount}</span> })}</span>
                <span className="text-slate-500" aria-hidden="true">|</span>
                <span className="whitespace-nowrap">{rich('SuB: {unread}', { unread: <strong className="font-mono text-amber-400">{unread}</strong> })}</span>
              </div>
              <div
                role="progressbar"
                aria-label={t('Lesefortschritt')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={t('{read} von {owned} gelesen', { read: readOfOwned, owned: ownedCount })}
                className="w-24 sm:w-32 h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800"
              >
                <div 
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                  title={t('{pct}% gelesen', { pct })}
                />
              </div>
              <span className="text-xs font-mono font-bold text-emerald-400">
                {pct}%
              </span>
            </div>
          </div>
  );
}
