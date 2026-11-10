import { useState } from 'react';
import { Library } from 'lucide-react';
import { post } from '../../utils/api';
import { notify } from '../../utils/notify';
import { askConfirm } from '../modals/askConfirm';
import { t as tr, tn } from '../../i18n/index.js';

/**
 * Notice in the series edit form about the catalog (migration 46): a shared edition keeps changes in this shelf, and
 * fields this shelf set itself can take the catalog values again (only while the server says the caller may see them).
 */
export default function CatalogNotice({ manga, disabled = false, onReset }) {
  const [busy, setBusy] = useState(false);
  const catalog = manga?.catalog;
  if (!catalog) return null;
  const local = Array.isArray(catalog.local_fields) ? catalog.local_fields : [];
  const showReset = catalog.resettable && local.length > 0;
  if (catalog.editable && !showReset) return null;

  const reset = async () => {
    const ok = await askConfirm(tr('Die eigenen Werte dieses Regals werden durch die Werte des Katalogs ersetzt.'), {
      title: tr('Auf Katalogstand zurücksetzen'),
      confirmLabel: tr('Zurücksetzen'),
      danger: false
    });
    if (!ok) return;
    setBusy(true);
    try {
      await post(`/api/mangas/${manga.id}/catalog-reset`, {}, { fallback: tr('Fehler beim Zurücksetzen') });
      notify.success(tr('Katalogstand übernommen'));
      await onReset?.();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300" data-catalog-notice="">
      <Library className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {!catalog.editable && <p>{tr('Diese Ausgabe steht auch in einem anderen Regal. Deine Änderungen gelten nur für dieses Regal.')}</p>}
        {local.length > 0 && (
          <p>{tn('{n} Feld hat in diesem Regal einen eigenen Wert.', '{n} Felder haben in diesem Regal einen eigenen Wert.', local.length)}</p>
        )}
      </div>
      {showReset && (
        <button
          type="button"
          className="btn-secondary hit-44 px-3 py-1.5 text-xs"
          onClick={reset}
          disabled={disabled || busy}
          aria-busy={busy || undefined}
        >
          {tr('Auf Katalogstand zurücksetzen')}
        </button>
      )}
    </div>
  );
}
