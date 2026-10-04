import { lazy, Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, LoaderCircle } from 'lucide-react';
import { pickIsbnBarcode, isIsbnBarcode, computeScaledSize, liveScanSupported } from '../../utils/scanHelpers';
import { notify } from '../../utils/notify';
import { haptic } from '../../utils/haptics';
import { t } from '../../i18n/index.js';

// Below iOS Safari's canvas area limit (about 16.7 MP); a 12-48 MP photo drawn at full size can come out blank.
const MAX_DIM = 1600;
const RETRY_DIM = 2400;
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
const LiveScanner = lazy(() => import('./LiveScanner'));
// the iOS/Android app's ML Kit scanner (mobile/src/native-bridge.mjs); LiveScanner uses it instead of the page camera
const nativeScanAvailable = () => typeof window !== 'undefined' && Boolean(window.mangashelfNative?.plugins?.BarcodeScanner);

/** createImageBitmap, or an <img> for formats it rejects (e.g. HEIC outside Safari). */
async function loadImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
  } catch (bitmapErr) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (_) {
      URL.revokeObjectURL(url);
      throw bitmapErr;
    }
  }
}

function drawScaled(image, maxDim) {
  const { width, height } = computeScaledSize(image.width, image.height, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image.source, 0, 0, width, height);
  return canvas;
}

const releaseCanvas = (canvas) => {
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
};

async function detectNative(canvas) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const detector = new window.BarcodeDetector({ formats: NATIVE_FORMATS });
    return pickIsbnBarcode(await detector.detect(canvas));
  } catch (err) {
    console.warn('Native BarcodeDetector threw, falling back to ZXing:', err);
    return null;
  }
}

/** ZXing on downscaled canvases: a quick pass, then TRY_HARDER on a larger copy. decodeFromCanvas throws on a miss. */
async function decodeWithZxing(image, firstCanvas) {
  const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library')
  ]);
  const formats = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128];
  const hints = (tryHarder) => {
    const map = new Map([[DecodeHintType.POSSIBLE_FORMATS, formats]]);
    if (tryHarder) map.set(DecodeHintType.TRY_HARDER, true);
    return map;
  };
  const attempt = (canvas, tryHarder) => {
    try {
      return new BrowserMultiFormatReader(hints(tryHarder)).decodeFromCanvas(canvas)?.getText() || null;
    } catch (_) {
      return null;
    }
  };

  const quick = attempt(firstCanvas, false);
  if (quick) return quick;
  const larger = Math.max(image.width, image.height) > MAX_DIM ? drawScaled(image, RETRY_DIM) : null;
  try {
    return attempt(larger || firstCanvas, true);
  } finally {
    releaseCanvas(larger);
  }
}

// Scan button: LiveScanner (native ML Kit or live camera, secure contexts only), else/fallback a photo through a file
// input (works over plain HTTP): BarcodeDetector, then ZXing. `continuous` keeps the scanner open; `scannerChildren`
// renders inside it.
export default function BarcodeScannerButton({
  onDetected, className = '', buttonText = t('Barcode scannen'), compact = false, continuous = false, live = true,
  scannerTitle, scannerChildren = null, id, children
}) {
  const fileInputRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const openPhoto = () => fileInputRef.current?.click();

  const handleCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);

    let image = null;
    let canvas = null;
    try {
      image = await loadImage(file);
      canvas = drawScaled(image, MAX_DIM);

      const native = await detectNative(canvas);
      let detectedCode = isIsbnBarcode(native) ? native : null;
      if (!detectedCode) {
        try {
          detectedCode = await decodeWithZxing(image, canvas);
        } catch (zxingErr) {
          console.warn('ZXing decode attempt finished without hit:', zxingErr?.message || zxingErr);
        }
      }
      detectedCode = detectedCode || native;

      if (detectedCode) {
        const cleanIsbn = detectedCode.replace(/[^0-9X]/gi, '');
        haptic('success', { sound: true });
        onDetected(cleanIsbn || detectedCode);
      } else {
        haptic('error');
        notify.error(t('Kein Barcode erkannt. Bitte fotografiere den Barcode scharf, nah und gut ausgeleuchtet auf der Buchrückseite.'));
      }
    } catch (err) {
      console.error('Fehler beim Barcode-Scannen:', err);
      notify.error(t('Konnte Bild nicht analysieren: {reason}', { reason: err?.message || t('Unbekannter Fehler') }));
    } finally {
      releaseCanvas(canvas);
      image?.release();
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="inline-flex items-center">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleCapture}
      />
      <button
        type="button"
        id={id}
        disabled={scanning}
        aria-busy={scanning || undefined}
        aria-label={compact ? (scanning ? t('Scanne...') : buttonText) : undefined}
        onClick={(e) => {
          // the header search box focuses its input on any click inside it, which would pop up the keyboard
          e.stopPropagation();
          if (live && (nativeScanAvailable() || liveScanSupported())) setLiveOpen(true);
          else openPhoto();
        }}
        title={t('ISBN / EAN-Barcode per Kamera scannen (funktioniert auch ohne HTTPS)')}
        className={className || `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/80 hover:bg-indigo-600 active:bg-indigo-700 text-white transition shadow-sm active:scale-95 disabled:opacity-50`}
      >
        {children || (scanning ? (
          <>
            <LoaderCircle className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            {!compact && <span>{t('Scanne...')}</span>}
          </>
        ) : (
          <>
            <Camera className="w-3.5 h-3.5" aria-hidden="true" />
            {!compact && <span>{buttonText}</span>}
          </>
        ))}
      </button>
      {liveOpen && createPortal(
        <Suspense fallback={null}>
          <LiveScanner
            onDetected={onDetected}
            onClose={() => setLiveOpen(false)}
            onPhotoFallback={openPhoto}
            continuous={continuous}
            title={scannerTitle || buttonText}
          >
            {scannerChildren}
          </LiveScanner>
        </Suspense>,
        document.body
      )}
    </div>
  );
}
