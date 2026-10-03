/** Series name of a catalogue hit: the catalogue's series if it knows one, else the book title (the DNB title is often only the volume title). */
export const scanSeriesTitle = (book) => String(book?.series || book?.title || '').trim();

/**
 * Prefill for "Neuen Manga anlegen" from an ISBN lookup (`/api/lookup/isbn`): series fields plus the scanned volume.
 * Open Library answers an unknown ISBN with a 1x1 placeholder unless `default=false` is set, so a missing cover 404s instead.
 */
export const buildScanPrefill = (book, isbn) => {
  const cover = book?.cover_url
    ? (/openlibrary\.org/.test(book.cover_url) && !/default=/.test(book.cover_url) ? `${book.cover_url}?default=false` : book.cover_url)
    : '';
  return {
    form: {
      title: scanSeriesTitle(book),
      author: book?.author || '',
      publisher: book?.publisher || '',
      cover_image: cover
    },
    volume: {
      enabled: true,
      volume_number: book?.volume_number_known ? String(book.volume_number) : '',
      status: 'Vorhanden',
      isbn: isbn || '',
      price: book?.price != null ? String(book.price) : '',
      pages: book?.pages ? String(book.pages) : '',
      release_year: book?.release_year ? String(book.release_year) : '',
      publisher: book?.publisher || ''
    }
  };
};

/** Body for `POST /api/volumes` from the scanned-volume form of the add dialog. */
export const buildScanVolumePayload = (mangaId, vol) => ({
  manga_id: mangaId,
  volume_number: String(vol.volume_number).trim(),
  status: vol.status || 'Vorhanden',
  isbn: vol.isbn || null,
  price: vol.price || null,
  pages: vol.pages || null,
  release_year: vol.release_year || null,
  publisher: vol.publisher || null
});
