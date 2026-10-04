// Frontend search helper (matching and ranking), loaded as ESM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'search.js')).href);

const series = [
    { title: 'One-Punch Man', author: 'ONE' },
    { title: "Hell's Paradise: Jigokuraku", author: 'Yuji Kaku' },
    { title: 'Pokémon – Die ersten Abenteuer', author: 'Hidenori Kusaka' },
    { title: 'Shōgun', author: 'James Clavell' },
    { title: 'SPY×FAMILY', author: 'Tatsuya Endo' },
    { title: 'Dr. Stone', author: 'Riichiro Inagaki' },
    { title: 'Jujutsu Kaisen', author: 'Gege Akutami' },
    { title: 'Frieren – Nach dem Ende der Reise', author: 'Kanehito Yamada' },
    { title: 'Kaijū No. 8', author: 'Naoya Matsumoto' },
    { title: 'Gregs Tagebücher', author: 'Jeff Kinney' },
    { title: 'Éclair', author: 'Anthologie' },
    { title: 'Großstadtliebe', author: 'Unbekannt' }
];

test('foldText: case, accents, ß, apostrophes, dots and punctuation', async () => {
    const { foldText } = await load();
    assert.equal(foldText("Hell's Paradise: Jigokuraku"), 'hells paradise jigokuraku');
    assert.equal(foldText('Pokémon'), 'pokemon');
    assert.equal(foldText('Großstadt'), 'grossstadt');
    assert.equal(foldText('Dr. Stone'), 'dr stone');
    assert.equal(foldText('SPY×FAMILY'), 'spy x family');
    assert.equal(foldText('One-Punch  Man!'), 'one punch man');
    assert.equal(foldText('Ｆｕｌｌｗｉｄｔｈ'), 'fullwidth');
    assert.equal(foldText('Œuvre'), 'oeuvre');
    assert.equal(foldText(null), '');
});

test('foldText keeps a dot between digits and turns a decimal comma into one', async () => {
    const { foldText } = await load();
    assert.equal(foldText('Vol. 1.5'), 'vol 1.5');
    assert.equal(foldText('Band 1,5'), 'band 1.5');
    assert.equal(foldText('Band 12.'), 'band 12');
    assert.equal(foldText('Nr.8'), 'nr8');
});

test('real queries that plain includes() missed all find their series', async () => {
    const { createSearch } = await load();
    const search = createSearch(s => ({ primary: [s.title], secondary: [s.author] }));
    const found = (q) => search.filter(series, q).map(s => s.title);
    const cases = {
        'one punch': 'One-Punch Man',
        onepunch: 'One-Punch Man',
        'hells paradise': "Hell's Paradise: Jigokuraku",
        pokemon: 'Pokémon – Die ersten Abenteuer',
        shogun: 'Shōgun',
        'spy family': 'SPY×FAMILY',
        'spy x family': 'SPY×FAMILY',
        'dr stone': 'Dr. Stone',
        'jujutsu kaisn': 'Jujutsu Kaisen',
        'yamada frieren': 'Frieren – Nach dem Ende der Reise',
        kaiju: 'Kaijū No. 8',
        tagebucher: 'Gregs Tagebücher',
        tagebuecher: 'Gregs Tagebücher',
        'Tagebücher': 'Gregs Tagebücher',
        eclair: 'Éclair',
        grossstadt: 'Großstadtliebe',
        'großstadt': 'Großstadtliebe'
    };
    for (const [q, title] of Object.entries(cases)) assert.deepEqual(found(q), [title], q);
    assert.equal(found('').length, series.length);
    assert.deepEqual(found('zzzz'), []);
});

test('typos: one edit for tokens of five or more letters, never for short tokens or numbers', async () => {
    const { createSearch } = await load();
    const search = createSearch(s => ({ primary: [s.title] }));
    const list = [{ title: 'Berserk' }, { title: 'Naruto' }, { title: 'Band 12345' }];
    const found = (q) => search.filter(list, q).map(s => s.title);
    assert.deepEqual(found('berserc'), ['Berserk']);
    assert.deepEqual(found('bresrek'), []);
    assert.deepEqual(found('bersekr'), ['Berserk'], 'transposition');
    assert.deepEqual(found('narto'), ['Naruto'], 'deletion');
    assert.deepEqual(found('nrau'), [], 'short tokens stay exact');
    assert.deepEqual(found('12346'), [], 'numbers stay exact');
    assert.deepEqual(found('berzer'), ['Berserk'], 'a typo while still typing');
});

