import { ShieldCheck } from 'lucide-react';
import ToolDialog from '../modals/ToolDialog';
import { t } from '../../i18n/index.js';

/** "Verwaltung": the sections of adminSections as one dialog; each entry closes it and opens its own dialog. */
export default function AdminCenter({ onClose, sections }) {
  // the entry's dialog replaces this one; it opens after this one has closed
  const open = (run) => {
    onClose();
    run();
  };
  return (
    <ToolDialog id="admin-center" title={t('Verwaltung')} subtitle={t('Konto, Personen & Regale, Daten und System an einem Ort')} Icon={ShieldCheck} onClose={onClose}>
      <div className="space-y-5">
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`admin-section-${section.id}`} className="space-y-2">
            <h3 id={`admin-section-${section.id}`} className="text-[11px] uppercase font-bold tracking-wider text-slate-400 px-1">{section.title}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {section.entries.map(({ id, Icon, label, hint, run }) => (
                <button
                  key={id}
                  id={id}
                  type="button"
                  onClick={() => open(run)}
                  className="text-left flex items-start gap-3 p-3 rounded-xl bg-slate-900/70 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-800/70 transition-colors"
                >
                  <Icon className="w-5 h-5 text-brand-300 shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-white">{label}</span>
                    <span className="block text-xs text-slate-400">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ToolDialog>
  );
}
