const test = require('node:test');
const assert = require('node:assert/strict');
const { GUIDES, formatError, guideLines, fillTemplate, userProviders, instanceProviders, guidesHandler } = require('../../core/sources/guides');

const EXAMPLES = {
    anilist: `eyJ0eXAiOiJKV1QifQ.${'a'.repeat(80)}.${'b'.repeat(30)}`,
    mal: '0123456789abcdef0123456789abcdef',
    google_books: 'AIzaSyA-1234567890abcdefghijklmnopqrstu'
};

test('guides: every provider has numbered steps with text, every link is https', () => {
    assert.deepEqual(GUIDES.map((g) => g.id), ['anilist', 'mal', 'google_books']);
    for (const guide of GUIDES) {
        assert.ok(guide.steps.length >= 3, guide.id);
        for (const step of guide.steps) {
            assert.equal(typeof step.text, 'string');
            assert.ok(step.text.length > 10, `${guide.id}: ${step.text}`);
            if (step.link) assert.match(step.link, /^https:\/\//);
            if (step.linkTemplate) assert.match(step.linkTemplate, /^https:\/\//);
        }
        for (const field of ['name', 'benefit', 'secretLabel', 'secretHint', 'check', 'validity', 'formatError']) assert.ok(guide[field], `${guide.id}.${field}`);
    }
    assert.deepEqual(userProviders(), ['anilist', 'mal']);
    assert.deepEqual(instanceProviders(), ['mal', 'google_books']);
});

test('guides: the format check refuses empty and short values and accepts an example', () => {
    for (const guide of GUIDES) {
        assert.match(formatError(guide.id, ''), /Bitte .* eingeben/);
        assert.equal(formatError(guide.id, 'abc'), guide.formatError);
        assert.equal(formatError(guide.id, EXAMPLES[guide.id]), null, guide.id);
        assert.equal(formatError(guide.id, `  ${EXAMPLES[guide.id]}\n`), null, `${guide.id} trimmed`);
    }
    assert.equal(formatError('kitsu', 'x'), 'Unbekannter Anbieter');
});

test('guides: the AniList sign-in link only exists with a numeric client id; JSON keeps everything', () => {
    const step = GUIDES[0].steps.find((s) => s.linkTemplate);
    assert.equal(fillTemplate(step.linkTemplate, { client_id: ' 123 ' }, GUIDES[0].steps), 'https://anilist.co/api/v2/oauth/authorize?client_id=123&response_type=token');
    assert.equal(fillTemplate(step.linkTemplate, { client_id: 'abc' }, GUIDES[0].steps), null);
    assert.equal(fillTemplate(step.linkTemplate, {}, GUIDES[0].steps), null);
    assert.ok(guideLines('anilist').some((l) => l.includes('Anmeldelink entsteht aus der Client-ID')));
    const body = JSON.parse(JSON.stringify(guidesHandler().body));
    assert.deepEqual(body, GUIDES, 'plain data: the frontend gets the same objects');
});
