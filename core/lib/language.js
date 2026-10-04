// Edition languages, regions and currencies: one normalisation for the API, the CSV import and migration 27.
// Pure (no Node API), shared with the frontend like the other core/lib modules.

const DEFAULT_LANGUAGE = 'de';
const DEFAULT_CURRENCY = 'EUR';
// Manga Passion only knows German editions
const MP_LANGUAGE = 'de';

// ISO 639-1: a two-letter code outside this list is unknown, not stored
const ISO_639_1 = new Set((
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu '
    + 'fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn '
    + 'ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os '
    + 'pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw '
    + 'ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
).split(' '));
const REGION_CODE = /^[A-Za-z]{2}$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;
const WORK_KEY = /^(?:anilist|mal|manual):[A-Za-z0-9_-]{1,64}$/;
const MANUAL_PREFIX = 'manual:';

// names and ISO 639-2 codes (folded: lower case, umlauts as ae/oe/ue, accents stripped) -> ISO 639-1
const LANGUAGE_NAMES = {
    de: ['deutsch', 'german', 'ger', 'deu', 'allemand', 'aleman', 'tedesco'],
    en: ['englisch', 'english', 'eng', 'anglais', 'ingles', 'inglese'],
    ja: ['japanisch', 'japanese', 'jpn', 'jp', '日本語', 'japonais', 'japones', 'giapponese'],
    fr: ['franzoesisch', 'franzosisch', 'french', 'francais', 'fra', 'fre', 'frances', 'francese'],
    it: ['italienisch', 'italian', 'ita', 'italiano', 'italien'],
    es: ['spanisch', 'spanish', 'espanol', 'spa', 'castellano', 'espagnol', 'spagnolo'],
    ko: ['koreanisch', 'korean', 'kor', '한국어', 'coreen', 'coreano'],
    zh: ['chinesisch', 'chinese', 'zho', 'chi', '中文', 'chinois', 'chino', 'cinese'],
    nl: ['niederlaendisch', 'niederlandisch', 'dutch', 'nld', 'dut', 'nederlands', 'hollaendisch'],
    pl: ['polnisch', 'polish', 'pol', 'polski'],
    pt: ['portugiesisch', 'portuguese', 'por', 'portugues'],
    ru: ['russisch', 'russian', 'rus', 'русский'],
    sv: ['schwedisch', 'swedish', 'swe', 'svenska'],
    tr: ['tuerkisch', 'turkisch', 'turkish', 'tur', 'turkce', 'tuerkce'],
    da: ['daenisch', 'danish', 'dan', 'dansk'],
    no: ['norwegisch', 'norwegian', 'nor', 'norsk'],
    fi: ['finnisch', 'finnish', 'fin', 'suomi'],
    cs: ['tschechisch', 'czech', 'ces', 'cze', 'cestina'],
    hu: ['ungarisch', 'hungarian', 'hun', 'magyar'],
    th: ['thailaendisch', 'thai', 'tha'],
    vi: ['vietnamesisch', 'vietnamese', 'vie'],
    id: ['indonesisch', 'indonesian', 'ind']
};
const NAME_TO_CODE = new Map(Object.entries(LANGUAGE_NAMES).flatMap(([code, names]) => names.map(name => [name, code])));

/** Lower case, NFC, umlauts as two letters, other accents stripped ("Französisch" -> "franzoesisch"). */
function fold(text) {
    return text.trim().normalize('NFC').toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

/** Region code in upper case ('us' -> 'US'), else null. */
function normalizeRegion(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    return REGION_CODE.test(text) ? text.toUpperCase() : null;
}

/** Currency code in upper case ('usd' -> 'USD'), else null. */
function normalizeCurrency(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    return CURRENCY_CODE.test(text) ? text.toUpperCase() : null;
}

/**
 * { language, region } from a code, a name or a BCP-47 tag ('de', 'Deutsch', 'en-US', 'pt_BR'); region is null
 * unless the tag names one. Empty input gives { language: null }; unknown text gives null.
 */
function parseLanguage(raw) {
    if (raw === undefined || raw === null) return { language: null, region: null };
    if (typeof raw !== 'string') return null;
    const text = fold(raw);
    if (!text) return { language: null, region: null };
    // names first: 'jp' is a common misspelling of 'ja'
    const named = NAME_TO_CODE.get(text);
    if (named) return { language: named, region: null };
    if (ISO_639_1.has(text)) return { language: text, region: null };
    // BCP-47: language[-script][-region][-…]
    const [head, ...rest] = text.split(/[-_]/);
    if (!rest.length || !/^[a-z]{2,3}$/.test(head) || !rest.every(part => /^[a-z0-9]{1,8}$/.test(part))) return null;
    const language = NAME_TO_CODE.get(head) || (ISO_639_1.has(head) ? head : null);
    if (!language) return null;
    const subtags = /^[a-z]{4}$/.test(rest[0]) ? rest.slice(1) : rest;
    return { language, region: subtags.length && /^[a-z]{2}$/.test(subtags[0]) ? subtags[0].toUpperCase() : null };
}

/** ISO 639-1 code of `raw`; empty or unknown text gives `fallback`. */
function normalizeLanguage(raw, fallback = DEFAULT_LANGUAGE) {
    const parsed = parseLanguage(raw);
    return (parsed && parsed.language) || fallback;
}

const isWorkKey = (value) => typeof value === 'string' && WORK_KEY.test(value);
const isManualWorkKey = (value) => isWorkKey(value) && value.startsWith(MANUAL_PREFIX);
const isLanguageCode = (value) => typeof value === 'string' && ISO_639_1.has(value);

/** A fresh manual work key from random hex ('manual:' + 24 hex): never derived from a series id, so it is never reused. */
const manualWorkKey = (hex) => MANUAL_PREFIX + String(hex).replace(/[^0-9a-f]/gi, '').slice(0, 24).toLowerCase();

/** Work key of a lookup hit: AniList before MyAnimeList ('al_12' -> 'anilist:12', 'mal_7' -> 'mal:7'), else null. */
function workKeyOfHit(hit) {
    if (!hit || typeof hit !== 'object') return null;
    const id = String(hit.id ?? '');
    const anilist = /^al_(\d+)$/.exec(id);
    if (anilist) return `anilist:${anilist[1]}`;
    const mal = /^mal_(\d+)$/.exec(id);
    if (mal) return `mal:${mal[1]}`;
    return hit.mal_id && /^\d+$/.test(String(hit.mal_id)) ? `mal:${hit.mal_id}` : null;
}

/** The key a merged group keeps: an AniList key wins, otherwise the target's. */
function preferredWorkKey(sourceKey, targetKey) {
    if (!sourceKey) return targetKey;
    if (!targetKey) return sourceKey;
    const anilist = (key) => key.startsWith('anilist:');
    if (anilist(sourceKey) && !anilist(targetKey)) return sourceKey;
    return targetKey;
}

const isMpLanguage = (language) => (language || DEFAULT_LANGUAGE) === MP_LANGUAGE;

module.exports = {
    DEFAULT_LANGUAGE, DEFAULT_CURRENCY, MP_LANGUAGE, LANGUAGE_NAMES,
    parseLanguage, normalizeLanguage, normalizeRegion, normalizeCurrency, isWorkKey, isManualWorkKey, isLanguageCode, manualWorkKey,
    workKeyOfHit, preferredWorkKey, isMpLanguage
};
