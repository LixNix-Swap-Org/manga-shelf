// Every table belongs to one layer (AGENTS.md "Tables and their layers"): shared by all accounts, of a shelf, of a person,
// or technical. A table that names an account decides what happens to its rows when the account is deleted. A new table
// has to be put into TABLE_LAYERS, and a new reference to users into ACCOUNT_REFERENCES, so nobody adds personal data
// without deciding where it lives and when it goes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../core/schema');

const TABLE_LAYERS = {
    shared: ['works', 'catalog_series', 'catalog_volumes', 'catalog_merge_log', 'publisher_aliases', 'animes', 'anime_links',
        'anime_airings', 'anime_work_links'],
    shelf: ['shelves', 'shelf_members', 'mangas', 'volumes', 'trash'],
    person: ['users', 'volume_copies', 'volume_reads', 'chapter_progress', 'anime_progress', 'anime_tags', 'anime_sync',
        'user_api_credentials', 'calendar_feeds', 'saved_filters'],
    technical: ['app_settings', 'schema_migrations', 'data_versions', 'api_cache', 'manga_passion_cache', 'sqlite_sequence',
        'sqlite_stat1', 'sqlite_stat4']
};

// "table.column": what a deleted account does to the row (CASCADE: the row goes; SET NULL: the row stays without a name)
const ACCOUNT_REFERENCES = {
    'shelves.owner_user_id': 'SET NULL',
    'shelf_members.user_id': 'CASCADE',
    'mangas.updated_by': 'SET NULL',
    'trash.deleted_by': 'SET NULL',
    'animes.updated_by': 'SET NULL',
    'anime_work_links.created_by': 'SET NULL',
    'volume_copies.owner_user_id': 'SET NULL',
    'volume_copies.lent_to_user_id': 'SET NULL',
    'volume_reads.user_id': 'CASCADE',
    'volumes.updated_by': 'SET NULL',
    'chapter_progress.user_id': 'CASCADE',
    'anime_progress.user_id': 'CASCADE',
    'anime_tags.user_id': 'CASCADE',
    'anime_sync.user_id': 'CASCADE',
    'user_api_credentials.user_id': 'CASCADE',
    'calendar_feeds.user_id': 'CASCADE',
    'saved_filters.user_id': 'CASCADE'
};

const fresh = () => {
    const conn = new DatabaseSync(':memory:');
    schema.applySchema(conn);
    return conn;
};

test('every table of a fresh database is in exactly one layer', () => {
    const conn = fresh();
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    const layerOf = new Map();
    for (const [layer, names] of Object.entries(TABLE_LAYERS)) {
        for (const name of names) {
            assert.ok(!layerOf.has(name), `${name} is in ${layerOf.get(name)} and ${layer}`);
            layerOf.set(name, layer);
        }
    }
    for (const name of tables) assert.ok(layerOf.has(name), `table ${name} has no layer: add it to TABLE_LAYERS (and AGENTS.md)`);
});

test('every reference to users is listed with what deleting the account does to the row', () => {
    const conn = fresh();
    const found = {};
    for (const { name } of conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        for (const fk of conn.prepare(`PRAGMA foreign_key_list(${name})`).all()) {
            if (fk.table === 'users') found[`${name}.${fk.from}`] = fk.on_delete;
        }
    }
    assert.deepEqual(found, ACCOUNT_REFERENCES);
    // a table of the person layer other than users itself goes with the account
    for (const name of TABLE_LAYERS.person.filter(n => n !== 'users' && n !== 'volume_copies')) {
        assert.ok(Object.entries(ACCOUNT_REFERENCES).some(([ref, action]) => ref.startsWith(`${name}.`) && action === 'CASCADE'), `${name} must go with its account`);
    }
});
