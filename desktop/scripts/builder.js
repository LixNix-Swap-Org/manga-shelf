#!/usr/bin/env node
// Runs electron-builder (arguments passed through). Without signing variables the build stays unsigned: otherwise
// electron-builder signs on macOS with any identity it finds in the keychain.
const path = require('path');
const { spawnSync } = require('child_process');

const SIGNING_VARIABLES = ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK', 'APPLE_ID', 'APPLE_API_KEY', 'APPLE_KEYCHAIN_PROFILE'];

/** Environment for electron-builder: CSC_IDENTITY_AUTO_DISCOVERY=false unless signing is configured or the variable is set. */
function builderEnv(env = process.env) {
    const signing = SIGNING_VARIABLES.some((name) => String(env[name] || '').trim() !== '');
    if (signing || env.CSC_IDENTITY_AUTO_DISCOVERY !== undefined) return { env: { ...env }, unsigned: false };
    return { env: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, unsigned: true };
}

function main(argv) {
    const { env, unsigned } = builderEnv();
    if (unsigned) console.log('Keine Signatur-Variablen (CSC_LINK, APPLE_ID, …): unsignierter Build.');
    const cli = require.resolve('electron-builder/cli.js', { paths: [path.resolve(__dirname, '..')] });
    const res = spawnSync(process.execPath, [cli, ...argv], { stdio: 'inherit', env });
    if (res.error) throw res.error;
    return res.status === null ? 1 : res.status;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}

module.exports = { builderEnv, SIGNING_VARIABLES };
