// "Was ist neu": the CHANGELOG (built into the app as virtual:changelog, see vite.config.js) read per version. Pure
// functions; the dialog and the hint after an update (components/whatsNew) render what they return.
//
// A version section `## X.Y.Z – YYYY-MM-DD` may hold `### Für alle` (short German sentences for everybody, written per
// release, each `- **Title:** text` with an optional `[Label](app:target)` link at its end), `### Before updating`
// (admins, also in the release text) and the English sections of the full list.

// the app carries the sections from this major version on (vite.config.js cuts the rest off at build time)
export const CHANGELOG_SINCE_MAJOR = 4;

/** The CHANGELOG up to the first version section below major `since` (older ones stay out of the app). */
export function changelogSince(text, since = CHANGELOG_SINCE_MAJOR) {
  const lines = String(text).split(/\r?\n/);
  const cut = lines.findIndex((line) => {
    const match = /^## v?(\d+)\.\d+\.\d+/.exec(line);
    return match && Number(match[1]) < since;
  });
  return `${(cut < 0 ? lines : lines.slice(0, cut)).join('\n').trimEnd()}\n`;
}

const VERSION_HEADING = /^##\s+v?(\d+\.\d+\.\d+)(?:\s+[–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
export const FOR_ALL = 'Für alle'; // i18n-ignore: CHANGELOG heading, not shown
export const BEFORE_UPDATING = 'Before updating'; // i18n-ignore: CHANGELOG heading, not shown
// sections that only concern whoever runs the server; their items and "Internal:" items carry the label "Technik"
const TECHNICAL = /^(maintenance|database|security|development|scripts|tooling|tests|internal|updates|system\b|ci\b|release)/i;
const INTERNAL_ITEM = /^\*\*Internal:\*\*/;

/** The places a `[Label](app:…)` link of a "Für alle" item can lead to; anything else is not shown as a link. */
export const APP_LINK_TARGETS = Object.freeze([
  'statistik', 'statistik/ueberblick', 'statistik/finanzen', 'statistik/personen', 'statistik/lesen', 'statistik/verlauf',
  'statistik/verlage', 'statistik/verliehen', 'statistik/aktivitaet', 'statistik/anime',
  'einstellungen', 'einstellungen/privatsphaere', 'einstellungen/dienste', 'einstellungen/konto',
  'einkauf', 'radar', 'anime'
]);

/** -1, 0 or 1 for two `X.Y.Z` versions; anything that is not such a version sorts below every version. */
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(String(v || '')) ? String(v).split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

export const isVersion = (value) => /^\d+\.\d+\.\d+$/.test(String(value || ''));

// the bullet items (continuation lines joined) and loose paragraphs of a block of lines
function items(lines) {
  const out = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { current = null; continue; }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      current = { text: bullet[1].trim() };
      out.push(current);
    } else if (current) {
      current.text += ` ${line.trim()}`;
    } else {
      current = { text: line.trim() };
      out.push(current);
    }
  }
  return out.map((item) => item.text).filter(Boolean);
}

/** `**Title:** text [Label](app:target)` → { title, text, link: { label, target } | null }. */
export function parseForAllItem(text) {
  let rest = String(text || '').trim();
  let link = null;
  const linkMatch = /\s*\[([^\]]+)\]\(app:([a-z/]+)\)\s*$/.exec(rest);
  if (linkMatch) {
    rest = rest.slice(0, linkMatch.index).trim();
    link = { label: linkMatch[1].trim(), target: linkMatch[2] };
  }
  const titled = /^\*\*(.+?):?\*\*:?\s*(.*)$/.exec(rest);
  const title = titled ? titled[1].replace(/:$/, '').trim() : '';
  return { title, text: titled ? titled[2].trim() : rest, link };
}

/**
 * The version sections of a CHANGELOG text, newest first as written:
 * [{ version, date, forAll: [{ title, text, link }], before: [text], sections: [{ heading, technical, items: [text] }] }].
 * "Unreleased" and headings without a version are skipped.
 */
