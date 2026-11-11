// "Aus deinen Regalen" in "Neuer Manga": the same series in another own shelf, taken over with its values (split from
// AddMangaModal.jsx).
import { Library } from 'lucide-react';
import LanguagePill from '../../common/LanguagePill';
import { t, tn, tc } from '../../../i18n/index.js';

export default function CopyHitsSection({ idPrefix, hits, pick, setPick, copyVolumes, setCopyVolumes, busy, submitting, onCopy }) {
  return (
    <section aria-labelledby={`${idPrefix}-copy`} className="bg-slate-900/60 border border-slate-700 rounded-xl p-3 space-y-2" data-copy-hits="">
      <h3 id={`${idPrefix}-copy`} className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
        <Library className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Aus deinen Regalen')}
      </h3>
      <ul className="space-y-2">
        {hits.map((hit) => (
          <li key={hit.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <p className="font-semibold text-white break-words">
                {hit.title} <LanguagePill language={hit.language} />
              </p>
              <p className="text-slate-400">
                {t('in „{shelf}“', { shelf: hit.shelf_name })} · {tn('{n} Band', '{n} Bände', hit.volume_count)}
              </p>
            </div>
            {pick !== hit.id ? (
              <button
                type="button"
                className="btn-secondary hit-44 px-3 py-1.5 text-xs"
                aria-label={t('Übernehmen: {title}', { title: hit.title })}
                onClick={() => { setPick(hit.id); setCopyVolumes(false); }}
                disabled={busy || submitting}
              >
                {tc('copy', 'Übernehmen')}
              </button>
            ) : (
              <div className="w-full flex flex-wrap items-center gap-3">
                {hit.volume_count > 0 && (
                  <span className="flex items-center gap-2">
                    <input id={`${idPrefix}-copy-volumes`} type="checkbox" checked={copyVolumes} onChange={(e) => setCopyVolumes(e.target.checked)} />
                    <label htmlFor={`${idPrefix}-copy-volumes`} className="text-slate-300">{t('Bände mitnehmen (als „Fehlt“)')}</label>
                  </span>
                )}
                <button
                  type="button"
                  className="btn-primary hit-44 px-3 py-1.5 text-xs"
                  onClick={() => onCopy(hit)}
                  disabled={busy || submitting}
                  aria-busy={busy || undefined}
                >
                  {t('In dieses Regal übernehmen')}
                </button>
                <button type="button" className="hit-44 px-1 py-1 text-slate-400 hover:text-white underline underline-offset-2" onClick={() => setPick(null)} disabled={busy}>
                  {t('Abbrechen')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
