// Multer image uploads into uploadsDir, plus byte-level verification of what was stored (see verifyImageUploads).
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { uploadsDir, tempDir } = require('../db');
const { detectImageExt } = require('../core/lib/imageCheck');
const { stripImageMetadata } = require('../utils/imageMeta');

// Allowed image MIME types and extensions for secure uploads
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const { ALLOWED_IMAGE_EXTS } = require('../core/lib/imageCheck');

const INVALID_TYPE_MESSAGE = 'Ungültiger Dateityp. Es sind ausschließlich Bilddateien (JPG, PNG, WebP, GIF, AVIF) erlaubt.';
const SNIFF_BYTES = 64;

function invalidTypeError() {
    const err = new Error(INVALID_TYPE_MESSAGE);
    err.status = 400;
    return err;
}

const imageFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype) && ALLOWED_IMAGE_EXTS.has(ext)) {
        cb(null, true);
    } else {
        cb(invalidTypeError());
    }
};

async function sniffImageExt(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
        return detectImageExt(buf.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
}

function storedFiles(req) {
    if (req.file) return [req.file];
    if (Array.isArray(req.files)) return req.files;
    if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
    return [];
}

const uploadsRoot = path.resolve(uploadsDir);

/** Absolute path of a stored upload, or null when it is not inside uploadsDir (such a file is never read or moved). */
function storedUploadPath(file) {
    if (!file || typeof file.path !== 'string' || !file.path) return null;
    const filePath = path.resolve(uploadsRoot, file.path);
    if (!filePath.startsWith(uploadsRoot + path.sep)) return null;
    return filePath;
}

async function stripStoredMetadata(filePath, ext) {
    const original = await fs.promises.readFile(filePath);
    const stripped = stripImageMetadata(original, ext);
    if (stripped !== original) await fs.promises.writeFile(filePath, stripped);
}

const stripTempPath = (filePath) => path.join(path.dirname(filePath), `.strip-${crypto.randomUUID()}.tmp`);

/**
 * Removes the metadata of an image file already on disk (format taken from its content) by writing a temp file next
 * to it and renaming it over the original, keeping mode and mtime. Resolves to true when the file was rewritten.
 */
async function stripImageFile(filePath) {
    const original = await fs.promises.readFile(filePath);
    const stripped = stripImageMetadata(original, detectImageExt(original.subarray(0, SNIFF_BYTES)));
    if (stripped === original) return false;
    const stat = await fs.promises.stat(filePath);
    const tmp = stripTempPath(filePath);
    try {
        await fs.promises.writeFile(tmp, stripped, { mode: stat.mode & 0o777 });
        await fs.promises.utimes(tmp, stat.atime, stat.mtime);
        await fs.promises.rename(tmp, filePath);
    } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
    }
    return true;
}

/** Synchronous stripImageFile, for code paths that move files synchronously (restored uploads). */
function stripImageFileSync(filePath) {
    const original = fs.readFileSync(filePath);
    const stripped = stripImageMetadata(original, detectImageExt(original.subarray(0, SNIFF_BYTES)));
    if (stripped === original) return false;
    const stat = fs.statSync(filePath);
    const tmp = stripTempPath(filePath);
    try {
        fs.writeFileSync(tmp, stripped, { mode: stat.mode & 0o777 });
        fs.utimesSync(tmp, stat.atime, stat.mtime);
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* never written */ }
        throw err;
    }
    return true;
}

/**
 * Checks the stored bytes of every uploaded image (multer only sees the client MIME type): a non-image removes all
 * files and answers 400, a wrong extension is renamed, metadata (GPS) is stripped because /uploads is public.
 */
async function verifyImageUploads(req, res, next) {
    const files = storedFiles(req);
    const paths = files.map(f => storedUploadPath(f));
    const removeAll = () => Promise.all(paths.filter(Boolean).map(p => fs.promises.unlink(p).catch(() => {})));
    if (paths.some(p => !p)) {
        await removeAll();
        return next(invalidTypeError());
    }
    try {
        const detected = await Promise.all(paths.map(p => sniffImageExt(p).catch(() => null)));
        if (detected.some(ext => !ext)) {
            await removeAll();
            return next(invalidTypeError());
        }
        for (let i = 0; i < files.length; i++) {
            const source = paths[i];
            await stripStoredMetadata(source, detected[i]);
            const current = path.extname(source).toLowerCase();
            if ((current === '.jpeg' ? '.jpg' : current) === detected[i]) continue;
            const filename = path.basename(source, path.extname(source)) + detected[i];
            const target = path.join(path.dirname(source), filename);
            await fs.promises.rename(source, target);
            paths[i] = target;
            files[i].filename = filename;
            files[i].path = target;
        }
        next();
    } catch (err) {
        await removeAll();
        next(err);
    }
}

/** Runs a multer middleware and then verifyImageUploads, so routes keep a single `upload.single(...)` step. */
function withContentCheck(multerMiddleware) {
    return (req, res, next) => multerMiddleware(req, res, (err) => {
        if (err) return next(err);
        verifyImageUploads(req, res, next);
    });
}

// Multer for image uploads (stored in data/uploads)
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const cleanExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg';
        cb(null, crypto.randomUUID() + cleanExt);
    }
});

const imageMulter = multer({
    storage: imageStorage,
    limits: { fileSize: 15 * 1024 * 1024 }, // Max 15 MB per image
    fileFilter: imageFileFilter
});

const upload = {
    single: (field) => withContentCheck(imageMulter.single(field)),
    array: (field, maxCount) => withContentCheck(imageMulter.array(field, maxCount)),
    fields: (spec) => withContentCheck(imageMulter.fields(spec))
};

// Multer for backup archive upload with disk storage in data/temp/ to prevent OOM
const backupStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        cb(null, `restore-${crypto.randomUUID()}.zip`);
    }
});

const uploadBackup = multer({
    storage: backupStorage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500 MB max backup archive size
});

module.exports = {
    upload,
    uploadBackup,
    verifyImageUploads,
    stripImageFile,
    stripImageFileSync,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_IMAGE_EXTS
};
