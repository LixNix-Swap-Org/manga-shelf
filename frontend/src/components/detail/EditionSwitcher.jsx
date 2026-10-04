import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { Languages, Link2, Plus, Unlink } from 'lucide-react';
import ToolDialog from '../modals/ToolDialog';
import EditionFields from '../common/EditionFields';
import { apiFetch, readJson } from '../../utils/api';
import { notify } from '../../utils/notify';
import {
  EDITION_LANGUAGES, currencyForRegion, defaultRegionFor, editionCandidates, editionCode, editionLanguage, editionName, editionRegion, editionsOf
} from '../../utils/editions';
import { t } from '../../i18n/index.js';
import { serverText } from '../../i18n/serverText.js';

const PILL = 'inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide';

/** The first offered language that no edition of this work has yet (English for a lone German series). */
const suggestLanguage = (current, editions) => {
  const taken = new Set([current, ...editions.map((e) => editionLanguage(e))]);
  return EDITION_LANGUAGES.find((code) => !taken.has(code)) || 'en';
};

/** "+ Ausgabe": a new linked edition of this work, or link/unlink an existing series of the collection. */
function EditionDialog({ manga, editions, onClose, onChanged }) {
  const navigate = useNavigate();
  const ids = useId();
  const current = editionLanguage(manga);
  const [edition, setEdition] = useState(() => {
    const language = suggestLanguage(current, editions);
    const region = defaultRegionFor(language) || '';
    return { language, region, currency: currencyForRegion(region) };
  });
  const [title, setTitle] = useState('');
  const [publisher, setPublisher] = useState('');
  const [series, setSeries] = useState(null);
  const [linkTo, setLinkTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    apiFetch('/api/mangas').then(readJson).then((rows) => {
      if (active) setSeries(Array.isArray(rows) ? rows : []);
    }).catch(() => { if (active) setSeries([]); });
    return () => { active = false; };
  }, []);

  const candidates = series ? editionCandidates(manga, series) : [];
  const candidateIds = new Set(candidates.map((m) => String(m.id)));
  const linkedIds = new Set(editions.map((e) => String(e.id)));
  const others = (series || []).filter((m) => String(m.id) !== String(manga.id) && !candidateIds.has(String(m.id)) && !linkedIds.has(String(m.id)));

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/mangas/${manga.id}/editions`, {
        method: 'POST',
        body: {
          language: edition.language,
          region: edition.region || null,
          currency: edition.currency,
          title: title.trim() || undefined,
          publisher: publisher.trim() || undefined
        }
      });
      const data = await readJson(res);
      if (!res.ok || !data?.id) {
        setError(serverText(data) || t('Die Ausgabe konnte nicht angelegt werden.'));
        return;
      }
      notify.success(t('Ausgabe „{language}“ angelegt', { language: editionName(edition.language, edition.region || null) }));
      onClose();
      navigate(`/manga/${data.id}`);
    } catch (err) {
      setError(err?.message || t('Netzwerkfehler'));
    } finally {
      setBusy(false);
    }
  };

  const putWork = async (body) => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/mangas/${manga.id}/work`, { method: 'PUT', body });
      if (!res.ok) {
        setError(serverText(await readJson(res)) || t('Verknüpfen fehlgeschlagen'));
        return false;
      }
      onChanged?.();
      return true;
    } catch (err) {
      setError(err?.message || t('Netzwerkfehler'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const link = async (e) => {
    e.preventDefault();
    if (!linkTo) return;
    if (await putWork({ link_to: Number(linkTo) })) {
      notify.success(t('Ausgaben verknüpft'));
      onClose();
    }
  };

  const unlink = async () => {
    if (await putWork({ link_to: null })) {
      notify.success(t('Verknüpfung gelöst'));
      onClose();
    }
  };

  const optionLabel = (m) => `${m.title} · ${editionCode(editionLanguage(m), editionRegion(m))}${m.publisher ? ` · ${m.publisher}` : ''}`;

  return (
    <ToolDialog id="edition-dialog" title={t('Ausgaben dieser Reihe')} subtitle={manga.title} Icon={Languages} onClose={onClose} busy={busy}>
      <div className="space-y-6">
        {error && <p role="alert" className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">{error}</p>}

        <form onSubmit={create} className="space-y-4" aria-labelledby={`${ids}-new`}>
          <h3 id={`${ids}-new`} className="text-sm font-bold text-white">{t('Neue Ausgabe anlegen')}</h3>
          <p className="text-xs text-slate-400">{t('Übernimmt Titel, Autor, Genres, Beschreibung, Bandzahl und Cover; Bände und Besitz bleiben bei jeder Ausgabe für sich.')}</p>
          <EditionFields idPrefix={`${ids}-edition`} value={edition} onChange={(patch) => setEdition((prev) => ({ ...prev, ...patch }))} disabled={busy} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${ids}-title`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Titel der Ausgabe')}</label>
              <input id={`${ids}-title`} type="text" className="input-field" placeholder={manga.title} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label htmlFor={`${ids}-publisher`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Verlag')}</label>
              <input id={`${ids}-publisher`} type="text" className="input-field" value={publisher} disabled={busy} onChange={(e) => setPublisher(e.target.value)} />
            </div>
          </div>
          <button id="btn-create-edition" type="submit" disabled={busy} className="btn-primary text-xs px-4 py-2 inline-flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Ausgabe anlegen')}
          </button>
        </form>

        <form onSubmit={link} className="space-y-3 pt-5 border-t border-slate-800" aria-labelledby={`${ids}-link`}>
          <h3 id={`${ids}-link`} className="text-sm font-bold text-white">{t('Vorhandene Reihe verknüpfen')}</h3>
          <p className="text-xs text-slate-400">{t('Für eine Reihe, die du schon in einer anderen Sprache sammelst. Vorschläge: gleicher Titel und Autor.')}</p>
          <label htmlFor={`${ids}-link-to`} className="sr-only">{t('Reihe zum Verknüpfen')}</label>
          <select id={`${ids}-link-to`} className="input-field bg-slate-950" value={linkTo} disabled={busy || !series} onChange={(e) => setLinkTo(e.target.value)}>
            <option value="">{series ? t('Reihe wählen…') : t('Lädt…')}</option>
            {candidates.length > 0 && (
              <optgroup label={t('Vorschläge')}>
                {candidates.map((m) => <option key={m.id} value={m.id}>{optionLabel(m)}</option>)}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label={t('Alle Reihen')}>
                {others.map((m) => <option key={m.id} value={m.id}>{optionLabel(m)}</option>)}
              </optgroup>
            )}
          </select>
          <div className="flex flex-wrap gap-2">
            <button id="btn-link-edition" type="submit" disabled={busy || !linkTo} className="btn-secondary text-xs px-4 py-2 inline-flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('Verknüpfen')}
            </button>
            {editions.length > 0 && (
              <button id="btn-unlink-edition" type="button" onClick={unlink} disabled={busy} className="btn-secondary text-xs px-4 py-2 inline-flex items-center gap-1.5 text-amber-200">
                <Unlink className="w-3.5 h-3.5" aria-hidden="true" /> {t('Diese Ausgabe lösen')}
              </button>
            )}
          </div>
        </form>
      </div>
    </ToolDialog>
  );
}

/**
 * The editions of the same work (same work_key) as pills under the title; the current one is marked. Editors get
 * "+ Ausgabe" to create or link an edition. Renders nothing for readers of an unlinked series.
 */
export default function EditionSwitcher({ manga, canEdit = false, isOffline = false, onChanged }) {
  const [open, setOpen] = useState(false);
  const editions = editionsOf(manga);
  if (!manga || (editions.length === 0 && !canEdit)) return null;
  const language = editionLanguage(manga);
  const region = editionRegion(manga);
  const sorted = [...editions].sort((a, b) => editionLanguage(a).localeCompare(editionLanguage(b)));

  return (
    <div id="edition-switcher" className="mt-2 flex flex-wrap items-center gap-1.5">
      {editions.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={t('Ausgaben')}>
          <li>
            <span aria-current="page" data-language={language} className={`language-pill ${PILL} border-teal-400/70 bg-teal-500/25 text-teal-100`} title={editionName(language, region)}>
              <span aria-hidden="true">{editionCode(language, region)}</span>
              <span className="sr-only">{t('Ausgabe: {language}', { language: editionName(language, region) })}</span>
            </span>
          </li>
          {sorted.map((e) => {
            const code = editionLanguage(e);
            const eRegion = editionRegion(e);
            return (
              <li key={e.id}>
                {/* the accessible name starts with the visible code (voice control: "EN-US klicken") */}
                <Link
                  to={`/manga/${e.id}`}
                  className={`hit-44 ${PILL} border-slate-600 bg-slate-800/80 text-slate-200 hover:border-teal-400/60 hover:text-white`}
                  title={t('{language}: {title}', { language: editionName(code, eRegion), title: e.title })}
                  aria-label={`${editionCode(code, eRegion)} – ${t('Zur Ausgabe {language}: {title}', { language: editionName(code, eRegion), title: e.title })}`}
                >
                  {editionCode(code, eRegion)}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && !isOffline && (
        <button
          id="btn-add-edition"
          type="button"
          onClick={() => setOpen(true)}
          className="hit-44 inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-600 px-2 py-0.5 text-[11px] font-semibold text-slate-300 hover:border-teal-400/60 hover:text-white"
          title={t('Andere Sprachausgabe anlegen oder verknüpfen')}
        >
          <Plus className="w-3 h-3" aria-hidden="true" /> {t('Ausgabe')}
        </button>
      )}
      {/* portal: the hero's backdrop-filter would make it the containing block of the fixed overlay */}
      {open && createPortal(<EditionDialog manga={manga} editions={editions} onClose={() => setOpen(false)} onChanged={onChanged} />, document.body)}
    </div>
  );
}
