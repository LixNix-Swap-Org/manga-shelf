import { useEffect, useState } from 'react';
import { Library } from 'lucide-react';
import { get, post } from '../../utils/api';
import { notify } from '../../utils/notify';
import { askConfirm } from '../modals/askConfirm';
import { t, tn, tc } from '../../i18n/index.js';

/**
 * Notice above the volumes (catalog stage c2): the same edition stands in another of your shelves with volumes this
 * series lacks; one click copies them as missing ones. Reads only the caller's own shelves (GET …/volume-sources).
 * `version` changes with every reload of the series, so the offer follows new and copied volumes.
 */
export default function CopyVolumesNotice({ mangaId, enabled, version, onCopied }) {
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || !mangaId) {
      setSources([]);
      return undefined;
    }
    let alive = true;
    get(`/api/mangas/${mangaId}/volume-sources`)
      .then((data) => { if (alive) setSources(Array.isArray(data?.sources) ? data.sources : []); })
      .catch(() => { if (alive) setSources([]); });
    return () => { alive = false; };
  }, [mangaId, enabled, version]);

  const source = sources[0];
  if (!enabled || !source || !source.volumes?.length) return null;
  const count = source.volumes.length;

  const copy = async () => {
    const ok = await askConfirm(tn('{n} Band wird hier als „Fehlt“ angelegt.', '{n} Bände werden hier als „Fehlt“ angelegt.', count), {
      title: t('Bände aus deinen Regalen übernehmen'),
      confirmLabel: tc('copy', 'Übernehmen'),
      danger: false
    });
    if (!ok) return;
    setBusy(true);
    try {
      const data = await post(`/api/mangas/${mangaId}/volumes/copy`, { from: source.manga_id }, { fallback: t('Fehler beim Übernehmen der Bände') });
      const created = Array.isArray(data?.created) ? data.created.length : 0;
      notify.success(tn('{n} Band übernommen', '{n} Bände übernommen', created));
      await onCopied?.();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 p-3 bg-slate-900/60 border border-slate-700 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300" data-copy-volumes="" data-notice={t('Bände übernehmen')}>
      <p className="flex items-center gap-2 min-w-0">
        <Library className="w-4 h-4 shrink-0 text-brand-400" aria-hidden="true" />
        <span>{tn('{n} Band aus „{shelf}“ fehlt hier.', '{n} Bände aus „{shelf}“ fehlen hier.', count, { shelf: source.shelf_name })}</span>
      </p>
      <button type="button" className="btn-secondary hit-44 px-3 py-1.5 text-xs" onClick={copy} disabled={busy} aria-busy={busy || undefined}>
        {t('Bände übernehmen')}
      </button>
    </div>
  );
}
