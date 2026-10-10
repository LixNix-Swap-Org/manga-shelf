// Entry of `npm run test:electron`: runs the cases that need the real Electron runtime and exits with their result.
const fail = (err) => {
    process.stderr.write(`[electron-test] ${(err && err.stack) || err}\n`);
    require('electron').app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const { app } = require('electron');
const transportCases = require('./transport');

app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    let failed = 0;
    for (const { name, run } of transportCases()) {
        try {
            await run();
            process.stdout.write(`ok - ${name}\n`);
        } catch (err) {
            failed += 1;
            process.stdout.write(`not ok - ${name}: ${(err && err.stack) || err}\n`);
        }
    }
    process.stdout.write(failed ? `[electron-test] ${failed} fehlgeschlagen\n` : '[electron-test] alle Fälle bestanden\n');
    app.exit(failed ? 1 : 0);
});
