import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Flag } from 'lucide-react';
import { CalendarFeedPanel } from '../radar/PersonalSummary';
import CoverImage from '../../common/CoverImage';
import api from '../../../utils/api';
import { calendarDays, dayKey, historyEvents, monthGrid, watchedEpisode, weekStart } from '../../../utils/animeHub';
import { displayTitle, readSetting, writeSetting } from '../../../utils/animeHelpers';
import { formatDayMonth, formatMonth, formatTime, getLocale } from '../../../utils/format';
import { t, tn } from '../../../i18n/index.js';

const weekdayName = (date) => new Intl.DateTimeFormat(getLocale(), { weekday: 'short' }).format(date);

function Event({ event, onOpen }) {
  const { anime } = event;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(anime)}
        className={`w-full text-left flex items-center gap-2 rounded-xl border p-1.5 hover:border-fuchsia-500/60 ${event.past ? 'opacity-80 ' : ''}${event.estimated ? 'border-dashed border-slate-700 bg-slate-900/40' : 'border-slate-700 bg-slate-900/80'}`}
      >
        <span className="w-8 h-11 shrink-0 rounded-md overflow-hidden bg-slate-900 border border-slate-800">
          <CoverImage src={anime.cover_image} className="w-full h-full object-cover" fallback={<span className="block w-full h-full" />} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-white line-clamp-2 break-words">{displayTitle(anime)}</span>
          {event.finished ? (
            <span className="block text-[11px] text-emerald-300 inline-flex items-center gap-1"><Flag className="w-3 h-3" aria-hidden="true" /> {t('Abgeschlossen')}</span>
          ) : (
            <span className={`block text-[11px] ${event.past ? 'text-slate-400' : 'text-fuchsia-300'}`}>
              {event.episode ? t('Folge {episode}', { episode: event.episode }) : t('Neue Folge')} · {formatTime(new Date(event.at))}
              {event.estimated && <span className="text-slate-400"> {t('(geschätzt)')}</span>}
              {event.past && watchedEpisode(event) && <Check className="w-3 h-3 inline ml-1 text-emerald-400" aria-label={t('gesehen')} />}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

const VIEW_KEY = 'mangashelf_anime_calendar_view';

/** The month as a grid: a count of episodes per day, a tap opens that day's list below. */
function MonthGrid({ days, month, today, selected, onSelect }) {
  const names = days.slice(0, 7).map((d) => weekdayName(d.date));
  return (
    <div role="grid" aria-label={t('Monatsansicht')} className="grid grid-cols-7 gap-1">
      {names.map((name) => <div key={name} role="columnheader" className="text-[11px] font-bold uppercase text-slate-400 text-center pb-1">{name}</div>)}
      {days.map((day) => {
        const inMonth = day.date.getMonth() === month;
        const count = day.events.length;
        return (
          <button
            key={day.key}
            type="button"
            role="gridcell"
            aria-pressed={selected === day.key}
            aria-label={`${day.date.getDate()}.${day.date.getMonth() + 1}. · ${count ? tn('{n} Folge', '{n} Folgen', count) : t('keine Folge')}`}
            onClick={() => onSelect(day.key)}
            className={`min-h-14 sm:min-h-20 rounded-xl border p-1.5 text-left flex flex-col justify-between ${selected === day.key ? 'border-fuchsia-400 bg-fuchsia-500/10' : day.key === today ? 'border-fuchsia-500/60' : 'border-slate-800 bg-slate-950/60'} ${inMonth ? '' : 'opacity-40'}`}
          >
            <span className="text-xs font-mono text-slate-300">{day.date.getDate()}</span>
            {count > 0 && (
              <span className="self-end inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-full bg-fuchsia-600/70 text-white text-[11px] font-bold">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The year as twelve small months: a day with episodes is marked, a tap on a month opens it in the month view. */
function YearGrid({ list, year, today, mineOnly, extra, onOpenMonth }) {
  const months = useMemo(() => Array.from({ length: 12 }, (_, m) => {
    const grid = monthGrid(new Date(year, m, 1));
    const days = calendarDays(list, grid.start, grid.weeks * 7, { mineOnly, extra });
    return { m, days, count: days.filter((d) => d.date.getMonth() === m).reduce((n, d) => n + d.events.length, 0) };
  }), [list, year, mineOnly, extra]);
  return (
    <ol className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4" id="anime-calendar-year">
      {months.map(({ m, days, count }) => (
        <li key={m}>
          <button type="button" onClick={() => onOpenMonth(m)} aria-label={`${formatMonth(`${year}-${m + 1}-01`)} · ${count ? tn('{n} Folge', '{n} Folgen', count) : t('keine Folge')}`}
            className="w-full text-left rounded-2xl border border-slate-800 bg-slate-950/60 p-2.5 hover:border-fuchsia-500/60">
            <p className="text-xs font-bold text-slate-200 mb-1.5 flex justify-between">
              <span>{formatMonth(`${year}-${m + 1}-01`, { year: false })}</span>
              {count > 0 && <span className="font-mono text-fuchsia-300">{count}</span>}
            </p>
            <div className="grid grid-cols-7 gap-0.5" aria-hidden="true">
              {days.map((d) => {
                const inMonth = d.date.getMonth() === m;
                const n = d.events.length;
                return (
                  <span key={d.key} className={`h-4 rounded-sm text-[8px] leading-4 text-center font-mono ${!inMonth ? 'opacity-0' : n ? 'bg-fuchsia-600/80 text-white' : d.key === today ? 'border border-fuchsia-500/70 text-slate-300' : 'text-slate-400'}`}>
                    {inMonth ? d.date.getDate() : ''}
                  </span>
                );
              })}
            </div>
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * Tab "Kalender": week or month with the airing times of my anime (Schaue and Geplant), the following weeks as estimates, and the
 * iCal subscription of the same times.
 */
export default function AnimeCalendarTab({ list, now, onOpen }) {
  const [view, setView] = useState(() => readSetting(VIEW_KEY, 'week', (v) => ['week', 'month', 'year'].includes(v)));
  const [offset, setOffset] = useState(0);
  const [mineOnly, setMineOnly] = useState(true);
  const [feedOpen, setFeedOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const month = view === 'month';
  const year = view === 'year';
  const grid = useMemo(() => monthGrid(now, offset), [now, offset]);
  const shownYear = now.getFullYear() + offset;
  const start = useMemo(() => (month ? grid.start : weekStart(now, offset)), [month, grid, now, offset]);
  // history (aired episodes, finished days) for what is on screen, only when it reaches into the past
  const rangeStart = year ? new Date(shownYear, 0, 1) : start;
  const rangeEnd = year ? new Date(shownYear, 11, 31) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + (month ? grid.weeks * 7 : 7) - 1);
  const needsHistory = dayKey(rangeStart) <= dayKey(now);
  const fromKey = dayKey(rangeStart);
  const toKey = dayKey(rangeEnd);
  const [history, setHistory] = useState(null);
  useEffect(() => {
    if (!needsHistory) { setHistory(null); return undefined; }
    let alive = true;
    api.get(`/api/anime/history?from=${fromKey}&to=${toKey}`, { fallback: t('Verlauf konnte nicht geladen werden') })
      .then((data) => { if (alive) setHistory(data); })
      .catch(() => { if (alive) setHistory(null); });
    return () => { alive = false; };
  }, [needsHistory, fromKey, toKey, list.length]);
  const extra = useMemo(() => historyEvents(history, list).filter((event) => !mineOnly || event.anime.my_progress), [history, list, mineOnly]);
  const days = useMemo(() => calendarDays(list, start, month ? grid.weeks * 7 : 7, { mineOnly, extra }), [list, start, month, grid, mineOnly, extra]);
  const today = dayKey(now);
  const inRange = month ? days.filter((d) => d.date.getMonth() === grid.first.getMonth()) : days;
  const yearTotal = useMemo(() => (year
    ? calendarDays(list, new Date(shownYear, 0, 1), 366, { mineOnly, extra }).filter((d) => d.date.getFullYear() === shownYear).reduce((n, d) => n + d.events.length, 0) : 0), [year, list, shownYear, mineOnly, extra]);
  const total = year ? yearTotal : inRange.reduce((sum, d) => sum + d.events.length, 0);
  const end = days[days.length - 1].date;
  const chooseView = (next) => { setView(next); setOffset(0); setPicked(null); writeSetting(VIEW_KEY, next); };
  const step = (delta) => { setOffset(offset + delta); setPicked(null); };
  const shownDay = month ? days.find((d) => d.key === (picked || (inRange.some((d) => d.key === today) ? today : null))) : null;
  const heading = year ? String(shownYear) : month ? formatMonth(`${grid.first.getFullYear()}-${grid.first.getMonth() + 1}-01`) : `${formatDayMonth(start, now)} – ${formatDayMonth(end, now)}`;
  const seg = (key) => `px-3 py-1.5 rounded-lg text-xs font-semibold ${view === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`;
  return (
    <div id="anime-calendar">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div role="group" aria-label={t('Ansicht')} className="inline-flex gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-xl">
          <button type="button" aria-pressed={!month} className={seg('week')} onClick={() => chooseView('week')}>{t('Woche')}</button>
          <button type="button" aria-pressed={month} className={seg('month')} onClick={() => chooseView('month')}>{t('Monat')}</button>
          <button type="button" aria-pressed={year} className={seg('year')} onClick={() => chooseView('year')}>{t('Jahr')}</button>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label={year ? t('Jahr wählen') : month ? t('Monat wählen') : t('Woche wählen')}>
          <button type="button" className="btn-secondary p-2" aria-label={year ? t('Vorheriges Jahr') : month ? t('Vorheriger Monat') : t('Vorherige Woche')} onClick={() => step(-1)}><ChevronLeft className="w-4 h-4" aria-hidden="true" /></button>
          <button type="button" className="btn-secondary text-xs py-2 px-3" disabled={offset === 0} onClick={() => step(-offset)}>{year ? t('Dieses Jahr') : month ? t('Dieser Monat') : t('Diese Woche')}</button>
          <button type="button" className="btn-secondary p-2" aria-label={year ? t('Nächstes Jahr') : month ? t('Nächster Monat') : t('Nächste Woche')} onClick={() => step(1)}><ChevronRight className="w-4 h-4" aria-hidden="true" /></button>
        </div>
        <p className="text-sm font-semibold text-slate-200 flex items-center gap-1.5" aria-live="polite">
          <CalendarDays className="w-4 h-4 text-fuchsia-400" aria-hidden="true" /> {heading}
        </p>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          {t('Nur meine Anime')}
        </label>
        <button type="button" id="btn-anime-calendar-feed" aria-expanded={feedOpen} aria-controls="anime-calendar-feed" onClick={() => setFeedOpen(!feedOpen)}
          className="btn-secondary text-xs py-2 px-3 inline-flex items-center gap-1.5">
          <CalendarPlus className="w-4 h-4" aria-hidden="true" /> {t('Kalender abonnieren')}
        </button>
      </div>
      {feedOpen && <div className="mb-4"><CalendarFeedPanel anime /></div>}
      {total === 0 && (
        <p className="text-sm text-slate-400 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-6 text-center mb-3">
          {year ? t('In diesem Jahr ist noch keine Folge deiner Anime bekannt. Termine kennt AniList nur für die nächsten Wochen.') : month ? t('In diesem Monat erscheint keine Folge deiner Anime. Sobald ein Termin bekannt ist, steht er hier.') : t('In dieser Woche erscheint keine Folge deiner Anime. Sobald ein Termin bekannt ist, steht er hier.')}
        </p>
      )}
      {year ? (
        <YearGrid list={list} year={shownYear} today={today} mineOnly={mineOnly} extra={extra}
          onOpenMonth={(m) => { setView('month'); writeSetting(VIEW_KEY, 'month'); setOffset((shownYear - now.getFullYear()) * 12 + m - now.getMonth()); setPicked(null); }} />
      ) : month ? (
        <>
          <MonthGrid days={days} month={grid.first.getMonth()} today={today} selected={shownDay ? shownDay.key : null} onSelect={(key) => setPicked(key)} />
          {shownDay && (
            <section className="mt-4" aria-live="polite" id="anime-calendar-day">
              <h3 className="text-sm font-bold text-slate-200 mb-2">{weekdayName(shownDay.date)} {shownDay.date.getDate()}.{shownDay.date.getMonth() + 1}.</h3>
              {shownDay.events.length === 0
                ? <p className="text-xs text-slate-400">{t('Keine Folge an diesem Tag.')}</p>
                : <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{shownDay.events.map((event) => <Event key={`${event.anime.id}-${event.episode}-${event.at}`} event={event} onOpen={onOpen} />)}</ul>}
            </section>
          )}
        </>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {days.map((day) => (
            <li key={day.key} className={`rounded-2xl border p-2 lg:min-h-24 ${day.key === today ? 'border-fuchsia-500/60 bg-fuchsia-500/5' : 'border-slate-800 bg-slate-950/60'}`}>
              <p className="text-xs font-bold text-slate-300 mb-1.5 flex items-baseline gap-1.5">
                <span className="uppercase tracking-wide">{weekdayName(day.date)}</span>
                <span className="font-mono text-slate-400">{day.date.getDate()}.{day.date.getMonth() + 1}.</span>
                {day.key === today && <span className="text-[10px] text-fuchsia-300">{t('heute')}</span>}
              </p>
              {day.events.length === 0
                ? <p className="text-[11px] text-slate-400">–</p>
                : <ul className="space-y-1.5">{day.events.map((event) => <Event key={`${event.anime.id}-${event.episode}-${event.at}`} event={event} onOpen={onOpen} />)}</ul>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
