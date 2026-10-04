// Finds an installed Chrome-family browser for the puppeteer suites.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAC_APPS = [
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Chromium.app/Contents/MacOS/Chromium',
    'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    'Brave Browser.app/Contents/MacOS/Brave Browser'
];

// every suite runs in German whatever the machine's language: the UI picks the device language on start
const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--lang=de-DE', '--accept-lang=de-DE'];

/** Browser paths in lookup order: CHROME_BIN / PUPPETEER_EXECUTABLE_PATH, then Linux, macOS (system and per user), Windows. */
function chromeCandidates(env = process.env, home = os.homedir()) {
    return [
        env.CHROME_BIN,
        env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
        ...MAC_APPS.map(app => path.join('/Applications', app)),
        ...(home ? MAC_APPS.map(app => path.join(home, 'Applications', app)) : []),
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);
}

/** Path of an installed Chrome / Chromium / Edge / Brave (CHROME_BIN or PUPPETEER_EXECUTABLE_PATH win), or throws. */
function findChrome({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
    const found = chromeCandidates(env, home).find(p => exists(p));
    if (!found) {
        throw new Error('No Chrome/Chromium/Edge found. Set CHROME_BIN to the browser executable ' +
            '(or install one with `npx @puppeteer/browsers install chrome@stable`).');
    }
    return found;
}

module.exports = { findChrome, chromeCandidates, CHROME_ARGS };
