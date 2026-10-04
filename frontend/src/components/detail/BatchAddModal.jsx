import { useEffect, useId, useState } from 'react';
import { Layers, X, Bookmark, Check, Coins, Plus } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { readApiError } from '../../hooks/useVolumeActions';
import { isValidPriceInput } from './volumeEdit/editorUtils';
import { apiFetch, readJson, TIMEOUTS } from '../../utils/api';
import { t as tr, tn } from '../../i18n/index.js';
import { currencySymbol, formatNumber } from '../../utils/format';
import { editionCurrency } from '../../utils/editions';

export const MAX_BATCH_VOLUMES = 300;

/** Range check before the request, same rules as POST /api/volumes/batch: whole numbers, from >= 1, at most 300 volumes. */
export function validateBatchRange(from, to) {
  const f = String(from ?? '').trim();
  const t = String(to ?? '').trim();
  if (!/^\d+$/.test(f) || !/^\d+$/.test(t)) return tr('Bitte ganze Bandnummern eingeben.');
  const start = parseInt(f, 10);
  const end = parseInt(t, 10);
  if (start < 1) return tr('Die Bandnummern beginnen bei 1.');
  if (start > end) return tr('„Von Band“ darf nicht größer als „Bis Band“ sein.');
  if (end - start + 1 > MAX_BATCH_VOLUMES) return tr('Höchstens {max} Bände auf einmal.', { max: MAX_BATCH_VOLUMES });
  return null;
}

/** "3 Bände angelegt, übersprungen (schon vorhanden): 4, 5" from the batch response. */
export function batchResultText({ created, skipped } = {}) {
  const count = Number(created) || 0;
  const list = Array.isArray(skipped) ? skipped : [];
  const made = tn('{n} Band angelegt', '{n} Bände angelegt', count);
  if (list.length === 0) return made;
  const shown = list.slice(0, 15).join(', ') + (list.length > 15 ? tr(' (+ {count} weitere)', { count: list.length - 15 }) : '');
  return tr('{made}, übersprungen (schon vorhanden): {shown}', { made, shown });
}

const pillClass = (active, tone) => `py-2 px-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 select-none ${
  active
    ? (tone === 'emerald'
      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/30'
      : 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/30')
    : 'text-slate-400 hover:text-slate-200 border border-transparent'
}`;

