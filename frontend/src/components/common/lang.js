const JAPANESE_SCRIPT = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

/** `lang` for a title that contains Kana or Han, so screen readers switch to a Japanese voice. */
export function langFor(text) {
  return typeof text === 'string' && JAPANESE_SCRIPT.test(text) ? 'ja' : undefined;
}
