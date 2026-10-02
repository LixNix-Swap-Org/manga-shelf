import { AlertCircle, BookCheck, BookOpen, Building2, Calendar, Camera, Check, Coins, Edit3, FileText, Package, Plus, Sparkles, Truck, X } from 'lucide-react';
import { getVolumeDisplayTitle, getEditionLabel, getSpecialEditionNumber } from '../../utils/volumeHelpers';

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
  user
}) {
  return (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[1800px]:grid-cols-7 gap-3 sm:gap-3.5 mb-8">
          {displayVolumeItems.map((item, itemIdx) => {
            if (item.isGap) {
              const gapMeta = item.gapMeta || mpGapMap.get(String(item.gapNumber).toLowerCase());
              return (
                <div 
                  key={`gap-card-${item.gapNumber}-${itemIdx}`}
                  onClick={() => canEdit && setFillingGapNumber(item.gapNumber)}
                  className={`group relative flex flex-col justify-between p-3 rounded-2xl border border-dashed border-amber-500/40 hover:border-amber-400 bg-slate-900/60 hover:bg-slate-900/90 text-sm select-none shadow-sm shadow-amber-950/20 transition-all duration-200 overflow-hidden ${
                    canEdit ? 'cursor-pointer hover:scale-[1.01]' : 'cursor-default'
                  }`}
                  title={gapMeta?.price ? `Fehlender Band ${item.gapNumber} (${gapMeta.price.toFixed(2).replace('.', ',')} €) • Klicken zum schnellen Erfassen` : `Fehlender Band ${item.gapNumber} fehlt in der Sammlung • Klicken zum Erfassen`}
                >
                  {/* Top Row: Gap Indicator & Number & Action */}
                  <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-amber-500/20 w-full shrink-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="w-5 h-5 rounded-lg flex items-center justify-center shrink-0 bg-amber-500/20 border border-amber-500/50 text-amber-400 font-bold text-xs">
                        +
                      </div>
                      <div className="font-bold text-amber-300 text-sm tracking-tight flex items-center gap-1.5 min-w-0">
                        <span className="truncate">Band {item.gapNumber}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 shrink-0 shadow-xs">
                          <Sparkles className="w-2.5 h-2.5 text-amber-400" /> Fehlend
                        </span>
                      </div>
                    </div>

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

                  {/* Middle: Cover Ghost / Official Image & Metadata */}
                  <div className="flex gap-2.5 items-start flex-1 py-2.5 min-w-0">
                    {gapMeta?.cover_image ? (
                      <div className="relative shrink-0 rounded-xl overflow-hidden shadow-md border border-amber-500/40 bg-slate-950 w-12 h-16 sm:w-13 sm:h-18 group-hover:scale-105 transition-transform duration-200">
                        <img 
                          src={gapMeta.cover_image} 
                          alt={`Band ${item.gapNumber}`}
                          className="w-full h-full object-cover opacity-60 group-hover:opacity-85 transition-opacity"
                          loading="lazy"
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
                        <AlertCircle className="w-3 h-3 text-amber-400" />
                        Lücke in Reihe
                      </span>

                      {gapMeta?.price !== undefined && gapMeta?.price !== null && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30 text-[10px]">
                          <Coins className="w-3 h-3 text-emerald-400" />
                          {gapMeta.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                        </span>
                      )}

                      {(gapMeta?.publisher || manga.publisher) && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 truncate max-w-[110px]" title={`Verlag: ${gapMeta?.publisher || manga.publisher}`}>
                          <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                          <span className="truncate">{gapMeta?.publisher || manga.publisher}</span>
                        </span>
                      )}

                      {gapMeta?.release_date && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 text-[10px]" title={`Erscheinungsdatum: ${gapMeta.release_date}`}>
                          <Calendar className="w-3 h-3 text-sky-400" />
                          {gapMeta.release_date}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bottom Row: Quick Add Prompt */}
                  <div className="w-full mt-auto pt-2 border-t border-amber-500/20 flex items-center justify-between gap-1.5 shrink-0 text-xs">
                    <span className="text-slate-400 text-[11px] flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
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
            const isOwned = vol.status === 'Vorhanden';
        const effectivePublisher = (vol.publisher && vol.publisher.trim()) || (manga.publisher && manga.publisher.trim());
        const hasCover = Boolean(vol.cover_image);

        return (
          <div 
            key={vol.id}
            onClick={() => canEdit && handleOpenEditVolume(vol)}
            className={`group relative flex flex-col justify-between p-3 rounded-2xl border text-sm select-none shadow-sm transition-all duration-200 overflow-hidden ${
              canEdit 
                ? 'cursor-pointer' 
                : 'cursor-default'
            } ${
              isOwned 
                ? 'bg-slate-900/90 border-emerald-500/40 text-slate-100 shadow-emerald-950/20' + (canEdit ? ' hover:border-emerald-400 hover:bg-slate-850' : '') 
                : vol.status === 'Vorbestellt'
                  ? 'bg-sky-950/30 border-sky-500/40 text-slate-100 shadow-sky-950/20' + (canEdit ? ' hover:border-sky-400 hover:bg-sky-900/30' : '')
                  : vol.status === 'Erscheint bald'
                    ? 'bg-purple-950/30 border-purple-500/40 text-slate-100 shadow-purple-950/20' + (canEdit ? ' hover:border-purple-400 hover:bg-purple-900/30' : '')
                    : 'bg-slate-950/70 border-slate-800 text-slate-400' + (canEdit ? ' hover:border-slate-700 hover:text-slate-200' : '')
            }`}
          >
            {/* Top Row: Checkmark / Status + Volume Number + Actions (Full width across card) */}
            <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-slate-800/70 w-full shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canEdit) handleToggleVolume(vol);
                  }}
                  className={`w-5 h-5 rounded-lg flex items-center justify-center transition-all shrink-0 ${
                    !canEdit ? 'cursor-default' : 'cursor-pointer'
                  } ${
                    isOwned 
                      ? 'bg-emerald-500/20 border border-emerald-500/60 text-emerald-400' + (canEdit ? ' hover:bg-emerald-500/30' : '') 
                      : vol.status === 'Vorbestellt'
                        ? 'bg-sky-500/20 border border-sky-500/60 text-sky-400' + (canEdit ? ' hover:bg-sky-500/30' : '')
                        : vol.status === 'Erscheint bald'
                          ? 'bg-purple-500/20 border border-purple-500/60 text-purple-400' + (canEdit ? ' hover:bg-purple-500/30' : '')
                          : 'bg-slate-800/80 border border-slate-700 text-slate-500' + (canEdit ? ' hover:border-slate-500 hover:text-slate-300' : '')
                  }`}
                  title={!canEdit ? `Status: ${vol.status || 'Fehlt'}` : `Status: ${vol.status || 'Fehlt'} (Klicken zum Umschalten)`}
                >
                  {isOwned ? (
                    <Check className="w-3 h-3 stroke-[2.5]" />
                  ) : vol.status === 'Vorbestellt' ? (
                    <Truck className="w-3 h-3" />
                  ) : vol.status === 'Erscheint bald' ? (
                    <Calendar className="w-3 h-3" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                  )}
                </button>
                <div 
                  className="font-bold text-white text-sm tracking-tight flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0"
                  title={getVolumeDisplayTitle(vol)}
                >
                  {vol.type === 'schuber' || String(vol.volume_number).toLowerCase().includes('schuber') ? (
                    <>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                        <Package className="w-2.5 h-2.5 text-indigo-400" /> Schuber
                      </span>
                      <span className="min-w-0 break-words leading-tight">{String(vol.volume_number).replace(/^schuber\s*/i, '')}</span>
                    </>
                  ) : vol.type === 'special_edition' || (
                    vol.type !== 'schuber' && (
                      String(vol.volume_number).toLowerCase().includes('special edition') ||
                      String(vol.volume_number).toLowerCase().includes('limited edition') ||
                      String(vol.volume_number).toLowerCase().includes('spezial edition') ||
                      (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition')))
                    )
                  ) ? (
                    <>
                      <span className="shrink-0 font-bold">
                        {getSpecialEditionNumber(vol) ? `Band ${getSpecialEditionNumber(vol)}` : 'Special'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-fuchsia-500/25 text-fuchsia-300 border border-fuchsia-500/40 flex items-center gap-1 max-w-full shadow-sm" title={getEditionLabel(vol).label}>
                        <Sparkles className="w-2.5 h-2.5 text-fuchsia-400 shrink-0" /> <span className="truncate">{getEditionLabel(vol).label.replace(/ Edition$/, '')}</span>
                      </span>
                    </>
                  ) : vol.type === 'special' || String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra') ? (
                    <>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                        <Sparkles className="w-2.5 h-2.5 text-amber-400" /> Special
                      </span>
                      <span className="truncate">{String(vol.volume_number).replace(/special\s*|extra\s*|sonderband\s*/i, '')}</span>
                    </>
                  ) : (
                    <span className="truncate">{getVolumeDisplayTitle(vol)}</span>
                  )}
                </div>
              </div>

              {canEdit && (
                <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100 transition-opacity shrink-0">
                  {!hasCover && (
                    <button
                      type="button"
                      onClick={(e) => handleOpenEditVolume(vol, e)}
                      className="p-1 text-slate-500 hover:text-brand-300 hover:bg-slate-800 rounded-md transition-all"
                      title="Foto für Band hochladen"
                    >
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => handleOpenEditVolume(vol, e)}
                    className="p-1 text-slate-400 hover:text-brand-300 hover:bg-slate-800 rounded-md transition-all"
                    title="Band-Details & Fotos bearbeiten"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleDeleteVolume(e, vol.id)}
                    className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/20 rounded-md transition-all"
                    title="Band löschen"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Middle: Harmonious Cover Thumbnail + Badges */}
            <div className="flex gap-2.5 items-start flex-1 py-2.5 min-w-0">
              {hasCover && (
                <div 
                  className="relative shrink-0 group/cover rounded-xl overflow-hidden shadow-md border border-slate-700/80 bg-slate-950 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    openVolumeGallery(vol);
                  }}
                  title="Klicken zum Öffnen der Fotogalerie"
                >
                  <img 
                    src={vol.cover_image} 
                    alt={getVolumeDisplayTitle(vol)} 
                    className="w-12 h-16 sm:w-13 sm:h-18 object-cover group-hover/cover:scale-105 transition-transform duration-200" 
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150" viewBox="0 0 100 150" fill="%231e293b"><rect width="100" height="150" fill="%230f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="10" font-family="sans-serif">Kein Bild</text></svg>';
                    }}
                  />
                  {vol.images && vol.images.length > 1 && (
                    <span className="absolute bottom-1 right-1 bg-black/85 text-brand-300 font-mono text-[9px] px-1.5 py-0.5 rounded-md font-bold shadow flex items-center gap-1 border border-brand-500/30 backdrop-blur-xs">
                      <Camera className="w-2.5 h-2.5 text-brand-400" />
                      {vol.images.length}
                    </span>
                  )}
                </div>
              )}

              <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-[11px]">
                {vol.status === 'Vorbestellt' ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-sky-300 bg-sky-950/70 border border-sky-500/40 text-[10px]">
                    <Truck className="w-3 h-3 text-sky-400" />
                    Vorbestellt
                  </span>
                ) : vol.status === 'Erscheint bald' ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-purple-300 bg-purple-950/70 border border-purple-500/40 text-[10px]">
                    <Calendar className="w-3 h-3 text-purple-400" />
                    Erscheint bald
                  </span>
                ) : null}

                {vol.release_date ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 text-[10px]" title={`Erscheinungsdatum: ${vol.release_date}`}>
                    <Calendar className="w-3 h-3 text-sky-400" />
                    {vol.release_date}
                  </span>
                ) : null}

                {vol.price !== null && vol.price !== undefined ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30">
                    <Coins className="w-3 h-3 text-emerald-400" />
                    {vol.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                  </span>
                ) : null}

                {effectivePublisher ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 truncate max-w-[110px]" title={`Verlag: ${effectivePublisher}`}>
                    <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
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
                    <Calendar className="w-3 h-3 text-slate-500" />
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
                  <span className="inline-flex items-center px-1 py-0.5 rounded text-slate-400 hover:text-white" title={`Notiz: ${vol.notes}`}>
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
                  const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
                  const isRead = vol.read_users 
                    ? vol.read_users.some(u => String(u.user_id || u.id) === String(effUserId)) 
                    : (Boolean(vol.is_read) && String(effUserId) === String(user?.id));
                  const canToggleStatus = canEdit;

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
                      title={!canToggleStatus ? `Lesestatus: ${isRead ? 'Gelesen' : 'Ungelesen'} (Nur Leseansicht)` : 'Lesestatus umschalten (Gelesen / Ungelesen)'}
                    >
                      <BookCheck className={`w-3.5 h-3.5 ${isRead ? 'text-emerald-400' : 'text-slate-500'}`} />
                      <span>{isRead ? 'Gelesen' : 'Ungelesen'}</span>
                    </button>
                  );
                })()}

                {/* Reader Badges: Dynamic, non-overlapping, with clear tooltip */}
                {readers.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {readers.map(r => {
                      const isReaderDone = vol.read_users 
                        ? vol.read_users.some(u => String(u.user_id || u.id) === String(r.user_id))
                        : (Boolean(vol.is_read) && String(r.user_id) === String(user?.id));
                      const initial = (r.display_name || r.username || '?').charAt(0).toUpperCase();
                      const canToggleReader = canEdit;

                      return (
                        <button
                          key={r.user_id}
                          type="button"
                          disabled={!canToggleReader}
                          onClick={(e) => {
                            if (canToggleReader) {
                              handleToggleVolumeRead(vol, r.user_id, e);
                            }
                          }}
                          className={`relative w-5 h-5 sm:w-6 sm:h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                            canToggleReader ? 'cursor-pointer hover:scale-110' : 'cursor-default'
                          } ${
                            isReaderDone
                              ? 'bg-emerald-500/25 border border-emerald-400/70 text-emerald-300 shadow-sm shadow-emerald-950/40'
                              : 'bg-slate-900 border border-slate-800 text-slate-500'
                          }`}
                          title={`${r.display_name || r.username}: ${isReaderDone ? 'Gelesen ✓' : 'Noch ungelesen'}${canToggleReader ? ' (Klicken zum Umschalten)' : ''}`}
                        >
                          <span>{initial}</span>
                          <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-slate-900 ${
                            isReaderDone ? 'bg-emerald-400' : 'bg-slate-600'
                          }`} />
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
