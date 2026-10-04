// Crunchyroll history in the apps (core/watch/crunchyroll.js): requests, answer parsing, item rules and progress planning.
const test = require('node:test');
const assert = require('node:assert/strict');
const cr = require('../../core/watch/crunchyroll');
const { fixture } = require('./helpers');

const SECRET = { etp_rt: 'etp-test-cookie-0001', client_id: 'test_client_01', device_id: '11111111-2222-4333-8444-555555555555', account_id: null, saved_at: 1 };
const res = (status, body, headers = {}) => ({ status, headers, text: typeof body === 'string' ? body : JSON.stringify(body) });

test('login options and secret: client id from the login page, dated fallback, nothing but the cookie and ids', () => {
    assert.deepEqual(Object.keys(cr.LOGIN_OPTIONS).sort(), ['cookieDomain', 'cookieName', 'doneWhen', 'readScript', 'url']);
    assert.deepEqual([cr.LOGIN_OPTIONS.cookieName, cr.LOGIN_OPTIONS.cookieDomain, cr.LOGIN_OPTIONS.doneWhen], ['etp_rt', 'crunchyroll.com', { pathNotContaining: '/login' }]);
    assert.match(cr.LOGIN_OPTIONS.url, /^https:\/\/www\.crunchyroll\.com\/de\/login$/);
    assert.match(cr.ENDPOINTS.clientIdFallback.date, /^\d{4}-\d{2}-\d{2}$/);

    const login = { cookie: { value: 'etp-test-cookie-0001', expires: 1 }, scriptResult: JSON.stringify({ accountAuthClientId: 'page_client_1', anonClientId: 'anon_1' }) };
    assert.deepEqual(cr.secretFromLogin(login, { deviceId: SECRET.device_id, now: 42 }),
        { etp_rt: 'etp-test-cookie-0001', client_id: 'page_client_1', device_id: SECRET.device_id, account_id: null, saved_at: 42 });
    assert.equal(cr.secretFromLogin({ ...login, scriptResult: null }).client_id, cr.ENDPOINTS.clientIdFallback.id);
    assert.equal(cr.secretFromLogin({ ...login, scriptResult: { anonClientId: 'anon_only' } }).client_id, 'anon_only');
    assert.equal(cr.secretFromLogin({ ...login, scriptResult: '{"accountAuthClientId":"bad id;"}' }).client_id, cr.ENDPOINTS.clientIdFallback.id);
    assert.equal(cr.secretFromLogin({ cookie: { value: 'a b' } }), null);
    assert.equal(cr.secretFromLogin(null), null);

    assert.deepEqual(cr.parseSecret(cr.serializeSecret({ ...SECRET, password: 'never' })), SECRET);
    assert.equal(cr.parseSecret('{"etp_rt":"x"}'), null);
    assert.equal(cr.parseSecret('kaputt'), null);
});

