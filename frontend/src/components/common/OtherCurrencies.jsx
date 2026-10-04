import { formatMoney } from '../../utils/format';
import { t } from '../../i18n/index.js';

/** Server totals count euro prices only; `other_currencies` ([{ currency, total }]) are listed beside them, never converted. */
export default function OtherCurrencies({ list, className = '' }) {
  const items = (Array.isArray(list) ? list : []).filter((c) => c && c.currency && c.currency !== 'EUR' && Number(c.total ?? c.value) > 0);
  if (!items.length) return null;
  const text = items.map((c) => formatMoney(c.total ?? c.value, c.currency)).join(' · ');
  return (
    <p className={`other-currencies text-[10px] font-mono text-emerald-300/80 ${className}`} title={t('Weitere Währungen (nicht umgerechnet): {amounts}', { amounts: text })}>
      + {text}
      <span className="sr-only"> ({t('weitere Währungen, nicht umgerechnet')})</span>
    </p>
  );
}
