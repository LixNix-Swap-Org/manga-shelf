// Named community ratings of one anime (split from AnimeDetailModal.jsx).
import { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { t } from '../../../i18n/index.js';

/** Named community ratings of one entry as the caller may see them (anonymous ones without a name). */
export function CommunityRatings({ animeId, version }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!animeId) return undefined;
    const controller = new AbortController();
    api.get(`/api/anime/${animeId}/ratings`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setRows(Array.isArray(data?.ratings) ? data.ratings : []); })
      .catch(() => { if (!controller.signal.aborted) setRows([]); });
    return () => controller.abort();
  }, [animeId, version]);
  const shown = rows.filter((r) => r.score || r.comment);
  if (!shown.length) return null;
  return (
    <ul className="space-y-1 mb-3" aria-label={t('Bewertungen')}>
      {shown.map((r, i) => (
        <li key={r.user_id || `anon-${i}`} className="text-xs text-slate-300">
          <span className="font-semibold text-slate-100">{r.username || t('Anonym')}</span>
          {r.own && <span className="text-slate-400"> ({t('du')})</span>}
          {r.score ? <span> {r.score}/10</span> : null}
          {r.visibility === 'private' && <span className="text-slate-400"> · {t('privat')}</span>}
          {r.comment && <span className="block text-slate-400 break-words">„{r.comment}“</span>}
        </li>
      ))}
    </ul>
  );
}
