import { useId } from 'react';
import {
  EDITION_CURRENCIES, EDITION_LANGUAGES, EDITION_REGIONS, currencyForRegion, defaultRegionFor, languageName, regionName, withCurrent
} from '../../utils/editions';
import { t } from '../../i18n/index.js';

const LABEL = 'block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5';

// Language, region and currency of an edition (ISO codes). `value` is { language, region, currency }; `onChange(patch)` gets the
// changed fields. Picking a language or region moves untouched dependants along (region from the UI locale for its own
// language, currency from the region) unless `follow` is false.
export default function EditionFields({ value, onChange, follow = true, labelClassName = LABEL, idPrefix, disabled = false }) {
  const autoId = useId();
  const id = idPrefix || autoId;
  const language = value?.language || 'de';
  const region = value?.region || '';
  const currency = value?.currency || 'EUR';

  const setLanguage = (next) => {
    if (!follow) return onChange({ language: next });
    const nextRegion = defaultRegionFor(next) || '';
    return onChange({ language: next, region: nextRegion, currency: currencyForRegion(nextRegion) });
  };
  const setRegion = (next) => onChange(follow ? { region: next, currency: currencyForRegion(next) } : { region: next });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label htmlFor={`${id}-language`} className={labelClassName}>{t('Sprache der Ausgabe')}</label>
        <select id={`${id}-language`} className="input-field bg-slate-950" value={language} disabled={disabled} onChange={(e) => setLanguage(e.target.value)}>
          {withCurrent(EDITION_LANGUAGES, language).map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-region`} className={labelClassName}>{t('Region')}</label>
        <select id={`${id}-region`} className="input-field bg-slate-950" value={region} disabled={disabled} onChange={(e) => setRegion(e.target.value)}>
          <option value="">{t('Keine Angabe')}</option>
          {withCurrent(EDITION_REGIONS, region).map((code) => <option key={code} value={code}>{regionName(code)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-currency`} className={labelClassName}>{t('Währung')}</label>
        <select id={`${id}-currency`} className="input-field bg-slate-950" value={currency} disabled={disabled} onChange={(e) => onChange({ currency: e.target.value })}>
          {withCurrent(EDITION_CURRENCIES, currency).map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </div>
    </div>
  );
}
