import { useState } from 'react';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';
import { COLLECT_FILTERS, STATUS_TABS } from '../../utils/collectionHelpers';
import { t } from '../../i18n/index.js';

// Saved filter sets of the collection ("Gemerkte Filter"): per account on this device, at most SAVED_FILTER_LIMIT.
const KEY_PREFIX = 'mangashelf_saved_filters';
export const SAVED_FILTER_LIMIT = 8;
const FIELDS = ['status', 'publisher', 'collect', 'author', 'tags', 'lang', 'shelf', 'sort', 'group'];

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
  try { globalThis.localStorage?.setItem(keyOf(userId), JSON.stringify(list)); } catch (_) { /* storage blocked: only this visit */ }
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
    sort: state.sort || 'title_asc',
    group: state.group || 'none'
  };
}

// the stored name, made in the language of the moment it was saved
const savedName = (f) => f.label;

export const sameFilters = (a, b) => FIELDS.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));

/** A short name for a filter set from its parts: shelf, status, publisher, collecting state, author, tags, language. */
export function filterLabel(filters, { shelves = [] } = {}) {
  const parts = [];
  if (filters.shelf !== 'ALL') parts.push(shelves.find((s) => String(s.id) === filters.shelf)?.name || t('Regal'));
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
export default function SavedFilters({ userId, current, apply, shelves = [], filtersActive }) {
  const [saved, setSaved] = useState(() => readSavedFilters(userId));
  const [owner, setOwner] = useState(userId);
  if (owner !== userId) {
    setOwner(userId);
    setSaved(readSavedFilters(userId));
  }
  const now = filterSnapshot(current);
  const alreadySaved = saved.some((f) => sameFilters(f.filters, now));
  if (!saved.length && !filtersActive) return null;

  const update = (list) => {
    setSaved(list);
    writeSavedFilters(userId, list);
  };
  const save = () => {
    if (alreadySaved) return;
    const entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label: filterLabel(now, { shelves }), filters: now };
    update([...saved, entry].slice(-SAVED_FILTER_LIMIT));
  };

  return (
    <div role="group" aria-label={t('Gemerkte Filter')} id="saved-filters" className="-mt-3 mb-6 flex flex-wrap items-center gap-2 text-xs">
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
              onClick={() => update(saved.filter((x) => x.id !== f.id))}
              aria-label={t('Gemerkten Filter „{label}“ löschen', { label: f.label })}
              className="pr-2 pl-0.5 py-1.5 text-slate-400 hover:text-white"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        );
      })}
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
