import { Package, Sparkles, X, CircleCheck, TriangleAlert } from 'lucide-react';
import { t } from '../../../i18n/index.js';

/** Manga-Passion autofill banner with its status message. */
export default function AutofillPanel({
  editVolForm,
  autofillingVolume,
  autofillMessage,
  setAutofillMessage,
  handleAutofillVolumeData
}) {
  return (
    <>
      <div className="p-3.5 rounded-2xl bg-gradient-to-br from-indigo-950/40 via-slate-900 to-sky-950/40 border border-sky-500/25 shadow-lg relative overflow-hidden">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0 mt-0.5">
            {editVolForm.type === 'schuber' ? <Package className="w-5 h-5 text-indigo-400" /> : <Sparkles className="w-5 h-5 text-sky-400" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs sm:text-sm font-bold text-white">
                {editVolForm.type === 'schuber' ? t('Schuber-Cover & Details laden') : t('Metadaten automatisch ausfüllen')}
              </h3>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                {t('Manga Passion')}
              </span>
            </div>
            <p className="text-[11px] text-slate-300/80 mt-1 leading-relaxed">
              {editVolForm.type === 'schuber'
                ? t('Offizielles Schuber-Cover herunterladen, Erscheinungsdatum, Titel & Preis automatisch abrufen.')
                : t('Erscheinungsdatum, Jahr, Seitenzahl, ISBN & Preis automatisch abrufen.')}
            </p>
          </div>
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80">
          <button
            type="button"
            onClick={() => handleAutofillVolumeData()}
            disabled={autofillingVolume}
            className="btn-primary w-full text-xs py-2.5 px-4 flex items-center justify-center gap-2 shadow-md shadow-sky-600/20 active:scale-[0.99] transition-all font-semibold"
            title={t('Metadaten via Manga Passion automatisch abrufen')}
          >
            <Sparkles className={`w-3.5 h-3.5 ${autofillingVolume ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>
              {autofillingVolume 
                ? t('Lade Daten von Manga Passion...') 
                : (editVolForm.type === 'schuber' ? t('Schuber-Cover & Details jetzt laden') : t('Daten jetzt automatisch ausfüllen'))}
            </span>
          </button>
        </div>
      </div>

      {/* always mounted, so screen readers announce a message that appears later */}
      <div role="status" aria-live="polite" className="empty:!mt-0">
        {autofillMessage && (
          <div className={`p-2.5 rounded-xl text-xs flex items-center justify-between gap-2 animate-fade-in ${
            autofillMessage.type === 'success' 
              ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300' 
              : autofillMessage.type === 'info'
                ? 'bg-sky-500/15 border border-sky-500/30 text-sky-300'
                : 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
          }`}>
            <div className="flex items-center gap-2">
              {autofillMessage.type === 'success' ? (
                <CircleCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              ) : autofillMessage.type === 'info' ? (
                <Sparkles className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
              ) : (
                <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
              )}
              <span>{autofillMessage.text}{/* i18n-ignore: translated where produced (useVolumeEditForm) */}</span>
            </div>
            <button
              type="button"
              onClick={() => setAutofillMessage(null)}
              aria-label={t('Meldung schließen')}
              className="hit-44 shrink-0 p-1 -m-1 rounded text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
