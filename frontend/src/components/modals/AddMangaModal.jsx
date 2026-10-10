// Add-series dialog: lookup search, manual form and cover; also creates a volume scanned by ISBN.
import { useState, useEffect, useRef, useId } from 'react';
import { Plus, X, Sparkles, RefreshCw, TriangleAlert, BookOpen, Upload, ScanBarcode, Globe, Library } from 'lucide-react';
import { buildScanVolumePayload } from '../../utils/scanHelpers';
import { MANGA_STATUSES, lookupMangaUrl } from '../../hooks/useMangaData';
import { UPLOAD_CANCELLED } from '../../hooks/useVolumeActions';
import useDialogA11y from '../../hooks/useDialogA11y';
import { apiFetch, readJson, TIMEOUTS, assetImgProps, isAbortError } from '../../utils/api';
import { formatCount } from '../../utils/format';
import FilePickerButton from '../common/FilePickerButton';
import { prepareImageForUpload } from '../../utils/imageResize';
import { PRIORITY_OPTIONS, DEFAULT_WISH_PRIORITY } from '../../utils/priority';
import { t } from '../../i18n/index.js';
import { serverText } from '../../i18n/serverText.js';
import { mangaStatusLabel } from '../../utils/enumLabels';
import EditionFields from '../common/EditionFields';
import { editionDefaults, isMpEdition } from '../../utils/editions';
import { hitToForm, lookupSourceLabels } from '../../utils/lookupPrefill';

export { lookupSourceLabels };

// i18n
const EMPTY_FORM = {
  title: '',
  alt_title: '',
  author: '',
  publisher: '',
  status: 'Laufend',
  total_volumes: '',
  description: '',
  cover_image: '',
  manga_passion_id: null,
  // edition (ISO codes); the dialog starts with the account's default language (editionDefaults)
  language: 'de',
  region: '',
  currency: 'EUR',
  work_key: null,
  wish: false,
  wish_priority: String(DEFAULT_WISH_PRIORITY)
};
const MAX_COVER_BYTES = 15 * 1024 * 1024;
// i18n
const NETWORK_ERROR = 'Netzwerkfehler – bitte Verbindung prüfen und erneut versuchen.';
// i18n
const LOOKUP_SOURCES_HINT = 'Sucht in Manga Passion (deutsche Ausgaben), AniList und MyAnimeList';
// i18n
const LOOKUP_SOURCES_HINT_OTHER = 'Sucht in AniList und MyAnimeList (Manga Passion kennt nur deutsche Ausgaben)';

const isRemoteUrl = (url) => /^https?:\/\//i.test(url || '');
const isBlobUrl = (url) => typeof url === 'string' && url.startsWith('blob:');
const lookupKey = (item) => item.id ?? item.title;

async function request(url, init) {
  try {
    return await apiFetch(url, init);
  } catch {
    throw new Error(t(NETWORK_ERROR));
  }
}

/** Copies a remote image into /uploads through the server; resolves to the local URL, or '' when that fails. */
async function cacheRemoteCover(url) {
  try {
    const res = await apiFetch('/api/upload-remote', { method: 'POST', body: { url }, timeout: TIMEOUTS.remote });
    if (!res.ok) return '';
    return (await readJson(res))?.url || '';
  } catch {
    return '';
  }
}

