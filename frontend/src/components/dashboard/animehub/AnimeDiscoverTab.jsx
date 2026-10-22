import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus, Sparkles, Sun } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import api, { TIMEOUTS } from '../../../utils/api';
import { notify } from '../../../utils/notify';
import { formatLabel } from '../../../utils/animeHelpers';
import { t, tn } from '../../../i18n/index.js';

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
// i18n
const SEASON_LABELS = { WINTER: 'Winter', SPRING: 'Frühling', SUMMER: 'Sommer', FALL: 'Herbst' };

const currentSeason = (now) => ({ season: SEASONS[Math.floor(now.getMonth() / 3)], year: now.getFullYear() });
const titleOf = (hit) => hit.title?.preferred || hit.title?.romaji || hit.title?.english || hit.title?.native || t('Ohne Titel');

function Hit({ hit, because, canEdit, added, busy, onAdd, onOpen }) {
  const entryId = hit.in_collection_id || added;
  return (
    <li className="glass-card rounded-2xl border border-slate-800 p-3 flex gap-3">
      <div className="w-16 h-24 shrink-0 rounded-lg overflow-hidden bg-slate-900 border border-slate-800">
        <CoverImage src={hit.cover_url} className="w-full h-full object-cover" fallback={<div className="w-full h-full" />} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-white line-clamp-2 break-words">{titleOf(hit)}</p>
        <p className="text-xs text-slate-400 mt-0.5">
          {[formatLabel(hit.format), hit.episodes ? tn('{n} Folge', '{n} Folgen', hit.episodes) : null, hit.score ? `★ ${(hit.score / 10).toFixed(1)}` : null].filter(Boolean).join(' · ')}
        </p>
        {hit.genres?.length > 0 && <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{hit.genres.slice(0, 4).join(', ')}</p>}
        {because?.length > 0 && <p className="text-[11px] text-fuchsia-300 mt-1 line-clamp-2">{t('Weil du {titles} mochtest', { titles: because.join(', ') })}</p>}
        <div className="mt-2">
          {entryId ? (
            <button type="button" className="text-xs text-emerald-300 inline-flex items-center gap-1.5 hover:underline" onClick={() => onOpen(entryId)}>
              <Check className="w-3.5 h-3.5" aria-hidden="true" /> {t('In deiner Liste')}
            </button>
          ) : canEdit && (
            <button type="button" disabled={busy} onClick={() => onAdd(hit)} className="btn-secondary text-xs py-1.5 px-2.5 inline-flex items-center gap-1.5 disabled:opacity-60">
              <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Zur Liste')}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Tab "Entdecken": recommendations from my best rated anime, and a season of AniList to browse. */
export default function AnimeDiscoverTab({ canEdit, now, onAdd, onOpenId }) {
  const [mode, setMode] = useState('recs');
  const [season, setSeason] = useState(() => currentSeason(now));
  const [data, setData] = useState({ results: [], seeds: 0, has_next: false });
  const [state, setState] = useState('loading');
  const [added, setAdded] = useState({});
  const [busy, setBusy] = useState(null);
  const [page, setPage] = useState(1);
  const request = useRef(0);

  const load = useCallback(async (nextMode, nextSeason, nextPage) => {
    const id = ++request.current;
    setState('loading');
    try {
      const path = nextMode === 'recs'
        ? '/api/anime/discover/recommendations'
        : `/api/anime/discover/season?season=${nextSeason.season}&year=${nextSeason.year}&page=${nextPage}`;
      const answer = await api.get(path, { timeout: TIMEOUTS.lookup, fallback: t('Vorschläge konnten nicht geladen werden') });
      if (id !== request.current) return;
      setData((old) => (nextMode === 'season' && nextPage > 1 ? { ...answer, results: [...old.results, ...answer.results] } : answer));
      setState('ready');
    } catch (err) {
      if (id !== request.current) return;
      setState(err?.message || t('Vorschläge konnten nicht geladen werden'));
    }
  }, []);

  useEffect(() => { setPage(1); load(mode, season, 1); }, [mode, season, load]);

  const add = async (hit) => {
    const key = hit.anilist_id || hit.mal_id;
    setBusy(key);
    try {
      const detail = await onAdd({ anilist_id: hit.anilist_id || undefined, mal_id: hit.mal_id || undefined });
      setAdded((old) => ({ ...old, [key]: detail.id }));
      notify.success(t('„{title}“ ist jetzt in deiner Liste', { title: titleOf(hit) }));
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(null);
    }
  };
  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() + 1 - i);
  const tab = (key) => `px-3 py-1.5 rounded-lg text-sm font-semibold ${mode === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`;
  return (
    <div id="anime-discover">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div role="group" aria-label={t('Art der Vorschläge')} className="inline-flex gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl">
          <button type="button" aria-pressed={mode === 'recs'} className={tab('recs')} onClick={() => setMode('recs')}><Sparkles className="w-4 h-4 inline mr-1.5" aria-hidden="true" />{t('Für dich')}</button>
          <button type="button" aria-pressed={mode === 'season'} className={tab('season')} onClick={() => setMode('season')}><Sun className="w-4 h-4 inline mr-1.5" aria-hidden="true" />{t('Season')}</button>
        </div>
        {mode === 'season' && (
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="discover-season">{t('Jahreszeit')}</label>
            <select id="discover-season" className="input-field text-base sm:text-xs py-1.5 w-auto" value={season.season} onChange={(e) => setSeason({ ...season, season: e.target.value })}>
              {SEASONS.map((s) => <option key={s} value={s}>{t(SEASON_LABELS[s])}</option>)}
            </select>
            <label className="sr-only" htmlFor="discover-year">{t('Jahr')}</label>
            <select id="discover-year" className="input-field text-base sm:text-xs py-1.5 w-auto" value={season.year} onChange={(e) => setSeason({ ...season, year: Number(e.target.value) })}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}
      </div>
      {mode === 'recs' && state === 'ready' && data.seeds === 0 && (
        <p className="text-sm text-slate-400 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-6 text-center">
          {t('Bewerte Anime mit 8 oder mehr (oder schließe welche ab), dann schlägt AniList dir passende Serien vor.')}
        </p>
      )}
      {mode === 'recs' && state === 'ready' && data.seeds > 0 && data.results.length === 0 && (
        <p className="text-sm text-slate-400 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-6 text-center">{t('Keine neuen Vorschläge: du hast alles in deiner Liste, was AniList passend findet.')}</p>
      )}
      {state === 'loading' && !data.results.length && <p role="status" className="text-sm text-slate-400">{t('Lädt…')}</p>}
      {state !== 'loading' && state !== 'ready' && (
        <p role="alert" className="text-sm text-rose-300">{state} <button type="button" className="underline" onClick={() => load(mode, season, page)}>{t('Erneut versuchen')}</button></p>
      )}
      {data.results.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.results.map((hit) => (
            <Hit key={hit.anilist_id || hit.mal_id} hit={hit} because={hit.because} canEdit={canEdit}
              added={added[hit.anilist_id || hit.mal_id] || null} busy={busy === (hit.anilist_id || hit.mal_id)} onAdd={add}
              onOpen={(id) => onOpenId(id)} />
          ))}
        </ul>
      )}
      {mode === 'season' && state === 'ready' && data.has_next && (
        <button type="button" className="btn-secondary text-xs mt-4" onClick={() => { setPage(page + 1); load('season', season, page + 1); }}>{t('Mehr anzeigen')}</button>
      )}
    </div>
  );
}
