import { inferVolumeType } from './volumeHelpers.js';
import { t } from '../i18n/index.js';

/** Form state of the volume editor for a volume (strings for inputs, cover first in the image list). */
export const buildVolumeForm = (vol) => {
  const rawImages = Array.isArray(vol.images) ? vol.images : (vol.cover_image ? [vol.cover_image] : []);
  const volImages = [];
  if (vol.cover_image) volImages.push(vol.cover_image);
  rawImages.forEach(img => {
    if (img && !volImages.includes(img)) volImages.push(img);
  });
  const detectedType = inferVolumeType(vol);
  return {
    type: detectedType,
    volume_number: vol.volume_number || '',
    status: vol.status || 'Vorhanden', // i18n-ignore: stored status value
    price: vol.price !== null && vol.price !== undefined ? String(vol.price) : '',
    publisher: vol.publisher || '',
    condition: vol.condition || '',
    release_date: vol.release_date || '',
    release_year: vol.release_year ? String(vol.release_year) : '',
    pages: vol.pages ? String(vol.pages) : '',
    isbn: vol.isbn || '',
    purchase_date: vol.purchase_date || '',
    notes: vol.notes || '',
    // own edition language of the volume; '' = the series language (volumes.language NULL)
    language: vol.language || '',
    priority: String(vol.priority || 0),
    target_price: vol.target_price !== null && vol.target_price !== undefined ? String(vol.target_price) : '',
    cover_image: vol.cover_image || (volImages.length > 0 ? volImages[0] : ''),
    images: volImages
  };
};

/** Notes left by old demo data; a lookup replaces them like an empty note. Same list as services/mangaPassion/autofill.js. */
// i18n-ignore: stored demo notes, only compared, never shown
export const PLACEHOLDER_NOTES = ['Das Abenteuer beginnt'];

/** Upload names of covers known to be wrong (from an earlier import); a lookup replaces and drops them. */
export const STALE_COVER_MARKERS = ['1790518007122'];

const isStaleCover = (url) => STALE_COVER_MARKERS.some(marker => String(url || '').includes(marker));

const sameText = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
const sameIsbn = (a, b) => String(a ?? '').replace(/[^0-9X]/gi, '').toUpperCase() === String(b ?? '').replace(/[^0-9X]/gi, '').toUpperCase();
const samePrice = (a, b) => {
  const num = (v) => Number(String(v ?? '').replace(',', '.').replace(/[€\s]/g, ''));
  const x = num(a);
  const y = num(b);
  return String(a ?? '').trim() !== '' && String(b ?? '').trim() !== '' && Number.isFinite(x) && Number.isFinite(y) ? x === y : sameText(a, b);
};

/**
 * Merges a Manga-Passion lookup into the form; returns the new form and the labels of changed fields. Price and notes
 * only fill empty values (Schuber entries too); cover replaced when missing/stale/Schuber or `forceCover`, the old one moves to the gallery.
 */
export const applyLookupToForm = (prev, d, { forceCover = false } = {}) => {
  const updatedFields = [];
  const next = { ...prev };
  const prevNumber = String(prev.volume_number || '');
  const isSchuber = prev.type === 'schuber' || prevNumber.toLowerCase().includes('schuber');

  const setField = (key, value, label, same = sameText) => {
    if (same(prev[key], value)) return;
    next[key] = String(value);
    updatedFields.push(label);
  };
  const clearField = (key, label) => {
    if (String(prev[key] ?? '').trim() === '') return;
    next[key] = '';
    updatedFields.push(label);
  };

  if (d.volume_number && isSchuber && !prevNumber.toLowerCase().includes('schuber')) {
    setField('volume_number', d.volume_number, t('Nummer ({number})', { number: d.volume_number }));
  }
  if (d.release_date) setField('release_date', d.release_date, t('Erscheinungsdatum ({date})', { date: d.release_date }));
  if (d.release_year) setField('release_year', d.release_year, t('Jahr ({year})', { year: d.release_year }));
  if (d.pages !== undefined && d.pages !== null) {
    setField('pages', d.pages, t('Seitenzahl ({pages})', { pages: d.pages }));
  } else if (isSchuber) {
    clearField('pages', t('Seitenzahl entfernt'));
  }
  if (d.isbn) {
    setField('isbn', d.isbn, 'ISBN', sameIsbn);
  } else if (isSchuber) {
    clearField('isbn', t('ISBN entfernt'));
  }
  const hasPrice = prev.price && !samePrice(prev.price, '0');
  if (d.price && (!hasPrice || isSchuber)) {
    setField('price', d.price, t('Kaufpreis ({price} €)', { price: d.price }), samePrice);
  }
  if (d.publisher) setField('publisher', d.publisher, t('Verlag'));
  if (d.notes && (!prev.notes || isSchuber || PLACEHOLDER_NOTES.includes(prev.notes))) {
    setField('notes', d.notes, t('Titel ({title})', { title: d.notes }));
  }
  if (d.cover_image && d.cover_image !== prev.cover_image) {
    const oldCover = prev.cover_image;
    const shouldUpdateCover = isSchuber || !oldCover || forceCover || isStaleCover(oldCover);
    if (shouldUpdateCover) {
      next.cover_image = d.cover_image;
      const kept = [oldCover, ...(prev.images || [])].filter(u => u && !isStaleCover(u));
      next.images = Array.from(new Set([d.cover_image, ...kept]));
      updatedFields.push(t('Cover-Bild'));
    }
  }
  return { next, updatedFields };
};
