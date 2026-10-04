import { BookCheck, BookOpen, BuildingComplex, Calendar, Camera, Check, CircleAlert, Coins, FileText, Package, PenLine, Plus, ShoppingCart, Sparkles, Truck, X } from 'lucide-react';
import { getVolumeDisplayTitle, getRegularGapMeta, hasUserRead } from '../../utils/volumeHelpers';
import { READ_OTHERS_ADMIN_ONLY } from '../../hooks/useVolumeActions';
import OwnerBadges from './OwnerBadges';
import { formatEuro, formatShortDate, gapLabel, getVolumeBadge, volumeStatusKind } from './volumeViewHelpers';
import { assetImgProps } from '../../utils/api';

/** Card grid view of a series' volumes (incl. official gaps). Purely presentational; all state and handlers come in via props. */
export default function VolumeGridView({
  canEdit,
  displayVolumeItems,
  handleDeleteVolume,
  handleOpenEditVolume,
  handleToggleVolume,
  handleToggleVolumeRead,
  manga,
  mpGapMap,
  openVolumeGallery,
  readers,
  selectedReaderId,
  setFillingGapNumber,
  user,
  canToggleOthers,
  gapsOfficial,
  canToggle = canEdit,
  selectionMode = false,
  isSelected = () => false,
  onSelectVolume
}) {
  const mayToggleOthers = canToggleOthers ?? user?.role === 'admin';
  return (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[1800px]:grid-cols-7 gap-3 sm:gap-3.5 mb-8">
          {displayVolumeItems.map((item, itemIdx) => {
            if (item.isGap) {
              const gapMeta = item.gapMeta || getRegularGapMeta(mpGapMap, item.gapNumber);
              const gapPrice = gapMeta?.price != null ? formatEuro(gapMeta.price) : '';
              return (
                <div 
                  key={`gap-card-${item.gapNumber}-${itemIdx}`}
                  onClick={canEdit ? () => setFillingGapNumber(item.gapNumber) : undefined}
                  className={`group relative flex flex-col justify-between p-3 rounded-2xl border border-dashed border-amber-500/40 bg-slate-900/60 text-sm select-none shadow-sm shadow-amber-950/20 transition-all duration-200 overflow-hidden ${
                    canEdit ? 'cursor-pointer hover:border-amber-400 hover:bg-slate-900/90 hover:scale-[1.01]' : 'cursor-default'
                  }`}
                  title={`${gapPrice ? `Fehlender Band ${item.gapNumber} (${gapPrice})` : `Band ${item.gapNumber} fehlt in der Sammlung`}${canEdit ? ' • Klicken zum Erfassen' : ''}`}
                >
                  {/* Top Row: Gap Indicator & Number & Action */}
                  <div className="flex flex-wrap items-center justify-between gap-x-1.5 gap-y-1.5 pb-2 border-b border-amber-500/20 w-full shrink-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1 basis-24">
                      <div className="w-5 h-5 rounded-lg flex items-center justify-center shrink-0 bg-amber-500/20 border border-amber-500/50 text-amber-400 font-bold text-xs">
                        +
                      </div>
                      <span className="font-bold text-amber-300 text-sm tracking-tight min-w-0 break-words leading-tight">Band {item.gapNumber}</span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 shrink-0 shadow-xs">
                        <Sparkles className="w-2.5 h-2.5 text-amber-400" /> Fehlend
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFillingGapNumber(item.gapNumber);
                          }}
                          className="px-2 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1 transition-all shrink-0 cursor-pointer"
                          title="Band in Sammlung erfassen"
                        >
                          <Plus className="w-3 h-3" /> Erfassen
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Middle: Cover Ghost / Official Image & Metadata */}
                  <div className="flex gap-2.5 items-start flex-1 py-2.5 min-w-0">
                    {gapMeta?.cover_image ? (
                      <div className="relative shrink-0 rounded-xl overflow-hidden shadow-md border border-amber-500/40 bg-slate-950 w-12 h-16 sm:w-13 sm:h-18 group-hover:scale-105 transition-transform duration-200">
                        <img 
                          {...assetImgProps(gapMeta.cover_image)} 
                          alt=""
                          className="w-full h-full object-cover opacity-60 group-hover:opacity-85 transition-opacity"
                          loading="lazy"
                          decoding="async"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent flex items-end justify-center p-1">
                          <span className="text-[8px] font-black text-amber-300 uppercase tracking-wider">Lücke</span>
                        </div>
                      </div>
                    ) : (
                      <div className="w-12 h-16 sm:w-13 sm:h-18 rounded-xl border border-dashed border-amber-500/30 bg-amber-950/20 shrink-0 flex flex-col items-center justify-center text-amber-500/60 p-1">
                        <BookOpen className="w-4 h-4 mb-1 opacity-50" />
                        <span className="text-[9px] font-bold text-center leading-tight">Band {item.gapNumber}</span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-amber-300 bg-amber-950/60 border border-amber-500/30 text-[10px]">
                        <CircleAlert className="w-3 h-3 text-amber-400" />
                        {gapLabel(gapsOfficial)}
                      </span>

                      {gapPrice && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30 text-[10px]">
                          <Coins className="w-3 h-3 text-emerald-400" />
                          {gapPrice}
                        </span>
                      )}

                      {(gapMeta?.publisher || manga.publisher) && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 truncate max-w-[110px]" title={`Verlag: ${gapMeta?.publisher || manga.publisher}`}>
                          <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
                          <span className="truncate">{gapMeta?.publisher || manga.publisher}</span>
                        </span>
                      )}

                      {gapMeta?.release_date && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 text-[10px]" title={`Erscheinungsdatum: ${formatShortDate(gapMeta.release_date)}`}>
                          <Calendar className="w-3 h-3 text-sky-400" />
                          {formatShortDate(gapMeta.release_date)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bottom Row: Quick Add Prompt */}
                  <div className="w-full mt-auto pt-2 border-t border-amber-500/20 flex items-center justify-between gap-1.5 shrink-0 text-xs">
                    <span className="text-slate-400 text-[11px] flex items-center gap-1.5">
                      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                      {canEdit ? 'Klicken zum Erfassen' : 'Noch zu sammeln'}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFillingGapNumber(item.gapNumber);
                        }}
                        className="text-amber-400 hover:text-amber-300 font-semibold text-xs flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <span>+ Zu Sammlung</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            const vol = item.volume;
            const statusKind = volumeStatusKind(vol.status);
            const isOwned = statusKind === 'owned';
            const badge = getVolumeBadge(vol);
            const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
        const effectivePublisher = (vol.publisher && vol.publisher.trim()) || (manga.publisher && manga.publisher.trim());
        const hasCover = Boolean(vol.cover_image);
        const selected = selectionMode && isSelected(vol.id);

        return (
          <div 
            key={vol.id}
            data-volume-id={vol.id}
            onClick={(e) => {
              if (selectionMode) onSelectVolume?.(vol, e);
              else if (canEdit) handleOpenEditVolume(vol);
            }}
            className={`group relative flex flex-col justify-between p-3 rounded-2xl border text-sm select-none shadow-sm transition-all duration-200 overflow-hidden ${
              canEdit || selectionMode
                ? 'cursor-pointer' 
                : 'cursor-default'
            } ${selected ? 'ring-2 ring-brand-400 ring-offset-2 ring-offset-slate-950' : ''} ${
              isOwned 
                ? 'bg-slate-900/90 border-emerald-500/40 text-slate-100 shadow-emerald-950/20' + (canEdit ? ' hover:border-emerald-400 hover:bg-slate-850' : '') 
                : statusKind === 'preordered'
                  ? 'bg-sky-950/30 border-sky-500/40 text-slate-100 shadow-sky-950/20' + (canEdit ? ' hover:border-sky-400 hover:bg-sky-900/30' : '')
                  : statusKind === 'ordered'
                    ? 'bg-orange-950/30 border-orange-500/40 text-slate-100 shadow-orange-950/20' + (canEdit ? ' hover:border-orange-400 hover:bg-orange-900/30' : '')
                  : statusKind === 'upcoming'
                    ? 'bg-purple-950/30 border-purple-500/40 text-slate-100 shadow-purple-950/20' + (canEdit ? ' hover:border-purple-400 hover:bg-purple-900/30' : '')
                    : 'bg-slate-950/70 border-slate-800 text-slate-400' + (canEdit ? ' hover:border-slate-700 hover:text-slate-200' : '')
            }`}
          >
            {/* Top Row: Checkmark / Status + Volume Number + Actions (Full width across card) */}
            <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-slate-800/70 w-full shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={selected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onSelectVolume?.(vol, e.nativeEvent)}
                    aria-label={`${getVolumeDisplayTitle(vol)} auswählen`}
                    className="w-5 h-5 shrink-0 accent-brand-500 cursor-pointer"
                  />
                )}
                <button
                  type="button"
                  disabled={!canToggle}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canToggle) handleToggleVolume(vol);
                  }}
                  className={`relative before:absolute before:-inset-2.5 before:content-[''] w-6 h-6 rounded-lg flex items-center justify-center transition-all shrink-0 ${
                    !canToggle ? 'cursor-default' : 'cursor-pointer'
                  } ${
                    isOwned 
                      ? 'bg-emerald-500/20 border border-emerald-500/60 text-emerald-400' + (canToggle ? ' hover:bg-emerald-500/30' : '') 
                      : statusKind === 'preordered'
                        ? 'bg-sky-500/20 border border-sky-500/60 text-sky-400' + (canToggle ? ' hover:bg-sky-500/30' : '')
                        : statusKind === 'ordered'
                          ? 'bg-orange-500/20 border border-orange-500/60 text-orange-400' + (canToggle ? ' hover:bg-orange-500/30' : '')
                        : statusKind === 'upcoming'
                          ? 'bg-purple-500/20 border border-purple-500/60 text-purple-400' + (canToggle ? ' hover:bg-purple-500/30' : '')
                          : 'bg-slate-800/80 border border-slate-700 text-slate-400' + (canToggle ? ' hover:border-slate-500 hover:text-slate-300' : '')
                  }`}
                  title={!canToggle ? `Status: ${vol.status || 'Fehlt'}` : `Status: ${vol.status || 'Fehlt'} (Klicken zum Umschalten)`}
                  aria-label={`Status: ${vol.status || 'Fehlt'} – ${getVolumeDisplayTitle(vol)}`}
                >
                  {isOwned ? (
                    <Check className="w-3 h-3 stroke-[2.5]" aria-hidden="true" />
                  ) : statusKind === 'preordered' ? (
                    <Truck className="w-3 h-3" aria-hidden="true" />
                  ) : statusKind === 'ordered' ? (
                    <ShoppingCart className="w-3 h-3" aria-hidden="true" />
                  ) : statusKind === 'upcoming' ? (
                    <Calendar className="w-3 h-3" />
                  ) : (
                    <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                  )}
                </button>
                <div 
                  className="font-bold text-white text-sm tracking-tight flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0"
                  title={getVolumeDisplayTitle(vol)}
                >
                  {badge.type === 'schuber' ? (
                    <>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                        <Package className="w-2.5 h-2.5 text-indigo-400" /> Schuber
                      </span>
                      <span className="min-w-0 break-words leading-tight">{badge.text}</span>
                    </>
                  ) : badge.type === 'special_edition' ? (
                    <>
                      {badge.text && <span className="shrink-0 font-bold">{badge.text}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-fuchsia-500/25 text-fuchsia-300 border border-fuchsia-500/40 flex items-center gap-1 max-w-full shadow-sm" title={badge.label}>
                        <Sparkles className="w-2.5 h-2.5 text-fuchsia-400 shrink-0" /> <span className="truncate">{badge.label.replace(/ Edition$/, '')}</span>
                      </span>
                    </>
                  ) : badge.type === 'special' ? (
                    <>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                        <Sparkles className="w-2.5 h-2.5 text-amber-400" /> Special
                      </span>
                      <span className="truncate">{badge.text}</span>
                    </>
                  ) : (
                    <span className="truncate">{badge.text}</span>
                  )}
                  <OwnerBadges vol={vol} multiUser={readers.length > 1} />
                </div>
              </div>

              {canEdit && !selectionMode && (
                <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity shrink-0">
                  {!hasCover && (
                    <button
                      type="button"
                      onClick={(e) => handleOpenEditVolume(vol, e)}
                      className={`p-1.5 text-slate-400 hover:text-brand-300 hover:bg-slate-800 rounded-md transition-all`}
                      title="Foto für Band hochladen"
                      aria-label="Foto für Band hochladen"
                    >
                      <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => handleOpenEditVolume(vol, e)}
                    className={`p-1.5 text-slate-400 hover:text-brand-300 hover:bg-slate-800 rounded-md transition-all`}
                    title="Band-Details & Fotos bearbeiten"
                    aria-label="Band-Details & Fotos bearbeiten"
                  >
                    <PenLine className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDeleteVolume(e, vol)}
                    className={`ml-1.5 p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/20 rounded-md transition-all`}
                    title="Band löschen"
                    aria-label="Band löschen"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            {/* Middle: Harmonious Cover Thumbnail + Badges */}
            <div className="flex gap-2.5 items-start flex-1 py-2.5 min-w-0">
              {hasCover && (
                <button
                  type="button"
                  className="relative shrink-0 group/cover rounded-xl overflow-hidden shadow-md border border-slate-700/80 bg-slate-950 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    openVolumeGallery(vol);
                  }}
                  title="Klicken zum Öffnen der Fotogalerie"
                  aria-label={`Fotogalerie öffnen: ${getVolumeDisplayTitle(vol)}`}
                >
                  <img 
                    {...assetImgProps(vol.cover_image)} 
                    alt="" 
                    className="w-12 h-16 sm:w-13 sm:h-18 object-cover group-hover/cover:scale-105 transition-transform duration-200" 
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150" viewBox="0 0 100 150" fill="%231e293b"><rect width="100" height="150" fill="%230f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="10" font-family="sans-serif">Kein Bild</text></svg>';
                    }}
                  />
                  {vol.images && vol.images.length > 1 && (
                    <span aria-hidden="true" className="absolute bottom-1 right-1 bg-black/85 text-brand-300 font-mono text-[9px] px-1.5 py-0.5 rounded-md font-bold shadow flex items-center gap-1 border border-brand-500/30">
                      <Camera className="w-2.5 h-2.5 text-brand-400" />
                      {vol.images.length}
                    </span>
                  )}
                </button>
              )}

              <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-[11px]">
                {statusKind === 'preordered' ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-sky-300 bg-sky-950/70 border border-sky-500/40 text-[10px]">
                    <Truck className="w-3 h-3 text-sky-400" />
                    Vorbestellt
                  </span>
                ) : statusKind === 'ordered' ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-orange-300 bg-orange-950/70 border border-orange-500/40 text-[10px]">
                    <ShoppingCart className="w-3 h-3 text-orange-400" />
                    Bestellt
                  </span>
                ) : statusKind === 'upcoming' ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-purple-300 bg-purple-950/70 border border-purple-500/40 text-[10px]">
                    <Calendar className="w-3 h-3 text-purple-400" />
                    Erscheint bald
                  </span>
                ) : null}

                {vol.release_date ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 text-[10px]" title={`Erscheinungsdatum: ${formatShortDate(vol.release_date)}`}>
                    <Calendar className="w-3 h-3 text-sky-400" />
                    {formatShortDate(vol.release_date)}
                  </span>
                ) : null}

                {formatEuro(vol.price) ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30">
                    <Coins className="w-3 h-3 text-emerald-400" />
                    {formatEuro(vol.price)}
                  </span>
                ) : null}

                {effectivePublisher ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 truncate max-w-[110px]" title={`Verlag: ${effectivePublisher}`}>
                    <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
                    <span className="truncate">{effectivePublisher}</span>
                  </span>
                ) : null}

                {vol.condition ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-amber-300 bg-amber-950/50 border border-amber-500/30 truncate" title={`Zustand: ${vol.condition}`}>
                    {vol.condition}
                  </span>
                ) : null}

                {vol.release_year ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-slate-400 bg-slate-900 border border-slate-800 font-mono" title={`Erscheinungsjahr: ${vol.release_year}`}>
                    <Calendar className="w-3 h-3 text-slate-400" />
                    {vol.release_year}
                  </span>
                ) : null}

                {vol.pages ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-slate-400 bg-slate-900 border border-slate-800 text-[10px]" title={`${vol.pages} Seiten`}>
                    {vol.pages} S.
                  </span>
                ) : null}

                {vol.isbn ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-sky-400 bg-sky-950/40 border border-sky-500/20 font-mono text-[10px]" title={`ISBN: ${vol.isbn}`}>
                    ISBN
                  </span>
                ) : null}

                {vol.notes ? (
                  <span role="img" aria-label={`Notiz: ${vol.notes}`} className="inline-flex items-center px-1 py-0.5 rounded text-slate-400 hover:text-white" title={`Notiz: ${vol.notes}`}>
                    <FileText className="w-3 h-3 text-brand-400" />
                  </span>
                ) : null}

                {vol.images && vol.images.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openVolumeGallery(vol); }}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-brand-300 bg-brand-950/60 border border-brand-500/30 text-[10px] hover:bg-brand-900/80 transition-colors font-medium cursor-pointer"
                    title="Fotogalerie öffnen"
                  >
                    <Camera className="w-3 h-3 text-brand-400" />
                    <span>{vol.images.length} Fotos</span>
                  </button>
                )}
              </div>
            </div>

            {/* Bottom Row: Reading Status & Non-overlapping Multi-User Markers */}
            {isOwned && (
              <div className="w-full mt-auto pt-2 border-t border-slate-800/80 flex items-center justify-between gap-1.5 shrink-0">
                {(() => {
                  const isRead = hasUserRead(vol, effUserId, user?.id);
                  const canToggleStatus = canToggle && (mayToggleOthers || String(effUserId) === String(user?.id));

                  return (
                    <button
                      type="button"
                      disabled={!canToggleStatus}
                      onClick={(e) => {
                        if (canToggleStatus) handleToggleVolumeRead(vol, effUserId, e);
                      }}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-semibold transition-all shrink-0 ${
                        !canToggleStatus ? 'cursor-default opacity-80' : 'cursor-pointer'
                      } ${
                        isRead
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' + (canToggleStatus ? ' hover:bg-emerald-500/30' : '')
                          : 'bg-slate-800/60 text-slate-400 border border-slate-700/60' + (canToggleStatus ? ' hover:text-slate-200 hover:border-slate-600' : '')
                      }`}
                      title={canToggleStatus
                        ? 'Lesestatus umschalten (Gelesen / Ungelesen)'
                        : canToggle ? READ_OTHERS_ADMIN_ONLY : `Lesestatus: ${isRead ? 'Gelesen' : 'Ungelesen'} (Nur Leseansicht)`}
                    >
                      <BookCheck className={`w-3.5 h-3.5 ${isRead ? 'text-emerald-400' : 'text-slate-400'}`} aria-hidden="true" />
                      <span>{isRead ? 'Gelesen' : 'Ungelesen'}</span>
                    </button>
                  );
                })()}

                {readers.length > 0 && (
                  <div role="group" aria-label="Lesestatus der Leser" className="flex items-center gap-1 flex-wrap justify-end">
                    {readers.map(r => {
                      const isReaderDone = hasUserRead(vol, r.user_id, user?.id);
                      const name = r.display_name || r.username || 'Unbekannt';
                      const initial = name.charAt(0).toUpperCase();
                      const canToggleReader = canToggle && (mayToggleOthers || String(r.user_id) === String(user?.id));
                      const stateText = isReaderDone ? 'gelesen' : 'ungelesen';
                      const look = `relative w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                        isReaderDone
                          ? 'bg-emerald-500/25 border border-emerald-400/70 text-emerald-300 shadow-sm shadow-emerald-950/40'
                          : 'bg-slate-900 border border-slate-800 text-slate-400'
                      }`;
                      const content = (
                        <>
                          <span aria-hidden="true">{initial}</span>
                          {isReaderDone ? (
                            <span aria-hidden="true" className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-emerald-400 border border-slate-900 flex items-center justify-center">
                              <Check className="w-2 h-2 text-slate-950 stroke-[3]" />
                            </span>
                          ) : (
                            <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-slate-500 bg-slate-900" />
                          )}
                        </>
                      );

                      if (!canToggleReader) {
                        return (
                          <span key={r.user_id} role="img" aria-label={`${name}: ${stateText}`} title={`${name}: ${isReaderDone ? 'Gelesen' : 'Noch ungelesen'}`} className={`${look} cursor-default`}>
                            {content}
                          </span>
                        );
                      }
                      return (
                        <button
                          key={r.user_id}
                          type="button"
                          aria-pressed={isReaderDone}
                          aria-label={`Gelesen: ${name}`}
                          onClick={(e) => handleToggleVolumeRead(vol, r.user_id, e)}
                          className={`${look} cursor-pointer hover:scale-110`}
                          title={`${name}: ${isReaderDone ? 'Gelesen' : 'Noch ungelesen'} (Klicken zum Umschalten)`}
                        >
                          {content}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
