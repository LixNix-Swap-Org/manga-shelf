import { useEffect, useRef, useState } from 'react';
import { X, Coins, Calendar, ShoppingCart, CircleCheck, Clock, PackageCheck, CircleAlert } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { readApiError, notifyTrashed } from '../../hooks/useVolumeActions';
import { getRegularGapMeta } from '../../utils/volumeHelpers';
import { ApiError, apiFetch, readJson, TIMEOUTS, assetImgProps } from '../../utils/api';
import { notify, UNEXPECTED_ERROR } from '../../utils/notify';
import { formatDate, formatEuro } from '../../utils/format';
import { deleteVolumeRequest } from './volumeEdit/editorUtils';

const FILL_OPTIONS = {
  Fehlt: {
    title: 'Auf Einkaufsliste setzen',
    hint: 'Status: Fehlt noch (erscheint im Buchladen-Modus)',
    Icon: ShoppingCart,
    tone: 'amber'
  },
  Vorhanden: {
    title: 'Direkt als im Besitz eintragen',
    hint: 'Status: Vorhanden (steht bereits im Regal)',
    Icon: CircleCheck,
    tone: 'emerald'
  },
  Vorbestellt: {
    title: 'Als vorbestellt eintragen',
    hint: 'Status: Vorbestellt (erscheint im Release-Radar)',
    Icon: PackageCheck,
    tone: 'sky'
  },
  'Erscheint bald': {
    title: 'Vormerken: erscheint bald',
    hint: 'Status: Erscheint bald (Erinnerung im Release-Radar)',
    Icon: Clock,
    tone: 'indigo'
  }
};

const TONES = {
  amber: 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/50 text-amber-200',
  emerald: 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/50 text-emerald-200',
  sky: 'bg-sky-500/15 hover:bg-sky-500/25 border-sky-500/50 text-sky-200',
  indigo: 'bg-indigo-500/15 hover:bg-indigo-500/25 border-indigo-500/50 text-indigo-200'
};

/** Statuses the dialog offers: a volume that is not out yet cannot be owned, but it can be pre-ordered or watched. */
export function gapFillOptions(meta) {
  if (meta && meta.is_released === false) return ['Vorbestellt', 'Erscheint bald', 'Fehlt'];
  return ['Fehlt', 'Vorhanden'];
}

/** 'YYYY-MM-DD' -> '01.02.2027', 'YYYY-MM' -> '02/2027'. */
export const formatGermanDate = (value) => formatDate(value);

/** Removes the volume a gap fill created ('Rückgängig' in the success toast); it goes to the trash like any delete. */
export async function undoGapFill(volumeId, onSuccess, label = 'Band') {
  const result = await deleteVolumeRequest(volumeId);
  if (!result.ok) {
    if (!result.aborted) notify.error(result.error);
    return false;
  }
  if (onSuccess) await onSuccess();
  notifyTrashed(label, result.trash_id, onSuccess);
  return true;
}

/** An http(s) cover goes through the server's download first, so the volume keeps a local copy (offline, no hotlink). */
async function localizeCover(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return url || null;
  try {
    const res = await apiFetch('/api/upload-remote', { method: 'POST', body: { url }, timeout: TIMEOUTS.remote });
    if (res.ok) {
      const data = await readJson(res);
      if (data?.url) return data.url;
    }
  } catch (_) { /* keep the remote URL */ }
  return url;
}