test('a run of digits (ISBN with hyphens) must stay together', async () => {
    const { createSearch } = await load();
    const search = createSearch(v => ({ secondary: [v.isbn] }));
    const list = [{ isbn: '978-3-551-00000-1' }, { isbn: '9783123551000' }];
    assert.deepEqual(search.filter(list, '978-3-551').map(v => v.isbn), ['978-3-551-00000-1']);
    assert.deepEqual(search.filter(list, '9783551').map(v => v.isbn), ['978-3-551-00000-1']);
    assert.equal(search.filter(list, '3551').length, 2, 'a fragment of 4+ digits');
    assert.equal(search.filter(list, '978').length, 0, 'short numbers never match inside an ISBN');
});

test('codes: ISBNs match only a digit query of 4+ characters, never a word or a short number', async () => {
    const { createSearch } = await load();
    const search = createSearch(v => ({ primary: [v.title], codes: [v.isbn] }));
    const list = [{ title: 'Band 1', isbn: '978-3-551-75421-3' }, { title: 'Band 5', isbn: '3-551-75421-X' }];
    const found = (q) => search.filter(list, q).map(v => v.title);
    assert.deepEqual(found('9783551754213'), ['Band 1']);
    assert.deepEqual(found('355175421x'), ['Band 5']);
    assert.deepEqual(found('75421'), ['Band 1', 'Band 5']);
    assert.deepEqual(found('band 3'), []);
    assert.deepEqual(found('band 7'), []);
    assert.deepEqual(found('551'), []);
});

test('number tokens match whole numbers only: Band 2 is not Band 12, 20 or 1.5', async () => {
    const { createSearch } = await load();
    const search = createSearch(v => ({ primary: [v.title, v.number], secondary: [v.notes] }));
    const list = ['1', '1.5', '2', '12', '15', '20', '150'].map(n => ({ title: `Band ${n}`, number: n }));
    const found = (q) => search.filter(list, q).map(v => v.number);
    assert.deepEqual(found('Band 2'), ['2']);
    assert.deepEqual(found('2'), ['2']);
    assert.deepEqual(found('band 1.5'), ['1.5']);
    assert.deepEqual(found('Band 1,5'), ['1.5']);
    assert.deepEqual(found('15'), ['15']);
    assert.deepEqual(found('band 02'), ['2'], 'leading zeros');
    assert.equal(search.rank({ title: 'Band 20', number: '20', notes: 'wie Band 2' }, 'band 2'), 2, 'a note hit is not a title prefix');
    assert.equal(search.rank({ title: 'Band 2', number: '2' }, 'band 2'), 0);
    const kaiju = createSearch(s => ({ primary: [s.title] }));
    assert.equal(kaiju.matches({ title: 'Kaijū No. 8' }, 'kaiju 8'), true);
    assert.equal(kaiju.matches({ title: 'Kaijū No. 8' }, 'kaiju 80'), false);
});

test('ISBN-shaped secondary values are codes too (series list volume_search)', async () => {
    const { createSearch } = await load();
    const search = createSearch(m => ({ primary: [m.title], secondary: m.volume_search.split('\n') }));
    const naruto = { title: 'Naruto', volume_search: '978-3-551-75421-3\nErstauflage 2019' };
    assert.equal(search.matches(naruto, 'naruto 3'), false);
    assert.equal(search.matches(naruto, 'naruto 551'), false);
    assert.equal(search.matches(naruto, '978-3-551'), true);
    assert.equal(search.matches(naruto, 'naruto 2019'), true, 'numbers in notes are words');
});

