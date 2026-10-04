/**
 * Shared text search of all search fields: folding (case, accents, ß, apostrophes, punctuation), every query token must
 * occur in the item, tokens of 5+ letters tolerate one typo. Indexes are cached per item object, so a list builds its
 * index once and every further keystroke only scans it.
 */

const LIGATURES = { æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', þ: 'th' };
const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue' };
const FIELD_SEP = '|';
const FUZZY_MIN = 5;
const LETTERS_ONLY = /^\p{L}+$/u;

export const naturalCollator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** German natural order ('Band 2' before 'Band 10', case and accents ignored); empty values compare as ''. */
export const compareNatural = (a, b) => naturalCollator.compare(String(a ?? ''), String(b ?? ''));

/** Lower case without accents, ß → ss, apostrophes and dots dropped, any other punctuation → one space. */
export const foldText = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/ß/g, 'ss')
  .replace(/×/g, ' x ')
  .replace(/['’‘`´.]/g, '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .replace(/[æœøłđþ]/g, ch => LIGATURES[ch])
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

// 'Tagebücher' is also found as 'tagebuecher'
const umlautVariant = (value) => {
  const text = String(value ?? '').normalize('NFC').toLowerCase();
  return /[äöü]/.test(text) ? foldText(text.replace(/[äöü]/g, ch => UMLAUTS[ch])) : null;
};

const toList = (value) => (Array.isArray(value) ? value : [value]).filter(v => v !== null && v !== undefined && v !== '');

/**
 * Index of one item. fields = { primary: title-like values (ranked first), secondary: everything else }; each entry may
 * be a value or an array of values.
 */
export const buildSearchIndex = ({ primary = [], secondary = [] } = {}) => {
  const folded = [];
  const primaryFolded = [];
  const add = (value, isPrimary) => {
    const f = foldText(value);
    if (!f) return;
    folded.push(f);
    if (isPrimary) primaryFolded.push(f);
    const variant = umlautVariant(value);
    if (variant && variant !== f) {
      folded.push(variant);
      if (isPrimary) primaryFolded.push(variant);
    }
  };
  for (const v of toList(primary).flat()) add(v, true);
  for (const v of toList(secondary).flat()) add(v, false);
  const words = new Set();
  for (const f of folded) {
    for (const w of f.split(' ')) if (w.length >= FUZZY_MIN - 1 && LETTERS_ONLY.test(w)) words.add(w);
  }
  return {
    text: folded.join(FIELD_SEP),
    compact: folded.map(f => f.replace(/ /g, '')).join(FIELD_SEP),
    primary: primaryFolded,
    words: [...words]
  };
};

/** Folded query tokens, or null for an empty query (which matches everything). */
export const prepareQuery = (query) => {
  const folded = foldText(query);
  if (!folded) return null;
  const tokens = folded.split(' ');
  const compact = tokens.join('');
  return {
    folded,
    compact,
    tokens,
    // '978-3-551' must stay one run of digits, not three loose numbers
    digitRun: tokens.length > 1 && /^\d{4,}$/.test(compact)
  };
};

// Optimal string alignment distance of `token` to `word` or to a prefix of it (someone still typing), at most 1
const withinOneEdit = (token, word) => {
  const n = token.length;
  if (word.length < n - 1) return false;
  const m = Math.min(word.length, n + 1);
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = token[i - 1] === word[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && token[i - 1] === word[j - 2] && token[i - 2] === word[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > 1) return false;
    prev2 = prev;
    prev = cur;
  }
  for (let j = Math.max(0, n - 1); j <= m; j++) if (prev[j] <= 1) return true;
  return false;
};

const tokenMatch = (index, token) => {
  if (index.text.includes(token) || index.compact.includes(token)) return 'exact';
  if (token.length >= FUZZY_MIN && LETTERS_ONLY.test(token) && index.words.some(w => withinOneEdit(token, w))) return 'fuzzy';
  return null;
};

/** Match strength: 0 title prefix, 1 all tokens in the title, 2 other fields, 3 only with a typo; null = no match. */
export const rankMatch = (index, query) => {
  if (!query) return 2;
  if (query.digitRun && !index.compact.includes(query.compact)) return null;
  let fuzzy = false;
  for (const token of query.tokens) {
    const kind = tokenMatch(index, token);
    if (!kind) return null;
    if (kind === 'fuzzy') fuzzy = true;
  }
  if (fuzzy) return 3;
  if (index.primary.some(p => p.startsWith(query.folded) || p.replace(/ /g, '').startsWith(query.compact))) return 0;
  if (index.primary.some(p => query.tokens.every(t => p.includes(t) || p.replace(/ /g, '').includes(t)))) return 1;
  return 2;
};

export const matchesQuery = (index, query) => rankMatch(index, query) !== null;

/**
 * Search over items whose fields come from fieldsOf(item) → { primary, secondary }. Indexes are cached per item object
 * (a new list from the server builds new ones); create one searcher per field set, not per render.
 */
export const createSearch = (fieldsOf) => {
  const cache = new WeakMap();
  const indexOf = (item) => {
    if (item === null || typeof item !== 'object') return buildSearchIndex(fieldsOf(item));
    let index = cache.get(item);
    if (!index) {
      index = buildSearchIndex(fieldsOf(item));
      cache.set(item, index);
    }
    return index;
  };
  /** Items matching the query, in list order (all items for an empty query). */
  const filter = (items, query) => {
    const q = typeof query === 'string' || query === undefined || query === null ? prepareQuery(query) : query;
    const list = items || [];
    return q ? list.filter(item => matchesQuery(indexOf(item), q)) : list.slice();
  };
  return {
    indexOf,
    filter,
    matches: (item, query) => matchesQuery(indexOf(item), typeof query === 'string' ? prepareQuery(query) : query),
    rank: (item, query) => rankMatch(indexOf(item), typeof query === 'string' ? prepareQuery(query) : query)
  };
};
