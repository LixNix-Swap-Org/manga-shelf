// The season editor of an anime: own season starts and names (split from AnimeDetailModal.jsx).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ListOrdered, Plus, Sparkles, X } from 'lucide-react';
import { isAbortError } from '../../../utils/api';
import { kindOf } from '../../../utils/animeHelpers';
import episodeMarks from '../../../../../core/anime/episodes.js';
import { t, tn } from '../../../i18n/index.js';

/**
 * Rows of the season editor: the seasons set by hand, else the TMDb seasons a TV show already stores (no request; the
 * names stay empty), else one season from episode 1.
 */
export function seasonRows(anime, custom) {
  const stored = kindOf(anime) === 'tv' && Array.isArray(anime.seasons) ? episodeMarks.seasonsFromCounts(anime.seasons) : [];
  const list = custom.length ? custom : stored.length ? stored : [{ start: 1, name: null }];
  return list.map((s) => ({ start: String(s.start), name: (s.name || '').slice(0, episodeMarks.MAX_SEASON_NAME) }));
}

/**
 * Seasons set by hand for everybody (PUT /anime/:id with custom_seasons): the first episode of each season and an optional
 * name. "Vorschlag von TMDB laden" fills the rows from TMDb (needs a TMDB key); nothing is stored before "Speichern".
 * A suggestion that arrives after "Abbrechen" is dropped; closing gives the focus back to "Staffeln bearbeiten".
 */
export function SeasonEditor({ anime, onSave, loadSuggestion, disabled }) {
  const ids = useId();
  const custom = useMemo(() => (Array.isArray(anime.custom_seasons) ? anime.custom_seasons : []), [anime.custom_seasons]);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const openRef = useRef(null);
  const focusNext = useRef(null);
  const total = anime.episodes > 0 ? anime.episodes : null;
  const maxName = episodeMarks.MAX_SEASON_NAME;

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === 'open' ? openRef.current : document.getElementById(target))?.focus();
  }, [rows]);

  if (!rows) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {custom.length > 0 && <p className="text-xs text-slate-300">{tn('{n} eigene Staffel', '{n} eigene Staffeln', custom.length)}</p>}
        <button ref={openRef} type="button" className="btn-secondary text-xs inline-flex items-center gap-1" disabled={disabled}
          onClick={() => { focusNext.current = `${ids}-name-0`; setRows(seasonRows(anime, custom)); setError(''); setNote(''); }}>
          <ListOrdered className="w-3.5 h-3.5" aria-hidden="true" /> {t('Staffeln bearbeiten')}
        </button>
      </div>
    );
  }

  const setRow = (i, field, value) => setRows((list) => list.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  const addRow = () => setRows((list) => {
    const last = Number(list[list.length - 1]?.start) || 0;
    return [...list, { start: String(last + 1), name: '' }];
  });
  const removeRow = (i) => {
    focusNext.current = `${ids}-name-${i - 1}`;
    setRows((list) => list.filter((_, j) => j !== i));
  };
  const close = () => {
    request.current += 1;
    focusNext.current = 'open';
    setRows(null);
    setError('');
    setNote('');
    setLoading(false);
  };
  const suggest = async () => {
    request.current += 1;
    const own = request.current;
    setLoading(true);
    setError('');
    setNote('');
    try {
      const answer = await loadSuggestion();
      if (own !== request.current) return;
      if (answer?.seasons?.length) {
        setRows(answer.seasons.map((s) => ({ start: String(s.start), name: (s.name || '').slice(0, maxName) })));
        setNote(tn('{n} Staffel von TMDB übernommen. Prüfen und speichern.', '{n} Staffeln von TMDB übernommen. Prüfen und speichern.', answer.seasons.length));
      } else if (answer?.reason === 'no_key') {
        setNote(t('Für den Vorschlag braucht es einen TMDB-Schlüssel (Konto & Sprache → API-Schlüssel).'));
      } else {
        setNote(t('TMDB kennt für diesen Eintrag keine Staffeln.'));
      }
    } catch (err) {
      if (own === request.current && !isAbortError(err)) setError(err.message);
    } finally {
      if (own === request.current) setLoading(false);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    const list = rows.map((r) => ({ start: Number(r.start), name: r.name.trim() || null }));
    let last = 0;
    for (const [i, s] of list.entries()) {
      const bad = !Number.isInteger(s.start) || s.start < 1 || (i === 0 && s.start !== 1) || s.start <= last || (total && s.start > total);
      if (bad) {
        setError(total
          ? t('Jede Staffel muss nach der vorigen beginnen, die erste bei Folge 1 und keine nach Folge {total}.', { total })
          : t('Jede Staffel muss nach der vorigen beginnen, die erste bei Folge 1.'));
        return;
      }
      last = s.start;
    }
    try {
      await onSave(list.length > 1 || list[0].name ? list : null);
      close();
    } catch (err) {
      setError(err.message);
    }
  };
  const clear = async () => {
    try {
      await onSave(null);
      close();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form onSubmit={save} noValidate className="rounded-xl border border-slate-700 bg-slate-900/80 p-3 space-y-3" aria-labelledby={`${ids}-title`}>
      <div>
        <h4 id={`${ids}-title`} className="text-xs font-semibold text-slate-100">{t('Staffeln bearbeiten')}</h4>
        <p className="text-[11px] text-slate-400">{t('Lege fest, bei welcher Folge jede Staffel beginnt. Die Staffeln gelten für alle.')}</p>
      </div>
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2">
            <span className="text-xs text-slate-300 w-full sm:w-auto sm:min-w-[5.5rem] sm:pb-2">{t('Staffel {season}', { season: i + 1 })}</span>
            <div className="w-24">
              <label htmlFor={`${ids}-start-${i}`} className="block text-[11px] text-slate-400 mb-1">{t('Ab Folge')}</label>
              <input id={`${ids}-start-${i}`} type="number" inputMode="numeric" min={1} max={total || undefined} className="input-field text-base sm:text-sm"
                value={r.start} readOnly={i === 0} disabled={disabled} onChange={(e) => setRow(i, 'start', e.target.value)} />
            </div>
            <div className="flex-1 min-w-[8rem]">
              <label htmlFor={`${ids}-name-${i}`} className="block text-[11px] text-slate-400 mb-1">{t('Name (optional)')}</label>
              <input id={`${ids}-name-${i}`} type="text" maxLength={maxName} className="input-field text-base sm:text-sm" value={r.name} disabled={disabled}
                onChange={(e) => setRow(i, 'name', e.target.value)} />
            </div>
            {i > 0 && (
              <button type="button" className="btn-secondary p-2.5 hit-44 shrink-0" disabled={disabled}
                aria-label={t('Staffel {season} entfernen', { season: i + 1 })} title={t('Staffel {season} entfernen', { season: i + 1 })} onClick={() => removeRow(i)}>
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {note && <p role="status" className="text-xs text-slate-300">{note}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" disabled={disabled} onClick={addRow}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Staffel hinzufügen')}
        </button>
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" disabled={disabled || loading} aria-busy={loading} onClick={suggest}>
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> {loading ? t('Lädt…') : t('Vorschlag von TMDB laden')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 justify-end">
        {custom.length > 0 && <button type="button" className="btn-secondary text-xs text-red-300" disabled={disabled} onClick={clear}>{t('Eigene Staffeln entfernen')}</button>}
        <button type="button" className="btn-secondary text-xs" onClick={close}>{t('Abbrechen')}</button>
        <button type="submit" className="btn-primary text-xs" disabled={disabled}>{t('Staffeln speichern')}</button>
      </div>
    </form>
  );
}
