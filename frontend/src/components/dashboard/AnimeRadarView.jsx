import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Bell, CalendarClock, Link2, Tv, Unlink } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import useTabList from '../../hooks/useTabList';
import { countdownText, displayTitle, kindOf, mangaLinks, newEpisodes } from '../../utils/animeHelpers';
import AnimeCalendarTab from './animehub/AnimeCalendarTab';
import AnimeTogetherTab from './animehub/AnimeTogetherTab';
import AnimeDiscoverTab from './animehub/AnimeDiscoverTab';
import { formatCount } from '../../utils/format';
import { compareNatural } from '../../utils/search';
import { t, tn } from '../../i18n/index.js';

const TABS = ['episodes', 'calendar', 'together', 'discover', 'manga'];

// entries whose cover was already asked for: remembered per device for a week, so a source without a cover is not asked at every visit
const COVER_TRIED_KEY = 'mangashelf_cover_tried';
const COVER_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COVER_LOOKUPS = 8;
const coverTried = new Map();
function loadCoverTried() {
  if (coverTried.size) return coverTried;
  try {
    const stored = JSON.parse(window.localStorage.getItem(COVER_TRIED_KEY) || '{}');
    const cutoff = Date.now() - COVER_RETRY_MS;
    Object.entries(stored).forEach(([id, at]) => { if (Number(at) > cutoff) coverTried.set(Number(id), Number(at)); });
  } catch (_) { /* storage unavailable: once per page session */ }
  return coverTried;
}
function markCoverTried(id) {
  coverTried.set(id, Date.now());
  try { window.localStorage.setItem(COVER_TRIED_KEY, JSON.stringify(Object.fromEntries(coverTried))); } catch (_) { /* ignore */ }
}
const hasSource = (a) => Boolean(a.anilist_id || a.mal_id || a.tmdb_id);

function Row({ children, action }) {
  return (
    <li className="glass-card rounded-2xl border border-slate-800 p-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-3 min-w-0 flex-1 basis-48">{children}</div>
      {action}
    </li>
  );
}

function Thumb({ anime }) {
  return (
    <div className="w-12 h-16 shrink-0 rounded-lg overflow-hidden bg-slate-900 border border-slate-800">
      <CoverImage src={anime.cover_image} className="w-full h-full object-cover"
        fallback={<div className="w-full h-full flex items-center justify-center text-slate-400"><Tv className="w-5 h-5" aria-hidden="true" /></div>} />
    </div>
  );
}

function Empty({ children }) {
  return <p className="text-sm text-slate-400 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-6 text-center">{children}</p>;
}

function Section({ title, count, children }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-bold text-slate-200 mb-2">{title} <span className="font-mono text-xs text-slate-400">{count}</span></h2>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

function AlertsToggle({ alerts }) {
  if (!alerts) return null;
  const blocked = alerts.permission === 'denied';
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300" id="anime-alerts">
      <label className="inline-flex items-center gap-2">
        <input type="checkbox" checked={alerts.enabled} onChange={(e) => (e.target.checked ? alerts.enable() : alerts.disable())} />
        <Bell className="w-3.5 h-3.5 text-fuchsia-400" aria-hidden="true" /> {t('Hinweis, wenn eine neue Folge erscheint')}
      </label>
      <span className="text-slate-400">
        {blocked ? t('Benachrichtigungen sind im Browser blockiert, es erscheint nur ein Hinweis in der App.') : t('Solange Manga Shelf geöffnet ist. Ohne App: Kalender abonnieren.')}
      </span>
    </div>
  );
}

