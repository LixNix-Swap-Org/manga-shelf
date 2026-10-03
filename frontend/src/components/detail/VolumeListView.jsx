import { Plus, Truck, Calendar, BookCheck, Edit3, Trash2 } from 'lucide-react';
import { getVolumeDisplayTitle } from '../../utils/volumeHelpers';

/** Compact table view of a series' volumes (incl. official gaps). Purely presentational. */
export default function VolumeListView({
  displayVolumeItems,
  mpGapMap,
  manga,
  user,
  canEdit,
  selectedReaderId,
  setFillingGapNumber,
  openVolumeGallery,
  handleToggleVolume,
  handleToggleVolumeRead,
  handleOpenEditVolume,
  handleDeleteVolume
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-800/80 bg-slate-950/60 shadow-xl mb-8 custom-scrollbar">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-800/90 bg-slate-900/80 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
            <th className="py-3 px-3 w-12 text-center">Cover</th>
            <th className="py-3 px-3">Band / Titel</th>
            <th className="py-3 px-3">Typ</th>
            <th className="py-3 px-3">Status</th>
            <th className="py-3 px-3">Lesestatus</th>
            <th className="py-3 px-3">Verlag</th>
            <th className="py-3 px-3">Preis</th>
            <th className="py-3 px-3">Zustand</th>
            <th className="py-3 px-3 text-right">Aktionen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60 text-slate-300">
          {displayVolumeItems.map((item, idx) => {
            if (item.isGap) {
              const gapMeta = item.gapMeta || mpGapMap.get(String(item.gapNumber).toLowerCase());
              return (
                <tr 
                  key={`table-gap-${item.gapNumber}-${idx}`}
                  className="border-b border-amber-500/20 hover:bg-amber-950/20 transition-colors bg-amber-950/10 cursor-pointer"
                  onClick={() => canEdit && setFillingGapNumber(item.gapNumber)}
                >
                  <td className="py-2 px-3 text-center">
                    {gapMeta?.cover_image ? (
                      <div className="w-8 h-12 rounded overflow-hidden shadow mx-auto border border-amber-500/40 relative">
                        <img src={gapMeta.cover_image} alt="" className="w-full h-full object-cover opacity-60" />
                      </div>
                    ) : (
                      <div className="w-8 h-12 rounded bg-amber-950/30 border border-dashed border-amber-500/40 flex items-center justify-center mx-auto text-amber-400 text-xs font-bold">
                        +
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-3 font-bold text-amber-300 text-sm">
                    Band {item.gapNumber}
                    <span className="block text-[10px] text-amber-400/80 font-normal">
                      Offizielle Lücke in Reihe
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      Lücke
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (canEdit) setFillingGapNumber(item.gapNumber);
                      }}
                      className="px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 cursor-pointer"
                      title="Band erfassen"
                    >
                      ✕ Fehlt (Lücke)
                    </button>
                  </td>
                  <td className="py-2 px-3 text-slate-600 text-xs text-center">-</td>
                  <td className="py-2 px-3 text-slate-400 text-xs">
                    {gapMeta?.publisher || manga.publisher || '-'}
                  </td>
                  <td className="py-2 px-3 font-mono text-emerald-400 text-xs">
                    {gapMeta?.price ? `${gapMeta.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '-'}
                  </td>
                  <td className="py-2 px-3 text-slate-500 text-xs italic">
                    {gapMeta?.release_date || '-'}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFillingGapNumber(item.gapNumber);
                        }}
                        className="px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1 transition-all ml-auto cursor-pointer"
                        title="Band in Sammlung aufnehmen"
                      >
                        <Plus className="w-3.5 h-3.5" /> Erfassen
                      </button>
                    )}
                  </td>
                </tr>
              );
            }

            const vol = item.volume;
            const isOwned = vol.status === 'Vorhanden';
            const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
            const isRead = vol.read_users 
              ? vol.read_users.some(u => String(u.user_id || u.id) === String(effUserId)) 
              : (Boolean(vol.is_read) && String(effUserId) === String(user?.id));
            const effectivePublisher = (vol.publisher && vol.publisher.trim()) || (manga.publisher && manga.publisher.trim()) || '-';

            return (
              <tr 
                key={vol.id} 
                className={`hover:bg-slate-900/60 transition-colors ${!isOwned ? 'opacity-75' : ''}`}
              >
                {/* Cover thumbnail */}
                <td className="py-2 px-3 text-center">
                  {vol.cover_image ? (
                    <div 
                      className="relative inline-block cursor-pointer group/thumb"
                      onClick={() => openVolumeGallery(vol)}
                      title="Fotogalerie öffnen"
                    >
                      <img loading="lazy" 
                        src={vol.cover_image} 
                        alt={vol.volume_number} 
                        className="w-8 h-12 object-cover rounded shadow border border-slate-800 group-hover/thumb:scale-110 transition-transform"
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150" viewBox="0 0 100 150" fill="%231e293b"><rect width="100" height="150" fill="%230f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="12" font-family="sans-serif">?</text></svg>';
                        }}
                      />
                      {vol.images && vol.images.length > 1 && (
                        <span className="absolute -bottom-1 -right-1 bg-black/90 text-brand-300 font-mono text-[8px] px-1 rounded font-bold border border-brand-500/30">
                          {vol.images.length}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="w-8 h-12 rounded bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto text-slate-600 text-[10px]">
                      📖
                    </div>
                  )}
                </td>

                {/* Band / Title */}
                <td className="py-2 px-3 font-bold text-white text-sm">
                  {getVolumeDisplayTitle(vol)}
                  {vol.isbn && (
                    <span className="block text-[10px] text-slate-500 font-mono font-normal">
                      ISBN: {vol.isbn}
                    </span>
                  )}
                </td>

                {/* Typ Badge */}
                <td className="py-2 px-3">
                  {vol.type === 'schuber' ? (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      Schuber
                    </span>
                  ) : vol.type === 'special_edition' ? (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30">
                      Special Edition
                    </span>
                  ) : vol.type === 'special' ? (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      Special
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-800 text-slate-400">
                      Einzelband
                    </span>
                  )}
                </td>

                {/* Status */}
                <td className="py-2 px-3">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => canEdit && handleToggleVolume(vol)}
                    className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                      canEdit ? 'cursor-pointer hover:scale-105' : 'cursor-default'
                    } ${
                      isOwned
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : vol.status === 'Vorbestellt'
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                          : vol.status === 'Erscheint bald'
                            ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    }`}
                    title={canEdit ? 'Klicken zum Status umschalten' : ''}
                  >
                    {isOwned ? (
                      '✓ Im Besitz'
                    ) : vol.status === 'Vorbestellt' ? (
                      <><Truck className="w-3 h-3 text-sky-400" /> Vorbestellt</>
                    ) : vol.status === 'Erscheint bald' ? (
                      <><Calendar className="w-3 h-3 text-purple-400" /> Erscheint bald</>
                    ) : (
                      '✕ Fehlt'
                    )}
                  </button>
                </td>

                {/* Read Status */}
                <td className="py-2 px-3">
                  {isOwned ? (
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={(e) => canEdit && handleToggleVolumeRead(vol, effUserId, e)}
                      className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                        canEdit ? 'cursor-pointer hover:scale-105' : 'cursor-default'
                      } ${
                        isRead
                          ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      <BookCheck className={`w-3 h-3 ${isRead ? 'text-teal-400' : 'text-slate-500'}`} />
                      <span>{isRead ? 'Gelesen' : 'Ungelesen'}</span>
                    </button>
                  ) : (
                    <span className="text-slate-600">-</span>
                  )}
                </td>

                {/* Publisher */}
                <td className="py-2 px-3 text-slate-300">{effectivePublisher}</td>

                {/* Price */}
                <td className="py-2 px-3 font-mono text-emerald-400">
                  {vol.price !== null && vol.price !== undefined ? `${Number(vol.price).toFixed(2)} €` : '-'}
                </td>

                {/* Condition */}
                <td className="py-2 px-3 text-slate-400">
                  {vol.condition || '-'}
                </td>

                {/* Actions */}
                <td className="py-2 px-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleOpenEditVolume(vol)}
                        className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                        title="Bearbeiten"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={(e) => handleDeleteVolume(e, vol.id)}
                        className="p-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 hover:text-rose-200 border border-rose-800/40 transition-colors"
                        title="Löschen"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
