import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Globe, Library, Plus } from 'lucide-react';
import { lookupMangaUrl } from '../../hooks/useMangaData';
import { apiFetch, assetImgProps, readJson, TIMEOUTS } from '../../utils/api';
import { formatCount } from '../../utils/format';
import { mangaStatusLabel } from '../../utils/enumLabels';
import { editionDefaults, editionLanguage, getDefaultLanguage, languageName } from '../../utils/editions';
import { hitToForm, lookupSourceLabels } from '../../utils/lookupPrefill';
import { matchHit, retryAfterSeconds, visibleHits } from '../../utils/onlineMatch';
import { serverText } from '../../i18n/serverText.js';
import { t, tn } from '../../i18n/index.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const UNAVAILABLE_HOLD_MS = 30 * 1000;
const LOADING = { status: 'loading', hits: [] };
const entries = new Map();
let running = null;
let rateLimitedUntil = 0;

const cacheKey = (query, language) => `${language}|${query.toLowerCase()}`;

/** Forgets the remembered answers and rate limit and drops a running lookup (tests). */
export function clearOnlineAnswers() {
  running?.controller.abort();
  running = null;
  rateLimitedUntil = 0;
  entries.clear();
}

async function fetchHits(query, language, signal) {
  const res = await apiFetch(lookupMangaUrl(query, language), { timeout: TIMEOUTS.lookup, signal });
  const data = await readJson(res);
  if (res.ok) return Array.isArray(data) ? { hits: data } : { error: 'other' };
  if (res.status === 429) return { error: 'rate', seconds: retryAfterSeconds(res.headers?.get?.('retry-after')) };
  if (res.status === 503 && data?.code === 'SOURCES_UNAVAILABLE') return { error: 'unavailable' };
  return { error: 'other', message: serverText(data) };
}

