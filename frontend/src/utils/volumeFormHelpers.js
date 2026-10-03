import { inferVolumeType } from './volumeHelpers.js';

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
    status: vol.status || 'Vorhanden',
    price: vol.price !== null && vol.price !== undefined ? String(vol.price) : '',
    publisher: vol.publisher || '',
    condition: vol.condition || '',
    release_date: vol.release_date || '',
    release_year: vol.release_year ? String(vol.release_year) : '',
    pages: vol.pages ? String(vol.pages) : '',
    isbn: vol.isbn || '',
    purchase_date: vol.purchase_date || '',
    notes: vol.notes || '',
    priority: String(vol.priority || 0),
    target_price: vol.target_price !== null && vol.target_price !== undefined ? String(vol.target_price) : '',
    cover_image: vol.cover_image || (volImages.length > 0 ? volImages[0] : ''),
    images: volImages
  };
};

/**
 * Merges the data found by the Manga-Passion lookup into the form. Existing input is only replaced where that is safe
 * (empty price / placeholder note, Schuber entries, a missing or stale cover). Returns the new form and what changed.
 */
export const applyLookupToForm = (prev, d, { forceCover = false } = {}) => {
  const updatedFields = [];
  const next = { ...prev };
  const isSchuber = prev.type === 'schuber' || String(prev.volume_number || '').toLowerCase().includes('schuber');

  if (d.volume_number && isSchuber && !prev.volume_number.toLowerCase().includes('schuber')) {
    next.volume_number = d.volume_number;
  }
  if (d.release_date) {
    next.release_date = d.release_date;
    updatedFields.push(`Erscheinungsdatum (${d.release_date})`);
  }
  if (d.release_year) {
    next.release_year = String(d.release_year);
    updatedFields.push(`Jahr (${d.release_year})`);
  }
  if (d.pages !== undefined && d.pages !== null) {
    next.pages = String(d.pages);
    updatedFields.push(`Seitenzahl (${d.pages})`);
  } else if (isSchuber) {
    next.pages = '';
  }
  if (d.isbn) {
    next.isbn = d.isbn;
    updatedFields.push('ISBN');
  } else if (isSchuber) {
    next.isbn = '';
  }
  if (d.price && (!prev.price || prev.price === '0' || prev.price === '0,00' || prev.price === '0.00' || isSchuber)) {
    next.price = String(d.price);
    updatedFields.push(`Kaufpreis (${d.price} €)`);
  }
  if (d.publisher) {
    next.publisher = d.publisher;
    updatedFields.push('Verlag');
  }
  if (d.notes && (!prev.notes || isSchuber || prev.notes === 'Das Abenteuer beginnt')) {
    next.notes = d.notes;
    updatedFields.push(`Titel (${d.notes})`);
  }
  if (d.cover_image) {
    const shouldUpdateCover = isSchuber || !prev.cover_image || forceCover || prev.cover_image.includes('1790518007122');
    if (shouldUpdateCover) {
      const oldCover = prev.cover_image;
      next.cover_image = d.cover_image;
      const otherImages = (prev.images || []).filter(u => u !== oldCover && u !== d.cover_image);
      next.images = Array.from(new Set([d.cover_image, ...otherImages]));
      updatedFields.push('Cover-Bild');
    }
  }
  return { next, updatedFields };
};
