// Step-by-step guides to the API keys. Pure data: the server console renders it, everything else gets it as JSON from GET /sources/guides.
const ANILIST_PIN_URL = 'https://anilist.co/api/v2/oauth/pin';

const AUTHORIZE_TEMPLATE = 'https://anilist.co/api/v2/oauth/authorize?client_id={client_id}&response_type=token';

/**
 * A step's link with the fields filled in ({client_id}); null while a field is missing or does not match the
 * pattern of the step that asks for it.
 */
function fillTemplate(template, fields = {}, steps = []) {
    let missing = false;
    const url = template.replace(/\{(\w+)\}/g, (_, name) => {
        const value = String((fields && fields[name]) || '').trim();
        const asking = steps.find((s) => s.input === name);
        if (!value || (asking && asking.inputPattern && !new RegExp(asking.inputPattern).test(value))) missing = true;
        return encodeURIComponent(value);
    });
    return missing ? null : url;
}

const anilistAuthorizeUrl = (clientId) => fillTemplate(AUTHORIZE_TEMPLATE, { client_id: clientId });

const GUIDES = [
    {
        id: 'anilist',
        name: 'AniList',
        scope: 'user',
        benefit: 'Eigenes Limit von 30 Anfragen pro Minute nur für dich; Suche und Metadaten laufen nicht mehr über den gemeinsamen Pool.',
        secretLabel: 'Zugriffstoken',
        secretHint: 'langer Text aus drei Teilen, beginnt mit „ey“',
        pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
        minLength: 100,
        formatError: 'Das sieht nicht wie ein AniList-Token aus (drei durch Punkte getrennte Teile, mindestens 100 Zeichen).',
        warning: 'Der Token erlaubt Zugriff auf dein AniList-Konto. Manga Shelf nutzt ihn nur für Suchen und Metadaten und zeigt ihn nie wieder an.',
        steps: [
            { text: 'Bei AniList anmelden und die Entwickler-Einstellungen öffnen.', link: 'https://anilist.co/settings/developer' },
            { text: '„Create New Client“: Name „Manga Shelf“, Redirect URL genau so eintragen:', copy: ANILIST_PIN_URL },
            { text: 'Speichern und die Client-ID hier eintragen — daraus entsteht der Anmeldelink.', input: 'client_id', inputLabel: 'Client-ID', inputPattern: '^\\d{1,10}$' },
            { text: 'Den Anmeldelink öffnen, Zugriff bestätigen und den angezeigten Token kopieren.', linkTemplate: AUTHORIZE_TEMPLATE },
            { text: 'Token unten einfügen und „Prüfen & speichern“ drücken.' }
        ],
        check: 'Anfrage „Viewer { name }“ mit dem Token; bei Erfolg wird dein AniList-Name angezeigt.',
        validity: 'Der Token gilt ein Jahr; danach erscheint hier „abgelaufen“ und die Schritte 4–5 wiederholen sich.'
    },
    {
        id: 'mal',
        name: 'MyAnimeList',
        scope: 'both',
        benefit: 'Suche und Daten über die offizielle MyAnimeList-API statt über Jikan, mit eigenem Limit.',
        secretLabel: 'Client-ID',
        secretHint: '32 Zeichen aus 0–9 und a–f',
        pattern: '^[0-9a-fA-F]{32}$',
        minLength: 32,
        formatError: 'Eine MyAnimeList-Client-ID besteht aus genau 32 Zeichen (0–9, a–f).',
        warning: null,
        steps: [
            { text: 'Bei MyAnimeList anmelden und die API-Einstellungen öffnen, dort „Create ID“ wählen.', link: 'https://myanimelist.net/apiconfig' },
            { text: 'App Name „Manga Shelf“, App Type „other“ (Client Secret bleibt optional), App Description frei.' },
            { text: 'App Redirect URL genau so eintragen:', copy: 'http://localhost/' },
            { text: 'Homepage URL, z. B.:', copy: 'https://github.com/LixNix-Swap-Org/manga-shelf' },
            { text: 'Commercial / Non-Commercial: „non-commercial“, Name/Company Name beliebig, Purpose of Use „hobbyist“, API License and Developer Agreement bestätigen und absenden.' },
            { text: 'Auf der Übersicht neben der App „Edit“ anklicken: dort steht die Client ID. Sie unten einfügen und „Prüfen & speichern“ drücken.' }
        ],
        check: 'Testsuche über die offizielle API mit der Client-ID; Antwort 200 bedeutet gültig.',
        validity: 'Die Client-ID läuft nicht ab, solange die App bei MyAnimeList besteht.'
    },
    {
        id: 'google_books',
        name: 'Google Books',
        scope: 'instance',
        benefit: 'Eigenes Kontingent für die ISBN-Suche über Google Books (sonst teilt sich der Server das anonyme Limit).',
        secretLabel: 'API-Schlüssel',
        secretHint: 'beginnt mit „AIza“, 39 Zeichen',
        pattern: '^AIza[0-9A-Za-z_-]{35}$',
        minLength: 39,
        formatError: 'Ein Google-API-Schlüssel beginnt mit „AIza“ und hat 39 Zeichen.',
        warning: null,
        steps: [
            { text: 'Die Google Cloud Console öffnen und ein Projekt anlegen oder auswählen.', link: 'https://console.cloud.google.com/' },
            { text: 'Unter „APIs & Dienste“ die „Books API“ aktivieren.', link: 'https://console.cloud.google.com/apis/library/books.googleapis.com' },
            { text: '„Anmeldedaten“ → „Anmeldedaten erstellen“ → „API-Schlüssel“.', link: 'https://console.cloud.google.com/apis/credentials' },
            { text: 'Den Schlüssel auf die Books API einschränken, kopieren und unten einfügen.' }
        ],
        check: 'ISBN-Abfrage bei Google Books mit dem Schlüssel; Antwort 200 bedeutet gültig.',
        validity: 'Der Schlüssel gilt, bis er in der Cloud Console gelöscht wird.'
    }
];

