// Guards that no UI source contains emoji and that the Lucide icons replacing them render.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../utils/offlineStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true)
}));

import { SORT_OPTIONS } from '../utils/collectionHelpers';
import { RADAR_STATUS_CHIPS } from '../utils/radarHelpers';
import { lookupSourceLabels } from '../components/modals/AddMangaModal';
import { lookupBadgeLabels } from '../components/detail/MangaHeroCard';
import PersonalFilters from '../components/dashboard/radar/PersonalFilters';
import ShoppingListView from '../components/dashboard/ShoppingListView';
import MangaDetail from '../MangaDetail';
import { SCAN_LIST_KEY } from '../utils/scanHelpers';
import { normalizePubName } from '../utils/volumeHelpers';
import { clearDataCache } from '../utils/dataCache';
import { fakeResponse } from './fakeResponse';

// Typographic glyphs render the same everywhere and stay allowed
const TYPOGRAPHIC = '✓✕★☐♡•→—↗◀▶';
const EMOJI = new RegExp(`(?![${TYPOGRAPHIC}])[\\p{Extended_Pictographic}\\p{Regional_Indicator}]`, 'gu');
const emojiIn = (text) => String(text).match(EMOJI) || [];

const srcDir = path.resolve(import.meta.dirname, '..');
const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
  return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : [];
});

describe('no emoji in the UI', () => {
  it('the guard regex catches emoji and flags but not the typographic set', () => {
    expect(emojiIn('🌐 AniList 🇩🇪 ⏳ ℹ️ ✔️')).toHaveLength(6);
    expect(emojiIn(`${TYPOGRAPHIC} Titel (A → Z)`)).toEqual([]);
  });

  it('sort options, radar chips and lookup badges are plain text', () => {
    for (const { label } of [...SORT_OPTIONS, ...RADAR_STATUS_CHIPS]) expect(emojiIn(label), label).toEqual([]);
    expect(SORT_OPTIONS.find((o) => o.value === 'title_asc').label).toBe('Titel (A → Z)');
    expect(RADAR_STATUS_CHIPS.map((c) => c.id)).toEqual(['ALL', 'Vorbestellt', 'Erscheint bald', 'Geplant']);
    expect(RADAR_STATUS_CHIPS.map((c) => c.label)).toEqual(['Alle Status', 'Vorbestellt', 'Erscheint bald', 'Noch nicht bestellt']);
    const hit = { source: 'anilist', also_on: ['mal'] };
    expect(lookupSourceLabels(hit)).toEqual(['AniList', 'MyAnimeList']);
    expect(lookupBadgeLabels(hit)).toEqual(['AniList', 'MyAnimeList']);
  });

  it('no component, util or page source contains an emoji', () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
      .flatMap((line, i) => emojiIn(line).map((glyph) => `${path.relative(srcDir, file)}:${i + 1} ${glyph}`)));
    expect(found).toEqual([]);
  });
});

