const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => { mod = await import('../frontend/src/utils/imageResize.js'); });

const KB = 1024;
const photo = (size, { type = 'image/jpeg', name = 'IMG_0001.JPG' } = {}) => new File([new Uint8Array(size)], name, { type, lastModified: 42 });

/** createImageBitmap and canvas stubs: records draws, encodes to `encodedSize` bytes. */
function stubs({ width = 4032, height = 3024, encodedSize = 200 * KB, decodeError = null } = {}) {
  const calls = { decode: [], canvas: [], draws: [], encode: [], closed: 0 };
  const createImageBitmap = async (file, opts) => {
    calls.decode.push(opts);
    if (decodeError) throw decodeError;
    return { width, height, close: () => { calls.closed++; } };
  };
  const createCanvas = (w, h) => {
    calls.canvas.push([w, h]);
    return {
      width: w,
      height: h,
      getContext: () => ({ fillRect: () => {}, drawImage: (_b, x, y, dw, dh) => calls.draws.push([dw, dh]) }),
      toBlob: (cb, type, quality) => { calls.encode.push([type, quality]); cb(new Blob([new Uint8Array(encodedSize)], { type })); }
    };
  };
  return { calls, opts: { createImageBitmap, createCanvas } };
}

test('fitWithin: longer edge capped, never upscaled', () => {
  assert.deepEqual(mod.fitWithin(4032, 3024, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(mod.fitWithin(3024, 4032, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(mod.fitWithin(800, 600, 1600), { width: 800, height: 600 });
});

test('a large phone photo is downscaled, re-encoded as JPEG and renamed', async () => {
  const { calls, opts } = stubs();
  const out = await mod.prepareImageForUpload(photo(4 * KB * KB), opts);
  assert.equal(out.type, 'image/jpeg');
  assert.equal(out.name, 'IMG_0001.jpg');
  assert.equal(out.size, 200 * KB);
  assert.deepEqual(calls.decode, [{ imageOrientation: 'from-image' }]);
  assert.deepEqual(calls.draws, [[1600, 1200]]);
  assert.deepEqual(calls.encode, [['image/jpeg', 0.84]]);
  assert.equal(calls.closed, 1);

  const png = await mod.prepareImageForUpload(photo(2 * KB * KB, { type: 'image/png', name: 'cover.png' }), opts);
  assert.equal(png.name, 'cover.jpg');
});

test('skips GIF, other types, small files and undecodable files; keeps the original when not smaller', async () => {
  const { calls, opts } = stubs();
  for (const file of [
    photo(2 * KB * KB, { type: 'image/gif', name: 'a.gif' }),
    photo(2 * KB * KB, { type: 'image/heic', name: 'a.heic' }),
    photo(400 * KB)
  ]) {
    assert.equal(await mod.prepareImageForUpload(file, opts), file);
  }
  assert.equal(calls.decode.length, 0);

  const broken = photo(2 * KB * KB);
  assert.equal(await mod.prepareImageForUpload(broken, stubs({ decodeError: new Error('decode') }).opts), broken);

  const optimised = photo(600 * KB);
  assert.equal(await mod.prepareImageForUpload(optimised, stubs({ encodedSize: 700 * KB }).opts), optimised);

  const noDecoder = photo(2 * KB * KB);
  assert.equal(await mod.prepareImageForUpload(noDecoder, { createImageBitmap: null }), noDecoder);
});

test('prepareImagesForUpload handles several files in order', async () => {
  const { opts } = stubs();
  const small = photo(10 * KB, { name: 'small.jpg' });
  const out = await mod.prepareImagesForUpload([photo(3 * KB * KB, { name: 'big.jpeg' }), small], opts);
  assert.deepEqual(out.map((f) => f.name), ['big.jpg', 'small.jpg']);
  assert.equal(out[1], small);
});