const guideFor = (id) => GUIDES.find((g) => g.id === id) || null;

/** Format check of a secret against the guide's pattern and minimum length. */
function isWellFormed(guide, secret) {
    const value = typeof secret === 'string' ? secret.trim() : '';
    return value.length >= (guide.minLength || 1) && new RegExp(guide.pattern).test(value);
}

/** Providers a user (scope user) or an admin for the instance (scope instance) can set. */
const userProviders = () => GUIDES.filter((g) => g.scope === 'user' || g.scope === 'both').map((g) => g.id);
const instanceProviders = () => GUIDES.filter((g) => g.scope === 'instance' || g.scope === 'both').map((g) => g.id);

/** Format check before anything is sent: null when fine, else the message. */
function formatError(id, secret) {
    const guide = guideFor(id);
    if (!guide) return 'Unbekannter Anbieter';
    const value = typeof secret === 'string' ? secret.trim() : '';
    if (!value) return `Bitte ${guide.secretLabel} eingeben.`;
    return isWellFormed(guide, value) ? null : guide.formatError;
}

/** Word-wrapped text for terminals (`width` columns, continuation lines indented by `indent`). */
function wrap(text, width = 80, indent = '') {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        const prefix = lines.length ? indent : '';
        if (line && (prefix + line + ' ' + word).length > width) {
            lines.push(prefix + line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push((lines.length ? indent : '') + line);
    return lines;
}

/** The guide as numbered terminal lines (80 columns); `fields.client_id` adds the AniList sign-in link. */
function guideLines(id, fields = {}, width = 80) {
    const guide = guideFor(id);
    if (!guide) return [];
    const out = [`${guide.name}: ${guide.secretLabel}`, ...wrap(guide.benefit, width), ''];
    guide.steps.forEach((step, i) => {
        const num = `${i + 1}. `;
        out.push(...wrap(num + step.text, width, ' '.repeat(num.length)));
        if (step.link) out.push(`${' '.repeat(num.length)}${step.link}`);
        if (step.copy) out.push(`${' '.repeat(num.length)}${step.copy}`);
        if (step.linkTemplate) {
            const link = fillTemplate(step.linkTemplate, fields, guide.steps);
            out.push(`${' '.repeat(num.length)}${link || '(Anmeldelink entsteht aus der Client-ID aus Schritt 3)'}`);
        }
    });
    if (guide.warning) out.push('', ...wrap(`Hinweis: ${guide.warning}`, width));
    out.push('', ...wrap(`Prüfung: ${guide.check}`, width), ...wrap(guide.validity, width));
    return out;
}

/** GET /sources/guides: every guide as JSON (patterns as strings, links with {field} placeholders). */
function guidesHandler() {
    return { body: GUIDES };
}

module.exports = {
    guidesHandler, GUIDES, guideFor, userProviders, instanceProviders, formatError, isWellFormed, fillTemplate, guideLines, wrap, anilistAuthorizeUrl,
    ANILIST_PIN_URL, AUTHORIZE_TEMPLATE
};
