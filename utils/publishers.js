// Canonical German Manga Publishers map & Normalization Helper
const CANONICAL_PUBLISHERS = {
    'altraverse': 'Altraverse',
    'carlsen manga': 'Carlsen Manga',
    'crunchyroll': 'Crunchyroll',
    'dani books': 'Dani Books',
    'dark horse manga': 'Dark Horse Manga',
    'egmont manga': 'Egmont Manga',
    'hayabusa': 'Hayabusa',
    'kazé manga': 'Kazé Manga',
    'kaze manga': 'Kazé Manga',
    'manga cult': 'Manga Cult',
    'manga jam session': 'Manga JAM Session',
    'panini verlag gmbh': 'Panini Verlags GmbH',
    'panini verlags gmbh': 'Panini Verlags GmbH',
    'panini': 'Panini Verlags GmbH',
    'panini manga': 'Panini Verlags GmbH',
    'papertoons': 'Papertoons',
    'schreiber&leser': 'Schreiber&Leser',
    'schreiber & leser': 'Schreiber&Leser',
    'tokyopop': 'TOKYOPOP'
};

const normalizePublisher = (name) => {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    // Manga Passion writes the imprint as "Carlsen Manga!"; the trailing "!" must not create a second publisher
    const lower = trimmed.toLowerCase().replace(/\s*!+$/, '');
    return CANONICAL_PUBLISHERS[lower] || trimmed.replace(/\s*!+$/, '');
};

module.exports = {
    CANONICAL_PUBLISHERS,
    normalizePublisher
};
