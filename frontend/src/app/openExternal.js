// Opens a link outside the app: a new tab in the browser build; the shells replace it with the system browser
// (@capacitor/browser, Electron shell.openExternal) through setOpenExternal. `options.preferApp` asks the shell for the
// system opener, so a universal/app link can open the installed app (the Crunchyroll app for "Weiter").
let opener = (url) => {
  globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer');
};

export function setOpenExternal(next) {
  opener = typeof next === 'function' ? next : opener;
}

/** Only http(s) links leave the app. */
export function openExternal(url, options = {}) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  opener(parsed.href, options);
  return true;
}

/** onClick of an <a href target="_blank">: a modified click stays with the browser, a plain one goes through openExternal. */
export function openLinkOutside(e, options) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (openExternal(e.currentTarget.href, options)) e.preventDefault();
}
