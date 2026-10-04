import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Star, ExternalLink, X, ChevronLeft, ChevronRight } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { apiFetch, assetUrl, assetImgProps } from '../../utils/api';

const SWIPE_MIN_PX = 50;

export default function LightboxGallery({
  lightboxData,
  setLightboxData,
  onClose,
  canEdit,
  onSuccess,
  onSetCover
}) {
  const step = useCallback((delta) => {
    setLightboxData(prev => {
      if (!prev || prev.images.length <= 1) return prev;
      return { ...prev, currentIndex: (prev.currentIndex + delta + prev.images.length) % prev.images.length };
    });
  }, [setLightboxData]);

  useEffect(() => {
    if (!lightboxData) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        // topmost layer: the page's own Escape handling must not also close the dialog underneath
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        step(-1);
      } else if (e.key === 'ArrowRight') {
        step(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [lightboxData, onClose, step]);

  // horizontal swipe on touch and pen; a mostly vertical drag or one under 50 px does nothing
  const swipeRef = useRef(null);
  const swipeHandlers = {
    onPointerDown: (e) => {
      swipeRef.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e) => {
      const start = swipeRef.current;
      swipeRef.current = null;
      if (!start) return;
      const dx = e.clientX - start.x;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(e.clientY - start.y)) return;
      step(dx < 0 ? 1 : -1);
    },
    onPointerCancel: () => { swipeRef.current = null; }
  };

  const dialogRef = useDialogA11y(Boolean(lightboxData));
  if (!lightboxData) return null;

  const canSetCover = canEdit && Boolean(onSetCover || lightboxData.volumeId);
  const isCover = lightboxData.volume?.cover_image === lightboxData.images[lightboxData.currentIndex];
  const coverLabel = isCover ? 'Aktuelles Cover' : 'Als Cover festlegen';

  const handleSetCoverFromLightbox = async () => {
    if (!canSetCover || isCover) return;
    const currentImg = lightboxData.images[lightboxData.currentIndex];
    if (!currentImg) return;
    if (onSetCover) {
      onSetCover(currentImg);
      return;
    }
    try {
      const res = await apiFetch(`/api/volumes/${lightboxData.volumeId}`, {
        method: 'PUT',
        body: {
          ...lightboxData.volume,
          cover_image: currentImg
        }
      });
      if (res.ok) {
        if (onSuccess) await onSuccess();
        setLightboxData(prev => ({
          ...prev,
          volume: { ...prev.volume, cover_image: currentImg }
        }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  return createPortal(
    <div 
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Bildergalerie"
      tabIndex={-1}
      className="outline-none fixed inset-0 z-60 bg-black/95 flex flex-col justify-between dialog-safe-area animate-fade-in select-none"
      onClick={onClose}
    >
      {/* Lightbox Top Header */}
      <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-800/80 z-10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-brand-400 shrink-0">
            <Camera className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
              <span>{lightboxData.title}</span>
              {lightboxData.images.length > 1 && (
                <span className="bg-slate-800 text-slate-300 text-[11px] font-mono px-2 py-0.5 rounded-full border border-slate-700" aria-live="polite">
                  <span aria-hidden="true">{lightboxData.currentIndex + 1} / {lightboxData.images.length}</span>
                  <span className="sr-only">Bild {lightboxData.currentIndex + 1} von {lightboxData.images.length}</span>
                </span>
              )}
              {isCover && (
                <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Star className="w-2.5 h-2.5 fill-current text-brand-400" /> Cover
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400">{lightboxData.subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canSetCover && (
            <button
              type="button"
              onClick={handleSetCoverFromLightbox}
              aria-disabled={isCover || undefined}
              className={`text-xs px-3 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all ${
                isCover
                  ? 'bg-brand-500/20 text-brand-300 border-brand-500/50 cursor-default'
                  : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white border-slate-700'
              }`}
              title={isCover ? 'Dieses Bild ist das aktuelle Cover' : 'Dieses Bild als Coverbild für diesen Eintrag festlegen'}
              aria-label={coverLabel}
            >
              <Star className={`w-3.5 h-3.5 ${isCover ? 'fill-current text-brand-400' : 'text-slate-400'}`} />
              <span className="hidden sm:inline">{coverLabel}</span>
            </button>
          )}

          <a 
            href={assetUrl(lightboxData.images[lightboxData.currentIndex])} 
            target="_blank" 
            rel="noreferrer" 
            className="text-xs text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700 p-2 sm:px-3 sm:py-1.5 rounded-xl transition-colors flex items-center gap-1.5"
            title="In Originalgröße in neuem Tab öffnen"
            aria-label="Original in neuem Tab öffnen"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Original</span>
          </a>

          <button 
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 transition-colors"
            title="Galerie schließen (Esc)"
            aria-label="Galerie schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Lightbox Center: Image with Left / Right Navigation */}
      <div className="flex-1 flex items-center justify-between gap-2 sm:gap-4 my-2 sm:my-4 relative min-h-0" onClick={e => e.stopPropagation()}>
        {/* Prev Button */}
        {lightboxData.images.length > 1 ? (
          <button
            type="button"
            onClick={() => step(-1)}
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-slate-950/80 hover:bg-slate-900 border border-slate-800 text-white flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all shadow-xl z-10"
            title="Vorheriges Bild (Pfeiltaste links)"
            aria-label="Vorheriges Bild"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        ) : <div className="w-10 sm:w-12 shrink-0" />}

        {/* Main Image */}
        <div
          {...swipeHandlers}
          className="flex-1 flex flex-col items-center justify-center h-full max-h-[75vh] relative overflow-hidden touch-pan-y touch-pinch-zoom"
        >
          <img 
            key={lightboxData.images[lightboxData.currentIndex]}
            {...assetImgProps(lightboxData.images[lightboxData.currentIndex])} 
            alt={`Foto ${lightboxData.currentIndex + 1}`} 
            className="max-h-full max-w-full rounded-2xl shadow-2xl object-contain border border-slate-800/80 transition-all duration-200 animate-fade-in"
          />
        </div>

        {/* Next Button */}
        {lightboxData.images.length > 1 ? (
          <button
            type="button"
            onClick={() => step(1)}
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-slate-950/80 hover:bg-slate-900 border border-slate-800 text-white flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all shadow-xl z-10"
            title="Nächstes Bild (Pfeiltaste rechts)"
            aria-label="Nächstes Bild"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        ) : <div className="w-10 sm:w-12 shrink-0" />}
      </div>

      {/* Lightbox Bottom Thumbnail Strip */}
      {lightboxData.images.length > 1 && (
        <div className="flex items-center justify-center gap-2 overflow-x-auto py-2 px-4 max-w-2xl mx-auto z-10" onClick={e => e.stopPropagation()}>
          {lightboxData.images.map((thumbUrl, idx) => {
            const isActive = idx === lightboxData.currentIndex;
            const thumbIsCover = lightboxData.volume?.cover_image === thumbUrl;
            return (
              <button
                type="button"
                key={idx}
                aria-label={`Bild ${idx + 1} anzeigen${thumbIsCover ? ' (Cover)' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => setLightboxData(prev => ({ ...prev, currentIndex: idx }))}
                className={`relative rounded-xl overflow-hidden shrink-0 transition-all ${
                  isActive 
                    ? 'ring-2 ring-brand-500 scale-110 shadow-lg shadow-brand-500/30 border border-brand-400' 
                    : 'opacity-50 hover:opacity-100 border border-slate-800'
                }`}
              >
                <img 
                  {...assetImgProps(thumbUrl)} 
                  alt="" 
                  className="w-10 h-14 sm:w-12 sm:h-16 object-cover" 
                />
                {thumbIsCover && (
                  <div aria-hidden="true" className="absolute bottom-0 inset-x-0 bg-brand-700/90 text-[8px] text-white font-bold py-px text-center">
                    Cover
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body
  );
}
