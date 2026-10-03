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

/**
 * Total volumes to prefill from a catalogue hit. For a running series the catalogue only knows the volumes released so far
 * (a fresh Dragon Maid scan listed "1"), which would show "1/1 complete"; leave it open instead.
 */
export const prefillTotalVolumes = (item, previous = '') => {
  if (!item?.total_volumes) return previous;
  if (/laufend|ongoing|releasing/i.test(String(item.status || ''))) return previous;
  return String(item.total_volumes);
};

/**
 * Einkaufsmodus: macht aus einer ISBN-Antwort (`/api/lookup/isbn`) einen Eintrag für die Scan-Liste.
 * kind: `buy` (steht auf der Einkaufsliste, `itemId` zum Abhaken), `owned`, `check` (Reihe bekannt, Band unklar/andere Reihe),
 * `new` (Reihe fehlt in der Sammlung), `unknown` (kein Katalogtreffer).
 */
export const classifyShopScan = (isbn, data, shoppingItems = []) => {
  const digits = (s) => String(s || '').replace(/[^0-9X]/gi, '');
  const clean = digits(isbn);
  const fromList = shoppingItems.find((it) => digits(it.isbn) && digits(it.isbn) === clean);
  const entry = (kind, label, extra = {}) => ({ isbn: clean, kind, label, ...extra });
  if (fromList) return entry('buy', `${fromList.title} ${fromList.volume_number}`.trim(), { itemId: fromList.id, price: fromList.price ?? null });

  const book = data?.book;
  const name = scanSeriesTitle(book) || 'Unbekannt';
  const mv = data?.matched_volume;
  if (!data?.found) return entry('unknown', clean);
  if (mv && mv.status === 'Vorhanden') return entry('owned', `${data.matched_manga?.title || name} Band ${mv.volume_number}`);
  const onList = mv && shoppingItems.find((it) => it.id === mv.id);
  if (onList) return entry('buy', `${onList.title} ${onList.volume_number}`.trim(), { itemId: onList.id, price: onList.price ?? null });
  if (data.matched_manga && book?.volume_number_known === false && !mv) {
    return entry('check', `${data.matched_manga.title}: Bandnummer im Katalog unbekannt, bitte selbst prüfen`);
  }
  if (data.matched_manga) {
    return entry('check', mv
      ? `${data.matched_manga.title} Band ${mv.volume_number} (Status ${mv.status})`
      : `${data.matched_manga.title} Band ${book?.volume_number || ''}: fehlt noch und steht nicht auf der Einkaufsliste`);
  }
  if (data.matched_candidates?.length > 0) {
    return entry('check', `${name} passt zu mehreren Reihen (${data.matched_candidates.map((c) => c.title).join(', ')})`);
  }
  return entry('new', `${name}: Reihe noch nicht in der Sammlung`);
};
