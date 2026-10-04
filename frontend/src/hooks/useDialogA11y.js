import { useEffect, useLayoutEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

const canTakeFocus = (el) => Boolean(el) && el !== document.body && el.isConnected && typeof el.focus === 'function';

// History entries of open dialogs: the Android back gesture (and the browser's Back) closes the top dialog instead of
// leaving the page or the installed app. Each open dialog adds its token to a copy of the current history state (the
// router's key and index stay), so Back lands on an entry without that token.
export const HISTORY_STATE_KEY = 'mangashelfDialogs';
const KEPT_OPEN_CHECK_MS = 120;
const OWN_BACK_TIMEOUT_MS = 1000;
const openDialogs = [];
// history.state survives a reload: tokens carry a per-load id, so an entry left by the previous page never matches
const PAGE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let nextToken = 1;
let ownBacks = 0;
let ownBackTimer = null;
let listening = false;

const dialogTokens = (state) => (Array.isArray(state?.[HISTORY_STATE_KEY]) ? state[HISTORY_STATE_KEY] : []);

/**
 * True while the current history entry belongs to a dialog. A navigation right after closing a dialog (open the chosen
 * series) then replaces that entry, else it would stay below the new page as a dead same-URL entry.
 */
export const dialogEntryOnTop = () => typeof window !== 'undefined' && dialogTokens(window.history?.state).length > 0;

function pushDialogEntry(token) {
  const state = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  window.history.pushState({ ...state, [HISTORY_STATE_KEY]: [...dialogTokens(state), token] }, '');
}

function onPopState(event) {
  if (ownBacks > 0) {
    ownBacks--;
    return;
  }
  const remaining = new Set(dialogTokens(event.state));
  for (const dialog of [...openDialogs].reverse()) {
    if (!remaining.has(dialog.token)) dialog.onBack();
  }
}

/** Removes the entry of a dialog the app closed itself, unless a navigation already put another entry on top. */
function dropDialogEntry(token) {
  const tokens = dialogTokens(window.history.state);
  if (tokens[tokens.length - 1] !== token) return;
  ownBacks++;
  clearTimeout(ownBackTimer);
  ownBackTimer = setTimeout(() => { ownBacks = 0; }, OWN_BACK_TIMEOUT_MS);
  window.history.back();
}

/** The dialog's own close path: its Escape handling (which may refuse while busy or ask about unsaved input). */
function pressEscape(node) {
  node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

/**
 * Keyboard/screen-reader basics for a modal: puts focus inside when it opens (a `[data-autofocus]` element, else an
 * autoFocus field, else the first control or the dialog itself), keeps Tab inside, and gives focus back to the element
 * that opened it. `returnFocusRef` is the fallback when that element is gone by the time the dialog closes (e.g. a
 * menu item whose menu closed). Attach the returned ref to the dialog's outer element (with role="dialog").
 * While open the dialog also owns a history entry: Back closes it through `onClose`, or without one through the
 * dialog's Escape handling; a dialog that stays open (busy, unsaved input kept) gets its entry back. `history: false`
 * opts out.
 */
export default function useDialogA11y(open, { returnFocusRef, onClose, history = true } = {}) {
  const ref = useRef(null);
  const openerRef = useRef(null);
  const wasOpenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; });

  // Read the opener while rendering: an autoFocus field inside the dialog takes focus during the commit, before any
  // effect of this hook runs. Repeating it in a StrictMode double render reads the same element.
  if (open && !wasOpenRef.current) openerRef.current = document.activeElement;
  wasOpenRef.current = Boolean(open);

  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return undefined;
    const opener = openerRef.current;
    // read when the dialog closes: the fallback element may be rendered while it is open
    const fallbackRef = returnFocusRef;
    const focusable = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => !el.disabled && el.offsetParent !== null);

    if (!node.contains(document.activeElement)) (node.querySelector('[data-autofocus]') || focusable()[0] || node).focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // leave focus alone if something outside the dialog already took it on purpose
      const current = document.activeElement;
      if (current && current !== document.body && current.isConnected && !node.contains(current)) return;
      const target = [opener, fallbackRef?.current].find((el) => canTakeFocus(el) && !node.contains(el));
      if (target) target.focus();
    };
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (!open || !history || typeof window === 'undefined' || !window.history?.pushState) return undefined;
    if (!listening) {
      window.addEventListener('popstate', onPopState);
      listening = true;
    }
    const dialog = { token: `${PAGE_ID}:${nextToken++}`, popped: false };
    dialog.onBack = () => {
      dialog.popped = true;
      if (onCloseRef.current) onCloseRef.current();
      else pressEscape(ref.current);
      setTimeout(() => {
        if (!openDialogs.includes(dialog)) return;
        dialog.popped = false;
        pushDialogEntry(dialog.token);
      }, KEPT_OPEN_CHECK_MS);
    };
    openDialogs.push(dialog);
    pushDialogEntry(dialog.token);
    return () => {
      openDialogs.splice(openDialogs.indexOf(dialog), 1);
      if (dialog.popped) return;
      // after the commit: a navigation in the same handler (open the chosen series) pushes its entry first
      setTimeout(() => dropDialogEntry(dialog.token), 0);
    };
  }, [open, history]);

  return ref;
}
