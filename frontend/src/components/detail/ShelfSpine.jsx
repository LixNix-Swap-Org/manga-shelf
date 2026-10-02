import { Package } from 'lucide-react';
import { getVolumeDisplayTitle, getEditionLabel, getSpecialEditionNumber, getSpinePublisherTheme, hasUserRead } from '../../utils/volumeHelpers';

/** One book spine (or a ghost spine for a gap) on the shelf. Layout depends on the shelf mode and scale. */
export default function ShelfSpine({
  item, currentMode, isFitMultiRow, totalCount, shelfScale, mpGapMap, canEdit, setFillingGapNumber,
  selectedReaderId, user, manga, focusedVolumeId, setFocusedVolumeId, handleOpenEditVolume
}) {
  const isFitSingleRow = currentMode === 'fit' && !isFitMultiRow;
  const isScrollFixed = currentMode === 'scroll';
  const isFlexFill = !isFitSingleRow && !isScrollFixed; // rows mode or fit-multirow

  const isVeryCompact = isFitSingleRow && totalCount > 24;
  const isUltraCompact = isFitSingleRow && totalCount > 34;

  // Proportional spine height based on scale + mode:
  let spineHeightPx;
  if (shelfScale === 's') {
    spineHeightPx = isFitSingleRow && isUltraCompact ? '150px' : '170px';
  } else if (shelfScale === 'l') {
    spineHeightPx = isFitSingleRow ? (isUltraCompact ? '210px' : '260px') : '240px';
  } else {
    spineHeightPx = isFitSingleRow ? (isUltraCompact ? '175px' : isVeryCompact ? '195px' : '220px') : '210px';
  }

  if (item.isGap) {
    const gapMeta = item.gapMeta || mpGapMap.get(String(item.gapNumber).toLowerCase());
    // Width class depends on layout mode:
    // KEY MATH: max-width must satisfy (targetPerRow × max-width > ~950px container)
    //   so flex-1 is forced to shrink items in full rows → row fills entire width.
    //   For partial rows (few items), max-width caps growth → books look normal.
    let ghostWidthClass;
    if (isFitSingleRow) {
      ghostWidthClass = 'flex-1 min-w-[18px] max-w-[56px]';
    } else if (isScrollFixed) {
      ghostWidthClass = shelfScale === 's' ? 'w-[36px]' : shelfScale === 'l' ? 'w-[56px]' : 'w-[46px]';
    } else {
      // Rows / fit-multirow: flex-1 with generous max-width
      // S(20/row): 20×56=1120>950 ✓  M(16/row): 16×70=1120>950 ✓  L(12/row): 12×92=1104>950 ✓
      ghostWidthClass = shelfScale === 's' ? 'flex-1 min-w-[20px] max-w-[56px]'
        : shelfScale === 'l' ? 'flex-1 min-w-[20px] max-w-[92px]'
        : 'flex-1 min-w-[20px] max-w-[70px]';
    }

    return (
      <div
        onClick={() => canEdit && setFillingGapNumber(item.gapNumber)}
        style={{ height: spineHeightPx, '--spine-height': spineHeightPx }}
        className={`manga-spine-ghost relative group ${ghostWidthClass} flex flex-col justify-between items-center py-2 sm:py-2.5 px-0.5 text-center ${isFlexFill ? '' : 'shrink-0'} rounded-lg overflow-hidden border border-dashed transition-all ${
          canEdit ? 'cursor-pointer hover:border-amber-400 hover:scale-[1.03]' : 'cursor-default'
        } border-amber-500/40 bg-slate-900/60 backdrop-blur-sm`}
        title={gapMeta?.price ? `Lücke: Band ${item.gapNumber} (${gapMeta.price.toFixed(2).replace('.', ',')} €${gapMeta.release_date ? ' • ' + gapMeta.release_date : ''}). Klicken zum Erfassen!` : `Lücke: Band ${item.gapNumber} fehlt.`}
      >
        {gapMeta?.cover_image && (
          <div 
            className="absolute inset-0 bg-cover bg-center opacity-25 group-hover:opacity-40 transition-opacity pointer-events-none"
            style={{ backgroundImage: `url(${gapMeta.cover_image})` }}
          />
        )}
        <div className={`relative z-10 font-bold text-amber-400/90 flex items-center justify-center rounded-full bg-amber-500/20 border border-amber-500/40 ${
          isUltraCompact ? 'w-4 h-4 text-[9px]' : 'w-5 h-5 text-[10px]'
        }`}>
          +
        </div>
        <div className="relative z-10 flex flex-col items-center">
          {!isUltraCompact && (
            <span className="text-[10px] font-black text-amber-300/80 tracking-tight leading-none mb-0.5">Band</span>
          )}
          <span className={`${isUltraCompact ? 'text-xs sm:text-sm' : isVeryCompact ? 'text-sm' : 'text-base'} font-black text-amber-400 leading-tight drop-shadow`}>
            {item.gapNumber}
          </span>
          {gapMeta?.price && !isUltraCompact && (
            <span className="text-[8px] sm:text-[9px] font-mono font-bold text-amber-300/90 mt-0.5 truncate max-w-full">
              {gapMeta.price.toFixed(2).replace('.', ',')} €
            </span>
          )}
        </div>
        <div className={`relative z-10 uppercase tracking-wider text-amber-400/90 bg-amber-500/20 px-0.5 sm:px-1 py-0.5 rounded border border-amber-500/30 truncate max-w-full ${
          isUltraCompact ? 'text-[7px] leading-none' : 'text-[8px] font-bold'
        }`}>
          Lücke
        </div>
      </div>
    );
  }

  const vol = item.volume;
  const isOwned = vol.status === 'Vorhanden';
  const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
  const isRead = hasUserRead(vol, effUserId, user?.id);

  const theme = getSpinePublisherTheme(vol.publisher || manga.publisher);
  const isSchuber = vol.type === 'schuber' || String(vol.volume_number).toLowerCase().includes('schuber');
  const isSpecialEd = vol.type === 'special_edition' || (
    vol.type !== 'schuber' && (
      String(vol.volume_number).toLowerCase().includes('special edition') ||
      String(vol.volume_number).toLowerCase().includes('limited edition') ||
      String(vol.volume_number).toLowerCase().includes('spezial edition') ||
      (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition')))
    )
  );
  const isSpecial = vol.type === 'special' || String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra');

  // Page-count realistic spine thickness factor (Standard manga ~192p = 1.0, Double-vol ~380p = 1.5)
  const pageFactor = (vol.pages && Number(vol.pages) > 40)
    ? Math.max(0.85, Math.min(1.75, Number(vol.pages) / 192))
    : 1.0;

  let spineWidth = '';
  let customWidthStyle = {};
  if (isFitSingleRow) {
    // Single-row auto-fit: flex-1 WITH max-width to prevent overflow on one line
    spineWidth = isSchuber ? 'flex-[1.8] min-w-[32px] max-w-[95px]' : isSpecialEd ? 'flex-[1.2] min-w-[24px] max-w-[65px]' : 'flex-1 min-w-[18px] max-w-[56px]';
  } else if (isScrollFixed) {
    // Scroll mode: fixed pixel widths for predictable horizontal scrolling with page factor
    const isS = shelfScale === 's';
    const isL = shelfScale === 'l';
    const baseW = isSchuber ? (isS ? 68 : isL ? 100 : 84) : isSpecialEd ? (isS ? 42 : isL ? 62 : 52) : (isS ? 36 : isL ? 56 : 46);
    const calculatedW = Math.round(baseW * pageFactor);
    customWidthStyle = { width: `${calculatedW}px` };
  } else {
    // Rows / fit-multirow: flex-1 with CALCULATED max-width
    const isS = shelfScale === 's';
    const isL = shelfScale === 'l';
    if (isSchuber) {
      spineWidth = isS ? 'flex-[1.8] min-w-[36px] max-w-[100px]' : isL ? 'flex-[1.8] min-w-[50px] max-w-[165px]' : 'flex-[1.8] min-w-[40px] max-w-[126px]';
    } else if (isSpecialEd) {
      spineWidth = isS ? 'flex-[1.2] min-w-[24px] max-w-[67px]' : isL ? 'flex-[1.2] min-w-[30px] max-w-[110px]' : 'flex-[1.2] min-w-[26px] max-w-[84px]';
    } else {
      spineWidth = isS ? 'flex-1 min-w-[20px] max-w-[56px]' : isL ? 'flex-1 min-w-[26px] max-w-[92px]' : 'flex-1 min-w-[22px] max-w-[70px]';
    }
  }

  // In flex-fill modes, don't use shrink-0 so flex distributes space properly
  const shrinkClass = isFlexFill ? '' : 'shrink-0';
  const isFocused = vol.id === focusedVolumeId;

  return (
    <div
      onClick={() => {
        setFocusedVolumeId(vol.id);
        if (canEdit) handleOpenEditVolume(vol);
      }}
      style={{ 
        height: spineHeightPx, 
        '--spine-height': spineHeightPx,
        ...customWidthStyle,
        ...(isFlexFill ? { flexGrow: (isSchuber ? 1.8 : isSpecialEd ? 1.25 : 1.0) * pageFactor } : {})
      }}
      className={`manga-spine ${isSpecialEd ? 'manga-spine-special' : ''} ${isSchuber ? 'manga-spine-box' : ''} ${spineWidth} bg-gradient-to-b ${theme.bg} ${theme.border} ${shrinkClass} flex flex-col justify-between items-center py-2 sm:py-2.5 px-0.5 sm:px-1 relative transition-all duration-200 ${
        isFocused ? 'ring-2 ring-brand-400 ring-offset-2 ring-offset-slate-950 scale-[1.04] z-20 shadow-xl shadow-brand-500/30' : ''
      } ${canEdit ? 'cursor-pointer' : 'cursor-default'} ${!isOwned ? 'opacity-70 saturate-50 hover:opacity-100 hover:saturate-100' : ''}`}
      title={`${getVolumeDisplayTitle(vol)}${vol.publisher ? ` • ${vol.publisher}` : ''}${vol.price ? ` • ${vol.price}€` : ''}${isRead ? ' • Gelesen ✓' : ''}`}
    >
      {/* Spine Top: Publisher Logo / Accent */}
      <div className="w-full flex justify-center shrink-0">
        <span className={`px-0.5 sm:px-1 py-0.5 rounded truncate max-w-full leading-tight text-center ${
          isUltraCompact ? 'text-[7px] max-w-[32px]' : 'text-[8px] sm:text-[9px] max-w-[42px] sm:max-w-[48px]'
        } ${theme.accentBadge}`}>
          {theme.accentName}
        </span>
      </div>

      {/* Spine Center: Vertical Manga Title */}
      <div className="flex-1 flex items-center justify-center my-1 overflow-hidden pointer-events-none w-full">
        <span className={`spine-vertical-text font-bold select-none truncate ${
          isUltraCompact ? 'text-[8px] sm:text-[9px] max-h-[70px]' : isVeryCompact ? 'text-[9px] sm:text-[10px] max-h-[85px]' : 'text-[11px] sm:text-xs tracking-wider max-h-[110px]'
        } ${theme.text} opacity-90 drop-shadow-sm`}>
          {manga.title}
        </span>
      </div>

      {/* Spine Bottom: Volume Number & Status Badges */}
      <div className="w-full flex flex-col items-center gap-0.5 sm:gap-1 shrink-0 pt-1 border-t border-white/10">
        {isSchuber ? (
          <div className="text-[9px] sm:text-[10px] font-black text-indigo-300 flex items-center gap-0.5 bg-indigo-950/60 px-1 py-0.5 rounded border border-indigo-500/30 truncate max-w-full">
            <Package className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
            <span className="truncate">{String(vol.volume_number).replace(/^schuber\s*/i, '')}</span>
          </div>
        ) : isSpecialEd ? (
          <div className="flex flex-col items-center">
            <span className="text-xs sm:text-sm font-black text-fuchsia-300 drop-shadow">
              {getSpecialEditionNumber(vol) || getEditionLabel(vol).short}
            </span>
            <span className="text-[7px] sm:text-[8px] font-bold text-fuchsia-300 bg-fuchsia-950/70 px-0.5 sm:px-1 rounded border border-fuchsia-500/40" title={getEditionLabel(vol).label}>
              {getEditionLabel(vol).short}
            </span>
          </div>
        ) : isSpecial ? (
          <div className="flex flex-col items-center">
            <span className="text-xs sm:text-sm font-black text-amber-300 drop-shadow">
              {String(vol.volume_number).replace(/special\s*|extra\s*/gi, '').trim() || 'SP'}
            </span>
            <span className="text-[7px] sm:text-[8px] font-bold text-amber-300 bg-amber-950/70 px-0.5 sm:px-1 rounded border border-amber-500/40">
              EXTRA
            </span>
          </div>
        ) : (
          <span className={`${
            isUltraCompact ? 'text-xs sm:text-sm' : isVeryCompact ? 'text-sm sm:text-base' : 'text-base sm:text-lg'
          } font-black text-white tracking-tight leading-none drop-shadow`}>
            {vol.volume_number}
          </span>
        )}

        {/* Status Badges Row (Owned / Read) */}
        <div className="flex items-center gap-1 mt-0.5">
          {/* Read Checkmark */}
          {isOwned && isRead && (
            <span className={`${isUltraCompact ? 'w-3 h-3 text-[7px]' : 'w-3.5 h-3.5 text-[8px]'} rounded-full bg-emerald-500/25 border border-emerald-400 text-emerald-300 flex items-center justify-center font-bold`} title="Gelesen">
              ✓
            </span>
          )}
          {/* Status Badge */}
          {vol.status === 'Vorbestellt' ? (
            <span className="text-[7px] sm:text-[8px] font-extrabold bg-sky-500 text-slate-950 px-0.5 sm:px-1 rounded-sm shadow-sm" title="Vorbestellt">
              BESTELLT
            </span>
          ) : vol.status === 'Erscheint bald' ? (
            <span className="text-[7px] sm:text-[8px] font-extrabold bg-purple-500 text-slate-950 px-0.5 sm:px-1 rounded-sm shadow-sm" title="Erscheint bald">
              BALD
            </span>
          ) : !isOwned ? (
            <span className="text-[7px] sm:text-[8px] font-extrabold bg-amber-500 text-slate-950 px-0.5 sm:px-1 rounded-sm" title="Fehlt in der Sammlung">
              FEHLT
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
