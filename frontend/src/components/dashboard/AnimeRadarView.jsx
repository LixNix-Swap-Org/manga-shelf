import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CalendarClock, Link2, Unlink } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import useTabList from '../../hooks/useTabList';
import { countdownText, displayTitle, kindOf, mangaLinks, newEpisodes } from '../../utils/animeHelpers';
import { formatCount } from '../../utils/format';
import { t, tn } from '../../i18n/index.js';

const TABS = ['episodes', 'manga'];

function Row({ children }) {
  return <li className="glass-card rounded-2xl border border-slate-800 p-3 flex items-center gap-3">{children}</li>;
}

function Thumb({ anime }) {
  return (
    <div className="w-10 h-14 shrink-0 rounded-lg overflow-hidden bg-slate-900">
      <CoverImage src={anime.cover_image} className="w-full h-full object-cover" />
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

function EpisodesTab({ list, now, onOpen }) {
  const { upcoming, behind } = useMemo(() => newEpisodes(list, now), [list, now]);
  if (!upcoming.length && !behind.length) {
    return <Empty>{t('Keine neuen Folgen in Sicht. Anime, die du schaust oder planst, erscheinen hier, sobald ein Termin bekannt ist.')}</Empty>;
  }
  return (
    <>
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
                <p className="text-xs text-slate-400 mt-0.5">{t('Du bist bei Folge {n}', { n: anime.my_progress.episodes_watched || 0 })}</p>
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

function MangaTab({ list, mangas, canEdit, onLink }) {
  const { linked, suggestions } = useMemo(() => mangaLinks(list, mangas), [list, mangas]);
  const [busy, setBusy] = useState(null);
  const run = async (id, mangaId) => {
    setBusy(id);
    try { await onLink(id, mangaId); } finally { setBusy(null); }
  };
  if (!linked.length && !suggestions.length) {
    return <Empty>{t('Noch keine Verknüpfung. Verknüpfe einen Anime im Detaildialog mit einer Reihe deiner Sammlung, oder lege ihn über „Anime-Adaption“ an der Reihe an.')}</Empty>;
  }
  return (
    <>
      {suggestions.length > 0 && (
        <Section title={t('Vorschläge')} count={suggestions.length}>
          {suggestions.map(({ anime, manga }) => (
            <Row key={anime.id}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white line-clamp-2 break-words">{displayTitle(anime)}</p>
                <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{t('Passt zu „{title}“ im Regal', { title: manga.title })}</p>
              </div>
              {canEdit && (
                <button type="button" disabled={busy === anime.id} onClick={() => run(anime.id, manga.id)}
                  className="hit-44 shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fuchsia-700 hover:bg-fuchsia-800 text-white text-xs font-semibold disabled:opacity-60">
                  <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('Verknüpfen')}
                </button>
              )}
            </Row>
          ))}
        </Section>
      )}
      {linked.length > 0 && (
        <Section title={t('Verknüpft')} count={linked.length}>
          {linked.map(({ anime, manga }) => (
            <Row key={anime.id}>
              <Thumb anime={anime} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white line-clamp-2 break-words">{displayTitle(anime)}</p>
                {manga ? (
                  <Link to={`/manga/${manga.id}`} className="text-xs text-sky-300 hover:underline inline-flex items-center gap-1.5 mt-0.5">
                    <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                    {manga.title}
                    <span className="text-slate-400">· {manga.total_volumes > 0
                      ? `${manga.regular_owned ?? manga.owned_volumes ?? 0} / ${formatCount(manga.total_volumes, 'Band', 'Bände')}`
                      : formatCount(manga.owned_volumes || 0, 'Band', 'Bände')}</span>
                  </Link>
                ) : <p className="text-xs text-slate-400 mt-0.5">{t('Die Reihe ist nicht mehr in der Sammlung.')}</p>}
              </div>
              {canEdit && (
                <button type="button" disabled={busy === anime.id} onClick={() => run(anime.id, null)} aria-label={t('Verknüpfung lösen')} title={t('Verknüpfung lösen')}
                  className="hit-44 shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-60">
                  <Unlink className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}

/** Tab "Anime-Radar": new episodes of my anime and the links between anime and series of the shelf. */
export default function AnimeRadarView({ list, mangas, loaded, error, canEdit, onOpen, onLink, onRetry, now = new Date() }) {
  const [tab, setTab] = useState('episodes');
  const { tabListProps, tabProps, panelProps } = useTabList({ tabs: TABS, selected: tab, onSelect: setTab, prefix: 'anime-radar' });
  const labels = { episodes: t('Neue Folgen'), manga: t('Manga-Verknüpfung') };
  return (
    <div id="anime-radar-view">
      <h1 className="sr-only">{t('Anime-Radar')}</h1>
      <div {...tabListProps} aria-label={t('Bereiche')} className="inline-flex gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl mb-4">
        {TABS.map((key) => (
          <button key={key} {...tabProps(key)} className={`px-3 py-1.5 [@media(pointer:coarse)]:py-3 rounded-lg text-sm font-semibold ${tab === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>
            {labels[key]}
          </button>
        ))}
      </div>
      {error && !list.length && (
        <p role="alert" className="text-sm text-rose-300 mb-3">{error} <button type="button" className="underline" onClick={onRetry}>{t('Erneut versuchen')}</button></p>
      )}
      <div {...panelProps}>
        {!loaded && !list.length ? <Empty>{t('Lädt…')}</Empty>
          : tab === 'episodes' ? <EpisodesTab list={list} now={now} onOpen={onOpen} />
            : <MangaTab list={list} mangas={mangas} canEdit={canEdit} onLink={onLink} />}
      </div>
    </div>
  );
}
