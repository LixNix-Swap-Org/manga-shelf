import { BookOpen } from 'lucide-react';

/** Reader switcher with read / unread progress of the selected reader. */
export default function ReaderBar({ readers, selectedReaderId, setSelectedReaderId, user, ownedCount, currentReaderReadCount, currentReaderUnreadCount }) {
  if (readers.length === 0) return null;
  // reads of volumes that are not (or no longer) owned must not push the bar past 100 %
  const readOfOwned = Math.min(currentReaderReadCount, ownedCount);
  const pct = ownedCount > 0 ? Math.min(100, Math.round((readOfOwned / ownedCount) * 100)) : 0;
  const unread = Math.max(0, currentReaderUnreadCount);
  return (
          <div className="mb-4 p-3.5 bg-slate-950/80 rounded-2xl border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-inner">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-emerald-400" />
                Leser:
              </span>
              
              {/* Readers switcher */}
              <div role="group" aria-label="Leser auswählen" className="flex flex-wrap items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs">
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

            {/* Reading Progress Percentage Bar for current selected reader */}
            <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end">
              <div className="text-xs text-slate-300 font-mono flex items-center gap-2">
                <span>Gelesen: <strong className="text-emerald-400">{readOfOwned}</strong> von {ownedCount}</span>
                <span className="text-slate-500" aria-hidden="true">|</span>
                <span>SuB: <strong className="text-amber-400">{unread}</strong></span>
              </div>
              <div
                role="progressbar"
                aria-label="Lesefortschritt"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={`${readOfOwned} von ${ownedCount} gelesen`}
                className="w-24 sm:w-32 h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800"
              >
                <div 
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                  title={`${pct}% gelesen`}
                />
              </div>
              <span className="text-xs font-mono font-bold text-emerald-400">
                {pct}%
              </span>
            </div>
          </div>
  );
}
