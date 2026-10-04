import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Flashlight, FlashlightOff, LoaderCircle, ScanBarcode, X } from 'lucide-react';
import { isIsbnBarcode, pickIsbnBarcode } from '../../utils/scanHelpers';
import { haptic } from '../../utils/haptics';
import useDialogA11y from '../../hooks/useDialogA11y';

export const SCAN_INTERVAL_MS = 125;
export const SAME_ISBN_PAUSE_MS = 2000;
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a'];
const HIT_FLASH_MS = 400;

/** German text for a failed camera start. */
export function cameraErrorText(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Kein Zugriff auf die Kamera. Erlaube sie in den Browser-Einstellungen oder fotografiere den Barcode.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Keine passende Kamera gefunden.';
    case 'NotReadableError':
      return 'Die Kamera wird gerade von einer anderen App benutzt.';
    default:
      return 'Die Kamera ließ sich nicht starten.';
  }
}

/** Ignores the same ISBN within `pauseMs` (a barcode stays in view for several frames). */
export function createScanDebounce(pauseMs = SAME_ISBN_PAUSE_MS, now = () => Date.now()) {
  let last = null;
  let lastAt = 0;
  return (isbn) => {
    const t = now();
    if (isbn === last && t - lastAt < pauseMs) return false;
    last = isbn;
    lastAt = t;
    return true;
  };
}

async function startZxing(stream, video, onCode) {
  const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library')
  ]);
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]]]);
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: SCAN_INTERVAL_MS });
  return reader.decodeFromStream(stream, video, (result) => {
    if (result) onCode(result.getText());
  });
}

/**
 * Full-screen live barcode scanner (rear camera): native BarcodeDetector at about 8 frames per second, else ZXing with
 * EAN hints on the same stream. Torch toggle where the camera offers it. Every new ISBN calls onDetected; without
 * `continuous` the scanner closes after the first one. `children` is shown under the viewfinder (e.g. the scan list).
 */
