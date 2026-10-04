// @vitest-environment node
// Covers the compiled Tailwind classes of the dashboard shell.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config.js';

const dashboard = path.resolve(import.meta.dirname, '../components/dashboard');

describe('dashboard shell classes', () => {
  it('generates the hover-media and focus variants of the grid delete button and the badge sizes', async () => {
    const content = ['MangaCollectionGrid.jsx', 'MangaCard.jsx', 'MangaRow.jsx', 'DashboardHeader.jsx', 'CollectionStats.jsx', '../common/BottomNav.jsx']
      .map((f) => path.join(dashboard, f));
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
    // the card frame, its stretched link and the author row above it
    expect(css).toMatch(/\.after\\:absolute::after\s*\{[^}]*content: var\(--tw-content\)[^}]*position: absolute/);
    expect(css).toMatch(/\.after\\:inset-0::after/);
    expect(css).toMatch(/\.z-\\\[1\\\]\s*\{\s*z-index: 1/);
    expect(css).toMatch(/\.hyphens-auto\s*\{[^}]*hyphens: auto/);
    expect(css).toMatch(/\.text-\\\[10px\\\]\s*\{\s*font-size: 10px/);
    // stat icon tiles: hidden in the four narrow columns between md and xl
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*\.md\\:hidden\s*\{\s*display: none/);
    expect(css).toMatch(/@media \(min-width: 1280px\)[\s\S]*\.xl\\:flex\s*\{\s*display: flex/);
  }, 60000);

  it('generates the phone wrap classes of the shelf toolbar chips', async () => {
    const content = [path.join(dashboard, 'CollectionToolbar.jsx')];
    const { css } = await postcss([tailwindcss({ ...config, content, corePlugins: { preflight: false } })])
      .process('@tailwind utilities;', { from: undefined });
    expect(css).toMatch(/\.basis-\\\[calc\\\(50\\%-0\\\.25rem\\\)\\\]\s*\{\s*flex-basis:\s*calc\(50% - 0\.25rem\)/);
    expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*\.lg\\:basis-\\\[calc\\\(25\\%-0\\\.375rem\\\)\\\]\s*\{\s*flex-basis:\s*calc\(25% - 0\.375rem\)/);
    expect(css).toMatch(/@media \(min-width: 1280px\)[\s\S]*\.xl\\:basis-auto\s*\{\s*flex-basis:\s*auto/);
    expect(css).toMatch(/\.xl\\:w-auto\s*\{\s*width:\s*auto/);
    expect(css).toMatch(/@media\s*\(pointer:coarse\)\s*\{[\s\S]*?\.\\\[\\@media\\\(pointer\\:coarse\\\)\\\]\\:p-2\\\.5\s*\{\s*padding: 0\.625rem/);
  }, 60000);
});
