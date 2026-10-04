#!/usr/bin/env node
// Which installers can be signed: a group counts only when every one of its secrets is set (GitHub passes a missing
// secret as an empty string). Prints key=value lines and appends them to $GITHUB_OUTPUT in Actions; --notes prints
// the signing lines for the release text instead.
const fs = require('fs');

const GROUPS = {
    windows: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'],
    macos: ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD'],
    notarize: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    android: ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
    ios: ['IOS_CERT_P12_BASE64', 'IOS_CERT_PASSWORD', 'IOS_PROVISIONING_PROFILE_BASE64', 'APPLE_TEAM_ID']
};
// optional on top of the ios group: the share extension's profile (mobile/scripts/build-ios.js leaves the extension out without it)
const IOS_SHARE_SECRET = 'IOS_SHARE_PROVISIONING_PROFILE_BASE64';

function detectSigning(env = process.env) {
    const has = (names) => names.every((name) => typeof env[name] === 'string' && env[name].trim() !== '');
    const state = Object.fromEntries(Object.entries(GROUPS).map(([key, names]) => [key, has(names)]));
    state.notarize = state.notarize && state.macos;
    return state;
}

function notes(state, env = process.env) {
    const yes = (flag, text) => (flag ? text : 'unsigned');
    // only a step that passes the variable (empty when the secret is missing) knows about the extension
    const shareKnown = typeof env[IOS_SHARE_SECRET] === 'string';
    const iosSigned = !shareKnown ? 'signed' : env[IOS_SHARE_SECRET].trim() ? 'signed, with share extension (iOS)' : 'signed, without share extension (iOS)';
    return [
        '### Signing',
        `- Windows (installer, portable .exe, server .exe): ${yes(state.windows, 'signed')}`,
        `- macOS (.dmg/.zip, server binary): ${yes(state.macos, state.notarize ? 'signed and notarized' : 'signed, not notarized')}`,
        `- Android (APK/AAB): ${yes(state.android, 'signed')}${state.android ? '' : ' (APK with the debug key)'}`,
        `- iPhone (IPA): ${yes(state.ios, iosSigned)}`,
        '- Linux (AppImage, .deb, .rpm, server binaries): unsigned, checksums in SHA256SUMS.txt',
        '- Docker image: signed keyless with cosign (if that step succeeded)'
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

module.exports = { detectSigning, notes, GROUPS, IOS_SHARE_SECRET };
