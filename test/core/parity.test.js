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
/** Row timestamps (created_at, updated_at, read_at, generated_at) differ between the two databases. */
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, TIME_KEY.test(k) && v !== null ? '<time>' : normalize(v)]));
    }
    return value;
}

/** Runs one request on both and checks that the answers agree; returns the body. */
async function both(user, method, url, body) {
    const [a, b] = await Promise.all([express.client(user).raw(method, url, body), memory.client(user).raw(method, url, body)]);
    assert.equal(a.status, b.status, `${user} ${method} ${url}: status ${a.status} vs ${b.status} ${a.text} | ${b.text}`);
    if (a.body === null || b.body === null) assert.equal(a.text, b.text, `${user} ${method} ${url}`);
    else assert.deepEqual(normalize(a.body), normalize(b.body), `${user} ${method} ${url}`);
    return a.body;
}

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

    const reads = [
        '/mangas', `/mangas/${naruto}`, `/mangas/${onePiece}`, `/mangas/${wish}`, '/offline-snapshot', '/stats', '/shopping-list',
        '/shopping-list?include_others=1', '/release-radar', '/dashboard-summary', '/users/1/stats', '/users/2/stats',
        '/lookup/isbn?isbn=9783551023452', '/export/csv'
    ];
    for (const user of ['admin', 'ed', 'vis']) {
        for (const url of reads) await both(user, 'GET', url);
    }
    const snapshot = await both('ed', 'GET', '/offline-snapshot');
    assert.deepEqual(snapshot.mangas.map(m => m.title), ['CSV-Reihe', 'Kalenderreihe', 'Naruto', 'One Piece', 'Wunschreihe']);
    assert.equal(Object.values(snapshot.details).reduce((n, m) => n + m.volumes.length, 0), 15);
    assert.ok((await both('ed', 'GET', '/release-radar')).groups.length >= 2);
});

test('the comparison notices a difference', async () => {
    memory.conn.prepare("UPDATE mangas SET author = 'Jemand anderes' WHERE title = 'Naruto'").run();
    await assert.rejects(both('ed', 'GET', '/mangas'), /ed GET \/mangas/);
});
