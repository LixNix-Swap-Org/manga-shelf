import { useState, useEffect } from 'react';
import BarcodeScannerButton from '../common/BarcodeScannerButton';
import { inferVolumeType } from '../../utils/volumeHelpers';
import { 
  Package, Sparkles, Layers, X, RefreshCw, CheckCircle2, AlertTriangle,
  Upload, Link as LinkIcon, Camera, Star, ArrowLeft, ArrowRight,
  Trash2, Save, Calendar, Coins, Bookmark, Tag, Hash, Check, Truck, Plus, Building2, FileText
} from 'lucide-react';
import VolumePhotoManager from './VolumePhotoManager';

export default function VolumeEditModal({
  isOpen,
  activeVolume,
  onClose,
  manga,
  mangaId,
  canEdit,
  onSuccess,
  onPreviewImage
}) {
  const [editVolForm, setEditVolForm] = useState({});
  const [savingVol, setSavingVol] = useState(false);
  const [uploadingVolImage, setUploadingVolImage] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [manualImageUrl, setManualImageUrl] = useState('');
  const [autofillingVolume, setAutofillingVolume] = useState(false);
  const [autofillMessage, setAutofillMessage] = useState(null);

  useEffect(() => {
    if (activeVolume) {
      const vol = activeVolume;
      const rawImages = Array.isArray(vol.images) ? vol.images : (vol.cover_image ? [vol.cover_image] : []);
      const volImages = [];
      if (vol.cover_image) volImages.push(vol.cover_image);
      rawImages.forEach(img => {
        if (img && !volImages.includes(img)) volImages.push(img);
      });
      const detectedType = inferVolumeType(vol);
      setEditVolForm({
        type: detectedType,
        volume_number: vol.volume_number || '',
        status: vol.status || 'Vorhanden',
        price: vol.price !== null && vol.price !== undefined ? String(vol.price) : '',
        publisher: vol.publisher || '',
        condition: vol.condition || '',
        release_date: vol.release_date || '',
        release_year: vol.release_year ? String(vol.release_year) : '',
        pages: vol.pages ? String(vol.pages) : '',
        isbn: vol.isbn || '',
        purchase_date: vol.purchase_date || '',
        notes: vol.notes || '',
        cover_image: vol.cover_image || (volImages.length > 0 ? volImages[0] : ''),
        images: volImages
      });
      setShowUrlInput(false);
      setManualImageUrl('');
      setAutofillMessage(null);
      setAutofillingVolume(false);
    }
  }, [activeVolume]);

  if (!isOpen || !activeVolume) return null;

  const handleUploadVolumeImages = async (files) => {
    if (!canEdit || !files || files.length === 0) return;
    setUploadingVolImage(true);
    try {
      const fd = new FormData();
      if (files.length === 1) {
        fd.append('image', files[0]);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          const currentImages = editVolForm.images || [];
          const newImages = [...currentImages, data.url];
          setEditVolForm(prev => ({
            ...prev,
            images: newImages,
            cover_image: prev.cover_image || data.url
          }));
        } else {
          const err = await res.json();
          alert(err.error || 'Fehler beim Hochladen des Bildes');
        }
      } else {
        for (let i = 0; i < files.length; i++) {
          fd.append('images', files[i]);
        }
        const res = await fetch('/api/upload/multiple', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          const currentImages = editVolForm.images || [];
          const newImages = [...currentImages, ...(data.urls || [])];
          setEditVolForm(prev => ({
            ...prev,
            images: newImages,
            cover_image: prev.cover_image || (data.urls && data.urls[0]) || ''
          }));
        } else {
          const err = await res.json();
          alert(err.error || 'Fehler beim Hochladen der Bilder');
        }
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler beim Bild-Upload');
    } finally {
      setUploadingVolImage(false);
    }
  };

  const handleAddImageUrl = async () => {
    if (!canEdit || !manualImageUrl.trim()) return;
    const url = manualImageUrl.trim();

    const mpMatch = url.match(/manga-passion\.de\/volumes\/(\d+)/i) || url.match(/^#?(\d{4,8})$/);
    if (mpMatch) {
      setShowUrlInput(false);
      setManualImageUrl('');
      await handleAutofillVolumeData({ url, mp_volume_id: mpMatch[1], force_cover: true });
      return;
    }

    try {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const upRes = await fetch('/api/upload-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        if (upRes.ok) {
          const upData = await upRes.json();
          if (upData.url) {
            const currentImages = editVolForm.images || [];
            setEditVolForm(prev => ({
              ...prev,
              images: [upData.url, ...currentImages.filter(u => u !== upData.url)],
              cover_image: upData.url
            }));
            setManualImageUrl('');
            setShowUrlInput(false);
            return;
          }
        }
      }
    } catch (_) {}

    const currentImages = editVolForm.images || [];
    setEditVolForm(prev => ({
      ...prev,
      images: [...currentImages, url],
      cover_image: prev.cover_image || url
    }));
    setManualImageUrl('');
    setShowUrlInput(false);
  };

  const handleMoveVolumeImage = (fromIdx, toIdx) => {
    if (!canEdit || !editVolForm.images) return;
    const imgs = [...editVolForm.images];
    if (toIdx < 0 || toIdx >= imgs.length) return;
    const [moved] = imgs.splice(fromIdx, 1);
    imgs.splice(toIdx, 0, moved);
    setEditVolForm(prev => ({
      ...prev,
      images: imgs
    }));
  };

  const handleRemoveVolumeImage = (imgUrl) => {
    if (!canEdit) return;
    const nextImages = (editVolForm.images || []).filter(u => u !== imgUrl);
    let nextCover = editVolForm.cover_image;
    if (nextCover === imgUrl) {
      nextCover = nextImages.length > 0 ? nextImages[0] : '';
    }
    setEditVolForm(prev => ({
      ...prev,
      images: nextImages,
      cover_image: nextCover
    }));
  };

  const handleSetVolumeCover = (imgUrl) => {
    if (!canEdit) return;
    setEditVolForm(prev => ({
      ...prev,
      cover_image: imgUrl
    }));
  };

  const handleAutofillVolumeData = async (extraOpts = {}) => {
    const targetUrl = extraOpts.url || (manualImageUrl && manualImageUrl.includes('manga-passion.de') ? manualImageUrl.trim() : '');
    const mpVolId = extraOpts.mp_volume_id || '';
    if (!editVolForm.volume_number && !editVolForm.isbn && !targetUrl && !mpVolId) {
      setAutofillMessage({ type: 'warning', text: 'Bitte gib zuerst eine Band-Nummer, ISBN oder Manga Passion URL ein.' });
      return;
    }
    setAutofillingVolume(true);
    setAutofillMessage(null);
    try {
      const qNum = encodeURIComponent(editVolForm.volume_number || '');
      const qIsbn = encodeURIComponent(editVolForm.isbn || '');
      const qType = encodeURIComponent(editVolForm.type || '');
      const qNotes = encodeURIComponent(editVolForm.notes || '');
      const qPrice = encodeURIComponent(editVolForm.price || '');
      const qUrl = encodeURIComponent(targetUrl || '');
      const qMpId = encodeURIComponent(mpVolId || '');

      const res = await fetch(`/api/volumes/lookup?manga_id=${mangaId}&volume_number=${qNum}&isbn=${qIsbn}&type=${qType}&notes=${qNotes}&price=${qPrice}&url=${qUrl}&mp_volume_id=${qMpId}`);
      const result = await res.json();

      if (res.ok && result.success && result.data) {
        const d = result.data;
        const updatedFields = [];

        setEditVolForm(prev => {
          const next = { ...prev };
          const isSchuber = prev.type === 'schuber' || String(prev.volume_number || '').toLowerCase().includes('schuber');

          if (d.volume_number && isSchuber && !prev.volume_number.toLowerCase().includes('schuber')) {
            next.volume_number = d.volume_number;
          }
          if (d.release_date) {
            next.release_date = d.release_date;
            updatedFields.push(`Erscheinungsdatum (${d.release_date})`);
          }
          if (d.release_year) {
            next.release_year = String(d.release_year);
            updatedFields.push(`Jahr (${d.release_year})`);
          }
          if (d.pages !== undefined && d.pages !== null) {
            next.pages = String(d.pages);
            updatedFields.push(`Seitenzahl (${d.pages})`);
          } else if (isSchuber) {
            next.pages = '';
          }
          if (d.isbn) {
            next.isbn = d.isbn;
            updatedFields.push('ISBN');
          } else if (isSchuber) {
            next.isbn = '';
          }
          if (d.price && (!prev.price || prev.price === '0' || prev.price === '0,00' || prev.price === '0.00' || isSchuber)) {
            next.price = String(d.price);
            updatedFields.push(`Kaufpreis (${d.price} €)`);
          }
          if (d.publisher) {
            next.publisher = d.publisher;
            updatedFields.push('Verlag');
          }
          if (d.notes && (!prev.notes || isSchuber || prev.notes === 'Das Abenteuer beginnt')) {
            next.notes = d.notes;
            updatedFields.push(`Titel (${d.notes})`);
          }
          if (d.cover_image) {
            const shouldUpdateCover = isSchuber || !prev.cover_image || extraOpts.force_cover || prev.cover_image.includes('1790518007122');
            if (shouldUpdateCover || prev.cover_image !== d.cover_image) {
              const oldCover = prev.cover_image;
              next.cover_image = d.cover_image;
              const otherImages = (prev.images || []).filter(u => u !== oldCover && u !== d.cover_image);
              next.images = Array.from(new Set([d.cover_image, ...otherImages]));
              updatedFields.push('Cover-Bild');
            }
          }
          return next;
        });

        if (updatedFields.length > 0) {
          setAutofillMessage({
            type: 'success',
            text: `Erfolgreich von ${result.data.source || 'Manga Passion'} ausgefüllt: ${updatedFields.join(', ')}!`
          });
        } else {
          setAutofillMessage({
            type: 'info',
            text: `Alle Daten von ${result.data.source || 'Manga Passion'} stimmen bereits mit deinen Eingaben überein.`
          });
        }
      } else {
        setAutofillMessage({
          type: 'warning',
          text: result.message || `Keine Daten für "${editVolForm.volume_number || targetUrl}" auf Manga Passion gefunden.`
        });
      }
    } catch (err) {
      setAutofillMessage({ type: 'warning', text: 'Fehler beim Abrufen der Metadaten.' });
    } finally {
      setAutofillingVolume(false);
    }
  };

  const handleSaveVolume = async (e) => {
    e.preventDefault();
    if (!canEdit || !activeVolume) return;
    setSavingVol(true);
    try {
      const res = await fetch(`/api/volumes/${activeVolume.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editVolForm)
      });
      if (res.ok) {
        onClose();
        if (onSuccess) await onSuccess();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Speichern des Bands');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setSavingVol(false);
    }
  };

  const handleDeleteVolume = async (e, volId) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    if (!confirm('Band wirklich entfernen?')) return;
    try {
      const res = await fetch(`/api/volumes/${volId}`, { method: 'DELETE' });
      if (res.ok) {
        onClose();
        if (onSuccess) await onSuccess();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (!isOpen || !activeVolume) return null;

  return (
        <div 
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 animate-fade-in overflow-hidden"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div 
            className="glass-panel w-full max-w-lg max-h-[92vh] flex flex-col rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl relative overflow-hidden my-auto" 
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header (Fixed at top) */}
            <div className="shrink-0 bg-slate-900/95 backdrop-blur-md px-4 py-3.5 sm:px-6 sm:py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="min-w-0 flex-1 pr-2">
                <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2 truncate">
                  {editVolForm.type === 'schuber' ? <Package className="w-5 h-5 text-indigo-400 shrink-0" /> :
                   editVolForm.type === 'special_edition' ? <Sparkles className="w-5 h-5 text-fuchsia-400 shrink-0" /> :
                   editVolForm.type === 'special' ? <Sparkles className="w-5 h-5 text-amber-400 shrink-0" /> :
                   <Layers className="w-5 h-5 text-brand-400 shrink-0" />}
                  <span className="truncate">
                    {editVolForm.type === 'schuber' ? 'Schuber ' : 
                     editVolForm.type === 'special_edition' ? 'Special Edition ' :
                     editVolForm.type === 'special' ? 'Special ' : 'Band '} 
                    {String(editVolForm.volume_number || activeVolume.volume_number).replace(/schuber\s*|special\s*edition\s*|limited\s*edition\s*|spezial\s*edition\s*|special\s*|extra\s*/i, '')} bearbeiten
                  </span>
                </h3>
                <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5 truncate">
                  Typ, Details, Preis und Sammlerangaben für diesen Eintrag
                </p>
              </div>
              <button 
                type="button" 
                onClick={() => onClose()} 
                className="text-slate-400 hover:text-white p-1.5 rounded-xl hover:bg-slate-800 transition-colors shrink-0 bg-slate-800/40"
                aria-label="Schließen"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveVolume} className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {/* Scrollable Form Body */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 custom-scrollbar">
                {/* Auto-Fill Banner / Button */}
              <div className="p-3.5 rounded-2xl bg-gradient-to-br from-indigo-950/40 via-slate-900 to-sky-950/40 border border-sky-500/25 shadow-lg relative overflow-hidden">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0 mt-0.5">
                    {editVolForm.type === 'schuber' ? <Package className="w-5 h-5 text-indigo-400" /> : <Sparkles className="w-5 h-5 text-sky-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs sm:text-sm font-bold text-white">
                        {editVolForm.type === 'schuber' ? 'Schuber-Cover & Details laden' : 'Metadaten automatisch ausfüllen'}
                      </h4>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                        Manga Passion
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-300/80 mt-1 leading-relaxed">
                      {editVolForm.type === 'schuber'
                        ? 'Offizielles Schuber-Cover herunterladen, Erscheinungsdatum, Titel & Preis automatisch abrufen.'
                        : 'Erscheinungsdatum, Jahr, Seitenzahl, ISBN & Preis automatisch abrufen.'}
                    </p>
                  </div>
                </div>

                <div className="mt-3 pt-2.5 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => handleAutofillVolumeData()}
                    disabled={autofillingVolume}
                    className="btn-primary w-full text-xs py-2.5 px-4 flex items-center justify-center gap-2 shadow-md shadow-sky-600/20 active:scale-[0.99] transition-all font-semibold"
                    title="Metadaten via Manga Passion automatisch abrufen"
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${autofillingVolume ? 'animate-spin' : ''}`} />
                    <span>
                      {autofillingVolume 
                        ? 'Lade Daten von Manga Passion...' 
                        : (editVolForm.type === 'schuber' ? '✨ Schuber-Cover & Details jetzt laden' : '✨ Daten jetzt automatisch ausfüllen')}
                    </span>
                  </button>
                </div>
              </div>

              {/* Autofill Status Message */}
              {autofillMessage && (
                <div className={`p-2.5 rounded-xl text-xs flex items-center justify-between gap-2 animate-fade-in ${
                  autofillMessage.type === 'success' 
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300' 
                    : autofillMessage.type === 'info'
                      ? 'bg-sky-500/15 border border-sky-500/30 text-sky-300'
                      : 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                }`}>
                  <div className="flex items-center gap-2">
                    {autofillMessage.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : autofillMessage.type === 'info' ? (
                      <Sparkles className="w-4 h-4 text-sky-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    <span>{autofillMessage.text}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAutofillMessage(null)}
                    className="text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Row 1: Type & Volume Number */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-3.5">
                <div className="sm:col-span-7">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-brand-400" /> Eintragstyp
                  </label>
                  <select 
                    className="input-field bg-slate-950 font-medium py-2.5 text-sm w-full cursor-pointer hover:border-slate-700"
                    value={editVolForm.type || 'volume'} 
                    onChange={e => setEditVolForm({ ...editVolForm, type: e.target.value })}
                  >
                    <option value="volume">📖 Einzelband</option>
                    <option value="special_edition">✨ Special Edition</option>
                    <option value="schuber">📦 Schuber</option>
                    <option value="special">⭐ Special / Extra</option>
                  </select>
                </div>

                <div className="sm:col-span-5">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Hash className="w-3.5 h-3.5 text-slate-400" />
                    {editVolForm.type === 'schuber' ? 'Schuber-Nr.' : 
                     editVolForm.type === 'special_edition' ? 'Band-Nr.' :
                     editVolForm.type === 'special' ? 'Bezeichnung' : 'Band-Nummer'} <span className="text-red-400">*</span>
                  </label>
                  <input 
                    type="text" 
                    required
                    className="input-field py-2.5 text-sm font-semibold" 
                    value={editVolForm.volume_number} 
                    onChange={e => setEditVolForm({ ...editVolForm, volume_number: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 2: Status & Price */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-3.5 items-end">
                <div className="sm:col-span-7">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Bookmark className="w-3.5 h-3.5 text-brand-400" /> Sammler-Status
                  </label>
                  {/* Segmented Switch Pill Control */}
                  <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950/90 rounded-xl border border-slate-800 shadow-inner">
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, status: 'Vorhanden' })}
                      className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
                        editVolForm.status === 'Vorhanden'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/30'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5] shrink-0" />
                      <span className="truncate">Im Besitz</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, status: 'Vorbestellt' })}
                      className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
                        editVolForm.status === 'Vorbestellt'
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/50 shadow-sm shadow-sky-950/40 ring-1 ring-sky-500/30'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                      }`}
                    >
                      <Truck className="w-3.5 h-3.5 text-sky-400 stroke-[2.5] shrink-0" />
                      <span className="truncate">Vorbestellt</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, status: 'Erscheint bald' })}
                      className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
                        editVolForm.status === 'Erscheint bald'
                          ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-sm shadow-purple-950/40 ring-1 ring-purple-500/30'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                      }`}
                    >
                      <Calendar className="w-3.5 h-3.5 text-purple-400 stroke-[2.5] shrink-0" />
                      <span className="truncate">Erscheint bald</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, status: 'Fehlt' })}
                      className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
                        editVolForm.status === 'Fehlt'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/40 ring-1 ring-rose-500/30'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                      }`}
                    >
                      <X className="w-3.5 h-3.5 text-rose-400 stroke-[2.5] shrink-0" />
                      <span className="truncate">Fehlt noch</span>
                    </button>
                  </div>
                </div>

                <div className="sm:col-span-5">
                  <label className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
                    <Coins className="w-3.5 h-3.5" /> Kaufpreis (€)
                  </label>
                  <div className="relative">
                    <input 
                      type="text" 
                      placeholder="0,00"
                      className="input-field border-emerald-500/40 focus:border-emerald-500 font-mono font-bold text-emerald-300 pr-8 py-2.5 text-sm" 
                      value={editVolForm.price} 
                      onChange={e => setEditVolForm({ ...editVolForm, price: e.target.value })} 
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none">€</span>
                  </div>
                </div>
              </div>

              {/* Volume Cover & Images Section */}
              <VolumePhotoManager
                editVolForm={editVolForm}
                handleAddImageUrl={handleAddImageUrl}
                handleMoveVolumeImage={handleMoveVolumeImage}
                handleRemoveVolumeImage={handleRemoveVolumeImage}
                handleSetVolumeCover={handleSetVolumeCover}
                handleUploadVolumeImages={handleUploadVolumeImages}
                manualImageUrl={manualImageUrl}
                onPreviewImage={onPreviewImage}
                setManualImageUrl={setManualImageUrl}
                setShowUrlInput={setShowUrlInput}
                showUrlInput={showUrlInput}
                uploadingVolImage={uploadingVolImage}
              />

              {/* Row 2: Publisher with "Vom Manga übernehmen" Button */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-brand-400" /> Verlag
                  </label>
                  {manga.publisher && (
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, publisher: manga.publisher })}
                      className="text-[11px] text-brand-400 hover:text-brand-300 underline"
                    >
                      Vom Manga ({manga.publisher}) übernehmen
                    </button>
                  )}
                </div>
                <input 
                  type="text" 
                  placeholder={`z. B. ${manga.publisher || 'Carlsen Manga, Tokyopop, ...'}`}
                  className="input-field" 
                  value={editVolForm.publisher} 
                  onChange={e => setEditVolForm({ ...editVolForm, publisher: e.target.value })} 
                />
              </div>

              {/* Row 3: Condition & Release Year */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Zustand
                  </label>
                  <select 
                    className="input-field bg-slate-950"
                    value={editVolForm.condition} 
                    onChange={e => setEditVolForm({ ...editVolForm, condition: e.target.value })}
                  >
                    <option value="">-- Keine Angabe --</option>
                    <option value="Neuwertig">Neuwertig (Mint / Wie neu)</option>
                    <option value="Sehr gut">Sehr gut (Leichte Spuren)</option>
                    <option value="Gut">Gut (Normal gelesen)</option>
                    <option value="Akzeptabel">Akzeptabel (Vergilbt / Knicke)</option>
                    <option value="Mängelexemplar">Mängelexemplar / Stempel</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" /> Erscheinungsjahr
                  </label>
                  <input 
                    type="number" 
                    placeholder="z. B. 2023"
                    className="input-field" 
                    value={editVolForm.release_year} 
                    onChange={e => setEditVolForm({ ...editVolForm, release_year: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 4: Pages & ISBN */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-slate-400" /> Seitenzahl
                  </label>
                  <input 
                    type="number" 
                    placeholder="z. B. 192"
                    className="input-field" 
                    value={editVolForm.pages} 
                    onChange={e => setEditVolForm({ ...editVolForm, pages: e.target.value })} 
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      <Hash className="w-3.5 h-3.5 text-slate-400" /> ISBN-Nummer
                    </span>
                    <BarcodeScannerButton 
                      compact 
                      buttonText="Scannen"
                      onDetected={(isbn) => {
                        setEditVolForm(prev => ({ ...prev, isbn }));
                      }} 
                    />
                  </label>
                  <input 
                    type="text" 
                    placeholder="z. B. 978-3-551-78901-2"
                    className="input-field font-mono" 
                    value={editVolForm.isbn} 
                    onChange={e => setEditVolForm({ ...editVolForm, isbn: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 5: Release date & Purchase date */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-3.5">
                <div>
                  <label className="block text-xs font-semibold text-sky-400 mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" /> Erscheinungsdatum (Radar)
                    </span>
                    <button
                      type="button"
                      onClick={handleAutofillVolumeData}
                      disabled={autofillingVolume}
                      className="text-[10px] text-sky-400 hover:text-sky-300 underline font-normal flex items-center gap-1 cursor-pointer"
                      title="Erscheinungsdatum und Details automatisch suchen"
                    >
                      <Sparkles className="w-3 h-3" />
                      {autofillingVolume ? 'Lade...' : 'Auto-Ausfüllen'}
                    </button>
                  </label>
                  <input 
                    type="date" 
                    className="input-field bg-slate-950 border-sky-500/30 focus:border-sky-500 text-sky-200" 
                    value={editVolForm.release_date || ''} 
                    onChange={e => setEditVolForm({ ...editVolForm, release_date: e.target.value })} 
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" /> Kaufdatum
                  </label>
                  <input 
                    type="date" 
                    className="input-field bg-slate-950" 
                    value={editVolForm.purchase_date} 
                    onChange={e => setEditVolForm({ ...editVolForm, purchase_date: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 6: Notes & Extras */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Notizen & Besonderheiten (z. B. Extras, Erstauflage, Farbschnitt)
                </label>
                <textarea 
                  rows="2" 
                  placeholder="z. B. Erstauflage mit Postkarte, Limited Variant Cover"
                  className="input-field resize-none text-xs" 
                  value={editVolForm.notes} 
                  onChange={e => setEditVolForm({ ...editVolForm, notes: e.target.value })} 
                />
              </div>

              </div>

              {/* Modal Buttons (Fixed at bottom with solid background, NEVER overlapping or bleeding through) */}
              <div className="shrink-0 bg-slate-900 border-t border-slate-800 px-4 py-3 sm:px-6 sm:py-3.5 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-2.5">
                <button 
                  type="button" 
                  onClick={(e) => handleDeleteVolume(e, activeVolume.id)} 
                  className="btn-danger text-xs py-2 px-3 flex items-center justify-center gap-1.5 w-full sm:w-auto"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Band löschen
                </button>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button 
                    type="button" 
                    onClick={() => onClose()} 
                    className="btn-secondary text-xs py-2 px-4 flex-1 sm:flex-initial text-center"
                  >
                    Abbrechen
                  </button>
                  <button 
                    type="submit" 
                    disabled={savingVol}
                    className="btn-primary text-xs py-2 px-4 flex-1 sm:flex-initial flex items-center justify-center gap-1.5 shadow-lg font-semibold"
                  >
                    <Save className="w-3.5 h-3.5" /> {savingVol ? 'Speichert...' : 'Speichern'}
                  </button>
                </div>
              </div>
            </form>
          </div>
      </div>
  );
}
