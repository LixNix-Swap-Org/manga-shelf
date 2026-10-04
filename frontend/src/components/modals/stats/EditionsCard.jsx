import { Languages } from 'lucide-react';
import { formatMoney } from '../../../utils/format';
import { countLabel, fmtNumber } from '../statsFormat';
import { languageName } from '../../../utils/editions';
import { t } from '../../../i18n/index.js';

/**
 * Editions per language and owned value per currency (GET /api/stats `languages`, `currencies`). Shown only when the
 * collection has more than one language or prices in another currency than the euro; amounts are never converted.
 */
export default function EditionsCard({ languages, currencies }) {
  const langs = Array.isArray(languages) ? languages : [];
  const others = (Array.isArray(currencies) ? currencies : []).filter((c) => c && c.currency !== 'EUR');
  if (langs.length < 2 && others.length === 0) return null;
  return (
    <div id="stats-editions" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
        <Languages className="w-4 h-4 text-teal-400" aria-hidden="true" /> {t('Ausgaben nach Sprache')}
      </h3>
      {langs.length > 0 && (
        <table className="w-full text-xs text-slate-300">
          <thead className="sr-only">
            <tr><th scope="col">{t('Sprache')}</th><th scope="col">{t('Reihen')}</th><th scope="col">{t('Bände im Besitz')}</th></tr>
          </thead>
          <tbody>
            {langs.map((l) => (
              <tr key={l.language} className="border-b border-slate-800/60 last:border-0">
                <th scope="row" className="py-1.5 text-left font-semibold text-slate-100">
                  {languageName(l.language)} <span className="ml-1 text-[10px] font-mono text-slate-400 uppercase">{l.language}</span>
                </th>
                <td className="py-1.5 text-right">{countLabel(l.series, 'Reihe', 'Reihen')}</td>
                <td className="py-1.5 text-right font-mono">{t('{owned} im Besitz', { owned: fmtNumber(l.owned_volumes) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {others.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[11px] font-semibold text-slate-300 mb-1.5">{t('Weitere Währungen')}</h4>
          <ul className="space-y-1 text-xs">
            {others.map((c) => (
              <li key={c.currency} className="flex items-center justify-between gap-2">
                <span className="text-slate-300"><span className="font-mono font-semibold text-slate-100">{c.currency}</span> · {countLabel(c.series, 'Reihe', 'Reihen')}</span>
                <span className="font-mono font-bold text-emerald-300">{formatMoney(c.owned_value, c.currency)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400">{t('Nicht umgerechnet: Sammlungswert und Ausgaben oben zählen nur Preise in Euro.')}</p>
        </div>
      )}
    </div>
  );
}
