import { useEffect, useId, useRef, useState } from 'react';
import { Handshake, Package, Pencil } from 'lucide-react';
import { ApiError, apiFetch, readJson } from '../../../utils/api';
import { formatDate, formatMoney, currencySymbol } from '../../../utils/format';
import { conditionLabel } from '../../../utils/enumLabels';
import { VOLUME_CONDITIONS } from '../../../utils/volumeHelpers';
import { isValidPriceInput } from './editorUtils';
import { t } from '../../../i18n/index.js';
import { serverText } from '../../../i18n/serverText.js';

// today as YYYY-MM-DD in local time (the upper bound of "Seit"); radarHelpers would pull a chunk of its own in here
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const NOT_LENT = 'none';
const OTHER_PERSON = 'name';

/** Who may change a copy: its owner, any editor for a household copy, an admin every copy (the server checks again). */
export const canChangeCopy = (copy, user, canEdit) => Boolean(canEdit && user)
  && (copy.owner_user_id === null || copy.owner_user_id === user.id || user.role === 'admin');

const formOf = (copy) => ({
  price: copy.price === null || copy.price === undefined ? '' : String(copy.price).replace('.', ','),
  purchase_date: copy.purchase_date || '',
  condition: copy.condition || '',
  lend: copy.lent_to ? (copy.lent_to_user_id ? String(copy.lent_to_user_id) : OTHER_PERSON) : NOT_LENT,
  lend_name: copy.lent_to && !copy.lent_to_user_id ? copy.lent_to : '',
  lend_at: copy.lent_at || ''
});

/** The PUT body of a form: price, date and condition always, the lending only when it changed. */
export function copyBody(form, copy) {
  const body = {
    price: form.price.trim() === '' ? null : form.price.trim(),
    purchase_date: form.purchase_date || null,
    condition: form.condition || null
  };
  const before = formOf(copy);
  const lendChanged = form.lend !== before.lend || form.lend_name.trim() !== before.lend_name || form.lend_at !== before.lend_at;
  if (!lendChanged) return body;
  if (form.lend === NOT_LENT) body.lent = null;
  else if (form.lend === OTHER_PERSON) body.lent = { name: form.lend_name.trim(), ...(form.lend_at ? { at: form.lend_at } : {}) };
  else body.lent = { user_id: Number(form.lend), ...(form.lend_at ? { at: form.lend_at } : {}) };
  return body;
}

/**
 * Every copy of a volume (volume_copies): owner (or the household), purchase price, date and condition, and who borrowed
 * it. A copy the user may change opens a small form; it saves with PUT /api/volumes/:id/copies/:copyId. `ownersVersion`
 * changes after an owners toggle: the copies are then read again from the series.
 */
