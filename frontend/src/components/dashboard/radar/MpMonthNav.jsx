import { Calendar, ChevronLeft, ChevronRight, ChevronDown, Star, RefreshCw, CalendarCheck } from 'lucide-react';
import { buildYearOptions, isCurrentMonth, shiftMonth } from '../../../utils/radarHelpers';

/** Month / year navigation of the Manga-Passion calendar. `mpCurrent`: mpData is the selected month. */
export default function MpMonthNav({
  mpData,
  mpCurrent,
  loadingMp,
  fetchMangaPassionReleases,
  mpYear,
  setMpYear,
  mpMonth,
  setMpMonth,
  handlePrevMonth,
  handleNextMonth,
  handleCurrentMonth,
  mpPrintOnly,
  GERMAN_MONTHS
}) {
  const now = new Date();
  const yearOptions = buildYearOptions(now.getFullYear(), mpYear);
  const onCurrentMonth = isCurrentMonth(mpYear, mpMonth, now);
  const shown = mpCurrent ? mpData : null;
  const countOrPlaceholder = (value) => (loadingMp ? '...' : shown ? (value ?? 0) : '–');

  return (
    <div className="glass-panel p-4 sm:p-5 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-sky-950/30">
      <div className="flex flex-wrap items-center justify-between sm:justify-start gap-2">
        <button
          type="button"
          onClick={handlePrevMonth}
          disabled={loadingMp || !shiftMonth(mpYear, mpMonth, -1)}
          className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1 shrink-0"
          title="Vorheriger Monat"
          aria-label="Vorheriger Monat"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Voriger Monat</span>
        </button>

        <div className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 bg-slate-950/80 border border-slate-800 rounded-xl shadow-inner">
          <Calendar className="w-4 h-4 text-sky-400 shrink-0" />

          <label className="relative inline-flex items-center cursor-pointer group">
            <select
              value={mpMonth}
              disabled={loadingMp}
              aria-label="Monat"
              onChange={(e) => {
                const m = Number(e.target.value);
                setMpMonth(m);
                fetchMangaPassionReleases(mpYear, m);
              }}
              className="seamless-select text-base font-bold text-white group-hover:text-sky-300 pr-4 py-0.5 cursor-pointer transition-colors"
            >
              {GERMAN_MONTHS.map((name, idx) => (
                <option key={idx + 1} value={idx + 1} className="bg-slate-900 text-white">
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-sky-300 pointer-events-none absolute right-0 transition-colors" />
          </label>

          <label className="relative inline-flex items-center cursor-pointer group">
            <select
              value={mpYear}
              disabled={loadingMp}
              aria-label="Jahr"
              onChange={(e) => {
                const y = Number(e.target.value);
                setMpYear(y);
                fetchMangaPassionReleases(y, mpMonth);
              }}
              className="seamless-select text-base font-bold text-sky-400 group-hover:text-sky-300 pr-4 py-0.5 cursor-pointer transition-colors"
            >
              {yearOptions.map(y => (
                <option key={y} value={y} className="bg-slate-900 text-white">
                  {y}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-sky-400/70 group-hover:text-sky-300 pointer-events-none absolute right-0 transition-colors" />
          </label>
        </div>

        <button
          type="button"
          onClick={handleNextMonth}
          disabled={loadingMp || !shiftMonth(mpYear, mpMonth, 1)}
          className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1 shrink-0"
          title="Nächster Monat"
          aria-label="Nächster Monat"
        >
          <span className="hidden sm:inline">Nächster Monat</span>
          <ChevronRight className="w-4 h-4" />
        </button>

        {!onCurrentMonth && handleCurrentMonth && (
          <button
            type="button"
            onClick={handleCurrentMonth}
            disabled={loadingMp}
            className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1 shrink-0"
            title="Zum aktuellen Monat"
          >
            <CalendarCheck className="w-4 h-4" />
            <span>Aktueller Monat</span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
        <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Neuerscheinungen</p>
          <p className="text-base sm:text-lg font-extrabold text-sky-400 font-mono">
            {countOrPlaceholder(mpPrintOnly ? shown?.print_count : shown?.total_items)}
            <span className="text-xs text-slate-400 font-normal ml-1">
              {mpPrintOnly ? 'Print' : 'Gesamt'}
            </span>
          </p>
        </div>

        <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
            <Star className="w-3 h-3 text-amber-400" /> Aus deinen Reihen
          </p>
          <p className="text-base sm:text-lg font-extrabold text-amber-400 font-mono">
            {countOrPlaceholder(mpPrintOnly ? shown?.user_series_print_count : shown?.user_series_count)}
            <span className="text-xs text-slate-400 font-normal ml-1">Bände</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => fetchMangaPassionReleases(mpYear, mpMonth, true)}
          disabled={loadingMp}
          className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 shrink-0"
          title="Manga-Passion-Daten neu laden (Cache umgehen)"
          aria-label="Manga-Passion-Daten neu laden"
        >
          <RefreshCw className={`w-4 h-4 ${loadingMp ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </div>
  );
}