export function parseChangelog(text) {
  const lines = String(text || '').split(/\r?\n/);
  const versions = [];
  let version = null;
  let section = null;
  let buffer = [];
  const flush = () => {
    if (!version || !section) { buffer = []; return; }
    const list = items(buffer);
    buffer = [];
    if (!list.length) return;
    if (section === FOR_ALL) version.forAll.push(...list.map(parseForAllItem));
    else if (section === BEFORE_UPDATING) version.before.push(...list);
    else version.sections.push({ heading: section, technical: TECHNICAL.test(section), items: list });
  };
  for (const line of lines) {
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      flush();
      const match = VERSION_HEADING.exec(line.trim());
      version = match ? { version: match[1], date: match[2] || null, forAll: [], before: [], sections: [] } : null;
      if (version) versions.push(version);
      section = version ? '' : null;
      continue;
    }
    const sub = /^###\s+(.+?)\s*$/.exec(line);
    if (sub) {
      flush();
      section = sub[1];
      continue;
    }
    if (version) buffer.push(line);
  }
  flush();
  return versions;
}

/** Leaves out the parentheses that only hold code (API paths, columns): `(GET /api/stats/year)`, `(\`a\`, \`b\`)`. */
export function withoutCodeNotes(text) {
  return String(text || '')
    .replace(/\s*\([^()]*`[^()]*\)/g, '')
    .replace(/\s+([.,;:])/g, '$1');
}

/** An English item as a "Für alle" entry: its bold lead as title, without code notes. */
export function fallbackItem(text) {
  const parsed = parseForAllItem(withoutCodeNotes(text));
  return { ...parsed, link: null };
}

/**
 * What "Für alle" shows for a version: the German block when the UI is German and the version has one, else the items of
 * its non-technical English sections without "Internal:" items. `{ items, english }`.
 */
export function forAllItems(entry, language = 'de') {
  if (!entry) return { items: [], english: false };
  if (language === 'de' && entry.forAll.length) return { items: entry.forAll, english: false };
  const list = entry.sections
    .filter((s) => !s.technical && s.heading)
    .flatMap((s) => s.items.filter((item) => !INTERNAL_ITEM.test(item)).map(fallbackItem));
  return { items: list, english: true };
}

/** Whether an item of the full list is technical: its section is, or it starts with "**Internal:**". */
export const isTechnicalItem = (section, item) => section.technical || INTERNAL_ITEM.test(item);

/** The versions newer than `seen` up to and including `current`, newest first (none when `seen` is not older). */
export function versionsSince(versions, seen, current) {
  return (versions || []).filter((v) => compareVersions(v.version, current) <= 0 && (!isVersion(seen) || compareVersions(v.version, seen) > 0));
}

/** The versions up to `current` (what the dialog lists; a newer section, as on a development build, stays out). */
export const versionsUpTo = (versions, current) => (versions || []).filter((v) => !isVersion(current) || compareVersions(v.version, current) <= 0);

/** The database migration numbers a "Before updating" text names ("migration 60", "migrations 40 to 58" → 40, 58). */
export function migrationNumbers(texts) {
  const found = new Set();
  for (const text of texts || []) {
    for (const match of String(text).matchAll(/\*\*Database migrations? (\d+)(?:\s*(?:to|–|-|and)\s*(\d+))?\*\*/gi)) {
      found.add(Number(match[1]));
      if (match[2]) found.add(Number(match[2]));
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The hint after an update: { versions, count, titles, migrations, adminNotes } for what came after `seen` up to
 * `current`, or null when there is nothing to tell this account.
 */
export function updateSummary(versions, { seen, current, language = 'de', admin = false } = {}) {
  if (!isVersion(seen) || !isVersion(current) || compareVersions(current, seen) <= 0) return null;
  const newer = versionsSince(versions, seen, current);
  const forAll = newer.flatMap((v) => forAllItems(v, language).items);
  const before = admin ? newer.flatMap((v) => v.before) : [];
  if (!forAll.length && !before.length) return null;
  return {
    versions: newer.map((v) => v.version),
    count: forAll.length,
    titles: forAll.map((item) => item.title).filter(Boolean).slice(0, 2),
    migrations: migrationNumbers(before),
    adminNotes: before.length
  };
}

// small inline Markdown of the CHANGELOG texts: **bold**, `code` and [label](https://…) links
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** [{ type: 'text' | 'bold' | 'code' | 'link', text, href? }] of a CHANGELOG text. */
export function inlineParts(text) {
  const out = [];
  let last = 0;
  const source = String(text || '');
  for (const match of source.matchAll(INLINE)) {
    if (match.index > last) out.push({ type: 'text', text: source.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('**')) out.push({ type: 'bold', text: token.slice(2, -2) });
    else if (token.startsWith('`')) out.push({ type: 'code', text: token.slice(1, -1) });
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link && /^https:\/\//.test(link[2])) out.push({ type: 'link', text: link[1], href: link[2] });
      else out.push({ type: 'text', text: link ? link[1] : token });
    }
    last = match.index + token.length;
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out;
}
