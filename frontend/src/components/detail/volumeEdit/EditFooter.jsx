import { Trash, Save } from 'lucide-react';

/** Delete / cancel / save buttons. */
export default function EditFooter({
  savingVol,
  handleDeleteVolume,
  activeVolume,
  onClose
}) {
  return (
    <div className="shrink-0 bg-slate-900 border-t border-slate-800 px-4 py-3 sm:px-6 sm:py-3.5 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-2.5">
      <button 
        type="button" 
        onClick={(e) => handleDeleteVolume(e, activeVolume.id)} 
        className="btn-danger text-xs py-2 px-3 flex items-center justify-center gap-1.5 w-full sm:w-auto"
      >
        <Trash className="w-3.5 h-3.5" /> Band löschen
      </button>

      <div className="flex items-center gap-2 w-full sm:w-auto">
        <button 
          type="button" 
          onClick={() => onClose()} 
          className="btn-secondary text-xs py-2 px-4 flex-1 sm:flex-initial text-center"
        >
          Abbrechen
        </button>
        <button 
          type="submit" 
          disabled={savingVol}
          className="btn-primary text-xs py-2 px-4 flex-1 sm:flex-initial flex items-center justify-center gap-1.5 shadow-lg font-semibold"
        >
          <Save className="w-3.5 h-3.5" /> {savingVol ? 'Speichert...' : 'Speichern'}
        </button>
      </div>
    </div>
  );
}
