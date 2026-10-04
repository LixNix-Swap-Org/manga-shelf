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
    assert.equal(search.filter(list, '978').length, 2);
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
