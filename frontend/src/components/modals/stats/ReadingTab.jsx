import { Link } from 'react-router-dom';
import { BookCheck, BookOpen, CircleCheck, Library } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { fmtNumber, fmtPct, countLabel, cssPct, fmtDateTime, sortReadVolumes } from '../statsFormat';
import { t } from '../../../i18n/index.js';

const READER_COVER_FALLBACK = (
  <div aria-hidden="true" className="w-full h-full flex items-center justify-center text-slate-500">
    <BookOpen className="w-5 h-5" />
  </div>
);

/** Overview card: read progress of every user. */
export function ReadingSummaryCard({ readers, ownedVols }) {
  return (
    <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
        <BookCheck className="w-4 h-4 text-emerald-400" aria-hidden="true" /> {t('Lese-Fortschritt der Community')}
      </h3>
      <div className="space-y-3.5">
        {readers.map(r => {
          const pct = r.read_pct ?? 0;
          return (
            <div key={r.user_id} className="space-y-1.5">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-white">{r.username}</span>
                <span className="text-slate-400 font-mono">
                  <strong className="text-emerald-400">{fmtNumber(r.read_count)}</strong> / {fmtNumber(r.total_owned ?? ownedVols)} ({fmtPct(pct)})
                </span>
              </div>
              <div aria-hidden="true" className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500" style={{ width: `${cssPct(pct)}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{t('Gelesen: {count}', { count: countLabel(r.read_count, 'Band', 'Bände') })}</span>
                <span>{t('Noch ungelesen (SuB): {count}', { count: countLabel(r.unread_count, 'Band', 'Bände') })}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReaderDetails({ details, visibleSeries, onShowMore, onBack, onNavigate }) {
  const readMangas = details?.stats?.readMangas || [];
  const hiddenSeries = Math.max(0, readMangas.length - visibleSeries);
  return (
    <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <div className="flex items-center gap-3 mb-6">
        <button type="button" onClick={onBack} className="p-2 bg-slate-800/80 hover:bg-slate-700 rounded-lg text-slate-300 hover:text-white transition-colors text-xs">
          {t('Zurück')}
        </button>
        <div>
          <h3 className="text-sm font-bold text-white">{t('Gelesene Mangas von {username}', { username: details.user.username })}</h3>
          <p className="text-xs text-slate-400">
            {t('{volumes} ({pages}) insgesamt gelesen', { volumes: countLabel(details.stats.totalVolumes, 'Band', 'Bände'), pages: countLabel(details.stats.totalPages, 'Seite', 'Seiten') })}
          </p>
        </div>
      </div>

      <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
        {readMangas.slice(0, visibleSeries).map(m => (
          <div key={m.id} className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex gap-4 items-start">
            <div className="w-12 h-16 bg-slate-800 rounded overflow-hidden shrink-0 shadow-md">
              <CoverImage src={m.cover_image} width={48} height={64} className="w-full h-full object-cover" fallback={READER_COVER_FALLBACK} />
            </div>
            <div>
              <Link to={`/manga/${m.id}`} onClick={onNavigate} className="font-bold text-white text-sm mb-2 hover:text-emerald-400 transition-colors inline-block">
                {m.title}
              </Link>
              <div className="flex flex-wrap gap-1.5">
                {sortReadVolumes(m.volumes).map(v => (
                  <span
                    key={v.id ?? `${v.type}-${v.volume_number}`}
                    className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono flex items-center gap-1"
                    title={t('Gelesen am: {date}', { date: fmtDateTime(v.read_at) })}
                  >
                    <CircleCheck className="w-3 h-3" aria-hidden="true" />
                    {getVolumeDisplayTitle(v)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
        {hiddenSeries > 0 && (
          <button
            type="button"
            onClick={onShowMore}
            className="w-full py-2 rounded-xl bg-slate-800/50 hover:bg-slate-700/80 border border-slate-700 text-slate-300 text-xs font-semibold"
          >
            {t('Weitere Reihen anzeigen ({number} übrig)', { number: fmtNumber(hiddenSeries) })}
          </button>
        )}
        {readMangas.length === 0 && (
          <div className="text-center py-8 bg-slate-900/50 rounded-xl border border-slate-800/50">
            <BookOpen className="w-8 h-8 mx-auto text-slate-500 mb-2" aria-hidden="true" />
            <p className="text-xs text-slate-400">{t('Noch keine Bände als gelesen markiert.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Reading per shelf (`shelf_reading` of /api/stats): owned volumes, how many of them a member has read, and every member
 * with their own count. Shown with two or more shelves, or one shelf shared by two or more members.
 */
export function ShelfReadingCard({ shelves }) {
  const list = Array.isArray(shelves) ? shelves : [];
  if (!(list.length >= 2 || list.some(s => (s.members || []).length >= 2))) return null;
  return (
    <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-2">
        <Library className="w-4 h-4 text-emerald-400" aria-hidden="true" />
        {t('Lesestand pro Regal')}
      </h3>
      <p className="text-xs text-slate-400 mb-4">{t('Ein Band zählt als gelesen, sobald ein Mitglied des Regals ihn gelesen hat.')}</p>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {list.map(s => {
          const pct = s.owned > 0 ? (s.read / s.owned) * 100 : 0;
          return (
            <li key={s.shelf_id} className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <div className="flex items-start justify-between gap-3 mb-2">
                <h4 className="font-bold text-white text-sm flex items-start gap-2 min-w-0">
                  <span aria-hidden="true" className="w-2.5 h-2.5 mt-1 rounded-full shrink-0" style={{ backgroundColor: s.color || '#6366f1' }} />
                  <span className="break-words [overflow-wrap:anywhere]">{s.name}</span>
                </h4>
                <span className="text-xs text-slate-400 font-mono shrink-0 mt-0.5">
                  {t('{read} von {owned} gelesen', { read: fmtNumber(s.read), owned: fmtNumber(s.owned) })}
                </span>
              </div>
              <div aria-hidden="true" className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800 mb-3">
                <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full" style={{ width: `${cssPct(pct)}%` }} />
              </div>
              <ul className="space-y-1 text-xs">
                {(s.members || []).map(m => (
                  <li key={m.user_id} className="flex justify-between gap-3">
                    <span className="text-slate-300 truncate">{m.username}</span>
                    <span className="text-slate-400 font-mono shrink-0">{countLabel(m.read, 'Band', 'Bände')}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Reading tab: one card per reader, or the read series of one reader. */
export default function ReadingTab({
  readers, ownedVols, shelves, details, visibleSeries, onShowMore, onBack, readerError, loadingDetails, onLoadDetails, onNavigate
}) {
  // the reader cards count an edition held in several shelves once, so their "Im Besitz" can be below the volume count
  const editionsCounted = readers.some(r => typeof r.total_owned === 'number' && r.total_owned < ownedVols);
  return (
    <div className="space-y-6 animate-fade-in">
      {details ? (
        <ReaderDetails details={details} visibleSeries={visibleSeries} onShowMore={onShowMore} onBack={onBack} onNavigate={onNavigate} />
      ) : (
        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
          <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-2">
            <BookCheck className="w-4 h-4 text-emerald-400" aria-hidden="true" />
            {t('Lese-Tracking & SuB (Stapel ungelesener Bücher)')}
          </h3>
          <p className={`text-xs text-slate-400 ${editionsCounted ? 'mb-1' : 'mb-6'}`}>{t('Übersicht aller Leser und deren Lesestatus über die gesamte Manga-Sammlung.')}</p>
          {editionsCounted && (
            <p className="text-xs text-slate-400 mb-6">{t('Ausgaben, die in mehreren Regalen stehen, zählen hier einmal.')}</p>
          )}
          {readerError && <p role="alert" className="mb-4 text-xs text-rose-300">{readerError}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {readers.map(r => {
              const pct = r.read_pct ?? 0;
              return (
                <div key={r.user_id} className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <div aria-hidden="true" className="w-9 h-9 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center font-bold text-brand-300">
                          {(r.username || '?').charAt(0).toUpperCase()}
                        </div>
                        <h4 className="font-bold text-white text-base">{r.username}</h4>
                      </div>
                      <div className="text-right">
                        <span className="text-xl font-extrabold font-mono text-emerald-400">{fmtPct(pct)}</span>
                        <span className="text-[10px] text-slate-400 block">{t('gelesen')}</span>
                      </div>
                    </div>

                    <div aria-hidden="true" className="w-full h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800 mb-4">
                      <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500" style={{ width: `${cssPct(pct)}%` }} />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center p-3 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs">
                      <div>
                        <span className="text-slate-400 text-[10px] block">{t('Gelesen')}</span>
                        <strong className="font-mono text-emerald-400 text-sm">{fmtNumber(r.read_count)}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400 text-[10px] block">{t('SuB (Offen)')}</span>
                        <strong className="font-mono text-amber-400 text-sm">{fmtNumber(r.unread_count)}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400 text-[10px] block">{t('Im Besitz')}</span>
                        <strong className="font-mono text-white text-sm">{fmtNumber(r.total_owned ?? ownedVols)}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => onLoadDetails(r.user_id)}
                      disabled={loadingDetails}
                      className="w-full py-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/80 border border-slate-700 hover:border-slate-600 text-slate-300 text-xs font-semibold transition-colors flex items-center justify-center gap-2"
                    >
                      {loadingDetails ? t('Lädt...') : t('Alle gelesenen Bände anzeigen')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!details && <ShelfReadingCard shelves={shelves} />}
    </div>
  );
}
