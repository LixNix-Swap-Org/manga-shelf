import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus, ScanBarcode } from 'lucide-react';
import BarcodeScannerButton from '../common/BarcodeScannerButton';
import { useIsNarrow } from '../common/BottomNav';
import { isTypingTarget, useKeyboardOpen } from '../../hooks/useKeyboardOpen';
import { apiFetch, readJson, TIMEOUTS } from '../../utils/api';
import { notify } from '../../utils/notify';
import { scanSeriesTitle, toIsbn13 } from '../../utils/scanHelpers';

export const DETAIL_SCAN_OFFLINE = 'Die ISBN-Suche braucht eine Verbindung zum Server.';
export const DETAIL_SCAN_FAILED = 'ISBN-Suche fehlgeschlagen (Server nicht erreichbar).';

const sameId = (a, b) => a !== null && a !== undefined && String(a) === String(b);

/** The volume of this series with the scanned ISBN, from the loaded detail (works offline). */
export function findScannedVolume(volumes, code) {
  const isbn = toIsbn13(code);
  if (!isbn) return null;
  return (volumes || []).find((v) => v?.isbn && toIsbn13(v.isbn) === isbn) || null;
}

/**
 * Series-page action for an /api/lookup/isbn answer: open (volume of this series), other (another series),
 * prefill (possibly missing book, editors only), notice, notFound, error.
 */
export function detailScanAction({ ok, data, mangaId, canEdit }) {
  if (!ok || !data) {
    return { type: 'error', message: (data && typeof data.error === 'string' && data.error) || DETAIL_SCAN_FAILED };
  }
  const matched = data.found ? data.matched_manga : null;
  if (matched && !sameId(matched.id, mangaId)) return { type: 'other', manga: matched };
  if (matched && data.matched_volume) return { type: 'open', volume: data.matched_volume };
  const candidates = Array.isArray(data.matched_candidates) ? data.matched_candidates.filter((c) => c && c.id != null) : [];
  if (!matched && candidates.length && !candidates.some((c) => sameId(c.id, mangaId))) {
    return candidates.length === 1
      ? { type: 'other', manga: candidates[0] }
      : { type: 'notice', message: 'Diese ISBN passt zu einer anderen Reihe der Sammlung.' };
  }
  if (data.found && data.book) {
    if (!canEdit) return { type: 'notice', message: 'Dieser Band ist in der Reihe noch nicht erfasst.' };
    const book = data.book;
    return {
      type: 'prefill',
      number: book.volume_number_known ? String(book.volume_number ?? '').trim() : '',
      price: Number(book.price) > 0 ? String(book.price) : '',
      title: matched ? '' : scanSeriesTitle(book),
      isbn: (typeof data.isbn === 'string' && data.isbn) || (typeof book.isbn === 'string' && book.isbn) || ''
    };
  }
  return { type: 'notFound', message: (typeof data.message === 'string' && data.message) || 'Keine Daten zu dieser ISBN gefunden.' };
}

export { isTypingTarget, useKeyboardOpen };

/**
 * After focusing a field, once the keyboard has shrunk the visual viewport: centre the field and lift the submit
 * button 16 px above the keyboard if the field stays in view. Returns a function that stops waiting.
 */
export function revealAboveKeyboard(field, { timeout = 1500 } = {}) {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!field || !vv || typeof vv.addEventListener !== 'function') return () => {};
  let timer = null;
  const stop = () => {
    vv.removeEventListener('resize', onResize);
    clearTimeout(timer);
  };
  function onResize() {
    stop();
    if (document.activeElement !== field) return;
    const rect = field.getBoundingClientRect();
    const top = vv.offsetTop || 0;
    const bottom = top + vv.height;
    const submit = field.form?.querySelector('[type="submit"]')?.getBoundingClientRect();
    let delta = rect.top >= top + 16 && rect.bottom <= bottom - 16 ? 0 : rect.top - top - Math.max(0, (vv.height - rect.height) / 2);
    if (submit?.height > 0 && submit.bottom - delta > bottom - 16) {
      delta = Math.max(delta, Math.min(submit.bottom - (bottom - 16), rect.top - top - 16));
    }
    if (delta !== 0) window.scrollBy({ top: delta });
  }
  vv.addEventListener('resize', onResize);
  timer = setTimeout(stop, timeout);
  return stop;
}

const itemClass = 'relative flex-1 min-w-0 min-h-[56px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200 transition-colors';

