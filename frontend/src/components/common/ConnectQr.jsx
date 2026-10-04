import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, QrCode, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { get } from '../../utils/api';
import { notify } from '../../utils/notify';
import { encodeQr, qrPath } from '../../app/qr';
import { buildConnectLink } from '../../app/deepLink';
import { rich } from '../../i18n/react.jsx';
import { t } from '../../i18n/index.js';

const QR_BORDER = 4;

/** The address the app should use: the one this browser reached the server under, else what the server saw. */
export function connectAddress(data, loc = globalThis.location) {
  const own = loc?.origin;
  return typeof own === 'string' && /^https?:\/\//.test(own) ? own : data?.url || '';
}

function QrSvg({ text }) {
  const modules = useMemo(() => encodeQr(text), [text]);
  const size = modules.length + QR_BORDER * 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('QR-Code für die Manga-Shelf-App')} className="w-56 h-56 rounded-xl bg-white" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(modules, QR_BORDER)} fill="#000" />
    </svg>
  );
}

function ConnectDialog({ onClose, returnFocusRef }) {
  const dialogRef = useDialogA11y(true, { returnFocusRef, onClose });
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    get('/api/auth/connect-info', { signal: controller.signal, fallback: t('Verbindungsdaten nicht abrufbar') })
      .then((data) => setInfo(data))
      .catch((e) => { if (!controller.signal.aborted) setError(e?.message || t('Verbindungsdaten nicht abrufbar')); });
    return () => controller.abort();
  }, []);

  const address = info ? connectAddress(info) : '';
  const link = info ? buildConnectLink({ url: address, name: info.name, instanceId: info.instance_id }) : '';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      notify.success(t('Link kopiert'));
    } catch (_) {
      notify.error(t('Kopieren nicht möglich – bitte den Link markieren und kopieren.'));
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-qr-title"
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in text-left"
    >
      <div className="dialog-box glass-panel max-w-sm rounded-2xl sm:rounded-3xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 id="connect-qr-title" className="text-lg font-bold text-white">{t('Mit App verbinden')}</h2>
          <button type="button" onClick={onClose} aria-label={t('Schließen')} className="hit-44 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div role="status" className="sr-only">{info ? t('QR-Code bereit') : (error ? '' : t('Wird geladen…'))}</div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        {info && (
          <div className="flex flex-col items-center gap-3 text-sm text-slate-300">
            <QrSvg text={link} />
            <p className="text-center">
              {t('In der Manga-Shelf-App den Code mit der Kamera scannen oder den Link unter „Server hinzufügen“ einfügen.')}
            </p>
            <p className="text-xs text-slate-400 break-all text-center">{rich('Adresse: {address}', { address: <span className="font-mono text-slate-200">{address}</span> })}</p>
            <button type="button" onClick={copyLink} className="btn-secondary text-xs py-2 px-3 inline-flex items-center gap-1.5">
              <Copy className="w-3.5 h-3.5" aria-hidden="true" /> {t('Link kopieren')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Footer entry "Mit App verbinden" (web build, editors and admins): QR code with the manga-shelf://connect link. */
export default function ConnectQr({ className = '' }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        id="footer-connect-app"
        onClick={() => setOpen(true)}
        className={`hit-44 inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 font-medium cursor-pointer transition-colors ${className}`}
        title={t('QR-Code für die Manga-Shelf-App auf Handy oder Desktop anzeigen')}
      >
        <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
        {t('Mit App verbinden')}
      </button>
      {open && <ConnectDialog onClose={() => setOpen(false)} returnFocusRef={buttonRef} />}
    </>
  );
}
