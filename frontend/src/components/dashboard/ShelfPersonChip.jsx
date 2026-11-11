import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Library, User, Users } from 'lucide-react';
import SavedFilters from './SavedFilters';
import { t } from '../../i18n/index.js';

/**
 * One chip for "whose collection": the shelf (Regal) and the person whose volumes count (Person), plus the saved filter
 * sets. Closed it names the choice ("Familie · Ich"); with one shelf and nobody else it reads "Meine Sammlung". The
 * selects stay mounted while the chip is closed, so their labels keep working for assistive tech and tests.
 */
export default function ShelfPersonChip({
  shelves = [], shelfFilter = 'ALL', setShelfFilter,
  persons = [], personFilter = 'ALL', setPersonFilter,
  userId, saved
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelId = useId();
  const showShelves = Boolean(setShelfFilter) && (shelves.length > 1 || shelfFilter !== 'ALL');
  const others = persons.filter((p) => String(p.id) !== String(userId));
  const showPersons = Boolean(setPersonFilter) && (others.length > 0 || personFilter !== 'ALL');

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => rootRef.current && !rootRef.current.contains(e.target);
    const onPointer = (e) => { if (outside(e)) setOpen(false); };
    const onFocus = (e) => { if (outside(e)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const personName = (p) => (String(p.id) === String(userId) ? t('Ich') : p.name);
  const shelfLabel = shelfFilter === 'ALL' ? t('Alle Regale') : (shelves.find((s) => String(s.id) === shelfFilter)?.name || t('Regal'));
  const chosenPerson = persons.find((p) => String(p.id) === String(personFilter));
  const personLabel = personFilter === 'ALL' ? t('Alle Personen') : (chosenPerson ? personName(chosenPerson) : t('Person'));
  let label;
  if (!showShelves && !showPersons) label = t('Meine Sammlung');
  else if (!showPersons) label = shelfLabel;
  else if (!showShelves) label = personLabel;
  else label = `${shelfLabel} · ${personLabel}`;
  const narrowed = shelfFilter !== 'ALL' || personFilter !== 'ALL';

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        id="btn-shelf-person-chip"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('Regal und Person: {label}', { label })}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold max-w-[260px] ${narrowed ? 'border-brand-500/50 bg-brand-500/15 text-brand-100' : 'border-slate-700 bg-slate-900/90 text-slate-200 hover:border-slate-600'}`}
      >
        {showPersons ? <Users className="w-3.5 h-3.5 text-teal-400 shrink-0" aria-hidden="true" /> : <Library className="w-3.5 h-3.5 text-teal-400 shrink-0" aria-hidden="true" />}
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" aria-hidden="true" />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute left-0 top-full mt-2 z-40 w-[min(320px,calc(100vw-2rem))] rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl p-3 space-y-3"
      >
        {showShelves && (
          <label className="block">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
              <Library className="w-3.5 h-3.5 text-teal-400" aria-hidden="true" /> {t('Regal')}
            </span>
            <select id="filter-shelf-select" aria-label={t('Regal filtern')} value={shelfFilter} onChange={(e) => setShelfFilter(e.target.value)} className="w-full bg-slate-950/70 border border-slate-700 rounded-xl px-3 py-2 text-base sm:text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-400">
              <option value="ALL">{t('Alle Regale')}</option>
              {shelves.map((s) => <option key={s.id} value={String(s.id)}>{s.name} ({s.count})</option>)}
            </select>
          </label>
        )}
        {showPersons && (
          <label className="block">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
              <User className="w-3.5 h-3.5 text-teal-400" aria-hidden="true" /> {t('Person')}
            </span>
            <select id="filter-person-select" aria-label={t('Person filtern')} value={String(personFilter)} onChange={(e) => setPersonFilter(e.target.value)} className="w-full bg-slate-950/70 border border-slate-700 rounded-xl px-3 py-2 text-base sm:text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-400">
              <option value="ALL">{t('Alle Personen')}</option>
              {persons.map((p) => <option key={p.id} value={String(p.id)}>{personName(p)} ({p.count})</option>)}
            </select>
            <span className="block mt-1 text-[11px] text-slate-400">{t('Zeigt die Reihen, von denen diese Person einen Band besitzt.')}</span>
          </label>
        )}
        {!showShelves && !showPersons && (
          <p className="text-xs text-slate-400">{t('Ein Regal, eine Person: Hier gibt es nichts umzuschalten. Gemerkte Filter findest du unten.')}</p>
        )}
        {saved && <SavedFilters {...saved} embedded />}
      </div>
    </div>
  );
}
