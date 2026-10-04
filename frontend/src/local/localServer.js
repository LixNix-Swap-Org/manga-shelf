// The server-only routes the client calls, answered on the device: session (one local profile, no login), the
// profile list, uploads and the API keys. Backups, users, setup and the console do not exist without a server.
import errors from '../../../core/errors.js';
import guides from '../../../core/sources/guides.js';
import gateway from '../../../core/anime/gateway.js';
import sourceRequest from '../../../core/anime/request.js';
import listSync from '../../../core/anime/listSync.js';
import locales from '../../../core/lib/locales.js';
import imageCheck from '../../../core/lib/imageCheck.js';

const { HttpError, badRequest, notFound, msg } = errors;
const MIN_SECRET = 10;
const MAX_SECRET = 4096;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
// i18n
export const NOT_LOCAL_TEXT = 'Im Modus ohne Server nicht verfügbar';
const PROVIDER_HOSTS = { anilist: 'graphql.anilist.co', mal: 'api.myanimelist.net', google_books: 'www.googleapis.com' };

const json = (body, status = 200, headers = {}) => ({ status, body, headers: { 'Cache-Control': 'no-store', ...headers } });
const notLocal = () => new HttpError(404, NOT_LOCAL_TEXT, 'NOT_AVAILABLE_LOCALLY');

function providerParam(raw, allowed) {
  const provider = String(raw || '').toLowerCase();
  if (!allowed.includes(provider)) throw badRequest(msg('Unbekannter Anbieter (erlaubt: {allowed})', { allowed: allowed.join(', ') }), 'UNKNOWN_PROVIDER'); // i18n-ignore: answer text
  return provider;
}

function cleanSecret(provider, raw) {
  if (typeof raw !== 'string') throw badRequest('Bitte den Schlüssel eingeben'); // i18n-ignore: answer text
  const secret = raw.trim();
  if (secret.length < MIN_SECRET || secret.length > MAX_SECRET) {
    throw badRequest(msg('Der Schlüssel muss {min} bis {max} Zeichen lang sein', { min: MIN_SECRET, max: MAX_SECRET })); // i18n-ignore: answer text
  }
  const wrong = guides.formatError(provider, secret);
  if (wrong) throw badRequest(wrong, 'KEY_FORMAT');
  return secret;
}

const allowBackgroundOf = (body) => body?.allow_background === true || body?.allow_background === 1 || body?.allow_background === '1';

async function fileEntries(form, field) {
  if (!form || typeof form.getAll !== 'function') return [];
  return form.getAll(field).filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
}

