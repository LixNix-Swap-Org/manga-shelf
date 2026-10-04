import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, render, screen } from '@testing-library/react';
import api, {
  apiFetch, request, get, post, put, del, upload, ApiError, TIMEOUTS, SESSION_EXPIRED_EVENT, MESSAGES,
  getApiBase, setServer, apiUrl, assetUrl, assetImgProps, rememberToken, readJson, errorFromResponse, isAbortError, isAppMode,
  sessionEndAnnounced
} from '../utils/api';
import { APP_CSP, appCspPlugin } from '../app/csp.js';
import { getActiveBase, getToken, setToken, setActiveBase } from '../app/connection';
import { postLogout } from '../appShell';
import useLatestRequest from '../hooks/useLatestRequest';
import ScanCandidatesDialog from '../components/dashboard/ScanCandidatesDialog';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers }
});
const html = (status, text = '<html><body>Bad Gateway</body></html>') => new Response(text, {
  status, headers: { 'Content-Type': 'text/html' }
});

/** fetch stub that never answers but rejects like the browser when its signal aborts. */
const hangingFetch = () => vi.fn((url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
}));

const appMode = (base = 'https://shelf.example.org', token = 'tok-123') => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  setServer({ base, token });
};

describe('utils/api', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('web mode', () => {
    it('keeps same-origin paths, sends no bearer token and leaves cookies to the browser', async () => {
      setToken('should-not-be-sent');
      const fetchMock = vi.fn(async () => json(200, { ok: 1 }));
      vi.stubGlobal('fetch', fetchMock);
      expect(isAppMode()).toBe(false);
      expect(getApiBase()).toBe('');
      expect(await get('/api/stats')).toEqual({ ok: 1 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/stats');
      expect(init.headers).toBeUndefined();
      expect(init.credentials).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('assetUrl and apiUrl are the identity', () => {
      setActiveBase('https://elsewhere.example');
      expect(assetUrl('/uploads/a.jpg')).toBe('/uploads/a.jpg');
      expect(apiUrl('/api/export/csv')).toBe('/api/export/csv');
    });

    it('rememberToken stores nothing (the cookie is the session)', () => {
      rememberToken({ token: 'abc' });
      expect(getToken()).toBe('');
    });
  });

  describe('app mode', () => {
    it('prefixes the server base and sends the bearer token, X-Client and no cookies', async () => {
      appMode();
      const fetchMock = vi.fn(async () => json(200, { id: 1 }));
      vi.stubGlobal('fetch', fetchMock);
      expect(getApiBase()).toBe('https://shelf.example.org');
      await post('/api/volumes', { manga_id: 3 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://shelf.example.org/api/volumes');
      expect(init.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Client': 'app',
        Authorization: 'Bearer tok-123'
      });
      expect(init.credentials).toBe('omit');
      expect(init.body).toBe(JSON.stringify({ manga_id: 3 }));
    });

    it('without a token only X-Client is added (login)', async () => {
      appMode('https://shelf.example.org/manga', null);
      const fetchMock = vi.fn(async () => json(200, { token: 'new-token', user: { id: 1 } }));
      vi.stubGlobal('fetch', fetchMock);
      const data = await post('/api/auth/login', { username: 'a', password: 'b' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://shelf.example.org/manga/api/auth/login');
      expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', 'X-Client': 'app' });
      rememberToken(data);
      expect(getToken()).toBe('new-token');
    });

    it('assetUrl prefixes server paths only', () => {
      appMode();
      expect(assetUrl('/uploads/cover.jpg')).toBe('https://shelf.example.org/uploads/cover.jpg');
      expect(assetUrl('https://cdn.example/c.jpg')).toBe('https://cdn.example/c.jpg');
      expect(assetUrl('blob:https://app/123')).toBe('blob:https://app/123');
      expect(assetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
      expect(assetUrl('//cdn.example/c.jpg')).toBe('//cdn.example/c.jpg');
      expect(assetUrl('')).toBe('');
      expect(assetUrl(null)).toBeNull();
      expect(apiUrl('/api/backup')).toBe('https://shelf.example.org/api/backup');
    });

    it('setServer stores base and token; undefined keeps a value, null clears the token', () => {
      vi.stubEnv('VITE_APP_MODE', 'app');
      setServer({ base: 'https://a.example/', token: 't1' });
      expect(getActiveBase()).toBe('https://a.example');
      expect(getToken()).toBe('t1');
      setServer({ base: 'https://a.example/manga' });
      expect(getToken()).toBe('t1');
      setServer({ token: null });
      expect(getToken()).toBe('');
      expect(getActiveBase()).toBe('https://a.example/manga');
    });

    it('a base switch never carries the old token to another server', async () => {
      appMode('https://home.example', 'TOKEN-FOR-HOME');
      setServer({ base: 'http://192.168.1.10:3000' });
      expect(getToken()).toBe('');
      const fetchMock = vi.fn(async () => json(200, { ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      await apiFetch('/api/health');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://192.168.1.10:3000/api/health');
      expect(init.headers.Authorization).toBeUndefined();
      setServer({ base: 'https://home.example' });
      expect(getToken()).toBe('');
    });

    it('a token issued by another origin is not sent, even when it is still stored', async () => {
      appMode('https://home.example', 'TOKEN-FOR-HOME');
      localStorage.setItem('mangashelf_server_base', 'https://other.example');
      const fetchMock = vi.fn(async () => json(200, {}));
      vi.stubGlobal('fetch', fetchMock);
      await apiFetch('/api/stats');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    it('setServer keeps no token in the browser build', () => {
      setServer({ base: 'https://a.example', token: 'web-token' });
      expect(getToken()).toBe('');
    });

    it('a successful logout drops the token', async () => {
      appMode();
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { success: true })));
      expect(await postLogout()).toBe(true);
      expect(getToken()).toBe('');
    });

    it('a logout that did not arrive keeps the token for the retry', async () => {
      appMode();
      vi.stubGlobal('fetch', vi.fn(async () => html(502)));
      expect(await postLogout()).toBe(false);
      expect(getToken()).toBe('tok-123');
    });
  });

  describe('bodies and parsing', () => {
    it('FormData passes through without a JSON content type', async () => {
      const fetchMock = vi.fn(async () => json(200, { url: '/uploads/x.jpg' }));
      vi.stubGlobal('fetch', fetchMock);
      const fd = new FormData();
      fd.append('image', new Blob(['x'], { type: 'image/png' }), 'x.png');
      expect(await upload('/api/upload', fd)).toEqual({ url: '/uploads/x.jpg' });
      const init = fetchMock.mock.calls[0][1];
      expect(init.body).toBe(fd);
      expect(init.headers).toBeUndefined();
      expect(init.method).toBe('POST');
    });

    it('a string body and explicit headers are sent unchanged', async () => {
      const fetchMock = vi.fn(async () => json(200, {}));
      vi.stubGlobal('fetch', fetchMock);
      await apiFetch('/api/import/csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"csv":""}' });
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"csv":""}', headers: { 'Content-Type': 'application/json' } });
    });

    it('put and del use their methods; empty and 204 answers resolve to null', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response('', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await put('/api/volumes/1', { status: 'Fehlt' })).toBeNull();
      expect(await del('/api/volumes/1')).toBeNull();
      expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['PUT', 'DELETE']);
    });

    it('a 200 HTML page (captive portal) is an ApiError NOT_JSON, never data', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => html(200, '<html>Portal</html>')));
      const err = await get('/api/mangas').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('NOT_JSON');
      expect(err.message).toBe(MESSAGES.notJson);
    });

    it('readJson only parses JSON content types', async () => {
      expect(await readJson(json(200, { a: 1 }))).toEqual({ a: 1 });
      expect(await readJson(html(200, '{"a":1}'))).toBeNull();
      expect(await readJson(new Response('{broken', { headers: { 'Content-Type': 'application/json' } }))).toBeNull();
      expect(await readJson(null)).toBeNull();
    });

    it('the default export bundles the helpers', () => {
      expect(api).toMatchObject({ get, post, put, del, upload, request, fetch: apiFetch });
    });
  });

  describe('errors', () => {
    it('uses the server error, code and ref', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'Notiz zu lang', code: 'NOTES_TOO_LONG' })));
      const err = await post('/api/volumes', { notes: 'x' }).catch((e) => e);
      expect(err).toMatchObject({ name: 'ApiError', status: 400, code: 'NOTES_TOO_LONG', message: 'Notiz zu lang' });
      expect(err.isNetwork).toBe(false);

      vi.stubGlobal('fetch', vi.fn(async () => json(500, { error: 'Interner Serverfehler', code: 'INTERNAL', ref: 'req-42' })));
      const err500 = await get('/api/stats').catch((e) => e);
      expect(err500.ref).toBe('req-42');
    });

    it('an HTML error page gives the German fallback', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => html(502)));
      const err = await get('/api/stats').catch((e) => e);
      expect(err).toMatchObject({ status: 502, code: null, message: 'Server nicht erreichbar' });

      const withFallback = await get('/api/stats', { fallback: 'Statistiken konnten nicht geladen werden' }).catch((e) => e);
      expect(withFallback.message).toBe('Statistiken konnten nicht geladen werden (HTTP 502)');

      vi.stubGlobal('fetch', vi.fn(async () => html(413)));
      expect((await post('/api/upload', {}).catch((e) => e)).message).toBe(MESSAGES[413]);
    });

    it('errorFromResponse parses JSON error bodies whatever their content type', async () => {
      const err = await errorFromResponse(new Response('{"error":"Kaputt","code":"X"}', { status: 409 }), 'Fallback');
      expect(err).toMatchObject({ status: 409, code: 'X', message: 'Kaputt' });
      expect((await errorFromResponse(new Response('', { status: 500 }), 'Fehler')).message).toBe('Fehler (HTTP 500)');
    });

    it('a network failure is ApiError NETWORK with status 0', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      const err = await apiFetch('/api/mangas').catch((e) => e);
      expect(err).toMatchObject({ code: 'NETWORK', status: 0, message: MESSAGES.network });
      expect(err.isNetwork).toBe(true);
      expect(err.cause).toBeInstanceOf(TypeError);
    });

    it('a timeout aborts the request and rejects with ApiError TIMEOUT', async () => {
      vi.useFakeTimers();
      const fetchMock = hangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const pending = put('/api/volumes/1', { status: 'Fehlt' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(TIMEOUTS.write - 1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await pending;
      expect(err).toMatchObject({ code: 'TIMEOUT', status: 0, message: MESSAGES.timeout });
      expect(err.isTimeout).toBe(true);
    });

    it('timeout classes: reads 15 s, lookups 90 s, long jobs 10 min, uploads none', () => {
      expect(TIMEOUTS).toMatchObject({ read: 15000, lookup: 90000, remote: 90000, long: 600000, upload: 0 });
      expect(TIMEOUTS.lookup).toBeGreaterThan(18000);
    });

    it('timeouts: 15 s for reads, none for uploads, a custom one, 0 for none', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', hangingFetch());
      const read = get('/api/mangas/1').catch((e) => e);
      await vi.advanceTimersByTimeAsync(TIMEOUTS.read);
      expect((await read).code).toBe('TIMEOUT');

      const uploadFetch = hangingFetch();
      vi.stubGlobal('fetch', uploadFetch);
      const fd = new FormData();
      const up = upload('/api/upload/multiple', fd).catch((e) => e);
      let settled = false;
      up.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(settled).toBe(false);
      expect(uploadFetch.mock.calls[0][1].signal.aborted).toBe(false);
      vi.stubGlobal('fetch', hangingFetch());

      const startup = apiFetch('/api/auth/me', { timeout: TIMEOUTS.auth }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(4000);
      expect((await startup).code).toBe('TIMEOUT');

      const fetchMock = hangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      apiFetch('/api/backup/restore', { method: 'POST', timeout: 0 }).catch(() => {});
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    });

    it('a settled request removes its listener from a long-lived caller signal', async () => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: 1 })));
      for (let i = 0; i < 5; i++) await apiFetch('/api/x', { signal: controller.signal });
      await get('/api/y', { signal: controller.signal });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
      await apiFetch('/api/z', { signal: controller.signal }).catch(() => {});
      expect(add).toHaveBeenCalledTimes(7);
      expect(remove).toHaveBeenCalledTimes(7);
      for (let i = 0; i < 7; i++) expect(remove.mock.calls[i][1]).toBe(add.mock.calls[i][1]);
    });

    it("the caller's abort rejects with its AbortError, not ApiError", async () => {
      vi.stubGlobal('fetch', hangingFetch());
      const controller = new AbortController();
      const pending = get('/api/mangas/1', { signal: controller.signal }).catch((e) => e);
      controller.abort();
      const err = await pending;
      expect(isAbortError(err)).toBe(true);
      expect(err).not.toBeInstanceOf(ApiError);
    });

    it('an already aborted signal never reaches the server answer', async () => {
      const fetchMock = vi.fn(async (url, init) => {
        if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
        return json(200, {});
      });
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      controller.abort();
      expect(isAbortError(await apiFetch('/api/stats', { signal: controller.signal }).catch((e) => e))).toBe(true);
    });
  });

  describe('session expiry (one 401 path)', () => {
    let expired;
    beforeEach(() => {
      expired = vi.fn();
      window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    });
    afterEach(() => window.removeEventListener(SESSION_EXPIRED_EVENT, expired));

    it("the app's own 401 fires the event once and still hands the response to the caller", async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' })));
      const res = await apiFetch('/api/stats');
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'SESSION_INVALID' });
      expect(expired).toHaveBeenCalledTimes(1);
      expect(expired.mock.calls[0][0].detail).toEqual({ url: '/api/stats', status: 401 });

      const err = await get('/api/mangas').catch((e) => e);
      expect(err).toMatchObject({ status: 401, code: 'SESSION_INVALID' });
      expect(expired).toHaveBeenCalledTimes(2);
    });

    it('sessionEndAnnounced tells an announced 401 from a proxy 401', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(401, { code: 'SESSION_INVALID' })));
      expect(sessionEndAnnounced(await apiFetch('/api/stats'))).toBe(true);
      vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'x' })));
      expect(sessionEndAnnounced(await apiFetch('/api/stats'))).toBe(false);
      expect(sessionEndAnnounced(null)).toBe(false);
    });

    it('no event for a 401 without the app code (basic-auth proxy) or from exempt endpoints', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } })));
      await apiFetch('/api/stats');
      vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Falsch', code: 'AUTH_REQUIRED' })));
      await apiFetch('/api/auth/login', { method: 'POST', body: {} });
      await apiFetch('/api/auth/me');
      await apiFetch('/api/auth/password', { method: 'PUT', body: {} });
      await apiFetch('/api/setup/status');
      expect(expired).not.toHaveBeenCalled();
    });

    it('in app mode the relative path decides, not the server base', async () => {
      appMode();
      vi.stubGlobal('fetch', vi.fn(async () => json(401, { code: 'AUTH_REQUIRED' })));
      await apiFetch('/api/mangas');
      expect(expired).toHaveBeenCalledTimes(1);
    });
  });

  describe('useLatestRequest', () => {
    it('a new request aborts the previous one, only the newest is current; unmount aborts it', () => {
      const { result, unmount } = renderHook(() => useLatestRequest());
      const first = result.current();
      expect(first.isCurrent()).toBe(true);
      const second = result.current();
      expect(first.signal.aborted).toBe(true);
      expect(first.isCurrent()).toBe(false);
      expect(second.isCurrent()).toBe(true);
      unmount();
      expect(second.signal.aborted).toBe(true);
      expect(second.isCurrent()).toBe(false);
    });
  });
});