/**
 * Phone context bar of a series page (below 640 px, like the dashboard's BottomNav): back, scan an ISBN (opens the
 * volume, or fills the add form with number and price) and "Band hinzufügen". Rendered into <body>.
 */
export default function DetailBottomBar({
  backTo = '/', mangaId, volumes, canEdit = false, isOffline = false, onOpenVolume, onPrefill, onOtherSeries, onAddVolume
}) {
  const narrow = useIsNarrow();
  const barRef = useRef(null);
  const keyboardOpen = useKeyboardOpen(barRef);
  const requestRef = useRef(0);
  const toastRef = useRef(null);

  const toast = (kind, message, options) => {
    if (toastRef.current !== null) notify.dismiss(toastRef.current);
    toastRef.current = kind ? notify[kind](message, options) : null;
  };

  const handleScan = async (code) => {
    const request = ++requestRef.current;
    const local = findScannedVolume(volumes, code);
    if (local) {
      toast(null);
      onOpenVolume?.(local);
      return;
    }
    if (isOffline) {
      toast('error', DETAIL_SCAN_OFFLINE);
      return;
    }
    toast('info', `ISBN ${code} wird gesucht...`, { duration: 0 });
    let res;
    let data = null;
    try {
      res = await apiFetch(`/api/lookup/isbn?isbn=${encodeURIComponent(code)}`, { timeout: TIMEOUTS.lookup });
      data = await readJson(res);
    } catch (_) {
      if (request === requestRef.current) toast('error', DETAIL_SCAN_FAILED);
      return;
    }
    if (request !== requestRef.current) return;
    const action = detailScanAction({ ok: res.ok, data, mangaId, canEdit });
    switch (action.type) {
      case 'open': {
        toast(null);
        const volume = (volumes || []).find((v) => sameId(v.id, action.volume.id)) || action.volume;
        onOpenVolume?.(volume);
        break;
      }
      case 'other':
        toast('info', `Diese ISBN gehört zu „${action.manga.title || 'einer anderen Reihe'}“.`, {
          duration: 8000,
          action: { label: 'Reihe öffnen', onClick: () => onOtherSeries?.(action.manga) }
        });
        break;
      case 'prefill':
        toast('info', action.number
          ? `Band ${action.number}${action.title ? ` (${action.title})` : ''} übernommen – bitte prüfen und hinzufügen.`
          : 'Bandnummer unbekannt – bitte eintragen und hinzufügen.', { duration: 8000 });
        onPrefill?.({ ...action, isbn: action.isbn || toIsbn13(code) || '' });
        break;
      case 'notice':
      case 'notFound':
        toast('info', action.message, { duration: 8000 });
        break;
      default:
        toast('error', action.message);
    }
  };

  if (!narrow || typeof document === 'undefined') return null;
  return createPortal(
    <nav
      ref={barRef}
      id="detail-bottom-bar"
      aria-label="Reihe"
      data-keyboard={keyboardOpen ? 'open' : undefined}
      className={`${keyboardOpen ? 'hidden' : ''} fixed inset-x-0 bottom-0 z-40 sm:hidden border-t border-slate-800/90 bg-slate-950/95 backdrop-blur-md shadow-[0_-8px_24px_rgba(0,0,0,0.35)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]`}
    >
      <div className="flex items-stretch justify-around max-w-lg mx-auto">
        <Link id="btn-detail-back" to={backTo} className={itemClass}>
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          Zurück
        </Link>
        <div className="flex-1 min-w-0 flex items-start justify-center">
          <BarcodeScannerButton
            id="btn-detail-scan"
            buttonText="Band scannen"
            scannerTitle="Band scannen"
            onDetected={handleScan}
            className="-mt-5 w-14 h-14 rounded-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-lg shadow-indigo-950/60 border-4 border-slate-950 flex items-center justify-center active:scale-95 transition disabled:opacity-60"
          >
            <ScanBarcode className="w-6 h-6" aria-hidden="true" />
            <span className="sr-only">Band scannen</span>
          </BarcodeScannerButton>
        </div>
        {canEdit ? (
          <button type="button" id="btn-detail-add-volume" onClick={onAddVolume} className={itemClass}>
            <Plus className="w-5 h-5" aria-hidden="true" />
            Band hinzufügen
          </button>
        ) : (
          <span className="flex-1" aria-hidden="true" />
        )}
      </div>
    </nav>,
    document.body
  );
}
