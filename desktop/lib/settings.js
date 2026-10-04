const path = require('path');
const { readJson, writeJson } = require('./jsonFile');
const { normalizeSettings } = require('../modes');

const SETTINGS_FILE = 'desktop-settings.json';

/** The app's own settings (mode, ports, tray, autostart) in the user data folder, never in DATA_DIR. */
function createSettings(userDataDir) {
    const file = path.join(userDataDir, SETTINGS_FILE);
    let current = normalizeSettings(readJson(file, {}));
    return {
        file,
        get: () => current,
        update(patch) {
            current = normalizeSettings({ ...current, ...patch });
            writeJson(file, current);
            return current;
        }
    };
}

module.exports = { createSettings, SETTINGS_FILE };
