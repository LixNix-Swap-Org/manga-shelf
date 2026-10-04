// Opens a link outside the app: a new tab in the browser build; the shells replace it with the system browser
// (@capacitor/browser, Electron shell.openExternal) through setOpenExternal.
let opener = (url) => {
  globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer');
};

export function setOpenExternal(next) {
  opener = typeof next === 'function' ? next : opener;
}

/** Only http(s) links leave the app. */
export function openExternal(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  opener(parsed.href);
  return true;
}
