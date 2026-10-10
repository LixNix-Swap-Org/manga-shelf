// LiveScanner and its helpers, with a BarcodeDetector stand-in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BarcodeFormat } from '@zxing/library';
import LiveScanner, { cameraErrorText, createScanDebounce, NATIVE_TEXTS, SAME_ISBN_PAUSE_MS } from '../components/common/LiveScanner';
import BarcodeScannerButton from '../components/common/BarcodeScannerButton';
import { buildScanPrefill, liveScanSupported } from '../utils/scanHelpers';

const zxing = vi.hoisted(() => ({ calls: [], stop: null }));
vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    constructor(hints, options) {
      zxing.calls.push({ hints, options });
    }

    decodeFromStream(stream, video, callback) {
      zxing.calls.push({ stream, video });
      callback(null);
      callback({ getText: () => '9783551762931' });
      return Promise.resolve({ stop: zxing.stop });
    }
  }
}));

const ISBN = '9783551762931';
const LINK = 'manga-shelf://connect?url=https%3A%2F%2Fmanga.example&name=Zuhause&id=inst-1';

function fakeCamera({ torch = true } = {}) {
  const track = {
    stop: vi.fn(),
    getCapabilities: () => (torch ? { torch: true } : {}),
    applyConstraints: vi.fn(async () => {})
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const mediaDevices = { getUserMedia: vi.fn(async () => stream) };
  return { track, stream, mediaDevices };
}

/** BarcodeDetector stand-in: answers each detect() with the next list of barcodes (then nothing). */
function fakeDetector(answers) {
  const queue = [...answers];
  const Detector = vi.fn(function Detector(options) {
    this.options = options;
    this.detect = vi.fn(async () => queue.shift() || []);
  });
  return Detector;
}

beforeEach(() => {
  zxing.calls.length = 0;
  zxing.stop = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete HTMLMediaElement.prototype.readyState;
});

describe('live scanner helpers', () => {
  it('needs a secure context with getUserMedia', () => {
    expect(liveScanSupported({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia: () => {} } } })).toBe(true);
    expect(liveScanSupported({ isSecureContext: false, navigator: { mediaDevices: { getUserMedia: () => {} } } })).toBe(false);
    expect(liveScanSupported({ isSecureContext: true, navigator: {} })).toBe(false);
    expect(liveScanSupported(null)).toBe(false);
  });

  it('ignores the same ISBN for two seconds, a different one at once', () => {
    let t = 0;
    const accept = createScanDebounce(SAME_ISBN_PAUSE_MS, () => t);
    expect(accept(ISBN)).toBe(true);
    t = 1500;
    expect(accept(ISBN)).toBe(false);
    expect(accept('9783551762948')).toBe(true);
    t = 1600;
    expect(accept(ISBN)).toBe(true);
    t = 3700;
    expect(accept(ISBN)).toBe(true);
  });

  it('names camera errors in German', () => {
    expect(cameraErrorText({ name: 'NotAllowedError' })).toMatch(/Kein Zugriff auf die Kamera/);
    expect(cameraErrorText({ name: 'NotFoundError' })).toBe('Keine passende Kamera gefunden.');
    expect(cameraErrorText(new Error('x'))).toBe('Die Kamera ließ sich nicht starten.');
    expect(cameraErrorText({ name: 'NotAllowedError' }, true)).toBe('Kein Zugriff auf die Kamera. Erlaube sie in den Browser-Einstellungen.');
  });
});

