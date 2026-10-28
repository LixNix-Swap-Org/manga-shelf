import { lazy, Suspense, useState } from 'react';
import { BookOpen } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import { t } from '../../../i18n/index.js';

const LightboxGallery = lazy(() => import('../../detail/LightboxGallery'));

const SIZE = 'w-24 h-36 sm:w-28 sm:h-[10.5rem]';

const COVER_FALLBACK = (
  <div aria-hidden="true" className={`${SIZE} bg-slate-800 rounded-xl flex items-center justify-center text-slate-500`}>
    <BookOpen className="w-7 h-7" />
  </div>
);

/** Radar cover; a tap opens it full size in the gallery (only while an image could be loaded). */
export default function RadarCover({ src, title, subtitle }) {
  const [failed, setFailed] = useState(() => new Set());
  const [lightbox, setLightbox] = useState(null);
  // failures live here, not in CoverImage: switching from button to plain frame remounts the image
  const candidates = (Array.isArray(src) ? src : [src]).filter((url) => typeof url === 'string' && url && !failed.has(url));
  const current = candidates[0];
  const frame = 'shrink-0 relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md';
  const image = (
    <CoverImage
      src={candidates}
      alt={title}
      fallback={COVER_FALLBACK}
      onFail={(url) => setFailed((prev) => new Set(prev).add(url))}
      className={`${SIZE} object-cover group-hover/thumb:scale-105 transition-transform duration-300`}
    />
  );

  if (!current) return <div className={frame}>{image}</div>;
  return (
    <>
      <button
        type="button"
        onClick={() => setLightbox({ images: [current], currentIndex: 0, title, subtitle })}
        className={`${frame} group/thumb cursor-zoom-in hover:border-sky-500/60 transition-colors`}
        aria-label={t('Cover vergrößern: {title}', { title })}
        title={t('Cover vergrößern: {title}', { title })}
      >
        {image}
      </button>
      {lightbox && (
        <Suspense fallback={null}>
          <LightboxGallery
            lightboxData={lightbox}
            setLightboxData={setLightbox}
            onClose={() => setLightbox(null)}
            canEdit={false}
          />
        </Suspense>
      )}
    </>
  );
}