test('token request: Basic client id, form body with the cookie grant, the cookie by hand', () => {
    const req = cr.buildTokenRequest(SECRET);
    assert.equal(req.url, 'https://www.crunchyroll.com/auth/v1/token');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from('test_client_01:').toString('base64')}`);
    assert.equal(req.headers.Cookie, 'etp_rt=etp-test-cookie-0001');
    assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(req.body);
    assert.deepEqual([form.get('grant_type'), form.get('device_id'), form.get('device_type')], ['etp_rt_cookie', SECRET.device_id, cr.ENDPOINTS.deviceType]);
    assert.equal(new URLSearchParams(cr.buildTokenRequest({ ...SECRET, device_id: null }).body).has('device_id'), false);
    for (const text of ['', 'a', 'ab', 'abc', 'äöü€', 'x'.repeat(31)]) assert.equal(cr.base64(text), Buffer.from(text).toString('base64'), text);
    assert.ok(cr.isAllowedApiUrl(req.url));
    for (const url of ['http://www.crunchyroll.com/x', 'https://crunchyroll.com.evil.tld/x', 'https://www.crunchyroll.com:444/x', 'https://beta-api.crunchyroll.com/x', 'kaputt']) {
        assert.equal(cr.isAllowedApiUrl(url), url === 'https://beta-api.crunchyroll.com/x', url);
    }
});

test('token answer: access token, account id, a rotated cookie; failures say whether the secret goes', () => {
    const ok = cr.parseTokenResponse(res(200, fixture('crunchyroll/token.json'), { 'Set-Cookie': ['__cf_bm=x; Path=/', 'etp_rt=etp-rotated-0002; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly'] }));
    assert.deepEqual(ok, { ok: true, access_token: 'test-access-token-0001', account_id: '00000000-0000-4000-8000-000000000001', etp_rt: 'etp-rotated-0002' });
    assert.equal(cr.parseTokenResponse(res(200, fixture('crunchyroll/token.json'), { 'set-cookie': '__cf_bm=x; Path=/, etp_rt=etp-rotated-0003; Path=/' })).etp_rt, 'etp-rotated-0003');
    assert.equal(cr.parseTokenResponse(res(200, fixture('crunchyroll/token.json'))).etp_rt, null);
    const parsed = { ...res(200, fixture('crunchyroll/token.json'), { 'set-cookie': 'etp_rt=etp-from-header-04; Path=/' }), cookies: [{ name: '__cf_bm', value: 'x' }, { name: 'etp_rt', value: 'etp-from-cookies-05', expires: null }] };
    assert.equal(cr.parseTokenResponse(parsed).etp_rt, 'etp-from-cookies-05', 'the platform-parsed cookies win over the joined header');
    assert.equal(cr.parseTokenResponse(res(200, fixture('crunchyroll/token.json'), { 'Set-Cookie': 'etp_rt=; Max-Age=0' })).etp_rt, null);

    const cases = [
        [res(400, { error: 'invalid_grant' }), 'reconnect', true],
        [res(401, { error: 'invalid_client' }), 'reconnect', true],
        [res(400, { error: 'invalid_client' }), 'reconnect', true],
        [res(403, '<html>Just a moment...</html>'), 'blocked', false],
        [res(429, ''), 'rate_limited', false],
        [res(503, ''), 'unavailable', false],
        [{ status: 0, text: '' }, 'unavailable', false],
        [res(400, { error: 'invalid_request' }), 'bad_response', false],
        [res(200, '<html></html>'), 'bad_response', false],
        [res(200, { token_type: 'Bearer' }), 'bad_response', false]
    ];
    for (const [answer, error, clear] of cases) {
        const failed = cr.parseTokenResponse(answer);
        assert.deepEqual([failed.ok, failed.error, failed.clear_secret, failed.message], [false, error, clear, cr.MESSAGES[error]], JSON.stringify(answer));
    }
    assert.equal(cr.parseTokenResponse(res(401, {})).message, 'Bitte erneut verbinden');
    assert.equal(cr.parseTokenResponse(undefined).error, 'unavailable');
});

test('api requests and /accounts/v1/me', () => {
    assert.deepEqual(cr.buildApiRequest(cr.ENDPOINTS.me, 'tok'), { url: 'https://www.crunchyroll.com/accounts/v1/me', method: 'GET', headers: { Authorization: 'Bearer tok', Accept: 'application/json' } });
    assert.equal(cr.ENDPOINTS.watchHistory('acc-1'), 'https://www.crunchyroll.com/content/v2/acc-1/watch-history?page_size=100&locale=de-DE');
    assert.equal(cr.ENDPOINTS.discoverHistory('acc/1', { pageSize: 20 }), 'https://www.crunchyroll.com/content/v2/discover/acc%2F1/history?n=20&locale=de-DE');
    assert.deepEqual(cr.parseMe(res(200, fixture('crunchyroll/me.json'))), { ok: true, account_id: '00000000-0000-4000-8000-000000000001' });
    assert.equal(cr.parseMe(res(401, {})).error, 'reconnect');
    assert.equal(cr.parseMe(res(200, {})).error, 'bad_response');
});

test('watch history: highest episode per series and season, seen by flag or playhead, specials/movies/odd ids dropped', () => {
    const items = cr.parseWatchHistory(fixture('crunchyroll/watch-history.json'));
    assert.deepEqual(items, [
        {
            external_id: 'GTESTSER01', series_title: 'Frieren: Beyond Journey\'s End', season: 1, episode: 8, fully_watched: false,
            resume_url: 'https://www.crunchyroll.com/watch/GTESTEP008/test-episode-eight', resume_episode: 8, watched_at: '2026-10-03T20:15:00.000Z'
        },
        {
            external_id: 'GTESTSER01', series_title: 'Frieren: Beyond Journey\'s End', season: 2, episode: 2, fully_watched: true,
            resume_url: null, resume_episode: null, watched_at: '2026-10-01T19:00:00.000Z'
        },
        {
            external_id: 'GTESTDNG01', series_title: 'Delicious in Dungeon', season: 1, episode: 3, fully_watched: true,
            resume_url: null, resume_episode: null, watched_at: '2026-09-30T21:00:00.000Z'
        }
    ]);
    assert.deepEqual(cr.parseWatchHistory('kaputt'), []);
    assert.deepEqual(cr.parseWatchHistory({ data: [null, 1, { panel: {} }] }), []);
});

test('discover history and merge: the in-progress or next episode becomes the resume link', () => {
    const watch = cr.parseWatchHistory(fixture('crunchyroll/watch-history.json'));
    const next = cr.parseDiscoverHistory(fixture('crunchyroll/discover-history.json'));
    assert.deepEqual(next.map((i) => [i.external_id, i.episode, i.fully_watched, i.resume_episode]),
        [['GTESTSER01', 8, false, 8], ['GTESTDNG01', 4, false, 4], ['GTESTNEW99', 1, false, 1]]);
    const merged = cr.mergeItems(watch, next);
    const dungeon = merged.find((i) => i.external_id === 'GTESTDNG01');
    assert.deepEqual([dungeon.episode, dungeon.fully_watched, dungeon.resume_url, dungeon.resume_episode, dungeon.watched_at],
        [4, false, 'https://www.crunchyroll.com/watch/GTESTDG004/test-dungeon-four', 4, '2026-09-30T21:00:00.000Z'],
        'three seen plus a link to four beats three seen without a link; the newest date stays');
    assert.deepEqual(merged.map((i) => cr.watchedCount(i)), [7, 2, 3, 0]);
    const body = cr.syncBody(merged);
    assert.equal(body.service, 'crunchyroll');
    assert.deepEqual(body.items, merged);
    assert.ok(!JSON.stringify(body).includes('etp'), 'nothing secret in the sync body');
    const many = Array.from({ length: 250 }, (_, i) => ({ external_id: `GTESTMNY${String(i).padStart(2, '0')}`, episode: 1, fully_watched: true }));
    assert.equal(cr.syncBody(many).items.length, 200, 'the body stays within the handler cap');
});

test('cleanItem: the item rules the handler checks again', () => {
    assert.deepEqual(cr.cleanItem({ external_id: 'gtestser01', episode: 3, fully_watched: true, resume_url: 'https://www.crunchyroll.com/de/watch/GTESTEP004/x?y=1', watched_at: '2026-10-01T00:00:00+02:00' }),
        { external_id: 'GTESTSER01', series_title: null, season: 1, episode: 3, fully_watched: true, resume_url: 'https://www.crunchyroll.com/watch/GTESTEP004/x', resume_episode: 4, watched_at: '2026-09-30T22:00:00.000Z' });
    assert.equal(cr.cleanItem({ external_id: 'GTESTSER01', episode: 3, resume_url: 'https://www.crunchyroll.com/series/GTESTSER01' }).resume_url, null, 'series links are no resume link');
    assert.equal(cr.cleanItem({ external_id: 'GTESTSER01', episode: 3, resume_url: 'https://evil.example/watch/GTESTEP004' }).resume_url, null);
    for (const bad of [null, {}, { external_id: 'x', episode: 1 }, { external_id: 'GTESTSER01', episode: 0 }, { external_id: 'GTESTSER01', episode: 1.5 },
        { external_id: 'GTESTSER01', episode: 1, season: 0 }, { external_id: 'GTESTSER01', episode: 1, fully_watched: 'yes' }, { external_id: '../../x', episode: 1 }]) {
        assert.equal(cr.cleanItem(bad), null, JSON.stringify(bad));
    }
});

test('planProgress: never backwards, the total caps, the resume link only for the next episode', () => {
    const item = (episode, fully, resume = null) => cr.cleanItem({ external_id: 'GTESTSER01', episode, fully_watched: fully, resume_url: resume, resume_episode: resume ? (fully ? episode + 1 : episode) : null });
    const ep8 = 'https://www.crunchyroll.com/watch/GTESTEP008/x';
    assert.deepEqual(cr.planProgress([item(8, false, ep8)], { episodes: 28, episodes_watched: 3 }), { change: { episodes_watched: 7, resume_url: ep8, resume_episode: 8 } });
    assert.deepEqual(cr.planProgress([item(7, true), item(8, false, ep8)], { episodes: 28, episodes_watched: 0 }).change.resume_url, ep8, 'equal counts prefer the one with a link');
    assert.equal(cr.planProgress([item(5, true)], { episodes: 28, episodes_watched: 9 }), null, 'never backwards');
    assert.equal(cr.planProgress([item(8, false, ep8)], { episodes: 28, episodes_watched: 7, resume_url: ep8 }), null, 'nothing new');
    assert.deepEqual(cr.planProgress([item(8, false, ep8)], { episodes: 28, episodes_watched: 7, resume_url: null }).change, { episodes_watched: 7, resume_url: ep8, resume_episode: 8 });
    assert.deepEqual(cr.planProgress([item(12, true)], { episodes: 12, episodes_watched: 11 }).change, { episodes_watched: 12, resume_url: null, resume_episode: null });
    assert.deepEqual(cr.planProgress([item(13, false, ep8)], { episodes: 12, episodes_watched: 2 }).change, { episodes_watched: 12, resume_url: null, resume_episode: null },
        'an episode past the total in progress means the entry is done, no link beyond it');
    assert.deepEqual(cr.planProgress([item(14, true)], { episodes: 12, episodes_watched: 2 }), { above_total: true, count: 14 });
    assert.equal(cr.planProgress([item(14, true)], { episodes: 12, episodes_watched: 12 }), null, 'already at the total: nothing to ask');
    assert.deepEqual(cr.planProgress([item(40, true)], { episodes: null, episodes_watched: 2 }).change.episodes_watched, 40, 'unknown total: no cap');
    assert.equal(cr.planProgress([item(1, false, ep8)], { episodes: 12 }), null, 'nothing watched yet');
    assert.equal(cr.planProgress([], {}), null);
});

test('season helpers: titles name a season, season links are keyed per series and season', () => {
    const cases = [[['Sousou no Frieren 2nd Season'], 2], [['Frieren'], 1], [['Shingeki no Kyojin Season 3'], 3], [['Mushoku Tensei: Second Season'], 2],
        [['Spy x Family 2. Staffel'], 2], [['Dr. Stone', 'Dr. Stone: Staffel 3'], 3], [['Kaguya-sama', 'Kaguya-sama: zweite Staffel'], 2], [['Season of Love'], 1]];
    for (const [titles, n] of cases) assert.equal(cr.seasonFromTitles(titles), n, titles.join(' / '));
    assert.equal(cr.seasonMarkerOf(['Frieren']), null, 'no marker');
    assert.equal(cr.seasonMarkerOf(['Probe', 'Probe Season 1']), 1);
    assert.deepEqual(cr.seasonLinkOf('crunchyroll', 'gtestser01', 2), { service: 'crunchyroll:season:2', external_id: 'GTESTSER01:2' });
    assert.notEqual(cr.seasonLinkOf('crunchyroll', 'X', 1).service, cr.seasonLinkOf('crunchyroll', 'X', 2).service, 'one entry can hold several seasons');
});
