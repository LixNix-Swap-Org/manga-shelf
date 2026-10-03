import { useState, useEffect } from 'react';
import { Plus, X, Sparkles, RefreshCw, AlertTriangle, BookOpen, Upload, ScanBarcode } from 'lucide-react';
import { buildScanVolumePayload, prefillTotalVolumes } from '../../utils/scanHelpers';
import useDialogA11y from '../../hooks/useDialogA11y';

// prefill: { form, volume } from an ISBN scan (utils/scanHelpers.js buildScanPrefill); also creates the scanned volume
export default function AddMangaModal({ isOpen, onClose, onSuccess, prefill = null }) {
  const [form, setForm] = useState({
    title: '',
    alt_title: '',
    author: '',
    publisher: '',
    status: 'Laufend',
    total_volumes: '',
    description: '',
    cover_image: '',
    manga_passion_id: null
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [coverFile, setCoverFile] = useState(null);
  const [coverPreview, setCoverPreview] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResults, setLookupResults] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [failedImages, setFailedImages] = useState({});
  const [scanVolume, setScanVolume] = useState(null);
  const [createdMangaId, setCreatedMangaId] = useState(null); // manga exists but the scanned volume failed: retry only the volume

  useEffect(() => {
    if (isOpen) {
      setForm({
        title: '',
        alt_title: '',
        author: '',
        publisher: '',
        status: 'Laufend',
        total_volumes: '',
        description: '',
        cover_image: '',
        manga_passion_id: null,
        ...(prefill?.form || {})
      });
      setScanVolume(prefill?.volume || null);
      setCreatedMangaId(null);
      setErrorMessage('');
      setCoverFile(null);
      setCoverPreview(prefill?.form?.cover_image || '');
      setLookupResults(null);
      setLookupError('');

      // Catalogue cover (Open Library): cache it locally; if there is none, drop it instead of saving a dead link
      const remoteCover = prefill?.form?.cover_image;
      if (remoteCover && remoteCover.startsWith('http')) {
        let cancelled = false;
        (async () => {
          let local = '';
          try {
            const upRes = await fetch('/api/upload-remote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: remoteCover })
            });
            if (upRes.ok) local = (await upRes.json()).url || '';
          } catch (e) {
            console.warn('Could not cache scanned cover:', e);
          }
          if (cancelled) return;
          setForm(prev => (prev.cover_image === remoteCover ? { ...prev, cover_image: local } : prev));
          setCoverPreview(prev => (prev === remoteCover ? local : prev));
        })();
        return () => { cancelled = true; };
      }
    }
  }, [isOpen]);

  const handleClose = () => {
    if (coverPreview && coverPreview.startsWith('blob:')) {
      URL.revokeObjectURL(coverPreview);
    }
    setCoverFile(null);
    setCoverPreview('');
    setLookupResults(null);
    setLookupError('');
    setScanVolume(null);
    setCreatedMangaId(null);
    onClose();
  };

  const handleLookupMetadata = async () => {
    if (!form.title.trim()) {
      setLookupError('Bitte gib zuerst einen Titel ein.');
      return;
    }
    setLookingUp(true);
    setLookupError('');
    setLookupResults(null);
    try {
      const res = await fetch(`/api/lookup/manga?q=${encodeURIComponent(form.title.trim())}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          if (data.length === 1) {
            await applyLookupResult(data[0]);
          } else {
            setLookupResults(data);
          }
        } else {
          setLookupError('Keine Treffer gefunden.');
        }
      } else {
        const err = await res.json();
        setLookupError(err.error || 'Fehler bei der Suche');
      }
    } catch (e) {
      setLookupError('Netzwerkfehler bei der Metadatensuche');
    } finally {
      setLookingUp(false);
    }
  };

  const applyLookupResult = async (item) => {
    let localCoverUrl = item.cover_image;
    if (item.cover_image && item.cover_image.startsWith('http')) {
      try {
        const upRes = await fetch('/api/upload-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.cover_image })
        });
        if (upRes.ok) {
          const upData = await upRes.json();
          if (upData.url) localCoverUrl = upData.url;
        }
      } catch (e) {
        console.warn('Could not cache remote cover locally, using remote URL:', e);
      }
    }

    setForm(prev => ({
      ...prev,
      title: item.title || prev.title,
      alt_title: item.alt_title || prev.alt_title,
      author: item.author || prev.author,
      publisher: item.publisher || prev.publisher,
      status: item.status || prev.status,
      total_volumes: prefillTotalVolumes(item, prev.total_volumes),
      description: item.description || prev.description,
      cover_image: localCoverUrl || prev.cover_image,
      manga_passion_id: item.manga_passion_id || null
    }));
    if (localCoverUrl) {
      if (coverPreview && coverPreview.startsWith('blob:')) {
        URL.revokeObjectURL(coverPreview);
      }
      setCoverFile(null);
      setCoverPreview(localCoverUrl);
    }
    setLookupResults(null);
    setLookupError('');
  };

  const handleCoverChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (coverPreview && coverPreview.startsWith('blob:')) {
        URL.revokeObjectURL(coverPreview);
      }
      setCoverFile(file);
      setCoverPreview(URL.createObjectURL(file));
    }
  };

  const handleCreateManga = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setErrorMessage('Bitte gib einen Titel ein.');
      return;
    }
    const withVolume = Boolean(scanVolume?.enabled);
    if (withVolume && !String(scanVolume.volume_number).trim()) {
      setErrorMessage('Bitte gib die Bandnummer des gescannten Buchs ein (oder deaktiviere „Gescannten Band anlegen“).');
      return;
    }

    setSubmitting(true);
    setErrorMessage('');

    try {
      let mangaId = createdMangaId;
      let data = { id: createdMangaId };
      if (!mangaId) {
      let finalCover = form.cover_image.trim();

      if (coverFile) {
        const fd = new FormData();
        fd.append('image', coverFile);
        const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
        if (upRes.ok) {
          const upData = await upRes.json();
          finalCover = upData.url;
        } else {
          const errData = await upRes.json();
          throw new Error(errData.error || 'Fehler beim Cover-Upload');
        }
      }

      const res = await fetch('/api/mangas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          alt_title: form.alt_title.trim() || null,
          author: form.author.trim() || null,
          publisher: form.publisher.trim() || null,
          status: form.status,
          total_volumes: form.total_volumes ? parseInt(form.total_volumes, 10) : null,
          description: form.description.trim() || null,
          cover_image: finalCover || null,
          manga_passion_id: form.manga_passion_id || null
        })
      });

      data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Fehler beim Erstellen des Mangas');
      }
      mangaId = data.id;
      }

      if (withVolume) {
        const volRes = await fetch('/api/volumes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildScanVolumePayload(mangaId, scanVolume))
        });
        if (!volRes.ok) {
          const volErr = await volRes.json().catch(() => ({}));
          setCreatedMangaId(mangaId);
          throw new Error(`Die Reihe wurde angelegt, der Band aber nicht: ${volErr.error || 'Fehler beim Anlegen des Bands'}. Mit „Band anlegen“ erneut versuchen.`);
        }
      }

      handleClose();
      if (onSuccess) onSuccess(data);
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  return (
    <div 
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Neuen Manga anlegen"
      tabIndex={-1}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in"
    >
      <div className="glass-panel w-full max-w-xl rounded-2xl sm:rounded-3xl p-5 sm:p-8 border border-slate-700/80 shadow-2xl my-3 sm:my-8 relative">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-500/20 border border-brand-500/40 text-brand-400 flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Neuen Manga anlegen</h2>
              <p className="text-xs text-slate-400">Erfasse eine neue Reihe in deiner Sammlung</p>
            </div>
          </div>
          <button 
            id="btn-close-add-modal-x"
            onClick={handleClose}
            aria-label="Schließen"
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Banner */}
        {errorMessage && (
          <div className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleCreateManga} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex justify-between items-center">
              <span>Titel <span className="text-red-400">*</span></span>
              <span className="text-[11px] text-brand-400 font-normal">Tipp: Titel eingeben & auf „Auto-Fill“ klicken</span>
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input 
                type="text" 
                placeholder="z.B. One Piece, Chainsaw Man, Frieren..." 
                className="input-field flex-1" 
                required
                autoFocus
                value={form.title} 
                onChange={e => setForm({ ...form, title: e.target.value })} 
              />
              <button
                type="button"
                onClick={handleLookupMetadata}
                disabled={lookingUp || !form.title.trim()}
                className="btn-secondary text-xs flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 bg-gradient-to-r hover:from-emerald-600/30 hover:to-sky-600/30 border-brand-500/40 text-brand-300 hover:text-white"
                title="Sucht offizielle deutsche Ausgaben über Manga Passion (mit AniList-Fallback)"
              >
                {lookingUp ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Suche...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                    <span>Auto-Fill</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Lookup Error Banner */}
          {lookupError && (
            <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
              <span>{lookupError}</span>
            </div>
          )}

          {/* Lookup Results Selector */}
          {lookupResults && lookupResults.length > 0 && (
            <div className="bg-slate-950/95 border border-brand-500/40 rounded-xl p-3 space-y-2.5 shadow-xl">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-brand-400 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Treffer auswählen (Manga Passion zuerst):
                </span>
                <button 
                  type="button" 
                  onClick={() => setLookupResults(null)}
                  className="text-slate-400 hover:text-white text-[11px]"
                >
                  Schließen
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                {lookupResults.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => applyLookupResult(item)}
                    className={`flex items-center gap-2.5 p-2 rounded-lg border text-left transition-all group ${
                      item.source === 'manga_passion'
                        ? 'bg-gradient-to-r from-emerald-950/30 to-slate-900/90 border-emerald-500/40 hover:border-emerald-400 hover:from-emerald-950/50'
                        : 'bg-slate-900/80 hover:bg-brand-950/60 border-slate-800 hover:border-brand-500/50'
                    }`}
                  >
                    {item.cover_image && !failedImages[`lookup-${item.id || item.title}`] ? (
                      <img 
                        src={item.cover_image} 
                        alt={item.title} 
                        onError={() => setFailedImages(prev => ({ ...prev, [`lookup-${item.id || item.title}`]: true }))}
                        className="w-10 h-14 object-cover rounded shadow shrink-0" 
                      />
                    ) : (
                      <div className="w-10 h-14 bg-slate-800 rounded shrink-0 flex items-center justify-center text-slate-500">
                        <BookOpen className="w-5 h-5" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {item.source === 'manga_passion' ? (
                          <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1 py-0.2 rounded text-[9px] font-bold shrink-0">
                            🇩🇪 Manga Passion
                          </span>
                        ) : (
                          <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-0.2 rounded text-[9px] font-medium shrink-0">
                            🌐 AniList
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-semibold text-white truncate group-hover:text-brand-300">
                        {item.title}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {item.author || item.alt_title || 'Unbekannt'}
                      </p>
                      <div className="flex flex-wrap gap-1 mt-1 text-[10px]">
                        {item.publisher && (
                          <span className="bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-medium truncate max-w-[120px]">
                            {item.publisher}
                          </span>
                        )}
                        {item.total_volumes && (
                          <span className="bg-slate-800 text-slate-200 border border-slate-700/80 px-1.5 py-0.5 rounded font-bold">
                            {item.total_volumes} Bände
                          </span>
                        )}
                        <span className="bg-slate-800/80 px-1.5 py-0.5 rounded text-slate-400">
                          {item.status}
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
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Autor / Mangaka
              </label>
              <input 
                type="text" 
                placeholder="z.B. Eiichiro Oda" 
                className="input-field" 
                value={form.author} 
                onChange={e => setForm({ ...form, author: e.target.value })} 
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Verlag
              </label>
              <input 
                type="text" 
                placeholder="z.B. Carlsen Manga, Tokyopop..." 
                className="input-field" 
                value={form.publisher} 
                onChange={e => setForm({ ...form, publisher: e.target.value })} 
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Status
              </label>
              <select 
                className="input-field bg-slate-950"
                value={form.status} 
                onChange={e => setForm({ ...form, status: e.target.value })}
              >
                <option value="Laufend">Laufend</option>
                <option value="Abgeschlossen">Abgeschlossen</option>
                <option value="Pausiert">Pausiert</option>
                <option value="Geplant">Geplant</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Geplante / Gesamtbände
              </label>
              <input 
                type="number" 
                min="1"
                placeholder="z.B. 108" 
                className="input-field" 
                value={form.total_volumes} 
                onChange={e => setForm({ ...form, total_volumes: e.target.value })} 
              />
            </div>
          </div>

          {/* Cover Upload / URL */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Cover-Bild (Datei hochladen oder URL)
            </label>
            <div className="flex flex-col sm:flex-row gap-3 items-center">
              <input 
                type="text" 
                placeholder="https://example.com/cover.jpg oder /uploads/..." 
                className="input-field flex-1 text-sm"
                value={form.cover_image} 
                onChange={e => {
                  setForm({ ...form, cover_image: e.target.value });
                  setCoverPreview(e.target.value);
                  setCoverFile(null);
                }} 
              />
              <span className="text-xs text-slate-500">oder</span>
              <label className="btn-secondary text-xs flex items-center gap-2 cursor-pointer shrink-0 py-2.5">
                <Upload className="w-4 h-4" /> Datei wählen
                <input 
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  onChange={handleCoverChange} 
                />
              </label>
            </div>
            {coverPreview && (
              <div className="mt-2.5 flex items-center gap-3 p-2 bg-slate-950/80 rounded-xl border border-slate-800">
                <img src={coverPreview} alt="Preview" className="w-10 h-14 object-cover rounded-lg" />
                <span className="text-xs text-slate-300 truncate">Vorschau aktiv</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Beschreibung
            </label>
            <textarea 
              rows="3" 
              placeholder="Kurze Inhaltsangabe..." 
              className="input-field resize-none text-sm" 
              value={form.description} 
              onChange={e => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {scanVolume && (
            <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-xl p-3.5 space-y-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-emerald-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scanVolume.enabled}
                  onChange={e => setScanVolume({ ...scanVolume, enabled: e.target.checked })}
                />
                <ScanBarcode className="w-4 h-4" /> Gescannten Band gleich anlegen
              </label>
              {scanVolume.enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Bandnummer <span className="text-red-400">*</span></label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="z.B. 1"
                      value={scanVolume.volume_number}
                      onChange={e => setScanVolume({ ...scanVolume, volume_number: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Status</label>
                    <select
                      className="input-field"
                      value={scanVolume.status}
                      onChange={e => setScanVolume({ ...scanVolume, status: e.target.value })}
                    >
                      <option value="Vorhanden">Vorhanden</option>
                      <option value="Fehlt">Fehlt (Einkaufsliste)</option>
                    </select>
                  </div>
                  <p className="col-span-2 text-[11px] text-slate-400">
                    ISBN {scanVolume.isbn || '–'}{scanVolume.price ? ` · ${scanVolume.price} €` : ''}{scanVolume.pages ? ` · ${scanVolume.pages} Seiten` : ''}{scanVolume.release_year ? ` · ${scanVolume.release_year}` : ''} werden mit übernommen.
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
              Abbrechen
            </button>
            <button 
              type="submit" 
              className="btn-primary text-sm flex items-center gap-2"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Wird angelegt...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" /> {createdMangaId ? 'Band anlegen' : 'Manga anlegen'}
                </>
              )}
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