export default function GapFillModal({
  isOpen,
  gapNumber,
  onClose,
  manga,
  mangaId,
  mpGapMap,
  canEdit,
  gapEditionUnconfirmed = false,
  onSuccess
}) {
  // the gap whose request is running: Escape or another ghost can switch the dialog to a different gap meanwhile
  const [loadingGap, setLoadingGap] = useState(null);
  const currentGapRef = useRef(gapNumber);
  currentGapRef.current = isOpen ? gapNumber : null;

  const open = isOpen && gapNumber !== null;
  const loading = open && loadingGap !== null && String(loadingGap) === String(gapNumber);
  const dialogRef = useDialogA11y(open);

  // the page closes dialogs on Escape; a running request keeps this one open. Capture phase on window, because the
  // clicked button is disabled meanwhile and focus may have left the dialog (useDetailKeyboard skips handled keys).
  useEffect(() => {
    if (!loading) return undefined;
    const holdEscape = (e) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', holdEscape, true);
    return () => window.removeEventListener('keydown', holdEscape, true);
  }, [loading]);

  if (!open) return null;

  const meta = getRegularGapMeta(mpGapMap, gapNumber);
  // a guessed edition may be the wrong one: its price, date and cover are not stored until it is confirmed
  const trustedMeta = gapEditionUnconfirmed ? null : meta;
  const options = gapFillOptions(trustedMeta);

  const handleFillGap = async (targetStatus) => {
    if (!canEdit || loadingGap !== null) return;
    const requested = gapNumber;
    const stillOpen = () => String(currentGapRef.current) === String(requested);
    setLoadingGap(requested);
    try {
      const cover = trustedMeta?.cover_image ? await localizeCover(trustedMeta.cover_image) : null;
      const res = await apiFetch('/api/volumes', {
        method: 'POST',
        body: {
          manga_id: mangaId,
          volume_number: String(requested),
          status: targetStatus,
          price: trustedMeta && trustedMeta.price !== null && trustedMeta.price !== undefined ? trustedMeta.price : null,
          release_date: trustedMeta?.release_date || null,
          cover_image: cover,
          publisher: manga?.publisher || null,
          type: 'volume'
        }
      });
      if (res.ok) {
        const created = await readJson(res);
        if (stillOpen()) onClose();
        if (onSuccess) await onSuccess();
        notify.success(`Band ${requested} als „${targetStatus}“ erfasst`, created?.id ? {
          action: { label: 'Rückgängig', onClick: () => undoGapFill(created.id, onSuccess, `„Band ${requested}“`) }
        } : undefined);
      } else {
        const message = await readApiError(res, 'Fehler beim Erfassen des Bands');
        notify.error(stillOpen() ? message : `Band ${requested} konnte nicht erfasst werden: ${message}`);
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : UNEXPECTED_ERROR;
      notify.error(stillOpen() ? message : `Band ${requested} konnte nicht erfasst werden: ${message}`);
    } finally {
      setLoadingGap(cur => (String(cur) === String(requested) ? null : cur));
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Lücke füllen"
      aria-busy={loading || undefined}
      data-busy={loading ? 'true' : undefined}
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-sm animate-fade-in"
      onClick={() => !loading && onClose()}
    >
      <div
        className="dialog-box bg-slate-900 border border-amber-500/40 rounded-2xl max-w-md p-4 sm:p-6 short:p-4 shadow-2xl relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-800 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 font-black" aria-hidden="true">
              +
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-white text-base">Lücke erfassen: Band {gapNumber}</h2>
              <p className="text-xs text-slate-400 break-words [overflow-wrap:anywhere]">{manga?.title}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="Schließen"
            title="Schließen"
            className="hit-44 shrink-0 text-slate-400 hover:text-white p-1 rounded-lg disabled:opacity-50"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <p className="text-xs text-slate-300 mb-3 leading-relaxed">
          Dieser Band fehlt in deiner Sammlung. Wie möchtest du Band {gapNumber} erfassen?
        </p>

        {gapEditionUnconfirmed && meta && (
          <p className="mb-3 p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/30 text-[11px] text-sky-200 flex items-start gap-2">
            <CircleAlert className="w-4 h-4 shrink-0 text-sky-300" aria-hidden="true" />
            <span>Die Manga-Passion-Edition ist nur vorgeschlagen. Preis, Termin und Cover werden erst nach „Edition bestätigen“ übernommen.</span>
          </p>
        )}

        {trustedMeta && (
          <div className="mb-4 p-3 bg-slate-950/90 rounded-xl border border-slate-800 flex gap-3 items-center">
            {trustedMeta.cover_image && (
              <img
                {...assetImgProps(trustedMeta.cover_image)}
                alt=""
                className="w-12 h-16 object-cover rounded-lg border border-slate-700 shrink-0 shadow-md"
              />
            )}
            <div className="text-xs space-y-1 min-w-0 flex-1">
              <div className="font-bold text-white truncate flex items-center gap-1.5">
                <span>{manga?.title} – Band {gapNumber}</span>
              </div>
              {typeof trustedMeta.price === 'number' && trustedMeta.price > 0 && (
                <div className="text-amber-400 font-mono font-bold text-xs flex items-center gap-1">
                  <Coins className="w-3 h-3 text-amber-400" aria-hidden="true" />
                  <span>Offizieller Preis: {formatEuro(trustedMeta.price)}</span>
                </div>
              )}
              {(trustedMeta.release_date || trustedMeta.is_released === false) && (
                <div className="text-slate-400 text-[11px] flex flex-wrap items-center gap-1">
                  <Calendar className="w-3 h-3 text-slate-400" aria-hidden="true" />
                  {trustedMeta.release_date ? (
                    <span>{trustedMeta.is_released === false ? 'Erscheint am' : 'Erschienen am'} {formatGermanDate(trustedMeta.release_date)}</span>
                  ) : (
                    <span>Termin noch nicht bekannt</span>
                  )}
                  <span className={`text-[9px] px-1.5 py-px rounded font-semibold ${trustedMeta.is_released === false ? 'bg-sky-500/20 text-sky-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                    {trustedMeta.is_released === false ? 'Vorbestellbar' : 'Bereits im Handel'}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {options.map(status => {
            const { title, hint, Icon, tone } = FILL_OPTIONS[status];
            return (
              <button
                key={status}
                type="button"
                disabled={loading}
                onClick={() => handleFillGap(status)}
                className={`w-full py-3 px-4 rounded-xl border font-semibold text-xs flex items-center justify-between transition-all group cursor-pointer disabled:opacity-60 disabled:cursor-wait ${TONES[tone]}`}
              >
                <div className="flex items-center gap-2.5 text-left">
                  <Icon className="w-4 h-4 group-hover:scale-110 transition-transform" aria-hidden="true" />
                  <div>
                    <div className="font-bold">{title}</div>
                    <div className="text-[11px] opacity-80">{hint}</div>
                  </div>
                </div>
                <span className="text-base font-bold" aria-hidden="true">→</span>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-800">
          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            className="btn-secondary text-xs"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}
