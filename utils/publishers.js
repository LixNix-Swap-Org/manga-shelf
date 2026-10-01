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
    'papertoons': 'Papertoons',
    'schreiber&leser': 'Schreiber&Leser',
    'schreiber & leser': 'Schreiber&Leser',
    'tokyopop': 'TOKYOPOP'
};

const normalizePublisher = (name) => {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    return CANONICAL_PUBLISHERS[lower] || trimmed;
};

module.exports = {
    CANONICAL_PUBLISHERS,
    normalizePublisher
};
