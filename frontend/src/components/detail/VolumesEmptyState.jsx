// The "Bände" tab without volumes to show: none yet, or none matching the filters (split from MangaDetail.jsx).
import { BookOpen, RotateCcw } from 'lucide-react';
import { t } from '../../i18n/index.js';

export default function VolumesEmptyState({ hasVolumes, hasActiveFilters, onResetFilters }) {
  return (
    <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60 my-4">
      <BookOpen className="w-8 h-8 text-slate-500 mx-auto mb-2" />
      <p className="text-sm text-slate-400">
        {!hasVolumes
          ? t('Noch keine Bände erfasst. Nutze untenstehendes Feld oder "Mehrere Bände", um loszulegen.') 
          : t('Keine Bände mit diesen Filtereinstellungen gefunden.')}
      </p>
      {hasVolumes && hasActiveFilters && (
        <button
          type="button"
          onClick={onResetFilters}
          className="mt-3.5 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-brand-600/30 hover:bg-brand-600/50 text-brand-300 border border-brand-500/40 transition-all cursor-pointer shadow-sm"
        >
          <RotateCcw className="w-3.5 h-3.5" /> {t('Filter zurücksetzen')}
        </button>
      )}
    </div>
  );
}
