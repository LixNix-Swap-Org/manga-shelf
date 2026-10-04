// Image uploads from the browser (multer, data/uploads); server-only. In the apps the files go to ctx.files directly.
const express = require('express');
const router = express.Router();
const { requireEditor } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { badRequest } = require('../utils/httpError');

router.post('/upload', requireEditor, upload.single('image'), (req, res) => {
    if (!req.file) throw badRequest('Keine Datei hochgeladen');
    res.json({ url: '/uploads/' + req.file.filename });
});

router.post('/upload/multiple', requireEditor, upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) throw badRequest('Keine Dateien hochgeladen');
    const urls = req.files.map(f => '/uploads/' + f.filename);
    res.json({ urls });
});

module.exports = router;
