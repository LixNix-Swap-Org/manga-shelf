/** "Band 14" / "Bd. 14" and "14" are the same regular volume (as POST /volumes stores it); other types keep their label. */
function canonicalVolumeNumber(num, type) {
    const s = String(num ?? '').trim();
    if (type !== 'volume') return s;
    const m = /^(?:band|bd\.?)\s*(\d+)$/i.exec(s);
    return m ? m[1] : s;
}

// SQL fragments on volumes.number_sort (migration 15, kept up to date by triggers): the numeric value of
// volume_number ("Band 12" = 12, "12.5" = 12.5), NULL for labels such as "Schuber 3" or "Starter 1".

/**
 * A regular volume that counts towards progress: type volume, whole number >= 1 ("12.5", volume 0, Schuber,
 * specials and unnumbered entries are extras). Never NULL, so NOT (...) works.
 */
const regularNumberedSql = (v = 'v') =>
    `(COALESCE(${v}.type, 'volume') = 'volume' AND ${v}.number_sort IS NOT NULL AND ${v}.number_sort >= 1 AND instr(${v}.volume_number, '.') = 0)`;

/**
 * Display order of a series' entries: numbered regular volumes and Special Editions by number, then unnumbered
 * Special Editions, Schuber and specials; id breaks ties.
 */
const volumeOrderSql = (v = 'v') => `
    CASE
        WHEN COALESCE(${v}.type, 'volume') IN ('volume', 'special_edition') AND ${v}.number_sort IS NOT NULL THEN 1
        WHEN COALESCE(${v}.type, 'volume') = 'special_edition' THEN 1.5
        WHEN COALESCE(${v}.type, 'volume') = 'special' THEN 3
        ELSE 2
    END ASC,
    COALESCE(${v}.number_sort, 999999) ASC,
    CASE
        WHEN COALESCE(${v}.type, 'volume') = 'volume' THEN 0
        WHEN COALESCE(${v}.type, 'volume') = 'special_edition' THEN 1
        ELSE 2
    END ASC,
    ${v}.volume_number ASC`;

module.exports = { canonicalVolumeNumber, regularNumberedSql, volumeOrderSql };
