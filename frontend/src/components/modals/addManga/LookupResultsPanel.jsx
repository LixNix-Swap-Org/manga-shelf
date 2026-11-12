// The hits of the series search in "Neuer Manga" (Manga Passion first, then AniList / MyAnimeList); a click fills the
// form (split from AddMangaModal.jsx).
import { BookOpen, Globe, Library, RefreshCw, Sparkles } from 'lucide-react';
import { assetImgProps } from '../../../utils/api';
import { alsoOnLabels, lookupSourceLabels } from '../../../utils/lookupPrefill';
import { formatCount } from '../../../utils/format';
import { mangaStatusLabel } from '../../../utils/enumLabels';
import { t } from '../../../i18n/index.js';

export const lookupKey = (item) => item.id ?? item.title;

export default function LookupResultsPanel({ results, mpFirst, applying, applyingId, onApply, onClose, failedImages, setFailedImages }) {
  return (
    <div className="bg-slate-950/95 border border-brand-500/40 rounded-xl p-3 space-y-2.5 shadow-xl" aria-busy={applying || undefined}>
      <div className="flex justify-between items-center text-xs">
        <span className="font-semibold text-brand-400 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" /> {mpFirst ? t('Treffer auswählen (Manga Passion zuerst):') : t('Treffer auswählen (AniList / MyAnimeList):')}
        </span>
        <button
          type="button"
          onClick={onClose}
          disabled={applying}
          className="text-slate-400 hover:text-white text-[11px] disabled:opacity-50"
        >
          {t('Schließen')}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
        {results.map(item => {
          const isApplying = applyingId === lookupKey(item);
          return (
          <button
            key={item.id}
            type="button"
            onClick={() => onApply(item)}
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
                {item.source === 'manga_passion' && (
                  <span className="inline-flex items-center gap-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1 py-px rounded text-[9px] font-bold shrink-0">
                    <Library className="w-3 h-3" aria-hidden="true" />{t('Manga Passion')}
                  </span>
                )}
                {(item.source === 'manga_passion' ? alsoOnLabels(item) : lookupSourceLabels(item)).map((label) => (
                  <span key={label} className="inline-flex items-center gap-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-px rounded text-[9px] font-medium shrink-0">
                    <Globe className="w-3 h-3" aria-hidden="true" />{label}
                  </span>
                ))}
                {item.format_label && (
                  <span className="inline-flex items-center bg-amber-500/20 text-amber-200 border border-amber-500/40 px-1 py-px rounded text-[9px] font-medium shrink-0">{item.format_label}</span>
                )}
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
  );
}