function EpisodesTab({ list, now, onOpen, alerts }) {
  const { upcoming, behind } = useMemo(() => newEpisodes(list, now), [list, now]);
  if (!upcoming.length && !behind.length) {
    return <><AlertsToggle alerts={alerts} /><Empty>{t('Keine neuen Folgen in Sicht. Anime, die du schaust oder planst, erscheinen hier, sobald ein Termin bekannt ist.')}</Empty></>;
  }
  return (
    <>
      <AlertsToggle alerts={alerts} />
      {upcoming.length > 0 && (
        <Section title={t('Demnächst')} count={upcoming.length}>
          {upcoming.map((anime) => (
            <Row key={anime.id}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => onOpen(anime)} className="text-left font-semibold text-white hover:underline line-clamp-2 break-words">{displayTitle(anime)}</button>
                <p className="text-xs text-fuchsia-300 flex items-center gap-1.5 mt-0.5">
                  <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                  {countdownText(anime.next_airing, now, kindOf(anime))}
                  {anime.next_airing.estimated && <span className="text-slate-400">{t('(geschätzt)')}</span>}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">{tn('{n} Folge gesehen', '{n} Folgen gesehen', anime.my_progress.episodes_watched || 0)}</p>
              </div>
            </Row>
          ))}
        </Section>
      )}
      {behind.length > 0 && (
        <Section title={t('Zum Nachschauen')} count={behind.length}>
          {behind.map(({ anime, missing }) => (
            <Row key={anime.id}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => onOpen(anime)} className="text-left font-semibold text-white hover:underline line-clamp-2 break-words">{displayTitle(anime)}</button>
                <p className="text-xs text-emerald-300 mt-0.5">{tn('{n} Folge offen', '{n} Folgen offen', missing)}</p>
              </div>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}

/**
 * "Reihe wählen…" over the shelf: picking a series links the entry; the choice stays visible while the link is saved.
 * The shelf's options appear once the select is used, so a long list without links does not hold rows × series options.
 */
function LinkSelect({ anime, shelf, busy, onPick }) {
  const [value, setValue] = useState('');
  const [opened, setOpened] = useState(false);
  const open = () => setOpened(true);
  const pick = (e) => {
    if (!e.target.value) return;
    setValue(e.target.value);
    onPick(Number(e.target.value)).finally(() => setValue(''));
  };
  return (
    <select value={value} disabled={busy} onChange={pick} onFocus={open} onPointerDown={open}
      aria-label={t('Reihe für „{title}“ wählen', { title: displayTitle(anime) })} className="input-field mt-2 w-full sm:max-w-xs disabled:opacity-60">
      <option value="">{t('Reihe wählen…')}</option>
      {opened && shelf.map((manga) => <option key={manga.id} value={manga.id}>{manga.title}</option>)}
    </select>
  );
}

function MangaTab({ list, mangas, canEdit, onLink }) {
  const { linked, suggestions, unlinked } = useMemo(() => mangaLinks(list, mangas), [list, mangas]);
  const shelf = useMemo(() => [...(mangas || [])].sort((a, b) => compareNatural(a.title, b.title)), [mangas]);
  const [busy, setBusy] = useState(null);
  const run = async (id, mangaId) => {
    setBusy(id);
    try { await onLink(id, mangaId); } finally { setBusy(null); }
  };
  if (!linked.length && !suggestions.length && !unlinked.length) {
    return <Empty>{t('Noch keine Verknüpfung. Verknüpfe einen Anime im Detaildialog mit einer Reihe deiner Sammlung, oder lege ihn über „Anime-Adaption“ an der Reihe an.')}</Empty>;
  }
  return (
    <>
      {suggestions.length > 0 && (
        <Section title={t('Vorschläge')} count={suggestions.length}>
          {suggestions.map(({ anime, manga }) => (
            <Row key={anime.id} action={canEdit && (
              <button type="button" disabled={busy === anime.id} onClick={() => run(anime.id, manga.id)}
                className="hit-44 shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-fuchsia-700 hover:bg-fuchsia-800 text-white text-xs font-semibold disabled:opacity-60 max-[420px]:w-full">
                <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('Verknüpfen')}
              </button>
            )}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white line-clamp-2 break-words">{displayTitle(anime)}</p>
                <p className="text-xs text-slate-400 mt-0.5 line-clamp-2 break-words">{t('Passt zu „{title}“ im Regal', { title: manga.title })}</p>
              </div>
            </Row>
          ))}
        </Section>
      )}
      {linked.length > 0 && (
        <Section title={t('Verknüpft')} count={linked.length}>
          {linked.map(({ anime, manga }) => (
            <Row key={anime.id} action={canEdit && (
              <button type="button" disabled={busy === anime.id} onClick={() => run(anime.id, null)} aria-label={t('Verknüpfung lösen')} title={t('Verknüpfung lösen')}
                className="hit-44 shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-60">
                <Unlink className="w-4 h-4" aria-hidden="true" />
              </button>
            )}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white line-clamp-2 break-words">{displayTitle(anime)}</p>
                {manga ? (
                  <Link to={`/manga/${manga.id}`} className="text-xs text-sky-300 hover:underline inline-flex flex-wrap items-center gap-x-1.5 mt-0.5 break-words">
                    <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                    {manga.title}
                    <span className="text-slate-400">· {manga.total_volumes > 0
                      ? t('{owned} von {volumes}', { owned: manga.regular_owned ?? manga.owned_volumes ?? 0, volumes: formatCount(manga.total_volumes, 'Band', 'Bänden') })
                      : formatCount(manga.owned_volumes || 0, 'Band', 'Bände')}</span>
                  </Link>
                ) : <p className="text-xs text-slate-400 mt-0.5">{t('Die Reihe ist nicht mehr in der Sammlung.')}</p>}
              </div>
            </Row>
          ))}
        </Section>
      )}
      {unlinked.length > 0 && (
        <Section title={t('Ohne Verknüpfung')} count={unlinked.length}>
          {unlinked.map((anime) => (
            <Row key={anime.id}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white line-clamp-2 break-words">{displayTitle(anime)}</p>
                {canEdit && shelf.length > 0 && (
                  <LinkSelect anime={anime} shelf={shelf} busy={busy === anime.id} onPick={(mangaId) => run(anime.id, mangaId)} />
                )}
              </div>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}

/** Tab "Anime-Radar": new episodes of my anime and the links between anime and series of the shelf. */
export default function AnimeRadarView({ list, mangas, loaded, error, canEdit, userId, username, onOpen, onOpenId, onLink, onRetry, onRefreshCover, onAddEntry, alerts, now = new Date() }) {
  const [tab, setTab] = useState('episodes');
  // new entries from a source can arrive without a cover (background download pending or failed): ask the source once each
  useEffect(() => {
    if (!canEdit || !onRefreshCover) return undefined;
    const tried = loadCoverTried();
    const todo = list.filter((a) => !a.cover_image && hasSource(a) && !tried.has(a.id)).slice(0, MAX_COVER_LOOKUPS);
    if (!todo.length) return undefined;
    let cancelled = false;
    (async () => {
      for (const a of todo) {
        if (cancelled) return;
        markCoverTried(a.id);
        try { await onRefreshCover(a.id); } catch (_) { /* stays without a cover; the detail dialog has "Aktualisieren" */ }
      }
    })();
    return () => { cancelled = true; };
  }, [list, canEdit, onRefreshCover]);
  const { tabListProps, tabProps, panelProps } = useTabList({ tabs: TABS, selected: tab, onSelect: setTab, prefix: 'anime-radar' });
  const labels = { episodes: t('Neue Folgen'), calendar: t('Kalender'), together: t('Gemeinsam'), discover: t('Entdecken'), manga: t('Manga-Verknüpfung') };
  return (
    <div id="anime-radar-view">
      <h2 className="sr-only">{t('Anime-Radar')}</h2>
      {/* five tabs do not fit a phone in every language: they wrap into a second row instead of hiding behind a scroll */}
      <div {...tabListProps} aria-label={t('Bereiche')} className="flex flex-wrap w-full max-w-full sm:inline-flex sm:flex-nowrap sm:w-auto gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl mb-4">
        {TABS.map((key) => (
          <button key={key} {...tabProps(key)} className={`flex-1 sm:flex-none whitespace-nowrap px-3 py-1.5 [@media(pointer:coarse)]:py-3 rounded-lg text-sm font-semibold ${tab === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>
            {labels[key]}
          </button>
        ))}
      </div>
      {error && !list.length && (
        <p role="alert" className="text-sm text-rose-300 mb-3">{error} <button type="button" className="underline" onClick={onRetry}>{t('Erneut versuchen')}</button></p>
      )}
      <div {...panelProps}>
        {!loaded && !list.length ? <Empty>{t('Lädt…')}</Empty>
          : tab === 'episodes' ? <EpisodesTab list={list} now={now} onOpen={onOpen} alerts={alerts} />
            : tab === 'calendar' ? <AnimeCalendarTab list={list} now={now} onOpen={onOpen} />
              : tab === 'together' ? <AnimeTogetherTab list={list} userId={userId} username={username} onOpen={onOpen} />
                : tab === 'discover' ? <AnimeDiscoverTab canEdit={canEdit} now={now} onAdd={onAddEntry} onOpenId={onOpenId} />
            : <MangaTab list={list} mangas={mangas} canEdit={canEdit} onLink={onLink} />}
      </div>
    </div>
  );
}
