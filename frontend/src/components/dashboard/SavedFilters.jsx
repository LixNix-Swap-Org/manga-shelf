import { useEffect, useState } from 'react';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';
import { COLLECT_FILTERS, STATUS_TABS } from '../../utils/collectionHelpers';
import { del, get, post } from '../../utils/api';
import { t } from '../../i18n/index.js';

// Saved filter sets of the collection ("Gemerkte Filter"): per account on the server (GET/POST/DELETE
// /api/saved-filters), at most SAVED_FILTER_LIMIT. The browser list under KEY_PREFIX is what older versions kept on
// this device, and what is saved while the server cannot be reached: it is handed to the server on the next load and
// then cleared.
const KEY_PREFIX = 'mangashelf_saved_filters';
export const SAVED_FILTER_LIMIT = 8;
const FIELDS = ['status', 'publisher', 'collect', 'author', 'tags', 'lang', 'shelf', 'person', 'sort', 'group'];

const keyOf = (userId) => `${KEY_PREFIX}:${userId ?? 'local'}`;

export function readSavedFilters(userId) {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(keyOf(userId)) || '[]');
    return Array.isArray(list) ? list.filter((f) => f && typeof f.label === 'string' && f.filters && typeof f.filters === 'object') : [];
  } catch (_) {
    return [];
  }
}

function writeSavedFilters(userId, list) {
  try {
    if (list.length) globalThis.localStorage?.setItem(keyOf(userId), JSON.stringify(list));
    else globalThis.localStorage?.removeItem(keyOf(userId));
  } catch (_) { /* storage blocked: only this visit */ }
}

const API = '/api/saved-filters';
const serverList = (body) => (Array.isArray(body?.items) ? body.items : [])
  .filter((f) => f && typeof f.label === 'string' && f.filters && typeof f.filters === 'object')
  .map((f) => ({ id: f.id, label: f.label, filters: filterSnapshot(f.filters) }));

/**
 * The server's list; entries kept in this browser go to the server first (oldest first, the server skips a set it
 * has already) and leave the browser once it took them.
 */
export async function loadSavedFilters(userId, { signal } = {}) {
  const local = readSavedFilters(userId);
  let body = await get(API, { signal });
  for (const entry of local) {
    body = await post(API, { label: entry.label, filters: filterSnapshot(entry.filters) }, { signal });
  }
  if (local.length) writeSavedFilters(userId, []);
  return serverList(body);
}

/** The filter set as stored: tags sorted case-insensitively, so the same choice compares equal. */
export function filterSnapshot(state) {
  const tags = (Array.isArray(state.tags) ? state.tags : []).map(String).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return {
    status: state.status || 'ALL',
    publisher: state.publisher || 'ALL',
    collect: state.collect || 'ALL',
    author: state.author || '',
    tags,
    lang: state.lang || 'ALL',
    shelf: String(state.shelf ?? 'ALL'),
    person: String(state.person ?? 'ALL'),
    sort: state.sort || 'title_asc',
    group: state.group || 'none'
  };
}

// the stored name, made in the language of the moment it was saved
const savedName = (f) => f.label;

export const sameFilters = (a, b) => FIELDS.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));

/** A short name for a filter set from its parts: shelf, status, publisher, collecting state, author, tags, language. */
export function filterLabel(filters, { shelves = [], persons = [], userId = null } = {}) {
  const parts = [];
  if (filters.shelf !== 'ALL') parts.push(shelves.find((s) => String(s.id) === filters.shelf)?.name || t('Regal'));
  if (filters.person && filters.person !== 'ALL') {
    parts.push(String(filters.person) === String(userId) ? t('Ich') : (persons.find((p) => String(p.id) === filters.person)?.name || t('Person')));
  }
  if (filters.status !== 'ALL') {
    const tab = STATUS_TABS.find((x) => x.id === filters.status);
    if (tab) parts.push(t(tab.label));
  }
  if (filters.publisher !== 'ALL') parts.push(filters.publisher);
  if (filters.collect !== 'ALL') {
    const c = COLLECT_FILTERS.find((x) => x.id === filters.collect);
    if (c) parts.push(t(c.label));
  }
  if (filters.author) parts.push(filters.author);
  if (filters.tags.length) parts.push(filters.tags.join(', '));
  if (filters.lang !== 'ALL') parts.push(filters.lang.toUpperCase());
  return parts.length ? parts.join(' · ') : t('Alle Reihen');
}

