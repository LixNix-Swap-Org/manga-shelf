// config.js parsing: flags, backup retention, bounded integers, time zones and APP_ORIGINS, with their startup warnings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-config-'));
const { readConfig } = require('../utils/config');
const scheduler = require('../services/scheduler');
const { zonedToday } = require('../services/radar');

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

test('flags: German and padded values validate without a warning and mean what the startup check says', () => {
    for (const [raw, expected] of [['nein', false], [' false', false], ['FALSE ', false], ['off', false], ['0', false], ['ja', true], [' yes ', true], ['1', true]]) {
        const { values, warnings } = readConfig({ ADMIN_CONSOLE: raw, COOKIE_SECURE: raw });
        assert.deepEqual([values.adminConsole, values.cookieSecure, warnings], [expected, expected, []], JSON.stringify(raw));
    }
    const odd = readConfig({ ADMIN_CONSOLE: 'vielleicht' });
    assert.equal(odd.values.adminConsole, true);
    assert.match(odd.warnings[0], /ADMIN_CONSOLE="vielleicht" ist unbekannt/);
});

test('backup retention: the scheduler keeps exactly what the startup warning announces', () => {
    const keepAll = /ist ungültig .* keine Snapshots dieser Art gelöscht$/;
    for (const [raw, expected, warning] of [['2000', 1000, /"2000" ist zu groß .* es gilt 1000$/], ['14d', Infinity, keepAll], ['30d', Infinity, keepAll], ['-1', Infinity, keepAll], ['abc', Infinity, keepAll], [' 12 ', 12], ['0', Infinity, keepAll], ['', 7]]) {
        const { values, warnings } = readConfig({ BACKUP_KEEP_DAILY: raw });
        assert.equal(values.backupKeepDaily, expected, raw);
        if (warning) assert.match(warnings[0], warning, raw);
        else assert.deepEqual(warnings, [], raw);
        withEnv({ BACKUP_KEEP_DAILY: raw }, () => assert.equal(scheduler.retentionFor('daily-auto'), expected, raw));
    }
    withEnv({ BACKUP_KEEP_PRE_UPDATE: '5x', BACKUP_KEEP_MANUAL: '1001', BACKUP_KEEP_PRE_RESTORE: '4' }, () => {
        assert.equal(scheduler.retentionFor('vor-update-v1-auf-v2'), Infinity, 'a malformed value never prunes to a smaller default');
        assert.equal(scheduler.retentionFor('manual'), 1000);
        assert.equal(scheduler.retentionFor('vor-wiederherstellung'), 4);
    });
});

test('bounded integers: a value above the cap is clamped to the cap with a warning, never replaced by the default', () => {
    const { values, warnings } = readConfig({ BACKUP_HOUR: '99', RESTORE_MAX_ENTRIES: '999999999', BACKUP_KEEP_PRE_RESTORE: '5000', BACKUP_KEEP_PRE_UPDATE: '1000' });
    assert.deepEqual(
        [values.backupHour, values.restoreMaxEntries, values.backupKeepPreRestore, values.backupKeepPreUpdate],
        [23, 10000000, 1000, 1000]
    );
    assert.deepEqual(warnings, [
        'BACKUP_HOUR="99" ist zu groß (erlaubt: 0 bis 23), es gilt 23',
        'BACKUP_KEEP_PRE_RESTORE="5000" ist zu groß (erlaubt: 1 bis 1000), es gilt 1000',
        'RESTORE_MAX_ENTRIES="999999999" ist zu groß (erlaubt: 1 bis 10000000), es gilt 10000000'
    ]);
    const huge = readConfig({ RESTORE_MAX_DB_BYTES: '9'.repeat(30) });
    assert.equal(huge.values.restoreMaxDbBytes, Number.MAX_SAFE_INTEGER);
    assert.match(huge.warnings[0], /ist zu groß/);
});

test('time zones: BACKUP_TIMEZONE and APP_TIMEZONE are read through config with the documented fallbacks', () => {
    withEnv({ BACKUP_TIMEZONE: ' Mars/Olympus ', BACKUP_HOUR: '25' }, () => {
        assert.deepEqual(scheduler.backupSchedule(), { hour: 23, timeZone: 'UTC' });
    });
    withEnv({ BACKUP_HOUR: '-1' }, () => assert.equal(scheduler.backupSchedule().hour, 3));
    withEnv({ BACKUP_TIMEZONE: ' America/New_York ', BACKUP_HOUR: ' 5 ' }, () => {
        assert.deepEqual(scheduler.backupSchedule(), { hour: 5, timeZone: 'America/New_York' });
    });
    const now = new Date('2026-10-03T23:30:00Z');
    withEnv({ APP_TIMEZONE: ' Asia/Tokyo ' }, () => assert.equal(zonedToday(now).getDate(), 4));
    withEnv({ APP_TIMEZONE: 'America/Los_Angeles' }, () => assert.equal(zonedToday(now).getDate(), 3));
});

test('APP_ORIGINS: default app origins, a replacing list, none, and invalid entries with a warning', () => {
    const { DEFAULT_APP_ORIGINS } = require('../utils/config');
    assert.deepEqual(readConfig({}).values.appOrigins, ['capacitor://localhost', 'https://localhost', 'ionic://localhost', 'app://manga-shelf']);
    assert.deepEqual(readConfig({}).values.appOrigins, DEFAULT_APP_ORIGINS);
    assert.deepEqual(readConfig({ APP_ORIGINS: ' NONE ' }).values.appOrigins, []);
    const custom = readConfig({ APP_ORIGINS: 'Capacitor://LocalHost/, https://shell.example, ,https://shell.example' });
    assert.deepEqual([custom.values.appOrigins, custom.warnings], [['capacitor://localhost', 'https://shell.example'], []]);
    const odd = readConfig({ APP_ORIGINS: 'capacitor://localhost, localhost, https://x.example/path' });
    assert.deepEqual(odd.values.appOrigins, ['capacitor://localhost']);
    assert.deepEqual(odd.warnings, ['APP_ORIGINS enthält ungültige Ursprünge (localhost, https://x.example/path; erwartet z. B. capacitor://localhost), sie werden ignoriert']);
});

test('UPDATE_INSTALL: on by default, a flag like UPDATE_CHECK, an unknown value keeps it on with a warning', () => {
    assert.equal(readConfig({}).values.updateInstall, true);
    assert.deepEqual([readConfig({ UPDATE_INSTALL: ' false ' }).values.updateInstall, readConfig({ UPDATE_INSTALL: 'nein' }).values.updateInstall], [false, false]);
    const odd = readConfig({ UPDATE_INSTALL: 'manchmal' });
    assert.equal(odd.values.updateInstall, true);
    assert.deepEqual(odd.warnings, ['UPDATE_INSTALL="manchmal" ist unbekannt (erlaubt: true oder false), es gilt true']);
    withEnv({ UPDATE_INSTALL: 'off' }, () => assert.equal(require('../utils/config').config.updateInstall, false));
});