export function createLocalServer({ getCtx, getProfile, listProfiles, credentials, http, isCoreRoute }) {
  const masked = (provider, entry) => ({
    provider,
    name: guides.guideFor(provider)?.name || provider,
    configured: Boolean(entry),
    from_env: false,
    label: entry?.label || null,
    last4: entry?.last4 || null,
    allow_background: Boolean(entry?.allow_background),
    last_ok_at: entry?.last_ok_at || null,
    last_error: entry?.last_error || null,
    insecure_storage: !credentials.secure
  });

  // a profile row that is not stored yet (second window) has the defaults
  const profileLanguage = () => locales.readProfile(getCtx().db, getProfile().id);

  async function checkLive(provider, secret) {
    const name = guides.guideFor(provider)?.name || provider;
    const blockedBefore = new Set(http.blockedHosts?.() || []);
    try {
      return await gateway.validateCredential(getCtx(), provider, secret);
    } catch (err) {
      const host = PROVIDER_HOSTS[provider];
      if (host && (http.blockedHosts?.() || []).includes(host) && !blockedBefore.has(host)) {
        throw new HttpError(400, msg('{host} lässt Anfragen aus dem Browser nicht zu (CORS). In der App oder mit einem Server funktioniert diese Quelle.', { host: name }), 'CORS_BLOCKED'); // i18n-ignore: answer text
      }
      if (err instanceof sourceRequest.SourceError) {
        if (err.kind === 'auth' || err.kind === 'bad' || err.kind === 'notfound') {
          const params = { provider: name, status: err.status || 401 };
          let text;
          if (provider === 'anilist') text = msg('{provider} lehnt den Token ab ({status})', params); // i18n-ignore: answer text
          else if (provider === 'mal') text = msg('{provider} lehnt die Client-ID ab ({status})', params); // i18n-ignore: answer text
          else text = msg('{provider} lehnt den Schlüssel ab ({status})', params); // i18n-ignore: answer text
          throw new HttpError(400, text, 'KEY_REJECTED');
        }
        throw new HttpError(502, msg('{provider} ist gerade nicht erreichbar, der Schlüssel wurde nicht gespeichert. Bitte später erneut versuchen.', { provider: name }), 'PROVIDER_UNREACHABLE'); // i18n-ignore: answer text
      }
      if (err?.code === 'CORS_BLOCKED') throw new HttpError(400, err.extra?.msg ? msg(err.extra.msg, err.extra.params) : err.message, 'CORS_BLOCKED');
      throw err;
    }
  }

  async function saveKey(userId, provider, body) {
    const secret = cleanSecret(provider, body?.secret);
    const { label } = await checkLive(provider, secret);
    const entry = await credentials.save(userId, provider, { secret, label: label || null, allowBackground: allowBackgroundOf(body) });
    if (userId !== null) {
      gateway.forgetAccess(userId, provider);
      // a new key may belong to another AniList account: the list sync resolves it again
      listSync.onCredentialChanged(getCtx(), userId, provider, { removed: false });
    }
    return masked(provider, entry);
  }

  async function upload(form, field, max) {
    const ctx = getCtx();
    const files = (await fileEntries(form, field)).slice(0, max);
    // answer texts stay German: the client translates them (i18n/serverText.js)
    if (!files.length && max > 1) throw badRequest('Keine Dateien hochgeladen'); // i18n-ignore
    if (!files.length) throw badRequest('Keine Datei hochgeladen'); // i18n-ignore
    const prepared = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Die Datei ist zu groß (höchstens 15 MB)', 'PAYLOAD_TOO_LARGE'); // i18n-ignore
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = imageCheck.detectImageExt(bytes);
      if (!ext) throw badRequest('Nur Bilddateien (JPG, PNG, WebP, GIF, AVIF) sind erlaubt', 'INVALID_FILE_TYPE'); // i18n-ignore
      prepared.push({ name: `${ctx.randomId()}${ext}`, bytes, ext });
    }
    for (const p of prepared) await ctx.files.write(p.name, p.bytes, { image: p.ext });
    return prepared.map((p) => ctx.files.url(p.name));
  }

  const routes = [
    ['GET', /^\/auth\/me$/, () => json({ user: { ...getProfile(), local: true, ...profileLanguage() } })],
    ['PUT', /^\/auth\/profile$/, (m, body) => {
      const fields = locales.parseProfileBody(body);
      return json({ user: { ...getProfile(), local: true, ...locales.saveProfile(getCtx().db, getProfile().id, fields) } });
    }],
    ['GET', /^\/setup\/status$/, () => json({ needsSetup: false })],
    ['POST', /^\/auth\/logout$/, () => json({ success: true })],
    // i18n-ignore: the app name of the health answer
    ['GET', /^\/health$/, () => json({ status: 'ok', name: 'Manga Shelf', local: true })],
    ['GET', /^\/users$/, () => json(listProfiles())],
    ['POST', /^\/upload$/, async (m, body) => json({ url: (await upload(body, 'image', 1))[0] })],
    ['POST', /^\/upload\/multiple$/, async (m, body) => json({ urls: await upload(body, 'images', 10) })],
    ['GET', /^\/auth\/api-keys$/, () => json(guides.userProviders().map((p) => masked(p, credentials.entry(getProfile().id, p))))],
    ['PUT', /^\/auth\/api-keys\/([^/]+)$/, async (m, body) => {
      const provider = providerParam(m[1], guides.userProviders());
      const userId = getProfile().id;
      if (body?.secret === undefined && body?.allow_background !== undefined) {
        const entry = await credentials.setAllowBackground(userId, provider, allowBackgroundOf(body));
        if (!entry) throw notFound('Schlüssel'); // i18n-ignore: answer text
        return json(masked(provider, entry));
      }
      return json(await saveKey(userId, provider, body));
    }],
    ['DELETE', /^\/auth\/api-keys\/([^/]+)$/, async (m) => {
      const provider = providerParam(m[1], guides.userProviders());
      const removed = await credentials.remove(getProfile().id, provider);
      gateway.forgetAccess(getProfile().id, provider);
      if (removed) listSync.onCredentialChanged(getCtx(), getProfile().id, provider, { removed: true });
      return json({ success: true, removed });
    }],
    ['GET', /^\/admin\/api-keys$/, () => json({
      keys: guides.instanceProviders().map((p) => masked(p, credentials.entry(null, p))),
      users_with_keys: credentials.usersWithKeys()
    })],
    ['GET', /^\/admin\/api-keys\/([^/]+)$/, (m) => {
      const provider = providerParam(m[1], guides.instanceProviders());
      return json(masked(provider, credentials.entry(null, provider)));
    }],
    ['PUT', /^\/admin\/api-keys\/([^/]+)$/, async (m, body) => json(await saveKey(null, providerParam(m[1], guides.instanceProviders()), body))],
    ['DELETE', /^\/admin\/api-keys\/([^/]+)$/, async (m) => json({ success: true, removed: await credentials.remove(null, providerParam(m[1], guides.instanceProviders())) })]
  ];

  // server-only areas: answered with a clear text instead of the generic 404 of the core table
  const SERVER_ONLY = /^\/(auth|setup|users|backup|backups|restore|admin|system|version|ical)(\/|$)/;

  return {
    /** The answer for a server-only path, or null when the core table handles it. */
    async handle(method, path, body) {
      for (const [m, re, fn] of routes) {
        if (m !== method) continue;
        const hit = re.exec(path);
        if (hit) return fn(hit, body);
      }
      if (SERVER_ONLY.test(path) && !isCoreRoute(method, path)) throw notLocal();
      return null;
    }
  };
}
