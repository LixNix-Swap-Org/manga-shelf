// Display labels of stored German values. The values never change (API, CSV, offline copy); only what is shown is
// translated, so code compares values and never labels.
import { msg, t, tc } from '../i18n/index.js';

// i18n
export const VOLUME_STATUS_VALUES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt'];
// i18n
export const MANGA_STATUS_VALUES = ['Laufend', 'Abgeschlossen', 'Pausiert', 'Abgebrochen', 'Geplant'];
// i18n
export const CONDITION_VALUES = ['Neuwertig', 'Sehr gut', 'Gut', 'Akzeptabel', 'Mängelexemplar'];
// i18n
export const ANIME_PROGRESS_VALUES = ['Geplant', 'Schaue', 'Gesehen', 'Pausiert', 'Abgebrochen'];

// stored collecting values: the server names them in messages as nested params ({ msg: 'aktiv' })
export const COLLECTING_VALUES = [msg('aktiv'), msg('pausiert'), msg('abgebrochen')];

// i18n
const COLLECTING_LABELS = { aktiv: 'Wird gesammelt', pausiert: 'Pausiert', abgebrochen: 'Nicht mehr gesammelt' };
// i18n
const VOLUME_TYPE_LABELS = { volume: 'Einzelband', special_edition: 'Special Edition', schuber: 'Schuber', special: 'Special / Extra' };

// the German genre names of GENRE_DE (utils/tags.js); test/i18n keeps both lists equal
// i18n
export const GENRE_NAMES = [
  'Action', 'Abenteuer', 'Komödie', 'Kochen', 'Krimi', 'Drama', 'Fantasy', 'Historisch', 'Horror', 'Magical Girl',
  'Kampfkunst', 'Medizin', 'Militär', 'Musik', 'Mystery', 'Psychologisch', 'Romantik', 'Schule', 'Science-Fiction',
  'Alltag', 'Sport', 'Übernatürlich', 'Thriller', 'Tragödie', 'Boys Love', 'Girls Love', 'Shounen', 'Shoujo', 'Seinen',
  'Josei'
];

const known = (values, contextual = {}) => {
  const set = new Set(values);
  return (value) => {
    if (typeof value !== 'string' || !set.has(value)) return value;
    return Object.prototype.hasOwnProperty.call(contextual, value) ? contextual[value]() : t(value);
  };
};

// 'Pausiert' alone is the series status ('On hiatus'); the watch status and the collecting state mean 'paused' and
// have their own keys (`watch::Pausiert`, `collecting::Pausiert`, see tc())
const WATCH_CONTEXT = { Pausiert: () => tc('watch', 'Pausiert') };
const collectingPaused = () => tc('collecting', 'Pausiert');

/** Volume status ('Vorhanden' …) as shown in chips and lists; unknown values pass through. */
export const statusLabel = known(VOLUME_STATUS_VALUES);
/** Release status of a series (mangas.status). */
export const mangaStatusLabel = known(MANGA_STATUS_VALUES);
/** Condition presets; free text passes through. */
export const conditionLabel = known(CONDITION_VALUES);
/** Watch status of an anime (anime_progress.status). */
export const animeProgressLabel = known(ANIME_PROGRESS_VALUES, WATCH_CONTEXT);
/** Genre tag: known genres translated, any other tag is user content and stays. */
export const genreLabel = known(GENRE_NAMES);

/** Collecting state value ('aktiv' …) -> its label. */
export const collectingLabel = (value) => {
  if (value === 'pausiert') return collectingPaused();
  return Object.prototype.hasOwnProperty.call(COLLECTING_LABELS, value) ? t(COLLECTING_LABELS[value]) : value;
};
/** Volume type value ('special_edition' …) -> its label. */
export const volumeTypeLabel = (value) => (Object.prototype.hasOwnProperty.call(VOLUME_TYPE_LABELS, value) ? t(VOLUME_TYPE_LABELS[value]) : value);
