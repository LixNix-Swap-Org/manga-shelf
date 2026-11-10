import { BookOpen, ChevronRight } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import { t } from '../../i18n/index.js';

export const QUICK_SERIES_LIMIT = 6;
export const QUICK_LISTBOX_ID = 'quick-access-list';
export const quickOptionId = (index) => `quick-access-option-${index}`;

const norm = (value) => String(value ?? '').toLocaleLowerCase();

/**
 * The entries of the quick access for a query: series (by title, alternative title or author; without a query the
 * recently opened ones) and the actions whose label or hint contains it. Returns { sections, items } where items is
 * the flat list in display order, each { key, kind: 'series' | 'action', label, hint, manga?, run? }.
 */
export function quickAccessEntries({ query = '', mangas = [], recentIds = [], actions = [] }) {
  const q = norm(query).trim();
  let series;
  let seriesTitle;
  if (q) {
    seriesTitle = t('Reihen');
    series = mangas
      .filter((m) => [m.title, m.alt_title, m.author].some((v) => norm(v).includes(q)))
      .slice(0, QUICK_SERIES_LIMIT);
  } else {
    seriesTitle = t('Zuletzt geöffnet');
    const byId = new Map(mangas.map((m) => [m.id, m]));
    series = recentIds.map((id) => byId.get(id)).filter(Boolean);
  }
  const seriesItems = series.map((m) => ({
    key: `series-${m.id}`,
    kind: 'series',
    label: m.title || t('Ohne Titel'),
    hint: m.author || m.publisher || '',
    manga: m
  }));
  const actionItems = actions
    .filter((a) => !q || norm(a.label).includes(q) || norm(a.hint).includes(q))
    .map((a) => ({ key: `action-${a.id}`, kind: 'action', label: a.label, hint: a.hint || '', run: a.run }));
  const sections = [];
  if (seriesItems.length) sections.push({ id: 'series', title: seriesTitle, items: seriesItems });
  if (actionItems.length) sections.push({ id: 'actions', title: t('Aktionen'), items: actionItems });
  return { sections, items: [...seriesItems, ...actionItems] };
}

/**
 * The panel of the quick access below the header search: a listbox the search field controls (combobox). On phones
 * it covers the screen below the header and has a "Schließen" button. Entries are chosen with a click or, from the
 * search field, with the arrow keys and Enter; a pointer press does not move the focus out of the search field.
 */
export default function QuickAccessPanel({ sections, activeIndex, onChoose, onHover, onClose, narrow }) {
  let index = -1;
  const frame = narrow
    ? 'fixed inset-x-0 bottom-0 top-[var(--sticky-header-h,64px)] z-50 bg-slate-950 overflow-y-auto overscroll-contain'
    : 'absolute left-0 right-0 top-full mt-2 z-50 max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl';
  return (
    <div id="quick-access" className={frame} onMouseDown={(e) => e.preventDefault()}>
      {narrow && (
        <div className="flex justify-end px-4 pt-2">
          <button type="button" id="btn-quick-access-close" onClick={onClose} className="min-h-[44px] px-2 text-sm font-semibold text-sky-400">
            {t('Schließen')}
          </button>
        </div>
      )}
      <div id={QUICK_LISTBOX_ID} role="listbox" aria-label={t('Schnellzugriff')} className="py-2">
        {sections.length === 0 && (
          <p className="px-4 py-3 text-sm text-slate-400">{t('Keine Treffer – Enter durchsucht weiter die Sammlung.')}</p>
        )}
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={`quick-access-${section.id}`}>
            <div id={`quick-access-${section.id}`} className="px-4 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{section.title}</div>
            {section.items.map((item) => {
              index += 1;
              const i = index;
              const active = i === activeIndex;
              return (
                <div
                  key={item.key}
                  id={quickOptionId(i)}
                  role="option"
                  aria-selected={active}
                  onClick={() => onChoose(item)}
                  onMouseMove={() => onHover(i)}
                  className={`flex items-center gap-3 px-4 min-h-[44px] py-1.5 cursor-pointer text-sm ${active ? 'bg-brand-600/25 text-white' : 'text-slate-200 hover:bg-slate-800/70'}`}
                >
                  {item.kind === 'series' ? (
                    <CoverImage
                      src={item.manga.cover_image}
                      className="w-7 h-10 rounded object-cover shrink-0"
                      fallback={<span className="w-7 h-10 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-3.5 h-3.5" aria-hidden="true" /></span>}
                    />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-brand-300 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{item.label}{/* i18n-ignore: translated where the entry is made */}</span>
                  {item.hint && <span className="text-xs text-slate-400 truncate max-w-[45%]">{item.hint}{/* i18n-ignore: translated where the entry is made */}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!narrow && (
        <div className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-400">{t('↑↓ wählen · Enter öffnen · Esc schließen')}</div>
      )}
    </div>
  );
}
