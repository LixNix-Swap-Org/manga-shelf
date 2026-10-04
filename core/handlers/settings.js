// Collection settings (PUT /stats/settings, admins): the start date of the collection.
const { badRequest } = require('../errors');
const { parseStartDate } = require('./stats');

function updateSettings(ctx, { body }) {
    const dateVal = body.collection_start_date ?? body.start_date;
    if (dateVal === undefined || dateVal === null) {
        throw badRequest('Kein Startdatum angegeben');
    }
    const dateStr = typeof dateVal === 'string' ? dateVal.trim() : '';
    if (!parseStartDate(dateStr)) {
        throw badRequest('Ungültiges Datum (erwartet: YYYY-MM-DD ab 1900)');
    }
    // One day of slack: the server cannot know the admin's timezone, "today" in Germany can still be yesterday in UTC.
    if (dateStr > new Date(ctx.now().getTime() + 86400000).toISOString().slice(0, 10)) {
        throw badRequest('Das Startdatum darf nicht in der Zukunft liegen');
    }
    ctx.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', ?)").run(dateStr);
    return { body: { success: true } };
}

module.exports = { updateSettings };
