// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config.js';

const root = path.resolve(import.meta.dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('safe-area insets (notched phones, standalone mode)', () => {
  it('the viewport covers the whole screen, so env(safe-area-inset-*) is not 0', () => {
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });

  it('the body keeps its content out of the left and right insets', async () => {
    const body = html.match(/<body class="([^"]*)"/)[1].split(/\s+/);
    expect(body).toEqual(expect.arrayContaining(['pl-[env(safe-area-inset-left)]', 'pr-[env(safe-area-inset-right)]']));
    const result = await postcss([tailwindcss({ ...config, content: [{ raw: html, extension: 'html' }] })])
      .process('@tailwind utilities;', { from: undefined });
    expect(result.css).toMatch(/padding-left:\s*env\(safe-area-inset-left\)/);
    expect(result.css).toMatch(/padding-right:\s*env\(safe-area-inset-right\)/);
  }, 60000);
});