export default function LiveScanner({
  onDetected, onClose, onPhotoFallback, continuous = false, title = 'Barcode scannen', children = null,
  mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  Detector = typeof window === 'undefined' ? undefined : window.BarcodeDetector
}) {
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const [phase, setPhase] = useState('starting');
  const [error, setError] = useState('');
  const [torch, setTorch] = useState({ supported: false, on: false });
  const [flash, setFlash] = useState(false);
  const [lastIsbn, setLastIsbn] = useState('');
  const handlersRef = useRef({ onDetected, onClose, continuous });
  handlersRef.current = { onDetected, onClose, continuous };
  const dialogRef = useDialogA11y(true, { onClose });

  const close = useCallback(() => handlersRef.current.onClose?.(), []);

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let timer = null;
    let flashTimer = null;
    let controls = null;
    const accept = createScanDebounce();

    const onCode = (raw) => {
      const isbn = String(raw || '').replace(/[^0-9X]/gi, '');
      if (cancelled || !isIsbnBarcode(isbn) || !accept(isbn)) return;
      haptic('success', { sound: true });
      setLastIsbn(isbn);
      setFlash(true);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setFlash(false), HIT_FLASH_MS);
      const { onDetected: report, continuous: keepOpen, onClose: done } = handlersRef.current;
      report?.(isbn);
      if (!keepOpen) {
        cancelled = true;
        done?.();
      }
    };

    const start = async () => {
      try {
        stream = await mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (cancelled) return;
        const video = videoRef.current;
        const [track] = stream.getVideoTracks();
        trackRef.current = track || null;
        setTorch({ supported: Boolean(track?.getCapabilities?.()?.torch), on: false });
        video.srcObject = stream;
        await video.play?.();
        if (cancelled) return;
        setPhase('scanning');
        if (typeof Detector === 'function') {
          const detector = new Detector({ formats: NATIVE_FORMATS });
          const tick = async () => {
            if (cancelled) return;
            try {
              if (video.readyState >= 2) onCode(pickIsbnBarcode(await detector.detect(video)));
            } catch (_) {
              // a frame the detector cannot read; the next one follows
            }
            if (!cancelled) timer = setTimeout(tick, SCAN_INTERVAL_MS);
          };
          tick();
        } else {
          controls = await startZxing(stream, video, onCode);
          if (cancelled) controls.stop();
        }
      } catch (err) {
        if (cancelled) return;
        setError(cameraErrorText(err));
        setPhase('error');
      }
    };
    start();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(flashTimer);
      controls?.stop();
      for (const track of stream?.getTracks() || []) track.stop();
      trackRef.current = null;
    };
  }, [mediaDevices, Detector]);

  const toggleTorch = async () => {
    const next = !torch.on;
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ torch: next }] });
      setTorch((t) => ({ ...t, on: next }));
    } catch (_) {
      setTorch({ supported: false, on: false });
    }
  };

  const switchToPhoto = () => {
    close();
    onPhotoFallback?.();
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
      className="fixed inset-0 z-[60] bg-black text-white flex flex-col focus:outline-none"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-sm font-bold flex items-center gap-2">
          <ScanBarcode className="w-5 h-5 text-indigo-300" aria-hidden="true" /> {title}
        </p>
        <button
          type="button"
          onClick={close}
          className="w-11 h-11 -m-1 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20"
          aria-label="Scanner schließen"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <video ref={videoRef} muted playsInline autoPlay className="absolute inset-0 w-full h-full object-cover" aria-hidden="true" />
        {phase !== 'error' && (
          <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className={`w-[78%] max-w-md aspect-[2/1] rounded-2xl border-4 transition-colors shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] ${flash ? 'border-emerald-400' : 'border-white/80'}`} />
          </div>
        )}
        {phase === 'starting' && (
          <p role="status" className="absolute inset-x-0 bottom-6 flex items-center justify-center gap-2 text-sm text-slate-200">
            <LoaderCircle className="w-4 h-4 animate-spin" aria-hidden="true" /> Kamera wird gestartet…
          </p>
        )}
        {phase === 'error' && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center bg-slate-950/90">
            <p className="text-sm text-slate-200 max-w-sm">{error}</p>
            {onPhotoFallback && (
              <button type="button" onClick={switchToPhoto} className="btn-primary flex items-center gap-2 px-5 py-3">
                <Camera className="w-4 h-4" aria-hidden="true" /> Foto aufnehmen
              </button>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-3 space-y-3 bg-slate-950/95">
        <p role="status" aria-live="polite" className="text-xs text-slate-300 text-center min-h-[1rem]">
          {lastIsbn ? `Erkannt: ${lastIsbn}` : (phase === 'scanning' ? 'Barcode der Buchrückseite in den Rahmen halten' : '')}
        </p>
        {children}
        <div className="flex items-center justify-center gap-3">
          {torch.supported && (
            <button
              type="button"
              onClick={toggleTorch}
              aria-pressed={torch.on}
              className="min-h-[44px] px-4 rounded-full bg-white/10 hover:bg-white/20 flex items-center gap-2 text-sm"
            >
              {torch.on ? <FlashlightOff className="w-4 h-4" aria-hidden="true" /> : <Flashlight className="w-4 h-4" aria-hidden="true" />}
              Licht
            </button>
          )}
          {onPhotoFallback && phase !== 'error' && (
            <button type="button" onClick={switchToPhoto} className="min-h-[44px] px-4 rounded-full bg-white/10 hover:bg-white/20 flex items-center gap-2 text-sm">
              <Camera className="w-4 h-4" aria-hidden="true" /> Foto statt Live-Bild
            </button>
          )}
          <button type="button" onClick={close} className="min-h-[44px] px-5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-sm font-semibold">
            Fertig
          </button>
        </div>
      </div>
    </div>
  );
}