// prefill: { form, volume } from an ISBN scan (utils/scanHelpers.js buildScanPrefill); also creates the scanned volume.
// onSeriesCreated(manga) fires when the series exists but the dialog stays open because the scanned volume failed.
export default function AddMangaModal({ isOpen, onClose, onSuccess, onSeriesCreated, prefill = null }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [coverFile, setCoverFile] = useState(null);
  const [coverPreview, setCoverPreview] = useState('');
  const [coverCaching, setCoverCaching] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResults, setLookupResults] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [applyingId, setApplyingId] = useState(null);
  const [failedImages, setFailedImages] = useState({});
  const [scanVolume, setScanVolume] = useState(null);
  // series created, scanned volume failed: the next submit only retries the volume
  const [createdManga, setCreatedManga] = useState(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const uploadAbortRef = useRef(null);

  const sessionRef = useRef(0);
  const applySeqRef = useRef(0);
  const prefillCoverRef = useRef(null);
  const backdropDownRef = useRef(false);
  const ids = useId();

  const replacePreview = (next) => setCoverPreview(prev => {
    if (isBlobUrl(prev) && prev !== next) URL.revokeObjectURL(prev);
    return next;
  });

  useEffect(() => {
    sessionRef.current += 1;
    prefillCoverRef.current = null;
    setApplyingId(null);
    setLookingUp(false);
    if (!isOpen) {
      replacePreview('');
      return undefined;
    }
    setForm({ ...EMPTY_FORM, ...editionDefaults(), ...(prefill?.form || {}) });
    setScanVolume(prefill?.volume || null);
    setCreatedManga(null);
    setErrorMessage('');
    setCoverFile(null);
    replacePreview(prefill?.form?.cover_image || '');
    setLookupResults(null);
    setLookupError('');

    // Catalogue cover (Open Library): cache it locally; if there is none, drop it instead of saving a dead link.
    // Submit awaits the same promise, so a quick submit never stores the remote URL.
    const remoteCover = prefill?.form?.cover_image;
    if (!isRemoteUrl(remoteCover)) {
      setCoverCaching(false);
      return undefined;
    }
    let cancelled = false;
    const promise = cacheRemoteCover(remoteCover);
    prefillCoverRef.current = { remote: remoteCover, promise };
    setCoverCaching(true);
    promise.then(local => {
      if (cancelled) return;
      setForm(prev => (prev.cover_image === remoteCover ? { ...prev, cover_image: local } : prev));
      setCoverPreview(prev => (prev === remoteCover ? local : prev));
      setCoverCaching(false);
    });
    return () => {
      cancelled = true;
      setCoverCaching(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [isOpen]);

  const handleClose = () => {
    sessionRef.current += 1;
    replacePreview('');
    setCoverFile(null);
    setLookupResults(null);
    setLookupError('');
    setApplyingId(null);
    setScanVolume(null);
    setCreatedManga(null);
    onClose();
  };

  const requestClose = () => {
    if (!submitting) handleClose();
  };

  const handleLookupMetadata = async () => {
    if (!form.title.trim()) {
      setLookupError(t('Bitte gib zuerst einen Titel ein.'));
      return;
    }
    const session = sessionRef.current;
    setLookingUp(true);
    setLookupError('');
    setLookupResults(null);
    try {
      const res = await apiFetch(lookupMangaUrl(form.title.trim(), form.language), { timeout: TIMEOUTS.lookup });
      const data = await readJson(res);
      if (session !== sessionRef.current) return;
      if (!res.ok) {
        setLookupError(serverText(data) || t('Fehler bei der Suche'));
      } else if (!Array.isArray(data) || data.length === 0) {
        setLookupError(t('Keine Treffer gefunden.'));
      } else if (data.length === 1) {
        await applyLookupResult(data[0]);
      } else {
        setLookupResults(data);
      }
    } catch (e) {
      if (session !== sessionRef.current) return;
      setLookupError(e?.code === 'TIMEOUT'
        ? t('Die Metadatensuche hat zu lange gedauert. Bitte erneut versuchen.')
        : t('Netzwerkfehler bei der Metadatensuche'));
    } finally {
      if (session === sessionRef.current) setLookingUp(false);
    }
  };

  const applyLookupResult = async (item) => {
    const seq = ++applySeqRef.current;
    const session = sessionRef.current;
    const isCurrent = () => seq === applySeqRef.current && session === sessionRef.current;
    setApplyingId(lookupKey(item));
    try {
      let cover = item.cover_image || '';
      if (isRemoteUrl(cover)) cover = (await cacheRemoteCover(cover)) || cover;
      if (!isCurrent()) return;
      setForm(prev => hitToForm({ ...item, cover_image: cover }, prev));
      if (cover) {
        setCoverFile(null);
        replacePreview(cover);
      }
      setLookupResults(null);
      setLookupError('');
    } finally {
      if (isCurrent()) setApplyingId(null);
    }
  };

  const closeLookupResults = () => {
    applySeqRef.current += 1;
    setApplyingId(null);
    setLookupResults(null);
  };

  const handleCoverChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_COVER_BYTES) {
      setErrorMessage(t('Bild ist größer als 15 MB'));
      return;
    }
    setErrorMessage('');
    setCoverFile(file);
    replacePreview(URL.createObjectURL(file));
  };

  /** Cover for POST /api/mangas: uploaded file, cached catalogue/typed URL, or null. A URL the server cannot fetch is kept as typed. */
  const resolveSeriesCover = async () => {
    if (coverFile) {
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setUploadingCover(true);
      try {
        const fd = new FormData();
        fd.append('image', await prepareImageForUpload(coverFile));
        if (controller.signal.aborted) throw new DOMException(UPLOAD_CANCELLED, 'AbortError');
        let upRes;
        try {
          upRes = await apiFetch('/api/upload', { method: 'POST', body: fd, signal: controller.signal });
        } catch (err) {
          throw isAbortError(err) ? err : new Error(t(NETWORK_ERROR));
        }
        const upData = await readJson(upRes);
        if (controller.signal.aborted) throw new DOMException(UPLOAD_CANCELLED, 'AbortError');
        if (!upRes.ok || !upData?.url) throw new Error(serverText(upData) || t('Fehler beim Cover-Upload'));
        return upData.url;
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
        setUploadingCover(false);
      }
    }
    const typed = form.cover_image.trim();
    const pending = prefillCoverRef.current;
    if (pending && typed === pending.remote) return (await pending.promise) || null;
    if (isRemoteUrl(typed)) return (await cacheRemoteCover(typed)) || typed;
    return typed || null;
  };

  /** Creates the scanned volume; resolves to null on success or to the error text. */
  const createScanVolume = async (mangaId, isRetry) => {
    let res;
    try {
      res = await apiFetch('/api/volumes', {
        method: 'POST',
        body: buildScanVolumePayload(mangaId, scanVolume)
      });
    } catch {
      return t('Netzwerkfehler – bitte Verbindung prüfen');
    }
    if (res.ok) return null;
    const body = await readJson(res);
    // the earlier attempt reached the server but its answer got lost
    if (isRetry && res.status === 409 && body?.existing_id) return null;
    return serverText(body) || t('Fehler beim Anlegen des Bands');
  };

  const handleCreateManga = async (e) => {
    e.preventDefault();
    if (submitting || applyingId !== null) return;
    if (!createdManga && !form.title.trim()) {
      setErrorMessage(t('Bitte gib einen Titel ein.'));
      return;
    }
    const withVolume = Boolean(scanVolume?.enabled);
    if (withVolume && !String(scanVolume.volume_number ?? '').trim()) {
      setErrorMessage(t('Bitte gib die Bandnummer des gescannten Buchs ein (oder deaktiviere „Gescannten Band gleich anlegen“).'));
      return;
    }

    setSubmitting(true);
    setErrorMessage('');

    try {
      let manga = createdManga;
      const isRetry = Boolean(manga);
      if (!manga) {
        const cover = await resolveSeriesCover();
        const res = await request('/api/mangas', {
          method: 'POST',
          body: {
            title: form.title.trim(),
            alt_title: form.alt_title.trim() || null,
            author: form.author.trim() || null,
            publisher: form.publisher.trim() || null,
            status: form.status,
            total_volumes: form.total_volumes ? parseInt(form.total_volumes, 10) : null,
            description: form.description.trim() || null,
            cover_image: cover,
            manga_passion_id: form.manga_passion_id || null,
            wish_priority: form.wish ? Number(form.wish_priority) : null,
            language: form.language,
            region: form.region || null,
            currency: form.currency,
            ...(form.work_key ? { work_key: form.work_key } : {})
          }
        });
        const data = await readJson(res);
        if (!res.ok) throw new Error(serverText(data) || t('Fehler beim Erstellen des Mangas'));
        if (!data?.id) {
          throw new Error(t('Die Antwort des Servers war unlesbar. Die Reihe wurde eventuell trotzdem angelegt – bitte die Sammlung prüfen, bevor du es erneut versuchst.'));
        }
        manga = data;
        setCreatedManga(data);
      }

      if (withVolume) {
        const volumeError = await createScanVolume(manga.id, isRetry);
        if (volumeError) {
          if (!isRetry && onSeriesCreated) onSeriesCreated(manga);
          setErrorMessage(t('Die Reihe wurde angelegt, der Band aber nicht: {reason}. Mit „Band anlegen“ erneut versuchen.', { reason: volumeError.replace(/[.\s]+$/, '') }));
          return;
        }
      }

      handleClose();
      if (onSuccess) onSuccess(manga);
    } catch (err) {
      setErrorMessage(isAbortError(err) ? t(UPLOAD_CANCELLED) : (err?.message || t('Unbekannter Fehler')));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelCoverUpload = () => uploadAbortRef.current?.abort();
  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  const seriesLocked = Boolean(createdManga);
  const applying = applyingId !== null;
  const submitLabel = seriesLocked ? (scanVolume?.enabled ? t('Band anlegen') : t('Fertig')) : t('Manga anlegen');

  return (
    <div
      onPointerDown={(e) => { backdropDownRef.current = e.target === e.currentTarget; }}
      onMouseDown={(e) => { backdropDownRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const startedOnBackdrop = backdropDownRef.current;
        backdropDownRef.current = false;
        if (startedOnBackdrop && e.target === e.currentTarget) requestClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (lookupResults) closeLookupResults();
        else requestClose();
      }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('Neuen Manga anlegen')}
      data-busy={submitting ? 'true' : undefined}
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-xl rounded-2xl sm:rounded-3xl p-5 sm:p-8 short:p-4 border border-slate-700/80 shadow-2xl relative">

        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-6 pb-4 short:mb-3 short:pb-2 border-b border-slate-800">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-brand-500/20 border border-brand-500/40 text-brand-400 flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{t('Neuen Manga anlegen')}</h2>
              <p className="text-xs text-slate-400 short:hidden">{t('Erfasse eine neue Reihe in deiner Sammlung')}</p>
            </div>
          </div>
          <button
            id="btn-close-add-modal-x"
            type="button"
            onClick={handleClose}
            disabled={submitting}
            aria-label={t('Schließen')}
            className="hit-44 shrink-0 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Banner */}
        {errorMessage && (
          <div role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleCreateManga} className="space-y-4">
          {seriesLocked && (
            <p className="bg-emerald-950/30 border border-emerald-500/30 text-emerald-200 rounded-xl p-3 text-xs">
              {t('Reihe „{title}“ ist bereits angelegt. Änderungen an der Reihe später über „Bearbeiten“ auf ihrer Seite.', { title: form.title.trim() })}
            </p>
          )}

          <fieldset disabled={seriesLocked} className="space-y-4 min-w-0 disabled:opacity-60">
          <div>
            <div className="mb-1.5 flex justify-between items-center gap-2">
              <label htmlFor={`${ids}-title`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                {t('Titel')} <span className="text-red-400">*</span>
              </label>
              <span className="text-[11px] text-brand-400 font-normal">{t('Tipp: Titel eingeben & auf „Auto-Fill“ klicken')}</span>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id={`${ids}-title`}
                type="text"
                placeholder={t('z.B. One Piece, Chainsaw Man, Frieren...')}
                className="input-field flex-1"
                required
                data-autofocus
                value={form.title}
                onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, title: value })); }}
              />
              <button
                type="button"
                onClick={handleLookupMetadata}
                disabled={lookingUp || applying || !form.title.trim()}
                className="btn-secondary text-xs flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 bg-gradient-to-r hover:from-emerald-600/30 hover:to-sky-600/30 border-brand-500/40 text-brand-300 hover:text-white"
                title={t(isMpEdition(form) ? LOOKUP_SOURCES_HINT : LOOKUP_SOURCES_HINT_OTHER)}
              >
                {lookingUp ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>{t('Suche...')}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                    <span>{t('Auto-Fill')}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Lookup Error Banner */}
          {lookupError && (
            <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
              <TriangleAlert className="w-4 h-4 shrink-0 text-amber-400" />
              <span>{lookupError}</span>
            </div>
          )}

          {/* Lookup Results Selector */}
          {!seriesLocked && lookupResults && lookupResults.length > 0 && (
            <div className="bg-slate-950/95 border border-brand-500/40 rounded-xl p-3 space-y-2.5 shadow-xl" aria-busy={applying || undefined}>
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-brand-400 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> {isMpEdition(form) ? t('Treffer auswählen (Manga Passion zuerst):') : t('Treffer auswählen (AniList / MyAnimeList):')}
                </span>
                <button
                  type="button"
                  onClick={closeLookupResults}
                  disabled={applying}
                  className="text-slate-400 hover:text-white text-[11px] disabled:opacity-50"
                >
                  {t('Schließen')}
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                {lookupResults.map(item => {
                  const isApplying = applyingId === lookupKey(item);
                  return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => applyLookupResult(item)}
                    disabled={applying}
                    aria-busy={isApplying || undefined}
                    className={`flex items-center gap-2.5 p-2 rounded-lg border text-left transition-all group disabled:cursor-wait ${
                      applying && !isApplying ? 'opacity-50' : ''
                    } ${
                      item.source === 'manga_passion'
                        ? 'bg-gradient-to-r from-emerald-950/30 to-slate-900/90 border-emerald-500/40 hover:border-emerald-400 hover:from-emerald-950/50'
                        : 'bg-slate-900/80 hover:bg-brand-950/60 border-slate-800 hover:border-brand-500/50'
                    }`}
                  >
                    {item.cover_image && !failedImages[`lookup-${item.id || item.title}`] ? (
                      <img
                        {...assetImgProps(item.cover_image)}
                        alt={item.title}
                        onError={() => setFailedImages(prev => ({ ...prev, [`lookup-${item.id || item.title}`]: true }))}
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
                            <Library className="w-3 h-3" aria-hidden="true" />{t('Manga Passion')}
                          </span>
                        ) : lookupSourceLabels(item).map((label) => (
                          <span key={label} className="inline-flex items-center gap-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-px rounded text-[9px] font-medium shrink-0">
                            <Globe className="w-3 h-3" aria-hidden="true" />{label}
                          </span>
                        ))}
                        {isApplying && (
                          <span className="flex items-center gap-1 text-[10px] text-brand-300">
                            <RefreshCw className="w-3 h-3 animate-spin" /> {t('Wird übernommen…')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-semibold text-white truncate group-hover:text-brand-300">
                        {item.title}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {item.author || item.alt_title || t('Unbekannt')}
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
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${ids}-author`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                {t('Autor / Mangaka')}
              </label>
              <input
                id={`${ids}-author`}
                type="text"
                placeholder={t('z.B. Eiichiro Oda')}
                className="input-field"
                value={form.author}
                onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, author: value })); }}
              />
            </div>

            <div>
              <label htmlFor={`${ids}-publisher`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                {t('Verlag')}
              </label>
              <input
                id={`${ids}-publisher`}
                type="text"
                placeholder={t('z.B. Carlsen Manga, Tokyopop...')}
                className="input-field"
                value={form.publisher}
                onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, publisher: value })); }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${ids}-status`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                {t('Status')}
              </label>
              <select
                id={`${ids}-status`}
                className="input-field bg-slate-950"
                value={form.status}
                onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, status: value })); }}
              >
                {MANGA_STATUSES.map(status => <option key={status} value={status}>{mangaStatusLabel(status)}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor={`${ids}-total`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                {t('Geplante / Gesamtbände')}
              </label>
              <input
                id={`${ids}-total`}
                type="number"
                inputMode="numeric"
                min="1"
                max="5000"
                step="1"
                placeholder={t('z.B. 108')}
                className="input-field"
                value={form.total_volumes}
                onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, total_volumes: value })); }}
              />
            </div>
          </div>

          <EditionFields
            idPrefix={`${ids}-edition`}
            value={form}
            // a picked Manga Passion hit names a German edition: another language must not keep its id (409 MP_LANGUAGE later)
            onChange={(patch) => setForm(prev => ({ ...prev, ...patch, ...(patch.language && !isMpEdition(patch) ? { manga_passion_id: null } : {}) }))}
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2.5">
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input
                id={`${ids}-wish`}
                type="checkbox"
                className="w-4 h-4 accent-rose-500"
                checked={form.wish}
                onChange={e => { const checked = e.target.checked; setForm(prev => ({ ...prev, wish: checked })); }}
              />
              {t('Auf die Wunschliste')}
            </label>
            {form.wish && (
              <label className="flex items-center gap-2 text-xs text-slate-300">
                {t('Priorität')}
                <select
                  id={`${ids}-wish-priority`}
                  className="input-field bg-slate-950 py-1.5 w-auto text-base sm:text-sm"
                  value={form.wish_priority}
                  onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, wish_priority: value })); }}
                >
                  {PRIORITY_OPTIONS.map(o => <option key={o.value} value={String(o.value)}>{t(o.label)}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* Cover Upload / URL */}
          <div>
            <label htmlFor={`${ids}-cover`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              {t('Cover-Bild (Datei hochladen oder URL)')}
            </label>
            <div className="flex flex-col sm:flex-row gap-3 items-center">
              <input
                id={`${ids}-cover`}
                type="text"
                placeholder={t('https://example.com/cover.jpg oder /uploads/...')}
                className="input-field flex-1 text-base sm:text-sm"
                value={form.cover_image}
                onChange={e => {
                  const value = e.target.value;
                  setForm(prev => ({ ...prev, cover_image: value }));
                  replacePreview(value);
                  setCoverFile(null);
                }}
              />
              <span className="text-xs text-slate-400">{t('oder')}</span>
              <FilePickerButton
                accept="image/*"
                onChange={handleCoverChange}
                label={t('Cover-Datei wählen')}
                className="btn-secondary text-xs flex items-center gap-2 cursor-pointer shrink-0 py-2.5"
              >
                <Upload className="w-4 h-4" /> {t('Datei wählen')}
              </FilePickerButton>
            </div>
            {coverPreview && (
              <div className="mt-2.5 flex items-center gap-3 p-2 bg-slate-950/80 rounded-xl border border-slate-800">
                <img {...assetImgProps(coverPreview)} alt={t('Cover-Vorschau')} className="w-10 h-14 object-cover rounded-lg" />
                <span className="text-xs text-slate-300 truncate">
                  {coverCaching && isRemoteUrl(coverPreview) ? t('Cover wird geladen…') : t('Vorschau aktiv')}
                </span>
              </div>
            )}
          </div>

          <div>
            <label htmlFor={`${ids}-description`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              {t('Beschreibung')}
            </label>
            <textarea
              id={`${ids}-description`}
              rows="3"
              placeholder={t('Kurze Inhaltsangabe...')}
              className="input-field resize-none text-base sm:text-sm"
              value={form.description}
              onChange={e => { const value = e.target.value; setForm(prev => ({ ...prev, description: value })); }}
            />
          </div>
          </fieldset>

          {scanVolume && (
            <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-xl p-3.5 space-y-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-emerald-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scanVolume.enabled}
                  onChange={e => { const checked = e.target.checked; setScanVolume(prev => ({ ...prev, enabled: checked })); }}
                />
                <ScanBarcode className="w-4 h-4" /> {t('Gescannten Band gleich anlegen')}
              </label>
              {scanVolume.enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={`${ids}-volume-number`} className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">{t('Bandnummer')} <span className="text-red-400">*</span></label>
                    <input
                      id={`${ids}-volume-number`}
                      type="text"
                      className="input-field"
                      placeholder={t('z.B. 1')}
                      maxLength={80}
                      value={scanVolume.volume_number}
                      onChange={e => { const value = e.target.value; setScanVolume(prev => ({ ...prev, volume_number: value })); }}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${ids}-volume-status`} className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">{t('Status')}</label>
                    <select
                      id={`${ids}-volume-status`}
                      className="input-field"
                      value={scanVolume.status}
                      onChange={e => { const value = e.target.value; setScanVolume(prev => ({ ...prev, status: value })); }}
                    >
                      <option value="Vorhanden">{t('Vorhanden')}</option>
                      <option value="Fehlt">{t('Fehlt (Einkaufsliste)')}</option>
                    </select>
                  </div>
                  <p className="col-span-2 text-[11px] text-slate-400">
                    {t('ISBN {details} werden mit übernommen.', {
                      details: `${scanVolume.isbn || '–'}${scanVolume.price ? ` · ${scanVolume.price} €` : ''}${scanVolume.pages ? ` · ${t('{pages} Seiten', { pages: scanVolume.pages })}` : ''}${scanVolume.release_year ? ` · ${scanVolume.release_year}` : ''}`
                    })}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              id="btn-close-add-modal"
              type="button"
              onClick={handleClose}
              className="btn-secondary text-sm"
              disabled={submitting}
            >
              {seriesLocked ? t('Schließen') : t('Abbrechen')}
            </button>
            {uploadingCover && (
              <button
                type="button"
                onClick={cancelCoverUpload}
                className="btn-secondary text-sm flex items-center gap-1.5 text-red-300 hover:text-red-200"
                title={t('Cover-Upload abbrechen')}
              >
                <X className="w-4 h-4" aria-hidden="true" /> {t('Upload abbrechen')}
              </button>
            )}
            <button
              type="submit"
              className="btn-primary text-sm flex items-center gap-2"
              disabled={submitting || applying}
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  {uploadingCover ? t('Cover wird hochgeladen…') : coverCaching ? t('Cover wird geladen…') : t('Wird angelegt...')}
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" /> {submitLabel}
                </>
              )}
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
