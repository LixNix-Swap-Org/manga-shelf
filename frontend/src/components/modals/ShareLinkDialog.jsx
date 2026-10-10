import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Plus, RefreshCw, Tv, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { langFor } from '../common/lang';
import { compareNatural } from '../../utils/search';
import { displayTitle, formatLabel, progressText } from '../../utils/animeHelpers';
import {
  aboveTotalText, displaySeriesTitle, knownEntry, progressBefore, raisesCounter, serviceLabel
} from '../../utils/shareIntake';
import { t } from '../../i18n/index.js';

const MAX_CANDIDATES = 5;

function PasteStep({ error, onSubmit, onCancel, ids }) {
  const [value, setValue] = useState('');
  const fieldRef = useRef(null);
  useEffect(() => {
    if (error) fieldRef.current?.focus();
  }, [error]);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(value); }} className="space-y-3" noValidate>
      <div>
        <label htmlFor={`${ids}-paste`} className="block text-xs font-semibold text-slate-300 mb-1.5">{t('Link aus der Crunchyroll-App oder -Website')}</label>
        <input
          ref={fieldRef}
          id={`${ids}-paste`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          className="input-field text-base sm:text-sm"
          placeholder="https://www.crunchyroll.com/de/watch/…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${ids}-paste-hint ${ids}-paste-error` : `${ids}-paste-hint`}
        />
        <p id={`${ids}-paste-hint`} className="text-[11px] text-slate-400 mt-1">{t('Tippe lange ins Feld und wähle „Einfügen“.')}</p>
        {error && <p id={`${ids}-paste-error`} role="alert" className="text-xs text-rose-300 mt-1">{error}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary text-sm" onClick={onCancel}>{t('Abbrechen')}</button>
        <button type="submit" className="btn-primary text-sm">{t('Link prüfen')}</button>
      </div>
    </form>
  );
}