describe('server images in the app build', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it('covers of server paths load from the active server, remote covers stay as they are', () => {
    const candidates = [
      { id: 1, title: 'Lokal', cover_image: '/uploads/a.jpg' },
      { id: 2, title: 'Remote', cover_image: 'https://cdn.example/b.jpg' }
    ];
    const props = { candidates, bookTitle: 'X', canEdit: false, onChoose: vi.fn(), onCreateNew: vi.fn(), onClose: vi.fn() };
    const srcs = () => Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src'));

    const web = render(<ScanCandidatesDialog {...props} />);
    expect(srcs()).toEqual(['/uploads/a.jpg', 'https://cdn.example/b.jpg']);
    web.unmount();

    vi.stubEnv('VITE_APP_MODE', 'app');
    setServer({ base: 'https://shelf.example.org' });
    render(<ScanCandidatesDialog {...props} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(srcs()).toEqual(['https://shelf.example.org/uploads/a.jpg', 'https://cdn.example/b.jpg']);
    expect(Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('crossorigin')))
      .toEqual(['anonymous', null]);
  });

  it('assetImgProps asks for CORS only for server paths in the app build', () => {
    expect(assetImgProps('/uploads/a.jpg')).toEqual({ src: '/uploads/a.jpg' });
    vi.stubEnv('VITE_APP_MODE', 'app');
    setServer({ base: 'https://shelf.example.org' });
    expect(assetImgProps('/uploads/a.jpg')).toEqual({ src: 'https://shelf.example.org/uploads/a.jpg', crossOrigin: 'anonymous' });
    expect(assetImgProps('https://cdn.example/b.jpg')).toEqual({ src: 'https://cdn.example/b.jpg' });
    expect(assetImgProps('blob:https://app/1')).toEqual({ src: 'blob:https://app/1' });
    expect(assetImgProps(null)).toEqual({ src: null });
  });

  it('every <img> of a server path goes through assetImgProps', async () => {
    const files = import.meta.glob('../components/**/*.jsx', { query: '?raw', import: 'default', eager: true });
    const offenders = Object.entries(files).filter(([, text]) => /src=\{assetUrl\(/.test(text)).map(([file]) => file);
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

describe('app build CSP', () => {
  it('the app build injects a CSP meta that only allows its own scripts', () => {
    const tags = appCspPlugin().transformIndexHtml('<html></html>');
    expect(tags).toEqual([{
      tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: APP_CSP }, injectTo: 'head-prepend'
    }]);
    const directives = Object.fromEntries(APP_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]));
    expect(directives).toMatchObject({
      'default-src': "'self'",
      'script-src': "'self'",
      'connect-src': 'http: https:',
      'object-src': "'none'",
      'base-uri': "'self'",
      'form-action': "'none'"
    });
  });
});
