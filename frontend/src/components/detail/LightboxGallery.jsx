import { useEffect } from 'react';
import { Camera, Star, ExternalLink, X, ChevronLeft, ChevronRight } from 'lucide-react';

export default function LightboxGallery({
  lightboxData,
  setLightboxData,
  onClose,
  canEdit,
  onSuccess
}) {
  useEffect(() => {
    if (!lightboxData) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        setLightboxData(prev => {
          if (!prev || prev.images.length <= 1) return prev;
          return {
            ...prev,
            currentIndex: (prev.currentIndex - 1 + prev.images.length) % prev.images.length
          };
        });
      } else if (e.key === 'ArrowRight') {
        setLightboxData(prev => {
          if (!prev || prev.images.length <= 1) return prev;
          return {
            ...prev,
            currentIndex: (prev.currentIndex + 1) % prev.images.length
          };
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxData, onClose, setLightboxData]);

  if (!lightboxData) return null;

  const handleSetCoverFromLightbox = async () => {
    if (!canEdit || !lightboxData || !lightboxData.volumeId) return;
    const currentImg = lightboxData.images[lightboxData.currentIndex];
    if (!currentImg) return;
    try {
      const res = await fetch(`/api/volumes/${lightboxData.volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...lightboxData.volume,
          cover_image: currentImg
        })
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

  return (
    <div 
      className="fixed inset-0 z-60 bg-black/95 backdrop-blur-xl flex flex-col justify-between p-3 sm:p-6 animate-fade-in select-none"
      onClick={onClose}
    >
      {/* Lightbox Top Header */}
      <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-800/80 z-10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-brand-400 shrink-0">
            <Camera className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
              <span>{lightboxData.title}</span>
              {lightboxData.images.length > 1 && (
                <span className="bg-slate-800 text-slate-300 text-[11px] font-mono px-2 py-0.5 rounded-full border border-slate-700">
                  {lightboxData.currentIndex + 1} / {lightboxData.images.length}
                </span>
              )}
              {lightboxData.volume?.cover_image === lightboxData.images[lightboxData.currentIndex] && (
                <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Star className="w-2.5 h-2.5 fill-current text-brand-400" /> Cover
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-400">{lightboxData.subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canEdit && lightboxData.volumeId && (
            <button
              type="button"
              onClick={handleSetCoverFromLightbox}
              className={`text-xs px-3 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all ${
                lightboxData.volume?.cover_image === lightboxData.images[lightboxData.currentIndex]
                  ? 'bg-brand-500/20 text-brand-300 border-brand-500/50 cursor-default'
                  : 'bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white border-slate-700'
              }`}
              title="Dieses Bild als Coverbild für diesen Eintrag festlegen"
            >
              <Star className={`w-3.5 h-3.5 ${lightboxData.volume?.cover_image === lightboxData.images[lightboxData.currentIndex] ? 'fill-current text-brand-400' : 'text-slate-400'}`} />
              <span className="hidden sm:inline">
                {lightboxData.volume?.cover_image === lightboxData.images[lightboxData.currentIndex] ? 'Aktuelles Cover' : 'Als Cover festlegen'}
              </span>
            </button>
          )}

          <a 
            href={lightboxData.images[lightboxData.currentIndex]} 
            target="_blank" 
            rel="noreferrer" 
            className="text-xs text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700 p-2 sm:px-3 sm:py-1.5 rounded-xl transition-colors flex items-center gap-1.5"
            title="In Originalgröße in neuem Tab öffnen"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Original</span>
          </a>

          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 transition-colors"
            title="Galerie schließen (Esc)"
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
            onClick={() => setLightboxData(prev => ({
              ...prev,
              currentIndex: (prev.currentIndex - 1 + prev.images.length) % prev.images.length
            }))}
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-slate-950/80 hover:bg-slate-900 border border-slate-800 text-white flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all shadow-xl z-10"
            title="Vorheriges Bild (Pfeiltaste links)"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        ) : <div className="w-10 sm:w-12 shrink-0" />}

        {/* Main Image */}
        <div className="flex-1 flex flex-col items-center justify-center h-full max-h-[75vh] relative overflow-hidden">
          <img 
            key={lightboxData.images[lightboxData.currentIndex]}
            src={lightboxData.images[lightboxData.currentIndex]} 
            alt={`Foto ${lightboxData.currentIndex + 1}`} 
            className="max-h-full max-w-full rounded-2xl shadow-2xl object-contain border border-slate-800/80 transition-all duration-200 animate-fade-in"
          />
        </div>

        {/* Next Button */}
        {lightboxData.images.length > 1 ? (
          <button
            onClick={() => setLightboxData(prev => ({
              ...prev,
              currentIndex: (prev.currentIndex + 1) % prev.images.length
            }))}
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-slate-950/80 hover:bg-slate-900 border border-slate-800 text-white flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all shadow-xl z-10"
            title="Nächstes Bild (Pfeiltaste rechts)"
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
            const isCover = lightboxData.volume?.cover_image === thumbUrl;
            return (
              <button
                key={idx}
                onClick={() => setLightboxData(prev => ({ ...prev, currentIndex: idx }))}
                className={`relative rounded-xl overflow-hidden shrink-0 transition-all ${
                  isActive 
                    ? 'ring-2 ring-brand-500 scale-110 shadow-lg shadow-brand-500/30 border border-brand-400' 
                    : 'opacity-50 hover:opacity-100 border border-slate-800'
                }`}
              >
                <img 
                  src={thumbUrl} 
                  alt={`Thumb ${idx + 1}`} 
                  className="w-10 h-14 sm:w-12 sm:h-16 object-cover" 
                />
                {isCover && (
                  <div className="absolute bottom-0 inset-x-0 bg-brand-600/90 text-[8px] text-white font-bold py-0.2 text-center">
                    Cover
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
