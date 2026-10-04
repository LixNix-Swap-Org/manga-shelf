import { useEffect, useId, useState } from 'react';
import { BookCheck, X, CheckCheck } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { readApiError, readAtForDate, localDateString } from '../../hooks/useVolumeActions';
import { apiFetch, errorFromResponse, readJson, TIMEOUTS } from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount, formatDate } from '../../utils/format';

const READ_FAILED = 'Fehler beim Aktualisieren des Lesestatus';

/**
 * What "Rückgängig" can undo: the ids the batch flipped (changed_ids). Reads removed by an "ungelesen" batch come back
 * only with their original dates (previous_read_at: { id: read_at }); without them no undo is offered.
 */
export function batchReadUndo(data, read) {
  const ids = Array.isArray(data?.changed_ids) ? data.changed_ids : [];
  if (!ids.length) return null;
  if (read) return { ids, readAt: null };
  const dates = data.previous_read_at;
  if (!dates || typeof dates !== 'object' || !ids.every((id) => typeof dates[id] === 'string' && dates[id])) return null;
  return { ids, readAt: dates };
}

/** Sets the read state of `ids` back one by one (a restored read keeps its date from `readAt`); the first failure is reported. */
export async function revertBatchRead(ids, { userId, read, readAt = null }) {
  let failure = null;
  for (const id of ids) {
    try {
      const body = { user_id: userId, read, is_read: read };
      if (read && readAt?.[id]) body.read_at = readAt[id];
      const res = await apiFetch(`/api/volumes/${id}/read`, { method: 'POST', body });
      if (!res.ok && res.status !== 404 && !failure) failure = await errorFromResponse(res, READ_FAILED);
    } catch (err) {
      failure = failure || err;
    }
  }
  if (failure) notify.error(failure, { fallback: READ_FAILED });
  return !failure;
}

/**
 * Whose reads the batch changes: admins may pick any reader (seeded from the reader shown on the page), everyone
 * else only their own (the server answers 403 for another user's id).
 */
export function batchReadTarget({ user, selectedReaderId, pickedReaderId }) {
  if (user?.role !== 'admin') return user?.id;
  const picked = pickedReaderId ?? selectedReaderId;
  return picked && picked !== 'ALL' ? picked : user?.id;
}

