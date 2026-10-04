import { useId } from 'react';
import { Tag, Hash } from 'lucide-react';
import { t } from '../../../i18n/index.js';

/** Entry type and volume number. */
export default function TypeNumberFields({
  editVolForm,
  setEditVolForm,
  error
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-3.5">
      <div className="sm:col-span-7">
        <label htmlFor={`${id}-type`} className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Tag className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Eintragstyp')}
        </label>
        <select 
          id={`${id}-type`}
          className="input-field bg-slate-950 font-medium py-2.5 text-base sm:text-sm w-full cursor-pointer hover:border-slate-700"
          value={editVolForm.type || 'volume'} 
          onChange={e => setEditVolForm(prev => ({ ...prev, type: e.target.value }))}
        >
          <option value="volume">{t('Einzelband')}</option>
          <option value="special_edition">{t('Special Edition')}</option>
          <option value="schuber">{t('Schuber')}</option>
          <option value="special">{t('Special / Extra')}</option>
        </select>
      </div>

      <div className="sm:col-span-5">
        <label htmlFor={`${id}-number`} className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Hash className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          {editVolForm.type === 'schuber' ? t('Schuber-Nr.') : 
           editVolForm.type === 'special_edition' ? t('Band-Nr.') :
           editVolForm.type === 'special' ? t('Bezeichnung') : t('Band-Nummer')} <span className="text-red-400" aria-hidden="true">*</span>
        </label>
        <input 
          id={`${id}-number`}
          type="text" 
          required
          maxLength={80}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-number-error` : undefined}
          className="input-field py-2.5 text-base sm:text-sm font-semibold" 
          value={editVolForm.volume_number ?? ''} 
          onChange={e => setEditVolForm(prev => ({ ...prev, volume_number: e.target.value }))} 
        />
        {error && <p id={`${id}-number-error`} className="text-[11px] text-red-400 mt-1">{error}</p>}
      </div>
    </div>
  );
}
