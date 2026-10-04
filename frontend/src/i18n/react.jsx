import { Fragment, createElement, useSyncExternalStore } from 'react';
import { getLanguage, subscribe, richParts } from './index.js';

/** Current UI language; re-renders on a switch (App keys the routed tree by it, so most components need no hook). */
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** A sentence with React nodes as placeholder values: rich('Angemeldet als {name}', { name: <strong>…</strong> }). */
export function rich(source, vars = {}) {
  // spread children: positional, so React needs no keys
  return createElement(Fragment, null, ...richParts(source, vars));
}
