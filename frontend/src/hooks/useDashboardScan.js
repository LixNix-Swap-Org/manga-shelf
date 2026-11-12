// Scans and shares on the dashboard (split from Dashboard.jsx): a scanned ISBN opens its series, offers a choice, prefills
// "Neuer Manga" or says why not; a shared text goes to the anime share dialog or is looked up like a scan. Returns the
// scan handler for the header.
import { useEffect, useRef } from 'react';
import { notify } from '../utils/notify';
import { apiFetch, readJson, TIMEOUTS } from '../utils/api';
import { buildScanPrefill, parseSharedScan } from '../utils/scanHelpers';
import { lookupLocalIsbn } from '../utils/offlineStore';
import { viewSearch, scanDashboardAction, SCAN_OFFLINE_MESSAGE, SCAN_FAILED_MESSAGE } from '../components/dashboard/dashboardShell';
import { findStreamingLink } from '../utils/shareIntake';
import { SHARE_LINK_EVENT, takePendingShare } from '../app/deepLink';
import { t } from '../i18n/index.js';

const ANIME_VIEW = 'anime';
// i18n
export const SHARED_NO_ISBN_MESSAGE = 'Im geteilten Text wurde keine ISBN gefunden.';
// i18n
export const SHARED_MP_LINK_MESSAGE = 'Manga-Passion-Link erkannt: Lege die Reihe an und übernimm die Daten per Auto-Fill.';

export default function useDashboardScan({ isOfflineMode, canEdit, openSeries, openAddWithPrefill, setScanChoice, share, location, navigate }) {
  const scanRequestRef = useRef(0);
  const scanToastRef = useRef(null);

  /** One scan message at a time in the app's toast stack; a busy or action message stays until replaced or closed. */
  const showScanToast = (kind, message, options) => {
    if (scanToastRef.current !== null) notify.dismiss(scanToastRef.current);
    scanToastRef.current = kind ? notify[kind](message, options) : null;
  };
  useEffect(() => () => {
    if (scanToastRef.current !== null) notify.dismiss(scanToastRef.current);
  }, []);

  const handleBarcodeDetected = async (scannedCode) => {
    const requestId = ++scanRequestRef.current;
    const isLatest = () => requestId === scanRequestRef.current;
    // a volume of the offline copy opens its series at once, also offline and without asking the server
    const local = await lookupLocalIsbn(scannedCode);
    if (!isLatest()) return;
    if (local?.manga) {
      showScanToast(null);
      openSeries(local.manga);
      return;
    }
    if (isOfflineMode) {
      showScanToast('error', t(SCAN_OFFLINE_MESSAGE));
      return;
    }
    showScanToast('info', t('ISBN {isbn} wird gesucht...', { isbn: scannedCode }), { duration: 0 });
    let res;
    let data;
    try {
      res = await apiFetch(`/api/lookup/isbn?isbn=${encodeURIComponent(scannedCode)}`, { timeout: TIMEOUTS.lookup });
      data = await readJson(res); // a proxy 502/504 answers with HTML
    } catch (_) {
      if (isLatest()) showScanToast('error', t(SCAN_FAILED_MESSAGE));
      return;
    }
    if (!isLatest()) return;
    const isbn = data?.isbn || scannedCode;
    const action = scanDashboardAction({ ok: res.ok, data, canEdit });
    switch (action.type) {
      case 'navigate':
        showScanToast(null);
        openSeries(action.manga);
        break;
      case 'choose':
        showScanToast(null);
        setScanChoice({ candidates: action.candidates, book: action.book, isbn });
        break;
      case 'prefill':
        showScanToast(null);
        openAddWithPrefill(buildScanPrefill(action.book, isbn));
        break;
      case 'notFound':
        showScanToast('info', action.message, action.canAdd ? {
          duration: 0,
          action: { label: t('Reihe manuell anlegen'), onClick: () => openAddWithPrefill(buildScanPrefill({}, isbn)) }
        } : { duration: 8000 });
        break;
      case 'notice':
        showScanToast('info', action.message, { duration: 8000 });
        break;
      default:
        showScanToast('error', action.message);
    }
  };

  // a shared text: a streaming link goes to the anime tab's confirmation, else an ISBN is looked up like a scan
  const handleSharedRef = useRef(null);
  handleSharedRef.current = (input, options) => {
    if (share.start(input, options)) return;
    const shared = parseSharedScan({ text: input.text || '', url: input.url || '' });
    if (shared?.isbn) handleBarcodeDetected(shared.isbn);
    else if (shared?.mpUrl && canEdit) {
      showScanToast('info', t(SHARED_MP_LINK_MESSAGE), { duration: 0, action: { label: t('Reihe anlegen'), onClick: () => openAddWithPrefill(null) } });
    } else showScanToast('info', t(SHARED_NO_ISBN_MESSAGE), { duration: 8000 });
  };

  // share target (manifest share_text / share_url): the parameters are removed at once, a streaming link opens ?view=anime
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('share_text') && !params.has('share_url')) return;
    const input = { text: params.get('share_text') || '', url: params.get('share_url') || '' };
    params.delete('share_text');
    params.delete('share_url');
    const rest = params.toString() ? `?${params}` : '';
    navigate({ search: findStreamingLink(input.text, input.url) ? viewSearch(rest, ANIME_VIEW) : rest }, { replace: true });
    // after the first paint: a toast stack mounted after the dashboard would miss a message sent during mount
    const timer = setTimeout(() => handleSharedRef.current(input, { switchView: false }), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  // app shells: a share that arrived before the dashboard mounted waits in deepLink.js, later ones come as an event
  useEffect(() => {
    const onShare = () => {
      const pending = takePendingShare();
      if (pending) handleSharedRef.current(pending);
    };
    const timer = setTimeout(onShare, 0);
    window.addEventListener(SHARE_LINK_EVENT, onShare);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(SHARE_LINK_EVENT, onShare);
    };
  }, []);

  return handleBarcodeDetected;
}