export default function CopiesField({ volumeId, mangaId, copies: initialCopies, currentUser, canEdit, currency = 'EUR', ownersVersion = 0, onChanged }) {
  const [copies, setCopies] = useState(initialCopies || []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const firstField = useRef(null);
  const listRef = useRef(null);
  const returnTo = useRef(null);

  useEffect(() => { setCopies(initialCopies || []); }, [initialCopies, volumeId]);

  useEffect(() => {
    if (!ownersVersion || !mangaId) return undefined;
    let live = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/mangas/${mangaId}`);
        const data = res.ok ? await readJson(res) : null;
        const vol = data?.volumes?.find(v => v.id === volumeId);
        if (live && vol) setCopies(vol.copies || []);
      } catch {
        // the list stays as it was; the next opening of the editor reads it again
      }
    })();
    return () => { live = false; };
  }, [ownersVersion, mangaId, volumeId]);

  useEffect(() => {
    if (editing === null || accounts) return;
    apiFetch('/api/users/directory')
      .then(async (res) => setAccounts(res.ok ? ((await readJson(res))?.users || []) : []))
      .catch(() => setAccounts([]));
  }, [editing, accounts]);

  useEffect(() => {
    if (editing !== null) { firstField.current?.focus(); return; }
    // a closed form gives the focus back to its copy's "Bearbeiten"
    if (returnTo.current !== null) {
      listRef.current?.querySelector(`[data-copy="${returnTo.current}"] [data-edit]`)?.focus();
      returnTo.current = null;
    }
  }, [editing]);

  if (!volumeId || copies.length === 0) return null;

  const open = (copy) => {
    setError('');
    setEditing(copy.id);
    setForm(formOf(copy));
  };
  const close = () => { returnTo.current = editing; setEditing(null); setForm(null); setError(''); };
  const setField = (key) => (e) => { const value = e.target.value; setForm(prev => ({ ...prev, [key]: value })); };

  const save = async (copy) => {
    if (!isValidPriceInput(form.price)) { setError(t('Ungültiger Preis')); return; }
    if (form.lend === OTHER_PERSON && !form.lend_name.trim()) { setError(t('Bitte einen Namen eingeben')); return; }
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/volumes/${volumeId}/copies/${copy.id}`, { method: 'PUT', body: copyBody(form, copy) });
      const data = (await readJson(res)) ?? {};
      if (!res.ok) throw new ApiError(serverText(data) || t('Fehler beim Speichern'), { status: res.status, ref: data.ref ?? null });
      setCopies(data.copies || []);
      close();
      if (onChanged) onChanged(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const symbol = currencySymbol(currency);
  const others = (accounts || []).filter(a => a.id !== (copies.find(c => c.id === editing)?.owner_user_id));

  return (
    <div>
      <span className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
        <Package className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Exemplare')}
      </span>
      <ul ref={listRef} className="space-y-2" aria-label={t('Exemplare')}>
        {copies.map(copy => {
          const owner = copy.owner || t('Haushalt');
          const facts = [
            copy.price !== null && copy.price !== undefined ? formatMoney(copy.price, currency) : null,
            copy.purchase_date ? formatDate(copy.purchase_date) : null,
            copy.condition ? conditionLabel(copy.condition) : null
          ].filter(Boolean);
          const changeable = canChangeCopy(copy, currentUser, canEdit);
          return (
            <li key={copy.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs" data-copy={copy.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-white">{owner}</p>
                  <p className="text-slate-400">{facts.length ? facts.join(' · ') : t('Keine Angaben zum Kauf')}</p>
                  {copy.lent_to && (
                    <p className="text-violet-200 flex items-center gap-1 mt-0.5">
                      <Handshake className="w-3 h-3 shrink-0" aria-hidden="true" />
                      {copy.lent_at
                        ? t('Ausgeliehen an {name} seit {date}', { name: copy.lent_to, date: formatDate(copy.lent_at) })
                        : t('Ausgeliehen an {name}', { name: copy.lent_to })}
                    </p>
                  )}
                </div>
                {changeable && editing !== copy.id && (
                  <button
                    type="button"
                    onClick={() => open(copy)}
                    data-edit
                    className="hit-44 shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:text-white"
                    aria-label={t('Bearbeiten – Exemplar von {owner}', { owner })}
                  >
                    <Pencil className="w-3 h-3" aria-hidden="true" /> {t('Bearbeiten')}
                  </button>
                )}
              </div>

              {editing === copy.id && form && (
                <div
                  className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2"
                  data-busy={busy ? 'true' : undefined}
                  onKeyDown={(e) => {
                    // Enter in a field saves this copy, not the volume form around it; Escape closes only this form
                    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); if (!busy) save(copy); }
                    if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); close(); }
                  }}
                >
                  <div>
                    <label htmlFor={`${id}-price`} className="block text-[11px] text-slate-400 mb-1">{t('Kaufpreis ({symbol})', { symbol })}</label>
                    <input ref={firstField} id={`${id}-price`} type="text" inputMode="decimal" className="input-field" value={form.price} onChange={setField('price')} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-date`} className="block text-[11px] text-slate-400 mb-1">{t('Kaufdatum')}</label>
                    <input id={`${id}-date`} type="date" className="input-field" value={form.purchase_date} onChange={setField('purchase_date')} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-condition`} className="block text-[11px] text-slate-400 mb-1">{t('Zustand')}</label>
                    <select id={`${id}-condition`} className="input-field bg-slate-950" value={form.condition} onChange={setField('condition')}>
                      <option value="">{t('Keine Angabe')}</option>
                      {[...VOLUME_CONDITIONS, ...(form.condition && !VOLUME_CONDITIONS.includes(form.condition) ? [form.condition] : [])].map(c => (
                        <option key={c} value={c}>{conditionLabel(c)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`${id}-lend`} className="block text-[11px] text-slate-400 mb-1">{t('Ausgeliehen an')}</label>
                    <select id={`${id}-lend`} className="input-field bg-slate-950" value={form.lend} onChange={setField('lend')}>
                      <option value={NOT_LENT}>{t('Nicht verliehen')}</option>
                      {others.map(a => <option key={a.id} value={String(a.id)}>{a.username}</option>)}
                      {form.lend !== NOT_LENT && form.lend !== OTHER_PERSON && !others.some(a => String(a.id) === form.lend) && (
                        <option value={form.lend}>{copy.lent_to}</option>
                      )}
                      <option value={OTHER_PERSON}>{t('Andere Person…')}</option>
                    </select>
                  </div>
                  {form.lend !== NOT_LENT && (
                    <div>
                      <label htmlFor={`${id}-lend-at`} className="block text-[11px] text-slate-400 mb-1">{t('Seit')}</label>
                      <input id={`${id}-lend-at`} type="date" max={today()} className="input-field" value={form.lend_at} onChange={setField('lend_at')} />
                    </div>
                  )}
                  {form.lend === OTHER_PERSON && (
                    <div className="sm:col-span-3">
                      <label htmlFor={`${id}-lend-name`} className="block text-[11px] text-slate-400 mb-1">{t('Name')}</label>
                      <input id={`${id}-lend-name`} type="text" maxLength={64} className="input-field" value={form.lend_name} onChange={setField('lend_name')} />
                    </div>
                  )}
                  {error && <p role="alert" className="sm:col-span-3 text-xs text-red-400">{error}</p>}
                  <div className="sm:col-span-3 flex justify-end gap-2">
                    <button type="button" onClick={close} disabled={busy} className="btn-secondary text-xs px-3 py-1.5">{t('Abbrechen')}</button>
                    <button type="button" onClick={() => save(copy)} disabled={busy} className="btn-primary text-xs px-3 py-1.5">
                      {busy ? t('Speichert...') : t('Exemplar speichern')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
