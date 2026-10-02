// Entry type of a volume row: 'volume' | 'special_edition' | 'schuber' | 'special'.
// Mirrors inferVolumeType() in frontend/src/utils/volumeHelpers.js (kept in sync by test/volumeType.test.js).

/** Uses vol.type when set, otherwise derives it from keywords in volume_number / notes. */
function inferVolumeType(vol) {
    if (vol.type) return vol.type;
    const num = String(vol.volume_number).toLowerCase();
    const notes = (vol.notes || '').toLowerCase();
    if (num.includes('schuber')) return 'schuber';
    if (num.includes('special edition') || num.includes('limited edition') || num.includes('spezial edition')
        || notes.includes('special edition') || notes.includes('limited edition')) return 'special_edition';
    if (num.includes('special') || num.includes('extra') || num.includes('sonderband')) return 'special';
    return 'volume';
}

/** Trailing integer of a volume number: "5" -> 5, "Schuber 8" -> 8, "1-5" / "Special" -> null. */
function volumeNumberOf(vol) {
    const m = String(vol.volume_number || '').trim().match(/^(?:\D*?\s)?(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
}

module.exports = { inferVolumeType, volumeNumberOf };
