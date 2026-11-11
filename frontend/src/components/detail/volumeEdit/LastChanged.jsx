import { History } from 'lucide-react';
import { formatDateTime } from '../../../utils/format';
import { t } from '../../../i18n/index.js';

// SQLite's CURRENT_TIMESTAMP is UTC without a zone ('2026-11-11 19:43:00')
const parseUtc = (value) => {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "Zuletzt geändert von Max am 11.11.2026, 19:43" (migration 55); nothing for a volume no one changed since. */
export default function LastChanged({ volume }) {
  const name = volume?.updated_by_name;
  const when = parseUtc(volume?.updated_at);
  if (!name && !when) return null;
  const date = when ? formatDateTime(when) : '';
  let text;
  if (name && date) text = t('Zuletzt geändert von {name} am {date}', { name, date });
  else if (name) text = t('Zuletzt geändert von {name}', { name });
  else text = t('Zuletzt geändert am {date}', { date });
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-slate-400" data-testid="volume-last-changed">
      <History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
