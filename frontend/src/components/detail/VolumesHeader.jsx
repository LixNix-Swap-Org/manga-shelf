// Heading of the "Bände" tab with its quick actions (split from MangaDetail.jsx).
import { Layers, Plus, BookCheck } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';

export default function VolumesHeader({ canEdit, canBatchRead, onBatchRead, onBatchAdd }) {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-6 border-b border-slate-800">
      <div>
        <h2 id="volumes-heading" className="text-xl font-bold text-white flex items-center gap-2.5">
          <Layers className="w-5 h-5 text-brand-400" />
          {t('Bände-Checkliste')}
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          {rich('Klicke auf das Häkchen für Schnell-Status oder auf die Karte für {details}', { details: <b>{t('Preise & Detailangaben')}</b> })}
        </p>
      </div>

      {/* Quick Actions */}
      {canBatchRead && (
        <div className="flex flex-wrap items-center gap-2">
          <button 
            onClick={onBatchRead} 
            className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
            title={t('Mehrere Bände auf einmal als gelesen oder ungelesen markieren')}
          >
            <BookCheck className="w-3.5 h-3.5 text-emerald-400" /> {t('Bis Band X als gelesen')}
          </button>
          {canEdit && (
            <button 
              onClick={onBatchAdd} 
              className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
            >
              <Plus className="w-3.5 h-3.5 text-brand-400" /> {t('Mehrere Bände anlegen')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
