// core/ctx.js strictParams: ctx.db refuses an undefined bound parameter on every host (node:sqlite of Node 22 throws,
// Node 26 and sql.js would store NULL), positional or named; null, Buffers and the other statement calls pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createCtx, dbFromConnection } = require('../../core/ctx');

test('an undefined parameter is refused with its position or name; null and the rest pass', () => {
    const conn = new DatabaseSync(':memory:');
    conn.exec('CREATE TABLE t (a, b)');
    // a host whose driver would quietly bind undefined as NULL (Node 26, sql.js)
    const lenient = {
        ...dbFromConnection(conn),
        prepare: (sql) => {
            const stmt = conn.prepare(sql);
            const fix = (params) => params.map((p) => (p === undefined ? null : p));
            return { run: (...p) => stmt.run(...fix(p)), get: (...p) => stmt.get(...fix(p)), all: (...p) => stmt.all(...fix(p)), setReadBigInts: (on) => stmt.setReadBigInts(on) };
        }
    };
    for (const db of [dbFromConnection(conn), lenient]) {
        const ctx = createCtx({ db });
        assert.throws(() => ctx.db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(1, undefined), /SQL-Parameter 2 ist undefined: INSERT INTO t/);
        assert.throws(() => ctx.db.prepare('SELECT * FROM t WHERE a = $a').get({ a: undefined }), /SQL-Parameter a ist undefined/);
        assert.throws(() => ctx.db.prepare('SELECT * FROM t WHERE a = ?').all(undefined), /SQL-Parameter 1/);
        assert.equal(conn.prepare('SELECT count(*) AS n FROM t').get().n, 0, 'nothing was written');
        ctx.db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(null, Buffer.from('x'));
        assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM t WHERE a IS NULL').get().n, 1);
        // other calls reach the statement (setReadBigInts exists on node:sqlite since Node 22.5)
        const big = ctx.db.prepare('SELECT count(*) AS n FROM t');
        big.setReadBigInts(true);
        assert.equal(big.get().n, 1n);
        conn.exec('DELETE FROM t');
    }
    // wrapping twice changes nothing
    const ctx = createCtx({ db: dbFromConnection(conn) });
    assert.equal(createCtx({ db: ctx.db }).db.prepare, ctx.db.prepare);
});