describe('LiveScanner', () => {
  it('opens the rear camera, reports each new ISBN once and stays open in continuous mode', async () => {
    const camera = fakeCamera();
    const Detector = fakeDetector([[{ rawValue: '4006381333931', format: 'ean_13' }], [{ rawValue: ISBN, format: 'ean_13' }], [{ rawValue: ISBN, format: 'ean_13' }]]);
    const onDetected = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <LiveScanner continuous onDetected={onDetected} onClose={onClose} mediaDevices={camera.mediaDevices} Detector={Detector}>
        <p>Liste</p>
      </LiveScanner>
    );
    expect(screen.getByRole('dialog', { name: 'Barcode scannen' })).toBeTruthy();
    expect(camera.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(ISBN));
    await new Promise((r) => setTimeout(r, 300));
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(Detector).toHaveBeenCalledWith({ formats: ['ean_13', 'ean_8', 'upc_a'] });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(`Erkannt: ${ISBN}`)).toBeTruthy();
    expect(screen.getByText('Liste')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Licht' }));
    await waitFor(() => expect(camera.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }));
    expect(screen.getByRole('button', { name: 'Licht' }).getAttribute('aria-pressed')).toBe('true');

    unmount();
    expect(camera.track.stop).toHaveBeenCalled();
  });

  it('closes after the first ISBN without continuous mode', async () => {
    const camera = fakeCamera({ torch: false });
    const onDetected = vi.fn();
    const onClose = vi.fn();
    render(<LiveScanner onDetected={onDetected} onClose={onClose} mediaDevices={camera.mediaDevices} Detector={fakeDetector([[{ rawValue: ISBN }]])} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onDetected).toHaveBeenCalledWith(ISBN);
    expect(screen.queryByRole('button', { name: 'Licht' })).toBeNull();
  });

  it('without BarcodeDetector ZXing decodes the same stream with EAN hints', async () => {
    const camera = fakeCamera();
    const onDetected = vi.fn();
    const { unmount } = render(<LiveScanner continuous onDetected={onDetected} onClose={vi.fn()} mediaDevices={camera.mediaDevices} Detector={undefined} />);
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith(ISBN));
    const [{ hints, options }, { stream }] = zxing.calls;
    expect([...hints.values()][0]).toHaveLength(3);
    expect(options.delayBetweenScanAttempts).toBe(125);
    expect(stream).toBe(camera.stream);
    unmount();
    expect(zxing.stop).toHaveBeenCalled();
  });

  it('a refused camera shows the reason and offers the photo instead', async () => {
    const mediaDevices = { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }) };
    const onClose = vi.fn();
    const onPhotoFallback = vi.fn();
    render(<LiveScanner onDetected={vi.fn()} onClose={onClose} onPhotoFallback={onPhotoFallback} mediaDevices={mediaDevices} Detector={undefined} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Kein Zugriff auf die Kamera/);
    fireEvent.click(screen.getByRole('button', { name: 'Foto aufnehmen' }));
    expect(onClose).toHaveBeenCalled();
    expect(onPhotoFallback).toHaveBeenCalled();
  });

  it('closed before the camera answered: the late stream is stopped at once', async () => {
    const camera = fakeCamera();
    let grant;
    camera.mediaDevices.getUserMedia = vi.fn(() => new Promise((resolve) => { grant = resolve; }));
    const { container, unmount } = render(<LiveScanner onDetected={vi.fn()} onClose={vi.fn()} mediaDevices={camera.mediaDevices} Detector={fakeDetector([])} />);
    const video = container.querySelector('video');
    unmount();
    await act(async () => { grant(camera.stream); });
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject ?? null).toBeNull();
  });

  it('closing releases the video element as well as the tracks', async () => {
    const camera = fakeCamera();
    const { container, unmount } = render(<LiveScanner onDetected={vi.fn()} onClose={vi.fn()} mediaDevices={camera.mediaDevices} Detector={fakeDetector([])} />);
    const video = container.querySelector('video');
    await waitFor(() => expect(video.srcObject).toBe(camera.stream));
    unmount();
    expect(video.srcObject).toBeNull();
    expect(camera.track.stop).toHaveBeenCalled();
  });

  it('pads for every safe area and sizes the guide frame by width and height (landscape phones)', async () => {
    const camera = fakeCamera();
    const { container } = render(<LiveScanner onDetected={vi.fn()} onClose={vi.fn()} mediaDevices={camera.mediaDevices} Detector={fakeDetector([])} />);
    // jsdom drops env() from inline styles, so the source is checked
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../components/common/LiveScanner.jsx'), 'utf8');
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) expect(source).toContain(`padding${side}: 'env(safe-area-inset-${side.toLowerCase()})'`);
    const guide = container.querySelector('[data-scan-guide]');
    expect(guide.className).toContain('supports-[width:1cqw]:w-[min(78cqw,28rem,150cqh)]');
    expect(guide.className).toContain('aspect-[2/1]');
    expect(guide.parentElement.className).toContain('[container-type:size]');
    await act(async () => {});
  });

  it('Escape and the close button end the scan', async () => {
    const camera = fakeCamera();
    const onClose = vi.fn();
    render(<LiveScanner onDetected={vi.fn()} onClose={onClose} mediaDevices={camera.mediaDevices} Detector={fakeDetector([])} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Scanner schließen' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });
});

describe('LiveScanner for QR codes', () => {
  const nativeBridge = ({ barcodes = [], camera = 'granted' } = {}) => ({
    platform: 'ios',
    plugins: { BarcodeScanner: { scan: vi.fn(async () => ({ barcodes })), requestPermissions: vi.fn(async () => ({ camera })) } },
    constants: { BarcodeFormat: { QrCode: 'QR_CODE', Ean13: 'EAN_13', Ean8: 'EAN_8', UpcA: 'UPC_A' } }
  });

  it('asks BarcodeDetector for QR codes only and reports the first text once, verbatim, then closes', async () => {
    const camera = fakeCamera();
    const Detector = fakeDetector([[{ rawValue: LINK, format: 'qr_code' }], [{ rawValue: LINK, format: 'qr_code' }]]);
    const onDetected = vi.fn();
    const onClose = vi.fn();
    render(<LiveScanner formats="qr" onDetected={onDetected} onClose={onClose} mediaDevices={camera.mediaDevices} Detector={Detector} />);
    expect(screen.getByRole('dialog', { name: 'QR-Code scannen' })).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(Detector).toHaveBeenCalledWith({ formats: ['qr_code'] });
    await new Promise((r) => setTimeout(r, 300));
    expect(onDetected.mock.calls).toEqual([[LINK]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows its own hint and a square guide', async () => {
    const camera = fakeCamera();
    const { container } = render(<LiveScanner formats="qr" onDetected={vi.fn()} onClose={vi.fn()} mediaDevices={camera.mediaDevices} Detector={fakeDetector([])} />);
    expect(await screen.findByText('QR-Code in den Rahmen halten')).toBeTruthy();
    expect(container.querySelector('[data-scan-guide]').className).toContain('aspect-square');
  });

  it('without BarcodeDetector ZXing gets the QR hint', async () => {
    const camera = fakeCamera();
    const onDetected = vi.fn();
    const onClose = vi.fn();
    render(<LiveScanner formats="qr" onDetected={onDetected} onClose={onClose} mediaDevices={camera.mediaDevices} Detector={undefined} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect([...zxing.calls[0].hints.values()][0]).toEqual([BarcodeFormat.QR_CODE]);
    expect(onDetected.mock.calls).toEqual([[ISBN]]);
  });

  it('in the app ML Kit scans QR codes only and the text is reported once', async () => {
    const bridge = nativeBridge({ barcodes: [{ rawValue: LINK, format: 'QR_CODE' }, { rawValue: 'zweiter', format: 'QR_CODE' }] });
    const onDetected = vi.fn();
    const onClose = vi.fn();
    render(<LiveScanner native={bridge} formats="qr" onDetected={onDetected} onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bridge.plugins.BarcodeScanner.scan).toHaveBeenCalledWith({ formats: ['QR_CODE'] });
    expect(onDetected.mock.calls).toEqual([[LINK]]);
  });

  it('in the app a refused camera explains itself without the photo hint', async () => {
    const bridge = nativeBridge({ camera: 'denied' });
    render(<LiveScanner native={bridge} formats="qr" onDetected={vi.fn()} onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toBe(NATIVE_TEXTS.deniedQr);
    expect(bridge.plugins.BarcodeScanner.scan).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'QR-Code scannen' })).toBeTruthy();
  });
});

describe('BarcodeScannerButton with live scanning', () => {
  it('opens the live scanner in a secure context and the photo picker otherwise', async () => {
    const camera = fakeCamera();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: camera.mediaDevices });
    try {
      render(<BarcodeScannerButton buttonText="Laden-Scan" continuous onDetected={vi.fn()} scannerChildren={<p>Feed</p>} />);
      fireEvent.click(screen.getByRole('button', { name: 'Laden-Scan' }));
      expect(await screen.findByRole('dialog', { name: 'Laden-Scan' })).toBeTruthy();
      expect(screen.getByText('Feed')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      delete window.isSecureContext;
      delete navigator.mediaDevices;
    }
    const { container } = render(<BarcodeScannerButton buttonText="Foto-Scan" onDetected={vi.fn()} />);
    const input = container.querySelector('input[type="file"]');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Foto-Scan' }));
    expect(click).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('scan prefill cover', () => {
  const cover = (url) => buildScanPrefill({ title: 'X', cover_url: url }, '978').form.cover_image;

  it('asks Open Library itself for a 404 instead of its placeholder, never another host that only names it', () => {
    expect(cover('https://covers.openlibrary.org/b/isbn/978-L.jpg')).toBe('https://covers.openlibrary.org/b/isbn/978-L.jpg?default=false');
    expect(cover('https://openlibrary.org/b/isbn/978-L.jpg')).toBe('https://openlibrary.org/b/isbn/978-L.jpg?default=false');
    expect(cover('https://covers.openlibrary.org/b/isbn/978-L.jpg?default=false')).toBe('https://covers.openlibrary.org/b/isbn/978-L.jpg?default=false');
    for (const other of ['https://evil.test/openlibrary.org/a.jpg', 'https://openlibrary.org.evil.test/a.jpg', 'https://notopenlibrary.org/a.jpg', 'covers.openlibrary.org/a.jpg']) {
      expect(cover(other)).toBe(other);
    }
    expect(cover('')).toBe('');
  });
});
