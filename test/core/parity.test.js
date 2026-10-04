// The same requests against the Express server and the in-memory core give the same JSON (timestamps aside).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startExpressCore, createMemoryCore } = require('./harness');

let express;
let memory;

test.before(async () => {
    express = await startExpressCore();
    memory = createMemoryCore();
});

test.after(async () => {
    await express.close();
    await memory.close();
});

const pad = (n) => String(n).padStart(2, '0');
const month = (offset) => {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    return `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
};

const TIME_KEY = /(^|_)at$/;
const MANUAL_KEY = /manual:[0-9a-f]{24}/g;
/** Random manual work keys become <manual1>, <manual2> … by first appearance, so the grouping is still compared. */
const manualKeys = (text, seen) => text.replace(MANUAL_KEY, (key) => {
    if (!seen.has(key)) seen.set(key, `<manual${seen.size + 1}>`);
    return seen.get(key);
});
/** Row timestamps (created_at, updated_at, read_at, generated_at), random undo tokens and manual work keys differ between the two. */
function normalize(value, seen = new Map()) {
    if (Array.isArray(value)) return value.map(v => normalize(v, seen));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => {
            if (k === 'undo_token' && typeof v === 'string') return [k, '<token>'];
            return [k, TIME_KEY.test(k) && v !== null ? '<time>' : normalize(v, seen)];
        }));
    }
    return typeof value === 'string' ? manualKeys(value, seen) : value;
}

/** One request on each side (bodies may differ, e.g. their own undo token); checks that the answers agree. */
async function pair(user, method, url, expressBody, memoryBody) {
    const [a, b] = await Promise.all([express.client(user).raw(method, url, expressBody), memory.client(user).raw(method, url, memoryBody)]);
    assert.equal(a.status, b.status, `${user} ${method} ${url}: status ${a.status} vs ${b.status} ${a.text} | ${b.text}`);
    if (a.body === null || b.body === null) assert.equal(manualKeys(a.text, new Map()), manualKeys(b.text, new Map()), `${user} ${method} ${url}`);
    else assert.deepEqual(normalize(a.body), normalize(b.body), `${user} ${method} ${url}`);
    return [a.body, b.body];
}

/** Runs one request on both and checks that the answers agree; returns the body. */
const both = async (user, method, url, body) => (await pair(user, method, url, body, body))[0];

test('a seeded collection reads the same through Express and the in-memory core', async () => {
    const naruto = (await both('ed', 'POST', '/mangas', { title: 'Naruto', publisher: 'carlsen manga', total_volumes: 72, author: 'Kishimoto' })).id;
    const onePiece = (await both('admin', 'POST', '/mangas', { title: 'One Piece', publisher: 'Carlsen', status: 'Laufend' })).id;
    const wish = (await both('ed', 'POST', '/mangas', { title: 'Wunschreihe', wish_priority: 2, publisher: 'Altraverse' })).id;
    await both('ed', 'POST', '/volumes/batch', { manga_id: naruto, from: 1, to: 6, default_price: '6,95', status: 'Vorhanden' });
    await both('ed', 'POST', '/volumes', { manga_id: naruto, volume_number: '7', status: 'Fehlt', price: 7.5, priority: 3, target_price: 5 });
    await both('ed', 'POST', '/volumes', { manga_id: naruto, volume_number: '8', status: 'Vorbestellt', release_date: `${month(1)}-12`, price: 7.5 });
    await both('ed', 'POST', '/volumes', { manga_id: naruto, volume_number: '1', type: 'special_edition', notes: 'Collectors Edition', isbn: '9783551023452' });
    await both('admin', 'POST', '/volumes', { manga_id: onePiece, volume_number: 'Schuber 1', type: 'schuber', price: 12 });
    await both('admin', 'POST', '/volumes', { manga_id: onePiece, volume_number: '1', purchase_date: '2023-05-06', price: 5.5 });
    await both('admin', 'POST', '/volumes', { manga_id: onePiece, volume_number: '2', status: 'Fehlt', release_date: month(2) });
    await both('admin', 'POST', '/volumes', { manga_id: wish, volume_number: '1', status: 'Fehlt', price: 9 });

    const detail = await both('ed', 'GET', `/mangas/${naruto}`);
    const vol = (n, type = 'volume') => detail.volumes.find(v => v.volume_number === n && v.type === type).id;
    await both('admin', 'POST', `/volumes/${vol('1')}/owners`, { owned: true, purchase_date: '2024-01-02', price: 5 });
    await both('vis', 'POST', `/volumes/${vol('2')}/owners`, { owned: true });
    await both('admin', 'POST', `/volumes/${vol('3')}/owners`, { owned: true, user_id: 3, purchase_date: '2024-02-03' });
    await both('ed', 'POST', `/volumes/${vol('2')}/owners`, { owned: false });
    await both('ed', 'POST', `/volumes/${vol('1')}/read`, {});
    await both('admin', 'POST', '/volumes/batch-read', { manga_id: naruto, up_to_volume: 4 });
    await both('admin', 'POST', `/volumes/${vol('4')}/read`, { read: false });
    await both('ed', 'PUT', `/volumes/${vol('5')}`, { notes: 'Signiert', condition: 'Neu', priority: 1 });
    await both('ed', 'DELETE', `/volumes/${vol('6')}`);
    await both('ed', 'PUT', `/mangas/${onePiece}`, { tags: 'Abenteuer, Piraten', wish_priority: null });
    await both('admin', 'PUT', '/stats/settings', { collection_start_date: '2021-04-09' });
    await both('ed', 'POST', '/import/csv', { csv: 'Reihe;Verlag;Bandnummer;Status;Preis;Besitzer;Gelesen von\nCSV-Reihe;Kazé;1;Vorhanden;8,00;ed;ed, admin\nCSV-Reihe;Kazé;2;Fehlt;8,00;;\n' });
    await both('ed', 'POST', '/manga-passion/import', { title: 'Kalenderreihe', volume_number: '4', target_status: 'Vorbestellt', release_date: month(1) });
    await both('ed', 'POST', '/mangas/999/batch-import-gaps', { volume_numbers: ['1'] });
    await both('vis', 'PUT', `/mangas/${naruto}`, { title: 'Nein' });
    const [bulkA, bulkB] = await pair('ed', 'POST', '/volumes/bulk', ...Array(2).fill({ ids: [vol('7'), vol('8')], set: { priority: 2, target_price: 4 } }));
    await pair('ed', 'POST', '/volumes/bulk', { revert: bulkA.undo_token }, { revert: bulkB.undo_token });
    const [dropA, dropB] = await pair('ed', 'POST', '/volumes/bulk', ...Array(2).fill({ ids: [vol('1'), vol('2')], delete: true }));
    await both('ed', 'GET', `/mangas/${naruto}`);
    await pair('ed', 'POST', '/volumes/bulk', { revert: dropA.undo_token }, { revert: dropB.undo_token });
    await both('admin', 'POST', '/volumes/bulk', { ids: [vol('5')], owners: { add: [1] }, set: { purchase_date: '2024-09-09' } });

    // editions: a linked English edition priced in USD, a work group merged and left again, a volume language, CSV edition columns
    const narutoEn = (await both('ed', 'POST', `/mangas/${naruto}/editions`, { language: 'en', region: 'US', currency: 'USD' })).id;
    await both('ed', 'POST', '/volumes', { manga_id: narutoEn, volume_number: '1', status: 'Vorbestellt', release_date: `${month(1)}-20`, price: 9.99 });
    await both('ed', 'PUT', `/mangas/${wish}/work`, { link_to: naruto });
    await both('ed', 'PUT', `/mangas/${wish}/work`, { link_to: null });
    await both('ed', 'PUT', `/volumes/${vol('5')}`, { language: 'ja' });
    await both('ed', 'GET', `/mangas/${naruto}/gaps`);
    await both('ed', 'POST', '/import/csv', { csv: 'Reihe;Bandnummer;Sprache;Region;Währung;Werk;Bandsprache\nCSV-Edition;1;Englisch;GB;GBP;manual:77;ja\n' });

    const anime = (await both('ed', 'POST', '/anime', { title: 'Parität Anime', episodes: 12 })).id;
    await both('ed', 'POST', `/anime/${anime}/watched`, { episode: 4, url: 'https://www.crunchyroll.com/de/watch/GPARITY01/a-title', remember: { service: 'crunchyroll', external_id: 'GPARITY99' } });
    await both('ed', 'POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/series/GPARITY99/paritaet-anime' });

    const reads = [
        '/anime', `/anime/${anime}`, '/anime/sync', '/mangas', '/mangas/volume-search', `/mangas/${naruto}`, `/mangas/${narutoEn}`, `/mangas/${onePiece}`, `/mangas/${wish}`, '/offline-snapshot', '/stats', '/shopping-list',
        '/shopping-list?include_others=1', '/release-radar', '/dashboard-summary', '/users/1/stats', '/users/2/stats',
        '/lookup/isbn?isbn=9783551023452', '/export/csv', '/tags', '/trash', '/publishers', '/stats/reading', '/stats/reading?user_id=1',
        '/maintenance/quality'
    ];
    for (const user of ['admin', 'ed', 'vis']) {
        for (const url of reads) await both(user, 'GET', url);
    }
    const snapshot = await both('ed', 'GET', '/offline-snapshot');
    assert.deepEqual(snapshot.mangas.map(m => m.title), ['CSV-Edition', 'CSV-Reihe', 'Kalenderreihe', 'Naruto', 'Naruto', 'One Piece', 'Wunschreihe']);
    assert.equal(Object.values(snapshot.details).reduce((n, m) => n + m.volumes.length, 0), 17);
    assert.deepEqual(snapshot.details[naruto].editions.map(e => [e.id, e.language, e.currency]), [[narutoEn, 'en', 'USD']]);
    const [csvEdition] = snapshot.mangas.filter(m => m.title === 'CSV-Edition');
    assert.deepEqual([csvEdition.language, csvEdition.region, csvEdition.currency], ['en', 'GB', 'GBP']);
    assert.match(csvEdition.work_key, /^manual:[0-9a-f]{24}$/, 'a manual key of the file gets a fresh one');
    assert.notEqual(snapshot.mangas.find(m => m.id === naruto).work_key, csvEdition.work_key);
    assert.ok((await both('ed', 'GET', '/release-radar')).groups.length >= 2);
});

test('the comparison notices a difference', async () => {
    memory.conn.prepare("UPDATE mangas SET author = 'Jemand anderes' WHERE title = 'Naruto'").run();
    await assert.rejects(both('ed', 'GET', '/mangas'), /ed GET \/mangas/);
});
