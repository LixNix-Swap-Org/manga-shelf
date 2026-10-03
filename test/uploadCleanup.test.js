const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-cleanup-'));
const { db, uploadsDir } = require('../db');
const { cleanOrphanUploads } = require('../services/uploadCleanup');

function put(name, ageDays) {
    const file = path.join(uploadsDir, name);
    fs.writeFileSync(file, 'x');
    const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, t, t);
}

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
    assert.ok(fs.existsSync(path.join(uploadsDir, 'orphan-old.jpg')), 'dry run must not delete');

    const real = cleanOrphanUploads();
    assert.equal(real.removed, 1);
    assert.ok(!fs.existsSync(path.join(uploadsDir, 'orphan-old.jpg')));
    for (const keep of ['cover-used.jpg', 'photo-used.jpg', 'orphan-new.jpg']) {
        assert.ok(fs.existsSync(path.join(uploadsDir, keep)), keep + ' must stay');
    }
});