export default function BatchAddModal({ isOpen, onClose, manga, mangaId, onSuccess }) {
  const [batchFrom, setBatchFrom] = useState('1');
  const [batchTo, setBatchTo] = useState('10');
  const [batchStatus, setBatchStatus] = useState('Vorhanden');
  const [batchPrice, setBatchPrice] = useState('');
  const [batchPublisher, setBatchPublisher] = useState('');
  const [batchCondition, setBatchCondition] = useState('');
  const symbol = currencySymbol(editionCurrency(manga));
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState('');
  const ids = useId();

  useEffect(() => {
    if (!isOpen) return;
    setFormError('');
    setResult('');
  }, [isOpen]);

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  const priceInvalid = Boolean(batchPrice.trim()) && !isValidPriceInput(batchPrice);

  const handleBatchAdd = async (e) => {
    e.preventDefault();
    if (loading) return;
    const rangeError = validateBatchRange(batchFrom, batchTo);
    if (rangeError || priceInvalid) {
      setFormError(rangeError || tr('Ungültiger Preis'));
      return;
    }
    setFormError('');
    setResult('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/volumes/batch', {
        method: 'POST',
        body: {
          manga_id: mangaId,
          from: parseInt(batchFrom, 10),
          to: parseInt(batchTo, 10),
          status: batchStatus,
          default_price: batchPrice.trim() || null,
          publisher: batchPublisher.trim() || null,
          condition: batchCondition.trim() || null
        },
        timeout: TIMEOUTS.long
      });
      if (res.ok) {
        const data = (await readJson(res)) ?? {};
        setBatchPrice('');
        setBatchPublisher('');
        setBatchCondition('');
        const skipped = Array.isArray(data.skipped) ? data.skipped : [];
        // everything requested was created: nothing to report. Skipped numbers stay visible in the dialog.
        if (skipped.length === 0 && (Number(data.created) || 0) > 0) onClose();
        else setResult(batchResultText(data));
        if (onSuccess) await onSuccess();
      } else {
        setFormError(await readApiError(res, tr('Fehler beim Hinzufügen mehrerer Bände')));
      }
    } catch (err) {
      setFormError(tr('Netzwerkfehler'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={tr('Bände hinzufügen')}
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="dialog-box glass-panel max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 mb-4 pb-3 short:mb-3 short:pb-2 border-b border-slate-800">
          <h2 className="min-w-0 pt-1.5 text-base font-bold text-white flex items-start gap-2 break-words">
            <Layers className="w-4 h-4 mt-0.5 shrink-0 text-brand-400" aria-hidden="true" /> <span className="min-w-0">{tr('Mehrere Bände auf einmal hinzufügen')}</span>
          </h2>
          <button type="button" onClick={onClose} disabled={loading} aria-label={tr('Schließen')} title={tr('Schließen')} className="hit-44 shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-slate-800/40 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          {tr('Fügt automatisch alle Bände in einem Zahlenbereich hinzu (höchstens {max}). Bereits vorhandene Bände werden übersprungen; Schuber und Sonderausgaben mit derselben Nummer zählen nicht.', { max: MAX_BATCH_VOLUMES })}
        </p>

        <form onSubmit={handleBatchAdd} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${ids}-from`} className="block text-xs font-semibold text-slate-300 mb-1">{tr('Von Band')}</label>
              <input
                id={`${ids}-from`}
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                required
                className="input-field"
                value={batchFrom}
                onChange={e => setBatchFrom(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${ids}-to`} className="block text-xs font-semibold text-slate-300 mb-1">{tr('Bis Band')}</label>
              <input
                id={`${ids}-to`}
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                required
                className="input-field"
                value={batchTo}
                onChange={e => setBatchTo(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <div>
              <span id={`${ids}-status`} className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Bookmark className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {tr('Startstatus')}
              </span>
              <div role="group" aria-labelledby={`${ids}-status`} className="grid grid-cols-2 p-1 bg-slate-950/90 rounded-xl border border-slate-800 gap-1.5 shadow-inner">
                <button
                  type="button"
                  aria-pressed={batchStatus === 'Vorhanden'}
                  onClick={() => setBatchStatus('Vorhanden') /* i18n-ignore: stored status value */}
                  className={pillClass(batchStatus === 'Vorhanden', 'emerald')}
                >
                  <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5]" aria-hidden="true" />
                  <span>{tr('Im Besitz')}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={batchStatus === 'Fehlt'}
                  onClick={() => setBatchStatus('Fehlt') /* i18n-ignore: stored status value */}
                  className={pillClass(batchStatus === 'Fehlt', 'rose')}
                >
                  <X className="w-3.5 h-3.5 text-rose-400 stroke-[2.5]" aria-hidden="true" />
                  <span>{tr('Fehlt noch')}</span>
                </button>
              </div>
            </div>
            <div>
              <label htmlFor={`${ids}-price`} className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
                <Coins className="w-3.5 h-3.5" aria-hidden="true" /> {tr('Preis pro Band ({symbol}, optional)', { symbol })}
              </label>
              <div className="relative">
                <input
                  id={`${ids}-price`}
                  type="text"
                  inputMode="decimal"
                  placeholder={tr('z. B. {price}', { price: formatNumber(7.99, 2) })}
                  aria-invalid={priceInvalid || undefined}
                  aria-describedby={priceInvalid ? `${ids}-price-error` : undefined}
                  className={`input-field text-base sm:text-xs font-mono placeholder:font-sans placeholder:font-normal text-emerald-300 ${symbol.length > 1 ? 'pr-14' : 'pr-8'} py-2.5 font-bold ${priceInvalid ? 'border-rose-500/70 focus:border-rose-500' : 'border-emerald-500/40 focus:border-emerald-500'}`}
                  value={batchPrice}
                  onChange={e => setBatchPrice(e.target.value)}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none" aria-hidden="true">{symbol}</span>
              </div>
              {priceInvalid && (
                <p id={`${ids}-price-error`} className="text-[11px] text-rose-300 mt-1">{tr('Ungültiger Preis (z. B. 7,99)')}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${ids}-publisher`} className="block text-xs font-semibold text-slate-300 mb-1">{tr('Verlag (optional)')}</label>
              <input
                id={`${ids}-publisher`}
                type="text"
                placeholder={manga?.publisher || tr('z. B. Carlsen')}
                className="input-field text-base sm:text-xs"
                value={batchPublisher}
                onChange={e => setBatchPublisher(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${ids}-condition`} className="block text-xs font-semibold text-slate-300 mb-1">{tr('Zustand (optional)')}</label>
              <select
                id={`${ids}-condition`}
                className="input-field bg-slate-950 text-base sm:text-xs"
                value={batchCondition}
                onChange={e => setBatchCondition(e.target.value)}
              >
                <option value="">{tr('-- Keine Angabe --')}</option>
                <option value="Neuwertig">{tr('Neuwertig')}</option>
                <option value="Sehr gut">{tr('Sehr gut')}</option>
                <option value="Gut">{tr('Gut')}</option>
                <option value="Akzeptabel">{tr('Akzeptabel')}</option>
                <option value="Mängelexemplar">{tr('Mängelexemplar')}</option>
              </select>
            </div>
          </div>

          {formError && (
            <p role="alert" className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl p-2.5">{formError}</p>
          )}
          {result && (
            <p role="status" className="text-xs text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-2.5">{result}</p>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary text-xs"
              disabled={loading}
            >
              {result ? tr('Schließen') : tr('Abbrechen')}
            </button>
            <button type="submit" disabled={loading} className="btn-primary text-xs flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {loading ? tr('Wird generiert...') : tr('Bände generieren')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
