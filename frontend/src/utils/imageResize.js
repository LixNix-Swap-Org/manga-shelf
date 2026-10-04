export const RESIZE_DEFAULTS = { maxEdge: 1600, quality: 0.84, minBytes: 500 * 1024 };

// GIF may be animated; AVIF/HEIC decoding differs between browsers, the server takes them as they are
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Size with the longer edge at most `maxEdge`, never upscaled. */
export function fitWithin(width, height, maxEdge) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const jpegName = (name) => `${String(name || 'foto').replace(/\.[^./\\]*$/, '') || 'foto'}.jpg`;

function defaultCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Downscales to `maxEdge` and re-encodes as JPEG (which drops EXIF such as GPS). Returns the original for GIF and
// other types, files under `minBytes`, undecodable files and when the result would not be smaller.
export async function prepareImageForUpload(file, options = {}) {
  const { maxEdge, quality, minBytes } = { ...RESIZE_DEFAULTS, ...options };
  const decode = options.createImageBitmap ?? globalThis.createImageBitmap;
  const createCanvas = options.createCanvas ?? defaultCanvas;
  if (!file || !RESIZABLE_TYPES.has(file.type) || !(file.size >= minBytes) || typeof decode !== 'function') return file;
  let bitmap = null;
  let canvas = null;
  try {
    bitmap = await decode(file, { imageOrientation: 'from-image' });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // a transparent PNG would turn black as JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch (_) {
    return file;
  } finally {
    bitmap?.close?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/** prepareImageForUpload for several files, one after another (each decode holds a full-size bitmap in memory). */
export async function prepareImagesForUpload(files, options) {
  const out = [];
  for (const file of Array.from(files || [])) out.push(await prepareImageForUpload(file, options));
  return out;
}
