import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, BookOpen, CircleExclamationPoint, Globe, Library, PenLine, RefreshCw, Save, Sparkles, Upload, X } from 'lucide-react';
import { MANGA_STATUSES, loadShelfMovePreview, shelfMoveConfirmText } from '../../hooks/useMangaData';
import useDialogA11y from '../../hooks/useDialogA11y';
import { assetImgProps, get } from '../../utils/api';
import { joinTags, splitTags, tagKey } from '../../utils/tags';
import { formatCount } from '../../utils/format';
import { PRIORITY_OPTIONS } from '../../utils/priority';
import { isMpEdition } from '../../utils/editions';
import { mangaStatusLabel } from '../../utils/enumLabels';
import FilePickerButton from '../common/FilePickerButton';
import EditionFields from '../common/EditionFields';
import FormatFields from '../common/FormatFields';
import ConfirmDialog from '../modals/ConfirmDialog';
import CatalogNotice from './CatalogNotice';
import { t as tr } from '../../i18n/index.js';

// i18n
export const COVER_UPLOAD_TEXT = 'Cover wird hochgeladen…';

// i18n
const SECTIONS = [
  { id: 'basis', label: 'Basis' },
  { id: 'edition', label: 'Edition' },
  { id: 'format', label: 'Format' },
  { id: 'bilder', label: 'Bilder' },
  { id: 'tags', label: 'Tags' }
];

const SOURCE_LABELS = { anilist: 'AniList', mal: 'MyAnimeList' };

/**
 * Badges of a non-Manga-Passion lookup hit (same rule as AddMangaModal): the label the server sends, else the label of a
 * known source (AniList only for AniList hits), then the sources merged into it (also_on).
 */
export function lookupBadgeLabels(item) {
  const own = item?.source_label || SOURCE_LABELS[item?.source];
  const merged = (Array.isArray(item?.also_on) ? item.also_on : []).map((source) => SOURCE_LABELS[source]).filter(Boolean);
  return [...new Set([own, ...merged].filter(Boolean))];
}

const SUGGESTION_LIMIT = 8;

/**
 * Tag chips plus an input: Enter, comma or leaving the field adds the typed tag; suggestions come from `suggestions`
 * ([{ tag, count }]) or, on first focus, from GET /api/tags. The form keeps the comma-separated text.
 */
