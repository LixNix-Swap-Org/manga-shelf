import { useId } from 'react';
import { t } from '../../i18n/index.js';

const LABEL = 'block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5';
// same bound as MAX_CHAPTERS in core/lib/validate.js
const MAX_CHAPTERS = 99999;

// How a series is read: in print (by volume) or as a webtoon (by chapter, with its known chapter count). `value` is
// { format, total_chapters }; `onChange(patch)` gets the changed fields.
export default function FormatFields({ value, onChange, labelClassName = LABEL, idPrefix, disabled = false }) {
  const autoId = useId();
  const id = idPrefix || autoId;
  const format = value?.format === 'webtoon' ? 'webtoon' : 'print';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label htmlFor={`${id}-format`} className={labelClassName}>{t('Format')}</label>
        <select id={`${id}-format`} className="input-field bg-slate-950" value={format} disabled={disabled} onChange={(e) => onChange({ format: e.target.value })}>
          <option value="print">{t('Gedruckt (Bände)')}</option>
          <option value="webtoon">{t('Webtoon (Kapitel)')}</option>
        </select>
      </div>
      {format === 'webtoon' && (
        <div>
          <label htmlFor={`${id}-chapters`} className={labelClassName}>{t('Kapitel gesamt')}</label>
          <input
            id={`${id}-chapters`}
            type="number"
            inputMode="numeric"
            min="1"
            max={MAX_CHAPTERS}
            step="1"
            placeholder={t('leer = noch offen')}
            className="input-field"
            value={value?.total_chapters ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ total_chapters: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
