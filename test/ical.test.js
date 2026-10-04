const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sha256Hex, escapeText, foldLine, formatStamp, allDay, buildCalendar } = require('../core/ical');
const { feedVolumeLabel } = require('../core/handlers/radar');

const nodeSha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

test('sha256Hex matches Node crypto (empty, multi-block, umlauts, emoji)', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const text of ['x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'ä'.repeat(200), 'Band 📚 Ünïcödé', crypto.randomBytes(32).toString('base64url')]) {
        assert.equal(sha256Hex(text), nodeSha(text), text.slice(0, 20));
    }
});

test('escapeText escapes backslash, semicolon, comma and line breaks', () => {
    assert.equal(escapeText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
    assert.equal(escapeText(null), '');
});

test('foldLine folds at 75 octets without splitting a UTF-8 character', () => {
    const long = 'SUMMARY:' + 'ä'.repeat(100);
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    assert.ok(lines.length > 1);
    for (const line of lines) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
    for (const line of lines.slice(1)) assert.equal(line[0], ' ');
    assert.equal(lines.map((l, i) => (i ? l.slice(1) : l)).join(''), long);
    assert.equal(foldLine('KURZ:x'), 'KURZ:x');
});

test('formatStamp and allDay', () => {
    assert.equal(formatStamp(new Date(Date.UTC(2026, 9, 4, 8, 5, 9))), '20261004T080509Z');
    assert.deepEqual(allDay('2026-12-31'), { start: '20261231', end: '20270101' });
    assert.deepEqual(allDay(' 2028-02-28 '), { start: '20280228', end: '20280229' });
    assert.equal(allDay('2026-11'), null);
    assert.equal(allDay('2026-02-30'), null);
    assert.equal(allDay(''), null);
});

test('buildCalendar writes a valid VCALENDAR with CRLF lines and skips events without a full date', () => {
    const text = buildCalendar({
        name: 'Manga Shelf – Termine',
        events: [
            { uid: 'volume-1@x', date: '2026-11-05', summary: 'One Piece – Band 108', description: 'Status: Vorbestellt\nPreis: 7,50 €', categories: 'Manga' },
            { uid: 'volume-2@x', date: '2026-12', summary: 'Nur Monat' }
        ],
        now: new Date(Date.UTC(2026, 9, 4, 12, 0, 0))
    });
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/[^\r]\n/.test(text), 'every line ends with CRLF');
    assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(text, /DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106/);
    assert.match(text, /SUMMARY:One Piece – Band 108/);
    assert.match(text, /DESCRIPTION:Status: Vorbestellt\\nPreis: 7\\,50 €/);
    assert.match(text, /DTSTAMP:20261004T120000Z/);
    assert.ok(!text.includes('Nur Monat'));
});

test('feedVolumeLabel names regular volumes, slipcases and specials', () => {
    assert.equal(feedVolumeLabel({ volume_number: '108', type: 'volume' }), 'Band 108');
    assert.equal(feedVolumeLabel({ volume_number: '3', type: 'schuber' }), 'Schuber 3');
    assert.equal(feedVolumeLabel({ volume_number: 'Vollschuber 1-5', type: 'schuber' }), 'Vollschuber 1-5');
    assert.equal(feedVolumeLabel({ volume_number: '2', type: 'special' }), 'Sonderband 2');
    assert.equal(feedVolumeLabel({ volume_number: '7', type: 'special_edition' }), 'Band 7 (Special Edition)');
    assert.equal(feedVolumeLabel({ volume_number: 'Artbook', type: 'volume' }), 'Artbook');
});

test('the feed runs in the in-memory core (apps) with a stored token and a fixed clock', async () => {
    const { createMemoryCore } = require('./core/harness');
    const core = createMemoryCore({ now: () => new Date('2026-10-04T10:00:00Z') });
    try {
        const token = 'T'.repeat(43);
        const userId = core.users[0].id;
        core.conn.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(`calendar_feed:${nodeSha(token)}`, JSON.stringify({ user_id: userId, created_at: '2026-10-01T00:00:00Z', last_used_at: null }));
        core.conn.prepare("INSERT INTO mangas (id, title, publisher) VALUES (1, 'Frieren', 'Egmont')").run();
        core.conn.prepare("INSERT INTO volumes (manga_id, volume_number, status, release_date, price) VALUES (1, '14', 'Vorbestellt', '2026-10-20', 7)").run();
        core.conn.prepare("INSERT INTO volumes (manga_id, volume_number, status, release_date) VALUES (1, '13', 'Bestellt', '2026-08-01')").run();
        const anonymous = core.client(null);
        const res = await anonymous.raw('GET', `/radar/feed.ics?token=${token}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers['Content-Type'], 'text/calendar; charset=utf-8');
        assert.match(res.text, /SUMMARY:Frieren – Band 14\r\n/);
        assert.match(res.text, /DTSTART;VALUE=DATE:20261020/);
        assert.ok(!res.text.includes('Band 13'), 'more than 30 days ago');
        const stored = JSON.parse(core.conn.prepare('SELECT value FROM app_settings WHERE key LIKE ?').get('calendar_feed:%').value);
        assert.equal(stored.last_used_at, Date.parse('2026-10-04T10:00:00Z'));
        assert.equal((await anonymous.raw('GET', `/radar/feed.ics?token=${'U'.repeat(43)}`)).status, 404);
    } finally {
        await core.close();
    }
});
