const fs = require('fs');

/** Path of an installed Chrome / Chromium / Edge (CHROME_BIN or PUPPETEER_EXECUTABLE_PATH win), or throws. */
function findChrome() {
    const candidates = [
        process.env.CHROME_BIN,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error('No Chrome/Chromium/Edge found. Set CHROME_BIN to the browser executable.');
    return found;
}

module.exports = { findChrome };