export default function BatchReadModal({
  isOpen,
  onClose,
  mangaId,
  readers = [],
  selectedReaderId,
  user,
  onSuccess
}) {
  const [batchReadUpTo, setBatchReadUpTo] = useState('');
  const [batchReadAction, setBatchReadAction] = useState(true);
  const [readDate, setReadDate] = useState(''); // empty = now; only a picked day is sent
  const [pickedReaderId, setPickedReaderId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const ids = useId();

  const isAdmin = user?.role === 'admin';

  // the select is local to the dialog: changing it must not switch the reader shown on the page behind it
  useEffect(() => {
    if (!isOpen) return;
    setPickedReaderId(null);
    setMessage('');
    setReadDate('');
  }, [isOpen]);

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  const targetUserId = batchReadTarget({ user, selectedReaderId, pickedReaderId });

  const handleBatchRead = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (!batchReadUpTo || isNaN(parseFloat(batchReadUpTo))) {
      setMessage('Bitte eine gültige Band-Nummer eingeben.');
      return;
    }
    setMessage('');
    setLoading(true);
    const upTo = parseFloat(batchReadUpTo);
    const read = batchReadAction;
    const readAt = read ? readAtForDate(readDate) : null;
    try {
      const res = await apiFetch('/api/volumes/batch-read', {
        method: 'POST',
        body: {
          manga_id: mangaId,
          up_to_volume: upTo,
          read,
          is_read: read,
          user_id: targetUserId,
          ...(readAt ? { read_at: readAt } : {})
        },
        timeout: TIMEOUTS.long
      });
      if (res.ok) {
        const data = (await readJson(res)) ?? {};
        if (Number(data.count) === 0) {
          setMessage('Keine passenden Bände gefunden: Nur Bände im Besitz (ohne Schuber) bis zu dieser Nummer zählen.');
          return;
        }
        setBatchReadUpTo('');
        onClose();
        if (onSuccess) await onSuccess();
        const undo = batchReadUndo(data, read);
        const on = readAt ? ` (gelesen am ${formatDate(readDate)})` : '';
        notify.success(`${formatCount(data.count, 'Band', 'Bände')} als ${read ? 'gelesen' : 'ungelesen'} markiert${on}`, undo ? {
          action: {
            label: 'Rückgängig',
            onClick: async () => {
              await revertBatchRead(undo.ids, { userId: targetUserId, read: !read, readAt: undo.readAt });
              if (onSuccess) await onSuccess();
            }
          }
        } : undefined);
      } else {
        setMessage(await readApiError(res, READ_FAILED));
      }
    } catch (err) {
      setMessage('Netzwerkfehler');
    } finally {
      setLoading(false);
    }
  };

  const ownName = user?.display_name || user?.username;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Lesestatus setzen"
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="dialog-box glass-panel max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 mb-4 pb-3 short:mb-3 short:pb-2 border-b border-slate-800">
          <h2 className="min-w-0 pt-1.5 text-base font-bold text-white flex items-start gap-2 break-words">
            <BookCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" /> <span className="min-w-0">Lesestatus für mehrere Bände festlegen</span>
          </h2>
          <button type="button" onClick={onClose} disabled={loading} aria-label="Schließen" title="Schließen" className="hit-44 shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-slate-800/40 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Markiere mehrere Bände bis zu einer bestimmten Band-Nummer mit einem Klick als gelesen oder ungelesen.
        </p>

        <form onSubmit={handleBatchRead} className="space-y-4">
          {isAdmin && readers.length > 0 ? (
            <div>
              <label htmlFor={`${ids}-reader`} className="block text-xs font-semibold text-slate-300 mb-1">Leser</label>
              <select
                id={`${ids}-reader`}
                className="input-field bg-slate-950 text-base sm:text-xs"
                value={String(targetUserId ?? '')}
                onChange={e => setPickedReaderId(e.target.value)}
              >
                {readers.map(r => (
                  <option key={r.user_id} value={String(r.user_id)}>
                    {r.display_name || r.username} ({r.read_count} gelesen)
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-[11px] text-slate-400">
              Gilt für deinen eigenen Lesestatus{ownName ? ` (${ownName})` : ''}.
            </p>
          )}

          <div>
            <span id={`${ids}-action`} className="block text-xs font-semibold text-slate-300 mb-1">Aktion</span>
            <div role="group" aria-labelledby={`${ids}-action`} className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={batchReadAction}
                onClick={() => setBatchReadAction(true)}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                  batchReadAction
                    ? 'bg-emerald-600/30 border-emerald-500 text-emerald-300 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <BookCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> Als gelesen markieren
              </button>
              <button
                type="button"
                aria-pressed={!batchReadAction}
                onClick={() => setBatchReadAction(false)}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                  !batchReadAction
                    ? 'bg-rose-600/30 border-rose-500 text-rose-300 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <X className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" /> Als ungelesen markieren
              </button>
            </div>
          </div>

          <div>
            <label htmlFor={`${ids}-upto`} className="block text-xs font-semibold text-slate-300 mb-1">Bis einschließlich Band-Nummer</label>
            <input
              id={`${ids}-upto`}
              type="number"
              inputMode="decimal"
              step="any"
              min="1"
              required
              placeholder="z. B. 12"
              aria-describedby={`${ids}-upto-hint`}
              className="input-field"
              value={batchReadUpTo}
              onChange={e => setBatchReadUpTo(e.target.value)}
            />
            <span id={`${ids}-upto-hint`} className="text-[11px] text-slate-400 mt-1 block">
              Alle Bände im Besitz von Band 1 bis zu dieser Nummer erhalten den gewählten Status.
            </span>
          </div>

          {batchReadAction && (
            <div>
              <label htmlFor={`${ids}-read-date`} className="block text-xs font-semibold text-slate-300 mb-1">Gelesen am</label>
              <input
                id={`${ids}-read-date`}
                type="date"
                max={localDateString()}
                aria-describedby={`${ids}-read-date-hint`}
                className="input-field bg-slate-950 font-mono"
                value={readDate}
                onChange={e => setReadDate(e.target.value)}
              />
              <span id={`${ids}-read-date-hint`} className="text-[11px] text-slate-400 mt-1 block">
                Für nachgetragene Bände ein früheres Datum wählen; bereits gelesene Bände behalten ihr Datum.
              </span>
            </div>
          )}

          {message && (
            <p role="alert" className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl p-2.5">{message}</p>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary text-xs"
              disabled={loading}
            >
              Abbrechen
            </button>
            <button type="submit" disabled={loading} className="btn-primary text-xs flex items-center gap-1.5">
              <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" /> {loading ? 'Wird angewendet...' : 'Anwenden'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
