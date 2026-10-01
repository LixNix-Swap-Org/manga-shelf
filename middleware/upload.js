const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadsDir, tempDir } = require('../db');

// Allowed image MIME types and extensions for secure uploads
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

const imageFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype) && ALLOWED_IMAGE_EXTS.has(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Ungültiger Dateityp. Es sind ausschließlich Bilddateien (JPG, PNG, WebP, GIF, AVIF) erlaubt.'));
    }
};

// Multer for image uploads (stored in data/uploads)
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const cleanExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + cleanExt);
    }
});

const upload = multer({ 
    storage: imageStorage,
    limits: { fileSize: 15 * 1024 * 1024 }, // Max 15 MB per image
    fileFilter: imageFileFilter
});

// Multer for backup archive upload with disk storage in data/temp/ to prevent OOM
const backupStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `restore-${uniqueSuffix}.zip`);
    }
});

const uploadBackup = multer({
    storage: backupStorage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500 MB max backup archive size
});

module.exports = {
    upload,
    uploadBackup,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_IMAGE_EXTS
};