/**
 * "Gemerkte Filter": chips that set a saved combination of the collection filters (shelf, status, publisher,
 * collecting state, author, tags, language, sort, grouping) at once, plus "Aktuelle Auswahl merken". Hidden while
 * nothing is saved and no filter is set.
 */
export default function SavedFilters({ userId, offline = false, current, apply, shelves = [], persons = [], filtersActive, embedded = false }) {
  // the server's entries, plus the ones only kept in this browser while the server was out of reach
  const [server, setServer] = useState([]);
  const [local, setLocal] = useState(() => readSavedFilters(userId));
  const [owner, setOwner] = useState(userId);
  if (owner !== userId) {
    setOwner(userId);
    setServer([]);
    setLocal(readSavedFilters(userId));
  }
  useEffect(() => {
    // offline copy: the server is out of reach, the browser's entries are all there is until it is back
    if (offline) return undefined;
    const controller = new AbortController();
    loadSavedFilters(userId, { signal: controller.signal })
      .then((list) => {
        if (controller.signal.aborted) return;
        setServer(list);
        setLocal(readSavedFilters(userId));
      })
      .catch(() => { /* not reachable: the browser's entries stay in view and go to the server next time */ });
    return () => controller.abort();
  }, [userId, offline]);

  const saved = [...server, ...local.filter((l) => !server.some((f) => sameFilters(f.filters, l.filters)))];
  const now = filterSnapshot(current);
  const alreadySaved = saved.some((f) => sameFilters(f.filters, now));
  if (!saved.length && !filtersActive && !embedded) return null;

  const keepLocal = (list) => {
    setLocal(list);
    writeSavedFilters(userId, list);
  };
  const save = () => {
    if (alreadySaved) return;
    const label = filterLabel(now, { shelves, persons, userId });
    const entry = { id: `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, filters: now };
    // shown at once; the server's answer replaces it
    keepLocal([...local, entry].slice(-SAVED_FILTER_LIMIT));
    if (offline) return;
    post(API, { label, filters: now })
      .then((body) => {
        setServer(serverList(body));
        keepLocal(readSavedFilters(userId).filter((x) => x.id !== entry.id));
      })
      .catch(() => { /* kept in this browser until the server can take it */ });
  };
  const remove = (f) => {
    if (local.some((x) => x.id === f.id)) keepLocal(local.filter((x) => x.id !== f.id));
    if (typeof f.id !== 'number' || offline) return;
    setServer((list) => list.filter((x) => x.id !== f.id));
    del(`${API}/${f.id}`)
      .then((body) => setServer(serverList(body)))
      .catch(() => setServer((list) => (list.some((x) => x.id === f.id) ? list : [...list, f].sort((a, b) => a.id - b.id))));
  };

  return (
    <div role="group" aria-label={t('Gemerkte Filter')} id="saved-filters" className={`${embedded ? 'border-t border-slate-800 pt-3' : '-mt-3 mb-6'} flex flex-wrap items-center gap-2 text-xs`}>
      <span className="flex items-center gap-1 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
        <Bookmark className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Gemerkt')}
      </span>
      {saved.map((f) => {
        const active = sameFilters(f.filters, now);
        return (
          <span key={f.id} className={`flex items-center rounded-full border ${active ? 'border-brand-500/50 bg-brand-500/20 text-brand-100' : 'border-slate-700 bg-slate-900/80 text-slate-200'}`}>
            <button type="button" aria-pressed={active} onClick={() => apply(f.filters)} className="pl-3 pr-1.5 py-1.5 max-w-[240px] truncate">
              {savedName(f)}
            </button>
            <button
              type="button"
              onClick={() => remove(f)}
              disabled={offline && typeof f.id === 'number'}
              aria-label={t('Gemerkten Filter „{label}“ löschen', { label: f.label })}
              className="pr-2 pl-0.5 py-1.5 text-slate-400 hover:text-white disabled:opacity-40 disabled:hover:text-slate-400"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        );
      })}
      {embedded && !saved.length && !filtersActive && (
        <span className="text-slate-400">{t('Setze Filter und merke sie dir hier für später.')}</span>
      )}
      {filtersActive && !alreadySaved && (
        <button
          type="button"
          id="btn-save-filter"
          onClick={save}
          className="flex items-center gap-1 rounded-full border border-dashed border-slate-600 px-3 py-1.5 text-slate-300 hover:text-white hover:border-brand-400"
        >
          <BookmarkPlus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Aktuelle Auswahl merken')}
        </button>
      )}
    </div>
  );
}
