const { pathToFileURL } = require('url');

const QR_BORDER = 4;

/** QR code of `text` as { size, path } for an SVG, through the frontend's encoder (ES module, loaded on demand). */
async function qrSvgData(text, modulePath) {
    const { encodeQr, qrPath } = await import(pathToFileURL(modulePath).href);
    const modules = encodeQr(text);
    return { size: modules.length + QR_BORDER * 2, path: qrPath(modules, QR_BORDER) };
}

module.exports = { qrSvgData };
