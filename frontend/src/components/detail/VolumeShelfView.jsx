import { ChevronLeft, ChevronRight, Layers, Library, Maximize2, MoveHorizontal } from 'lucide-react';
import { countShelfItems } from './volumeViewHelpers';
import { formatCount } from '../../utils/format';
import { t, tn } from '../../i18n/index.js';

const KBD = 'px-1 bg-slate-900 border border-slate-700 rounded text-slate-300 font-mono text-[9px]';

/** 3D spine bookshelf view (toolbar, layout modes and shelf rows). Purely presentational; all state and handlers come in via props. */
export default function VolumeShelfView({
  canEdit,
  handleSetShelfMode,
  handleSetShelfScale,
  isFitMultiRow,
  renderShelfSpine,
  scrollShelf,
  shelfMode,
  shelfRows,
  shelfScale,
  shelfScrollRef,
  shelfMeasureRef,
  spineShelfItems
}) {
  const counts = countShelfItems(spineShelfItems);
  return (
    <div className="mb-8">
      {/* Shelf Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 px-1">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
            <Library className="w-4 h-4 text-brand-400" />
            {t('Manga-Regal')}
          </h3>
          <span className="text-[11px] text-slate-400 font-mono">
            ({formatCount(counts.volumes, 'Band', 'Bände')}{counts.gaps > 0 ? ` + ${formatCount(counts.gaps, 'Lücke', 'Lücken')}` : ''})
          </span>
          <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-[10px] text-slate-400 font-medium" title={t('Tastatur-Navigation im Regal')}>
            <span>{t('Tasten:')}</span>
            <kbd className={KBD}>J</kbd>
            <kbd className={KBD}>K</kbd>
            {canEdit && (
              <>
                <span className="text-slate-500" aria-hidden="true">•</span>
                <kbd className={KBD}>{t('Leertaste')}</kbd>
                <span className="text-slate-400">{t('Gelesen')}</span>
                <span className="text-slate-500" aria-hidden="true">•</span>
                <kbd className={KBD}>E</kbd>
                <span className="text-slate-400">{t('Bearbeiten')}</span>
              </>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Shelf Layout Mode: Auto-Fit | Regalbretter | Scrollen */}
          <div role="group" aria-label={t('Regal-Layout')} className="flex items-center bg-slate-900/90 p-0.5 rounded-xl border border-slate-800 text-xs">
            <button
              type="button"
              aria-pressed={shelfMode === 'fit'}
              onClick={() => handleSetShelfMode('fit')}
              className={`hit-44 px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                shelfMode === 'fit'
                  ? 'bg-brand-700 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={t('Auto-Fit: Alle Bände passen sich dynamisch an die Bildschirmbreite an')}
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>{t('Auto-Fit')}</span>
            </button>

            <button
              type="button"
              aria-pressed={shelfMode === 'rows'}
              onClick={() => handleSetShelfMode('rows')}
              className={`hit-44 px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                shelfMode === 'rows'
                  ? 'bg-brand-700 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={t('Regalbretter: Mehrzeiliges Bücherregal mit Holzplanken pro Reihe')}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>{t('Regalbretter')}</span>
            </button>

            <button
              type="button"
              aria-pressed={shelfMode === 'scroll'}
              onClick={() => handleSetShelfMode('scroll')}
              className={`hit-44 px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                shelfMode === 'scroll'
                  ? 'bg-brand-700 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={t('Scrollen: Klassische horizontale Leiste mit Scrollbalken')}
            >
              <MoveHorizontal className="w-3.5 h-3.5" />
              <span>{t('Scrollen')}</span>
            </button>
          </div>

          {/* Shelf Scale (S / M / L) */}
          <div role="group" aria-label={t('Regal-Größe')} className="flex items-center bg-slate-900/90 p-0.5 rounded-xl border border-slate-800 text-xs">
            <button
              type="button"
              aria-pressed={shelfScale === 's'}
              aria-label={t('Kompakt')}
              onClick={() => handleSetShelfScale('s')}
              className={`hit-44 [@media(pointer:coarse)]:min-w-11 px-2 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                shelfScale === 's'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-300'
              }`}
              title={t('Kompakte Ansicht (S)')}
            >
              S
            </button>
            <button
              type="button"
              aria-pressed={shelfScale === 'm'}
              aria-label={t('Standard')}
              onClick={() => handleSetShelfScale('m')}
              className={`hit-44 [@media(pointer:coarse)]:min-w-11 px-2 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                shelfScale === 'm'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-300'
              }`}
              title={t('Standard Ansicht (M)')}
            >
              M
            </button>
            <button
              type="button"
              aria-pressed={shelfScale === 'l'}
              aria-label={t('Groß')}
              onClick={() => handleSetShelfScale('l')}
              className={`hit-44 [@media(pointer:coarse)]:min-w-11 px-2 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                shelfScale === 'l'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-300'
              }`}
              title={t('Große Ansicht (L)')}
            >
              L
            </button>
          </div>

          {/* Quick Scroll Left/Right arrows when in scroll mode */}
          {shelfMode === 'scroll' && (
            <div className="flex items-center gap-0.5 bg-slate-900/90 p-0.5 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => scrollShelf(-350)}
                aria-label={t('Nach links scrollen')}
                className="hit-44 p-1 [@media(pointer:coarse)]:p-2.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
                title={t('Nach links scrollen')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => scrollShelf(350)}
                aria-label={t('Nach rechts scrollen')}
                className="hit-44 p-1 [@media(pointer:coarse)]:p-2.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
                title={t('Nach rechts scrollen')}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Physical Shelf Container */}
      <div className="relative bg-slate-950/70 p-4 sm:p-6 rounded-2xl border border-slate-800/80 shadow-2xl">
        {/* MODE 1: AUTO-FIT — Single responsive row (few items) OR multi-row (many items) */}
        {shelfMode === 'fit' && (
          isFitMultiRow ? (
            /* Auto-multi-row: too many books for single row → display as balanced rows */
            <div ref={shelfMeasureRef} className="space-y-5 pt-2 pb-2 px-1">
              <div className="text-[10px] text-slate-400 mb-1 flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-slate-500" />
                {tn('Auto-Fit: {n} Reihen für {items}', 'Auto-Fit: {n} Reihen für {items}', shelfRows.length, { items: tn('{n} Einträge', '{n} Einträge', spineShelfItems.length) })}
              </div>
              {shelfRows.map((row, rIdx) => (
                <div key={rIdx} className="relative">
                  <div className="flex items-end gap-1 sm:gap-1.5 w-full pb-1">
                    {row.map((item, idx) => renderShelfSpine(item, idx, 'fit'))}
                  </div>
                  <div className="shelf-plank w-full mt-[-2px]" />
                </div>
              ))}
            </div>
          ) : (
            /* Single-row auto-fit: few items, stretch to fill width */
            <div ref={shelfMeasureRef} className="pb-2 pt-2 px-1">
              <div className="flex items-end gap-1 sm:gap-1.5 w-full justify-between pb-1">
                {spineShelfItems.map((item, idx) => renderShelfSpine(item, idx, 'fit'))}
              </div>
              <div className="shelf-plank w-full mt-[-2px]" />
            </div>
          )
        )}

        {/* MODE 2: REGALBRETTER (Multi-tier bookcase shelves) */}
        {shelfMode === 'rows' && (
          <div ref={shelfMeasureRef} className="space-y-5 pt-2 pb-2 px-1">
            {shelfRows.map((row, rIdx) => (
              <div key={rIdx} className="relative">
                <div className="flex items-end gap-1 sm:gap-1.5 w-full pb-1">
                  {row.map((item, idx) => renderShelfSpine(item, idx, 'rows'))}
                </div>
                <div className="shelf-plank w-full mt-[-2px]" />
              </div>
            ))}
          </div>
        )}

        {/* MODE 3: SCROLL (Classic horizontal single-row with scrollbar) */}
        {shelfMode === 'scroll' && (
          <div 
            ref={shelfScrollRef}
            className="overflow-x-auto pb-2 pt-4 px-2 custom-scrollbar scroll-smooth"
          >
            <div className="flex items-end gap-1.5 sm:gap-2 min-w-max px-2 pb-1">
              {spineShelfItems.map((item, idx) => renderShelfSpine(item, idx, 'scroll'))}
            </div>
            <div className="shelf-plank w-full mt-[-2px]" />
          </div>
        )}
      </div>
    </div>
  );
}
