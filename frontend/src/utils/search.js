/**
 * Shared folded text search: every query token must occur, tokens of 5+ letters tolerate one typo; number tokens
 * match whole numbers, codes (ISBNs) need 4+ digits. Indexes are cached per item object.
 */

const LIGATURES = { æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', þ: 'th' };
const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue' };
const FIELD_SEP = '|';
const FUZZY_MIN = 5;
const FUZZY_MAX_TOKEN = 24;
const FUZZY_MAX_WORD = 32;
const MAX_QUERY_CHARS = 200;
const MAX_TOKENS = 12;
const LETTERS_ONLY = /^\p{L}+$/u;
const NUMBER = /^\d+(?:\.\d+)*$/;
const CODE_QUERY = /^\d{3,}[\dx]$/;
const ISBN_SHAPE = /^(?:\d{9}[\dx]|\d{13})$/;

export const naturalCollator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** German natural order ('Band 2' before 'Band 10', case and accents ignored); empty values compare as ''. */
export const compareNatural = (a, b) => naturalCollator.compare(String(a ?? ''), String(b ?? ''));

/**
 * Lower case without accents, ß → ss, apostrophes dropped, a dot dropped unless it sits between digits ('Dr. Stone' →
 * 'dr stone', '1.5' stays), a decimal comma becomes a dot, any other punctuation → one space.
 */
export const foldText = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/ß/g, 'ss')
  .replace(/×/g, ' x ')
  .replace(/['’‘`´]/g, '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .replace(/[æœøłđþ]/g, ch => LIGATURES[ch])
  .replace(/(\d),(?=\d)/g, '$1.')
  .replace(/(?<!\d)\.|\.(?!\d)/g, '')
  .replace(/[^\p{L}\p{N}.]+/gu, ' ')
  .trim();

// 'Tagebücher' is also found as 'tagebuecher'
const umlautVariant = (value) => {
  const text = String(value ?? '').normalize('NFC').toLowerCase();
  return /[äöü]/.test(text) ? foldText(text.replace(/[äöü]/g, ch => UMLAUTS[ch])) : null;
};

const toList = (value) => (Array.isArray(value) ? value : [value]).filter(v => v !== null && v !== undefined && v !== '');

// '007' and '7' are the same number
const numberKey = (word) => word.replace(/^0+(?=\d)/, '');

const codeOf = (value) => String(value ?? '').toLowerCase().replace(/[^0-9x]/g, '');
const isIsbnLike = (value) => /^[\d\s-]+x?$/i.test(String(value).trim()) && ISBN_SHAPE.test(codeOf(value));

const addTerms = (set, folded) => {
  for (const w of folded.split(' ')) {
    set.add(w);
    if (NUMBER.test(w)) set.add(numberKey(w));
  }
};

/**
 * Index of one item: { primary: title-like values (ranked first), secondary: the rest, codes: ISBNs and identifiers },
 * each a value or an array. A secondary value shaped like an ISBN counts as a code.
 */
export const buildSearchIndex = ({ primary = [], secondary = [], codes = [] } = {}) => {
  const folded = [];
  const primaryEntries = [];
  const codeList = [];
  const terms = new Set();
  const add = (value, isPrimary) => {
    if (!isPrimary && isIsbnLike(value)) {
      codeList.push(codeOf(value));
      return;
    }
    const f = foldText(value);
    if (!f) return;
    const forms = [f];
    const variant = umlautVariant(value);
    if (variant && variant !== f) forms.push(variant);
    for (const form of forms) {
      folded.push(form);
      addTerms(terms, form);
      if (isPrimary) {
        const own = new Set();
        addTerms(own, form);
        primaryEntries.push({ text: form, compact: form.replace(/ /g, ''), terms: own });
      }
    }
  };
  for (const v of toList(primary).flat()) add(v, true);
  for (const v of toList(secondary).flat()) add(v, false);
  for (const v of toList(codes).flat()) {
    const code = codeOf(v);
    if (code) codeList.push(code);
  }
  const words = [];
  for (const w of terms) {
    if (w.length >= FUZZY_MIN - 1 && w.length <= FUZZY_MAX_WORD && LETTERS_ONLY.test(w)) words.push(w);
  }
  return {
    text: folded.join(FIELD_SEP),
    compact: folded.map(f => f.replace(/ /g, '')).join(FIELD_SEP),
    primary: primaryEntries,
    terms,
    words,
    codes: codeList
  };
};

/** Folded query tokens, or null for an empty query (which matches everything). Long input is cut to 200 characters. */
export const prepareQuery = (query) => {
  const folded = foldText(String(query ?? '').slice(0, MAX_QUERY_CHARS * 10)).slice(0, MAX_QUERY_CHARS).trim();
  if (!folded) return null;
  const all = folded.split(' ');
  const compact = all.join('');
  const tokens = [...new Set(all)].slice(0, MAX_TOKENS);
  return {
    folded,
    compact,
    tokens,
    terms: tokens.map(token => ({
      token,
      number: NUMBER.test(token) ? numberKey(token) : null,
      fuzzy: token.length >= FUZZY_MIN && token.length <= FUZZY_MAX_TOKEN && LETTERS_ONLY.test(token)
    })),
    // '978-3-551' must stay one run of digits, not three loose numbers
    digitRun: all.length > 1 && /^\d{4,}$/.test(compact),
    code: CODE_QUERY.test(compact) ? compact : null,
    numberTail: NUMBER.test(all[all.length - 1])
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

const termMatch = (index, term) => {
  if (term.number !== null) return index.terms.has(term.number) ? 'exact' : null;
  if (index.text.includes(term.token) || index.compact.includes(term.token)) return 'exact';
  if (term.fuzzy && index.words.some(w => withinOneEdit(term.token, w))) return 'fuzzy';
  return null;
};

const inPrimary = (entry, term) => (term.number !== null
  ? entry.terms.has(term.number)
  : entry.text.includes(term.token) || entry.compact.includes(term.token));

// 'band 2' is a prefix of 'band 2 (...)' but not of 'band 20'
const prefixHit = (entry, query) => {
  if (entry.text.startsWith(query.folded)) {
    if (!query.numberTail) return true;
    const next = entry.text[query.folded.length];
    return next === undefined || next === ' ';
  }
  return !query.numberTail && entry.compact.startsWith(query.compact);
};

/** Match strength: 0 title prefix, 1 all tokens in the title, 2 other fields, 3 only with a typo; null = no match. */
export const rankMatch = (index, query) => {
  if (!query) return 2;
  if (query.code && index.codes.some(c => c.includes(query.code))) return 2;
  if (query.digitRun && !index.compact.includes(query.compact)) return null;
  const { terms } = query;
  let fuzzy = false;
  for (const term of terms) {
    const kind = termMatch(index, term);
    if (!kind) return null;
    if (kind === 'fuzzy') fuzzy = true;
  }
  if (fuzzy) return 3;
  if (index.primary.some(p => prefixHit(p, query))) return 0;
  if (index.primary.some(p => terms.every(t => inPrimary(p, t)))) return 1;
  return 2;
};

export const matchesQuery = (index, query) => rankMatch(index, query) !== null;

/**
 * Search over items whose fields come from fieldsOf(item) → { primary, secondary, codes }. Indexes are cached per item
 * object (a new list from the server builds new ones); create one searcher per field set, not per render.
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
  const toQuery = (query) => (typeof query === 'string' || query === undefined || query === null ? prepareQuery(query) : query);
  /** Items matching the query, in list order (all items for an empty query). */
  const filter = (items, query) => {
    const q = toQuery(query);
    const list = items || [];
    return q ? list.filter(item => matchesQuery(indexOf(item), q)) : list.slice();
  };
  return {
    indexOf,
    filter,
    matches: (item, query) => matchesQuery(indexOf(item), toQuery(query)),
    rank: (item, query) => rankMatch(indexOf(item), toQuery(query))
  };
};
