import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, ExternalLink, Play, RefreshCw, Trash, Tv, X } from 'lucide-react';
import useDialogA11y, { afterDialogEntriesDropped, dialogEntryOnTop } from '../../hooks/useDialogA11y';
import useLatestRequest from '../../hooks/useLatestRequest';
import useAccountDefaults from '../../hooks/useAccountDefaults';
import CoverImage from '../common/CoverImage';
import { langFor } from '../common/lang';
import { openLinkOutside } from '../../app/openExternal';
import api, { isAbortError } from '../../utils/api';
import { notify } from '../../utils/notify';
import { compareNatural } from '../../utils/search';
import { displayTitle, formatLabel, airingStatusLabel, relationLabel, progressText, countdownText, staleText, shortDescription, continueTarget, airedEpisodes, kindOf, kindLabel, seasonEpisodeText, ANIME_KINDS, resetByPlanned } from '../../utils/animeHelpers';
import { formatNumber } from '../../utils/format';
import { animeProgressLabel } from '../../utils/enumLabels';
import ConfirmDialog from './ConfirmDialog';
import { t, tn } from '../../i18n/index.js';
import TagEditor from '../dashboard/animehub/TagEditor';
import { readSpoilerGuard, spoilerState, writeSpoilerGuard } from '../../utils/animeHub';
import { CommunityRatings } from './animeDetail/CommunityRatings';
import { SeasonEditor } from './animeDetail/SeasonEditor';
import { EXTRA_FORMATS, NOT_TRUNCATED, chainSeasonLabels, useAutoSeasons, EpisodeGrid } from './animeDetail/EpisodeGrid';
import { isRated, sharedWithOthers, OwnProgress } from './animeDetail/OwnProgress';

const REFRESH_LOCK_MS = 60 * 1000;
const lastRefresh = new Map();

function MetaRow({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex gap-2 text-xs">
      <dt className="text-slate-400 w-24 shrink-0">{label}</dt>
      <dd className="text-slate-200 min-w-0">{children}</dd>
    </div>
  );
}





/**
 * Detail of one anime: banner, metadata, description, relations (add or open), everybody's progress, my progress,
 * link to a series, refresh (60 s lock) and delete. `fallback` is the list entry (offline it is all there is).
 * `defaultVisibility` (the account's default for new ratings) is read from GET /api/auth/me when not passed.
 * Closing, "Öffnen" on a related anime and the series link ask before unsaved input is dropped.
 */
