import { useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { BookOpen, BuildingComplex, CircleCheck, Coins, PenLine, Trash, Tv, Upload, X } from 'lucide-react';
import { assetImgProps } from '../../utils/api';
import { formatCount, formatMoney } from '../../utils/format';
import { getChapterProgress } from '../../utils/volumeHelpers';
import FilePickerButton from '../common/FilePickerButton';
import { langFor } from '../common/lang';
import WishControl from './WishControl';
import { authorShelfPath, splitAuthors } from '../../utils/seriesMeta';
import CollectingControl from './CollectingControl';
import EditionSwitcher from './EditionSwitcher';
import SeriesEditPanel, { COVER_UPLOAD_TEXT } from './SeriesEditPanel';
import WebtoonPill from '../common/WebtoonPill';
import LanguagePill from '../common/LanguagePill';
import { editionCurrency, editionLanguage, editionRegion, editionsOf } from '../../utils/editions';
import { rich } from '../../i18n/react.jsx';
import { mangaStatusLabel } from '../../utils/enumLabels';
import { t as tr, tn } from '../../i18n/index.js';
import ConfirmDialog from '../modals/ConfirmDialog';
import { afterDialogEntriesDropped } from '../../hooks/useDialogA11y';
import { seriesDeleteConfirmText } from '../../hooks/useMangaData';

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

export { TagEditor, lookupBadgeLabels } from './SeriesEditPanel';

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
  viewerShelf = false,
  movableShelves = [],
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
  canWish = false,
  onWishSaved,
  tagSuggestions = null,
  onEditionsChanged,
  onShowInfo
}) {
  const [failedCoverUrl, setFailedCoverUrl] = useState(null);
  const inRouter = useInRouterContext();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const coverUrl = heroCoverUrl({ manga, formData, editing });
  const authors = splitAuthors(manga.author);
  const currency = editionCurrency(manga);
  // a webtoon is read by chapter (ChapterProgress below the card); its volumes are optional print volumes
  const webtoon = manga?.format === 'webtoon';
  const chapters = getChapterProgress(manga || {});
  const beginEdit = () => (startEditing ? startEditing() : setEditing(true));
  const endEdit = () => (cancelEditing ? cancelEditing() : setEditing(false));
  // the hook reads the file synchronously; clearing the input lets the same file be picked again
  const handleCoverInput = (e) => {
    handleCoverUpload(e);
    e.target.value = '';
  };
  return (
    <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl flex flex-col md:flex-row gap-8 mb-8 relative overflow-hidden">

      {/* Subtle glow background */}
      <div aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-3xl pointer-events-none"><div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl -mr-20 -mt-20" /></div>

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

        {/* Quick stats under cover (a webtoon: its chapter first, volumes and value only once it has print volumes) */}
        <div className="w-full mt-4 bg-slate-950/60 rounded-xl p-3 border border-slate-800/80 flex justify-around text-center">
          {webtoon && (
            <div>
              <span className="text-[10px] uppercase font-semibold text-teal-300 block">{tr('Kapitel')}</span>
              <span className="text-sm font-bold text-white">{chapters.read} / {chapters.total || '?'}</span>
            </div>
          )}
          {(!webtoon || ownedCount > 0 || totalTarget > 0) && (
            <>
              {webtoon && <div aria-hidden="true" className="w-[1px] bg-slate-800"></div>}
              <div>
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">{tr('Bände')}</span>
                <span className="text-sm font-bold text-white">{ownedCount} / {totalTarget || '?'}{extrasCount > 0 && <span className="text-[10px] font-semibold text-fuchsia-300 ml-1" title={tr('Schuber, Specials und Extras zusätzlich zu den Bänden')}>+{extrasCount}</span>}</span>
              </div>
            </>
          )}
          {(!webtoon || totalOwnedValue > 0) && (
            <>
              <div aria-hidden="true" className="w-[1px] bg-slate-800"></div>
              <div>
                <span className="text-[10px] uppercase font-semibold text-emerald-400 block">{tr('Sammlungswert')}</span>
                <span className="text-sm font-bold text-emerald-400 font-mono">
                  {formatMoney(totalOwnedValue, currency)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Details Column */}
      <div className="flex-1 min-w-0 relative z-10">
        {/* stays in place while "Reihe bearbeiten" is open beside it */}
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
                        onClick={() => setConfirmDeleteOpen(true)} 
                        className="btn-danger text-xs flex items-center gap-1.5 py-2 px-3"
                        title={tr('Reihe löschen')}
                        aria-label={tr('Reihe löschen')}
                      >
                        <Trash className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs bg-slate-800/80 text-slate-400 px-3 py-1.5 rounded-xl border border-slate-700/60 font-medium">
                      {isOffline ? tr('Nur Leseansicht (Offline)') : viewerShelf ? tr('Nur Leseansicht (Leser)') : tr('Nur Leseansicht (Gast)')}
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
                {/* no pill for a missing publisher: the placeholder "Unbekannt" (stored by lookups) reads like a real name */}
                {manga.publisher && manga.publisher !== 'Unbekannt' && ( // i18n-ignore: stored placeholder value
                  <span className="max-w-full min-w-0 bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium flex items-center gap-1.5">
                    <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">{rich('Verlag: {publisher}', { publisher: <strong className="text-white">{manga.publisher}</strong> })}</span>
                  </span>
                )}
                {/* the edition switcher under the title already names the language of a linked series */}
                {editionsOf(manga).length === 0 && <LanguagePill language={editionLanguage(manga)} region={editionRegion(manga)} size="md" className="py-1 rounded-xl" />}
                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 rounded-xl font-semibold">
                  {mangaStatusLabel(manga.status || 'Laufend') /* i18n-ignore: stored default value */}
                </span>
                <WebtoonPill format={manga.format} size="md" />
                <CollectingControl manga={manga} canEdit={canEdit} isOffline={isOffline} onSaved={onCollectingSaved} />
                <WishControl manga={manga} canWish={canWish} onSaved={onWishSaved} />
                <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-3 py-1 rounded-xl font-semibold">
                  {webtoon
                    ? tr('Gesamt: {total}', { total: manga.total_chapters > 0 ? tn('{n} Kapitel', '{n} Kapitel', manga.total_chapters) : tr('Unbekannt') })
                    : tr('Gesamt: {total}', { total: totalTarget > 0 ? formatCount(totalTarget, 'Band', 'Bände') : tr('Unbekannt') })}
                </span>
                {/* a webtoon without bought volumes has no collection value */}
                {(!webtoon || totalOwnedValue > 0) && (
                  <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-3 py-1 rounded-xl font-semibold flex items-center gap-1.5">
                    <Coins className="w-3.5 h-3.5 text-emerald-400" />
                    {rich('Sammlungswert: {price}', { price: <strong className="text-white font-mono">{formatMoney(totalOwnedValue, currency)}</strong> })}
                  </span>
                )}
              </div>

              {/* a short excerpt; the whole description, genres and tags are in the tab "Infos" */}
              {manga.description && (
                <div id="detail-description-excerpt" className="max-w-2xl mb-6">
                  <p className="text-sm text-slate-300 leading-relaxed line-clamp-3 break-words" lang={langFor(manga.description) || undefined}>{manga.description}</p>
                  {onShowInfo && (
                    <button type="button" id="btn-show-info" onClick={onShowInfo} className="mt-1.5 text-xs font-semibold text-brand-300 hover:text-brand-200">
                      {tr('Mehr unter „Infos“')}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Progress bar (a webtoon only shows it once it has print volumes) */}
            {(!webtoon || ownedCount > 0 || totalTarget > 0) && (
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
            )}

          </div>
      </div>

      {editing && (
        <SeriesEditPanel
          applyEditLookupResult={applyEditLookupResult}
          coverUrl={shouldShowCover(coverUrl, failedCoverUrl) ? coverUrl : ''}
          editLookingUp={editLookingUp}
          editLookupError={editLookupError}
          editLookupResults={editLookupResults}
          formData={formData}
          handleCoverUpload={handleCoverUpload}
          handleEditLookup={handleEditLookup}
          handleUpdate={handleUpdate}
          isOffline={isOffline}
          manga={manga}
          movableShelves={movableShelves}
          onCancel={endEdit}
          onEditionsChanged={onEditionsChanged}
          saving={saving}
          setEditLookupResults={setEditLookupResults}
          setFormData={setFormData}
          tagSuggestions={tagSuggestions}
          uploadingCover={uploadingCover}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title={tr('Reihe löschen')}
        message={seriesDeleteConfirmText(manga?.title || '')}
        confirmLabel={tr('Löschen')}
        cancelLabel={tr('Abbrechen')}
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          // the delete navigates to the collection: only after the confirmation's history entry is gone
          afterDialogEntriesDropped(() => handleDeleteManga(true));
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