describe('icons that replaced emoji', () => {
  it('radar status chips: Package, Clock, ShoppingCart before the label, none for "Alle Status"', () => {
    render(
      <PersonalFilters
        radarData={{ publishers: [] }}
        radarPublisherFilter="ALL" setRadarPublisherFilter={vi.fn()}
        radarStatusFilter="ALL" setRadarStatusFilter={vi.fn()}
        radarSearch="" setRadarSearch={vi.fn()}
        filtersActive={false} onResetFilters={vi.fn()}
      />
    );
    const group = screen.getByRole('group', { name: 'Status-Filter' });
    const chip = (name) => within(group).getByRole('button', { name });
    expect(chip('Alle Status').querySelector('svg')).toBeNull();
    for (const [name, icon] of [['Vorbestellt', 'package'], ['Erscheint bald', 'clock'], ['Noch nicht bestellt', 'shopping-cart']]) {
      const svg = chip(name).querySelector('svg');
      expect(svg.classList.contains(`lucide-${icon}`), name).toBe(true);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.classList.contains('w-3.5')).toBe(true);
    }
  });

  describe('shopping scan list', () => {
    beforeEach(() => localStorage.clear());

    it('each kind and booking state shows its Lucide icon in the aria-hidden marker', () => {
      const entries = [
        { isbn: '1', kind: 'buy', label: 'Kaufen', itemId: 1 },
        { isbn: '2', kind: 'owned', label: 'Im Besitz' },
        { isbn: '3', kind: 'partner', label: 'Partner' },
        { isbn: '4', kind: 'check', label: 'Prüfen' },
        { isbn: '5', kind: 'new', label: 'Neu' },
        { isbn: '6', kind: 'mystery', label: 'Unbekannt' },
        { isbn: '7', kind: 'offline', label: 'Offline', offline: true },
        { isbn: '8', kind: 'buy', label: 'Gebucht', itemId: 1, done: true },
        { isbn: '9', kind: 'buy', label: 'Vorgemerkt', itemId: 1, done: true, queued: true },
        { isbn: '10', kind: 'buy', label: 'Fehlgeschlagen', itemId: 1, failed: true, error: 'Konflikt' }
      ];
      localStorage.setItem(SCAN_LIST_KEY, JSON.stringify({ savedAt: Date.now(), userId: null, entries }));
      const item = {
        id: 1, manga_id: 9, volume_number: '1', isbn: '1', price: 7, status: 'Fehlt', type: 'volume', notes: null, priority: 0,
        target_price: null, manga_title: 'Berserk', manga_cover: null, effective_publisher: 'Carlsen Manga'
      };
      render(
        <MemoryRouter>
          <ShoppingListView
            shoppingData={{ total_missing: 1, total_cost: 7, publishers: [{ publisher: 'Carlsen Manga', count: 1, total_price: 7 }], items: [item], others: [] }}
            loadingShopping={false} fetchShoppingList={vi.fn()} fetchMangas={vi.fn()} isOfflineMode={false} offlineLastUpdated={null}
            syncPendingPurchases={vi.fn(async () => null)} shoppingSearch="" setShoppingSearch={vi.fn()}
            shoppingPublisherFilter="ALL" setShoppingPublisherFilter={vi.fn()} normalizePubName={normalizePubName}
            setActiveMainView={vi.fn()} canEdit handleQuickBuy={vi.fn(async () => 'ok')} buyingId={null}
          />
        </MemoryRouter>
      );
      const rows = Array.from(document.querySelectorAll('#shop-scan-list li'));
      const icons = rows.map((li) => {
        const marker = li.firstElementChild;
        expect(marker.getAttribute('aria-hidden')).toBe('true');
        expect(emojiIn(marker.textContent)).toEqual([]);
        return [li.dataset.kind, [...marker.querySelector('svg').classList].find((c) => c.startsWith('lucide-'))];
      });
      expect(icons).toEqual([
        ['buy', 'lucide-shopping-cart'], ['owned', 'lucide-circle-check'], ['partner', 'lucide-users'], ['check', 'lucide-info'],
        ['new', 'lucide-book-open'], ['mystery', 'lucide-circle-question-mark'], ['offline', 'lucide-wifi-off'],
        ['buy', 'lucide-check'], ['buy', 'lucide-clock'], ['buy', 'lucide-triangle-alert']
      ]);
      expect(rows[0].classList.contains('text-emerald-300')).toBe(true);
      expect(rows[9].textContent).toContain('nicht gebucht: Konflikt');
    });
  });

  describe('detail page placeholders', () => {
    beforeEach(() => { localStorage.clear(); clearDataCache(); });
    afterEach(() => vi.unstubAllGlobals());

    const renderPage = () => render(
      <MemoryRouter initialEntries={['/manga/5']}>
        <Routes>
          <Route path="/manga/:id" element={<MangaDetail user={{ id: 2, username: 'ed', role: 'editor' }} />} />
        </Routes>
      </MemoryRouter>
    );
    const placeholderIcon = (heading) => heading.closest('main').querySelector('[aria-hidden="true"] > svg.lucide-library');

    it.each([
      [404, 'Manga nicht gefunden'],
      [500, 'Server nicht erreichbar']
    ])('%s shows the Library icon instead of an emoji', async (status, title) => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(status, { error: 'x' })));
      renderPage();
      const heading = await screen.findByRole('heading', { level: 1, name: title });
      const icon = placeholderIcon(heading);
      expect(icon).toBeTruthy();
      expect(icon.classList.contains('w-10')).toBe(true);
      expect(emojiIn(heading.closest('main').textContent)).toEqual([]);
    });
  });
});
