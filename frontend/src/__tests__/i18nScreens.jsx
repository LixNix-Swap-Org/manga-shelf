// Render-text harness of the main screens: renders App per screen against recorded API answers of a seeded demo
// server (fixtures/i18nScreens.json) and dumps every visible text plus aria-label/title/placeholder/alt in DOM order.
// i18nScreens.test.jsx compares the German dump with __snapshots__/i18nScreens.de.json (proof that wrapping texts
// changed nothing); i18nLeak.test.jsx renders the same screens in English and looks for German.
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import fixtures from './fixtures/i18nScreens.json';
import App from '../App';
import OfflineBanner from '../components/common/OfflineBanner';
import { clearDataCache } from '../utils/dataCache';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ID = fixtures.manga_id;

const EXTRA = {
  'GET /api/release-radar/changes': { status: 200, body: { changes: [], months_checked: 3, months_failed: 0 } },
  [`GET /api/mangas/${ID}/gaps`]: {
    status: 200,
    body: { success: false, matched: false, unavailable: true, message: 'Manga Passion ist gerade nicht erreichbar. Bitte später erneut versuchen.', candidate_editions: [] }
  },
  'GET /api/manga-passion/releases': { status: 503, body: { error: 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen', code: 'MP_UNAVAILABLE' } }
};

/** fetch against the recorded answers; anything else is a 404 like the server's. */
export function fixtureFetch({ signedIn = true } = {}) {
  const table = { ...fixtures.responses, ...EXTRA };
  return vi.fn(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://localhost');
    const method = (init.method || 'GET').toUpperCase();
    if (!signedIn && url.pathname === '/api/auth/me') return json(401, { error: 'Nicht angemeldet', code: 'AUTH_REQUIRED' });
    const hit = table[`${method} ${url.pathname}${url.search}`] ?? table[`${method} ${url.pathname}`];
    if (!hit) return json(404, { error: 'Nicht gefunden', code: 'NOT_FOUND' });
    let body = hit.body;
    // the language comes from the test, not from the recorded account
    if (url.pathname === '/api/auth/me' && body?.user) body = { user: { id: body.user.id, username: body.user.username, role: body.user.role } };
    return json(hit.status, body);
  });
}

const clickTab = (selector, index) => () => {
  const tabs = document.querySelectorAll(selector);
  if (tabs[index]) fireEvent.click(tabs[index]);
};

/** The main screens: URL, stored view settings and an optional step after the first render. */
export const SCREENS = [
  { name: 'login', url: '/login', signedIn: false },
  { name: 'dashboard-grid', url: '/', storage: { mangashelf_view_mode: 'grid' } },
  { name: 'dashboard-list', url: '/', storage: { mangashelf_view_mode: 'list' } },
  { name: 'shopping', url: '/?view=shopping' },
  { name: 'radar-calendar', url: '/?view=radar' },
  { name: 'radar-personal', url: '/?view=radar', step: () => fireEvent.click(document.getElementById('radar-tab-personal') || document.querySelectorAll('[role="tab"]')[1]) },
  { name: 'anime', url: '/?view=anime' },
  { name: 'detail', url: `/manga/${ID}` },
  { name: 'stats', url: '/?view=stats' },
  { name: 'stats-publishers', url: '/?view=stats', step: clickTab('[role="dialog"] [role="group"] button', 1) },
  { name: 'stats-reading', url: '/?view=stats', step: clickTab('[role="dialog"] [role="group"] button', 2) },
  { name: 'stats-timeline', url: '/?view=stats', step: clickTab('[role="dialog"] [role="group"] button', 3) },
  { name: 'account-password', url: '/', session: { mangashelf_reopen_account: 'password' } },
  { name: 'account-keys', url: '/', session: { mangashelf_reopen_account: 'keys' } },
  { name: 'account-language', url: '/', session: { mangashelf_reopen_account: 'language' } },
  // single components that no App screen shows with the fixtures
  { name: 'offline-banner', element: () => <MemoryRouter><OfflineBanner lastSync={null} /><OfflineBanner lastSync={Date.parse(fixtures.captured_at) - 5 * 60000} /></MemoryRouter> }
];

const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

/**
 * Visible texts and the translated attributes, one line each, in DOM order. Adjacent text nodes count as one text
 * (React splits "Sammlung ({n})" into three nodes, t() renders one), whitespace collapsed.
 */
export function dumpText(root = document.body) {
  const lines = [];
  const push = (text) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) lines.push(clean);
  };
  const visit = (node) => {
    if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'svg'].includes(node.nodeName)) return;
    for (const attr of ATTRS) {
      const value = node.getAttribute(attr);
      if (value && value.trim()) push(`@${attr}: ${value}`);
    }
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        text += child.nodeValue;
        continue;
      }
      push(text);
      text = '';
      visit(child);
    }
    push(text);
  };
  visit(root);
  return lines;
}

// lazy route chunks compile on first use: the loading screen alone never counts as settled
async function settle(timeoutMs = 10000) {
  let last = '';
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const lines = dumpText();
    const now = lines.join('\n');
    stable = now === last && lines.length > 2 ? stable + 1 : 0;
    last = now;
    if (stable >= 8) return;
  }
}

/** Renders one screen in the current language and returns its text dump. Fake Date: the fixtures' capture time. */
export async function renderScreen(screen) {
  cleanup();
  clearDataCache();
  localStorage.clear();
  sessionStorage.clear();
  for (const [k, v] of Object.entries(screen.storage || {})) localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(screen.session || {})) sessionStorage.setItem(k, v);
  window.history.replaceState(null, '', screen.url);
  vi.stubGlobal('fetch', fixtureFetch({ signedIn: screen.signedIn !== false }));
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(fixtures.captured_at) });
  try {
    render(screen.element ? screen.element() : <App />);
    await settle();
    if (screen.step) {
      await act(async () => { screen.step(); });
      await settle();
    }
    return dumpText();
  } finally {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}
