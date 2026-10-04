// MangaDetail selection bar.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config.js';

vi.mock('../utils/offlineStore', () => ({
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import MangaDetail from '../MangaDetail';
import { clearDataCache } from '../utils/dataCache';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const src = path.resolve(import.meta.dirname, '..');

let utilities = '';
beforeAll(async () => {
  const content = ['MangaDetail.jsx', 'components/detail/BulkActionBar.jsx'].map((f) => path.join(src, f));
  const result = await postcss([tailwindcss({ ...config, content, corePlugins: { preflight: false } })])
    .process('@tailwind utilities;', { from: undefined });
  utilities = result.css;
}, 60000);

describe('MangaDetail selection bar', () => {
  const editor = { id: 2, username: 'ed', role: 'editor' };
  const volume = (id, number) => ({ id, volume_number: number, type: 'volume', status: 'Fehlt', owners: [], read_users: [] });
  const MANGA = { id: 5, title: 'Klebe Reihe', status: 'Laufend', total_volumes: 2, reader_stats: [], volumes: [volume(51, '1'), volume(52, '2')] };
  let toasts;
  let style;
  beforeEach(() => {
    toasts = recordToasts();
    clearDataCache();
    localStorage.clear();
    localStorage.setItem('mangashelf_volume_view_mode', 'grid');
    style = document.createElement('style');
    style.textContent = utilities;
    document.head.appendChild(style);
  });
  afterEach(() => {
    style.remove();
    toasts.stop();
    vi.unstubAllGlobals();
  });

  it('no ancestor of the sticky #bulk-action-bar is a scroll container (the window scrolls, so the bar sticks)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/mangas/5') return fakeResponse(200, MANGA);
      if (url.startsWith('/api/mangas/5/gaps')) return fakeResponse(200, { matched: false, gaps: [] });
      return fakeResponse(404, {});
    }));
    const { container } = render(
      <MemoryRouter initialEntries={['/manga/5']}>
        <Routes><Route path="/manga/:id" element={<MangaDetail user={editor} />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByText('Klebe Reihe');
    fireEvent.click(screen.getByRole('button', { name: 'Auswählen' }));
    const bar = document.getElementById('bulk-action-bar');
    expect(getComputedStyle(bar).position).toBe('sticky');

    const root = container.firstElementChild;
    expect(getComputedStyle(root).overflowX).toBe('clip');
    const scrolling = [];
    for (let el = bar.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      for (const value of [cs.overflow, cs.overflowX, cs.overflowY]) {
        if (/hidden|auto|scroll/.test(value)) scrolling.push(`${el.tagName}.${el.className}: ${value}`);
      }
    }
    expect(scrolling).toEqual([]);
  });
});
