// Orphaned upload cleanup against an isolated data directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-cleanup-'));
process.env.DATA_DIR = dataDir;
const { db, uploadsDir, closeDb } = require('../db');
const { cleanOrphanUploads } = require('../services/uploadCleanup');

test.after(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function put(name, ageDays) {
    const file = path.join(uploadsDir, name);
    fs.writeFileSync(file, 'x');
    const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, t, t);
}

const exists = (name) => fs.existsSync(path.join(uploadsDir, name));

test('removes only old files nobody references', () => {
    const manga = db.prepare("INSERT INTO mangas (title, cover_image) VALUES ('A', '/uploads/cover-used.jpg')").run();
    db.prepare("INSERT INTO volumes (manga_id, volume_number, images) VALUES (?, '1', ?)")
        .run(manga.lastInsertRowid, JSON.stringify(['/uploads/photo-used.jpg']));
    put('cover-used.jpg', 30);
    put('photo-used.jpg', 30);
    put('orphan-old.jpg', 30);
    put('orphan-new.jpg', 1);

    const dry = cleanOrphanUploads({ dryRun: true });
    assert.deepEqual(dry.files, ['orphan-old.jpg']);
    assert.ok(exists('orphan-old.jpg'), 'dry run must not delete');

    const real = cleanOrphanUploads();
    assert.equal(real.removed, 1);
    assert.ok(!exists('orphan-old.jpg'));
    for (const keep of ['cover-used.jpg', 'photo-used.jpg', 'orphan-new.jpg']) {
        assert.ok(exists(keep), keep + ' must stay');
    }
});

test('keeps files referenced in any form: JSON, markdown, HTML, absolute URLs, edition data, odd names', () => {
    const manga = db.prepare(`INSERT INTO mangas (title, cover_image, banner_image, description, manga_passion_edition_data)
        VALUES ('B', 'https://shelf.example/uploads/abs-cover.jpg?v=2', 'banner-bare.png', ?, ?)`).run(
        'Text ![](/uploads/md-image.jpg) und <img src="/uploads/html-image.webp"> sowie ein Leerzeichen: /uploads/mit leer zeichen.jpg',
        JSON.stringify({ cover: 'C:\\data\\uploads\\edition-local.jpg', esc: '\\/uploads\\/escaped.jpg' })
    );
    db.prepare("INSERT INTO volumes (manga_id, volume_number, cover_image, images, notes) VALUES (?, '2', ?, ?, ?)").run(
        manga.lastInsertRowid,
        '/uploads/1700000000000-123456789.jpg',
        JSON.stringify(['/uploads/gallery-a.jpg', '/uploads/gallery-b.jpg']),
        'Siehe [Foto](/uploads/note-photo.jpg) und /uploads/ümlaut-bild.jpg'
    );
    const referenced = ['abs-cover.jpg', 'banner-bare.png', 'md-image.jpg', 'html-image.webp', 'mit leer zeichen.jpg',
        'edition-local.jpg', 'escaped.jpg', '1700000000000-123456789.jpg', 'gallery-a.jpg', 'gallery-b.jpg',
        'note-photo.jpg', 'ümlaut-bild.jpg',
        // substring semantics: a name inside a longer referenced name still counts as used
        'cover.jpg'];
    for (const name of referenced) put(name, 30);
    put('really-orphaned.jpg', 30);
    put('fresh-orphan.jpg', 0);
    put('.hidden-old', 30);
    fs.mkdirSync(path.join(uploadsDir, 'subdir'), { recursive: true });
    put(path.join('subdir', 'nested-old.jpg'), 30);

    const result = cleanOrphanUploads();
    assert.deepEqual(result.files, ['really-orphaned.jpg']);
    for (const name of referenced) assert.ok(exists(name), name + ' must stay');
    assert.ok(exists('fresh-orphan.jpg'), 'files younger than the grace period stay');
    assert.ok(exists('.hidden-old'), 'dotfiles are skipped');
    assert.ok(exists(path.join('subdir', 'nested-old.jpg')), 'subdirectories are skipped');
});

test('many files and volumes are checked quickly', () => {
    const count = 20000;
    const manga = db.prepare("INSERT INTO mangas (title) VALUES ('Perf')").run();
    const insert = db.prepare("INSERT INTO volumes (manga_id, volume_number, cover_image, notes) VALUES (?, ?, ?, 'Notiz zum Band')");
    db.exec('BEGIN');
    for (let i = 0; i < count; i++) insert.run(manga.lastInsertRowid, String(i), `/uploads/perf-${i}.jpg`);
    db.exec('COMMIT');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < count; i++) {
        const file = path.join(uploadsDir, `perf-${i}.jpg`);
        fs.writeFileSync(file, 'x');
        fs.utimesSync(file, old, old);
    }
    put('perf-orphan.jpg', 30);

    const started = Date.now();
    const result = cleanOrphanUploads({ dryRun: true });
    const elapsed = Date.now() - started;
    assert.deepEqual(result.files, ['perf-orphan.jpg']);
    assert.ok(elapsed < 750, `cleanup took ${elapsed} ms`);
});

