import { useId, useRef, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { BookOpen, BuildingComplex, ChevronDown, CircleAlert, CircleCheck, Coins, Globe, Heart, Library, PenLine, RefreshCw, Save, Sparkles, Tag, Trash, Tv, Upload, X } from 'lucide-react';
import { MANGA_STATUSES } from '../../hooks/useMangaData';
import { assetImgProps, get } from '../../utils/api';
import { formatCount, formatMoney } from '../../utils/format';
import FilePickerButton from '../common/FilePickerButton';
import { langFor } from '../common/lang';
import { PRIORITY_OPTIONS, isWishedSeries, priorityBadgeClass, wishLabel } from '../../utils/priority';
import { authorShelfPath, splitAuthors } from '../../utils/seriesMeta';
import CollectingControl from './CollectingControl';
import EditionSwitcher from './EditionSwitcher';
import EditionFields from '../common/EditionFields';
import LanguagePill from '../common/LanguagePill';
import { editionCurrency, editionLanguage, editionRegion, editionsOf, isMpEdition } from '../../utils/editions';
import { joinTags, splitTags, tagKey } from '../../utils/tags';
import { rich } from '../../i18n/react.jsx';
import { mangaStatusLabel } from '../../utils/enumLabels';
import { t as tr, tn } from '../../i18n/index.js';

// i18n
const COVER_UPLOAD_TEXT = 'Cover wird hochgeladen…';

/**
 * The cover the hero shows: while the form is open an uploaded cover (/uploads/…) is previewed before 'Speichern';
 * typed URLs are not, so every keystroke does not fire an image request.
 */
export function heroCoverUrl({ manga, formData, editing }) {
  const draft = String(formData?.cover_image || '').trim();
  if (editing && draft.startsWith('/uploads/')) return draft;
  return manga?.cover_image || '';
}

export { authorShelfPath };

/** Below md a long description is clamped behind "Mehr anzeigen". */
export const isLongDescription = (text) => {
  const value = String(text || '');
  return value.length > 280 || value.split('\n').length > 5;
};

/** Shelf filtered by one genre/tag (the dashboard reads ?tags=). */
export const tagShelfPath = (tag) => `/?${new URLSearchParams({ tags: String(tag || '').trim() })}`;

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

/** A broken URL is remembered per URL: a new cover (upload, other URL) gets a fresh attempt without a reload. */
export const shouldShowCover = (url, failedUrl) => Boolean(url) && url !== failedUrl;

/** Cover, metadata, edit form and progress of the series. Purely presentational; all state and handlers come in via props. */
export default function MangaHeroCard({
  applyEditLookupResult,
  canEdit,
  completionPct,
  editLookingUp,
  editLookupError,
  editLookupResults,
  editing,
  isOffline,
  formData,
  handleCoverUpload,
  handleDeleteManga,
  handleEditLookup,
  handleUpdate,
  headingRef,
  manga,
  ownedCount,
  extrasCount = 0,
  saving,
  setEditLookupResults,
  setEditing,
  startEditing,
  cancelEditing,
  setFormData,
  totalOwnedValue,
  totalTarget,
  uploadingCover,
  onCancelCoverUpload,
  onCollectingSaved,
  tagSuggestions = null,
  onEditionsChanged,
  canFillTags = false,
  fillingTags = false,
  handleFillTags
}) {
  const [failedCoverUrl, setFailedCoverUrl] = useState(null);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const inRouter = useInRouterContext();
  const ids = useId();
  const coverUrl = heroCoverUrl({ manga, formData, editing });
  const authors = splitAuthors(manga.author);
  const seriesTags = splitTags(manga.tags);
  const longDescription = isLongDescription(manga.description);
  const currency = editionCurrency(manga);
  const beginEdit = () => (startEditing ? startEditing() : setEditing(true));
  const endEdit = () => (cancelEditing ? cancelEditing() : setEditing(false));
  // the hook reads the file synchronously; clearing the input lets the same file be picked again
  const handleCoverInput = (e) => {
    handleCoverUpload(e);
    e.target.value = '';
  };
  const statusOptions = formData.status && !MANGA_STATUSES.includes(formData.status)
    ? [...MANGA_STATUSES, formData.status]
    : MANGA_STATUSES;

  return (
    <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl flex flex-col md:flex-row gap-8 mb-8 relative overflow-hidden">

      {/* Subtle glow background */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>

      {/* Cover Column */}
      <div className="w-full md:w-64 lg:w-72 shrink-0 flex flex-col items-center">
        <div className="relative group w-48 sm:w-56 md:w-full aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl border border-slate-700/80 bg-slate-950 flex items-center justify-center">
          {shouldShowCover(coverUrl, failedCoverUrl) ? (
            <img 
              key={coverUrl}
              {...assetImgProps(coverUrl)} 
              alt={manga.title} 
              onError={() => setFailedCoverUrl(coverUrl)}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
              <BookOpen className="w-12 h-12 stroke-[1.5] text-slate-400" />
              <span className="text-xs font-medium text-slate-400">{tr('Kein Cover vorhanden')}</span>
            </div>
          )}

          {/* Cover Upload Overlay */}
          {canEdit && (
            <FilePickerButton
              id="cover-upload"
              accept="image/*"
              onChange={handleCoverInput}
              disabled={uploadingCover}
              className={'absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 flex flex-col items-center justify-center gap-2 cursor-pointer transition-opacity text-white text-xs font-semibold ' +
                '[@media(hover:none)]:opacity-100 [@media(hover:none)]:inset-auto [@media(hover:none)]:inset-x-0 [@media(hover:none)]:bottom-0 [@media(hover:none)]:flex-row [@media(hover:none)]:py-2.5 [@media(hover:none)]:bg-black/75'}
            >
              <Upload className="w-6 h-6 text-brand-400 [@media(hover:none)]:w-4 [@media(hover:none)]:h-4" />
              <span>{tr('Cover ändern')}</span>
            </FilePickerButton>
          )}

          {uploadingCover && (
            <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3">
              <span aria-hidden="true" className="block w-6 h-6 rounded-full animate-spin border-2 border-brand-500 border-t-transparent" />
              {onCancelCoverUpload && (
                <button
                  type="button"
                  onClick={onCancelCoverUpload}
                  className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 text-red-300 hover:text-red-200"
                  title={tr('Cover-Upload abbrechen')}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" /> {tr('Upload abbrechen')}
                </button>
              )}
            </div>
          )}
        </div>
        {/* one live region that is always mounted: a region mounted together with its text is often not announced */}
        <p role="status" className="sr-only">{uploadingCover ? tr(COVER_UPLOAD_TEXT) : ''}</p>

        {/* Quick stats under cover */}
        <div className="w-full mt-4 bg-slate-950/60 rounded-xl p-3 border border-slate-800/80 flex justify-around text-center">
          <div>
            <span className="text-[10px] uppercase font-semibold text-slate-400 block">{tr('Bände')}</span>
            <span className="text-sm font-bold text-white">{ownedCount} / {totalTarget || '?'}{extrasCount > 0 && <span className="text-[10px] font-semibold text-fuchsia-300 ml-1" title={tr('Schuber, Specials und Extras zusätzlich zu den Bänden')}>+{extrasCount}</span>}</span>
          </div>
          <div aria-hidden="true" className="w-[1px] bg-slate-800"></div>
          <div>
            <span className="text-[10px] uppercase font-semibold text-emerald-400 block">{tr('Sammlungswert')}</span>
            <span className="text-sm font-bold text-emerald-400 font-mono">
              {formatMoney(totalOwnedValue, currency)}
            </span>
          </div>
        </div>
      </div>

      {/* Details Column */}
      <div className="flex-1 min-w-0 relative z-10">
        {editing ? (
          /* EDIT MODE */
          <form onSubmit={handleUpdate} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
              <h2 className="min-w-0 text-lg font-bold text-white flex items-center gap-2">
                <PenLine className="w-4 h-4 text-brand-400" aria-hidden="true" /> {tr('Manga bearbeiten')}
              </h2>
              <div className="flex gap-2 ml-auto">
                <button 
                  type="button" 
                  onClick={endEdit} 
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  {tr('Abbrechen')}
                </button>
                <button 
                  type="submit" 
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                  disabled={saving}
                >
                  <Save className="w-3.5 h-3.5" /> {saving ? tr('Speichert...') : tr('Speichern')}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${ids}-title`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Titel der Reihe')}</label>
                <div className="flex gap-2 items-center">
                  <input 
                    id={`${ids}-title`}
                    type="text" 
                    className="input-field flex-1" 
                    required
                    value={formData.title} 
                    onChange={e => setFormData({ ...formData, title: e.target.value })} 
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
              <div>
                <label htmlFor={`${ids}-alt`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Alternativer Titel')}</label>
                <input 
                  id={`${ids}-alt`}
                  type="text" 
                  className="input-field" 
                  value={formData.alt_title} 
                  onChange={e => setFormData({ ...formData, alt_title: e.target.value })} 
                />
              </div>
            </div>

            {/* Edit Lookup Error */}
            {editLookupError && (
              <div role="alert" className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
                <CircleAlert className="w-4 h-4 shrink-0 text-amber-400" />
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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor={`${ids}-author`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Autor / Mangaka')}</label>
                <input 
                  id={`${ids}-author`}
                  type="text" 
                  className="input-field" 
                  value={formData.author} 
                  onChange={e => setFormData({ ...formData, author: e.target.value })} 
                />
              </div>
              <div>
                <label htmlFor={`${ids}-publisher`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Standard-Verlag')}</label>
                <input 
                  id={`${ids}-publisher`}
                  type="text" 
                  className="input-field" 
                  value={formData.publisher} 
                  onChange={e => setFormData({ ...formData, publisher: e.target.value })} 
                />
              </div>
              <div>
                <label htmlFor={`${ids}-status`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Status')}</label>
                <select 
                  id={`${ids}-status`}
                  className="input-field bg-slate-950"
                  value={formData.status} 
                  onChange={e => setFormData({ ...formData, status: e.target.value })}
                >
                  {statusOptions.map(status => (
                    <option key={status} value={status}>{mangaStatusLabel(status)}</option>
                  ))}
                </select>
              </div>
            </div>

            <EditionFields
              idPrefix={`${ids}-edition`}
              labelClassName="block text-xs font-semibold text-slate-400 mb-1"
              follow={false}
              value={formData}
              onChange={(patch) => setFormData({ ...formData, ...patch })}
            />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2.5">
              <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input
                  id={`${ids}-wish`}
                  type="checkbox"
                  className="w-4 h-4 accent-rose-500"
                  checked={Boolean(formData.wish)}
                  onChange={e => setFormData({ ...formData, wish: e.target.checked })}
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
                    onChange={e => setFormData({ ...formData, wish_priority: e.target.value })}
                  >
                    {PRIORITY_OPTIONS.map(o => <option key={o.value} value={String(o.value)}>{tr(o.label)}</option>)}
                  </select>
                </label>
              )}
              <span className="text-[11px] text-slate-400 basis-full">{tr('Zählt als Wunschreihe, solange noch kein Band vorhanden ist.')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${ids}-total`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Geplante Gesamtbände')}</label>
                <input 
                  id={`${ids}-total`}
                  type="number" 
                  inputMode="numeric"
                  min="1"
                  max="5000"
                  step="1"
                  className="input-field" 
                  value={formData.total_volumes} 
                  onChange={e => setFormData({ ...formData, total_volumes: e.target.value })} 
                />
              </div>
              <div>
                <label htmlFor={`${ids}-cover`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Cover-Bild')}</label>
                <div className="flex gap-2 items-center">
                  <input 
                    id={`${ids}-cover`}
                    type="text" 
                    className="input-field flex-1" 
                    placeholder={tr('URL oder Datei hochladen')}
                    value={formData.cover_image} 
                    onChange={e => setFormData({ ...formData, cover_image: e.target.value })} 
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

            <TagEditor
              id={`${ids}-tags`}
              value={formData.tags}
              onChange={(tags) => setFormData({ ...formData, tags })}
              suggestions={tagSuggestions}
              offline={isOffline}
            />

            <div>
              <label htmlFor={`${ids}-description`} className="block text-xs font-semibold text-slate-400 mb-1">{tr('Beschreibung')}</label>
              <textarea 
                id={`${ids}-description`}
                rows="3" 
                className="input-field resize-none" 
                value={formData.description} 
                onChange={e => setFormData({ ...formData, description: e.target.value })} 
              />
            </div>
          </form>
        ) : (
          /* VIEW MODE */
          <div className="flex flex-col h-full justify-between">
            <div>
              {/* Title & Action Buttons */}
              <div id="detail-hero-title-row" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-3">
                <div className="min-w-0 basis-full xl:basis-0 xl:flex-1">
                  <h1 ref={headingRef} tabIndex={-1} lang={langFor(manga.title) || 'de'} className="focus:outline-none text-2xl sm:text-3xl xl:text-4xl font-extrabold text-white tracking-tight break-words hyphens-auto [overflow-wrap:anywhere]">
                    {manga.title}
                  </h1>
                  {manga.alt_title && (
                    <p className="text-sm text-slate-400 mt-0.5 break-words" lang={langFor(manga.alt_title)}>{manga.alt_title}</p>
                  )}
                  {inRouter && <EditionSwitcher manga={manga} canEdit={canEdit} isOffline={isOffline} onChanged={onEditionsChanged} />}
                </div>

                <div id="detail-hero-actions" className="flex flex-wrap items-center gap-2 xl:shrink-0">
                  {canEdit ? (
                    <>
                      {inRouter && manga.id && (
                        <Link
                          id="btn-anime-adaption"
                          to={`/?view=anime&add=${manga.id}`}
                          className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3 text-fuchsia-200"
                          title={tr('Anime-Adaption dieser Reihe suchen und hinzufügen')}
                        >
                          <Tv className="w-3.5 h-3.5" aria-hidden="true" /> {tr('Anime-Adaption')}
                        </Link>
                      )}
                      <button 
                        id="btn-edit-manga"
                        onClick={beginEdit} 
                        className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
                      >
                        <PenLine className="w-3.5 h-3.5" /> {tr('Bearbeiten')}
                      </button>
                      <button 
                        id="btn-delete-manga"
                        onClick={handleDeleteManga} 
                        className="btn-danger text-xs flex items-center gap-1.5 py-2 px-3"
                        title={tr('Reihe löschen')}
                        aria-label={tr('Reihe löschen')}
                      >
                        <Trash className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs bg-slate-800/80 text-slate-400 px-3 py-1.5 rounded-xl border border-slate-700/60 font-medium">
                      {isOffline ? tr('Nur Leseansicht (Offline)') : tr('Nur Leseansicht (Gast)')}
                    </span>
                  )}
                </div>
              </div>

              {/* Badges */}
              <div className="flex flex-wrap items-center gap-2 text-xs mb-6 min-w-0">
                <span className="max-w-full break-words bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium">
                  {rich('Autor: {authors}', { authors: inRouter && authors.length > 0 ? authors.map((name, i) => (
                    <span key={`${i}-${name}`}>
                      {i > 0 && ', '}
                      <Link
                        to={authorShelfPath(name)}
                        className="font-bold text-white underline decoration-slate-500 underline-offset-2 hover:text-brand-300 hover:decoration-brand-400"
                        title={tr('Alle Reihen von {name} in der Sammlung', { name })}
                      >
                        {name}
                      </Link>
                    </span>
                  )) : <strong className="text-white">{manga.author || tr('Unbekannt')}</strong> })}
                </span>
                <span className="max-w-full min-w-0 bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium flex items-center gap-1.5">
                  <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <span className="min-w-0 break-words">{rich('Verlag: {publisher}', { publisher: <strong className="text-white">{manga.publisher && manga.publisher !== 'Unbekannt' ? manga.publisher : tr('Unbekannt')}</strong> })}</span>
                </span>
                {/* the edition switcher under the title already names the language of a linked series */}
                {editionsOf(manga).length === 0 && <LanguagePill language={editionLanguage(manga)} region={editionRegion(manga)} size="md" className="py-1 rounded-xl" />}
                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 rounded-xl font-semibold">
                  {mangaStatusLabel(manga.status || 'Laufend') /* i18n-ignore: stored default value */}
                </span>
                <CollectingControl manga={manga} canEdit={canEdit} isOffline={isOffline} onSaved={onCollectingSaved} />
                {isWishedSeries(manga) && (
                  <span id="detail-wish-pill" className={`px-3 py-1 rounded-xl border font-semibold flex items-center gap-1.5 ${priorityBadgeClass(manga.wish_priority)}`}>
                    <Heart className="w-3.5 h-3.5" aria-hidden="true" />
                    {wishLabel(manga)}
                  </span>
                )}
                <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-3 py-1 rounded-xl font-semibold">
                  {tr('Gesamt: {total}', { total: totalTarget > 0 ? formatCount(totalTarget, 'Band', 'Bände') : tr('Unbekannt') })}
                </span>
                <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-3 py-1 rounded-xl font-semibold flex items-center gap-1.5">
                  <Coins className="w-3.5 h-3.5 text-emerald-400" />
                  {rich('Sammlungswert: {price}', { price: <strong className="text-white font-mono">{formatMoney(totalOwnedValue, currency)}</strong> })}
                </span>
              </div>

              {seriesTags.length > 0 && (
                <ul id="detail-tags" className="flex flex-wrap items-center gap-1.5 -mt-3 mb-6 text-xs" aria-label={tr('Genres und Tags')}>
                  <li aria-hidden="true"><Tag className="w-3.5 h-3.5 text-fuchsia-400" /></li>
                  {seriesTags.map((tag) => (
                    <li key={tag.toLowerCase()}>
                      {inRouter ? (
                        <Link
                          to={tagShelfPath(tag)}
                          className="inline-block rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 text-fuchsia-200 hover:bg-fuchsia-500/25"
                          title={tr('Alle Reihen mit „{tag}“', { tag })}
                        >
                          {tag}
                        </Link>
                      ) : (
                        <span className="inline-block rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 text-fuchsia-200">{tag}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {seriesTags.length === 0 && canFillTags && handleFillTags && (
                <div className="-mt-3 mb-6">
                  <button
                    type="button"
                    id="btn-fill-tags"
                    onClick={handleFillTags}
                    disabled={fillingTags}
                    className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
                    title={tr('Genres aus der verknüpften Manga-Passion-Edition übernehmen')}
                  >
                    <Tag className="w-3.5 h-3.5 text-fuchsia-400" aria-hidden="true" />
                    {fillingTags ? tr('Genres werden geladen…') : tr('Genres nachladen')}
                  </button>
                </div>
              )}

              {/* Description */}
              <div className="mb-6">
                <h2 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2">{tr('Beschreibung')}</h2>
                <div className="max-w-2xl bg-slate-950/40 p-4 rounded-2xl border border-slate-800/60">
                  <p
                    id={`${ids}-description-text`}
                    className={`text-sm text-slate-300 leading-relaxed whitespace-pre-line break-words ${longDescription && !descriptionOpen ? 'line-clamp-5 md:line-clamp-none' : ''}`}
                  >
                    {manga.description || (canEdit
                      ? tr('Keine Beschreibung vorhanden. Klicke auf "Bearbeiten", um eine Inhaltsangabe hinzuzufügen.')
                      : tr('Keine Beschreibung vorhanden.'))}
                  </p>
                  {longDescription && (
                    <button
                      type="button"
                      id="btn-description-more"
                      aria-expanded={descriptionOpen}
                      aria-controls={`${ids}-description-text`}
                      onClick={() => setDescriptionOpen((open) => !open)}
                      className="hit-44 md:hidden mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-300 hover:text-brand-200"
                    >
                      {descriptionOpen ? tr('Weniger anzeigen') : tr('Mehr anzeigen')}
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${descriptionOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="pt-4 border-t border-slate-800/80">
              <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-1 text-xs mb-2">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <CircleCheck className="w-4 h-4 text-emerald-400" />
                  {tr('Sammlungs-Fortschritt')}
                </span>
                <span className="text-slate-400 font-mono">
                  <strong className="text-emerald-400">{ownedCount}</strong> {totalTarget > 0 ? `/ ${totalTarget}` : tr('im Besitz')}{extrasCount > 0 ? ` ${tn('+ {n} Extras', '+ {n} Extras', extrasCount)}` : ''} 
                  {completionPct !== null && ` (${completionPct}%)`}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={tr('Sammlungs-Fortschritt')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={completionPct ?? 0}
                aria-valuetext={totalTarget > 0 ? tr('{owned} von {total}', { owned: ownedCount, total: formatCount(totalTarget, 'Band', 'Bänden') }) : tr('{volumes} im Besitz', { volumes: formatCount(ownedCount, 'Band', 'Bände') })}
                className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800"
              >
                <div 
                  className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 transition-all duration-500"
                  style={{ width: `${completionPct !== null ? completionPct : 0}%` }}
                />
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
