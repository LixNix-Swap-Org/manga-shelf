#!/usr/bin/env node
// Which installers can be signed: a group counts only when every one of its secrets is set (GitHub passes a missing
// secret as an empty string). Prints key=value lines and appends them to $GITHUB_OUTPUT in Actions; --notes prints
// the German lines for the release text instead.
const fs = require('fs');

const GROUPS = {
    windows: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'],
    macos: ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD'],
    notarize: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    android: ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
    ios: ['IOS_CERT_P12_BASE64', 'IOS_CERT_PASSWORD', 'IOS_PROVISIONING_PROFILE_BASE64', 'APPLE_TEAM_ID']
};

function detectSigning(env = process.env) {
    const has = (names) => names.every((name) => typeof env[name] === 'string' && env[name].trim() !== '');
    const state = Object.fromEntries(Object.entries(GROUPS).map(([key, names]) => [key, has(names)]));
    state.notarize = state.notarize && state.macos;
    return state;
}

function notes(state) {
    const yes = (flag, text) => (flag ? text : 'unsigniert');
    return [
        '### Signierung',
        `- Windows (Installer, portable .exe, Server-.exe): ${yes(state.windows, 'signiert')}`,
        `- macOS (.dmg/.zip, Server-Binärdatei): ${yes(state.macos, state.notarize ? 'signiert und notarisiert' : 'signiert, nicht notarisiert')}`,
        `- Android (APK/AAB): ${yes(state.android, 'signiert')}${state.android ? '' : ' (APK mit Debug-Schlüssel)'}`,
        `- iPhone (IPA): ${yes(state.ios, 'signiert')}`,
        '- Linux (AppImage, .deb, .rpm, Server-Binärdateien): unsigniert, Prüfsummen in SHA256SUMS.txt',
        '- Docker-Image: keyless mit cosign signiert (sofern der Schritt gelang)'
    ].join('\n');
}

if (require.main === module) {
    const state = detectSigning();
    if (process.argv.includes('--notes')) {
        process.stdout.write(notes(state) + '\n');
    } else {
        const lines = Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
        process.stdout.write(lines);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
    }
}

module.exports = { detectSigning, notes, GROUPS };
