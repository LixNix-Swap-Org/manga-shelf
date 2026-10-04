import { Package, Sparkles, Layers, X } from 'lucide-react';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { t } from '../../../i18n/index.js';

/** The entry as the form describes it right now; an emptied number field falls back to the stored one. */
export const headerVolume = (activeVolume, editVolForm) => {
  const merged = { ...(activeVolume || {}), ...(editVolForm || {}) };
  if (!String(merged.volume_number ?? '').trim()) merged.volume_number = activeVolume?.volume_number ?? '';
  return merged;
};

/** Title bar of the volume editor (icon and label follow the entry type). */
export default function EditHeader({
  editVolForm,
  activeVolume,
  onClose
}) {
  return (
    <div className="shrink-0 bg-slate-900/95 px-4 py-3.5 sm:px-6 sm:py-4 short:py-2 border-b border-slate-800 flex items-center justify-between">
      <div className="min-w-0 flex-1 pr-2">
        <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2 truncate">
          {editVolForm.type === 'schuber' ? <Package className="w-5 h-5 text-indigo-400 shrink-0" /> :
           editVolForm.type === 'special_edition' ? <Sparkles className="w-5 h-5 text-fuchsia-400 shrink-0" /> :
           editVolForm.type === 'special' ? <Sparkles className="w-5 h-5 text-amber-400 shrink-0" /> :
           <Layers className="w-5 h-5 text-brand-400 shrink-0" />}
          <span className="truncate">
            {t('{volume} bearbeiten', { volume: getVolumeDisplayTitle(headerVolume(activeVolume, editVolForm)) })}
          </span>
        </h2>
        <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5 truncate short:hidden">
          {t('Typ, Details, Preis und Sammlerangaben für diesen Eintrag')}
        </p>
      </div>
      <button 
        type="button" 
        onClick={() => onClose()} 
        className="hit-44 text-slate-400 hover:text-white p-1.5 rounded-xl hover:bg-slate-800 transition-colors shrink-0 bg-slate-800/40"
        aria-label={t('Schließen')}
      >
        <X className="w-5 h-5" aria-hidden="true" />
      </button>
    </div>
  );
}
