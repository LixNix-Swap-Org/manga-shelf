import { useEffect, useId, useState } from 'react';
import { Plus, ScrollText } from 'lucide-react';
import { put } from '../../utils/api';
import { notify } from '../../utils/notify';
import { getChapterProgress } from '../../utils/volumeHelpers';
import { formatNumber } from '../../utils/format';
import { t, tn } from '../../i18n/index.js';

// same bound as MAX_CHAPTERS in core/lib/validate.js
const MAX_CHAPTERS = 99999;

/**
 * The detail after a PUT /mangas/:id/chapters answer: the own chapter and the own row of chapter_progress. An answer for
 * another series (an undo tapped after opening the next one) leaves the shown detail as it is.
 */
export function withChapter(manga, data, user) {
  if (data.manga_id !== undefined && data.manga_id !== null && String(data.manga_id) !== String(manga.id)) return manga;
  const rows = (manga.chapter_progress || []).filter((p) => p.user_id !== user?.id);
  if (data.chapters_read > 0) rows.push({ user_id: user?.id, username: user?.username, chapters_read: data.chapters_read, updated_at: null });
  rows.sort((a, b) => a.user_id - b.user_id);
  return { ...manga, chapters_read: data.chapters_read, chapter_progress: rows };
}

/**
 * Chapter progress of a webtoon (mangas.format): the caller's chapter with +1 and "Gelesen bis Kapitel", and how far the
 * other people of the series are. `canChange`: editors and admins, viewers of the shelf included (own chapter only);
 * offline it is false and the panel only shows.
 */
export default function ChapterProgress({ manga, user, canChange, isOffline, onSaved }) {
  const ids = useId();
  const { read, total, pct } = getChapterProgress(manga);
  const [draft, setDraft] = useState(read ? String(read) : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(read ? String(read) : ''); }, [read]);
  const others = (manga.chapter_progress || []).filter((p) => p.user_id !== user?.id);
  const atEnd = total > 0 && read >= total;
  const summary = total > 0
    ? tn('{read} von {n} Kapitel gelesen', '{read} von {n} Kapiteln gelesen', total, { read: formatNumber(read) })
    : tn('{n} Kapitel gelesen', '{n} Kapitel gelesen', read);

  const save = async (body, { undo = true } = {}) => {
    setBusy(true);
    try {
      const data = await put(`/api/mangas/${encodeURIComponent(manga.id)}/chapters`, body, { fallback: t('Kapitelstand konnte nicht gespeichert werden') });
      onSaved(data);
      if (undo && data.chapters_read !== data.previous) {
        const text = data.chapters_read > 0
          ? t('{title}: bis Kapitel {n} gelesen', { title: manga.title, n: formatNumber(data.chapters_read) })
          : t('{title}: Kapitelstand zurückgesetzt', { title: manga.title });
        notify.success(text, { action: { label: t('Rückgängig'), onClick: () => save({ chapters_read: data.previous }, { undo: false }) } });
      }
    } catch (err) {
      notify.error(err);
      setDraft(read ? String(read) : '');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    const value = text === '' ? 0 : Number(text);
    if (!Number.isInteger(value) || value < 0 || value > MAX_CHAPTERS) {
      notify.error(t('Bitte eine ganze Zahl zwischen 0 und {max} eingeben.', { max: MAX_CHAPTERS }));
      return;
    }
    if (value !== read) save({ chapters_read: value });
  };

  return (
    <section aria-labelledby={`${ids}-heading`} data-busy={busy ? 'true' : undefined} className="glass-panel p-5 sm:p-6 rounded-3xl border border-teal-500/30 shadow-xl mb-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
        <h2 id={`${ids}-heading`} className="text-lg font-bold text-white flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-teal-300" aria-hidden="true" />
          {t('Kapitel')}
        </h2>
        <p className="text-sm text-slate-300 font-mono">
          {summary}{pct !== null && ` (${pct}%)`}
        </p>
      </div>

      {total > 0 && (
        <div
          role="progressbar"
          aria-label={t('Lesefortschritt')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? 0}
          aria-valuetext={summary}
          className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800 mb-4"
        >
          <div className="h-full bg-gradient-to-r from-teal-500 to-sky-400 transition-all duration-500" style={{ width: `${pct ?? 0}%` }} />
        </div>
      )}

      {canChange ? (
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            id="btn-chapter-plus-one"
            onClick={() => save({ add: 1 })}
            disabled={busy || atEnd}
            className="hit-44 btn-primary text-sm py-2 px-3.5 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={t('+1 – ein Kapitel mehr gelesen')}
            title={atEnd ? t('Alle Kapitel gelesen') : t('Ein Kapitel mehr gelesen')}
          >
            <Plus className="w-4 h-4" aria-hidden="true" />1
          </button>
          <form onSubmit={submit} className="flex items-end gap-2">
            <div>
              <label htmlFor={`${ids}-chapter`} className="block text-xs font-semibold text-slate-400 mb-1">{t('Gelesen bis Kapitel')}</label>
              <input
                id={`${ids}-chapter`}
                type="number"
                inputMode="numeric"
                min="0"
                max={total > 0 ? total : MAX_CHAPTERS}
                step="1"
                className="input-field w-28"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
              />
            </div>
            <button type="submit" className="btn-secondary text-sm py-2.5 px-3" disabled={busy}>{t('Speichern')}</button>
          </form>
        </div>
      ) : isOffline ? (
        <p className="text-xs text-slate-400">{t('Offline lässt sich der Kapitelstand nicht ändern.')}</p>
      ) : null}

      {others.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-800/80">
          <h3 className="text-xs font-semibold text-slate-400 mb-1.5">{t('Weitere Leser')}</h3>
          <ul className="flex flex-wrap gap-2 text-xs">
            {others.map((p) => (
              <li key={p.user_id} className="px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-200">
                {t('{name}: Kapitel {n}', { name: p.username, n: formatNumber(p.chapters_read) })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