function entryFor(key) {
  let entry = entries.get(key);
  if (!entry) {
    entry = { seq: -1, until: 0, view: LOADING, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry, view, until) {
  entry.view = view;
  entry.until = until;
  entry.listeners.forEach((notify) => notify());
}

const rateView = (until) => ({ status: 'error', hits: [], error: 'rate', seconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) });

function settle(entry, result) {
  const now = Date.now();
  if (result.hits) {
    publish(entry, { status: 'done', hits: result.hits }, now + CACHE_TTL_MS);
  } else if (result.error === 'rate') {
    rateLimitedUntil = now + result.seconds * 1000;
    publish(entry, rateView(rateLimitedUntil), rateLimitedUntil);
  } else {
    publish(entry, { status: 'error', hits: [], ...result }, result.error === 'unavailable' ? now + UNAVAILABLE_HOLD_MS : now);
  }
}

function startLookup(key, entry, query, language) {
  if (running) {
    running.controller.abort();
    const dropped = entries.get(running.key);
    if (dropped) dropped.seq = -1;
  }
  const job = { key, controller: new AbortController() };
  running = job;
  publish(entry, LOADING, 0);
  const finish = (result) => {
    if (running !== job) return;
    running = null;
    settle(entry, result);
  };
  fetchHits(query, language, job.controller.signal).then(finish, () => finish({ error: 'other' }));
}

function request(key, query, language, seq) {
  const entry = entryFor(key);
  if (seq <= entry.seq || running?.key === key) {
    entry.seq = Math.max(entry.seq, seq);
    return;
  }
  entry.seq = seq;
  const now = Date.now();
  if (now < entry.until && entry.view.error !== 'rate') return;
  if (now < rateLimitedUntil) publish(entry, rateView(rateLimitedUntil), rateLimitedUntil);
  else startLookup(key, entry, query, language);
}

function useOnlineLookup(query, seq, language) {
  const key = cacheKey(query, language);
  const subscribe = useCallback((notify) => {
    const entry = entryFor(key);
    entry.listeners.add(notify);
    return () => { entry.listeners.delete(notify); };
  }, [key]);
  const view = useSyncExternalStore(subscribe, () => entries.get(key)?.view ?? LOADING);
  useEffect(() => {
    request(key, query, language, seq);
  }, [key, query, language, seq]);
  return view;
}

function statusText(state, query) {
  if (state.status === 'loading') return t('Online-Suche läuft…');
  if (state.status === 'done') {
    const n = visibleHits(state.hits).length;
    return n > 0 ? tn('{n} online gefunden', '{n} online gefunden', n) : t('Online nichts gefunden zu „{q}“', { q: query });
  }
  if (state.error === 'rate') return t('Zu viele Online-Suchen – in {seconds} s wieder', { seconds: state.seconds });
  if (state.error === 'unavailable') return t('Online-Quellen gerade nicht erreichbar');
  return state.message || t('Fehler bei der Suche');
}

function SourceBadges({ hit }) {
  if (hit.source === 'manga_passion') {
    return (
      <span className="inline-flex items-center gap-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1 py-px rounded text-[10px] font-bold shrink-0">
        <Library className="w-3 h-3" aria-hidden="true" />{t('Manga Passion')}
      </span>
    );
  }
  return lookupSourceLabels(hit).map((label) => (
    <span key={label} className="inline-flex items-center gap-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-px rounded text-[10px] font-medium shrink-0">
      <Globe className="w-3 h-3" aria-hidden="true" />{label}
    </span>
  ));
}

function MatchNote({ match }) {
  if (!match) return null;
  const { manga } = match;
  if (match.kind === 'owned') {
    return (
      <Link to={`/manga/${manga.id}`} className="text-xs font-semibold text-emerald-300 hover:text-white underline-offset-2 hover:underline">
        {t('In der Sammlung')}<span className="sr-only">: {manga.title}</span>
      </Link>
    );
  }
  if (match.kind === 'otherEdition') {
    return <p className="text-xs text-amber-200">{t('Andere Ausgabe vorhanden ({language})', { language: languageName(editionLanguage(manga)) })}</p>;
  }
  return (
    <Link to={`/manga/${manga.id}`} className="text-xs text-sky-300 hover:text-white underline-offset-2 hover:underline break-words">
      {t('Ähnlicher Titel: {title}', { title: manga.title })}
    </Link>
  );
}

function HitCard({ hit, match, canEdit, onAdd }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const mp = hit.source === 'manga_passion';
  const canAdd = canEdit && match?.kind !== 'owned';
  return (
    <li className={`flex gap-3 p-3 rounded-xl border text-left ${mp
      ? 'bg-gradient-to-r from-emerald-950/30 to-slate-900/90 border-emerald-500/40'
      : 'bg-slate-900/80 border-slate-800'}`}
    >
      {hit.cover_image && !coverFailed ? (
        <img {...assetImgProps(hit.cover_image)} alt="" loading="lazy" onError={() => setCoverFailed(true)} className="w-12 h-[4.5rem] object-cover rounded shadow shrink-0" />
      ) : (
        <div aria-hidden="true" className="w-12 h-[4.5rem] bg-slate-800 rounded shrink-0 flex items-center justify-center text-slate-400">
          <BookOpen className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1"><SourceBadges hit={hit} /></div>
        <h3 className="text-sm font-semibold text-white break-words">{hit.title}</h3>
        {hit.alt_title && hit.alt_title !== hit.title && <p className="text-[11px] text-slate-400 truncate">{hit.alt_title}</p>}
        <p className="text-[11px] text-slate-400 truncate">{hit.author || t('Unbekannt')}</p>
        <div className="flex flex-wrap gap-1 text-[10px]">
          {hit.publisher && (
            <span className="bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-medium truncate max-w-[160px]">{hit.publisher}</span>
          )}
          {hit.total_volumes ? (
            <span className="bg-slate-800 text-slate-200 border border-slate-700/80 px-1.5 py-0.5 rounded font-bold">{formatCount(hit.total_volumes, 'Band', 'Bände')}</span>
          ) : null}
          {hit.status && <span className="bg-slate-800/80 px-1.5 py-0.5 rounded text-slate-400">{mangaStatusLabel(hit.status)}</span>}
        </div>
        {(match || canAdd) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <MatchNote match={match} />
            {canAdd && (
              <button
                type="button"
                onClick={() => onAdd({ form: hitToForm(hit, editionDefaults()), volume: null })}
                className="hit-44 btn-primary text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Anlegen')}<span className="sr-only">: {hit.title}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Online lookup hits for `query` with their relation to the collection; `embedded` inside the empty-shelf panel. */
export default function OnlineResults({ query, seq = 0, mangas = [], canEdit = false, onAdd, embedded = false, focusRequest = null }) {
  const language = getDefaultLanguage();
  const state = useOnlineLookup(query, seq, language);
  const headingId = useId();
  const focusRef = useRef(null);

  useEffect(() => {
    if (!focusRequest?.current) return;
    focusRequest.current = false;
    focusRef.current?.focus();
  }, [focusRequest]);

  const hits = useMemo(() => visibleHits(state.hits), [state.hits]);
  const matches = useMemo(() => hits.map((hit) => matchHit(hit, mangas, { language })), [hits, mangas, language]);
  const loading = state.status === 'loading';
  const Wrapper = embedded ? 'div' : 'section';

  return (
    <Wrapper aria-labelledby={embedded ? undefined : headingId} aria-busy={loading || undefined} className={embedded ? 'text-left' : 'mt-8'}>
      {!embedded && (
        <h2 id={headingId} ref={focusRef} tabIndex={-1} className="flex items-center gap-2 text-sm font-bold text-slate-200 mb-2 focus:outline-none">
          <Globe className="w-4 h-4 text-sky-400" aria-hidden="true" /> {t('Online-Treffer zu „{q}“', { q: query })}
        </h2>
      )}
      <p
        role="status"
        aria-live="polite"
        ref={embedded ? focusRef : undefined}
        tabIndex={embedded ? -1 : undefined}
        className={`text-xs mb-3 focus:outline-none ${state.status === 'error' ? 'text-amber-300' : 'text-slate-400'}`}
      >
        {statusText(state, query)}
      </p>
      {loading && (
        <div aria-hidden="true" className={`grid gap-3 ${embedded ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'}`}>
          {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-xl border border-slate-800 bg-slate-800/50 animate-pulse" />)}
        </div>
      )}
      {!loading && hits.length > 0 && (
        <ul className={`grid gap-3 ${embedded ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'}`}>
          {hits.map((hit, i) => (
            <HitCard key={hit.id ?? `${hit.source}-${hit.title}-${i}`} hit={hit} match={matches[i]} canEdit={canEdit} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </Wrapper>
  );
}
