import { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Link } from 'react-router-dom';
import { 
  X, Camera, RefreshCw, CheckCircle2, ShoppingCart, 
  Plus, BookOpen, AlertCircle, Sparkles, Building2, 
  Coins, Hash, Calendar, ArrowRight, Check
} from 'lucide-react';

export default function IsbnScannerModal({ isOpen, onClose, onMangaCreated, onVolumeAdded, canEdit = true }) {
  const [activeTab, setActiveTab] = useState('camera'); // 'camera' | 'manual'
  const [manualIsbn, setManualIsbn] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [loadingLookup, setLoadingLookup] = useState(false);
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [processingAction, setProcessingAction] = useState(false);

  const scannerRef = useRef(null);
  const isStoppingRef = useRef(false);

  // Keyboard close on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Start or Stop camera scanner when modal opens/closes or tab changes
  useEffect(() => {
    if (isOpen && activeTab === 'camera' && !lookupResult) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, activeTab, lookupResult]);

  const startCamera = async () => {
    setCameraError('');
    if (scannerRef.current || isStoppingRef.current) return;

    try {
      const html5QrCode = new Html5Qrcode('isbn-scanner-viewport');
      scannerRef.current = html5QrCode;

      const config = {
        fps: 10,
        qrbox: { width: 280, height: 160 },
        aspectRatio: 1.777778
      };

      await html5QrCode.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => {
          // Barcode successfully decoded!
          handleBarcodeScanned(decodedText);
        },
        () => {
          // Frame decode error (normal while scanning)
        }
      );
      setIsScanning(true);
    } catch (err) {
      console.warn('Camera start error:', err);
      setIsScanning(false);
      setCameraError('Kamera konnte nicht gestartet werden. Bitte erlaube den Zugriff auf die Kamera oder gib die ISBN manuell ein.');
      setActiveTab('manual');
    }
  };

  const stopCamera = async () => {
    if (scannerRef.current && !isStoppingRef.current) {
      isStoppingRef.current = true;
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        await scannerRef.current.clear();
      } catch (err) {
        console.warn('Camera stop error:', err);
      } finally {
        scannerRef.current = null;
        isStoppingRef.current = false;
        setIsScanning(false);
      }
    }
  };

  const handleBarcodeScanned = async (code) => {
    // Only process standard EAN / ISBN length (10 or 13 digits)
    const clean = code.replace(/[^0-9X]/gi, '');
    if (clean.length === 10 || clean.length === 13) {
      // Temporarily stop camera to focus on result
      await stopCamera();
      fetchIsbnData(clean);
    }
  };

  const fetchIsbnData = async (isbnToLookup) => {
    const clean = String(isbnToLookup).replace(/[^0-9X]/gi, '');
    if (!clean) return;

    setLoadingLookup(true);
    setLookupError('');
    setLookupResult(null);
    setActionSuccess('');

    try {
      const res = await fetch(`/api/lookup/isbn?isbn=${encodeURIComponent(clean)}`);
      const data = await res.json();

      if (res.ok && data.found) {
        setLookupResult(data);
      } else {
        setLookupError(data.error || data.message || 'Kein Manga für diese ISBN in der Deutschen Nationalbibliothek gefunden.');
      }
    } catch (err) {
      setLookupError('Netzwerkfehler beim Abrufen der Buchdaten.');
    } finally {
      setLoadingLookup(false);
    }
  };

  const handleManualSubmit = (e) => {
    e.preventDefault();
    if (!manualIsbn.trim()) return;
    fetchIsbnData(manualIsbn.trim());
  };

  const handleNextScan = () => {
    setLookupResult(null);
    setLookupError('');
    setActionSuccess('');
    setManualIsbn('');
    if (activeTab === 'camera') {
      setTimeout(() => startCamera(), 100);
    }
  };

  const handleClose = async () => {
    await stopCamera();
    setLookupResult(null);
    setLookupError('');
    setActionSuccess('');
    setManualIsbn('');
    onClose();
  };

  // 1-Tap Action: Mark existing missing volume as bought
  const handleMarkAsBought = async (volumeId) => {
    if (!canEdit) return;
    setProcessingAction(true);
    try {
      const res = await fetch(`/api/volumes/${volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Vorhanden' })
      });
      if (res.ok) {
        setActionSuccess('Band erfolgreich als gekauft ins Regal gestellt!');
        if (lookupResult?.matched_volume) {
          setLookupResult(prev => ({
            ...prev,
            matched_volume: { ...prev.matched_volume, status: 'Vorhanden' }
          }));
        }
        if (onVolumeAdded) onVolumeAdded();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Aktualisieren');
      }
    } catch (e) {
      alert('Netzwerkfehler');
    } finally {
      setProcessingAction(false);
    }
  };

  // 1-Tap Action: Add new volume to existing manga
  const handleAddVolumeToManga = async (mangaId, status = 'Vorhanden') => {
    if (!canEdit || !lookupResult?.book) return;
    setProcessingAction(true);
    const book = lookupResult.book;
    try {
      const res = await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: mangaId,
          volume_number: book.volume_number || '1',
          isbn: lookupResult.isbn,
          price: book.price ? String(book.price) : null,
          release_year: book.release_year,
          pages: book.pages,
          publisher: book.publisher,
          status: status,
          cover_image: book.cover_url
        })
      });

      if (res.ok) {
        const data = await res.json();
        setActionSuccess(status === 'Vorhanden' 
          ? `Band ${book.volume_number} erfolgreich ins Regal gestellt!` 
          : `Band ${book.volume_number} auf deine Einkaufsliste gesetzt!`
        );
        setLookupResult(prev => ({
          ...prev,
          matched_volume: {
            id: data.id,
            volume_number: book.volume_number,
            status: status
          }
        }));
        if (onVolumeAdded) onVolumeAdded();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Hinzufügen des Bands');
      }
    } catch (e) {
      alert('Netzwerkfehler');
    } finally {
      setProcessingAction(false);
    }
  };

  // 1-Tap Action: Create brand new manga series and add volume 1
  const handleCreateNewMangaWithVolume = async () => {
    if (!canEdit || !lookupResult?.book) return;
    setProcessingAction(true);
    const book = lookupResult.book;

    try {
      // 1. Create Manga
      const mangaRes = await fetch('/api/mangas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: book.title,
          alt_title: book.subtitle || null,
          author: book.author || null,
          publisher: book.publisher || null,
          status: 'Laufend',
          cover_image: book.cover_url || null
        })
      });

      if (!mangaRes.ok) {
        const err = await mangaRes.json();
        throw new Error(err.error || 'Fehler beim Anlegen der Reihe');
      }

      const mangaData = await mangaRes.json();
      const newMangaId = mangaData.id;

      // 2. Add Scanned Volume
      await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: newMangaId,
          volume_number: book.volume_number || '1',
          isbn: lookupResult.isbn,
          price: book.price ? String(book.price) : null,
          release_year: book.release_year,
          pages: book.pages,
          publisher: book.publisher,
          status: 'Vorhanden',
          cover_image: book.cover_url
        })
      });

      setActionSuccess(`Reihe "${book.title}" und Band ${book.volume_number} erfolgreich angelegt!`);
      setLookupResult(prev => ({
        ...prev,
        matched_manga: { id: newMangaId, title: book.title, publisher: book.publisher },
        matched_volume: { volume_number: book.volume_number, status: 'Vorhanden' }
      }));
      if (onMangaCreated) onMangaCreated();
    } catch (err) {
      alert(err.message || 'Fehler beim Anlegen');
    } finally {
      setProcessingAction(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in">
      <div 
        className="glass-panel w-full max-w-lg rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-scale-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scanner-modal-title"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-500 flex items-center justify-center text-white shadow-md">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h2 id="scanner-modal-title" className="text-base font-bold text-white leading-tight">
                Manga Barcode & ISBN Scanner
              </h2>
              <p className="text-[11px] text-slate-400">
                Deutsche Nationalbibliothek & Verlagsabfrage
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher (only when not showing result) */}
        {!lookupResult && (
          <div className="flex border-b border-slate-800/80 bg-slate-900/30 p-1.5 gap-1.5">
            <button
              onClick={() => setActiveTab('camera')}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'camera'
                  ? 'bg-brand-600 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Kamera-Scan</span>
            </button>
            <button
              onClick={() => setActiveTab('manual')}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'manual'
                  ? 'bg-brand-600 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              <Hash className="w-3.5 h-3.5" />
              <span>ISBN eingeben</span>
            </button>
          </div>
        )}

        {/* Content Area */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4">
          {/* CAMERA SCANNER TAB */}
          {!lookupResult && activeTab === 'camera' && (
            <div className="space-y-3">
              <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 aspect-[4/3] flex items-center justify-center">
                {/* Viewport for Html5Qrcode */}
                <div id="isbn-scanner-viewport" className="w-full h-full" />

                {/* Laser animation overlay */}
                {isScanning && (
                  <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                    <div className="w-64 h-36 border-2 border-brand-400/70 rounded-xl relative shadow-[0_0_15px_rgba(99,102,241,0.3)]">
                      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-brand-400 to-transparent animate-pulse" />
                    </div>
                    <span className="text-[10px] text-slate-300 mt-2 bg-slate-900/80 px-2 py-0.5 rounded-full font-medium">
                      Barcode im Rahmen zentrieren
                    </span>
                  </div>
                )}
              </div>

              {cameraError && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex gap-2 items-start">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{cameraError}</p>
                </div>
              )}

              <p className="text-[11px] text-slate-400 text-center">
                Halte den Barcode auf der Manga-Rückseite vor deine Kamera.
              </p>
            </div>
          )}

          {/* MANUAL ISBN TAB */}
          {!lookupResult && activeTab === 'manual' && (
            <form onSubmit={handleManualSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  ISBN oder EAN-13 Barcode
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="z. B. 978-3-551-74581-1"
                    value={manualIsbn}
                    onChange={(e) => setManualIsbn(e.target.value)}
                    className="flex-1 input-field font-mono text-sm py-2 px-3"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!manualIsbn.trim() || loadingLookup}
                    className="btn-primary px-4 py-2 text-xs font-semibold shrink-0"
                  >
                    {loadingLookup ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      'Suchen'
                    )}
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Tipp: Funktioniert mit allen deutschen Verlagen (Carlsen, Egmont, Tokyopop, Altraverse, Manga Cult, Hayabusa, Kazé/Crunchyroll). Bindestriche werden automatisch bereinigt.
              </p>
            </form>
          )}

          {/* LOADING STATE */}
          {loadingLookup && (
            <div className="py-12 flex flex-col items-center justify-center text-center gap-3">
              <RefreshCw className="w-8 h-8 text-brand-400 animate-spin" />
              <div>
                <p className="text-sm font-semibold text-white">Deutsche Nationalbibliothek wird abgefragt...</p>
                <p className="text-xs text-slate-400 mt-0.5">Prüfe Bandnummer, Preis, Verlag und Bestand</p>
              </div>
            </div>
          )}

          {/* LOOKUP ERROR */}
          {lookupError && !loadingLookup && (
            <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 space-y-3 text-center">
              <div className="w-10 h-10 rounded-full bg-rose-500/20 flex items-center justify-center mx-auto text-rose-400">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-white">Nicht gefunden</h4>
                <p className="text-xs text-rose-300/90 mt-1">{lookupError}</p>
              </div>
              <button
                type="button"
                onClick={handleNextScan}
                className="btn-secondary text-xs px-4 py-1.5 mx-auto"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          {/* RESULT CARD & INVENTORY MATCHING */}
          {lookupResult && lookupResult.book && (
            <div className="space-y-4 animate-fade-in">
              {/* SUCCESS NOTIFICATION */}
              {actionSuccess && (
                <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 font-medium">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>{actionSuccess}</span>
                </div>
              )}

              {/* BOOK CARD */}
              <div className="glass-card rounded-2xl p-3.5 border border-slate-700/80 bg-slate-900/80 flex gap-3.5 relative">
                {/* Cover Thumbnail */}
                <div className="w-20 h-28 bg-slate-800 rounded-xl overflow-hidden shrink-0 border border-slate-700 flex items-center justify-center relative shadow-md">
                  {lookupResult.book.cover_url ? (
                    <img 
                      src={lookupResult.book.cover_url} 
                      alt={lookupResult.book.title}
                      className="w-full h-full object-cover"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <BookOpen className="w-8 h-8 text-slate-500" />
                  )}
                  <span className="absolute bottom-1 right-1 bg-brand-600 text-white font-mono text-[10px] font-bold px-1.5 py-0.5 rounded shadow">
                    #{lookupResult.book.volume_number}
                  </span>
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                  <div>
                    <h3 className="text-sm font-bold text-white truncate" title={lookupResult.book.title}>
                      {lookupResult.book.title}
                    </h3>
                    {lookupResult.book.subtitle && (
                      <p className="text-xs text-slate-400 truncate mt-0.5">
                        {lookupResult.book.subtitle}
                      </p>
                    )}
                    {lookupResult.book.author && (
                      <p className="text-[11px] text-slate-400 mt-1 truncate">
                        von {lookupResult.book.author}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[11px] font-bold px-2 py-0.5 rounded-lg font-mono">
                        Band {lookupResult.book.volume_number}
                      </span>
                      {lookupResult.book.price > 0 && (
                        <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono px-2 py-0.5 rounded-lg font-bold">
                          {lookupResult.book.price.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                        </span>
                      )}
                      {lookupResult.book.pages && (
                        <span className="bg-slate-800 text-slate-300 border border-slate-700 text-[10px] px-2 py-0.5 rounded-lg font-mono">
                          {lookupResult.book.pages} S.
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-[10px] text-slate-400 mt-2 flex items-center justify-between border-t border-slate-800/80 pt-1.5">
                    <span className="truncate flex items-center gap-1">
                      <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                      {lookupResult.book.publisher || 'Unbekannt'}
                    </span>
                    <span className="font-mono text-slate-500 shrink-0">
                      ISBN: {lookupResult.isbn}
                    </span>
                  </div>
                </div>
              </div>

              {/* INVENTORY INTELLIGENCE BANNER & ACTIONS */}
              <div className="rounded-2xl p-4 border space-y-3 transition-all">
                {/* CASE A: Volume already owned */}
                {lookupResult.matched_volume && lookupResult.matched_volume.status === 'Vorhanden' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Bereits in deinem Regal!</span>
                    </div>
                    <p className="text-xs text-slate-300">
                      Du besitzt Band {lookupResult.book.volume_number} bereits in deiner Sammlung. Kein Doppelkauf nötig!
                    </p>
                    {lookupResult.matched_manga && (
                      <Link
                        to={`/manga/${lookupResult.matched_manga.id}`}
                        onClick={handleClose}
                        className="inline-flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 font-semibold mt-1"
                      >
                        <span>Zu {lookupResult.matched_manga.title} wechseln</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    )}
                  </div>
                )}

                {/* CASE B: Volume is on shopping / wishlist */}
                {lookupResult.matched_volume && lookupResult.matched_volume.status === 'Fehlt' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
                      <ShoppingCart className="w-4 h-4" />
                      <span>Auf deiner Einkaufsliste!</span>
                    </div>
                    <p className="text-xs text-slate-300">
                      Dieser Band fehlt dir noch und ist in deiner Wunschliste vorgemerkt.
                    </p>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleMarkAsBought(lookupResult.matched_volume.id)}
                        disabled={processingAction}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-2 shadow-md transition-all active:scale-95"
                      >
                        {processingAction ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-4 h-4" />
                        )}
                        <span>Jetzt gekauft – Ins Regal stellen</span>
                      </button>
                    )}
                  </div>
                )}

                {/* CASE C: Manga exists, but this Volume is not yet added */}
                {lookupResult.matched_manga && !lookupResult.matched_volume && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sky-400 font-bold text-xs">
                      <Sparkles className="w-4 h-4" />
                      <span>Reihe vorhanden ({lookupResult.matched_manga.title})</span>
                    </div>
                    <p className="text-xs text-slate-300">
                      Du sammelst diese Reihe bereits, aber Band {lookupResult.book.volume_number} ist noch nicht eingetragen.
                    </p>
                    {canEdit && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handleAddVolumeToManga(lookupResult.matched_manga.id, 'Vorhanden')}
                          disabled={processingAction}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition-all active:scale-95"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Ins Regal (+ Besitz)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAddVolumeToManga(lookupResult.matched_manga.id, 'Fehlt')}
                          disabled={processingAction}
                          className="bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 border border-amber-500/40 font-semibold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all active:scale-95"
                        >
                          <ShoppingCart className="w-3.5 h-3.5" />
                          <span>Auf Einkaufsliste</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* CASE D: Brand new Manga Series */}
                {!lookupResult.matched_manga && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-indigo-400 font-bold text-xs">
                      <Plus className="w-4 h-4" />
                      <span>Neue Manga-Reihe!</span>
                    </div>
                    <p className="text-xs text-slate-300">
                      Diese Reihe befindet sich noch nicht in deiner Sammlung. Du kannst sie jetzt mit Band {lookupResult.book.volume_number} direkt anlegen.
                    </p>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={handleCreateNewMangaWithVolume}
                        disabled={processingAction}
                        className="w-full bg-brand-600 hover:bg-brand-500 text-white font-semibold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-2 shadow-md transition-all active:scale-95"
                      >
                        {processingAction ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                        <span>Reihe anlegen & Band {lookupResult.book.volume_number} ins Regal</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* ACTION FOOTER */}
              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={handleNextScan}
                  className="flex-1 btn-secondary text-xs py-2 flex items-center justify-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>Nächsten Manga scannen</span>
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="btn-secondary text-xs py-2 px-4"
                >
                  Fertig
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
