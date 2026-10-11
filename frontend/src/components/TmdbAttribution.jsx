import { t } from '../i18n/index.js';

/** TMDB mark and the notice TMDB's terms ask for wherever TMDB keys or data appear. */
export default function TmdbAttribution({ className = '' }) {
  return (
    <p className={`flex items-center gap-2 text-[11px] text-slate-400 ${className}`} data-testid="tmdb-attribution">
      <span className="shrink-0 inline-flex items-center h-4 px-1 rounded border border-slate-600 text-[10px] leading-none font-extrabold tracking-wide text-slate-200">TMDB</span>
      <span>{t('Dieses Produkt verwendet die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert.')}</span>
    </p>
  );
}