function ConfirmStep({ state, list, listLoaded, canAdd, onChoose, onAddToList, onConfirm, onCreate, onCancel, ids, titleId }) {
  const { answer, chosenId } = state;
  const saving = state.phase === 'saving';
  const [episode, setEpisode] = useState(answer.episode ? String(answer.episode) : '');
  const [picking, setPicking] = useState(!answer.anime_id || (answer.candidates || []).length > 1);
  const [error, setError] = useState('');
  const episodeRef = useRef(null);

  const entry = list.find((a) => a.id === chosenId) || null;
  const known = knownEntry(answer, chosenId);
  const candidates = (answer.candidates || []).slice(0, MAX_CANDIDATES);
  const others = useMemo(() => {
    const shown = new Set((answer.candidates || []).slice(0, MAX_CANDIDATES).map((c) => c.id));
    return list.filter((a) => !shown.has(a.id)).sort((a, b) => compareNatural(displayTitle(a), displayTitle(b)));
  }, [list, answer.candidates]);
  const seriesTitle = displaySeriesTitle(answer, state.link);
  const title = entry ? displayTitle(entry) : (known?.title || seriesTitle || '');
  const refused = state.aboveTotal?.animeId === chosenId ? state.aboveTotal : null;
  const total = entry?.episodes || known?.episodes || refused?.total || null;
  const number = Number(episode);
  const valid = Number.isInteger(number) && number > 0;
  // later seasons are often numbered on from the first one (Folge 29 of a 12-episode entry)
  const above = Boolean(chosenId) && valid && (total ? number > total : refused?.episode === number);
  const before = progressBefore(entry, known);
  const ahead = chosenId && valid && !above && !raisesCounter(before, number);
  // the server keeps the counter and ignores an older page, so only the current episode is worth remembering
  const older = ahead && number < (before?.episodes_watched || 0);
  const showEpisodeField = !answer.episode || above || episode !== String(answer.episode);
  const suggestion = canAdd && onCreate && !chosenId && Number.isInteger(answer.suggestion?.anilist_id) ? answer.suggestion : null;

  const heading = title
    ? (answer.episode ? t('{title}, Folge {episode} gesehen?', { title, episode: answer.episode }) : t('{title}: welche Folge?', { title }))
    : (answer.episode ? t('Folge {episode} gesehen?', { episode: answer.episode }) : t('Welche Folge hast du gesehen?'));

  const check = () => {
    if (!chosenId) {
      setError(t('Bitte einen Eintrag wählen.'));
      return false;
    }
    if (!valid) {
      setError(t('Bitte die Folge eingeben.'));
      episodeRef.current?.focus();
      return false;
    }
    setError('');
    return true;
  };
  const submit = (e) => {
    e.preventDefault();
    if (check() && !above) onConfirm({ animeId: chosenId, episode: number });
  };
  const complete = () => {
    if (check()) onConfirm({ animeId: chosenId, episode: number, complete: true });
  };
  const create = () => {
    if (!valid) {
      setError(t('Bitte die Folge eingeben.'));
      episodeRef.current?.focus();
      return;
    }
    setError('');
    onCreate({ episode: number });
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h2 id={titleId} lang={title ? langFor(title) || 'de' : 'de'} className="text-lg font-bold text-white leading-snug break-words [overflow-wrap:anywhere] pr-10">
        {heading}
      </h2>
      {seriesTitle && seriesTitle.toLowerCase() !== title.toLowerCase() && (
        <p className="text-xs text-slate-400 -mt-2">{serviceLabel(answer.service)}: {seriesTitle}</p>
      )}

      {suggestion && (
        <div className="rounded-xl border border-brand-500/40 bg-brand-500/10 px-3 py-2.5 space-y-2">
          <p className="text-sm text-slate-100 flex flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]" lang={langFor(suggestion.title) || 'de'}>{suggestion.title}</span>
            {formatLabel(suggestion.format) && <span className="text-[11px] text-slate-400">{formatLabel(suggestion.format)}</span>}
          </p>
          <button type="button" className="hit-44 btn-primary text-xs inline-flex items-center gap-1.5" onClick={create} disabled={saving}>
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Anlegen und als gesehen markieren')}
          </button>
        </div>
      )}

      {picking ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-slate-300 mb-1.5">{t('Welcher Eintrag?')}</legend>
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 cursor-pointer has-[:checked]:border-brand-500/70">
              <input type="radio" name={`${ids}-entry`} value={c.id} checked={chosenId === c.id} onChange={() => { onChoose(c.id); setError(''); }} />
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]" lang={langFor(c.title) || 'de'}>{c.title}</span>
              {c.my_status && <span className="text-[11px] font-mono text-slate-400 shrink-0">{progressText(c.my_episodes, c.episodes)}</span>}
            </label>
          ))}
          {others.length > 0 && (
            <div>
              <label htmlFor={`${ids}-other`} className="block text-[11px] text-slate-400 mb-1">{candidates.length ? t('Anderer Eintrag') : t('Eintrag aus der Liste')}</label>
              <select
                id={`${ids}-other`}
                className="input-field text-base sm:text-sm"
                value={others.some((a) => a.id === chosenId) ? String(chosenId) : ''}
                onChange={(e) => { onChoose(e.target.value ? Number(e.target.value) : null); setError(''); }}
              >
                <option value="">–</option>
                {others.map((a) => <option key={a.id} value={a.id}>{displayTitle(a)}</option>)}
              </select>
            </div>
          )}
          {!candidates.length && !others.length && (
            <p className="text-xs text-slate-400">{listLoaded ? t('Dieser Anime steht noch nicht in der Liste.') : t('Die Liste wird noch geladen…')}</p>
          )}
          {canAdd && (
            <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={onAddToList} disabled={saving}>
              <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Zur Liste hinzufügen')}
            </button>
          )}
        </fieldset>
      ) : !above && (
        <button type="button" className="hit-44 self-start text-xs text-brand-300 hover:text-brand-200 underline" onClick={() => setPicking(true)}>{t('Anderer Eintrag…')}</button>
      )}

      {showEpisodeField && (
        <div>
          <label htmlFor={`${ids}-episode`} className="block text-xs font-semibold text-slate-300 mb-1.5">{t('Folge')}</label>
          <input
            ref={episodeRef}
            id={`${ids}-episode`}
            type="number"
            min="1"
            inputMode="numeric"
            required
            data-autofocus={above ? true : undefined}
            className="input-field text-base sm:text-sm w-28"
            value={episode}
            onChange={(e) => { setEpisode(e.target.value); setError(''); }}
            aria-invalid={(error && !valid) || above ? 'true' : undefined}
            aria-describedby={[above && `${ids}-above`, error && `${ids}-confirm-error`].filter(Boolean).join(' ') || undefined}
          />
        </div>
      )}

      {above && (
        <div className="space-y-2" aria-live="polite">
          <p id={`${ids}-above`} className="text-sm text-amber-300">
            {total ? aboveTotalText(number, total) : t('Folge {number} gibt es bei diesem Eintrag nicht.', { number })}
          </p>
          {!picking && (
            <button type="button" className="hit-44 text-xs text-brand-300 hover:text-brand-200 underline" onClick={() => setPicking(true)}>{t('Anderen Eintrag wählen')}</button>
          )}
        </div>
      )}

      {ahead && (
        <p className="text-sm text-slate-300">
          {older
            ? t('Du bist schon bei Folge {episodes_watched}, Folge {number} ändert nichts.', { episodes_watched: before.episodes_watched, number })
            : t('Du bist schon bei Folge {episodes_watched} – nur den Link für „Weiter“ merken?', { episodes_watched: before.episodes_watched })}
        </p>
      )}
      {error && <p id={`${ids}-confirm-error`} role="alert" className="text-xs text-rose-300">{error}</p>}
      {!error && state.createError && <p role="alert" className="text-xs text-rose-300">{state.createError}</p>}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary text-sm" onClick={onCancel} disabled={saving} data-autofocus={older ? true : undefined}>{t('Abbrechen')}</button>
        {above ? (
          <button key="complete" type="button" className="btn-primary text-sm" onClick={complete} disabled={saving}>
            {saving ? t('Wird gespeichert…') : t('Trotzdem als komplett markieren')}
          </button>
        ) : !older && (
          <button key="confirm" type="submit" className="btn-primary text-sm" disabled={saving} data-autofocus>
            {saving ? t('Wird gespeichert…') : ahead ? t('Link merken') : t('Ja, gesehen')}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * The share flow of hooks/useShareIntake.js: paste field, "Link wird gelesen…", an error with retry, and the
 * confirmation "Frieren, Folge 7 gesehen?" with the entry picker. Lazy; mounted only while a share is open.
 */
export default function ShareLinkDialog({
  state, list = [], listLoaded = true, canAdd = false, rootRef, onClose, onSubmitPaste, onRetry, onChoose, onAddToList, onConfirm, onCreate
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const busy = state.phase === 'reading' || state.phase === 'saving';
  const close = () => { if (state.phase !== 'saving') onClose(); };
  const dialogRef = useDialogA11y(true, { onClose: close });
  const confirming = state.phase === 'confirm' || state.phase === 'saving';
  // the parent's ref is the add dialog's focus target when its opener inside this dialog is gone
  const setRoot = useCallback((node) => {
    dialogRef.current = node;
    if (rootRef) rootRef.current = node;
  }, [dialogRef, rootRef]);

  // the step's content replaces the focused button (reading -> confirm): focus moves to the new step, not to the page
  useEffect(() => {
    const node = dialogRef.current;
    if (!node || node.contains(document.activeElement)) return;
    (node.querySelector('[data-autofocus]') || node).focus();
  }, [state.phase, dialogRef]);

  return (
    <div
      ref={setRoot}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-busy={busy ? 'true' : undefined}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl relative" id="share-link-dialog">
        <button type="button" onClick={close} disabled={state.phase === 'saving'} aria-label={t('Schließen')} className="hit-44 absolute top-3 right-3 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {state.phase === 'paste' && (
          <>
            <h2 id={titleId} className="text-lg font-bold text-white flex items-center gap-2 mb-4 pr-10">
              <ClipboardPaste className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> {t('Link einfügen')}
            </h2>
            <PasteStep error={state.error} onSubmit={onSubmitPaste} onCancel={close} ids={ids} />
          </>
        )}

        {(state.phase === 'reading' || state.phase === 'error') && (
          <>
            <h2 id={titleId} className="text-lg font-bold text-white flex items-center gap-2 mb-4 pr-10">
              <Tv className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> {t('Geteilter Link')}
            </h2>
            {state.phase === 'reading'
              ? <p role="status" className="text-sm text-slate-300">{t('Link wird gelesen…')}</p>
              : <p role="alert" className="text-sm text-rose-300">{state.error}</p>}
            <div className="flex flex-wrap justify-end gap-2 mt-5">
              <button type="button" className="btn-secondary text-sm" onClick={close} data-autofocus={state.phase === 'reading' ? true : undefined}>{t('Abbrechen')}</button>
              {state.phase === 'error' && state.retryable !== false && (
                <button type="button" className="btn-primary text-sm inline-flex items-center gap-1.5" onClick={onRetry} data-autofocus>
                  <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('Erneut versuchen')}
                </button>
              )}
            </div>
          </>
        )}

        {confirming && (
          <ConfirmStep
            state={state}
            list={list}
            listLoaded={listLoaded}
            canAdd={canAdd}
            onChoose={onChoose}
            onAddToList={onAddToList}
            onConfirm={onConfirm}
            onCreate={onCreate}
            onCancel={close}
            ids={ids}
            titleId={titleId}
          />
        )}
      </div>
    </div>
  );
}
