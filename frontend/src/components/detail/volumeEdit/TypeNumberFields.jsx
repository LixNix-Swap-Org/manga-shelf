import { Tag, Hash } from 'lucide-react';

/** Entry type and volume number. */
export default function TypeNumberFields({
  editVolForm,
  setEditVolForm
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-3.5">
      <div className="sm:col-span-7">
        <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Tag className="w-3.5 h-3.5 text-brand-400" /> Eintragstyp
        </label>
        <select 
          className="input-field bg-slate-950 font-medium py-2.5 text-sm w-full cursor-pointer hover:border-slate-700"
          value={editVolForm.type || 'volume'} 
          onChange={e => setEditVolForm({ ...editVolForm, type: e.target.value })}
        >
          <option value="volume">📖 Einzelband</option>
          <option value="special_edition">✨ Special Edition</option>
          <option value="schuber">📦 Schuber</option>
          <option value="special">⭐ Special / Extra</option>
        </select>
      </div>

      <div className="sm:col-span-5">
        <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Hash className="w-3.5 h-3.5 text-slate-400" />
          {editVolForm.type === 'schuber' ? 'Schuber-Nr.' : 
           editVolForm.type === 'special_edition' ? 'Band-Nr.' :
           editVolForm.type === 'special' ? 'Bezeichnung' : 'Band-Nummer'} <span className="text-red-400">*</span>
        </label>
        <input 
          type="text" 
          required
          className="input-field py-2.5 text-sm font-semibold" 
          value={editVolForm.volume_number} 
          onChange={e => setEditVolForm({ ...editVolForm, volume_number: e.target.value })} 
        />
      </div>
    </div>
  );
}