export function TagEditor({ id, value, onChange, suggestions = null, offline = false }) {
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(null);
  const requested = useRef(false);
  const tags = splitTags(value);
  const known = suggestions || loaded || [];
  const draftKey = tagKey(draft);
  const own = new Set(tags.map((t) => t.toLowerCase()));
  const offers = known
    .filter((s) => !own.has(s.tag.toLowerCase()) && (!draftKey || s.tag.toLowerCase().includes(draftKey)))
    .slice(0, SUGGESTION_LIMIT);

  const commit = (text) => {
    const added = splitTags(text);
    if (added.length) onChange(joinTags([...tags, ...added]));
    setDraft('');
  };
  const loadSuggestions = () => {
    if (suggestions || offline || requested.current) return;
    requested.current = true;
    get('/api/tags').then((data) => setLoaded(Array.isArray(data?.tags) ? data.tags : [])).catch(() => setLoaded([]));
  };

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Genres / Tags')}</label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mb-2" aria-label={tr('Gesetzte Tags')}>
          {tags.map((tag) => (
            <li key={tag.toLowerCase()} className="flex items-center gap-1 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/15 px-2 py-0.5 text-xs text-fuchsia-200">
              {tag}
              <button
                type="button"
                onClick={() => onChange(joinTags(tags.filter((t) => t !== tag)))}
                className="text-fuchsia-300 hover:text-white"
                aria-label={tr('Tag „{tag}“ entfernen', { tag })}
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        type="text"
        className="input-field"
        placeholder={tr('z. B. Abenteuer, Fantasy – Enter fügt hinzu')}
        value={draft}
        maxLength={200}
        onFocus={loadSuggestions}
        onChange={(e) => {
          const text = e.target.value;
          if (/[,;]/.test(text)) commit(text);
          else setDraft(text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onChange(joinTags(tags.slice(0, -1)));
          }
        }}
        onBlur={() => { if (draft.trim()) commit(draft); }}
      />
      {offers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2" role="group" aria-label={tr('Vorschläge')}>
          {offers.map((s) => (
            <button
              key={s.tag}
              type="button"
              // mousedown keeps the focus, so the blur does not add the half-typed text first
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(s.tag)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300 hover:border-fuchsia-500/50 hover:text-white"
            >
              + {s.tag}{s.count ? <span className="text-slate-400"> ({s.count})</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LABEL = 'block text-xs font-semibold text-slate-400 mb-1';

function Section({ id, ids, title, children }) {
  return (
    <section id={`series-edit-${id}`} data-section={id} aria-labelledby={`${ids}-${id}-heading`} className="space-y-4 scroll-mt-4">
      <h3 id={`${ids}-${id}-heading`} className="text-xs font-bold uppercase tracking-wide text-brand-300 pt-1">{title}</h3>
      {children}
    </section>
  );
}

/**
 * "Reihe bearbeiten" as a panel at the right edge (full screen on phones): the series page stays behind it. Same fields
 * and behaviour as the form the hero used to turn into, grouped into the sections Basis, Edition, Format, Bilder and Tags.
 * Escape and Back go through the page's own Escape handling, which asks before unsaved input is dropped.
 */
export default function SeriesEditPanel({
  applyEditLookupResult, coverUrl, editLookingUp, editLookupError, editLookupResults, formData, handleCoverUpload,
  handleEditLookup, handleUpdate, isOffline, manga, movableShelves = [], onCancel, onEditionsChanged, saving,
  setEditLookupResults, setFormData, tagSuggestions = null, uploadingCover
}) {
  const ids = useId();
  const dialogRef = useDialogA11y(true);
  const bodyRef = useRef(null);
  const [activeSection, setActiveSection] = useState('basis');
  // a move deletes the marks of everyone who does not see the target shelf: asked before the choice counts
  const [shelfMove, setShelfMove] = useState(null);
  const [checkingMove, setCheckingMove] = useState(false);
  const moveRequestRef = useRef(0);
  // closing the panel drops a question that is still loading
  useEffect(() => () => { moveRequestRef.current += 1; }, []);

  const handleCoverInput = (e) => {
    handleCoverUpload(e);
    e.target.value = '';
  };
  const chooseShelf = async (value) => {
    const request = ++moveRequestRef.current;
    if (value === String(manga.shelf_id || '')) {
      setShelfMove(null);
      setCheckingMove(false);
      setFormData((prev) => ({ ...prev, shelf_id: value }));
      return;
    }
    setCheckingMove(true);
    const affected = await loadShelfMovePreview(manga.id, value);
    if (request !== moveRequestRef.current) return;
    setCheckingMove(false);
    if (Array.isArray(affected) && affected.length === 0) {
      setFormData((prev) => ({ ...prev, shelf_id: value }));
      return;
    }
    const shelf = movableShelves.find((s) => String(s.id) === value)?.name || `#${value}`;
    setShelfMove({ shelfId: value, text: shelfMoveConfirmText({ title: manga.title || '', shelf, affected }) });
  };
  // after a jump the chosen section stays marked, also when the body cannot scroll it to the top; the reader's own
  // scrolling (wheel, touch, keys) lets the scroll position decide again
  const pinnedRef = useRef(false);
  const unpin = () => { pinnedRef.current = false; };
  const jumpTo = (id) => {
    pinnedRef.current = true;
    setActiveSection(id);
    const target = bodyRef.current?.querySelector(`[data-section="${id}"]`);
    target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  // the section in view is marked in the row of section buttons
  const onBodyScroll = () => {
    const body = bodyRef.current;
    if (!body || pinnedRef.current) return;
    const top = body.getBoundingClientRect().top;
    let current = SECTIONS[0].id;
    for (const s of body.querySelectorAll('[data-section]')) {
      if (s.getBoundingClientRect().top - top <= 48) current = s.dataset.section;
    }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = SECTIONS[SECTIONS.length - 1].id;
    setActiveSection((prev) => (prev === current ? prev : current));
  };
  const statusOptions = formData.status && !MANGA_STATUSES.includes(formData.status)
    ? [...MANGA_STATUSES, formData.status]
    : MANGA_STATUSES;
  const patch = (next) => setFormData({ ...formData, ...next });

  // in document.body: the blurred series card would otherwise be the containing block of the fixed panel
  return createPortal(
    <div
      ref={dialogRef}
      id="series-edit-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${ids}-heading`}
      tabIndex={-1}
      className="outline-none dialog-sheet z-50 bg-black/60 backdrop-blur-sm animate-fade-in"
    >
      <form
        onSubmit={handleUpdate}
        className="dialog-sheet-panel glass-panel bg-slate-950/95 border-l border-slate-800 shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 pt-4 pb-3 border-b border-slate-800">
          <h2 id={`${ids}-heading`} className="min-w-0 text-lg font-bold text-white flex items-center gap-2">
            <PenLine className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{tr('Reihe bearbeiten')}</span>
          </h2>
          <button type="button" id="btn-series-edit-close" onClick={onCancel} className="hit-44 shrink-0 p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800" aria-label={tr('Schließen')} title={tr('Schließen')}>
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <nav aria-label={tr('Abschnitte')} className="px-4 sm:px-6 py-2 border-b border-slate-800 overflow-x-auto custom-scrollbar">
          <ul className="flex gap-1.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  id={`btn-series-edit-section-${s.id}`}
                  aria-current={activeSection === s.id ? 'true' : undefined}
                  onClick={() => jumpTo(s.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap border ${activeSection === s.id ? 'bg-brand-500/20 text-brand-200 border-brand-500/50' : 'bg-slate-900 text-slate-300 border-slate-800 hover:text-white'}`}
                >
                  {tr(s.label)}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div ref={bodyRef} onScroll={onBodyScroll} onWheel={unpin} onTouchMove={unpin} onKeyDown={unpin} className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-4 sm:px-6 py-4 space-y-8">
          <Section id="basis" ids={ids} title={tr('Basis')}>
            <div>
              <label htmlFor={`${ids}-title`} className={LABEL}>{tr('Titel der Reihe')}</label>
              <div className="flex gap-2 items-center">
                <input
                  id={`${ids}-title`}
                  type="text"
                  className="input-field flex-1"
                  required
                  value={formData.title}
                  onChange={e => patch({ title: e.target.value })}
                />
                <button
                  type="button"
                  onClick={handleEditLookup}
                  disabled={editLookingUp || !formData.title.trim()}
                  className="btn-secondary text-xs flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 bg-gradient-to-r hover:from-emerald-600/30 hover:to-sky-600/30 border-brand-500/40 text-brand-300 hover:text-white shrink-0"
                  title={isMpEdition(formData) ? tr('Sucht offizielle deutsche Ausgaben über Manga Passion (mit AniList-Fallback)') : tr('Sucht in AniList und MyAnimeList (Manga Passion kennt nur deutsche Ausgaben)')}
                >
                  {editLookingUp ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>{tr('Suche...')}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                      <span>{tr('Auto-Fill')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>

              {/* Edit Lookup Error */}
              {editLookupError && (
                <div role="alert" className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
                  <CircleExclamationPoint className="w-4 h-4 shrink-0 text-amber-400" />
                  <span>{editLookupError}</span>
                </div>
              )}

              {/* Edit Lookup Results Selector */}
              {editLookupResults && editLookupResults.length > 0 && (
                <div className="bg-slate-950/95 border border-brand-500/40 rounded-xl p-3 space-y-2.5 shadow-xl">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-brand-400 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" /> {isMpEdition(formData) ? tr('Treffer auswählen (Manga Passion zuerst):') : tr('Treffer auswählen (AniList / MyAnimeList):')}
                    </span>
                    <button 
                      type="button" 
                      onClick={() => setEditLookupResults(null)}
                      className="text-slate-400 hover:text-white text-[11px]"
                    >
                      {tr('Schließen')}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
                    {editLookupResults.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => applyEditLookupResult(item)}
                        className={`flex items-center gap-2.5 p-2 rounded-lg border text-left transition-all group ${
                          item.source === 'manga_passion'
                            ? 'bg-gradient-to-r from-emerald-950/30 to-slate-900/90 border-emerald-500/40 hover:border-emerald-400 hover:from-emerald-950/50'
                            : 'bg-slate-900/80 hover:bg-brand-950/60 border-slate-800 hover:border-brand-500/50'
                        }`}
                      >
                        {item.cover_image ? (
                          <img 
                            {...assetImgProps(item.cover_image)} 
                            alt="" 
                            className="w-10 h-14 object-cover rounded shadow shrink-0" 
                          />
                        ) : (
                          <div className="w-10 h-14 bg-slate-800 rounded shrink-0 flex items-center justify-center text-slate-400">
                            <BookOpen className="w-5 h-5" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {item.source === 'manga_passion' ? (
                              <span className="inline-flex items-center gap-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1 py-px rounded text-[9px] font-bold shrink-0">
                                <Library className="w-3 h-3" aria-hidden="true" />{item.source_label || tr('Manga Passion')}
                              </span>
                            ) : lookupBadgeLabels(item).map((label) => (
                              <span key={label} className="inline-flex items-center gap-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-px rounded text-[9px] font-medium shrink-0">
                                <Globe className="w-3 h-3" aria-hidden="true" />{label}
                              </span>
                            ))}
                          </div>
                          <p className="text-xs font-semibold text-white truncate group-hover:text-brand-300">
                            {item.title}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {item.author || item.alt_title || tr('Unbekannt')}
                          </p>
                          <div className="flex flex-wrap gap-1 mt-1 text-[10px]">
                            {item.publisher && (
                              <span className="bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-medium truncate max-w-[120px]">
                                {item.publisher}
                              </span>
                            )}
                            {item.total_volumes && (
                              <span className="bg-slate-800 text-slate-200 border border-slate-700/80 px-1.5 py-0.5 rounded font-bold">
                                {formatCount(item.total_volumes, 'Band', 'Bände')}
                              </span>
                            )}
                            <span className="bg-slate-800/80 px-1.5 py-0.5 rounded text-slate-400">
                              {mangaStatusLabel(item.status)}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${ids}-alt`} className={LABEL}>{tr('Alternativer Titel')}</label>
                <input id={`${ids}-alt`} type="text" className="input-field" value={formData.alt_title} onChange={e => patch({ alt_title: e.target.value })} />
              </div>
              <div>
                <label htmlFor={`${ids}-author`} className={LABEL}>{tr('Autor / Mangaka')}</label>
                <input id={`${ids}-author`} type="text" className="input-field" value={formData.author} onChange={e => patch({ author: e.target.value })} />
              </div>
              <div>
                <label htmlFor={`${ids}-status`} className={LABEL}>{tr('Status')}</label>
                <select id={`${ids}-status`} className="input-field bg-slate-950" value={formData.status} onChange={e => patch({ status: e.target.value })}>
                  {statusOptions.map(status => (
                    <option key={status} value={status}>{mangaStatusLabel(status)}</option>
                  ))}
                </select>
              </div>
              {movableShelves.length > 1 && (
                <div>
                  <label htmlFor={`${ids}-shelf`} className={LABEL}>{tr('Regal')}</label>
                  <select
                    id={`${ids}-shelf`}
                    className="input-field bg-slate-950"
                    value={formData.shelf_id || String(manga.shelf_id || '')}
                    onChange={e => chooseShelf(e.target.value)}
                    aria-busy={checkingMove || undefined}
                  >
                    {movableShelves.map(s => (
                      <option key={s.id} value={String(s.id)}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2.5">
              <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input
                  id={`${ids}-wish`}
                  type="checkbox"
                  className="w-4 h-4 accent-rose-500"
                  checked={Boolean(formData.wish)}
                  onChange={e => patch({ wish: e.target.checked })}
                />
                {tr('Wunschliste')}
              </label>
              {formData.wish && (
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  {tr('Priorität')}
                  <select
                    id={`${ids}-wish-priority`}
                    className="input-field bg-slate-950 py-1.5 w-auto text-base sm:text-sm"
                    value={formData.wish_priority}
                    onChange={e => patch({ wish_priority: e.target.value })}
                  >
                    {PRIORITY_OPTIONS.map(o => <option key={o.value} value={String(o.value)}>{tr(o.label)}</option>)}
                  </select>
                </label>
              )}
              <span className="text-[11px] text-slate-400 basis-full">{tr('Zählt als Wunschreihe, solange noch kein Band vorhanden ist.')}</span>
            </div>

            <div>
              <label htmlFor={`${ids}-description`} className={LABEL}>{tr('Beschreibung')}</label>
              <textarea
                id={`${ids}-description`}
                rows="5"
                className="input-field resize-y"
                value={formData.description}
                onChange={e => patch({ description: e.target.value })}
              />
            </div>
          </Section>

          <Section id="edition" ids={ids} title={tr('Edition')}>
            <CatalogNotice
              manga={manga}
              disabled={saving || isOffline}
              onReset={async () => { onCancel(); await onEditionsChanged?.(); }}
            />
            <EditionFields idPrefix={`${ids}-edition`} labelClassName={LABEL} follow={false} value={formData} onChange={patch} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${ids}-publisher`} className={LABEL}>{tr('Standard-Verlag')}</label>
                <input id={`${ids}-publisher`} type="text" className="input-field" value={formData.publisher} onChange={e => patch({ publisher: e.target.value })} />
              </div>
              <div>
                <label htmlFor={`${ids}-total`} className={LABEL}>{tr('Geplante Gesamtbände')}</label>
                <input
                  id={`${ids}-total`}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="5000"
                  step="1"
                  className="input-field"
                  value={formData.total_volumes}
                  onChange={e => patch({ total_volumes: e.target.value })}
                />
              </div>
            </div>
          </Section>

          <Section id="format" ids={ids} title={tr('Format')}>
            <FormatFields idPrefix={`${ids}-format`} labelClassName={LABEL} value={formData} onChange={patch} />
          </Section>

          <Section id="bilder" ids={ids} title={tr('Bilder')}>
            <div className="flex gap-4 items-start">
              <div className="w-20 aspect-[2/3] shrink-0 rounded-lg overflow-hidden border border-slate-700/80 bg-slate-950 flex items-center justify-center">
                {coverUrl
                  ? <img key={coverUrl} {...assetImgProps(coverUrl)} alt="" className="w-full h-full object-cover" />
                  : <BookOpen className="w-6 h-6 text-slate-500" aria-hidden="true" />}
              </div>
              <div className="flex-1 min-w-0">
                <label htmlFor={`${ids}-cover`} className={LABEL}>{tr('Cover-Bild')}</label>
                <div className="flex gap-2 items-center">
                  <input
                    id={`${ids}-cover`}
                    type="text"
                    className="input-field flex-1 min-w-0"
                    placeholder={tr('URL oder Datei hochladen')}
                    value={formData.cover_image}
                    onChange={e => patch({ cover_image: e.target.value })}
                  />
                  <FilePickerButton
                    accept="image/*"
                    onChange={handleCoverInput}
                    disabled={uploadingCover}
                    label={tr('Cover-Bild hochladen')}
                    className="btn-secondary text-xs flex items-center gap-1.5 cursor-pointer shrink-0 py-2.5 px-3"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {tr('Bild')}
                  </FilePickerButton>
                </div>
                {uploadingCover && (
                  <p aria-hidden="true" className="text-xs text-brand-400 mt-1 flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin inline-block"></span>
                    {tr(COVER_UPLOAD_TEXT)}
                  </p>
                )}
              </div>
            </div>
          </Section>

          <Section id="tags" ids={ids} title={tr('Tags')}>
            <TagEditor
              id={`${ids}-tags`}
              value={formData.tags}
              onChange={(tags) => patch({ tags })}
              suggestions={tagSuggestions}
              offline={isOffline}
            />
          </Section>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 sm:px-6 py-3 border-t border-slate-800 bg-slate-950/80">
          <button type="button" onClick={onCancel} className="btn-secondary text-sm py-2 px-4">
            {tr('Abbrechen')}
          </button>
          <button type="submit" className="btn-primary text-sm py-2 px-4 flex items-center gap-1.5" disabled={saving}>
            <Save className="w-4 h-4" /> {saving ? tr('Speichert...') : tr('Speichern')}
          </button>
        </div>
      </form>

      {shelfMove && (
        <ConfirmDialog
          isOpen
          title={tr('Reihe verschieben')}
          icon={ArrowRightLeft}
          message={shelfMove.text}
          confirmLabel={tr('Verschieben')}
          cancelLabel={tr('Abbrechen')}
          onConfirm={() => {
            const { shelfId } = shelfMove;
            setShelfMove(null);
            setFormData((prev) => ({ ...prev, shelf_id: shelfId }));
          }}
          onCancel={() => setShelfMove(null)}
        />
      )}
    </div>,
    document.body
  );
}
