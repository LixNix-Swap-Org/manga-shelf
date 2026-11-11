import { useId, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { ChevronDown, Tag } from 'lucide-react';
import { splitTags } from '../../utils/tags';
import { isLongDescription, tagShelfPath } from './MangaHeroCard';
import { t as tr } from '../../i18n/index.js';

/**
 * Tab "Infos" of the series page: genres and tags (each a link to the shelf filtered by it, or "Genres nachladen" for
 * an empty list when `canFillTags`) and the description (clamped below md behind "Mehr anzeigen").
 */
export default function SeriesInfo({ manga, canEdit, canFillTags = false, fillingTags = false, handleFillTags }) {
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const inRouter = useInRouterContext();
  const ids = useId();
  const seriesTags = splitTags(manga.tags);
  const longDescription = isLongDescription(manga.description);
  return (
    <div id="detail-info" className="space-y-6">
      {seriesTags.length > 0 && (
        <ul id="detail-tags" className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={tr('Genres und Tags')}>
          <li aria-hidden="true"><Tag className="w-3.5 h-3.5 text-fuchsia-400" /></li>
          {seriesTags.map((tag) => (
            <li key={tag.toLowerCase()}>
              {inRouter ? (
                <Link
                  to={tagShelfPath(tag)}
                  className="inline-block rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 text-fuchsia-200 hover:bg-fuchsia-500/25"
                  title={tr('Alle Reihen mit „{tag}“', { tag })}
                >
                  {tag}
                </Link>
              ) : (
                <span className="inline-block rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 text-fuchsia-200">{tag}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {seriesTags.length === 0 && canFillTags && handleFillTags && (
        <div>
          <button
            type="button"
            id="btn-fill-tags"
            onClick={handleFillTags}
            disabled={fillingTags}
            className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
            title={tr('Genres aus der verknüpften Manga-Passion-Edition übernehmen')}
          >
            <Tag className="w-3.5 h-3.5 text-fuchsia-400" aria-hidden="true" />
            {fillingTags ? tr('Genres werden geladen…') : tr('Genres nachladen')}
          </button>
        </div>
      )}

      {/* Description */}
      <div>
        <h2 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2">{tr('Beschreibung')}</h2>
        <div className="max-w-2xl bg-slate-950/40 p-4 rounded-2xl border border-slate-800/60">
          <p
            id={`${ids}-description-text`}
            className={`text-sm text-slate-300 leading-relaxed whitespace-pre-line break-words ${longDescription && !descriptionOpen ? 'line-clamp-5 md:line-clamp-none' : ''}`}
          >
            {manga.description || (canEdit
              ? tr('Keine Beschreibung vorhanden. Klicke auf "Bearbeiten", um eine Inhaltsangabe hinzuzufügen.')
              : tr('Keine Beschreibung vorhanden.'))}
          </p>
          {longDescription && (
            <button
              type="button"
              id="btn-description-more"
              aria-expanded={descriptionOpen}
              aria-controls={`${ids}-description-text`}
              onClick={() => setDescriptionOpen((open) => !open)}
              className="hit-44 md:hidden mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-300 hover:text-brand-200"
            >
              {descriptionOpen ? tr('Weniger anzeigen') : tr('Mehr anzeigen')}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${descriptionOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