export default function AnimeDetailModal({
  isOpen, animeId, fallback, onClose, canEdit, mangas = [], fetchDetail, updateProgress, removeFromMyList, update, seasonSuggestion, refresh, remove, onAdd,
  onOpenAnime, defaultVisibility, knownTags = []
}) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [gridBusy, setGridBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [spoilerGuard, setSpoilerGuard] = useState(readSpoilerGuard);
  const [revealed, setRevealed] = useState(null);
  const [titleDe, setTitleDe] = useState('');
  const [refreshLeft, setRefreshLeft] = useState(0);
  const [progressDirty, setProgressDirty] = useState(false);
  const [progressSaving, setProgressSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discardThen, setDiscardThen] = useState(null);
  const begin = useLatestRequest();
  const navigate = useNavigate();
  const hasFallback = useRef(Boolean(fallback));
  hasFallback.current = Boolean(fallback);
  const titleId = useId();

  const anime = detail || fallback;
  const sharing = Boolean(anime) && sharedWithOthers(anime);
  const autoSeasons = useAutoSeasons(anime, isOpen && canEdit && anime && kindOf(anime) !== 'movie' ? seasonSuggestion : null);
  const gridAnime = useMemo(() => (anime && autoSeasons ? { ...anime, custom_seasons: autoSeasons } : anime), [anime, autoSeasons]);
  const spoilers = spoilerState(anime, spoilerGuard);
  const account = useAccountDefaults({ enabled: Boolean(isOpen && canEdit && sharing && defaultVisibility === undefined) });
  const accountVisibility = defaultVisibility === undefined ? account.animeVisibility : defaultVisibility;
  const isTitleDirty = Boolean(anime && titleDe.trim() !== (anime.title_de || '').trim());
  // input that a running save already sends is not lost by closing
  const isDirty = (progressDirty && !progressSaving) || isTitleDirty;

  // `afterQuestion` takes the place of `proceed` when the discard question was asked and answered with yes
  const unlessDiscarding = useCallback((proceed, afterQuestion = proceed) => {
    if (isDirty) {
      setDiscardThen(() => afterQuestion);
      return;
    }
    proceed();
  }, [isDirty]);
  const requestClose = useCallback(() => unlessDiscarding(onClose), [unlessDiscarding, onClose]);

  const dialogRef = useDialogA11y(isOpen, { onClose: requestClose });
  const latest = useRef(null);
  const shownVisibility = useRef(null);

  // a reload that a save, removal or add asks for after "Öffnen" switched the entry leaves the new entry alone
  const load = useCallback(async () => {
    if (!animeId || latest.current?.animeId !== animeId) return;
    const { signal, isCurrent } = begin();
    setError('');
    try {
      const data = await fetchDetail(animeId, { signal });
      if (isCurrent()) setDetail(data);
    } catch (err) {
      if (!isCurrent() || isAbortError(err)) return;
      setError(hasFallback.current ? '' : (err.message || t('Anime konnte nicht geladen werden')));
    }
  }, [animeId, begin, fetchDetail]);
  latest.current = { animeId, load, progress: anime?.my_progress ?? null };

  useEffect(() => {
    if (!isOpen) return;
    setDetail(null);
    setExpanded(false);
    load();
  }, [isOpen, load]);

  useEffect(() => { setTitleDe(anime?.title_de || ''); }, [anime?.title_de]);

  // the live main line (AniList, beyond the entries in the collection); the detail's own season_chain is the fallback
  const [liveChain, setLiveChain] = useState(null);
  const [chainTruncated, setChainTruncated] = useState(NOT_TRUNCATED);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainRevision, setChainRevision] = useState(0);
  // "Weitere Staffeln laden" hands the focus back once the answer is there (the button may be gone by then)
  const chainFocus = useRef(false);
  const chainHeadingRef = useRef(null);
  const chainMoreRef = useRef(null);
  const chainId = isOpen && anime?.anilist_id && (anime.kind || 'anime') === 'anime' ? animeId : null;
  useEffect(() => { setLiveChain(null); setChainTruncated(NOT_TRUNCATED); chainFocus.current = false; }, [chainId]);
  useEffect(() => {
    if (!chainId) return undefined;
    const controller = new AbortController();
    setChainLoading(true);
    api.get(`/api/anime/${chainId}/season-chain`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || !Array.isArray(data?.seasons)) return;
        setLiveChain(data.seasons);
        // the request cap ended a direction early: the next call goes on from the steps AniList already answered
        setChainTruncated({ before: !!data.truncated?.before, after: !!data.truncated?.after });
      })
      .catch((err) => { if (!controller.signal.aborted && chainRevision > 0) notify.error(err); })
      .finally(() => { if (!controller.signal.aborted) setChainLoading(false); });
    return () => controller.abort();
  }, [chainId, chainRevision]);
  useEffect(() => {
    if (chainLoading || !chainFocus.current) return;
    chainFocus.current = false;
    (chainMoreRef.current || chainHeadingRef.current)?.focus();
  }, [chainLoading, chainTruncated]);

  useEffect(() => {
    if (!isOpen || !animeId) return undefined;
    const tick = () => setRefreshLeft(Math.max(0, Math.ceil(((lastRefresh.get(animeId) || 0) + REFRESH_LOCK_MS - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isOpen, animeId]);

  if (!isOpen) return null;

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const saveProgress = (change) => {
    setProgressSaving(true);
    const id = animeId;
    const prev = anime.my_progress;
    return run(async () => {
      // a reset by "Geplant" gets its own toast with "Rückgängig" from updateProgress, which reloads this dialog after the undo
      const saved = change.status === 'Geplant' // i18n-ignore: stored value
        ? await updateProgress(id, change, { onUndone: () => { if (latest.current?.animeId === id) latest.current.load(); } })
        : await updateProgress(id, change);
      if (saved) {
        if (!resetByPlanned(prev, change, saved)) notify.success(t('Fortschritt gespeichert'));
        await load();
      }
    }).finally(() => setProgressSaving(false));
  };

  // the series page takes the place of the dialog's history entry, so Back does not land on the closed dialog; after
  // the discard question it waits until the question's own entry is gone
  const followLink = (e, to) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const go = () => navigate(to, { replace: dialogEntryOnTop() });
    unlessDiscarding(go, () => afterDialogEntriesDropped(go));
  };

  const doRefresh = () => run(async () => {
    lastRefresh.set(animeId, Date.now());
    setRefreshLeft(60);
    const fresh = await refresh(animeId);
    setDetail(fresh);
    notify.success(fresh.refreshed === false ? t('Bei den Quellen nicht mehr gefunden, der gespeicherte Stand bleibt') : t('Aktualisiert'));
  });

  const doDelete = () => {
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = () => {
    setDeleteConfirmOpen(false);
    run(async () => {
      await remove(animeId);
      notify.success(t('Anime gelöscht'));
      onClose();
    });
  };

  const onRemove = () => run(async () => {
    const id = animeId;
    const prev = anime.my_progress;
    const removed = await removeFromMyList(id, { decline: true });
    await load();
    if (!removed || !prev) return;
    notify.success(t('Von deiner Liste entfernt'), {
      action: {
        label: t('Rückgängig'),
        onClick: async () => {
          const saved = await updateProgress(id, {
            status: prev.status, episodes_watched: prev.episodes_watched, score: prev.score, notes: prev.notes,
            audio_language: prev.audio_language ?? null, subtitle_language: prev.subtitle_language ?? null,
            ...(prev.watched_episodes !== undefined ? { watched_episodes: prev.watched_episodes } : {}),
            ...(prev.episode_scores !== undefined ? { episode_scores: prev.episode_scores } : {}),
            // the restored rating keeps who saw it and its comment (a new row would get the account default)
            ...(prev.rating_visibility ? { rating_visibility: prev.rating_visibility } : {}),
            ...(prev.public_comment !== undefined ? { public_comment: prev.public_comment } : {}), restore: true
          });
          if (saved && latest.current?.animeId === id) latest.current.load();
        }
      }
    });
  });

  // a save of the episode grid, bound to the grid's entry: no toast; the dialog takes the answer (counter and status
  // follow at once) only while it still shows that entry. A first rating takes the visibility the form shows.
  const saveEpisodes = async (id, change) => {
    const shown = shownVisibility.current;
    const firstRating = shown?.id === id && latest.current?.animeId === id && !isRated(latest.current.progress)
      && Object.keys(change.episode_scores || {}).length > 0;
    const saved = await updateProgress(id, firstRating ? { ...change, rating_visibility: shown.value } : change);
    if (saved && latest.current?.animeId === id) setDetail((d) => (d && d.id === id ? { ...d, my_progress: saved } : d));
    return saved;
  };
  // the grid's saves are done: one reload, so "Weiter" and "Fortschritt aller" follow
  const episodesSettled = (id) => {
    if (latest.current?.animeId === id) latest.current.load();
  };

  const saveLink = (value) => run(async () => setDetail(await update(animeId, { manga_id: value ? Number(value) : null })));
  const saveKind = (value) => run(async () => setDetail(await update(animeId, { kind: value })));
  // one tag change ({ tags_add } or { tags_remove }), applied on the server to the stored tags; false when nothing was stored
  const saveTags = async (change) => {
    let saved = false;
    await run(async () => { setDetail(await update(animeId, change)); saved = true; });
    return saved;
  };
  // the season editor shows its own errors: no toast, the busy flag only
  const saveSeasons = async (customSeasons) => {
    setBusy(true);
    try {
      setDetail(await update(animeId, { custom_seasons: customSeasons }));
      notify.success(customSeasons ? t('Staffeln gespeichert') : t('Eigene Staffeln entfernt'));
    } finally {
      setBusy(false);
    }
  };
  const loadSeasonSuggestion = () => seasonSuggestion(animeId);
  const saveTitle = (e) => {
    e.preventDefault();
    run(async () => setDetail(await update(animeId, { title_de: titleDe.trim() || null })));
  };

  const description = shortDescription(anime?.description);
  const stale = anime ? staleText(anime) : null;
  const kind = anime ? kindOf(anime) : 'anime';
  const countdown = anime ? countdownText(anime.next_airing, undefined, kind) : null;
  const seasons = Array.isArray(anime?.seasons) ? anime.seasons : [];
  const sortedMangas = [...mangas].sort((a, b) => compareNatural(a.title, b.title));
  const animeRelations = (anime?.relations || []).filter((r) => r.kind === 'ANIME');
  // films, specials and OVAs sit apart from the main line; they never touch the episode count
  // no fallback (an entry the list does not know yet): `anime` stays null until the detail has loaded
  const storedChain = anime?.season_chain || [];
  const chainSeasons = liveChain && liveChain.length > storedChain.length ? liveChain : storedChain;
  const extras = animeRelations.filter((r) => EXTRA_FORMATS.includes(r.format));
  const relations = animeRelations.filter((r) => !EXTRA_FORMATS.includes(r.format));
  const next = continueTarget(anime);
  const aired = anime ? airedEpisodes(anime) : null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') requestClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-3xl rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden">
        <div className="relative h-28 sm:h-40 bg-slate-900">
          {anime?.banner_image && <CoverImage src={anime.banner_image} className="w-full h-full object-cover opacity-70" />}
          <button type="button" onClick={requestClose} aria-label={t('Schließen')} className="hit-44 absolute top-3 right-3 bg-slate-950/70 text-slate-200 hover:text-white p-1.5 rounded-lg">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 sm:p-7 -mt-14 sm:-mt-20 relative">
          {!anime && !error && <p className="text-sm text-slate-400" role="status">{t('Wird geladen…')}</p>}
          {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
          {anime && (
            <>
              <div className="flex gap-4 items-end">
                <div className="w-24 sm:w-32 aspect-[2/3] rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shrink-0 shadow-xl">
                  <CoverImage src={anime.cover_image} className="w-full h-full object-cover" fallback={<Tv className="w-8 h-8 m-auto mt-10 text-slate-500" aria-hidden="true" />} />
                </div>
                <div className="min-w-0 pb-1">
                  <h2 id={titleId} lang={langFor(displayTitle(anime)) || 'de'} className="text-xl sm:text-2xl font-extrabold text-white leading-tight break-words hyphens-auto [overflow-wrap:anywhere]">{displayTitle(anime)}</h2>
                  {anime.title_romaji && anime.title_romaji !== displayTitle(anime) && <p className="text-sm text-slate-400">{anime.title_romaji}</p>}
                  {anime.title_native && <p className="text-xs text-slate-400">{anime.title_native}</p>}
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <dl className="space-y-1.5">
                    <MetaRow label={t('Art')}>{kindLabel(kind)}</MetaRow>
                    <MetaRow label={t('Format')}>{[formatLabel(anime.format), anime.season_year].filter(Boolean).join(' · ') || null}</MetaRow>
                    <MetaRow label={t('Status')}>{airingStatusLabel(anime.status)}</MetaRow>
                    {kind === 'anime' || (kind === 'tv' && !seasons.length) ? (
                      <MetaRow label={t('Folgen')}>{anime.episodes ? (anime.duration ? t('{episodes} à {duration} Min.', { episodes: anime.episodes, duration: anime.duration }) : `${anime.episodes}`) : null}</MetaRow>
                    ) : null}
                    <MetaRow label={t('Nächste Folge')}>{countdown ? (anime.next_airing?.estimated ? t('{countdown} (geschätzt)', { countdown }) : `${countdown}`) : null}</MetaRow>
                    <MetaRow label={t('Studio')}>{(anime.studios || []).join(', ') || null}</MetaRow>
                    <MetaRow label={t('Genres')}>{(anime.genres || []).join(', ') || null}</MetaRow>
                    <MetaRow label={t('Wertung')}>{anime.score ? `${anime.score} / 100` : null}</MetaRow>
                    <MetaRow label={t('Reihe')}>
                      {anime.manga ? <Link to={`/manga/${anime.manga.id}`} onClick={(e) => followLink(e, `/manga/${anime.manga.id}`)} className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1"><BookOpen className="w-3.5 h-3.5" aria-hidden="true" />{anime.manga.title}</Link> : null}
                    </MetaRow>
                  </dl>
                  {kind === 'tv' && seasons.length > 0 && <p className="text-xs text-slate-200">{t('Staffeln: {n} · Folgen: {m}', { n: seasons.length, m: anime.episodes || 0 })}</p>}
                  {kind === 'movie' && anime.duration ? <p className="text-xs text-slate-200">{t('Laufzeit: {n} Min.', { n: anime.duration })}</p> : null}
                </div>
                <div className="space-y-2">
                  {next && ( // i18n-ignore: continueTarget() returns the label translated
                    <a
                      id="anime-continue-link"
                      href={next.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(e) => openLinkOutside(e, { preferApp: true })}
                      aria-label={`${next.label}: ${displayTitle(anime)}`}
                      className="btn-primary text-xs inline-flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" aria-hidden="true" /> {next.label}
                    </a>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {anime.urls?.anilist && <a href={anime.urls.anilist} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">AniList <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.mal && <a href={anime.urls.mal} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">MyAnimeList <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.imdb && <a href={anime.urls.imdb} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">IMDb <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                    {anime.urls?.tmdb && <a href={anime.urls.tmdb} target="_blank" rel="noreferrer noopener" className="btn-secondary text-xs inline-flex items-center gap-1">TMDB <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>}
                  </div>
                  {stale && <p className="text-[11px] text-slate-400">{stale}</p>}
                  {canEdit && !anime.manual && (
                    <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" onClick={doRefresh} disabled={busy || refreshLeft > 0}>
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {refreshLeft > 0 ? t('Aktualisieren ({refreshLeft} s)', { refreshLeft }) : t('Aktualisieren')}
                    </button>
                  )}
                </div>
              </div>

              <label className="mt-4 flex items-center gap-2 text-[11px] text-slate-400 w-fit">
                <input type="checkbox" id="anime-spoiler-guard" checked={spoilerGuard}
                  onChange={(e) => { setSpoilerGuard(e.target.checked); writeSpoilerGuard(e.target.checked); }} />
                {t('Spoilerschutz (Beschreibung und fremde Bewertungen erst nach dem Anschauen)')}
              </label>
              {description.text && (spoilers.hideDescription && revealed !== anime.id ? (
                <div className="mt-2 rounded-xl border border-dashed border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400" data-testid="anime-description-hidden">
                  {t('Beschreibung ausgeblendet, bis du die erste Folge gesehen hast.')}{' '}
                  <button type="button" className="text-brand-300 underline" onClick={() => setRevealed(anime.id)}>{t('Trotzdem anzeigen')}</button>
                </div>
              ) : (
                <div className="mt-2">
                  <p className="text-sm text-slate-300 whitespace-pre-line break-words">{expanded ? anime.description : description.text}</p>
                  {description.cut && <button type="button" className="text-xs text-brand-300 mt-1" onClick={() => setExpanded((v) => !v)}>{expanded ? t('Weniger anzeigen') : t('Mehr anzeigen')}</button>}
                </div>
              ))}

              {canEdit && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-label={t('Mein Fortschritt')}>
                  <h3 className="text-sm font-bold text-white mb-2">{t('Mein Fortschritt')}</h3>
                  <OwnProgress key={anime.id} anime={anime} progress={anime.my_progress} onSave={saveProgress} busy={busy || gridBusy}
                    onRemove={onRemove} onDirtyChange={setProgressDirty} defaultVisibility={accountVisibility} sharing={sharing} visibilityRef={shownVisibility} />
                </section>
              )}

              {canEdit && kind !== 'movie' && !(anime.format === 'MOVIE' && !(anime.episodes > 1)) && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-labelledby={`${titleId}-episodes`}>
                  <h3 id={`${titleId}-episodes`} className="text-sm font-bold text-white mb-2">{t('Einzelne Folgen')}</h3>
                  {seasonSuggestion && (
                    <div className="mb-3">
                      <SeasonEditor key={anime.id} anime={anime} onSave={saveSeasons} loadSuggestion={loadSeasonSuggestion} disabled={busy} />
                    </div>
                  )}
                  {autoSeasons && (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <p className="text-xs text-slate-300">{t('Staffeln von TMDB, nur zur Anzeige.')}</p>
                      <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => saveSeasons(autoSeasons).catch((err) => notify.error(err))}>
                        {t('Für alle übernehmen')}
                      </button>
                    </div>
                  )}
                  <EpisodeGrid key={anime.id} anime={gridAnime} progress={anime.my_progress} onSave={saveEpisodes} onSettled={episodesSettled}
                    onPendingChange={setGridBusy} disabled={busy} />
                </section>
              )}

              {(anime.progress || anime.progress_users || []).length > 0 && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">{t('Fortschritt aller')}</h3>
                  {sharing && spoilers.hideOthers && revealed !== `${anime.id}:others` && (
                    <p className="text-xs text-slate-400 mb-2" data-testid="anime-ratings-hidden">
                      {t('Bewertungen anderer sind ausgeblendet, bis du den Anime abgeschlossen oder selbst bewertet hast.')}{' '}
                      <button type="button" className="text-brand-300 underline" onClick={() => setRevealed(`${anime.id}:others`)}>{t('Trotzdem anzeigen')}</button>
                    </p>
                  )}
                  {sharing && !(spoilers.hideOthers && revealed !== `${anime.id}:others`) && anime.community?.count > 0 && (
                    <p className="text-xs text-slate-300 mb-2">{tn('Community: Ø {average} / 10 aus {count} Bewertung', 'Community: Ø {average} / 10 aus {count} Bewertungen', anime.community.count, { count: anime.community.count, average: formatNumber(anime.community.average, 1) })}</p>
                  )}
                  {sharing && !(spoilers.hideOthers && revealed !== `${anime.id}:others`) && (
                    <CommunityRatings animeId={anime.id}
                      version={`${anime.community?.count || 0}:${anime.my_progress?.score || 0}:${anime.my_progress?.rating_visibility || ''}:${anime.my_progress?.public_comment || ''}`} />
                  )}
                  <ul className="space-y-1">
                    {(anime.progress || anime.progress_users).map((p) => (
                      <li key={p.user_id} className="text-xs text-slate-300 flex gap-2">
                        <span className="font-semibold text-slate-100 w-28 truncate">{p.username}</span>
                        <span>{animeProgressLabel(p.status)}</span>
                        {kind !== 'movie' && <span className="font-mono">{seasonEpisodeText(anime, p.episodes_watched) || progressText(p.episodes_watched, anime.episodes, aired)}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {chainSeasons.length > 1 && (
                <section className="mt-5 border-t border-slate-800 pt-4" aria-labelledby={`${titleId}-chain`}>
                  <h3 id={`${titleId}-chain`} ref={chainHeadingRef} tabIndex={-1} className="text-sm font-bold text-white mb-2 outline-none">{t('Staffeln')}</h3>
                  <ol className="space-y-1.5">
                    {chainSeasonLabels(chainSeasons, chainTruncated.before).map(({ season: c, label }) => (
                      <li key={`${c.anilist_id || c.mal_id || c.in_collection_id}`} className="flex items-center gap-2 text-xs" aria-current={c.current ? 'true' : undefined}>
                        <span className="text-slate-400 w-32 shrink-0">{label}</span>
                        <span className={`min-w-0 flex-1 truncate ${c.current ? 'text-white font-semibold' : 'text-slate-200'}`}>
                          {c.title}{c.season_year ? ` (${c.season_year})` : ''}
                          {c.my_status ? <span className="ml-2 text-slate-400">{animeProgressLabel(c.my_status)}</span> : null}
                        </span>
                        {c.current ? null : c.in_collection_id ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" onClick={() => unlessDiscarding(() => onOpenAnime(c.in_collection_id))}>{t('Öffnen')}</button>
                        ) : canEdit && (c.anilist_id || c.mal_id) ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" disabled={busy}
                            onClick={() => run(async () => { await onAdd({ anilist_id: c.anilist_id || undefined, mal_id: c.mal_id || undefined }); notify.success(t('„{title}“ hinzugefügt', { title: c.title })); await load(); setChainRevision((r) => r + 1); })}>
                            {t('Hinzufügen')}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  {(chainTruncated.before || chainTruncated.after) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span>{t('Weitere Staffeln wurden noch nicht geladen.')}</span>
                      <button type="button" ref={chainMoreRef} className="btn-secondary text-[11px] py-1 px-2" disabled={chainLoading} aria-busy={chainLoading || undefined}
                        onClick={() => { chainFocus.current = true; setChainRevision((r) => r + 1); }}>
                        {t('Weitere Staffeln laden')}
                      </button>
                    </div>
                  )}
                </section>
              )}

              {[[extras, t('Filme & Specials')], [relations, t('Verwandte Anime')]].map(([list, heading]) => list.length > 0 && (
                <section key={heading} className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="text-sm font-bold text-white mb-2">{heading}</h3>
                  <ul className="space-y-1.5">
                    {list.map((r) => (
                      <li key={`${r.relation}-${r.anilist_id || r.mal_id}`} className="flex items-center gap-2 text-xs">
                        <span className="text-slate-400 w-32 shrink-0">{relationLabel(r.relation)}</span>
                        <span className="text-slate-200 min-w-0 flex-1 truncate">{r.title}{r.season_year ? ` (${r.season_year})` : ''}{r.my_status ? <span className="ml-2 text-slate-400">{animeProgressLabel(r.my_status)}</span> : null}</span>
                        {r.in_collection_id ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" onClick={() => unlessDiscarding(() => onOpenAnime(r.in_collection_id))}>{t('Öffnen')}</button>
                        ) : canEdit && (r.anilist_id || r.mal_id) ? (
                          <button type="button" className="btn-secondary text-[11px] py-1 px-2" disabled={busy}
                            onClick={() => run(async () => { await onAdd({ anilist_id: r.anilist_id || undefined, mal_id: r.mal_id || undefined }); notify.success(t('„{title}“ hinzugefügt', { title: r.title })); await load(); })}>
                            {t('Hinzufügen')}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}

              {(canEdit || anime.tags?.length > 0) && (
                <section className="mt-5 border-t border-slate-800 pt-4">
                  <TagEditor tags={anime.tags || []} removable={anime.removable_tags} known={knownTags} canEdit={canEdit} busy={busy}
                    onSave={saveTags} />
                </section>
              )}

              {canEdit && (
                <section className="mt-5 border-t border-slate-800 pt-4 grid gap-3 sm:grid-cols-2">
                  <form onSubmit={saveTitle}>
                    <label htmlFor={`${titleId}-de`} className="block text-[11px] text-slate-400 mb-1">{t('Deutscher Titel')}</label>
                    <div className="flex gap-2">
                      <input id={`${titleId}-de`} className="input-field text-base sm:text-sm" maxLength={200} value={titleDe} onChange={(e) => setTitleDe(e.target.value)} />
                      <button type="submit" className="btn-secondary text-xs" disabled={busy}>{t('Speichern')}</button>
                    </div>
                  </form>
                  <div>
                    <label htmlFor={`${titleId}-manga`} className="block text-[11px] text-slate-400 mb-1">{t('Verknüpfte Reihe')}</label>
                    <select id={`${titleId}-manga`} className="input-field text-base sm:text-sm" value={anime.manga_id || ''} disabled={busy}
                      onChange={(e) => saveLink(e.target.value)}>
                      <option value="">{t('Keine Verknüpfung')}</option>
                      {sortedMangas.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                    </select>
                  </div>
                  {anime.manual && (
                    <div>
                      <label htmlFor={`${titleId}-kind`} className="block text-[11px] text-slate-400 mb-1">{t('Art')}</label>
                      <select id={`${titleId}-kind`} className="input-field text-base sm:text-sm" value={kind} disabled={busy} onChange={(e) => saveKind(e.target.value)}>
                        {ANIME_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                      </select>
                    </div>
                  )}
                  {/* only an admin deletes an entry others still have on their list (can_delete_for_all) */}
                  {anime.can_delete_for_all !== false && (
                    <div className="sm:col-span-2 flex justify-end">
                      <button type="button" className="btn-secondary text-xs text-red-300 inline-flex items-center gap-1" onClick={doDelete} disabled={busy}>
                        <Trash className="w-3.5 h-3.5" aria-hidden="true" /> {t('Für alle löschen')}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title={t('Für alle löschen')}
        message={t('„{title}“ für alle löschen? Der Fortschritt aller Benutzer geht verloren.', { title: displayTitle(anime) })}
        confirmLabel={t('Löschen')}
        cancelLabel={t('Abbrechen')}
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
      <ConfirmDialog
        isOpen={discardThen !== null}
        title={t('Ungespeicherte Änderungen verwerfen?')}
        message={t('Deine Eingaben wurden noch nicht gespeichert und gehen verloren.')}
        confirmLabel={t('Verwerfen')}
        cancelLabel={t('Abbrechen')}
        isDanger
        onConfirm={() => {
          const proceed = discardThen;
          setDiscardThen(null);
          proceed?.();
        }}
        onCancel={() => setDiscardThen(null)}
      />
    </div>
  );
}
