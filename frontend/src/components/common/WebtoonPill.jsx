import { t } from '../../i18n/index.js';

const SIZES = {
  sm: 'text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
  md: 'text-xs font-semibold px-3 py-1 rounded-xl'
};

/** "Webtoon" next to the status of a series read by chapter (mangas.format); nothing for a print series. */
export default function WebtoonPill({ format, size = 'sm' }) {
  if (format !== 'webtoon') return null;
  return (
    <span className={`shrink-0 border border-teal-400/50 bg-teal-950/80 text-teal-200 ${SIZES[size] || SIZES.sm}`}>
      {t('Webtoon')}
    </span>
  );
}
