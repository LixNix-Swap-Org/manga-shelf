import { BookOpen, Plus, Truck, Calendar, BookCheck, PenLine, ShoppingCart, Trash } from 'lucide-react';
import { getVolumeDisplayTitle, getRegularGapMeta, hasUserRead } from '../../utils/volumeHelpers';
import { READ_OTHERS_ADMIN_ONLY } from '../../hooks/useVolumeActions';
import OwnerBadges from './OwnerBadges';
import { formatEuro, formatShortDate, gapLabel, getVolumeBadge, releaseVerb, volumeStatusKind } from './volumeViewHelpers';
import { assetImgProps } from '../../utils/api';
import { t } from '../../i18n/index.js';
import { conditionLabel } from '../../utils/enumLabels';
import { formatMoney } from '../../utils/format';
import { editionCurrency } from '../../utils/editions';
import { VolumeLanguagePill } from '../common/LanguagePill';

// i18n
const TYPE_BADGES = {
  schuber: ['Schuber', 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'],
  special_edition: ['Special Edition', 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'],
  special: ['Special', 'bg-amber-500/20 text-amber-300 border border-amber-500/30'],
  volume: ['Einzelband', 'bg-slate-800 text-slate-400']
};

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
  handleDeleteVolume,
  canToggleOthers,
  gapsOfficial,
  canToggle = canEdit,
  selectionMode = false,
  isSelected = () => false,
  onSelectVolume
}) {
  const mayToggleOthers = canToggleOthers ?? user?.role === 'admin';
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-800/80 bg-slate-950/60 shadow-xl mb-8 custom-scrollbar">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-800/90 bg-slate-900/80 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
            {selectionMode && <th scope="col" className="py-3 px-3 w-10 text-center"><span className="sr-only">{t('Auswahl')}</span></th>}
            <th scope="col" className="py-3 px-3 w-12 text-center">{t('Cover')}</th>
            <th scope="col" className="py-3 px-3">{t('Band / Titel')}</th>
            <th scope="col" className="py-3 px-3">{t('Typ')}</th>
            <th scope="col" className="py-3 px-3">{t('Status')}</th>
            <th scope="col" className="py-3 px-3">{t('Lesestatus')}</th>
            <th scope="col" className="py-3 px-3">{t('Verlag')}</th>
            <th scope="col" className="py-3 px-3">{t('Preis')}</th>
            <th scope="col" className="py-3 px-3">{t('Zustand')}</th>
            <th scope="col" className="py-3 px-3 text-right">{t('Aktionen')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60 text-slate-300">
          {displayVolumeItems.map((item, idx) => {
            if (item.isGap) {
              const gapMeta = item.gapMeta || getRegularGapMeta(mpGapMap, item.gapNumber);
              const gapDate = formatShortDate(gapMeta?.release_date);
              return (
                <tr 
                  key={`table-gap-${item.gapNumber}-${idx}`}
                  className={`border-b border-amber-500/20 transition-colors bg-amber-950/10 ${canEdit ? 'cursor-pointer hover:bg-amber-950/20' : 'cursor-default'}`}
                  onClick={canEdit ? () => setFillingGapNumber(item.gapNumber) : undefined}
                >
                  {selectionMode && <td className="py-2 px-3" />}
                  <td className="py-2 px-3 text-center">
                    {gapMeta?.cover_image ? (
                      <div className="w-8 h-12 rounded overflow-hidden shadow mx-auto border border-amber-500/40 relative">
                        <img
                          {...assetImgProps(gapMeta.cover_image)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          className="w-full h-full object-cover opacity-60"
                        />
                      </div>
                    ) : (
                      <div className="w-8 h-12 rounded bg-amber-950/30 border border-dashed border-amber-500/40 flex items-center justify-center mx-auto text-amber-400 text-xs font-bold">
                        +
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-3 font-bold text-amber-300 text-sm">
                    {t('Band {gapNumber}', { gapNumber: item.gapNumber })}
                    <span className="block text-[10px] text-amber-400/80 font-normal">
                      {gapLabel(gapsOfficial)}{gapDate ? ` · ${releaseVerb(gapMeta.release_date, gapMeta.is_released)} ${gapDate}` : ''}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      {t('Lücke')}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFillingGapNumber(item.gapNumber);
                        }}
                        className="hit-44 px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 cursor-pointer"
                        title={t('Band erfassen')}
                        aria-label={t('Band {gapNumber}: Fehlt (Lücke) – erfassen', { gapNumber: item.gapNumber })}
                      >
                        {t('✕ Fehlt (Lücke)')}
                      </button>
                    ) : (
                      <span
                        className="inline-flex px-2 py-1 rounded-lg text-xs font-semibold items-center gap-1 bg-amber-500/20 text-amber-300 border border-amber-500/40"
                        title={t('Fehlender Band')}
                      >
                        {t('✕ Fehlt (Lücke)')}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs text-center"><span aria-hidden="true" className="text-slate-500">-</span><span className="sr-only">{t('keine Angabe')}</span></td>
                  <td className="py-2 px-3 text-slate-400 text-xs">
                    {gapMeta?.publisher || manga.publisher || '-'}
                  </td>
                  <td className="py-2 px-3 font-mono text-emerald-400 text-xs">
                    {gapMeta?.price ? formatEuro(gapMeta.price) : '-'}
                  </td>
                  <td className="py-2 px-3 text-xs"><span aria-hidden="true" className="text-slate-500">-</span><span className="sr-only">{t('keine Angabe')}</span></td>
                  <td className="py-2 px-3 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFillingGapNumber(item.gapNumber);
                        }}
                        className="hit-44 px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1 transition-all ml-auto cursor-pointer"
                        title={t('Band in Sammlung aufnehmen')}
                        aria-label={t('Band {gapNumber} erfassen', { gapNumber: item.gapNumber })}
                      >
                        <Plus className="w-3.5 h-3.5" /> {t('Erfassen')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            }

            const vol = item.volume;
            const statusKind = volumeStatusKind(vol.status);
            const isOwned = statusKind === 'owned';
            const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
            const isRead = hasUserRead(vol, effUserId, user?.id);
            const canToggleRead = canToggle && (mayToggleOthers || String(effUserId) === String(user?.id));
            const [typeLabel, typeClass] = TYPE_BADGES[getVolumeBadge(vol).type];
            const effectivePublisher = (vol.publisher && vol.publisher.trim()) || (manga.publisher && manga.publisher.trim()) || '-';

            const selected = selectionMode && isSelected(vol.id);

            return (
              <tr 
                key={vol.id} 
                data-volume-id={vol.id}
                onClick={selectionMode ? (e) => {
                  if (!(e.target instanceof Element) || !e.target.closest('button, a, input, label')) onSelectVolume?.(vol, e);
                } : undefined}
                data-missing={!isOwned || undefined}
                className={`hover:bg-slate-900/60 transition-colors ${!isOwned && !selected ? 'bg-slate-950/40' : ''} ${selected ? 'bg-brand-950/50' : ''} ${selectionMode ? 'cursor-pointer' : ''}`}
              >
                {selectionMode && (
                  <td className="py-2 px-3 text-center">
                    <label className="hit-44 inline-flex align-middle cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) => onSelectVolume?.(vol, e.nativeEvent)}
                        aria-label={t('{volume} auswählen', { volume: getVolumeDisplayTitle(vol) })}
                        className="w-6 h-6 m-0 accent-brand-500 cursor-pointer"
                      />
                    </label>
                  </td>
                )}
                {/* Cover thumbnail */}
                <td className="py-2 px-3 text-center">
                  {vol.cover_image ? (
                    <button
                      type="button"
                      className="hit-44 relative inline-block cursor-pointer group/thumb rounded"
                      onClick={() => openVolumeGallery(vol)}
                      title={t('Fotogalerie öffnen')}
                      aria-label={t('Fotogalerie öffnen: {volume}', { volume: getVolumeDisplayTitle(vol) })}
                    >
                      <img loading="lazy" decoding="async"
                        {...assetImgProps(vol.cover_image)} 
                        alt="" 
                        className={`w-8 h-12 object-cover rounded shadow border border-slate-800 group-hover/thumb:scale-110 transition-transform ${isOwned ? '' : 'opacity-60 saturate-50'}`}
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150" viewBox="0 0 100 150" fill="%231e293b"><rect width="100" height="150" fill="%230f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="12" font-family="sans-serif">?</text></svg>';
                        }}
                      />
                      {vol.images && vol.images.length > 1 && (
                        <span aria-hidden="true" className="absolute -bottom-1 -right-1 bg-black/90 text-brand-300 font-mono text-[8px] px-1 rounded font-bold border border-brand-500/30">
                          {vol.images.length}
                        </span>
                      )}
                    </button>
                  ) : (
                    <div aria-hidden="true" className={`w-8 h-12 rounded bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto text-slate-500 ${isOwned ? '' : 'opacity-60'}`}>
                      <BookOpen className="w-3.5 h-3.5" />
                    </div>
                  )}
                </td>

                {/* Volume / title */}
                <td className="py-2 px-3 font-bold text-white text-sm">
                  {getVolumeDisplayTitle(vol)}
                  <VolumeLanguagePill volume={vol} manga={manga} className="ml-1.5 align-middle" />
                  <span className="ml-1.5 align-middle">
                    <OwnerBadges vol={vol} multiUser={(manga?.reader_stats?.length || 0) > 1} />
                  </span>
                  {vol.isbn && (
                    <span className="block text-[10px] text-slate-400 font-mono font-normal">
                      ISBN: {vol.isbn}
                    </span>
                  )}
                </td>

                {/* Typ Badge */}
                <td className="py-2 px-3">
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${typeClass}`}>
                    {t(typeLabel)}
                  </span>
                </td>

                {/* Status */}
                <td className="py-2 px-3">
                  <button
                    type="button"
                    disabled={!canToggle}
                    onClick={() => canToggle && handleToggleVolume(vol)}
                    className={`hit-44 px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                      canToggle ? 'cursor-pointer hover:scale-105' : 'cursor-default'
                    } ${
                      isOwned
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : statusKind === 'preordered'
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                          : statusKind === 'ordered'
                            ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                            : statusKind === 'upcoming'
                              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    }`}
                    title={canToggle ? t('Klicken zum Status umschalten') : ''}
                    aria-label={t('Status: {status} – {volume}', { status: isOwned ? t('Im Besitz') : statusKind === 'preordered' ? t('Vorbestellt') : statusKind === 'ordered' ? t('Bestellt') : statusKind === 'upcoming' ? t('Erscheint bald') : t('Fehlt'), volume: getVolumeDisplayTitle(vol) })}
                  >
                    {isOwned ? (
                      t('✓ Im Besitz')
                    ) : statusKind === 'preordered' ? (
                      <><Truck className="w-3 h-3 text-sky-400" /> {t('Vorbestellt')}</>
                    ) : statusKind === 'ordered' ? (
                      <><ShoppingCart className="w-3 h-3 text-orange-400" /> {t('Bestellt')}</>
                    ) : statusKind === 'upcoming' ? (
                      <><Calendar className="w-3 h-3 text-purple-400" /> {t('Erscheint bald')}</>
                    ) : (
                      t('✕ Fehlt')
                    )}
                  </button>
                </td>

                {/* Read Status */}
                <td className="py-2 px-3">
                  {isOwned ? (
                    <button
                      type="button"
                      disabled={!canToggleRead}
                      onClick={(e) => canToggleRead && handleToggleVolumeRead(vol, effUserId, e)}
                      title={canToggle && !canToggleRead ? t(READ_OTHERS_ADMIN_ONLY) : undefined}
                      aria-label={t('{state} – {volume}', { state: isRead ? t('Gelesen') : t('Ungelesen'), volume: getVolumeDisplayTitle(vol) })}
                      className={`hit-44 px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                        canToggleRead ? 'cursor-pointer hover:scale-105' : 'cursor-default'
                      } ${
                        isRead
                          ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      <BookCheck className={`w-3 h-3 ${isRead ? 'text-teal-400' : 'text-slate-400'}`} />
                      <span>{isRead ? t('Gelesen') : t('Ungelesen')}</span>
                    </button>
                  ) : (
                    <span><span aria-hidden="true" className="text-slate-500">-</span><span className="sr-only">{t('keine Angabe')}</span></span>
                  )}
                </td>

                {/* Publisher */}
                <td className="py-2 px-3 text-slate-300">{effectivePublisher}</td>

                {/* Price */}
                <td className="py-2 px-3 font-mono text-emerald-400">
                  {formatMoney(vol.price, editionCurrency(manga)) || '-'}
                </td>

                {/* Condition */}
                <td className="py-2 px-3 text-slate-400">
                  {conditionLabel(vol.condition) || '-'}
                </td>

                {/* Actions */}
                <td className="py-2 px-3 text-right">
                  <div className="flex items-center justify-end gap-1.5 [@media(pointer:coarse)]:gap-5">
                    {canEdit && !selectionMode && (
                      <button
                        type="button"
                        onClick={() => handleOpenEditVolume(vol)}
                        className="hit-44 p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                        title={t('Bearbeiten')}
                        aria-label={t('{volume} bearbeiten', { volume: getVolumeDisplayTitle(vol) })}
                      >
                        <PenLine className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {canEdit && !selectionMode && (
                      <button
                        type="button"
                        onClick={(e) => handleDeleteVolume(e, vol)}
                        className="hit-44 p-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 hover:text-rose-200 border border-rose-800/40 transition-colors"
                        title={t('Löschen')}
                        aria-label={t('{volume} löschen', { volume: getVolumeDisplayTitle(vol) })}
                      >
                        <Trash className="w-3.5 h-3.5" />
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
