// A sql.js Database (SQLite as wasm, browser and Electron tests) behind the connection shape of node:sqlite that
// core/schema.js and core/ctx.js dbFromConnection expect: prepare(sql) -> { get, all, run }, exec(sql), close().
// sql.js statements are freed by hand and all of them die on export(), so every call prepares its own statement; the
// one exception is the last_insert_rowid() query of run(), which export() and close() drop.
const { dbFromConnection } = require('../ctx');

// node:sqlite rejects undefined and booleans as bind values; sql.js would silently accept them, so mirror it.
function bindable(value) {
    if (value === undefined) throw new TypeError('Provided value cannot be bound to SQLite parameter');
    if (typeof value === 'boolean') throw new TypeError('Provided value cannot be bound to SQLite parameter');
    return value;
}

function connectionFromSqlJs(database) {
    const withStatement = (sql, params, use) => {
        const stmt = database.prepare(sql);
        try {
            if (params.length) stmt.bind(params.map(bindable));
            return use(stmt);
        } finally {
            stmt.free();
        }
    };
    // compiling this query on every run() cost about as much as the write itself
    let rowidStmt = null;
    const readRowid = () => {
        if (!rowidStmt) rowidStmt = database.prepare('SELECT last_insert_rowid()');
        try {
            return rowidStmt.step() ? rowidStmt.get()[0] : 0;
        } finally {
            rowidStmt.reset();
        }
    };
    const lastInsertRowid = () => {
        try {
            return readRowid();
        } catch (e) {
            // a database.export() past this adapter freed the statement: prepare it once more
            rowidStmt = null;
            return readRowid();
        }
    };
    const dropRowidStmt = () => {
        if (!rowidStmt) return;
        try { rowidStmt.free(); } catch (e) { /* freed with the database */ }
        rowidStmt = null;
    };
    const conn = {
        prepare(sql) {
            return {
                get: (...params) => withStatement(sql, params, (stmt) => (stmt.step() ? stmt.getAsObject() : undefined)),
                all: (...params) => withStatement(sql, params, (stmt) => {
                    const rows = [];
                    while (stmt.step()) rows.push(stmt.getAsObject());
                    return rows;
                }),
                run: (...params) => withStatement(sql, params, (stmt) => {
                    while (stmt.step()) { /* drain RETURNING rows */ }
                    return { changes: database.getRowsModified(), lastInsertRowid: lastInsertRowid() };
                })
            };
        },
        exec(sql) {
            database.exec(sql);
        },
        /** The database file as bytes; export() resets the connection's pragmas, so foreign keys are switched on again. */
        export() {
            dropRowidStmt();
            const bytes = database.export();
            database.exec('PRAGMA foreign_keys = ON;');
            return bytes;
        },
        close() {
            dropRowidStmt();
            database.close();
        }
    };
    database.exec('PRAGMA foreign_keys = ON;');
    return conn;
}

/** ctx.db on a sql.js Database (plus the connection for applySchema and export). */
function sqlJsDb(database, options) {
    const conn = connectionFromSqlJs(database);
    return { conn, db: dbFromConnection(conn, options) };
}

module.exports = { connectionFromSqlJs, sqlJsDb };