test('long or pasted queries are bounded: 200 characters, 12 distinct tokens, short fuzzy tokens', async () => {
    const { prepareQuery, createSearch } = await load();
    const q = prepareQuery('frierne '.repeat(1250));
    assert.deepEqual(q.tokens, ['frierne']);
    assert.ok(q.folded.length <= 200);
    const many = prepareQuery(Array.from({ length: 40 }, (_, i) => `wort${String.fromCharCode(97 + (i % 26))}${i}`).join(' '));
    assert.equal(many.tokens.length, 12);
    const search = createSearch(s => ({ primary: [s.title] }));
    const long = 'a'.repeat(30);
    assert.equal(search.matches({ title: long }, `${long.slice(0, 29)}b`), false, 'no typo tolerance above 24 letters');
    assert.equal(search.matches({ title: 'Frieren' }, 'frierne'), true);
});

test('a 10 kB pasted query filters 1,500 items in under 50 ms', async () => {
    const { createSearch } = await load();
    const words = ['frieren', 'berserk', 'vagabond', 'monster', 'pluto', 'akira', 'naruto', 'bleach', 'gintama', 'mushishi'];
    const items = Array.from({ length: 1500 }, (_, i) => ({
        title: `${words[i % 10]} ${words[(i * 7) % 10]} Edition ${i}`,
        author: `Autorin ${words[(i * 3) % 10]}`,
        notes: `Notiz ${'x'.repeat(i % 40)} ${words[(i * 11) % 10]}raum`
    }));
    const search = createSearch(s => ({ primary: [s.title], secondary: [s.author, s.notes] }));
    search.filter(items, 'warm');
    const distinct = Array.from({ length: 1250 }, (_, i) => `frierne${String.fromCharCode(97 + (i % 26))}`).join(' ');
    for (const query of ['frierne '.repeat(1250), distinct, 'q'.repeat(10000)]) {
        assert.ok(query.length >= 10000);
        const started = performance.now();
        search.filter(items, query);
        const ms = performance.now() - started;
        assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
    }
});

test('tokens never match across two fields in the no-space form', async () => {
    const { createSearch } = await load();
    const search = createSearch(s => ({ primary: [s.title], secondary: [s.author] }));
    assert.equal(search.matches({ title: 'Ab', author: 'Cd' }, 'bc'), false);
    assert.equal(search.matches({ title: 'Ab Cd', author: '' }, 'bc'), true);
});

test('rankMatch: title prefix, then title words, then other fields, then typos', async () => {
    const { createSearch } = await load();
    const search = createSearch(s => ({ primary: [s.title], secondary: [s.author] }));
    assert.equal(search.rank({ title: 'One Piece', author: 'Oda' }, 'one'), 0);
    assert.equal(search.rank({ title: 'One-Punch Man', author: '' }, 'onepu'), 0);
    assert.equal(search.rank({ title: 'Der eine Ring', author: '' }, 'ring eine'), 1);
    assert.equal(search.rank({ title: 'Akira', author: 'Otomo' }, 'otomo'), 2);
    assert.equal(search.rank({ title: 'Berserk', author: '' }, 'berserc'), 3);
    assert.equal(search.rank({ title: 'Berserk', author: '' }, 'naruto'), null);
});

test('createSearch caches the index per item object and rebuilds for a new object', async () => {
    const { createSearch } = await load();
    let builds = 0;
    const search = createSearch(s => { builds++; return { primary: [s.title] }; });
    const list = [{ title: 'Akira' }, { title: 'Berserk' }];
    search.filter(list, 'aki');
    search.filter(list, 'ber');
    search.filter(list, 'berserk');
    assert.equal(builds, 2);
    search.filter([{ title: 'Akira' }], 'aki');
    assert.equal(builds, 3);
});

test('compareNatural: German, numeric, case and accents ignored', async () => {
    const { compareNatural } = await load();
    assert.deepEqual(['Band 10', 'band 2', 'Band 1'].sort(compareNatural), ['Band 1', 'band 2', 'Band 10']);
    assert.deepEqual(['Zeta', 'Äther', 'Alpha'].sort(compareNatural), ['Alpha', 'Äther', 'Zeta']);
    assert.equal(compareNatural(null, ''), 0);
});
