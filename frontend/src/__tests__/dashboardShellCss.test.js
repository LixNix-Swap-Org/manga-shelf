// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config.js';

const dashboard = path.resolve(import.meta.dirname, '../components/dashboard');

describe('dashboard shell classes', () => {
  it('generates the hover-media and focus variants of the grid delete button and the badge sizes', async () => {
    const content = ['MangaCollectionGrid.jsx', 'MangaCard.jsx', 'MangaRow.jsx', 'DashboardHeader.jsx', 'CollectionStats.jsx'].map((f) => path.join(dashboard, f));
    const { css } = await postcss([tailwindcss({ ...config, content, corePlugins: { preflight: false } })])
      .process('@tailwind utilities;', { from: undefined });
    const media = css.slice(css.indexOf('@media(hover:hover)'));
    expect(media).toContain('.\\[\\@media\\(hover\\:hover\\)\\]\\:opacity-0');
    expect(media).toContain('.\\[\\@media\\(hover\\:hover\\)\\]\\:pointer-events-none');
    expect(css).toContain('.group:focus-within .group-focus-within\\:opacity-100');
    expect(css).toContain('.focus-visible\\:opacity-100:focus-visible');
    expect(css).toContain('.min-w-4');
    expect(css).toContain('.py-px');
    expect(css).toContain('.hover\\:bg-slate-850\\/60:hover');
  }, 60000);
});
