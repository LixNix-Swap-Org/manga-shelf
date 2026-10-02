import { useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';

/**
 * BarcodeScannerButton
 * Resilient barcode scanner that works reliably over plain HTTP without WebRTC camera blocks.
 * Uses HTML5 capture="environment" file input, native BarcodeDetector API (Prio 1),
 * with dynamic fallback to ZXing browser reader (Prio 2).
 */
export default function BarcodeScannerButton({ onDetected, className = '', buttonText = 'Barcode scannen', compact = false }) {
  const fileInputRef = useRef(null);
  const [scanning, setScanning] = useState(false);

  const handleCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);

    try {
      // 1. Create ImageBitmap or Image element for decoding
      const imageBitmap = await createImageBitmap(file);

      // Downscale if image is gigantic (> 1600px) to speed up decoding on mobile
      let processSource = imageBitmap;
      const maxDim = 1600;
      if (imageBitmap.width > maxDim || imageBitmap.height > maxDim) {
        const scale = Math.min(maxDim / imageBitmap.width, maxDim / imageBitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(imageBitmap.width * scale);
        canvas.height = Math.round(imageBitmap.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
        processSource = canvas;
      }

      let detectedCode = null;

      // 2. Try native BarcodeDetector API (Hardware accelerated, supported on Chrome/Edge Android)
      if ('BarcodeDetector' in window) {
        try {
          const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
          const barcodes = await detector.detect(processSource);
          if (barcodes && barcodes.length > 0) {
            detectedCode = barcodes[0].rawValue;
          }
        } catch (detectorErr) {
          console.warn('Native BarcodeDetector threw, falling back to ZXing:', detectorErr);
        }
      }

      // 3. Fallback: Use ZXing browser library dynamically
      if (!detectedCode) {
        try {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const reader = new BrowserMultiFormatReader();
          let imgUrl = URL.createObjectURL(file);
          try {
            const result = await reader.decodeFromImageUrl(imgUrl);
            if (result && result.getText()) {
              detectedCode = result.getText();
            }
          } finally {
            URL.revokeObjectURL(imgUrl);
          }
        } catch (zxingErr) {
          console.warn('ZXing decode attempt finished without hit:', zxingErr?.message || zxingErr);
        }
      }

      if (detectedCode) {
        const cleanIsbn = detectedCode.replace(/[^0-9X]/gi, '');
        // Haptic feedback if supported
        if ('vibrate' in navigator) {
          try { navigator.vibrate([25, 40, 25]); } catch (_) {}
        }
        onDetected(cleanIsbn || detectedCode);
      } else {
        alert('Kein Barcode erkannt. Bitte fotografiere den Barcode scharf, nah und gut ausgeleuchtet auf der Buchrückseite.');
      }
    } catch (err) {
      console.error('Fehler beim Barcode-Scannen:', err);
      alert('Konnte Bild nicht analysieren: ' + (err.message || 'Unbekannter Fehler'));
    } finally {
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
        onChange={handleCapture}
      />
      <button
        type="button"
        disabled={scanning}
        onClick={() => fileInputRef.current?.click()}
        title="ISBN / EAN-Barcode per Kamera scannen (funktioniert auch ohne HTTPS)"
        className={className || `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/80 hover:bg-indigo-600 active:bg-indigo-700 text-white transition shadow-sm active:scale-95 disabled:opacity-50`}
      >
        {scanning ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {!compact && <span>Scanne...</span>}
          </>
        ) : (
          <>
            <Camera className="w-3.5 h-3.5" />
            {!compact && <span>{buttonText}</span>}
          </>
        )}
      </button>
    </div>
  );
}
