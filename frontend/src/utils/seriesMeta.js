// Small series helpers shared by the shelf and the detail page (kept apart from collectionHelpers, which pulls the
// search index into whatever chunk imports it).

/** Whether the household still collects a series (mangas.collecting); older answers without the field count as 'aktiv'. */
export const COLLECTING_OPTIONS = [
  { value: 'aktiv', label: 'Wird gesammelt' },
  { value: 'pausiert', label: 'Pausiert' },
  { value: 'abgebrochen', label: 'Nicht mehr gesammelt' }
];
const COLLECTING_VALUES = COLLECTING_OPTIONS.map(o => o.value);
export const collectingOf = (m) => (COLLECTING_VALUES.includes(m?.collecting) ? m.collecting : 'aktiv');

/** The single names of a series' author field ("Tsugumi Ohba, Takeshi Obata" -> two names). */
export const splitAuthors = (author) => String(author || '')
  .split(/\s*[,;/&]\s*|\s+und\s+/)
  .map(a => a.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

/** Shelf URL filtered by one author (the dashboard reads ?author=). */
export const authorShelfPath = (name) => `/?${new URLSearchParams({ author: String(name || '').trim() })}`;