test('the token index finds exactly the orphans a plain substring scan finds', () => {
    let seed = 42;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const names = [];
    for (let i = 0; i < 400; i++) {
        const scheme = rand(4);
        if (scheme === 0) names.push(`${1700000000000 + i}-${rand(1e9)}.jpg`);
        else if (scheme === 1) names.push(`mp-cov-${rand(1e9).toString(16)}.webp`);
        else if (scheme === 2) names.push(`eq-${i}.png`);
        else names.push(`Umlaut ä ${i}.avif`);
    }
    const manga = db.prepare("INSERT INTO mangas (title) VALUES ('Vergleich')").run().lastInsertRowid;
    const insert = db.prepare('INSERT INTO volumes (manga_id, volume_number, cover_image, notes, images) VALUES (?, ?, ?, ?, ?)');
    names.forEach((name, i) => {
        const pick = rand(5);
        if (pick === 0) insert.run(manga, `v${i}`, `/uploads/${name}`, null, null);
        else if (pick === 1) insert.run(manga, `v${i}`, null, `Foto: (/uploads/${name})`, null);
        else if (pick === 2) insert.run(manga, `v${i}`, null, null, JSON.stringify([`/uploads/${name}`]));
        else if (pick === 3) insert.run(manga, `v${i}`, null, `erwähnt ${name.slice(0, -1)}`, null);
        put(name, 30);
    });

    const rows = [
        ...db.prepare('SELECT cover_image, banner_image, description, manga_passion_edition_data FROM mangas').all(),
        ...db.prepare('SELECT cover_image, images, notes FROM volumes').all()
    ];
    const text = rows.flatMap(r => Object.values(r)).filter(Boolean).map(String).join('\n');
    const naive = fs.readdirSync(uploadsDir, { withFileTypes: true })
        .filter(e => e.isFile() && !e.name.startsWith('.'))
        .map(e => e.name)
        .filter(name => !text.includes(name) && Date.now() - fs.statSync(path.join(uploadsDir, name)).mtimeMs >= 7 * 24 * 60 * 60 * 1000)
        .sort();
    const result = cleanOrphanUploads({ dryRun: true }).files.sort();
    assert.deepEqual(result, naive);
    assert.ok(result.some(n => names.includes(n)), 'some generated files are orphans');
    assert.ok(names.some(n => !result.includes(n)), 'some generated files are referenced');
});

test('many orphans do not fall back to one substring scan each', () => {
    const manga = db.prepare("INSERT INTO mangas (title) VALUES ('Viele Notizen')").run().lastInsertRowid;
    const insert = db.prepare('INSERT INTO volumes (manga_id, volume_number, notes) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 40000; i++) insert.run(manga, String(i), `Notiz ${i}: ${'gelesen, Zustand gut. '.repeat(5)}`);
    db.exec('COMMIT');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 2000; i++) {
        const file = path.join(uploadsDir, `${1600000000000 + i}-${i}.jpg`);
        fs.writeFileSync(file, 'x');
        fs.utimesSync(file, old, old);
    }
    const started = Date.now();
    const result = cleanOrphanUploads({ dryRun: true });
    const elapsed = Date.now() - started;
    assert.ok(result.removed >= 2000);
    assert.ok(elapsed < 750, `cleanup took ${elapsed} ms`);
});

test('files referenced by a retained undo snapshot stay; an unreadable undo snapshot stops the cleanup', () => {
    const { dataDir: dir, openRawDb } = require('../db');
    const AdmZip = require('adm-zip');
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    for (const f of fs.readdirSync(backups)) fs.rmSync(path.join(backups, f), { force: true });
    put('undo-listed.jpg', 30);
    put('undo-from-db.png', 30);
    put('undo-orphan.jpg', 30);

    const restoreName = 'vor-wiederherstellung-2026-09-01T10-00-00-000Z.zip';
    fs.writeFileSync(path.join(backups, restoreName), 'zip');
    fs.writeFileSync(path.join(backups, restoreName.replace(/\.zip$/, '.json')),
        JSON.stringify({ verified: true, referenced_uploads: ['undo-listed.jpg'] }));

    // an older pre-update snapshot (db.js writes no sidecar): the list is read from its database once and stored
    const oldDb = path.join(dir, 'temp', 'old-schema.db');
    const conn = openRawDb(oldDb);
    conn.exec("CREATE TABLE mangas (id INTEGER PRIMARY KEY, title TEXT, cover_image TEXT); CREATE TABLE volumes (id INTEGER PRIMARY KEY, notes TEXT)");
    conn.exec("INSERT INTO mangas (title, cover_image) VALUES ('Alt', '/uploads/undo-from-db.png')");
    conn.close();
    const zip = new AdmZip();
    zip.addLocalFile(oldDb, '', 'manga.db');
    fs.rmSync(oldDb);
    const updateName = 'vor-update-v3-auf-v4-2026-09-02T10-00-00-000Z.zip';
    zip.writeZip(path.join(backups, updateName));

    assert.deepEqual(cleanOrphanUploads({ dryRun: true }).files.filter(n => n.startsWith('undo-')), ['undo-orphan.jpg']);
    const stored = JSON.parse(fs.readFileSync(path.join(backups, updateName.replace(/\.zip$/, '.json')), 'utf8'));
    assert.deepEqual(stored, { referenced_uploads: ['undo-from-db.png'] });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'temp')).filter(f => f.startsWith('inspect-refs-')), []);

    const broken = 'vor-update-v4-auf-v5-2026-09-03T10-00-00-000Z.zip';
    fs.writeFileSync(path.join(backups, broken), 'kein zip');
    const skipped = cleanOrphanUploads();
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.removed, 0);
    assert.ok(exists('undo-orphan.jpg'));

    fs.rmSync(path.join(backups, broken));
    assert.ok(cleanOrphanUploads().files.includes('undo-orphan.jpg'));
    for (const keep of ['undo-listed.jpg', 'undo-from-db.png']) assert.ok(exists(keep), keep + ' must stay');
    for (const f of fs.readdirSync(backups)) fs.rmSync(path.join(backups, f), { force: true });
});
