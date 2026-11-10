import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Handshake } from 'lucide-react';
import { apiFetch, readJson } from '../../../utils/api';
import { formatDate } from '../../../utils/format';
import { getVolumeDisplayTitle } from '../../../utils/volumeHelpers';
import { t } from '../../../i18n/index.js';

const volumeName = (c) => `${c.title} – ${getVolumeDisplayTitle({ volume_number: c.volume_number, type: c.type })}`;

function CopyLine({ copy, text, showShelf, onNavigate }) {
  return (
    <li className="flex flex-col py-1.5 border-b border-slate-800/60 last:border-0">
      <div className="flex items-baseline justify-between gap-2">
        {copy.manga_id
          ? <Link to={`/manga/${copy.manga_id}`} onClick={onNavigate} className="font-semibold text-slate-100 hover:text-brand-300 break-words">{volumeName(copy)}</Link>
          : <span className="font-semibold text-slate-100 break-words">{volumeName(copy)}</span>}
        {showShelf && copy.shelf_name && <span className="text-[11px] text-slate-400 shrink-0">{copy.shelf_name}</span>}
      </div>
      <span className="text-slate-400">{text}</span>
    </li>
  );
}

/**
 * Lent and borrowed copies (GET /api/copies/lent): what is lent out from the caller's shelves and what others lent to
 * the caller. Hidden while both lists are empty or the request failed.
 */
export default function LentCard({ shelfId = null, onNavigate }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let live = true;
    const url = shelfId && shelfId !== 'all' ? `/api/copies/lent?shelf_id=${encodeURIComponent(shelfId)}` : '/api/copies/lent';
    apiFetch(url)
      .then(async (res) => { const body = res.ok ? await readJson(res) : null; if (live) setData(body); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [shelfId]);

  const lentOut = data?.lent_out || [];
  const borrowed = data?.borrowed || [];
  if (lentOut.length === 0 && borrowed.length === 0) return null;
  const showShelf = !shelfId || shelfId === 'all';
  const since = (c) => (c.lent_at ? formatDate(c.lent_at) : '');
  return (
    <div id="stats-lent" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800 text-xs">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
        <Handshake className="w-4 h-4 text-violet-300" aria-hidden="true" /> {t('Verliehen & ausgeliehen')}
      </h3>
      {lentOut.length > 0 && (
        <>
          <h4 className="font-semibold text-slate-300 mb-1">{t('Aus deinen Regalen verliehen')}</h4>
          <ul className="mb-3">
            {lentOut.map(c => (
              <CopyLine
                key={c.copy_id}
                copy={c}
                showShelf={showShelf}
                onNavigate={onNavigate}
                text={c.lent_at ? t('an {name} seit {date}', { name: c.lent_to, date: since(c) }) : t('an {name}', { name: c.lent_to })}
              />
            ))}
          </ul>
        </>
      )}
      {borrowed.length > 0 && (
        <>
          <h4 className="font-semibold text-slate-300 mb-1">{t('An dich ausgeliehen')}</h4>
          <ul>
            {borrowed.map(c => (
              <CopyLine
                key={c.copy_id}
                copy={c}
                showShelf={showShelf}
                onNavigate={onNavigate}
                text={c.owner
                  ? (c.lent_at ? t('von {name} seit {date}', { name: c.owner, date: since(c) }) : t('von {name}', { name: c.owner }))
                  : (c.lent_at ? t('seit {date}', { date: since(c) }) : '')}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
